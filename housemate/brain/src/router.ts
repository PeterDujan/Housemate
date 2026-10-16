/**
 * The owner table.
 *
 * An owner says "this turn is mine" (`claim`) and then answers it (`answer`).
 * Owners sit in nine precedence tiers
 * "Arbitration Policy". `handleBasicTurn` runs one table, `OWNER_TABLE`, in
 * the brain's historical order; where order decides a clash it is a tie rule
 * (`TIE_RULES`), with a test. Order is a fact to remove, not a design.
 * Frame owners also take follow-ups: `FOLLOW_UPS` is every owner's
 * follow-up steps in one order, run by the follow-up stage. Owners never
 * import the brain: what they need from it arrives in `OwnerServices`.
 */
import type { BasicTurnAnalysis } from "./basic-turn-analysis.js";
import type { BasicBrainRouteServices, CatchupRuntime } from "./basic-brain-services.js";
import { declined, withReadFallback, type BasicConversationTurn, type BasicResult, type PendingClarifierFrame } from "./basic-brain-contracts.js";
import type { BasicContextViews } from "./basic-context-store.js";
import type { AppConfig } from "./config.js";
import type { CorrectionLedger } from "./correction-ledger.js";
import type { MemoryArchive } from "./memory-archive.js";
import type { JarvisSelfModel } from "./self-model.js";
import type { TimeWindow } from "./time-window-parser.js";
import type { VoiceBrainRequest } from "./voice-brain.js";
import type { WikipediaKnowledgeStore } from "./wikipedia-knowledge-store.js";
import { normalizeMeasuredRoutingText } from "./routing-text.js";
import * as stateless from "./stateless-owners.js";
import {
  FollowUpTurn,
  NOT_FOLLOW_UP,
  followUpSteps,
  looksLikeBasicFollowUp,
  looksLikeContextualDomainFragment,
  type FollowUpStep,
} from "./follow-up-turn.js";
import {
  looksLikeOutdoorAdviceFollowUp,
  looksLikeWeatherContextFollowUp,
  looksLikeWeatherFastPathQuestion,
  looksLikeWeatherForecastFollowUp,
} from "./basic-brain-weather.js";
import {
  looksLikeCurrentPowerRankingQuestion,
  looksLikeEnergyBudgetQuestion,
  looksLikeHistoryMetricQuestion,
  looksLikeStandaloneTimeWindowFollowUp,
  resolveMetricQuestion,
} from "./basic-brain-metrics.js";
import { looksLikeElectricitySummaryQuestion } from "./basic-brain-knowledge.js";
import { looksLikeCalendarQuestion, looksLikeScheduleQuestion, looksLikeTodoQuestion } from "./basic-brain-schedule.js";
import * as weather from "./weather-owners.js";
import * as music from "./music-owners.js";
import * as conversation from "./conversation-owners.js";
import * as status from "./status-owners.js";
import * as energy from "./energy-owners.js";
import * as schedule from "./schedule-owners.js";
import * as knowledge from "./knowledge-owners.js";
import { looksLikeScalarCalculationFollowUp } from "./scalar-calculator.js";
import * as action from "./action-owners.js";

/** The arbitration tiers, highest first. */
export const TIERS = [
  "protocol", "safety", "explicit", "correction", "continuation", "inferred", "unsupported", "knowledge", "conversation",
] as const;
export type Tier = (typeof TIERS)[number];

/** The turn as every owner sees it: parsed once by the brain. */
export interface OwnerTurn {
  readonly request: VoiceBrainRequest;
  /** The trimmed spoken words. */
  readonly surface: string;
  /** The routing core for a query or command, otherwise the surface. */
  readonly transcript: string;
  /** `transcript` as measured routing text. */
  readonly normalized: string;
  readonly analysis: BasicTurnAnalysis;
  readonly conversationTurns: readonly BasicConversationTurn[];
  /** The previous reply was the model talking (open chat or knowledge). */
  readonly activeModelConversation: boolean;
  /** Asks for current information a research call would look up. */
  readonly currentInformationResearch: boolean;
  readonly resolvedTimeWindow: TimeWindow | null;
  /**
   * A reading of the turn that several owners share (the house-versus-knowledge
   * evidence, whether open chat carries on), worked out once; `key` names it.
   */
  once<T>(key: string, compute: () => T): T;
}

