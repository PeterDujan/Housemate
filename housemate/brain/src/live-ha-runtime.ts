import { HaHistoryCache, HaHistoryFetcher } from "./ha-history.js";
import { HaCalendarService } from "./ha-calendar.js";
import type { HaRegistryIndex, HaRegistryIndexInput } from "./ha-registry-index.js";
import type { HaStateCache } from "./ha-state-cache.js";
import { createMusicAssistantDirectClientFromHaConfig, HaMusicAssistantService } from "./ha-music-assistant.js";
import { HaTodoService } from "./ha-todo.js";
import { HaWeatherForecastService } from "./ha-weather-forecast.js";
import {
  createHomeAssistantWebSocketClient,
  type HaWebSocketClient,
  type HaWebSocketClientOptions,
  type HaWebSocketMessage,
} from "./ha-websocket.js";
import type { AppConfig } from "./config.js";
import { notificationActionFromHaMessage } from "./memory-reflection.js";
import type { PassiveStateChangeObservation } from "./event-watchers.js";
import { recordOrNull } from "./value-guards.js";
import { fetchVoiceExposure, type VoiceExposure } from "./voice-exposure.js";
import { HOUSE_TIME_ZONE } from "./house-config.js";

export interface LiveHaRuntimeScheduler {
  schedule(delayMs: number, callback: () => void): () => void;
}

export interface LiveHaRuntimeOptions {
  readonly stateCache: HaStateCache;
  readonly registry: HaRegistryIndex;
  readonly now?: () => Date;
  readonly timezone?: string;
  readonly onError?: (message: string) => void;
  readonly onStateChanged?: (change: PassiveStateChangeObservation) => void;
  /** When set, also subscribes to phone notification button taps. */
  readonly onNotificationAction?: (action: string) => void;
  /** Assist's expose list, re-read with the registry and every few minutes. */
  readonly voiceExposure?: VoiceExposure;
  readonly voiceExposureRefreshMs?: number;
  readonly registryRefreshDebounceMs?: number;
  readonly registryRefreshScheduler?: LiveHaRuntimeScheduler;
  readonly retryInitialDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly retryScheduler?: LiveHaRuntimeScheduler;
  readonly clientFactory?: (
    config: AppConfig,
    options: Omit<HaWebSocketClientOptions, "token" | "url">,
  ) => HaWebSocketClient;
}

export interface LiveHaRuntime {
  readonly client: HaWebSocketClient;
  readonly historyFetcher: HaHistoryFetcher;
  readonly weatherForecastFetcher: HaWeatherForecastService;
  readonly calendarFetcher: HaCalendarService;
  readonly todoFetcher: HaTodoService;
  readonly musicAssistant: HaMusicAssistantService;
  readonly ready: Promise<void>;
  readonly stop: () => void;
}

interface BootstrapProgress {
  readonly subscribedEventTypes: Set<string>;
  registryLoaded: boolean;
}

