import { stripSpokenDiscourseLabels } from "./housemate-personality.js";
import type { SpeechTone } from "./speech-tone.js";

export type ProgressiveSpeechSegmentKind = "bridge" | "answer" | "fallback";
export type ProgressiveSpeechCommitPolicy = "source_verified" | "bounded_chat" | "final_verified";

export interface ProgressiveSpeechSegment {
  readonly sequence: number;
  readonly text: string;
  readonly kind: ProgressiveSpeechSegmentKind;
  readonly commitPolicy: ProgressiveSpeechCommitPolicy;
  /** Code-picked tone; absent means neutral. */
  readonly tone?: SpeechTone;
  /** Open chat only: the same words with vetted inline Fish delivery tags; TTS input, never display text. */
  readonly markup?: string;
  readonly source: {
    readonly kind: "wikipedia" | "codex" | "claude" | "software";
    readonly label: string;
    readonly url?: string;
  };
}

export interface ProgressiveSpeechSink {
  readonly signal: AbortSignal;
  emit(input: Omit<ProgressiveSpeechSegment, "sequence">): ProgressiveSpeechSegment | null;
  snapshot(): readonly ProgressiveSpeechSegment[];
  combinedText(): string;
  remainingWords(): number;
}

export class ProgressiveSpeechSession implements ProgressiveSpeechSink {
  readonly signal: AbortSignal;
  private readonly onSegment: (segment: ProgressiveSpeechSegment) => void;
  private readonly maxWords: number;
  private readonly segments: ProgressiveSpeechSegment[] = [];

  constructor(options: {
    readonly signal: AbortSignal;
    readonly onSegment: (segment: ProgressiveSpeechSegment) => void;
    readonly maxWords?: number;
  }) {
    this.signal = options.signal;
    this.onSegment = options.onSegment;
    this.maxWords = Math.max(1, Math.min(100, options.maxWords ?? 100));
  }

  emit(input: Omit<ProgressiveSpeechSegment, "sequence">): ProgressiveSpeechSegment | null {
    if (this.signal.aborted) {
      return null;
    }
    const text = normalizeCompleteSegment(input.text);
    if (!text) {
      return null;
    }
    const words = wordCount(text);
    if (words < 1 || words > 36 || words > this.remainingWords()) {
      return null;
    }
    if (this.isDuplicate(text)) {
      return null;
    }
    const segment: ProgressiveSpeechSegment = {
      ...input,
      sequence: this.segments.length + 1,
      text,
    };
    try {
      this.onSegment(segment);
    } catch {
      return null;
    }
    this.segments.push(segment);
    return segment;
  }

  snapshot(): readonly ProgressiveSpeechSegment[] {
    return [...this.segments];
  }

  combinedText(): string {
    return this.segments.map((segment) => segment.text).join(" ").trim();
  }

  remainingWords(): number {
    return Math.max(
      0,
      this.maxWords - this.segments.reduce((total, segment) => total + wordCount(segment.text), 0),
    );
  }

  private isDuplicate(text: string): boolean {
    const candidate = comparisonText(text);
    return this.segments.some((segment) => {
      const existing = comparisonText(segment.text);
      return candidate === existing
        || (candidate.length >= 24 && existing.includes(candidate))
        || (existing.length >= 24 && candidate.includes(existing));
    });
  }
}

/** The assistant's one code-owned line while a lookup runs: chat tools, web search, the read agent. */
export const LOOKUP_HOLDING_LINE = "Let me check.";

/** While he studies the owner's project notes. */
export const PROJECT_STUDY_LINE = "Give me a moment to study what's there.";

/** The code-owned holding lines; the model saying one again is never spoken twice. */
export const HOLDING_LINES: ReadonlySet<string> = new Set([LOOKUP_HOLDING_LINE, PROJECT_STUDY_LINE]);

/** Speaks a holding line as a bridge; false when the stream refused it. */
export function emitLookupHoldingLine(sink: ProgressiveSpeechSink, line: string = LOOKUP_HOLDING_LINE): boolean {
  return Boolean(sink.emit({
    text: line,
    kind: "bridge",
    commitPolicy: "bounded_chat",
    source: { kind: "software", label: "lookup holding line" },
  }));
}

