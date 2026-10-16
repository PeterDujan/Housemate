/**
 * Device-action owners: the gate for what is on the owner's voice list
 * and the locked decline every other action gets. The switching
 * itself lives in `device-control.ts`.
 */
import type { BasicActionContextReference } from "./basic-context-store.js";
import type { ResolvedTarget } from "./basic-brain-contracts.js";
import type { BasicBrainRouteServices } from "./basic-brain-services.js";
import type { BasicTurnAnalysis } from "./basic-turn-analysis.js";
import {
  applyRoutingExecutionToEntityActionIntent,
  entityActionOperationSupportsDomain,
  classifyDemonstrativeTarget,
  entityActionTargetResolutionVariants,
  entityActionIntentCanResolveTarget,
  hasEntityActionDeviceLanguage,
  isDeicticActionTarget,
  isGenericActionTargetDescriptor,
  parseEntityActionIntent,
  type DemonstrativeTargetReference,
  type EntityActionOperation,
  type EntityActionIntent,
} from "./entity-action-intent.js";
import { parseClimateQuestion, parseClimateRequest, type ClimateMode } from "./climate-request.js";
import { climateActionInput, deviceActionAnswer, deviceActionInput, deviceControlLiveFor, type DeviceActionInput } from "./device-control.js";
import { domainFromEntityId, friendlyName, isUnavailableState, type HaEntityState } from "./ha-state-cache.js";
import { exactTargetDisplayLabel, type TargetResolverMatch } from "./target-resolver.js";
import { normalizeRoutingText, parseRoutingUtterance, routingSemanticsAllowDirectAction, targetTextKey, type RoutingUtterance } from "./routing-text.js";
import {
  actionStateSupportsOperation,
  canonicalEntityStatusLabel,
  contextualReferenceMatchesTarget,
  exactAliasTargetKey,
  isReportableHouseLight,
  liveStateCache,
  resolveExactSourcedTarget,
  resolveExplicitDemonstrativeTarget,
  statusTargetHasUniqueActionProvenance,
} from "./basic-brain-status.js";
import type { AliasEntry } from "./alias-schema.js";
import { capitalize, lowerCommonWords } from "./text-format.js";
import type { Owner, OwnerServices, OwnerTurn } from "./router.js";
import { vacuumAnswer, vacuumEntityId } from "./vacuum-control.js";
import { checkAnswer, isVacuumCheck, parseVacuumRequest, type VacuumRequest } from "./vacuum-request.js";
import { vacuumName } from "./house-config.js";

export function looksLikeAction(normalized: string): boolean {
  const utterance = parseRoutingUtterance(normalized);
  return routingSemanticsAllowDirectAction(utterance.semantics)
    && parseEntityActionIntent(utterance.core) !== null;
}

export function looksLikeEntityActionIntent(
  utterance: RoutingUtterance,
  turnAnalysis: BasicTurnAnalysis,
): boolean {
  const parsedPlan = parseEntityActionIntent(utterance.core);
  const plan = parsedPlan
    ? applyRoutingExecutionToEntityActionIntent(parsedPlan, utterance.semantics.execution)
    : null;
  if (!routingSemanticsAllowDirectAction(utterance.semantics)
    || !plan) {
    return false;
  }
  const hasDeviceLanguage = hasEntityActionDeviceLanguage(plan.targetText);
  const targetReference = classifyDemonstrativeTarget(plan.targetText);
  const evidencePlan = targetReference.kind === "descriptive"
    ? { ...plan, targetText: targetReference.descriptor }
    : plan;
  const hasSourceEvidence = hasSourcedActionOwnershipEvidence(evidencePlan, turnAnalysis);
  if (targetReference.kind === "descriptive"
    && plan.targetEvidence !== "device_control_syntax"
    && !hasSourceEvidence) {
    return false;
  }
  return hasDeviceLanguage
    || isDeicticActionTarget(plan.targetText)
    || plan.targetEvidence === "device_control_syntax"
    || hasSourceEvidence;
}

