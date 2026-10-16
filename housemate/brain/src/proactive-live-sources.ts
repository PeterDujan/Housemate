import { createHash } from "node:crypto";

import type { HouseStateSnapshot } from "./house-state.js";
import type { HaCalendarEvent, HaCalendarFetcher } from "./ha-calendar.js";
import type { HaEntityState, HaStateCache } from "./ha-state-cache.js";
import type { HaTodoFetcher, HaTodoItem } from "./ha-todo.js";
import type { HaWeatherForecastFetcher, HaWeatherForecastPoint } from "./ha-weather-forecast.js";
import type { Opportunity } from "./proactive-opportunity.js";
import { errorMessage } from "./value-guards.js";
import { timezoneOffsetMs } from "./zoned-time.js";
import { attributeText } from "./ha-state-cache.js";
import { HOUSE_LOCALE, houseConfig, type LeftOpenWatch } from "./house-config.js";

export type LiveProactiveSource = "weather" | "todo" | "device" | "calendar" | "bins";

export interface LiveProactiveSourceFailure {
  readonly source: LiveProactiveSource;
  readonly message: string;
}

export interface LiveProactiveSourceResult {
  readonly opportunities: readonly Opportunity[];
  readonly failures: readonly LiveProactiveSourceFailure[];
}

export interface RemoteProactiveSourceOptions {
  readonly now: Date;
  readonly targetPersonId: string;
  readonly timezone: string;
  readonly houseSnapshot: HouseStateSnapshot;
  readonly stateCache: HaStateCache;
  readonly weatherForecastFetcher?: HaWeatherForecastFetcher;
  readonly todoFetcher?: HaTodoFetcher;
  readonly calendarFetcher?: HaCalendarFetcher;
}

const REMOTE_SOURCE_TIMEOUT_MS = 5_000;
const WEATHER_HORIZON_MS = 4 * 60 * 60_000;
const CALENDAR_QUERY_HORIZON_MS = 7 * 24 * 60 * 60_000;
const CALENDAR_NOTICE_HORIZON_MS = 24 * 60 * 60_000;
const TODO_MINIMUM_OVERDUE_MS = 30 * 60_000;
const TODO_MAXIMUM_OVERDUE_MS = 72 * 60 * 60_000;
const DEVICE_CONFIRMATION_MS = 2 * 60_000;
const MINIMUM_CONFLICT_MS = 15 * 60_000;
const AUTOMATED_CALENDAR_PATTERN = /\b(?:sonarr|radarr|waste|bin collection|release calendar|tv calendar|movie calendar)\b/iu;
const BIN_CALENDAR_PATTERN = /\b(?:waste|bin collection)\b/iu;
const UPCOMING_EVENT_NOTICE_MS = 60 * 60_000;
const SPOKEN_CLOCK_PATTERN = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/iu;
const BIN_NIGHT_HOURS = { from: 17, until: 23 } as const;
const UPKEEP_HOURS = { from: 10, until: 20 } as const;
const LEFT_OPEN_SETTLE_MS = 10 * 60_000;
const LOW_BATTERY_PERCENT = 20;
const LOW_TONER_PERCENT = 15;
const NAS_NEARLY_FULL_FRACTION = 0.1;
const BACKUP_GRACE_MS = 2 * 60 * 60_000;
// Batteries that charge themselves or are not a job for anyone: phones, the
// iPad, the home battery and the vacuum.
function rechargeableBatteryPattern(): RegExp {
  return new RegExp(`(?:${["iphone", "ipad", "phone", "vacuum", ...houseConfig().rechargeableWords].join("|")})`, "iu");
}

/** What counts as the house left open: the house's picks (house.json `left_open`), else its locks and garage doors (discovery). */
function leftOpenWatch(): readonly LeftOpenWatch[] {
  return houseConfig().leftOpen;
}
const PHYSICAL_PROBLEM_PATTERN = /\b(?:overpower(?:ing)?|overheat(?:ing)?|electrical|leak|water|flood|pump|boiler|freezer|fridge|refrigerat|fault)\b/iu;
const RAIN_CONDITIONS = new Set(["rainy", "pouring", "lightning-rainy", "hail"]);