/** The words every owner reads, cut once from the request and its analysis. */
export function ownerTurn(options: Omit<OwnerTurn, "surface" | "transcript" | "normalized" | "once">): OwnerTurn {
  const surface = options.request.transcript.trim();
  const transcript = options.analysis.normalizedCore
    && (options.analysis.speechAct === "query" || options.analysis.speechAct === "command")
    ? options.analysis.normalizedCore
    : surface;
  const shared = new Map<string, unknown>();
  const once = <T>(key: string, compute: () => T): T => {
    if (!shared.has(key)) shared.set(key, compute());
    return shared.get(key) as T;
  };
  return { ...options, surface, transcript, normalized: normalizeMeasuredRoutingText(transcript), once };
}

/** Sources and brain capabilities an owner may use; never the brain module itself. */
export interface OwnerServices {
  readonly turn: OwnerTurn;
  readonly turnId: string;
  readonly config: AppConfig;
  readonly routes: BasicBrainRouteServices;
  readonly now: () => Date;
  readonly selfModel?: JarvisSelfModel;
  readonly memoryArchive: MemoryArchive | null;
  readonly correctionLedger: CorrectionLedger | null;
  readonly catchup: CatchupRuntime;
  /** Open chat on this turn, or on other words in its place. */
  readonly openChat: (transcript?: string) => Promise<BasicResult>;
  readonly contextViews: BasicContextViews;
  /** The session has a frame from an earlier turn. */
  readonly hasSessionContext: boolean;
  readonly wikipediaKnowledge: WikipediaKnowledgeStore;
  /** Claims a pending clarifier for this turn; null when a newer reply already did. */
  readonly claimClarifier: (frameId: string) => PendingClarifierFrame | null;
  /** General knowledge (offline Wikipedia, then the bounded model) on this turn. */
  readonly knowledge: () => Promise<BasicResult>;
  /** Stage timings for the turn notes, written by the stages that ran. */
  readonly stages: { earlyKnowledgeMs: number; followUpMs: number };
}

/**
 * Owner modules import this contract as types only, so the table can import
 * them without a cycle. Write each owner as an object literal that
 * `satisfies Owner<Claim>`.
 */
export interface Owner<Claim = unknown> {
  readonly id: string;
  readonly tier: Tier;
  /** Pure: no reads with side effects, no writes. */
  claim(turn: OwnerTurn, ctx: OwnerServices): Claim | null;
  /**
   * The answer, or null when a source the claim could not read first (the
   * offline Wikipedia index, a follow-up frame) shows the turn is not this
   * owner's after all: the next owner tries.
   */
  answer(claim: Claim, services: OwnerServices): BasicResult | null | Promise<BasicResult | null>;
}

// --- The follow-up stage ---------------------------------------------------------

/**
 * Leaves the stage when the turn is a whole question of some domain, not a
 * fragment that leans on what came before ("what's the weather tomorrow?",
 * "play Yellow").
 */
const COMPLETE_QUESTION = followUpSteps("follow_up", {
  completeQuestion(f, ctx) {
    const n = f.normalized;
    const contextualWeatherAdvice = f.priorWeatherFrame !== null
      && !f.standaloneOutdoorAdvice
      && looksLikeOutdoorAdviceFollowUp(n);
    return !looksLikeContextualDomainFragment(n) && !f.correctsToWeather && !contextualWeatherAdvice && (
      looksLikeEnergyBudgetQuestion(n)
      || looksLikeElectricitySummaryQuestion(n)
      || resolveMetricQuestion(n)
      || looksLikeHistoryMetricQuestion(n)
      || looksLikeCurrentPowerRankingQuestion(n)
      || looksLikeWeatherFastPathQuestion(n)
      || looksLikeScheduleQuestion(n)
      || looksLikeCalendarQuestion(n)
      || looksLikeTodoQuestion(n)
      || weather.looksLikeDirectOutdoorClothingMemoryQuestion(n, ctx.turn.request)
      || music.looksLikeMusicPlayRequest(f.transcript, n)
    )
      ? NOT_FOLLOW_UP
      : null;
  },
  /** Past here only follow-up shapes go on: "and...", "what about...", "why?", a bare window. */
  followUpShape(f) {
    const n = f.normalized;
    const basicFollowUp = looksLikeBasicFollowUp(n)
      || (f.priorWeatherFrame !== null && looksLikeOutdoorAdviceFollowUp(n))
      || (f.returnsToPriorFocus && f.views.focus.recentByDomain.length > 0)
      || f.correctsToWeather;
    return !basicFollowUp && !f.lightsListFollowUp && !looksLikeStandaloneTimeWindowFollowUp(n, f.timeWindow)
      ? NOT_FOLLOW_UP
      : null;
  },
  /** Past here every step reads the focused frame. */
  focusRequired(f) {
    return f.hasFocus ? null : NOT_FOLLOW_UP;
  },
  incompatible() {
    return declined("open_conversation", "That follow-up doesn't hook cleanly onto the last sourced answer. Restate it as a full question.", "follow-up frame type incompatible");
  },
});

