import type {
  BasicTurnAnalysis,
  BasicTurnCapabilityView,
  BasicTurnRegistryTarget,
} from "./basic-turn-analysis.js";
import type { HaEntityState } from "./ha-state-cache.js";
import { canonicalStatusRequestedStateForEntityIds } from "./entity-status-state.js";
import { friendlyName } from "./ha-state-cache.js";
import {
  canonicalSemanticToken,
  exactTextKey,
  semanticTokens,
  statusTargetText as normalizeStatusTargetText,
  type TargetIndex,
} from "./target-index.js";

export type EntityStatusTargetSource =
  | "alias"
  | "entity_id"
  | "exact_name"
  | "area_domain"
  | "state_hint";

export type EntityStatusRequestedAttribute = "temperature";

export interface EntityStatusResolvedTarget {
  readonly query: string;
  readonly label: string;
  readonly entityIds: readonly string[];
  readonly match: "resolved" | "exact";
  readonly source: EntityStatusTargetSource;
}

export interface EntityStatusAmbiguityCandidate {
  readonly entityId: string;
  readonly label: string;
  readonly source: EntityStatusTargetSource;
}

export type EntityStatusTargetResolution =
  | { readonly outcome: "resolved"; readonly target: EntityStatusResolvedTarget }
  | { readonly outcome: "unavailable"; readonly target: EntityStatusResolvedTarget }
  | { readonly outcome: "incompatible"; readonly target: EntityStatusResolvedTarget }
  | {
      readonly outcome: "ambiguous";
      readonly query: string;
      readonly candidates: readonly EntityStatusAmbiguityCandidate[];
    }
  | { readonly outcome: "missing"; readonly query: string };

type TurnAliasEntry = ReturnType<BasicTurnAnalysis["sources"]["aliases"]>[number];
type CapabilityEntry = ReturnType<BasicTurnCapabilityView["entries"]>[number];

interface TargetSemantics {
  readonly normalized: string;
  readonly domains: readonly string[] | null;
  readonly capability: EntityStatusRequestedAttribute | null;
  readonly requiredObjectTokens: readonly string[];
  readonly scopeTokens: readonly string[];
  readonly conjunctScopes: readonly (readonly string[])[];
  readonly requestsCollection: boolean;
}

/**
 * Resolve one status target from exact operator declarations or exact source
 * evidence. No registration-order fallback, fuzzy score, or phrase rewrite is
 * allowed to create a target.
 */
export function resolveStandaloneEntityStatusTarget(options: {
  readonly targetText: string;
  readonly requestedState: string | null;
  readonly requestedAttribute?: EntityStatusRequestedAttribute | null;
  readonly quantifier?: "any" | "all" | "which" | null;
  readonly analysis: BasicTurnAnalysis;
}): EntityStatusTargetResolution {
  const query = canonicalStatusTargetQuery(options.targetText, options.analysis);
  const semantics = targetSemantics(
    query,
    options.requestedAttribute ?? null,
    options.quantifier ?? null,
  );
  const states = options.analysis.sources.states();
  const statesById = byEntityId(states);

  const exactAlias = options.analysis.sources.aliases()
    .find((entry) => exactTextKey(entry.alias) === exactTextKey(query));
  if (exactAlias) {
    return resolveExactAlias(
      exactAlias,
      query,
      semantics,
      options.requestedState,
      options.analysis,
      statesById,
    );
  }

  const exactEntityId = states.find(
    (state) => state.entityId.toLowerCase() === query.trim().toLowerCase(),
  );
  if (exactEntityId) {
    const capability = options.analysis.sources.capabilities()?.entity(exactEntityId.entityId) ?? null;
    if (!stateMatchesSemanticContract(exactEntityId, capability, semantics)
      || !stateSupportsRequestedStateOrNoPredicate(exactEntityId, options.requestedState, true)) {
      return {
        outcome: "incompatible",
        target: resolvedStateTarget(query, [exactEntityId], "entity_id"),
      };
    }
    return {
      outcome: "resolved",
      target: resolvedStateTarget(query, [exactEntityId], "entity_id"),
    };
  }

  const mixedRegisteredNames = mixedAvailabilityRegisteredNames(query, options.analysis, statesById);
  if (mixedRegisteredNames) {
    if (options.quantifier) {
      return {
        outcome: "unavailable",
        target: resolvedRegisteredTarget(query, mixedRegisteredNames, "exact_name"),
      };
    }
    return {
      outcome: "ambiguous",
      query,
      candidates: registryAmbiguityCandidates(query, mixedRegisteredNames),
    };
  }

  const capabilityEntries = options.analysis.sources.capabilities()?.entries() ?? [];
  const capabilityById = byEntityId(capabilityEntries);
  const exactNames = exactNameMatches(query, options.analysis, statesById);
  if (exactNames.length > 0) {
    const narrowed = exactNames.filter((state) => stateMatchesSemanticContract(
      state,
      capabilityById.get(state.entityId) ?? null,
      semantics,
    ) && stateSupportsRequestedStateOrNoPredicate(
      state,
      options.requestedState,
      targetExplicitlyNamesLock(semantics),
    ));
    if (narrowed.length === 0) {
      return {
        outcome: "incompatible",
        target: resolvedStateTarget(query, exactNames, "exact_name"),
      };
    }
    if (narrowed.length === 1) {
      return {
        outcome: "resolved",
        target: resolvedStateTarget(query, narrowed, "exact_name"),
      };
    }
    if (options.quantifier) {
      return {
        outcome: "resolved",
        target: {
          query,
          label: query,
          entityIds: narrowed.map((state) => state.entityId).sort((left, right) => left.localeCompare(right)),
          match: "exact",
          source: "exact_name",
        },
      };
    }
    return {
      outcome: "ambiguous",
      query,
      candidates: ambiguityCandidates(narrowed, capabilityById, "exact_name"),
    };
  }

  const unavailableRegistered = exactUnavailableRegisteredTarget(query, options.analysis, statesById);
  if (unavailableRegistered) {
    return { outcome: "unavailable", target: unavailableRegistered };
  }

  if (capabilityEntries.length === 0) {
    return { outcome: "missing", query };
  }

  return resolveCompositionalTarget({
    query,
    semantics,
    requestedState: options.requestedState,
    analysis: options.analysis,
    entries: capabilityEntries,
    statesById,
  });
}

