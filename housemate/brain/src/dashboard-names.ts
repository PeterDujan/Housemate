import { normalizeAlias, type AliasEntry } from "./alias-schema.js";
import type { AliasStore } from "./alias-store.js";
import type { HaRegistryIndex } from "./ha-registry-index.js";
import type { HaStateCache } from "./ha-state-cache.js";
import type { VoiceExposure } from "./voice-exposure.js";
import { assistantName } from "./persona.js";

/**
 * The dashboard's "My X" names editor and read-only roster.
 * The owner types an exact name for one or more real HA entities; the assistant never
 * invents or learns names. Saves go to `aliases.json` and into the live
 * alias list the brain already reads, so they work on the next turn.
 * People rows (`person.*`) and area/capability rows stay as the file has
 * them. Supervisor ingress only; the server checks that first.
 */

const MAX_ALIAS_CHARS = 60;
const MAX_NOTES_CHARS = 200;
const MAX_TARGETS = 12;

export interface DashboardNameTarget {
  readonly entityId: string;
  readonly name: string | null;
  /** Not in Home Assistant right now: the assistant can't use this part of the name. */
  readonly missing: boolean;
}

export interface DashboardNameRow {
  readonly alias: string;
  readonly targets: readonly DashboardNameTarget[];
  readonly notes: string | null;
  /** Why the row can't be edited here, or null when it can. */
  readonly locked: string | null;
}

export interface DashboardNamesResponse {
  readonly ok: true;
  readonly names: readonly DashboardNameRow[];
  /** For the device picker: every entity HA knows, by id and friendly name. */
  readonly entities: readonly { readonly id: string; readonly name: string | null }[];
  readonly roster: { readonly text: string };
  /** Assist's expose list, read-only here (the owner edits it in HA). */
  readonly voice: DashboardVoiceList;
}

export interface DashboardVoiceList {
  readonly loaded: boolean;
  readonly error: string | null;
  readonly devices: readonly (DashboardNameTarget & { readonly aliases: readonly string[] })[];
  /** Assist names two devices share: the assistant uses neither by that name. */
  readonly clashes: readonly string[];
}

export class DashboardNames {
  private readonly store: AliasStore;
  private readonly live: AliasEntry[];
  private readonly stateCache: HaStateCache;
  private readonly registry: HaRegistryIndex;
  private readonly roster: () => string;
  private readonly onSaved: () => void;
  private readonly voice: VoiceExposure | undefined;

  constructor(options: {
    readonly store: AliasStore;
    /** The array every brain route holds; a save swaps its contents in place. */
    readonly live: AliasEntry[];
    readonly stateCache: HaStateCache;
    readonly registry: HaRegistryIndex;
    readonly roster: () => string;
    /** After a save: rebuild anything derived from the saved names. */
    readonly onSaved?: () => void;
    readonly voice?: VoiceExposure;
  }) {
    this.store = options.store;
    this.live = options.live;
    this.stateCache = options.stateCache;
    this.registry = options.registry;
    this.roster = options.roster;
    this.onSaved = options.onSaved ?? (() => {});
    this.voice = options.voice;
  }

  read(): DashboardNamesResponse {
    const entities = this.stateCache.entries()
      .filter((state) => !state.entityId.startsWith("person."))
      .map((state) => ({ id: state.entityId, name: friendlyNameAttribute(state.attributes) }))
      .sort((left, right) => left.id.localeCompare(right.id));
    return {
      ok: true,
      names: this.live.map((entry) => this.row(entry)),
      entities,
      roster: { text: this.roster() },
      voice: this.voiceList(),
    };
  }

  private voiceList(): DashboardVoiceList {
    const snapshot = this.voice?.snapshot();
    if (!snapshot) return { loaded: false, error: null, devices: [], clashes: [] };
    const aliases = this.voice?.aliasEntries() ?? [];
    return {
      loaded: snapshot.loaded,
      error: snapshot.lastError,
      devices: snapshot.entityIds.map((entityId) => {
        const state = this.stateCache.get(entityId);
        return {
          entityId,
          name: state ? friendlyNameAttribute(state.attributes) : null,
          missing: !state,
          aliases: aliases.flatMap((entry) => (entry.target.kind === "entity" && entry.target.entityId === entityId ? [entry.alias] : [])),
        };
      }),
      clashes: snapshot.clashes,
    };
  }

