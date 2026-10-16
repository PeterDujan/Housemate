import type {
  BasicAnswerTrace,
  BasicAnswerTraceEffect,
  BasicAnswerTraceFrame,
  BasicContextSlotEffect,
  BasicFocusContextFrame,
  PendingClarifierFrame,
} from "./basic-brain-contracts.js";
import type {
  ContextDomain,
  ContextEnvelope,
} from "./context-contract.js";

const FOCUS_HISTORY_LIMIT = 40;
const ANSWER_TRACE_HISTORY_LIMIT = 8;

export type BasicFocusContextEnvelope = ContextEnvelope<BasicFocusContextFrame>;
export type BasicClarifierContextEnvelope = ContextEnvelope<PendingClarifierFrame>;
export type BasicAnswerTraceContextEnvelope = ContextEnvelope<BasicAnswerTraceFrame>;

export interface BasicFocusSnapshot {
  readonly active: BasicFocusContextEnvelope | null;
  readonly recentByDomain: readonly BasicFocusContextEnvelope[];
}

export interface BasicClarifierSnapshot {
  /** Authoritative pending clarification. Clarifiers never leave their session. */
  readonly pending: BasicClarifierContextEnvelope | null;
  /** A one-shot claim in flight; matching later replies must fail closed rather than reroute. */
  readonly claimed: BasicClarifierContextEnvelope | null;
}

export interface BasicStoredAnswerTrace {
  readonly traceId: string;
  readonly responseText: string;
  readonly explanation: BasicAnswerTrace["explanation"];
  readonly envelopes: readonly BasicAnswerTraceContextEnvelope[];
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export interface BasicAnswerTraceSnapshot {
  readonly latest: BasicStoredAnswerTrace | null;
}

export class FocusStore {
  private readonly entries = new Map<string, readonly BasicFocusContextEnvelope[]>();

  sweep(timestamp: Date): void {
    for (const [key, entries] of this.entries) {
      this.publish(key, freshEnvelopes(entries, timestamp).slice(0, FOCUS_HISTORY_LIMIT));
    }
  }

  snapshotForKey(key: string | null, timestamp: Date): readonly BasicFocusContextEnvelope[] {
    if (!key) {
      return Object.freeze([]);
    }
    const fresh = freshEnvelopes(this.entries.get(key) ?? [], timestamp)
      .slice(0, FOCUS_HISTORY_LIMIT);
    this.publish(key, fresh);
    return Object.freeze([...fresh]);
  }

  stage(
    key: string,
    incoming: readonly BasicFocusContextEnvelope[],
    effect: BasicContextSlotEffect<BasicFocusContextFrame>,
    timestamp: Date,
  ): readonly BasicFocusContextEnvelope[] {
    const existing = freshEnvelopes(this.entries.get(key) ?? [], timestamp);
    switch (effect.lifecycle) {
      case "preserve":
        return Object.freeze(existing.slice(0, FOCUS_HISTORY_LIMIT));
      case "clear":
        return Object.freeze(effect.targetKind
          ? existing.filter((entry) => entry.payload.kind !== effect.targetKind).slice(0, FOCUS_HISTORY_LIMIT)
          : []);
      case "set":
        return Object.freeze([...incoming, ...existing].slice(0, FOCUS_HISTORY_LIMIT));
      case "update":
        return Object.freeze([
          ...incoming,
          ...existing.filter((entry) => entry.frameId !== effect.basedOnFrameId),
        ].slice(0, FOCUS_HISTORY_LIMIT));
    }
  }

  publish(key: string, next: readonly BasicFocusContextEnvelope[]): void {
    if (next.length > 0) {
      this.entries.set(key, Object.freeze([...next]));
    } else {
      this.entries.delete(key);
    }
  }

  clear(key: string): void {
    this.entries.delete(key);
  }
}

export class ClarifierStore {
  private readonly entries = new Map<string, BasicClarifierContextEnvelope>();
  private readonly claims = new Map<string, string>();

