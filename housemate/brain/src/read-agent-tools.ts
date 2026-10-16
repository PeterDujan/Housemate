import type { AliasEntry } from "./alias-schema.js";
import { BasicTurnSourceView } from "./basic-turn-analysis.js";
import type {
  PassiveEventWatcherService,
  PassiveEventWatcherSnapshot,
  PassiveWatcherEvent,
} from "./event-watchers.js";
import type { HaCalendarFetcher } from "./ha-calendar.js";
import type {
  HaHistoryFetcher,
  HaHistoryResult,
  HaHistoryState,
  HaStatisticSample,
} from "./ha-history.js";
import type { HaRegistryIndex } from "./ha-registry-index.js";
import type { HaEntityState, HaStateCache } from "./ha-state-cache.js";
import type { HaTodoFetcher } from "./ha-todo.js";
import type { HaWeatherForecastFetcher } from "./ha-weather-forecast.js";
import { resolveHistoricalPersonEntityId } from "./episodic-presence-inference.js";
import {
  buildEntityLocationPrivacyContext,
  isSensitiveLocationEntity,
} from "./entity-status-privacy.js";
import type {
  LocalMediaCatalogClient,
  LocalMediaListItem,
  LocalMediaRecommendation,
} from "./local-media-catalog.js";
import type {
  ReadAgentEvidence,
  ReadAgentEvidenceFact,
  ReadAgentEvidenceStatus,
  ReadAgentPrincipal,
  ReadAgentPrivacyClass,
  ReadAgentStateFingerprint,
  ReadAgentToolCall,
  ReadAgentToolName,
} from "./read-agent-contracts.js";
import { deepFreeze } from "./ha-state-cache.js";
import { boundedInteger, recordOrNull } from "./value-guards.js";
import { HOUSE_LOCALE, HOUSE_TIME_ZONE } from "./house-config.js";

/**
 * The only capabilities exposed to the read agent. In particular, there is no
 * websocket command client, service caller, action executor, endpoint, memory
 * store, reminder service, alarm service, or playback adapter here.
 */
export interface AgentReadServices {
  readonly stateCache?: HaStateCache;
  readonly registry?: HaRegistryIndex;
  readonly aliases?: readonly AliasEntry[];
  readonly historyFetcher?: Partial<
    Pick<HaHistoryFetcher, "fetchHistory" | "fetchStatistics">
  >;
  readonly calendarFetcher?: HaCalendarFetcher;
  readonly todoFetcher?: HaTodoFetcher;
  readonly weatherForecastFetcher?: HaWeatherForecastFetcher;
  readonly mediaCatalog?: Partial<
    Pick<
      LocalMediaCatalogClient,
      "recommendForAgent" | "findForAgent" | "listForAgent"
    >
  >;
  readonly eventWatcher?: Pick<
    PassiveEventWatcherService,
    "recentEvents" | "snapshot"
  >;
}

export interface ReadAgentToolSessionOptions {
  readonly services: AgentReadServices;
  readonly principal: ReadAgentPrincipal;
  readonly ownPresenceWindow?: {
    readonly start: string;
    readonly end: string;
  } | null;
  readonly ownPresencePersonEntityId?: string | null;
  readonly canonicalTimeWindow?: {
    readonly start: string;
    readonly end: string;
    readonly timezone?: string;
  } | null;
  /** Whole-agent lifetime signal; aborting it cancels every in-flight read. */
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  /** Bounds every adapter call, including history's websocket request. */
  readonly historyTimeoutMs?: number;
}

export interface ReadAgentEvidenceRevalidation {
  readonly status: "valid" | "changed" | "unavailable";
  readonly changedEntityIds: readonly string[];
  readonly evidence: ReadAgentEvidence;
  /** Fresh replacement produced by a bounded adapter re-read, when required. */
  readonly freshEvidence?: ReadAgentEvidence;
  /** Adapter calls consumed by this revalidation. */
  readonly toolCallsUsed?: number;
}

interface CurrentSource {
  readonly view: BasicTurnSourceView;
  readonly states: ReadonlyMap<string, HaEntityState>;
  readonly registry: HaRegistryIndex | undefined;
  readonly stateRevision: number;
  readonly registryRevision: number | null;
}

interface EvidenceInput {
  readonly call: ReadAgentToolCall;
  readonly status: ReadAgentEvidenceStatus;
  readonly source: string;
  readonly privacy?: ReadAgentPrivacyClass;
  readonly entityIds?: readonly string[];
  readonly sourceLabels?: readonly string[];
  readonly cached?: boolean;
  readonly truncated?: boolean;
  readonly stateRevision?: number | null;
  readonly registryRevision?: number | null;
  readonly watcherRevision?: number | null;
  readonly fingerprints?: readonly ReadAgentStateFingerprint[];
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly errorCode?: string | null;
}

type SafePassiveWatcherEvent =
  | Extract<PassiveWatcherEvent, { readonly calendarEntityId: string }>
  | Extract<PassiveWatcherEvent, { readonly entityId: string }>;

const TOOL_CALL_KEYS = [
  "area",
  "call_id",
  "domain",
  "end",
  "entity_ids",
  "limit",
  "media_filter",
  "media_kind",
  "mode",
  "name",
  "period",
  "query",
  "start",
  "statuses",
  "types",
] as const;
const ENTITY_ID_PATTERN = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const DOMAIN_PATTERN = /^[a-z0-9_]+$/;
const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_ENTITY_IDS = 10;
const MAX_ROWS = 50;
const MAX_SEARCH_RESULTS = 10;
const MAX_SEARCH_CANDIDATE_SCAN = 512;
const MAX_MEDIA_RESULTS = 10;
const WEATHER_HOURLY_HORIZON_MS = 24 * 60 * 60 * 1_000;
const WEATHER_DAILY_HORIZON_DAYS = 7;
const DEFAULT_READ_TIMEZONE = HOUSE_TIME_ZONE;
const DYNAMIC_ADAPTER_TOOLS: ReadonlySet<ReadAgentToolName> = new Set([
  "get_history",
  "get_my_presence_history",
  "get_statistics",
  "get_calendar",
  "get_todos",
  "get_weather",
  "search_media",
]);
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1_000;
const MAX_RAW_HISTORY_ENTITIES = 1;
const MAX_RAW_HISTORY_ENTITY_DAYS = 1;
const DEFAULT_SOURCE_TIMEOUT_MS = 5_000;
const MAX_RECENT_EVENT_VIEW_AGE_MS = 2 * 60 * 1_000;
const MAX_RECENT_EVENT_AGE_MS = 24 * 60 * 60 * 1_000;
const SAFE_STATE_ATTRIBUTES = new Set([
  "battery_level",
  "brightness",
  "current_temperature",
  "device_class",
  "humidity",
  "temperature",
  "temperature_unit",
  "unit_of_measurement",
]);
const PERSONAL_DOMAINS = new Set([
  "calendar",
  "device_tracker",
  "geo_location",
  "input_text",
  "person",
  "proximity",
  "todo",
  "zone",
]);
const STATE_READ_DENIED_DOMAINS = new Set([
  // Free-form text helpers commonly hold PINs, tokens, webhook URLs, or other
  // operator secrets. Privacy labelling is not permission to export them.
  "input_text",
  "text",
]);
const CONSTRAINED_STATE_DOMAINS = new Set([
  "alarm_control_panel",
  "automation",
  "binary_sensor",
  "calendar",
  "climate",
  "cover",
  "fan",
  "humidifier",
  "input_boolean",
  "light",
  "lock",
  "media_player",
  "remote",
  "sun",
  "switch",
  "timer",
  "todo",
  "update",
  "vacuum",
  "valve",
  "water_heater",
  "weather",
]);
const NUMERIC_STATE_DOMAINS = new Set([
  "counter",
  "input_number",
  "number",
  "sensor",
]);
const SAFE_TEXT_SENSOR_DEVICE_CLASSES = new Set([
  "date",
  "timestamp",
]);
const HISTORY_DENIED_DOMAINS = new Set([
  "device_tracker",
  "geo_location",
  "person",
  "proximity",
  "zone",
]);
const VOLATILE_DOMAINS = new Set([
  "counter",
  "input_number",
  "number",
  "sensor",
]);
const VOLATILE_DEVICE_CLASSES = new Set([
  "apparent_power",
  "atmospheric_pressure",
  "battery",
  "carbon_dioxide",
  "carbon_monoxide",
  "current",
  "data_rate",
  "data_size",
  "distance",
  "duration",
  "energy",
  "energy_storage",
  "frequency",
  "gas",
  "humidity",
  "illuminance",
  "moisture",
  "monetary",
  "nitrogen_dioxide",
  "nitrogen_monoxide",
  "nitrous_oxide",
  "ozone",
  "pm1",
  "pm10",
  "pm25",
  "power",
  "power_factor",
  "precipitation",
  "precipitation_intensity",
  "pressure",
  "reactive_energy",
  "reactive_power",
  "signal_strength",
  "sound_pressure",
  "speed",
  "sulphur_dioxide",
  "temperature",
  "volatile_organic_compounds",
  "volatile_organic_compounds_parts",
  "voltage",
  "volume",
  "volume_flow_rate",
  "water",
  "weight",
  "wind_speed",
]);
const INJECTION_TEXT = [
  /(?:^|\s)(?:assistant|developer|system|tool)\s*:/i,
  /(?:^|\s)###\s*(?:assistant|developer|system|tool)\b/i,
  /<\|(?:assistant|end|im_start|im_end|system|tool)[^>]*\|>/i,
  /\b(?:ignore|disregard|override)\b.{0,60}\b(?:instruction|message|prompt|rule)s?\b/i,
  /\b(?:previous|prior|above)\b.{0,30}\b(?:instruction|message|prompt|rule)s?\b/i,
  /\byou are (?:chatgpt|an? (?:assistant|language model))\b/i,
  /\b(?:call|invoke|execute|run)\b.{0,30}\b(?:tool|command|service)\b/i,
] as const;
const SECRET_ENTITY_LABEL_TERM_PATTERN =
  /\b(?:2fa|bearer|credential|credentials|mfa|mnemonic|otp|passcode|passwd|password|pin|secret|token|totp)\b/iu;
const SECRET_ENTITY_ACCESS_CODE_CONTEXT = new Set([
  "access",
  "alarm",
  "auth",
  "authentication",
  "authorization",
  "backup",
  "door",
  "entry",
  "garage",
  "gate",
  "lock",
  "network",
  "one",
  "otp",
  "recovery",
  "safe",
  "security",
  "time",
  "unlock",
  "verification",
  "verify",
  "wifi",
  "wireless",
]);
const SECRET_ENTITY_PHRASE_CONTEXT = new Set([
  "backup",
  "mnemonic",
  "recovery",
  "seed",
]);
const SECRET_ENTITY_KEY_CONTEXT = new Set([
  "backup",
  "network",
  "private",
  "recovery",
  "ssh",
  "wifi",
  "wireless",
]);
const ADJACENT_CREDENTIAL_TOKEN_PATTERN =
  /\b(?:2fa|api[_ -]?key|bearer|credential|credentials|mfa|otp|passcode|passwd|password|pin|token|totp)\b\s+(?:(?:is|was|equals?)\s+)?([^\s,;]+)/giu;
const LINKED_SECRET_VALUE_PATTERN =
  /\bsecret\b\s+(?:(?:is|was|equals?)\s+)([^\s,;]+)/giu;
const ACCESS_CODE_VALUE_PATTERN =
  /\b(?:access|alarm|door|entry|garage|gate|lock|safe|security|unlock)(?:[\s_-]+\w+){0,2}[\s_-]+codes?\b\s+(?:(?:is|was|equals?)\s+)?([^\s,;]+)/giu;
const GENERAL_CREDENTIAL_CODE_VALUE_PATTERN =
  /\b(?:auth(?:entication|orization)?|backup|mfa|network|one[\s_-]*time|otp|recovery|totp|verification|verify|wi[\s_-]*fi|wireless)(?:[\s_-]+\w+){0,2}[\s_-]+codes?\b\s+(?:(?:is|was|equals?)\s+)?([^\s,;]+)/giu;
const CREDENTIAL_PHRASE_VALUE_PATTERN =
  /\b(?:backup|mnemonic|recovery|seed)(?:[\s_-]+\w+){0,1}[\s_-]+phrases?\b\s+(?:(?:is|was|equals?)\s+)?([^\s,;]+)/giu;
const CREDENTIAL_KEY_VALUE_PATTERN =
  /\b(?:backup|network|private|recovery|ssh(?:[\s_-]+private)?|wi[\s_-]*fi|wireless)(?:[\s_-]+\w+){0,1}[\s_-]+keys?\b\s+(?:(?:is|was|equals?)\s+)?([^\s,;]+)/giu;
const BENIGN_CREDENTIAL_FOLLOWERS = new Set([
  "change",
  "changed",
  "changes",
  "changing",
  "check",
  "checks",
  "expiry",
  "expired",
  "help",
  "issue",
  "issues",
  "limit",
  "limits",
  "manager",
  "policy",
  "policies",
  "problem",
  "problems",
  "recovery",
  "reminder",
  "reminders",
  "requirement",
  "requirements",
  "reset",
  "resets",
  "resetting",
  "rotation",
  "rule",
  "rules",
  "strength",
  "update",
  "updated",
  "updates",
  "updating",
]);

