/**
 * The follow-up stage's shared reading of an elliptical turn:
 * follow-up shapes ("what about X?", "and yesterday?", "why?", "is it
 * still on?"), the turn as every owner's follow-up step sees it
 * (`FollowUpTurn`, computed once per turn), and the step contract. The
 * steps live with their owners; their order is `FOLLOW_UPS` in `router.ts`.
 */
import { declined, type BasicContextFrame, type BasicResult, type BasicRoute } from "./basic-brain-contracts.js";
import type { BasicContextViews, BasicHouseLightsContextFrame, BasicMetricsContextFrame, BasicWeatherContextFrame } from "./basic-context-store.js";
import { parseOutdoorAdviceSlots } from "./intent-parser.js";
import type { OwnerServices, OwnerTurn } from "./router.js";
import { normalizeSpeechForRouting } from "./speech-normalizer.js";
import { extractTimeWindowEnvelopeFromUtterance, type TimeWindow } from "./time-window-parser.js";
import { classifyDemonstrativeTarget } from "./entity-action-intent.js";
import { cleanTargetText } from "./entity-status-intent.js";
import {
  normalizeDynamicMetricTargetText,
  hasMetricTimeWindow,
  looksLikeComparisonMetricQuestion,
  looksLikeEnergyBudgetFollowUp,
  resolveTimeWindowFromQuestion,
} from "./basic-brain-metrics.js";
import { looksLikeWeatherContextFollowUp, looksLikeWeatherForecastFollowUp } from "./basic-brain-weather.js";
import { looksLikeScalarCalculationFollowUp } from "./scalar-calculator.js";
import { canonicalizeLeadingQuestionContractions } from "./routing-text.js";
import { DEFAULT_TIMEZONE } from "./basic-brain-open-chat.js";
import { FOLLOW_UP_FRAGMENT_MAX_WORDS, FOLLOW_UP_OPENER_PATTERN, NOW_PATTERN, WEEKDAY_PATTERN } from "./lexicon.js";
import { spokenWordCount } from "./text-format.js";
import { looksLikeConversationRepair } from "./stateless-owners.js";
import {
  explicitFocusShiftTargetText,
  looksLikeCompactStateOnlyFollowUp,
  looksLikePronounStatusFollowUp,
  looksLikeStatusChangeFollowUp,
} from "./basic-brain-status.js";

/** A follow-up step's verdict that the turn is no follow-up: the table goes on past the stage. */
export const NOT_FOLLOW_UP = "not_follow_up";

/** An answer, (not this step's: the next step tries) or `NOT_FOLLOW_UP`. */
export type FollowUpOutcome = BasicResult | null | typeof NOT_FOLLOW_UP;

/** One branch of an owner's follow-up, run in `FOLLOW_UPS` order. */
export interface FollowUpStep {
  /** The owner whose frame (or follow-up shape) the step reads. */
  readonly owner: string;
  readonly id: string;
  run(turn: FollowUpTurn, ctx: OwnerServices): FollowUpOutcome | Promise<FollowUpOutcome>;
}

/** An owner's follow-up steps, named by their keys. */
export function followUpSteps<K extends string>(
  owner: string,
  runs: Readonly<Record<K, FollowUpStep["run"]>>,
): Readonly<Record<K, FollowUpStep>> {
  return Object.freeze(Object.fromEntries(Object.entries<FollowUpStep["run"]>(runs)
    .map(([id, run]) => [id, Object.freeze({ owner, id, run })]))) as Readonly<Record<K, FollowUpStep>>;
}

type MetricFrame = Extract<BasicContextFrame, { kind: "current_metric" | "history_metric" | "comparison_metric" }>;
type CurrentPowerFrame = Extract<BasicContextFrame, { kind: "current_metric" | "current_power_ranking" }>;

/**
 * The turn as every follow-up step reads it: the follow-up text forms and
 * the frames it may follow, each worked out once on first use.
 */
