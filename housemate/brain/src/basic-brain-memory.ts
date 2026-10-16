import { createHash } from "node:crypto";
import { looksLikeAssistantSelfOpinionPrompt } from "./assistant-self-opinion.js";
import { displaySubject, memoryPlainText, subjectMatchesSpeaker } from "./memory-recall.js";
import { cognitiveFeatureEnabled } from "./cognitive-control.js";
import {
  canonicalRecallActorId,
  canonicalRecallSubjectId,
  memoryRecordRecallAllowed,
} from "./memory-access.js";
import {
  buildEpisodicRecallQuery,
  classifyPersonalMemoryQuestion,
  episodicHistoricalEvidenceWindow,
  episodicNoMatchText,
  episodicRecallText,
  looksLikeAgeQuestion,
  looksLikeBirthDateQuestion,
  recallEpisodicMemories,
} from "./episodic-memory-query.js";
import type { EpisodicRecallQuery } from "./episodic-memory-query.js";
import {
  inferHistoricalPresence,
  resolveHistoricalPersonEntityId,
  type HistoricalPresenceOpportunity,
} from "./episodic-presence-inference.js";
import type { BasicBrainRouteServices } from "./basic-brain-services.js";
import type { BasicContextFrame } from "./basic-brain-contracts.js";
import type { TimeWindow } from "./time-window-parser.js";
import {
  episodicDaySuppressionTagForInstant,
  storedEpisodicDaySuppressionTags,
} from "./memory-claim.js";
import { noteMemoryRetrieved } from "./memory-salience.js";
import { type MemoryRecord } from "./memory-schema.js";
import { MemoryStore, memoryStorePath } from "./memory-store.js";
import { normalizeRoutingText as normalize } from "./routing-text.js";
import { isTrustedSpeakerTrust, resolveSpeakerPrincipal, trustedSpeakerLabel } from "./speaker-principal.js";
import { normalizeSpeechForRouting } from "./speech-normalizer.js";
import { type VoiceBrainRequest } from "./voice-brain.js";
import { formatNumber } from "./text-format.js";
import { declined, ok, withReadFallback, withheld, type BasicResult } from "./basic-brain-contracts.js";
import { householdNameTokens, householdPersonByName, householdRegex, personNamedIn } from "./household.js";
import { HOUSE_LOCALE, HOUSE_TIME_ZONE } from "./house-config.js";

export interface MemoryConfig {
  readonly dataDir: string;
  readonly cognitiveSystemEnabled?: boolean;
  readonly cognitiveLearningEnabled?: boolean;
  readonly cognitiveRecallEnabled?: boolean;
}

export interface MemoryRouteResult {
  readonly route: "memory_query";
  readonly status: "ok" | "declined";
  readonly confidence: "high" | "medium" | "low";
  readonly text: string;
  readonly modelUsed: false;
  readonly resultId: null;
  readonly touchedEntities: readonly string[];
  readonly notes: string;
  readonly historicalPresenceOpportunity?: HistoricalPresenceOpportunity;
}


export function looksLikePersonalMemoryQuestion(
  normalized: string,
  timeWindowOverride: TimeWindow | null = null,
): boolean {
  return classifyPersonalMemoryQuestion(normalized, timeWindowOverride) !== null;
}

export function looksLikeMemoryQuery(
  normalized: string,
  assistantSelfOpinion = looksLikeAssistantSelfOpinionPrompt(normalized),
): boolean {
  if (/\blike a person\b/.test(normalized)) {
    return false;
  }
  if (assistantSelfOpinion) {
    return false;
  }
  if (looksLikePersonalMemoryQuestion(normalized)) {
    return true;
  }
  if (/\b(remember|memory|memories|preference|prefer|favo(?:u)?rite|what do you know|what you know)\b/.test(normalized)) {
    return true;
  }
  if (/\b(?:my|our)\b.*\b(?:saved|remembered)\b.*\b(?:rule|cutoff|threshold|preference)\b/.test(normalized)) {
    return true;
  }
  return /\b(?:what does|does|who|tell me what)\b.*\blikes?\b/.test(normalized)
    || /\blikes?\b.*\b(?:best|more|most)\b/.test(normalized);
}

