import { TextMemo } from "./text-memo.js";

export interface SpeechNormalizeOptions {
  readonly preserveEntityChars?: boolean;
  readonly preserveMathChars?: boolean;
  readonly preserveMeasurementChars?: boolean;
  readonly preservePragmaticPrefaces?: boolean;
}

// One cache per option combination, keyed by the raw text itself.
const speechMemos = Array.from({ length: 16 }, () => new TextMemo());

export function normalizeSpeechForRouting(value: string, options: SpeechNormalizeOptions = {}): string {
  const memo = speechMemos[
    (options.preserveEntityChars ? 1 : 0)
    | (options.preserveMathChars ? 2 : 0)
    | (options.preserveMeasurementChars ? 4 : 0)
    | (options.preservePragmaticPrefaces ? 8 : 0)
  ] as TextMemo;
  return memo.get(value) ?? memo.set(value, normalizeSpeech(value, options));
}

/** Lower case with every run of other characters one space: the key for names, aliases and catalogue words. */
export function normalizeWords(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
}

function normalizeSpeech(value: string, options: SpeechNormalizeOptions): string {
  const allowedPattern = options.preserveEntityChars && options.preserveMathChars
    ? /[^a-z0-9._:%+*/^()×÷−°℃℉µμ²³-]+/g
    : options.preserveEntityChars && options.preserveMeasurementChars
      ? /[^a-z0-9._:%/^°℃℉µμ²³]+/g
    : options.preserveEntityChars
      ? /[^a-z0-9._:]+/g
      : options.preserveMathChars
        ? /[^a-z0-9:%+*/^()×÷−°℃℉µμ²³-]+/g
        : options.preserveMeasurementChars
          ? /[^a-z0-9:%/^°℃℉µμ²³]+/g
        : /[^a-z0-9:]+/g;
  const normalized = value
    .toLowerCase()
    .replace(/(^|[\s(])[-−]\s*(?=\d)/g, "$1minus ")
    .replaceAll(allowedPattern, " ")
    .trim()
    .replaceAll(/\s+/g, " ");
  return stripSpeechNoise(normalized, options.preservePragmaticPrefaces
    ? { preservePragmaticPrefaces: true }
    : {});
}

export function stripSpeechNoise(
  normalized: string,
  options: { readonly preservePragmaticPrefaces?: boolean } = {},
): string {
  const tokens = normalized.split(" ");
  const withoutFillers = tokens
    .filter((token, index) => token && (
      !SPEECH_FILLER_TOKENS.has(token)
      || isMeasurementUnitAt(tokens, index)
    ))
    .join(" ");
  const withoutPreface = options.preservePragmaticPrefaces
    ? withoutFillers
    : stripLeadingPragmaticPrefaces(withoutFillers);
  return stripProfanityIntensifiers(withoutPreface);
}

/** `mm` is a hesitation on its own, but after a magnitude it is a unit. */
function isMeasurementUnitAt(tokens: readonly string[], index: number): boolean {
  if (tokens[index] !== "mm" || index === 0) return false;
  const previous = tokens[index - 1] ?? "";
  return /^\d+(?:\.\d+)?$/.test(previous)
    || SPOKEN_NUMBER_MAGNITUDE_TOKENS.has(previous);
}

const SPOKEN_NUMBER_MAGNITUDE_TOKENS = new Set([
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
  "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
  "hundred", "thousand", "million", "billion",
]);

function stripLeadingPragmaticPrefaces(normalized: string): string {
  let text = normalized;
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of LEADING_EMOTIONAL_IDIOM_PATTERNS) {
      const match = pattern.exec(text);
      const remainder = match?.[1]?.trim();
      if (remainder !== undefined && (!remainder || isRoutingStart(remainder) || startsWithDiscourseMarker(remainder))) {
        text = remainder;
        changed = true;
        break;
      }
    }
    if (changed) {
      continue;
    }
    for (const marker of LEADING_DISCOURSE_MARKERS) {
      if (text === marker) {
        return marker === "quick question" ? marker : "";
      }
      if (!text.startsWith(`${marker} `)) {
        continue;
      }
      const remainder = text.slice(marker.length + 1).trim();
      if (isRoutingStart(remainder) || startsWithDiscourseMarker(remainder)) {
        text = remainder;
        changed = true;
        break;
      }
    }
  }
  return text;
}

function startsWithDiscourseMarker(text: string): boolean {
  return LEADING_DISCOURSE_MARKERS.some((marker) => text === marker || text.startsWith(`${marker} `));
}

function isRoutingStart(text: string): boolean {
  return ROUTING_STARTERS.some((starter) => text === starter || text.startsWith(`${starter} `));
}

function stripProfanityIntensifiers(normalized: string): string {
  let text = normalized;
  text = text.replaceAll(/\b(what|where|when|who|why|how)\s+(?:the\s+)?fucks\s+(?=(?:the|my|our|your|his|her|their)\b)/g, "$1 s ");
  text = text.replaceAll(/\b(what|where|when|who|why|how)\s+(?:the\s+)?(?:fuck|fucking|hell|heck)\s+(is|are|was|were|do|does|did|can|could|should|would|will)\b/g, "$1 $2");
  text = text.replaceAll(/\bhow\s+(?:the\s+)?(?:fuck|fucks|fucking|hell|heck)\s+(much|many|long|far|hot|cold)\b/g, "how $1");
  text = text.replaceAll(/\b(?:bloody|fucking|frigging|fricking)\s+(?=(?:house|office|lights?|power|energy|weather|time|temperature|rain|wind|solar|grid|battery|status|door|lock|outlet|sensor)\b)/g, "");
  return text.trim().replaceAll(/\s+/g, " ");
}

export const SPEECH_FILLER_TOKENS: ReadonlySet<string> = new Set([
  "ah",
  "ahh",
  "ahhh",
  "er",
  "erm",
  "hm",
  "hmm",
  "hmmm",
  "mm",
  "mmm",
  "uh",
  "uhh",
  "uhhh",
  "um",
  "umm",
  "ummm",
]);

const LEADING_DISCOURSE_MARKERS = [
  "all right",
  "alright",
  "anyway",
  "can i ask",
  "do me a favor",
  "do me a favour",
  "hear me out",
  "hey",
  "i mean",
  "i guess",
  "listen to me",
  "listen",
  "look here",
  "look",
  "mate",
  "nah",
  "no yeah",
  "now",
  "okay",
  "ok",
  "oi",
  "quick question",
  "right",
  "see",
  "so",
  "well",
  "yeah nah",
  "yeah no",
  "yeah",
];

const LEADING_EMOTIONAL_IDIOM_PATTERNS = [
  /^(?:stone|stiffen|starve)\s+(?:the\s+)?(?:(?:bloody|flaming|flamin)\s+)?crows(?:\s+(.+))?$/,
  /^(?:bloody\s+hell|bugger\s+me|cor\s+blimey|crikey|cripes|for\s+fuck\s+sake|for\s+fucks\s+sake|good\s+grief|hells\s+bells|holy\s+shit|jesus\s+christ|my\s+god|oh\s+my\s+god|strewth|struth)(?:\s+(.+))?$/,
];

const ROUTING_STARTERS = [
  "any",
  "are",
  "bring",
  "can",
  "check",
  "could",
  "did",
  "do",
  "does",
  "give",
  "has",
  "have",
  "how",
  "i",
  "is",
  "should",
  "show",
  "status",
  "switch",
  "that",
  "take",
  "tell",
  "the",
  "turn",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "would",
];
