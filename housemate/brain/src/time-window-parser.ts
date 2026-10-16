export type TimeWindowStatus = "matched" | "ambiguous" | "unmatched";
import { normalizeSpeechForRouting } from "./speech-normalizer.js";
import { escapeRegExp } from "./text-format.js";
import { zonedDateTimeParts, zonedTimeToUtc } from "./zoned-time.js";

export type TimeWindowConfidence = "low" | "medium" | "high";
export type TimeWindowSource =
  | "absolute_date"
  | "absolute_range"
  | "relative_calendar"
  | "context_reference"
  | "rolling_duration"
  | "day_part"
  | "household_anchor"
  | "model_fallback";

export interface TimeWindow {
  readonly start: string;
  readonly end: string;
  readonly timezone: string;
  readonly label: string;
  readonly source: TimeWindowSource;
  readonly confidence: TimeWindowConfidence;
}

export interface TimeWindowParseFallbackRequest {
  readonly schemaVersion: 1;
  readonly purpose: "time_window_parse";
  readonly input: string;
  readonly now: string;
  readonly timezone: string;
  readonly instructions: readonly string[];
  readonly outputSchema: {
    readonly status: "matched|ambiguous|unmatched";
    readonly start: "ISO-8601 string required only when matched";
    readonly end: "ISO-8601 string required only when matched, exclusive";
    readonly timezone: "IANA timezone";
    readonly label: "short normalized label";
    readonly confidence: "low|medium|high";
    readonly reason: "short reason for ambiguous or unmatched";
  };
}

export interface TimeWindowParseResult {
  readonly status: TimeWindowStatus;
  readonly input: string;
  readonly normalizedInput: string;
  readonly window: TimeWindow | null;
  readonly reason: string | null;
  readonly fallbackRequest: TimeWindowParseFallbackRequest | null;
}

export interface ExtractedTimeWindowEnvelope {
  readonly result: TimeWindowParseResult;
  readonly residualInput: string | null;
  readonly temporalInput: string | null;
}

export interface HouseholdAnchorWindow {
  readonly start: string;
  readonly end: string;
  readonly crossesMidnight?: boolean;
}

export interface ParseTimeWindowOptions {
  readonly now?: Date;
  readonly timezone?: string;
  readonly householdAnchors?: Readonly<Record<string, HouseholdAnchorWindow>>;
  readonly weekdayDirection?: "past" | "future";
  /** Prior software-resolved window for contextual relative follow-ups. */
  readonly referenceWindow?: TimeWindow | null;
}

type DurationUnit = "second" | "minute" | "hour" | "day" | "week" | "month";

interface Duration {
  readonly amount: number;
  readonly unit: DurationUnit;
}

interface LocalDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

