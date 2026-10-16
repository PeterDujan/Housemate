#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { houseConfig } from "../dist/src/house-config.js";
import { householdPeople } from "../dist/src/household.js";

// A household name run into its possessive ("sams lamp"), split the way speech writes it ("sam s lamp").
const HOUSEHOLD_NAMES = householdPeople().flatMap((person) => person.aliases).filter((alias) => /^[a-z]+$/.test(alias));
const POSSESSIVE_NAME = HOUSEHOLD_NAMES.length ? new RegExp(`\\b(?:${HOUSEHOLD_NAMES.join("|")})s\\b`, "g") : null;

const DEFAULT_INPUT = "/share/jarvis-v5/pattern-analysis/current-ha-pattern-candidates.json";
const DEFAULT_OUTPUT = resolve("config/house-pattern-observations.json");
const DEFAULT_REVIEW_OUTPUT = "/share/jarvis-v5/pattern-analysis/current-ha-pattern-review.json";
const POLICY_VERSION = 2;

const PUBLIC_OR_FORECAST = /(?:solcast|forecast|epa_air_quality|electricity_maps|cheapest_|energy_(?:current|next|production)|power_production)/i;
const INFRASTRUCTURE_OR_DIAGNOSTIC = /(?:remote_ui|debug|connected\b|esphome|sabnzbd|radarr|sonarr|overseerr|heartbeat|response_time|(?:^|_)lqi(?:_|\b)|config_|do_not_disturb|_dnd\b|warnings?\b|free_space|used_space|volume_used|firmware|uptime|last_seen|last_boot|api_used|filter_(?:left|time)|brush_(?:left|time)|sensor_dirty|wheel_dirty|(?:^|_)gap(?:_|\b)|_vs_)/i;
const MOBILE_TELEMETRY = /(?:iphone|mobile_app|phone_storage|floors_ascended|average_active_pace)/i;
const DERIVED_OR_CIRCULAR = /(?:presence_probability|_sleeping\b|_in_use\b)/i;
// The robot vacuum's own setting switches (switch.<its name>_...), from the house's vacuum.
const VACUUM_OBJECT = (houseConfig().vacuum.entity ?? "").replace(/^vacuum\./, "");
const VACUUM_CONFIGURATION = VACUUM_OBJECT ? new RegExp(`^switch\\.${VACUUM_OBJECT}_`, "i") : /(?!)/;
const REDUNDANT_PROXY = /^light\.all_lights$/i;
const UNKNOWN_HOUSEHOLD_DEVICE = /media_player\..*echo/i;
const PERIODIC_AGGREGATE = /(?:^|[._])(?:daily|monthly|yearly|hourly|month|year|hour)(?:_|$)/i;
const HIDDEN_ACCUMULATOR = /(?:total_energy|usage_adjusted)/i;
const NON_BEHAVIOURAL_COUNTER = /(?:^|[._])(?:history|count|library)(?:_|$)/i;
const SECONDARY_LIGHT = /^light\..*2$/i;
const CUMULATIVE_STATE_CLASSES = new Set(["total", "total_increasing"]);
const MEASUREMENT_FAMILIES = new Set([
  "numeric_typical_range",
  "numeric_daily_cycle",
  "numeric_day_night_difference",
]);
const NUMERIC_FAMILIES = new Set([
  ...MEASUREMENT_FAMILIES,
  "numeric_daily_delta",
]);
const TRANSITION_FAMILIES = new Set([
  "activation",
  "deactivation",
  "home_arrival",
  "home_departure",
  "zone_arrival",
]);

const args = parseArgs(process.argv.slice(2));
const report = JSON.parse(readFileSync(args.input, "utf8"));
validateCandidateReport(report);
const previousCatalog = args.previousCatalog
  ? JSON.parse(readFileSync(args.previousCatalog, "utf8"))
  : null;
if (previousCatalog) validatePreviousCatalog(previousCatalog);
const previousIds = new Set(Array.isArray(previousCatalog?.observations)
  ? previousCatalog.observations.map((observation) => observation.id)
  : []);

const staticSubjects = new Set(report.candidates
  .filter((candidate) => candidate.family === "daily_active_duration" && number(candidate.data.activeFraction) >= 0.98)
  .map((candidate) => candidate.subject.id));
const decisions = report.candidates.map((candidate) => reviewCandidate(candidate, staticSubjects, previousIds));
const preliminarilyPromoted = decisions
  .filter((decision) => decision.decision === "promote")
  .map((decision) => enrichCandidate(decision.candidate));
