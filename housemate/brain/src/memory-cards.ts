import type { AppConfig } from "./config.js";
import { cognitiveFeatureEnabled } from "./cognitive-control.js";
import {
  canonicalRecallActorId,
  canonicalRecallSubjectId,
  memoryRecordRecallAllowed,
} from "./memory-access.js";
import { buildMemorySalienceEvidenceLines, memorySalienceScore, normalizeMemoryText } from "./memory-salience.js";
import { displaySubject, memoryPlainText } from "./memory-recall.js";
import type { JsonValue, MemoryRecord } from "./memory-schema.js";
import { MemoryStore, memoryStorePath } from "./memory-store.js";
import { householdNameTokens, peopleNamedIn } from "./household.js";

export interface BasicMemoryCard {
  readonly memoryId: string;
  readonly subject: string;
  readonly fact: string;
  readonly reason: string;
  readonly source: string;
  readonly confidence: number;
  readonly lastConfirmed: string;
  readonly linkedEntities: readonly string[];
  readonly evidenceLines: readonly string[];
}

export interface MemoryCardConversationTurn {
  readonly speakerName: string | null;
  readonly transcript: string;
}

export interface MemoryCardQuery {
  readonly transcript: string;
  readonly speakerName: string | null;
  readonly speakerVoiceId: string | null;
  readonly speakerConfidence?: number | null;
  readonly speakerTrustedActorId?: string | null;
  readonly channel?: string;
  readonly now?: string;
  readonly conversationTurns?: readonly MemoryCardConversationTurn[];
  readonly maxCards?: number;
}

export interface MemoryAdapter {
  getMemoryCards(query: MemoryCardQuery): readonly BasicMemoryCard[];
}

// Referential words that make a turn lean on the previous one. A bare "it" is
// excluded: it is usually a dummy subject ("is it worth...", "it's cold").
const FOLLOW_UP_HINT = /\b(that|they|them|those|she|he|her|him|more|another|else|same)\b/;
const FIRST_PERSON_HINT = /\b(i|me|my|mine)\b/;
const OWN_PREFERENCE_HINT = /\b(?:prefer|prefers|preferred|preference|preferences|like|likes|love|loves|enjoy|enjoys|favou?rites?|taste|tastes)\b/;
const STOP_TOKENS = new Set([
  "a",
  "about",
  "am",
  "an",
  "and",
  "any",
  "are",
  "at",
  "be",
  "but",
  "do",
  "for",
  "from",
  "get",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "its",
  "me",
  "more",
  "my",
  "of",
  "on",
  "or",
  "please",
  "should",
  "tell",
  "that",
  "the",
  "them",
  "there",
  "they",
  "this",
  "to",
  "us",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "you",
  "your",
]);
// Frame words carry no topic: memory values say "likes quiet" or "does not
// usually feel stressed", and speech says "what do you make of".
const FRAME_TOKENS = new Set([
  "above", "after", "also", "around", "because", "been", "below", "can", "care", "could",
  "did", "does", "doing", "done", "feel", "feels", "felt", "getting", "had", "has", "have",
  "help", "helps", "her", "him", "his", "just", "like", "liked", "likes", "love", "loves",
  "mainly", "make", "much", "need", "needs", "not", "often", "other", "people", "person",
  "prefer", "preferred", "prefers", "reckon", "really", "say", "she", "some", "strong",
  "tend", "tends", "than", "then", "thing", "things", "think", "too", "usually", "very",
  "was", "were", "will", "with", "would", "worth",
]);
const BOOKKEEPING_TAGS = new Set([
  "cognitive_consolidated",
  "people_fact",
  "preferences_file",
  "routine",
  "v3_import",
]);
export class SqliteMemoryCardAdapter implements MemoryAdapter {
  private readonly config: Pick<AppConfig, "dataDir"> & Partial<Pick<
    AppConfig,
    "cognitiveSystemEnabled" | "cognitiveRecallEnabled"
  >>;

  constructor(config: Pick<AppConfig, "dataDir"> & Partial<Pick<
    AppConfig,
    "cognitiveSystemEnabled" | "cognitiveRecallEnabled"
  >>) {
    this.config = config;
  }

  getMemoryCards(query: MemoryCardQuery): readonly BasicMemoryCard[] {
    if (!cognitiveFeatureEnabled(this.config, "recall")) {
      return [];
    }
    const store = new MemoryStore(memoryStorePath(this.config));
    try {
      return selectAcceptedMemoryCards(store.listMemoryRecords(), query);
    } finally {
      store.close();
    }
  }
}

/**
 * Pick accepted memory cards that are genuinely relevant to this turn.
 *
 * Relevance needs typed evidence, not incidental word overlap:
 * - a household member named in the utterance brings their cards on that
 *   topic, or their whole profile when the utterance names no topic of theirs;
 * - the speaker's own cards need a topic term, or a question about their own
 *   preferences;
 * - anyone else's card needs the utterance itself to name that memory's typed
 *   object (the preferred thing, the fact value, the place...), so a shared
 *   frame word or a borrowed earlier topic cannot pull it in.
 * Terms match as whole, lightly stemmed words against typed memory fields, not
 * as substrings of serialised payload JSON.
 */