export function looksLikeOutdoorClothingMemoryQuestion(normalized: string): boolean {
  if (/\bdress(?:ed|ing)? up as\b/.test(normalized)) {
    return false;
  }
  const hasClothingTerm = /\b(jacket|jumper|coat|wear|wearing|dress|dressed|dressing|clothing|clothes|layers?)\b/.test(normalized);
  const asksPersonalPreference = /\b(preference|preferences|prefer|usually|normally|rule|threshold|cutoff|what do you know|what you know|know about|remember|remembered|memory|memories|recall|saved|what have i told|what have i said)\b/.test(normalized);
  const asksPersonalThreshold = /\b(?:at|above|below|over|under) what temperature\b/.test(normalized)
    || householdRegex(String.raw`\bwhat temperature\b.*\b(?:do|does|would|should)\b.*\b(?:i|me|my|{NAMES})\b`).test(normalized);
  const namesPerson = householdRegex(String.raw`\b({NAMES})\b`).test(normalized);
  if (hasClothingTerm
    && (asksPersonalPreference || asksPersonalThreshold)
    && (namesPerson || /\b(my|me|i)\b/.test(normalized))) {
    return true;
  }
  return false;
}

/** An accepted-memory search that found nothing; with a model, the question goes on to open chat. */
export const MEMORY_NO_MATCH_NOTE = "accepted memory search found no match";

export function guestMemoryDecline(notes: string): BasicResult {
  return withheld("memory_query", notes);
}

export function memoryAnswer(
  config: MemoryConfig,
  request: VoiceBrainRequest,
  transcript: string,
  options: {
    readonly now?: string;
    readonly sourceRef?: string;
    readonly timeWindowOverride?: TimeWindow | null;
  } = {},
): MemoryRouteResult {
  if (!cognitiveFeatureEnabled(config, "recall")) {
    return declined("memory_query", "My memory system is switched off.", "cognitive recall disabled");
  }
  const store = new MemoryStore(memoryStorePath(config));
  try {
    const now = options.now ?? new Date().toISOString();
    const records = store.listMemoryRecords();
    const episodicQuery = buildEpisodicRecallQuery(
      transcript,
      request,
      now,
      records,
      undefined,
      options.timeWindowOverride ?? null,
    );
    if (episodicQuery) {
      const initialMatches = recallEpisodicMemories(
        records,
        episodicQuery,
        request,
        now,
      );
      if (initialMatches.length === 0) {
        const fallbackText = episodicNoMatchText(
          records,
          episodicQuery,
          request,
          now,
        );
        const opportunity = historicalPresenceOpportunity(records, episodicQuery, request, now, fallbackText);
        return {
          ...declined("memory_query", fallbackText, "accepted episodic memory search found no match"),
          ...(opportunity ? { historicalPresenceOpportunity: opportunity } : {}),
        };
      }
      const learningEnabled = cognitiveFeatureEnabled(config, "learning");
      const matches = initialMatches.flatMap((record) => {
        if (!learningEnabled) {
          const current = store.getMemoryRecord(record.id);
          return current
            && recallEpisodicMemories(
              [current],
              episodicQuery,
              request,
              now,
            ).length === 1
            ? [current]
            : [];
        }
        const current = store.updateMemoryRecord(record.id, (latest) => {
          if (
            recallEpisodicMemories(
              [latest],
              episodicQuery,
              request,
              now,
            ).length !== 1
          ) {
            return null;
          }
          return noteMemoryRetrieved(latest, {
            now,
            ...(options.sourceRef ? { sourceRef: options.sourceRef } : {}),
          });
        });
        return current ? [current] : [];
      });
      if (matches.length === 0) {
        return declined(
          "memory_query",
          "I don't have an accepted memory for that.",
          "accepted episodic memory changed before recall",
        );
      }
      return ok(
        "memory_query",
        episodicRecallText(matches, episodicQuery, request),
        "accepted episodic memory search",
      );
    }
    const initialMatches = recallSimpleMemories(
      records,
      transcript,
      request,
      now,
    );
    if (initialMatches.length === 0) {
      return declined("memory_query", "I don't have an accepted memory for that.", MEMORY_NO_MATCH_NOTE);
    }
    const learningEnabled = cognitiveFeatureEnabled(config, "learning");
    const matches = initialMatches.flatMap((record) => {
      if (!learningEnabled) {
        const current = store.getMemoryRecord(record.id);
        return current && recallSimpleMemories([current], transcript, request, now).length === 1
          ? [current]
          : [];
      }
      const current = store.updateMemoryRecord(record.id, (latest) => {
        if (recallSimpleMemories([latest], transcript, request, now).length !== 1) {
          return null;
        }
        return noteMemoryRetrieved(latest, {
          now,
          ...(options.sourceRef ? { sourceRef: options.sourceRef } : {}),
        });
      });
      return current ? [current] : [];
    });
    if (matches.length === 0) {
      return declined("memory_query", "I don't have an accepted memory for that.", "accepted memory changed before recall");
    }
    if (hasConflictingDirectFacts(matches)) {
      return declined(
        "memory_query",
        "I have conflicting memories for that, so I won't guess.",
        "accepted memory search found conflicting direct facts",
      );
    }
    return ok(
      "memory_query",
      matches.map((record) => basicMemoryPlainText(record, request, now)).join(" "),
      "accepted memory search",
    );
  } finally {
    store.close();
  }
}

