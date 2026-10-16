/**
 * The spoken shapes of a vacuum request, parsed from the
 * routing core. Pure: it names one dashboard action and the settings the words
 * name; `vacuum-control.ts` decides whether to act and the vacuum's own queue
 * (`lif_vacuum_queue`) does the rest.
 *
 *   where's the vacuum up to? / what's the vacuum doing? / is the vacuum cleaning?
 *   Pause the vacuum / resume the vacuum / stop the vacuum / send the vacuum home / clear the vacuum's warning
 *   clean the kitchen / mop the kitchen twice / vacuum the lounge on turbo
 *   get the vacuum to clean the kitchen and the hallway / clean the whole house
 *
 * Rooms are the dashboard's: exact names only, plus his one
 * rule that "the lounge" means Lounge Room. "Robbie" is the vacuum.
 */
import { POLITENESS_PATTERN } from "./lexicon.js";
import { normalizeRoutingText } from "./routing-text.js";
import { householdRegex } from "./household.js";
import { assistantNamePattern } from "./persona.js";
import { houseConfig, vacuumName } from "./house-config.js";

/** A room on the dashboard: its name and Dreame segment id. */
export interface VacuumRoom {
  readonly name: string;
  readonly id: number;
  /** In the vacuum's own room list; a room can be on the map and still be off limits. */
  readonly allowed: boolean;
}

/** Only the settings the words name; the room's own settings fill the rest. */
export interface VacuumSettings {
  /** 0 vacuum, 1 mop, 2 vacuum and mop. */
  readonly mode?: number;
  /** 0 quiet, 1 standard, 2 strong, 3 turbo. */
  readonly suction?: number;
  /** 1 slightly dry, 2 moist, 3 wet. */
  readonly water?: number;
  readonly passes?: number;
}

export type VacuumRequest =
  | { readonly kind: "status" | "pause" | "resume" | "stop" | "clear_warning" | "start" }
  | { readonly kind: "rooms"; readonly rooms: readonly VacuumRoom[]; readonly settings: VacuumSettings }
  | { readonly kind: "house"; readonly settings: VacuumSettings }
  /** The vacuum was asked for by name or verb, but no dashboard room has that name. */
  | { readonly kind: "unknown_room"; readonly spoken: string };

/** What the vacuum is called besides its Assist aliases: the house's names for it (house.json), then the generic ones. */
const vacuumNames = (): string[] => [...houseConfig().vacuum.names, "the robot vacuum", "the vacuum cleaner", "the vacuum", "the robot"];

const TRAILING = new RegExp(String.raw`(?:\s+(?:${POLITENESS_PATTERN}|for me|${assistantNamePattern()}|now))+$`);
const leading = (): RegExp => householdRegex(String.raw`^(?:(?:hey|ok|okay)\s+)?{ASSISTANT}\s+`);

/** "Robbie clean the kitchen", "get Robbie to mop the hallway": the verb, and whether the vacuum was named. */
const VERB = "(clean|vacuum and mop|mop and vacuum|vacuum|hoover|mop|do)";
const VERB_MODE: Readonly<Record<string, number>> = { vacuum: 0, hoover: 0, mop: 1, "vacuum and mop": 2, "mop and vacuum": 2 };

const HOUSE = /^(?:the )?(?:whole |entire )?house$|^(?:everywhere|every room|all (?:the )?rooms|all)$/;

/** Settings named after the room, read from the end ("mop the kitchen twice on wet"). */
const MODIFIERS: readonly (readonly [RegExp, VacuumSettings])[] = [
  [/ (?:once|one pass)$/, { passes: 1 }],
  [/ (?:twice|two times|2 times|two passes|2 passes)$/, { passes: 2 }],
  [/ (?:three times|3 times|three passes|3 passes)$/, { passes: 3 }],
  [/ (?:on |at |with )?(?:turbo|max|maximum)(?: suction| power)?$/, { suction: 3 }],
  [/ (?:on |at |with )?strong(?: suction| power)?$/, { suction: 2 }],
  [/ (?:on |at |with )?standard(?: suction| power)?$/, { suction: 1 }],
  [/ (?:on |at |with )?quiet(?: suction| mode)?$| quietly$/, { suction: 0 }],
  [/ (?:on |with )?(?:a )?slightly dry(?: mop)?$/, { water: 1 }],
  [/ (?:on |with )?(?:a )?moist(?: mop)?$/, { water: 2 }],
  [/ (?:on |with )?(?:a )?wet(?: mop)?$/, { water: 3 }],
];

