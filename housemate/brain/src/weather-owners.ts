/**
 * Weather and outdoor-advice owners: forecasts, readings, what to
 * wear or take, and the remembered clothing preferences, claimed from their
 * own words and followed up on the weather and clothing frames.
 */
import { declined, withheld, type BasicContextFrame, type BasicResult } from "./basic-brain-contracts.js";
import {
  basicMemoryResult,
  guestMemoryDecline,
  looksLikeOutdoorClothingMemoryQuestion,
  outdoorClothingMemoryAnswer,
  outdoorClothingMemorySubject,
} from "./basic-brain-memory.js";
import type { AppConfig } from "./config.js";
import { isGuestSpeakerRequest, trustedSpeakerPersonId } from "./speaker-principal.js";
import type { VoiceBrainRequest } from "./voice-brain.js";
import { NOT_FOLLOW_UP, followUpSteps, looksLikeCompactOutdoorClothingFollowUp, looksLikeContextualDomainFragment } from "./follow-up-turn.js";
import {
  looksLikeNonWeatherWindMetricQuestion,
  looksLikeOutdoorAdviceFollowUp,
  looksLikeTimeSpecificWeatherQuestion,
  looksLikeWeatherContextFollowUp,
  looksLikeWeatherFastPathQuestion,
  looksLikeWeatherForecastFollowUp,
  outdoorWeatherAdviceAnswer,
  parseWeatherIntentFrame,
  timeSpecificWeatherAnswer,
  weatherFastPathAnswer,
  weatherForecastFollowUpAnswer,
} from "./basic-brain-weather.js";
import type { Owner } from "./router.js";
import { looksLikeOccasionClothingRequest, parseOutdoorAdviceSlots, type OutdoorAdviceSlots } from "./intent-parser.js";
import { normalizeSpeechForRouting } from "./speech-normalizer.js";
import { routingSemanticsAllowCurrentStatus } from "./routing-text.js";
import { parseCurrentStatusPlan, resolveStatusTargetWithClarifier } from "./basic-brain-status.js";
import { sourceRead } from "./stateless-owners.js";
import { extractTimeWindowFromUtterance } from "./time-window-parser.js";
import { DEFAULT_TIMEZONE } from "./basic-brain-open-chat.js";
import { householdRegex } from "./household.js";

export function looksLikeDirectOutdoorClothingMemoryQuestion(normalized: string, request: VoiceBrainRequest): boolean {
  if (!looksLikeOutdoorClothingMemoryQuestion(normalized)) {
    return false;
  }
  if (/\b(preference|preferences|prefer|usually|what do you know|what you know|know about|remember|memories)\b/.test(normalized)) {
    return true;
  }
  if (householdRegex(String.raw`\b({NAMES})\b`).test(normalized)) {
    return true;
  }
  return trustedSpeakerPersonId(request) !== null;
}

export function looksLikeImmediateDepartureAdviceRequest(normalized: string, hasAdviceContext: boolean): boolean {
  const departing = householdRegex(String.raw`\b(?:i|we|me|us|they|he|she|{NAMES})\b`).test(normalized)
    && /\b(?:leaving|going|heading|ducking|stepping)\s+(?:soon|now|shortly|for a while|for a bit)\b/.test(normalized);
  if (!departing) {
    return false;
  }
  const genericPacking = /\bwhat should (?:i|we|he|she|they) (?:take|bring|grab|wear)(?: with (?:me|us|him|her|them)| along)?$/.test(normalized);
  const explicitClothing = /\b(?:what|which|should|need|take|bring|grab|wear)\b/.test(normalized)
    && /\b(?:jacket|jumper|coat|umbrella|clothes|clothing|layers?|shoes?|boots?|hat|sunscreen)\b/.test(normalized);
  return (genericPacking && hasAdviceContext) || explicitClothing;
}

export function looksLikeOutdoorClothingMemoryPreferenceFollowUp(normalized: string): boolean {
  return looksLikeOutdoorClothingMemoryQuestion(normalized)
    && /\b(?:usually|prefer|preference|remember|what do you know|what you know|know about)\b/.test(normalized);
}