function hasSourcedActionOwnershipEvidence(
  plan: NonNullable<ReturnType<typeof parseEntityActionIntent>>,
  turnAnalysis: BasicTurnAnalysis,
): boolean {
  const result = turnAnalysis.sources.targets()?.resolve({
    text: plan.targetText,
    includeUnavailable: true,
  });
  const exactMatches = result?.matches.filter((match) => match.reasons.some((reason) => (
    reason.startsWith("exact:")
    || reason.startsWith("alias_exact:entity:")
    || reason.startsWith("alias_exact:group:")
  ))) ?? [];
  const uniqueNamedMatch = result?.confidence === "high" && result.matches.length === 1
    ? result.matches[0] ?? null
    : null;
  return exactMatches.length > 1
    || (exactMatches.length === 1
      && entityActionOperationSupportsDomain(plan.operation, (exactMatches[0] as TargetResolverMatch).domain))
    || (uniqueNamedMatch !== null
      && entityActionOperationSupportsDomain(plan.operation, uniqueNamedMatch.domain));
}

/** The action plan and its execution target, resolved once per turn. */
interface ActionTargets {
  /** The plan, only when it may resolve a target (no deferral or condition). */
  readonly plan: EntityActionIntent | null;
  /** Exact provenance, or the same-session adjacent frame, revalidated. */
  readonly target: ResolvedTarget | null;
  readonly aliases: readonly AliasEntry[];
}

function actionTargets(turn: OwnerTurn, ctx: OwnerServices): ActionTargets {
  return turn.once("actionTargets", () => resolveActionTargets(turn.analysis.routing, ctx.routes, ctx.contextViews.actionTarget, turn.analysis));
}

function resolveActionTargets(
  utterance: RoutingUtterance,
  routes: BasicBrainRouteServices,
  actionContext: BasicActionContextReference | null,
  turnAnalysis: BasicTurnAnalysis,
): ActionTargets {
  const parsedPlan = parseEntityActionIntent(utterance.core);
  const plan = parsedPlan
    ? applyRoutingExecutionToEntityActionIntent(parsedPlan, utterance.semantics.execution)
    : null;
  const actionSourceView = turnAnalysis.sources.targets();
  const actionSourceAliases = turnAnalysis.sources.aliases();
  const demonstrativeReference = classifyDemonstrativeTarget(plan?.targetText ?? "");
  const targetResolvablePlan = plan && entityActionIntentCanResolveTarget(plan) ? plan : null;
  const policyTarget = targetResolvablePlan?.targetScope === "whole_house_lights"
    ? resolveWholeHouseLightActionTarget(targetResolvablePlan, routes)
    : null;
  const exactExclusionTarget = targetResolvablePlan?.assertionEvidence === "root_positive"
    && demonstrativeReference.kind === "underspecified"
    && demonstrativeReference.reason === "exclusion"
    ? resolveExactSourcedTarget(
      targetResolvablePlan.targetText,
      routes,
      { operation: targetResolvablePlan.operation },
      null,
      actionSourceView,
      actionSourceAliases,
    )
    : null;
  const explicitDemonstrativeTarget = targetResolvablePlan
    ? resolveExplicitDemonstrativeTarget(
      targetResolvablePlan.targetText,
      routes,
      { operation: targetResolvablePlan.operation },
      actionSourceView,
      actionSourceAliases,
    )
    : null;
  const resolvedTarget = targetResolvablePlan
    ? policyTarget
      ?? exactExclusionTarget
      ?? explicitDemonstrativeTarget
      ?? (demonstrativeReference.kind === "contextual"
        ? revalidateActionContextTarget(
          targetResolvablePlan,
          actionContext,
          routes,
          demonstrativeReference,
          turnAnalysis,
        )
        : demonstrativeReference.kind === "descriptive" || demonstrativeReference.kind === "underspecified"
          ? null
          : isGenericActionTargetDescriptor(targetResolvablePlan.targetText)
            ? null
            : resolveExactSourcedTarget(
              targetResolvablePlan.targetText,
              routes,
              { operation: targetResolvablePlan.operation },
              null,
              actionSourceView,
              actionSourceAliases,
            ))
    : null;
  const target = targetResolvablePlan && resolvedTarget
    ? revalidateResolvedActionTarget(targetResolvablePlan, resolvedTarget, routes)
    : null;
  return { plan: targetResolvablePlan, target, aliases: actionSourceAliases };
}

