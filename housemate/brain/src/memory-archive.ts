import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { canonicalHouseholdActorId } from "./actor-identity.js";
import { cognitiveFeatureEnabled } from "./cognitive-control.js";
import type { AppConfig } from "./config.js";
import type { HouseholdMemory } from "./household-memory.js";
import { capWords, ftsQuery, prefixHit, queryWords } from "./memory-recall-index.js";
import {
  explicitRememberContent,
  memoryReflectionActorId,
  memoryWriteAdmitted,
  permanentTierBlocked,
} from "./memory-reflection.js";
import type { VoiceBrainRequest } from "./voice-brain.js";
import { errorMessage } from "./value-guards.js";
import { inTransaction } from "./sqlite-store.js";
import { localDate } from "./zoned-time.js";
import { householdRegex } from "./household.js";
import { HOUSE_TIME_ZONE } from "./house-config.js";

/*
 * The permanent tier: the household's own words
 * that should outlive the 90-day turn log. Code alone chooses them, no model:
 * an explicit "remember that...", a household first or date, something a
 * speaker tells the assistant about themselves or the family (he
 * remembers like a household member, without being asked), or a turn recall
 * brought back on several different days. Each item is one turn's
 * verbatim speaker words, never a summary. Sensitive words never enter. A
 * speaker can make the assistant forget; the tombstone also stops the words coming
 * back later. Only the speaker who said them can recall them.
 */

export const MEMORY_ARCHIVE_LIMITS = Object.freeze({
  itemsPerPerson: 5_000,
  /** The owner's hard disk budget, measured on the household memory database; writes stop at it. */
  maxDiskBytes: 500 * 1024 * 1024,
  /** The owner's budget before first speech; a slower lookup is dropped and the tier skipped for a while. */
  lookupBudgetMs: 100,
  breakerMs: 10 * 60_000,
  storedWords: 80,
  /** Distinct house days a turn must come back in recall before it is kept. */
  recalledDaysToKeep: 3,
  /** Hit counts only matter while the turn is still in the 90-day log. */
  hitRetentionMs: 90 * 86_400_000,
  /** "Forget that" reaches the speaker's last turn in the same chat within this window. */
  recentTurnMs: 10 * 60_000,
  candidates: 40,
  flushDelayMs: 1_000,
});

export type ArchiveReason = "asked" | "milestone" | "told" | "recalled";

export interface ArchiveTurnInput {
  readonly request: VoiceBrainRequest;
  readonly route: string;
  readonly status: string;
  readonly turnId: string;
  readonly timestamp: Date;
}

export interface ArchivedWords {
  /** Whose words they are. */
  readonly actorId: string;
  readonly turnId: string;
  readonly saidAt: string;
  readonly words: string;
  readonly grief: boolean;
  readonly rank: number;
}

export interface ArchiveLookup {
  readonly rows: readonly ArchivedWords[];
  readonly elapsedMs: number;
  /** Why the tier was left out of this turn, or null. */
  readonly skipped: string | null;
}

export interface ArchiveRecallQuery {
  /** Every search word, including a follow-up's carried-over ones. */
  readonly terms: readonly string[];
  /** The words of this turn alone. */
  readonly current: readonly string[];
  readonly transcript: string;
}

export interface MemoryArchiveOptions {
  /** The household memory database the words live in; its `forget` is the one forget. */
  readonly memory: Pick<HouseholdMemory, "database" | "filePath" | "turns" | "tombstone" | "forget">;
  readonly now?: () => Date;
  readonly onError?: (message: string) => void;
  readonly flushDelayMs?: number;
  /** Switched off: nothing new is kept or offered, but forgetting still works. */
  readonly active?: () => boolean;
  /** Tests only: smaller caps and budgets. */
  readonly limits?: { readonly itemsPerPerson?: number; readonly maxDiskBytes?: number; readonly lookupBudgetMs?: number };
}

/**
 * Keeping words is learning; reading them back is recall. Both sit under the
 * cognitive breaker, and the tier is pointless without recall switched on.
 */
export function memoryArchiveActive(config: AppConfig): boolean {
  return config.memoryArchiveEnabled
    && config.memoryRecallEnabled
    && memoryArchiveAvailable(config);
}

/** Built at boot under the breakers; the two dashboard switches are checked per use. */
export function memoryArchiveAvailable(config: AppConfig): boolean {
  return cognitiveFeatureEnabled(config, "learning")
    && cognitiveFeatureEnabled(config, "recall");
}

