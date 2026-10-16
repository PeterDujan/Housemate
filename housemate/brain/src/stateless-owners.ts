/**
 * Owners that need no context frame: each claims a turn from its
 * own words and answers it from its own source. The table and its order live
 * in `router.ts`.
 */
import { join } from "node:path";

import { canonicalHouseholdActorId } from "./actor-identity.js";
import { AgentQuestionBox, nextQuestion, parseQuestionTurn, pullReply, questionLine, type QuestionTurn } from "./agent-questions.js";
import { assistantSelfAnswer, type AssistantSelfContext } from "./assistant-self-knowledge.js";
import { selfGrowthSummary } from "./self-growth.js";
import { looksLikeAssistantSelfOpinionPrompt } from "./assistant-self-opinion.js";
import {
  contentInstructionLead,
  parseAssistantSelfQuestion,
  parseAssistantSystemIntent,
  parseBasicSpeakerIdentityIntent,
  parseBasicSystemHealthIntent,
} from "./assistant-system-intent.js";
import {
  conversationStartedAt,
  declined,
  declinedReadFallback,
  ok,
  resultId,
  withReadFallback,
  withheld,
  type BasicConversationTurn,
  type BasicResult,
} from "./basic-brain-contracts.js";
import { buildEventLogAnswer, looksLikeEventLogQuestion } from "./basic-brain-event-log.js";
import { buildHouseSummaryAnswer, looksLikeHouseSummaryQuestion } from "./basic-brain-house-summary.js";
import {
  basicMemoryResultWithHistoricalPresence,
  guestMemoryDecline,
  MEMORY_NO_MATCH_NOTE,
  looksLikeMemoryQuery,
  looksLikePersonalMemoryQuestion,
  memoryAnswer,
} from "./basic-brain-memory.js";
import { looksLikeEnergyBudgetQuestion, looksLikeHistoryMetricQuestion, resolveMetricQuestion } from "./basic-brain-metrics.js";
import { looksLikeCalendarQuestion, looksLikeTodoQuestion } from "./basic-brain-schedule.js";
import { catchupServices } from "./basic-brain-services.js";
import {
  guestPersonalStatusDecline,
  looksLikeExplicitStatusTargetObject,
  parseCurrentStatusPlan,
  resolveStatusTarget,
} from "./basic-brain-status.js";
import { checkInSentence } from "./basic-speech-response.js";
import { loadCatchupSourcesConfig } from "./catchup-digest.js";
import type { AppConfig } from "./config.js";
import { BASIC_CURRENT_TIMEZONE, parseCurrentTimeIntent, type CurrentTimeField } from "./current-time-intent.js";
import { episodicQuestionActionTerms } from "./episodic-memory-query.js";
import { hasEvaluativeComplement } from "./evaluative-judgement.js";
import { looksLikeGlobalLightsStatus } from "./house-lights-status-intent.js";
import { housePatternAnswer } from "./house-pattern-catalog.js";
import { parsePresenceRollCall, presenceRollCallAnswer } from "./house-presence.js";
import { parseSecurityRollCall, securityRollCallAnswer, securitySources } from "./house-security.js";
import { doorbellAnswer, doorbellSources, doorbellTimeFollowUp, parseDoorbellAsk, type DoorbellAsk } from "./house-doorbell.js";
import { FOLLOW_UP_FRAGMENT_MAX_WORDS, QUESTION_LEAD_PATTERN, REPAIR_MARKER_PATTERN } from "./lexicon.js";
import type {
  LocalMediaAgentReadResult,
  LocalMediaKind,
  LocalMediaListItem,
  LocalMediaRecommendation,
  LocalMediaSourceObservation,
} from "./local-media-catalog.js";
import { SHORT_FILM_MINUTES } from "./local-media-catalog.js";
import { memoryArchiveActive } from "./memory-archive.js";
import {
  explicitRememberContent,
  honestRememberReply,
  MEMORY_REFLECTION_LIMITS,
  memoryReflectionActive,
  memoryReflectionActorId,
  memoryWriteAdmitted,
} from "./memory-reflection.js";
import { configuredModelSkipReason } from "./model-backend.js";
import { deviceControlLive, voiceListSummary } from "./device-control.js";
import type { Owner, OwnerTurn, Tier, OwnerServices } from "./router.js";
import { normalizeMeasuredRoutingText, parseRoutingUtterance, type RoutingDialogueAct } from "./routing-text.js";
import { resolveScalarCalculation, resolveUnsupportedMathPrompt } from "./scalar-calculator.js";
import { selfTasteAnswer, selfTasteChangesAnswer } from "./self-taste.js";
import { isGuestSpeakerRequest, trustedSpeakerLabel, trustedSpeakerPersonId } from "./speaker-principal.js";
import { dialogueActTone } from "./speech-tone.js";
import { joinNatural, spokenWordCount } from "./text-format.js";
import type { VoiceBrainRequest } from "./voice-brain.js";
import { looksLikeSubjectiveOpinionPrompt } from "./wikipedia-knowledge-store.js";
import type { ReadAgentFallbackReason } from "./read-agent-contracts.js";
import { householdRegex } from "./household.js";
import { HOUSE_LOCALE } from "./house-config.js";

/** A reply written by code, numbered for the turn. */
function codeReply(turnId: string, text: string, notes: string): BasicResult {
  return { ...ok("open_conversation", text, notes), resultId: resultId(turnId) };
}

/** Hands the turn to open chat when holds. */
export function toOpenChat(id: string, tier: Tier, asks: (turn: OwnerTurn) => boolean): Owner<true> {
  return { id, tier, claim: (turn) => asks(turn) || null, answer: (_claim, { openChat }) => openChat() };
}

/** Answers with one code reply when holds. */
export function fixedReply(
  id: string,
  tier: Tier,
  asks: (turn: OwnerTurn, ctx: OwnerServices) => boolean,
  reply: () => BasicResult,
): Owner<true> {
  return { id, tier, claim: (turn, ctx) => asks(turn, ctx) || null, answer: reply };
}

/** Reads its source when holds; a decline is offered to the read agent for `reason`. */
export function sourceRead(
  id: string,
  tier: Tier,
  asks: (turn: OwnerTurn, ctx: OwnerServices) => boolean,
  read: (ctx: OwnerServices) => BasicResult | Promise<BasicResult>,
  reason: ReadAgentFallbackReason,
): Owner<true> {
  return { id, tier, claim: (turn, ctx) => asks(turn, ctx) || null, answer: async (_claim, ctx) => withReadFallback(await read(ctx), reason) };
}

// --- Protocol --------------------------------------------------------------------

// "Forget what I said about X" and "don't keep that". A bare
// "forget that" stays the "never mind" dialogue act; the archive still drops
// the words before it.
const forgetTopicPattern = (): RegExp => householdRegex(String.raw`^(?:(?:hey\s+)?{ASSISTANT}[,.\s]+)?(?:please[,\s]+)?(?:(?:can|could|would) you (?:please )?)?(?:forget|(?:don't|do not) (?:keep|remember)|stop remembering) (?:what|everything|anything|all) (?:that )?(?:i|i've|i have) (?:ever |just )?(?:said|told you|mentioned|say|tell you)(?: to you)? about (.+?)(?:,?\s*please)?[.!?\s]*$`, "i");

const forgetRecentPattern = (): RegExp => householdRegex(String.raw`^(?:(?:hey\s+)?{ASSISTANT}[,.\s]+)?(?:please[,\s]+)?(?:(?:can|could|would) you (?:please )?)?(?:forget (?:what i (?:just )?(?:said|told you)|(?:that )?i (?:just )?(?:said|told you|mentioned) (?:that|it|this))|(?:don't|do not) (?:keep|remember|hang on to|hold on to|save) (?:that|this|what i (?:just )?said))(?:,?\s*please)?[.!?\s]*$`, "i");

