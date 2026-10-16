import { existsSync, readFileSync } from "node:fs";

import type { HaCommandClient } from "./ha-history.js";
import { optionalString, recordOrNull } from "./value-guards.js";

export const MUSIC_ASSISTANT_CONFIG_ENTRY_ID = "01KR16BVYD6PG2DRR6T75W787B";

export interface MusicAssistantSearchQuery {
  readonly name: string;
  readonly artist?: string | null;
  readonly limit?: number;
}

export interface MusicAssistantTrack {
  readonly uri: string;
  readonly name: string;
  readonly artist: string | null;
  readonly album: string | null;
  readonly albumVersion: string | null;
  readonly albumType: string | null;
  readonly albumYear: number | null;
  readonly albumBarcode: string | null;
  readonly version: string | null;
  readonly provider: string | null;
  readonly duration: number | null;
  readonly isrc: string | null;
}

export type MusicAssistantMediaType = "track" | "album" | "artist" | "playlist";
export type MusicAssistantEnqueue = "play" | "replace" | "next" | "add";

/** A search, library or browse hit that is not a track (or a track without its details). */
export interface MusicAssistantItem {
  readonly uri: string;
  readonly name: string;
  readonly mediaType: MusicAssistantMediaType;
  readonly artist: string | null;
}

export interface MusicAssistantSearchResult {
  readonly artists: readonly MusicAssistantItem[];
  readonly albums: readonly MusicAssistantItem[];
  readonly playlists: readonly MusicAssistantItem[];
}

export interface MusicAssistantPlayRequest {
  readonly targetEntityId: string;
  readonly mediaId: string | readonly string[];
  readonly mediaType: MusicAssistantMediaType;
  readonly enqueue: MusicAssistantEnqueue;
}

/** The media_player services the assistant may call on a Music Assistant player. */
export type MusicPlayerService =
  | "media_play"
  | "media_pause"
  | "media_stop"
  | "media_next_track"
  | "media_previous_track"
  | "media_seek"
  | "volume_set"
  | "volume_mute"
  | "shuffle_set"
  | "repeat_set"
  | "clear_playlist";

/**
 * A player call either finished inside its wait ("done") or is still running in
 * Home Assistant ("pending"): the assistant stops waiting, the call carries on, and the
 * caller checks the player instead.
 */
export type MusicCallOutcome = "done" | "pending";

/** What Music Assistant's queue for a player holds now. */
export interface MusicAssistantQueue {
  readonly queueId: string;
  readonly items: number;
  readonly currentIndex: number | null;
  readonly hasNext: boolean;
  readonly current: MusicAssistantItem | null;
}

/** Music Assistant (or YouTube Music behind it) did not answer in time. */
export class MusicAssistantTimeoutError extends Error {
  readonly stage: "search" | "queue" | "browse" | "api";

  constructor(stage: MusicAssistantTimeoutError["stage"], what: string) {
    super(`Music Assistant ${what} did not answer in time`);
    this.stage = stage;
  }
}

/**
 * Music Assistant as the assistant uses it: HA's own services for search, play and the
 * player, MA's API for what HA has no service for (browse, favourite, playlist
 * add, keep playing). The assistant keeps no copy of the queue or position.
 */
export interface MusicAssistantClient {
  searchTracks(query: MusicAssistantSearchQuery): Promise<readonly MusicAssistantTrack[]>;
  search(query: MusicAssistantSearchQuery): Promise<MusicAssistantSearchResult>;
  playMedia(request: MusicAssistantPlayRequest): Promise<MusicCallOutcome>;
  playerCommand(targetEntityId: string, service: MusicPlayerService, data?: Readonly<Record<string, unknown>>): Promise<MusicCallOutcome>;
  /** The player's queue, or null when it has none. */
  queue(targetEntityId: string): Promise<MusicAssistantQueue | null>;
  /** YouTube Music's own mix: My Supermix (personal) or Discover Mix (discovery); null when the account has none. */
  station(kind: MusicStation): Promise<MusicAssistantItem | null>;
  libraryPlaylists(): Promise<readonly MusicAssistantItem[]>;
  addFavourite(uri: string): Promise<void>;
  addToPlaylist(playlistUri: string, trackUri: string): Promise<void>;
  /** When the asked-for music runs out, Music Assistant carries on with similar music. */
  keepPlaying(queueId: string): Promise<void>;
}

export type MusicStation = "personal" | "discovery";

