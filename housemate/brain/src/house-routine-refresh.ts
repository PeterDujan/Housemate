import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AppConfig } from "./config.js";
import type { HaHistoryState } from "./ha-history.js";
import { parseHousePatternCatalog, zonedLocalDateTime } from "./house-pattern-catalog.js";
import { localDate, zonedDateTimeParts } from "./zoned-time.js";
import { HOUSE_TIME_ZONE } from "./house-config.js";

/**
 * Rebuilds the reviewed household routines (`config/house-patterns.json` shape)
 * from Home Assistant history. The source-controlled catalogue is the spec: it
 * fixes which routines exist, their subjects, wording terms and commitments.
 * This module only recomputes evidence, data, answers and validity, so a refresh
 * can never invent a new routine or a new personal claim.
 *
 * HA keeps about ten days of history, so person routines carry the previous
 * catalogue's samples forward until they age out. A routine whose evidence fails
 * its gate is dropped and the assistant declines it, rather than repeating stale times.
 */
export const ROUTINE_REFRESH_LIMITS = Object.freeze({
  sampleMaxAgeDays: 42,
  validDays: 14,
  minSamples: 3,
  highConfidenceSamples: 5,
  highConfidenceSpreadMinutes: 30,
  maxSpreadMinutes: { departure: 45, return: 60, school: 45 },
  shiftGapMs: 3 * 60 * 60_000,
  maxDetourMs: 15 * 60_000,
  maxCommuteMs: 6 * 60 * 60_000,
  minSchoolDayMs: 4 * 60 * 60_000,
  lightDays: 9,
  minLightDays: 7,
  minActiveLightDays: 5,
});

type RawPattern = Record<string, unknown> & {
  readonly id: string;
  readonly subject: { readonly label: string };
  readonly evidence: { readonly sourceEntityIds: readonly string[]; readonly samples?: readonly string[]; readonly operatorConfirmedAt?: string; readonly claimBoundary?: string };
  readonly upcomingCommitment?: unknown;
};

export interface RawRoutineCatalog {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly timezone: string;
  readonly sourcePolicy: string;
  readonly patterns: readonly RawPattern[];
}

export interface RoutineRefreshResult {
  readonly catalog: RawRoutineCatalog;
  readonly kept: readonly string[];
  readonly dropped: readonly { readonly id: string; readonly reason: string }[];
}

interface Sample {
  readonly date: string;
  readonly minutes: number;
  readonly endMinutes?: number;
}

interface Built {
  readonly confidence: { readonly score: number; readonly band: "medium" | "high"; readonly reason: string };
  readonly evidence: RawPattern["evidence"] & Record<string, unknown>;
  readonly data: Record<string, unknown>;
  readonly answers: Record<string, unknown>;
}

