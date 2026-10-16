import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AppConfig } from "./config.js";
import type { HaCalendarEvent, HaCalendarFetcher } from "./ha-calendar.js";
import type { HaEntityState, HaStateCache } from "./ha-state-cache.js";
import { friendlyName, openingOpen, personPresent } from "./ha-state-cache.js";
import { houseConfig } from "./house-config.js";

const OPENING_DEVICE_CLASSES = new Set(["door", "garage_door", "window", "opening"]);
const RAINY_WEATHER_STATES = new Set(["rainy", "pouring", "lightning-rainy", "snowy-rainy"]);
const RECENT_EVENT_LIMIT = 200;
const RECENT_EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface PassiveStateChangeObservation {
  readonly entityId: string;
  readonly fromState: string | null;
  readonly toState: string | null;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly observedAt: string;
}

export type PassiveWatcherEventKind =
  | "calendar_start"
  | "rain_start"
  | "person_arrived"
  | "person_departed"
  | "opening_opened"
  | "opening_closed";

export type PassiveWatcherEvent =
  | {
    readonly id: string;
    readonly kind: "calendar_start";
    readonly detectedAt: string;
    readonly source: "ha_calendar";
    readonly calendarEntityId: string;
    readonly calendarName: string | null;
    readonly eventSummary: string;
    readonly eventStart: string;
  }
  | {
    readonly id: string;
    readonly kind: "rain_start";
    readonly detectedAt: string;
    readonly source: "ha_state";
    readonly entityId: string;
    readonly label: string;
    readonly fromState: string;
    readonly toState: string;
  }
  | {
    readonly id: string;
    readonly kind: "person_arrived" | "person_departed";
    readonly detectedAt: string;
    readonly source: "ha_state";
    readonly personId: string;
    readonly personName: string;
    readonly fromState: string;
    readonly toState: string;
  }
  | {
    readonly id: string;
    readonly kind: "opening_opened" | "opening_closed";
    readonly detectedAt: string;
    readonly source: "ha_state";
    readonly entityId: string;
    readonly label: string;
    readonly fromState: string;
    readonly toState: string;
  };

export interface PassiveEventWatcherSnapshot {
  readonly revision: number;
  readonly lastEvaluatedAt: string | null;
  readonly watchedEntityCount: number;
  readonly recentEvents: readonly PassiveWatcherEvent[];
}

export interface PassiveEventWatcherService {
  evaluateNow(): Promise<readonly PassiveWatcherEvent[]>;
  observeStateChange?(change: PassiveStateChangeObservation): void;
  recentEvents(limit?: number): readonly PassiveWatcherEvent[];
  snapshot(): PassiveEventWatcherSnapshot;
}

interface EventWatcherFile {
  readonly schemaVersion?: unknown;
  readonly revision?: unknown;
  readonly lastEvaluatedAt?: unknown;
  readonly lastCalendarEvaluatedAt?: unknown;
  readonly entityStates?: unknown;
  readonly recentEvents?: readonly unknown[];
}

interface StoredWatcherState {
  revision: number;
  lastEvaluatedAt: string | null;
  lastCalendarEvaluatedAt: string | null;
  entityStates: Record<string, string>;
  recentEvents: PassiveWatcherEvent[];
}

interface WatchedEntitySnapshot {
  readonly entityId: string;
  readonly label: string;
  readonly rawState: string;
  readonly kind: "person" | "opening" | "weather";
}

export function eventWatcherStorePath(config: Pick<AppConfig, "dataDir">): string {
  return join(config.dataDir, "event-watchers.json");
}

export class PersistentPassiveEventWatcherService implements PassiveEventWatcherService {
  private readonly filePath: string;
  private readonly stateCache: HaStateCache;
  private readonly calendarFetcher: HaCalendarFetcher | undefined;
  private readonly now: () => Date;
  private state: StoredWatcherState;

