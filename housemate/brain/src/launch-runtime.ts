import type { AliasEntry } from "./alias-schema.js";
import { AliasStore } from "./alias-store.js";
import { alarmStorePath, PersistentAlarmClock } from "./alarm-clock.js";
import { createBasicBrainVoiceHandler } from "./basic-brain.js";
import type { BasicBrainRouteServices } from "./basic-brain-services.js";
import { conditionalReminderStorePath, HaPersistentNotificationSink, PersistentConditionalReminderService } from "./conditional-reminders.js";
import type { AppConfig } from "./config.js";
import { warmCodexAppServer } from "./codex-app-server.js";
import {
  configuredModelSkipReason,
  prewarmClaudeStream,
  prewarmClaudeToolStream,
  seedSelfAccount,
  setSelfAccountSource,
} from "./model-backend.js";
import type { LiveSettingsStore } from "./live-settings.js";
import { JarvisHelperControl } from "./dashboard-settings.js";
import { DashboardNames, friendlyNameAttribute } from "./dashboard-names.js";
import { eventWatcherStorePath, PersistentPassiveEventWatcherService } from "./event-watchers.js";
import { HaRegistryIndex } from "./ha-registry-index.js";
import { HaStateCache } from "./ha-state-cache.js";
import { RuntimeHouseStateProvider } from "./house-state.js";
import { NucJarvisDeviceEndpoint } from "./housemate-device-endpoint.js";
import { LocalMediaCatalogClient } from "./local-media-catalog.js";
import { startLiveHaRuntime } from "./live-ha-runtime.js";
import { VoiceExposure, withVoiceAliases } from "./voice-exposure.js";
import { HouseholdMemory } from "./household-memory.js";
import { household } from "./household.js";
import {
  discoveredHouse,
  houseOptions,
  runHouseDiscovery,
  saveHousePage,
  startHouseDiscovery,
  type HouseDiscoveryOptions,
} from "./house-discovery.js";
import { HousemateChat, PageActions } from "./chat-settings-tools.js";
import { AssistSetupReader, notifyPhones } from "./assist-setup.js";
import { memoryArchiveActive, memoryArchiveAvailable } from "./memory-archive.js";
import { startHousePatternRefresh } from "./house-pattern-refresh-job.js";
import { LOG_RETENTION_DAYS, startLogRetention } from "./log-retention.js";
import {
  ConfiguredReflectionModel,
  HaApprovalNotifier,
  lockedApprovalService,
  memoryReflectionActive,
  memoryReflectionAvailable,
  MemoryReflectionService,
} from "./memory-reflection.js";
import { HaDeviceSwitch } from "./device-control.js";
import { HaVacuumQueue } from "./vacuum-control.js";
import { InMemoryPersonalityTailStore } from "./personality-tail.js";
import { PersistentProactiveShadowService } from "./proactive-shadow.js";
import { proactivePresencePersonId } from "./proactive-summary.js";
import { ConfiguredReadAgentModelProvider } from "./read-agent-model.js";
import { BoundedReadAgent } from "./read-agent.js";
import {
  createReadAgentToolSession,
  type AgentReadServices,
} from "./read-agent-tools.js";
import type { AppRuntime } from "./server.js";
import { JarvisSelfModel, selfModelStorePath } from "./self-model.js";
import { ConfiguredSelfModelReviewer } from "./self-model-reviewer.js";
import { ConfiguredSelfGrowthModel } from "./self-growth-model.js";
import {
  readGrowthTurns,
  selfGrowthActive,
  SelfGrowthService,
  SelfGrowthStore,
  setSelfGrowthSummarySource,
} from "./self-growth.js";
import { turnLogPath } from "./turn-log.js";
import { HOUSE_TIME_ZONE } from "./house-config.js";
import { haRestAnnounce, VoiceTrainingControl } from "./voice-training.js";
import { haMediaApps, type MediaAppConnection } from "./media-apps.js";

export interface LaunchRuntimeOptions {
  readonly version: string;
  readonly startedAt: Date;
  readonly now?: () => Date;
  readonly timezone?: string;
  /** The dashboard settings store behind `config`'s live fields, and the option values it overrides. */
  readonly settings?: LiveSettingsStore;
  readonly settingsDefaults?: AppConfig;
}

