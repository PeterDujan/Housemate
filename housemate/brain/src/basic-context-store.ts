import type {
  BasicAnswerTrace,
  BasicAnswerTraceFrame,
  BasicCommittedResult,
  BasicContextEmission,
  BasicContextEffect,
  BasicContextFrame,
  BasicContextSlotEffect,
  EntityStatusTargetAcquisition,
  BasicFocusContextFrame,
  BasicResult,
  BasicRoute,
  PendingClarifierFrame,
  ResolvedTarget,
} from "./basic-brain-contracts.js";
import { AnswerTraceStore, type BasicAnswerTraceContextEnvelope, type BasicAnswerTraceSnapshot, type BasicClarifierContextEnvelope, type BasicClarifierSnapshot, type BasicFocusContextEnvelope, type BasicFocusSnapshot, ClarifierStore, dedupeByFrameId, focusSnapshot, FocusStore, storedAnswerTrace } from "./basic-context-owner-stores.js";
import {
  createContextEnvelope,
  type ContextAllowedUse,
  type ContextDomain,
  type ContextEnvelope,
  type ContextOwner,
  type ContextPayloadProvenance,
  type ContextSensitivity,
  type ContextStorageScope,
} from "./context-contract.js";
import {
  contextCarryPersonId,
  resolveSpeakerPrincipal,
} from "./speaker-principal.js";
import type { VoiceBrainRequest } from "./voice-brain.js";

const BASIC_CONTEXT_FRAME_LIMIT = 40;
const BASIC_EXPLANATION_FRAME_LIMIT = 8;
const BASIC_STORED_CONTEXT_FRAME_LIMIT = BASIC_CONTEXT_FRAME_LIMIT + BASIC_EXPLANATION_FRAME_LIMIT;
const BASIC_CONTEXT_TTL_MS = 5 * 60 * 1000;
const BASIC_CONTEXT_SWEEP_INTERVAL_MS = 60 * 1000;
const BASIC_CONTEXT_FINAL_METADATA_RETENTION_MS = BASIC_CONTEXT_TTL_MS * 2;
const BASIC_CONTEXT_IN_FLIGHT_METADATA_RETENTION_MS = 60 * 60 * 1000;

export type BasicContextEnvelope = ContextEnvelope<BasicContextFrame>;
export type BasicEntityStatusContextEnvelope = ContextEnvelope<Extract<BasicContextFrame, { kind: "entity_status" }>>;
export type BasicMetricsContextFrame = Extract<BasicContextFrame, {
  kind: "energy_budget" | "current_power_ranking" | "current_metric" | "history_metric" | "comparison_metric";
}>;
export type BasicWeatherContextFrame = Extract<BasicContextFrame, { kind: "weather" }>;
export type BasicCalendarContextFrame = Extract<BasicContextFrame, { kind: "calendar" }>;
export type BasicHouseLightsContextFrame = Extract<BasicContextFrame, { kind: "house_lights" }>;
export type BasicCalculationContextFrame = Extract<BasicContextFrame, { kind: "calculation" }>;
export type BasicMusicContextFrame = Extract<BasicContextFrame, { kind: "music_playback" }>;

export interface BasicDomainContextView<TFrame extends BasicFocusContextFrame> {
  /** The domain owns the current semantic focus, after its carry policy is applied. */
  readonly active: ContextEnvelope<TFrame> | null;
  /** Current-session domain context first, then the newest allowed trusted-speaker carry. */
  readonly recent: ContextEnvelope<TFrame> | null;
  /** Bounded session-precedence history, newest-first within each scope and deduped by frame identity. */
  readonly history: readonly ContextEnvelope<TFrame>[];
}

export interface BasicEntityStatusContextView {
  readonly active: BasicEntityStatusContextEnvelope | null;
  readonly recent: BasicEntityStatusContextEnvelope | null;
  readonly history: readonly BasicEntityStatusContextEnvelope[];
}

export interface BasicActionContextReference {
  readonly sourceFrameId: string;
  readonly sourceTurnSequence: number;
  readonly sessionId: string;
  readonly target: ResolvedTarget;
  readonly targetAcquisition: "explicit" | "clarified";
  readonly sourceQuery: string | null;
  readonly revalidateBeforeUse: true;
}

export interface BasicContextViews {
  readonly focus: BasicFocusSnapshot;
  readonly clarifier: BasicClarifierSnapshot;
  readonly answerTrace: BasicAnswerTraceSnapshot;
  readonly entityStatus: BasicEntityStatusContextView;
  readonly metrics: BasicDomainContextView<BasicMetricsContextFrame>;
  readonly weather: BasicDomainContextView<BasicWeatherContextFrame>;
  readonly calendar: BasicDomainContextView<BasicCalendarContextFrame>;
  readonly houseLights: BasicDomainContextView<BasicHouseLightsContextFrame>;
  /** Calculations never inherit the trusted-speaker copy from another session. */
  readonly calculation: BasicDomainContextView<BasicCalculationContextFrame>;
  /** Music is session-only and read only by the explicit music follow-up executor. */
  readonly music: BasicDomainContextView<BasicMusicContextFrame>;
  readonly actionTarget: BasicActionContextReference | null;
}

export interface BasicContextCommitMetadata {
  readonly turnId: string;
  readonly turnSequence: number;
  readonly timestamp: Date;
}

export interface BasicContextTurnAdmission {
  readonly accepted: boolean;
  /** Previous request admitted in this session, even when other sessions interleave. */
  readonly previousSessionTurnSequence: number | null;
}

export interface BasicContextSnapshot {
  readonly sessionEnvelopes: readonly BasicContextEnvelope[];
  readonly speakerEnvelopes: readonly BasicContextEnvelope[];
  /** Payload-redacted projection for turn analysis and typed diagnostics. */
  readonly frameKinds: readonly BasicContextFrame["kind"][];
  readonly hasSessionContext: boolean;
  readonly views: BasicContextViews;
}

interface ContextStorageKey {
  readonly key: string;
  readonly storageScope: ContextStorageScope;
}

interface BasicContextStorageAccess {
  readonly sessionNamespace: string | null;
  readonly sessionKey: string | null;
  readonly speakerKey: string | null;
}

interface BasicContextTurnWatermark {
  readonly turnId: string;
  readonly turnSequence: number;
  readonly phase: "begin" | "final";
  readonly timestampMs: number;
}

