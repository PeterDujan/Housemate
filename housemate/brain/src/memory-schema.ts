
import { objectValue, optionalString, requiredString } from "./value-guards.js";export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type MemoryCategory =
  | "event"
  | "fact"
  | "preference"
  | "routine"
  | "person"
  | "relationship"
  | "place"
  | "rule"
  | "skill"
  | "episodic";

export type MemoryTier = "short" | "medium" | "long" | "archive";
export type MemoryScope = "person" | "household" | "room" | "device" | "conversation" | "system";
export type ReviewStatus =
  | "accepted"
  | "queued"
  | "needs_clarification"
  | "rejected"
  | "redacted"
  | "deleted";
export type MemorySourceType =
  | "chat"
  | "voice_turn"
  | "calendar"
  | "home_assistant"
  | "history"
  | "weather"
  | "operator_import"
  | "routine_miner"
  | "system";
export type SensitivityCategory =
  | "child"
  | "health"
  | "safety"
  | "location"
  | "school"
  | "relationship"
  | "permission"
  | "finance"
  | "private"
  | "none";

export interface MemoryRecallPolicy {
  readonly visibility: "household" | "named_actors" | "operator_only";
  readonly allowedActorIds: readonly string[];
  readonly allowedChannels: readonly ("chat" | "voice")[];
  readonly modelContextAllowed: boolean;
  readonly proactiveUseAllowed: boolean;
}

export interface MemoryProvenance {
  readonly derivation: "cognitive_consolidation" | "memory_reflection";
  readonly sourceExperienceIds: readonly string[];
  readonly pipelineVersion: string;
  readonly generatedAt: string;
}

export interface MemorySalience {
  readonly returnCount: number;
  readonly recurrenceCount: number;
  readonly correctionCount: number;
  readonly reopenedCount: number;
  readonly unresolved: boolean;
  readonly lastSeen?: string;
  readonly sourceEvidenceIds: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly sourceSlugs: readonly string[];
  readonly sourceAliases: readonly string[];
  readonly memoryEditIds: readonly string[];
  readonly correctionTargets: readonly string[];
}

export interface MemoryRecordBase<TPayload extends MemoryPayload = MemoryPayload> {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly category: TPayload["category"];
  readonly tier: MemoryTier;
  readonly scope: MemoryScope;
  readonly subjectIds: readonly string[];
  readonly ownerId?: string;
  readonly title: string;
  readonly summary: string;
  readonly payload: TPayload;
  readonly confidence: number;
  readonly sourceReliability: number;
  readonly retrievalStrength: number;
  readonly storageStrength: number;
  readonly reviewStatus: ReviewStatus;
  readonly sensitivity: readonly SensitivityCategory[];
  readonly evidenceIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly expiresAt?: string;
  readonly reviewAfter?: string;
  readonly staleAfter?: string;
  readonly lastRetrievedAt?: string;
  readonly lastConfirmedAt?: string;
  readonly lastUsedAt?: string;
  readonly evidenceCount: number;
  readonly contradictionCount: number;
  readonly supersedesIds: readonly string[];
  readonly contradictedByIds: readonly string[];
  readonly tags: readonly string[];
  /** Broader words a person might later use for this memory; recall search only. */
  readonly recallTerms?: readonly string[];
  readonly recallPolicy?: MemoryRecallPolicy;
  readonly provenance?: MemoryProvenance;
  readonly salience?: MemorySalience;
}

export type MemoryRecord = MemoryRecordBase<MemoryPayload>;

export interface EventMemoryPayload {
  readonly category: "event";
  readonly eventType: string;
  readonly startsAt?: string;
  readonly date?: string;
  readonly endsAt?: string;
  readonly subjectIds: readonly string[];
  readonly location?: string;
  readonly status: "planned" | "confirmed" | "cancelled" | "completed" | "unknown";
}

export interface FactMemoryPayload {
  readonly category: "fact";
  readonly factType: string;
  readonly subjectIds: readonly string[];
  readonly value: JsonValue;
  readonly scope: MemoryScope;
  readonly validity: "current" | "historical" | "uncertain";
}

export interface PreferenceMemoryPayload {
  readonly category: "preference";
  readonly preferenceType: string;
  readonly subjectId: string;
  readonly value: JsonValue;
  readonly scope: MemoryScope;
  readonly strength: "weak" | "normal" | "strong";
  readonly impact: "low" | "medium" | "high";
}

