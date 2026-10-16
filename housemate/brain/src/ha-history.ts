import type { TimeWindow } from "./time-window-parser.js";
import { isValidHaTimestamp } from "./ha-timestamp.js";
import { objectValue } from "./value-guards.js";

export type HaStatisticPeriod = "5minute" | "hour" | "day" | "week" | "month";
export type HaStatisticType = "mean" | "min" | "max" | "state" | "sum";
export type HaHistorySource = "statistics" | "history";
export type HaHistoryConfidence = "low" | "medium" | "high";

export interface HaCommandOptions {
  readonly signal?: AbortSignal;
}

export interface HaCommandClient {
  sendCommand(
    command: Readonly<Record<string, unknown>>,
    options?: HaCommandOptions,
  ): Promise<unknown>;
}

export interface HaHistoryWindow {
  readonly start: string;
  readonly end: string;
  readonly timezone?: string;
  readonly label?: string;
}

export interface HaStatisticsQuery {
  readonly statisticIds: readonly string[];
  readonly window: HaHistoryWindow | TimeWindow;
  readonly period?: HaStatisticPeriod;
  readonly types?: readonly HaStatisticType[];
  readonly fresh?: boolean;
  readonly signal?: AbortSignal;
}

export interface HaHistoryQuery {
  readonly entityIds: readonly string[];
  readonly window: HaHistoryWindow | TimeWindow;
  readonly significantChangesOnly?: boolean;
  readonly minimalResponse?: boolean;
  readonly includeStartTimeState?: boolean;
  readonly noAttributes?: boolean;
  readonly fresh?: boolean;
  readonly signal?: AbortSignal;
}

export interface HaStatisticSample {
  readonly statisticId: string;
  readonly start: string;
  readonly end: string | null;
  readonly mean: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly state: number | null;
  readonly sum: number | null;
}

export interface HaHistoryState {
  readonly entityId: string;
  readonly state: string;
  readonly lastChanged: string;
  readonly lastUpdated: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface HaHistoryResult {
  readonly source: HaHistorySource;
  readonly confidence: HaHistoryConfidence;
  readonly window: HaHistoryWindow;
  readonly samples: readonly HaStatisticSample[];
  readonly states: readonly HaHistoryState[];
  readonly entityIds: readonly string[];
  readonly statisticIds: readonly string[];
  readonly cached: boolean;
}

export interface HaHistoryFetcherOptions {
  readonly cache?: HaHistoryCache;
}

/** Statistic ids the house's Energy dashboard is configured with (`energy/get_prefs`). */
export interface HaEnergySources {
  readonly gridImport: readonly string[];
  readonly gridExport: readonly string[];
  readonly solar: readonly string[];
  readonly batteryIn: readonly string[];
  readonly batteryOut: readonly string[];
  readonly gas: readonly string[];
  readonly water: readonly string[];
}

export const MAX_HA_STATISTICS_RESPONSE_ITEMS = 20_000;
export const MAX_HA_HISTORY_RESPONSE_ITEMS = 20_000;

export class HaHistoryFetcher {
  private readonly client: HaCommandClient;
  private readonly cache: HaHistoryCache | null;

  constructor(client: HaCommandClient, options: HaHistoryFetcherOptions = {}) {
    this.client = client;
    this.cache = options.cache ?? null;
  }

  async fetchStatistics(query: HaStatisticsQuery): Promise<HaHistoryResult> {
    query.signal?.throwIfAborted();
    validateNonEmpty(query.statisticIds, "statistics query statisticIds");
    const window = normalizeWindow(query.window);
    const cacheKey = statisticsCacheKey(query, window);
    const cached = query.fresh ? null : this.cache?.get(cacheKey);
    if (cached) {
      return markCached(cached);
    }

    const response = await this.client.sendCommand(
      {
        type: "recorder/statistics_during_period",
        start_time: window.start,
        end_time: window.end,
        statistic_ids: [...query.statisticIds],
        period: query.period ?? "hour",
        types: [...(query.types ?? DEFAULT_STATISTIC_TYPES)],
      },
      query.signal ? { signal: query.signal } : undefined,
    );
    const samples = parseStatisticsResponse(response, query.statisticIds);
    const result: HaHistoryResult = {
      source: "statistics",
      confidence: samples.length > 0 ? "high" : "low",
      window,
      samples,
      states: [],
      entityIds: [],
      statisticIds: [...query.statisticIds].sort(),
      cached: false,
    };
    if (!query.fresh) {
      this.cache?.set(cacheKey, result);
    }
    return result;
  }