/** Whether the turn asks to act on a device ("turn off the kitchen lights"). */
function asksAction(turn: OwnerTurn): boolean {
  return turn.once("asksAction", () => looksLikeEntityActionIntent(turn.analysis.routing, turn.analysis));
}

/**
 * An HVAC request ("set the HVAC to 22", "turn on the heating")
 * from a real household client, through the same gate. Claims only when the
 * words land on exactly one climate device on the voice list.
 */
export const climateControlOwner = {
  id: "climate_control",
  tier: "explicit",
  claim(turn, ctx) {
    if (!deviceControlLiveFor(ctx.routes.deviceControl, turn.request)) return null;
    const climate = parseClimateRequest(turn.analysis.routing.core);
    if (!climate) return null;
    const { analysis } = turn;
    return climateActionInput({
      control: ctx.routes.deviceControl,
      request: turn.request,
      stateCache: ctx.routes.stateCache,
      aliases: analysis.sources.aliases(),
      principal: analysis.principal,
      climate,
      resolve: (text) => resolveExactSourcedTarget(text, ctx.routes, {}, null, analysis.sources.targets(), analysis.sources.aliases()),
      adjacent: ctx.contextViews.actionTarget?.target ?? null,
      adjacentMode: previousClimateMode(turn),
    });
  },
  answer: (input) => deviceActionAnswer(input),
} satisfies Owner<DeviceActionInput>;

/**
 * The mode the previous turn named ("is the aircon on?"), so "turn it on"
 * means the aircon, not whatever mode the HVAC last ran.
 */
function previousClimateMode(turn: OwnerTurn): ClimateMode | null {
  const previous = turn.conversationTurns.at(-1)?.transcript;
  if (!previous) return null;
  const core = parseRoutingUtterance(normalizeRoutingText(previous)).core;
  return (parseClimateQuestion(core) ?? parseClimateRequest(core))?.targetMode ?? null;
}

/** A yes or no counts only right after the check it answers. */
const VACUUM_CHECK_WINDOW_MS = 120_000;

type VacuumClaim = { readonly request: VacuumRequest; readonly confirmed: boolean } | { readonly cancelled: true };

/**
 * The vacuum by voice, through the vacuum's own queue. Claims a
 * vacuum request, or a yes or no right after one of its checks; a yes runs the
 * turn before it again, parsed afresh, without the check. Anything else after a
 * check drops it. The gate, the call and the reply are `vacuum-control.ts`.
 */
export const vacuumControlOwner = {
  id: "vacuum_control",
  tier: "explicit",
  claim(turn, ctx) {
    const { vacuumQueue: queue, deviceControl } = ctx.routes;
    if (!queue || !deviceControl) return null;
    const rooms = queue.rooms();
    const names = turn.analysis.sources.aliases()
      .filter((entry) => entry.target.kind === "entity" && entry.target.entityId === vacuumEntityId())
      .map((entry) => entry.alias);
    const previous = turn.conversationTurns.at(-1);
    const answer = previous && isVacuumCheck(previous.responseText) && ctx.now().getTime() - previous.timestampMs <= VACUUM_CHECK_WINDOW_MS
      ? checkAnswer(turn.analysis.routing.core)
      : null;
    if (answer === "no") return { cancelled: true };
    if (answer === "yes" && previous) {
      const asked = parseVacuumRequest(parseRoutingUtterance(normalizeRoutingText(previous.transcript)).core, rooms, names);
      if (asked) return { request: asked, confirmed: true };
    }
    const request = parseVacuumRequest(turn.analysis.routing.core, rooms, names);
    return request ? { request, confirmed: false } : null;
  },
  answer(claim, { turn, routes, now }) {
    const { vacuumQueue: queue, deviceControl: control } = routes;
    if (!queue || !control) return null;
    if ("cancelled" in claim) {
      return { route: "entity_action", status: "ok", confidence: "high", text: `Okay, I'll leave ${vacuumName()} be.`, modelUsed: false, resultId: null, touchedEntities: [], notes: "vacuum: check answered no" };
    }
    return vacuumAnswer({
      control,
      queue,
      stateCache: routes.stateCache,
      principal: turn.analysis.principal,
      request: claim.request,
      confirmed: claim.confirmed,
      quietHours: routes.houseState?.snapshot(now()).activity.quietHoursActive ?? true,
      live: deviceControlLiveFor(control, turn.request),
    });
  },
} satisfies Owner<VacuumClaim>;

