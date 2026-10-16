import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AppConfig } from "./config.js";
import type { PassiveEventWatcherService, PassiveWatcherEvent } from "./event-watchers.js";
import { isPersonalCalendarText, type HaCalendarEvent, type HaCalendarFetcher } from "./ha-calendar.js";
import type { HaEntityState, HaStateCache } from "./ha-state-cache.js";
import { normalizeSpeechForRouting } from "./speech-normalizer.js";
import { optionalString } from "./value-guards.js";
import { friendlyName, openingOpen, personPresent } from "./ha-state-cache.js";
import { householdRegex } from "./household.js";

const LOOKAHEAD_DAYS = 30;
const RAINY_WEATHER_STATES = new Set(["rainy", "pouring", "lightning-rainy", "snowy-rainy"]);

export type ConditionalReminderKind =
  | "calendar_start"
  | "rain_before_event"
  | "rain_start"
  | "person_arrived"
  | "person_departed"
  | "opening_opened"
  | "opening_closed";
export type ConditionalReminderStatus = "active" | "triggered" | "expired" | "cancelled";
export type ConditionalReminderRequest =
  | { readonly kind: "calendar_start"; readonly eventQuery: string }
  | { readonly kind: "rain_before_event"; readonly eventQuery: string }
  | { readonly kind: "rain_start" }
  | { readonly kind: "person_arrived" | "person_departed"; readonly personQuery: string }
  | { readonly kind: "opening_opened" | "opening_closed"; readonly targetQuery: string };

export interface ConditionalReminderRecord {
  readonly id: string;
  readonly kind: ConditionalReminderKind;
  readonly createdAt: string;
  readonly speakerName: string | null;
  readonly eventSummary: string | null;
  readonly eventStart: string | null;
  readonly calendarEntityId: string | null;
  readonly weatherEntityId: string | null;
  readonly personId: string | null;
  readonly personName: string | null;
  readonly entityId: string | null;
  readonly label: string | null;
  readonly status: ConditionalReminderStatus;
  readonly triggeredAt: string | null;
}

export interface ConditionalReminderService {
  createCalendarStartReminder(request: { readonly eventQuery: string; readonly speakerName: string | null }): Promise<ConditionalReminderResult>;
  createRainBeforeEventReminder(request: { readonly eventQuery: string; readonly speakerName: string | null }): Promise<ConditionalReminderResult>;
  createRainStartReminder(request: { readonly speakerName: string | null }): Promise<ConditionalReminderResult>;
  createPersonArrivedReminder(request: { readonly personId: string; readonly personName: string; readonly speakerName: string | null }): Promise<ConditionalReminderResult>;
  createPersonDepartedReminder(request: { readonly personId: string; readonly personName: string; readonly speakerName: string | null }): Promise<ConditionalReminderResult>;
  createOpeningOpenedReminder(request: { readonly entityId: string; readonly label: string; readonly speakerName: string | null }): Promise<ConditionalReminderResult>;
  createOpeningClosedReminder(request: { readonly entityId: string; readonly label: string; readonly speakerName: string | null }): Promise<ConditionalReminderResult>;
  evaluateDueReminders(): Promise<void>;
  listReminders(speakerName?: string | null): readonly ConditionalReminderRecord[];
}

export interface ConditionalReminderResult {
  readonly status: "ok" | "declined";
  readonly text: string;
  readonly notes: string;
}

export interface NotificationSink {
  createNotification(request: { readonly id: string; readonly title: string; readonly message: string }): Promise<void>;
}

export interface HaCommandClient {
  sendCommand(command: Readonly<Record<string, unknown>>): Promise<unknown>;
}

interface ConditionalReminderFile {
  readonly reminders?: readonly unknown[];
}

