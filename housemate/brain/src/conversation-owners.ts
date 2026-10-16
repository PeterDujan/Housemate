/**
 * Conversation owners: follow-ups on what was just said (the answer
 * trace, a calculation, the dialogue), repeats, and the turns that belong to
 * open chat. Open chat itself lives in `basic-brain-open-chat.ts`.
 */
import {
  declined,
  ok,
  declinedReadFallback,
  type BasicAnswerExplanation,
  type BasicContextFrame,
  type BasicResult,
  type BasicConversationTurn,
} from "./basic-brain-contracts.js";
import { resolveScalarCalculationFollowUp, looksLikeScalarCalculationFollowUp } from "./scalar-calculator.js";
import { joinNatural } from "./text-format.js";
import { NOT_FOLLOW_UP, followUpSteps, looksLikeAnswerExplanationFollowUp } from "./follow-up-turn.js";
import { normalizeSpeechForRouting } from "./speech-normalizer.js";
import { canonicalizeRoutingText, type RoutingDialogueAct } from "./routing-text.js";
import { MODEL_CHAT_DIALOGUE_ACTS, asksMemory, toOpenChat } from "./stateless-owners.js";
import { conversationTurnAllowsModelContext, chatWebSearchActive } from "./basic-brain-open-chat.js";
import { looksLikeEphemeralTimedPrompt, looksLikePersonalAdvicePrompt, looksLikeStableKnowledgeGrammar } from "./basic-brain-knowledge.js";
import type { Owner, OwnerTurn } from "./router.js";
import { catchupScope } from "./basic-brain-event-log.js";

export function calculationFollowUpAnswer(frame: Extract<BasicContextFrame, { kind: "calculation" }>, normalized: string): BasicResult {
  if (!Number.isFinite(frame.value)) {
    return declined("calculation", "I don't have a single calculator value to transform from that answer.", "scalar calculation follow-up missing numeric value");
  }
  const previousValue = frame.value as number;
  const followUp = resolveScalarCalculationFollowUp(previousValue, normalized);
  if (!followUp) {
    return declined("calculation", "I couldn't attach that calculator follow-up cleanly.", "scalar calculation follow-up not understood");
  }
  return ok(
    "calculation",
    followUp.text,
    "scalar calculation follow-up from prior result",
    { kind: "calculation", expression: frame.expression, value: followUp.value },
    { kind: "calculation", statement: followUp.text },
  );
}

export function answerExplanationFollowUp(explanation: BasicAnswerExplanation, normalized: string): BasicResult {
  if (/^(?:what (?:do|did) you mean|what does (?:that|this|it) mean)\??$/.test(normalized)) {
    const target = explanation.targetLabel
      ?? explanation.sourceLabels[0]
      ?? "the previous answer";
    const sourceDetails = explanation.sourceEntityIds.length === 1
      ? ` (${explanation.sourceEntityIds[0] as string})`
      : "";
    return {
      ...ok(
        "open_conversation",
        `I meant the previous answer was about ${target}. I got that from ${explanation.sourceSummary}${sourceDetails}.`,
        "contextual meaning repair from previous answer trace",
      ),
      preservePendingClarifier: true,
    };
  }
  const wantsSources = /\b(source|sources|use|used|come from)\b/.test(normalized);
  const wantsWhy = /\bwhy|explain|how do you know\b/.test(normalized);
  const sourceLabelText = explanation.sourceLabels.length > 0 ? joinNatural(explanation.sourceLabels.slice(0, 4)) : explanation.sourceSummary;
  const sourceSentence = `I used ${explanation.sourceSummary}${sourceLabelText ? `: ${sourceLabelText}` : ""}.`;
  const whySentence = `${explanation.reason} Confidence was ${explanation.confidence}.`;
  const text = wantsSources && wantsWhy
    ? `${whySentence} ${sourceSentence} ${explanation.actionBoundary}`
    : wantsSources
      ? `${sourceSentence} ${explanation.actionBoundary}`
      : `${whySentence} ${sourceSentence} ${explanation.actionBoundary}`;
  return {
    ...ok("open_conversation", text, "answer explanation follow-up"),
    preservePendingClarifier: true,
  };
}

// --- Follow-ups ------------------------------------------------------------------

