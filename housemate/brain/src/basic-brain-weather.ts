import { type OutdoorAdviceSlots } from "./intent-parser.js";
import { cognitiveFeatureEnabled } from "./cognitive-control.js";
import type { BasicSpeechRenderPlan } from "./basic-speech-response.js";
import { MemoryStore, memoryStorePath } from "./memory-store.js";
import {
  normalizeMeasuredRoutingText as normalize,
  looksLikeKnowledgeContentReadRequest,
} from "./routing-text.js";
import { isTrustedSpeakerTrust, resolveSpeakerPrincipal } from "./speaker-principal.js";
import { friendlyName, type HaEntityState, type HaStateCache, isUnavailableState } from "./ha-state-cache.js";
import { type HaDailyWeatherForecastPoint, type HaWeatherForecastFetcher, type HaWeatherForecastPoint } from "./ha-weather-forecast.js";
import type { SpeechTone } from "./speech-tone.js";
import { type VoiceBrainRequest } from "./voice-brain.js";
import {
  canonicalNumericStatusUnit,
  parseNumericStatusComparison,
  type NumericStatusComparison,
} from "./entity-status-intent.js";
import { isRecord } from "./value-guards.js";
import { capitalize, formatNumber, lowerInitial } from "./text-format.js";
import { declined, ok } from "./basic-brain-contracts.js";
import { hourInTimezone, localDateOffset, localWeekday } from "./zoned-time.js";
import {
  COMPARATOR_PATTERN,
  FOLLOW_UP_OPENER_PATTERN,
  INDOOR_SCOPE_WORD,
  OUTDOOR_PATTERN,
  WEATHER_WORD,
  WEEKDAY_NAMES,
  WEEKDAY_PATTERN,
} from "./lexicon.js";
import { displayPersonName } from "./household.js";
import { HOUSE_LOCALE, HOUSE_TIME_ZONE, houseConfig } from "./house-config.js";

export interface WeatherConfig {
  readonly dataDir: string;
  readonly cognitiveSystemEnabled?: boolean;
  readonly cognitiveRecallEnabled?: boolean;
}

export interface WeatherRouteServices {
  readonly stateCache?: HaStateCache;
  readonly weatherForecastFetcher?: HaWeatherForecastFetcher;
}

export interface FollowUpRenderOptions {
  readonly compactFollowUp?: boolean;
}

export interface TimeSpecificWeatherMatchOptions {
  readonly allowContextOnly?: boolean;
}

interface WeatherForecastTargetOptions {
  readonly minimumIndex?: number;
}

interface DailyForecastReadingOptions {
  readonly allowNearestWeekdayFallback?: boolean;
}

interface WeatherContextFrame {
  readonly kind: "weather";
  readonly forecastIndex?: number;
  readonly forecastLabel?: string | null;
  /** A current outdoor reading was asked, so "what about inside?" can ask it of a room. */
  readonly reading?: "temperature" | "humidity";
}

export interface WeatherIntentFrame {
  readonly timeframe: "current" | "later" | "future";
  readonly field: "summary" | "temperature" | "feels_like" | "humidity" | "wind" | "rain_chance" | "rain_amount" | "sunrise" | "sunset" | null;
  readonly windMeasure: "speed" | "gust" | null;
  readonly adviceItem: "umbrella" | "jacket" | "layers" | "shoes" | null;
  readonly asksSuitability: boolean;
  readonly numericComparison: NumericStatusComparison | null;
}

export interface WeatherRouteResult {
  readonly route: "weather_query" | "memory_query";
  readonly status: "ok" | "declined";
  readonly confidence: "high" | "low";
  readonly text: string;
  readonly speechPlan?: BasicSpeechRenderPlan | null;
  readonly tone?: SpeechTone;
  readonly modelUsed: false;
  readonly resultId: null;
  readonly touchedEntities: readonly string[];
  readonly notes: string;
  readonly contextFrame?: WeatherContextFrame | null;
}

interface WeatherForecastTarget {
  readonly index: number;
  readonly label: string;
}

interface WeatherTimeTarget {
  readonly dayIndex: number;
  readonly dayLabel: string;
  readonly date: string;
  readonly hour: number;
  readonly minute: number;
  readonly relation: "at" | "after" | "before" | "around" | "by" | "from";
}

interface WeatherQuantity {
  readonly value: number;
  readonly unit: string | null;
}

interface WeatherNumericComparisonSource {
  readonly quantity: WeatherQuantity;
  readonly subject: string;
  readonly range?: {
    readonly min: WeatherQuantity;
    readonly max: WeatherQuantity;
  };
}

interface WeatherFastPathReading {
  readonly location: string;
  readonly forecastIndex: number;
  readonly forecastLabel: string | null;
  readonly condition: string | null;
  readonly temperature: WeatherQuantity | null;
  readonly feelsLike: WeatherQuantity | null;
  readonly humidity: WeatherQuantity | null;
  readonly rainSince9am: WeatherQuantity | null;
  readonly rainChance: WeatherQuantity | null;
  readonly rainAmount: string | null;
  readonly rainAmountMin: WeatherQuantity | null;
  readonly rainAmountMax: WeatherQuantity | null;
  readonly windSpeed: WeatherQuantity | null;
  readonly gustSpeed: WeatherQuantity | null;
  readonly windDirection: string | null;
  readonly forecast: string | null;
  readonly uvCategory: string | null;
  readonly uvIndex: WeatherQuantity | null;
  readonly uvForecast: string | null;
  readonly uvStartTime: string | null;
  readonly uvEndTime: string | null;
  readonly maxTemp: WeatherQuantity | null;
  readonly minTemp: WeatherQuantity | null;
  readonly laterTemp: WeatherQuantity | null;
  readonly laterLabel: string | null;
  readonly sunrise: string | null;
  readonly sunset: string | null;
  readonly contextFrame: WeatherContextFrame;
  readonly notes: string;
}

interface OutdoorAdviceSubject {
  readonly id: string;
  readonly label: string;
  readonly pronoun: "you" | "name";
}

interface OutdoorClothingPreference {
  readonly garment: string;
  readonly thresholdC: number;
}

interface ClothingDecision {
  readonly summary: string;
  readonly advice: string;
  readonly wet: boolean;
  readonly windy: boolean;
}

const WEATHER_TEMPERATURE_CHANGE_PATTERN = "(?:be|become|get|reach|hit|rise|climb|fall|drop|remain|stay|end up)";
const DEICTIC_CURRENT_TEMPERATURE_COMPARISON = new RegExp(
  `\\b(?:is|are)\\s+it\\s+${COMPARATOR_PATTERN}\\b`,
);
const DEICTIC_MODAL_TEMPERATURE_COMPARISON = new RegExp(
  `\\b(?:will|would|could|can|may|might|should)\\s+it\\s+${WEATHER_TEMPERATURE_CHANGE_PATTERN}\\s+${COMPARATOR_PATTERN}\\b`,
);
const DEICTIC_EMBEDDED_MODAL_TEMPERATURE_COMPARISON = new RegExp(
  `\\bit\\s+(?:will|would|could|can|may|might|should)\\s+${WEATHER_TEMPERATURE_CHANGE_PATTERN}\\s+${COMPARATOR_PATTERN}\\b`,
);
const DEICTIC_PERIPHRASTIC_TEMPERATURE_COMPARISON = new RegExp(
  `\\b(?:is|are)\\s+it\\s+(?:going|expected|predicted|forecast|likely|supposed)\\s+to\\s+${WEATHER_TEMPERATURE_CHANGE_PATTERN}\\s+${COMPARATOR_PATTERN}\\b`,
);
const PROSPECTIVE_WEATHER_COMPARISON = new RegExp(
  `\\b(?:will|would|could|can|may|might|should|expected|predicted|forecast|going to)\\b[^?.]{0,80}\\b${WEATHER_TEMPERATURE_CHANGE_PATTERN}\\s+${COMPARATOR_PATTERN}\\b`,
);
const HISTORICAL_WEATHER_COMPARISON = new RegExp(
  `\\b(?:was|were|did|had)\\b[^?.]{0,80}\\b${COMPARATOR_PATTERN}\\b`,
);

interface ClothingBase {
  readonly summary: string;
  readonly advice: string;
}

export interface WeatherContextReference {
  readonly forecastIndex?: number;
  readonly forecastLabel?: string | null;
}

/** The house's own place name, from its Bureau-style weather sensors ("sensor.springfield" -> "springfield"). */
const WEATHER_PLACE = houseConfig().weather.sensorPrefix?.replace(/^sensor\./, "").replace(/_/g, " ") ?? null;
const DEFAULT_TIMEZONE = HOUSE_TIME_ZONE;
export function looksLikeWeatherContextFollowUp(normalized: string): boolean {
  return (
    /^(?:and |what about |how about |what if |if |do i |should i |should |does that mean |is (?:a|an|the|sun protection|rain gear|wet weather gear)|that means |(?:can you )?(?:tell me|check)(?: if| whether)? )/.test(normalized)
      && /\b(weather|outside|out|rain|raining|rains|umbrella|jacket|coat|jumper|wear|dress|warm|cold|wind|humidity|uv|sun|protection|layers?)\b/.test(normalized)
  ) || /^(?:(?:the )?weather(?:\s+.+)?|rain(?:ing|s| later)?|if it rains|what about if it rains|an? umbrella|the umbrella|the wind|wind|a jacket|the jacket|jacket|coat|jumper|layers?|sun protection)(?:\s+(?:too|as well))?\??$/.test(normalized);
}

