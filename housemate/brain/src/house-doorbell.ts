import type { HaHistoryQuery, HaHistoryResult } from "./ha-history.js";
import type { HaEntityState } from "./ha-state-cache.js";
import { FOLLOW_UP_OPENER_PATTERN } from "./lexicon.js";
import { extractTimeWindowEnvelopeFromUtterance, extractTimeWindowFromUtterance, type TimeWindow } from "./time-window-parser.js";
import { spokenDay, spokenWhen } from "./zoned-time.js";
import { householdRegex } from "./household.js";

/*
 * Doorbell rings: "when did the doorbell last ring?", "did
 * anyone ring the doorbell today?", "was the doorbell pressed last week?"
 * are answered by code from the doorbell's HA `event` entity, read-only.
 * The entity's state is the time of its last ring, so every distinct state
 * in its history is one ring; a later row with the same state is HA
 * restoring it after a restart. A doorbell joins by domain and device class
 * alone (`event`, `doorbell`), never by name.
 */

/** `polar`: did it ring? Otherwise when, or how many times. */
export interface DoorbellAsk {
  readonly polar: boolean;
}

const DOORBELL = /\bdoor ?bells?\b/;
const RING_VERB = /\b(?:ring|rings|rang|rung|press|pressed|push|pushed|buzz|buzzed|go off|went off|gone off)\b/;
const PAST = /\b(?:did|was|were|has|have|had|rang|rung|pressed|pushed|buzzed|went off|gone off|last)\b/;
const ASK_LEAD = /^(?:(?:do you know|can you tell me|could you tell me|tell me) )?(?:when|what time|did|was|were|has|have|how many|how often|(?:the )?last time|(?:has |did )?(?:anyone|anybody|someone|somebody))\b/;
const POLAR_LEAD = /^(?:(?:do you know|can you tell me|could you tell me|tell me) )?(?:(?:if|whether) )?(?:did|was|were|has|have|(?:anyone|anybody|someone|somebody))\b/;

/** A question about when, whether or how often the doorbell rang, else null. */
export function parseDoorbellAsk(normalized: string): DoorbellAsk | null {
  const text = normalized.trim().replace(householdRegex(String.raw`^(?:(?:so|okay|ok|hey|{ASSISTANT}|and|right) )+`), "");
  if (!DOORBELL.test(text) || !RING_VERB.test(text) || !PAST.test(text) || !ASK_LEAD.test(text)) {
    return null;
  }
  return { polar: POLAR_LEAD.test(text) };
}

const FOLLOW_UP_OPENER = new RegExp(`^(?:${FOLLOW_UP_OPENER_PATTERN}\\s*)*`);

/**
 * "And yesterday?" right after a doorbell question: the same question for
 * that time. `earlier` is this conversation's previous turns' words, newest
 * first; a chain of bare times ("and last week?") leads back to it.
 */
export function doorbellTimeFollowUp(normalized: string, earlier: readonly string[], now: Date, timezone: string): DoorbellAsk | null {
  if (!bareTime(normalized, now, timezone)) return null;
  for (const previous of earlier.slice(0, 3)) {
    const ask = parseDoorbellAsk(previous);
    if (ask) return ask;
    if (!bareTime(previous, now, timezone)) return null;
  }
  return null;
}

/** Nothing but a time, after "and" / "what about". */
function bareTime(text: string, now: Date, timezone: string): boolean {
  const envelope = extractTimeWindowEnvelopeFromUtterance(text, { now, timezone });
  return envelope.result.status === "matched" && (envelope.residualInput ?? "").trim().replace(FOLLOW_UP_OPENER, "").trim() === "";
}

/** Live doorbell press entities. */
export function doorbellSources(states: readonly HaEntityState[]): HaEntityState[] {
  return states.filter((state) => state.entityId.startsWith("event.") && state.attributes.device_class === "doorbell");
}

export interface DoorbellAnswer {
  readonly status: "ok" | "declined";
  readonly text: string;
  readonly notes: string;
}

