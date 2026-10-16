/**
 * Music on the speaker you are
 * talking to. The speaker (Show now, ESP32 speaker later) is a Music
 * Assistant player; the assistant turns the words into one HA / Music Assistant call
 * on that player and keeps no copy of the queue or position. Done is silent
 * (the speaker's beep, the session ends so the music comes back up); he speaks
 * only when something fails or when asked. Anyone may use it, guests too, but
 * only from a speaker: evals, probes, typed chat and the Windows terminal get
 * the decline and never act.
 */
import { declined, ok, type BasicResult } from "./basic-brain-contracts.js";
import type { BasicBrainRouteServices } from "./basic-brain-services.js";
import { friendlyName, type HaEntityState } from "./ha-state-cache.js";
import { MusicAssistantTimeoutError, type MusicAssistantClient, type MusicAssistantItem, type MusicAssistantTrack, type MusicCallOutcome, type MusicPlayerService } from "./ha-music-assistant.js";
import { speakerPlayerFor } from "./house-discovery.js";
import type { MusicCommand, MusicPlayQuery } from "./music-request.js";
import { musicTrackLabel, nextDifferentMusicTrack, rankMusicTracks } from "./music-track-rank.js";
import { normalizeMeasuredRoutingText as normalize } from "./routing-text.js";
import { isAdmittedIntakeSource } from "./turn-source-trust.js";
import type { VoiceBrainRequest } from "./voice-brain.js";

const ROUTE = "music_playback";
const ACTIVE_STATES: ReadonlySet<string> = new Set(["playing", "paused", "buffering"]);

/**
 * Something is on: playing or paused. A Sendspin player reports a pause as with the track
 * still loaded, so idle with a queue
 * item counts too; a stop clears the queue and the item with it.
 */
function hasMusic(state: HaEntityState): boolean {
  return ACTIVE_STATES.has(state.state)
    || (state.state === "idle" && typeof state.attributes.media_content_id === "string" && state.attributes.media_content_id !== "");
}
const FAVOURITES_PLAYLISTS = ["all favorited tracks", "all favourited tracks", "favourite songs", "favorite songs"];
/** After a slow call, how long the assistant watches the player for the change before saying so. */
const SETTLE_MS = 3_000;
const SETTLE_POLL_MS = 150;

/**
 * "Set volume to..." cut short: the assistant asked "What volume?", and the next
 * words in that conversation give the level (live "fifty percent"
 * went to the calculator). RAM only, per conversation, 30 seconds.
 */
const VOLUME_ASK_MS = 30_000;
const volumeAsks = new Map<string, number>();

function askKey(request: VoiceBrainRequest): string | null {
  return request.sessionId ?? request.endpoint?.id ?? null;
}

export function volumeAskPending(request: VoiceBrainRequest, now: Date): boolean {
  const key = askKey(request);
  const at = key ? volumeAsks.get(key) : undefined;
  return at !== undefined && now.getTime() - at <= VOLUME_ASK_MS;
}

/** The speaker's Music Assistant player, when this turn may use it. */
export interface MusicPlayer {
  readonly entityId: string;
  readonly endpointId: string;
  readonly label: string;
}

type PlayerCheck = { readonly player: MusicPlayer } | { readonly refusal: BasicResult };

/** The player of the speaker the turn came from; pure (claims use it). */
export function speakerMusicPlayer(request: VoiceBrainRequest, routes: BasicBrainRouteServices): MusicPlayer | null {
  const endpoint = request.endpoint;
  // The speaker's own record names its player; an Assist speaker's comes from the House page.
  const mediaPlayer = endpoint ? endpoint.mediaPlayer ?? speakerPlayerFor(endpoint.id) : null;
  if (!endpoint || !mediaPlayer
    || request.channel !== "voice"
    || request.speaker.transportAuthenticated !== true
    || !isAdmittedIntakeSource({ channel: request.channel, sourceVia: request.sourceVia })) {
    return null;
  }
  const state = routes.stateCache?.get(mediaPlayer) ?? null;
  return {
    entityId: mediaPlayer,
    endpointId: endpoint.id,
    label: endpoint.name ?? (state ? friendlyName(state) : mediaPlayer),
  };
}