const equivalentSubjects = synchronizedEquivalentSubjects(preliminarilyPromoted);
const { kept, duplicateRejections } = deduplicate(preliminarilyPromoted, equivalentSubjects);
const allDecisions = [
  ...decisions.filter((decision) => decision.decision === "reject"),
  ...kept.map((candidate) => ({ decision: "promote", reason: "passed_review", candidate })),
  ...duplicateRejections,
];
const promoted = kept
  .map((candidate) => ({ ...candidate, status: "active" }))
  .sort((left, right) => left.family.localeCompare(right.family)
    || left.subject.label.localeCompare(right.subject.label)
    || left.id.localeCompare(right.id));
const rejected = allDecisions.filter((decision) => decision.decision === "reject");
const validThrough = args.validThrough ?? localDate(Date.parse(report.source.windowEnd) + args.validDays * 86_400_000, report.source.timezone);
const summary = {
  candidates: report.candidates.length,
  promoted: promoted.length,
  rejected: rejected.length,
  byFamily: countBy(promoted, (candidate) => candidate.family),
  byConfidence: countBy(promoted, (candidate) => candidate.confidence.band),
  bySubjectDomain: countBy(promoted, (candidate) => candidate.subject.domain),
  rejectionReasons: countBy(rejected, (decision) => decision.reason),
  ...(previousCatalog ? {
    continuity: {
      previousPromoted: previousIds.size,
      corroborated: promoted.filter((candidate) => previousIds.has(candidate.id)).length,
      newlyPromoted: promoted.filter((candidate) => !previousIds.has(candidate.id)).length,
      noLongerPromoted: [...previousIds].filter((id) => !promoted.some((candidate) => candidate.id === id)).length,
    },
  } : {}),
};

const catalog = {
  schemaVersion: 1,
  category: "jarvis_reviewed_house_observations",
  generatedAt: report.generatedAt,
  timezone: report.source.timezone,
  validFrom: localDate(Date.parse(report.source.windowStart), report.source.timezone),
  validThrough,
  sourcePolicy: "Current Home Assistant recorder history only.",
  reviewPolicy: {
    version: POLICY_VERSION,
    trigger: "manual",
    description: "Deterministic broad discovery followed by confidence, provenance, semantic, artefact, duplication, and family-specific reliability gates.",
    boundaries: [
      "Observations describe recorded correlations and distributions, not personal causation or preference.",
      "Public forecasts, infrastructure telemetry, mobile telemetry, circular time templates, recorder reload artefacts, static settings, and redundant device proxies are excluded.",
      "Cumulative meters may supply daily deltas but not typical absolute ranges or time-of-day cycles.",
    ],
  },
  source: report.source,
  summary,
  observations: promoted,
};
const review = {
  schemaVersion: 1,
  category: "jarvis_current_ha_pattern_review",
  reviewedAt: new Date().toISOString(),
  candidateGeneratedAt: report.generatedAt,
  policyVersion: POLICY_VERSION,
  output: args.output,
  summary,
  decisions: allDecisions
    .map((decision) => ({
      id: decision.candidate.id,
      decision: decision.decision,
      reason: decision.reason,
    }))
    .sort((left, right) => left.id.localeCompare(right.id)),
};

writeJson(args.output, catalog);
writeJson(args.reviewOutput, review);
process.stdout.write(`${JSON.stringify({
  success: true,
  output: args.output,
  reviewOutput: args.reviewOutput,
  validThrough,
  summary,
}, null, 2)}\n`);

