import { existsSync } from "node:fs";

import type { AppConfig } from "./config.js";
import { cognitiveFeatureEnabled } from "./cognitive-control.js";
import { type ModelBudgetSummary, modelLedgerPath, readModelBudgetSummary, roundNumber } from "./model-ledger.js";
import { MemoryStore, memoryStorePath } from "./memory-store.js";
import type {
  MemoryCategory,
  MemoryRecord,
  MemorySourceType,
  MemoryTier,
  ReviewStatus,
  SensitivityCategory,
} from "./memory-schema.js";
import { readTurnLogEntries, turnLogPath, type TurnLogEntry } from "./turn-log.js";

export interface LocalReport {
  readonly generatedAt: string;
  readonly dataDir: string;
  readonly latency: {
    readonly turnCount: number;
    readonly averageMs: number | null;
    readonly latest: LatestTurnSummary | null;
  };
  readonly cost: ModelBudgetSummary;
  readonly memory: MemoryReportSummary;
}

export interface LatestTurnSummary {
  readonly turnId: string;
  readonly timestamp: string;
  readonly route: string;
  readonly outcome: string;
  readonly latencyMs: number;
  readonly modelUsed: boolean;
}

export interface MemoryReportSummary {
  readonly storePresent: boolean;
  readonly total: number;
  readonly evidenceTotal: number;
  readonly byCategory: Readonly<Record<MemoryCategory, number>>;
  readonly byTier: Readonly<Record<MemoryTier, number>>;
  readonly byReviewStatus: Readonly<Record<ReviewStatus, number>>;
  readonly reviewBacklog: {
    readonly queued: number;
    readonly needsClarification: number;
  };
  readonly sensitive: {
    readonly total: number;
    readonly bySensitivity: Readonly<Record<SensitivityCategory, number>>;
  };
  readonly evidenceBySource: Readonly<Record<MemorySourceType, number>>;
  readonly latestUpdatedAt: string | null;
}

export function buildLocalReport(
  config: AppConfig,
  now: Date = new Date(),
  options: { readonly includeMemory?: boolean } = {},
): LocalReport {
  const turns = readTurnLogEntries(turnLogPath(config));

  return {
    generatedAt: now.toISOString(),
    dataDir: config.dataDir,
    latency: {
      turnCount: turns.length,
      averageMs: averageLatency(turns),
      latest: latestTurnSummary(turns),
    },
    cost: readModelBudgetSummary(modelLedgerPath(config), config.monthlyBudgetUsd, now),
    memory: (options.includeMemory ?? cognitiveFeatureEnabled(config, "recall")) === false
      ? emptyMemoryReport(existsSync(memoryStorePath(config)))
      : buildMemoryReport(config),
  };
}

export function buildMemoryReport(config: Pick<AppConfig, "dataDir">): MemoryReportSummary {
  const path = memoryStorePath(config);
  if (!existsSync(path)) {
    return emptyMemoryReport(false);
  }

  const store = new MemoryStore(path);
  try {
    const records = store.listMemoryRecords();
    const evidence = store.listEvidenceRecords();

    return {
      storePresent: true,
      total: records.length,
      evidenceTotal: evidence.length,
      byCategory: countBy(MEMORY_CATEGORIES, records, (record) => record.category),
      byTier: countBy(MEMORY_TIERS, records, (record) => record.tier),
      byReviewStatus: countBy(REVIEW_STATUSES, records, (record) => record.reviewStatus),
      reviewBacklog: {
        queued: records.filter((record) => record.reviewStatus === "queued").length,
        needsClarification: records.filter((record) => record.reviewStatus === "needs_clarification").length,
      },
      sensitive: {
        total: records.filter((record) => !record.sensitivity.includes("none")).length,
        bySensitivity: countSensitivity(records),
      },
      evidenceBySource: countBy(MEMORY_SOURCE_TYPES, evidence, (record) => record.sourceType),
      latestUpdatedAt: latestMemoryUpdatedAt(records),
    };
  } finally {
    store.close();
  }
}

function averageLatency(turns: readonly TurnLogEntry[]): number | null {
  if (turns.length === 0) {
    return null;
  }
  const total = turns.reduce((sum, turn) => sum + turn.latencyMs, 0);
  return roundNumber(total / turns.length, 2);
}

function latestTurnSummary(turns: readonly TurnLogEntry[]): LatestTurnSummary | null {
  const latest = latestByTimestamp(turns);
  if (!latest) {
    return null;
  }
  return {
    turnId: latest.turnId,
    timestamp: latest.timestamp,
    route: latest.route,
    outcome: latest.outcome,
    latencyMs: latest.latencyMs,
    modelUsed: latest.modelUsed,
  };
}

function latestByTimestamp<T extends { readonly timestamp: string }>(
  entries: readonly T[],
): T | null {
  return entries.reduce<T | null>((latest, entry) => {
    if (!latest || Date.parse(entry.timestamp) > Date.parse(latest.timestamp)) {
      return entry;
    }
    return latest;
  }, null);
}

const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  "event",
  "fact",
  "preference",
  "routine",
  "person",
  "relationship",
  "place",
  "rule",
  "skill",
  "episodic",
];

const MEMORY_TIERS: readonly MemoryTier[] = ["short", "medium", "long", "archive"];
const REVIEW_STATUSES: readonly ReviewStatus[] = ["accepted", "queued", "needs_clarification", "rejected", "redacted", "deleted"];
const SENSITIVITY_CATEGORIES: readonly SensitivityCategory[] = [
  "child",
  "health",
  "safety",
  "location",
  "school",
  "relationship",
  "permission",
  "finance",
  "private",
  "none",
];
const MEMORY_SOURCE_TYPES: readonly MemorySourceType[] = [
  "chat",
  "voice_turn",
  "calendar",
  "home_assistant",
  "history",
  "weather",
  "operator_import",
  "routine_miner",
  "system",
];

function emptyMemoryReport(storePresent: boolean): MemoryReportSummary {
  return {
    storePresent,
    total: 0,
    evidenceTotal: 0,
    byCategory: zeroCounts(MEMORY_CATEGORIES),
    byTier: zeroCounts(MEMORY_TIERS),
    byReviewStatus: zeroCounts(REVIEW_STATUSES),
    reviewBacklog: {
      queued: 0,
      needsClarification: 0,
    },
    sensitive: {
      total: 0,
      bySensitivity: zeroCounts(SENSITIVITY_CATEGORIES),
    },
    evidenceBySource: zeroCounts(MEMORY_SOURCE_TYPES),
    latestUpdatedAt: null,
  };
}

function zeroCounts<TKey extends string>(keys: readonly TKey[]): Record<TKey, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<TKey, number>;
}

function countBy<TItem, TKey extends string>(
  keys: readonly TKey[],
  items: readonly TItem[],
  selector: (item: TItem) => TKey,
): Record<TKey, number> {
  const counts = zeroCounts(keys);
  for (const item of items) {
    counts[selector(item)] += 1;
  }
  return counts;
}

function countSensitivity(records: readonly MemoryRecord[]): Record<SensitivityCategory, number> {
  const counts = zeroCounts(SENSITIVITY_CATEGORIES);
  for (const record of records) {
    for (const sensitivity of record.sensitivity) {
      counts[sensitivity] += 1;
    }
  }
  return counts;
}

function latestMemoryUpdatedAt(records: readonly MemoryRecord[]): string | null {
  return records.reduce<string | null>((latest, record) =>
    latest === null || Date.parse(record.updatedAt) > Date.parse(latest) ? record.updatedAt : latest,
  null);
}