interface BasicContextClassification {
  readonly domain: ContextDomain;
  readonly owner: ContextOwner;
  readonly sensitivity: ContextSensitivity;
  readonly allowedUses: readonly ContextAllowedUse[];
  readonly payloadProvenanceKind: ContextPayloadProvenance["kind"];
}

export class BasicContextStore {
  /** Raw committed envelopes: they decide `hasSessionContext`; owner views never read them. */
  private readonly legacyEntries = new Map<string, readonly BasicContextEnvelope[]>();
  private readonly focusStore = new FocusStore();
  private readonly clarifierStore = new ClarifierStore();
  private readonly answerTraceStore = new AnswerTraceStore();
  private readonly turnWatermarks = new Map<string, BasicContextTurnWatermark>();
  private readonly sessionPartitions = new Map<string, Set<string>>();
  private readonly sessionSpeakerKeys = new Map<string, Set<string>>();
  private nextSweepAtMs = Number.NEGATIVE_INFINITY;

  beginTurn(
    request: VoiceBrainRequest,
    metadata: BasicContextCommitMetadata,
    options: { readonly clearBeforeCore?: boolean } = {},
  ): BasicContextTurnAdmission {
    this.sweep(metadata.timestamp);
    const access = this.storageAccessFor(request, true);
    const authorityKey = access.sessionNamespace ?? access.speakerKey;
    const previous = authorityKey ? this.turnWatermarks.get(authorityKey) ?? null : null;
    if (!authorityKey || !this.claimBegin(authorityKey, metadata)) {
      return Object.freeze({ accepted: false, previousSessionTurnSequence: null });
    }
    if (access.speakerKey && access.speakerKey !== authorityKey) {
      this.claimBegin(access.speakerKey, metadata);
    }
    if (!options.clearBeforeCore) {
      return Object.freeze({
        accepted: true,
        previousSessionTurnSequence: access.sessionNamespace ? previous?.turnSequence ?? null : null,
      });
    }
    this.clearSessionNamespace(access.sessionNamespace);
    for (const speakerKey of this.speakerKeysForClear(access)) {
      if (this.claimOrRetainBegin(speakerKey, metadata)) {
        this.clearStorageKey(speakerKey);
      }
    }
    return Object.freeze({
      accepted: true,
      previousSessionTurnSequence: access.sessionNamespace ? previous?.turnSequence ?? null : null,
    });
  }

  snapshotFor(
    request: VoiceBrainRequest,
    timestamp: Date,
    options: { readonly previousSessionTurnSequence?: number | null } = {},
  ): BasicContextSnapshot {
    this.sweep(timestamp);
    const { sessionKey, speakerKey } = this.storageAccessFor(request, false);
    const sessionEnvelopes = Object.freeze([
      ...(sessionKey ? this.freshLegacyFramesForKey(sessionKey, timestamp) : []),
    ]);
    const speakerEnvelopes = Object.freeze([
      ...(speakerKey && speakerKey !== sessionKey ? this.freshLegacyFramesForKey(speakerKey, timestamp) : []),
    ]);
    const sessionFocus = this.focusStore.snapshotForKey(sessionKey, timestamp);
    const speakerFocus = speakerKey && speakerKey !== sessionKey
      ? this.focusStore.snapshotForKey(speakerKey, timestamp)
      : Object.freeze([]);
    const carryEligibleSpeakerFocus = speakerFocus.filter((entry) => (
      entry.domain !== "calculation"
      && entry.domain !== "dialogue"
      && entry.domain !== "music"
    ));
    const focus = focusSnapshot(sessionFocus, carryEligibleSpeakerFocus);
    const pendingClarifier = this.clarifierStore.snapshotForKey(sessionKey, timestamp);
    const claimedClarifier = this.clarifierStore.claimedForKey(sessionKey, timestamp);
    const sessionTraces = this.answerTraceStore.snapshotForKey(sessionKey, timestamp);
    const speakerTraces = speakerKey && speakerKey !== sessionKey
      ? this.answerTraceStore.snapshotForKey(speakerKey, timestamp)
      : Object.freeze([]);
    const recentStatus = focus.recentByDomain.find(isEntityStatusEnvelope) ?? null;
    const activeStatus = focus.active && isEntityStatusEnvelope(focus.active) ? focus.active : null;
    const statusHistory = dedupeByFrameId([...sessionFocus, ...carryEligibleSpeakerFocus])
      .filter(isEntityStatusEnvelope);
    const carriedFocusHistory = dedupeByFrameId([...sessionFocus, ...carryEligibleSpeakerFocus]);
    const metrics = domainContextView(focus.active, carriedFocusHistory, isMetricsEnvelope);
    const weather = domainContextView(focus.active, carriedFocusHistory, isWeatherEnvelope);
    const calendar = domainContextView(focus.active, carriedFocusHistory, isCalendarEnvelope);
    const houseLights = domainContextView(focus.active, carriedFocusHistory, isHouseLightsEnvelope);
    const calculation = domainContextView(sessionFocus[0] ?? null, sessionFocus, isCalculationEnvelope);
    const music = domainContextView(sessionFocus[0] ?? null, sessionFocus, isMusicEnvelope);
    const actionTarget = actionContextReference(
      sessionFocus[0] ?? null,
      request,
      options.previousSessionTurnSequence ?? null,
    );
    const views = Object.freeze({
      focus,
      clarifier: Object.freeze({
        pending: pendingClarifier,
        claimed: claimedClarifier,
      }),
      answerTrace: Object.freeze({
        latest: sessionTraces[0] ?? speakerTraces[0] ?? null,
      }),
      entityStatus: Object.freeze({
        active: activeStatus,
        recent: recentStatus,
        history: Object.freeze(statusHistory),
      }),
      metrics,
      weather,
      calendar,
      houseLights,
      calculation,
      music,
      actionTarget,
    });
    const visibleClarifier = views.clarifier.pending ?? views.clarifier.claimed;
    const frameKinds = Object.freeze([
      ...views.focus.recentByDomain.map((entry) => entry.payload.kind),
      ...(visibleClarifier ? [visibleClarifier.payload.kind] : []),
      ...(views.answerTrace.latest?.envelopes.map((entry) => entry.payload.kind) ?? []),
    ]);
    return Object.freeze({
      sessionEnvelopes,
      speakerEnvelopes,
      frameKinds,
      hasSessionContext: sessionEnvelopes.some((entry) => entry.payload.kind !== "answer_explanation"),
      views,
    });
  }

