import type { AliasEntry } from "./alias-schema.js";
import {
  clarify,
  declined,
  declinedReadFallback,
  declinedWithContext,
  ok,
  withheld,
  type BasicContextFrame,
  type BasicResult,
  type ClarifierQuestionType,
  type CurrentStatusPlan,
  type EntityStatusTargetAcquisition,
  type PendingClarifierChoice,
  type PendingClarifierFrame,
  type ResolvedTarget,
} from "./basic-brain-contracts.js";
import type { BasicBrainRouteServices } from "./basic-brain-services.js";
import type { BasicSpeechRenderPlan } from "./basic-speech-response.js";
import type { BasicTurnAnalysis, BasicTurnTargetView } from "./basic-turn-analysis.js";
import {
  entityActionOperationSupportsDomain,
  classifyDemonstrativeTarget,
  demonstrativeActionTargetDescriptor,
  isGenericActionTargetDescriptor,
  type DemonstrativeTargetReference,
  type EntityActionOperation,
} from "./entity-action-intent.js";
import {
  cleanTargetText,
  canonicalNumericStatusUnit,
  canonicalStatusRequestedState,
  canonicalStatusRequestedStateForEntityIds,
  parseNumericStatusComparison,
  parseStandaloneEntityStatusIntent,
  requestedStateFromStatusText,
  statusQuantifierFromText,
} from "./entity-status-intent.js";
import { resolveStandaloneEntityStatusTarget } from "./entity-status-resolution.js";
import { weatherFastPathAnswer } from "./basic-brain-weather.js";
import {
  deepFreeze,
  domainFromEntityId,
  friendlyName,
  isGarageDoorLock,
  isUnavailableState,
  shortFriendlyName,
  type HaEntityState,
  type HaStateCache,
} from "./ha-state-cache.js";
import type { HaRegistryIndex } from "./ha-registry-index.js";
import { isReportableHouseLightEntityId } from "./house-light-policy.js";
import { buildEntityLocationPrivacyContext, isSensitiveLocationEntity } from "./entity-status-privacy.js";
import {
  looksLikeGlobalLightsStatus,
  looksLikeWholeHouseLightScopeQuestion,
  parseHouseLightsStatusIntent,
  type HouseLightsStatusOperation,
} from "./house-lights-status-intent.js";
import { isGuestSpeakerRequest, trustedSpeakerLabel } from "./speaker-principal.js";
import type { VoiceBrainRequest } from "./voice-brain.js";
import { normalizeSpeechForRouting } from "./speech-normalizer.js";
import {
  labelsEquivalent,
  resolverNameKey,
  singularKey,
  targetIndexFor,
  type TargetIndex,
} from "./target-index.js";
import {
  exactTargetDisplayLabel,
  targetResolverFor,
  type TargetResolver,
  type TargetResolverMatch,
  type TargetResolverResult,
} from "./target-resolver.js";
import {
  canonicalizeLeadingQuestionContractions,
  normalizeMeasuredRoutingText as normalize,
  parseRoutingUtterance,
  targetTextKey,
  type RoutingSpeechAct,
} from "./routing-text.js";
import {
  COMPARATOR_WORD,
  DEVICE_DESCRIPTORS,
  DEVICE_PLURAL_WORD,
  DEVICE_STATUS_PATTERN,
  INDOOR_SCOPE_WORD,
  READING_PATTERN,
  STATUS_STATE_PATTERN,
  stripStatusFiller,
} from "./lexicon.js";
import { capitalize, escapeRegExp, joinAlternatives, joinNatural, lowerCommonWords, spokenDuration } from "./text-format.js";
import { householdRegex } from "./household.js";
import { houseConfig } from "./house-config.js";

/**
 * Entity status: the one owner of "is the X on?", "what's the Y reading?"
 * and "where's Z?". The status question is parsed once (the
 * shared plan in entity-status-intent.ts), its target resolved once per HA
 * revision against the target index, and the answer rendered here. The
 * brain keeps only the call lines and the follow-up switchyard.
 */

export interface CurrentStatusResolution {
  readonly target: ResolvedTarget | null;
  readonly clarifier: PendingClarifierFrame | null;
}

interface FollowUpStatusResolution extends CurrentStatusResolution {
  readonly acquisition: EntityStatusTargetAcquisition;
}

const STATUS_ACTION_PROVENANCE = Symbol("status-action-provenance");

interface VerifiedStatusActionProvenance {
  readonly [STATUS_ACTION_PROVENANCE]: true;
  readonly targetKey: string;
  readonly sourceQuery: string;
}

type EntityStatusAcquisitionEvidence =
  | {
    readonly acquisition: "explicit";
    readonly proof: VerifiedStatusActionProvenance;
  }
  | {
    readonly acquisition: Exclude<EntityStatusTargetAcquisition, "explicit">;
  };

interface DirectEntityIdentityResolution {
  readonly target: ResolvedTarget | null;
  readonly clarifier: PendingClarifierFrame | null;
}

export function resolveDirectEntityIdentity(
  targetText: string,
  routes: BasicBrainRouteServices,
): DirectEntityIdentityResolution {
  const normalizedTarget = targetTextKey(targetText);
  const aliasTargets = dedupeResolvedTargets(exactAliasMatches(
    normalizedTarget,
    routes.aliases ?? [],
    normalizedTarget,
  ));
  if (aliasTargets.length === 1) {
    return { target: aliasTargets[0] as ResolvedTarget, clarifier: null };
  }
  if (aliasTargets.length > 1) {
    return entityIdentityAmbiguity(aliasTargets, targetText, routes);
  }

  const states = routes.stateCache?.entries() ?? [];
  const stateById = new Map(states.map((state) => [state.entityId, state]));
  const registryById = new Map((routes.registry?.allEntities() ?? []).map((entry) => [entry.entityId, entry]));
  const entityIds = [...new Set([...stateById.keys(), ...registryById.keys()])];
  const matches = entityIds.flatMap((entityId): ResolvedTarget[] => {
    const state = stateById.get(entityId) ?? null;
    const registry = registryById.get(entityId) ?? null;
    const aliasNames = (routes.aliases ?? []).flatMap((entry) => (
      entry.target.kind === "entity" && entry.target.entityId === entityId ? [entry.alias] : []
    ));
    const keys = [
      entityId,
      entityId.replaceAll(/[._-]/g, " "),
      ...(state ? [friendlyName(state), shortFriendlyName(state)] : []),
      registry?.name ?? "",
      registry?.originalName ?? "",
      ...aliasNames,
    ].map(targetTextKey).filter(Boolean);
    if (!keys.some((key) => labelsEquivalent(key, normalizedTarget))) return [];
    const label = state
      ? shortFriendlyName(state)
      : registry?.name
        ?? registry?.originalName
        ?? entityId.slice(entityId.indexOf(".") + 1).replaceAll("_", " ");
    return [{
      label,
      entityIds: [entityId],
      source: labelsEquivalent(targetTextKey(entityId), normalizedTarget)
        ? "entity_id"
        : aliasNames.some((alias) => labelsEquivalent(targetTextKey(alias), normalizedTarget))
          ? "alias"
          : "exact_name",
    }];
  });
  const targets = dedupeResolvedTargets(matches);
  if (targets.length === 1) {
    return { target: targets[0] as ResolvedTarget, clarifier: null };
  }
  if (targets.length > 1) {
    return entityIdentityAmbiguity(targets, targetText, routes);
  }
  return { target: null, clarifier: null };
}

function dedupeResolvedTargets(targets: readonly ResolvedTarget[]): readonly ResolvedTarget[] {
  return [...new Map(targets.map((target) => [
    [...target.entityIds].sort().join("\u0000"),
    target,
  ])).values()];
}

function entityIdentityAmbiguity(
  targets: readonly ResolvedTarget[],
  targetText: string,
  routes: BasicBrainRouteServices,
): DirectEntityIdentityResolution {
  if (targets.length > 4) {
    const entityIds = [...new Set(targets.flatMap((target) => target.entityIds))];
    return {
      target: null,
      clarifier: {
        kind: "clarifier",
        route: "entity_status",
        prompt: `I found ${targets.length} Home Assistant entities called ${targetText}. Use the exact entity ID.`,
        choices: [],
        freeform: {
          kind: "entity_identity_exact_id",
          targetHint: targetText,
          entityIds,
        },
      },
    };
  }
  const choices: PendingClarifierChoice[] = targets.map((target, index) => {
    const label = entityIdentityChoiceLabel(target, routes);
    return {
      id: `entity-identity-${index + 1}`,
      label,
      synonyms: [label, target.label, ...target.entityIds],
      action: {
        kind: "entity_status",
        targetLabel: target.label,
        entityIds: [...target.entityIds],
        source: target.source === "inferred" || target.source === "state_hint" ? "exact_name" : target.source,
        requestedState: null,
        questionType: "state_value",
        responseKind: "entity_identity",
      },
    };
  });
  return {
    target: null,
    clarifier: {
      kind: "clarifier",
      route: "entity_status",
      prompt: `Do you mean ${joinAlternatives(choices.map((choice) => choice.label))}?`,
      choices,
    },
  };
}

function entityIdentityChoiceLabel(target: ResolvedTarget, routes: BasicBrainRouteServices): string {
  if (target.entityIds.length !== 1) {
    return `${target.label}, the ${target.entityIds.length}-entity group`;
  }
  const entityId = target.entityIds[0] as string;
  const state = routes.stateCache?.get(entityId) ?? null;
  if (state) return disambiguatedStateLabel(state, routes);
  const registry = routes.registry?.entity(entityId) ?? null;
  const base = registry?.name ?? registry?.originalName ?? target.label;
  return registry?.effectiveAreaName
    ? `${base} in ${registry.effectiveAreaName}`
    : `${base} as ${entityId}`;
}

export function houseLightFocusSupportsStatusPlan(plan: CurrentStatusPlan): boolean {
  return houseLightFocusSupportsRequestedState(plan.requestedState);
}

export function houseLightFocusSupportsRequestedState(requestedState: string | null): boolean {
  return requestedState === "on" || requestedState === "off";
}

export function looksLikePronounStatusFollowUp(normalized: string): boolean {
  const plan = parseCurrentStatusPlan(normalized);
  if (!plan?.targetText || plan.requestedState === null) {
    return false;
  }
  return classifyDemonstrativeTarget(plan.targetText).kind !== "none";
}

export function classifiedStatusFollowUpReference(normalized: string): DemonstrativeTargetReference | null {
  const targetText = parseCurrentStatusPlan(normalized)?.targetText ?? null;
  if (!targetText) {
    return null;
  }
  const reference = classifyDemonstrativeTarget(targetText);
  return reference.kind === "none" ? null : reference;
}

export function looksLikeStatusChangeFollowUp(normalized: string): boolean {
  return statusChangeFollowUpTarget(normalized) !== null
    || /^(?:check|show|tell me|give me)\s+(?:it|that|this|them|those|these)(?:\s+once more|\s+again)?$/.test(normalized);
}

export function parseContextualStatusRestatement(
  surface: string,
): {
  readonly targetText: string;
  readonly requestedState: string;
} | null {
  const delimited = /^(.+?)\s*(?:—|–|;|:|,\s+)\s*(.+?)[?.!]*$/u.exec(surface.trim());
  const normalized = normalize(surface);
  const implicitBoundary = new RegExp(
    `^((?:which|what)(?: one| ones)? (?:is|are|was|were) (?:still )?${STATUS_STATE_PATTERN} (?:again|previously|earlier|before)) (?:the )?(.+)$`,
  ).exec(normalized);
  const predicate = normalize(delimited?.[1] ?? implicitBoundary?.[1] ?? "");
  const targetText = cleanTargetText(delimited?.[2] ?? implicitBoundary?.[2] ?? "", "status");
  if (!predicate || !targetText) {
    return null;
  }
  const requestedState = new RegExp(
    `^(?:which|what)(?: one| ones)? (?:is|are|was|were) (?:still )?(${STATUS_STATE_PATTERN})(?: (?:again|previously|earlier|before))?$`,
  ).exec(predicate)?.[1] ?? "";
  return requestedState
    ? { targetText, requestedState }
    : null;
}

export function statusChangeFollowUpTarget(normalized: string): string | null {
  const stripped = stripStatusFiller(normalized);
  const target = cleanTargetText(
    new RegExp(`^(?:did|has|have) (?:the )?(.+?) (?:state )?(?:stay|stayed|remain|remained)(?: (?:showing|set|as))? ${STATUS_STATE_PATTERN}$`).exec(stripped)?.[1]
      ?? /^(?:did|has|have) (?:the )?(.+?) (?:state )?(?:change|changed)$/.exec(stripped)?.[1]
      ?? /^(?:check|show|tell me|give me)(?: whether| if)? (?:the )?(.+?) state changed$/.exec(stripped)?.[1]
      ?? "",
    "status",
  );
  return target;
}

export function matchingStatusChangeFrame(
  targetText: string,
  frames: readonly Extract<BasicContextFrame, { kind: "entity_status" }>[],
  genericReference = false,
): Extract<BasicContextFrame, { kind: "entity_status" }> | null {
  if (genericReference) {
    return frames[0] ?? null;
  }
  const targetTokens = normalizedStatusReferenceTokens(targetText, new Set(["state", "status"]));
  return uniqueStatusTargetEntry(frames.filter((frame) => {
    const evidenceTokens = new Set(normalizedStatusReferenceTokens(`${frame.target.label} ${frame.target.entityIds.join(" ")}`));
    return targetTokens.length > 0 && targetTokens.every((token) => evidenceTokens.has(token));
  }), (frame) => frame.target);
}

export function resolveFreshStatusChangeTarget(
  targetText: string,
  routes: BasicBrainRouteServices,
  requestedState: string | null,
  questionType: ClarifierQuestionType,
): CurrentStatusResolution {
  const resolution = resolveStatusTargetWithClarifier(targetText, routes, requestedState, questionType);
  if (resolution.target) {
    const exactSource = !["inferred", "state_hint"].includes(resolution.target.source);
    return exactSource || statusReferenceMatchesTarget(targetText, resolution.target, routes)
      ? resolution
      : { target: null, clarifier: null };
  }
  if (resolution.clarifier) {
    const targetTokens = normalizedStatusReferenceTokens(targetText, new Set(["state", "status"]));
    const hasMatchingChoice = resolution.clarifier.choices.some((choice) => {
      const choiceTokens = new Set(normalizedStatusReferenceTokens(choice.label));
      return targetTokens.length > 0 && targetTokens.every((token) => choiceTokens.has(token));
    });
    return hasMatchingChoice ? resolution : { target: null, clarifier: null };
  }
  return resolution;
}

function statusReferenceMatchesTarget(
  targetText: string,
  target: ResolvedTarget,
  routes: BasicBrainRouteServices,
): boolean {
  const targetTokens = normalizedStatusReferenceTokens(targetText, new Set(["state", "status"]));
  const stateEvidence = target.entityIds.map((entityId) => {
    const state = routes.stateCache?.get(entityId) ?? null;
    return `${entityId} ${state ? friendlyName(state) : ""}`;
  }).join(" ");
  const evidenceTokens = new Set(normalizedStatusReferenceTokens(stateEvidence));
  return targetTokens.length > 0 && targetTokens.every((token) => evidenceTokens.has(token));
}

export function normalizedStatusReferenceTokens(value: string, ignored: ReadonlySet<string> = new Set()): readonly string[] {
  const ignoredKeys = new Set([...ignored].map((token) => singularKey(token)));
  return [...new Set(targetTextKey(value.replace(/[._:-]+/g, " "))
    .split(/\s+/)
    .map((token) => singularKey(token))
    .filter((token) => token.length > 1 && !ignoredKeys.has(token)))];
}