export function startLiveHaRuntime(config: AppConfig, options: LiveHaRuntimeOptions): LiveHaRuntime | null {
  if (!config.homeAssistantToken) {
    return null;
  }
  const now = options.now ?? (() => new Date());
  let readyResolve: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  let readyResolved = false;
  let bootstrappedConnectionAt: string | null = null;
  let bootstrapConnectionAt: string | null = null;
  let bootstrapProgress: BootstrapProgress | null = null;
  let bootstrapInFlight: Promise<void> | null = null;
  let bootstrapRetryAttempt = 0;
  let cancelBootstrapRetry: (() => void) | null = null;
  let registryUpdateGeneration = 0;
  let registryRefreshRequested = false;
  let registryRefreshInFlight: Promise<void> | null = null;
  let cancelRegistryRefresh: (() => void) | null = null;
  let registryRefreshRetryAttempt = 0;
  let stopped = false;
  let voiceExposureInFlight = false;
  let cancelVoiceExposurePoll: (() => void) | null = null;
  const registryRefreshDebounceMs = normalizeDebounceMs(options.registryRefreshDebounceMs);
  const registryRefreshScheduler = options.registryRefreshScheduler ?? defaultRegistryRefreshScheduler;
  const retryInitialDelayMs = normalizeRetryDelayMs(options.retryInitialDelayMs, DEFAULT_RETRY_INITIAL_DELAY_MS);
  const retryMaxDelayMs = Math.max(
    retryInitialDelayMs,
    normalizeRetryDelayMs(options.retryMaxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS),
  );
  const retryScheduler = options.retryScheduler ?? defaultRetryScheduler;
  const voiceExposureRefreshMs = options.voiceExposureRefreshMs ?? DEFAULT_VOICE_EXPOSURE_REFRESH_MS;
  const clientFactory = options.clientFactory ?? createHomeAssistantWebSocketClient;
  const client = clientFactory(config, {
    now,
    onMessage: (message) => {
      const receivedAt = now();
      try {
        options.stateCache.handleMessage(message);
        const stateChange = passiveStateChangeObservation(message, receivedAt);
        if (stateChange) {
          options.onStateChanged?.(stateChange);
        }
        if (options.onNotificationAction) {
          const action = notificationActionFromHaMessage(message);
          if (action) {
            options.onNotificationAction(action);
          }
        }
      } catch (error) {
        options.onError?.(error instanceof Error ? error.message : String(error));
        options.stateCache.markSourceUnavailable();
        options.registry.markSourceUnavailable();
        client.reconnect("Malformed Home Assistant state event");
      }
      if (isRegistryUpdateEvent(message)) {
        registryUpdateGeneration += 1;
        options.registry.markSourceUnavailable();
        requestRegistryRefresh();
      }
    },
    onStateChange: (snapshot) => {
      if (!snapshot.connected) {
        clearBootstrapRetry();
        bootstrapConnectionAt = null;
        bootstrapProgress = null;
        bootstrapRetryAttempt = 0;
        clearRegistryRefresh();
        registryRefreshRequested = false;
        registryRefreshRetryAttempt = 0;
        options.stateCache.markSourceUnavailable();
        options.registry.markSourceUnavailable();
        return;
      }
      ensureBootstrap();
    },
  });
  const historyFetcher = new HaHistoryFetcher(client, {
    cache: new HaHistoryCache({ now }),
  });
  client.start();

  function ensureBootstrap(): void {
    const snapshot = client.snapshot();
    const connectedAt = snapshot.lastConnectedAt;
    if (!snapshot.connected || !connectedAt || connectedAt === bootstrappedConnectionAt || bootstrapInFlight || cancelBootstrapRetry) {
      return;
    }
    if (bootstrapConnectionAt !== connectedAt) {
      clearBootstrapRetry();
      bootstrapConnectionAt = connectedAt;
      bootstrapProgress = {
        subscribedEventTypes: new Set(),
        registryLoaded: false,
      };
      bootstrapRetryAttempt = 0;
    }
    const progress = bootstrapProgress;
    if (!progress) {
      return;
    }
    const connectionIsCurrent = (): boolean => {
      const latest = client.snapshot();
      return !stopped
        && latest.connected
        && latest.lastConnectedAt === connectedAt
        && bootstrapProgress === progress;
    };
    bootstrapInFlight = bootstrapConnection(
      client,
      options,
      now,
      progress,
      connectionIsCurrent,
      () => registryUpdateGeneration,
    )
      .then((committed) => {
        if (!committed || !connectionIsCurrent()) {
          return;
        }
        bootstrappedConnectionAt = connectedAt;
        bootstrapRetryAttempt = 0;
        if (!readyResolved) {
          readyResolved = true;
          readyResolve?.();
        }
        refreshVoiceExposure();
        scheduleRegistryRefresh();
      })
      .catch((error) => {
        if (!connectionIsCurrent()) {
          return;
        }
        options.onError?.(error instanceof Error ? error.message : String(error));
        options.stateCache.markSourceUnavailable();
        options.registry.markSourceUnavailable();
        // A failed bootstrap invalidates both source snapshots. Force the
        // registry stage to run again on the same connection so a later
        // successful state fetch cannot resolve readiness beside a registry
        // that is still marked unavailable.
        progress.registryLoaded = false;
        scheduleBootstrapRetry(connectedAt);
      })
      .finally(() => {
        bootstrapInFlight = null;
        const latest = client.snapshot();
        if (latest.connected && latest.lastConnectedAt !== connectedAt) {
          ensureBootstrap();
        }
      });
  }

  function scheduleBootstrapRetry(connectedAt: string): void {
    const snapshot = client.snapshot();
    if (
      stopped
      || cancelBootstrapRetry
      || !snapshot.connected
      || snapshot.lastConnectedAt !== connectedAt
      || bootstrappedConnectionAt === connectedAt
    ) {
      return;
    }
    const delayMs = retryDelayMs(bootstrapRetryAttempt, retryInitialDelayMs, retryMaxDelayMs);
    bootstrapRetryAttempt += 1;
    cancelBootstrapRetry = retryScheduler.schedule(delayMs, () => {
      cancelBootstrapRetry = null;
      ensureBootstrap();
    });
  }

  function clearBootstrapRetry(): void {
    cancelBootstrapRetry?.();
    cancelBootstrapRetry = null;
  }

  function requestRegistryRefresh(): void {
    if (stopped || !client.snapshot().connected) {
      return;
    }
    registryRefreshRequested = true;
    if (registryRefreshInFlight) {
      return;
    }
    clearRegistryRefresh();
    registryRefreshRetryAttempt = 0;
    scheduleRegistryRefresh(registryRefreshDebounceMs, registryRefreshScheduler);
  }

  function scheduleRegistryRefresh(
    delayMs = registryRefreshDebounceMs,
    scheduler = registryRefreshScheduler,
  ): void {
    const snapshot = client.snapshot();
    const connectedAt = snapshot.lastConnectedAt;
    if (
      stopped
      || !registryRefreshRequested
      || cancelRegistryRefresh
      || registryRefreshInFlight
      || !snapshot.connected
      || !connectedAt
      || bootstrappedConnectionAt !== connectedAt
    ) {
      return;
    }
    cancelRegistryRefresh = scheduler.schedule(delayMs, () => {
      cancelRegistryRefresh = null;
      void refreshRegistryForConnection(connectedAt);
    });
  }

  async function refreshRegistryForConnection(connectedAt: string): Promise<void> {
    const snapshot = client.snapshot();
    if (stopped || !snapshot.connected || snapshot.lastConnectedAt !== connectedAt) {
      registryRefreshRequested = false;
      return;
    }
    registryRefreshRequested = false;
    const refreshGeneration = registryUpdateGeneration;
    const refresh = fetchRegistry(client).then((registryData) => {
      const latest = client.snapshot();
      if (
        !stopped
        && latest.connected
        && latest.lastConnectedAt === connectedAt
        && registryUpdateGeneration === refreshGeneration
      ) {
        options.registry.replace(registryData);
        refreshVoiceExposure();
      }
    });
    registryRefreshInFlight = refresh;
    let refreshFailed = false;
    try {
      await refresh;
      registryRefreshRetryAttempt = 0;
    } catch (error) {
      const latest = client.snapshot();
      if (!stopped && latest.connected && latest.lastConnectedAt === connectedAt) {
        options.onError?.(error instanceof Error ? error.message : String(error));
        registryRefreshRequested = true;
        refreshFailed = true;
      }
    } finally {
      if (registryRefreshInFlight === refresh) {
        registryRefreshInFlight = null;
      }
      if (refreshFailed) {
        const delayMs = retryDelayMs(registryRefreshRetryAttempt, retryInitialDelayMs, retryMaxDelayMs);
        registryRefreshRetryAttempt += 1;
        scheduleRegistryRefresh(delayMs, retryScheduler);
      } else {
        scheduleRegistryRefresh();
      }
    }
  }

  function clearRegistryRefresh(): void {
    cancelRegistryRefresh?.();
    cancelRegistryRefresh = null;
  }

  // HA sends no event when an entity without a registry entry is exposed, so
  // the list is also re-read on a timer, not only after registry changes.
  function refreshVoiceExposure(): void {
    const exposure = options.voiceExposure;
    if (!exposure || stopped || voiceExposureInFlight || !client.snapshot().connected) return;
    voiceExposureInFlight = true;
    void fetchVoiceExposure(client)
      .then((input) => {
        if (!stopped) exposure.replace(input, now());
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        exposure.markFailed(message);
        options.onError?.(`voice list: ${message}`);
      })
      .finally(() => {
        voiceExposureInFlight = false;
      });
  }

  function scheduleVoiceExposurePoll(): void {
    if (!options.voiceExposure || stopped) return;
    cancelVoiceExposurePoll = retryScheduler.schedule(voiceExposureRefreshMs, () => {
      refreshVoiceExposure();
      scheduleVoiceExposurePoll();
    });
  }
  scheduleVoiceExposurePoll();

  return {
    client,
    historyFetcher,
    weatherForecastFetcher: new HaWeatherForecastService(client, options.timezone ?? HOUSE_TIME_ZONE),
    calendarFetcher: new HaCalendarService(client),
    todoFetcher: new HaTodoService(client),
    musicAssistant: new HaMusicAssistantService(client, undefined, createMusicAssistantDirectClientFromHaConfig()),
    ready,
    stop: () => {
      stopped = true;
      clearBootstrapRetry();
      registryRefreshRequested = false;
      clearRegistryRefresh();
      cancelVoiceExposurePoll?.();
      options.stateCache.markSourceUnavailable();
      client.stop();
    },
  };
}

