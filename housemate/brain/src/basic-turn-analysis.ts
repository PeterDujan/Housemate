import type { AliasEntry } from "./alias-schema.js";
import type { BasicContextFrame } from "./basic-brain-contracts.js";
import type {
  ContextAllowedUse,
  ContextDomain,
  ContextOwner,
} from "./context-contract.js";
import type {
  HaCapability,
  HaCapabilityEntity,
  HaCapabilityIndex,
  HaCapabilityIndexSnapshot,
} from "./ha-capability-index.js";
import type {
  HaIndexedEntity,
  HaRegistryRoutingSnapshot,
} from "./ha-registry-index.js";
import { HaRegistryIndex } from "./ha-registry-index.js";
import { lexiconTags, type LexiconTag } from "./lexicon.js";
import type { HaEntityState, HaStateCache, HaStateRoutingSnapshot } from "./ha-state-cache.js";
import type { RoutingSemantics, RoutingUtterance } from "./routing-text.js";
import { resolveSpeakerPrincipal, type SpeakerIdentitySource, type SpeakerTrust } from "./speaker-principal.js";
import { normalizeWords } from "./speech-normalizer.js";
import {
  sharedCapabilityIndex,
  targetResolverFor,
  type TargetResolverQuery,
  type TargetResolverMatch,
  type TargetResolverResult,
} from "./target-resolver.js";
import { targetIndexFor, type TargetIndex } from "./target-index.js";
import type { VoiceBrainChannel, VoiceBrainRequest } from "./voice-brain.js";
import { HOUSE_LOCALE } from "./house-config.js";

export type BasicContextFrameKind = BasicContextFrame["kind"];

export interface BasicTurnContextReference {
  readonly frameId: string;
  readonly owner: ContextOwner;
  readonly domain: ContextDomain;
  readonly sourceTurnSequence: number;
  readonly allowedUses: readonly ContextAllowedUse[];
}

export interface BasicTurnPrincipal {
  readonly speakerName: string | null;
  readonly voiceId: string | null;
  readonly confidence: number | null;
  readonly trustedPersonId: string | null;
  readonly trustedLabel: string | null;
  readonly identitySource: SpeakerIdentitySource;
  readonly trust: SpeakerTrust;
}

export interface BasicTurnContextSnapshot {
  readonly hasSessionContext: boolean;
  readonly newestFrameKind: BasicContextFrameKind | null;
  readonly frameKinds: readonly BasicContextFrameKind[];
  readonly activeFocus: BasicTurnContextReference | null;
  readonly pendingClarifier: BasicTurnContextReference | null;
  readonly latestAnswerTrace: BasicTurnContextReference | null;
}

export interface BasicTurnSourceAvailability {
  readonly state: boolean;
  readonly registry: boolean;
  readonly aliases: boolean;
  readonly targetResolution: boolean;
}

export interface BasicTurnSourceInput {
  readonly stateCache?: HaStateCache;
  readonly registry?: HaRegistryIndex;
  readonly aliases?: readonly AliasEntry[];
}

export interface BasicTurnCapabilityView {
  entity(entityId: string): HaCapabilityEntity | null;
  entitiesWithCapability(capability: HaCapability): readonly HaCapabilityEntity[];
  entitiesForAreaWithCapability(areaId: string, capability: HaCapability): readonly HaCapabilityEntity[];
  entries(): readonly HaCapabilityEntity[];
  snapshot(): HaCapabilityIndexSnapshot;
}

export interface BasicTurnTargetView {
  resolve(query: TargetResolverQuery): TargetResolverResult;
}

export interface BasicTurnRegistryTarget {
  readonly entityId: string;
  readonly domain: string;
  readonly nameCandidates: readonly string[];
}

export interface BasicTurnRegistryTargetView {
  entity(entityId: string): BasicTurnRegistryTarget | null;
  exactNameMatches(text: string): readonly BasicTurnRegistryTarget[];
}

/**
 * A turn-scoped, lazy view over the cheap read-only HA routing sources.
 * Candidate producers must not receive history, weather, calendar, model, or action adapters.
 */
export class BasicTurnSourceView {
  readonly availability: BasicTurnSourceAvailability;

  readonly #stateSnapshot: HaStateRoutingSnapshot | null;
  readonly #registrySnapshot: HaRegistryRoutingSnapshot | null;
  readonly #aliasSnapshot: readonly AliasEntry[];
  #registryTargetViewCache: BasicTurnRegistryTargetView | null = null;