function reviewCandidate(candidate, staticSubjects, previousIds) {
  const subjectText = `${candidate.subject.id} ${candidate.subject.label}`;
  if (candidate.confidence.band === "low") return reject(candidate, "low_confidence");
  if (PUBLIC_OR_FORECAST.test(subjectText)) return reject(candidate, "public_or_forecast_data");
  if (INFRASTRUCTURE_OR_DIAGNOSTIC.test(subjectText)) return reject(candidate, "infrastructure_or_diagnostic");
  if (MOBILE_TELEMETRY.test(subjectText)) return reject(candidate, "mobile_telemetry");
  if (DERIVED_OR_CIRCULAR.test(subjectText)) return reject(candidate, "derived_or_circular_signal");
  if (VACUUM_CONFIGURATION.test(candidate.subject.id)) return reject(candidate, "static_vacuum_configuration");
  if (REDUNDANT_PROXY.test(candidate.subject.id)) return reject(candidate, "redundant_device_proxy");
  if (UNKNOWN_HOUSEHOLD_DEVICE.test(subjectText)) return reject(candidate, "unknown_household_device");
  if (previousIds.size > 0
    && ["person", "relationship"].includes(candidate.subject.domain)
    && !previousIds.has(candidate.id)) {
    return reject(candidate, "uncorroborated_personal_pattern");
  }
  if (SECONDARY_LIGHT.test(candidate.subject.id)) return reject(candidate, "secondary_light_entity");
  if (NUMERIC_FAMILIES.has(candidate.family) && NON_BEHAVIOURAL_COUNTER.test(candidate.subject.id)) {
    return reject(candidate, "non_behavioural_counter");
  }
  if (["activation", "deactivation", "active_episode_duration"].includes(candidate.family)
    && staticSubjects.has(candidate.subject.id)) {
    return reject(candidate, "static_or_reload_state");
  }

  if (MEASUREMENT_FAMILIES.has(candidate.family)
    && CUMULATIVE_STATE_CLASSES.has(candidate.subject.stateClass)) {
    return reject(candidate, "cumulative_meter_absolute_value");
  }
  if (NUMERIC_FAMILIES.has(candidate.family) && PERIODIC_AGGREGATE.test(candidate.subject.id)) {
    return reject(candidate, "periodic_aggregate_absolute_value");
  }
  if (MEASUREMENT_FAMILIES.has(candidate.family) && HIDDEN_ACCUMULATOR.test(candidate.subject.id)) {
    return reject(candidate, "hidden_accumulator_absolute_value");
  }
  if ((candidate.family === "numeric_daily_cycle" || candidate.family === "numeric_day_night_difference")
    && ["energy", "water", "area", "duration"].includes(candidate.subject.deviceClass)) {
    return reject(candidate, "accumulator_time_profile");
  }
  if (candidate.family === "numeric_daily_delta") {
    const median = number(candidate.data.medianDailyDelta);
    const p90 = number(candidate.data.p90DailyDelta);
    if (median <= 0 && p90 <= 0) return reject(candidate, "zero_daily_delta");
    if (/(?:^|[._])(?:monthly|yearly|hourly|month|year|hour)(?:_|$)/i.test(candidate.subject.id)) {
      return reject(candidate, "mismatched_meter_period");
    }
    if (candidate.subject.deviceClass === "energy"
      && !CUMULATIVE_STATE_CLASSES.has(candidate.subject.stateClass)) {
      return reject(candidate, "non_monotonic_delta_source");
    }
  }
  if (candidate.family === "numeric_typical_range"
    && number(candidate.data.median) === 0
    && number(candidate.data.p10) === 0
    && number(candidate.data.p90) === 0) {
    return reject(candidate, "uninformative_zero_baseline");
  }
  if (MEASUREMENT_FAMILIES.has(candidate.family) && !plausibleMeasurement(candidate)) {
    return reject(candidate, "implausible_measurement_range");
  }
  if (candidate.family === "daily_active_duration") {
    const activeDays = number(candidate.data.activeDays);
    const median = number(candidate.data.medianMinutes);
    const fraction = number(candidate.data.activeFraction);
    if (activeDays < 3 || median <= 0) return reject(candidate, "insufficient_active_days");
    if (fraction >= 0.98) return reject(candidate, "static_or_reload_state");
  }
  if (candidate.family === "active_episode_duration") {
    if (number(candidate.data.distinctDays) < 4 || number(candidate.data.episodeCount) < 4) {
      return reject(candidate, "insufficient_episode_days");
    }
    if (number(candidate.data.medianMinutes) >= 1_200) return reject(candidate, "static_or_reload_state");
  }
  if (TRANSITION_FAMILIES.has(candidate.family)) {
    const distinctDays = number(candidate.data.distinctDays);
    const spread = number(candidate.data.p90Minute) - number(candidate.data.p10Minute);
    if (distinctDays < 4) return reject(candidate, "insufficient_transition_days");
    if (spread > 240) return reject(candidate, "diffuse_time_cluster");
    if (number(candidate.data.shareOfTransitions) < 0.2) return reject(candidate, "weak_time_cluster");
  }
  if (candidate.family === "zone_arrival" && zoneFromCandidate(candidate) === "home") {
    return reject(candidate, "duplicate_home_arrival");
  }
  if (candidate.family === "person_zone_visit" && number(candidate.data.distinctDays) < 3) {
    return reject(candidate, "insufficient_zone_days");
  }
  if (candidate.family === "person_zone_visit" && normalize(candidate.data.zone) === "home") {
    return reject(candidate, "uninformative_home_visit");
  }
  if (candidate.family === "person_pair_timing" && number(candidate.data.distinctDays) < 4) {
    return reject(candidate, "insufficient_pair_days");
  }
  if (candidate.family === "person_light_correlation") {
    if (Math.abs(number(candidate.data.rateDifference)) < 0.2) return reject(candidate, "weak_correlation");
  }
  return { decision: "promote", reason: "passed_review", candidate };
}

