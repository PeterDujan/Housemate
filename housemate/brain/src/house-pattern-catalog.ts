import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { AppConfig } from "./config.js";
import { houseObservationAnswer } from "./house-pattern-observations.js";
import { isTrustedSpeakerTrust, resolveSpeakerPrincipal } from "./speaker-principal.js";
import { normalizeWords as normalize } from "./speech-normalizer.js";
import type { TimeWindow } from "./time-window-parser.js";
import type { VoiceBrainRequest } from "./voice-brain.js";
import { isRecord, requiredFields } from "./value-guards.js";
import { localDate, zonedDateTimeParts } from "./zoned-time.js";
import { householdNameTokens, householdPeople } from "./household.js";
import { HOUSE_TIME_ZONE } from "./house-config.js";

const { string: requiredString, strings: requiredStrings, number: requiredNumber, positiveInteger: requiredPositiveInteger, date: requiredDate, iso: requiredIso } =
  requiredFields("house pattern");

export interface HousePatternAnswer {
  readonly status: "ok" | "declined";
  readonly confidence: "low" | "medium" | "high";
  readonly text: string;
  readonly notes: string;
  readonly sourceEntityIds: readonly string[];
  /** Withheld from an untrusted voice: never spoken, the turn goes to open chat (BasicResult.withheld). */
  readonly withheld?: true;
}

export interface UpcomingHousePatternCommitment {
  readonly patternId: string;
  readonly subjectId: string;
  readonly label: string;
  readonly actionText: string;
  readonly startsAt: string;
  readonly confidence: number;
  readonly sourceEntityIds: readonly string[];
}

interface HousePatternCatalog {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly timezone: string;
  readonly sourcePolicy: string;
  readonly patterns: readonly HousePattern[];
}

interface HousePattern {
  readonly id: string;
  readonly status: "active";
  readonly privacy: "household";
  readonly validFrom: string;
  readonly validThrough: string;
  readonly subject: {
    readonly kind: "person" | "device" | "household";
    readonly id: string;
    readonly label: string;
    readonly aliases: readonly string[];
  };
  readonly behaviour: {
    readonly id: string;
    readonly label: string;
    readonly requiredTermGroups: readonly (readonly string[])[];
  };
  readonly upcomingCommitment?: {
    readonly role: "commitment";
    readonly label: string;
    readonly actionText: string;
    readonly maxLookaheadHours: number;
  };
  readonly confidence: {
    readonly score: number;
    readonly band: "low" | "medium" | "high";
    readonly reason: string;
  };
  readonly evidence: {
    readonly source: "home_assistant_history";
    readonly sourceEntityIds: readonly string[];
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly method: string;
    readonly sampleCount: number;
    readonly samples: readonly string[];
    readonly operatorConfirmedAt?: string;
    readonly claimBoundary?: string;
  };
  readonly data: Readonly<Record<string, unknown>>;
  readonly answers: {
    readonly default: string;
    readonly firstPerson?: string;
    readonly evidence: string;
    readonly variants: readonly {
      readonly selectorTerms: readonly string[];
      readonly text: string;
      readonly firstPersonText?: string;
    }[];
  };
}

interface CatalogCache {
  readonly path: string;
  readonly modifiedMs: number;
  readonly catalog: HousePatternCatalog;
}

const PATTERN_LANGUAGE = /\b(?:usual(?:ly)?|normal(?:ly)?|typical(?:ly)?|generally|often|tend(?:s|ed|ing)?|routines?|patterns?|trends?|habits?|behaviou?r|correlations?|on average|most days|most nights)\b/;
const EVIDENCE_LANGUAGE = /\b(?:evidence|samples?|confidence|how (?:do|did) you know|based on|how sure|why do you think)\b/;
const FIRST_PERSON_LANGUAGE = /\b(?:i|me|my|mine)\b/;

let cachedCatalog: CatalogCache | null = null;

export function defaultHousePatternCatalogPath(config: Pick<AppConfig, "dataDir">): string {
  const override = process.env.JARVIS_V5_HOUSE_PATTERNS_PATH?.trim();
  if (override) return override;
  // The house's own reviewed routines; a house without the file has none yet.
  return join(config.dataDir, "patterns", "house-patterns.json");
}

