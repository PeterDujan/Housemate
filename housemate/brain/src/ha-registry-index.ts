
import { nonBlankString, objectValue } from "./value-guards.js";export interface HaAreaRegistryEntry {
  readonly areaId: string;
  readonly name: string;
  readonly aliases: readonly string[];
}

export interface HaDeviceRegistryEntry {
  readonly id: string;
  readonly areaId: string | null;
  readonly name: string | null;
  readonly manufacturer: string | null;
  readonly model: string | null;
}

export interface HaEntityRegistryEntry {
  readonly entityId: string;
  readonly domain: string;
  readonly areaId: string | null;
  readonly deviceId: string | null;
  readonly platform: string | null;
  readonly name: string | null;
  readonly originalName: string | null;
  readonly disabledBy: string | null;
  /** HA `hidden_by`: hidden from the house's own lists. */
  readonly hiddenBy?: string | null;
  /** HA `entity_category`: `diagnostic`/`config` describe the device itself, not its surroundings. */
  readonly entityCategory?: string | null;
}

export interface HaIndexedEntity extends HaEntityRegistryEntry {
  readonly effectiveAreaId: string | null;
  readonly effectiveAreaName: string | null;
  readonly deviceName: string | null;
  readonly nameCandidates: readonly string[];
}

export interface HaRegistryIndexInput {
  readonly areas: readonly unknown[];
  readonly devices: readonly unknown[];
  readonly entities: readonly unknown[];
}

export interface HaRegistryRoutingSnapshot {
  readonly revision: number;
  readonly complete: boolean;
  readonly index: HaRegistryIndex;
}

export class HaRegistryIndex {
  private areas = new Map<string, HaAreaRegistryEntry>();
  private devices = new Map<string, HaDeviceRegistryEntry>();
  private entities = new Map<string, HaEntityRegistryEntry>();
  private indexedEntities = new Map<string, HaIndexedEntity>();
  private revisionNumber = 0;
  private content: object = {};
  private sourceAvailable = false;
  private immutableSnapshot = false;
  private routingSnapshotCache: HaRegistryRoutingSnapshot | null = null;

  static from(input: HaRegistryIndexInput): HaRegistryIndex {
    return new HaRegistryIndex(input);
  }

  constructor(input: HaRegistryIndexInput) {
    this.replace(input);
  }

  replace(input: HaRegistryIndexInput): void {
    if (this.immutableSnapshot) {
      throw new Error("HA registry routing snapshot is immutable");
    }

    const replacementAreas = new Map<string, HaAreaRegistryEntry>();
    const replacementDevices = new Map<string, HaDeviceRegistryEntry>();
    const replacementEntities = new Map<string, HaEntityRegistryEntry>();
    for (const rawArea of input.areas) {
      const area = parseArea(rawArea);
      replacementAreas.set(area.areaId, area);
    }
    for (const rawDevice of input.devices) {
      const device = parseDevice(rawDevice);
      replacementDevices.set(device.id, device);
    }
    for (const rawEntity of input.entities) {
      const entity = parseEntity(rawEntity);
      replacementEntities.set(entity.entityId, entity);
    }
    const replacementIndexedEntities = new Map(
      [...replacementEntities.values()].map((entity) => [
        entity.entityId,
        indexEntity(entity, replacementAreas, replacementDevices),
      ]),
    );

    this.areas = replacementAreas;
    this.devices = replacementDevices;
    this.entities = replacementEntities;
    this.indexedEntities = replacementIndexedEntities;
    this.sourceAvailable = true;
    this.revisionNumber += 1;
    this.content = {};
    this.routingSnapshotCache = null;
  }

  area(areaId: string): HaAreaRegistryEntry | null {
    const area = this.areas.get(areaId);
    return area ? cloneArea(area) : null;
  }

  device(deviceId: string): HaDeviceRegistryEntry | null {
    const device = this.devices.get(deviceId);
    return device ? { ...device } : null;
  }

  /** Indexed entities are frozen and replaced with the registry, so callers share them. */
  entity(entityId: string): HaIndexedEntity | null {
    return this.indexedEntities.get(entityId) ?? null;
  }

  entitiesForArea(areaId: string): HaIndexedEntity[] {
    return [...this.indexedEntities.values()]
      .filter((entity) => entity.effectiveAreaId === areaId)
      .sort(compareEntityId);
  }

  entitiesForDevice(deviceId: string): HaIndexedEntity[] {
    return [...this.indexedEntities.values()]
      .filter((entity) => entity.deviceId === deviceId)
      .sort(compareEntityId);
  }

  allEntities(): HaIndexedEntity[] {
    return [...this.indexedEntities.values()].sort(compareEntityId);
  }

  /** The area whose name or an alias is exactly this text, ignoring case and punctuation. */
  areaNamed(text: string): HaAreaRegistryEntry | null {
    const key = areaNameKey(text);
    if (!key) return null;
    for (const area of this.areas.values()) {
      if ([area.name, ...area.aliases].some((name) => areaNameKey(name) === key)) return cloneArea(area);
    }
    return null;
  }