export class FollowUpTurn {
  /** The routing text as the turn arrived. */
  readonly raw: string;
  /** `raw` with compact follow-ups spelled out ("same for X" -> "what about X"). */
  readonly normalized: string;
  readonly transcript: string;
  readonly views: BasicContextViews;
  /** "Back to...": recent frames of other domains count, not only the active one. */
  readonly returnsToPriorFocus: boolean;
  readonly activeFocusDomain: string | null;
  readonly clarifier: BasicContextViews["clarifier"]["pending"];
  readonly correctsToWeather: boolean;
  private readonly cache = new Map<string, unknown>();

  constructor(readonly turn: OwnerTurn, views: BasicContextViews, readonly hasSessionContext: boolean, private readonly now: () => Date) {
    this.raw = turn.normalized;
    this.normalized = canonicalizeCompactFollowUpText(turn.normalized);
    this.transcript = turn.transcript;
    this.views = views;
    this.returnsToPriorFocus = /\b(?:back to|go back to|return to)\b/.test(this.normalized);
    this.activeFocusDomain = views.focus.active?.domain ?? null;
    this.clarifier = views.clarifier.pending ?? views.clarifier.claimed;
    this.correctsToWeather = CORRECTS_TO_WEATHER.test(this.normalized);
  }

  /** A value worked out once per turn; `key` names it. */
  once<T>(key: string, compute: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, compute());
    return this.cache.get(key) as T;
  }

  get hasFocus(): boolean {
    return this.activeFocusDomain !== null;
  }

  /** The spoken surface, pragmatic prefaces kept ("I mean the solar"). */
  get surface(): string {
    return this.once("surface", () => canonicalizeCompactFollowUpText(normalizeSpeechForRouting(this.turn.analysis.surface, {
      preserveEntityChars: true,
      preserveMeasurementChars: true,
      preservePragmaticPrefaces: true,
    })));
  }

  /** The discourse surface, directive wrappers kept ("check whether..."). */
  get discourse(): string {
    return this.once("discourse", () => canonicalizeCompactFollowUpText(this.turn.analysis.normalizedSurface));
  }

  get statusFrame(): Extract<BasicContextFrame, { kind: "entity_status" }> | null {
    return this.views.entityStatus.active?.payload
      ?? (this.returnsToPriorFocus ? this.views.entityStatus.recent?.payload ?? null : null);
  }

  get calculationFrame(): Extract<BasicContextFrame, { kind: "calculation" }> | null {
    return this.views.calculation.active?.payload
      ?? (this.returnsToPriorFocus ? this.views.calculation.recent?.payload ?? null : null);
  }

  /** Metric frames newest first, while metrics hold the focus or the turn goes back to them. */
  get metricHistory(): readonly BasicMetricsContextFrame[] {
    return this.once("metricHistory", () => this.activeFocusDomain === "metrics" || this.returnsToPriorFocus
      ? this.views.metrics.history.map((entry) => entry.payload)
      : []);
  }

  get activeMetricFrame(): BasicMetricsContextFrame | null {
    return this.views.metrics.active?.payload ?? null;
  }

  get metricFrame(): MetricFrame | undefined {
    const active = this.activeMetricFrame;
    return active && (active.kind === "current_metric" || active.kind === "history_metric" || active.kind === "comparison_metric")
      ? active
      : this.returnsToPriorFocus
        ? this.metricHistory.find((frame): frame is MetricFrame => frame.kind === "current_metric" || frame.kind === "history_metric" || frame.kind === "comparison_metric")
        : undefined;
  }

  get currentPowerContext(): CurrentPowerFrame | undefined {
    const active = this.activeMetricFrame;
    return active && (active.kind === "current_metric" || active.kind === "current_power_ranking")
      ? active
      : this.returnsToPriorFocus
        ? this.metricHistory.find((frame): frame is CurrentPowerFrame => frame.kind === "current_metric" || frame.kind === "current_power_ranking")
        : undefined;
  }

  get priorWeatherFrame(): BasicWeatherContextFrame | null {
    return this.views.weather.recent?.payload ?? null;
  }

  get weatherFrame(): BasicWeatherContextFrame | null {
    return this.views.weather.active?.payload
      ?? (this.returnsToPriorFocus || this.correctsToWeather ? this.priorWeatherFrame : null);
  }

  get clothingMemoryFrame(): Extract<BasicContextFrame, { kind: "outdoor_clothing_memory" }> | null {
    return this.views.focus.recentByDomain.map((entry) => entry.payload)
      .find((frame): frame is Extract<BasicContextFrame, { kind: "outdoor_clothing_memory" }> => frame.kind === "outdoor_clothing_memory") ?? null;
  }

  get implicitWeatherCondition(): boolean {
    return this.once("implicitWeatherCondition", () => looksLikeImplicitWeatherConditionFollowUp(this.normalized));
  }

  /** A whole outdoor-advice question in a fresh session ("should I take a jacket?"). */
  get standaloneOutdoorAdvice(): boolean {
    return this.once("standaloneOutdoorAdvice", () => !this.hasSessionContext
      && parseOutdoorAdviceSlots(this.normalized) !== null
      && !looksLikeContextualDomainFragment(this.normalized)
      && !hasPronounFollowUp(this.normalized));
  }

  get lightsListFollowUp(): boolean {
    return this.once("lightsListFollowUp", () => looksLikeHouseLightsListFollowUp(this.normalized)
      || looksLikeHouseLightsListFollowUp(this.discourse)
      || (this.views.houseLights.active !== null && looksLikeBareRemainderFollowUp(this.normalized)));
  }

  get lightsFrame(): BasicHouseLightsContextFrame | undefined {
    return this.views.houseLights.active?.payload
      ?? (this.returnsToPriorFocus || this.lightsListFollowUp
        ? this.views.houseLights.recent?.payload
        : undefined);
  }

  /** A whole new question ("what is...", "turn on..."), not a fragment. */
  get restatedRequest(): boolean {
    return this.once("restatedRequest", () => looksLikeStandaloneRestatedRequest(this.normalized));
  }

  get timeWindow(): TimeWindow | null {
    return this.once("timeWindow", () => resolveTimeWindowFromQuestion(this.transcript, this.now()));
  }

  /**
   * The words left once the turn's one time phrase is taken out ("was the
   * doorbell pressed" from "... Last week"); null when no single phrase is
   * found or the turn is nothing but the phrase.
   */
  get windowResidual(): readonly string[] | null {
    return this.once("windowResidual", () => {
      const residual = extractTimeWindowEnvelopeFromUtterance(this.normalized, { now: this.now(), timezone: DEFAULT_TIMEZONE }).residualInput;
      return residual ? Object.freeze(residual.split(" ").filter(Boolean)) : null;
    });
  }

  get explicitQuestion(): string | null {
    return this.once("explicitQuestion", () => explicitFollowUpQuestionText(this.normalized));
  }

  get targetSwap(): string | null {
    return this.once("targetSwap", () => followUpTargetText(this.normalized));
  }

  get dynamicTargetSwap(): string | null {
    return this.once("dynamicTargetSwap", () => followUpDynamicMetricTargetText(this.normalized, this.now()));
  }

  get rawKnowledgeTarget(): string | null {
    return this.once("rawKnowledgeTarget", () => targetLikeKnowledgeText(this.normalized));
  }
}