function passiveStateChangeObservation(
  message: HaWebSocketMessage,
  receivedAt: Date,
): PassiveStateChangeObservation | null {
  if (
    message.type !== "event"
    || !message.event
    || typeof message.event !== "object"
    || Array.isArray(message.event)
  ) {
    return null;
  }
  const event = message.event as Record<string, unknown>;
  if (event.event_type !== "state_changed") {
    return null;
  }
  const data = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const entityId = typeof record.entity_id === "string"
    ? record.entity_id.trim()
    : "";
  if (!entityId) {
    return null;
  }
  const oldState = recordOrNull(record.old_state);
  const newState = recordOrNull(record.new_state);
  return {
    entityId,
    fromState: typeof oldState?.state === "string" ? oldState.state : null,
    toState: typeof newState?.state === "string" ? newState.state : null,
    attributes: newState?.attributes
      && typeof newState.attributes === "object"
      && !Array.isArray(newState.attributes)
      ? newState.attributes as Readonly<Record<string, unknown>>
      : {},
    observedAt: receivedAt.toISOString(),
  };
}

async function bootstrapConnection(
  client: HaWebSocketClient,
  options: LiveHaRuntimeOptions,
  now: () => Date,
  progress: BootstrapProgress,
  connectionIsCurrent: () => boolean,
  registryGeneration: () => number,
): Promise<boolean> {
  // Subscribe before taking the complete snapshot, then fetch states last. HA
  // websocket ordering means changes before get_states are in that snapshot and
  // later changes are delivered after it, so bootstrap cannot create a stale gap.
  const eventTypes = options.onNotificationAction
    ? [...SUBSCRIBED_EVENT_TYPES, NOTIFICATION_ACTION_EVENT_TYPE]
    : SUBSCRIBED_EVENT_TYPES;
  for (const eventType of eventTypes) {
    if (progress.subscribedEventTypes.has(eventType)) {
      continue;
    }
    await client.sendCommand({ type: "subscribe_events", event_type: eventType });
    if (!connectionIsCurrent()) {
      return false;
    }
    progress.subscribedEventTypes.add(eventType);
  }
  if (!progress.registryLoaded) {
    const fetchGeneration = registryGeneration();
    const registryData = await fetchRegistry(client);
    if (!connectionIsCurrent()) {
      return false;
    }
    if (registryGeneration() !== fetchGeneration) {
      throw new Error("Home Assistant registry changed during bootstrap");
    }
    options.registry.replace(registryData);
    progress.registryLoaded = true;
  }
  const states = await client.sendCommand({ type: "get_states" });
  if (!connectionIsCurrent()) {
    return false;
  }
  if (!Array.isArray(states)) {
    throw new Error("live Home Assistant bootstrap returned malformed state data");
  }
  // State readiness is the bootstrap commit point. Any earlier failure leaves
  // the last snapshot retained for diagnostics but unavailable for answers.
  options.stateCache.applyStateList(states);
  return true;
}

