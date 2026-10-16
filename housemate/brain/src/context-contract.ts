import type {
  BasicConfidence,
  BasicRoute,
  BasicStatus,
  EntityStatusTargetAcquisition,
} from "./basic-brain-contracts.js";
import type { ContextClaimUse } from "./intent-contract.js";
import type {
  SpeakerIdentitySource,
  SpeakerTrust,
} from "./speaker-principal.js";
import type { VoiceBrainChannel } from "./voice-brain.js";

export type ContextOwner = "focus" | "clarifier" | "answer_trace";

export type ContextDomain =
  | "action"
  | "alarm"
  | "calculation"
  | "calendar"
  | "deferred_watch"
  | "dialogue"
  | "entity_status"
  | "event_log"
  | "house_lights"
  | "house_summary"
  | "knowledge"
  | "metrics"
  | "music"
  | "personal_memory"
  | "system"
  | "weather";

export type ContextStorageScope = "session" | "speaker";
export type ContextSensitivity = "public" | "household" | "personal" | "unknown";
export type ContextPolicyStatus = "legacy_unenforced";
export type ContextVisibility = "internal_only";

/**
 * These are declared read-only context capabilities. Deliberately absent:
 * permission to bind or execute an action target. They become authoritative
 * only after policyStatus moves beyond the legacy adapter.
 */
export type ContextAllowedUse = ContextClaimUse | "clarifier_reply";

export type ContextPayloadSourceProvenance =
  | {
      readonly confidence: "legacy_unverified";
      readonly observedAtMs: null;
      readonly revision: null;
    }
  | {
      readonly confidence: "verified";
      readonly observedAtMs: number;
      readonly revision: string | null;
    };

export type ContextPayloadProvenance =
  | {
      readonly kind: "snapshot";
      readonly source: ContextPayloadSourceProvenance;
    }
  | {
      readonly kind: "reference";
      readonly source: ContextPayloadSourceProvenance;
      readonly revalidateBeforeUse: true;
    };

export interface ContextSource {
  readonly turnId: string;
  readonly turnSequence: number;
  readonly frameOrdinal: number;
  readonly route: BasicRoute;
  readonly status: BasicStatus;
  readonly confidence: BasicConfidence;
  readonly resultId: string | null;
  readonly targetAcquisition: EntityStatusTargetAcquisition | null;
  /** Present only for an explicitly verified entity-status target. */
  readonly targetSourceQuery: string | null;
}

export interface ContextPrincipal {
  readonly personId: string | null;
  readonly label: string | null;
  readonly identitySource: SpeakerIdentitySource;
  readonly trust: SpeakerTrust;
}

export interface ContextTransport {
  readonly channel: VoiceBrainChannel;
  /** Current caller/client provenance; no stronger client identity exists yet. */
  readonly sourceVia: string | null;
  readonly room: string | null;
  readonly sessionId: string | null;
}

export interface ContextEnvelope<TPayload> {
  readonly schemaVersion: 1;
  /** Identity of this immutable storage record. */
  readonly envelopeId: string;
  /** Identity of the logical frame shared by its scoped storage copies. */
  readonly frameId: string;
  readonly domain: ContextDomain;
  readonly owner: ContextOwner;
  readonly source: ContextSource;
  readonly principal: ContextPrincipal;
  readonly transport: ContextTransport;
  /** Logical source-turn time retained for legacy TTL parity. */
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly sensitivity: ContextSensitivity;
  /** Where this compatibility copy is stored, not permission to carry it. */
  readonly storageScope: ContextStorageScope;
  readonly policyStatus: ContextPolicyStatus;
  readonly visibility: ContextVisibility;
  readonly allowedUses: readonly ContextAllowedUse[];
  readonly payloadProvenance: ContextPayloadProvenance;
  readonly payload: TPayload;
}

export type ContextEnvelopeInput<TPayload> = Omit<ContextEnvelope<TPayload>, "schemaVersion">;

const VALID_CONTEXT_USES: ReadonlySet<string> = new Set<ContextAllowedUse>([
  "read_followup",
  "refocus",
  "clarifier_reply",
  "repeat",
  "explain",
]);

/**
 * Snapshot the payload and freeze the complete envelope. Callers cannot mutate
 * committed context through either their original object or the legacy view.
 */