  /**
   * Body: `{ action: "save", alias, entityIds, notes?, previousAlias? }` adds
   * or renames a row; `{ action: "remove", alias }` deletes one. The file is
   * re-read first so a hand edit since boot is kept, not overwritten.
   */
  apply(body: unknown): DashboardNamesResponse {
    const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    let current: readonly AliasEntry[];
    try {
      current = this.store.load().entries;
    } catch (error) {
      throw new Error(`aliases.json can't be read, so nothing was changed: ${error instanceof Error ? error.message : String(error)}`);
    }
    let next: AliasEntry[];
    if (record.action === "remove") {
      const index = findAlias(current, record.alias);
      if (index < 0) throw new Error("That name isn't in the list");
      this.assertEditable(current[index]!);
      next = current.filter((_, at) => at !== index);
    } else if (record.action === "save") {
      const entry = this.entryFrom(record);
      const previous = record.previousAlias === undefined ? -1 : findAlias(current, record.previousAlias);
      if (record.previousAlias !== undefined && previous < 0) throw new Error("The name being edited isn't in the list any more");
      if (previous >= 0) this.assertEditable(current[previous]!);
      const clash = current.findIndex((other, at) => at !== previous && other.normalizedAlias === entry.normalizedAlias);
      if (clash >= 0) throw new Error(`"${current[clash]!.alias}" already exists`);
      next = previous >= 0
        ? current.map((other, at) => (at === previous ? entry : other))
        : [...current, entry];
    } else {
      throw new Error("action must be save or remove");
    }
    const saved = this.store.save(next).entries;
    this.live.splice(0, this.live.length, ...saved);
    this.onSaved();
    return this.read();
  }

  private entryFrom(record: Record<string, unknown>): AliasEntry {
    const alias = typeof record.alias === "string" ? record.alias.trim().replaceAll(/\s+/g, " ") : "";
    const normalizedAlias = normalizeAlias(alias);
    if (!normalizedAlias) throw new Error("Type a name");
    if (alias.length > MAX_ALIAS_CHARS) throw new Error(`Names are ${MAX_ALIAS_CHARS} characters at most`);
    if (!Array.isArray(record.entityIds)) throw new Error("Pick at least one device");
    const entityIds = record.entityIds
      .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
      .filter(Boolean);
    if (entityIds.length === 0) throw new Error("Pick at least one device");
    if (entityIds.length > MAX_TARGETS) throw new Error(`One name covers ${MAX_TARGETS} devices at most`);
    if (new Set(entityIds).size !== entityIds.length) throw new Error("The same device is listed twice");
    for (const entityId of entityIds) {
      if (entityId.startsWith("person.")) throw new Error("People aren't named here");
      if (!this.stateCache.has(entityId) && !this.registry.entity(entityId)) {
        throw new Error(`${entityId} isn't in Home Assistant`);
      }
    }
    const notes = typeof record.notes === "string" ? record.notes.trim() : "";
    if (notes.length > MAX_NOTES_CHARS) throw new Error(`Notes are ${MAX_NOTES_CHARS} characters at most`);
    return {
      alias,
      normalizedAlias,
      target: entityIds.length === 1
        ? { kind: "entity", entityId: entityIds[0]! }
        : { kind: "group", entityIds },
      ...(notes ? { notes } : {}),
    };
  }

  private assertEditable(entry: AliasEntry): void {
    const locked = lockReason(entry);
    if (locked) throw new Error(`"${entry.alias}" can't be changed here: ${locked}`);
  }

  private row(entry: AliasEntry): DashboardNameRow {
    const ids = entry.target.kind === "entity"
      ? [entry.target.entityId]
      : entry.target.kind === "group" ? [...entry.target.entityIds] : [];
    return {
      alias: entry.alias,
      targets: ids.map((entityId) => {
        const state = this.stateCache.get(entityId);
        return {
          entityId,
          name: state ? friendlyNameAttribute(state.attributes) : this.registry.entity(entityId)?.name ?? null,
          missing: !state && !this.registry.entity(entityId),
        };
      }),
      notes: entry.notes ?? null,
      locked: lockReason(entry),
    };
  }
}

function lockReason(entry: AliasEntry): string | null {
  if (entry.target.kind === "area" || entry.target.kind === "capability") return "a room or feature name, set in the file";
  const ids = entry.target.kind === "entity" ? [entry.target.entityId] : entry.target.entityIds;
  return ids.some((id) => id.startsWith("person.")) ? `it's how ${assistantName()} knows who's who` : null;
}

function findAlias(entries: readonly AliasEntry[], alias: unknown): number {
  const normalized = typeof alias === "string" ? normalizeAlias(alias) : "";
  return normalized ? entries.findIndex((entry) => entry.normalizedAlias === normalized) : -1;
}

export function friendlyNameAttribute(attributes: Readonly<Record<string, unknown>>): string | null {
  const name = attributes.friendly_name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}