/** An exact target from a real household client goes through the one gate. */
export const deviceControlOwner = {
  id: "device_control",
  tier: "explicit",
  claim(turn, ctx) {
    if (!asksAction(turn) || !deviceControlLiveFor(ctx.routes.deviceControl, turn.request)) return null;
    const { plan, target, aliases } = actionTargets(turn, ctx);
    return deviceActionInput({
      control: ctx.routes.deviceControl,
      request: turn.request,
      stateCache: ctx.routes.stateCache,
      plan,
      target,
      aliases,
      principal: turn.analysis.principal,
    });
  },
  answer: (input) => deviceActionAnswer(input),
} satisfies Owner<DeviceActionInput>;

/** Every other device action: declined, naming the target when it is grounded. */
export const lockedActionOwner = {
  id: "locked_action",
  tier: "safety",
  claim: (turn, ctx) => (asksAction(turn) ? actionTargets(turn, ctx) : null),
  answer({ plan, target }, ctx) {
    const { routes } = ctx;
    // A locked decline may name a uniquely grounded current target without
    // promoting that weaker mention proof into execution authority.
    const mentionTarget = target ?? (plan
      ? resolveDirectActionMentionTarget(plan, ctx.turn.analysis, routes)
      : null);
    const targetState = mentionTarget?.entityIds.length === 1
      ? routes.stateCache?.get(mentionTarget.entityIds[0] as string) ?? null
      : null;
    const named = targetState
      ? canonicalEntityStatusLabel(targetState, mentionTarget?.label ?? friendlyName(targetState))
      : mentionTarget?.label ?? null;
    // Mid-sentence: "front door lock", "plug 11", "HVAC".
    const targetLabel = named === null ? null : lowerCommonWords(named);
    // Control is on for this client, but the gate had no exact target to act on.
    if (deviceControlLiveFor(routes.deviceControl, ctx.turn.request)) {
      return {
        route: "entity_action",
        status: "declined",
        confidence: "medium",
        text: targetState && isUnavailableState(targetState)
          ? `${capitalize(targetLabel ?? "")} isn't responding right now, so I didn't touch it.`
          : targetLabel
            ? `Did you mean ${targetLabel}? Say it by name and I'll do it. I didn't touch anything.`
            : "I'm not sure which device you mean, so I didn't touch anything.",
        modelUsed: false,
        resultId: null,
        touchedEntities: [],
        notes: mentionTarget
          ? `action declined; ${mentionTarget.source} mention target without an exact execution target`
          : "action declined; no exact target",
      };
    }
    return {
      route: "entity_action",
      status: "declined",
      confidence: mentionTarget ? "high" : "medium",
      text: targetLabel
        ? `I've got ${targetLabel}, but device control is still locked. I didn't touch anything.`
        : "Device control is still locked, so I didn't touch anything.",
      modelUsed: false,
      resultId: null,
      touchedEntities: [],
      notes: target
        ? `action declined; exact ${target.source} execution target matched`
        : mentionTarget
          ? `action declined; ${mentionTarget.source} mention target grounded without execution authority`
          : "action declined; no exact target required in reset mode",
    };
  },
} satisfies Owner<ActionTargets>;