function exactUnavailableRegisteredTarget(
  query: string,
  analysis: BasicTurnAnalysis,
  statesById: ReadonlyMap<string, HaEntityState>,
): EntityStatusResolvedTarget | null {
  const registry = analysis.sources.registryTargets();
  if (!registry) return null;

  const exactEntity = registry.entity(query);
  const source: "entity_id" | "exact_name" = exactEntity ? "entity_id" : "exact_name";
  const exactMatches = exactEntity ? [exactEntity] : registry.exactNameMatches(query);
  const unavailableMatches = exactMatches.filter((entry) => !statesById.has(entry.entityId));
  if (unavailableMatches.length === 0) return null;

  return resolvedRegisteredTarget(query, unavailableMatches, source);
}

function mixedAvailabilityRegisteredNames(
  query: string,
  analysis: BasicTurnAnalysis,
  statesById: ReadonlyMap<string, HaEntityState>,
): readonly BasicTurnRegistryTarget[] | null {
  const matches = analysis.sources.registryTargets()?.exactNameMatches(query) ?? [];
  if (matches.length < 2) return null;
  const availableCount = matches.filter((entry) => statesById.has(entry.entityId)).length;
  return availableCount > 0 && availableCount < matches.length ? matches : null;
}

function resolvedRegisteredTarget(
  query: string,
  matches: readonly BasicTurnRegistryTarget[],
  source: "entity_id" | "exact_name",
): EntityStatusResolvedTarget {
  return {
    query,
    label: matches.length === 1
      ? registryTargetLabel(matches[0] as BasicTurnRegistryTarget, query)
      : query,
    entityIds: matches.map((entry) => entry.entityId)
      .sort((left, right) => left.localeCompare(right)),
    match: "exact",
    source,
  };
}

function registryAmbiguityCandidates(
  query: string,
  matches: readonly BasicTurnRegistryTarget[],
): readonly EntityStatusAmbiguityCandidate[] {
  return withUniqueCandidateLabels([...matches]
    .sort((left, right) => left.entityId.localeCompare(right.entityId))
    .map((entry) => ({
      entityId: entry.entityId,
      label: registryTargetLabel(entry, query),
      detailLabel: entry.entityId,
      source: "exact_name" as const,
    })));
}

function registryTargetLabel(target: BasicTurnRegistryTarget, query: string): string {
  return target.nameCandidates.find((candidate) => exactTextKey(candidate) === exactTextKey(query))
    ?? target.nameCandidates.find((candidate) => candidate !== target.entityId)
    ?? target.entityId;
}