  sweep(timestamp: Date): void {
    for (const key of this.entries.keys()) {
      this.snapshotForKey(key, timestamp);
    }
    for (const key of this.claims.keys()) {
      if (!this.entries.has(key)) {
        this.claims.delete(key);
      }
    }
  }

  snapshotForKey(key: string | null, timestamp: Date): BasicClarifierContextEnvelope | null {
    if (!key) {
      return null;
    }
    const entry = this.entries.get(key) ?? null;
    if (!entry || timestamp.getTime() > entry.expiresAtMs) {
      this.entries.delete(key);
      this.claims.delete(key);
      return null;
    }
    return this.claims.get(key) === entry.frameId ? null : entry;
  }

  claimedForKey(key: string | null, timestamp: Date): BasicClarifierContextEnvelope | null {
    if (!key) {
      return null;
    }
    const entry = this.snapshotWithoutMutation(key, timestamp);
    if (!entry) {
      this.entries.delete(key);
      this.claims.delete(key);
      return null;
    }
    return this.claims.get(key) === entry.frameId ? entry : null;
  }

  stage(
    key: string,
    incoming: readonly BasicClarifierContextEnvelope[],
    effect: BasicContextSlotEffect<PendingClarifierFrame>,
    timestamp: Date,
  ): BasicClarifierContextEnvelope | null {
    const existing = this.snapshotWithoutMutation(key, timestamp);
    switch (effect.lifecycle) {
      case "preserve":
        return existing && this.claims.get(key) !== existing.frameId ? existing : null;
      case "clear":
        return null;
      case "set":
        return singleClarifier(incoming);
      case "update":
        if (existing?.frameId !== effect.basedOnFrameId) {
          return singleClarifier(incoming);
        }
        return singleClarifier(incoming);
    }
  }

  publish(key: string, next: BasicClarifierContextEnvelope | null): void {
    this.claims.delete(key);
    if (next) {
      this.entries.set(key, next);
    } else {
      this.entries.delete(key);
    }
  }

  claim(key: string, frameId: string, timestamp: Date): BasicClarifierContextEnvelope | null {
    const current = this.snapshotWithoutMutation(key, timestamp);
    if (!current || current.frameId !== frameId || this.claims.get(key) === frameId) {
      return null;
    }
    this.claims.set(key, frameId);
    return current;
  }

  clear(key: string): void {
    this.entries.delete(key);
    this.claims.delete(key);
  }

  private snapshotWithoutMutation(key: string, timestamp: Date): BasicClarifierContextEnvelope | null {
    const entry = this.entries.get(key) ?? null;
    return entry && timestamp.getTime() <= entry.expiresAtMs ? entry : null;
  }
}

export class AnswerTraceStore {
  private readonly entries = new Map<string, readonly BasicStoredAnswerTrace[]>();

  sweep(timestamp: Date): void {
    for (const [key, entries] of this.entries) {
      this.publish(key, freshTraces(entries, timestamp).slice(0, ANSWER_TRACE_HISTORY_LIMIT));
    }
  }

  snapshotForKey(key: string | null, timestamp: Date): readonly BasicStoredAnswerTrace[] {
    if (!key) {
      return Object.freeze([]);
    }
    const fresh = freshTraces(this.entries.get(key) ?? [], timestamp)
      .slice(0, ANSWER_TRACE_HISTORY_LIMIT);
    this.publish(key, fresh);
    return Object.freeze([...fresh]);
  }