  hasSessionFrames(request: VoiceBrainRequest, timestamp: Date): boolean {
    return this.snapshotFor(request, timestamp).hasSessionContext;
  }

  claimClarifier(
    request: VoiceBrainRequest,
    metadata: BasicContextCommitMetadata,
    frameId: string,
  ): BasicClarifierContextEnvelope | null {
    const access = this.storageAccessFor(request, false);
    if (!access.sessionNamespace || !access.sessionKey) {
      return null;
    }
    const watermarkValue = this.turnWatermarks.get(access.sessionNamespace);
    if (!sameTurnWatermark(watermarkValue, metadata, "begin")) {
      return null;
    }
    return this.clarifierStore.claim(access.sessionKey, frameId, metadata.timestamp);
  }

  commit(
    request: VoiceBrainRequest,
    result: BasicCommittedResult,
    metadata: BasicContextCommitMetadata,
  ): void {
    const access = this.storageAccessFor(request, false);
    const authorityKey = access.sessionNamespace ?? access.speakerKey;
    const emissions = explicitContextEmissionsForResult(result);
    const wideClear = hasSessionAndSpeakerClear(result.contextEffect);
    const sessionStage = !wideClear && access.sessionKey
      ? this.stageCommitToKey({ key: access.sessionKey, storageScope: "session" }, request, result, emissions, metadata)
      : null;
    const speakerStage = !wideClear && access.speakerKey
      ? this.stageCommitToKey({ key: access.speakerKey, storageScope: "speaker" }, request, result, emissions, metadata)
      : null;
    if (!authorityKey || !this.claimFinal(authorityKey, metadata)) {
      return;
    }

    if (wideClear) {
      this.clearSessionNamespace(access.sessionNamespace);
      for (const speakerKey of this.speakerKeysForClear(access)) {
        if (this.claimOrReplaceFinal(speakerKey, metadata)) {
          this.clearStorageKey(speakerKey);
        }
      }
      return;
    }

    if (access.sessionKey && sessionStage) {
      sessionStage.publish();
    }
    if (access.speakerKey && access.speakerKey !== authorityKey && this.claimFinal(access.speakerKey, metadata)) {
      speakerStage?.publish();
    } else if (access.speakerKey && access.speakerKey === authorityKey) {
      speakerStage?.publish();
    }
  }

  private stageCommitToKey(
    storage: ContextStorageKey,
    request: VoiceBrainRequest,
    result: BasicCommittedResult,
    emissions: readonly BasicContextEmission<BasicContextFrame>[],
    metadata: BasicContextCommitMetadata,
  ): { readonly publish: () => void } {
    const incoming = basicContextEnvelopesForResult(request, result, metadata, storage.storageScope, emissions);
    const existing = this.freshLegacyFramesWithoutMutation(storage.key, metadata.timestamp)
      .filter((entry) => shouldRetainExistingEnvelope(entry, result.contextEffect));
    const nextPrimary = [
      ...incoming.filter((entry) => entry.payload.kind !== "answer_explanation"),
      ...existing.filter((entry) => entry.payload.kind !== "answer_explanation"),
    ].slice(0, BASIC_CONTEXT_FRAME_LIMIT);
    const nextExplanation = [
      ...incoming.filter((entry) => entry.payload.kind === "answer_explanation"),
      ...existing.filter((entry) => entry.payload.kind === "answer_explanation"),
    ].slice(0, BASIC_EXPLANATION_FRAME_LIMIT);
    const next = [...nextPrimary, ...nextExplanation];
    const incomingFocus = incoming.filter(isFocusEnvelope);
    const incomingClarifiers = incoming.filter(isClarifierEnvelope);
    const incomingTrace = incoming.filter(isAnswerTraceEnvelope);
    const nextFocus = this.focusStore.stage(
      storage.key,
      incomingFocus,
      result.contextEffect.focus,
      metadata.timestamp,
    );
    const nextClarifier = storage.storageScope === "session"
      ? this.clarifierStore.stage(
        storage.key,
        incomingClarifiers,
        result.contextEffect.clarifier,
        metadata.timestamp,
      )
      : null;
    const trace = result.answerTrace && incomingTrace.length > 0
      ? storedAnswerTrace(result.answerTrace, incomingTrace)
      : null;
    const nextTraces = this.answerTraceStore.stage(
      storage.key,
      trace,
      result.contextEffect.answerTrace,
      metadata.timestamp,
    );
    return {
      publish: () => {
        this.publishLegacy(storage.key, next);
        this.focusStore.publish(storage.key, nextFocus);
        if (storage.storageScope === "session") {
          this.clarifierStore.publish(storage.key, nextClarifier);
        }
        this.answerTraceStore.publish(storage.key, nextTraces);
      },
    };
  }

  private freshLegacyFramesForKey(key: string, timestamp: Date): readonly BasicContextEnvelope[] {
    const fresh = this.freshLegacyFramesWithoutMutation(key, timestamp);
    this.publishLegacy(key, fresh);
    return fresh;
  }

  private freshLegacyFramesWithoutMutation(key: string, timestamp: Date): readonly BasicContextEnvelope[] {
    return (this.legacyEntries.get(key) ?? [])
      .filter((entry) => timestamp.getTime() <= entry.expiresAtMs)
      .slice(0, BASIC_STORED_CONTEXT_FRAME_LIMIT);
  }

  private publishLegacy(key: string, next: readonly BasicContextEnvelope[]): void {
    if (next.length > 0) {
      this.legacyEntries.set(key, Object.freeze([...next]));
    } else {
      this.legacyEntries.delete(key);
    }
  }