interface Context {
  readonly timezone: string;
  readonly windowEnd: Date;
  readonly cutoffDate: string;
  readonly states: ReadonlyMap<string, readonly HaHistoryState[]>;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const MON_TO_THU: readonly string[] = ["mon", "tue", "wed", "thu"];
const SCHOOL_DAYS: readonly string[] = ["mon", "tue", "wed", "thu", "fri"];
const NUMBER_WORDS = ["none", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

class GateFailure extends Error {}

/** Refresh methods by the pattern kind, the last part of its id (`person.sam.work_departure`). */
const BUILDERS: Readonly<Record<string, (pattern: RawPattern, context: Context, previous: RawPattern | undefined) => Built>> = {
  work_departure: buildWorkDeparture,
  return_home_from_work: buildReturnFromWork,
  school_window: buildSchoolWindow,
  daily_usage: buildLightUsage,
  zone_departure: (pattern, context, previous) => buildZoneTrip(pattern, context, previous, "departure"),
  zone_return: (pattern, context, previous) => buildZoneTrip(pattern, context, previous, "return"),
};

export function refreshHouseRoutines(input: {
  readonly spec: RawRoutineCatalog;
  readonly previous: RawRoutineCatalog | null;
  readonly states: readonly HaHistoryState[];
  readonly now: Date;
}): RoutineRefreshResult {
  const { spec, now } = input;
  const timezone = spec.timezone;
  const today = localDate(now, timezone);
  const windowEnd = zonedLocalDateTime(today, "00:00", timezone) ?? now;
  const context: Context = {
    timezone,
    windowEnd,
    cutoffDate: shiftDate(today, -ROUTINE_REFRESH_LIMITS.sampleMaxAgeDays),
    states: groupStates(input.states, windowEnd),
  };
  const previousById = new Map((input.previous?.patterns ?? []).map((pattern) => [pattern.id, pattern]));
  const patterns: RawPattern[] = [];
  const kept: string[] = [];
  const dropped: { id: string; reason: string }[] = [];
  for (const pattern of spec.patterns) {
    const builder = BUILDERS[pattern.id.split(".").pop() ?? ""];
    if (!builder) {
      dropped.push({ id: pattern.id, reason: "no refresh method" });
      continue;
    }
    try {
      const built = builder(pattern, context, previousById.get(pattern.id));
      const { upcomingCommitment, ...rest } = pattern;
      patterns.push({
        ...rest,
        validFrom: today,
        validThrough: shiftDate(today, ROUTINE_REFRESH_LIMITS.validDays),
        ...(upcomingCommitment !== undefined && built.confidence.band === "high" ? { upcomingCommitment } : {}),
        ...built,
      } as RawPattern);
      kept.push(pattern.id);
    } catch (error) {
      if (!(error instanceof GateFailure)) throw error;
      dropped.push({ id: pattern.id, reason: error.message });
    }
  }
  const catalog: RawRoutineCatalog = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    timezone,
    sourcePolicy: spec.sourcePolicy,
    patterns,
  };
  parseHousePatternCatalog(catalog);
  return { catalog, kept, dropped };
}

export type RoutineHistoryFetch = (entityIds: readonly string[], start: Date, end: Date) => Promise<readonly HaHistoryState[]>;

/**
 * Refreshes the runtime override `<dataDir>/patterns/house-patterns.json`, which
 * the catalogue loader prefers over the source-controlled file. Nothing is
 * written when HA returns no history, so a failed run keeps the last catalogue.
 */
export async function runHouseRoutineRefresh(options: {
  readonly config: Pick<AppConfig, "dataDir">;
  readonly fetchStates: RoutineHistoryFetch;
  readonly now: Date;
  readonly dryRun?: boolean;
  /** The people the house linked to HA (for routines found by themselves). */
  readonly people?: readonly RoutinePerson[];
}): Promise<RoutineRefreshResult & { readonly outputPath: string; readonly written: boolean }> {
  const outputPath = join(options.config.dataDir, "patterns", "house-patterns.json");
  // The house's reviewed routines are both the spec and the previous run. A house without any of its
  // own (or whose last catalogue was found by itself) finds its routines afresh from who goes where.
  const specPath = process.env.JARVIS_V5_HOUSE_PATTERNS_PATH?.trim() || outputPath;
  const own = existsSync(specPath) ? JSON.parse(readFileSync(specPath, "utf8")) as RawRoutineCatalog : null;
  const previous = existsSync(outputPath) ? JSON.parse(readFileSync(outputPath, "utf8")) as RawRoutineCatalog : own;
  const start = new Date(options.now.getTime() - 14 * 86_400_000);
  let spec: RawRoutineCatalog;
  let states: readonly HaHistoryState[];
  if (own && own.sourcePolicy !== AUTO_ROUTINE_POLICY) {
    spec = own;
    states = await options.fetchStates([...new Set(spec.patterns.flatMap((pattern) => pattern.evidence.sourceEntityIds))], start, options.now);
  } else {
    const people = (options.people ?? []).filter((person) => person.haPerson);
    states = people.length ? await options.fetchStates(people.map((person) => person.haPerson as string), start, options.now) : [];
    spec = autoRoutineSpec(people, states, HOUSE_TIME_ZONE, previous);
  }
  if (states.length === 0) throw new Error("Home Assistant returned no history; keeping the current routines");
  const result = refreshHouseRoutines({ spec, previous, states, now: options.now });
  if (options.dryRun) return { ...result, outputPath, written: false };
  mkdirSync(join(options.config.dataDir, "patterns"), { recursive: true });
  const temporary = `${outputPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(result.catalog, null, 2)}\n`);
  renameSync(temporary, outputPath);
  return { ...result, outputPath, written: true };
}

