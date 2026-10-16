import type { HaHistoryResult, HaHistorySource, HaHistoryState, HaStatisticSample, HaHistoryWindow } from "./ha-history.js";

export type MathResultKind = "energy_used" | "cost_estimate" | "runtime_duration" | "average_peak";
export type MathConfidence = "low" | "medium" | "high";

export interface MathSourceReport {
  readonly source: HaHistorySource;
  readonly confidence: MathConfidence;
  readonly entityIds: readonly string[];
  readonly statisticIds: readonly string[];
  readonly sampleCount: number;
  readonly stateCount: number;
  readonly cached: boolean;
}

export interface MathResultBase {
  readonly kind: MathResultKind;
  readonly window: HaHistoryWindow;
  readonly confidence: MathConfidence;
  readonly source: MathSourceReport;
  readonly notes: readonly string[];
}

export interface EnergyUsedResult extends MathResultBase {
  readonly kind: "energy_used";
  readonly kWh: number | null;
}

export type MetricAggregation = "sum" | "average" | "minimum" | "maximum" | "delta";
export type MetricComparison = "difference" | "percent_change" | "higher_lower";

export interface MetricPoint {
  readonly timestamp: string;
  readonly value: number;
  readonly unit: string | null;
}

export interface MetricMathOk {
  readonly status: "ok";
  readonly value: number;
  readonly unit: string | null;
  readonly notes: readonly string[];
  readonly sampleCount: number;
}

export interface MetricMathDeclined {
  readonly status: "declined";
  readonly reason: string;
  readonly notes: readonly string[];
  readonly sampleCount: number;
}

export type MetricMathResult = MetricMathOk | MetricMathDeclined;

export interface MetricComparisonOk extends MetricMathOk {
  readonly comparison: MetricComparison;
  readonly direction: "higher" | "lower" | "same" | null;
}

export type MetricComparisonResult = MetricComparisonOk | MetricMathDeclined;

export function calculateMetricAggregation(points: readonly MetricPoint[], aggregation: MetricAggregation): MetricMathResult {
  const normalized = normalizeMetricPoints(points);
  if (normalized.status === "declined") {
    return normalized;
  }
  const values = normalized.points.map((point) => point.value);
  if (values.length === 0) {
    return declineMetric("no numeric metric samples", points.length);
  }

  switch (aggregation) {
    case "sum":
      return okMetric(values.reduce((sum, value) => sum + value, 0), normalized.unit, ["sum calculated from numeric samples"], values.length);
    case "average":
      return okMetric(values.reduce((sum, value) => sum + value, 0) / values.length, normalized.unit, ["average calculated from numeric samples"], values.length);
    case "minimum":
      return okMetric(Math.min(...values), normalized.unit, ["minimum calculated from numeric samples"], values.length);
    case "maximum":
      return okMetric(Math.max(...values), normalized.unit, ["maximum calculated from numeric samples"], values.length);
    case "delta":
      if (values.length < 2) {
        return declineMetric("delta requires at least two samples", points.length);
      }
      return okMetric((values[values.length - 1] as number) - (values[0] as number), normalized.unit, ["delta calculated from first and last sample"], values.length);
    default:
      return declineMetric("unsupported metric aggregation", points.length);
  }
}

export function calculateEnergyFromPower(points: readonly MetricPoint[]): MetricMathResult {
  const normalized = normalizeMetricPoints(points);
  if (normalized.status === "declined") {
    return normalized;
  }
  if (normalized.unit !== "W") {
    return declineMetric("energy integration requires power samples in W or kW", points.length);
  }
  const sorted = [...normalized.points].sort((left, right) => left.timestampMs - right.timestampMs);
  if (sorted.length < 2) {
    return declineMetric("energy integration requires at least two timestamped power samples", points.length);
  }

  let wattHours = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1] as NormalizedMetricPoint;
    const current = sorted[index] as NormalizedMetricPoint;
    const hours = (current.timestampMs - previous.timestampMs) / 3_600_000;
    if (hours < 0) {
      return declineMetric("power samples must be sorted by valid timestamps", points.length);
    }
    wattHours += ((previous.value + current.value) / 2) * hours;
  }
  return okMetric(wattHours / 1000, "kWh", ["energy integrated from timestamped power samples"], sorted.length);
}

export function compareMetricValues(left: MetricMathOk, right: MetricMathOk, comparison: MetricComparison): MetricComparisonResult {
  const normalizedLeft = normalizeMetricValue(left.value, left.unit);
  const normalizedRight = normalizeMetricValue(right.value, right.unit);
  if (!normalizedLeft || !normalizedRight) {
    return declineMetric("comparison requires supported units", left.sampleCount + right.sampleCount);
  }
  if (normalizedLeft.dimension !== normalizedRight.dimension) {
    return declineMetric("comparison requires compatible units", left.sampleCount + right.sampleCount);
  }

  const difference = normalizedLeft.value - normalizedRight.value;
  if (comparison === "difference") {
    return okComparison(difference, normalizedLeft.unit, comparison, directionFromDifference(difference), left.sampleCount + right.sampleCount, ["difference calculated after unit normalization"]);
  }
  if (comparison === "percent_change") {
    if (normalizedRight.value === 0) {
      return declineMetric("percent change requires a non-zero comparison baseline", left.sampleCount + right.sampleCount);
    }
    return okComparison((difference / Math.abs(normalizedRight.value)) * 100, "%", comparison, directionFromDifference(difference), left.sampleCount + right.sampleCount, ["percent change calculated from normalized values"]);
  }
  if (comparison === "higher_lower") {
    return okComparison(Math.sign(difference), null, comparison, directionFromDifference(difference), left.sampleCount + right.sampleCount, ["higher/lower comparison calculated from normalized values"]);
  }
  return declineMetric("unsupported metric comparison", left.sampleCount + right.sampleCount);
}

