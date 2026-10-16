/**
 * The shared vocabulary. Each word class is frozen data plus one
 * compiled pattern; recognisers read the class instead of keeping their own
 * copy, so a word counts the same everywhere. A named variant exists only
 * where call sites still need different members; what it adds or lacks
 * against the base is written beside it. Time words are owned by
 * `time-window-parser.ts` and speech fillers by `speech-normalizer.ts`; they
 * are exported from here.
 *
 * Patterns are `(?:...)` groups of whole words, longest first, for use
 * between word boundaries or anchors.
 */
import type { HaCapability } from "./ha-capability-index.js";
import { SPEECH_FILLER_TOKENS } from "./speech-normalizer.js";
import { escapeRegExp } from "./text-format.js";
import { MONTH_NAMES, WEEKDAY_NAMES } from "./time-window-parser.js";

export { MONTH_NAMES, SPEECH_FILLER_TOKENS, WEEKDAY_NAMES };

/** `(?:a|b|c)` over whole words and phrases, longest first so a phrase beats its prefix. */
export function wordPattern(words: readonly string[]): string {
  return `(?:${[...new Set(words)].sort((a, b) => b.length - a.length || a.localeCompare(b)).map(escapeRegExp).join("|")})`;
}

/** `\b(?:a|b|c)\b` over whole words. */
function wordRegExp(words: readonly string[]): RegExp {
  return new RegExp(`\\b${wordPattern(words)}\\b`);
}

function words(...groups: readonly (readonly string[])[]): readonly string[] {
  return Object.freeze([...new Set(groups.flat())]);
}

// --- Devices -----------------------------------------------------------------

interface DeviceNoun {
  readonly forms: readonly string[];
  /** HA domains an entity named by the noun may have. */
  readonly domains: readonly string[];
  /** `ha-capability-index` capabilities the noun implies, where one fits. */
  readonly capabilities: readonly HaCapability[];
  /** For a subtype of its domains (a lamp is a light): words in an entity's names that confirm it. */
  readonly evidence: readonly string[] | null;
}

const OPENABLE: readonly HaCapability[] = ["open", "close"];
const SWITCHED: readonly HaCapability[] = ["turn_on", "turn_off", "toggle"];
const PLAYER: readonly HaCapability[] = ["media_playback"];
const POWER_POINT = ["outlet", "outlets", "plug", "plugs", "socket", "sockets"];
const COVERING = ["blind", "blinds", "shade", "shades", "curtain", "curtains"];
const SENSED_OPENING = ["binary_sensor", "cover", "lock"];

function noun(forms: string, domains: readonly string[], capabilities: readonly HaCapability[], evidence: readonly string[] | true | null = null): DeviceNoun {
  const words = forms.split(",");
  return Object.freeze({
    forms: Object.freeze(words),
    domains: Object.freeze([...domains]),
    capabilities: Object.freeze([...capabilities]),
    evidence: evidence === true ? Object.freeze(words) : evidence && Object.freeze([...evidence]),
  });
}

/**
 * Device nouns by lexeme, in the order a descriptor is read ("lamp" before
 * "light", "media player" before "speaker").
 */
export const DEVICE_NOUNS = Object.freeze({
  lamp: noun("lamp,lamps", ["light"], [...SWITCHED, "brightness"], true),
  light: noun("light,lights,lighting", ["light"], [...SWITCHED, "brightness"]),
  outlet: noun("outlet,outlets", ["switch"], SWITCHED, POWER_POINT),
  plug: noun("plug,plugs", ["switch"], SWITCHED, POWER_POINT),
  socket: noun("socket,sockets", ["switch"], SWITCHED, POWER_POINT),
  switch: noun("switch,switches", ["switch"], SWITCHED),
  lock: noun("lock,locks", ["lock"], ["lock", "unlock"]),
  door: noun("door,doors", SENSED_OPENING, OPENABLE, true),
  gate: noun("gate,gates", SENSED_OPENING, OPENABLE, true),
  garage: noun("garage", SENSED_OPENING, OPENABLE, true),
  window: noun("window,windows", ["binary_sensor", "cover"], OPENABLE, true),
  blind: noun("blind,blinds", ["cover"], [...OPENABLE, "position"], COVERING),
  shade: noun("shade,shades", ["cover"], [...OPENABLE, "position"], COVERING),
  curtain: noun("curtain,curtains", ["cover"], [...OPENABLE, "position"], COVERING),
  cabinet: noun("cabinet,cabinets", ["cover", "light", "switch"], SWITCHED, true),
  heater: noun("heater,heaters", ["climate", "switch"], SWITCHED, true),
  fan: noun("fan,fans", ["fan"], [...SWITCHED, "fan_speed"]),
  vacuum: noun("vacuum,vacuums", ["vacuum"], []),
  computer: noun("computer,computers", ["switch"], SWITCHED, ["computer", "computers", "pc", "pcs", "workstation", "workstations"]),
  mediaPlayer: noun("media player,media players", ["media_player"], PLAYER),
  speaker: noun("speaker,speakers", ["media_player"], PLAYER, true),
  television: noun("television,televisions,tv,tvs", ["media_player"], PLAYER, true),
  sensor: noun("sensor,sensors,detector,detectors", ["sensor", "binary_sensor"], []),
  pump: noun("pump,pumps", ["switch"], SWITCHED),
  device: noun("device,devices", [], []),
});

