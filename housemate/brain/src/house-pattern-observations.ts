import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { AppConfig } from "./config.js";
import { isTrustedSpeakerTrust, resolveSpeakerPrincipal } from "./speaker-principal.js";
import { normalizeWords as normalize } from "./speech-normalizer.js";
import type { VoiceBrainRequest } from "./voice-brain.js";
import { isRecord, requiredFields } from "./value-guards.js";
import { joinNatural } from "./text-format.js";
import { localDate } from "./zoned-time.js";
import { householdPersonById, householdRegex, personNamedIn } from "./household.js";

const { string: requiredString, strings: requiredStrings, number: requiredNumber, positiveInteger: requiredPositiveInteger, date: requiredDate, iso: requiredIso } =
  requiredFields("house observation");

export interface HouseObservationAnswer {
  readonly status: "ok" | "declined";
  readonly confidence: "low" | "medium" | "high";
  readonly text: string;
  readonly notes: string;
  readonly sourceEntityIds: readonly string[];
  /** Withheld from an untrusted voice: never spoken, the turn goes to open chat (BasicResult.withheld). */
  readonly withheld?: true;
}

type ObservationFamily =
  | "activation"
  | "active_episode_duration"
  | "daily_active_duration"
  | "deactivation"
  | "home_arrival"
  | "home_departure"
  | "light_pair_synchrony"
  | "numeric_daily_cycle"
  | "numeric_daily_delta"
  | "numeric_day_night_difference"
  | "numeric_typical_range"
  | "person_light_correlation"
  | "person_pair_timing"
  | "person_zone_visit"
  | "zone_arrival";

interface HouseObservationCatalog {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly timezone: string;
  readonly validFrom: string;
  readonly validThrough: string;
  readonly sourcePolicy: string;
  readonly observations: readonly HouseObservation[];
}

interface HouseObservation {
  readonly id: string;
  readonly status: "active";
  readonly family: ObservationFamily;
  readonly subject: {
    readonly kind: "entity" | "person" | "relationship";
    readonly id: string;
    readonly sourceEntityIds: readonly string[];
    readonly domain: string;
    readonly deviceClass: string;
    readonly stateClass: string;
    readonly label: string;
    readonly aliases: readonly string[];
    readonly unit: string | null;
  };
  readonly confidence: {
    readonly score: number;
    readonly band: "medium" | "high";
  };
  readonly evidence: {
    readonly source: "home_assistant_history";
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly evidenceCount: number;
    readonly observationCount: number;
    readonly method: string;
  };
  readonly data: Readonly<Record<string, unknown>>;
  readonly suggestedAnswer: string;
}

interface ObservationCache {
  readonly path: string;
  readonly modifiedMs: number;
  readonly catalog: HouseObservationCatalog;
}

interface FamilyIntent {
  readonly family: ObservationFamily;
  readonly score: number;
}

interface ObservationSelection {
  readonly kind: "match";
  readonly observations: readonly HouseObservation[];
  readonly score: number;
}

interface ObservationAmbiguity {
  readonly kind: "ambiguous";
}

const OBSERVATION_FAMILIES = new Set<ObservationFamily>([
  "activation",
  "active_episode_duration",
  "daily_active_duration",
  "deactivation",
  "home_arrival",
  "home_departure",
  "light_pair_synchrony",
  "numeric_daily_cycle",
  "numeric_daily_delta",
  "numeric_day_night_difference",
  "numeric_typical_range",
  "person_light_correlation",
  "person_pair_timing",
  "person_zone_visit",
  "zone_arrival",
]);
const EVIDENCE_LANGUAGE = /\b(?:evidence|samples?|confidence|how (?:do|did) you know|based on|how sure|why do you think)\b/;
const FIRST_PERSON_LANGUAGE = /\b(?:i|me|my|mine)\b/;
const PHASES = ["overnight", "morning", "afternoon", "evening"] as const;
const GENERIC_SUBJECT_TOKENS = new Set([
  "active", "area", "battery", "current", "daily", "duration", "energy", "level", "light", "lights", "lock",
  "main", "normal", "normally", "power", "sensor", "total", "typical", "usually", "value", "voltage",
]);
const deviceAttribution = (): RegExp => householdRegex(String.raw`\b(?:does|did|is|has) {NAMES}(?! s\b) (?:(?:usually|normally|typically|often|generally|always|tend to) )*(?:use|turn|leave|keep|operate|prefer|love)\b|\bdo i (?:(?:usually|normally|typically|often|generally|always|tend to) )*(?:use|turn|leave|keep|operate|prefer|love)\b`);