export function outdoorClothingMemoryAnswer(config: MemoryConfig, request: VoiceBrainRequest, normalized: string): MemoryRouteResult {
  const subject = outdoorClothingMemorySubject(request, normalized);
  if (!subject) {
    return declined("memory_query", "I don't have a sourced speaker identity for that memory question.", "outdoor clothing memory missing subject");
  }
  return memoryAnswer(config, request, `what do you know about ${subject} jacket outdoor clothing`);
}

export function historicalPresenceOpportunityStillCurrent(
  config: MemoryConfig,
  opportunity: HistoricalPresenceOpportunity,
): boolean {
  let store: MemoryStore | null = null;
  try {
    store = new MemoryStore(memoryStorePath(config));
    const records = store.listMemoryRecords();
    return memorySnapshotToken(records) === opportunity.memorySnapshotToken
      && !hasReviewProtectedEpisode(
        records,
        opportunity.actorId,
        opportunity.window,
      );
  } catch {
    return false;
  } finally {
    store?.close();
  }
}

function basicMemoryPlainText(
  record: MemoryRecord,
  request: VoiceBrainRequest,
  now: string,
): string {
  if (
    record.category === "fact"
    && record.payload.category === "fact"
    && record.payload.factType === "birth_date"
  ) {
    const normalized = normalizeSpeechForRouting(request.transcript);
    const date = birthDateValue(record.payload.value);
    const subject = record.subjectIds[0] ?? record.ownerId ?? "";
    const speaker = subjectMatchesSpeaker(subject, request);
    if (looksLikeAgeQuestion(normalized)) {
      const age = ageFromBirthDate(record.payload.value, now);
      if (age !== null) {
        return speaker ? `You are ${age}.` : `${displaySubject(subject)} is ${age}.`;
      }
    }
    if (date && looksLikeBirthDateQuestion(normalized)) {
      const dateText = `${date.day} ${birthMonthLabel(date.month)}`;
      if (/\b(?:born|birth date|date of birth)\b/.test(normalized)) {
        return speaker
          ? `You were born on ${dateText} ${date.year}.`
          : `${displaySubject(subject)} was born on ${dateText} ${date.year}.`;
      }
      return speaker
        ? `Your birthday is ${dateText}.`
        : `${displaySubject(subject)}'s birthday is ${dateText}.`;
    }
  }
  if (record.category === "preference" && record.payload.category === "preference" && record.payload.preferenceType === "outdoor_clothing") {
    const subject = record.payload.subjectId;
    const isSpeaker = subjectMatchesSpeaker(subject, request);
    if (isJsonObject(record.payload.value)) {
      const garment = String(record.payload.value.garment ?? "extra layers");
      const threshold = typeof record.payload.value.threshold_c === "number" ? record.payload.value.threshold_c : null;
      if (threshold !== null) {
        return `${isSpeaker ? "You usually want" : `${displaySubject(subject)} usually wants`} ${garmentWithArticle(garment)} at ${formatNumber(threshold)} C or below.`;
      }
      return `${isSpeaker ? "You usually want" : `${displaySubject(subject)} usually wants`} ${garmentWithArticle(garment)} outdoors.`;
    }
  }
  return memoryPlainText(record);
}

