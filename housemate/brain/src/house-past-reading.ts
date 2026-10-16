import type { HaHistoryState } from "./ha-history.js";
import { extractTimeWindowEnvelopeFromUtterance, type TimeWindow } from "./time-window-parser.js";
import { capitalize } from "./text-format.js";
import { spokenWhen } from "./zoned-time.js";
import { householdRegex } from "./household.js";

/*
 * Past room readings: "how cold did the lounge room get
 * last night?", "what was the temperature inside yesterday?", "what was the
 * highest humidity in the lounge room this week?" are answered by code from
 * the sensor's HA history: the low, the high, or the range with the
 * time-weighted average. The place becomes the present-tense question ("what
 * is the temperature in the lounge room"), so the shared status parse and
 * resolver pick the same sensor "what's the temperature in X?" uses.
 */

export type PastReadingKind = "low" | "high" | "range";

export interface PastReadingAsk {
  readonly reading: "temperature" | "humidity";
  readonly kind: PastReadingKind;
  /** The present-tense status question that names the sensor. */
  readonly statusQuestion: string;
  /** The place as the reply says it: "the lounge room", "the house". */
  readonly place: string;
  readonly window: TimeWindow;
  /** The time as spoken: "last night". */
  readonly when: string;
}

/** Asked in the past tense but not answerable: one moment ("at 3am"), or a time still to come ("this morning" at 12:30 am). */
export interface PastReadingRefusal {
  readonly refusal: "moment" | "not_yet";
  /** The time as spoken. */
  readonly when: string;
}

const LOW = /\b(?:how (?:cold|cool|chilly)|cold(?:est)?|lowest|minimum|min)\b/;
const HIGH = /\b(?:how (?:hot|warm|humid)|hottest|warmest|highest|maximum|max|most humid)\b/;
const READING = /\b(?:temperature|temp|humidity|humid|cold|cool|chilly|hot|warm|coldest|hottest|warmest)\b/;
const PAST = /\b(?:was|were|did|got)\b/;
const MOMENT = /\bat (?:\d{1,2}(?: ?\d{2})?(?: ?(?:am|pm|o clock))?|midnight|noon|midday)\b/;
const INSIDE = /\b(?:inside|indoors|in the house)\b/;
/** "how cold did the lounge room get": the subject is the place. */
const HOW_SUBJECT = /^how (?:cold|cool|chilly|hot|warm|humid) (?:did|was|were) (.+?)(?: (?:get|got|be))?$/;
/** "what was the lounge room temperature": the place before the reading. */
const WHAT_NAMED = /^what (?:was|were) (the .+?|[a-z]+ s .+?) (?:temperature|temp|humidity)$/;
const KIND_WORDS = /\b(?:coldest|lowest|minimum|min|hottest|warmest|highest|maximum|max|most humid|average)\s+/g;

/** A past temperature or humidity question about a place, else null. Reads nothing. */
export function parsePastReading(normalized: string, now: Date, timezone: string): PastReadingAsk | PastReadingRefusal | null {
  const text = normalized.trim().replace(householdRegex(String.raw`^(?:(?:so|okay|ok|hey|{ASSISTANT}|and) )+`), "");
  if (!READING.test(text) || !PAST.test(text) || !/^(?:what|how)\b/.test(text)) return null;
  const humidity = /\bhumid(?:ity)?\b/.test(text);
  if (!humidity && !/\b(?:temperature|temp|coldest|hottest|warmest)\b/.test(text) && !/^how (?:cold|cool|chilly|hot|warm)\b/.test(text)) return null;
  const reading = humidity ? "humidity" : "temperature";
  const kind: PastReadingKind = LOW.test(text) ? "low" : HIGH.test(text) ? "high" : "range";

  const envelope = extractTimeWindowEnvelopeFromUtterance(text, { now, timezone });
  const window = envelope.result.status === "matched" ? envelope.result.window : null;
  const residual = envelope.residualInput?.trim() ?? "";
  if (!window || !envelope.temporalInput || !residual) {
    return MOMENT.test(text) && placeOf(text.replace(MOMENT, "").trim()) ? { refusal: "moment", when: MOMENT.exec(text)?.[0] ?? "" } : null;
  }
  const place = placeOf(residual);
  if (!place) return null;
  if (MOMENT.test(residual)) return { refusal: "moment", when: MOMENT.exec(residual)?.[0] ?? "" };
  if (Date.parse(window.start) >= now.getTime()) return { refusal: "not_yet", when: envelope.temporalInput };
  return {
    reading,
    kind,
    statusQuestion: place.inside ? `what is the ${reading} inside` : `what is the ${reading} in ${place.name}`,
    place: place.inside ? "the house" : place.name,
    window,
    when: envelope.temporalInput,
  };
}