/**
 * YouTube Music's fixed ids for the account's own mixes (MA 2.10.5 `ytmusic`
 * YT_PERSONAL_PLAYLISTS).
 */
const YTM_MIXES: Readonly<Record<MusicStation, string>> = {
  personal: "RDTMAK5uy_kset8DisdE7LSD4TNjEVvrKRTmG7a56sY",
  discovery: "RDTMAK5uy_n_5IN6hzAOwdCnM8D8rzrs3vDl12UcZpA",
};

export interface MusicAssistantDetailsClient {
  enrichTracks(tracks: readonly MusicAssistantTrack[]): Promise<readonly MusicAssistantTrack[]>;
  command?(command: string, args: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<unknown>;
}

/** How long the assistant waits on each kind of call before answering from the player instead. */
export const MUSIC_WAITS = {
  /** A player command (pause, next, volume...): most finish in tens of milliseconds. */
  playerMs: 2_500,
  /** play_media: a refusal comes back at once; a song YouTube is still starting (about 7 s) is answered without it. */
  playMs: 1_500,
  /** A search or a queue read; a slow provider can hold these for a minute. */
  searchMs: 5_000,
  queueMs: 2_000,
} as const;

/** Enrich only the leading hits: every lookup is a call to the music service behind Music Assistant. */
const ENRICH_TOP = 5;
const DETAILS_RETRY_MS = 10 * 60_000;

/**
 * Small least-recently-used cache with an age limit. Searches, stations and
 * playlists change rarely, and every repeat saves a round trip to the music service.
 */
class TtlCache<V> {
  private readonly entries = new Map<string, { readonly value: V; readonly at: number }>();

  constructor(private readonly max: number, private readonly ttlMs: number, private readonly clock: () => number) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    this.entries.delete(key);
    if (this.clock() - entry.at > this.ttlMs) {
      return undefined;
    }
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, at: this.clock() });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }
}

/** A hit from the music service itself, not only the library's copy: Music Assistant drops a provider quietly when it is not answering. */
function fromProvider(uri: string): boolean {
  return !uri.startsWith("library://");
}

export class HaMusicAssistantService implements MusicAssistantClient {
  private readonly client: HaCommandClient;
  private readonly configEntryId: string;
  private readonly detailsClient: MusicAssistantDetailsClient | null;
  private readonly clock: () => number;
  private detailsRetryAt = 0;
  private readonly trackSearches: TtlCache<readonly MusicAssistantTrack[]>;
  private readonly searches: TtlCache<MusicAssistantSearchResult>;
  private readonly details: TtlCache<MusicAssistantTrack>;
  private readonly lists: TtlCache<readonly MusicAssistantItem[]>;
  private youTubeInstance: string | null = null;
  private readonly keptPlaying = new Set<string>();

  constructor(client: HaCommandClient, configEntryId = MUSIC_ASSISTANT_CONFIG_ENTRY_ID, detailsClient: MusicAssistantDetailsClient | null = null, clock: () => number = Date.now) {
    this.client = client;
    this.configEntryId = configEntryId;
    this.detailsClient = detailsClient;
    this.clock = clock;
    // Large allowance: searches a day, stations half a day, the library's playlists ten minutes.
    this.trackSearches = new TtlCache(1_000, 24 * 3_600_000, clock);
    this.searches = new TtlCache(1_000, 24 * 3_600_000, clock);
    this.details = new TtlCache(5_000, 7 * 24 * 3_600_000, clock);
    this.lists = new TtlCache(8, 10 * 60_000, clock);
  }

  async searchTracks(query: MusicAssistantSearchQuery): Promise<readonly MusicAssistantTrack[]> {
    const key = searchKey(query);
    const cached = this.trackSearches.get(key);
    if (cached) {
      return cached;
    }
    const response = await this.searchRaw(query, ["track"]);
    const tracks = await this.enrich(response ? parseMusicAssistantSearchResponse(response) : []);
    // Only an answer the music service took part in is kept: a library-only one may just mean it was not answering.
    if (tracks.some((track) => fromProvider(track.uri))) {
      this.trackSearches.set(key, tracks);
    }
    return tracks;
  }

