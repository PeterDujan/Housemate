import type { HaCalendarFetcher } from "./ha-calendar.js";
import type { HaEntityState, HaStateCache } from "./ha-state-cache.js";
import type { HaWeatherForecastFetcher } from "./ha-weather-forecast.js";
import { silentHelperHours } from "./housemate-controls.js";
import { friendlyName } from "./ha-state-cache.js";
import { HOUSE_TIME_ZONE, houseConfig } from "./house-config.js";

export interface HouseStateWindowPolicy {
  readonly startHourLocal: number;
  readonly endHourLocal: number;
  readonly source: "runtime_policy" | "home_assistant_helper";
}

export interface HouseStatePolicy {
  readonly quietHours: HouseStateWindowPolicy | null;
  readonly bedtime: HouseStateWindowPolicy | null;
}

export interface HouseStateSourceSummary {
  readonly available: boolean;
  readonly entityCount: number;
  readonly entityIds: readonly string[];
}

export interface HouseStateWeatherSourceSummary extends HouseStateSourceSummary {
  readonly currentEntityId: string | null;
  readonly hourlyEntityId: string | null;
  readonly forecastFetcherAvailable: boolean;
}

export interface HouseStateCalendarSourceSummary extends HouseStateSourceSummary {
  readonly fetcherAvailable: boolean;
}

export interface HouseStatePresenceSourceSummary extends HouseStateSourceSummary {
  readonly presentPersonIds: readonly string[];
}

export type HouseStatePersonPresence = "home" | "away" | "zone" | "unknown";
export type HouseOccupancyMode = "occupied" | "empty" | "unknown";
export type HouseTimeMode = "awake" | "quiet_hours" | "bedtime";
export type HouseCompositeMode =
  | "active_occupied"
  | "quiet_occupied"
  | "settling_occupied"
  | "idle_empty"
  | "quiet_empty"
  | "night_empty"
  | "unresolved";

export interface HouseStatePersonSnapshot {
  readonly personId: string;
  readonly name: string;
  readonly rawState: string;
  readonly presence: HouseStatePersonPresence;
  readonly zoneName: string | null;
  readonly lastChanged: string;
}

export interface HouseStateActivitySnapshot {
  readonly localHour: number;
  readonly weekday: number;
  readonly weekend: boolean;
  readonly quietHoursActive: boolean;
  readonly bedtimeActive: boolean;
}

export interface HouseStateModesSnapshot {
  readonly occupancy: HouseOccupancyMode;
  readonly time: HouseTimeMode;
  readonly composite: HouseCompositeMode;
}

export interface HouseStatePresenceSnapshot {
  readonly people: readonly HouseStatePersonSnapshot[];
  readonly presentPersonIds: readonly string[];
  readonly awayPersonIds: readonly string[];
  readonly unknownPersonIds: readonly string[];
  readonly occupancy: HouseOccupancyMode;
}

export interface HouseStateSnapshot {
  readonly generatedAt: string;
  readonly timezone: string;
  readonly policy: HouseStatePolicy;
  readonly sources: {
    readonly presence: HouseStatePresenceSourceSummary;
    readonly calendar: HouseStateCalendarSourceSummary;
    readonly weather: HouseStateWeatherSourceSummary;
  };
  readonly presence: HouseStatePresenceSnapshot;
  readonly activity: HouseStateActivitySnapshot;
  readonly modes: HouseStateModesSnapshot;
}

export interface HouseStateProvider {
  snapshot(now?: Date): HouseStateSnapshot;
}

export interface HouseStateProviderOptions {
  readonly stateCache?: HaStateCache;
  readonly calendarFetcher?: HaCalendarFetcher;
  readonly weatherForecastFetcher?: HaWeatherForecastFetcher;
  readonly now?: () => Date;
  readonly timezone?: string;
  readonly policy?: Partial<HouseStatePolicy>;
}

export const DEFAULT_HOUSE_STATE_POLICY: HouseStatePolicy = {
  quietHours: { startHourLocal: 22, endHourLocal: 7, source: "runtime_policy" },
  bedtime: { startHourLocal: 21, endHourLocal: 23, source: "runtime_policy" },
};