export function uniqueStatusTargetEntry<T>(
  entries: readonly T[],
  targetFor: (entry: T) => ResolvedTarget,
): T | null {
  const targetKeys = new Set(entries.map((entry) => {
    const target = targetFor(entry);
    return [...target.entityIds].sort().join("|") || targetTextKey(target.label);
  }));
  return targetKeys.size === 1 ? entries[0] ?? null : null;
}

export function looksLikeCompactStateOnlyFollowUp(normalized: string): boolean {
  return new RegExp(`^(?:${STATUS_STATE_PATTERN})(?: now)?\\??$`).test(normalized);
}

export function outsideTemperatureStatusTarget(normalized: string, routes: BasicBrainRouteServices): ResolvedTarget | null {
  if (COMPARATOR_WORD.test(normalized)) {
    return null;
  }
  if (!/\boutside temp(?:erature)?\b/.test(normalized)) {
    return null;
  }
  const stripped = canonicalizeLeadingQuestionContractions(stripStatusFiller(normalized)
    .replace(/^[^a-z0-9]+/g, " ")
    .replace(/^(?:can you|could you|would you)\s+/g, "")
    .replace(/^(?:check|tell me|show me|give me)\s+what\s+(.+)\s+is$/g, "what is $1")
    .replace(/\s+/g, " ")
    .trim());
  const directOutsideTemperatureQuestion = /^outside temperature$/.test(stripped)
    || /^(?:tell me|give me|check|show(?: me)?)(?: the)? outside temperature$/.test(stripped)
    || /^(?:tell me|give me|check|show(?: me)?)(?: the)? outside temperature(?: sensor)?(?: status| state| reading)?$/.test(stripped)
    || /^(?:what(?:s| is))(?: the)? outside temperature(?: sensor)?(?: status| state| reading)$/.test(stripped)
    || (/^(?:what(?:s| is))(?: the)? outside temperature$/.test(stripped)
      && /\b(right now|now|at the moment|currently)\b/.test(normalized));
  if (!directOutsideTemperatureQuestion && !/\b(status|state|reading|sensor|working|work|show)\b/.test(normalized)) {
    return null;
  }
  return resolveStatusTarget("outside temperature", routes)
    ?? resolveStatusTarget("outside temp", routes)
    ?? inferOutsideTemperatureStatusTarget(routes);
}

export function inferOutsideTemperatureStatusTarget(routes: BasicBrainRouteServices): ResolvedTarget | null {
  const sensors = statusTargetIndex(routes).entityIdsInDomain("sensor")
    .flatMap((entityId) => routes.stateCache?.get(entityId) ?? []);
  const exact = sensors.find((state) => ["outside temperature", "outside temp"].includes(targetTextKey(friendlyName(state))));
  const outside = exact ?? sensors.find((state) => String(state.attributes?.device_class ?? "").toLowerCase() === "temperature"
    && /\boutside\b/.test(targetTextKey(friendlyName(state))));
  return outside
    ? { label: friendlyName(outside), entityIds: [outside.entityId], source: exact ? "exact_name" : "inferred" }
    : null;
}

export function isDefiniteReferentialStatusQuestion(normalized: string): boolean {
  const targetText = /^what (?:is|are) (?:the|my|our|your) (.+)$/.exec(normalized)?.[1] ?? "";
  if (!targetText || /\b(?:about|for|of)\b/.test(targetText)) {
    return false;
  }
  return looksLikeExplicitStatusTargetObject(targetTextKey(targetText));
}

export function isBareNominalStatusRequest(
  normalized: string,
  targetText: string,
): boolean {
  const nominalTarget = /^(?:the |my |our )?(.+?) (?:status|state|reading|value)$/.exec(normalized)?.[1] ?? "";
  return nominalTarget.length > 0
    && targetTextKey(nominalTarget) === targetTextKey(targetText);
}

export function explicitFocusShiftTargetText(normalized: string): string | null {
  const match = /^(?:back to|go back to|return to) (?:the )?(.+?) (?:(?:is|are|was|were|do|does|did|has|have) (?:it|they|that|those|these)\b|what (?:is|are)\b)/.exec(normalized);
  return cleanTargetText(match?.[1] ?? "", "status");
}

export const PLACE_READING_TAIL = new RegExp(String.raw`\b${READING_PATTERN}$`);

export function resolveFollowUpStatusTarget(
  targetText: string,
  frame: Extract<BasicContextFrame, { kind: "entity_status" }>,
  routes: BasicBrainRouteServices,
  requestedState: string | null,
): FollowUpStatusResolution {
  const resolution = resolveStatusTargetWithClarifier(targetText, routes, requestedState, requestedState ? "yes_no" : "state_value");
  if (resolution.target || resolution.clarifier) {
    return { ...resolution, acquisition: "explicit" };
  }
  if (/\blights?\b/.test(targetTextKey(frame.target.label))) {
    return {
      ...resolveStatusTargetWithClarifier(`${targetText} lights`, routes, requestedState, requestedState ? "yes_no" : "state_value"),
      acquisition: "contextual",
    };
  }
  return { target: null, clarifier: null, acquisition: "explicit" };
}

export function entityStatus(
  target: ResolvedTarget,
  routes: BasicBrainRouteServices,
  plan: CurrentStatusPlan,
  request: VoiceBrainRequest,
  acquisitionEvidence: EntityStatusAcquisitionEvidence,
): BasicResult {
  const resolvedPlan: CurrentStatusPlan = {
    ...plan,
    requestedState: canonicalStatusRequestedStateForEntityIds(plan.requestedState, target.entityIds),
  };
  const targetAcquisition = acquisitionEvidence.acquisition;
  const explicitTargetCannotAuthorizeAction = targetAcquisition === "explicit"
    && (plan.targetText === null
      || classifyDemonstrativeTarget(plan.targetText).kind === "contextual"
      || (plan.quantifier == null && isGenericActionTargetDescriptor(plan.targetText))
      || acquisitionEvidence.proof.targetKey !== statusActionTargetKey(target));
  const effectiveTargetAcquisition = explicitTargetCannotAuthorizeAction
    ? "inferred"
    : targetAcquisition;
  const actionSourceQuery = effectiveTargetAcquisition === "explicit"
    && acquisitionEvidence.acquisition === "explicit"
    ? acquisitionEvidence.proof.sourceQuery
    : null;
  const guestRequest = isGuestSpeakerRequest(request);
  const privacy = guestRequest
    ? buildEntityLocationPrivacyContext({
        registry: routes.registry,
        states: routes.stateCache?.entries() ?? [],
        aliases: routes.aliases ?? [],
      })
    : null;
  if (privacy && target.entityIds.some((entityId) =>
    isSensitiveLocationEntity(
      entityId,
      null,
      privacy.labelsForEntity(entityId),
      privacy.knownPersonLabels,
    ))) {
    return guestPersonalStatusDecline(`guest mode blocked personal entity status for ${target.label}`);
  }
  const cache = liveStateCache(routes);
  if (!cache || cache.size() === 0) {
    return declinedReadFallback(
      "entity_status",
      "I can't see Home Assistant state yet.",
      `exact ${target.source} target matched; no state cache`,
      "current_source_unresolved",
    );
  }
  const states = target.entityIds.map((entityId) => cache.get(entityId)).filter((state): state is HaEntityState => state !== null);
  if (states.length === 0) {
    return declinedReadFallback(
      "entity_status",
      target.entityIds.length === 1
        ? `I've got ${target.label}, but I don't have live state for it.`
        : `I've got ${target.label}, but I don't have live state for any of its members.`,
      `exact ${target.source} target matched; state missing`,
      "current_source_unresolved",
    );
  }
  const uniqueEntityIds = new Set(target.entityIds);
  if (uniqueEntityIds.size !== target.entityIds.length || states.length !== target.entityIds.length) {
    return declinedReadFallback(
      "entity_status",
      `I've got ${target.label}, but I don't have live state for every member.`,
      `exact ${target.source} target matched; group membership incomplete`,
      "current_source_unresolved",
    );
  }
  if (privacy && states.some((state) =>
    isSensitiveLocationEntity(
      state.entityId,
      state,
      privacy.labelsForEntity(state.entityId),
      privacy.knownPersonLabels,
    ))) {
    return guestPersonalStatusDecline(`guest mode blocked personal entity status for ${target.label}`);
  }
  if (resolvedPlan.requestedState
    && states.some((state) => !stateSupportsStatusPredicate(state, resolvedPlan.requestedState as string, target.label))) {
    // One device that can't answer the question asked ("is the front door open?" of a lock):
    // say what it does report, never stretch it into the answer.
    const only = states.length === 1 ? states[0] : null;
    return declined(
      "entity_status",
      only
        ? `${capitalize(subjectForStatus(canonicalEntityStatusLabel(only, target.label)))} is ${renderedState(only).text}, and that's all it can tell me.`
        : `I've got ${target.label}, but that state doesn't apply to every member.`,
      `exact ${target.source} target matched; requested predicate incompatible`,
    );
  }
  const numericAssessment = assessNumericStatus(states, resolvedPlan);
  if (numericAssessment?.outcome === "unavailable") {
    return declinedReadFallback(
      "entity_status",
      `I've got ${target.label}, but its numeric reading is unavailable.`,
      `exact ${target.source} target matched; numeric source unavailable`,
      "current_source_unresolved",
    );
  }
  if (numericAssessment?.outcome === "unsupported") {
    return declined(
      "entity_status",
      `I've got ${target.label}, but that numeric comparison doesn't apply to it.`,
      `exact ${target.source} target matched; numeric predicate incompatible`,
    );
  }
  if (states.length === 1) {
    const state = states[0] as HaEntityState;
    const personTarget = domainFromEntityId(state.entityId) === "person";
    const displayLabel = canonicalEntityStatusLabel(state, target.label);
    const contextTarget = displayLabel === target.label
      ? target
      : { ...target, label: displayLabel };
    return {
      ...ok(
        "entity_status",
        singleStatusSentence(displayLabel, state, resolvedPlan),
        `exact ${target.source} target matched`,
        { kind: "entity_status", target: contextTarget },
        personTarget ? null : singleStatusSpeechPlan(displayLabel, state, resolvedPlan),
      ),
      entityStatusTargetAcquisition: effectiveTargetAcquisition,
      ...(actionSourceQuery ? { entityStatusActionSourceQuery: actionSourceQuery } : {}),
    };
  }
  const groupSentence = groupStatusSentence(target.label, states, resolvedPlan, routes);
  const selectionAnswer = resolvedPlan.quantifier === "which" && resolvedPlan.requestedState !== null;
  return {
    ...ok(
      "entity_status",
      groupSentence,
      `exact ${target.source} group target matched`,
      { kind: "entity_status", target },
      selectionAnswer ? null : groupStatusSpeechPlan(target.label, states, resolvedPlan, routes),
    ),
    entityStatusTargetAcquisition: effectiveTargetAcquisition,
    ...(actionSourceQuery ? { entityStatusActionSourceQuery: actionSourceQuery } : {}),
  };
}

export function statusTargetHasUniqueActionProvenance(
  target: ResolvedTarget,
  sourceQuery: string,
  analysis: BasicTurnAnalysis,
): boolean {
  const queryAliasKey = provenanceAliasKey(sourceQuery);
  const exactAliases = analysis.sources.aliases().filter((entry) => (
    provenanceAliasKey(entry.normalizedAlias || entry.alias) === queryAliasKey
  ));
  if (exactAliases.length > 0) {
    if (exactAliases.length !== 1) return false;
    const aliasTarget = exactAliases[0]?.target;
    return aliasTarget?.kind === "entity"
      && target.entityIds.length === 1
      && aliasTarget.entityId === target.entityIds[0];
  }
  const exactStateIds = analysis.sources.targetIndex()?.entityIdsWithNameKey(queryAliasKey) ?? [];
  const exactRegistryIds = analysis.sources.registryTargets()
    ?.exactNameMatches(sourceQuery)
    .map((entry) => entry.entityId) ?? [];
  const exactSourceIds = [...new Set([...exactStateIds, ...exactRegistryIds])].sort();
  if (exactSourceIds.length > 0) {
    return sameEntityIds(exactSourceIds, target.entityIds);
  }
  if (target.source === "area_domain") {
    const current = resolveStandaloneEntityStatusTarget({
      targetText: sourceQuery,
      requestedState: null,
      analysis,
    });
    if (current.outcome !== "resolved") return false;
    const currentIds = [...new Set(current.target.entityIds)].sort();
    const targetIds = [...new Set(target.entityIds)].sort();
    return sameEntityIds(currentIds, targetIds);
  }
  if (!["alias", "entity_id", "exact_name"].includes(target.source)) return false;
  const exactMatches = analysis.sources.targets()?.resolve({
    text: sourceQuery,
    includeUnavailable: true,
  }).matches.filter((match) => match.reasons.some((reason) => (
    reason.startsWith("exact:")
    || reason.startsWith("alias_exact:entity:")
    || reason.startsWith("alias_exact:group:")
  ))) ?? [];
  if (exactMatches.some((match) => match.reasons.some((reason) => reason.startsWith("alias_exact:group:")))) {
    return false;
  }
  const sharedGroupBinding = exactGroupBinding(exactMatches);
  if (exactMatches.length !== 1 && !sharedGroupBinding) return false;
  const resolvedIds = [...new Set(exactMatches.map((match) => match.entityId))].sort();
  const targetIds = [...new Set(target.entityIds)].sort();
  return sameEntityIds(resolvedIds, targetIds);
}

function sameEntityIds(left: readonly string[], right: readonly string[]): boolean {
  const leftIds = [...new Set(left)].sort();
  const rightIds = [...new Set(right)].sort();
  return leftIds.length === rightIds.length
    && leftIds.every((entityId, index) => entityId === rightIds[index]);
}

function provenanceAliasKey(value: string): string {
  return resolverNameKey(value) ?? "";
}

export function statusAcquisitionEvidence(
  target: ResolvedTarget,
  acquisition: EntityStatusTargetAcquisition,
  analysis: BasicTurnAnalysis | null,
  sourceQuery: string,
): EntityStatusAcquisitionEvidence {
  if (acquisition !== "explicit") return { acquisition };
  if (!analysis
    || !statusSourceQueryIsGroundedInTurn(sourceQuery, analysis)
    || !statusTargetHasUniqueActionProvenance(target, sourceQuery, analysis)) {
    return { acquisition: "inferred" };
  }
  return {
    acquisition: "explicit",
    proof: Object.freeze({
      [STATUS_ACTION_PROVENANCE]: true as const,
      targetKey: statusActionTargetKey(target),
      sourceQuery,
    }),
  };
}

function statusSourceQueryIsGroundedInTurn(
  sourceQuery: string,
  analysis: BasicTurnAnalysis,
): boolean {
  const query = provenanceSurfaceKey(sourceQuery);
  if (!query) return false;
  return [analysis.surface, analysis.taskCore, analysis.semantics.coreSurface]
    .map(provenanceSurfaceKey)
    .some((surface) => surface === query || ` ${surface} `.includes(` ${query} `));
}