export class ReadAgentToolSession {
  readonly #services: AgentReadServices;
  readonly #principal: ReadAgentPrincipal;
  readonly #now: () => Date;
  readonly #sourceTimeoutMs: number;
  readonly #runSignal: AbortSignal | undefined;
  readonly #ownPresenceWindow: {
    readonly start: string;
    readonly end: string;
  } | null;
  readonly #ownPresencePersonEntityId: string | null;
  #canonicalTimeWindow: {
    readonly start: string;
    readonly end: string;
  } | null;
  readonly #canonicalTimezone: string | null;
  readonly #grantedEntityIds = new Set<string>();
  readonly #seenCallIds = new Set<string>();
  readonly #evidence: ReadAgentEvidence[] = [];
  readonly #originalCalls = new Map<string, ReadAgentToolCall>();
  readonly #searchSignatures = new Map<string, string>();
  #evidenceSequence = 0;

  constructor(options: ReadAgentToolSessionOptions) {
    this.#principal = validatePrincipal(options.principal);
    this.#now = options.now ?? (() => new Date());
    this.#runSignal = options.signal;
    this.#ownPresenceWindow = normalizeGrantedWindow(
      options.ownPresenceWindow ?? null,
      "owner presence window",
    );
    this.#ownPresencePersonEntityId = normalizeGrantedPersonEntityId(
      options.ownPresencePersonEntityId ?? null,
    );
    this.#canonicalTimeWindow = normalizeGrantedWindow(
      options.canonicalTimeWindow ?? null,
      "canonical time window",
    );
    this.#canonicalTimezone = normalizeTimezone(
      options.canonicalTimeWindow?.timezone ?? null,
    );
    this.#sourceTimeoutMs = boundedInteger(
      options.historyTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS,
      1,
      30_000,
      "read agent source timeout",
    );
    // Copy only the declared projection. Extra fields on a structurally typed
    // object never become reachable from a tool handler.
    this.#services = Object.freeze({
      ...(options.services.stateCache
        ? { stateCache: options.services.stateCache }
        : {}),
      ...(options.services.registry
        ? { registry: options.services.registry }
        : {}),
      ...(options.services.aliases
        ? { aliases: options.services.aliases }
        : {}),
      ...(options.services.historyFetcher
        ? { historyFetcher: options.services.historyFetcher }
        : {}),
      ...(options.services.calendarFetcher
        ? { calendarFetcher: options.services.calendarFetcher }
        : {}),
      ...(options.services.todoFetcher
        ? { todoFetcher: options.services.todoFetcher }
        : {}),
      ...(options.services.weatherForecastFetcher
        ? { weatherForecastFetcher: options.services.weatherForecastFetcher }
        : {}),
      ...(options.services.mediaCatalog
        ? { mediaCatalog: options.services.mediaCatalog }
        : {}),
      ...(options.services.eventWatcher
        ? { eventWatcher: options.services.eventWatcher }
        : {}),
    });
  }

  async execute(call: ReadAgentToolCall): Promise<ReadAgentEvidence> {
    return this.#execute(call, false);
  }

  /**
   * Replaces the granted window for later windowed reads. For callers that
   * derive each window in code, one read at a time (open chat's house tools
   * build it from bounded hour/day counts); a model never supplies it.
   */
  grantCanonicalTimeWindow(window: { readonly start: string; readonly end: string } | null): void {
    this.#canonicalTimeWindow = normalizeGrantedWindow(window, "canonical time window");
  }

  evidence(): readonly ReadAgentEvidence[] {
    return Object.freeze([...this.#evidence]);
  }

  grantedEntityIds(): readonly string[] {
    return Object.freeze([...this.#grantedEntityIds].sort());
  }

  revalidate(evidence: ReadAgentEvidence): ReadAgentEvidenceRevalidation {
    if (evidence.tool === "search_entities") {
      return this.#revalidateEntitySearch(evidence);
    }
    if (
      evidence.tool !== "get_my_presence_history"
      && evidence.registryRevision !== null
      && this.#services.registry
      && !this.#currentSourceOrNull()?.registry
    ) {
      return Object.freeze({
        status: "unavailable",
        changedEntityIds: Object.freeze([...evidence.entityIds].sort()),
        evidence,
      });
    }

    if (
      evidence.entityIds.length > 0
      && !this.#entityEvidenceRemainsSafe(evidence)
    ) {
      return Object.freeze({
        status: "unavailable",
        changedEntityIds: Object.freeze([...evidence.entityIds].sort()),
        evidence,
      });
    }

    if (evidence.watcherRevision !== null) {
      const source = this.#currentSourceOrNull();
      const watcher = this.#services.eventWatcher;
      if (!source || !watcher) {
        return Object.freeze({
          status: "unavailable",
          changedEntityIds: Object.freeze([]),
          evidence,
        });
      }
      const snapshot = watcher.snapshot();
      if (!recentEventViewIsCurrent(snapshot, this.#now())) {
        return Object.freeze({
          status: "unavailable",
          changedEntityIds: Object.freeze([]),
          evidence,
        });
      }
      return Object.freeze({
        status: snapshot.revision === evidence.watcherRevision
          ? "valid"
          : "changed",
        changedEntityIds: Object.freeze([]),
        evidence,
      });
    }

    const fingerprints = evidence.stateFingerprints;
    const registryChanged = evidence.registryRevision !== null
      && this.#services.registry?.revision() !== evidence.registryRevision;
    if (fingerprints.length === 0) {
      if (evidence.stateRevision !== null || evidence.registryRevision !== null) {
        const source = this.#currentSourceOrNull();
        if (!source) {
          return Object.freeze({
            status: "unavailable",
            changedEntityIds: Object.freeze([]),
            evidence,
          });
        }
        const stateChanged = evidence.stateRevision !== null
          && source.stateRevision !== evidence.stateRevision;
        return Object.freeze({
          status: stateChanged || registryChanged ? "changed" : "valid",
          changedEntityIds: Object.freeze([]),
          evidence,
        });
      }
      return Object.freeze({
        status: registryChanged ? "changed" : "valid",
        changedEntityIds: Object.freeze([]),
        evidence,
      });
    }

    const source = this.#currentSourceOrNull();
    if (!source) {
      return Object.freeze({
        status: "unavailable",
        changedEntityIds: Object.freeze(fingerprints.map((item) => item.entityId)),
        evidence,
      });
    }

    const changedEntityIds = fingerprints
      .filter((fingerprint) => {
        const current = source.states.get(fingerprint.entityId);
        return !current
          || current.state !== fingerprint.state
          || current.lastUpdated !== fingerprint.lastUpdated;
      })
      .map((fingerprint) => fingerprint.entityId);
    if (registryChanged && changedEntityIds.length === 0) {
      changedEntityIds.push(...fingerprints.map((item) => item.entityId));
    }
    return Object.freeze({
      status: changedEntityIds.length > 0 ? "changed" : "valid",
      changedEntityIds: Object.freeze([...new Set(changedEntityIds)].sort()),
      evidence,
    });
  }

  revalidationCost(evidence: ReadAgentEvidence): number {
    return DYNAMIC_ADAPTER_TOOLS.has(evidence.tool)
      && this.#originalCalls.has(evidence.evidenceId)
      ? 1
      : 0;
  }

  async revalidateFresh(
    evidence: ReadAgentEvidence,
  ): Promise<ReadAgentEvidenceRevalidation> {
    const liveCheck = this.revalidate(evidence);
    if (
      liveCheck.status === "unavailable"
      || !DYNAMIC_ADAPTER_TOOLS.has(evidence.tool)
    ) {
      return Object.freeze({
        ...liveCheck,
        toolCallsUsed: 0,
      });
    }
    if (!this.#originalCalls.has(evidence.evidenceId)) {
      return Object.freeze({
        status: "unavailable",
        changedEntityIds: Object.freeze([...evidence.entityIds].sort()),
        evidence,
        toolCallsUsed: 0,
      });
    }

    const freshEvidence = await this.refresh(evidence);
    if (
      freshEvidence.status !== "ok"
      && freshEvidence.status !== "empty"
    ) {
      return Object.freeze({
        status: "unavailable",
        changedEntityIds: Object.freeze([...evidence.entityIds].sort()),
        evidence,
        freshEvidence,
        toolCallsUsed: 1,
      });
    }
    return Object.freeze({
      status: semanticEvidenceSignature(freshEvidence)
        === semanticEvidenceSignature(evidence)
        ? "valid"
        : "changed",
      changedEntityIds: Object.freeze([...evidence.entityIds].sort()),
      evidence,
      freshEvidence,
      toolCallsUsed: 1,
    });
  }

  async refresh(evidence: ReadAgentEvidence): Promise<ReadAgentEvidence> {
    const call = this.#originalCalls.get(evidence.evidenceId);
    if (!call) {
      return this.#recordEvidence({
        call: callFromEvidence(evidence),
        status: "error",
        source: evidence.source,
        privacy: evidence.privacy,
        entityIds: evidence.entityIds,
        sourceLabels: evidence.sourceLabels,
        payload: { reason: "Evidence did not originate in this session." },
        errorCode: "foreign_evidence",
      });
    }
    return this.#execute(call, true);
  }

  async #execute(
    call: ReadAgentToolCall,
    refresh: boolean,
  ): Promise<ReadAgentEvidence> {
    this.#throwIfRunAborted();
    const tool = toolName(call);
    if (!refresh && this.#seenCallIds.has(call.call_id)) {
      return this.#recordEvidence({
        call,
        status: "error",
        source: sourceFor(tool),
        payload: { reason: "The call_id was already used in this session." },
        errorCode: "duplicate_call_id",
      });
    }
    if (!refresh) {
      this.#seenCallIds.add(call.call_id);
    }

    try {
      validateCall(call);
      const evidence = await this.#dispatch(call);
      this.#originalCalls.set(evidence.evidenceId, cloneCall(call));
      return evidence;
    } catch (error) {
      this.#throwIfRunAborted();
      const policy = error instanceof ToolPolicyError ? error : null;
      const status: ReadAgentEvidenceStatus =
        policy?.code === "source_unavailable"
        || policy?.code === "source_timeout"
        || policy?.code === "stale_source"
          ? "unavailable"
          : "error";
      const evidence = this.#recordEvidence({
        call,
        status,
        source: sourceFor(tool),
        payload: {
          reason: policy?.publicMessage
            ?? "The read source failed without returning usable evidence.",
        },
        errorCode: policy?.code ?? "source_error",
      });
      this.#originalCalls.set(evidence.evidenceId, cloneCall(call));
      return evidence;
    }
  }

  async #dispatch(call: ReadAgentToolCall): Promise<ReadAgentEvidence> {
    switch (call.name) {
      case "search_entities":
        return this.#searchEntities(call);
      case "get_states":
        return this.#getStates(call);
      case "get_history":
        return this.#getHistory(call);
      case "get_my_presence_history":
        return this.#getMyPresenceHistory(call);
      case "get_statistics":
        return this.#getStatistics(call);
      case "get_calendar":
        return this.#getCalendar(call);
      case "get_todos":
        return this.#getTodos(call);
      case "get_weather":
        return this.#getWeather(call);
      case "search_media":
        return this.#searchMedia(call);
      case "get_recent_events":
        return this.#getRecentEvents(call);
    }
  }

  #searchEntities(call: ReadAgentToolCall): ReadAgentEvidence {
    const source = this.#currentSource();
    if (this.#services.registry && !source.registry) {
      throw new ToolPolicyError(
        "source_unavailable",
        "Live Home Assistant entity registry data is unavailable.",
      );
    }
    const { result, visibleMatches, signature } =
      this.#entitySearchSnapshot(call, source);
    const matches = visibleMatches.slice(0, call.limit);
    const rows = matches.map(({ match, state, readable, metadataOnly }) => {
      const label = metadataOnly
        ? personMetadataLabel(match.entityId, source.registry)
        : entityLabel(match.entityId, state, source.registry);
      if (metadataOnly) {
        return {
          entity_id: match.entityId,
          label,
          domain: match.domain,
          metadata_only: true,
          readable: false,
          reasons: [],
        };
      }
      return {
        entity_id: match.entityId,
        label,
        domain: match.domain,
        area: safeOptionalText(match.areaName, 120),
        available: match.available,
        metadata_only: false,
        readable,
        reasons: match.reasons.slice(0, 8).map((reason) => sanitizeSourceText(reason, 160)),
      };
    });
    for (const { match, readable } of matches) {
      if (readable) {
        this.#grantedEntityIds.add(match.entityId);
      }
    }
    const states = matches
      .map((item) => item.state)
      .filter((state): state is HaEntityState => state !== null);
    const readableMatches = matches.filter((item) => item.readable);
    const evidence = this.#recordEvidence({
      call,
      status: rows.length > 0 ? "ok" : "empty",
      source: sourceFor(call.name),
      privacy: privacyForEntities(
        states,
        source.registry,
        this.#services.aliases ?? [],
      ),
      entityIds: readableMatches.map((item) => item.match.entityId),
      sourceLabels: readableMatches.map((item) =>
        entityLabel(item.match.entityId, item.state, source.registry)),
      truncated: visibleMatches.length > matches.length,
      // Search freshness is its privacy-filtered visible-match signature,
      // never a global HA revision that churns on unrelated sensors.
      stateRevision: null,
      registryRevision: null,
      fingerprints: [],
      payload: {
        confidence: result.confidence,
        entities: rows,
        rejected_count: result.rejectedCount
          + (result.matches.length - visibleMatches.length),
      },
    });
    this.#searchSignatures.set(evidence.evidenceId, signature);
    return evidence;
  }

  #entitySearchSnapshot(call: ReadAgentToolCall, source: CurrentSource) {
    const resolver = source.view.targets();
    if (!resolver) {
      throw new ToolPolicyError(
        "source_unavailable",
        "Live Home Assistant entity discovery is unavailable.",
      );
    }
    const result = resolver.resolve({
      text: call.query as string,
      ...(call.domain ? { domain: call.domain } : {}),
      ...(call.area ? { area: call.area } : {}),
      includeUnavailable: true,
    });
    const knownPersonLabels = privacyPersonLabels(
      source.registry,
      this.#services.aliases ?? [],
      this.#principal,
      source.states.values(),
    );
    const visibleMatches: Array<{
      readonly match: (typeof result.matches)[number];
      readonly state: HaEntityState | null;
      readonly readable: boolean;
      readonly metadataOnly: boolean;
    }> = [];
    let scannedMatches = 0;
    for (const match of result.matches) {
      if (scannedMatches >= MAX_SEARCH_CANDIDATE_SCAN) {
        break;
      }
      scannedMatches += 1;
      const state = source.states.get(match.entityId) ?? null;
      const secretLabel = state !== null && isSensitiveSecretEntity(
        state,
        source.registry,
        this.#services.aliases ?? [],
      );
      const readable = state !== null && isStateSafeForReadAgent(
        state,
        this.#principal,
        source.registry,
        this.#services.aliases ?? [],
        knownPersonLabels,
      );
      const classified = {
        match,
        state,
        readable,
        metadataOnly: !readable
          && !secretLabel
          && call.domain === "person"
          && match.domain === "person"
          && state !== null,
      };
      if (classified.readable || classified.metadataOnly) {
        visibleMatches.push(classified);
        if (visibleMatches.length >= call.limit + 1) {
          break;
        }
      }
    }
    const fullyClassified = scannedMatches >= result.matches.length;
    if (
      !fullyClassified
      && visibleMatches.length < call.limit + 1
    ) {
      throw new ToolPolicyError(
        "source_unavailable",
        "Home Assistant entity discovery was too broad to privacy-check safely.",
      );
    }
    if (
      result.matches.length > 0
      && visibleMatches.length === 0
      && fullyClassified
    ) {
      throw new ToolPolicyError(
        "privacy_denied",
        "Matching Home Assistant entities exist, but none are safe for external read-agent processing.",
      );
    }
    const signature = JSON.stringify({
      confidence: result.confidence,
      truncated: visibleMatches.length > call.limit,
      visible: visibleMatches.map((item) => ({
        entity_id: item.match.entityId,
        domain: item.match.domain,
        readable: item.readable,
        metadata_only: item.metadataOnly,
        label: item.metadataOnly
          ? personMetadataLabel(item.match.entityId, source.registry)
          : entityLabel(item.match.entityId, item.state, source.registry),
        area: safeOptionalText(item.match.areaName, 120),
        available: item.match.available,
        reasons: item.metadataOnly
          ? []
          : item.match.reasons
            .slice(0, 8)
            .map((reason) => sanitizeSourceText(reason, 160)),
      })),
    });
    return { result, visibleMatches, signature };
  }

  #revalidateEntitySearch(
    evidence: ReadAgentEvidence,
  ): ReadAgentEvidenceRevalidation {
    const source = this.#currentSourceOrNull();
    const call = this.#originalCalls.get(evidence.evidenceId);
    const expectedSignature = this.#searchSignatures.get(evidence.evidenceId);
    if (
      !source
      || !call
      || expectedSignature === undefined
      || (this.#services.registry && !source.registry)
    ) {
      return Object.freeze({
        status: "unavailable",
        changedEntityIds: Object.freeze([...evidence.entityIds].sort()),
        evidence,
      });
    }
    try {
      const current = this.#entitySearchSnapshot(call, source);
      return Object.freeze({
        status: current.signature === expectedSignature
          ? "valid"
          : "changed",
        changedEntityIds: Object.freeze([...evidence.entityIds].sort()),
        evidence,
      });
    } catch {
      return Object.freeze({
        status: "unavailable",
        changedEntityIds: Object.freeze([...evidence.entityIds].sort()),
        evidence,
      });
    }
  }

  #getStates(call: ReadAgentToolCall): ReadAgentEvidence {
    const source = this.#entities(call.entity_ids);
    const states = call.entity_ids.map((entityId) => requiredState(source, entityId));
    assertStatesSafeForReadAgent(
      states,
      this.#principal,
      source.registry,
      this.#services.aliases ?? [],
      source.states.values(),
    );
    const rows = states.map((state) => ({
      entity_id: state.entityId,
      label: entityLabel(state.entityId, state, source.registry),
      state: sanitizeSourceText(state.state, 160),
      attributes: safeStateAttributes(state.attributes),
      last_changed: safeTimestamp(state.lastChanged),
      last_updated: safeTimestamp(state.lastUpdated),
    }));
    return this.#recordEvidence({
      call,
      status: "ok",
      source: sourceFor(call.name),
      privacy: privacyForEntities(
        states,
        source.registry,
        this.#services.aliases ?? [],
      ),
      entityIds: call.entity_ids,
      sourceLabels: rows.map((row) => row.label),
      stateRevision: source.stateRevision,
      registryRevision: source.registryRevision,
      fingerprints: states.map(stateFingerprint),
      payload: { states: rows },
    });
  }

  async #getHistory(call: ReadAgentToolCall): Promise<ReadAgentEvidence> {
    const source = this.#entities(call.entity_ids);
    const states = call.entity_ids.map((entityId) => requiredState(source, entityId));
    assertStatesSafeForReadAgent(
      states,
      this.#principal,
      source.registry,
      this.#services.aliases ?? [],
      source.states.values(),
    );
    assertHistoryAllowed(
      states,
      source.registry,
      this.#services.aliases ?? [],
      this.#principal,
      source.states.values(),
    );
    assertRawHistoryStateTypes(states);
    const fetch = this.#services.historyFetcher?.fetchHistory;
    if (!fetch) {
      throw new ToolPolicyError(
        "source_unavailable",
        "Home Assistant history is unavailable.",
      );
    }
    const window = historyWindow(call, this.#now());
    assertCanonicalWindow(window, this.#canonicalTimeWindow);
    assertRawHistoryCost(call.entity_ids, window);
    const result = await this.#sourceCall((signal) =>
      fetch.call(this.#services.historyFetcher, {
        entityIds: call.entity_ids,
        window,
        significantChangesOnly: true,
        minimalResponse: true,
        includeStartTimeState: true,
        noAttributes: true,
        fresh: true,
        signal,
      }));
    assertFresh(result);
    const verifiedSource = this.#entities(call.entity_ids);
    const verifiedStates = call.entity_ids.map((entityId) =>
      requiredState(verifiedSource, entityId));
    assertStatesSafeForReadAgent(
      verifiedStates,
      this.#principal,
      verifiedSource.registry,
      this.#services.aliases ?? [],
      verifiedSource.states.values(),
    );
    assertHistoryAllowed(
      verifiedStates,
      verifiedSource.registry,
      this.#services.aliases ?? [],
      this.#principal,
      verifiedSource.states.values(),
    );
    assertRawHistoryStateTypes(verifiedStates);
    assertHistoryRowsSafe(result.states, verifiedStates);
    const allowed = new Set(call.entity_ids);
    const allRows = scopedHistoryRows(result.states, allowed, window);
    const rows = allRows.slice(0, MAX_ROWS);
    return this.#recordEvidence({
      call,
      status: rows.length > 0 ? "ok" : "empty",
      source: sourceFor(call.name),
      privacy: privacyForEntities(
        verifiedStates,
        verifiedSource.registry,
        this.#services.aliases ?? [],
      ),
      entityIds: call.entity_ids,
      sourceLabels: verifiedStates.map((state) =>
        entityLabel(state.entityId, state, verifiedSource.registry)),
      cached: false,
      truncated: allRows.length > rows.length,
      stateRevision: null,
      registryRevision: verifiedSource.registryRevision,
      payload: {
        window,
        states: rows,
        units: Object.fromEntries(verifiedStates.map((state) => [
          state.entityId,
          safeUnit(state),
        ])),
      },
    });
  }

  async #getMyPresenceHistory(call: ReadAgentToolCall): Promise<ReadAgentEvidence> {
    const grantedWindow = this.#ownPresenceWindow;
    const grantedPersonEntityId = this.#ownPresencePersonEntityId;
    if (!grantedWindow || !grantedPersonEntityId) {
      throw new ToolPolicyError(
        "privacy_denied",
        "Owner presence history and its deterministic person binding were not both granted.",
      );
    }
    const window = historyWindow(call, this.#now());
    assertExactWindow(window, grantedWindow, "owner presence");
    const source = this.#currentSource();
    if (
      entityDomain(grantedPersonEntityId) !== "person"
      || resolvePersonBindingFromSource(
        this.#principal.actorId,
        source,
        this.#services.aliases ?? [],
      ) !== grantedPersonEntityId
    ) {
      throw new ToolPolicyError(
        "privacy_denied",
        "The granted person entity no longer matches the trusted principal.",
      );
    }
    requiredState(source, grantedPersonEntityId);
    const fetch = this.#services.historyFetcher?.fetchHistory;
    if (!fetch) {
      throw new ToolPolicyError(
        "source_unavailable",
        "Home Assistant presence history is unavailable.",
      );
    }
    const result = await this.#sourceCall((signal) =>
      fetch.call(this.#services.historyFetcher, {
        entityIds: [grantedPersonEntityId],
        window,
        significantChangesOnly: true,
        minimalResponse: true,
        includeStartTimeState: true,
        noAttributes: true,
        fresh: true,
        signal,
      }));
    assertFresh(result);
    const verifiedSource = this.#currentSource();
    if (
      resolvePersonBindingFromSource(
        this.#principal.actorId,
        verifiedSource,
        this.#services.aliases ?? [],
      ) !== grantedPersonEntityId
    ) {
      throw new ToolPolicyError(
        "privacy_denied",
        "The trusted principal's person binding changed during the history read.",
      );
    }
    assertHistoryRowsSafe(result.states, [
      requiredState(verifiedSource, grantedPersonEntityId),
    ], true);
    const allRows = scopedHistoryRows(
      result.states,
      new Set([grantedPersonEntityId]),
      window,
    );
    const rows = allRows.slice(0, MAX_ROWS);
    return this.#recordEvidence({
      call,
      status: rows.length > 0 ? "ok" : "empty",
      source: sourceFor(call.name),
      privacy: "personal",
      entityIds: [grantedPersonEntityId],
      sourceLabels: [this.#principal.label],
      cached: false,
      truncated: allRows.length > rows.length,
      stateRevision: null,
      registryRevision: null,
      payload: {
        window,
        states: rows,
      },
    });
  }

  async #getStatistics(call: ReadAgentToolCall): Promise<ReadAgentEvidence> {
    const source = this.#entities(call.entity_ids);
    const states = call.entity_ids.map((entityId) => requiredState(source, entityId));
    assertStatesSafeForReadAgent(
      states,
      this.#principal,
      source.registry,
      this.#services.aliases ?? [],
      source.states.values(),
    );
    assertHistoryAllowed(
      states,
      source.registry,
      this.#services.aliases ?? [],
      this.#principal,
      source.states.values(),
    );
    const fetch = this.#services.historyFetcher?.fetchStatistics;
    if (!fetch) {
      throw new ToolPolicyError(
        "source_unavailable",
        "Home Assistant statistics are unavailable.",
      );
    }
    const window = historyWindow(call, this.#now());
    assertCanonicalWindow(window, this.#canonicalTimeWindow);
    const result = await this.#sourceCall((signal) =>
      fetch.call(this.#services.historyFetcher, {
        statisticIds: call.entity_ids,
        window,
        period: call.period as Exclude<ReadAgentToolCall["period"], "none">,
        types: call.types,
        fresh: true,
        signal,
      }));
    assertFresh(result);
    const verifiedSource = this.#entities(call.entity_ids);
    const verifiedStates = call.entity_ids.map((entityId) =>
      requiredState(verifiedSource, entityId));
    assertStatesSafeForReadAgent(
      verifiedStates,
      this.#principal,
      verifiedSource.registry,
      this.#services.aliases ?? [],
      verifiedSource.states.values(),
    );
    assertHistoryAllowed(
      verifiedStates,
      verifiedSource.registry,
      this.#services.aliases ?? [],
      this.#principal,
      verifiedSource.states.values(),
    );
    const allowed = new Set(call.entity_ids);
    const allRows = result.samples
      .filter((sample) =>
        allowed.has(sample.statisticId)
        && statisticSampleInWindow(sample, window))
      .map(statisticsRow);
    const rows = allRows.slice(0, MAX_ROWS);
    return this.#recordEvidence({
      call,
      status: rows.length > 0 ? "ok" : "empty",
      source: sourceFor(call.name),
      privacy: privacyForEntities(
        verifiedStates,
        verifiedSource.registry,
        this.#services.aliases ?? [],
      ),
      entityIds: call.entity_ids,
      sourceLabels: verifiedStates.map((state) =>
        entityLabel(state.entityId, state, verifiedSource.registry)),
      cached: false,
      truncated: allRows.length > rows.length,
      stateRevision: null,
      registryRevision: verifiedSource.registryRevision,
      payload: {
        window,
        period: call.period,
        types: call.types,
        samples: rows,
        units: Object.fromEntries(verifiedStates.map((state) => [
          state.entityId,
          safeUnit(state),
        ])),
      },
    });
  }

  async #getCalendar(call: ReadAgentToolCall): Promise<ReadAgentEvidence> {
    const source = this.#entities(call.entity_ids, "calendar");
    const fetcher = this.#services.calendarFetcher;
    if (!fetcher) {
      throw new ToolPolicyError(
        "source_unavailable",
        "Home Assistant calendar data is unavailable.",
      );
    }
    const window = boundedWindow(call, false, this.#now());
    assertCanonicalWindow(window, this.#canonicalTimeWindow);
    const labels = Object.fromEntries(call.entity_ids.map((entityId) => {
      const state = requiredState(source, entityId);
      return [entityId, entityLabel(entityId, state, source.registry)];
    }));
    const events = await this.#sourceCall((signal) => fetcher.fetchEvents({
      entityIds: call.entity_ids,
      start: window.start,
      end: window.end,
      calendarNames: labels,
      signal,
    }));
    const allowed = new Set(call.entity_ids);
    const allRows = events.map((event) => {
      if (!allowed.has(event.entityId)) {
        throw new ToolPolicyError(
          "source_invalid",
          "The calendar source returned an unrequested entity.",
        );
      }
      if (!event.summary.trim()) {
        throw new ToolPolicyError(
          "source_invalid",
          "The calendar source returned an event without a summary.",
        );
      }
      const startMs = sourceTimestampMs(
        event.start,
        call.start as string,
        "calendar event start",
        this.#canonicalTimezone,
      );
      const endMs = sourceTimestampMs(
        event.end,
        call.start as string,
        "calendar event end",
        this.#canonicalTimezone,
      );
      const startIsDate = isDateOnly(event.start);
      const endIsDate = isDateOnly(event.end);
      if (startIsDate !== endIsDate) {
        throw new ToolPolicyError(
          "source_invalid",
          "The calendar source mixed all-day and timed event boundaries.",
        );
      }
      if (
        endMs <= startMs
        || startMs >= Date.parse(window.end)
        || endMs <= Date.parse(window.start)
      ) {
        throw new ToolPolicyError(
          "source_invalid",
          "The calendar source returned an event outside the requested window.",
        );
      }
      return {
        entity_id: event.entityId,
        calendar_name: safeOptionalText(event.calendarName, 120),
        summary: sanitizeSourceText(event.summary, 200),
        start: startIsDate ? event.start : new Date(startMs).toISOString(),
        end: endIsDate ? event.end : new Date(endMs).toISOString(),
        all_day: startIsDate && endIsDate,
        location: safeOptionalText(event.location, 160),
      };
    });
    const rows = allRows.slice(0, MAX_ROWS);
    return this.#recordEvidence({
      call,
      status: rows.length > 0 ? "ok" : "empty",
      source: sourceFor(call.name),
      privacy: "personal",
      entityIds: call.entity_ids,
      sourceLabels: Object.values(labels),
      truncated: allRows.length > rows.length,
      stateRevision: source.stateRevision,
      registryRevision: source.registryRevision,
      fingerprints: call.entity_ids.map((entityId) =>
        stateFingerprint(requiredState(source, entityId))),
      payload: { window, events: rows },
    });
  }

  async #getTodos(call: ReadAgentToolCall): Promise<ReadAgentEvidence> {
    const source = this.#entities(call.entity_ids, "todo");
    const fetcher = this.#services.todoFetcher;
    if (!fetcher) {
      throw new ToolPolicyError(
        "source_unavailable",
        "Home Assistant todo data is unavailable.",
      );
    }
    const labels = Object.fromEntries(call.entity_ids.map((entityId) => {
      const state = requiredState(source, entityId);
      return [entityId, entityLabel(entityId, state, source.registry)];
    }));
    const items = await this.#sourceCall((signal) => fetcher.fetchItems({
      entityIds: call.entity_ids,
      ...(call.statuses.length > 0 ? { statuses: call.statuses } : {}),
      listNames: labels,
      signal,
    }));
    const allowed = new Set(call.entity_ids);
    const requestedStatuses = new Set(
      call.statuses.map(normalizeTodoStatus),
    );
    const allRows = items.flatMap((item) => {
      if (!allowed.has(item.entityId)) {
        throw new ToolPolicyError(
          "source_invalid",
          "The to-do source returned an unrequested entity.",
        );
      }
      if (!item.summary.trim()) {
        throw new ToolPolicyError(
          "source_invalid",
          "The to-do source returned an item without a summary.",
        );
      }
      const status = item.status === null
        ? null
        : normalizeTodoStatus(item.status);
      if (requestedStatuses.size > 0) {
        if (!status) {
          throw new ToolPolicyError(
            "source_invalid",
            "The to-do source returned an item without a filterable status.",
          );
        }
        if (!requestedStatuses.has(status)) {
          return [];
        }
      }
      return [{
        entity_id: item.entityId,
        list_name: safeOptionalText(item.listName, 120),
        summary: sanitizeSourceText(item.summary, 200),
        status: safeOptionalText(status, 40),
        due: safeOptionalTimestamp(item.due),
      }];
    });
    const rows = allRows.slice(0, MAX_ROWS);
    return this.#recordEvidence({
      call,
      status: rows.length > 0 ? "ok" : "empty",
      source: sourceFor(call.name),
      privacy: "personal",
      entityIds: call.entity_ids,
      sourceLabels: Object.values(labels),
      truncated: allRows.length > rows.length,
      stateRevision: source.stateRevision,
      registryRevision: source.registryRevision,
      fingerprints: call.entity_ids.map((entityId) =>
        stateFingerprint(requiredState(source, entityId))),
      payload: { items: rows },
    });
  }

  async #getWeather(call: ReadAgentToolCall): Promise<ReadAgentEvidence> {
    const source = this.#entities(call.entity_ids, "weather");
    const fetcher = this.#services.weatherForecastFetcher;
    if (!fetcher) {
      throw new ToolPolicyError(
        "source_unavailable",
        "Home Assistant weather forecasts are unavailable.",
      );
    }
    const entityId = call.entity_ids[0] as string;
    const points = call.mode === "hourly"
      ? await this.#sourceCall((signal) =>
          fetcher.fetchHourly(entityId, { signal }))
      : await this.#sourceCall((signal) =>
          fetcher.fetchDaily(entityId, { signal }));
    const timezone = this.#canonicalTimezone ?? DEFAULT_READ_TIMEZONE;
    const datedPoints = points.map((point) => {
      const datetime = (point as { readonly datetime?: unknown }).datetime;
      if (
        typeof datetime !== "string"
        || !datetime.trim()
      ) {
        throw new ToolPolicyError(
          "source_invalid",
          "The weather source returned a forecast with an invalid datetime.",
        );
      }
      return {
        point,
        timestampMs: sourceTimestampMs(
          datetime,
          this.#canonicalTimeWindow?.start ?? this.#now().toISOString(),
          "weather forecast datetime",
          timezone,
        ),
      };
    }).sort((left, right) => left.timestampMs - right.timestampMs);
    const coverage = weatherCoverage(
      call.mode,
      this.#canonicalTimeWindow,
      this.#now(),
      timezone,
    );
    const coverageStartMs = Date.parse(coverage.start);
    const coverageEndMs = Date.parse(coverage.end);
    const selectedPoints = datedPoints.filter((item) =>
      item.timestampMs >= coverageStartMs
      && item.timestampMs < coverageEndMs);
    const allRows = selectedPoints.map((item) => forecastRow(item.point));
    const rows = allRows.slice(0, MAX_ROWS);
    const state = requiredState(source, entityId);
    return this.#recordEvidence({
      call,
      status: rows.length > 0 ? "ok" : "empty",
      source: sourceFor(call.name),
      entityIds: [entityId],
      sourceLabels: [entityLabel(entityId, state, source.registry)],
      truncated: allRows.length > rows.length,
      stateRevision: source.stateRevision,
      registryRevision: source.registryRevision,
      fingerprints: [stateFingerprint(state)],
      payload: {
        entity_id: entityId,
        mode: call.mode,
        coverage,
        temperature_unit: safeOptionalText(
          state.attributes.temperature_unit
            ?? state.attributes.unit_of_measurement,
          20,
        ),
        precipitation_unit: safeOptionalText(
          state.attributes.precipitation_unit,
          20,
        ),
        wind_speed_unit: safeOptionalText(
          state.attributes.wind_speed_unit,
          20,
        ),
        forecasts: rows,
      },
    });
  }

  async #searchMedia(call: ReadAgentToolCall): Promise<ReadAgentEvidence> {
    const catalog = this.#services.mediaCatalog;
    if (!catalog) {
      throw new ToolPolicyError(
        "source_unavailable",
        "The local media catalogue is unavailable.",
      );
    }
    let candidates: readonly (LocalMediaRecommendation | LocalMediaListItem)[];
    let complete = false;
    let sourceStatuses: readonly Readonly<Record<string, unknown>>[] = [];
    if (call.mode === "find") {
      const find = catalog.findForAgent;
      if (!find) {
        throw new ToolPolicyError("source_unavailable", "Media search is unavailable.");
      }
      const outcome = await this.#sourceCall((signal) => find.call(
        catalog,
        call.query as string,
        call.media_kind === "any" ? null : call.media_kind,
        { signal },
      ));
      complete = outcome.complete;
      sourceStatuses = mediaSourceStatuses(outcome.sources);
      candidates = outcome.result ? [outcome.result] : [];
    } else if (call.mode === "recommend") {
      const recommend = catalog.recommendForAgent;
      if (!recommend) {
        throw new ToolPolicyError(
          "source_unavailable",
          "Media recommendations are unavailable.",
        );
      }
      const outcome = await this.#sourceCall((signal) => recommend.call(
        catalog,
        call.media_kind as "movie" | "show",
        call.query,
        { signal },
      ));
      complete = outcome.complete;
      sourceStatuses = mediaSourceStatuses(outcome.sources);
      candidates = outcome.result ? [outcome.result] : [];
    } else {
      const list = catalog.listForAgent;
      if (!list) {
        throw new ToolPolicyError(
          "source_unavailable",
          "Media catalogue lists are unavailable.",
        );
      }
      const outcome = await this.#sourceCall((signal) => list.call(
        catalog,
        call.media_kind as "movie" | "show",
        call.media_filter as "recent" | "unwatched",
        call.limit,
        { signal },
      ));
      complete = outcome.complete;
      sourceStatuses = mediaSourceStatuses(outcome.sources);
      candidates = outcome.result;
    }
    const allRows = candidates.map(mediaRow);
    const rows = allRows.slice(0, Math.min(call.limit, MAX_MEDIA_RESULTS));
    if (rows.length === 0 && !complete) {
      return this.#recordEvidence({
        call,
        status: "unavailable",
        source: sourceFor(call.name),
        privacy: "personal",
        payload: {
          complete,
          source_statuses: sourceStatuses,
          results: [],
        },
        errorCode: "source_unavailable",
      });
    }
    return this.#recordEvidence({
      call,
      status: rows.length > 0 ? "ok" : "empty",
      source: sourceFor(call.name),
      privacy: "personal",
      sourceLabels: rows.map((row) => row.title),
      truncated: allRows.length > rows.length,
      payload: {
        complete,
        source_statuses: sourceStatuses,
        results: rows,
      },
    });
  }

  async #getRecentEvents(call: ReadAgentToolCall): Promise<ReadAgentEvidence> {
    const source = this.#currentSource();
    if (this.#services.registry && !source.registry) {
      throw new ToolPolicyError(
        "source_unavailable",
        "Live Home Assistant entity registry data is unavailable.",
      );
    }
    const watcher = this.#services.eventWatcher;
    if (!watcher) {
      throw new ToolPolicyError(
        "source_unavailable",
        "The recent Home Assistant event view is unavailable.",
      );
    }
    const snapshot = watcher.snapshot();
    if (!snapshot.lastEvaluatedAt) {
      throw new ToolPolicyError(
        "source_unavailable",
        "The recent event view has not completed an evaluation.",
      );
    }
    if (!recentEventViewIsCurrent(snapshot, this.#now())) {
      throw new ToolPolicyError(
        "stale_source",
        "The recent event view is too old to support a current answer.",
      );
    }
    const observedAtMs = this.#now().getTime();
    const coverageStartMs = observedAtMs - MAX_RECENT_EVENT_AGE_MS;
    const rawEvents = watcher.recentEvents(Number.MAX_SAFE_INTEGER)
      .filter((event) => {
        const detectedAtMs = Date.parse(event.detectedAt);
        return Number.isFinite(detectedAtMs)
          && detectedAtMs >= coverageStartMs
          && detectedAtMs <= observedAtMs + 5_000;
      });
    const knownPersonLabels = privacyPersonLabels(
      source.registry,
      this.#services.aliases ?? [],
      this.#principal,
      source.states.values(),
    );
    const safeEvents = rawEvents
      .filter(isSafePassiveWatcherEvent)
      .filter((event) => {
        const entityId = eventEntityId(event);
        const state = source.states.get(entityId);
        if (
          state === undefined
          || !isStateSafeForReadAgent(
            state,
            this.#principal,
            source.registry,
            this.#services.aliases ?? [],
            knownPersonLabels,
          )
        ) {
          return false;
        }
        const eventLabel = watcherEventLabel(event);
        return !looksLikeSensitiveSecretLabel(eventLabel)
          && !isSensitiveLocationEntity(
            entityId,
            state,
            [
              ...privacyLabelsForEntity(
                source.registry,
                this.#services.aliases ?? [],
                entityId,
              ),
              eventLabel,
            ],
            knownPersonLabels,
          );
      });
    const visibleEvents = safeEvents.slice(0, call.limit);
    const rows = visibleEvents.map(eventRow);
    const entityIds = [...new Set(visibleEvents.map(eventEntityId))];
    return this.#recordEvidence({
      call,
      status: rows.length > 0 ? "ok" : "empty",
      source: sourceFor(call.name),
      privacy: visibleEvents.some((event) => event.kind === "calendar_start")
        ? "personal"
        : "household",
      entityIds,
      sourceLabels: eventLabels(visibleEvents),
      truncated: safeEvents.length > visibleEvents.length,
      cached: true,
      stateRevision: null,
      registryRevision: null,
      watcherRevision: snapshot.revision,
      payload: {
        evaluated_at: safeTimestamp(snapshot.lastEvaluatedAt),
        coverage: {
          start: new Date(coverageStartMs).toISOString(),
          end: new Date(observedAtMs).toISOString(),
          completeness: "best_effort_positive_observations_only",
        },
        events: rows,
      },
    });
  }

  #entities(
    entityIds: readonly string[],
    expectedDomain?: string,
  ): CurrentSource {
    for (const entityId of entityIds) {
      if (STATE_READ_DENIED_DOMAINS.has(entityDomain(entityId))) {
        throw new ToolPolicyError(
          "privacy_denied",
          "Free-form Home Assistant text helpers are not available to the read agent.",
        );
      }
      if (!this.#grantedEntityIds.has(entityId)) {
        throw new ToolPolicyError(
          "entity_not_granted",
          "An entity must be returned by search_entities in this session before it can be read.",
        );
      }
      if (expectedDomain && entityDomain(entityId) !== expectedDomain) {
        throw new ToolPolicyError(
          "wrong_entity_domain",
          `This tool accepts only ${expectedDomain} entities.`,
        );
      }
    }
    const source = this.#currentSource();
    if (this.#services.registry && !source.registry) {
      throw new ToolPolicyError(
        "source_unavailable",
        "Live Home Assistant entity registry data is unavailable.",
      );
    }
    const knownPersonLabels = privacyPersonLabels(
      source.registry,
      this.#services.aliases ?? [],
      this.#principal,
      source.states.values(),
    );
    for (const entityId of entityIds) {
      const state = requiredState(source, entityId);
      if (!isStateSafeForReadAgent(
        state,
        this.#principal,
        source.registry,
        this.#services.aliases ?? [],
        knownPersonLabels,
      )) {
        throw new ToolPolicyError(
          "privacy_denied",
          "This entity's state is not safe for external read-agent processing.",
        );
      }
    }
    return source;
  }

  #entityEvidenceRemainsSafe(evidence: ReadAgentEvidence): boolean {
    const source = this.#currentSourceOrNull();
    if (!source) {
      return false;
    }
    if (evidence.tool === "get_my_presence_history") {
      const grantedPersonEntityId = this.#ownPresencePersonEntityId;
      return grantedPersonEntityId !== null
        && this.#ownPresenceWindow !== null
        && evidence.entityIds.length === 1
        && evidence.entityIds[0] === grantedPersonEntityId
        && entityDomain(grantedPersonEntityId) === "person"
        && source.states.has(grantedPersonEntityId)
        && resolvePersonBindingFromSource(
          this.#principal.actorId,
          source,
          this.#services.aliases ?? [],
        ) === grantedPersonEntityId;
    }
    if (
      this.#services.registry
      && !source.registry
    ) {
      return false;
    }
    const knownPersonLabels = privacyPersonLabels(
      source.registry,
      this.#services.aliases ?? [],
      this.#principal,
      source.states.values(),
    );
    return evidence.entityIds.every((entityId) => {
      const state = source.states.get(entityId);
      return state !== undefined && isStateSafeForReadAgent(
        state,
        this.#principal,
        source.registry,
        this.#services.aliases ?? [],
        knownPersonLabels,
      );
    });
  }

  #currentSource(): CurrentSource {
    const source = this.#currentSourceOrNull();
    if (!source) {
      throw new ToolPolicyError(
        "source_unavailable",
        "Live Home Assistant state is unavailable.",
      );
    }
    return source;
  }

  #currentSourceOrNull(): CurrentSource | null {
    const stateCache = this.#services.stateCache;
    if (!stateCache) {
      return null;
    }
    // Never read HaStateCache.entries/get directly: those deliberately
    // retain stale values through disconnects. The turn view gates snapshots.
    const view = new BasicTurnSourceView({
      stateCache,
      ...(this.#services.registry ? { registry: this.#services.registry } : {}),
      ...(this.#services.aliases ? { aliases: this.#services.aliases } : {}),
    });
    if (!view.availability.state) {
      return null;
    }
    const states = new Map(view.states().map((state) => [state.entityId, state]));
    return {
      view,
      states,
      registry: view.registryIndex() ?? undefined,
      stateRevision: stateCache.revision(),
      // Registry revision is also its availability generation. Retain it while
      // the registry is unavailable so recovery cannot leave state-only
      // discovery evidence looking current.
      registryRevision: this.#services.registry?.revision() ?? null,
    };
  }

  async #sourceCall<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.#throwIfRunAborted();
    const controller = new AbortController();
    let abortListener: (() => void) | null = null;
    let runAbortListener: (() => void) | null = null;
    let timer: NodeJS.Timeout | null = null;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(abortReason(controller.signal));
      controller.signal.addEventListener("abort", abortListener, {
        once: true,
      });
    });
    if (this.#runSignal) {
      runAbortListener = () => {
        if (!controller.signal.aborted) {
          controller.abort(abortReason(this.#runSignal as AbortSignal));
        }
      };
      this.#runSignal.addEventListener("abort", runAbortListener, {
        once: true,
      });
      if (this.#runSignal.aborted) {
        runAbortListener();
      }
    }
    timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new ToolPolicyError(
          "source_timeout",
          "The read source did not respond in time.",
        ));
      }
    }, this.#sourceTimeoutMs);
    try {
      if (controller.signal.aborted) {
        return await aborted;
      }
      return await Promise.race([operation(controller.signal), aborted]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      if (abortListener) {
        controller.signal.removeEventListener("abort", abortListener);
      }
      if (runAbortListener && this.#runSignal) {
        this.#runSignal.removeEventListener("abort", runAbortListener);
      }
    }
  }

  #recordEvidence(input: EvidenceInput): ReadAgentEvidence {
    this.#throwIfRunAborted();
    const evidenceId = `read-evidence-${++this.#evidenceSequence}`;
    const payload = input.payload ?? {};
    const evidence = deepFreeze<ReadAgentEvidence>({
      evidenceId,
      callId: input.call.call_id,
      tool: input.call.name,
      status: input.status,
      source: input.source,
      observedAt: this.#now().toISOString(),
      privacy: this.#evidencePrivacy(input.privacy ?? "household"),
      entityIds: [...new Set(input.entityIds ?? [])],
      sourceLabels: [...new Set(input.sourceLabels ?? [])],
      cached: input.cached ?? false,
      truncated: input.truncated ?? false,
      stateRevision: input.stateRevision ?? null,
      registryRevision: input.registryRevision ?? null,
      watcherRevision: input.watcherRevision ?? null,
      stateFingerprints: [...(input.fingerprints ?? [])],
      facts: buildEvidenceFacts(
        evidenceId,
        input.call,
        input.status,
        input.truncated ?? false,
        payload,
        input.entityIds ?? [],
        input.sourceLabels ?? [],
      ),
      payload,
      errorCode: input.errorCode ?? null,
    });
    this.#evidence.push(evidence);
    return evidence;
  }

  #throwIfRunAborted(): void {
    if (this.#runSignal?.aborted) {
      throw abortReason(this.#runSignal);
    }
  }

  #evidencePrivacy(privacy: ReadAgentPrivacyClass): ReadAgentPrivacyClass {
    if (privacy === "personal" && !this.#principal.actorId) {
      throw new Error("personal evidence requires a trusted principal");
    }
    return privacy;
  }
}

