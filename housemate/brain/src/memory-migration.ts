import { chmodSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ReflectionState } from "./memory-reflection.js";
import { readMemoryMeta, writeMemoryMeta } from "./memory-store.js";
import { inTransaction } from "./sqlite-store.js";
import { arrayValue, errorMessage, objectValue } from "./value-guards.js";
import { localDate } from "./zoned-time.js";
import { HOUSE_TIME_ZONE } from "./house-config.js";

/*
 * The one-time move into one household memory database. Every old
 * file is copied to `<name>.bak-YYYYMMDD-lean10` first; the import runs in one
 * transaction and switches (sets the marker) only when every count matches.
 * On a mismatch nothing is written, the old files stay as they are, and
 * household memory stays off until it succeeds. The old files are only ever
 * read, through read-only connections, and are left on disk (mode 0400).
 */

const MARKER = "household_memory";
const MARKER_VALUE = "lean10";

export type MigrationResult =
  | { readonly kind: "ready"; readonly db: DatabaseSync }
  | { readonly kind: "refused"; readonly reason: string };

type Counts = Readonly<Record<string, number>>;

export function migrateToOneMemory(options: {
  readonly filePath: string;
  readonly dataDir: string;
  readonly now: Date;
  readonly open: () => DatabaseSync;
  readonly tables: string;
  readonly writeReflection: (db: DatabaseSync, state: ReflectionState) => void;
  readonly log: (message: string) => void;
}): MigrationResult {
  const old = {
    reflection: join(options.dataDir, "cognition", "memory-reflection.json"),
    archive: join(options.dataDir, "memory", "archive.sqlite"),
    recall: join(options.dataDir, "memory", "recall.sqlite"),
    turns: join(options.dataDir, "memory", "turn-search.sqlite"),
  };
  const existed = existsSync(options.filePath);
  const db = options.open();
  try {
    if (readMemoryMeta(db, MARKER) === MARKER_VALUE) {
      db.exec(options.tables);
      return { kind: "ready", db };
    }
    // Our connection is open but idle, so the copies are consistent.
    const backups = backUp([...(existed ? [options.filePath] : []), ...Object.values(old)], options.now);
    const counts = inTransaction(db, () => {
      db.exec(options.tables);
      db.exec(`DELETE FROM reflection_people; DELETE FROM reflection_episodes; DELETE FROM reflection_held;
        DELETE FROM reflection_counts; DELETE FROM archive_items; DELETE FROM archive_fts; DELETE FROM archive_hits;
        DELETE FROM forgotten; DELETE FROM recall_docs; DELETE FROM recall_fts; DELETE FROM turns; DELETE FROM turn_fts;
        DELETE FROM opportunity_queue;`);
      // Opportunities left memory records for their own queue; none were ever stored as records.
      const opportunityRecords = count(db, "memory_records WHERE category = 'opportunity'");
      if (opportunityRecords > 0) throw new Error(`memory holds ${opportunityRecords} opportunity records`);
      const expected: Record<string, number> = { ...recordCounts(db) };
      const reflection = existsSync(old.reflection) ? readOldReflectionState(old.reflection) : null;
      if (reflection) {
        options.writeReflection(db, reflection);
        Object.assign(expected, reflectionCounts(reflection));
      }
      Object.assign(expected, importArchive(db, old.archive), importTurns(db, old.turns));
      const actual = { ...recordCounts(db), ...tableCounts(db) };
      const mismatched = Object.keys({ ...expected, ...actual })
        .filter((key) => (expected[key] ?? 0) !== (actual[key] ?? 0))
        .map((key) => `${key} ${expected[key] ?? 0} -> ${actual[key] ?? 0}`);
      if (mismatched.length > 0) throw new Error(`counts do not match: ${mismatched.join(", ")}`);
      writeMemoryMeta(db, MARKER, MARKER_VALUE);
      return actual;
    });
    for (const path of Object.values(old)) {
      if (existsSync(path)) chmodSync(path, 0o400);
    }
    options.log(`moved into one database (${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(" ")}); ${backups} backup files`);
    return { kind: "ready", db };
  } catch (error) {
    db.close();
    return { kind: "refused", reason: errorMessage(error) };
  }
}

/** Copies each existing file and its SQLite sidecars; returns how many were copied. */
function backUp(paths: readonly string[], now: Date): number {
  const suffix = `.bak-${localDate(now, HOUSE_TIME_ZONE).replaceAll("-", "")}-lean10`;
  let copied = 0;
  for (const path of paths.flatMap((file) => [file, `${file}-wal`, `${file}-shm`])) {
    if (!existsSync(path)) continue;
    const target = join(dirname(path), `${basename(path)}${suffix}`);
    copyFileSync(path, target);
    chmodSync(target, 0o600);
    copied += 1;
  }
  return copied;
}

function recordCounts(db: DatabaseSync): Counts {
  return {
    records: count(db, "memory_records"),
    evidence: count(db, "evidence_records"),
  };
}

function tableCounts(db: DatabaseSync): Counts {
  const counts: Record<string, number> = {
    briefs: count(db, "reflection_people WHERE brief != ''"),
    held: count(db, "reflection_held"),
    reflectionCounters: count(db, "reflection_counts"),
    archiveItems: count(db, "archive_items"),
    archiveWords: count(db, "archive_fts"),
    archiveHits: count(db, "archive_hits"),
    forgotten: count(db, "forgotten"),
    turns: count(db, "turns"),
    turnWords: count(db, "turn_fts"),
  };
  for (const row of db.prepare("SELECT actor_id, count(*) AS n FROM reflection_episodes GROUP BY actor_id").all() as unknown as {
    readonly actor_id: string; readonly n: number;
  }[]) {
    counts[`episodes:${row.actor_id}`] = row.n;
  }
  return counts;
}