  private storageAccessFor(request: VoiceBrainRequest, register: boolean): BasicContextStorageAccess {
    const principal = resolveSpeakerPrincipal(request.speaker);
    const carryPersonId = contextCarryPersonId(principal);
    const evidenceToken = principal.token ?? "anonymous";
    const sessionNamespace = request.sessionId
      ? storageKey(["context-session-order", request.channel, request.sessionId])
      : null;
    const sessionKey = request.sessionId
      ? storageKey([
        "context-session",
        request.channel,
        request.sessionId,
        carryPersonId ? "carry-eligible" : "session-only",
        ...(carryPersonId
          ? [carryPersonId]
          : [principal.trust, principal.identitySource, evidenceToken]),
      ])
      : null;
    const speakerKey = carryPersonId
      ? storageKey(["context-speaker", request.channel, carryPersonId])
      : null;
    if (register && sessionNamespace && sessionKey) {
      addIndexedValue(this.sessionPartitions, sessionNamespace, sessionKey);
      if (speakerKey) {
        addIndexedValue(this.sessionSpeakerKeys, sessionNamespace, speakerKey);
      }
    }
    return { sessionNamespace, sessionKey, speakerKey };
  }

  private clearSessionNamespace(sessionNamespace: string | null): void {
    if (!sessionNamespace) {
      return;
    }
    for (const sessionKey of this.sessionPartitions.get(sessionNamespace) ?? []) {
      this.clearStorageKey(sessionKey);
    }
  }

  private clearStorageKey(key: string): void {
    this.legacyEntries.delete(key);
    this.focusStore.clear(key);
    this.clarifierStore.clear(key);
    this.answerTraceStore.clear(key);
  }

  private sweep(timestamp: Date): void {
    const timestampMs = timestamp.getTime();
    if (!Number.isFinite(timestampMs) || timestampMs < this.nextSweepAtMs) {
      return;
    }
    this.nextSweepAtMs = timestampMs + BASIC_CONTEXT_SWEEP_INTERVAL_MS;

    for (const [key, entries] of this.legacyEntries) {
      this.publishLegacy(key, entries
        .filter((entry) => timestampMs <= entry.expiresAtMs)
        .slice(0, BASIC_STORED_CONTEXT_FRAME_LIMIT));
    }
    this.focusStore.sweep(timestamp);
    this.clarifierStore.sweep(timestamp);
    this.answerTraceStore.sweep(timestamp);

    for (const [key, watermarkValue] of this.turnWatermarks) {
      const retentionMs = watermarkValue.phase === "begin"
        ? BASIC_CONTEXT_IN_FLIGHT_METADATA_RETENTION_MS
        : BASIC_CONTEXT_FINAL_METADATA_RETENTION_MS;
      if (timestampMs - watermarkValue.timestampMs > retentionMs) {
        this.turnWatermarks.delete(key);
      }
    }
    for (const [sessionNamespace, sessionKeys] of this.sessionPartitions) {
      if (this.turnWatermarks.has(sessionNamespace)) {
        continue;
      }
      for (const sessionKey of sessionKeys) {
        this.clearStorageKey(sessionKey);
      }
      this.sessionPartitions.delete(sessionNamespace);
      this.sessionSpeakerKeys.delete(sessionNamespace);
    }
    for (const sessionNamespace of this.sessionSpeakerKeys.keys()) {
      if (!this.sessionPartitions.has(sessionNamespace)) {
        this.sessionSpeakerKeys.delete(sessionNamespace);
      }
    }
  }

  private speakerKeysForClear(access: BasicContextStorageAccess): readonly string[] {
    const keys = new Set<string>();
    if (access.speakerKey) {
      keys.add(access.speakerKey);
    }
    if (access.sessionNamespace) {
      for (const speakerKey of this.sessionSpeakerKeys.get(access.sessionNamespace) ?? []) {
        keys.add(speakerKey);
      }
    }
    return [...keys];
  }

  private claimBegin(key: string, metadata: BasicContextCommitMetadata): boolean {
    const current = this.turnWatermarks.get(key);
    if (current && metadata.turnSequence <= current.turnSequence) {
      return false;
    }
    this.turnWatermarks.set(key, watermark(metadata, "begin"));
    return true;
  }

  private claimOrRetainBegin(key: string, metadata: BasicContextCommitMetadata): boolean {
    const current = this.turnWatermarks.get(key);
    if (sameTurnWatermark(current, metadata, "begin")) {
      return true;
    }
    return this.claimBegin(key, metadata);
  }

  private claimFinal(key: string, metadata: BasicContextCommitMetadata): boolean {
    const current = this.turnWatermarks.get(key);
    if (!sameTurnWatermark(current, metadata, "begin")) {
      return false;
    }
    this.turnWatermarks.set(key, watermark(metadata, "final"));
    return true;
  }

  private claimOrReplaceFinal(key: string, metadata: BasicContextCommitMetadata): boolean {
    const current = this.turnWatermarks.get(key);
    if (sameTurnWatermark(current, metadata, "final")) {
      return true;
    }
    if (sameTurnWatermark(current, metadata, "begin")) {
      this.turnWatermarks.set(key, watermark(metadata, "final"));
      return true;
    }
    return false;
  }
}

export function basicContextFramesForResult(result: BasicResult): readonly BasicContextFrame[] {
  const frames: BasicContextFrame[] = [];
  if (result.contextFrame) {
    frames.push(result.contextFrame);
  }
  for (const frame of result.additionalContextFrames ?? []) {
    frames.push(frame);
  }
  return frames;
}

