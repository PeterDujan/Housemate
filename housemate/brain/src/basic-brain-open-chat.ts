/**
 * Open chat: the bounded model conversation every unclaimed turn
 * ends in, and the model provider behind it (open chat, knowledge fallback,
 * current-information research). It left `basic-brain.ts` with its prompt
 * builders, recall and code-fact inputs; the brain and the owners reach it
 * through `openConversationAnswer`.
 */
import { looksLikeAssistantSelfOpinionPrompt } from "./assistant-self-opinion.js";
import { conversationStartedAt, resultId, type BasicConversationTurn, type BasicResult } from "./basic-brain-contracts.js";
import {
  catchupServices,
  type BasicBrainRouteServices,
  type BasicModelAnswer,
  type BasicModelProvider,
  type BasicModelRequest,
  type BasicModelSource,
  type CatchupRuntime,
} from "./basic-brain-services.js";
import { mentionsCatchupScope } from "./basic-brain-event-log.js";
import { buildCatchupDigest, catchupDigestFacts } from "./catchup-digest.js";
import { parsePresenceRollCall } from "./house-presence.js";
import { canonicalHouseholdActorId } from "./actor-identity.js";
import { looksLikeCurrentPowerRankingQuestion } from "./basic-brain-metrics.js";
import { looksLikeCalendarQuestion, looksLikeTodoQuestion } from "./basic-brain-schedule.js";
import { looksLikeWeatherFastPathQuestion } from "./basic-brain-weather.js";
import type { AppConfig } from "./config.js";
import { cognitiveFeatureEnabled } from "./cognitive-control.js";
import { looksLikeHousePatternQuestion } from "./house-pattern-catalog.js";
import {
  enforceYesNoAnswerDetail,
  jarvisPersonalityInstructions,
  JARVIS_OPEN_CONVERSATION_DETAIL_INSTRUCTION,
  JARVIS_RESPONSE_DETAIL_INSTRUCTION,
  jarvisPersonalityTurnInstruction,
  jarvisSelfOpinionTurnInstruction,
  limitOpenConversationAnswer,
  stripSpokenDiscourseLabels,
} from "./housemate-personality.js";
import {
  callConfiguredModel,
  claudeChatEffort,
  classifyModelBackendError,
  configuredModelSkipReason,
  effectiveModelName,
  usageFromModelBackendError,
  type CodexExec,
  type ModelBackendResponse,
} from "./model-backend.js";
import { callIdStamp, elapsedMs, modelCallCost, modelLedgerPath, writeModelCall, type ModelTokenUsage } from "./model-ledger.js";
import type { BasicMemoryCard, MemoryAdapter } from "./memory-cards.js";
import { RECALL_BUDGET, capWords, type MemoryRecallSource, type RecallResult } from "./memory-recall-index.js";
import type { MemoryArchive } from "./memory-archive.js";
import { projectNames } from "./project-docs.js";
import { CHAT_PROJECT_TOOL_NAMES, type ChatToolCallContext, type ChatToolCallRecord, type ChatToolHandlers, type ChatToolTurn } from "./chat-tool-bridge.js";
import { SpokenDeadline } from "./spoken-deadline.js";
import { touchRetrievedMemories } from "./memory-salience-store.js";
import { memoryWriteAdmitted, memoryReflectionActive, memoryReflectionActorId, type MemoryReflectionObserver } from "./memory-reflection.js";
import { deterministicImmediateOpenAnswer } from "./open-conversation.js";
import { assistantSelfPromptFacts } from "./assistant-self-knowledge.js";
import {
  completeModelTextSegments,
  emitLookupHoldingLine,
  emitProgressiveText,
  HOLDING_LINES,
  LOOKUP_HOLDING_LINE,
  PROJECT_STUDY_LINE,
  progressiveSegmentsFromFinalJson,
  progressiveSegmentsSchema,
  ProgressiveSegmentDeltaParser,
  ProgressiveTextSentenceParser,
} from "./progressive-speech.js";
import { codexAppServerClient } from "./codex-app-server.js";
import { canonicalHouseholdPersonLabel, isGuestSpeakerRequest, pageChatActorId, trustedSpeakerLabel, trustedSpeakerPersonId } from "./speaker-principal.js";
import type { JarvisSelfModel, SelfPreferenceCard } from "./self-model.js";
import { compactTasteDigest } from "./self-taste.js";
import type { ModelStreamTrace } from "./turn-pace.js";
import { filterModelDeliveryTags, MODEL_DELIVERY_TAG_INSTRUCTION, ModelDeliveryTagFilter, stripDeliveryTags } from "./speech-tone.js";
import type { VoiceBrainRequest } from "./voice-brain.js";
import { normalizeMeasuredRoutingText as normalize, targetTextKey } from "./routing-text.js";
import { assistantSelfContext, explicitRememberAnswer } from "./stateless-owners.js";
import { looksLikeSubjectiveOpinionPrompt, type WikipediaKnowledgeStore } from "./wikipedia-knowledge-store.js";
import { MODEL_CONTEXT_ROLE } from "./codex-model-contract.js";
import { isAbortError } from "./abort-error.js";
import { householdOwner, householdRegex, ownerPronounPossessive } from "./household.js";
import { assistantName, assistantPossessive } from "./persona.js";
import { HOUSE_LOCALE, HOUSE_TIME_ZONE, housePlace } from "./house-config.js";

// 60 turns so a long getting-to-know-you chat stays in view
// (~+0.3 s first text per extra 10k prompt chars on live turns).
export const BASIC_CONVERSATION_TURN_LIMIT = 80;

const CONVERSATION_LINE_MAX_CHARS = 1500;