export function parseVacuumRequest(core: string, rooms: readonly VacuumRoom[], aliases: readonly string[] = []): VacuumRequest | null {
  const text = core.trim().replace(/[.!?,]+$/, "").replace(/\s+/g, " ").replace(leading(), "").replace(TRAILING, "");
  const n = nounPattern(aliases);
  const match = (pattern: string) => new RegExp(`^(?:${pattern})$`).test(text);

  if (
    match(`(?:where is|where s) ${n} (?:up to|at)`)
    || match(`what (?:is|s) ${n} (?:doing|up to)(?: right now| at the moment)?`)
    || match(`(?:is|has) ${n} (?:cleaning|running|going|working|busy|finished|done|home|docked|charging|stuck)(?: yet| right now| at the moment)?`)
    || match(`how (?:is|s) ${n} (?:going|doing|getting on)`)
    || match(`what (?:is|s) (?:in )?${n}(?: s)? queue`)
  ) return { kind: "status" };
  if (match(`${n} pause|pause (?:${n}|the cleaning|cleaning)`)) return { kind: "pause" };
  if (match(`${n} (?:resume|carry on|keep going|continue)|(?:resume|unpause|continue) (?:${n}|the cleaning|cleaning)|start ${n} (?:again|back up)|get ${n} going again`)) {
    return { kind: "resume" };
  }
  if (match(`${n} (?:stop|go home|go back to (?:the )?(?:dock|base))|(?:stop|cancel) (?:${n}|the cleaning|cleaning)|send ${n} (?:home|back|back home|back to (?:the )?(?:dock|base)|to (?:the )?(?:dock|base))|(?:dock|turn off|switch off) ${n}`)) {
    return { kind: "stop" };
  }
  if (match(`clear ${n}(?: s)? (?:warning|error)s?|clear the (?:warning|error)s? (?:on|for) ${n}`)) return { kind: "clear_warning" };
  if (match(`(?:start|turn on|switch on|run) ${n}(?: cleaning)?|${n} start(?: cleaning)?`)) return { kind: "start" };

  const clean = new RegExp(`^(?:(?:get|have|ask|tell) (${n}) (?:to )?|(${n}) )?${VERB} (?:the )?(.+)$`).exec(text);
  if (!clean) return null;
  const named = Boolean(clean[1] ?? clean[2]);
  const verb = clean[3] as string;
  // Only the vacuum "does" a room ("Robbie, do the kitchen"); "do the dishes" is not this.
  if (verb === "do" && !named) return null;
  let target = clean[4] as string;
  let settings: VacuumSettings = VERB_MODE[verb] === undefined ? {} : { mode: VERB_MODE[verb] };
  for (let found = true; found;) {
    found = false;
    for (const [pattern, setting] of MODIFIERS) {
      if (!pattern.test(target)) continue;
      target = target.replace(pattern, "").replace(/ and$/, "");
      settings = { ...setting, ...settings };
      found = true;
    }
  }
  if (HOUSE.test(target)) return { kind: "house", settings };
  const asked = target.split(/ and (?:the )?/).map((part) => roomNamed(part, rooms));
  if (asked.every((room): room is VacuumRoom => room !== null)) {
    return { kind: "rooms", rooms: [...new Map(asked.map((room) => [room.id, room])).values()], settings };
  }
  // "Clean the dishes" is not for the vacuum; "Robbie, clean the shed" and "mop the shed" are, and get a no.
  return named || verb !== "clean" ? { kind: "unknown_room", spoken: target } : null;
}

/** The vacuum's names as one alternation, longest first so "robbie two" wins over "robbie". */
function nounPattern(aliases: readonly string[]): string {
  const names = new Set([...vacuumNames(), ...aliases.flatMap((alias) => {
    const key = normalizeRoutingText(alias);
    return key ? [key, `the ${key}`] : [];
  })]);
  return `(?:${[...names].sort((a, b) => b.length - a.length).map(escape).join("|")})`;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A dashboard room by its exact name; "the lounge" is Lounge Room. */
function roomNamed(spoken: string, rooms: readonly VacuumRoom[]): VacuumRoom | null {
  const key = spoken.replace(/^the /, "").trim();
  const wanted = key === "lounge" ? "lounge room" : key;
  return rooms.find((room) => normalizeRoutingText(room.name) === wanted) ?? null;
}

// --- The one check step ---------------------------------------------------------

/** Every check the assistant asks before acting ends with one of these questions. */
const CHECK = new RegExp(`(?:Do you really want me to stop and send ${escapeName(vacuumName())} home|Do you still want ${escapeName(vacuumName())} to [^?]+|Do you want me to replace that with the whole house)\\?$`);

function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const YES = new RegExp(String.raw`^(?:yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|go for it|go on|please do|please|affirmative|correct)(?: (?:yes|please|mate|do it|go ahead|go on|thanks|${assistantNamePattern()}|${POLITENESS_PATTERN}))*$`);
const no = (): RegExp => householdRegex(String.raw`^(?:no|nope|nah|don t|do not|cancel|never ?mind|leave it|not now|forget it)(?: (?:thanks|mate|{ASSISTANT}|leave it|don t|no|thank you))*$`);

export function isVacuumCheck(reply: string): boolean {
  return CHECK.test(reply.trim());
}

/** A yes or no to a check; null for anything else, which drops the check. */
export function checkAnswer(core: string): "yes" | "no" | null {
  const text = core.trim().replace(/[.!?,]+$/, "").replace(/\s+/g, " ").replace(leading(), "");
  return YES.test(text) ? "yes" : no().test(text) ? "no" : null;
}