function buildWorkDeparture(pattern: RawPattern, context: Context, previous: RawPattern | undefined): Built {
  const { departures, freshFrom } = scanWorkShifts(entityStates(pattern, context), context.timezone);
  const samples = mergeSamples(departures, freshFrom, previous, context);
  const weekday = samples.filter((sample) => MON_TO_THU.includes(weekdayOf(sample.date)));
  const sunday = samples.filter((sample) => weekdayOf(sample.date) === "sun");
  const weekdayStats = timeStats(weekday, "departure", "Monday-to-Thursday departures");
  const sundayStats = sunday.length >= ROUTINE_REFRESH_LIMITS.minSamples
    && spread(sunday) <= ROUTINE_REFRESH_LIMITS.maxSpreadMinutes.departure ? timeStats(sunday, "departure", "") : null;
  const used = [...weekday, ...(sundayStats ? sunday : [])].sort(bySample);
  const name = pattern.subject.label;
  const weekdayLine = (subject: string, verb: string) =>
    `${subject} ${verb} for work at about ${clock(weekdayStats.typical)} on Monday-to-Thursday shifts; ${words(weekday.length)} observed departures were between ${clockRange(weekdayStats.start, weekdayStats.end)}.`;
  const sundayLine = sundayStats
    ? ` ${capital(words(sunday.length))} Sunday shifts were ${sundayStats.typical < weekdayStats.typical ? "earlier" : "later"}, around ${clock(sundayStats.typical)}.`
    : "";
  const confirmed = sundayStats && pattern.evidence.operatorConfirmedAt ? ` ${name} previously confirmed that shift split.` : "";
  return {
    confidence: confidenceFor(weekday, `${capital(words(weekday.length))} Monday-to-Thursday departures within ${spread(weekday)} minutes${sundayStats ? ` and ${words(sunday.length)} Sunday departures` : ""}, ${dateRange(used)}.`),
    evidence: personEvidence(pattern, used, "Home-to-away transitions followed by Work, deduplicating later Work re-entry during the same shift and leaving out trips that stopped elsewhere for more than 15 minutes.", context.timezone),
    data: {
      type: "time_of_day_by_cohort",
      cohorts: [
        cohort("weekday_evening", "Monday to Thursday workdays", MON_TO_THU, weekday.length, weekdayStats),
        ...(sundayStats ? [cohort("sunday", "Sunday shifts", ["sun"], sunday.length, sundayStats)] : []),
      ],
    },
    answers: {
      default: weekdayLine(name, "usually leaves") + sundayLine,
      firstPerson: weekdayLine("You", "usually leave") + sundayLine,
      evidence: `That is based on ${words(used.length)} Home Assistant presence sequences ${dateRange(used)}: ${words(weekday.length)} Monday-to-Thursday departures between ${clockRange(weekdayStats.start, weekdayStats.end)}${sundayStats ? `, and ${words(sunday.length)} Sunday departures between ${clockRange(sundayStats.start, sundayStats.end)}` : ""}. Trips that stopped somewhere else on the way are left out.${confirmed}`,
      variants: [
        ...(sundayStats ? [{
          selectorTerms: ["sunday"],
          text: `On ${words(sunday.length)} observed Sunday shifts, ${name} left for work between ${clockRange(sundayStats.start, sundayStats.end)}, with a median of ${clock(sundayStats.typical)}.`,
          firstPersonText: `On your ${words(sunday.length)} observed Sunday shifts, you left for work between ${clockRange(sundayStats.start, sundayStats.end)}, with a median of ${clock(sundayStats.typical)}.`,
        }] : []),
        {
          selectorTerms: ["weekday", "weekdays", "monday", "tuesday", "wednesday", "thursday"],
          text: `On ${words(weekday.length)} observed Monday-to-Thursday shifts, ${name} left for work between ${clockRange(weekdayStats.start, weekdayStats.end)}, with a median of ${clock(weekdayStats.typical)}.`,
          firstPersonText: `On your ${words(weekday.length)} observed Monday-to-Thursday shifts, you left for work between ${clockRange(weekdayStats.start, weekdayStats.end)}, with a median of ${clock(weekdayStats.typical)}.`,
        },
      ],
    },
  };
}

function buildReturnFromWork(pattern: RawPattern, context: Context, previous: RawPattern | undefined): Built {
  const { returns, freshFrom } = scanWorkShifts(entityStates(pattern, context), context.timezone);
  const samples = mergeSamples(returns, freshFrom, previous, context);
  const stats = timeStats(samples, "return", "post-work returns");
  const line = (subject: string, verb: string) =>
    `After Monday-to-Thursday night shifts, ${subject} ${verb} home around ${clock(stats.typical)}; ${words(samples.length)} observed returns were between ${clockRange(stats.start, stats.end)}.`;
  return {
    confidence: confidenceFor(samples, `${capital(words(samples.length))} post-work returns within ${spread(samples)} minutes, ${dateRange(samples)}.`),
    evidence: personEvidence(pattern, samples, "First Home transition after the end of each Monday-to-Thursday Work shift.", context.timezone),
    data: { type: "time_of_day", sampleCount: samples.length, typicalTime: hhmm(stats.typical), rangeStart: hhmm(stats.start), rangeEnd: hhmm(stats.end) },
    answers: {
      default: line(pattern.subject.label, "usually gets"),
      firstPerson: line("you", "usually get"),
      evidence: `That uses ${words(samples.length)} first-home arrivals after a Monday-to-Thursday Work shift, ${dateRange(samples)}.`,
      variants: [],
    },
  };
}

function buildSchoolWindow(pattern: RawPattern, context: Context, previous: RawPattern | undefined): Built {
  const states = entityStates(pattern, context);
  const episodes: Sample[] = [];
  let entered: HaHistoryState | null = null;
  for (const state of states) {
    if (state.state === "School") {
      entered ??= state;
      continue;
    }
    if (entered) {
      const start = Date.parse(entered.lastChanged);
      const end = Date.parse(state.lastChanged);
      const date = localDate(new Date(start), context.timezone);
      if (end - start >= ROUTINE_REFRESH_LIMITS.minSchoolDayMs && SCHOOL_DAYS.includes(weekdayOf(date))
        && localDate(new Date(end), context.timezone) === date) {
        episodes.push({ date, minutes: minutesOf(start, context.timezone), endMinutes: minutesOf(end, context.timezone) });
      }
      entered = null;
    }
  }
  const samples = mergeSamples(episodes, freshFromStates(states, context.timezone), previous, context);
  const arrive = timeStats(samples, "school", "school arrivals");
  const leave = timeStats(samples.map((sample) => ({ date: sample.date, minutes: sample.endMinutes ?? NaN })), "school", "school departures");
  const name = pattern.subject.label;
  return {
    confidence: confidenceFor(samples, `${capital(words(samples.length))} full school days with arrivals within ${arrive.end - arrive.start} minutes, ${dateRange(samples)}.`),
    evidence: personEvidence(pattern, samples, "Direct School zone entry and exit on weekdays, keeping visits of at least four hours and leaving out shorter visits.", context.timezone),
    data: {
      type: "time_window",
      days: SCHOOL_DAYS,
      sampleCount: samples.length,
      typicalStart: hhmm(arrive.typical),
      startRange: `${hhmm(arrive.start)}-${hhmm(arrive.end)}`,
      typicalEnd: hhmm(leave.typical),
      endRange: `${hhmm(leave.start)}-${hhmm(leave.end)}`,
    },
    answers: {
      default: `On school days, ${name} usually reaches School around ${clock(arrive.typical)} and leaves around ${clock(leave.typical)}. Across ${words(samples.length)} full school days ${dateRange(samples)}, arrivals ranged from ${clockRange(arrive.start, arrive.end, "to")} and departures from ${clockRange(leave.start, leave.end, "to")}.`,
      evidence: `That is based on ${words(samples.length)} weekday School zone visits of at least four hours ${dateRange(samples)}. Shorter visits are left out rather than counted as school days.`,
      variants: [
        {
          selectorTerms: ["arrive", "arrives", "arrival", "start", "starts", "drop", "dropoff"],
          text: `Across ${words(samples.length)} full school days ${dateRange(samples)}, ${name} reached School between ${clockRange(arrive.start, arrive.end)}, with a median arrival of ${clock(arrive.typical)}.`,
        },
        {
          selectorTerms: ["leave", "leaves", "finish", "finishes", "pickup", "pick"],
          text: `Across ${words(samples.length)} full school days ${dateRange(samples)}, ${name} left School between ${clockRange(leave.start, leave.end)}, with a median departure of ${clock(leave.typical)}.`,
        },
      ],
    },
  };
}

