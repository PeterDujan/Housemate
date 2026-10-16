import type { HaRegistryIndex } from "./ha-registry-index.js";
import type { HaEntityState } from "./ha-state-cache.js";
import { nonBlankString } from "./value-guards.js";

export type HaCapability =
  | "toggle"
  | "turn_on"
  | "turn_off"
  | "brightness"
  | "color"
  | "temperature"
  | "humidity"
  | "energy"
  | "power"
  | "open"
  | "close"
  | "position"
  | "lock"
  | "unlock"
  | "fan_speed"
  | "media_playback";

export interface HaCapabilityEntity {
  readonly entityId: string;
  readonly domain: string;
  readonly friendlyName: string | null;
  readonly deviceClass: string | null;
  readonly capabilities: readonly HaCapability[];
  readonly state: string;
  readonly areaId: string | null;
  readonly areaName: string | null;
  readonly deviceId: string | null;
  readonly deviceName: string | null;
  readonly available: boolean;
  /** HA `entity_category`; `diagnostic`/`config` readings describe the device, not the room. */
  readonly entityCategory?: string | null;
}

export interface HaCapabilityIndexSnapshot {
  readonly entityCount: number;
  readonly capabilityCounts: Readonly<Record<HaCapability, number>>;
}

/**
 * Domain capabilities of every entity with state, built once per HA state
 * change and shared. Entities and lists are frozen and handed out as they
 * are; do not mutate them (it throws).
 */
export class HaCapabilityIndex {
  private readonly entities = new Map<string, HaCapabilityEntity>();
  private readonly sorted: readonly HaCapabilityEntity[];
  private readonly byCapability = new Map<HaCapability, readonly HaCapabilityEntity[]>();

  constructor(states: readonly HaEntityState[], registryIndex: HaRegistryIndex) {
    for (const state of states) {
      const registryEntity = registryIndex.entity(state.entityId);
      const domain = registryEntity?.domain ?? domainFromEntityId(state.entityId);
      this.entities.set(state.entityId, Object.freeze({
        entityId: state.entityId,
        domain,
        friendlyName: friendlyNameForState(state),
        deviceClass: nonBlankString(state.attributes.device_class),
        capabilities: Object.freeze([...capabilitiesForState(domain, state)]),
        state: state.state,
        areaId: registryEntity?.effectiveAreaId ?? null,
        areaName: registryEntity?.effectiveAreaName ?? null,
        deviceId: registryEntity?.deviceId ?? null,
        deviceName: registryEntity?.deviceName ?? null,
        available: !["unavailable", "unknown"].includes(state.state),
        entityCategory: registryEntity?.entityCategory ?? null,
      }));
    }
    this.sorted = Object.freeze([...this.entities.values()].sort(compareEntityId));
    Object.freeze(this);
  }

  get size(): number {
    return this.entities.size;
  }

  entity(entityId: string): HaCapabilityEntity | null {
    return this.entities.get(entityId) ?? null;
  }

  /** Every entity, sorted by entity id. */
  entries(): readonly HaCapabilityEntity[] {
    return this.sorted;
  }

  entitiesWithCapability(capability: HaCapability): readonly HaCapabilityEntity[] {
    let result = this.byCapability.get(capability);
    if (!result) {
      result = Object.freeze(this.entries().filter((entity) => entity.capabilities.includes(capability)));
      this.byCapability.set(capability, result);
    }
    return result;
  }

  entitiesForAreaWithCapability(areaId: string, capability: HaCapability): readonly HaCapabilityEntity[] {
    return this.entitiesWithCapability(capability).filter((entity) => entity.areaId === areaId);
  }

  snapshot(): HaCapabilityIndexSnapshot {
    const capabilityCounts = Object.fromEntries(
      HA_CAPABILITIES.map((capability) => [
        capability,
        this.entitiesWithCapability(capability).length,
      ]),
    ) as Record<HaCapability, number>;
    return {
      entityCount: this.entities.size,
      capabilityCounts,
    };
  }
}

function friendlyNameForState(state: HaEntityState): string | null {
  const friendlyName = state.attributes.friendly_name;
  return typeof friendlyName === "string" && friendlyName.trim() ? friendlyName.trim() : null;
}

export const HA_CAPABILITIES: readonly HaCapability[] = [
  "toggle",
  "turn_on",
  "turn_off",
  "brightness",
  "color",
  "temperature",
  "humidity",
  "energy",
  "power",
  "open",
  "close",
  "position",
  "lock",
  "unlock",
  "fan_speed",
  "media_playback",
];

function capabilitiesForState(domain: string, state: HaEntityState): readonly HaCapability[] {
  switch (domain) {
    case "light":
      return lightCapabilities(state);
    case "switch":
    case "input_boolean":
      return ["toggle", "turn_on", "turn_off"];
    case "cover":
      return ["open", "close", "position"];
    case "lock":
      return ["lock", "unlock"];
    case "fan":
      return ["toggle", "turn_on", "turn_off", "fan_speed"];
    case "media_player":
      return ["media_playback"];
    case "climate":
      return ["temperature"];
    case "sensor":
      return sensorCapabilities(state);
    default:
      return [];
  }
}

function lightCapabilities(state: HaEntityState): readonly HaCapability[] {
  const colorModes = stringArray(state.attributes.supported_color_modes);
  const capabilities: HaCapability[] = ["toggle", "turn_on", "turn_off"];
  if (
    colorModes.some((mode) => ["brightness", "color_temp", "hs", "rgb", "rgbw", "rgbww", "xy"].includes(mode)) ||
    typeof state.attributes.brightness === "number"
  ) {
    capabilities.push("brightness");
  }
  if (colorModes.some((mode) => ["hs", "rgb", "rgbw", "rgbww", "xy"].includes(mode))) {
    capabilities.push("color");
  }
  return capabilities;
}

function sensorCapabilities(state: HaEntityState): readonly HaCapability[] {
  const deviceClass = nonBlankString(state.attributes.device_class);
  if (deviceClass === "temperature") {
    return ["temperature"];
  }
  if (deviceClass === "humidity") {
    return ["humidity"];
  }
  if (deviceClass === "energy") {
    return ["energy"];
  }
  if (deviceClass === "power") {
    return ["power"];
  }
  return [];
}

function domainFromEntityId(entityId: string): string {
  const [domain, objectId] = entityId.split(".", 2);
  if (!domain || !objectId) {
    throw new Error(`entity_id must include a domain: ${entityId}`);
  }
  return domain;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

function compareEntityId(left: HaCapabilityEntity, right: HaCapabilityEntity): number {
  return left.entityId.localeCompare(right.entityId);
}