export function parseConditionalReminderRequest(normalized: string): ConditionalReminderRequest | null {
  const calendarStartMatch = /^(?:remind me|tell me|let me know|notify me)\s+when\s+(.+?)\s+starts$/.exec(normalized);
  if (calendarStartMatch?.[1]) {
    return { kind: "calendar_start", eventQuery: calendarStartMatch[1].trim() };
  }

  const rainBeforeMatch = /^(?:remind me|tell me|let me know|notify me)\s+if\s+(?:it\s+starts\s+)?raining\s+before\s+(.+)$/.exec(normalized)
    ?? /^(?:remind me|tell me|let me know|notify me)\s+if\s+rain\s+starts\s+before\s+(.+)$/.exec(normalized)
    ?? /^(?:remind me|tell me|let me know|notify me)\s+if\s+it\s+rains\s+before\s+(.+)$/.exec(normalized);
  if (rainBeforeMatch?.[1]) {
    return { kind: "rain_before_event", eventQuery: rainBeforeMatch[1].trim() };
  }

  if (/^(?:remind me|tell me|let me know|notify me)\s+(?:when|if)\s+(?:it\s+starts\s+)?raining$/.test(normalized)
    || /^(?:remind me|tell me|let me know|notify me)\s+(?:when|if)\s+rain\s+starts$/.test(normalized)
    || /^(?:remind me|tell me|let me know|notify me)\s+(?:when|if)\s+it\s+rains$/.test(normalized)) {
    return { kind: "rain_start" };
  }

  const personArrivedMatch = /^(?:remind me|tell me|let me know|notify me)\s+when\s+(.+?)\s+(?:gets home|get home|comes home|come home|arrives|arrive|is home)$/.exec(normalized);
  if (personArrivedMatch?.[1]) {
    return { kind: "person_arrived", personQuery: personArrivedMatch[1].trim() };
  }

  const personDepartedMatch = /^(?:remind me|tell me|let me know|notify me)\s+when\s+(.+?)\s+(?:leaves|leave|heads out|head out|goes out|go out)$/.exec(normalized);
  if (personDepartedMatch?.[1]) {
    return { kind: "person_departed", personQuery: personDepartedMatch[1].trim() };
  }

  const openingOpenedMatch = /^(?:remind me|tell me|let me know|notify me)\s+when\s+(.+?)\s+(?:opens|open)$/.exec(normalized);
  if (openingOpenedMatch?.[1]) {
    return { kind: "opening_opened", targetQuery: openingOpenedMatch[1].trim() };
  }

  const openingClosedMatch = /^(?:remind me|tell me|let me know|notify me)\s+when\s+(.+?)\s+(?:closes|close|shuts|shut)$/.exec(normalized);
  if (openingClosedMatch?.[1]) {
    return { kind: "opening_closed", targetQuery: openingClosedMatch[1].trim() };
  }

  return null;
}

export function conditionalReminderStorePath(config: Pick<AppConfig, "dataDir">): string {
  return join(config.dataDir, "conditional-reminders.json");
}

export class PersistentConditionalReminderService implements ConditionalReminderService {
  private readonly filePath: string;
  private readonly stateCache: HaStateCache;
  private readonly calendarFetcher: HaCalendarFetcher;
  private readonly eventWatcher: PassiveEventWatcherService | undefined;
  private readonly notificationSink: NotificationSink;
  private readonly now: () => Date;
  private reminders: readonly ConditionalReminderRecord[];

  constructor(
    filePath: string,
    options: {
      readonly stateCache: HaStateCache;
      readonly calendarFetcher: HaCalendarFetcher;
      readonly eventWatcher?: PassiveEventWatcherService;
      readonly notificationSink: NotificationSink;
      readonly now?: () => Date;
    },
  ) {
    this.filePath = filePath;
    this.stateCache = options.stateCache;
    this.calendarFetcher = options.calendarFetcher;
    this.eventWatcher = options.eventWatcher;
    this.notificationSink = options.notificationSink;
    this.now = options.now ?? (() => new Date());
    this.reminders = readReminderFile(filePath);
  }

  async createCalendarStartReminder(request: { readonly eventQuery: string; readonly speakerName: string | null }): Promise<ConditionalReminderResult> {
    const event = await resolveReminderEvent(this.calendarFetcher, this.stateCache, request.eventQuery, this.now());
    if (!event) {
      return {
        status: "declined",
        text: "I couldn't find a matching upcoming calendar event to arm that watch.",
        notes: `conditional reminder event not found: ${request.eventQuery}`,
      };
    }
    if (Date.parse(event.start) <= this.now().getTime()) {
      return {
        status: "declined",
        text: `${event.summary} has already started, so I won't arm that watch.`,
        notes: `conditional reminder event already started: ${event.summary}`,
      };
    }
    const existing = this.findCalendarDuplicate("calendar_start", event, request.speakerName);
    if (existing) {
      return {
        status: "ok",
        text: `That watch is already armed for ${event.summary}.`,
        notes: `conditional reminder duplicate reused: ${existing.id}`,
      };
    }
    const record = this.createCalendarRecord("calendar_start", event, request.speakerName, null);
    return {
      status: "ok",
      text: `Okay. I'll remind you when ${event.summary} starts.`,
      notes: `conditional reminder armed: ${record.id}`,
    };
  }

