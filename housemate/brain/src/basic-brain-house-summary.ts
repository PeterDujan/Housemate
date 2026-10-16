import type { PassiveEventWatcherService, PassiveWatcherEvent } from "./event-watchers.js";
import type { HaCalendarEvent, HaCalendarFetcher } from "./ha-calendar.js";
import type { HaEntityState, HaStateCache } from "./ha-state-cache.js";
import type { HouseStateProvider, HouseStateSnapshot } from "./house-state.js";
import { parseTimeWindow } from "./time-window-parser.js";
import type { HouseSummaryScope } from "./basic-brain-contracts.js";
import { formatNumber, joinNatural } from "./text-format.js";
import { friendlyName } from "./ha-state-cache.js";
import { HOUSE_LOCALE, HOUSE_TIME_ZONE, houseConfig } from "./house-config.js";

export type { HouseSummaryScope } from "./basic-brain-contracts.js";

export interface HouseSummaryAnswer {
  readonly text: string;
  readonly parts: readonly string[];
  readonly notes: string;
  readonly scope: HouseSummaryScope;
  readonly sourceEntityIds: readonly string[];
  readonly sourceSummary: string;
}

const DEFAULT_TIMEZONE = HOUSE_TIME_ZONE;
const HOUSE_SUMMARY_PATTERNS: readonly RegExp[] = [
  /^house summary\b/,
  /^(?:summari[sz]e|summary of)\s+(?:the\s+)?house(?:\s+(?:today|tonight))?$/,
  /^anything(?:\s+i)?\s+(?:need|ought)?\s*to know(?:\s+(?:today|tonight))?$/,
  /^what do i\s+(?:need|ought)?\s*to know(?:\s+(?:today|tonight))?$/,
  /^what should i\s+know(?:\s+(?:today|tonight))?$/,
  /^what(?:'s| is)\s+going on(?:\s+at home)?(?:\s+(?:today|tonight))?$/,
  /^how(?:'s| is)\s+(?:the\s+)?house\s+looking(?:\s+(?:today|tonight))?$/,
  /^(?:give me|what(?:'s| is))\s+(?:the\s+)?(?:house\s+)?rundown(?:\s+for)?(?:\s+(?:today|tonight))?$/,
];

export function looksLikeHouseSummaryQuestion(normalized: string): boolean {
  if (!normalized) {
    return false;
  }
  return HOUSE_SUMMARY_PATTERNS.some((pattern) => pattern.test(normalized));
}

export async function buildHouseSummaryAnswer(options: {
  readonly stateCache: HaStateCache | undefined;
  readonly houseState: HouseStateProvider | undefined;
  readonly calendarFetcher: HaCalendarFetcher | undefined;
  readonly eventWatcher: PassiveEventWatcherService | undefined;
  readonly now: Date;
  readonly normalized: string;
  readonly guestMode: boolean;
}): Promise<HouseSummaryAnswer | null> {
  const snapshot = options.houseState?.snapshot(options.now) ?? null;
  const timezone = snapshot?.timezone ?? DEFAULT_TIMEZONE;
  const scope: HouseSummaryScope = /\btonight\b/.test(options.normalized) ? "tonight" : "today";
  const sourceEntityIds = new Set<string>();
  const sourceSummaryParts = new Set<string>();
  const parts: string[] = [];

  const houseLead = houseLeadSentence(snapshot, options.guestMode);
  if (houseLead) {
    parts.push(houseLead);
    sourceSummaryParts.add("live house state");
    if (!options.guestMode) {
      for (const personId of snapshot?.presence.presentPersonIds ?? []) {
        sourceEntityIds.add(personId);
      }
    }
  }

  const weatherEntityId = snapshot?.sources.weather.currentEntityId ?? currentWeatherEntityId(options.stateCache?.entries() ?? []);
  const weatherState = weatherEntityId ? options.stateCache?.get(weatherEntityId) ?? null : null;
  const weatherSentence = weatherSummarySentence(weatherState, scope);
  if (weatherSentence && weatherEntityId) {
    parts.push(weatherSentence);
    sourceEntityIds.add(weatherEntityId);
    sourceSummaryParts.add("current weather state");
  }

  const calendarSentence = options.guestMode
    ? null
    : await calendarSummarySentence({
        stateCache: options.stateCache,
        calendarFetcher: options.calendarFetcher,
        now: options.now,
        timezone,
        scope,
      });
  if (calendarSentence) {
    parts.push(calendarSentence.text);
    for (const entityId of calendarSentence.entityIds) {
      sourceEntityIds.add(entityId);
    }
    sourceSummaryParts.add("Home Assistant calendar events");
  }

  const recentEvent = recentSummaryEvent(options.eventWatcher, options.now, options.guestMode);
  if (recentEvent) {
    parts.push(renderRecentEvent(recentEvent));
    const entityId = eventSourceEntityId(recentEvent);
    if (entityId) {
      sourceEntityIds.add(entityId);
    }
    sourceSummaryParts.add("recent passive watcher events");
  }

  if (parts.length === 0) {
    return null;
  }

  return {
    text: parts.join(" "),
    parts,
    notes: `house summary for ${scope}`,
    scope,
    sourceEntityIds: [...sourceEntityIds].sort(),
    sourceSummary: [...sourceSummaryParts].join(", "),
  };
}

function houseLeadSentence(snapshot: HouseStateSnapshot | null, guestMode: boolean): string | null {
  if (!snapshot) {
    return null;
  }
  const timeLead = snapshot.activity.bedtimeActive
    ? "It's bedtime."
    : snapshot.activity.quietHoursActive
      ? "It's quiet hours."
      : snapshot.activity.localHour >= 17
        ? "The day is winding down."
        : null;
  const occupancyLead = occupancySentence(snapshot, guestMode);
  if (timeLead && occupancyLead) {
    return `${timeLead} ${occupancyLead}`;
  }
  return timeLead ?? occupancyLead;
}

function occupancySentence(snapshot: HouseStateSnapshot, guestMode: boolean): string | null {
  switch (snapshot.presence.occupancy) {
    case "occupied": {
      if (guestMode) {
        return "The house looks occupied.";
      }
      const names = snapshot.presence.people
        .filter((person) => person.presence === "home" || person.presence === "zone")
        .map((person) => person.name);
      if (names.length === 1) {
        return `${names[0]} is home.`;
      }
      if (names.length > 1 && names.length <= 3) {
        return `${joinNatural(names)} are home.`;
      }
      return "The house looks occupied.";
    }
    case "empty":
      return guestMode ? "The house looks empty." : "No one looks home right now.";
    default:
      return null;
  }
}

function weatherSummarySentence(state: HaEntityState | null, scope: HouseSummaryScope): string | null {
  if (!state) {
    return null;
  }
  const location = friendlyName(state).replace(/\s+hourly$/i, "").trim();
  const condition = humanWeatherCondition(state.state);
  const temperature = numericAttribute(state, "temperature");
  const tempUnit = stringAttribute(state, "temperature_unit") ?? "°C";
  const tempText = temperature !== null ? `, about ${formatNumber(temperature)} ${tempUnit}` : "";
  if (scope === "tonight") {
    return `Tonight looks ${condition} in ${location}${tempText}.`;
  }
  return `Weather now is ${condition} in ${location}${tempText}.`;
}

async function calendarSummarySentence(options: {
  readonly stateCache: HaStateCache | undefined;
  readonly calendarFetcher: HaCalendarFetcher | undefined;
  readonly now: Date;
  readonly timezone: string;
  readonly scope: HouseSummaryScope;
}): Promise<{ readonly text: string; readonly entityIds: readonly string[] } | null> {
  if (!options.stateCache || !options.calendarFetcher) {
    return null;
  }
  const calendarStates = options.stateCache.entries().filter((state) => state.entityId.startsWith("calendar."));
  if (calendarStates.length === 0) {
    return null;
  }
  const fallbackToday = parseTimeWindow("today", { now: options.now, timezone: options.timezone });
  const queryWindow = fallbackToday.status === "matched" ? fallbackToday.window : null;
  if (!queryWindow) {
    return null;
  }
  const events = await options.calendarFetcher.fetchEvents({
    entityIds: calendarStates.map((state) => state.entityId),
    start: queryWindow.start,
    end: queryWindow.end,
    calendarNames: Object.fromEntries(calendarStates.map((state) => [state.entityId, friendlyName(state)])),
  });
  const relevant = events
    .filter((event) => eventOverlapsOrFollows(event, options.now))
    .filter((event) => options.scope === "tonight" ? eventTouchesTonight(event, options.timezone) : true)
    .slice(0, 2);
  if (relevant.length === 0) {
    return null;
  }
  const first = relevant[0] as HaCalendarEvent;
  if (eventInProgress(first, options.now)) {
    return {
      text: `Happening now: ${first.summary} until ${formatLocalTime(first.end, options.timezone)}.`,
      entityIds: [first.entityId],
    };
  }
  if (relevant.length === 1) {
    return {
      text: options.scope === "tonight"
        ? `Next up tonight: ${first.summary} at ${formatLocalTime(first.start, options.timezone)}.`
        : `Next up today: ${first.summary} at ${formatLocalTime(first.start, options.timezone)}.`,
      entityIds: [first.entityId],
    };
  }
  const second = relevant[1] as HaCalendarEvent;
  return {
    text: options.scope === "tonight"
      ? `Tonight still has ${first.summary} at ${formatLocalTime(first.start, options.timezone)}, then ${second.summary} at ${formatLocalTime(second.start, options.timezone)}.`
      : `Today still has ${first.summary} at ${formatLocalTime(first.start, options.timezone)}, then ${second.summary} at ${formatLocalTime(second.start, options.timezone)}.`,
    entityIds: [...new Set([first.entityId, second.entityId])],
  };
}

function recentSummaryEvent(
  eventWatcher: PassiveEventWatcherService | undefined,
  now: Date,
  guestMode: boolean,
): PassiveWatcherEvent | null {
  const threeHoursMs = 3 * 60 * 60 * 1000;
  for (const event of eventWatcher?.recentEvents(6) ?? []) {
    const detectedAtMs = Date.parse(event.detectedAt);
    if (!Number.isFinite(detectedAtMs) || now.getTime() - detectedAtMs > threeHoursMs) {
      continue;
    }
    if (guestMode && (event.kind === "person_arrived" || event.kind === "person_departed")) {
      continue;
    }
    if (event.kind === "calendar_start") {
      continue;
    }
    return event;
  }
  return null;
}

function renderRecentEvent(event: PassiveWatcherEvent): string {
  switch (event.kind) {
    case "rain_start":
      return `Recent change: rain started around ${formatLocalTime(event.detectedAt, DEFAULT_TIMEZONE)}.`;
    case "person_arrived":
      return `Recent change: ${event.personName} arrived.`;
    case "person_departed":
      return `Recent change: ${event.personName} left.`;
    case "opening_opened":
      return `Recent change: ${event.label} opened.`;
    case "opening_closed":
      return `Recent change: ${event.label} closed.`;
    case "calendar_start":
      return `Recent change: ${event.eventSummary} started.`;
  }
}

function eventSourceEntityId(event: PassiveWatcherEvent): string | null {
  switch (event.kind) {
    case "rain_start":
    case "opening_opened":
    case "opening_closed":
      return event.entityId;
    case "person_arrived":
    case "person_departed":
      return event.personId;
    case "calendar_start":
      return event.calendarEntityId;
  }
}

function currentWeatherEntityId(states: readonly HaEntityState[]): string | null {
  const weatherStates = states.filter((state) => state.entityId.startsWith("weather."));
  return weatherStates.find((state) => state.entityId === houseConfig().weather.entity)?.entityId
    ?? weatherStates.find((state) => state.entityId === "weather.home")?.entityId
    ?? weatherStates[0]?.entityId
    ?? null;
}

function eventOverlapsOrFollows(event: HaCalendarEvent, now: Date): boolean {
  const startMs = Date.parse(event.start);
  const endMs = Date.parse(event.end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= now.getTime();
}

function eventInProgress(event: HaCalendarEvent, now: Date): boolean {
  const startMs = Date.parse(event.start);
  const endMs = Date.parse(event.end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && startMs <= now.getTime() && endMs > now.getTime();
}

function eventTouchesTonight(event: HaCalendarEvent, timezone: string): boolean {
  const startHour = localHour(event.start, timezone);
  const endHour = localHour(event.end, timezone);
  return startHour >= 18 || endHour >= 18;
}

function humanWeatherCondition(condition: string): string {
  const clean = condition.trim().toLowerCase().replace(/-/g, " ");
  if (!clean) {
    return "unclear";
  }
  if (clean === "clear night") {
    return "clear";
  }
  return clean;
}

function numericAttribute(state: HaEntityState, key: string): number | null {
  const value = state.attributes[key];
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringAttribute(state: HaEntityState, key: string): string | null {
  const value = state.attributes[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatLocalTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
}

function localHour(iso: string, timezone: string): number {
  const parts = new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date(iso));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  return Number.isFinite(hour) ? hour : 0;
}