function resolveExactAlias(
  alias: TurnAliasEntry,
  query: string,
  semantics: TargetSemantics,
  requestedState: string | null,
  analysis: BasicTurnAnalysis,
  statesById: ReadonlyMap<string, HaEntityState>,
): EntityStatusTargetResolution {
  let entityIds: readonly string[] = [];
  let requiresCompleteState = false;
  const entries = analysis.sources.capabilities()?.entries() ?? [];
  const entryById = byEntityId(entries);

  if (alias.target.kind === "entity") {
    entityIds = [alias.target.entityId];
    requiresCompleteState = true;
  } else if (alias.target.kind === "group") {
    entityIds = alias.target.entityIds;
    requiresCompleteState = true;
  } else {
    const target = alias.target;
    if (target.kind === "area") {
      entityIds = entries
        .filter((entry) => entry.areaId === target.areaId)
        .filter((entry) => entryMatchesSemanticContract(entry, semantics))
        .map((entry) => entry.entityId);
    } else {
      if (semantics.capability && target.capability !== semantics.capability) {
        return {
          outcome: "incompatible",
          target: resolvedAliasTarget(query, alias, []),
        };
      }
      entityIds = entries
        .filter((entry) => entry.capabilities.includes(target.capability))
        .filter((entry) => !target.areaId || entry.areaId === target.areaId)
        .filter((entry) => !target.domain || entry.domain === target.domain)
        .map((entry) => entry.entityId);
    }
  }

  if (entityIds.length === 0) {
    return { outcome: "missing", query };
  }
  const target = resolvedAliasTarget(query, alias, entityIds);
  if (requiresCompleteState && new Set(entityIds).size !== entityIds.length) {
    return { outcome: "incompatible", target };
  }
  if (requiresCompleteState && entityIds.some((entityId) => !statesById.has(entityId))) {
    return { outcome: "unavailable", target };
  }
  const compatibleIds = entityIds.filter((entityId) => {
    const state = statesById.get(entityId);
    return Boolean(state
      && stateSupportsRequestedAttribute(state, entryById.get(entityId) ?? null, semantics.capability)
      && stateSupportsRequestedStateOrNoPredicate(state, requestedState, true));
  });
  if (compatibleIds.length === 0) {
    return { outcome: "incompatible", target };
  }
  if (requiresCompleteState && compatibleIds.length !== entityIds.length) {
    return { outcome: "incompatible", target };
  }
  return {
    outcome: "resolved",
    target: resolvedAliasTarget(query, alias, compatibleIds),
  };
}

function exactNameMatches(
  query: string,
  analysis: BasicTurnAnalysis,
  statesById: ReadonlyMap<string, HaEntityState>,
): readonly HaEntityState[] {
  const queryKey = exactTextKey(query);
  const matchedIds = new Set(analysis.sources.targetIndex()?.entityIdsWithExactName(queryKey) ?? []);

  const resolver = analysis.sources.targets();
  if (resolver) {
    const result = resolver.resolve({ text: query, includeUnavailable: true });
    for (const match of result.matches) {
      const state = statesById.get(match.entityId);
      if (!state) continue;
      const exactSourceNames = match.reasons
        .filter((reason) => reason.startsWith("exact:"))
        .map((reason) => reason.slice("exact:".length))
        .filter((name) => exactTextKey(name) === queryKey);
      const areaOnly = exactTextKey(match.areaName ?? "") === queryKey
        && exactTextKey(match.deviceName ?? "") !== queryKey
        && exactTextKey(friendlyName(state)) !== queryKey;
      if (exactSourceNames.length > 0 && !areaOnly) {
        matchedIds.add(match.entityId);
      }
    }
  }

  return [...matchedIds]
    .flatMap((entityId) => statesById.get(entityId) ?? [])
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
}

function resolveCompositionalTarget(options: {
  readonly query: string;
  readonly semantics: TargetSemantics;
  readonly requestedState: string | null;
  readonly analysis: BasicTurnAnalysis;
  readonly entries: readonly CapabilityEntry[];
  readonly statesById: ReadonlyMap<string, HaEntityState>;
}): EntityStatusTargetResolution {
  if (options.semantics.domains?.length === 0) {
    return { outcome: "missing", query: options.query };
  }

  if (options.semantics.conjunctScopes.length > 1) {
    return resolveConjunctiveTarget(options);
  }

  const evidence = resolverEvidence(options.analysis, options.query);
  const sourceMatches = compositionalMatches(
    options.entries,
    options.semantics,
    options.semantics.scopeTokens,
    evidence,
    options.analysis.sources.targetIndex(),
  );
  const matches = inExactArea(narrowEntriesByRequestedState(
    sourceMatches,
    options.requestedState,
    options.statesById,
    targetExplicitlyNamesLock(options.semantics),
  ), options.semantics.scopeTokens);
  if (matches.length === 0) {
    if (sourceMatches.length > 0 && options.requestedState) {
      return {
        outcome: "incompatible",
        target: resolvedCompositionalTarget(
          options.query,
          sourceMatches,
          compositionalSource(sourceMatches, options.semantics.scopeTokens),
          options.semantics.scopeTokens,
        ),
      };
    }
    return { outcome: "missing", query: options.query };
  }
  if (targetIsBareArea(matches, options.semantics, options.requestedState)) {
    return { outcome: "missing", query: options.query };
  }
  const source = compositionalSource(matches, options.semantics.scopeTokens);
  if (matches.length === 1 || targetMeansSourceBackedCollection(matches, options.semantics)) {
    return {
      outcome: "resolved",
      target: resolvedCompositionalTarget(
        options.query,
        matches,
        source,
        options.semantics.scopeTokens,
      ),
    };
  }
  return {
    outcome: "ambiguous",
    query: options.query,
    candidates: ambiguityCandidatesForEntries(matches, source),
  };
}