export function createReadAgentToolSession(
  options: ReadAgentToolSessionOptions,
): ReadAgentToolSession {
  return new ReadAgentToolSession(options);
}

function validateCall(call: ReadAgentToolCall): void {
  if (!call || typeof call !== "object" || Array.isArray(call)) {
    throw invalid("Tool call must be an object.");
  }
  const actualKeys = Object.keys(call).sort();
  if (
    actualKeys.length !== TOOL_CALL_KEYS.length
    || actualKeys.some((key, index) => key !== TOOL_CALL_KEYS[index])
  ) {
    throw invalid("Tool call fields did not match the strict schema.");
  }
  if (!CALL_ID_PATTERN.test(call.call_id)) {
    throw invalid("call_id is invalid.");
  }
  if (!Array.isArray(call.entity_ids)
    || call.entity_ids.length > MAX_ENTITY_IDS
    || call.entity_ids.some((entityId) =>
      typeof entityId !== "string" || !ENTITY_ID_PATTERN.test(entityId))
    || new Set(call.entity_ids).size !== call.entity_ids.length) {
    throw invalid("entity_ids must contain at most ten unique Home Assistant entity ids.");
  }
  if (!Number.isInteger(call.limit) || call.limit < 0) {
    throw invalid("limit must be a non-negative integer.");
  }
  validateOptionalInput(call.query, 300, "query");
  validateOptionalInput(call.start, 80, "start");
  validateOptionalInput(call.end, 80, "end");
  validateOptionalInput(call.area, 160, "area");
  if (call.domain !== null
    && (typeof call.domain !== "string" || !DOMAIN_PATTERN.test(call.domain))) {
    throw invalid("domain is invalid.");
  }
  if (!Array.isArray(call.types)
    || new Set(call.types).size !== call.types.length
    || call.types.some((type) =>
      !["mean", "min", "max", "state", "sum"].includes(type))) {
    throw invalid("types contains an unsupported or duplicate value.");
  }
  if (!Array.isArray(call.statuses)
    || call.statuses.length > 10
    || new Set(call.statuses).size !== call.statuses.length
    || call.statuses.some((status) =>
      typeof status !== "string"
      || !status.trim()
      || status.length > 40
      || hasControlCharacter(status))) {
    throw invalid("statuses contains an invalid value.");
  }

  switch (call.name) {
    case "search_entities":
      requireText(call.query, "search_entities query");
      requireNoEntities(call);
      requireNoWindow(call);
      requireLimit(call, 1, MAX_SEARCH_RESULTS);
      requireDefaults(call, {
        allowQuery: true,
        allowDomain: true,
        allowArea: true,
      });
      return;
    case "get_states":
      requireEntities(call);
      requireNoWindow(call);
      requireUnusedLimit(call);
      requireDefaults(call);
      return;
    case "get_history":
      requireEntities(call);
      requireWindow(call);
      requireUnusedLimit(call);
      requireDefaults(call, { allowWindow: true });
      return;
    case "get_my_presence_history":
      requireNoEntities(call);
      requireWindow(call);
      requireUnusedLimit(call);
      requireDefaults(call, { allowWindow: true });
      return;
    case "get_statistics":
      requireEntities(call);
      requireWindow(call);
      requireUnusedLimit(call);
      if (call.period === "none" || call.types.length === 0) {
        throw invalid("get_statistics requires a period and at least one statistic type.");
      }
      requireDefaults(call, {
        allowWindow: true,
        allowPeriod: true,
        allowTypes: true,
      });
      return;
    case "get_calendar":
      requireEntities(call);
      requireWindow(call);
      requireUnusedLimit(call);
      requireDefaults(call, { allowWindow: true });
      return;
    case "get_todos":
      requireEntities(call);
      requireNoWindow(call);
      requireUnusedLimit(call);
      requireDefaults(call, { allowStatuses: true });
      return;
    case "get_weather":
      requireEntities(call);
      if (call.entity_ids.length !== 1
        || (call.mode !== "hourly" && call.mode !== "daily")) {
        throw invalid("get_weather requires one entity and hourly or daily mode.");
      }
      requireNoWindow(call);
      requireUnusedLimit(call);
      requireDefaults(call, { allowMode: true });
      return;
    case "search_media":
      requireNoEntities(call);
      requireNoWindow(call);
      requireLimit(call, 1, MAX_MEDIA_RESULTS);
      requireMediaCall(call);
      return;
    case "get_recent_events":
      requireNoEntities(call);
      requireNoWindow(call);
      requireLimit(call, 1, MAX_ROWS);
      requireDefaults(call);
      return;
  }
}