  async createRainBeforeEventReminder(request: { readonly eventQuery: string; readonly speakerName: string | null }): Promise<ConditionalReminderResult> {
    const event = await resolveReminderEvent(this.calendarFetcher, this.stateCache, request.eventQuery, this.now());
    if (!event) {
      return {
        status: "declined",
        text: "I couldn't find a matching upcoming calendar event to attach that rain watch to.",
        notes: `conditional reminder rain event not found: ${request.eventQuery}`,
      };
    }
    if (Date.parse(event.start) <= this.now().getTime()) {
      return {
        status: "declined",
        text: `${event.summary} has already started, so that rain watch would be stale.`,
        notes: `conditional reminder rain event already started: ${event.summary}`,
      };
    }
    const weatherEntity = defaultWeatherEntity(this.stateCache.entries());
    if (!weatherEntity) {
      return {
        status: "declined",
        text: "I can't see a live weather source to arm that rain watch.",
        notes: "conditional reminder weather source unavailable",
      };
    }
    if (weatherLooksRainy(weatherEntity)) {
      return {
        status: "declined",
        text: `It's already raining now, so I won't arm a before-${event.summary} rain watch.`,
        notes: `conditional reminder rain already active for ${weatherEntity.entityId}`,
      };
    }
    const existing = this.findCalendarDuplicate("rain_before_event", event, request.speakerName);
    if (existing) {
      return {
        status: "ok",
        text: `That rain watch is already armed for ${event.summary}.`,
        notes: `conditional reminder rain duplicate reused: ${existing.id}`,
      };
    }
    const record = this.createCalendarRecord("rain_before_event", event, request.speakerName, weatherEntity.entityId);
    return {
      status: "ok",
      text: `Okay. I'll let you know if it starts raining before ${event.summary}.`,
      notes: `conditional reminder rain armed: ${record.id}`,
    };
  }

  async createRainStartReminder(request: { readonly speakerName: string | null }): Promise<ConditionalReminderResult> {
    const weatherEntity = defaultWeatherEntity(this.stateCache.entries());
    if (!weatherEntity) {
      return {
        status: "declined",
        text: "I can't see a live weather source to arm that rain watch.",
        notes: "conditional reminder rain-start weather source unavailable",
      };
    }
    if (weatherLooksRainy(weatherEntity)) {
      return {
        status: "declined",
        text: "It's already raining now, so I won't arm a rain watch that's already true.",
        notes: `conditional reminder rain-start already active for ${weatherEntity.entityId}`,
      };
    }
    const existing = this.findStateDuplicate("rain_start", { weatherEntityId: weatherEntity.entityId, speakerName: request.speakerName });
    if (existing) {
      return {
        status: "ok",
        text: "That rain watch is already armed.",
        notes: `conditional reminder rain-start duplicate reused: ${existing.id}`,
      };
    }
    const record = this.createStateRecord("rain_start", {
      speakerName: request.speakerName,
      weatherEntityId: weatherEntity.entityId,
    });
    return {
      status: "ok",
      text: "Okay. I'll let you know when it starts raining.",
      notes: `conditional reminder rain-start armed: ${record.id}`,
    };
  }