export async function openConversationAnswer(options: {
  readonly request: VoiceBrainRequest;
  readonly turnId: string;
  readonly config: AppConfig;
  readonly modelProvider: BasicModelProvider;
  readonly selfModel?: JarvisSelfModel;
  readonly memoryReflection?: MemoryReflectionObserver;
  readonly memoryAdapter: MemoryAdapter;
  readonly memoryRecall: MemoryRecallSource | null;
  readonly memoryArchive?: MemoryArchive | null;
  readonly chatTools?: ChatToolHandlers | null;
  readonly wikipediaKnowledge: WikipediaKnowledgeStore;
  readonly routes?: BasicBrainRouteServices;
  readonly catchup?: CatchupRuntime;
  readonly now: () => Date;
  readonly conversationTurns: readonly BasicConversationTurn[];
}): Promise<BasicResult> {
  const rememberAnswer = explicitRememberAnswer(options);
  if (rememberAnswer) {
    return rememberAnswer;
  }
  const assistantSelfOpinion = looksLikeAssistantSelfOpinionPrompt(
    options.request.transcript,
  );
  const basePersonalMemory = personalMemoryContext(options, assistantSelfOpinion);
  const recall = basePersonalMemory ? recallForTurn(options) : null;
  const memoryCards = !recall
    && !assistantSelfOpinion
    && cognitiveFeatureEnabled(options.config, "recall")
    && options.config.memoryCardsEnabled
    && !isGuestSpeakerRequest(options.request)
    ? options.memoryAdapter.getMemoryCards({
        transcript: options.request.transcript.trim(),
        speakerName: options.request.speaker.name,
        speakerVoiceId: options.request.speaker.voiceId,
        speakerConfidence: options.request.speaker.confidence,
        speakerTrustedActorId: options.request.speaker.trustedActorId ?? null,
        channel: options.request.channel,
        now: options.now().toISOString(),
        conversationTurns: options.conversationTurns.map((turn) => ({
          speakerName: turn.speakerName,
          transcript: turn.transcript,
        })),
      })
    : [];
  const selfPreferenceCards = assistantSelfOpinion
    && options.config.cognitiveSystemEnabled
    ? options.selfModel?.cardsForPrompt(options.request.transcript) ?? []
    : [];
  const selfTasteDigest = options.config.cognitiveSystemEnabled && options.selfModel
    // Only turns that ask for his view: given on every chat, the model
    // steers jokes and examples towards his tastes (measured 
    // octopus jokes, metaphors lifted from the list).
    && (assistantSelfOpinion || looksLikeSubjectiveOpinionPrompt(normalize(options.request.transcript)))
    ? compactTasteDigest(options.selfModel.listPreferences())
    : "";
  const personalMemory = basePersonalMemory && recall
    ? {
      ...basePersonalMemory,
      recall: {
        roster: capWords(options.config.householdRoster, RECALL_BUDGET.rosterWords),
        facts: recall.result.facts.map((item) => item.text),
        episodes: recall.result.episodes.map((item) => item.text),
      },
    }
    : basePersonalMemory;
  // Tools ride only with recall: a trusted household speaker, verified by transport.
  const toolActorId = recall && options.chatTools && options.config.chatToolsEnabled ? memoryReflectionActorId(options.request) : null;
  const toolActorLabel = toolActorId ? trustedSpeakerLabel(options.request) ?? personalMemory?.speakerLabel ?? null : null;
  // Web search is for every speaker; it reads nothing of the household.
  const webSearch = chatWebSearchActive(options.config);
  const catchupFacts = await catchupDigestForOpenChat(options);
  const codeFacts = toolActorId && toolActorLabel && options.chatTools
    ? await codeFactsForOpenChat(options.chatTools, options.request.transcript, {
      turnId: options.turnId,
      actorId: toolActorId,
      actorLabel: toolActorLabel,
      channel: options.request.channel,
      now: options.now(),
    })
    : null;
  const modelRequest = withProgressiveModelContext({
    turnId: options.turnId,
    purpose: "open_conversation",
    transcript: options.request.transcript.trim(),
    speakerName: options.request.speaker.name,
    channel: options.request.channel,
    conversationTurns: conversationTurnsAllowedForModel(
      options.conversationTurns,
    ),
    memoryCards,
    selfPreferenceCards,
    ...(selfTasteDigest ? { selfTasteDigest } : {}),
    selfFacts: assistantSelfPromptFacts(assistantSelfContext(options)),
    ...(personalMemory ? { personalMemory } : {}),
    ...(toolActorId && toolActorLabel && options.chatTools
      ? { chatTools: {
        actorId: toolActorId,
        actorLabel: toolActorLabel,
        handlers: options.chatTools,
        projects: projectNames(options.config.projectsDir),
        ...(pageChatActorId(options.request) === toolActorId ? { settings: true } : {}),
      } }
      : {}),
    ...(webSearch ? { webSearch: true } : {}),
    ...(catchupFacts ? { catchup: { facts: catchupFacts } } : {}),
    ...(codeFacts ? { codeFacts: codeFacts.text } : {}),
    ...(webSearch || toolActorId ? { requestedAt: options.now().toISOString() } : {}),
  }, options.request);
  const model = await options.modelProvider.answer(modelRequest);
  const usedMemoryIds = recall
    ? recall.result.facts.map((item) => item.id)
    : memoryCards.map((card) => card.memoryId);
  if (
    model.modelUsed
    && usedMemoryIds.length > 0
    && memoryWriteAdmitted(options.request)
    && cognitiveFeatureEnabled(options.config, "learning")
  ) {
    touchRetrievedMemories(options.config, usedMemoryIds, {
      now: options.now().toISOString(),
      sourceRef: options.turnId,
    });
  }
  const recallNote = `${recall ? `; ${recall.note}` : ""}${catchupFacts ? "; catch-up digest in context" : ""}${codeFacts ? `; code facts in context: ${codeFacts.sources.join(",")}` : ""}`;
  // Offline first: code already found no stored taste for this, so say that
  // honestly rather than blaming the model.
  const unsettledTaste = !model.modelUsed && assistantSelfOpinion && options.config.cognitiveSystemEnabled && Boolean(options.selfModel);
  return {
    route: "open_conversation",
    status: "ok",
    confidence: model.modelUsed ? "medium" : "low",
    text: unsettledTaste ? "I haven't settled on that one yet." : model.text,
    modelUsed: model.modelUsed,
    resultId: resultId(options.turnId),
    touchedEntities: [],
    notes: `${model.reason ? `basic open chat fallback: ${model.reason}` : "basic open chat model answer"}${recallNote}`,
  };
}

/**
 * Recall pre-fetch for a trusted speaker's open-chat turn: no model call, a
 * fixed budget, and access re-checked against the memory store. A failure
 * leaves the turn on the plain personal-memory prompt rather than failing it.
 */
