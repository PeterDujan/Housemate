import { normalizeWords } from "./speech-normalizer.js";
import { arrayValue, objectValue, optionalString, requiredString } from "./value-guards.js";

export type MetricKind = "energy" | "power" | "water" | "gas";
export type MetricScope = "house" | "source" | "device" | "derived";
export type MetricSource = "ha_energy_dashboard" | "live_helper" | "derived";
export type MetricComponentOperation = "add" | "subtract";

export interface MetricComponent {
  readonly metricId: string;
  readonly operation: MetricComponentOperation;
}

export interface MetricDefinition {
  readonly id: string;
  readonly label: string;
  readonly kind: MetricKind;
  readonly scope: MetricScope;
  readonly source: MetricSource;
  readonly unit: string;
  readonly aliases: readonly string[];
  readonly normalizedAliases: readonly string[];
  readonly entityId: string | null;
  readonly statisticId: string | null;
  readonly fallbackEntityIds: readonly string[];
  readonly relatedPowerEntityId: string | null;
  readonly components: readonly MetricComponent[];
}

export interface MetricCatalog {
  readonly schemaVersion: 1;
  readonly source: string;
  readonly sourceRef: string | null;
  readonly notes: readonly string[];
  readonly metrics: readonly MetricDefinition[];
}

export interface MetricResolveOptions {
  readonly kind?: MetricKind;
  readonly scope?: MetricScope;
}

export function parseMetricCatalog(raw: unknown): MetricCatalog {
  const catalog = objectValue(raw, "metric catalog");
  const schemaVersion = integerValue(catalog.schemaVersion, "metric catalog schemaVersion");
  if (schemaVersion !== 1) {
    throw new Error("metric catalog schemaVersion must be 1");
  }
  const metrics = arrayValue(catalog.metrics, "metric catalog metrics").map(parseMetricDefinition);
  assertUniqueMetricIds(metrics);
  assertUniqueMetricAliases(metrics);
  assertValidComponents(metrics);
  return {
    schemaVersion: 1,
    source: requiredString(catalog.source, "metric catalog source"),
    sourceRef: optionalString(catalog.sourceRef),
    notes: optionalStringArray(catalog.notes, "metric catalog notes"),
    metrics,
  };
}

export function resolveMetric(catalog: MetricCatalog, text: string, options: MetricResolveOptions = {}): MetricDefinition | null {
  const normalized = normalizeWords(text);
  if (!normalized) {
    return null;
  }
  const matches = catalog.metrics.filter((metric) => {
    if (options.kind && metric.kind !== options.kind) {
      return false;
    }
    if (options.scope && metric.scope !== options.scope) {
      return false;
    }
    return metric.id === normalized.replaceAll(" ", "_")
      || normalizeWords(metric.label) === normalized
      || metric.normalizedAliases.includes(normalized);
  });
  return matches.length === 1 ? (matches[0] as MetricDefinition) : null;
}

export function metricById(catalog: MetricCatalog, id: string): MetricDefinition | null {
  return catalog.metrics.find((metric) => metric.id === id) ?? null;
}

function parseMetricDefinition(raw: unknown): MetricDefinition {
  const metric = objectValue(raw, "metric definition");
  const aliases = optionalStringArray(metric.aliases, "metric aliases");
  const normalizedAliases = aliases.map(normalizeWords);
  if (normalizedAliases.some((alias) => !alias)) {
    throw new Error("metric aliases must contain searchable text");
  }
  const entityId = optionalEntityId(metric.entityId, "metric entityId");
  const statisticId = optionalEntityId(metric.statisticId, "metric statisticId");
  const components = optionalComponents(metric.components);
  if (!entityId && !statisticId && components.length === 0) {
    throw new Error("metric definition must include entityId, statisticId, or components");
  }
  return {
    id: idValue(metric.id, "metric id"),
    label: requiredString(metric.label, "metric label"),
    kind: metricKind(metric.kind),
    scope: metricScope(metric.scope),
    source: metricSource(metric.source),
    unit: requiredString(metric.unit, "metric unit"),
    aliases,
    normalizedAliases,
    entityId,
    statisticId,
    fallbackEntityIds: optionalEntityIds(metric.fallbackEntityIds, "metric fallbackEntityIds"),
    relatedPowerEntityId: optionalEntityId(metric.relatedPowerEntityId, "metric relatedPowerEntityId"),
    components,
  };
}

