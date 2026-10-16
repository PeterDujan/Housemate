#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { householdPeople } from "../dist/src/household.js";

const DEFAULT_BASE_URL = "http://homeassistant.local:8123";
// The house's own zone: Home Assistant apps get TZ from the Supervisor.
const DEFAULT_TIMEZONE = process.env.TZ?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
const DEFAULT_COMPLETE_DAYS = 9;
const DEFAULT_WINDOW = completeDayWindow(new Date(), DEFAULT_TIMEZONE, DEFAULT_COMPLETE_DAYS);
const DEFAULT_START = DEFAULT_WINDOW.start;
const DEFAULT_END = DEFAULT_WINDOW.end;
const DEFAULT_OUTPUT = "/share/jarvis-v5/pattern-analysis/current-ha-pattern-candidates.json";
const BATCH_SIZE = 25;
const GRID_MINUTES = 15;
const CATEGORICAL_DOMAINS = new Set([
  "binary_sensor",
  "cover",
  "fan",
  "light",
  "lock",
  "media_player",
  "person",
  "switch",
  "vacuum",
]);
const NUMERIC_DEVICE_CLASSES = new Set([
  "aqi",
  "area",
  "battery",
  "carbon_dioxide",
  "carbon_monoxide",
  "current",
  "data_rate",
  "data_size",
  "distance",
  "duration",
  "energy",
  "frequency",
  "gas",
  "humidity",
  "illuminance",
  "monetary",
  "nitrogen_dioxide",
  "ozone",
  "pm1",
  "pm10",
  "pm25",
  "power",
  "power_factor",
  "pressure",
  "reactive_power",
  "signal_strength",
  "speed",
  "temperature",
  "volatile_organic_compounds",
  "voltage",
  "volume",
  "water",
  "weight",
  "wind_speed",
]);
const ACTIVE_STATES = new Map([
  ["binary_sensor", new Set(["on"])],
  ["cover", new Set(["open", "opening"])],
  ["fan", new Set(["on"])],
  ["light", new Set(["on"])],
  ["lock", new Set(["unlocked", "unlocking"])],
  ["media_player", new Set(["playing", "paused", "on"])],
  ["switch", new Set(["on"])],
  ["vacuum", new Set(["cleaning", "returning", "paused"])],
]);
const INVALID_STATES = new Set(["", "unknown", "unavailable", "none", "null"]);
// Each linked Home Assistant person: the household's spoken names for them, and their household id.
const PERSON_ALIASES = new Map(householdPeople().filter((person) => person.haPerson).map((person) => [person.haPerson, [...person.aliases]]));
const PERSON_IDS = new Map(householdPeople().filter((person) => person.haPerson).map((person) => [person.haPerson, person.id]));
// Group lights, do-not-disturb lights and network-gear LEDs: not lights people use.
const PRIMARY_LIGHT_EXCLUSIONS = /(?:^light\.all_lights$|_dnd$|router|\bled\b)/i;
const DIAGNOSTIC_ENTITY = /(?:rssi|signal_strength|linkquality|uptime|firmware|update|last_seen|last_boot|reboot|restart|identify|diagnostic|memory_usage|processor_use|cpu_|disk_|network_|ip_address|mac_address|wi_?fi|wlan|bluetooth|temperature_?2$)/i;
const FORECAST_ENTITY = /(?:forecast|solcast|estimated|prediction|predicted|tomorrow|next_hour|in_\d+_(?:minute|hour))/i;

if (process.argv.includes("--print-default-window")) {
  process.stdout.write(`${JSON.stringify({
    timezone: DEFAULT_TIMEZONE,
    completeDays: DEFAULT_COMPLETE_DAYS,
    ...DEFAULT_WINDOW,
  }, null, 2)}\n`);
  process.exit(0);
}
const args = parseArgs(process.argv.slice(2));
const localFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: args.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const localPartsCache = new Map();
const token = process.env.JARVIS_HA_TOKEN?.trim();
if (!token) {
  throw new Error("JARVIS_HA_TOKEN is required");
}

const startedAt = new Date();
const startMs = Date.parse(args.start);
const endMs = Date.parse(args.end);
if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
  throw new Error("invalid --start/--end window");
}

const states = await fetchJson(`${args.baseUrl}/api/states`);
const inventory = states.map(normalizeState).filter(Boolean);
const categoricalEntities = inventory.filter((entity) => CATEGORICAL_DOMAINS.has(entity.domain));
const numericEntities = inventory.filter((entity) =>
  entity.domain === "sensor"
  && (NUMERIC_DEVICE_CLASSES.has(entity.deviceClass) || numericValue(entity.state) !== null));
const selected = uniqueById([...categoricalEntities, ...numericEntities]);

process.stderr.write(`Inventory ${inventory.length}; fetching ${selected.length} candidate entities in batches of ${args.batchSize}.\n`);
const histories = new Map();
for (let offset = 0; offset < selected.length; offset += args.batchSize) {
  const batch = selected.slice(offset, offset + args.batchSize);
  const groups = await fetchHistoryBatch(batch.map((entity) => entity.entityId));
  for (const group of groups) {
    const entityId = group[0]?.entity_id;
    if (!entityId) continue;
    histories.set(entityId, normalizeHistory(group, startMs, endMs));
  }
  process.stderr.write(`Fetched ${Math.min(offset + batch.length, selected.length)}/${selected.length}.\r`);
}
process.stderr.write("\nMining deterministic candidates.\n");

const candidates = [];
const rejectionCounts = new Map();
for (const entity of selected) {
  const history = histories.get(entity.entityId) ?? [];
  if (history.length < 1) {
    increment(rejectionCounts, "no_history");
    continue;
  }
  if (CATEGORICAL_DOMAINS.has(entity.domain)) {
    candidates.push(...categoricalCandidates(entity, history));
  }
  if (entity.domain === "sensor" && (NUMERIC_DEVICE_CLASSES.has(entity.deviceClass) || numericValue(entity.state) !== null)) {
    candidates.push(...numericCandidates(entity, history));
  }
}

