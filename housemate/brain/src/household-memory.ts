import type { DatabaseSync } from "node:sqlite";

import { canonicalHouseholdActorId } from "./actor-identity.js";
import type { AppConfig } from "./config.js";
import { MemoryArchive, type MemoryArchiveOptions } from "./memory-archive.js";
import { migrateToOneMemory } from "./memory-migration.js";
import { MemoryRecallIndex, queryWords, type MemoryRecallSource, type RecallQuery, type RecallResult } from "./memory-recall-index.js";
import { emptyReflectionState, forgetReflectedFacts, type ReflectionEpisode, type ReflectionState } from "./memory-reflection.js";
import { MemoryStore, memoryStorePath, openMemoryDatabase, readMemoryMeta, writeMemoryMeta } from "./memory-store.js";
import { inTransaction } from "./sqlite-store.js";
import { turnLogPath } from "./turn-log.js";
import { TurnSearchIndex } from "./turn-search-index.js";
import type { Opportunity } from "./proactive-opportunity.js";
import type { VoiceBrainRequest } from "./voice-brain.js";
import { errorMessage } from "./value-guards.js";

/*
 * Household memory: one database, `memory/memory.sqlite`, for
 * everything the assistant keeps about the household. Records and evidence (as
 * before); reflection's briefs, episodes, held items and counters; the
 * permanent tier's verbatim words, recall hits and the forget list; and the
 * derived search tables over facts and episodes (recall) and real turns.
 * One learner path writes it (reflection, "remember that", the archive's code
 * rules), `recall` reads it, and `forget` lets go in one transaction.
 * Each search table keeps its own FTS5 index so every bm25 score, and so
 * every recall result, is what the separate stores gave.
 */

const HOUSEHOLD_TABLES = `
  CREATE TABLE IF NOT EXISTS reflection_people (
    actor_id TEXT PRIMARY KEY,
    brief TEXT NOT NULL,
    brief_updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS reflection_episodes (
    id INTEGER PRIMARY KEY,
    actor_id TEXT NOT NULL,
    episode TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reflection_held (
    id TEXT PRIMARY KEY,
    source_turn_id TEXT NOT NULL,
    item TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reflection_counts (
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    n INTEGER NOT NULL,
    PRIMARY KEY (kind, key)
  );
  CREATE TABLE IF NOT EXISTS archive_items (
    id INTEGER PRIMARY KEY,
    turn_id TEXT NOT NULL UNIQUE,
    actor_id TEXT NOT NULL,
    said_at TEXT NOT NULL,
    words TEXT NOT NULL,
    reasons TEXT NOT NULL,
    grief INTEGER NOT NULL,
    kept_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS archive_items_actor ON archive_items(actor_id, said_at);
  CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(words, tokenize = 'porter unicode61');
  CREATE TABLE IF NOT EXISTS archive_hits (
    turn_id TEXT NOT NULL,
    day TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    PRIMARY KEY (turn_id, day)
  );
  CREATE TABLE IF NOT EXISTS forgotten (
    turn_id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recall_docs (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    actor_scope TEXT NOT NULL,
    subject_ids TEXT NOT NULL,
    sensitivity TEXT NOT NULL,
    visibility TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    text TEXT NOT NULL,
    terms TEXT NOT NULL,
    turn_ids TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS recall_docs_kind ON recall_docs(kind);
  CREATE VIRTUAL TABLE IF NOT EXISTS recall_fts USING fts5(text, terms, tokenize = 'porter unicode61');
  CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY,
    turn_id TEXT NOT NULL UNIQUE,
    actor_id TEXT NOT NULL,
    at TEXT NOT NULL,
    transcript TEXT NOT NULL,
    response TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS turns_actor_at ON turns(actor_id, at);
  CREATE VIRTUAL TABLE IF NOT EXISTS turn_fts USING fts5(transcript, response, tokenize = 'porter unicode61');
  CREATE TABLE IF NOT EXISTS opportunity_queue (
    id TEXT PRIMARY KEY,
    opportunity TEXT NOT NULL
  );
`;
const REFLECTION_GENERATION = "reflection_generation";