/**
 * Every owner's follow-up steps in one order: the old follow-up chain's,
 * branch for branch. An owner's steps are not contiguous: where another
 * owner's step sits between two of them, that step decides first. The active
 * frame's owner does not go first yet; that sort is not proven neutral.
 */
export const FOLLOW_UPS: readonly FollowUpStep[] = [
  conversation.OPEN_CHAT_FOLLOW_UPS.dialogueFocus,
  status.CLARIFIER_FOLLOW_UPS.choice,
  weather.WEATHER_FOLLOW_UPS.standaloneRequest,
  energy.ENERGY_FOLLOW_UPS.metricContext,
  weather.WEATHER_FOLLOW_UPS.clothingMemoryFrame,
  weather.WEATHER_FOLLOW_UPS.standaloneAdvice,
  weather.WEATHER_FOLLOW_UPS.numericOrWindMetric,
  status.STATUS_FOLLOW_UPS.restatement,
  status.STATUS_FOLLOW_UPS.outsideTemperature,
  status.STATUS_FOLLOW_UPS.freshQuestion,
  COMPLETE_QUESTION.completeQuestion,
  status.CLARIFIER_FOLLOW_UPS.reply,
  energy.ENERGY_FOLLOW_UPS.metricContextAfterClarifier,
  status.STATUS_FOLLOW_UPS.statusChange,
  schedule.SCHEDULE_FOLLOW_UPS.calendarWindow,
  COMPLETE_QUESTION.followUpShape,
  status.LIGHTS_FOLLOW_UPS.membership,
  conversation.ANSWER_TRACE_FOLLOW_UPS.explanation,
  conversation.CALCULATION_FOLLOW_UPS.calculation,
  energy.ENERGY_FOLLOW_UPS.powerSource,
  knowledge.KNOWLEDGE_FOLLOW_UPS.unfocusedTopic,
  status.STATUS_FOLLOW_UPS.unfocusedQuestion,
  weather.WEATHER_FOLLOW_UPS.unfocused,
  status.STATUS_FOLLOW_UPS.unfocusedTarget,
  status.STATUS_FOLLOW_UPS.placeSwap,
  weather.WEATHER_FOLLOW_UPS.noFrame,
  energy.ENERGY_FOLLOW_UPS.explicitMetricSwap,
  status.STATUS_FOLLOW_UPS.explicitQuestion,
  conversation.OPEN_CHAT_FOLLOW_UPS.deliveryRepair,
  energy.ENERGY_FOLLOW_UPS.powerRanking,
  energy.ENERGY_FOLLOW_UPS.energyHistory,
  energy.ENERGY_FOLLOW_UPS.averageBaseline,
  energy.ENERGY_FOLLOW_UPS.budget,
  energy.ENERGY_FOLLOW_UPS.comparison,
  energy.ENERGY_FOLLOW_UPS.moreThan,
  weather.WEATHER_FOLLOW_UPS.context,
  weather.WEATHER_FOLLOW_UPS.conversationAdvice,
  status.LIGHTS_FOLLOW_UPS.list,
  schedule.SCHEDULE_FOLLOW_UPS.activeCalendarWindow,
  energy.ENERGY_FOLLOW_UPS.metricWindow,
  weather.WEATHER_FOLLOW_UPS.clothingMemory,
  energy.ENERGY_FOLLOW_UPS.metricRepair,
  energy.ENERGY_FOLLOW_UPS.dynamicTargetSwap,
  energy.ENERGY_FOLLOW_UPS.metricTargetSwap,
  status.STATUS_FOLLOW_UPS.targetSwap,
  knowledge.KNOWLEDGE_FOLLOW_UPS.targetSwapTopic,
  status.STATUS_FOLLOW_UPS.targetSwapUnresolved,
  knowledge.KNOWLEDGE_FOLLOW_UPS.topic,
  status.STATUS_FOLLOW_UPS.pronounState,
  status.STATUS_FOLLOW_UPS.pronoun,
  COMPLETE_QUESTION.focusRequired,
  status.LIGHTS_FOLLOW_UPS.activeList,
  energy.ENERGY_FOLLOW_UPS.currentMetricValue,
  energy.ENERGY_FOLLOW_UPS.historyPronoun,
  COMPLETE_QUESTION.incompatible,
];