function reflectionCounts(state: ReflectionState): Counts {
  const counts: Record<string, number> = {
    briefs: Object.values(state.people).filter((person) => (person.brief ?? "") !== "").length,
    held: state.held.length,
    reflectionCounters: Object.keys(state.reflectionCounts).length + Object.keys(state.notificationCounts).length,
  };
  for (const [actorId, person] of Object.entries(state.people)) {
    if ((person.episodes ?? []).length > 0) counts[`episodes:${actorId}`] = person.episodes.length;
  }
  return counts;
}

/** The permanent tier's words, hits and forget list, row for row; the word index is rebuilt from the same words. */
function importArchive(db: DatabaseSync, path: string): Counts {
  return withOldDatabase(path, ["items", "hits", "forgotten"], (old) => {
    if ((old.prepare("PRAGMA user_version").get() as { readonly user_version: number }).user_version !== 1) {
      throw new Error("old archive has an unknown schema version");
    }
    const items = old.prepare("SELECT id, turn_id, actor_id, said_at, words, reasons, grief, kept_at FROM items ORDER BY id").all() as unknown as {
      readonly id: number; readonly turn_id: string; readonly actor_id: string; readonly said_at: string;
      readonly words: string; readonly reasons: string; readonly grief: number; readonly kept_at: string;
    }[];
    const item = db.prepare("INSERT INTO archive_items (id, turn_id, actor_id, said_at, words, reasons, grief, kept_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const words = db.prepare("INSERT INTO archive_fts (rowid, words) VALUES (?, ?)");
    for (const row of items) {
      item.run(row.id, row.turn_id, row.actor_id, row.said_at, row.words, row.reasons, row.grief, row.kept_at);
      words.run(row.id, row.words);
    }
    const hits = old.prepare("SELECT turn_id, day, actor_id FROM hits").all() as unknown as {
      readonly turn_id: string; readonly day: string; readonly actor_id: string;
    }[];
    const hit = db.prepare("INSERT INTO archive_hits (turn_id, day, actor_id) VALUES (?, ?, ?)");
    for (const row of hits) hit.run(row.turn_id, row.day, row.actor_id);
    const forgotten = old.prepare("SELECT turn_id, actor_id, at FROM forgotten").all() as unknown as {
      readonly turn_id: string; readonly actor_id: string; readonly at: string;
    }[];
    const tombstone = db.prepare("INSERT INTO forgotten (turn_id, actor_id, at) VALUES (?, ?, ?)");
    for (const row of forgotten) tombstone.run(row.turn_id, row.actor_id, row.at);
    return {
      archiveItems: items.length,
      archiveWords: items.length,
      archiveHits: hits.length,
      forgotten: forgotten.length,
    };
  });
}

/** The real-turn index, row for row, with its place in the turn log, so it carries on where it stopped. */
function importTurns(db: DatabaseSync, path: string): Counts {
  return withOldDatabase(path, ["turns", "meta"], (old) => {
    // A derived index of another shape is simply rebuilt from the turn log.
    if ((old.prepare("PRAGMA user_version").get() as { readonly user_version: number }).user_version !== 1) return {};
    const turns = old.prepare("SELECT id, turn_id, actor_id, at, transcript, response FROM turns ORDER BY id").all() as unknown as {
      readonly id: number; readonly turn_id: string; readonly actor_id: string; readonly at: string;
      readonly transcript: string; readonly response: string;
    }[];
    const turn = db.prepare("INSERT INTO turns (id, turn_id, actor_id, at, transcript, response) VALUES (?, ?, ?, ?, ?, ?)");
    const words = db.prepare("INSERT INTO turn_fts (rowid, transcript, response) VALUES (?, ?, ?)");
    for (const row of turns) {
      turn.run(row.id, row.turn_id, row.actor_id, row.at, row.transcript, row.response);
      words.run(row.id, row.transcript, row.response);
    }
    for (const key of ["log_identity", "log_offset"]) {
      const row = old.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { readonly value: string } | undefined;
      if (row) writeMemoryMeta(db, `turn_${key}`, row.value);
    }
    return { turns: turns.length, turnWords: turns.length };
  });
}

function withOldDatabase(path: string, tables: readonly string[], work: (old: DatabaseSync) => Counts): Counts {
  if (!existsSync(path)) return {};
  const old = new DatabaseSync(path, { readOnly: true });
  try {
    const present = new Set((old.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as {
      readonly name: string;
    }[]).map((row) => row.name));
    // Created but never written: nothing to carry.
    if (!tables.every((table) => present.has(table))) return {};
    return work(old);
  } finally {
    old.close();
  }
}

/** The old `cognition/memory-reflection.json`, read exactly as reflection read it. */
function readOldReflectionState(path: string): ReflectionState {
  const value = objectValue(JSON.parse(readFileSync(path, "utf8")) as unknown, "reflection state");
  if (value.schemaVersion !== 1) throw new Error("reflection state schemaVersion must be 1");
  return {
    schemaVersion: 1,
    people: objectValue(value.people ?? {}, "reflection people") as ReflectionState["people"],
    held: arrayValue(value.held ?? [], "reflection held") as unknown as ReflectionState["held"],
    reflectionCounts: objectValue(value.reflectionCounts ?? {}, "reflection counts") as Record<string, number>,
    notificationCounts: objectValue(value.notificationCounts ?? {}, "notification counts") as Record<string, number>,
  };
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { readonly n: number }).n;
}
