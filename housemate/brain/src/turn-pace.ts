import type { ProgressiveSpeechSegmentKind, ProgressiveSpeechSink } from "./progressive-speech.js";

/**
 * Per-turn timing for the pause before the assistant starts talking.
 * Numbers only: every time is milliseconds after the turn reached the brain.
 */

/** What the Claude stream reports while a turn runs; the recorder stamps the first of each. */
export type ModelStreamTrace =
  | { readonly kind: "process"; readonly spare: "warm" | "cold" | "detached" }
  | { readonly kind: "prompt"; readonly promptChars: number; readonly systemPromptChars: number }
  | { readonly kind: "sent" }
  | { readonly kind: "message_start" }
  | { readonly kind: "thinking" }
  | { readonly kind: "tool_use" };

export interface TurnPaceModelExtras {
  readonly recall: boolean;
  readonly brief: boolean;
  readonly tools: boolean;
  readonly webSearch: boolean;
  readonly catchup: boolean;
  readonly memoryCards: number;
  readonly conversationTurns: number;
}

export interface TurnPaceModelLog {
  readonly purpose: "open_conversation" | "general_knowledge" | "current_information";
  readonly startMs: number;
  readonly spare: "warm" | "cold" | "detached" | null;
  readonly sentMs: number | null;
  readonly firstEventMs: number | null;
  readonly firstThinkingMs: number | null;
  readonly firstTextMs: number | null;
  /** Terminal punctuation first seen in the streamed text; the commit may wait for more. */
  readonly firstSentenceEndMs: number | null;
  readonly firstCommitMs: number | null;
  readonly firstToolMs: number | null;
  readonly endMs: number | null;
  readonly apiRounds: number;
  readonly promptChars: number | null;
  readonly systemPromptChars: number | null;
  readonly extras: TurnPaceModelExtras;
}

export interface TurnPaceLog {
  /** First speech segment committed to the stream; null when nothing was spoken before the turn finished. */
  readonly firstEmitMs: number | null;
  readonly firstEmitKind: ProgressiveSpeechSegmentKind | null;
  readonly models: readonly TurnPaceModelLog[];
}

const MAX_MODEL_CALLS = 4;
const SENTENCE_SCAN_LIMIT = 4_096;

export class TurnPace {
  private readonly startedAtMs: number;
  private readonly clock: () => number;
  private firstEmit: { readonly atMs: number; readonly kind: ProgressiveSpeechSegmentKind } | null = null;
  private readonly models: TurnPaceModel[] = [];

  constructor(startedAtMs: number, clock: () => number = Date.now) {
    this.startedAtMs = startedAtMs;
    this.clock = clock;
  }

  elapsed(): number {
    return Math.max(0, this.clock() - this.startedAtMs);
  }

  /** Wraps the turn's speech sink so the first committed segment is timed. */
  timeSink(sink: ProgressiveSpeechSink): ProgressiveSpeechSink {
    return {
      signal: sink.signal,
      emit: (input) => {
        const segment = sink.emit(input);
        if (segment && !this.firstEmit) {
          this.firstEmit = { atMs: this.elapsed(), kind: segment.kind };
        }
        return segment;
      },
      snapshot: () => sink.snapshot(),
      combinedText: () => sink.combinedText(),
      remainingWords: () => sink.remainingWords(),
    };
  }

  beginModel(purpose: TurnPaceModelLog["purpose"], extras: TurnPaceModelExtras): TurnPaceModel | null {
    if (this.models.length >= MAX_MODEL_CALLS) {
      return null;
    }
    const model = new TurnPaceModel(this, purpose, extras);
    this.models.push(model);
    return model;
  }

  hasRecord(): boolean {
    return this.firstEmit !== null || this.models.length > 0;
  }

  snapshot(): TurnPaceLog {
    return {
      firstEmitMs: this.firstEmit?.atMs ?? null,
      firstEmitKind: this.firstEmit?.kind ?? null,
      models: this.models.map((model) => model.snapshot()),
    };
  }
}

