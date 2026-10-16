import {
  canonicalRecallActorId,
  memoryRecordRecallAllowed,
} from "./memory-access.js";
import { memoryClaimHashes } from "./memory-claim.js";
import {
  canonicalEpisodicVerb,
  episodicMemoryDateKey,
  episodicVerbForms,
} from "./episodic-memory-identity.js";
import type { MemoryRecord } from "./memory-schema.js";
import { canonicalizeRoutingText } from "./routing-text.js";
import { normalizeSpeechForRouting } from "./speech-normalizer.js";
import {
  extractTimeWindowFromUtterance,
  parseTimeWindow,
  type TimeWindow,
} from "./time-window-parser.js";
import type { VoiceBrainRequest } from "./voice-brain.js";
import { capitalize, escapeRegExp } from "./text-format.js";
import { MONTH_NAMES, WEEKDAY_NAMES } from "./lexicon.js";
import { householdNamePattern, householdNameTokens, householdPeople, householdPersonById, householdPersonByName, householdRegex } from "./household.js";
import { HOUSE_LOCALE, HOUSE_TIME_ZONE } from "./house-config.js";

const DEFAULT_TIMEZONE = HOUSE_TIME_ZONE;
const MONTH_TOKENS: ReadonlySet<string> = new Set(MONTH_NAMES);
const WEEKDAY_TOKENS: ReadonlySet<string> = new Set(WEEKDAY_NAMES);
const ORDINAL_UNIT_TOKENS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
] as const;
const ORDINAL_TOKENS = [
  ...ORDINAL_UNIT_TOKENS,
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth",
  "twentieth",
  "thirtieth",
  "fortieth",
  "fiftieth",
  "sixtieth",
  "seventieth",
  "eightieth",
  "ninetieth",
  "hundredth",
] as const;
const ORDINAL_TENS_TOKENS = [
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
] as const;
const COMPOUND_ORDINAL_PATTERN =
  `(?:${ORDINAL_TENS_TOKENS.join("|")})\\s+(?:${ORDINAL_UNIT_TOKENS.join("|")})`;
const ORDINAL_PATTERN =
  `(?:(?:\\d{1,3})(?:st|nd|rd|th)?|${ORDINAL_TOKENS.join("|")}|${COMPOUND_ORDINAL_PATTERN})`;
const RELATIONAL_ROLE_PATTERN =
  "(?:wife|husband|partner|spouse|daughter|son|child|mother|father|mum|mom|dad|sister|brother)";
const COORDINATED_COMPANION_PATTERN =
  `(?:my\\s+${RELATIONAL_ROLE_PATTERN}|(?!my\\b)[a-z]+)`;
const COORDINATED_SELF_SUBJECT_PATTERN =
  `(?:${COORDINATED_COMPANION_PATTERN}\\s+and\\s+i|i\\s+and\\s+${COORDINATED_COMPANION_PATTERN})`;
/** "I", a household name, "my wife" or "Sam and I". */
function episodicSubjectPattern(): string {
  return `(?:${COORDINATED_SELF_SUBJECT_PATTERN}|(?:i|${householdNamePattern()}|my ${RELATIONAL_ROLE_PATTERN}))`;
}
const EPISODIC_SUBJECT_BOUNDARY = "(?!\\s+(?:s|and)\\b)";
const RELATIONAL_POSSESSIVE_PATTERN = new RegExp(
  `\\bmy ${RELATIONAL_ROLE_PATTERN}\\b`,
);
const NON_ACTION_QUERY_COMPLEMENTS = new Set([
  "at",
  "during",
  "for",
  "from",
  "in",
  "last",
  "on",
  "there",
  "this",
  "to",
  "where",
  "with",
]);
const MEAL_TERMS = new Set([
  "breakfast",
  "brunch",
  "dinner",
  "lunch",
  "meal",
  "supper",
]);

export type PersonalMemoryQuestionKind =
  | "birth_date"
  | "age"
  | "episodic";

export type EpisodicAnswerFacet =
  | "location"
  | "companions"
  | "travel_mode";

export interface EpisodicRecallQuery {
  readonly kind: "episodic";
  readonly subjectIds: readonly string[];
  readonly actorId: string | null;
  readonly birthday: boolean;
  readonly birth: boolean;
  readonly window: TimeWindow | null;
  readonly temporalStatus: "matched" | "ambiguous" | "unmatched" | "not_requested";
  readonly temporalReason: string | null;
  readonly temporalLabel: string | null;
  readonly requestedBirthdayYear: number | null;
  readonly requestedBirthdayAge: number | null;
  readonly birthdayHonoreeId: string | null;
  readonly birthdayRoleSupported: boolean;
  readonly actionTerms: readonly string[];
  readonly detailTerms: readonly (readonly string[])[];
  readonly answerFacet: EpisodicAnswerFacet | null;
  readonly timezone: string;
}

export function classifyPersonalMemoryQuestion(
  value: string,
  resolvedTimeWindow: TimeWindow | null = null,
): PersonalMemoryQuestionKind | null {
  const normalized = normalize(value);
  if (!normalized) return null;
  if (looksLikeAgeQuestion(normalized)) return "age";
  if (looksLikeBirthDateQuestion(normalized)) return "birth_date";
  return looksLikeEpisodicQuestion(
    normalized,
    value,
    resolvedTimeWindow !== null,
  ) ? "episodic" : null;
}

export function episodicQuestionActionTerms(
  value: string,
): readonly string[] {
  const normalized = normalize(value);
  return activityActionTerms(normalized, episodicAnswerFacet(normalized));
}

export function looksLikeBirthDateQuestion(normalizedValue: string): boolean {
  const normalized = normalize(normalizedValue);
  if (!hasPersonalBirthAnchor(normalized)) return false;
  if (/\b(?:did|happened|celebrat(?:e|ed|ing)|gift|present|hospital|where|who|with)\b/.test(normalized)) {
    return false;
  }

  const subject = `(?:my|${householdNamePattern()}(?: s)?)`;
  const birthdayTail = "(?:(?: this| last| next) year)?$";
  const indirectWhenClause = new RegExp(
    `\\bwhen ${subject} birthday (?:is|was)$`,
  );
  const indirectInquiry = /^(?:can|could|do|would|will) you\b/.test(normalized)
    || /^(?:please )?tell me\b/.test(normalized)
    || /^(?:recall|remember)\b/.test(normalized);
  return new RegExp(`\\bwhen (?:is|was) ${subject} birthday${birthdayTail}`).test(normalized)
    || new RegExp(`\\bdo you know when ${subject} birthday (?:is|was)$`).test(normalized)
    || (indirectInquiry && indirectWhenClause.test(normalized))
    || new RegExp(`\\bwhat (?:is|was) ${subject} birthday$`).test(normalized)
    || new RegExp(`\\b(?:what|which) (?:date|day|month|year) (?:is|was) ${subject} birthday$`).test(normalized)
    || new RegExp(`\\b(?:tell me|do you know) ${subject} birthday$`).test(normalized)
    || /\bwhen was i born$/.test(normalized)
    || /\b(?:what|which) (?:date|day|month|year) was i born$/.test(normalized)
    || /\b(?:tell me|do you know) (?:when i was born|my (?:birth date|date of birth))$/.test(normalized)
    || new RegExp(`\\b(?:what is|what s|tell me|do you know) ${subject} (?:birth date|date of birth)$`).test(normalized);
}