type DeviceLexeme = keyof typeof DEVICE_NOUNS;

export interface DeviceDescriptor {
  readonly pattern: RegExp;
  readonly domains: readonly string[];
  readonly evidence: RegExp | null;
}

/** Descriptors of a contextual device reference ("those lamps"), in reading order. */
export const DEVICE_DESCRIPTORS: readonly DeviceDescriptor[] = Object.freeze(
  (["lamp", "light", "outlet", "plug", "socket", "switch", "lock", "door", "gate", "garage", "window", "blind", "shade",
    "curtain", "cabinet", "heater", "fan", "vacuum", "computer", "mediaPlayer", "speaker", "television"] as const)
    .map((lexeme) => {
      const entry = DEVICE_NOUNS[lexeme];
      return Object.freeze({
        pattern: wordRegExp(entry.forms),
        domains: entry.domains,
        evidence: entry.evidence && wordRegExp(entry.evidence),
      });
    }),
);

function deviceWords(lexemes: readonly DeviceLexeme[], form: "all" | "plural" = "all"): readonly string[] {
  return words(...lexemes.map((lexeme) => {
    const forms = DEVICE_NOUNS[lexeme].forms;
    return form === "all" ? forms : forms.filter((word) => word.endsWith("s") && word !== "lighting");
  }));
}

/** Heads of a device status question ("is the garage door open?", "office lights"). */
export const DEVICE_STATUS_PATTERN = wordPattern(deviceWords([
  "light", "lamp", "lock", "sensor", "switch", "door", "window", "gate", "garage",
  "pump", "heater", "fan", "outlet", "plug", "socket", "vacuum", "computer",
]));

/** Objects of a control command: the status heads with cabinets and "device", without sensors, pumps, plugs or sockets. */
export const DEVICE_CONTROL_PATTERN = wordPattern(deviceWords([
  "light", "lamp", "cabinet", "outlet", "switch", "lock", "door", "window", "gate", "garage",
  "heater", "fan", "vacuum", "computer", "device",
]));

/** Devices an action can name: the control objects plus coverings and media players. */
export const DEVICE_ACTION_PATTERN = wordPattern(deviceWords([
  "light", "lamp", "cabinet", "outlet", "switch", "lock", "door", "window", "blind", "shade", "curtain",
  "gate", "garage", "heater", "fan", "vacuum", "computer", "mediaPlayer", "speaker", "television", "device",
]));

/** Plural heads that make a reference a set ("the lights", "those ones"). */
export const DEVICE_PLURAL_PATTERN = wordPattern(words(["ones", "things"], deviceWords([
  "light", "lamp", "cabinet", "outlet", "plug", "socket", "switch", "lock", "door", "window", "blind", "shade",
  "curtain", "gate", "heater", "fan", "vacuum", "computer", "mediaPlayer", "speaker", "television", "device",
], "plural")));
export const DEVICE_PLURAL_WORD = new RegExp(`\\b${DEVICE_PLURAL_PATTERN}\\b`);

// --- Readings and measures ---------------------------------------------------

/** Sensor readings a place can be asked about. */
export const READING_PATTERN = wordPattern(["temperature", "temp", "humidity"]);

/** Comparisons against a number ("above 20", "colder than 10"). */
export const COMPARATOR_PATTERN = wordPattern(["below", "under", "less than", "colder than", "above", "over", "greater than", "warmer than"]);
export const COMPARATOR_WORD = new RegExp(`\\b${COMPARATOR_PATTERN}\\b`);

/** Measures that make a status target a power reading rather than a device. */
const POWER_READING_PATTERN = wordPattern([
  "watt", "watts", "kw", "kwh", "draw", "drawing", "usage", "using", "consumption", "generation", "output", "total", "average",
]);
export const POWER_READING_WORD = new RegExp(`\\b${POWER_READING_PATTERN}\\b`);