export class TurnPaceModel {
  private readonly pace: TurnPace;
  private readonly purpose: TurnPaceModelLog["purpose"];
  private readonly extras: TurnPaceModelExtras;
  private readonly startMs: number;
  private spare: TurnPaceModelLog["spare"] = null;
  private sentMs: number | null = null;
  private firstEventMs: number | null = null;
  private firstThinkingMs: number | null = null;
  private firstTextMs: number | null = null;
  private firstSentenceEndMs: number | null = null;
  private firstCommitMs: number | null = null;
  private firstToolMs: number | null = null;
  private endMs: number | null = null;
  private apiRounds = 0;
  private promptChars: number | null = null;
  private systemPromptChars: number | null = null;
  private streamedText = "";

  constructor(pace: TurnPace, purpose: TurnPaceModelLog["purpose"], extras: TurnPaceModelExtras) {
    this.pace = pace;
    this.purpose = purpose;
    this.extras = extras;
    this.startMs = pace.elapsed();
  }

  trace(event: ModelStreamTrace): void {
    const at = this.pace.elapsed();
    switch (event.kind) {
      case "process":
        this.spare ??= event.spare;
        return;
      case "prompt":
        this.promptChars ??= event.promptChars;
        this.systemPromptChars ??= event.systemPromptChars;
        return;
      case "sent":
        this.sentMs ??= at;
        return;
      case "message_start":
        this.firstEventMs ??= at;
        this.apiRounds += 1;
        return;
      case "thinking":
        this.firstThinkingMs ??= at;
        return;
      case "tool_use":
        this.firstToolMs ??= at;
        return;
    }
  }

  /** Streamed answer text as it arrives (plain text or segment JSON). */
  text(delta: string): void {
    if (!delta) {
      return;
    }
    const at = this.pace.elapsed();
    this.firstTextMs ??= at;
    if (this.firstSentenceEndMs !== null || this.streamedText.length >= SENTENCE_SCAN_LIMIT) {
      return;
    }
    this.streamedText += delta;
    if (/\p{L}[^.!?]*[.!?]["'”’)\]]*(?:\s|$)/u.test(this.streamedText)) {
      this.firstSentenceEndMs = at;
    }
  }

  committed(): void {
    this.firstCommitMs ??= this.pace.elapsed();
  }

  end(): void {
    this.endMs ??= this.pace.elapsed();
  }

  snapshot(): TurnPaceModelLog {
    return {
      purpose: this.purpose,
      startMs: this.startMs,
      spare: this.spare,
      sentMs: this.sentMs,
      firstEventMs: this.firstEventMs,
      firstThinkingMs: this.firstThinkingMs,
      firstTextMs: this.firstTextMs,
      firstSentenceEndMs: this.firstSentenceEndMs,
      firstCommitMs: this.firstCommitMs,
      firstToolMs: this.firstToolMs,
      endMs: this.endMs,
      apiRounds: this.apiRounds,
      promptChars: this.promptChars,
      systemPromptChars: this.systemPromptChars,
      extras: this.extras,
    };
  }
}

export function validateTurnPaceLog(pace: TurnPaceLog): void {
  validateNullableMs(pace.firstEmitMs, "firstEmitMs");
  if (
    pace.firstEmitKind !== null
    && pace.firstEmitKind !== "bridge"
    && pace.firstEmitKind !== "answer"
    && pace.firstEmitKind !== "fallback"
  ) {
    throw new Error("turn log pace firstEmitKind is unsupported");
  }
  if (!Array.isArray(pace.models) || pace.models.length > MAX_MODEL_CALLS) {
    throw new Error("turn log pace models must be a short array");
  }
  for (const model of pace.models) {
    for (const key of [
      "sentMs",
      "firstEventMs",
      "firstThinkingMs",
      "firstTextMs",
      "firstSentenceEndMs",
      "firstCommitMs",
      "firstToolMs",
      "endMs",
      "promptChars",
      "systemPromptChars",
    ] as const) {
      validateNullableMs(model[key], key);
    }
    validateNullableMs(model.startMs, "startMs");
    validateNullableMs(model.apiRounds, "apiRounds");
  }
}

function validateNullableMs(value: number | null, label: string): void {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`turn log pace ${label} must be null or a non-negative number`);
  }
}