function requireDefaults(
  call: ReadAgentToolCall,
  allowed: {
    readonly allowArea?: boolean;
    readonly allowDomain?: boolean;
    readonly allowMode?: boolean;
    readonly allowPeriod?: boolean;
    readonly allowQuery?: boolean;
    readonly allowStatuses?: boolean;
    readonly allowTypes?: boolean;
    readonly allowWindow?: boolean;
  } = {},
): void {
  if ((!allowed.allowQuery && call.query !== null)
    || (!allowed.allowDomain && call.domain !== null)
    || (!allowed.allowArea && call.area !== null)
    || (!allowed.allowWindow && (call.start !== null || call.end !== null))
    || (!allowed.allowMode && call.mode !== "none")
    || (!allowed.allowPeriod && call.period !== "none")
    || (!allowed.allowTypes && call.types.length !== 0)
    || (!allowed.allowStatuses && call.statuses.length !== 0)
    || call.media_kind !== "any"
    || call.media_filter !== "none") {
    throw invalid("Tool call contains fields that are not used by this tool.");
  }
}

function requireMediaCall(call: ReadAgentToolCall): void {
  if (call.domain !== null
    || call.area !== null
    || call.period !== "none"
    || call.types.length !== 0
    || call.statuses.length !== 0
    || call.mode === "none"
    || call.mode === "hourly"
    || call.mode === "daily") {
    throw invalid("search_media contains unsupported fields.");
  }
  if (call.mode === "find") {
    requireText(call.query, "search_media find query");
    if (call.media_filter !== "none") {
      throw invalid("search_media find does not accept a media filter.");
    }
    return;
  }
  if (call.media_kind === "any") {
    throw invalid("Media list and recommendation calls require movie or show kind.");
  }
  if (call.mode === "recommend") {
    if (call.media_filter !== "none") {
      throw invalid("search_media recommend does not accept a media filter.");
    }
    return;
  }
  if (call.mode === "list") {
    if (call.query !== null
      || (call.media_filter !== "recent" && call.media_filter !== "unwatched")) {
      throw invalid("search_media list requires recent or unwatched and no query.");
    }
    return;
  }
  throw invalid("search_media mode is unsupported.");
}