export function buildWindowedEnergyUsedResult(history: HaHistoryResult, targetWindow: HaHistoryWindow): EnergyUsedResult {
  const statistics = energyFromStatisticsWithinWindow(history.samples, targetWindow);
  if (statistics !== null) {
    return {
      kind: "energy_used",
      window: targetWindow,
      confidence: sourceConfidence(history, "high"),
      source: sourceReport(history),
      notes: ["energy derived from cumulative statistics across the target window"],
      kWh: round(statistics, 4),
    };
  }

  const states = numericStateDeltaWithinWindow(history.states, targetWindow);
  if (states !== null) {
    return {
      kind: "energy_used",
      window: targetWindow,
      confidence: sourceConfidence(history, "medium"),
      source: sourceReport(history),
      notes: ["energy derived from cumulative history states across the target window"],
      kWh: round(states, 4),
    };
  }

  return {
    kind: "energy_used",
    window: targetWindow,
    confidence: "low",
    source: sourceReport(history),
    notes: ["no usable cumulative energy data found"],
    kWh: null,
  };
}

export function sourceReport(history: HaHistoryResult): MathSourceReport {
  return {
    source: history.source,
    confidence: history.confidence,
    entityIds: [...history.entityIds],
    statisticIds: [...history.statisticIds],
    sampleCount: history.samples.length,
    stateCount: history.states.length,
    cached: history.cached,
  };
}

function energyFromStatisticsWithinWindow(samples: readonly HaStatisticSample[], targetWindow: HaHistoryWindow): number | null {
  const startMs = Date.parse(targetWindow.start);
  const endMs = Date.parse(targetWindow.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return null;
  }
  const points = samples
    .map((sample) => ({
      timestampMs: Date.parse(sample.start),
      value: sample.sum ?? sample.state,
    }))
    .filter((sample): sample is { readonly timestampMs: number; readonly value: number } => Number.isFinite(sample.timestampMs) && sample.value !== null && Number.isFinite(sample.value))
    .sort((left, right) => left.timestampMs - right.timestampMs);
  if (points.length === 0) {
    return null;
  }
  const baseline = lastPointAtOrBefore(points, startMs);
  const latest = lastPointAtOrBefore(points, endMs);
  if (!latest) {
    return null;
  }
  if (latest.timestampMs < startMs) {
    return baseline ? 0 : null;
  }
  if (baseline) {
    return Math.max(0, latest.value - baseline.value);
  }
  const inWindow = points.filter((point) => point.timestampMs >= startMs && point.timestampMs <= endMs);
  if (inWindow.length < 2) {
    return null;
  }
  const first = inWindow[0] as { readonly timestampMs: number; readonly value: number };
  const last = inWindow[inWindow.length - 1] as { readonly timestampMs: number; readonly value: number };
  return Math.max(0, last.value - first.value);
}

function numericStateDeltaWithinWindow(states: readonly HaHistoryState[], targetWindow: HaHistoryWindow): number | null {
  const startMs = Date.parse(targetWindow.start);
  const endMs = Date.parse(targetWindow.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return null;
  }
  const points = states
    .map((state) => ({
      timestampMs: Date.parse(state.lastChanged),
      value: Number(state.state),
    }))
    .filter((state): state is { readonly timestampMs: number; readonly value: number } => Number.isFinite(state.timestampMs) && Number.isFinite(state.value))
    .sort((left, right) => left.timestampMs - right.timestampMs);
  if (points.length === 0) {
    return null;
  }
  const baseline = lastPointAtOrBefore(points, startMs);
  const latest = lastPointAtOrBefore(points, endMs);
  if (!latest) {
    return null;
  }
  if (latest.timestampMs < startMs) {
    return baseline ? 0 : null;
  }
  if (baseline) {
    return Math.max(0, latest.value - baseline.value);
  }
  const inWindow = points.filter((point) => point.timestampMs >= startMs && point.timestampMs <= endMs);
  if (inWindow.length < 2) {
    return null;
  }
  const first = inWindow[0] as { readonly timestampMs: number; readonly value: number };
  const last = inWindow[inWindow.length - 1] as { readonly timestampMs: number; readonly value: number };
  return Math.max(0, last.value - first.value);
}