let cachedCatalog: ObservationCache | null = null;

export function defaultHouseObservationCatalogPath(config: Pick<AppConfig, "dataDir">): string {
  const override = process.env.JARVIS_V5_HOUSE_OBSERVATIONS_PATH?.trim();
  if (override) return override;
  // The house's own reviewed observations; a house without the file has none yet.
  return join(config.dataDir, "patterns", "house-pattern-observations.json");
}

export function houseObservationAnswer(
  config: Pick<AppConfig, "dataDir">,
  request: VoiceBrainRequest,
  normalized: string,
  now: Date,
): HouseObservationAnswer | null {
  const question = normalize(normalized);
  const intents = familyIntents(question);
  if (intents.length < 1) return null;

  const principal = resolveSpeakerPrincipal(request.speaker);
  const trusted = isTrustedSpeakerTrust(principal.trust);
  const expandedQuestion = FIRST_PERSON_LANGUAGE.test(question) && trusted && principal.label
    ? `${question} ${normalize(principal.label)}`
    : question;
  const path = defaultHouseObservationCatalogPath(config);
  let catalog: HouseObservationCatalog;
  try {
    catalog = loadHouseObservationCatalog(path);
  } catch {
    return null;
  }
  if (!catalogIsCurrent(catalog, now)) return null;
  const selection = selectObservations(catalog.observations, expandedQuestion, intents);
  if (!selection) return null;
  if (!trusted) {
    return {
      status: "declined",
      confidence: "low",
      text: "",
      notes: "guest mode blocked reviewed house observation",
      sourceEntityIds: [],
      withheld: true,
    };
  }
  if (selection.kind === "ambiguous") {
    return {
      status: "declined",
      confidence: "low",
      text: "I found several matching household patterns. Name the exact device or sensor you mean.",
      notes: "reviewed house observation subject was ambiguous",
      sourceEntityIds: [],
    };
  }

  const first = selection.observations[0];
  if (!first) return null;
  if (first.subject.kind === "entity" && deviceAttribution().test(question) && namedPersonLabel(question)) {
    return {
      status: "declined",
      confidence: "low",
      text: `I can see the ${first.subject.label.toLowerCase()} pattern, but the data doesn't show that ${namedPersonLabel(question)} caused or preferred it.`,
      notes: `reviewed observation ${first.id} rejected unsupported person attribution`,
      sourceEntityIds: first.subject.sourceEntityIds,
    };
  }

  const evidenceRequested = EVIDENCE_LANGUAGE.test(question);
  const text = evidenceRequested
    ? evidenceAnswer(selection.observations)
    : firstPersonAnswer(renderAnswer(selection.observations), first, principal.personId ?? null);
  return {
    status: "ok",
    confidence: weakestConfidence(selection.observations),
    text,
    notes: `reviewed house observations ${selection.observations.map((item) => item.id).join(",")}; score=${selection.score}; valid_through=${catalog.validThrough}`,
    sourceEntityIds: unique(selection.observations.flatMap((item) => item.subject.sourceEntityIds)),
  };
}

/** Families about people's comings and goings, as opposed to device readings. */
const PERSON_ROUTINE_FAMILIES: ReadonlySet<ObservationFamily> = new Set([
  "home_arrival",
  "home_departure",
  "person_zone_visit",
  "zone_arrival",
  "person_pair_timing",
]);

/**
 * The reviewed comings-and-goings observations still in date, as
 * their reviewed sentences, for open chat. Trusted household speakers only;
 * the caller checks that.
 */
export function currentPersonObservationLines(config: Pick<AppConfig, "dataDir">, now: Date): readonly string[] {
  let catalog: HouseObservationCatalog;
  try {
    catalog = loadHouseObservationCatalog(defaultHouseObservationCatalogPath(config));
  } catch {
    return [];
  }
  if (!catalogIsCurrent(catalog, now)) return [];
  return catalog.observations
    .filter((item) => item.status === "active" && PERSON_ROUTINE_FAMILIES.has(item.family))
    .map((item) => item.suggestedAnswer);
}

