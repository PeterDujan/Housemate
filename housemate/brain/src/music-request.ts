/**
 * Music command words: what was asked, never how it is
 * done. `music-control.ts` checks and runs it on the speaker's own Music
 * Assistant player.
 *
 * Intent, not set phrases: each command is a verb family
 * with an optional object ("next", "next song", "play the next one", "skip it",
 * "move on"), so the natural variants of a phrasing parse, not only the words
 * once heard. Code only: none of it reaches the model.
 */
import { normalizeMeasuredRoutingText as normalize } from "./routing-text.js";
import { houseConfig } from "./house-config.js";
import { householdRegex } from "./household.js";

export type MusicPlayQuery =
  | { readonly kind: "station"; readonly station: "personal" | "discovery" }
  | { readonly kind: "sound"; readonly name: string; readonly path: string }
  | { readonly kind: "favourites" }
  | { readonly kind: "playlist"; readonly name: string }
  | { readonly kind: "album"; readonly name: string; readonly artist: string | null }
  | { readonly kind: "search"; readonly title: string; readonly artist: string | null };

export type MusicCommand =
  | { readonly kind: "play"; readonly query: MusicPlayQuery; readonly enqueue: "replace" | "next" | "add"; readonly room: string | null }
  | { readonly kind: "different_version" }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "stop" }
  | { readonly kind: "next" }
  | { readonly kind: "previous" }
  | { readonly kind: "restart" }
  | { readonly kind: "seek"; readonly seconds: number }
  | { readonly kind: "volume"; readonly level: number }
  | { readonly kind: "volume_ask" }
  | { readonly kind: "volume_step"; readonly step: number }
  | { readonly kind: "mute"; readonly on: boolean }
  | { readonly kind: "shuffle"; readonly on: boolean }
  | { readonly kind: "repeat"; readonly mode: "one" | "all" | "off" }
  | { readonly kind: "like" }
  | { readonly kind: "add_to_playlist"; readonly playlist: string }
  | { readonly kind: "now_playing"; readonly ask: "track" | "artist" | "album" }
  | { readonly kind: "move"; readonly room: string };

export interface MusicRequest {
  readonly command: MusicCommand;
  /**
   * Bare words ("stop", "next", "what's this?") that are music only while the
   * speaker's player has something on; otherwise another owner has them.
   */
  readonly needsActivePlayer: boolean;
  /**
   * The words only became music through a speaker's sound-alike ("place X by Y"
   * heard for "play X by Y"): a search that finds nothing leaves the turn to the
   * other owners rather than saying so.
   */
  readonly heardAlike?: boolean;
}

/** What the claim knows about where the words came from. */
export interface MusicParseContext {
  /** From a speaker with a music player: its sound-alikes apply. */
  readonly fromSpeaker: boolean;
  /** That player has something on (playing or paused). */
  readonly active: boolean;
  /** The assistant just asked "What volume?" in this conversation. */
  readonly volumeAsked: boolean;
}

const NO_CONTEXT: MusicParseContext = { fromSpeaker: false, active: false, volumeAsked: false };

export const VOLUME_STEP = 0.1;
export const VOLUME_BIG_STEP = 0.3;

const OBJ = String.raw`(?:music|song|songs|track|tune|tunes|number|playback|record)`;
const DET = String.raw`(?:the |this |that |my |our )?`;
const IT = String.raw`(?:it|this|that|this one|that one|${DET}${OBJ})`;
const START = String.raw`(?:start|beginning|top)`;
const UNIT_WORDS: Readonly<Record<string, number>> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100,
};

/**
 * Words STT heard for "play" over music (live "place", "plate",
 * "played", "my"). Taken as "play" only from a speaker, and only when the rest
 * is plainly a music request (see `heardAsPlay`).
 */