function buildLightUsage(pattern: RawPattern, context: Context): Built {
  const entityIds = pattern.evidence.sourceEntityIds;
  const perEntity = entityIds.map((entityId) => onIntervals(context.states.get(entityId) ?? [], context.windowEnd));
  const coveredFrom = Math.max(...entityIds.map((entityId) => firstChangeMs(context.states.get(entityId) ?? [])));
  const days: { readonly date: string; readonly minutes: number }[] = [];
  let unionMs = 0;
  let overlapMs = 0;
  for (let back = ROUTINE_REFRESH_LIMITS.lightDays; back >= 1; back -= 1) {
    const date = shiftDate(localDate(context.windowEnd, context.timezone), -back);
    const start = zonedLocalDateTime(date, "00:00", context.timezone)?.getTime() ?? NaN;
    const end = zonedLocalDateTime(shiftDate(date, 1), "00:00", context.timezone)?.getTime() ?? NaN;
    if (!(start >= coveredFrom)) continue;
    const clipped = perEntity.map((intervals) => clip(intervals, start, end));
    const union = mergeIntervals(clipped.flat());
    const dayMs = total(union);
    unionMs += dayMs;
    if (clipped.length === 2) overlapMs += total(intersect(clipped[0] ?? [], clipped[1] ?? []));
    days.push({ date, minutes: Math.round(dayMs / 60_000) });
  }
  const active = days.filter((day) => day.minutes > 0);
  if (days.length < ROUTINE_REFRESH_LIMITS.minLightDays) throw new GateFailure(`only ${days.length} complete days of history`);
  if (active.length < ROUTINE_REFRESH_LIMITS.minActiveLightDays) throw new GateFailure(`active on only ${active.length} of ${days.length} days`);
  const activeMinutes = active.map((day) => day.minutes).sort((a, b) => a - b);
  const median = activeMinutes[Math.floor((activeMinutes.length - 1) / 2)] ?? 0;
  const mean = Math.round(activeMinutes.reduce((sum, value) => sum + value, 0) / activeMinutes.length);
  const allMinutes = days.map((day) => day.minutes);
  const low = Math.min(...allMinutes);
  const high = Math.max(...allMinutes);
  const overlap = entityIds.length === 2 && unionMs > 0 ? Math.round((overlapMs / unionMs) * 100) : null;
  const label = pattern.subject.label.toLowerCase();
  const verb = label.endsWith("s") ? "were" : "was";
  const range = `${dateText(days[0]?.date ?? "")} to ${dateText(days.at(-1)?.date ?? "")}`;
  return {
    confidence: {
      score: 0.8,
      band: "medium",
      reason: `${capital(words(days.length))} complete days from ${range}, active on ${words(active.length)}; daily duration varies.`,
    },
    evidence: {
      source: "home_assistant_history",
      sourceEntityIds: entityIds,
      windowStart: new Date(zonedLocalDateTime(days[0]?.date ?? "", "00:00", context.timezone) ?? context.windowEnd).toISOString(),
      windowEnd: context.windowEnd.toISOString(),
      method: "Integrated on-state duration for complete local days; partial boundary days excluded.",
      sampleCount: days.length,
      samples: [
        `${active.length} of ${days.length} days active`,
        `median ${durationShort(median)}`,
        `mean ${durationShort(mean)}`,
        ...(overlap !== null ? [`${overlap}% overlap while either group was on`] : []),
        `range ${durationShort(low)}-${durationShort(high)}`,
      ],
      ...(pattern.evidence.claimBoundary ? { claimBoundary: pattern.evidence.claimBoundary } : {}),
    },
    data: { type: "daily_duration", observedDays: days.length, daysActive: active.length, medianDurationMinutes: median, meanDurationMinutes: mean, rangeMinutes: [low, high] },
    answers: {
      default: `Across ${words(days.length)} complete recent days, the ${label} ${verb} on during ${words(active.length)} days for a median of about ${durationText(median)}. Daily use ranged from ${low === 0 ? "none" : `about ${durationText(low)}`} to about ${durationText(high)}.`,
      evidence: `That comes from integrating ${entityIds.join(" and ")} over ${words(days.length)} complete days from ${range}.${overlap !== null ? ` They overlapped for ${overlap}% of the time either was on.` : ""} The data cannot identify who turned them on.`,
      variants: [],
    },
  };
}