function resolveConjunctiveTarget(options: {
  readonly query: string;
  readonly semantics: TargetSemantics;
  readonly requestedState: string | null;
  readonly analysis: BasicTurnAnalysis;
  readonly entries: readonly CapabilityEntry[];
  readonly statesById: ReadonlyMap<string, HaEntityState>;
}): EntityStatusTargetResolution {
  const sourceMatchesByConjunct = options.semantics.conjunctScopes.map((scope) => {
    const evidence = resolverEvidence(options.analysis, scope.join(" "));
    return compositionalMatches(options.entries, options.semantics, scope, evidence, options.analysis.sources.targetIndex());
  });
  const matchesByConjunct = sourceMatchesByConjunct.map((sourceMatches) =>
    narrowEntriesByRequestedState(
      sourceMatches,
      options.requestedState,
      options.statesById,
      targetExplicitlyNamesLock(options.semantics),
    ));
  if (matchesByConjunct.some((matches) => matches.length === 0)) {
    const incompatible = sourceMatchesByConjunct.find((matches, index) =>
      matches.length > 0 && (matchesByConjunct[index]?.length ?? 0) === 0);
    if (incompatible && options.requestedState) {
      return {
        outcome: "incompatible",
        target: resolvedCompositionalTarget(
          options.query,
          incompatible,
          compositionalSource(incompatible, options.semantics.scopeTokens),
          options.semantics.scopeTokens,
        ),
      };
    }
    return { outcome: "missing", query: options.query };
  }

  const commonAreaIds = sortedUnique(matchesByConjunct[0]
    ?.map((entry) => entry.areaId)
    .filter((areaId): areaId is string => Boolean(areaId)) ?? [])
    .filter((areaId) => matchesByConjunct.every((matches) =>
      matches.some((entry) => entry.areaId === areaId)));
  if (commonAreaIds.length === 1) {
    const areaId = commonAreaIds[0] as string;
    const coherentMatches = uniqueEntries(matchesByConjunct.flatMap((matches) =>
      matches.filter((entry) => entry.areaId === areaId)));
    if (coherentMatches.length >= options.semantics.conjunctScopes.length) {
      return {
        outcome: "resolved",
        target: resolvedCompositionalTarget(
          options.query,
          coherentMatches,
          "area_domain",
          options.semantics.scopeTokens,
        ),
      };
    }
  }

  const everyScopeIsAreaCollection = matchesByConjunct.every((matches, index) =>
    targetScopeIsExactArea(matches, options.semantics.conjunctScopes[index] ?? []));
  const ambiguousConjunct = matchesByConjunct.find((matches) =>
    matches.length > 1 && !everyScopeIsAreaCollection);
  if (ambiguousConjunct) {
    const source = compositionalSource(ambiguousConjunct, options.semantics.scopeTokens);
    return {
      outcome: "ambiguous",
      query: options.query,
      candidates: ambiguityCandidatesForEntries(ambiguousConjunct, source),
    };
  }

  const matches = uniqueEntries(matchesByConjunct.flat());
  if (matches.length < options.semantics.conjunctScopes.length) {
    return { outcome: "missing", query: options.query };
  }
  const source = options.semantics.conjunctScopes.some((scope) =>
    targetScopeIsExactArea(matches, scope)) ? "area_domain" : "state_hint";
  return {
    outcome: "resolved",
    target: resolvedCompositionalTarget(
      options.query,
      matches,
      source,
      options.semantics.scopeTokens,
    ),
  };
}

function compositionalMatches(
  entries: readonly CapabilityEntry[],
  semantics: TargetSemantics,
  scopeTokens: readonly string[],
  resolverEvidenceById: ReadonlyMap<string, readonly string[]>,
  index: TargetIndex | null,
): readonly CapabilityEntry[] {
  if (!index) return [];
  const scopeMatches = entries.flatMap((entry) => {
    const extraNames = resolverEvidenceById.get(entry.entityId) ?? [];
    const names = index.entity(entry.entityId);
    if (!names) return [];
    const scopeEvidenceTokens = extraNames.length > 0
      ? new Set([...names.scopeTokens, ...extraNames.flatMap(semanticTokens)])
      : names.scopeTokens;
    const objectEvidenceTokens = names.objectTokens;
    return entryMatchesSemanticContract(entry, semantics, scopeEvidenceTokens)
      && scopeTokens.every((token) => scopeEvidenceTokens.has(token))
      && (!isDeviceSelfReading(entry)
        || scopeTokens.every((token) => objectEvidenceTokens.has(token)))
      ? [{ entry, objectEvidenceTokens }]
      : [];
  });

  return scopeMatches.filter(({ entry, objectEvidenceTokens }) =>
    semantics.requiredObjectTokens.every((token) =>
      objectEvidenceTokens.has(token)
        || sourceBackedObjectSynonymMatches({
          token,
          entry,
          scopeTokens,
          scopeMatchCount: scopeMatches.length,
        })))
    .map(({ entry }) => entry);
}