/** True while the speaker's player has something on (playing or paused, see `hasMusic`). */
export function speakerPlayerActive(request: VoiceBrainRequest, routes: BasicBrainRouteServices): boolean {
  const player = speakerMusicPlayer(request, routes);
  const state = player ? routes.stateCache?.get(player.entityId) ?? null : null;
  return state !== null && hasMusic(state);
}

/**
 * True while music is on at the speaker the turn came from: playing, or paused by
 * The voice host only for this request. No model calls then: over
 * music, what reaches chat is misheard commands. HA's mute flag is not trusted:
 * it stayed "muted" while a speaker played aloud.
 */
export function speakerMusicAudible(request: VoiceBrainRequest, routes: BasicBrainRouteServices): boolean {
  const player = speakerMusicPlayer(request, routes);
  const state = player ? routes.stateCache?.get(player.entityId) ?? null : null;
  return state?.state === "playing"
    || (state?.state === "paused" && request.endpoint?.musicPausedByTurn === true);
}

function checkPlayer(request: VoiceBrainRequest, routes: BasicBrainRouteServices): PlayerCheck {
  const player = speakerMusicPlayer(request, routes);
  if (!player) {
    return { refusal: spoken(declined(ROUTE, "Music only works from the speakers.", `music refused: no speaker endpoint (source=${request.sourceVia ?? "none"} endpoint=${request.endpoint?.id ?? "none"})`)) };
  }
  const registered = routes.registry?.entity(player.entityId) ?? null;
  if (registered?.platform !== "music_assistant") {
    return { refusal: spoken(declined(ROUTE, "That speaker isn't set up for music.", `music refused: ${player.entityId} is not a Music Assistant player (platform=${registered?.platform ?? "unknown"})`)) };
  }
  const state = routes.stateCache?.get(player.entityId);
  if (!state || state.state === "unavailable" || state.state === "unknown") {
    return { refusal: spoken(declined(ROUTE, `${player.label}'s music player is offline.`, `music refused: ${player.entityId} is ${state?.state ?? "missing"}`)) };
  }
  return { player };
}