  /** Read-only: which statistics the Energy dashboard uses for grid, solar, battery, gas and water. */
  async fetchEnergySources(signal?: AbortSignal): Promise<HaEnergySources> {
    signal?.throwIfAborted();
    const response = await this.client.sendCommand(
      { type: "energy/get_prefs" },
      signal ? { signal } : undefined,
    );
    return parseEnergySources(response);
  }

  async fetchHistory(query: HaHistoryQuery): Promise<HaHistoryResult> {
    query.signal?.throwIfAborted();
    validateNonEmpty(query.entityIds, "history query entityIds");
    const window = normalizeWindow(query.window);
    const cacheKey = historyCacheKey(query, window);
    const cached = query.fresh ? null : this.cache?.get(cacheKey);
    if (cached) {
      return markCached(cached);
    }

    const response = await this.client.sendCommand(
      {
        type: "history/history_during_period",
        start_time: window.start,
        end_time: window.end,
        entity_ids: [...query.entityIds],
        significant_changes_only: query.significantChangesOnly ?? false,
        minimal_response: query.minimalResponse ?? false,
        ...(query.includeStartTimeState !== undefined
          ? { include_start_time_state: query.includeStartTimeState }
          : {}),
        ...(query.noAttributes !== undefined
          ? { no_attributes: query.noAttributes }
          : {}),
      },
      query.signal ? { signal: query.signal } : undefined,
    );
    const states = parseHistoryResponse(response, query.entityIds);
    const result: HaHistoryResult = {
      source: "history",
      confidence: states.length > 0 ? "medium" : "low",
      window,
      samples: [],
      states,
      entityIds: [...query.entityIds].sort(),
      statisticIds: [],
      cached: false,
    };
    if (!query.fresh) {
      this.cache?.set(cacheKey, result);
    }
    return result;
  }

  async fetchBest(query: HaStatisticsQuery & { readonly fallbackEntityIds: readonly string[] }): Promise<HaHistoryResult> {
    const statistics = await this.fetchStatistics(query);
    if (statistics.samples.length > 0) {
      return statistics;
    }
    return this.fetchHistory({
      entityIds: query.fallbackEntityIds,
      window: query.window,
      significantChangesOnly: false,
      minimalResponse: false,
      ...(query.fresh !== undefined ? { fresh: query.fresh } : {}),
      ...(query.signal ? { signal: query.signal } : {}),
    });
  }
}

export class HaHistoryCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => Date;
  private readonly entries = new Map<string, { readonly storedAtMs: number; readonly result: HaHistoryResult }>();

  constructor(options: { readonly ttlMs?: number; readonly maxEntries?: number; readonly now?: () => Date } = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxEntries = options.maxEntries ?? 64;
    this.now = options.now ?? (() => new Date());
  }

  get(key: string): HaHistoryResult | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (this.now().getTime() - entry.storedAtMs > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return cloneResult(entry.result);
  }

  set(key: string, result: HaHistoryResult): void {
    this.entries.set(key, { storedAtMs: this.now().getTime(), result: cloneResult(result) });
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }

  snapshot(): { readonly entryCount: number; readonly keys: readonly string[] } {
    return {
      entryCount: this.entries.size,
      keys: [...this.entries.keys()].sort(),
    };
  }
}

export function parseEnergySources(response: unknown): HaEnergySources {
  const sources = isRecord(response) && Array.isArray(response.energy_sources) ? response.energy_sources : [];
  const ids = { gridImport: [], gridExport: [], solar: [], batteryIn: [], batteryOut: [], gas: [], water: [] } as Record<keyof HaEnergySources, string[]>;
  const add = (key: keyof HaEnergySources, value: unknown): void => {
    if (typeof value === "string" && /^[a-z0-9_]+[.:][a-z0-9_]+$/.test(value) && !ids[key].includes(value)) {
      ids[key].push(value);
    }
  };
  for (const source of sources) {
    if (!isRecord(source)) continue;
    switch (source.type) {
      case "grid":
        add("gridImport", source.stat_energy_from);
        add("gridExport", source.stat_energy_to);
        // Older prefs list grid meters as flows.
        for (const flow of Array.isArray(source.flow_from) ? source.flow_from : []) {
          if (isRecord(flow)) add("gridImport", flow.stat_energy_from);
        }
        for (const flow of Array.isArray(source.flow_to) ? source.flow_to : []) {
          if (isRecord(flow)) add("gridExport", flow.stat_energy_to);
        }
        break;
      case "solar":
        add("solar", source.stat_energy_from);
        break;
      case "battery":
        add("batteryOut", source.stat_energy_from);
        add("batteryIn", source.stat_energy_to);
        break;
      case "gas":
        add("gas", source.stat_energy_from);
        break;
      case "water":
        add("water", source.stat_energy_from);
        break;
    }
  }
  return ids;
}

