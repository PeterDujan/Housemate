import type { BasicSpeechRenderPlan } from "./basic-speech-response.js";
import type { MusicAssistantTrack } from "./ha-music-assistant.js";
import type {
  ReadAgentEligibleFallbackDisposition,
  ReadAgentEvidence,
  ReadAgentFallbackDisposition,
  ReadAgentFallbackReason,
} from "./read-agent-contracts.js";
import type { SpeechTone } from "./speech-tone.js";
import type { TimeWindow } from "./time-window-parser.js";

export type BasicRoute =
  | "current_time"
  | "entity_status"
  | "entity_action"
  | "house_status"
  | "house_summary"
  | "event_log"
  | "calculation"
  | "time_window_math"
  | "memory_query"
  | "calendar_query"
  | "energy_budget"
  | "music_playback"
  | "alarm_clock"
  | "deferred_watch"
  | "weather_query"
  | "system_health"
  | "general_knowledge"
  | "agentic_read"
  | "open_conversation";

export type BasicStatus = "ok" | "clarify" | "declined" | "error";
export type BasicConfidence = "low" | "medium" | "high";

export interface BasicAgentReadContext {
  /** Residual non-temporal proposition selected by software, never model text. */
  readonly proposition: string;
  /** Full software-resolved window used to derive a fresh grant on follow-up. */
  readonly canonicalTimeWindow: TimeWindow | null;
}

export interface BasicConversationTurn {
  /** Exact source turn used to prove that a deictic follow-up still targets the latest reply. */
  readonly turnId?: string;
  readonly speakerName: string | null;
  readonly transcript: string;
  readonly responseText: string;
  readonly timestampMs: number;
  readonly route?: BasicRoute;
  readonly status?: BasicStatus;
  readonly modelUsed?: boolean;
  readonly modelContextAllowed?: boolean;
  /** Private typed read-follow-up state; excluded from every model projection. */
  readonly agentReadContext?: BasicAgentReadContext;
}

export interface BasicResult {
  readonly route: BasicRoute;
  readonly status: BasicStatus;
  readonly confidence: BasicConfidence;
  readonly text: string;
  readonly speechPlan?: BasicSpeechRenderPlan | null;
  /** Code-picked spoken tone; absent means the final builder judges it (see speech-tone.ts). */
  readonly tone?: SpeechTone;
  readonly modelUsed: boolean;
  readonly resultId: string | null;
  readonly touchedEntities: readonly string[];
  readonly notes: string;
  readonly modelContextAllowed?: boolean;
  /** Typed read-agent disposition; only eligible=true opens the bounded lane. */
  readonly readFallback?: ReadAgentFallbackDisposition;
  /** Private provenance retained for explanation/audit, never conversation text. */
  readonly readEvidence?: readonly ReadAgentEvidence[];
  /** Private typed read-follow-up state; excluded from rendered/model context. */
  readonly agentReadContext?: BasicAgentReadContext;
  readonly contextFrame?: BasicContextFrame | null;
  readonly additionalContextFrames?: readonly BasicContextFrame[];
  readonly sessionDirective?: "continue" | "close";
  /** Done without words: the speaker beeps and the session ends. */
  readonly confirmBeep?: true;
  /** The voice host paused the music for this request: "hold" leaves it as the command left it (pause, stop, a new song). */
  readonly musicAfter?: "hold";
  /**
   * The answer would tell a voice the assistant does not trust about the household. It is never spoken: the
   * turn goes on in open chat, which has nothing private for that voice. nobody
   * needs to hear "guest mode"; a family member not yet recognised just gets a conversation.
   */
  readonly withheld?: true;
  readonly resetContext?: boolean;
  /** Rare meta-turns such as "why?" may inspect a pending clarifier without consuming it. */
  readonly preservePendingClarifier?: true;
  /** Provenance for an emitted entity-status target; never projected into the legacy payload. */
  readonly entityStatusTargetAcquisition?: EntityStatusTargetAcquisition;
  /** Exact source query whose unique live resolution authorized adjacent deictic action context. */
  readonly entityStatusActionSourceQuery?: string;
  /** Stored tastes a code taste answer spoke; read only by taste evidence after the reply. */
  readonly selfTastePreferenceIds?: readonly string[];
}
export type BasicContextClearScope = "current" | "session_and_speaker";