export function adaptLegacyBasicResultContext(
  result: BasicResult,
  session: "continue" | "close",
): BasicCommittedResult {
  const legacyFrames = basicContextFramesForResult(result);
  const emissions = legacyFrames.map((frame, frameOrdinal) => Object.freeze({ frameOrdinal, frame }));
  const shouldClear = result.resetContext === true || session === "close";
  if (shouldClear) {
    return committedResult(result, {
      focus: { lifecycle: "clear", scope: "session_and_speaker" },
      clarifier: { lifecycle: "clear", scope: "session_and_speaker" },
      answerTrace: { lifecycle: "clear", scope: "session_and_speaker" },
    }, answerTraceFrom(result, emissions));
  }

  const admitted = result.status === "ok"
    || result.status === "declined"
    || (result.status === "clarify" && legacyFrames.some((frame) => frame.kind === "clarifier" || frame.kind === "answer_explanation"));
  if (!admitted) {
    return committedResult(result, preservedContextEffect(), null);
  }
  const clearsFailedStatusFocus = result.route === "entity_status" && result.status === "declined";
  if (emissions.length === 0) {
    return committedResult(result, {
      focus: clearsFailedStatusFocus
        ? { lifecycle: "clear", scope: "current", targetKind: "entity_status" }
        : { lifecycle: "preserve" },
      clarifier: result.preservePendingClarifier === true
        ? { lifecycle: "preserve" }
        : { lifecycle: "clear", scope: "current" },
      answerTrace: { lifecycle: "preserve" },
    }, null);
  }

  const focusFrames = emissions.filter((emission): emission is BasicContextEmission<BasicFocusContextFrame> => (
    emission.frame.kind !== "clarifier" && !isAnswerTraceFrame(emission.frame)
  ));
  const clarifierFrames = emissions.filter((emission): emission is BasicContextEmission<PendingClarifierFrame> => (
    emission.frame.kind === "clarifier"
  ));
  const traceFrames = emissions.filter((emission): emission is BasicContextEmission<BasicAnswerTraceFrame> => (
    isAnswerTraceFrame(emission.frame)
  ));
  const answerTrace = answerTraceFrom(result, traceFrames);
  const ownsNewAnswerTopic = traceFrames.some((emission) => emission.frame.kind !== "answer_explanation");
  const answerTopicEmission: BasicContextEmission<BasicFocusContextFrame> | null = focusFrames.length === 0 && ownsNewAnswerTopic
    ? Object.freeze({
        frameOrdinal: legacyFrames.length,
        frame: Object.freeze({ kind: "answer_topic", route: result.route }),
      })
    : null;
  const committedFocusFrames: readonly BasicContextEmission<BasicFocusContextFrame>[] = answerTopicEmission
    ? Object.freeze([answerTopicEmission])
    : focusFrames;
  const committedInput = answerTopicEmission
    ? {
        ...result,
        additionalContextFrames: [
          ...(result.additionalContextFrames ?? []),
          answerTopicEmission.frame,
        ],
      }
    : result;
  const modelConversationFocus = focusFrames.some(
    (emission) => emission.frame.kind === "model_conversation",
  );
  return committedResult(committedInput, {
    focus: committedFocusFrames.length > 0
      ? { lifecycle: "set", frames: Object.freeze(committedFocusFrames) }
      : clearsFailedStatusFocus
        ? { lifecycle: "clear", scope: "current", targetKind: "entity_status" }
        : { lifecycle: "preserve" },
    clarifier: clarifierFrames.length > 0
      ? { lifecycle: "set", frames: Object.freeze(clarifierFrames) }
      : { lifecycle: "clear", scope: "current" },
    answerTrace: answerTrace
      ? { lifecycle: "set" }
      : modelConversationFocus
        ? { lifecycle: "clear", scope: "current" }
      : { lifecycle: "preserve" },
  }, answerTrace);
}

export function basicContextEnvelopesForResult(
  request: VoiceBrainRequest,
  result: BasicCommittedResult,
  metadata: BasicContextCommitMetadata,
  storageScope: ContextStorageScope,
  emissions: readonly BasicContextEmission<BasicContextFrame>[] = explicitContextEmissionsForResult(result),
): readonly BasicContextEnvelope[] {
  const principal = resolveSpeakerPrincipal(request.speaker);
  return Object.freeze(emissions.map(({ frame: payload, frameOrdinal }) => {
    const classification = classifyBasicContextFrame(payload);
    const payloadProvenance = payloadProvenanceFor(classification.payloadProvenanceKind);
    return createContextEnvelope({
      envelopeId: `context-envelope:${metadata.turnId}:${metadata.turnSequence}:${frameOrdinal}:${storageScope}`,
      frameId: `context-frame:${metadata.turnId}:${metadata.turnSequence}:${frameOrdinal}`,
      domain: classification.domain,
      owner: classification.owner,
      source: {
        turnId: metadata.turnId,
        turnSequence: metadata.turnSequence,
        frameOrdinal,
        route: result.route,
        status: result.status,
        confidence: result.confidence,
        resultId: result.resultId,
        targetAcquisition: targetAcquisitionForPayload(result, payload),
        targetSourceQuery: targetSourceQueryForPayload(result, payload),
      },
      principal: {
        personId: principal.personId,
        label: principal.label,
        identitySource: principal.identitySource,
        trust: principal.trust,
      },
      transport: {
        channel: request.channel,
        sourceVia: request.sourceVia,
        room: request.room,
        sessionId: request.sessionId,
      },
      createdAtMs: metadata.timestamp.getTime(),
      expiresAtMs: metadata.timestamp.getTime() + BASIC_CONTEXT_TTL_MS,
      sensitivity: classification.sensitivity,
      storageScope,
      policyStatus: "legacy_unenforced",
      visibility: "internal_only",
      allowedUses: classification.allowedUses,
      payloadProvenance,
      payload,
    });
  }));
}

function explicitContextEmissionsForResult(
  result: BasicCommittedResult,
): readonly BasicContextEmission<BasicContextFrame>[] {
  rejectUnsupportedUpdate(result.contextEffect);
  validateSlotEffect(result.contextEffect.focus, "focus");
  validateSlotEffect(result.contextEffect.clarifier, "clarifier");
  const emissions: BasicContextEmission<BasicContextFrame>[] = [];
  if (result.contextEffect.focus.lifecycle === "set") {
    emissions.push(...result.contextEffect.focus.frames);
  }
  if (result.contextEffect.clarifier.lifecycle === "set") {
    emissions.push(...result.contextEffect.clarifier.frames);
  }
  if (result.contextEffect.answerTrace.lifecycle === "set") {
    if (!result.answerTrace || result.answerTrace.frames.length === 0) {
      throw new Error("answer-trace set requires explicit trace frames");
    }
    validateAnswerTrace(result);
    emissions.push(...result.answerTrace.frames);
  }
  const ordinals = new Set<number>();
  for (const emission of emissions) {
    if (!Number.isSafeInteger(emission.frameOrdinal) || emission.frameOrdinal < 0) {
      throw new Error("context frame ordinal must be a non-negative safe integer");
    }
    if (ordinals.has(emission.frameOrdinal)) {
      throw new Error("context frame ordinals must be unique per result");
    }
    ordinals.add(emission.frameOrdinal);
  }
  const ordered = emissions.sort((left, right) => left.frameOrdinal - right.frameOrdinal);
  if (ordered.length > 0) {
    const legacyFrames = basicContextFramesForResult(result);
    if (legacyFrames.length !== ordered.length
      || ordered.some((emission, index) => emission.frameOrdinal !== index || !samePlainValue(emission.frame, legacyFrames[index]))) {
      throw new Error("explicit context effects do not match the legacy frame projection");
    }
  }
  return Object.freeze(ordered);
}

