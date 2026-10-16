import { entityStatusSentence, groupEntityStatusSentence } from "./speech-planner.js";
import { formatForSpeech } from "./spoken-format.js";
import { capitalize, joinNatural, lowerInitial } from "./text-format.js";

export type BasicSpeechChannel = "voice" | "chat" | "test";
/** `own` is the live voice; `plain` the older plain lead phrasing. */
export type BasicSpeechStyle = "own" | "plain";

export interface BasicSpeechGroupItem {
  readonly label: string;
  readonly state: string;
  readonly unit?: string | null;
}

export type BasicSpeechRenderPlan =
  | {
    readonly kind: "current_time";
    readonly clockText: string;
    readonly naturalClockText: string;
  }
  | {
    readonly kind: "current_day";
    readonly day: string;
  }
  | {
    readonly kind: "current_date";
    readonly date: string;
  }
  | {
    readonly kind: "entity_status_single";
    readonly label: string;
    readonly state: string;
    readonly unit?: string | null;
    readonly polarity?: "yes" | "no" | null;
  }
  | {
    readonly kind: "entity_status_group";
    readonly label: string;
    readonly items: readonly BasicSpeechGroupItem[];
    readonly polarity?: "yes" | "no" | null;
  }
  | {
    readonly kind: "house_lights_none";
  }
  | {
    readonly kind: "house_lights_some";
    readonly names: readonly string[];
    readonly remainder?: boolean;
  }
  | {
    readonly kind: "metric_current";
    readonly subject: string;
    readonly measurement: string;
    readonly drawsPower: boolean;
  }
  | {
    readonly kind: "metric_baseline";
    readonly polarity?: "yes" | "no" | null;
    readonly relation: "higher" | "lower" | "same";
    readonly currentMeasurement: string;
    readonly averageMeasurement: string;
  }
  | {
    readonly kind: "weather_now";
    readonly summary: string;
    readonly location: string;
    readonly temperatureText?: string | null;
    readonly feelsLikeText?: string | null;
    readonly windy?: boolean;
    readonly rainLikely?: boolean;
  }
  | {
    readonly kind: "calendar_empty";
    readonly windowLabel: string;
  }
  | {
    readonly kind: "calendar_events";
    readonly count: number;
    readonly windowLabel: string;
    readonly items: readonly string[];
    readonly remainingCount: number;
  }
  | {
    readonly kind: "calculation";
    readonly statement: string;
  }
  | {
    readonly kind: "energy_budget";
    readonly mode:
      | "summary"
      | "used"
      | "remaining"
      | "projection"
      | "daily_target"
      | "allowance"
      | "suggested_cap"
      | "history"
      | "history_coverage"
      | "formula"
      | "formula_component"
      | "source_status"
      | "percent";
    readonly statement: string;
  }
  | {
    readonly kind: "todo_items";
    readonly listName: string | null;
    readonly items: readonly string[];
    readonly totalCount: number;
    readonly remainingCount: number;
    readonly grouped: boolean;
  }
  | {
    readonly kind: "alarm_set";
    readonly timeText: string;
  }
  | {
    readonly kind: "alarm_stopped";
    readonly action: "cancelled" | "stopped";
  }
  | {
    readonly kind: "music_playback";
    readonly track: string;
    readonly artist: string | null;
    readonly endpoint: string;
  }
  | {
    readonly kind: "house_summary";
    readonly scope: "today" | "tonight";
    readonly parts: readonly string[];
  }
  | {
    readonly kind: "event_log";
    readonly scope: "recent" | "today" | "tonight" | "while_i_was_out";
    readonly lead: string;
    readonly entries: readonly string[];
    readonly quiet: boolean;
  }
  | {
    /** Catch-up digest: code-built wording, spoken as built. */
    readonly kind: "catchup";
    readonly scope: "while_i_was_out" | "since_last_spoke" | "today";
    readonly lead: string;
    readonly entries: readonly string[];
    readonly closing: string | null;
    readonly quiet: boolean;
  }
  | {
    /** "How are you?": the assistant answers for himself, code-owned and model-free. */
    readonly kind: "check_in";
    readonly speakerName: string | null;
  };

export function renderBasicSpeechText(
  plan: BasicSpeechRenderPlan | null | undefined,
  fallbackText: string,
  channel: BasicSpeechChannel,
  variationIndex?: number,
  style: BasicSpeechStyle = "own",
): string {
  if (channel !== "voice" && channel !== "test") {
    return formatForSpeech(fallbackText);
  }
  if (!plan) {
    return formatForSpeech(fallbackText);
  }
  return formatForSpeech(style === "own" ? ownVoiceLead(plan, variationIndex) : renderVoiceLead(plan, variationIndex));
}

export function basicSpeechVariationCount(plan: BasicSpeechRenderPlan): number {
  switch (plan.kind) {
    case "current_time":
    case "current_day":
    case "current_date":
      return 6;
    case "entity_status_single":
    case "entity_status_group":
      return 8;
    case "house_lights_none":
    case "house_lights_some":
      return 10;
    case "metric_current":
    case "metric_baseline":
    case "weather_now":
      return 8;
    case "calendar_empty":
    case "calendar_events":
    case "todo_items":
      return 10;
    case "calculation":
    case "energy_budget":
    case "alarm_set":
    case "alarm_stopped":
    case "music_playback":
    case "house_summary":
    case "event_log":
      return 6;
    case "catchup":
      return 1;
    case "check_in":
      return CHECK_IN_VARIANT_COUNT;
  }
}

function renderVoiceLead(plan: BasicSpeechRenderPlan, variationIndex?: number): string {
  switch (plan.kind) {
    case "current_time":
      return currentTimeSentence(plan, variationIndex);
    case "current_day":
      return currentDaySentence(plan.day, variationIndex);
    case "current_date":
      return currentDateSentence(plan.date, variationIndex);
    case "entity_status_single":
      return varyDeclarativeSentence(entityStatusSentence(
        {
          label: plan.label,
          state: plan.state,
          ...(plan.unit ? { unit: plan.unit } : {}),
        },
        {
          compact: true,
          polarity: plan.polarity ?? null,
        },
      ), variationIndex);
    case "entity_status_group":
      return varyDeclarativeSentence(groupEntityStatusSentence(
        {
          label: plan.label,
          items: plan.items,
        },
        {
          compact: true,
          polarity: plan.polarity ?? null,
        },
      ), variationIndex);
    case "house_lights_none":
      return houseLightsNoneSentence(variationIndex);
    case "house_lights_some":
      return houseLightsSentence(plan.names, plan.remainder ?? false, variationIndex);
    case "metric_current":
      return metricCurrentSentence(plan, variationIndex);
    case "metric_baseline":
      return baselineSentence(plan, variationIndex);
    case "weather_now":
      return weatherNowSentence(plan, variationIndex);
    case "calendar_empty":
      return calendarEmptySentence(plan.windowLabel, variationIndex);
    case "calendar_events":
      return calendarEventsSentence(plan, variationIndex);
    case "calculation":
      return calculationSentence(plan.statement, variationIndex);
    case "energy_budget":
      return energyBudgetSentence(plan, variationIndex);
    case "todo_items":
      return todoItemsSentence(plan, variationIndex);
    case "alarm_set":
      return alarmSetSentence(plan.timeText, variationIndex);
    case "alarm_stopped":
      return alarmStoppedSentence(plan.action, variationIndex);
    case "music_playback":
      return musicPlaybackSentence(plan, variationIndex);
    case "house_summary":
      return houseSummarySentence(plan, variationIndex);
    case "event_log":
      return eventLogSentence(plan, variationIndex);
    case "catchup":
      return [plan.lead, ...plan.entries, plan.closing].filter((part): part is string => Boolean(part)).join(" ");
    case "check_in":
      return checkInSentence(plan.speakerName, variationIndex);
  }
}