export function looksLikeAgeQuestion(normalizedValue: string): boolean {
  const normalized = normalize(normalizedValue);
  return householdRegex(String.raw`\bhow old (?:am i|are {NAMES}|is {NAMES})\b`).test(normalized)
    || householdRegex(String.raw`\b(?:what is|what s|tell me|do you know) (?:my|{NAMES}(?: s)?) age\b`).test(normalized);
}

export function buildEpisodicRecallQuery(
  transcript: string,
  request: VoiceBrainRequest,
  now: string,
  records: readonly MemoryRecord[],
  timezone = DEFAULT_TIMEZONE,
  resolvedTimeWindow: TimeWindow | null = null,
): EpisodicRecallQuery | null {
  if (classifyPersonalMemoryQuestion(transcript, resolvedTimeWindow) !== "episodic") {
    return null;
  }
  const normalized = normalize(transcript);
  const actorId = canonicalRecallActorId(
    request.speaker.trustedActorId,
    request.speaker.trustedActorId ? 1 : null,
  );
  const focalSubjectId = focalSubjectIdFromQuery(normalized, actorId);
  const subjectIds = focalSubjectId ? [focalSubjectId] : [];
  const birthday = /\bbirthday\b/.test(normalized);
  const birth = birthday
    || /\b(?:born|birth date|date of birth)\b/.test(normalized);
  const requestedBirthdayYear = birthday
    ? birthdayYearFromQuery(normalized, now, timezone)
    : null;
  const requestedBirthdayAge = birthday
    ? birthdayAgeFromQuery(normalized)
    : null;
  const birthdayHonoreeId = birthday
    ? birthdayHonoreeIdFromQuery(normalized, actorId, focalSubjectId)
    : null;
  const birthdayRoleSupported = !birthday
    || (
      focalSubjectId !== null
      && birthdayHonoreeId !== null
      && focalSubjectId === birthdayHonoreeId
    );
  const parsed = resolvedTimeWindow
    ? {
        status: "matched" as const,
        window: resolvedTimeWindow,
        reason: null,
      }
    : extractTimeWindowFromUtterance(transcript, {
        now: new Date(now),
        timezone,
        householdAnchors: {},
        weekdayDirection: "past",
      });
  const explicitTemporalSignal = hasNonSemanticTemporalSignal(
    normalized,
    transcript,
  ) || resolvedTimeWindow !== null;
  const yearOnlyBirthdaySignal = birthday
    && requestedBirthdayYear !== null
    && !hasDateOrWindowBeyondYear(normalized);
  const window = parsed.window;
  const temporalStatus: EpisodicRecallQuery["temporalStatus"] =
    parsed.status === "matched"
      ? "matched"
      : explicitTemporalSignal && !yearOnlyBirthdaySignal
        ? parsed.status
        : "not_requested";
  const temporalReason = parsed.reason;
  const temporalLabel = parsed.window?.label ?? null;

  const answerFacet = episodicAnswerFacet(normalized);
  return {
    kind: "episodic",
    subjectIds,
    actorId,
    birthday,
    birth,
    window,
    temporalStatus,
    temporalReason,
    temporalLabel,
    requestedBirthdayYear: requestedBirthdayAge === null
      ? requestedBirthdayYear
      : birthdayYearForAge(
          records,
          requestedBirthdayAge,
          subjectIds,
          actorId,
          request,
          now,
        ),
    requestedBirthdayAge,
    birthdayHonoreeId,
    birthdayRoleSupported,
    actionTerms: activityActionTerms(normalized, answerFacet),
    detailTerms: activityDetailTerms(normalized, answerFacet),
    answerFacet,
    timezone,
  };
}

export function recallEpisodicMemories(
  records: readonly MemoryRecord[],
  query: EpisodicRecallQuery,
  request: VoiceBrainRequest,
  now: string,
): readonly MemoryRecord[] {
  if (
    !query.actorId
    || query.subjectIds.length === 0
    || !query.birthdayRoleSupported
  ) {
    return [];
  }
  const blockedClaimHashes = new Set(
    records
      .filter((record) =>
        record.reviewStatus === "redacted"
        || record.reviewStatus === "deleted"
      )
      .flatMap((record) => memoryClaimHashes(record)),
  );
  const eligible = records
    .filter((record) =>
      record.category === "episodic"
      && record.payload.category === "episodic"
      && !memoryClaimHashes(record).some((hash) =>
        blockedClaimHashes.has(hash)
      )
      && record.recallPolicy !== undefined
      && memoryRecordRecallAllowed(record, {
        actorId: query.actorId,
        channel: request.channel,
        now,
      })
      && focalSubjectMatches(record, query.subjectIds)
    );
  const temporalCandidates = selectTemporalCandidates(
    eligible,
    query,
    now,
  );

  return temporalCandidates
    .filter((record) => {
      if (record.payload.category !== "episodic") return false;
      if (query.birth && !query.birthday && !isBirthEpisode(record)) {
        return false;
      }
      return actionMatches(
        record,
        query.actionTerms,
        query.detailTerms,
        query.answerFacet,
      );
    })
    .sort((left, right) => {
      if (left.payload.category !== "episodic" || right.payload.category !== "episodic") {
        return 0;
      }
      return query.window
        ? left.payload.occurredAt.localeCompare(right.payload.occurredAt)
        : right.payload.occurredAt.localeCompare(left.payload.occurredAt);
    })
    .filter((record, index, all) =>
      all.findIndex((candidate) =>
        candidate.payload.category === "episodic"
        && record.payload.category === "episodic"
        && episodicMemoryDateKey(
          candidate.payload.occurredAt,
          query.timezone,
        ) === episodicMemoryDateKey(
          record.payload.occurredAt,
          query.timezone,
        )
        && normalize(candidate.payload.outcome) === normalize(record.payload.outcome)
      ) === index
    )
    .slice(0, 3);
}