const DEFAULT_TIMEZONE = HOUSE_TIME_ZONE;

export class RuntimeHouseStateProvider implements HouseStateProvider {
  private readonly stateCache: HaStateCache | undefined;
  private readonly calendarFetcher: HaCalendarFetcher | undefined;
  private readonly weatherForecastFetcher: HaWeatherForecastFetcher | undefined;
  private readonly now: () => Date;
  private readonly timezone: string;
  private readonly policy: HouseStatePolicy;

  constructor(options: HouseStateProviderOptions = {}) {
    this.stateCache = options.stateCache;
    this.calendarFetcher = options.calendarFetcher;
    this.weatherForecastFetcher = options.weatherForecastFetcher;
    this.now = options.now ?? (() => new Date());
    this.timezone = options.timezone ?? DEFAULT_TIMEZONE;
    this.policy = {
      quietHours: options.policy?.quietHours ?? DEFAULT_HOUSE_STATE_POLICY.quietHours,
      bedtime: options.policy?.bedtime ?? DEFAULT_HOUSE_STATE_POLICY.bedtime,
    };
  }

  snapshot(now: Date = this.now()): HouseStateSnapshot {
    const states = this.stateCache?.entries() ?? [];
    const people = peopleSnapshot(states);
    const presence = presenceSnapshot(people);
    const policy = this.currentPolicy();
    const activity = activitySnapshot(now, this.timezone, policy);
    return {
      generatedAt: now.toISOString(),
      timezone: this.timezone,
      policy,
      sources: {
        presence: presenceSourceSummary(people),
        calendar: calendarSourceSummary(states, this.calendarFetcher),
        weather: weatherSourceSummary(states, this.weatherForecastFetcher),
      },
      presence,
      activity,
      modes: {
        occupancy: presence.occupancy,
        time: activity.bedtimeActive ? "bedtime" : activity.quietHoursActive ? "quiet_hours" : "awake",
        composite: compositeMode(
          presence.occupancy,
          activity.bedtimeActive ? "bedtime" : activity.quietHoursActive ? "quiet_hours" : "awake",
        ),
      },
    };
  }

  private currentPolicy(): HouseStatePolicy {
    const helperHours = silentHelperHours(this.stateCache);
    if (!helperHours) return this.policy;
    return {
      ...this.policy,
      quietHours: { ...helperHours, source: "home_assistant_helper" },
    };
  }
}