export function looksLikeWeatherForecastFollowUp(normalized: string, now: Date = new Date()): boolean {
  return parseWeatherForecastTarget(normalized, now) !== null
    && (
      new RegExp(String.raw`^${FOLLOW_UP_OPENER_PATTERN} `).test(normalized)
      || /\bweather\b/.test(normalized)
      || new RegExp(String.raw`^(?:same(?: for)?|for )?(?:today|tonight|tomorrow|${WEEKDAY_PATTERN})\??$`).test(normalized)
    );
}

export function looksLikeOutdoorAdviceFollowUp(normalized: string): boolean {
  return /\b(umbrella|jacket|coat|jumper|wear|dress|warm|take|bring|need|should|sun protection)\b/.test(normalized);
}

// Longest vague-verb weather question ("what's it doing outside this afternoon").
const WEATHER_VAGUE_QUESTION_MAX_WORDS = 10;

export function looksLikeWeatherFastPathQuestion(normalized: string): boolean {
  if (looksLikeKnowledgeContentReadRequest(normalized)) {
    return false;
  }
  if (/\bsensors?\b/.test(normalized)) {
    return false;
  }
  if (looksLikeNonWeatherWindMetricQuestion(normalized)) {
    return false;
  }
  const frame = parseWeatherIntentFrame(normalized);
  if (frame.adviceItem && frame.asksSuitability) {
    return true;
  }
  if (frame.field === "feels_like") {
    return true;
  }
  const outdoorScope = /\b(?:out|outside|outdoor|outdoors|weather|forecast)\b/.test(normalized)
    || (WEATHER_PLACE !== null && normalized.includes(WEATHER_PLACE));
  const indoorScope = INDOOR_SCOPE_WORD.test(normalized);
  // "like", "look" and "doing" only ask about the weather in a short question
  // ("what's it like out"); in a long statement they are ordinary words
  // ("cheeky stuff like breaking out").
  const weatherPredicate = WEATHER_WORD.test(normalized)
    || (/\b(?:like|look|looking|doing)\b/.test(normalized) && normalized.split(/\s+/).filter(Boolean).length <= WEATHER_VAGUE_QUESTION_MAX_WORDS);
  // A place name plus a time is not weather intent (cinema listings are the
  // obvious counterexample). A timed forecast still needs a weather field;
  // location only scopes meaning after weather ownership already exists.
  const timedForecast = frame.timeframe !== "current" && frame.field !== null && !indoorScope;
  const inherentlyOutdoorField = frame.field === "wind" || frame.field === "rain_chance" || frame.field === "rain_amount"
    || frame.field === "sunrise" || frame.field === "sunset";
  const deicticOutdoorField = (frame.field === "temperature" || frame.field === "humidity")
    && /\b(?:it|outside|out)\b/.test(normalized)
    && !indoorScope;
  const deicticOutdoorConditions = new RegExp(String.raw`^(?:what|how)\b.*\bit\b.*\b${OUTDOOR_PATTERN}\b`).test(normalized);
  return (outdoorScope && weatherPredicate)
    || deicticOutdoorConditions
    || inherentlyOutdoorField
    || deicticOutdoorField
    || timedForecast
    || (frame.field !== null
      && new RegExp(String.raw`\b(?:today|tonight|tomorrow|later|${WEEKDAY_PATTERN})\b`).test(normalized)
      && !indoorScope);
}

/**
 * "Feels like" is a weather field only when the weather is what feels
 * the feels-like/apparent
 * temperature as a noun, a bare "feels like?", or a question whose subject of
 * "feel" is the weather or a dummy "it" ("what does it feel like outside",
 * "how cold does it feel"). A person feeling something ("do you feel like
 *...") is ordinary talk, and so is a statement ("it also feels like I'm
 * talking to something conscious").
 */
function looksLikeFeelsLikeAsk(normalized: string): boolean {
  if (/\b(?:apparent|feels?[ -]?like) (?:temp|temperature|reading)\b/.test(normalized) || /\breal feel\b/.test(normalized)) {
    return true;
  }
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length <= 4 && /^(?:(?:and|so|what about|what is|what s|whats)\s+)*(?:the\s+)?feels?[ -]?like$/.test(normalized)) {
    return true;
  }
  const feel = words.findIndex((word) => /^feel(?:s|ing)?$/.test(word));
  if (feel < 0) return false;
  // The subject sits straight before the verb, past any -ly adverb.
  let subject = feel - 1;
  while (subject >= 0 && /ly$/.test(words[subject] ?? "")) subject -= 1;
  const weatherSubject = /^(?:it|weather|temperature|temp|air)$/.test(words[subject] ?? "");
  const interrogative = /^(?:(?:and|so)\s+)?(?:what|how|does|do|did|is|will|would)\b/.test(normalized);
  // A clause after the verb makes "it" a placeholder for that clause, not the
  // weather: "how does it feel to live here", "...like being you", "...when".
  const afterAt = words[feel + 1] === "like" ? feel + 2 : feel + 1;
  const after = words[afterAt] ?? "";
  // A gerund opens a clause ("like being you"); "-ing to" is a preposition ("according to").
  const clausalComplement = /^(?:to|when|if|that|whether)$/.test(after) || (/ing$/.test(after) && words[afterAt + 1] !== "to");
  return weatherSubject && interrogative && !clausalComplement;
}

/** Extract weather meaning independently of conversational scaffolding. */
export function parseWeatherIntentFrame(normalized: string): WeatherIntentFrame {
  const timeframe: WeatherIntentFrame["timeframe"] = new RegExp(String.raw`\b(?:tomorrow|${WEEKDAY_PATTERN})\b`).test(normalized)
    ? "future"
    : /\b(?:tonight|later|afternoon|evening|next few hours|coming hours)\b/.test(normalized)
      ? "later"
      : "current";
  const numericComparison = parseNumericStatusComparison(normalized);
  const outdoorNumericTemperature = numericComparison !== null
    && (/\b(?:outside|outdoor|outdoors|weather|forecast)\b/.test(normalized)
      || hasDeicticTemperatureComparisonFrame(normalized));
  const adviceItem: WeatherIntentFrame["adviceItem"] = /\b(?:umbrella|rain gear|rain jacket)\b/.test(normalized)
    ? "umbrella"
    : /\b(?:jacket|coat|jumper|warm layer)\b/.test(normalized)
      ? "jacket"
      : /\b(?:layer|layers|layered clothing)\b/.test(normalized)
        ? "layers"
        : /\b(?:shoe|shoes|footwear|sandals)\b/.test(normalized)
          ? "shoes"
          : null;
  const asksSuitability = adviceItem !== null
    && /\b(?:should|need|wear|take|bring|grab|weather|suit|suits|suitable|make sense|good idea|bad idea|avoid|enough)\b/.test(normalized);
  const rain = /\b(?:rain|raining|rainfall|precipitation|showers?)\b/.test(normalized);
  const amount = /\b(?:amount|how much|how many|heavy|heaviest|peak|maximum|max|most|wettest|millimetres?|millimeters?|mm)\b/.test(normalized);
  const chance = /\b(?:chance|likely|likelihood|probability|will it)\b/.test(normalized);
  const windMeasure: WeatherIntentFrame["windMeasure"] = looksLikeNonWeatherWindMetricQuestion(normalized)
    ? null
    : /\bgusts?\b/.test(normalized)
    ? "gust"
    : /\b(?:wind|windy)\b/.test(normalized)
      ? "speed"
      : null;
  const field: WeatherIntentFrame["field"] = /\bsunrise\b/.test(normalized)
    ? "sunrise"
    : /\bsunset\b/.test(normalized)
      ? "sunset"
    : looksLikeFeelsLikeAsk(normalized)
    ? "feels_like"
    : rain && amount
      ? "rain_amount"
      : rain && chance
        ? "rain_chance"
        : /\b(?:humidity|humid)\b/.test(normalized)
          ? "humidity"
          : windMeasure !== null
            ? "wind"
            : /\b(?:temperature|temp|how cold|how warm)\b/.test(normalized) || outdoorNumericTemperature
              ? "temperature"
              : /\b(?:weather|forecast|conditions?|outside|outdoor|outdoors)\b/.test(normalized)
                ? "summary"
                : null;
  return { timeframe, field, windMeasure, adviceItem, asksSuitability, numericComparison };
}

/**
 * A bare future `it` only implies outdoor temperature when it participates in
 * a copular or change-of-state comparison. Other predicates such as cost,
 * weight, and duration retain their own meaning.
 */
function hasDeicticTemperatureComparisonFrame(normalized: string): boolean {
  return DEICTIC_CURRENT_TEMPERATURE_COMPARISON.test(normalized)
    || DEICTIC_MODAL_TEMPERATURE_COMPARISON.test(normalized)
    || DEICTIC_EMBEDDED_MODAL_TEMPERATURE_COMPARISON.test(normalized)
    || DEICTIC_PERIPHRASTIC_TEMPERATURE_COMPARISON.test(normalized);
}