  constructor(
    filePath: string,
    options: {
      readonly stateCache: HaStateCache;
      readonly calendarFetcher?: HaCalendarFetcher;
      readonly now?: () => Date;
    },
  ) {
    this.filePath = filePath;
    this.stateCache = options.stateCache;
    this.calendarFetcher = options.calendarFetcher;
    this.now = options.now ?? (() => new Date());
    this.state = readWatcherState(filePath);
  }

  async evaluateNow(): Promise<readonly PassiveWatcherEvent[]> {
    const calendarThrough = this.now();
    const calendarEvents = await this.detectCalendarEvents(
      this.state.lastCalendarEvaluatedAt,
      calendarThrough,
    );
    // Read current state only after the await. Any websocket observations that
    // arrived during the calendar fetch have already advanced this.state, so
    // this commit merges them instead of reverting their watermark/events.
    const committedAt = this.now();
    const currentEntities = watchedEntities(this.stateCache.entries());
    const stateEvents = detectStateEvents(
      currentEntities,
      this.state.entityStates,
      committedAt,
    );
    const detected = [...stateEvents, ...calendarEvents];
    this.state = nextWatcherState(this.state, {
      lastEvaluatedAt: committedAt.toISOString(),
      lastCalendarEvaluatedAt: calendarThrough.toISOString(),
      entityStates: Object.fromEntries(currentEntities.map((entity) => [entity.entityId, entity.rawState])),
      recentEvents: retainedRecentEvents(
        [...this.state.recentEvents, ...detected],
        committedAt,
      ),
    });
    writeWatcherState(this.filePath, this.state);
    return detected;
  }

  observeStateChange(change: PassiveStateChangeObservation): void {
    const detectedAt = new Date(change.observedAt);
    if (
      !Number.isFinite(detectedAt.getTime())
      || change.fromState === null
      || change.toState === null
      || change.fromState === change.toState
    ) {
      return;
    }
    const entity = watchedEntityFromObservation(change);
    if (!entity) {
      return;
    }
    const detected = detectStateEvents(
      [entity],
      { [entity.entityId]: change.fromState },
      detectedAt,
    );
    this.state = nextWatcherState(this.state, {
      lastEvaluatedAt: detectedAt.toISOString(),
      lastCalendarEvaluatedAt: this.state.lastCalendarEvaluatedAt,
      entityStates: {
        ...this.state.entityStates,
        [entity.entityId]: change.toState,
      },
      recentEvents: retainedRecentEvents(
        [...this.state.recentEvents, ...detected],
        detectedAt,
      ),
    });
    writeWatcherState(this.filePath, this.state);
  }

  recentEvents(limit: number = 20): readonly PassiveWatcherEvent[] {
    const bounded = Math.max(0, limit);
    return [...this.state.recentEvents].slice(-bounded).reverse();
  }

  snapshot(): PassiveEventWatcherSnapshot {
    return {
      revision: this.state.revision,
      lastEvaluatedAt: this.state.lastEvaluatedAt,
      watchedEntityCount: Object.keys(this.state.entityStates).length,
      recentEvents: this.recentEvents(),
    };
  }