function currentTimeSentence(
  plan: Extract<BasicSpeechRenderPlan, { kind: "current_time" }>,
  variationIndex?: number,
): string {
  const variants = [
    `It is ${plan.naturalClockText}.`,
    `The time is ${plan.naturalClockText}.`,
    `By the clock, it is ${plan.naturalClockText}.`,
    `The clock has it at ${plan.naturalClockText}.`,
    `The precise time is ${plan.naturalClockText}.`,
    `It is precisely ${plan.naturalClockText}.`,
  ];
  return selectVariant(variants, variationIndex, `It is ${plan.clockText}.`);
}

function currentDaySentence(day: string, variationIndex?: number): string {
  const variants = [
    `Today is ${day}.`,
    `It is ${day}.`,
    `The day is ${day}.`,
    `This is ${day}.`,
    `By the calendar, it is ${day}.`,
    `We are on ${day}.`,
  ];
  return selectVariant(variants, variationIndex, `Today is ${day}.`);
}

function currentDateSentence(date: string, variationIndex?: number): string {
  const variants = [
    `Today is ${date}.`,
    `The date is ${date}.`,
    `It is ${date}.`,
    `By the calendar, it is ${date}.`,
    `The full date is ${date}.`,
    `We are on ${date}.`,
  ];
  return selectVariant(variants, variationIndex, `Today is ${date}.`);
}

function varyDeclarativeSentence(sentence: string, variationIndex?: number): string {
  const polarity = /^(Yes|No)\.\s+(.+)$/.exec(sentence);
  if (polarity) {
    const answer = polarity[1] ?? "";
    const fact = polarity[2] ?? "";
    const lowerFact = lowerInitial(fact);
    return selectVariant([
      sentence,
      `${answer}; ${lowerFact}`,
      `${answer}—${lowerFact}`,
      `${answer}. The fact is that ${lowerFact}`,
      `${answer}. As matters stand, ${lowerFact}`,
      `${answer}. In fact, ${lowerFact}`,
      `${answer}. The present state is clear: ${lowerFact}`,
      `${answer}. The answer is straightforward: ${lowerFact}`,
    ], variationIndex, sentence);
  }
  const lowerSentence = lowerInitial(sentence);
  return selectVariant([
    sentence,
    `The fact is that ${lowerSentence}`,
    `As matters stand, ${lowerSentence}`,
    `In fact, ${lowerSentence}`,
    `The present state is clear: ${lowerSentence}`,
    `The answer is straightforward: ${lowerSentence}`,
    `The present state is plain: ${lowerSentence}`,
    `Quite simply, ${lowerSentence}`,
  ], variationIndex, sentence);
}

function houseLightsNoneSentence(variationIndex?: number): string {
  return selectVariant([
    "No lights are on.",
    "No. Every house light is off.",
    "No. The house lights are all off.",
    "No. Not one house light is on.",
    "No. There is not a light on in the house.",
    "No. The lights are off throughout the house.",
    "No. None of the house lights are on.",
    "No. The position is simple: every house light is off.",
    "No. As matters stand, every house light is off.",
    "No. The answer is none; every house light is off.",
  ], variationIndex, "No lights are on.");
}

function houseLightsSentence(names: readonly string[], remainder: boolean, variationIndex?: number): string {
  if (names.length === 0) {
    return houseLightsNoneSentence(variationIndex);
  }
  if (remainder) {
    if (names.length === 1) {
      const name = names[0];
      return selectVariant([
        `The other light is ${name}.`,
        `${name} is the other light.`,
        `The remaining light is ${name}.`,
        `That leaves ${name}.`,
        `The one not yet named is ${name}.`,
        `The final light is ${name}.`,
        `The remainder is ${name}.`,
        `One light remains to be named: ${name}.`,
        `The outstanding light is ${name}.`,
        `The rest amounts to one light: ${name}.`,
      ], variationIndex, `The other light is ${name}.`);
    }
    const joined = joinNatural(names);
    return selectVariant([
      `The other ${names.length} lights are ${joined}.`,
      `The remaining ${names.length} lights are ${joined}.`,
      `That leaves ${joined}.`,
      `The lights not yet named are ${joined}.`,
      `The rest are ${joined}.`,
      `The remainder is ${joined}.`,
      `${joined} complete the list.`,
      `The outstanding lights are ${joined}.`,
      `There are ${names.length} others: ${joined}.`,
      `The balance of the list is ${joined}.`,
    ], variationIndex, `The other ${names.length} lights are ${joined}.`);
  }
  if (names.length === 1) {
    const name = names[0];
    return selectVariant([
      `Yes. One light is on: ${name}.`,
      `Yes. ${name} is the only light on.`,
      `Yes. Only ${name} is on.`,
      `Yes. There is one light on: ${name}.`,
      `Yes. The sole light on is ${name}.`,
      `Yes. Every light is off except ${name}.`,
      `Yes. ${name} alone is on.`,
      `Yes. The house has one light on: ${name}.`,
      `Yes. The list contains one light: ${name}.`,
      `Yes. One light, and one only, is on: ${name}.`,
    ], variationIndex, `Yes. One light is on: ${name}.`);
  }
  const shown = names.length <= 3 ? names : names.slice(0, 3);
  const joined = joinNatural(shown);
  const remaining = names.length - shown.length;
  if (remaining === 0) {
    return selectVariant([
      `Yes. ${names.length} lights are on: ${joined}.`,
      `Yes. The lights on are ${joined}.`,
      `Yes. ${joined} are on.`,
      `Yes. There are ${names.length} lights on: ${joined}.`,
      `Yes. As matters stand, ${joined} are on.`,
      `Yes. The house has ${names.length} lights on: ${joined}.`,
      `Yes. The complete list is ${joined}.`,
      `Yes. I can see ${names.length} lights on: ${joined}.`,
      `Yes. The lights on in the house are ${joined}.`,
      `Yes. The position is clear: ${joined} are on.`,
    ], variationIndex, `Yes. ${names.length} lights are on: ${joined}.`);
  }
  return selectVariant([
    `Yes. ${names.length} lights are on: ${joined}, and ${remaining} more.`,
    `Yes. The lights on include ${joined}, with ${remaining} more.`,
    `Yes. ${joined} are on, along with ${remaining} others.`,
    `Yes. There are ${names.length} lights on: ${joined}, then ${remaining} more.`,
    `Yes. The house has ${names.length} lights on; ${joined}, and ${remaining} others.`,
    `Yes. I can see ${names.length} lights on: ${joined}, plus ${remaining} more.`,
    `Yes. The list begins with ${joined}, with ${remaining} still to name.`,
    `Yes. On are ${joined}, together with ${remaining} others.`,
    `Yes. The position is ${names.length} lights on: ${joined}, and ${remaining} more.`,
    `Yes. ${joined} account for three of the ${names.length} lights on.`,
  ], variationIndex, `Yes. ${names.length} lights are on: ${joined}, and ${remaining} more.`);
}

