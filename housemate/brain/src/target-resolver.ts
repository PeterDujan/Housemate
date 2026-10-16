import type { AliasEntry, AliasTarget } from "./alias-schema.js";
import { HaCapabilityIndex, type HaCapability, type HaCapabilityEntity } from "./ha-capability-index.js";
import type { HaIndexedEntity, HaRegistryIndex } from "./ha-registry-index.js";
import { deepFreeze, type HaStateCache, type HaStateRoutingSnapshot } from "./ha-state-cache.js";
import { resolverNameKey as normalize, semanticTargetKey, targetIndexFor, type ResolverName, type TargetIndex } from "./target-index.js";

export type TargetResolverConfidence = "none" | "low" | "medium" | "high" | "ambiguous";

export interface TargetResolverQuery {
  readonly text?: string;
  readonly area?: string;
  readonly domain?: string;
  readonly capability?: HaCapability;
  readonly includeUnavailable?: boolean;
}

export interface TargetResolverMatch {
  readonly entityId: string;
  readonly domain: string;
  readonly areaId: string | null;
  readonly areaName: string | null;
  readonly deviceId: string | null;
  readonly deviceName: string | null;
  readonly capabilities: readonly HaCapability[];
  readonly available: boolean;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface TargetResolverResult {
  readonly confidence: TargetResolverConfidence;
  readonly matches: readonly TargetResolverMatch[];
  readonly rejectedCount: number;
}

interface AliasQueryMatch {
  readonly alias: AliasEntry;
  readonly textScore: {
    readonly kind: "exact" | "partial" | "tokens";
    readonly score: number;
  };
}

/**
 * Render the exact source identity that made a unique match possible. Aliases
 * keep the operator's wording; area composites stay conversational; exact
 * device/registry names must not collapse back to a duplicate friendly name.
 */
export function exactTargetDisplayLabel(
  query: string,
  friendlyName: string,
  match: TargetResolverMatch,
): string {
  // The alias as the owner wrote it ("HVAC", "Sam's bedroom lights"), not the lowercased spoken words.
  const aliases = match.reasons
    .filter((reason) => reason.startsWith("alias_exact:"))
    .map((reason) => reason.split(":").slice(2).join(":"));
  if (aliases.length > 0) {
    return aliases.find((alias) => semanticTargetKey(normalize(alias) ?? "") === semanticTargetKey(normalize(query) ?? "")) ?? aliases[0] ?? query;
  }
  const normalizedQuery = normalize(query);
  const normalizedFriendly = normalize(friendlyName);
  const normalizedArea = normalize(match.areaName);
  if (normalizedQuery
    && normalizedArea
    && normalizedPhraseIncludes(normalizedQuery, normalizedArea)
    && (!normalizedFriendly || !normalizedPhraseIncludes(normalizedFriendly, normalizedArea))) {
    return `${friendlyName} in ${match.areaName}`;
  }
  const exactSourceLabel = match.reasons
    .filter((reason) => reason.startsWith("exact:"))
    .map((reason) => reason.slice("exact:".length).trim())
    .find((label) => normalize(label) === normalizedQuery);
  if (exactSourceLabel
    && normalize(exactSourceLabel) !== normalize(match.entityId)
    && normalize(exactSourceLabel) !== normalizedFriendly) {
    return exactSourceLabel;
  }
  return friendlyName;
}

/**
 * The one name scorer (exact, partial, word match, plus manual aliases). It
 * scores only the entities the target index says share the query's words.
 */
export class TargetResolver {
  private readonly registryIndex: HaRegistryIndex;
  private readonly capabilityIndex: HaCapabilityIndex;
  private readonly names: TargetIndex;
  private readonly aliases: readonly AliasEntry[];
  private readonly results = new Map<string, TargetResolverResult>();

  constructor(
    registryIndex: HaRegistryIndex,
    capabilityIndex: HaCapabilityIndex,
    names: TargetIndex,
    aliases: readonly AliasEntry[] = [],
  ) {
    this.registryIndex = registryIndex;
    this.capabilityIndex = capabilityIndex;
    this.names = names;
    this.aliases = aliases.map(cloneAliasEntry);
    Object.freeze(this);
  }

  /** Results are frozen and shared: the same query against the same sources reads the same answer. */
  resolve(query: TargetResolverQuery): TargetResolverResult {
    const key = JSON.stringify([
      query.text ?? null,
      query.area ?? null,
      query.domain ?? null,
      query.capability ?? null,
      query.includeUnavailable === true,
    ]);
    let result = this.results.get(key);
    if (!result) {
      if (this.results.size >= RESULT_MEMO_LIMIT) this.results.clear();
      result = deepFreeze(this.score(query));
      this.results.set(key, result);
    }
    return result;
  }