export function episodicRecallText(
  records: readonly MemoryRecord[],
  query: EpisodicRecallQuery,
  request: VoiceBrainRequest,
): string {
  const clauses = records.flatMap((record) => {
    if (record.payload.category !== "episodic") return [];
    const subjectId = focalSubjectId(record) ?? "";
    const isSpeaker = query.actorId !== null && subjectId === query.actorId;
    const outcome = query.birthday
      ? stripBirthdayContext(record.payload.outcome)
      : record.payload.outcome;
    return [renderOutcome(outcome, subjectId, isSpeaker)];
  });
  const body = joinClauses(clauses);
  if (query.birthday) {
    return `For ${birthdaySubjectText(query)}, ${continuationStart(body)}`;
  }
  if (query.window) {
    return `${windowLead(query.window, request.transcript)}, ${continuationStart(body)}`;
  }
  return body;
}

export function episodicNoMatchText(
  records: readonly MemoryRecord[],
  query: EpisodicRecallQuery,
  request: VoiceBrainRequest,
  now: string,
): string {
  if (!query.birthdayRoleSupported) {
    return "I can't reliably resolve whose birthday activity you mean.";
  }
  if (
    query.temporalStatus === "ambiguous"
    || query.temporalStatus === "unmatched"
  ) {
    return "I couldn't resolve the date in that memory question.";
  }
  if (query.birthday && accessibleBirthDate(records, query, request, now)) {
    return `I know when ${birthdaySubjectText(query)} is, but I don't remember what ${birthdaySubjectPronoun(query)} did for it.`;
  }
  if (query.birthday) {
    return `I don't remember what ${birthdaySubjectPronoun(query)} did for ${birthdaySubjectText(query)}.`;
  }
  if (query.window) {
    if (query.answerFacet === "location") {
      return `I don't remember where ${birthdaySubjectPronoun(query)} ${subjectPastCopula(query)} ${windowNoMatchPhrase(query.window)}.`;
    }
    if (query.answerFacet === "companions") {
      return `I don't remember who ${birthdaySubjectPronoun(query)} ${subjectPastCopula(query)} with ${windowNoMatchPhrase(query.window)}.`;
    }
    if (query.answerFacet === "travel_mode") {
      return `I don't remember how ${birthdaySubjectPronoun(query)} travelled ${windowNoMatchPhrase(query.window)}.`;
    }
    return `I don't remember what ${birthdaySubjectPronoun(query)} did ${windowNoMatchPhrase(query.window)}.`;
  }
  return "I don't remember anything reliable for that.";
}

export function episodicHistoricalEvidenceWindow(
  records: readonly MemoryRecord[],
  query: EpisodicRecallQuery,
  request: VoiceBrainRequest,
  now: string,
): TimeWindow | null {
  if (
    query.temporalStatus === "ambiguous"
    || query.temporalStatus === "unmatched"
  ) {
    return null;
  }
  if (!query.birthday) {
    return query.window;
  }

  const birthDate = accessibleBirthDateRecord(
    records,
    query.subjectIds,
    query.actorId,
    request,
    now,
  );
  if (
    !birthDate
    || birthDate.payload.category !== "fact"
    || typeof birthDate.payload.value !== "string"
  ) {
    return null;
  }
  const parsedBirthDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(
    birthDate.payload.value,
  );
  const localNow = localDateParts(now, query.timezone);
  if (!parsedBirthDate || !localNow) {
    return null;
  }
  const month = Number(parsedBirthDate[2]);
  const day = Number(parsedBirthDate[3]);
  const explicitWindowYear = query.window
    ? localDateParts(query.window.start, query.timezone)?.year ?? null
    : null;
  const year = query.requestedBirthdayYear
    ?? explicitWindowYear
    ?? (
      localNow.month > month
      || (localNow.month === month && localNow.day >= day)
        ? localNow.year
        : localNow.year - 1
    );
  const parsed = parseTimeWindow(`${day} ${monthName(month)} ${year}`, {
    now: new Date(now),
    timezone: query.timezone,
  });
  const anniversary = parsed.status === "matched" ? parsed.window : null;
  if (!anniversary) {
    return null;
  }
  if (
    query.window
    && (
      query.window.start !== anniversary.start
      || query.window.end !== anniversary.end
    )
  ) {
    const queryStartMs = Date.parse(query.window.start);
    const queryEndMs = Date.parse(query.window.end);
    const anniversaryStartMs = Date.parse(anniversary.start);
    const anniversaryEndMs = Date.parse(anniversary.end);
    const anniversaryFallsInsideQualifiedYear =
      query.requestedBirthdayYear !== null
      && [queryStartMs, queryEndMs, anniversaryStartMs, anniversaryEndMs]
        .every(Number.isFinite)
      && anniversaryStartMs >= queryStartMs
      && anniversaryEndMs <= queryEndMs;
    if (!anniversaryFallsInsideQualifiedYear) {
      return null;
    }
  }
  return anniversary;
}

function looksLikeEpisodicQuestion(
  normalized: string,
  temporalSource: string,
  hasResolvedTimeWindow = false,
): boolean {
  if (!hasPersonalReference(normalized)) return false;
  if (hasFutureSubjectModality(normalized) || hasFutureTimeReference(normalized)) {
    return false;
  }
  if (hasAmbiguousContractedModal(normalized)) {
    return false;
  }
  if (new RegExp(
    `\\b(?:am|is|are)\\s+${episodicSubjectPattern()}\\s+(?:doing|going)\\b`,
  ).test(normalized)) {
    return false;
  }
  const inquiry = /^(?:what|where|who|how|when|which|did|was|were|have|had)\b/.test(normalized)
    || /^(?:remember|recall)\b/.test(normalized)
    || /\b(?:do you remember|can you remember|tell me|what do you remember|what can you recall)\b/.test(normalized);
  const retrospective = hasRetrospectivePredicate(normalized);
  const hasPresentEmbeddedPredicate =
    hasNonRetrospectiveEmbeddedPredicate(normalized);
  const birthdayInquiry = /\bbirthday\b/.test(normalized)
    && (
      retrospective
      || (
        !hasPresentEmbeddedPredicate
        && /\b(?:do you remember|can you remember|remember|recall|tell me about|what do you remember|what can you recall)\b/.test(normalized)
      )
    );
  const birthInquiry = /\b(?:born|birth date|date of birth)\b/.test(normalized)
    && retrospective;
  return inquiry
    && (
      birthdayInquiry
      || birthInquiry
      || retrospective
        && (
          hasResolvedTimeWindow
          || hasNonSemanticTemporalSignal(normalized, temporalSource)
        )
    );
}

function hasPersonalBirthAnchor(normalized: string): boolean {
  return /\bmy (?:birthday|birth date)\b/.test(normalized)
    || /\bmy date of birth\b/.test(normalized)
    || householdRegex(String.raw`\b{NAMES}(?: s)? (?:birthday|birth date|date of birth)\b`).test(normalized)
    || /\bi (?:was|am) born\b/.test(normalized)
    || /\b(?:was|am) i born\b/.test(normalized)
    || householdRegex(String.raw`\b{NAMES} was born\b`).test(normalized);
}