  private async detectCalendarEvents(
    previous: string | null,
    now: Date,
  ): Promise<readonly PassiveWatcherEvent[]> {
    if (!previous || !this.calendarFetcher) {
      return [];
    }
    // A calendar that isn't answering (its integration down) is left out, not the whole check.
    const calendarStates = this.stateCache.entries().filter((state) => (
      state.entityId.startsWith("calendar.") && state.state !== "unavailable" && state.state !== "unknown"
    ));
    if (calendarStates.length === 0) {
      return [];
    }
    const previousMs = Date.parse(previous);
    if (!Number.isFinite(previousMs)) {
      return [];
    }
    const nowIso = now.toISOString();
    const calendarNames = Object.fromEntries(calendarStates.map((state) => [state.entityId, friendlyName(state)]));
    const fetcher = this.calendarFetcher;
    const fetch = (entityIds: readonly string[]) => fetcher.fetchEvents({ entityIds, start: previous, end: nowIso, calendarNames });
    let events: Awaited<ReturnType<typeof fetch>>;
    try {
      events = await fetch(calendarStates.map((state) => state.entityId));
    } catch {
      // HA can still drop one from a joint answer: ask each on its own and keep the ones that answer.
      const each = await Promise.allSettled(calendarStates.map((state) => fetch([state.entityId])));
      events = each.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    }
    return events
      .filter((event) => calendarEventStartedWithinWindow(event, previousMs, now.getTime()))
      .map((event) => ({
        id: eventId("calendar_start", `${event.entityId}:${event.start}:${event.summary}`),
        kind: "calendar_start",
        detectedAt: nowIso,
        source: "ha_calendar",
        calendarEntityId: event.entityId,
        calendarName: event.calendarName,
        eventSummary: event.summary,
        eventStart: event.start,
      }));
  }
}

function watchedEntityFromObservation(
  change: PassiveStateChangeObservation,
): WatchedEntitySnapshot | null {
  const label = typeof change.attributes.friendly_name === "string"
    && change.attributes.friendly_name.trim()
    ? change.attributes.friendly_name.trim()
    : change.entityId;
  if (change.entityId.startsWith("person.")) {
    return {
      entityId: change.entityId,
      label,
      rawState: change.toState ?? "",
      kind: "person",
    };
  }
  const deviceClass = typeof change.attributes.device_class === "string"
    ? change.attributes.device_class.trim().toLowerCase()
    : "";
  if (
    change.entityId.startsWith("binary_sensor.")
    && OPENING_DEVICE_CLASSES.has(deviceClass)
  ) {
    return {
      entityId: change.entityId,
      label,
      rawState: change.toState ?? "",
      kind: "opening",
    };
  }
  if (change.entityId.startsWith("weather.")) {
    return {
      entityId: change.entityId,
      label,
      rawState: change.toState ?? "",
      kind: "weather",
    };
  }
  return null;
}

function retainedRecentEvents(
  events: readonly PassiveWatcherEvent[],
  now: Date,
): PassiveWatcherEvent[] {
  const oldestMs = now.getTime() - RECENT_EVENT_MAX_AGE_MS;
  return events
    .filter((event) => {
      const detectedAtMs = Date.parse(event.detectedAt);
      return Number.isFinite(detectedAtMs)
        && detectedAtMs >= oldestMs
        && detectedAtMs <= now.getTime() + 5_000;
    })
    .slice(-RECENT_EVENT_LIMIT);
}

function detectStateEvents(
  currentEntities: readonly WatchedEntitySnapshot[],
  previousStates: Readonly<Record<string, string>>,
  now: Date,
): readonly PassiveWatcherEvent[] {
  const detected: PassiveWatcherEvent[] = [];
  for (const entity of currentEntities) {
    const previous = previousStates[entity.entityId];
    if (previous === undefined || previous === entity.rawState) {
      continue;
    }
    if (entity.kind === "person") {
      const kind = personTransition(previous, entity.rawState);
      if (kind) {
        detected.push({
          id: eventId(kind, `${entity.entityId}:${now.toISOString()}`),
          kind,
          detectedAt: now.toISOString(),
          source: "ha_state",
          personId: entity.entityId,
          personName: entity.label,
          fromState: previous,
          toState: entity.rawState,
        });
      }
      continue;
    }
    if (entity.kind === "opening") {
      const kind = openingTransition(previous, entity.rawState);
      if (kind) {
        detected.push({
          id: eventId(kind, `${entity.entityId}:${now.toISOString()}`),
          kind,
          detectedAt: now.toISOString(),
          source: "ha_state",
          entityId: entity.entityId,
          label: entity.label,
          fromState: previous,
          toState: entity.rawState,
        });
      }
      continue;
    }
    if (entity.kind === "weather" && !weatherLooksRainy(previous) && weatherLooksRainy(entity.rawState)) {
      detected.push({
        id: eventId("rain_start", `${entity.entityId}:${now.toISOString()}`),
        kind: "rain_start",
        detectedAt: now.toISOString(),
        source: "ha_state",
        entityId: entity.entityId,
        label: entity.label,
        fromState: previous,
        toState: entity.rawState,
      });
    }
  }
  return detected;
}

