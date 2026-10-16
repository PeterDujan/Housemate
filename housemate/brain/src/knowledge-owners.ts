import { followUpSteps, type FollowUpTurn } from "./follow-up-turn.js";
import {
  exactWikipediaKnowledgeFollowUpResult,
  looksLikeChemicalFormulaKnowledgePrompt,
  looksLikeEphemeralTimedPrompt,
  looksLikeLocalReadSourceScope,
  looksLikePersonalAdvicePrompt,
  refersToConversation,
  earlyExactWikipediaKnowledgeResult,
  fallbackRouteEvidence,
  hasStrongHouseFallbackCandidate,
  looksLikeGeneralKnowledgePrompt,
  looksLikeStableKnowledgeGrammar,
  type FallbackRouteEvidence,
} from "./basic-brain-knowledge.js";
import type { OwnerServices, Owner, OwnerTurn } from "./router.js";
import type { BasicResult } from "./basic-brain-contracts.js";
import { looksLikeDirectOutdoorClothingMemoryQuestion } from "./weather-owners.js";
import { looksLikeWeatherContextFollowUp, looksLikeWeatherForecastFollowUp } from "./basic-brain-weather.js";
import { resolveUnsupportedMathPrompt } from "./scalar-calculator.js";
import { looksLikeSubjectiveOpinionPrompt } from "./wikipedia-knowledge-store.js";
import type { BasicBrainRouteServices } from "./basic-brain-services.js";
import { looksLikeExplicitReadRequest, routingSemanticsAllowReadOnlyToolUse } from "./routing-text.js";
import { asksMemory } from "./stateless-owners.js";
import { continuesModelChat } from "./conversation-owners.js";
import { namesProject } from "./project-docs.js";
/**
 * General-knowledge owners: offline Wikipedia and the bounded model
 * fallback, claimed from their own words and followed up on a topic. The
 * answers live in `basic-brain-knowledge.ts`.
 */

// --- Follow-ups ------------------------------------------------------------------

/** "What about X?" as a topic in the local Wikipedia index. */
export const KNOWLEDGE_FOLLOW_UPS = followUpSteps("general_knowledge", {
  unfocusedTopic(f, ctx) {
    return f.hasFocus
      ? null
      : exactWikipediaKnowledgeFollowUpResult(ctx.turnId, f.transcript, f.rawKnowledgeTarget, ctx.routes, ctx.wikipediaKnowledge);
  },
  targetSwapTopic(f, ctx) {
    return f.targetSwap ? topicFollowUp(f, ctx) : null;
  },
  topic(f, ctx) {
    return topicFollowUp(f, ctx);
  },
});

/** Weather follow-ups ("will it rain later?") never become a Wikipedia lookup. */
function topicFollowUp(f: FollowUpTurn, ctx: OwnerServices): Promise<BasicResult | null> | null {
  const n = f.normalized;
  const keepWeatherFollowUpsOutOfKnowledge = f.weatherFrame !== null
    && !looksLikeDirectOutdoorClothingMemoryQuestion(n, ctx.turn.request)
    && (looksLikeWeatherContextFollowUp(n) || looksLikeWeatherForecastFollowUp(n, ctx.now()) || f.implicitWeatherCondition);
  return keepWeatherFollowUpsOutOfKnowledge
    ? null
    : exactWikipediaKnowledgeFollowUpResult(ctx.turnId, f.transcript, f.rawKnowledgeTarget ?? f.targetSwap, ctx.routes, ctx.wikipediaKnowledge);
}

/**
 * The end-of-cascade factual class. It is a question about a topic, not
 * about this conversation, this house, or a judgement: a yes/no question
 * counts only when a source can settle it ("is a tomato a fruit"); "is God
 * real" or "is pineapple on pizza acceptable" asks for a judgement and
 * belongs to open chat.
 */