export async function doorbellAnswer(options: {
  readonly ask: DoorbellAsk;
  readonly normalized: string;
  readonly sources: readonly HaEntityState[];
  readonly fetchHistory: ((query: HaHistoryQuery) => Promise<HaHistoryResult>) | null;
  readonly now: Date;
  readonly timezone: string;
}): Promise<DoorbellAnswer> {
  const { now, timezone } = options;
  if (options.sources.length === 0) {
    return { status: "declined", text: "I can't see a doorbell.", notes: "doorbell: no event entity with device class doorbell" };
  }
  const entityIds = options.sources.map((state) => state.entityId);
  const extracted = extractTimeWindowFromUtterance(options.normalized, { now, timezone });
  if (extracted.status === "ambiguous") {
    return { status: "declined", text: "Which day do you mean? Try last Friday or yesterday.", notes: `doorbell: ambiguous time window (${extracted.reason ?? "no reason"})` };
  }
  const window = extracted.status === "matched" && extracted.window && Date.parse(extracted.window.start) <= now.getTime()
    ? extracted.window
    : null;

  if (!window) {
    const last = Math.max(...options.sources.map((state) => ringTime(state.state) ?? Number.NEGATIVE_INFINITY));
    if (!Number.isFinite(last)) {
      return { status: "declined", text: "I can't see when the doorbell last rang.", notes: `doorbell last ring: no readable ring time (${entityIds.join(", ")})` };
    }
    return {
      status: "ok",
      text: `The doorbell last rang ${spokenWhen(last, now, timezone)}.`,
      notes: `doorbell last ring from live state of ${entityIds.join(", ")}`,
    };
  }

  if (!options.fetchHistory) {
    return { status: "declined", text: "I can't read the doorbell's history just now.", notes: "doorbell window: no history source" };
  }
  let history: HaHistoryResult;
  try {
    history = await options.fetchHistory({ entityIds, window, includeStartTimeState: true, noAttributes: true });
  } catch {
    return { status: "declined", text: "I can't read the doorbell's history just now.", notes: "doorbell window: history read failed" };
  }
  const startMs = Date.parse(window.start);
  const endMs = Math.min(Date.parse(window.end), now.getTime());
  const rings = [...new Set([...history.states.map((row) => row.state), ...options.sources.map((state) => state.state)]
    .map(ringTime)
    .filter((at): at is number => at !== null && at >= startMs && at < endMs))]
    .sort((left, right) => left - right);
  // With history at the window's start HA reports the state at that instant,
  // stamped with the start; otherwise the recorder has purged that far back.
  const earliest = Math.min(...history.states.map((row) => Date.parse(row.lastChanged)).filter(Number.isFinite));
  const covered = Number.isFinite(earliest) && earliest <= startMs + 1000;
  const reach = Number.isFinite(earliest) ? ` My doorbell history only goes back to ${spokenDay(earliest, timezone)}.` : "";
  const notes = `doorbell rings ${window.label}: ${rings.length} from history of ${entityIds.join(", ")}${covered ? "" : " (window starts before the recorder's history)"}`;
  const label = windowLabel(window);

  if (rings.length === 0) {
    return covered
      ? { status: "ok", text: `${options.ask.polar ? "No, the" : "The"} doorbell didn't ring ${label}.`, notes }
      : { status: "ok", text: `Not that I can see.${reach || " I can't see that far back."}`, notes };
  }
  const last = rings[rings.length - 1] as number;
  const count = rings.length === 1 ? "once" : rings.length === 2 ? "twice" : `${rings.length} times`;
  // "rang once yesterday, at 8:53 pm", not "yesterday, yesterday at".
  const when = spokenWhen(last, now, timezone).replace(new RegExp(`^${label} `), "");
  const lastPart = rings.length === 1 ? when : `last ${when}`;
  return {
    status: "ok",
    text: `${options.ask.polar ? "Yes, the" : "The"} doorbell rang ${count} ${label}, ${lastPart}.${covered ? "" : reach}`,
    notes,
  };
}

function ringTime(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function windowLabel(window: TimeWindow): string {
  return /^(?:today|tonight|yesterday|this |last |past |earlier)/.test(window.label) ? window.label : `in ${window.label}`;
}