const PLAY_ALIKES = /^(?:place|plays|played|plate|plane|pray|lay|clay|blay|plague|plain|my) /;
/** Words that make a sound-alike a music request with nothing playing. */
const NAMES_MUSIC = /\b(?:song|songs|theme|track|tune|album|music|playlist|sounds)\b/;
/** Sound-alikes STT gave over music, tried only when the words heard parse as nothing. */
const SPEAKER_ALIKES: readonly (readonly [RegExp, string])[] = [
  [/\b(?:solving|soft|son|sung)$/, "song"],
  [/\bwider$/, "quieter"],
  // Heard over loud music: "Floss the song.", "slot", "spot music."
  [/^(?:floss|flaws|paws|pores|pours|porz|pulse)\b/, "pause"],
  [/^(?:slot|spot|stopped|stops|stomp|stock)\b/, "stop"],
];

/**
 * `transcript` keeps the spoken casing for titles; `normalized` is its routing
 * text. `isRoom` says whether words after "in"/"on" name a room or speaker.
 */
export function parseMusicRequest(
  transcript: string,
  normalized: string,
  isRoom: (text: string) => boolean,
  context: MusicParseContext = NO_CONTEXT,
): MusicRequest | null {
  const n = trimCourtesy(normalized);
  if (!n) {
    return null;
  }
  const heard = parseCommand(n, context) ?? parsePlay(trimCourtesy(transcript, true), n, isRoom);
  if (heard || !context.fromSpeaker) {
    return heard;
  }
  // "A lot wider" with nothing on is not worth turning the speaker down for.
  for (const [alike, word] of context.active ? SPEAKER_ALIKES : []) {
    if (alike.test(n)) {
      const fixed = parseCommand(n.replace(alike, word), context);
      if (fixed) {
        return { ...fixed, heardAlike: true };
      }
    }
  }
  return heardAsPlay(transcript, n, isRoom, context);
}

function parseCommand(n: string, context: MusicParseContext): MusicRequest | null {
  return parseTransport(n, context)
    ?? parseSeek(n)
    ?? parseVolume(n, context)
    ?? parseModes(n)
    ?? parseLikes(n)
    ?? parseNowPlaying(n)
    ?? parseMove(n);
}

/**
 * "Place Yellow by Coldplay", "played the previous song": a play-alike
 * first word is "play" when what follows is a transport word, a music object,
 * an "X by Y", or two or more words while music is on.
 */
function heardAsPlay(transcript: string, n: string, isRoom: (text: string) => boolean, context: MusicParseContext): MusicRequest | null {
  if (!PLAY_ALIKES.test(n)) {
    return null;
  }
  const rest = n.replace(PLAY_ALIKES, "");
  const asPlay = `play ${rest}`;
  const command = parseTransport(asPlay, context);
  if (command) {
    return { ...command, needsActivePlayer: false, heardAlike: true };
  }
  const spokenRest = trimCourtesy(transcript, true).replace(/^\S+\s+/, "");
  const play = parsePlay(`play ${spokenRest}`, asPlay, isRoom);
  if (play?.command.kind !== "play") {
    return null;
  }
  const query = play.command.query;
  const plain = query.kind === "search" && query.artist === null;
  const enoughWords = rest.split(" ").length >= 2 && !n.startsWith("my ") && (context.active || NAMES_MUSIC.test(rest));
  return !plain || enoughWords ? { ...play, heardAlike: true } : null;
}

/**
 * What can stand in front of a music command: a filler ("I mean,", "no,"), or the wake word as STT
 * kept it, in any order.
 */
const leadIn = (): RegExp => householdRegex(String.raw`^(?:(?:i mean|i said|sorry|actually|um+|uh+|er+)[,.]?\s+|(?:(?:hey|hi|hay|a|my|ok|okay),? )?{ASSISTANT_HEARD}(?:'s)?[,.]?\s+|(?:my|hey|hi) jobs?(?: is| was| has)?(?: to)?[,.]?\s+)`, "i");

function trimCourtesy(text: string, keepCase = false): string {
  let cleaned = keepCase ? text.trim().replace(/[.!?]+$/, "") : text;
  for (let lead = cleaned.match(leadIn()); lead && lead[0].length < cleaned.length; lead = cleaned.match(leadIn())) {
    cleaned = cleaned.slice(lead[0].length);
  }
  return cleaned
    .replace(/^(?:can you |could you |would you |will you |please |just |now )+/i, "")
    .replace(householdRegex(String.raw`(?:,?\s+(?:please|thanks|thank you|mate|{ASSISTANT}|now))+$`, "i"), "")
    .trim();
}