export function looksLikeBroadStableFactualQuestion(normalized: string): boolean {
  if (
    looksLikePersonalAdvicePrompt(normalized)
    || looksLikeSubjectiveOpinionPrompt(normalized)
    || looksLikeEphemeralTimedPrompt(normalized)
    || /\b(?:i|me|my|mine|we|us|our|ours|you|your|yours)\b/.test(normalized)
    || refersToConversation(normalized)
    || looksLikeLocalReadSourceScope(normalized)
    || (resolveUnsupportedMathPrompt(normalized) && !looksLikeChemicalFormulaKnowledgePrompt(normalized))
  ) {
    return false;
  }
  return /^(?:(?:approximately|roughly|exactly)\s+)?(?:what|which|who|whom|where|when|why|how)\b/.test(normalized)
    || looksLikeFactualYesNoQuestion(normalized)
    || /^(?:along|at|by|for|from|in|into|off|to|with|beyond|across)\b.*\b(?:which|whom)\b/.test(normalized)
    || /\b(?:is|are|was|were)\b.*\bwhich\s+[\p{L}\p{N}-]+(?:\s+[\p{L}\p{N}-]+){0,6}$/u.test(normalized);
}

/**
 * A yes/no question a source can settle: category membership ("is a tomato
 * a fruit"), a choice between two categories ("warm-blooded or
 * ectothermic"), or a comparison ("is gold worth more than silver").
 */