function hasPersonalReference(normalized: string): boolean {
  return hasSpeakerSelfReference(normalized)
    || RELATIONAL_POSSESSIVE_PATTERN.test(normalized)
    || [...householdNameTokens()].some((token) =>
      new RegExp(`\\b${token}(?: s)?\\b`).test(normalized)
    );
}

function hasRetrospectivePredicate(normalized: string): boolean {
  const subject = episodicSubjectPattern();
  return new RegExp(
    `\\b(?:d|did|was|were)\\s+${subject}${EPISODIC_SUBJECT_BOUNDARY}\\s+[a-z]+\\b`,
  ).test(normalized)
    || new RegExp(`\\b(?:have|has|had)\\s+${subject}\\s+(?:done|been doing)\\b`).test(normalized)
    || new RegExp(`\\b${subject}${EPISODIC_SUBJECT_BOUNDARY}\\s+(?:did|was|were|had)\\b`).test(normalized)
    || hasEmbeddedRetrospectivePredicate(normalized)
    || /\bwhat (?:happened|went on)\b/.test(normalized)
    || (
      !hasNonRetrospectiveEmbeddedPredicate(normalized)
      && /\b(?:remember|recall)\b.*\b(?:did|done|doing|happened|went|got|received|spent|visited|celebrated|ate|saw|told)\b/.test(normalized)
    )
    || /\bborn\b/.test(normalized);
}

function hasEmbeddedRetrospectivePredicate(normalized: string): boolean {
  const predicate = embeddedPersonalPredicate(normalized);
  return predicate
    ? embeddedPredicateIsRetrospective(predicate.first, predicate.second)
    : false;
}

function hasNonRetrospectiveEmbeddedPredicate(normalized: string): boolean {
  const predicate = embeddedPersonalPredicate(normalized);
  return predicate
    ? !embeddedPredicateIsRetrospective(predicate.first, predicate.second)
    : false;
}

function embeddedPersonalPredicate(
  normalized: string,
): { readonly first: string; readonly second: string | null } | null {
  const subject = episodicSubjectPattern();
  const match = new RegExp(
    `\\b(?:what|where|who|how|whether|if)\\s+${subject}${EPISODIC_SUBJECT_BOUNDARY}\\s+([a-z]+)(?:\\s+([a-z]+))?\\b`,
  ).exec(normalized);
  return match?.[1]
    ? {
        first: match[1],
        second: match[2] ?? null,
      }
    : null;
}

function embeddedPredicateIsRetrospective(
  first: string,
  second: string | null,
): boolean {
  if (/^(?:did|had|was|were)$/.test(first)) {
    return true;
  }
  if (/^(?:am|is|are)$/.test(first)) {
    return false;
  }
  if (/^(?:have|has)$/.test(first)) {
    if (!second) {
      return false;
    }
    return (
      canonicalEpisodicVerb(second) !== second
      && !second.endsWith("ing")
    ) || /^(?:been|read)$/.test(second);
  }
  return canonicalEpisodicVerb(first) !== first
    && !first.endsWith("ing");
}

function hasFutureSubjectModality(normalized: string): boolean {
  const subject = episodicSubjectPattern();
  const modal = "(?:will|shall|should|would|could|can|might)";
  return new RegExp(`\\b${modal}\\s+${subject}\\b`).test(normalized)
    || new RegExp(`\\b${subject}\\s+${modal}\\b`).test(normalized)
    || new RegExp(`\\b${subject}\\s+(?:am|is|are)\\s+(?:going\\s+to|planning\\s+to)\\b`).test(normalized);
}

function hasFutureTimeReference(normalized: string): boolean {
  return /\b(?:tomorrow|upcoming|next (?:day|week|weekend|month|year))\b/.test(normalized);
}

function hasAmbiguousContractedModal(normalized: string): boolean {
  const subject = episodicSubjectPattern();
  return new RegExp(
    `\\b(?:what|where|who|how|when) d ${subject}\\s+(?:be|expect|hope|like|love|prefer|rather|want)\\b`,
  ).test(normalized);
}

function hasParsedRetrospectiveWindow(normalized: string): boolean {
  return extractTimeWindowFromUtterance(normalized, {
    now: new Date("2000-07-26T02:00:00.000Z"),
    timezone: DEFAULT_TIMEZONE,
    householdAnchors: {},
  }).status === "matched";
}

