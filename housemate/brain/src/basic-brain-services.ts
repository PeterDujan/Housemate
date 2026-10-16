import type { BasicSpeechStyle } from "./basic-speech-response.js";
import type { HouseholdMemory } from "./household-memory.js";
import type { MemoryArchive } from "./memory-archive.js";
import type { CorrectionLedger } from "./correction-ledger.js";
import type { AlarmClockService } from "./alarm-clock.js";
import type { AliasEntry } from "./alias-schema.js";
import type { BasicConversationTurn } from "./basic-brain-contracts.js";
import type { ChatToolHandlers } from "./chat-tool-bridge.js";
import type { HousemateChat } from "./chat-settings-tools.js";
import type { ConditionalReminderService } from "./conditional-reminders.js";
import type { AppConfig } from "./config.js";
import type { PassiveEventWatcherService } from "./event-watchers.js";
import type { HaCalendarFetcher } from "./ha-calendar.js";
import type { HaHistoryFetcher } from "./ha-history.js";
import type { MusicAssistantClient } from "./ha-music-assistant.js";
import type { HaRegistryIndex } from "./ha-registry-index.js";
import type { HaStateCache } from "./ha-state-cache.js";
import type { HouseStateProvider } from "./house-state.js";
import type { HaTodoFetcher } from "./ha-todo.js";
import type { HaWeatherForecastFetcher } from "./ha-weather-forecast.js";
import type { JarvisDeviceEndpoint } from "./housemate-device-endpoint.js";
import type { LocalMediaCatalogClient } from "./local-media-catalog.js";
import type { BasicMemoryCard, MemoryAdapter } from "./memory-cards.js";
import type { MemoryRecallSource } from "./memory-recall-index.js";
import type { PersonalityTailRenderer, PersonalityTailStore } from "./personality-tail.js";
import type { ProgressiveSpeechSink } from "./progressive-speech.js";
import type { ReadAgentProvider } from "./read-agent-contracts.js";
import type { MemoryReflectionObserver } from "./memory-reflection.js";
import type { SelfGrowthStore } from "./self-growth.js";
import type { JarvisSelfModel, SelfPreferenceCard } from "./self-model.js";
import type { DeviceSwitch } from "./device-control.js";
import type { VacuumQueue } from "./vacuum-control.js";
import type { VoiceExposure } from "./voice-exposure.js";
import type { TurnPace } from "./turn-pace.js";
import type { CatchupDigestCache, CatchupServices } from "./catchup-digest.js";

export interface BasicBrainOptions {
  readonly config: AppConfig;
  readonly routes?: BasicBrainRouteServices;
  readonly now?: () => Date;
  readonly deterministicSpeechStyle?: "stable" | BasicSpeechStyle;
  readonly turnLogFilePath?: string;
  readonly appendTurnLog?: boolean;
  readonly modelProvider?: BasicModelProvider;
  readonly personalityTailRenderer?: PersonalityTailRenderer;
  readonly personalityTailStore?: PersonalityTailStore;
  readonly memoryAdapter?: MemoryAdapter;
  /** The one household memory database; built from config when not given. */
  readonly householdMemory?: HouseholdMemory;
  /** Recall pre-fetch for open chat; the household memory unless a test swaps it. */
  readonly memoryRecall?: MemoryRecallSource | null;
  /** The permanent tier; the household memory's unless a test swaps or drops it. */
  readonly memoryArchive?: MemoryArchive | null;
  /** Corrections ledger; built from config when `correctionsLedgerEnabled` and the turn log is on. */
  readonly correctionLedger?: CorrectionLedger | null;
  /** Read-only chat tools for trusted speakers' open chat; built from config when `chatToolsEnabled`. */
  readonly chatTools?: ChatToolHandlers | null;
  readonly readAgent?: ReadAgentProvider;
  readonly selfModel?: JarvisSelfModel;
  /** His self-account history, for the search_my_past chat tool. */
  readonly selfGrowth?: SelfGrowthStore;
  /** Post-chat memory reflection; sees each finished turn, never delays the reply. */
  readonly memoryReflection?: MemoryReflectionObserver;
  /** The whole app's settings for the page's Chat tab; absent outside the app. */
  readonly houseSettings?: HousemateChat | null;
  /** "Since we last spoke" lookup for the catch-up digest; defaults to the household turn index. */
  readonly catchupLastSpokeAt?: (actorId: string, before: Date, since: Date) => string | null;
}