/** "Back to...", "where were we", "I mean...": a return to an earlier focus. */
export const FOCUS_RETURN = /\b(?:back to|go back to|return to|where were we|i mean)\b/;

/** "I mean the weather": a correction towards the forecast. */
export const CORRECTS_TO_WEATHER = /\b(?:i do mean|i mean|meant)\b.*\b(?:weather|forecast)\b/;

export function looksLikeBasicFollowUp(normalized: string): boolean {
  return looksLikeAnswerExplanationFollowUp(normalized)
    || looksLikeScalarCalculationFollowUp(normalized)
    || looksLikeRankedCurrentPowerOrdinalFollowUp(normalized)
    || looksLikeCurrentPowerRankingFollowUp(normalized)
    || looksLikeCurrentPowerSourceClarifierFollowUp(normalized)
    || looksLikeAdditiveTargetFollowUp(normalized)
    || /^and\b/.test(normalized)
    || /^how about\b/.test(normalized)
    || /^what about\b/.test(normalized)
    || looksLikeCorrectionFollowUp(normalized)
    || looksLikeHouseLightsListFollowUp(normalized)
    || houseLightMembershipTarget(normalized) !== null
    || looksLikeCompactPronounQuestion(normalized)
    || looksLikeCompactStateOnlyFollowUp(normalized)
    || looksLikeCurrentMetricValueFollowUp(normalized)
    || /^(?:is that )?(?:more|less|higher|lower|greater) than\b/.test(normalized)
    || (hasPronounFollowUp(normalized) && looksLikeComparisonMetricQuestion(normalized))
    || looksLikePronounStatusFollowUp(normalized)
    || looksLikeStatusChangeFollowUp(normalized)
    || looksLikeAverageBaselineFollowUp(normalized)
    || looksLikeEnergyBudgetFollowUp(normalized)
    || looksLikeWeatherContextFollowUp(normalized)
    || looksLikeWeatherForecastFollowUp(normalized)
    || looksLikeImplicitWeatherConditionFollowUp(normalized)
    || looksLikeCompactOutdoorClothingFollowUp(normalized);
}