function resolveDirectActionMentionTarget(
  plan: NonNullable<ReturnType<typeof parseEntityActionIntent>>,
  analysis: BasicTurnAnalysis,
  routes: BasicBrainRouteServices,
): ResolvedTarget | null {
  const reference = classifyDemonstrativeTarget(plan.targetText);
  const directDefiniteDescriptor = reference.kind === "contextual"
    && /^the\b/i.test(plan.targetText.trim())
    ? reference.descriptor
    : null;
  // Pronouns and demonstratives remain provenance-bearing references. A
  // definite noun phrase ("the garage") may use the mention-only lane, but
  // still cannot become execution authority.
  if (reference.kind !== "none" && !directDefiniteDescriptor) return null;
  const descriptor = directDefiniteDescriptor ?? plan.targetText;
  const sourceView = analysis.sources.targets();
  if (!sourceView) return null;
  const descriptorVariants = entityActionTargetResolutionVariants(descriptor);
  const genericDescriptor = isGenericActionTargetDescriptor(descriptor);

  const exactTargets = genericDescriptor
    ? []
    : descriptorVariants.flatMap((variant) => {
      const exact = resolveExactSourcedTarget(
        variant,
        routes,
        {},
        null,
        sourceView,
        analysis.sources.aliases(),
      );
      return exact && actionMentionTargetIsGrounded(exact, plan.operation, analysis, routes)
        ? [exact]
        : [];
    });
  const uniqueExactTargets = uniqueResolvedTargets(exactTargets);
  if (uniqueExactTargets.length === 1) return uniqueExactTargets[0] ?? null;
  if (uniqueExactTargets.length > 1) return null;
  const declaredExactAliases = analysis.sources.aliases().filter((alias) => (
    descriptorVariants.some((variant) => (
      exactAliasTargetKey(alias.normalizedAlias) === exactAliasTargetKey(variant)
    ))
  ));
  if (declaredExactAliases.length > 0) return null;

  const rankedTargets = descriptorVariants.flatMap((variant) => {
    const result = sourceView.resolve({ text: variant, includeUnavailable: true });
    if (!(result.confidence === "high" || result.confidence === "medium") || result.matches.length !== 1) {
      return [];
    }
    const match = result.matches[0];
    const state = match ? routes.stateCache?.get(match.entityId) ?? null : null;
    if (!match || !state) return [];
    if (genericDescriptor && match.reasons.some((reason) => reason.startsWith("alias_exact:"))) {
      return [];
    }
    const genericNamesExactArea = genericDescriptor
      && match.areaName !== null
      && exactAliasTargetKey(variant) === exactAliasTargetKey(match.areaName);
    if (genericDescriptor
      && entityActionOperationSupportsDomain(plan.operation, match.domain)
      && !genericNamesExactArea) {
      return [];
    }
    const target: ResolvedTarget = {
      label: genericDescriptor
        ? friendlyName(state)
        : exactTargetDisplayLabel(variant, friendlyName(state), match),
      entityIds: [match.entityId],
      source: "inferred",
    };
    return actionMentionTargetIsGrounded(target, plan.operation, analysis, routes) ? [target] : [];
  });
  const uniqueRankedTargets = uniqueResolvedTargets(rankedTargets);
  return uniqueRankedTargets.length === 1 ? uniqueRankedTargets[0] ?? null : null;
}

function uniqueResolvedTargets(targets: readonly ResolvedTarget[]): readonly ResolvedTarget[] {
  const byEntityIds = new Map<string, ResolvedTarget>();
  for (const target of targets) {
    const key = [...new Set(target.entityIds)].sort().join("\u0000");
    if (!byEntityIds.has(key)) byEntityIds.set(key, target);
  }
  return [...byEntityIds.values()];
}