  async createPersonArrivedReminder(request: { readonly personId: string; readonly personName: string; readonly speakerName: string | null }): Promise<ConditionalReminderResult> {
    const state = this.stateCache.get(request.personId);
    if (state && personPresent(state.state)) {
      return {
        status: "declined",
        text: `${request.personName} is already home, so that watch is already satisfied.`,
        notes: `conditional reminder person-arrived already true: ${request.personId}`,
      };
    }
    const existing = this.findStateDuplicate("person_arrived", {
      personId: request.personId,
      speakerName: request.speakerName,
    });
    if (existing) {
      return {
        status: "ok",
        text: `That ${request.personName} arrival watch is already armed.`,
        notes: `conditional reminder person-arrived duplicate reused: ${existing.id}`,
      };
    }
    const record = this.createStateRecord("person_arrived", {
      speakerName: request.speakerName,
      personId: request.personId,
      personName: request.personName,
    });
    return {
      status: "ok",
      text: `Okay. I'll let you know when ${request.personName} gets home.`,
      notes: `conditional reminder person-arrived armed: ${record.id}`,
    };
  }

  async createPersonDepartedReminder(request: { readonly personId: string; readonly personName: string; readonly speakerName: string | null }): Promise<ConditionalReminderResult> {
    const state = this.stateCache.get(request.personId);
    if (state && !personPresent(state.state)) {
      return {
        status: "declined",
        text: `${request.personName} is already away, so that watch is already satisfied.`,
        notes: `conditional reminder person-departed already true: ${request.personId}`,
      };
    }
    const existing = this.findStateDuplicate("person_departed", {
      personId: request.personId,
      speakerName: request.speakerName,
    });
    if (existing) {
      return {
        status: "ok",
        text: `That ${request.personName} departure watch is already armed.`,
        notes: `conditional reminder person-departed duplicate reused: ${existing.id}`,
      };
    }
    const record = this.createStateRecord("person_departed", {
      speakerName: request.speakerName,
      personId: request.personId,
      personName: request.personName,
    });
    return {
      status: "ok",
      text: `Okay. I'll let you know when ${request.personName} leaves.`,
      notes: `conditional reminder person-departed armed: ${record.id}`,
    };
  }

  async createOpeningOpenedReminder(request: { readonly entityId: string; readonly label: string; readonly speakerName: string | null }): Promise<ConditionalReminderResult> {
    const state = this.stateCache.get(request.entityId);
    if (state && openingOpen(state.state) === true) {
      return {
        status: "declined",
        text: `${request.label} is already open, so that watch is already satisfied.`,
        notes: `conditional reminder opening-opened already true: ${request.entityId}`,
      };
    }
    const existing = this.findStateDuplicate("opening_opened", {
      entityId: request.entityId,
      speakerName: request.speakerName,
    });
    if (existing) {
      return {
        status: "ok",
        text: `That ${request.label} open watch is already armed.`,
        notes: `conditional reminder opening-opened duplicate reused: ${existing.id}`,
      };
    }
    const record = this.createStateRecord("opening_opened", {
      speakerName: request.speakerName,
      entityId: request.entityId,
      label: request.label,
    });
    return {
      status: "ok",
      text: `Okay. I'll let you know when ${openingLabelForSpeech(request.label)} opens.`,
      notes: `conditional reminder opening-opened armed: ${record.id}`,
    };
  }

  async createOpeningClosedReminder(request: { readonly entityId: string; readonly label: string; readonly speakerName: string | null }): Promise<ConditionalReminderResult> {
    const state = this.stateCache.get(request.entityId);
    if (state && openingOpen(state.state) === false) {
      return {
        status: "declined",
        text: `${request.label} is already closed, so that watch is already satisfied.`,
        notes: `conditional reminder opening-closed already true: ${request.entityId}`,
      };
    }
    const existing = this.findStateDuplicate("opening_closed", {
      entityId: request.entityId,
      speakerName: request.speakerName,
    });
    if (existing) {
      return {
        status: "ok",
        text: `That ${request.label} closed watch is already armed.`,
        notes: `conditional reminder opening-closed duplicate reused: ${existing.id}`,
      };
    }
    const record = this.createStateRecord("opening_closed", {
      speakerName: request.speakerName,
      entityId: request.entityId,
      label: request.label,
    });
    return {
      status: "ok",
      text: `Okay. I'll let you know when ${openingLabelForSpeech(request.label)} closes.`,
      notes: `conditional reminder opening-closed armed: ${record.id}`,
    };
  }