/** One pass over a person's zone history: departures from home into a Work shift, and the first return home after it. */
function scanWorkShifts(states: readonly HaHistoryState[], timezone: string): {
  readonly departures: readonly Sample[];
  readonly returns: readonly Sample[];
  readonly freshFrom: string | null;
} {
  const departures: Sample[] = [];
  const returns: Sample[] = [];
  let homeExit: number | null = null;
  let detoured = false;
  let shiftStart: number | null = null;
  let lastWorkExit = -Infinity;
  let previous: HaHistoryState | null = null;
  for (const state of states) {
    if (previous && previous.state === state.state) continue;
    const at = Date.parse(state.lastChanged);
    if (previous) {
      const prior = previous.state;
      const stayedMs = at - Date.parse(previous.lastChanged);
      if (prior === "home") {
        homeExit = at;
        detoured = false;
      } else if (prior === "Work") {
        lastWorkExit = at;
      } else if (prior !== "not_home" && homeExit !== null && stayedMs > ROUTINE_REFRESH_LIMITS.maxDetourMs) {
        detoured = true;
      }
    }
    if (state.state === "Work" && previous?.state !== "Work" && at - lastWorkExit >= ROUTINE_REFRESH_LIMITS.shiftGapMs) {
      if (homeExit !== null && !detoured && at - homeExit <= ROUTINE_REFRESH_LIMITS.shiftGapMs) {
        departures.push(sampleAt(homeExit, timezone));
      }
      shiftStart = at;
      homeExit = null;
    }
    if (state.state === "home") {
      if (shiftStart !== null && lastWorkExit > shiftStart && at - lastWorkExit <= ROUTINE_REFRESH_LIMITS.maxCommuteMs
        && MON_TO_THU.includes(weekdayOf(localDate(new Date(shiftStart), timezone)))) {
        returns.push(sampleAt(at, timezone));
      }
      shiftStart = null;
      homeExit = null;
    }
    previous = state;
  }
  return { departures, returns, freshFrom: freshFromStates(states, timezone) };
}

/** Fresh history wins from the first day HA still holds; older previous samples carry forward until they age out. */
function mergeSamples(fresh: readonly Sample[], freshFrom: string | null, previous: RawPattern | undefined, context: Context): readonly Sample[] {
  const carried = (previous?.evidence.samples ?? [])
    .map(parseSample)
    .filter((sample): sample is Sample => sample !== null)
    .filter((sample) => sample.date >= context.cutoffDate && (freshFrom === null || sample.date < freshFrom));
  return [...carried, ...fresh.filter((sample) => sample.date >= context.cutoffDate)].sort(bySample);
}

function timeStats(samples: readonly Sample[], kind: keyof typeof ROUTINE_REFRESH_LIMITS.maxSpreadMinutes, label: string): {
  readonly typical: number;
  readonly start: number;
  readonly end: number;
} {
  if (samples.length < ROUTINE_REFRESH_LIMITS.minSamples) {
    throw new GateFailure(`only ${samples.length} ${label} in the last ${ROUTINE_REFRESH_LIMITS.sampleMaxAgeDays} days`);
  }
  if (spread(samples) > ROUTINE_REFRESH_LIMITS.maxSpreadMinutes[kind]) {
    throw new GateFailure(`${label} spread ${spread(samples)} minutes`);
  }
  const sorted = samples.map((sample) => sample.minutes).sort((a, b) => a - b);
  return { typical: sorted[Math.floor((sorted.length - 1) / 2)] ?? 0, start: sorted[0] ?? 0, end: sorted.at(-1) ?? 0 };
}

function confidenceFor(samples: readonly Sample[], reason: string): Built["confidence"] {
  const high = samples.length >= ROUTINE_REFRESH_LIMITS.highConfidenceSamples
    && spread(samples) <= ROUTINE_REFRESH_LIMITS.highConfidenceSpreadMinutes;
  return { score: high ? 0.9 : 0.75, band: high ? "high" : "medium", reason };
}

function personEvidence(pattern: RawPattern, samples: readonly Sample[], method: string, timezone: string): Built["evidence"] {
  const dayStart = (date: string) => (zonedLocalDateTime(date, "00:00", timezone) ?? new Date(NaN)).getTime();
  return {
    source: "home_assistant_history",
    sourceEntityIds: pattern.evidence.sourceEntityIds,
    windowStart: new Date(dayStart(samples[0]?.date ?? "")).toISOString(),
    windowEnd: new Date(dayStart(shiftDate(samples.at(-1)?.date ?? "", 1)) - 1_000).toISOString(),
    method,
    sampleCount: samples.length,
    ...(pattern.evidence.operatorConfirmedAt ? { operatorConfirmedAt: pattern.evidence.operatorConfirmedAt } : {}),
    samples: samples.map(formatSample),
  };
}

