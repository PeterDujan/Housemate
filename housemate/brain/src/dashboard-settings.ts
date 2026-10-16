import type { AppConfig } from "./config.js";
import type { HaStateCache } from "./ha-state-cache.js";
import {
  JARVIS_PROACTIVE_ENTITY_ID,
  JARVIS_SILENT_FROM_ENTITY_ID,
  JARVIS_SILENT_UNTIL_ENTITY_ID,
} from "./housemate-controls.js";
import {
  isLiveSettingKey,
  liveSettingRows,
  type LiveSettingKey,
  type LiveSettingsStore,
  type LiveSettingValue,
} from "./live-settings.js";
import { lockedApprovalService, type HaServiceCommandClient } from "./memory-reflection.js";
import { ownerPossessive } from "./household.js";

/**
 * What the dashboard Settings tab reads and writes. The assistant's own
 * switches go through the live store; the three HA helpers (speak up, quiet
 * hours) stay in HA and are changed there, nothing else. Supervisor ingress
 * only; the server checks that before any of this runs.
 */

export type JarvisHelperKey = "proactive" | "silentFrom" | "silentUntil";

const HELPER_ENTITY: Readonly<Record<JarvisHelperKey, string>> = {
  proactive: JARVIS_PROACTIVE_ENTITY_ID,
  silentFrom: JARVIS_SILENT_FROM_ENTITY_ID,
  silentUntil: JARVIS_SILENT_UNTIL_ENTITY_ID,
};

const HELPER_CONFIRM_TIMEOUT_MS = 4_000;
const HELPER_CONFIRM_POLL_MS = 100;

export interface JarvisHelperValues {
  /** False when HA is not connected or a helper is missing; the page shows them read-only. */
  readonly available: boolean;
  readonly proactive: boolean | null;
  readonly silentFrom: string | null;
  readonly silentUntil: string | null;
}

export function isJarvisHelperKey(key: unknown): key is JarvisHelperKey {
  return key === "proactive" || key === "silentFrom" || key === "silentUntil";
}

export class JarvisHelperControl {
  private readonly stateCache: HaStateCache;
  private readonly client: () => HaServiceCommandClient | null;
  private readonly confirmTimeoutMs: number;

  constructor(options: {
    readonly stateCache: HaStateCache;
    readonly client: () => HaServiceCommandClient | null;
    readonly confirmTimeoutMs?: number;
  }) {
    this.stateCache = options.stateCache;
    this.client = options.client;
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? HELPER_CONFIRM_TIMEOUT_MS;
  }

  read(): JarvisHelperValues {
    const proactive = this.stateCache.get(JARVIS_PROACTIVE_ENTITY_ID)?.state ?? null;
    const silentFrom = clockValue(this.stateCache.get(JARVIS_SILENT_FROM_ENTITY_ID)?.state);
    const silentUntil = clockValue(this.stateCache.get(JARVIS_SILENT_UNTIL_ENTITY_ID)?.state);
    const proactiveValue = proactive === "on" ? true : proactive === "off" ? false : null;
    return {
      available: this.client() !== null && proactiveValue !== null && silentFrom !== null && silentUntil !== null,
      proactive: proactiveValue,
      silentFrom,
      silentUntil,
    };
  }