export interface BasicContextEmission<TFrame extends BasicContextFrame> {
  /** Position in the producer's legacy frame list, retained for parity and provenance. */
  readonly frameOrdinal: number;
  readonly frame: TFrame;
}

export type BasicContextSlotEffect<TFrame extends BasicContextFrame> =
  | {
      readonly lifecycle: "set";
      readonly frames: readonly BasicContextEmission<TFrame>[];
    }
  | {
      readonly lifecycle: "update";
      /** Updates must name the immutable frame they consumed. */
      readonly basedOnFrameId: string;
      readonly frames: readonly BasicContextEmission<TFrame>[];
    }
  | { readonly lifecycle: "preserve" }
  | {
      readonly lifecycle: "clear";
      readonly scope: BasicContextClearScope;
      /** A current-scope focus tombstone may remove one payload kind without erasing other domains. */
      readonly targetKind?: TFrame["kind"];
    };

export type BasicAnswerTraceEffect =
  | { readonly lifecycle: "set" }
  | { readonly lifecycle: "update"; readonly basedOnFrameId: string }
  | { readonly lifecycle: "preserve" }
  | { readonly lifecycle: "clear"; readonly scope: BasicContextClearScope };

export interface BasicContextEffect {
  readonly focus: BasicContextSlotEffect<BasicFocusContextFrame>;
  readonly clarifier: BasicContextSlotEffect<PendingClarifierFrame>;
  readonly answerTrace: BasicAnswerTraceEffect;
}

export interface BasicAnswerTrace {
  readonly frames: readonly BasicContextEmission<BasicAnswerTraceFrame>[];
  readonly responseText: string;
  readonly explanation: BasicAnswerExplanation | null;
}

/**
 * The only result shape accepted by the context commit boundary. Route
 * producers remain on BasicResult until their context effects are migrated.
 */
export interface BasicCommittedResult extends BasicResult {
  readonly contextEffect: BasicContextEffect;
  readonly answerTrace: BasicAnswerTrace | null;
}

export interface BasicAnswerExplanation {
  readonly route: BasicRoute;
  readonly confidence: BasicConfidence;
  readonly reason: string;
  readonly sourceSummary: string;
  readonly sourceLabels: readonly string[];
  readonly sourceEntityIds: readonly string[];
  readonly actionBoundary: string;
  readonly targetLabel?: string | null;
}

export type ClarifierTargetSource = "alias" | "entity_id" | "exact_name" | "area_domain";
export type ClarifierQuestionType = "yes_no" | "state_value";

export interface PendingClarifierChoice {
  readonly id: string;
  readonly label: string;
  readonly synonyms: readonly string[];
  readonly action:
    | {
      readonly kind: "entity_status";
      readonly targetLabel: string;
      readonly entityIds: readonly string[];
      readonly source: ClarifierTargetSource;
      readonly requestedState: string | null;
      readonly questionType: ClarifierQuestionType;
      /** Preserve an entity-ID question across a deterministic choice reply. */
      readonly responseKind?: "status" | "entity_identity";
    }
    | {
      readonly kind: "calendar_event";
      readonly eventSummary: string;
      readonly eventStart: string;
      readonly eventEnd: string;
      readonly entityIds: readonly string[];
      readonly window: TimeWindow;
    }
    | {
      readonly kind: "metric_current";
      readonly metricId: string;
    }
    | {
      /** Public local-index title selected from a deterministic media-family ambiguity. */
      readonly kind: "wikipedia_media";
      readonly title: string;
    };
}

export type PendingClarifierFreeform =
  | {
      readonly kind: "missing_context" | "follow_up_target";
      readonly targetHint?: string | null;
    }
  | {
      /** A large identity ambiguity that may only be completed by one exact candidate ID. */
      readonly kind: "entity_identity_exact_id";
      readonly targetHint: string;
      readonly entityIds: readonly string[];
    };