function music(command: MusicCommand, needsActivePlayer = false): MusicRequest {
  return { command, needsActivePlayer };
}

function parseTransport(n: string, context: MusicParseContext): MusicRequest | null {
  const hasObject = new RegExp(`\\b${OBJ}\\b`).test(n);
  // Next: any next/skip/move-on word, with or without "song", "play" or not.
  if (new RegExp(`^(?:(?:play|go to|skip to|jump to|move on to|move to|give me|put on|on to|onto) )?(?:the )?next(?: one| ${OBJ})?$`).test(n)) {
    return music({ kind: "next" }, /^(?:the )?next(?: one)?$/.test(n));
  }
  if (new RegExp(`^skip(?: ${IT})?(?: one)?$|^skip (?:ahead |forward )?to (?:the )?next(?: one| ${OBJ})?$`).test(n)) {
    return music({ kind: "next" }, !hasObject);
  }
  if (new RegExp(`^(?:move on|next please|(?:change|switch) (?:the |this )?${OBJ}|(?:play )?(?:something else|another (?:song|track|tune|one)|a different (?:song|track|tune)))$`).test(n)) {
    return music({ kind: "next" }, !n.startsWith("play ") && !hasObject);
  }
  // Previous: previous/last/the one before, or back a song.
  if (new RegExp(`^(?:(?:play|go to|go back to|back to|skip back to|jump back to|put on) )?(?:the )?(?:previous|last|one before)(?: one| ${OBJ})?(?: again)?$`).test(n)) {
    return music({ kind: "previous" }, /^(?:the )?(?:previous|last|one before)(?: one)?$/.test(n));
  }
  if (new RegExp(`^(?:go |skip |jump )?back(?: a| one)? (?:song|track|tune)$|^back one$|^go back$`).test(n)) {
    return music({ kind: "previous" }, !hasObject);
  }
  // From the start: any restart verb, a few words, then from/to the start.
  if (new RegExp(`^(?:play|start|restart|replay|rewind|go back|skip back|jump back|back|take it back|begin|put it)(?: \\S+){0,3} (?:from|to|at) (?:the )?(?:very )?${START}(?: of (?:the |this )?(?:song|track|tune))?$`).test(n)
    || new RegExp(`^from the (?:very )?${START}$|^back to the ${START}$|^start (?:it|this|that) (?:again|over)$|^start (?:over|again)$`).test(n)) {
    return music({ kind: "restart" }, !hasObject);
  }
  if (new RegExp(`^(?:restart|replay|rewind)(?: ${IT})?$|^play (?:it|this|that|${DET}(?:song|track|tune)) again$|^start (?:this|the) (?:song|track|tune)(?: again| over)?$|^(?:this|the) (?:song|track) again$`).test(n)) {
    return music({ kind: "restart" }, !hasObject && !/ again$/.test(n));
  }
  // Pause.
  if (new RegExp(`^pause(?: ${IT})?(?: for a (?:sec|second|bit|minute|moment))?$|^(?:hold|freeze) ${IT}$|^put (?:it|this|${DET}${OBJ}) on (?:pause|hold)$|^pause (?:playback|playing)$`).test(n)) {
    return music({ kind: "pause" }, !hasObject);
  }
  // Stop: explicit music objects only, so "turn it off" stays with the devices.
  if (/^stop(?: it| this| that)?$|^that s enough$/.test(n)) return music({ kind: "stop" }, true);
  if (new RegExp(`^(?:stop|kill|end|cut)(?: playing)? ${DET}${OBJ}$|^stop playing$|^(?:turn|switch|shut) off ${DET}${OBJ}$|^(?:turn|switch|shut) ${DET}${OBJ} off$|^(?:music|songs?) off$|^no more music$|^that s enough music$`).test(n)) {
    return music({ kind: "stop" });
  }
  // Resume.
  if (/^(?:resume|continue|unpause|keep playing|carry on|play|play it|start|start it|back on)$/.test(n)) {
    return music({ kind: "resume" }, true);
  }
  if (new RegExp(`^(?:resume|continue|unpause|keep playing|carry on with) ${IT}(?: again)?$|^(?:resume|continue) (?:playing|playback)$|^(?:play|start) ${DET}${OBJ} again$|^(?:turn|put|switch) ${DET}${OBJ} back on$`).test(n)) {
    return music({ kind: "resume" });
  }
  // "Continue tune", "continue chewed": a resume word and one more while music is on.
  if (context.fromSpeaker && context.active && /^(?:resume|continue|unpause) \S+$/.test(n)) {
    return music({ kind: "resume" }, true);
  }
  return null;
}