// Household firsts and dates. Statements only: questions are never kept.
const MILESTONE_PATTERN = /\b(?:(?:our|my|his|her|their|the) first|for the first time|first (?:time|ever)|birthday|anniversary|(?:was|were|got) born|born on|moved (?:in|house)|new (?:house|home|puppy|kitten|dog|cat)|got (?:a|our|my) (?:new )?(?:puppy|kitten|dog|cat)|engaged|graduat\w*|retir\w*)\b/;
const questionStart = (): RegExp => householdRegex(String.raw`^(?:(?:hey\s+)?{ASSISTANT}[,.\s]+)?(?:what|whats|what's|when|where|who|whose|which|how|why|is|are|am|was|were|do|does|did|can|could|will|would|should|shall|have|has|may|might|tell me|remind me)\b`);
// Told: a statement about the speaker or the household, with some substance to it.
const leadingFiller = (): RegExp => householdRegex(String.raw`^(?:(?:hey\s+)?{ASSISTANT}|ok|okay|yeah|yep|yes|no|nah|well|so|and|but|oh|um|uh|mate|look|honestly|actually)[,.\s]+`);
const householdReference = (): RegExp => householdRegex(String.raw`\b(?:i|i'm|i've|i'd|i'll|im|ive|me|my|mine|myself|we|we're|we've|we'd|our|ours|us|mum|mom|dad|{REFERENCES}|family)\b`);
const NOT_TELLING = /^(?:thanks|thank you|cheers|ta|sorry|haha|lol|hi|hello|hey|good (?:morning|night|evening|afternoon)|bye|see (?:you|ya)|never ?mind|forget|tell|give|play|turn|switch|set|show|explain|describe|write|make|let's|lets|say|sing|find|search|look up|check|read|list|name|pick|choose|recommend|suggest|remind|stop|shut|go|come|try|guess|pretend|imagine|help|please)\b/;
const TOLD_MIN_CONTENT_WORDS = 3;
const GRIEF_PATTERN = /\b(?:died|dies|dead|death|passed away|passed on|funeral|grief|griev\w*|mourn\w*|put (?:him|her|them) down|put to sleep|memorial|lost (?:him|her|them))\b/;
// Grief words the speaker says this turn are the only thing that lets a grief item surface.
const GRIEF_CUE_PATTERN = /\b(?:died|dies|dead|death|passed away|passed on|funeral|grief|griev\w*|mourn\w*|memorial|miss|missed|missing|remember|remembering|memories|lost)\b/;
const BARE_FORGET_PATTERN = /^(?:(?:ok|okay|actually|no|please)[,\s]+)?forget (?:it|that|this)(?:\s+please)?[.!\s]*$/i;

export function griefWords(text: string): boolean {
  return GRIEF_PATTERN.test(normalizeWords(text));
}

export function griefCue(text: string): boolean {
  return GRIEF_CUE_PATTERN.test(normalizeWords(text));
}

/** Why code would keep these words, or none. Sensitivity is checked separately. */
export function archiveReasons(transcript: string): readonly ArchiveReason[] {
  const text = normalizeWords(transcript);
  if (!text || transcript.includes("?") || questionStart().test(text)) return [];
  const reasons: ArchiveReason[] = [];
  if (explicitRememberContent(transcript)) reasons.push("asked");
  if (MILESTONE_PATTERN.test(text)) reasons.push("milestone");
  if (reasons.length === 0 && toldAboutHousehold(text)) reasons.push("told");
  return reasons;
}

function toldAboutHousehold(text: string): boolean {
  let body = text;
  for (let previous = ""; previous !== body;) {
    previous = body;
    body = body.replace(leadingFiller(), "");
  }
  return !NOT_TELLING.test(body)
    && householdReference().test(body)
    && queryWords(body, { keepNames: true }).length >= TOLD_MIN_CONTENT_WORDS;
}

interface QueuedTurn {
  readonly turnId: string;
  readonly actorId: string;
  readonly saidAt: string;
  readonly words: string;
  readonly reasons: readonly ArchiveReason[];
}

interface QueuedHit {
  readonly actorId: string;
  readonly turnIds: readonly string[];
  readonly day: string;
}

export class MemoryArchive {
  readonly memory: MemoryArchiveOptions["memory"];
  private readonly now: () => Date;
  private readonly onError: (message: string) => void;
  private readonly flushDelayMs: number;
  private readonly active: () => boolean;
  private readonly limits: { readonly itemsPerPerson: number; readonly maxDiskBytes: number; readonly lookupBudgetMs: number };
  private queuedTurns: QueuedTurn[] = [];
  private queuedHits: QueuedHit[] = [];
  private timer: NodeJS.Timeout | null = null;
  private breakerUntilMs = 0;
  private diskFullLogged = false;
  private readonly lastTurns = new Map<string, { readonly turnId: string; readonly atMs: number }>();

  constructor(options: MemoryArchiveOptions) {
    this.limits = { ...MEMORY_ARCHIVE_LIMITS, ...options.limits };
    this.memory = options.memory;
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? ((message) => console.warn(`[brain] memory archive: ${message}`));
    this.flushDelayMs = options.flushDelayMs ?? MEMORY_ARCHIVE_LIMITS.flushDelayMs;
    this.active = options.active ?? (() => true);
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * See a finished turn. Nothing is written here: the turn is queued and
   * written a moment after the reply, so keeping words never delays speech.
   */
  observeTurn(input: ArchiveTurnInput): void {
    if (!memoryWriteAdmitted(input.request)) return;
    const actorId = memoryReflectionActorId(input.request);
    if (!actorId) return;
    const transcript = input.request.transcript.trim();
    const key = chatKey(actorId, input.request);
    const atMs = input.timestamp.getTime();
    if (BARE_FORGET_PATTERN.test(transcript.replace(/[’]/g, "'"))) {
      // "Forget that" is also a plain "never mind"; either way the words before it are not kept.
      const last = this.recentTurn(actorId, input.request, input.timestamp);
      if (last) this.memory.tombstone(actorId, [last], input.timestamp);
      this.lastTurns.delete(key);
      return;
    }
    if (input.status === "error" || !transcript || !this.active()) return;
    this.lastTurns.set(key, { turnId: input.turnId, atMs });
    if (input.route !== "open_conversation") return;
    const reasons = archiveReasons(transcript);
    if (reasons.length === 0 || permanentTierBlocked(transcript)) return;
    this.queuedTurns.push({
      turnId: input.turnId,
      actorId,
      saidAt: input.timestamp.toISOString(),
      words: capWords(transcript, MEMORY_ARCHIVE_LIMITS.storedWords),
      reasons,
    });
    this.schedule();
  }

  /** Recall brought these turns back for this speaker; counted after the reply. */
  noteRecalled(actorId: string, turnIds: readonly string[], at: Date): void {
    const actor = canonicalHouseholdActorId(actorId);
    const ids = [...new Set(turnIds.filter(Boolean))];
    if (!actor || ids.length === 0 || !this.active()) return;
    this.queuedHits.push({ actorId: actor, turnIds: ids, day: localDate(at, HOUSE_TIME_ZONE) });
    this.schedule();
  }

  /** Write everything queued. Safe to call any time; tests call it directly. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const turns = this.queuedTurns;
    const hits = this.queuedHits;
    this.queuedTurns = [];
    this.queuedHits = [];
    if (turns.length === 0 && hits.length === 0) return;
    try {
      const db = this.memory.database();
      if (!db) return;
      const touched = new Set<string>();
      for (const turn of turns) {
        if (this.insert(db, turn)) touched.add(turn.actorId);
      }
      for (const turn of this.promoteRecalled(db, hits)) {
        if (this.insert(db, turn)) touched.add(turn.actorId);
      }
      for (const actorId of touched) this.enforceCap(db, actorId);
      const cutoff = new Date(this.now().getTime() - MEMORY_ARCHIVE_LIMITS.hitRetentionMs);
      db.prepare("DELETE FROM archive_hits WHERE day < ?").run(localDate(cutoff, HOUSE_TIME_ZONE));
    } catch (error) {
      this.onError(`write failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Budgeted search of the speaker's own kept words. A slow lookup is thrown
   * away. Grief is never raised unprompted: those words need the speaker's own
   * grief or remembering words this turn, and a direct match to this turn.
   */
  searchForRecall(actorId: string, query: ArchiveRecallQuery): ArchiveLookup {
    const actor = canonicalHouseholdActorId(actorId);
    const nowMs = Date.now();
    const words = query.terms;
    if (!actor || words.length === 0) return { rows: [], elapsedMs: 0, skipped: null };
    if (!this.active()) return { rows: [], elapsedMs: 0, skipped: "switched off" };
    if (nowMs < this.breakerUntilMs) return { rows: [], elapsedMs: 0, skipped: "over budget recently" };
    const startedAt = performance.now();
    let rows: readonly ArchivedWords[];
    try {
      // The household is open: anyone in it hears what anyone told the assistant.
      rows = this.search(null, words, MEMORY_ARCHIVE_LIMITS.candidates);
    } catch (error) {
      this.onError(`lookup failed: ${errorMessage(error)}`);
      return { rows: [], elapsedMs: roundMs(performance.now() - startedAt), skipped: "lookup failed" };
    }
    const elapsedMs = roundMs(performance.now() - startedAt);
    if (elapsedMs > this.limits.lookupBudgetMs) {
      this.breakerUntilMs = Date.now() + MEMORY_ARCHIVE_LIMITS.breakerMs;
      this.onError(`lookup took ${elapsedMs} ms, over the ${this.limits.lookupBudgetMs} ms budget; skipping the permanent tier for ${MEMORY_ARCHIVE_LIMITS.breakerMs / 60_000} minutes`);
      return { rows: [], elapsedMs, skipped: "over budget" };
    }
    const griefAsked = griefCue(query.transcript);
    return {
      rows: rows.filter((row) => !row.grief || (griefAsked && directHit(row.words, query.current))),
      elapsedMs,
      skipped: null,
    };
  }

  /** One person's kept words, or the whole household's when actorId is null. */
  search(actorId: string | null, words: readonly string[], limit: number): readonly ArchivedWords[] {
    const db = words.length > 0 ? this.memory.database() : null;
    if (!db) return [];
    const rows = db.prepare(`
      SELECT i.actor_id, i.turn_id, i.said_at, i.words, i.grief, bm25(archive_fts) AS rank
      FROM archive_fts JOIN archive_items i ON i.id = archive_fts.rowid
      WHERE archive_fts MATCH ? AND (? IS NULL OR i.actor_id = ?)
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery(words), actorId, actorId, limit) as unknown as {
      readonly actor_id: string;
      readonly turn_id: string;
      readonly said_at: string;
      readonly words: string;
      readonly grief: number;
      readonly rank: number;
    }[];
    return rows.map((row) => ({
      actorId: row.actor_id,
      turnId: row.turn_id,
      saidAt: row.said_at,
      words: row.words,
      grief: row.grief === 1,
      rank: row.rank,
    }));
  }

  /** The speaker's previous turn in this chat, for "don't keep that"; null after 10 minutes. */
  recentTurn(actorId: string, request: Pick<VoiceBrainRequest, "channel" | "sessionId">, now: Date): string | null {
    const last = this.lastTurns.get(chatKey(actorId, request));
    return last && now.getTime() - last.atMs <= MEMORY_ARCHIVE_LIMITS.recentTurnMs ? last.turnId : null;
  }

  /** Queued words from forgotten turns must not land after the forget. */
  dropQueued(turnIds: readonly string[]): void {
    const forgetting = new Set(turnIds);
    this.queuedTurns = this.queuedTurns.filter((turn) => !forgetting.has(turn.turnId));
  }

  stats(actorId?: string): { readonly items: number; readonly forgotten: number; readonly bytes: number } {
    const db = this.memory.database();
    if (!db) return { items: 0, forgotten: 0, bytes: 0 };
    const items = actorId
      ? (db.prepare("SELECT count(*) AS n FROM archive_items WHERE actor_id = ?").get(actorId) as { readonly n: number }).n
      : (db.prepare("SELECT count(*) AS n FROM archive_items").get() as { readonly n: number }).n;
    const forgotten = (db.prepare("SELECT count(*) AS n FROM forgotten").get() as { readonly n: number }).n;
    return { items, forgotten, bytes: this.diskBytes() };
  }

  private promoteRecalled(db: DatabaseSync, hits: readonly QueuedHit[]): readonly QueuedTurn[] {
    if (hits.length === 0) return [];
    const record = db.prepare("INSERT OR IGNORE INTO archive_hits (turn_id, day, actor_id) VALUES (?, ?, ?)");
    for (const hit of hits) {
      for (const turnId of hit.turnIds) record.run(turnId, hit.day, hit.actorId);
    }
    const candidates = [...new Set(hits.flatMap((hit) => hit.turnIds))];
    const days = db.prepare("SELECT count(DISTINCT day) AS n FROM archive_hits WHERE turn_id = ?");
    const kept = db.prepare("SELECT 1 FROM archive_items WHERE turn_id = ?");
    const forgotten = db.prepare("SELECT 1 FROM forgotten WHERE turn_id = ?");
    const promoted: QueuedTurn[] = [];
    for (const turnId of candidates) {
      if ((days.get(turnId) as { readonly n: number }).n < MEMORY_ARCHIVE_LIMITS.recalledDaysToKeep) continue;
      if (kept.get(turnId) || forgotten.get(turnId)) continue;
      const turn = this.memory.turns.turn(turnId);
      const owner = hits.find((hit) => hit.turnIds.includes(turnId))?.actorId;
      // Only the speaker's own words, and only when they still pass the checks a new turn must.
      if (!turn || turn.actorId !== owner) continue;
      const text = normalizeWords(turn.transcript);
      if (!text || turn.transcript.includes("?") || questionStart().test(text)) continue;
      if (permanentTierBlocked(turn.transcript)) continue;
      promoted.push({
        turnId,
        actorId: turn.actorId,
        saidAt: turn.at,
        words: capWords(turn.transcript, MEMORY_ARCHIVE_LIMITS.storedWords),
        reasons: ["recalled"],
      });
    }
    return promoted;
  }

  private insert(db: DatabaseSync, turn: QueuedTurn): boolean {
    if (this.diskBytes() >= this.limits.maxDiskBytes) {
      if (!this.diskFullLogged) {
        this.onError(`at the ${Math.round(this.limits.maxDiskBytes / 1024 / 1024)} MB disk budget; not keeping new words`);
        this.diskFullLogged = true;
      }
      return false;
    }
    if (db.prepare("SELECT 1 FROM forgotten WHERE turn_id = ?").get(turn.turnId)) return false;
    return inTransaction(db, () => {
      const result = db.prepare(`
        INSERT OR IGNORE INTO archive_items (turn_id, actor_id, said_at, words, reasons, grief, kept_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        turn.turnId,
        turn.actorId,
        turn.saidAt,
        turn.words,
        JSON.stringify(turn.reasons),
        griefWords(turn.words) ? 1 : 0,
        this.now().toISOString(),
      );
      if (result.changes > 0) {
        db.prepare("INSERT INTO archive_fts (rowid, words) VALUES (?, ?)").run(result.lastInsertRowid, turn.words);
      }
      return result.changes > 0;
    });
  }

  /** Over the per-person cap, words kept only for being recalled go first, the least recalled and oldest. */
  private enforceCap(db: DatabaseSync, actorId: string): void {
    const count = (db.prepare("SELECT count(*) AS n FROM archive_items WHERE actor_id = ?").get(actorId) as { readonly n: number }).n;
    const excess = count - this.limits.itemsPerPerson;
    if (excess <= 0) return;
    const victims = db.prepare(`
      SELECT i.id FROM archive_items i
      WHERE i.actor_id = ?
      ORDER BY (i.reasons LIKE '%"asked"%' OR i.reasons LIKE '%"milestone"%') ASC,
               (SELECT count(DISTINCT day) FROM archive_hits h WHERE h.turn_id = i.turn_id) ASC,
               i.said_at ASC
      LIMIT ?
    `).all(actorId, excess) as unknown as { readonly id: number }[];
    const dropFts = db.prepare("DELETE FROM archive_fts WHERE rowid = ?");
    const dropItem = db.prepare("DELETE FROM archive_items WHERE id = ?");
    for (const victim of victims) {
      dropFts.run(victim.id);
      dropItem.run(victim.id);
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.flushDelayMs);
    this.timer.unref();
  }

  private diskBytes(): number {
    let total = 0;
    for (const path of [this.memory.filePath, `${this.memory.filePath}-wal`]) {
      try {
        total += statSync(path).size;
      } catch {
        // Missing sidecars count as empty.
      }
    }
    return total;
  }
}

function directHit(words: string, current: readonly string[]): boolean {
  const docWords = new Set(queryWords(words, { keepNames: true }));
  return current.some((word) => docWords.has(word) || prefixHit(word, docWords));
}

function chatKey(actorId: string, request: Pick<VoiceBrainRequest, "channel" | "sessionId">): string {
  // Voice starts a new session on every wake, so a spoken chat is keyed by channel.
  return request.channel !== "voice" && request.sessionId
    ? `${actorId}|session:${request.sessionId}`
    : `${actorId}|channel:${request.channel}`;
}

function normalizeWords(text: string): string {
  return text.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
}

function roundMs(value: number): number {
  return Number(value.toFixed(2));
}