export function looksLikeHousePatternQuestion(normalized: string): boolean {
  return PATTERN_LANGUAGE.test(normalize(normalized));
}

export function housePatternAnswer(
  config: Pick<AppConfig, "dataDir">,
  request: VoiceBrainRequest,
  normalized: string,
  now: Date,
): HousePatternAnswer | null {
  const question = normalize(normalized);
  if (!looksLikeHousePatternQuestion(question)) return null;

  const principal = resolveSpeakerPrincipal(request.speaker);
  const trusted = isTrustedSpeakerTrust(principal.trust);
  const expandedQuestion = FIRST_PERSON_LANGUAGE.test(question) && trusted && principal.label
    ? `${question} ${normalize(principal.label)}`
    : question;
  const catalog = loadHousePatternCatalog(defaultHousePatternCatalogPath(config));
  const match = bestPatternMatch(catalog.patterns, expandedQuestion, principal.label ?? null, now, catalog.timezone);
  if (!match) {
    const attributedDevice = attributedDevicePattern(catalog.patterns, expandedQuestion, now, catalog.timezone);
    if (!attributedDevice) return houseObservationAnswer(config, request, question, now);
    if (!trusted) {
      return {
        status: "declined",
        confidence: "low",
        text: "",
        notes: `guest mode blocked attributed device pattern ${attributedDevice.id}`,
        sourceEntityIds: [],
        withheld: true,
      };
    }
    const namedPerson = namedPersonLabel(question) ?? "that person";
    return {
      status: "declined",
      confidence: "low",
      text: `I can see the ${attributedDevice.subject.label.toLowerCase()} usage pattern, but I don't have evidence that attributes it to ${namedPerson}.`,
      notes: `house pattern ${attributedDevice.id} rejected unsupported person attribution`,
      sourceEntityIds: attributedDevice.evidence.sourceEntityIds,
    };
  }
  if (!trusted) {
    return {
      status: "declined",
      confidence: "low",
      text: "",
      notes: `guest mode blocked house pattern ${match.pattern.id}`,
      sourceEntityIds: [],
      withheld: true,
    };
  }

  const firstPerson = match.pattern.subject.kind === "person"
    && principal.personId?.toLowerCase() === match.pattern.subject.id.toLowerCase();
  const text = EVIDENCE_LANGUAGE.test(question)
    ? match.pattern.answers.evidence
    : selectedPatternAnswer(match.pattern, question, firstPerson);
  return {
    status: "ok",
    confidence: match.pattern.confidence.band,
    text,
    notes: `house pattern ${match.pattern.id}; score=${match.score}; samples=${match.pattern.evidence.sampleCount}; valid_through=${match.pattern.validThrough}`,
    sourceEntityIds: match.pattern.evidence.sourceEntityIds,
  };
}

/**
 * Project explicitly approved, current, high-confidence routine patterns into
 * a bounded future window. Generic schedule questions may consume these
 * projections; ordinary pattern matching remains wording-independent.
 */
export function upcomingHousePatternCommitments(
  config: Pick<AppConfig, "dataDir">,
  request: VoiceBrainRequest,
  window: TimeWindow,
  now: Date,
): readonly UpcomingHousePatternCommitment[] {
  const principal = resolveSpeakerPrincipal(request.speaker);
  if (!isTrustedSpeakerTrust(principal.trust) || !principal.personId) return [];
  const catalog = loadHousePatternCatalog(defaultHousePatternCatalogPath(config));
  const windowStartMs = Math.max(now.getTime(), Date.parse(window.start));
  const windowEndMs = Date.parse(window.end);
  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs) || windowEndMs <= windowStartMs) return [];

  const commitments: UpcomingHousePatternCommitment[] = [];
  for (const pattern of catalog.patterns) {
    const declaration = pattern.upcomingCommitment;
    if (!declaration
      || pattern.subject.kind !== "person"
      || pattern.subject.id.toLowerCase() !== principal.personId.toLowerCase()
      || pattern.confidence.band !== "high"
      || !pattern.evidence.operatorConfirmedAt
      || !patternIsCurrent(pattern, now, catalog.timezone)) {
      continue;
    }
    const boundedEndMs = Math.min(
      windowEndMs,
      now.getTime() + declaration.maxLookaheadHours * 60 * 60 * 1_000,
    );
    for (const occurrence of patternCommitmentOccurrences(pattern, windowStartMs, boundedEndMs, catalog.timezone)) {
      commitments.push({
        patternId: pattern.id,
        subjectId: pattern.subject.id,
        label: declaration.label,
        actionText: declaration.actionText,
        startsAt: occurrence.toISOString(),
        confidence: pattern.confidence.score,
        sourceEntityIds: pattern.evidence.sourceEntityIds,
      });
    }
  }
  return commitments.sort((left, right) => left.startsAt.localeCompare(right.startsAt));
}

