/**
 * Entity-status owners: device and person state, place readings,
 * house lights, entity identity and inventory, claimed from their own words
 * and followed up on the status, lights and clarifier frames. The answers
 * themselves live in `basic-brain-status.ts`.
 */
import {
  clarify,
  declined,
  ok,
  declinedReadFallback,
  withReadFallback,
  type BasicContextFrame,
  type BasicResult,
  type PendingClarifierChoice,
  type PendingClarifierFrame,
  type PendingClarifierFreeform,
  type ResolvedTarget,
  type EntityStatusTargetAcquisition,
  type BasicConversationTurn,
  type CurrentStatusPlan,
} from "./basic-brain-contracts.js";
import type { BasicBrainRouteServices } from "./basic-brain-services.js";
import type { BasicTurnAnalysis } from "./basic-turn-analysis.js";
import {
  currentMetricAnswer,
  defaultMetricById,
  dynamicMetricAnswer,
  hasMetricTimeWindow,
  historyMetricAnswer,
  resolveMetricQuestion,
  resolveFollowUpMetricTarget,
} from "./basic-brain-metrics.js";
import { calendarClarifierChoiceAnswer } from "./basic-brain-schedule.js";
import { shortFriendlyName, friendlyName, type HaEntityState } from "./ha-state-cache.js";
import { buildEntityLocationPrivacyContext, isSensitiveLocationEntity, PERSON_LOCATION_FIELD_PATTERN_SOURCE } from "./entity-status-privacy.js";
import { looksLikeGlobalLightsStatus } from "./house-lights-status-intent.js";
import { isGuestSpeakerRequest } from "./speaker-principal.js";
import type { VoiceBrainRequest } from "./voice-brain.js";
import { resolveUnsupportedMathPrompt, resolveScalarCalculation } from "./scalar-calculator.js";
import {
  normalizeMeasuredRoutingText as normalize,
  targetTextKey,
  extractExplicitReadRequestObject,
  routingSemanticsAllowCurrentStatus,
  routingSemanticsAllowReadOnlyToolUse,
} from "./routing-text.js";
import {
  FOLLOW_UP_FRAGMENT_MAX_WORDS,
  INDOOR_PATTERN,
  OUTDOOR_PATTERN,
  stripStatusFiller,
  FOLLOW_UP_OPENER_PATTERN,
  COMPARATOR_WORD,
} from "./lexicon.js";
import { capitalize, joinAlternatives, lowerCommonWords, spokenWordCount } from "./text-format.js";
import { basicScalarCalculationAnswer, asksMemory, fixedReply, sourceRead } from "./stateless-owners.js";
import type { WikipediaKnowledgeStore } from "./wikipedia-knowledge-store.js";
import {
  PLACE_READING_TAIL,
  entityStatus,
  guestPersonalStatusDecline,
  houseLightsStatus,
  inferHouseFactAnswer,
  looksLikeExplicitStatusTargetObject,
  parseCurrentStatusPlan,
  statusAnswerFromPlan,
  classifiedStatusFollowUpReference,
  contextualReferenceMatchesTarget,
  houseLightFocusSupportsRequestedState,
  houseLightFocusSupportsStatusPlan,
  houseLightsListFollowUpAnswer,
  looksLikePronounStatusFollowUp,
  matchingStatusChangeFrame,
  outsideTemperatureStatusTarget,
  parseContextualStatusRestatement,
  requestedStateForStatusTarget,
  resolveExactExclusionStatusTarget,
  resolveExplicitDemonstrativeTarget,
  resolveFollowUpStatusTarget,
  resolveFreshStatusChangeTarget,
  resolveStatusTarget,
  resolveStatusTargetWithClarifier,
  statusAcquisitionEvidence,
  statusChangeFollowUpTarget,
  looksLikeHouseFact,
  normalizedStatusReferenceTokens,
  resolveDirectEntityIdentity,
  uniqueStatusTargetEntry,
  challengedHouseFactQuestionText,
  houseEntityInventoryAnswer,
  houseEntityInventoryDomain,
  inferOutsideTemperatureStatusTarget,
  isSourceBackedPersonalLocatorTarget,
  looksLikeStatusChangeFollowUp,
  resolveExactSourcedTarget,
  resolveExactTarget,
  resolveReservedPersonStatusTarget,
  type CurrentStatusResolution,
} from "./basic-brain-status.js";
import {
  wikipediaDiagnosticsNote,
  wikipediaKnowledgeResult,
  entityLinkedKnowledgeQuestion,
  directEntityLinkedKnowledgeQuestion,
  exactTargetLooksLikeKnowledgeTitleCollision,
  preferHouseFallback,
  type FallbackRouteEvidence,
} from "./basic-brain-knowledge.js";
import {
  looksLikeBasicFollowUp,
  looksLikeStandaloneRestatedRequest,
  NOT_FOLLOW_UP,
  declinedContextReference,
  followUpSteps,
  hasPronounFollowUp,
  houseLightMembershipTarget,
  isGenericFollowUpTargetReference,
  looksLikeCorrectionFollowUp,
  looksLikeExplicitHouseLightsFocusReturn,
  type FollowUpTurn,
} from "./follow-up-turn.js";
import type { OwnerServices, Owner, OwnerTurn } from "./router.js";
import { looksLikeClarifierReply, resolvePendingClarifierChoice, resolvePendingClarifierRepair } from "./basic-brain-clarifiers.js";
import { classifyDemonstrativeTarget, demonstrativeActionTargetDescriptor } from "./entity-action-intent.js";
import { metricFollowUpPrompt } from "./energy-owners.js";
import {
  parseEntityStatusPredicateFollowUp,
  cleanTargetText,
  bareDeviceStatusTargetText,
  parseStandaloneEntityStatusIntent,
  parseTimeQualifiedEntityStatusIntent,
} from "./entity-status-intent.js";
import { resolveStandaloneEntityStatusTarget } from "./entity-status-resolution.js";
import { parsePastReading, pastReadingAnswer, type PastReadingAsk, type PastReadingRefusal } from "./house-past-reading.js";
import type { BasicContextViews } from "./basic-context-store.js";
import { labelsEquivalent } from "./target-index.js";
import { DEFAULT_TIMEZONE } from "./basic-brain-open-chat.js";
import { looksLikeAction } from "./action-owners.js";
import { parseClimateQuestion } from "./climate-request.js";
import { climateQuestionAnswer, climateQuestionTarget } from "./climate-status.js";
import { explicitLocalSourceScope, fallbackEvidence, strongHouseCandidate } from "./knowledge-owners.js";

type FreeformClarifierResolution =
  | { readonly kind: "reply_as_fresh_request" }
  | { readonly kind: "resolved"; readonly result: BasicResult };

export function resolvedEntityIdentityAnswer(
  target: ResolvedTarget,
  routes: BasicBrainRouteServices,
  request: VoiceBrainRequest,
): BasicResult {
  if (isGuestSpeakerRequest(request) && entityIdentityIdsAreSensitive(target.entityIds, routes)) {
    return guestPersonalStatusDecline("guest mode blocked personal entity identity disclosure");
  }
  const sourceStates = target.entityIds
    .map((entityId) => routes.stateCache?.get(entityId) ?? null)
    .filter((state): state is HaEntityState => state !== null);
  const label = sourceStates.length === 1
    ? shortFriendlyName(sourceStates[0] as HaEntityState)
    : target.label;
  const responseText = target.entityIds.length === 1
    ? `${label} is Home Assistant entity ${target.entityIds[0] as string}.`
    : `${label} is a Home Assistant group containing ${target.entityIds.length} entities.`;
  return {
    ...ok(
      "entity_status",
      responseText,
      "entity identity resolved from Home Assistant metadata",
      { kind: "entity_status", target: { ...target, label } },
    ),
    // Metadata explanations must not create fresh adjacent-action authority.
    entityStatusTargetAcquisition: "contextual",
  };
}

export function entityIdentityIdsAreSensitive(
  entityIds: readonly string[],
  routes: BasicBrainRouteServices,
): boolean {
  const privacy = buildEntityLocationPrivacyContext({
    registry: routes.registry,
    states: routes.stateCache?.entries() ?? [],
    aliases: routes.aliases ?? [],
  });
  return entityIds.some((entityId) => isSensitiveLocationEntity(
    entityId,
    routes.stateCache?.get(entityId) ?? null,
    privacy.labelsForEntity(entityId),
    privacy.knownPersonLabels,
  ));
}

export function alternateClarifierTargetText(normalized: string): string | null {
  if (!/\b(?:instead|rather than)\b/.test(normalized)) {
    return null;
  }
  const raw = normalized
    .replace(/^(?:try|check|use|show me|tell me about|what about|how about)\s+/, "")
    .replace(/\s+(?:instead|rather than(?:\s+.+)?)$/, "")
    .trim();
  const target = normalizeExplicitTargetText(raw);
  return target && looksLikeExplicitStatusTargetObject(target) ? target : null;
}