export async function collectRemoteProactiveOpportunities(
  options: RemoteProactiveSourceOptions,
): Promise<LiveProactiveSourceResult> {
  const jobs: readonly Promise<{ readonly source: LiveProactiveSource; readonly opportunities: readonly Opportunity[] }>[] = [
    collectWeather(options),
    collectTodos(options),
    collectCalendar(options),
    collectBinNight(options),
  ];
  const settled = await Promise.allSettled(jobs);
  const opportunities: Opportunity[] = [];
  const failures: LiveProactiveSourceFailure[] = [];
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index]!;
    const source = (["weather", "todo", "calendar", "bins"] as const)[index]!;
    if (result.status === "fulfilled") {
      opportunities.push(...result.value.opportunities);
    } else {
      failures.push({ source, message: errorMessage(result.reason) });
    }
  }
  return { opportunities: stableRecords(opportunities), failures };
}

/** The proactive device-fault rule: a `problem` sensor about physical plant, not app health. */
export function isPhysicalProblemSensor(entityId: string, label: string): boolean {
  return PHYSICAL_PROBLEM_PATTERN.test(`${entityId} ${label}`);
}

export function collectDeviceProblemOpportunities(options: {
  readonly now: Date;
  readonly targetPersonId: string;
  readonly stateCache: HaStateCache;
}): readonly Opportunity[] {
  const nowMs = options.now.getTime();
  return stableRecords(options.stateCache.entries().flatMap((state) => {
    if (!state.entityId.startsWith("binary_sensor.") || state.state !== "on") return [];
    const deviceClass = attributeText(state, "device_class").toLowerCase();
    const label = safeLabel(entityLabel(state));
    if (deviceClass !== "problem" || !isPhysicalProblemSensor(state.entityId, label)) {
      return [];
    }
    const changedAtMs = Date.parse(state.lastChanged);
    if (!Number.isFinite(changedAtMs) || nowMs - changedAtMs < DEVICE_CONFIRMATION_MS) return [];
    const text = deviceProblemText(label, deviceClass);
    return [opportunityRecord({
      now: options.now,
      targetPersonId: options.targetPersonId,
      opportunityType: "device_problem",
      sourceKey: `${state.entityId}:${state.lastChanged}`,
      title: `Device problem: ${label}`,
      summary: text,
      expiresAt: new Date(nowMs + 60 * 60_000),
      usefulness: 0.88,
      tags: [`entity:${state.entityId}`, `device_class:${deviceClass || "problem"}`],
      reason: "a physical problem sensor stayed on for at least 2 minutes",
    })];
  })).slice(0, 3);
}

/**
 * State-only ideas, read every minute: the front door or garage
 * left open at bedtime or with nobody home, and the weekly upkeep line.
 */
export function collectHouseCareOpportunities(options: {
  readonly now: Date;
  readonly targetPersonId: string;
  readonly stateCache: HaStateCache;
  readonly houseSnapshot: HouseStateSnapshot;
}): readonly Opportunity[] {
  return [...leftOpen(options), ...upkeep(options)];
}

function leftOpen(options: Parameters<typeof collectHouseCareOpportunities>[0]): Opportunity[] {
  const nowMs = options.now.getTime();
  const trigger = options.houseSnapshot.modes.occupancy === "empty"
    ? "nobody is home"
    : options.houseSnapshot.activity.bedtimeActive ? "it is bedtime" : null;
  if (!trigger) return [];
  const open = leftOpenWatch().flatMap((watch) => {
    const state = options.stateCache.get(watch.entityId);
    const changedAtMs = state ? Date.parse(state.lastChanged) : Number.NaN;
    return state?.state === watch.openState && Number.isFinite(changedAtMs) && nowMs - changedAtMs >= LEFT_OPEN_SETTLE_MS
      ? [{ watch, lastChanged: state.lastChanged }]
      : [];
  });
  if (open.length === 0) return [];
  const said = open.map(({ watch }) => watch.text).join(" and ");
  return [opportunityRecord({
    now: options.now,
    targetPersonId: options.targetPersonId,
    opportunityType: "house_left_open",
    sourceKey: `${trigger}:${open.map(({ watch, lastChanged }) => `${watch.entityId}:${lastChanged}`).join("|")}`,
    title: "House left open",
    summary: `${said.charAt(0).toUpperCase()}${said.slice(1)}.`,
    expiresAt: new Date(nowMs + 60 * 60_000),
    usefulness: 0.9,
    tags: open.map(({ watch }) => `entity:${watch.entityId}`),
    reason: `${trigger} and it has been left that way for at least 10 minutes`,
  })];
}