export interface ForgetRequest {
  readonly actorId: string;
  /** "Forget what I said about X"; without it, the speaker's previous turn in this chat. */
  readonly topic?: string;
  readonly chat: Pick<VoiceBrainRequest, "channel" | "sessionId">;
  readonly now: Date;
  /** The corrections ledger, told after the store has let go. */
  readonly corrections?: { forgetTurns(turnIds: readonly string[]): unknown } | null;
}

export interface ForgetOutcome {
  readonly turnIds: readonly string[];
  /** Permanent-tier items dropped. */
  readonly kept: number;
  /** Reflected facts deleted because they rested only on these turns. */
  readonly facts: number;
}

export class HouseholdMemory implements MemoryRecallSource {
  readonly filePath: string;
  readonly turns: TurnSearchIndex;
  private readonly archiveTier: MemoryArchive | null;
  private readonly recallIndex: MemoryRecallIndex;
  private readonly dataDir: string;
  private readonly now: () => Date;
  private readonly onError: (message: string) => void;
  private readonly forgetListeners: ((turnIds: readonly string[]) => void)[] = [];
  private db: DatabaseSync | null = null;
  /** Why the one-time migration refused to switch; memory stays off until it succeeds. */
  private failure: string | null = null;

  constructor(options: {
    readonly config: Pick<AppConfig, "dataDir">;
    /** Tests only. */
    readonly filePath?: string;
    readonly logPath?: string;
    readonly now?: () => Date;
    readonly onError?: (message: string) => void;
    /** The permanent tier is built only under the learning and recall breakers. */
    readonly archive?: false | Omit<MemoryArchiveOptions, "memory" | "now">;
  }) {
    this.dataDir = options.config.dataDir;
    this.filePath = options.filePath ?? memoryStorePath(options.config);
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? ((message) => console.warn(`[brain] household memory: ${message}`));
    this.turns = new TurnSearchIndex({ memory: this, logPath: options.logPath ?? turnLogPath(options.config) });
    this.archiveTier = options.archive === false
      ? null
      : new MemoryArchive({ ...options.archive, memory: this, now: this.now });
    this.recallIndex = new MemoryRecallIndex({ memory: this, archive: this.archiveTier });
  }

  /**
   * The shared connection. The first call runs the one-time 
   * migration (backups, import, count check); null when it refused to switch.
   */
  database(): DatabaseSync | null {
    if (this.db || this.failure) return this.db;
    const result = migrateToOneMemory({
      filePath: this.filePath,
      dataDir: this.dataDir,
      now: this.now(),
      open: () => openMemoryDatabase(this.filePath),
      tables: HOUSEHOLD_TABLES,
      writeReflection: writeReflectionTables,
      log: (message) => console.log(`[brain] household memory: ${message}`),
    });
    if (result.kind === "refused") {
      this.failure = result.reason;
      this.onError(`one-memory migration refused, household memory is off and the old stores are untouched: ${result.reason}`);
      return null;
    }
    this.db = result.db;
    return this.db;
  }

  available(): boolean {
    return this.database() !== null;
  }

  /** The permanent tier, or null when it is not built or the database is unavailable. */
  get archive(): MemoryArchive | null {
    return this.archiveTier && this.available() ? this.archiveTier : null;
  }

  recall(query: RecallQuery): RecallResult {
    return this.recallIndex.recall(query);
  }

  /** Bring the recall tables up to date (boot warm-up). */
  syncRecall(now = this.now()): void {
    this.recallIndex.sync(now);
  }

  close(): void {
    this.archiveTier?.close();
    this.db?.close();
    this.db = null;
  }

  // Forgetting.

  onForget(listener: (turnIds: readonly string[]) => void): void {
    this.forgetListeners.push(listener);
  }