/** Load words of a power question: base power words plus the verbs "use" and "draw". */
export const POWER_LOAD_PATTERN = wordPattern(["power", "energy", "usage", "use", "load", "loads", "drawing", "draw"]);
export const POWER_LOAD_WORD = new RegExp(`\\b${POWER_LOAD_PATTERN}\\b`);

/** "Use" and "consume" in every form. */
const POWER_USE_PATTERN = wordPattern([
  "use", "uses", "used", "using", "usage", "consume", "consumes", "consumed", "consuming", "consumption",
]);
export const POWER_USE_WORD = new RegExp(`\\b${POWER_USE_PATTERN}\\b`);

/**
 * State words a status question can ask for, in precedence order: the first
 * one present wins ("is the disconnected sensor on?" asks for disconnected).
 */
const STATE_WORDS = ["disconnected", "connected", "unlocked", "locked", "disabled", "enabled", "disarmed", "armed",
  "detected", "inactive", "active", "closed", "clear", "open", "running", "off", "on"]
  .map((word) => [word, new RegExp(`\\b${word}\\b`)] as const);

export function firstStateWord(normalized: string): string | null {
  return STATE_WORDS.find(([, pattern]) => pattern.test(normalized))?.[0] ?? null;
}

/**
 * Every predicate word a status question may end on: the state words plus the
 * spoken ones status grammar maps onto them (secure, shut, dark, lit, out, triggered).
 */
export const STATUS_STATE_PATTERN = "(?:disconnected|connected|unlocked|locked|disabled|enabled|disarmed|armed|detected|triggered|inactive|active|closed|clear|open|running|secure|shut|dark|lit|out|off|on)";

// --- Weather, time and place ---------------------------------------------------

/** Words that make a question about the weather. */
const WEATHER_PATTERN = wordPattern([
  "weather", "forecast", "condition", "conditions", "temperature", "temp", "rain", "raining", "rainfall", "humidity", "humid",
  "wind", "windy", "cold", "chilly", "cool", "warm", "hot", "gross", "wet", "dry", "cloudy", "shower", "showers", "storm",
]);
export const WEATHER_WORD = new RegExp(`\\b${WEATHER_PATTERN}\\b`);

/** The present moment as a qualifier. */
export const NOW_PATTERN = wordPattern(["right now", "now", "currently", "at the moment"]);

/** Days a calendar question names. */
export const CALENDAR_DAY_PATTERN = wordPattern(["today", "tomorrow", "tonight", "this week", "next week", "weekend", ...WEEKDAY_NAMES]);
export const CALENDAR_DAY_WORD = new RegExp(`\\b${CALENDAR_DAY_PATTERN}\\b`);

/** Any weekday name. */
export const WEEKDAY_PATTERN = wordPattern(WEEKDAY_NAMES);

/** Places that put a reading indoors rather than outside: inside, the rooms people name. */
const INDOOR_SCOPE_PATTERN = wordPattern([
  "inside", "indoor", "indoors", "bedroom", "office", "kitchen", "lounge", "laundry", "bathroom", "hallway", "garage", "pergola", "room",
]);
export const INDOOR_SCOPE_WORD = new RegExp(`\\b${INDOOR_SCOPE_PATTERN}\\b`);

/** Inside and outside as places. */
export const INDOOR_PATTERN = wordPattern(["inside", "indoor", "indoors"]);
export const OUTDOOR_PATTERN = wordPattern(["outside", "outdoor", "outdoors"]);

// --- Discourse -----------------------------------------------------------------

/** Wh-words and the auxiliaries that open a question. */
export const QUESTION_LEAD_PATTERN = wordPattern([
  "what", "which", "who", "when", "where", "why", "how",
  "is", "are", "was", "were", "do", "does", "did", "has", "have", "can", "could", "would", "will", "should",
]);

/** The speaker and the assistant as words: whatever they own or say anchors a question to this house and chat. */
export const PARTICIPANT_PATTERN = wordPattern(["i", "me", "my", "mine", "we", "us", "our", "ours", "you", "your", "yours"]);

/** Subject pronouns: followed by more words, they start a clause ("something you'd like to work on"), which no device name holds. */
export const SUBJECT_PRONOUN_PATTERN = wordPattern(["i", "we", "you", "they", "he", "she"]);

/** Determiners that point at one known thing ("the oven", "this sensor"), not a kind. */
export const DEFINITE_DETERMINER_PATTERN = wordPattern(["the", "this", "that", "these", "those", "his", "her", "their"]);

/** Politeness that adds nothing to a request. */
export const POLITENESS_PATTERN = wordPattern(["please", "thanks", "thank you", "cheers", "ta", "mate"]);

/** Openers of an elliptical follow-up ("what about inside?", "and the garage?"). */
export const FOLLOW_UP_OPENER_PATTERN = wordPattern(["what about", "how about", "and"]);

