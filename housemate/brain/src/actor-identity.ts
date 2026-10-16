import { householdPerson } from "./household.js";

/**
 * How sure speaker recognition must be before a voice is treated as that household member: their
 * memory, recall, reflection and trusted-actor rights. 0.60 (was 0.80, then
 * 0.70): on a speaker Alex scored 0.61-0.69 and Sam's first turns sit low too, while the
 * household's voices stay far apart (Alex 0.13-0.22 and Sam under 0.20 against the owner's voice).
 */
export const VOICE_TRUST_MIN_CONFIDENCE = 0.6;

export function canonicalHouseholdActorId(
  value: string | null | undefined,
): string | null {
  return householdPerson(value)?.id ?? null;
}