function watchedEntities(states: readonly HaEntityState[]): readonly WatchedEntitySnapshot[] {
  const entities: WatchedEntitySnapshot[] = [];
  for (const state of states) {
    if (state.entityId.startsWith("person.")) {
      entities.push({
        entityId: state.entityId,
        label: friendlyName(state),
        rawState: state.state,
        kind: "person",
      });
      continue;
    }
    if (state.entityId.startsWith("binary_sensor.") && openingDeviceClass(state)) {
      entities.push({
        entityId: state.entityId,
        label: friendlyName(state),
        rawState: state.state,
        kind: "opening",
      });
    }
  }

  const weather = currentWeatherState(states);
  if (weather) {
    entities.push({
      entityId: weather.entityId,
      label: friendlyName(weather),
      rawState: weather.state,
      kind: "weather",
    });
  }
  return entities.sort((left, right) => left.entityId.localeCompare(right.entityId));
}

function currentWeatherState(states: readonly HaEntityState[]): HaEntityState | null {
  const weatherStates = states.filter((state) => state.entityId.startsWith("weather."));
  return weatherStates.find((state) => state.entityId === houseConfig().weather.entity)
    ?? weatherStates.find((state) => state.entityId === "weather.home")
    ?? weatherStates.find((state) => !/\bhourly\b/i.test(friendlyName(state)))
    ?? weatherStates[0]
    ?? null;
}

function openingDeviceClass(state: HaEntityState): boolean {
  const value = state.attributes.device_class;
  return typeof value === "string" && OPENING_DEVICE_CLASSES.has(value.trim().toLowerCase());
}

function personTransition(previous: string, current: string): "person_arrived" | "person_departed" | null {
  const wasPresent = personPresent(previous);
  const isPresent = personPresent(current);
  if (!wasPresent && isPresent) {
    return "person_arrived";
  }
  if (wasPresent && !isPresent) {
    return "person_departed";
  }
  return null;
}

function openingTransition(previous: string, current: string): "opening_opened" | "opening_closed" | null {
  const previousOpen = openingOpen(previous);
  const currentOpen = openingOpen(current);
  if (previousOpen === null || currentOpen === null || previousOpen === currentOpen) {
    return null;
  }
  return currentOpen ? "opening_opened" : "opening_closed";
}

function weatherLooksRainy(rawState: string): boolean {
  return RAINY_WEATHER_STATES.has(rawState.trim().toLowerCase());
}

function calendarEventStartedWithinWindow(event: HaCalendarEvent, previousMs: number, nowMs: number): boolean {
  const startMs = Date.parse(event.start);
  return Number.isFinite(startMs) && startMs > previousMs && startMs <= nowMs;
}

