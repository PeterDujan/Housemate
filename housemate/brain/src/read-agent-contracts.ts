import type { BasicRoute } from "./basic-brain-contracts.js";
import type { TimeWindow } from "./time-window-parser.js";

export type ReadAgentFallbackReason =
  | "current_source_unresolved"
  | "historical_state_required"
  | "cross_source_read_required"
  | "read_source_unavailable";

export interface ReadAgentEligibleFallbackDisposition {
  readonly eligible: true;
  readonly reason: ReadAgentFallbackReason;
  /**
   * Owner-only historical-presence scope granted by the deterministic memory
   * privacy pipeline. Null/absent means the agent has no person-history tool.
   */
  readonly ownPresenceWindow?: {
    readonly start: string;
    readonly end: string;
  };
  /**
   * Privacy-approved Home Assistant person entity resolved by deterministic
   * code for the same actor/window grant. Never model-selected.
   */
  readonly ownPresencePersonEntityId?: string;
  /**
   * Private deterministic guard for the memory snapshot that authorised the
   * owner-presence lane. This is rechecked after model work and is never sent
   * to the model or tool session.
   */
  readonly memoryGuard?: {
    readonly actorId: string;
    readonly window: TimeWindow;
    readonly memorySnapshotToken: string;
  };
}

/**
 * A deterministic resolver can close the read-agent lane. With only an
 * unresolved reference the agent has no grounded subject to investigate; with
 * a source-final miss (a known place with no such sensor) it would only search
 * again for what the registry already says is not there.
 */
export interface ReadAgentTerminalFallbackDisposition {
  readonly eligible: false;
  readonly reason: "context_reference_unresolved" | "source_final";
}

export type ReadAgentFallbackDisposition =
  | ReadAgentEligibleFallbackDisposition
  | ReadAgentTerminalFallbackDisposition;

export type ReadAgentToolName =
  | "search_entities"
  | "get_states"
  | "get_history"
  | "get_my_presence_history"
  | "get_statistics"
  | "get_calendar"
  | "get_todos"
  | "get_weather"
  | "search_media"
  | "get_recent_events";

/**
 * One deliberately uniform call shape keeps every model backend on the same
 * strict JSON schema. Tool handlers reject fields that are invalid for the
 * selected tool instead of passing arbitrary arguments to Home Assistant.
 */
export interface ReadAgentToolCall {
  readonly call_id: string;
  readonly name: ReadAgentToolName;
  readonly query: string | null;
  readonly entity_ids: readonly string[];
  readonly start: string | null;
  readonly end: string | null;
  readonly limit: number;
  readonly domain: string | null;
  readonly area: string | null;
  readonly mode: "none" | "hourly" | "daily" | "find" | "list" | "recommend";
  readonly period: "none" | "5minute" | "hour" | "day" | "week" | "month";
  readonly types: readonly ("mean" | "min" | "max" | "state" | "sum")[];
  readonly statuses: readonly string[];
  readonly media_kind: "any" | "movie" | "show";
  readonly media_filter: "none" | "recent" | "unwatched";
}

export type ReadAgentClauseKind = "fact" | "inference" | "limitation";
export type ReadAgentInferenceKind =
  | "none"
  | "presence_location_estimate"
  | "numeric_pattern"
  | "weather_outlook"
  | "planned_not_observed"
  | "media_match"
  | "event_pattern"
  | "cross_source_likelihood";

export interface ReadAgentClause {
  readonly kind: ReadAgentClauseKind;
  readonly evidence_ids: readonly string[];
  readonly fact_ids: readonly string[];
  /** Closed code-rendered inference template; "none" for facts/limitations. */
  readonly inference_kind: ReadAgentInferenceKind;
}

export interface ReadAgentModelStep {
  readonly decision: "tool_calls" | "answer" | "decline";
  readonly tool_calls: readonly ReadAgentToolCall[];
  readonly clauses: readonly ReadAgentClause[];
  readonly confidence: "low" | "medium" | "high";
}

export type ReadAgentEvidenceStatus = "ok" | "empty" | "unavailable" | "error";
export type ReadAgentPrivacyClass = "household" | "personal";

export interface ReadAgentStateFingerprint {
  readonly entityId: string;
  readonly state: string;
  readonly lastUpdated: string;
  readonly volatileMeasurement: boolean;
}

export interface ReadAgentEvidenceFact {
  readonly factId: string;
  readonly kind:
    | "entity_match"
    | "state_observation"
    | "history_state"
    | "history_measurement"
    | "statistic_sample"
    | "calendar_event"
    | "todo_item"
    | "weather_forecast"
    | "media_item"
    | "recent_event"
    | "empty_result";
  /** Complete, code-rendered and source-attributed sentence. */
  readonly text: string;
}

