import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/*
 * Media apps: Plex, Radarr, Sonarr and Seerr come from the house's own
 * Home Assistant integrations for them (their address and key, read from HA's config entries) unless
 * the brain's config.json names them. The System page shows which is in use and can set its own;
 * the media catalogue is built at start, so a change waits for a restart.
 */

export type MediaApp = "plex" | "radarr" | "sonarr" | "seerr";

export interface MediaAppConnection {
  readonly url: string;
  readonly key: string | null;
}

export type MediaApps = Partial<Record<MediaApp, MediaAppConnection>>;

/** The config.json keys for each app. */
const CONFIG_KEYS: Readonly<Record<MediaApp, { readonly url: string; readonly key: string }>> = {
  plex: { url: "plexUrl", key: "plexToken" },
  radarr: { url: "radarrUrl", key: "radarrApiKey" },
  sonarr: { url: "sonarrUrl", key: "sonarrApiKey" },
  seerr: { url: "seerrUrl", key: "seerrApiKey" },
};

const APPS = Object.keys(CONFIG_KEYS) as MediaApp[];

export function haConfigDir(): string {
  return process.env.JARVIS_V5_HA_CONFIG_DIR?.trim() || "/homeassistant";
}

/** The media apps the house has set up in Home Assistant (enabled entries only). */
export function haMediaApps(dir: string = haConfigDir()): MediaApps {
  let entries: unknown[];
  try {
    const value = JSON.parse(readFileSync(join(dir, ".storage", "core.config_entries"), "utf8")) as { data?: { entries?: unknown[] } };
    entries = Array.isArray(value.data?.entries) ? value.data.entries : [];
  } catch {
    return {};
  }
  const found: MediaApps = {};
  for (const raw of entries) {
    const entry = record(raw);
    if (entry.disabled_by) continue;
    const data = record(entry.data);
    const connection = ((): [MediaApp, MediaAppConnection] | null => {
      switch (entry.domain) {
        case "plex": {
          const server = record(data.server_config);
          return text(server.url) && text(server.token) ? ["plex", { url: text(server.url) as string, key: text(server.token) }] : null;
        }
        case "radarr":
        case "sonarr":
          return text(data.url) && text(data.api_key) ? [entry.domain, { url: text(data.url) as string, key: text(data.api_key) }] : null;
        case "overseerr": {
          const host = text(data.host);
          const port = typeof data.port === "number" ? data.port : null;
          return host && text(data.api_key) ? ["seerr", { url: `${data.ssl === true ? "https" : "http"}://${host}${port ? `:${port}` : ""}`, key: text(data.api_key) }] : null;
        }
        default:
          return null;
      }
    })();
    if (connection && !found[connection[0]]) found[connection[0]] = { ...connection[1], url: connection[1].url.replace(/\/+$/, "") };
  }
  return found;
}

/** The config.json's own apps (an address set there). */
export function ownMediaApps(configFile: string): MediaApps {
  const value = readConfig(configFile);
  return Object.fromEntries(APPS.flatMap((app) => {
    const url = text(value[CONFIG_KEYS[app].url]);
    return url ? [[app, { url, key: text(value[CONFIG_KEYS[app].key]) }]] : [];
  }));
}

/** What the media catalogue uses: the house's own config.json, else Home Assistant's integration. */
export function mediaAppsInUse(configFile: string, dir: string = haConfigDir()): MediaApps {
  return { ...haMediaApps(dir), ...ownMediaApps(configFile) };
}

export interface MediaAppsBody {
  readonly ok: true;
  readonly apps: readonly { readonly app: MediaApp; readonly url: string | null; readonly hasKey: boolean; readonly source: "own" | "home_assistant" | "none" }[];
}

export function readMediaAppsForm(configFile: string, dir: string = haConfigDir()): MediaAppsBody {
  const own = ownMediaApps(configFile);
  const ha = haMediaApps(dir);
  return {
    ok: true,
    apps: APPS.map((app) => {
      const use = own[app] ?? ha[app] ?? null;
      return { app, url: use?.url ?? null, hasKey: Boolean(use?.key), source: own[app] ? "own" : ha[app] ? "home_assistant" : "none" };
    }),
  };
}

/**
 * A System page save for one app: an address (and a key, kept when left blank) of the house's own,
 * or an empty address to hand it back to Home Assistant's integration. Written whole (temp, rename).
 */
export function saveMediaAppForm(configFile: string, input: unknown, dir: string = haConfigDir()): MediaAppsBody & { readonly applied: "restart" } {
  const value = record(input);
  const app = value.app;
  if (typeof app !== "string" || !APPS.includes(app as MediaApp)) throw new Error("unknown media app");
  const keys = CONFIG_KEYS[app as MediaApp];
  const url = typeof value.url === "string" ? value.url.trim().replace(/\/+$/, "") : "";
  const key = typeof value.key === "string" ? value.key.trim() : "";
  if (url && !/^https?:\/\/[^\s/]+(?::\d+)?(?:\/\S*)?$/.test(url)) throw new Error("the address must look like http://192.168.1.10:7878");
  if (/[\s"\\]/.test(key)) throw new Error("that key has spaces or quotes in it");
  const config = readConfig(configFile);
  if (url) {
    config[keys.url] = url;
    if (key) config[keys.key] = key;
  } else {
    delete config[keys.url];
    delete config[keys.key];
  }
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(`${configFile}.tmp`, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${configFile}.tmp`, configFile);
  return { ...readMediaAppsForm(configFile, dir), applied: "restart" };
}

function readConfig(file: string): Record<string, unknown> {
  try {
    return record(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