export function houseLightMembershipTarget(normalized: string): string | null {
  const listedTarget = /^(?:is|are) (?:the )?(.+?) (?:one|part) of (?:them|those|that list)$/.exec(normalized)?.[1] ?? "";
  const contextualRoom = /^is that (?:the )?light (?:in|from) (?:the )?(.+)$/.exec(normalized)?.[1] ?? "";
  const target = cleanTargetText(listedTarget || contextualRoom, "status");
  return target;
}

function looksLikeAdditiveTargetFollowUp(normalized: string): boolean {
  return /^.+\s+too\??$/.test(normalized)
    && !/^(?:me|you|we|they)\s+too\??$/.test(normalized);
}

export function looksLikeAnswerExplanationFollowUp(normalized: string): boolean {
  return /^why\??$/.test(normalized)
    || /^(?:what (?:do|did) you mean|what does (?:that|this|it) mean)\??$/.test(normalized)
    || /^how do you know\??$/.test(normalized)
    || /\bwhere did (?:that|this|it) come from\??$/.test(normalized)
    || /\bwhat did you use\??$/.test(normalized)
    || /\bwhat (?:source|sources) did you use\??$/.test(normalized)
    || /\bwhat are your sources\??$/.test(normalized)
    || /\bwhy did you say (?:that|this|it)\??$/.test(normalized)
    || /\bexplain (?:that|this|it)\b/.test(normalized);
}

export function hasPronounFollowUp(normalized: string): boolean {
  return /\bit\b/.test(normalized)
    || /\bthey\b/.test(normalized)
    || /\bthem\b/.test(normalized)
    || /\btheir\b/.test(normalized)
    || /\bthose\b/.test(normalized)
    || /\bthese\b/.test(normalized)
    || /\bthis\b(?!\s+(?:week|weekend|month|year|morning|afternoon|evening|tonight|time)\b)/.test(normalized)
    || /\bthat\b(?!\s+(?:is|are|was|were)\b)/.test(normalized);
}

function looksLikeCompactPronounQuestion(normalized: string): boolean {
  return new RegExp(String.raw`^(?:what|whats|where|which|who|how much) (?:is|are|was|were) (?:it|that|this|they|those|these)(?: ${NOW_PATTERN})?\??$`).test(normalized);
}

export function looksLikeCurrentMetricValueFollowUp(normalized: string): boolean {
  const compactPronounValueQuestion = looksLikeCompactPronounQuestion(normalized);
  const explicitMetricValueQuestion = hasPronounFollowUp(normalized)
    && /\b(?:power|electricity|load|watts?|kw|usage|using|use|draw|drawing)\b/.test(normalized);
  return (compactPronounValueQuestion || explicitMetricValueQuestion)
    && !looksLikeConversationRepair(normalized)
    && !looksLikeAverageBaselineFollowUp(normalized)
    && !looksLikeCurrentPowerRankingFollowUp(normalized);
}