  /**
   * Changes one helper and waits until HA reports the new state, because a
   * successful service call is not proof the helper changed.
   */
  async set(key: JarvisHelperKey, value: unknown): Promise<{ readonly confirmed: boolean; readonly values: JarvisHelperValues }> {
    const client = this.client();
    if (!client) throw new Error("Home Assistant is not connected");
    const entityId = HELPER_ENTITY[key];
    if (!this.stateCache.get(entityId)) throw new Error(`${entityId} is missing in Home Assistant`);
    let expected: (state: string) => boolean;
    if (key === "proactive") {
      if (typeof value !== "boolean") throw new Error("proactive must be true or false");
      await client.sendCommand({
        type: "call_service",
        domain: "input_boolean",
        service: value ? "turn_on" : "turn_off",
        service_data: { entity_id: entityId },
      });
      expected = (state) => state === (value ? "on" : "off");
    } else {
      const clock = typeof value === "string" ? clockValue(value) : null;
      if (!clock) throw new Error("time must be HH:MM");
      await client.sendCommand({
        type: "call_service",
        domain: "input_datetime",
        service: "set_datetime",
        service_data: { entity_id: entityId, time: `${clock}:00` },
      });
      expected = (state) => clockValue(state) === clock;
    }
    const deadline = Date.now() + this.confirmTimeoutMs;
    for (;;) {
      const state = this.stateCache.get(entityId)?.state ?? "";
      if (expected(state)) return { confirmed: true, values: this.read() };
      if (Date.now() >= deadline) return { confirmed: false, values: this.read() };
      await new Promise((resolve) => setTimeout(resolve, HELPER_CONFIRM_POLL_MS));
    }
  }
}

export interface DashboardSettingRow {
  readonly key: LiveSettingKey;
  readonly group: string;
  readonly label: string;
  readonly help: string;
  readonly kind: "boolean" | "enum";
  readonly values?: readonly string[];
  readonly value: LiveSettingValue;
  readonly defaultValue: LiveSettingValue;
  readonly saved: boolean;
  /** Plain labels of switches that are off and this one needs. */
  readonly waitingOn: readonly string[];
  readonly unavailable: string | null;
}

export interface DashboardSettingsResponse {
  readonly ok: true;
  readonly rows: readonly DashboardSettingRow[];
  readonly helpers: JarvisHelperValues;
  /** Display-only: code refuses every other notify target. */
  readonly memoryAlerts: { readonly service: string | null; readonly label: string };
}

export function buildDashboardSettings(options: {
  readonly defaults: AppConfig;
  readonly store: LiveSettingsStore;
  readonly helpers: JarvisHelperControl | null;
}): DashboardSettingsResponse {
  const rows = liveSettingRows(options.defaults, options.store);
  const current = new Map(rows.map((row) => [row.key as string, row]));
  const memoryAlerts = lockedApprovalService(options.defaults);
  return {
    ok: true,
    rows: rows.map((row) => {
      const definition = row.definition;
      return {
        key: row.key,
        group: definition.group,
        label: definition.label,
        help: definition.help,
        kind: definition.kind,
        ...(definition.kind === "enum" ? { values: definition.values } : {}),
        value: row.value,
        defaultValue: row.defaultValue,
        saved: row.saved,
        waitingOn: (definition.requires ?? [])
          .map((key) => current.get(key))
          .filter((needed) => needed !== undefined && needed.value === false)
          .map((needed) => needed!.definition.label),
        unavailable: definition.backend && options.defaults.modelBackend !== definition.backend
          ? "Needs the Claude backend"
          : null,
      };
    }),
    helpers: options.helpers?.read() ?? { available: false, proactive: null, silentFrom: null, silentUntil: null },
    memoryAlerts: {
      service: memoryAlerts,
      label: memoryAlerts ? `${capitalisedPossessive()} phone` : "Off (no notify service set)",
    },
  };
}

/** Body of `POST /settings`: `{ key, value }` saves, `{ key, reset: true }` returns to the add-on option. */
export function applyDashboardSetting(store: LiveSettingsStore, body: unknown): LiveSettingKey {
  const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  if (!isLiveSettingKey(record.key)) throw new Error("unknown setting");
  if (record.reset === true) store.reset(record.key);
  else store.set(record.key, record.value);
  return record.key;
}

function clockValue(value: string | undefined | null): string | null {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value?.trim() ?? "");
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function capitalisedPossessive(): string {
  const owner = ownerPossessive();
  return owner.charAt(0).toUpperCase() + owner.slice(1);
}