/**
 * The follow-up stage: a task in the actual world (or a weather or
 * calculator follow-up about a hypothetical) goes through `FOLLOW_UPS` until
 * a step answers or says it is no follow-up.
 */
export const followUpOwner = {
  id: "follow_up",
  tier: "continuation",
  claim(turn, ctx) {
    if (turn.analysis.semantics.use !== "task" || stateless.isLongStatement(turn)) return null;
    const followUp = new FollowUpTurn(turn, ctx.contextViews, ctx.hasSessionContext, ctx.now);
    const n = followUp.normalized;
    if (
      turn.analysis.semantics.world !== "actual"
      && !looksLikeScalarCalculationFollowUp(n)
      && !looksLikeWeatherContextFollowUp(n)
      && !looksLikeWeatherForecastFollowUp(n, ctx.now())
      && !followUp.implicitWeatherCondition
      && !looksLikeOutdoorAdviceFollowUp(n)
    ) {
      return null;
    }
    return followUp;
  },
  async answer(followUp, ctx) {
    const startedAt = Date.now();
    try {
      for (const step of FOLLOW_UPS) {
        const outcome = await step.run(followUp, ctx);
        if (outcome === NOT_FOLLOW_UP) return null;
        if (outcome) {
          const followsAgentRead = ctx.turn.conversationTurns.at(-1)?.route === "agentic_read";
          return outcome.route === "open_conversation" && !followsAgentRead
            ? outcome
            : withReadFallback(outcome, "cross_source_read_required");
        }
      }
      return null;
    } finally {
      ctx.stages.followUpMs = Math.max(0, Date.now() - startedAt);
    }
  },
} satisfies Owner<FollowUpTurn>;

/**
 * Every owner in one order: the brain's historical order (the two old
 * switchyards' checks, then 's stretches, merged where they stood).
 * The first owner that claims the turn and answers it wins; an owner that
 * passes after reading (null) lets the next one try. Order still decides
 * where two owners claim one turn: each such clash found is a tie rule
 * below. Open chat is last and answers everything.
 */
export const OWNER_TABLE: readonly Owner[] = [
  stateless.agentQuestionOwner,
  action.vacuumControlOwner,
  music.musicControlOwner,
  stateless.forgetOwner,
  stateless.dialogueActOwner,
  stateless.emptyTurnOwner,
  stateless.discourseOwner,
  stateless.priorConversationOwner,
  stateless.longStatementOwner,
  stateless.systemAnswerOwner,
  stateless.systemHealthOwner,
  stateless.speakerIdentityOwner,
  stateless.householdRosterOwner,
  knowledge.ownerProjectOwner,
  stateless.presenceRollCallOwner,
  stateless.securityRollCallOwner,
  stateless.doorbellOwner,
  status.pastReadingOwner,
  stateless.unsupportedMathOwner,
  stateless.scalarCalculationOwner,
  stateless.currentTimeOwner,
  stateless.selfTasteOwner,
  stateless.housePatternOwner,
  status.timeQualifiedStatusOwner,
  stateless.personalMemoryOwner,
  status.guestPrivateLookupOwner,
  status.entityIdentityOwner,
  knowledge.earlyKnowledgeOwner,
  status.climateStatusOwner,
  action.climateControlOwner,
  action.deviceControlOwner,
  action.lockedActionOwner,
  status.houseLightsOwner,
  status.unsourcedHouseFactOwner,
  status.namedRepeatOwner,
  conversation.repeatedAnswerOwner,
  conversation.modelChatOwner,
  stateless.selfOpinionOwner,
  stateless.operatorCommentaryOwner,
  stateless.voiceCommentaryOwner,
  stateless.houseSummaryOwner,
  stateless.catchupOwner,
  schedule.calendarOverWeatherOwner,
  status.outsideSensorOwner,
  weather.timeSpecificWeatherOwner,
  status.inventoryOwner,
  stateless.mistakeExplanationOwner,
  stateless.contextFailureOwner,
  weather.departureAdviceOwner,
  followUpOwner,
  stateless.rememberOwner,
  stateless.conversationRepairOwner,
  stateless.dialogueMetaOwner,
  weather.clothingMemoryOwner,
  weather.outdoorAdviceOwner,
  weather.forecastOverSensorOwner,
  status.outsideTemperatureOwner,
  conversation.personalAdviceOwner,
  music.reminderOwner,
  status.bareDeviceOwner,
  energy.dynamicMetricOwner,
  energy.energyBudgetOwner,
  weather.weatherOwner,
  schedule.upcomingOwner,
  schedule.scheduleOwner,
  schedule.todoOwner,
  schedule.calendarOwner,
  stateless.localMediaOwner,
  conversation.liveListingsOwner,
  music.alarmOwner,
  music.musicOwner,
  stateless.stopOwner,
  stateless.goodbyeOwner,
  knowledge.stableKnowledgeOwner,
  energy.powerRankingOwner,
  energy.incompleteWindowOwner,
  energy.metricOwner,
  energy.unresolvedMetricOwner,
  status.inferredHouseFactOwner,
  status.entityStatusOwner,
  stateless.memoryQueryOwner,
  conversation.mentionOwner,
  status.identityEvidenceOwner,
  status.exactTargetOwner,
  conversation.webSearchChatOwner,
  knowledge.currentInformationOwner,
  status.houseFallbackOwner,
  status.haCandidateOwner,
  knowledge.knowledgeFallbackOwner,
  status.houseFactOwner,
  status.localSourceScopeOwner,
  knowledge.generalKnowledgeOwner,
  conversation.openChatOwner,
];

