import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isAdmittedIntakeSource, trustedSpeakerId } from "./turn-source-trust.js";
import type { AppConfig } from "./config.js";
import { detectCorrection, normalizeCorrectionText, type CorrectionKind } from "./correction-signal.js";
import type { TurnLogEntry } from "./turn-log.js";
import { householdRegex } from "./household.js";

/**
 * When someone tells the assistant he got it wrong, code links the
 * correction to the answer it corrects and writes both down, so the mistake
 * becomes a test instead of vanishing into the turn log. Code only; nothing
 * here changes a route or a reply. Real household clients only (the same
 * rule as experience intake); unverified voices count, since a guest's
 * correction still points at a real misroute.
 */

export const CORRECTION_LEDGER_SCHEMA_VERSION = 1;
export const CORRECTION_LEDGER_LIMITS = Object.freeze({
  /** A correction links to the last reply on the same client this recently, across wake sessions. */
  linkWindowMs: 120_000,
  repliesPerClient: 8,
  clients: 32,
  storedChars: 300,
  maxOpen: 500,
  closedRetentionDays: 90,
  /** A question corrected this recently, still open on the dashboard, is asked about before answering. */
  repeatAskDays: 14,
});

/** When corrected with nothing to go on, the assistant asks instead of guessing. */
export const CORRECTION_ASK_REPLY = "Fair, I got that wrong. What did you mean?";
export const CORRECTION_REPEAT_ASK_REPLY = "I got that one wrong last time. What did you mean?";
/** A re-ask must never repeat the corrected answer with a straight face. */
export const CORRECTION_STILL_WRONG_REPLY = "Sorry, I'm still not getting it. Can you ask it another way?";

/** True when a re-asked answer is the same one someone already said was wrong (stored clipped). */
export function repeatsCorrectedAnswer(text: string, correctedResponse: string): boolean {
  const stored = normalizeCorrectionText(correctedResponse.replace(/…$/, ""));
  return stored.length > 0 && normalizeCorrectionText(text).startsWith(stored);
}

/** What the correction check decides before a turn is routed. */
export type CorrectionTurnPlan =
  | { readonly kind: "ask"; readonly reply: string; readonly corrected: CorrectionTurnRecord; readonly reason: "bare_correction" | "repeat" }
  | { readonly kind: "reask"; readonly transcript: string; readonly corrected: CorrectionTurnRecord };

export type CorrectionTurnKey = Pick<TurnLogEntry, "channel" | "sourceVia" | "room" | "sessionId" | "transcript">;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One write queue per ledger file, so the brain and the dashboard never interleave rewrites. */
const writeQueues = new Map<string, Promise<unknown>>();

export type CorrectionCloseReason = "fixed" | "not_a_correction";
export const CORRECTION_CLOSE_REASONS: readonly CorrectionCloseReason[] = ["fixed", "not_a_correction"];

export interface CorrectionTurnRecord {
  readonly turnId: string;
  readonly timestamp: string;
  readonly transcript: string;
  readonly responseText: string;
  readonly route: string;
  readonly outcome: string;
  readonly modelUsed: boolean;
  readonly sessionId: string | null;
}

export interface CorrectionLedgerEntry {
  readonly schemaVersion: typeof CORRECTION_LEDGER_SCHEMA_VERSION;
  /** The correction turn's id. */
  readonly id: string;
  readonly recordedAt: string;
  readonly status: "open" | "closed";
  readonly closedAt?: string;
  readonly closedReason?: string;
  readonly kind: CorrectionKind;
  readonly correctedText: string | null;
  /** Trusted household actor id, or "unverified". */
  readonly speaker: string;
  readonly channel: string;
  readonly sourceVia: string | null;
  readonly room: string | null;
  readonly appVersion: string | null;
  readonly correction: CorrectionTurnRecord;
  /** The answer being corrected; null when no reply on that client was recent enough. */
  readonly corrected: CorrectionTurnRecord | null;
}

interface RingRecord {
  readonly record: CorrectionTurnRecord;
  readonly repliedAtMs: number;
  readonly wasCorrection: boolean;
  /** On a correction turn: the answer it corrected, so a second "still wrong" links back to it. */
  readonly correctionTarget: CorrectionTurnRecord | null;
}

export interface CorrectionLedgerOptions {
  readonly filePath: string;
  readonly appVersion?: string | null;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

export function correctionLedgerPath(config: Pick<AppConfig, "dataDir">): string {
  return join(config.dataDir, "cognition", "corrections.jsonl");
}

export class CorrectionLedger {
  private readonly rings = new Map<string, RingRecord[]>();
  /** Per client: the question the assistant just asked about, waiting for what the speaker meant. */
  private readonly pendingAsks = new Map<string, { readonly corrected: CorrectionTurnRecord; readonly askedAtMs: number }>();
  private openIndex: { readonly mtimeMs: number; readonly entries: readonly CorrectionLedgerEntry[] } | null = null;
  private readonly now: () => Date;