function metricCurrentSentence(
  plan: Extract<BasicSpeechRenderPlan, { kind: "metric_current" }>,
  variationIndex?: number,
): string {
  const subject = naturalMetricSubject(plan.subject);
  const fact = plan.drawsPower
    ? `${subject} is drawing ${plan.measurement}.`
    : `${subject} is ${plan.measurement}.`;
  const predicate = plan.drawsPower
    ? `drawing ${plan.measurement}`
    : `at ${plan.measurement}`;
  return selectVariant([
    fact,
    plan.drawsPower
      ? `${subject} is using ${plan.measurement}.`
      : `${subject} reads ${plan.measurement}.`,
    `The reading for ${lowerInitial(subject)} is ${plan.measurement}.`,
    `As matters stand, ${lowerInitial(subject)} is ${predicate}.`,
    `The present figure for ${lowerInitial(subject)} is ${plan.measurement}.`,
    `For ${lowerInitial(subject)}, the reading is ${plan.measurement}.`,
    `More precisely, ${lowerInitial(subject)} is ${predicate}.`,
    `The figure for ${lowerInitial(subject)} is ${plan.measurement}.`,
  ], variationIndex, fact);
}

function baselineSentence(
  plan: Extract<BasicSpeechRenderPlan, { kind: "metric_baseline" }>,
  variationIndex?: number,
): string {
  const comparison = plan.relation === "same"
    ? `That's about the usual same-time draw: ${plan.currentMeasurement} and about ${plan.averageMeasurement}.`
    : `That's ${plan.relation} than the usual same-time draw: ${plan.currentMeasurement} against about ${plan.averageMeasurement}.`;
  const answer = plan.polarity ? `${plan.polarity === "yes" ? "Yes" : "No"}. ` : "";
  const relation = plan.relation === "same" ? "about level with" : `${plan.relation} than`;
  const position = plan.relation === "same" ? "in line with" : plan.relation === "higher" ? "above" : "below";
  const relativeConclusion = plan.relation === "same" ? "about the usual level" : `${plan.relation} than usual`;
  return selectVariant([
    `${answer}${comparison}`,
    `${answer}It is ${relation} the usual same-time draw: ${plan.currentMeasurement} against about ${plan.averageMeasurement}.`,
    `${answer}The comparison is ${plan.currentMeasurement} against about ${plan.averageMeasurement}; that is ${relativeConclusion}.`,
    `${answer}At this hour, ${plan.currentMeasurement} is ${position} the usual level of about ${plan.averageMeasurement}.`,
    `${answer}The present draw is ${plan.currentMeasurement}; the same-time average is about ${plan.averageMeasurement}.`,
    `${answer}Measured against the usual level of about ${plan.averageMeasurement}, the present ${plan.currentMeasurement} is ${position} it.`,
    `${answer}The figures are ${plan.currentMeasurement} now and about ${plan.averageMeasurement} ordinarily, placing the present draw ${position} normal.`,
    `${answer}The figures are ${plan.currentMeasurement} now against about ${plan.averageMeasurement} normally. That puts the present draw ${position} the ordinary level.`,
  ], variationIndex, `${answer}${comparison}`);
}

function weatherNowSentence(
  plan: Extract<BasicSpeechRenderPlan, { kind: "weather_now" }>,
  variationIndex?: number,
): string {
  const tempText = plan.temperatureText ? `, about ${plan.temperatureText}` : "";
  const feelsLikeText = plan.feelsLikeText ? `, but it feels like ${plan.feelsLikeText}` : "";
  const windyText = plan.windy && !/\bwind(?:y|ier|iest)?\b/i.test(plan.summary) ? ", and windy" : "";
  const rainText = plan.rainLikely ? " Rain is likely." : "";
  const exactWeather = `It's ${plan.summary} in ${plan.location}${tempText}${feelsLikeText}${windyText}.${plan.rainLikely ? " Rain's likely." : ""}`;
  const subject = `Conditions in ${plan.location} are ${plan.summary}${tempText}${feelsLikeText}${windyText}.`;
  return selectVariant([
    exactWeather,
    `Outside in ${plan.location}, it is ${plan.summary}${tempText}${feelsLikeText}${windyText}.${rainText}`,
    `The weather in ${plan.location} is ${plan.summary}${tempText}${feelsLikeText}${windyText}.${rainText}`,
    `${subject}${rainText}`,
    `At the moment, conditions in ${plan.location} are ${plan.summary}${tempText}${feelsLikeText}${windyText}.${rainText}`,
    `As matters stand in ${plan.location}, it is ${plan.summary}${tempText}${feelsLikeText}${windyText}.${rainText}`,
    `More precisely, it is ${plan.summary} in ${plan.location}${tempText}${feelsLikeText}${windyText}.${rainText}`,
    `Outside in ${plan.location}, conditions are ${plan.summary}${tempText}${feelsLikeText}${windyText}.${rainText}`,
  ], variationIndex, exactWeather);
}

function calendarEmptySentence(windowLabel: string, variationIndex?: number): string {
  return selectVariant([
    `I don't see anything on the calendar ${windowLabel}.`,
    `The calendar is clear ${windowLabel}.`,
    `There is nothing on the calendar ${windowLabel}.`,
    `No events appear on the calendar ${windowLabel}.`,
    `The calendar contains no events ${windowLabel}.`,
    `Nothing is scheduled on the calendar ${windowLabel}.`,
    `The diary is clear ${windowLabel}.`,
    `There are no calendar entries ${windowLabel}.`,
    `The calendar has nothing listed ${windowLabel}.`,
    `As matters stand, the calendar is empty ${windowLabel}.`,
  ], variationIndex, `I don't see anything on the calendar ${windowLabel}.`);
}