export function loadHouseObservationCatalog(path: string): HouseObservationCatalog {
  if (!existsSync(path)) {
    return validateCatalog({
      schemaVersion: 1,
      sourcePolicy: "Current Home Assistant recorder history only.",
      observations: [],
    });
  }
  const modifiedMs = statSync(path).mtimeMs;
  if (cachedCatalog?.path === path && cachedCatalog.modifiedMs === modifiedMs) return cachedCatalog.catalog;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const catalog = validateCatalog(parsed);
  cachedCatalog = { path, modifiedMs, catalog };
  return catalog;
}

function familyIntents(question: string): readonly FamilyIntent[] {
  const scores = new Map<ObservationFamily, number>();
  const add = (family: ObservationFamily, score: number): void => {
    scores.set(family, Math.max(score, scores.get(family) ?? 0));
  };
  const asksWhen = /\b(?:when|what time)\b/.test(question);
  const asksHowLong = /\bhow long\b/.test(question);
  const perDay = /\b(?:per|a|each|every) day\b|\bdaily\b/.test(question);
  const arriving = /\b(?:arrive|arrives|arrival|come|comes|coming|get|gets|getting)\b/.test(question);
  const departing = /\b(?:leave|leaves|leaving|depart|departs|departure|go out|goes out|going out)\b/.test(question);
  const home = /\b(?:home|house)\b/.test(question);
  const together = /\b(?:together|same time|synchron(?:y|ised|ized)|in sync)\b/.test(question);

  if (together && /\blights?\b/.test(question)) add("light_pair_synchrony", 16);
  if (together && (arriving || departing)) add("person_pair_timing", 16);
  if (/\b(?:correlation|relationship|associated|linked)\b/.test(question)
    && /\blights?\b/.test(question)
    && namedPersonLabel(question)) add("person_light_correlation", 17);
  if (/\b(?:home (?:versus|vs) away|when .* (?:is|am|are) (?:at )?home|when .* (?:is|am|are) away)\b/.test(question)
    && /\blights?\b/.test(question)) add("person_light_correlation", 17);
  if (arriving && home) add("home_arrival", 15);
  if (departing && home) add("home_departure", 15);
  if (arriving && !home && /\b(?:at|to)\b/.test(question)) add("zone_arrival", 14);
  if (/\b(?:visit|visits|go|goes|going)\b/.test(question)
    && /\b(?:how often|how frequently|usual|usually|normal|normally|typical|typically)\b/.test(question)) {
    add("person_zone_visit", 13);
  }
  if (asksHowLong) {
    if (perDay) add("daily_active_duration", 14);
    else if (/\b(?:each time|at a time|stay|stays|remain|episode)\b/.test(question)) add("active_episode_duration", 14);
    else {
      add("daily_active_duration", 12);
      add("active_episode_duration", 9);
    }
  }
  if (/\b(?:leave|leaves|keep|keeps)\b.*\bon\b/.test(question)) add("daily_active_duration", 13);
  if (perDay && /\b(?:energy|water|use|uses|usage|consume|consumes|consumption|change|changes|clean|cleans)\b/.test(question)) {
    add("numeric_daily_delta", 15);
  }
  if (/\b(?:peak|peaks|highest|lowest|trough|time of day)\b/.test(question)) add("numeric_daily_cycle", 15);
  if (/\b(?:daytime|day versus night|day vs night|overnight compared|during the day|during the night)\b/.test(question)) {
    add("numeric_day_night_difference", 15);
  }
  if (/\b(?:range|reading|level|value|sit at|normally at|usually at|average)\b/.test(question)) {
    add("numeric_typical_range", 12);
  }
  if (asksWhen && /\b(?:turn|turns|come|comes|switch|switches|start|starts|open|opens|unlock|unlocks|activate|activates) on\b|\b(?:start|starts|open|opens|unlock|unlocks|activate|activates)\b/.test(question)) {
    add("activation", 14);
  }
  if (/\b(?:activation|turn on)\b/.test(question)) add("activation", 13);
  if (asksWhen && /\b(?:turn|turns|switch|switches|go|goes) off\b|\b(?:stop|stops|close|closes|lock|locks|deactivate|deactivates)\b/.test(question)) {
    add("deactivation", 14);
  }
  if (/\b(?:deactivation|turn off)\b/.test(question)) add("deactivation", 13);
  if (scores.size < 1
    && /\b(?:what|how much)\b/.test(question)
    && /\b(?:air quality|battery|count|current|energy|frequency|humidity|illuminance|level|power|pressure|reading|speed|temperature|value|voltage|water|weight)\b/.test(question)) {
    add("numeric_typical_range", 7);
  }
  return [...scores.entries()].map(([family, score]) => ({ family, score }));
}