  constructor(private readonly options: CorrectionLedgerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Called after every logged turn. Remembers the reply for linking and, when
   * the turn is a correction, queues a ledger entry. Returns that entry.
   */
  observe(turn: TurnLogEntry): CorrectionLedgerEntry | null {
    if (!isAdmittedIntakeSource(turn) || !turn.transcript?.trim()) {
      return null;
    }
    const key = clientKey(turn);
    const ring = this.rings.get(key) ?? [];
    const startedAtMs = Date.parse(turn.timestamp);
    const previous = ring.at(-1);
    const recent = previous && startedAtMs - previous.repliedAtMs <= CORRECTION_LEDGER_LIMITS.linkWindowMs
      ? previous
      : null;
    let signal = detectCorrection(turn.transcript);
    // A reply to a question the assistant just asked is an answer, not a correction.
    if (signal && recent?.record.responseText.trim().endsWith("?")) {
      signal = null;
    }
    const record = turnRecord(turn);
    const corrected = signal && recent
      ? recent.wasCorrection ? recent.correctionTarget : recent.record
      : null;
    this.remember(key, ring, {
      record,
      repliedAtMs: startedAtMs + Math.max(0, turn.latencyMs),
      wasCorrection: signal !== null,
      correctionTarget: corrected,
    });
    if (!signal) {
      return null;
    }
    const entry: CorrectionLedgerEntry = {
      schemaVersion: CORRECTION_LEDGER_SCHEMA_VERSION,
      id: turn.turnId,
      recordedAt: this.now().toISOString(),
      status: "open",
      kind: signal.kind,
      correctedText: signal.correctedText,
      speaker: trustedSpeakerId(turn) ?? "unverified",
      channel: turn.channel,
      sourceVia: turn.sourceVia ?? null,
      room: turn.room ?? null,
      appVersion: this.options.appVersion ?? null,
      correction: record,
      corrected,
    };
    this.enqueue((entries) => [...entries.filter((existing) => existing.id !== entry.id), entry]);
    return entry;
  }

  /**
   * Before routing. A bare correction ("that's wrong") with a recent
   * answer to point at gets a question back. The next reply on that client is
   * re-asked together with the corrected question, unless it is a whole new
   * question or a never mind. A question someone corrected in the last 14
   * days, still open, is asked about first. A correction that already says
   * what was meant is left to the brain's own repair. Real clients only.
   */
  planTurn(turn: CorrectionTurnKey, nowMs: number): CorrectionTurnPlan | null {
    const transcript = turn.transcript?.trim() ?? "";
    if (!isAdmittedIntakeSource(turn) || !transcript) {
      return null;
    }
    const key = clientKey(turn);
    const pending = this.pendingAsks.get(key);
    this.pendingAsks.delete(key);
    const signal = detectCorrection(transcript);
    if (pending && nowMs - pending.askedAtMs <= CORRECTION_LEDGER_LIMITS.linkWindowMs) {
      const normalized = normalizeCorrectionText(transcript);
      if (CANCEL_PATTERN.test(normalized) || (!signal && looksLikeWholeQuestion(transcript, normalized))) {
        return null;
      }
      const meant = signal
        ? signal.correctedText && originalCase(transcript, signal.correctedText)
        : stripMeaningLead(transcript);
      return meant
        ? { kind: "reask", transcript: `${stripEnd(pending.corrected.transcript)}, ${meant}?`, corrected: pending.corrected }
        : null;
    }
    const recent = this.recentReply(key, nowMs);
    if (signal) {
      if (!recent || recent.record.responseText.trim().endsWith("?")) {
        return null;
      }
      const corrected = recent.wasCorrection ? recent.correctionTarget : recent.record;
      if (!corrected || carriesNewContext(signal.correctedText, corrected)) {
        return null;
      }
      this.pendingAsks.set(key, { corrected, askedAtMs: nowMs });
      return { kind: "ask", reply: CORRECTION_ASK_REPLY, corrected, reason: "bare_correction" };
    }
    const repeat = this.openRepeatOf(transcript, nowMs);
    if (!repeat?.corrected) {
      return null;
    }
    this.pendingAsks.set(key, { corrected: repeat.corrected, askedAtMs: nowMs });
    return { kind: "ask", reply: CORRECTION_REPEAT_ASK_REPLY, corrected: repeat.corrected, reason: "repeat" };
  }

  /** "Forget what I said": drop every entry touching these turns. */
  forgetTurns(turnIds: readonly string[]): Promise<void> {
    const forgotten = new Set(turnIds);
    if (forgotten.size === 0) {
      return this.flush();
    }
    for (const [key, ring] of this.rings) {
      this.rings.set(key, ring.filter(({ record, correctionTarget }) =>
        !forgotten.has(record.turnId) && !forgotten.has(correctionTarget?.turnId ?? "")));
    }
    this.enqueue((entries) => entries.filter((entry) =>
      !forgotten.has(entry.correction.turnId) && !forgotten.has(entry.corrected?.turnId ?? "")));
    return this.flush();
  }

  /** Dashboard: the owner marks an entry fixed or not a correction. False when there is no open entry. */
  async close(id: string, reason: CorrectionCloseReason): Promise<boolean> {
    let closed = false;
    const closedAt = this.now().toISOString();
    this.enqueue((entries) => entries.map((entry) => {
      if (entry.id !== id || entry.status !== "open") return entry;
      closed = true;
      return { ...entry, status: "closed", closedAt, closedReason: reason };
    }));
    await this.flush();
    return closed;
  }

  /** Resolves once every queued write has landed. */
  flush(): Promise<void> {
    return (writeQueues.get(this.options.filePath) ?? Promise.resolve()).then(() => undefined);
  }

  private recentReply(key: string, nowMs: number): RingRecord | null {
    const previous = this.rings.get(key)?.at(-1);
    return previous && nowMs - previous.repliedAtMs <= CORRECTION_LEDGER_LIMITS.linkWindowMs ? previous : null;
  }

  // Open entries whose corrected question is exactly this one, re-read only when the file changes.
  private openRepeatOf(transcript: string, nowMs: number): CorrectionLedgerEntry | null {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.options.filePath).mtimeMs;
    } catch {
      return null;
    }
    if (this.openIndex?.mtimeMs !== mtimeMs) {
      this.openIndex = {
        mtimeMs,
        entries: readCorrectionLedger(this.options.filePath).filter((entry) => entry.status === "open" && entry.corrected),
      };
    }
    const wanted = normalizeCorrectionText(transcript);
    const since = nowMs - CORRECTION_LEDGER_LIMITS.repeatAskDays * DAY_MS;
    return this.openIndex.entries.find((entry) =>
      Date.parse(entry.correction.timestamp) >= since
      && normalizeCorrectionText(entry.corrected?.transcript ?? "") === wanted) ?? null;
  }