interface LocalDateTimeParts extends LocalDateParts {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

interface DayPartSpec {
  readonly start: string;
  readonly end: string;
  readonly crossesMidnight?: boolean;
}

interface TimeWindowSpan {
  readonly startToken: number;
  readonly endToken: number;
  readonly result: TimeWindowParseResult;
}

interface ParsedDateText {
  readonly recognized: boolean;
  readonly date: LocalDateParts | null;
}

export function parseTimeWindow(input: string, options: ParseTimeWindowOptions = {}): TimeWindowParseResult {
  const normalizedInput = normalize(input);
  const now = options.now ?? new Date();
  const timezone = options.timezone ?? "UTC";

  if (!normalizedInput) {
    return unresolved(input, normalizedInput, now, timezone, "time window input is empty");
  }

  const parsers: readonly (() => TimeWindowParseResult | null)[] = [
    () => parseAbsoluteRange(input, normalizedInput, now, timezone),
    () => parseAbsoluteDate(input, normalizedInput, now, timezone),
    () => parseReferenceRelativeWindow(
      input,
      normalizedInput,
      timezone,
      options.referenceWindow ?? null,
    ),
    () => parseRelativeCalendar(
      input,
      normalizedInput,
      now,
      timezone,
      options.weekdayDirection,
    ),
    () => parseFutureDuration(input, normalizedInput, now, timezone),
    () => parseRollingDuration(input, normalizedInput, now, timezone),
    () => parseDayPart(input, normalizedInput, now, timezone),
    () => parseHouseholdAnchor(input, normalizedInput, now, timezone, options.householdAnchors ?? DEFAULT_ANCHORS),
  ];

  for (const parser of parsers) {
    const result = parser();
    if (result) {
      return result;
    }
  }

  return unresolved(input, normalizedInput, now, timezone, "time window wording needs parse fallback");
}

function parseReferenceRelativeWindow(
  input: string,
  normalizedInput: string,
  timezone: string,
  reference: TimeWindow | null,
): TimeWindowParseResult | null {
  if (!reference) {
    return null;
  }
  const direct = /^(?:the\s+)?(?:(previous|prior|last|next|following|same)\s+(day|week|month)|(day|week|month)\s+(before|after))$/u.exec(normalizedInput);
  const counted = /^(?:the\s+)?(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(days?|weeks?|months?)\s+(before|after|earlier|later)$/u.exec(normalizedInput);
  let amount = 0;
  type RelativeUnit = "day" | "week" | "month";
  let unit: RelativeUnit = "day";
  if (direct) {
    unit = (direct[2] ?? direct[3]) as RelativeUnit;
    const direction = direct[1] ?? direct[4] ?? "";
    amount = direction === "same"
      ? 0
      : direction === "previous"
        || direction === "prior"
        || direction === "last"
        || direction === "before"
        ? -1
        : 1;
  } else if (counted) {
    const parsedAmount = parseAmount(counted[1] ?? "");
    if (!parsedAmount) {
      return null;
    }
    unit = (counted[2] ?? "day").replace(/s$/u, "") as RelativeUnit;
    const direction = counted[3] ?? "";
    amount = (direction === "before" || direction === "earlier")
      ? -parsedAmount
      : parsedAmount;
  } else {
    return null;
  }
  const startParts = zonedDateTimeParts(new Date(reference.start), timezone);
  const endParts = zonedDateTimeParts(new Date(reference.end), timezone);
  const shift = <T extends LocalDateTimeParts>(parts: T): T =>
    unit === "month"
      ? addMonths(parts, amount)
      : addDays(parts, amount * (unit === "week" ? 7 : 1));
  const shiftedStartParts = shift(startParts);
  const shiftedEndParts = shift(endParts);
  const shiftedStart = zonedTimeToUtc(shiftedStartParts, timezone);
  const shiftedEnd = zonedTimeToUtc(shiftedEndParts, timezone);
  if (shiftedEnd.getTime() <= shiftedStart.getTime()) {
    return null;
  }
  const daySized = shiftedEnd.getTime() - shiftedStart.getTime()
    >= 20 * 60 * 60 * 1_000
    && shiftedEnd.getTime() - shiftedStart.getTime()
    <= 28 * 60 * 60 * 1_000;
  return matched(input, normalizedInput, {
    start: shiftedStart.toISOString(),
    end: shiftedEnd.toISOString(),
    timezone,
    label: daySized
      ? formatLocalDate(shiftedStartParts)
      : normalizedInput,
    source: "context_reference",
    confidence: "high",
  });
}

export function extractTimeWindowFromUtterance(
  input: string,
  options: ParseTimeWindowOptions = {},
): TimeWindowParseResult {
  const normalizedInput = normalize(input);
  const now = options.now ?? new Date();
  const timezone = options.timezone ?? "UTC";
  if (!normalizedInput) {
    return unresolved(input, normalizedInput, now, timezone, "time window input is empty");
  }

  const { tokens, matchedSpans, problemSpans } = collectTimeWindowSpans(
    normalizedInput,
    { ...options, now, timezone },
  );

  const maximalMatches = maximalTimeWindowSpans(matchedSpans);
  const invalidEnvelope = maximalMatches.find((span) =>
    !timeWindowSpanConsumesTemporalEnvelope(
      tokens,
      span,
      { ...options, now, timezone },
    )
  );
  if (invalidEnvelope) {
    return unresolved(
      input,
      normalizedInput,
      now,
      timezone,
      "utterance contains an invalid or conflicting time window",
    );
  }
  const windows = new Map<string, TimeWindow>();
  for (const span of maximalMatches) {
    const window = span.result.window;
    if (window) {
      windows.set(timeWindowIdentity(window), window);
    }
  }

  if (windows.size > 1) {
    return ambiguous(input, normalizedInput, now, timezone, "utterance contains multiple distinct time windows");
  }

  const conflictingProblem = maximalTimeWindowSpans(problemSpans).find((problem) =>
    !maximalMatches.some((match) => containsSpan(match, problem))
  );
  if (windows.size === 1 && conflictingProblem) {
    return ambiguous(input, normalizedInput, now, timezone, "utterance contains an additional unresolved time window");
  }

  const window = windows.values().next().value as TimeWindow | undefined;
  if (window) {
    return matched(input, normalizedInput, window);
  }

  const ambiguousProblem = problemSpans.find((span) => span.result.status === "ambiguous");
  if (ambiguousProblem) {
    return ambiguous(
      input,
      normalizedInput,
      now,
      timezone,
      ambiguousProblem.result.reason ?? "utterance contains an ambiguous time window",
    );
  }
  if (problemSpans.length > 0) {
    return unresolved(input, normalizedInput, now, timezone, "utterance contains an invalid time window");
  }
  return unresolved(input, normalizedInput, now, timezone, "utterance does not contain a supported time window");
}

/**
 * Extract one unambiguous time envelope and return the remaining proposition.
 * Consumers can classify the residual meaning without maintaining a second
 * date grammar or silently dropping conflicting/invalid temporal wording.
 */
export function extractTimeWindowEnvelopeFromUtterance(
  input: string,
  options: ParseTimeWindowOptions = {},
): ExtractedTimeWindowEnvelope {
  const result = extractTimeWindowFromUtterance(input, options);
  if (result.status !== "matched" || !result.window) {
    return {
      result,
      residualInput: null,
      temporalInput: null,
    };
  }

  const now = options.now ?? new Date();
  const timezone = options.timezone ?? "UTC";
  const { tokens, matchedSpans } = collectTimeWindowSpans(
    result.normalizedInput,
    { ...options, now, timezone },
  );
  const identity = timeWindowIdentity(result.window);
  const matchingSpans = maximalTimeWindowSpans(matchedSpans)
    .filter((span) => span.result.window
      && timeWindowIdentity(span.result.window) === identity);
  if (matchingSpans.length !== 1) {
    return {
      result,
      residualInput: null,
      temporalInput: null,
    };
  }

  const [span] = matchingSpans;
  if (!span) {
    return {
      result,
      residualInput: null,
      temporalInput: null,
    };
  }
  const residualInput = [
    ...tokens.slice(0, span.startToken),
    ...tokens.slice(span.endToken),
  ].join(" ").replace(/\s+/g, " ").trim();
  const temporalInput = tokens
    .slice(span.startToken, span.endToken)
    .join(" ")
    .trim();
  return {
    result,
    residualInput: residualInput || null,
    temporalInput: temporalInput || null,
  };
}

export function buildTimeWindowFallbackRequest(
  input: string,
  options: ParseTimeWindowOptions = {},
): TimeWindowParseFallbackRequest {
  const now = options.now ?? new Date();
  const timezone = options.timezone ?? "UTC";
  return {
    schemaVersion: 1,
    purpose: "time_window_parse",
    input,
    now: now.toISOString(),
    timezone,
    instructions: [
      "Return structured JSON only.",
      "Do not answer the user.",
      "Use start/end only for a resolved exclusive time window.",
      "Return ambiguous instead of guessing unclear dates, anchors, or ranges.",
    ],
    outputSchema: {
      status: "matched|ambiguous|unmatched",
      start: "ISO-8601 string required only when matched",
      end: "ISO-8601 string required only when matched, exclusive",
      timezone: "IANA timezone",
      label: "short normalized label",
      confidence: "low|medium|high",
      reason: "short reason for ambiguous or unmatched",
    },
  };
}

function parseAbsoluteRange(
  input: string,
  normalizedInput: string,
  now: Date,
  timezone: string,
): TimeWindowParseResult | null {
  const match = /^(?:from|between)\s+(.+?)\s+(?:to|and)\s+(.+)$/.exec(normalizedInput);
  if (!match) {
    return null;
  }

  const defaultYear = zonedDateParts(now, timezone).year;
  const startDate = parseDateText(match[1] ?? "", defaultYear);
  const endDate = parseDateText(match[2] ?? "", defaultYear);
  if (!startDate || !endDate) {
    return unresolved(input, normalizedInput, now, timezone, "absolute range contains an unsupported date");
  }
  const endExclusive = addDays(endDate, 1);
  const start = zonedTimeToUtc({ ...startDate, hour: 0, minute: 0, second: 0 }, timezone);
  const end = zonedTimeToUtc({ ...endExclusive, hour: 0, minute: 0, second: 0 }, timezone);
  if (end.getTime() <= start.getTime()) {
    return ambiguous(input, normalizedInput, now, timezone, "absolute range end is not after start");
  }

  return matched(input, normalizedInput, {
    start: start.toISOString(),
    end: end.toISOString(),
    timezone,
    label: `from ${formatLocalDate(startDate)} to ${formatLocalDate(endDate)}`,
    source: "absolute_range",
    confidence: "high",
  });
}

function parseAbsoluteDate(
  input: string,
  normalizedInput: string,
  now: Date,
  timezone: string,
): TimeWindowParseResult | null {
  const parsed = parseDateTextResult(
    normalizedInput.replace(/^on\s+/, ""),
    zonedDateParts(now, timezone).year,
  );
  if (!parsed.recognized) {
    return null;
  }
  if (!parsed.date) {
    return unresolved(input, normalizedInput, now, timezone, "absolute date is invalid");
  }
  return calendarDayResult(
    input,
    normalizedInput,
    parsed.date,
    timezone,
    formatLocalDate(parsed.date),
    "absolute_date",
    "high",
  );
}

function parseRelativeCalendar(
  input: string,
  normalizedInput: string,
  now: Date,
  timezone: string,
  weekdayDirection: ParseTimeWindowOptions["weekdayDirection"],
): TimeWindowParseResult | null {
  const today = zonedDateParts(now, timezone);
  if (normalizedInput === "today") {
    return calendarDayResult(input, normalizedInput, today, timezone, "today", "relative_calendar", "high");
  }
  if (normalizedInput === "yesterday") {
    return calendarDayResult(input, normalizedInput, addDays(today, -1), timezone, "yesterday", "relative_calendar", "high");
  }
  if (normalizedInput === "tomorrow") {
    return calendarDayResult(input, normalizedInput, addDays(today, 1), timezone, "tomorrow", "relative_calendar", "medium");
  }
  if (normalizedInput === "this week") {
    const weekStartOffset = -((weekdayForLocalDate(today) + 6) % 7);
    return midnightRange(input, normalizedInput, addDays(today, weekStartOffset), addDays(today, weekStartOffset + 7), timezone, "this week", "relative_calendar", "medium");
  }
  if (normalizedInput === "last week") {
    const weekStartOffset = -((weekdayForLocalDate(today) + 6) % 7);
    return midnightRange(input, normalizedInput, addDays(today, weekStartOffset - 7), addDays(today, weekStartOffset), timezone, "last week", "relative_calendar", "high");
  }
  if (normalizedInput === "next week") {
    const weekStartOffset = -((weekdayForLocalDate(today) + 6) % 7);
    return midnightRange(input, normalizedInput, addDays(today, weekStartOffset + 7), addDays(today, weekStartOffset + 14), timezone, "next week", "relative_calendar", "medium");
  }
  if (normalizedInput === "this month") {
    return calendarMonthResult(input, normalizedInput, addMonths({ ...today, day: 1, hour: 0, minute: 0, second: 0 }, 0), timezone, "this month", "medium");
  }
  if (normalizedInput === "next month") {
    return calendarMonthResult(input, normalizedInput, addMonths({ ...today, day: 1, hour: 0, minute: 0, second: 0 }, 1), timezone, "next month", "medium");
  }
  if (normalizedInput === "last month") {
    return calendarMonthResult(input, normalizedInput, addMonths({ ...today, day: 1, hour: 0, minute: 0, second: 0 }, -1), timezone, "last month", "medium");
  }
  if (normalizedInput === "this year") {
    return midnightRange(input, normalizedInput, { year: today.year, month: 1, day: 1 }, { year: today.year + 1, month: 1, day: 1 }, timezone, "this year", "relative_calendar", "medium");
  }
  if (normalizedInput === "last year") {
    return midnightRange(input, normalizedInput, { year: today.year - 1, month: 1, day: 1 }, { year: today.year, month: 1, day: 1 }, timezone, "last year", "relative_calendar", "high");
  }
  if (normalizedInput === "next year") {
    return midnightRange(input, normalizedInput, { year: today.year + 1, month: 1, day: 1 }, { year: today.year + 2, month: 1, day: 1 }, timezone, "next year", "relative_calendar", "medium");
  }
  if (normalizedInput === "this weekend" || normalizedInput === "weekend") {
    const weekStartOffset = -((weekdayForLocalDate(today) + 6) % 7);
    const saturdayOffset = weekStartOffset + 5;
    return midnightRange(input, normalizedInput, addDays(today, saturdayOffset), addDays(today, saturdayOffset + 2), timezone, "this weekend", "relative_calendar", "medium");
  }
  if (normalizedInput === "next weekend") {
    const weekStartOffset = -((weekdayForLocalDate(today) + 6) % 7);
    const saturdayOffset = weekStartOffset + 12;
    return midnightRange(input, normalizedInput, addDays(today, saturdayOffset), addDays(today, saturdayOffset + 2), timezone, "next weekend", "relative_calendar", "medium");
  }
  if (normalizedInput === "last weekend") {
    const weekStartOffset = -((weekdayForLocalDate(today) + 6) % 7);
    const saturdayOffset = weekStartOffset - 2;
    return midnightRange(input, normalizedInput, addDays(today, saturdayOffset), addDays(today, weekStartOffset), timezone, "last weekend", "relative_calendar", "high");
  }

  const weekday = new RegExp(
    `^(?:on\\s+)?(?:(last|this|next)\\s+)?(${WEEKDAY_PATTERN})$`,
  ).exec(normalizedInput);
  if (weekday) {
    const qualifier = weekday[1] ?? null;
    const targetWeekday = WEEKDAYS[weekday[2] ?? ""];
    if (targetWeekday === undefined) return null;
    const currentWeekday = weekdayForLocalDate(today);
    let offset: number;
    if (qualifier === "last") {
      const daysBack = (currentWeekday - targetWeekday + 7) % 7;
      offset = -(daysBack === 0 ? 7 : daysBack);
    } else if (qualifier === "next") {
      const daysAhead = (targetWeekday - currentWeekday + 7) % 7;
      offset = daysAhead === 0 ? 7 : daysAhead;
    } else if (qualifier === "this") {
      const mondayIndex = (currentWeekday + 6) % 7;
      const targetMondayIndex = (targetWeekday + 6) % 7;
      offset = targetMondayIndex - mondayIndex;
    } else if (weekdayDirection === "past") {
      offset = -((currentWeekday - targetWeekday + 7) % 7);
    } else if (weekdayDirection === "future") {
      offset = (targetWeekday - currentWeekday + 7) % 7;
    } else {
      return ambiguous(
        input,
        normalizedInput,
        now,
        timezone,
        "weekday needs a past or future context",
      );
    }
    return calendarDayResult(
      input,
      normalizedInput,
      addDays(today, offset),
      timezone,
      normalizedInput.replace(/^on\s+/, ""),
      "relative_calendar",
      qualifier === "last" || weekdayDirection === "past"
        ? "high"
        : "medium",
    );
  }

  const daysAgo = /^(?:(\d{1,3})|(one|two|three|four|five|six|seven|eight|nine|ten)) days? ago$/.exec(normalizedInput);
  if (daysAgo) {
    const amount = daysAgo[1]
      ? Number(daysAgo[1])
      : NUMBER_WORDS[daysAgo[2] ?? ""] ?? 0;
    if (amount > 0) {
      return calendarDayResult(
        input,
        normalizedInput,
        addDays(today, -amount),
        timezone,
        normalizedInput,
        "relative_calendar",
        "high",
      );
    }
  }

  const namedMonth = new RegExp(
    `^(?:in\\s+)?(${MONTH_PATTERN})(?:\\s+(this|last|next)\\s+year|\\s+(\\d{4}))?$`,
  ).exec(normalizedInput);
  if (namedMonth) {
    const qualifier = namedMonth[2];
    const explicitYear = namedMonth[3];
    const year = explicitYear
      ? Number(explicitYear)
      : qualifier === "last"
        ? today.year - 1
        : qualifier === "next"
          ? today.year + 1
          : today.year;
    const month = monthNumber(namedMonth[1] ?? "");
    if (month > 0) {
      return calendarMonthResult(
        input,
        normalizedInput,
        { year, month, day: 1 },
        timezone,
        normalizedInput,
        qualifier === "last" || explicitYear ? "high" : "medium",
      );
    }
  }

  const sinceMatch = /^since\s+(.+)$/.exec(normalizedInput);
  if (sinceMatch) {
    const time = parseClockTime(sinceMatch[1] ?? "");
    if (!time) {
      return unresolved(input, normalizedInput, now, timezone, "since window contains an unsupported time");
    }
    let startParts = { ...today, ...time, second: 0 };
    let start = zonedTimeToUtc(startParts, timezone);
    if (start.getTime() > now.getTime()) {
      startParts = { ...addDays(today, -1), ...time, second: 0 };
      start = zonedTimeToUtc(startParts, timezone);
    }
    return matched(input, normalizedInput, {
      start: start.toISOString(),
      end: now.toISOString(),
      timezone,
      label: normalizedInput,
      source: "relative_calendar",
      confidence: "medium",
    });
  }

  if (normalizedInput === "last hour" || normalizedInput === "past hour") {
    return rollingResult(input, normalizedInput, now, timezone, { amount: 1, unit: "hour" }, "high");
  }

  return null;
}

function parseRollingDuration(
  input: string,
  normalizedInput: string,
  now: Date,
  timezone: string,
): TimeWindowParseResult | null {
  const match = /^(?:in\s+the\s+)?(?:last|past|previous|rolling)\s+(.+?)\s+(seconds?|minutes?|hours?|days?|weeks?|months?)$/.exec(normalizedInput);
  if (!match) {
    return null;
  }
  const amount = parseAmount(match[1] ?? "");
  const unit = parseUnit(match[2] ?? "");
  if (!amount || !unit) {
    return unresolved(input, normalizedInput, now, timezone, "rolling duration is unsupported");
  }
  return rollingResult(input, normalizedInput, now, timezone, { amount, unit }, "high");
}

function parseFutureDuration(
  input: string,
  normalizedInput: string,
  now: Date,
  timezone: string,
): TimeWindowParseResult | null {
  const match = /^(?:(?:in|over|within)\s+(?:the\s+)?)?next\s+(.+?)(?:\s+of)?\s+(seconds?|minutes?|hours?|days?|weeks?|months?)$/.exec(normalizedInput);
  if (!match) {
    return null;
  }
  const amount = parseAmount(match[1] ?? "");
  const unit = parseUnit(match[2] ?? "");
  if (!amount || !unit) {
    return unresolved(input, normalizedInput, now, timezone, "future duration is unsupported");
  }
  const end = addDuration(now, timezone, { amount, unit });
  return matched(input, normalizedInput, {
    start: now.toISOString(),
    end: end.toISOString(),
    timezone,
    label: normalizedInput,
    source: "rolling_duration",
    confidence: "high",
  });
}

function parseDayPart(
  input: string,
  normalizedInput: string,
  now: Date,
  timezone: string,
): TimeWindowParseResult | null {
  const dayPartMatch = /^(?:(today|yesterday|tomorrow|this|last|tonight)\s+)?(morning|afternoon|evening|night)$/.exec(normalizedInput);
  if (!dayPartMatch) {
    return null;
  }
  const qualifier = dayPartMatch[1] ?? null;
  const partName = dayPartMatch[2] as keyof typeof DAY_PARTS;
  const today = zonedDateParts(now, timezone);
  const spec = DAY_PARTS[partName];
  if (!spec) {
    return null;
  }

  if (!qualifier && partName !== "night") {
    return ambiguous(input, normalizedInput, now, timezone, `${partName} needs a day qualifier`);
  }

  const date = dayForQualifier(today, qualifier ?? (partName === "night" ? "tonight" : "today"), partName === "night");
  return namedLocalWindow(input, normalizedInput, date, spec, timezone, partName, "day_part", "high");
}

function parseHouseholdAnchor(
  input: string,
  normalizedInput: string,
  now: Date,
  timezone: string,
  anchors: Readonly<Record<string, HouseholdAnchorWindow>>,
): TimeWindowParseResult | null {
  const anchorNames = Object.keys(anchors).sort((left, right) => right.length - left.length);
  for (const anchorName of anchorNames) {
    const pattern = new RegExp(`^(?:(today|yesterday|tomorrow|this|last)\\s+)?${escapeRegExp(normalize(anchorName))}$`);
    const match = pattern.exec(normalizedInput);
    if (!match) {
      continue;
    }
    const spec = anchors[anchorName];
    if (!spec) {
      continue;
    }
    const today = zonedDateParts(now, timezone);
    const date = dayForQualifier(today, match[1] ?? "today", false);
    return namedLocalWindow(input, normalizedInput, date, spec, timezone, anchorName, "household_anchor", "medium");
  }
  return null;
}

function couldStartTimeWindow(
  token: string,
  anchors: Readonly<Record<string, HouseholdAnchorWindow>>,
): boolean {
  if (
    TIME_WINDOW_START_TOKENS.has(token)
    || token in MONTHS
    || token in WEEKDAYS
    || token in NUMBER_WORDS
    || ORDINAL_DAY_START_TOKENS.has(token)
    || /^\d{1,4}(?:st|nd|rd|th)?$/.test(token)
  ) {
    return true;
  }
  return Object.keys(anchors).some((anchor) => normalize(anchor).split(" ")[0] === token);
}

function collectTimeWindowSpans(
  normalizedInput: string,
  options: ParseTimeWindowOptions & {
    readonly now: Date;
    readonly timezone: string;
  },
): {
  readonly tokens: readonly string[];
  readonly matchedSpans: readonly TimeWindowSpan[];
  readonly problemSpans: readonly TimeWindowSpan[];
} {
  const tokens = normalizedInput.split(" ");
  const maximumSpanLength = Math.max(
    MAX_STRUCTURAL_TIME_SPAN_TOKENS,
    ...Object.keys(options.householdAnchors ?? DEFAULT_ANCHORS)
      .map((anchor) => normalize(anchor).split(" ").filter(Boolean).length + 1),
  );
  const matchedSpans: TimeWindowSpan[] = [];
  const problemSpans: TimeWindowSpan[] = [];

  for (let startToken = 0; startToken < tokens.length; startToken += 1) {
    if (!couldStartTimeWindow(tokens[startToken] ?? "", options.householdAnchors ?? DEFAULT_ANCHORS)) {
      continue;
    }
    const lastEndToken = Math.min(tokens.length, startToken + maximumSpanLength);
    for (let endToken = startToken + 1; endToken <= lastEndToken; endToken += 1) {
      const candidate = tokens.slice(startToken, endToken).join(" ");
      const result = parseTimeWindow(candidate, options);
      const span = { startToken, endToken, result };
      if (result.status === "matched" && result.window) {
        matchedSpans.push(span);
      } else if (result.status === "ambiguous" || isStructurallyInvalidTimeResult(result)) {
        problemSpans.push(span);
      }
    }
  }
  return { tokens, matchedSpans, problemSpans };
}

function maximalTimeWindowSpans(spans: readonly TimeWindowSpan[]): readonly TimeWindowSpan[] {
  return spans.filter((candidate) =>
    !spans.some((other) =>
      other !== candidate
      && containsSpan(other, candidate)
      && other.endToken - other.startToken > candidate.endToken - candidate.startToken
    )
  );
}

function containsSpan(container: TimeWindowSpan, contained: TimeWindowSpan): boolean {
  return container.startToken <= contained.startToken && container.endToken >= contained.endToken;
}

function timeWindowSpanConsumesTemporalEnvelope(
  tokens: readonly string[],
  span: TimeWindowSpan,
  options: ParseTimeWindowOptions & {
    readonly now: Date;
    readonly timezone: string;
  },
): boolean {
  let startToken = span.startToken;
  let endToken = span.endToken;
  while (
    startToken > 0
    && isTemporalEnvelopeToken(tokens[startToken - 1] ?? "")
  ) {
    const previous = tokens[startToken - 1] ?? "";
    const leading = tokens[startToken] ?? "";
    if (
      previous === leading
      && TEMPORAL_TRAILING_CONNECTORS.has(leading)
    ) {
      break;
    }
    if (previous === "on" && !sameWindow(tokens.slice(startToken - 1, span.endToken).join(" "), span, options)) {
      // "On" that cannot introduce the window closes the proposition instead:
      // "was the lamp on last week", "turn it on in ten minutes".
      break;
    }
    startToken -= 1;
  }
  while (
    endToken < tokens.length
    && isTemporalEnvelopeToken(tokens[endToken] ?? "")
  ) {
    endToken += 1;
  }
  while (
    endToken > span.endToken
    && TEMPORAL_TRAILING_CONNECTORS.has(tokens[endToken - 1] ?? "")
  ) {
    endToken -= 1;
  }
  if (startToken === span.startToken && endToken === span.endToken) {
    return true;
  }
  return sameWindow(tokens.slice(startToken, endToken).join(" "), span, options);
}

function sameWindow(
  text: string,
  span: TimeWindowSpan,
  options: ParseTimeWindowOptions & { readonly now: Date; readonly timezone: string },
): boolean {
  const parsed = parseTimeWindow(text, options);
  return parsed.status === "matched"
    && parsed.window !== null
    && span.result.window !== null
    && timeWindowIdentity(parsed.window)
      === timeWindowIdentity(span.result.window);
}

function isTemporalEnvelopeToken(token: string): boolean {
  return TIME_WINDOW_START_TOKENS.has(token)
    || token in MONTHS
    || token in WEEKDAYS
    || token in NUMBER_WORDS
    || ORDINAL_DAY_START_TOKENS.has(token)
    || TEMPORAL_ENVELOPE_TOKENS.has(token)
    || /^\d{1,4}(?:st|nd|rd|th)?$/.test(token);
}

function timeWindowIdentity(window: TimeWindow): string {
  return `${window.start}\u0000${window.end}\u0000${window.timezone}`;
}

function isStructurallyInvalidTimeResult(result: TimeWindowParseResult): boolean {
  return result.reason === "absolute date is invalid"
    || result.reason === "absolute range contains an unsupported date"
    || result.reason === "absolute range end is not after start";
}

function rollingResult(
  input: string,
  normalizedInput: string,
  now: Date,
  timezone: string,
  duration: Duration,
  confidence: TimeWindowConfidence,
): TimeWindowParseResult {
  const start = subtractDuration(now, timezone, duration);
  return matched(input, normalizedInput, {
    start: start.toISOString(),
    end: now.toISOString(),
    timezone,
    label: `last ${duration.amount} ${duration.unit}${duration.amount === 1 ? "" : "s"}`,
    source: "rolling_duration",
    confidence,
  });
}

/** A window from local midnight on `startDate` to local midnight on `endDate`. */
function midnightRange(
  input: string,
  normalizedInput: string,
  startDate: LocalDateParts,
  endDate: LocalDateParts,
  timezone: string,
  label: string,
  source: TimeWindowSource,
  confidence: TimeWindowConfidence,
): TimeWindowParseResult {
  return matched(input, normalizedInput, {
    start: zonedTimeToUtc({ ...startDate, hour: 0, minute: 0, second: 0 }, timezone).toISOString(),
    end: zonedTimeToUtc({ ...endDate, hour: 0, minute: 0, second: 0 }, timezone).toISOString(),
    timezone,
    label,
    source,
    confidence,
  });
}

function calendarDayResult(
  input: string,
  normalizedInput: string,
  date: LocalDateParts,
  timezone: string,
  label: string,
  source: TimeWindowSource,
  confidence: TimeWindowConfidence,
): TimeWindowParseResult {
  return midnightRange(input, normalizedInput, date, addDays(date, 1), timezone, label, source, confidence);
}

/** The calendar month that starts on `startDate` (the first of a month). */
function calendarMonthResult(
  input: string,
  normalizedInput: string,
  startDate: LocalDateParts,
  timezone: string,
  label: string,
  confidence: TimeWindowConfidence,
): TimeWindowParseResult {
  const endDate = addMonths({ ...startDate, hour: 0, minute: 0, second: 0 }, 1);
  return midnightRange(input, normalizedInput, startDate, endDate, timezone, label, "relative_calendar", confidence);
}

function namedLocalWindow(
  input: string,
  normalizedInput: string,
  date: LocalDateParts,
  spec: HouseholdAnchorWindow | DayPartSpec,
  timezone: string,
  label: string,
  source: TimeWindowSource,
  confidence: TimeWindowConfidence,
): TimeWindowParseResult {
  const startTime = parseFixedTime(spec.start);
  const endTime = parseFixedTime(spec.end);
  const endDate = spec.crossesMidnight || compareTime(endTime, startTime) <= 0 ? addDays(date, 1) : date;
  return matched(input, normalizedInput, {
    start: zonedTimeToUtc({ ...date, ...startTime, second: 0 }, timezone).toISOString(),
    end: zonedTimeToUtc({ ...endDate, ...endTime, second: 0 }, timezone).toISOString(),
    timezone,
    label,
    source,
    confidence,
  });
}

function matched(input: string, normalizedInput: string, window: TimeWindow): TimeWindowParseResult {
  return {
    status: "matched",
    input,
    normalizedInput,
    window,
    reason: null,
    fallbackRequest: null,
  };
}

function ambiguous(
  input: string,
  normalizedInput: string,
  now: Date,
  timezone: string,
  reason: string,
): TimeWindowParseResult {
  return {
    status: "ambiguous",
    input,
    normalizedInput,
    window: null,
    reason,
    fallbackRequest: buildTimeWindowFallbackRequest(input, { now, timezone }),
  };
}

function unresolved(
  input: string,
  normalizedInput: string,
  now: Date,
  timezone: string,
  reason: string,
): TimeWindowParseResult {
  return {
    status: "unmatched",
    input,
    normalizedInput,
    window: null,
    reason,
    fallbackRequest: buildTimeWindowFallbackRequest(input, { now, timezone }),
  };
}

function parseDateText(value: string, defaultYear: number): LocalDateParts | null {
  return parseDateTextResult(value, defaultYear).date;
}

function parseDateTextResult(value: string, defaultYear: number): ParsedDateText {
  const normalized = normalize(value);
  const slash = /^(\d{1,2}) slash (\d{1,2})(?: slash (\d{4}))?$/.exec(
    normalized,
  );
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    const year = Number(slash[3] ?? defaultYear);
    const monthFirst = first <= 12 && second > 12;
    return {
      recognized: true,
      date: monthFirst
        ? validDate(year, first, second)
        : validDate(year, second, first),
    };
  }
  const iso = /^(\d{4}) (\d{1,2}) (\d{1,2})$/.exec(normalized);
  if (iso) {
    return {
      recognized: true,
      date: validDate(Number(iso[1]), Number(iso[2]), Number(iso[3])),
    };
  }

  const split = splitDateYear(normalized, defaultYear);
  const monthFirst = new RegExp(`^(${MONTH_PATTERN})\\s+(?:the\\s+)?(${DAY_TOKEN_PATTERN})$`).exec(split.dateText);
  if (monthFirst) {
    const day = parseDayToken(monthFirst[2] ?? "");
    return {
      recognized: true,
      date: day === null
        ? null
        : validDate(split.year, monthNumber(monthFirst[1] ?? ""), day),
    };
  }

  const dayFirst = new RegExp(
    `^(?:the\\s+)?(${DAY_TOKEN_PATTERN})\\s+(?:of\\s+)?(${MONTH_PATTERN})$`,
  ).exec(split.dateText);
  if (dayFirst) {
    const day = parseDayToken(dayFirst[1] ?? "");
    return {
      recognized: true,
      date: day === null
        ? null
        : validDate(split.year, monthNumber(dayFirst[2] ?? ""), day),
    };
  }

  return { recognized: false, date: null };
}

function splitDateYear(normalized: string, defaultYear: number): {
  readonly dateText: string;
  readonly year: number;
} {
  const match = /^(.*?\S)\s+(?:(?:in|of)\s+)?((?:this|last|next)\s+year|\d{4})$/.exec(normalized);
  if (!match) {
    return { dateText: normalized, year: defaultYear };
  }
  const qualifier = match[2] ?? "";
  const year = /^\d{4}$/.test(qualifier)
    ? Number(qualifier)
    : qualifier === "last year"
      ? defaultYear - 1
      : qualifier === "next year"
        ? defaultYear + 1
        : defaultYear;
  return {
    dateText: match[1] ?? normalized,
    year,
  };
}

function parseDayToken(value: string): number | null {
  const wordOrdinal = ORDINAL_DAYS[value];
  if (wordOrdinal !== undefined) {
    return wordOrdinal;
  }
  const match = /^(\d{1,2})(st|nd|rd|th)?$/.exec(value);
  if (!match) {
    return null;
  }
  const day = Number(match[1]);
  const suffix = match[2];
  if (suffix && suffix !== ordinalSuffix(day)) {
    return null;
  }
  return day;
}

function ordinalSuffix(value: number): "st" | "nd" | "rd" | "th" {
  const lastTwoDigits = value % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 13) {
    return "th";
  }
  switch (value % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

function validDate(year: number, month: number, day: number): LocalDateParts | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

function parseClockTime(value: string): Pick<LocalDateTimeParts, "hour" | "minute"> | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(value);
  if (!match) {
    return null;
  }
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3];
  if (meridiem === "pm" && hour < 12) {
    hour += 12;
  }
  if (meridiem === "am" && hour === 12) {
    hour = 0;
  }
  if (hour > 23 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

function parseFixedTime(value: string): Pick<LocalDateTimeParts, "hour" | "minute"> {
  const parsed = parseClockTime(value);
  if (!parsed) {
    throw new Error(`fixed time is invalid: ${value}`);
  }
  return parsed;
}

function parseAmount(value: string): number | null {
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    return parsed > 0 ? parsed : null;
  }
  return NUMBER_WORDS[value] ?? null;
}

function parseUnit(value: string): DurationUnit | null {
  const singular = value.replace(/s$/, "");
  if (singular === "second" || singular === "minute" || singular === "hour" || singular === "day" || singular === "week" || singular === "month") {
    return singular;
  }
  return null;
}

function subtractDuration(now: Date, timezone: string, duration: Duration): Date {
  switch (duration.unit) {
    case "second":
      return new Date(now.getTime() - duration.amount * 1_000);
    case "minute":
      return new Date(now.getTime() - duration.amount * 60_000);
    case "hour":
      return new Date(now.getTime() - duration.amount * 3_600_000);
    case "day":
      return zonedTimeToUtc(addDays(zonedDateTimeParts(now, timezone), -duration.amount), timezone);
    case "week":
      return zonedTimeToUtc(addDays(zonedDateTimeParts(now, timezone), -duration.amount * 7), timezone);
    case "month":
      return zonedTimeToUtc(addMonths(zonedDateTimeParts(now, timezone), -duration.amount), timezone);
  }
}

function addDuration(now: Date, timezone: string, duration: Duration): Date {
  switch (duration.unit) {
    case "second":
      return new Date(now.getTime() + duration.amount * 1_000);
    case "minute":
      return new Date(now.getTime() + duration.amount * 60_000);
    case "hour":
      return new Date(now.getTime() + duration.amount * 3_600_000);
    case "day":
      return zonedTimeToUtc(addDays(zonedDateTimeParts(now, timezone), duration.amount), timezone);
    case "week":
      return zonedTimeToUtc(addDays(zonedDateTimeParts(now, timezone), duration.amount * 7), timezone);
    case "month":
      return zonedTimeToUtc(addMonths(zonedDateTimeParts(now, timezone), duration.amount), timezone);
  }
}

function dayForQualifier(today: LocalDateParts, qualifier: string, night: boolean): LocalDateParts {
  switch (qualifier) {
    case "yesterday":
    case "last":
      return addDays(today, -1);
    case "tomorrow":
      return addDays(today, 1);
    case "tonight":
      return today;
    case "this":
    case "today":
      return night ? today : today;
    default:
      return today;
  }
}

function addDays<T extends LocalDateParts>(parts: T, days: number): T {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    ...parts,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function weekdayForLocalDate(parts: LocalDateParts): number {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function addMonths<T extends LocalDateTimeParts>(parts: T, months: number): T {
  const targetMonth = parts.month - 1 + months;
  const firstOfTarget = new Date(Date.UTC(parts.year, targetMonth, 1));
  const year = firstOfTarget.getUTCFullYear();
  const month = firstOfTarget.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    ...parts,
    year,
    month,
    day: Math.min(parts.day, lastDay),
  };
}

function zonedDateParts(date: Date, timezone: string): LocalDateParts {
  const parts = zonedDateTimeParts(date, timezone);
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
  };
}

function compareTime(
  left: Pick<LocalDateTimeParts, "hour" | "minute">,
  right: Pick<LocalDateTimeParts, "hour" | "minute">,
): number {
  return left.hour * 60 + left.minute - (right.hour * 60 + right.minute);
}

function formatLocalDate(date: LocalDateParts): string {
  return [
    String(date.year).padStart(4, "0"),
    String(date.month).padStart(2, "0"),
    String(date.day).padStart(2, "0"),
  ].join("-");
}

function normalize(value: string): string {
  const markedNumericDate = value.replace(
    /\b(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{4}))?\b/g,
    (_match, first: string, second: string, year: string | undefined) =>
      `${first} slash ${second}${year ? ` slash ${year}` : ""}`,
  );
  return normalizeSpeechForRouting(markedNumericDate);
}