/**
 * Every current reviewed routine, worded for the speaker: the
 * same catalogue and answers the pattern route speaks, listed for open chat.
 * The caller must already have checked the speaker is a trusted household
 * member; guests never reach it.
 */
export function currentHouseRoutineLines(
  config: Pick<AppConfig, "dataDir">,
  speakerActorId: string,
  now: Date,
): readonly string[] {
  let catalog: HousePatternCatalog;
  try {
    catalog = loadHousePatternCatalog(defaultHousePatternCatalogPath(config));
  } catch {
    return [];
  }
  return catalog.patterns
    .filter((pattern) => pattern.status === "active" && patternIsCurrent(pattern, now, catalog.timezone))
    .map((pattern) => selectedPatternAnswer(
      pattern,
      "",
      pattern.subject.kind === "person" && pattern.subject.id.toLowerCase() === speakerActorId.toLowerCase(),
    ));
}

export function loadHousePatternCatalog(path: string): HousePatternCatalog {
  if (!existsSync(path)) return parseHousePatternCatalog({ schemaVersion: 1, timezone: HOUSE_TIME_ZONE, patterns: [] });
  const modifiedMs = statSync(path).mtimeMs;
  if (cachedCatalog?.path === path && cachedCatalog.modifiedMs === modifiedMs) {
    return cachedCatalog.catalog;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const catalog = parseHousePatternCatalog(parsed);
  cachedCatalog = { path, modifiedMs, catalog };
  return catalog;
}

function bestPatternMatch(
  patterns: readonly HousePattern[],
  question: string,
  _principalLabel: string | null,
  now: Date,
  timezone: string,
): { readonly pattern: HousePattern; readonly score: number } | null {
  const tokens = new Set(question.split(" ").filter(Boolean));
  const namedPeople = [...tokens].filter((token) => householdNameTokens().has(token));
  const candidates = patterns
    .filter((pattern) => pattern.status === "active")
    .filter((pattern) => patternIsCurrent(pattern, now, timezone))
    .filter((pattern) => personBoundaryAllows(pattern, namedPeople))
    .map((pattern) => ({ pattern, score: patternScore(pattern, question, tokens) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || right.pattern.confidence.score - left.pattern.confidence.score);
  if (candidates.length < 1) return null;
  if (candidates.length > 1 && candidates[0]!.score === candidates[1]!.score) return null;
  return candidates[0] ?? null;
}

function personBoundaryAllows(pattern: HousePattern, namedPeople: readonly string[]): boolean {
  if (namedPeople.length === 0) return true;
  if (pattern.subject.kind !== "person") return false;
  const aliases = new Set(pattern.subject.aliases.map(normalize));
  return namedPeople.every((person) => aliases.has(person));
}

function patternScore(pattern: HousePattern, question: string, tokens: ReadonlySet<string>): number {
  if (!semanticPatternBoundary(pattern.behaviour.id, question, pattern.behaviour.requiredTermGroups[0] ?? [])) return 0;
  const subjectMatched = pattern.subject.aliases.some((alias) => phraseMatches(question, normalize(alias)));
  if (!subjectMatched && pattern.subject.kind === "person") return 0;
  const requiredGroupsMatched = pattern.behaviour.requiredTermGroups.every((group) =>
    group.some((term) => tokens.has(normalize(term)) || phraseMatches(question, normalize(term))));
  if (!requiredGroupsMatched) return 0;
  const subjectScore = subjectMatched ? 5 : pattern.subject.kind === "device" ? 1 : 0;
  const behaviourScore = pattern.behaviour.requiredTermGroups.length * 3;
  const labelScore = phraseMatches(question, normalize(pattern.behaviour.label)) ? 2 : 0;
  return subjectScore + behaviourScore + labelScore;
}

function attributedDevicePattern(
  patterns: readonly HousePattern[],
  question: string,
  now: Date,
  timezone: string,
): HousePattern | null {
  const tokens = new Set(question.split(" ").filter(Boolean));
  if (![...tokens].some((token) => householdNameTokens().has(token))) return null;
  const matches = patterns
    .filter((pattern) => pattern.subject.kind === "device" && patternIsCurrent(pattern, now, timezone))
    .map((pattern) => ({ pattern, score: patternScore(pattern, question, tokens) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);
  return matches[0]?.pattern ?? null;
}

/** `place`: a found routine's place words (its first term group), for "leave for <place>" and "home from <place>". */
function semanticPatternBoundary(behaviourId: string, question: string, place: readonly string[] = []): boolean {
  const places = place.map((term) => normalize(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter(Boolean).join("|");
  switch (behaviourId) {
    case "leave_home_for_work":
      return /\b(?:leave|leaves|leaving|depart|departs|departing)(?: the)? (?:home|house) for work\b/.test(question)
        || /\b(?:leave|leaves|leaving|depart|departs|departing|go|goes|going|head|heads|heading) (?:off )?(?:for|to) work\b/.test(question)
        || /\bwork departures?\b/.test(question);
    case "return_home_from_work":
      return /\b(?:return|returns|returning|arrive|arrives|arriving|get|gets|getting|come|comes|coming) home from work\b/.test(question)
        || /\b(?:back|home) from work\b/.test(question);
    case "weekday_school_window":
      return /\b(?:when|what time|how long|arrive|arrives|arrival|leave|leaves|finish|finishes|start|starts|dropoff|pickup)\b/.test(question)
        || /\bat school\b/.test(question);
    case "daily_on_duration":
      return /\b(?:how long|duration|usage|use|used|stays?|keeping|kept|leave|leaves|leaving|left)\b/.test(question)
        || /\bon average\b/.test(question);
    default:
      break;
  }
  if (places && behaviourId.startsWith("leave_home_for_")) {
    return new RegExp(`\\b(?:leave|leaves|leaving|depart|departs|departing|go|goes|going|head|heads|heading)(?: off)?(?: the)?(?: home| house)? (?:for|to)(?: the)? (?:${places})\\b`).test(question);
  }
  if (places && behaviourId.startsWith("return_home_from_")) {
    return new RegExp(`\\b(?:(?:return|returns|returning|arrive|arrives|arriving|get|gets|getting|come|comes|coming) )?(?:home|back) from(?: the)? (?:${places})\\b`).test(question);
  }
  return false;
}

function namedPersonLabel(question: string): string | null {
  const tokens = new Set(question.split(" ").filter(Boolean));
  return householdPeople().find((person) => person.aliases.some((alias) => tokens.has(alias)))?.name ?? null;
}

function selectedPatternAnswer(pattern: HousePattern, question: string, firstPerson: boolean): string {
  const variant = pattern.answers.variants.find((candidate) =>
    candidate.selectorTerms.some((term) => phraseMatches(question, normalize(term))));
  if (variant) {
    return firstPerson && variant.firstPersonText ? variant.firstPersonText : variant.text;
  }
  return firstPerson && pattern.answers.firstPerson ? pattern.answers.firstPerson : pattern.answers.default;
}

function patternIsCurrent(pattern: HousePattern, now: Date, timezone: string): boolean {
  const date = localDate(now, timezone);
  return date >= pattern.validFrom && date <= pattern.validThrough;
}

function patternCommitmentOccurrences(
  pattern: HousePattern,
  startMs: number,
  endMs: number,
  timezone: string,
): readonly Date[] {
  if (pattern.data.type !== "time_of_day_by_cohort" || !Array.isArray(pattern.data.cohorts)) return [];
  const dates = localDatesAcrossWindow(new Date(startMs), new Date(endMs), timezone);
  const occurrences: Date[] = [];
  for (const date of dates) {
    for (const rawCohort of pattern.data.cohorts) {
      if (!isRecord(rawCohort) || !Array.isArray(rawCohort.days) || typeof rawCohort.typicalTime !== "string") continue;
      const days = rawCohort.days.filter((day): day is string => typeof day === "string");
      if (!days.includes(localWeekdayForDate(date))) continue;
      const occurrence = zonedLocalDateTime(date, rawCohort.typicalTime, timezone);
      if (occurrence && occurrence.getTime() >= startMs && occurrence.getTime() < endMs) {
        occurrences.push(occurrence);
      }
    }
  }
  return occurrences;
}

function localDatesAcrossWindow(start: Date, end: Date, timezone: string): readonly string[] {
  const first = localDate(start, timezone);
  const last = localDate(new Date(Math.max(start.getTime(), end.getTime() - 1)), timezone);
  const cursor = new Date(`${first}T00:00:00.000Z`);
  const final = new Date(`${last}T00:00:00.000Z`);
  const dates: string[] = [];
  while (cursor.getTime() <= final.getTime() && dates.length < 32) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function localWeekdayForDate(date: string): string {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(`${date}T12:00:00.000Z`).getUTCDay()] ?? "";
}

export function zonedLocalDateTime(date: string, clock: string, timezone: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(clock);
  if (!dateMatch || !timeMatch) return null;
  const localAsUtc = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
  );
  let candidate = new Date(localAsUtc);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedDateTimeParts(candidate, timezone);
    const renderedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    candidate = new Date(candidate.getTime() + (localAsUtc - renderedAsUtc));
  }
  return candidate;
}

function phraseMatches(question: string, phrase: string): boolean {
  return ` ${question} `.includes(` ${phrase} `);
}

export function parseHousePatternCatalog(value: unknown): HousePatternCatalog {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.patterns)) {
    throw new Error("house pattern catalogue must use schemaVersion 1 with a patterns array");
  }
  const patterns = value.patterns.map(validatePattern);
  const ids = new Set<string>();
  for (const pattern of patterns) {
    if (ids.has(pattern.id)) throw new Error(`duplicate house pattern id: ${pattern.id}`);
    ids.add(pattern.id);
  }
  return {
    schemaVersion: 1,
    generatedAt: requiredString(value.generatedAt, "generatedAt"),
    timezone: requiredString(value.timezone, "timezone"),
    sourcePolicy: requiredString(value.sourcePolicy, "sourcePolicy"),
    patterns,
  };
}

function validatePattern(value: unknown): HousePattern {
  if (!isRecord(value) || !isRecord(value.subject) || !isRecord(value.behaviour)
    || !isRecord(value.confidence) || !isRecord(value.evidence) || !isRecord(value.answers)
    || !isRecord(value.data)) {
    throw new Error("house pattern is missing a required structured section");
  }
  if (value.status !== "active" || value.privacy !== "household") {
    throw new Error("house pattern must be active and household-private");
  }
  const subjectKind = value.subject.kind;
  if (subjectKind !== "person" && subjectKind !== "device" && subjectKind !== "household") {
    throw new Error("house pattern subject kind is invalid");
  }
  const band = value.confidence.band;
  if (band !== "low" && band !== "medium" && band !== "high") {
    throw new Error("house pattern confidence band is invalid");
  }
  const score = requiredNumber(value.confidence.score, "confidence.score");
  if (score < 0 || score > 1) throw new Error("house pattern confidence score must be between zero and one");
  if (value.evidence.source !== "home_assistant_history") {
    throw new Error("house pattern evidence must come from current Home Assistant history");
  }
  const groups = requiredStringGroups(value.behaviour.requiredTermGroups, "behaviour.requiredTermGroups");
  const variants = Array.isArray(value.answers.variants)
    ? value.answers.variants.map((variant) => {
        if (!isRecord(variant)) throw new Error("house pattern answer variant is invalid");
        return {
          selectorTerms: requiredStrings(variant.selectorTerms, "answers.variants.selectorTerms"),
          text: requiredString(variant.text, "answers.variants.text"),
          ...(typeof variant.firstPersonText === "string" && variant.firstPersonText.trim()
            ? { firstPersonText: variant.firstPersonText.trim() }
            : {}),
        };
      })
    : [];
  return {
    id: requiredString(value.id, "id"),
    status: "active",
    privacy: "household",
    validFrom: requiredDate(value.validFrom, "validFrom"),
    validThrough: requiredDate(value.validThrough, "validThrough"),
    subject: {
      kind: subjectKind,
      id: requiredString(value.subject.id, "subject.id"),
      label: requiredString(value.subject.label, "subject.label"),
      aliases: requiredStrings(value.subject.aliases, "subject.aliases"),
    },
    behaviour: {
      id: requiredString(value.behaviour.id, "behaviour.id"),
      label: requiredString(value.behaviour.label, "behaviour.label"),
      requiredTermGroups: groups,
    },
    ...(value.upcomingCommitment !== undefined
      ? { upcomingCommitment: validateUpcomingCommitment(value.upcomingCommitment, subjectKind, band, value.data) }
      : {}),
    confidence: {
      score,
      band,
      reason: requiredString(value.confidence.reason, "confidence.reason"),
    },
    evidence: {
      source: "home_assistant_history",
      sourceEntityIds: requiredStrings(value.evidence.sourceEntityIds, "evidence.sourceEntityIds"),
      windowStart: requiredIso(value.evidence.windowStart, "evidence.windowStart"),
      windowEnd: requiredIso(value.evidence.windowEnd, "evidence.windowEnd"),
      method: requiredString(value.evidence.method, "evidence.method"),
      sampleCount: requiredPositiveInteger(value.evidence.sampleCount, "evidence.sampleCount"),
      samples: requiredStrings(value.evidence.samples, "evidence.samples"),
      ...(typeof value.evidence.operatorConfirmedAt === "string"
        ? { operatorConfirmedAt: requiredIso(value.evidence.operatorConfirmedAt, "evidence.operatorConfirmedAt") }
        : {}),
      ...(typeof value.evidence.claimBoundary === "string" && value.evidence.claimBoundary.trim()
        ? { claimBoundary: value.evidence.claimBoundary.trim() }
        : {}),
    },
    data: value.data,
    answers: {
      default: requiredString(value.answers.default, "answers.default"),
      ...(typeof value.answers.firstPerson === "string" && value.answers.firstPerson.trim()
        ? { firstPerson: value.answers.firstPerson.trim() }
        : {}),
      evidence: requiredString(value.answers.evidence, "answers.evidence"),
      variants,
    },
  };
}

function validateUpcomingCommitment(
  value: unknown,
  subjectKind: HousePattern["subject"]["kind"],
  confidenceBand: HousePattern["confidence"]["band"],
  data: Readonly<Record<string, unknown>>,
): NonNullable<HousePattern["upcomingCommitment"]> {
  if (!isRecord(value) || value.role !== "commitment") {
    throw new Error("house pattern upcomingCommitment must declare the commitment role");
  }
  if (subjectKind !== "person" || confidenceBand !== "high" || data.type !== "time_of_day_by_cohort") {
    throw new Error("upcoming commitments require a high-confidence person time_of_day_by_cohort pattern");
  }
  const maxLookaheadHours = requiredNumber(value.maxLookaheadHours, "upcomingCommitment.maxLookaheadHours");
  if (maxLookaheadHours <= 0 || maxLookaheadHours > 168) {
    throw new Error("house pattern upcomingCommitment.maxLookaheadHours must be between 0 and 168");
  }
  return {
    role: "commitment",
    label: requiredString(value.label, "upcomingCommitment.label"),
    actionText: requiredString(value.actionText, "upcomingCommitment.actionText"),
    maxLookaheadHours,
  };
}

function requiredStringGroups(value: unknown, field: string): readonly (readonly string[])[] {
  if (!Array.isArray(value) || value.length < 1) throw new Error(`house pattern ${field} must be a non-empty group array`);
  return value.map((entry) => requiredStrings(entry, field));
}