function parseStatisticsResponse(
  response: unknown,
  requestedStatisticIds: readonly string[],
): readonly HaStatisticSample[] {
  const rows = objectValue(response, "statistics response");
  // Home Assistant leaves out a statistic with no rows in the window (for
  // example a year before the sensor existed); that is an empty answer.
  const presentStatisticIds = requestedStatisticIds.filter((statisticId) => Object.hasOwn(rows, statisticId));
  for (const statisticId of presentStatisticIds) {
    if (!Array.isArray(rows[statisticId])) {
      throw new Error(
        `statistics response for ${statisticId} must be an array`,
      );
    }
  }
  assertNestedArrayItemLimit(
    presentStatisticIds.map((statisticId) => rows[statisticId]),
    MAX_HA_STATISTICS_RESPONSE_ITEMS,
    "statistics response",
  );
  const samples: HaStatisticSample[] = [];
  for (const statisticId of presentStatisticIds) {
    const rawSamples = rows[statisticId];
    if (!Array.isArray(rawSamples)) {
      throw new Error(`statistics response for ${statisticId} must be an array`);
    }
    for (const rawSample of rawSamples) {
      const sample = objectValue(rawSample, `statistics sample for ${statisticId}`);
      samples.push({
        statisticId,
        start: isoValue(sample.start, `statistics sample start for ${statisticId}`),
        end: optionalIsoValue(sample.end, `statistics sample end for ${statisticId}`),
        mean: optionalNumber(
          sample.mean,
          `statistics sample mean for ${statisticId}`,
        ),
        min: optionalNumber(
          sample.min,
          `statistics sample min for ${statisticId}`,
        ),
        max: optionalNumber(
          sample.max,
          `statistics sample max for ${statisticId}`,
        ),
        state: optionalNumber(
          sample.state,
          `statistics sample state for ${statisticId}`,
        ),
        sum: optionalNumber(
          sample.sum,
          `statistics sample sum for ${statisticId}`,
        ),
      });
    }
  }
  return samples.sort((left, right) => left.start.localeCompare(right.start) || left.statisticId.localeCompare(right.statisticId));
}

function parseHistoryResponse(
  response: unknown,
  requestedEntityIds: readonly string[],
): readonly HaHistoryState[] {
  const groups = historyResponseGroups(response, requestedEntityIds);
  assertNestedArrayItemLimit(
    groups.map((group) => group.rows),
    MAX_HA_HISTORY_RESPONSE_ITEMS,
    "history response",
  );
  const states: HaHistoryState[] = [];
  for (const group of groups) {
    for (const rawState of group.rows) {
      const state = objectValue(rawState, "history state");
      const explicitEntityId = optionalHistoryString(
        state.entity_id,
        "history state entity_id",
      );
      if (
        explicitEntityId
        && group.entityId
        && explicitEntityId !== group.entityId
      ) {
        throw new Error(
          `history state entity_id ${explicitEntityId} did not match requested entity ${group.entityId}`,
        );
      }
      const entityId = explicitEntityId ?? group.entityId;
      if (!entityId) {
        throw new Error("history state entity_id must be a string");
      }
      const lastChanged = firstPresentValue(
        state,
        ["last_changed", "lc", "last_updated", "lu"],
      );
      const lastUpdated = firstPresentValue(
        state,
        ["last_updated", "lu", "last_changed", "lc"],
      );
      states.push({
        entityId,
        state: historyStateValue(firstPresentValue(state, ["state", "s"])),
        lastChanged: isoValue(lastChanged, "history state last_changed"),
        lastUpdated: isoValue(lastUpdated, "history state last_updated"),
        attributes: recordValue(
          firstPresentValue(state, ["attributes", "a"], {}),
        ),
      });
    }
  }
  return states.sort((left, right) => left.lastChanged.localeCompare(right.lastChanged) || left.entityId.localeCompare(right.entityId));
}

function assertNestedArrayItemLimit(
  values: readonly unknown[],
  maximum: number,
  label: string,
): void {
  let itemCount = 0;
  for (const value of values) {
    if (!Array.isArray(value)) {
      continue;
    }
    itemCount += value.length;
    if (itemCount > maximum) {
      throw new Error(`${label} exceeded its ${maximum}-item limit`);
    }
  }
}

