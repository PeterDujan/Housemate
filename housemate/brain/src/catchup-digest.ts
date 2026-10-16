import { existsSync, readFileSync } from "node:fs";

import type { HaCalendarFetcher } from "./ha-calendar.js";
import type { HaEnergySources, HaHistoryFetcher, HaHistoryState, HaStatisticSample } from "./ha-history.js";
import type { HaEntityState } from "./ha-state-cache.js";
import { isPhysicalProblemSensor } from "./proactive-live-sources.js";
import { parseTimeWindow } from "./time-window-parser.js";
import { joinNatural } from "./text-format.js";
import { attributeText, friendlyName } from "./ha-state-cache.js";
import { recordOrNull } from "./value-guards.js";
import { HOUSE_LOCALE, houseDataPath } from "./house-config.js";
import { discoveredHouse, discoveryRevision } from "./house-discovery.js";

/*
 * Catch-up digest: what happened while the
 * speaker was out, or since they last spoke to the assistant, built by code from HA
 * history. No model touches it. The same digest answers the no-AI route and,
 * for catch-up follow-ups only, rides open chat as the model's only facts.
 */

export type CatchupScope = "while_i_was_out" | "since_last_spoke" | "today";
export type CatchupSource = "people" | "openings" | "weather" | "calendar" | "energy" | "devices";
export type CatchupItemKind =
  | "device_problem"
  | "opening_left_open"
  | "person"
  | "storm"
  | "calendar"
  | "rain"
  | "energy"
  | "temperature"
  | "opening";

export interface CatchupItem {
  readonly kind: CatchupItemKind;
  readonly weight: number;
  readonly at: string;
  readonly text: string;
  readonly sourceEntityIds: readonly string[];
}

export interface CatchupWindow {
  readonly start: string;
  readonly end: string;
  /** How the start was found. `no_recent_contact` means nothing inside the cap. */
  readonly basis: "away" | "last_spoke" | "no_recent_contact" | "today";
  /** The real start was older than the cap, so the window was cut to the cap. */
  readonly capped: boolean;
  /** The speaker is still away (window end is now). */
  readonly ongoing: boolean;
}

export interface CatchupDigest {
  readonly scope: CatchupScope;
  readonly window: CatchupWindow;
  /** Ranked, most notable first, at most `CATCHUP_LIMITS.keptItems`. */
  readonly items: readonly CatchupItem[];
  readonly failures: readonly CatchupSource[];
  readonly speakerEntityId: string | null;
  readonly builtAt: string;
  readonly timezone: string;
}

export interface CatchupSourcesConfig {
  readonly people: Readonly<Record<string, { readonly entityId: string; readonly label: string }>>;
  readonly openingLabels: Readonly<Record<string, string>>;
  readonly excludeEntityIds: readonly string[];
  readonly calendars: readonly string[];
  readonly problemLabels: Readonly<Record<string, string>>;
  readonly weatherEntityId: string | null;
  readonly hotDegrees: number;
  readonly coldDegrees: number;
}

export interface CatchupServices {
  readonly stateCache?: { entries(): readonly HaEntityState[]; get(entityId: string): HaEntityState | null | undefined };
  readonly fetchHistory?: HaHistoryFetcher["fetchHistory"];
  readonly fetchStatistics?: HaHistoryFetcher["fetchStatistics"];
  readonly fetchEnergySources?: HaHistoryFetcher["fetchEnergySources"];
  readonly calendarFetcher?: HaCalendarFetcher;
  /** The speaker's latest real turn in [since, before), or null. */
  readonly lastSpokeAt?: (actorId: string, before: Date, since: Date) => string | null;
}

export type CatchupBuildResult =
  | { readonly status: "ok"; readonly digest: CatchupDigest }
  | { readonly status: "declined"; readonly text: string; readonly notes: string; readonly sourceEntityIds: readonly string[] };

export const CATCHUP_LIMITS = Object.freeze({
  capMs: 7 * 24 * 60 * 60_000,
  sourceTimeoutMs: 1_500,
  spokenItems: 3,
  keptItems: 10,
  leftOpenMs: 30 * 60_000,
  energyMinWindowMs: 2 * 60 * 60_000,
  energyMinDeltaKwh: 2,
  energyHighRatio: 1.6,
  energyLowRatio: 0.5,
});

const WEIGHTS: Readonly<Record<CatchupItemKind, number>> = Object.freeze({
  device_problem: 100,
  opening_left_open: 90,
  person: 70,
  storm: 65,
  calendar: 55,
  rain: 50,
  energy: 45,
  temperature: 35,
  opening: 30,
});

const SOURCE_NAMES: Readonly<Record<CatchupSource, string>> = Object.freeze({
  people: "comings and goings",
  openings: "the doors",
  weather: "the weather",
  calendar: "the calendar",
  energy: "the power use",
  devices: "the device alarms",
});