function cohort(id: string, label: string, days: readonly string[], sampleCount: number, stats: ReturnType<typeof timeStats>) {
  return { id, label, days, sampleCount, typicalTime: hhmm(stats.typical), rangeStart: hhmm(stats.start), rangeEnd: hhmm(stats.end) };
}

function groupStates(states: readonly HaHistoryState[], windowEnd: Date): ReadonlyMap<string, readonly HaHistoryState[]> {
  const grouped = new Map<string, HaHistoryState[]>();
  for (const state of states) {
    if (Date.parse(state.lastChanged) >= windowEnd.getTime()) continue;
    grouped.set(state.entityId, [...(grouped.get(state.entityId) ?? []), state]);
  }
  for (const list of grouped.values()) list.sort((a, b) => Date.parse(a.lastChanged) - Date.parse(b.lastChanged));
  return grouped;
}

function entityStates(pattern: RawPattern, context: Context): readonly HaHistoryState[] {
  const entityId = pattern.evidence.sourceEntityIds[0] ?? "";
  const states = context.states.get(entityId) ?? [];
  if (states.length === 0) throw new GateFailure(`no history for ${entityId}`);
  return states;
}

function freshFromStates(states: readonly HaHistoryState[], timezone: string): string | null {
  const first = states[0];
  return first ? localDate(new Date(first.lastChanged), timezone) : null;
}

function firstChangeMs(states: readonly HaHistoryState[]): number {
  return states[0] ? Date.parse(states[0].lastChanged) : Infinity;
}

type Interval = readonly [number, number];

function onIntervals(states: readonly HaHistoryState[], windowEnd: Date): readonly Interval[] {
  const intervals: Interval[] = [];
  states.forEach((state, index) => {
    if (state.state !== "on") return;
    const next = states[index + 1];
    intervals.push([Date.parse(state.lastChanged), next ? Date.parse(next.lastChanged) : windowEnd.getTime()]);
  });
  return intervals;
}

function clip(intervals: readonly Interval[], start: number, end: number): Interval[] {
  return intervals
    .map(([from, to]): Interval => [Math.max(from, start), Math.min(to, end)])
    .filter(([from, to]) => to > from);
}

function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const merged: [number, number][] = [];
  for (const [from, to] of [...intervals].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  return a.flatMap(([from, to]) => clip(b, from, to));
}

function total(intervals: readonly Interval[]): number {
  return intervals.reduce((sum, [from, to]) => sum + to - from, 0);
}

function sampleAt(ms: number, timezone: string): Sample {
  return { date: localDate(new Date(ms), timezone), minutes: minutesOf(ms, timezone) };
}

function minutesOf(ms: number, timezone: string): number {
  const parts = zonedDateTimeParts(new Date(ms), timezone);
  return parts.hour * 60 + parts.minute;
}

function parseSample(text: string): Sample | null {
  const match = /^(\d{4}-\d{2}-\d{2}) \w{3} (\d{2}):(\d{2})(?:-(\d{2}):(\d{2}))?$/.exec(text);
  if (!match) return null;
  return {
    date: match[1] ?? "",
    minutes: Number(match[2]) * 60 + Number(match[3]),
    ...(match[4] !== undefined ? { endMinutes: Number(match[4]) * 60 + Number(match[5]) } : {}),
  };
}

function formatSample(sample: Sample): string {
  const day = weekdayOf(sample.date);
  const end = sample.endMinutes !== undefined ? `-${hhmm(sample.endMinutes)}` : "";
  return `${sample.date} ${day.charAt(0).toUpperCase()}${day.slice(1)} ${hhmm(sample.minutes)}${end}`;
}

function bySample(a: Sample, b: Sample): number {
  return a.date.localeCompare(b.date) || a.minutes - b.minutes;
}

function spread(samples: readonly Sample[]): number {
  const minutes = samples.map((sample) => sample.minutes);
  return Math.max(...minutes) - Math.min(...minutes);
}

function weekdayOf(date: string): string {
  return WEEKDAYS[new Date(`${date}T12:00:00.000Z`).getUTCDay()] ?? "";
}