export function looksLikeNonWeatherWindMetricQuestion(normalized: string): boolean {
  return /\bwind\s+(?:power|energy|electricity|turbines?|generators?|farms?)\b/.test(normalized)
    || /\bwind\s+(?:turbines?|generators?)\b[^?.]{0,60}\b(?:power|energy|output|generation|producing|generating)\b/.test(normalized);
}

export function looksLikeTimeSpecificWeatherQuestion(
  normalized: string,
  options: TimeSpecificWeatherMatchOptions = {},
): boolean {
  const hasClock = hasClockReference(normalized);
  if (!hasClock) {
    return false;
  }
  if (hasExplicitWeatherIntent(normalized)) {
    return true;
  }
  return Boolean(options.allowContextOnly) && hasTimeReferenceAnchor(normalized);
}

export async function timeSpecificWeatherAnswer(
  routes: WeatherRouteServices,
  now: Date,
  normalized: string,
  context: WeatherContextReference | null,
): Promise<WeatherRouteResult> {
  const target = parseWeatherTimeTarget(normalized, now, context);
  if (!target) {
    return weatherFastPathAnswer(routes, now, normalized);
  }
  const entityId = hourlyWeatherEntityId(routes);
  if (entityId && routes.weatherForecastFetcher) {
    try {
      const forecast = await routes.weatherForecastFetcher.fetchHourly(entityId);
      const matching = matchingHourlyForecastPoints(forecast, target);
      if (matching.length > 0) {
        return {
          ...ok("weather_query", hourlyWeatherSummarySentence(matching, target, normalized), `hourly weather forecast from ${entityId}`, { kind: "weather", forecastIndex: target.dayIndex, forecastLabel: target.dayLabel }),
          tone: wetTone(hourlyRainSummary(matching).likely),
        };
      }
    } catch (error) {
      const fallback = await dailyFallbackForTimeSpecificWeather(routes, target);
      if (fallback) {
        return fallback;
      }
      return declined("weather_query", "I could not read the hourly weather forecast just now.", `hourly weather forecast failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const fallback = await dailyFallbackForTimeSpecificWeather(routes, target);
  if (fallback) {
    return fallback;
  }
  return declined("weather_query", `I don't have hourly weather for ${target.dayLabel} ${weatherClockPhrase(normalized) ?? "that time"} wired here.`, "time-specific weather requested; no hourly forecast source or daily fallback");
}

export async function weatherFastPathAnswer(
  routes: WeatherRouteServices,
  now: Date,
  normalized: string,
  options: FollowUpRenderOptions = {},
): Promise<WeatherRouteResult> {
  const target = parseWeatherForecastTarget(normalized, now);
  const weather = weatherFastPathReading(routes, target) ?? await fetchDailyForecastWeatherReading(routes, target);
  if (!weather) {
    return declined("weather_query", "I can't see live weather state yet.", "weather requested; no usable BOM/weather state");
  }
  const decision = clothingDecision(weather, null, now);
  const speechPlan = weather.forecastIndex === 0 && !options.compactFollowUp
    ? {
      kind: "weather_now",
      summary: decision.summary,
      location: weather.location,
      temperatureText: weather.temperature ? renderWeatherQuantity(weather.temperature) : null,
      feelsLikeText: weather.feelsLike ? renderWeatherQuantity(weather.feelsLike) : null,
      windy: decision.windy,
      rainLikely: decision.wet,
    } satisfies BasicSpeechRenderPlan
    : null;
  const numericComparison = targetedWeatherNumericComparisonAnswer(weather, normalized);
  if (numericComparison?.outcome === "answered") {
    return ok("weather_query", numericComparison.text, weather.notes, weather.contextFrame);
  }
  if (numericComparison?.outcome === "declined") {
    return declined("weather_query", numericComparison.text, `${weather.notes}; ${numericComparison.notes}`);
  }
  const later = await targetedLaterWeatherFactAnswer(routes, now, normalized);
  if (later) {
    return ok("weather_query", later.text, `${weather.notes}; ${later.notes}`, weather.contextFrame);
  }
  const targeted = targetedWeatherFactAnswer(weather, normalized, decision, options);
  if (targeted) {
    return ok("weather_query", targeted, weather.notes, withCurrentReading(weather, normalized));
  }
  return {
    ...ok("weather_query", weatherSummarySentence(weather, now, options), weather.notes, weather.contextFrame, speechPlan),
    tone: wetTone(decision.wet),
  };
}

/**
 * Open chat's weather read: today's reading and the next days'
 * forecasts, in the words the weather route speaks, from the same sources.
 */
export async function weatherOutlookLines(routes: WeatherRouteServices, now: Date, daysAhead: number): Promise<string> {
  const dayNames = WEEKDAY_NAMES;
  const today = localWeekday(now, DEFAULT_TIMEZONE);
  const lines: string[] = [];
  for (let index = 0; index <= daysAhead; index += 1) {
    const target: WeatherForecastTarget = {
      index,
      label: index === 0 ? "today" : index === 1 ? "tomorrow" : dayNames[(today + index) % 7] as string,
    };
    const weather = weatherFastPathReading(routes, target) ?? await fetchDailyForecastWeatherReading(routes, target);
    if (weather) lines.push(weatherSummarySentence(weather, now));
  }
  return lines.length > 0 ? lines.join("\n") : "The weather readings are unavailable right now.";
}

function targetedWeatherNumericComparisonAnswer(
  weather: WeatherFastPathReading,
  normalized: string,
): { readonly outcome: "answered"; readonly text: string }
  | { readonly outcome: "declined"; readonly text: string; readonly notes: string }
  | null {
  const frame = parseWeatherIntentFrame(normalized);
  const comparison = frame.numericComparison;
  if (!comparison) return null;
  if (HISTORICAL_WEATHER_COMPARISON.test(normalized)) {
    return {
      outcome: "declined",
      text: "I don't have historical weather readings for that comparison.",
      notes: "historical numeric weather comparison has no source",
    };
  }
  const prospective = frame.timeframe !== "current"
    || PROSPECTIVE_WEATHER_COMPARISON.test(normalized)
    || new RegExp(String.raw`\b(?:get|reach|hit|rise|climb)\s+(?:(?:to|back)\s+)?${COMPARATOR_PATTERN}\b`).test(normalized);
  const source = weatherNumericComparisonSource(weather, frame, prospective, comparison.operator);
  if (!source) {
    return {
      outcome: "declined",
      text: "I don't have a compatible weather reading for that comparison.",
      notes: "numeric weather comparison source unavailable",
    };
  }
  if (source.range) {
    const min = weatherQuantityInUnit(source.range.min, comparison.unit);
    const max = weatherQuantityInUnit(source.range.max, comparison.unit);
    if (!min || !max || min.unit !== max.unit) {
      return {
        outcome: "declined",
        text: "That weather comparison uses a unit I can't match to the source.",
        notes: "numeric weather range unit incompatible",
      };
    }
    const definitelyMatches = comparison.operator === "less_than"
      ? max.value < comparison.threshold
      : min.value > comparison.threshold;
    const definitelyDoesNotMatch = comparison.operator === "less_than"
      ? min.value >= comparison.threshold
      : max.value <= comparison.threshold;
    const rangeText = `${renderWeatherQuantity(min)} to ${renderWeatherQuantity(max)}`;
    const threshold = renderWeatherQuantity({ value: comparison.threshold, unit: min.unit });
    const relation = comparison.operator === "less_than" ? "below" : "above";
    if (!definitelyMatches && !definitelyDoesNotMatch) {
      return {
        outcome: "declined",
        text: `${source.subject} is ${rangeText}, so ${threshold} sits inside that range.`,
        notes: "numeric weather range straddles threshold",
      };
    }
    return {
      outcome: "answered",
      text: `${definitelyMatches ? "Yes" : "No"}. ${source.subject} is ${rangeText}, ${definitelyMatches ? relation : `not ${relation}`} ${threshold}.`,
    };
  }
  const quantity = weatherQuantityInUnit(source.quantity, comparison.unit);
  if (!quantity) {
    return {
      outcome: "declined",
      text: "That weather comparison uses a unit I can't match to the source.",
      notes: "numeric weather comparison unit incompatible",
    };
  }
  const matches = comparison.operator === "less_than"
    ? quantity.value < comparison.threshold
    : quantity.value > comparison.threshold;
  const relation = comparison.operator === "less_than" ? "below" : "above";
  const threshold = renderWeatherQuantity({ value: comparison.threshold, unit: quantity.unit });
  return {
    outcome: "answered",
    text: `${matches ? "Yes" : "No"}. ${source.subject} is ${renderWeatherQuantity(quantity)}, ${matches ? relation : `not ${relation}`} ${threshold}.`,
  };
}

function weatherNumericComparisonSource(
  weather: WeatherFastPathReading,
  frame: WeatherIntentFrame,
  prospective: boolean,
  operator: NumericStatusComparison["operator"],
): WeatherNumericComparisonSource | null {
  if (frame.field === "temperature") {
    if (frame.timeframe === "later" && weather.laterTemp) {
      return { quantity: weather.laterTemp, subject: "The later outdoor temperature" };
    }
    const extreme = operator === "less_than" ? "low" : "high";
    const quantity = prospective
      ? operator === "less_than" ? weather.minTemp : weather.maxTemp
      : weather.temperature;
    if (!quantity) return null;
    const subject = prospective
      ? frame.timeframe === "future"
        ? `${capitalize(weather.forecastLabel ?? "that day")}'s forecast ${extreme}`
        : frame.timeframe === "later"
          ? `The later forecast ${extreme}`
          : `Today's forecast ${extreme}`
      : "The outdoor temperature";
    return { quantity, subject };
  }
  if (frame.field === "feels_like" && weather.feelsLike) {
    return { quantity: weather.feelsLike, subject: "The apparent temperature" };
  }
  if (frame.field === "humidity" && weather.humidity) {
    return { quantity: weather.humidity, subject: "Outdoor humidity" };
  }
  if (frame.field === "wind") {
    const quantity = frame.windMeasure === "gust" ? weather.gustSpeed : weather.windSpeed;
    return quantity ? { quantity, subject: frame.windMeasure === "gust" ? "The gust speed" : "The wind speed" } : null;
  }
  if (frame.field === "rain_chance" && weather.rainChance) {
    return { quantity: weather.rainChance, subject: "The chance of rain" };
  }
  if (frame.field === "rain_amount") {
    if (!weather.rainAmountMin || !weather.rainAmountMax) return null;
    return {
      quantity: operator === "less_than" ? weather.rainAmountMax : weather.rainAmountMin,
      subject: "The forecast rain amount",
      range: { min: weather.rainAmountMin, max: weather.rainAmountMax },
    };
  }
  return null;
}

function weatherQuantityInUnit(
  source: WeatherQuantity,
  requestedUnit: string | null,
): WeatherQuantity | null {
  const sourceUnit = canonicalNumericStatusUnit(source.unit);
  const targetUnit = requestedUnit ?? sourceUnit;
  if (!targetUnit) return { value: source.value, unit: null };
  if (sourceUnit === targetUnit) return { value: source.value, unit: targetUnit };
  if (sourceUnit === "°C" && targetUnit === "°F") {
    return { value: (source.value * 9) / 5 + 32, unit: "°F" };
  }
  if (sourceUnit === "°F" && targetUnit === "°C") {
    return { value: ((source.value - 32) * 5) / 9, unit: "°C" };
  }
  return null;
}

async function targetedLaterWeatherFactAnswer(
  routes: WeatherRouteServices,
  now: Date,
  normalized: string,
): Promise<{ readonly text: string; readonly notes: string } | null> {
  const frame = parseWeatherIntentFrame(normalized);
  if (frame.timeframe !== "later" || !routes.weatherForecastFetcher) {
    return null;
  }
  const entityId = hourlyWeatherEntityId(routes);
  if (!entityId) {
    return null;
  }
  try {
    const forecast = await routes.weatherForecastFetcher.fetchHourly(entityId);
    const future = forecast.filter((point) => Date.parse(point.datetime) >= now.getTime());
    if (future.length === 0) {
      return null;
    }
    const rainValues = future.map((point) => point.precipitation).filter((value): value is number => value !== null);
    const rainChance = future.map((point) => point.precipitationProbability).filter((value): value is number => value !== null);
    const maxRain = rainValues.length > 0 ? Math.max(...rainValues) : null;
    const maxChance = rainChance.length > 0 ? Math.max(...rainChance) : null;
    const rainy = (maxRain !== null && maxRain > 0) || (maxChance !== null && maxChance >= 40)
      || future.some((point) => /\b(?:rain|rainy|showers?|storm)\b/i.test(point.condition ?? ""));
    if (frame.field === "rain_amount" && maxRain !== null) {
      return { text: `Later rain could reach ${formatNumber(maxRain)} mm.`, notes: `hourly weather forecast from ${entityId}` };
    }
    const temperatures = future.map((point) => point.temperature).filter((value): value is number => value !== null);
    const temperature = temperatures.length > 0 ? Math.max(...temperatures) : null;
    const temperatureText = temperature !== null ? `, around ${formatNumber(temperature)} °C` : "";
    return {
      text: rainy ? `Rain looks likely later${temperatureText}.` : `It looks dry later${temperatureText}.`,
      notes: `hourly weather forecast from ${entityId}`,
    };
  } catch {
    return null;
  }
}

export async function weatherForecastFollowUpAnswer(
  routes: WeatherRouteServices,
  now: Date,
  normalized: string,
  context: WeatherContextReference | null,
  options: FollowUpRenderOptions = {},
): Promise<WeatherRouteResult> {
  const target = parseWeatherForecastTarget(normalized, now, {
    minimumIndex: forecastFollowUpMinimumIndex(context),
  }) ?? weatherForecastTargetFromContext(context);
  const weather = weatherFastPathReading(routes, target) ?? await fetchDailyForecastWeatherReading(routes, target, {
    allowNearestWeekdayFallback: true,
  });
  if (!weather) {
    return declined("weather_query", "I can't see live weather state yet.", "weather forecast follow-up requested; no usable BOM/weather state");
  }
  return {
    ...ok("weather_query", weatherSummarySentence(weather, now, options), weather.notes, weather.contextFrame),
    tone: wetTone(clothingDecision(weather, null, now).wet),
  };
}

export async function outdoorWeatherAdviceAnswer(
  config: WeatherConfig,
  request: VoiceBrainRequest,
  slots: OutdoorAdviceSlots,
  routes: WeatherRouteServices,
  now: Date,
  options: FollowUpRenderOptions = {},
): Promise<WeatherRouteResult> {
  const normalized = normalize(request.transcript);
  const target = parseWeatherForecastTarget(normalized, now);
  const weather = weatherFastPathReading(routes, target) ?? await fetchDailyForecastWeatherReading(routes, target);
  if (!weather) {
    return declined("weather_query", "I can't see live weather state yet.", "outdoor clothing advice requested; no usable weather state");
  }
  const subject = outdoorAdviceSubject(request, slots);
  const preference = subject ? outdoorClothingPreference(config, subject.id) : null;
  const advice = clothingAdviceSentence(subject, preference, weather, now, normalized, options);
  return {
    ...ok("weather_query", advice, `${weather.notes}; outdoor advice from weather fast path${preference ? " and accepted memory" : ""}`, weather.contextFrame),
    tone: wetTone(clothingDecision(weather, preference, now).wet),
  };
}

function weatherForecastTargetFromContext(
  context: WeatherContextReference | null,
): WeatherForecastTarget | null {
  return context && typeof context.forecastIndex === "number"
    ? { index: context.forecastIndex, label: context.forecastLabel ?? (context.forecastIndex === 0 ? "today" : `day ${context.forecastIndex}`) }
    : null;
}

function parseWeatherForecastTarget(
  normalized: string,
  now: Date,
  options: WeatherForecastTargetOptions = {},
): WeatherForecastTarget | null {
  if (/\btomorrow\b/.test(normalized)) {
    return { index: 1, label: "tomorrow" };
  }
  if (/\btoday|tonight\b/.test(normalized)) {
    return { index: 0, label: "today" };
  }
  const dayNames = WEEKDAY_NAMES;
  const requestedDay = dayNames.find((day) => new RegExp(`\\b${day}\\b`).test(normalized));
  if (!requestedDay) {
    return null;
  }
  const today = localWeekday(now, DEFAULT_TIMEZONE);
  const requested = dayNames.indexOf(requestedDay);
  const rawDiff = (requested - today + 7) % 7;
  let index = rawDiff === 0 && /\bnext\b/.test(normalized) ? 7 : rawDiff;
  while (index < (options.minimumIndex ?? 0)) {
    index += 7;
  }
  if (index < 0 || index > 7) {
    return null;
  }
  return { index, label: requestedDay };
}

function hasClockReference(normalized: string): boolean {
  return /\b(?:after|before|around|at|by|from)\s+(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:am|pm)?\b/.test(normalized)
    || /\b(?:[1-9]|1[0-2])\s*(?:am|pm)\b/.test(normalized);
}

function hasExplicitWeatherIntent(normalized: string): boolean {
  return /\b(weather|forecast|rain|raining|showers?|temperature|temp|cold|chilly|cool|warm|hot|wind|windy|humidity|humid|outside)\b/.test(normalized);
}

function hasTimeReferenceAnchor(normalized: string): boolean {
  return new RegExp(String.raw`\b(today|tonight|tomorrow|${WEEKDAY_PATTERN})\b`).test(normalized)
    || /^i meant\b/.test(normalized)
    || /^what about\b/.test(normalized);
}

function forecastFollowUpMinimumIndex(
  context: WeatherContextReference | null,
): number {
  return context && typeof context.forecastIndex === "number" && context.forecastIndex > 0
    ? context.forecastIndex
    : 0;
}

function parseWeatherTimeTarget(
  normalized: string,
  now: Date,
  context: WeatherContextReference | null,
): WeatherTimeTarget | null {
  const clock = parseClockTarget(normalized);
  if (!clock) {
    return null;
  }
  const explicitTarget = parseWeatherForecastTarget(normalized, now);
  const upcomingDayIndex = inferredUpcomingWeatherDayIndex(clock, now);
  const contextDayIndex = typeof context?.forecastIndex === "number"
    ? Math.max(context.forecastIndex, upcomingDayIndex)
    : null;
  const resolvedDayIndex = explicitTarget
    ? explicitTarget.index
    : contextDayIndex ?? upcomingDayIndex;
  const dayLabel = explicitTarget?.label
    ?? (context?.forecastLabel && context.forecastIndex === resolvedDayIndex ? context.forecastLabel : null)
    ?? (resolvedDayIndex === 0 ? "today" : resolvedDayIndex === 1 ? "tomorrow" : `day ${resolvedDayIndex}`);
  return {
    dayIndex: resolvedDayIndex,
    dayLabel,
    date: localDateOffset(now, DEFAULT_TIMEZONE, resolvedDayIndex),
    hour: clock.hour,
    minute: clock.minute,
    relation: clock.relation,
  };
}

function inferredUpcomingWeatherDayIndex(
  clock: Pick<WeatherTimeTarget, "hour" | "minute" | "relation">,
  now: Date,
): number {
  const nowMinutes = localClockMinutes(now, DEFAULT_TIMEZONE);
  const targetMinutes = clock.hour * 60 + clock.minute;
  return targetMinutes < nowMinutes ? 1 : 0;
}

function parseClockTarget(normalized: string): Pick<WeatherTimeTarget, "hour" | "minute" | "relation"> | null {
  const match = /\b(after|before|around|at|by|from)\s+([01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?\b/.exec(normalized)
    ?? /\b([1-9]|1[0-2])(?::([0-5]\d))?\s*(am|pm)\b/.exec(normalized);
  if (!match) {
    return null;
  }
  const hasRelation = match.length >= 5;
  const relation = (hasRelation ? match[1] : "at") as WeatherTimeTarget["relation"];
  const rawHour = Number(hasRelation ? match[2] : match[1]);
  const rawMinute = Number((hasRelation ? match[3] : match[2]) ?? 0);
  const meridiem = (hasRelation ? match[4] : match[3]) ?? "";
  if (!Number.isFinite(rawHour) || !Number.isFinite(rawMinute)) {
    return null;
  }
  let hour = rawHour;
  if (meridiem === "am" && hour === 12) {
    hour = 0;
  } else if (meridiem === "pm" && hour < 12) {
    hour += 12;
  } else if (!meridiem && hour >= 1 && hour <= 11 && /\b(tonight|evening|night|after)\b/.test(normalized)) {
    hour += 12;
  }
  return { hour, minute: rawMinute, relation };
}

function weatherClockPhrase(normalized: string): string | null {
  const match = /\b(?:after|before|around|at|by|from)\s+((?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:am|pm)?)\b/.exec(normalized)
    ?? /\b((?:[1-9]|1[0-2])\s*(?:am|pm))\b/.exec(normalized);
  return match?.[1]?.replace(/\s+/g, " ").toUpperCase() ?? null;
}

function hourlyWeatherEntityId(routes: WeatherRouteServices): string | null {
  const entries = routes.stateCache?.entries() ?? [];
  const hourly = entries.find((state) => state.entityId.startsWith("weather.") && /\bhourly\b/i.test(friendlyName(state)));
  const configured = houseConfig().weather.hourlyEntity;
  return hourly?.entityId ?? (configured && routes.stateCache?.get(configured) ? configured : null);
}

function dailyWeatherEntityId(routes: WeatherRouteServices): string | null {
  const cache = routes.stateCache;
  const configured = houseConfig().weather.entity;
  return (configured ? cache?.get(configured)?.entityId : undefined)
    ?? cache?.get("weather.home")?.entityId
    ?? null;
}

async function dailyFallbackForTimeSpecificWeather(routes: WeatherRouteServices, target: WeatherTimeTarget): Promise<WeatherRouteResult | null> {
  const weather = weatherFastPathReading(routes, { index: target.dayIndex, label: target.dayLabel })
    ?? await fetchDailyForecastWeatherReading(routes, { index: target.dayIndex, label: target.dayLabel }, {
      allowNearestWeekdayFallback: true,
    });
  if (!weather) {
    return null;
  }
  return ok(
    "weather_query",
    `I don't have the hourly breakdown for ${target.dayLabel} ${formatClockTarget(target)}, but ${forecastWeatherSummarySentence(weather)}`,
    `${weather.notes}; hourly weather unavailable, daily forecast used as fallback`,
    weather.contextFrame,
  );
}

async function fetchDailyForecastWeatherReading(
  routes: WeatherRouteServices,
  target: WeatherForecastTarget | null,
  options: DailyForecastReadingOptions = {},
): Promise<WeatherFastPathReading | null> {
  if (!target || !routes.weatherForecastFetcher) {
    return null;
  }
  const entityId = dailyWeatherEntityId(routes);
  if (!entityId) {
    return null;
  }
  let forecast: readonly HaDailyWeatherForecastPoint[];
  try {
    forecast = await routes.weatherForecastFetcher.fetchDaily(entityId);
  } catch {
    return null;
  }
  const resolved = resolveDailyForecastTarget(forecast, target, options);
  if (!resolved) {
    return null;
  }
  const weatherEntity = routes.stateCache?.get(entityId) ?? null;
  const condition = resolved.point.condition?.replace(/_/g, " ") ?? null;
  const precipitation = resolved.point.precipitation;
  const rainAmount = precipitation !== null && precipitation > 0 ? formatNumber(precipitation) : null;
  const fallbackNotes = resolved.usedNearestWeekdayFallback ? `; nearest ${target.label} within daily forecast horizon` : "";
  return {
    location: weatherEntity ? friendlyName(weatherEntity) : "Outside",
    forecastIndex: target.index,
    forecastLabel: target.label,
    condition,
    temperature: null,
    feelsLike: null,
    humidity: null,
    rainSince9am: null,
    rainChance: dailyWeatherQuantity(resolved.point.precipitationProbability, "%"),
    rainAmount,
    rainAmountMin: dailyWeatherQuantity(precipitation, "mm"),
    rainAmountMax: dailyWeatherQuantity(precipitation, "mm"),
    windSpeed: null,
    gustSpeed: null,
    windDirection: null,
    forecast: null,
    uvCategory: null,
    uvIndex: null,
    uvForecast: null,
    uvStartTime: null,
    uvEndTime: null,
    maxTemp: dailyWeatherQuantity(resolved.point.temperature, "°C"),
    minTemp: dailyWeatherQuantity(resolved.point.templow, "°C"),
    laterTemp: null,
    laterLabel: null,
    sunrise: null,
    sunset: null,
    contextFrame: { kind: "weather", forecastIndex: target.index, forecastLabel: target.label },
    notes: `daily weather forecast from ${entityId}${fallbackNotes}`,
  };
}

function resolveDailyForecastTarget(
  forecast: readonly HaDailyWeatherForecastPoint[],
  target: WeatherForecastTarget,
  options: DailyForecastReadingOptions,
): { readonly point: HaDailyWeatherForecastPoint; readonly index: number; readonly usedNearestWeekdayFallback: boolean } | null {
  const direct = forecast[target.index];
  if (direct) {
    return { point: direct, index: target.index, usedNearestWeekdayFallback: false };
  }
  if (!options.allowNearestWeekdayFallback || !isWeekdayLabel(target.label)) {
    return null;
  }
  const fallbackIndex = forecast.findIndex((point) => dailyForecastWeekday(point.datetime) === target.label);
  if (fallbackIndex < 0) {
    return null;
  }
  return {
    point: forecast[fallbackIndex] as HaDailyWeatherForecastPoint,
    index: fallbackIndex,
    usedNearestWeekdayFallback: true,
  };
}

function weatherFastPathReading(routes: WeatherRouteServices, target: WeatherForecastTarget | null = null): WeatherFastPathReading | null {
  const cache = routes.stateCache;
  if (!cache || cache.size() === 0) {
    return null;
  }
  const forecastIndex = target?.index ?? 0;
  const suffix = String(forecastIndex);
  const entityIds: string[] = [];
  const addSource = (state: HaEntityState | null): HaEntityState | null => {
    if (state && !entityIds.includes(state.entityId)) {
      entityIds.push(state.entityId);
    }
    return state;
  };
  const get = (entityId: string): HaEntityState | null => addSource(cache.get(entityId));
  const weather = houseConfig().weather;
  // The house's Bureau-style sensor family (`sensor.<town>_temp`...), when it has one.
  const local = (name: string): HaEntityState | null => (weather.sensorPrefix ? get(`${weather.sensorPrefix}_${name}`) : null);
  const optional = (entityId: string | null): HaEntityState | null => (entityId ? get(entityId) : null);
  const weatherEntity = (weather.entity ? get(weather.entity) : null) ?? get("weather.home");
  const temp = forecastIndex === 0 ? weatherNumber(
    local("temp"),
    "state",
  ) ?? weatherAttributeNumber(weatherEntity, "temperature", weatherEntity ? weatherAttributeUnit(weatherEntity, "temperature_unit") : null)
    ?? weatherNumber(optional(weather.outsideTemperature), "state") : null;
  const feelsLike = forecastIndex === 0 ? weatherNumber(local("temp_feels_like"), "state") : null;
  const humidity = forecastIndex === 0 ? weatherNumber(local("humidity"), "state")
    ?? weatherAttributeNumber(weatherEntity, "humidity", "%") : null;
  const rainSince9am = forecastIndex === 0 ? weatherNumber(local("rain_since_9am"), "state") : null;
  const rainChance = weatherNumber(local(`rain_chance_${suffix}`), "state");
  const rainAmount = cleanStateText(local(`rain_amount_range_${suffix}`));
  const rainAmountMin = weatherNumber(local(`rain_amount_min_${suffix}`), "state");
  const rainAmountMax = weatherNumber(local(`rain_amount_max_${suffix}`), "state");
  const windSpeed = forecastIndex === 0 ? weatherNumber(local("wind_speed_kilometre"), "state")
    ?? weatherNumber(optional(weather.outsideWindSpeed), "state")
    ?? weatherAttributeNumber(weatherEntity, "wind_speed", weatherEntity ? weatherAttributeUnit(weatherEntity, "wind_speed_unit") : null) : null;
  const gustSpeed = forecastIndex === 0 ? weatherNumber(local("gust_speed_kilometre"), "state") : null;
  const windDirection = forecastIndex === 0 ? cleanStateText(local("wind_direction")) ?? weatherAttributeText(weatherEntity, "wind_bearing") : null;
  const shortForecast = cleanStateText(local(`short_text_${suffix}`));
  const extendedForecast = cleanStateText(local(`extended_text_${suffix}`));
  const uvCategory = cleanStateText(local(`uv_category_${suffix}`));
  const uvIndex = weatherNumber(local(`uv_max_index_${suffix}`), "state");
  const uvForecast = cleanStateText(local(`uv_forecast_${suffix}`));
  const uvStartTime = cleanStateText(local(`uv_start_time_${suffix}`));
  const uvEndTime = cleanStateText(local(`uv_end_time_${suffix}`));
  const maxTemp = weatherNumber(local(`temp_max_${suffix}`), "state") ?? (forecastIndex === 0 ? weatherNumber(local("max_temp"), "state") : null);
  const minTemp = weatherNumber(local(`temp_min_${suffix}`), "state") ?? (forecastIndex === 0 ? weatherNumber(local("min_temp"), "state") : null);
  const laterTemp = forecastIndex === 0 ? weatherNumber(local("now_temp_later"), "state") : null;
  const laterLabel = forecastIndex === 0 ? cleanStateText(local("now_later_label")) : null;
  const sunrise = cleanStateText(local(`astronomical_sunrise_time_${suffix}`));
  const sunset = cleanStateText(local(`astronomical_sunset_time_${suffix}`));
  const condition = shortForecast ?? (forecastIndex === 0 ? weatherCondition(weatherEntity) : null);

  if (!temp && !condition && !humidity && !rainSince9am && !rainChance && !windSpeed && !extendedForecast && !uvIndex && !maxTemp && !minTemp && !sunrise && !sunset) {
    return null;
  }

  return {
    location: weatherEntity ? friendlyName(weatherEntity) : "Outside",
    forecastIndex,
    forecastLabel: target?.label ?? null,
    condition,
    temperature: temp,
    feelsLike,
    humidity,
    rainSince9am,
    rainChance,
    rainAmount,
    rainAmountMin,
    rainAmountMax,
    windSpeed,
    gustSpeed,
    windDirection,
    forecast: extendedForecast,
    uvCategory,
    uvIndex,
    uvForecast,
    uvStartTime,
    uvEndTime,
    maxTemp,
    minTemp,
    laterTemp,
    laterLabel,
    sunrise,
    sunset,
    contextFrame: { kind: "weather", forecastIndex, forecastLabel: target?.label ?? null },
    notes: `weather fast path from ${entityIds.join(", ")}`,
  };
}

function weatherSummarySentence(weather: WeatherFastPathReading, now: Date, options: FollowUpRenderOptions = {}): string {
  if (weather.forecastIndex > 0) {
    return forecastWeatherSummarySentence(weather);
  }
  const decision = clothingDecision(weather, null, now);
  const tempText = weather.temperature ? `, about ${renderWeatherQuantity(weather.temperature)}` : "";
  const feelsLikeText = weather.feelsLike ? `, but it feels like ${renderWeatherQuantity(weather.feelsLike)}` : "";
  const windyText = decision.windy && !/\bwindy\b/i.test(decision.summary) ? ", and windy" : "";
  const rainText = decision.wet ? " Rain's likely." : "";
  if (options.compactFollowUp) {
    return `Yes. It's ${decision.summary}${tempText}${feelsLikeText}${windyText}.${rainText}`;
  }
  return `It's ${decision.summary} in ${weather.location}${tempText}${feelsLikeText}${windyText}.${rainText}`;
}

function withCurrentReading(weather: WeatherFastPathReading, normalized: string): WeatherContextFrame {
  const frame = parseWeatherIntentFrame(normalized);
  const reading = frame.field === "temperature" || frame.field === "humidity" ? frame.field : null;
  return reading && frame.timeframe === "current" && weather.forecastIndex === 0
    ? { ...weather.contextFrame, reading }
    : weather.contextFrame;
}

function targetedWeatherFactAnswer(
  weather: WeatherFastPathReading,
  normalized: string,
  decision: ClothingDecision,
  options: FollowUpRenderOptions,
): string | null {
  const frame = parseWeatherIntentFrame(normalized);
  const location = options.compactFollowUp ? "" : ` in ${weather.location}`;
  if (frame.adviceItem && frame.asksSuitability) {
    return targetedWeatherAdviceSentence(frame.adviceItem, decision);
  }
  if (frame.field === "sunrise" || frame.field === "sunset") {
    const value = frame.field === "sunrise" ? weather.sunrise : weather.sunset;
    if (!value) return null;
    const label = frame.field === "sunrise" ? "Sunrise" : "Sunset";
    const subject = weather.forecastIndex > 0
      ? `${capitalize(weather.forecastLabel ?? "that day")}'s ${label.toLowerCase()}`
      : label;
    return `${subject}${location} is at ${formatWeatherClock(value)}.`;
  }
  if (frame.field === "feels_like" || /\b(?:feel|feels|feeling|apparent)\b/.test(normalized)) {
    const value = weather.feelsLike ?? weather.temperature;
    return value ? `It feels like ${renderWeatherQuantity(value)}${location}.` : null;
  }
  if (frame.field === "humidity") {
    return weather.humidity ? `Outdoor humidity${location} is ${renderWeatherQuantity(weather.humidity)}.` : null;
  }
  if (/\b(?:wind direction|wind bearing|which way|direction of the wind|where is the wind coming from)\b/.test(normalized)) {
    return weather.windDirection ? `The wind${location} is coming from ${weather.windDirection}.` : null;
  }
  if (frame.field === "wind") {
    const speed = weather.windSpeed ?? weather.gustSpeed;
    const direction = weather.windDirection ? `${weather.windDirection} ` : "";
    if (speed) {
      const gustTail = weather.gustSpeed && weather.windSpeed && weather.gustSpeed.value > weather.windSpeed.value
        ? `, gusting near ${renderWeatherQuantity(weather.gustSpeed)}`
        : "";
      return `Wind${location} is ${direction}about ${renderWeatherQuantity(speed)}${gustTail}.`;
    }
    return decision.windy ? `Yes, it is windy${location}.` : `No, it doesn't look especially windy${location}.`;
  }
  if (frame.field === "rain_amount" || frame.field === "rain_chance" || /\b(?:rain|raining|wet|millimetres?|millimeters?)\b/.test(normalized)) {
    if (frame.field === "rain_chance" && weather.rainChance) {
      return `The chance of rain${location} is ${renderWeatherQuantity(weather.rainChance)}.`;
    }
    if (frame.timeframe === "later" || frame.field === "rain_amount" || /\b(?:coming|expected|amount)\b/.test(normalized)) {
      const amount = weather.rainAmountMax ?? weather.rainAmountMin;
      if (amount) {
        return `Later rain could reach ${renderWeatherQuantity(amount)}.`;
      }
      if (weather.rainAmount) {
        return `Later rain is forecast at ${weather.rainAmount} mm.`;
      }
      return decision.wet ? "Rain looks likely later." : "Rain does not look likely later.";
    }
  }
  if (frame.timeframe === "later") {
    const forecast = weather.forecast ?? weather.condition;
    const temperature = weather.laterTemp ? `, around ${renderWeatherQuantity(weather.laterTemp)}` : "";
    return forecast ? `Later, it looks ${lowerInitial(forecast)}${temperature}.` : null;
  }
  if (frame.field === "temperature") {
    if (!weather.temperature) return null;
    const feelsLike = weather.feelsLike
      ? `, but it feels like ${renderWeatherQuantity(weather.feelsLike)}`
      : "";
    return `The outdoor temperature${location} is ${renderWeatherQuantity(weather.temperature)}${feelsLike}.`;
  }
  return null;
}

function formatWeatherClock(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: DEFAULT_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function targetedWeatherAdviceSentence(item: NonNullable<WeatherIntentFrame["adviceItem"]>, decision: ClothingDecision): string {
  if (item === "umbrella") {
    return decision.wet ? "Yes. Take an umbrella or rain jacket." : "No. You shouldn't need an umbrella.";
  }
  if (item === "shoes") {
    return decision.wet
      ? "Yes. Avoid open shoes; enclosed shoes or footwear that handles wet ground are a better idea."
      : "Open shoes should be fine; the ground doesn't look especially wet.";
  }
  if (item === "layers") {
    return `Yes. Layers make sense; ${decision.advice}.`;
  }
  return /\b(?:jacket|jumper|coat)\b/.test(decision.advice)
    ? `Yes. It's jacket weather; ${decision.advice}.`
    : `No. You probably won't need a jacket; ${decision.advice}.`;
}

function matchingHourlyForecastPoints(forecast: readonly HaWeatherForecastPoint[], target: WeatherTimeTarget): readonly HaWeatherForecastPoint[] {
  const sameDate = forecast.filter((point) => hourlyForecastDate(point.datetime) === target.date);
  const targetMinutes = target.hour * 60 + target.minute;
  if (target.relation === "after" || target.relation === "from") {
    return sameDate.filter((point) => hourlyForecastMinutes(point.datetime) >= targetMinutes);
  }
  if (target.relation === "before" || target.relation === "by") {
    return sameDate.filter((point) => hourlyForecastMinutes(point.datetime) <= targetMinutes);
  }
  const withDistance = sameDate
    .map((point) => ({ point, distance: Math.abs(hourlyForecastMinutes(point.datetime) - targetMinutes) }))
    .filter((item) => Number.isFinite(item.distance))
    .sort((left, right) => left.distance - right.distance);
  const closest = withDistance[0];
  return closest && closest.distance <= 90 ? [closest.point] : [];
}

function hourlyWeatherSummarySentence(points: readonly HaWeatherForecastPoint[], target: WeatherTimeTarget, normalized: string): string {
  const rain = hourlyRainSummary(points);
  const temp = numericRange(points.map((point) => point.temperature).filter((value): value is number => value !== null));
  const wind = Math.max(...points.map((point) => point.windGustSpeed ?? point.windSpeed ?? NaN).filter(Number.isFinite));
  const humid = Math.max(...points.map((point) => point.humidity ?? NaN).filter(Number.isFinite));
  const condition = commonCondition(points);
  const time = formatClockTarget(target);
  const tempText = temp ? `, around ${formatNumberRange(temp)} °C` : "";
  const windText = Number.isFinite(wind) && wind >= 25 ? `, with gusts near ${Math.round(wind)} km/h` : "";
  const humidityText = Number.isFinite(humid) && humid >= 85 && /\b(humid|humidity|gross|muggy|weather|outside)\b/.test(normalized) ? `, humidity about ${Math.round(humid)}%` : "";
  if (/\b(rain|raining|showers?|umbrella|wet)\b/.test(normalized)) {
    const rainText = rain.likely ? `rain looks likely${rain.detail}` : `rain does not look likely${rain.detail}`;
    return `For ${target.dayLabel} ${time}, ${rainText}${tempText}${windText}.`;
  }
  const summary = condition ? lowerInitial(condition.replace(/_/g, " ")) : rain.likely ? "wet" : "fair";
  return `For ${target.dayLabel} ${time}, it looks ${summary}${tempText}${windText}${humidityText}.`;
}

function hourlyRainSummary(points: readonly HaWeatherForecastPoint[]): { readonly likely: boolean; readonly detail: string } {
  const probabilities = points.map((point) => point.precipitationProbability).filter((value): value is number => value !== null);
  const precipitation = points.map((point) => point.precipitation).filter((value): value is number => value !== null);
  const text = normalize(points.map((point) => point.condition ?? "").join(" "));
  const maxProbability = probabilities.length ? Math.max(...probabilities) : null;
  const maxPrecipitation = precipitation.length ? Math.max(...precipitation) : null;
  const likely = (maxProbability !== null && maxProbability >= 40)
    || (maxPrecipitation !== null && maxPrecipitation > 0)
    || weatherKeywords(text, ["rainy", "rain", "showers", "shower", "drizzle", "storm", "thunderstorm"]);
  const probabilityRange = numericRange(probabilities);
  if (probabilityRange) {
    return { likely, detail: ` at ${formatNumberRange(probabilityRange)}%` };
  }
  if (maxPrecipitation !== null && maxPrecipitation > 0) {
    return { likely, detail: `, with about ${formatNumber(maxPrecipitation)} mm possible` };
  }
  return { likely, detail: "" };
}

function commonCondition(points: readonly HaWeatherForecastPoint[]): string | null {
  const counts = new Map<string, number>();
  for (const point of points) {
    if (point.condition) {
      counts.set(point.condition, (counts.get(point.condition) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

function hourlyForecastDate(datetime: string): string | null {
  return /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/.exec(datetime)?.[1] ?? null;
}

function hourlyForecastMinutes(datetime: string): number {
  const match = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/.exec(datetime);
  if (!match) {
    return Number.NaN;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function localClockMinutes(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function formatClockTarget(target: WeatherTimeTarget): string {
  const hour12 = target.hour % 12 || 12;
  const suffix = target.hour >= 12 ? "PM" : "AM";
  const minute = target.minute ? `:${pad2(target.minute)}` : "";
  const clock = `${hour12}${minute} ${suffix}`;
  if (target.relation === "after") {
    return `after ${clock}`;
  }
  if (target.relation === "before") {
    return `before ${clock}`;
  }
  if (target.relation === "by") {
    return `by ${clock}`;
  }
  if (target.relation === "from") {
    return `from ${clock}`;
  }
  return `around ${clock}`;
}

function numericRange(values: readonly number[]): { readonly min: number; readonly max: number } | null {
  if (values.length === 0) {
    return null;
  }
  return { min: Math.min(...values), max: Math.max(...values) };
}

function formatNumberRange(range: { readonly min: number; readonly max: number }): string {
  return range.min === range.max ? formatNumber(range.min) : `${formatNumber(range.min)} to ${formatNumber(range.max)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function dailyWeatherQuantity(value: number | null, unit: string): WeatherQuantity | null {
  return value !== null && Number.isFinite(value) ? { value, unit } : null;
}

function dailyForecastWeekday(datetime: string): string | null {
  const date = new Date(datetime);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TIMEZONE,
    weekday: "long",
  }).format(date).toLowerCase();
}

function isWeekdayLabel(label: string): boolean {
  return WEEKDAY_NAMES.includes(label);
}

function forecastWeatherSummarySentence(weather: WeatherFastPathReading): string {
  const label = weather.forecastLabel ?? `Day ${weather.forecastIndex}`;
  const condition = lowerInitial(weather.condition ?? "forecast unavailable");
  const temps = forecastTemperatureText(weather);
  const rainAmount = weather.rainAmount ? `${weather.rainAmount} mm possible` : "";
  const details = [condition, temps, rainAmount ? `with ${rainAmount}` : ""].filter(Boolean).join(", ");
  return `${capitalize(label)} in ${weather.location} looks like ${details}.`;
}

function forecastTemperatureText(weather: WeatherFastPathReading): string {
  if (weather.minTemp && weather.maxTemp) {
    return `${renderWeatherQuantity(weather.minTemp)} to ${renderWeatherQuantity(weather.maxTemp)}`;
  }
  if (weather.maxTemp) {
    return `up to ${renderWeatherQuantity(weather.maxTemp)}`;
  }
  if (weather.minTemp) {
    return `down to ${renderWeatherQuantity(weather.minTemp)}`;
  }
  return "";
}

function clothingAdviceSentence(
  subject: OutdoorAdviceSubject | null,
  preference: OutdoorClothingPreference | null,
  weather: WeatherFastPathReading,
  now: Date,
  normalized: string,
  options: FollowUpRenderOptions = {},
): string {
  const subjectText = subject?.pronoun === "you" ? "You" : subject?.label ?? "You";
  const decision = clothingDecision(weather, preference, now);
  const lead = `It's ${decision.summary} out in ${weather.location}.`;
  const subjectPrefix = subjectText === "You" ? "Wear" : `${subjectText} should wear`;
  if (options.compactFollowUp) {
    if (/\bumbrella\b/.test(normalized)) {
      return umbrellaAdviceSentence(subjectText, decision);
    }
    return `${subjectPrefix} ${decision.advice}.`;
  }
  return `${lead} ${subjectPrefix} ${decision.advice}.`;
}

function umbrellaAdviceSentence(subjectText: string, decision: ClothingDecision): string {
  if (decision.wet) {
    return subjectText === "You" ? "Take a rain jacket or umbrella." : `${subjectText} should take a rain jacket or umbrella.`;
  }
  return subjectText === "You" ? "Umbrella isn't needed." : `${subjectText} doesn't need an umbrella.`;
}

function clothingDecision(weather: WeatherFastPathReading, preference: OutdoorClothingPreference | null, now: Date): ClothingDecision {
  const effectiveTemp = weatherCelsius(weather.feelsLike) ?? weatherCelsius(weather.temperature);
  const airTemp = weatherCelsius(weather.temperature);
  const minTemp = weatherCelsius(weather.minTemp);
  const laterTemp = weatherCelsius(weather.laterTemp);
  const coldestKnown = [effectiveTemp, airTemp, minTemp, laterTemp].filter((value): value is number => value !== null).sort((left, right) => left - right)[0] ?? null;
  const maxTemp = weatherCelsius(weather.maxTemp);
  const humid = (weather.humidity?.value ?? 0) >= 70;
  const rainChance = weather.rainChance?.value ?? null;
  const rainMax = weather.rainAmountMax?.value ?? parseWeatherAmountMax(weather.rainAmount);
  const windSpeed = weather.gustSpeed?.value ?? weather.windSpeed?.value ?? null;
  const text = normalize([weather.condition, weather.forecast, weather.uvForecast].filter(Boolean).join(" "));
  const wet = (rainChance !== null && rainChance >= 40)
    || (rainMax !== null && rainMax > 0)
    || weatherKeywords(text, ["rain", "raining", "showers", "shower", "storm", "thunderstorm", "drizzle", "hail"]);
  const windy = (windSpeed !== null && windSpeed >= 25)
    || weatherKeywords(text, ["windy", "gust", "gusty", "squall"]);
  const stormy = weatherKeywords(text, ["storm", "thunderstorm", "hail"]);
  const uvIndex = weather.uvIndex?.value ?? null;
  const sunRisk = (uvIndex !== null && uvIndex >= 3)
    || /moderate|high|very high|extreme/i.test(weather.uvCategory ?? "")
    || /sun protection recommended/i.test(weather.uvForecast ?? "");
  const sunRiskNow = sunRisk && sunProtectionRelevantNow(weather, now);

  const base = clothingBase(coldestKnown, airTemp, maxTemp);
  const summary = weatherHumanSummary(base, wet, windy, humid, sunRiskNow);
  const adviceParts: string[] = [base.advice];

  if (preference && coldestKnown !== null && coldestKnown <= preference.thresholdC && !base.advice.includes(preference.garment)) {
    adviceParts.push(garmentWithArticle(preference.garment));
  }
  if (wet) {
    adviceParts.push("take a rain jacket or umbrella");
  }
  if (windy) {
    adviceParts.push("make the outer layer wind-resistant");
  }
  if (stormy) {
    adviceParts.push("enclosed shoes are a good idea too");
  } else if (wet) {
    adviceParts.push("wear shoes that can handle wet ground");
  }
  if (sunRiskNow) {
    adviceParts.push("use sun protection");
  }
  if (humid && ((airTemp !== null && airTemp >= 24) || (maxTemp !== null && maxTemp >= 26))) {
    adviceParts.push("breathable fabrics will help");
  }

  return { summary, advice: formatAdviceList(uniqueStrings(adviceParts)), wet, windy };
}

function outdoorAdviceSubject(request: VoiceBrainRequest, slots: OutdoorAdviceSlots): OutdoorAdviceSubject | null {
  const explicit = slots.person;
  if (explicit) {
    return { id: `person.${explicit}`, label: displayPerson(explicit), pronoun: "name" };
  }
  const principal = resolveSpeakerPrincipal(request.speaker);
  return isTrustedSpeakerTrust(principal.trust) && principal.personId && principal.label
    ? { id: principal.personId, label: principal.label, pronoun: "you" }
    : null;
}

function outdoorClothingPreference(config: WeatherConfig, subjectId: string): OutdoorClothingPreference | null {
  if (!cognitiveFeatureEnabled(config, "recall")) {
    return null;
  }
  const store = new MemoryStore(memoryStorePath(config));
  try {
    const records = store.listMemoryRecords();
    for (const record of records) {
      if (record.reviewStatus !== "accepted" || record.payload.category !== "preference" || record.payload.preferenceType !== "outdoor_clothing") {
        continue;
      }
      const recordSubject = record.payload.subjectId || record.subjectIds[0] || "";
      if (recordSubject !== subjectId && !record.subjectIds.includes(subjectId)) {
        continue;
      }
      const value = record.payload.value;
      if (!isRecord(value)) {
        continue;
      }
      const garment = typeof value.garment === "string" ? value.garment.trim() : "";
      const threshold = typeof value.threshold_c === "number" ? value.threshold_c : Number(value.threshold_c);
      if (garment && Number.isFinite(threshold)) {
        return { garment, thresholdC: threshold };
      }
    }
    return null;
  } finally {
    store.close();
  }
}

function weatherNumber(state: HaEntityState | null, source: "state"): WeatherQuantity | null {
  void source;
  if (!state || isUnavailableState(state)) {
    return null;
  }
  const value = Number(state.state);
  if (!Number.isFinite(value)) {
    return null;
  }
  return { value, unit: typeof state.attributes.unit_of_measurement === "string" ? state.attributes.unit_of_measurement : null };
}

function weatherAttributeNumber(state: HaEntityState | null, key: string, unit: string | null): WeatherQuantity | null {
  if (!state || isUnavailableState(state)) {
    return null;
  }
  const value = Number(state.attributes[key]);
  return Number.isFinite(value) ? { value, unit } : null;
}

function weatherAttributeText(state: HaEntityState | null, key: string): string | null {
  if (!state || isUnavailableState(state)) {
    return null;
  }
  const value = state.attributes[key];
  if (typeof value === "number") {
    return String(value);
  }
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function weatherAttributeUnit(state: HaEntityState, key: string): string | null {
  const value = state.attributes[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanStateText(state: HaEntityState | null): string | null {
  if (!state || isUnavailableState(state)) {
    return null;
  }
  const text = state.state.trim().replace(/[.]+$/, "");
  return text ? text : null;
}

function weatherCondition(state: HaEntityState | null): string | null {
  if (!state || isUnavailableState(state)) {
    return null;
  }
  return state.state.replace(/_/g, " ").trim() || null;
}

function renderWeatherQuantity(quantity: WeatherQuantity): string {
  if (quantity.unit === "%") {
    return `${quantity.value}%`;
  }
  return `${quantity.value}${quantity.unit ? ` ${quantity.unit}` : ""}`;
}

function garmentWithArticle(garment: string): string {
  if (/^(?:a|an|the|some)\s+/i.test(garment) || /\b(?:layers|clothes|clothing)\b/i.test(garment)) {
    return garment;
  }
  return `a ${garment}`;
}

function weatherCelsius(quantity: WeatherQuantity | null): number | null {
  if (!quantity) {
    return null;
  }
  const unit = quantity.unit?.toLowerCase() ?? "°c";
  return unit === "°c" || unit === "c" || unit === "degrees c" || unit === "degrees celsius" ? quantity.value : null;
}

function clothingBase(coldestKnown: number | null, airTemp: number | null, maxTemp: number | null): ClothingBase {
  if (coldestKnown !== null && coldestKnown <= 5) {
    return { summary: "very cold", advice: "thermal layers and a warm jacket" };
  }
  if (coldestKnown !== null && coldestKnown <= 12) {
    return { summary: "cold", advice: "warm layers and a jacket" };
  }
  if (coldestKnown !== null && coldestKnown <= 18) {
    return { summary: "cool", advice: "light layers and a jumper or light jacket" };
  }
  if ((maxTemp !== null && maxTemp >= 30) || (airTemp !== null && airTemp >= 30)) {
    return { summary: "hot", advice: "light, loose clothing" };
  }
  if ((maxTemp !== null && maxTemp >= 26) || (airTemp !== null && airTemp >= 26)) {
    return { summary: "warm", advice: "light clothing" };
  }
  return { summary: "mild", advice: "comfortable layers" };
}

function weatherHumanSummary(base: ClothingBase, wet: boolean, windy: boolean, humid: boolean, sunRiskNow: boolean): string {
  const parts = [base.summary];
  if (wet) {
    parts.push("wet");
  }
  if (windy) {
    parts.push("windy");
  }
  if (base.summary === "hot" && humid) {
    parts.push("humid");
  }
  if (base.summary === "hot" && sunRiskNow) {
    parts.push("sunny enough for UV");
  }
  return formatAdviceList(uniqueStrings(parts));
}

function sunProtectionRelevantNow(weather: WeatherFastPathReading, now: Date): boolean {
  const start = weather.uvStartTime ? new Date(weather.uvStartTime).getTime() : NaN;
  const end = weather.uvEndTime ? new Date(weather.uvEndTime).getTime() : NaN;
  if (Number.isFinite(start) && Number.isFinite(end)) {
    const timestamp = now.getTime();
    return timestamp >= start && timestamp <= end;
  }
  const localHour = hourInTimezone(now.toISOString(), DEFAULT_TIMEZONE);
  return localHour >= 9 && localHour <= 17;
}

function parseWeatherAmountMax(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const values = value.match(/\d+(?:\.\d+)?/g)?.map(Number).filter(Number.isFinite) ?? [];
  return values.length > 0 ? Math.max(...values) : null;
}

function weatherKeywords(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => new RegExp(`\\b${keyword}\\b`).test(text));
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function formatAdviceList(values: readonly string[]): string {
  if (values.length === 0) {
    return "comfortable layers";
  }
  if (values.length === 1) {
    return values[0] as string;
  }
  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function displayPerson(value: string): string {
  const normalized = normalize(value);
  return normalized ? displayPersonName(normalized) : "They";
}

/** Rain or storms in the reading are the one weather fact the assistant sounds concerned about. */
function wetTone(wet: boolean): SpeechTone {
  return wet ? "concerned" : "neutral";
}