function parseSeek(n: string): MusicRequest | null {
  const verb = String.raw`(rewind|go back|skip back|jump back|move back|back up|back|fast forward|skip ahead|skip forward|go forward|move forward|jump ahead|jump forward|forward|skip)`;
  const unit = String.raw`(seconds?|secs?|minutes?|mins?)`;
  const lead = new RegExp(`^${verb}(?: (?:it|the song|this song|the track))?(?: by)? (.+?)(?: ${unit})?$`).exec(n);
  const tail = new RegExp(`^(.+?) ${unit} (back|backwards?|forward|forwards|ahead)$`).exec(n);
  const verbWord = lead?.[1] ?? tail?.[3] ?? "";
  const amountText = lead?.[2] ?? tail?.[1] ?? "";
  const unitWord = lead?.[3] ?? tail?.[2] ?? "";
  if (!lead && !tail) {
    return null;
  }
  const amount = numberWords(amountText);
  // A small bare number is not a seek ("go back one" is the previous song, "skip two" a count).
  if (amount === null || amount <= 0 || (!unitWord && amount < 5)) {
    return null;
  }
  // No unit is seconds: STT often ends the turn before "seconds".
  const seconds = unitWord.startsWith("min") ? amount * 60 : amount;
  const backwards = /^(?:rewind|go back|skip back|jump back|move back|back up|back|backwards?)$/.test(verbWord);
  return music({ kind: "seek", seconds: backwards ? -seconds : seconds });
}

function numberWords(text: string): number | null {
  if (/^\d{1,4}$/.test(text)) {
    return Number(text);
  }
  if (text === "half a" || text === "half") {
    return 0.5;
  }
  const words = text.replace(/-/g, " ").replace(/\band\b/g, " ").split(" ").filter(Boolean);
  if (words.length === 0) {
    return null;
  }
  let total = 0;
  for (const word of words) {
    const value = UNIT_WORDS[word];
    if (value === undefined) {
      return null;
    }
    total = value === 100 ? Math.max(1, total) * 100 : total + value;
  }
  return total;
}

const VOLUME_UP = new Set(["louder", "up", "increase", "raise", "boost", "higher", "crank", "pump"]);
const VOLUME_DOWN = new Set(["quieter", "softer", "down", "lower", "decrease", "reduce", "quiet"]);
const VOLUME_BIG = /\b(?:a lot|lots|much|way|heaps|loads|a heap|a fair bit|heaps more|way more)\b/;
const VOLUME_FILLER = new Set([
  "make", "turn", "it", "the", "music", "volume", "song", "sound", "a", "bit", "little", "tad", "touch", "slightly",
  "more", "can", "you", "this", "go", "get", "put", "things", "lot", "lots", "much", "way", "heaps", "loads", "fair",
  "notch", "notches", "level", "heap", "that",
]);