export interface BasicBrainRouteServices {
  readonly stateCache?: HaStateCache;
  readonly registry?: HaRegistryIndex;
  readonly aliases?: readonly AliasEntry[];
  /** Assist's expose list, the assistant's voice list. */
  readonly voiceExposure?: VoiceExposure;
  readonly historyFetcher?: Pick<HaHistoryFetcher, "fetchBest"> & Partial<Pick<HaHistoryFetcher, "fetchHistory" | "fetchStatistics" | "fetchEnergySources">>;
  readonly weatherForecastFetcher?: HaWeatherForecastFetcher;
  readonly calendarFetcher?: HaCalendarFetcher;
  readonly todoFetcher?: HaTodoFetcher;
  readonly musicAssistant?: MusicAssistantClient;
  /** The gate's HA side; absent means every action keeps the locked decline. */
  readonly deviceControl?: DeviceSwitch;
  /** The vacuum's own queue services and the dashboard's rooms; absent means no vacuum owner. */
  readonly vacuumQueue?: VacuumQueue;
  readonly mediaCatalog?: Partial<Pick<LocalMediaCatalogClient, "recommendForAgent" | "findForAgent" | "listForAgent">>;
  readonly alarmClock?: AlarmClockService;
  readonly conditionalReminder?: ConditionalReminderService;
  readonly deviceEndpoints?: readonly JarvisDeviceEndpoint[];
  readonly houseState?: HouseStateProvider;
  readonly eventWatcher?: PassiveEventWatcherService;
}

export interface BasicModelProvider {
  answer(request: BasicModelRequest): Promise<BasicModelAnswer> | BasicModelAnswer;
}

export interface BasicModelRequest {
  readonly turnId: string;
  readonly purpose?: "open_conversation" | "general_knowledge" | "current_information";
  readonly transcript: string;
  readonly requestedAt?: string;
  readonly speakerName: string | null;
  readonly channel: string;
  readonly conversationTurns: readonly BasicConversationTurn[];
  readonly memoryCards?: readonly BasicMemoryCard[];
  readonly selfPreferenceCards?: readonly SelfPreferenceCard[];
  /** Open chat: his compact taste list from the self-model store. */
  readonly selfTasteDigest?: string;
  /** Open chat: the code-owned facts about the assistant, for sincere questions only. */
  readonly selfFacts?: string;
  /**
   * Present only when memory reflection is on and the speaker is a trusted
   * household member: switches the prompt to personal-memory wording and
   * carries that person's brief ("" when none yet).
   */
  readonly personalMemory?: {
    readonly speakerLabel: string;
    readonly brief: string;
    /**
     * Present only when memory recall is on: the household roster and the few
     * memories recalled for this turn. Switches the prompt to recall wording.
     */
    readonly recall?: {
      readonly roster: string;
      readonly facts: readonly string[];
      readonly episodes: readonly string[];
    };
  };
  /**
   * Present only for a trusted speaker's open chat while chat tools are on:
   * the tools act for this verified actor, never for anyone the model names.
   */
  readonly chatTools?: {
    readonly actorId: string;
    readonly actorLabel: string;
    readonly handlers: ChatToolHandlers;
    /** The page's Chat tab through Home Assistant's login: the settings tools work. */
    readonly settings?: boolean;
    /** The names of the owner's projects, whose notes the project tools read. */
    readonly projects?: readonly string[];
  };
  /**
   * Open chat may search the web.
   * Carries no personal data, so it does not need a verified speaker.
   */
  readonly webSearch?: boolean;
  /**
   * Catch-up turns and their follow-ups only: the
   * code-built digest as plain fact lines. Never present on other turns.
   */
  readonly catchup?: {
    readonly facts: string;
  };
  /**
   * What code already read for a topic it recognised in this turn
   * (routines, who's home, calendar, weather, to-dos, power), so the model
   * needs no lookup round trip. Same sources as the chat tools.
   */
  readonly codeFacts?: string;
  readonly progressive?: {
    readonly sink: ProgressiveSpeechSink;
  };
  /** Internal per-turn timing recorder; never changes the answer. */
  readonly pace?: TurnPace;
}

export interface BasicModelAnswer {
  readonly text: string;
  readonly modelUsed: boolean;
  readonly reason: string | null;
  readonly sources?: readonly BasicModelSource[];
}

export interface BasicModelSource {
  readonly publisher: string;
  readonly title: string;
  readonly url: string;
  readonly publishedDate: string;
}

/** Catch-up digests kept between turns, and when each speaker last spoke. */
export interface CatchupRuntime {
  readonly digests: CatchupDigestCache;
  readonly lastSpokeAt: NonNullable<CatchupServices["lastSpokeAt"]>;
}

export function catchupServices(routes: BasicBrainRouteServices, runtime: CatchupRuntime): CatchupServices {
  const history = routes.historyFetcher;
  return {
    ...(routes.stateCache ? { stateCache: routes.stateCache } : {}),
    ...(history?.fetchHistory ? { fetchHistory: history.fetchHistory.bind(history) } : {}),
    ...(history?.fetchStatistics ? { fetchStatistics: history.fetchStatistics.bind(history) } : {}),
    ...(history?.fetchEnergySources ? { fetchEnergySources: history.fetchEnergySources.bind(history) } : {}),
    ...(routes.calendarFetcher ? { calendarFetcher: routes.calendarFetcher } : {}),
    lastSpokeAt: runtime.lastSpokeAt,
  };
}