function committedResult(
  result: BasicResult,
  contextEffect: BasicContextEffect,
  answerTrace: BasicAnswerTrace | null,
): BasicCommittedResult {
  return {
    ...result,
    contextEffect: Object.freeze({
      focus: freezeSlotEffect(contextEffect.focus),
      clarifier: freezeSlotEffect(contextEffect.clarifier),
      answerTrace: Object.freeze({ ...contextEffect.answerTrace }),
    }),
    answerTrace,
  };
}

function freezeSlotEffect<TFrame extends BasicContextFrame>(
  effect: BasicContextSlotEffect<TFrame>,
): BasicContextSlotEffect<TFrame> {
  if (effect.lifecycle === "set") {
    return Object.freeze({ ...effect, frames: Object.freeze([...effect.frames]) });
  }
  if (effect.lifecycle === "update") {
    return Object.freeze({ ...effect, frames: Object.freeze([...effect.frames]) });
  }
  return Object.freeze({ ...effect });
}

function answerTraceFrom(
  result: BasicResult,
  emissions: readonly BasicContextEmission<BasicContextFrame>[],
): BasicAnswerTrace | null {
  const frames = emissions.filter((emission): emission is BasicContextEmission<BasicAnswerTraceFrame> => (
    isAnswerTraceFrame(emission.frame)
  ));
  if (frames.length === 0) {
    return null;
  }
  const explanationFrame = frames.find((emission): emission is BasicContextEmission<Extract<BasicContextFrame, { kind: "answer_explanation" }>> => (
    emission.frame.kind === "answer_explanation"
  ));
  return Object.freeze({
    frames: Object.freeze([...frames]),
    responseText: result.text,
    explanation: explanationFrame?.frame.explanation ?? null,
  });
}

function preservedContextEffect(): BasicContextEffect {
  return Object.freeze({
    focus: Object.freeze({ lifecycle: "preserve" as const }),
    clarifier: Object.freeze({ lifecycle: "preserve" as const }),
    answerTrace: Object.freeze({ lifecycle: "preserve" as const }),
  });
}

function isAnswerTraceFrame(frame: BasicContextFrame): frame is BasicAnswerTraceFrame {
  return frame.kind === "answer_explanation"
    || frame.kind === "house_summary"
    || frame.kind === "event_log"
    || frame.kind === "historical_presence"
    || frame.kind === "wikipedia_abstract";
}

function rejectUnsupportedUpdate(effect: BasicContextEffect): void {
  const updates = [effect.focus, effect.clarifier, effect.answerTrace]
    .filter((candidate) => candidate.lifecycle === "update");
  for (const update of updates) {
    if (!("basedOnFrameId" in update) || !update.basedOnFrameId.trim()) {
      throw new Error("context update requires a source frameId");
    }
  }
  if (updates.length > 0) {
    throw new Error("context update is not enabled before owner-store migration");
  }
}

function validateSlotEffect<TFrame extends BasicContextFrame>(
  effect: BasicContextSlotEffect<TFrame>,
  expectedOwner: "focus" | "clarifier",
): void {
  if (effect.lifecycle !== "set") {
    return;
  }
  if (effect.frames.length === 0) {
    throw new Error(`${expectedOwner} context set requires at least one frame`);
  }
  if (effect.frames.some((emission) => ownerForFrame(emission.frame) !== expectedOwner)) {
    throw new Error(`${expectedOwner} context set contains a frame owned by another store`);
  }
}

function validateAnswerTrace(result: BasicCommittedResult): void {
  const trace = result.answerTrace;
  if (!trace) {
    throw new Error("answer-trace effect requires trace data");
  }
  if (trace.frames.some((emission) => ownerForFrame(emission.frame) !== "answer_trace")) {
    throw new Error("answer trace contains a frame owned by another store");
  }
  const explanations = trace.frames.filter((emission): emission is BasicContextEmission<Extract<BasicContextFrame, { kind: "answer_explanation" }>> => (
    emission.frame.kind === "answer_explanation"
  ));
  if (explanations.length > 1) {
    throw new Error("answer trace cannot contain multiple explanation authorities");
  }
  const frameExplanation = explanations[0]?.frame.explanation ?? null;
  if (!samePlainValue(trace.explanation, frameExplanation)) {
    throw new Error("answer trace explanation does not match its explanation frame");
  }
  if (trace.responseText !== result.text) {
    throw new Error("answer trace response text does not match the committed result");
  }
}

function hasSessionAndSpeakerClear(effect: BasicContextEffect): boolean {
  const effects = [effect.focus, effect.clarifier, effect.answerTrace];
  const wideClears = effects.filter((candidate) => (
    candidate.lifecycle === "clear" && candidate.scope === "session_and_speaker"
  ));
  if (wideClears.length > 0 && wideClears.length !== effects.length) {
    throw new Error("session-and-speaker clear must cover every context owner");
  }
  return wideClears.length === effects.length;
}

function shouldRetainExistingEnvelope(
  envelope: BasicContextEnvelope,
  effect: BasicContextEffect,
): boolean {
  switch (envelope.owner) {
    case "focus":
      return effect.focus.lifecycle !== "clear"
        || (effect.focus.targetKind !== undefined && envelope.payload.kind !== effect.focus.targetKind);
    case "clarifier":
      return effect.clarifier.lifecycle === "preserve";
    case "answer_trace":
      return effect.answerTrace.lifecycle !== "clear";
    default:
      return assertNever(envelope.owner);
  }
}

