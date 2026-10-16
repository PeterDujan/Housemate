import { VOICE_TRUST_MIN_CONFIDENCE, canonicalHouseholdActorId } from "./actor-identity.js";
import type { TurnLogEntry } from "./turn-log.js";

/** The verified household speaker of a logged turn, or null. */
export function trustedSpeakerId(turn: TurnLogEntry): string | null {
  if (
    turn.speakerIdentitySource !== "ha_ingress"
    && turn.speakerIdentitySource !== "api_token"
  ) {
    return null;
  }
  if (
    turn.channel === "voice"
    && (
      turn.speakerConfidence === undefined
      || turn.speakerConfidence === null
      || turn.speakerConfidence < VOICE_TRUST_MIN_CONFIDENCE
    )
  ) {
    return null;
  }
  const trustedId = canonicalHouseholdActorId(turn.speakerTrustedActorId);
  const claimedId = canonicalHouseholdActorId(turn.speakerVoiceId);
  return trustedId && claimedId === trustedId ? trustedId : null;
}

/** True for turns from the real household clients, not probes or evals. */
export function isAdmittedIntakeSource(turn: Pick<TurnLogEntry, "channel" | "sourceVia">): boolean {
  const source = (turn.sourceVia ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (turn.channel === "voice") {
    return source === "linux_voice_loop"
      || source === "windows_voice_app"
      || source === "jarvis_voice_loop";
  }
  return turn.channel === "chat"
    && (source === "ha_sidebar" || source === "jarvis_dashboard_ui");
}
