import { friendlyName, type HaEntityState } from "./ha-state-cache.js";
import type { HaIndexedEntity, HaRegistryIndex } from "./ha-registry-index.js";
import { stripStatusFiller } from "./lexicon.js";
import { normalizeMeasuredRoutingText, normalizeRoutingText, targetTextKey } from "./routing-text.js";
import { TextMemo } from "./text-memo.js";

/**
 * The house's names, normalised once per HA name change.
 *
 * Every way a spoken target is compared with an entity reads the keys here:
 * the brain's label and entity-id keys, the status resolver's semantic and
 * exact keys, and the target resolver's name candidates with a word index
 * that narrows a lookup to the entities sharing its words. Built from the
 * state list's names and the registry; live values are read from the state
 * cache at lookup time, so the index survives ordinary state changes.
 */

// --- Target text keys ---------------------------------------------------------

/** A target key with plurals folded ("office lights" ~ "office light", "sam s room" ~ "sam room"). */
export function semanticTargetKey(value: string): string {
  return singularKey(value).replace(/\b([a-z]+) s\b/g, "$1");
}

export function singularKey(value: string): string {
  return value.split(" ").map((token) => token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token).join(" ");
}

export function labelsEquivalent(left: string, right: string): boolean {
  return left === right || semanticTargetKey(left) === semanticTargetKey(right);
}

