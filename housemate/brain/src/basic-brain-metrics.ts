import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AliasEntry } from "./alias-schema.js";
import type { ComparisonWindowPair, DynamicMetricContextData } from "./basic-brain-contracts.js";
import type { BasicSpeechRenderPlan } from "./basic-speech-response.js";
import type { HaHistoryFetcher, HaHistoryResult, HaStatisticPeriod } from "./ha-history.js";
import type { HaRegistryIndex } from "./ha-registry-index.js";
import type { HaEntityState, HaStateCache } from "./ha-state-cache.js";
import { buildWindowedEnergyUsedResult, calculateEnergyFromPower, calculateMetricAggregation, compareMetricValues, type MetricAggregation, type MetricMathOk, type MetricPoint } from "./math-calculator.js";
import { metricById, parseMetricCatalog, resolveMetric, type MetricCatalog, type MetricDefinition } from "./metric-catalog.js";
import { normalizeRoutingText as normalize, targetTextKey as normalizeTargetText } from "./routing-text.js";
import { targetResolverFor, type TargetResolver, type TargetResolverMatch } from "./target-resolver.js";
import { parseTimeWindow, type TimeWindow } from "./time-window-parser.js";
import { capitalize, escapeRegExp } from "./text-format.js";
import { declined, ok } from "./basic-brain-contracts.js";
import { hourInTimezone, zonedDateTimeParts, zonedTimeToUtc } from "./zoned-time.js";
import { isUnavailableState } from "./ha-state-cache.js";
import {
  DEVICE_STATUS_PATTERN,
  firstStateWord,
  NOW_PATTERN,
  POWER_LOAD_PATTERN,
  POWER_USE_WORD,
} from "./lexicon.js";
import { HOUSE_LOCALE, HOUSE_TIME_ZONE, houseConfig, houseDataPath } from "./house-config.js";
import { discoveredHouse, discoveryRevision } from "./house-discovery.js";

export interface MetricRouteServices {
  readonly stateCache?: HaStateCache;
  readonly registry?: HaRegistryIndex;
  readonly aliases?: readonly AliasEntry[];
  readonly historyFetcher?: Pick<HaHistoryFetcher, "fetchBest"> & Partial<Pick<HaHistoryFetcher, "fetchHistory" | "fetchStatistics">>;
}

export const DYNAMIC_COMPOSED_METRIC_ID = "__dynamic_composed__";

export type { ComparisonWindowPair, DynamicMetricContextData } from "./basic-brain-contracts.js";

type HistoricalMetricOperation = "energy_delta" | "average" | "maximum" | "minimum" | "energy_from_power";
type MetricRoute = "time_window_math" | "energy_budget";
type MetricStatus = "ok" | "declined";
type MetricConfidence = "high" | "low";
type EnergyBudgetSpeechMode = Extract<BasicSpeechRenderPlan, { kind: "energy_budget" }>["mode"];

export interface MetricIntentFrame {
  readonly measure: "power" | "energy" | "water" | "gas" | "temperature" | null;
  readonly timeframe: "current" | "history";
  readonly aggregation: "average" | "maximum" | "minimum" | "total" | null;
  readonly flow: "import" | "export" | "net" | null;
  readonly ranking: {
    readonly direction: "ascending" | "descending";
    readonly collection: boolean;
  } | null;
  readonly asksForReading: boolean;
}

type MetricContextFrame =
  | { readonly kind: "energy_budget"; readonly monthIndex: number }
  | { readonly kind: "current_power_ranking"; readonly metricId: string; readonly direction: "ascending" | "descending" }
  | { readonly kind: "current_metric"; readonly metricId: string; readonly composed?: DynamicMetricContextData | null }
  | { readonly kind: "history_metric"; readonly metricId: string; readonly window: TimeWindow; readonly composed?: DynamicMetricContextData | null }
  | { readonly kind: "comparison_metric"; readonly metricId: string; readonly windows: ComparisonWindowPair; readonly composed?: DynamicMetricContextData | null };

export interface MetricRouteResult {
  readonly route: MetricRoute;
  readonly status: MetricStatus;
  readonly confidence: MetricConfidence;
  readonly text: string;
  readonly speechPlan?: BasicSpeechRenderPlan | null;
  readonly modelUsed: false;
  readonly resultId: null;
  readonly touchedEntities: readonly string[];
  readonly notes: string;
  readonly contextFrame?: MetricContextFrame | null;
}

interface HistoricalMetricOk {
  readonly status: "ok";
  readonly value: number;
  readonly unit: string | null;
  readonly sampleCount: number;
  readonly notes: readonly string[];
}

interface HistoricalMetricDeclined {
  readonly status: "declined";
  readonly reason: string;
}

type HistoricalMetricResult = HistoricalMetricOk | HistoricalMetricDeclined;

interface HistoricalMetricCohort {
  readonly label: string;
  readonly values: readonly number[];
}

interface EnergyBudgetReading {
  readonly monthIndex: number;
  readonly monthKey: string;
  readonly monthLabel: string;
  readonly isCurrent: boolean;
  readonly budget: number;
  readonly actual: number | null;
  readonly used: number | null;
  readonly remaining: number | null;
  readonly percentUsed: number | null;
  readonly trackingRatio: number | null;
  readonly projected: number | null;
  readonly projectionDelta: number | null;
  readonly dailyTarget: number | null;
  readonly risk: string | null;
  readonly reason: string | null;
  readonly label: string | null;
  readonly selectedSource: string | null;
  readonly sourceStatus: string | null;
  readonly reportAgeMinutes: number | null;
  readonly rawAgeMinutes: number | null;
  readonly reportedFormula: number | null;
  readonly integratedPower: number | null;
  readonly formulaParts: {
    readonly pv: number | null;
    readonly grid: number | null;
    readonly batteryDischarge: number | null;
    readonly feedin: number | null;
    readonly batteryCharge: number | null;
  };
  readonly suggestedCap: number | null;
  readonly history: readonly EnergyBudgetHistoryRow[];
  readonly sourceEntities: readonly string[];
}

interface EnergyBudgetHistoryRow {
  readonly year: number;
  readonly kwh: number;
  readonly note?: string;
}

interface DynamicMetricMember {
  readonly label: string;
  readonly mode: "energy" | "power";
  readonly statisticIds: readonly string[];
  readonly fallbackEntityIds: readonly string[];
  readonly sourceEntityIds: readonly string[];
  readonly deviceId: string | null;
}

interface DynamicMetricTargetSource {
  readonly phrase: string;
  readonly label: string;
  readonly members: readonly DynamicMetricMember[];
}

interface DynamicMetricComposition {
  readonly subjectLabel: string;
  readonly targetPhrases: readonly string[];
  readonly targets: readonly DynamicMetricTargetSource[];
}

const DEFAULT_TIMEZONE = HOUSE_TIME_ZONE;
const SPARSE_POWER_ESTIMATE_MAX_WINDOW_MS = 15 * 60 * 1000;

const ENERGY_BUDGET_MONTHS = [
  { key: "january", short: "jan", label: "January" },
  { key: "february", short: "feb", label: "February" },
  { key: "march", short: "mar", label: "March" },
  { key: "april", short: "apr", label: "April" },
  { key: "may", short: "may", label: "May" },
  { key: "june", short: "jun", label: "June" },
  { key: "july", short: "jul", label: "July" },
  { key: "august", short: "aug", label: "August" },
  { key: "september", short: "sep", label: "September" },
  { key: "october", short: "oct", label: "October" },
  { key: "november", short: "nov", label: "November" },
  { key: "december", short: "dec", label: "December" },
] as const;

const ENERGY_BUDGET_SUGGESTED_CAPS = [915, 888, 620, 515, 540, 565, 550, 540, 435, 470, 525, 637] as const;

const ENERGY_BUDGET_REPOSIT_HISTORY: Readonly<Record<string, readonly EnergyBudgetHistoryRow[]>> = {
  january: [{ year: 2025, kwh: 921 }, { year: 2026, kwh: 300, note: "partial" }],
  february: [{ year: 2025, kwh: 893 }, { year: 2026, kwh: 537, note: "partial" }],
  march: [{ year: 2025, kwh: 730 }, { year: 2026, kwh: 469 }],
  april: [{ year: 2025, kwh: 506 }, { year: 2026, kwh: 156, note: "current" }],
  may: [{ year: 2025, kwh: 526 }],
  june: [{ year: 2025, kwh: 555 }],
  july: [{ year: 2025, kwh: 541 }],
  august: [{ year: 2025, kwh: 530 }],
  september: [{ year: 2025, kwh: 416 }],
  october: [{ year: 2024, kwh: 510 }, { year: 2025, kwh: 393 }],
  november: [{ year: 2024, kwh: 686 }, { year: 2025, kwh: 390 }],
  december: [{ year: 2024, kwh: 827 }, { year: 2025, kwh: 481 }],
};

let cachedMetricCatalog: { readonly revision: number; readonly catalog: MetricCatalog | null } | undefined;

export function looksLikeCurrentPowerRankingQuestion(normalized: string): boolean {
  const frame = parseMetricIntentFrame(normalized);
  return frame.timeframe === "current" && frame.measure === "power" && frame.ranking !== null;
}

const ENERGY_PROJECTION_LANGUAGE = /\b(projected|projection|finish|tracking|track|pace|burning through|too quickly|over or under|point in the month)\b/;

/**
 * A forecast ("what will this month finish at if this keeps going?") asks
 * where a period will end up. History can only read what has happened, so the
 * budget projection owns it even when a history reading is in context.
 */
export function looksLikeEnergyProjectionQuestion(normalized: string): boolean {
  return ENERGY_PROJECTION_LANGUAGE.test(normalized) && looksLikeEnergyBudgetQuestion(normalized);
}

export function looksLikeEnergyBudgetQuestion(normalized: string): boolean {
  if (/\b(right now|currently|at the moment|watts?|kw|power draw|drawing|load)\b/.test(normalized)
    && !/\b(allowance|budget|cap|limit|headroom|reposit|foxess|no bill|monthly|month|billing month|remaining|left|projected|projection|forecast|pace|track|tracking|over|under)\b/.test(normalized)) {
    return false;
  }
  if (hasMetricTimeWindow(normalized)
    && !/\b(allowance|budget|cap|limit|headroom|reposit|foxess|no bill|monthly|month|billing month|remaining|left|projected|projection|forecast|pace|track|tracking|over|under|daily|per day|source|formula|history|historical|last year|suggested|recommended)\b/.test(normalized)) {
    return false;
  }
  const hasMonth = hasEnergyBudgetMonthName(normalized) || /\b(this|current|next|last|previous|billing) month\b/.test(normalized);
  const hasBudgetSubject = /\b(allowance|budget|cap|limit|headroom|no bill|reposit|foxess|monthly kwh|monthly usage|monthly energy|monthly electricity|electricity budget|energy budget|power budget)\b/.test(normalized);
  const hasBudgetAsk = /\b(about|overview|summary|used|use|using|left|remaining|remain|projected|projection|forecast|finish|pace|track|tracking|going|risk|over|under|daily|per day|status|source|healthy|recent|fresh|formula|calculate|calculation|count|counts|history|historical|last year|suggested|recommended|percentage|percent|spare)\b/.test(normalized);
  const formulaComponent = looksLikeEnergyBudgetFormulaComponentQuestion(normalized);
  const namedBudgetSignal = /\b(daily target|daily allowance|per day target|need per day|need each day|rest of (?:the )?month|billing month)\b/.test(normalized);
  const projectionSignal = ENERGY_PROJECTION_LANGUAGE.test(normalized);
  const projectionOnlySignal = /\b(projected|projection)\b/.test(normalized) && /\b(over|under|risk|finish)\b/.test(normalized);
  const namedMonthProjectionSignal = hasEnergyBudgetMonthName(normalized)
    && /\b(projected|projection|finish|tracking|track|pace|over|under)\b/.test(normalized);
  const sourceSignal = /\b(monthly usage|usage reading|foxess usage|reposit usage|usage source)\b/.test(normalized)
    && /\b(source|healthy|recent|fresh|status|reading)\b/.test(normalized);
  const householdScope = /\b(?:we|our|my|house|home)\b/.test(normalized);
  const monthBudgetSignal = hasMonth
    && householdScope
    && /\b(kwh|electricity|energy|power|usage|used|left|remaining|headroom|allowance|budget|cap|limit|history|historical|last year|projected|projection|forecast|finish|per day)\b/.test(normalized);
  const currentMonthAllowance = /\b(electricity|energy|kwh)\b/.test(normalized)
    && /\b(this month|monthly|month|rest of)\b/.test(normalized)
    && /\b(allowance|budget|cap|limit|headroom|left|remaining|projected|forecast|over|under|pace|track)\b/.test(normalized);
  return formulaComponent
    || sourceSignal
    || namedBudgetSignal
    || projectionOnlySignal
    || namedMonthProjectionSignal
    || (projectionSignal && (hasBudgetSubject || /\b(allowance|budget|headroom|month|billing month|reposit|electricity|power)\b/.test(normalized)))
    || (hasBudgetSubject && (hasBudgetAsk || /\b(what|how much|am i|are we|is it|do we|can i|will i)\b/.test(normalized)))
    || monthBudgetSignal
    || currentMonthAllowance;
}

export function looksLikeEnergyBudgetFollowUp(normalized: string): boolean {
  const prefixed = /^(?:and |what about |how about |so |then )/.test(normalized)
    && /\b(allowance|budget|cap|limit|remaining|left|projected|projection|forecast|pace|track|risk|over|under|daily|per day|source|formula|foxess|reposit|history|historical|last year|suggested|recommended)\b/.test(normalized);
  const monthHistory = hasEnergyBudgetMonthName(normalized) && /\b(history|historical|last year|previous year)\b/.test(normalized);
  return prefixed || monthHistory;
}

export function looksLikeHistoryMetricQuestion(normalized: string): boolean {
  const frame = parseMetricIntentFrame(normalized);
  return frame.timeframe === "history" && frame.measure !== null && frame.asksForReading;
}

export function looksLikeComparisonMetricQuestion(normalized: string): boolean {
  return /\b(compare|compared|difference|more than|less than|higher than|lower than|versus|vs|beat|beats)\b/.test(normalized)
    || /\b(more|less|higher|lower|greater)\b.*\bthan\b/.test(normalized)
    || /\btoday\b.*\byesterday\b|\byesterday\b.*\btoday\b/.test(normalized);
}

export function looksLikeStandaloneTimeWindowFollowUp(normalized: string, window: TimeWindow | null): boolean {
  if (!window) {
    return false;
  }
  return normalized === window.label
    || normalized === `the ${window.label}`
    || new RegExp(`^for (?:the )?${escapeRegExp(window.label)}\\??$`).test(normalized)
    || normalized === "weekend";
}

export function resolveTimeWindowFromQuestion(transcript: string, now: Date): TimeWindow | null {
  const intentText = metricIntentText(normalize(transcript));
  if (/\bsince midnight\b/.test(intentText)) {
    const today = parseTimeWindow("today", { now, timezone: DEFAULT_TIMEZONE });
    if (today.status === "matched" && today.window) {
      return today.window;
    }
  }
  const tokens = intentText.split(" ").filter(Boolean);
  const candidates: string[] = [];
  for (let start = 0; start < tokens.length; start += 1) {
    for (let length = 1; length <= Math.min(8, tokens.length - start); length += 1) {
      candidates.push(tokens.slice(start, start + length).join(" "));
    }
  }
  const uniqueCandidates = [...new Set(candidates)].sort((left, right) => right.length - left.length);
  for (const candidate of uniqueCandidates) {
    const parsed = parseTimeWindow(candidate, { now, timezone: DEFAULT_TIMEZONE });
    if (parsed.status === "matched" && parsed.window) {
      return parsed.window;
    }
  }
  return null;
}

export function defaultMetricCatalog(): MetricCatalog | null {
  if (cachedMetricCatalog?.revision !== discoveryRevision()) {
    cachedMetricCatalog = { revision: discoveryRevision(), catalog: loadMetricCatalog() };
  }
  return cachedMetricCatalog.catalog;
}

/** The house's own energy and power metrics (<dataDir>/house-metrics.json), else the ones discovery built from its Energy dashboard. */
function loadMetricCatalog(): MetricCatalog | null {
  try {
    return parseMetricCatalog(JSON.parse(readFileSync(houseDataPath("house-metrics.json", "JARVIS_V5_HOUSE_METRICS_FILE"), "utf8")));
  } catch {
    const discovered = discoveredHouse()?.metrics;
    try {
      return discovered ? parseMetricCatalog(discovered) : null;
    } catch {
      return null;
    }
  }
}

export function defaultMetricById(metricId: string): MetricDefinition | null {
  const catalog = defaultMetricCatalog();
  return catalog ? metricById(catalog, metricId) : null;
}

export function resolveFollowUpMetricTarget(targetText: string): MetricDefinition | null {
  const catalog = defaultMetricCatalog();
  if (!catalog) {
    return null;
  }
  const clean = normalizeTargetText(targetText);
  const withoutMetricNoun = clean.replace(/\b(?:power|energy|usage|use|load|loads)\b/g, " ").replace(/\s+/g, " ").trim();
  const candidates = [
    clean,
    `${clean} usage`,
    `${clean} power`,
    withoutMetricNoun,
    `${withoutMetricNoun} usage`,
    `${withoutMetricNoun} power`,
    ...followUpMetricAliasCandidates(clean),
    ...followUpMetricAliasCandidates(withoutMetricNoun),
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    const metric = resolveMetric(catalog, candidate) ?? resolveSpokenMetricQuestion(catalog, candidate);
    if (metric) {
      return metric;
    }
  }
  return null;
}