  async evaluateDueReminders(): Promise<void> {
    const now = this.now();
    const recentEvents = this.eventWatcher?.recentEvents(50) ?? [];
    for (const reminder of this.reminders) {
      if (reminder.status !== "active") {
        continue;
      }
      if (reminder.kind === "calendar_start") {
        if (reminder.eventStart && Date.parse(reminder.eventStart) <= now.getTime()) {
          await this.triggerReminder(reminder, `Reminder: ${reminder.eventSummary ?? "event"}`, `${reminder.eventSummary ?? "That event"} is starting now.`);
        }
        continue;
      }
      if (reminder.kind === "rain_before_event") {
        if (!reminder.eventStart || Date.parse(reminder.eventStart) <= now.getTime()) {
          this.updateReminder(reminder.id, { status: "expired" });
          continue;
        }
        const weatherEntity = reminder.weatherEntityId ? this.stateCache.get(reminder.weatherEntityId) : null;
        if (weatherEntity && weatherLooksRainy(weatherEntity)) {
          await this.triggerReminder(
            reminder,
            `Rain before ${reminder.eventSummary ?? "that event"}`,
            `It has started raining before ${reminder.eventSummary ?? "that event"}.`,
          );
        }
        continue;
      }
      const matchingEvent = findMatchingWatcherEvent(reminder, recentEvents);
      if (!matchingEvent) {
        continue;
      }
      const notification = watcherNotification(reminder);
      await this.triggerReminder(reminder, notification.title, notification.message);
    }
  }

  listReminders(speakerName: string | null = null): readonly ConditionalReminderRecord[] {
    return this.reminders.filter((reminder) => !speakerName || !reminder.speakerName || reminder.speakerName === speakerName);
  }

  private createCalendarRecord(
    kind: "calendar_start" | "rain_before_event",
    event: HaCalendarEvent,
    speakerName: string | null,
    weatherEntityId: string | null,
  ): ConditionalReminderRecord {
    const now = this.now();
    const record: ConditionalReminderRecord = {
      id: reminderId(now),
      kind,
      createdAt: now.toISOString(),
      speakerName,
      eventSummary: event.summary,
      eventStart: event.start,
      calendarEntityId: event.entityId,
      weatherEntityId,
      personId: null,
      personName: null,
      entityId: null,
      label: null,
      status: "active",
      triggeredAt: null,
    };
    this.reminders = [...this.reminders, record];
    this.write();
    return record;
  }

  private createStateRecord(
    kind: Exclude<ConditionalReminderKind, "calendar_start" | "rain_before_event">,
    options: {
      readonly speakerName: string | null;
      readonly weatherEntityId?: string | null;
      readonly personId?: string | null;
      readonly personName?: string | null;
      readonly entityId?: string | null;
      readonly label?: string | null;
    },
  ): ConditionalReminderRecord {
    const now = this.now();
    const record: ConditionalReminderRecord = {
      id: reminderId(now),
      kind,
      createdAt: now.toISOString(),
      speakerName: options.speakerName,
      eventSummary: null,
      eventStart: null,
      calendarEntityId: null,
      weatherEntityId: options.weatherEntityId ?? null,
      personId: options.personId ?? null,
      personName: options.personName ?? null,
      entityId: options.entityId ?? null,
      label: options.label ?? null,
      status: "active",
      triggeredAt: null,
    };
    this.reminders = [...this.reminders, record];
    this.write();
    return record;
  }

  private findCalendarDuplicate(
    kind: "calendar_start" | "rain_before_event",
    event: HaCalendarEvent,
    speakerName: string | null,
  ): ConditionalReminderRecord | null {
    return this.reminders.find((reminder) =>
      reminder.status === "active"
      && reminder.kind === kind
      && reminder.eventSummary === event.summary
      && reminder.eventStart === event.start
      && reminder.speakerName === speakerName,
    ) ?? null;
  }

  private findStateDuplicate(
    kind: Exclude<ConditionalReminderKind, "calendar_start" | "rain_before_event">,
    options: {
      readonly speakerName: string | null;
      readonly weatherEntityId?: string;
      readonly personId?: string;
      readonly entityId?: string;
    },
  ): ConditionalReminderRecord | null {
    return this.reminders.find((reminder) =>
      reminder.status === "active"
      && reminder.kind === kind
      && reminder.speakerName === options.speakerName
      && (options.weatherEntityId === undefined || reminder.weatherEntityId === options.weatherEntityId)
      && (options.personId === undefined || reminder.personId === options.personId)
      && (options.entityId === undefined || reminder.entityId === options.entityId),
    ) ?? null;
  }