  private remember(key: string, ring: RingRecord[], item: RingRecord): void {
    ring.push(item);
    if (ring.length > CORRECTION_LEDGER_LIMITS.repliesPerClient) {
      ring.splice(0, ring.length - CORRECTION_LEDGER_LIMITS.repliesPerClient);
    }
    this.rings.delete(key);
    this.rings.set(key, ring);
    if (this.rings.size > CORRECTION_LEDGER_LIMITS.clients) {
      const oldest = this.rings.keys().next().value;
      if (oldest !== undefined) this.rings.delete(oldest);
    }
  }

  // Writes are rare (about one a month), so each one rewrites the small file whole.
  private enqueue(change: (entries: readonly CorrectionLedgerEntry[]) => CorrectionLedgerEntry[]): void {
    const filePath = this.options.filePath;
    const next = (writeQueues.get(filePath) ?? Promise.resolve())
      .then(async () => {
        const entries = await readEntries(filePath);
        await writeEntries(filePath, applyLimits(change(entries), this.now()));
      })
      .catch((error: unknown) => {
        try {
          this.options.onError?.(error);
        } catch {
          // Reporting must never break the reply path.
        }
      });
    writeQueues.set(filePath, next);
    void next.then(() => {
      if (writeQueues.get(filePath) === next) writeQueues.delete(filePath);
    });
  }
}

/** Open entries past the cap drop oldest first; closed ones go after 90 days. */
export function applyLimits(entries: readonly CorrectionLedgerEntry[], now: Date): CorrectionLedgerEntry[] {
  const closedCutoff = now.getTime() - CORRECTION_LEDGER_LIMITS.closedRetentionDays * DAY_MS;
  const kept = entries.filter((entry) =>
    entry.status === "open" || Date.parse(entry.closedAt ?? entry.recordedAt) >= closedCutoff);
  const open = kept.filter((entry) => entry.status === "open");
  const excess = open.length - CORRECTION_LEDGER_LIMITS.maxOpen;
  if (excess <= 0) {
    return kept;
  }
  const dropped = new Set(
    [...open].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)).slice(0, excess).map((entry) => entry.id),
  );
  console.warn(`[brain] correction ledger over ${CORRECTION_LEDGER_LIMITS.maxOpen} open entries; dropped ${dropped.size} oldest`);
  return kept.filter((entry) => !dropped.has(entry.id));
}

