import type { AppConfig } from "./config.js";
import { PERSONALITY_TAIL_TONE, type SpeechTone } from "./speech-tone.js";
import {
  jarvisPersonalityInstructions,
  stripSpokenDiscourseLabels,
} from "./housemate-personality.js";
import {
  callConfiguredModel,
  classifyModelBackendError,
  configuredModelSkipReason,
  effectiveModelName,
  usageFromModelBackendError,
  type CodexExec,
} from "./model-backend.js";
import { addTokenUsage, callIdStamp, elapsedMs, modelCallCost, type ModelCallOutcome, modelLedgerPath, type ModelTokenUsage, writeModelCall } from "./model-ledger.js";
import type { SafeRenderSummary } from "./result-contract.js";
import { automaticFishTextForSummary } from "./speech-renderer.js";
import type { VoiceBrainChannel } from "./voice-brain.js";
import { isAbortError } from "./abort-error.js";
import { householdRegex } from "./household.js";

export type PersonalityTailStatus = "pending" | "ready" | "skipped" | "timeout" | "error";

export interface PersonalityTailContext {
  readonly summary: SafeRenderSummary;
  readonly leadText: string;
  readonly channel: VoiceBrainChannel;
  readonly speakerName: string | null;
  readonly sourceVia?: string | null;
}

export interface PersonalityTailResult {
  readonly schemaVersion: 1;
  readonly status: Exclude<PersonalityTailStatus, "pending">;
  readonly text: string | null;
  readonly fishText: string | null;
  readonly fishTags: readonly string[];
  /** Code-picked tone; when set, fishText carries no delivery tag of its own. */
  readonly tone?: SpeechTone;
  readonly reason: string | null;
  readonly latencyMs: number;
  readonly modelUsed: boolean;
}

export interface PersonalityTailSnapshot {
  readonly schemaVersion: 1;
  readonly turnId: string;
  readonly status: PersonalityTailStatus;
  readonly leadText: string;
  readonly text: string | null;
  readonly fishText: string | null;
  readonly fishTags: readonly string[];
  readonly tone?: SpeechTone;
  readonly reason: string | null;
  readonly latencyMs: number | null;
  readonly modelUsed: boolean;
}

export interface PersonalityTailRenderer {
  renderTail(
    context: PersonalityTailContext,
    options?: { readonly signal?: AbortSignal },
  ): Promise<PersonalityTailResult> | PersonalityTailResult;
}

export interface PersonalityTailStore {
  start(
    turnId: string,
    leadText: string,
    result: Promise<PersonalityTailResult>
      | PersonalityTailResult
      | ((signal: AbortSignal) => Promise<PersonalityTailResult> | PersonalityTailResult),
  ): PersonalityTailSnapshot;
  get(turnId: string): PersonalityTailSnapshot | null;
  cancel?(turnId: string, reason?: string): PersonalityTailSnapshot | null;
}

export interface PersonalityTailRendererOptions {
  readonly execImpl?: CodexExec;
  readonly now?: () => Date;
  readonly ledgerFilePath?: string;
  readonly appendLedger?: boolean;
}

export class InMemoryPersonalityTailStore implements PersonalityTailStore {
  private readonly jobs = new Map<string, {
    snapshot: PersonalityTailSnapshot;
    controller: AbortController;
    createdAtMs: number;
    deadline: ReturnType<typeof setTimeout>;
  }>();
  private readonly nowMs: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly pendingDeadlineMs: number;

  constructor(options: {
    readonly nowMs?: () => number;
    readonly ttlMs?: number;
    readonly maxEntries?: number;
    readonly pendingDeadlineMs?: number;
  } = {}) {
    this.nowMs = options.nowMs ?? Date.now;
    this.ttlMs = Math.max(1_000, options.ttlMs ?? 5 * 60_000);
    this.maxEntries = Math.max(1, options.maxEntries ?? 256);
    this.pendingDeadlineMs = Math.max(250, options.pendingDeadlineMs ?? 12_000);
  }