  stage(
    key: string,
    incoming: BasicStoredAnswerTrace | null,
    effect: BasicAnswerTraceEffect,
    timestamp: Date,
  ): readonly BasicStoredAnswerTrace[] {
    const existing = freshTraces(this.entries.get(key) ?? [], timestamp);
    switch (effect.lifecycle) {
      case "preserve":
        return Object.freeze(existing.slice(0, ANSWER_TRACE_HISTORY_LIMIT));
      case "clear":
        return Object.freeze([]);
      case "set":
        return Object.freeze(incoming
          ? [incoming, ...existing].slice(0, ANSWER_TRACE_HISTORY_LIMIT)
          : existing.slice(0, ANSWER_TRACE_HISTORY_LIMIT));
      case "update":
        return Object.freeze(incoming
          ? [
              incoming,
              ...existing.filter((trace) => !trace.envelopes.some((entry) => entry.frameId === effect.basedOnFrameId)),
            ].slice(0, ANSWER_TRACE_HISTORY_LIMIT)
          : existing.slice(0, ANSWER_TRACE_HISTORY_LIMIT));
    }
  }

  publish(key: string, next: readonly BasicStoredAnswerTrace[]): void {
    if (next.length > 0) {
      this.entries.set(key, Object.freeze([...next]));
    } else {
      this.entries.delete(key);
    }
  }

  clear(key: string): void {
    this.entries.delete(key);
  }
}

export function focusSnapshot(
  session: readonly BasicFocusContextEnvelope[],
  speaker: readonly BasicFocusContextEnvelope[],
): BasicFocusSnapshot {
  const combined = dedupeByFrameId([...session, ...speaker]);
  const recentByDomain: BasicFocusContextEnvelope[] = [];
  const domains = new Set<ContextDomain>();
  for (const entry of combined) {
    if (domains.has(entry.domain)) {
      continue;
    }
    domains.add(entry.domain);
    recentByDomain.push(entry);
  }
  return Object.freeze({
    active: combined[0] ?? null,
    recentByDomain: Object.freeze(recentByDomain),
  });
}

export function storedAnswerTrace(
  trace: BasicAnswerTrace,
  envelopes: readonly BasicAnswerTraceContextEnvelope[],
): BasicStoredAnswerTrace {
  if (envelopes.length === 0) {
    throw new Error("stored answer trace requires at least one envelope");
  }
  const first = envelopes[0] as BasicAnswerTraceContextEnvelope;
  return Object.freeze({
    traceId: `answer-trace:${first.source.turnId}:${first.source.turnSequence}`,
    responseText: trace.responseText,
    explanation: trace.explanation
      ? Object.freeze({
          ...trace.explanation,
          sourceLabels: Object.freeze([...trace.explanation.sourceLabels]),
          sourceEntityIds: Object.freeze([...trace.explanation.sourceEntityIds]),
        })
      : null,
    envelopes: Object.freeze([...envelopes]),
    createdAtMs: Math.min(...envelopes.map((entry) => entry.createdAtMs)),
    expiresAtMs: Math.min(...envelopes.map((entry) => entry.expiresAtMs)),
  });
}

function singleClarifier(
  incoming: readonly BasicClarifierContextEnvelope[],
): BasicClarifierContextEnvelope {
  if (incoming.length !== 1) {
    throw new Error("clarifier store accepts exactly one pending frame");
  }
  return incoming[0] as BasicClarifierContextEnvelope;
}

function freshEnvelopes<TFrame>(
  entries: readonly ContextEnvelope<TFrame>[],
  timestamp: Date,
): readonly ContextEnvelope<TFrame>[] {
  return entries.filter((entry) => timestamp.getTime() <= entry.expiresAtMs);
}

function freshTraces(
  entries: readonly BasicStoredAnswerTrace[],
  timestamp: Date,
): readonly BasicStoredAnswerTrace[] {
  return entries.filter((entry) => timestamp.getTime() <= entry.expiresAtMs);
}

export function dedupeByFrameId<TFrame>(
  entries: readonly ContextEnvelope<TFrame>[],
): readonly ContextEnvelope<TFrame>[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.frameId)) {
      return false;
    }
    seen.add(entry.frameId);
    return true;
  });
}
