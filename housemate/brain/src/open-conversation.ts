import { householdRegex } from "./household.js";
import { assistantName, persona, personaLines } from "./persona.js";
/** "Who are you?" answers: the house's persona, its name filled in. */
export function identityIntroductions(): readonly string[] {
  return personaLines(persona().introductions);
}

export function jarvisIdentityIntroduction(random: () => number = Math.random): string {
  const introductions = identityIntroductions();
  const index = Math.min(introductions.length - 1, Math.floor(Math.max(0, random()) * introductions.length));
  return introductions[index] ?? introductions[0] ?? `I'm ${assistantName()}.`;
}

export function deterministicImmediateOpenAnswer(text: string): string | null {
  const deterministic = deterministicImmediateOnlyOpenAnswer(text);
  if (deterministic !== DEFAULT_OPEN_ANSWER) {
    return deterministic;
  }
  return null;
}

function deterministicImmediateOnlyOpenAnswer(text: string): string {
  // Canned answers replace the model, so each must be the whole utterance.
  // A phrase found inside a longer question ("what are you referring to?")
  // is that question, not a request for the canned reply.
  const utterance = wholeUtterance(text);
  if (/^(?:hello|hi|hey|hiya|gday|g day)(?: there)?$/.test(utterance)) {
    return "Hello.";
  }
  if (/^(?:thanks|thank you|cheers|ta)(?: very much| a lot| heaps| for that)?$/.test(utterance)) {
    return "You're welcome.";
  }
  if (/^(?:who|what) (?:are you|exactly are you)(?: exactly| really)?$/.test(utterance)) {
    return jarvisIdentityIntroduction();
  }
  if (/^(?:why are you|you(?:'re| are)) repeating yourself$/.test(utterance)) {
    return "I probably matched the wrong route or reused stale context. I can keep going from the next request.";
  }
  return DEFAULT_OPEN_ANSWER;
}

function wholeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}' ]+/gu, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .replace(householdRegex(String.raw`^(?:(?:well|so|ok|okay|oh|um|uh|and|but|{ASSISTANT})\s+)+`, "u"), "")
    .replace(householdRegex(String.raw`(?:\s+(?:{ASSISTANT}|mate))+$`, "u"), "");
}

const DEFAULT_OPEN_ANSWER = "I can chat a bit, but I will not guess house facts, memories, weather, calendar, or actions.";