/**
 * Diagnostic and config entities (a NAS's system temperature) report on the
 * device itself, not the room it sits in. An area alone never selects them;
 * the device or entity must be named.
 */
function isDeviceSelfReading(entry: CapabilityEntry): boolean {
  return entry.entityCategory === "diagnostic" || entry.entityCategory === "config";
}

/**
 * A lamp is physically a light, but that domain synonym is only enough when
 * source-backed modifiers identify one specific light. This lets `office
 * secondary lamp` bind to an entity sourced as `Office Secondary` without
 * turning a bare `office lamp` into whichever light happened to register
 * first.
 */
function sourceBackedObjectSynonymMatches(options: {
  readonly token: string;
  readonly entry: CapabilityEntry;
  readonly scopeTokens: readonly string[];
  readonly scopeMatchCount: number;
}): boolean {
  if (options.token !== "lamp"
    || options.entry.domain !== "light"
    || options.scopeMatchCount !== 1
    || options.scopeTokens.length === 0) {
    return false;
  }

  const areaTokens = new Set([options.entry.areaId, options.entry.areaName]
    .flatMap((value) => semanticTokens(value ?? "")));
  if (areaTokens.size > 0) {
    return options.scopeTokens.some((token) => !areaTokens.has(token));
  }
  return options.scopeTokens.length >= 2;
}

function entryMatchesSemanticContract(
  entry: CapabilityEntry,
  semantics: TargetSemantics,
  evidenceTokens?: ReadonlySet<string>,
): boolean {
  if (semantics.domains && !semantics.domains.includes(entry.domain)) return false;
  if (!semantics.capability || entry.capabilities.includes(semantics.capability)) return true;
  return Boolean(evidenceTokens?.has(semantics.capability));
}

function stateMatchesSemanticContract(
  state: HaEntityState,
  entry: CapabilityEntry | null,
  semantics: TargetSemantics,
): boolean {
  const domain = state.entityId.split(".", 1)[0] ?? "";
  if (semantics.domains && !semantics.domains.includes(domain)) return false;
  return stateSupportsRequestedAttribute(state, entry, semantics.capability);
}

function stateSupportsRequestedAttribute(
  state: HaEntityState,
  entry: CapabilityEntry | null,
  requestedAttribute: EntityStatusRequestedAttribute | null,
): boolean {
  if (!requestedAttribute) return true;
  if (entry?.capabilities.includes(requestedAttribute)) return true;
  return sourceEvidenceTokensForState(state).has(requestedAttribute);
}

function sourceEvidenceTokensForState(state: HaEntityState): ReadonlySet<string> {
  return new Set([state.entityId, friendlyName(state)]
    .flatMap((value) => semanticTokens(value)));
}

function stateSupportsRequestedStateOrNoPredicate(
  state: HaEntityState,
  requestedState: string | null,
  allowLockOpenClosed = false,
): boolean {
  return !requestedState || stateSupportsRequestedState(state, requestedState, allowLockOpenClosed);
}

function resolverEvidence(
  analysis: BasicTurnAnalysis,
  query: string,
): ReadonlyMap<string, readonly string[]> {
  const resolver = analysis.sources.targets();
  if (!resolver) return new Map();
  const result = resolver.resolve({ text: query, includeUnavailable: true });
  const evidence = new Map<string, string[]>();
  for (const match of result.matches) {
    const names = match.reasons.flatMap((reason) => {
      const prefix = ["exact:", "partial:", "tokens:"]
        .find((candidate) => reason.startsWith(candidate));
      return prefix ? [reason.slice(prefix.length)] : [];
    });
    evidence.set(match.entityId, names);
  }
  return evidence;
}

function targetMeansSourceBackedCollection(
  matches: readonly CapabilityEntry[],
  semantics: TargetSemantics,
): boolean {
  if (semantics.requestsCollection) return true;
  const areaIds = sortedUnique(matches
    .map((entry) => entry.areaId)
    .filter((areaId): areaId is string => Boolean(areaId)));
  if (areaIds.length !== 1 || semantics.scopeTokens.length === 0) return false;
  const first = matches[0];
  if (!first) return false;
  const areaKeys = [first.areaId, first.areaName]
    .filter((value): value is string => Boolean(value))
    .map((value) => semanticTokens(value).join(" "));
  return areaKeys.includes(semantics.scopeTokens.join(" "));
}

