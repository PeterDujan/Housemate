import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { canonicalHouseholdActorId } from "./actor-identity.js";
import type { HouseholdMemory } from "./household-memory.js";
import { isAdmittedIntakeSource, trustedSpeakerId } from "./turn-source-trust.js";
import { capWords, ftsQuery, queryWords } from "./memory-recall-index.js";
import { readMemoryMeta, writeMemoryMeta } from "./memory-store.js";
import { inTransaction } from "./sqlite-store.js";
import type { TurnLogEntry } from "./turn-log.js";
import { HOUSE_LOCALE, HOUSE_TIME_ZONE } from "./house-config.js";

/*
 * Conversation search for chat tools: derived FTS5 tables in
 * the household memory database over the household's own turns in the 90-day
 * turn log. Only turns from real household clients with a verified speaker
 * are indexed, and a search only ever returns the asking speaker's turns and
 * never a turn they asked the assistant to forget. The index reads the log from
 * where it last stopped and rebuilds when the log is rewritten (daily pruning
 * renames a fresh file in). It is never the source of truth.
 */

const TURN_SEARCH_RETENTION_DAYS = 90;
const TURN_TEXT_WORDS = 40;
const CANDIDATE_LIMIT = 40;
const READ_CHUNK_BYTES = 1024 * 1024;
const HOUSE_ZONE = HOUSE_TIME_ZONE;

export interface TurnSearchQuery {
  readonly actorId: string;
  /** Empty: the speaker's most recent turns in the window. */
  readonly query: string;
  readonly daysBack: number | null;
  readonly now: Date;
  readonly limit: number;
  /** The forget itself looks up turns already forgotten too. */
  readonly includeForgotten?: boolean;
  /** Everyone's turns, not just the speaker's: the household is open. */
  readonly household?: boolean;
}

export interface TurnSearchHit {
  /** Who said it. */
  readonly actorId: string;
  readonly turnId: string;
  readonly at: string;
  readonly transcript: string;
  readonly response: string;
}

export class TurnSearchIndex {
  private readonly memory: Pick<HouseholdMemory, "database">;
  private readonly logPath: string;

  constructor(options: { readonly memory: Pick<HouseholdMemory, "database">; readonly logPath: string }) {
    this.memory = options.memory;
    this.logPath = options.logPath;
  }

  /** Index turns appended since the last sync; rebuild if the log was rewritten. */
  sync(now = new Date()): DatabaseSync | null {
    const db = this.memory.database();
    if (!db) return null;
    let stat;
    try {
      stat = statSync(this.logPath);
    } catch {
      return db;
    }
    const identity = `${stat.dev}:${stat.ino}`;
    const storedIdentity = readMemoryMeta(db, "turn_log_identity");
    let offset = Number(readMemoryMeta(db, "turn_log_offset") ?? "0");
    if (storedIdentity !== identity || !Number.isFinite(offset) || offset > stat.size) {
      db.exec("DELETE FROM turn_fts; DELETE FROM turns;");
      offset = 0;
    }
    if (offset < stat.size) {
      offset = this.ingest(db, offset, stat.size);
    }
    writeMemoryMeta(db, "turn_log_identity", identity);
    writeMemoryMeta(db, "turn_log_offset", String(offset));
    const cutoff = new Date(now.getTime() - TURN_SEARCH_RETENTION_DAYS * 86_400_000).toISOString();
    const stale = db.prepare("SELECT id FROM turns WHERE at < ?").all(cutoff) as unknown as { readonly id: number }[];
    if (stale.length > 0) {
      const dropFts = db.prepare("DELETE FROM turn_fts WHERE rowid = ?");
      const dropTurn = db.prepare("DELETE FROM turns WHERE id = ?");
      for (const row of stale) {
        dropFts.run(row.id);
        dropTurn.run(row.id);
      }
    }
    return db;
  }

  search(query: TurnSearchQuery): readonly TurnSearchHit[] {
    const actorId = canonicalHouseholdActorId(query.actorId);
    const db = actorId && query.limit >= 1 ? this.sync(query.now) : null;
    if (!actorId || !db) {
      return [];
    }
    const days = Math.min(TURN_SEARCH_RETENTION_DAYS, Math.max(1, query.daysBack ?? TURN_SEARCH_RETENTION_DAYS));
    const since = new Date(query.now.getTime() - days * 86_400_000).toISOString();
    const words = queryWords(query.query, { keepNames: true });
    const whose = query.household ? null : actorId;
    const rows = words.length > 0
      ? db.prepare(`
          SELECT t.actor_id, t.turn_id, t.at, t.transcript, t.response, bm25(turn_fts, 2.0, 1.0) AS rank
          FROM turn_fts JOIN turns t ON t.id = turn_fts.rowid
          WHERE turn_fts MATCH ? AND (? IS NULL OR t.actor_id = ?) AND t.at >= ?
          ORDER BY rank
          LIMIT ?
        `).all(ftsQuery(words), whose, whose, since, CANDIDATE_LIMIT) as unknown as TurnRow[]
      : db.prepare(`
          SELECT actor_id, turn_id, at, transcript, response, 0 AS rank
          FROM turns
          WHERE (? IS NULL OR actor_id = ?) AND at >= ?
          ORDER BY at DESC
          LIMIT ?
        `).all(whose, whose, since, query.limit) as unknown as TurnRow[];
    const shown = rows.slice(0, query.limit);
    const forgotten = query.includeForgotten ? new Set<string>() : forgottenAmong(db, shown.map((row) => row.turn_id));
    return shown
      .filter((row) => !forgotten.has(row.turn_id))
      // Oldest first reads like the conversation happened.
      .sort((left, right) => left.at.localeCompare(right.at))
      .map((row) => ({
        actorId: row.actor_id,
        turnId: row.turn_id,
        at: row.at,
        transcript: row.transcript,
        response: row.response,
      }));
  }