export interface RoutineMemoryPayload {
  readonly category: "routine";
  readonly routineType: string;
  readonly subjectIds: readonly string[];
  readonly schedulePattern: string;
  readonly window: string;
  readonly evidenceSpan: string;
  readonly sampleCount: number;
  readonly eligibleForReasoning: boolean;
}

export interface PersonMemoryPayload {
  readonly category: "person";
  readonly personId: string;
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  readonly voiceIds: readonly string[];
  readonly roles: readonly string[];
  readonly confidenceByAlias: Readonly<Record<string, number>>;
}

export interface RelationshipMemoryPayload {
  readonly category: "relationship";
  readonly fromSubjectId: string;
  readonly relationshipType: string;
  readonly toSubjectId: string;
  readonly direction: "one_way" | "mutual";
  readonly confidenceBySource: Readonly<Record<string, number>>;
}

export interface PlaceMemoryPayload {
  readonly category: "place";
  readonly placeId: string;
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  readonly areaRefs: readonly string[];
  readonly meaning: string;
}

export interface RuleMemoryPayload {
  readonly category: "rule";
  readonly ruleType: string;
  readonly scope: MemoryScope;
  readonly authority: string;
  readonly statement: string;
  readonly enforcementLevel: "advisory" | "block" | "require_confirmation";
}

export interface SkillMemoryPayload {
  readonly category: "skill";
  readonly skillType: string;
  readonly instruction: string;
  readonly scope: MemoryScope;
  readonly authority: string;
  readonly examples: readonly string[];
  readonly enforcementLevel: "advisory" | "prefer" | "require";
}

export interface EpisodicMemoryPayload {
  readonly category: "episodic";
  readonly episodeType: string;
  readonly occurredAt: string;
  readonly subjectIds: readonly string[];
  readonly outcome: string;
  readonly relatedMemoryIds: readonly string[];
}

export type MemoryPayload =
  | EventMemoryPayload
  | FactMemoryPayload
  | PreferenceMemoryPayload
  | RoutineMemoryPayload
  | PersonMemoryPayload
  | RelationshipMemoryPayload
  | PlaceMemoryPayload
  | RuleMemoryPayload
  | SkillMemoryPayload
  | EpisodicMemoryPayload;

export interface EvidenceRecord {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly sourceType: MemorySourceType;
  readonly sourceRef?: string;
  readonly channel?: "chat" | "voice" | "tool" | "import" | "system";
  readonly speakerId?: string;
  readonly subjectIds: readonly string[];
  readonly observedAt: string;
  readonly ingestedAt: string;
  readonly windowStart?: string;
  readonly windowEnd?: string;
  readonly textSummary?: string;
  readonly structuredSummary?: JsonValue;
  readonly confidence: number;
  readonly sourceReliability: number;
  readonly sensitivity: readonly SensitivityCategory[];
  readonly retention: "normal" | "short" | "long" | "redactable";
  readonly redactedAt?: string;
}

const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  "event",
  "fact",
  "preference",
  "routine",
  "person",
  "relationship",
  "place",
  "rule",
  "skill",
  "episodic",
];
const MEMORY_TIERS: readonly MemoryTier[] = ["short", "medium", "long", "archive"];
const MEMORY_SCOPES: readonly MemoryScope[] = ["person", "household", "room", "device", "conversation", "system"];
const REVIEW_STATUSES: readonly ReviewStatus[] = [
  "accepted",
  "queued",
  "needs_clarification",
  "rejected",
  "redacted",
  "deleted",
];
const MEMORY_SOURCE_TYPES: readonly MemorySourceType[] = [
  "chat",
  "voice_turn",
  "calendar",
  "home_assistant",
  "history",
  "weather",
  "operator_import",
  "routine_miner",
  "system",
];
const SENSITIVITY_CATEGORIES: readonly SensitivityCategory[] = [
  "child",
  "health",
  "safety",
  "location",
  "school",
  "relationship",
  "permission",
  "finance",
  "private",
  "none",
];