function sourceConfidence(history: HaHistoryResult, fallback: MathConfidence): MathConfidence {
  if (history.confidence === "low") {
    return "low";
  }
  return history.source === "statistics" ? "high" : fallback;
}

interface NormalizedMetricPoint {
  readonly timestamp: string;
  readonly timestampMs: number;
  readonly value: number;
  readonly unit: string | null;
}

type MetricDimension = "power" | "energy" | "temperature" | "ratio" | "duration" | "unitless";

function normalizeMetricPoints(points: readonly MetricPoint[]): MetricMathDeclined | {
  readonly status: "ok";
  readonly points: readonly NormalizedMetricPoint[];
  readonly unit: string | null;
} {
  const normalized: NormalizedMetricPoint[] = [];
  let unit: string | null = null;
  let dimension: MetricDimension | null = null;
  for (const point of points) {
    const timestampMs = Date.parse(point.timestamp);
    if (!Number.isFinite(timestampMs)) {
      return declineMetric("metric sample has invalid timestamp", points.length);
    }
    const value = normalizeMetricValue(point.value, point.unit);
    if (!value) {
      return declineMetric("metric sample has unsupported or non-numeric unit", points.length);
    }
    if (dimension !== null && value.dimension !== dimension) {
      return declineMetric("metric samples have mixed unit dimensions", points.length);
    }
    dimension = value.dimension;
    unit = value.unit;
    normalized.push({
      timestamp: point.timestamp,
      timestampMs,
      value: value.value,
      unit: value.unit,
    });
  }
  return {
    status: "ok",
    points: normalized.sort((left, right) => left.timestampMs - right.timestampMs),
    unit,
  };
}

function normalizeMetricValue(value: number, unit: string | null): {
  readonly value: number;
  readonly unit: string | null;
  readonly dimension: MetricDimension;
} | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  const clean = normalizeUnit(unit);
  switch (clean) {
    case null:
      return { value, unit: null, dimension: "unitless" };
    case "W":
      return { value, unit: "W", dimension: "power" };
    case "kW":
      return { value: value * 1000, unit: "W", dimension: "power" };
    case "Wh":
      return { value: value / 1000, unit: "kWh", dimension: "energy" };
    case "kWh":
      return { value, unit: "kWh", dimension: "energy" };
    case "C":
      return { value, unit: "C", dimension: "temperature" };
    case "%":
      return { value, unit: "%", dimension: "ratio" };
    case "s":
      return { value, unit: "s", dimension: "duration" };
    case "min":
      return { value: value * 60, unit: "s", dimension: "duration" };
    case "h":
      return { value: value * 3600, unit: "s", dimension: "duration" };
    default:
      return null;
  }
}

function normalizeUnit(unit: string | null): string | null {
  const clean = unit?.trim();
  if (!clean) {
    return null;
  }
  if (clean === "W" || clean === "watt" || clean === "watts") {
    return "W";
  }
  if (clean === "kW" || clean === "kw" || clean === "kilowatt" || clean === "kilowatts") {
    return "kW";
  }
  if (clean === "Wh" || clean === "wh" || clean === "watt hour" || clean === "watt hours") {
    return "Wh";
  }
  if (clean === "kWh" || clean === "kwh" || clean === "kilowatt hour" || clean === "kilowatt hours") {
    return "kWh";
  }
  if (clean === "C" || clean === "°C" || clean === "celsius") {
    return "C";
  }
  if (clean === "%") {
    return "%";
  }
  if (clean === "s" || clean === "sec" || clean === "second" || clean === "seconds") {
    return "s";
  }
  if (clean === "min" || clean === "minute" || clean === "minutes") {
    return "min";
  }
  if (clean === "h" || clean === "hr" || clean === "hour" || clean === "hours") {
    return "h";
  }
  return clean;
}

function okMetric(value: number, unit: string | null, notes: readonly string[], sampleCount: number): MetricMathOk {
  return {
    status: "ok",
    value: round(value, 6),
    unit,
    notes,
    sampleCount,
  };
}

function okComparison(
  value: number,
  unit: string | null,
  comparison: MetricComparison,
  direction: "higher" | "lower" | "same",
  sampleCount: number,
  notes: readonly string[],
): MetricComparisonOk {
  return {
    ...okMetric(value, unit, notes, sampleCount),
    comparison,
    direction,
  };
}

function declineMetric(reason: string, sampleCount: number): MetricMathDeclined {
  return {
    status: "declined",
    reason,
    notes: [reason],
    sampleCount,
  };
}

function directionFromDifference(difference: number): "higher" | "lower" | "same" {
  if (Math.abs(difference) < 0.000001) {
    return "same";
  }
  return difference > 0 ? "higher" : "lower";
}

function round(value: number, decimals: number): number {
  const multiplier = 10 ** decimals;
  return Math.round(value * multiplier) / multiplier;
}

function lastPointAtOrBefore<T extends { readonly timestampMs: number }>(points: readonly T[], targetMs: number): T | null {
  let match: T | null = null;
  for (const point of points) {
    if (point.timestampMs <= targetMs) {
      match = point;
      continue;
    }
    break;
  }
  return match;
}
