import type { HaWebSocketMessage } from "./ha-websocket.js";
import { nonBlankString, objectValue } from "./value-guards.js";

export interface HaEntityState {
  readonly entityId: string;
  readonly state: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly lastChanged: string;
  readonly lastUpdated: string;
  readonly context: unknown;
}

export interface HaStateRoutingSnapshot {
  readonly revision: number;
  /** Replaced only when an entity comes or goes or its name or device class changes. */
  readonly shape: object;
  readonly complete: boolean;
  readonly entries: readonly HaEntityState[];
}

export class HaStateCache {
  private readonly states = new Map<string, HaEntityState>();
  private stateSnapshotComplete = false;
  private stateSourceAvailable = false;
  private revisionNumber = 0;
  private shape: object = {};
  private routingSnapshotCache: HaStateRoutingSnapshot | null = null;

  applyStateList(rawStates: readonly unknown[]): void {
    const replacement = new Map<string, HaEntityState>();
    for (const rawState of rawStates) {
      const state = parseEntityState(rawState);
      replacement.set(state.entityId, state);
    }

    this.states.clear();
    for (const [entityId, state] of replacement) {
      this.states.set(entityId, state);
    }
    this.stateSnapshotComplete = true;
    this.stateSourceAvailable = true;
    this.shape = {};
    this.markChanged();
  }

  handleMessage(message: HaWebSocketMessage): void {
    if (message.type !== "event") {
      return;
    }

    const event = objectValue(message.event, "HA websocket state payload");
    if (event.event_type !== "state_changed") {
      return;
    }

    const data = objectValue(event.data, "HA websocket state payload");
    const entityId = nonBlankString(data.entity_id);
    if (!entityId) {
      throw new Error("state_changed event entity_id is required");
    }
    if (data.new_state === null) {
      this.states.delete(entityId);
        this.shape = {};
      this.markChanged();
      return;
    }

    const state = parseEntityState(data.new_state);
    if (state.entityId !== entityId) {
      throw new Error("state_changed event entity_id must match new_state.entity_id");
    }
    const previous = this.states.get(entityId);
    if (!previous
      || previous.attributes.friendly_name !== state.attributes.friendly_name
      || previous.attributes.device_class !== state.attributes.device_class) {
      this.shape = {};
    }
    this.states.set(entityId, state);
    this.markChanged();
  }

  /** States are deeply frozen and replaced on change, so callers share them. */
  get(entityId: string): HaEntityState | null {
    return this.states.get(entityId) ?? null;
  }

  has(entityId: string): boolean {
    return this.states.has(entityId);
  }

  entries(): HaEntityState[] {
    return [...this.states.values()];
  }

  size(): number {
    return this.states.size;
  }

  /** O(1) readiness check; avoids cloning and sorting the full state snapshot per turn. */
  hasReceivedStateSnapshot(): boolean {
    return this.stateSnapshotComplete && this.stateSourceAvailable;
  }

  /**
   * Marks live state truth unavailable without discarding the last complete snapshot.
   * Only a subsequent successful state-list snapshot restores routing readiness.
   */
  markSourceUnavailable(): void {
    if (!this.stateSourceAvailable) {
      return;
    }
    this.stateSourceAvailable = false;
    this.markChanged();
  }

  /** Monotonic source generation used to invalidate derived routing indexes. */
  revision(): number {
    return this.revisionNumber;
  }

  /**
   * Stable, deeply immutable state input for routing. The same object is reused until
   * a complete snapshot or state_changed event advances the source revision.
   */
  routingSnapshot(): HaStateRoutingSnapshot {
    if (this.routingSnapshotCache === null) {
      this.routingSnapshotCache = Object.freeze({
        revision: this.revisionNumber,
        shape: this.shape,
        complete: this.hasReceivedStateSnapshot(),
        entries: Object.freeze([...this.states.values()]),
      });
    }
    return this.routingSnapshotCache;
  }

  private markChanged(): void {
    this.revisionNumber += 1;
    this.routingSnapshotCache = null;
  }
}

function parseEntityState(rawState: unknown): HaEntityState {
  const state = objectValue(rawState, "HA websocket state payload");
  const entityId = nonBlankString(state.entity_id);
  const stateValue = stringOrNull(state.state);
  const lastChanged = nonBlankString(state.last_changed);
  const lastUpdated = nonBlankString(state.last_updated);
  if (!entityId) {
    throw new Error("HA entity state entity_id is required");
  }
  if (stateValue === null) {
    throw new Error(`HA entity state is required for ${entityId}`);
  }
  if (!lastChanged) {
    throw new Error(`HA entity last_changed is required for ${entityId}`);
  }
  if (!lastUpdated) {
    throw new Error(`HA entity last_updated is required for ${entityId}`);
  }
  return deepFreeze({
    entityId,
    state: stateValue,
    attributes: cloneAttributes(state.attributes),
    lastChanged,
    lastUpdated,
    context: structuredCloneOrNull(state.context),
  });
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function cloneAttributes(value: unknown): Readonly<Record<string, unknown>> {
  if (value === undefined || value === null) {
    return {};
  }
  return structuredCloneOrNull(objectValue(value, "HA websocket state payload")) as Readonly<Record<string, unknown>>;
}

function structuredCloneOrNull(value: unknown): unknown {
  return value === undefined ? null : structuredClone(value);
}

export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

/** The entity's friendly name, or its entity id. */
export function friendlyName(state: HaEntityState): string {
  const value = state.attributes.friendly_name;
  return typeof value === "string" && value.trim() ? value.trim() : state.entityId;
}

export function isUnavailableState(state: HaEntityState): boolean {
  return state.state === "unavailable" || state.state === "unknown";
}

/** A person entity counts as present in any zone except away/not_home or unreadable. */
export function personPresent(rawState: string): boolean {
  const normalized = rawState.trim().toLowerCase();
  return normalized !== "" && normalized !== "not_home" && normalized !== "away" && normalized !== "unknown" && normalized !== "unavailable";
}

/** A door/window style state: true open, false closed, null unknown. */
export function openingOpen(rawState: string): boolean | null {
  const normalized = rawState.trim().toLowerCase();
  if (normalized === "on" || normalized === "open") {
    return true;
  }
  if (normalized === "off" || normalized === "closed") {
    return false;
  }
  return null;
}

/** A string attribute, trimmed, or "". */
export function attributeText(state: HaEntityState, key: string): string {
  const value = state.attributes[key];
  return typeof value === "string" ? value.trim() : "";
}

/** The domain part of an entity id, or "". */
/**
 * HA keeps the garage door as a lock driven by its door sensor: for
 * that lock, locked means closed and unlocked means open. A real lock is a bolt.
 */
export function isGarageDoorLock(entityId: string, name: string): boolean {
  return entityId.startsWith("lock.") && /\bgarage\b/i.test(`${name} ${entityId.replaceAll("_", " ")}`);
}

export function domainFromEntityId(entityId: string): string {
  return entityId.split(".", 1)[0] ?? "";
}

/** The friendly name without a "Lights - " group prefix. */
export function shortFriendlyName(state: HaEntityState): string {
  return friendlyName(state).replace(/^lights\s*-\s*/i, "").trim();
}