function looksLikeFactualYesNoQuestion(normalized: string): boolean {
  return /^(?:is|are|was|were)\s+\S.*\s(?!or not\b)or\s+(?!not\b)[\p{L}\p{N}'-]+/u.test(normalized)
    || /^(?:is|are|was|were|do|does|did)\s+\S.*\bthan\s+[\p{L}\p{N}'-]+/u.test(normalized)
    || /^(?:is|are|was|were)\s+(?:(?:a|an|the)\s+)?(?:(?!(?:in|on|at|to|of|for|with|from|by|about)\b)[\p{L}\p{N}'-]+\s+){1,4}(?:(?:really|actually|also|still)\s+)?(?:a|an|the|one of the|part of the|kind of|type of)\s+[\p{L}\p{N}'-]+/u.test(normalized);
}

export function preferGeneralKnowledgeFallback(evidence: FallbackRouteEvidence): boolean {
  return evidence.knowledge >= 4 && evidence.knowledge >= evidence.house + 2;
}

// --- Shared readings -------------------------------------------------------------

/** House-versus-knowledge evidence for an unclaimed question, read once. */
export function fallbackEvidence(turn: OwnerTurn, routes: BasicBrainRouteServices): FallbackRouteEvidence {
  return turn.once("fallbackEvidence", () => fallbackRouteEvidence(turn.transcript, turn.normalized, routes));
}

/** An exact house target that is not a knowledge title, read once. */
export function strongHouseCandidate(turn: OwnerTurn, routes: BasicBrainRouteServices): boolean {
  return turn.once("strongHouseCandidate", () => hasStrongHouseFallbackCandidate(turn.transcript, turn.normalized, routes));
}

/** "Look up...", "check...": an explicit read request. */
function explicitReadRequest(turn: OwnerTurn): boolean {
  return turn.once("explicitReadRequest", () => routingSemanticsAllowReadOnlyToolUse(turn.analysis.semantics)
    && looksLikeExplicitReadRequest(turn.transcript));
}

/** An explicit read request scoped to the house ("check Home Assistant for..."). */
export function explicitLocalSourceScope(turn: OwnerTurn): boolean {
  return explicitReadRequest(turn) && looksLikeLocalReadSourceScope(turn.normalized);
}

/** Knowledge with the turn's stage timings in its notes. */
async function timedKnowledge(ctx: OwnerServices, stage: "current_information" | "general_knowledge"): Promise<BasicResult> {
  const startedAt = Date.now();
  const result = await ctx.knowledge();
  const elapsed = Math.max(0, Date.now() - startedAt);
  return {
    ...result,
    notes: `${result.notes}; handle stages early_knowledge=${ctx.stages.earlyKnowledgeMs} follow_up=${ctx.stages.followUpMs} ${stage}=${elapsed}`,
  };
}

// --- Owners ----------------------------------------------------------------------

/** An exact local Wikipedia title answers before the house is searched, unless open chat carries on. */
export const earlyKnowledgeOwner = {
  id: "early_knowledge",
  tier: "knowledge",
  claim: (turn, ctx) => (!continuesModelChat(turn) && !asksAboutOwnersProject(turn, ctx)) || null,
  async answer(_claim, ctx) {
    const startedAt = Date.now();
    const result = await earlyExactWikipediaKnowledgeResult(ctx.turnId, ctx.turn.surface, ctx.routes, ctx.wikipediaKnowledge);
    ctx.stages.earlyKnowledgeMs = Math.max(0, Date.now() - startedAt);
    return result;
  },
} satisfies Owner<true>;

/** "What is photosynthesis?": stable knowledge grammar that names no house source. */
export const stableKnowledgeOwner = {
  id: "stable_knowledge",
  tier: "knowledge",
  claim: (turn, ctx) => (looksLikeStableKnowledgeGrammar(turn.normalized) && !looksLikeLocalReadSourceScope(turn.normalized) && !asksAboutOwnersProject(turn, ctx)) || null,
  answer: (_claim, ctx) => ctx.knowledge(),
} satisfies Owner<true>;

/** "Who won last night?": current information, looked up when a lookup exists. */
export const currentInformationOwner = {
  id: "current_information",
  tier: "knowledge",
  claim: (turn) => turn.currentInformationResearch || null,
  answer: (_claim, ctx) => timedKnowledge(ctx, "current_information"),
} satisfies Owner<true>;

/** Knowledge evidence clearly outweighs the house. */
export const knowledgeFallbackOwner = {
  id: "knowledge_fallback",
  tier: "knowledge",
  claim: (turn, ctx) => (preferGeneralKnowledgeFallback(fallbackEvidence(turn, ctx.routes)) && !asksAboutOwnersProject(turn, ctx)) || null,
  answer: (_claim, ctx) => timedKnowledge(ctx, "general_knowledge"),
} satisfies Owner<true>;

/**
 * A question that names one of the owner's projects ("what is the garden sensors project about?") is about
 * his project, not the encyclopedia's topic of the same name: it goes on to open chat, which studies
 * his notes.
 */
function asksAboutOwnersProject(turn: OwnerTurn, ctx: OwnerServices): boolean {
  return turn.once("names_owners_project", () => namesProject(turn.normalized, ctx.config.projectsDir));
}

/**
 * "How is the HVAC project going?": a question about one of the owner's projects, by name and as a
 * project, is his project's before any house owner reads "HVAC" as the heater. Open chat studies the
 * notes.
 */
export const ownerProjectOwner = {
  id: "owner_project",
  tier: "explicit",
  claim: (turn, ctx) => (/\bprojects?\b/u.test(turn.normalized) && asksAboutOwnersProject(turn, ctx)) || null,
  answer: (_claim, { openChat }) => openChat(),
} satisfies Owner<true>;

/** A general-knowledge question, a broad stable factual one, or an explicit read request. */
export const generalKnowledgeOwner = {
  id: "general_knowledge",
  tier: "knowledge",
  claim(turn, ctx) {
    const n = turn.normalized;
    if (asksAboutOwnersProject(turn, ctx)) return null;
    return (looksLikeGeneralKnowledgePrompt(n)
      || (
        looksLikeBroadStableFactualQuestion(n)
        && !asksMemory(turn)
        && !looksLikeLocalReadSourceScope(n)
        && !strongHouseCandidate(turn, ctx.routes)
      )
      || explicitReadRequest(turn)) || null;
  },
  answer: (_claim, ctx) => timedKnowledge(ctx, "general_knowledge"),
} satisfies Owner<true>;
