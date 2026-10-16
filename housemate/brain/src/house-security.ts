import type { HaEntityState } from "./ha-state-cache.js";
import type { HaIndexedEntity } from "./ha-registry-index.js";
import { capitalize, joinNatural } from "./text-format.js";
import { householdRegex } from "./household.js";

/*
 * Locked-up roll call: "is everything locked in
 * the house?" is answered by code from every live lock and every door,
 * garage-door and window sensor, read-only. Nothing is named in config: a new lock or door sensor
 * joins the roll call by its domain and device class alone.
 */

/** "all": is everything secure? "any": is anything left open or unlocked? */
export type SecurityRollCallForm = "all" | "any";

const ASK_LEAD = "(?:(?:do you know|can you tell me|could you tell me|can you check|could you check|tell me|check|let me know) (?:if |whether )?)?";
const EVERYTHING = "(?:everything|every door|all (?:of )?the doors|all doors|the doors|all (?:of )?the locks|the locks|the house|the place|we|it)(?: all)?";
const SECURE = "(?:all )?(?:locked(?: up)?|shut|closed(?: up)?|secure|secured|locked and (?:shut|closed)|(?:shut|closed) and locked)";
const ANYTHING = "(?:anything|any doors?|any of the doors|a door|any locks?|any windows?|the doors?)";
const INSECURE = "(?:unlocked|open|undone)";
// Embedded or statement order: "check if everything is locked", "everything's shut?".
const COPULA = "(?: (?:is|are|s))?";
const PLACE_TAIL = "(?: (?:in the house|at home|around the house|in here|at the house))?";
const TIME_TAIL = "(?: (?:right now|just now|at the moment|tonight|for the night|now|yet|then|mate))*";

const ALL_PATTERNS: readonly RegExp[] = [
  new RegExp(`^${ASK_LEAD}(?:(?:is|are) )?${EVERYTHING}${COPULA} ${SECURE}${PLACE_TAIL}${TIME_TAIL}$`),
];
const ANY_PATTERNS: readonly RegExp[] = [
  new RegExp(`^${ASK_LEAD}(?:(?:is|are) )?(?:there )?${ANYTHING}${COPULA} (?:left )?${INSECURE}${PLACE_TAIL}${TIME_TAIL}$`),
  new RegExp(`^${ASK_LEAD}(?:did|have) (?:i|we|you|anyone|somebody|someone) (?:left|leave) ${ANYTHING} ${INSECURE}${PLACE_TAIL}${TIME_TAIL}$`),
];

/** The roll-call form of a whole-utterance "is everything locked?" ask, else null. */
export function parseSecurityRollCall(normalized: string): SecurityRollCallForm | null {
  const text = normalized.trim().replace(/\s+/g, " ").replace(householdRegex(String.raw`^(?:(?:so|okay|ok|hey|{ASSISTANT}|and|right|now) )+`), "");
  if (!text) return null;
  if (ALL_PATTERNS.some((pattern) => pattern.test(text))) return "all";
  if (ANY_PATTERNS.some((pattern) => pattern.test(text))) return "any";
  return null;
}

export type SecurityRollCallResult = {
  readonly status: "ok" | "declined";
  readonly text: string;
  readonly notes: string;
  readonly sourceEntityIds: readonly string[];
};

type Reading = "secure" | "insecure" | "unknown";

const DOOR_CLASSES = new Set(["door", "garage_door", "window"]);

/** Live locks and door/garage-door/window sensors, the roll call's sources. */
export function securitySources(states: readonly HaEntityState[]): HaEntityState[] {
  return states
    .filter((state) => state.entityId.startsWith("lock.")
      || (state.entityId.startsWith("binary_sensor.") && DOOR_CLASSES.has(String(state.attributes.device_class ?? ""))))
    // Door sensors before locks, so a door reads "shut and locked".
    .sort((left, right) => Number(left.entityId.startsWith("lock.")) - Number(right.entityId.startsWith("lock."))
      || left.entityId.localeCompare(right.entityId));
}