export function basicOutdoorClothingMemoryAnswer(
  config: Pick<AppConfig, "dataDir">,
  request: VoiceBrainRequest,
  normalized: string,
): BasicResult {
  if (isGuestSpeakerRequest(request)) {
    return guestMemoryDecline("guest mode blocked outdoor clothing memory lookup");
  }
  const result = outdoorClothingMemoryAnswer(config, request, normalized);
  return basicMemoryResult(result, result.status === "ok" ? outdoorClothingMemoryContextFrame(request, normalized) : null);
}

function outdoorClothingMemoryContextFrame(request: VoiceBrainRequest, normalized: string): BasicContextFrame | null {
  const subject = outdoorClothingMemorySubject(request, normalized);
  return subject ? { kind: "outdoor_clothing_memory", subject } : null;
}

export function guestWeatherPreferenceDecline(notes: string): BasicResult {
  return withheld("weather_query", notes);
}

// --- Follow-ups ------------------------------------------------------------------

/** Forecasts, readings and advice on the weather frame; the clothing preferences on theirs. */
export const WEATHER_FOLLOW_UPS = followUpSteps("weather", {
  // A complete weather request owns a fresh source read even when an older
  // weather frame and a pending non-weather clarifier both exist. Words such
  // as "warm" must not turn the new question into contextual advice.
  standaloneRequest(f) {
    const n = f.normalized;
    return f.restatedRequest
      && looksLikeWeatherFastPathQuestion(n)
      && !looksLikeContextualDomainFragment(n)
      && !looksLikeWeatherContextFollowUp(n)
      && !f.implicitWeatherCondition
      ? NOT_FOLLOW_UP
      : null;
  },
  clothingMemoryFrame(f, ctx) {
    return f.clothingMemoryFrame && (looksLikeOutdoorClothingMemoryQuestion(f.normalized)
      || /\b(?:saved|remembered|memory)\b.*\b(?:cutoff|threshold|rule)\b/.test(f.normalized))
      ? basicOutdoorClothingMemoryAnswer(ctx.config, ctx.turn.request, f.normalized)
      : null;
  },
  standaloneAdvice(f) {
    return f.standaloneOutdoorAdvice ? NOT_FOLLOW_UP : null;
  },
  // Explicit numeric meaning outranks loose contextual-fragment/advice
  // heuristics. Non-weather wind metrics must leave weather context.
  numericOrWindMetric(f) {
    const n = f.normalized;
    return looksLikeNonWeatherWindMetricQuestion(n)
      || (parseWeatherIntentFrame(n).numericComparison !== null && looksLikeWeatherFastPathQuestion(n))
      ? NOT_FOLLOW_UP
      : null;
  },
  /** With no focus, a weather-shaped follow-up is asked fresh by the weather owner. */
  unfocused(f, ctx) {
    const n = f.normalized;
    return !f.hasFocus && (
      looksLikeWeatherContextFollowUp(n)
      || looksLikeWeatherForecastFollowUp(n, ctx.now())
      || f.implicitWeatherCondition
      || looksLikeOutdoorClothingMemoryQuestion(n)
    )
      ? NOT_FOLLOW_UP
      : null;
  },
  noFrame(f) {
    return (looksLikeWeatherContextFollowUp(f.normalized) || f.implicitWeatherCondition) && f.weatherFrame === null
      ? NOT_FOLLOW_UP
      : null;
  },
  context(f, ctx) {
    const n = f.normalized;
    const weatherContextFrame = f.weatherFrame;
    const { routes, config } = ctx;
    const request = ctx.turn.request;
    if (
      !weatherContextFrame
      || f.lightsListFollowUp
      || f.standaloneOutdoorAdvice
      || looksLikeDirectOutdoorClothingMemoryQuestion(n, request)
      || !(looksLikeWeatherContextFollowUp(n)
        || looksLikeCompactOutdoorClothingFollowUp(n)
        || looksLikeOutdoorAdviceFollowUp(n)
        || looksLikeWeatherForecastFollowUp(n, ctx.now())
        || f.implicitWeatherCondition
        || f.correctsToWeather
        || f.returnsToPriorFocus)
    ) {
      return null;
    }
    if (looksLikeOutdoorClothingMemoryPreferenceFollowUp(n)) {
      const memory = basicOutdoorClothingMemoryAnswer(config, request, n);
      if (memory.status === "ok") {
        return memory;
      }
    }
    if (looksLikeTimeSpecificWeatherQuestion(n, { allowContextOnly: true })) {
      return timeSpecificWeatherAnswer(routes, ctx.now(), n, weatherContextFrame);
    }
    if (parseWeatherIntentFrame(n).timeframe === "later") {
      return weatherFastPathAnswer(routes, ctx.now(), n, { compactFollowUp: true });
    }
    if (looksLikeOutdoorAdviceFollowUp(n) || f.implicitWeatherCondition) {
      return outdoorWeatherAdviceAnswer(config, request, { person: null, asksClothingAdvice: true }, routes, ctx.now(), { compactFollowUp: true });
    }
    if (looksLikeWeatherForecastFollowUp(n, ctx.now()) || f.correctsToWeather || f.returnsToPriorFocus) {
      return weatherForecastFollowUpAnswer(routes, ctx.now(), n, weatherContextFrame, { compactFollowUp: true });
    }
    return weatherFastPathAnswer(routes, ctx.now(), n, { compactFollowUp: true });
  },
  conversationAdvice(f, ctx) {
    const n = f.normalized;
    return f.priorWeatherFrame
      && f.activeFocusDomain !== "personal_memory"
      && ctx.turn.request.conversationMode
      && looksLikeWeatherContextFollowUp(n)
      && looksLikeOutdoorAdviceFollowUp(n)
      ? outdoorWeatherAdviceAnswer(ctx.config, ctx.turn.request, { person: null, asksClothingAdvice: true }, ctx.routes, ctx.now(), { compactFollowUp: true })
      : null;
  },
  clothingMemory(f, ctx) {
    return looksLikeOutdoorClothingMemoryQuestion(f.normalized)
      ? basicOutdoorClothingMemoryAnswer(ctx.config, ctx.turn.request, f.normalized)
      : null;
  },
});