function upkeep(options: Parameters<typeof collectHouseCareOpportunities>[0]): Opportunity[] {
  const timezone = options.houseSnapshot.timezone;
  const hour = localHour(options.now, timezone);
  if (hour < UPKEEP_HOURS.from || hour >= UPKEEP_HOURS.until) return [];
  const states = options.stateCache.entries();
  const percent = (state: HaEntityState): number | null =>
    attributeText(state, "unit_of_measurement") === "%" && Number.isFinite(Number(state.state)) && state.state.trim() !== ""
      ? Number(state.state)
      : null;
  const items: string[] = [];
  for (const state of states) {
    const value = percent(state);
    if (value === null || !state.entityId.startsWith("sensor.")) continue;
    if (attributeText(state, "device_class") === "battery" && value <= LOW_BATTERY_PERCENT
      && !rechargeableBatteryPattern().test(state.entityId)) {
      items.push(`the ${batteryOwner(safeLabel(entityLabel(state)))} battery is at ${Math.round(value)}%`);
    } else if (/(?:toner|_ink$)/u.test(state.entityId) && value <= LOW_TONER_PERCENT) {
      items.push(`the ${safeLabel(entityLabel(state)).replace(/\s*remaining$/iu, "").toLowerCase()} is at ${Math.round(value)}%`);
    }
  }
  const attempted = Date.parse(options.stateCache.get("sensor.backup_last_attempted_automatic_backup")?.state ?? "");
  const succeeded = Date.parse(options.stateCache.get("sensor.backup_last_successful_automatic_backup")?.state ?? "");
  if (Number.isFinite(attempted) && options.now.getTime() - attempted >= BACKUP_GRACE_MS
    && (!Number.isFinite(succeeded) || succeeded < attempted)) {
    items.push("the last Home Assistant backup failed");
  }
  for (const free of states.filter((state) => state.entityId.startsWith("sensor.") && state.entityId.includes("_free_space_"))) {
    const used = options.stateCache.get(free.entityId.replace("_free_space_", "_used_space_"));
    const freeAmount = Number(free.state);
    const usedAmount = Number(used?.state);
    if (Number.isFinite(freeAmount) && Number.isFinite(usedAmount) && freeAmount + usedAmount > 0
      && freeAmount / (freeAmount + usedAmount) < NAS_NEARLY_FULL_FRACTION) {
      items.push(`${safeLabel(entityLabel(free)).replace(/\s*free space\s*/iu, " ").trim()} is nearly full`);
    }
  }
  if (items.length === 0) return [];
  const list = items.length === 1 ? items[0]! : `${items.slice(0, -1).join(", ")} and ${items.at(-1)!}`;
  return [opportunityRecord({
    now: options.now,
    targetPersonId: options.targetPersonId,
    opportunityType: "upkeep",
    sourceKey: `week:${localWeekKey(options.now, timezone)}`,
    title: "Upkeep",
    summary: `A bit of upkeep: ${list}.`,
    expiresAt: new Date(options.now.getTime() + 6 * 60 * 60_000),
    usefulness: 0.72,
    tags: ["upkeep"],
    reason: "something in the house needs looking after; raised at most once a week",
  })];
}

// "Front Door Lock Front Door Battery percentage" -> "Front Door Lock".
function batteryOwner(label: string): string {
  const words = label.replace(/\s*battery(?:\s+(?:percentage|level|sensor))?\s*$/iu, "").trim().split(/\s+/u);
  for (let size = Math.floor(words.length / 2); size > 0; size -= 1) {
    const tail = words.slice(-size).join(" ").toLowerCase();
    if (words.slice(0, size).join(" ").toLowerCase() === tail) return words.slice(0, -size).join(" ");
  }
  return words.join(" ");
}