/**
 * Clashes settled by table order: found by claiming every turn of the tests,
 * the hermetic gate and the real-turn replay with every owner (within
 * the stretches, over the merged table). Listed where the winner's
 * tier does not already put it first (same tier, or a lower tier that wins
 * by order); a pass-after-reading owner or a fallback losing is no rule.
 * `example` is claimed by both owners in the baseline semantic world; the
 * winner sits first. A test holds each rule to the table. Order facts seen
 * only with live or test-only names (exact_target losing to bare_device,
 * current_time, identity_evidence, todo and house_lights; self_taste over
 * self_opinion; clothing_memory over outdoor_advice) are deliberate. Discourse and long statement
 * also overlap with the same answer (open chat), so their order is no rule.
 */
/** Examples name people as {owner}, {adult} and {child}; the router test fills them in from its household. */
export const TIE_RULES: readonly {
  readonly winner: string;
  readonly loser: string;
  readonly rule: string;
  readonly example: string;
}[] = [
  { winner: "forget", loser: "dialogue_act", example: "Forget what I said about my favourite beer",
    rule: "Forgetting what was said is a memory request, not the \"forget it\" dialogue act." },
  { winner: "dialogue_act", loser: "empty_turn", example: "Go on.",
    rule: "Words that are all filler can still be a dialogue act." },
  { winner: "dialogue_act", loser: "discourse", example: "Understood. Leave everything as it is.",
    rule: "A turn the dialogue-act parse settles whole is answered as that act, however many sentences it has." },
  { winner: "dialogue_act", loser: "operator_commentary", example: "never mind",
    rule: "A settled dialogue act is answered as the act, not as commentary on the assistant." },
  { winner: "dialogue_act", loser: "stop", example: "Cancel.",
    rule: "A bare cancel or stop is the dialogue act's own reply." },
  { winner: "dialogue_act", loser: "goodbye", example: "Bye.",
    rule: "A bare goodbye is the dialogue act's own reply." },
  { winner: "discourse", loser: "system_answer", example: "Voices differ. {adult} could say this is {owner}.",
    rule: "A turn that only tells is conversation, even when it says who is speaking." },
  { winner: "discourse", loser: "speaker_identity", example: "Voices differ. {adult} could say this is {owner}.",
    rule: "A turn that only tells is conversation, not an identity claim." },
  { winner: "discourse", loser: "house_pattern", example: "{child} loves school. She usually arrives at school early.",
    rule: "A turn that only tells is conversation, even when it describes a household habit." },
  { winner: "discourse", loser: "voice_commentary", example: "No, I can understand you now. It was the voice.",
    rule: "A turn that only tells is conversation, even about the assistant's voice." },
  { winner: "system_answer", loser: "system_health", example: "are device actions still locked?",
    rule: "The system answer's specific runtime facts (locked, ready) come before the generic health line." },
  { winner: "system_answer", loser: "speaker_identity", example: "who am I?",
    rule: "The assistant-system boundary answers \"who am I?\" first; the speaker-identity parse is its broader fallback." },
  { winner: "system_answer", loser: "memory_query", example: "I am {owner}, remember?",
    rule: "Telling the assistant who is speaking is answered as identity, not looked up in memory." },
  { winner: "system_answer", loser: "exact_target", example: "this is {owner}",
    rule: "\"This is {owner}\" is the speaker saying who they are, not the person entity's state." },
  { winner: "current_time", loser: "schedule", example: "what time is it",
    rule: "The clock answers the time; the schedule is for events." },
  { winner: "house_pattern", loser: "schedule", example: "When do the lounge lights usually turn on?",
    rule: "\"Usually\" asks the learnt household pattern, not today's schedule." },
  { winner: "house_pattern", loser: "metric", example: "What is kitchen power usually?",
    rule: "\"Usually\" asks the learnt pattern, not the live reading." },
  { winner: "self_opinion", loser: "weather", example: "What kind of weather do you enjoy most?",
    rule: "Asking the assistant's taste is its opinion, not the forecast." },
  { winner: "time_qualified_status", loser: "personal_memory", example: "Was {owner} home on 22 July 2026?",
    rule: "A house state at another time is declined (no history read) before personal memory guesses at it." },
  { winner: "time_qualified_status", loser: "memory_query", example: "Was {owner} home on 22 July 2026?",
    rule: "A house state at another time is declined before a memory lookup." },
  { winner: "time_qualified_status", loser: "exact_target", example: "On 22 July 2026, were my office lights off?",
    rule: "A named device at another time is declined, never answered with its state now." },
  { winner: "personal_memory", loser: "calendar", example: "Which events did I attend on 22 July 2026?",
    rule: "What the speaker did on a past day is personal memory, not the calendar." },
  { winner: "personal_memory", loser: "memory_query", example: "How old am I?",
    rule: "A personal question about the speaker is answered from what the assistant keeps about them first." },
  { winner: "personal_memory", loser: "outdoor_advice", example: "Did I go out on 22 July 2026?",
    rule: "A past outing is personal memory, not advice for going out." },
  { winner: "house_lights", loser: "outdoor_advice", example: "Are any lights still on before we head out?",
    rule: "Lights left on before going out is the lights roll call, not outdoor advice." },
  { winner: "house_lights", loser: "metric", example: "Which lights are on that I could switch off to save power?",
    rule: "Which lights are on is the lights roll call, even when power is the reason." },
  { winner: "catchup", loser: "outdoor_advice", example: "What did I miss while I was out?",
    rule: "\"While I was out\" asks what happened, not what to wear." },
  { winner: "calendar_over_weather", loser: "weather", example: "What's in my diary tomorrow, not the forecast?",
    rule: "Naming the calendar over the forecast is a correction towards the calendar." },
  { winner: "calendar_over_weather", loser: "calendar", example: "What's in my diary tomorrow, not the forecast?",
    rule: "The calendar answers it either way; the correction owner reads it first." },
  { winner: "outside_sensor", loser: "exact_target", example: "Outside sensor temperature?",
    rule: "The physical outdoor sensor is read as itself, named or not." },
  { winner: "mistake_explanation", loser: "conversation_repair", example: "I was asking you to explain the mistake, not repeat the watts.",
    rule: "Asking why the assistant got it wrong is answered as that, before a general repair." },
  { winner: "remember", loser: "conversation_repair", example: "please remember that mess for Codex.",
    rule: "An explicit \"remember\" gets the honest code reply, even when it also names a handoff." },
  { winner: "conversation_repair", loser: "dialogue_meta", example: "I thought you did",
    rule: "A repair marker gets the short repair acknowledgement before talk about the talk goes to open chat." },
  { winner: "conversation_repair", loser: "weather", example: "why did you dump all the weather numbers?",
    rule: "A complaint about the last answer is a repair, not a new weather question." },
  { winner: "clothing_memory", loser: "schedule", example: "when do I usually put a jacket on?",
    rule: "\"When do I put a jacket on\" is the clothing preference, not a schedule." },
  { winner: "clothing_memory", loser: "memory_query", example: "do you remember my jacket preference?",
    rule: "The remembered clothing preference has its own owner before the general memory lookup." },
  { winner: "outdoor_advice", loser: "weather", example: "umbrella weather?",
    rule: "Asking what to take or wear is advice from the forecast, not the bare forecast." },
  { winner: "outside_temperature", loser: "bare_device", example: "read the outside temperature sensor",
    rule: "The outdoor temperature sensor is read by its reading, not resolved as a bare name." },
  { winner: "outside_temperature", loser: "weather", example: "outside temperature please",
    rule: "The house's outdoor sensor answers the outside temperature before the forecast." },
  { winner: "outside_temperature", loser: "exact_target", example: "outside temperature please",
    rule: "The outside temperature is read from the outdoor sensor by its reading, whichever name matched." },
  { winner: "personal_advice", loser: "schedule", example: "how should I start when a problem feels overwhelming?",
    rule: "Personal advice is conversation, even when it says \"when\"." },
  { winner: "reminder", loser: "schedule", example: "remind me when swimming lessons starts",
    rule: "\"Remind me when\" is a deferred watch, not a schedule question." },
  { winner: "bare_device", loser: "metric", example: "Office computer power switch?",
    rule: "A bare device name asks its state; a power word in the name does not make it a reading." },
  { winner: "energy_budget", loser: "metric", example: "are we under the electricity cap?",
    rule: "The monthly budget answers cap and billing questions before a single meter." },
  { winner: "energy_budget", loser: "weather", example: "What does the electricity forecast look like this month?",
    rule: "An electricity forecast is the energy budget's projection, not the weather." },
  { winner: "energy_budget", loser: "memory_query", example: "What does the electricity forecast look like this month?",
    rule: "A budget question is answered from the meters, not from memory." },
  { winner: "energy_budget", loser: "power_ranking", example: "what source are you using for the monthly usage?",
    rule: "Monthly usage is the budget's, even when it asks the source." },
  { winner: "weather", loser: "calendar", example: "What's tomorrow's weather, not my diary?",
    rule: "Naming the forecast over the diary asks the weather." },
  { winner: "weather", loser: "memory_query", example: "what does it feel like outside?",
    rule: "How it feels outside is the weather, not a memory of it." },
  { winner: "upcoming", loser: "calendar", example: "what have I got on today?",
    rule: "\"What have I got on\" gathers every commitment, the calendar among them." },
  { winner: "schedule", loser: "calendar", example: "when is bin night this week?",
    rule: "A household schedule item is the schedule's, before calendar events." },
  { winner: "schedule", loser: "metric", example: "when is solar power meeting?",
    rule: "\"When is ...\" asks a time, not a power reading." },
  { winner: "calendar", loser: "memory_query", example: "What did I have on my calendar on 22 July 2026?",
    rule: "Naming the calendar reads the calendar, not memory." },
  { winner: "stable_knowledge", loser: "metric", example: "What type of body of water is the Dead Sea?",
    rule: "Stable knowledge grammar (\"what type of ...\") is knowledge, even when a word looks like a metric." },
  { winner: "power_ranking", loser: "metric", example: "rank what is using power",
    rule: "Ranking the loads comes before reading one total." },
  { winner: "incomplete_window", loser: "metric", example: "Alright. How much electricity was used yester",
    rule: "A cut-off time window is asked again, never answered as a live reading." },
  { winner: "metric", loser: "memory_query", example: "How much electricity did I use on 22 July 2026?",
    rule: "Electricity on a past day is the meter's history, not memory." },
  { winner: "metric", loser: "exact_target", example: "check office power",
    rule: "A power reading of a named place is the metric, not the entity's raw state." },
  { winner: "unresolved_metric", loser: "exact_target", example: "average office temperature today",
    rule: "An average over today is a metric window, declined honestly, not the sensor's state now." },
  { winner: "memory_query", loser: "exact_target", example: "what do you remember about office lights",
    rule: "\"What do you remember about X\" is memory, not X's state." },
];

/** The first owner that claims the turn and answers it; open chat answers every turn. */
export async function runOwners(services: OwnerServices): Promise<BasicResult> {
  for (const candidate of OWNER_TABLE) {
    const claim = candidate.claim(services.turn, services);
    const answer = claim === null ? null : await candidate.answer(claim, services);
    if (answer) {
      return answer.withheld ? services.openChat() : answer;
    }
  }
  throw new Error("no owner answered the turn; open chat must be last in OWNER_TABLE");
}