  start(
    turnId: string,
    leadText: string,
    result: Promise<PersonalityTailResult>
      | PersonalityTailResult
      | ((signal: AbortSignal) => Promise<PersonalityTailResult> | PersonalityTailResult),
  ): PersonalityTailSnapshot {
    this.prune();
    this.remove(turnId, "tail_replaced");
    while (this.jobs.size >= this.maxEntries) {
      const oldestTurnId = this.jobs.keys().next().value as string | undefined;
      if (!oldestTurnId) break;
      this.remove(oldestTurnId, "tail_evicted");
    }
    const pending: PersonalityTailSnapshot = {
      schemaVersion: 1,
      turnId,
      status: "pending",
      leadText,
      text: null,
      fishText: null,
      fishTags: [],
      reason: null,
      latencyMs: null,
      modelUsed: false,
    };
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      this.cancel(turnId, "tail_timeout");
    }, this.pendingDeadlineMs);
    deadline.unref?.();
    const job = {
      snapshot: pending,
      controller,
      createdAtMs: this.nowMs(),
      deadline,
    };
    this.jobs.set(turnId, job);
    const guardedResult = typeof result === "function"
      ? null
      : Promise.resolve(result).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
    // A tail is strictly post-response work. A promise microtask can still run
    // before the request handler gets a chance to return and flush its lead;
    // defer the factory to the next event-loop turn instead.
    setImmediate(() => {
      if (controller.signal.aborted) return;
      void Promise.resolve()
        .then(async () => {
          if (typeof result === "function") return result(controller.signal);
          if (!guardedResult) throw new Error("tail_result_missing");
          const settled = await guardedResult;
          if (!settled.ok) throw settled.error;
          return settled.value;
        })
        .then((tail) => this.finish(turnId, job, snapshotFromResult(turnId, leadText, tail)))
        .catch((error) => this.finish(turnId, job, {
          ...pending,
          status: controller.signal.aborted ? "skipped" : "error",
          reason: controller.signal.aborted
            ? "tail_cancelled"
            : error instanceof Error ? error.message : String(error),
          latencyMs: 0,
        }));
    });
    return pending;
  }

  get(turnId: string): PersonalityTailSnapshot | null {
    this.prune();
    return this.jobs.get(turnId)?.snapshot ?? null;
  }

  cancel(turnId: string, reason = "tail_cancelled"): PersonalityTailSnapshot | null {
    const job = this.jobs.get(turnId);
    if (!job) return null;
    if (job.snapshot.status !== "pending") return job.snapshot;
    clearTimeout(job.deadline);
    job.controller.abort(new Error(reason));
    job.snapshot = {
      ...job.snapshot,
      status: reason === "tail_timeout" ? "timeout" : "skipped",
      reason,
      latencyMs: Math.max(0, this.nowMs() - job.createdAtMs),
    };
    return job.snapshot;
  }

  private finish(
    turnId: string,
    expected: { readonly deadline: ReturnType<typeof setTimeout> },
    snapshot: PersonalityTailSnapshot,
  ): void {
    const current = this.jobs.get(turnId);
    if (!current || current !== expected || current.controller.signal.aborted) return;
    clearTimeout(current.deadline);
    current.snapshot = snapshot;
  }

  private prune(): void {
    const cutoff = this.nowMs() - this.ttlMs;
    for (const [turnId, job] of this.jobs) {
      if (job.createdAtMs < cutoff) this.remove(turnId, "tail_expired");
    }
  }

  private remove(turnId: string, reason: string): void {
    const job = this.jobs.get(turnId);
    if (!job) return;
    clearTimeout(job.deadline);
    if (job.snapshot.status === "pending") job.controller.abort(new Error(reason));
    this.jobs.delete(turnId);
  }
}

export class OpenAiPersonalityTailRenderer implements PersonalityTailRenderer {
  private readonly config: AppConfig;
  private readonly execImpl: CodexExec | undefined;
  private readonly now: () => Date;
  private readonly ledgerFilePath: string;
  private readonly appendLedger: boolean;

  constructor(config: AppConfig, options: PersonalityTailRendererOptions = {}) {
    this.config = config;
    this.execImpl = options.execImpl;
    this.now = options.now ?? (() => new Date());
    this.ledgerFilePath = options.ledgerFilePath ?? modelLedgerPath(config);
    this.appendLedger = options.appendLedger ?? true;
  }