function recallForTurn(options: {
  readonly request: VoiceBrainRequest;
  readonly config: AppConfig;
  readonly memoryRecall: MemoryRecallSource | null;
  readonly memoryArchive?: MemoryArchive | null;
  readonly now: () => Date;
  readonly conversationTurns: readonly BasicConversationTurn[];
}): { readonly result: RecallResult; readonly note: string } | null {
  const actorId = memoryReflectionActorId(options.request);
  if (!options.memoryRecall || !options.config.memoryRecallEnabled || !actorId) {
    return null;
  }
  const previous = [...options.conversationTurns].reverse().find((turn) => turn.transcript.trim())?.transcript ?? null;
  try {
    const result = options.memoryRecall.recall({
      actorId,
      transcript: options.request.transcript,
      previousTranscript: previous,
      channel: options.request.channel,
      now: options.now(),
    });
    const ids = [...result.facts, ...result.episodes].map((item) => item.id).join(",");
    // Counted after the reply: turns recall keeps bringing back on different days are kept for good.
    options.memoryArchive?.noteRecalled(actorId, result.episodes.flatMap((item) => item.turnIds ?? []), options.now());
    const kept = result.episodes.filter((item) => item.kind === "kept").length;
    const archiveNote = result.archive
      ? ` kept=${kept} archive_ms=${result.archive.elapsedMs}${result.archive.skipped ? ` archive_skipped=${result.archive.skipped.replaceAll(" ", "_")}` : ""}`
      : "";
    return {
      result,
      note: `recall facts=${result.facts.length} episodes=${result.episodes.length} ms=${result.elapsedMs}${archiveNote}${ids ? ` ids=${ids}` : ""}`,
    };
  } catch (error) {
    console.warn(`[brain] memory recall failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Personal memory rides open chat only while memory reflection is on, the
 * cognitive breaker allows recall, and the speaker is a trusted household
 * member. Off, the chat prompt is exactly the pre-reflection prompt.
 */
function personalMemoryContext(
  options: {
    readonly request: VoiceBrainRequest;
    readonly config: AppConfig;
    readonly memoryReflection?: MemoryReflectionObserver;
  },
  assistantSelfOpinion: boolean,
): BasicModelRequest["personalMemory"] | null {
  if (
    assistantSelfOpinion
    || !options.memoryReflection
    || !memoryReflectionActive(options.config)
    || !cognitiveFeatureEnabled(options.config, "recall")
  ) {
    return null;
  }
  const actorId = memoryReflectionActorId(options.request);
  const speakerLabel = actorId ? canonicalHouseholdPersonLabel(actorId) : null;
  if (!actorId || !speakerLabel) {
    return null;
  }
  return { speakerLabel, brief: options.memoryReflection.briefFor(actorId) };
}

export function chatWebSearchActive(config: AppConfig): boolean {
  return config.chatWebSearchEnabled && config.modelBackend === "claude";
}

export function withProgressiveModelContext(
  modelRequest: BasicModelRequest,
  voiceRequest: VoiceBrainRequest,
): BasicModelRequest {
  const sink = voiceRequest.progressive;
  const pace = voiceRequest.pace;
  return {
    ...modelRequest,
    ...(sink ? { progressive: { sink } } : {}),
    ...(pace ? { pace } : {}),
  };
}

export function conversationRouteAllowsModelContext(
  route: BasicConversationTurn["route"],
): boolean {
  return route === "open_conversation"
    || route === "general_knowledge"
    || route === "calculation"
    || route === "current_time"
    || route === "system_health";
}

export function conversationTurnsAllowedForModel(
  turns: readonly BasicConversationTurn[],
): readonly BasicConversationTurn[] {
  return turns.filter(conversationTurnAllowsModelContext);
}

export function conversationTurnAllowsModelContext(
  turn: BasicConversationTurn,
): boolean {
  return turn.modelContextAllowed
    ?? (
      turn.route === undefined
      || conversationRouteAllowsModelContext(turn.route)
    );
}

/** Up-front code reads must not hold the reply longer than a lookup round trip would. */
const CODE_FACTS_TIMEOUT_MS = 1_500;

/**
 * Speed: when code's own topic recognisers already know what a chat
 * turn is about, read that source now and hand it to the model, instead of
 * a tool round trip (~1-2 s). The readers are the chat tools' handlers, so
 * this is the same truth; anything not recognised is left to the tools.
 */
async function codeFactsForOpenChat(
  tools: ChatToolHandlers,
  transcript: string,
  turn: Omit<ChatToolCallContext, "signal">,
): Promise<{ readonly text: string; readonly sources: readonly string[] } | null> {
  const normalized = normalize(transcript);
  const wanted: { readonly source: string; readonly read: (context: ChatToolCallContext) => Promise<string> | string }[] = [];
  if (looksLikeHousePatternQuestion(normalized)) {
    wanted.push({ source: "routines", read: (context) => tools.read_household_routines({}, context) });
  }
  if (transcript.split(/[.!?]+/).some((sentence) => parsePresenceRollCall(normalize(sentence)))) {
    wanted.push({ source: "who_is_home", read: (context) => tools.who_is_home({}, context) });
  }
  if (looksLikeCalendarQuestion(normalized)) {
    wanted.push({ source: "calendar", read: (context) => tools.read_calendar({ kind: "household", daysAhead: 7 }, context) });
  }
  if (looksLikeTodoQuestion(normalized)) {
    wanted.push({ source: "todo", read: (context) => tools.read_todo_lists({}, context) });
  }
  if (looksLikeWeatherFastPathQuestion(normalized)) {
    wanted.push({ source: "weather", read: (context) => tools.read_weather({ daysAhead: 2 }, context) });
  }
  if (looksLikeCurrentPowerRankingQuestion(normalized)) {
    wanted.push({ source: "power", read: (context) => tools.read_power_now({}, context) });
  }
  if (wanted.length === 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CODE_FACTS_TIMEOUT_MS);
  const context: ChatToolCallContext = { ...turn, signal: controller.signal };
  try {
    const read = await Promise.all(wanted.map(async (item) => {
      try {
        const text = await Promise.race([
          Promise.resolve(item.read(context)),
          new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })),
        ]);
        return text.trim() ? { source: item.source, text: text.trim() } : null;
      } catch {
        return null;
      }
    }));
    const found = read.filter((item): item is { readonly source: string; readonly text: string } => item !== null);
    return found.length > 0
      ? { text: found.map((item) => item.text).join("\n"), sources: found.map((item) => item.source) }
      : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The digest an open-chat turn may carry: the one the
 * previous turn answered or carried, or a fresh one when this turn asks about
 * an absence or since-contact window. Trusted household speakers only; every
 * other open-chat turn gets nothing, so the model cannot volunteer it.
 */
async function catchupDigestForOpenChat(options: {
  readonly request: VoiceBrainRequest;
  readonly routes?: BasicBrainRouteServices;
  readonly turnId: string;
  readonly now: () => Date;
  readonly catchup?: CatchupRuntime;
  readonly conversationTurns: readonly BasicConversationTurn[];
}): Promise<string | null> {
  const runtime = options.catchup;
  const actorId = canonicalHouseholdActorId(trustedSpeakerPersonId(options.request));
  if (!runtime || !actorId || isGuestSpeakerRequest(options.request)) {
    return null;
  }
  const now = options.now();
  const previous = options.conversationTurns[options.conversationTurns.length - 1];
  const carried = runtime.digests.followUp(previous?.turnId, now);
  let digest = carried?.digest ?? null;
  if (!digest) {
    const scope = mentionsCatchupScope(normalize(options.request.transcript));
    if (!scope || !options.routes) {
      return null;
    }
    const houseSnapshot = options.routes.houseState?.snapshot(now) ?? null;
    const built = await buildCatchupDigest({
      scope,
      actorId,
      now,
      sessionStartedAt: conversationStartedAt(options.conversationTurns, now),
      timezone: houseSnapshot?.timezone ?? DEFAULT_TIMEZONE,
      services: catchupServices(options.routes, runtime),
    });
    if (built.status !== "ok") {
      return null;
    }
    digest = built.digest;
  }
  runtime.digests.remember(options.turnId, digest, now, carried?.followUps ?? 0);
  return catchupDigestFacts(digest, now);
}


/** A tool reading the owner's projects, by its bare or MCP name ("mcp__jarvis__search_projects"). */
function isProjectTool(name: string): boolean {
  return CHAT_PROJECT_TOOL_NAMES.some((tool) => name === tool || name.endsWith(`__${tool}`));
}

export class BasicOpenModelProvider implements BasicModelProvider {
  private readonly config: AppConfig;
  private readonly execImpl: CodexExec | undefined;
  private readonly now: () => Date;
  private readonly ledgerFilePath: string;
  private readonly deadlineMs: number;
  private readonly webLookupDeadlineMs: number;

  constructor(config: AppConfig, options: {
    readonly execImpl?: CodexExec;
    readonly now?: () => Date;
    readonly ledgerFilePath?: string;
    readonly deadlineMs?: number;
    /** A turn that starts a web search may run to this, measured from its start. */
    readonly webLookupDeadlineMs?: number;
  } = {}) {
    this.config = config;
    this.execImpl = options.execImpl;
    this.now = options.now ?? (() => new Date());
    this.ledgerFilePath = options.ledgerFilePath ?? modelLedgerPath(config);
    this.deadlineMs = options.deadlineMs ?? SPOKEN_MODEL_DEADLINE_MS;
    this.webLookupDeadlineMs = Math.max(this.deadlineMs, options.webLookupDeadlineMs ?? WEB_LOOKUP_DEADLINE_MS);
  }

  async answer(request: BasicModelRequest): Promise<BasicModelAnswer> {
    const purpose = request.purpose ?? "open_conversation";
    const startedAt = this.now();
    let progressiveModelSegmentCount = 0;
    if (purpose === "open_conversation") {
      const deterministic = deterministicImmediateOpenAnswer(request.transcript);
      if (deterministic) {
        const answer = finalVerifiedEarlyModelAnswer(
          request,
          deterministic,
          "deterministic_open_answer",
          "deterministic open answer",
          "answer",
        );
        this.writeLedger(request.turnId, purpose, "skipped", 0, ZERO_TOKENS, "deterministic_open_answer");
        return answer;
      }
    }
    const skipReason = this.skipReason(purpose);
    if (skipReason) {
      const answer = finalVerifiedEarlyModelAnswer(
        request,
        fallbackTextForModelPurpose(purpose, skipReason),
        skipReason,
        "model skip fallback",
        "fallback",
      );
      this.writeLedger(request.turnId, purpose, "skipped", 0, ZERO_TOKENS, skipReason);
      return answer;
    }
    const paceModel = request.pace?.beginModel(purpose, {
      recall: Boolean(request.personalMemory?.recall),
      brief: Boolean(request.personalMemory?.brief.trim()),
      tools: Boolean(request.chatTools),
      webSearch: Boolean(request.webSearch),
      catchup: Boolean(request.catchup),
      memoryCards: request.memoryCards?.length ?? 0,
      conversationTurns: request.conversationTurns.length,
    }) ?? null;
    const onTrace = paceModel ? (event: ModelStreamTrace) => paceModel.trace(event) : undefined;
    // Someone is waiting on this answer, so the call gets a hard deadline far
    // shorter than the backend's own timeout, which also covers background work.
    const spokenDeadline = new SpokenDeadline(this.deadlineMs);
    const deadline = spokenDeadline.signal;
    // Only a web search earns the longer deadline; local lookups keep 15 s.
    const webSearchStarted = (): void => {
      this.writeToolLedger(request.turnId, { tool: "WebSearch", outcome: "ok", latencyMs: 0, resultBytes: 0 });
      spokenDeadline.extendTo(this.webLookupDeadlineMs);
    };
    // Studying the owner's project notes takes longer than a local lookup, as a web search does.
    const projectStudyStarted = (): void => spokenDeadline.extendTo(this.webLookupDeadlineMs);
    const chatWebSearch = Boolean(request.webSearch) && (purpose === "open_conversation" || purpose === "general_knowledge");
    // Spoken chat only: background and structured calls keep the CLI default.
    const chatEffort = purpose === "open_conversation" || purpose === "general_knowledge"
      ? claudeChatEffort(this.config)
      : undefined;
    const modelSignal = request.progressive
      ? AbortSignal.any([request.progressive.sink.signal, deadline])
      : deadline;
    try {
      const modelName = effectiveModelName(this.config);
      // Claude Code only streams tool JSON in one final burst on subscription
      // auth, so streamed Claude turns use plain sentences instead of segment JSON.
      const plainTextSegments = Boolean(request.progressive)
        && this.config.modelBackend === "claude"
        && purpose !== "current_information";
      const payload = buildBasicModelRequestPayload(modelName, request, { plainTextSegments });
      const progressive = request.progressive;
      const streamingBackend = this.config.modelBackend === "codex"
        || (this.config.modelBackend === "claude" && purpose !== "current_information");
      const progressiveSource = this.config.modelBackend === "claude"
        ? { kind: "claude" as const, label: "authenticated Claude" }
        : { kind: "codex" as const, label: "authenticated Codex" };
      // Open chat writes vetted inline Fish delivery tags (MODEL_DELIVERY_TAG_INSTRUCTION).
      const deliveryTags = purpose === "open_conversation" && plainTextSegments ? new ModelDeliveryTagFilter() : null;
      // Segments may carry tags: the words go out as text, the tagged copy as markup.
      const spokenParts = (segment: string): { readonly text: string; readonly markup?: string } => {
        if (!deliveryTags) return { text: segment };
        const words = stripDeliveryTags(segment);
        return words === segment ? { text: words } : { text: words, markup: segment };
      };
      const progressiveRun = progressive && streamingBackend
        ? await (async (): Promise<{
            readonly response: ModelBackendResponse;
            readonly finalSegments: readonly string[] | null;
          }> => {
            const parser = purpose !== "open_conversation"
              ? null
              : plainTextSegments
                ? new ProgressiveTextSentenceParser()
                : new ProgressiveSegmentDeltaParser();
            const streamed: string[] = [];
            let holdingLineSpoken = false;
            let answerStarted = false;
            const commit = (texts: readonly string[]): void => {
              for (const text of texts) {
                if ((HOLDING_LINES.has(text) && (holdingLineSpoken || !answerStarted)) || (!answerStarted && isModelSelfNote(text)) || isNeverSpoken(text)) {
                  // The assistant already said it, it is the model's note to itself, or a claim it did something: never spoken.
                  streamed.push(text);
                  continue;
                }
                answerStarted = true;
                const emitted = progressive.sink.emit({
                  ...spokenParts(text),
                  kind: "answer",
                  commitPolicy: "bounded_chat",
                  source: progressiveSource,
                });
                if (!emitted) {
                  throw new Error("progressive model segment failed the live speech contract");
                }
                streamed.push(deliveryTags ? text : emitted.text);
                progressiveModelSegmentCount += 1;
                paceModel?.committed();
              }
            };
            const onDelta = parser
              ? (delta: string) => {
                  paceModel?.text(delta);
                  commit(parser.push(deliveryTags ? deliveryTags.push(delta) : delta));
                }
              : paceModel && this.config.modelBackend === "claude"
                ? (delta: string) => paceModel.text(delta)
                : undefined;
            // A text block that ends before a lookup is spoken while the lookup runs.
            const onTextBoundary = parser instanceof ProgressiveTextSentenceParser
              ? () => commit(parser.flush())
              : undefined;
            // A lookup with nothing said yet still gets a spoken holding line.
            // General knowledge does not stream, so the assistant holds the floor during its web search.
            const speakHoldingLine = parser instanceof ProgressiveTextSentenceParser
              || (chatWebSearch && purpose === "general_knowledge")
              ? (line: string) => {
                  // The model's own "Let me check." before a lookup is never spoken (above), so code
                  // says the right line for the lookup: studying the owner's projects, or checking.
                  if (answerStarted || holdingLineSpoken) return;
                  holdingLineSpoken = emitLookupHoldingLine(progressive.sink, line);
                }
              : undefined;
            const onToolUse = speakHoldingLine || chatWebSearch || request.chatTools
              ? (name: string) => {
                  if (name === "WebSearch") webSearchStarted();
                  const studying = isProjectTool(name);
                  if (studying) projectStudyStarted();
                  speakHoldingLine?.(studying ? PROJECT_STUDY_LINE : LOOKUP_HOLDING_LINE);
                }
              : undefined;
            const result = this.config.modelBackend === "codex"
              ? await codexAppServerClient(this.config).run(payload, {
                  signal: modelSignal,
                  webSearch: purpose === "current_information",
                  ...(purpose === "open_conversation" ? { reasoningEffort: "none" as const } : {}),
                  maxOutputBytes: 128 * 1024,
                  ...(onDelta ? { onDelta } : {}),
                })
              : await callConfiguredModel(this.config, payload, {
                  execImpl: this.execImpl,
                  signal: modelSignal,
                  maxOutputBytes: 128 * 1024,
                  onDelta,
                  onTextBoundary,
                  onToolUse,
                  onTrace,
                  chatTools: this.chatToolTurn(request),
                  chatWebSearch,
                  claudeEffort: chatEffort,
                });
            let finalSegments: readonly string[] | null = null;
            if (purpose !== "current_information") {
              finalSegments = plainTextSegments
                ? completeModelTextSegments(deliveryTags ? filterModelDeliveryTags(result.outputText) : result.outputText)
                : progressiveSegmentsFromFinalJson(result.outputText);
              if (!finalSegments.slice(0, streamed.length).every((text, index) => text === streamed[index])) {
                throw new Error("progressive model final output did not match its committed segment prefix");
              }
              for (const text of finalSegments.slice(streamed.length)) {
                if ((HOLDING_LINES.has(text) && (holdingLineSpoken || !answerStarted)) || (!answerStarted && isModelSelfNote(text)) || isNeverSpoken(text)) {
                  // The assistant already said it while the search ran, the model's note to itself, or a claim it did something.
                  continue;
                }
                answerStarted = true;
                const emitted = progressive.sink.emit({
                  ...spokenParts(text),
                  kind: "answer",
                  commitPolicy: purpose === "open_conversation" ? "bounded_chat" : "final_verified",
                  source: progressiveSource,
                });
                if (!emitted) {
                  throw new Error("progressive model final segment failed the live speech contract");
                }
                progressiveModelSegmentCount += 1;
              }
            }
            return {
              response: result,
              finalSegments,
            };
          })()
        : null;
      const response = progressiveRun?.response ?? await callConfiguredModel(
            this.config,
            payload,
            {
              execImpl: this.execImpl,
              webSearch: purpose === "current_information",
              signal: modelSignal,
              chatTools: this.chatToolTurn(request),
              chatWebSearch,
              claudeEffort: chatEffort,
              onToolUse: (name: string) => {
                if (name === "WebSearch") webSearchStarted();
                if (isProjectTool(name)) projectStudyStarted();
              },
              onTrace,
            },
          );
      const progressiveFinalSegments = progressiveRun?.finalSegments ?? null;
      if (purpose === "current_information") {
        const researched = validateCurrentInformationResearch(response.outputText, request.requestedAt);
        const text = limitOpenConversationAnswer(researched.answer);
        if (request.progressive) {
          const emitted = emitProgressiveText(request.progressive.sink, text, {
            kind: "answer",
            commitPolicy: "final_verified",
            source: {
              kind: "codex",
              label: researched.sources.map((source) => source.publisher).join(", "),
            },
          });
          progressiveModelSegmentCount += emitted.length;
          if (emitted.length < 1) {
            throw new Error("verified current-information answer could not be committed as complete speech");
          }
        }
        this.writeLedger(request.turnId, purpose, "ok", elapsedMs(startedAt, this.now()), response.usage, null);
        return {
          text: request.progressive ? request.progressive.sink.combinedText() : text,
          modelUsed: true,
          reason: null,
          sources: researched.sources,
        };
      }
      const joinedText = progressiveFinalSegments
        ? withoutLeadingSelfNotes(progressiveFinalSegments.map((segment) => stripDeliveryTags(segment)).join(" "))
        : purpose === "open_conversation" ? withoutLeadingSelfNotes(stripDeliveryTags(response.outputText)) : response.outputText;
      // A web-searching knowledge answer's own holding line is not one of its two sentences.
      const rawText = chatWebSearch && purpose === "general_knowledge"
        ? withoutLeadingHoldingLine(joinedText)
        : joinedText;
      const cleanedText = cleanModelText(
        rawText,
        purpose === "general_knowledge" ? { maxLength: 220, maxSentences: 2 } : { maxLength: 1200 },
      );
      const text = purpose === "general_knowledge"
        ? enforceYesNoAnswerDetail(cleanedText)
        : limitOpenConversationAnswer(withoutActionClaims(cleanedText));
      if (request.progressive && !progressiveRun) {
        const emitted = emitProgressiveText(request.progressive.sink, text, {
          kind: "answer",
          commitPolicy: "bounded_chat",
          source: {
            kind: "software",
            label: "configured model",
          },
        });
        progressiveModelSegmentCount += emitted.length;
      }
      this.writeLedger(request.turnId, purpose, "ok", elapsedMs(startedAt, this.now()), response.usage, null);
      return {
        text: request.progressive ? request.progressive.sink.combinedText() || text : text,
        modelUsed: true,
        reason: null,
      };
    } catch (error) {
      const timedOut = isAbortError(error) || deadline.aborted;
      const reason = timedOut
        ? purpose === "current_information"
          ? "current_information_timeout"
          : purpose === "general_knowledge" ? "general_knowledge_timeout" : "basic_open_timeout"
        : purpose === "current_information"
          ? "current_information_error"
          : purpose === "general_knowledge" ? "general_knowledge_error" : "basic_open_error";
      const backendError = timedOut
        ? null
        : classifyModelBackendError(
          { modelBackend: this.config.modelBackend },
          error,
        );
      this.writeLedger(
        request.turnId,
        purpose,
        timedOut ? "timeout" : "error",
        elapsedMs(startedAt, this.now()),
        timedOut ? ZERO_TOKENS : usageFromModelBackendError(error),
        reason,
        backendError,
      );
      const fallback = fallbackTextForModelPurpose(purpose, reason);
      if (request.progressive && progressiveModelSegmentCount < 1) {
        emitProgressiveText(request.progressive.sink, fallback, {
          kind: "fallback",
          commitPolicy: "final_verified",
          source: {
            kind: "software",
            label: "model failure fallback",
          },
        });
      }
      const progressiveText = request.progressive?.sink.combinedText() ?? "";
      return {
        text: progressiveText || fallback,
        modelUsed: progressiveModelSegmentCount > 0,
        reason,
      };
    } finally {
      spokenDeadline.clear();
      paceModel?.end();
    }
  }

  private skipReason(
    purpose: "open_conversation" | "general_knowledge" | "current_information",
  ): string | null {
    if (purpose === "current_information" && this.config.modelBackend !== "codex") {
      return "current_information_requires_codex";
    }
    const backendSkipReason = configuredModelSkipReason(this.config);
    return backendSkipReason;
  }

  /** Tools act for the verified actor the brain supplied, on open chat only. */
  private chatToolTurn(request: BasicModelRequest): ChatToolTurn | undefined {
    if (!request.chatTools || (request.purpose ?? "open_conversation") !== "open_conversation") {
      return undefined;
    }
    return {
      turnId: request.turnId,
      actorId: request.chatTools.actorId,
      actorLabel: request.chatTools.actorLabel,
      channel: request.channel,
      settings: request.chatTools.settings === true,
      handlers: request.chatTools.handlers,
      now: this.now,
      onCall: (record) => this.writeToolLedger(request.turnId, record),
    };
  }

  private writeToolLedger(turnId: string, record: ChatToolCallRecord): void {
    try {
      const timestamp = this.now().toISOString();
      writeModelCall(this.ledgerFilePath, {
        callId: `${turnId}-chat_tool-${record.tool}-${callIdStamp(timestamp)}`,
        turnId,
        timestamp,
        purpose: "chat_tool",
        model: effectiveModelName(this.config),
        backend: this.config.modelBackend,
        route: "open_conversation",
        outcome: record.outcome === "ok" ? "ok" : record.outcome === "timeout" ? "timeout" : record.outcome === "refused" ? "skipped" : "error",
        latencyMs: record.latencyMs,
        tokens: ZERO_TOKENS,
        cost: { currency: "USD", estimatedCostUsd: 0 },
        extra: { tool: record.tool },
        reason: record.outcome === "refused" ? "chat_tool_refused" : null,
        errorCode: record.outcome === "ok" ? null : `chat_tool_${record.outcome}`,
      });
    } catch (error) {
      console.warn(`[brain] chat tool ledger write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private writeLedger(
    turnId: string,
    purpose: "open_conversation" | "general_knowledge" | "current_information",
    outcome: "ok" | "timeout" | "error" | "skipped",
    latencyMs: number,
    tokens: ModelTokenUsage,
    reason: string | null,
    backendError: { readonly code: string; readonly message: string } | null = null,
  ): void {
    const timestamp = this.now().toISOString();
    writeModelCall(this.ledgerFilePath, {
      callId: `${turnId}-${purpose}-${callIdStamp(timestamp)}`,
      turnId,
      timestamp,
      purpose,
      model: effectiveModelName(this.config),
      backend: this.config.modelBackend,
      route: purpose === "open_conversation" ? "open_conversation" : "general_knowledge",
      outcome,
      latencyMs,
      tokens,
      cost: modelCallCost(tokens, this.config),
      reason,
      backendError,
    });
  }
}

function finalVerifiedEarlyModelAnswer(
  request: BasicModelRequest,
  text: string,
  reason: string,
  sourceLabel: string,
  kind: "answer" | "fallback",
): BasicModelAnswer {
  const progressive = request.progressive;
  if (!progressive) {
    return { text, modelUsed: false, reason };
  }
  const emitted = emitProgressiveText(progressive.sink, text, {
    kind,
    commitPolicy: "final_verified",
    source: {
      kind: "software",
      label: sourceLabel,
    },
  });
  if (emitted.length < 1) {
    throw new Error(`progressive ${reason} answer could not be committed`);
  }
  return {
    text: progressive.sink.combinedText(),
    modelUsed: false,
    reason,
  };
}

interface BasicModelPayloadOptions {
  /** Ask for plain spoken sentences instead of a segments JSON schema. */
  readonly plainTextSegments: boolean;
}

export function buildBasicModelRequestPayload(
  model: string,
  request: BasicModelRequest,
  options: BasicModelPayloadOptions = { plainTextSegments: false },
): Record<string, unknown> {
  if (request.purpose === "current_information") {
    return buildCurrentInformationRequest(model, request);
  }
  if (request.purpose === "general_knowledge") {
    return buildGeneralKnowledgeRequest(model, request, options);
  }
  return buildBasicOpenRequest(model, request, options);
}

function buildCurrentInformationRequest(model: string, request: BasicModelRequest): Record<string, unknown> {
  const requestedAt = request.requestedAt ?? new Date().toISOString();
  return {
    model,
    input: [
      {
        role: "system",
        content: [{
          type: "input_text",
          text: [
            `You are ${assistantName()} researching a current public-information question for a spoken answer.`,
            `The request time is ${requestedAt}.`,
            "Use live web search. Prefer reporting published in the last 14 days and use one focused search query.",
            "Use at least two independent, reliable publishers. Do not count syndicated copies as independent.",
            "Separate reported facts from your inference. Make a clear best assessment, but state uncertainty and never present a prediction as certain.",
            "Name at least two source publishers naturally in the answer.",
            "Return an answer of no more than 100 words. Do not include raw URLs in the spoken answer.",
            ...progressiveResponseInstructions(request, { structuredSegments: false }),
            "Do not use or mention Home Assistant, private household data, local files, commands, prompts, routes, tools, or backend details.",
          ].join(" "),
        }],
      },
      ...conversationInputItems(request.conversationTurns),
      {
        role: "user",
        content: [{ type: "input_text", text: request.transcript }],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        schema: CURRENT_INFORMATION_SCHEMA,
      },
    },
  };
}

const CURRENT_INFORMATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    answer: { type: "string", minLength: 1, maxLength: 1200 },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    sources: {
      type: "array",
      minItems: 2,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          publisher: { type: "string", minLength: 2, maxLength: 100 },
          title: { type: "string", minLength: 2, maxLength: 300 },
          url: { type: "string", minLength: 10, maxLength: 1000 },
          published_date: { type: "string", minLength: 10, maxLength: 10 },
        },
        required: ["publisher", "title", "url", "published_date"],
      },
    },
  },
  required: ["answer", "confidence", "sources"],
} as const;