function historicalPresenceOpportunity(
  records: readonly MemoryRecord[],
  query: EpisodicRecallQuery,
  request: VoiceBrainRequest,
  now: string,
  fallbackText: string,
): HistoricalPresenceOpportunity | undefined {
  const trustedActorId = request.speaker.trustedActorId ?? null;
  if (
    !trustedActorId
    || query.actorId !== trustedActorId
    || query.subjectIds.length !== 1
    || query.subjectIds[0] !== trustedActorId
    || !query.birthdayRoleSupported
    || query.actionTerms.length > 0
    || query.detailTerms.length > 0
    || (
      query.answerFacet !== null
      && query.answerFacet !== "location"
    )
  ) {
    return undefined;
  }
  const window = episodicHistoricalEvidenceWindow(
    records,
    query,
    request,
    now,
  );
  const startMs = Date.parse(window?.start ?? "");
  const endMs = Date.parse(window?.end ?? "");
  const nowMs = Date.parse(now);
  if (
    !window
    || !Number.isFinite(startMs)
    || !Number.isFinite(endMs)
    || !Number.isFinite(nowMs)
    || endMs <= startMs
    || endMs > nowMs
    || endMs - startMs > 26 * 60 * 60 * 1_000
    || !isCompleteLocalCalendarDay(window)
    || hasReviewProtectedEpisode(records, trustedActorId, window)
  ) {
    return undefined;
  }
  return {
    actorId: trustedActorId,
    window,
    fallbackText,
    memorySnapshotToken: memorySnapshotToken(records),
  };
}

function memorySnapshotToken(records: readonly MemoryRecord[]): string {
  const stableRecords = [...records].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  return createHash("sha256")
    .update(JSON.stringify(stableRecords))
    .digest("hex");
}

function isCompleteLocalCalendarDay(
  window: NonNullable<EpisodicRecallQuery["window"]>,
): boolean {
  const localParts = (value: string) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: window.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(value));
    const numberPart = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
    return {
      year: numberPart("year"),
      month: numberPart("month"),
      day: numberPart("day"),
      hour: numberPart("hour"),
      minute: numberPart("minute"),
      second: numberPart("second"),
    };
  };
  const start = localParts(window.start);
  const end = localParts(window.end);
  if (
    !Object.values(start).every(Number.isFinite)
    || !Object.values(end).every(Number.isFinite)
    || start.hour !== 0
    || start.minute !== 0
    || start.second !== 0
    || end.hour !== 0
    || end.minute !== 0
    || end.second !== 0
  ) {
    return false;
  }
  const next = new Date(Date.UTC(start.year, start.month - 1, start.day + 1));
  return end.year === next.getUTCFullYear()
    && end.month === next.getUTCMonth() + 1
    && end.day === next.getUTCDate();
}