function calendarEventsSentence(
  plan: Extract<BasicSpeechRenderPlan, { kind: "calendar_events" }>,
  variationIndex?: number,
): string {
  const joined = joinNatural(plan.items);
  const more = plan.remainingCount > 0 ? `, and ${plan.remainingCount} more` : "";
  const noun = plan.count === 1 ? "event" : "events";
  return selectVariant([
    `I found ${numberWord(plan.count)} calendar ${noun} ${plan.windowLabel}: ${joined}${more}.`,
    `The calendar has ${numberWord(plan.count)} ${noun} ${plan.windowLabel}: ${joined}${more}.`,
    `There ${plan.count === 1 ? "is" : "are"} ${numberWord(plan.count)} ${noun} ${plan.windowLabel}: ${joined}${more}.`,
    `For ${plan.windowLabel}, the calendar lists ${joined}${more}.`,
    `The calendar ${plan.count === 1 ? "entry" : "entries"} ${plan.windowLabel} ${plan.count === 1 ? "is" : "are"} ${joined}${more}.`,
    `On the calendar ${plan.windowLabel}: ${joined}${more}.`,
    `The calendar shows ${numberWord(plan.count)} ${noun} ${plan.windowLabel}: ${joined}${more}.`,
    `As matters stand, the calendar contains ${numberWord(plan.count)} ${noun} ${plan.windowLabel}: ${joined}${more}.`,
    `The diary records ${numberWord(plan.count)} ${noun} ${plan.windowLabel}: ${joined}${more}.`,
    `${numberWord(plan.count, true)} calendar ${noun} appear ${plan.windowLabel}: ${joined}${more}.`,
  ], variationIndex, `I found ${numberWord(plan.count)} calendar ${noun} ${plan.windowLabel}: ${joined}${more}.`);
}

function calculationSentence(statement: string, variationIndex?: number): string {
  const lowerStatement = lowerInitial(statement);
  return selectVariant([
    statement,
    `The arithmetic is straightforward: ${lowerStatement}`,
    `The result is equally straightforward: ${lowerStatement}`,
    `Put plainly, ${lowerStatement}`,
    `The calculation gives us this: ${lowerStatement}`,
    `There is no mystery in the arithmetic: ${lowerStatement}`,
  ], variationIndex, statement);
}

function energyBudgetSentence(
  plan: Extract<BasicSpeechRenderPlan, { kind: "energy_budget" }>,
  variationIndex?: number,
): string {
  const polarity = /^(Yes|No)\.\s+(.+)$/.exec(plan.statement);
  const prefix = polarity ? `${polarity[1]}. ` : "";
  const statement = polarity?.[2] ?? plan.statement;
  const lowerStatement = lowerInitial(statement);
  const formulaMode = plan.mode === "formula" || plan.mode === "formula_component";
  const sourceMode = plan.mode === "source_status";
  const historyMode = plan.mode === "history" || plan.mode === "history_coverage";
  const subject = formulaMode
    ? "The formula"
    : sourceMode
      ? "The source position"
      : historyMode
        ? "The historical record"
        : "The budget position";
  const details = formulaMode
    ? "The terms are these"
    : sourceMode
      ? "The source facts are these"
      : historyMode
        ? "The record is this"
        : "The figures are these";
  const standing = formulaMode
    ? "As the formula stands"
    : sourceMode
      ? "As the source stands"
      : historyMode
        ? "As the record stands"
        : "As the numbers stand";
  return selectVariant([
    plan.statement,
    `${prefix}${subject} is straightforward: ${lowerStatement}`,
    `${prefix}${details}: ${lowerStatement}`,
    `${prefix}Put plainly, ${lowerStatement}`,
    `${prefix}The relevant fact is this: ${lowerStatement}`,
    `${prefix}${standing}, ${lowerStatement}`,
  ], variationIndex, plan.statement);
}

function todoItemsSentence(
  plan: Extract<BasicSpeechRenderPlan, { kind: "todo_items" }>,
  variationIndex?: number,
): string {
  if (plan.totalCount === 0) {
    const subject = plan.listName ?? "The to-do lists";
    const listReference = plan.listName ? `the ${plan.listName}` : "the to-do lists";
    return selectVariant([
      `${subject} ${plan.listName ? "is" : "are"} empty.`,
      `There is nothing on ${listReference}.`,
      `${subject} contain${plan.listName ? "s" : ""} no open items.`,
      `No open items appear on ${listReference}.`,
      `${subject} ${plan.listName ? "has" : "have"} nothing outstanding.`,
      `The position is clear: ${subject} ${plan.listName ? "is" : "are"} empty.`,
      `As matters stand, ${subject} contain${plan.listName ? "s" : ""} nothing.`,
      `There are no outstanding items on ${listReference}.`,
      `${subject} ${plan.listName ? "remains" : "remain"} clear.`,
      `Nothing requires attention on ${listReference}.`,
    ], variationIndex, `${subject} ${plan.listName ? "is" : "are"} empty.`);
  }
  const shown = joinNatural(plan.items);
  const more = plan.remainingCount > 0 ? `, and ${plan.remainingCount} more` : "";
  const subject = plan.listName ?? "The open to-do lists";
  const listReference = plan.listName ? `the ${plan.listName}` : "the to-do lists";
  const noun = plan.totalCount === 1 ? "item" : "items";
  return selectVariant([
    `${subject} ${plan.grouped ? "show" : "has"} ${numberWord(plan.totalCount)} ${noun}: ${shown}${more}.`,
    `There ${plan.totalCount === 1 ? "is" : "are"} ${numberWord(plan.totalCount)} open ${noun} on ${listReference}: ${shown}${more}.`,
    `The outstanding ${noun} on ${listReference} ${plan.totalCount === 1 ? "is" : "are"} ${shown}${more}.`,
    `On ${listReference}: ${shown}${more}.`,
    `${subject} contain${plan.listName ? "s" : ""} ${numberWord(plan.totalCount)} open ${noun}: ${shown}${more}.`,
    `The list is straightforward: ${shown}${more}.`,
    `As matters stand, ${subject} contain${plan.listName ? "s" : ""} ${shown}${more}.`,
    `The open entries are ${shown}${more}.`,
    `${numberWord(plan.totalCount, true)} ${noun} remain open: ${shown}${more}.`,
    `The position is ${numberWord(plan.totalCount)} open ${noun}: ${shown}${more}.`,
  ], variationIndex, `${subject} has ${numberWord(plan.totalCount)} ${noun}: ${shown}${more}.`);
}