  devicesForArea(areaId: string): HaDeviceRegistryEntry[] {
    return [...this.devices.values()]
      .filter((device) => device.areaId === areaId)
      .map((device) => ({ ...device }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  /** O(1) readiness check for the launch-time empty registry placeholder. */
  hasEntries(): boolean {
    return this.areas.size > 0 || this.devices.size > 0 || this.entities.size > 0;
  }

  /** Monotonic source generation used to invalidate derived routing indexes. */
  revision(): number {
    return this.revisionNumber;
  }

  /** Identity of the registry content; a routing snapshot shares it with its source. */
  contentKey(): object {
    return this.content;
  }

  entityCount(): number {
    return this.entities.size;
  }

  markSourceUnavailable(): void {
    if (!this.sourceAvailable) {
      return;
    }
    this.sourceAvailable = false;
    this.revisionNumber += 1;
    this.routingSnapshotCache = null;
  }

  hasFreshSourceSnapshot(): boolean {
    return this.sourceAvailable;
  }

  /**
   * Returns a stable, isolated registry index for one source revision. It cannot be
   * replaced, so an older turn cannot observe a later live registry mutation.
   */
  routingSnapshot(): HaRegistryRoutingSnapshot {
    if (this.routingSnapshotCache === null) {
      const index = new HaRegistryIndex({ areas: [], devices: [], entities: [] });
      index.areas = new Map(this.areas);
      index.devices = new Map(this.devices);
      index.entities = new Map(this.entities);
      index.indexedEntities = new Map(this.indexedEntities);
      index.revisionNumber = this.revisionNumber;
      index.content = this.content;
      index.sourceAvailable = this.sourceAvailable;
      index.immutableSnapshot = true;
      const snapshot = Object.freeze({
        revision: this.revisionNumber,
        complete: this.sourceAvailable,
        index,
      });
      index.routingSnapshotCache = snapshot;
      Object.freeze(index);
      this.routingSnapshotCache = snapshot;
    }
    return this.routingSnapshotCache;
  }

}

function indexEntity(
  entity: HaEntityRegistryEntry,
  areas: ReadonlyMap<string, HaAreaRegistryEntry>,
  devices: ReadonlyMap<string, HaDeviceRegistryEntry>,
): HaIndexedEntity {
  const device = entity.deviceId ? devices.get(entity.deviceId) ?? null : null;
  const effectiveAreaId = entity.areaId ?? device?.areaId ?? null;
  const area = effectiveAreaId ? areas.get(effectiveAreaId) ?? null : null;
  const deviceName = device?.name ?? null;

  return Object.freeze({
    ...entity,
    effectiveAreaId,
    effectiveAreaName: area?.name ?? null,
    deviceName,
    nameCandidates: Object.freeze(uniqueStrings([
      entity.name,
      entity.originalName,
      entity.entityId,
      deviceName,
      area?.name ?? null,
      ...(area?.aliases ?? []),
    ])),
  });
}

function parseArea(rawArea: unknown): HaAreaRegistryEntry {
  const area = objectValue(rawArea, "HA area registry entry");
  const areaId = requiredRegistryString(area.area_id ?? area.id, "area area_id");
  const name = requiredRegistryString(area.name, `area name for ${areaId}`);
  return Object.freeze({
    areaId,
    name,
    aliases: Object.freeze([...stringArray(area.aliases)]),
  });
}

function parseDevice(rawDevice: unknown): HaDeviceRegistryEntry {
  const device = objectValue(rawDevice, "HA device registry entry");
  const id = requiredRegistryString(device.id, "device id");
  return Object.freeze({
    id,
    areaId: nonBlankString(device.area_id),
    name: nonBlankString(device.name_by_user) ?? nonBlankString(device.name),
    manufacturer: nonBlankString(device.manufacturer),
    model: nonBlankString(device.model),
  });
}

function parseEntity(rawEntity: unknown): HaEntityRegistryEntry {
  const entity = objectValue(rawEntity, "HA entity registry entry");
  const entityId = requiredRegistryString(entity.entity_id, "entity entity_id");
  return Object.freeze({
    entityId,
    domain: domainFromEntityId(entityId),
    areaId: nonBlankString(entity.area_id),
    deviceId: nonBlankString(entity.device_id),
    platform: nonBlankString(entity.platform),
    name: nonBlankString(entity.name),
    originalName: nonBlankString(entity.original_name),
    disabledBy: nonBlankString(entity.disabled_by),
    hiddenBy: nonBlankString(entity.hidden_by),
    entityCategory: nonBlankString(entity.entity_category),
  });
}

function domainFromEntityId(entityId: string): string {
  const [domain, objectId] = entityId.split(".", 2);
  if (!domain || !objectId) {
    throw new Error(`entity entity_id must include a domain: ${entityId}`);
  }
  return domain;
}

function requiredRegistryString(value: unknown, label: string): string {
  const parsed = nonBlankString(value);
  if (!parsed) {
    throw new Error(`HA ${label} is required`);
  }
  return parsed;
}

function stringArray(value: unknown): readonly string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("HA area aliases must be an array");
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function uniqueStrings(values: readonly (string | null)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

function areaNameKey(value: string): string {
  return value.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function cloneArea(area: HaAreaRegistryEntry): HaAreaRegistryEntry {
  return {
    ...area,
    aliases: [...area.aliases],
  };
}

function compareEntityId(left: HaIndexedEntity, right: HaIndexedEntity): number {
  return left.entityId.localeCompare(right.entityId);
}