  /** One indexed turn by id, for the permanent tier; null once it has aged out. */
  turn(turnId: string): { readonly actorId: string; readonly at: string; readonly transcript: string } | null {
    const row = this.sync()?.prepare("SELECT actor_id, at, transcript FROM turns WHERE turn_id = ?").get(turnId) as
      | { readonly actor_id: string; readonly at: string; readonly transcript: string }
      | undefined;
    return row ? { actorId: row.actor_id, at: row.at, transcript: row.transcript } : null;
  }

  /** When the speaker last spoke in [since, before), or null. For "since we last spoke". */
  lastTurnAt(actorId: string, before: Date, since: Date): string | null {
    const actor = canonicalHouseholdActorId(actorId);
    const row = actor ? this.sync(before)?.prepare(`
      SELECT at FROM turns WHERE actor_id = ? AND at >= ? AND at < ? ORDER BY at DESC LIMIT 1
    `).get(actor, since.toISOString(), before.toISOString()) as { readonly at: string } | undefined : undefined;
    return row?.at ?? null;
  }

  private ingest(db: DatabaseSync, offset: number, size: number): number {
    const insertTurn = db.prepare(`
      INSERT OR IGNORE INTO turns (turn_id, actor_id, at, transcript, response)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare("INSERT INTO turn_fts (rowid, transcript, response) VALUES (?, ?, ?)");
    const fd = openSync(this.logPath, "r");
    let position = offset;
    let pending = Buffer.alloc(0);
    try {
      inTransaction(db, () => {
        while (position < size) {
          const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - position));
          const read = readSync(fd, chunk, 0, chunk.length, position);
          if (read <= 0) break;
          position += read;
          pending = Buffer.concat([pending, chunk.subarray(0, read)]);
          let newline = pending.indexOf(0x0a);
          while (newline >= 0) {
            const line = pending.subarray(0, newline).toString("utf8").trim();
            pending = pending.subarray(newline + 1);
            newline = pending.indexOf(0x0a);
            const turn = indexableTurn(line);
            if (!turn) continue;
            const result = insertTurn.run(turn.turnId, turn.actorId, turn.at, turn.transcript, turn.response);
            if (result.changes > 0) {
              insertFts.run(result.lastInsertRowid, turn.transcript, turn.response);
            }
          }
        }
      });
    } finally {
      closeSync(fd);
    }
    // A half-written last line is read again next time.
    return position - pending.length;
  }
}

interface TurnRow {
  readonly actor_id: string;
  readonly turn_id: string;
  readonly at: string;
  readonly transcript: string;
  readonly response: string;
  readonly rank: number;
}

function indexableTurn(line: string): {
  readonly turnId: string;
  readonly actorId: string;
  readonly at: string;
  readonly transcript: string;
  readonly response: string;
} | null {
  if (!line) return null;
  let entry: TurnLogEntry;
  try {
    entry = JSON.parse(line) as TurnLogEntry;
  } catch {
    return null;
  }
  if (
    !entry
    || typeof entry.turnId !== "string"
    || typeof entry.timestamp !== "string"
    || Number.isNaN(Date.parse(entry.timestamp))
    || entry.channel === "test"
    || !isAdmittedIntakeSource(entry)
  ) {
    return null;
  }
  const actorId = trustedSpeakerId(entry);
  const transcript = typeof entry.transcript === "string" ? entry.transcript.trim() : "";
  if (!actorId || !transcript) return null;
  return {
    turnId: entry.turnId,
    actorId,
    at: new Date(entry.timestamp).toISOString(),
    transcript: capWords(transcript, TURN_TEXT_WORDS),
    response: capWords(typeof entry.responseText === "string" ? entry.responseText : "", TURN_TEXT_WORDS),
  };
}

function forgottenAmong(db: DatabaseSync, turnIds: readonly string[]): ReadonlySet<string> {
  if (turnIds.length === 0) return new Set();
  const rows = db.prepare(`SELECT turn_id FROM forgotten WHERE turn_id IN (${turnIds.map(() => "?").join(",")})`)
    .all(...turnIds) as unknown as { readonly turn_id: string }[];
  return new Set(rows.map((row) => row.turn_id));
}

/** "Today 3:40 pm", "Yesterday 7:10 pm", "Fri 26 Sep 9:05 am", in house time. */
export function turnWhenLabel(at: string, now: Date): string {
  const date = new Date(at);
  const dayKey = (value: Date): string => new Intl.DateTimeFormat("en-CA", {
    timeZone: HOUSE_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
  const time = new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: HOUSE_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date).replace(/\s+/g, " ").toLowerCase();
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000));
  const day = dayKey(date);
  if (day === today) return `Today ${time}`;
  if (day === yesterday) return `Yesterday ${time}`;
  const parts = Object.fromEntries(new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: HOUSE_ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.weekday} ${parts.day} ${parts.month} ${time}`;
}