  async search(query: MusicAssistantSearchQuery): Promise<MusicAssistantSearchResult> {
    const key = searchKey(query);
    const cached = this.searches.get(key);
    if (cached) {
      return cached;
    }
    const response = await this.searchRaw(query, ["artist", "album", "playlist"]);
    const root = serviceResponse(response);
    const result: MusicAssistantSearchResult = {
      artists: itemList(root?.artists, "artist"),
      albums: itemList(root?.albums, "album"),
      playlists: itemList(root?.playlists, "playlist"),
    };
    if ([...result.artists, ...result.albums, ...result.playlists].some((item) => fromProvider(item.uri))) {
      this.searches.set(key, result);
    }
    return result;
  }

  playMedia(request: MusicAssistantPlayRequest): Promise<MusicCallOutcome> {
    return this.within({
      type: "call_service",
      domain: "music_assistant",
      service: "play_media",
      service_data: {
        media_id: request.mediaId,
        media_type: request.mediaType,
        enqueue: request.enqueue,
      },
      target: { entity_id: [request.targetEntityId] },
    }, MUSIC_WAITS.playMs);
  }

  playerCommand(targetEntityId: string, service: MusicPlayerService, data: Readonly<Record<string, unknown>> = {}): Promise<MusicCallOutcome> {
    return this.within({
      type: "call_service",
      domain: "media_player",
      service,
      service_data: { ...data },
      target: { entity_id: [targetEntityId] },
    }, MUSIC_WAITS.playerMs);
  }

  async queue(targetEntityId: string): Promise<MusicAssistantQueue | null> {
    const response = await this.send({
      type: "call_service",
      domain: "music_assistant",
      service: "get_queue",
      service_data: {},
      target: { entity_id: [targetEntityId] },
      return_response: true,
    }, MUSIC_WAITS.queueMs, "queue");
    const queue = recordOrNull(serviceResponse(response)?.[targetEntityId]);
    if (!queue) {
      return null;
    }
    const current = recordOrNull(queue.current_item);
    const index = numberValue(queue.current_index);
    return {
      queueId: optionalString(queue.queue_id) ?? targetEntityId,
      items: numberValue(queue.items) ?? 0,
      currentIndex: index,
      hasNext: recordOrNull(queue.next_item) !== null,
      current: parseItem(current?.media_item, "track"),
    };
  }

  async station(kind: MusicStation): Promise<MusicAssistantItem | null> {
    const cached = this.lists.get(`station ${kind}`);
    if (cached) {
      return cached[0] ?? null;
    }
    const instance = await this.youTubeMusicInstance();
    if (!instance) {
      return null;
    }
    const result = await this.directCommand("music/playlists/get", { item_id: YTM_MIXES[kind], provider_instance_id_or_domain: instance }, MUSIC_WAITS.searchMs, "browse");
    const mix = parseItem(result, "playlist");
    if (mix) {
      this.lists.set(`station ${kind}`, [mix]);
    }
    return mix;
  }

  async libraryPlaylists(): Promise<readonly MusicAssistantItem[]> {
    const cached = this.lists.get("playlists");
    if (cached) {
      return cached;
    }
    const response = await this.send({
      type: "call_service",
      domain: "music_assistant",
      service: "get_library",
      service_data: { config_entry_id: this.configEntryId, media_type: "playlist", limit: 200 },
      return_response: true,
    }, MUSIC_WAITS.searchMs, "search");
    const playlists = itemList(serviceResponse(response)?.items, "playlist");
    this.lists.set("playlists", playlists);
    return playlists;
  }

  async addFavourite(uri: string): Promise<void> {
    await this.directCommand("music/favorites/add_item", { item: uri }, MUSIC_WAITS.searchMs, "api");
  }

  async addToPlaylist(playlistUri: string, trackUri: string): Promise<void> {
    const playlistId = /^library:\/\/playlist\/(.+)$/.exec(playlistUri)?.[1];
    if (!playlistId) {
      throw new Error(`not a library playlist: ${playlistUri}`);
    }
    await this.directCommand("music/playlists/add_playlist_tracks", { db_playlist_id: playlistId, uris: [trackUri] }, MUSIC_WAITS.searchMs, "api");
  }

  async keepPlaying(queueId: string): Promise<void> {
    if (this.keptPlaying.has(queueId)) {
      return;
    }
    await this.directCommand("player_queues/dont_stop_the_music", { queue_id: queueId, dont_stop_the_music_enabled: true }, MUSIC_WAITS.queueMs, "api");
    this.keptPlaying.add(queueId);
  }

