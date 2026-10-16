import { HA_CAPABILITIES, type HaCapability } from "./ha-capability-index.js";
import { normalizeWords } from "./speech-normalizer.js";
import { objectValue, optionalString, requiredString } from "./value-guards.js";

export { normalizeWords as normalizeAlias };

export type AliasTargetKind = "entity" | "group" | "area" | "capability";

export interface AliasTargetBase {
  readonly kind: AliasTargetKind;
}

export interface EntityAliasTarget extends AliasTargetBase {
  readonly kind: "entity";
  readonly entityId: string;
}

export interface GroupAliasTarget extends AliasTargetBase {
  readonly kind: "group";
  readonly entityIds: readonly string[];
}

export interface AreaAliasTarget extends AliasTargetBase {
  readonly kind: "area";
  readonly areaId: string;
}

export interface CapabilityAliasTarget extends AliasTargetBase {
  readonly kind: "capability";
  readonly capability: HaCapability;
  readonly areaId?: string;
  readonly domain?: string;
}

export type AliasTarget =
  | EntityAliasTarget
  | GroupAliasTarget
  | AreaAliasTarget
  | CapabilityAliasTarget;

export interface AliasEntry {
  readonly alias: string;
  readonly normalizedAlias: string;
  readonly target: AliasTarget;
  readonly notes?: string;
}

export interface AliasMap {
  readonly schemaVersion: 1;
  readonly entries: readonly AliasEntry[];
}

export function parseAliasMap(raw: unknown): AliasMap {
  const map = objectValue(raw, "alias map");
  const schemaVersion = numberValue(map.schemaVersion);
  if (schemaVersion !== 1) {
    throw new Error("alias map schemaVersion must be 1");
  }
  if (!Array.isArray(map.entries)) {
    throw new Error("alias map entries must be an array");
  }

  const entries = map.entries.map(parseAliasEntry);
  assertUniqueAliases(entries);
  return {
    schemaVersion: 1,
    entries,
  };
}

function parseAliasEntry(raw: unknown): AliasEntry {
  const entry = objectValue(raw, "alias entry");
  const alias = requiredString(entry.alias, "alias entry alias");
  const normalizedAlias = normalizeWords(alias);
  if (!normalizedAlias) {
    throw new Error("alias entry alias must contain searchable text");
  }

  return {
    alias,
    normalizedAlias,
    target: parseAliasTarget(entry.target),
    ...(optionalString(entry.notes) ? { notes: optionalString(entry.notes) as string } : {}),
  };
}

function parseAliasTarget(raw: unknown): AliasTarget {
  const target = objectValue(raw, "alias target");
  const kind = requiredString(target.kind, "alias target kind");
  switch (kind) {
    case "entity":
      return {
        kind,
        entityId: entityIdValue(target.entityId),
      };
    case "group":
      return {
        kind,
        entityIds: entityIdsValue(target.entityIds),
      };
    case "area":
      return {
        kind,
        areaId: requiredString(target.areaId, "alias target areaId"),
      };
    case "capability":
      return parseCapabilityAliasTarget(target);
    default:
      throw new Error(`alias target kind is not supported: ${kind}`);
  }
}

function parseCapabilityAliasTarget(target: Record<string, unknown>): CapabilityAliasTarget {
  const parsed = {
    kind: "capability" as const,
    capability: capabilityValue(target.capability),
    ...(optionalString(target.areaId) ? { areaId: optionalString(target.areaId) as string } : {}),
    ...(optionalString(target.domain) ? { domain: optionalString(target.domain) as string } : {}),
  };
  if (!parsed.areaId && !parsed.domain) {
    throw new Error("capability alias target must include areaId, domain, or both");
  }
  return parsed;
}

function assertUniqueAliases(entries: readonly AliasEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.normalizedAlias)) {
      throw new Error(`alias map duplicate alias: ${entry.alias}`);
    }
    seen.add(entry.normalizedAlias);
  }
}

function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("alias map schemaVersion must be an integer");
  }
  return value;
}

function entityIdValue(value: unknown): string {
  const entityId = requiredString(value, "alias target entityId");
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(entityId)) {
    throw new Error(`alias target entityId is invalid: ${entityId}`);
  }
  return entityId;
}

function entityIdsValue(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error("alias target entityIds must be an array");
  }
  const entityIds = value.map(entityIdValue);
  if (entityIds.length === 0) {
    throw new Error("group alias target must include at least one entityId");
  }
  if (new Set(entityIds).size !== entityIds.length) {
    throw new Error("group alias target entityIds must be unique");
  }
  return entityIds;
}

function capabilityValue(value: unknown): HaCapability {
  const capability = requiredString(value, "alias target capability");
  if (!CAPABILITIES.includes(capability as HaCapability)) {
    throw new Error(`alias target capability is not supported: ${capability}`);
  }
  return capability as HaCapability;
}

const CAPABILITIES = HA_CAPABILITIES;
