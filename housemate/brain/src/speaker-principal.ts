import { householdPersonById, householdPersonByName } from "./household.js";
import type { VoiceBrainSpeaker } from "./voice-brain.js";

const PRINCIPAL_CACHE = new WeakMap<VoiceBrainSpeaker, SpeakerPrincipal>();

export type SpeakerIdentitySource = "person_id" | "speaker_name" | "none";
export type SpeakerTrust = "canonical" | "recognized" | "unverified" | "low_confidence" | "guest";

export interface SpeakerPrincipal {
  readonly token: string | null;
  readonly personId: string | null;
  readonly label: string | null;
  readonly identitySource: SpeakerIdentitySource;
  readonly trust: SpeakerTrust;
}

export function isTrustedSpeakerTrust(trust: SpeakerTrust): boolean {
  return trust === "canonical" || trust === "recognized" || trust === "unverified";
}

/**
 * Return the allowlisted canonical household identity used for speaker carry.
 * Recognized display names remain session-only. This is still an admission
 * policy over caller-supplied evidence, not an authentication boundary;
 * context grants no action-target capability.
 */
export function contextCarryPersonId(principal: SpeakerPrincipal): string | null {
  if (principal.trust !== "canonical" || !principal.personId) {
    return null;
  }
  return householdPersonById(principal.personId)?.id ?? null;
}

/** Resolve identity once while preserving the current legacy trust mapping. */
export function resolveSpeakerPrincipal(speaker: VoiceBrainSpeaker): SpeakerPrincipal {
  const cached = PRINCIPAL_CACHE.get(speaker);
  if (cached) {
    return cached;
  }
  // Parsed live requests always carry an explicit transport-authentication
  // result. A caller-supplied household name or person id is identity evidence,
  // not authority: without the Voice Lab token or trusted HA ingress it must
  // remain a guest. `undefined` is retained for source-controlled internal
  // fixtures which predate the transport field and never cross the HTTP edge.
  if (speaker.transportAuthenticated === false) {
    const guest = Object.freeze({
      token: null,
      personId: null,
      label: null,
      identitySource: "none" as const,
      trust: "guest" as const,
    });
    PRINCIPAL_CACHE.set(speaker, guest);
    return guest;
  }
  const voiceId = speaker.voiceId?.trim().toLowerCase() ?? "";
  const speakerName = speaker.name?.trim() ?? "";
  const normalizedName = speakerName.toLowerCase();
  const personId = voiceId.startsWith("person.")
    ? voiceId
    : householdPersonByName(normalizedName)?.id ?? null;
  const identitySource: SpeakerIdentitySource = voiceId.startsWith("person.")
    ? "person_id"
    : personId
      ? "speaker_name"
      : "none";
  const token = (speaker.voiceId ?? speaker.name ?? "").trim().toLowerCase() || null;
  const label = personId ? canonicalLabelForPersonId(personId) : null;
  const principal = Object.freeze({
    token,
    personId,
    label,
    identitySource,
    trust: trustFor(identitySource, speaker.confidence),
  });
  PRINCIPAL_CACHE.set(speaker, principal);
  return principal;
}

function trustFor(source: SpeakerIdentitySource, confidence: number | null): SpeakerTrust {
  if (source === "none") {
    return "guest";
  }
  if (confidence !== null && confidence < 0.5) {
    return "low_confidence";
  }
  if (source === "person_id") {
    return "canonical";
  }
  return confidence === null ? "unverified" : "recognized";
}

export function canonicalHouseholdPersonLabel(personId: string): string | null {
  return householdPersonById(personId)?.name ?? null;
}

function canonicalLabelForPersonId(personId: string): string {
  const trustedLabel = canonicalHouseholdPersonLabel(personId);
  if (trustedLabel) {
    return trustedLabel;
  }
  const slug = personId.split(".").pop() ?? personId;
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/** The verified household speaker's person id, or null. */
export function trustedSpeakerPersonId(request: { readonly speaker: VoiceBrainSpeaker }): string | null {
  const principal = resolveSpeakerPrincipal(request.speaker);
  return isTrustedSpeakerTrust(principal.trust) ? principal.personId : null;
}

/** The verified household speaker's name, or null. */
export function trustedSpeakerLabel(request: { readonly speaker: VoiceBrainSpeaker }): string | null {
  const principal = resolveSpeakerPrincipal(request.speaker);
  return isTrustedSpeakerTrust(principal.trust) ? principal.label : null;
}

/** The household person typing in the Housemate page's Chat tab through Home Assistant's login, else null. */
export function pageChatActorId(request: { readonly channel: string; readonly speaker: VoiceBrainSpeaker }): string | null {
  return request.channel === "chat" && request.speaker.identitySource === "ha_ingress" ? request.speaker.trustedActorId ?? null : null;
}

/** A request with no trusted household speaker. */
export function isGuestSpeakerRequest(request: { readonly speaker: VoiceBrainSpeaker }): boolean {
  return trustedSpeakerPersonId(request) === null;
}