  async renderTail(
    context: PersonalityTailContext,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PersonalityTailResult> {
    const startedAt = this.now();
    if (!shouldRequestPersonalityTail(context.summary, context.channel, context.sourceVia)) {
      const tail = skippedTail("tail_not_useful", elapsedMs(startedAt, this.now()));
      this.writeLedger(context, "skipped", tail.latencyMs, ZERO_TOKENS, "tail_not_useful", tail.fishTags);
      return tail;
    }
    let accumulatedUsage = ZERO_TOKENS;
    const skipReason = this.skipReason(context);
    if (skipReason) {
      const tail = skippedTail(skipReason, elapsedMs(startedAt, this.now()));
      this.writeLedger(context, "skipped", tail.latencyMs, ZERO_TOKENS, skipReason, tail.fishTags);
      return tail;
    }

    try {
      const modelName = effectiveModelName(this.config);
      let tailText: string | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await callConfiguredModel(
          this.config,
          buildOpenAiPersonalityTailRequest(modelName, context),
          {
            execImpl: this.execImpl,
            reasoningEffort: "none",
            ...(options.signal ? { signal: options.signal } : {}),
          },
        );
        accumulatedUsage = addTokenUsage(accumulatedUsage, response.usage);
        try {
          tailText = validatePersonalityTail(response.outputText, context);
          break;
        } catch (error) {
          if (attempt === 0 && isTailValidationError(error)) {
            continue;
          }
          throw error;
        }
      }
      if (!tailText) {
        throw new Error("tail_error");
      }
      const latencyMs = elapsedMs(startedAt, this.now());
      const fish = this.config.speechToneEnabled
        ? { fishText: tailText, fishTags: [] as readonly string[] }
        : automaticFishTextForSummary(tailText, context.summary);
      const tail: PersonalityTailResult = {
        schemaVersion: 1,
        status: "ready",
        text: tailText,
        fishText: fish.fishText,
        fishTags: fish.fishTags,
        ...(this.config.speechToneEnabled ? { tone: PERSONALITY_TAIL_TONE } : {}),
        reason: null,
        latencyMs,
        modelUsed: true,
      };
      this.writeLedger(context, "ok", latencyMs, accumulatedUsage, null, fish.fishTags);
      return tail;
    } catch (error) {
      const latencyMs = elapsedMs(startedAt, this.now());
      const outcome = isAbortError(error) ? "timeout" : "error";
      const validationError = isTailValidationError(error);
      const reason = outcome === "timeout"
        ? "tail_timeout"
        : validationError
          ? (error as Error).message
          : "tail_error";
      // A tail the assistant rejected is not a backend fault; keep its own reason in the ledger.
      const backendError = outcome === "error" && !validationError
        ? classifyModelBackendError(
          { modelBackend: this.config.modelBackend },
          error,
        )
        : null;
      const tail = skippedTail(reason, latencyMs, outcome);
      this.writeLedger(
        context,
        outcome,
        latencyMs,
        outcome === "timeout"
          ? accumulatedUsage
          : addTokenUsage(accumulatedUsage, usageFromModelBackendError(error)),
        reason,
        tail.fishTags,
        backendError,
      );
      return tail;
    }
  }

  private skipReason(context: PersonalityTailContext): string | null {
    if (!shouldRequestPersonalityTail(context.summary, context.channel, context.sourceVia)) {
      return "tail_not_useful";
    }
    return configuredModelSkipReason(this.config);
  }

  private writeLedger(
    context: PersonalityTailContext,
    outcome: ModelCallOutcome,
    latencyMs: number,
    tokens: ModelTokenUsage,
    reason: string | null,
    fishTags: readonly string[],
    backendError: { readonly code: string; readonly message: string } | null = null,
  ): void {
    if (!this.appendLedger) {
      return;
    }
    const timestamp = this.now().toISOString();
    writeModelCall(this.ledgerFilePath, {
      callId: `${context.summary.turnId}-tail-${callIdStamp(timestamp)}`,
      turnId: context.summary.turnId,
      timestamp,
      purpose: "render_tail",
      model: effectiveModelName(this.config),
      backend: this.config.modelBackend,
      route: context.summary.route,
      outcome,
      latencyMs,
      tokens,
      cost: modelCallCost(tokens, this.config, 8),
      ...(fishTags.length > 0 ? { extra: { fishTags } } : {}),
      reason,
      backendError,
    });
  }
}