export function looksLikeHouseLightsListFollowUp(normalized: string): boolean {
  return looksLikeExplicitHouseLightsFocusReturn(normalized) || (
    /\b(?:what|which|tell|list|name|show)\b/.test(normalized)
    // "What are the two others that are lit?" names the lights by their state.
    && /\b(?:lights?|ones|lit|switched on|turned on|(?:are|is|s) (?:still )?on)\b/.test(normalized)
    && (
      /\b(?:more|rest|remaining|others?)\b/.test(normalized)
      || /\b(?:one|1|two|2|three|3|four|4|five|5|six|6|seven|7|eight|8|nine|9|ten|10)\s+more\b/.test(normalized)
      || /\b(?:you told me|you said|just tell me|tell me the)\b/.test(normalized)
    )
  ) || (
    /\b(?:you told me|you said)\b/.test(normalized)
    && /\b(?:more|lights?)\b/.test(normalized)
    && /\b(?:tell me|list|name|show)\b/.test(normalized)
  ) || /\b(?:whole[ -]?house|house)\s+list\b.*\b(?:again|once more|repeat)\b/.test(normalized);
}

/**
 * "What are the other two?", "the rest?", "which are the others?": a bare
 * remainder ask with no noun. Only counted while a house-lights list is the
 * active focus, so it never steals another domain's "the others".
 */
export function looksLikeBareRemainderFollowUp(normalized: string): boolean {
  const count = "(?:one|ones|two|three|four|five|six|seven|eight|nine|ten|[0-9]+)";
  return new RegExp(`^(?:and )?(?:(?:what|which|who) (?:are|is|were) )?(?:the )?(?:other ${count}|other ones|others|rest|remaining ${count}|${count} others?)(?: then)?$`).test(normalized)
    || new RegExp(`^(?:what|which) (?:are|were) the (?:${count} )?(?:others|other ones|rest)$`).test(normalized)
    || /^(?:name|list|tell me) (?:the )?(?:others|rest|other ones)$/.test(normalized);
}

export function looksLikeExplicitHouseLightsFocusReturn(normalized: string): boolean {
  return /\b(?:back to|go back to|return to)\b/.test(normalized)
    && /\b(?:list|report|summary|rundown|overview)\b/.test(normalized)
    && /\b(?:lights?|lighting)\b/.test(normalized);
}

export function targetLikeKnowledgeText(normalized: string): string | null {
  const raw = followUpContentText(normalized);
  return raw ? raw.trim() : null;
}

export function looksLikeAverageBaselineFollowUp(normalized: string): boolean {
  return /\b(that|it|this)\b/.test(normalized)
    && (
      (/\b(above|below|higher|lower|over|under)\b/.test(normalized) && /\baverage|normal|usual\b/.test(normalized))
      || /\b(normal|usual|typical|expected|okay|ok|alright|fine)\b/.test(normalized)
    );
}

export function looksLikeCurrentPowerRankingFollowUp(normalized: string): boolean {
  return !hasMetricTimeWindow(normalized) && !looksLikeConversationRepair(normalized) && ((
    /\b(it|that|this)\b/.test(normalized)
      && /\b(what|which|who|show|tell|using|use|drawing|draw|pulling|pull|taking|take)\b/.test(normalized)
      && (
        /\b(using|use|drawing|draw|pulling|pull|taking|take)\b/.test(normalized)
        || /\b(most|least|biggest|smallest|highest|lowest|top|bottom|main|largest|heaviest|lightest|rank|ranking)\b/.test(normalized)
      )
  ) || /^what about (?:the )?(?:most|least|biggest|smallest|highest|lowest|top|bottom|main|largest|heaviest|lightest)(?: (?:one|power|load|loads|draw|draws))?$/.test(normalized));
}

export function looksLikeRankedCurrentPowerOrdinalFollowUp(normalized: string): boolean {
  if (/\b(?:alphabetic(?:al|ally)?|mention(?:ed)?|said|asked|conversation|wording|list order|original order)\b/.test(normalized)) {
    return false;
  }
  return /\b(?:which|what)\s+(?:one|load|device|source)\b.*\b(?:first|top|biggest|highest|most)\b/.test(normalized)
    || /\b(?:first|top|biggest|highest)\s+(?:one|load|device|source)\b/.test(normalized);
}