/** Status target text without status filler and articles, for semantic tokens and exact keys. */
export function statusTargetText(value: string): string {
  return stripStatusFiller(normalizeRoutingText(value))
    .replace(/\b(?:the|my)\b/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

const EXACT_TEXT_ARTICLES = new Set(["a", "an", "the", "my", "our", "your"]);

export function exactTextKey(value: string): string {
  return statusTargetText(value)
    .replaceAll(/[._:]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(canonicalInflectionToken)
    .filter((token) => !EXACT_TEXT_ARTICLES.has(token))
    .join(" ");
}

export function semanticTokens(value: string): readonly string[] {
  return statusTargetText(value)
    .replaceAll(/[._:]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(canonicalSemanticToken);
}

const SEMANTIC_PLACE_TOKENS: Readonly<Record<string, string>> = {
  outdoor: "outside",
  outdoors: "outside",
  // The house as a whole: "inside" / "indoors" mean the house, as "outdoor" means outside.
  indoor: "house",
  indoors: "house",
  inside: "house",
};

export function canonicalSemanticToken(token: string): string {
  const inflected = canonicalInflectionToken(token);
  return SEMANTIC_PLACE_TOKENS[inflected] ?? inflected;
}

const SINGULAR_FORMS: Readonly<Record<string, string>> = {
  bedrooms: "bedroom",
  blinds: "blind",
  cabinets: "cabinet",
  computers: "computer",
  curtains: "curtain",
  doors: "door",
  fans: "fan",
  gates: "gate",
  heaters: "heater",
  lamps: "lamp",
  lights: "light",
  locks: "lock",
  outlets: "outlet",
  people: "person",
  plugs: "plug",
  pumps: "pump",
  rooms: "room",
  sensors: "sensor",
  shades: "shade",
  sockets: "socket",
  switches: "switch",
  temperatures: "temperature",
  vacuums: "vacuum",
  windows: "window",
};

export function canonicalInflectionToken(token: string): string {
  return SINGULAR_FORMS[token] ?? token;
}

const nameKeyMemo = new TextMemo();

/** The target resolver's name key: lower case, no the/my/our, words only. */
export function resolverNameKey(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const key = nameKeyMemo.get(value) ?? nameKeyMemo.set(value, value
    .toLowerCase()
    .replaceAll(/\b(the|my|our)\b/g, " ")
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim()
    .replaceAll(/\s+/g, " "));
  return key || null;
}

// --- The index ----------------------------------------------------------------

export interface ResolverName {
  readonly raw: string;
  readonly key: string;
}

export interface PersonTarget {
  readonly entityId: string;
  /** Target keys from the state name, the entity slug and the registry names. */
  readonly keys: readonly string[];
  readonly registryEntity: HaIndexedEntity | null;
  readonly hasState: boolean;
}

export interface EntityNames {
  readonly entityId: string;
  readonly domain: string;
  readonly friendly: string;
  /** `targetTextKey(friendlyName)`. */
  readonly label: string;
  /** Routing-normalised entity id and friendly name. */
  readonly idKey: string;
  readonly routingLabel: string;
  /** Resolver name keys of the entity id and the HA friendly name. */
  readonly nameKeys: readonly string[];
  readonly registryEntity: HaIndexedEntity | null;
  readonly scopeTokens: ReadonlySet<string>;
  readonly objectTokens: ReadonlySet<string>;
  readonly resolverNames: readonly ResolverName[] | null;
  readonly resolverAreaKeys: readonly (string | null)[] | null;
}

const NO_REGISTRY = {};
const INDEXES = new WeakMap<object, WeakMap<object, TargetIndex>>();

/** The index for this state shape and registry content, built at most once per HA name change. */
export function targetIndexFor(
  states: { readonly shape: object; readonly entries: readonly HaEntityState[] },
  registry: HaRegistryIndex | null,
): TargetIndex {
  let byRegistry = INDEXES.get(states.shape);
  if (!byRegistry) {
    byRegistry = new WeakMap();
    INDEXES.set(states.shape, byRegistry);
  }
  const registryKey = registry?.contentKey() ?? NO_REGISTRY;
  let index = byRegistry.get(registryKey);
  if (!index) {
    index = new TargetIndex(states.entries, registry);
    byRegistry.set(registryKey, index);
  }
  return index;
}

export class TargetIndex {
  readonly size: number;
  readonly #entities: readonly EntityNames[];
  readonly #position = new Map<string, number>();
  readonly #bySemanticLabel = new Map<string, number[]>();
  readonly #byIdKey = new Map<string, number[]>();
  readonly #byDomain = new Map<string, number[]>();
  readonly #byExactName = new Map<string, number[]>();
  readonly #byNameKey = new Map<string, number[]>();
  readonly #byArea = new Map<string, number[]>();
  readonly #wordPostings = new Map<string, number[]>();
  readonly #longNamePostings = new Map<string, number[]>();
  readonly #people: readonly PersonTarget[];

  constructor(states: readonly HaEntityState[], registry: HaRegistryIndex | null) {
    this.#entities = states.map((state) => entityNames(state, registry?.entity(state.entityId) ?? null));
    this.size = this.#entities.length;
    this.#entities.forEach((entity, position) => {
      this.#position.set(entity.entityId, position);
      push(this.#bySemanticLabel, semanticTargetKey(entity.label), position);
      push(this.#byIdKey, entity.idKey, position);
      push(this.#byDomain, entity.domain, position);
      for (const name of new Set([entity.friendly, entity.registryEntity?.deviceName ?? ""].map(exactTextKey))) {
        push(this.#byExactName, name, position);
      }
      for (const key of new Set(entity.nameKeys)) push(this.#byNameKey, key, position);
      if (entity.registryEntity?.effectiveAreaId) push(this.#byArea, entity.registryEntity.effectiveAreaId, position);
      const words = new Set<string>();
      const longWords = new Set<string>();
      for (const name of entity.resolverNames ?? []) {
        const nameWords = name.key.split(" ");
        for (const word of nameWords) {
          words.add(word);
          if (nameWords.length >= 3) longWords.add(word);
        }
      }
      for (const word of words) push(this.#wordPostings, word, position);
      for (const word of longWords) push(this.#longNamePostings, word, position);
    });
    this.#people = personTargets(states, registry);
  }

  /** The entity's normalised names and tokens, or null when it has no state. */
  entity(entityId: string): EntityNames | null {
    const position = this.#position.get(entityId);
    return position === undefined ? null : this.#entities[position] ?? null;
  }

  /** Entity ids, in state order, whose routing-normalised id is this key. */
  entityIdsWithIdKey(key: string): readonly string[] {
    return this.#ids(this.#byIdKey.get(key));
  }

  /** Entity ids, in state order, whose friendly-name label is equivalent to this target key. */
  entityIdsWithLabelLike(targetKey: string): readonly string[] {
    return this.#ids(this.#bySemanticLabel.get(semanticTargetKey(targetKey)));
  }

  entityIdsInDomain(domain: string): readonly string[] {
    return this.#ids(this.#byDomain.get(domain));
  }

  entityIdsInArea(areaId: string): readonly string[] {
    return this.#ids(this.#byArea.get(areaId));
  }

  /** Entity ids whose id or HA friendly name has this resolver name key ("" for none). */
  entityIdsWithNameKey(key: string): readonly string[] {
    return this.#ids(this.#byNameKey.get(key));
  }

  /** Entity ids whose friendly name or device name has this exact key. */
  entityIdsWithExactName(key: string): readonly string[] {
    return this.#ids(this.#byExactName.get(key));
  }

  /** Every entity in state order. */
  entries(): readonly EntityNames[] {
    return this.#entities;
  }

  /**
   * Entities whose resolver names could score against this name key: a name
   * holding every word of the key, or a three-word name inside the key.
   */
  resolverCandidates(nameKey: string): readonly string[] {
    const words = [...new Set(nameKey.split(" ").filter(Boolean))];
    const positions = new Set<number>();
    const postings = words.map((word) => this.#wordPostings.get(word) ?? EMPTY_POSITIONS);
    const narrowest = postings.reduce((best, list) => list.length < best.length ? list : best, postings[0] ?? EMPTY_POSITIONS);
    const others = postings.filter((list) => list !== narrowest).map((list) => new Set(list));
    for (const position of narrowest) {
      if (others.every((set) => set.has(position))) positions.add(position);
    }
    for (const word of words) {
      for (const position of this.#longNamePostings.get(word) ?? EMPTY_POSITIONS) positions.add(position);
    }
    return [...positions].sort((left, right) => left - right).map((position) => this.#entities[position]?.entityId ?? "");
  }

  /** Household people: person entities in state order, then registered ones without state. */
  people(): readonly PersonTarget[] {
    return this.#people;
  }

  #ids(positions: readonly number[] | undefined): readonly string[] {
    return positions ? positions.map((position) => this.#entities[position]?.entityId ?? "") : EMPTY_IDS;
  }
}

const EMPTY_IDS: readonly string[] = Object.freeze([]);
const EMPTY_POSITIONS: readonly number[] = Object.freeze([]);

function push(map: Map<string, number[]>, key: string, position: number): void {
  const list = map.get(key);
  if (list) list.push(position);
  else map.set(key, [position]);
}

function entityNames(state: HaEntityState, registryEntity: HaIndexedEntity | null): EntityNames {
  const friendly = friendlyName(state);
  const stateFriendlyName = typeof state.attributes.friendly_name === "string" && state.attributes.friendly_name.trim()
    ? state.attributes.friendly_name.trim()
    : null;
  const deviceClass = typeof state.attributes.device_class === "string" && state.attributes.device_class.trim()
    ? state.attributes.device_class
    : null;
  const deviceName = registryEntity?.deviceName ?? null;
  return {
    entityId: state.entityId,
    domain: state.entityId.split(".", 1)[0] ?? "",
    friendly,
    label: targetTextKey(friendly),
    idKey: normalizeMeasuredRoutingText(state.entityId),
    routingLabel: normalizeMeasuredRoutingText(friendly),
    nameKeys: [state.entityId, typeof state.attributes.friendly_name === "string" ? state.attributes.friendly_name : ""]
      .map((value) => resolverNameKey(value) ?? ""),
    registryEntity,
    scopeTokens: new Set([
      state.entityId,
      stateFriendlyName,
      deviceName,
      registryEntity?.effectiveAreaName ?? null,
      registryEntity?.effectiveAreaId ?? null,
    ].flatMap((value) => semanticTokens(value ?? ""))),
    objectTokens: new Set([
      state.entityId,
      stateFriendlyName,
      deviceName,
      deviceClass?.replaceAll(/[_-]/g, " ") ?? null,
    ].flatMap((value) => semanticTokens(value ?? ""))),
    resolverNames: registryEntity
      ? resolverNameCandidates(state.entityId, stateFriendlyName, registryEntity)
        .flatMap((raw) => {
          const key = resolverNameKey(raw);
          return key ? [{ raw, key }] : [];
        })
      : null,
    resolverAreaKeys: registryEntity
      ? [registryEntity.effectiveAreaId, registryEntity.effectiveAreaName, ...registryEntity.nameCandidates].map(resolverNameKey)
      : null,
  };
}

function resolverNameCandidates(
  entityId: string,
  stateFriendlyName: string | null,
  registryEntity: HaIndexedEntity,
): readonly string[] {
  const objectNames = uniqueNonEmptyStrings([
    entityId,
    stateFriendlyName,
    registryEntity.name,
    registryEntity.originalName,
    registryEntity.deviceName,
  ]);
  const areaNames = uniqueNonEmptyStrings([
    registryEntity.effectiveAreaName,
    ...registryEntity.nameCandidates.filter((candidate) => !looksLikeEntityId(candidate) && !objectNames.includes(candidate)),
  ]);
  const composites = areaNames.flatMap((area) => objectNames.flatMap((objectName) => [
    `${area} ${objectName}`,
    `${objectName} ${area}`,
  ]));
  return uniqueNonEmptyStrings([
    ...objectNames,
    ...composites,
  ]);
}

function personTargets(states: readonly HaEntityState[], registry: HaRegistryIndex | null): readonly PersonTarget[] {
  const statePeople = states.filter((state) => state.entityId.startsWith("person."));
  const stateByEntityId = new Map(statePeople.map((state) => [state.entityId, state]));
  const personEntityIds = [...new Set([
    ...statePeople.map((state) => state.entityId),
    ...(registry?.allEntities() ?? [])
      .filter((entry) => entry.domain === "person")
      .map((entry) => entry.entityId),
  ])];
  return personEntityIds.map((entityId) => {
    const state = stateByEntityId.get(entityId) ?? null;
    const registryEntity = registry?.entity(entityId) ?? null;
    return {
      entityId,
      keys: [
        ...(state ? [friendlyName(state)] : []),
        entityId.slice("person.".length).replaceAll("_", " "),
        ...(registryEntity?.nameCandidates ?? []),
      ].map(targetTextKey).filter(Boolean),
      registryEntity,
      hasState: state !== null,
    };
  });
}

function looksLikeEntityId(value: string): boolean {
  return /^[a-z0-9_]+\.[a-z0-9_]+$/i.test(value.trim());
}

function uniqueNonEmptyStrings(values: readonly (string | null | undefined)[]): readonly string[] {
  return [...new Set(values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim()))];
}