function provenanceSurfaceKey(value: string): string {
  const normalized = normalizeSpeechForRouting(value, { preserveEntityChars: true })
    .replace(/[^a-z0-9._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized;
}

function statusActionTargetKey(target: ResolvedTarget): string {
  return [...new Set(target.entityIds)].sort().join("\u0000");
}

export function houseLightsStatus(routes: BasicBrainRouteServices, normalized = "", now = new Date()): BasicResult {
  const cache = liveStateCache(routes);
  if (!cache || cache.size() === 0) {
    return declined("house_status", "I can't see Home Assistant state yet.", "no state cache for house lights");
  }
  // A house without its own light list counts every real light: never a setting or diagnostic
  // entity (an ESPHome colour picker is a light in HA), nor a hidden or disabled one.
  const listed = houseConfig().lights.reportable !== null;
  const lights = cache.entries().filter((state) => {
    if (!isReportableHouseLight(state)) return false;
    if (listed) return true;
    const entry = routes.registry?.entity(state.entityId);
    return !entry || (!entry.entityCategory && !entry.disabledBy && !entry.hiddenBy);
  });
  if (lights.length === 0) {
    return declined("house_status", "I can't see any light states from Home Assistant yet.", "no light states");
  }
  const onLights = lights.filter((state) => state.state === "on");
  const offLights = lights.filter((state) => state.state === "off");
  const unknownLights = lights.filter((state) => state.state !== "on" && state.state !== "off");
  const contextFrame = (names: readonly string[]): Extract<BasicContextFrame, { kind: "house_lights" }> => ({
    kind: "house_lights",
    onLightNames: names,
  });
  const onNames = sortedHouseLightNames(onLights);
  const offNames = sortedHouseLightNames(offLights);
  const unknownNames = sortedHouseLightNames(unknownLights);
  const operation = parseHouseLightsStatusIntent(normalized)?.operation ?? "summary";
  const frame = contextFrame(onNames);

  switch (operation) {
    case "any_on":
      if (onNames.length > 0) return houseLightsKnownListResult(onNames, "on", frame);
      if (unknownNames.length > 0) return houseLightsUnknownResult(operation, unknownNames, frame);
      return ok(
        "house_status",
        "No. All house lights are off.",
        "live light states checked: no lights on",
        frame,
        { kind: "house_lights_none" },
      );
    case "all_on":
      if (offNames.length > 0) {
        return ok("house_status", `No. ${lightsStateEvidenceSentence(offNames, "off")}`, "live light states checked: not all lights on", frame);
      }
      if (unknownNames.length > 0) return houseLightsUnknownResult(operation, unknownNames, frame);
      return ok("house_status", "Yes. All house lights are on.", "live light states checked: all lights on", frame);
    case "any_off":
      if (offNames.length > 0) return houseLightsKnownListResult(offNames, "off", frame);
      if (unknownNames.length > 0) return houseLightsUnknownResult(operation, unknownNames, frame);
      return ok("house_status", "No. All house lights are on.", "live light states checked: no lights off", frame);
    case "all_off":
      if (onNames.length > 0) {
        return ok("house_status", `No. ${lightsStateEvidenceSentence(onNames, "on")}`, "live light states checked: not all lights off", frame);
      }
      if (unknownNames.length > 0) return houseLightsUnknownResult(operation, unknownNames, frame);
      return ok("house_status", "Yes. All house lights are off.", "live light states checked: all lights off", frame);
    case "list_on":
    case "summary":
      if (onNames.length > 0) return houseLightsKnownListResult(onNames, "on", frame, unknownNames);
      if (unknownNames.length > 0) return houseLightsUnknownResult(operation, unknownNames, frame);
      return ok(
        "house_status",
        "No, I can't see any lights on.",
        "live light states checked: on-light list empty",
        frame,
        { kind: "house_lights_none" },
      );
    case "list_off":
      if (offNames.length > 0) return houseLightsKnownListResult(offNames, "off", frame, unknownNames);
      if (unknownNames.length > 0) return houseLightsUnknownResult(operation, unknownNames, frame);
      return ok("house_status", "No house lights are off.", "live light states checked: off-light list empty", frame);
    case "longest_on":
      if (onLights.length === 0) {
        return ok("house_status", "None, all the house lights are off.", "live light states checked: no lights on", frame, { kind: "house_lights_none" });
      }
      return ok("house_status", longestOnSentence(onLights, now), "live light states checked: on-lights ordered by last change", frame);
  }
}

/** The lights that are on, longest first, with how long since HA saw each change. */
function longestOnSentence(onLights: readonly HaEntityState[], now: Date): string {
  const [first, ...rest] = onLights
    .map((state) => ({ name: shortFriendlyName(state), onFor: now.getTime() - Date.parse(state.lastChanged) }))
    .sort((left, right) => right.onFor - left.onFor);
  if (!first) return "None, all the house lights are off.";
  const lead = `${capitalize(first.name)}, on for ${spokenDuration(first.onFor)}.`;
  if (rest.length === 0) return `${lead} It's the only one on.`;
  const shown = rest.slice(0, 2).map((light) => `${light.name} for ${spokenDuration(light.onFor)}`);
  const then = rest.length > 2 ? `${shown.join(", ")}, and ${rest.length - 2} more` : joinNatural(shown);
  return `${lead} Then ${then}.`;
}

function sortedHouseLightNames(states: readonly HaEntityState[]): readonly string[] {
  return states.map(shortFriendlyName).sort((left, right) => left.localeCompare(right));
}

function houseLightsKnownListResult(
  names: readonly string[],
  state: "on" | "off",
  frame: Extract<BasicContextFrame, { kind: "house_lights" }>,
  unknownNames: readonly string[] = [],
): BasicResult {
  const evidence = state === "on" ? lightsOnSentence(names) : lightsStateAffirmationSentence(names, state);
  const qualification = unknownNames.length > 0
    ? ` I can't verify ${joinNatural(unknownNames)} right now.`
    : "";
  return ok(
    "house_status",
    `${evidence}${qualification}`,
    `live light states checked: ${state}-light evidence`,
    frame,
    state === "on" && unknownNames.length === 0 ? { kind: "house_lights_some", names } : null,
  );
}

function houseLightsUnknownResult(
  operation: HouseLightsStatusOperation,
  names: readonly string[],
  frame: Extract<BasicContextFrame, { kind: "house_lights" }>,
): BasicResult {
  return declinedWithContext(
    "house_status",
    `I can't answer that reliably because ${joinNatural(names)} ${names.length === 1 ? "is" : "are"} unavailable.`,
    `live light states incomplete for ${operation}`,
    frame,
  );
}

export function houseEntityInventoryDomain(normalized: string): "light" | null {
  if (!/\b(entities?|entity ids?)\b/.test(normalized)) {
    return null;
  }
  if (/\b(light|lights)\b/.test(normalized)) {
    return "light";
  }
  return null;
}

export function houseEntityInventoryAnswer(domain: "light", routes: BasicBrainRouteServices): BasicResult {
  const cache = routes.stateCache;
  if (!cache || cache.size() === 0) {
    return declined("house_status", "I can't see Home Assistant state yet.", `no state cache for ${domain} entity inventory`);
  }
  const entityIds = cache.entries()
    .map((state) => state.entityId)
    .filter((entityId) => entityId.startsWith(`${domain}.`))
    .sort((left, right) => left.localeCompare(right));
  if (entityIds.length === 0) {
    return declined("house_status", `I can't see any ${domain} entities from Home Assistant yet.`, `no ${domain} entities in live cache`);
  }
  const label = entityIds.length === 1 ? `${domain} entity` : `${domain} entities`;
  return ok(
    "house_status",
    `I can see ${entityIds.length} ${label}: ${entityIds.join(", ")}.`,
    `live ${domain} entity inventory checked`,
  );
}

export function isReportableHouseLight(state: HaEntityState): boolean {
  return isReportableHouseLightEntityId(state.entityId);
}

export function houseLightsListFollowUpAnswer(frame: Extract<BasicContextFrame, { kind: "house_lights" }>, normalized: string): BasicResult {
  const names = frame.onLightNames;
  if (names.length === 0) {
    return ok("house_status", "No, I can't see any lights on.", "previous house light list reused", frame, { kind: "house_lights_none" });
  }
  if (/\b(?:more|rest|remaining|others?)\b/.test(normalized) || /\b(?:one|1|two|2|three|3|four|4|five|5|six|6|seven|7|eight|8|nine|9|ten|10)\s+more\b/.test(normalized)) {
    const hidden = names.slice(3);
    if (hidden.length > 0) {
      return ok("house_status", lightsRemainderSentence(hidden), "previous house light remainder reused", frame, { kind: "house_lights_some", names: hidden, remainder: true });
    }
  }
  return ok("house_status", lightsFullListSentence(names), "previous house light list reused", frame, { kind: "house_lights_some", names });
}

export function resolveStatusTarget(targetText: string, routes: BasicBrainRouteServices): ResolvedTarget | null {
  return resolveStatusTargetWithClarifier(targetText, routes).target;
}

export function resolveExplicitDemonstrativeTarget(
  targetText: string,
  routes: BasicBrainRouteServices,
  options: {
    readonly requestedState?: string | null;
    readonly operation?: EntityActionOperation | null;
  } = {},
  sourceView?: BasicTurnTargetView | null,
  sourceAliases?: readonly AliasEntry[],
): ResolvedTarget | null {
  const reference = classifyDemonstrativeTarget(targetText);
  if (reference.kind !== "descriptive") {
    return null;
  }
  return resolveExactSourcedTarget(
    reference.descriptor,
    routes,
    options,
    reference.expectedCardinality,
    sourceView,
    sourceAliases,
  );
}

/** Read-only exact-name escape hatch for lexical words that also look like set exclusions. */
export function resolveExactExclusionStatusTarget(
  targetText: string,
  reference: DemonstrativeTargetReference,
  routes: BasicBrainRouteServices,
  requestedState: string | null,
): ResolvedTarget | null {
  return reference.kind === "underspecified" && reference.reason === "exclusion"
    ? resolveExactSourcedTarget(targetText, routes, { requestedState })
    : null;
}

export function resolveExactSourcedTarget(
  descriptor: string,
  routes: BasicBrainRouteServices,
  options: {
    readonly requestedState?: string | null;
    readonly operation?: EntityActionOperation | null;
  } = {},
  expectedCardinality: number | null = null,
  sourceView?: BasicTurnTargetView | null,
  sourceAliases?: readonly AliasEntry[],
): ResolvedTarget | null {
  if (!liveStateCache(routes)) {
    return null;
  }
  const operation = options.operation ?? null;
  const requestedState = options.requestedState ?? null;
  if (sourceView === undefined) {
    const exactGroup = resolveExactGroupTarget(descriptor, routes, operation, expectedCardinality);
    if (exactGroup.kind === "resolved") {
      return exactGroup.target;
    }
    if (exactGroup.kind === "invalid") {
      return null;
    }
    const exactEntityAlias = resolveExactEntityAliasTarget(
      descriptor,
      routes,
      operation,
      expectedCardinality,
    );
    if (exactEntityAlias.kind === "resolved") {
      return exactEntityAlias.target;
    }
    if (exactEntityAlias.kind === "invalid") {
      return null;
    }
  }

  const resolver = sourceView === undefined ? targetResolverForRoutes(routes) : sourceView;
  if (!resolver) {
    if (sourceView !== undefined) {
      return null;
    }
    const target = operation === null
      ? resolveExactDescriptiveStateTarget(descriptor, routes, requestedState)
      : null;
    return target && cardinalityMatches(target, expectedCardinality) ? target : null;
  }
  const rawExactMatches = resolver.resolve({ text: descriptor, includeUnavailable: true }).matches
    .filter((match) => match.reasons.some((reason) => (
      reason.startsWith("exact:")
      || reason.startsWith("alias_exact:entity:")
      || reason.startsWith("alias_exact:group:")
    )));
  if (sourceView !== undefined
    && !exactDeclaredGroupBindingIsComplete(descriptor, sourceAliases ?? [], rawExactMatches)) {
    return null;
  }
  const rawSharedGroupBinding = exactGroupBinding(rawExactMatches);
  // A requested operation validates an already unique source binding. It must
  // not make an ambiguous binding unique by deleting unsupported contenders.
  if (operation !== null && rawExactMatches.length !== 1 && !rawSharedGroupBinding) {
    return null;
  }
  let exactMatches = rawExactMatches.filter((match) => operation === null
    || entityActionOperationSupportsDomain(operation, match.domain));
  if (operation !== null
    && rawSharedGroupBinding
    && exactMatches.length !== rawExactMatches.length) {
    return null;
  }
  if (operation === null && exactMatches.length > 1 && requestedState !== null) {
    const capabilityMatches = exactMatches.filter((match) => {
      const state = routes.stateCache?.get(match.entityId) ?? null;
      return state ? exactStateCapabilitySupportsRequestedState(state, requestedState) : false;
    });
    if (capabilityMatches.length > 0) {
      exactMatches = capabilityMatches;
    }
  }
  const sharedGroupBinding = exactGroupBinding(exactMatches);
  if (exactMatches.length !== 1 && !sharedGroupBinding) {
    return null;
  }
  if (expectedCardinality !== null && exactMatches.length !== expectedCardinality) {
    return null;
  }
  const states = exactMatches
    .map((match) => routes.stateCache?.get(match.entityId) ?? null)
    .filter((state): state is HaEntityState => state !== null);
  if (states.length !== exactMatches.length) {
    return null;
  }
  const firstMatch = exactMatches[0];
  const firstState = states[0];
  if (!firstMatch || !firstState) {
    return null;
  }
  const aliasExact = exactMatches.every((match) => match.reasons.some((reason) => reason.startsWith("alias_exact:")));
  return {
    label: sharedGroupBinding
      ? descriptor
      : exactTargetDisplayLabel(descriptor, friendlyName(firstState), firstMatch),
    entityIds: states.map((state) => state.entityId),
    source: aliasExact
      ? "alias"
      : normalize(descriptor) === normalize(firstState.entityId)
        ? "entity_id"
        : "exact_name",
  };
}

function exactDeclaredGroupBindingIsComplete(
  descriptor: string,
  aliases: readonly AliasEntry[],
  matches: readonly TargetResolverMatch[],
): boolean {
  const exactGroups = aliases.filter((alias) => (
    alias.target.kind === "group"
    && exactAliasTargetKey(alias.normalizedAlias) === exactAliasTargetKey(descriptor)
  ));
  if (exactGroups.length === 0) return true;
  const group = exactGroups.length === 1 ? exactGroups[0] : null;
  if (!group || group.target.kind !== "group" || group.target.entityIds.length === 0) return false;
  const declaredIds = [...new Set(group.target.entityIds)];
  const matchedIds = [...new Set(matches.map((match) => match.entityId))];
  return declaredIds.length === group.target.entityIds.length
    && declaredIds.length === matchedIds.length
    && declaredIds.every((entityId) => matchedIds.includes(entityId));
}

function exactGroupBinding(matches: readonly TargetResolverMatch[]): string | null {
  return matches[0]?.reasons.find((reason) => (
    reason.startsWith("alias_exact:group:")
    && matches.every((match) => match.reasons.includes(reason))
  )) ?? null;
}

type ExactGroupTargetResolution =
  | { readonly kind: "none" }
  | { readonly kind: "invalid" }
  | { readonly kind: "resolved"; readonly target: ResolvedTarget };

function resolveExactEntityAliasTarget(
  targetText: string,
  routes: BasicBrainRouteServices,
  operation: EntityActionOperation | null,
  expectedCardinality: number | null,
): ExactGroupTargetResolution {
  const cache = liveStateCache(routes);
  const aliases = (routes.aliases ?? []).filter((alias) => (
    alias.target.kind === "entity"
    && exactAliasTargetKey(alias.normalizedAlias) === exactAliasTargetKey(targetText)
  ));
  if (aliases.length === 0) {
    return { kind: "none" };
  }
  const alias = aliases.length === 1 ? aliases[0] : null;
  if (!alias || alias.target.kind !== "entity" || !cache || expectedCardinality === 0) {
    return { kind: "invalid" };
  }
  const state = cache.get(alias.target.entityId);
  if (!state
    || (expectedCardinality !== null && expectedCardinality !== 1)
    || (operation !== null && (isUnavailableState(state) || !actionStateSupportsOperation(operation, state)))) {
    return { kind: "invalid" };
  }
  return {
    kind: "resolved",
    target: { label: alias.alias, entityIds: [state.entityId], source: "alias" },
  };
}

function resolveExactGroupTarget(
  targetText: string,
  routes: BasicBrainRouteServices,
  operation: EntityActionOperation | null,
  expectedCardinality: number | null = null,
): ExactGroupTargetResolution {
  const cache = liveStateCache(routes);
  const exactAliases = (routes.aliases ?? []).filter((alias) => (
    alias.target.kind === "group"
    && exactAliasTargetKey(alias.normalizedAlias) === exactAliasTargetKey(targetText)
  ));
  if (exactAliases.length === 0) {
    return { kind: "none" };
  }
  const alias = exactAliases.length === 1 ? exactAliases[0] : null;
  if (!alias || alias.target.kind !== "group" || !cache) {
    return { kind: "invalid" };
  }
  const entityIds = [...new Set(alias.target.entityIds)];
  const states = entityIds
    .map((entityId) => cache.get(entityId))
    .filter((state): state is HaEntityState => state !== null);
  const valid = entityIds.length === alias.target.entityIds.length
    && (expectedCardinality === null || entityIds.length === expectedCardinality)
    && states.length === entityIds.length
    && (operation === null || states.every((state) => (
      !isUnavailableState(state) && actionStateSupportsOperation(operation, state)
    )));
  return valid
    ? {
      kind: "resolved",
      target: { label: targetText, entityIds, source: "alias" },
    }
    : { kind: "invalid" };
}

function cardinalityMatches(target: ResolvedTarget, expectedCardinality: number | null): boolean {
  return expectedCardinality === null || target.entityIds.length === expectedCardinality;
}

export function contextualReferenceMatchesTarget(
  reference: Extract<DemonstrativeTargetReference, { readonly kind: "contextual" }>,
  target: ResolvedTarget,
  routes: BasicBrainRouteServices,
): boolean {
  if (!cardinalityMatches(target, reference.expectedCardinality)) {
    return false;
  }
  if (reference.minimumCardinality !== null
    && !(reference.singularPersonAllowed && targetIsSingularPersonReference(target))
    && !targetMatchesMinimumCardinality(target, reference.minimumCardinality, routes)) {
    return false;
  }
  if (!reference.descriptor) {
    return true;
  }
  const cache = liveStateCache(routes);
  if (!cache || target.entityIds.length === 0) {
    return false;
  }
  const states = target.entityIds
    .map((entityId) => cache.get(entityId))
    .filter((state): state is HaEntityState => state !== null);
  const descriptor = reference.descriptor;
  return states.length === target.entityIds.length
    && states.every((state) => stateMatchesContextualDescriptor(state, descriptor, routes));
}

function targetIsSingularPersonReference(target: ResolvedTarget): boolean {
  return target.entityIds.length === 1
    && ["person", "device_tracker"].includes(domainFromEntityId(target.entityIds[0] as string));
}

function targetMatchesMinimumCardinality(
  target: ResolvedTarget,
  minimumCardinality: number,
  routes: BasicBrainRouteServices,
): boolean {
  if (target.entityIds.length >= minimumCardinality) {
    return true;
  }
  if (minimumCardinality !== 2 || target.entityIds.length !== 1) {
    return false;
  }
  const state = liveStateCache(routes)?.get(target.entityIds[0] as string) ?? null;
  const evidence = targetTextKey([target.label, state ? friendlyName(state) : ""].join(" "));
  return DEVICE_PLURAL_WORD.test(evidence);
}

function stateMatchesContextualDescriptor(
  state: HaEntityState,
  descriptor: string,
  routes: BasicBrainRouteServices,
): boolean {
  const normalized = targetTextKey(descriptor);
  if (/\b(?:devices?|ones?|things?)\b/.test(normalized)) return true;
  const domain = domainFromEntityId(state.entityId);
  const noun = DEVICE_DESCRIPTORS.find((entry) => entry.pattern.test(normalized));
  return noun !== undefined
    && noun.domains.includes(domain)
    && (noun.evidence === null || hasContextualSubtypeEvidence(state, routes, noun.evidence));
}

function hasContextualSubtypeEvidence(
  state: HaEntityState,
  routes: BasicBrainRouteServices,
  subtype: RegExp,
): boolean {
  const registryEntity = routes.registry?.entity(state.entityId) ?? null;
  const deviceClass = typeof state.attributes.device_class === "string"
    ? state.attributes.device_class
    : "";
  const evidence = targetTextKey([
    state.entityId.replaceAll(/[._-]/g, " "),
    friendlyName(state),
    deviceClass.replaceAll(/[_-]/g, " "),
    registryEntity?.deviceName ?? "",
    registryEntity?.name ?? "",
    registryEntity?.originalName ?? "",
  ].join(" "));
  return subtype.test(evidence);
}

function resolveExactDescriptiveStateTarget(
  descriptor: string,
  routes: BasicBrainRouteServices,
  requestedState: string | null,
): ResolvedTarget | null {
  const normalizedDescriptor = targetTextKey(descriptor);
  let states = (routes.stateCache?.entries() ?? []).filter((state) => (
    targetTextKey(state.entityId) === normalizedDescriptor
    || targetTextKey(friendlyName(state)) === normalizedDescriptor
  ));
  if (states.length > 1 && requestedState !== null) {
    const capabilityMatches = states.filter((state) => exactStateCapabilitySupportsRequestedState(state, requestedState));
    if (capabilityMatches.length > 0) {
      states = capabilityMatches;
    }
  }
  if (states.length !== 1) {
    return null;
  }
  const state = states[0];
  if (!state) {
    return null;
  }
  return {
    label: friendlyName(state),
    entityIds: [state.entityId],
    source: targetTextKey(state.entityId) === normalizedDescriptor ? "entity_id" : "exact_name",
  };
}

function exactStateCapabilitySupportsRequestedState(state: HaEntityState, requestedState: string): boolean {
  const requested = targetTextKey(requestedState);
  const domain = domainFromEntityId(state.entityId);
  if (requested === "locked" || requested === "unlocked") {
    return domain === "lock";
  }
  if (requested === "open" || requested === "closed") {
    const deviceClass = typeof state.attributes.device_class === "string"
      ? state.attributes.device_class.trim().toLowerCase()
      : "";
    return domain === "cover"
      || (domain === "binary_sensor" && ["door", "garage_door", "opening", "window"].includes(deviceClass));
  }
  return true;
}

interface StatusResolutionMemo {
  readonly stateRevision: number;
  readonly registry: HaRegistryIndex | null;
  readonly registryRevision: number;
  readonly aliases: readonly AliasEntry[] | null;
  readonly results: Map<string, CurrentStatusResolution>;
}

const STATUS_RESOLUTION_MEMO_LIMIT = 64;

const STATUS_RESOLUTIONS = new WeakMap<HaStateCache, StatusResolutionMemo>();

/**
 * A turn resolves its status target once: every path asking about the same
 * target against the same HA revision reads the same answer.
 */
export function resolveStatusTargetWithClarifier(
  targetText: string,
  routes: BasicBrainRouteServices,
  requestedState: string | null = null,
  questionType: ClarifierQuestionType = requestedState ? "yes_no" : "state_value",
): CurrentStatusResolution {
  const cache = routes.stateCache;
  if (!cache) {
    return resolveFreshStatusTarget(targetText, routes, requestedState, questionType);
  }
  let memo = STATUS_RESOLUTIONS.get(cache);
  if (!memo
    || memo.stateRevision !== cache.revision()
    || memo.registry !== (routes.registry ?? null)
    || memo.registryRevision !== (routes.registry?.revision() ?? -1)
    || memo.aliases !== (routes.aliases ?? null)) {
    memo = {
      stateRevision: cache.revision(),
      registry: routes.registry ?? null,
      registryRevision: routes.registry?.revision() ?? -1,
      aliases: routes.aliases ?? null,
      results: new Map(),
    };
    STATUS_RESOLUTIONS.set(cache, memo);
  }
  const key = JSON.stringify([targetText, requestedState, questionType]);
  let result = memo.results.get(key);
  if (!result) {
    result = deepFreeze(resolveFreshStatusTarget(targetText, routes, requestedState, questionType));
    if (memo.results.size >= STATUS_RESOLUTION_MEMO_LIMIT) memo.results.clear();
    memo.results.set(key, result);
  }
  return result;
}

function resolveFreshStatusTarget(
  targetText: string,
  routes: BasicBrainRouteServices,
  requestedState: string | null,
  questionType: ClarifierQuestionType,
): CurrentStatusResolution {
  const surfaceTarget = targetTextKey(targetText);
  const reservedPerson = resolveReservedPersonStatusTarget(
    surfaceTarget,
    routes,
    requestedState,
    questionType,
  );
  if (reservedPerson.kind === "resolved") {
    // Once a household person name has matched, keep that namespace reserved.
    // Missing state or an incompatible predicate must decline as a person
    // query; neither is permission to reinterpret the name as a room fixture.
    return { target: reservedPerson.target, clarifier: null };
  }
  if (reservedPerson.kind === "ambiguous") {
    return { target: null, clarifier: reservedPerson.clarifier };
  }
  const normalizedVariants = statusTargetVariants(targetText, requestedState);
  const surfaceAllowsAreaInference = parseAreaDomainTarget(surfaceTarget) !== null
    || /\blighting\b/.test(surfaceTarget)
    || (/^(?:on|off)$/.test(requestedState ?? "")
      && !/\b(?:lights?|lighting|lamps?|outlets?|switch(?:es)?|person|door|lock|sensor)\b/.test(surfaceTarget));
  const index = statusTargetIndex(routes);
  const liveState = (entityId: string): HaEntityState | null => routes.stateCache?.get(entityId) ?? null;
  let deferredClarifier: PendingClarifierFrame | null = null;
  for (const normalized of normalizedVariants) {
    const aliasMatches = exactAliasMatches(normalized, routes.aliases ?? [], surfaceTarget);
    if (aliasMatches.length === 1) {
      const target = aliasMatches[0] as ResolvedTarget;
      if (requestedState && !exactStatusTargetSupportsRequestedState(target, routes, requestedState)) {
        return { target: null, clarifier: null };
      }
      return { target, clarifier: null };
    }
    if (aliasMatches.length > 1) {
      const aliasStates = [...new Set(aliasMatches.flatMap((match) => match.entityIds))]
        .map((entityId) => routes.stateCache?.get(entityId) ?? null)
        .filter((state): state is HaEntityState => state !== null);
      if (aliasStates.length > 1 && aliasStates.length <= 4) {
        deferredClarifier ??= statusClarifierForNameMatches(aliasStates, routes, requestedState, questionType);
      }
      continue;
    }

    const entityIdMatches = index.entityIdsWithIdKey(normalized);
    if (entityIdMatches.length === 1) {
      const entityId = entityIdMatches[0] as string;
      return { target: { label: entityId, entityIds: [entityId], source: "entity_id" }, clarifier: null };
    }

    const areaTarget = surfaceAllowsAreaInference ? resolveAreaDomainTarget(normalized, routes) : null;
    if (areaTarget) {
      return { target: areaTarget, clarifier: null };
    }

    const nameMatches = index.entityIdsWithLabelLike(normalized).flatMap((entityId) => {
      const state = liveState(entityId);
      const label = index.entity(entityId)?.label ?? "";
      return state
        && label.length >= 3
        && !isGenericPersonTempCollision(state, normalized)
        && fixtureNounNumberMatches(surfaceTarget, label)
        ? [state]
        : [];
    });
    if (nameMatches.length === 1) {
      const state = nameMatches[0] as HaEntityState;
      if (requestedState && !stateSupportsStatusPredicate(state, requestedState, surfaceTarget)) {
        return { target: null, clarifier: null };
      }
      return {
        target: {
          label: friendlyName(state),
          entityIds: [state.entityId],
          source: "exact_name",
        },
        clarifier: null,
      };
    }
    if (nameMatches.length > 1 && requestedState) {
      const compatibleMatches = nameMatches.filter((state) => stateSupportsRequestedState(state, requestedState));
      if (compatibleMatches.length === 1) {
        const state = compatibleMatches[0] as HaEntityState;
        return {
          target: {
            label: friendlyName(state),
            entityIds: [state.entityId],
            source: "exact_name",
          },
          clarifier: null,
        };
      }
    }
    if (requestedState && supportsRequestedStateTargetHint(requestedState)) {
      const hintedMatches = index.entries().flatMap(({ entityId, label }) => {
        if (label.length < 3 || !(label.includes(normalized) || normalized.includes(label))) return [];
        const state = liveState(entityId);
        return state && stateSupportsRequestedState(state, requestedState) ? [state] : [];
      });
      if (hintedMatches.length === 1) {
        const state = hintedMatches[0] as HaEntityState;
        return {
          target: {
            label: statusHintLabel(targetText, requestedState),
            entityIds: [state.entityId],
            source: "state_hint",
          },
          clarifier: null,
        };
      }
    }
    if (nameMatches.length > 1 && nameMatches.length <= 4) {
      deferredClarifier ??= statusClarifierForNameMatches(nameMatches, routes, requestedState, questionType);
      continue;
    }

  }

  // Exhaust exact semantic variants before fuzzy inference. Otherwise a
  // possessive room such as "Sam's room" can collapse to person.sam before
  // The exact "Sam's bedroom lights" variant is ever considered.
  for (const normalized of normalizedVariants) {
    const inferred = resolveInferredStatusTarget(normalized, routes, requestedState, questionType, surfaceTarget);
    if (inferred.target) {
      return inferred;
    }
    if (inferred.clarifier) {
      deferredClarifier ??= inferred.clarifier;
    }
  }

  return { target: null, clarifier: deferredClarifier };
}

type ReservedPersonStatusResolution =
  | { readonly kind: "none" }
  | { readonly kind: "resolved"; readonly target: ResolvedTarget }
  | { readonly kind: "ambiguous"; readonly clarifier: PendingClarifierFrame };

export function resolveReservedPersonStatusTarget(
  surfaceTarget: string,
  routes: BasicBrainRouteServices,
  requestedState: string | null,
  questionType: ClarifierQuestionType,
): ReservedPersonStatusResolution {
  if (!/^\p{L}[\p{L}'-]*(?: \p{L}[\p{L}'-]*){0,3}$/u.test(surfaceTarget)) {
    return { kind: "none" };
  }
  const candidates = statusTargetIndex(routes).people().map((person) => {
    const entityId = person.entityId;
    const state = person.hasState ? routes.stateCache?.get(entityId) ?? null : null;
    const registryEntity = person.registryEntity;
    const aliasKeys = (routes.aliases ?? []).flatMap((entry) => (
      entry.target.kind === "entity" && entry.target.entityId === entityId
        ? [targetTextKey(entry.alias)]
        : []
    )).filter(Boolean);
    const keys = [...person.keys, ...aliasKeys];
    const label = state
      ? friendlyName(state)
      : registryEntity?.name
        ?? registryEntity?.originalName
        ?? entityId.slice("person.".length).replaceAll("_", " ");
    return { entityId, registryEntity, label, keys };
  });
  const exact = candidates.filter((candidate) => candidate.keys.includes(surfaceTarget));
  const prefix = surfaceTarget.length >= 3
    ? candidates.filter((candidate) => candidate.keys.some((key) => key.startsWith(surfaceTarget)))
    : [];
  const matches = exact.length > 0 ? exact : prefix;
  if (matches.length === 0) {
    return { kind: "none" };
  }
  if (matches.length > 1) {
    const choices: PendingClarifierChoice[] = matches.map((candidate, index) => {
      const area = candidate.registryEntity?.effectiveAreaName;
      const label = area
        ? `${candidate.label} in ${area}`
        : `${candidate.label} as ${candidate.entityId}`;
      return {
        id: `person-status-${index + 1}`,
        label,
        synonyms: [...new Set([candidate.label, candidate.entityId, ...candidate.keys])],
        action: {
          kind: "entity_status",
          targetLabel: candidate.label,
          entityIds: [candidate.entityId],
          source: "exact_name",
          requestedState,
          questionType,
        },
      };
    });
    return {
      kind: "ambiguous",
      clarifier: {
        kind: "clarifier",
        route: "entity_status",
        prompt: `Do you mean ${joinAlternatives(choices.map((choice) => choice.label))}?`,
        choices,
      },
    };
  }
  const candidate = matches[0] as (typeof matches)[number];
  return {
    kind: "resolved",
    target: {
      label: candidate.label,
      entityIds: [candidate.entityId],
      source: exact.length > 0 ? "exact_name" : "inferred",
    },
  };
}

function resolveInferredStatusTarget(
  targetText: string,
  routes: BasicBrainRouteServices,
  requestedState: string | null,
  questionType: ClarifierQuestionType,
  surfaceTarget: string,
): CurrentStatusResolution {
  const resolver = targetResolverForRoutes(routes);
  if (!resolver) {
    return { target: null, clarifier: null };
  }
  const result = resolver.resolve({ text: targetText, includeUnavailable: true });
  const states = resolverStatesFromResult(result, routes)
    .filter((state) => fixtureNounNumberMatches(surfaceTarget, fixtureEvidenceForState(state)));
  if (result.confidence === "ambiguous" && states.length > 1 && states.length <= 4) {
    if (explicitTargetScopeMatchesNoCandidate(targetText, states, routes)) {
      return { target: null, clarifier: null };
    }
    return {
      target: null,
      clarifier: statusClarifierForNameMatches(states, routes, requestedState, questionType),
    };
  }
  if ((result.confidence === "high" || result.confidence === "medium") && states.length > 0) {
    if (explicitTargetScopeMatchesNoCandidate(targetText, states, routes)) {
      return { target: null, clarifier: null };
    }
    const label = targetText.trim().replace(/\s+/g, " ");
    return {
      target: {
        label,
        entityIds: states.map((state) => state.entityId),
        source: "inferred",
      },
      clarifier: null,
    };
  }
  return { target: null, clarifier: null };
}

function explicitTargetScopeMatchesNoCandidate(
  targetText: string,
  states: readonly HaEntityState[],
  routes: BasicBrainRouteServices,
): boolean {
  const stopWords = new Set([
    "a", "an", "the", "my", "our", "your", "lamp", "lamps", "light", "lights", "lighting",
    "room", "device", "sensor", "switch", "outlet", "plug", "state", "status", "check", "try",
    "instead", "rather", "than", "different", "another", "for", "me", "please", "on", "off",
  ]);
  const scopeTokens = targetTextKey(targetText)
    .split(/\s+/)
    .filter((token) => token.length > 1 && !stopWords.has(token));
  if (scopeTokens.length === 0) {
    return false;
  }
  return states.every((state) => {
    const registryEntity = routes.registry?.entity(state.entityId);
    const evidence = targetTextKey([
      friendlyName(state),
      state.entityId.replaceAll(/[._]/g, " "),
      registryEntity?.effectiveAreaName ?? "",
      ...(registryEntity?.nameCandidates ?? []),
    ].join(" "));
    return !scopeTokens.every((token) => evidence.includes(token));
  });
}

const NO_STATES = Object.freeze({ shape: {}, entries: Object.freeze([]) });

function statusTargetIndex(routes: BasicBrainRouteServices): TargetIndex {
  return targetIndexFor(routes.stateCache?.routingSnapshot() ?? NO_STATES, routes.registry ?? null);
}

function targetResolverForRoutes(routes: BasicBrainRouteServices): TargetResolver | null {
  if (!routes.registry || !routes.stateCache) {
    return null;
  }
  return targetResolverFor(routes.stateCache, routes.registry, routes.aliases ?? []);
}

function resolverStatesFromResult(
  result: TargetResolverResult,
  routes: BasicBrainRouteServices,
): readonly HaEntityState[] {
  const cache = routes.stateCache;
  if (!cache) {
    return [];
  }
  return result.matches
    .map((match) => cache.get(match.entityId))
    .filter((state): state is HaEntityState => state !== null);
}

/** "Do you mean the lounge room or the front lounge?": one choice per room, answered as "<room> <reading>". */
function placeReadingClarifier(
  candidates: readonly { readonly entityId: string; readonly label: string }[],
  targetText: string,
  requestedState: string | null,
  questionType: ClarifierQuestionType,
): PendingClarifierFrame {
  const reading = PLACE_READING_TAIL.exec(targetText)?.[0] ?? "";
  const choices: PendingClarifierChoice[] = candidates.map((candidate, index) => {
    const place = lowerCommonWords(candidate.label);
    return {
      id: `entity-status-${index + 1}`,
      label: `the ${place}`,
      synonyms: [candidate.label, place, `${place} ${reading}`, candidate.entityId],
      action: {
        kind: "entity_status",
        targetLabel: `${place} ${reading}`,
        entityIds: [candidate.entityId],
        source: "exact_name",
        requestedState,
        questionType,
      },
    };
  });
  return {
    kind: "clarifier",
    route: "entity_status",
    prompt: `Do you mean ${joinAlternatives(choices.map((choice) => choice.label))}?`,
    choices,
  };
}

function statusClarifierForNameMatches(
  states: readonly HaEntityState[],
  routes: BasicBrainRouteServices,
  requestedState: string | null,
  questionType: ClarifierQuestionType,
): PendingClarifierFrame {
  const choices: PendingClarifierChoice[] = states.map((state, index) => {
    const label = disambiguatedStateLabel(state, routes);
    return {
      id: `entity-status-${index + 1}`,
      label,
      synonyms: [friendlyName(state), state.entityId],
      action: {
        kind: "entity_status",
        targetLabel: label,
        entityIds: [state.entityId],
        source: "exact_name",
        requestedState,
        questionType,
      },
    };
  });
  const prompt = `Do you mean ${joinAlternatives(choices.map((choice) => choice.label))}?`;
  return {
    kind: "clarifier",
    route: "entity_status",
    prompt,
    choices,
  };
}

function disambiguatedStateLabel(state: HaEntityState, routes: BasicBrainRouteServices): string {
  const base = friendlyName(state);
  const registryEntity = routes.registry?.entity(state.entityId) ?? null;
  if (registryEntity?.effectiveAreaName) {
    return `${base} in ${registryEntity.effectiveAreaName}`;
  }
  if (registryEntity?.deviceName) {
    return `${base} on ${registryEntity.deviceName}`;
  }
  return `${base} as ${state.entityId}`;
}

export async function statusAnswerFromPlan(
  queryPlan: CurrentStatusPlan,
  routes: BasicBrainRouteServices,
  now: () => Date,
  request: VoiceBrainRequest,
  turnAnalysis: BasicTurnAnalysis | null = null,
): Promise<BasicResult | null> {
  if (queryPlan.targetText) {
    if (
      isGuestSpeakerRequest(request)
      && queryPlan.questionType === "state_value"
      && isSourceBackedPersonalLocatorTarget(queryPlan.targetText, routes)
    ) {
      return guestPersonalStatusDecline(
        "guest mode blocked a source-backed personal locator request",
      );
    }
    const targetText = /^(?:i|me|myself)$/.test(targetTextKey(queryPlan.targetText))
      ? trustedSpeakerLabel(request) ?? queryPlan.targetText
      : queryPlan.targetText;
    const demonstrativeReference = classifyDemonstrativeTarget(targetText);
    const unresolvedGenericReference = demonstrativeReference.kind === "none"
      && queryPlan.quantifier == null
      && isGenericActionTargetDescriptor(targetText);
    const explicitDemonstrativeTarget = resolveExplicitDemonstrativeTarget(
      targetText,
      routes,
      { requestedState: queryPlan.requestedState },
    );
    const exactExclusionTarget = resolveExactExclusionStatusTarget(
      targetText,
      demonstrativeReference,
      routes,
      queryPlan.requestedState,
    );
    const exactTarget = explicitDemonstrativeTarget ?? exactExclusionTarget;
    if (exactTarget) {
      const sourceQuery = explicitDemonstrativeTarget
        ? demonstrativeActionTargetDescriptor(targetText) ?? targetText
        : targetText;
      return entityStatus(exactTarget, routes, {
        ...queryPlan,
        targetText: sourceQuery,
      }, request, statusAcquisitionEvidence(
        exactTarget,
        "explicit",
        turnAnalysis,
        sourceQuery,
      ));
    }
    if (demonstrativeReference.kind === "descriptive" || demonstrativeReference.kind === "underspecified") {
      return declined("entity_status", "I can't see a matching device for that.", "demonstrative status target did not resolve exactly");
    }
    if (demonstrativeReference.kind === "contextual") {
      return declined(
        "entity_status",
        "I don't have a previous sourced status target to attach that to.",
        "contextual status target declined without a status context frame",
      );
    }
    // A reading in a place ("lounge room temperature", "inside humidity")
    // resolves by device class and area, so a new room sensor needs no alias.
    const namesPlaceReading = PLACE_READING_TAIL.test(targetText);
    const needsCompositionalSourceResolution = queryPlan.compareGroupUniformity === true
      || queryPlan.quantifier != null
      || /\b(?:and|or)\b/.test(targetText)
      || namesPlaceReading;
    const sourceResolution = turnAnalysis && needsCompositionalSourceResolution
      ? resolveStandaloneEntityStatusTarget({
        targetText,
        requestedState: queryPlan.requestedState,
        quantifier: queryPlan.quantifier ?? null,
        ...(namesPlaceReading ? { requestedAttribute: queryPlan.requestedAttribute ?? null } : {}),
        analysis: turnAnalysis,
      })
      : null;
    if (sourceResolution?.outcome === "resolved") {
      const sourceTarget: ResolvedTarget = {
        // Say the reading the way it was asked ("inside temperature"), not a
        // registry name such as "Hallway Temperature".
        label: namesPlaceReading && sourceResolution.target.entityIds.length === 1
          ? targetText
          : sourceResolution.target.label,
        entityIds: sourceResolution.target.entityIds,
        source: sourceResolution.target.source,
      };
      return entityStatus(
        sourceTarget,
        routes,
        queryPlan,
        request,
        statusAcquisitionEvidence(sourceTarget, "explicit", turnAnalysis, targetText),
      );
    }
    // A reading in a place that names more than one room ("the lounge": Lounge Room and
    // Front Lounge, one candidate per room) asks which room. The looser name match below would sweep in
    // everything called "temperature" in either room (a NAS, the vacuum's water setting).
    if (namesPlaceReading
      && sourceResolution?.outcome === "ambiguous"
      && sourceResolution.candidates.every((candidate) => candidate.source === "area_domain")
      && new Set(sourceResolution.candidates.map((candidate) => candidate.label)).size === sourceResolution.candidates.length) {
      const clarifier = placeReadingClarifier(sourceResolution.candidates, targetText, queryPlan.requestedState, queryPlan.questionType);
      return clarify("entity_status", clarifier.prompt, "place reading names more than one room", clarifier);
    }
    if (unresolvedGenericReference) {
      const genericSourceResolution = turnAnalysis
        ? resolveStandaloneEntityStatusTarget({
          targetText,
          requestedState: queryPlan.requestedState,
          quantifier: queryPlan.quantifier ?? null,
          analysis: turnAnalysis,
        })
        : null;
      if (genericSourceResolution?.outcome === "resolved") {
        return entityStatus({
          label: targetText,
          entityIds: genericSourceResolution.target.entityIds,
          source: genericSourceResolution.target.source,
        }, routes, queryPlan, request, { acquisition: "inferred" });
      }
      const genericResolution = resolveStatusTargetWithClarifier(
        targetText,
        routes,
        queryPlan.requestedState,
        queryPlan.questionType,
      );
      if (genericResolution.clarifier) {
        return clarify(
          "entity_status",
          genericResolution.clarifier.prompt,
          "generic status target needs exact-name clarification",
          genericResolution.clarifier,
        );
      }
      return declined(
        "entity_status",
        "I need an exact device name for that.",
        "generic status target cannot create fresh provenance",
      );
    }
    const resolution = resolveStatusTargetWithClarifier(targetText, routes, queryPlan.requestedState, queryPlan.questionType);
    if (resolution.target) {
      return entityStatus(
        resolution.target,
        routes,
        queryPlan,
        request,
        statusAcquisitionEvidence(
          resolution.target,
          "explicit",
          turnAnalysis,
          targetText,
        ),
      );
    }
    if (resolution.clarifier) {
      return clarify("entity_status", resolution.clarifier.prompt, "status target needs exact-name clarification", resolution.clarifier);
    }
    if (queryPlan.requestedState) {
      let requestedStateClarifier: PendingClarifierFrame | null = null;
      for (const candidate of stateNamedStatusTargetCandidates(targetText, queryPlan.requestedState)) {
        const stateNamedResolution = resolveStatusTargetWithClarifier(candidate, routes, queryPlan.requestedState, queryPlan.questionType);
        if (stateNamedResolution.target) {
          return entityStatus(
            stateNamedResolution.target,
            routes,
            queryPlan,
            request,
            statusAcquisitionEvidence(
              stateNamedResolution.target,
              "explicit",
              turnAnalysis,
              candidate,
            ),
          );
        }
        if (!requestedStateClarifier && stateNamedResolution.clarifier) {
          requestedStateClarifier = stateNamedResolution.clarifier;
        }
      }
      if (requestedStateClarifier) {
        return clarify("entity_status", requestedStateClarifier.prompt, "status target needs exact-name clarification", requestedStateClarifier);
      }
    }
    const inferred = await inferHouseFactAnswer(targetText, routes, now, request);
    if (inferred) {
      return inferred;
    }
    if (looksLikeExplicitStatusTargetObject(targetText)) {
      return declined("entity_status", "I can't see a matching device for that.", "status target could not be resolved");
    }
    if (queryPlan.requestedState || queryPlan.questionType === "yes_no") {
      return declined("entity_status", "I can't see a matching device for that.", "status target could not be resolved");
    }
    return null;
  }
  return houseLightsStatus(routes);
}

export function isSourceBackedPersonalLocatorTarget(
  targetText: string,
  routes: BasicBrainRouteServices,
): boolean {
  const normalizedTarget = targetTextKey(targetText);
  if (/^(?:my|our|your|his|her|their)\b/.test(normalizedTarget)) {
    return true;
  }
  const owner = /^(.+?)\s+s\s+.+$/.exec(normalizedTarget)?.[1]?.trim() ?? "";
  if (!owner) {
    return false;
  }
  const ownerTarget = resolveStatusTarget(owner, routes);
  const privacy = buildEntityLocationPrivacyContext({
    registry: routes.registry,
    states: routes.stateCache?.entries() ?? [],
    aliases: routes.aliases ?? [],
  });
  return ownerTarget?.entityIds.some((entityId) =>
    isSensitiveLocationEntity(
      entityId,
      routes.stateCache?.get(entityId) ?? null,
      privacy.labelsForEntity(entityId),
      privacy.knownPersonLabels,
    )
  ) ?? false;
}

export async function inferHouseFactAnswer(
  transcript: string,
  routes: BasicBrainRouteServices,
  now: () => Date,
  request: VoiceBrainRequest,
): Promise<BasicResult | null> {
  const challengedQuestion = challengedHouseFactQuestionText(normalize(transcript));
  if (challengedQuestion) {
    const recoveredOutsideTemperature = await inferOutsideTemperatureAnswer(challengedQuestion, routes, now, request);
    if (recoveredOutsideTemperature) {
      return recoveredOutsideTemperature;
    }
  }
  const inferredOutsideTemperature = await inferOutsideTemperatureAnswer(transcript, routes, now, request);
  if (inferredOutsideTemperature) {
    return inferredOutsideTemperature;
  }
  return null;
}

async function inferOutsideTemperatureAnswer(
  transcript: string,
  routes: BasicBrainRouteServices,
  now: () => Date,
  request: VoiceBrainRequest,
): Promise<BasicResult | null> {
  const normalized = normalizeBareTemperatureQuestionText(normalize(transcript));
  if (COMPARATOR_WORD.test(normalized)) {
    return null;
  }
  if (!looksLikeBareTemperatureQuestion(normalized) || explicitlyIndoorTemperatureQuestion(normalized)) {
    return null;
  }
  const outsideTemperature = resolveStatusTarget("outside temperature", routes);
  if (outsideTemperature) {
    const direct = entityStatus(outsideTemperature, routes, {
      intent: "current_status",
      targetText: outsideTemperature.label,
      requestedState: null,
      questionType: "state_value",
      source: "aliases_or_live_state",
    }, request, { acquisition: "inferred" });
    return {
      ...direct,
      notes: `${direct.notes}; inferred outside temperature from vague temperature prompt`,
    };
  }
  const weather = await weatherFastPathAnswer(routes, now(), "what's the temperature outside right now?");
  return weather.status === "ok"
    ? { ...weather, notes: `${weather.notes}; inferred outside temperature from vague temperature prompt` }
    : null;
}

export function resolveExactTarget(transcript: string, routes: BasicBrainRouteServices): ResolvedTarget | null {
  const normalized = normalize(transcript);
  const aliasMatches = aliasMatchesInText(
    normalized,
    routes.aliases ?? [],
  ).filter((match) => targetLabelOwnsStatusUtterance(match.label, normalized));
  if (aliasMatches.length === 1) {
    return aliasMatches[0] as ResolvedTarget;
  }
  if (aliasMatches.length > 1) {
    return null;
  }

  const index = statusTargetIndex(routes);
  const entityIdMatches = index.entries()
    .filter(({ idKey }) => normalized.includes(idKey))
    .map(({ entityId }) => entityId);
  if (entityIdMatches.length === 1) {
    const entityId = entityIdMatches[0] as string;
    return { label: entityId, entityIds: [entityId], source: "entity_id" };
  }

  const nameMatches = index.entries().filter(({ routingLabel: label }) => {
    if (label === "house" && looksLikeWholeHouseLightScopeQuestion(normalized)) {
      return false;
    }
    return label.length >= 3
      && normalized.includes(label)
      && targetLabelOwnsStatusUtterance(label, normalized);
  });
  const nameMatch = nameMatches.length === 1 ? routes.stateCache?.get(nameMatches[0]?.entityId ?? "") ?? null : null;
  if (nameMatch) {
    return { label: friendlyName(nameMatch), entityIds: [nameMatch.entityId], source: "exact_name" };
  }

  const resolver = targetResolverForRoutes(routes);
  if (resolver) {
    const result = resolver.resolve({ text: transcript, includeUnavailable: true });
    if ((result.confidence === "high" || result.confidence === "medium") && result.matches.length === 1) {
      const match = result.matches[0] as TargetResolverMatch;
      const state = routes.stateCache?.get(match.entityId) ?? null;
      if (!state) {
        return null;
      }
      return {
        label: friendlyName(state),
        entityIds: [match.entityId],
        source: "inferred",
      };
    }
  }
  return null;
}

function targetLabelOwnsStatusUtterance(
  label: string,
  utterance: string,
): boolean {
  const labelTokens = targetTextKey(label).split(/\s+/).filter(Boolean);
  const utteranceTokens = targetTextKey(utterance).split(/\s+/).filter(Boolean);
  if (labelTokens.length === 0 || utteranceTokens.length === 0) {
    return false;
  }
  let matchAt = -1;
  for (let index = 0; index <= utteranceTokens.length - labelTokens.length; index += 1) {
    if (labelTokens.every((token, offset) =>
      utteranceTokens[index + offset] === token)) {
      matchAt = index;
      break;
    }
  }
  if (matchAt < 0) {
    return false;
  }
  const residual = [
    ...utteranceTokens.slice(0, matchAt),
    ...utteranceTokens.slice(matchAt + labelTokens.length),
  ];
  const statusGrammar = new Set([
    "a", "about", "an", "and", "are", "as", "at", "away", "be", "been",
    "being", "can", "check", "closed", "confirm", "could", "currently", "did",
    "disabled", "do", "does", "enabled", "exactly", "find", "give", "has",
    "have", "home", "how", "i", "in", "inactive", "is", "it", "know", "lit",
    "locked", "me", "my", "now", "of", "off", "on", "open", "our", "please",
    "read", "reading", "report", "right", "running", "s", "scan", "show", "state",
    "status", "still", "stopped", "tell", "that", "the", "their", "this", "to",
    "unlocked", "value", "verify", "was", "were", "what", "where", "which",
    "who", "will", "work", "would", "you", "your",
  ]);
  return residual.every((token) => statusGrammar.has(token));
}

function exactAliasMatches(
  normalizedTarget: string,
  aliases: readonly AliasEntry[],
  surfaceTarget = normalizedTarget,
): readonly ResolvedTarget[] {
  const target = exactAliasTargetKey(normalizedTarget);
  return aliases.flatMap((entry) => {
    const alias = exactAliasTargetKey(entry.alias);
    return alias && fixtureNounNumberMatches(surfaceTarget, alias) && labelsEquivalent(alias, target)
      ? aliasResolvedTarget(entry)
      : [];
  });
}

function aliasResolvedTarget(entry: AliasEntry): readonly ResolvedTarget[] {
  if (entry.target.kind === "entity") {
    return [{ label: entry.alias, entityIds: [entry.target.entityId], source: "alias" }];
  }
  if (entry.target.kind === "group") {
    return [{ label: entry.alias, entityIds: [...entry.target.entityIds], source: "alias" }];
  }
  return [];
}

function exactStatusTargetSupportsRequestedState(
  target: ResolvedTarget,
  routes: BasicBrainRouteServices,
  requestedState: string,
): boolean {
  const states = target.entityIds
    .map((entityId) => routes.stateCache?.get(entityId) ?? null)
    .filter((state): state is HaEntityState => state !== null);
  return states.length !== target.entityIds.length
    || states.every((state) => stateSupportsStatusPredicate(state, requestedState, target.label));
}

/**
 * Open/closed of a lock: "is the front door lock open?" asks about the lock
 * (open means unlocked), and the garage's lock is its door. "Is the front door
 * open?" asks about the door, which a bolt can't see (no unpredictable
 * answers), so it is not answered from the lock.
 */
function stateSupportsStatusPredicate(state: HaEntityState, requestedState: string, spokenTarget: string): boolean {
  if (isUnavailableState(state)) return true;
  const requested = targetTextKey(requestedState);
  if (domainFromEntityId(state.entityId) === "lock"
    && (requested === "open" || requested === "closed")) {
    return /\block\b/i.test(spokenTarget) || isGarageDoorLock(state.entityId, friendlyName(state));
  }
  return stateSupportsRequestedState(state, requestedState);
}

export function exactAliasTargetKey(value: string): string {
  return targetTextKey(value)
    .replace(/^(?:our|your)\s+/, "")
    .trim();
}

function fixtureNounNumberMatches(targetText: string, candidateText: string): boolean {
  const target = targetTextKey(targetText);
  const candidate = targetTextKey(candidateText);
  const asksForOneFixture = /\blamp\b/.test(target) && !/\blamps\b/.test(target);
  const candidateOnlyNamesPluralLights = /\blights\b/.test(candidate) && !/\b(?:lamp|light)\b/.test(candidate);
  return !(asksForOneFixture && candidateOnlyNamesPluralLights);
}

function fixtureEvidenceForState(state: HaEntityState): string {
  const objectId = state.entityId.split(".").slice(1).join(" ").replaceAll("_", " ");
  return `${friendlyName(state)} ${objectId}`;
}

function aliasMatchesInText(normalizedText: string, aliases: readonly AliasEntry[]): readonly ResolvedTarget[] {
  return aliases.flatMap((entry) => {
    const alias = targetTextKey(entry.alias);
    return alias && normalizedText.includes(alias) ? aliasResolvedTarget(entry) : [];
  });
}

export function actionStateSupportsOperation(
  operation: EntityActionOperation,
  state: HaEntityState,
): boolean {
  const domain = domainFromEntityId(state.entityId);
  return entityActionOperationSupportsDomain(operation, domain);
}

export function looksLikeHouseFact(normalized: string): boolean {
  return /\b(?:lights?|lighting|lamps?|locks?|sensors?|switch(?:es)?|doors?|pumps?|temperature|state|status)\b/.test(normalized)
    && /\b(what|which|is|are|any|status|state|does|do|say|says|reading|anything)\b/.test(normalized);
}

const EXPLICIT_STATUS_OBJECT = new RegExp(String.raw`\b(?:${DEVICE_STATUS_PATTERN}|temperature|temp)\b`);

export function looksLikeExplicitStatusTargetObject(targetText: string): boolean {
  return EXPLICIT_STATUS_OBJECT.test(targetText);
}

function looksLikeBareTemperatureQuestion(normalized: string): boolean {
  if (!/\b(temp|temperature)\b/.test(normalized)) {
    return /^(?:what(?:s| is)|how(?:s| is))(?: it)? outside(?: right now| now| at the moment| currently| then)?$/.test(normalized);
  }
  if (/\b(weather|outside|outdoors?|forecast|rain|humidity|wind|feels like|apparent)\b/.test(normalized)) {
    return true;
  }
  return /^(?:what(?:s| is)|tell me|give me|check|how much is|how hot is|how cold is)(?: the)? temperature(?: right now| now| at the moment| currently| then)?$/.test(normalized)
    || /^(?:what(?:s| is)|tell me|give me|check)(?: the)? temp(?: right now| now| at the moment| currently| then)?$/.test(normalized)
    || /^(?:temperature|temp)(?: right now| now| at the moment| currently| then)?$/.test(normalized);
}

function explicitlyIndoorTemperatureQuestion(normalized: string): boolean {
  return INDOOR_SCOPE_WORD.test(normalized);
}

function normalizeBareTemperatureQuestionText(normalized: string): string {
  return canonicalizeLeadingQuestionContractions(stripStatusFiller(normalized)
    .replace(/^[^a-z0-9]+/g, " ")
    .replace(/^(?:(?:ok(?:ay)?|right|so)\b\s*)+/g, " ")
    .replace(/\bthen\b/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

export function challengedHouseFactQuestionText(normalized: string): string | null {
  const match = /^(?:so\s+)?you\s+do(?:n t| not)?\s+know\s+what\s+(.+?)\s+is\??$/.exec(normalized);
  if (!match?.[1]) {
    if (/\bthat(?:\s+s|s| is)\s+just\s+asking\s+what\s+the\s+temperature\s+is\b/.test(normalized)) {
      return "what is the temperature";
    }
    return null;
  }
  return `what is ${match[1].trim()}`;
}

// Owners and follow-up steps ask the same turn's plan several times; the parse reads only the text.
const statusPlans = new Map<string, CurrentStatusPlan | null>();

/** The status question in `input`, parsed once per text and speech act (frozen: never mutate it). */
export function parseCurrentStatusPlan(input: string, speechAct?: RoutingSpeechAct): CurrentStatusPlan | null {
  const key = `${speechAct ?? ""}\u0000${input}`;
  const cached = statusPlans.get(key);
  if (cached !== undefined) return cached;
  if (statusPlans.size >= 2_000) statusPlans.clear();
  const plan = readCurrentStatusPlan(input, speechAct);
  if (plan?.numericComparison) Object.freeze(plan.numericComparison);
  statusPlans.set(key, plan && Object.freeze(plan));
  return plan;
}

function readCurrentStatusPlan(input: string, speechAct: RoutingSpeechAct | undefined): CurrentStatusPlan | null {
  const normalized = stripStatusFiller(normalize(input));
  if (/^(?:what year|when)\b.*\bcome out\b/.test(normalized)) {
    return null;
  }
  const ownedSpeechAct = speechAct ?? parseRoutingUtterance(normalized).speechAct;
  if (ownedSpeechAct === "query"
    && (/^(?:how|why)\b.*\b(?:turn|switch|set|make|open|close|lock|unlock|start|stop|pause|resume|dock|change)\b/.test(normalized)
      || /^will (?!you\b).+\b(?:open|close|lock|unlock|start|stop)\b/.test(normalized))) {
    return null;
  }
  if (looksLikeGlobalLightsStatus(normalized)) {
    return {
      intent: "current_status",
      targetText: null,
      requestedState: requestedStateFromStatusText(normalized) ?? "on",
      questionType: "yes_no",
      source: "aliases_or_live_state",
      quantifier: statusQuantifierFromText(normalized),
    };
  }
  const sharedPlan = parseStandaloneEntityStatusIntent(normalized, {
    speechAct: ownedSpeechAct,
  });
  const targetText = explicitFocusShiftTargetText(normalized) ?? sharedPlan?.targetText ?? null;
  if (!targetText) {
    return null;
  }
  const requestedState = sharedPlan
    ? sharedPlan.requestedState === "out" ? "out" : canonicalStatusRequestedState(sharedPlan.requestedState)
    : requestedStateFromStatusText(normalized);
  const numericComparison = sharedPlan
    ? sharedPlan.numericComparison
    : parseNumericStatusComparison(normalized);
  return {
    intent: "current_status",
    targetText,
    requestedState,
    questionType: sharedPlan?.questionType ?? (requestedState || numericComparison ? "yes_no" : "state_value"),
    source: "aliases_or_live_state",
    quantifier: sharedPlan ? sharedPlan.quantifier : statusQuantifierFromText(normalized),
    numericComparison,
    requestedAttribute: sharedPlan?.requestedAttribute ?? null,
    compareGroupUniformity: sharedPlan
      ? sharedPlan.compareGroupUniformity
      : /\b(?:same state|all (?:showing|set|switched) the same)\b/.test(normalized),
  };
}

function stateNamedStatusTargetCandidates(targetText: string, requestedState: string): readonly string[] {
  const candidates = [`${targetText} ${requestedState}`];
  if (requestedState === "connected" || requestedState === "disconnected") {
    candidates.push(`${targetText} connected`);
  }
  if (requestedState === "armed" || requestedState === "disarmed") {
    candidates.push(`${targetText} armed`);
  }
  return [...new Set(candidates)];
}

export function requestedStateForStatusTarget(normalized: string, targetText: string): string | null {
  const sharedPlan = parseStandaloneEntityStatusIntent(normalized, {
    speechAct: parseRoutingUtterance(normalized).speechAct,
  });
  if (sharedPlan) {
    return sharedPlan.requestedState === "out"
      ? "out"
      : canonicalStatusRequestedState(sharedPlan.requestedState);
  }
  const target = targetTextKey(targetText);
  if (!target) {
    return requestedStateFromStatusText(normalized);
  }
  const targetPattern = target.split(/\s+/).map(escapeRegExp).join("\\s+");
  const withoutTarget = normalized
    .replace(new RegExp(`(?:^|\\s)${targetPattern}(?=\\s|$)`, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();
  return requestedStateFromStatusText(withoutTarget);
}

function resolveAreaDomainTarget(normalizedTarget: string, routes: BasicBrainRouteServices): ResolvedTarget | null {
  const areaDomain = parseAreaDomainTarget(normalizedTarget);
  if (!areaDomain) {
    return null;
  }
  const states = statusTargetIndex(routes).entityIdsInDomain(areaDomain.domain)
    .flatMap((entityId) => routes.stateCache?.get(entityId) ?? []);
  const areaTokens = areaDomain.area.split(" ").filter(Boolean);
  const candidates = states.filter((state) => {
    if (isUnavailableState(state)) {
      return false;
    }
    if (areaDomain.domain === "light" && !isAreaResolvableHouseLight(state)) {
      return false;
    }
    const registryEntity = routes.registry?.entity(state.entityId);
    const areaName = registryEntity?.effectiveAreaName ? targetTextKey(registryEntity.effectiveAreaName) : "";
    const friendly = targetTextKey(friendlyName(state));
    const entityLabel = targetTextKey(state.entityId.replaceAll(/[._]/g, " "));
    const combined = [areaName, friendly, entityLabel].filter(Boolean).join(" ");
    const combinedTokens = new Set(combined.split(/\s+/).filter(Boolean));
    const exactPhraseMatch = ` ${combined} `.includes(` ${areaDomain.area} `);
    const tokenMatch = areaTokens.length > 0 && areaTokens.every((token) => combinedTokens.has(token));
    return labelsEquivalent(areaName, areaDomain.area)
      || exactPhraseMatch
      || tokenMatch;
  });
  if (candidates.length === 0) {
    return null;
  }
  const displayArea = displayAreaDomainTargetArea(areaDomain.area, candidates);
  if (candidates.length === 1) {
    const state = candidates[0] as HaEntityState;
    return {
      label: `${displayArea} ${areaDomain.labelWord}`,
      entityIds: [state.entityId],
      source: "area_domain",
    };
  }
  if (!pluralDomainWord(areaDomain.labelWord)) {
    return null;
  }
  return {
    label: `${displayArea} ${areaDomain.labelWord}`,
    entityIds: candidates.map((state) => state.entityId),
    source: "area_domain",
  };
}

function parseAreaDomainTarget(normalizedTarget: string): {
  readonly area: string;
  readonly domain: string;
  readonly domainWord: string;
  readonly labelWord: string;
} | null {
  const inArea = /^(lights?|switches|locks|sensors) in (?:the )?(.+)$/.exec(normalizedTarget);
  if (inArea) {
    const labelWord = targetTextKey(inArea[1] ?? "");
    const domainWord = singularDomainWord(labelWord);
    const area = cleanTargetText(inArea[2] ?? "", "status");
    const domain = domainForWord(domainWord);
    return area && domain && labelWord ? { area, domain, domainWord, labelWord } : null;
  }
  const suffix = /^(.+) (lights?|switches|locks|sensors)$/.exec(normalizedTarget);
  if (suffix) {
    const area = cleanTargetText(suffix[1] ?? "", "status");
    const labelWord = targetTextKey(suffix[2] ?? "");
    const domainWord = singularDomainWord(labelWord);
    const domain = domainForWord(domainWord);
    return area && domain && labelWord ? { area, domain, domainWord, labelWord } : null;
  }
  return null;
}

function isAreaResolvableHouseLight(state: HaEntityState): boolean {
  const friendly = targetTextKey(friendlyName(state));
  const entityLabel = targetTextKey(state.entityId.replaceAll(/[._]/g, " "));
  const searchable = `${friendly} ${entityLabel}`;
  if (/\bpower on state\b/.test(searchable) || /\bdnd\b/.test(searchable) || /\ball lights?\b/.test(searchable)) {
    return false;
  }
  if (isReportableHouseLight(state)) {
    return true;
  }
  if (/^light\.lights_[a-z0-9_]+2?$/.test(state.entityId)) {
    return true;
  }
  return /\blights?\b/.test(friendly) || houseConfig().lights.alsoLights.includes(state.entityId);
}

function displayAreaDomainTargetArea(area: string, candidates: readonly HaEntityState[]): string {
  if (!/\broom\b/.test(area) || /\bbedroom\b/.test(area)) {
    return area;
  }
  const allBedroomScoped = candidates.every((state) => {
    const friendly = targetTextKey(friendlyName(state));
    const entityLabel = targetTextKey(state.entityId.replaceAll(/[._]/g, " "));
    return friendly.includes("bedroom") || entityLabel.includes("bedroom");
  });
  return allBedroomScoped ? area.replace(/\broom\b/g, "bedroom") : area;
}

function singleStatusSentence(label: string, state: HaEntityState, plan: CurrentStatusPlan): string {
  const truth = entityStatusTruth([state], plan);
  if (domainFromEntityId(state.entityId) === "person") {
    const rawLocation = targetTextKey(state.state) || "unknown";
    const location = rawLocation === "not_home" ? "away" : rawLocation;
    const place = location === "home" || location === "away" || location === "unknown" || location === "unavailable"
      ? location
      : `at ${location}`;
    const body = `${capitalize(label)} is ${place}.`;
    if (plan.requestedState) {
      return `${entityStatusTruthPrefix(truth)}${body}`;
    }
    return body;
  }
  const subject = subjectForStatus(label);
  const value = renderedStatusValue(state, plan);
  const verb = pluralLabel(label) ? "are" : "is";
  if (plan.numericComparison) {
    return `${entityStatusTruthPrefix(truth)}${capitalize(subject)} ${verb} ${value.text}.`;
  }
  if (plan.requestedState) {
    return `${entityStatusTruthPrefix(truth)}${capitalize(subject)} ${verb} ${value.text}.`;
  }
  return `${capitalize(subject)} ${verb} ${value.text}.`;
}

export function canonicalEntityStatusLabel(state: HaEntityState, resolvedLabel: string): string {
  if (domainFromEntityId(state.entityId) === "person") {
    return resolvedLabel;
  }
  const friendly = friendlyName(state).trim();
  const resolved = resolvedLabel.trim();
  const normalizedResolved = targetTextKey(resolved);
  const normalizedFriendly = targetTextKey(friendly);
  const normalizedFriendlyWithoutPrefix = targetTextKey(friendly.replace(/^lights\s*-\s*/i, ""));
  const normalizedEntityId = targetTextKey(state.entityId.replaceAll(/[._]/g, " "));
  const normalizedDomain = targetTextKey(domainFromEntityId(state.entityId).replaceAll("_", " "));
  const resolvedIsBareDomainName = normalizedResolved === normalizedDomain
    && (` ${normalizedFriendly} `.includes(` ${normalizedResolved} `)
      || ` ${normalizedFriendlyWithoutPrefix} `.includes(` ${normalizedResolved} `));
  const candidate = !resolved
    || normalizedResolved === normalizedEntityId
    || normalizedResolved === normalizedFriendly
    || normalizedResolved === normalizedFriendlyWithoutPrefix
    || resolvedIsBareDomainName
    ? friendly
    : resolved;
  const clean = undoubledName(candidate.replace(/^lights\s*-\s*/i, "").trim());
  const bedroom = householdRegex(String.raw`^({NAMES})(?:'s| s)? bedroom(?: lights?)?(?: main)?$`, "i").exec(clean);
  if (bedroom?.[1]) return `${capitalize(bedroom[1].toLowerCase())}'s bedroom lights`;
  if (/^kitchen cabinets$/i.test(clean)) return "Kitchen cabinet lights";
  if (/^kitchen main$/i.test(clean)) return "Kitchen lights";
  if (/^office lights secondary$/i.test(clean)) return "Office secondary light";
  const mainLights = /^(.+?) lights main$/i.exec(clean)?.[1];
  if (mainLights) return `${capitalize(mainLights)} lights`;
  return clean || resolvedLabel;
}

function statusGroupItemLabels(
  states: readonly HaEntityState[],
  routes: BasicBrainRouteServices,
): ReadonlyMap<string, string> {
  const shortLabels = states.map((state) => shortFriendlyName(state));
  const counts = new Map<string, number>();
  for (const label of shortLabels) {
    const key = targetTextKey(label);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Map(states.map((state, index) => {
    const shortLabel = shortLabels[index] ?? friendlyName(state);
    const duplicate = (counts.get(targetTextKey(shortLabel)) ?? 0) > 1;
    return [state.entityId, duplicate ? disambiguatedStateLabel(state, routes) : shortLabel];
  }));
}

function statusGroupLabel(label: string, memberCount: number): string {
  const clean = label.trim().replace(/\s+/g, " ");
  if (memberCount < 2 || pluralLabel(clean) || /\blighting$/i.test(clean)) {
    return clean;
  }
  const finalWord = targetTextKey(clean).split(/\s+/).at(-1) ?? "";
  const plural = statusGroupPluralWord(finalWord);
  return plural ? clean.replace(new RegExp(`${escapeRegExp(finalWord)}$`, "i"), plural) : clean;
}

function statusGroupPluralWord(word: string): string | null {
  switch (word) {
    case "person": return "people";
    case "switch": return "switches";
    case "lock": return "locks";
    case "light": return "lights";
    case "lamp": return "lamps";
    case "sensor": return "sensors";
    case "door": return "doors";
    case "window": return "windows";
    case "blind": return "blinds";
    case "shade": return "shades";
    case "curtain": return "curtains";
    case "gate": return "gates";
    case "fan": return "fans";
    case "vacuum": return "vacuums";
    case "outlet": return "outlets";
    case "plug": return "plugs";
    case "socket": return "sockets";
    default: return null;
  }
}

function groupStatusSentence(
  label: string,
  states: readonly HaEntityState[],
  plan: CurrentStatusPlan,
  routes: BasicBrainRouteServices,
): string {
  const groupLabel = statusGroupLabel(label, states.length);
  const subject = subjectForStatus(groupLabel);
  const copula = pluralLabel(groupLabel) ? "are" : "is";
  const itemLabels = statusGroupItemLabels(states, routes);
  const rendered = states.map((state) => ({
    label: itemLabels.get(state.entityId) ?? shortFriendlyName(state),
    state: renderedState(state),
  }));
  if (plan.quantifier === "which" && plan.requestedState) {
    const matching = rendered.filter((item) => (
      item.state.normalized !== "unavailable"
      && stateMatches(item.state.normalized, plan.requestedState as string)
    ));
    if (matching.length === 1) {
      const item = matching[0] as (typeof matching)[number];
      return `${capitalize(item.label)} ${pluralLabel(item.label) ? "are" : "is"} ${item.state.text}.`;
    }
    if (matching.length > 1) {
      return `${joinNatural(matching.map((item) => item.label))} are ${plan.requestedState}.`;
    }
    if (rendered.some((item) => item.state.normalized === "unavailable")) {
      return `I can't tell which ${subject} ${copula} ${plan.requestedState}.`;
    }
    return `None of the ${subject} ${copula} ${plan.requestedState}.`;
  }
  const uniqueStates = new Set(rendered.map((item) => item.state.normalized));
  const truth = entityStatusTruth(states, plan);
  if (plan.compareGroupUniformity) {
    const details = rendered.map((item) => `${item.label} ${item.state.text}`).join(", ");
    return uniqueStates.size === 1
      ? `${entityStatusTruthPrefix(truth)}${capitalize(subject)} ${copula} all ${rendered[0]?.state.text ?? "unknown"}.`
      : `${entityStatusTruthPrefix(truth)}${capitalize(subject)} ${copula} mixed: ${details}.`;
  }
  if (uniqueStates.size === 1) {
    const value = rendered[0]?.state.text ?? "unknown";
    if (plan.requestedState) {
      return `${entityStatusTruthPrefix(truth)}${capitalize(subject)} ${copula} all ${value}.`;
    }
    return `${capitalize(subject)} ${copula} all ${value}.`;
  }
  const details = rendered.map((item) => `${item.label} ${item.state.text}`).join(", ");
  if (plan.requestedState) {
    return `${entityStatusTruthPrefix(truth)}${capitalize(subject)} ${copula} mixed: ${details}.`;
  }
  return `${capitalize(subject)} ${copula} mixed: ${details}.`;
}

type EntityStatusTruth = "yes" | "no" | "unknown" | null;

function entityStatusTruth(states: readonly HaEntityState[], plan: CurrentStatusPlan): EntityStatusTruth {
  if (plan.quantifier === "which") {
    return null;
  }
  const unknownCount = states.filter(isUnavailableState).length;
  if (plan.numericComparison) {
    const state = states.length === 1 ? states[0] : null;
    const measurement = state ? numericStatusMeasurement(state, plan) : null;
    if (!measurement || measurement.outcome !== "compatible") {
      return "unknown";
    }
    const matches = plan.numericComparison.operator === "less_than"
      ? measurement.value < plan.numericComparison.threshold
      : measurement.value > plan.numericComparison.threshold;
    return matches ? "yes" : "no";
  }
  if (plan.compareGroupUniformity) {
    const knownStates = new Set(states
      .filter((state) => !isUnavailableState(state))
      .map((state) => renderedState(state).normalized));
    if (knownStates.size > 1) return "no";
    if (unknownCount > 0) return "unknown";
    return states.length > 0 ? "yes" : "unknown";
  }
  if (!plan.requestedState) {
    return null;
  }
  const known = states.filter((state) => !isUnavailableState(state));
  const matchingCount = known.filter((state) => (
    stateMatches(renderedState(state).normalized, plan.requestedState as string)
  )).length;
  if (plan.quantifier === "any") {
    if (matchingCount > 0) return "yes";
    return unknownCount > 0 ? "unknown" : "no";
  }
  if (matchingCount < known.length) return "no";
  return unknownCount > 0 ? "unknown" : "yes";
}

function entityStatusTruthPrefix(truth: EntityStatusTruth): string {
  if (truth === "yes") return "Yes. ";
  if (truth === "no") return "No. ";
  if (truth === "unknown") return "I can't tell yet. ";
  return "";
}

type NumericStatusMeasurement = {
  readonly outcome: "compatible";
  readonly value: number;
  readonly text: string;
  readonly unit: string | null;
  readonly temperatureCompatible: boolean;
};

type NumericStatusAssessment =
  | NumericStatusMeasurement
  | { readonly outcome: "unsupported" }
  | { readonly outcome: "unavailable" };

const NUMERIC_STATUS_DOMAINS = new Set([
  "counter",
  "input_number",
  "number",
  "proximity",
  "sensor",
  "zone",
]);

const NUMERIC_STATUS_DEVICE_CLASSES = new Set([
  "energy",
  "humidity",
  "power",
  "temperature",
]);

function assessNumericStatus(
  states: readonly HaEntityState[],
  plan: CurrentStatusPlan,
): NumericStatusAssessment | null {
  if (!plan.numericComparison) return null;
  if (states.length !== 1) return { outcome: "unsupported" };
  return numericStatusMeasurement(states[0] as HaEntityState, plan);
}

function numericStatusMeasurement(
  state: HaEntityState,
  plan: CurrentStatusPlan,
): NumericStatusAssessment {
  const comparison = plan.numericComparison;
  if (!comparison) return { outcome: "unsupported" };
  if (isUnavailableState(state)) return { outcome: "unavailable" };

  const domain = domainFromEntityId(state.entityId);
  const comparisonRequestsTemperature = comparison.unit === "°C" || comparison.unit === "°F";
  const hasCurrentTemperature = Object.hasOwn(state.attributes, "current_temperature");
  const requestedAttribute = plan.requestedAttribute
    ?? (comparisonRequestsTemperature || hasCurrentTemperature ? "temperature" : null);
  const rawSourceUnit = numericStatusSourceUnit(state, requestedAttribute);
  const sourceUnit = canonicalNumericStatusUnit(rawSourceUnit);
  const temperatureUnit = canonicalNumericTemperatureUnit(sourceUnit);
  const deviceClass = typeof state.attributes.device_class === "string"
    ? targetTextKey(state.attributes.device_class)
    : "";
  const temperatureCompatible = domain === "climate"
    || deviceClass === "temperature"
    || hasCurrentTemperature
    || temperatureUnit !== null;

  let rawValue: unknown;
  if (requestedAttribute === "temperature") {
    if (!temperatureCompatible || temperatureUnit === null) {
      return { outcome: "unsupported" };
    }
    rawValue = hasCurrentTemperature
      ? state.attributes.current_temperature
      : state.state;
  } else {
    const numericSource = NUMERIC_STATUS_DOMAINS.has(domain)
      || NUMERIC_STATUS_DEVICE_CLASSES.has(deviceClass)
      || sourceUnit !== null;
    if (!numericSource) return { outcome: "unsupported" };
    rawValue = state.state;
  }

  if (numericStatusSourceValueUnavailable(rawValue)) return { outcome: "unavailable" };
  const value = numericStatusFiniteValue(rawValue);
  if (value === null) return { outcome: "unsupported" };
  const measurementUnit = temperatureUnit ?? sourceUnit;
  const requestsTemperatureUnit = comparisonRequestsTemperature;
  if (comparison.unit !== null
    && ((requestsTemperatureUnit && requestedAttribute !== "temperature")
      || (!requestsTemperatureUnit && requestedAttribute === "temperature")
      || (requestsTemperatureUnit && !temperatureCompatible)
      || measurementUnit !== comparison.unit)) {
    return { outcome: "unsupported" };
  }
  const rawText = typeof rawValue === "string" ? rawValue.trim() : String(rawValue);
  return {
    outcome: "compatible",
    value,
    text: `${rawText}${measurementUnit ? ` ${measurementUnit}` : ""}`,
    unit: measurementUnit,
    temperatureCompatible,
  };
}

function numericStatusSourceUnit(
  state: HaEntityState,
  requestedAttribute: "temperature" | null,
): string | null {
  const rawUnit = requestedAttribute === "temperature"
    ? state.attributes.temperature_unit ?? state.attributes.unit_of_measurement
    : state.attributes.unit_of_measurement;
  return typeof rawUnit === "string" && rawUnit.trim() ? rawUnit.trim() : null;
}

function canonicalNumericTemperatureUnit(value: string | null): "°C" | "°F" | null {
  return value === "°C" || value === "°F" ? value : null;
}

function numericStatusFiniteValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function numericStatusSourceValueUnavailable(value: unknown): boolean {
  return value === undefined
    || value === null
    || (typeof value === "string"
      && ["unknown", "unavailable"].includes(value.trim().toLowerCase()));
}

function renderedStatusValue(
  state: HaEntityState,
  plan: CurrentStatusPlan,
): { readonly text: string; readonly normalized: string } {
  if (plan.numericComparison) {
    const measurement = numericStatusMeasurement(state, plan);
    if (measurement.outcome === "compatible") {
      return { text: measurement.text, normalized: String(measurement.value) };
    }
  }
  // The garage door is a lock in HA that means the door: it answers in the
  // question's words ("locked?" -> locked), and otherwise as a door (closed/open).
  const requested = plan.requestedState ? targetTextKey(plan.requestedState) : null;
  if (domainFromEntityId(state.entityId) === "lock"
    && isGarageDoorLock(state.entityId, friendlyName(state))
    && (state.state === "locked" || state.state === "unlocked")
    && requested !== "locked" && requested !== "unlocked") {
    return { text: state.state === "locked" ? "closed" : "open", normalized: state.state };
  }
  return renderedState(state);
}

function renderedState(state: HaEntityState): { readonly text: string; readonly normalized: string } {
  if (isUnavailableState(state)) {
    return { text: "unavailable", normalized: "unavailable" };
  }
  const domain = domainFromEntityId(state.entityId);
  const name = targetTextKey(friendlyName(state));
  if (domain === "binary_sensor") {
    const deviceClass = typeof state.attributes.device_class === "string" ? state.attributes.device_class : "";
    if (deviceClass === "door" || deviceClass === "garage_door" || deviceClass === "opening" || deviceClass === "window") {
      return state.state === "on" ? { text: "open", normalized: "open" } : { text: "closed", normalized: "closed" };
    }
    if (deviceClass === "motion" || deviceClass === "occupancy" || /\b(motion|occupancy)\b/.test(name)) {
      return state.state === "on" ? { text: "detected", normalized: "detected" } : { text: "clear", normalized: "clear" };
    }
    if (deviceClass === "connectivity" || /\b(connected|connectivity|online)\b/.test(name)) {
      return state.state === "on" ? { text: "connected", normalized: "connected" } : { text: "disconnected", normalized: "disconnected" };
    }
  }
  if (domain === "input_boolean" && /\barmed\b/.test(name)) {
    return state.state === "on" ? { text: "armed", normalized: "armed" } : { text: "disarmed", normalized: "disarmed" };
  }
  const unit = typeof state.attributes.unit_of_measurement === "string" && state.attributes.unit_of_measurement.trim()
    ? ` ${state.attributes.unit_of_measurement.trim()}`
    : "";
  return {
    text: `${state.state}${unit}`,
    normalized: state.state,
  };
}

function stateMatches(actual: string, requested: string): boolean {
  if (actual === requested) {
    return true;
  }
  if (actual === "detected") {
    return requested === "on" || requested === "active";
  }
  if (actual === "clear") {
    return requested === "off" || requested === "inactive";
  }
  if (actual === "connected") {
    return requested === "on" || requested === "active";
  }
  if (actual === "disconnected") {
    return requested === "off" || requested === "inactive";
  }
  if (actual === "armed") {
    return requested === "on" || requested === "enabled" || requested === "active";
  }
  if (actual === "disarmed") {
    return requested === "off" || requested === "disabled" || requested === "inactive";
  }
  // Only reached for a lock that means a door (the garage): a bolt can't say whether its door is open.
  if (actual === "locked") {
    return requested === "closed";
  }
  if (actual === "unlocked") {
    return requested === "open";
  }
  if (actual === "on") {
    return requested === "enabled" || requested === "active";
  }
  if (actual === "off") {
    return requested === "disabled" || requested === "inactive";
  }
  return false;
}

function stateSupportsRequestedState(state: HaEntityState, requested: string): boolean {
  const normalizedRequested = targetTextKey(
    canonicalStatusRequestedStateForEntityIds(requested, [state.entityId]) ?? requested,
  );
  const domain = domainFromEntityId(state.entityId);
  if (domain === "person" || domain === "device_tracker") {
    return ["home", "not_home", "work", "school"].includes(normalizedRequested);
  }
  const actual = renderedState(state).normalized;
  if (stateMatches(actual, normalizedRequested)) {
    return true;
  }
  switch (actual) {
    case "open":
    case "closed":
      return normalizedRequested === "open" || normalizedRequested === "closed";
    case "locked":
    case "unlocked":
      return normalizedRequested === "locked" || normalizedRequested === "unlocked";
    case "armed":
    case "disarmed":
      return ["armed", "disarmed", "on", "off", "enabled", "disabled", "active", "inactive"].includes(normalizedRequested);
    case "detected":
    case "clear":
      return ["detected", "clear", "on", "off", "active", "inactive"].includes(normalizedRequested);
    case "connected":
    case "disconnected":
      return ["connected", "disconnected", "on", "off", "active", "inactive"].includes(normalizedRequested);
    case "on":
    case "off":
      return ["on", "off", "enabled", "disabled", "active", "inactive"].includes(normalizedRequested);
    default:
      return false;
  }
}

function supportsRequestedStateTargetHint(requested: string): boolean {
  const normalizedRequested = targetTextKey(requested);
  return ["locked", "unlocked", "open", "closed"].includes(normalizedRequested);
}

function statusHintLabel(targetText: string, requestedState: string): string {
  const normalizedRequested = targetTextKey(requestedState);
  return targetText
    .trim()
    .replace(/\s+/g, " ")
    .replace(new RegExp(`\\s+${normalizedRequested}$`, "i"), "");
}

function isGenericPersonTempCollision(state: HaEntityState, normalizedTarget: string): boolean {
  return domainFromEntityId(state.entityId) === "person"
    && targetTextKey(friendlyName(state)) === "temp"
    && /\btemp(?:erature)?\b/.test(normalizedTarget)
    && normalizedTarget !== "temp";
}

/** HA joins device and entity names, so a device whose entity repeats it reads "Robbie Robbie": say it once. */
function undoubledName(name: string): string {
  const words = name.split(/\s+/);
  const half = words.length / 2;
  return Number.isInteger(half) && half > 0 && words.slice(0, half).join(" ") === words.slice(half).join(" ")
    ? words.slice(0, half).join(" ")
    : name;
}

function subjectForStatus(label: string): string {
  return lowerCommonWords(label.trim().replace(/\s+/g, " "));
}

function pluralLabel(label: string): boolean {
  const finalWord = targetTextKey(label).split(/\s+/).at(-1) ?? "";
  return /^(?:people|things|lights|lamps|sensors|switches|locks|doors|windows|blinds|shades|curtains|gates|heaters|fans|vacuums|computers|players|speakers|televisions|tvs|devices|controls|outlets|plugs|sockets)$/.test(finalWord);
}

function domainForWord(word: string): string | null {
  switch (word) {
    case "light":
      return "light";
    case "switch":
      return "switch";
    case "lock":
      return "lock";
    case "sensor":
      return "sensor";
    default:
      return null;
  }
}

function singularDomainWord(value: string): string {
  const clean = normalize(value);
  if (clean === "lights") {
    return "light";
  }
  if (clean === "switches") {
    return "switch";
  }
  if (clean === "locks") {
    return "lock";
  }
  if (clean === "sensors") {
    return "sensor";
  }
  return clean;
}

function pluralDomainWord(value: string): boolean {
  const clean = normalize(value);
  return clean === "lights" || clean === "switches" || clean === "locks" || clean === "sensors";
}

function statusTargetVariants(value: string, requestedState: string | null = null): readonly string[] {
  const normalized = targetTextKey(value);
  const variants = new Set<string>([normalized]);
  if (/\bpower (?:switch|outlet|plug|socket)\b/.test(normalized)) {
    variants.add(normalized.replace(/\bpower (?=(?:switch|outlet|plug|socket)\b)/g, ""));
  }
  if (/\broom\b/.test(normalized)) {
    variants.add(normalized.replace(/\broom\b/g, "bedroom"));
  }
  if (/\bbedroom\b/.test(normalized)) {
    variants.add(normalized.replace(/\bbedroom\b/g, "room"));
  }
  if (/\blighting\b/.test(normalized)) {
    variants.add(normalized.replace(/\blighting\b/g, "lights"));
  }
  if (/\b(?:smaller|secondary|other) lamps?\b/.test(normalized)) {
    variants.add(normalized.replace(/\blamps?\b/g, "light"));
  }
  if (/\blight\b/.test(normalized)) {
    variants.add(normalized.replace(/\blight\b/g, "lights"));
  }
  if (/\bhall\b/.test(normalized)) {
    variants.add(normalized.replace(/\bhall\b/g, "hallway"));
  }
  if (/\bliving room\b/.test(normalized)) {
    variants.add(normalized.replace(/\bliving room\b/g, "lounge"));
  }
  if (/^front lock$/.test(normalized)) {
    variants.add("front door lock");
  }
  if (/^cabinet lights?$/.test(normalized)) {
    variants.add("kitchen cabinet lights");
  }
  if (/^kitchen cabinets?$/.test(normalized)) {
    variants.add("kitchen cabinet lights");
  }
  const outsideLight = /^(.+?) lights? outside$/.exec(normalized);
  if (outsideLight?.[1]) {
    variants.add(`outside ${outsideLight[1]} lights`);
  }
  const smallerLight = /^(?:the )?(?:smaller|secondary|other) (.+?) lights?$/.exec(normalized);
  if (smallerLight?.[1]) {
    variants.add(`${smallerLight[1]} secondary light`);
  }
  if (/^[a-z]+ s lights?$/.test(normalized)) {
    variants.add(normalized.replace(/ lights?$/, " bedroom lights"));
  }
  if (/\boutdoor\b/.test(normalized)) {
    variants.add(normalized.replace(/\boutdoor\b/g, "outside"));
  }
  if (/\boutside\b/.test(normalized)) {
    variants.add(normalized.replace(/\boutside\b/g, "outdoor"));
  }
  if (/^main (.+) (?:light|lights|lighting)$/.test(normalized)) {
    variants.add(normalized.replace(/^main (.+) (?:light|lights|lighting)$/, "$1 main"));
  }
  if (/^(?:on|off)$/.test(requestedState ?? "")) {
    for (const variant of [...variants]) {
      if (!/\b(?:lights?|lighting|lamps?|outlets?|switch(?:es)?|person|door|lock|sensor)\b/.test(variant)) {
        variants.add(`${variant} lights`);
      }
    }
  }
  return [...variants].filter(Boolean);
}

export function liveStateCache(routes: BasicBrainRouteServices): HaStateCache | null {
  const cache = routes.stateCache;
  return cache?.hasReceivedStateSnapshot() ? cache : null;
}

export function guestPersonalStatusDecline(notes: string): BasicResult {
  return withheld("entity_status", notes);
}

function singleStatusSpeechPlan(label: string, state: HaEntityState, plan: CurrentStatusPlan): BasicSpeechRenderPlan {
  const rendered = renderedStatusValue(state, plan);
  const truth = entityStatusTruth([state], plan);
  const polarity = truth === "yes" || truth === "no" ? truth : null;
  return {
    kind: "entity_status_single",
    label,
    state: rendered.text,
    ...(polarity ? { polarity } : {}),
  };
}

function groupStatusSpeechPlan(
  label: string,
  states: readonly HaEntityState[],
  plan: CurrentStatusPlan,
  routes: BasicBrainRouteServices,
): BasicSpeechRenderPlan {
  const itemLabels = statusGroupItemLabels(states, routes);
  const items = states.map((state) => {
    const rendered = renderedState(state);
    return {
      label: itemLabels.get(state.entityId) ?? shortFriendlyName(state),
      state: rendered.text,
    };
  });
  const truth = entityStatusTruth(states, plan);
  const polarity = truth === "yes" || truth === "no" ? truth : null;
  return {
    kind: "entity_status_group",
    label: statusGroupLabel(label, states.length),
    items,
    ...(polarity ? { polarity } : {}),
  };
}

function lightsOnSentence(names: readonly string[]): string {
  if (names.length === 1) {
    return `Yes. One light is on: ${names[0]}.`;
  }
  if (names.length <= 3) {
    return `Yes. ${names.length} lights are on: ${joinNatural(names)}.`;
  }
  const shown = names.slice(0, 3);
  const remaining = names.length - shown.length;
  return `Yes. ${names.length} lights are on: ${joinNatural(shown)}, and ${remaining} more.`;
}

function lightsStateEvidenceSentence(names: readonly string[], state: "on" | "off"): string {
  if (names.length === 1) {
    return `One light is ${state}: ${names[0]}.`;
  }
  return `${names.length} lights are ${state}: ${joinNatural(names)}.`;
}

function lightsStateAffirmationSentence(names: readonly string[], state: "on" | "off"): string {
  return `Yes. ${lightsStateEvidenceSentence(names, state)}`;
}

function lightsFullListSentence(names: readonly string[]): string {
  if (names.length === 1) {
    return `The light on is ${names[0]}.`;
  }
  return `The lights on are: ${joinNatural(names)}.`;
}

function lightsRemainderSentence(names: readonly string[]): string {
  if (names.length === 1) {
    return `The other light is ${names[0]}.`;
  }
  return `The other ${names.length} lights are: ${joinNatural(names)}.`;
}