function selectObservations(
  observations: readonly HouseObservation[],
  question: string,
  intents: readonly FamilyIntent[],
): ObservationSelection | ObservationAmbiguity | null {
  const intentScores = new Map(intents.map((intent) => [intent.family, intent.score]));
  const groups = new Map<string, { observations: HouseObservation[]; score: number }>();
  for (const observation of observations) {
    const intentScore = intentScores.get(observation.family);
    if (intentScore === undefined) continue;
    const subject = subjectScore(observation, question);
    if (subject <= 0 || !relationshipBoundaryAllows(observation, question)) continue;
    const qualifier = qualifierScore(observation, question);
    if (!Number.isFinite(qualifier)) continue;
    const score = intentScore + subject + qualifier + domainScore(observation, question) + observation.confidence.score;
    const key = observationGroupKey(observation);
    const group = groups.get(key) ?? { observations: [], score };
    group.observations.push(observation);
    group.score = Math.max(group.score, score);
    groups.set(key, group);
  }
  const ranked = [...groups.values()].sort((left, right) => right.score - left.score
    || right.observations[0]!.confidence.score - left.observations[0]!.confidence.score);
  const first = ranked[0];
  if (!first || first.score < 16) {
    const looseGroups = new Set(observations
      .filter((observation) => intentScores.has(observation.family))
      .filter((observation) => looseSubjectOverlap(observation, question))
      .filter((observation) => relationshipBoundaryAllows(observation, question))
      .map(observationGroupKey));
    return looseGroups.size > 1 ? { kind: "ambiguous" } : null;
  }
  const second = ranked[1];
  if (second && second.score >= first.score - 0.5) return { kind: "ambiguous" };
  return {
    kind: "match",
    observations: first.observations.sort((left, right) => dataNumber(left, "typicalMinute") - dataNumber(right, "typicalMinute")),
    score: round(first.score, 2),
  };
}

function domainScore(observation: HouseObservation, question: string): number {
  if (/\b(?:lock|locks|locked|locking|unlock|unlocks|unlocked|unlocking)\b/.test(question)) {
    return observation.subject.domain === "lock" ? 10 : -10;
  }
  return 0;
}

function looseSubjectOverlap(observation: HouseObservation, question: string): boolean {
  const questionTokens = new Set(question.split(" ").filter(Boolean));
  return [observation.subject.label, ...observation.subject.aliases].some((alias) =>
    normalize(alias)
      .split(" ")
      .some((token) => token.length >= 3 && !GENERIC_SUBJECT_TOKENS.has(token) && questionTokens.has(token)));
}

function subjectScore(observation: HouseObservation, question: string): number {
  const questionTokens = new Set(question.split(" ").filter(Boolean));
  let best = 0;
  for (const rawAlias of [observation.subject.label, ...observation.subject.aliases]) {
    const alias = normalize(rawAlias);
    if (!alias) continue;
    const aliasTokens = alias.split(" ").filter(Boolean);
    const distinctive = [...new Set(aliasTokens.filter((token) => !GENERIC_SUBJECT_TOKENS.has(token)))];
    const distinctiveMatches = distinctive.filter((token) => questionTokens.has(token));
    if (distinctiveMatches.length < 1) continue;
    if (phraseMatches(question, alias)) {
      best = Math.max(best, 20 + aliasTokens.length);
      continue;
    }
    const coverage = distinctiveMatches.length / distinctive.length;
    if (coverage < 0.67) continue;
    best = Math.max(best, 6 + coverage * 8 + distinctiveMatches.length);
  }
  return best;
}