  private async enrich(tracks: readonly MusicAssistantTrack[]): Promise<readonly MusicAssistantTrack[]> {
    const lead = tracks.slice(0, ENRICH_TOP).map((track) => this.details.get(track.uri) ?? track);
    const missing = lead.filter((track) => !this.details.get(track.uri));
    if (!this.detailsClient || missing.length === 0 || this.clock() < this.detailsRetryAt) {
      return [...lead, ...tracks.slice(ENRICH_TOP)];
    }
    try {
      const enriched = new Map((await this.detailsClient.enrichTracks(missing)).map((track) => [track.uri, track]));
      for (const track of enriched.values()) {
        this.details.set(track.uri, track);
      }
      return [...lead.map((track) => enriched.get(track.uri) ?? track), ...tracks.slice(ENRICH_TOP)];
    } catch {
      // Details only sharpen the ranking: carry on without them and try again later.
      this.detailsRetryAt = this.clock() + DETAILS_RETRY_MS;
      return [...lead, ...tracks.slice(ENRICH_TOP)];
    }
  }

  private async searchRaw(query: MusicAssistantSearchQuery, mediaTypes: readonly string[]): Promise<unknown> {
    const name = query.name.trim();
    if (!name) {
      return null;
    }
    return this.send({
      type: "call_service",
      domain: "music_assistant",
      service: "search",
      service_data: {
        config_entry_id: this.configEntryId,
        name,
        media_type: [...mediaTypes],
        limit: query.limit ?? 5,
        ...(query.artist?.trim() ? { artist: query.artist.trim() } : {}),
      },
      return_response: true,
    }, MUSIC_WAITS.searchMs, "search");
  }

