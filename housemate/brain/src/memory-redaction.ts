import {
  episodicDaySuppressionTagForRecord,
  memoryClaimHashes,
  memoryClaimHashTagFromHash,
} from "./memory-claim.js";
import {
  parseEvidenceRecord,
  parseMemoryRecord,
  type EvidenceRecord,
  type MemoryPayload,
  type MemoryRecord,
} from "./memory-schema.js";

export type MemoryTombstoneStatus = "deleted" | "redacted";

export function redactMemoryTombstone(
  input: MemoryRecord,
  status: MemoryTombstoneStatus,
  decidedAt: string,
): MemoryRecord {
  const memory = parseMemoryRecord(input);
  const claimHashes = memoryClaimHashes(memory);
  const episodicDaySuppressionTag =
    episodicDaySuppressionTagForRecord(memory);
  return parseMemoryRecord({
    id: memory.id,
    schemaVersion: 1,
    category: memory.category,
    tier: "archive",
    scope: "system",
    subjectIds: [status],
    title: `[${status}]`,
    summary: `[${status}]`,
    payload: redactedPayload(memory.payload, status),
    confidence: 0,
    sourceReliability: 0,
    retrievalStrength: 0,
    storageStrength: 1,
    reviewStatus: status,
    sensitivity: ["private"],
    evidenceIds: [...memory.evidenceIds],
    createdAt: memory.createdAt,
    updatedAt: decidedAt,
    evidenceCount: memory.evidenceIds.length,
    contradictionCount: 0,
    supersedesIds: [],
    contradictedByIds: [],
    tags: [
      status,
      ...(episodicDaySuppressionTag
        ? [episodicDaySuppressionTag]
        : []),
      ...claimHashes.map(memoryClaimHashTagFromHash),
    ],
  });
}

export function redactEvidenceTombstone(
  evidence: EvidenceRecord,
  status: MemoryTombstoneStatus,
  decidedAt: string,
): EvidenceRecord {
  return parseEvidenceRecord({
    id: evidence.id,
    schemaVersion: 1,
    sourceType: "system",
    channel: "system",
    subjectIds: [],
    observedAt: evidence.observedAt,
    ingestedAt: evidence.ingestedAt,
    textSummary: `[${status}]`,
    structuredSummary: { [status]: true },
    confidence: 0,
    sourceReliability: 0,
    sensitivity: ["private"],
    retention: "redactable",
    redactedAt: decidedAt,
  });
}

function redactedPayload(
  payload: MemoryPayload,
  status: MemoryTombstoneStatus,
): MemoryPayload {
  const marker = `[${status}]`;
  switch (payload.category) {
    case "event":
      return {
        category: "event",
        eventType: status,
        date: "1970-01-01",
        subjectIds: [status],
        status: "unknown",
      };
    case "fact":
      return {
        category: "fact",
        factType: status,
        subjectIds: [status],
        value: marker,
        scope: "system",
        validity: "historical",
      };
    case "preference":
      return {
        category: "preference",
        preferenceType: status,
        subjectId: status,
        value: marker,
        scope: "system",
        strength: "weak",
        impact: "low",
      };
    case "routine":
      return {
        category: "routine",
        routineType: status,
        subjectIds: [status],
        schedulePattern: marker,
        window: marker,
        evidenceSpan: marker,
        sampleCount: 1,
        eligibleForReasoning: false,
      };
    case "person":
      return {
        category: "person",
        personId: status,
        canonicalName: marker,
        aliases: [],
        voiceIds: [],
        roles: [],
        confidenceByAlias: { [status]: 1 },
      };
    case "relationship":
      return {
        category: "relationship",
        fromSubjectId: status,
        relationshipType: status,
        toSubjectId: status,
        direction: "one_way",
        confidenceBySource: { [status]: 1 },
      };
    case "place":
      return {
        category: "place",
        placeId: status,
        canonicalName: marker,
        aliases: [],
        areaRefs: [],
        meaning: marker,
      };
    case "rule":
      return {
        category: "rule",
        ruleType: status,
        scope: "system",
        authority: status,
        statement: marker,
        enforcementLevel: "advisory",
      };
    case "skill":
      return {
        category: "skill",
        skillType: status,
        instruction: marker,
        scope: "system",
        authority: status,
        examples: [],
        enforcementLevel: "advisory",
      };
    case "episodic":
      return {
        category: "episodic",
        episodeType: status,
        occurredAt: "1970-01-01T00:00:00.000Z",
        subjectIds: [status],
        outcome: marker,
        relatedMemoryIds: [],
      };
  }
}