export function shouldRequestPersonalityTail(summary: SafeRenderSummary, channel: VoiceBrainChannel, sourceVia: string | null = null): boolean {
  if (channel === "test") {
    return false;
  }
  if (sourceVia && isEvaluationSourceVia(sourceVia)) {
    return false;
  }
  if (!summary.modelPolishUseful || summary.status !== "ok") {
    return false;
  }
  // Tail-eligible routes are the ones with predetermined fallback copy. The voice
  // loop plays a model tail only if it is ready before the lead finishes, so a
  // slow tail is dropped rather than leaving silence.
  if (!predeterminedTailText(summary)) {
    return false;
  }
  if (summary.route === "entity_action") {
    return false;
  }
  if (channel === "chat") {
    return true;
  }
  return summary.session === "continue" || summary.route !== "open_conversation";
}

function predeterminedTailText(summary: SafeRenderSummary): string | null {
  const variants = PREDETERMINED_TAILS[summary.route];
  if (!variants || variants.length === 0) return null;
  return variants[stableTailIndex(summary.turnId, variants.length)] ?? null;
}

function stableTailIndex(turnId: string, size: number): number {
  let hash = 2_166_136_261;
  for (const character of turnId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % size;
}

const PREDETERMINED_TAILS: Readonly<Partial<Record<SafeRenderSummary["route"], readonly string[]>>> = Object.freeze({
  entity_status: Object.freeze([
    "The machinery has managed a straight answer. Best not to startle it.",
    "The sensors have delivered a coherent statement. A modest miracle.",
    "Even the house can be admirably specific when properly supervised.",
  ]),
  house_status: Object.freeze([
    "The house has filed its report, with only the usual mechanical attitude.",
    "Domestic civilisation survives another inspection. Barely, but it survives.",
    "The building appears to know what it is doing. Suspicious, but useful.",
  ]),
  time_window_math: Object.freeze([
    "The arithmetic remains depressingly immune to optimism.",
    "The numbers have spoken, with their customary lack of bedside manner.",
    "Calculation complete; reality has declined to negotiate.",
  ]),
  energy_budget: Object.freeze([
    "The electrons have submitted their accounts. They remain entirely unapologetic.",
    "The power ledger is clear, even if domestic efficiency still lacks charm.",
    "The house is keeping score. Naturally, it has no sense of mercy.",
  ]),
  weather_query: Object.freeze([
    "The atmosphere remains committed to its little performance.",
    "The sky has issued its ruling, without accepting appeals.",
    "Nature's planning department remains gloriously unaccountable.",
  ]),
});

export function buildOpenAiPersonalityTailRequest(model: string, context: PersonalityTailContext): Record<string, unknown> {
  return {
    model,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: buildPersonalityTailSystemPrompt(),
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({
              lead_text_being_spoken: context.leadText,
              speaker_name: context.speakerName,
              channel: context.channel,
              source_via: context.sourceVia ?? null,
              tail_style: tailStyleForSummary(context.summary),
              safe_summary: context.summary,
            }),
          },
        ],
      },
    ],
    text: {
      verbosity: "low",
    },
  };
}

export function buildPersonalityTailSystemPrompt(): string {
  return [
    "Only add a short tail after the main answer.",
    "Return the tail text only. Delivery tags are handled by the speech renderer.",
    "Write one natural continuation with no heading or labels such as Opinion, Fact, Analysis, or Verdict.",
    "Continue the answer, don't restart or repeat it.",
    ...jarvisPersonalityInstructions(),
    "If safe_summary.renderContext is present, use it only as ambient context for tone, timing, and brevity. Do not turn it into new facts.",
    "Do not add facts, numbers, device states, action claims, safety claims, or questions.",
    "If practical advice introduces an object, name it explicitly; never rely on a dangling 'it', 'that', or 'this'.",
    "Do not contradict the main answer.",
    "Usually use 8 to 20 words; never exceed 30 words.",
    "If no useful tail exists, return nothing.",
  ].join(" ");
}