export function createLaunchRuntime(config: AppConfig, options: LaunchRuntimeOptions): AppRuntime {
  const now = options.now ?? (() => new Date());
  // One household memory database. Opened first, so its one-time
  // migration backs up and imports the old stores before anything reads them.
  const householdMemory = new HouseholdMemory({
    config,
    now,
    archive: memoryArchiveAvailable(config) && { active: () => memoryArchiveActive(config) },
  });
  if (config.cognitiveSystemEnabled) householdMemory.available();
  // His self-account, read by every Claude launch while growth is on; off is SELF.md.
  const selfGrowth = new SelfGrowthStore({ filePath: selfModelStorePath(config), seed: seedSelfAccount(), now });
  setSelfAccountSource(() => (config.selfGrowthEnabled ? selfGrowth.selfText() : null));
  setSelfGrowthSummarySource(() => (config.selfGrowthEnabled ? selfGrowth.summary() : null));
  warmCodexAppServer(config);
  prewarmClaudeStream(config);
  void prewarmClaudeToolStream(config);
  // A changed chat setting changes the Claude launch shape; warm the new one before the next turn.
  options.settings?.onChange(() => {
    prewarmClaudeStream(config);
    void prewarmClaudeToolStream(config);
  });
  startLogRetention(config, {
    now,
    onResult: ({ turnLog, evalRunsRemoved }) => {
      if (turnLog.removed > 0 || evalRunsRemoved > 0) {
        console.log(`[brain] log retention removed ${turnLog.removed} turns (${turnLog.kept} kept) and ${evalRunsRemoved} eval-run files older than ${LOG_RETENTION_DAYS} days`);
      }
    },
    onError: (message) => console.warn(`[brain] ${message}`),
  });
  const backgroundWatchersEnabled = config.backgroundWatchersEnabled;
  const registry = HaRegistryIndex.from({ areas: [], devices: [], entities: [] });
  const stateCache = new HaStateCache();
  const aliasStore = new AliasStore(config.aliasFilePath);
  // `aliases.json` as loaded; a dashboard names save swaps its contents.
  const aliases: AliasEntry[] = [...aliasStore.load(now()).entries];
  // One mutable array shared by every route: `aliases.json` plus Assist's aliases.
  const routeAliases: AliasEntry[] = [];
  const syncRouteAliases = (): void => {
    routeAliases.splice(0, routeAliases.length, ...withVoiceAliases(aliases, voiceExposure.aliasEntries()));
  };
  const voiceExposure = new VoiceExposure({ onChange: syncRouteAliases });
  syncRouteAliases();
  const operatorPresencePersonId = proactivePresencePersonId(config.cognitiveOperatorActorId, aliases);
  const personalityTailStore = new InMemoryPersonalityTailStore();
  const selfReviewEnabled = backgroundWatchersEnabled
    && config.cognitiveSystemEnabled
    && configuredModelSkipReason(config) === null;
  const selfModel = new JarvisSelfModel({
    filePath: selfModelStorePath(config),
    reviewer: selfReviewEnabled ? new ConfiguredSelfModelReviewer(config, { now }) : null,
    now,
  });
  if (selfReviewEnabled) selfModel.startAutomaticReview();
  if (backgroundWatchersEnabled && config.cognitiveSystemEnabled && configuredModelSkipReason({ ...config, modelEnabled: true }) === null) {
    new SelfGrowthService({
      store: selfGrowth,
      model: new ConfiguredSelfGrowthModel(config, { now }),
      readTurns: (since, until) => readGrowthTurns({
        logPath: turnLogPath(config),
        since,
        until,
        forgottenAmong: (turnIds) => householdMemory.forgottenAmong(turnIds),
      }),
      views: () => selfModel.listConversationOpinions().slice(0, 40).map(({ subject, stance }) => ({ subject, stance })),
      active: () => selfGrowthActive(config),
      now,
      // A new account is a new launch shape; warm it before the next turn.
      onChanged: () => {
        prewarmClaudeStream(config);
        void prewarmClaudeToolStream(config);
      },
    }).start();
  }
  const memoryReflection = memoryReflectionAvailable(config) && householdMemory.available()
    ? new MemoryReflectionService({
        config,
        memory: householdMemory,
        active: () => memoryReflectionActive(config),
        model: new ConfiguredReflectionModel(config, { now }),
        selfModel,
        now,
      })
    : null;
  if (memoryReflection && config.memoryApprovalNotifyService && !lockedApprovalService(config)) {
    console.warn(`[brain] memory approval notifications disabled: ${config.memoryApprovalNotifyService} is not the allowed phone service`);
  }
  const nucEndpoint = new NucJarvisDeviceEndpoint();
  const alarmClock = new PersistentAlarmClock(alarmStorePath(config), {
    now,
    onRing: (alarm) => {
      void nucEndpoint.playAlarm({ alarm }).catch((error: unknown) => {
        console.warn(`[brain] alarm endpoint failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
  });
  const routes: BasicBrainRouteServices = {
    stateCache,
    registry,
    aliases: routeAliases,
    voiceExposure,
    mediaCatalog: new LocalMediaCatalogClient(mediaCatalogOptions(config)),
    alarmClock,
    deviceEndpoints: [nucEndpoint],
    houseState: new RuntimeHouseStateProvider({
      stateCache,
      now,
      ...(options.timezone ? { timezone: options.timezone } : {}),
    }),
    eventWatcher: new PersistentPassiveEventWatcherService(eventWatcherStorePath(config), {
      stateCache,
      now,
    }),
  };
  let liveEventWatcher = routes.eventWatcher as PersistentPassiveEventWatcherService;
  let discovery: HouseDiscoveryOptions | null = null;
  const live = startLiveHaRuntime(config, {
    stateCache,
    registry,
    voiceExposure,
    now,
    timezone: options.timezone ?? HOUSE_TIME_ZONE,
    onError: (message) => console.warn(`[brain] live HA runtime: ${message}`),
    onStateChanged: (change) => liveEventWatcher.observeStateChange(change),
    ...(memoryReflection
      ? {
          onNotificationAction: (action: string) => {
            void memoryReflection.handleNotificationAction(action).then((outcome) => {
              if (outcome.kind !== "ignored") {
                console.log(`[brain] memory approval ${outcome.kind} ${outcome.itemId}`);
              }
            }).catch((error: unknown) => {
              console.warn(`[brain] memory approval failed: ${error instanceof Error ? error.message : String(error)}`);
            });
          },
        }
      : {}),
  });
  if (memoryReflection) {
    if (live) memoryReflection.setNotifier(new HaApprovalNotifier(live.client, () => lockedApprovalService(config)));
    if (backgroundWatchersEnabled) memoryReflection.start();
  }
  if (live && backgroundWatchersEnabled) {
    startHousePatternRefresh(config, {
      now,
      log: (message) => console.log(`[brain] ${message}`),
      fetchStates: async (entityIds, start, end) => (await live.historyFetcher.fetchHistory({
        entityIds,
        window: { start: start.toISOString(), end: end.toISOString() },
        minimalResponse: true,
        noAttributes: true,
        fresh: true,
      })).states,
    });
  }
  if (live) {
    (routes as { historyFetcher: BasicBrainRouteServices["historyFetcher"] }).historyFetcher = live.historyFetcher;
    (routes as { weatherForecastFetcher: BasicBrainRouteServices["weatherForecastFetcher"] }).weatherForecastFetcher = live.weatherForecastFetcher;
    (routes as { calendarFetcher: BasicBrainRouteServices["calendarFetcher"] }).calendarFetcher = live.calendarFetcher;
    (routes as { todoFetcher: BasicBrainRouteServices["todoFetcher"] }).todoFetcher = live.todoFetcher;
    (routes as { musicAssistant: BasicBrainRouteServices["musicAssistant"] }).musicAssistant = live.musicAssistant;
    (routes as { deviceControl: BasicBrainRouteServices["deviceControl"] }).deviceControl = new HaDeviceSwitch(
      live.client,
      voiceExposure,
      () => config.deviceControlEnabled,
    );
    (routes as { vacuumQueue: BasicBrainRouteServices["vacuumQueue"] }).vacuumQueue = new HaVacuumQueue(live.client);
    // The house sets itself up from its own HA: power, people, calendars, locks, the vacuum.
    discovery = {
      client: () => live.client,
      states: () => stateCache.entries(),
      deviceOf: (entityId) => registry.entity(entityId)?.deviceId ?? null,
      people: () => household().people.map((person) => ({ id: person.id, name: person.name, haPerson: person.haPerson, owner: person.role === "owner" })),
      speakers: () => registry.allEntities()
        .filter((entity) => entity.entityId.startsWith("assist_satellite.") && entity.deviceId)
        .map((entity) => ({ device: entity.deviceId as string, name: entity.deviceName ?? entity.name ?? entity.entityId })),
      platformOf: (entityId) => registry.entity(entityId)?.platform ?? null,
      isSetting: (entityId) => {
        const entity = registry.entity(entityId);
        return Boolean(entity && (entity.entityCategory || entity.disabledBy || entity.hiddenBy));
      },
      musicPlayers: () => registry.allEntities()
        .filter((entity) => entity.platform === "music_assistant" && entity.entityId.startsWith("media_player."))
        .map((entity) => ({ entityId: entity.entityId, name: entity.deviceName ?? entity.name ?? entity.entityId })),
      now,
      log: (line) => console.log(`[brain] ${line}`),
    };
    startHouseDiscovery(live.ready, discovery);
    (routes as { houseState: BasicBrainRouteServices["houseState"] }).houseState = new RuntimeHouseStateProvider({
      stateCache,
      calendarFetcher: live.calendarFetcher,
      weatherForecastFetcher: live.weatherForecastFetcher,
      now,
      ...(options.timezone ? { timezone: options.timezone } : {}),
    });
    liveEventWatcher = new PersistentPassiveEventWatcherService(eventWatcherStorePath(config), {
      stateCache,
      calendarFetcher: live.calendarFetcher,
      now,
    });
    (routes as { eventWatcher: BasicBrainRouteServices["eventWatcher"] }).eventWatcher = liveEventWatcher;
    const conditionalReminder = new PersistentConditionalReminderService(conditionalReminderStorePath(config), {
      stateCache,
      calendarFetcher: live.calendarFetcher,
      ...(routes.eventWatcher ? { eventWatcher: routes.eventWatcher } : {}),
      notificationSink: new HaPersistentNotificationSink(live.client),
      now,
    });
    (routes as { conditionalReminder: BasicBrainRouteServices["conditionalReminder"] }).conditionalReminder = conditionalReminder;
    const proactiveShadow = new PersistentProactiveShadowService(config, {
      ...(routes.houseState ? { houseState: routes.houseState } : {}),
      stateCache,
      weatherForecastFetcher: live.weatherForecastFetcher,
      todoFetcher: live.todoFetcher,
      calendarFetcher: live.calendarFetcher,
      ...(operatorPresencePersonId
        ? { targetPresencePersonId: operatorPresencePersonId }
        : {}),
      memory: householdMemory,
      now,
      onError: (message) => console.warn(`[brain] ${message}`),
    });
    if (backgroundWatchersEnabled) {
      setInterval(() => {
        void conditionalReminder.evaluateDueReminders().catch((error: unknown) => {
          console.warn(`[brain] conditional reminder evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, 60_000);
    }
    void live.ready.then(
      () => {
        if (backgroundWatchersEnabled) {
          void routes.eventWatcher?.evaluateNow().catch((error: unknown) => {
            console.warn(`[brain] event watcher evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
          });
          void proactiveShadow.evaluateNow().catch((error: unknown) => {
            console.warn(`[brain] proactive shadow evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        console.log("[brain] live Home Assistant state and registry loaded");
      },
      () => undefined,
    );
    if (backgroundWatchersEnabled) {
      setInterval(() => {
        void routes.eventWatcher?.evaluateNow().catch((error: unknown) => {
          console.warn(`[brain] event watcher evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, 60_000);
      setInterval(() => {
        void proactiveShadow.evaluateNow().catch((error: unknown) => {
          console.warn(`[brain] proactive shadow evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, 60_000);
    }
  }
  const readAgent = live
    ? new BoundedReadAgent({
        modelProvider: new ConfiguredReadAgentModelProvider(config, { now }),
        createToolSession: (request, sessionOptions) => createReadAgentToolSession({
          services: agentReadServices(routes),
          principal: request.principal,
          ownPresenceWindow: request.ownPresenceWindow,
          ownPresencePersonEntityId: request.ownPresencePersonEntityId,
          canonicalTimeWindow: request.canonicalTimeWindow,
          signal: sessionOptions.signal,
          now,
        }),
      })
    : null;
  // The House page's settings, for the page itself and its Chat tab.
  const houseDiscovery = discovery
    ? {
      found: discoveredHouse,
      rescan: () => runHouseDiscovery(discovery as HouseDiscoveryOptions),
      options: () => houseOptions(stateCache.entries(), (discovery as HouseDiscoveryOptions).musicPlayers?.() ?? []),
      save: (raw: unknown) => saveHousePage(discovery as HouseDiscoveryOptions, raw),
    }
    : null;
  // The page's actions, for its Chat tab; the server attaches them when it starts.
  const pageActions = new PageActions();

  return {
    version: options.version,
    startedAt: options.startedAt,
    now,
    routes,
    ...(options.settings
      ? { liveSettings: { store: options.settings, defaults: options.settingsDefaults ?? config } }
      : {}),
    ...(live ? { jarvisHelpers: new JarvisHelperControl({ stateCache, client: () => live.client }) } : {}),
    ...(live && process.env.JARVIS_V5_VOICE_URL?.trim()
      ? { voiceTraining: new VoiceTrainingControl({
        stateCache, registry, client: () => live.client, voiceUrl: process.env.JARVIS_V5_VOICE_URL.trim(),
        announce: haRestAnnounce(config.haUrl, config.homeAssistantToken ?? null),
      }) }
      : {}),
    ...(houseDiscovery ? { houseDiscovery } : {}),
    pageActions,
    ...(live
      ? {
        assistSetup: () => new AssistSetupReader({ stateCache, registry, client: () => live.client }).read(),
        notifyPhones: () => notifyPhones(live.client),
      }
      : {}),
    brainAgent: () => registry.allEntities()
      .find((entity) => entity.platform === "housemate" && entity.entityId.startsWith("conversation."))?.entityId ?? null,
    haPersons: () => stateCache.entries()
      .filter((state) => state.entityId.startsWith("person."))
      .map((state) => ({ id: state.entityId, name: friendlyNameAttribute(state.attributes) })),
    dashboardNames: new DashboardNames({
      store: aliasStore,
      live: aliases,
      onSaved: syncRouteAliases,
      voice: voiceExposure,
      stateCache,
      registry,
      roster: () => config.householdRoster,
    }),
    personalityTailStore,
    selfModel,
    selfGrowth,
    ...(memoryReflection ? { memoryReflection } : {}),
    voiceBrainHandler: createBasicBrainVoiceHandler({
      config,
      routes,
      now,
      deterministicSpeechStyle: "own",
      personalityTailStore,
      selfModel,
      selfGrowth,
      householdMemory,
      ...(memoryReflection ? { memoryReflection } : {}),
      ...(readAgent ? { readAgent } : {}),
      houseSettings: new HousemateChat({ house: houseDiscovery, page: pageActions }),
    }),
  };
}

/**
 * Project the live route bag into an explicit read-only capability set at the
 * moment a fallback starts. This keeps mutable live fetcher wiring current
 * without ever handing the agent action, playback, alarm, reminder, endpoint,
 * notification, or raw websocket capabilities.
 */
function agentReadServices(routes: BasicBrainRouteServices): AgentReadServices {
  return {
    ...(routes.stateCache ? { stateCache: routes.stateCache } : {}),
    ...(routes.registry ? { registry: routes.registry } : {}),
    ...(routes.aliases ? { aliases: routes.aliases } : {}),
    ...(routes.historyFetcher ? { historyFetcher: routes.historyFetcher } : {}),
    ...(routes.calendarFetcher ? { calendarFetcher: routes.calendarFetcher } : {}),
    ...(routes.todoFetcher ? { todoFetcher: routes.todoFetcher } : {}),
    ...(routes.weatherForecastFetcher
      ? { weatherForecastFetcher: routes.weatherForecastFetcher }
      : {}),
    ...(routes.mediaCatalog ? { mediaCatalog: routes.mediaCatalog } : {}),
    ...(routes.eventWatcher ? { eventWatcher: routes.eventWatcher } : {}),
  };
}

/** Each media app from the house's own config, else from its Home Assistant integration. */
function mediaCatalogOptions(config: AppConfig) {
  const ha = haMediaApps();
  const pick = (url: string, key: string | null, found: MediaAppConnection | undefined): MediaAppConnection | null => (
    url ? { url, key } : found ?? null
  );
  const plex = pick(config.plexUrl, config.plexToken, ha.plex);
  const radarr = pick(config.radarrUrl, config.radarrApiKey, ha.radarr);
  const sonarr = pick(config.sonarrUrl, config.sonarrApiKey, ha.sonarr);
  const seerr = pick(config.seerrUrl, config.seerrApiKey, ha.seerr);
  return {
    plexUrl: plex?.url ?? "", plexToken: plex?.key ?? null,
    radarrUrl: radarr?.url ?? "", radarrApiKey: radarr?.key ?? null,
    sonarrUrl: sonarr?.url ?? "", sonarrApiKey: sonarr?.key ?? null,
    seerrUrl: seerr?.url ?? "", seerrApiKey: seerr?.key ?? null,
  };
}