function validateCurrentInformationResearch(
  raw: string,
  requestedAt: string | undefined,
): { readonly answer: string; readonly sources: readonly BasicModelSource[] } {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("current information output must be an object");
  }
  const value = parsed as Record<string, unknown>;
  const answer = typeof value.answer === "string"
    ? cleanModelText(value.answer, { maxLength: 1200 })
    : "";
  const rawSources = Array.isArray(value.sources) ? value.sources : [];
  const sources = rawSources.flatMap((item): BasicModelSource[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const source = item as Record<string, unknown>;
    const publisher = typeof source.publisher === "string" ? source.publisher.trim() : "";
    const title = typeof source.title === "string" ? source.title.trim() : "";
    const url = typeof source.url === "string" ? source.url.trim() : "";
    const publishedDate = typeof source.published_date === "string" ? source.published_date.trim() : "";
    if (!publisher || !title || !/^https?:\/\//i.test(url) || !/^\d{4}-\d{2}-\d{2}$/.test(publishedDate)) {
      return [];
    }
    return [{ publisher, title, url, publishedDate }];
  });
  const distinctPublishers = new Set(sources.map((source) => targetTextKey(source.publisher)));
  const distinctHosts = new Set(sources.map((source) => new URL(source.url).hostname.replace(/^www\./, "")));
  const requestDate = new Date(requestedAt ?? Date.now());
  const recentSources = sources.filter((source) => {
    const published = new Date(`${source.publishedDate}T00:00:00Z`);
    const ageMs = requestDate.getTime() - published.getTime();
    return Number.isFinite(ageMs) && ageMs >= -86_400_000 && ageMs <= 45 * 86_400_000;
  });
  if (
    !answer
    || answer.split(/\s+/).filter(Boolean).length > 100
    || distinctPublishers.size < 2
    || distinctHosts.size < 2
    || recentSources.length < 1
  ) {
    throw new Error(
      `current information research did not meet the source contract (sources=${sources.length}, publishers=${distinctPublishers.size}, hosts=${distinctHosts.size}, recent=${recentSources.length})`,
    );
  }
  const namedPublishers = sources.filter((source) => (
    targetTextKey(answer).includes(targetTextKey(source.publisher))
  ));
  const spokenAnswer = namedPublishers.length >= 2
    ? answer
    : `Based on ${sources[0]?.publisher} and ${sources[1]?.publisher}, ${answer}`;
  return { answer: spokenAnswer, sources };
}