const OPENING_DEVICE_CLASSES = new Set(["door", "garage_door", "window", "opening"]);
const RAINY_STATES = new Set(["rainy", "pouring", "lightning-rainy", "snowy-rainy", "hail"]);
const STORM_STATES = new Set(["lightning", "lightning-rainy"]);
const DAY_MS = 24 * 60 * 60_000;

let cachedConfig: { readonly revision: number; readonly config: CatchupSourcesConfig } | null = null;

export function loadCatchupSourcesConfig(): CatchupSourcesConfig {
  if (cachedConfig?.revision !== discoveryRevision()) {
    // The house's catch-up sources (<dataDir>/catchup-sources.json); each section it leaves out comes
    // from discovery (the People page's linked people, the house's calendars and weather).
    const path = houseDataPath("catchup-sources.json", "JARVIS_V5_CATCHUP_SOURCES_FILE");
    const own = existsSync(path) ? recordOrNull(JSON.parse(readFileSync(path, "utf8"))) ?? {} : {};
    cachedConfig = { revision: discoveryRevision(), config: parseCatchupSourcesConfig({ ...(discoveredHouse()?.catchup ?? {}), ...own }) };
  }
  return cachedConfig.config;
}

export function parseCatchupSourcesConfig(raw: unknown): CatchupSourcesConfig {
  const value = recordOrNull(raw) ?? {};
  const people: Record<string, { entityId: string; label: string }> = {};
  for (const [actorId, entry] of Object.entries(recordOrNull(value.people) ?? {})) {
    const person = recordOrNull(entry);
    const entityId = typeof person?.entityId === "string" ? person.entityId.trim() : "";
    const label = typeof person?.label === "string" ? person.label.trim() : "";
    if (actorId.startsWith("person.") && entityId.startsWith("person.") && label) {
      people[actorId] = { entityId, label };
    }
  }
  return {
    people,
    openingLabels: stringRecord(value.openingLabels),
    excludeEntityIds: stringList(value.excludeEntityIds),
    calendars: stringList(value.calendars).filter((id) => id.startsWith("calendar.")),
    problemLabels: stringRecord(value.problemLabels),
    weatherEntityId: typeof value.weatherEntityId === "string" && value.weatherEntityId.startsWith("weather.")
      ? value.weatherEntityId
      : null,
    hotDegrees: typeof value.hotDegrees === "number" ? value.hotDegrees : 30,
    coldDegrees: typeof value.coldDegrees === "number" ? value.coldDegrees : 3,
  };
}

/** The HA person entity for a canonical household actor, only if HA has it. */
export function speakerPersonEntityId(
  actorId: string,
  config: CatchupSourcesConfig,
  services: Pick<CatchupServices, "stateCache">,
): string | null {
  const mapped = config.people[actorId]?.entityId ?? null;
  const cache = services.stateCache;
  if (!cache) {
    return mapped;
  }
  if (mapped && cache.get(mapped)) {
    return mapped;
  }
  // A world whose person entity is literally the actor id needs no mapping.
  return cache.get(actorId) ? actorId : null;
}

export async function buildCatchupDigest(options: {
  readonly scope: CatchupScope;
  readonly actorId: string;
  readonly now: Date;
  /** Start of the current conversation; earlier turns count as "last spoke". */
  readonly sessionStartedAt: Date;
  readonly timezone: string;
  readonly services: CatchupServices;
  readonly config?: CatchupSourcesConfig;
  readonly sourceTimeoutMs?: number;
}): Promise<CatchupBuildResult> {
  const config = options.config ?? loadCatchupSourcesConfig();
  const speakerEntityId = speakerPersonEntityId(options.actorId, config, options.services);
  const window = options.scope === "while_i_was_out"
    ? await awayWindow(options, speakerEntityId)
    : options.scope === "today"
      ? todayWindow(options)
      : lastSpokeWindow(options);
  if ("declined" in window) {
    return {
      status: "declined",
      text: window.declined,
      notes: window.notes,
      sourceEntityIds: speakerEntityId ? [speakerEntityId] : [],
    };
  }

  const timeoutMs = options.sourceTimeoutMs ?? CATCHUP_LIMITS.sourceTimeoutMs;
  const context: SourceContext = {
    window,
    startMs: Date.parse(window.start),
    endMs: Date.parse(window.end),
    actorId: options.actorId,
    config,
    services: options.services,
    timezone: options.timezone,
    now: options.now,
  };
  const readers: readonly [CatchupSource, (context: SourceContext, signal: AbortSignal) => Promise<readonly CatchupItem[] | null>][] = [
    ["people", peopleItems],
    ["openings", openingItems],
    ["weather", weatherItems],
    ["calendar", calendarItems],
    ["energy", energyItems],
    ["devices", deviceItems],
  ];
  const settled = await Promise.all(readers.map(async ([source, read]) => {
    try {
      return { source, items: await withTimeout((signal) => read(context, signal), timeoutMs) };
    } catch {
      return { source, items: undefined };
    }
  }));
  const failures = settled.filter((entry) => entry.items === undefined).map((entry) => entry.source);
  const items = rankItems(settled.flatMap((entry) => entry.items ?? []));
  return {
    status: "ok",
    digest: {
      scope: options.scope,
      window,
      items: items.slice(0, CATCHUP_LIMITS.keptItems),
      failures,
      speakerEntityId,
      builtAt: options.now.toISOString(),
      timezone: options.timezone,
    },
  };
}