export interface ReadAgentEvidence {
  readonly evidenceId: string;
  readonly callId: string;
  readonly tool: ReadAgentToolName;
  readonly status: ReadAgentEvidenceStatus;
  readonly source: string;
  readonly observedAt: string;
  readonly privacy: ReadAgentPrivacyClass;
  readonly entityIds: readonly string[];
  readonly sourceLabels: readonly string[];
  readonly cached: boolean;
  readonly truncated: boolean;
  readonly stateRevision: number | null;
  readonly registryRevision: number | null;
  /** Generation of the passive event view; null for evidence from other tools. */
  readonly watcherRevision: number | null;
  readonly stateFingerprints: readonly ReadAgentStateFingerprint[];
  /** Facts rendered by trusted tool code; the model may select but not rewrite them. */
  readonly facts: readonly ReadAgentEvidenceFact[];
  readonly payload: Readonly<Record<string, unknown>>;
  readonly errorCode: string | null;
}

export interface ReadAgentPrincipal {
  readonly actorId: string;
  readonly label: string;
}

/**
 * Trusted final-rendering policy selected by deterministic routing code.
 * This is deliberately absent from model requests: the model can select
 * supported facts, but it cannot suppress or rewrite a memory-miss admission.
 */
export type ReadAgentFinalFraming =
  | {
      readonly kind: "generic_read";
    }
  | {
      readonly kind: "deterministic_lead";
      /** Trusted deterministic miss text; never projected into model input. */
      readonly text: string;
    };

export interface ReadAgentRecoveryRequest {
  readonly turnId: string;
  readonly transcript: string;
  readonly fallbackRoute: BasicRoute;
  readonly fallbackReason: ReadAgentFallbackReason;
  readonly finalFraming: ReadAgentFinalFraming;
  readonly principal: ReadAgentPrincipal;
  readonly requestedAt: string;
  readonly ownPresenceWindow: {
    readonly start: string;
    readonly end: string;
  } | null;
  /** Code-derived HA person binding paired with ownPresenceWindow. */
  readonly ownPresencePersonEntityId: string | null;
  readonly canonicalTimeWindow: {
    readonly start: string;
    readonly end: string;
    readonly timezone: string;
    readonly label: string;
  } | null;
  /** Prior agent-read user questions only; answers and observations never carry over. */
  readonly contextQuestions: readonly string[];
  /**
   * Streamed turns: speaks the code-owned holding line. Called once, just
   * before the first planning call, and only when a model can be called.
   */
  readonly beforePlanning?: () => void;
}

export interface ReadAgentRecoveryResult {
  readonly status: "answered" | "declined";
  readonly text: string;
  readonly confidence: "low" | "medium" | "high";
  readonly evidence: readonly ReadAgentEvidence[];
  readonly modelUsed: boolean;
  readonly notes: string;
}

export interface ReadAgentProvider {
  recover(request: ReadAgentRecoveryRequest): Promise<ReadAgentRecoveryResult | null>;
}

export interface ReadAgentModelRequest {
  readonly turnId: string;
  readonly transcript: string;
  readonly requestedAt: string;
  readonly fallbackRoute: BasicRoute;
  readonly fallbackReason: ReadAgentFallbackReason;
  readonly ownPresenceWindow: {
    readonly start: string;
    readonly end: string;
  } | null;
  readonly canonicalTimeWindow: {
    readonly start: string;
    readonly end: string;
    readonly timezone: string;
    readonly label: string;
  } | null;
  readonly contextQuestions: readonly string[];
  readonly round: number;
  readonly maxRounds: number;
  readonly remainingToolCalls: number;
  readonly evidence: readonly ReadAgentEvidence[];
}

export interface ReadAgentVerificationRequest {
  readonly turnId: string;
  readonly transcript: string;
  readonly clauses: readonly ReadAgentClause[];
  readonly evidence: readonly ReadAgentEvidence[];
}

/** A bare verdict: nothing reads a reason, and free text only cost tokens. */
export interface ReadAgentVerification {
  readonly verdict: "supported" | "unsupported";
}

export interface ReadAgentModelCallOptions {
  readonly signal?: AbortSignal;
}

export interface ReadAgentModelProvider {
  /** Why no model call can run now (disabled, no auth, budget), or null. */
  unavailableReason?(): string | null;
  next(
    request: ReadAgentModelRequest,
    options?: ReadAgentModelCallOptions,
  ): Promise<ReadAgentModelStep>;
  verify(
    request: ReadAgentVerificationRequest,
    options?: ReadAgentModelCallOptions,
  ): Promise<ReadAgentVerification>;
}