  private async triggerReminder(reminder: ConditionalReminderRecord, title: string, message: string): Promise<void> {
    await this.notificationSink.createNotification({
      id: reminder.id,
      title,
      message,
    });
    this.updateReminder(reminder.id, {
      status: "triggered",
      triggeredAt: this.now().toISOString(),
    });
  }

  private updateReminder(id: string, updates: Partial<ConditionalReminderRecord>): void {
    this.reminders = this.reminders.map((reminder) => reminder.id === id ? { ...reminder, ...updates } : reminder);
    this.write();
  }

  private write(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify({ reminders: this.reminders }, null, 2)}\n`);
  }
}

export class HaPersistentNotificationSink implements NotificationSink {
  private readonly client: HaCommandClient;

  constructor(client: HaCommandClient) {
    this.client = client;
  }

  async createNotification(request: { readonly id: string; readonly title: string; readonly message: string }): Promise<void> {
    await this.client.sendCommand({
      type: "call_service",
      domain: "persistent_notification",
      service: "create",
      service_data: {
        notification_id: request.id,
        title: request.title,
        message: request.message,
      },
    });
  }
}

async function resolveReminderEvent(
  calendarFetcher: HaCalendarFetcher,
  stateCache: HaStateCache,
  query: string,
  now: Date,
): Promise<HaCalendarEvent | null> {
  const calendars = reminderCalendars(stateCache.entries());
  if (calendars.length === 0) {
    return null;
  }
  const events = await calendarFetcher.fetchEvents({
    entityIds: calendars.map((state) => state.entityId),
    start: now.toISOString(),
    end: new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    calendarNames: Object.fromEntries(calendars.map((state) => [state.entityId, friendlyName(state)])),
  });
  const normalizedQuery = normalize(query);
  const scored = events
    .map((event) => ({ event, score: reminderEventScore(event, normalizedQuery) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.event.start.localeCompare(right.event.start));
  return scored[0]?.event ?? null;
}

function reminderCalendars(states: readonly HaEntityState[]): readonly HaEntityState[] {
  const calendars = states.filter((state) => state.entityId.startsWith("calendar."));
  const personal = calendars.filter((state) => isPersonalCalendarText(`${state.entityId} ${friendlyName(state)}`));
  return (personal.length > 0 ? personal : calendars).sort((left, right) => friendlyName(left).localeCompare(friendlyName(right)));
}

function reminderEventScore(event: HaCalendarEvent, normalizedQuery: string): number {
  const summary = normalize(event.summary);
  if (!summary || !normalizedQuery) {
    return 0;
  }
  if (summary === normalizedQuery) {
    return 100;
  }
  if (summary.includes(normalizedQuery) || normalizedQuery.includes(summary)) {
    return 80;
  }
  const queryTokens = meaningfulTokens(normalizedQuery);
  const summaryTokens = new Set(meaningfulTokens(summary));
  const overlap = queryTokens.filter((token) => summaryTokens.has(token)).length;
  if (overlap === 0) {
    return 0;
  }
  return overlap * 10 + (summary.startsWith(queryTokens[0] ?? "") ? 3 : 0);
}

function meaningfulTokens(value: string): readonly string[] {
  return value.split(" ").filter((token) => token.length >= 3 && !["the", "and", "for", "with", "before", "after", "starts", "start"].includes(token));
}

function defaultWeatherEntity(states: readonly HaEntityState[]): HaEntityState | null {
  return states
    .filter((state) => state.entityId.startsWith("weather."))
    .sort((left, right) => left.entityId.localeCompare(right.entityId))[0] ?? null;
}

function weatherLooksRainy(state: HaEntityState): boolean {
  const normalizedState = normalize(state.state);
  if (RAINY_WEATHER_STATES.has(normalizedState)) {
    return true;
  }
  return /\b(rain|shower|storm|drizzle)\b/.test(normalizedState);
}

function findMatchingWatcherEvent(
  reminder: ConditionalReminderRecord,
  recentEvents: readonly PassiveWatcherEvent[],
): PassiveWatcherEvent | null {
  const createdAtMs = Date.parse(reminder.createdAt);
  return recentEvents.find((event) => {
    const detectedAtMs = Date.parse(event.detectedAt);
    if (!Number.isFinite(createdAtMs) || !Number.isFinite(detectedAtMs) || detectedAtMs < createdAtMs) {
      return false;
    }
    switch (reminder.kind) {
      case "rain_start":
        return event.kind === "rain_start" && event.entityId === reminder.weatherEntityId;
      case "person_arrived":
      case "person_departed":
        return event.kind === reminder.kind && event.personId === reminder.personId;
      case "opening_opened":
      case "opening_closed":
        return event.kind === reminder.kind && event.entityId === reminder.entityId;
      default:
        return false;
    }
  }) ?? null;
}

function watcherNotification(reminder: ConditionalReminderRecord): { readonly title: string; readonly message: string } {
  switch (reminder.kind) {
    case "rain_start":
      return {
        title: "Rain started",
        message: "It has started raining.",
      };
    case "person_arrived":
      return {
        title: `${reminder.personName ?? "That person"} got home`,
        message: `${reminder.personName ?? "That person"} got home.`,
      };
    case "person_departed":
      return {
        title: `${reminder.personName ?? "That person"} left`,
        message: `${reminder.personName ?? "That person"} left the house.`,
      };
    case "opening_opened":
      return {
        title: `${reminder.label ?? "That opening"} opened`,
        message: `${reminder.label ?? "That opening"} opened.`,
      };
    case "opening_closed":
      return {
        title: `${reminder.label ?? "That opening"} closed`,
        message: `${reminder.label ?? "That opening"} closed.`,
      };
    default:
      throw new Error(`unsupported watcher reminder kind: ${reminder.kind}`);
  }
}

function readReminderFile(filePath: string): readonly ConditionalReminderRecord[] {
  if (!existsSync(filePath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as ConditionalReminderFile;
    const rows = Array.isArray(parsed.reminders) ? parsed.reminders : [];
    return rows.map(parseReminderRecord).filter((row): row is ConditionalReminderRecord => row !== null);
  } catch {
    return [];
  }
}

function parseReminderRecord(value: unknown): ConditionalReminderRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const input = value as Record<string, unknown>;
  const id = optionalString(input.id);
  const kind = reminderKindValue(input.kind);
  const createdAt = optionalString(input.createdAt);
  const status = reminderStatusValue(input.status);
  if (!id || !kind || !createdAt || !status) {
    return null;
  }
  return {
    id,
    kind,
    createdAt,
    speakerName: optionalString(input.speakerName),
    eventSummary: optionalString(input.eventSummary),
    eventStart: optionalString(input.eventStart),
    calendarEntityId: optionalString(input.calendarEntityId),
    weatherEntityId: optionalString(input.weatherEntityId),
    personId: optionalString(input.personId),
    personName: optionalString(input.personName),
    entityId: optionalString(input.entityId),
    label: optionalString(input.label),
    status,
    triggeredAt: optionalString(input.triggeredAt),
  };
}

function reminderKindValue(value: unknown): ConditionalReminderKind | null {
  return value === "calendar_start"
    || value === "rain_before_event"
    || value === "rain_start"
    || value === "person_arrived"
    || value === "person_departed"
    || value === "opening_opened"
    || value === "opening_closed"
    ? value
    : null;
}

function reminderStatusValue(value: unknown): ConditionalReminderStatus | null {
  return value === "active" || value === "triggered" || value === "expired" || value === "cancelled" ? value : null;
}

function openingLabelForSpeech(label: string): string {
  const trimmed = label.trim();
  if (/^(?:the|my|our)\b/i.test(trimmed)) {
    return trimmed;
  }
  return `the ${trimmed}`;
}

function reminderId(now: Date): string {
  return `conditional-reminder-${now.toISOString().replaceAll(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalize(value: string): string {
  return normalizeSpeechForRouting(value, { preserveEntityChars: true })
    .replace(householdRegex(String.raw`\b(?:hey\s+{ASSISTANT}|{ASSISTANT}|please|just|can you|could you|would you)\b`, "g"), " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
