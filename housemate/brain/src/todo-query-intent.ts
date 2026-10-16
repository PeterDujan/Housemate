import { normalizeSpeechForRouting } from "./speech-normalizer.js";

export interface TodoQueryIntent {
  readonly kind: "shopping" | "reminders";
  readonly source: "named_list" | "prospective_obligation";
}

/**
 * Pure to-do/list-content grammar. A purchase verb alone is an activity, not
 * evidence that the user is asking for the current shopping list.
 */
export function parseTodoQueryIntent(value: string): TodoQueryIntent | null {
  const normalized = normalizeSpeechForRouting(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || !looksLikeListContentRequest(normalized)) {
    return null;
  }
  if (/^(?:what|which|where|who|how)\b.*\bdid\b/.test(normalized)
    || /^(?:did|was|were|had)\b/.test(normalized)) {
    return null;
  }

  if (/\b(?:shopping list|grocery list|groceries list)\b/.test(normalized)) {
    return {
      kind: "shopping",
      source: "named_list",
    };
  }
  if (/\b(?:reminders?|to do list|todo list|task list|tasks)\b/.test(normalized)) {
    return {
      kind: "reminders",
      source: "named_list",
    };
  }
  if (/\b(?:need|needs) to (?:buy|get|pick up)\b/.test(normalized)) {
    return {
      kind: "shopping",
      source: "prospective_obligation",
    };
  }
  return null;
}

function looksLikeListContentRequest(normalized: string): boolean {
  return /^(?:what|which|show|list|tell|give|read|check|do|does|have|has|are|is)\b/.test(normalized)
    || /\b(?:what|which|anything|any)\b/.test(normalized);
}