const personEntities = categoricalEntities.filter((entity) => entity.domain === "person");
const lightEntities = categoricalEntities.filter((entity) =>
  entity.domain === "light"
  && !PRIMARY_LIGHT_EXCLUSIONS.test(entity.entityId)
  && !INVALID_STATES.has(entity.state));
candidates.push(...personPairCandidates(personEntities, histories));
candidates.push(...lightPairCandidates(lightEntities, histories));
candidates.push(...personLightCorrelationCandidates(personEntities, lightEntities, histories));

const deduped = dedupeCandidates(candidates)
  .sort((left, right) => right.confidence.score - left.confidence.score || left.id.localeCompare(right.id));
const familyCounts = countBy(deduped, (candidate) => candidate.family);
const confidenceCounts = countBy(deduped, (candidate) => candidate.confidence.band);
const subjectCounts = countBy(deduped, (candidate) => candidate.subject.domain);
const report = {
  schemaVersion: 1,
  category: "jarvis_current_ha_pattern_candidates",
  generatedAt: new Date().toISOString(),
  generatedInMs: Date.now() - startedAt.getTime(),
  sourcePolicy: "Current Home Assistant recorder history only.",
  source: {
    kind: "home_assistant_history_api",
    baseUrl: args.baseUrl,
    timezone: args.timezone,
    windowStart: args.start,
    windowEnd: args.end,
    completeDays: Math.round((endMs - startMs) / 86_400_000),
    gridMinutes: GRID_MINUTES,
  },
  inventory: {
    totalEntities: inventory.length,
    selectedEntities: selected.length,
    categoricalEntities: categoricalEntities.length,
    numericEntities: numericEntities.length,
    historiesReturned: histories.size,
    byDomain: countBy(inventory, (entity) => entity.domain),
  },
  candidateSummary: {
    count: deduped.length,
    byFamily: familyCounts,
    byConfidence: confidenceCounts,
    bySubjectDomain: subjectCounts,
    rejected: Object.fromEntries([...rejectionCounts.entries()].sort()),
  },
  candidates: deduped,
};