function hasInvalidDateSyntax(
  normalized: string,
  temporalSource = normalized,
): boolean {
  const tokens = normalized.split(" ");
  const hasMonth = tokens.some((token) => MONTH_TOKENS.has(token));
  const hasWeekday = tokens.some((token) => WEEKDAY_TOKENS.has(token));
  return /(?:^|\D)\d{1,2}\s*\/\s*\d{1,2}(?:\s*\/\s*\d{4})?(?:\D|$)/.test(temporalSource)
    || /\b\d{1,2}\s+\d{1,2}(?:\s+\d{4})?\b/.test(normalized)
    || (
      hasMonth
      && (
        /\b\d{1,4}(?:st|nd|rd|th)?\b/.test(normalized)
        || [...ORDINAL_TOKENS].some((token) =>
          new RegExp(`\\b${escapeRegExp(token)}\\b`).test(normalized)
        )
        || /\b(?:this|last|next) year\b/.test(normalized)
        || /\bin\b/.test(normalized)
      )
    )
    || hasWeekday
    || /\b(?:today|yesterday|tonight|this|last|previous|next)\s+(?:morning|afternoon|evening|night|day|week|weekend|month|year)\b/.test(normalized)
    || /\b(?:today|yesterday|tonight)\b/.test(normalized)
    || /\b(?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\s+days?\s+ago\b/.test(normalized)
    || /\b(?:19|20|21)\d{2}\s+\d{1,2}\s+\d{1,2}\b/.test(normalized);
}

function hasNonSemanticTemporalSignal(
  normalized: string,
  temporalSource = normalized,
): boolean {
  return hasParsedRetrospectiveWindow(temporalSource)
    || hasInvalidDateSyntax(normalized, temporalSource)
    || /\b(?:this|last|next) year\b/.test(normalized)
    || /\b(?:19|20|21)\d{2}\b/.test(normalized);
}

function hasDateOrWindowBeyondYear(normalized: string): boolean {
  return hasParsedRetrospectiveWindow(normalized)
    || hasInvalidDateSyntax(normalized)
    || /\b(?:today|yesterday|tonight|morning|afternoon|evening|night|week|weekend|month|since|rolling|past|previous)\b/.test(normalized);
}

function focalSubjectIdFromQuery(
  normalized: string,
  actorId: string | null,
): string | null {
  const subjectPattern = episodicSubjectPattern();
  const grammaticalSubject = new RegExp(
    `\\b(?:d|did|was|were|have|has|had)\\s+(${subjectPattern})${EPISODIC_SUBJECT_BOUNDARY}\\b`,
  ).exec(normalized)?.[1] ?? null;
  if (grammaticalSubject) {
    return actorIdForSubjectText(grammaticalSubject, actorId);
  }
  const birthdayHonoree = birthdayHonoreeIdFromQuery(normalized, actorId);
  if (
    birthdayHonoree
    && /\b(?:tell me about|what happened|remember|recall)\b/.test(normalized)
  ) {
    return birthdayHonoree;
  }
  if (hasSpeakerSelfReference(normalized)) return actorId;
  return namedActorIdFromText(normalized);
}

function birthdayHonoreeIdFromQuery(
  normalized: string,
  actorId: string | null,
  focalSubjectId: string | null = null,
): string | null {
  if (new RegExp(`\\bmy(?: ${ORDINAL_PATTERN})? birthday\\b`).test(normalized)) {
    return actorId;
  }
  const named = new RegExp(
    `\\b(${householdNamePattern()})(?: s)?(?: ${ORDINAL_PATTERN})? birthday\\b`,
  ).exec(normalized)?.[1];
  if (named) return actorIdForSubjectText(named, actorId);
  const pronoun = new RegExp(
    `\\b(her|his|their)(?: ${ORDINAL_PATTERN})? birthday\\b`,
  ).exec(normalized)?.[1] ?? null;
  if (!pronoun || !focalSubjectId) return null;
  if (pronoun === "their") return focalSubjectId;
  return householdPersonById(focalSubjectId)?.pronoun === (pronoun === "his" ? "he" : "she") ? focalSubjectId : null;
}

function actorIdForSubjectText(
  value: string,
  actorId: string | null,
): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "i") return actorId;
  if (new RegExp(`^${COORDINATED_SELF_SUBJECT_PATTERN}$`).test(normalized)) {
    return actorId;
  }
  return householdPersonByName(normalized)?.id ?? null;
}

function namedActorIdFromText(normalized: string): string | null {
  const matches = householdPeople()
    .filter((person) => new RegExp(`\\b(?:${person.aliases.join("|")})\\b`).test(normalized))
    .map((person) => person.id);
  return matches.length === 1 ? matches[0] ?? null : null;
}

function memorySubjectIds(record: MemoryRecord): ReadonlySet<string> {
  const values = new Set(record.subjectIds.map((subjectId) => subjectId.toLowerCase()));
  if (record.ownerId) values.add(record.ownerId.toLowerCase());
  if (record.payload.category === "episodic") {
    for (const subjectId of record.payload.subjectIds) values.add(subjectId.toLowerCase());
  }
  return values;
}

function focalSubjectId(record: MemoryRecord): string | null {
  if (record.payload.category !== "episodic") return null;
  const ownerId = record.ownerId?.toLowerCase() ?? null;
  const primarySubjectId = (
    record.payload.subjectIds[0]
    ?? record.subjectIds[0]
    ?? null
  )?.toLowerCase() ?? null;
  if (ownerId && primarySubjectId && ownerId !== primarySubjectId) {
    return null;
  }
  return ownerId ?? primarySubjectId;
}

function focalSubjectMatches(
  record: MemoryRecord,
  requestedSubjectIds: readonly string[],
): boolean {
  const focalSubject = focalSubjectId(record);
  return focalSubject !== null
    && requestedSubjectIds.some((subjectId) =>
      subjectId.toLowerCase() === focalSubject
    );
}

function isBirthdayEpisode(record: MemoryRecord): boolean {
  return record.payload.category === "episodic"
    && (
      /\bbirthday\b/.test(normalize(record.payload.episodeType))
      || record.tags.some((tag) => normalize(tag) === "birthday")
    );
}

function selectTemporalCandidates(
  records: readonly MemoryRecord[],
  query: EpisodicRecallQuery,
  now: string,
): readonly MemoryRecord[] {
  if (
    query.temporalStatus === "ambiguous"
    || query.temporalStatus === "unmatched"
  ) {
    return [];
  }
  const nowMs = Date.parse(now);
  const pastRecords = records.filter((record) => {
    if (record.payload.category !== "episodic") return false;
    const occurredAt = Date.parse(record.payload.occurredAt);
    return Number.isFinite(occurredAt)
      && (!Number.isFinite(nowMs) || occurredAt <= nowMs);
  });

  if (query.birthday) {
    const tagged = pastRecords.filter(isBirthdayEpisode);
    let relevantTagged: readonly MemoryRecord[] = [];
    if (query.temporalStatus === "matched" && query.window) {
      relevantTagged = tagged.filter((record) =>
        recordFallsInsideWindow(record, query.window as TimeWindow)
      );
    } else if (query.requestedBirthdayYear !== null) {
      relevantTagged = tagged.filter((record) =>
        localYearForEpisode(record, query.timezone)
          === query.requestedBirthdayYear
      );
    } else if (query.requestedBirthdayAge !== null) {
      relevantTagged = tagged.filter((record) =>
        birthdayAgeMatchesRecord(record, query.requestedBirthdayAge as number)
      );
    } else {
      const years = tagged
        .map((record) => localYearForEpisode(record, query.timezone))
        .filter((year): year is number => year !== null);
      const latestYear = years.length > 0 ? Math.max(...years) : null;
      relevantTagged = latestYear === null
        ? []
        : tagged.filter((record) =>
            localYearForEpisode(record, query.timezone) === latestYear
          );
    }
    if (relevantTagged.length > 0) {
      return relevantTagged;
    }
    return [];
  }

  if (!query.window) {
    return query.temporalStatus === "not_requested" ? pastRecords : [];
  }
  return pastRecords.filter((record) =>
    recordFallsInsideWindow(record, query.window as TimeWindow)
  );
}

function recordFallsInsideWindow(
  record: MemoryRecord,
  window: TimeWindow,
): boolean {
  if (record.payload.category !== "episodic") return false;
  const occurredAt = Date.parse(record.payload.occurredAt);
  return Number.isFinite(occurredAt)
    && occurredAt >= Date.parse(window.start)
    && occurredAt < Date.parse(window.end);
}

function localYearForEpisode(
  record: MemoryRecord,
  timezone: string,
): number | null {
  if (record.payload.category !== "episodic") return null;
  return localDateParts(record.payload.occurredAt, timezone)?.year ?? null;
}

