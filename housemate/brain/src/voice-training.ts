import { friendlyNameAttribute } from "./dashboard-names.js";
import type { HaRegistryIndex } from "./ha-registry-index.js";
import type { HaStateCache } from "./ha-state-cache.js";
import { householdPersonById } from "./household.js";
import type { HaServiceCommandClient } from "./memory-reflection.js";
import { assistantName } from "./persona.js";

/**
 * Voice training from the page. The page picks a person and an Assist
 * satellite; the voice arms a session for that satellite and returns its opening line; Home Assistant
 * announces it on the satellite. When the satellite goes idle, Housemate Brain plays the beep file and
 * listens (any TTS works). The voice runs the ten sentences and the training itself; this only lists
 * speakers, starts, stops and reports progress.
 *
 * The announcement takes as long as the intro is spoken, longer than a websocket command may wait,
 * so it goes over HA's REST API in the background; if it fails, the session is cancelled.
 */

export interface TrainingSatellite {
  readonly entityId: string;
  readonly name: string;
  readonly wakeWord: string;
}

export interface TrainingStatus {
  readonly state: string;
  readonly person_id?: string;
  readonly name?: string;
  readonly sentence?: number;
  readonly total?: number;
  readonly progress?: number;
  readonly message?: string;
}

/** Assist satellites that can start a conversation (AssistSatelliteEntityFeature.START_CONVERSATION). */
const START_CONVERSATION = 2;

export class VoiceTrainingControl {
  private readonly stateCache: HaStateCache;
  private readonly registry: HaRegistryIndex;
  private readonly client: () => HaServiceCommandClient | null;
  private readonly voiceUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly announce: (satellite: string, message: string) => Promise<void>;

  constructor(options: {
    readonly stateCache: HaStateCache;
    readonly registry: HaRegistryIndex;
    readonly client: () => HaServiceCommandClient | null;
    readonly voiceUrl: string;
    readonly fetchImpl?: typeof fetch;
    /** Announces on a satellite and resolves when it has been said (HA's REST API). */
    readonly announce: (satellite: string, message: string) => Promise<void>;
  }) {
    this.stateCache = options.stateCache;
    this.registry = options.registry;
    this.client = options.client;
    this.voiceUrl = options.voiceUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.announce = options.announce;
  }

  satellites(): readonly TrainingSatellite[] {
    return this.stateCache.entries()
      .filter((state) => state.entityId.startsWith("assist_satellite.") && state.state !== "unavailable"
        && (Number(state.attributes.supported_features) & START_CONVERSATION) !== 0)
      .map((state) => ({
        entityId: state.entityId,
        name: friendlyNameAttribute(state.attributes) ?? state.entityId,
        wakeWord: this.wakeWord(state.entityId),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async status(): Promise<TrainingStatus> {
    return await this.voice("status", {}) as TrainingStatus;
  }

  async cancel(): Promise<TrainingStatus> {
    return await this.voice("cancel", {}) as TrainingStatus;
  }

  async start(personId: string, satelliteId: string): Promise<TrainingStatus> {
    const person = householdPersonById(personId);
    if (!person || person.id !== personId) throw new Error("that person does not live here; save People first");
    const satellite = this.satellites().find((each) => each.entityId === satelliteId);
    if (!satellite) throw new Error("that speaker can't run voice training");
    const deviceId = this.registry.entity(satelliteId)?.deviceId;
    if (!deviceId) throw new Error("that speaker has no device in Home Assistant");
    if (!this.client()) throw new Error("Home Assistant is not connected");
    const armed = await this.voice("start", { device_id: deviceId, person_id: person.id, name: person.shortName, wake_word: satellite.wakeWord }) as { say?: string };
    if (!armed.say) throw new Error("the voice did not start a session");
    this.announce(satelliteId, armed.say).catch(async (error: unknown) => {
      console.error(`[brain] voice training: ${satelliteId} could not announce: ${error instanceof Error ? error.message : String(error)}`);
      await this.cancel().catch(() => undefined);
    });
    return this.status();
  }

  /** The satellite's own wake word (its device's first "Wake word" select in use), else "Hey <assistant>". */
  private wakeWord(entityId: string): string {
    const deviceId = this.registry.entity(entityId)?.deviceId;
    const selects = deviceId
      ? this.registry.entitiesForDevice(deviceId)
        .filter((entity) => /^select\..*_wake_word(?:_\d+)?$/.test(entity.entityId))
        .sort((left, right) => left.entityId.length - right.entityId.length || left.entityId.localeCompare(right.entityId))
      : [];
    for (const select of selects) {
      const value = this.stateCache.get(select.entityId)?.state ?? "";
      if (value && !/^(?:unknown|unavailable|none|off|no[ _]wake[ _]word)$/i.test(value)) {
        return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
      }
    }
    return `Hey ${assistantName()}`;
  }

  private async voice(action: string, body: object): Promise<unknown> {
    if (!this.voiceUrl) throw new Error("the voice is not running here");
    const response = await this.fetchImpl(`${this.voiceUrl}/assist/training/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(payload.error || `voice training ${action} failed`);
    return payload;
  }
}

/** Home Assistant's REST service call for announcements, from the brain's own HA address and token. */
export function haRestAnnounce(haUrl: string, token: string | null, fetchImpl: typeof fetch = fetch) {
  // ws://host:8123/api/websocket or, inside an app, ws://supervisor/core/websocket.
  const base = haUrl.replace(/^ws/, "http").replace(/\/(?:api\/)?websocket\/?$/, "").replace(/\/$/, "");
  return async (satellite: string, message: string): Promise<void> => {
    if (!token) throw new Error("no Home Assistant token");
    const response = await fetchImpl(`${base}/api/services/assist_satellite/announce`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ entity_id: satellite, message, preannounce: false }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`announce failed: HTTP ${response.status}`);
  };
}
