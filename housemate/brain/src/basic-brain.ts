import { randomUUID } from "node:crypto";
import { normalizeAlias, type AliasEntry } from "./alias-schema.js";
import { BasicContextStore, adaptLegacyBasicResultContext, type BasicContextViews } from "./basic-context-store.js";
import {
  resultId,
  ok,
  type BasicAnswerExplanation,
  type BasicAgentReadContext,
  type BasicCommittedResult,
  type BasicConversationTurn,
  type BasicResult,
  type BasicRoute,
  type PendingClarifierFrame,
} from "./basic-brain-contracts.js";
import {
  catchupServices,
  type BasicBrainOptions,
  type BasicBrainRouteServices,
  type BasicModelProvider,
  type CatchupRuntime,
} from "./basic-brain-services.js";
import { basicSpeechVariationCount, checkInSentence, renderBasicSpeechText, type BasicSpeechRenderPlan } from "./basic-speech-response.js";
import { buildBasicTurnAnalysis, type BasicTurnAnalysis, type BasicTurnContextReference } from "./basic-turn-analysis.js";
import type { ContextEnvelope } from "./context-contract.js";
import { CatchupDigestCache } from "./catchup-digest.js";
import { historicalPresenceOpportunityStillCurrent, refreshedDeterministicMemoryResult } from "./basic-brain-memory.js";
import { resolveHistoricalPersonEntityId } from "./episodic-presence-inference.js";
import { defaultMetricById } from "./basic-brain-metrics.js";
import type { AppConfig } from "./config.js";
import { cognitiveCapabilities } from "./cognitive-control.js";
import { friendlyName, shortFriendlyName } from "./ha-state-cache.js";
import { SqliteMemoryCardAdapter, type MemoryAdapter } from "./memory-cards.js";
import type { MemoryRecallSource } from "./memory-recall-index.js";
import { memoryArchiveActive, memoryArchiveAvailable, type MemoryArchive } from "./memory-archive.js";
import { HouseholdMemory } from "./household-memory.js";
import {
  CORRECTION_STILL_WRONG_REPLY,
  CorrectionLedger,
  correctionLedgerPath,
  repeatsCorrectedAnswer,
  type CorrectionTurnPlan,
} from "./correction-ledger.js";
import { appVersion } from "./app-version.js";
import type { ChatToolHandlers } from "./chat-tool-bridge.js";
import { ProjectDocs } from "./project-docs.js";
import { createChatToolHandlers } from "./chat-tools.js";
import { createChatHouseToolHandlers } from "./chat-house-tools.js";
import { createChatCodeToolHandlers } from "./chat-code-tools.js";
import { memoryWriteAdmitted, memoryReflectionActorId, type MemoryReflectionObserver } from "./memory-reflection.js";
import { OpenAiPersonalityTailRenderer, shouldRequestPersonalityTail } from "./personality-tail.js";
import { emitLookupHoldingLine } from "./progressive-speech.js";
import type { SafeRenderContext, SafeRenderHouseContext, SafeRenderRecentEvent, SafeRenderSummary } from "./result-contract.js";
import { looksLikeHouseSettingRequest } from "./chat-settings-tools.js";
import { isGuestSpeakerRequest, isTrustedSpeakerTrust, pageChatActorId, resolveSpeakerPrincipal, trustedSpeakerLabel } from "./speaker-principal.js";
import type { JarvisSelfModel } from "./self-model.js";
import { tasteEvidenceFromTurn } from "./self-taste-evidence.js";
import { extractTimeWindowEnvelopeFromUtterance, extractTimeWindowFromUtterance, type TimeWindow } from "./time-window-parser.js";
import { appendTurnLogEntry, turnLogPath, type TurnChannel, type TurnLogEntry } from "./turn-log.js";
import { TurnPace } from "./turn-pace.js";
import { dialogueActTone, speechToneForResult } from "./speech-tone.js";
import { buildVoiceBrainResponse, type VoiceBrainHandler, type VoiceBrainRequest } from "./voice-brain.js";
import { normalizeMeasuredRoutingText as normalize, parseRoutingUtterance } from "./routing-text.js";
import { ownerTurn, runOwners } from "./router.js";
import { WikipediaKnowledgeStore } from "./wikipedia-knowledge-store.js";
import type { ReadAgentProvider } from "./read-agent-contracts.js";
import { readAgentWakeRefusal } from "./agentic-read-wake.js";
import { isReportableHouseLight } from "./basic-brain-status.js";
import {
  BASIC_CONVERSATION_TURN_LIMIT,
  BasicOpenModelProvider,
  DEFAULT_TIMEZONE,
  conversationRouteAllowsModelContext,
  openConversationAnswer,
} from "./basic-brain-open-chat.js";
import { generalKnowledgeAnswer, looksLikeCurrentInformationResearchPrompt } from "./basic-brain-knowledge.js";
import { hasActiveModelConversation } from "./conversation-owners.js";
import { looksLikeAction } from "./action-owners.js";
import { speakerMusicAudible } from "./music-control.js";
import { householdRegex } from "./household.js";

export type {
  BasicBrainOptions,
  BasicBrainRouteServices,
  BasicModelAnswer,
  BasicModelProvider,
  BasicModelRequest,
} from "./basic-brain-services.js";
export type { BasicConversationTurn } from "./basic-brain-contracts.js";
const BASIC_CONVERSATION_TTL_MS = 10 * 60 * 1000;
/** Stands in for the model while music is audible: what code did not understand is asked again. */
const MUSIC_ON_MODEL: BasicModelProvider = {
  answer: () => ({ text: "Say it again please.", modelUsed: false, reason: "music playing" }),
};

/**
 * "My the assistant, turn on the lights": over music STT keeps a misheard wake word in front of the request
 *.
 */
function withoutWakeLeftover(request: VoiceBrainRequest): VoiceBrainRequest {
  const rest = request.transcript.replace(householdRegex(String.raw`^\s*(?:(?:(?:my|hi|hey|hay|a|ok|okay)[\s,]+)?{ASSISTANT}\b|(?:my|hi|hey)\s+jobs?(?:\s+(?:is|was|has)(?:\s+to)?)?\b)[\s,.!?]*`, "iu"), "");
  return rest && rest !== request.transcript ? { ...request, transcript: rest } : request;
}

/**
 * Commands are one-off: he does the job and stops listening. A question (the time, the house's
 * power, the weather, chat) leaves the speaker listening for a reply, except
 * over music, which stays paused while it listens (a stock Echo does no follow-up over media).
 */
const COMMAND_ROUTES: ReadonlySet<string> = new Set(["entity_action", "music_playback", "alarm_clock", "deferred_watch"]);

/** "Play" as heard, sound-alikes included (music-request's PLAY_ALIKES), at the start of a turn. */
const PLAY_LIKE_START = /^(?:play|place|plays|played|plate|plane|pray|plague|plain)\b/u;

/**
 * "Play the Terminator theme" heard as "plague terminated theme song": chat asked "Did you mean the
 * Terminator theme song?" and the answer was taken as a new topic and lectured on.
 * When the last turn was play-like and chat answered it with a question, a short reply is the thing to
 * play: "the Terminator theme song" plays it, a bare "yes" plays what chat suggested.
 */