function activityActionTerms(
  normalized: string,
  answerFacet: EpisodicAnswerFacet | null,
): readonly string[] {
  const subject = episodicSubjectPattern();
  const predicate = new RegExp(
    `\\b(d|did|was|were|have|has|had)\\s+${subject}${EPISODIC_SUBJECT_BOUNDARY}\\s+([a-z]+)\\b`,
  ).exec(normalized);
  const embeddedPredicate = new RegExp(
    `\\b(?:what|where|who|how|whether|if)\\s+${subject}${EPISODIC_SUBJECT_BOUNDARY}\\s+([a-z]+)(?:\\s+([a-z]+))?\\b`,
  ).exec(normalized);
  const embeddedFirst = embeddedPredicate?.[1] ?? null;
  const embeddedSecond = embeddedPredicate?.[2] ?? null;
  const embeddedVerb = embeddedFirst
    ? embeddedActivityVerb(embeddedFirst, embeddedSecond)
    : null;
  const rawVerb = predicate?.[2] ?? embeddedVerb ?? null;
  if (
    !rawVerb
    || NON_ACTION_QUERY_COMPLEMENTS.has(rawVerb)
  ) {
    return [];
  }
  const canonical = canonicalEpisodicVerb(rawVerb);
  if (
    canonical === "have"
    && normalize(normalized).split(" ").some((token) => MEAL_TERMS.has(token))
  ) {
    return ["eat"];
  }
  if (
    answerFacet === "travel_mode"
    && (
      canonical === "get"
      || canonical === "go"
      || canonical === "come"
      || canonical === "travel"
    )
  ) {
    return ["travel"];
  }
  return canonical === "do" ? [] : [canonical];
}

function activityDetailTerms(
  normalized: string,
  answerFacet: EpisodicAnswerFacet | null,
): readonly (readonly string[])[] {
  if (answerFacet === "companions") {
    return [];
  }
  const companion = householdRegex(String.raw`\b(?:with|alongside) ({NAMES})\b`).exec(
    normalized,
  )?.[1];
  if (companion) {
    return [companionForms(companion)];
  }
  const genericCompanion = new RegExp(
    `\\b(?:with|alongside)\\s+(?:(?:my|a|an|the)\\s+)?([a-z]+)\\b`,
  ).exec(normalized)?.[1];
  if (genericCompanion) {
    return [[genericCompanion]];
  }
  const coordinatedMatch = new RegExp(
    `\\b(${COORDINATED_COMPANION_PATTERN})\\s+and\\s+i\\b`
    + `|\\bi\\s+and\\s+(${COORDINATED_COMPANION_PATTERN})\\b`,
  ).exec(normalized);
  const coordinatedCompanion = (
    coordinatedMatch?.[1]
    ?? coordinatedMatch?.[2]
    ?? null
  )?.split(/\s+/).at(-1) ?? null;
  return coordinatedCompanion
    ? [companionForms(coordinatedCompanion)]
    : [];
}

function embeddedActivityVerb(
  first: string,
  second: string | null,
): string {
  if (!second) {
    return first;
  }
  if (/^(?:am|is|are|was|were)$/.test(first)) {
    return second;
  }
  if (
    /^(?:have|has|had)$/.test(first)
    && (
      canonicalEpisodicVerb(second) !== second
      || /^(?:been|read)$/.test(second)
    )
  ) {
    return second;
  }
  return first;
}

function companionForms(value: string): readonly string[] {
  return householdPersonByName(value)?.aliases ?? [value];
}

function episodicAnswerFacet(
  normalized: string,
): EpisodicAnswerFacet | null {
  const subject = episodicSubjectPattern();
  if (new RegExp(
    `\\bwhere\\s+(?:d|did|was|were|have|has|had)\\s+${subject}${EPISODIC_SUBJECT_BOUNDARY}\\b`,
  ).test(normalized) || new RegExp(
    `\\bwhere\\s+${subject}${EPISODIC_SUBJECT_BOUNDARY}\\s+(?:was|were|went|stayed|visited|travelled|traveled)\\b`,
  ).test(normalized)) {
    return "location";
  }
  if (new RegExp(
    `\\bwho\\s+(?:d|did|was|were|have|has|had)\\s+${subject}${EPISODIC_SUBJECT_BOUNDARY}.*\\bwith\\b`,
  ).test(normalized) || new RegExp(
    `\\bwho\\s+${subject}${EPISODIC_SUBJECT_BOUNDARY}(?:\\s+[a-z]+){0,4}\\s+with\\b`,
  ).test(normalized)) {
    return "companions";
  }
  if (new RegExp(
    `\\bhow\\s+(?:d|did|have|has|had)\\s+${subject}${EPISODIC_SUBJECT_BOUNDARY}.*\\b(?:travel|go|get|come|drive|fly|ride|walk)\\b`,
  ).test(normalized) || new RegExp(
    `\\bhow\\s+${subject}${EPISODIC_SUBJECT_BOUNDARY}(?:\\s+[a-z]+){0,4}\\s+(?:travel|go|get|come|drive|fly|ride|walk)\\b`,
  ).test(normalized)) {
    return "travel_mode";
  }
  return null;
}

function actionMatches(
  record: MemoryRecord,
  actionTerms: readonly string[],
  detailTerms: readonly (readonly string[])[],
  answerFacet: EpisodicAnswerFacet | null,
): boolean {
  if (record.payload.category !== "episodic") return false;
  const searchableText = [
    record.payload.outcome,
    record.payload.episodeType,
    ...record.tags,
  ].join(" ");
  const haystack = new Set(normalize(searchableText).split(" "));
  const detailsMatch = detailTerms.every((forms) =>
    forms.some((form) => haystack.has(form))
  );
  if (!detailsMatch) return false;
  if (!answerFacetMatches(record, answerFacet, searchableText, haystack)) {
    return false;
  }
  if (actionTerms.length === 0) return true;
  return actionTerms.every((term) => actionTermMatches(term, haystack));
}

function answerFacetMatches(
  record: MemoryRecord,
  answerFacet: EpisodicAnswerFacet | null,
  searchableText: string,
  haystack: ReadonlySet<string>,
): boolean {
  if (!answerFacet) return true;
  const normalized = normalize(searchableText);
  if (answerFacet === "location") {
    return actionFamilyForms("go").some((form) => haystack.has(form))
      || /\b(?:at|in|inside|outside|near|beside|behind|under)\s+(?:the\s+)?[a-z]/.test(normalized);
  }
  if (answerFacet === "companions") {
    return record.payload.category === "episodic"
      && (
        record.payload.subjectIds.length > 1
        || householdRegex(String.raw`\bwith\s+(?:{NAMES}|mum|dad|mother|father|brother|sister|friend|friends|family|wife|husband|partner|kids|children)\b`, "i").test(searchableText)
        || /\bwith\s+[A-Z][a-z]+\b/.test(searchableText)
      );
  }
  return travelModeForms().some((form) => haystack.has(form))
    || /\bby\s+(?:car|train|bus|plane|air|bike|bicycle|motorbike|motorcycle|boat|ferry|taxi|tram|foot)\b/.test(normalized);
}