  /**
   * One HA command with its own deadline. An abort only stops the assistant waiting;
   * unlike the client's own timeout it does not tear down the whole HA
   * connection.
   */
  private async send(command: Readonly<Record<string, unknown>>, waitMs: number, stage: MusicAssistantTimeoutError["stage"]): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), waitMs);
    try {
      return await this.client.sendCommand(command, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new MusicAssistantTimeoutError(stage, String(command.service ?? command.type));
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A player call that may outlast its wait: "pending" means HA is still on it. */
  private async within(command: Readonly<Record<string, unknown>>, waitMs: number): Promise<MusicCallOutcome> {
    try {
      await this.send(command, waitMs, "api");
      return "done";
    } catch (error) {
      if (error instanceof MusicAssistantTimeoutError) {
        return "pending";
      }
      throw error;
    }
  }

  /** The YouTube Music provider instance ("ytmusic--xxxx"); its mixes hang off it. */
  private async youTubeMusicInstance(): Promise<string | null> {
    if (this.youTubeInstance) {
      return this.youTubeInstance;
    }
    const result = await this.directCommand("music/browse", { path: "" }, MUSIC_WAITS.searchMs, "browse");
    const items = Array.isArray(result) ? result : recordOrNull(result)?.items;
    for (const item of Array.isArray(items) ? items : []) {
      const path = optionalString(recordOrNull(item)?.path) ?? optionalString(recordOrNull(item)?.uri) ?? "";
      const instance = /^(ytmusic--[^:]+):\/\//.exec(path)?.[1];
      if (instance) {
        this.youTubeInstance = instance;
        return instance;
      }
    }
    return null;
  }

  private async directCommand(command: string, args: Readonly<Record<string, unknown>>, timeoutMs: number, stage: MusicAssistantTimeoutError["stage"]): Promise<unknown> {
    if (!this.detailsClient?.command) {
      throw new Error("Music Assistant API is not configured");
    }
    try {
      return await this.detailsClient.command(command, args, timeoutMs);
    } catch (error) {
      if (error instanceof Error && / timed out$/.test(error.message)) {
        throw new MusicAssistantTimeoutError(stage, command);
      }
      throw error;
    }
  }
}

function searchKey(query: MusicAssistantSearchQuery): string {
  return JSON.stringify([query.name.trim().toLowerCase(), query.artist?.trim().toLowerCase() ?? "", query.limit ?? 5]);
}

interface MusicAssistantSocket {
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { readonly data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

export interface MusicAssistantDirectClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly socketFactory?: (url: string) => MusicAssistantSocket;
  readonly timeoutMs?: number;
}

export class MusicAssistantDirectClient implements MusicAssistantDetailsClient {
  private readonly wsUrl: string;
  private readonly token: string;
  private readonly socketFactory: (url: string) => MusicAssistantSocket;
  private readonly timeoutMs: number;

  constructor(options: MusicAssistantDirectClientOptions) {
    this.wsUrl = musicAssistantWebSocketUrl(options.baseUrl);
    this.token = options.token;
    this.socketFactory = options.socketFactory ?? defaultMusicAssistantSocketFactory;
    this.timeoutMs = options.timeoutMs ?? 750;
  }

  async enrichTracks(tracks: readonly MusicAssistantTrack[]): Promise<readonly MusicAssistantTrack[]> {
    const details = await this.fetchItemsByUri(tracks.map((track) => track.uri));
    return tracks.map((track) => {
      const detail = details.get(track.uri);
      return detail ? { ...track, ...detail } : track;
    });
  }

  /** One MA API command on its own connection: auth, the command, its result. */
  command(command: string, args: Readonly<Record<string, unknown>>, timeoutMs = this.timeoutMs): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = this.socketFactory(this.wsUrl);
      let settled = false;
      const settle = (error: Error | null, value?: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.close();
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };
      const timeout = setTimeout(() => settle(new Error(`Music Assistant ${command} timed out`)), timeoutMs);
      socket.addEventListener("message", (event) => {
        const message = parseJsonObject(event.data);
        if (!message) {
          return;
        }
        if (optionalString(message.server_id) && !optionalString(message.message_id)) {
          socket.send(JSON.stringify({ command: "auth", message_id: "1", args: { token: this.token } }));
          return;
        }
        if (message.error_code !== undefined) {
          settle(new Error(`Music Assistant ${command} failed: ${optionalString(message.details) ?? String(message.error_code)}`));
          return;
        }
        if (message.message_id === "1") {
          socket.send(JSON.stringify({ command, message_id: "2", args }));
        } else if (message.message_id === "2") {
          settle(null, message.result);
        }
      });
      socket.addEventListener("close", () => settle(new Error(`Music Assistant ${command} closed before completion`)));
      socket.addEventListener("error", () => settle(new Error(`Music Assistant ${command} failed`)));
    });
  }

  private fetchItemsByUri(uris: readonly string[]): Promise<Map<string, MusicAssistantTrack>> {
    return new Promise((resolve, reject) => {
      const socket = this.socketFactory(this.wsUrl);
      const details = new Map<string, MusicAssistantTrack>();
      const pending = new Set<number>();
      let commandId = 1;
      let uriIndex = 0;
      let authenticated = false;
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("Music Assistant detail lookup timed out"));
      }, this.timeoutMs);
      const finish = () => {
        if (!authenticated || pending.size > 0) {
          return;
        }
        clearTimeout(timeout);
        socket.close();
        resolve(details);
      };
      const sendCommand = (command: string, args: Record<string, unknown>) => {
        const messageId = commandId;
        commandId += 1;
        pending.add(messageId);
        socket.send(JSON.stringify({ command, message_id: String(messageId), args }));
      };
      const sendNextTrackLookup = () => {
        const uri = uris[uriIndex];
        uriIndex += 1;
        if (uri) {
          sendCommand("music/item_by_uri", { uri });
        }
      };
      socket.addEventListener("message", (event) => {
        const message = parseJsonObject(event.data);
        if (!message) {
          return;
        }
        if (optionalString(message.server_id) && !authenticated) {
          sendCommand("auth", { token: this.token });
          return;
        }
        const messageIdText = optionalString(message.message_id);
        const messageId = messageIdText ? Number(messageIdText) : NaN;
        if (!Number.isFinite(messageId)) {
          return;
        }
        pending.delete(messageId);
        if (messageId === 1 && recordOrNull(message.result)) {
          authenticated = true;
          sendNextTrackLookup();
          finish();
          return;
        }
        const track = parseTrack(message.result);
        if (track) {
          details.set(track.uri, track);
        }
        sendNextTrackLookup();
        finish();
      });
      socket.addEventListener("close", () => {
        clearTimeout(timeout);
        if (pending.size > 0) {
          reject(new Error("Music Assistant detail lookup closed before completion"));
        }
      });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Music Assistant detail lookup failed"));
      });
    });
  }
}

export function createMusicAssistantDirectClientFromHaConfig(
  configEntryId = MUSIC_ASSISTANT_CONFIG_ENTRY_ID,
  paths = musicAssistantConfigEntryPaths(),
): MusicAssistantDirectClient | null {
  for (const path of paths) {
    const config = readMusicAssistantConfigEntry(path, configEntryId);
    if (config) {
      return new MusicAssistantDirectClient(config);
    }
  }
  return null;
}

