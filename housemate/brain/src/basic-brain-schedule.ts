import { memoryPlainText, subjectMatchesSpeaker } from "./memory-recall.js";
import { cognitiveFeatureEnabled } from "./cognitive-control.js";
import type { BasicSpeechRenderPlan } from "./basic-speech-response.js";
import { type PendingClarifierFrame, type PendingClarifierChoice } from "./basic-brain-clarifiers.js";
import { looksLikePersonalMemoryQuestion } from "./basic-brain-memory.js";
import { type MemoryRecord } from "./memory-schema.js";
import { MemoryStore, memoryStorePath } from "./memory-store.js";
import { isPersonalCalendarText, WASTE_CALENDAR_PATTERN, type HaCalendarEvent, type HaCalendarFetcher } from "./ha-calendar.js";
import { friendlyName, type HaEntityState, type HaStateCache } from "./ha-state-cache.js";
import { type HaTodoFetcher, type HaTodoItem } from "./ha-todo.js";
import {
  upcomingHousePatternCommitments,
  type UpcomingHousePatternCommitment,
} from "./house-pattern-catalog.js";
import { normalizeRoutingText as normalize } from "./routing-text.js";
import { trustedSpeakerPersonId } from "./speaker-principal.js";
import { parseTimeWindow, type TimeWindow } from "./time-window-parser.js";
import { parseTodoQueryIntent } from "./todo-query-intent.js";
import { type VoiceBrainRequest } from "./voice-brain.js";
import { joinNatural } from "./text-format.js";
import { declined, ok, withheld } from "./basic-brain-contracts.js";
import { hourInTimezone, localDateOffset, localWeekday } from "./zoned-time.js";
import {
  CALENDAR_DAY_PATTERN,
  CALENDAR_DAY_WORD,
  WEEKDAY_NAMES,
  WEEKDAY_PATTERN,
} from "./lexicon.js";
import { householdNameTokens, householdPersonById } from "./household.js";
import { HOUSE_LOCALE, HOUSE_TIME_ZONE } from "./house-config.js";

export interface ScheduleConfig {
  readonly dataDir: string;
  readonly cognitiveSystemEnabled?: boolean;
  readonly cognitiveRecallEnabled?: boolean;
}

export interface ScheduleRouteServices {
  readonly stateCache?: HaStateCache;
  readonly calendarFetcher?: HaCalendarFetcher;
  readonly todoFetcher?: HaTodoFetcher;
}

interface ScheduleContextFrame {
  readonly kind: "calendar";
  readonly entityIds: readonly string[];
  readonly window: TimeWindow;
}

export interface ScheduleRouteResult {
  readonly route: "memory_query" | "calendar_query";
  readonly status: "ok" | "declined" | "clarify";
  readonly confidence: "high" | "low";
  readonly text: string;
  readonly modelUsed: false;
  readonly resultId: null;
  readonly touchedEntities: readonly string[];
  readonly notes: string;
  readonly contextFrame?: ScheduleContextFrame | PendingClarifierFrame | null;
  readonly speechPlan?: BasicSpeechRenderPlan | null;
}

const DEFAULT_TIMEZONE = HOUSE_TIME_ZONE;

export function looksLikeCalendarQuestion(normalized: string): boolean {
  return /\b(calendar|appointment|appointments|event|events|diary)\b/.test(normalized)
    || /\b(?:movie|movies|film|films|radarr)\b.*\b(?:release|releases|coming out|out this|out next)\b/.test(normalized)
    || new RegExp(String.raw`\breleases?\b.*\b${CALENDAR_DAY_PATTERN}\b`).test(normalized)
    || new RegExp(String.raw`\b(?:bin|bins|rubbish|trash|waste|recycling|green waste|greens)\b.*\b(?:night|due|collection|pickup|pick up|today|tomorrow|tonight|this week|next week|weekend|${WEEKDAY_PATTERN})\b`).test(normalized)
    || /\b(?:what have i got|what do i have|have i got anything)\s+on\b/.test(normalized)
    || (/\bhave i got anything\b/.test(normalized)
      && CALENDAR_DAY_WORD.test(normalized))
    || (/\bi have got anything\b/.test(normalized)
      && CALENDAR_DAY_WORD.test(normalized))
    || (/\b(?:(?:do|did)\s+(?:we|i)\s+have|have\s+(?:we|i)\s+got|got|any|what)\s+(?:any\s+)?(?:shit|stuff|things|plans)\s+(?:is\s+|are\s+)?on\b/.test(normalized)
      && CALENDAR_DAY_WORD.test(normalized))
    || (/\b(?:anything|something|what(?: i)?s|what is)\s+on\b/.test(normalized)
      && CALENDAR_DAY_WORD.test(normalized));
}

export function looksLikeTodoQuestion(normalized: string): boolean {
  return parseTodoQueryIntent(normalized) !== null;
}