export function parseMemoryRecord(raw: unknown): MemoryRecord {
  const record = objectValue(raw, "memory record");
  const schemaVersion = schemaVersionValue(record.schemaVersion, "memory record");
  const category = enumValue(record.category, MEMORY_CATEGORIES, "memory record category");
  const tier = enumValue(record.tier, MEMORY_TIERS, "memory record tier");
  const scope = enumValue(record.scope, MEMORY_SCOPES, "memory record scope");
  const evidenceIds = stringArray(record.evidenceIds, "memory record evidenceIds", { allowEmpty: true });
  const reviewStatus = enumValue(record.reviewStatus, REVIEW_STATUSES, "memory record reviewStatus");
  const parsed = {
    id: requiredString(record.id, "memory record id"),
    schemaVersion,
    category,
    tier,
    scope,
    subjectIds: stringArray(record.subjectIds, "memory record subjectIds", { allowEmpty: false }),
    ...(optionalString(record.ownerId) ? { ownerId: optionalString(record.ownerId) as string } : {}),
    title: requiredString(record.title, "memory record title"),
    summary: requiredString(record.summary, "memory record summary"),
    payload: parseMemoryPayload(category, record.payload),
    confidence: boundedNumber(record.confidence, "memory record confidence"),
    sourceReliability: boundedNumber(record.sourceReliability, "memory record sourceReliability"),
    retrievalStrength: boundedNumber(record.retrievalStrength, "memory record retrievalStrength"),
    storageStrength: boundedNumber(record.storageStrength, "memory record storageStrength"),
    reviewStatus,
    sensitivity: sensitivityArray(record.sensitivity, "memory record sensitivity"),
    evidenceIds,
    createdAt: isoString(record.createdAt, "memory record createdAt"),
    updatedAt: isoString(record.updatedAt, "memory record updatedAt"),
    ...(optionalIsoString(record.validFrom, "memory record validFrom") ? { validFrom: optionalIsoString(record.validFrom, "memory record validFrom") as string } : {}),
    ...(optionalIsoString(record.validUntil, "memory record validUntil") ? { validUntil: optionalIsoString(record.validUntil, "memory record validUntil") as string } : {}),
    ...(optionalIsoString(record.expiresAt, "memory record expiresAt") ? { expiresAt: optionalIsoString(record.expiresAt, "memory record expiresAt") as string } : {}),
    ...(optionalIsoString(record.reviewAfter, "memory record reviewAfter") ? { reviewAfter: optionalIsoString(record.reviewAfter, "memory record reviewAfter") as string } : {}),
    ...(optionalIsoString(record.staleAfter, "memory record staleAfter") ? { staleAfter: optionalIsoString(record.staleAfter, "memory record staleAfter") as string } : {}),
    ...(optionalIsoString(record.lastRetrievedAt, "memory record lastRetrievedAt") ? { lastRetrievedAt: optionalIsoString(record.lastRetrievedAt, "memory record lastRetrievedAt") as string } : {}),
    ...(optionalIsoString(record.lastConfirmedAt, "memory record lastConfirmedAt") ? { lastConfirmedAt: optionalIsoString(record.lastConfirmedAt, "memory record lastConfirmedAt") as string } : {}),
    ...(optionalIsoString(record.lastUsedAt, "memory record lastUsedAt") ? { lastUsedAt: optionalIsoString(record.lastUsedAt, "memory record lastUsedAt") as string } : {}),
    evidenceCount: nonNegativeInteger(record.evidenceCount, "memory record evidenceCount"),
    contradictionCount: nonNegativeInteger(record.contradictionCount, "memory record contradictionCount"),
    supersedesIds: stringArray(record.supersedesIds, "memory record supersedesIds", { allowEmpty: true }),
    contradictedByIds: stringArray(record.contradictedByIds, "memory record contradictedByIds", { allowEmpty: true }),
    tags: stringArray(record.tags, "memory record tags", { allowEmpty: true }),
    ...(record.recallTerms === undefined
      ? {}
      : { recallTerms: stringArray(record.recallTerms, "memory record recallTerms", { allowEmpty: true }) }),
    ...(record.recallPolicy === undefined
      ? {}
      : { recallPolicy: parseMemoryRecallPolicy(record.recallPolicy) }),
    ...(record.provenance === undefined
      ? {}
      : { provenance: parseMemoryProvenance(record.provenance) }),
    salience: parseMemorySalience(record.salience),
  } satisfies MemoryRecord;

  if (parsed.payload.category !== parsed.category) {
    throw new Error("memory record payload category must match record category");
  }
  if (parsed.evidenceCount < parsed.evidenceIds.length) {
    throw new Error("memory record evidenceCount cannot be less than evidenceIds length");
  }
  if (parsed.tier === "long" && parsed.evidenceIds.length === 0) {
    throw new Error("long memory record requires at least one evidenceId");
  }
  if (
    parsed.tier === "long" &&
    parsed.sourceReliability < 0.8 &&
    parsed.evidenceCount < 2 &&
    parsed.reviewStatus !== "accepted"
  ) {
    throw new Error("long memory record requires strong source, repeated evidence, or accepted review");
  }
  const cognitive = parsed.provenance?.derivation === "cognitive_consolidation"
    || parsed.tags.includes("cognitive_consolidated");
  if (cognitive && !parsed.recallPolicy) {
    throw new Error("cognitive consolidated memory requires a recallPolicy");
  }
  if (
    parsed.recallPolicy
    && parsed.ownerId
    && parsed.recallPolicy.visibility !== "household"
    && !parsed.recallPolicy.allowedActorIds.includes(parsed.ownerId)
  ) {
    throw new Error("private memory ownerId must be allowed by recallPolicy");
  }
  return parsed;
}