function targetIsBareArea(
  matches: readonly CapabilityEntry[],
  semantics: TargetSemantics,
  requestedState: string | null,
): boolean {
  const structurallyNamesOneFixture = matches.length === 1
    && requestedState !== null
    && ["open", "closed", "locked", "unlocked"].includes(requestedState);
  return semantics.domains === null
    && semantics.capability === null
    && semantics.requiredObjectTokens.length === 0
    && !structurallyNamesOneFixture
    && targetScopeIsExactArea(matches, semantics.scopeTokens);
}

/**
 * When the words name one area exactly ("lounge room"), only that area's
 * entries: "Front Lounge" shares a word, not the name. Otherwise unchanged.
 */
function inExactArea(matches: readonly CapabilityEntry[], scopeTokens: readonly string[]): readonly CapabilityEntry[] {
  const exact = matches.filter((entry) => targetScopeIsExactArea([entry], scopeTokens));
  return exact.length > 0 ? exact : matches;
}

function targetScopeIsExactArea(
  matches: readonly CapabilityEntry[],
  scopeTokens: readonly string[],
): boolean {
  if (scopeTokens.length === 0) return false;
  const scope = scopeTokens.join(" ");
  return matches.some((entry) => [entry.areaId, entry.areaName]
    .filter((value): value is string => Boolean(value))
    .some((value) => semanticTokens(value).join(" ") === scope));
}

function resolvedCompositionalTarget(
  query: string,
  matches: readonly CapabilityEntry[],
  source: "area_domain" | "state_hint",
  scopeTokens: readonly string[],
): EntityStatusResolvedTarget {
  const only = matches.length === 1 ? matches[0] : null;
  return {
    query,
    label: only ? compositionalTargetLabel(query, only, scopeTokens) : query,
    entityIds: matches.map((entry) => entry.entityId).sort((left, right) => left.localeCompare(right)),
    match: "resolved",
    source,
  };
}

function compositionalTargetLabel(
  query: string,
  entry: CapabilityEntry,
  scopeTokens: readonly string[],
): string {
  const sourceLabel = entry.friendlyName ?? entry.deviceName ?? query;
  const sourceTokens = new Set(semanticTokens(sourceLabel));
  // Keep a spoken room/qualifier when it was needed to identify the source,
  // but do not echo generic object heads such as "sensor" over the canonical
  // Home Assistant label.
  return scopeTokens.some((token) => !sourceTokens.has(token)) ? query : sourceLabel;
}

function resolvedAliasTarget(
  query: string,
  alias: TurnAliasEntry,
  entityIds: readonly string[],
): EntityStatusResolvedTarget {
  return {
    query,
    label: alias.alias,
    entityIds: sortedUnique(entityIds),
    match: "exact",
    source: "alias",
  };
}

function resolvedStateTarget(
  query: string,
  states: readonly HaEntityState[],
  source: "entity_id" | "exact_name",
): EntityStatusResolvedTarget {
  const only = states.length === 1 ? states[0] : null;
  return {
    query,
    // An exact registry/resolver name can carry a room or facet that the
    // entity's short friendly name omits. Retain that sourced name; entity-id
    // lookups still render through the friendly label.
    label: only ? source === "exact_name" ? query : friendlyName(only) : query,
    entityIds: states.map((state) => state.entityId).sort((left, right) => left.localeCompare(right)),
    match: "exact",
    source,
  };
}

function compositionalSource(
  matches: readonly CapabilityEntry[],
  scopeTokens: readonly string[],
): "area_domain" | "state_hint" {
  const areaTokens = new Set(matches.flatMap((entry) => [entry.areaId, entry.areaName]
    .flatMap((value) => semanticTokens(value ?? ""))));
  return scopeTokens.some((token) => areaTokens.has(token)) ? "area_domain" : "state_hint";
}

