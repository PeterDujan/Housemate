import { VOICE_TRUST_MIN_CONFIDENCE, canonicalHouseholdActorId } from "./actor-identity.js";
import type { MemoryRecord } from "./memory-schema.js";

export interface MemoryRecallAccess {
  readonly actorId: string | null;
  readonly channel: string;
  readonly purpose?: "direct" | "model_context" | "proactive";
  readonly now?: string;
}

export function memoryRecordRecallAllowed(
  record: MemoryRecord,
  access: MemoryRecallAccess,
): boolean {
  if (
    record.reviewStatus !== "accepted"
    || record.contradictionCount > 0
    || (record.expiresAt !== undefined
      && Date.parse(record.expiresAt) <= Date.parse(access.now ?? new Date().toISOString()))
  ) {
    return false;
  }

  const cognitive = record.provenance?.derivation === "cognitive_consolidation"
    || record.tags.includes("cognitive_consolidated");
  const policy = record.recallPolicy;
  if (!policy) {
    return !cognitive;
  }
  if (access.channel !== "chat" && access.channel !== "voice") {
    return false;
  }
  if (!policy.allowedChannels.includes(access.channel)) {
    return false;
  }
  if (access.purpose === "model_context" && !policy.modelContextAllowed) {
    return false;
  }
  if (access.purpose === "proactive" && !policy.proactiveUseAllowed) {
    return false;
  }
  // The household is open: the owner, Sam and Alex hear any memory. Guests none.
  return canonicalHouseholdActorId(access.actorId) !== null;
}

export function canonicalRecallActorId(
  voiceId: string | null | undefined,
  confidence: number | null | undefined,
): string | null {
  if (confidence === null || confidence === undefined || confidence < VOICE_TRUST_MIN_CONFIDENCE) {
    return null;
  }
  return canonicalRecallSubjectId(voiceId);
}

export function canonicalRecallSubjectId(
  voiceId: string | null | undefined,
): string | null {
  return canonicalHouseholdActorId(voiceId);
}