function relationshipBoundaryAllows(observation: HouseObservation, question: string): boolean {
  if (observation.subject.kind !== "relationship") return true;
  const subjectIds = observation.subject.id.split("+");
  if (observation.family === "person_pair_timing") {
    return subjectIds.filter((id) => id.startsWith("person.")).every((id) => personMentioned(id, question));
  }
  if (observation.family === "person_light_correlation") {
    const personId = subjectIds.find((id) => id.startsWith("person."));
    const lightId = subjectIds.find((id) => id.startsWith("light."));
    return Boolean(personId && lightId && personMentioned(personId, question) && entityMentioned(lightId, question));
  }
  return true;
}

function qualifierScore(observation: HouseObservation, question: string): number {
  const namedPhase = PHASES.find((phase) => question.includes(phase));
  const observationPhase = dataString(observation, "phase");
  if (namedPhase && observationPhase && namedPhase !== observationPhase) return Number.NEGATIVE_INFINITY;
  let score = namedPhase && namedPhase === observationPhase ? 5 : 0;
  if (observation.family === "person_zone_visit" || observation.family === "zone_arrival") {
    const zone = normalize(dataString(observation, "zone"));
    if (zone && phraseMatches(question, zone)) score += 8;
  }
  if (observation.family === "person_pair_timing") {
    const mode = dataString(observation, "mode");
    if (mode === "arrival" && /\b(?:arrive|arrives|arrival|come|comes)\b/.test(question)) score += 5;
    if (mode === "departure" && /\b(?:leave|leaves|depart|departure|go out)\b/.test(question)) score += 5;
  }
  return score;
}

function observationGroupKey(observation: HouseObservation): string {
  if (observation.family === "person_zone_visit" || observation.family === "zone_arrival") {
    return `${observation.family}|${observation.subject.id}|${dataString(observation, "zone")}`;
  }
  if (observation.family === "person_pair_timing") {
    return `${observation.family}|${observation.subject.id}|${dataString(observation, "mode")}`;
  }
  return `${observation.family}|${observation.subject.id}`;
}

function renderAnswer(observations: readonly HouseObservation[]): string {
  const first = observations[0];
  if (!first) return "I don't have a reliable reviewed pattern for that yet.";
  if (["activation", "deactivation", "home_arrival", "home_departure"].includes(first.family)) {
    return transitionAnswer(observations);
  }
  if (first.family === "numeric_daily_delta") return dailyDeltaAnswer(first);
  if (first.family === "person_pair_timing") return personPairAnswer(first);
  return first.suggestedAnswer;
}

function transitionAnswer(observations: readonly HouseObservation[]): string {
  const first = observations[0]!;
  const details = observations.map((observation) => {
    const phase = dataString(observation, "phase");
    const time = formatMinute(dataNumber(observation, "typicalMinute"));
    const events = dataNumber(observation, "transitionCount");
    const days = dataNumber(observation, "distinctDays");
    return `${phase ? `in the ${phase} ` : ""}around ${time} (${events} events across ${days} days)`;
  });
  const joined = joinNatural(details);
  const coverage = observations.reduce((total, observation) => total + dataNumber(observation, "shareOfTransitions"), 0);
  if (coverage < 0.6) {
    const noun = transitionClusterNoun(first);
    const clusters = observations.length === 1 ? `a repeated ${noun} cluster` : `repeated ${noun} clusters`;
    return `${first.subject.label} had ${clusters} ${joined}. ${Math.round(coverage * 100)}% of recorded events fell into ${observations.length === 1 ? "that cluster" : "those clusters"}; the rest were less consistent.`;
  }
  if (first.family === "home_arrival") return `${first.subject.label} usually arrived home ${joined}.`;
  if (first.family === "home_departure") return `${first.subject.label} usually left home ${joined}.`;
  const verb = transitionVerb(first);
  return `${first.subject.label} ${verb} ${joined}.`;
}

function transitionClusterNoun(observation: HouseObservation): string {
  if (observation.family === "home_arrival") return "home-arrival";
  if (observation.family === "home_departure") return "home-departure";
  if (observation.subject.domain === "light") return observation.family === "activation" ? "turn-on" : "turn-off";
  if (observation.subject.domain === "lock") return observation.family === "activation" ? "unlock" : "lock";
  if (observation.subject.domain === "vacuum") return observation.family === "activation" ? "cleaning-start" : "cleaning-stop";
  return observation.family === "activation" ? "activation" : "deactivation";
}