function actionMentionTargetIsGrounded(
  target: ResolvedTarget,
  operation: EntityActionOperation,
  analysis: BasicTurnAnalysis,
  routes: BasicBrainRouteServices,
): boolean {
  if (target.entityIds.length !== 1) return false;
  const states = target.entityIds
    .map((entityId) => routes.stateCache?.get(entityId) ?? null)
    .filter((state): state is HaEntityState => state !== null);
  if (states.length !== target.entityIds.length) return false;
  if (states.every((state) => entityActionOperationSupportsDomain(operation, domainFromEntityId(state.entityId)))) {
    return true;
  }
  // Registry-backed device facets may identify the physical target for the
  // wording of a locked decline even when the status facet is not actionable.
  // A state-only alias is insufficient for that weaker physical-device claim.
  const registry = analysis.sources.registryTargets();
  return registry !== null && states.every((state) => {
    if (registry.entity(state.entityId) === null) return false;
    const deviceClass = typeof state.attributes.device_class === "string"
      ? state.attributes.device_class.trim().toLowerCase()
      : "";
    return (operation === "open" || operation === "close")
      && domainFromEntityId(state.entityId) === "binary_sensor"
      && ["door", "garage_door", "opening", "window"].includes(deviceClass);
  });
}

function resolveWholeHouseLightActionTarget(
  plan: NonNullable<ReturnType<typeof parseEntityActionIntent>>,
  routes: BasicBrainRouteServices,
): ResolvedTarget | null {
  const cache = liveStateCache(routes);
  if (!cache) return null;
  const states = cache.entries().filter(isReportableHouseLight);
  if (states.length === 0
    || states.some((state) => isUnavailableState(state) || !actionStateSupportsOperation(plan.operation, state))) {
    return null;
  }
  return {
    label: "house lights",
    entityIds: states.map((state) => state.entityId).sort((left, right) => left.localeCompare(right)),
    source: "inferred",
  };
}

function revalidateActionContextTarget(
  plan: NonNullable<ReturnType<typeof parseEntityActionIntent>>,
  reference: BasicActionContextReference | null,
  routes: BasicBrainRouteServices,
  targetReference: Extract<DemonstrativeTargetReference, { readonly kind: "contextual" }>,
  turnAnalysis: BasicTurnAnalysis,
): ResolvedTarget | null {
  if (!reference?.revalidateBeforeUse) {
    return null;
  }
  if (reference.targetAcquisition === "explicit"
    && (!reference.sourceQuery
      || !statusTargetHasUniqueActionProvenance(reference.target, reference.sourceQuery, turnAnalysis))) {
    return null;
  }
  if (reference.targetAcquisition === "clarified"
    && !clarifiedStatusTargetStillResolves(reference.target, turnAnalysis)) {
    return null;
  }
  return contextualReferenceMatchesTarget(targetReference, reference.target, routes)
    ? revalidateResolvedActionTarget(plan, reference.target, routes)
    : null;
}

function clarifiedStatusTargetStillResolves(
  target: ResolvedTarget,
  analysis: BasicTurnAnalysis,
): boolean {
  if (target.entityIds.length !== 1) return false;
  const entityId = target.entityIds[0] as string;
  const current = analysis.sources.capabilities()?.entity(entityId) ?? null;
  if (!current || (!current.areaName && !current.deviceName)) return false;
  const base = current.friendlyName ?? entityId;
  const currentLabel = current.areaName
    ? `${base} in ${current.areaName}`
    : `${base} on ${current.deviceName}`;
  return targetTextKey(currentLabel) === targetTextKey(target.label);
}

function revalidateResolvedActionTarget(
  plan: NonNullable<ReturnType<typeof parseEntityActionIntent>>,
  target: ResolvedTarget,
  routes: BasicBrainRouteServices,
): ResolvedTarget | null {
  const cache = liveStateCache(routes);
  if (target.entityIds.length === 0 || !cache) {
    return null;
  }
  const states = target.entityIds
    .map((entityId) => cache.get(entityId))
    .filter((state): state is HaEntityState => state !== null);
  if (states.length !== target.entityIds.length
    || !states.every((state) => !isUnavailableState(state) && actionStateSupportsOperation(plan.operation, state))) {
    return null;
  }
  return target;
}