export function looksLikeScheduleQuestion(normalized: string): boolean {
  if (looksLikePersonalMemoryQuestion(normalized)) {
    return false;
  }
  const asksWhen = /\bwhen\b/.test(normalized) || /\bwhat(?: s| is)?(?: the)? time\b/.test(normalized);
  if (!asksWhen) {
    return false;
  }
  if (/\b(?:weather|temperature|forecast|rain|storm|sunrise|sunset|alarm|timer|music|song|track)\b/.test(normalized)) {
    return false;
  }
  return /\b(?:usually|normally|routine|schedule|school|work|lesson|lessons|practice|pickup|pick up|drop off|dropoff|leave|leaving|arrive|arrival|start|starting|finish|finishing|bin|bins|waste|recycling|calendar|event|appointment|reminder)\b/.test(normalized)
    || /\b(?:when do|when is|when are|what time is|what time are|what time do)\b/.test(normalized);
}

export async function scheduleAnswer(
  config: ScheduleConfig,
  routes: ScheduleRouteServices,
  request: VoiceBrainRequest,
  transcript: string,
  normalized: string,
  now: Date,
): Promise<ScheduleRouteResult> {
  const routine = recallScheduleRoutine(config, request, transcript, normalized);
  if (routine) {
    if (isGuestScheduleRequest(request)) {
      return withheld("memory_query", "guest mode blocked routine memory schedule match");
    }
    return routine;
  }

  const calendar = await scheduleCalendarAnswer(routes, normalized, now);
  if (calendar) {
    return calendar;
  }

  if (looksLikeCalendarQuestion(normalized) || /\b(?:bin|bins|waste|recycling|calendar|event|events|appointment|appointments)\b/.test(normalized) || resolveTimeWindowFromQuestion(normalized, now)) {
    return calendarAnswer(routes, now, normalized);
  }

  return declined("memory_query", "I couldn't find a routine or calendar answer for that.", "schedule query found no accepted routine or calendar match");
}

export async function todoAnswer(routes: ScheduleRouteServices, normalized: string): Promise<ScheduleRouteResult> {
  if (!routes.todoFetcher) {
    return declined("calendar_query", "I can't see the to-do lists yet.", "todo source unavailable");
  }
  const states = routes.stateCache?.entries() ?? [];
  const todoEntities = todoEntitiesForQuestion(states, normalized);
  if (todoEntities.length === 0) {
    return declined("calendar_query", "I can't see any matching to-do lists yet.", "no matching todo entities in live state");
  }
  try {
    const items = await routes.todoFetcher.fetchItems({
      entityIds: todoEntities.map((state) => state.entityId),
      statuses: ["needs_action"],
      listNames: Object.fromEntries(todoEntities.map((state) => [state.entityId, friendlyName(state)])),
    });
    const text = todoItemsSentence(todoEntities, items);
    return ok(
      "calendar_query",
      text,
      `todo.get_items checked ${todoEntities.length} lists`,
      null,
      todoSpeechPlan(todoEntities, items),
    );
  } catch (error) {
    return declined(
      "calendar_query",
      "I couldn't read the to-do lists just now.",
      error instanceof Error ? `todo source error: ${error.message}` : "todo source error",
    );
  }
}

export async function calendarAnswer(
  routes: ScheduleRouteServices,
  now: Date,
  normalized: string,
  options: {
    readonly entityIds?: readonly string[];
    readonly window?: TimeWindow;
    readonly commitments?: readonly UpcomingHousePatternCommitment[];
  } = {},
): Promise<ScheduleRouteResult> {
  const commitments = options.commitments ?? [];
  if (!routes.calendarFetcher) {
    if (commitments.length > 0) {
      return ok(
        "calendar_query",
        `I can't read the calendar just now, but ${commitmentsSentence(commitments, now)}.`,
        `calendar source unavailable; ${commitments.length} reviewed routine commitments matched`,
      );
    }
    return declined("calendar_query", "I can't see the calendar yet.", "calendar source unavailable");
  }
  const states = routes.stateCache?.entries() ?? [];
  const calendarEntities = options.entityIds
    ? calendarEntitiesForIds(states, options.entityIds)
    : calendarEntitiesForQuestion(states, normalized);
  if (calendarEntities.length === 0) {
    if (commitments.length > 0) {
      return ok(
        "calendar_query",
        `I can't see a calendar source just now, but ${commitmentsSentence(commitments, now)}.`,
        `no matching calendar entities; ${commitments.length} reviewed routine commitments matched`,
      );
    }
    return declined("calendar_query", "I can't see any matching calendar entities yet.", "no matching calendar entities in live state");
  }

  const window = options.window ?? calendarWindowFromQuestion(normalized, now);
  try {
    const events = await routes.calendarFetcher.fetchEvents({
      entityIds: calendarEntities.map((state) => state.entityId),
      start: window.start,
      end: window.end,
      calendarNames: Object.fromEntries(calendarEntities.map((state) => [state.entityId, friendlyName(state)])),
    });
    const text = combinedCommitmentsText(events, commitments, window.label, now);
    return ok(
      "calendar_query",
      text,
      `calendar.get_events checked ${calendarEntities.length} calendars for ${window.label}; ${commitments.length} reviewed routine commitments matched`,
      { kind: "calendar", entityIds: calendarEntities.map((state) => state.entityId), window },
      commitments.length === 0 ? calendarSpeechPlan(events, window.label, now) : null,
    );
  } catch (error) {
    if (commitments.length > 0) {
      return ok(
        "calendar_query",
        `I couldn't read the calendar just now, but ${commitmentsSentence(commitments, now)}.`,
        `${error instanceof Error ? `calendar source error: ${error.message}` : "calendar source error"}; ${commitments.length} reviewed routine commitments matched`,
      );
    }
    return declined(
      "calendar_query",
      "I couldn't read the calendar just now.",
      error instanceof Error ? `calendar source error: ${error.message}` : "calendar source error",
    );
  }
}