function alarmSetSentence(timeText: string, variationIndex?: number): string {
  return selectVariant([
    `Alarm set for ${timeText}.`,
    `The alarm is set for ${timeText}.`,
    `I have set the alarm for ${timeText}.`,
    `The alarm will sound at ${timeText}.`,
    `The time is fixed: ${timeText}.`,
    `The alarm stands at ${timeText}.`,
  ], variationIndex, `Alarm set for ${timeText}.`);
}

function alarmStoppedSentence(action: "cancelled" | "stopped", variationIndex?: number): string {
  const verb = action === "cancelled" ? "cancelled" : "stopped";
  const noun = action === "cancelled" ? "scheduled alarm" : "alarm";
  return selectVariant([
    `The ${noun} is ${verb}.`,
    `${capitalize(verb)} the ${noun}.`,
    `I have ${verb} the ${noun}.`,
    `The ${noun} has been ${verb}.`,
    `That ${noun} is now ${verb}.`,
    `The matter is settled: the ${noun} is ${verb}.`,
  ], variationIndex, `${capitalize(verb)} the ${noun}.`);
}

function musicPlaybackSentence(
  plan: Extract<BasicSpeechRenderPlan, { kind: "music_playback" }>,
  variationIndex?: number,
): string {
  const track = `${plan.track}${plan.artist ? ` by ${plan.artist}` : ""}`;
  return selectVariant([
    `Playing ${track} on ${plan.endpoint}.`,
    `${track} is playing on ${plan.endpoint}.`,
    `I have put ${track} on ${plan.endpoint}.`,
    `On ${plan.endpoint}: ${track}.`,
    `The selection is ${track}, playing on ${plan.endpoint}.`,
    `The track on ${plan.endpoint} is ${track}.`,
  ], variationIndex, `Playing ${track} on ${plan.endpoint}.`);
}

function houseSummarySentence(
  plan: Extract<BasicSpeechRenderPlan, { kind: "house_summary" }>,
  variationIndex?: number,
): string {
  const facts = plan.parts.join(" ");
  const scope = plan.scope === "tonight" ? "tonight" : "today";
  return selectVariant([
    facts,
    `The house, in brief: ${facts}`,
    `The position ${scope} is this: ${facts}`,
    `A concise account of the house: ${facts}`,
    `The relevant facts are these: ${facts}`,
    `As the house stands ${scope}: ${facts}`,
  ], variationIndex, facts);
}

function eventLogSentence(
  plan: Extract<BasicSpeechRenderPlan, { kind: "event_log" }>,
  variationIndex?: number,
): string {
  const entries = plan.entries.join(" ");
  if (plan.quiet) {
    const period = plan.scope === "while_i_was_out"
      ? "while you were out"
      : plan.scope === "recent"
        ? "recently"
        : plan.scope;
    return selectVariant([
      `${plan.lead} nothing notable appears in the watched house log.`,
      `${plan.lead} the watched house log is quiet.`,
      `${plan.lead} there is nothing of note in the house log.`,
      `${plan.lead} no notable change was recorded.`,
      `${plan.lead} the record is uneventful${plan.scope === "while_i_was_out" ? ` ${period}` : ""}.`,
      `${plan.lead} the plain answer is that nothing notable occurred.`,
    ], variationIndex, `${plan.lead} nothing notable appears in the watched house log.`);
  }
  return selectVariant([
    `${plan.lead} ${entries}`,
    `${plan.lead} the record is as follows. ${entries}`,
    `${plan.lead} the notable events are these. ${entries}`,
    `${plan.lead} the house log records this. ${entries}`,
    `${plan.lead} the facts, in order, are these. ${entries}`,
    `${plan.lead} the account is straightforward. ${entries}`,
  ], variationIndex, `${plan.lead} ${entries}`);
}

function naturalMetricSubject(subject: string): string {
  if (/^house$/i.test(subject)) {
    return "The house";
  }
  if (/^office$/i.test(subject)) {
    return "The office";
  }
  return subject;
}

/*
 * The assistant's answer to "How are you?". Honest per SELF.md:
 * what he can actually report is that he is running and here; no invented
 * feelings, no house facts nobody checked, and only one line in six asks
 * The owner back.
 */
const CHECK_IN_VARIANT_COUNT = 6;

export function checkInSentence(speakerName: string | null, variationIndex?: number): string {
  const name = speakerName ? `, ${speakerName}` : "";
  const variants = [
    `I am well, thank you${name}. Everything is running as it should.`,
    `I am well. Everything is in order here.`,
    `Quite well, thank you. Settled and listening.`,
    `I am well${name}. Everything is running, and I am here.`,
    `Quite well, thank you. It is quiet here, which suits me.`,
    `I am well, thank you${name}. How is your day progressing?`,
  ];
  return selectVariant(variants, variationIndex, variants[0] ?? "I am well, thank you.");
}