export function emitProgressiveText(
  sink: ProgressiveSpeechSink | undefined,
  text: string,
  options: {
    readonly kind: ProgressiveSpeechSegmentKind;
    readonly commitPolicy: ProgressiveSpeechCommitPolicy;
    readonly source: ProgressiveSpeechSegment["source"];
    readonly tone?: SpeechTone;
  },
): readonly ProgressiveSpeechSegment[] {
  if (!sink) {
    return [];
  }
  const emitted: ProgressiveSpeechSegment[] = [];
  for (const part of completeSpeechSegments(text)) {
    const segment = sink.emit({
      text: part,
      kind: options.kind,
      commitPolicy: options.commitPolicy,
      ...(options.tone ? { tone: options.tone } : {}),
      source: options.source,
    });
    if (segment) {
      emitted.push(segment);
    }
  }
  return emitted;
}

export function completeSpeechSegments(text: string): readonly string[] {
  return sourceSentences(cleanSpeechText(text)).flatMap((sentence) => splitLongCompleteSentence(sentence));
}

/**
 * Splits plain model output exactly as the streaming parser commits it:
 * discourse labels stripped, and a sentence that is unsafe or unfinished is
 * rejected rather than spoken, matching the segment-JSON contract.
 */
export function completeModelTextSegments(text: string): readonly string[] {
  return sourceSentences(cleanSpeechText(text)).flatMap((sentence) => modelSentenceSegments(sentence));
}

/**
 * Commits plain streamed model text one sentence at a time. The newest
 * sentence is held back until a following sentence has begun, because its
 * boundary and any long-sentence split can still change while it grows. The
 * caller must still compare the committed prefix with
 * completeModelTextSegments(finalText).
 */
export class ProgressiveTextSentenceParser {
  private raw = "";
  private committedSentences = 0;

  push(delta: string): readonly string[] {
    if (!delta) {
      return [];
    }
    this.raw += delta;
    if (Buffer.byteLength(this.raw, "utf8") > 128 * 1024) {
      throw new Error("progressive model output exceeded its byte limit");
    }
    const sentences = sourceSentences(cleanSpeechText(this.raw));
    const stable = sentences.slice(this.committedSentences, -1);
    this.committedSentences += stable.length;
    return stable.flatMap((sentence) => modelSentenceSegments(sentence));
  }

  /**
   * The model's text block ended (for example before a lookup), so a held-back
   * sentence that already ends in terminal punctuation is final: commit it now
   * rather than waiting for text that may only arrive after the lookup.
   */
  flush(): readonly string[] {
    const sentences = sourceSentences(cleanSpeechText(this.raw));
    const pending = sentences.slice(this.committedSentences);
    const last = pending.at(-1);
    const complete = last && /[.!?]["'”’)\]]*$/u.test(last) ? pending : pending.slice(0, -1);
    this.committedSentences += complete.length;
    return complete.flatMap((sentence) => modelSentenceSegments(sentence));
  }
}

function modelSentenceSegments(sentence: string): readonly string[] {
  const segments = completeModelSpeechSegments(sentence);
  if (segments.length === 0) {
    throw new Error("progressive model segment was empty or incomplete");
  }
  return segments;
}

/**
 * Links are never spoken. A web answer's trailing "Sources:" list is dropped
 * from its heading on; markdown links keep their words; bare URLs vanish.
 * Each rule only removes text at or after its match, so a committed sentence
 * prefix stays stable while the stream grows.
 */
export function stripSpokenLinks(text: string): string {
  return String(text ?? "")
    .replace(/(?:^|\n)[ \t]*(?:[#>*_-][ \t#*_]*)?Sources?[ \t*_]*(?::|(?=\n|$))[\s\S]*$/iu, "")
    .replaceAll(/\[([^\]\n]{1,200})\]\([^)\s]{0,2000}\)?/gu, "$1")
    .replaceAll(/\(?\bhttps?:\/\/[^\s)]*\)?/giu, "")
    .replaceAll(/[ \t]+([.,;:!?])/gu, "$1");
}

function cleanSpeechText(text: string): string {
  return stripSpokenLinks(String(text ?? ""))
    .replaceAll(/[\r\n\t]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

export function progressiveSegmentsSchema(maxSegments = 8) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      segments: {
        type: "array",
        minItems: 1,
        maxItems: Math.max(1, Math.min(10, maxSegments)),
        items: {
          type: "string",
          minLength: 1,
          maxLength: 360,
          pattern: "[.!?]$",
        },
      },
    },
    required: ["segments"],
  } as const;
}