// --- Owners ----------------------------------------------------------------------

/** "At 6pm yesterday": a time already past, which neither the current reading nor a forecast can answer. */
function windowHasEnded(surface: string, now: Date): boolean {
  const { window } = extractTimeWindowFromUtterance(surface, { now, timezone: DEFAULT_TIMEZONE });
  return window !== null && Date.parse(window.end) <= now.getTime();
}

/** "Will it rain at three?": the forecast at a time (or at the weather frame's time). */
export const timeSpecificWeatherOwner = sourceRead(
  "time_specific_weather",
  "explicit",
  (turn, ctx) => looksLikeTimeSpecificWeatherQuestion(turn.normalized, { allowContextOnly: ctx.contextViews.weather.active !== null })
    && !windowHasEnded(turn.surface, ctx.now()),
  (ctx) => timeSpecificWeatherAnswer(ctx.routes, ctx.now(), ctx.turn.normalized, ctx.contextViews.weather.active?.payload ?? null),
  "read_source_unavailable",
);

/** "I'm heading out soon, do I need a jacket?": advice for leaving now. */
export const departureAdviceOwner = {
  id: "departure_advice",
  tier: "explicit",
  claim(turn, ctx) {
    const slots = parseOutdoorAdviceSlots(turn.analysis.surface);
    if (!slots) return null;
    const departureSurface = normalizeSpeechForRouting(turn.analysis.surface, {
      preserveEntityChars: true,
      preserveMeasurementChars: true,
      preservePragmaticPrefaces: true,
    });
    const activeContext = ctx.contextViews.focus.active;
    const hasDepartureAdviceContext = Boolean(
      activeContext
        && activeContext.transport.sessionId === turn.request.sessionId
        && (activeContext.payload.kind === "outdoor_clothing_memory" || activeContext.payload.kind === "weather"),
    );
    return looksLikeImmediateDepartureAdviceRequest(departureSurface, hasDepartureAdviceContext) ? slots : null;
  },
  answer(slots, ctx) {
    if (isGuestSpeakerRequest(ctx.turn.request) && slots.person) {
      return guestWeatherPreferenceDecline("guest mode blocked named-person clothing preference lookup");
    }
    return outdoorWeatherAdviceAnswer(ctx.config, ctx.turn.request, slots, ctx.routes, ctx.now());
  },
} satisfies Owner<OutdoorAdviceSlots>;