function monthNumber(value: string): number {
  return MONTHS[value] ?? 0;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/** Month names and abbreviations (the lexicon exports them). */
export const MONTH_NAMES: readonly string[] = Object.freeze(Object.keys(MONTHS));
const MONTH_PATTERN = MONTH_NAMES.join("|");
const WEEKDAYS: Readonly<Record<string, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};
/** Weekday names, Sunday first (the lexicon exports them). */
export const WEEKDAY_NAMES: readonly string[] = Object.freeze(Object.keys(WEEKDAYS));
const WEEKDAY_PATTERN = WEEKDAY_NAMES.join("|");
const ORDINAL_DAYS: Readonly<Record<string, number>> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  "twenty first": 21,
  "twenty second": 22,
  "twenty third": 23,
  "twenty fourth": 24,
  "twenty fifth": 25,
  "twenty sixth": 26,
  "twenty seventh": 27,
  "twenty eighth": 28,
  "twenty ninth": 29,
  thirtieth: 30,
  "thirty first": 31,
};
const ORDINAL_DAY_START_TOKENS = new Set(
  Object.keys(ORDINAL_DAYS).map((value) => value.split(" ")[0] ?? value),
);
const DAY_TOKEN_PATTERN = `(?:\\d{1,2}(?:st|nd|rd|th)?|${Object.keys(
  ORDINAL_DAYS,
)
  .sort((left, right) => right.length - left.length)
  .join("|")})`;