function missingContextClarifierResult(targetHint: string | null): BasicResult {
  const cleanTarget = targetHint && !/^(?:that|it|this|they)$/.test(targetHint) ? targetHint : null;
  const prompt = cleanTarget
    ? `What do you want to know about ${cleanTarget}?`
    : "What do you want me to attach that to?";
  const freeform: PendingClarifierFreeform = cleanTarget
    ? { kind: "follow_up_target", targetHint: cleanTarget }
    : { kind: "missing_context" };
  return clarify("open_conversation", prompt, "follow-up asked without compatible context; requested a full repair", {
    kind: "clarifier",
    route: "open_conversation",
    prompt,
    choices: [],
    freeform,
  });
}

export function unresolvedFollowUpTargetResult(targetHint: string | null): BasicResult | null {
  const target = targetHint?.trim() ?? "";
  // A long hint is a statement, not a missed target: leave it to open chat rather than parrot it back.
  if (spokenWordCount(target) > FOLLOW_UP_FRAGMENT_MAX_WORDS) {
    return null;
  }
  if (target && looksLikeExplicitStatusTargetObject(target)) {
    return declined(
      "entity_status",
      "I can't see a matching device for that.",
      `explicit follow-up device target could not be resolved: ${target}`,
    );
  }
  return missingContextClarifierResult(targetHint);
}

export async function resolveFreeformClarifierReply(
  normalized: string,
  transcript: string,
  clarifierFrame: PendingClarifierFrame,
  routes: BasicBrainRouteServices,
  now: () => Date,
  request: VoiceBrainRequest,
  turnAnalysis: BasicTurnAnalysis,
): Promise<FreeformClarifierResolution> {
  const freeform = clarifierFrame.freeform;
  if (!freeform) {
    return { kind: "reply_as_fresh_request" };
  }
  if (freeform.kind === "missing_context") {
    if (looksLikeBasicFollowUp(normalized)) {
      return {
        kind: "resolved",
        result: declined(
          "open_conversation",
          "I still need the full question, not another dangling follow-up.",
          "freeform repair reply stayed context-dependent without a restated request",
        ),
      };
    }
    return { kind: "reply_as_fresh_request" };
  }
  if (freeform.kind === "entity_identity_exact_id") {
    const entityId = exactEntityIdClarifierReply(transcript);
    if (entityId && freeform.entityIds.includes(entityId)) {
      const state = routes.stateCache?.get(entityId) ?? null;
      const registry = routes.registry?.entity(entityId) ?? null;
      const label = state
        ? shortFriendlyName(state)
        : registry?.name
          ?? registry?.originalName
          ?? entityId.slice(entityId.indexOf(".") + 1).replaceAll("_", " ");
      return {
        kind: "resolved",
        result: resolvedEntityIdentityAnswer({
          label,
          entityIds: [entityId],
          source: "entity_id",
        }, routes, request),
      };
    }
    if (looksLikeStandaloneRestatedRequest(normalized)) {
      return { kind: "reply_as_fresh_request" };
    }
    return {
      kind: "resolved",
      result: clarify(
        clarifierFrame.route,
        clarifierFrame.prompt,
        entityId
          ? "exact entity ID reply was not a member of the pending identity ambiguity"
          : "large entity identity ambiguity still needs one exact candidate ID",
        clarifierFrame,
      ),
    };
  }
  const targetHint = freeform.targetHint?.trim() ?? "";
  const resolved = await resolveTargetedClarifierReply(
    targetHint,
    transcript,
    routes,
    now,
    request,
    turnAnalysis,
  );
  if (resolved) {
    return { kind: "resolved", result: resolved };
  }
  if (looksLikeStandaloneRestatedRequest(normalized)) {
    return { kind: "reply_as_fresh_request" };
  }
  return {
    kind: "resolved",
    result: declined(
      "open_conversation",
      `I still need the actual question about ${targetHint}.`,
      "freeform target repair reply did not restate a resolvable request",
    ),
  };
}

function exactEntityIdClarifierReply(transcript: string): string | null {
  const match = /^(?:(?:use|choose|select|pick)\s+|(?:the\s+)?(?:entity|entity id)\s+(?:is\s+)?)?([a-z_][a-z0-9_]*\.[a-z0-9_]+)(?:\s+please)?[.!?]*$/i.exec(
    transcript.trim(),
  );
  return match?.[1]?.toLowerCase() ?? null;
}

async function resolveTargetedClarifierReply(
  targetHint: string,
  transcript: string,
  routes: BasicBrainRouteServices,
  now: () => Date,
  request: VoiceBrainRequest,
  turnAnalysis: BasicTurnAnalysis,
): Promise<BasicResult | null> {
  const candidates = targetedClarifierReplyCandidates(targetHint, transcript);
  for (const candidate of candidates) {
    const result = await resolveExplicitFollowUpQuestion(candidate, routes, now, request, turnAnalysis);
    if (result) {
      return result;
    }
  }
  return null;
}

function targetedClarifierReplyCandidates(targetHint: string, transcript: string): readonly string[] {
  const normalizedTarget = targetTextKey(targetHint);
  const normalizedReply = normalize(transcript);
  if (!normalizedTarget || !normalizedReply) {
    return [];
  }
  const candidates = [
    rewriteTargetedPronounReply(normalizedReply, normalizedTarget),
    `${normalizedTarget} ${normalizedReply}`,
    `${normalizedReply} ${normalizedTarget}`,
  ].filter((candidate): candidate is string => Boolean(candidate));
  return [...new Set(candidates)];
}

function rewriteTargetedPronounReply(reply: string, targetHint: string): string | null {
  if (!/\b(?:it|that|this|they)\b/.test(reply)) {
    return null;
  }
  const leadingPronoun = /^((?:is|are|was|were|do|does|did|what|what s|whats|which|where|how much)\s+)(?:it|that|this|they)\b/.exec(reply);
  if (leadingPronoun) {
    return reply.replace(leadingPronoun[0], `${leadingPronoun[1]}${targetHint}`);
  }
  const replaced = reply.replace(/\b(?:it|that|this|they)\b/, targetHint);
  return replaced === reply ? null : replaced;
}

export async function resolveExplicitFollowUpQuestion(
  normalizedQuestion: string,
  routes: BasicBrainRouteServices,
  now: () => Date,
  request: VoiceBrainRequest,
  turnAnalysis: BasicTurnAnalysis,
): Promise<BasicResult | null> {
  const unsupportedMath = resolveUnsupportedMathPrompt(normalizedQuestion);
  if (unsupportedMath) {
    return declined("calculation", unsupportedMath, "unsupported math follow-up blocked before knowledge fallback");
  }
  const scalarCalculation = resolveScalarCalculation(normalizedQuestion);
  if (scalarCalculation) {
    return basicScalarCalculationAnswer(scalarCalculation);
  }
  const dynamicMetric = await dynamicMetricAnswer(normalizedQuestion, normalizedQuestion, routes, now);
  if (dynamicMetric) {
    return dynamicMetric;
  }
  const metric = resolveMetricQuestion(normalizedQuestion);
  if (metric) {
    if (hasMetricTimeWindow(normalizedQuestion)) {
      return historyMetricAnswer(metric, normalizedQuestion, normalizedQuestion, routes, now);
    }
    return currentMetricAnswer(metric, normalizedQuestion, routes)
      ?? declined("time_window_math", "I matched that metric, but the time-window calculation path is not wired yet, so I will not guess.", `metric explicit follow-up matched: ${metric.id}; metric question blocked before current status or model fallback`);
  }

  const queryPlan = parseCurrentStatusPlan(normalizedQuestion);
  if (queryPlan?.intent === "current_status") {
    return statusAnswerFromPlan(queryPlan, routes, now, request, turnAnalysis);
  }
  if (looksLikeGlobalLightsStatus(normalizedQuestion)) {
    return houseLightsStatus(routes, normalizedQuestion);
  }
  const inferred = await inferHouseFactAnswer(normalizedQuestion, routes, now, request);
  if (inferred) {
    return inferred;
  }
  return null;
}

/**
 * "What about inside?" after a temperature or humidity answer asks the same
 * reading in a new place. The place is resolved by the standalone
 * place-reading path, so only a source-backed reading answers.
 */
export async function carriedPlaceReading(
  place: string,
  reading: "temperature" | "humidity",
  statusFrame: Extract<BasicContextFrame, { kind: "entity_status" }> | null,
  routes: BasicBrainRouteServices,
  now: () => Date,
  request: VoiceBrainRequest,
  turnAnalysis: BasicTurnAnalysis,
): Promise<BasicResult | null> {
  if (PLACE_READING_TAIL.test(place)) return null;
  const plan = parseCurrentStatusPlan(`what is the ${place} ${reading}`);
  if (plan?.intent !== "current_status") return null;
  const result = await statusAnswerFromPlan(plan, routes, now, request, turnAnalysis);
  if (result?.status === "ok") return result;
  // A bare place with no such reading gets an honest no, not some other
  // device that happens to share the room's name.
  if (!OPEN_AIR_PLACE.test(place) && !INDOOR_PLACE.test(place) && routes.registry?.areaNamed(place) == null) return null;
  const decline: BasicResult = {
    ...declined("entity_status", `I can't see a ${reading} reading for ${spokenPlace(place)}.`, `carried ${reading} reading has no source for ${place}`),
    readFallback: { eligible: false, reason: "source_final" },
  };
  // The talk is still about that reading, so the next place swap keeps it.
  return statusFrame ? { ...decline, contextFrame: statusFrame, entityStatusTargetAcquisition: "contextual" } : decline;
}