function asPlayAnswer(request: VoiceBrainRequest, turns: readonly BasicConversationTurn[]): VoiceBrainRequest {
  const last = turns.at(-1);
  const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9' ]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!last || last.route !== "open_conversation" || !/\?\s*$/u.test(last.responseText.trim())
    || !PLAY_LIKE_START.test(plain(last.transcript))) {
    return request;
  }
  const answer = request.transcript.trim().replace(/[.!?]+$/u, "");
  const n = plain(answer);
  if (!n || n.split(" ").length > 8 || /^(?:no|nope|nah|never mind|forget it|cancel|stop|what|why|how|who|where|when)\b/u.test(n)) {
    return request;
  }
  let wanted = answer.replace(/^(?:yes|yeah|yep|yup|that's right|correct)[,.!]?\s*/iu, "").replace(/^(?:i mean|i meant|play)\s+/iu, "").trim();
  if (!wanted) {
    wanted = /did you mean (.+?)(?:,| or |\?)/iu.exec(last.responseText)?.[1]?.trim() ?? "";
  }
  return wanted ? { ...request, transcript: `play ${wanted}` } : request;
}

export function createBasicBrainVoiceHandler(options: BasicBrainOptions): VoiceBrainHandler {
  const now = options.now ?? (() => new Date());
  const cognition = cognitiveCapabilities(options.config);
  const turnLogFilePath = options.turnLogFilePath ?? turnLogPath(options.config);
  const appendTurnLog = options.appendTurnLog ?? true;
  const modelProvider = options.modelProvider ?? new BasicOpenModelProvider(options.config, { now });
  const tailRenderer = options.personalityTailRenderer ?? new OpenAiPersonalityTailRenderer(options.config, { now });
  const tailStore = options.personalityTailStore ?? null;
  const memoryAdapter = options.memoryAdapter ?? new SqliteMemoryCardAdapter(options.config);
  // One household memory database: the permanent tier, recall and the turn index live in it.
  const householdMemory = options.householdMemory ?? new HouseholdMemory({
    config: options.config,
    now,
    archive: memoryArchiveAvailable(options.config) && { active: () => memoryArchiveActive(options.config) },
  });
  const memoryArchive = options.memoryArchive !== undefined ? options.memoryArchive : householdMemory.archive;
  // Corrections and the answers they correct; real clients only, after the reply.
  // Built under the breaker; `correctionsLedgerEnabled` is a live switch, checked per turn.
  const correctionLedger = options.correctionLedger !== undefined
    ? options.correctionLedger
    : appendTurnLog && cognition.system
      ? new CorrectionLedger({
          filePath: correctionLedgerPath(options.config),
          appVersion: appVersion(),
          onError: (error) => {
            console.warn(`[brain] correction ledger write failed: ${error instanceof Error ? error.message : String(error)}`);
          },
        })
      : null;
  // Recall syncs lazily; warmed at boot only when recall is on. Nothing opens
  // the memory database at boot while the cognitive breaker is off.
  const memoryRecall = options.memoryRecall !== undefined ? options.memoryRecall : householdMemory;
  if (memoryRecall === householdMemory && options.config.memoryRecallEnabled && cognition.recall) {
    try {
      householdMemory.syncRecall();
    } catch (error) {
      console.warn(`[brain] memory recall index build failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const wikipediaKnowledge = new WikipediaKnowledgeStore(options.config);
  wikipediaKnowledge.prewarm();
  // One turn index for chat tools and catch-up.
  const turnSearch = householdMemory.turns;
  const catchup: CatchupRuntime = {
    digests: new CatchupDigestCache(),
    lastSpokeAt: options.catchupLastSpokeAt ?? ((actorId, before, since) => turnSearch.lastTurnAt(actorId, before, since)),
  };
  const chatTools = options.chatTools !== undefined
    ? options.chatTools
    : options.config.modelBackend === "claude"
      ? createChatToolHandlers({
          memoryRecall,
          turnSearch: cognition.system ? syncedTurnSearch(turnSearch) : turnSearch,
          archive: memoryArchive,
          wikipediaKnowledge,
          house: createChatHouseToolHandlers({
            services: () => options.routes ?? {},
            energySources: (signal) => {
              const fetcher = options.routes?.historyFetcher;
              return fetcher?.fetchEnergySources
                ? fetcher.fetchEnergySources(signal)
                : Promise.reject(new Error("energy dashboard unavailable"));
            },
            timezone: DEFAULT_TIMEZONE,
          }),
          code: createChatCodeToolHandlers({
            config: options.config,
            routes: () => options.routes ?? {},
            catchupServices: () => catchupServices(options.routes ?? {}, catchup),
            timezone: DEFAULT_TIMEZONE,
          }),
          past: { growth: options.selfGrowth ?? null, opinions: options.selfModel ?? null },
          settings: options.houseSettings?.handlers() ?? null,
          // Only a house that set a projects folder gets the project tools.
          ...(options.config.projectsDir ? { projects: new ProjectDocs(options.config.projectsDir) } : {}),
        })
      : null;
  const contextStore = new BasicContextStore();
  const conversationStore = new BasicConversationStore();
  const speechVariationIndexes = new Map<BasicSpeechRenderPlan["kind"], number>();
  let nextTurnSequence = 0;

  return async (arrivedRequest) => {
    const startedAt = now();
    const turnRoutes = readinessGatedRoutes(options.routes ?? {});
    // Music audible on the speaker: code answers as ever, but no model calls, and the
    // wake word STT kept over the music ("my the assistant turn on the lights") is dropped for every route.
    const musicAudible = speakerMusicAudible(arrivedRequest, turnRoutes);
    const heardRequest = musicAudible ? withoutWakeLeftover(arrivedRequest) : arrivedRequest;
    const incomingRequest = heardRequest.channel === "voice"
      ? asPlayAnswer(heardRequest, conversationStore.turnsFor(heardRequest, startedAt))
      : heardRequest;
    const turnId = turnIdFor(startedAt);
    const turnSequence = ++nextTurnSequence;
    const pipelineStartedAtMs = Date.now();
    // Time to first spoken words, recorded for every turn, never read by routing.
    const pace = new TurnPace(pipelineStartedAtMs);
    // Before routing, code may ask what a bare correction meant or re-ask with the answer.
    const spokenTranscript = arrivedRequest.transcript;
    let correctionPlan: CorrectionTurnPlan | null = null;
    if (correctionLedger && options.config.correctionsLedgerEnabled && options.config.correctionAskEnabled) {
      try {
        correctionPlan = correctionLedger.planTurn({
          channel: turnChannelFromRequest(incomingRequest),
          sourceVia: incomingRequest.sourceVia,
          room: incomingRequest.room,
          sessionId: incomingRequest.sessionId,
          transcript: incomingRequest.transcript,
        }, startedAt.getTime());
      } catch (error) {
        console.warn(`[brain] correction planning failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // A re-ask speaks only once the whole answer is checked against the corrected one.
    const { progressive: incomingProgressive, ...incomingFields } = incomingRequest;
    const request: VoiceBrainRequest = {
      ...incomingFields,
      ...(correctionPlan?.kind === "reask" ? { transcript: correctionPlan.transcript } : {}),
      pace,
      ...(incomingProgressive && correctionPlan?.kind !== "reask" ? { progressive: pace.timeSink(incomingProgressive) } : {}),
    };
    const initialRoutingUtterance = parseRoutingUtterance(request.transcript);
    const contextCommitMetadata = {
      turnId,
      turnSequence,
      timestamp: startedAt,
    };
    const contextAdmission = contextStore.beginTurn(request, contextCommitMetadata, {
      clearBeforeCore: initialRoutingUtterance.resetBeforeCore,
    });
    if (initialRoutingUtterance.resetBeforeCore) {
      conversationStore.clear(request);
    }
    const contextStartedAtMs = Date.now();
    const contextSnapshot = contextStore.snapshotFor(request, startedAt, {
      previousSessionTurnSequence: contextAdmission.previousSessionTurnSequence,
    });
    const hasSessionContext = contextSnapshot.hasSessionContext;
    const contextMs = Math.max(0, Date.now() - contextStartedAtMs);
    const conversationStartedAtMs = Date.now();
    const conversationTurns = conversationStore.turnsFor(request, startedAt);
    const conversationMs = Math.max(0, Date.now() - conversationStartedAtMs);
    const agentReadReference = resolveAgenticReadTurnReference(
      request.transcript,
      conversationTurns,
      startedAt,
    );
    const ownedRequest = withSpeakerOwnedAliases(request, turnRoutes.aliases ?? []);
    const semanticRequest = agentReadReference
      ? { ...request, transcript: agentReadReference.proposition }
      : ownedRequest;
    const hasRoutingContext = hasSessionContext || conversationTurns.length > 0;
    const routingUtterance = hasRoutingContext
      ? parseRoutingUtterance(semanticRequest.transcript, {
        hasSessionContext: true,
        contextFrameKinds: contextSnapshot.frameKinds,
      })
      : parseRoutingUtterance(semanticRequest.transcript);
    const routingRequest = routingUtterance.dialoguePrefix && routingUtterance.core
      ? { ...semanticRequest, transcript: routingUtterance.core }
      : semanticRequest;
    const turnAnalysis = buildBasicTurnAnalysis({
      request: semanticRequest,
      routing: routingUtterance,
      startedAt,
      contextFrameKinds: contextSnapshot.frameKinds,
      hasSessionContext,
      contextReferences: {
        activeFocus: turnContextReference(contextSnapshot.views.focus.active),
        pendingClarifier: turnContextReference(contextSnapshot.views.clarifier.pending),
        latestAnswerTrace: turnContextReference(contextSnapshot.views.answerTrace.latest?.envelopes[0] ?? null),
      },
      sources: turnRoutes,
    });
    const handleStartedAtMs = Date.now();
    // The Chat tab's yes (or no) to a House settings change the AI proposed, answered by code.
    const settingsActorId = options.houseSettings ? pageChatActorId(request) : null;
    const settingsReply = settingsActorId ? await options.houseSettings!.answer(settingsActorId, spokenTranscript, turnId, startedAt) : null;
    const turnOptions = {
      request: routingRequest,
      turnId,
      config: options.config,
      routes: turnRoutes,
      modelProvider: musicAudible ? MUSIC_ON_MODEL : modelProvider,
      ...(options.selfModel ? { selfModel: options.selfModel } : {}),
      ...(options.memoryReflection ? { memoryReflection: options.memoryReflection } : {}),
      memoryAdapter,
      memoryRecall,
      memoryArchive,
      correctionLedger,
      chatTools,
      wikipediaKnowledge,
      catchup,
      now,
      contextViews: contextSnapshot.views,
      hasSessionContext,
      conversationTurns,
      turnAnalysis,
      resolvedTimeWindow: agentReadReference?.canonicalTimeWindow ?? null,
      claimClarifier: (frameId: string) => contextStore.claimClarifier(request, contextCommitMetadata, frameId)?.payload ?? null,
    };
    // A settings message in the Chat tab goes to the AI and its settings tools, not the code answer sharing its words.
    const settingsTurn = settingsReply === null && settingsActorId !== null && chatTools !== null
      && options.config.chatToolsEnabled && looksLikeHouseSettingRequest(routingRequest.transcript);
    const deterministicResult = settingsReply !== null
      ? ok("open_conversation", settingsReply, "helm: house setting change answered")
      : correctionPlan?.kind === "ask" ? {
      ...ok("open_conversation", correctionPlan.reply, `oops: asked what was meant (${correctionPlan.reason}; corrected turn ${correctionPlan.corrected.turnId})`),
      tone: dialogueActTone("disagree"),
    } : settingsTurn ? await openConversationAnswer(turnOptions) : await handleBasicTurn(turnOptions);
    const baseResult = await recoverWithReadAgent(
      deterministicResult,
      musicAudible ? undefined : options.readAgent,
      semanticRequest,
      turnId,
      startedAt,
      conversationTurns,
      options.config,
      agentReadReference?.canonicalTimeWindow ?? null,
      turnAnalysis,
      turnRoutes,
    );
    if (request.progressive?.signal.aborted) {
      // Nothing is committed to context or memory for an answer nobody heard,
      // but the turn itself still happened and belongs in the log.
      if (appendTurnLog) {
        appendTurnLogEntry(turnLogFilePath, {
          ...turnLogHead(turnId, startedAt, request, spokenTranscript, request.progressive.combinedText()),
          route: baseResult.route,
          outcome: "disconnected",
          modelUsed: baseResult.modelUsed,
          latencyMs: Math.max(0, now().getTime() - startedAt.getTime()),
          actionTouchedEntities: [...baseResult.touchedEntities],
          notes: `${baseResult.notes}; voice client disconnected before the turn finished`,
          pace: pace.snapshot(),
        });
      }
      const error = new Error("Progressive voice turn disconnected");
      error.name = "AbortError";
      throw error;
    }
    const handleMs = Math.max(0, Date.now() - handleStartedAtMs);
    const explanationStartedAtMs = Date.now();
    const checkedResult: BasicResult = correctionPlan?.kind === "reask"
      && repeatsCorrectedAnswer(baseResult.text, correctionPlan.corrected.responseText)
      ? {
          ...ok("open_conversation", CORRECTION_STILL_WRONG_REPLY, `oops: re-ask gave the corrected ${baseResult.route} answer again`),
          tone: dialogueActTone("disagree"),
        }
      : baseResult;
    const focusedResult = attachModelConversationFocus(checkedResult);
    const explainedResult = attachAnswerExplanation(focusedResult, turnRoutes);
    const explanationMs = Math.max(0, Date.now() - explanationStartedAtMs);
    const session = explainedResult.sessionDirective ?? (request.conversationMode ? "continue" : "close");
    const result = adaptLegacyBasicResultContext(
      options.deterministicSpeechStyle && options.deterministicSpeechStyle !== "stable"
        ? withRotatedCheckIn(explainedResult, startedAt, speechVariationIndexes)
        : explainedResult,
      session,
    );
    const rememberStartedAtMs = Date.now();
    contextStore.commit(request, result, contextCommitMetadata);
    if (result.resetContext || session === "close") {
      conversationStore.clear(request);
    } else {
      conversationStore.remember(semanticRequest, result, turnId, startedAt, session);
    }
    const rememberMs = Math.max(0, Date.now() - rememberStartedAtMs);
    if (options.memoryReflection) {
      try {
        options.memoryReflection.observeTurn({
          request,
          route: result.route,
          status: result.status,
          responseText: result.text,
          turnId,
          timestamp: startedAt,
          session: result.resetContext ? "close" : session,
        });
      } catch (error) {
        console.warn(`[brain] memory reflection observe failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (memoryArchive) {
      try {
        memoryArchive.observeTurn({ request, route: result.route, status: result.status, turnId, timestamp: startedAt });
      } catch (error) {
        console.warn(`[brain] memory archive observe failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (options.selfModel && cognition.system) {
      try {
        observeTasteEvidence(options.selfModel, request, result, conversationTurns.at(-1) ?? null);
      } catch (error) {
        console.warn(`[brain] taste evidence failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const summaryStartedAtMs = Date.now();
    const summary = basicSafeRenderSummary(result, turnId, session, turnRoutes, startedAt, request);
    const summaryMs = Math.max(0, Date.now() - summaryStartedAtMs);
    const renderStartedAtMs = Date.now();
    const speechStyle = options.deterministicSpeechStyle ?? "stable";
    const speechVariationIndex = speechStyle !== "stable"
      && request.channel === "voice"
      && result.speechPlan
      ? nextSpeechVariationIndex(result.speechPlan, startedAt, speechVariationIndexes)
      : undefined;
    const leadText = renderBasicSpeechText(
      result.speechPlan,
      result.text,
      request.channel,
      speechVariationIndex,
      speechStyle === "stable" ? undefined : speechStyle,
    );
    const renderMs = Math.max(0, Date.now() - renderStartedAtMs);
    const pipelineMs = Math.max(0, Date.now() - pipelineStartedAtMs);
    const timingNote = `brain timings context=${contextMs} conversation=${conversationMs} handle=${handleMs} explain=${explanationMs} remember=${rememberMs} summary=${summaryMs} render=${renderMs} total=${pipelineMs}`;
    // Guest summaries already carry guest-redacted render context, so every
    // authenticated transport gets a model-written tail.
    const tailContext = {
      summary,
      leadText,
      channel: request.channel,
      speakerName: request.speaker.name,
      sourceVia: request.sourceVia,
    };
    const confirmBeep = result.confirmBeep === true && request.channel === "voice";
    const tail = tailStore
      && !confirmBeep
      && !musicAudible
      && request.speaker.transportAuthenticated === true
      && shouldRequestPersonalityTail(summary, request.channel, request.sourceVia)
      ? tailStore.start(
          turnId,
          leadText,
          (signal) => tailRenderer.renderTail(tailContext, { signal }),
        )
      : null;

    const explanation = answerExplanationForResult(result);
    const turnLogEntry: TurnLogEntry = {
      ...turnLogHead(turnId, startedAt, request, spokenTranscript, result.text),
      route: result.route,
      outcome: result.status,
      modelUsed: result.modelUsed,
      latencyMs: Math.max(0, now().getTime() - startedAt.getTime()),
      actionTouchedEntities: [...result.touchedEntities],
      ...(explanation ? { explanation } : {}),
      ...(request.progressive || pace.hasRecord() ? { pace: pace.snapshot() } : {}),
      notes: (correctionPlan?.kind === "reask" ? `oops re-asked as: ${correctionPlan.transcript}; ` : "") + (tail
        ? `${result.notes}; ${timingNote}; personality tail pending`
        : `${result.notes}; ${timingNote}`),
    };

    if (appendTurnLog) {
      appendTurnLogEntry(turnLogFilePath, turnLogEntry);
    }

    try {
      if (options.config.correctionsLedgerEnabled) correctionLedger?.observe(turnLogEntry);
    } catch (error) {
      console.warn(`[brain] correction ledger observe failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const response = buildVoiceBrainResponse({
      text: result.text,
      modelUsed: result.modelUsed,
      ...(confirmBeep ? { confirmBeep } : {}),
      ...(result.musicAfter && request.channel === "voice" ? { musicAfter: result.musicAfter } : {}),
      ...(request.channel === "voice" && !COMMAND_ROUTES.has(result.route) && !musicAudible ? { listenAgain: true } : {}),
      speechText: leadText,
      ...(options.config.speechToneEnabled ? {
        tone: speechToneForResult(result, (entityId) => turnRoutes.stateCache?.get(entityId) ?? null),
      } : {}),
      session,
      route: {
        route: result.route,
        confidence: result.confidence,
        status: result.status,
        resultId: result.resultId,
        turnId,
      },
      ...(tail ? {
        tail: {
          turn_id: tail.turnId,
          status: tail.status,
          poll_path: `/voice/tail/${encodeURIComponent(tail.turnId)}`,
        },
      } : {}),
    });
    return response;
  };
}

/** The turn log fields every entry starts with, in the log's own order. */
function turnLogHead(
  turnId: string,
  startedAt: Date,
  request: VoiceBrainRequest,
  spokenTranscript: string,
  responseText: string,
): Omit<TurnLogEntry, "route" | "outcome" | "modelUsed" | "latencyMs" | "actionTouchedEntities" | "notes"> {
  return {
    schemaVersion: 1,
    turnId,
    timestamp: startedAt.toISOString(),
    channel: turnChannelFromRequest(request),
    transcript: spokenTranscript,
    ...(request.transcriptConfidence !== undefined
      ? { transcriptConfidence: request.transcriptConfidence }
      : {}),
    responseText,
    room: request.room,
    sourceVia: request.sourceVia,
    sessionId: request.sessionId,
    conversationMode: request.conversationMode,
    speakerName: request.speaker.name,
    speakerVoiceId: request.speaker.voiceId,
    speakerConfidence: request.speaker.confidence,
    speakerTrustedActorId: request.speaker.trustedActorId ?? null,
    speakerIdentitySource: request.speaker.identitySource ?? "none",
  };
}

function readinessGatedRoutes(routes: BasicBrainRouteServices): BasicBrainRouteServices {
  if (!routes.stateCache || routes.stateCache.hasReceivedStateSnapshot()) {
    return routes;
  }
  const {
    stateCache: _retainedState,
    houseState: _retainedHouse,
    eventWatcher: _retainedEvents,
    ...sourceSafeRoutes
  } = routes;
  return sourceSafeRoutes;
}

async function recoverWithReadAgent(
  deterministic: BasicResult,
  readAgent: ReadAgentProvider | undefined,
  request: VoiceBrainRequest,
  turnId: string,
  requestedAt: Date,
  conversationTurns: readonly BasicConversationTurn[],
  config: AppConfig,
  resolvedTimeWindow: TimeWindow | null,
  turnAnalysis: BasicTurnAnalysis,
  routes: BasicBrainRouteServices,
): Promise<BasicResult> {
  if (
    !readAgent
    || deterministic.status !== "declined"
    || deterministic.readFallback?.eligible !== true
  ) {
    return deterministic;
  }
  const canonicalTimeWindow = canonicalReadAgentTimeWindow(
    request.transcript,
    requestedAt,
    deterministic.readFallback.ownPresenceWindow ?? null,
    resolvedTimeWindow,
  );
  const wakeRefusal = readAgentWakeRefusal({
    route: deterministic.route,
    fallbackReason: deterministic.readFallback.reason,
    semantics: turnAnalysis.semantics,
    tags: turnAnalysis.tags,
    normalizedSurface: turnAnalysis.normalizedSurface,
    canonicalTimeWindow,
  }) ?? (looksLikeAction(normalize(request.transcript)) ? "action_route" : null);
  if (wakeRefusal) {
    return {
      ...deterministic,
      notes: `${deterministic.notes}; read agent not woken: ${wakeRefusal}`,
    };
  }
  const principal = resolveSpeakerPrincipal(request.speaker);
  const transportActorId = request.speaker.trustedActorId ?? null;
  if (
    !isTrustedSpeakerTrust(principal.trust)
    || !principal.personId
    || !principal.label
    || !transportActorId
    || principal.personId !== transportActorId
    || principal.personId !== config.cognitiveOperatorActorId
  ) {
    return deterministic;
  }
  const ownPresenceWindow = deterministic.readFallback.ownPresenceWindow ?? null;
  const ownPresencePersonEntityId =
    deterministic.readFallback.ownPresencePersonEntityId ?? null;
  const memoryGuard = deterministic.readFallback.memoryGuard;
  if (
    (ownPresenceWindow === null) !== (ownPresencePersonEntityId === null)
    || (
      ownPresenceWindow !== null
      && (
        !memoryGuard
        || memoryGuard.actorId !== principal.personId
        || !routes.stateCache
        || !routes.stateCache.hasReceivedStateSnapshot()
        || resolveHistoricalPersonEntityId(
          principal.personId,
          routes.stateCache,
          routes.aliases ?? [],
        ) !== ownPresencePersonEntityId
      )
    )
  ) {
    return {
      ...deterministic,
      notes: `${deterministic.notes}; owner presence grant was absent or no longer matched its deterministic person binding`,
    };
  }
  // Memory the deterministic answer read changed while the agent worked: answer again from memory.
  const memoryMovedOn = (notes: string): BasicResult | null => memoryGuard
    && !historicalPresenceOpportunityStillCurrent(config, {
      actorId: memoryGuard.actorId,
      window: memoryGuard.window,
      memorySnapshotToken: memoryGuard.memorySnapshotToken,
      fallbackText: "",
    })
    ? refreshedDeterministicMemoryResult(config, {
      request,
      transcript: request.transcript,
      now: requestedAt.toISOString(),
      sourceRef: turnId,
      timeWindowOverride: memoryGuard.window,
    }, notes)
    : null;
  try {
    const progressive = request.progressive;
    const recovered = await readAgent.recover({
      ...(progressive ? { beforePlanning: () => emitLookupHoldingLine(progressive) } : {}),
      turnId,
      transcript: request.transcript.trim(),
      fallbackRoute: deterministic.route,
      fallbackReason: deterministic.readFallback.reason,
      finalFraming:
        deterministic.route === "memory_query"
        && deterministic.readFallback.reason === "historical_state_required"
          ? {
              kind: "deterministic_lead",
              text: deterministic.text,
            }
          : { kind: "generic_read" },
      principal: {
        actorId: principal.personId,
        label: principal.label,
      },
      requestedAt: requestedAt.toISOString(),
      ownPresenceWindow,
      ownPresencePersonEntityId,
      canonicalTimeWindow,
      contextQuestions: trailingAgentReadQuestions(conversationTurns),
    });
    const rerun = memoryMovedOn("memory changed during read-agent recovery; reran deterministic recall");
    if (rerun) {
      return rerun;
    }
    if (!recovered) {
      return deterministic;
    }
    return {
      route: "agentic_read",
      status: recovered.status === "answered" ? "ok" : "declined",
      confidence: recovered.confidence,
      text: recovered.text,
      modelUsed: recovered.modelUsed,
      resultId: resultId(turnId),
      touchedEntities: [],
      notes: `${deterministic.notes}; ${recovered.notes}`,
      modelContextAllowed: false,
      readEvidence: recovered.evidence,
      agentReadContext: {
        proposition: agentReadProposition(
          request.transcript,
          requestedAt,
          resolvedTimeWindow,
        ),
        canonicalTimeWindow: agentReadContextWindow(
          request.transcript,
          requestedAt,
          resolvedTimeWindow,
          canonicalTimeWindow,
        ),
      },
    };
  } catch (error) {
    return memoryMovedOn("memory changed while read-agent recovery failed; reran deterministic recall") ?? {
      ...deterministic,
      notes: `${deterministic.notes}; read agent failed closed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function canonicalReadAgentTimeWindow(
  transcript: string,
  requestedAt: Date,
  ownPresenceWindow: {
    readonly start: string;
    readonly end: string;
  } | null,
  resolvedTimeWindow: TimeWindow | null,
): {
  readonly start: string;
  readonly end: string;
  readonly timezone: string;
  readonly label: string;
} | null {
  if (resolvedTimeWindow) {
    return {
      start: resolvedTimeWindow.start,
      end: resolvedTimeWindow.end,
      timezone: resolvedTimeWindow.timezone,
      label: resolvedTimeWindow.label,
    };
  }
  const parsed = extractTimeWindowFromUtterance(transcript, {
    now: requestedAt,
    timezone: DEFAULT_TIMEZONE,
  });
  if (parsed.status === "matched" && parsed.window) {
    return {
      start: parsed.window.start,
      end: parsed.window.end,
      timezone: parsed.window.timezone,
      label: parsed.window.label,
    };
  }
  return ownPresenceWindow
    ? {
        ...ownPresenceWindow,
        timezone: DEFAULT_TIMEZONE,
        label: "the privacy-approved memory day",
      }
    : null;
}

function agentReadContextWindow(
  transcript: string,
  requestedAt: Date,
  resolvedTimeWindow: TimeWindow | null,
  canonicalWindow: {
    readonly start: string;
    readonly end: string;
    readonly timezone: string;
    readonly label: string;
  } | null,
): TimeWindow | null {
  if (resolvedTimeWindow) {
    return { ...resolvedTimeWindow };
  }
  const parsed = extractTimeWindowFromUtterance(transcript, {
    now: requestedAt,
    timezone: DEFAULT_TIMEZONE,
  });
  if (
    parsed.status === "matched"
    && parsed.window
    && (
      !canonicalWindow
      || (
        parsed.window.start === canonicalWindow.start
        && parsed.window.end === canonicalWindow.end
      )
    )
  ) {
    return { ...parsed.window };
  }
  return canonicalWindow
    ? {
        ...canonicalWindow,
        source: "model_fallback",
        confidence: "high",
      }
    : null;
}

function basicSafeRenderSummary(
  result: BasicResult,
  turnId: string,
  session: "continue" | "close",
  routes: BasicBrainRouteServices,
  timestamp: Date,
  request: VoiceBrainRequest,
): SafeRenderSummary {
  const renderContext = basicRenderContext(routes, timestamp, request);
  return {
    schemaVersion: 1,
    resultId: result.resultId ?? `result-${turnId}`,
    turnId,
    route: result.route,
    status: result.status,
    confidence: result.confidence,
    target: null,
    facts: [],
    safety: [],
    suggestedPlainText: result.text,
    modelPolishUseful: basicTailUseful(result),
    session,
    ...(renderContext ? { renderContext } : {}),
  };
}

function basicRenderContext(routes: BasicBrainRouteServices, timestamp: Date, request: VoiceBrainRequest): SafeRenderContext | null {
  const house = safeRenderHouseContext(routes, timestamp, request);
  const recentEvents = safeRenderRecentEvents(routes, timestamp, request);
  if (!house && recentEvents.length === 0) {
    return null;
  }
  return {
    house,
    recentEvents,
  };
}

function safeRenderHouseContext(routes: BasicBrainRouteServices, timestamp: Date, request: VoiceBrainRequest): SafeRenderHouseContext | null {
  const snapshot = routes.houseState?.snapshot(timestamp);
  if (!snapshot) {
    return null;
  }
  const guestMode = isGuestSpeakerRequest(request);
  return {
    timezone: snapshot.timezone,
    occupancy: guestMode ? "unknown" : snapshot.modes.occupancy,
    timeMode: snapshot.modes.time,
    compositeMode: guestMode ? "unresolved" : snapshot.modes.composite,
    localHour: snapshot.activity.localHour,
    weekend: snapshot.activity.weekend,
    quietHoursActive: snapshot.activity.quietHoursActive,
    bedtimeActive: snapshot.activity.bedtimeActive,
    presentPeople: guestMode
      ? []
      : snapshot.presence.people
        .filter((person) => person.presence === "home" || person.presence === "zone")
        .map((person) => person.name),
  };
}

function safeRenderRecentEvents(routes: BasicBrainRouteServices, timestamp: Date, request: VoiceBrainRequest): readonly SafeRenderRecentEvent[] {
  const ninetyMinutesMs = 90 * 60 * 1000;
  const guestMode = isGuestSpeakerRequest(request);
  return (routes.eventWatcher?.recentEvents(4) ?? [])
    .filter((event) => {
      const detectedAtMs = Date.parse(event.detectedAt);
      if (!Number.isFinite(detectedAtMs) || timestamp.getTime() - detectedAtMs > ninetyMinutesMs) {
        return false;
      }
      if (guestMode && (
        event.kind === "person_arrived"
        || event.kind === "person_departed"
        || event.kind === "calendar_start"
      )) {
        return false;
      }
      return true;
    })
    .map((event): SafeRenderRecentEvent => {
      switch (event.kind) {
        case "calendar_start":
          return {
            kind: event.kind,
            detectedAt: event.detectedAt,
            calendarName: event.calendarName,
            eventSummary: event.eventSummary,
            eventStart: event.eventStart,
          };
        case "rain_start":
          return {
            kind: event.kind,
            detectedAt: event.detectedAt,
            label: event.label,
          };
        case "person_arrived":
        case "person_departed":
          return {
            kind: event.kind,
            detectedAt: event.detectedAt,
            personName: event.personName,
          };
        case "opening_opened":
        case "opening_closed":
          return {
            kind: event.kind,
            detectedAt: event.detectedAt,
            label: event.label,
          };
      }
    });
}

function basicTailUseful(result: BasicResult): boolean {
  if (result.status !== "ok" || result.modelUsed) {
    return false;
  }
  return [
    "entity_status",
    "house_status",
    "time_window_math",
    "energy_budget",
    "weather_query",
  ].includes(result.route);
}

function answerExplanationForResult(result: BasicCommittedResult): BasicAnswerExplanation | null {
  return result.answerTrace?.explanation ?? null;
}

function turnContextReference(
  envelope: ContextEnvelope<unknown> | null,
): BasicTurnContextReference | null {
  return envelope
    ? Object.freeze({
        frameId: envelope.frameId,
        owner: envelope.owner,
        domain: envelope.domain,
        sourceTurnSequence: envelope.source.turnSequence,
        allowedUses: Object.freeze([...envelope.allowedUses]),
      })
    : null;
}

class BasicConversationStore {
  private readonly entries = new Map<string, readonly BasicConversationTurn[]>();

  turnsFor(request: VoiceBrainRequest, timestamp: Date): readonly BasicConversationTurn[] {
    const sessionKey = this.sessionKeyFor(request);
    const speakerKey = this.speakerKeyFor(request);
    const sessionTurns = sessionKey ? this.freshTurnsForKey(sessionKey, timestamp) : [];
    const speakerTurns = speakerKey && speakerKey !== sessionKey ? this.freshTurnsForKey(speakerKey, timestamp) : [];
    return dedupeConversationTurns([...sessionTurns, ...speakerTurns]).slice(-BASIC_CONVERSATION_TURN_LIMIT);
  }

  remember(request: VoiceBrainRequest, result: BasicResult, turnId: string, timestamp: Date, session: "continue" | "close"): void {
    if (session === "close") {
      const sessionKey = this.sessionKeyFor(request);
      if (sessionKey) {
        this.entries.delete(sessionKey);
      }
      return;
    }
    if (result.status === "error") {
      return;
    }
    const transcript = request.transcript.trim();
    const responseText = result.text.trim();
    if (!transcript || !responseText) {
      return;
    }
    const turn: BasicConversationTurn = {
      turnId,
      speakerName: request.speaker.name,
      transcript,
      responseText,
      timestampMs: timestamp.getTime(),
      route: result.route,
      status: result.status,
      modelUsed: result.modelUsed,
      modelContextAllowed: conversationResultAllowsModelContext(result),
      ...(result.agentReadContext
        ? {
            agentReadContext: {
              proposition: result.agentReadContext.proposition,
              canonicalTimeWindow: result.agentReadContext.canonicalTimeWindow
                ? { ...result.agentReadContext.canonicalTimeWindow }
                : null,
            },
          }
        : {}),
    };
    const sessionKey = this.sessionKeyFor(request);
    if (sessionKey) {
      const next = [
        ...this.freshTurnsForKey(sessionKey, timestamp),
        turn,
      ].slice(-BASIC_CONVERSATION_TURN_LIMIT);
      this.entries.set(sessionKey, next);
    }
    const speakerKey = this.speakerKeyFor(request);
    if (speakerKey && speakerKey !== sessionKey && shouldCarryConversationAcrossSessions(result)) {
      const next = [
        ...this.freshTurnsForKey(speakerKey, timestamp),
        turn,
      ].slice(-BASIC_CONVERSATION_TURN_LIMIT);
      this.entries.set(speakerKey, next);
    }
  }

  clear(request: VoiceBrainRequest): void {
    for (const key of this.keysFor(request)) {
      this.entries.delete(key);
    }
  }

  private freshTurnsForKey(key: string, timestamp: Date): readonly BasicConversationTurn[] {
    const fresh = (this.entries.get(key) ?? []).filter((entry) => timestamp.getTime() - entry.timestampMs <= BASIC_CONVERSATION_TTL_MS);
    if (fresh.length > 0) {
      this.entries.set(key, fresh);
    } else {
      this.entries.delete(key);
    }
    return fresh;
  }

  private keysFor(request: VoiceBrainRequest): readonly string[] {
    const sessionKey = this.sessionKeyFor(request);
    const speakerKey = this.speakerKeyFor(request);
    return [sessionKey, speakerKey].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
  }

  private sessionKeyFor(request: VoiceBrainRequest): string | null {
    if (request.sessionId) {
      return `session:${request.sessionId}:${speakerTokenForRequest(request) ?? "anonymous"}`;
    }
    return null;
  }

  private speakerKeyFor(request: VoiceBrainRequest): string | null {
    const speaker = speakerTokenForRequest(request);
    return speaker ? `speaker:${speaker}:${request.channel}` : null;
  }
}

async function handleBasicTurn(options: {
  readonly request: VoiceBrainRequest;
  readonly turnId: string;
  readonly config: AppConfig;
  readonly routes: BasicBrainRouteServices;
  readonly modelProvider: BasicModelProvider;
  readonly selfModel?: JarvisSelfModel;
  readonly memoryReflection?: MemoryReflectionObserver;
  readonly memoryAdapter: MemoryAdapter;
  readonly memoryRecall: MemoryRecallSource | null;
  readonly memoryArchive: MemoryArchive | null;
  readonly correctionLedger: CorrectionLedger | null;
  readonly chatTools: ChatToolHandlers | null;
  readonly wikipediaKnowledge: WikipediaKnowledgeStore;
  readonly catchup: CatchupRuntime;
  readonly now: () => Date;
  readonly contextViews: BasicContextViews;
  readonly hasSessionContext: boolean;
  readonly conversationTurns: readonly BasicConversationTurn[];
  readonly turnAnalysis: BasicTurnAnalysis;
  readonly resolvedTimeWindow: TimeWindow | null;
  readonly claimClarifier: (frameId: string) => PendingClarifierFrame | null;
}): Promise<BasicResult> {
  return runOwners({
    ...options,
    turn: ownerTurn({
      request: options.request,
      analysis: options.turnAnalysis,
      conversationTurns: options.conversationTurns,
      activeModelConversation: hasActiveModelConversation(options.conversationTurns),
      currentInformationResearch: looksLikeCurrentInformationResearchPrompt(options.request.transcript.trim()),
      resolvedTimeWindow: options.resolvedTimeWindow,
    }),
    openChat: (text) => openConversationAnswer(text === undefined
      ? options
      : { ...options, request: { ...options.request, transcript: text } }),
    knowledge: () => generalKnowledgeAnswer(options),
    stages: { earlyKnowledgeMs: 0, followUpMs: 0 },
  });
}

/** The turn index for chat tools, brought up to date at boot. */
function syncedTurnSearch(index: HouseholdMemory["turns"]): HouseholdMemory["turns"] {
  try {
    index.sync();
  } catch (error) {
    console.warn(`[brain] turn search index build failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return index;
}

function resolveAgenticReadTurnReference(
  transcript: string,
  conversationTurns: readonly BasicConversationTurn[],
  now: Date,
): BasicAgentReadContext | null {
  const normalized = normalize(transcript);
  const latest = conversationTurns.at(-1) ?? null;
  const prior = latest?.route === "agentic_read"
    && latest.agentReadContext?.proposition.trim()
    ? latest.agentReadContext
    : null;
  if (!prior) {
    return null;
  }
  if (isAnswerRepeatOrClarityRequest(normalized)) {
    return {
      proposition: prior.proposition,
      canonicalTimeWindow: prior.canonicalTimeWindow
        ? { ...prior.canonicalTimeWindow }
        : null,
    };
  }
  const extracted = extractTimeWindowEnvelopeFromUtterance(transcript, {
    now,
    timezone: DEFAULT_TIMEZONE,
    referenceWindow: prior.canonicalTimeWindow,
  });
  if (extracted.result.status !== "matched" || !extracted.result.window) {
    return null;
  }
  const residual = cleanAgentReadProposition(extracted.residualInput ?? "");
  if (
    extracted.result.window.source !== "context_reference"
    && hasAgentReadProposition(residual)
  ) {
    return null;
  }
  return {
    proposition: hasAgentReadProposition(residual)
      ? residual
      : prior.proposition,
    canonicalTimeWindow: { ...extracted.result.window },
  };
}

function trailingAgentReadQuestions(
  conversationTurns: readonly BasicConversationTurn[],
): readonly string[] {
  const questions: string[] = [];
  for (let index = conversationTurns.length - 1; index >= 0; index -= 1) {
    const turn = conversationTurns[index];
    if (!turn || turn.route !== "agentic_read") {
      break;
    }
    questions.push(turn.agentReadContext?.proposition ?? turn.transcript);
    if (questions.length === 2) {
      break;
    }
  }
  return questions.reverse();
}

function isAnswerRepeatOrClarityRequest(normalized: string): boolean {
  return /^(?:say|repeat|tell me) (?:that|it)(?: again| once more)?$/.test(normalized)
    || /^(?:what did you (?:say|just say))$/.test(normalized)
    || /\b(?:more simply|simpler|plain english|shorter|clarify that)\b/.test(normalized);
}

function agentReadProposition(
  transcript: string,
  now: Date,
  resolvedTimeWindow: TimeWindow | null,
): string {
  if (resolvedTimeWindow) {
    return cleanAgentReadProposition(transcript);
  }
  const extracted = extractTimeWindowEnvelopeFromUtterance(transcript, {
    now,
    timezone: DEFAULT_TIMEZONE,
  });
  const residual = extracted.result.status === "matched"
    ? cleanAgentReadProposition(extracted.residualInput ?? "")
    : "";
  return hasAgentReadProposition(residual)
    ? residual
    : transcript.trim();
}

function cleanAgentReadProposition(value: string): string {
  const leadingDiscourse = new Set(["and", "also", "then", "so", "okay", "ok"]);
  const tokens = normalize(value).split(/\s+/u).filter(Boolean);
  while (tokens[0] && leadingDiscourse.has(tokens[0])) {
    tokens.shift();
  }
  return tokens.join(" ");
}

function hasAgentReadProposition(value: string): boolean {
  const scaffolding = new Set([
    "about", "and", "also", "it", "same", "that", "the", "then", "what",
  ]);
  return value
    .split(/\s+/u)
    .filter(Boolean)
    .some((token) => !scaffolding.has(token));
}

function dedupeConversationTurns(turns: readonly BasicConversationTurn[]): readonly BasicConversationTurn[] {
  const seen = new Set<string>();
  const deduped: BasicConversationTurn[] = [];
  for (const turn of turns) {
    const key = JSON.stringify(turn);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(turn);
  }
  return deduped.sort((left, right) => left.timestampMs - right.timestampMs);
}

function shouldCarryConversationAcrossSessions(result: BasicResult): boolean {
  return result.route === "open_conversation" || result.route === "general_knowledge";
}

function conversationResultAllowsModelContext(result: BasicResult): boolean {
  return result.status !== "error"
    && (
      result.modelContextAllowed
      ?? conversationRouteAllowsModelContext(result.route)
    );
}

function speakerTokenForRequest(request: VoiceBrainRequest): string | null {
  return resolveSpeakerPrincipal(request.speaker).token;
}

/**
 * "My computer" means the speaker's own: when a verified household member
 * says "my X" and an alias "<their name>'s X" exists ("sam's computer"),
 * the turn routes on that alias. Without an owner alias nothing changes, so
 * Alex's "my computer" stays ambiguous rather than reading the owner's outlet.
 */
export function withSpeakerOwnedAliases(request: VoiceBrainRequest, aliases: readonly AliasEntry[]): VoiceBrainRequest {
  const label = trustedSpeakerLabel(request);
  if (!label || aliases.length === 0 || !/\bmy\b/i.test(request.transcript)) {
    return request;
  }
  const owner = `${normalizeAlias(`${label}'s`)} `;
  const owned = aliases
    .map((entry) => entry.normalizedAlias)
    .filter((alias) => alias.startsWith(owner))
    .map((alias) => alias.slice(owner.length))
    .sort((left, right) => right.length - left.length);
  let transcript = request.transcript;
  for (const thing of owned) {
    const words = thing.split(" ").map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    transcript = transcript.replace(new RegExp(`\\bmy\\s+${words.join("\\s+")}\\b`, "giu"), `${label}'s ${thing}`);
  }
  return transcript === request.transcript ? request : { ...request, transcript };
}

function attachAnswerExplanation(result: BasicResult, routes: BasicBrainRouteServices): BasicResult {
  if (result.status === "error" || result.route === "open_conversation") {
    return result;
  }
  const explanation = buildAnswerExplanation(result, routes);
  if (!explanation) {
    return result;
  }
  return {
    ...result,
    additionalContextFrames: [
      ...(result.additionalContextFrames ?? []),
      { kind: "answer_explanation", explanation },
    ],
  };
}

function attachModelConversationFocus(result: BasicResult): BasicResult {
  if (result.status !== "ok"
    || !result.modelUsed
    || (result.route !== "open_conversation" && result.route !== "general_knowledge")) {
    return result;
  }
  return {
    ...result,
    additionalContextFrames: [
      ...(result.additionalContextFrames ?? []),
      { kind: "model_conversation" },
    ],
  };
}

function buildAnswerExplanation(result: BasicResult, routes: BasicBrainRouteServices): BasicAnswerExplanation | null {
  const specific = (() => {
    switch (result.route) {
    case "entity_status":
      return explanationForEntityStatus(result, routes);
    case "house_status":
      return explanationForHouseStatus(result, routes);
    case "house_summary":
    case "event_log":
      return explanationForHouseDigest(result, routes);
    case "weather_query":
      return explanationForWeather(result, routes);
    case "calendar_query":
      return explanationForCalendar(result, routes);
    case "memory_query":
      return explanationForMemory(result);
    case "calculation":
      return explanationForCalculation(result);
    case "time_window_math":
      return explanationForMetric(result, routes);
    case "energy_budget":
      return explanationForEnergyBudget(result, routes);
    case "music_playback":
      return explanationForMusicPlayback(result);
    case "general_knowledge":
      return explanationForGeneralKnowledge(result);
    case "agentic_read":
      return explanationForAgenticRead(result);
    default:
      return null;
    }
  })();
  return specific ?? genericExplanationForResult(result, routes);
}

function explanationForAgenticRead(result: BasicResult): BasicAnswerExplanation | null {
  const evidence = result.readEvidence ?? [];
  const successful = evidence.filter((item) => item.status === "ok");
  if (successful.length === 0) {
    return null;
  }
  const sourceLabels = [...new Set(successful.flatMap((item) => item.sourceLabels))];
  const sourceEntityIds = [...new Set(successful.flatMap((item) => item.entityIds))];
  return {
    route: result.route,
    confidence: result.confidence,
    reason: "The bounded read agent planned read-only lookups, then the verifier checked every spoken claim against the returned evidence.",
    sourceSummary: [...new Set(successful.map((item) => item.source))].join(", "),
    sourceLabels,
    sourceEntityIds,
    actionBoundary: "The agent had no device-action tools and no action was attempted.",
  };
}

function explanationForEntityStatus(result: BasicResult, routes: BasicBrainRouteServices): BasicAnswerExplanation | null {
  if (result.contextFrame?.kind !== "entity_status") {
    return null;
  }
  const target = result.contextFrame.target;
  if (result.notes.includes("entity identity resolved")) {
    return {
      route: result.route,
      confidence: result.confidence,
      reason: `I matched ${target.label} to Home Assistant entity metadata without using the model.`,
      sourceSummary: "Home Assistant entity metadata",
      sourceLabels: sourceLabelsForEntityIds(routes, target.entityIds, [target.label]),
      sourceEntityIds: [...target.entityIds],
      actionBoundary: "No device action was attempted.",
      targetLabel: target.label,
    };
  }
  const inferred = result.notes.includes("inferred outside temperature from vague temperature prompt");
  return {
    route: result.route,
    confidence: result.confidence,
    reason: inferred
      ? `I inferred you meant outside temperature, then checked live Home Assistant state for ${target.label}.`
      : `I used the entity status route and checked live Home Assistant state for ${target.label}.`,
    sourceSummary: "live Home Assistant state",
    sourceLabels: sourceLabelsForEntityIds(routes, target.entityIds, [target.label]),
    sourceEntityIds: [...target.entityIds],
    actionBoundary: "No device action was attempted.",
    targetLabel: target.label,
  };
}

function explanationForHouseStatus(result: BasicResult, routes: BasicBrainRouteServices): BasicAnswerExplanation | null {
  const lights = routes.stateCache?.entries().filter(isReportableHouseLight) ?? [];
  return {
    route: result.route,
    confidence: result.confidence,
    reason: "I used the house-status route and checked the live Home Assistant light states across the house.",
    sourceSummary: "live Home Assistant light states",
    sourceLabels: lights.length > 0 ? lights.map(shortFriendlyName) : ["house lights"],
    sourceEntityIds: lights.map((state) => state.entityId),
    actionBoundary: "No device action was attempted.",
    targetLabel: "house lights",
  };
}

/** House summaries and event logs: what was combined, from which watched or live signals. */
function explanationForHouseDigest(result: BasicResult, routes: BasicBrainRouteServices): BasicAnswerExplanation | null {
  const frame = result.contextFrame;
  if ((frame?.kind !== "house_summary" && frame?.kind !== "event_log") || frame.kind !== result.route) {
    return null;
  }
  const summary = frame.kind === "house_summary";
  return {
    route: result.route,
    confidence: result.confidence,
    reason: summary
      ? `I built a ${frame.scope} summary by combining the available live house signals instead of guessing.`
      : `I built a ${frame.scope} event log from watched house events instead of guessing.`,
    sourceSummary: frame.sourceSummary || (summary ? "live house state plus other sourced house signals" : "passive watcher event log"),
    sourceLabels: sourceLabelsForEntityIds(routes, frame.sourceEntityIds, [summary ? "house summary" : "event log"]),
    sourceEntityIds: [...frame.sourceEntityIds],
    actionBoundary: "No device action was attempted.",
    targetLabel: frame.scope,
  };
}

function explanationForWeather(result: BasicResult, routes: BasicBrainRouteServices): BasicAnswerExplanation | null {
  const sourceEntityIds = extractEntityIds(result.notes);
  const targetLabel = result.contextFrame?.kind === "weather" && result.contextFrame.forecastLabel
    ? result.contextFrame.forecastLabel
    : "weather";
  const inferred = result.notes.includes("inferred outside temperature from vague temperature prompt");
  return {
    route: result.route,
    confidence: result.confidence,
    reason: inferred
      ? `I inferred you meant outside temperature, then used the weather route for ${targetLabel}.`
      : `I used the weather route for ${targetLabel}.`,
    sourceSummary: result.notes.includes("hourly weather forecast")
      ? "hourly weather forecast plus live weather state"
      : "live BOM weather state",
    sourceLabels: sourceLabelsForEntityIds(routes, sourceEntityIds, ["weather state"]),
    sourceEntityIds,
    actionBoundary: "No device action was attempted.",
    targetLabel,
  };
}

function explanationForCalendar(result: BasicResult, routes: BasicBrainRouteServices): BasicAnswerExplanation | null {
  if (result.contextFrame?.kind !== "calendar") {
    return null;
  }
  return {
    route: result.route,
    confidence: result.confidence,
    reason: `I used the calendar route and checked the selected calendars for ${result.contextFrame.window.label}.`,
    sourceSummary: "Home Assistant calendar events",
    sourceLabels: sourceLabelsForEntityIds(routes, result.contextFrame.entityIds, ["calendar"]),
    sourceEntityIds: [...result.contextFrame.entityIds],
    actionBoundary: "No device action was attempted.",
    targetLabel: result.contextFrame.window.label,
  };
}

function explanationForMemory(result: BasicResult): BasicAnswerExplanation | null {
  if (result.contextFrame?.kind === "historical_presence") {
    return {
      route: result.route,
      confidence: result.confidence,
      reason: "I couldn't find an accepted memory, so I checked the exact Home Assistant person history and reported only sustained registered-zone evidence.",
      sourceSummary: result.contextFrame.sourceSummary,
      sourceLabels: ["Home Assistant presence history"],
      sourceEntityIds: [...result.contextFrame.sourceEntityIds],
      actionBoundary: "No device action was attempted.",
      targetLabel: result.contextFrame.window.label,
    };
  }
  if (result.contextFrame?.kind === "outdoor_clothing_memory") {
    return {
      route: result.route,
      confidence: result.confidence,
      reason: `I used accepted memory for ${result.contextFrame.subject}.`,
      sourceSummary: "accepted memory",
      sourceLabels: [`${result.contextFrame.subject} memory`],
      sourceEntityIds: [],
      actionBoundary: "No device action was attempted.",
      targetLabel: result.contextFrame.subject,
    };
  }
  if (!/accepted .*memory/i.test(result.notes)) {
    return null;
  }
  return {
    route: result.route,
    confidence: result.confidence,
    reason: "I used the accepted memory path for that answer.",
    sourceSummary: "accepted memory",
    sourceLabels: ["accepted memory"],
    sourceEntityIds: [],
    actionBoundary: "No device action was attempted.",
  };
}

function explanationForCalculation(result: BasicResult): BasicAnswerExplanation | null {
  if (result.contextFrame?.kind !== "calculation") {
    return null;
  }
  return {
    route: result.route,
    confidence: result.confidence,
    reason: `I used the local scalar calculator for ${result.contextFrame.expression}.`,
    sourceSummary: "local scalar calculator",
    sourceLabels: ["local scalar calculator"],
    sourceEntityIds: [],
    actionBoundary: "No live house state, accepted memory, or device action was used.",
    targetLabel: result.contextFrame.expression,
  };
}

function explanationForMetric(result: BasicResult, routes: BasicBrainRouteServices): BasicAnswerExplanation | null {
  const sourceEntityIds = extractEntityIds(result.notes);
  const metricId = result.contextFrame?.kind === "current_metric"
    || result.contextFrame?.kind === "history_metric"
    || result.contextFrame?.kind === "comparison_metric"
    ? result.contextFrame.metricId
    : null;
  const metric = metricId ? defaultMetricById(metricId) : null;
  const metricLabel = metric?.label
    ?? (result.contextFrame?.kind === "current_metric"
      || result.contextFrame?.kind === "history_metric"
      || result.contextFrame?.kind === "comparison_metric"
      ? result.contextFrame.composed?.subjectLabel ?? "that metric"
      : "that metric");
  return {
    route: result.route,
    confidence: result.confidence,
    reason: `I used the metric route for ${metricLabel}.`,
    sourceSummary: result.notes.includes("history") || result.notes.includes("compared")
      ? "Home Assistant history/statistics"
      : "live Home Assistant metric state",
    sourceLabels: sourceLabelsForEntityIds(routes, sourceEntityIds, [metricLabel]),
    sourceEntityIds,
    actionBoundary: "No device action was attempted.",
    targetLabel: metricLabel,
  };
}

function explanationForEnergyBudget(result: BasicResult, routes: BasicBrainRouteServices): BasicAnswerExplanation | null {
  const sourceEntityIds = extractEntityIds(result.notes);
  return {
    route: result.route,
    confidence: result.confidence,
    reason: "I used the energy budget route and its configured source sensors.",
    sourceSummary: "energy budget sources",
    sourceLabels: sourceLabelsForEntityIds(routes, sourceEntityIds, ["energy budget"]),
    sourceEntityIds,
    actionBoundary: "No device action was attempted.",
    targetLabel: "energy budget",
  };
}

function explanationForMusicPlayback(result: BasicResult): BasicAnswerExplanation | null {
  if (result.contextFrame?.kind !== "music_playback") {
    return null;
  }
  return {
    route: result.route,
    confidence: result.confidence,
    reason: `I used Music Assistant search results and the ${result.contextFrame.endpointLabel} speaker.`,
    sourceSummary: "Music Assistant plus the selected speaker",
    sourceLabels: [result.contextFrame.endpointLabel],
    sourceEntityIds: [],
    actionBoundary: "Playback was limited to the selected speaker.",
    targetLabel: result.contextFrame.endpointLabel,
  };
}

function explanationForGeneralKnowledge(result: BasicResult): BasicAnswerExplanation | null {
  if (result.contextFrame?.kind === "wikipedia_abstract") {
    const labels = [result.contextFrame.title];
    if (result.contextFrame.resolvedFromTitle) {
      labels.push(`${result.contextFrame.resolvedFromTitle} redirect`);
    }
    return {
      route: result.route,
      confidence: result.confidence,
      reason: `I answered from the local Wikipedia abstract index for ${result.contextFrame.title}.`,
      sourceSummary: "local Wikipedia abstract index",
      sourceLabels: labels,
      sourceEntityIds: [],
      actionBoundary: "No live house state, accepted memory, or device action was used.",
      targetLabel: result.contextFrame.title,
    };
  }
  return {
    route: result.route,
    confidence: result.confidence,
    reason: "I used the general knowledge route and answered from bounded model knowledge rather than house truth.",
    sourceSummary: "bounded model knowledge",
    sourceLabels: ["general knowledge model"],
    sourceEntityIds: [],
    actionBoundary: "No live house state, accepted memory, or device action was used.",
    targetLabel: "general knowledge",
  };
}

function genericExplanationForResult(result: BasicResult, routes: BasicBrainRouteServices): BasicAnswerExplanation | null {
  if (result.route === "open_conversation") {
    return null;
  }
  const routeLabel = result.route.replaceAll("_", " ");
  const sourceEntityIds = extractEntityIds(result.notes);
  return {
    route: result.route,
    confidence: result.confidence,
    reason: genericExplanationReason(result, routeLabel),
    sourceSummary: genericSourceSummaryForRoute(result.route),
    sourceLabels: sourceLabelsForEntityIds(routes, sourceEntityIds, [routeLabel]),
    sourceEntityIds,
    actionBoundary: "No device action was attempted.",
  };
}

function genericExplanationReason(result: BasicResult, routeLabel: string): string {
  if (result.status === "clarify") {
    return `I stayed on the ${routeLabel} route and asked for clarification instead of guessing.`;
  }
  if (result.status === "declined") {
    return `I stayed on the ${routeLabel} route and declined because I couldn't confirm a safe source-backed answer.`;
  }
  return `I used the ${routeLabel} route for that answer.`;
}

function genericSourceSummaryForRoute(route: BasicRoute): string {
  switch (route) {
    case "entity_status":
    case "house_status":
    case "house_summary":
    case "event_log":
      return "live Home Assistant state";
    case "weather_query":
      return "weather sources";
    case "calendar_query":
      return "calendar sources";
    case "memory_query":
      return "accepted memory";
    case "calculation":
      return "local scalar calculator";
    case "time_window_math":
    case "energy_budget":
      return "Home Assistant metric sources";
    case "music_playback":
      return "Music Assistant plus the selected speaker";
    case "deferred_watch":
      return "live Home Assistant state plus passive watcher events";
    case "general_knowledge":
      return "bounded model knowledge";
    default:
      return "route sources";
  }
}

/**
 * Taste evidence, after the reply: household speakers
 * on real clients only, so evals and probes never move his tastes.
 */
function observeTasteEvidence(
  selfModel: JarvisSelfModel,
  request: VoiceBrainRequest,
  result: BasicResult,
  previous: BasicConversationTurn | null,
): void {
  const actorId = memoryReflectionActorId(request);
  if (!actorId || !memoryWriteAdmitted(request)) return;
  const plan = result.speechPlan;
  const observations = tasteEvidenceFromTurn({
    preferences: selfModel.listPreferences(),
    transcript: request.transcript,
    route: result.route,
    status: result.status,
    askedPreferenceIds: result.selfTastePreferenceIds ?? [],
    previous: previous
      ? { transcript: previous.transcript, responseText: previous.responseText, ...(previous.route ? { route: previous.route } : {}) }
      : null,
    played: result.status === "ok" && plan?.kind === "music_playback" ? { track: plan.track, artist: plan.artist } : null,
  });
  const outcome = selfModel.recordTasteEvidence(observations, actorId);
  for (const nudge of outcome.nudges) {
    console.info(`[brain] taste nudge: ${nudge.preferenceId} ${nudge.field} ${nudge.from} -> ${nudge.to} (evidence ${nudge.evidenceIds.join(", ")})`);
  }
}

function extractEntityIds(text: string): readonly string[] {
  const matches = text.match(/\b[a-z_]+\.[a-z0-9_]+\b/g) ?? [];
  return [...new Set(matches)];
}

function sourceLabelsForEntityIds(
  routes: BasicBrainRouteServices,
  entityIds: readonly string[],
  fallbacks: readonly string[] = [],
): readonly string[] {
  const labels = entityIds.map((entityId) => {
    const state = routes.stateCache?.get(entityId);
    return state ? friendlyName(state) : entityId;
  });
  return [...new Set(labels.length > 0 ? labels : [...fallbacks])];
}

function turnIdFor(date: Date): string {
  return `turn-${date.toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}`;
}

/**
 * "How are you?": the rotated line becomes the reply text itself,
 * on every channel, so what is spoken is what the turn log and the chat
 * history record, and back-to-back check-ins never repeat a line.
 */
function withRotatedCheckIn(
  result: BasicResult,
  startedAt: Date,
  indexes: Map<BasicSpeechRenderPlan["kind"], number>,
): BasicResult {
  const plan = result.speechPlan;
  if (plan?.kind !== "check_in") {
    return result;
  }
  const { speechPlan: _plan, ...rest } = result;
  return { ...rest, text: checkInSentence(plan.speakerName, nextSpeechVariationIndex(plan, startedAt, indexes)) };
}

function nextSpeechVariationIndex(
  plan: BasicSpeechRenderPlan,
  startedAt: Date,
  indexes: Map<BasicSpeechRenderPlan["kind"], number>,
): number {
  const count = basicSpeechVariationCount(plan);
  const previous = indexes.get(plan.kind);
  const seed = [...`${plan.kind}:${startedAt.toISOString()}`]
    .reduce((hash, character) => ((hash * 31) + character.charCodeAt(0)) >>> 0, 0);
  const index = previous === undefined ? seed % count : (previous + 1) % count;
  indexes.set(plan.kind, index);
  return index;
}

function turnChannelFromRequest(request: VoiceBrainRequest): TurnChannel {
  if (request.channel === "chat" || request.channel === "test") {
    return request.channel;
  }
  return "voice";
}