  constructor(input: BasicTurnSourceInput) {
    const sourceAliases = input.aliases ?? null;
    this.#stateSnapshot = input.stateCache?.routingSnapshot() ?? null;
    this.#registrySnapshot = input.registry?.routingSnapshot() ?? null;
    this.#aliasSnapshot = immutableAliasSnapshot(sourceAliases);
    const stateAvailable = this.#stateSnapshot?.complete ?? false;
    const registryAvailable = (
      this.#registrySnapshot?.complete
      && this.#registrySnapshot.index.hasEntries()
    ) ?? false;
    this.availability = Object.freeze({
      state: stateAvailable,
      registry: registryAvailable,
      aliases: sourceAliases !== null,
      targetResolution: stateAvailable,
    });
    Object.freeze(this);
  }

  aliases(): readonly AliasEntry[] {
    return this.#aliasSnapshot;
  }

  states(): readonly HaEntityState[] {
    return this.availability.state ? this.#stateSnapshot?.entries ?? EMPTY_STATES : EMPTY_STATES;
  }

  registryTargets(): BasicTurnRegistryTargetView | null {
    if (!this.availability.registry || !this.#registrySnapshot) {
      return null;
    }
    if (this.#registryTargetViewCache === null) {
      this.#registryTargetViewCache = sharedRegistryTargetView(this.#registrySnapshot);
    }
    return this.#registryTargetViewCache;
  }

  registryIndex(): HaRegistryIndex | null {
    return this.availability.registry
      ? this.#registrySnapshot?.index ?? null
      : null;
  }

  /**
   * Privacy may conservatively deny from the last snapshot while a source is
   * reconnecting. These values must never be used to answer the question.
   */
  privacyRegistryIndex(): HaRegistryIndex | null {
    return this.#registrySnapshot?.index ?? null;
  }

  privacyStates(): readonly HaEntityState[] {
    return this.#stateSnapshot?.entries ?? EMPTY_STATES;
  }

