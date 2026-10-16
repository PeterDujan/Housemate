import { type AliasEntry, normalizeAlias } from "./alias-schema.js";
import type { HaCommandClient } from "./ha-history.js";
import { recordOrNull } from "./value-guards.js";

/**
 * What the owner exposes to Assist in HA
 * (Settings > Voice assistants > Expose) is the assistant's voice list, and Assist's
 * aliases are its spoken names. HA's expose list knows only Assist, Alexa and
 * Google, so the assistant reads Assist's (`conversation`). Reads only: nothing here
 * switches anything or decides whether a turn may act.
 */
export const VOICE_ASSISTANT = "conversation";

export interface VoiceExposureInput {
  readonly entityIds: readonly string[];
  /** Assist aliases per exposed entity. */
  readonly aliases: Readonly<Record<string, readonly string[]>>;
}

export interface VoiceExposureSnapshot {
  readonly loaded: boolean;
  readonly entityIds: readonly string[];
  readonly aliasCount: number;
  /** Aliases two exposed entities share: dropped, so neither is picked by that name. */
  readonly clashes: readonly string[];
  readonly lastLoadedAt: string | null;
  readonly lastError: string | null;
}

export class VoiceExposure {
  #entityIds: ReadonlySet<string> = new Set();
  #aliasEntries: readonly AliasEntry[] = [];
  #clashes: readonly string[] = [];
  #loaded = false;
  #lastLoadedAt: string | null = null;
  #lastError: string | null = null;
  readonly #onChange: () => void;

  constructor(options: { readonly onChange?: () => void } = {}) {
    this.#onChange = options.onChange ?? (() => {});
  }

  replace(input: VoiceExposureInput, now: Date = new Date()): void {
    const byAlias = new Map<string, { alias: string; entityIds: Set<string> }>();
    for (const entityId of input.entityIds) {
      for (const alias of input.aliases[entityId] ?? []) {
        const normalizedAlias = normalizeAlias(alias);
        if (!normalizedAlias) continue;
        const seen = byAlias.get(normalizedAlias) ?? { alias: alias.trim(), entityIds: new Set<string>() };
        seen.entityIds.add(entityId);
        byAlias.set(normalizedAlias, seen);
      }
    }
    const entries: AliasEntry[] = [];
    const clashes: string[] = [];
    for (const [normalizedAlias, { alias, entityIds }] of byAlias) {
      const [entityId, ...others] = [...entityIds];
      if (!entityId) continue;
      if (others.length > 0) {
        clashes.push(alias);
        continue;
      }
      entries.push({ alias, normalizedAlias, target: { kind: "entity", entityId }, notes: "Assist alias" });
    }
    this.#entityIds = new Set(input.entityIds);
    this.#aliasEntries = Object.freeze(entries);
    this.#clashes = Object.freeze(clashes);
    this.#loaded = true;
    this.#lastLoadedAt = now.toISOString();
    this.#lastError = null;
    this.#onChange();
  }

  /** A failed read keeps the last list: the owner's choices don't vanish on a blip. */
  markFailed(message: string): void {
    this.#lastError = message;
  }

  isExposed(entityId: string): boolean {
    return this.#entityIds.has(entityId);
  }

  aliasEntries(): readonly AliasEntry[] {
    return this.#aliasEntries;
  }

  snapshot(): VoiceExposureSnapshot {
    return {
      loaded: this.#loaded,
      entityIds: [...this.#entityIds].sort(),
      aliasCount: this.#aliasEntries.length,
      clashes: this.#clashes,
      lastLoadedAt: this.#lastLoadedAt,
      lastError: this.#lastError,
    };
  }
}

/** Assist's expose list and the aliases of what is on it: two reads over the assistant's HA socket. */
export async function fetchVoiceExposure(client: HaCommandClient): Promise<VoiceExposureInput> {
  const listed = recordOrNull(recordOrNull(await client.sendCommand({ type: "homeassistant/expose_entity/list" }))?.exposed_entities);
  if (!listed) throw new Error("Home Assistant expose list was malformed");
  const entityIds = Object.entries(listed)
    .filter(([, assistants]) => recordOrNull(assistants)?.[VOICE_ASSISTANT] === true)
    .map(([entityId]) => entityId)
    .sort();
  if (entityIds.length === 0) return { entityIds, aliases: {} };
  const entries = recordOrNull(await client.sendCommand({ type: "config/entity_registry/get_entries", entity_ids: entityIds }));
  if (!entries) throw new Error("Home Assistant registry entries were malformed");
  const aliases: Record<string, readonly string[]> = {};
  for (const entityId of entityIds) {
    // An entity without a unique id (a YAML template) has no registry entry and so no aliases.
    const names = recordOrNull(entries[entityId])?.aliases;
    aliases[entityId] = Array.isArray(names)
      ? names.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
      : [];
  }
  return { entityIds, aliases };
}

/**
 * The aliases every route reads: the assistant's own `aliases.json` plus Assist's.
 * On the same name the Assist alias wins: HA is where the owner names voice targets.
 */
export function withVoiceAliases(own: readonly AliasEntry[], assist: readonly AliasEntry[]): AliasEntry[] {
  const taken = new Set(assist.map((entry) => entry.normalizedAlias));
  return [...own.filter((entry) => !taken.has(entry.normalizedAlias)), ...assist];
}