function parseVolume(n: string, context: MusicParseContext): MusicRequest | null {
  const level = /^(?:set |put |change )?(?:the )?volume (?:to |at |on )?(.+?)(?: percent| per cent)?$|^(?:turn|set|put) (?:it|the volume|the music) (?:up |down )?to (.+?)(?: percent| per cent)?$|^(.+?) (?:percent|per cent) volume$/.exec(n);
  if (level) {
    const value = numberWords(level[1] ?? level[2] ?? level[3] ?? "");
    if (value !== null) {
      return volumeLevel(value, /percent|per cent/.test(n));
    }
  }
  if (/^(?:full|max|maximum) volume$|^volume (?:all the way up|to (?:the )?max(?:imum)?)$/.test(n)) return music({ kind: "volume", level: 1 });
  if (/^half volume$/.test(n)) return music({ kind: "volume", level: 0.5 });
  // Cut short after "set volume to": ask, and the next words give the level.
  if (/^(?:set |change |put )?(?:the )?volume(?: to| at)?$/.test(n) && n !== "volume") return music({ kind: "volume_ask" });
  if (context.volumeAsked) {
    const bare = /^(?:to )?(.+?)(?: percent| per cent)?$/.exec(n);
    const value = bare ? numberWords(bare[1] ?? "") : null;
    if (value !== null) {
      return volumeLevel(value, /percent|per cent/.test(n));
    }
  }
  if (/^(?:it is |that is |this is )?(?:way |a bit |much )?too loud$/.test(n)) return music({ kind: "volume_step", step: -VOLUME_STEP }, true);
  if (/^(?:(?:it is |that is |this is )?(?:way |a bit |much )?too (?:quiet|soft)|i (?:cannot|can not) hear (?:it|the music|this))$/.test(n)) return music({ kind: "volume_step", step: VOLUME_STEP }, true);
  const step = volumeStep(n);
  if (step !== null) {
    // Without a music word, "turn it up" could be the heating: only with music on.
    return music({ kind: "volume_step", step }, !/\b(?:music|volume|song|sound|louder|quieter|softer)\b/.test(n));
  }
  if (/^mute(?: it| the music| the volume| the sound)?$/.test(n)) return music({ kind: "mute", on: true }, n === "mute it");
  if (/^unmute(?: it| the music| the volume| the sound)?$/.test(n)) return music({ kind: "mute", on: false });
  return null;
}

function volumeLevel(value: number, percentWord: boolean): MusicRequest | null {
  const percent = percentWord || value > 10;
  if (value < 0 || (percent && value > 100)) {
    return null;
  }
  return music({ kind: "volume", level: percent ? value / 100 : value / 10 });
}

/** Any up/down word with only volume words around it: "make the music a lot quieter", "turn it up a bit". */
function volumeStep(n: string): number | null {
  const words = n.split(" ");
  const up = words.some((word) => VOLUME_UP.has(word));
  const down = words.some((word) => VOLUME_DOWN.has(word));
  if (up === down) {
    return null;
  }
  if (!words.every((word) => VOLUME_UP.has(word) || VOLUME_DOWN.has(word) || VOLUME_FILLER.has(word))) {
    return null;
  }
  // "Up" or "down" alone, or with only "it", is too thin to be the volume.
  if (!/\b(?:louder|quieter|softer|volume|music|sound|song|turn|crank|pump)\b/.test(n)) {
    return null;
  }
  const size = VOLUME_BIG.test(n) ? VOLUME_BIG_STEP : VOLUME_STEP;
  return up ? size : -size;
}

function parseModes(n: string): MusicRequest | null {
  if (/^(?:shuffle(?: on| mode on)?|turn (?:on )?shuffle(?: on)?|shuffle (?:it|this|the music|the songs|my music|the playlist)|put it on shuffle|mix it up)$/.test(n)) return music({ kind: "shuffle", on: true });
  if (/^(?:shuffle off|shuffle mode off|turn (?:off )?shuffle(?: off)?|stop shuffling|no shuffle|unshuffle|don t shuffle)$/.test(n)) return music({ kind: "shuffle", on: false });
  if (/^(?:repeat (?:this|the|that) (?:song|track|one)|repeat one|put (?:this|the) (?:song|track) on repeat|loop (?:this|the|it)(?: song| track)?|on repeat)$/.test(n)) return music({ kind: "repeat", mode: "one" });
  if (/^(?:repeat (?:on|all)|repeat mode on|turn (?:on )?repeat(?: on)?|repeat (?:the|this) (?:playlist|album|queue)|put it on repeat)$/.test(n)) return music({ kind: "repeat", mode: "all" });
  if (/^(?:repeat off|repeat mode off|turn (?:off )?repeat(?: off)?|stop repeating|no repeat|don t repeat)$/.test(n)) return music({ kind: "repeat", mode: "off" });
  return null;
}