  /** Turns the household asked the assistant to forget, among these. */
  forgottenAmong(turnIds: readonly string[]): ReadonlySet<string> {
    const ids = [...new Set(turnIds.filter(Boolean))];
    const db = ids.length > 0 ? this.database() : null;
    if (!db) return new Set();
    const rows = db.prepare(
      `SELECT turn_id FROM forgotten WHERE turn_id IN (${ids.map(() => "?").join(",")})`,
    ).all(...ids) as unknown as { readonly turn_id: string }[];
    return new Set(rows.map((row) => row.turn_id));
  }

  /**
   * "Forget what I said about X" / "don't keep that": in one
   * transaction the speaker's kept words go, the turns are tombstoned for
   * recall, search and the tier, held items from them are dropped, and
   * reflected facts resting only on them are deleted. Then the chats not yet
   * reflected on and the corrections ledger are told.
   */
  forget(request: ForgetRequest): ForgetOutcome {
    const actorId = canonicalHouseholdActorId(request.actorId);
    const archive = this.archive;
    const db = this.database();
    if (!actorId || !archive || !db) return { turnIds: [], kept: 0, facts: 0 };
    let turnIds: readonly string[];
    let kept = 0;
    if (request.topic !== undefined) {
      const words = queryWords(request.topic, { keepNames: true });
      if (words.length === 0) return { turnIds: [], kept: 0, facts: 0 };
      const archived = archive.search(actorId, words, 1_000).map((row) => row.turnId);
      let recent: readonly string[] = [];
      try {
        recent = this.turns.search({ actorId, query: request.topic, daysBack: null, now: request.now, limit: 200, includeForgotten: true })
          .map((hit) => hit.turnId);
      } catch (error) {
        this.onError(`turn search for forget failed: ${errorMessage(error)}`);
      }
      turnIds = [...new Set([...archived, ...recent])];
      kept = archived.length;
    } else {
      const last = archive.recentTurn(actorId, request.chat, request.now);
      turnIds = last ? [last] : [];
    }
    const nowIso = request.now.toISOString();
    const facts = inTransaction(db, () => {
      this.tombstone(actorId, turnIds, request.now);
      if (turnIds.length === 0) return 0;
      const dropHeld = db.prepare("DELETE FROM reflection_held WHERE source_turn_id = ?");
      if (turnIds.reduce((dropped, turnId) => dropped + Number(dropHeld.run(turnId).changes), 0) > 0) {
        this.bumpReflectionGeneration(db);
      }
      return forgetReflectedFacts(new MemoryStore(db), actorId, turnIds, nowIso);
    });
    for (const listener of this.forgetListeners) listener(turnIds);
    void request.corrections?.forgetTurns(turnIds);
    return { turnIds, kept, facts };
  }

  /**
   * The tier's tombstone alone: the words go and the turns stay out of recall
   * and search. A bare "forget that" (a "never mind") does only this.
   */
  tombstone(actorId: string, turnIds: readonly string[], now: Date): void {
    this.archiveTier?.dropQueued(turnIds);
    const db = turnIds.length > 0 ? this.database() : null;
    if (!db) return;
    const find = db.prepare("SELECT id FROM archive_items WHERE turn_id = ? AND actor_id = ?");
    const dropFts = db.prepare("DELETE FROM archive_fts WHERE rowid = ?");
    const dropItem = db.prepare("DELETE FROM archive_items WHERE id = ?");
    const mark = db.prepare("INSERT OR IGNORE INTO forgotten (turn_id, actor_id, at) VALUES (?, ?, ?)");
    const dropHits = db.prepare("DELETE FROM archive_hits WHERE turn_id = ?");
    inTransaction(db, () => {
      for (const turnId of turnIds) {
        const row = find.get(turnId, actorId) as { readonly id: number } | undefined;
        if (row) {
          dropFts.run(row.id);
          dropItem.run(row.id);
        }
        mark.run(turnId, actorId, now.toISOString());
        dropHits.run(turnId);
      }
    });
  }

  /** Proactive opportunities waiting in their own queue, oldest first. */
  queuedOpportunities(): readonly Opportunity[] {
    const db = this.database();
    return db
      ? (db.prepare("SELECT opportunity FROM opportunity_queue ORDER BY rowid").all() as unknown as { readonly opportunity: string }[])
        .map((row) => JSON.parse(row.opportunity) as Opportunity)
      : [];
  }