function storageKey(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function addIndexedValue(index: Map<string, Set<string>>, key: string, value: string): void {
  const values = index.get(key) ?? new Set<string>();
  values.add(value);
  index.set(key, values);
}

function watermark(
  metadata: BasicContextCommitMetadata,
  phase: BasicContextTurnWatermark["phase"],
): BasicContextTurnWatermark {
  return Object.freeze({
    turnId: metadata.turnId,
    turnSequence: metadata.turnSequence,
    phase,
    timestampMs: metadata.timestamp.getTime(),
  });
}

function sameTurnWatermark(
  watermarkValue: BasicContextTurnWatermark | undefined,
  metadata: BasicContextCommitMetadata,
  phase: BasicContextTurnWatermark["phase"],
): boolean {
  return watermarkValue?.turnId === metadata.turnId
    && watermarkValue.turnSequence === metadata.turnSequence
    && watermarkValue.phase === phase;
}

function samePlainValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isFocusEnvelope(entry: BasicContextEnvelope): entry is BasicFocusContextEnvelope {
  return ownerForFrame(entry.payload) === "focus";
}

function isClarifierEnvelope(entry: BasicContextEnvelope): entry is BasicClarifierContextEnvelope {
  return entry.payload.kind === "clarifier";
}

function isAnswerTraceEnvelope(entry: BasicContextEnvelope): entry is BasicAnswerTraceContextEnvelope {
  return isAnswerTraceFrame(entry.payload);
}

function isEntityStatusEnvelope(
  entry: BasicFocusContextEnvelope,
): entry is BasicEntityStatusContextEnvelope {
  return entry.payload.kind === "entity_status" && entry.domain === "entity_status";
}

function domainContextView<TFrame extends BasicFocusContextFrame>(
  activeCandidate: BasicFocusContextEnvelope | null,
  historyCandidates: readonly BasicFocusContextEnvelope[],
  accepts: (entry: BasicFocusContextEnvelope) => entry is ContextEnvelope<TFrame>,
): BasicDomainContextView<TFrame> {
  const history = historyCandidates.filter(accepts);
  return Object.freeze({
    active: activeCandidate && accepts(activeCandidate) ? activeCandidate : null,
    recent: history[0] ?? null,
    history: Object.freeze(history),
  });
}

function isMetricsEnvelope(
  entry: BasicFocusContextEnvelope,
): entry is ContextEnvelope<BasicMetricsContextFrame> {
  return entry.domain === "metrics" && (
    entry.payload.kind === "energy_budget"
    || entry.payload.kind === "current_power_ranking"
    || entry.payload.kind === "current_metric"
    || entry.payload.kind === "history_metric"
    || entry.payload.kind === "comparison_metric"
  );
}

function isWeatherEnvelope(
  entry: BasicFocusContextEnvelope,
): entry is ContextEnvelope<BasicWeatherContextFrame> {
  return entry.domain === "weather" && entry.payload.kind === "weather";
}

function isCalendarEnvelope(
  entry: BasicFocusContextEnvelope,
): entry is ContextEnvelope<BasicCalendarContextFrame> {
  return entry.domain === "calendar" && entry.payload.kind === "calendar";
}

function isHouseLightsEnvelope(
  entry: BasicFocusContextEnvelope,
): entry is ContextEnvelope<BasicHouseLightsContextFrame> {
  return entry.domain === "house_lights" && entry.payload.kind === "house_lights";
}

function isCalculationEnvelope(
  entry: BasicFocusContextEnvelope,
): entry is ContextEnvelope<BasicCalculationContextFrame> {
  return entry.domain === "calculation" && entry.payload.kind === "calculation";
}

function isMusicEnvelope(
  entry: BasicFocusContextEnvelope,
): entry is ContextEnvelope<BasicMusicContextFrame> {
  return entry.domain === "music" && entry.payload.kind === "music_playback";
}

function actionContextReference(
  entry: BasicFocusContextEnvelope | null,
  request: VoiceBrainRequest,
  previousSessionTurnSequence: number | null,
): BasicActionContextReference | null {
  if (!entry
    || !isEntityStatusEnvelope(entry)
    || !request.sessionId
    || previousSessionTurnSequence === null
    || entry.source.turnSequence !== previousSessionTurnSequence
    || entry.source.status !== "ok"
    // A confirmed office-lights switch keeps them the adjacent subject.
    || (entry.source.route !== "entity_status" && entry.source.route !== "entity_action")
    || entry.source.confidence !== "high"
    || (entry.source.targetAcquisition !== "explicit" && entry.source.targetAcquisition !== "clarified")
    || !["alias", "entity_id", "exact_name", "area_domain"].includes(entry.payload.target.source)
    || entry.payload.target.entityIds.length !== 1
    || entry.storageScope !== "session"
    || entry.transport.sessionId !== request.sessionId
    || entry.transport.channel !== request.channel
    || entry.transport.sourceVia !== request.sourceVia
    || entry.payloadProvenance.kind !== "reference"
    || entry.payloadProvenance.revalidateBeforeUse !== true) {
    return null;
  }
  const principal = resolveSpeakerPrincipal(request.speaker);
  const carryPersonId = contextCarryPersonId(principal);
  const sourceCarryPersonId = contextCarryPersonId({
    token: null,
    ...entry.principal,
  });
  if (!carryPersonId || sourceCarryPersonId !== carryPersonId) {
    return null;
  }
  return Object.freeze({
    sourceFrameId: entry.frameId,
    sourceTurnSequence: entry.source.turnSequence,
    sessionId: request.sessionId,
    target: entry.payload.target,
    targetAcquisition: entry.source.targetAcquisition,
    sourceQuery: entry.source.targetSourceQuery,
    revalidateBeforeUse: true,
  });
}

function targetAcquisitionForPayload(
  result: BasicCommittedResult,
  payload: BasicContextFrame,
): EntityStatusTargetAcquisition | null {
  if (payload.kind !== "entity_status") {
    return null;
  }
  if (!result.entityStatusTargetAcquisition) {
    throw new Error("entity-status context requires target acquisition provenance");
  }
  return result.entityStatusTargetAcquisition;
}

function targetSourceQueryForPayload(
  result: BasicCommittedResult,
  payload: BasicContextFrame,
): string | null {
  if (payload.kind !== "entity_status") {
    return null;
  }
  if (result.entityStatusTargetAcquisition !== "explicit") {
    if (result.entityStatusActionSourceQuery !== undefined) {
      throw new Error("non-explicit status context cannot carry an action source query");
    }
    return null;
  }
  const sourceQuery = result.entityStatusActionSourceQuery?.trim() ?? "";
  if (!sourceQuery) {
    throw new Error("explicit entity-status context requires an action source query");
  }
  return sourceQuery;
}

function classifyBasicContextFrame(frame: BasicContextFrame): BasicContextClassification {
  const domain = domainForFrame(frame);
  const owner = ownerForFrame(frame);
  return {
    domain,
    owner,
    sensitivity: sensitivityForFrame(frame, domain),
    allowedUses: allowedUsesForOwner(owner),
    payloadProvenanceKind: payloadProvenanceKindForFrame(frame),
  };
}

function ownerForFrame(frame: BasicContextFrame): ContextOwner {
  switch (frame.kind) {
    case "clarifier":
      return "clarifier";
    case "answer_explanation":
    case "house_summary":
    case "event_log":
    case "historical_presence":
    case "wikipedia_abstract":
      return "answer_trace";
    case "answer_topic":
    case "calculation":
    case "entity_status":
    case "weather":
    case "model_conversation":
    case "outdoor_clothing_memory":
    case "house_lights":
    case "energy_budget":
    case "calendar":
    case "music_playback":
    case "current_power_ranking":
    case "current_metric":
    case "history_metric":
    case "comparison_metric":
      return "focus";
    default:
      return assertNever(frame);
  }
}

function allowedUsesForOwner(owner: ContextOwner): readonly ContextAllowedUse[] {
  switch (owner) {
    case "focus":
      return ["read_followup", "refocus"];
    case "clarifier":
      return ["clarifier_reply"];
    case "answer_trace":
      return ["repeat", "explain"];
    default:
      return assertNever(owner);
  }
}

function domainForFrame(frame: BasicContextFrame): ContextDomain {
  switch (frame.kind) {
    case "clarifier":
      return domainForRoute(frame.route);
    case "answer_explanation":
      return domainForRoute(frame.explanation.route);
    case "answer_topic":
      return domainForRoute(frame.route);
    case "house_summary":
      return "house_summary";
    case "event_log":
      return "event_log";
    case "historical_presence":
      return "personal_memory";
    case "calculation":
      return "calculation";
    case "entity_status":
      return "entity_status";
    case "weather":
      return "weather";
    case "model_conversation":
      return "dialogue";
    case "outdoor_clothing_memory":
      return "personal_memory";
    case "house_lights":
      return "house_lights";
    case "energy_budget":
    case "current_power_ranking":
    case "current_metric":
    case "history_metric":
    case "comparison_metric":
      return "metrics";
    case "calendar":
      return "calendar";
    case "wikipedia_abstract":
      return "knowledge";
    case "music_playback":
      return "music";
    default:
      return assertNever(frame);
  }
}

function domainForRoute(route: BasicRoute): ContextDomain {
  switch (route) {
    case "current_time":
    case "system_health":
      return "system";
    case "entity_status":
      return "entity_status";
    case "entity_action":
      return "action";
    case "house_status":
      return "house_lights";
    case "house_summary":
      return "house_summary";
    case "event_log":
      return "event_log";
    case "calculation":
      return "calculation";
    case "time_window_math":
    case "energy_budget":
      return "metrics";
    case "memory_query":
      return "personal_memory";
    case "agentic_read":
      // Agent answers may combine household, calendar, todo, media, and other
      // owner-only evidence. Treat the whole answer trace as personal rather
      // than attempting to infer sensitivity from a partial entity-id list.
      return "personal_memory";
    case "calendar_query":
      return "calendar";
    case "music_playback":
      return "music";
    case "alarm_clock":
      return "alarm";
    case "deferred_watch":
      return "deferred_watch";
    case "weather_query":
      return "weather";
    case "general_knowledge":
      return "knowledge";
    case "open_conversation":
      return "dialogue";
    default:
      return assertNever(route);
  }
}

function sensitivityForFrame(
  frame: BasicContextFrame,
  domain: ContextDomain,
): ContextSensitivity {
  if (hasPersonalEntityReference(frame) || domain === "personal_memory" || domain === "calendar") {
    return "personal";
  }
  if (domain === "calculation" || domain === "knowledge" || domain === "dialogue" || domain === "system") {
    return "public";
  }
  if (frame.kind === "answer_explanation"
    || frame.kind === "clarifier"
    || domain === "entity_status"
    || domain === "house_summary"
    || domain === "event_log") {
    return "unknown";
  }
  return "household";
}

function hasPersonalEntityReference(frame: BasicContextFrame): boolean {
  return entityIdsForFrame(frame).some((entityId) => /^(?:device_tracker|geo_location|person|proximity|zone)\./iu.test(entityId));
}

function entityIdsForFrame(frame: BasicContextFrame): readonly string[] {
  switch (frame.kind) {
    case "clarifier":
      return frame.choices.flatMap((choice) => (
        choice.action.kind === "entity_status" || choice.action.kind === "calendar_event"
          ? choice.action.entityIds
          : []
      ));
    case "answer_explanation":
      return frame.explanation.sourceEntityIds;
    case "house_summary":
    case "event_log":
    case "historical_presence":
      return frame.sourceEntityIds;
    case "entity_status":
      return frame.target.entityIds;
    case "calendar":
      return frame.entityIds;
    case "answer_topic":
    case "calculation":
    case "weather":
    case "model_conversation":
    case "outdoor_clothing_memory":
    case "house_lights":
    case "energy_budget":
    case "wikipedia_abstract":
    case "music_playback":
    case "current_power_ranking":
    case "current_metric":
    case "history_metric":
    case "comparison_metric":
      return [];
    default:
      return assertNever(frame);
  }
}

function payloadProvenanceKindForFrame(frame: BasicContextFrame): ContextPayloadProvenance["kind"] {
  switch (frame.kind) {
    case "clarifier":
      return frame.choices.length > 0 ? "reference" : "snapshot";
    case "answer_explanation":
    case "house_summary":
    case "event_log":
    case "historical_presence":
    case "answer_topic":
    case "calculation":
    case "house_lights":
    case "model_conversation":
    case "wikipedia_abstract":
    case "music_playback":
      return "snapshot";
    case "entity_status":
    case "weather":
    case "outdoor_clothing_memory":
    case "energy_budget":
    case "calendar":
    case "current_power_ranking":
    case "current_metric":
    case "history_metric":
    case "comparison_metric":
      return "reference";
    default:
      return assertNever(frame);
  }
}

function payloadProvenanceFor(
  kind: ContextPayloadProvenance["kind"],
): ContextPayloadProvenance {
  const source = {
    confidence: "legacy_unverified" as const,
    observedAtMs: null,
    revision: null,
  };
  return kind === "snapshot"
    ? { kind, source }
    : { kind, source, revalidateBeforeUse: true };
}

function assertNever(value: never): never {
  throw new Error(`unexpected context contract value: ${JSON.stringify(value)}`);
}