/** While the talk itself is the focus, only "back to..." follows an older frame. */
export const OPEN_CHAT_FOLLOW_UPS = followUpSteps("open_chat", {
  dialogueFocus(f) {
    return !f.returnsToPriorFocus && f.activeFocusDomain === "dialogue" ? NOT_FOLLOW_UP : null;
  },
  deliveryRepair(f) {
    return /\b(don t answer|do not answer|answer with)\b/.test(f.normalized)
      ? ok("open_conversation", "Got it.", "follow-up delivery repair acknowledged without forcing a sourced lookup")
      : null;
  },
});

/** "Why?", "how do you know?": the sources of the last sourced answer. */
export const ANSWER_TRACE_FOLLOW_UPS = followUpSteps("answer_trace", {
  explanation(f) {
    if (!looksLikeAnswerExplanationFollowUp(f.normalized)) return null;
    const explanation = f.views.answerTrace.latest?.explanation ?? null;
    return explanation
      ? answerExplanationFollowUp(explanation, f.normalized)
      : declined("open_conversation", "I don't have a previous sourced answer to explain.", "explanation follow-up declined without trace");
  },
});

/** "Times two?": the last calculator value transformed. */
export const CALCULATION_FOLLOW_UPS = followUpSteps("scalar_calculation", {
  calculation(f) {
    const frame = f.calculationFrame;
    return frame && looksLikeScalarCalculationFollowUp(f.normalized) ? calculationFollowUpAnswer(frame, f.normalized) : null;
  },
});

export function hasActiveModelConversation(turns: readonly BasicConversationTurn[]): boolean {
  const latest = turns.at(-1);
  return latest?.status === "ok"
    && latest.modelUsed === true
    && conversationTurnAllowsModelContext(latest)
    && (latest.route === "open_conversation" || latest.route === "general_knowledge");
}

export function shouldContinueActiveModelConversation(
  surface: string,
  dialogueAct: RoutingDialogueAct | null,
  turns: readonly BasicConversationTurn[],
): boolean {
  if (!hasActiveModelConversation(turns)) {
    return false;
  }
  const normalized = canonicalizeRoutingText(
    normalizeSpeechForRouting(surface, { preservePragmaticPrefaces: true }),
  );
  if (/\b(?:change of subject|different subject|new topic)\b/.test(normalized)
    || explicitLiveOrHouseRequest(normalized)) {
    return false;
  }
  if (dialogueAct && MODEL_CHAT_DIALOGUE_ACTS.has(dialogueAct)) {
    return true;
  }
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (wordCount > 18) {
    return false;
  }
  return /^(?:why|why not|how so|go on|keep going|really|surely|explain|explain that|what do you mean|what makes you say that|and why|but why|so what|is that fair|does that follow)\??$/.test(normalized)
    || /^(?:no )?(?:you are wrong|that(?: answer| response)? is (?:wrong|not right|off)|this(?: answer| response)? is (?:wrong|not right|off)|you misunderstood(?: me)?)\b/.test(normalized)
    || /^i (?:still )?(?:disagree|do not agree)\b/.test(normalized)
    || /^(?:and|but|so|then|also|still|actually|fine|okay|right)\b/.test(normalized)
    || /^(?:what|how) about\b/.test(normalized)
    || /\b(?:that|this|it|them|those|your point|my point|the point)\b/.test(normalized);
}

function explicitLiveOrHouseRequest(normalized: string): boolean {
  return /\b(?:weather|forecast|temperature|temp|calendar|schedule|appointment|reminder|alarm|timer|lights?|lamp|door|lock|garage|fan|heater|switch|sensor|outlet|power|electricity|energy|solar|grid|battery|music|song|volume)\b/.test(normalized);
}

export function deterministicAnswerReference(
  normalized: string,
  conversationTurns: readonly BasicConversationTurn[],
): BasicResult | null {
  const previousTurn = conversationTurns.at(-1) ?? null;
  const previous = previousTurn?.responseText.trim() ?? "";
  if (!previous) {
    return null;
  }
  const asksRepeat = /^(?:say|repeat|tell me) (?:that|it)(?: again| once more)?$/.test(normalized)
    || /^(?:what did you (?:say|just say))$/.test(normalized);
  const asksClarity = /\b(?:more simply|simpler|plain english|shorter|clarify that)\b/.test(normalized);
  if (
    previousTurn?.route === "agentic_read"
    && (asksRepeat || asksClarity)
  ) {
    return declinedReadFallback(
      "agentic_read",
      "I couldn't refresh that answer from the live sources.",
      "agentic read references must be replanned from fresh evidence rather than replayed",
      "cross_source_read_required",
    );
  }
  if (asksRepeat) {
    return {
      ...ok("open_conversation", previous, "repeated the immediately previous visible answer"),
      modelContextAllowed: previousTurn
        ? conversationTurnAllowsModelContext(previousTurn)
        : false,
    };
  }
  if (asksClarity) {
    return {
      ...ok("open_conversation", previous, "restated the immediately previous visible answer without a new lookup"),
      modelContextAllowed: previousTurn
        ? conversationTurnAllowsModelContext(previousTurn)
        : false,
    };
  }
  return null;
}