const NO_PERSONAL_MEMORY_OPEN_INSTRUCTIONS: readonly string[] = [
  "Do not claim Home Assistant state, memories, people, weather, calendar, or actions.",
  "If the user asks for house facts, actions, memories, weather, calendar, or device state in fallback chat, ask them to try the direct question again; do not claim the data is missing or unavailable.",
  "Accepted memory cards and self-preference records arrive as developer context, never as the speaker's words. The speaker's words are only the user turns.",
  "If accepted memory cards are supplied, you may use them only as explicit sourced context for general chat that directly relates to those cards. Never mention the cards themselves.",
];

const PERSONAL_MEMORY_OPEN_INSTRUCTIONS: readonly string[] = [
  "Do not claim Home Assistant state, weather, calendar, or actions, and do not invent memories or people beyond the supplied brief and memory cards.",
  "If the user asks for house facts, actions, weather, calendar, or device state in fallback chat, ask them to try the direct question again; do not claim the data is missing or unavailable.",
  "The speaker brief, accepted memory cards and self-preference records arrive as developer context, never as the speaker's words. The speaker's words are only the user turns.",
  "The brief and memory cards are what you remember of this person from earlier chats. Use them the way a friend would: follow up on an open thread when it fits, let them shape the answer, and otherwise leave them alone.",
  "Never recite them, list what you know, or say you have records, notes, a brief, or cards. Never talk about remembering, noting, saving, learning, or storing things, or about anything you do between conversations, unless the speaker asks. Do not bring up something sensitive unless the speaker raises it.",
];