export interface PendingClarifierFrame {
  readonly kind: "clarifier";
  readonly route: "entity_status" | "calendar_query" | "time_window_math" | "general_knowledge" | "open_conversation";
  readonly prompt: string;
  readonly choices: readonly PendingClarifierChoice[];
  readonly freeform?: PendingClarifierFreeform | null;
}

export type HouseSummaryScope = "today" | "tonight";
export type EventLogScope = "recent" | "today" | "tonight" | "while_i_was_out" | "since_last_spoke";

export interface DynamicMetricContextData {
  readonly sourceKind: "current_power" | "history_energy";
  readonly targetPhrases: readonly string[];
  readonly subjectLabel: string;
}

export interface ComparisonWindowPair {
  readonly left: TimeWindow;
  readonly right: TimeWindow;
}

export interface MusicPlaybackRequest {
  readonly title: string;
  readonly artist: string | null;
  readonly targetText: string | null;
}

export interface ResolvedTarget {
  readonly label: string;
  readonly entityIds: readonly string[];
  readonly source: "alias" | "entity_id" | "exact_name" | "area_domain" | "state_hint" | "inferred";
}

export type EntityStatusTargetAcquisition = "explicit" | "clarified" | "contextual" | "inferred";

export type CurrentStatusQuestionType = "yes_no" | "state_value";

export interface CurrentStatusPlan {
  readonly intent: "current_status";
  readonly targetText: string | null;
  readonly requestedState: string | null;
  readonly questionType: CurrentStatusQuestionType;
  readonly source: "aliases_or_live_state";
  readonly quantifier?: "any" | "all" | "which" | null;
  readonly numericComparison?: {
    readonly operator: "less_than" | "greater_than";
    readonly threshold: number;
    readonly unit: string | null;
  } | null;
  readonly requestedAttribute?: "temperature" | null;
  readonly compareGroupUniformity?: boolean;
}

export type WikipediaMatchKind = "exact_title" | "redirect" | "qualified_title" | "fts";

export type BasicContextFrame =
  | PendingClarifierFrame
  | { readonly kind: "answer_explanation"; readonly explanation: BasicAnswerExplanation }
  /**
   * A sourced answer that owns the current topic but has no domain payload in
   * the focus store. Detailed evidence remains in the answer-trace store; this
   * marker stops an older domain becoming active after a trace-only answer.
   */
  | { readonly kind: "answer_topic"; readonly route: BasicRoute }
  | { readonly kind: "house_summary"; readonly scope: HouseSummaryScope; readonly sourceEntityIds: readonly string[]; readonly sourceSummary: string }
  | { readonly kind: "event_log"; readonly scope: EventLogScope; readonly sourceEntityIds: readonly string[]; readonly sourceSummary: string }
  | { readonly kind: "historical_presence"; readonly window: TimeWindow; readonly sourceEntityIds: readonly string[]; readonly sourceSummary: string }
  | { readonly kind: "calculation"; readonly expression: string; readonly value: number | null }
  | { readonly kind: "entity_status"; readonly target: ResolvedTarget }
  | { readonly kind: "weather"; readonly forecastIndex?: number; readonly forecastLabel?: string | null; readonly reading?: "temperature" | "humidity" }
  | { readonly kind: "model_conversation" }
  | { readonly kind: "outdoor_clothing_memory"; readonly subject: string }
  | { readonly kind: "house_lights"; readonly onLightNames: readonly string[] }
  | { readonly kind: "energy_budget"; readonly monthIndex: number }
  | { readonly kind: "calendar"; readonly entityIds: readonly string[]; readonly window: TimeWindow }
  | { readonly kind: "wikipedia_abstract"; readonly title: string; readonly url: string | null; readonly description: string | null; readonly matchedBy: WikipediaMatchKind; readonly resolvedFromTitle: string | null }
  | { readonly kind: "music_playback"; readonly request: MusicPlaybackRequest; readonly tracks: readonly MusicAssistantTrack[]; readonly selectedUri: string; readonly endpointId: string; readonly endpointLabel: string }
  | { readonly kind: "current_power_ranking"; readonly metricId: string; readonly direction: "ascending" | "descending" }
  | { readonly kind: "current_metric"; readonly metricId: string; readonly followUpSource?: "target_swap" | null; readonly composed?: DynamicMetricContextData | null }
  | { readonly kind: "history_metric"; readonly metricId: string; readonly window: TimeWindow; readonly followUpSource?: "target_swap" | null; readonly composed?: DynamicMetricContextData | null }
  | { readonly kind: "comparison_metric"; readonly metricId: string; readonly windows: ComparisonWindowPair; readonly followUpSource?: "target_swap" | null; readonly composed?: DynamicMetricContextData | null };