function hasReviewProtectedEpisode(
  records: readonly MemoryRecord[],
  actorId: string,
  window: HistoricalPresenceOpportunity["window"],
): boolean {
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  const suppressionTag = episodicDaySuppressionTagForInstant(
    actorId,
    window.start,
    window.timezone,
  );
  return records.some((record) => {
    if (
      record.category === "episodic"
      && (
        record.reviewStatus === "redacted"
        || record.reviewStatus === "deleted"
      )
    ) {
      const storedTags = storedEpisodicDaySuppressionTags(record);
      // Older tombstones have no scoped suppression tag, so they remain a
      // coarse fail-closed guard. New tombstones block only their actor/day.
      return storedTags.length === 0
        || suppressionTag === null
        || storedTags.includes(suppressionTag);
    }
    if (
      record.category !== "episodic"
      || record.payload.category !== "episodic"
    ) {
      return false;
    }
    const focalSubjectId = (
      record.ownerId
      ?? record.payload.subjectIds[0]
      ?? record.subjectIds[0]
      ?? null
    )?.toLowerCase() ?? null;
    const occurredAtMs = Date.parse(record.payload.occurredAt);
    // The no-match can be caused by review, contradiction, expiry, recall
    // policy, or semantic filtering. Do not use an independent HA source to
    // route around any episode already governed by memory policy.
    return focalSubjectId === actorId
      && Number.isFinite(occurredAtMs)
      && occurredAtMs >= startMs
      && occurredAtMs < endMs;
  });
}

function garmentWithArticle(garment: string): string {
  const clean = garment.trim();
  if (!clean || /^(?:a|an|the|some)\b/i.test(clean) || /\b(?:layers|clothes|clothing)\b/i.test(clean)) {
    return clean;
  }
  return `${/^[aeiou]/i.test(clean) ? "an" : "a"} ${clean}`;
}

function isJsonObject(value: unknown): value is { readonly [key: string]: unknown } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function recallSimpleMemories(
  records: readonly MemoryRecord[],
  transcript: string,
  request: VoiceBrainRequest,
  now: string,
): readonly MemoryRecord[] {
  const tokens = meaningfulTokens(transcript);
  const contentTokens = tokens.filter((token) => !householdNameTokens().has(token));
  const subjectTokens = tokens.filter((token) => householdNameTokens().has(token));
  const normalized = normalize(transcript);
  const questionKind = classifyPersonalMemoryQuestion(normalized);
  const actorId = canonicalRecallActorId(
    request.speaker.trustedActorId,
    request.speaker.trustedActorId ? 1 : null,
  );
  const principal = resolveSpeakerPrincipal(request.speaker);
  const speakerSubjectId = actorId
    ?? (isTrustedSpeakerTrust(principal.trust)
      ? canonicalRecallSubjectId(principal.personId)
      : null);
  const firstPerson = /\b(?:i|me|my|mine)\b/.test(normalized);
  if (firstPerson && !speakerSubjectId) {
    return [];
  }
  const requestedSubjectIds = new Set<string>([
    ...(firstPerson && speakerSubjectId ? [speakerSubjectId] : []),
    ...subjectIdsFromNamedTokens(subjectTokens),
  ]);
  const birthDateQuery = questionKind === "birth_date"
    || questionKind === "age";
  const broad = /\b(what do you know|what.*remember|memories about|tell me about)\b/.test(normalized)
    && contentTokens.length === 0;
  return records
    .filter((record) =>
      memoryRecordRecallAllowed(record, {
        actorId,
        channel: request.channel,
        now,
      })
    )
    .filter((record) =>
      requestedSubjectIds.size === 0
      || [...requestedSubjectIds].some((subjectId) => memorySubjectIds(record).has(subjectId))
    )
    .filter((record) =>
      record.category !== "fact"
      || record.payload.category !== "fact"
      || record.payload.factType !== "birth_date"
      || birthDateQuery
    )
    .filter((record) =>
      !birthDateQuery
      || (
        record.category === "fact"
        && record.payload.category === "fact"
        && record.payload.factType === "birth_date"
      )
    )
    .map((record) => ({
      record,
      text: memorySearchText(record),
      specialMatch: birthDateQuery
        && record.category === "fact"
        && record.payload.category === "fact"
        && record.payload.factType === "birth_date",
    }))
    .map((match) => ({
      ...match,
      score: tokens.reduce((score, token) => score + (match.text.includes(token) ? 3 : 0), 0)
        + (match.specialMatch ? 12 : 0)
        + [...memorySubjectIds(match.record)].filter((subjectId) => requestedSubjectIds.has(subjectId)).length * 8
        + match.record.confidence
        + match.record.sourceReliability
        + match.record.retrievalStrength,
      contentScore: contentTokens.reduce((score, token) => score + (match.text.includes(token) ? 1 : 0), 0),
    }))
    .filter((match) =>
      match.specialMatch
      || (contentTokens.length > 0
        ? match.contentScore === contentTokens.length
        : (match.score > 0 || broad))
    )
    .sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt))
    .slice(0, birthDateQuery ? 2 : 3)
    .map((match) => match.record);
}