/**
 * Open chat's calendar read: the calendars and event wording the
 * calendar route uses, every event in the next `daysAhead` days (capped).
 */
export async function calendarOutlookLines(
  routes: ScheduleRouteServices,
  now: Date,
  kind: CalendarKind,
  daysAhead: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!routes.calendarFetcher) return "The calendar is unavailable right now.";
  const calendars = calendarEntitiesOfKind(routes.stateCache?.entries() ?? [], kind);
  if (calendars.length === 0) return "There is no calendar for that.";
  const label = daysAhead === 1 ? "today" : `in the next ${daysAhead} days`;
  const window = parsedCalendarDateRange(0, daysAhead, label, now);
  const events = await routes.calendarFetcher.fetchEvents({
    entityIds: calendars.map((state) => state.entityId),
    start: window.start,
    end: window.end,
    calendarNames: Object.fromEntries(calendars.map((state) => [state.entityId, friendlyName(state)])),
    ...(signal ? { signal } : {}),
  });
  const names = calendars.map(friendlyName).join(", ");
  if (events.length === 0) return `Nothing on ${names} ${label}.`;
  const shown = events.slice(0, CALENDAR_OUTLOOK_EVENTS);
  return [
    `On ${names} ${label}:`,
    ...shown.map((event) => `- ${calendarEventPhrase(event, now)}`),
    ...(events.length > shown.length ? [`And ${events.length - shown.length} more.`] : []),
  ].join("\n");
}

const CALENDAR_OUTLOOK_EVENTS = 12;

/** Open chat's to-do read: every list's open items, as the to-do route words them. */
export async function todoListLines(routes: ScheduleRouteServices, signal?: AbortSignal): Promise<string> {
  if (!routes.todoFetcher) return "The to-do lists are unavailable right now.";
  const lists = todoEntitiesForQuestion(routes.stateCache?.entries() ?? [], "");
  if (lists.length === 0) return "There are no to-do lists.";
  const items = await routes.todoFetcher.fetchItems({
    entityIds: lists.map((state) => state.entityId),
    statuses: ["needs_action"],
    listNames: Object.fromEntries(lists.map((state) => [state.entityId, friendlyName(state)])),
    ...(signal ? { signal } : {}),
  });
  return lists.map((list) => {
    const open = items.filter((item) => item.entityId === list.entityId);
    const shown = open.slice(0, TODO_OUTLOOK_ITEMS);
    return open.length === 0
      ? `${friendlyName(list)}: empty.`
      : `${friendlyName(list)}: ${shown.map(todoItemSpeech).join("; ")}${open.length > shown.length ? `; and ${open.length - shown.length} more` : ""}.`;
  }).join("\n");
}

const TODO_OUTLOOK_ITEMS = 15;

export async function upcomingCommitmentsAnswer(
  config: ScheduleConfig,
  routes: ScheduleRouteServices,
  request: VoiceBrainRequest,
  normalized: string,
  now: Date,
): Promise<ScheduleRouteResult> {
  const window = calendarWindowFromQuestion(normalized, now);
  const commitments = upcomingHousePatternCommitments(config, request, window, now);
  return calendarAnswer(routes, now, normalized, { window, commitments });
}

export async function calendarClarifierChoiceAnswer(
  routes: ScheduleRouteServices,
  now: Date,
  choice: PendingClarifierChoice,
): Promise<ScheduleRouteResult> {
  const action = choice.action;
  if (action.kind !== "calendar_event") {
    return declined("calendar_query", "I lost that calendar choice.", "non-calendar choice reached calendar revalidation");
  }
  if (!routes.calendarFetcher) {
    return declined("calendar_query", "I can't see the calendar yet.", "calendar source unavailable during clarifier revalidation");
  }
  const states = routes.stateCache?.entries() ?? [];
  const calendarEntities = calendarEntitiesForIds(states, action.entityIds);
  if (calendarEntities.length === 0) {
    return declined("calendar_query", "I can't see that calendar anymore.", "calendar clarifier entities unavailable during revalidation");
  }
  try {
    const events = await routes.calendarFetcher.fetchEvents({
      entityIds: calendarEntities.map((state) => state.entityId),
      start: action.window.start,
      end: action.window.end,
      calendarNames: Object.fromEntries(calendarEntities.map((state) => [state.entityId, friendlyName(state)])),
    });
    const event = events.find((candidate) => (
      candidate.summary === action.eventSummary
      && candidate.start === action.eventStart
      && candidate.end === action.eventEnd
      && action.entityIds.includes(candidate.entityId)
    )) ?? null;
    if (!event) {
      return declined("calendar_query", "That calendar event isn't there anymore.", "calendar clarifier reference failed live revalidation");
    }
    return ok(
      "calendar_query",
      `${event.summary} ${calendarEventWhen(event, now)}.`,
      "calendar clarifier choice revalidated against calendar.get_events",
      { kind: "calendar", entityIds: action.entityIds, window: action.window },
    );
  } catch (error) {
    return declined(
      "calendar_query",
      "I couldn't recheck that calendar event just now.",
      error instanceof Error ? `calendar clarifier source error: ${error.message}` : "calendar clarifier source error",
    );
  }
}