async function collectBinNight(
  options: RemoteProactiveSourceOptions,
): Promise<{ readonly source: "bins"; readonly opportunities: readonly Opportunity[] }> {
  const fetcher = options.calendarFetcher;
  const hour = localHour(options.now, options.timezone);
  const entities = options.stateCache.entries().filter((state) =>
    state.entityId.startsWith("calendar.") && BIN_CALENDAR_PATTERN.test(`${state.entityId} ${entityLabel(state)}`)
  );
  if (!fetcher || entities.length === 0 || hour < BIN_NIGHT_HOURS.from || hour >= BIN_NIGHT_HOURS.until) {
    return { source: "bins", opportunities: [] };
  }
  const nowMs = options.now.getTime();
  const tomorrow = localDateKey(new Date(nowMs + 24 * 60 * 60_000), options.timezone);
  const events = await fetcher.fetchEvents({
    entityIds: entities.map((state) => state.entityId),
    start: options.now.toISOString(),
    end: new Date(nowMs + 2 * 24 * 60 * 60_000).toISOString(),
    calendarNames: Object.fromEntries(entities.map((state) => [state.entityId, entityLabel(state)])),
    signal: AbortSignal.timeout(REMOTE_SOURCE_TIMEOUT_MS),
  });
  const bins = [...new Set(events
    .filter((event) => (isDateOnly(event.start) ? event.start : localDateKey(new Date(sourceTimestampMs(event.start, options.timezone)), options.timezone)) === tomorrow)
    .map((event) => safeLabel(event.summary).replace(/[.!?]+$/u, "")))];
  if (bins.length === 0) return { source: "bins", opportunities: [] };
  return {
    source: "bins",
    opportunities: [opportunityRecord({
      now: options.now,
      targetPersonId: options.targetPersonId,
      opportunityType: "bin_night",
      sourceKey: `bins:${tomorrow}`,
      title: "Bin night",
      summary: `Bins go out tonight: ${bins.join(" and ")}.`,
      expiresAt: new Date(zonedDateTimeMs(`${tomorrow}T00:00`, options.timezone)),
      usefulness: 0.88,
      tags: entities.map((state) => `calendar:${state.entityId}`),
      reason: "the bin collection calendar has a pickup tomorrow",
    })],
  };
}

async function collectWeather(
  options: RemoteProactiveSourceOptions,
): Promise<{ readonly source: "weather"; readonly opportunities: readonly Opportunity[] }> {
  const fetcher = options.weatherForecastFetcher;
  const entityId = options.houseSnapshot.sources.weather.hourlyEntityId
    ?? options.houseSnapshot.sources.weather.currentEntityId;
  if (!fetcher || !entityId) return { source: "weather", opportunities: [] };
  const points = await fetcher.fetchHourly(entityId, { signal: AbortSignal.timeout(REMOTE_SOURCE_TIMEOUT_MS) });
  const currentCondition = options.stateCache.get(options.houseSnapshot.sources.weather.currentEntityId ?? entityId)?.state ?? "";
  const candidate = bestWeatherCandidate(points, options.now, options.timezone, currentCondition);
  if (!candidate) return { source: "weather", opportunities: [] };
  const localDate = localDateKey(new Date(candidate.atMs), options.timezone);
  return {
    source: "weather",
    opportunities: [opportunityRecord({
      now: options.now,
      targetPersonId: options.targetPersonId,
      opportunityType: "imminent_weather",
      sourceKey: `${entityId}:${candidate.kind}:${localDate}`,
      title: `Imminent weather: ${candidate.kind.replaceAll("_", " ")}`,
      summary: candidate.text,
      expiresAt: new Date(candidate.atMs + 60 * 60_000),
      usefulness: candidate.usefulness,
      tags: [`weather:${entityId}`, `weather_kind:${candidate.kind}`],
      reason: candidate.reason,
    })],
  };
}

interface WeatherCandidate {
  readonly kind: "rain_start" | "heavy_rain" | "high_wind" | "extreme_heat" | "extreme_cold";
  readonly atMs: number;
  readonly usefulness: number;
  readonly text: string;
  readonly reason: string;
}