function subjectIdsFromNamedTokens(tokens: readonly string[]): readonly string[] {
  const values = new Set<string>();
  for (const token of tokens) {
    const person = householdPersonByName(token);
    if (person) values.add(person.id);
  }
  return [...values];
}

function memorySubjectIds(record: MemoryRecord): ReadonlySet<string> {
  const values = new Set(record.subjectIds.map((subjectId) => subjectId.toLowerCase()));
  if (record.ownerId) {
    values.add(record.ownerId.toLowerCase());
  }
  if (record.category === "preference" && record.payload.category === "preference") {
    values.add(record.payload.subjectId.toLowerCase());
  }
  return values;
}

function hasConflictingDirectFacts(records: readonly MemoryRecord[]): boolean {
  const facts = records.filter((record) =>
    record.category === "fact" && record.payload.category === "fact"
  );
  const valuesByKey = new Map<string, Set<string>>();
  for (const record of facts) {
    if (record.payload.category !== "fact") continue;
    const key = `${record.payload.factType}:${[...record.payload.subjectIds].sort().join(",")}`;
    const values = valuesByKey.get(key) ?? new Set<string>();
    values.add(JSON.stringify(record.payload.value));
    valuesByKey.set(key, values);
  }
  return [...valuesByKey.values()].some((values) => values.size > 1);
}

function ageFromBirthDate(value: unknown, now: string): number | null {
  const date = birthDateValue(value);
  if (!date) return null;
  const current = houseDateParts(now);
  if (!current || date.year > current.year) return null;
  const birthdayPassed = current.month > date.month
    || (current.month === date.month && current.day >= date.day);
  const age = current.year - date.year - (birthdayPassed ? 0 : 1);
  return age >= 0 && age <= 130 ? age : null;
}

function birthDateValue(value: unknown): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
} | null {
  if (typeof value === "string") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) return null;
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const date = (value as { readonly date?: unknown }).date;
  return typeof date === "string" ? birthDateValue(date) : null;
}

function houseDateParts(value: string): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
} | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: HOUSE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const numberPart = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  const year = numberPart("year");
  const month = numberPart("month");
  const day = numberPart("day");
  return [year, month, day].every(Number.isFinite) ? { year, month, day } : null;
}

function birthMonthLabel(month: number): string {
  return new Intl.DateTimeFormat(HOUSE_LOCALE, {
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2024, month - 1, 1)));
}

/** Whose clothing preference: a named household member, else the trusted speaker. */
export function outdoorClothingMemorySubject(request: VoiceBrainRequest, normalized: string): string | null {
  return personNamedIn(normalized)?.name ?? trustedSpeakerLabel(request);
}

function memorySearchText(record: MemoryRecord): string {
  return normalize([
    record.title,
    record.summary,
    JSON.stringify(record.payload),
    ...record.subjectIds,
    ...record.tags,
  ].join(" "));
}