function assertUniqueMetricIds(metrics: readonly MetricDefinition[]): void {
  const seen = new Set<string>();
  for (const metric of metrics) {
    if (seen.has(metric.id)) {
      throw new Error(`metric catalog duplicate id: ${metric.id}`);
    }
    seen.add(metric.id);
  }
}

function assertUniqueMetricAliases(metrics: readonly MetricDefinition[]): void {
  const seen = new Map<string, string>();
  for (const metric of metrics) {
    for (const alias of [normalizeWords(metric.label), ...metric.normalizedAliases]) {
      const existing = seen.get(alias);
      if (existing && existing !== metric.id) {
        throw new Error(`metric catalog duplicate alias: ${alias}`);
      }
      seen.set(alias, metric.id);
    }
  }
}

function assertValidComponents(metrics: readonly MetricDefinition[]): void {
  const ids = new Set(metrics.map((metric) => metric.id));
  for (const metric of metrics) {
    for (const component of metric.components) {
      if (!ids.has(component.metricId)) {
        throw new Error(`metric ${metric.id} references missing component: ${component.metricId}`);
      }
    }
  }
}

function optionalComponents(value: unknown): readonly MetricComponent[] {
  if (value === undefined || value === null) {
    return [];
  }
  return arrayValue(value, "metric components").map((raw) => {
    const component = objectValue(raw, "metric component");
    const operation = requiredString(component.operation, "metric component operation");
    if (operation !== "add" && operation !== "subtract") {
      throw new Error(`metric component operation is unsupported: ${operation}`);
    }
    return {
      metricId: idValue(component.metricId, "metric component metricId"),
      operation,
    };
  });
}

function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function optionalStringArray(value: unknown, label: string): readonly string[] {
  if (value === undefined || value === null) {
    return [];
  }
  return arrayValue(value, label).map((item) => requiredString(item, label));
}

function idValue(value: unknown, label: string): string {
  const id = requiredString(value, label);
  if (!/^[a-z0-9_]+$/.test(id)) {
    throw new Error(`${label} is invalid: ${id}`);
  }
  return id;
}

function optionalEntityId(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const entityId = requiredString(value, label);
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(entityId)) {
    throw new Error(`${label} is invalid: ${entityId}`);
  }
  return entityId;
}

function optionalEntityIds(value: unknown, label: string): readonly string[] {
  if (value === undefined || value === null) {
    return [];
  }
  const entityIds = arrayValue(value, label).map((item) => optionalEntityId(item, label));
  return entityIds.filter((item): item is string => item !== null);
}

function metricKind(value: unknown): MetricKind {
  const kind = requiredString(value, "metric kind");
  if (kind !== "energy" && kind !== "power" && kind !== "water" && kind !== "gas") {
    throw new Error(`metric kind is unsupported: ${kind}`);
  }
  return kind;
}

function metricScope(value: unknown): MetricScope {
  const scope = requiredString(value, "metric scope");
  if (scope !== "house" && scope !== "source" && scope !== "device" && scope !== "derived") {
    throw new Error(`metric scope is unsupported: ${scope}`);
  }
  return scope;
}

function metricSource(value: unknown): MetricSource {
  const source = requiredString(value, "metric source");
  if (source !== "ha_energy_dashboard" && source !== "live_helper" && source !== "derived") {
    throw new Error(`metric source is unsupported: ${source}`);
  }
  return source;
}