async function scheduleCalendarAnswer(
  routes: ScheduleRouteServices,
  normalized: string,
  now: Date,
): Promise<ScheduleRouteResult | null> {
  if (!routes.calendarFetcher) {
    return null;
  }
  const states = routes.stateCache?.entries() ?? [];
  const calendarEntities = calendarEntitiesForQuestion(states, normalized);
  if (calendarEntities.length === 0) {
    return null;
  }
  const window = resolveTimeWindowFromQuestion(normalized, now) ?? parsedCalendarDateRange(0, 30, "in the next 30 days", now);
  try {
    const events = await routes.calendarFetcher.fetchEvents({
      entityIds: calendarEntities.map((state) => state.entityId),
      start: window.start,
      end: window.end,
      calendarNames: Object.fromEntries(calendarEntities.map((state) => [state.entityId, friendlyName(state)])),
    });
    const resolution = bestScheduleCalendarEventResolution(events, normalized, now, {
      entityIds: calendarEntities.map((state) => state.entityId),
      window,
    });
    if (resolution.status === "clarify") {
      return clarify("calendar_query", resolution.text, resolution.notes, resolution.contextFrame);
    }
    if (!resolution.event) {
      if (looksLikeCalendarQuestion(normalized) || /\b(?:bin|bins|waste|recycling|calendar|event|events|appointment|appointments)\b/.test(normalized) || resolveTimeWindowFromQuestion(normalized, now)) {
        const text = events.length === 0
          ? `I don't see anything on the calendar ${window.label}.`
          : calendarEventsSentence(events, window.label, now);
        return ok(
          "calendar_query",
          text,
          `calendar schedule window checked ${calendarEntities.length} calendars for ${window.label}`,
          { kind: "calendar", entityIds: calendarEntities.map((state) => state.entityId), window },
          calendarSpeechPlan(events, window.label, now),
        );
      }
      return null;
    }
    return ok(
      "calendar_query",
      `${resolution.event.summary} ${calendarEventWhen(resolution.event, now)}.`,
      `calendar schedule match from ${calendarEntities.length} calendars for ${window.label}`,
      { kind: "calendar", entityIds: calendarEntities.map((state) => state.entityId), window },
    );
  } catch {
    return null;
  }
}

function recallScheduleRoutine(
  config: ScheduleConfig,
  request: VoiceBrainRequest,
  transcript: string,
  normalized: string,
): ScheduleRouteResult | null {
  if (!cognitiveFeatureEnabled(config, "recall")) {
    return null;
  }
  const store = new MemoryStore(memoryStorePath(config));
  try {
    const match = bestScheduleRoutineMatch(store.listMemoryRecords(), request, transcript, normalized);
    if (!match) {
      return null;
    }
    return ok("memory_query", memoryPlainText(match), "accepted routine memory schedule match");
  } finally {
    store.close();
  }
}

function isGuestScheduleRequest(request: VoiceBrainRequest): boolean {
  return trustedSpeakerPersonId(request) === null;
}

function calendarEntitiesForIds(states: readonly HaEntityState[], entityIds: readonly string[]): readonly HaEntityState[] {
  const byId = new Map(states.map((state) => [state.entityId, state]));
  return entityIds
    .map((entityId) => byId.get(entityId))
    .filter((state): state is HaEntityState => Boolean(state));
}

function calendarEntitiesForQuestion(states: readonly HaEntityState[], normalized: string): readonly HaEntityState[] {
  return calendarEntitiesOfKind(
    states,
    /\b(bin|bins|rubbish|trash|waste|recycling|green waste|greens)\b/.test(normalized)
      ? "bins"
      : /\b(radarr|movie|movies|film|films|release|releases)\b/.test(normalized)
        ? "releases"
        : "household",
  );
}

/** Which calendars a question is about: bin collection, film releases, or the household's own. */
export type CalendarKind = "household" | "bins" | "releases";

function calendarEntitiesOfKind(states: readonly HaEntityState[], kind: CalendarKind): readonly HaEntityState[] {
  const allCalendars = states
    .filter((state) => state.entityId.startsWith("calendar."))
    .sort((left, right) => friendlyName(left).localeCompare(friendlyName(right)));
  if (allCalendars.length === 0) {
    return [];
  }
  if (kind === "bins") {
    const waste = allCalendars.filter((state) => WASTE_CALENDAR_PATTERN.test(`${state.entityId} ${friendlyName(state)}`));
    return waste.length > 0 ? waste : allCalendars;
  }
  if (kind === "releases") {
    const media = allCalendars.filter((state) => /radarr|movie|film|release/i.test(`${state.entityId} ${friendlyName(state)}`));
    return media.length > 0 ? media : allCalendars;
  }
  const personal = allCalendars.filter((state) => isPersonalCalendarText(`${state.entityId} ${friendlyName(state)}`));
  if (personal.length > 0) {
    return personal;
  }
  return allCalendars;
}