function parseMemoryRecallPolicy(raw: unknown): MemoryRecallPolicy {
  const policy = objectValue(raw, "memory recallPolicy");
  const visibility = enumValue(
    policy.visibility,
    ["household", "named_actors", "operator_only"] as const,
    "memory recallPolicy visibility",
  );
  const allowedActorIds = stringArray(
    policy.allowedActorIds,
    "memory recallPolicy allowedActorIds",
    { allowEmpty: visibility === "household" },
  );
  if (visibility !== "household" && allowedActorIds.length === 0) {
    throw new Error("non-household memory recallPolicy requires an allowed actor");
  }
  return {
    visibility,
    allowedActorIds,
    allowedChannels: enumArray(
      policy.allowedChannels,
      ["chat", "voice"] as const,
      "memory recallPolicy allowedChannels",
      { allowEmpty: false },
    ),
    modelContextAllowed: booleanValue(
      policy.modelContextAllowed,
      "memory recallPolicy modelContextAllowed",
    ),
    proactiveUseAllowed: booleanValue(
      policy.proactiveUseAllowed,
      "memory recallPolicy proactiveUseAllowed",
    ),
  };
}

function parseMemoryProvenance(raw: unknown): MemoryProvenance {
  const provenance = objectValue(raw, "memory provenance");
  return {
    derivation: enumValue(
      provenance.derivation,
      ["cognitive_consolidation", "memory_reflection"] as const,
      "memory provenance derivation",
    ),
    sourceExperienceIds: stringArray(
      provenance.sourceExperienceIds,
      "memory provenance sourceExperienceIds",
      { allowEmpty: false },
    ),
    pipelineVersion: requiredString(
      provenance.pipelineVersion,
      "memory provenance pipelineVersion",
    ),
    generatedAt: isoString(
      provenance.generatedAt,
      "memory provenance generatedAt",
    ),
  };
}

export function parseEvidenceRecord(raw: unknown): EvidenceRecord {
  const record = objectValue(raw, "evidence record");
  return {
    id: requiredString(record.id, "evidence record id"),
    schemaVersion: schemaVersionValue(record.schemaVersion, "evidence record"),
    sourceType: enumValue(record.sourceType, MEMORY_SOURCE_TYPES, "evidence record sourceType"),
    ...(optionalString(record.sourceRef) ? { sourceRef: optionalString(record.sourceRef) as string } : {}),
    ...(record.channel === undefined ? {} : { channel: enumValue(record.channel, ["chat", "voice", "tool", "import", "system"] as const, "evidence record channel") }),
    ...(optionalString(record.speakerId) ? { speakerId: optionalString(record.speakerId) as string } : {}),
    subjectIds: stringArray(record.subjectIds, "evidence record subjectIds", { allowEmpty: true }),
    observedAt: isoString(record.observedAt, "evidence record observedAt"),
    ingestedAt: isoString(record.ingestedAt, "evidence record ingestedAt"),
    ...(optionalIsoString(record.windowStart, "evidence record windowStart") ? { windowStart: optionalIsoString(record.windowStart, "evidence record windowStart") as string } : {}),
    ...(optionalIsoString(record.windowEnd, "evidence record windowEnd") ? { windowEnd: optionalIsoString(record.windowEnd, "evidence record windowEnd") as string } : {}),
    ...(optionalString(record.textSummary) ? { textSummary: optionalString(record.textSummary) as string } : {}),
    ...(record.structuredSummary === undefined ? {} : { structuredSummary: jsonValue(record.structuredSummary, "evidence record structuredSummary") }),
    confidence: boundedNumber(record.confidence, "evidence record confidence"),
    sourceReliability: boundedNumber(record.sourceReliability, "evidence record sourceReliability"),
    sensitivity: sensitivityArray(record.sensitivity, "evidence record sensitivity"),
    retention: enumValue(record.retention, ["normal", "short", "long", "redactable"] as const, "evidence record retention"),
    ...(optionalIsoString(record.redactedAt, "evidence record redactedAt") ? { redactedAt: optionalIsoString(record.redactedAt, "evidence record redactedAt") as string } : {}),
  };
}

