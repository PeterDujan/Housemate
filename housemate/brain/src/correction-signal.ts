import { householdRegex } from "./household.js";
/**
 * Does this turn tell the assistant he got the last answer wrong?
 *
 * Code only, no model. People mostly correct by restating what they meant
 * ("I didn't ask about the house lights, I asked about the office light"),
 * not by saying "wrong", so both shapes count. A reply to a question the assistant
 * himself just asked is an answer, not a correction; the caller checks that
 * because only it knows the previous reply.
 */

export type CorrectionKind = "explicit" | "restated" | "complaint";

export interface CorrectionSignal {
  readonly kind: CorrectionKind;
  /** What the speaker says they meant, when they said it ("the office light"). */
  readonly correctedText: string | null;
}

const EXPLICIT_PATTERNS: readonly RegExp[] = [
  /^(?:no )?(?:wrong|incorrect)\b/,
  /^(?:no )?(?:that's|that is|thats) (?:wrong|incorrect|not (?:right|correct|true|it)\b)/,
  /^no (?:that's wrong|that is wrong|that should|you (?:misheard|got))\b/,
  /\byou got (?:that|it) wrong\b/,
  /\b(?:not what i said|misheard me|that was wrong)\b/,
];

const RESTATED_PATTERNS: readonly RegExp[] = [
  /^(?:no )?i meant (?!to\b)/,
  /^(?:no )?what i (?:said|asked|meant) was\b/,
  /^no i (?:said|asked|meant)\b/,
  /^(?:no )?i said \S+(?: \S+){0,5} not \S+(?: \S+){0,3}$/,
  /^(?:no )?i (?:didn't|didnt|did not) (?:ask|say|mean)\b(?! to\b)/,
  /^(?:no )?i (?:wasn't|wasnt|was not) (?:talking|asking) about\b/,
];

const COMPLAINT_PATTERNS: readonly RegExp[] = [
  /\byou (?:probably |really |just )?(?:should have|should've|shouldve) (?:just )?(?:understood|known|said|answered|asked|realised|realized)\b/,
  /\bthat's not what i (?:asked|said|meant)\b/,
  /\byou (?:didn't|didnt|did not) (?:answer|understand) (?:my|the|what)\b/,
  /\byou misunderstood\b/,
];

const CORRECTED_TEXT_PATTERNS: readonly RegExp[] = [
  /\bi meant (?!to\b)(.+)$/,
  /\bwhat i (?:said|asked|meant) was (.+)$/,
  /\bi was (?:talking|asking) about (.+?)(?: and you .*| not .*)?$/,
  /\bi (?:only )?(?:asked|said) (?:you )?(?:only )?(?:about |for )?(.+?)(?: not .*)?$/,
];

export function detectCorrection(transcript: string): CorrectionSignal | null {
  const sentences = correctionSentences(transcript);
  const matches = (patterns: readonly RegExp[]): boolean =>
    sentences.some((sentence) => patterns.some((pattern) => pattern.test(sentence)));
  const kind = matches(EXPLICIT_PATTERNS)
    ? "explicit"
    : matches(RESTATED_PATTERNS)
      ? "restated"
      : matches(COMPLAINT_PATTERNS)
        ? "complaint"
        : null;
  if (!kind) {
    return null;
  }
  return { kind, correctedText: correctedTextFrom(sentences) };
}

/** Lower case, straight apostrophes, no punctuation, no leading "hey the assistant" or filler. */
export function normalizeCorrectionText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(householdRegex(String.raw`^(?:hey )?{ASSISTANT}\b ?`), "")
    .replace(/^(?:(?:um|uh|oh|well|okay|ok|yeah|sorry|mate|look) )+/, "")
    .replace(/^nah\b/, "no");
}

function correctionSentences(transcript: string): string[] {
  return transcript
    .split(/[.!?]+/)
    .map(normalizeCorrectionText)
    .filter(Boolean);
}

// The last sentence that restates the question, trimmed; null when there is none.
function correctedTextFrom(sentences: readonly string[]): string | null {
  for (const sentence of [...sentences].reverse()) {
    if (/\bi (?:didn't|didnt|did not) /.test(sentence)) {
      continue;
    }
    for (const pattern of CORRECTED_TEXT_PATTERNS) {
      const text = pattern.exec(sentence)?.[1]?.trim();
      if (text && text.split(" ").length <= 20) {
        return text;
      }
    }
  }
  return null;
}