function parseLikes(n: string): MusicRequest | null {
  if (/^i (?:like|love) (?:this|it)$/.test(n)) return music({ kind: "like" }, true);
  if (/^(?:i (?:like|love)|like|love|favourite|favorite|save) (?:this|that) (?:song|track)$|^(?:favourite|favorite) (?:this|it)$|^add (?:this|it|this song|this track) to (?:my )?(?:favourites|favorites|liked songs)$/.test(n)) {
    return music({ kind: "like" });
  }
  const playlist = /^add (?:this|it|this song|this track) to (?:my |the )?((?:\S+ ){0,4}\S+)$/.exec(n);
  const name = playlist?.[1]?.replace(/ playlist$/, "");
  if (name && !/\bqueue\b/.test(name)) {
    return music({ kind: "add_to_playlist", playlist: name });
  }
  return null;
}

function parseNowPlaying(n: string): MusicRequest | null {
  const SONG = String.raw`(?:song|track|tune)`;
  if (new RegExp(`^(?:what|which) ${SONG} is (?:this|that|playing|on)$|^what is (?:this|that|the) ${SONG}(?: called)?$|^what is the name of (?:this|that|the) ${SONG}$|^(?:name|identify) (?:this|that|the) ${SONG}$|^what am i listening to$|^what is playing$|^what is this ${SONG} called$`).test(n)) {
    return music({ kind: "now_playing", ask: "track" });
  }
  if (/^what is (?:this|on|that)(?: called)?$/.test(n)) return music({ kind: "now_playing", ask: "track" }, true);
  if (new RegExp(`^who (?:sings|is singing|sang|performs) (?:this|this ${SONG}|that|that ${SONG}|it)$|^who is singing$|^who is (?:this|that|the|this ${SONG}|the ${SONG}) by$|^(?:what|which) (?:band|artist|singer) is (?:this|that|it|playing)$|^who is the (?:band|artist|singer)$|^who sings it$`).test(n)) {
    return music({ kind: "now_playing", ask: "artist" });
  }
  if (/^who is (?:this|that)$/.test(n)) return music({ kind: "now_playing", ask: "artist" }, true);
  if (new RegExp(`^(?:what|which) album is (?:this|this ${SONG}|that|it)(?: from| on)?$|^(?:what|which) album is (?:this|it|this ${SONG}) (?:from|on)$`).test(n)) {
    return music({ kind: "now_playing", ask: "album" });
  }
  return null;
}

function parseMove(n: string): MusicRequest | null {
  const match = /^(?:move|send|take|transfer) (?:the music|this|it|the song|my music) (?:to|into) (?:the )?(.+)$/.exec(n);
  return match?.[1] ? music({ kind: "move", room: match[1] }) : null;
}

function parsePlay(transcript: string, n: string, isRoom: (text: string) => boolean): MusicRequest | null {
  if (looksLikeDifferentVersion(n)) {
    return music({ kind: "different_version" });
  }
  const queued = /^(?:add|put) (.+?) (?:to|on|in) (?:the )?queue$|^queue(?: up)? (.+)$/i.exec(transcript);
  if (queued) {
    const words = (queued[1] ?? queued[2] ?? "").trim();
    // A title, not a sentence ("add it to the queue, and just tell them...").
    if (/,/.test(words) || words.split(/\s+/).length > 8 || /^(?:it|this|that)$/i.test(words)) {
      return null;
    }
    const query = words ? playQuery(words) : null;
    return query ? music({ kind: "play", query, enqueue: "add", room: null }) : null;
  }
  if (!/^(?:play|put on|start playing|play me|put me on|chuck on|throw on)\b/.test(n)) {
    return null;
  }
  let rest = transcript.replace(/^(?:play me|put me on|play|put on|start playing|chuck on|throw on)\s*/i, "").trim();
  if (!rest) {
    return null;
  }
  let room: string | null = null;
  const roomMatch = /\s+(?:on|in|through|to)\s+(?:the\s+)?(.+)$/i.exec(rest);
  const everywhere = /\s+(everywhere|in every room|on all (?:the )?speakers|all over the house)$/i.exec(rest);
  if (everywhere) {
    room = "everywhere";
    rest = rest.slice(0, everywhere.index).trim();
  } else if (roomMatch?.[1] && isRoom(roomMatch[1])) {
    room = roomMatch[1].trim();
    rest = rest.slice(0, roomMatch.index).trim();
  }
  let enqueue: "replace" | "next" = "replace";
  if (/\s+(?:next|after this(?: one| song)?)$/i.test(rest)) {
    enqueue = "next";
    rest = rest.replace(/\s+(?:next|after this(?: one| song)?)$/i, "").trim();
  }
  const query = playQuery(rest);
  return query ? music({ kind: "play", query, enqueue, room }) : null;
}