/** Where the reading was taken; null when no place is named ("how cold did it get" may be outside). */
function placeOf(residual: string): { readonly name: string; readonly inside: boolean } | null {
  if (INSIDE.test(residual)) return { name: "the house", inside: true };
  const named = WHAT_NAMED.exec(residual.replace(KIND_WORDS, ""));
  const spoken = /\b(?:in|at) ((?:the )?[a-z][a-z ]*?)(?: (?:get|got|be))?$/.exec(residual)?.[1]
    ?? named?.[1]
    ?? HOW_SUBJECT.exec(residual)?.[1];
  if (!spoken || /^(?:it|there|here|outside|out)$/.test(spoken)) return null;
  if (/^the (?:house|home)$/.test(spoken)) return { name: "the house", inside: true };
  return { name: /^the /.test(spoken) || /^[a-z]+ s /.test(spoken) ? spoken : `the ${spoken}`, inside: false };
}

export interface PastReadingAnswer {
  readonly status: "ok" | "declined";
  readonly text: string;
  readonly notes: string;
}

/** The answer from one sensor's history over the window (cut at now). */
export function pastReadingAnswer(options: {
  readonly ask: PastReadingAsk;
  readonly entityId: string;
  readonly unit: string | null;
  readonly history: readonly HaHistoryState[];
  readonly now: Date;
  readonly timezone: string;
}): PastReadingAnswer {
  const { ask, now, timezone } = options;
  const startMs = Date.parse(ask.window.start);
  const endMs = Math.min(Date.parse(ask.window.end), now.getTime());
  // Every row in time order; "unavailable" (NaN) ends the reading before it but is no reading itself.
  const rows = options.history
    .map((row) => ({ at: Math.max(Date.parse(row.lastChanged), startMs), value: Number(row.state) }))
    .filter((row) => Number.isFinite(row.at) && row.at < endMs)
    .sort((left, right) => left.at - right.at);
  const samples = rows
    .map((row, index) => ({ ...row, until: rows[index + 1]?.at ?? endMs }))
    .filter((sample) => Number.isFinite(sample.value));
  const notes = `past ${ask.reading} ${ask.kind} ${ask.when} (${ask.window.start}..${ask.window.end}) from history of ${options.entityId}: ${samples.length} readings`;
  const When = capitalize(ask.when);
  const first = samples[0];
  if (!first) {
    return { status: "declined", text: `I don't have any ${ask.reading} readings from ${ask.place} for ${ask.when}.`, notes };
  }
  // With history at the window's start HA reports the state at that instant, stamped with the start.
  const reach = first.at > startMs + 1000 ? ` Its readings only start ${spokenWhen(first.at, now, timezone)}.` : "";
  const unit = (value: number) => (options.unit === "%" ? `${spoken(value)} per cent` : `${spoken(value)} degrees`);
  const values = samples.map((sample) => sample.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (low === high) return { status: "ok", text: `${When}, ${ask.place} stayed at ${unit(low)}.${reach}`, notes };
  if (ask.kind !== "range") {
    const pick = samples.reduce((best, sample) => (ask.kind === "low" ? sample.value < best.value : sample.value > best.value) ? sample : best);
    const verb = ask.kind === "low" ? "got down to" : "got up to";
    // "Yesterday,... At 4 am", not "yesterday at 4 am" twice.
    const at = spokenWhen(pick.at, now, timezone).replace(new RegExp(`^${ask.when} `), "");
    return { status: "ok", text: `${When}, ${ask.place} ${verb} ${unit(pick.value)}, ${at}.${reach}`, notes };
  }
  // Time-weighted: each reading counts for as long as it held.
  const held = samples.reduce((sum, sample) => sum + sample.until - sample.at, 0);
  const average = samples.reduce((sum, sample) => sum + sample.value * (sample.until - sample.at), 0) / held;
  return { status: "ok", text: `${When}, ${ask.place} was between ${spoken(low)} and ${unit(high)}, ${spoken(average)} on average.${reach}`, notes };
}

/** One decimal at most: 17.8, 18. */
function spoken(value: number): string {
  return String(Math.round(value * 10) / 10);
}
