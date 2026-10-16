import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AppConfig } from "./config.js";

export type ModelCallPurpose =
  | "parse_fallback"
  | "render"
  | "render_tail"
  | "open_conversation"
  | "general_knowledge"
  | "current_information"
  | "read_agent_plan"
  | "read_agent_verify"
  | "self_model_review"
  | "memory_reflection"
  | "self_growth"
  /** A read-only lookup the chat model made; logged for latency, not a model call. */
  | "chat_tool"
  | "test";
export type ModelCallOutcome = "ok" | "timeout" | "error" | "skipped";

export interface ModelTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelCost {
  readonly currency: "USD";
  readonly estimatedCostUsd: number;
}

export interface ModelCallLedgerEntry {
  readonly schemaVersion: 1;
  readonly callId: string;
  readonly turnId: string;
  readonly timestamp: string;
  readonly purpose: ModelCallPurpose;
  readonly model: string;
  readonly outcome: ModelCallOutcome;
  readonly latencyMs: number;
  readonly tokens: ModelTokenUsage;
  readonly cost: ModelCost;
  readonly metadata?: ModelCallMetadata;
  readonly errorCode?: string;
}

export interface ModelCallMetadata {
  readonly route?: string;
  readonly backend?: string;
  readonly fishTags?: readonly string[];
  readonly fallbackReason?: string;
  readonly backendErrorCode?: string;
  readonly backendErrorMessage?: string;
  /** chat_tool entries: which tool ran. */
  readonly tool?: string;
}

export type ModelBudgetWarningLevel = "ok" | "warning" | "hard_warning" | "exceeded";

export interface ModelBudgetCounter {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
}

export interface ModelBudgetSummary {
  readonly currency: "USD";
  readonly monthlyBudgetUsd: number;
  readonly monthlyUsedPercent: number;
  readonly warningLevel: ModelBudgetWarningLevel;
  readonly optionalModelUseRequiresApproval: boolean;
  readonly daily: ModelBudgetCounter & {
    readonly date: string;
    readonly budgetUsd: number;
  };
  readonly monthly: ModelBudgetCounter & {
    readonly month: string;
  };
}

export function modelLedgerPath(config: Pick<AppConfig, "dataDir">): string {
  return join(config.dataDir, "logs", "model-calls.jsonl");
}

export function appendModelCallLedgerEntry(
  filePath: string,
  entry: ModelCallLedgerEntry,
): void {
  validateModelCallLedgerEntry(entry);
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8" });
}

/** One model call as its writer knows it; `writeModelCall` builds the ledger line. */
export interface ModelCallRecord {
  readonly callId: string;
  readonly turnId: string;
  readonly timestamp: string;
  readonly purpose: ModelCallPurpose;
  readonly model: string;
  readonly backend: string;
  readonly route: string;
  readonly outcome: ModelCallOutcome;
  readonly latencyMs: number;
  readonly tokens: ModelTokenUsage;
  readonly cost: ModelCost;
  /** Metadata written after route and backend. */
  readonly extra?: Pick<ModelCallMetadata, "fishTags" | "tool">;
  /** Why the call fell back or was skipped. */
  readonly reason?: string | null;
  readonly backendError?: { readonly code: string; readonly message: string } | null;
  /** Defaults to the backend error code, then the reason. */
  readonly errorCode?: string | null;
}

export function writeModelCall(filePath: string, call: ModelCallRecord): void {
  const errorCode = call.errorCode !== undefined ? call.errorCode : call.backendError?.code ?? call.reason ?? null;
  appendModelCallLedgerEntry(filePath, {
    schemaVersion: 1,
    callId: call.callId,
    turnId: call.turnId,
    timestamp: call.timestamp,
    purpose: call.purpose,
    model: call.model,
    outcome: call.outcome,
    latencyMs: call.latencyMs,
    tokens: call.tokens,
    cost: call.cost,
    metadata: {
      route: call.route,
      backend: call.backend,
      ...call.extra,
      ...(call.reason ? { fallbackReason: call.reason } : {}),
      ...(call.backendError
        ? { backendErrorCode: call.backendError.code, backendErrorMessage: call.backendError.message }
        : {}),
    },
    ...(errorCode ? { errorCode } : {}),
  });
}

/** A call id's time part: the ISO timestamp with ":" and "." as "-". */
export function callIdStamp(timestamp: string): string {
  return timestamp.replaceAll(/[:.]/g, "-");
}

export function modelCallCost(
  tokens: ModelTokenUsage,
  config: Pick<AppConfig, "modelInputCostPerMillionUsd" | "modelOutputCostPerMillionUsd">,
  places = 6,
): ModelCost {
  return {
    currency: "USD",
    estimatedCostUsd: roundNumber(
      ((tokens.inputTokens / 1_000_000) * config.modelInputCostPerMillionUsd)
        + ((tokens.outputTokens / 1_000_000) * config.modelOutputCostPerMillionUsd),
      places,
    ),
  };
}

export function elapsedMs(startedAt: Date, endedAt: Date): number {
  return Math.max(0, endedAt.getTime() - startedAt.getTime());
}

export function readModelCallLedgerEntries(filePath: string): ModelCallLedgerEntry[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const content = readFileSync(filePath, "utf8").trim();
  if (!content) {
    return [];
  }
  return content.split("\n").map((line) => {
    const entry = JSON.parse(line) as ModelCallLedgerEntry;
    validateModelCallLedgerEntry(entry);
    return entry;
  });
}