function peopleSnapshot(states: readonly HaEntityState[]): readonly HouseStatePersonSnapshot[] {
  return states
    .filter((state) => state.entityId.startsWith("person."))
    .map((state) => ({
      personId: state.entityId,
      name: friendlyName(state),
      rawState: state.state,
      presence: personPresence(state.state),
      zoneName: personZoneName(state.state),
      lastChanged: state.lastChanged,
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.personId.localeCompare(right.personId));
}

function presenceSnapshot(people: readonly HouseStatePersonSnapshot[]): HouseStatePresenceSnapshot {
  const presentPersonIds = people.filter((person) => person.presence === "home").map((person) => person.personId);
  const awayPersonIds = people.filter((person) => person.presence === "away" || person.presence === "zone").map((person) => person.personId);
  const unknownPersonIds = people.filter((person) => person.presence === "unknown").map((person) => person.personId);
  return {
    people,
    presentPersonIds,
    awayPersonIds,
    unknownPersonIds,
    occupancy: occupancyMode(people),
  };
}

function presenceSourceSummary(people: readonly HouseStatePersonSnapshot[]): HouseStatePresenceSourceSummary {
  const presentPersonIds = people.filter((person) => person.presence === "home").map((person) => person.personId);
  return {
    available: people.length > 0,
    entityCount: people.length,
    entityIds: people.map((person) => person.personId),
    presentPersonIds,
  };
}

function calendarSourceSummary(
  states: readonly HaEntityState[],
  calendarFetcher: HaCalendarFetcher | undefined,
): HouseStateCalendarSourceSummary {
  const entityIds = states
    .filter((state) => state.entityId.startsWith("calendar."))
    .map((state) => state.entityId)
    .sort();
  return {
    available: entityIds.length > 0,
    entityCount: entityIds.length,
    entityIds,
    fetcherAvailable: calendarFetcher !== undefined,
  };
}

function weatherSourceSummary(
  states: readonly HaEntityState[],
  weatherForecastFetcher: HaWeatherForecastFetcher | undefined,
): HouseStateWeatherSourceSummary {
  const weatherStates = states.filter((state) => state.entityId.startsWith("weather."));
  const entityIds = weatherStates.map((state) => state.entityId).sort();
  return {
    available: entityIds.length > 0,
    entityCount: entityIds.length,
    entityIds,
    currentEntityId: currentWeatherEntityId(weatherStates),
    hourlyEntityId: hourlyWeatherEntityId(weatherStates),
    forecastFetcherAvailable: weatherForecastFetcher !== undefined,
  };
}

function activitySnapshot(now: Date, timezone: string, policy: HouseStatePolicy): HouseStateActivitySnapshot {
  const local = localClock(now, timezone);
  return {
    localHour: local.hour,
    weekday: local.weekday,
    weekend: local.weekday === 0 || local.weekday === 6,
    quietHoursActive: windowActive(local.hour + local.minute / 60, policy.quietHours),
    bedtimeActive: windowActive(local.hour + local.minute / 60, policy.bedtime),
  };
}

function currentWeatherEntityId(states: readonly HaEntityState[]): string | null {
  return states.find((state) => state.entityId === houseConfig().weather.entity)?.entityId
    ?? states.find((state) => state.entityId === "weather.home")?.entityId
    ?? states.find((state) => !/\bhourly\b/i.test(friendlyName(state)))?.entityId
    ?? states[0]?.entityId
    ?? null;
}

function hourlyWeatherEntityId(states: readonly HaEntityState[]): string | null {
  return states.find((state) => /\bhourly\b/i.test(friendlyName(state)))?.entityId
    ?? states.find((state) => state.entityId === houseConfig().weather.hourlyEntity)?.entityId
    ?? null;
}

function personPresence(rawState: string): HouseStatePersonPresence {
  const normalized = rawState.trim().toLowerCase();
  if (normalized === "home") {
    return "home";
  }
  if (normalized === "not_home" || normalized === "away") {
    return "away";
  }
  if (normalized === "unknown" || normalized === "unavailable" || normalized === "") {
    return "unknown";
  }
  return "zone";
}

function personZoneName(rawState: string): string | null {
  return personPresence(rawState) === "zone" ? rawState : null;
}

function occupancyMode(people: readonly HouseStatePersonSnapshot[]): HouseOccupancyMode {
  if (people.length === 0) {
    return "unknown";
  }
  return people.some((person) => person.presence === "home") ? "occupied" : "empty";
}

function compositeMode(occupancy: HouseOccupancyMode, time: HouseTimeMode): HouseCompositeMode {
  if (occupancy === "unknown") {
    return "unresolved";
  }
  if (time === "bedtime") {
    return occupancy === "occupied" ? "settling_occupied" : "night_empty";
  }
  if (time === "quiet_hours") {
    return occupancy === "occupied" ? "quiet_occupied" : "quiet_empty";
  }
  return occupancy === "occupied" ? "active_occupied" : "idle_empty";
}

function windowActive(hour: number, window: HouseStateWindowPolicy | null): boolean {
  if (!window) {
    return false;
  }
  if (window.startHourLocal === window.endHourLocal) {
    return true;
  }
  if (window.startHourLocal < window.endHourLocal) {
    return hour >= window.startHourLocal && hour < window.endHourLocal;
  }
  return hour >= window.startHourLocal || hour < window.endHourLocal;
}

function localClock(date: Date, timezone: string): { readonly hour: number; readonly minute: number; readonly weekday: number } {
  const hourParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(hourParts.find((part) => part.type === "hour")?.value ?? NaN);
  const minute = Number(hourParts.find((part) => part.type === "minute")?.value ?? NaN);
  const weekdayLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(date).toLowerCase();
  const weekday = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(weekdayLabel);
  return {
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0,
    weekday: weekday >= 0 ? weekday : 0,
  };
}
