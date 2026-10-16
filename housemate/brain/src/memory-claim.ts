import { createHash } from "node:crypto";

import { episodicMemoryOccurrenceClaimKey } from "./episodic-memory-identity.js";
import type { MemoryRecord } from "./memory-schema.js";
import { HOUSE_TIME_ZONE } from "./house-config.js";

const CLAIM_HASH_TAG = "memory_claim_sha256:";
const EPISODIC_DAY_SUPPRESSION_TAG = "episodic_day_sha256:";
const DEFAULT_EPISODIC_TIMEZONE = HOUSE_TIME_ZONE;

export function memoryClaimHash(record: MemoryRecord): string | null {
  if (
    record.reviewStatus === "redacted"
    || record.reviewStatus === "deleted"
  ) {
    return storedMemoryClaimHashes(record)[0] ?? null;
  }
  const key = memoryClaimKey(record);
  return key
    ? hashMemoryClaimKey(key)
    : storedMemoryClaimHashes(record)[0] ?? null;
}

export function memoryClaimHashes(record: MemoryRecord): readonly string[] {
  if (
    record.reviewStatus === "redacted"
    || record.reviewStatus === "deleted"
  ) {
    return storedMemoryClaimHashes(record);
  }
  const current = memoryClaimHash(record);
  return current ? [current] : [];
}

export function memoryClaimHashTag(claimKey: string): string {
  return memoryClaimHashTagFromHash(hashMemoryClaimKey(claimKey));
}

export function memoryClaimHashTagFromHash(hash: string): string {
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    throw new Error("memory claim hash must be a SHA-256 hex digest");
  }
  return `${CLAIM_HASH_TAG}${hash.toLowerCase()}`;
}

export function hashMemoryClaimKey(claimKey: string): string {
  return createHash("sha256").update(claimKey, "utf8").digest("hex");
}

export function episodicDaySuppressionTagForRecord(
  record: MemoryRecord,
  timezone = DEFAULT_EPISODIC_TIMEZONE,
): string | null {
  if (
    record.category !== "episodic"
    || record.payload.category !== "episodic"
    || record.reviewStatus === "redacted"
    || record.reviewStatus === "deleted"
  ) {
    return null;
  }
  const ownerId = record.ownerId?.toLowerCase() ?? null;
  const subjectId = (
    record.payload.subjectIds[0]
    ?? record.subjectIds[0]
    ?? null
  )?.toLowerCase() ?? null;
  if (!subjectId || (ownerId && ownerId !== subjectId)) {
    return null;
  }
  return episodicDaySuppressionTagForInstant(
    ownerId ?? subjectId,
    record.payload.occurredAt,
    timezone,
  );
}

export function episodicDaySuppressionTagForInstant(
  actorId: string,
  instant: string,
  timezone = DEFAULT_EPISODIC_TIMEZONE,
): string | null {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime()) || !actorId.trim()) {
    return null;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  const dateKey = `${part("year")}-${part("month")}-${part("day")}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return null;
  }
  const hash = hashMemoryClaimKey(
    `${actorId.trim().toLowerCase()}|episodic_day|${dateKey}`,
  );
  return `${EPISODIC_DAY_SUPPRESSION_TAG}${hash}`;
}

export function storedEpisodicDaySuppressionTags(
  record: MemoryRecord,
): readonly string[] {
  return [...new Set(record.tags.filter((tag) =>
    new RegExp(`^${EPISODIC_DAY_SUPPRESSION_TAG}[a-f0-9]{64}$`, "i")
      .test(tag)
  ).map((tag) => tag.toLowerCase()))];
}

function memoryClaimKey(record: MemoryRecord): string | null {
  if (
    record.category === "fact"
    && record.payload.category === "fact"
    && record.payload.factType === "birth_date"
  ) {
    const subjectId = record.payload.subjectIds[0] ?? record.subjectIds[0];
    return subjectId ? `${subjectId}|fact|birth_date` : null;
  }
  if (record.category === "preference" && record.payload.category === "preference") {
    const additiveHash = record.tags
      .find((tag) => tag.startsWith("preference_value:"))
      ?.slice("preference_value:".length);
    return additiveHash
      ? `${record.payload.subjectId}|preference|${record.payload.preferenceType}|${additiveHash}`
      : `${record.payload.subjectId}|preference|${record.payload.preferenceType}`;
  }
  if (record.category === "episodic" && record.payload.category === "episodic") {
    const subjectId = record.ownerId
      ?? record.payload.subjectIds[0]
      ?? record.subjectIds[0];
    const occurrenceRef = record.provenance?.sourceExperienceIds[0]
      ?? record.id;
    return subjectId
      ? episodicMemoryOccurrenceClaimKey(
          subjectId,
          occurrenceRef,
        )
      : null;
  }
  return null;
}

function storedMemoryClaimHashes(record: MemoryRecord): readonly string[] {
  return [...new Set(record.tags
    .filter((tag) => tag.startsWith(CLAIM_HASH_TAG))
    .map((tag) => tag.slice(CLAIM_HASH_TAG.length))
    .filter((hash) => /^[a-f0-9]{64}$/i.test(hash))
    .map((hash) => hash.toLowerCase()))];
}