export const OPEN_AIR_PLACE = new RegExp(`^${OUTDOOR_PATTERN}$`);

const INDOOR_PLACE = new RegExp(`^${INDOOR_PATTERN}$`);

function spokenPlace(place: string): string {
  return OPEN_AIR_PLACE.test(place) || INDOOR_PLACE.test(place) ? place : `the ${place.replace(/^the\s+/, "")}`;
}

export function frameReading(
  frame: Extract<BasicContextFrame, { kind: "entity_status" }>,
  routes: BasicBrainRouteServices,
): "temperature" | "humidity" | null {
  const named = PLACE_READING_TAIL.exec(targetTextKey(frame.target.label))?.[0];
  if (named) return named === "humidity" ? "humidity" : "temperature";
  const classes = new Set(frame.target.entityIds.map((entityId) => routes.stateCache?.get(entityId)?.attributes.device_class));
  if (classes.size !== 1) return null;
  const [deviceClass] = classes;
  return deviceClass === "temperature" || deviceClass === "humidity" ? deviceClass : null;
}

function normalizeExplicitTargetText(value: string): string | null {
  const target = stripStatusFiller(normalize(value))
    .replace(/\b(?:the|my)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return target || null;
}

export function staleClarifierReply(frame: PendingClarifierFrame): BasicResult {
  return declined(
    frame.route,
    "I've already used that clarification. Ask me again if you meant something else.",
    "pending clarifier was claimed by a newer admitted reply",
  );
}

export async function resolveClarifiedChoice(
  choice: PendingClarifierChoice,
  routes: BasicBrainRouteServices,
  request: VoiceBrainRequest,
  now: Date,
  wikipediaKnowledge: WikipediaKnowledgeStore,
  turnId: string,
): Promise<BasicResult> {
  switch (choice.action.kind) {
    case "entity_status": {
      const target: ResolvedTarget = {
        label: choice.action.targetLabel,
        entityIds: choice.action.entityIds,
        source: choice.action.source,
      };
      if (choice.action.responseKind === "entity_identity") {
        return resolvedEntityIdentityAnswer(target, routes, request);
      }
      return entityStatus({
        ...target,
      }, routes, {
        intent: "current_status",
        targetText: choice.action.targetLabel,
        requestedState: choice.action.requestedState,
        questionType: choice.action.questionType,
        source: "aliases_or_live_state",
      }, request, { acquisition: "clarified" });
    }
    case "calendar_event":
      return calendarClarifierChoiceAnswer(routes, now, choice);
    case "metric_current": {
      const metric = defaultMetricById(choice.action.metricId);
      return metric
        ? (currentMetricAnswer(metric, `${metric.label} power`, routes)
          ?? declined("time_window_math", `I've got ${metric.label}, but I don't have a live current-state source for it.`, `clarified current metric unavailable: ${metric.id}`))
        : declined("time_window_math", "I lost that metric context, so I can't finish the clarification cleanly.", `clarified metric missing from catalog: ${choice.action.metricId}`);
    }
    case "wikipedia_media": {
      const lookup = await wikipediaKnowledge.lookupEarlyTitleTextAsync(choice.action.title);
      const hit = lookup.hit;
      return hit
        ? wikipediaKnowledgeResult(
          turnId,
          hit,
          [
            "resolved a typed media clarifier against the local Wikipedia index",
            wikipediaDiagnosticsNote(lookup.diagnostics),
          ].filter(Boolean).join("; "),
        )
        : declined(
            "general_knowledge",
            "I lost that title from the local knowledge index, so ask me the full question again.",
            `clarified Wikipedia media title no longer resolved: ${choice.action.title}`,
          );
    }
  }
}

/** The target's state now: yes or no when a state was named, its value otherwise. */
function stateNow(
  target: ResolvedTarget,
  targetText: string,
  requestedState: string | null,
  acquisition: EntityStatusTargetAcquisition,
  ctx: OwnerServices,
  questionType: CurrentStatusPlan["questionType"] = requestedState ? "yes_no" : "state_value",
): BasicResult {
  return entityStatus(target, ctx.routes, {
    intent: "current_status",
    targetText,
    requestedState,
    questionType,
    source: "aliases_or_live_state",
  }, ctx.turn.request, statusAcquisitionEvidence(target, acquisition, ctx.turn.analysis, targetText));
}

// --- Follow-ups ------------------------------------------------------------------

/** One reply claims a pending clarifier; a later one gets the stale reply. */
const claimed = (ctx: OwnerServices, envelope: NonNullable<FollowUpTurn["clarifier"]>): boolean =>
  ctx.claimClarifier(envelope.frameId) !== null;

/** A pending clarifier's reply: a choice, a repair of one, or the question again. */
export const CLARIFIER_FOLLOW_UPS = followUpSteps("clarifier", {
  async choice(f, ctx) {
    const envelope = f.clarifier;
    if (!envelope || envelope.payload.freeform) return null;
    const pending = envelope.payload;
    const choice = resolvePendingClarifierChoice(f.raw, pending);
    // Repair markers are dialogue evidence and may be absent from the routing
    // core after pragmatic-preface normalization. Read the immutable surface.
    const repair = resolvePendingClarifierRepair(f.turn.analysis.surface, pending);
    if (choice === null && repair === null && f.restatedRequest) return null;
    const selected = choice ?? (repair?.kind === "choice" ? repair.choice : null);
    if (selected) {
      if (!claimed(ctx, envelope)) return staleClarifierReply(pending);
      return resolveClarifiedChoice(selected, ctx.routes, ctx.turn.request, ctx.now(), ctx.wikipediaKnowledge, ctx.turnId);
    }
    if (repair?.kind === "reissue") {
      if (!claimed(ctx, envelope)) return staleClarifierReply(pending);
      return clarify(pending.route, pending.prompt, "contrastive clarifier repair remained ambiguous", pending);
    }
    return clarifierRepeat(f, ctx, envelope);
  },
  async reply(f, ctx) {
    const envelope = f.clarifier;
    if (!envelope || !(envelope.payload.freeform || !f.restatedRequest)) return null;
    const pending = envelope.payload;
    if (pending.freeform) {
      if (!claimed(ctx, envelope)) return staleClarifierReply(pending);
      const resolution = await resolveFreeformClarifierReply(
        f.normalized,
        f.transcript,
        pending,
        ctx.routes,
        ctx.now,
        ctx.turn.request,
        f.turn.analysis,
      );
      return resolution.kind === "resolved" ? resolution.result : NOT_FOLLOW_UP;
    }
    const clarified = resolvePendingClarifierChoice(f.raw, pending);
    if (clarified) {
      if (!claimed(ctx, envelope)) return staleClarifierReply(pending);
      return resolveClarifiedChoice(clarified, ctx.routes, ctx.turn.request, ctx.now(), ctx.wikipediaKnowledge, ctx.turnId);
    }
    const alternateTarget = pending.route === "entity_status"
      ? alternateClarifierTargetText(f.normalized)
      : null;
    if (alternateTarget) {
      if (!claimed(ctx, envelope)) return staleClarifierReply(pending);
      const requestedState = requestedStateForStatusTarget(f.normalized, alternateTarget);
      const questionType = requestedState ? "yes_no" : "state_value";
      const resolution = resolveStatusTargetWithClarifier(alternateTarget, ctx.routes, requestedState, questionType);
      if (resolution.target) {
        return stateNow(resolution.target, alternateTarget, requestedState, "explicit", ctx, questionType);
      }
      if (resolution.clarifier) {
        return clarify("entity_status", resolution.clarifier.prompt, "alternate status target needs fresh clarification", resolution.clarifier);
      }
      return declined("entity_status", "I can't see a matching device for that.", "alternate status target superseded stale clarifier but did not resolve");
    }
    return clarifierRepeat(f, ctx, envelope);
  },
});

/** A reply that still did not settle the clarifier gets the question again, unless it moves on. */
function clarifierRepeat(f: FollowUpTurn, ctx: OwnerServices, envelope: NonNullable<FollowUpTurn["clarifier"]>): BasicResult | null {
  const pending = envelope.payload;
  const supersedesClarifier = /\b(?:instead|rather than|different|another)\b/.test(f.normalized);
  if (supersedesClarifier || !looksLikeClarifierReply(f.raw, pending)) return null;
  if (!claimed(ctx, envelope)) return staleClarifierReply(pending);
  return clarify(pending.route, pending.prompt, "clarifier reply did not resolve cleanly", pending);
}

/** Entity status on the status frame, and the status questions that look like follow-ups. */
export const STATUS_FOLLOW_UPS = followUpSteps("entity_status", {
  restatement(f, ctx) {
    const history = f.views.entityStatus.history;
    const restatement = history.length > 0 ? parseContextualStatusRestatement(f.transcript) : null;
    if (!restatement) return null;
    const resolution = resolveStatusTargetWithClarifier(restatement.targetText, ctx.routes, restatement.requestedState, "yes_no");
    const priorEntityIds = new Set(history.flatMap((entry) => entry.payload.target.entityIds));
    if (!resolution.target || !resolution.target.entityIds.some((entityId) => priorEntityIds.has(entityId))) return null;
    return stateNow(resolution.target, restatement.targetText, restatement.requestedState, "contextual", ctx);
  },
  outsideTemperature(f, ctx) {
    return outsideTemperatureStatusTarget(f.normalized, ctx.routes)
      && !new RegExp(String.raw`^${FOLLOW_UP_OPENER_PATTERN}\b`).test(f.normalized)
      && !looksLikeCorrectionFollowUp(f.normalized)
      ? NOT_FOLLOW_UP
      : null;
  },
  /** A whole status question with its own target is asked fresh. */
  freshQuestion(f, ctx) {
    const n = f.normalized;
    const plan = parseCurrentStatusPlan(f.transcript);
    if (plan?.intent !== "current_status" || !plan.targetText) return null;
    const reference = classifyDemonstrativeTarget(plan.targetText);
    const explicitDemonstrativeTarget = resolveExplicitDemonstrativeTarget(plan.targetText, ctx.routes, { requestedState: plan.requestedState });
    return !f.returnsToPriorFocus
      && !f.lightsListFollowUp
      && reference.kind !== "contextual"
      && statusChangeFollowUpTarget(n) === null
      && statusChangeFollowUpTarget(f.discourse) === null
      && !/^(?:what about|and)\b/.test(n)
      && !looksLikeCorrectionFollowUp(n)
      && (
        outsideTemperatureStatusTarget(n, ctx.routes)
        || explicitDemonstrativeTarget
        || reference.kind === "descriptive"
        || resolveStatusTarget(plan.targetText, ctx.routes)
        || looksLikeExplicitStatusTargetObject(plan.targetText)
      )
      ? NOT_FOLLOW_UP
      : null;
  },
  // Like deferred watches, status-change follow-ups need their directive
  // wrapper ("check whether... changed") to distinguish them from a bare
  // assertion. Keep semantic-core routing, but let this owning grammar inspect
  // the immutable surface as a fallback.
  statusChange(f, ctx) {
    const statusChangeTarget = statusChangeFollowUpTarget(f.normalized) ?? statusChangeFollowUpTarget(f.discourse);
    if (!statusChangeTarget) return null;
    const { routes } = ctx;
    const requestedState = requestedStateForStatusTarget(f.normalized, statusChangeTarget);
    const demonstrativeReference = classifyDemonstrativeTarget(statusChangeTarget);
    const explicitDemonstrativeTarget = resolveExplicitDemonstrativeTarget(statusChangeTarget, routes, { requestedState });
    const exactExclusionTarget = resolveExactExclusionStatusTarget(statusChangeTarget, demonstrativeReference, routes, requestedState);
    const contextualStatusChange = demonstrativeReference.kind === "contextual";
    const unresolvedReferenceStatusChange = (demonstrativeReference.kind === "underspecified" && exactExclusionTarget === null)
      || (demonstrativeReference.kind === "descriptive" && explicitDemonstrativeTarget === null);
    const statusContextFrame = f.statusFrame;
    const statusCandidates = contextualStatusChange
      ? (statusContextFrame ? [statusContextFrame] : [])
      : unresolvedReferenceStatusChange
        ? []
        : f.views.entityStatus.history.map((entry) => entry.payload);
    const matchedStatusFrame = unresolvedReferenceStatusChange
      ? null
      : matchingStatusChangeFrame(statusChangeTarget, statusCandidates, contextualStatusChange);
    const statusFrame = matchedStatusFrame
      && (demonstrativeReference.kind !== "contextual"
        || contextualReferenceMatchesTarget(demonstrativeReference, matchedStatusFrame.target, routes))
      ? matchedStatusFrame
      : null;
    const resolution = explicitDemonstrativeTarget
      ? { target: explicitDemonstrativeTarget, clarifier: null }
      : exactExclusionTarget
        ? { target: exactExclusionTarget, clarifier: null }
        : statusFrame
          ? { target: statusFrame.target, clarifier: null }
          : contextualStatusChange || unresolvedReferenceStatusChange
            ? { target: null, clarifier: null }
            : resolveFreshStatusChangeTarget(statusChangeTarget, routes, requestedState, requestedState ? "yes_no" : "state_value");
    if (resolution.target) {
      const targetText = explicitDemonstrativeTarget
        ? demonstrativeActionTargetDescriptor(statusChangeTarget) ?? statusChangeTarget
        : statusChangeTarget;
      const acquisition = explicitDemonstrativeTarget || exactExclusionTarget ? "explicit" : statusFrame ? "contextual" : "explicit";
      return stateNow(resolution.target, targetText, requestedState, acquisition, ctx);
    }
    if (resolution.clarifier) {
      return clarify("entity_status", resolution.clarifier.prompt, "status-change target needs exact-name clarification", resolution.clarifier);
    }
    return contextualStatusChange
      ? declinedContextReference(
        "entity_status",
        "I can't safely attach that reference to a sourced device target.",
        "status-change reference lacked compatible active device context",
      )
      : declined("entity_status", "I can't see a matching device for that.", "status-change target could not be resolved");
  },
  /** With no focus, a follow-up shaped question is asked as itself ("and what is the office temperature?"). */
  unfocusedQuestion(f, ctx) {
    if (f.hasFocus || !f.explicitQuestion) return null;
    return resolveExplicitFollowUpQuestion(f.explicitQuestion, ctx.routes, ctx.now, ctx.turn.request, f.turn.analysis);
  },
  /** With no focus, "what about X?" asks about X fresh, or says what is missing. */
  unfocusedTarget(f, ctx) {
    if (f.hasFocus) return null;
    const targetSwap = f.targetSwap;
    if (isGenericFollowUpTargetReference(targetSwap)) {
      return unresolvedFollowUpTargetResult(targetSwap) ?? NOT_FOLLOW_UP;
    }
    const targetSwapText = targetSwap as string;
    const targetReference = classifyDemonstrativeTarget(targetSwapText);
    const metric = targetReference.kind === "none" ? resolveFollowUpMetricTarget(targetSwapText) : null;
    if (metric) {
      return currentMetricAnswer(metric, metricFollowUpPrompt(targetSwapText), ctx.routes)
        ?? declined("time_window_math", `I've got ${metric.label}, but I don't have a live current-state source for it.`, `metric shorthand without prior frame matched: ${metric.id}; no current answer`);
    }
    const requestedStatus = requestedStateForStatusTarget(f.normalized, targetSwapText);
    const statusResolution = targetReference.kind === "descriptive"
      ? {
        target: resolveExplicitDemonstrativeTarget(targetSwapText, ctx.routes, { requestedState: requestedStatus }),
        clarifier: null,
      }
      : resolveStatusTargetWithClarifier(targetSwapText, ctx.routes, requestedStatus, requestedStatus ? "yes_no" : "state_value");
    if (statusResolution.target) {
      return stateNow(statusResolution.target, targetSwapText, requestedStatus, "explicit", ctx);
    }
    if (statusResolution.clarifier) {
      return clarify("entity_status", statusResolution.clarifier.prompt, "follow-up status target needs exact-name clarification", statusResolution.clarifier);
    }
    return unresolvedFollowUpTargetResult(targetSwapText) ?? NOT_FOLLOW_UP;
  },
  // A place swap after a reading ("what about inside?", "and outside?") is
  // settled before weather words like "outside" can send it elsewhere.
  // Weather already answers for outside, so only an indoor place leaves it.
  async placeSwap(f, ctx) {
    const statusFrame = f.statusFrame;
    const carriedReading = statusFrame ? frameReading(statusFrame, ctx.routes) : f.weatherFrame?.reading ?? null;
    const placeSwap = carriedReading ? f.targetSwap : null;
    const place = placeSwap && classifyDemonstrativeTarget(placeSwap).kind === "none" ? targetTextKey(placeSwap) : null;
    if (!carriedReading || !place || (!statusFrame && OPEN_AIR_PLACE.test(place))) return null;
    return carriedPlaceReading(place, carriedReading, statusFrame, ctx.routes, ctx.now, ctx.turn.request, f.turn.analysis);
  },
  explicitQuestion(f, ctx) {
    return f.explicitQuestion
      ? resolveExplicitFollowUpQuestion(f.explicitQuestion, ctx.routes, ctx.now, ctx.turn.request, f.turn.analysis)
      : null;
  },
  /** "What about the kitchen light?" on the status frame. */
  targetSwap(f, ctx) {
    const targetSwapText = f.targetSwap;
    if (!targetSwapText) return null;
    const { routes } = ctx;
    const targetReference = classifyDemonstrativeTarget(targetSwapText);
    const statusFrame = f.statusFrame;
    const requestedStatus = requestedStateForStatusTarget(f.normalized, targetSwapText);
    const exactExclusionTarget = resolveExactExclusionStatusTarget(targetSwapText, targetReference, routes, requestedStatus);
    let acquisition: EntityStatusTargetAcquisition = "explicit";
    let statusResolution: CurrentStatusResolution;
    if (targetReference.kind === "contextual") {
      acquisition = "contextual";
      statusResolution = statusFrame && contextualReferenceMatchesTarget(targetReference, statusFrame.target, routes)
        ? { target: statusFrame.target, clarifier: null }
        : { target: null, clarifier: null };
    } else if (targetReference.kind === "underspecified") {
      statusResolution = { target: exactExclusionTarget, clarifier: null };
    } else if (targetReference.kind === "descriptive") {
      statusResolution = {
        target: resolveExplicitDemonstrativeTarget(targetSwapText, routes, { requestedState: requestedStatus }),
        clarifier: null,
      };
    } else if (statusFrame) {
      const followUpResolution = resolveFollowUpStatusTarget(targetSwapText, statusFrame, routes, requestedStatus);
      acquisition = followUpResolution.acquisition;
      statusResolution = followUpResolution;
    } else {
      statusResolution = resolveStatusTargetWithClarifier(targetSwapText, routes, requestedStatus, requestedStatus ? "yes_no" : "state_value");
    }
    if (statusResolution.target) {
      return stateNow(statusResolution.target, targetSwapText, requestedStatus, acquisition, ctx);
    }
    if (statusResolution.clarifier) {
      return clarify("entity_status", statusResolution.clarifier.prompt, "follow-up status target needs exact-name clarification", statusResolution.clarifier);
    }
    if (targetReference.kind === "none") return null;
    return targetReference.kind === "contextual"
      ? declinedContextReference(
        "entity_status",
        "I can't safely attach that reference to a sourced device target.",
        "follow-up target reference lacked compatible exact provenance",
      )
      : declined(
        "entity_status",
        "I can't safely attach that reference to a sourced device target.",
        "follow-up target reference lacked compatible exact provenance",
      );
  },
  targetSwapUnresolved(f) {
    return f.targetSwap
      ? declined("entity_status", "I can't see a matching device for that.", "follow-up target could not be resolved")
      : null;
  },
  /** "Is it still on?": the state asked of the status frame (or the lights list). */
  pronounState(f, ctx) {
    const requestedState = pronounRequestedState(f);
    if (!requestedState || !looksLikePronounStatusFollowUp(f.normalized)) return null;
    const statusFrame = f.statusFrame;
    if (statusFrame) {
      const reference = classifiedStatusFollowUpReference(f.normalized);
      if (reference?.kind !== "contextual" || !contextualReferenceMatchesTarget(reference, statusFrame.target, ctx.routes)) {
        return declinedContextReference(
          "entity_status",
          "I can't safely attach that to the previous device target.",
          "status follow-up reference or cardinality did not match sourced context",
        );
      }
      return stateNow(statusFrame.target, statusFrame.target.label, requestedState, "contextual", ctx);
    }
    if (f.lightsFrame) {
      return houseLightFocusSupportsRequestedState(requestedState)
        ? houseLightsStatus(ctx.routes, f.normalized)
        : NOT_FOLLOW_UP;
    }
    return declinedContextReference(
      "entity_status",
      "I don't have a previous sourced status target to attach that to.",
      "state follow-up declined without status context frame",
    );
  },
  pronoun(f, ctx) {
    const statusFrame = f.statusFrame;
    const requestedState = pronounRequestedState(f);
    const pronoun = hasPronounFollowUp(f.normalized);
    if (!statusFrame || !(pronoun || requestedState)) return null;
    if (pronoun) {
      const reference = classifiedStatusFollowUpReference(f.normalized);
      if (reference && (reference.kind !== "contextual" || !contextualReferenceMatchesTarget(reference, statusFrame.target, ctx.routes))) {
        return declinedContextReference(
          "entity_status",
          "I can't safely attach that to the previous device target.",
          "status follow-up reference or cardinality did not match sourced context",
        );
      }
    }
    return stateNow(statusFrame.target, statusFrame.target.label, requestedState, "contextual", ctx);
  },
});

function pronounRequestedState(f: FollowUpTurn): string | null {
  return f.once("pronounRequestedState", () => parseCurrentStatusPlan(f.normalized)?.requestedState
    ?? parseEntityStatusPredicateFollowUp(f.normalized));
}

/** The house lights list on the lights frame. */
export const LIGHTS_FOLLOW_UPS = followUpSteps("house_lights", {
  membership(f, ctx) {
    const lightMembershipTarget = houseLightMembershipTarget(f.normalized);
    if (!lightMembershipTarget || !f.views.houseLights.recent) return null;
    const resolution = resolveStatusTargetWithClarifier(`${lightMembershipTarget} lights`, ctx.routes, "on", "yes_no");
    if (!resolution.target) return null;
    return stateNow(resolution.target, lightMembershipTarget, "on", "contextual", ctx);
  },
  list(f, ctx) {
    const lightsFrame = f.lightsFrame;
    if (!lightsFrame || !f.lightsListFollowUp) return null;
    return looksLikeExplicitHouseLightsFocusReturn(f.normalized)
      ? houseLightsStatus(ctx.routes, "which house lights are on")
      : houseLightsListFollowUpAnswer(lightsFrame, f.discourse);
  },
  activeList(f, ctx) {
    const activeLightsFrame = f.views.houseLights.active?.payload ?? null;
    if (!activeLightsFrame) return null;
    const plan = parseCurrentStatusPlan(f.normalized);
    const reference = classifyDemonstrativeTarget(plan?.targetText ?? "");
    return looksLikeGlobalLightsStatus(f.normalized)
      || (plan !== null && reference.kind === "contextual" && houseLightFocusSupportsStatusPlan(plan))
      ? houseLightsStatus(ctx.routes, f.normalized)
      : null;
  },
});

export function hasHaEntityCandidate(
  transcript: string,
  turnAnalysis: BasicTurnAnalysis,
): boolean {
  const normalized = normalize(transcript);
  const resolver = turnAnalysis.sources.targets();
  const topics = [
    entityLinkedKnowledgeQuestion(transcript, normalized)?.topic ?? "",
    extractExplicitReadRequestObject(turnAnalysis.semantics.core) ?? "",
    ...possessiveSourceCandidateTopics(normalized),
  ].filter(Boolean);
  if (!resolver || topics.length === 0) {
    return false;
  }
  return topics.some((topic) => hasHaTopicCandidate(topic, turnAnalysis));
}

function possessiveSourceCandidateTopics(normalized: string): readonly string[] {
  const tokens = targetTextKey(normalized).split(/\s+/).filter(Boolean);
  const boundaryTerms = new Set([
    "a", "an", "and", "are", "at", "can", "check", "confirm", "could", "did",
    "do", "does", "find", "for", "from", "has", "have", "how", "in", "is",
    "left", "much", "of", "on", "please", "read", "report", "scan", "the",
    "to", "verify", "was", "were", "what", "where", "which", "who", "will",
    "work", "would",
  ]);
  const topics = new Set<string>();
  for (let marker = 1; marker < tokens.length - 1; marker += 1) {
    if (tokens[marker] !== "s") {
      continue;
    }
    const object = tokens[marker + 1] ?? "";
    if (!object || boundaryTerms.has(object)) {
      continue;
    }
    const owner: string[] = [];
    for (let index = marker - 1; index >= 0 && owner.length < 3; index -= 1) {
      const token = tokens[index] ?? "";
      if (!token || boundaryTerms.has(token)) {
        break;
      }
      owner.unshift(token);
      topics.add(`${owner.join(" ")} ${object}`);
    }
    const next = tokens[marker + 2] ?? "";
    if (next && !boundaryTerms.has(next)) {
      for (let size = 1; size <= owner.length; size += 1) {
        topics.add(`${owner.slice(-size).join(" ")} ${object} ${next}`);
      }
    }
  }
  return [...topics];
}

export function hasHaTopicCandidate(
  topic: string,
  turnAnalysis: BasicTurnAnalysis,
): boolean {
  const resolver = turnAnalysis.sources.targets();
  if (!resolver || !topic.trim()) {
    return false;
  }
  const result = resolver.resolve({
    text: topic,
    includeUnavailable: true,
  });
  return ["high", "medium", "ambiguous"].includes(result.confidence)
    && result.matches.some((match) =>
      match.score >= 60
      && match.reasons.some((reason) =>
        reason.startsWith("exact:")
        || reason.startsWith("partial:")
        || reason.startsWith("alias_exact:")
        || reason.startsWith("alias_partial:")
      )
    );
}

export function entityLocatorTopic(normalized: string): string | null {
  const topic = /^what (?:is|are) (.+?) (?:location|presence|whereabouts)(?: state)?$/.exec(normalized)?.[1]
    ?? /^(?:what|where) (?:is|are) the (?:location|presence|whereabouts) of (.+)$/.exec(normalized)?.[1]
    ?? /^(?:location|presence|whereabouts) (?:of|for) (.+)$/.exec(normalized)?.[1]
    ?? /^(.+?) (?:location|presence|whereabouts)$/.exec(normalized)?.[1]
    ?? /^(?:(?:can|could|would|will) you )?(?:tell me|show me|check|find out|confirm) where (.+?) is$/.exec(normalized)?.[1]
    ?? /^i (?:want|need|would like) to know where (.+?) is$/.exec(normalized)?.[1]
    ?? new RegExp(`^(?:what (?:is|are) )?(.+?) s ${PERSON_LOCATION_FIELD_PATTERN_SOURCE}(?: state)?$`).exec(normalized)?.[1]
    ?? new RegExp(`^(?:what|which) ${PERSON_LOCATION_FIELD_PATTERN_SOURCE} (?:is|are) (.+?)(?: in| at)?$`).exec(normalized)?.[1]
    ?? "";
  return cleanTargetText(topic, "status") || null;
}

interface EntityIdentityQuestion {
  readonly targetText: string | null;
  readonly ownsUnresolved: boolean;
}

export function parseEntityIdentityQuestion(normalized: string): EntityIdentityQuestion | null {
  const question = normalized
    .replace(/^(?:(?:do|can|could|would) you (?:know|tell me)\s+)/, "")
    .trim();
  if (
    /^(?:which|what) (?:home assistant )?entity(?: id)? (?:does )?(?:that|this|it) (?:belongs? to|maps? to|refers? to)$/.test(question)
    || /^(?:which|what) (?:home assistant )?entity(?: id)? (?:is )?(?:that|this|it)$/.test(question)
    || /^what is (?:the )?(?:entity id|home assistant entity)(?: for)? (?:that|this|it)$/.test(question)
  ) {
    return { targetText: null, ownsUnresolved: true };
  }

  const suffixTarget = /^(.+?) (?:(?:which|what) (?:home assistant )?entity(?: id)? (?:is|does) (?:that|this|it)(?: (?:belong|map) to)?|what is (?:that|this|its) (?:home assistant )?entity(?: id)?)$/.exec(question)?.[1];
  const prefixTarget = /^(?:what is|whats) (?:the )?(?:home assistant )?entity(?: id)? (?:for|behind) (.+)$/.exec(question)?.[1]
    ?? /^(?:which|what) (?:home assistant )?entity(?: id)? (?:does )?(.+?) (?:belongs? to|maps? to|use)$/.exec(question)?.[1]
    ?? /^(?:which|what) (?:home assistant )?entity(?: id)? is (.+)$/.exec(question)?.[1];
  const targetText = targetTextKey(suffixTarget ?? prefixTarget ?? "");
  if (!targetText) {
    return null;
  }
  return {
    targetText,
    // Bare "what entity is that?" is also ordinary ontology language. Only
    // reserve an unresolved target when the caller explicitly named HA or an
    // entity ID; otherwise a non-HA subject must remain available to knowledge.
    ownsUnresolved: /\b(?:home assistant entity|entity id)\b/.test(question),
  };
}

export function answerEntityIdentityQuestion(
  question: EntityIdentityQuestion,
  contextViews: BasicContextViews,
  routes: BasicBrainRouteServices,
  request: VoiceBrainRequest,
  conversationTurns: readonly BasicConversationTurn[],
): BasicResult | null {
  const latestTrace = contextViews.answerTrace.latest;
  const previousTurn = conversationTurns.at(-1) ?? null;
  const demonstrativeTraceIsLatest = question.targetText !== null
    || (
      latestTrace !== null
      && previousTurn !== null
      && previousTurn.turnId === latestTrace.envelopes[0]?.source.turnId
    );
  const traceTarget = resolveEntityIdentityFromAnswerTrace(
    question.targetText,
    demonstrativeTraceIsLatest ? latestTrace : null,
    routes,
  );
  if (question.targetText === null && demonstrativeTraceIsLatest && latestTrace) {
    const sourceCount = latestTrace.explanation?.sourceEntityIds.length ?? 0;
    if (!traceTarget && sourceCount > 1) {
      return declined(
        "entity_status",
        `That answer used ${sourceCount} Home Assistant entities, not one entity ID.`,
        "latest answer trace had multiple sources and no unique spoken antecedent",
      );
    }
    if (!traceTarget) {
      return null;
    }
  }
  const directResolution = question.targetText
    ? resolveDirectEntityIdentity(question.targetText, routes)
    : null;
  if (!traceTarget && directResolution?.clarifier) {
    if (isGuestSpeakerRequest(request) && entityIdentityClarifierIsSensitive(directResolution.clarifier, routes)) {
      return guestPersonalStatusDecline("guest mode blocked sensitive entity identity clarification");
    }
    return clarify(
      "entity_status",
      directResolution.clarifier.prompt,
      "entity identity target needs exact-name clarification",
      directResolution.clarifier,
    );
  }
  const target = traceTarget ?? directResolution?.target ?? null;
  if (!target || target.entityIds.length === 0) {
    return null;
  }
  return resolvedEntityIdentityAnswer(target, routes, request);
}

function entityIdentityClarifierIsSensitive(
  clarifier: PendingClarifierFrame,
  routes: BasicBrainRouteServices,
): boolean {
  const choiceIsSensitive = clarifier.choices.some((choice) => (
    choice.action.kind === "entity_status"
    && entityIdentityIdsAreSensitive(choice.action.entityIds, routes)
  ));
  const freeformIsSensitive = clarifier.freeform?.kind === "entity_identity_exact_id"
    && entityIdentityIdsAreSensitive(clarifier.freeform.entityIds, routes);
  return choiceIsSensitive || freeformIsSensitive;
}

function resolveEntityIdentityFromAnswerTrace(
  targetText: string | null,
  trace: BasicContextViews["answerTrace"]["latest"],
  routes: BasicBrainRouteServices,
): ResolvedTarget | null {
  const explanation = trace?.explanation;
  if (!trace || !explanation || explanation.sourceEntityIds.length === 0) {
    return null;
  }
  const sources = explanation.sourceEntityIds.map((entityId, index) => {
    const state = routes.stateCache?.get(entityId) ?? null;
    const label = explanation.sourceLabels[index]
      ?? (state ? friendlyName(state) : entityId);
    const keys = [
      label,
      entityId,
      entityId.replaceAll(/[._]/g, " "),
      ...(state ? [friendlyName(state), shortFriendlyName(state)] : []),
    ].map(targetTextKey).filter(Boolean);
    return { entityId, label: state ? shortFriendlyName(state) : label, keys };
  });

  const matches = targetText
    ? sources.filter((source) => source.keys.some((key) => labelsEquivalent(key, targetText)))
    : sources.filter((source) => source.keys.some((key) => key.length >= 3 && targetTextKey(trace.responseText).includes(key)));
  const uniqueMatches = [...new Map(matches.map((match) => [match.entityId, match])).values()];
  const selected = uniqueMatches.length === 1
    ? uniqueMatches[0]
    : targetText === null && sources.length === 1
      ? sources[0]
      : null;
  return selected
    ? {
      label: selected.label,
      entityIds: [selected.entityId],
      source: "exact_name",
    }
    : null;
}

export function namedContextAnswerReference(
  normalized: string,
  context: BasicContextViews["entityStatus"],
  routes: BasicBrainRouteServices,
  request: VoiceBrainRequest,
): BasicResult | null {
  const subject = cleanTargetText(
    /^(?:say|repeat|give me|tell me) (?:the )?(.+?) (?:answer|reading|status)(?: again| once more)?$/.exec(normalized)?.[1] ?? "",
    "status",
  );
  if (!subject) return null;
  const subjectTokens = normalizedStatusReferenceTokens(subject);
  const frame = uniqueStatusTargetEntry(context.history.filter((candidate) => {
    const labelTokens = new Set(normalizedStatusReferenceTokens(candidate.payload.target.label));
    return subjectTokens.length > 0 && subjectTokens.every((token) => labelTokens.has(token));
  }), (candidate) => candidate.payload.target);
  if (!frame) return null;
  return entityStatus(frame.payload.target, routes, {
    intent: "current_status",
    targetText: frame.payload.target.label,
    requestedState: null,
    questionType: "state_value",
    source: "aliases_or_live_state",
  }, request, { acquisition: "contextual" });
}

export function looksLikeUnsourcedHouseFactTrap(normalized: string): boolean {
  return (
    /\b(fake|ghost|imaginary|pretend|non existent|invisible|mystery|secret|unicorn|spaceship|portal|dragon)\b/.test(normalized)
    || /\bpower button\b/.test(normalized)
  ) && looksLikeHouseFact(normalized);
}

// --- Owners ----------------------------------------------------------------------

/** Whether the turn may read current house state (a task about the actual world). */
const readsState = (turn: OwnerTurn): boolean => routingSemanticsAllowCurrentStatus(turn.analysis.semantics);

/** Actual Home Assistant entities named in the turn, read once. */
export function resolvedHaCandidate(turn: OwnerTurn): boolean {
  return turn.once("resolvedHaCandidate", () => hasHaEntityCandidate(turn.transcript, turn.analysis));
}

/** Status-shaped "complete" answer: the target's live state, read now. */
function explicitStatus(target: ResolvedTarget, targetText: string, ctx: OwnerServices): BasicResult {
  return withReadFallback(stateNow(target, targetText, null, "explicit", ctx), "read_source_unavailable");
}

/**
 * "Was the door open at six?": a state at another time needs history this path
 * does not read. A device the house does not have is declined outright, so the
 * read agent is never sent looking for it.
 */
export const timeQualifiedStatusOwner = {
  id: "time_qualified_status",
  tier: "unsupported",
  claim(turn, ctx) {
    const plan = parseTimeQualifiedEntityStatusIntent(turn.surface, { now: ctx.now(), timezone: DEFAULT_TIMEZONE });
    if (!plan) return null;
    const resolution = resolveStatusTargetWithClarifier(plan.targetText, ctx.routes, plan.requestedState, plan.questionType);
    const claimed = resolution.target !== null || plan.ownsMissingTarget || looksLikeExplicitStatusTargetObject(plan.targetText);
    return claimed ? { exists: resolution.target !== null || resolution.clarifier !== null } : null;
  },
  answer: ({ exists }) => exists
    ? declinedReadFallback(
      "entity_status",
      "I can't verify that state for that time.",
      "time-qualified entity state requires historical state evidence",
      "historical_state_required",
    )
    : declined("entity_status", "I can't see a matching device for that.", "time-qualified status target could not be resolved"),
} satisfies Owner<{ readonly exists: boolean }>;

/**
 * A past temperature or humidity in a place: from the
 * sensor's HA history, the sensor found exactly as "what's the temperature in
 * X?" finds it. One exact moment ("at 3am") is declined (the time parser has
 * no single instant yet), as is a time still to come.
 */
export const pastReadingOwner = {
  id: "past_reading",
  tier: "explicit",
  claim: (turn, ctx) => parsePastReading(turn.normalized, ctx.now(), DEFAULT_TIMEZONE),
  async answer(ask, { turn, routes, now }) {
    if ("refusal" in ask) {
      return ask.refusal === "moment"
        ? declined("entity_status", "I can tell you about a stretch of time, like last night or yesterday, but not one exact moment yet.", "past reading at a single moment; no instant window")
        : declined("entity_status", `${capitalize(ask.when)} hasn't happened yet, so there's nothing to look back on.`, `past reading: ${ask.when} has not started`);
    }
    const plan = parseStandaloneEntityStatusIntent(ask.statusQuestion);
    // The present-tense path's order: an exact name first, then the place resolver.
    const exact = plan ? resolveExplicitDemonstrativeTarget(plan.targetText, routes) : null;
    const resolution = plan && !exact
      ? resolveStandaloneEntityStatusTarget({ targetText: plan.targetText, requestedState: null, requestedAttribute: plan.requestedAttribute, analysis: turn.analysis })
      : null;
    if (resolution?.outcome === "ambiguous") {
      const rooms = joinAlternatives(resolution.candidates.map((candidate) => `the ${lowerCommonWords(candidate.label)}`));
      return declined("entity_status", `Which room, ${rooms}? Ask again with its name.`, `past reading: ambiguous target ${resolution.query}`);
    }
    const entityIds = exact?.entityIds ?? (resolution && "target" in resolution ? resolution.target.entityIds : []);
    if (entityIds.length > 1) {
      return declined("entity_status", `${capitalize(ask.place)} matches more than one ${ask.reading} sensor. Say the room's full name.`, `past reading: ${entityIds.length} sensors for "${plan?.targetText ?? ""}"`);
    }
    const entityId = entityIds[0] ?? null;
    if (!entityId) {
      return declined("entity_status", `I can't see a ${ask.reading} sensor for ${ask.place}.`, `past reading: no single sensor for "${plan?.targetText ?? ask.statusQuestion}"`);
    }
    const fetchHistory = routes.historyFetcher?.fetchHistory;
    if (!fetchHistory) {
      return declined("entity_status", `I can't read the ${ask.reading} history just now.`, "past reading: no history source");
    }
    let history;
    try {
      history = await fetchHistory.call(routes.historyFetcher, { entityIds: [entityId], window: ask.window, includeStartTimeState: true, noAttributes: true });
    } catch {
      return declined("entity_status", `I can't read the ${ask.reading} history just now.`, "past reading: history read failed");
    }
    const unit = routes.stateCache?.get(entityId)?.attributes.unit_of_measurement;
    const answer = pastReadingAnswer({
      ask,
      entityId,
      unit: typeof unit === "string" ? unit : null,
      history: history.states.filter((row) => row.entityId === entityId),
      now: now(),
      timezone: DEFAULT_TIMEZONE,
    });
    return answer.status === "ok" ? ok("entity_status", answer.text, answer.notes) : declined("entity_status", answer.text, answer.notes);
  },
} satisfies Owner<PastReadingAsk | PastReadingRefusal>;

/** Guests never learn who or where a household member or a tracked thing is. */
export const guestPrivateLookupOwner = fixedReply(
  "guest_private_lookup",
  "safety",
  (turn, ctx) => {
    if (!isGuestSpeakerRequest(turn.request)) return false;
    const n = turn.normalized;
    const privateEntityLink = directEntityLinkedKnowledgeQuestion(n);
    const privateLocatorTopic = entityLocatorTopic(n);
    const guestPrivateTopic = privateLocatorTopic
      ?? (privateEntityLink?.kind === "identity" || privateEntityLink?.kind === "location" ? privateEntityLink.topic : null);
    const plan = parseCurrentStatusPlan(turn.transcript, turn.analysis.speechAct);
    const reservedPerson = plan?.intent === "current_status" && plan.targetText
      ? resolveReservedPersonStatusTarget(targetTextKey(plan.targetText), ctx.routes, plan.requestedState, plan.questionType)
      : { kind: "none" as const };
    return reservedPerson.kind !== "none" || (
      guestPrivateTopic !== null && (
        hasHaTopicCandidate(guestPrivateTopic, turn.analysis)
        || resolveReservedPersonStatusTarget(targetTextKey(guestPrivateTopic), ctx.routes, null, "state_value").kind !== "none"
        || (privateLocatorTopic !== null && isSourceBackedPersonalLocatorTarget(privateLocatorTopic, ctx.routes))
      )
    );
  },
  () => guestPersonalStatusDecline("guest mode blocked a source-backed identity or locator request before resolution"),
);

/** "What is the kitchen sensor?": which Home Assistant entity a name is. */
export const entityIdentityOwner = {
  id: "entity_identity",
  tier: "explicit",
  claim: (turn) => parseEntityIdentityQuestion(turn.analysis.normalizedSurface) ?? parseEntityIdentityQuestion(turn.normalized),
  answer(question, ctx) {
    const answer = answerEntityIdentityQuestion(question, ctx.contextViews, ctx.routes, ctx.turn.request, ctx.turn.conversationTurns);
    if (answer) return answer;
    if (question.ownsUnresolved) {
      return declined("entity_status", "I can't match that to one Home Assistant entity.", "entity identity question did not resolve to one source-backed target");
    }
    // "What entity is X?" is also a normal ontology question. Once the HA
    // resolver has genuinely missed, route it directly to knowledge rather
    // than allowing an older house focus to capture its demonstrative.
    return question.targetText ? ctx.knowledge() : null;
  },
} satisfies Owner<EntityIdentityQuestion>;

/** "Are any lights on?": the house lights roll call. */
export const houseLightsOwner = sourceRead(
  "house_lights",
  "explicit",
  (turn) => readsState(turn) && looksLikeGlobalLightsStatus(turn.normalized),
  (ctx) => houseLightsStatus(ctx.routes, ctx.turn.normalized, ctx.now()),
  "read_source_unavailable",
);

/** A house fact with no sourced device behind it is declined before weather, metrics or the model. */
export const unsourcedHouseFactOwner = fixedReply(
  "unsourced_house_fact",
  "unsupported",
  (turn) => readsState(turn)
    && looksLikeUnsourcedHouseFactTrap(turn.normalized)
    && !looksLikeAction(turn.normalized)
    && !asksMemory(turn)
    && !looksLikeStatusChangeFollowUp(turn.normalized),
  () => declined("entity_status", "I can't see a matching device for that.", "negative house fact declined before weather, metric, or model fallback"),
);

/** "What did you say the front door was?": a status answer repeated by name. */
export const namedRepeatOwner = {
  id: "named_repeat",
  tier: "continuation",
  claim: (turn, ctx) => namedContextAnswerReference(turn.normalized, ctx.contextViews.entityStatus, ctx.routes, turn.request),
  answer: (result) => result,
} satisfies Owner<BasicResult>;

/** "What's the outside sensor reading?": the physical outdoor sensor, not the forecast. */
export const outsideSensorOwner = {
  id: "outside_sensor",
  tier: "explicit",
  claim(turn, ctx) {
    const n = turn.normalized;
    const explicitOutsideSensor = readsState(turn)
      && /\b(?:(?:outside|outdoor|physical|local) sensor|sensor outside)\b/.test(n)
      && /\b(?:read|reading|show|showing|value|degrees?|warm|temperature|physical|local|itself)\b/.test(n)
      && !COMPARATOR_WORD.test(n)
      && !/\b(?:weather|forecast)\b.*\b(?:rather than|instead of)\b.*\bsensor\b/.test(n);
    return explicitOutsideSensor
      ? resolveStatusTarget("outside temperature", ctx.routes) ?? inferOutsideTemperatureStatusTarget(ctx.routes)
      : null;
  },
  answer: (target, ctx) => explicitStatus(target, target.label, ctx),
} satisfies Owner<ResolvedTarget>;

/** "How many lights do we have?": the house's entities of one kind. */
export const inventoryOwner = {
  id: "inventory",
  tier: "explicit",
  claim: (turn) => houseEntityInventoryDomain(turn.normalized),
  answer: (domain, ctx) => withReadFallback(houseEntityInventoryAnswer(domain, ctx.routes), "read_source_unavailable"),
} satisfies Owner<NonNullable<ReturnType<typeof houseEntityInventoryDomain>>>;

/** "How warm is it outside?" answered by the outdoor sensor when the house has one. */
export const outsideTemperatureOwner = {
  id: "outside_temperature",
  tier: "explicit",
  claim: (turn, ctx) => (readsState(turn) ? outsideTemperatureStatusTarget(turn.normalized, ctx.routes) : null),
  answer: (target, ctx) => explicitStatus(target, target.label, ctx),
} satisfies Owner<ResolvedTarget>;

/** "Garage door?": a bare device name asks its state. */
export const bareDeviceOwner = {
  id: "bare_device",
  tier: "explicit",
  claim: (turn) => (readsState(turn) ? bareDeviceStatusTargetText(turn.normalized, "status") : null),
  answer(targetText, ctx) {
    const resolution = resolveStatusTargetWithClarifier(targetText, ctx.routes, null, "state_value");
    if (resolution.target) {
      return explicitStatus(resolution.target, targetText, ctx);
    }
    if (resolution.clarifier) {
      return clarify("entity_status", resolution.clarifier.prompt, "bare device target needs exact-name clarification", resolution.clarifier);
    }
    return declined("entity_status", "I can't see a matching device for that.", "bare device-shaped status target could not be resolved");
  },
} satisfies Owner<string>;

/** "Is anyone in the lounge?": a house fact inferred from sourced sensors. */
export const inferredHouseFactOwner = {
  id: "inferred_house_fact",
  tier: "inferred",
  claim: (turn) => (readsState(turn) || challengedHouseFactQuestionText(turn.normalized) !== null) || null,
  async answer(_claim, ctx) {
    const result = await inferHouseFactAnswer(ctx.turn.transcript, ctx.routes, ctx.now, ctx.turn.request);
    return result ? withReadFallback(result, "cross_source_read_required") : null;
  },
} satisfies Owner<true>;

/** "Is the front door locked?": one status question, parsed once. */
/**
 * "is the heater on?", "what is the aircon set to?" from the HVAC's
 * live mode and setpoint (`climate-status.ts`). Claims only when the words
 * land on the house's climate device.
 */
export const climateStatusOwner = {
  id: "climate_status",
  tier: "explicit",
  claim(turn, ctx) {
    const question = parseClimateQuestion(turn.analysis.routing.core);
    if (!question) return null;
    const { analysis } = turn;
    const target = climateQuestionTarget(
      question,
      ctx.routes.stateCache,
      analysis.sources.aliases(),
      (text) => resolveExactSourcedTarget(text, ctx.routes, {}, null, analysis.sources.targets(), analysis.sources.aliases()),
      ctx.contextViews.actionTarget?.target ?? null,
    );
    return target ? { question, target } : null;
  },
  answer: ({ question, target }, ctx) => climateQuestionAnswer(question, target, ctx.routes.stateCache),
} satisfies Owner<{ question: NonNullable<ReturnType<typeof parseClimateQuestion>>; target: ResolvedTarget }>;

export const entityStatusOwner = {
  id: "entity_status",
  tier: "explicit",
  claim(turn) {
    if (asksMemory(turn) || !readsState(turn)) return null;
    const plan = parseCurrentStatusPlan(turn.analysis.semantics.core, turn.analysis.speechAct);
    return plan?.intent === "current_status" ? plan : null;
  },
  answer: (plan, ctx) => statusAnswerFromPlan(plan, ctx.routes, ctx.now, ctx.turn.request, ctx.turn.analysis),
} satisfies Owner<CurrentStatusPlan>;

/** "Who is the hallway sensor?" with house evidence the deterministic path could not settle. */
export const identityEvidenceOwner = fixedReply(
  "identity_evidence",
  "unsupported",
  (turn) => directEntityLinkedKnowledgeQuestion(turn.normalized)?.kind === "identity" && resolvedHaCandidate(turn),
  () => declinedReadFallback(
    "entity_status",
    "I found related Home Assistant evidence, but the deterministic path couldn't resolve the answer.",
    "source-backed identity question offered to bounded read synthesis before status resolution",
    "cross_source_read_required",
  ),
);

/** The whole turn is an exact alias, entity id or live name. */
export const exactTargetOwner = {
  id: "exact_target",
  tier: "explicit",
  claim(turn, ctx) {
    if (!readsState(turn)) return null;
    const exactTarget = resolveExactTarget(turn.transcript, ctx.routes);
    return exactTarget && !exactTargetLooksLikeKnowledgeTitleCollision(exactTarget, turn.transcript, turn.normalized)
      ? exactTarget
      : null;
  },
  answer: (target, ctx) => explicitStatus(target, ctx.turn.transcript, ctx),
} satisfies Owner<ResolvedTarget>;

/** House evidence outweighs knowledge, but nothing resolved: an honest decline the read agent may settle. */
export const houseFallbackOwner = {
  id: "house_fallback",
  tier: "unsupported",
  claim(turn, ctx) {
    const evidence = fallbackEvidence(turn, ctx.routes);
    return readsState(turn)
      && preferHouseFallback(evidence)
      && (strongHouseCandidate(turn, ctx.routes) || explicitLocalSourceScope(turn))
      ? evidence
      : null;
  },
  answer: (evidence) => declinedReadFallback(
    "entity_status",
    "I can't see a matching device for that.",
    `house evidence outweighed knowledge fallback (${evidence.house}:${evidence.knowledge})`,
    "cross_source_read_required",
  ),
} satisfies Owner<FallbackRouteEvidence>;

/** Actual entities match words in the turn, but no route settled it. */
export const haCandidateOwner = fixedReply(
  "ha_candidate",
  "unsupported",
  (turn) => routingSemanticsAllowReadOnlyToolUse(turn.analysis.semantics) && resolvedHaCandidate(turn),
  () => declinedReadFallback(
    "entity_status",
    "I found related Home Assistant evidence, but the deterministic path couldn't resolve the answer.",
    "actual Home Assistant entity candidates offered to bounded read synthesis before generic knowledge",
    "cross_source_read_required",
  ),
);

/** A house fact with no exact alias, entity id or live name. */
export const houseFactOwner = fixedReply(
  "house_fact",
  "unsupported",
  (turn, ctx) => readsState(turn)
    && looksLikeHouseFact(turn.normalized)
    && (strongHouseCandidate(turn, ctx.routes) || explicitLocalSourceScope(turn)),
  () => declinedReadFallback(
    "entity_status",
    "I can't see a matching device for that.",
    "house fact declined without exact alias, entity id, or exact live name",
    "cross_source_read_required",
  ),
);

/** "Check Home Assistant for...": a source-scoped read no route settled. */
export const localSourceScopeOwner = fixedReply(
  "local_source_scope",
  "unsupported",
  (turn) => explicitLocalSourceScope(turn),
  () => declinedReadFallback(
    "entity_status",
    "I couldn't settle that on the deterministic read path.",
    "source-scoped read request offered to bounded read synthesis after knowledge arbitration",
    "cross_source_read_required",
  ),
);