export function progressiveSegmentsFromFinalJson(raw: string): readonly string[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("progressive model output must be an object");
  }
  const rawSegments = (parsed as Record<string, unknown>).segments;
  if (!Array.isArray(rawSegments) || rawSegments.length < 1 || rawSegments.length > 10) {
    throw new Error("progressive model output must contain a bounded segments array");
  }
  const segments: string[] = [];
  for (const rawSegment of rawSegments) {
    const expanded = completeModelSpeechSegments(rawSegment);
    if (expanded.length === 0) {
      throw new Error("progressive model output contained an invalid segment");
    }
    segments.push(...expanded);
  }
  return segments;
}

export class ProgressiveSegmentDeltaParser {
  private raw = "";
  private cursor = 0;
  private foundArray = false;
  private completed = false;

  push(delta: string): readonly string[] {
    if (this.completed || !delta) {
      return [];
    }
    this.raw += delta;
    if (Buffer.byteLength(this.raw, "utf8") > 128 * 1024) {
      throw new Error("progressive model output exceeded its byte limit");
    }
    if (!this.foundArray) {
      const match = /^\s*\{\s*"segments"\s*:\s*\[/.exec(this.raw);
      if (!match) {
        return [];
      }
      this.foundArray = true;
      this.cursor = match[0].length;
    }

    const emitted: string[] = [];
    while (this.cursor < this.raw.length) {
      while (this.cursor < this.raw.length && /[\s,]/.test(this.raw[this.cursor] ?? "")) {
        this.cursor += 1;
      }
      if (this.raw[this.cursor] === "]") {
        this.completed = true;
        break;
      }
      if (this.raw[this.cursor] !== '"') {
        break;
      }
      const end = closingJsonStringQuote(this.raw, this.cursor);
      if (end < 0) {
        break;
      }
      const encoded = this.raw.slice(this.cursor, end + 1);
      const decoded = JSON.parse(encoded) as unknown;
      if (typeof decoded !== "string") {
        throw new Error("progressive model segment was not text");
      }
      const segments = completeModelSpeechSegments(decoded);
      if (segments.length === 0) {
        throw new Error("progressive model segment was empty or incomplete");
      }
      emitted.push(...segments);
      this.cursor = end + 1;
    }
    return emitted;
  }
}

function sourceSentences(value: string): readonly string[] {
  const clean = spokenEllipsis(String(value ?? ""))
    .replaceAll(/[\r\n\t]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (!clean) {
    return [];
  }
  const sentences: string[] = [];
  let start = 0;
  for (const match of clean.matchAll(/[.!?]["'\u201d\u2019)\]]*(?=\s+|$)/gu)) {
    const punctuationIndex = match.index;
    if (punctuationIndex === undefined) {
      continue;
    }
    const sentenceEnd = punctuationIndex + match[0].length;
    let nextStart = sentenceEnd;
    while (nextStart < clean.length && /\s/u.test(clean[nextStart] ?? "")) {
      nextStart += 1;
    }
    const punctuation = clean[punctuationIndex] ?? "";
    const candidate = clean.slice(start, sentenceEnd);
    if (
      punctuation === "."
      && nextStart < clean.length
      && sourcePeriodContinues(candidate)
    ) {
      continue;
    }
    if (candidate.trim()) {
      sentences.push(candidate.trim());
    }
    start = nextStart;
  }
  const remainder = clean.slice(start).trim();
  if (remainder) {
    sentences.push(remainder);
  }
  return sentences;
}

function sourcePeriodContinues(prefix: string): boolean {
  const token = /([A-Za-z][A-Za-z.]*)\.$/u.exec(prefix.trim())?.[1] ?? "";
  if (!token) {
    return false;
  }
  if (/^[A-Za-z]$/u.test(token)) {
    return true;
  }
  if (/^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|No|vs|etc|e\.g|i\.e)$/iu.test(token)) {
    return true;
  }
  if (!/^(?:[A-Za-z]\.)+[A-Za-z]$/u.test(token)) {
    return false;
  }
  return true;
}

function splitLongCompleteSentence(sentence: string): readonly string[] {
  const clean = normalizeCompleteSegment(sentence);
  if (!clean) {
    return [];
  }
  if (wordCount(clean) <= 36) {
    return [clean];
  }
  const terminal = clean.at(-1) ?? ".";
  const body = clean.slice(0, -1).trim();
  const words = body.split(/\s+/).filter(Boolean);
  const segments: string[] = [];
  let cursor = 0;
  while (cursor < words.length) {
    const remaining = words.length - cursor;
    const finalChunk = remaining <= 36;
    const chunksNeeded = Math.ceil(remaining / 36);
    const balancedEnd = cursor + Math.ceil(remaining / chunksNeeded);
    const end = finalChunk
      ? words.length
      : preferredSpeechBreak(words, cursor, balancedEnd);
    const chunk = words
      .slice(cursor, end)
      .join(" ")
      .replace(/[,;:]+$/u, "")
      .trim();
    if (!chunk) {
      return [];
    }
    const complete = normalizeCompleteSegment(
      `${chunk}${finalChunk ? terminal : "."}`,
    );
    if (!complete || wordCount(complete) > 36) {
      return [];
    }
    segments.push(complete);
    cursor = end;
  }
  return segments;
}

function completeModelSpeechSegments(value: unknown): readonly string[] {
  if (typeof value !== "string") {
    return [];
  }
  const complete = normalizeCompleteSegment(stripSpokenDiscourseLabels(value));
  return complete ? completeSpeechSegments(complete) : [];
}

function preferredSpeechBreak(
  words: readonly string[],
  start: number,
  targetEnd: number,
): number {
  const minimumUsefulWords = 12;
  const minimumEnd = start + minimumUsefulWords;
  const maximumEnd = Math.min(start + 36, words.length - minimumUsefulWords);
  const balancedEnd = Math.max(minimumEnd, Math.min(maximumEnd, targetEnd));
  const maximumDistance = Math.max(
    balancedEnd - minimumEnd,
    maximumEnd - balancedEnd,
  );
  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    const candidates = distance === 0
      ? [balancedEnd]
      : [balancedEnd - distance, balancedEnd + distance];
    for (const index of candidates) {
      if (index < minimumEnd || index > maximumEnd) {
        continue;
      }
      const previous = words[index - 1] ?? "";
      const next = words[index] ?? "";
      if (/[,;:]$/u.test(previous) || /^(?:and|but|because|while|although|though|whereas|which|who|that)$/iu.test(next)) {
        return index;
      }
    }
  }
  return balancedEnd;
}

function normalizeCompleteSegment(value: string): string {
  const clean = spokenEllipsis(String(value ?? ""))
    .replaceAll(/[\r\n\t]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .replace(/^[-*#\s]+/, "")
    .trim();
  if (
    !clean
    || /https?:\/\//i.test(clean)
    || /```/.test(clean)
    || /\b(?:backend|(?:system|my) prompt|chain of thought|reasoning tokens?)\b/i.test(clean)
  ) {
    return "";
  }
  // A sentence may end inside closing quotes or brackets: `the "proverbial."`
  return /[.!?]["'\u201d\u2019)\]]*$/u.test(clean) ? clean : "";
}

function spokenEllipsis(value: string): string {
  return value.replaceAll("\u2026", "...");
}

function closingJsonStringQuote(value: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      return index;
    }
  }
  return -1;
}

function comparisonText(value: string): string {
  return value.toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function wordCount(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}
