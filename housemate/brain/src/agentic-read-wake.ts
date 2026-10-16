import { lexiconTags, type LexiconTag } from "./lexicon.js";
import type { ReadAgentFallbackReason } from "./read-agent-contracts.js";
import {
  asksAboutConversation,
  looksLikeDataMutationRequest,
  looksLikeGenericKindQuestion,
  routingSemanticsAllowReadOnlyToolUse,
  type RoutingSemantics,
} from "./routing-text.js";

/** Why a declined, fallback-eligible turn stays with its deterministic answer. */
export type ReadAgentWakeRefusal =
  | "not_a_read"
  | "conversation"
  | "repair"
  | "generic"
  | "no_time_window"
  | "action_route";

/** Routes whose declines are never recovered by reading: they act or schedule. */
const ACTING_ROUTES: ReadonlySet<string> = new Set([
  "entity_action",
  "music_playback",
  "alarm_clock",
  "deferred_watch",
]);

/**
 * The read agent wakes only for a direct question about this house that one
 * of its read tools can reach. Its only
 * real run in 90 days was a question about the conversation that reached it
 * through the word "water"; every rule here is grammar, lexicon or source
 * reach, never a phrase:
 *
 * - The speaker asks a read of the actual world (speech act and modality),
 *   not about the conversation: what either side said or meant
 *   (`asksAboutConversation`). Routing may still answer "what did you say
 *   about the office lights" by reading them again; the agent cannot see the
 *   conversation, so it is not woken for it.
 * - The turn is not repairing the conversation (lexicon repair markers,
 *   anywhere in the turn): that belongs to the correction flow and open chat.
 * - The question is about this house, not a kind of thing ("how much gas
 *   does a car use"): an indefinite subject with nothing tying it to the
 *   household (`looksLikeGenericKindQuestion`).
 * - A history read needs a time window: without the canonical window every
 *   history, statistics and calendar tool is closed to the agent, so waking
 *   it can only burn a planning round before the same decline.
 * - The route only reads, and the words ask for no change to data.
 */
export function readAgentWakeRefusal(input: {
  readonly route: string;
  readonly fallbackReason: ReadAgentFallbackReason;
  readonly semantics: RoutingSemantics;
  readonly tags: readonly LexiconTag[];
  readonly normalizedSurface: string;
  readonly canonicalTimeWindow: object | null;
}): ReadAgentWakeRefusal | null {
  if (ACTING_ROUTES.has(input.route) || looksLikeDataMutationRequest(input.semantics.core)) {
    return "action_route";
  }
  if (!routingSemanticsAllowReadOnlyToolUse(input.semantics)) {
    return input.semantics.use === "mention" && input.semantics.priorConversation
      ? "conversation"
      : "not_a_read";
  }
  if (asksAboutConversation(input.semantics.coreSurface)) {
    return "conversation";
  }
  if (input.tags.includes("repair") || lexiconTags(input.normalizedSurface).includes("repair")) {
    return "repair";
  }
  if (looksLikeGenericKindQuestion(input.semantics.core)) {
    return "generic";
  }
  if (input.fallbackReason === "historical_state_required" && input.canonicalTimeWindow === null) {
    return "no_time_window";
  }
  return null;
}