function enrichCandidate(candidate) {
  const label = cleanDisplayLabel(candidate.subject.label);
  const aliases = naturalAliases(candidate.subject.aliases, label);
  let data = candidate.data;
  let suggestedAnswer = candidate.suggestedAnswer.startsWith(candidate.subject.label)
    ? `${label}${candidate.suggestedAnswer.slice(candidate.subject.label.length)}`
    : candidate.suggestedAnswer;
  if (candidate.family === "zone_arrival") {
    const phase = String(candidate.data.phase ?? "");
    const zone = zoneFromCandidate(candidate);
    data = { ...candidate.data, zone };
    suggestedAnswer = `${label} usually arrived at ${zone} in the ${phase} around ${formatMinute(number(candidate.data.typicalMinute))}, based on ${candidate.data.transitionCount} events across ${candidate.data.distinctDays} days.`;
  }
  if (candidate.family === "active_episode_duration") {
    suggestedAnswer = `${label} active episodes typically lasted ${formatDuration(number(candidate.data.medianMinutes))}, based on ${candidate.data.episodeCount} episodes across ${candidate.data.distinctDays} days.`;
  }
  return {
    ...candidate,
    subject: { ...candidate.subject, label, aliases },
    data,
    suggestedAnswer,
  };
}

function zoneFromCandidate(candidate) {
  const phase = String(candidate.data.phase ?? "");
  const suffix = candidate.id.split(".zone_arrival.")[1] ?? "";
  const zoneSlug = suffix.endsWith(`_${phase}`) ? suffix.slice(0, -(phase.length + 1)) : suffix;
  return zoneSlug.replaceAll("_", " ");
}

function plausibleMeasurement(candidate) {
  const values = measurementValues(candidate);
  if (values.length < 1) return true;
  const bounds = {
    battery: [0, 100],
    humidity: [0, 100],
    power_factor: [-1.1, 1.1],
    frequency: [40, 70],
    voltage: [-10, 600],
    temperature: [-40, 120],
  }[candidate.subject.deviceClass];
  if (!bounds) return true;
  return values.every((value) => value >= bounds[0] && value <= bounds[1]);
}

function measurementValues(candidate) {
  if (candidate.family === "numeric_typical_range") {
    return [candidate.data.median, candidate.data.p10, candidate.data.p90, candidate.data.minimum, candidate.data.maximum]
      .map(number);
  }
  if (candidate.family === "numeric_day_night_difference") {
    return [candidate.data.dayMedian, candidate.data.nightMedian].map(number);
  }
  if (candidate.family === "numeric_daily_cycle") {
    return [
      candidate.data.peakMedian,
      candidate.data.troughMedian,
      ...(Array.isArray(candidate.data.profile) ? candidate.data.profile.map((item) => item.median) : []),
    ].map(number);
  }
  return [];
}

function synchronizedEquivalentSubjects(candidates) {
  const parent = new Map();
  const find = (value) => {
    const current = parent.get(value) ?? value;
    if (current === value) return value;
    const root = find(current);
    parent.set(value, root);
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const [first, second] = [leftRoot, rightRoot].sort();
    parent.set(second, first);
    parent.set(first, first);
  };
  for (const candidate of candidates) {
    if (candidate.family !== "light_pair_synchrony" || number(candidate.data.jaccardOn) < 0.9) continue;
    const [left, right] = candidate.subject.sourceEntityIds;
    if (left && right) union(left, right);
  }
  return new Map([...parent.keys()].map((key) => [key, find(key)]));
}