export function musicAssistantWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.toString();
}

export function parseMusicAssistantSearchResponse(response: unknown): readonly MusicAssistantTrack[] {
  const rawTracks = serviceResponse(response)?.tracks;
  if (!Array.isArray(rawTracks)) {
    return [];
  }
  return rawTracks.map(parseTrack).filter((track): track is MusicAssistantTrack => track !== null);
}

function serviceResponse(response: unknown): Record<string, unknown> | null {
  const root = recordOrNull(response);
  return root ? recordOrNull(root.response) ?? recordOrNull(root.service_response) ?? root : null;
}

function itemList(value: unknown, mediaType: MusicAssistantMediaType): readonly MusicAssistantItem[] {
  return Array.isArray(value) ? value.map((item) => parseItem(item, mediaType)).filter(isItem) : [];
}

function parseItem(value: unknown, fallbackType: MusicAssistantMediaType): MusicAssistantItem | null {
  const input = recordOrNull(value);
  const uri = optionalString(input?.uri);
  const name = optionalString(input?.name);
  if (!input || !uri || !name) {
    return null;
  }
  const type = optionalString(input.media_type);
  const mediaType = type === "track" || type === "album" || type === "artist" || type === "playlist" ? type : fallbackType;
  const artists = Array.isArray(input.artists) ? input.artists : [];
  return { uri, name, mediaType, artist: optionalString(recordOrNull(artists[0])?.name) };
}

function isItem(item: MusicAssistantItem | null): item is MusicAssistantItem {
  return item !== null;
}

function parseTrack(value: unknown): MusicAssistantTrack | null {
  const input = recordOrNull(value);
  const uri = optionalString(input?.uri);
  const name = optionalString(input?.name);
  if (!input || !uri || !name) {
    return null;
  }
  const artists = Array.isArray(input.artists) ? input.artists : [];
  const firstArtist = recordOrNull(artists[0]);
  const album = recordOrNull(input.album);
  const albumExternalIds = Array.isArray(album?.external_ids) ? album.external_ids : [];
  const externalIds = Array.isArray(input.external_ids) ? input.external_ids : [];
  return {
    uri,
    name,
    artist: optionalString(firstArtist?.name),
    album: optionalString(album?.name),
    albumVersion: optionalString(album?.version),
    albumType: optionalString(album?.album_type),
    albumYear: numberValue(album?.year),
    albumBarcode: externalIdValue(albumExternalIds, "barcode"),
    version: optionalString(input.version),
    provider: uri.includes("://") ? uri.slice(0, uri.indexOf("://")) : null,
    duration: numberValue(input.duration),
    isrc: externalIdValue(externalIds, "isrc"),
  };
}

function readMusicAssistantConfigEntry(path: string, entryId: string): MusicAssistantDirectClientOptions | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const entries = recordOrNull(recordOrNull(parsed)?.data)?.entries;
    if (!Array.isArray(entries)) {
      return null;
    }
    const entry = entries.find((candidate) => recordOrNull(candidate)?.entry_id === entryId);
    const data = recordOrNull(recordOrNull(entry)?.data);
    const baseUrl = optionalString(data?.url);
    const token = optionalString(data?.token);
    return baseUrl && token ? { baseUrl, token } : null;
  } catch {
    return null;
  }
}

function musicAssistantConfigEntryPaths(): readonly string[] {
  return [
    process.env.JARVIS_V5_MUSIC_ASSISTANT_CONFIG_ENTRIES_PATH,
    "/config/.storage/core.config_entries",
    "/homeassistant/.storage/core.config_entries",
  ].filter((path): path is string => Boolean(path));
}

function defaultMusicAssistantSocketFactory(url: string): MusicAssistantSocket {
  const Socket = globalThis.WebSocket as unknown as { new(url: string): MusicAssistantSocket } | undefined;
  if (!Socket) {
    throw new Error("WebSocket is not available in this runtime");
  }
  return new Socket(url);
}

function externalIdValue(values: readonly unknown[], key: string): string | null {
  for (const value of values) {
    if (Array.isArray(value) && value[0] === key) {
      return optionalString(value[1]);
    }
  }
  return null;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") {
    return recordOrNull(value);
  }
  try {
    return recordOrNull(JSON.parse(value));
  } catch {
    return null;
  }
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