export function validatePersonalityTail(raw: string, context: PersonalityTailContext): string {
  const unwrapped = raw
    .replace(/^["']|["']$/g, "")
    .replace(/\[[^\]\n]{1,80}\]/g, "")
    .trim();
  const text = stripSpokenDiscourseLabels(unwrapped)
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    throw new Error("empty_tail");
  }
  if (text.length > 220 || text.split(/\s+/).length > 30) {
    throw new Error("tail_too_long");
  }
  if (/[?]/.test(text)) {
    throw new Error("tail_must_not_ask_question");
  }
  if (/\d/.test(text)) {
    throw new Error("tail_must_not_add_numbers");
  }
  if (/(?:\bkwh\b|°|degrees?|celsius|fahrenheit|percent|%|\bwatts?\b)/i.test(text)) {
    throw new Error("tail_must_not_add_measurements");
  }
  if (/^\s*done\b/i.test(text)
    || householdRegex(String.raw`\b(?:i|we|{ASSISTANT})\s+(?:(?:have|already)\s+)?(?:turned|switched|opened|closed|locked|unlocked)\b`, "i").test(text)
    || /\b(?:i've|we've)\s+(?:turned|switched|opened|closed|locked|unlocked)\b/i.test(text)) {
    throw new Error("tail_must_not_imply_actions");
  }
  if (/\b(?:keep|leave|shut|open|turn|switch)\s+(?:it|that|this|them)\b/i.test(text)) {
    throw new Error("tail_must_not_use_dangling_reference");
  }
  if (/(?:\bactually\b|\binstead\b|\bcorrection\b|\bwrong\b)/i.test(text)) {
    throw new Error("tail_must_not_contradict");
  }
  if (containsBannedAbuse(text)) {
    throw new Error("tail_must_not_use_abuse");
  }
  for (const fact of context.summary.facts) {
    const value = String(fact.value).trim();
    if (value && !context.leadText.includes(value) && text.includes(value)) {
      throw new Error("tail_must_not_add_fact_values");
    }
  }
  return text;
}

export function tailStyleForSummary(summary: SafeRenderSummary): string {
  const quietHint = summary.renderContext?.house?.timeMode === "bedtime" || summary.renderContext?.house?.timeMode === "quiet_hours"
    ? " Keep it softer and shorter than usual."
    : "";
  const eventHint = (summary.renderContext?.recentEvents.length ?? 0) > 0
    ? " If it helps, you may reflect that the house has just had a real event, but do not restate the event facts."
    : "";
  switch (summary.route) {
    case "weather_query":
      return `Continue with a polished practical judgement: mock-courteous permission, then a dry qualification or elegant warning. Advice may mention going outside, suitable clothing, or a clearly named practical object; never use a dangling reference. Do not reuse a stock phrase.${quietHint}${eventHint}`;
    case "time_window_math":
    case "energy_budget":
      return `Add a short judgement or dry aside about the sourced number without changing it.${quietHint}${eventHint}`;
    case "entity_status":
    case "house_status":
      return `Add a brief human aside about the state without implying control or action.${quietHint}${eventHint}`;
    case "memory_query":
      return `Add a warm acknowledgement that fits the remembered preference.${quietHint}${eventHint}`;
    default:
      return `Add only a tiny human acknowledgement if it genuinely follows.${quietHint}${eventHint}`;
  }
}

function containsBannedAbuse(text: string): boolean {
  return /\b(?:retard|retarded|spaz|cripple|mong)\b/i.test(text);
}

function isTailValidationError(error: unknown): boolean {
  return error instanceof Error && /^tail_[a-z_]+$/.test(error.message);
}

function isEvaluationSourceVia(sourceVia: string): boolean {
  return /(?:spoken-regression|fast-path-hardening|eval|fixture|test:)/i.test(sourceVia);
}

function snapshotFromResult(turnId: string, leadText: string, result: PersonalityTailResult): PersonalityTailSnapshot {
  return {
    schemaVersion: 1,
    turnId,
    status: result.status,
    leadText,
    text: result.text,
    fishText: result.fishText,
    fishTags: result.fishTags,
    ...(result.tone ? { tone: result.tone } : {}),
    reason: result.reason,
    latencyMs: result.latencyMs,
    modelUsed: result.modelUsed,
  };
}

function skippedTail(
  reason: string,
  latencyMs: number,
  status: Exclude<PersonalityTailStatus, "pending" | "ready"> = "skipped",
): PersonalityTailResult {
  return {
    schemaVersion: 1,
    status,
    text: null,
    fishText: null,
    fishTags: [],
    reason,
    latencyMs,
    modelUsed: false,
  };
}

const ZERO_TOKENS: ModelTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
};