function todoEntitiesForQuestion(states: readonly HaEntityState[], normalized: string): readonly HaEntityState[] {
  const allTodos = states
    .filter((state) => state.entityId.startsWith("todo."))
    .sort((left, right) => friendlyName(left).localeCompare(friendlyName(right)));
  if (allTodos.length === 0) {
    return [];
  }
  const intent = parseTodoQueryIntent(normalized);
  if (intent?.kind === "shopping") {
    const shopping = allTodos.filter((state) => /shopping|grocer/i.test(`${state.entityId} ${friendlyName(state)}`));
    return shopping.length > 0 ? shopping : allTodos;
  }
  if (intent?.kind === "reminders") {
    const reminders = allTodos.filter((state) => {
      const name = friendlyName(state);
      const entitySuffix = state.entityId.replace(/^todo\./, "");
      return /reminder/i.test(`${entitySuffix} ${name}`) || /todo|task/i.test(name);
    });
    return reminders.length > 0 ? reminders : allTodos;
  }
  return allTodos;
}

function todoItemsSentence(todoEntities: readonly HaEntityState[], items: readonly HaTodoItem[]): string {
  if (todoEntities.length === 1) {
    const listName = friendlyName(todoEntities[0]!);
    if (items.length === 0) {
      return `${listName} is empty.`;
    }
    if (items.length === 1) {
      return `${listName} has 1 item: ${todoItemSpeech(items[0]!)}.`;
    }
    const shown = items.slice(0, 3).map((item) => todoItemSpeech(item));
    if (items.length <= 3) {
      return `${listName} has ${items.length} items: ${joinNatural(shown)}.`;
    }
    return `${listName} has ${items.length} items: ${joinNatural(shown)}, and ${items.length - shown.length} more.`;
  }

  if (items.length === 0) {
    return "I don't see any open to-do items.";
  }

  const grouped = new Map<string, HaTodoItem[]>();
  for (const item of items) {
    const key = item.entityId;
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      grouped.set(key, [item]);
    }
  }
  const summaries = todoEntities
    .map((state) => {
      const count = grouped.get(state.entityId)?.length ?? 0;
      return `${friendlyName(state)}: ${count}`;
    })
    .filter((summary) => !summary.endsWith(": 0"));
  if (summaries.length === 0) {
    return "I don't see any open to-do items.";
  }
  return `Open to-do items: ${joinNatural(summaries)}.`;
}

function todoSpeechPlan(
  todoEntities: readonly HaEntityState[],
  items: readonly HaTodoItem[],
): BasicSpeechRenderPlan {
  if (todoEntities.length === 1) {
    const shown = items.slice(0, 3).map((item) => todoItemSpeech(item));
    return {
      kind: "todo_items",
      listName: friendlyName(todoEntities[0]!),
      items: shown,
      totalCount: items.length,
      remainingCount: Math.max(0, items.length - shown.length),
      grouped: false,
    };
  }
  const grouped = new Map<string, number>();
  for (const item of items) {
    grouped.set(item.entityId, (grouped.get(item.entityId) ?? 0) + 1);
  }
  const summaries = todoEntities
    .map((state) => {
      const count = grouped.get(state.entityId) ?? 0;
      return count > 0 ? `${friendlyName(state)}: ${count}` : null;
    })
    .filter((summary): summary is string => summary !== null);
  return {
    kind: "todo_items",
    listName: null,
    items: summaries,
    totalCount: items.length,
    remainingCount: 0,
    grouped: true,
  };
}

function todoItemSpeech(item: HaTodoItem): string {
  const due = todoDueSpeech(item.due);
  return due ? `${item.summary} due ${due}` : item.summary;
}