function historyResponseGroups(
  response: unknown,
  requestedEntityIds: readonly string[],
): readonly {
  readonly entityId: string | null;
  readonly rows: readonly unknown[];
}[] {
  if (Array.isArray(response)) {
    if (response.length !== requestedEntityIds.length) {
      throw new Error(
        "history response must contain one array per requested entity",
      );
    }
    return response.map((group, index) => {
      if (!Array.isArray(group)) {
        throw new Error("history response entity groups must be arrays");
      }
      return {
        entityId: requestedEntityIds[index] ?? null,
        rows: group,
      };
    });
  }
  if (response && typeof response === "object") {
    const keyed = response as Record<string, unknown>;
    // Home Assistant leaves out an entity with no states in the window.
    return requestedEntityIds.filter((entityId) => Object.hasOwn(keyed, entityId)).map((entityId) => {
      const group = keyed[entityId];
      if (!Array.isArray(group)) {
        throw new Error(`history response for ${entityId} must be an array`);
      }
      return { entityId, rows: group };
    });
  }
  throw new Error("history response must be an array or object");
}

function normalizeWindow(window: HaHistoryWindow | TimeWindow): HaHistoryWindow {
  const start = isoValue(window.start, "history window start");
  const end = isoValue(window.end, "history window end");
  if (Date.parse(end) <= Date.parse(start)) {
    throw new Error("history window end must be after start");
  }
  return {
    start,
    end,
    ...(window.timezone ? { timezone: window.timezone } : {}),
    ...(window.label ? { label: window.label } : {}),
  };
}

function statisticsCacheKey(query: HaStatisticsQuery, window: HaHistoryWindow): string {
  return stableKey({
    source: "statistics",
    statisticIds: [...query.statisticIds].sort(),
    start: window.start,
    end: window.end,
    period: query.period ?? "hour",
    types: [...(query.types ?? DEFAULT_STATISTIC_TYPES)].sort(),
  });
}

function historyCacheKey(query: HaHistoryQuery, window: HaHistoryWindow): string {
  return stableKey({
    source: "history",
    entityIds: [...query.entityIds].sort(),
    start: window.start,
    end: window.end,
    significantChangesOnly: query.significantChangesOnly ?? false,
    minimalResponse: query.minimalResponse ?? false,
    includeStartTimeState: query.includeStartTimeState ?? true,
    noAttributes: query.noAttributes ?? false,
  });
}

function stableKey(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(value);
}

function markCached(result: HaHistoryResult): HaHistoryResult {
  return {
    ...cloneResult(result),
    cached: true,
  };
}

function cloneResult(result: HaHistoryResult): HaHistoryResult {
  return {
    ...result,
    window: { ...result.window },
    samples: result.samples.map((sample) => ({ ...sample })),
    states: result.states.map((state) => ({
      ...state,
      attributes: { ...state.attributes },
    })),
    entityIds: [...result.entityIds],
    statisticIds: [...result.statisticIds],
  };
}

function validateNonEmpty(values: readonly string[], label: string): void {
  if (values.length === 0 || values.some((value) => !value.trim())) {
    throw new Error(`${label} must include at least one value`);
  }
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("history state attributes must be an object");
  }
  return { ...(value as Record<string, unknown>) };
}

function historyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function optionalHistoryString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return historyString(value, label);
}

function historyStateValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return historyString(value, "history state state");
}

function isoValue(value: unknown, label: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const epochMs = Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
    const parsedEpoch = new Date(epochMs);
    if (!Number.isFinite(parsedEpoch.getTime())) {
      throw new Error(`${label} must be ISO-like`);
    }
    return parsedEpoch.toISOString();
  }
  const parsed = historyString(value, label);
  if (!isValidHaTimestamp(parsed)) {
    throw new Error(`${label} must be ISO-like`);
  }
  return new Date(parsed).toISOString();
}

function optionalIsoValue(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return isoValue(value, label);
}

function optionalNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must be a finite number`);
    }
    return value;
  }
  if (typeof value === "string" && !value.trim()) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a finite number`);
  }
  const text = value.trim();
  if (!DECIMAL_NUMBER_PATTERN.test(text)) {
    throw new Error(`${label} must be a finite number`);
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a finite number`);
  }
  return parsed;
}

function firstPresentValue(
  input: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  fallback?: unknown,
): unknown {
  for (const key of keys) {
    if (Object.hasOwn(input, key)) {
      return input[key];
    }
  }
  return fallback;
}

const DEFAULT_STATISTIC_TYPES: readonly HaStatisticType[] = ["mean", "min", "max", "state", "sum"];
const DECIMAL_NUMBER_PATTERN =
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