function targetSemantics(
  value: string,
  requestedAttribute: EntityStatusRequestedAttribute | null,
  quantifier: "any" | "all" | "which" | null,
): TargetSemantics {
  const normalized = normalizeStatusTargetText(value);
  const rawTokens = normalized
    .replaceAll(/[._:]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const tokens = rawTokens.map(canonicalSemanticToken);
  const headDefinitions = tokens
    .map((token) => TARGET_HEADS[token])
    .filter((definition): definition is TargetHeadDefinition => Boolean(definition));
  let domains: Set<string> | null = null;
  for (const definition of headDefinitions) {
    if (!definition.domains) continue;
    const definitionDomains = definition.domains;
    if (domains === null) {
      domains = new Set(definitionDomains);
    } else {
      const existingDomains: ReadonlySet<string> = domains;
      domains = new Set([...existingDomains].filter((domain) => definitionDomains.includes(domain)));
    }
  }
  if (requestedAttribute === "temperature") {
    const attributeDomains = new Set(["sensor", "climate"]);
    if (domains === null) {
      domains = attributeDomains;
    } else {
      const existingDomains: ReadonlySet<string> = domains;
      domains = new Set([...existingDomains].filter((domain) => attributeDomains.has(domain)));
    }
  }

  const headTokens = new Set(Object.keys(TARGET_HEADS));
  const contentTokens = tokens.filter((token) => !TARGET_SCOPE_STOP_WORDS.has(token) && !headTokens.has(token));
  const conjunctScopes = splitConjunctScopes(contentTokens);
  const requiredObjectTokens = sortedUnique(tokens.flatMap(
    (token) => TARGET_HEADS[token]?.requiresObjectEvidence ? [token] : [],
  ));
  return {
    normalized,
    domains: domains === null ? null : [...domains].sort(),
    capability: requestedAttribute,
    requiredObjectTokens,
    scopeTokens: contentTokens.filter((token) => token !== "and"),
    conjunctScopes,
    requestsCollection: quantifier !== null || rawTokens.some((token) => COLLECTION_HEADS.has(token)),
  };
}

function targetExplicitlyNamesLock(semantics: TargetSemantics): boolean {
  return /(?:^|\s)locks?(?:\s|$)/.test(semantics.normalized);
}

interface TargetHeadDefinition {
  readonly domains?: readonly string[];
  readonly requiresObjectEvidence?: boolean;
}

const TARGET_HEADS: Readonly<Record<string, TargetHeadDefinition>> = Object.freeze({
  light: { domains: ["light"] },
  lighting: { domains: ["light"] },
  lamp: { domains: ["light"], requiresObjectEvidence: true },
  sensor: { domains: ["sensor", "binary_sensor"] },
  temperature: { domains: ["sensor", "climate"] },
  temp: { domains: ["sensor", "climate"] },
  humidity: { domains: ["sensor", "climate"], requiresObjectEvidence: true },
  lock: { domains: ["lock"] },
  switch: { domains: ["switch", "input_boolean"] },
  outlet: { domains: ["switch", "input_boolean"], requiresObjectEvidence: true },
  plug: { domains: ["switch", "input_boolean"], requiresObjectEvidence: true },
  socket: { domains: ["switch", "input_boolean"], requiresObjectEvidence: true },
  door: { domains: ["binary_sensor", "cover", "lock"], requiresObjectEvidence: true },
  window: { domains: ["binary_sensor", "cover", "lock"], requiresObjectEvidence: true },
  gate: { domains: ["binary_sensor", "cover", "lock"], requiresObjectEvidence: true },
  blind: { domains: ["cover"], requiresObjectEvidence: true },
  shade: { domains: ["cover"], requiresObjectEvidence: true },
  curtain: { domains: ["cover"], requiresObjectEvidence: true },
  fan: { domains: ["fan"] },
  vacuum: { domains: ["vacuum"] },
  thermostat: { domains: ["climate"] },
  climate: { domains: ["climate"] },
  person: { domains: ["person"] },
});

const COLLECTION_HEADS = new Set([
  "lights", "lighting", "lamps", "sensors", "switches", "outlets", "plugs", "sockets",
  "doors", "windows", "gates", "blinds", "shades", "curtains", "fans", "vacuums", "people",
]);

const TARGET_SCOPE_STOP_WORDS = new Set([
  "a", "an", "the", "my", "our", "your", "in", "at", "of", "for", "to", "s", "room",
]);

function splitConjunctScopes(tokens: readonly string[]): readonly (readonly string[])[] {
  if (!tokens.includes("and")) return tokens.length > 0 ? [tokens] : [];
  const scopes: string[][] = [[]];
  for (const token of tokens) {
    if (token === "and") {
      if ((scopes.at(-1)?.length ?? 0) > 0) scopes.push([]);
      continue;
    }
    scopes.at(-1)?.push(token);
  }
  return scopes.filter((scope) => scope.length > 0);
}

function narrowEntriesByRequestedState(
  entries: readonly CapabilityEntry[],
  requestedState: string | null,
  statesById: ReadonlyMap<string, HaEntityState>,
  allowLockOpenClosed = false,
): readonly CapabilityEntry[] {
  if (!requestedState) return entries;
  const compatible = entries.filter((entry) => {
    const state = statesById.get(entry.entityId);
    return state ? stateSupportsRequestedState(state, requestedState, allowLockOpenClosed) : false;
  });
  return compatible;
}

function stateSupportsRequestedState(
  state: HaEntityState,
  requestedState: string,
  allowLockOpenClosed = false,
): boolean {
  const domain = state.entityId.split(".", 1)[0] ?? "";
  const requested = normalizeStatusTargetText(
    canonicalStatusRequestedStateForEntityIds(requestedState, [state.entityId]) ?? requestedState,
  );
  if (domain === "person" || domain === "device_tracker") {
    return ["home", "not_home", "work", "school"].includes(requested);
  }
  if (domain === "lock") {
    return requested === "locked"
      || requested === "unlocked"
      || (allowLockOpenClosed && (requested === "open" || requested === "closed"));
  }
  if (domain === "binary_sensor") {
    const deviceClass = typeof state.attributes.device_class === "string"
      ? state.attributes.device_class.trim().toLowerCase()
      : "";
    if (["door", "garage_door", "opening", "window"].includes(deviceClass)) {
      return requested === "open" || requested === "closed";
    }
    return ["on", "off", "active", "inactive", "detected", "clear", "connected", "disconnected"].includes(requested);
  }
  if (["light", "switch", "input_boolean", "fan"].includes(domain)) {
    return ["on", "off", "out", "active", "inactive", "enabled", "disabled"].includes(requested);
  }
  if (domain === "cover") return ["open", "closed"].includes(requested);
  if (domain === "vacuum") return ["running", "active", "inactive", "on", "off"].includes(requested);
  return false;
}

function ambiguityCandidates(
  states: readonly HaEntityState[],
  capabilityById: ReadonlyMap<string, CapabilityEntry>,
  source: EntityStatusTargetSource,
): readonly EntityStatusAmbiguityCandidate[] {
  return withUniqueCandidateLabels(states.map((state) => {
    const capability = capabilityById.get(state.entityId);
    return {
      entityId: state.entityId,
      label: capability?.areaName ?? capability?.deviceName ?? friendlyName(state),
      detailLabel: capability?.deviceName ?? friendlyName(state),
      source,
    };
  }));
}

function ambiguityCandidatesForEntries(
  entries: readonly CapabilityEntry[],
  source: EntityStatusTargetSource,
): readonly EntityStatusAmbiguityCandidate[] {
  return withUniqueCandidateLabels([...entries]
    .sort((left, right) => left.entityId.localeCompare(right.entityId))
    .map((entry) => ({
      entityId: entry.entityId,
      label: entry.areaName ?? entry.deviceName ?? entry.friendlyName ?? entry.entityId,
      detailLabel: entry.deviceName ?? entry.friendlyName ?? entry.entityId,
      source,
    })));
}

function withUniqueCandidateLabels(
  candidates: readonly (EntityStatusAmbiguityCandidate & { readonly detailLabel: string })[],
): readonly EntityStatusAmbiguityCandidate[] {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.label, (counts.get(candidate.label) ?? 0) + 1);
  }
  const detailedCounts = new Map<string, number>();
  const detailed = candidates.map((candidate) => {
    const label = (counts.get(candidate.label) ?? 0) > 1
      ? `${candidate.label} — ${candidate.detailLabel}`
      : candidate.label;
    detailedCounts.set(label, (detailedCounts.get(label) ?? 0) + 1);
    return { ...candidate, label };
  });
  return detailed.map(({ detailLabel: _detailLabel, ...candidate }) => ({
    ...candidate,
    label: (detailedCounts.get(candidate.label) ?? 0) > 1
      ? `${candidate.label} (${candidate.entityId})`
      : candidate.label,
  }));
}

function canonicalStatusTargetQuery(targetText: string, analysis: BasicTurnAnalysis): string {
  const normalized = normalizeStatusTargetText(targetText);
  if (/^(?:i|me|myself)$/.test(normalized) && analysis.principal.trustedLabel) {
    return analysis.principal.trustedLabel;
  }
  return targetText.trim().replaceAll(/\s+/g, " ");
}

function uniqueEntries(entries: readonly CapabilityEntry[]): readonly CapabilityEntry[] {
  const byId = new Map(entries.map((entry) => [entry.entityId, entry]));
  return [...byId.values()].sort((left, right) => left.entityId.localeCompare(right.entityId));
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

const BY_ENTITY_ID = new WeakMap<readonly { readonly entityId: string }[], ReadonlyMap<string, unknown>>();

/** One id lookup per source list (states and capability entries are frozen per HA revision). */
function byEntityId<T extends { readonly entityId: string }>(items: readonly T[]): ReadonlyMap<string, T> {
  let map = BY_ENTITY_ID.get(items) as ReadonlyMap<string, T> | undefined;
  if (!map) {
    map = new Map(items.map((item) => [item.entityId, item]));
    BY_ENTITY_ID.set(items, map);
  }
  return map;
}