function shiftDate(date: string, days: number): string {
  const cursor = new Date(`${date}T12:00:00.000Z`);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return cursor.toISOString().slice(0, 10);
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function clock(minutes: number): string {
  return `${clockDigits(minutes)} ${minutes < 720 ? "AM" : "PM"}`;
}

function clockDigits(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 12 || 12;
  return `${hour}:${String(minutes % 60).padStart(2, "0")}`;
}

function clockRange(start: number, end: number, joiner = "and"): string {
  return (start < 720) === (end < 720)
    ? `${clockDigits(start)} ${joiner} ${clock(end)}`
    : `${clock(start)} ${joiner} ${clock(end)}`;
}

function dateText(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  return `${day} ${MONTHS[(month ?? 1) - 1]}`;
}

function dateRange(samples: readonly Sample[]): string {
  return `from ${dateText(samples[0]?.date ?? "")} to ${dateText(samples.at(-1)?.date ?? "")}`;
}

function words(count: number): string {
  return NUMBER_WORDS[count] ?? String(count);
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function durationText(minutes: number): string {
  const rounded = Math.round(minutes / 15) * 15;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  if (hours === 0) return `${rest} minutes`;
  const hourText = `${hours} hour${hours === 1 ? "" : "s"}`;
  return rest === 0 ? hourText : `${hourText} ${rest} minutes`;
}

function durationShort(minutes: number): string {
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

// --- Routines found by themselves -------------------------------------

/** Marks a catalogue found by itself, so the next refresh looks again instead of keeping its list. */
export const AUTO_ROUTINE_POLICY = "Found by Housemate from Home Assistant presence history.";

export interface RoutinePerson {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly haPerson: string | null;
}

const NOT_PLACES = new Set(["home", "not_home", "unknown", "unavailable", "away"]);
const LEAVE_TERMS = ["leave", "leaves", "leaving", "depart", "departs", "departing", "go", "goes", "going", "head", "heads", "heading"];
const RETURN_TERMS = ["home", "return", "returns", "returning", "back", "arrive", "arrives", "arriving"];
const WEEKDAY_SET: readonly string[] = ["mon", "tue", "wed", "thu", "fri"];
const WEEKEND_SET: readonly string[] = ["sat", "sun"];

/**
 * Each linked person's regular places: any HA zone they were in on three or more days of the last
 * two weeks becomes a "leaves for" and a "gets home from" routine. The refresh then keeps only the
 * ones whose times hold together; earlier samples carry forward from the previous catalogue.
 */
export function autoRoutineSpec(people: readonly RoutinePerson[], states: readonly HaHistoryState[], timezone: string, previous: RawRoutineCatalog | null): RawRoutineCatalog {
  const patterns: RawPattern[] = [];
  for (const person of people) {
    const own = states.filter((state) => state.entityId === person.haPerson);
    const days = new Map<string, Set<string>>();
    for (const state of own) {
      if (NOT_PLACES.has(state.state.toLowerCase())) continue;
      const place = days.get(state.state) ?? new Set<string>();
      place.add(localDate(new Date(state.lastChanged), timezone));
      days.set(state.state, place);
    }
    // A place seen before (in the previous catalogue) stays a candidate while its samples last.
    for (const pattern of previous?.patterns ?? []) {
      const place = (pattern as { place?: { state?: unknown } }).place?.state;
      if (pattern.id.startsWith(`${person.id}.`) && typeof place === "string" && !days.has(place)) days.set(place, new Set(["carried"]));
    }
    for (const [place, seen] of days) {
      if (seen.size < ROUTINE_REFRESH_LIMITS.minSamples && !seen.has("carried")) continue;
      patterns.push(...zonePatterns(person, place));
    }
  }
  return { schemaVersion: 1, generatedAt: new Date(0).toISOString(), timezone, sourcePolicy: AUTO_ROUTINE_POLICY, patterns };
}

function zonePatterns(person: RoutinePerson, place: string): RawPattern[] {
  const label = placeLabel(place);
  const key = place.toLowerCase().normalize("NFKD").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "place";
  const terms = [...new Set([label.toLowerCase().replace(/^the /, ""), ...label.toLowerCase().split(/\s+/).filter((word) => word.length >= 3 && word !== "the")])];
  const subject = { kind: "person", id: person.id, label: person.name, aliases: [...new Set([person.name.toLowerCase(), ...person.aliases])] };
  const base = { status: "active", privacy: "household", subject, place: { state: place, label } };
  const evidence = { source: "home_assistant_history", sourceEntityIds: [person.haPerson as string] };
  return [
    {
      ...base,
      id: `${person.id}.${key}.zone_departure`,
      behaviour: { id: `leave_home_for_${key}`, label: `leave home for ${label}`, requiredTermGroups: [terms, LEAVE_TERMS] },
      upcomingCommitment: { role: "commitment", label, actionText: `leave for ${label}`, maxLookaheadHours: 24 },
      evidence,
    } as unknown as RawPattern,
    {
      ...base,
      id: `${person.id}.${key}.zone_return`,
      behaviour: { id: `return_home_from_${key}`, label: `return home from ${label}`, requiredTermGroups: [terms, RETURN_TERMS] },
      evidence,
    } as unknown as RawPattern,
  ];
}

/** How a zone is said: one plain word in lower case ("work", "school"), a proper name as written ("Mum's"). */
function placeLabel(place: string): string {
  if (!/^[A-Z][a-z]+$/.test(place)) return place;
  const word = place.toLowerCase();
  return THE_PLACES.has(word) ? `the ${word}` : word;
}

/** Plain places said with "the" ("leaves for the gym"; but "work", "school", "church"). */
const THE_PLACES = new Set(["gym", "office", "shops", "pool", "beach", "park", "library", "station", "airport", "hospital", "club", "farm", "shop", "studio", "pub", "track", "oval", "mall", "factory", "warehouse", "site", "yard"]);

/** Leaving home for a place (the home exit before it), or getting home from it (the first home after it). */
function scanZoneTrips(states: readonly HaHistoryState[], place: string, timezone: string): { readonly departures: readonly Sample[]; readonly returns: readonly Sample[]; readonly freshFrom: string | null } {
  const departures: Sample[] = [];
  const returns: Sample[] = [];
  let homeExit: number | null = null;
  let detoured = false;
  let placeExit: number | null = null;
  let previous: HaHistoryState | null = null;
  for (const state of states) {
    if (previous && previous.state === state.state) continue;
    const at = Date.parse(state.lastChanged);
    if (previous) {
      const stayedMs = at - Date.parse(previous.lastChanged);
      if (previous.state === "home") {
        homeExit = at;
        detoured = false;
        placeExit = null;
      } else if (previous.state === place) {
        placeExit = at;
      } else if (!NOT_PLACES.has(previous.state.toLowerCase()) && stayedMs > ROUTINE_REFRESH_LIMITS.maxDetourMs) {
        detoured = true;
        if (previous.state !== place) placeExit = null;
      }
    }
    if (state.state === place && homeExit !== null && !detoured && at - homeExit <= ROUTINE_REFRESH_LIMITS.maxCommuteMs) {
      departures.push(sampleAt(homeExit, timezone));
      homeExit = null;
    }
    if (state.state === "home" && placeExit !== null && at - placeExit <= ROUTINE_REFRESH_LIMITS.maxCommuteMs) {
      returns.push(sampleAt(at, timezone));
      placeExit = null;
    }
    previous = state;
  }
  return { departures, returns, freshFrom: freshFromStates(states, timezone) };
}

function buildZoneTrip(pattern: RawPattern, context: Context, previous: RawPattern | undefined, kind: "departure" | "return"): Built {
  const place = (pattern as { place?: { state?: unknown; label?: unknown } }).place;
  if (typeof place?.state !== "string") throw new GateFailure("no place");
  const label = typeof place.label === "string" ? place.label : place.state;
  const trips = scanZoneTrips(entityStates(pattern, context), place.state, context.timezone);
  const samples = mergeSamples(kind === "departure" ? trips.departures : trips.returns, trips.freshFrom, previous, context);
  // Weekdays and weekends kept apart; each needs its own steady times.
  const groups = [
    { id: "weekdays", label: "weekdays", days: WEEKDAY_SET, samples: samples.filter((sample) => WEEKDAY_SET.includes(weekdayOf(sample.date))) },
    { id: "weekends", label: "weekends", days: WEEKEND_SET, samples: samples.filter((sample) => WEEKEND_SET.includes(weekdayOf(sample.date))) },
  ].flatMap((group) => {
    try {
      return [{ ...group, stats: timeStats(group.samples, kind, `${group.label} trips`) }];
    } catch (error) {
      if (error instanceof GateFailure) return [];
      throw error;
    }
  });
  const main = groups[0];
  if (!main) throw new GateFailure(`no steady ${kind === "departure" ? "departures for" : "returns from"} ${label} on weekdays or weekends`);
  const used = groups.flatMap((group) => group.samples).sort(bySample);
  const name = pattern.subject.label;
  const action = (subject: string, third: boolean) => kind === "departure"
    ? `${subject} usually ${third ? "leaves" : "leave"} for ${label} at about`
    : `${subject} usually ${third ? "gets" : "get"} home from ${label} around`;
  const line = (subject: string, third: boolean) => {
    const spanText = main.stats.start === main.stats.end ? `all at ${clock(main.stats.start)}` : `between ${clockRange(main.stats.start, main.stats.end)}`;
    const first = `${action(subject, third)} ${clock(main.stats.typical)} on ${main.label}; ${words(main.samples.length)} trips were ${spanText}.`;
    const other = groups[1];
    return other ? `${first} On ${other.label}, around ${clock(other.stats.typical)}.` : first;
  };
  return {
    confidence: confidenceFor(main.samples, `${capital(words(main.samples.length))} ${main.label} ${kind === "departure" ? "departures" : "returns"} within ${spread(main.samples)} minutes, ${dateRange(main.samples)}.`),
    evidence: personEvidence(pattern, used, kind === "departure"
      ? `Leaving home, then arriving at the ${place.state} zone within six hours without a long stop elsewhere.`
      : `The first time home after leaving the ${place.state} zone, within six hours.`, context.timezone),
    data: { type: "time_of_day_by_cohort", cohorts: groups.map((group) => cohort(group.id, group.label, group.days, group.samples.length, group.stats)) },
    answers: {
      default: line(name, true),
      firstPerson: line("You", false),
      evidence: `That is based on ${words(used.length)} trips in Home Assistant's presence history ${dateRange(used)}.`,
      variants: groups.map((group) => ({
        selectorTerms: group.id === "weekdays" ? ["weekday", "weekdays", "monday", "tuesday", "wednesday", "thursday", "friday"] : ["weekend", "weekends", "saturday", "sunday"],
        text: `On ${group.label}, ${name} ${kind === "departure" ? `left for ${label}` : `got home from ${label}`} between ${clockRange(group.stats.start, group.stats.end)}, around ${clock(group.stats.typical)}.`,
        firstPersonText: `On ${group.label}, you ${kind === "departure" ? `left for ${label}` : `got home from ${label}`} between ${clockRange(group.stats.start, group.stats.end)}, around ${clock(group.stats.typical)}.`,
      })),
    },
  };
}