function selectVariant(variants: readonly string[], variationIndex: number | undefined, fallback: string): string {
  if (variationIndex === undefined || variants.length === 0) {
    return fallback;
  }
  return variants[positiveModulo(variationIndex, variants.length)] ?? fallback;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function numberWord(value: number, capitalizeWord = false): string {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"] as const;
  const word = words[value] ?? String(value);
  return capitalizeWord ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

/*
 * The assistant's own voice: plain, dry, no flourish. Same facts
 * and the same variant counts as the older voice
 * set above, so basicSpeechVariationCount holds for both styles.
 */
function ownVoiceLead(plan: BasicSpeechRenderPlan, variationIndex?: number): string {
  switch (plan.kind) {
    case "current_time":
      return selectVariant([
        `It's ${plan.naturalClockText}.`,
        `It's ${plan.naturalClockText} now.`,
        `Right now it's ${plan.naturalClockText}.`,
        `The clock says ${plan.naturalClockText}.`,
        `It's ${plan.naturalClockText}, by my clock.`,
        `It's ${plan.naturalClockText} at the moment.`,
      ], variationIndex, `It is ${plan.clockText}.`);
    case "current_day":
      return selectVariant([
        `It's ${plan.day}.`,
        `Today's ${plan.day}.`,
        `It's ${plan.day} today.`,
        `We're on ${plan.day}.`,
        `Today is ${plan.day}.`,
        `${plan.day}, today.`,
      ], variationIndex, `Today is ${plan.day}.`);
    case "current_date":
      return selectVariant([
        `It's ${plan.date}.`,
        `Today's ${plan.date}.`,
        `Today is ${plan.date}.`,
        `It's ${plan.date} today.`,
        `We're up to ${plan.date}.`,
        `The date's ${plan.date}.`,
      ], variationIndex, `Today is ${plan.date}.`);
    case "entity_status_single":
      return ownDeclarativeSentence(entityStatusSentence(
        {
          label: plan.label,
          state: plan.state,
          ...(plan.unit ? { unit: plan.unit } : {}),
        },
        {
          compact: true,
          polarity: plan.polarity ?? null,
        },
      ), variationIndex);
    case "entity_status_group":
      return ownDeclarativeSentence(groupEntityStatusSentence(
        {
          label: plan.label,
          items: plan.items,
        },
        {
          compact: true,
          polarity: plan.polarity ?? null,
        },
      ), variationIndex);
    case "house_lights_none":
      return ownHouseLightsNoneSentence(variationIndex);
    case "house_lights_some":
      return ownHouseLightsSentence(plan.names, plan.remainder ?? false, variationIndex);
    case "metric_current":
      return ownMetricCurrentSentence(plan, variationIndex);
    case "metric_baseline":
      return ownBaselineSentence(plan, variationIndex);
    case "weather_now":
      return ownWeatherNowSentence(plan, variationIndex);
    case "calendar_empty":
      return selectVariant([
        `I don't see anything on the calendar ${plan.windowLabel}.`,
        `Nothing on the calendar ${plan.windowLabel}.`,
        `The calendar's clear ${plan.windowLabel}.`,
        `The calendar's empty ${plan.windowLabel}.`,
        `Nothing booked ${plan.windowLabel}.`,
        `Nothing in the diary ${plan.windowLabel}.`,
        `Clear calendar ${plan.windowLabel}.`,
        `There's nothing on the calendar ${plan.windowLabel}.`,
        `Nothing scheduled ${plan.windowLabel}.`,
        `The calendar's got nothing ${plan.windowLabel}.`,
      ], variationIndex, `I don't see anything on the calendar ${plan.windowLabel}.`);
    case "calendar_events":
      return ownCalendarEventsSentence(plan, variationIndex);
    case "calculation": {
      const lowerStatement = lowerInitial(plan.statement);
      return selectVariant([
        plan.statement,
        `By my maths, ${lowerStatement}`,
        `Right. ${plan.statement}`,
        `Quick sum: ${lowerStatement}`,
        `So, ${lowerStatement}`,
        `Worked it out: ${lowerStatement}`,
      ], variationIndex, plan.statement);
    }
    case "energy_budget":
      return ownEnergyBudgetSentence(plan, variationIndex);
    case "todo_items":
      return ownTodoItemsSentence(plan, variationIndex);
    case "alarm_set":
      return selectVariant([
        `Alarm set for ${plan.timeText}.`,
        `Done. Alarm's set for ${plan.timeText}.`,
        `Understood. Alarm set for ${plan.timeText}.`,
        `Alarm's on for ${plan.timeText}.`,
        `You're set for ${plan.timeText}.`,
        `Set. ${plan.timeText} it is.`,
      ], variationIndex, `Alarm set for ${plan.timeText}.`);
    case "alarm_stopped": {
      const verb = plan.action === "cancelled" ? "cancelled" : "stopped";
      const noun = plan.action === "cancelled" ? "scheduled alarm" : "alarm";
      return selectVariant([
        `The ${noun} is ${verb}.`,
        `${capitalize(verb)} the ${noun}.`,
        `Done, ${noun} ${verb}.`,
        `${capitalize(noun)}'s ${verb}.`,
        `Understood. The ${noun} is ${verb}.`,
        `That ${noun}'s ${verb}.`,
      ], variationIndex, `${capitalize(verb)} the ${noun}.`);
    }
    case "music_playback": {
      const track = `${plan.track}${plan.artist ? ` by ${plan.artist}` : ""}`;
      return selectVariant([
        `Playing ${track} on ${plan.endpoint}.`,
        `${track}, on ${plan.endpoint}.`,
        `On it. ${track} on ${plan.endpoint}.`,
        `Putting ${track} on ${plan.endpoint}.`,
        `Here's ${track}, on ${plan.endpoint}.`,
        `Understood. ${track} on ${plan.endpoint}.`,
      ], variationIndex, `Playing ${track} on ${plan.endpoint}.`);
    }
    case "house_summary": {
      const facts = plan.parts.join(" ");
      const scope = plan.scope === "tonight" ? "tonight" : "today";
      return selectVariant([
        facts,
        `Quick rundown: ${facts}`,
        `Here's the house ${scope}: ${facts}`,
        `Short version: ${facts}`,
        `${capitalize(scope)}: ${facts}`,
        `Where things are at: ${facts}`,
      ], variationIndex, facts);
    }
    case "event_log":
      return ownEventLogSentence(plan, variationIndex);
    case "catchup":
      return [plan.lead, ...plan.entries, plan.closing].filter((part): part is string => Boolean(part)).join(" ");
    case "check_in":
      return checkInSentence(plan.speakerName, variationIndex);
  }
}

function ownDeclarativeSentence(sentence: string, variationIndex?: number): string {
  const polarity = /^(Yes|No)\.\s+(.+)$/.exec(sentence);
  if (polarity) {
    const answer = polarity[1] ?? "";
    const lowerFact = lowerInitial(polarity[2] ?? "");
    return selectVariant([
      sentence,
      `${answer}, ${lowerFact}`,
      `${answer}. Right now, ${lowerFact}`,
      `${answer}. At the moment, ${lowerFact}`,
      `${answer}. Just checked: ${lowerFact}`,
      `${answer}. As of now, ${lowerFact}`,
      `${answer}—${lowerFact}`,
      `${answer}. Currently, ${lowerFact}`,
    ], variationIndex, sentence);
  }
  const lowerSentence = lowerInitial(sentence);
  return selectVariant([
    sentence,
    `Right now, ${lowerSentence}`,
    `At the moment, ${lowerSentence}`,
    `Just checked: ${lowerSentence}`,
    `As of now, ${lowerSentence}`,
    `Currently, ${lowerSentence}`,
    `From what I can see, ${lowerSentence}`,
    `Last I looked, which was just now, ${lowerSentence}`,
  ], variationIndex, sentence);
}

function ownHouseLightsNoneSentence(variationIndex?: number): string {
  return selectVariant([
    "No lights are on.",
    "No. Every light's off.",
    "No, they're all off.",
    "No. Not a single light on.",
    "No. Everything's off.",
    "No. The lights are all off.",
    "No. None on anywhere.",
    "No. Every light in the house is off.",
    "No. All off, the whole house.",
    "No. It's lights out everywhere.",
  ], variationIndex, "No lights are on.");
}

function ownHouseLightsSentence(names: readonly string[], remainder: boolean, variationIndex?: number): string {
  if (names.length === 0) {
    return ownHouseLightsNoneSentence(variationIndex);
  }
  if (remainder) {
    if (names.length === 1) {
      const name = names[0];
      return selectVariant([
        `The other light is ${name}.`,
        `The other one's ${name}.`,
        `That leaves ${name}.`,
        `Just ${name}.`,
        `The last one's ${name}.`,
        `Then there's ${name}.`,
        `Only ${name} left.`,
        `${name} is the other one.`,
        `One more: ${name}.`,
        `And ${name}. That's the lot.`,
      ], variationIndex, `The other light is ${name}.`);
    }
    const joined = joinNatural(names);
    return selectVariant([
      `The other ${names.length} lights are ${joined}.`,
      `The other ${names.length} are ${joined}.`,
      `That leaves ${joined}.`,
      `The rest are ${joined}.`,
      `Then there's ${joined}.`,
      `Also on: ${joined}.`,
      `The rest: ${joined}.`,
      `${joined}. That's the lot.`,
      `${names.length} more: ${joined}.`,
      `The remaining ${names.length} are ${joined}.`,
    ], variationIndex, `The other ${names.length} lights are ${joined}.`);
  }
  if (names.length === 1) {
    const name = names[0];
    return selectVariant([
      `Yes. One light is on: ${name}.`,
      `Yes, just ${name}.`,
      `Yes. Only ${name}.`,
      `Yes. ${name} is on, nothing else.`,
      `Yes, one: ${name}.`,
      `Yes, just the one: ${name}.`,
      `Yes. ${name}'s on. Everything else is off.`,
      `Yes. Only ${name} is on.`,
      `Yes. ${name}, and that's it.`,
      `Yes. One on: ${name}.`,
    ], variationIndex, `Yes. One light is on: ${name}.`);
  }
  const shown = names.length <= 3 ? names : names.slice(0, 3);
  const joined = joinNatural(shown);
  const remaining = names.length - shown.length;
  if (remaining === 0) {
    return selectVariant([
      `Yes. ${names.length} lights are on: ${joined}.`,
      `Yes. ${joined}.`,
      `Yes. ${joined} are on.`,
      `Yes, ${names.length} of them: ${joined}.`,
      `Yes. ${joined}, that's all.`,
      `Yes. There's ${names.length} on: ${joined}.`,
      `Yes. Right now it's ${joined}.`,
      `Yes. ${names.length} on: ${joined}.`,
      `Yes, ${joined}. Nothing else.`,
      `Yes. On at the moment: ${joined}.`,
    ], variationIndex, `Yes. ${names.length} lights are on: ${joined}.`);
  }
  return selectVariant([
    `Yes. ${names.length} lights are on: ${joined}, and ${remaining} more.`,
    `Yes. ${joined}, plus ${remaining} more.`,
    `Yes, ${names.length} of them. ${joined}, and ${remaining} others.`,
    `Yes. ${names.length} on: ${joined}, and ${remaining} more after that.`,
    `Yes. A fair few: ${joined}, and ${remaining} more.`,
    `Yes. ${joined} are on, and ${remaining} others.`,
    `Yes. There's ${names.length} on. ${joined}, then ${remaining} more.`,
    `Yes. ${names.length} lights. ${joined}, and another ${remaining}.`,
    `Yes. Right now: ${joined}, and ${remaining} more.`,
    `Yes. ${joined}, with ${remaining} more on too.`,
  ], variationIndex, `Yes. ${names.length} lights are on: ${joined}, and ${remaining} more.`);
}

function ownMetricCurrentSentence(
  plan: Extract<BasicSpeechRenderPlan, { kind: "metric_current" }>,
  variationIndex?: number,
): string {
  const subject = naturalMetricSubject(plan.subject);
  const lowerSubject = lowerInitial(subject);
  const fact = plan.drawsPower
    ? `${subject} is drawing ${plan.measurement}.`
    : `${subject} is ${plan.measurement}.`;
  const predicate = plan.drawsPower
    ? `drawing ${plan.measurement}`
    : `at ${plan.measurement}`;
  return selectVariant([
    fact,
    plan.drawsPower
      ? `${subject}'s pulling ${plan.measurement}.`
      : `${subject}'s at ${plan.measurement}.`,
    `Right now ${lowerSubject} is ${predicate}.`,
    plan.drawsPower
      ? `${subject} is using ${plan.measurement}.`
      : `${subject} reads ${plan.measurement}.`,
    `${subject} is sitting at ${plan.measurement}.`,
    `At the moment, ${lowerSubject} is ${predicate}.`,
    `${subject}? ${capitalize(plan.measurement)}.`,
    `Just checked: ${lowerSubject} is ${predicate}.`,
  ], variationIndex, fact);
}

function ownBaselineSentence(
  plan: Extract<BasicSpeechRenderPlan, { kind: "metric_baseline" }>,
  variationIndex?: number,
): string {
  const comparison = plan.relation === "same"
    ? `That's about the usual same-time draw: ${plan.currentMeasurement} and about ${plan.averageMeasurement}.`
    : `That's ${plan.relation} than the usual same-time draw: ${plan.currentMeasurement} against about ${plan.averageMeasurement}.`;
  const answer = plan.polarity ? `${plan.polarity === "yes" ? "Yes" : "No"}. ` : "";
  const relation = plan.relation === "same" ? "about level with" : `${plan.relation} than`;
  const position = plan.relation === "same" ? "in line with" : plan.relation === "higher" ? "above" : "below";
  const relativeConclusion = plan.relation === "same" ? "about the usual level" : `${plan.relation} than usual`;
  return selectVariant([
    `${answer}${comparison}`,
    `${answer}It's ${relation} usual for this time: ${plan.currentMeasurement} against about ${plan.averageMeasurement}.`,
    `${answer}${capitalize(plan.currentMeasurement)} now, against about ${plan.averageMeasurement} normally. So it's ${relativeConclusion}.`,
    `${answer}Usual for this time is about ${plan.averageMeasurement}. It's ${plan.currentMeasurement} now, so it's ${relativeConclusion}.`,
    `${answer}Right now it's ${plan.currentMeasurement}. This time of day it's normally about ${plan.averageMeasurement}.`,
    `${answer}${capitalize(plan.currentMeasurement)} at the moment. Normal for now is about ${plan.averageMeasurement}, so it's ${position} that.`,
    `${answer}It's ${plan.currentMeasurement}, ${position} the usual ${plan.averageMeasurement} or so.`,
    `${answer}Compared with the usual ${plan.averageMeasurement} or so, ${plan.currentMeasurement} is ${relativeConclusion}.`,
  ], variationIndex, `${answer}${comparison}`);
}

function ownWeatherNowSentence(
  plan: Extract<BasicSpeechRenderPlan, { kind: "weather_now" }>,
  variationIndex?: number,
): string {
  const tempText = plan.temperatureText ? `, about ${plan.temperatureText}` : "";
  const feelsLikeText = plan.feelsLikeText ? `, but it feels like ${plan.feelsLikeText}` : "";
  const windyText = plan.windy && !/\bwind(?:y|ier|iest)?\b/i.test(plan.summary) ? ", and windy" : "";
  const detail = `${tempText}${feelsLikeText}${windyText}`;
  const rainText = plan.rainLikely ? " Rain's likely." : "";
  const exactWeather = `It's ${plan.summary} in ${plan.location}${detail}.${rainText}`;
  return selectVariant([
    exactWeather,
    `In ${plan.location} it's ${plan.summary}${detail}.${rainText}`,
    `${plan.location}'s ${plan.summary} right now${detail}.${rainText}`,
    `It's ${plan.summary} out in ${plan.location}${detail}.${rainText}`,
    `Right now in ${plan.location}: ${plan.summary}${detail}.${rainText}`,
    `${plan.location} is ${plan.summary} at the moment${detail}.${rainText}`,
    `Out there in ${plan.location} it's ${plan.summary}${detail}.${rainText}`,
    `Weather in ${plan.location}? ${capitalize(plan.summary)}${detail}.${rainText}`,
  ], variationIndex, exactWeather);
}

function ownCalendarEventsSentence(
  plan: Extract<BasicSpeechRenderPlan, { kind: "calendar_events" }>,
  variationIndex?: number,
): string {
  const joined = joinNatural(plan.items);
  const more = plan.remainingCount > 0 ? `, and ${plan.remainingCount} more` : "";
  const noun = plan.count === 1 ? "event" : "events";
  const count = numberWord(plan.count);
  return selectVariant([
    `I found ${count} calendar ${noun} ${plan.windowLabel}: ${joined}${more}.`,
    `${numberWord(plan.count, true)} on the calendar ${plan.windowLabel}: ${joined}${more}.`,
    `There's ${count} ${noun} ${plan.windowLabel}: ${joined}${more}.`,
    `I can see ${joined}${more} on the calendar ${plan.windowLabel}.`,
    `On the calendar ${plan.windowLabel}: ${joined}${more}.`,
    `The calendar says ${joined}${more} ${plan.windowLabel}.`,
    `The calendar has ${joined}${more} ${plan.windowLabel}.`,
    `${numberWord(plan.count, true)} ${noun} ${plan.windowLabel}. ${capitalize(joined)}${more}.`,
    `In the diary ${plan.windowLabel}: ${joined}${more}.`,
    `Looks like ${joined}${more} ${plan.windowLabel}.`,
  ], variationIndex, `I found ${count} calendar ${noun} ${plan.windowLabel}: ${joined}${more}.`);
}

function ownEnergyBudgetSentence(
  plan: Extract<BasicSpeechRenderPlan, { kind: "energy_budget" }>,
  variationIndex?: number,
): string {
  const polarity = /^(Yes|No)\.\s+(.+)$/.exec(plan.statement);
  const prefix = polarity ? `${polarity[1]}. ` : "";
  const lowerStatement = lowerInitial(polarity?.[2] ?? plan.statement);
  return selectVariant([
    plan.statement,
    `${prefix}Short version: ${lowerStatement}`,
    `${prefix}Right now, ${lowerStatement}`,
    `${prefix}Here's where it's at: ${lowerStatement}`,
    `${prefix}Going by the numbers, ${lowerStatement}`,
    `${prefix}Basically, ${lowerStatement}`,
  ], variationIndex, plan.statement);
}

function ownTodoItemsSentence(
  plan: Extract<BasicSpeechRenderPlan, { kind: "todo_items" }>,
  variationIndex?: number,
): string {
  const single = Boolean(plan.listName);
  const listReference = plan.listName ? `the ${plan.listName}` : "the to-do lists";
  const listSubject = capitalize(listReference);
  const is = single ? "is" : "are";
  const has = single ? "has" : "have";
  if (plan.totalCount === 0) {
    const subject = plan.listName ?? "The to-do lists";
    return selectVariant([
      `${subject} ${is} empty.`,
      `Nothing on ${listReference}.`,
      `${listSubject} ${is} clear.`,
      `All clear on ${listReference}.`,
      `Nothing left on ${listReference}.`,
      `There's nothing on ${listReference}.`,
      `${listSubject}? Empty.`,
      `Not a thing on ${listReference}. It's empty.`,
      `${listSubject} ${is} empty right now.`,
      `No open items on ${listReference}.`,
    ], variationIndex, `${subject} ${is} empty.`);
  }
  const shown = joinNatural(plan.items);
  const more = plan.remainingCount > 0 ? `, and ${plan.remainingCount} more` : "";
  const subject = plan.listName ?? "The open to-do lists";
  const noun = plan.totalCount === 1 ? "item" : "items";
  return selectVariant([
    `${subject} ${plan.grouped ? "show" : "has"} ${numberWord(plan.totalCount)} ${noun}: ${shown}${more}.`,
    `${numberWord(plan.totalCount, true)} on ${listReference}: ${shown}${more}.`,
    `On ${listReference}: ${shown}${more}.`,
    `${listSubject} ${has} ${shown}${more}.`,
    `There's ${numberWord(plan.totalCount)} ${noun} on ${listReference}: ${shown}${more}.`,
    `Still on ${listReference}: ${shown}${more}.`,
    `${capitalize(shown)}${more}. That's ${listReference}.`,
    `${listSubject}? ${capitalize(shown)}${more}.`,
    `Right now ${listReference} ${has} ${shown}${more}.`,
    `${numberWord(plan.totalCount, true)} ${noun}: ${shown}${more}.`,
  ], variationIndex, `${subject} has ${numberWord(plan.totalCount)} ${noun}: ${shown}${more}.`);
}

function ownEventLogSentence(
  plan: Extract<BasicSpeechRenderPlan, { kind: "event_log" }>,
  variationIndex?: number,
): string {
  if (plan.quiet) {
    const period = plan.scope === "while_i_was_out" ? " while you were out" : "";
    return selectVariant([
      `${plan.lead} nothing notable appears in the watched house log.`,
      `${plan.lead} nothing worth mentioning in what I watch.`,
      `${plan.lead} the house log's quiet.`,
      `${plan.lead} nothing of note in the house log.`,
      `${plan.lead} a quiet one${period}, as far as the house log goes.`,
      `${plan.lead} not a lot to report from the house log.`,
    ], variationIndex, `${plan.lead} nothing notable appears in the watched house log.`);
  }
  const entries = plan.entries.join(" ");
  return selectVariant([
    `${plan.lead} ${entries}`,
    `${plan.lead} here's what happened. ${entries}`,
    `${plan.lead} this is what the house log has. ${entries}`,
    `${plan.lead} what I noticed. ${entries}`,
    `${plan.lead} the short version. ${entries}`,
    `${plan.lead} from the house log. ${entries}`,
  ], variationIndex, `${plan.lead} ${entries}`);
}