/**
 * A household forget, answered by code: one `forget` lets go of the
 * speaker's kept words, their searchable turns, held items and reflected facts
 * resting only on those turns in one transaction, then tells any chat not yet
 * reflected on and the corrections ledger, before the assistant says so.
 */
/**
 * Questions Claude and Codex left for a household member. A pull reads
 * the next one out; the turn right after it is the answer, kept word for word
 * (or skip / stop / repeat). First in the table, so an answer is never taken
 * as a command. Recognised household voices on a real client only.
 */
export const agentQuestionOwner = {
  id: "agent_question",
  tier: "protocol",
  claim(turn, { config }) {
    const actorId = memoryWriteAdmitted(turn.request) ? memoryReflectionActorId(turn.request) : null;
    const box = new AgentQuestionBox(config.questionsDir || join(config.dataDir, "questions"));
    const previous = actorId ? turn.conversationTurns.at(-1)?.responseText ?? null : null;
    const parsed = parseQuestionTurn(turn.normalized, previous, () => (actorId ? box.pending(actorId) : []));
    return parsed ? { parsed, actorId, box } : null;
  },
  answer({ parsed, actorId, box }: { parsed: QuestionTurn; actorId: string | null; box: AgentQuestionBox }, { turn, turnId, now }) {
    if (!actorId) {
      return codeReply(turnId, "I can only pass those on to someone I recognise.", "agent questions: speaker not recognised or not a household client");
    }
    if (parsed.kind === "pull") {
      return codeReply(turnId, pullReply(box.pending(actorId), parsed.from), `agent questions: pull from=${parsed.from ?? "any"}`);
    }
    const { question, control } = parsed;
    if (control === "repeat") return codeReply(turnId, questionLine(question), `agent questions: repeat ${question.id}`);
    if (control === "stop") return codeReply(turnId, "Certainly. They will keep.", `agent questions: stopped at ${question.id}`);
    const answer = turn.request.transcript.trim().replace(householdRegex(String.raw`^(?:hey\s+)?{ASSISTANT}[\s,.!]+`, "i"), "");
    box.record(question, control === "skip" ? { skipped: true } : { answer }, actorId, now());
    const next = nextQuestion(box.pending(actorId), null);
    const lead = control === "skip" ? "Skipped." : "Got it.";
    return codeReply(
      turnId,
      next ? `${lead} Next, ${questionLine(next)}` : `${lead} That's all of them.`,
      `agent questions: ${control === "skip" ? "skipped" : "answered"} ${question.id}`,
    );
  },
} satisfies Owner<{ parsed: QuestionTurn; actorId: string | null; box: AgentQuestionBox }>;

export const forgetOwner = {
  id: "forget",
  tier: "protocol",
  claim(turn, ctx) {
    if (!ctx.memoryArchive) return null;
    const text = turn.request.transcript.trim().replace(/[’]/g, "'");
    const topicMatch = forgetTopicPattern().exec(text);
    if (!topicMatch && !forgetRecentPattern().test(text)) return null;
    return { topic: topicMatch?.[1]?.trim().replace(/[.!?,]+$/, "") ?? "" };
  },
  answer({ topic }, { turn, turnId, memoryArchive, correctionLedger, now }) {
    const actorId = memoryReflectionActorId(turn.request);
    if (!memoryArchive || !actorId || !memoryWriteAdmitted(turn.request)) {
      return codeReply(turnId, "I can only do that for someone I recognise.", "forget request from an unverified speaker or non-household source");
    }
    const forgotten = memoryArchive.memory.forget({
      actorId,
      ...(topic ? { topic } : {}),
      chat: turn.request,
      now: now(),
      corrections: correctionLedger ?? null,
    });
    const held = forgotten.turnIds.length > 0;
    const about = secondPersonTopic(topic);
    const reply = topic
      ? held ? `Done. I've let go of what you said about ${about}.` : `I wasn't keeping anything you said about ${about}.`
      : held ? "Done. I won't keep that." : "There's nothing from just now for me to let go of.";
    return codeReply(turnId, reply, `forget request answered by code: turns=${forgotten.turnIds.length} kept=${forgotten.kept} facts=${forgotten.facts}`);
  },
} satisfies Owner<{ readonly topic: string }>;

function seeYa(speakerName: string | null | undefined): string {
  return speakerName ? `Goodbye, ${speakerName}.` : "Goodbye.";
}

function secondPersonTopic(topic: string): string {
  const swaps: Readonly<Record<string, string>> = { my: "your", me: "you", mine: "yours", myself: "yourself", i: "you", "i'm": "you're", our: "your", us: "you" };
  return topic.split(/\s+/).map((word) => swaps[word.toLowerCase()] ?? word).join(" ");
}

/** Mid-chat, these acts are the model's to answer: they react to what it said, and the chat goes on. */
export const MODEL_CHAT_DIALOGUE_ACTS: ReadonlySet<RoutingDialogueAct> = new Set([
  "acknowledge", "agree", "disagree", "rephrase", "resume", "apology", "compliment",
]);

/** Stop, goodbye, cancel, thanks, hello and the other standalone dialogue acts. */
export const dialogueActOwner = {
  id: "dialogue_act",
  tier: "protocol",
  claim(turn) {
    const act = turn.analysis.dialogueAct;
    if (!act) return null;
    const modelChat = turn.activeModelConversation && turn.analysis.routing.dialogueResponsePolicy === "contextual";
    return modelChat && MODEL_CHAT_DIALOGUE_ACTS.has(act) ? null : act;
  },
  answer(act, { turn }) {
    const speakerName = turn.request.speaker.name;
    const answer: Record<RoutingDialogueAct, string> = {
      cancel: "Certainly.",
      stop: "Okay, I'll stop.",
      gratitude: "You are welcome.",
      acknowledge: "Good, we're on the same page.",
      agree: "Good, got it.",
      disagree: "Sorry, I got that wrong. Go ahead and correct me.",
      rephrase: "Go ahead, I'm listening.",
      hold: "Okay, I'll wait.",
      resume: "Okay, continue.",
      attention: "Yes, I'm here. Go ahead.",
      greet: speakerName ? `Hello, ${speakerName}.` : "Hello.",
      check_in: checkInSentence(speakerName ?? null),
      goodbye: seeYa(speakerName),
      apology: "It is quite all right.",
      compliment: "Thanks, glad that helped.",
      capability: "Yes, I can hear you and I'm listening.",
    };
    const closes = act === "stop" || act === "goodbye";
    const clearsContext = closes || act === "cancel";
    return {
      ...ok(
        "open_conversation",
        answer[act],
        `deterministic dialogue act: ${act}`,
        null,
        act === "check_in" ? { kind: "check_in", speakerName: speakerName ?? null } : null,
      ),
      tone: dialogueActTone(act),
      ...(closes ? { sessionDirective: "close" as const } : {}),
      ...(clearsContext ? { resetContext: true } : {}),
    };
  },
} satisfies Owner<RoutingDialogueAct>;

/** Nothing left once fillers are gone. Mid-chat a bare "Okay." hands the turn back. */
export const emptyTurnOwner = {
  id: "empty_turn",
  tier: "protocol",
  claim: (turn) => (turn.normalized ? null : true),
  answer: (_claim, { turn, openChat }) => (turn.surface && turn.activeModelConversation
    ? openChat(turn.surface)
    : declined("open_conversation", "I need words before I can do anything useful.", "empty transcript")),
} satisfies Owner<true>;

// An indirect question is still a request: "that's just asking what the
// temperature is", "I was wondering whether...", "let me know when...".
const INDIRECT_REQUEST = /\b(?:ask(?:ing|ed)?|wonder(?:ing|ed)?|know|tell me|check|find out|see)\b(?:\s+\S+){0,3}?\s+(?:what|which|whether|if|how|when|where|who)\b/u;