function bestWeatherCandidate(
  points: readonly HaWeatherForecastPoint[],
  now: Date,
  timezone: string,
  currentCondition: string,
): WeatherCandidate | null {
  const nowMs = now.getTime();
  const future = points
    .map((point) => ({ point, atMs: sourceTimestampMs(point.datetime, timezone) }))
    .filter((item) => item.atMs > nowMs && item.atMs <= nowMs + WEATHER_HORIZON_MS)
    .sort((left, right) => left.atMs - right.atMs);
  const candidates: WeatherCandidate[] = [];
  for (const { point, atMs } of future) {
    const clock = localClock(new Date(atMs), timezone);
    const condition = point.condition?.toLowerCase() ?? "";
    if ((point.precipitation ?? 0) >= 5 || condition === "pouring" || condition === "lightning-rainy") {
      candidates.push({ kind: "heavy_rain", atMs, usefulness: 0.92, text: `Heavy rain is forecast around ${clock}.`, reason: "the forecast reports at least 5 mm of rain or a severe rain condition within 4 hours" });
    } else if (!RAIN_CONDITIONS.has(currentCondition.toLowerCase())
      && RAIN_CONDITIONS.has(condition)
      && (point.precipitationProbability ?? 0) >= 70) {
      candidates.push({ kind: "rain_start", atMs, usefulness: 0.82, text: `Rain is likely to start around ${clock}.`, reason: "the house is currently dry and rain probability reaches at least 70 percent within 4 hours" });
    }
    if ((point.windGustSpeed ?? 0) >= 60) {
      const gust = Math.round((point.windGustSpeed ?? 0) / 5) * 5;
      candidates.push({ kind: "high_wind", atMs, usefulness: 0.91, text: `Wind gusts around ${gust} km/h are forecast around ${clock}.`, reason: "forecast wind gusts reach at least 60 km/h within 4 hours" });
    }
    if ((point.temperature ?? -Infinity) >= 35) {
      candidates.push({ kind: "extreme_heat", atMs, usefulness: 0.9, text: `The temperature is forecast to reach ${Math.round(point.temperature!)} °C around ${clock}.`, reason: "forecast temperature reaches at least 35 C within 4 hours" });
    }
    if ((point.temperature ?? Infinity) <= 2) {
      candidates.push({ kind: "extreme_cold", atMs, usefulness: 0.88, text: `The temperature is forecast to fall to ${Math.round(point.temperature!)} °C around ${clock}.`, reason: "forecast temperature falls to 2 C or below within 4 hours" });
    }
  }
  return candidates.sort((left, right) => right.usefulness - left.usefulness || left.atMs - right.atMs)[0] ?? null;
}

async function collectTodos(
  options: RemoteProactiveSourceOptions,
): Promise<{ readonly source: "todo"; readonly opportunities: readonly Opportunity[] }> {
  const fetcher = options.todoFetcher;
  const entities = options.stateCache.entries().filter((state) => state.entityId.startsWith("todo."));
  if (!fetcher || entities.length === 0) return { source: "todo", opportunities: [] };
  const items = await fetcher.fetchItems({
    entityIds: entities.map((state) => state.entityId),
    statuses: ["needs_action"],
    listNames: Object.fromEntries(entities.map((state) => [state.entityId, entityLabel(state)])),
    signal: AbortSignal.timeout(REMOTE_SOURCE_TIMEOUT_MS),
  });
  const nowMs = options.now.getTime();
  const overdue = items.flatMap((item) => {
    if (!item.due || (item.status && item.status !== "needs_action")) return [];
    const dueMs = todoDueMs(item.due, options.timezone);
    const overdueMs = nowMs - dueMs;
    return overdueMs >= TODO_MINIMUM_OVERDUE_MS && overdueMs <= TODO_MAXIMUM_OVERDUE_MS
      ? [{ item, dueMs }]
      : [];
  });
  const byList = new Map<string, { readonly items: readonly { readonly item: HaTodoItem; readonly dueMs: number }[]; readonly label: string }>();
  for (const entity of entities) {
    const matching = overdue.filter(({ item }) => item.entityId === entity.entityId).sort((left, right) => left.dueMs - right.dueMs);
    if (matching.length > 0) byList.set(entity.entityId, { items: matching, label: safeLabel(entityLabel(entity)) });
  }
  const groups = [...byList.entries()].sort(([left], [right]) => left.localeCompare(right));
  if (groups.length === 0) return { source: "todo", opportunities: [] };
  const totalCount = groups.reduce((sum, [, group]) => sum + group.items.length, 0);
  const oldestDueMs = Math.min(...groups.flatMap(([, group]) => group.items.map((item) => item.dueMs)));
  const labels = groups.map(([, group]) => group.label);
  const listPhrase = labels.length <= 2
    ? labels.join(" and ")
    : `${labels.slice(0, 2).join(", ")}, and ${labels.length - 2} other lists`;
  const noun = totalCount === 1 ? "item" : "items";
  const opportunity = opportunityRecord({
    now: options.now,
    targetPersonId: options.targetPersonId,
    opportunityType: "overdue_jobs",
    sourceKey: groups.map(([entityId, group]) => `${entityId}:${group.items.length}`).join("|") + `:${oldestDueMs}`,
    title: "Overdue jobs",
    summary: `${listPhrase} ${groups.length === 1 ? "has" : "have"} ${totalCount === 1 ? "one" : totalCount} overdue ${noun}; the oldest was due ${localMoment(new Date(oldestDueMs), options.timezone)}.`,
    expiresAt: new Date(nowMs + 6 * 60 * 60_000),
    usefulness: Math.min(0.9, 0.78 + Math.max(0, totalCount - 1) * 0.03),
    tags: [...groups.map(([entityId]) => `todo:${entityId}`), "content:redacted"],
    reason: "unfinished items became overdue 30 minutes to 72 hours ago; task content is redacted",
  });
  return { source: "todo", opportunities: [opportunity] };
}