function meaningfulTokens(text: string): readonly string[] {
  const stop = new Set([
    "what",
    "who",
    "when",
    "does",
    "do",
    "is",
    "are",
    "was",
    "were",
    "the",
    "you",
    "your",
    "about",
    "tell",
    "know",
    "remember",
    "memory",
    "memories",
    "prefer",
    "preference",
    "like",
    "likes",
  ]);
  return normalize(text).split(" ").filter((token) => token.length >= 3 && !stop.has(token));
}

export function basicMemoryResult(result: MemoryRouteResult, contextFrame: BasicContextFrame | null = null): BasicResult {
  return {
    route: result.route,
    status: result.status,
    confidence: result.confidence,
    text: result.text,
    modelUsed: result.modelUsed,
    resultId: result.resultId,
    touchedEntities: result.touchedEntities,
    notes: result.notes,
    ...(result.status === "ok" && contextFrame ? { contextFrame } : {}),
  };
}

export async function basicMemoryResultWithHistoricalPresence(
  result: MemoryRouteResult,
  routes: Pick<BasicBrainRouteServices, "aliases" | "historyFetcher" | "stateCache">,
  config: MemoryConfig,
  refresh: {
    readonly request: VoiceBrainRequest;
    readonly transcript: string;
    readonly now: string;
    readonly sourceRef: string;
    readonly timeWindowOverride: TimeWindow | null;
  },
): Promise<BasicResult> {
  const opportunity = result.historicalPresenceOpportunity;
  if (!opportunity) {
    return basicMemoryResult(result);
  }
  const personEntityId = routes.stateCache
    ? resolveHistoricalPersonEntityId(opportunity.actorId, routes.stateCache, routes.aliases ?? [])
    : null;
  const inference = await inferHistoricalPresence(opportunity, {
    ...(routes.stateCache ? { stateCache: routes.stateCache } : {}),
    ...(routes.historyFetcher ? { historyFetcher: routes.historyFetcher } : {}),
    ...(routes.aliases ? { aliases: routes.aliases } : {}),
  });
  // Memory may change while history is read; then recall runs again.
  if (!historicalPresenceOpportunityStillCurrent(config, opportunity)) {
    return refreshedDeterministicMemoryResult(
      config,
      { ...refresh, timeWindowOverride: opportunity.window },
      "memory changed during deterministic presence read; reran deterministic recall",
    );
  }
  if (!inference) {
    return personEntityId
      ? withReadFallback(basicMemoryResult(result), "historical_state_required", {
        ownPresenceWindow: { start: opportunity.window.start, end: opportunity.window.end },
        ownPresencePersonEntityId: personEntityId,
        memoryGuard: {
          actorId: opportunity.actorId,
          window: opportunity.window,
          memorySnapshotToken: opportunity.memorySnapshotToken,
        },
      })
      : withReadFallback(basicMemoryResult(result), "historical_state_required");
  }
  return basicMemoryResult(
    { ...result, status: "ok", confidence: inference.confidence, text: inference.text, notes: inference.notes },
    {
      kind: "historical_presence",
      window: opportunity.window,
      sourceEntityIds: inference.sourceEntityIds,
      sourceSummary: "historical Home Assistant person presence",
    },
  );
}

export function refreshedDeterministicMemoryResult(
  config: MemoryConfig,
  refresh: {
    readonly request: VoiceBrainRequest;
    readonly transcript: string;
    readonly now: string;
    readonly sourceRef: string;
    readonly timeWindowOverride: TimeWindow | null;
  },
  note: string,
): BasicResult {
  const current = basicMemoryResult(memoryAnswer(
    config,
    refresh.request,
    refresh.transcript,
    {
      now: refresh.now,
      sourceRef: refresh.sourceRef,
      timeWindowOverride: refresh.timeWindowOverride,
    },
  ));
  return {
    ...current,
    notes: `${current.notes}; ${note}`,
  };
}