function transitionVerb(observation: HouseObservation): string {
  const activating = observation.family === "activation";
  if (observation.subject.domain === "light") return activating ? "usually turned on" : "usually turned off";
  if (observation.subject.domain === "lock") return activating ? "was usually unlocked" : "was usually locked";
  if (observation.subject.domain === "vacuum") return activating ? "usually started cleaning" : "usually stopped cleaning";
  if (observation.subject.domain === "media_player") return activating ? "usually started" : "usually stopped";
  return activating ? "usually became active" : "usually became inactive";
}

function dailyDeltaAnswer(observation: HouseObservation): string {
  const median = formatValue(dataNumber(observation, "medianDailyDelta"), observation.subject.unit);
  const p10 = formatValue(dataNumber(observation, "p10DailyDelta"), observation.subject.unit);
  const p90 = formatValue(dataNumber(observation, "p90DailyDelta"), observation.subject.unit);
  const days = dataNumber(observation, "observedDays");
  if (p10 === p90) return `${observation.subject.label} recorded a median daily change of ${median} across ${days} complete days.`;
  return `${observation.subject.label} recorded a median daily change of ${median}; the middle 80% ran from ${p10} to ${p90} across ${days} complete days.`;
}

function personPairAnswer(observation: HouseObservation): string {
  const mode = dataString(observation, "mode");
  const pairs = dataNumber(observation, "pairCount");
  const days = dataNumber(observation, "distinctDays");
  const separation = formatDuration(dataNumber(observation, "medianSeparationMinutes"));
  return `${observation.subject.label} had ${pairs} near-simultaneous home ${mode}s across ${days} days, usually within ${separation}.`;
}

function evidenceAnswer(observations: readonly HouseObservation[]): string {
  const first = observations[0]!;
  const count = observations.reduce((total, observation) => total + observation.evidence.evidenceCount, 0);
  const boundary = observations
    .map((observation) => dataString(observation, "claimBoundary"))
    .find(Boolean);
  const base = `That is based on ${count} recorded observations from ${first.evidence.windowStart.slice(0, 10)} to ${first.evidence.windowEnd.slice(0, 10)}, using ${first.evidence.method}. Reviewed confidence is ${weakestConfidence(observations)}.`;
  return boundary ? `${base} ${boundary}` : base;
}

function firstPersonAnswer(text: string, observation: HouseObservation, principalPersonId: string | null): string {
  if (observation.subject.kind !== "person" || !principalPersonId
    || observation.subject.id.toLowerCase() !== principalPersonId.toLowerCase()) return text;
  const label = observation.subject.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .replace(new RegExp(`^${label}'s\\b`, "i"), "Your")
    .replace(new RegExp(`^${label}\\b`, "i"), "You");
}

function weakestConfidence(observations: readonly HouseObservation[]): "medium" | "high" {
  return observations.some((observation) => observation.confidence.band === "medium") ? "medium" : "high";
}

function catalogIsCurrent(catalog: HouseObservationCatalog, now: Date): boolean {
  const today = localDate(now, catalog.timezone);
  return today >= catalog.validFrom && today <= catalog.validThrough;
}

function personMentioned(personId: string, question: string): boolean {
  return (householdPersonById(personId)?.aliases ?? []).some((alias) => phraseMatches(question, alias));
}

function entityMentioned(entityId: string, question: string): boolean {
  const tokens = entityId.split(".")[1]?.split("_").filter((token) => token && !GENERIC_SUBJECT_TOKENS.has(token)) ?? [];
  return tokens.some((token) => phraseMatches(question, token));
}

function namedPersonLabel(question: string): string | null {
  const person = personNamedIn(question);
  if (person) return person.name;
  if (/\b(?:i|me|my)\b/.test(question)) return "you";
  return null;
}