function parseMemorySalience(raw: unknown): MemorySalience {
  if (raw === undefined) {
    return {
      returnCount: 0,
      recurrenceCount: 0,
      correctionCount: 0,
      reopenedCount: 0,
      unresolved: false,
      sourceEvidenceIds: [],
      sourceRefs: [],
      sourceSlugs: [],
      sourceAliases: [],
      memoryEditIds: [],
      correctionTargets: [],
    };
  }
  const value = objectValue(raw, "memory salience");
  return {
    returnCount: nonNegativeInteger(value.returnCount, "memory salience returnCount"),
    recurrenceCount: nonNegativeInteger(value.recurrenceCount ?? 0, "memory salience recurrenceCount"),
    correctionCount: nonNegativeInteger(value.correctionCount, "memory salience correctionCount"),
    reopenedCount: nonNegativeInteger(value.reopenedCount, "memory salience reopenedCount"),
    unresolved: booleanValue(value.unresolved, "memory salience unresolved"),
    ...(optionalIsoString(value.lastSeen, "memory salience lastSeen") ? { lastSeen: optionalIsoString(value.lastSeen, "memory salience lastSeen") as string } : {}),
    sourceEvidenceIds: stringArray(value.sourceEvidenceIds ?? [], "memory salience sourceEvidenceIds", { allowEmpty: true }),
    sourceRefs: stringArray(value.sourceRefs ?? [], "memory salience sourceRefs", { allowEmpty: true }),
    sourceSlugs: stringArray(value.sourceSlugs ?? [], "memory salience sourceSlugs", { allowEmpty: true }),
    sourceAliases: stringArray(value.sourceAliases ?? [], "memory salience sourceAliases", { allowEmpty: true }),
    memoryEditIds: stringArray(value.memoryEditIds ?? [], "memory salience memoryEditIds", { allowEmpty: true }),
    correctionTargets: stringArray(value.correctionTargets ?? [], "memory salience correctionTargets", { allowEmpty: true }),
  };
}

function parseMemoryPayload(category: MemoryCategory, raw: unknown): MemoryPayload {
  const payload = objectValue(raw, "memory payload");
  const payloadCategory = enumValue(payload.category, MEMORY_CATEGORIES, "memory payload category");
  if (payloadCategory !== category) {
    throw new Error("memory payload category must match record category");
  }
  switch (category) {
    case "event":
      return parseEventPayload(payload);
    case "fact":
      return parseFactPayload(payload);
    case "preference":
      return parsePreferencePayload(payload);
    case "routine":
      return parseRoutinePayload(payload);
    case "person":
      return parsePersonPayload(payload);
    case "relationship":
      return parseRelationshipPayload(payload);
    case "place":
      return parsePlacePayload(payload);
    case "rule":
      return parseRulePayload(payload);
    case "skill":
      return parseSkillPayload(payload);
    case "episodic":
      return parseEpisodicPayload(payload);
  }
}

function parseEventPayload(payload: Record<string, unknown>): EventMemoryPayload {
  const startsAt = optionalIsoString(payload.startsAt, "event memory startsAt");
  const date = optionalDateString(payload.date, "event memory date");
  if (!startsAt && !date) {
    throw new Error("event memory requires startsAt or date");
  }
  return {
    category: "event",
    eventType: requiredString(payload.eventType, "event memory eventType"),
    ...(startsAt ? { startsAt } : {}),
    ...(date ? { date } : {}),
    ...(optionalIsoString(payload.endsAt, "event memory endsAt") ? { endsAt: optionalIsoString(payload.endsAt, "event memory endsAt") as string } : {}),
    subjectIds: stringArray(payload.subjectIds, "event memory subjectIds", { allowEmpty: false }),
    ...(optionalString(payload.location) ? { location: optionalString(payload.location) as string } : {}),
    status: enumValue(payload.status, ["planned", "confirmed", "cancelled", "completed", "unknown"] as const, "event memory status"),
  };
}