function requireNoEntities(call: ReadAgentToolCall): void {
  if (call.entity_ids.length !== 0) {
    throw invalid("This tool does not accept entity_ids.");
  }
}

function requireEntities(call: ReadAgentToolCall): void {
  if (call.entity_ids.length === 0) {
    throw invalid("This tool requires at least one entity_id.");
  }
}

function requireNoWindow(call: ReadAgentToolCall): void {
  if (call.start !== null || call.end !== null) {
    throw invalid("This tool does not accept a time window.");
  }
}

function requireWindow(call: ReadAgentToolCall): void {
  if (call.start === null || call.end === null) {
    throw invalid("This tool requires start and end timestamps.");
  }
}

function requireUnusedLimit(call: ReadAgentToolCall): void {
  if (call.limit !== 0) {
    throw invalid("limit must be zero for this tool.");
  }
}

function requireLimit(call: ReadAgentToolCall, minimum: number, maximum: number): void {
  if (call.limit < minimum || call.limit > maximum) {
    throw invalid(`limit must be from ${minimum} to ${maximum} for this tool.`);
  }
}

function requireText(value: string | null, label: string): void {
  if (value === null || !value.trim()) {
    throw invalid(`${label} is required.`);
  }
}

function validateOptionalInput(
  value: string | null,
  maximum: number,
  label: string,
): void {
  if (value === null) {
    return;
  }
  if (typeof value !== "string"
    || !value.trim()
    || value.length > maximum
    || hasControlCharacter(value)) {
    throw invalid(`${label} is invalid.`);
  }
}

function historyWindow(
  call: ReadAgentToolCall,
  now: Date,
): { readonly start: string; readonly end: string } {
  return boundedWindow(call, true, now);
}