const REGISTRY_UPDATE_EVENT_TYPES = new Set([
  "entity_registry_updated",
  "device_registry_updated",
  "area_registry_updated",
]);
const SUBSCRIBED_EVENT_TYPES = [
  "state_changed",
  ...REGISTRY_UPDATE_EVENT_TYPES,
];
const NOTIFICATION_ACTION_EVENT_TYPE = "mobile_app_notification_action";
const DEFAULT_REGISTRY_REFRESH_DEBOUNCE_MS = 250;
const DEFAULT_RETRY_INITIAL_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_VOICE_EXPOSURE_REFRESH_MS = 5 * 60_000;

const defaultRegistryRefreshScheduler: LiveHaRuntimeScheduler = {
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

const defaultRetryScheduler: LiveHaRuntimeScheduler = {
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

async function fetchRegistry(client: HaWebSocketClient): Promise<HaRegistryIndexInput> {
  const [areas, devices, entities] = await Promise.all([
    client.sendCommand({ type: "config/area_registry/list" }),
    client.sendCommand({ type: "config/device_registry/list" }),
    client.sendCommand({ type: "config/entity_registry/list" }),
  ]);
  if (!Array.isArray(areas) || !Array.isArray(devices) || !Array.isArray(entities)) {
    throw new Error("live Home Assistant bootstrap returned malformed registry data");
  }
  return { areas, devices, entities };
}

function isRegistryUpdateEvent(message: HaWebSocketMessage): boolean {
  if (message.type !== "event" || !message.event || typeof message.event !== "object" || Array.isArray(message.event)) {
    return false;
  }
  const eventType = (message.event as Record<string, unknown>).event_type;
  return typeof eventType === "string" && REGISTRY_UPDATE_EVENT_TYPES.has(eventType);
}

function normalizeDebounceMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_REGISTRY_REFRESH_DEBOUNCE_MS;
  }
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_REGISTRY_REFRESH_DEBOUNCE_MS;
}

function normalizeRetryDelayMs(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value >= 0
    ? Math.floor(value)
    : fallback;
}

function retryDelayMs(attempt: number, initialDelayMs: number, maxDelayMs: number): number {
  return Math.min(initialDelayMs * 2 ** Math.min(attempt, 30), maxDelayMs);
}