async function collectCalendar(
  options: RemoteProactiveSourceOptions,
): Promise<{ readonly source: "calendar"; readonly opportunities: readonly Opportunity[] }> {
  const fetcher = options.calendarFetcher;
  const entities = options.stateCache.entries().filter((state) =>
    state.entityId.startsWith("calendar.")
    && !AUTOMATED_CALENDAR_PATTERN.test(`${state.entityId} ${entityLabel(state)}`)
  );
  if (!fetcher || entities.length === 0) return { source: "calendar", opportunities: [] };
  const nowMs = options.now.getTime();
  const events = await fetcher.fetchEvents({
    entityIds: entities.map((state) => state.entityId),
    start: options.now.toISOString(),
    end: new Date(nowMs + CALENDAR_QUERY_HORIZON_MS).toISOString(),
    calendarNames: Object.fromEntries(entities.map((state) => [state.entityId, entityLabel(state)])),
    signal: AbortSignal.timeout(REMOTE_SOURCE_TIMEOUT_MS),
  });
  const timed = deduplicateEvents(events, options.timezone)
    .filter((event) => !isDateOnly(event.start) && !isDateOnly(event.end))
    .map((event) => ({ event, startMs: sourceTimestampMs(event.start, options.timezone), endMs: sourceTimestampMs(event.end, options.timezone) }))
    .filter((event) => event.startMs > nowMs && event.startMs <= nowMs + CALENDAR_NOTICE_HORIZON_MS && event.endMs > event.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  // A heads-up within the hour. Family entries are often reminders
  // whose own title carries the real time ("Swimming today at
  // 4:30pm"), so that title is read as written.
  const upcoming = timed.filter((event) => event.startMs <= nowMs + UPCOMING_EVENT_NOTICE_MS).slice(0, 2).map((event) => {
    const title = safeLabel(event.event.summary).replace(/[.!?]+$/u, "");
    return opportunityRecord({
      now: options.now,
      targetPersonId: options.targetPersonId,
      opportunityType: "upcoming_calendar_event",
      sourceKey: eventKey(event.event),
      title: "Coming up",
      summary: SPOKEN_CLOCK_PATTERN.test(title)
        ? `From the calendar: ${title}.`
        : `${title} at ${localClock(new Date(event.startMs), options.timezone)}.`,
      expiresAt: new Date(event.startMs),
      usefulness: 0.85,
      tags: [`calendar:${event.event.entityId}`],
      reason: "a family calendar entry starts within the hour",
    });
  });
  const opportunities: Opportunity[] = [...upcoming];
  for (let leftIndex = 0; leftIndex < timed.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < timed.length; rightIndex += 1) {
      const left = timed[leftIndex]!;
      const right = timed[rightIndex]!;
      if (right.startMs >= left.endMs) break;
      const overlapStart = Math.max(left.startMs, right.startMs);
      const overlapEnd = Math.min(left.endMs, right.endMs);
      if (overlapEnd - overlapStart < MINIMUM_CONFLICT_MS) continue;
      const sourceKey = [eventKey(left.event), eventKey(right.event)].sort().join("|");
      opportunities.push(opportunityRecord({
        now: options.now,
        targetPersonId: options.targetPersonId,
        opportunityType: "calendar_conflict",
        sourceKey,
        title: "Calendar conflict",
        summary: `Two calendar events overlap ${localMoment(new Date(overlapStart), options.timezone)} until ${localClock(new Date(overlapEnd), options.timezone)}.`,
        expiresAt: new Date(overlapStart),
        usefulness: 0.89,
          tags: ["calendar:conflict", "content:redacted"],
        reason: "two non-automated timed events overlap by at least 15 minutes within 24 hours; titles are redacted",
      }));
    }
  }
  const conflicts = stableRecords(opportunities.filter((record) => record.type === "calendar_conflict")).slice(0, 1);
  return { source: "calendar", opportunities: stableRecords([...upcoming, ...conflicts]) };
}