function boundedWindow(
  call: ReadAgentToolCall,
  historicalOnly: boolean,
  now: Date,
): { readonly start: string; readonly end: string } {
  const start = parseTimestamp(call.start, "start");
  const end = parseTimestamp(call.end, "end");
  if (end.getTime() <= start.getTime()) {
    throw invalid("end must be after start.");
  }
  if (end.getTime() - start.getTime() > MAX_WINDOW_MS) {
    throw invalid("Time windows cannot exceed 31 days.");
  }
  if (historicalOnly && end.getTime() > now.getTime()) {
    throw invalid("Historical windows cannot end in the future.");
  }
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function parseTimestamp(value: string | null, label: string): Date {
  if (value === null || !ISO_TIMESTAMP_PATTERN.test(value)) {
    throw invalid(`${label} must be an ISO timestamp with a timezone.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw invalid(`${label} is not a real timestamp.`);
  }
  return parsed;
}

function normalizeGrantedWindow(
  value: {
    readonly start: string;
    readonly end: string;
  } | null,
  label: string,
): {
  readonly start: string;
  readonly end: string;
} | null {
  if (!value) {
    return null;
  }
  const start = parseTimestamp(value.start, `${label} start`);
  const end = parseTimestamp(value.end, `${label} end`);
  if (
    end.getTime() <= start.getTime()
    || end.getTime() - start.getTime() > MAX_WINDOW_MS
  ) {
    throw new Error(`${label} is invalid or exceeds 31 days`);
  }
  return Object.freeze({
    start: start.toISOString(),
    end: end.toISOString(),
  });
}

function normalizeGrantedPersonEntityId(value: string | null): string | null {
  if (
    typeof value !== "string"
    || !ENTITY_ID_PATTERN.test(value)
    || entityDomain(value) !== "person"
  ) {
    return null;
  }
  return value;
}

function resolvePersonBindingFromSource(
  actorId: string,
  source: CurrentSource,
  aliases: readonly AliasEntry[],
): string | null {
  return resolveHistoricalPersonEntityId(
    actorId,
    {
      get: (entityId) => source.states.get(entityId) ?? null,
      entries: () => [...source.states.values()],
    },
    aliases,
  );
}

function assertCanonicalWindow(
  requested: {
    readonly start: string;
    readonly end: string;
  },
  canonical: {
    readonly start: string;
    readonly end: string;
  } | null,
): void {
  if (!canonical) {
    throw new ToolPolicyError(
      "time_window_unresolved",
      "A deterministic time window was not available for this lookup.",
    );
  }
  assertExactWindow(requested, canonical, "canonical");
}

function assertExactWindow(
  requested: {
    readonly start: string;
    readonly end: string;
  },
  allowed: {
    readonly start: string;
    readonly end: string;
  },
  label: string,
): void {
  if (
    Date.parse(requested.start) !== Date.parse(allowed.start)
    || Date.parse(requested.end) !== Date.parse(allowed.end)
  ) {
    throw new ToolPolicyError(
      "time_window_mismatch",
      `The requested window did not match the software-resolved ${label} window.`,
    );
  }
}

function assertHistoryAllowed(
  states: readonly HaEntityState[],
  registry: HaRegistryIndex | undefined,
  aliases: readonly AliasEntry[],
  principal: ReadAgentPrincipal,
  allStates: Iterable<HaEntityState>,
): void {
  const knownPersonLabels = privacyPersonLabels(
    registry,
    aliases,
    principal,
    allStates,
  );
  if (states.some((state) =>
    HISTORY_DENIED_DOMAINS.has(entityDomain(state.entityId))
    || isSensitiveLocationEntity(
      state.entityId,
      state,
      privacyLabelsForEntity(registry, aliases, state.entityId),
      knownPersonLabels,
    ))) {
    throw new ToolPolicyError(
      "privacy_denied",
      "Person and location history is not available to the read agent.",
    );
  }
}

function assertRawHistoryStateTypes(states: readonly HaEntityState[]): void {
  if (states.some((state) => stateFingerprint(state).volatileMeasurement)) {
    throw new ToolPolicyError(
      "history_cost_exceeded",
      "Raw history is unavailable for volatile measurements; use bounded Home Assistant statistics.",
    );
  }
}

function assertHistoryRowsSafe(
  rows: readonly HaHistoryState[],
  currentStates: readonly HaEntityState[],
  ownerPresence = false,
): void {
  const currentByEntity = new Map(
    currentStates.map((state) => [state.entityId, state]),
  );
  const unsafe = rows.some((row) => {
    const current = currentByEntity.get(row.entityId);
    if (!current || looksLikeSensitiveStateValue(row.state)) {
      return true;
    }
    if (ownerPresence && entityDomain(row.entityId) === "person") {
      return false;
    }
    const domain = entityDomain(row.entityId);
    if (CONSTRAINED_STATE_DOMAINS.has(domain)) {
      return false;
    }
    if (!NUMERIC_STATE_DOMAINS.has(domain)) {
      return true;
    }
    if (Number.isFinite(Number(row.state))) {
      return false;
    }
    const deviceClass = optionalAttributeText(
      current.attributes.device_class,
    )?.toLowerCase();
    return !deviceClass
      || !SAFE_TEXT_SENSOR_DEVICE_CLASSES.has(deviceClass)
      || !isIsoDateOrTimestamp(row.state);
  });
  if (unsafe) {
    throw new ToolPolicyError(
      "privacy_denied",
      "Home Assistant history contained a state value that is unsafe for external read-agent processing.",
    );
  }
}

function assertStatesSafeForReadAgent(
  states: readonly HaEntityState[],
  principal: ReadAgentPrincipal,
  registry: HaRegistryIndex | undefined,
  aliases: readonly AliasEntry[],
  allStates: Iterable<HaEntityState>,
): void {
  const knownPersonLabels = privacyPersonLabels(
    registry,
    aliases,
    principal,
    allStates,
  );
  if (states.some((state) =>
    !isStateSafeForReadAgent(
      state,
      principal,
      registry,
      aliases,
      knownPersonLabels,
    ))) {
    throw new ToolPolicyError(
      "privacy_denied",
      "One or more entity states are not safe for external read-agent processing.",
    );
  }
}

function isStateSafeForReadAgent(
  state: HaEntityState,
  principal: ReadAgentPrincipal,
  registry: HaRegistryIndex | undefined,
  aliases: readonly AliasEntry[],
  knownPersonLabels: readonly string[],
): boolean {
  const domain = entityDomain(state.entityId);
  if (
    STATE_READ_DENIED_DOMAINS.has(domain)
    || looksLikeSensitiveStateValue(state.state)
    || isSensitiveSecretEntity(state, registry, aliases)
  ) {
    return false;
  }
  if (domain === "person") {
    return state.entityId === principal.actorId;
  }
  if (isSensitiveLocationEntity(
    state.entityId,
    state,
    privacyLabelsForEntity(registry, aliases, state.entityId),
    knownPersonLabels,
  )) {
    return false;
  }
  if (CONSTRAINED_STATE_DOMAINS.has(domain)) {
    return true;
  }
  if (NUMERIC_STATE_DOMAINS.has(domain)) {
    if (Number.isFinite(Number(state.state))) {
      return true;
    }
    const deviceClass = optionalAttributeText(state.attributes.device_class)?.toLowerCase();
    return deviceClass !== undefined
      && deviceClass !== null
      && SAFE_TEXT_SENSOR_DEVICE_CLASSES.has(deviceClass)
      && isIsoDateOrTimestamp(state.state);
  }
  return false;
}

function looksLikeSensitiveStateValue(value: string): boolean {
  const clean = value.trim();
  return /(?:https?:\/\/|wss?:\/\/|mailto:)/iu.test(clean)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(clean)
    || /\b(?:\d{1,3}\.){3}\d{1,3}\b/u.test(clean)
    || /\b(?:token|secret|password|passwd|passcode|credential|credentials|api[_ -]?key|bearer|pin)\b\s*[:=]/iu.test(clean)
    || containsCredentialValue(clean, ADJACENT_CREDENTIAL_TOKEN_PATTERN)
    || containsCredentialValue(clean, LINKED_SECRET_VALUE_PATTERN)
    || containsCredentialValue(clean, ACCESS_CODE_VALUE_PATTERN)
    || containsCredentialValue(clean, GENERAL_CREDENTIAL_CODE_VALUE_PATTERN)
    || containsCredentialValue(clean, CREDENTIAL_PHRASE_VALUE_PATTERN)
    || containsCredentialValue(clean, CREDENTIAL_KEY_VALUE_PATTERN)
    || /\b[0-9a-f]{32,}\b/iu.test(clean)
    || /[A-Za-z0-9+/=_-]{48,}/u.test(clean);
}

function containsCredentialValue(value: string, pattern: RegExp): boolean {
  return [...value.matchAll(pattern)].some((match) => {
    const candidate = match[1]
      ?.toLowerCase()
      .replaceAll(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "");
    return candidate !== undefined
      && candidate.length > 0
      && !BENIGN_CREDENTIAL_FOLLOWERS.has(candidate);
  });
}

function isSensitiveSecretEntity(
  state: HaEntityState,
  registry: HaRegistryIndex | undefined,
  aliases: readonly AliasEntry[],
): boolean {
  const friendlyName = optionalAttributeText(state.attributes.friendly_name);
  return [
    state.entityId,
    ...(friendlyName ? [friendlyName] : []),
    ...privacyLabelsForEntity(registry, aliases, state.entityId),
  ].some(looksLikeSensitiveSecretLabel);
}

function looksLikeSensitiveSecretLabel(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim();
  if (!normalized) {
    return false;
  }
  if (
    SECRET_ENTITY_LABEL_TERM_PATTERN.test(normalized)
    || /\bapi\s+key\b/iu.test(normalized)
  ) {
    return true;
  }
  const tokens = normalized.split(/\s+/u);
  return (
    tokens.some((token) => token === "code" || token === "codes")
    && tokens.some((token) => SECRET_ENTITY_ACCESS_CODE_CONTEXT.has(token))
  ) || (
    tokens.some((token) => token === "phrase" || token === "phrases")
    && tokens.some((token) => SECRET_ENTITY_PHRASE_CONTEXT.has(token))
  ) || (
    tokens.some((token) => token === "key" || token === "keys")
    && tokens.some((token) => SECRET_ENTITY_KEY_CONTEXT.has(token))
  );
}

function isIsoDateOrTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/u.test(value);
}

function assertFresh(result: HaHistoryResult): void {
  if (result.cached) {
    throw new ToolPolicyError(
      "stale_source",
      "The history source returned cached data to a fresh-only request.",
    );
  }
}

function requiredState(source: CurrentSource, entityId: string): HaEntityState {
  const state = source.states.get(entityId);
  if (!state) {
    throw new ToolPolicyError(
      "entity_missing",
      "A granted entity is no longer present in the live state snapshot.",
    );
  }
  return state;
}

function stateFingerprint(state: HaEntityState): ReadAgentStateFingerprint {
  const deviceClass = optionalAttributeText(state.attributes.device_class);
  return Object.freeze({
    entityId: state.entityId,
    state: state.state,
    lastUpdated: state.lastUpdated,
    volatileMeasurement: Number.isFinite(Number(state.state))
      || VOLATILE_DOMAINS.has(entityDomain(state.entityId))
      || (deviceClass !== null && VOLATILE_DEVICE_CLASSES.has(deviceClass.toLowerCase())),
  });
}

function assertRawHistoryCost(
  entityIds: readonly string[],
  window: { readonly start: string; readonly end: string },
): void {
  const durationDays = (Date.parse(window.end) - Date.parse(window.start))
    / (24 * 60 * 60 * 1_000);
  if (
    entityIds.length > MAX_RAW_HISTORY_ENTITIES
    || durationDays * entityIds.length > MAX_RAW_HISTORY_ENTITY_DAYS
  ) {
    throw new ToolPolicyError(
      "history_cost_exceeded",
      "Raw history is limited to one entity-day; use statistics or narrow the question.",
    );
  }
}

function scopedHistoryRows(
  rows: readonly HaHistoryState[],
  allowedEntityIds: ReadonlySet<string>,
  window: { readonly start: string; readonly end: string },
): readonly Readonly<Record<string, unknown>>[] {
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  const carryByEntity = new Map<string, {
    readonly row: HaHistoryState;
    readonly timestampMs: number;
  }>();
  const inside: Array<{
    readonly row: HaHistoryState;
    readonly timestampMs: number;
  }> = [];
  for (const row of rows) {
    if (!allowedEntityIds.has(row.entityId)) {
      continue;
    }
    const timestampMs = Date.parse(row.lastChanged || row.lastUpdated);
    if (!Number.isFinite(timestampMs) || timestampMs >= endMs) {
      continue;
    }
    if (timestampMs < startMs) {
      const prior = carryByEntity.get(row.entityId);
      if (!prior || timestampMs > prior.timestampMs) {
        carryByEntity.set(row.entityId, { row, timestampMs });
      }
      continue;
    }
    inside.push({ row, timestampMs });
  }
  const carry = [...carryByEntity.values()].map(({ row }) => ({
    entity_id: row.entityId,
    state: sanitizeSourceText(row.state, 160),
    last_changed: new Date(startMs).toISOString(),
    last_updated: new Date(startMs).toISOString(),
    carried_from_before_window: true,
  }));
  const inWindow = inside
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .map(({ row }) => historyRow(row));
  return [...carry, ...inWindow];
}

function statisticSampleInWindow(
  sample: HaStatisticSample,
  window: { readonly start: string; readonly end: string },
): boolean {
  const sampleStartMs = Date.parse(sample.start);
  return Number.isFinite(sampleStartMs)
    && sampleStartMs >= Date.parse(window.start)
    && sampleStartMs < Date.parse(window.end);
}

function historyRow(row: HaHistoryState): Readonly<Record<string, unknown>> {
  return {
    entity_id: row.entityId,
    state: sanitizeSourceText(row.state, 160),
    last_changed: safeTimestamp(row.lastChanged),
    last_updated: safeTimestamp(row.lastUpdated),
  };
}

function statisticsRow(
  sample: HaStatisticSample,
): Readonly<Record<string, unknown>> {
  return {
    statistic_id: sample.statisticId,
    start: safeTimestamp(sample.start),
    end: sample.end ? safeTimestamp(sample.end) : null,
    mean: finiteNumber(sample.mean),
    min: finiteNumber(sample.min),
    max: finiteNumber(sample.max),
    state: finiteNumber(sample.state),
    sum: finiteNumber(sample.sum),
  };
}

function forecastRow(point: object): Readonly<Record<string, unknown>> {
  const value = point as Record<string, unknown>;
  return {
    datetime: safeTimestamp(String(value.datetime ?? "")),
    condition: safeOptionalText(value.condition, 60),
    precipitation_probability: finiteNumber(value.precipitationProbability),
    precipitation: finiteNumber(value.precipitation),
    temperature: finiteNumber(value.temperature),
    templow: finiteNumber(value.templow),
    wind_speed: finiteNumber(value.windSpeed),
    wind_gust_speed: finiteNumber(value.windGustSpeed),
    humidity: finiteNumber(value.humidity),
    uv_index: finiteNumber(value.uvIndex),
  };
}

function mediaRow(
  item: LocalMediaRecommendation | LocalMediaListItem,
): {
  readonly title: string;
  readonly year: number | null;
  readonly kind: string;
  readonly available: boolean;
  readonly source: string;
  readonly rating: number | null;
  readonly rating_source: string | null;
  readonly genres: readonly string[];
  readonly watched: boolean | null;
  readonly added_at: number | null;
} {
  const listItem = item as Partial<LocalMediaListItem>;
  return {
    title: sanitizeSourceText(item.title, 160),
    year: Number.isInteger(item.year) ? item.year : null,
    kind: sanitizeSourceText(item.kind, 20),
    available: item.available === true,
    source: sanitizeSourceText(item.source, 40),
    rating: finiteNumber(item.rating),
    rating_source: safeOptionalText(item.ratingSource, 60),
    genres: Array.isArray(item.genres)
      ? item.genres.slice(0, 10).map((genre) => sanitizeSourceText(genre, 60))
      : [],
    watched: typeof listItem.watched === "boolean" ? listItem.watched : null,
    added_at:
      typeof listItem.addedAt === "number"
      && Number.isFinite(listItem.addedAt)
      && listItem.addedAt > 0
        ? listItem.addedAt
        : null,
  };
}

function mediaSourceStatuses(
  sources: readonly {
    readonly source: string;
    readonly status: string;
    readonly errorCode: string | null;
  }[],
): readonly Readonly<Record<string, unknown>>[] {
  return sources.map((item) => Object.freeze({
    source: sanitizeSourceText(item.source, 40),
    status: sanitizeSourceText(item.status, 40),
    error_code: item.errorCode
      ? sanitizeSourceText(item.errorCode, 60)
      : null,
  }));
}

function eventRow(
  event: SafePassiveWatcherEvent,
): Readonly<Record<string, unknown>> {
  if (event.kind === "calendar_start") {
    return {
      kind: event.kind,
      detected_at: safeTimestamp(event.detectedAt),
      calendar_entity_id: event.calendarEntityId,
      calendar_name: safeOptionalText(event.calendarName, 120),
      summary: sanitizeSourceText(event.eventSummary, 200),
      event_start: safeTimestamp(event.eventStart),
    };
  }
  return {
    kind: event.kind,
    detected_at: safeTimestamp(event.detectedAt),
    entity_id: event.entityId,
    label: sanitizeSourceText(event.label, 120),
    from_state: sanitizeSourceText(event.fromState, 80),
    to_state: sanitizeSourceText(event.toState, 80),
  };
}

function eventLabels(events: readonly PassiveWatcherEvent[]): readonly string[] {
  return [...new Set(events.flatMap((event) => {
    if ("personId" in event) {
      return [];
    }
    if (event.kind === "calendar_start") {
      return [safeOptionalText(event.calendarName, 120)
        ?? sanitizeSourceText(event.calendarEntityId, 120)];
    }
    return [sanitizeSourceText(event.label, 120)];
  }))];
}

function isSafePassiveWatcherEvent(
  event: PassiveWatcherEvent,
): event is SafePassiveWatcherEvent {
  return "calendarEntityId" in event || "entityId" in event;
}

function eventEntityId(event: SafePassiveWatcherEvent): string {
  return "calendarEntityId" in event
    ? event.calendarEntityId
    : event.entityId;
}

function watcherEventLabel(event: SafePassiveWatcherEvent): string {
  return "calendarEntityId" in event
    ? event.calendarName ?? event.calendarEntityId
    : event.label;
}

function recentEventViewIsCurrent(
  snapshot: PassiveEventWatcherSnapshot,
  now: Date,
): boolean {
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !snapshot.lastEvaluatedAt) {
    return false;
  }
  const evaluatedAtMs = Date.parse(snapshot.lastEvaluatedAt);
  const eventViewAgeMs = now.getTime() - evaluatedAtMs;
  return Number.isFinite(evaluatedAtMs)
    && eventViewAgeMs >= -5_000
    && eventViewAgeMs <= MAX_RECENT_EVENT_VIEW_AGE_MS;
}

function safeStateAttributes(
  attributes: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const safe: Record<string, unknown> = {};
  for (const key of SAFE_STATE_ATTRIBUTES) {
    const value = attributes[key];
    const sanitized = safeScalar(value);
    if (sanitized !== undefined) {
      safe[key] = sanitized;
    }
  }
  return safe;
}

const MAX_EVIDENCE_FACTS = MAX_ROWS;

function buildEvidenceFacts(
  evidenceId: string,
  call: ReadAgentToolCall,
  status: ReadAgentEvidenceStatus,
  truncated: boolean,
  payload: Readonly<Record<string, unknown>>,
  entityIds: readonly string[],
  sourceLabels: readonly string[],
): readonly ReadAgentEvidenceFact[] {
  if ((status !== "ok" && status !== "empty") || truncated) {
    return [];
  }
  const facts: ReadAgentEvidenceFact[] = [];
  const labelByEntity = new Map(
    entityIds.map((entityId, index) => [
      entityId,
      sourceLabels[index] ?? entityId,
    ]),
  );
  const add = (kind: ReadAgentEvidenceFact["kind"], text: string): void => {
    if (facts.length >= MAX_EVIDENCE_FACTS) {
      return;
    }
    const clean = text.replaceAll(/\s+/g, " ").trim().slice(0, 420);
    if (clean) {
      facts.push({
        factId: `${evidenceId}:fact-${facts.length + 1}`,
        kind,
        text: /[.!?]$/.test(clean) ? clean : `${clean}.`,
      });
    }
  };
  const rows = (key: string): readonly Record<string, unknown>[] =>
    recordArray(payload[key]);

  if (status === "empty") {
    const window = recordOrNull(payload.window);
    const windowText = window
      ? factWindow(window.start, window.end)
      : null;
    switch (call.name) {
      case "search_entities":
        add("empty_result", "Home Assistant entity discovery returned no matching entities");
        break;
      case "get_history":
      case "get_my_presence_history":
        add("empty_result", `Home Assistant history returned no recorded state rows${windowText ? ` ${windowText}` : ""}`);
        break;
      case "get_statistics":
        add("empty_result", `Home Assistant statistics returned no samples${windowText ? ` ${windowText}` : ""}`);
        break;
      case "get_calendar":
        add("empty_result", `The selected Home Assistant calendars returned no events${windowText ? ` ${windowText}` : ""}`);
        break;
      case "get_todos":
        add("empty_result", "The selected Home Assistant to-do lists returned no matching items");
        break;
      case "get_weather":
        add("empty_result", "Home Assistant returned no forecast points for the selected weather entity");
        break;
      case "search_media":
        add("empty_result", "The local media catalogue returned no matching items");
        break;
      case "get_states":
      case "get_recent_events":
        // A missing state is an error, while the event feed is explicitly
        // incomplete and therefore cannot support a negative fact.
        break;
    }
    return facts;
  }

  switch (call.name) {
    case "search_entities":
      for (const row of rows("entities")) {
        if (row.metadata_only === true) {
          add("entity_match", [
            "Home Assistant entity discovery found",
            factQuote(row.label),
            "as a configured person entry; its state and location were withheld",
          ].join(" "));
          continue;
        }
        add("entity_match", [
          "Home Assistant entity discovery found",
          factQuote(row.label),
          `with id ${factQuote(row.entity_id)}`,
          row.area ? `in area ${factQuote(row.area)}` : "",
        ].filter(Boolean).join(" "));
      }
      break;
    case "get_states":
      for (const row of rows("states")) {
        const attributes = recordOrNull(row.attributes);
        const unit = attributes
          ? safeOptionalText(attributes.unit_of_measurement, 20)
          : null;
        add("state_observation", [
          `At ${factTime(row.last_updated)}, Home Assistant reported`,
          factQuote(row.label ?? row.entity_id),
          `as ${factQuote(row.state)}${unit ? ` ${unit}` : ""}`,
        ].join(" "));
        const attributeUnits: Readonly<Record<string, string | null>> = {
          battery_level: "%",
          brightness: null,
          current_temperature: safeOptionalText(
            attributes?.temperature_unit ?? attributes?.unit_of_measurement,
            20,
          ),
          humidity: "%",
          temperature: safeOptionalText(
            attributes?.temperature_unit ?? attributes?.unit_of_measurement,
            20,
          ),
        };
        for (const [key, attributeUnit] of Object.entries(attributeUnits)) {
          const value = attributes?.[key];
          if (
            typeof value !== "number"
            && typeof value !== "string"
            && typeof value !== "boolean"
          ) {
            continue;
          }
          add("state_observation", [
            `At ${factTime(row.last_updated)}, Home Assistant reported`,
            `${factQuote(row.label ?? row.entity_id)} ${key.replaceAll("_", " ")}`,
            `as ${factQuote(value)}${attributeUnit ? ` ${attributeUnit}` : ""}`,
          ].join(" "));
        }
      }
      break;
    case "get_history":
    case "get_my_presence_history":
      for (const row of rows("states")) {
        const entityId = typeof row.entity_id === "string" ? row.entity_id : "";
        const unit = recordOrNull(payload.units)?.[entityId];
        add(
          Number.isFinite(Number(row.state))
            ? "history_measurement"
            : "history_state",
          [
          `At ${factTime(row.last_changed ?? row.last_updated)}, Home Assistant history recorded`,
          factQuote(labelByEntity.get(entityId) ?? entityId),
          `as ${factQuote(row.state)}${typeof unit === "string" ? ` ${unit}` : ""}`,
          ].join(" "),
        );
      }
      break;
    case "get_statistics":
      for (const row of rows("samples")) {
        const entityId = typeof row.statistic_id === "string" ? row.statistic_id : "";
        const unit = recordOrNull(payload.units)?.[entityId];
        const values = ["mean", "min", "max", "state", "sum"]
          .filter((key) => typeof row[key] === "number")
          .map((key) => `${key} ${String(row[key])}`)
          .join(", ");
        if (values) {
          add("statistic_sample", [
            `For the period starting ${factTime(row.start)}, Home Assistant statistics recorded`,
            factQuote(labelByEntity.get(entityId) ?? entityId),
            `with ${values}${typeof unit === "string" ? ` ${unit}` : ""}`,
          ].join(" "));
        }
      }
      break;
    case "get_calendar":
      for (const row of rows("events")) {
        add("calendar_event", [
          `Calendar ${factQuote(row.calendar_name ?? row.entity_id)} contains event`,
          factQuote(row.summary),
          factCalendarRange(row.start, row.end, row.all_day),
          row.location ? `at ${factQuote(row.location)}` : "",
        ].filter(Boolean).join(" "));
      }
      break;
    case "get_todos":
      for (const row of rows("items")) {
        add("todo_item", [
          `To-do list ${factQuote(row.list_name ?? row.entity_id)} contains`,
          factQuote(row.summary),
          row.status ? `with status ${factQuote(row.status)}` : "",
          row.due
            ? `due ${factTime(row.due)}${isDateOnly(row.due) ? " (date only)" : ""}`
            : "",
        ].filter(Boolean).join(" "));
      }
      break;
    case "get_weather":
      for (const row of rows("forecasts")) {
        const temperatureUnit = safeOptionalText(payload.temperature_unit, 20);
        const precipitationUnit = safeOptionalText(payload.precipitation_unit, 20);
        const windUnit = safeOptionalText(payload.wind_speed_unit, 20);
        const details = [
          row.condition ? `condition ${factQuote(row.condition)}` : "",
          typeof row.temperature === "number"
            ? `temperature ${row.temperature}${temperatureUnit ? ` ${temperatureUnit}` : ""}`
            : "",
          typeof row.templow === "number"
            ? `low ${row.templow}${temperatureUnit ? ` ${temperatureUnit}` : ""}`
            : "",
          typeof row.precipitation_probability === "number"
            ? `rain probability ${row.precipitation_probability} percent`
            : "",
          typeof row.precipitation === "number"
            ? `precipitation ${row.precipitation}${precipitationUnit ? ` ${precipitationUnit}` : ""}`
            : "",
          typeof row.wind_speed === "number"
            ? `wind ${row.wind_speed}${windUnit ? ` ${windUnit}` : ""}`
            : "",
          typeof row.wind_gust_speed === "number"
            ? `gusts ${row.wind_gust_speed}${windUnit ? ` ${windUnit}` : ""}`
            : "",
          typeof row.humidity === "number" ? `humidity ${row.humidity} percent` : "",
          typeof row.uv_index === "number" ? `UV index ${row.uv_index}` : "",
        ].filter(Boolean).join(", ");
        if (details) {
          add(
            "weather_forecast",
            `The Home Assistant forecast for ${factTime(row.datetime)}${isDateOnly(row.datetime) ? " (all day)" : ""} reports ${details}`,
          );
        }
      }
      break;
    case "search_media":
      for (const row of rows("results")) {
        add("media_item", [
          "The local media catalogue lists",
          factQuote(row.title),
          row.year ? `from ${String(row.year)}` : "",
          row.kind ? `as a ${factQuote(row.kind)}` : "",
          row.source ? `from source ${factQuote(row.source)}` : "",
          row.available === true ? "and marks it available" : "",
          typeof row.rating === "number"
            ? `with rating ${row.rating}${row.rating_source ? ` from ${factQuote(row.rating_source)}` : ""}`
            : "",
          Array.isArray(row.genres) && row.genres.length > 0
            ? `in genres ${row.genres.map((genre) => factQuote(genre)).join(", ")}`
            : "",
          typeof row.watched === "boolean"
            ? row.watched ? "and marks it watched" : "and marks it unwatched"
            : "",
          typeof row.added_at === "number"
            ? `added at ${factTime(new Date(row.added_at).toISOString())}`
            : "",
        ].filter(Boolean).join(" "));
      }
      break;
    case "get_recent_events":
      for (const row of rows("events")) {
        if (row.kind === "calendar_start") {
          add("recent_event", [
            `At ${factTime(row.detected_at)}, the passive event feed observed calendar event`,
            factQuote(row.summary),
            `starting on ${factTime(row.event_start)}`,
          ].join(" "));
        } else {
          add("recent_event", [
            `At ${factTime(row.detected_at)}, the passive event feed observed`,
            factQuote(row.label ?? row.entity_id),
            `change from ${factQuote(row.from_state)} to ${factQuote(row.to_state)}`,
          ].join(" "));
        }
      }
      break;
  }
  return facts;
}

function recordArray(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function factQuote(value: unknown): string {
  const text = sanitizeSourceText(String(value ?? "unknown"), 160)
    .replaceAll(/[“”"]/g, "'");
  return `“${text || "unknown"}”`;
}

function factTime(value: unknown): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    if (year && month && day) {
      return new Intl.DateTimeFormat(HOUSE_LOCALE, {
        timeZone: HOUSE_TIME_ZONE,
        dateStyle: "medium",
      }).format(new Date(Date.UTC(year, month - 1, day, 12)));
    }
  }
  const parsed = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (!Number.isFinite(parsed.getTime())) {
    return "an unknown time";
  }
  return new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: HOUSE_TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function factWindow(start: unknown, end: unknown): string | null {
  if (typeof start !== "string" || typeof end !== "string") {
    return null;
  }
  return `between ${factTime(start)} and ${factTime(end)}`;
}

function factCalendarRange(
  start: unknown,
  end: unknown,
  allDay: unknown = false,
): string {
  if (allDay === true && isDateOnly(start) && isDateOnly(end)) {
    const inclusiveEnd = previousCalendarDate(end);
    return inclusiveEnd === start
      ? `on ${factTime(start)} (all day)`
      : `from ${factTime(start)} through ${factTime(inclusiveEnd)} (all day)`;
  }
  return `from ${factTime(start)} to ${factTime(end)}`;
}

function previousCalendarDate(value: string): string {
  const parsed = parseCalendarDate(value);
  if (!parsed) {
    return value;
  }
  const prior = new Date(Date.UTC(
    parsed.year,
    parsed.month - 1,
    parsed.day - 1,
  ));
  return [
    String(prior.getUTCFullYear()).padStart(4, "0"),
    String(prior.getUTCMonth() + 1).padStart(2, "0"),
    String(prior.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function isDateOnly(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function safeScalar(value: unknown): string | number | boolean | readonly (string | number | boolean)[] | undefined {
  if (typeof value === "string") {
    return sanitizeSourceText(value, 160);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value) && value.length <= 10) {
    const items = value.map(safeScalar);
    return items.every((item) =>
      typeof item === "string"
      || typeof item === "number"
      || typeof item === "boolean")
      ? items as readonly (string | number | boolean)[]
      : undefined;
  }
  return undefined;
}

function entityLabel(
  entityId: string,
  state: HaEntityState | null,
  registry: HaRegistryIndex | undefined,
): string {
  const indexed = registry?.entity(entityId);
  const candidate = optionalAttributeText(state?.attributes.friendly_name)
    ?? indexed?.name
    ?? indexed?.originalName
    ?? indexed?.deviceName
    ?? entityId;
  return sanitizeSourceText(candidate, 120);
}

function personMetadataLabel(
  entityId: string,
  registry: HaRegistryIndex | undefined,
): string {
  const indexed = registry?.entity(entityId);
  const objectId = entityId.split(".", 2)[1]?.replaceAll("_", " ") ?? entityId;
  return sanitizeSourceText(
    indexed?.name
      ?? indexed?.originalName
      ?? objectId,
    120,
  );
}

function privacyForEntities(
  states: readonly HaEntityState[],
  registry: HaRegistryIndex | undefined,
  aliases: readonly AliasEntry[],
): ReadAgentPrivacyClass {
  return states.some((state) =>
    PERSONAL_DOMAINS.has(entityDomain(state.entityId))
    || isSensitiveLocationEntity(
      state.entityId,
      state,
      privacyLabelsForEntity(registry, aliases, state.entityId),
      privacyPersonLabels(registry, aliases),
    )
  )
    ? "personal"
    : "household";
}

function privacyLabelsForEntity(
  registry: HaRegistryIndex | undefined,
  aliases: readonly AliasEntry[],
  entityId: string,
): readonly string[] {
  return buildEntityLocationPrivacyContext({
    registry,
    aliases,
  }).labelsForEntity(entityId);
}

function privacyPersonLabels(
  registry: HaRegistryIndex | undefined,
  aliases: readonly AliasEntry[],
  principal?: ReadAgentPrincipal,
  states: Iterable<HaEntityState> = [],
): readonly string[] {
  return buildEntityLocationPrivacyContext({
    registry,
    states,
    aliases,
    additionalKnownPersonEntityIds: principal?.actorId
      ? [principal.actorId]
      : [],
    additionalKnownPersonLabels: principal?.label
      ? [principal.label]
      : [],
  }).knownPersonLabels;
}

function sanitizeSourceText(value: string, maximum: number): string {
  const clean = value
    .split("")
    .map((character) => isControlCharacter(character) ? " " : character)
    .join("")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (INJECTION_TEXT.some((pattern) => pattern.test(clean))) {
    return "[redacted unsafe source text]";
  }
  if (looksLikeSensitiveStateValue(clean)) {
    return "[redacted sensitive source text]";
  }
  return clean.length <= maximum ? clean : `${clean.slice(0, maximum - 1)}…`;
}

function hasControlCharacter(value: string): boolean {
  return value.split("").some(isControlCharacter);
}

function isControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code <= 31 || code === 127;
}

function safeOptionalText(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.trim()
    ? sanitizeSourceText(value, maximum)
    : null;
}

function optionalAttributeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeUnit(state: HaEntityState): string | null {
  return safeOptionalText(
    state.attributes.unit_of_measurement
      ?? state.attributes.temperature_unit,
    20,
  );
}

function safeTimestamp(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ? value : null;
  }
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function sourceTimestampMs(
  value: string,
  timezoneReference: string,
  label: string,
  timezone: string | null = null,
): number {
  if (isDateOnly(value)) {
    const date = parseCalendarDate(value);
    if (!date) {
      throw new ToolPolicyError(
        "source_invalid",
        `The source returned an invalid ${label}.`,
      );
    }
    if (timezone) {
      return zonedCalendarMidnightMs(date, timezone);
    }
  }
  const offset = timezoneReference.match(/(?:Z|[+-]\d{2}:\d{2})$/u)?.[0]
    ?? "Z";
  const candidate = /^\d{4}-\d{2}-\d{2}$/u.test(value)
    ? `${value}T00:00:00${offset}`
    : value;
  const timestampMs = Date.parse(candidate);
  if (!Number.isFinite(timestampMs)) {
    throw new ToolPolicyError(
      "source_invalid",
      `The source returned an invalid ${label}.`,
    );
  }
  return timestampMs;
}

function parseCalendarDate(
  value: string,
): { readonly year: number; readonly month: number; readonly day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  return normalized.getUTCFullYear() === year
    && normalized.getUTCMonth() === month - 1
    && normalized.getUTCDate() === day
    ? { year, month, day }
    : null;
}

function zonedCalendarMidnightMs(
  date: { readonly year: number; readonly month: number; readonly day: number },
  timezone: string,
): number {
  const localAsUtc = Date.UTC(date.year, date.month - 1, date.day);
  let utcMs = localAsUtc
    - calendarTimezoneOffsetMs(new Date(localAsUtc), timezone);
  utcMs = localAsUtc
    - calendarTimezoneOffsetMs(new Date(utcMs), timezone);
  return utcMs;
}

function weatherCoverage(
  mode: ReadAgentToolCall["mode"],
  canonicalWindow: {
    readonly start: string;
    readonly end: string;
  } | null,
  now: Date,
  timezone: string,
): Readonly<{
  start: string;
  end: string;
  timezone: string;
  basis: "canonical_window" | "software_horizon";
}> {
  if (canonicalWindow) {
    return Object.freeze({
      start: canonicalWindow.start,
      end: canonicalWindow.end,
      timezone,
      basis: "canonical_window",
    });
  }
  if (mode === "hourly") {
    const currentHourMs = Math.floor(
      now.getTime() / (60 * 60 * 1_000),
    ) * 60 * 60 * 1_000;
    return Object.freeze({
      start: new Date(currentHourMs).toISOString(),
      end: new Date(currentHourMs + WEATHER_HOURLY_HORIZON_MS).toISOString(),
      timezone,
      basis: "software_horizon",
    });
  }
  const startDate = calendarDateInTimezone(now, timezone);
  const endDate = addCalendarDays(
    startDate,
    WEATHER_DAILY_HORIZON_DAYS,
  );
  return Object.freeze({
    start: new Date(zonedCalendarMidnightMs(startDate, timezone)).toISOString(),
    end: new Date(zonedCalendarMidnightMs(endDate, timezone)).toISOString(),
    timezone,
    basis: "software_horizon",
  });
}

function calendarDateInTimezone(
  value: Date,
  timezone: string,
): { readonly year: number; readonly month: number; readonly day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): number => {
    const item = parts.find((candidate) => candidate.type === type)?.value;
    if (!item) {
      throw new ToolPolicyError(
        "source_invalid",
        "The canonical timezone could not be applied to weather data.",
      );
    }
    return Number(item);
  };
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
  };
}

function addCalendarDays(
  value: { readonly year: number; readonly month: number; readonly day: number },
  days: number,
): { readonly year: number; readonly month: number; readonly day: number } {
  const shifted = new Date(Date.UTC(
    value.year,
    value.month - 1,
    value.day + days,
  ));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function calendarTimezoneOffsetMs(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((item) => item.type === type)?.value;
    if (!value) {
      throw new ToolPolicyError(
        "source_invalid",
        "The canonical timezone could not be applied to calendar data.",
      );
    }
    return Number(value);
  };
  const localAsUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return localAsUtc - Math.floor(date.getTime() / 1_000) * 1_000;
}

function normalizeTimezone(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  try {
    new Intl.DateTimeFormat(HOUSE_LOCALE, { timeZone: value }).format(new Date(0));
    return value;
  } catch {
    throw new Error("canonical time window timezone is invalid");
  }
}

function normalizeTodoStatus(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/gu, "_");
}

function safeOptionalTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  // HA todos may use a date without a time.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ? value : null;
  }
  return safeTimestamp(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function entityDomain(entityId: string): string {
  return entityId.split(".", 1)[0] ?? "";
}

function sourceFor(tool: ReadAgentToolName): string {
  switch (tool) {
    case "search_entities":
      return "home_assistant_entity_index";
    case "get_states":
      return "home_assistant_live_state";
    case "get_history":
      return "home_assistant_history";
    case "get_my_presence_history":
      return "home_assistant_owner_presence_history";
    case "get_statistics":
      return "home_assistant_statistics";
    case "get_calendar":
      return "home_assistant_calendar";
    case "get_todos":
      return "home_assistant_todo";
    case "get_weather":
      return "home_assistant_weather";
    case "search_media":
      return "local_media_catalogue";
    case "get_recent_events":
      return "housemate_recent_event_view";
  }
}

function toolName(call: ReadAgentToolCall): ReadAgentToolName {
  const name = (call as { readonly name?: unknown } | null)?.name;
  if (![
    "search_entities",
    "get_states",
    "get_history",
    "get_my_presence_history",
    "get_statistics",
    "get_calendar",
    "get_todos",
    "get_weather",
    "search_media",
    "get_recent_events",
  ].includes(name as string)) {
    throw new ToolPolicyError(
      "unsupported_tool",
      "Only the declared read-only tools are available.",
    );
  }
  return name as ReadAgentToolName;
}

function validatePrincipal(principal: ReadAgentPrincipal): ReadAgentPrincipal {
  if (!principal
    || typeof principal.actorId !== "string"
    || !principal.actorId.trim()
    || principal.actorId.length > 160
    || typeof principal.label !== "string"
    || !principal.label.trim()
    || principal.label.length > 120
    || hasControlCharacter(`${principal.actorId}${principal.label}`)) {
    throw new Error("read agent requires a valid trusted principal");
  }
  return Object.freeze({
    actorId: principal.actorId.trim(),
    label: principal.label.trim(),
  });
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("The read-agent operation was aborted.");
  error.name = "AbortError";
  return error;
}

function invalid(message: string): ToolPolicyError {
  return new ToolPolicyError("invalid_arguments", message);
}

class ToolPolicyError extends Error {
  readonly code: string;
  readonly publicMessage: string;

  constructor(code: string, publicMessage: string) {
    super(publicMessage);
    this.name = "ToolPolicyError";
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

function cloneCall(call: ReadAgentToolCall): ReadAgentToolCall {
  return Object.freeze({
    ...call,
    entity_ids: Object.freeze([...call.entity_ids]),
    types: Object.freeze([...call.types]),
    statuses: Object.freeze([...call.statuses]),
  });
}

function callFromEvidence(evidence: ReadAgentEvidence): ReadAgentToolCall {
  return {
    call_id: evidence.callId,
    name: evidence.tool,
    query: null,
    entity_ids: [],
    start: null,
    end: null,
    limit: 0,
    domain: null,
    area: null,
    mode: "none",
    period: "none",
    types: [],
    statuses: [],
    media_kind: "any",
    media_filter: "none",
  };
}

function semanticEvidenceSignature(evidence: ReadAgentEvidence): string {
  return JSON.stringify({
    tool: evidence.tool,
    status: evidence.status,
    source: evidence.source,
    privacy: evidence.privacy,
    entity_ids: evidence.entityIds,
    source_labels: evidence.sourceLabels,
    truncated: evidence.truncated,
    facts: evidence.facts.map((fact) => ({
      kind: fact.kind,
      text: fact.text,
    })),
    payload: evidence.payload,
    error_code: evidence.errorCode,
  });
}