mkdirSync(dirname(args.output), { recursive: true });
writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  success: true,
  output: args.output,
  inventory: report.inventory,
  candidateSummary: report.candidateSummary,
}, null, 2)}\n`);

async function fetchHistoryBatch(entityIds) {
  const url = new URL(`${args.baseUrl}/api/history/period/${encodeURIComponent(args.start)}`);
  url.searchParams.set("filter_entity_id", entityIds.join(","));
  url.searchParams.set("end_time", args.end);
  url.searchParams.set("minimal_response", "");
  url.searchParams.set("no_attributes", "");
  url.searchParams.set("significant_changes_only", "");
  const value = await fetchJson(url.toString());
  return Array.isArray(value) ? value : [];
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

function categoricalCandidates(entity, history) {
  if (entity.domain === "person") return personCandidates(entity, history);
  const activeStates = ACTIVE_STATES.get(entity.domain);
  if (!activeStates) return stateDistributionCandidates(entity, history);
  const samples = gridStates(history, startMs, endMs, GRID_MINUTES);
  const valid = samples.filter((sample) => !INVALID_STATES.has(sample.state));
  if (valid.length < 48) return [];
  const active = valid.filter((sample) => activeStates.has(sample.state));
  const activeFraction = active.length / valid.length;
  const transitions = stateTransitions(history).filter((transition) => activeStates.has(transition.to));
  const episodes = activeEpisodes(history, activeStates, startMs, endMs);
  const daily = dailyActiveStats(valid, activeStates);
  const result = [];
  if (daily.length >= 5 && (active.length > 0 || transitions.length > 0)) {
    const durations = daily.map((day) => day.activeMinutes);
    const activationCounts = daily.map((day) => day.activations);
    const score = durationConfidence(durations, daily.length);
    result.push(candidate(entity, "daily_active_duration", {
      score,
      evidenceCount: daily.length,
      observationCount: valid.length,
      method: `${GRID_MINUTES}-minute state integration across complete local days`,
      data: {
        observedDays: daily.length,
        activeDays: daily.filter((day) => day.activeMinutes > 0).length,
        medianMinutes: round(percentile(durations, 0.5), 1),
        meanMinutes: round(mean(durations), 1),
        p10Minutes: round(percentile(durations, 0.1), 1),
        p90Minutes: round(percentile(durations, 0.9), 1),
        minMinutes: round(Math.min(...durations), 1),
        maxMinutes: round(Math.max(...durations), 1),
        medianActivationsPerDay: round(percentile(activationCounts, 0.5), 1),
        activeFraction: round(activeFraction, 4),
      },
      summary: `${entity.label} was active on ${daily.filter((day) => day.activeMinutes > 0).length} of ${daily.length} complete days for a median ${formatDuration(percentile(durations, 0.5))} per day.`,
    }));
  }
  if (episodes.length >= 4) {
    const durations = episodes.map((episode) => episode.durationMinutes).filter((value) => value >= 0.1 && value <= 1_440);
    if (durations.length >= 4) {
      const score = episodeConfidence(durations, unique(episodes.map((episode) => episode.localDate)).length);
      result.push(candidate(entity, "active_episode_duration", {
        score,
        evidenceCount: durations.length,
        observationCount: history.length,
        method: "Exact active-state transition intervals",
        data: {
          episodeCount: durations.length,
          distinctDays: unique(episodes.map((episode) => episode.localDate)).length,
          medianMinutes: round(percentile(durations, 0.5), 1),
          p10Minutes: round(percentile(durations, 0.1), 1),
          p90Minutes: round(percentile(durations, 0.9), 1),
        },
        summary: `${entity.label} active episodes typically lasted ${formatDuration(percentile(durations, 0.5))}, based on ${durations.length} episodes.`,
      }));
    }
  }
  result.push(...transitionTimeCandidates(entity, transitions, "activation"));
  const inactiveTransitions = stateTransitions(history).filter((transition) =>
    activeStates.has(transition.from) && !activeStates.has(transition.to) && !INVALID_STATES.has(transition.to));
  result.push(...transitionTimeCandidates(entity, inactiveTransitions, "deactivation"));
  return result.filter((item) => item.confidence.score >= 0.35);
}

function stateDistributionCandidates(entity, history) {
  const samples = gridStates(history, startMs, endMs, GRID_MINUTES)
    .filter((sample) => !INVALID_STATES.has(sample.state));
  if (samples.length < 48) return [];
  const counts = countBy(samples, (sample) => sample.state);
  const result = [];
  for (const [state, count] of Object.entries(counts)) {
    const fraction = count / samples.length;
    if (fraction < 0.03) continue;
    result.push(candidate(entity, "state_prevalence", {
      score: clamp(0.45 + Math.min(0.35, samples.length / 3_000) + Math.min(0.2, count / 500)),
      evidenceCount: count,
      observationCount: samples.length,
      method: `${GRID_MINUTES}-minute state prevalence`,
      qualifier: state,
      data: { state, fraction: round(fraction, 4), sampledMinutes: samples.length * GRID_MINUTES },
      summary: `${entity.label} was ${state} for about ${Math.round(fraction * 100)}% of the observed window.`,
    }));
  }
  return result;
}

function personCandidates(entity, history) {
  const transitions = stateTransitions(history).filter((transition) => !INVALID_STATES.has(transition.to));
  const visits = [];
  for (let index = 0; index < history.length; index += 1) {
    const current = history[index];
    if (!current || INVALID_STATES.has(current.state) || current.state === "not_home") continue;
    const next = history[index + 1];
    const episodeStart = Math.max(startMs, current.timeMs);
    const episodeEnd = Math.min(endMs, next?.timeMs ?? endMs);
    if (episodeEnd <= episodeStart) continue;
    visits.push({
      state: current.state,
      startMs: episodeStart,
      endMs: episodeEnd,
      durationMinutes: (episodeEnd - episodeStart) / 60_000,
      localDate: localDate(episodeStart),
      weekday: localWeekday(episodeStart),
      minute: localMinute(episodeStart),
    });
  }
  const result = [];
  const zones = unique(visits.map((visit) => visit.state));
  for (const zone of zones) {
    const zoneVisits = visits.filter((visit) => visit.state === zone && visit.durationMinutes >= 2);
    const days = unique(zoneVisits.map((visit) => visit.localDate));
    if (zoneVisits.length < 3 || days.length < 2) continue;
    const durations = zoneVisits.map((visit) => visit.durationMinutes);
    result.push(candidate(entity, "person_zone_visit", {
      score: clamp(0.42 + Math.min(0.3, days.length * 0.06) + Math.min(0.2, zoneVisits.length * 0.025) - spreadPenalty(durations, 240) * 0.1),
      evidenceCount: zoneVisits.length,
      observationCount: history.length,
      method: `Direct ${zone} zone entry and exit states`,
      qualifier: slug(zone),
      data: {
        zone,
        visitCount: zoneVisits.length,
        distinctDays: days.length,
        daysPerObservedWeek: round(days.length / ((endMs - startMs) / 604_800_000), 1),
        medianArrivalMinute: round(circularMedian(zoneVisits.map((visit) => visit.minute)), 0),
        arrivalP10Minute: round(percentile(zoneVisits.map((visit) => visit.minute), 0.1), 0),
        arrivalP90Minute: round(percentile(zoneVisits.map((visit) => visit.minute), 0.9), 0),
        medianVisitMinutes: round(percentile(durations, 0.5), 1),
        weekdays: countBy(zoneVisits, (visit) => visit.weekday),
      },
      summary: `${entity.label} entered ${zone} ${zoneVisits.length} times across ${days.length} observed days; the median visit lasted ${formatDuration(percentile(durations, 0.5))}.`,
    }));
    const arrivals = zoneVisits.map((visit) => ({
      from: "",
      to: zone,
      timeMs: visit.startMs,
      localDate: visit.localDate,
      weekday: visit.weekday,
      minute: visit.minute,
    }));
    result.push(...transitionTimeCandidates(entity, arrivals, "zone_arrival", zone));
  }
  const departures = transitions.filter((transition) => transition.from === "home" && transition.to === "not_home");
  result.push(...transitionTimeCandidates(entity, departures, "home_departure"));
  const arrivalsHome = transitions.filter((transition) => transition.to === "home" && transition.from !== "home");
  result.push(...transitionTimeCandidates(entity, arrivalsHome, "home_arrival"));
  return result;
}

function transitionTimeCandidates(entity, transitions, family, qualifier = null) {
  if (transitions.length < 3) return [];
  const phases = new Map();
  for (const transition of transitions) {
    const phase = dayPhase(transition.minute);
    const list = phases.get(phase) ?? [];
    list.push(transition);
    phases.set(phase, list);
  }
  const result = [];
  for (const [phase, phaseTransitions] of phases.entries()) {
    const days = unique(phaseTransitions.map((transition) => transition.localDate));
    if (phaseTransitions.length < 3 || days.length < 3) continue;
    const minutes = phaseTransitions.map((transition) => transition.minute).sort((a, b) => a - b);
    const spread = percentile(minutes, 0.9) - percentile(minutes, 0.1);
    const dominance = phaseTransitions.length / transitions.length;
    const score = clamp(0.4 + Math.min(0.3, days.length * 0.06) + dominance * 0.2 - Math.min(0.2, spread / 1_200));
    result.push(candidate(entity, family, {
      score,
      evidenceCount: phaseTransitions.length,
      observationCount: transitions.length,
      method: `Repeated ${family.replaceAll("_", " ")} transitions grouped by local day phase`,
      qualifier: [qualifier, phase].filter(Boolean).join("_"),
      data: {
        phase,
        transitionCount: phaseTransitions.length,
        distinctDays: days.length,
        shareOfTransitions: round(dominance, 4),
        typicalMinute: round(percentile(minutes, 0.5), 0),
        p10Minute: round(percentile(minutes, 0.1), 0),
        p90Minute: round(percentile(minutes, 0.9), 0),
        weekdays: countBy(phaseTransitions, (transition) => transition.weekday),
      },
      summary: `${entity.label} ${family.replaceAll("_", " ")} events clustered in the ${phase} around ${formatMinute(percentile(minutes, 0.5))}, based on ${phaseTransitions.length} events across ${days.length} days.`,
    }));
  }
  return result;
}

function numericCandidates(entity, history) {
  if (DIAGNOSTIC_ENTITY.test(entity.entityId) && !["battery", "temperature"].includes(entity.deviceClass)) return [];
  const numericHistory = history
    .map((sample) => ({ ...sample, value: numericValue(sample.state) }))
    .filter((sample) => sample.value !== null);
  if (numericHistory.length < 3) return [];
  const grid = numericGrid(numericHistory, startMs, endMs, GRID_MINUTES, entity.stateClass === "total_increasing" ? 1_440 : 180);
  if (grid.length < 48) return [];
  const values = grid.map((sample) => sample.value).filter(Number.isFinite);
  if (values.length < 48) return [];
  const result = [];
  const typical = numericRangeCandidate(entity, grid, values);
  if (typical) result.push(typical);
  const dayNight = numericDayNightCandidate(entity, grid);
  if (dayNight) result.push(dayNight);
  const profile = numericDailyProfileCandidate(entity, grid);
  if (profile) result.push(profile);
  const dailyDelta = numericDailyDeltaCandidate(entity, numericHistory);
  if (dailyDelta) result.push(dailyDelta);
  return result;
}

function numericRangeCandidate(entity, grid, values) {
  const days = unique(grid.map((sample) => sample.localDate)).length;
  if (days < 4) return null;
  const median = percentile(values, 0.5);
  const p10 = percentile(values, 0.1);
  const p90 = percentile(values, 0.9);
  const score = clamp(0.5 + Math.min(0.3, days * 0.04) + Math.min(0.15, values.length / 8_000));
  return candidate(entity, "numeric_typical_range", {
    score,
    evidenceCount: values.length,
    observationCount: grid.length,
    method: `${GRID_MINUTES}-minute time-weighted samples with stale-value limits`,
    data: {
      sampleCount: values.length,
      distinctDays: days,
      median: round(median, precision(entity)),
      p10: round(p10, precision(entity)),
      p90: round(p90, precision(entity)),
      minimum: round(Math.min(...values), precision(entity)),
      maximum: round(Math.max(...values), precision(entity)),
      unit: entity.unit,
    },
    summary: `${entity.label} was typically ${formatValue(median, entity)}; the middle 80% of time-weighted readings ran from ${formatValue(p10, entity)} to ${formatValue(p90, entity)}.`,
  });
}

function numericDayNightCandidate(entity, grid) {
  const day = grid.filter((sample) => sample.minute >= 7 * 60 && sample.minute < 19 * 60).map((sample) => sample.value);
  const night = grid.filter((sample) => sample.minute < 7 * 60 || sample.minute >= 19 * 60).map((sample) => sample.value);
  if (day.length < 24 || night.length < 24) return null;
  const dayMedian = percentile(day, 0.5);
  const nightMedian = percentile(night, 0.5);
  const absolute = Math.abs(dayMedian - nightMedian);
  const scale = Math.max(Math.abs(percentile([...day, ...night], 0.5)), percentile([...day, ...night].map(Math.abs), 0.5), 1);
  const relative = absolute / scale;
  const threshold = ["temperature", "humidity"].includes(entity.deviceClass) ? 0.04 : 0.15;
  if (relative < threshold && absolute < meaningfulAbsoluteDifference(entity)) return null;
  const score = clamp(0.45 + Math.min(0.25, relative) + Math.min(0.2, unique(grid.map((sample) => sample.localDate)).length * 0.03));
  return candidate(entity, "numeric_day_night_difference", {
    score,
    evidenceCount: day.length + night.length,
    observationCount: grid.length,
    method: "Time-weighted 07:00-19:00 versus 19:00-07:00 comparison",
    data: {
      dayMedian: round(dayMedian, precision(entity)),
      nightMedian: round(nightMedian, precision(entity)),
      absoluteDifference: round(dayMedian - nightMedian, precision(entity)),
      relativeDifference: round(relative, 4),
      unit: entity.unit,
    },
    summary: `${entity.label} had a daytime median of ${formatValue(dayMedian, entity)} versus ${formatValue(nightMedian, entity)} overnight.`,
  });
}

function numericDailyProfileCandidate(entity, grid) {
  const bins = new Map();
  for (const sample of grid) {
    const bin = Math.floor(sample.minute / 120) * 120;
    const list = bins.get(bin) ?? [];
    list.push(sample.value);
    bins.set(bin, list);
  }
  const profile = [...bins.entries()]
    .filter(([, values]) => values.length >= 12)
    .map(([minute, values]) => ({ minute, median: percentile(values, 0.5), count: values.length }))
    .sort((left, right) => left.minute - right.minute);
  if (profile.length < 8) return null;
  const peak = [...profile].sort((left, right) => right.median - left.median)[0];
  const trough = [...profile].sort((left, right) => left.median - right.median)[0];
  const amplitude = peak.median - trough.median;
  const scale = Math.max(Math.abs(percentile(grid.map((sample) => sample.value), 0.5)), 1);
  const relative = Math.abs(amplitude) / scale;
  if (relative < 0.15 && Math.abs(amplitude) < meaningfulAbsoluteDifference(entity)) return null;
  const score = clamp(0.42 + Math.min(0.3, relative) + Math.min(0.2, unique(grid.map((sample) => sample.localDate)).length * 0.03));
  return candidate(entity, "numeric_daily_cycle", {
    score,
    evidenceCount: grid.length,
    observationCount: grid.length,
    method: "Two-hour local-time bins over time-weighted readings",
    data: {
      peakWindowStartMinute: peak.minute,
      peakMedian: round(peak.median, precision(entity)),
      troughWindowStartMinute: trough.minute,
      troughMedian: round(trough.median, precision(entity)),
      amplitude: round(amplitude, precision(entity)),
      relativeAmplitude: round(relative, 4),
      unit: entity.unit,
      profile: profile.map((item) => ({ minute: item.minute, median: round(item.median, precision(entity)), count: item.count })),
    },
    summary: `${entity.label} tended to peak around ${formatMinute(peak.minute + 60)} at ${formatValue(peak.median, entity)} and bottom out around ${formatMinute(trough.minute + 60)} at ${formatValue(trough.median, entity)}.`,
  });
}

function numericDailyDeltaCandidate(entity, history) {
  if (entity.stateClass !== "total_increasing" && entity.deviceClass !== "energy" && entity.deviceClass !== "water") return null;
  const groups = groupBy(history, (sample) => localDate(sample.timeMs));
  const deltas = [];
  for (const [date, samples] of groups.entries()) {
    const values = samples.map((sample) => sample.value).filter(Number.isFinite);
    if (values.length < 2) continue;
    const delta = values.at(-1) - values[0];
    if (Number.isFinite(delta) && delta >= 0) deltas.push({ date, value: delta });
  }
  if (deltas.length < 4) return null;
  const values = deltas.map((item) => item.value);
  return candidate(entity, "numeric_daily_delta", {
    score: clamp(0.5 + Math.min(0.35, deltas.length * 0.05) - spreadPenalty(values, Math.max(mean(values), 0.01)) * 0.1),
    evidenceCount: deltas.length,
    observationCount: history.length,
    method: "First-to-last monotonic state delta per complete local day",
    data: {
      observedDays: deltas.length,
      medianDailyDelta: round(percentile(values, 0.5), precision(entity)),
      p10DailyDelta: round(percentile(values, 0.1), precision(entity)),
      p90DailyDelta: round(percentile(values, 0.9), precision(entity)),
      unit: entity.unit,
      daily: deltas.map((item) => ({ date: item.date, value: round(item.value, precision(entity)) })),
    },
    summary: `${entity.label} changed by a median ${formatValue(percentile(values, 0.5), entity)} per complete day across ${deltas.length} days.`,
  });
}

function personPairCandidates(entities, historyMap) {
  const result = [];
  for (let leftIndex = 0; leftIndex < entities.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entities.length; rightIndex += 1) {
      const left = entities[leftIndex];
      const right = entities[rightIndex];
      if (!left || !right) continue;
      const leftTransitions = stateTransitions(historyMap.get(left.entityId) ?? []);
      const rightTransitions = stateTransitions(historyMap.get(right.entityId) ?? []);
      for (const mode of ["departure", "arrival"]) {
        const select = mode === "departure"
          ? (transition) => transition.from === "home" && transition.to === "not_home"
          : (transition) => transition.to === "home" && transition.from !== "home";
        const leftEvents = leftTransitions.filter(select);
        const rightEvents = rightTransitions.filter(select);
        const pairs = nearestEventPairs(leftEvents, rightEvents, 8 * 60_000);
        const days = unique(pairs.map((pair) => localDate(Math.min(pair.left.timeMs, pair.right.timeMs))));
        if (pairs.length < 3 || days.length < 3) continue;
        const offsets = pairs.map((pair) => Math.abs(pair.left.timeMs - pair.right.timeMs) / 60_000);
        result.push(crossCandidate(
          `people.${slug(left.label)}.${slug(right.label)}.shared_${mode}`,
          "person_pair_timing",
          [left, right],
          clamp(0.5 + Math.min(0.3, days.length * 0.07) - percentile(offsets, 0.5) / 60),
          pairs.length,
          `Paired home ${mode} transitions within eight minutes`,
          {
            mode,
            pairCount: pairs.length,
            distinctDays: days.length,
            medianSeparationMinutes: round(percentile(offsets, 0.5), 1),
            p90SeparationMinutes: round(percentile(offsets, 0.9), 1),
          },
          `${left.label} and ${right.label} had ${pairs.length} near-simultaneous home ${mode}s across ${days.length} days, usually within ${formatDuration(percentile(offsets, 0.5))}.`,
        ));
      }
    }
  }
  return result;
}

function lightPairCandidates(entities, historyMap) {
  const result = [];
  const grids = new Map(entities.map((entity) => [entity.entityId, gridStates(historyMap.get(entity.entityId) ?? [], startMs, endMs, GRID_MINUTES)]));
  for (let leftIndex = 0; leftIndex < entities.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entities.length; rightIndex += 1) {
      const left = entities[leftIndex];
      const right = entities[rightIndex];
      if (!left || !right) continue;
      const leftGrid = grids.get(left.entityId) ?? [];
      const rightGrid = grids.get(right.entityId) ?? [];
      const length = Math.min(leftGrid.length, rightGrid.length);
      if (length < 48) continue;
      let bothOn = 0;
      let eitherOn = 0;
      let same = 0;
      let leftOn = 0;
      let rightOn = 0;
      for (let index = 0; index < length; index += 1) {
        const leftActive = leftGrid[index]?.state === "on";
        const rightActive = rightGrid[index]?.state === "on";
        if (leftActive) leftOn += 1;
        if (rightActive) rightOn += 1;
        if (leftActive && rightActive) bothOn += 1;
        if (leftActive || rightActive) eitherOn += 1;
        if (leftActive === rightActive) same += 1;
      }
      if (eitherOn < 12) continue;
      const jaccard = bothOn / eitherOn;
      const agreement = same / length;
      if (jaccard < 0.72 || agreement < 0.85) continue;
      result.push(crossCandidate(
        `lights.${slug(left.label)}.${slug(right.label)}.synchrony`,
        "light_pair_synchrony",
        [left, right],
        clamp(0.45 + jaccard * 0.35 + agreement * 0.15),
        length,
        `${GRID_MINUTES}-minute paired-state comparison`,
        {
          jaccardOn: round(jaccard, 4),
          overallAgreement: round(agreement, 4),
          bothOnMinutes: bothOn * GRID_MINUTES,
          eitherOnMinutes: eitherOn * GRID_MINUTES,
          leftOnMinutes: leftOn * GRID_MINUTES,
          rightOnMinutes: rightOn * GRID_MINUTES,
        },
        `${left.label} and ${right.label} were on together for ${Math.round(jaccard * 100)}% of the time either light was on, with ${Math.round(agreement * 100)}% overall state agreement.`,
      ));
    }
  }
  return result;
}

function personLightCorrelationCandidates(people, lights, historyMap) {
  const result = [];
  const lightGrids = new Map(lights.map((light) => [light.entityId, gridStates(historyMap.get(light.entityId) ?? [], startMs, endMs, GRID_MINUTES)]));
  for (const person of people) {
    const personGrid = gridStates(historyMap.get(person.entityId) ?? [], startMs, endMs, GRID_MINUTES);
    for (const light of lights) {
      const lightGrid = lightGrids.get(light.entityId) ?? [];
      const length = Math.min(personGrid.length, lightGrid.length);
      let home = 0;
      let homeOn = 0;
      let away = 0;
      let awayOn = 0;
      for (let index = 0; index < length; index += 1) {
        const isHome = personGrid[index]?.state === "home";
        const isOn = lightGrid[index]?.state === "on";
        if (isHome) {
          home += 1;
          if (isOn) homeOn += 1;
        } else {
          away += 1;
          if (isOn) awayOn += 1;
        }
      }
      if (home < 48 || away < 48) continue;
      const homeRate = homeOn / home;
      const awayRate = awayOn / away;
      const difference = homeRate - awayRate;
      if (Math.abs(difference) < 0.18) continue;
      const score = clamp(0.38 + Math.min(0.25, Math.abs(difference)) + Math.min(0.15, Math.min(home, away) / 1_000));
      result.push(crossCandidate(
        `correlation.${slug(person.label)}.${slug(light.label)}.presence_light`,
        "person_light_correlation",
        [person, light],
        score,
        home + away,
        `${GRID_MINUTES}-minute light-state comparison by person home/not-home state; correlation only`,
        {
          personEntityId: person.entityId,
          lightEntityId: light.entityId,
          homeObservedMinutes: home * GRID_MINUTES,
          awayObservedMinutes: away * GRID_MINUTES,
          lightOnRateWhenHome: round(homeRate, 4),
          lightOnRateWhenAway: round(awayRate, 4),
          rateDifference: round(difference, 4),
          claimBoundary: "This is a correlation. It cannot identify who operated or preferred the light.",
        },
        `${light.label} was on ${Math.round(homeRate * 100)}% of observed time when ${person.label} was home versus ${Math.round(awayRate * 100)}% when away. This does not identify who operated the light.`,
      ));
    }
  }
  return result;
}

function candidate(entity, family, details) {
  const qualifier = details.qualifier ? `.${slug(details.qualifier)}` : "";
  return {
    id: `${entity.entityId}.${family}${qualifier}`,
    status: "candidate",
    family,
    subject: {
      kind: entity.domain === "person" ? "person" : "entity",
      id: canonicalSubjectId(entity),
      sourceEntityIds: [entity.entityId],
      domain: entity.domain,
      deviceClass: entity.deviceClass,
      stateClass: entity.stateClass,
      label: entity.label,
      aliases: entityAliases(entity),
      unit: entity.unit,
    },
    confidence: confidence(details.score, details.reason),
    evidence: {
      source: "home_assistant_history",
      windowStart: args.start,
      windowEnd: args.end,
      evidenceCount: details.evidenceCount,
      observationCount: details.observationCount,
      method: details.method,
    },
    data: details.data,
    suggestedAnswer: details.summary,
  };
}

function crossCandidate(id, family, entities, score, evidenceCount, method, data, summary) {
  return {
    id,
    status: "candidate",
    family,
    subject: {
      kind: "relationship",
      id: entities.map((entity) => canonicalSubjectId(entity)).join("+"),
      sourceEntityIds: entities.map((entity) => entity.entityId),
      domain: "relationship",
      deviceClass: "none",
      stateClass: "none",
      label: entities.map((entity) => entity.label).join(" and "),
      aliases: unique(entities.flatMap(entityAliases)),
      unit: null,
    },
    confidence: confidence(score),
    evidence: {
      source: "home_assistant_history",
      windowStart: args.start,
      windowEnd: args.end,
      evidenceCount,
      observationCount: evidenceCount,
      method,
    },
    data,
    suggestedAnswer: summary,
  };
}

function confidence(score, reason = null) {
  const rounded = round(clamp(score), 3);
  return {
    score: rounded,
    band: rounded >= 0.82 ? "high" : rounded >= 0.62 ? "medium" : "low",
    ...(reason ? { reason } : {}),
  };
}

function gridStates(history, fromMs, toMs, stepMinutes) {
  if (history.length < 1) return [];
  const stepMs = stepMinutes * 60_000;
  let index = 0;
  let current = history[0];
  const result = [];
  for (let timeMs = fromMs; timeMs < toMs; timeMs += stepMs) {
    while (index + 1 < history.length && history[index + 1].timeMs <= timeMs) {
      index += 1;
      current = history[index];
    }
    if (!current || current.timeMs > timeMs) continue;
    result.push({
      timeMs,
      state: current.state,
      localDate: localDate(timeMs),
      weekday: localWeekday(timeMs),
      minute: localMinute(timeMs),
    });
  }
  return result;
}

function numericGrid(history, fromMs, toMs, stepMinutes, maxStaleMinutes) {
  if (history.length < 1) return [];
  const stepMs = stepMinutes * 60_000;
  let index = 0;
  let current = history[0];
  const result = [];
  for (let timeMs = fromMs; timeMs < toMs; timeMs += stepMs) {
    while (index + 1 < history.length && history[index + 1].timeMs <= timeMs) {
      index += 1;
      current = history[index];
    }
    if (!current || current.timeMs > timeMs || timeMs - current.timeMs > maxStaleMinutes * 60_000) continue;
    result.push({
      timeMs,
      value: current.value,
      localDate: localDate(timeMs),
      weekday: localWeekday(timeMs),
      minute: localMinute(timeMs),
    });
  }
  return result;
}

function stateTransitions(history) {
  const result = [];
  for (let index = 1; index < history.length; index += 1) {
    const previous = history[index - 1];
    const current = history[index];
    if (!previous || !current || previous.state === current.state) continue;
    result.push({
      from: previous.state,
      to: current.state,
      timeMs: current.timeMs,
      localDate: localDate(current.timeMs),
      weekday: localWeekday(current.timeMs),
      minute: localMinute(current.timeMs),
    });
  }
  return result;
}

function activeEpisodes(history, activeStates, fromMs, toMs) {
  const result = [];
  for (let index = 0; index < history.length; index += 1) {
    const current = history[index];
    if (!current || !activeStates.has(current.state)) continue;
    const previous = history[index - 1];
    if (previous && activeStates.has(previous.state)) continue;
    let endIndex = index + 1;
    while (endIndex < history.length && activeStates.has(history[endIndex].state)) endIndex += 1;
    const episodeStart = Math.max(fromMs, current.timeMs);
    const episodeEnd = Math.min(toMs, history[endIndex]?.timeMs ?? toMs);
    if (episodeEnd <= episodeStart) continue;
    result.push({
      startMs: episodeStart,
      endMs: episodeEnd,
      durationMinutes: (episodeEnd - episodeStart) / 60_000,
      localDate: localDate(episodeStart),
    });
  }
  return result;
}

function dailyActiveStats(samples, activeStates) {
  const grouped = groupBy(samples, (sample) => sample.localDate);
  return [...grouped.entries()].map(([date, daySamples]) => {
    let activations = 0;
    let previousActive = false;
    for (const sample of daySamples) {
      const currentActive = activeStates.has(sample.state);
      if (currentActive && !previousActive) activations += 1;
      previousActive = currentActive;
    }
    return {
      date,
      activeMinutes: daySamples.filter((sample) => activeStates.has(sample.state)).length * GRID_MINUTES,
      activations,
    };
  });
}

function normalizeState(value) {
  if (!value || typeof value.entity_id !== "string") return null;
  const domain = value.entity_id.split(".")[0] ?? "";
  const attributes = value.attributes && typeof value.attributes === "object" ? value.attributes : {};
  return {
    entityId: value.entity_id,
    domain,
    state: String(value.state ?? "").toLowerCase(),
    label: cleanLabel(typeof attributes.friendly_name === "string" ? attributes.friendly_name : value.entity_id),
    deviceClass: typeof attributes.device_class === "string" ? attributes.device_class : "none",
    stateClass: typeof attributes.state_class === "string" ? attributes.state_class : "none",
    unit: typeof attributes.unit_of_measurement === "string" ? attributes.unit_of_measurement : null,
  };
}

function normalizeHistory(group, fromMs, toMs) {
  return group
    .map((entry) => ({
      state: String(entry.state ?? "").toLowerCase(),
      timeMs: Date.parse(entry.last_changed ?? entry.last_updated ?? ""),
    }))
    .filter((entry) => Number.isFinite(entry.timeMs) && entry.timeMs <= toMs)
    .sort((left, right) => left.timeMs - right.timeMs)
    .reduce((result, entry) => {
      const previous = result.at(-1);
      if (previous && previous.state === entry.state) return result;
      result.push(entry);
      return result;
    }, [])
    .map((entry, index, values) => index === 0 && entry.timeMs < fromMs ? { ...entry, timeMs: fromMs } : entry);
}

function canonicalSubjectId(entity) {
  return PERSON_IDS.get(entity.entityId) ?? entity.entityId;
}

function entityAliases(entity) {
  const aliases = PERSON_ALIASES.get(entity.entityId) ?? [];
  return unique([
    ...aliases,
    normalizePhrase(entity.label),
    normalizePhrase(entity.entityId.split(".")[1]?.replaceAll("_", " ") ?? ""),
  ].filter(Boolean));
}

function nearestEventPairs(leftEvents, rightEvents, toleranceMs) {
  const used = new Set();
  const pairs = [];
  for (const left of leftEvents) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < rightEvents.length; index += 1) {
      if (used.has(index)) continue;
      const distance = Math.abs(left.timeMs - rightEvents[index].timeMs);
      if (distance <= toleranceMs && distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    }
    if (bestIndex >= 0) {
      used.add(bestIndex);
      pairs.push({ left, right: rightEvents[bestIndex] });
    }
  }
  return pairs;
}

function parseArgs(argv) {
  const values = {
    baseUrl: DEFAULT_BASE_URL,
    start: DEFAULT_START,
    end: DEFAULT_END,
    timezone: DEFAULT_TIMEZONE,
    output: DEFAULT_OUTPUT,
    batchSize: BATCH_SIZE,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || !key?.startsWith("--")) throw new Error(`missing value for ${key}`);
    index += 1;
    if (key === "--base-url") values.baseUrl = value.replace(/\/$/, "");
    else if (key === "--start") values.start = value;
    else if (key === "--end") values.end = value;
    else if (key === "--timezone") values.timezone = value;
    else if (key === "--output") values.output = resolve(value);
    else if (key === "--batch-size") values.batchSize = Math.max(1, Math.min(25, Number.parseInt(value, 10)));
    else throw new Error(`unknown argument ${key}`);
  }
  return values;
}

function completeDayWindow(now, timezone, days) {
  const endDate = datePartsInZone(now, timezone);
  const shifted = new Date(Date.UTC(
    Number(endDate.year),
    Number(endDate.month) - 1,
    Number(endDate.day) - days,
  ));
  const startDate = {
    year: String(shifted.getUTCFullYear()),
    month: String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    day: String(shifted.getUTCDate()).padStart(2, "0"),
  };
  return {
    start: zonedMidnightIso(startDate, timezone),
    end: zonedMidnightIso(endDate, timezone),
  };
}

function zonedMidnightIso(parts, timezone) {
  const desiredWallTime = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  let utcGuess = desiredWallTime;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = datePartsInZone(new Date(utcGuess), timezone, true);
    const observedWallTime = Date.UTC(
      Number(observed.year),
      Number(observed.month) - 1,
      Number(observed.day),
      Number(observed.hour),
      Number(observed.minute),
      Number(observed.second),
    );
    utcGuess += desiredWallTime - observedWallTime;
  }
  return new Date(utcGuess).toISOString();
}

function datePartsInZone(date, timezone, includeTime = false) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(includeTime ? {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    } : {}),
  }).formatToParts(date).map((part) => [part.type, part.value]));
}

function localParts(timeMs) {
  const cached = localPartsCache.get(timeMs);
  if (cached) return cached;
  const parts = Object.fromEntries(localFormatter
    .formatToParts(new Date(timeMs))
    .map((part) => [part.type, part.value]));
  localPartsCache.set(timeMs, parts);
  return parts;
}

function localDate(timeMs) {
  const parts = localParts(timeMs);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localWeekday(timeMs) {
  return localParts(timeMs).weekday.toLowerCase().slice(0, 3);
}

function localMinute(timeMs) {
  const parts = localParts(timeMs);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function dayPhase(minute) {
  if (minute < 6 * 60) return "overnight";
  if (minute < 12 * 60) return "morning";
  if (minute < 18 * 60) return "afternoon";
  return "evening";
}

function durationConfidence(values, days) {
  const nonzero = values.filter((value) => value > 0).length;
  const coverage = nonzero / days;
  const variability = spreadPenalty(values, Math.max(mean(values), 15));
  return clamp(0.42 + Math.min(0.3, days * 0.04) + coverage * 0.18 - variability * 0.12);
}

function episodeConfidence(values, days) {
  return clamp(0.4 + Math.min(0.3, days * 0.05) + Math.min(0.2, values.length * 0.02) - spreadPenalty(values, Math.max(mean(values), 5)) * 0.1);
}

function spreadPenalty(values, scale) {
  if (values.length < 2 || scale <= 0) return 0;
  return Math.min(1, (percentile(values, 0.9) - percentile(values, 0.1)) / scale);
}

function meaningfulAbsoluteDifference(entity) {
  if (entity.deviceClass === "temperature") return 1;
  if (entity.deviceClass === "humidity") return 5;
  if (entity.deviceClass === "power") return 20;
  if (entity.deviceClass === "energy") return 0.2;
  if (entity.deviceClass === "illuminance") return 20;
  if (entity.deviceClass === "battery") return 5;
  return 1;
}

function precision(entity) {
  if (["power", "current", "voltage", "frequency", "illuminance"].includes(entity.deviceClass)) return 1;
  return 2;
}

function numericValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || INVALID_STATES.has(value.toLowerCase())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatValue(value, entity) {
  const rounded = round(value, precision(entity));
  return `${rounded}${entity.unit ? ` ${entity.unit}` : ""}`;
}

function formatDuration(minutes) {
  if (!Number.isFinite(minutes)) return "an unknown duration";
  const rounded = Math.max(0, Math.round(minutes));
  if (rounded < 60) return `${rounded} minute${rounded === 1 ? "" : "s"}`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `${hours} hour${hours === 1 ? "" : "s"}` : `${hours} hour${hours === 1 ? "" : "s"} ${rest} minutes`;
}

function formatMinute(value) {
  const minute = ((Math.round(value) % 1_440) + 1_440) % 1_440;
  const hour24 = Math.floor(minute / 60);
  const minutes = minute % 60;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour = hour24 % 12 || 12;
  return `${hour}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function circularMedian(values) {
  if (values.length < 1) return 0;
  let best = values[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidateValue of values) {
    const distance = values.reduce((total, value) => {
      const direct = Math.abs(value - candidateValue);
      return total + Math.min(direct, 1_440 - direct);
    }, 0);
    if (distance < bestDistance) {
      best = candidateValue;
      bestDistance = distance;
    }
  }
  return best;
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length < 1) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueById(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (seen.has(value.entityId)) return false;
    seen.add(value.entityId);
    return true;
  });
}

function groupBy(values, selector) {
  const groups = new Map();
  for (const value of values) {
    const key = selector(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function countBy(values, selector) {
  const counts = {};
  for (const value of values) {
    const key = String(selector(value));
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function dedupeCandidates(values) {
  const byId = new Map();
  for (const value of values) {
    const current = byId.get(value.id);
    if (!current || value.confidence.score > current.confidence.score) byId.set(value.id, value);
  }
  return [...byId.values()];
}

function slug(value) {
  return normalizePhrase(value).replaceAll(" ", "_");
}

function normalizePhrase(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function cleanLabel(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(.+?)\s+Lock\s+\1(?:\s+(.+))?$/i, (_match, name, suffix) =>
      `${name} Lock${suffix ? ` ${suffix}` : ""}`);
}