function deduplicateEvents(events: readonly HaCalendarEvent[], timezone: string): readonly HaCalendarEvent[] {
  const unique = new Map<string, HaCalendarEvent>();
  for (const event of events) {
    const key = `${event.summary.trim().toLowerCase()}|${canonicalEventTime(event.start, timezone)}|${canonicalEventTime(event.end, timezone)}`;
    if (!unique.has(key)) unique.set(key, event);
  }
  return [...unique.values()];
}

function canonicalEventTime(value: string, timezone: string): string | number {
  return isDateOnly(value) ? value : sourceTimestampMs(value, timezone);
}

function eventKey(event: HaCalendarEvent): string {
  return `${event.entityId}:${event.summary.trim().toLowerCase()}:${event.start}:${event.end}`;
}

function opportunityRecord(fields: {
  readonly now: Date;
  readonly targetPersonId: string;
  readonly opportunityType: string;
  readonly sourceKey: string;
  readonly title: string;
  readonly summary: string;
  readonly expiresAt: Date;
  readonly usefulness: number;
  readonly tags: readonly string[];
  readonly reason: string;
}): Opportunity {
  const digest = createHash("sha256").update(`${fields.opportunityType}:${fields.sourceKey}`).digest("hex").slice(0, 16);
  const now = fields.now.toISOString();
  return {
    id: `mem-opportunity-live-${digest}`,
    type: fields.opportunityType,
    targetPersonId: fields.targetPersonId,
    title: fields.title,
    summary: fields.summary,
    allowedChannels: ["voice"],
    notBefore: now,
    expiresAt: fields.expiresAt.toISOString(),
    cooldownUntil: now,
    usefulness: fields.usefulness,
    sensitivity: ["none"],
    status: "queued",
    source: { kind: "live", reason: fields.reason },
    tags: fields.tags,
  };
}

function stableRecords(records: readonly Opportunity[]): Opportunity[] {
  return [...new Map(records.map((record) => [record.id, record])).values()].sort((left, right) => left.id.localeCompare(right.id));
}

function todoDueMs(value: string, timezone: string): number {
  if (isDateOnly(value)) {
    return zonedDateTimeMs(`${value}T23:59:59`, timezone);
  }
  return sourceTimestampMs(value, timezone);
}

function sourceTimestampMs(value: string, timezone: string): number {
  if (/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    throw new Error(`invalid source timestamp ${value}`);
  }
  return zonedDateTimeMs(value, timezone);
}

function zonedDateTimeMs(value: string, timezone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/u.exec(value);
  if (!match) throw new Error(`invalid local source timestamp ${value}`);
  const localAsUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] ?? 0));
  let utcMs = localAsUtc - timezoneOffsetMs(new Date(localAsUtc), timezone);
  utcMs = localAsUtc - timezoneOffsetMs(new Date(utcMs), timezone);
  return utcMs;
}

// YYYY-MM-DD from parts: "en-CA" formatting is not ISO in every ICU build.
function localDateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function localHour(date: Date, timezone: string): number {
  return Number(new Intl.DateTimeFormat(HOUSE_LOCALE, { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(date));
}

// Weeks start on Monday: 1 Jan 1970 was a Thursday.
function localWeekKey(date: Date, timezone: string): number {
  return Math.floor((Date.parse(`${localDateKey(date, timezone)}T00:00:00Z`) / 86_400_000 + 3) / 7);
}

function localMoment(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: timezone,
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date).replace(/\s(am|pm)$/iu, " $1").replace(/\s+/gu, " ");
}

function localClock(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date).replace(/\s(am|pm)$/iu, " $1").replace(/\s+/gu, " ");
}

function deviceProblemText(label: string, deviceClass: string): string {
  if (deviceClass !== "problem") throw new Error(`unsupported opportunistic device class ${deviceClass}`);
  return `${label} is reporting a physical fault.`;
}

function entityLabel(state: HaEntityState): string {
  return attributeText(state, "friendly_name") || state.entityId.replace(/^[^.]+\./u, "").replaceAll("_", " ");
}

function safeLabel(value: string): string {
  const printable = [...value].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 ? " " : character;
  }).join("");
  return printable.replace(/\s+/gu, " ").trim().slice(0, 80) || "A Home Assistant device";
}

function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value);
}