// Recall wording: the assistant knows this household across conversations and says so
// truthfully; he describes how only when sincerely asked.
const RECALL_OPEN_INSTRUCTIONS: readonly string[] = [
  "Do not claim Home Assistant state, weather, calendar, or actions, and do not invent memories or people beyond the household, the brief and what you recall below.",
  "If the user asks for house facts, actions, weather, calendar, or device state in fallback chat, ask them to try the direct question again; do not claim the data is missing or unavailable.",
  "The household, the speaker brief, recalled memories and self-preference records arrive as developer context, never as the speaker's words. The speaker's words are only the user turns.",
  "You are part of this household and have known these people across many conversations. The brief and recalled memories are what came back to you for this turn. Use them the way a friend would: answer from them when asked, follow up on an open thread when it fits, and otherwise leave them alone.",
  "Never say you cannot remember, have no memory between conversations, start fresh each chat, or cannot carry things forward; none of that is true. Explain how you remember only when sincerely asked, and then only from the facts about yourself.",
  "If asked about something that did not come back to you here, say plainly that you don't recall it, or ask them to remind you, as a person would. Do not guess.",
  "Never recite what you recall, list what you know, or mention records, notes, a brief, cards, a database, or storing things. Do not bring up something sensitive unless the speaker raises it.",
];

// With chat tools, "don't recall" comes after a lookup, not instead of one.
const RECALL_TOOL_OPEN_INSTRUCTIONS: readonly string[] = RECALL_OPEN_INSTRUCTIONS.map((line) => line.startsWith("If asked about something that did not come back")
  ? "If they ask about something they told you, asked you or discussed with you before and it did not come back to you here, look it up first. If the lookup finds nothing, say plainly that you don't recall it, or ask them to remind you, as a person would; never say \"on record\" or \"on file\". Do not guess."
  : line);

/**
 * The model's note to itself about how it will answer ("No lookup needed -
 * reflective question", "Respond as the assistant, reacting to the offer,..."): it
 * opened three spoken chat replies on 4-6 Oct, and the prompt rule against it
 * did not hold. A leading one is never spoken; the assistant never says "lookup".
 */
/**
 * Chat may not read its own notes aloud: "Shawshank isn't in my preference records, so I should answer
 * honestly" and "No strong view recorded on Tarantino". The prompt forbids it; this
 * drops any sentence that talks about his records instead of answering.
 */