  // Reflection's state: briefs, episodes, held items and daily counters.

  reflectionState(): ReflectionState {
    const db = this.database();
    if (!db) return emptyReflectionState();
    const people: Record<string, { brief: string; briefUpdatedAt: string | null; episodes: ReflectionEpisode[] }> = {};
    const person = (actorId: string) => (people[actorId] ??= { brief: "", briefUpdatedAt: null, episodes: [] });
    for (const row of db.prepare("SELECT actor_id, brief, brief_updated_at FROM reflection_people ORDER BY rowid").all() as unknown as {
      readonly actor_id: string; readonly brief: string; readonly brief_updated_at: string | null;
    }[]) {
      Object.assign(person(row.actor_id), { brief: row.brief, briefUpdatedAt: row.brief_updated_at });
    }
    for (const row of db.prepare("SELECT actor_id, episode FROM reflection_episodes ORDER BY id").all() as unknown as {
      readonly actor_id: string; readonly episode: string;
    }[]) {
      person(row.actor_id).episodes.push(JSON.parse(row.episode) as ReflectionEpisode);
    }
    const counts = (kind: string): Record<string, number> => Object.fromEntries(
      (db.prepare("SELECT key, n FROM reflection_counts WHERE kind = ? ORDER BY rowid").all(kind) as unknown as {
        readonly key: string; readonly n: number;
      }[]).map((row) => [row.key, row.n]),
    );
    return {
      schemaVersion: 1,
      people,
      held: (db.prepare("SELECT item FROM reflection_held ORDER BY rowid").all() as unknown as { readonly item: string }[])
        .map((row) => JSON.parse(row.item) as ReflectionState["held"][number]),
      reflectionCounts: counts("reflection"),
      notificationCounts: counts("notification"),
    };
  }

  saveReflectionState(state: ReflectionState): void {
    const db = this.database();
    if (!db) return;
    inTransaction(db, () => {
      writeReflectionTables(db, state);
      this.bumpReflectionGeneration(db);
    });
  }

  /** Moves whenever reflection's state is written: the brief cache and recall's episode tables follow it. */
  reflectionVersion(): number {
    const db = this.database();
    return db ? Number(readMemoryMeta(db, REFLECTION_GENERATION) ?? "0") : -1;
  }

  private bumpReflectionGeneration(db: DatabaseSync): void {
    writeMemoryMeta(db, REFLECTION_GENERATION, String(Number(readMemoryMeta(db, REFLECTION_GENERATION) ?? "0") + 1));
  }
}

/** Replace reflection's tables with this state (in the caller's transaction). */
export function writeReflectionTables(db: DatabaseSync, state: ReflectionState): void {
  db.exec("DELETE FROM reflection_people; DELETE FROM reflection_episodes; DELETE FROM reflection_held; DELETE FROM reflection_counts;");
  const person = db.prepare("INSERT INTO reflection_people (actor_id, brief, brief_updated_at) VALUES (?, ?, ?)");
  const episode = db.prepare("INSERT INTO reflection_episodes (actor_id, episode) VALUES (?, ?)");
  for (const [actorId, value] of Object.entries(state.people)) {
    person.run(actorId, value.brief ?? "", value.briefUpdatedAt ?? null);
    for (const item of value.episodes ?? []) episode.run(actorId, JSON.stringify(item));
  }
  const held = db.prepare("INSERT INTO reflection_held (id, source_turn_id, item) VALUES (?, ?, ?)");
  for (const item of state.held) held.run(item.id, item.sourceTurnId, JSON.stringify(item));
  const count = db.prepare("INSERT INTO reflection_counts (kind, key, n) VALUES (?, ?, ?)");
  for (const [key, n] of Object.entries(state.reflectionCounts)) count.run("reflection", key, n);
  for (const [key, n] of Object.entries(state.notificationCounts)) count.run("notification", key, n);
}