const MAX_STRUCTURAL_TIME_SPAN_TOKENS = 18;
const TEMPORAL_ENVELOPE_TOKENS = new Set([
  "day",
  "days",
  "from",
  "in",
  "month",
  "months",
  "of",
  "on",
  "over",
  "slash",
  "the",
  "to",
  "within",
  "week",
  "weekend",
  "weeks",
  "year",
  "years",
]);
const TEMPORAL_TRAILING_CONNECTORS = new Set([
  "and",
  "from",
  "in",
  "of",
  "on",
  "over",
  "the",
  "to",
]);

const TIME_WINDOW_START_TOKENS = new Set([
  "between",
  "from",
  "last",
  "morning",
  "next",
  "night",
  "on",
  "over",
  "past",
  "previous",
  "rolling",
  "since",
  "the",
  "this",
  "today",
  "tomorrow",
  "tonight",
  "within",
  "weekend",
  "yesterday",
  "afternoon",
  "evening",
]);

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  couple: 2,
};

const DAY_PARTS: Readonly<Record<string, DayPartSpec>> = {
  morning: { start: "05:00", end: "12:00" },
  afternoon: { start: "12:00", end: "17:00" },
  evening: { start: "17:00", end: "21:00" },
  night: { start: "21:00", end: "05:00", crossesMidnight: true },
};

const DEFAULT_ANCHORS: Readonly<Record<string, HouseholdAnchorWindow>> = {
  breakfast: { start: "07:00", end: "09:00" },
  lunch: { start: "12:00", end: "13:30" },
  dinner: { start: "18:00", end: "20:00" },
  bedtime: { start: "21:00", end: "23:00" },
};