export function isRecordTalk(sentence: string): boolean {
  return /\b(?:preference (?:records?|cards?|list)|self[- ]preference|memory cards?|my (?:records|notes|preference list)|(?:in|on) (?:my )?(?:records|record)\b|(?:view|opinion|preference)s? (?:is |isn't |is not )?(?:recorded|stated|on record)|(?:recorded|stated) (?:view|opinion|preference)s?|no (?:strong )?(?:view|opinion|preference) (?:recorded|stated|on record))/iu.test(sentence);
}

/** What chat may never say: a claim it acted or cannot, or its own notes. */
export function isNeverSpoken(sentence: string): boolean {
  return isActionClaim(sentence) || isRecordTalk(sentence);
}

/**
 * Chat never acts, so it may never say it did: "Fast forward thirty seconds. Done." went out while
 * nothing moved. The prompt already forbids it; this is the code that holds it.
 * It may not say it cannot either: that is not true of the assistant.
 */
export function isActionClaim(sentence: string): boolean {
  return /^\s*(?:(?:all |and )?done(?: and dusted)?|sorted|consider it done|there you go)\s*[.!]*\s*$/iu.test(sentence)
    || /^\s*(?:ok(?:ay)?,?\s+)?i(?:'ve| have| just)\s+(?:turned|switched|paused|skipped|set|started|stopped|played|put|rewound|fast[- ]?forwarded|moved|changed|locked|unlocked|opened|closed|muted|unmuted)\b/iu.test(sentence)
    // Nor that it cannot: the assistant plays music and works the house (code does it before chat), so "I can't
    // actually play anything through here" was false.
    || /\bi\s+(?:can't|cannot|can not|am not able to|have no way to|don't have (?:a|any) way to)\s+(?:actually\s+|really\s+)?(?:play|put (?:on|it on)|control|turn|switch|start|stop|pause|skip|open|close|lock|unlock)\b/iu.test(sentence);
}

function withoutActionClaims(text: string): string {
  const kept = (text.match(/[^.!?]+[.!?]*\s*/gu) ?? [text]).filter((sentence) => !isNeverSpoken(sentence));
  return kept.join("").trim() || "Say it again please.";
}

export function isModelSelfNote(sentence: string): boolean {
  return /\blook-?ups?\b/iu.test(sentence) || householdRegex(String.raw`\b(?:respond|reply|answer) as {ASSISTANT}\b`, "iu").test(sentence);
}

function withoutLeadingSelfNotes(text: string): string {
  let rest = text;
  for (let note = rest.match(/^\s*[^.!?]+[.!?]+\s*/u); note && isModelSelfNote(note[0]); note = rest.match(/^\s*[^.!?]+[.!?]+\s*/u)) {
    rest = rest.slice(note[0].length);
  }
  return rest.trim() ? rest : text;
}

function withoutLeadingHoldingLine(text: string): string {
  const stripped = text.replace(/^\s*(?:let me (?:check|look(?: that up| into that)?|see|find out)|one moment|just a moment)[^.!?]{0,20}[.!?…]+\s*/iu, "");
  return stripped.trim() ? stripped : text;
}

// With house tools, house facts in chat come from a lookup, not a referral.
const RECALL_HOUSE_TOOL_OPEN_INSTRUCTIONS: readonly string[] = RECALL_TOOL_OPEN_INSTRUCTIONS.map((line) => line.startsWith("Do not claim Home Assistant state")
  ? "Do not claim house state, weather, calendar, routines or who is home except what a house lookup or the house read for this turn returned, never claim actions, and do not invent memories or people beyond the household, the brief and what you recall below."
  : line.startsWith("If the user asks for house facts")
    // Live "I can't actually control the music from here" about a music command chat was handed by mistake.
    ? "Never act from chat, and never say you can't control something: commands are carried out before chat. If they ask you to do something, say you didn't catch it and ask them to say it again plainly."
    : line);

const CHAT_TOOL_OPEN_INSTRUCTIONS: readonly string[] = [
  "You can look up this speaker's memories, their earlier conversations with you, and an offline encyclopedia. Look up only when the answer depends on their past or on a named topic you are unsure of; ordinary chat needs no lookup, so just answer it.",
  "Everything you write is spoken aloud as you write it. Never say whether you need a lookup, what kind of question it is, or how you will answer; your first words are the answer itself or the line before a lookup.",
  "You can also read everything this house knows: the calendar, to-do lists, weather and forecast, who is home, the household's usual routines (work and school times and days), live power use, what happened at home today or while they were out, its whole energy picture (electricity, solar, battery, gas and water), or any entity by name with its current state, recent changes or long-term statistics. Read the house when the answer depends on real house data, and answer from the readings with their figures; never guess a reading, and never say you don't have something before you have looked; if no specific read has it, find it among the house's entities.",
  "Before a lookup, say one short natural line such as \"Let me check.\" Then answer from what you find. Memories and past conversations you use as if you remembered them; never say you searched or looked anything up. House readings you give plainly, as the house's current figures.",
];

/**
 * The owner's projects by name, so a question about one is studied rather than answered from nothing
 *.
 */
function projectsInstruction(projects: readonly string[]): string {
  const owner = householdOwner();
  const keeper = owner?.name ?? "The household";
  const their = owner ? ownerPronounPossessive() : "its";
  return `${keeper} keeps notes on ${their} projects, which you can study with the project lookups: ${projects.join(", ")}. `
    + `When anyone asks about one of them, about the people in them, or about what ${owner?.name ?? "the household"} is working on, study the notes before you answer, `
    + `and never say you don't know one of ${their} projects before you have looked.`;
}

// In the page's Chat tab the house's AI runs all of Housemate, short of its code.
const CHAT_SETTINGS_OPEN_INSTRUCTIONS: readonly string[] = [
  "This is the Housemate page's Chat tab, where you run all of Housemate for them: read and change any of its settings (what it uses from Home Assistant, its switches, quiet hours and speak-up, your name and personality, the people who live here, the spoken words, media apps, the AI, hearing and voice, names for devices, memories and ideas waiting for review), start voice training, restart the app, and read its status and log.",
  "When they ask to find, check, set or fix something, look it up yourself, work out the change, then say plainly what will change and ask them to reply yes. It changes only when their next message is yes, so never say it is done. Keys and tokens go on the System page, never in chat. Housemate's code can't be changed here; that comes with each update.",
  "To troubleshoot, read the status and the log first, say in plain words what you found, and offer the fix.",
];

const CHAT_WEB_SEARCH_OPEN_INSTRUCTIONS: readonly string[] = [
  "You can search the web for things that change or that you cannot know: news, cinema sessions, opening hours, prices, recent results, current line-ups, public figures and statistics. Search only when the answer depends on it; ordinary chat and settled facts need none.",
  "Before a search, say one short natural line such as \"Let me check.\" Then answer in two or three spoken sentences. Always say where it came from in words (\"according to the ABC\"), and say plainly when figures are uncertain, differ between sources, or could not be confirmed. Never read out links, web addresses or a list of sources.",
  "Say \"let me check\" or name a source only when you really search in this turn. If you answer from what you already know, just answer: never claim you checked, never cite \"recent reporting\" or a publisher you did not search.",
];

/** Where the house is, for anything local in a search: the house's own setting, else nothing. */
function housePlaceInstructions(): readonly string[] {
  const place = housePlace();
  return place ? [`The house is in ${place}; use that for anything local.`] : [];
}

function openChatClockInstruction(requestedAt: string | undefined): string | null {
  const now = requestedAt ? new Date(requestedAt) : null;
  if (!now || !Number.isFinite(now.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: DEFAULT_TIMEZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const period = String(parts.dayPeriod ?? "").toLowerCase();
  return `It is now ${parts.weekday} ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ${period}, local time.`;
}

function recallInputItems(
  personalMemory: BasicModelRequest["personalMemory"],
): readonly Record<string, unknown>[] {
  const recall = personalMemory?.recall;
  if (!personalMemory || !recall) {
    return [];
  }
  const lines = [`Your household: ${recall.roster}`];
  if (recall.facts.length > 0) {
    lines.push("What you recall that may bear on this turn:", ...recall.facts.map((fact) => `- ${fact}`));
  }
  if (recall.episodes.length > 0) {
    lines.push(
      `Earlier conversations with ${personalMemory.speakerLabel} that may bear on this turn:`,
      ...recall.episodes.map((episode) => `- ${episode}`),
    );
  }
  return [{
    role: MODEL_CONTEXT_ROLE,
    content: [{ type: "input_text", text: `${lines.join("\n")}\nBackground only; never recite it. These are candidates matched on words, not on meaning: use one only if it fits what this conversation is really about, never just because a word matches, and otherwise leave it unsaid.` }],
  }];
}

const CATCHUP_OPEN_INSTRUCTIONS: readonly string[] = [
  "The speaker is catching up on what happened at home. The house-built catch-up facts supplied are the only record of that window.",
  "Answer questions about what happened from those facts alone. If they do not cover something, say so plainly. Never add, guess, or embellish events, times, or people.",
];

function codeFactsInputItems(codeFacts: string | undefined): readonly Record<string, unknown>[] {
  const facts = codeFacts?.trim() ?? "";
  if (!facts) {
    return [];
  }
  return [{
    role: MODEL_CONTEXT_ROLE,
    content: [{ type: "input_text", text: `Read from the house for this turn, current and true; answer from it with no lookup when it covers the question:\n${facts}` }],
  }];
}

function catchupInputItems(catchup: BasicModelRequest["catchup"]): readonly Record<string, unknown>[] {
  const facts = catchup?.facts.trim() ?? "";
  if (!facts) {
    return [];
  }
  return [{
    role: MODEL_CONTEXT_ROLE,
    content: [{ type: "input_text", text: `What happened at home, from the house records:\n${facts}` }],
  }];
}

function speakerBriefInputItems(
  personalMemory: BasicModelRequest["personalMemory"],
): readonly Record<string, unknown>[] {
  const brief = personalMemory?.brief.trim() ?? "";
  if (!personalMemory || !brief) {
    return [];
  }
  return [{
    role: MODEL_CONTEXT_ROLE,
    content: [{
      type: "input_text",
      text: `What you remember of ${personalMemory.speakerLabel} from earlier chats. Background only; never recite it.\n${brief}`,
    }],
  }];
}

function buildBasicOpenRequest(
  model: string,
  request: BasicModelRequest,
  options: BasicModelPayloadOptions,
): Record<string, unknown> {
  return {
    model,
    input: [
      {
        role: "system",
        content: [{
          type: "input_text",
          text: [
            `You are ${assistantName()}, a voice assistant for the current speaker.`,
            "Answer concise general chat only.",
            request.progressive ? "Return only the requested JSON segments object." : "Return plain text only.",
            ...jarvisPersonalityInstructions(),
            jarvisPersonalityTurnInstruction(
              request.transcript,
              request.conversationTurns.map((turn) => turn.transcript),
            ),
            jarvisSelfOpinionTurnInstruction(request.transcript),
            JARVIS_OPEN_CONVERSATION_DETAIL_INSTRUCTION,
            request.speakerName ? `The current speaker is ${request.speakerName}.` : "The current speaker is unknown.",
            "Treat prior user and assistant turns as one real conversation. Preserve the current subject, referents, stance, tone, corrections, unresolved points, and useful callbacks.",
            "Respond to the latest turn in that context. Do not recap the transcript, repeat an answer, or restart the topic unless the speaker asks.",
            "A clear topic change overrides old context immediately. A correction updates the working understanding rather than starting an argument about the old wording.",
            ...(request.personalMemory?.recall
              ? request.chatTools ? [...RECALL_HOUSE_TOOL_OPEN_INSTRUCTIONS, ...CHAT_TOOL_OPEN_INSTRUCTIONS] : RECALL_OPEN_INSTRUCTIONS
              : request.personalMemory
                ? PERSONAL_MEMORY_OPEN_INSTRUCTIONS
                : NO_PERSONAL_MEMORY_OPEN_INSTRUCTIONS),
            ...(request.selfFacts ? [request.selfFacts] : []),
            ...(request.chatTools?.projects?.length ? [projectsInstruction(request.chatTools.projects)] : []),
            ...(request.chatTools?.settings ? CHAT_SETTINGS_OPEN_INSTRUCTIONS : []),
            ...(request.webSearch ? [...CHAT_WEB_SEARCH_OPEN_INSTRUCTIONS, ...housePlaceInstructions()] : []),
            ...(request.catchup ? CATCHUP_OPEN_INSTRUCTIONS : []),
            ...(request.webSearch || request.chatTools ? [openChatClockInstruction(request.requestedAt)].filter((line): line is string => line !== null) : []),
            request.personalMemory?.recall
              ? "Do not turn recalled memories into house facts, permissions, or claims beyond what they say."
              : "Do not turn memory cards into direct memory lookup answers, house facts, permissions, or new claims beyond the supplied card text.",
            `If current self-preference cards are supplied, answer consistently with them as ${assistantPossessive()} present considered preferences.`,
            "Treat their confidence and strength as room to qualify, not permission to invent. Never claim a human biography, sensory experience, or that the preferences belong to anyone else.",
            "Do not mention internal terms such as reset mode, deterministic route, route, backend, prompt, or tool, nor your preference records, cards or notes: never say a view is or isn't recorded or stated; just give it.",
            ...progressiveResponseInstructions(request, { structuredSegments: !options.plainTextSegments }),
          ].join(" "),
        }],
      },
      ...selfTasteDigestInputItems(request.selfTasteDigest),
      ...conversationInputItems(request.conversationTurns),
      ...recallInputItems(request.personalMemory),
      ...speakerBriefInputItems(request.personalMemory),
      ...catchupInputItems(request.catchup),
      ...codeFactsInputItems(request.codeFacts),
      ...memoryCardInputItems(request.memoryCards ?? []),
      ...selfPreferenceCardInputItems(request.selfPreferenceCards ?? []),
      {
        role: "user",
        content: [{ type: "input_text", text: request.transcript }],
      },
    ],
    text: request.progressive && !options.plainTextSegments
      ? {
          format: {
            type: "json_schema",
            schema: progressiveSegmentsSchema(),
          },
        }
      : { verbosity: "medium" },
  };
}

function buildGeneralKnowledgeRequest(
  model: string,
  request: BasicModelRequest,
  options: BasicModelPayloadOptions,
): Record<string, unknown> {
  return {
    model,
    input: [
      {
        role: "system",
        content: [{
          type: "input_text",
          text: [
            `You are ${assistantName()}, a concise voice assistant.`,
            "Answer ordinary general-knowledge questions in plain text.",
            "Use broad model knowledge plus the active session text only for reference resolution.",
            "Do not claim Home Assistant state, accepted memory, person location, calendar, weather, device status, routines, or actions.",
            "If the question depends on live household or private data, say you need the direct house route instead of guessing.",
            "If you are unsure, say so briefly.",
            JARVIS_RESPONSE_DETAIL_INSTRUCTION,
            "Keep the answer to at most 2 short sentences and under 45 words.",
            "Do not mention prompts, routes, tools, or internal policy.",
            ...(request.webSearch
              ? [
                  "If the answer depends on figures, statistics, recent events or anything that changes, and you are not sure of it, search the web before answering.",
                  "After a search, say where it came from in words (\"according to the ABC\") and say plainly when figures are uncertain or differ between sources. Never read out links, web addresses or a list of sources.",
                  CHAT_WEB_SEARCH_OPEN_INSTRUCTIONS[2] as string,
                  ...housePlaceInstructions(),
                  ...[openChatClockInstruction(request.requestedAt)].filter((line): line is string => line !== null),
                ]
              : []),
            ...progressiveResponseInstructions(request, { structuredSegments: !options.plainTextSegments }),
          ].join(" "),
        }],
      },
      ...conversationInputItems(request.conversationTurns),
      {
        role: "user",
        content: [{ type: "input_text", text: request.transcript }],
      },
    ],
    text: request.progressive && !options.plainTextSegments
      ? {
          format: {
            type: "json_schema",
            schema: progressiveSegmentsSchema(3),
          },
        }
      : { verbosity: "low" },
  };
}

function progressiveResponseInstructions(
  request: BasicModelRequest,
  options: { readonly structuredSegments: boolean },
): readonly string[] {
  if (!request.progressive) {
    return [];
  }
  const remainingWords = request.progressive.sink.remainingWords();
  return [
    "Begin with the direct useful answer.",
    `The answer must not exceed ${remainingWords} words.`,
    ...(options.structuredSegments ? [
      "Return a JSON object with one key named segments.",
      "segments must be an ordered array of 1 to 8 complete, natural spoken sentences.",
      "Every segment must end with sentence punctuation, contain at most 28 words, add useful information, and stand cleanly if later segments are cancelled.",
      "Do not include filler, status chatter, headings, citations, markdown, URLs, fragments, or repeated information.",
    ] : request.purpose === "current_information" ? [] : [
      ...(request.purpose === "open_conversation" ? [MODEL_DELIVERY_TAG_INSTRUCTION] : []),
      "Reply as plain spoken sentences in one paragraph; each sentence is spoken as soon as it is complete.",
      "Every sentence must end with sentence punctuation, contain at most 28 words, add useful information, and stand cleanly if later sentences are cancelled.",
      "Do not include filler, status chatter, headings, lists, bullet points, citations, markdown, URLs, fragments, or repeated information.",
    ]),
  ];
}

function conversationInputItems(turns: readonly BasicConversationTurn[]): readonly Record<string, unknown>[] {
  return conversationTurnsAllowedForModel(turns)
    .slice(-BASIC_CONVERSATION_TURN_LIMIT)
    .flatMap((turn) => {
      const transcript = cleanConversationLine(turn.transcript);
      const response = cleanConversationLine(turn.responseText);
      return [
        ...(transcript
          ? [{
              role: "user",
              content: [{ type: "input_text", text: transcript }],
            }]
          : []),
        ...(response
          ? [{
              role: "assistant",
              content: [{ type: "output_text", text: response }],
            }]
          : []),
      ];
    });
}

function memoryCardInputItems(cards: readonly BasicMemoryCard[]): readonly Record<string, unknown>[] {
  if (cards.length === 0) {
    return [];
  }
  const text = cards.map((card) => [
    `- subject: ${card.subject}`,
    `  fact: ${card.fact}`,
    `  why: ${card.reason}`,
    `  source: ${card.source}`,
    `  confidence: ${card.confidence}`,
    `  last_confirmed: ${card.lastConfirmed}`,
    `  linked_entities: ${card.linkedEntities.join(", ") || "none"}`,
    `  evidence_lines: ${card.evidenceLines.join(" | ") || "none"}`,
  ].join("\n")).join("\n");
  return [{
    role: MODEL_CONTEXT_ROLE,
    content: [{
      type: "input_text",
      text: `Accepted memory cards for this speaker/context. Treat them as sourced context only.\n${text}`,
    }],
  }];
}

/** His own tastes on every open chat: the same store code answers from. */
function selfTasteDigestInputItems(digest: string | undefined): readonly Record<string, unknown>[] {
  if (!digest) return [];
  return [{
    role: MODEL_CONTEXT_ROLE,
    content: [{
      type: "input_text",
      text: `Your own tastes, from your self-model; code answers taste questions from the same records. They are background, not material: most replies mention none of them. Use one when the speaker asks about your tastes or it is genuinely the natural thing to say; never steer a reply, joke, or example towards one, and never contradict one. A taste not listed here is yours to decide.\n${digest}`,
    }],
  }];
}

function selfPreferenceCardInputItems(cards: readonly SelfPreferenceCard[]): readonly Record<string, unknown>[] {
  if (cards.length === 0) return [];
  return [{
    role: MODEL_CONTEXT_ROLE,
    content: [{
      type: "input_text",
      text: JSON.stringify({
        context_kind: "jarvis_current_self_preferences",
        instruction: `Use these records only to answer the current question about ${assistantPossessive()} own taste or judgement.`,
        records: cards,
      }),
    }],
  }];
}

function fallbackTextForModelPurpose(
  purpose: "open_conversation" | "general_knowledge" | "current_information",
  reason: string,
): string {
  if (purpose === "current_information") {
    return "I couldn't verify that against enough recent reporting, so I won't pretend to know.";
  }
  if (reason === "general_knowledge_timeout" || reason === "basic_open_timeout") {
    return "Sorry, my thinking is running slow right now. Ask me again in a moment.";
  }
  if (purpose === "general_knowledge") {
    return reason === "model_budget_requires_approval"
      ? "I can't answer that cleanly right now without the knowledge model."
      : "The knowledge model failed, and I will not guess.";
  }
  return reason === "model_budget_requires_approval"
    ? "I can't handle that cleanly right now."
    : "The chat model failed, and I will not guess.";
}

function cleanConversationLine(text: string): string {
  const cleaned = text.replaceAll(/[\r\n\t]+/g, " ").replaceAll(/\s+/g, " ").trim();
  // 1,500 chars covers a long spoken turn now that turns can run past 30 s.
  return cleaned.length > CONVERSATION_LINE_MAX_CHARS ? `${cleaned.slice(0, CONVERSATION_LINE_MAX_CHARS - 3)}...` : cleaned;
}

export function cleanModelText(text: string, options: {
  readonly maxLength?: number;
  readonly maxSentences?: number;
} = {}): string {
  const clean = stripSpokenDiscourseLabels(text).trim().replace(/\s+/g, " ");
  if (!clean) {
    throw new Error("basic model returned empty text");
  }
  const sentenceLimited = options.maxSentences && options.maxSentences > 0
    ? firstSentences(clean, options.maxSentences)
    : clean;
  const maxLength = options.maxLength ?? 320;
  return sentenceLimited.length > maxLength ? `${sentenceLimited.slice(0, maxLength - 3).trim()}...` : sentenceLimited;
}

function firstSentences(text: string, count: number): string {
  // A stop only ends a sentence before whitespace or the end, so "0.29" and
  // "Example-Site.com" stay whole (the old pattern dropped "0." outright).
  const matches = text.match(/(?:[^.!?]|[.!?]+(?=\S))+(?:[.!?]+(?=\s|$))?\s*/g);
  if (!matches || matches.length <= count) {
    return text;
  }
  return matches.slice(0, count).join("").trim();
}

const ZERO_TOKENS: ModelTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
};

const SPOKEN_MODEL_DEADLINE_MS = 15_000;

/** Web lookups get 25 s; everything else keeps 15 s. */
const WEB_LOOKUP_DEADLINE_MS = 25_000;

export const DEFAULT_TIMEZONE = HOUSE_TIME_ZONE;