function deduplicate(candidates, equivalentSubjects) {
  const groups = new Map();
  for (const candidate of candidates) {
    const key = duplicateKey(candidate, equivalentSubjects);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  const kept = [];
  const duplicateRejections = [];
  for (const group of groups.values()) {
    group.sort((left, right) => right.confidence.score - left.confidence.score
      || right.evidence.evidenceCount - left.evidence.evidenceCount
      || left.id.localeCompare(right.id));
    kept.push(group[0]);
    for (const candidate of group.slice(1)) {
      duplicateRejections.push(reject(candidate, "duplicate_observation"));
    }
  }
  return { kept, duplicateRejections };
}

function duplicateKey(candidate, equivalentSubjects) {
  const qualifier = candidate.family === "person_zone_visit"
    ? String(candidate.data.zone ?? "")
    : candidate.family === "zone_arrival"
      ? `${candidate.data.zone ?? ""}:${candidate.data.phase ?? ""}`
      : TRANSITION_FAMILIES.has(candidate.family)
        ? String(candidate.data.phase ?? "")
        : candidate.family === "person_pair_timing"
          ? String(candidate.data.mode ?? "")
          : "";
  const subjectKey = candidate.family === "person_light_correlation"
    ? candidate.subject.id.split("+").map((id) => equivalentSubjects.get(id) ?? id).join("+")
    : candidate.family === "numeric_daily_delta" && /_(?:consumption|energy)$/i.test(candidate.subject.id)
    ? candidate.subject.id.replace(/_(?:consumption|energy)$/i, "_energy")
    : canonicalLabel(candidate.subject.label);
  return [
    candidate.family,
    subjectKey,
    candidate.subject.deviceClass,
    candidate.subject.unit ?? "",
    qualifier,
  ].join("|");
}

function naturalAliases(input, label) {
  const result = new Set(input.flatMap((value) => aliasVariants(normalize(value))).filter(Boolean));
  const normalizedLabel = normalize(label);
  for (const value of aliasVariants(normalizedLabel)) result.add(value);
  if (/^(?:foxess|shelly)\b/.test(normalizedLabel)) {
    for (const value of aliasVariants(normalizedLabel.replace(/^(?:foxess|shelly)\b/, "").trim())) result.add(value);
  }
  if (normalizedLabel.startsWith("lights ")) {
    const room = normalizedLabel.slice("lights ".length).replace(/\bmain\b/g, "").trim();
    result.add(room);
    result.add(`${room} light`);
    result.add(`${room} lights`);
  }
  return [...result].filter(Boolean).sort();
}

function aliasVariants(value) {
  return [...new Set([
    value,
    POSSESSIVE_NAME ? value.replace(POSSESSIVE_NAME, (match) => `${match.slice(0, -1)} s`) : value,
  ])];
}

function cleanDisplayLabel(value) {
  const spaced = value.replaceAll("_", " ").replace(/\s+/g, " ").trim();
  const words = spaced.split(" ");
  if (words.length === 2 && words[0]?.toLowerCase() === words[1]?.toLowerCase()) return words[0];
  return spaced.replace(/\b(power|energy|current|voltage) \1\b/gi, "$1");
}

function canonicalLabel(value) {
  return normalize(value)
    .replace(/\b([a-z]+) s\b/g, "$1s")
    .replace(/\b(power|energy|current|voltage) \1\b/g, "$1")
    .replace(/\bmain\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function reject(candidate, reason) {
  return { decision: "reject", reason, candidate };
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMinute(value) {
  const minute = ((Math.round(value) % 1_440) + 1_440) % 1_440;
  const hour24 = Math.floor(minute / 60);
  const suffix = hour24 >= 12 ? "PM" : "AM";
  return `${hour24 % 12 || 12}:${String(minute % 60).padStart(2, "0")} ${suffix}`;
}

function formatDuration(minutes) {
  if (minutes < 1) {
    const seconds = Math.max(1, Math.round(minutes * 60));
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} minute${rounded === 1 ? "" : "s"}`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0
    ? `${hours} hour${hours === 1 ? "" : "s"}`
    : `${hours} hour${hours === 1 ? "" : "s"} ${rest} minutes`;
}

function countBy(values, keyFor) {
  const counts = {};
  for (const value of values) {
    const key = keyFor(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function localDate(timeMs, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timeMs)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validateCandidateReport(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.candidates) || !value.source?.timezone) {
    throw new Error("input must be a schemaVersion 1 current-HA candidate report");
  }
  if (!/current home assistant/i.test(String(value.sourcePolicy))) {
    throw new Error("candidate report must come from current Home Assistant data");
  }
}

function validatePreviousCatalog(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.observations)) {
    throw new Error("previous catalogue must use schemaVersion 1 with observations");
  }
}

function parseArgs(argv) {
  const values = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    reviewOutput: DEFAULT_REVIEW_OUTPUT,
    previousCatalog: null,
    validDays: 28,
    validThrough: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || !key?.startsWith("--")) throw new Error(`missing value for ${key}`);
    index += 1;
    if (key === "--input") values.input = resolve(value);
    else if (key === "--output") values.output = resolve(value);
    else if (key === "--review-output") values.reviewOutput = resolve(value);
    else if (key === "--previous-catalog") values.previousCatalog = resolve(value);
    else if (key === "--valid-days") values.validDays = Math.max(1, Math.min(90, Number.parseInt(value, 10)));
    else if (key === "--valid-through") values.validThrough = value;
    else throw new Error(`unknown argument ${key}`);
  }
  return values;
}