  private score(query: TargetResolverQuery): TargetResolverResult {
    const normalizedText = normalize(query.text);
    const normalizedArea = normalize(query.area);
    const aliasQueryMatches = normalizedText
      ? matchingAliases(this.aliases, normalizedText)
      : [];
    const matches: TargetResolverMatch[] = [];

    for (const capabilityEntity of this.candidates(normalizedText, aliasQueryMatches)) {
      const registryEntity = this.registryIndex.entity(capabilityEntity.entityId);
      if (!registryEntity
        || (!query.includeUnavailable && !capabilityEntity.available)
        || (query.domain && capabilityEntity.domain !== query.domain)
        || (query.capability && !capabilityEntity.capabilities.includes(query.capability))
        || (normalizedArea && !this.areaMatches(registryEntity, normalizedArea))) {
        continue;
      }

      const scored = scoreEntity(
        capabilityEntity,
        this.names.entity(capabilityEntity.entityId)?.resolverNames ?? [],
        normalizedText,
        normalizedArea,
        query,
        aliasQueryMatches,
        registryEntity,
      );
      if (scored.score > 0 && (!normalizedText || scored.nameMatched)) {
        const { nameMatched: _nameMatched, ...match } = scored;
        matches.push(match);
      }
    }

    const sortedMatches = matches.sort((left, right) => {
      const scoreDiff = right.score - left.score;
      return scoreDiff === 0 ? left.entityId.localeCompare(right.entityId) : scoreDiff;
    });
    const prunedMatches = pruneDominatedMatches(sortedMatches);

    return {
      confidence: confidenceFor(prunedMatches),
      matches: prunedMatches,
      rejectedCount: this.capabilityIndex.size - matches.length,
    };
  }

  /** Only entities sharing the query's words, or bound to an alias it matched, can score. */
  private candidates(
    normalizedText: string | null,
    aliasQueryMatches: readonly AliasQueryMatch[],
  ): Iterable<HaCapabilityEntity> {
    if (!normalizedText || aliasQueryMatches.some(({ alias }) => alias.target.kind === "capability")) {
      return this.capabilityIndex.entries();
    }
    const entityIds = new Set(this.names.resolverCandidates(normalizedText));
    for (const { alias } of aliasQueryMatches) {
      const target = alias.target;
      const ids = target.kind === "entity"
        ? [target.entityId]
        : target.kind === "group"
          ? target.entityIds
          : target.kind === "area" ? this.names.entityIdsInArea(target.areaId) : [];
      for (const entityId of ids) entityIds.add(entityId);
    }
    return [...entityIds].flatMap((entityId) => {
      const entity = this.capabilityIndex.entity(entityId);
      return entity ? [entity] : [];
    });
  }