/** "What jacket does Sam usually wear?": the remembered clothing preference. */
export const clothingMemoryOwner = {
  id: "clothing_memory",
  tier: "explicit",
  claim: (turn) => looksLikeDirectOutdoorClothingMemoryQuestion(turn.normalized, turn.request) || null,
  answer: (_claim, ctx) => isGuestSpeakerRequest(ctx.turn.request)
    ? guestMemoryDecline("guest mode blocked outdoor clothing memory lookup")
    : basicOutdoorClothingMemoryAnswer(ctx.config, ctx.turn.request, ctx.turn.normalized),
} satisfies Owner<true>;

/** "Do I need an umbrella?": advice from the forecast, then the remembered preference. */
export const outdoorAdviceOwner = {
  id: "outdoor_advice",
  tier: "explicit",
  claim: (turn) => (looksLikeOccasionClothingRequest(turn.analysis.surface) ? null : parseOutdoorAdviceSlots(turn.normalized)),
  async answer(slots, ctx) {
    const { request } = ctx.turn;
    if (isGuestSpeakerRequest(request) && slots.person) {
      return guestWeatherPreferenceDecline("guest mode blocked named-person clothing preference lookup");
    }
    const advice = await outdoorWeatherAdviceAnswer(ctx.config, request, slots, ctx.routes, ctx.now());
    if (advice.status === "declined" && /\b(?:jacket|jumper|coat|wear|wearing|clothing|clothes|layers?)\b/.test(ctx.turn.normalized)) {
      return basicOutdoorClothingMemoryAnswer(ctx.config, request, ctx.turn.normalized);
    }
    return advice;
  },
} satisfies Owner<OutdoorAdviceSlots>;

/** "The forecast, not the outside sensor": the weather source asked by name. */
export const forecastOverSensorOwner = sourceRead(
  "forecast_over_sensor",
  "correction",
  ({ normalized: n }) => /\b(?:weather|forecast)\b/.test(n)
    && /\b(?:rather than|instead of|not)\b/.test(n)
    && /\b(?:local|physical|outdoor|outside) sensor\b/.test(n),
  (ctx) => weatherFastPathAnswer(ctx.routes, ctx.now(), ctx.turn.normalized),
  "read_source_unavailable",
);

/**
 * Weather, unless it asks the remembered clothing preference or a numeric
 * comparison on a current house reading ("is it over 20 inside?").
 */
export const weatherOwner = sourceRead(
  "weather",
  "explicit",
  (turn, ctx) => {
    const n = turn.normalized;
    if (looksLikeOutdoorClothingMemoryQuestion(n) || !looksLikeWeatherFastPathQuestion(n)) return false;
    const numericStatusPlan = routingSemanticsAllowCurrentStatus(turn.analysis.semantics)
      ? parseCurrentStatusPlan(turn.analysis.semantics.core, turn.analysis.speechAct)
      : null;
    const numericStatusBeforeWeather = numericStatusPlan?.numericComparison
      && numericStatusPlan.targetText
      && parseWeatherIntentFrame(n).timeframe === "current"
      && resolveStatusTargetWithClarifier(
        numericStatusPlan.targetText,
        ctx.routes,
        numericStatusPlan.requestedState,
        numericStatusPlan.questionType,
      ).target !== null;
    return !numericStatusBeforeWeather;
  },
  // "What was the weather yesterday?": the weather sources are now and the
  // forecast, so a window already over is declined, never answered with today.
  // Source-final: the read agent found nothing either (live 0.0.407: 5 s, then no answer).
  (ctx) => windowHasEnded(ctx.turn.surface, ctx.now())
    ? {
      ...declined(
        "weather_query",
        "I can't look back at past weather. I've only got now and the forecast.",
        "weather window has ended; weather sources are current and forecast only",
      ),
      readFallback: { eligible: false, reason: "source_final" },
    }
    : weatherFastPathAnswer(ctx.routes, ctx.now(), ctx.turn.normalized),
  "read_source_unavailable",
);
