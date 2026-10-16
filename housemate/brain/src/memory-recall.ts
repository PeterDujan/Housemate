import type { MemoryRecord } from "./memory-schema.js";
import { isTrustedSpeakerTrust, resolveSpeakerPrincipal } from "./speaker-principal.js";
import type { VoiceBrainRequest } from "./voice-brain.js";
import { displayPersonName, householdRegex } from "./household.js";

export function memoryPlainText(record: MemoryRecord): string {
  if (record.category === "preference" && record.payload.category === "preference") {
    const subject = displaySubject(record.payload.subjectId);
    const preference = displayPreferenceType(record.payload.preferenceType);
    const value = displayMemoryValue(record.payload.value);
    if (/^(?:does not care|no preference|doesn't care)$/i.test(value)) {
      return `${subject} has no strong preference about ${preference}.`;
    }
    if (record.payload.preferenceType === "outdoor_clothing" && isJsonObject(record.payload.value)) {
      const garment = String(record.payload.value.garment ?? "extra layers");
      const threshold = typeof record.payload.value.threshold_c === "number" ? record.payload.value.threshold_c : null;
      return threshold === null
        ? `${subject} tends to wear ${garment} outdoors.`
        : `${subject} tends to wear ${garment} when it is ${threshold} C or below.`;
    }
    const naturalClause = preferenceValueClause(value);
    if (naturalClause) {
      return `${subject} ${naturalClause}.`;
    }
    const indirectClause = indirectPreferenceValueSentence(subject, value);
    if (indirectClause) {
      return indirectClause;
    }
    return `${subject} prefers ${value}.`;
  }
  return record.summary.endsWith(".") ? record.summary : `${record.summary}.`;
}

export function displaySubject(subjectId: string): string {
  return displayPersonName(subjectId);
}

function displayPreferenceType(value: string): string {
  return value.replaceAll("_", " ");
}

function displayMemoryValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value)
      .map(([key, child]) => `${displayPreferenceType(key)} ${String(child)}`)
      .join(", ");
  }
  return "that";
}

function preferenceValueClause(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return null;
  }
  const withoutSubject = normalized.replace(householdRegex(String.raw`^{NAMES}\s+`, "i"), "");
  const cleaned = withoutSubject.replace(/\.$/, "");
  if (/^(?:likes?|loves?|hates?|prefers?|enjoys?|needs?|wants?|wears?|uses?|usually|often|sometimes|rarely|does not|doesn't|is|has|feels?|tends)\b/i.test(cleaned)) {
    return cleaned;
  }
  return null;
}

function indirectPreferenceValueSentence(subject: string, value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, " ").replace(/\.$/, "");
  const helpsMatch = /^(.*?)\s+helps\s+(?:her|him|them)\s+(.+)$/i.exec(normalized);
  if (helpsMatch) {
    const cause = sentenceStart(helpsMatch[1] ?? "");
    const effect = helpsMatch[2] ?? "";
    return `${cause} helps ${subject} ${effect}.`;
  }
  if (/\bfeels annoying$/i.test(normalized)) {
    return `${sentenceStart(normalized)} to ${subject}.`;
  }
  return null;
}

function sentenceStart(value: string): string {
  const trimmed = value.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function isJsonObject(value: unknown): value is { readonly [key: string]: unknown } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** True when the memory subject is the verified speaker (by person id or name). */
export function subjectMatchesSpeaker(subjectId: string, request: Pick<VoiceBrainRequest, "speaker">): boolean {
  const principal = resolveSpeakerPrincipal(request.speaker);
  if (!isTrustedSpeakerTrust(principal.trust)) return false;
  if (principal.personId && subjectId.toLowerCase() === principal.personId.toLowerCase()) return true;
  return Boolean(principal.label && displaySubject(subjectId).toLowerCase() === principal.label.toLowerCase());
}