export function selectAcceptedMemoryCards(
  records: readonly MemoryRecord[],
  query: MemoryCardQuery,
): readonly BasicMemoryCard[] {
  const transcriptText = normalizeMemoryText(query.transcript);
  const namedSubjectIds = namedSubjectIdsForTranscript(transcriptText);
  const currentTerms = topicTerms(transcriptText);
  const borrowedTerms = borrowedFollowUpTerms(query, transcriptText);
  const maxCards = Math.max(1, Math.min(query.maxCards ?? 4, 6));
  const recallActorId = canonicalRecallActorId(
    query.speakerTrustedActorId,
    query.speakerTrustedActorId ? 1 : null,
  );
  const speakerSubjectId = recallActorId
    ?? canonicalRecallSubjectId(query.speakerVoiceId);
  const firstPerson = FIRST_PERSON_HINT.test(transcriptText);
  const ownPreferenceQuestion = firstPerson && OWN_PREFERENCE_HINT.test(transcriptText);

  return records
    .filter((record) =>
      memoryRecordRecallAllowed(record, {
        actorId: recallActorId,
        channel: query.channel ?? "chat",
        purpose: "model_context",
        ...(query.now ? { now: query.now } : {}),
      })
    )
    .map((record) => scoreMemoryCard(record, {
      namedSubjectIds,
      currentTerms,
      borrowedTerms,
      firstPerson,
      ownPreferenceQuestion,
      speakerSubjectId,
    }))
    .filter((candidate, _index, candidates) =>
      candidate.score > 0
      && !namedOnlyCardOutranked(candidate, candidates))
    .sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt))
    .slice(0, maxCards)
    .map((candidate) => toMemoryCard(candidate.record));
}

function scoreMemoryCard(
  record: MemoryRecord,
  context: {
    readonly namedSubjectIds: ReadonlySet<string>;
    readonly currentTerms: ReadonlySet<string>;
    readonly borrowedTerms: ReadonlySet<string>;
    readonly firstPerson: boolean;
    readonly ownPreferenceQuestion: boolean;
    readonly speakerSubjectId: string | null;
  },
): ScoredMemoryCard {
  // Relevance follows who the memory is about, not who recorded it: imported
  // household memories are all owned by the person who imported them.
  const recordSubjectIds = aboutSubjectIdsForRecord(record);
  const terms = memoryTopicTerms(record);
  const namedSubject = [...recordSubjectIds].some((subjectId) => context.namedSubjectIds.has(subjectId));
  const aboutSpeaker = Boolean(context.speakerSubjectId && recordSubjectIds.has(context.speakerSubjectId));
  const currentObject = countShared(context.currentTerms, terms.object);
  const currentContext = countShared(context.currentTerms, terms.context);
  const borrowed = countShared(context.borrowedTerms, terms.object)
    + countShared(context.borrowedTerms, terms.context);
  const ownPreference = aboutSpeaker
    && context.ownPreferenceQuestion
    && record.category === "preference";

  const eligible = namedSubject
    || currentObject > 0
    || (aboutSpeaker && (currentContext > 0 || borrowed > 0 || ownPreference));
  const named = [...recordSubjectIds].filter((subjectId) => context.namedSubjectIds.has(subjectId));
  const topical = currentObject + currentContext > 0;
  if (!eligible) {
    return { record, score: 0, named, topical };
  }

  let score = 0;
  if (namedSubject) {
    score += 8;
  }
  if (aboutSpeaker && context.firstPerson) {
    score += 4;
  }
  if (ownPreference) {
    score += 3;
  }
  score += currentObject * 4 + currentContext * 2 + borrowed;
  score += record.confidence + record.sourceReliability + Math.min(record.retrievalStrength, 0.5);
  score += memorySalienceScore(record);
  if (record.lastConfirmedAt) {
    score += 0.25;
  }
  return { record, score, named, topical };
}

interface ScoredMemoryCard {
  readonly record: MemoryRecord;
  readonly score: number;
  /** Household members named in the utterance whom this memory is about. */
  readonly named: readonly string[];
  /** The utterance itself shares a topic term with this memory. */
  readonly topical: boolean;
}

/**
 * A card admitted only because its person was named gives way when the
 * utterance also names a topic that some of that person's cards match.
 */
function namedOnlyCardOutranked(
  candidate: ScoredMemoryCard,
  candidates: readonly ScoredMemoryCard[],
): boolean {
  if (candidate.topical || candidate.named.length === 0) {
    return false;
  }
  return candidate.named.every((subjectId) => candidates.some((other) =>
    other.score > 0
    && other.topical
    && other.named.includes(subjectId)));
}