function actionTermMatches(
  term: string,
  haystack: ReadonlySet<string>,
): boolean {
  if (term === "eat") {
    const direct = episodicVerbForms("eat").some((form) =>
      haystack.has(form)
    );
    const meal = [...MEAL_TERMS].some((token) => haystack.has(token));
    const had = episodicVerbForms("have").some((form) =>
      haystack.has(form)
    );
    return direct || (meal && had);
  }
  return actionFamilyForms(term).some((form) => haystack.has(form));
}

function actionFamilyForms(term: string): readonly string[] {
  if (term === "go") {
    return [
      ...new Set([
        ...episodicVerbForms("go"),
        ...episodicVerbForms("come"),
        ...episodicVerbForms("drive"),
        ...episodicVerbForms("fly"),
        ...episodicVerbForms("ride"),
        ...episodicVerbForms("stay"),
        ...episodicVerbForms("visit"),
        ...episodicVerbForms("walk"),
      ]),
    ];
  }
  if (term === "watch" || term === "see") {
    return [
      ...new Set([
        ...episodicVerbForms("watch"),
        ...episodicVerbForms("see"),
      ]),
    ];
  }
  if (term === "call" || term === "phone") {
    return [
      ...new Set([
        ...episodicVerbForms("call"),
        ...episodicVerbForms("phone"),
      ]),
    ];
  }
  if (term === "travel") {
    return [
      ...new Set([
        ...episodicVerbForms("travel"),
        ...episodicVerbForms("go"),
        ...travelModeForms(),
      ]),
    ];
  }
  return episodicVerbForms(term);
}

function travelModeForms(): readonly string[] {
  return [
    ...new Set([
      ...episodicVerbForms("drive"),
      ...episodicVerbForms("fly"),
      ...episodicVerbForms("ride"),
      ...episodicVerbForms("run"),
      ...episodicVerbForms("swim"),
      ...episodicVerbForms("walk"),
    ]),
  ];
}

function isBirthEpisode(record: MemoryRecord): boolean {
  return record.payload.category === "episodic"
    && (
      /\b(?:birth|born)\b/.test(normalize(record.payload.episodeType))
      || record.tags.some((tag) => /\b(?:birth|born)\b/.test(normalize(tag)))
    );
}

function birthdayYearFromQuery(
  normalized: string,
  now: string,
  timezone: string,
): number | null {
  const explicitYear = /\b(19\d{2}|20\d{2}|21\d{2})\b/.exec(normalized)?.[1];
  if (explicitYear) return Number(explicitYear);
  const current = localDateParts(now, timezone);
  if (!current) return null;
  if (/\blast year\b/.test(normalized)) return current.year - 1;
  if (/\bnext year\b/.test(normalized)) return current.year + 1;
  if (/\bthis year\b/.test(normalized)) return current.year;
  return null;
}

function birthdayAgeFromQuery(normalized: string): number | null {
  const match = new RegExp(
    `\\b(?:my|${householdNamePattern()}(?: s)?)\\s+(${ORDINAL_PATTERN})\\s+birthday\\b`,
  ).exec(normalized);
  return match?.[1] ? parseOrdinalAge(match[1]) : null;
}

function parseOrdinalAge(value: string): number | null {
  const normalized = value.trim().toLowerCase().replace(/-/g, " ");
  const numeric = /^(\d{1,3})(?:st|nd|rd|th)?$/.exec(normalized)?.[1];
  if (numeric) {
    const age = Number(numeric);
    return age >= 1 && age <= 130 ? age : null;
  }
  const direct: Readonly<Record<string, number>> = {
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    fifth: 5,
    sixth: 6,
    seventh: 7,
    eighth: 8,
    ninth: 9,
    tenth: 10,
    eleventh: 11,
    twelfth: 12,
    thirteenth: 13,
    fourteenth: 14,
    fifteenth: 15,
    sixteenth: 16,
    seventeenth: 17,
    eighteenth: 18,
    nineteenth: 19,
    twentieth: 20,
    thirtieth: 30,
    fortieth: 40,
    fiftieth: 50,
    sixtieth: 60,
    seventieth: 70,
    eightieth: 80,
    ninetieth: 90,
    hundredth: 100,
  };
  if (direct[normalized]) return direct[normalized] ?? null;
  const compound = /^(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety) (first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)$/.exec(
    normalized,
  );
  if (!compound) return null;
  const tens: Readonly<Record<string, number>> = {
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
  };
  return (tens[compound[1] ?? ""] ?? 0)
    + (direct[compound[2] ?? ""] ?? 0);
}

function birthdayYearForAge(
  records: readonly MemoryRecord[],
  age: number,
  subjectIds: readonly string[],
  actorId: string | null,
  request: VoiceBrainRequest,
  now: string,
): number | null {
  const birthDate = accessibleBirthDateRecord(
    records,
    subjectIds,
    actorId,
    request,
    now,
  );
  if (
    !birthDate
    || birthDate.payload.category !== "fact"
    || typeof birthDate.payload.value !== "string"
  ) {
    return null;
  }
  const birthYear = /^(\d{4})-\d{2}-\d{2}$/.exec(
    birthDate.payload.value,
  )?.[1];
  return birthYear ? Number(birthYear) + age : null;
}

function birthdayAgeMatchesRecord(
  record: MemoryRecord,
  age: number,
): boolean {
  if (record.payload.category !== "episodic") return false;
  const text = normalize([
    record.payload.outcome,
    record.payload.episodeType,
    ...record.tags,
  ].join(" "));
  if (new RegExp(`\\b${age}(?:st|nd|rd|th)? birthday\\b`).test(text)) {
    return true;
  }
  const matches = text.matchAll(
    new RegExp(`\\b(${ORDINAL_PATTERN}) birthday\\b`, "g"),
  );
  return [...matches].some((match) =>
    match[1] ? parseOrdinalAge(match[1]) === age : false
  );
}

function accessibleBirthDate(
  records: readonly MemoryRecord[],
  query: EpisodicRecallQuery,
  request: VoiceBrainRequest,
  now: string,
): boolean {
  return accessibleBirthDateRecord(
    records,
    query.subjectIds,
    query.actorId,
    request,
    now,
  ) !== null;
}