function todoDueSpeech(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return trimmed;
  }
  const hasTime = /\dT\d/.test(trimmed);
  return hasTime
    ? parsed.toLocaleString(HOUSE_LOCALE, {
        timeZone: DEFAULT_TIMEZONE,
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : parsed.toLocaleDateString(HOUSE_LOCALE, {
        timeZone: DEFAULT_TIMEZONE,
        weekday: "long",
        month: "long",
        day: "numeric",
      });
}

function calendarWindowFromQuestion(normalized: string, now: Date): TimeWindow {
  const calendarText = normalized
    .replace(/\btodays\b/g, "today")
    .replace(/\btomorrows\b/g, "tomorrow")
    .replace(/\b(?:for )?the week\b/g, "this week");
  const parsed = resolveTimeWindowFromQuestion(calendarText, now);
  if (parsed) {
    return parsed;
  }
  if (/\btoday\b|\btonight\b/.test(calendarText)) {
    return parsedCalendarWindow("today", now, "today");
  }
  if (/\btomorrow\b/.test(calendarText)) {
    return parsedCalendarWindow("tomorrow", now, "tomorrow");
  }
  if (/\bnext week\b/.test(calendarText)) {
    const todayWeekday = localWeekday(now, DEFAULT_TIMEZONE);
    const startOffset = todayWeekday === 0 ? 1 : 8 - todayWeekday;
    return parsedCalendarDateRange(startOffset, startOffset + 7, "next week", now);
  }
  if (/\bthis week\b/.test(calendarText)) {
    return parsedCalendarDateRange(0, 7, "this week", now);
  }
  if (/\bweekend\b/.test(calendarText)) {
    const todayWeekday = localWeekday(now, DEFAULT_TIMEZONE);
    const saturdayOffset = todayWeekday <= 6 ? 6 - todayWeekday : 0;
    return parsedCalendarDateRange(saturdayOffset, saturdayOffset + 2, "this weekend", now);
  }
  const weekday = requestedCalendarWeekday(calendarText);
  if (weekday !== null) {
    const todayWeekday = localWeekday(now, DEFAULT_TIMEZONE);
    const offset = (weekday - todayWeekday + 7) % 7;
    const label = WEEKDAY_NAMES[weekday] ?? "that day";
    return parsedCalendarDateRange(offset, offset + 1, label, now);
  }
  if (/\b(?:next|coming)\s+(?:7|seven)\s+days\b|\bcoming week\b|\bnext few days\b/.test(normalized)) {
    return parsedCalendarDateRange(0, 7, "the next 7 days", now);
  }
  return parsedCalendarDateRange(0, 7, "the next 7 days", now);
}

function parsedCalendarWindow(text: string, now: Date, label: string): TimeWindow {
  const parsed = parseTimeWindow(text, { now, timezone: DEFAULT_TIMEZONE });
  if (parsed.window) {
    return { ...parsed.window, label };
  }
  return parsedCalendarDateRange(0, 1, label, now);
}

function parsedCalendarDateRange(startOffset: number, endOffset: number, label: string, now: Date): TimeWindow {
  const startDate = localDateOffset(now, DEFAULT_TIMEZONE, startOffset);
  const endDate = localDateOffset(now, DEFAULT_TIMEZONE, Math.max(startOffset, endOffset - 1));
  const parsed = parseTimeWindow(`from ${startDate} to ${endDate}`, { now, timezone: DEFAULT_TIMEZONE });
  if (parsed.window) {
    return { ...parsed.window, label };
  }
  return {
    start: `${startDate}T00:00:00.000Z`,
    end: `${endDate}T00:00:00.000Z`,
    timezone: DEFAULT_TIMEZONE,
    label,
    source: "relative_calendar",
    confidence: "medium",
  };
}

function requestedCalendarWeekday(normalized: string): number | null {
  return WEEKDAY_NAMES.findIndex((day) => new RegExp(`\\b${day}\\b`).test(normalized));
}

function calendarEventsSentence(events: readonly HaCalendarEvent[], windowLabel: string, now: Date): string {
  const shown = events.slice(0, 3).map((event) => calendarEventPhrase(event, now));
  const prefix = events.length === 1 ? `I found one calendar event ${windowLabel}: ` : `I found ${events.length} calendar events ${windowLabel}: `;
  const suffix = events.length > shown.length ? `, and ${events.length - shown.length} more` : "";
  return `${prefix}${joinNatural(shown)}${suffix}.`;
}

function combinedCommitmentsText(
  events: readonly HaCalendarEvent[],
  commitments: readonly UpcomingHousePatternCommitment[],
  windowLabel: string,
  now: Date,
): string {
  if (commitments.length === 0) {
    return events.length === 0
      ? `I don't see anything on the calendar ${windowLabel}.`
      : calendarEventsSentence(events, windowLabel, now);
  }
  const routineText = commitmentsSentence(commitments, now);
  if (events.length === 0) {
    return `I don't see anything on the calendar ${windowLabel}, but ${routineText}.`;
  }
  return `${calendarEventsSentence(events, windowLabel, now)} You also ${routineText.replace(/^you\s+/i, "")}.`;
}

function commitmentsSentence(commitments: readonly UpcomingHousePatternCommitment[], now: Date): string {
  const clauses = commitments.slice(0, 3).map((commitment) => commitmentClause(commitment, now));
  const remaining = commitments.length - clauses.length;
  return `you ${joinNatural(clauses)}${remaining > 0 ? `, plus ${remaining} more usual commitment${remaining === 1 ? "" : "s"}` : ""}`;
}

function commitmentClause(commitment: UpcomingHousePatternCommitment, now: Date): string {
  const startsAt = new Date(commitment.startsAt);
  const dateLabel = calendarEventDateLabel(commitment.startsAt, now);
  const day = dateLabel === "today" ? "" : `${dateLabel} `;
  return `usually ${commitment.actionText} ${day}around ${formatCalendarClock(startsAt)}, ${relativeCommitmentTime(startsAt, now)}`;
}

function relativeCommitmentTime(startsAt: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((startsAt.getTime() - now.getTime()) / 60_000));
  if (minutes < 2) return "very shortly";
  if (minutes < 90) return `in about ${minutes} minutes`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `in about ${hours} hours`;
}