export function looksLikeCurrentPowerSourceClarifierFollowUp(normalized: string): boolean {
  return !hasMetricTimeWindow(normalized)
    && /\bsources?\b/.test(normalized)
    && /\b(what|which|first|top|biggest|highest|most|main)\b/.test(normalized)
    && (
      looksLikeCompactCurrentPowerSourceReference(normalized)
      || looksLikeCorrectionFollowUp(normalized)
      || /^what about\b/.test(normalized)
      || /^and\b/.test(normalized)
      || hasPronounFollowUp(normalized)
    );
}

function looksLikeCompactCurrentPowerSourceReference(normalized: string): boolean {
  return /^(?:(?:the )?(?:first|top|main|biggest|highest|most) source|which source(?: is)? (?:first|top|main)|what source(?: is)? (?:first|top|main)|which source(?: is)? using (?:the )?most|what source(?: is)? using (?:the )?most)\??$/.test(normalized);
}

export function followUpTargetText(normalized: string): string | null {
  const focusShiftTarget = explicitFocusShiftTargetText(normalized);
  if (focusShiftTarget) {
    return focusShiftTarget;
  }
  const raw = followUpContentText(normalized) ?? "";
  const target = cleanTargetText(raw, "status");
  return target;
}

export function canonicalizeCompactFollowUpText(normalized: string): string {
  return normalized
    .replace(/^and\s+what about\s+/, "what about ")
    .replace(/^they are still (on|off|open|closed|locked|unlocked|active|inactive|running)(?: right)?$/, "are they still $1")
    .replace(/^same thing[, ]+still\s+(on|off|open|closed|locked|unlocked|active|inactive|running)\??$/i, "is it still $1")
    .replace(/^same thing[, ]+(on|off|open|closed|locked|unlocked|active|inactive|running)\??$/i, "is it $1")
    .replace(/^(?:and\s+)?(it|that|this)\s+(?:is|was)\s+(on|off|open|closed|locked|unlocked|active|inactive|running)\??$/i, "is $1 $2")
    .replace(/^(?:and\s+)?(they|those|these)\s+(?:are|were)\s+(on|off|open|closed|locked|unlocked|active|inactive|running)\??$/i, "are $1 $2")
    .replace(/^(?:locked|unlocked)\s+up\??$/i, (match) => `is it ${match.replace(/\?+$/g, "").replace(/\s+up$/i, "").toLowerCase()}`)
    .replace(/^left\s+(open|closed|on|off|locked|unlocked)\??$/i, "is it $1")
    .replace(/^(?:that|this) one(?:\s+as well)?\??$/i, "what is that")
    .replace(/^(?:same(?:\s+for)?|same)\s+(.+?)\??$/i, "what about $1")
    .replace(/^(?:check|show me|tell me|give me)\s+(that|it|this)\s+too\??$/i, "what about $1")
    .replace(new RegExp(String.raw`^(?:check|show me|tell me|give me)\s+((?:for\s+)?(?:today|tonight|tomorrow|yesterday|${WEEKDAY_PATTERN}))(?:\s+too)?\??$`, "i"), "what about $1")
    .replace(/^(.+?)\s+as well\??$/i, "what about $1")
    .replace(new RegExp(String.raw`^(?:for\s+)?((?:${WEEKDAY_PATTERN}))(?:\s+(?:too|as well))?\??$`, "i"), "what about for $1")
    .replace(/^(?:for\s+)?((?:today|tonight|tomorrow|yesterday))(?:\s+(?:too|as well))?\??$/i, "what about $1")
    .replace(/^(it|that|this)\s+is\s+still\s+(on|off|open|closed|locked|unlocked|active|inactive|running)\??$/i, "is $1 still $2")
    .replace(/^(?:it\s+s|its)\s+still\s+(on|off|open|closed|locked|unlocked|active|inactive|running)\??$/i, "is it still $1")
    .replace(/^(?:that\s+s|thats)\s+still\s+(on|off|open|closed|locked|unlocked|active|inactive|running)\??$/i, "is that still $1")
    .replace(/^(?:this\s+s)\s+still\s+(on|off|open|closed|locked|unlocked|active|inactive|running)\??$/i, "is this still $1")
    .replace(/^(?:still)\s+(on|off|open|closed|locked|unlocked|active|inactive|running)\??$/i, "is it still $1")
    .replace(/^(?:compared with)\s+(.+?)(?:,)?\s+(higher|lower|more|less|greater)\??$/i, "is that $2 than $1")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksLikeImplicitWeatherConditionFollowUp(normalized: string): boolean {
  return /^(?:and\s+)?if\s+(?:that|this|it)\s+happens\??$/.test(normalized)
    || /^(?:and\s+)?if\s+so\??$/.test(normalized);
}

export function looksLikeCompactOutdoorClothingFollowUp(normalized: string): boolean {
  return /^(?:so|and|what about)\s*,?\s*(?:a |an |the )?(?:jacket|jumper|coat|layers?)\??$/.test(normalized)
    || /^(?:a |an |the )?(?:jacket|jumper|coat|layers?)\??$/.test(normalized)
    || /\b(?:saved|remembered|my)\b.*\b(?:cutoff|threshold|jacket rule|clothing rule)\b/.test(normalized);
}

export function isGenericFollowUpTargetReference(value: string | null): boolean {
  if (!value) {
    return true;
  }
  const reference = classifyDemonstrativeTarget(value);
  return reference.kind === "contextual" || reference.kind === "underspecified";
}

export function followUpDynamicMetricTargetText(normalized: string, now: Date): string | null {
  const raw = followUpContentText(normalized);
  if (!raw) {
    return null;
  }
  const target = normalizeDynamicMetricTargetText(raw, now);
  return target || null;
}

export function explicitFollowUpQuestionText(normalized: string): string | null {
  const raw = canonicalizeLeadingQuestionContractions(followUpContentText(normalized)?.trim() ?? "");
  if (!raw || /^(?:that|it|this)\b/.test(raw)) {
    return null;
  }
  return raw;
}

export function looksLikeCorrectionFollowUp(normalized: string): boolean {
  return followUpCorrectionText(normalized) !== null;
}

export function looksLikeContextualDomainFragment(normalized: string): boolean {
  return new RegExp(String.raw`^(?:${FOLLOW_UP_OPENER_PATTERN}|same for)\b`).test(normalized)
    || (/\b(?:too|as well|instead)\b$/.test(normalized) && spokenWordCount(normalized) <= FOLLOW_UP_FRAGMENT_MAX_WORDS + 2);
}

export function followUpContentText(normalized: string): string | null {
  const direct = new RegExp(String.raw`^${FOLLOW_UP_OPENER_PATTERN}\s+(.+?)\??$`).exec(normalized)?.[1];
  if (direct) {
    return direct.trim();
  }
  // "the office too" is a follow-up; a whole spoken sentence that happens to end in "as well" is not.
  const additive = /^(.+?)\s+too\??$/.exec(normalized)?.[1];
  if (additive && spokenWordCount(additive) <= FOLLOW_UP_FRAGMENT_MAX_WORDS) {
    return additive.trim();
  }
  const additiveAsWell = /^(.+?)\s+as well\??$/.exec(normalized)?.[1];
  if (additiveAsWell && spokenWordCount(additiveAsWell) <= FOLLOW_UP_FRAGMENT_MAX_WORDS) {
    return additiveAsWell.trim();
  }
  return followUpCorrectionText(normalized);
}

function followUpCorrectionText(normalized: string): string | null {
  const raw = /^(?:no[, ]+|nah[, ]+|sorry[, ]+|i meant\s+|i mean\s+|meant\s+|mean\s+|(?:no\s+)?i was asking(?:\s+(?:about|for))?\s+)(.+?)\??$/.exec(normalized)?.[1] ?? "";
  const text = raw.trim();
  return text || null;
}

export function looksLikeStandaloneRestatedRequest(normalized: string): boolean {
  return /^(?:what|which|who|when|where|why|how|is|are|was|were|do|does|did|can|could|would|should|has|have|tell|show|check|play|set|turn|switch|lock|unlock|open|close|explain|define|describe)\b/.test(normalized);
}

export function declinedContextReference(route: BasicRoute, text: string, notes: string): BasicResult {
  return {
    ...declined(route, text, notes),
    readFallback: {
      eligible: false,
      reason: "context_reference_unresolved",
    },
  };
}