export async function musicCommandAnswer(routes: BasicBrainRouteServices, request: VoiceBrainRequest, command: MusicCommand, now: () => Date, heardAlike = false): Promise<BasicResult | null> {
  const ma = routes.musicAssistant;
  if (!ma) {
    return spoken(declined(ROUTE, "Music Assistant isn't wired in yet.", "music requested without Music Assistant route service"));
  }
  const checked = checkPlayer(request, routes);
  if ("refusal" in checked) {
    return checked.refusal;
  }
  const { player } = checked;
  const key = askKey(request);
  if (key) {
    volumeAsks.delete(key);
  }
  const read = () => routes.stateCache?.get(player.entityId) ?? null;
  const started = performance.now();
  try {
    const result = await runCommand({ ma, player, read, now, heardAlike, askKey: key }, command);
    return result && { ...result, notes: `${result.notes} (${Math.round(performance.now() - started)} ms)` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const text = error instanceof MusicAssistantTimeoutError
      ? error.stage === "search" || error.stage === "browse" ? "The music service isn't answering right now. Try again in a minute." : "Music Assistant is slow to answer right now."
      : "Music Assistant didn't take that.";
    return spoken({
      route: ROUTE,
      status: "error",
      confidence: "medium",
      text,
      modelUsed: false,
      resultId: null,
      touchedEntities: [],
      notes: `music ${command.kind} error on ${player.entityId}: ${detail}`,
    });
  }
}

interface MusicRun {
  readonly ma: MusicAssistantClient;
  readonly player: MusicPlayer;
  readonly read: () => HaEntityState | null;
  readonly now: () => Date;
  readonly heardAlike: boolean;
  readonly askKey: string | null;
}

/** What the player shows once a command has taken: checked only when the call outlasted its wait. */
type Settled = (state: HaEntityState, before: HaEntityState) => boolean;

const changedTrack: Settled = (state, before) => state.attributes.media_content_id !== before.attributes.media_content_id
  || state.attributes.media_title !== before.attributes.media_title;
const movedPosition: Settled = (state, before) => state.attributes.media_position_updated_at !== before.attributes.media_position_updated_at
  || changedTrack(state, before);

/**
 * A call that outlasted its wait is still running in HA: watch the player for
 * its effect a little longer, then answer from what the player shows (the owner,
 * "send, then check the player"; no 15 s waits).
 */
async function settle(run: MusicRun, outcome: MusicCallOutcome, before: HaEntityState, took: Settled, startsTrack = false): Promise<boolean> {
  if (outcome === "done") {
    return true;
  }
  if (startsTrack) {
    watchLateStart(run, before, took);
    return true;
  }
  const deadline = performance.now() + SETTLE_MS;
  while (performance.now() < deadline) {
    const state = run.read();
    if (state && took(state, before)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
  return false;
}

/**
 * A streaming service can take several seconds to start a song (YouTube Music about 7 s), so a
 * call that starts a track and outlasted its wait is answered at once and the player is watched for
 * the start instead.
 */
const LATE_START_MS = 20_000;

function watchLateStart(run: MusicRun, before: HaEntityState, took: Settled, then?: () => void): void {
  void (async () => {
    const deadline = performance.now() + LATE_START_MS;
    while (performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const state = run.read();
      if (state && took(state, before)) {
        then?.();
        return;
      }
    }
    console.warn(`[brain] music: nothing new playing on ${run.player.entityId} ${LATE_START_MS / 1000} s after a call Music Assistant took`);
  })();
}

function slow(command: MusicCommand, player: MusicPlayer, service: string): BasicResult {
  return spoken({
    route: ROUTE,
    status: "error",
    confidence: "medium",
    text: "Music Assistant is slow to answer. It may still happen.",
    modelUsed: false,
    resultId: null,
    touchedEntities: [player.entityId],
    notes: `music ${command.kind} -> ${service} still pending on ${player.entityId} after the wait`,
  });
}

async function runCommand(run: MusicRun, command: MusicCommand): Promise<BasicResult | null> {
  const { ma, player } = run;
  const state = run.read() as HaEntityState;
  const active = hasMusic(state);
  const nothingOn = () => spoken(declined(ROUTE, "Nothing's playing.", `music ${command.kind}: ${player.entityId} is ${state.state}`));
  const call = async (service: MusicPlayerService, took: Settled, data?: Readonly<Record<string, unknown>>, text = "Done.") => {
    const outcome = await ma.playerCommand(player.entityId, service, data);
    if (!(await settle(run, outcome, state, took, took === changedTrack))) {
      return slow(command, player, `media_player.${service}`);
    }
    return done(player, text, `music ${command.kind} -> media_player.${service}${data ? ` ${JSON.stringify(data)}` : ""}${outcome === "pending" ? " (slow, then seen)" : ""}`);
  };
  switch (command.kind) {
    case "play":
      return playAnswer(run, state, command);
    case "different_version":
      return differentVersion(run, state, active);
    case "pause":
      // Paused by the voice host for this request already shows paused: it stays so (`musicAfter`).
      return active ? { ...(await call("media_pause", (now) => now.state !== "playing", undefined, "Paused.")), musicAfter: "hold" } : nothingOn();
    case "resume":
      return active ? call("media_play", (now) => now.state === "playing", undefined, "Playing.") : nothingOn();
    case "stop": {
      if (!active) return nothingOn();
      const outcome = await ma.playerCommand(player.entityId, "media_stop");
      if (!(await settle(run, outcome, state, (now) => now.state !== "playing"))) {
        return slow(command, player, "media_player.media_stop");
      }
      await ma.playerCommand(player.entityId, "clear_playlist");
      return { ...done(player, "Stopped.", "music stop -> media_player.media_stop + clear_playlist"), musicAfter: "hold" };
    }
    case "next": {
      if (!active) return nothingOn();
      // At the end of the queue Music Assistant hung on a skip: let it carry on with similar music first.
      const queue = await queueOrNull(ma, player);
      if (queue && !queue.hasNext) {
        await ma.keepPlaying(queue.queueId).catch(() => undefined);
      }
      return call("media_next_track", changedTrack, undefined, "Next song.");
    }
    case "previous": {
      if (!active) return nothingOn();
      // The first song has nothing before it, and Music Assistant hung on "previous" there: start it again instead.
      const queue = await queueOrNull(ma, player);
      if (queue && (queue.items <= 1 || queue.currentIndex === 0)) {
        return call("media_seek", movedPosition, { seek_position: 0 }, "From the top.");
      }
      return call("media_previous_track", changedTrack, undefined, "Previous song.");
    }
    case "restart":
      return active ? call("media_seek", movedPosition, { seek_position: 0 }, "From the top.") : nothingOn();
    case "seek": {
      if (!active) return nothingOn();
      const position = currentPosition(state, run.now());
      if (position === null) {
        return spoken(declined(ROUTE, "I can't tell where the song is up to.", `music seek: ${player.entityId} reports no position`));
      }
      const duration = numberAttribute(state, "media_duration");
      const target = Math.max(0, Math.min(position + command.seconds, duration !== null ? Math.max(0, duration - 1) : Number.POSITIVE_INFINITY));
      return call("media_seek", movedPosition, { seek_position: Math.round(target) });
    }
    case "volume": {
      const level = clampVolume(command.level);
      return call("volume_set", (now) => numberAttribute(now, "volume_level") === level, { volume_level: level });
    }
    case "volume_ask":
      if (run.askKey) {
        volumeAsks.set(run.askKey, run.now().getTime());
      }
      return { ...ok(ROUTE, "What volume?", `music volume asked on ${player.entityId}`), sessionDirective: "continue" };
    case "volume_step": {
      const current = numberAttribute(state, "volume_level");
      if (current === null) {
        return spoken(declined(ROUTE, "I can't read that speaker's volume.", `music volume step: ${player.entityId} reports no volume_level`));
      }
      const level = clampVolume(current + command.step);
      return call("volume_set", (now) => numberAttribute(now, "volume_level") === level, { volume_level: level });
    }
    case "mute":
      return call("volume_mute", (now) => now.attributes.is_volume_muted === command.on, { is_volume_muted: command.on });
    case "shuffle":
      return call("shuffle_set", (now) => now.attributes.shuffle === command.on, { shuffle: command.on });
    case "repeat":
      return call("repeat_set", (now) => now.attributes.repeat === command.mode, { repeat: command.mode });
    case "like": {
      const current = active ? (await queueOrNull(ma, player))?.current ?? null : null;
      if (!current) return nothingOn();
      await ma.addFavourite(current.uri);
      return done(player, "Liked.", `music like -> favourite ${current.uri}`);
    }
    case "add_to_playlist":
      return addToPlaylist(run, active, command.playlist);
    case "now_playing":
      return active ? nowPlaying(state, command.ask) : nothingOn();
    case "move":
      return spoken(declined(ROUTE, `${player.label} is the only music speaker so far.`, `music move to ${command.room} declined: one music endpoint`));
  }
}

/** The queue, or null when Music Assistant is too slow to say: the command goes ahead without it. */
async function queueOrNull(ma: MusicAssistantClient, player: MusicPlayer) {
  try {
    return await ma.queue(player.entityId);
  } catch (error) {
    if (error instanceof MusicAssistantTimeoutError) {
      return null;
    }
    throw error;
  }
}

async function playAnswer(run: MusicRun, before: HaEntityState, command: Extract<MusicCommand, { kind: "play" }>): Promise<BasicResult | null> {
  const { ma, player } = run;
  if (command.room && !sameSpeaker(command.room, player)) {
    return spoken(declined(ROUTE, `${player.label} is the only music speaker so far.`, `music play in ${command.room} declined: one music endpoint`));
  }
  const searchStarted = performance.now();
  const pick = await pickMedia(ma, command.query);
  const searchMs = Math.round(performance.now() - searchStarted);
  if (!pick) {
    // A sound-alike ("place X") that names nothing was not a music request after all.
    return run.heardAlike ? null : spoken(declined(ROUTE, `I couldn't find ${queryLabel(command.query)}.`, `music search found nothing for ${JSON.stringify(command.query)} (search ${searchMs} ms)`));
  }
  const playStarted = performance.now();
  const outcome = await ma.playMedia({ targetEntityId: player.entityId, mediaId: pick.item.uri, mediaType: pick.item.mediaType, enqueue: command.enqueue });
  const replacing = command.enqueue === "replace";
  const timing = `search ${searchMs} ms, play ${Math.round(performance.now() - playStarted)} ms${outcome === "pending" ? " (accepted, start watched)" : ""}`;
  // Queued music changes nothing to see; a replaced one shows up as the player playing something else.
  const started: Settled = (now, was) => now.state === "playing" && (was.state !== "playing" || changedTrack(now, was));
  if (replacing && outcome === "pending") {
    // A household sound (rain) is not followed by similar music.
    watchLateStart(run, before, started, () => void (command.query.kind !== "sound" && keepPlayingAfter(ma, player)));
  } else if (replacing) {
    if (!(await settle(run, outcome, before, started))) {
      return slow(command, player, `music_assistant.play_media ${pick.item.uri}`);
    }
    if (command.query.kind !== "sound") {
      void keepPlayingAfter(ma, player);
    }
  }
  const what = pick.item.artist && pick.item.mediaType !== "artist" ? `${pick.item.name} by ${pick.item.artist}` : pick.item.name;
  const verb = replacing ? "Now playing" : command.enqueue === "next" ? "Up next:" : "Queued";
  const notes = `music play ${pick.item.mediaType} ${pick.item.uri} enqueue=${command.enqueue} on ${player.entityId}; ${timing}`;
  const resultNotes = pick.libraryOnly ? `${notes}; library copy only${pick.version ? ` (${pick.version})` : ""}` : notes;
  // A new song is said ("Now playing X by Y"): it covers YouTube's few seconds of loading. Queueing
  // stays a beep.
  const result = replacing ? nowPlayingAnswer(player, `${verb} ${what}.`, resultNotes) : done(player, `${verb} ${what}.`, resultNotes);
  if (pick.item.mediaType !== "track") {
    return result;
  }
  const query = command.query.kind === "search" ? command.query : { title: pick.item.name, artist: pick.item.artist };
  return {
    ...result,
    ...(result.confirmBeep ? { speechPlan: { kind: "music_playback", track: pick.item.name, artist: pick.item.artist, endpoint: player.label } } : {}),
    contextFrame: {
      kind: "music_playback",
      request: { title: query.title, artist: query.artist, targetText: command.room },
      tracks: pick.tracks,
      selectedUri: pick.item.uri,
      endpointId: player.endpointId,
      endpointLabel: player.label,
    },
  };
}

/** Once per queue: when the asked-for music ends, Music Assistant carries on with similar music. */
async function keepPlayingAfter(ma: MusicAssistantClient, player: MusicPlayer): Promise<void> {
  try {
    const queue = await ma.queue(player.entityId);
    if (queue) {
      await ma.keepPlaying(queue.queueId);
    }
  } catch {
    // The music is already playing; carrying on after it is a nicety.
  }
}

interface MediaPick {
  readonly item: MusicAssistantItem;
  readonly tracks: readonly MusicAssistantTrack[];
  /** Only the library answered (the music service did not), so the choice may not be the recording asked for. */
  readonly libraryOnly?: boolean;
  /** The chosen recording's version ("Live at the Forum / 2023"), when it has one. */
  readonly version?: string | null;
}

/**
 * The music service's answer for the words: a band named exactly so (when it is in the
 * library, or no song has that exact title), else the best recording, else an
 * album or playlist of that name.
 */
async function pickMedia(ma: MusicAssistantClient, query: MusicPlayQuery): Promise<MediaPick | null> {
  switch (query.kind) {
    case "station": {
      const station = await ma.station(query.station);
      return station ? { item: station, tracks: [] } : null;
    }
    case "sound":
      return { item: { uri: query.path, name: query.name, mediaType: "track", artist: null }, tracks: [] };
    case "favourites": {
      const playlists = await ma.libraryPlaylists();
      const favourites = FAVOURITES_PLAYLISTS.map((name) => playlists.find((item) => normalize(item.name) === name)).find(Boolean);
      return favourites ? { item: favourites, tracks: [] } : null;
    }
    case "playlist": {
      const playlist = namedItem(await ma.libraryPlaylists(), query.name) ?? namedItem((await ma.search({ name: query.name, limit: 5 })).playlists, query.name, true);
      return playlist ? { item: playlist, tracks: [] } : null;
    }
    case "album": {
      const albums = (await ma.search({ name: query.name, artist: query.artist, limit: 5 })).albums;
      const album = namedItem(albums, query.name) ?? albums[0] ?? null;
      return album ? { item: album, tracks: [] } : null;
    }
    case "search": {
      const [tracks, others] = await Promise.all([
        ma.searchTracks({ name: query.title, artist: query.artist, limit: 10 }),
        query.artist ? Promise.resolve(null) : ma.search({ name: query.title, limit: 5 }),
      ]);
      const wanted = normalize(query.title);
      const band = others?.artists.find((item) => normalize(item.name) === wanted) ?? null;
      const ranked = rankMusicTracks(tracks, query);
      // A song title that is also an unknown band's name means the song; a band in the library wins.
      const exactSong = ranked.some((track) => normalize(track.name) === wanted);
      if (band && (band.uri.startsWith("library://") || !exactSong)) {
        return { item: band, tracks: [] };
      }
      const track = ranked[0];
      if (track) {
        const libraryOnly = tracks.every((candidate) => candidate.provider === "library");
        return { item: { uri: track.uri, name: track.name, mediaType: "track", artist: track.artist }, tracks: ranked, libraryOnly, version: track.version };
      }
      const named = namedItem(others?.albums ?? [], query.title) ?? namedItem(others?.playlists ?? [], query.title);
      return named ? { item: named, tracks: [] } : null;
    }
  }
}

async function differentVersion(run: MusicRun, before: HaEntityState, active: boolean): Promise<BasicResult> {
  const { ma, player } = run;
  const current = active ? (await queueOrNull(ma, player))?.current ?? null : null;
  if (!current || current.mediaType !== "track") {
    return spoken(declined(ROUTE, "Nothing's playing.", "music different version: no current track"));
  }
  const tracks = await ma.searchTracks({ name: current.name, artist: current.artist, limit: 10 });
  const ranked = rankMusicTracks(tracks, { title: current.name, artist: current.artist });
  const playing = ranked.find((track) => track.uri === current.uri) ?? null;
  const next = nextDifferentMusicTrack(ranked, current.uri, playing?.isrc ?? null);
  if (!next) {
    // Live with the music service not answering only the library's copy came back, and he said "the only version".
    const serviceAnswered = tracks.some((track) => track.provider !== "library");
    return spoken(declined(ROUTE, serviceAnswered ? "That's the only version I can find." : "The music service isn't answering, so I can't find another version right now.", `music different version exhausted for ${current.uri} (service answered: ${serviceAnswered})`));
  }
  const outcome = await ma.playMedia({ targetEntityId: player.entityId, mediaId: next.uri, mediaType: "track", enqueue: "replace" });
  if (!(await settle(run, outcome, before, changedTrack, true))) {
    return slow({ kind: "different_version" }, player, `music_assistant.play_media ${next.uri}`);
  }
  return nowPlayingAnswer(player, `Now playing ${musicTrackLabel(next)}.`, `music different version ${current.uri} -> ${next.uri}`);
}

async function addToPlaylist(run: MusicRun, active: boolean, name: string): Promise<BasicResult> {
  const { ma, player } = run;
  const current = active ? (await queueOrNull(ma, player))?.current ?? null : null;
  if (!current || current.mediaType !== "track") {
    return spoken(declined(ROUTE, "Nothing's playing.", "music add to playlist: no current track"));
  }
  const playlist = namedItem(await ma.libraryPlaylists(), name);
  if (!playlist) {
    return spoken(declined(ROUTE, `I can't find a playlist called ${name}.`, `music add to playlist: no library playlist matches ${name}`));
  }
  await ma.addToPlaylist(playlist.uri, current.uri);
  return done(player, `Added to ${playlist.name}.`, `music add ${current.uri} -> ${playlist.uri}`);
}

function nowPlaying(state: HaEntityState, ask: "track" | "artist" | "album"): BasicResult {
  const title = stringAttribute(state, "media_title");
  const artist = stringAttribute(state, "media_artist");
  const album = stringAttribute(state, "media_album_name");
  const text = ask === "artist" && artist ? `That's ${artist}.`
    : ask === "album" && album ? `It's from ${album}.`
      : title ? `That's ${title}${artist ? ` by ${artist}` : ""}.`
        : "I can't tell what's playing.";
  return spoken(ok(ROUTE, text, `music now playing read ${state.entityId} (${ask})`));
}

function done(player: MusicPlayer, text: string, notes: string): BasicResult {
  return {
    ...ok(ROUTE, text, notes),
    touchedEntities: [player.entityId],
    sessionDirective: "close",
    confirmBeep: true,
  };
}

/** A new song starting: said, the session ends, and the voice host leaves the new music be. */
function nowPlayingAnswer(player: MusicPlayer, text: string, notes: string): BasicResult {
  return { ...ok(ROUTE, text, notes), touchedEntities: [player.entityId], sessionDirective: "close", musicAfter: "hold" };
}

/** Spoken replies end the session too, so the music comes back up. */
function spoken(result: BasicResult): BasicResult {
  return { ...result, sessionDirective: "close" };
}

function namedItem(items: readonly MusicAssistantItem[], name: string, loose = false): MusicAssistantItem | null {
  const wanted = normalize(name).replace(/^(?:my|the) /, "");
  const exact = items.find((item) => normalize(item.name) === wanted);
  if (exact) {
    return exact;
  }
  const partial = items.filter((item) => normalize(item.name).includes(wanted));
  return partial.length === 1 || (loose && partial.length > 0) ? partial[0] ?? null : null;
}

function sameSpeaker(room: string, player: MusicPlayer): boolean {
  const wanted = normalize(room).replace(/^the /, "");
  return wanted === normalize(player.label) || wanted === "show" || wanted === "this speaker" || wanted === "here";
}

function queryLabel(query: MusicPlayQuery): string {
  switch (query.kind) {
    case "station":
      return query.station === "discovery" ? "your Discover Mix" : "your Supermix";
    case "sound":
      return query.name;
    case "favourites":
      return "your favourites";
    case "playlist":
      return `a playlist called ${query.name}`;
    case "album":
      return `the album ${query.name}`;
    case "search":
      return query.artist ? `${query.title} by ${query.artist}` : query.title;
  }
}

function currentPosition(state: HaEntityState, now: Date): number | null {
  const position = numberAttribute(state, "media_position");
  if (position === null) {
    return null;
  }
  const updatedAt = Date.parse(stringAttribute(state, "media_position_updated_at") ?? "");
  const elapsed = state.state === "playing" && Number.isFinite(updatedAt) ? Math.max(0, (now.getTime() - updatedAt) / 1000) : 0;
  return position + elapsed;
}

function clampVolume(level: number): number {
  return Math.round(Math.max(0, Math.min(1, level)) * 100) / 100;
}

function numberAttribute(state: HaEntityState, key: string): number | null {
  const value = state.attributes[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringAttribute(state: HaEntityState, key: string): string | null {
  const value = state.attributes[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