function calendarSpeechPlan(
  events: readonly HaCalendarEvent[],
  windowLabel: string,
  now: Date,
): BasicSpeechRenderPlan {
  if (events.length === 0) {
    return { kind: "calendar_empty", windowLabel };
  }
  const items = events.slice(0, 3).map((event) => calendarEventPhrase(event, now));
  return {
    kind: "calendar_events",
    count: events.length,
    windowLabel,
    items,
    remainingCount: Math.max(0, events.length - items.length),
  };
}

function calendarEventPhrase(event: HaCalendarEvent, now: Date): string {
  const summary = cleanCalendarEventSummary(event.summary);
  const when = calendarEventWhen(event, now);
  const location = event.location ? ` at ${event.location}` : "";
  return `${summary}${when ? ` ${when}` : ""}${location}`;
}

function calendarEventWhen(event: HaCalendarEvent, now: Date): string {
  const dateLabel = calendarEventDateLabel(event.start, now);
  if (calendarEventAllDay(event.start, event.end)) {
    return dateLabel ? `on ${dateLabel}` : "";
  }
  const time = formatCalendarTimeRange(event.start, event.end);
  if (!time) {
    return dateLabel ? `on ${dateLabel}` : "";
  }
  return dateLabel === "today" || dateLabel === "tomorrow" ? `${dateLabel} at ${time}` : `on ${dateLabel} at ${time}`;
}

function calendarEventDateLabel(iso: string, now: Date): string {
  const date = iso.slice(0, 10);
  if (date === localDateOffset(now, DEFAULT_TIMEZONE, 0)) {
    return "today";
  }
  if (date === localDateOffset(now, DEFAULT_TIMEZONE, 1)) {
    return "tomorrow";
  }
  const parsed = iso.includes("T") ? new Date(iso) : new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return date;
  }
  return new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: iso.includes("T") ? DEFAULT_TIMEZONE : "UTC",
    weekday: "long",
    day: "numeric",
    month: "short",
  }).format(parsed);
}

function calendarEventAllDay(start: string, end: string): boolean {
  return !start.includes("T") && !end.includes("T");
}

function formatCalendarTimeRange(start: string, end: string): string | null {
  if (!start.includes("T")) {
    return null;
  }
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime())) {
    return null;
  }
  const startText = formatCalendarClock(startDate);
  if (Number.isNaN(endDate.getTime()) || endDate.getTime() <= startDate.getTime()) {
    return startText;
  }
  return `${startText} to ${formatCalendarClock(endDate)}`;
}

function formatCalendarClock(date: Date): string {
  const hour = hourInTimezone(date.toISOString(), DEFAULT_TIMEZONE);
  const minute = Number(new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: DEFAULT_TIMEZONE,
    minute: "2-digit",
  }).format(date));
  if (hour === 12 && minute === 0) {
    return "noon";
  }
  if (hour === 0 && minute === 0) {
    return "midnight";
  }
  return new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: DEFAULT_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date).replace(/\s/g, " ");
}

function cleanCalendarEventSummary(summary: string): string {
  const stripped = summary
    .replace(/\s+(?:today|tomorrow)\s+at\s+(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.))\s*$/i, "")
    .replace(/\s+on\s+[a-z]+,\s+[a-z]{3,9}\s+\d{1,2}\s+at\s+(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.))(?:\s+to\s+(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)))?\s*$/i, "")
    .replace(/\s+at\s+(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.))(?:\s+to\s+(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)))?\s*$/i, "")
    .trim();
  return stripped || summary;
}

function recallTimeWindowCandidates(transcript: string): readonly string[] {
  const tokens = normalize(transcript).split(" ").filter(Boolean);
  const candidates: string[] = [];
  for (let start = 0; start < tokens.length; start += 1) {
    for (let length = 1; length <= Math.min(8, tokens.length - start); length += 1) {
      candidates.push(tokens.slice(start, start + length).join(" "));
    }
  }
  return [...new Set(candidates)].sort((left, right) => right.length - left.length);
}

function resolveTimeWindowFromQuestion(transcript: string, now: Date): TimeWindow | null {
  for (const candidate of recallTimeWindowCandidates(transcript)) {
    const parsed = parseTimeWindow(candidate, { now, timezone: DEFAULT_TIMEZONE });
    if (parsed.status === "matched" && parsed.window) {
      return parsed.window;
    }
  }
  return null;
}