export function looksLikeLivePublicListingsQuestion(normalized: string): boolean {
  if (!looksLikeEphemeralTimedPrompt(normalized)) {
    return false;
  }
  const explicitScreeningRequest = /\b(?:session|sessions|screening|screenings|showtime|showtimes)\b/.test(normalized)
    || (
      /\b(?:playing|showing|screening)\b/.test(normalized)
      && /\b(?:movie|movies|film|films|cinema|theatre|theater)\b/.test(normalized)
    );
  const venueHoursRequest = /\b(?:open|opening|close|closing|hours)\b/.test(normalized)
    && /\b(?:cinema|theatre|theater|restaurant|cafe|shop|store|venue|mall)\b/.test(normalized);
  return explicitScreeningRequest || venueHoursRequest;
}

// --- Owners ----------------------------------------------------------------------

/**
 * The model was just talking and this turn carries on that talk ("why?",
 * "go on", "and what about you?"). A catch-up ask, a memory question, current
 * information and stable knowledge grammar are not carries.
 */
export function continuesModelChat(turn: OwnerTurn): boolean {
  return turn.once("continuesModelChat", () => !turn.currentInformationResearch
    && !asksMemory(turn)
    && catchupScope(turn.normalized) === null
    && !looksLikeStableKnowledgeGrammar(turn.normalized)
    && shouldContinueActiveModelConversation(
      turn.analysis.surface,
      turn.analysis.dialogueAct ?? turn.analysis.dialoguePrefix,
      turn.conversationTurns,
    ));
}

/** "Say that again": the last deterministic answer, repeated. */
export const repeatedAnswerOwner = {
  id: "repeated_answer",
  tier: "continuation",
  claim: (turn) => deterministicAnswerReference(turn.normalized, turn.conversationTurns),
  answer: (result) => result,
} satisfies Owner<BasicResult>;

/** The model's talk carries on with the whole spoken turn. */
export const modelChatOwner = {
  id: "model_chat",
  tier: "continuation",
  claim: (turn) => continuesModelChat(turn) || null,
  answer: (_claim, ctx) => ctx.openChat(ctx.turn.analysis.surface),
} satisfies Owner<true>;

/** "Should I take the job?": personal advice is conversation. */
export const personalAdviceOwner = toOpenChat("personal_advice", "conversation", (turn) => looksLikePersonalAdvicePrompt(turn.normalized));

/** "What's on at the cinema tonight?": open chat when it may search the web, otherwise an honest decline. */
export const liveListingsOwner = {
  id: "live_listings",
  tier: "unsupported",
  claim: (turn) => looksLikeLivePublicListingsQuestion(turn.normalized) || null,
  answer: (_claim, ctx) => chatWebSearchActive(ctx.config)
    ? ctx.openChat()
    : declined(
      "open_conversation",
      "I don't have a live public listings source for that yet.",
      "time-anchored public listings requested without a supported source",
    ),
} satisfies Owner<true>;

// At this point every owning follow-up/domain has had first refusal. An
// unresolved hypothetical or reported house-state frame must not fall into
// exact-target or generic house-fact routing merely because it names a device.
export const mentionOwner = toOpenChat("mention", "conversation", (turn) => turn.analysis.semantics.use === "mention"
  || turn.analysis.semantics.world !== "actual");

// Research-worthy questions need the Codex research call, which the Claude
// backend lacks; with chat web search on, open chat searches instead.
export const webSearchChatOwner = {
  id: "web_search_chat",
  tier: "conversation",
  claim: (turn, ctx) => (turn.currentInformationResearch && chatWebSearchActive(ctx.config)) || null,
  answer: (_claim, ctx) => ctx.openChat(),
} satisfies Owner<true>;

/** Everything no other owner claimed. */
export const openChatOwner = toOpenChat("open_chat", "conversation", () => true);