export function createContextEnvelope<TPayload>(
  input: ContextEnvelopeInput<TPayload>,
): ContextEnvelope<TPayload> {
  if (!input.envelopeId.trim()) {
    throw new Error("context envelopeId is required");
  }
  if (!input.frameId.trim()) {
    throw new Error("context frameId is required");
  }
  if (!input.source.turnId.trim()) {
    throw new Error("context source turnId is required");
  }
  if (!Number.isSafeInteger(input.source.turnSequence) || input.source.turnSequence < 1) {
    throw new Error("context turnSequence must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.source.frameOrdinal) || input.source.frameOrdinal < 0) {
    throw new Error("context frameOrdinal must be a non-negative safe integer");
  }
  const targetSourceQuery = input.source.targetSourceQuery?.trim() ?? "";
  if (input.source.targetAcquisition === "explicit" && !targetSourceQuery) {
    throw new Error("explicit context target requires a source query");
  }
  if (input.source.targetAcquisition !== "explicit" && input.source.targetSourceQuery !== null) {
    throw new Error("non-explicit context target cannot carry a source query");
  }
  if (!Number.isFinite(input.createdAtMs) || !Number.isFinite(input.expiresAtMs)) {
    throw new Error("context timestamps must be finite");
  }
  if (input.expiresAtMs < input.createdAtMs) {
    throw new Error("context expiry cannot precede creation");
  }
  if (input.allowedUses.length === 0) {
    throw new Error("context allowedUses cannot be empty");
  }
  if (input.allowedUses.some((use) => !VALID_CONTEXT_USES.has(use))) {
    throw new Error("context allowedUses contains an unsupported capability");
  }
  validateContextPrincipal(input.principal);
  if (input.policyStatus !== "legacy_unenforced") {
    throw new Error("context policyStatus is invalid");
  }
  if (input.visibility !== "internal_only") {
    throw new Error("context visibility is invalid");
  }

  return Object.freeze({
    ...input,
    schemaVersion: 1 as const,
    source: Object.freeze({ ...input.source }),
    principal: Object.freeze({ ...input.principal }),
    transport: Object.freeze({ ...input.transport }),
    allowedUses: Object.freeze([...new Set(input.allowedUses)]),
    payloadProvenance: cloneAndFreeze(input.payloadProvenance),
    payload: cloneAndFreeze(input.payload),
  });
}

function cloneAndFreeze<T>(value: T): T {
  assertPlainContextData(value);
  return deepFreeze(structuredClone(value));
}

function validateContextPrincipal(principal: ContextPrincipal): void {
  if (principal.identitySource === "none") {
    if (principal.personId !== null || principal.label !== null || principal.trust !== "guest") {
      throw new Error("context guest principal metadata is incoherent");
    }
    return;
  }
  if (!principal.personId || !principal.label) {
    throw new Error("context identified principal requires canonical person metadata");
  }
  if (principal.identitySource === "person_id"
    && principal.trust !== "canonical"
    && principal.trust !== "low_confidence") {
    throw new Error("context person-id principal trust is incoherent");
  }
  if (principal.identitySource === "speaker_name"
    && principal.trust !== "recognized"
    && principal.trust !== "unverified"
    && principal.trust !== "low_confidence") {
    throw new Error("context speaker-name principal trust is incoherent");
  }
}

function assertPlainContextData(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return;
  }
  if (typeof value !== "object") {
    throw new Error("context payload metadata must contain plain cloneable data");
  }
  const objectValue = value as object;
  if (seen.has(objectValue)) {
    throw new Error("context payload metadata must not be cyclic");
  }
  seen.add(objectValue);
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("context payload metadata must contain plain cloneable data");
    }
  }
  for (const key of Reflect.ownKeys(objectValue)) {
    if (typeof key !== "string") {
      throw new Error("context payload metadata must use string keys");
    }
    assertPlainContextData((value as Record<string, unknown>)[key], seen);
  }
  seen.delete(objectValue);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const objectValue = value as object;
  if (seen.has(objectValue)) {
    return value;
  }
  seen.add(objectValue);
  const record = value as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(objectValue)) {
    deepFreeze(record[key], seen);
  }
  return Object.freeze(value);
}