// Longest content a "... too" / "... As well" follow-up fragment may carry ("will I need an umbrella too").
export const FOLLOW_UP_FRAGMENT_MAX_WORDS = 6;

/**
 * Words a bare time follow-up may carry besides its window ("was last week
 * higher?", "yesterday then?", "same again for last week"): auxiliaries,
 * prepositions, connectives and comparisons. Any other word is a subject of
 * the turn's own ("was the doorbell pressed last week").
 */
export const WINDOW_FOLLOW_UP_WORD = new RegExp(`^${wordPattern([
  "is", "are", "was", "were", "do", "does", "did",
  "the", "a", "an", "for", "in", "on", "at", "over", "during", "from", "since",
  "and", "or", "so", "then", "too", "also", "again", "same", "as", "well",
  "higher", "lower", "more", "less", "than", "please", "ok", "okay",
])}$`);

/** Markers that the speaker is repairing the conversation rather than asking afresh. */
export const REPAIR_MARKER_PATTERN = wordPattern([
  "i did not ask", "i didn t ask", "didn t ask", "not what", "what i asked", "i meant", "was asking",
  "wasn t talking about", "was not talking about", "should have understood", "why did you", "why would you",
  "nothing to do", "doesn t match", "does not match", "not about", "not another", "not repeat", "don t answer",
  "do not answer", "answer with", "your mistake", "that mistake", "your answer", "that answer", "you were wrong",
  "you got it wrong", "you got that wrong", "incorrect answer",
]);

/**
 * Status filler: time-now words, hedges and politeness a status target never
 * contains. Each is replaced by a space, in this order, before whitespace is
 * collapsed.
 */
export function stripStatusFiller(value: string): string {
  return value
    .replace(/\bright now\b/g, " ")
    .replace(/\bnow\b/g, " ")
    .replace(/\bat the moment\b/g, " ")
    .replace(/\bcurrently\b/g, " ")
    .replace(/\bactually\b/g, " ")
    .replace(/\bdefinitely\b/g, " ")
    .replace(/\bstill\b/g, " ")
    .replace(/\byet\b/g, " ")
    .replace(/\bsitting\b/g, " ")
    .replace(/\bplease\b/g, " ")
    .replace(/\b(?:thanks|thank you|cheers|ta|mate)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Tags ----------------------------------------------------------------------

export type LexiconTag =
  | "device"
  | "reading"
  | "measure"
  | "weather"
  | "time"
  | "place"
  | "repair"
  | "question"
  | "politeness"
  | "follow_up";

const DEVICE_ANY_PATTERN = wordPattern(Object.values(DEVICE_NOUNS).flatMap((entry) => entry.forms));
const MEASURE_PATTERN = wordPattern([
  "power", "energy", "electricity", "usage", "consumption", "draw", "drawing", "load", "watt", "watts", "wattage",
  "kw", "kwh", "kilowatt", "kilowatts", "solar", "grid", "battery",
]);
const TIME_WORD_PATTERN = wordPattern([
  "now", "right now", "currently", "at the moment", "today", "tonight", "tomorrow", "yesterday", "morning",
  "afternoon", "evening", "night", "week", "weekend", "month", "year", "earlier", "later", "ago", ...WEEKDAY_NAMES,
]);

const TAG_TESTS: readonly (readonly [LexiconTag, RegExp])[] = [
  ["device", new RegExp(`\\b${DEVICE_ANY_PATTERN}\\b`)],
  ["reading", new RegExp(`\\b${READING_PATTERN}\\b`)],
  ["measure", new RegExp(`\\b${MEASURE_PATTERN}\\b`)],
  ["weather", new RegExp(`\\b${WEATHER_PATTERN}\\b`)],
  ["time", new RegExp(`\\b(?:${TIME_WORD_PATTERN}|${wordPattern(MONTH_NAMES)})\\b`)],
  ["place", new RegExp(`\\b(?:${INDOOR_PATTERN}|${OUTDOOR_PATTERN}|house|home)\\b`)],
  ["repair", new RegExp(`\\b${REPAIR_MARKER_PATTERN}\\b`)],
  ["question", new RegExp(`^${QUESTION_LEAD_PATTERN}\\b`)],
  ["politeness", new RegExp(`\\b${POLITENESS_PATTERN}\\b`)],
  ["follow_up", new RegExp(`^(?:${FOLLOW_UP_OPENER_PATTERN}|same for)\\b`)],
];

/** Which word classes occur in normalised text, in a fixed order. */
export function lexiconTags(normalized: string): readonly LexiconTag[] {
  return Object.freeze(TAG_TESTS.filter(([, pattern]) => pattern.test(normalized)).map(([tag]) => tag));
}