export function rankItems(items: readonly CatchupItem[]): readonly CatchupItem[] {
  return [...items].sort((left, right) => right.weight - left.weight || left.at.localeCompare(right.at));
}

export interface CatchupSpeech {
  readonly lead: string;
  readonly entries: readonly string[];
  readonly closing: string | null;
  readonly quiet: boolean;
  readonly text: string;
}

export function renderCatchupSpeech(digest: CatchupDigest, now: Date): CatchupSpeech {
  const tz = digest.timezone;
  const window = digest.window;
  const start = whenLabel(window.start, now, tz);
  const failures = digest.failures.length > 0
    ? `I couldn't check ${joinNatural(digest.failures.map((source) => SOURCE_NAMES[source]), "none")}.`
    : null;
  if (digest.items.length === 0) {
    const quiet = window.basis === "no_recent_contact"
      ? "Quiet all week, as far as I can see."
      : window.basis === "today"
        ? "Quiet today so far, as far as I can see."
      : window.basis === "away" && !window.ongoing
        ? `Quiet while you were out, from ${start} to ${whenLabel(window.end, now, tz)}.`
        : `Quiet since ${start}.`;
    return {
      lead: quiet,
      entries: [],
      closing: failures,
      quiet: true,
      text: [quiet, failures].filter(Boolean).join(" "),
    };
  }
  const lead = window.basis === "no_recent_contact"
    ? "We haven't spoken in over a week, so here's the last seven days."
    : window.basis === "today"
      ? "Today so far:"
    : window.basis === "away"
      ? window.capped
        ? "You've been away over a week. In the last seven days:"
        : window.ongoing
          ? `Since you left at ${start}:`
          : `While you were out, from ${start} to ${whenLabel(window.end, now, tz)}:`
      : `Since we last spoke, at ${start}:`;
  const spoken = digest.items.slice(0, CATCHUP_LIMITS.spokenItems);
  const rest = digest.items.length - spoken.length;
  const entries = spoken.map((item) => item.text);
  const closing = [
    rest > 0 ? `And ${rest} smaller ${rest === 1 ? "thing" : "things"}.` : null,
    failures,
  ].filter(Boolean).join(" ") || null;
  return {
    lead,
    entries,
    closing,
    quiet: false,
    text: [lead, ...entries, closing].filter(Boolean).join(" "),
  };
}

/** Plain fact lines for the open-chat prompt. The model reads these; it never extends them. */
export function catchupDigestFacts(digest: CatchupDigest, now: Date): string {
  const tz = digest.timezone;
  const window = digest.window;
  const lines = [
    `Window: ${whenLabel(window.start, now, tz)} to ${window.ongoing ? "now" : whenLabel(window.end, now, tz)}`
      + ` (${window.basis === "away" ? "while the speaker was out" : window.basis === "last_spoke" ? "since the speaker last spoke to you" : window.basis === "today" ? "today so far" : "the last seven days; no contact before that"}).`,
    ...(digest.items.length > 0
      ? digest.items.map((item) => `- ${item.text}`)
      : ["- Nothing notable."]),
    ...(digest.failures.length > 0
      ? [`Could not check: ${digest.failures.map((source) => SOURCE_NAMES[source]).join(", ")}.`]
      : []),
  ];
  return lines.join("\n");
}

export function catchupSourceEntityIds(digest: CatchupDigest): readonly string[] {
  return [...new Set([
    ...(digest.speakerEntityId ? [digest.speakerEntityId] : []),
    ...digest.items.flatMap((item) => item.sourceEntityIds),
  ])].sort();
}

/**
 * Digests by the turn that carried them, so a follow-up in the same chat
 * ("how long was the garage open?") reads the same facts. RAM only.
 */
export class CatchupDigestCache {
  /** Follow-ups that may carry one digest before chat moves on without it. */
  static readonly maxFollowUps = 3;
  private readonly entries = new Map<string, { readonly digest: CatchupDigest; readonly atMs: number; readonly followUps: number }>();

  constructor(private readonly ttlMs = 30 * 60_000, private readonly limit = 20) {}