/** Resolve a named metric subject embedded in conversational scaffolding.
 * Measurement and time slots are deliberately left to the caller. */
export function resolveMentionedMetric(text: string): MetricDefinition | null {
  const catalog = defaultMetricCatalog();
  if (!catalog) {
    return null;
  }
  const normalized = normalize(text);
  const flow = metricFlowFromText(normalized);
  if (flow && /\bgrid\b/.test(normalized)) {
    return metricById(catalog, flow === "export"
      ? "grid_export_energy"
      : flow === "import"
        ? "grid_import_energy"
        : "grid_net_import_energy");
  }
  const ranked = catalog.metrics
    .map((metric) => {
      const score = [metric.label, ...metric.aliases]
        .map((phrase) => normalize(phrase))
        .filter((phrase) => phrase.length >= 3)
        .reduce((best, phrase) => {
          if (!new RegExp(`(?:^| )${escapeRegExp(phrase)}(?: |$)`).test(normalized)) {
            return best;
          }
          return Math.max(best, phrase.split(/\s+/).length * 100 + phrase.length);
        }, 0);
      return { metric, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);
  return ranked.length > 0 && (ranked.length === 1 || ranked[0]!.score > ranked[1]!.score)
    ? ranked[0]!.metric
    : null;
}

function followUpMetricAliasCandidates(value: string): readonly string[] {
  if (!value) {
    return [];
  }
  if (value === "grid") {
    return ["grid import", "grid usage"];
  }
  return [];
}

export function resolveMetricQuestion(normalized: string): MetricDefinition | null {
  const intentText = metricIntentText(normalized);
  if (!looksLikeMetricWording(intentText)) {
    return null;
  }
  if (looksLikeStateOnlyQuestionWithMetricContext(intentText)) {
    return null;
  }
  if (looksLikeMetricWordStatusTarget(intentText)) {
    return null;
  }
  const catalog = defaultMetricCatalog();
  if (!catalog) {
    return null;
  }
  const frame = parseMetricIntentFrame(intentText);
  if (frame.flow) {
    const flowMetricId = frame.flow === "export"
      ? "grid_export_energy"
      : frame.flow === "import"
        ? "grid_import_energy"
        : "grid_net_import_energy";
    const flowMetric = metricById(catalog, flowMetricId);
    if (flowMetric) {
      return flowMetric;
    }
  }
  const metricText = normalizedMetricQuestionText(intentText);
  const metricTextWithoutUnit = metricText.replace(new RegExp(String.raw`\b${POWER_LOAD_PATTERN}\b`, "g"), " ").replace(/\s+/g, " ").trim();
  const exact = resolveMetric(catalog, metricText)
    ?? resolveMetric(catalog, metricTextWithoutUnit)
    ?? resolveMetric(catalog, intentText);
  if (exact) {
    return exact;
  }
  const spoken = resolveSpokenMetricQuestion(catalog, intentText);
  if (spoken) {
    return spoken;
  }
  const matches = catalog.metrics.filter((metric) => metricCompatibleWithQuestion(intentText, metric) && metricTextMatchesMetric(intentText, metric));
  if (matches.length === 1) {
    return matches[0] as MetricDefinition;
  }
  return resolveCurrentPowerMetricBySubject(catalog, intentText);
}

export function hasMetricTimeWindow(normalized: string): boolean {
  const text = metricIntentText(normalized).replace(/\bat the minute\b/g, " ");
  return /\b(last|past|previous|yesterday|today|this morning|this afternoon|this evening|tonight|midnight|seconds?|minutes?|hours?|days?|weeks?|months?)\b/.test(text);
}

export function hasIncompleteMetricTimeWindow(normalized: string): boolean {
  const text = metricIntentText(normalized).trim();
  const finalToken = /([a-z]+)$/.exec(text)?.[1] ?? "";
  if (finalToken.length < 4) {
    return false;
  }
  const incompleteWindow = [
    "yesterday",
    "today",
    "tonight",
    "tomorrow",
    "morning",
    "afternoon",
    "evening",
    "midnight",
    "second",
    "minute",
    "hour",
    "week",
    "month",
  ].some((candidate) => candidate !== finalToken && candidate.startsWith(finalToken));
  return incompleteWindow && parseMetricIntentFrame(text).measure !== null;
}

/**
 * Parse the stable semantic slots shared by current readings, history and power
 * rankings. The surface wording is deliberately kept separate from the subject
 * resolver below: "office watts" and "what is the office drawing" describe the
 * same frame even though they share almost no question scaffolding.
 */
export function parseMetricIntentFrame(normalized: string): MetricIntentFrame {
  const intentText = metricIntentText(normalized);
  const history = hasMetricTimeWindow(intentText);
  const flow = metricFlowFromText(intentText);
  const consumption = POWER_USE_WORD.test(intentText);
  const explicitEnergy = /\b(?:energy|kwh|kilowatt[ -]?hours?|watt[ -]?hours?)\b/.test(intentText)
    || (history && (consumption || /\b(?:exported|imported|generated|produced|production)\b/.test(intentText)));
  const explicitPower = /\b(?:power|wattage|watts?|kw|kilowatts?|loads?|draw|drawing|pull|pulled|pulling|output)\b/.test(intentText);
  const electricity = /\belectricity\b/.test(intentText);
  const solarSubject = /\b(?:solar|pv|panels?)\b/.test(intentText);
  const historicalIndoorTemperature = history
    && /\b(?:temperature|temp|degrees?|celsius|fahrenheit)\b/.test(intentText)
    && !/\b(?:weather|forecast|outside|outdoor)\b/.test(intentText);
  const readingMeasure: MetricIntentFrame["measure"] = historicalIndoorTemperature
    ? "temperature"
    : /\b(?:water|litres?|liters?)\b/.test(intentText)
    ? "water"
    : /\bgas\b/.test(intentText)
      ? "gas"
      : explicitEnergy || (flow !== null && history) || (electricity && history) || (solarSubject && history)
        ? "energy"
        : explicitPower || electricity || /\b(?:using|use|consumption|consume|consumed|consuming|making|generate|generated|generating|generation|produce|produced|producing|putting out)\b/.test(intentText)
          || (solarSubject && /\b(?:current|currently|live|now)\b/.test(intentText))
          ? "power"
          : null;
  const aggregation: MetricIntentFrame["aggregation"] = /\b(?:average|mean|usual|normally|typical)\b/.test(intentText)
    ? "average"
    : /\b(?:maximum|max|peak|highest)\b/.test(intentText)
      ? "maximum"
      : /\b(?:minimum|min|lowest)\b/.test(intentText)
        ? "minimum"
        : /\b(?:total|altogether)\b/.test(intentText)
          ? "total"
          : null;
  const orderedDirection = /\bfrom (highest|largest|biggest|most|heaviest|top|lowest|smallest|least|lightest|bottom) to (highest|largest|biggest|most|heaviest|top|lowest|smallest|least|lightest|bottom)\b/.exec(intentText);
  const ascending = orderedDirection
    ? /^(?:lowest|smallest|least|lightest|bottom)$/.test(orderedDirection[1] ?? "")
    : /\b(?:least|smallest|lowest|bottom|lightest|barely)\b/.test(intentText);
  const descending = orderedDirection
    ? /^(?:highest|largest|biggest|most|heaviest|top)$/.test(orderedDirection[1] ?? "")
    : /\b(?:most|biggest|highest|top|main|largest|heaviest)\b/.test(intentText);
  const rankingVerb = /\b(?:rank|ranking|list)\b/.test(intentText) || /\bbreak(?:ing)?\s+down\b|\bbreakdown\b/.test(intentText);
  const collectionSubject = /\b(?:users?|devices?|appliances?|things?|rooms?|circuits?|sources?|loads?)\b/.test(intentText);
  const pluralCollectionSubject = /\b(?:users|devices|appliances|things|rooms|circuits|sources|loads)\b/.test(intentText);
  const collectionAsk = (pluralCollectionSubject && /^(?:what|which|who|show|list|rank|break)\b/.test(intentText))
    || (collectionSubject && /\b(?:what|which|who)\b.*\b(?:using|drawing|pulling|consuming)\b/.test(intentText));
  const openContributorAsk = /^(?:what|which|who)(?:\s+(?:s|is|are))?\s+(?:currently\s+)?(?:using|drawing|pulling|taking|consuming)\b.*\b(?:power|electricity|load)\b/.test(intentText);
  const ellipticalExtreme = /^(?:using|drawing|pulling|taking|consuming)\s+(?:the\s+)?(?:most|least|biggest|smallest|highest|lowest|top|bottom|main|largest|heaviest|lightest|barely)\b/.test(intentText);
  // "Is there a particular device causing that usage?" asks which load is
  // behind the reading: a cause verb, a load subject, and a power/usage word.
  const causeAsk = /\b(?:causing|behind|responsible for|driving)\b/.test(intentText)
    && (collectionSubject || /^(?:what|which|who)\b/.test(intentText))
    && /\b(?:usage|use|using|power|load|draw|drawing|electricity|consumption|watts?)\b/.test(intentText);
  // Its usage word means the live draw, so the measure is power.
  const measure: MetricIntentFrame["measure"] = readingMeasure ?? (causeAsk && !history ? "power" : null);
  const ranking = (measure === "power" || measure === null) && !history && (ascending || descending || rankingVerb || collectionAsk || openContributorAsk || ellipticalExtreme || causeAsk)
    ? {
      direction: ascending ? "ascending" as const : "descending" as const,
      collection: rankingVerb || pluralCollectionSubject || (openContributorAsk && !ascending && !descending),
    }
    : null;
  const explicitAsk = /\b(?:what|whats|how much|how many|which|who|check|read|show|give|tell|current|currently|present|live|now|status|average|mean|usual|total|compare|compared|did|does|do|has|have|is|are|was|were|rank|list|break)\b/.test(intentText);
  const compactReading = measure !== null && intentText.split(/\s+/).length <= 5;
  return {
    measure,
    timeframe: history ? "history" : "current",
    aggregation,
    flow,
    ranking,
    asksForReading: explicitAsk || compactReading || (history && measure !== null),
  };
}

function metricIntentText(normalized: string): string {
  const contrast = /\b(?:rather than|instead of|not)\b/.exec(normalized);
  if (!contrast || contrast.index === 0) {
    return normalized;
  }
  const preferred = normalized.slice(0, contrast.index).replace(/[,:;\s]+$/g, "").trim();
  return preferred || normalized;
}

function metricFlowFromText(normalized: string): MetricIntentFrame["flow"] {
  const grid = /\bgrid\b/.test(normalized);
  if ((/\b(?:net|balance|balanced)\b/.test(normalized)
      && /\b(?:grid|import|export|electricity|energy)\b/.test(normalized))
    || (grid && /\b(?:after|minus|less)\b[\s\S]*\bexport\b/.test(normalized))
    || (/\b(?:import|imports|imported|importing|usage|use|used|consumption)\b/.test(normalized)
      && /\b(?:after|minus|less)\b[\s\S]*\bexport\b/.test(normalized))) {
    return "net";
  }
  const exported = /\b(?:export|exported|feed[ -]?in|fed in|returned|sold)\b/.test(normalized)
    || /\b(?:send|sent|push|pushed)\b.*\b(?:out|back|grid)\b/.test(normalized);
  if (exported) {
    return "export";
  }
  const acquisition = /\b(?:import|imports|imported|importing|buy|buys|bought|buying)\b/.test(normalized);
  const directionalAcquisition = /\b(?:draw|draws|drawing|drawn|pull|pulls|pulling|pulled|take|takes|taking|taken|took|come|comes|coming|came)\b[\s\S]*\bfrom (?:the )?grid\b/.test(normalized);
  const gridConsumption = grid
    && POWER_USE_WORD.test(normalized);
  const gridSupply = grid && /\b(?:supply|supplies|supplied|supplying|provide|provides|provided|providing)\b/.test(normalized);
  const imported = acquisition || directionalAcquisition || gridConsumption || gridSupply;
  return imported ? "import" : null;
}

export async function dynamicMetricAnswer(
  transcript: string,
  normalized: string,
  routes: MetricRouteServices,
  now: () => Date,
): Promise<MetricRouteResult | null> {
  if (!looksLikeMetricWording(normalized)
    || looksLikeCurrentPowerRankingQuestion(normalized)
    || looksLikeStateOnlyQuestionWithMetricContext(normalized)
    || looksLikeMetricWordStatusTarget(normalized)) {
    return null;
  }
  const targetPhrases = resolveDynamicTargetPhraseList(transcript, normalized, now());
  if (shouldPreferCatalogMetric(normalized, targetPhrases)) {
    return null;
  }

  if (looksLikeComparisonMetricQuestion(normalized)) {
    const windows = resolveComparisonWindowsFromQuestion(normalized, now());
    if (!windows) {
      return null;
    }
    return dynamicComparisonMetricAnswerForPhrasesAndWindows(
      targetPhrases,
      normalized,
      windows,
      routes,
    );
  }

  if (hasMetricTimeWindow(normalized)) {
    const timeWindow = resolveTimeWindowFromQuestion(transcript, now());
    if (!timeWindow || !looksLikeDynamicEnergyHistoryQuestion(normalized)) {
      return null;
    }
    return dynamicHistoryMetricAnswerForPhrasesAndWindow(
      targetPhrases,
      normalized,
      timeWindow,
      routes,
    );
  }

  if (!looksLikeDynamicCurrentPowerQuestion(normalized)) {
    return null;
  }
  return dynamicCurrentMetricAnswerForPhrases(
    targetPhrases,
    normalized,
    routes,
  );
}

function shouldPreferCatalogMetric(normalized: string, targetPhrases: readonly string[]): boolean {
  const metric = resolveMetricQuestion(normalized);
  if (!metric) {
    return false;
  }
  const targetCount = targetPhrases.flatMap((phrase) => splitDynamicTargetPhrase(phrase)).length;
  if (targetCount > 1) {
    return false;
  }
  return metric.scope !== "device";
}

export function dynamicCurrentMetricAnswerForPhrases(
  targetPhrases: readonly string[],
  normalized: string,
  routes: MetricRouteServices,
): MetricRouteResult | null {
  const composition = resolveDynamicMetricComposition(targetPhrases, routes, "current_power");
  if (!composition) {
    return null;
  }
  const cache = routes.stateCache;
  if (!cache || cache.size() === 0) {
    return declined("time_window_math", "I can't see Home Assistant state yet.", "dynamic current metric missing state cache");
  }

  const readings = composition.targets.flatMap((target) =>
    target.members.flatMap((member) => {
      if (member.mode !== "power") {
        return [];
      }
      const state = member.sourceEntityIds
        .map((entityId) => cache.get(entityId))
        .find((candidate): candidate is HaEntityState => candidate !== null);
      const point = state ? numericMetricPointFromState(state, syntheticPowerMetricDefinition(member.label)) : null;
      const watts = point ? powerPointWatts(point) : null;
      return state && watts !== null ? [{ entityId: state.entityId, watts }] : [];
    }),
  );

  if (readings.length === 0) {
    return declined("time_window_math", "I matched that source set, but I don't have usable live power states for it.", `dynamic current metric resolved no usable live power states for ${composition.subjectLabel}`);
  }

  const totalWatts = readings.reduce((sum, reading) => sum + reading.watts, 0);
  return {
    route: "time_window_math",
    status: "ok",
    confidence: "high",
    text: dynamicCurrentMetricSentence(composition.subjectLabel, totalWatts),
    modelUsed: false,
    resultId: null,
    touchedEntities: [],
    notes: `dynamic current metric from ${readings.map((reading) => reading.entityId).join(", ")}`,
    contextFrame: {
      kind: "current_metric",
      metricId: DYNAMIC_COMPOSED_METRIC_ID,
      composed: {
        sourceKind: "current_power",
        targetPhrases: composition.targetPhrases,
        subjectLabel: composition.subjectLabel,
      },
    },
  };
}

export async function dynamicHistoryMetricAnswerForPhrasesAndWindow(
  targetPhrases: readonly string[],
  normalized: string,
  timeWindow: TimeWindow,
  routes: MetricRouteServices,
): Promise<MetricRouteResult | null> {
  const composition = resolveDynamicMetricComposition(targetPhrases, routes, "history_energy");
  if (!composition) {
    return null;
  }
  const unsupportedWindowReason = unsupportedMetricWindowReason(timeWindow);
  if (unsupportedWindowReason) {
    return declined("time_window_math", `I matched ${composition.subjectLabel}, but ${unsupportedWindowReason}.`, `dynamic history metric source matched: ${composition.subjectLabel}; ${unsupportedWindowReason}`);
  }
  if (!routes.historyFetcher) {
    return declined("time_window_math", "I matched that source set, but Home Assistant history is not available yet.", `dynamic history metric source matched: ${composition.subjectLabel}; no history fetcher`);
  }

  const result = await calculateDynamicCompositionEnergy(composition, timeWindow, routes);
  if (result.status === "declined") {
    return declined("time_window_math", `I matched ${composition.subjectLabel}, but ${result.reason}.`, `dynamic history metric source matched: ${composition.subjectLabel}; ${result.reason}`);
  }

  const sourceEntityIds = composition.targets.flatMap((target) => target.members.flatMap((member) => member.sourceEntityIds));
  const approximate = dynamicCompositionUsesApproximateEnergy(composition);
  return {
    route: "time_window_math",
    status: "ok",
    confidence: "high",
    text: dynamicHistoryMetricSentence(composition.subjectLabel, result.value, result.unit, timeWindow.label, approximate),
    modelUsed: false,
    resultId: null,
    touchedEntities: [],
    notes: `dynamic history metric from ${[...new Set(sourceEntityIds)].join(", ")}; ${result.notes.join("; ")}`,
    contextFrame: {
      kind: "history_metric",
      metricId: DYNAMIC_COMPOSED_METRIC_ID,
      window: timeWindow,
      composed: {
        sourceKind: "history_energy",
        targetPhrases: composition.targetPhrases,
        subjectLabel: composition.subjectLabel,
      },
    },
  };
}

export async function dynamicComparisonMetricAnswerForPhrasesAndWindows(
  targetPhrases: readonly string[],
  normalized: string,
  windows: ComparisonWindowPair,
  routes: MetricRouteServices,
): Promise<MetricRouteResult | null> {
  const composition = resolveDynamicMetricComposition(targetPhrases, routes, "history_energy");
  if (!composition) {
    return null;
  }
  if (!routes.historyFetcher) {
    return declined("time_window_math", "I matched that source set, but Home Assistant history is not available yet.", `dynamic comparison metric source matched: ${composition.subjectLabel}; no history fetcher`);
  }

  const left = await calculateDynamicCompositionEnergy(composition, windows.left, routes);
  if (left.status === "declined") {
    return declined("time_window_math", `I matched ${composition.subjectLabel}, but ${left.reason}.`, `dynamic comparison metric source matched: ${composition.subjectLabel}; left comparison ${left.reason}`);
  }
  const right = await calculateDynamicCompositionEnergy(composition, windows.right, routes);
  if (right.status === "declined") {
    return declined("time_window_math", `I matched ${composition.subjectLabel}, but ${right.reason}.`, `dynamic comparison metric source matched: ${composition.subjectLabel}; right comparison ${right.reason}`);
  }
  const difference = compareMetricValues(left, right, "difference");
  if (difference.status === "declined") {
    return declined("time_window_math", `I matched ${composition.subjectLabel}, but ${difference.reason}.`, `dynamic comparison metric source matched: ${composition.subjectLabel}; comparison ${difference.reason}`);
  }

  const sourceEntityIds = composition.targets.flatMap((target) => target.members.flatMap((member) => member.sourceEntityIds));
  const approximate = dynamicCompositionUsesApproximateEnergy(composition);
  return {
    route: "time_window_math",
    status: "ok",
    confidence: "high",
    text: dynamicComparisonMetricSentence(composition.subjectLabel, left, right, difference.value, difference.unit, difference.direction, windows, normalized, approximate),
    modelUsed: false,
    resultId: null,
    touchedEntities: [],
    notes: `dynamic comparison metric from ${[...new Set(sourceEntityIds)].join(", ")}; compared ${windows.left.label} to ${windows.right.label}; ${left.notes.join("; ")}; ${right.notes.join("; ")}`,
    contextFrame: {
      kind: "comparison_metric",
      metricId: DYNAMIC_COMPOSED_METRIC_ID,
      windows,
      composed: {
        sourceKind: "history_energy",
        targetPhrases: composition.targetPhrases,
        subjectLabel: composition.subjectLabel,
      },
    },
  };
}

interface CurrentPowerLoad {
  readonly metric: MetricDefinition;
  readonly entityId: string;
  readonly watts: number;
}

/** Live device loads from the sourced power metrics, or why there are none. */
function currentPowerLoads(routes: MetricRouteServices): readonly CurrentPowerLoad[] | "no_catalog" | "no_state" {
  const catalog = defaultMetricCatalog();
  if (!catalog) return "no_catalog";
  const cache = routes.stateCache;
  if (!cache || cache.size() === 0) return "no_state";
  return catalog.metrics
    .filter((metric) => metric.scope === "device" && Boolean(metric.relatedPowerEntityId))
    .map((metric) => {
      const entityId = metric.relatedPowerEntityId as string;
      const state = cache.get(entityId);
      const point = state ? numericMetricPointFromState(state, metric) : null;
      const watts = point ? powerPointWatts(point) : null;
      return state && point && watts !== null ? { metric, entityId, watts } : null;
    })
    .filter((item): item is CurrentPowerLoad => item !== null);
}

/** Open chat's power read: the ranking route's live loads, biggest first. */
export function currentPowerLoadLines(routes: MetricRouteServices, limit = 8): string {
  const loads = currentPowerLoads(routes);
  if (loads === "no_catalog" || loads === "no_state" || loads.length === 0) return "The power readings are unavailable right now.";
  const ranked = [...loads].sort((left, right) => right.watts - left.watts).slice(0, limit);
  return `Biggest live loads now: ${ranked.map((item) => `${rankingMetricLabel(item.metric)} ${formatMetricNumber(item.watts)} W`).join(", ")}.`;
}

export function currentPowerRankingAnswer(normalized: string, routes: MetricRouteServices): MetricRouteResult {
  const candidates = currentPowerLoads(routes);
  if (candidates === "no_catalog") {
    return declined("time_window_math", "I don't have the metric catalogue loaded, so I can't rank current power.", "current power ranking catalog unavailable");
  }
  if (candidates === "no_state") {
    return declined("time_window_math", "I can't see Home Assistant state yet.", "current power ranking missing state cache");
  }

  if (candidates.length === 0) {
    return declined("time_window_math", "I have sourced device power metrics, but none of their live states are usable right now.", "current power ranking had no numeric live states");
  }

  const rankingFrame = parseMetricIntentFrame(normalized).ranking;
  const wantsLeast = rankingFrame?.direction === "ascending";
  const ranked = [...candidates].sort((left, right) => wantsLeast ? left.watts - right.watts : right.watts - left.watts);
  const namesSingleExtreme = /\b(?:most|least|biggest|smallest|highest|lowest|top|bottom|heaviest|lightest|barely)\b/.test(normalized);
  const asksOpenBreakdown = /^(?:what is|whats) using\b/.test(normalized) && !namesSingleExtreme;
  const asksForCollection = Boolean(rankingFrame?.collection) || /\b(?:rank|list|loads|users|devices|sources|break down|contributing|where .* going)\b/.test(normalized)
    || /^(?:what|which) are\b/.test(normalized)
    || asksOpenBreakdown;
  const count = Math.min(asksForCollection ? 3 : 1, ranked.length);
  const list = ranked.slice(0, count).map((item) => `${rankingMetricLabel(item.metric)} ${formatMetricNumber(item.watts)} W`).join(", ");
  const prefix = count === 1
    ? (wantsLeast ? "Smallest load" : "Biggest load")
    : (wantsLeast ? "Smallest loads" : "Biggest loads");
  return ok(
    "time_window_math",
    `${prefix}: ${list}.`,
    `current power ranking from ${candidates.length} sourced live power metrics: ${ranked.slice(0, count).map((item) => item.entityId).join(", ")}`,
    { kind: "current_power_ranking", metricId: "house_current_power", direction: wantsLeast ? "ascending" : "descending" },
  );
}

/**
 * The budget answer, with this month's usage worked out from the Energy history when the house set
 * its budget as a kWh figure on the House page rather than with its own helper sensors.
 */
export async function energyBudgetAnswerWithUsage(routes: MetricRouteServices, now: Date, normalized: string, contextMonthIndex: number | null = null): Promise<MetricRouteResult> {
  const energy = houseConfig().energy;
  if (energy.monthlyBudget || energy.monthlyBudgetPattern || energy.monthlyBudgetKwh === null) {
    return energyBudgetAnswer(routes, now, normalized, contextMonthIndex);
  }
  const monthIndex = parseEnergyBudgetMonthIndex(normalized, now) ?? contextMonthIndex ?? localMonthIndex(now, DEFAULT_TIMEZONE);
  return energyBudgetAnswer(routes, now, normalized, monthIndex, await monthEnergyUsed(routes, now, monthIndex));
}

/** The house's energy use in one month of this year (to now for this month), or null when it can't be read. */
async function monthEnergyUsed(routes: MetricRouteServices, now: Date, monthIndex: number): Promise<number | null> {
  const catalog = defaultMetricCatalog();
  const metric = catalog ? metricById(catalog, "house_consumption_energy") : null;
  const month = ENERGY_BUDGET_MONTHS[monthIndex];
  if (!catalog || !metric || !month) return null;
  const parsed = parseTimeWindow(monthIndex === localMonthIndex(now, DEFAULT_TIMEZONE) ? "this month" : `in ${month.label}`, { now, timezone: DEFAULT_TIMEZONE });
  if (parsed.status !== "matched" || !parsed.window) return null;
  const result = await calculateHistoricalMetric(metric, "energy_delta", parsed.window, routes, catalog, new Set());
  return result.status === "ok" ? result.value : null;
}

export function energyBudgetAnswer(routes: MetricRouteServices, now: Date, normalized: string, contextMonthIndex: number | null = null, usedKwh?: number | null): MetricRouteResult {
  const targetMonthIndex = parseEnergyBudgetMonthIndex(normalized, now) ?? contextMonthIndex ?? localMonthIndex(now, DEFAULT_TIMEZONE);
  const reading = energyBudgetReading(routes, now, targetMonthIndex, usedKwh);
  if (!reading) {
    return declined("energy_budget", "There's no monthly electricity budget set. Set one on the House page.", "energy budget requested; no budget set or its sources missing");
  }
  const notes = `energy budget from ${reading.sourceEntities.join(", ")}; card-compatible source model`;
  const answer = (mode: EnergyBudgetSpeechMode, text: string): MetricRouteResult => ok(
    "energy_budget",
    text,
    notes,
    { kind: "energy_budget", monthIndex: reading.monthIndex },
    { kind: "energy_budget", mode, statement: text },
  );
  if (/\b(months?|which months?)\b/.test(normalized) && /\breposit\b/.test(normalized) && /\bhistory\b/.test(normalized)) {
    return answer("history_coverage", energyBudgetHistoryCoverageSentence());
  }
  if (/\b(history|historical|last year|previous years?|reposit history|usually|normal for)\b/.test(normalized)) {
    return answer("history", energyBudgetHistorySentence(reading, now, normalized));
  }
  if (/\b(source|healthy|recent|fresh|status)\b/.test(normalized) && /\b(source|usage|reading|foxess|reposit|monthly)\b/.test(normalized)) {
    return answer("source_status", energyBudgetSourceStatusSentence(reading, normalized));
  }
  if (looksLikeEnergyBudgetFormulaComponentQuestion(normalized)) {
    return answer("formula_component", energyBudgetFormulaComponentSentence(reading, normalized));
  }
  if ((/\b(source|formula|calculation|calculate|calculated|work|derived|count|counts|counted|foxess)\b/.test(normalized)
    || (/\breposit\b/.test(normalized) && /\b(how|why|source|formula|calculation|calculate|calculated|work|derived|count|counts|counted)\b/.test(normalized)))
    && !/\b(left|remaining|remain|projected|projection|forecast|over|under|budget|allowance|cap|limit)\b/.test(normalized)) {
    return answer("formula", energyBudgetFormulaSentence(reading));
  }
  if (/\b(daily|per day|each day|need.*day|allowance.*day|average.*daily|rest of (?:the )?month)\b/.test(normalized)) {
    return answer("daily_target", energyBudgetDailyTargetSentence(reading));
  }
  if (/\b(suggested|recommended)\b/.test(normalized) || (/\bcap\b/.test(normalized) && /\b(reposit|history|set|budget|allowance)\b/.test(normalized))) {
    return answer("suggested_cap", energyBudgetSuggestedCapSentence(reading));
  }
  if (/\b(left|remaining|remain|how much.*have i got|how much.*do i have)\b/.test(normalized)) {
    return answer("remaining", energyBudgetRemainingSentence(reading));
  }
  if (/\b(percent|percentage)\b/.test(normalized)) {
    return answer("percent", energyBudgetPercentSentence(reading));
  }
  if (/\b(projected|projection|forecast|risk|pace|track|tracking|over|under|blow|exceed|go over|on target|finish|burning through|too quickly|point in the month)\b/.test(normalized)) {
    return answer("projection", energyBudgetProjectionSentence(reading, normalized));
  }
  if (/\b(used|use|using|spent|burned|burnt|through)\b/.test(normalized)) {
    return answer("used", energyBudgetUsedSentence(reading));
  }
  if (/\b(budget|allowance|cap|limit)\b/.test(normalized) && !reading.isCurrent) {
    return answer("allowance", energyBudgetMonthBudgetSentence(reading));
  }
  return answer("summary", energyBudgetSummarySentence(reading));
}

export function currentMetricAnswer(metric: MetricDefinition, normalized: string, routes: MetricRouteServices): MetricRouteResult | null {
  if (!canAnswerCurrentMetric(metric, normalized)) {
    return null;
  }
  const entityIds = currentMetricEntityIds(metric, normalized);
  if (entityIds.length === 0) {
    return declined("time_window_math", `I've got ${metric.label}, but I don't have a live current-state source for it.`, `metric source matched: ${metric.id}; no current entity`);
  }
  const cache = routes.stateCache;
  if (!cache || cache.size() === 0) {
    return declined("time_window_math", "I can't see Home Assistant state yet.", `metric source matched: ${metric.id}; no state cache`);
  }
  const state = entityIds.map((entityId) => cache.get(entityId)).find((candidate): candidate is HaEntityState => candidate !== null);
  if (!state) {
    return declined("time_window_math", `I've got ${metric.label}, but I don't have live state for its metric entity.`, `metric source matched: ${metric.id}; metric state missing`);
  }
  const value = numericMetricState(state);
  if (!value) {
    return declined("time_window_math", `${metric.label} is unavailable right now, so I can't read it.`, `metric source matched: ${metric.id}; metric state non-numeric or unavailable`);
  }
  const label = currentMetricLabel(metric, state);
  return ok(
    "time_window_math",
    currentMetricSentence(metric, state, value),
    `metric source matched: ${metric.id}; live state ${state.entityId}`,
    { kind: "current_metric", metricId: metric.id },
    {
      kind: "metric_current",
      subject: metricSpeechSubject({ ...metric, label }),
      measurement: value,
      drawsPower: metric.kind === "power" || /\bpower$/i.test(label),
    },
  );
}

export async function currentMetricBaselineAnswer(
  metric: MetricDefinition,
  normalized: string,
  routes: MetricRouteServices,
  now: () => Date,
): Promise<MetricRouteResult> {
  if (metric.kind !== "power") {
    return declined("time_window_math", "I can only compare current power against the same-time average for now.", `average follow-up unsupported metric kind: ${metric.id}`);
  }
  const cache = routes.stateCache;
  const entityIds = currentMetricEntityIds(metric, "now");
  const state = cache ? entityIds.map((entityId) => cache.get(entityId)).find((candidate): candidate is HaEntityState => candidate !== null) : null;
  if (!state) {
    return declined("time_window_math", `I've got ${metric.label}, but I don't have live state for its metric entity.`, `average follow-up metric source matched: ${metric.id}; metric state missing`);
  }
  const current = numericMetricPointFromState(state, metric);
  if (!current) {
    return declined("time_window_math", `I've got ${metric.label}, but its live state isn't numeric.`, `average follow-up metric source matched: ${metric.id}; metric state non-numeric`);
  }
  if (!routes.historyFetcher) {
    return declined("time_window_math", "I've got that metric, but Home Assistant history isn't available yet.", `average follow-up metric source matched: ${metric.id}; no history fetcher`);
  }
  const window = lastMonthBaselineWindow(now());
  const history = await routes.historyFetcher.fetchBest({
    statisticIds: metricStatisticIds(metric),
    fallbackEntityIds: metricFallbackEntityIds(metric),
    window,
    period: "hour",
  });
  const currentHour = hourInTimezone(now().toISOString(), DEFAULT_TIMEZONE);
  const sameHourSamples = history.samples.filter((sample) => hourInTimezone(sample.start, DEFAULT_TIMEZONE) === currentHour);
  const points = metricPointsFromHistory({ ...history, samples: sameHourSamples, states: [] }, metric, "average");
  const average = calculateMetricAggregation(points, "average");
  if (average.status === "declined") {
    return declined("time_window_math", `I've got ${metric.label}, but ${average.reason}.`, `average follow-up metric source matched: ${metric.id}; ${average.reason}`);
  }
  const currentResult: MetricMathOk = {
    status: "ok",
    value: current.value,
    unit: current.unit,
    notes: ["current value from live Home Assistant state"],
    sampleCount: 1,
  };
  const difference = compareMetricValues(currentResult, average, "difference");
  if (difference.status === "declined") {
    return declined("time_window_math", `I've got ${metric.label}, but ${difference.reason}.`, `average follow-up metric source matched: ${metric.id}; ${difference.reason}`);
  }
  const relation = difference.direction ?? "same";
  const currentMeasurement = `${formatMetricNumber(current.value)}${current.unit ? ` ${current.unit}` : ""}`;
  const averageMeasurement = `${formatBaselineNumber(average.value, average.unit)}${average.unit ? ` ${average.unit}` : ""}`;
  if (/\b(normal|usual|typical|expected)\b/.test(normalized) && !/\b(above|below|higher|lower|over|under)\b/.test(normalized)) {
    return ok(
      "time_window_math",
      `That's ${relation} than the usual same-time draw: ${currentMeasurement} against about ${averageMeasurement}.`,
      `average follow-up metric source matched: ${metric.id}; live state ${state.entityId}; same-time hourly history samples ${sameHourSamples.length}`,
      { kind: "current_metric", metricId: metric.id },
      {
        kind: "metric_baseline",
        relation,
        currentMeasurement,
        averageMeasurement,
      },
    );
  }
  const expected = /\b(below|lower|under)\b/.test(normalized) ? "lower" : "higher";
  const yesNo = difference.direction === expected ? "Yes" : "No";
  return ok(
    "time_window_math",
    `${yesNo}. That's ${relation} than the usual same-time draw: ${currentMeasurement} against about ${averageMeasurement}.`,
    `average follow-up metric source matched: ${metric.id}; live state ${state.entityId}; same-time hourly history samples ${sameHourSamples.length}`,
    { kind: "current_metric", metricId: metric.id },
    {
      kind: "metric_baseline",
      polarity: yesNo === "Yes" ? "yes" : "no",
      relation,
      currentMeasurement,
      averageMeasurement,
    },
  );
}

export async function historicalEnergyNormalityAnswer(
  metric: MetricDefinition,
  sourceWindow: TimeWindow,
  routes: MetricRouteServices,
  now: Date,
): Promise<MetricRouteResult> {
  if (metric.kind !== "energy" || metric.components.length > 0) {
    return declined("time_window_math", "I can only build that historical baseline for a directly sourced energy metric.", `historical normality unsupported metric: ${metric.id}`);
  }
  if (!routes.historyFetcher) {
    return declined("time_window_math", "I've got that metric context, but Home Assistant history isn't available yet.", `historical normality metric source matched: ${metric.id}; no history fetcher`);
  }
  if (!isLocalTodayWindow(sourceWindow, now)) {
    // The baseline compares today so far with past days at the same time of
    // day; it says nothing about a week, a month or a finished day.
    return declined(
      "time_window_math",
      `I can only judge today so far against past days, not ${sourceWindow.label ?? "that period"}.`,
      `historical normality metric source matched: ${metric.id}; baseline only covers today, not ${sourceWindow.label ?? `${sourceWindow.start}..${sourceWindow.end}`}`,
    );
  }
  const elapsedWindow = windowToSamePoint(sourceWindow, now);
  const observed = await calculateDirectEnergyMetric(metric, elapsedWindow, routes);
  if (observed.status === "declined") {
    return declined("time_window_math", `I've got ${metric.label}, but ${observed.reason}.`, `historical normality metric source matched: ${metric.id}; current window ${observed.reason}`);
  }

  const cohortWindows = historicalNormalityCohortWindows(elapsedWindow, now);
  const cohortResults = await Promise.all(cohortWindows.map(async ({ cohort, window }) => ({
    cohort,
    result: await calculateDirectEnergyMetric(metric, window, routes),
  })));
  const cohorts: HistoricalMetricCohort[] = ["month", "weekday"].flatMap((cohort) => {
    const values = cohortResults
      .filter((entry) => entry.cohort === cohort && entry.result.status === "ok")
      .map((entry) => (entry.result as HistoricalMetricOk).value);
    if (values.length === 0) {
      return [];
    }
    return [{
      label: cohort === "month"
        ? `${localMonthName(now, DEFAULT_TIMEZONE)} days`
        : `${localWeekdayName(now, DEFAULT_TIMEZONE)}s`,
      values,
    }];
  });
  if (cohorts.length === 0) {
    const boundary = await metricHistoryAvailabilityBoundary(metric, routes, now);
    return declined(
      "time_window_math",
      boundary
        ? `I can't build a comparable baseline. The earliest Home Assistant history returned is ${boundary}.`
        : "I can't build a comparable baseline because Home Assistant returned no usable history.",
      `historical normality metric source matched: ${metric.id}; no comparable cohort samples${boundary ? `; earliest sample ${boundary}` : ""}`,
    );
  }

  const baseline = average(cohorts.map((cohort) => average(cohort.values)));
  const ratio = baseline === 0 ? 0 : (observed.value - baseline) / Math.abs(baseline);
  const assessment = Math.abs(ratio) <= 0.15
    ? "within the normal range"
    : ratio > 0
      ? "higher than normal"
      : "lower than normal";
  const cohortText = cohorts.map((cohort) =>
    `${cohort.label} average ${formatMetricNumber(average(cohort.values))} kWh across ${cohort.values.length} comparable day${cohort.values.length === 1 ? "" : "s"}`).join("; ");
  return ok(
    "time_window_math",
    `Today so far is ${formatMetricNumber(observed.value)} kWh, which is ${assessment} against the available history. ${capitalize(cohortText)}.`,
    `historical normality metric source matched: ${metric.id}; deterministic ±15% combined-cohort rule; ${cohorts.map((cohort) => `${cohort.label} n=${cohort.values.length}`).join("; ")}`,
    { kind: "history_metric", metricId: metric.id, window: sourceWindow },
  );
}

export async function historicalEnergySamePointLastYearAnswer(
  metric: MetricDefinition,
  sourceWindow: TimeWindow,
  routes: MetricRouteServices,
  now: Date,
): Promise<MetricRouteResult> {
  if (metric.kind !== "energy" || metric.components.length > 0) {
    return declined("time_window_math", "I can only make that anniversary comparison for a directly sourced energy metric.", `same-point last-year unsupported metric: ${metric.id}`);
  }
  if (!routes.historyFetcher) {
    return declined("time_window_math", "I've got that metric context, but Home Assistant history isn't available yet.", `same-point last-year metric source matched: ${metric.id}; no history fetcher`);
  }
  const currentWindow = windowToSamePoint(sourceWindow, now);
  const priorWindow = shiftWindowLocalYears(currentWindow, -1);
  const [current, prior] = await Promise.all([
    calculateDirectEnergyMetric(metric, currentWindow, routes),
    calculateDirectEnergyMetric(metric, priorWindow, routes),
  ]);
  if (current.status === "declined") {
    return declined("time_window_math", `I've got ${metric.label}, but ${current.reason}.`, `same-point last-year metric source matched: ${metric.id}; current window ${current.reason}`);
  }
  if (prior.status === "declined") {
    const boundary = await metricHistoryAvailabilityBoundary(metric, routes, now);
    const requested = localDateLabel(new Date(priorWindow.start), DEFAULT_TIMEZONE);
    return declined(
      "time_window_math",
      boundary
        ? `I can't compare ${requested}: the earliest Home Assistant history returned is ${boundary}.`
        : `I can't compare ${requested}: Home Assistant returned no usable history for that date or any earlier boundary.`,
      `same-point last-year metric source matched: ${metric.id}; prior window unavailable; requested ${priorWindow.start}; ${boundary ? `earliest sample ${boundary}` : "no history boundary"}`,
    );
  }
  const difference = current.value - prior.value;
  const direction = difference > 0 ? "more" : difference < 0 ? "less" : "the same amount";
  const percent = prior.value === 0 ? null : Math.abs((difference / prior.value) * 100);
  const comparison = difference === 0
    ? `the same as last year at this point`
    : `${formatMetricNumber(Math.abs(difference))} kWh ${direction}, ${percent === null ? "with no percentage baseline" : `${formatMetricNumber(percent)}% ${direction}`}`;
  return ok(
    "time_window_math",
    `The house has used ${formatMetricNumber(current.value)} kWh today so far, versus ${formatMetricNumber(prior.value)} kWh at the same point last year: ${comparison}.`,
    `same-point last-year metric source matched: ${metric.id}; compared ${currentWindow.start}..${currentWindow.end} with ${priorWindow.start}..${priorWindow.end}`,
    { kind: "comparison_metric", metricId: metric.id, windows: { left: currentWindow, right: priorWindow } },
  );
}

export async function historyMetricAnswer(
  metric: MetricDefinition,
  transcript: string,
  normalized: string,
  routes: MetricRouteServices,
  now: () => Date,
): Promise<MetricRouteResult> {
  if (!routes.historyFetcher) {
    return declined("time_window_math", "I matched that metric, but Home Assistant history is not available yet.", `metric source matched: ${metric.id}; no history fetcher`);
  }
  if (looksLikeComparisonMetricQuestion(normalized)) {
    return comparisonMetricAnswer(metric, normalized, routes, now);
  }
  const timeWindow = resolveTimeWindowFromQuestion(transcript, now());
  if (!timeWindow) {
    return declined("time_window_math", "I matched that metric, but I could not resolve the time window without guessing.", `metric source matched: ${metric.id}; time window unresolved`);
  }
  return historyMetricAnswerForWindow(metric, normalized, timeWindow, routes);
}

export async function historyMetricAnswerForWindow(
  metric: MetricDefinition,
  normalized: string,
  timeWindow: TimeWindow,
  routes: MetricRouteServices,
): Promise<MetricRouteResult> {
  const catalog = defaultMetricCatalog();
  if (!catalog) {
    return declined("time_window_math", "I matched that metric, but the metric catalogue is not available.", `metric source matched: ${metric.id}; catalog unavailable`);
  }
  const unsupportedWindowReason = unsupportedMetricWindowReason(timeWindow);
  if (unsupportedWindowReason) {
    return declined("time_window_math", `I matched ${metric.label}, but ${unsupportedWindowReason}.`, `metric source matched: ${metric.id}; ${unsupportedWindowReason}`);
  }
  const operation = historicalMetricOperation(metric, normalized);
  const result = await calculateHistoricalMetric(metric, operation, timeWindow, routes, catalog, new Set());
  if (result.status === "declined") {
    return declined("time_window_math", `I matched ${metric.label}, but ${result.reason}.`, `metric source matched: ${metric.id}; ${result.reason}`);
  }
  return ok(
    "time_window_math",
    historicalMetricSentence(metric, operation, result.value, result.unit, timeWindow.label),
    `metric source matched: ${metric.id}; ${result.notes.join("; ")}`,
    { kind: "history_metric", metricId: metric.id, window: timeWindow },
  );
}

export function resolveComparisonWindowsFromQuestion(normalized: string, now: Date): ComparisonWindowPair | null {
  const todayYesterday = todayYesterdayComparisonWindows(normalized, now);
  if (todayYesterday) {
    return todayYesterday;
  }
  const rolling = rollingPreviousComparisonWindows(normalized, now);
  if (rolling) {
    return rolling;
  }
  return null;
}

export function contextualComparisonWindows(normalized: string, latestWindow: TimeWindow, now: Date): ComparisonWindowPair | null {
  if (/\byesterday\b/.test(normalized) && /\b(more|less|higher|lower|greater|than|compare|compared|beat|beats)\b/.test(normalized)) {
    const yesterday = parseNamedComparisonWindow("yesterday", now);
    return yesterday ? { left: latestWindow, right: yesterday } : null;
  }
  if (/\btoday\b/.test(normalized) && /\b(more|less|higher|lower|greater|than|compare|compared|beat|beats)\b/.test(normalized)) {
    const today = parseNamedComparisonWindow("today", now);
    return today ? { left: latestWindow, right: today } : null;
  }
  return null;
}

export async function comparisonMetricAnswerForWindows(
  metric: MetricDefinition,
  normalized: string,
  routes: MetricRouteServices,
  windows: ComparisonWindowPair,
): Promise<MetricRouteResult> {
  const catalog = defaultMetricCatalog();
  if (!catalog) {
    return declined("time_window_math", "I matched that metric, but the metric catalogue is not available.", `metric source matched: ${metric.id}; catalog unavailable`);
  }
  const operation = historicalMetricOperation(metric, normalized);
  const left = await calculateHistoricalMetric(metric, operation, windows.left, routes, catalog, new Set());
  if (left.status === "declined") {
    return declined("time_window_math", `I matched ${metric.label}, but ${left.reason}.`, `metric source matched: ${metric.id}; left comparison ${left.reason}`);
  }
  const right = await calculateHistoricalMetric(metric, operation, windows.right, routes, catalog, new Set());
  if (right.status === "declined") {
    return declined("time_window_math", `I matched ${metric.label}, but ${right.reason}.`, `metric source matched: ${metric.id}; right comparison ${right.reason}`);
  }
  const difference = compareMetricValues(left, right, "difference");
  if (difference.status === "declined") {
    return declined("time_window_math", `I matched ${metric.label}, but ${difference.reason}.`, `metric source matched: ${metric.id}; comparison ${difference.reason}`);
  }
  return ok(
    "time_window_math",
    comparisonMetricSentence(metric, left, right, difference.value, difference.unit, difference.direction, windows, normalized),
    `metric source matched: ${metric.id}; compared ${windows.left.label} to ${windows.right.label}; ${left.notes.join("; ")}; ${right.notes.join("; ")}`,
    { kind: "comparison_metric", metricId: metric.id, windows },
  );
}

async function comparisonMetricAnswer(
  metric: MetricDefinition,
  normalized: string,
  routes: MetricRouteServices,
  now: () => Date,
): Promise<MetricRouteResult> {
  const windows = resolveComparisonWindowsFromQuestion(normalized, now());
  if (!windows) {
    return declined("time_window_math", "I matched that metric, but I could not resolve both comparison windows without guessing.", `metric source matched: ${metric.id}; comparison windows unresolved`);
  }
  return comparisonMetricAnswerForWindows(metric, normalized, routes, windows);
}

async function calculateHistoricalMetric(
  metric: MetricDefinition,
  operation: HistoricalMetricOperation,
  window: TimeWindow,
  routes: MetricRouteServices,
  catalog: MetricCatalog,
  seenMetricIds: Set<string>,
): Promise<HistoricalMetricResult> {
  if (seenMetricIds.has(metric.id)) {
    return { status: "declined", reason: "the metric catalogue contains a circular derived metric" };
  }
  if (metric.components.length > 0) {
    seenMetricIds.add(metric.id);
    const parts: HistoricalMetricOk[] = [];
    for (const component of metric.components) {
      const child = metricById(catalog, component.metricId);
      if (!child) {
        return { status: "declined", reason: `derived metric component ${component.metricId} is missing` };
      }
      const childResult = await calculateHistoricalMetric(child, operation, window, routes, catalog, seenMetricIds);
      if (childResult.status === "declined") {
        return childResult;
      }
      parts.push({
        ...childResult,
        value: component.operation === "subtract" ? -childResult.value : childResult.value,
      });
    }
    seenMetricIds.delete(metric.id);
    return combineHistoricalMetricParts(parts, metric.unit);
  }

  const statisticIds = metricStatisticIds(metric);
  const fallbackEntityIds = metricFallbackEntityIds(metric);
  if (statisticIds.length === 0 && fallbackEntityIds.length === 0) {
    return { status: "declined", reason: "there is no Home Assistant statistic or fallback entity for it" };
  }
  const queryWindow = operation === "energy_delta" ? cumulativeEnergyQueryWindow(window) : window;
  const history = await routes.historyFetcher?.fetchBest({
    statisticIds: statisticIds.length > 0 ? statisticIds : fallbackEntityIds,
    fallbackEntityIds,
    window: queryWindow,
    period: historyPeriodForWindow(queryWindow),
  });
  if (!history) {
    return { status: "declined", reason: "Home Assistant history is not available yet" };
  }
  if (operation === "energy_delta") {
    const energy = buildWindowedEnergyUsedResult(history, window);
    const fallbackHistory = energy.kWh === null && history.source === "statistics" && fallbackEntityIds.length > 0 && routes.historyFetcher?.fetchHistory
      ? await routes.historyFetcher.fetchHistory({
          entityIds: fallbackEntityIds,
          window: queryWindow,
          significantChangesOnly: false,
          minimalResponse: false,
        })
      : null;
    const historyFallback = fallbackHistory ? buildWindowedEnergyUsedResult(fallbackHistory, window) : null;
    const sourcedEnergy = energy.kWh === null && historyFallback && historyFallback.kWh !== null ? historyFallback : energy;
    const sourcedHistory = sourcedEnergy === historyFallback && fallbackHistory ? fallbackHistory : history;
    if (sourcedEnergy.kWh === null) {
      return { status: "declined", reason: "Home Assistant did not return usable cumulative energy data for that window" };
    }
    return {
      status: "ok",
      value: sourcedEnergy.kWh,
      unit: metric.unit,
      sampleCount: sourcedEnergy.source.sampleCount + sourcedEnergy.source.stateCount,
      notes: [...sourcedEnergy.notes, `history source ${historyResultSourceEntityIds(sourcedHistory).join(", ")}`],
    };
  }
  const points = metricPointsFromHistory(history, metric, operation);
  const math = operation === "energy_from_power"
    ? calculateEnergyFromPower(points)
    : calculateMetricAggregation(points, aggregationForHistoryOperation(operation));
  if (math.status === "declined") {
    return { status: "declined", reason: math.reason };
  }
  return {
    status: "ok",
    value: math.value,
    unit: math.unit,
    sampleCount: math.sampleCount,
    notes: [...math.notes, `history source ${historyResultSourceEntityIds(history).join(", ")}`],
  };
}

async function calculateDirectEnergyMetric(
  metric: MetricDefinition,
  window: TimeWindow,
  routes: MetricRouteServices,
): Promise<HistoricalMetricResult> {
  const catalog = defaultMetricCatalog();
  if (!catalog) {
    return { status: "declined", reason: "the metric catalogue is not available" };
  }
  return calculateHistoricalMetric(metric, "energy_delta", window, routes, catalog, new Set());
}

function isLocalTodayWindow(window: TimeWindow, now: Date): boolean {
  const start = zonedDateTimeParts(new Date(window.start), DEFAULT_TIMEZONE);
  const today = zonedDateTimeParts(now, DEFAULT_TIMEZONE);
  const spanHours = (Date.parse(window.end) - Date.parse(window.start)) / 3_600_000;
  return start.year === today.year
    && start.month === today.month
    && start.day === today.day
    && start.hour === 0
    && start.minute === 0
    && spanHours <= 25;
}

function windowToSamePoint(window: TimeWindow, now: Date): TimeWindow {
  const endMs = Math.min(Date.parse(window.end), Math.max(Date.parse(window.start), now.getTime()));
  return {
    ...window,
    end: new Date(endMs).toISOString(),
    label: "today so far",
  };
}

function historicalNormalityCohortWindows(
  currentWindow: TimeWindow,
  now: Date,
): readonly { readonly cohort: "month" | "weekday"; readonly window: TimeWindow }[] {
  const currentStart = zonedDateTimeParts(new Date(currentWindow.start), DEFAULT_TIMEZONE);
  const currentEnd = zonedDateTimeParts(new Date(currentWindow.end), DEFAULT_TIMEZONE);
  const currentWeekday = localWeekdayIndex(new Date(currentWindow.start), DEFAULT_TIMEZONE);
  const monthWindows: TimeWindow[] = [];
  const weekdayWindows: TimeWindow[] = [];
  for (let offset = 1; offset <= 400 && (monthWindows.length < 6 || weekdayWindows.length < 6); offset += 1) {
    const date = addLocalCalendarDays(currentStart, -offset);
    const start = zonedTimeToUtc({ ...date, hour: 0, minute: 0, second: 0 }, DEFAULT_TIMEZONE);
    const end = zonedTimeToUtc({ ...date, hour: currentEnd.hour, minute: currentEnd.minute, second: currentEnd.second }, DEFAULT_TIMEZONE);
    if (end.getTime() <= start.getTime() || end.getTime() >= now.getTime()) {
      continue;
    }
    const candidate: TimeWindow = {
      start: start.toISOString(),
      end: end.toISOString(),
      timezone: DEFAULT_TIMEZONE,
      label: localDateLabel(start, DEFAULT_TIMEZONE),
      source: "absolute_date",
      confidence: "high",
    };
    if (date.month === currentStart.month && monthWindows.length < 6) {
      monthWindows.push(candidate);
    }
    if (localWeekdayIndex(start, DEFAULT_TIMEZONE) === currentWeekday && weekdayWindows.length < 6) {
      weekdayWindows.push(candidate);
    }
  }
  return [
    ...monthWindows.map((window) => ({ cohort: "month" as const, window })),
    ...weekdayWindows.map((window) => ({ cohort: "weekday" as const, window })),
  ];
}

function shiftWindowLocalYears(window: TimeWindow, years: number): TimeWindow {
  const start = zonedDateTimeParts(new Date(window.start), DEFAULT_TIMEZONE);
  const end = zonedDateTimeParts(new Date(window.end), DEFAULT_TIMEZONE);
  const shiftedStart = zonedTimeToUtc(withLocalYear(start, start.year + years), DEFAULT_TIMEZONE);
  const shiftedEnd = zonedTimeToUtc(withLocalYear(end, end.year + years), DEFAULT_TIMEZONE);
  return {
    ...window,
    start: shiftedStart.toISOString(),
    end: shiftedEnd.toISOString(),
    label: "the same point last year",
  };
}

async function metricHistoryAvailabilityBoundary(
  metric: MetricDefinition,
  routes: MetricRouteServices,
  now: Date,
): Promise<string | null> {
  const statisticIds = metricStatisticIds(metric);
  const fallbackEntityIds = metricFallbackEntityIds(metric);
  if (!routes.historyFetcher || (statisticIds.length === 0 && fallbackEntityIds.length === 0)) {
    return null;
  }
  const start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - 5);
  const query = {
    statisticIds: statisticIds.length > 0 ? statisticIds : fallbackEntityIds,
    window: {
      start: start.toISOString(),
      end: now.toISOString(),
      timezone: DEFAULT_TIMEZONE,
      label: "available retention",
    },
    period: "day",
  } as const;
  const history = routes.historyFetcher.fetchStatistics
    ? await routes.historyFetcher.fetchStatistics(query)
    : await routes.historyFetcher.fetchBest({ ...query, fallbackEntityIds });
  const timestamps = [
    ...history.samples.map((sample) => sample.start),
    ...history.states.map((state) => state.lastChanged),
  ].filter((value) => Number.isFinite(Date.parse(value))).sort();
  const earliest = timestamps[0];
  return earliest ? localDateTimeLabel(new Date(earliest), DEFAULT_TIMEZONE) : null;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

interface LocalMetricDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function addLocalCalendarDays(date: LocalMetricDateTime, days: number): LocalMetricDateTime {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days, date.hour, date.minute, date.second));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

function withLocalYear(date: LocalMetricDateTime, year: number): LocalMetricDateTime {
  const day = Math.min(date.day, new Date(Date.UTC(year, date.month, 0)).getUTCDate());
  return { ...date, year, day };
}

function localWeekdayIndex(date: Date, timezone: string): number {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(date);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
}

function localMonthName(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat(HOUSE_LOCALE, { timeZone: timezone, month: "long" }).format(date);
}

function localWeekdayName(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat(HOUSE_LOCALE, { timeZone: timezone, weekday: "long" }).format(date);
}

function localDateLabel(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: timezone,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function localDateTimeLabel(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: timezone,
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function combineHistoricalMetricParts(parts: readonly HistoricalMetricOk[], fallbackUnit: string): HistoricalMetricResult {
  if (parts.length === 0) {
    return { status: "declined", reason: "the derived metric has no components" };
  }
  const units = new Set(parts.map((part) => part.unit ?? fallbackUnit));
  if (units.size > 1) {
    return { status: "declined", reason: "the derived metric components returned incompatible units" };
  }
  return {
    status: "ok",
    value: parts.reduce((sum, part) => sum + part.value, 0),
    unit: parts[0]?.unit ?? fallbackUnit,
    sampleCount: parts.reduce((sum, part) => sum + part.sampleCount, 0),
    notes: parts.flatMap((part) => part.notes),
  };
}

function historicalMetricOperation(metric: MetricDefinition, normalized: string): HistoricalMetricOperation {
  const aggregation = parseMetricIntentFrame(normalized).aggregation;
  if (aggregation === "average") {
    return "average";
  }
  if (aggregation === "maximum") {
    return "maximum";
  }
  if (aggregation === "minimum") {
    return "minimum";
  }
  if (metric.kind === "power" && /\b(total|energy|used|use|usage|consumed|consume)\b/.test(normalized)) {
    return "energy_from_power";
  }
  return metric.kind === "power" ? "average" : "energy_delta";
}

function aggregationForHistoryOperation(operation: HistoricalMetricOperation): MetricAggregation {
  switch (operation) {
    case "maximum":
      return "maximum";
    case "minimum":
      return "minimum";
    case "average":
    default:
      return "average";
  }
}

function metricPointsFromHistory(history: HaHistoryResult, metric: MetricDefinition, operation: HistoricalMetricOperation): readonly MetricPoint[] {
  if (history.samples.length > 0) {
    return history.samples.flatMap((sample) => {
      const value = statisticSampleValue(sampleValueForOperation(sample, operation));
      return value === null ? [] : [{ timestamp: sample.start, value, unit: metric.unit }];
    });
  }
  return history.states.flatMap((state) => {
    const value = Number(state.state);
    if (!Number.isFinite(value)) {
      return [];
    }
    const unit = typeof state.attributes.unit_of_measurement === "string" ? state.attributes.unit_of_measurement : metric.unit;
    return [{ timestamp: state.lastChanged, value, unit }];
  });
}

function sampleValueForOperation(sample: { readonly mean: number | null; readonly min: number | null; readonly max: number | null; readonly state: number | null; readonly sum: number | null }, operation: HistoricalMetricOperation): number | null {
  switch (operation) {
    case "maximum":
      return sample.max ?? sample.mean ?? sample.state;
    case "minimum":
      return sample.min ?? sample.mean ?? sample.state;
    case "energy_from_power":
    case "average":
    default:
      return sample.mean ?? sample.state ?? sample.max ?? sample.min;
  }
}

function statisticSampleValue(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : value;
}

function metricStatisticIds(metric: MetricDefinition): readonly string[] {
  return metric.statisticId ? [metric.statisticId] : [];
}

function metricFallbackEntityIds(metric: MetricDefinition): readonly string[] {
  return [...new Set([metric.entityId, ...metric.fallbackEntityIds].filter((entityId): entityId is string => Boolean(entityId)))];
}

function historyResultSourceEntityIds(history: HaHistoryResult): readonly string[] {
  return [...new Set([
    ...history.samples.map((sample) => sample.statisticId),
    ...history.states.map((state) => state.entityId),
    ...history.statisticIds,
    ...history.entityIds,
  ].filter(Boolean))];
}

function historyPeriodForWindow(window: TimeWindow): HaStatisticPeriod {
  const hours = (Date.parse(window.end) - Date.parse(window.start)) / 3_600_000;
  if (hours <= 6) {
    return "5minute";
  }
  if (hours > 24 * 730) {
    return "month";
  }
  if (hours > 24 * 62) {
    return "week";
  }
  if (hours > 24 * 14) {
    return "day";
  }
  return "hour";
}

function cumulativeEnergyQueryWindow(window: TimeWindow): TimeWindow {
  const lookbackMs = 24 * 60 * 60 * 1000;
  return {
    ...window,
    start: new Date(Date.parse(window.start) - lookbackMs).toISOString(),
  };
}

function unsupportedMetricWindowReason(window: TimeWindow, now: Date = new Date()): string | null {
  if (window.source === "day_part") {
    const startMs = Date.parse(window.start);
    if (!Number.isFinite(startMs)) {
      return "the time window could not be resolved cleanly";
    }
    if (startMs >= now.getTime()) {
      return `that ${window.label} window has not started yet`;
    }
    return `that ${window.label} window needs a clearer calendar day or rolling range`;
  }
  return null;
}

function todayYesterdayComparisonWindows(normalized: string, now: Date): ComparisonWindowPair | null {
  const todayIndex = normalized.indexOf("today");
  const yesterdayIndex = normalized.indexOf("yesterday");
  if (todayIndex < 0 && yesterdayIndex < 0) {
    return null;
  }
  const today = parseNamedComparisonWindow("today", now);
  const yesterday = parseNamedComparisonWindow("yesterday", now);
  if (!today || !yesterday) {
    return null;
  }
  if (todayIndex >= 0 && yesterdayIndex >= 0) {
    return todayIndex <= yesterdayIndex ? { left: today, right: yesterday } : { left: yesterday, right: today };
  }
  if (yesterdayIndex >= 0 && /\b(more|less|higher|lower|compare|compared|versus|vs|difference)\b/.test(normalized)) {
    return { left: today, right: yesterday };
  }
  if (todayIndex >= 0 && /\bthan yesterday|compared to yesterday|against yesterday\b/.test(normalized)) {
    return { left: today, right: yesterday };
  }
  return null;
}

function rollingPreviousComparisonWindows(normalized: string, now: Date): ComparisonWindowPair | null {
  if (!/\b(previous|prior)\b/.test(normalized)) {
    return null;
  }
  const match = /\b((?:last|past)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?))\b/.exec(normalized);
  const previousOnlyMatch = /\bprevious\s+((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?))\b/.exec(normalized);
  const leftText = match?.[1] ?? (previousOnlyMatch ? `last ${previousOnlyMatch[1]}` : undefined);
  if (!leftText) {
    return null;
  }
  const left = parseNamedComparisonWindow(leftText, now);
  if (!left) {
    return null;
  }
  const right = previousWindow(left);
  if (!right) {
    return null;
  }
  return { left, right };
}

function parseNamedComparisonWindow(text: string, now: Date): TimeWindow | null {
  const parsed = parseTimeWindow(text, { now, timezone: DEFAULT_TIMEZONE });
  return parsed.status === "matched" ? parsed.window : null;
}

function previousWindow(window: TimeWindow): TimeWindow | null {
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return null;
  }
  const duration = endMs - startMs;
  return {
    ...window,
    start: new Date(startMs - duration).toISOString(),
    end: new Date(startMs).toISOString(),
    label: `previous ${window.label.replace(/^(?:last|past)\s+/i, "")}`,
    confidence: window.confidence === "high" ? "high" : "medium",
  };
}

function historicalMetricSentence(metric: MetricDefinition, operation: HistoricalMetricOperation, value: number, unit: string | null, windowLabel: string): string {
  const measurement = `${formatMetricNumber(value)}${unit ? ` ${unit}` : ""}`;
  const subject = metricSpeechSubject(metric);
  const spokenWindowLabel = spokenMetricWindowLabel(windowLabel);
  switch (operation) {
    case "average":
      return `${capitalize(spokenWindowLabel)}, the average ${subject.toLowerCase()} ${metric.kind === "power" ? "draw" : "value"} was ${measurement}.`;
    case "maximum":
      return `${capitalize(spokenWindowLabel)}, ${metricEnergySubject(metric, subject)} peaked at ${measurement}.`;
    case "minimum":
      return `${capitalize(spokenWindowLabel)}, ${metricEnergySubject(metric, subject)} bottomed out at ${measurement}.`;
    case "energy_from_power":
      return `${metricEnergySubject(metric, subject)} used about ${measurement} ${spokenWindowLabel}.`;
    case "energy_delta":
    default:
      return `${metricEnergyLead(metric, subject)} ${measurement} ${spokenWindowLabel}.`;
  }
}

function comparisonMetricSentence(
  metric: MetricDefinition,
  left: HistoricalMetricOk,
  right: HistoricalMetricOk,
  difference: number,
  unit: string | null,
  direction: "higher" | "lower" | "same" | null,
  windows: ComparisonWindowPair,
  normalized: string,
): string {
  const leftMeasurement = `${formatMetricNumber(left.value)}${left.unit ? ` ${left.unit}` : ""}`;
  const rightMeasurement = `${formatMetricNumber(right.value)}${right.unit ? ` ${right.unit}` : ""}`;
  const differenceMeasurement = `${formatMetricNumber(Math.abs(difference))}${unit ? ` ${unit}` : ""}`;
  const relation = direction ?? "same";
  const yesNo = comparisonYesNoPrefix(normalized, relation);
  const prefix = yesNo ? `${yesNo}. ` : "";
  const subject = metricSpeechSubject(metric);
  const comparisonSubject = metricComparisonSubject(metric, subject);
  const leftWindow = spokenComparisonWindowLabel(windows.left.label);
  const rightWindow = spokenComparisonWindowLabel(windows.right.label);
  if (relation === "same") {
    return `${prefix}${comparisonSubject.same} ${leftWindow} and ${rightWindow}: ${leftMeasurement} vs ${rightMeasurement}.`;
  }
  return `${prefix}${comparisonSubject.relation(relation)} ${leftWindow} than ${rightWindow}: ${leftMeasurement} vs ${rightMeasurement}, a ${differenceMeasurement} difference.`;
}

function looksLikeDynamicCurrentPowerQuestion(normalized: string): boolean {
  return !hasMetricTimeWindow(normalized)
    && /\b(power|electricity|load|loads|draw|drawing|watts?|kw|using|use)\b/.test(normalized)
    && /\b(now|right now|currently|current|at the moment|at the minute)\b/.test(normalized)
    && !/\b(average|mean|maximum|max|peak|highest|minimum|min|lowest)\b/.test(normalized);
}

function looksLikeDynamicEnergyHistoryQuestion(normalized: string): boolean {
  return hasMetricTimeWindow(normalized)
    && /\b(power|energy|electricity|kwh|usage|use|used|consume|consumed|consumption)\b/.test(normalized)
    && !/\b(average|mean|maximum|max|peak|highest|minimum|min|lowest)\b/.test(normalized);
}

function resolveDynamicTargetPhraseList(transcript: string, normalized: string, now: Date): readonly string[] {
  const explicitSubject = /\bdid\s+(.+?)\s+(?:use|used|consume|consumed|draw|drawing|pull|pulled|take|taken|took|generate|generated|produce|produced)\b/.exec(normalized)?.[1]
    ?? /\b(?:from|for|of)\s+(.+?)\s+(?:was|were)\s+(?:used|consumed|drawn|generated|produced)\b/.exec(normalized)?.[1]
    ?? null;
  const rawSubject = explicitSubject ?? normalized
    .replace(/^(?:what is|what are|what s|whats|how much|how many|show me|give me|tell me|check)\s+/, "")
    .replace(/\b(?:energy|power used|power|electricity|load|loads|draw|drawing|use|used|usage|consume|consumed|consumption|kwh|kw|watts?|cost|costing|price|money|runtime|run time|duration|average|mean|peak|max|highest|minimum|min|lowest|total|current|currently)\b/g, " ")
    .replace(/\b(?:right now|at the moment|at the minute|now)\b/g, " ")
    .replace(/\b(?:for|over|during|since|today|yesterday|tomorrow|tonight|last|past|previous|rolling|this)\b.*$/, "")
    .replace(/\b(?:did|does|do|was|were|is|are|the|a|an|of|our)\b/g, " ");
  const cleaned = normalizeDynamicTargetPhrase(rawSubject, now);
  return cleaned ? [cleaned] : [];
}

export function normalizeDynamicMetricTargetText(value: string, now: Date): string {
  return normalizeDynamicTargetPhrase(value, now);
}

function normalizeDynamicTargetPhrase(value: string, now: Date): string {
  const normalized = normalizeTargetText(value)
    .replace(/\b(?:from|for|in|inside|across)\b/g, " ")
    .replace(/\b(?:just|only)\b/g, " ")
    .replace(/\b(?:all of|all)\b/g, " ")
    .replace(/\b(?:and then)\b/g, " and ")
    .replace(/\btogether\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "";
  }
  const timeWindow = resolveTimeWindowFromQuestion(normalized, now);
  const withoutWindow = timeWindow
    ? normalized
      .replace(new RegExp(`(?:^| )${escapeRegExp(timeWindow.label)}(?: |$)`, "g"), " ")
      .replace(/\s+/g, " ")
      .trim()
    : normalized;
  return withoutWindow
    .replace(/^(?:the|my)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveDynamicMetricComposition(
  targetPhrases: readonly string[],
  routes: MetricRouteServices,
  purpose: "current_power" | "history_energy",
): DynamicMetricComposition | null {
  const normalizedTargets = targetPhrases.map((phrase) => normalizeTargetText(phrase)).filter(Boolean);
  if (normalizedTargets.length === 0) {
    return null;
  }
  const resolverContext = buildDynamicMetricResolverContext(routes);
  const targets = normalizedTargets.flatMap((targetText) => {
    const parts = splitDynamicTargetPhrase(targetText);
    if (parts.length > 1) {
      const splitTargets = parts
        .map((phrase) => resolveDynamicTargetSource(phrase, routes, purpose, resolverContext))
        .filter((target): target is DynamicMetricTargetSource => target !== null);
      if (splitTargets.length > 0) {
        return splitTargets;
      }
    }
    const direct = resolveDynamicTargetSource(targetText, routes, purpose, resolverContext);
    if (direct) {
      return [direct];
    }
    return [];
  });
  if (targets.length === 0) {
    return null;
  }
  return {
    subjectLabel: joinDynamicLabels(targets.map((target) => target.label)),
    targetPhrases: targets.map((target) => target.phrase),
    targets,
  };
}

function buildDynamicMetricResolverContext(routes: MetricRouteServices): TargetResolver | null {
  return routes.stateCache && routes.registry
    ? targetResolverFor(routes.stateCache, routes.registry, routes.aliases ?? [])
    : null;
}

function resolveDynamicTargetSource(
  phrase: string,
  routes: MetricRouteServices,
  purpose: "current_power" | "history_energy",
  resolverContext: TargetResolver | null,
): DynamicMetricTargetSource | null {
  const cleaned = normalizeTargetText(phrase);
  if (!cleaned) {
    return null;
  }

  const areaMembers = resolverContext ? dynamicMembersForArea(cleaned, purpose, resolverContext) : [];
  if (areaMembers.length > 0) {
    return {
      phrase: cleaned,
      label: dynamicAreaLabel(areaMembers, cleaned),
      members: areaMembers,
    };
  }

  const textMembers = resolverContext ? dynamicMembersForText(cleaned, purpose, resolverContext) : [];
  if (textMembers.length > 0) {
    return {
      phrase: cleaned,
      label: dynamicTextLabel(textMembers, cleaned),
      members: textMembers,
    };
  }

  const metricFallback = dynamicMembersFromMetricAlias(cleaned, purpose);
  if (metricFallback.length === 0) {
    return null;
  }
  return {
    phrase: cleaned,
    label: metricFallback[0]?.label ?? capitalize(cleaned),
    members: metricFallback,
  };
}

function dynamicMembersForArea(
  areaText: string,
  purpose: "current_power" | "history_energy",
  resolverContext: TargetResolver,
): readonly DynamicMetricMember[] {
  const energyMatches = resolverContext.resolve({ area: areaText, capability: "energy" }).matches;
  const powerMatches = resolverContext.resolve({ area: areaText, capability: "power" }).matches;
  return dynamicMembersFromCapabilityMatches(energyMatches, powerMatches, purpose);
}

function dynamicMembersForText(
  text: string,
  purpose: "current_power" | "history_energy",
  resolverContext: TargetResolver,
): readonly DynamicMetricMember[] {
  const energyMatches = resolverContext.resolve({ text, capability: "energy" }).matches;
  const powerMatches = resolverContext.resolve({ text, capability: "power" }).matches;
  return dynamicMembersFromCapabilityMatches(energyMatches, powerMatches, purpose);
}

function dynamicMembersFromCapabilityMatches(
  energyMatches: readonly TargetResolverMatch[],
  powerMatches: readonly TargetResolverMatch[],
  purpose: "current_power" | "history_energy",
): readonly DynamicMetricMember[] {
  if (purpose === "current_power") {
    return dedupeDynamicMembers(powerMatches.map((match) => capabilityEntityToDynamicMember(match, "power")));
  }

  const energyMembers = energyMatches.map((match) => capabilityEntityToDynamicMember(match, "energy"));
  const coveredDeviceIds = new Set(energyMembers.map((member) => member.deviceId).filter((deviceId): deviceId is string => Boolean(deviceId)));
  const powerMembers = powerMatches
    .filter((match) => !match.deviceId || !coveredDeviceIds.has(match.deviceId))
    .map((match) => capabilityEntityToDynamicMember(match, "power"));
  return dedupeDynamicMembers([...energyMembers, ...powerMembers]);
}

function capabilityEntityToDynamicMember(
  entity: TargetResolverMatch,
  mode: "energy" | "power",
): DynamicMetricMember {
  return {
    label: dynamicCapabilityEntityLabel(entity),
    mode,
    statisticIds: [entity.entityId],
    fallbackEntityIds: [entity.entityId],
    sourceEntityIds: [entity.entityId],
    deviceId: entity.deviceId,
  };
}

function dynamicMembersFromMetricAlias(
  text: string,
  purpose: "current_power" | "history_energy",
): readonly DynamicMetricMember[] {
  const metric = resolveFollowUpMetricTarget(text);
  if (!metric || metric.scope !== "device") {
    return [];
  }
  if (purpose === "current_power") {
    const entityIds = metric.kind === "power"
      ? metricFallbackEntityIds(metric)
      : metric.relatedPowerEntityId ? [metric.relatedPowerEntityId] : [];
    return entityIds.length > 0
      ? [{
          label: metricSpeechSubject(metric),
          mode: "power",
          statisticIds: entityIds,
          fallbackEntityIds: entityIds,
          sourceEntityIds: entityIds,
          deviceId: null,
        }]
      : [];
  }

  const energyStatisticIds = metric.kind === "energy" ? metricStatisticIds(metric) : [];
  const energyFallbackEntityIds = metric.kind === "energy" ? metricFallbackEntityIds(metric) : [];
  if (energyStatisticIds.length > 0 || energyFallbackEntityIds.length > 0) {
    return [{
      label: metricSpeechSubject(metric),
      mode: "energy",
      statisticIds: energyStatisticIds.length > 0 ? energyStatisticIds : energyFallbackEntityIds,
      fallbackEntityIds: energyFallbackEntityIds,
      sourceEntityIds: energyFallbackEntityIds,
      deviceId: null,
    }];
  }
  if (metric.kind === "power") {
    const powerEntityIds = metricFallbackEntityIds(metric);
    return powerEntityIds.length > 0
      ? [{
          label: metricSpeechSubject(metric),
          mode: "power",
          statisticIds: metricStatisticIds(metric).length > 0 ? metricStatisticIds(metric) : powerEntityIds,
          fallbackEntityIds: powerEntityIds,
          sourceEntityIds: powerEntityIds,
          deviceId: null,
        }]
      : [];
  }
  return [];
}

function splitDynamicTargetPhrase(value: string): readonly string[] {
  return value
    .split(/\s*(?:,| and | plus )\s*/g)
    .map((part) => normalizeTargetText(part))
    .filter(Boolean);
}

function dedupeDynamicMembers(members: readonly DynamicMetricMember[]): readonly DynamicMetricMember[] {
  const seen = new Set<string>();
  const result: DynamicMetricMember[] = [];
  for (const member of members) {
    const key = `${member.mode}:${member.sourceEntityIds.join(",")}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(member);
  }
  return result;
}

async function calculateDynamicCompositionEnergy(
  composition: DynamicMetricComposition,
  timeWindow: TimeWindow,
  routes: MetricRouteServices,
): Promise<HistoricalMetricResult> {
  const parts = await Promise.all(
    composition.targets.flatMap((target) =>
      target.members.map((member) => calculateDynamicMemberEnergy(member, timeWindow, routes)),
    ),
  );
  const declinedPart = parts.find((part) => part.status === "declined");
  if (declinedPart) {
    return declinedPart;
  }
  return combineHistoricalMetricParts(parts as readonly HistoricalMetricOk[], "kWh");
}

async function calculateDynamicMemberEnergy(
  member: DynamicMetricMember,
  timeWindow: TimeWindow,
  routes: MetricRouteServices,
): Promise<HistoricalMetricResult> {
  const operation: HistoricalMetricOperation = member.mode === "energy" ? "energy_delta" : "energy_from_power";
  const queryWindow = operation === "energy_delta" ? cumulativeEnergyQueryWindow(timeWindow) : timeWindow;
  const history = await routes.historyFetcher?.fetchBest({
    statisticIds: member.statisticIds.length > 0 ? member.statisticIds : member.fallbackEntityIds,
    fallbackEntityIds: member.fallbackEntityIds,
    window: queryWindow,
    period: historyPeriodForWindow(queryWindow),
  });
  if (!history) {
    return { status: "declined", reason: "Home Assistant history is not available yet" };
  }
  if (member.mode === "energy") {
    const energy = buildWindowedEnergyUsedResult(history, timeWindow);
    const historyFallback = energy.kWh === null && history.source === "statistics" && member.fallbackEntityIds.length > 0 && routes.historyFetcher?.fetchHistory
      ? buildWindowedEnergyUsedResult(await routes.historyFetcher.fetchHistory({
          entityIds: member.fallbackEntityIds,
          window: queryWindow,
          significantChangesOnly: false,
          minimalResponse: false,
        }), timeWindow)
      : null;
    const sourcedEnergy = energy.kWh === null && historyFallback?.kWh !== null ? historyFallback : energy;
    const kWh = sourcedEnergy?.kWh ?? null;
    if (kWh === null || !sourcedEnergy) {
      return { status: "declined", reason: "Home Assistant did not return usable cumulative energy data for that window" };
    }
    return {
      status: "ok",
      value: kWh,
      unit: "kWh",
      sampleCount: sourcedEnergy.source.sampleCount + sourcedEnergy.source.stateCount,
      notes: sourcedEnergy.notes,
    };
  }

  const points = memberPointsFromHistory(history, member);
  const math = calculateEnergyFromPower(points);
  if (math.status === "ok") {
    return historicalMetricOkFromMath(math);
  }

  if (history.source === "statistics" && math.reason === "energy integration requires at least two timestamped power samples" && member.fallbackEntityIds.length > 0 && routes.historyFetcher?.fetchHistory) {
    const fallbackHistory = await routes.historyFetcher.fetchHistory({
      entityIds: member.fallbackEntityIds,
      window: queryWindow,
      significantChangesOnly: false,
      minimalResponse: false,
    });
    const fallbackPoints = memberPointsFromHistory(fallbackHistory, member);
    const fallbackMath = calculateEnergyFromPower(fallbackPoints);
    if (fallbackMath.status === "ok") {
      return historicalMetricOkFromMath(fallbackMath, ["fell back to raw history states after sparse recorder statistics"]);
    }
    const fallbackEstimate = approximateSparsePowerEnergy(fallbackPoints, timeWindow, ["estimated from raw history after sparse recorder statistics"]);
    if (fallbackEstimate) {
      return fallbackEstimate;
    }
  }

  const estimate = approximateSparsePowerEnergy(points, timeWindow);
  if (estimate) {
    return estimate;
  }

  return {
    status: "declined",
    reason: dynamicPowerHistoryFailureReason(math.reason),
  };
}

function memberPointsFromHistory(history: HaHistoryResult, member: DynamicMetricMember): readonly MetricPoint[] {
  if (history.samples.length > 0) {
    return history.samples.flatMap((sample) => {
      const value = statisticSampleValue(sample.mean ?? sample.state ?? sample.max ?? sample.min);
      return value === null ? [] : [{ timestamp: sample.start, value, unit: "W" }];
    });
  }
  return history.states.flatMap((state) => {
    const value = Number(state.state);
    if (!Number.isFinite(value)) {
      return [];
    }
    const unit = typeof state.attributes.unit_of_measurement === "string" ? state.attributes.unit_of_measurement : "W";
    return [{ timestamp: state.lastChanged, value, unit }];
  });
}

function historicalMetricOkFromMath(result: MetricMathOk, extraNotes: readonly string[] = []): HistoricalMetricOk {
  return {
    status: "ok",
    value: result.value,
    unit: result.unit,
    sampleCount: result.sampleCount,
    notes: [...result.notes, ...extraNotes],
  };
}

function approximateSparsePowerEnergy(
  points: readonly MetricPoint[],
  timeWindow: TimeWindow,
  extraNotes: readonly string[] = [],
): HistoricalMetricOk | null {
  if (points.length !== 1) {
    return null;
  }
  const point = points[0];
  if (!point) {
    return null;
  }
  const durationMs = timeWindowDurationMs(timeWindow);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > SPARSE_POWER_ESTIMATE_MAX_WINDOW_MS) {
    return null;
  }
  const watts = powerPointWatts(point);
  if (watts === null) {
    return null;
  }
  return {
    status: "ok",
    value: (watts * (durationMs / 3_600_000)) / 1000,
    unit: "kWh",
    sampleCount: 1,
    notes: ["energy estimated from a single recorded power sample across a short window", ...extraNotes],
  };
}

function dynamicPowerHistoryFailureReason(reason: string): string {
  if (reason === "energy integration requires at least two timestamped power samples") {
    return "Home Assistant only returned one usable power reading for that window, so I can't answer it cleanly";
  }
  return reason;
}

function timeWindowDurationMs(window: TimeWindow): number {
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return Number.NaN;
  }
  return endMs - startMs;
}

function dynamicAreaLabel(members: readonly DynamicMetricMember[], fallback: string): string {
  return capitalize(fallback);
}

function dynamicTextLabel(members: readonly DynamicMetricMember[], fallback: string): string {
  if (members.length === 1) {
    const memberLabel = members[0]?.label ?? "";
    return memberLabel.includes(".") ? capitalize(fallback) : (memberLabel || capitalize(fallback));
  }
  return capitalize(fallback);
}

function dynamicCapabilityEntityLabel(entity: TargetResolverMatch): string {
  return entity.deviceName ?? entity.areaName ?? entity.entityId;
}

function dynamicCurrentMetricSentence(subjectLabel: string, watts: number): string {
  return `${subjectLabel} ${looksPluralSubject(subjectLabel) ? "are" : "is"} drawing ${formatMetricNumber(watts)} W.`;
}

function dynamicHistoryMetricSentence(subjectLabel: string, value: number, unit: string | null, windowLabel: string, approximate: boolean): string {
  const historySubject = dynamicMetricHistorySubjectLabel(subjectLabel);
  return `${historySubject} used ${approximate ? "about " : ""}${formatMetricNumber(value)}${unit ? ` ${unit}` : ""} ${spokenMetricWindowLabel(windowLabel)}.`;
}

function spokenMetricWindowLabel(windowLabel: string): string {
  if (/^last\s+\d+\s+(?:second|minute|hour|day|week|month)s?$/i.test(windowLabel)) {
    return `in the ${windowLabel}`;
  }
  return /^\d+\s+(?:second|minute|hour|day|week|month)s?$/i.test(windowLabel)
    ? `in the last ${windowLabel}`
    : windowLabel;
}

function spokenComparisonWindowLabel(windowLabel: string): string {
  return /^(?:last|previous)\s+\d+\s+(?:second|minute|hour|day|week|month)s?$/i.test(windowLabel)
    ? `in the ${windowLabel}`
    : windowLabel;
}

function dynamicComparisonMetricSentence(
  subjectLabel: string,
  left: HistoricalMetricOk,
  right: HistoricalMetricOk,
  difference: number,
  unit: string | null,
  direction: "higher" | "lower" | "same" | null,
  windows: ComparisonWindowPair,
  normalized: string,
  approximate: boolean,
): string {
  const historySubject = dynamicMetricHistorySubjectLabel(subjectLabel);
  const leftMeasurement = `${formatMetricNumber(left.value)}${left.unit ? ` ${left.unit}` : ""}`;
  const rightMeasurement = `${formatMetricNumber(right.value)}${right.unit ? ` ${right.unit}` : ""}`;
  const differenceMeasurement = `${formatMetricNumber(Math.abs(difference))}${unit ? ` ${unit}` : ""}`;
  const relation = direction ?? "same";
  const yesNo = comparisonYesNoPrefix(normalized, relation);
  const prefix = yesNo ? `${yesNo}. ` : "";
  const leftWindow = spokenComparisonWindowLabel(windows.left.label);
  const rightWindow = spokenComparisonWindowLabel(windows.right.label);
  if (relation === "same") {
    return `${prefix}${historySubject} used ${approximate ? "about the same" : "the same"} ${leftWindow} and ${rightWindow}: ${leftMeasurement} vs ${rightMeasurement}.`;
  }
  return `${prefix}${historySubject} used ${relation === "higher" ? "more" : "less"} ${leftWindow} than ${rightWindow}: ${leftMeasurement} vs ${rightMeasurement}, a ${differenceMeasurement} difference.`;
}

function dynamicMetricHistorySubjectLabel(subjectLabel: string): string {
  if (/^house$/i.test(subjectLabel)) {
    return "The house";
  }
  if (/^office$/i.test(subjectLabel)) {
    return "The office";
  }
  return subjectLabel;
}

function dynamicCompositionUsesApproximateEnergy(composition: DynamicMetricComposition): boolean {
  return composition.targets.some((target) => target.members.some((member) => member.mode === "power"));
}

function joinDynamicLabels(labels: readonly string[]): string {
  if (labels.length === 0) {
    return "That source set";
  }
  if (labels.length === 1) {
    return labels[0] as string;
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function looksPluralSubject(subjectLabel: string): boolean {
  return /\band\b|,/.test(subjectLabel);
}

function syntheticPowerMetricDefinition(label: string): MetricDefinition {
  return {
    id: "dynamic_power",
    label,
    kind: "power",
    scope: "device",
    source: "live_helper",
    unit: "W",
    aliases: [],
    normalizedAliases: [],
    entityId: null,
    statisticId: null,
    fallbackEntityIds: [],
    relatedPowerEntityId: null,
    components: [],
  };
}

function comparisonYesNoPrefix(normalized: string, direction: "higher" | "lower" | "same"): "Yes" | "No" | null {
  if (!/^(?:did|do|does|is|are|was|were|has|have|more|less|higher|lower|greater)\b/.test(normalized)) {
    return null;
  }
  const expected = /\b(more|higher|greater)\b/.test(normalized) ? "higher" : /\b(less|lower)\b/.test(normalized) ? "lower" : null;
  if (!expected) {
    return null;
  }
  return direction === expected ? "Yes" : "No";
}

function canAnswerCurrentMetric(metric: MetricDefinition, normalized: string): boolean {
  if (hasMetricTimeWindow(normalized)) {
    return false;
  }
  if (metric.kind === "power") {
    return true;
  }
  return Boolean(metric.relatedPowerEntityId)
    && /\b(power|electricity|wattage|watts?|kw|using|use|consumption|consume|consuming|draw|drawing|pull|pulled|pulling|load|output|making|putting out|generation|generating|generate|producing|production|current|currently|present|live|now|right now|status)\b/.test(normalized);
}

function currentMetricEntityIds(metric: MetricDefinition, normalized: string): readonly string[] {
  const wantsRelatedPower = metric.kind !== "power"
    && Boolean(metric.relatedPowerEntityId)
    && /\b(power|electricity|wattage|watts?|kw|using|use|consumption|consume|consuming|draw|drawing|pull|pulled|pulling|load|output|making|putting out|generation|generating|generate|producing|production|current|currently|present|live|now|right now|status)\b/.test(normalized);
  if (wantsRelatedPower) {
    return metric.relatedPowerEntityId ? [metric.relatedPowerEntityId] : [];
  }
  return [...new Set([metric.entityId, ...metric.fallbackEntityIds].filter((entityId): entityId is string => Boolean(entityId)))];
}

function numericMetricState(state: HaEntityState): string | null {
  if (isUnavailableState(state)) {
    return null;
  }
  const numeric = Number(state.state);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const unit = typeof state.attributes.unit_of_measurement === "string" && state.attributes.unit_of_measurement.trim()
    ? ` ${state.attributes.unit_of_measurement.trim()}`
    : "";
  return `${formatMetricNumber(numeric)}${unit}`;
}

function currentMetricLabel(metric: MetricDefinition, state: HaEntityState): string {
  if (metric.kind === "power" || metric.relatedPowerEntityId !== state.entityId) {
    return metric.label;
  }
  if (/\benergy$/i.test(metric.label)) {
    return metric.label.replace(/\benergy$/i, "power");
  }
  return `${metric.label} power`;
}

function currentMetricSentence(metric: MetricDefinition, state: HaEntityState, measurement: string): string {
  const label = currentMetricLabel(metric, state);
  const subject = metricSpeechSubject({ ...metric, label });
  if (/\b(?:solar|pv)\b/i.test(metric.label)) {
    return `${subject} is generating ${measurement}.`;
  }
  if (metric.kind === "power" || /\bpower$/i.test(label)) {
    return `${subject === "House" ? "The house" : subject} is drawing ${measurement}.`;
  }
  return `${subject} is ${measurement}.`;
}

function metricSpeechSubject(metric: Pick<MetricDefinition, "label" | "kind">): string {
  const cleaned = metric.label
    .replace(/\s+current\s+power$/i, "")
    .replace(/\s+total\s+power$/i, "")
    .replace(/\s+power$/i, "")
    .replace(/\s+total\s+energy$/i, "")
    .replace(/\s+consumption\s+energy$/i, "")
    .replace(/\s+import\s+energy$/i, " import")
    .replace(/\s+energy$/i, "")
    .trim();
  return cleaned || metric.label;
}

function metricEnergySubject(metric: Pick<MetricDefinition, "label" | "kind">, subject: string): string {
  if (/^house$/i.test(subject)) {
    return "The house";
  }
  if (/^office$/i.test(subject)) {
    return "The office";
  }
  return subject;
}

function metricEnergyLead(metric: Pick<MetricDefinition, "label" | "kind">, subject: string): string {
  const naturalSubject = metricEnergySubject(metric, subject);
  if (/^solar$/i.test(subject)) {
    return "Solar made";
  }
  if (/grid.*(?:import|export)/i.test(subject)) {
    return `${subject} was`;
  }
  if (metric.kind === "energy") {
    return `${naturalSubject} used`;
  }
  return `${naturalSubject} was`;
}

function metricComparisonSubject(metric: Pick<MetricDefinition, "label" | "kind">, subject: string): {
  readonly same: string;
  readonly relation: (relation: "higher" | "lower") => string;
} {
  const naturalSubject = metricEnergySubject(metric, subject);
  if (/^solar$/i.test(subject)) {
    return {
      same: "Solar made about the same",
      relation: (relation) => `Solar made ${relation === "higher" ? "more" : "less"}`,
    };
  }
  if (/grid.*(?:import|export)/i.test(subject)) {
    return {
      same: `${subject} was about the same`,
      relation: (relation) => `${subject} was ${relation}`,
    };
  }
  if (metric.kind === "energy") {
    return {
      same: `${naturalSubject} used about the same`,
      relation: (relation) => `${naturalSubject} used ${relation === "higher" ? "more" : "less"}`,
    };
  }
  return {
    same: `${naturalSubject} was about the same`,
    relation: (relation) => `${naturalSubject} was ${relation}`,
  };
}

function normalizedMetricQuestionText(normalized: string): string {
  return normalized
    .replace(/^(?:what is|what are|what s|whats|how much|how many|check|tell me|show me)\s+/, "")
    .replace(/\b(?:status|please|right now|now|currently|current|at the moment)\b/g, " ")
    .replace(/\b(?:what|is|are|was|were|did|does|do|has|have|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function metricCompatibleWithQuestion(normalized: string, metric: MetricDefinition): boolean {
  if (/\b(temperature|degrees?|celsius|fahrenheit)\b/.test(normalized)) {
    return false;
  }
  if (/\b(water|litres?|liters?)\b/.test(normalized)) {
    return metric.kind === "water";
  }
  if (/\b(gas)\b/.test(normalized)) {
    return metric.kind === "gas";
  }
  return true;
}

function looksLikeMetricWording(normalized: string): boolean {
  const frame = parseMetricIntentFrame(normalized);
  return frame.measure !== null && frame.asksForReading;
}

/** Resolve a live power reading from the metric subject, independently of how the
 * caller asks for the reading. This keeps measurement language and house/device
 * ontology as separate slots instead of growing a list of complete prompts. */
function resolveCurrentPowerMetricBySubject(catalog: MetricCatalog, normalized: string): MetricDefinition | null {
  if (!looksLikeCurrentPowerReadingIntent(normalized)) {
    return null;
  }
  const ranked = catalog.metrics
    .filter((metric) => metric.kind === "power" || Boolean(metric.relatedPowerEntityId))
    .map((metric) => ({ metric, score: currentPowerSubjectScore(metric, normalized) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);
  if (ranked.length > 0 && (ranked.length === 1 || ranked[0]!.score > ranked[1]!.score)) {
    return ranked[0]!.metric;
  }
  if (looksLikeWholeHousePowerSubject(normalized)) {
    return metricById(catalog, "house_current_power");
  }
  return null;
}

function looksLikeCurrentPowerReadingIntent(normalized: string): boolean {
  const frame = parseMetricIntentFrame(normalized);
  return frame.timeframe === "current"
    && frame.measure === "power"
    && frame.ranking === null
    && frame.asksForReading;
}

function currentPowerSubjectScore(metric: MetricDefinition, normalized: string): number {
  const phrases = [metric.label, ...metric.aliases]
    .map((value) => normalize(value))
    .map((value) => value
      .replace(/\b(current|total|power|energy|electricity|wattage|watts?|kw|load|loads|draw|drawing|use|usage|using|consumption|generated|generating|generation|producing|production|output|now)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim())
    .filter((value) => value.length >= 2);
  let best = 0;
  for (const phrase of new Set(phrases)) {
    if (new RegExp(`(?:^| )${escapeRegExp(phrase)}(?: |$)`).test(normalized)) {
      const words = phrase.split(" ").length;
      best = Math.max(best, words * 100 + phrase.length);
    }
  }
  return best;
}

function looksLikeWholeHousePowerSubject(normalized: string): boolean {
  return /\b(house|home|household|whole house|we|our)\b/.test(normalized)
    || (/\belectricity\b/.test(normalized) && /\b(using|use|consuming|consumption)\b/.test(normalized));
}

function metricTextMatchesMetric(normalized: string, metric: MetricDefinition): boolean {
  const labels = [metric.label, ...metric.aliases].map((value) => normalize(value)).filter(Boolean);
  return labels.some((label) => new RegExp(`(?:^| )${escapeRegExp(label)}(?: |$)`).test(normalized));
}

function resolveSpokenMetricQuestion(catalog: MetricCatalog, normalized: string): MetricDefinition | null {
  const flow = parseMetricIntentFrame(normalized).flow;
  if (flow === "net") return metricById(catalog, "grid_net_import_energy");
  if (flow === "export") return metricById(catalog, "grid_export_energy");
  if (flow === "import") return metricById(catalog, "grid_import_energy");
  if (looksLikeCurrentHousePowerQuestion(normalized)) {
    return metricById(catalog, "house_current_power");
  }
  if (looksLikeBareHousePowerHistoryQuestion(normalized)) {
    return metricById(catalog, "house_current_power");
  }
  if (looksLikeBareHouseConsumptionQuestion(normalized)) {
    return metricById(catalog, "house_consumption_energy");
  }
  if (looksLikeCurrentLightingPowerQuestion(normalized)) {
    return metricById(catalog, "device_lighting_energy");
  }
  return null;
}

function looksLikeCurrentHousePowerQuestion(normalized: string): boolean {
  return !hasMetricTimeWindow(normalized)
    && (
      (/\b(power|electricity|load|watts?|kw|draw|drawing)\b/.test(normalized)
        && /\b(what|what s|whats|how much|is|are|check|current|currently|usage)\b/.test(normalized)
        && /\b(using|used|use|being used|drawing|draw|pulling|pull|current|currently|now|right now|at the moment|status)\b/.test(normalized))
      || new RegExp(String.raw`\b(?:house|home)\b.*\busing\b.*\b${NOW_PATTERN}\b`).test(normalized)
    )
    && !/\b(grid|solar|pv|panels?|battery|water|gas|refrigeration|fridge|fridges|freezer|lighting|lights|kitchen|office|printer|echo|bedroom|room|tv|lounge|washing|washer|computer)\b/.test(normalized);
}

function looksLikeBareHousePowerHistoryQuestion(normalized: string): boolean {
  const frame = parseMetricIntentFrame(normalized);
  return frame.timeframe === "history"
    && frame.measure === "power"
    && frame.aggregation !== null
    && !/\b(grid|solar|battery|water|gas|refrigeration|fridge|freezer|lighting|lights|kitchen|office|printer|echo|bedroom|room|tv|lounge|washing|washer)\b/.test(normalized);
}

function looksLikeBareHouseConsumptionQuestion(normalized: string): boolean {
  const frame = parseMetricIntentFrame(normalized);
  return frame.timeframe === "history"
    && frame.measure === "energy"
    && (/\b(i|we|our|house|home|household)\b/.test(normalized) || /\belectricity\b/.test(normalized))
    && !/\b(grid|solar|battery|water|gas|refrigeration|fridge|freezer|lighting|lights|kitchen|office|printer|echo|bedroom|room|tv|lounge|washing|washer)\b/.test(normalized);
}

function looksLikeCurrentLightingPowerQuestion(normalized: string): boolean {
  return !hasMetricTimeWindow(normalized)
    && /\b(light|lights|lighting)\b/.test(normalized)
    && /\b(power|watts?|kw|using|use|draw|drawing|load|current|currently|now|right now|at the moment|status)\b/.test(normalized)
    && /\b(what|what s|whats|how much|is|are|check|show|tell me|current|currently|status|using)\b/.test(normalized);
}

function looksLikeStateOnlyQuestionWithMetricContext(normalized: string): boolean {
  return (firstStateWord(normalized) !== null || /\blit\b/.test(normalized))
    && /\b(grid|solar|battery|water|gas)\b/.test(normalized)
    && !/\b(power|energy|electricity|kwh|kw|watts?|usage|consumption|using|import|imported|export|exported|generated|generation|producing|production|current|now|right now)\b/.test(normalized);
}

/** A metric word naming a device ("the water leak detector", "the solar lights"), not the measure. */
const METRIC_WORD_STATUS_OBJECT = new RegExp(String.raw`\b(?:${DEVICE_STATUS_PATTERN}|sofa|cupboard|kettle)\b`);

function looksLikeMetricWordStatusTarget(normalized: string): boolean {
  return /\b(grid|solar|battery|water|gas)\b/.test(normalized)
    && METRIC_WORD_STATUS_OBJECT.test(normalized)
    && !/\b(power|energy|electricity|kwh|kw|watts?|usage|consumption|using|import|imported|export|exported|generated|generation|producing|production|current|now|right now)\b/.test(normalized);
}

function numericMetricPointFromState(state: HaEntityState, metric: MetricDefinition): { readonly value: number; readonly unit: string | null } | null {
  if (isUnavailableState(state)) {
    return null;
  }
  const value = Number(state.state);
  if (!Number.isFinite(value)) {
    return null;
  }
  const unit = typeof state.attributes.unit_of_measurement === "string" && state.attributes.unit_of_measurement.trim()
    ? state.attributes.unit_of_measurement.trim()
    : metric.unit;
  return { value, unit };
}

function powerPointWatts(point: { readonly value: number; readonly unit: string | null }): number | null {
  const unit = (point.unit ?? "W").toLowerCase();
  if (unit === "w" || unit === "watt" || unit === "watts") {
    return point.value;
  }
  if (unit === "kw" || unit === "kilowatt" || unit === "kilowatts") {
    return point.value * 1000;
  }
  return null;
}

function rankingMetricLabel(metric: MetricDefinition): string {
  return metric.label.replace(/\s+energy$/i, "");
}

function lastMonthBaselineWindow(now: Date): TimeWindow {
  const end = now.toISOString();
  const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    start,
    end,
    timezone: DEFAULT_TIMEZONE,
    label: "same-time average over the last month",
    source: "rolling_duration",
    confidence: "medium",
  };
}

function energyBudgetReading(routes: MetricRouteServices, now: Date, monthIndex: number, usedKwh?: number | null): EnergyBudgetReading | null {
  const cache = routes.stateCache;
  if (!cache || cache.size() === 0) {
    return null;
  }
  const month = ENERGY_BUDGET_MONTHS[monthIndex];
  if (!month) {
    return null;
  }
  const entityIds: string[] = [];
  const get = (entityId: string): HaEntityState | null => {
    const state = cache.get(entityId);
    if (state && !entityIds.includes(entityId)) {
      entityIds.push(entityId);
    }
    return state;
  };
  const isCurrent = monthIndex === localMonthIndex(now, DEFAULT_TIMEZONE);
  // The house's monthly budget sensors (house.json energy); a house without them has no budget.
  const energy = houseConfig().energy;
  const monthly = (pattern: string | null) => (pattern ? get(pattern.replaceAll("{month}", month.key)) : null);
  const budgetState = (isCurrent && energy.monthlyBudget ? get(energy.monthlyBudget) : monthly(energy.monthlyBudgetPattern))
    ?? monthly(energy.monthlyBudgetPattern);
  // The house's own helpers, else the kWh figure set on the House page (its usage worked out by the caller).
  const pageBudget = budgetState === null && usedKwh !== undefined ? energy.monthlyBudgetKwh : null;
  const budget = numericStateValue(budgetState) ?? pageBudget;
  if (budget === null) {
    return null;
  }
  const actualState = monthly(energy.monthlyActualPattern);
  const actual = numericStateValue(actualState);
  const usedState = isCurrent && energy.monthlyUsed ? get(energy.monthlyUsed) : null;
  const reportedState = isCurrent && energy.monthlyReportedLoad ? get(energy.monthlyReportedLoad) : null;
  const projectedState = isCurrent ? selectedEnergyProjectionState(cache, get, budget, numericStateValue(usedState) ?? 0) : null;
  const used = numericStateValue(usedState);
  const reportedFormula = numericAttribute(usedState, "reported_formula_kwh") ?? numericStateValue(reportedState);
  const integratedPower = numericAttribute(usedState, "power_integrated_kwh");
  const displayUsed = used ?? reportedFormula ?? integratedPower ?? (pageBudget !== null ? usedKwh ?? null : null);
  const selectedSource = textAttribute(usedState, "selected_source");
  const sourceStatus = textAttribute(usedState, "status");
  const reportAgeMinutes = numericAttribute(usedState, "report_age_minutes");
  const rawAgeMinutes = numericAttribute(usedState, "raw_age_minutes");
  const projected = numericStateValue(projectedState);
  const projectionDelta = numericAttribute(projectedState, "projection_delta") ?? (projected !== null ? projected - budget : null);
  const remainingDailyTarget = numericAttribute(projectedState, "remaining_daily_target");
  const risk = textAttribute(projectedState, "risk");
  const reason = textAttribute(projectedState, "reason");
  const label = textAttribute(projectedState, "label");
  const daysInMonth = daysInLocalMonth(now, DEFAULT_TIMEZONE);
  const dayOfMonth = dayInTimezone(now, DEFAULT_TIMEZONE);
  const hourFrac = hourFractionInTimezone(now, DEFAULT_TIMEZONE);
  const elapsedDays = Math.max(dayOfMonth - 1 + hourFrac, 0.1);
  const remainingDays = Math.max(daysInMonth - elapsedDays, 0);
  const remaining = displayUsed !== null ? Math.max(0, budget - displayUsed) : null;
  const dailyTarget = remainingDailyTarget ?? (remaining !== null && remainingDays > 0 ? Math.max(remaining, 0) / remainingDays : null);
  const monthPct = (dayOfMonth / daysInMonth) * 100;
  const percentUsed = displayUsed !== null && budget > 0 ? (displayUsed / budget) * 100 : null;
  const trackingRatio = percentUsed !== null && monthPct > 0 ? percentUsed / monthPct : null;
  return {
    monthIndex,
    monthKey: month.key,
    monthLabel: month.label,
    isCurrent,
    budget,
    actual,
    used: displayUsed,
    remaining,
    percentUsed,
    trackingRatio,
    projected,
    projectionDelta,
    dailyTarget,
    risk,
    reason,
    label,
    selectedSource,
    sourceStatus,
    reportAgeMinutes,
    rawAgeMinutes,
    reportedFormula,
    integratedPower,
    formulaParts: {
      pv: numericAttribute(reportedState, "pv_kwh"),
      grid: numericAttribute(reportedState, "grid_kwh"),
      batteryDischarge: numericAttribute(reportedState, "battery_discharge_kwh"),
      feedin: numericAttribute(reportedState, "feedin_kwh"),
      batteryCharge: numericAttribute(reportedState, "battery_charge_kwh"),
    },
    // The suggested caps and Reposit history are the house with the helper sensors' own (the owner's).
    suggestedCap: pageBudget === null ? ENERGY_BUDGET_SUGGESTED_CAPS[monthIndex] ?? null : null,
    history: pageBudget === null ? ENERGY_BUDGET_REPOSIT_HISTORY[month.key] ?? [] : [],
    sourceEntities: entityIds,
  };
}

function selectedEnergyProjectionState(
  cache: HaStateCache,
  get: (entityId: string) => HaEntityState | null,
  budget: number,
  usedForCalc: number,
): HaEntityState | null {
  const [engine, smart] = houseConfig().energy.monthlyProjection;
  if (!engine) return null;
  let state = get(engine);
  if (state) {
    const engineUsed = numericAttribute(state, "used_kwh");
    const engineBudget = numericAttribute(state, "budget_kwh");
    const matches = engineUsed !== null && engineBudget !== null
      && Math.abs(engineUsed - usedForCalc) < 0.2
      && Math.abs(engineBudget - budget) < 0.2;
    if (matches) {
      return state;
    }
  }
  state = smart ? cache.get(smart) : null;
  return state ?? cache.get(engine);
}

function energyBudgetSummarySentence(reading: EnergyBudgetReading): string {
  if (!reading.isCurrent) {
    return energyBudgetMonthBudgetSentence(reading);
  }
  const used = reading.used !== null ? formatMetricNumber(reading.used) : "unknown";
  const remaining = reading.remaining !== null ? `${formatMetricNumber(reading.remaining)} kWh left` : "remaining allowance unknown";
  const projection = reading.projected !== null && reading.projectionDelta !== null
    ? `Projected finish is ${formatMetricNumber(reading.projected)} kWh, ${energyBudgetDeltaText(reading.projectionDelta)}.`
    : "Projection is unavailable.";
  return `For ${reading.monthLabel}, you've used ${used} of ${formatMetricNumber(reading.budget)} kWh, with ${remaining}. ${projection}`;
}

function energyBudgetUsedSentence(reading: EnergyBudgetReading): string {
  if (!reading.isCurrent && reading.actual !== null) {
    return `${reading.monthLabel} captured actual is ${formatMetricNumber(reading.actual)} kWh against a ${formatMetricNumber(reading.budget)} kWh allowance.`;
  }
  if (reading.used === null) {
    return `I have the ${reading.monthLabel} allowance, but the current Reposit-style usage is unavailable.`;
  }
  return `You've used ${formatMetricNumber(reading.used)} of ${formatMetricNumber(reading.budget)} kWh for ${reading.monthLabel}.`;
}

function energyBudgetRemainingSentence(reading: EnergyBudgetReading): string {
  if (!reading.isCurrent) {
    return energyBudgetMonthBudgetSentence(reading);
  }
  if (reading.remaining === null) {
    return "The allowance is loaded, but current usage is unavailable so I cannot calculate remaining kWh.";
  }
  const daily = reading.dailyTarget !== null ? ` That is about ${formatMetricNumber(reading.dailyTarget)} kWh per day from here.` : "";
  return `You have about ${formatMetricNumber(reading.remaining)} kWh left from the ${formatMetricNumber(reading.budget)} kWh ${reading.monthLabel} allowance.${daily}`;
}

function energyBudgetProjectionSentence(reading: EnergyBudgetReading, normalized: string): string {
  if (!reading.isCurrent || reading.projected === null || reading.projectionDelta === null) {
    return reading.isCurrent ? "The budget projection is unavailable right now." : energyBudgetMonthBudgetSentence(reading);
  }
  const yesNo = /^(?:am|are|is|will|would|do|does|did|can|could)\b/.test(normalized)
    ? energyBudgetYesNo(normalized, reading.projectionDelta)
    : null;
  const prefix = yesNo ? `${yesNo}. ` : "";
  if (energyRiskLabel(reading.risk ?? "") === "safe") {
    return `${prefix}You're on track. At the current rate, the projected finish is ${formatMetricNumber(reading.projected)} kWh, ${energyBudgetDeltaText(reading.projectionDelta)} the ${formatMetricNumber(reading.budget)} kWh allowance.`;
  }
  const riskSentence = reading.risk ? energyRiskSentence(reading.risk) : "";
  const risk = riskSentence ? ` ${riskSentence}` : "";
  return `${prefix}Projected finish is ${formatMetricNumber(reading.projected)} kWh, ${energyBudgetDeltaText(reading.projectionDelta)} the ${formatMetricNumber(reading.budget)} kWh allowance.${risk}`;
}

function energyBudgetDailyTargetSentence(reading: EnergyBudgetReading): string {
  if (!reading.isCurrent || reading.dailyTarget === null) {
    return reading.isCurrent ? "I cannot calculate the daily target from the budget sources right now." : energyBudgetMonthBudgetSentence(reading);
  }
  return `To stay under the ${reading.monthLabel} allowance, average about ${Math.round(reading.dailyTarget)} kWh per day for the rest of the month.`;
}

function energyBudgetMonthBudgetSentence(reading: EnergyBudgetReading): string {
  const suggested = reading.suggestedCap !== null ? ` The Reposit-history suggested cap is ${formatMetricNumber(reading.suggestedCap)} kWh.` : "";
  const actual = reading.actual !== null && reading.actual > 0 ? ` Captured actual is ${formatMetricNumber(reading.actual)} kWh.` : "";
  return `${reading.monthLabel} allowance is ${formatMetricNumber(reading.budget)} kWh.${actual}${suggested}`;
}

function energyBudgetSuggestedCapSentence(reading: EnergyBudgetReading): string {
  if (reading.suggestedCap === null) {
    return `I don't have a Reposit-history suggested cap for ${reading.monthLabel}.`;
  }
  return `The Reposit-history suggested ${reading.monthLabel} cap is ${formatMetricNumber(reading.suggestedCap)} kWh. The current allowance is ${formatMetricNumber(reading.budget)} kWh.`;
}

function energyBudgetHistorySentence(reading: EnergyBudgetReading, now: Date, normalized: string): string {
  if (reading.history.length === 0) {
    return `I don't have Reposit history for ${reading.monthLabel} yet.`;
  }
  if (/\blast year\b/.test(normalized)) {
    const lastYear = localYear(now, DEFAULT_TIMEZONE) - 1;
    const row = reading.history.find((entry) => entry.year === lastYear);
    if (row) {
      return `${reading.monthLabel} last year was ${formatMetricNumber(row.kwh)} kWh${row.note ? ` ${row.note}` : ""}.`;
    }
  }
  const rows = reading.history.map((row) => `${row.year}: ${formatMetricNumber(row.kwh)} kWh${row.note ? ` ${row.note}` : ""}`).join(", ");
  return `${reading.monthLabel} Reposit history: ${rows}.`;
}

function energyBudgetHistoryCoverageSentence(): string {
  const monthLabels = ENERGY_BUDGET_MONTHS
    .filter((month) => (ENERGY_BUDGET_REPOSIT_HISTORY[month.key]?.length ?? 0) > 0)
    .map((month) => month.label);
  return `I have Reposit history for ${energyBudgetListSentence(monthLabels)}.`;
}

function energyBudgetFormulaSentence(reading: EnergyBudgetReading): string {
  const parts = reading.formulaParts;
  const formula = "FoxESS PV plus grid plus battery discharge, minus feed-in and battery charge";
  if ([parts.pv, parts.grid, parts.batteryDischarge, parts.feedin, parts.batteryCharge].every((value) => value !== null) && reading.reportedFormula !== null) {
    return `Reposit-style usage uses ${formula}. This month: ${formatMetricNumber(parts.pv as number)} + ${formatMetricNumber(parts.grid as number)} + ${formatMetricNumber(parts.batteryDischarge as number)} - ${formatMetricNumber(parts.feedin as number)} - ${formatMetricNumber(parts.batteryCharge as number)} = ${formatMetricNumber(reading.reportedFormula)} kWh.`;
  }
  const source = energyBudgetSourceLabel(reading);
  return `Reposit-style usage uses ${formula}. The current month total source is ${source}.`;
}

function looksLikeEnergyBudgetFormulaComponentQuestion(normalized: string): boolean {
  const batteryOrFeed = /\b(feed ?in|feed-in|battery charge|battery charging|battery discharge|battery discharging)\b/.test(normalized)
    && /\b(reposit|foxess|usage|total|count|counts|counted|reduce|minus|subtract|include|included|electricity)\b/.test(normalized);
  const gridOrSolar = /\b(grid|pv|solar)\b/.test(normalized)
    && /\b(reposit|foxess|formula|calculation|count|counts|counted|include|included)\b/.test(normalized)
    && !/\b(today|yesterday|last|past|this morning|tonight)\b/.test(normalized);
  return batteryOrFeed || gridOrSolar;
}

function energyBudgetFormulaComponentSentence(reading: EnergyBudgetReading, normalized: string): string {
  if (/\b(feed ?in|feed-in)\b/.test(normalized)) {
    const value = reading.formulaParts.feedin;
    return `Yes. Feed-in is subtracted from the Reposit-style usage${value !== null ? `; this month it subtracts ${formatMetricNumber(value)} kWh` : ""}.`;
  }
  if (/\bbattery charge|battery charging\b/.test(normalized)) {
    const value = reading.formulaParts.batteryCharge;
    return `Yes. Battery charging is subtracted from the Reposit-style usage${value !== null ? `; this month it subtracts ${formatMetricNumber(value)} kWh` : ""}.`;
  }
  if (/\bbattery discharge|battery discharging\b/.test(normalized)) {
    const value = reading.formulaParts.batteryDischarge;
    return `Yes. Battery discharge counts into the Reposit-style usage${value !== null ? `; this month it adds ${formatMetricNumber(value)} kWh` : ""}.`;
  }
  if (/\b(grid)\b/.test(normalized)) {
    const value = reading.formulaParts.grid;
    return `Yes. Grid consumption counts into the Reposit-style usage${value !== null ? `; this month it adds ${formatMetricNumber(value)} kWh` : ""}.`;
  }
  if (/\b(pv|solar)\b/.test(normalized)) {
    const value = reading.formulaParts.pv;
    return `Yes. FoxESS PV generation counts into the Reposit-style usage${value !== null ? `; this month it adds ${formatMetricNumber(value)} kWh` : ""}.`;
  }
  return energyBudgetFormulaSentence(reading);
}

function energyBudgetSourceStatusSentence(reading: EnergyBudgetReading, normalized: string): string {
  const source = energyBudgetSourceLabel(reading);
  if (/\b(recent|fresh|age|how old)\b/.test(normalized)) {
    const ages = [
      reading.reportAgeMinutes !== null ? `FoxESS report ${formatMetricNumber(reading.reportAgeMinutes)} minutes old` : null,
      reading.rawAgeMinutes !== null ? `raw fallback ${formatMetricNumber(reading.rawAgeMinutes)} minutes old` : null,
    ].filter((value): value is string => value !== null);
    return ages.length > 0 ? `The monthly usage reading is current enough: ${ages.join(", ")}.` : `The monthly usage source is ${source}, but I don't have its age.`;
  }
  if (/\b(healthy|status|ok|okay)\b/.test(normalized)) {
    const status = reading.sourceStatus ? energyRiskLabel(reading.sourceStatus) : "unknown";
    return `The monthly usage source is ${source}; status is ${status}.`;
  }
  return `The monthly usage source is ${source}; I'm reading ${reading.sourceEntities.join(", ")}.`;
}

function energyBudgetPercentSentence(reading: EnergyBudgetReading): string {
  if (reading.percentUsed === null || reading.used === null) {
    return "I have the budget, but current usage is unavailable so I cannot calculate the percentage.";
  }
  return `You've used about ${formatMetricNumber(reading.percentUsed)}% of the ${reading.monthLabel} allowance: ${formatMetricNumber(reading.used)} of ${formatMetricNumber(reading.budget)} kWh.`;
}

function energyBudgetDeltaText(delta: number): string {
  if (Math.abs(delta) < 0.5) {
    return "on target";
  }
  return `${formatMetricNumber(Math.abs(delta))} kWh ${delta > 0 ? "over" : "under"}`;
}

function energyBudgetYesNo(normalized: string, delta: number): "Yes" | "No" | null {
  const asksOver = /\b(over|exceed|exceeding|blow|above|too high|risk)\b/.test(normalized);
  const asksUnder = /\b(under|below|safe|okay|ok|within|on target)\b/.test(normalized);
  if (asksOver) {
    return delta > 0 ? "Yes" : "No";
  }
  if (asksUnder) {
    return delta <= 0 ? "Yes" : "No";
  }
  return null;
}

function energyRiskLabel(value: string): string {
  return value.replace(/_/g, " ");
}

/**
 * The projection engine's risk bands (scripts/energy_projection.py
 * risk_label): projected over the allowance, within 5% of it, within 15%,
 * or clear. The band name is a code, not speech, so an unknown band says
 * nothing rather than reading the code out.
 */
function energyRiskSentence(value: string): string {
  switch (value.trim()) {
    case "likely_over":
      return "That's probably over.";
    case "risk":
      return "That's cutting it close.";
    case "watch":
      return "Worth keeping an eye on.";
    case "safe":
      return "That remains within the allowance.";
    default:
      return "";
  }
}

function energyBudgetSourceLabel(reading: EnergyBudgetReading): string {
  if (reading.selectedSource === "report_formula") {
    return "FoxESS report";
  }
  if (reading.selectedSource === "integrated_power") {
    return "live power fallback";
  }
  if (reading.reportedFormula !== null) {
    return "last known FoxESS report";
  }
  return "unavailable";
}

function energyBudgetListSentence(items: readonly string[]): string {
  if (items.length <= 2) {
    return items.join(" and ");
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function parseEnergyBudgetMonthIndex(normalized: string, now: Date): number | null {
  if (/\bthis month\b/.test(normalized)) {
    return localMonthIndex(now, DEFAULT_TIMEZONE);
  }
  if (/\bnext month\b/.test(normalized)) {
    return (localMonthIndex(now, DEFAULT_TIMEZONE) + 1) % 12;
  }
  if (/\b(last|previous) month\b/.test(normalized)) {
    return (localMonthIndex(now, DEFAULT_TIMEZONE) + 11) % 12;
  }
  const index = ENERGY_BUDGET_MONTHS.findIndex((month) => new RegExp(`\\b${month.key}\\b|\\b${month.short}\\b`).test(normalized));
  return index >= 0 ? index : null;
}

function hasEnergyBudgetMonthName(normalized: string): boolean {
  return ENERGY_BUDGET_MONTHS.some((month) => new RegExp(`\\b${month.key}\\b|\\b${month.short}\\b`).test(normalized));
}

function localMonthIndex(date: Date, timezone: string): number {
  const month = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    month: "numeric",
  }).format(date);
  const index = Number(month) - 1;
  return Number.isFinite(index) ? Math.max(0, Math.min(11, index)) : date.getUTCMonth();
}

function localYear(date: Date, timezone: string): number {
  const year = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
  }).format(date);
  const value = Number(year);
  return Number.isFinite(value) ? value : date.getUTCFullYear();
}

function dayInTimezone(date: Date, timezone: string): number {
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "numeric",
  }).format(date);
  const value = Number(day);
  return Number.isFinite(value) ? value : date.getUTCDate();
}

function hourFractionInTimezone(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return ((Number.isFinite(hour) ? hour : 0) + (Number.isFinite(minute) ? minute : 0) / 60) / 24;
}

function daysInLocalMonth(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
  }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    return new Date(date.getUTCFullYear(), date.getUTCMonth() + 1, 0).getUTCDate();
  }
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function numericStateValue(state: HaEntityState | null): number | null {
  if (!state || isUnavailableState(state)) {
    return null;
  }
  const value = Number(state.state);
  return Number.isFinite(value) ? value : null;
}

function numericAttribute(state: HaEntityState | null, key: string): number | null {
  if (!state || isUnavailableState(state)) {
    return null;
  }
  const value = Number(state.attributes[key]);
  return Number.isFinite(value) ? value : null;
}

function textAttribute(state: HaEntityState | null, key: string): string | null {
  if (!state || isUnavailableState(state)) {
    return null;
  }
  const value = state.attributes[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatMetricNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/g, "").replace(/\.$/, "");
}

function formatBaselineNumber(value: number, unit: string | null): string {
  return /^w(?:att)?s?$/i.test(String(unit ?? "").trim()) ? String(Math.round(value)) : formatMetricNumber(value);
}