function parseFactPayload(payload: Record<string, unknown>): FactMemoryPayload {
  return {
    category: "fact",
    factType: requiredString(payload.factType, "fact memory factType"),
    subjectIds: stringArray(payload.subjectIds, "fact memory subjectIds", { allowEmpty: false }),
    value: jsonValue(payload.value, "fact memory value"),
    scope: enumValue(payload.scope, MEMORY_SCOPES, "fact memory scope"),
    validity: enumValue(payload.validity, ["current", "historical", "uncertain"] as const, "fact memory validity"),
  };
}

function parsePreferencePayload(payload: Record<string, unknown>): PreferenceMemoryPayload {
  return {
    category: "preference",
    preferenceType: requiredString(payload.preferenceType, "preference memory preferenceType"),
    subjectId: requiredString(payload.subjectId, "preference memory subjectId"),
    value: jsonValue(payload.value, "preference memory value"),
    scope: enumValue(payload.scope, MEMORY_SCOPES, "preference memory scope"),
    strength: enumValue(payload.strength, ["weak", "normal", "strong"] as const, "preference memory strength"),
    impact: enumValue(payload.impact, ["low", "medium", "high"] as const, "preference memory impact"),
  };
}

function parseRoutinePayload(payload: Record<string, unknown>): RoutineMemoryPayload {
  return {
    category: "routine",
    routineType: requiredString(payload.routineType, "routine memory routineType"),
    subjectIds: stringArray(payload.subjectIds, "routine memory subjectIds", { allowEmpty: false }),
    schedulePattern: requiredString(payload.schedulePattern, "routine memory schedulePattern"),
    window: requiredString(payload.window, "routine memory window"),
    evidenceSpan: requiredString(payload.evidenceSpan, "routine memory evidenceSpan"),
    sampleCount: positiveInteger(payload.sampleCount, "routine memory sampleCount"),
    eligibleForReasoning: booleanValue(payload.eligibleForReasoning, "routine memory eligibleForReasoning"),
  };
}

function parsePersonPayload(payload: Record<string, unknown>): PersonMemoryPayload {
  return {
    category: "person",
    personId: requiredString(payload.personId, "person memory personId"),
    canonicalName: requiredString(payload.canonicalName, "person memory canonicalName"),
    aliases: stringArray(payload.aliases, "person memory aliases", { allowEmpty: true }),
    voiceIds: stringArray(payload.voiceIds, "person memory voiceIds", { allowEmpty: true }),
    roles: stringArray(payload.roles, "person memory roles", { allowEmpty: true }),
    confidenceByAlias: boundedNumberMap(payload.confidenceByAlias, "person memory confidenceByAlias"),
  };
}

function parseRelationshipPayload(payload: Record<string, unknown>): RelationshipMemoryPayload {
  return {
    category: "relationship",
    fromSubjectId: requiredString(payload.fromSubjectId, "relationship memory fromSubjectId"),
    relationshipType: requiredString(payload.relationshipType, "relationship memory relationshipType"),
    toSubjectId: requiredString(payload.toSubjectId, "relationship memory toSubjectId"),
    direction: enumValue(payload.direction, ["one_way", "mutual"] as const, "relationship memory direction"),
    confidenceBySource: boundedNumberMap(payload.confidenceBySource, "relationship memory confidenceBySource"),
  };
}

function parsePlacePayload(payload: Record<string, unknown>): PlaceMemoryPayload {
  return {
    category: "place",
    placeId: requiredString(payload.placeId, "place memory placeId"),
    canonicalName: requiredString(payload.canonicalName, "place memory canonicalName"),
    aliases: stringArray(payload.aliases, "place memory aliases", { allowEmpty: true }),
    areaRefs: stringArray(payload.areaRefs, "place memory areaRefs", { allowEmpty: true }),
    meaning: requiredString(payload.meaning, "place memory meaning"),
  };
}

