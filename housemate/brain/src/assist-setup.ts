import { friendlyNameAttribute } from "./dashboard-names.js";
import type { HaRegistryIndex } from "./ha-registry-index.js";
import type { HaStateCache } from "./ha-state-cache.js";
import type { HaServiceCommandClient } from "./memory-reflection.js";
import { assistantName } from "./persona.js";

/*
 * How Home Assistant's voice side is set up for the app, read from HA for the page's checks and
 * its last setup step: the Housemate Brain agent, the app's own Hearing and Voice (Wyoming), the
 * other speech engines HA has, and which voice assistant (pipeline) each speaker uses. Read only.
 */

export interface SpeechEntity {
  readonly id: string;
  readonly name: string;
}

export interface SpeakerAssistant {
  /** The speaker's assist_satellite entity. */
  readonly id: string;
  readonly deviceId: string | null;
  readonly name: string;
  /** The voice assistant it uses, by name ("" when HA's own pick could not be read). */
  readonly assistant: string;
  readonly usesHousemate: boolean;
}

export interface AssistSetup {
  readonly agent: string | null;
  readonly agentName: string | null;
  /** The app's own Hearing and Voice in HA (Wyoming), when they are added. */
  readonly hearing: SpeechEntity | null;
  readonly voice: SpeechEntity | null;
  /** HA's other speech engines (never the app's own). */
  readonly stt: readonly SpeechEntity[];
  readonly tts: readonly SpeechEntity[];
  readonly speakers: readonly SpeakerAssistant[];
  /** Why the voice assistants could not be read, when they could not. */
  readonly error: string | null;
}

interface Pipeline {
  readonly id: string;
  readonly name: string;
  readonly conversation_engine?: unknown;
}

export class AssistSetupReader {
  constructor(private readonly options: {
    readonly stateCache: HaStateCache;
    readonly registry: HaRegistryIndex;
    readonly client: () => HaServiceCommandClient | null;
  }) {}

  async read(): Promise<AssistSetup> {
    const { stateCache, registry } = this.options;
    const entities = registry.allEntities();
    const agentEntity = entities.find((entity) => entity.platform === "housemate" && entity.entityId.startsWith("conversation.")) ?? null;
    const named = (id: string): SpeechEntity => ({ id, name: friendlyNameAttribute(stateCache.get(id)?.attributes ?? {}) ?? registry.entity(id)?.originalName ?? id });
    const own = ownSpeech(entities, assistantName());
    const speech = (domain: "stt" | "tts") => stateCache.entries()
      .filter((state) => state.entityId.startsWith(`${domain}.`) && state.state !== "unavailable" && !own.ids.has(state.entityId))
      .map((state) => named(state.entityId))
      .sort((left, right) => left.name.localeCompare(right.name));
    let pipelines: readonly Pipeline[] = [];
    let preferred = "";
    let error: string | null = null;
    const client = this.options.client();
    if (!client) {
      error = "Home Assistant is not connected";
    } else {
      try {
        const body = await client.sendCommand({ type: "assist_pipeline/pipeline/list" }) as { pipelines?: unknown; preferred_pipeline?: unknown };
        pipelines = Array.isArray(body?.pipelines) ? body.pipelines.filter((item): item is Pipeline => Boolean(item) && typeof (item as Pipeline).name === "string") : [];
        preferred = typeof body?.preferred_pipeline === "string" ? body.preferred_pipeline : "";
      } catch (reason) {
        error = reason instanceof Error ? reason.message : String(reason);
      }
    }
    const speakers = stateCache.entries()
      .filter((state) => state.entityId.startsWith("assist_satellite.") && state.state !== "unavailable")
      .map((state): SpeakerAssistant => {
        const deviceId = registry.entity(state.entityId)?.deviceId ?? null;
        const device = deviceId ? registry.device(deviceId) : null;
        const select = deviceId ? assistantSelect(registry, deviceId) : null;
        const picked = select ? stateCache.get(select)?.state ?? "" : "";
        const pipeline = picked === "preferred" || !select
          ? pipelines.find((item) => item.id === preferred)
          : pipelines.find((item) => item.name === picked);
        return {
          id: state.entityId,
          deviceId,
          name: device?.name ?? friendlyNameAttribute(state.attributes) ?? state.entityId,
          assistant: pipeline?.name ?? "",
          usesHousemate: Boolean(agentEntity && pipeline && pipeline.conversation_engine === agentEntity.entityId),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      agent: agentEntity?.entityId ?? null,
      agentName: agentEntity ? named(agentEntity.entityId).name : null,
      hearing: own.hearing ? named(own.hearing) : null,
      voice: own.voice ? named(own.voice) : null,
      stt: speech("stt"),
      tts: speech("tts"),
      speakers,
      error,
    };
  }
}

/** The app's Wyoming services are named "<assistant> Hearing" and "<assistant> Voice"; an older name still counts. */
function ownSpeech(entities: ReturnType<HaRegistryIndex["allEntities"]>, name: string) {
  const wyoming = entities.filter((entity) => entity.platform === "wyoming");
  const pick = (domain: string, word: string): string | null => {
    const mine = wyoming.filter((entity) => entity.domain === domain && (entity.originalName ?? "").endsWith(` ${word}`));
    return (mine.find((entity) => entity.originalName === `${name} ${word}`) ?? mine[0])?.entityId ?? null;
  };
  const hearing = pick("stt", "Hearing");
  const voice = pick("tts", "Voice");
  return { hearing, voice, ids: new Set([hearing, voice].filter((id): id is string => id !== null)) };
}

/** The speaker's "Assistant" select (its first, for the first wake word). */
function assistantSelect(registry: HaRegistryIndex, deviceId: string): string | null {
  return registry.entitiesForDevice(deviceId)
    .filter((entity) => /^select\..*_(?:assistant|pipeline)$/.test(entity.entityId))
    .sort((left, right) => left.entityId.length - right.entityId.length || left.entityId.localeCompare(right.entityId))[0]?.entityId ?? null;
}

/** Home Assistant's phones (its mobile app notify services), for the approval phone. */
export async function notifyPhones(client: HaServiceCommandClient): Promise<readonly { readonly value: string; readonly label: string }[]> {
  const services = await client.sendCommand({ type: "get_services" }) as { notify?: Record<string, unknown> } | null;
  return Object.keys(services?.notify ?? {})
    .filter((service) => service.startsWith("mobile_app_"))
    .sort()
    .map((service) => ({
      value: `notify.${service}`,
      label: service.slice("mobile_app_".length).split("_").filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" "),
    }));
}