export type BasicAnswerTraceFrame = Extract<BasicContextFrame, {
  readonly kind: "answer_explanation" | "house_summary" | "event_log" | "historical_presence" | "wikipedia_abstract";
}>;

export type BasicFocusContextFrame = Exclude<
  BasicContextFrame,
  PendingClarifierFrame | BasicAnswerTraceFrame
>;

/** What every code-owned answer shares: no model, no result id, nothing touched. */
interface CodeAnswer<Route extends string, Status extends string, Confidence extends string> {
  readonly route: Route;
  readonly status: Status;
  readonly confidence: Confidence;
  readonly text: string;
  readonly modelUsed: false;
  readonly resultId: null;
  readonly touchedEntities: readonly string[];
  readonly notes: string;
}

/** A sourced code answer. */
export function ok<Route extends string, Frame = never>(
  route: Route,
  text: string,
  notes: string,
  contextFrame: Frame | null = null,
  speechPlan: BasicSpeechRenderPlan | null = null,
): CodeAnswer<Route, "ok", "high"> & { readonly speechPlan?: BasicSpeechRenderPlan; readonly contextFrame?: Frame } {
  return {
    route,
    status: "ok",
    confidence: "high",
    text,
    ...(speechPlan ? { speechPlan } : {}),
    modelUsed: false,
    resultId: null,
    touchedEntities: [],
    notes,
    ...(contextFrame ? { contextFrame } : {}),
  };
}

/** A code decline: low confidence, nothing touched. */
export function declined<Route extends string>(route: Route, text: string, notes: string): CodeAnswer<Route, "declined", "low"> {
  return {
    route,
    status: "declined",
    confidence: "low",
    text,
    modelUsed: false,
    resultId: null,
    touchedEntities: [],
    notes,
  };
}

/** A code clarifier: asks which one, keeps the pending choice as context. */
export function clarify(route: BasicRoute, text: string, notes: string, contextFrame: PendingClarifierFrame): BasicResult {
  return {
    route,
    status: "clarify",
    confidence: "low",
    text,
    modelUsed: false,
    resultId: null,
    touchedEntities: [],
    notes,
    contextFrame,
    sessionDirective: "continue",
  };
}

/** An answer withheld from an untrusted voice (see BasicResult.withheld). */
export function withheld<Route extends string>(route: Route, notes: string) {
  return { ...declined(route, "", notes), withheld: true as const };
}

export function declinedReadFallback(
  route: BasicRoute,
  text: string,
  notes: string,
  reason: ReadAgentFallbackReason,
): BasicResult {
  return withReadFallback(declined(route, text, notes), reason);
}

export function withReadFallback(
  result: BasicResult,
  reason: ReadAgentFallbackReason,
  scope: Pick<
    ReadAgentEligibleFallbackDisposition,
    "ownPresenceWindow" | "ownPresencePersonEntityId" | "memoryGuard"
  > = {},
): BasicResult {
  if (result.status !== "declined" || result.readFallback) {
    return result;
  }
  return {
    ...result,
    readFallback: {
      eligible: true,
      reason,
      ...scope,
    },
  };
}

/** The first turn of the current conversation, or now when this turn opens it. */
export function conversationStartedAt(turns: readonly BasicConversationTurn[], now: Date): Date {
  const first = Math.min(...turns.map((turn) => turn.timestampMs).filter(Number.isFinite));
  return Number.isFinite(first) && first < now.getTime() ? new Date(first) : now;
}

export function resultId(turnId: string): string {
  return `result-${turnId}`;
}

export function declinedWithContext(route: BasicRoute, text: string, notes: string, contextFrame: BasicContextFrame | null): BasicResult {
  return {
    ...declined(route, text, notes),
    ...(contextFrame ? { contextFrame } : {}),
  };
}