  private areaMatches(registryEntity: HaIndexedEntity, normalizedArea: string): boolean {
    if (manualAreaMatches(registryEntity, normalizedArea, this.aliases)) {
      return true;
    }
    return (this.names.entity(registryEntity.entityId)?.resolverAreaKeys
      ?? [registryEntity.effectiveAreaId, registryEntity.effectiveAreaName, ...registryEntity.nameCandidates].map(normalize))
      .some((candidate) => candidate === normalizedArea);
  }
}

interface ResolverSources {
  readonly stateRevision: number;
  readonly capabilityIndex: HaCapabilityIndex;
  readonly names: TargetIndex;
  readonly resolvers: WeakMap<readonly AliasEntry[], TargetResolver>;
}

const RESULT_MEMO_LIMIT = 256;
const RESOLVER_SOURCES = new WeakMap<object, WeakMap<object, ResolverSources>>();

function resolverSources(snapshot: HaStateRoutingSnapshot, registry: HaRegistryIndex): ResolverSources {
  let byRegistry = RESOLVER_SOURCES.get(snapshot.shape);
  if (!byRegistry) {
    byRegistry = new WeakMap();
    RESOLVER_SOURCES.set(snapshot.shape, byRegistry);
  }
  let sources = byRegistry.get(registry.contentKey());
  if (sources?.stateRevision !== snapshot.revision) {
    sources = {
      stateRevision: snapshot.revision,
      capabilityIndex: new HaCapabilityIndex(snapshot.entries, registry),
      names: targetIndexFor(snapshot, registry),
      resolvers: new WeakMap(),
    };
    byRegistry.set(registry.contentKey(), sources);
  }
  return sources;
}

/** The capability index for these states and registry, built once per state change. */
export function sharedCapabilityIndex(snapshot: HaStateRoutingSnapshot, registry: HaRegistryIndex): HaCapabilityIndex {
  return resolverSources(snapshot, registry).capabilityIndex;
}

/**
 * The shared resolver for the current HA states, registry and aliases. Its
 * capability index is rebuilt once per state change, its names once per name
 * change.
 */
export function targetResolverFor(
  states: HaStateCache | HaStateRoutingSnapshot,
  registry: HaRegistryIndex,
  aliases: readonly AliasEntry[] = NO_ALIASES,
): TargetResolver {
  const sources = resolverSources("routingSnapshot" in states ? states.routingSnapshot() : states, registry);
  let resolver = sources.resolvers.get(aliases);
  if (!resolver) {
    resolver = new TargetResolver(registry, sources.capabilityIndex, sources.names, aliases);
    sources.resolvers.set(aliases, resolver);
  }
  return resolver;
}

const NO_ALIASES: readonly AliasEntry[] = Object.freeze([]);

function scoreEntity(
  capabilityEntity: HaCapabilityEntity,
  names: readonly ResolverName[],
  normalizedText: string | null,
  normalizedArea: string | null,
  query: TargetResolverQuery,
  aliasQueryMatches: readonly AliasQueryMatch[],
  registryEntity: HaIndexedEntity,
): TargetResolverMatch & { readonly nameMatched: boolean } {
  const reasons: string[] = [];
  let score = 0;

  if (query.capability) {
    score += 15;
    reasons.push(`capability:${query.capability}`);
  }
  if (query.domain) {
    score += 10;
    reasons.push(`domain:${query.domain}`);
  }
  if (normalizedArea) {
    score += 20;
    reasons.push(`area:${registryEntity.effectiveAreaId ?? normalizedArea}`);
  }

  if (normalizedText) {
    const nameScore = bestNameScore(names, normalizedText);
    score += nameScore.score;
    reasons.push(...nameScore.reasons);

    const aliasScore = bestAliasScore(capabilityEntity, registryEntity, aliasQueryMatches);
    score += aliasScore.score;
    reasons.push(...aliasScore.reasons);
  }

  return {
    entityId: capabilityEntity.entityId,
    domain: capabilityEntity.domain,
    areaId: capabilityEntity.areaId,
    areaName: capabilityEntity.areaName,
    deviceId: capabilityEntity.deviceId,
    deviceName: capabilityEntity.deviceName,
    capabilities: [...capabilityEntity.capabilities],
    available: capabilityEntity.available,
    score,
    reasons,
    nameMatched: !normalizedText || reasons.some((reason) => /^(exact|partial|tokens|alias_)/.test(reason)),
  };
}

function bestAliasScore(
  capabilityEntity: HaCapabilityEntity,
  registryEntity: HaIndexedEntity,
  aliasQueryMatches: readonly AliasQueryMatch[],
): { readonly score: number; readonly reasons: readonly string[] } {
  let score = 0;
  const reasons: string[] = [];

  for (const { alias, textScore } of aliasQueryMatches) {
    if (!aliasTargetMatches(alias.target, capabilityEntity, registryEntity)) {
      continue;
    }

    score = Math.max(score, textScore.score);
    reasons.push(`alias_${textScore.kind}:${alias.target.kind}:${alias.alias}`);
  }

  return {
    score,
    reasons: [...new Set(reasons)],
  };
}

function matchingAliases(
  aliases: readonly AliasEntry[],
  normalizedText: string,
): readonly AliasQueryMatch[] {
  return aliases.flatMap((alias) => {
    const textScore = aliasTextScore(alias.normalizedAlias, normalizedText);
    return textScore ? [{ alias, textScore }] : [];
  });
}

function aliasTextScore(
  normalizedAlias: string,
  normalizedText: string,
): { readonly kind: "exact" | "partial" | "tokens"; readonly score: number } | null {
  // Plurals fold ("office light" is the "office lights" alias): a spoken
  // singular must never slide to a different device that a word match prefers.
  if (normalizedAlias === normalizedText || semanticTargetKey(normalizedAlias) === semanticTargetKey(normalizedText)) {
    return { kind: "exact", score: 120 };
  }
  if (normalizedPhraseIncludes(normalizedAlias, normalizedText) || normalizedPhraseIncludes(normalizedText, normalizedAlias)) {
    return { kind: "partial", score: 75 };
  }
  if (tokensMatch(normalizedAlias, normalizedText)) {
    return { kind: "tokens", score: 55 };
  }
  return null;
}

function aliasTargetMatches(
  target: AliasTarget,
  capabilityEntity: HaCapabilityEntity,
  registryEntity: HaIndexedEntity,
): boolean {
  switch (target.kind) {
    case "entity":
      return target.entityId === capabilityEntity.entityId;
    case "group":
      return target.entityIds.includes(capabilityEntity.entityId);
    case "area":
      return target.areaId === registryEntity.effectiveAreaId;
    case "capability":
      return (
        capabilityEntity.capabilities.includes(target.capability) &&
        (!target.areaId || target.areaId === registryEntity.effectiveAreaId) &&
        (!target.domain || target.domain === capabilityEntity.domain)
      );
  }
}

function bestNameScore(
  names: readonly ResolverName[],
  normalizedText: string,
): { readonly score: number; readonly reasons: readonly string[] } {
  let score = 0;
  const reasons: string[] = [];

  for (const { raw: candidate, key: normalizedCandidate } of names) {
    if (normalizedCandidate === normalizedText) {
      score = Math.max(score, 100);
      reasons.push(`exact:${candidate}`);
    } else if (normalizedPhraseIncludes(normalizedCandidate, normalizedText) || textContainsSpecificCandidate(normalizedText, normalizedCandidate)) {
      score = Math.max(score, 60);
      reasons.push(`partial:${candidate}`);
    } else if (tokensMatch(normalizedCandidate, normalizedText)) {
      score = Math.max(score, 40);
      reasons.push(`tokens:${candidate}`);
    }
  }

  return {
    score,
    reasons: [...new Set(reasons)],
  };
}

function textContainsSpecificCandidate(normalizedText: string, normalizedCandidate: string): boolean {
  return normalizedPhraseIncludes(normalizedText, normalizedCandidate)
    && normalizedCandidate.split(" ").filter(Boolean).length >= 3;
}

function confidenceFor(matches: readonly TargetResolverMatch[]): TargetResolverConfidence {
  const best = matches[0];
  if (!best) {
    return "none";
  }
  const second = matches[1];
  if (second && best.score === second.score && sharedTopExactGroupAlias(matches)) {
    return "high";
  }
  if (second && best.score - second.score < 10) {
    return "ambiguous";
  }
  if (best.score >= 80) {
    return "high";
  }
  if (best.score >= 30) {
    return "medium";
  }
  return "low";
}

function pruneDominatedMatches(matches: readonly TargetResolverMatch[]): readonly TargetResolverMatch[] {
  const best = matches[0];
  const second = matches[1];
  const sharedGroupAlias = sharedTopExactGroupAlias(matches);
  if (best && sharedGroupAlias) {
    return matches.filter((match) => match.score === best.score && match.reasons.includes(sharedGroupAlias));
  }
  if (best && second && best.score >= 80 && best.score - second.score >= 10) {
    return [best];
  }
  return matches;
}

function sharedTopExactGroupAlias(matches: readonly TargetResolverMatch[]): string | null {
  const best = matches[0];
  if (!best) {
    return null;
  }
  const topMatches = matches.filter((match) => match.score === best.score);
  if (topMatches.length < 2) {
    return null;
  }
  const firstGroupAlias = topMatches[0]?.reasons.find((reason) => reason.startsWith("alias_exact:group:"));
  if (!firstGroupAlias) {
    return null;
  }
  return topMatches.every((match) => match.reasons.includes(firstGroupAlias)) ? firstGroupAlias : null;
}

function manualAreaMatches(
  registryEntity: HaIndexedEntity,
  normalizedArea: string,
  aliases: readonly AliasEntry[],
): boolean {
  return aliases.some(
    (alias) =>
      alias.target.kind === "area" &&
      alias.normalizedAlias === normalizedArea &&
      alias.target.areaId === registryEntity.effectiveAreaId,
  );
}

function tokensMatch(candidate: string, text: string): boolean {
  const textTokens = text.split(" ").filter(Boolean);
  return textTokens.length > 0 && textTokens.every((token) => normalizedPhraseIncludes(candidate, token));
}

function normalizedPhraseIncludes(value: string, phrase: string): boolean {
  return ` ${value} `.includes(` ${phrase} `);
}

function cloneAliasEntry(entry: AliasEntry): AliasEntry {
  return {
    ...entry,
    target: cloneAliasTarget(entry.target),
  };
}

function cloneAliasTarget(target: AliasTarget): AliasTarget {
  if (target.kind === "group") {
    return {
      ...target,
      entityIds: [...target.entityIds],
    };
  }
  return { ...target };
}