export function securityRollCallAnswer(options: {
  readonly form: SecurityRollCallForm;
  readonly sources: readonly HaEntityState[];
  readonly registryEntity: (entityId: string) => HaIndexedEntity | null;
}): SecurityRollCallResult {
  const sourceEntityIds = options.sources.map((state) => state.entityId);
  // A door with a sensor and a lock (or a template lock over its sensor) is
  // one door: one line, insecure if either says so.
  const doors = new Map<string, { reading: Reading; phrases: string[] }>();
  for (const state of options.sources) {
    const name = spokenName(state, options.registryEntity(state.entityId));
    const reading = readingOf(state);
    const door = doors.get(name) ?? { reading: "secure" as Reading, phrases: [] };
    door.reading = worse(door.reading, reading);
    const phrase = statePhrase(state, reading);
    if (!door.phrases.includes(phrase)) door.phrases.push(phrase);
    doors.set(name, door);
  }
  const items = [...doors].map(([name, door]) => ({
    name,
    reading: door.reading,
    phrase: `${name} is ${joinNatural(door.phrases, "keep-ands-apart")}`,
  }));
  const insecure = items.filter((item) => item.reading === "insecure");
  const unknown = items.filter((item) => item.reading === "unknown");
  const secure = items.filter((item) => item.reading === "secure");
  const counts = `secure=${secure.length} insecure=${insecure.length} unknown=${unknown.length}`;
  if (items.length === 0 || unknown.length === items.length) {
    return {
      status: "declined",
      text: items.length === 0 ? "I can't see any locks or door sensors." : "I can't read the locks or doors just now.",
      notes: `security roll call: no readable lock or door state (${counts})`,
      sourceEntityIds,
    };
  }
  // Problems first, then what can't be read, then what is fine.
  const sentences = [
    ...(insecure.length > 0 ? [`${capitalize(joinNatural(insecure.map((item) => item.phrase), "keep-ands-apart"))}.`] : []),
    ...(unknown.length > 0 ? [`I can't read ${joinNatural(unknown.map((item) => item.name), "keep-ands-apart")}.`] : []),
    ...(secure.length > 0 ? [`${capitalize(joinNatural(secure.map((item) => item.phrase), "keep-ands-apart"))}.`] : []),
  ];
  const lead = insecure.length > 0
    ? options.form === "all" ? "No." : "Yes."
    : unknown.length > 0
      ? "Not that I can see."
      : options.form === "all" ? "Yes." : "No.";
  return {
    status: "ok",
    text: `${lead} ${sentences.join(" ")}`,
    notes: `security roll call (${options.form}) from live lock and door sensor state: ${counts}`,
    sourceEntityIds,
  };
}

function worse(left: Reading, right: Reading): Reading {
  if (left === "insecure" || right === "insecure") return "insecure";
  return left === "unknown" || right === "unknown" ? "unknown" : "secure";
}

function readingOf(state: HaEntityState): Reading {
  const value = state.state.trim().toLowerCase();
  if (state.entityId.startsWith("lock.")) {
    if (value === "locked") return "secure";
    return ["unlocked", "unlocking", "locking", "open", "opening", "jammed"].includes(value) ? "insecure" : "unknown";
  }
  if (value === "off") return "secure";
  return value === "on" ? "insecure" : "unknown";
}

function statePhrase(state: HaEntityState, reading: Reading): string {
  if (reading === "unknown") return "unreadable";
  if (state.entityId.startsWith("lock.")) {
    return state.state === "jammed" ? "jammed" : reading === "secure" ? "locked" : state.state === "open" ? "open" : "unlocked";
  }
  return reading === "secure" ? "shut" : "open";
}

/**
 * The entity's own name, not the device prefix HA glues on ("Front Door Lock
 * Front Door" is the lock entity "Front Door"), less a trailing sensor word.
 */
function spokenName(state: HaEntityState, entity: HaIndexedEntity | null): string {
  const friendly = typeof state.attributes.friendly_name === "string" ? state.attributes.friendly_name : "";
  const own = entity?.name ?? entity?.originalName ?? friendly;
  const name = (own || state.entityId.split(".")[1]?.replace(/_/g, " ") || state.entityId)
    .replace(/\s+(?:sensor|contact|lock)$/i, "")
    .trim()
    .toLowerCase();
  return `the ${name}`;
}