export interface CorrectionDashboardSummary {
  readonly enabled: boolean;
  readonly open: number;
  /** Open entries, newest first. */
  readonly items: readonly CorrectionLedgerEntry[];
}

export function correctionDashboardSummary(
  filePath: string,
  enabled: boolean,
  limit: number,
): CorrectionDashboardSummary {
  const open = readCorrectionLedger(filePath)
    .filter((entry) => entry.status === "open")
    .sort((a, b) => b.correction.timestamp.localeCompare(a.correction.timestamp));
  return { enabled, open: open.length, items: open.slice(0, limit) };
}

export function readCorrectionLedger(filePath: string): CorrectionLedgerEntry[] {
  return existsSync(filePath) ? parseEntries(readFileSync(filePath, "utf8")) : [];
}

async function readEntries(filePath: string): Promise<CorrectionLedgerEntry[]> {
  try {
    return parseEntries(await readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function parseEntries(content: string): CorrectionLedgerEntry[] {
  const entries: CorrectionLedgerEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as CorrectionLedgerEntry;
      if (entry.schemaVersion === CORRECTION_LEDGER_SCHEMA_VERSION && typeof entry.id === "string") {
        entries.push(entry);
      }
    } catch {
      // A torn line is skipped rather than guessed about.
    }
  }
  return entries;
}

async function writeEntries(filePath: string, entries: readonly CorrectionLedgerEntry[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp`;
  const body = entries.map((entry) => JSON.stringify(entry)).join("\n");
  try {
    await writeFile(tempPath, body ? `${body}\n` : "", { encoding: "utf8", mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

const CANCEL_PATTERN = /^(?:never ?mind|forget it|forget about it|(?:it )?doesn't matter|nothing|all good|no worries|don't worry(?: about it)?|cancel|stop)\b/;
const QUESTION_START = /^(?:what|what's|whats|who|who's|when|where|why|how|which|is|are|was|were|can|could|do|does|did|will|would|should|tell|turn|play|set|show)\b/;

// "What year did the film come out?" is a new question; "the movie" is what they meant.
function looksLikeWholeQuestion(transcript: string, normalized: string): boolean {
  return QUESTION_START.test(normalized) && normalized.split(" ").length >= 3
    || transcript.trim().endsWith("?") && normalized.split(" ").length >= 4;
}

function stripMeaningLead(transcript: string): string {
  return transcript
    .trim()
    .replace(householdRegex(String.raw`^(?:(?:hey )?{ASSISTANT}[,.\s]+)`, "i"), "")
    .replace(/^(?:(?:no|nah|i mean|i meant|i was asking about|i was talking about|the one about)[,.\s]+)+/i, "")
    .replace(/[\s?.!,]+$/, "")
    // Speech-to-text capitalises the first word; "The movie" joins the question as "the movie".
    .replace(/^(The|A|An|In|On|At|For|About|My|Our|That|This|Its|It's)\b/, (word) => word.toLowerCase());
}

// The speaker's own words for text the detector found in lower case.
function originalCase(transcript: string, lower: string): string {
  const index = transcript.toLowerCase().indexOf(lower);
  return index >= 0 ? transcript.slice(index, index + lower.length) : lower;
}

function stripEnd(question: string): string {
  return question.trim().replace(/[\s?.!,]+$/, "");
}

// "I meant the movie" adds something; restating the same question does not.
function carriesNewContext(correctedText: string | null, corrected: CorrectionTurnRecord): boolean {
  if (!correctedText) return false;
  return !normalizeCorrectionText(corrected.transcript).includes(normalizeCorrectionText(correctedText));
}

function clientKey(turn: Pick<TurnLogEntry, "channel" | "sourceVia" | "room" | "sessionId">): string {
  const source = (turn.sourceVia ?? "").trim().toLowerCase();
  return turn.channel === "voice"
    ? `voice|${source}|${turn.room ?? ""}`
    : `${turn.channel}|${source}|${turn.sessionId ?? ""}`;
}

function turnRecord(turn: TurnLogEntry): CorrectionTurnRecord {
  return {
    turnId: turn.turnId,
    timestamp: turn.timestamp,
    transcript: clip(turn.transcript ?? ""),
    responseText: clip(turn.responseText ?? ""),
    route: turn.route,
    outcome: turn.outcome,
    modelUsed: turn.modelUsed,
    sessionId: turn.sessionId ?? null,
  };
}

function clip(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= CORRECTION_LEDGER_LIMITS.storedChars
    ? trimmed
    : `${trimmed.slice(0, CORRECTION_LEDGER_LIMITS.storedChars - 1).trimEnd()}…`;
}