function countShared(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  for (const term of left) {
    if (right.has(term)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Typed topic terms for a memory. `object` is what the memory is about (the
 * preferred thing, the fact value, the place or event); `context` is its type
 * label, meaningful tags, and descriptive text.
 */
function memoryTopicTerms(record: MemoryRecord): {
  readonly object: ReadonlySet<string>;
  readonly context: ReadonlySet<string>;
} {
  const payload = record.payload;
  const plainText = memoryPlainText(record);
  let objectText: string[];
  let labels: string[];
  switch (payload.category) {
    case "preference":
      objectText = jsonStringLeaves(payload.value);
      labels = [payload.preferenceType];
      break;
    case "fact":
      objectText = [payload.factType, ...jsonStringLeaves(payload.value)];
      labels = [payload.factType];
      break;
    case "event":
      objectText = [payload.eventType, payload.location ?? ""];
      labels = [payload.eventType];
      break;
    case "person":
      objectText = [payload.canonicalName, ...payload.aliases];
      labels = [...payload.roles];
      break;
    case "place":
      objectText = [payload.canonicalName, ...payload.aliases, payload.meaning];
      labels = [];
      break;
    case "relationship":
      objectText = [payload.relationshipType];
      labels = [payload.relationshipType];
      break;
    case "rule":
      objectText = [payload.statement];
      labels = [payload.ruleType];
      break;
    case "skill":
      objectText = [payload.instruction];
      labels = [payload.skillType];
      break;
    case "episodic":
      objectText = [payload.outcome];
      labels = [payload.episodeType];
      break;
    default:
      objectText = [plainText];
      labels = "routineType" in payload ? [payload.routineType] : [];
  }
  const tags = record.tags.filter((tag) => !tag.includes(":") && !BOOKKEEPING_TAGS.has(tag));
  return {
    object: topicTerms(objectText.join(" ")),
    context: topicTerms([...labels, ...tags, record.title, record.summary, plainText].join(" ")),
  };
}

function jsonStringLeaves(value: JsonValue): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => jsonStringLeaves(item));
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap((item) => jsonStringLeaves(item));
  }
  return [];
}

function topicTerms(text: string): ReadonlySet<string> {
  return new Set(
    normalizeMemoryText(text.replaceAll("_", " "))
      .split(" ")
      .filter((token) => /[a-z]/.test(token)
        && token.length >= 3
        && !STOP_TOKENS.has(token)
        && !FRAME_TOKENS.has(token)
        && !householdNameTokens().has(token))
      .map(stemTerm),
  );
}

function stemTerm(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.length > 4 && /(?:ches|shes|sses|xes)$/.test(token)) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function toMemoryCard(record: MemoryRecord): BasicMemoryCard {
  const fact = ensureSentence(memoryPlainText(record));
  const reason = ensureSentence(record.summary === fact ? record.title : record.summary || record.title);
  return {
    memoryId: record.id,
    subject: displaySubject(record.subjectIds[0] ?? record.ownerId ?? "household"),
    fact,
    reason,
    source: memorySourceLabel(record),
    confidence: Number(record.confidence.toFixed(2)),
    lastConfirmed: record.lastConfirmedAt ?? record.updatedAt,
    linkedEntities: [...linkedEntitiesForRecord(record)],
    evidenceLines: buildMemorySalienceEvidenceLines(record),
  };
}

function namedSubjectIdsForTranscript(transcript: string): ReadonlySet<string> {
  return new Set(peopleNamedIn(transcript).map((person) => person.id));
}

function borrowedFollowUpTerms(query: MemoryCardQuery, transcript: string): ReadonlySet<string> {
  if (!FOLLOW_UP_HINT.test(transcript)) {
    return new Set();
  }
  const current = topicTerms(transcript);
  const recent = (query.conversationTurns ?? [])
    .slice(-2)
    .map((turn) => turn.transcript)
    .join(" ");
  return new Set([...topicTerms(recent)].filter((term) => !current.has(term)));
}

function aboutSubjectIdsForRecord(record: MemoryRecord): ReadonlySet<string> {
  const values = new Set(record.subjectIds.map((subjectId) => subjectId.toLowerCase()));
  if (record.category === "preference" && record.payload.category === "preference") {
    values.add(record.payload.subjectId.toLowerCase());
  }
  return values;
}

function linkedEntitiesForRecord(record: MemoryRecord): ReadonlySet<string> {
  const values = new Set<string>(record.subjectIds);
  if (record.ownerId) {
    values.add(record.ownerId);
  }
  for (const tag of record.tags) {
    if (/^(?:entity|device|area|person):/i.test(tag)) {
      values.add(tag.slice(tag.indexOf(":") + 1));
    }
  }
  return values;
}

function memorySourceLabel(record: MemoryRecord): string {
  if (record.provenance?.derivation === "cognitive_consolidation") {
    return "consolidated private experience";
  }
  if (record.provenance?.derivation === "memory_reflection") {
    return "reflected conversation";
  }
  if (record.tags.includes("v3_import")) {
    return "accepted v3 import";
  }
  if (record.tags.includes("review:manual")) {
    return "accepted manually reviewed memory";
  }
  if (record.category === "routine") {
    return "accepted routine memory";
  }
  return `accepted ${record.category} memory`;
}

function ensureSentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