  remember(turnId: string, digest: CatchupDigest, now: Date, followUps = 0): void {
    this.entries.delete(turnId);
    this.entries.set(turnId, { digest, atMs: now.getTime(), followUps });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** The digest a follow-up to `turnId` may carry, with its follow-up count, or null. */
  followUp(turnId: string | undefined, now: Date): { readonly digest: CatchupDigest; readonly followUps: number } | null {
    const entry = turnId ? this.entries.get(turnId) : undefined;
    if (!entry || now.getTime() - entry.atMs > this.ttlMs || entry.followUps >= CatchupDigestCache.maxFollowUps) {
      return null;
    }
    return { digest: entry.digest, followUps: entry.followUps + 1 };
  }
}

// --- windows ---------------------------------------------------------------

type WindowOrDecline = CatchupWindow | { readonly declined: string; readonly notes: string };

async function awayWindow(
  options: {
    readonly now: Date;
    readonly timezone: string;
    readonly services: CatchupServices;
  },
  speakerEntityId: string | null,
): Promise<WindowOrDecline> {
  if (!speakerEntityId) {
    return { declined: "I can't see your presence in the house records.", notes: "catch-up: no HA person entity for speaker" };
  }
  if (!options.services.fetchHistory) {
    return { declined: "I can't read presence history just now.", notes: "catch-up: history fetcher unavailable" };
  }
  const capStart = new Date(options.now.getTime() - CATCHUP_LIMITS.capMs);
  let states: readonly HaHistoryState[];
  try {
    const history = await withTimeout((signal) => options.services.fetchHistory!({
      entityIds: [speakerEntityId],
      window: { start: capStart.toISOString(), end: options.now.toISOString(), timezone: options.timezone, label: "last 7 days" },
      significantChangesOnly: false,
      minimalResponse: false,
      includeStartTimeState: true,
      noAttributes: true,
      signal,
    }), CATCHUP_LIMITS.sourceTimeoutMs * 2);
    states = history.states;
  } catch (error) {
    return {
      declined: "I couldn't read your presence history just now.",
      notes: `catch-up: presence history failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const found = latestAwayWindow(entityRows(states, speakerEntityId), options.now);
  if (!found) {
    return { declined: "I can't see a recent time you were out.", notes: `catch-up: no away window for ${speakerEntityId}` };
  }
  // The start-time row carries the window start, so an equal start means "earlier".
  const capped = Date.parse(found.start) <= capStart.getTime();
  return {
    start: capped ? capStart.toISOString() : found.start,
    end: found.end,
    basis: "away",
    capped,
    ongoing: found.ongoing,
  };
}

/** "What's been happening today?": local midnight to now. */
function todayWindow(options: { readonly now: Date; readonly timezone: string }): WindowOrDecline {
  const parsed = parseTimeWindow("today", { now: options.now, timezone: options.timezone });
  const start = parsed.status === "matched" ? parsed.window?.start : undefined;
  if (!start || Date.parse(start) > options.now.getTime()) {
    return { declined: "I can't work out where today started just now.", notes: "catch-up: today window did not parse" };
  }
  return { start, end: options.now.toISOString(), basis: "today", capped: false, ongoing: false };
}

function lastSpokeWindow(options: {
  readonly actorId: string;
  readonly now: Date;
  readonly sessionStartedAt: Date;
  readonly services: CatchupServices;
}): WindowOrDecline {
  if (!options.services.lastSpokeAt) {
    return { declined: "I can't look back at when we last spoke just now.", notes: "catch-up: turn index unavailable" };
  }
  const capStart = new Date(options.now.getTime() - CATCHUP_LIMITS.capMs);
  let last: string | null;
  try {
    last = options.services.lastSpokeAt(options.actorId, options.sessionStartedAt, capStart);
  } catch (error) {
    return {
      declined: "I can't look back at when we last spoke just now.",
      notes: `catch-up: turn index failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!last) {
    return { start: capStart.toISOString(), end: options.now.toISOString(), basis: "no_recent_contact", capped: true, ongoing: false };
  }
  return { start: last, end: options.now.toISOString(), basis: "last_spoke", capped: false, ongoing: false };
}

export function latestAwayWindow(
  rows: readonly HaHistoryState[],
  now: Date,
): { readonly start: string; readonly end: string; readonly ongoing: boolean } | null {
  if (rows.length === 0) {
    return null;
  }
  const last = rows[rows.length - 1] as HaHistoryState;
  if (!isHome(last.state)) {
    const start = awayStart(rows, rows.length - 1);
    return start ? { start, end: now.toISOString(), ongoing: true } : null;
  }
  for (let index = rows.length - 1; index >= 1; index -= 1) {
    const current = rows[index] as HaHistoryState;
    const previous = rows[index - 1] as HaHistoryState;
    if (isHome(current.state) && !isHome(previous.state)) {
      const start = awayStart(rows, index - 1);
      return start ? { start, end: current.lastChanged, ongoing: false } : null;
    }
  }
  return null;
}

function awayStart(rows: readonly HaHistoryState[], awayIndex: number): string | null {
  for (let index = awayIndex; index >= 1; index -= 1) {
    const current = rows[index] as HaHistoryState;
    const previous = rows[index - 1] as HaHistoryState;
    if (!isHome(current.state) && isHome(previous.state)) {
      return current.lastChanged;
    }
  }
  return (rows[awayIndex] as HaHistoryState | undefined)?.lastChanged ?? null;
}

// --- sources ---------------------------------------------------------------

interface SourceContext {
  readonly window: CatchupWindow;
  readonly startMs: number;
  readonly endMs: number;
  readonly actorId: string;
  readonly config: CatchupSourcesConfig;
  readonly services: CatchupServices;
  readonly timezone: string;
  readonly now: Date;
}

/** null: the source has nothing to read here (not a failure). */
async function peopleItems(context: SourceContext, signal: AbortSignal): Promise<readonly CatchupItem[] | null> {
  const others = Object.entries(context.config.people)
    .filter(([actorId]) => actorId !== context.actorId)
    .map(([, person]) => person)
    .filter((person) => !context.services.stateCache || context.services.stateCache.get(person.entityId));
  if (others.length === 0) {
    return null;
  }
  const states = await windowHistory(context, others.map((person) => person.entityId), signal, true);
  const items: CatchupItem[] = [];
  for (const person of others) {
    const moves = transitions(entityRows(states, person.entityId), context)
      .filter((move) => move.from !== null && isHome(move.from) !== isHome(move.to))
      .map((move) => ({ at: move.at, arrived: isHome(move.to) }));
    const first = moves[0];
    const last = moves[moves.length - 1];
    if (!first || !last) {
      continue;
    }
    const firstAt = whenLabel(first.at, context.now, context.timezone);
    const lastAt = whenLabel(last.at, context.now, context.timezone);
    // First and last movement only, never every flap.
    const text = moves.length === 1
      ? `${person.label} ${first.arrived ? "got home" : "went out"} at ${firstAt}.`
      : first.arrived === last.arrived
        ? `${person.label} was in and out, ${last.arrived ? `home by ${lastAt}` : `last leaving at ${lastAt}`}.`
        : first.arrived
          ? `${person.label} got home at ${firstAt} and went out again at ${lastAt}.`
          : `${person.label} went out at ${firstAt} and was back by ${lastAt}.`;
    items.push({ kind: "person", weight: WEIGHTS.person, at: first.at, text, sourceEntityIds: [person.entityId] });
  }
  return items;
}

async function openingItems(context: SourceContext, signal: AbortSignal): Promise<readonly CatchupItem[] | null> {
  const cache = context.services.stateCache;
  if (!cache) {
    return null;
  }
  const excluded = new Set(context.config.excludeEntityIds);
  const sensors = cache.entries().filter((state) => state.entityId.startsWith("binary_sensor.")
    && !excluded.has(state.entityId)
    && OPENING_DEVICE_CLASSES.has(attributeText(state, "device_class").toLowerCase()));
  if (sensors.length === 0) {
    return null;
  }
  const states = await windowHistory(context, sensors.map((sensor) => sensor.entityId), signal, true);
  const items: CatchupItem[] = [];
  for (const sensor of sensors) {
    const label = context.config.openingLabels[sensor.entityId] ?? friendlyName(sensor);
    const intervals = onIntervals(entityRows(states, sensor.entityId), context);
    if (intervals.length === 0) {
      continue;
    }
    const longest = [...intervals].sort((left, right) => (right.endMs - right.startMs) - (left.endMs - left.startMs))[0]!;
    const openedAt = new Date(longest.startMs).toISOString();
    if (longest.endMs - longest.startMs >= CATCHUP_LIMITS.leftOpenMs) {
      const text = longest.stillOn
        ? `${label} has been open since ${whenLabel(openedAt, context.now, context.timezone)}${longest.clippedStart ? " or earlier" : ""}.`
        : `${label} was open for ${durationLabel(longest.endMs - longest.startMs)} from ${whenLabel(openedAt, context.now, context.timezone)}.`;
      items.push({ kind: "opening_left_open", weight: WEIGHTS.opening_left_open, at: openedAt, text, sourceEntityIds: [sensor.entityId] });
      continue;
    }
    const opens = intervals.filter((interval) => !interval.clippedStart);
    if (opens.length === 0) {
      continue;
    }
    const first = new Date(opens[0]!.startMs).toISOString();
    const last = new Date(opens[opens.length - 1]!.startMs).toISOString();
    const text = opens.length === 1
      ? `${label} opened at ${whenLabel(first, context.now, context.timezone)}.`
      : `${label} opened ${countLabel(opens.length)}, first at ${whenLabel(first, context.now, context.timezone)} and last at ${whenLabel(last, context.now, context.timezone)}.`;
    items.push({ kind: "opening", weight: WEIGHTS.opening, at: first, text, sourceEntityIds: [sensor.entityId] });
  }
  return items;
}

async function weatherItems(context: SourceContext, signal: AbortSignal): Promise<readonly CatchupItem[] | null> {
  const entityId = context.config.weatherEntityId;
  if (!entityId || (context.services.stateCache && !context.services.stateCache.get(entityId))) {
    return null;
  }
  if (!context.services.fetchHistory) {
    throw new Error("history unavailable");
  }
  const history = await context.services.fetchHistory({
    entityIds: [entityId],
    window: { start: context.window.start, end: context.window.end, timezone: context.timezone },
    significantChangesOnly: false,
    minimalResponse: false,
    includeStartTimeState: true,
    noAttributes: false,
    signal,
  });
  const rows = entityRows(history.states, entityId, "lastUpdated");
  const items: CatchupItem[] = [];
  const moves = transitions(entityRows(history.states, entityId), context);
  const storm = moves.find((move) => move.from !== null && STORM_STATES.has(move.to) && !STORM_STATES.has(move.from));
  const rain = moves.find((move) => move.from !== null && RAINY_STATES.has(move.to) && !RAINY_STATES.has(move.from));
  if (storm) {
    items.push({ kind: "storm", weight: WEIGHTS.storm, at: storm.at, text: `A storm came through around ${whenLabel(storm.at, context.now, context.timezone)}.`, sourceEntityIds: [entityId] });
  } else if (rain) {
    items.push({ kind: "rain", weight: WEIGHTS.rain, at: rain.at, text: `Rain came through around ${whenLabel(rain.at, context.now, context.timezone)}.`, sourceEntityIds: [entityId] });
  }
  const temperatures = rows
    .map((row) => ({ at: row.lastUpdated, value: row.attributes.temperature }))
    .filter((row): row is { at: string; value: number } => typeof row.value === "number" && Number.isFinite(row.value)
      && Date.parse(row.at) >= context.startMs && Date.parse(row.at) <= context.endMs);
  const hottest = [...temperatures].sort((left, right) => right.value - left.value)[0];
  const coldest = [...temperatures].sort((left, right) => left.value - right.value)[0];
  if (hottest && hottest.value >= context.config.hotDegrees) {
    items.push({ kind: "temperature", weight: WEIGHTS.temperature, at: hottest.at, text: `It got up to ${Math.round(hottest.value)} degrees around ${whenLabel(hottest.at, context.now, context.timezone)}.`, sourceEntityIds: [entityId] });
  }
  if (coldest && coldest.value <= context.config.coldDegrees) {
    items.push({ kind: "temperature", weight: WEIGHTS.temperature, at: coldest.at, text: `It dropped to ${Math.round(coldest.value)} degrees around ${whenLabel(coldest.at, context.now, context.timezone)}.`, sourceEntityIds: [entityId] });
  }
  return items;
}

async function calendarItems(context: SourceContext, signal: AbortSignal): Promise<readonly CatchupItem[] | null> {
  const fetcher = context.services.calendarFetcher;
  const calendars = context.config.calendars
    .filter((entityId) => !context.services.stateCache || context.services.stateCache.get(entityId));
  if (calendars.length === 0) {
    return null;
  }
  if (!fetcher) {
    throw new Error("calendar unavailable");
  }
  const events = await fetcher.fetchEvents({
    entityIds: calendars,
    start: context.window.start,
    end: context.window.end,
    signal,
  });
  const timed = events
    .filter((event) => event.start.includes("T"))
    .filter((event) => {
      const startMs = Date.parse(event.start);
      return Number.isFinite(startMs) && startMs >= context.startMs && startMs <= context.endMs;
    })
    .sort((left, right) => left.start.localeCompare(right.start));
  if (timed.length === 0) {
    return [];
  }
  const named = timed.slice(0, 3).map((event) => `${event.summary.trim()} at ${whenLabel(event.start, context.now, context.timezone)}`);
  const more = timed.length - named.length;
  return [{
    kind: "calendar",
    weight: WEIGHTS.calendar,
    at: timed[0]!.start,
    text: `On the calendar: ${joinNatural(named, "none")}${more > 0 ? `, and ${more} more` : ""}.`,
    sourceEntityIds: [...new Set(timed.map((event) => event.entityId))].sort(),
  }];
}

async function energyItems(context: SourceContext, signal: AbortSignal): Promise<readonly CatchupItem[] | null> {
  const { fetchEnergySources, fetchStatistics } = context.services;
  if (!fetchEnergySources || !fetchStatistics) {
    return null;
  }
  const windowMs = context.endMs - context.startMs;
  if (windowMs < CATCHUP_LIMITS.energyMinWindowMs) {
    return [];
  }
  const sources: HaEnergySources = await fetchEnergySources(signal);
  const ids = [...new Set(sources.gridImport)];
  if (ids.length === 0) {
    return null;
  }
  const scale = energyScale(ids, context);
  if (scale === null) {
    return null;
  }
  const baselineDays = 7;
  const fetchStart = new Date(context.startMs - baselineDays * DAY_MS - 60 * 60_000);
  const result = await fetchStatistics({
    statisticIds: ids,
    window: { start: fetchStart.toISOString(), end: context.window.end, timezone: context.timezone },
    period: "hour",
    types: ["sum"],
    fresh: true,
    signal,
  });
  const used = usageBetween(result.samples, ids, context.startMs, context.endMs);
  if (used === null) {
    return [];
  }
  let expected: number | null;
  if (windowMs <= DAY_MS) {
    const shifted = Array.from({ length: baselineDays }, (_, index) => usageBetween(
      result.samples,
      ids,
      context.startMs - (index + 1) * DAY_MS,
      context.endMs - (index + 1) * DAY_MS,
    )).filter((value): value is number => value !== null);
    expected = shifted.length >= 3 ? shifted.reduce((sum, value) => sum + value, 0) / shifted.length : null;
  } else {
    const before = usageBetween(result.samples, ids, context.startMs - baselineDays * DAY_MS, context.startMs);
    expected = before === null ? null : before * (windowMs / (baselineDays * DAY_MS));
  }
  if (expected === null || expected <= 0) {
    return [];
  }
  const usedKwh = used * scale;
  const expectedKwh = expected * scale;
  const high = usedKwh >= expectedKwh * CATCHUP_LIMITS.energyHighRatio && usedKwh - expectedKwh >= CATCHUP_LIMITS.energyMinDeltaKwh;
  const low = usedKwh <= expectedKwh * CATCHUP_LIMITS.energyLowRatio && expectedKwh - usedKwh >= CATCHUP_LIMITS.energyMinDeltaKwh;
  if (!high && !low) {
    return [];
  }
  return [{
    kind: "energy",
    weight: WEIGHTS.energy,
    at: context.window.start,
    text: `The house drew about ${Math.round(usedKwh)} kilowatt hours from the grid, well ${high ? "above" : "below"} the usual ${Math.round(expectedKwh)} for that stretch.`,
    sourceEntityIds: ids,
  }];
}

async function deviceItems(context: SourceContext, signal: AbortSignal): Promise<readonly CatchupItem[] | null> {
  const cache = context.services.stateCache;
  if (!cache) {
    return null;
  }
  const sensors = cache.entries().filter((state) => state.entityId.startsWith("binary_sensor.")
    && attributeText(state, "device_class").toLowerCase() === "problem"
    && isPhysicalProblemSensor(state.entityId, friendlyName(state)));
  if (sensors.length === 0) {
    return null;
  }
  const states = await windowHistory(context, sensors.map((sensor) => sensor.entityId), signal, true);
  const items: CatchupItem[] = [];
  for (const sensor of sensors) {
    const tripped = onIntervals(entityRows(states, sensor.entityId), context).filter((interval) => !interval.clippedStart);
    const first = tripped[0];
    if (!first) {
      continue;
    }
    const label = context.config.problemLabels[sensor.entityId] ?? friendlyName(sensor);
    const at = new Date(first.startMs).toISOString();
    const still = tripped[tripped.length - 1]!.stillOn;
    items.push({
      kind: "device_problem",
      weight: WEIGHTS.device_problem,
      at,
      text: `${label} went off at ${whenLabel(at, context.now, context.timezone)}${tripped.length > 1 ? `, ${countLabel(tripped.length)} in all` : ""}${still ? ", and it's still on" : ""}.`,
      sourceEntityIds: [sensor.entityId],
    });
  }
  return items;
}

// --- history helpers -------------------------------------------------------

async function windowHistory(
  context: SourceContext,
  entityIds: readonly string[],
  signal: AbortSignal,
  noAttributes: boolean,
): Promise<readonly HaHistoryState[]> {
  if (!context.services.fetchHistory) {
    throw new Error("history unavailable");
  }
  const history = await context.services.fetchHistory({
    entityIds,
    window: { start: context.window.start, end: context.window.end, timezone: context.timezone },
    significantChangesOnly: false,
    minimalResponse: false,
    includeStartTimeState: true,
    noAttributes,
    signal,
  });
  return history.states;
}

function entityRows(
  states: readonly HaHistoryState[],
  entityId: string,
  key: "lastChanged" | "lastUpdated" = "lastChanged",
): readonly HaHistoryState[] {
  return states
    .filter((state) => state.entityId === entityId)
    .sort((left, right) => left[key].localeCompare(right[key]));
}

interface Transition {
  readonly at: string;
  readonly from: string | null;
  readonly to: string;
}

/** State changes that happened inside the window, from the state before each. */
function transitions(rows: readonly HaHistoryState[], context: SourceContext): readonly Transition[] {
  const moves: Transition[] = [];
  let previous: string | null = null;
  for (const row of rows) {
    const atMs = Date.parse(row.lastChanged);
    if (row.state !== previous && Number.isFinite(atMs) && atMs >= context.startMs && atMs <= context.endMs && !unavailable(row.state)) {
      moves.push({ at: row.lastChanged, from: previous, to: row.state });
    }
    if (!unavailable(row.state)) {
      previous = row.state;
    }
  }
  return moves;
}

interface OnInterval {
  readonly startMs: number;
  readonly endMs: number;
  /** Already on when the window opened. */
  readonly clippedStart: boolean;
  /** Still on when the window closed. */
  readonly stillOn: boolean;
}

function onIntervals(rows: readonly HaHistoryState[], context: SourceContext): readonly OnInterval[] {
  const intervals: OnInterval[] = [];
  let openedMs: number | null = null;
  let clipped = false;
  for (const row of rows) {
    const atMs = Date.parse(row.lastChanged);
    if (!Number.isFinite(atMs) || atMs > context.endMs || unavailable(row.state)) {
      continue;
    }
    const on = row.state === "on";
    if (on && openedMs === null) {
      // HA stamps the start-time state with the window start.
      clipped = atMs <= context.startMs;
      openedMs = Math.max(atMs, context.startMs);
    } else if (!on && openedMs !== null) {
      if (atMs >= context.startMs) {
        intervals.push({ startMs: openedMs, endMs: atMs, clippedStart: clipped, stillOn: false });
      }
      openedMs = null;
    }
  }
  if (openedMs !== null) {
    intervals.push({ startMs: openedMs, endMs: context.endMs, clippedStart: clipped, stillOn: true });
  }
  return intervals;
}

function usageBetween(
  samples: readonly HaStatisticSample[],
  ids: readonly string[],
  fromMs: number,
  toMs: number,
): number | null {
  let total = 0;
  for (const id of ids) {
    const rows = samples
      .filter((sample) => sample.statisticId === id && typeof sample.sum === "number")
      .map((sample) => ({ endMs: sample.end ? Date.parse(sample.end) : Date.parse(sample.start) + 60 * 60_000, sum: sample.sum as number }))
      .sort((left, right) => left.endMs - right.endMs);
    const at = (ms: number): number | null => {
      let value: number | null = null;
      for (const row of rows) {
        if (row.endMs > ms) break;
        value = row.sum;
      }
      return value;
    };
    const from = at(fromMs);
    const to = at(toMs);
    if (from === null || to === null || to < from) {
      return null;
    }
    total += to - from;
  }
  return total;
}

function energyScale(ids: readonly string[], context: SourceContext): number | null {
  const units = new Set(ids.map((id) => {
    const unit = context.services.stateCache?.get(id)?.attributes.unit_of_measurement;
    return typeof unit === "string" ? unit.trim() : "kWh";
  }));
  if (units.size !== 1) {
    return null;
  }
  const unit = [...units][0];
  return unit === "kWh" ? 1 : unit === "Wh" ? 0.001 : unit === "MWh" ? 1000 : null;
}

// --- wording ---------------------------------------------------------------

/** "3:40 pm" today, "yesterday 3:40 pm", "Friday 3:40 pm" within the week. */
export function whenLabel(at: string, now: Date, timezone: string): string {
  const date = new Date(at);
  const time = new Intl.DateTimeFormat(HOUSE_LOCALE, { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true })
    .format(date)
    .replace(/\s+/g, " ")
    .replace(/:00(?= )/, "")
    .toLowerCase();
  const dayKey = (value: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
  const today = dayKey(now);
  const day = dayKey(date);
  if (day === today) {
    return time;
  }
  if (day === dayKey(new Date(now.getTime() - DAY_MS))) {
    return `yesterday ${time}`;
  }
  const weekday = new Intl.DateTimeFormat(HOUSE_LOCALE, { timeZone: timezone, weekday: "long" }).format(date);
  return `${weekday} ${time}`;
}

function durationLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    return `${minutes} minutes`;
  }
  const halfHours = Math.round(minutes / 30);
  const hours = Math.floor(halfHours / 2);
  const half = halfHours % 2 === 1;
  if (hours >= 24) {
    const days = Math.round(minutes / (24 * 60));
    return days === 1 ? "about a day" : `about ${days} days`;
  }
  return `${half ? "about " : ""}${hours === 1 && !half ? "an hour" : `${hours}${half ? " and a half" : ""} ${hours === 1 && !half ? "hour" : "hours"}`}`;
}

function countLabel(count: number): string {
  return count === 2 ? "twice" : `${count} times`;
}

// --- small utilities -------------------------------------------------------

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function isHome(state: string): boolean {
  const normalized = state.trim().toLowerCase();
  return normalized === "home";
}

function unavailable(state: string): boolean {
  const normalized = state.trim().toLowerCase();
  return normalized === "" || normalized === "unknown" || normalized === "unavailable";
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(recordOrNull(value) ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== ""));
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}
