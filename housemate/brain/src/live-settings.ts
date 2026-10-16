import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { hasReadableCodexAuth } from "./config.js";
import type { AppConfig } from "./config.js";
import { errorMessage, isRecord } from "./value-guards.js";

/**
 * The assistant owns a small settings file
 * the dashboard changes without a restart. The add-on options page still
 * supplies every value, but only as the default: a setting saved here wins
 * until it is reset. Plumbing (tokens, backend, paths, timeouts, the
 * cognitive breakers) never lives here.
 */

export const LIVE_SETTINGS_SCHEMA_VERSION = 1;

export type LiveSettingGroup = "talking" | "memory" | "quiet" | "house";

interface LiveSettingBase {
  readonly group: LiveSettingGroup;
  /** The add-on option this overrides, for the "default" note. */
  readonly option: string;
  readonly label: string;
  readonly help: string;
  /** Other switches this one does nothing without; the page says so. */
  readonly requires?: readonly string[];
  /** Only meaningful on this model backend. */
  readonly backend?: "claude";
}

export type LiveSettingDefinition =
  | (LiveSettingBase & { readonly kind: "boolean" })
  | (LiveSettingBase & { readonly kind: "enum"; readonly values: readonly string[] });

export const LIVE_SETTINGS = Object.freeze({
  modelEnabled: {
    group: "talking", option: "model_enabled", kind: "boolean",
    label: "Use AI for open chat",
    help: "Off: house questions are still answered, without AI.",
  },
  claudeChatEffort: {
    group: "talking", option: "claude_chat_effort", kind: "enum", values: ["low", "default", "medium", "high"],
    label: "Thinking time",
    help: "Quick answers sooner; Careful takes longer over harder questions.",
    requires: ["modelEnabled"], backend: "claude",
  },
  chatWebSearchEnabled: {
    group: "talking", option: "chat_web_search_enabled", kind: "boolean",
    label: "Look things up online",
    help: "Lets open chat search the web, for everyone (guests too).",
    requires: ["modelEnabled"], backend: "claude",
  },
  chatToolsEnabled: {
    group: "talking", option: "chat_tools_enabled", kind: "boolean",
    label: "Let chat read the house",
    help: "Lets open chat look up devices and history. Household only, never guests.",
    requires: ["modelEnabled", "memoryReflectionEnabled", "memoryRecallEnabled"], backend: "claude",
  },
  speechToneEnabled: {
    group: "talking", option: "speech_tone_enabled", kind: "boolean",
    label: "Tone of voice",
    help: "Sounds warm, dry or concerned to suit each reply. Off: always neutral.",
  },
  correctionsLedgerEnabled: {
    group: "talking", option: "corrections_ledger_enabled", kind: "boolean",
    label: "Keep a corrections list",
    help: "Notes each time someone says it got something wrong. Off also turns off the next one.",
  },
  correctionAskEnabled: {
    group: "talking", option: "correction_ask_enabled", kind: "boolean",
    label: "Ask \"what did you mean?\"",
    help: "When someone just says \"that's wrong\", it asks what they meant instead of guessing.",
    requires: ["correctionsLedgerEnabled"],
  },
  memoryReflectionEnabled: {
    group: "memory", option: "memory_reflection_enabled", kind: "boolean",
    label: "Learn from chats",
    help: "After a chat, it keeps the facts worth remembering about the people in it.",
    requires: ["modelEnabled"],
  },
  memoryRecallEnabled: {
    group: "memory", option: "memory_recall_enabled", kind: "boolean",
    label: "Remember past chats",
    help: "Uses what it remembers when it answers. Off also turns off permanent memories.",
  },
  memoryArchiveEnabled: {
    group: "memory", option: "memory_archive_enabled", kind: "boolean",
    label: "Keep permanent memories",
    help: "Keeps what people say about themselves for good, not just 90 days.",
    requires: ["memoryRecallEnabled"],
  },
  selfGrowthEnabled: {
    group: "memory", option: "self_growth_enabled", kind: "boolean",
    label: "Grow its character",
    help: "Each night it may change a little of how it sees itself, from the day's chats.",
    requires: ["modelEnabled"],
  },
  cognitiveProactiveEnabled: {
    group: "quiet", option: "cognitive_proactive_enabled", kind: "boolean",
    label: "Proactive thinking",
    help: "Suggests proactive things the assistant could do. Currently unavailable.",
  },
  deviceControlEnabled: {
    group: "house", option: "device_control_enabled", kind: "boolean",
    label: "Switch devices",
    help: "Turns on and off what you have exposed to Assist in Home Assistant, when someone in the house asks. Guests: lights only.",
  },
} satisfies Record<string, LiveSettingDefinition>);

export type LiveSettingKey = keyof typeof LIVE_SETTINGS & keyof AppConfig;
export type LiveSettingValue = boolean | string;

export const LIVE_SETTING_KEYS = Object.freeze(Object.keys(LIVE_SETTINGS)) as readonly LiveSettingKey[];