function eventId(kind: PassiveWatcherEventKind, source: string): string {
  return `watcher-${kind}-${source.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function readWatcherState(filePath: string): StoredWatcherState {
  if (!existsSync(filePath)) {
    return {
      revision: 0,
      lastEvaluatedAt: null,
      lastCalendarEvaluatedAt: null,
      entityStates: {},
      recentEvents: [],
    };
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as EventWatcherFile;
    return {
      revision: nonNegativeSafeInteger(raw.revision) ?? 0,
      lastEvaluatedAt: typeof raw.lastEvaluatedAt === "string" && raw.lastEvaluatedAt.trim() ? raw.lastEvaluatedAt : null,
      lastCalendarEvaluatedAt: typeof raw.lastCalendarEvaluatedAt === "string"
        && raw.lastCalendarEvaluatedAt.trim()
        ? raw.lastCalendarEvaluatedAt
        : typeof raw.lastEvaluatedAt === "string" && raw.lastEvaluatedAt.trim()
          ? raw.lastEvaluatedAt
          : null,
      entityStates: parseEntityStates(raw.entityStates),
      recentEvents: parseRecentEvents(raw.recentEvents),
    };
  } catch {
    return {
      revision: 0,
      lastEvaluatedAt: null,
      lastCalendarEvaluatedAt: null,
      entityStates: {},
      recentEvents: [],
    };
  }
}

function parseEntityStates(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string"),
  );
}

function parseRecentEvents(value: readonly unknown[] | undefined): PassiveWatcherEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const event = parseRecentEvent(entry);
    return event ? [event] : [];
  });
}

function parseRecentEvent(value: unknown): PassiveWatcherEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const event = value as Record<string, unknown>;
  const kind = typeof event.kind === "string" ? event.kind : null;
  const id = typeof event.id === "string" ? event.id : null;
  const detectedAt = typeof event.detectedAt === "string" ? event.detectedAt : null;
  const source = event.source;
  if (!kind || !id || !detectedAt) {
    return null;
  }
  if (kind === "calendar_start" && source === "ha_calendar" && typeof event.calendarEntityId === "string" && typeof event.eventSummary === "string" && typeof event.eventStart === "string") {
    return {
      id,
      kind,
      detectedAt,
      source,
      calendarEntityId: event.calendarEntityId,
      calendarName: typeof event.calendarName === "string" ? event.calendarName : null,
      eventSummary: event.eventSummary,
      eventStart: event.eventStart,
    };
  }
  if (kind === "rain_start" && source === "ha_state" && typeof event.entityId === "string" && typeof event.label === "string" && typeof event.fromState === "string" && typeof event.toState === "string") {
    return {
      id,
      kind,
      detectedAt,
      source,
      entityId: event.entityId,
      label: event.label,
      fromState: event.fromState,
      toState: event.toState,
    };
  }
  if ((kind === "person_arrived" || kind === "person_departed") && source === "ha_state" && typeof event.personId === "string" && typeof event.personName === "string" && typeof event.fromState === "string" && typeof event.toState === "string") {
    return {
      id,
      kind,
      detectedAt,
      source,
      personId: event.personId,
      personName: event.personName,
      fromState: event.fromState,
      toState: event.toState,
    };
  }
  if ((kind === "opening_opened" || kind === "opening_closed") && source === "ha_state" && typeof event.entityId === "string" && typeof event.label === "string" && typeof event.fromState === "string" && typeof event.toState === "string") {
    return {
      id,
      kind,
      detectedAt,
      source,
      entityId: event.entityId,
      label: event.label,
      fromState: event.fromState,
      toState: event.toState,
    };
  }
  return null;
}

function writeWatcherState(filePath: string, state: StoredWatcherState): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({
    schemaVersion: 2,
    revision: state.revision,
    lastEvaluatedAt: state.lastEvaluatedAt,
    lastCalendarEvaluatedAt: state.lastCalendarEvaluatedAt,
    entityStates: state.entityStates,
    recentEvents: state.recentEvents,
  }, null, 2)}\n`);
}

function nextWatcherState(
  previous: StoredWatcherState,
  next: Omit<StoredWatcherState, "revision">,
): StoredWatcherState {
  const changed = previous.lastEvaluatedAt !== next.lastEvaluatedAt
    || previous.lastCalendarEvaluatedAt !== next.lastCalendarEvaluatedAt
    || !sameStringRecord(previous.entityStates, next.entityStates)
    || JSON.stringify(previous.recentEvents) !== JSON.stringify(next.recentEvents);
  return {
    revision: changed ? previous.revision + 1 : previous.revision,
    ...next,
  };
}

function sameStringRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) =>
      key === rightKeys[index] && left[key] === right[key]);
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}
