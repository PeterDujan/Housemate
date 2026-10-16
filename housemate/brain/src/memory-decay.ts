import {
  parseMemoryRecord,
  type MemoryCategory,
  type MemoryRecord,
  type MemoryTier,
} from "./memory-schema.js";

export interface MemoryDecayOptions {
  readonly now: string;
}

export interface MemoryContradictionOptions {
  readonly contradictedById: string;
  readonly now: string;
}
const TERMINAL_REVIEW_STATUSES = new Set(["deleted", "redacted", "rejected"]);

const TIER_HALF_LIFE_DAYS: Readonly<Record<MemoryTier, number>> = {
  short: 7,
  medium: 60,
  long: 365,
  archive: 730,
};

export function applyMemoryDecay(record: MemoryRecord, options: MemoryDecayOptions): MemoryRecord {
  if (TERMINAL_REVIEW_STATUSES.has(record.reviewStatus)) {
    return record;
  }

  const now = parseTime(options.now);
  const anchor = mostRecentTime([
    record.lastConfirmedAt,
    record.lastUsedAt,
    record.lastRetrievedAt,
    record.updatedAt,
    record.createdAt,
  ]);
  const ageDays = Math.max(0, (now - anchor) / 86_400_000);
  const halfLife = TIER_HALF_LIFE_DAYS[record.tier] * categoryDurabilityMultiplier(record.category);
  const unsupportedPenalty = supportScore(record) < 0.5 ? 0.65 : 1;
  const contradictionPenalty = record.contradictionCount > 0 ? 0.58 : 1;
  const retrievalFloor = durableRecord(record) ? 0.35 : 0.04;
  const storageFloor = durableRecord(record) ? 0.45 : 0.06;

  let retrievalStrength = decayTowardFloor(record.retrievalStrength, retrievalFloor, ageDays, halfLife);
  let storageStrength = decayTowardFloor(record.storageStrength, storageFloor, ageDays, halfLife * 1.7);
  let confidence = decayTowardFloor(record.confidence, 0.35, ageDays, halfLife * 2.4);

  retrievalStrength = clamp01(retrievalStrength * unsupportedPenalty * contradictionPenalty);
  storageStrength = clamp01(storageStrength * Math.max(unsupportedPenalty, 0.75) * contradictionPenalty);
  confidence = clamp01(confidence * Math.max(contradictionPenalty, 0.72));

  const expiresAt = record.expiresAt ? parseTime(record.expiresAt) : null;
  const expired = expiresAt !== null && expiresAt <= now;
  const tier = nextTier(record, { confidence, storageStrength, retrievalStrength, expired, ageDays });
  const reviewStatus = record.contradictionCount > 0 && record.reviewStatus === "accepted"
    ? "needs_clarification"
    : record.reviewStatus;

  return parseMemoryRecord({
    ...record,
    tier,
    confidence: roundScore(confidence),
    retrievalStrength: roundScore(retrievalStrength),
    storageStrength: roundScore(storageStrength),
    reviewStatus,
    updatedAt: options.now,
    ...(expired && !record.staleAfter ? { staleAfter: options.now } : {}),
  });
}

export function markMemoryContradicted(
  record: MemoryRecord,
  options: MemoryContradictionOptions,
): MemoryRecord {
  const contradictedByIds = Array.from(new Set([...record.contradictedByIds, options.contradictedById]));
  return parseMemoryRecord({
    ...record,
    tier: record.tier === "long" ? "medium" : record.tier,
    reviewStatus: record.reviewStatus === "deleted" || record.reviewStatus === "redacted"
      ? record.reviewStatus
      : "needs_clarification",
    confidence: roundScore(record.confidence * 0.72),
    retrievalStrength: roundScore(record.retrievalStrength * 0.45),
    storageStrength: roundScore(record.storageStrength * 0.7),
    contradictionCount: Math.max(record.contradictionCount + 1, contradictedByIds.length),
    contradictedByIds,
    reviewAfter: options.now,
    updatedAt: options.now,
  });
}

function nextTier(
  record: MemoryRecord,
  scores: {
    readonly confidence: number;
    readonly storageStrength: number;
    readonly retrievalStrength: number;
    readonly expired: boolean;
    readonly ageDays: number;
  },
): MemoryTier {
  if (record.tier === "archive") {
    return "archive";
  }
  if (scores.expired) {
    return "archive";
  }
  if (record.contradictionCount > 0) {
    return record.tier === "long" ? "medium" : record.tier;
  }
  if (canPromoteToLong(record, scores)) {
    return "long";
  }
  if (record.tier === "long" && (scores.confidence < 0.5 || scores.storageStrength < 0.45)) {
    return "medium";
  }
  if (record.tier === "short" && scores.ageDays > 21 && scores.retrievalStrength < 0.25) {
    return "archive";
  }
  if (
    record.tier === "medium" &&
    scores.ageDays > 180 &&
    scores.retrievalStrength < 0.15 &&
    scores.storageStrength < 0.22
  ) {
    return "archive";
  }
  return record.tier;
}

function canPromoteToLong(
  record: MemoryRecord,
  scores: {
    readonly confidence: number;
    readonly storageStrength: number;
  },
): boolean {
  return record.tier !== "long"
    && record.reviewStatus === "accepted"
    && record.contradictionCount === 0
    && record.evidenceIds.length > 0
    && scores.confidence >= 0.74
    && scores.storageStrength >= 0.74
    && (record.evidenceCount >= 2 || record.sourceReliability >= 0.9);
}

function supportScore(record: MemoryRecord): number {
  const evidenceScore = Math.min(1, record.evidenceCount / 3);
  return clamp01(evidenceScore * 0.45 + record.sourceReliability * 0.35 + record.confidence * 0.2);
}

function durableRecord(record: MemoryRecord): boolean {
  return record.tier === "long"
    || record.category === "rule"
    || record.category === "skill"
    || record.category === "person"
    || record.category === "relationship";
}

function categoryDurabilityMultiplier(category: MemoryCategory): number {
  switch (category) {
    case "rule":
    case "skill":
      return 3;
    case "person":
    case "relationship":
    case "place":
      return 2;
    case "routine":
      return 1.6;
    case "event":
      return 0.75;
    default:
      return 1;
  }
}

function decayTowardFloor(value: number, floor: number, ageDays: number, halfLifeDays: number): number {
  const ageFactor = 0.5 ** (ageDays / halfLifeDays);
  if (value >= floor) {
    return floor + (value - floor) * ageFactor;
  }
  return value * ageFactor;
}

function parseTime(value: string): number {
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    throw new Error(`invalid memory time: ${value}`);
  }
  return time;
}

function mostRecentTime(values: readonly (string | undefined)[]): number {
  return Math.max(...values.filter((value): value is string => Boolean(value)).map(parseTime));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function roundScore(value: number): number {
  return Math.round(clamp01(value) * 1_000) / 1_000;
}