  capabilities(): BasicTurnCapabilityView | null {
    if (!this.availability.targetResolution || !this.#stateSnapshot) {
      return null;
    }
    return sharedCapabilityIndex(this.#stateSnapshot, this.#resolutionRegistry());
  }

  /** The house's normalised names for this turn's states and registry. */
  targetIndex(): TargetIndex | null {
    if (!this.availability.targetResolution || !this.#stateSnapshot) {
      return null;
    }
    return targetIndexFor(
      this.#stateSnapshot,
      this.availability.registry ? this.#registrySnapshot?.index ?? null : null,
    );
  }

  targets(): BasicTurnTargetView | null {
    if (!this.availability.targetResolution || !this.#stateSnapshot) {
      return null;
    }
    return this.availability.registry && this.#registrySnapshot
      ? targetResolverFor(this.#stateSnapshot, this.#registrySnapshot.index, this.#aliasSnapshot)
      : sharedStateTargetView(sharedCapabilityIndex(this.#stateSnapshot, EMPTY_REGISTRY_INDEX), this.#aliasSnapshot);
  }

  #resolutionRegistry(): HaRegistryIndex {
    return this.availability.registry && this.#registrySnapshot ? this.#registrySnapshot.index : EMPTY_REGISTRY_INDEX;
  }
}

interface SharedRegistryTargetCache {
  readonly revision: number;
  readonly view: BasicTurnRegistryTargetView;
}

const EMPTY_STATES: readonly HaEntityState[] = Object.freeze([]);
const EMPTY_ALIASES: readonly AliasEntry[] = Object.freeze([]);
const EMPTY_REGISTRY_TARGETS: readonly BasicTurnRegistryTarget[] = Object.freeze([]);
const EMPTY_REGISTRY_INDEX = HaRegistryIndex.from({ areas: [], devices: [], entities: [] });
const TARGET_RESULT_CACHE_LIMIT = 256;
const STATE_TARGET_VIEWS = new WeakMap<HaCapabilityIndex, WeakMap<readonly AliasEntry[], BasicTurnTargetView>>();
const SHARED_REGISTRY_TARGETS = new WeakMap<
  HaRegistryRoutingSnapshot,
  SharedRegistryTargetCache
>();
const IMMUTABLE_ALIAS_SNAPSHOTS = new WeakMap<
  readonly AliasEntry[],
  { readonly signature: string; readonly entries: readonly AliasEntry[] }
>();

function sharedRegistryTargetView(snapshot: HaRegistryRoutingSnapshot): BasicTurnRegistryTargetView {
  const current = SHARED_REGISTRY_TARGETS.get(snapshot);
  if (current?.revision === snapshot.revision) {
    return current.view;
  }

  const byEntityId = new Map<string, BasicTurnRegistryTarget>();
  const mutableExactNames = new Map<string, BasicTurnRegistryTarget[]>();
  for (const entity of snapshot.index.allEntities()) {
    const target = registryTarget(entity);
    byEntityId.set(entity.entityId.toLocaleLowerCase(HOUSE_LOCALE), target);
    for (const candidate of target.nameCandidates) {
      const key = normalizeWords(candidate);
      if (!key) {
        continue;
      }
      const matches = mutableExactNames.get(key) ?? [];
      if (!matches.some((match) => match.entityId === target.entityId)) {
        matches.push(target);
      }
      mutableExactNames.set(key, matches);
    }
  }
  const exactNames = new Map(
    [...mutableExactNames].map(([name, matches]) => [name, Object.freeze(matches)] as const),
  );
  const view = Object.freeze({
    entity: (entityId: string) => byEntityId.get(entityId.trim().toLocaleLowerCase(HOUSE_LOCALE)) ?? null,
    exactNameMatches: (text: string) => exactNames.get(normalizeWords(text)) ?? EMPTY_REGISTRY_TARGETS,
  });
  SHARED_REGISTRY_TARGETS.set(snapshot, { revision: snapshot.revision, view });
  return view;
}

function registryTarget(entity: HaIndexedEntity): BasicTurnRegistryTarget {
  const nameCandidates = Object.freeze([...new Set([
    entity.entityId,
    entity.name,
    entity.originalName,
    entity.deviceName,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0))]);
  return Object.freeze({
    entityId: entity.entityId,
    domain: entity.domain,
    nameCandidates,
  });
}

/** Exact-name resolution for the moments the registry is unavailable. */
function sharedStateTargetView(
  capabilityIndex: HaCapabilityIndex,
  aliases: readonly AliasEntry[],
): BasicTurnTargetView {
  let byAliases = STATE_TARGET_VIEWS.get(capabilityIndex);
  if (!byAliases) {
    byAliases = new WeakMap();
    STATE_TARGET_VIEWS.set(capabilityIndex, byAliases);
  }
  const cached = byAliases.get(aliases);
  if (cached) {
    return cached;
  }
  const results = new Map<string, TargetResolverResult>();
  const view = Object.freeze({
    resolve: (query: TargetResolverQuery) => {
      const key = targetQueryKey(query);
      const cached = results.get(key);
      if (cached) {
        results.delete(key);
        results.set(key, cached);
        return cached;
      }
      const queryText = exactAliasTargetKey(query.text ?? "");
      const exactAliases = queryText
        ? aliases.filter((alias) => exactAliasTargetKey(alias.normalizedAlias) === queryText)
        : [];
      if (exactAliases.length > 1) {
        const conflict = deepFreeze<TargetResolverResult>({
          matches: [],
          rejectedCount: exactAliases.length,
          confidence: "none",
        });
        results.set(key, conflict);
        return conflict;
      }
      const alias = exactAliases.length === 1 ? exactAliases[0] ?? null : null;
      const declaredIds = alias?.target.kind === "entity"
        ? [alias.target.entityId]
        : alias?.target.kind === "group"
          ? [...alias.target.entityIds]
          : [];
      const entityIds = [...new Set(declaredIds)];
      const complete = alias !== null
        && entityIds.length > 0
        && entityIds.length === declaredIds.length;
      const exactAlias = complete ? alias : null;
      if (alias && !exactAlias) {
        const invalid = deepFreeze<TargetResolverResult>({
          matches: [],
          rejectedCount: Math.max(1, declaredIds.length),
          confidence: "none",
        });
        results.set(key, invalid);
        return invalid;
      }

      const matchesById = new Map<string, TargetResolverMatch>();
      const addMatch = (entity: HaCapabilityEntity, reasons: readonly string[]) => {
        if ((query.domain && entity.domain !== query.domain)
          || (query.capability && !entity.capabilities.includes(query.capability))
          || (!query.includeUnavailable && !entity.available)) {
          return;
        }
        const current = matchesById.get(entity.entityId);
        matchesById.set(entity.entityId, {
          entityId: entity.entityId,
          domain: entity.domain,
          areaId: null,
          areaName: null,
          deviceId: null,
          deviceName: null,
          capabilities: entity.capabilities,
          available: entity.available,
          score: 120,
          reasons: [...new Set([...(current?.reasons ?? []), ...reasons])],
        });
      };

      if (exactAlias) {
        for (const entityId of entityIds) {
          const entity = capabilityIndex.entity(entityId);
          if (!entity
            || (query.domain && entity.domain !== query.domain)
            || (query.capability && !entity.capabilities.includes(query.capability))
            || (!query.includeUnavailable && !entity.available)) {
            const invalid = deepFreeze<TargetResolverResult>({
              matches: [],
              rejectedCount: Math.max(1, entityIds.length),
              confidence: "none",
            });
            results.set(key, invalid);
            return invalid;
          }
          addMatch(entity, [`alias_exact:${exactAlias.target.kind}:${exactAlias.alias}`]);
        }
      }

      if (queryText) {
        for (const entity of capabilityIndex.entries()) {
          const reasons: string[] = [];
          if (exactAliasTargetKey(entity.entityId) === queryText) reasons.push("exact:entity_id");
          if (entity.friendlyName && exactAliasTargetKey(entity.friendlyName) === queryText) {
            reasons.push("exact:friendly_name");
          }
          if (reasons.length > 0) addMatch(entity, reasons);
        }
      }

      const matches = [...matchesById.values()].sort((left, right) => left.entityId.localeCompare(right.entityId));
      const sharedGroupBinding = matches[0]?.reasons.find((reason) => (
        reason.startsWith("alias_exact:group:")
        && matches.every((match) => match.reasons.includes(reason))
      )) ?? null;
      const result = deepFreeze<TargetResolverResult>({
        matches,
        rejectedCount: Math.max(0, capabilityIndex.entries().length - matches.length),
        confidence: matches.length === 0
          ? "none"
          : matches.length === 1 || sharedGroupBinding
            ? "high"
            : "ambiguous",
      });
      results.set(key, result);
      if (results.size > TARGET_RESULT_CACHE_LIMIT) {
        const oldestKey = results.keys().next().value as string | undefined;
        if (oldestKey !== undefined) results.delete(oldestKey);
      }
      return result;
    },
  });
  byAliases.set(aliases, view);
  return view;
}

function exactAliasTargetKey(value: string): string {
  return value
    .toLocaleLowerCase(HOUSE_LOCALE)
    .replaceAll(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token && !["the", "my", "our", "your"].includes(token))
    .join(" ");
}

function immutableAliasSnapshot(source: readonly AliasEntry[] | null): readonly AliasEntry[] {
  if (!source || source.length === 0) {
    return EMPTY_ALIASES;
  }
  const signature = aliasSignature(source);
  const cached = IMMUTABLE_ALIAS_SNAPSHOTS.get(source);
  if (cached?.signature === signature) {
    return cached.entries;
  }
  const entries = Object.freeze(source.map(cloneFrozenAliasEntry));
  IMMUTABLE_ALIAS_SNAPSHOTS.set(source, { signature, entries });
  return entries;
}

function aliasSignature(entries: readonly AliasEntry[]): string {
  return JSON.stringify(entries.map((entry) => [
    entry.alias,
    entry.normalizedAlias,
    entry.notes ?? null,
    aliasTargetSignature(entry),
  ]));
}

function aliasTargetSignature(entry: AliasEntry): readonly unknown[] {
  switch (entry.target.kind) {
    case "entity":
      return ["entity", entry.target.entityId];
    case "group":
      return ["group", ...entry.target.entityIds];
    case "area":
      return ["area", entry.target.areaId];
    case "capability":
      return [
        "capability",
        entry.target.capability,
        entry.target.areaId ?? null,
        entry.target.domain ?? null,
      ];
  }
}

function targetQueryKey(query: TargetResolverQuery): string {
  return JSON.stringify([
    query.text ?? null,
    query.area ?? null,
    query.domain ?? null,
    query.capability ?? null,
    query.includeUnavailable === true,
  ]);
}

export interface BasicTurnAnalysis {
  readonly surface: string;
  readonly normalizedSurface: string;
  readonly taskCore: string;
  readonly normalizedCore: string;
  /** Lexicon word classes that occur in the normalised core. */
  readonly tags: readonly LexiconTag[];
  readonly speechAct: RoutingUtterance["speechAct"];
  readonly semantics: RoutingSemantics;
  readonly dialogueAct: RoutingUtterance["dialogueAct"];
  readonly dialoguePrefix: RoutingUtterance["dialoguePrefix"];
  readonly resetBeforeCore: boolean;
  readonly channel: VoiceBrainChannel;
  readonly sourceVia: string | null;
  readonly room: string | null;
  readonly sessionId: string | null;
  readonly conversationMode: boolean;
  readonly startedAt: string;
  readonly principal: BasicTurnPrincipal;
  readonly context: BasicTurnContextSnapshot;
  readonly routing: RoutingUtterance;
  readonly sources: BasicTurnSourceView;
}

export function buildBasicTurnAnalysis(options: {
  readonly request: VoiceBrainRequest;
  readonly routing: RoutingUtterance;
  readonly startedAt: Date;
  readonly contextFrameKinds: readonly BasicContextFrame["kind"][];
  readonly hasSessionContext: boolean;
  readonly contextReferences?: {
    readonly activeFocus: BasicTurnContextReference | null;
    readonly pendingClarifier: BasicTurnContextReference | null;
    readonly latestAnswerTrace: BasicTurnContextReference | null;
  };
  readonly sources: BasicTurnSourceInput;
}): BasicTurnAnalysis {
  const frameKinds = Object.freeze([...options.contextFrameKinds]);
  const routing = Object.freeze({ ...options.routing });
  const resolvedPrincipal = resolveSpeakerPrincipal(options.request.speaker);
  const principal = Object.freeze({
    speakerName: options.request.speaker.name,
    voiceId: options.request.speaker.voiceId,
    confidence: options.request.speaker.confidence,
    trustedPersonId: resolvedPrincipal.personId,
    trustedLabel: resolvedPrincipal.label,
    identitySource: resolvedPrincipal.identitySource,
    trust: resolvedPrincipal.trust,
  });
  const context = Object.freeze({
    hasSessionContext: options.hasSessionContext,
    newestFrameKind: frameKinds[0] ?? null,
    frameKinds,
    activeFocus: freezeContextReference(options.contextReferences?.activeFocus ?? null),
    pendingClarifier: freezeContextReference(options.contextReferences?.pendingClarifier ?? null),
    latestAnswerTrace: freezeContextReference(options.contextReferences?.latestAnswerTrace ?? null),
  });
  return Object.freeze({
    surface: routing.raw,
    normalizedSurface: routing.normalized,
    taskCore: routing.semantics.coreSurface,
    normalizedCore: routing.semantics.core,
    tags: lexiconTags(routing.semantics.core),
    speechAct: routing.speechAct,
    semantics: routing.semantics,
    dialogueAct: routing.dialogueAct,
    dialoguePrefix: routing.dialoguePrefix,
    resetBeforeCore: routing.resetBeforeCore,
    channel: options.request.channel,
    sourceVia: options.request.sourceVia,
    room: options.request.room,
    sessionId: options.request.sessionId,
    conversationMode: options.request.conversationMode,
    startedAt: options.startedAt.toISOString(),
    principal,
    context,
    routing,
    sources: new BasicTurnSourceView(options.sources),
  });
}

function freezeContextReference(reference: BasicTurnContextReference | null): BasicTurnContextReference | null {
  return reference
    ? Object.freeze({
        frameId: reference.frameId,
        owner: reference.owner,
        domain: reference.domain,
        sourceTurnSequence: reference.sourceTurnSequence,
        allowedUses: Object.freeze([...reference.allowedUses]),
      })
    : null;
}

function cloneFrozenAliasEntry(entry: AliasEntry): AliasEntry {
  const target = entry.target.kind === "group"
    ? Object.freeze({ ...entry.target, entityIds: Object.freeze([...entry.target.entityIds]) })
    : Object.freeze({ ...entry.target });
  return Object.freeze({
    alias: entry.alias,
    normalizedAlias: entry.normalizedAlias,
    target,
    ...(entry.notes ? { notes: entry.notes } : {}),
  });
}

function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
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