function bestScheduleRoutineMatch(
  records: readonly MemoryRecord[],
  request: VoiceBrainRequest,
  transcript: string,
  normalized: string,
): MemoryRecord | null {
  const tokens = scheduleMeaningfulTokens(transcript);
  const contentTokens = tokens.filter((token) => !householdNameTokens().has(token));
  const subjectTokens = tokens.filter((token) => householdNameTokens().has(token));
  const speakerSubject = /\b(?:i|me|my|mine)\b/.test(normalized);
  const matches = records
    .filter((record) => record.category === "routine")
    .filter((record) => record.reviewStatus === "accepted")
    .filter((record) => record.payload.category === "routine" && record.payload.eligibleForReasoning)
    .map((record) => {
      const text = memorySearchText(record);
      const matchedContent = contentTokens.filter((token) => text.includes(token));
      const matchedSubjects = memorySubjectTokens(record).filter((token) => subjectTokens.includes(token));
      const speakerMatch = speakerSubject && record.subjectIds.some((subjectId) => subjectMatchesSpeaker(subjectId, request));
      return {
        record,
        matchedContent,
        matchedSubjects,
        speakerMatch,
        score: matchedContent.length + (matchedSubjects.length * 3) + (speakerMatch ? 2 : 0),
      };
    })
    .filter((match) => subjectTokens.length === 0 || match.matchedSubjects.length > 0)
    .filter((match) => !speakerSubject || match.speakerMatch || match.matchedSubjects.length > 0)
    .filter((match) => contentTokens.length > 0 ? match.matchedContent.length > 0 : (match.matchedSubjects.length > 0 || match.speakerMatch))
    .sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt));
  return matches[0]?.record ?? null;
}

function bestScheduleCalendarEventResolution(
  events: readonly HaCalendarEvent[],
  normalized: string,
  now: Date,
  context: { readonly entityIds: readonly string[]; readonly window: TimeWindow },
): { readonly status: "event"; readonly event: HaCalendarEvent } | { readonly status: "clarify"; readonly text: string; readonly notes: string; readonly contextFrame: PendingClarifierFrame } | { readonly status: "none"; readonly event: null } {
  const tokens = scheduleMeaningfulTokens(normalized).filter((token) => !householdNameTokens().has(token));
  if (tokens.length === 0) {
    return { status: "none", event: null };
  }
  const matches = events
    .map((event) => {
      const text = normalize(`${event.summary} ${event.location ?? ""}`);
      const score = tokens.reduce((total, token) => total + (text.includes(token) ? 1 : 0), 0);
      return { event, score };
    })
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.event.start.localeCompare(right.event.start));
  if (matches.length === 0) {
    return { status: "none", event: null };
  }
  const bestScore = matches[0]!.score;
  const tied = matches.filter((match) => match.score === bestScore).slice(0, 4);
  if (tied.length > 1) {
    const choices: PendingClarifierChoice[] = tied.map((match, index) => ({
      id: `calendar-event-${index + 1}`,
      label: calendarClarifierLabel(match.event, now),
      synonyms: [match.event.summary],
      action: {
        kind: "calendar_event",
        eventSummary: match.event.summary,
        eventStart: match.event.start,
        eventEnd: match.event.end,
        entityIds: [match.event.entityId],
        window: context.window,
      },
    }));
    return {
      status: "clarify",
      text: `Do you mean ${joinClarifierChoices(choices.map((choice) => choice.label))}?`,
      notes: `calendar schedule clarify from ${tied.length} tied event matches`,
      contextFrame: {
        kind: "clarifier",
        route: "calendar_query",
        prompt: `Do you mean ${joinClarifierChoices(choices.map((choice) => choice.label))}?`,
        choices,
      },
    };
  }
  return { status: "event", event: matches[0]!.event };
}

function calendarClarifierLabel(event: HaCalendarEvent, now: Date): string {
  const dateLabel = calendarEventDateLabel(event.start, now);
  return dateLabel ? `${event.summary} ${dateLabel}` : event.summary;
}

function scheduleMeaningfulTokens(text: string): readonly string[] {
  const stop = new Set([
    "what",
    "when",
    "time",
    "tell",
    "show",
    "list",
    "have",
    "with",
    "from",
    "that",
    "this",
    "usually",
    "normal",
    "normally",
    "schedule",
    "routine",
    "calendar",
    "event",
    "events",
    "appointment",
    "appointments",
  ]);
  return normalize(text).split(" ").filter((token) => token.length >= 3 && !stop.has(token));
}

function memorySearchText(record: MemoryRecord): string {
  return normalize([
    record.title,
    record.summary,
    ...record.subjectIds,
    ...record.tags,
  ].join(" "));
}

function memorySubjectTokens(record: MemoryRecord): readonly string[] {
  return record.subjectIds.flatMap((subject) => {
    const normalized = normalize(subject);
    const tail = normalized.split(".").pop() ?? normalized;
    return householdPersonById(normalized)?.aliases ?? [tail];
  });
}

function clarify(
  route: ScheduleRouteResult["route"],
  text: string,
  notes: string,
  contextFrame: PendingClarifierFrame,
): ScheduleRouteResult {
  return {
    route,
    status: "clarify",
    confidence: "low",
    text,
    modelUsed: false,
    resultId: null,
    touchedEntities: [],
    notes,
    contextFrame,
  };
}

function joinClarifierChoices(values: readonly string[]): string {
  if (values.length === 0) {
    return "";
  }
  if (values.length === 1) {
    return values[0] ?? "";
  }
  if (values.length === 2) {
    return `${values[0] ?? ""} or ${values[1] ?? ""}`;
  }
  return `${values.slice(0, -1).join(", ")}, or ${values.at(-1) ?? ""}`;
}