function parseRulePayload(payload: Record<string, unknown>): RuleMemoryPayload {
  return {
    category: "rule",
    ruleType: requiredString(payload.ruleType, "rule memory ruleType"),
    scope: enumValue(payload.scope, MEMORY_SCOPES, "rule memory scope"),
    authority: requiredString(payload.authority, "rule memory authority"),
    statement: requiredString(payload.statement, "rule memory statement"),
    enforcementLevel: enumValue(payload.enforcementLevel, ["advisory", "block", "require_confirmation"] as const, "rule memory enforcementLevel"),
  };
}

function parseSkillPayload(payload: Record<string, unknown>): SkillMemoryPayload {
  return {
    category: "skill",
    skillType: requiredString(payload.skillType, "skill memory skillType"),
    instruction: requiredString(payload.instruction, "skill memory instruction"),
    scope: enumValue(payload.scope, MEMORY_SCOPES, "skill memory scope"),
    authority: requiredString(payload.authority, "skill memory authority"),
    examples: stringArray(payload.examples, "skill memory examples", { allowEmpty: true }),
    enforcementLevel: enumValue(payload.enforcementLevel, ["advisory", "prefer", "require"] as const, "skill memory enforcementLevel"),
  };
}

function parseEpisodicPayload(payload: Record<string, unknown>): EpisodicMemoryPayload {
  return {
    category: "episodic",
    episodeType: requiredString(payload.episodeType, "episodic memory episodeType"),
    occurredAt: isoString(payload.occurredAt, "episodic memory occurredAt"),
    subjectIds: stringArray(payload.subjectIds, "episodic memory subjectIds", { allowEmpty: false }),
    outcome: requiredString(payload.outcome, "episodic memory outcome"),
    relatedMemoryIds: stringArray(payload.relatedMemoryIds, "episodic memory relatedMemoryIds", { allowEmpty: true }),
  };
}

function schemaVersionValue(value: unknown, label: string): 1 {
  if (value !== 1) {
    throw new Error(`${label} schemaVersion must be 1`);
  }
  return 1;
}

export function isoString(value: unknown, label: string): string {
  const parsed = requiredString(value, label);
  if (Number.isNaN(Date.parse(parsed))) {
    throw new Error(`${label} must be ISO-like`);
  }
  return parsed;
}

function optionalIsoString(value: unknown, label: string): string | null {
  if (value === undefined) {
    return null;
  }
  return isoString(value, label);
}

function optionalDateString(value: unknown, label: string): string | null {
  if (value === undefined) {
    return null;
  }
  const parsed = requiredString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  return parsed;
}

function boundedNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const parsed = requiredString(value, label);
  if (!allowed.includes(parsed as T)) {
    throw new Error(`${label} is unsupported: ${parsed}`);
  }
  return parsed as T;
}

function enumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  options: { readonly allowEmpty: boolean },
): readonly T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const parsed = value.map((item) => enumValue(item, allowed, label));
  if (!options.allowEmpty && parsed.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (new Set(parsed).size !== parsed.length) {
    throw new Error(`${label} must be unique`);
  }
  return parsed;
}

function stringArray(
  value: unknown,
  label: string,
  options: { readonly allowEmpty: boolean },
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const parsed = value.map((item) => requiredString(item, label));
  if (!options.allowEmpty && parsed.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (new Set(parsed).size !== parsed.length) {
    throw new Error(`${label} must be unique`);
  }
  return parsed;
}

function sensitivityArray(value: unknown, label: string): readonly SensitivityCategory[] {
  const parsed = enumArray(value, SENSITIVITY_CATEGORIES, label, { allowEmpty: false });
  if (parsed.includes("none") && parsed.length > 1) {
    throw new Error(`${label} cannot mix none with sensitive categories`);
  }
  return parsed;
}

function boundedNumberMap(value: unknown, label: string): Readonly<Record<string, number>> {
  const map = objectValue(value, label);
  const entries = Object.entries(map);
  if (entries.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return Object.fromEntries(entries.map(([key, item]) => [requiredString(key, `${label} key`), boundedNumber(item, `${label} ${key}`)]));
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`${label} number must be finite`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonValue(item, label));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        requiredString(key, `${label} key`),
        jsonValue(item, label),
      ]),
    );
  }
  throw new Error(`${label} must be JSON-compatible`);
}