function dataNumber(observation: HouseObservation, field: string): number {
  const value = observation.data[field];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function dataString(observation: HouseObservation, field: string): string {
  const value = observation.data[field];
  return typeof value === "string" ? value : "";
}

function formatMinute(value: number): string {
  const minute = ((Math.round(value) % 1_440) + 1_440) % 1_440;
  const hour24 = Math.floor(minute / 60);
  const suffix = hour24 >= 12 ? "PM" : "AM";
  return `${hour24 % 12 || 12}:${String(minute % 60).padStart(2, "0")} ${suffix}`;
}

function formatValue(value: number, unit: string | null): string {
  return `${Number.isInteger(value) ? value : round(value, 2)}${unit ? ` ${unit}` : ""}`;
}

function formatDuration(minutes: number): string {
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

function phraseMatches(question: string, phrase: string): boolean {
  return ` ${question} `.includes(` ${normalize(phrase)} `);
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function validateCatalog(value: unknown): HouseObservationCatalog {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.observations)) {
    throw new Error("house observation catalogue must use schemaVersion 1 with observations");
  }
  const sourcePolicy = requiredString(value.sourcePolicy, "sourcePolicy");
  if (!/current home assistant/i.test(sourcePolicy)) {
    throw new Error("house observation catalogue must require current HA data");
  }
  const observations = value.observations.map(validateObservation);
  const ids = new Set<string>();
  for (const observation of observations) {
    if (ids.has(observation.id)) throw new Error(`duplicate house observation id: ${observation.id}`);
    ids.add(observation.id);
  }
  return {
    schemaVersion: 1,
    generatedAt: requiredIso(value.generatedAt, "generatedAt"),
    timezone: requiredString(value.timezone, "timezone"),
    validFrom: requiredDate(value.validFrom, "validFrom"),
    validThrough: requiredDate(value.validThrough, "validThrough"),
    sourcePolicy,
    observations,
  };
}

function validateObservation(value: unknown): HouseObservation {
  if (!isRecord(value) || !isRecord(value.subject) || !isRecord(value.confidence)
    || !isRecord(value.evidence) || !isRecord(value.data)) {
    throw new Error("house observation is missing a structured section");
  }
  const family = requiredString(value.family, "family");
  if (!OBSERVATION_FAMILIES.has(family as ObservationFamily)) throw new Error(`invalid observation family: ${family}`);
  const kind = value.subject.kind;
  if (kind !== "entity" && kind !== "person" && kind !== "relationship") throw new Error("invalid observation subject kind");
  const band = value.confidence.band;
  if (band !== "medium" && band !== "high") throw new Error("reviewed observation confidence must be medium or high");
  const score = requiredNumber(value.confidence.score, "confidence.score");
  if (score < 0 || score > 1) throw new Error("observation confidence score must be between zero and one");
  if (value.status !== "active" || value.evidence.source !== "home_assistant_history") {
    throw new Error("reviewed observations must be active and sourced from Home Assistant history");
  }
  const sourceEntityIds = requiredStrings(value.subject.sourceEntityIds, "subject.sourceEntityIds");
  return {
    id: requiredString(value.id, "id"),
    status: "active",
    family: family as ObservationFamily,
    subject: {
      kind,
      id: requiredString(value.subject.id, "subject.id"),
      sourceEntityIds,
      domain: requiredString(value.subject.domain, "subject.domain"),
      deviceClass: requiredString(value.subject.deviceClass, "subject.deviceClass"),
      stateClass: requiredString(value.subject.stateClass, "subject.stateClass"),
      label: requiredString(value.subject.label, "subject.label"),
      aliases: requiredStrings(value.subject.aliases, "subject.aliases"),
      unit: typeof value.subject.unit === "string" ? value.subject.unit : null,
    },
    confidence: { score, band },
    evidence: {
      source: "home_assistant_history",
      windowStart: requiredIso(value.evidence.windowStart, "evidence.windowStart"),
      windowEnd: requiredIso(value.evidence.windowEnd, "evidence.windowEnd"),
      evidenceCount: requiredPositiveInteger(value.evidence.evidenceCount, "evidence.evidenceCount"),
      observationCount: requiredPositiveInteger(value.evidence.observationCount, "evidence.observationCount"),
      method: requiredString(value.evidence.method, "evidence.method"),
    },
    data: value.data,
    suggestedAnswer: requiredString(value.suggestedAnswer, "suggestedAnswer"),
  };
}
