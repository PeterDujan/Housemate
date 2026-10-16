import type { CatchupSourcesConfig } from "./catchup-digest.js";
import type { HaEntityState } from "./ha-state-cache.js";
import { capitalize, joinNatural } from "./text-format.js";
import { householdRegex } from "./household.js";

/*
 * Who's home: a code-owned roll call of the
 * household from the live HA person entities, for verified household
 * speakers only. Home or out, never the zone name. The
 * people and their HA person ids come from `config/catchup-sources.json`, so
 * a stray person entity (person.temp) is never counted and nobody is guessed.
 */

export type PresenceRollCallForm = "who" | "anyone" | "everyone";

const TIME_TAIL = "(?: (?:right now|just now|at the moment|at present|currently|now|tonight|today|yet|then|at all|mate))*";
const PLACE = "(?:at home|home|here|around|in|inside|in the house|at the house|in the house at the moment)";
const ASK_LEAD = "(?:(?:do you know|can you tell me|could you tell me|can you see|can you check|could you check|tell me|check|let me know) )?";
const WHO = "who(?: all| else)? (?:is|s|are)";
const OUT = "(?:out|away|not (?:at )?home|not here|not in)";

const WHO_PATTERNS: readonly RegExp[] = [
  new RegExp(`^${ASK_LEAD}${WHO}(?: still)? ${PLACE}${TIME_TAIL}$`),
  new RegExp(`^${ASK_LEAD}${WHO}(?: still)? ${OUT}${TIME_TAIL}$`),
  new RegExp(`^${ASK_LEAD}${WHO} ${PLACE} and who (?:is|s) ${OUT}${TIME_TAIL}$`),
];
const ANYONE_PATTERNS: readonly RegExp[] = [
  new RegExp(`^${ASK_LEAD}(?:(?:is|are) )?(?:there )?(?:anyone|anybody|someone|somebody)(?: else)? ${PLACE}${TIME_TAIL}$`),
  new RegExp(`^${ASK_LEAD}(?:is )?the house empty${TIME_TAIL}$`),
];
const EVERYONE_PATTERNS: readonly RegExp[] = [
  new RegExp(`^${ASK_LEAD}(?:(?:is|are) )?(?:everyone|everybody|the whole family|the family|all of us) ${PLACE}${TIME_TAIL}$`),
  new RegExp(`^${ASK_LEAD}(?:are )?we all ${PLACE}${TIME_TAIL}$`),
];

/** The roll-call form of a whole-utterance "who's home" ask, else null. */
export function parsePresenceRollCall(normalized: string): PresenceRollCallForm | null {
  const text = normalized.trim().replace(/\s+/g, " ").replace(householdRegex(String.raw`^(?:(?:so|okay|ok|hey|{ASSISTANT}|and|right|now) )+`), "");
  if (!text) return null;
  if (WHO_PATTERNS.some((pattern) => pattern.test(text))) return "who";
  if (EVERYONE_PATTERNS.some((pattern) => pattern.test(text))) return "everyone";
  if (ANYONE_PATTERNS.some((pattern) => pattern.test(text))) return "anyone";
  return null;
}

export type PresenceRollCallResult =
  | { readonly status: "ok"; readonly text: string; readonly notes: string; readonly sourceEntityIds: readonly string[] }
  | { readonly status: "declined"; readonly text: string; readonly notes: string; readonly sourceEntityIds: readonly string[] };

export function presenceRollCallAnswer(options: {
  readonly form: PresenceRollCallForm;
  /** Canonical household actor id of the verified speaker (person.sam). */
  readonly speakerActorId: string;
  readonly people: CatchupSourcesConfig["people"];
  readonly stateOf: (entityId: string) => HaEntityState | null | undefined;
}): PresenceRollCallResult {
  const people = Object.entries(options.people)
    .map(([actorId, person]) => ({ actorId, ...person }))
    // The speaker leads, then config order.
    .sort((left, right) => Number(right.actorId === options.speakerActorId) - Number(left.actorId === options.speakerActorId));
  const sourceEntityIds = people.map((person) => person.entityId).sort();
  const home: string[] = [];
  const out: string[] = [];
  const unknown: string[] = [];
  for (const person of people) {
    const name = person.actorId === options.speakerActorId ? "you" : person.label;
    const state = options.stateOf(person.entityId)?.state.trim().toLowerCase() ?? "";
    if (state === "" || state === "unknown" || state === "unavailable") {
      unknown.push(name);
    } else if (state === "home") {
      home.push(name);
    } else {
      out.push(name);
    }
  }
  const counts = `home=${home.length} out=${out.length} unknown=${unknown.length}`;
  if (people.length === 0 || unknown.length === people.length) {
    return {
      status: "declined",
      text: "I can't read who's home just now.",
      notes: `presence roll call: no readable household person state (${counts})`,
      sourceEntityIds,
    };
  }

  const sentences: string[] = [];
  if (out.length === 0 && unknown.length === 0) {
    sentences.push(options.form === "who" ? `Everyone's home: ${joinNatural(home, "keep-ands-apart")}.` : "Everyone's home.");
  } else if (home.length === 0 && unknown.length === 0) {
    sentences.push(`Nobody's home. ${capitalize(joinNatural(out, "keep-ands-apart"))} ${out.length === 1 ? verb(out) : "are all"} out.`);
  } else {
    if (home.length > 0) sentences.push(`${capitalize(joinNatural(home, "keep-ands-apart"))} ${verb(home)} home.`);
    if (out.length > 0) sentences.push(`${capitalize(joinNatural(out, "keep-ands-apart"))} ${verb(out)} out.`);
  }
  if (unknown.length > 0) {
    sentences.push(`I can't tell where ${joinNatural(unknown, "keep-ands-apart")} ${verb(unknown)}.`);
  }
  const answer = options.form === "anyone"
    ? `${home.length > 0 ? "Yes" : unknown.length > 0 ? "Not that I can see" : "No"}. ${sentences.join(" ")}`
    : options.form === "everyone"
      ? out.length === 0 && unknown.length === 0
        ? "Yes, everyone's home."
        : `No. ${sentences.join(" ")}`
      : sentences.join(" ");
  return {
    status: "ok",
    text: answer,
    notes: `presence roll call (${options.form}) from live HA person state: ${counts}`,
    sourceEntityIds,
  };
}

function verb(names: readonly string[]): string {
  if (names.length > 1) return "are";
  return names[0] === "you" ? "are" : "is";
}