export function isLiveSettingKey(key: unknown): key is LiveSettingKey {
  return typeof key === "string" && Object.hasOwn(LIVE_SETTINGS, key);
}

export function liveSettingsPath(config: Pick<AppConfig, "dataDir">): string {
  return join(config.dataDir, "settings.json");
}

/** Null when the value is wrong for the setting. */
export function parseLiveSettingValue(key: LiveSettingKey, value: unknown): LiveSettingValue | null {
  const definition: LiveSettingDefinition = LIVE_SETTINGS[key];
  if (definition.kind === "boolean") return typeof value === "boolean" ? value : null;
  return typeof value === "string" && definition.values.includes(value) ? value : null;
}

export interface LiveSettingRow {
  readonly key: LiveSettingKey;
  readonly definition: LiveSettingDefinition;
  readonly value: LiveSettingValue;
  readonly defaultValue: LiveSettingValue;
  readonly saved: boolean;
}

export class LiveSettingsStore {
  readonly filePath: string;
  private values: Partial<Record<LiveSettingKey, LiveSettingValue>> = {};
  private readonly listeners: ((key: LiveSettingKey) => void)[] = [];
  private readonly onError: (message: string) => void;

  constructor(options: { readonly filePath: string; readonly onError?: (message: string) => void }) {
    this.filePath = options.filePath;
    this.onError = options.onError ?? ((message) => console.warn(`[brain] settings: ${message}`));
    this.values = this.load();
  }

  get(key: LiveSettingKey): LiveSettingValue | undefined {
    return this.values[key];
  }

  /** Saves one setting; throws when the value is wrong or the file cannot be written. */
  set(key: LiveSettingKey, value: unknown): LiveSettingValue {
    const parsed = parseLiveSettingValue(key, value);
    if (parsed === null) throw new Error(`invalid value for ${key}`);
    this.write({ ...this.values, [key]: parsed });
    this.notify(key);
    return parsed;
  }

  /** Back to the add-on option value. */
  reset(key: LiveSettingKey): void {
    if (!Object.hasOwn(this.values, key)) return;
    const next = { ...this.values };
    delete next[key];
    this.write(next);
    this.notify(key);
  }

  onChange(listener: (key: LiveSettingKey) => void): void {
    this.listeners.push(listener);
  }

  private notify(key: LiveSettingKey): void {
    for (const listener of this.listeners) {
      try {
        listener(key);
      } catch (error) {
        this.onError(`change listener failed: ${errorMessage(error)}`);
      }
    }
  }

  private load(): Partial<Record<LiveSettingKey, LiveSettingValue>> {
    if (!existsSync(this.filePath)) return {};
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      // A broken file must not take the assistant down: the options page values apply.
      this.onError(`${this.filePath} unreadable, using add-on options: ${errorMessage(error)}`);
      return {};
    }
    const settings = isRecord(raw) && isRecord(raw.settings) ? raw.settings : {};
    const values: Partial<Record<LiveSettingKey, LiveSettingValue>> = {};
    for (const [key, value] of Object.entries(settings)) {
      if (!isLiveSettingKey(key)) continue;
      const parsed = parseLiveSettingValue(key, value);
      if (parsed === null) {
        this.onError(`ignoring bad saved value for ${key}`);
        continue;
      }
      values[key] = parsed;
    }
    return values;
  }

  private write(values: Partial<Record<LiveSettingKey, LiveSettingValue>>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const body = { schemaVersion: LIVE_SETTINGS_SCHEMA_VERSION, settings: values };
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.filePath);
    this.values = values;
  }
}

/**
 * The config every part of the assistant holds, with each live setting read from the
 * store on every access. Everything else is the boot value. Code that copies
 * the config takes a snapshot, so long-lived holders keep this object.
 */
export function withLiveSettings(base: AppConfig, store: LiveSettingsStore): AppConfig {
  const config = { ...base } as Record<string, unknown>;
  for (const key of LIVE_SETTING_KEYS) {
    const fallback = base[key];
    Object.defineProperty(config, key, {
      enumerable: true,
      configurable: false,
      get: () => store.get(key) ?? fallback,
    });
  }
  // A Codex sign-in on the page counts at once, not after a restart.
  Object.defineProperty(config, "hasCodexAuth", {
    enumerable: true,
    configurable: false,
    get: () => base.modelBackend === "codex" && hasReadableCodexAuth(base.codexHome),
  });
  return Object.freeze(config) as unknown as AppConfig;
}

/** Rows for the dashboard: current value, the options-page default, and whether it was saved here. */
export function liveSettingRows(base: AppConfig, store: LiveSettingsStore): readonly LiveSettingRow[] {
  return LIVE_SETTING_KEYS.map((key) => {
    const saved = store.get(key);
    const defaultValue = base[key] as LiveSettingValue;
    return { key, definition: LIVE_SETTINGS[key], value: saved ?? defaultValue, defaultValue, saved: saved !== undefined };
  });
}