/** "play rain sounds": one of the house's own sound files, by its name (house.json `sounds`). */
function houseSound(n: string): readonly [string, string] | null {
  const sounds = houseConfig().sounds;
  // Speech-to-text writes "rain" as "ryan" or "reign", and "sounds" as "noises".
  const name = n.replace(/^(?:the|some) /, "").replace(/^(?:ryan|rein|reign|raine?)\b/, "rain").replace(/\bnoises?$/, "sounds");
  const file = sounds[name] ?? sounds[`${name} sounds`];
  return file ? [sounds[name] ? name : `${name} sounds`, file] : null;
}

function playQuery(words: string): MusicPlayQuery | null {
  const n = normalize(words);
  if (!n) {
    return null;
  }
  const sound = houseSound(n);
  if (sound) {
    return { kind: "sound", name: sound[0], path: sound[1] };
  }
  if (/^(?:some |a bit of |any )?(?:music|tunes|songs|something|anything|a song|some songs|my music|my station|my radio|something i like)$|^(?:my |the )?super ?mix$/.test(n)) {
    return { kind: "station", station: "personal" };
  }
  if (/^(?:something|some music|some songs|a song|songs|music|me something) (?:new|different|i haven t heard)$|^(?:some )?new (?:music|songs|stuff)$|^(?:the )?discovery station$|^(?:my |the )?discover(?:y)? mix$/.test(n)) {
    return { kind: "station", station: "discovery" };
  }
  if (/^(?:my |the )?(?:favourites|favorites|favourite songs|favorite songs|liked songs|loved songs|songs i like)$/.test(n)) {
    return { kind: "favourites" };
  }
  const playlist = /^(?:my |the )?(.+?) playlist$|^(?:my |the )?playlist (?:called )?(.+)$/i.exec(words.trim());
  if (playlist) {
    const name = (playlist[1] ?? playlist[2] ?? "").trim();
    return name ? { kind: "playlist", name } : null;
  }
  const album = /^(?:the )?album (?:called )?(.+?)(?:\s+by\s+(.+))?$|^(?:the )?(.+?) album(?:\s+by\s+(.+))?$/i.exec(words.trim());
  if (album) {
    const name = (album[1] ?? album[3] ?? "").trim();
    const artist = (album[2] ?? album[4] ?? "").trim() || null;
    return name ? { kind: "album", name, artist } : null;
  }
  const byArtist = /^(.+?)\s+by\s+(.+)$/i.exec(words.trim());
  const title = (byArtist ? byArtist[1] ?? "" : words).trim().replace(/^["'“‘]|["'”’]$/g, "");
  return title ? { kind: "search", title, artist: byArtist?.[2]?.trim() ?? null } : null;
}

export function looksLikeDifferentVersion(normalized: string): boolean {
  // "Another one" alone is the next song (`parseTransport`), and "tell me another one" is not music at all.
  return /\b(?:different|another|other)\s+(?:version|recording)\b/.test(normalized)
    || /^(?:play )?(?:a )?different one$/.test(normalized)
    || /\bnext\s+(?:version|recording)\b/.test(normalized);
}