// "I'm asking about you, not a device." narrows the question just asked.
const QUESTION_SCOPE_CLARIFICATION = /^(?:i(?:'m| am) (?:asking|talking) (?:about|after|for)|i mean(?:t)?)\b/iu;

/**
 * A household request is one sentence. When a turn runs to several sentences
 * and the last is not itself a question or instruction, the turn is
 * conversation: house, system and follow-up routes match keywords anywhere in
 * the text, so any of them could otherwise claim it ("...but that's okay"
 * read as "is that normal?", "...our conversation... Who he was" as "who am I?").
 * Telling rather than asking is a speech act, so this is protocol.
 */
function isConversationalDiscourse(surface: string): boolean {
  const sentences = surface.trim().split(/(?<=[.!?])\s+/u).filter((sentence) => sentence.trim());
  while (
    sentences.length > 1
    && sentences.at(-2)?.trim().endsWith("?")
    && QUESTION_SCOPE_CLARIFICATION.test(sentences.at(-1)?.trim().replace(/[’]/gu, "'") ?? "")
  ) {
    sentences.pop();
  }
  const last = sentences.at(-1)?.trim() ?? "";
  if (sentences.length < 2 || last.endsWith("?")) {
    return false;
  }
  const force = parseRoutingUtterance(last).semantics.force;
  if (force === "query" || force === "command" || INDIRECT_REQUEST.test(last.toLowerCase())) {
    return false;
  }
  // "No. The office one." is a short correction, not discourse.
  return !(force === "fragment" && spokenWordCount(last) <= FOLLOW_UP_FRAGMENT_MAX_WORDS);
}

export const discourseOwner = toOpenChat("discourse", "protocol", (turn) => isConversationalDiscourse(turn.surface));

/**
 * "Are you aware I asked you about the electricity?" is about the
 * conversation, not a live read: chat answers it with recall in hand.
 */
export const priorConversationOwner = toOpenChat(
  "prior_conversation",
  "protocol",
  (turn) => turn.analysis.semantics.use === "mention" && turn.analysis.semantics.priorConversation,
);

/** Words from which a turn that only tells counts as long. */
const LONG_STATEMENT_MIN_WORDS = 12;

/**
 * A long turn made only of statements: every sentence, read whole with its
 * commas neutralised so an appended or relative clause cannot pose as a
 * question, is a statement, dialogue or fragment, and none ends in a
 * question mark. One sentence that asks or commands keeps the turn on the
 * normal routes, so real questions mid-chat still get fast answers.
 */
function isLongStatementTurn(surface: string): boolean {
  if (spokenWordCount(surface) < LONG_STATEMENT_MIN_WORDS) {
    return false;
  }
  return surface.split(/(?<=[.!?])\s+/u).map((sentence) => sentence.trim()).filter(Boolean).every((sentence) => {
    if (/\?\s*$/u.test(sentence)) {
      return false;
    }
    const act = parseRoutingUtterance(sentence.replace(/[,;:—–]+/gu, " ")).speechAct;
    return act === "statement" || act === "dialogue" || act === "fragment";
  });
}

/** Inside a model chat, a long turn that only tells is talk, not a house question that shares its words. */
export const longStatementOwner = toOpenChat(
  "long_statement",
  "protocol",
  (turn) => turn.activeModelConversation && isLongStatementTurn(turn.surface),
);

/** A turn opening with a wh-word or question auxiliary is asking, not commenting. */
const QUESTION_LEAD = new RegExp(String.raw`^${QUESTION_LEAD_PATTERN}\b`);

function looksLikeOperatorCommentary(normalized: string): boolean {
  return !QUESTION_LEAD.test(normalized)
    && (
      (/^(?:(?:it|that|this)\s+(?:is|was|sounds?|looks?|seems?|makes)\b|things?\s+(?:are|were|look|looks|seem|seems)\b)/.test(normalized)
        && /\b(ok|okay|fine|alright|cool|good|bad|great|thanks?|cheers|makes sense|not bad|no problem|fair enough|no worries|do not stress|don t stress)\b/.test(normalized))
      || /^(?:never mind(?: then)?|forget that(?: then)?|drop it then|scrap that then|do not worry then|dont worry then|don t worry then|no worries(?: that is| thats)? alright|(?:that )?sounds fine to me|fine by me|leave it then|leave it there|okay that is not bad|fair enough that makes sense|that will do|all good then|done with that|no answer like a person)$/.test(normalized)
    );
}

/** "That's fine", "fair enough", "never mind then". */
export const operatorCommentaryOwner = {
  id: "operator_commentary",
  tier: "protocol",
  claim: (turn) => (looksLikeOperatorCommentary(turn.normalized) ? turn.normalized : null),
  answer: (normalized) => ok(
    "open_conversation",
    /\banswer like a person\b/.test(normalized)
      ? "Sure, I'll keep it natural."
      : /\b(makes sense|fair enough)\b/.test(normalized)
        ? "Glad it makes sense."
        : /\b(no worries|never mind|forget that|drop it|scrap that|do not worry|dont worry|don t worry|fine|alright|not bad|sounds fine)\b/.test(normalized)
          || /^(?:fine by me|leave it then|leave it there|that will do|all good then|done with that)$/.test(normalized)
          ? "Certainly."
          : "Okay.",
    "operator commentary handled without model fallback",
  ),
} satisfies Owner<string>;

function looksLikeVoiceUxCommentary(normalized: string): boolean {
  return !QUESTION_LEAD.test(normalized)
    && !contentInstructionLead().test(normalized)
    && /\b(?:voice|audio|mic|microphone|hear|hearing|heard|understand|understanding|transcript|recognition|recognise|recognize|stt)\b/.test(normalized)
    && /\b(?:can|cannot|can not|could|could not|couldn t|couldnt|now|again|better|changed|change|working|fixed|problem|issue|wrong|fine|okay|ok|all good|never mind|it was|it s|thats|that s)\b/.test(normalized);
}

/** Talk about the voice and hearing; inside a model chat it is conversation. */
export const voiceCommentaryOwner = fixedReply(
  "voice_commentary",
  "protocol",
  (turn) => looksLikeVoiceUxCommentary(turn.normalized) && !turn.activeModelConversation,
  () => ok("open_conversation", "Got it.", "voice UX commentary handled without forcing follow-up repair"),
);

/**
 * "Remember that..." gets a code-owned answer: the assistant only says he will keep
 * something when post-chat reflection will actually store or hold it. Open
 * chat asks this too.
 */
export function explicitRememberAnswer(options: {
  readonly request: VoiceBrainRequest;
  readonly turnId: string;
  readonly config: AppConfig;
}): BasicResult | null {
  return explicitRememberContent(options.request.transcript)
    ? codeReply(options.turnId, honestRememberReply(options.request, memoryReflectionActive(options.config)), "explicit remember request answered by code")
    : null;
}

export const rememberOwner = {
  id: "remember",
  tier: "protocol",
  claim: (turn, ctx) => explicitRememberAnswer({ request: turn.request, turnId: ctx.turnId, config: ctx.config }),
  answer: (reply) => reply,
} satisfies Owner<BasicResult>;

function looksLikeStopStatement(normalized: string): boolean {
  return /^(?:ok |okay |oh my god |all good |we can )?(?:stop|stop it|stop there|stop talking|shut up|enough|that s enough|thats enough|cancel|never mind|nevermind)(?: please| thanks| thank you)?\.?$/.test(normalized);
}

export const stopOwner = fixedReply("stop", "protocol", (turn) => looksLikeStopStatement(turn.normalized), () => ({
  ...ok("open_conversation", "Okay, I'll stop.", "stop/frustration statement handled without model fallback"),
  sessionDirective: "close" as const,
}));

function looksLikeGoodbyeStatement(normalized: string): boolean {
  return householdRegex(String.raw`^(?:ok |okay |alright |right |sweet )?(?:see you|see ya|bye|bye bye|by by|buy buy|goodbye|catch you later|talk later)(?: mate| {ASSISTANT}| {OWNER})?\.?$`).test(normalized);
}

export const goodbyeOwner = {
  id: "goodbye",
  tier: "protocol",
  claim: (turn) => (looksLikeGoodbyeStatement(turn.normalized) ? true : null),
  answer: (_claim, { turn }) => ({
    ...ok("open_conversation", seeYa(turn.request.speaker.name), "goodbye statement closes voice session"),
    sessionDirective: "close" as const,
  }),
} satisfies Owner<true>;

// --- System and self --------------------------------------------------------------

/** A request about the actual world; an "advice" query (task kind other) is not a system question. */
function systemIntentEligible(turn: OwnerTurn): boolean {
  const semantics = turn.analysis.semantics;
  const adviceQuery = semantics.use === "task" && semantics.force === "query" && semantics.taskKind === "other";
  return semantics.use === "task" && semantics.world === "actual" && !adviceQuery;
}

/**
 * System and identity answers reply to a question. A statement that merely
 * shares their vocabulary ("...our conversation... Who he was...") is
 * conversation; only an explicit identity claim is handled as a statement.
 */
function systemQuestionEligible(turn: OwnerTurn): boolean {
  return systemIntentEligible(turn) && ["query", "fragment", "command"].includes(turn.analysis.semantics.force);
}

/** The live facts behind the assistant's answers about himself. */
export function assistantSelfContext(options: {
  readonly config: AppConfig;
  readonly request: VoiceBrainRequest;
  readonly conversationTurns: readonly BasicConversationTurn[];
}): AssistantSelfContext {
  const previous = options.conversationTurns.at(-1);
  return {
    household: trustedSpeakerLabel(options.request) !== null,
    mind: configuredModelSkipReason(options.config) ? "none" : options.config.modelBackend,
    learnsFromChats: memoryReflectionActive(options.config) && memoryReflectionActorId(options.request) !== null,
    episodeMaxAgeDays: Math.round(MEMORY_REFLECTION_LIMITS.episodeMaxAgeMs / 86_400_000),
    keepsWords: memoryArchiveActive(options.config) && memoryReflectionActorId(options.request) !== null,
    previousReply: previous ? { modelUsed: previous.modelUsed === true } : null,
    growth: selfGrowthSummary(),
  };
}

function readinessLine(loaded: boolean, deviceControl: boolean): string {
  return `I'm up, ready, and healthy; Home Assistant data is ${loaded ? "loaded" : "not loaded yet"}, and ${deviceControlClause(deviceControl)}.`;
}

/** What the assistant may switch, for the health line. */
export function deviceControlClause(deviceControl: boolean): string {
  return deviceControl ? "I can work the devices on my voice list" : "device control is still locked";
}

/**
 * Sincere questions about the assistant himself (fixed self facts), who the speaker
 * is, and whether he is ready or locked.
 */
export function assistantSystemAnswer(
  input: string,
  request: VoiceBrainRequest,
  sources: {
    readonly stateCount?: number;
    readonly registryCount?: number;
    /** Facts for sincere questions about the assistant himself; absent means that route is off. */
    readonly self?: AssistantSelfContext;
    /** Device control is live (service present, kill switch on). */
    readonly deviceControl?: boolean;
  } = {},
  options: { readonly question: boolean } = { question: true },
): BasicResult | null {
  const selfQuestion = options.question && sources.self ? parseAssistantSelfQuestion(input) : null;
  if (selfQuestion && sources.self) {
    return ok(
      "open_conversation",
      assistantSelfAnswer(selfQuestion, sources.self),
      `assistant self question (${selfQuestion.topic}) answered from code-owned self facts`,
    );
  }
  const intent = parseAssistantSystemIntent(input, options);
  if (!intent) {
    return null;
  }
  if (intent.kind === "speaker_identity") {
    const speaker = trustedSpeakerLabel(request);
    return speaker
      ? ok("open_conversation", `You are ${speaker}.`, "speaker identity answered from trusted request metadata")
      : declined("open_conversation", "I don't have a trusted speaker identity for this chat.", "speaker identity missing trusted request metadata");
  }
  if (intent.fact === "locked") {
    return ok(
      "system_health",
      sources.deviceControl
        ? "Partly. I can work the devices on my voice list; everything else is still locked."
        : "Yes. I can check things, but device control is still locked.",
      "read-only safety state answered from runtime policy",
    );
  }
  return ok(
    "system_health",
    readinessLine((sources.stateCount ?? 0) > 0 || (sources.registryCount ?? 0) > 0, sources.deviceControl === true),
    "runtime readiness answered from process and Home Assistant source state",
  );
}

/** What the assistant is, runs on, can do and remembers; his version, uptime and house counts. */
export const systemAnswerOwner = {
  id: "system_answer",
  tier: "explicit",
  claim: (turn, { config, routes }) => (systemIntentEligible(turn)
    ? assistantSystemAnswer(turn.surface, turn.request, {
        stateCount: routes.stateCache?.size() ?? 0,
        registryCount: routes.registry?.entityCount() ?? 0,
        self: {
          ...assistantSelfContext({ config, request: turn.request, conversationTurns: turn.conversationTurns }),
          voiceList: () => voiceListSummary(routes.deviceControl, routes.stateCache, turn.analysis.sources.aliases(), turn.analysis.principal),
        },
        deviceControl: deviceControlLive(routes.deviceControl),
      }, { question: systemQuestionEligible(turn) })
    : null),
  answer: (answer) => answer,
} satisfies Owner<BasicResult>;

export const systemHealthOwner = {
  id: "system_health",
  tier: "explicit",
  claim: (turn) => (systemQuestionEligible(turn) && parseBasicSystemHealthIntent(turn.normalized) ? true : null),
  answer: (_claim, { routes }) => ok(
    "system_health",
    readinessLine(
      (routes.stateCache?.size() ?? 0) > 0 || (routes.registry?.entityCount() ?? 0) > 0,
      deviceControlLive(routes.deviceControl),
    ),
    "basic reset health",
  ),
} satisfies Owner<true>;

/** "Who am I?" and "I'm the owner", answered from the request's trusted speaker only. */
export const speakerIdentityOwner = {
  id: "speaker_identity",
  tier: "explicit",
  claim: (turn) => {
    const mode = systemIntentEligible(turn) ? parseBasicSpeakerIdentityIntent(turn.normalized)?.mode : null;
    return mode === "statement" || (mode === "question" && systemQuestionEligible(turn)) ? mode : null;
  },
  answer: (mode, { turn }) => {
    const speakerName = trustedSpeakerLabel(turn.request);
    if (!speakerName) {
      return declined("open_conversation", "I don't have a trusted speaker identity for this chat.", "speaker identity missing trusted person source");
    }
    return mode === "question"
      ? ok("open_conversation", `You are ${speakerName}.`, "speaker identity answered from request metadata")
      : ok("open_conversation", `Yes, you are ${speakerName}.`, "speaker identity acknowledged from request metadata");
  },
} satisfies Owner<"question" | "statement">;

/**
 * Household membership, not presence: "who lives here", "who is in this
 * household". "Who is home" stays with the live presence routes.
 */
function looksLikeHouseholdRosterQuestion(normalized: string): boolean {
  const group = "(?:this|the|our|my|your) (?:household|family)";
  return new RegExp(`^who (?:all )?(?:lives?|stays?) (?:here|with (?:us|me|you)|in (?:this|the|our|my) (?:house|home|household))$`).test(normalized)
    || new RegExp(`^who (?:is|are) (?:in|part of) ${group}$`).test(normalized)
    || new RegExp(`^(?:who|what) (?:is|are) (?:the )?(?:members|people|residents) (?:of|in) ${group}$`).test(normalized)
    || new RegExp(`^who (?:is|are) the (?:household|family) members$`).test(normalized)
    || new RegExp(`^(?:who|what) makes? up ${group}$`).test(normalized)
    || new RegExp(`^(?:list|name) (?:the )?(?:household members|members of ${group})$`).test(normalized);
}

/** The configured roster, spoken as-is to a verified household member. */
export const householdRosterOwner = {
  id: "household_roster",
  tier: "explicit",
  claim: (turn) => (systemQuestionEligible(turn) && looksLikeHouseholdRosterQuestion(turn.normalized) ? true : null),
  answer: (_claim, { turn, config }) => {
    if (isGuestSpeakerRequest(turn.request)) {
      return guestMemoryDecline("guest mode blocked household roster");
    }
    const roster = config.householdRoster
      .replace(/^[^:.]{1,60}:\s*/u, "")
      .replace(/\s*\([^)]*\)/gu, "")
      .trim();
    if (!roster || !memoryReflectionActorId(turn.request)) {
      return declined("memory_query", "I can't talk about the household until I know who's asking.", "household roster needs a verified household speaker");
    }
    return ok("memory_query", roster, "household roster from config");
  },
} satisfies Owner<true>;

/**
 * Taste questions answered from the self-model store with no model
 *. Only an exact stored record answers; anything
 * else goes on to open chat.
 */
export const selfTasteOwner = {
  id: "self_taste",
  tier: "explicit",
  claim: (turn, { config, selfModel }) => {
    if (!config.cognitiveSystemEnabled || !selfModel) return null;
    const previous = turn.conversationTurns.at(-1);
    return selfTasteChangesAnswer(() => selfModel.recentTasteChanges(), turn.request.transcript)
      ?? selfTasteAnswer(
        selfModel.listPreferences(),
        turn.request.transcript,
        previous?.route === "open_conversation" ? previous.responseText : null,
      );
  },
  answer: (answer) => ({
    ...ok(
      "open_conversation",
      answer.text,
      `self taste (${answer.kind}) answered from the self-model store: ${answer.preferenceIds.join(", ")}`,
    ),
    // Hearing what changed is not being asked about those tastes.
    selfTastePreferenceIds: answer.kind === "changes" ? [] : answer.preferenceIds,
  }),
} satisfies Owner<NonNullable<ReturnType<typeof selfTasteAnswer>>>;

/**
 * Asks the assistant's own opinion. A holder stance ("in your opinion,...") can sit
 * outside the dominant clause; it binds only when that clause is itself
 * evaluative.
 */
export function asksAssistantOpinion(turn: OwnerTurn): boolean {
  return looksLikeAssistantSelfOpinionPrompt(turn.normalized)
    || (looksLikeAssistantSelfOpinionPrompt(turn.surface) && hasEvaluativeComplement(turn.normalized));
}

/** His opinion is his to give in open chat, unless the question needs current information. */
export const selfOpinionOwner = toOpenChat("self_opinion", "explicit", (turn) => asksAssistantOpinion(turn) && !turn.currentInformationResearch);

// --- House roll calls -------------------------------------------------------------

function rollCallResult(answer: { readonly status: "ok" | "declined"; readonly text: string; readonly notes: string }): BasicResult {
  return answer.status === "ok" ? ok("entity_status", answer.text, answer.notes) : declined("entity_status", answer.text, answer.notes);
}

/** "Who's home?": home or out per household member, verified speakers only. */
export const presenceRollCallOwner = {
  id: "presence_roll_call",
  tier: "explicit",
  claim: (turn) => parsePresenceRollCall(turn.normalized),
  answer: (form, { turn, routes }) => {
    const speakerActorId = canonicalHouseholdActorId(trustedSpeakerPersonId(turn.request));
    if (!speakerActorId) {
      return guestPersonalStatusDecline("guest mode blocked the household presence roll call");
    }
    const answer = presenceRollCallAnswer({
      form,
      speakerActorId,
      people: loadCatchupSourcesConfig().people,
      stateOf: (entityId) => routes.stateCache?.get(entityId),
    });
    return rollCallResult(answer);
  },
} satisfies Owner<NonNullable<ReturnType<typeof parsePresenceRollCall>>>;

/** "Is everything locked?": every live lock and door sensor, verified speakers only, read-only. */
export const securityRollCallOwner = {
  id: "security_roll_call",
  tier: "explicit",
  claim: (turn) => parseSecurityRollCall(turn.normalized),
  answer: (form, { turn, routes }) => {
    if (!canonicalHouseholdActorId(trustedSpeakerPersonId(turn.request))) {
      return guestPersonalStatusDecline("guest mode blocked the household lock roll call");
    }
    const answer = securityRollCallAnswer({
      form,
      sources: securitySources(routes.stateCache?.entries() ?? []),
      registryEntity: (entityId) => routes.registry?.entity(entityId) ?? null,
    });
    return rollCallResult(answer);
  },
} satisfies Owner<NonNullable<ReturnType<typeof parseSecurityRollCall>>>;

/** "When did the doorbell last ring?", "did anyone ring it today?": the doorbell's ring times, verified speakers only. */
export const doorbellOwner = {
  id: "doorbell",
  tier: "explicit",
  claim: (turn, { now }) => parseDoorbellAsk(turn.normalized) ?? doorbellTimeFollowUp(
    turn.normalized,
    turn.conversationTurns.map((earlier) => normalizeMeasuredRoutingText(earlier.transcript)).reverse(),
    now(),
    BASIC_CURRENT_TIMEZONE,
  ),
  answer: async (ask, { turn, routes, now }) => {
    if (!canonicalHouseholdActorId(trustedSpeakerPersonId(turn.request))) {
      return guestPersonalStatusDecline("guest mode blocked the doorbell history");
    }
    const fetchHistory = routes.historyFetcher?.fetchHistory;
    const answer = await doorbellAnswer({
      ask,
      normalized: turn.normalized,
      sources: doorbellSources(routes.stateCache?.entries() ?? []),
      fetchHistory: fetchHistory ? (query) => fetchHistory.call(routes.historyFetcher, query) : null,
      now: now(),
      timezone: BASIC_CURRENT_TIMEZONE,
    });
    return rollCallResult(answer);
  },
} satisfies Owner<DoorbellAsk>;

// --- Clock and calculator --------------------------------------------------------

/** Maths the calculator must not attempt is declined before knowledge can guess at it. */
export const unsupportedMathOwner = {
  id: "unsupported_math",
  tier: "unsupported",
  claim: (turn) => resolveUnsupportedMathPrompt(turn.transcript) || null,
  answer: (reason) => declined("calculation", reason, "unsupported math prompt blocked before knowledge fallback"),
} satisfies Owner<string>;

export const scalarCalculationOwner = {
  id: "scalar_calculation",
  tier: "explicit",
  claim: (turn) => resolveScalarCalculation(turn.transcript),
  answer: (calculation) => basicScalarCalculationAnswer(calculation),
} satisfies Owner<NonNullable<ReturnType<typeof resolveScalarCalculation>>>;

function currentTimeAnswer(now: Date, field: CurrentTimeField): BasicResult {
  const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(HOUSE_LOCALE, { timeZone: BASIC_CURRENT_TIMEZONE, ...options });
  if (field === "day") {
    const day = format({ weekday: "long" }).format(now);
    return ok("current_time", `Today is ${day}.`, "current weekday from runtime clock", null, { kind: "current_day", day });
  }
  if (field === "date") {
    const date = format({ weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now);
    return ok("current_time", `Today is ${date}.`, "current date from runtime clock", null, { kind: "current_date", date });
  }
  const parts = format({ hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  const hour = Number(part("hour") ?? "0");
  const minute = part("minute") ?? "00";
  const dayPeriod = (part("dayPeriod") ?? "").toUpperCase();
  const clockText = `${hour}:${minute}${dayPeriod ? ` ${dayPeriod}` : ""}`;
  const naturalPeriod = dayPeriod === "AM" ? "in the morning" : hour >= 5 && hour !== 12 ? "in the evening" : "in the afternoon";
  const naturalClockText = dayPeriod ? `${hour}:${minute} ${naturalPeriod}` : clockText;
  return ok("current_time", `It is ${clockText}.`, "current time from runtime clock", null, { kind: "current_time", clockText, naturalClockText });
}

export function basicScalarCalculationAnswer(calculation: ReturnType<typeof resolveScalarCalculation>): BasicResult {
  if (!calculation) {
    return declined("calculation", "I understood the calculation, but I can't work that one out safely yet.", "scalar calculation shape unresolved");
  }
  if (calculation.status === "declined") {
    return declined("calculation", calculation.reason, `scalar calculation declined: ${calculation.reason}`);
  }
  return ok(
    "calculation",
    calculation.text,
    "local scalar calculator answered directly",
    { kind: "calculation", expression: calculation.expression, value: calculation.value },
    { kind: "calculation", statement: calculation.text },
  );
}

export const currentTimeOwner = {
  id: "current_time",
  tier: "explicit",
  claim: (turn) => parseCurrentTimeIntent(turn.normalized),
  answer: (intent, { now }) => currentTimeAnswer(now(), intent.field),
} satisfies Owner<NonNullable<ReturnType<typeof parseCurrentTimeIntent>>>;

// --- Memory and household patterns ------------------------------------------------

/**
 * Household habits ("when does Alex usually get home?"). A question about the
 * energy allowance is about that budget, even when it asks for an average
 * ("how much can I use on average each day to stay under my limit?"):
 * household habits yield it to the energy owner.
 */
export const housePatternOwner = {
  id: "house_pattern",
  tier: "explicit",
  claim: (turn, { config, now }) => (looksLikeEnergyBudgetQuestion(turn.normalized)
    ? null
    : housePatternAnswer(config, turn.request, turn.normalized, now())),
  answer: (pattern) => ({
    route: "memory_query",
    status: pattern.status,
    confidence: pattern.confidence,
    text: pattern.text,
    modelUsed: false,
    resultId: null,
    touchedEntities: [],
    notes: pattern.notes,
    ...(pattern.withheld ? { withheld: true as const } : {}),
  }),
} satisfies Owner<NonNullable<ReturnType<typeof housePatternAnswer>>>;

/**
 * A personal-memory question ("what did I do last weekend?") yields to a
 * deterministic domain that owns the same words: a metric or metric history,
 * the to-do list, the calendar (unless the question asks what someone did),
 * or a current status with a resolvable or explicit target or the whole
 * house's lights. It runs after the time-qualified status check, so a
 * device state at a time stays the house's.
 */
export const personalMemoryOwner = {
  id: "personal_memory",
  tier: "explicit",
  claim: (turn, { routes }) => {
    const normalized = turn.normalized;
    if (!looksLikePersonalMemoryQuestion(normalized, turn.resolvedTimeWindow)) return null;
    const episodicActions = episodicQuestionActionTerms(normalized);
    const calendarOwnsQuestion = looksLikeCalendarQuestion(normalized)
      && (episodicActions.length === 0 || episodicActions.includes("have"));
    const statusPlan = parseCurrentStatusPlan(turn.analysis.semantics.core, turn.analysis.speechAct);
    const statusOwnsQuestion = statusPlan !== null
      && (statusPlan.targetText === null
        ? looksLikeGlobalLightsStatus(normalized)
        : resolveStatusTarget(statusPlan.targetText, routes) !== null
          || looksLikeExplicitStatusTargetObject(statusPlan.targetText));
    const domainOwnsQuestion = resolveMetricQuestion(normalized) !== null
      || looksLikeHistoryMetricQuestion(normalized)
      || looksLikeTodoQuestion(normalized)
      || calendarOwnsQuestion
      || statusOwnsQuestion;
    return domainOwnsQuestion ? null : true;
  },
  answer: (_claim, { turn, turnId, config, routes, now }) => {
    if (isGuestSpeakerRequest(turn.request)) {
      return guestMemoryDecline("guest mode blocked accepted personal memory lookup");
    }
    const memoryNow = now().toISOString();
    const refresh = {
      request: turn.request,
      transcript: turn.transcript,
      now: memoryNow,
      sourceRef: turnId,
      timeWindowOverride: turn.resolvedTimeWindow,
    };
    return basicMemoryResultWithHistoricalPresence(
      memoryAnswer(config, turn.request, turn.transcript, refresh),
      routes,
      config,
      refresh,
    );
  },
} satisfies Owner<true>;

/** Asks about accepted memory; the assistant's own opinion or a subjective question is not a memory lookup. */
export function asksMemory(turn: OwnerTurn): boolean {
  return looksLikeMemoryQuery(
    turn.normalized,
    asksAssistantOpinion(turn) || looksLikeSubjectiveOpinionPrompt(turn.normalized),
  );
}

/** Accepted memory, last of the sourced answers: metrics, house facts and status come first. */
export const memoryQueryOwner = {
  id: "memory_query",
  tier: "explicit",
  claim: (turn) => (asksMemory(turn) ? true : null),
  answer: (_claim, { turn, turnId, config, now, openChat }) => {
    if (isGuestSpeakerRequest(turn.request)) {
      return guestMemoryDecline("guest mode blocked accepted memory lookup");
    }
    const answer = memoryAnswer(config, turn.request, turn.transcript, {
      now: now().toISOString(),
      sourceRef: turnId,
      timeWindowOverride: turn.resolvedTimeWindow,
    });
    // Nothing accepted: open chat can still look (memory, conversations, the owner's projects), as with
    // "what do you know about the speaker project?". With no model, the plain no.
    return answer.notes === MEMORY_NO_MATCH_NOTE && config.modelEnabled ? openChat() : answer;
  },
} satisfies Owner<true>;

// --- Catch-up, event log and house summary ----------------------------------------

/** "What's happening at home?": a summary built from the live house signals. */
export const houseSummaryOwner = {
  id: "house_summary",
  tier: "explicit",
  claim: (turn) => (looksLikeHouseSummaryQuestion(turn.normalized) ? true : null),
  answer: async (_claim, { turn, routes, now }) => {
    const summary = await buildHouseSummaryAnswer({
      stateCache: routes.stateCache,
      houseState: routes.houseState,
      calendarFetcher: routes.calendarFetcher,
      eventWatcher: routes.eventWatcher,
      now: now(),
      normalized: turn.normalized,
      guestMode: isGuestSpeakerRequest(turn.request),
    });
    return withReadFallback(summary
      ? ok(
        "house_summary",
        summary.text,
        summary.notes,
        { kind: "house_summary", scope: summary.scope, sourceEntityIds: summary.sourceEntityIds, sourceSummary: summary.sourceSummary },
        { kind: "house_summary", scope: summary.scope, parts: summary.parts },
      )
      : declined("house_summary", "I can't build a useful house summary yet because the live house signals are not loaded.", "house summary sources unavailable"),
    "cross_source_read_required");
  },
} satisfies Owner<true>;

/** "What did I miss?", "anything happen while I was out?" and the house event log. */
export const catchupOwner = {
  id: "catchup",
  tier: "explicit",
  claim: (turn) => (looksLikeEventLogQuestion(turn.normalized) ? true : null),
  answer: async (_claim, { turn, turnId, routes, catchup, now: clock }) => {
    const now = clock();
    const houseSnapshot = routes.houseState?.snapshot(now) ?? null;
    const answer = await buildEventLogAnswer({
      eventWatcher: routes.eventWatcher,
      now,
      normalized: turn.normalized,
      ...(houseSnapshot?.timezone ? { timezone: houseSnapshot.timezone } : {}),
      guestMode: isGuestSpeakerRequest(turn.request),
      trustedSpeakerPersonId: trustedSpeakerPersonId(turn.request),
      catchup: {
        services: catchupServices(routes, catchup),
        sessionStartedAt: conversationStartedAt(turn.conversationTurns, now),
      },
    });
    if (answer?.digest) {
      catchup.digests.remember(turnId, answer.digest, now);
    }
    if (!answer) {
      return withReadFallback(
        declined("event_log", "I can't build a useful event log yet because the watcher feed is not loaded.", "event log sources unavailable"),
        "historical_state_required",
      );
    }
    if (answer.withheld) {
      return withheld("event_log", answer.notes);
    }
    const frame = { kind: "event_log" as const, scope: answer.scope, sourceEntityIds: answer.sourceEntityIds, sourceSummary: answer.sourceSummary };
    return withReadFallback(answer.status === "ok"
      ? ok("event_log", answer.text, answer.notes, frame, answer.speechPlan)
      : { ...declined("event_log", answer.text, answer.notes), contextFrame: frame },
    "historical_state_required");
  },
} satisfies Owner<true>;

// --- Local media catalogue ----------------------------------------------------------

type LocalMediaRequest =
  | { readonly type: "recommend"; readonly kind: "movie" | "show"; readonly genre: string | null; readonly short: boolean }
  | { readonly type: "availability"; readonly kind: "movie" | "show" | null; readonly title: string }
  | { readonly type: "list"; readonly kind: "movie" | "show"; readonly filter: "recent" | "unwatched" };

function parseLocalMediaRequest(normalized: string): LocalMediaRequest | null {
  const watchRecommendation = looksLikeWatchRecommendation(normalized);
  const kind = localMediaKind(normalized) ?? (watchRecommendation ? "movie" : null);
  if (/\bplex\b/.test(normalized) && /^(?:do we have|have we got|is|are)\b/.test(normalized)) {
    const title = normalized
      .replace(/^(?:do we have|have we got|is|are)\s+/, "")
      .replace(/\s+(?:in|on)\s+plex(?:\s+(?:yet|already))?$/, "")
      .replace(/\s+(?:movie|film|show|series)$/, "")
      .trim();
    return title ? { type: "availability", kind, title } : null;
  }
  if (kind && /\b(?:recently added|newest|latest)\b/.test(normalized)) {
    return { type: "list", kind, filter: "recent" };
  }
  if (kind && /\b(?:unwatched|not watched|haven't watched|have not watched)\b/.test(normalized)) {
    return { type: "list", kind, filter: "unwatched" };
  }
  const asksForRecommendation = watchRecommendation
    || /\b(?:recommend|recommendation|suggest|suggestion|pick|choose|good|worth watching)\b/.test(normalized);
  if (!asksForRecommendation || !kind) {
    return null;
  }
  const genre = ["action", "comedy", "crime", "documentary", "drama", "horror", "mystery", "romance", "science fiction", "thriller", "western"]
    .find((value) => new RegExp(`\\b${value}\\b`).test(normalized)) ?? null;
  // "before bed" got The Shawshank Redemption (2 h 22) at 2 AM.
  const short = kind === "movie" && /\b(?:before (?:bed|i go to bed|i go to sleep|sleep)|bedtime|short|quick|not too long)\b/.test(normalized);
  return { type: "recommend", kind, genre, short };
}

function looksLikeWatchRecommendation(normalized: string): boolean {
  return /\b(?:what|which)\b.*\b(?:should|could|would)\b.*\b(?:watch|see|put on)\b/.test(normalized);
}

function localMediaKind(normalized: string): "movie" | "show" | null {
  if (/\b(?:tv|television|show|shows|series)\b/.test(normalized)) return "show";
  return /\b(?:movie|movies|film|films)\b/.test(normalized) ? "movie" : null;
}

function localMediaRecommendationSentence(recommendation: LocalMediaRecommendation, short = false): string {
  const year = recommendation.year === null ? "" : ` (${recommendation.year})`;
  const availability = recommendation.source === "plex"
    ? "It is in Plex."
    : recommendation.source === "radarr"
      ? "Radarr reports it downloaded."
      : recommendation.source === "sonarr"
        ? "Sonarr reports episodes available."
        : "Seerr lists it, although Plex availability is not confirmed.";
  const rating = recommendation.rating === null
    ? ""
    : ` It is rated ${formatMediaRating(recommendation.rating)} out of 10 by ${recommendation.ratingSource ?? "the local catalogue"}.`;
  const genre = recommendation.genres.length === 0
    ? ""
    : ` Genres: ${joinNatural(recommendation.genres.slice(0, 2))}.`;
  const length = short && recommendation.minutes !== undefined ? ` It runs ${filmLength(recommendation.minutes)}.` : "";
  return `Try ${recommendation.title}${year}.${length} ${availability}${rating}${genre}`;
}

function filmLength(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourText = hours === 0 ? "" : `${hours} hour${hours === 1 ? "" : "s"}`;
  const minuteText = rest === 0 ? "" : `${rest} minute${rest === 1 ? "" : "s"}`;
  return [hourText, minuteText].filter(Boolean).join(" ");
}

function formatMediaRating(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "");
}

function localMediaAvailabilitySentence(
  requestedTitle: string,
  match: LocalMediaRecommendation | null,
  sources: readonly LocalMediaSourceObservation[],
): string {
  if (!match) {
    return `I couldn't find ${requestedTitle} in ${joinNatural(availableMediaSourceLabels(sources))}.`;
  }
  const title = `${match.title}${match.year === null ? "" : ` (${match.year})`}`;
  if (match.source === "plex") return `Yes. ${title} is in Plex.`;
  const plexStatus = sources.find((item) => item.source === "plex")?.status;
  const plexQualification = plexStatus === "available"
    ? ", but it wasn't in the Plex catalogue"
    : plexStatus === "unavailable"
      ? ", while Plex was unavailable"
      : "";
  if (match.source === "radarr") {
    return match.available
      ? `Radarr reports ${title} downloaded${plexQualification}.`
      : `Radarr knows about ${title}, but it is not downloaded${plexQualification}.`;
  }
  return match.available
    ? `Sonarr reports episodes of ${title} available${plexQualification}.`
    : `Sonarr knows about ${title}, but no episodes are available${plexQualification}.`;
}

function availableMediaSourceLabels(sources: readonly LocalMediaSourceObservation[]): readonly string[] {
  return sources
    .filter((item) => item.status === "available")
    .map((item) => ({
      plex: "Plex",
      radarr: "Radarr",
      sonarr: "Sonarr",
      seerr: "Seerr",
    })[item.source]);
}

function localMediaListSentence(kind: LocalMediaKind, filter: "recent" | "unwatched", items: readonly LocalMediaListItem[]): string {
  const noun = kind === "movie" ? "movies" : "shows";
  if (items.length === 0) {
    return `I couldn't find any ${filter === "recent" ? "recently added" : "unwatched"} ${noun} in Plex.`;
  }
  const titles = items.map((item) => `${item.title}${item.year === null ? "" : ` (${item.year})`}`);
  return `The ${filter === "recent" ? "most recently added" : "latest unwatched"} ${noun} in Plex are ${joinNatural(titles)}.`;
}

/**
 * One catalogue read, which says whether every source answered and which
 * ones did. No catalogue, or a read that fails, is a decline the read agent
 * may take up.
 */
async function readMediaCatalog<T>(
  what: string,
  read: (() => Promise<LocalMediaAgentReadResult<T>>) | null,
): Promise<LocalMediaAgentReadResult<T> | BasicResult> {
  if (!read) {
    return declinedReadFallback("open_conversation", "The local media catalogue is unavailable.", `local media ${what} adapter unavailable`, "read_source_unavailable");
  }
  try {
    return await read();
  } catch {
    return declinedReadFallback("open_conversation", "The local media catalogue did not respond.", `local media ${what} adapter failed`, "read_source_unavailable");
  }
}

function incompleteMediaRead(text: string, notes: string): BasicResult {
  return declinedReadFallback("open_conversation", `Part of the local media catalogue is unavailable, so I can't ${text}.`, notes, "read_source_unavailable");
}

/** Plex, Radarr, Sonarr and Seerr: recommendations, "do we have X?", recent and unwatched lists. */
export const localMediaOwner = {
  id: "local_media",
  tier: "explicit",
  claim: (turn) => parseLocalMediaRequest(turn.normalized),
  answer: async (request, { routes }) => {
    const catalog = routes.mediaCatalog;
    if (request.type === "recommend") {
      const read = await readMediaCatalog(
        "recommendation",
        catalog?.recommendForAgent ? () => catalog.recommendForAgent!(request.kind, request.genre, {}, request.short ? SHORT_FILM_MINUTES : null) : null,
      );
      if (!("complete" in read)) return read;
      if (!read.complete) return incompleteMediaRead("rank a recommendation honestly", "local media recommendation was source-incomplete");
      const recommendation = read.result;
      return recommendation
        ? ok(
          "open_conversation",
          localMediaRecommendationSentence(recommendation, request.short),
          `local ${request.kind} recommendation from ${recommendation.source}; available=${recommendation.available}; rating=${recommendation.rating ?? "unknown"}; genre=${request.genre ?? "any"}${request.short ? `; short minutes=${recommendation.minutes ?? "unknown"}` : ""}`,
        )
        : ok(
          "open_conversation",
          `I couldn't find a suitable ${request.genre ? `${request.genre} ` : ""}${request.kind} in the local catalogue.`,
          `no local ${request.kind} recommendation matched; genre=${request.genre ?? "any"}`,
        );
    }
    if (request.type === "availability") {
      const read = await readMediaCatalog(
        "availability",
        catalog?.findForAgent ? () => catalog.findForAgent!(request.title, request.kind) : null,
      );
      if (!("complete" in read)) return read;
      const match = read.result;
      if (!match && !read.complete) return incompleteMediaRead("confirm that title is absent", "local media absence was source-incomplete");
      return ok(
        "open_conversation",
        localMediaAvailabilitySentence(request.title, match, read.sources),
        match
          ? `local media availability from ${match.source}; available=${match.available}`
          : `local media title absent from ${availableMediaSourceLabels(read.sources).join(", ") || "legacy configured sources"}`,
      );
    }
    const read = await readMediaCatalog(
      "list",
      catalog?.listForAgent ? () => catalog.listForAgent!(request.kind, request.filter, 3) : null,
    );
    if (!("complete" in read)) return read;
    if (!read.complete) return incompleteMediaRead("give you a complete list", "local media list was source-incomplete");
    return ok(
      "open_conversation",
      localMediaListSentence(request.kind, request.filter, read.result),
      `local Plex ${request.filter} ${request.kind} list; count=${read.result.length}`,
    );
  },
} satisfies Owner<LocalMediaRequest>;

// --- Correction and repair -----------------------------------------------------

function looksLikeAssistantMistakeExplanationRequest(normalized: string): boolean {
  const asksForExplanation = /\b(?:explain|explanation|tell me (?:why|what went wrong)|what went wrong|why did you)\b/.test(normalized);
  if (!asksForExplanation) {
    return false;
  }
  const explicitlyAssistantError = /\b(?:your (?:mistake|error)|(?:mistake|error) you (?:made|committed)|you (?:made (?:a|the|that) (?:mistake|error)|got (?:it|that) wrong|were wrong))\b/.test(normalized);
  const repairFraming = /\b(?:i (?:was )?asking|i asked|what i asked|not repeat|instead of repeat(?:ing)?|rather than repeat(?:ing)?)\b/.test(normalized);
  const namesError = /\b(?:mistake|error|went wrong)\b/.test(normalized);
  return explicitlyAssistantError || (repairFraming && namesError);
}

export const mistakeExplanationOwner = fixedReply(
  "mistake_explanation",
  "correction",
  (turn) => looksLikeAssistantMistakeExplanationRequest(turn.normalized),
  () => ({
    ...ok(
      "open_conversation",
      "I carried the previous answer context into your correction instead of treating it as a request to explain my error. That's what went wrong.",
      "assistant mistake explanation handled without reusing sourced focus",
    ),
    resetContext: true,
  }),
);

export const contextFailureOwner = fixedReply(
  "context_failure",
  "correction",
  (turn) => /\b(?:wrong context|old context|previous context|same context|you repeated|kept repeating|not the lights|wrong answer|old answer|previous answer)\b/.test(turn.normalized),
  () => ({
    ...ok("open_conversation", "I carried the wrong context into that answer. I will reset it and listen properly.", "operator explicitly named context failure"),
    resetContext: true,
  }),
);

export function looksLikeConversationRepair(normalized: string): boolean {
  // A longer question is a question, not a complaint, even when it brushes
  // a marker; complaints ask for a reason ("why did you..."). Decided by
  // speech act, not wording. "I have a
  // question for you, what do you think you would be pushing back on... the
  // data you have access to?" got "Got it."
  if (normalized.split(/\s+/).length >= 10
    && parseRoutingUtterance(normalized).speechAct === "query"
    && !/^(?:why|how come)\b/.test(parseRoutingUtterance(normalized).core)) {
    return false;
  }
  const repairMarker = new RegExp(`\\b${REPAIR_MARKER_PATTERN}\\b`).test(normalized);
  const handoffMarker = /\b(codex|pass (?:that|this|it)|send (?:that|this|it)|pass .* through|send .* through|remember that mess|failure chain)\b/.test(normalized);
  const internalMarker = /\b(deterministic|fast route|route)\b/.test(normalized) && /\b(your|you|that|this)\b/.test(normalized);
  const accessMarker = /\b(i thought you did|you should have access|you have access|you should know|you do have this|you do have that)\b/.test(normalized);
  return repairMarker || handoffMarker || internalMarker || accessMarker;
}

/**
 * A long statement is conversation: not a complaint (every known repair is
 * under 30 words) and not a follow-up fragment. his
 * 49-word offer to let the assistant talk about himself ("... You have access to
 * features...") got "Got it.", and after a weather answer its "take" would
 * have drawn clothing advice.
 */
export function isLongStatement(turn: Pick<OwnerTurn, "analysis" | "normalized">): boolean {
  return turn.analysis.speechAct === "statement" && turn.normalized.split(/\s+/).length >= 30;
}

export const conversationRepairOwner = fixedReply(
  "conversation_repair",
  "correction",
  (turn) => !isLongStatement(turn) && looksLikeConversationRepair(turn.normalized),
  () => ok("open_conversation", "Got it.", "conversation repair handled without sourced fact lookup"),
);

function looksLikeDialogueMetaStatement(normalized: string): boolean {
  return !/^(?:what|which|who|when|where|why|how|is|are|was|were|do|does|did|can|could|would|should|has|have|turn|switch|set|open|close|lock|unlock|start|stop|dock)\b/.test(normalized)
    && (
      /\b(i thought|you said|you could|you do have|you have (?:this|that) (?:info|information)|you should have access|you have access|i mean|i meant|never mind|dont worry|don t worry|do not worry)\b/.test(normalized)
      || /\b(?:vital|private|personal|sensitive)\s+house\s+(?:info|information)\b/.test(normalized)
    );
}

/** "I thought you could see that", "you said...": talk about the talk, for open chat. */
export const dialogueMetaOwner = toOpenChat("dialogue_meta", "correction", (turn) => looksLikeDialogueMetaStatement(turn.normalized));