function accessibleBirthDateRecord(
  records: readonly MemoryRecord[],
  subjectIds: readonly string[],
  actorId: string | null,
  request: VoiceBrainRequest,
  now: string,
): MemoryRecord | null {
  if (!actorId) return null;
  return records.find((record) =>
    record.category === "fact"
    && record.payload.category === "fact"
    && record.payload.factType === "birth_date"
    && memoryRecordRecallAllowed(record, {
      actorId,
      channel: request.channel,
      now,
    })
    && subjectIds.some((subjectId) =>
      memorySubjectIds(record).has(subjectId)
    )
  ) ?? null;
}

function localDateParts(value: string, timezone: string): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
} | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
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

function monthName(month: number): string {
  return [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ][month - 1] ?? "";
}

function displayInstantDate(value: string, timezone: string): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return value;
  const parts = new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: timezone,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("year")}`.trim();
}

function windowLead(window: TimeWindow, transcript: string): string {
  if (window.source === "absolute_date") {
    return `On ${displayInstantDate(window.start, window.timezone)}`;
  }
  if (window.source === "absolute_range") {
    const inclusiveEnd = new Date(Date.parse(window.end) - 1).toISOString();
    return `Between ${displayInstantDate(window.start, window.timezone)} and ${displayInstantDate(inclusiveEnd, window.timezone)}`;
  }
  const normalized = normalize(transcript);
  if (window.source === "day_part") {
    const phrase = /\b(?:(?:today|yesterday|this|last|tonight)\s+)?(?:morning|afternoon|evening|night)\b/.exec(normalized)?.[0]
      ?? window.label;
    return capitalize(phrase);
  }
  if (
    window.source === "relative_calendar"
    && /^(?:today|yesterday|tonight)$/.test(window.label)
  ) {
    return capitalize(window.label);
  }
  return `During ${window.label}`;
}

function windowDescription(window: TimeWindow): string {
  if (window.source === "absolute_date") {
    return displayInstantDate(window.start, window.timezone);
  }
  if (window.source === "absolute_range") {
    const inclusiveEnd = new Date(Date.parse(window.end) - 1).toISOString();
    return `${displayInstantDate(window.start, window.timezone)} to ${displayInstantDate(inclusiveEnd, window.timezone)}`;
  }
  return window.label;
}

function windowNoMatchPhrase(window: TimeWindow): string {
  if (window.source === "absolute_date") {
    return `on ${windowDescription(window)}`;
  }
  if (window.source === "absolute_range") {
    const inclusiveEnd = new Date(Date.parse(window.end) - 1).toISOString();
    return `between ${displayInstantDate(window.start, window.timezone)} and ${displayInstantDate(inclusiveEnd, window.timezone)}`;
  }
  if (
    window.source === "relative_calendar"
    && /^(?:today|yesterday|tonight)$/.test(window.label)
  ) {
    return window.label;
  }
  return `during ${windowDescription(window)}`;
}

function birthdaySubjectText(query: EpisodicRecallQuery): string {
  const subjectId = query.subjectIds[0] ?? "";
  if (!subjectId) return "that person's birthday";
  return query.actorId !== null && subjectId === query.actorId
    ? "your birthday"
    : `${subjectLabel(subjectId)}'s birthday`;
}

function birthdaySubjectPronoun(query: EpisodicRecallQuery): string {
  const subjectId = query.subjectIds[0] ?? "";
  if (!subjectId) return "that person";
  return query.actorId !== null && subjectId === query.actorId
    ? "you"
    : subjectLabel(subjectId);
}

function subjectPastCopula(query: EpisodicRecallQuery): "was" | "were" {
  const subjectId = query.subjectIds[0] ?? "";
  return query.actorId !== null && subjectId === query.actorId
    ? "were"
    : "was";
}

function renderOutcome(
  value: string,
  subjectId: string,
  isSpeaker: boolean,
): string {
  let outcome = value.trim().replace(/[.!?]+$/, "");
  const label = subjectLabel(subjectId);
  if (isSpeaker) {
    outcome = outcome
      .replace(new RegExp(`^${escapeRegExp(label)}(?:'s| s)\\s+`, "i"), "Your ")
      .replace(new RegExp(`^${escapeRegExp(label)}\\s+`, "i"), "You ")
      .replace(/\bi was\b/gi, "you were")
      .replace(/\bi am\b/gi, "you are")
      .replace(/\bmyself\b/gi, "yourself")
      .replace(/\bmine\b/gi, "yours")
      .replace(/\bmy\b/gi, "your")
      .replace(/\bme\b/gi, "you")
      .replace(/\bi\b/gi, "you");
    if (!/^(?:you|your)\b/i.test(outcome)) {
      outcome = outcome.replace(/^was\b/i, "were");
      outcome = `You ${lowercaseStart(outcome)}`;
    }
  } else {
    outcome = outcome
      .replace(/\bmyself\b/gi, label)
      .replace(/\bmine\b/gi, `${label}'s`)
      .replace(/\bmy\b/gi, `${label}'s`)
      .replace(/\bme\b/gi, label)
      .replace(/\bi\b/gi, label);
    if (!new RegExp(`^${escapeRegExp(label)}\\b`, "i").test(outcome)) {
      outcome = `${label} ${lowercaseStart(outcome)}`;
    }
  }
  return `${capitalize(outcome)}.`;
}

function stripBirthdayContext(value: string): string {
  return value
    .replace(
      new RegExp(
        `\\s+(?:for|on|at)\\s+(?:(?:my|your|his|her|their|${householdNamePattern()}(?:'s| s)?)\\s+)?(?:${ORDINAL_PATTERN}\\s+)?birthday\\s*$`,
        "i",
      ),
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function joinClauses(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${stripPeriod(values[0] ?? "")} and ${continuationStart(values[1] ?? "")}`;
  return `${values.slice(0, -1).map(stripPeriod).join(", ")}, and ${continuationStart(values.at(-1) ?? "")}`;
}

function stripPeriod(value: string): string {
  return value.replace(/\.$/, "");
}

function lowercaseStart(value: string): string {
  if (!value) return value;
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function continuationStart(value: string): string {
  return /^(?:You|Your)\b/.test(value) ? lowercaseStart(value) : value;
}

function subjectLabel(subjectId: string): string {
  const person = householdPersonById(subjectId);
  if (person) return person.name;
  const tail = subjectId.split(".").pop() ?? subjectId;
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

function hasSpeakerSelfReference(normalized: string): boolean {
  if (/\b(?:i|mine)\b/.test(normalized)) return true;
  if (/\b(?:about|to|with) me\b/.test(normalized)) return true;
  if (!/\bmy\b/.test(normalized)) return false;
  return !RELATIONAL_POSSESSIVE_PATTERN.test(normalized);
}

function normalize(value: string): string {
  return canonicalizeRoutingText(normalizeSpeechForRouting(value));
}
