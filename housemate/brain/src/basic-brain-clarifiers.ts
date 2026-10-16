import type {
  PendingClarifierChoice,
  PendingClarifierFrame,
} from "./basic-brain-contracts.js";
import { normalizeSpeechForRouting } from "./speech-normalizer.js";

export type {
  ClarifierQuestionType,
  ClarifierTargetSource,
  PendingClarifierChoice,
  PendingClarifierFrame,
  PendingClarifierFreeform,
} from "./basic-brain-contracts.js";

export function resolvePendingClarifierChoice(normalized: string, frame: PendingClarifierFrame): PendingClarifierChoice | null {
  if (frame.choices.length === 0) {
    return null;
  }
  const replyCore = clarifierReplyCore(normalized);
  if (!replyCore) {
    return null;
  }
  const ordinalIndex = ordinalChoiceIndex(replyCore);
  if (ordinalIndex !== null) {
    return ordinalIndex === Number.MAX_SAFE_INTEGER
      ? (frame.choices[frame.choices.length - 1] ?? null)
      : (frame.choices[ordinalIndex] ?? null);
  }
  const exact = frame.choices.filter((choice) => labelsEquivalent(normalizeClarifierText(choice.label), replyCore)
    || choice.synonyms.some((synonym) => labelsEquivalent(normalizeClarifierText(synonym), replyCore)));
  if (exact.length === 1) {
    return exact[0] ?? null;
  }
  if (exact.length > 1) {
    return null;
  }
  const scores = frame.choices
    .map((choice, index) => ({ choice, index, score: clarifierChoiceScore(replyCore, choice) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  if (scores.length === 0) {
    return null;
  }
  if (scores.length === 1 || scores[0]!.score > scores[1]!.score) {
    return scores[0]!.choice;
  }
  return null;
}

export function looksLikeClarifierReply(normalized: string, frame: PendingClarifierFrame): boolean {
  if (frame.choices.length === 0) {
    return false;
  }
  const replyCore = clarifierReplyCore(normalized);
  if (!replyCore) {
    return false;
  }
  return ordinalChoiceIndex(replyCore) !== null
    || frame.choices.some((choice) => clarifierChoiceScore(replyCore, choice) > 0)
    || /^(?:the )?(?:first|second|third|fourth|fifth|last) (?:one)?$/.test(replyCore)
    || /^(?:this|that) one$/.test(replyCore);
}

export type PendingClarifierRepair =
  | { readonly kind: "choice"; readonly choice: PendingClarifierChoice }
  | { readonly kind: "reissue" };

/**
 * Resolve contrastive repairs such as "I mean the lamp, not the main light".
 * A correction that still denotes multiple choices reissues the ambiguity;
 * excluding one exact choice may select the sole remaining choice.
 */
export function resolvePendingClarifierRepair(
  normalized: string,
  frame: PendingClarifierFrame,
): PendingClarifierRepair | null {
  const contrast = /^(?:(?:no|nah|sorry)\s+)?(?:i (?:mean|meant)\s+|meant\s+|mean\s+)(.+?)\s+not\s+(.+)$/.exec(
    normalizeClarifierText(normalized),
  );
  const retained = contrast?.[1]?.trim() ?? "";
  const excluded = contrast?.[2]?.trim() ?? "";
  if (!retained || !excluded) return null;

  const retainedChoice = resolvePendingClarifierChoice(retained, frame);
  if (retainedChoice) return { kind: "choice", choice: retainedChoice };
  if (!looksLikeClarifierReply(retained, frame)) return null;

  const excludedChoice = resolvePendingClarifierChoice(excluded, frame);
  if (excludedChoice) {
    const remaining = frame.choices.filter((choice) => choice.id !== excludedChoice.id);
    if (remaining.length === 1) return { kind: "choice", choice: remaining[0] as PendingClarifierChoice };
  }
  return { kind: "reissue" };
}

function clarifierChoiceScore(normalized: string, choice: PendingClarifierChoice): number {
  const haystacks = [choice.label, ...choice.synonyms].map(normalizeClarifierText);
  const tokens = meaningfulTokens(normalized);
  if (tokens.length === 0) {
    return 0;
  }
  const choiceTokens = new Set(haystacks.flatMap((haystack) => haystack.split(" ").filter(Boolean)));
  return tokens.every((token) => choiceTokens.has(token)) ? tokens.length : 0;
}

function meaningfulTokens(text: string): readonly string[] {
  const stop = new Set([
    "the", "a", "an", "one", "ones", "option", "choice", "please", "mean", "meant",
    "i", "id", "ill", "want", "wanted", "pick", "choose", "take", "give", "me", "it",
  ]);
  return normalizeClarifierText(text).split(" ").filter((token) => token.length >= 3 && !stop.has(token));
}

function ordinalChoiceIndex(normalized: string): number | null {
  const tokens = normalizeClarifierText(normalized).split(" ").filter(Boolean);
  if (tokens[0] === "the") {
    tokens.shift();
  }
  let explicitCardinal = false;
  if (["number", "option", "choice"].includes(tokens[0] ?? "")) {
    tokens.shift();
    explicitCardinal = true;
  }
  const firstToken = tokens[0] ?? "";
  if (tokens.length > 1 && (["option", "choice"].includes(tokens[tokens.length - 1] ?? "")
    || ((tokens[tokens.length - 1] ?? "") === "one"
      && /^(?:first|second|third|fourth|fifth|last|[1-5](?:st|nd|rd|th))$/.test(firstToken)))) {
    tokens.pop();
  }
  if (tokens.length !== 1) {
    return null;
  }
  const ordinal = tokens[0] ?? "";
  if (!explicitCardinal && /^(?:one|two|three|four|five|[1-5])$/.test(ordinal)) {
    return null;
  }
  const indexes: Readonly<Record<string, number>> = {
    one: 0,
    "1": 0,
    first: 0,
    "1st": 0,
    two: 1,
    "2": 1,
    second: 1,
    "2nd": 1,
    three: 2,
    "3": 2,
    third: 2,
    "3rd": 2,
    four: 3,
    "4": 3,
    fourth: 3,
    "4th": 3,
    five: 4,
    "5": 4,
    fifth: 4,
    "5th": 4,
    last: Number.MAX_SAFE_INTEGER,
  };
  return indexes[ordinal] ?? null;
}

function clarifierReplyCore(value: string): string {
  const tokens = normalizeClarifierText(value).split(" ").filter(Boolean);
  while (tokens.length > 1 && (
    tokens[0] === "please"
    || ["yes", "yep", "yeah", "sure", "okay", "ok"].includes(tokens[0] ?? "")
  )) {
    tokens.shift();
  }
  const selectionPrefixLength = clarifierSelectionPrefixLength(tokens);
  if (selectionPrefixLength > 0) {
    tokens.splice(0, selectionPrefixLength);
  }
  if (["please", "thanks", "mate"].includes(tokens.at(-1) ?? "")) {
    tokens.pop();
  } else if (tokens.at(-2) === "thank" && tokens.at(-1) === "you") {
    tokens.splice(-2, 2);
  }
  return tokens.join(" ");
}

function clarifierSelectionPrefixLength(tokens: readonly string[]): number {
  if ((tokens[0] === "let" && tokens[1] === "s") || tokens[0] === "lets") {
    const offset = tokens[0] === "lets" ? 1 : 2;
    return tokens[offset] === "go" && tokens[offset + 1] === "with" ? offset + 2 : 0;
  }
  if (tokens[0] === "give" && tokens[1] === "me") return 2;
  if (tokens[0] === "make" && tokens[1] === "it") return 2;
  if (tokens[0] === "go" && tokens[1] === "with") return 2;

  let index = 0;
  let modal: "would" | "will" | null = null;
  if (tokens[index] === "id") {
    modal = "would";
    index += 1;
  } else if (tokens[index] === "ill") {
    modal = "will";
    index += 1;
  } else if (tokens[index] === "i" || tokens[index] === "we") {
    index += 1;
    const next = tokens[index] ?? "";
    if (next === "would" || next === "d") {
      modal = "would";
      index += 1;
    } else if (next === "will" || next === "ll") {
      modal = "will";
      index += 1;
    }
  } else {
    return 0;
  }

  if (tokens[index] === "go" && tokens[index + 1] === "with") return index + 2;
  if (modal === "would" && tokens[index] === "like") return index + 1;
  if (modal === "will" && tokens[index] === "take") return index + 1;
  return ["mean", "meant", "want", "wanted", "pick", "choose", "take"].includes(tokens[index] ?? "")
    ? index + 1
    : 0;
}

function normalizeClarifierText(value: string): string {
  return normalizeSpeechForRouting(value, {
    preserveEntityChars: true,
    // "I mean" is evidence in a repair frame, not disposable routing filler.
    preservePragmaticPrefaces: true,
  })
    .replace(/[?.,!]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function labelsEquivalent(left: string, right: string): boolean {
  return left === right || left.replace(/^the /, "") === right.replace(/^the /, "");
}