export function summarizeModelBudget(
  entries: readonly ModelCallLedgerEntry[],
  monthlyBudgetUsd: number,
  now: Date = new Date(),
): ModelBudgetSummary {
  validateNonNegative("monthlyBudgetUsd", monthlyBudgetUsd);
  if (monthlyBudgetUsd === 0) {
    throw new Error("model ledger monthlyBudgetUsd must be greater than zero");
  }

  const month = now.toISOString().slice(0, 7);
  const date = now.toISOString().slice(0, 10);
  const daily = summarizeEntries(entries.filter((entry) => entry.timestamp.slice(0, 10) === date));
  const monthly = summarizeEntries(entries.filter((entry) => entry.timestamp.slice(0, 7) === month));
  const monthlyUsedPercent = roundNumber((monthly.estimatedCostUsd / monthlyBudgetUsd) * 100, 2);

  return {
    currency: "USD",
    monthlyBudgetUsd,
    monthlyUsedPercent,
    warningLevel: budgetWarningLevel(monthlyUsedPercent),
    optionalModelUseRequiresApproval: monthlyUsedPercent >= 100,
    daily: {
      date,
      budgetUsd: roundNumber(monthlyBudgetUsd / daysInUtcMonth(now), 6),
      ...daily,
    },
    monthly: {
      month,
      ...monthly,
    },
  };
}

export function readModelBudgetSummary(
  filePath: string,
  monthlyBudgetUsd: number,
  now: Date = new Date(),
): ModelBudgetSummary {
  return summarizeModelBudget(readModelCallLedgerEntries(filePath), monthlyBudgetUsd, now);
}

export function validateModelCallLedgerEntry(entry: ModelCallLedgerEntry): void {
  if (entry.schemaVersion !== 1) {
    throw new Error("model ledger schemaVersion must be 1");
  }
  if (!entry.callId.trim()) {
    throw new Error("model ledger callId is required");
  }
  if (!entry.turnId.trim()) {
    throw new Error("model ledger turnId is required");
  }
  if (Number.isNaN(Date.parse(entry.timestamp))) {
    throw new Error("model ledger timestamp must be ISO-like");
  }
  if (!entry.model.trim()) {
    throw new Error("model ledger model is required");
  }
  validateNonNegative("latencyMs", entry.latencyMs);
  validateNonNegative("inputTokens", entry.tokens.inputTokens);
  validateNonNegative("outputTokens", entry.tokens.outputTokens);
  validateNonNegative("estimatedCostUsd", entry.cost.estimatedCostUsd);
  if (entry.cost.currency !== "USD") {
    throw new Error("model ledger currency must be USD");
  }
  if (entry.metadata) {
    validateModelCallMetadata(entry.metadata);
  }
}

function validateModelCallMetadata(metadata: ModelCallMetadata): void {
  if (metadata.route !== undefined && !metadata.route.trim()) {
    throw new Error("model ledger metadata route must be non-empty");
  }
  if (metadata.backend !== undefined && !metadata.backend.trim()) {
    throw new Error("model ledger metadata backend must be non-empty");
  }
  if (metadata.fallbackReason !== undefined && !metadata.fallbackReason.trim()) {
    throw new Error("model ledger metadata fallbackReason must be non-empty");
  }
  if (metadata.backendErrorCode !== undefined && !metadata.backendErrorCode.trim()) {
    throw new Error("model ledger metadata backendErrorCode must be non-empty");
  }
  if (metadata.backendErrorMessage !== undefined && !metadata.backendErrorMessage.trim()) {
    throw new Error("model ledger metadata backendErrorMessage must be non-empty");
  }
  if (metadata.tool !== undefined && !metadata.tool.trim()) {
    throw new Error("model ledger metadata tool must be non-empty");
  }
  for (const tag of metadata.fishTags ?? []) {
    if (!tag.trim()) {
      throw new Error("model ledger metadata fishTags must be non-empty");
    }
  }
}

function summarizeEntries(entries: readonly ModelCallLedgerEntry[]): ModelBudgetCounter {
  // Tool lookups ride inside a model call that is already counted.
  return entries.filter((entry) => entry.purpose !== "chat_tool").reduce<ModelBudgetCounter>(
    (summary, entry) => ({
      calls: summary.calls + 1,
      inputTokens: summary.inputTokens + entry.tokens.inputTokens,
      outputTokens: summary.outputTokens + entry.tokens.outputTokens,
      estimatedCostUsd: roundNumber(
        summary.estimatedCostUsd + entry.cost.estimatedCostUsd,
        6,
      ),
    }),
    {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    },
  );
}

function budgetWarningLevel(monthlyUsedPercent: number): ModelBudgetWarningLevel {
  if (monthlyUsedPercent >= 100) {
    return "exceeded";
  }
  if (monthlyUsedPercent >= 90) {
    return "hard_warning";
  }
  if (monthlyUsedPercent >= 70) {
    return "warning";
  }
  return "ok";
}

function daysInUtcMonth(now: Date): number {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
}

export function roundNumber(value: number, places: number): number {
  return Number(value.toFixed(places));
}

function validateNonNegative(field: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`model ledger ${field} must be non-negative`);
  }
}

export function addTokenUsage(left: ModelTokenUsage, right: ModelTokenUsage): ModelTokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}
