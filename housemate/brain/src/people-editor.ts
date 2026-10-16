import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { household, parseHousehold, type Household, type HouseholdRole } from "./household.js";

/**
 * The page's People editor: who lives here, written to the house's household file.
 * Each person keeps one memory id for good; the page links them by hand to one Home Assistant
 * person (`ha_person`), so nothing is guessed from ids or names. A new person's id is their linked
 * HA person's, else made from their name. A save is checked by the parser the assistant boots with, written whole (temp file,
 * rename) with the last version kept as `<file>.prev`. Keys the page does not edit (relations,
 * older ids, other names) are kept; relations to someone removed go with them. Who lives here is
 * read at start by both the brain and the voice, so every change waits for a restart of the app.
 */

export interface PersonForm {
  /** The memory id; empty for someone added on the page and not saved yet. */
  readonly id: string;
  /** The linked Home Assistant person, or "" for none. */
  readonly ha_person: string;
  readonly name: string;
  readonly short_name: string;
  readonly pronoun: "he" | "she" | "they";
  readonly role: HouseholdRole;
  readonly aliases: readonly string[];
  readonly misheard_as: readonly string[];
}

export interface HaPerson {
  readonly id: string;
  readonly name: string | null;
}

export interface PeopleFormBody {
  readonly ok: true;
  readonly people: readonly PersonForm[];
  /** Every Home Assistant person, for the link dropdown. */
  readonly haPersons: readonly HaPerson[];
  readonly restartPending: boolean;
}

const PERSON_ID = /^person\.[a-z0-9_]+$/;
const MAX_PEOPLE = 20;

export function readPeopleForm(file: string, haPersons: readonly HaPerson[], running: Household = household()): PeopleFormBody {
  const saved = parseHousehold(readRaw(file));
  // Someone already here under an older id (other_ids) is not offered again.
  return {
    ok: true,
    people: saved.people.map((person) => {
      const own = new Set([person.name.toLowerCase(), person.shortName.toLowerCase()]);
      return {
        id: person.id,
        ha_person: person.haPerson ?? "",
        name: person.name,
        short_name: person.shortName === person.name ? "" : person.shortName,
        pronoun: person.pronoun,
        role: person.role,
        aliases: person.aliases.filter((alias) => !own.has(alias)),
        misheard_as: person.misheardAs,
      };
    }),
    haPersons: [...haPersons].sort((left, right) => left.id.localeCompare(right.id)),
    restartPending: JSON.stringify(saved) !== JSON.stringify(running),
  };
}

export function savePeopleForm(file: string, input: unknown, haPersons: readonly HaPerson[], running: Household = household()): PeopleFormBody & { readonly applied: "restart" } {
  const raw = readRaw(file);
  const people = withIds(checkedPeople(input));
  const kept = new Map<string, Record<string, unknown>>();
  for (const person of Array.isArray(raw.people) ? raw.people : []) {
    if (person && typeof person === "object" && typeof (person as { id?: unknown }).id === "string") {
      kept.set(((person as { id: string }).id).toLowerCase(), person as Record<string, unknown>);
    }
  }
  const ids = new Set(people.map((person) => person.id));
  const next = {
    ...raw,
    version: 1,
    owner: people.find((person) => person.role === "owner")?.id ?? null,
    people: people.map((person) => {
      const before = kept.get(person.id) ?? {};
      const relations = Object.fromEntries(Object.entries((before.relations ?? {}) as Record<string, unknown>)
        .filter(([, target]) => typeof target === "string" && ids.has(target.toLowerCase())));
      const record: Record<string, unknown> = { ...before, ...person, relations };
      if (!person.short_name) delete record.short_name;
      if (!person.ha_person) delete record.ha_person;
      return record;
    }),
  };
  parseHousehold(next);
  if (existsSync(file)) copyFileSync(file, `${file}.prev`);
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return { ...readPeopleForm(file, haPersons, running), applied: "restart" };
}

function readRaw(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("household.json must be an object");
  return value as Record<string, unknown>;
}

function checkedPeople(input: unknown): PersonForm[] {
  const list = input && typeof input === "object" && !Array.isArray(input) ? (input as { people?: unknown }).people : undefined;
  if (!Array.isArray(list)) throw new Error("expected the people who live here");
  if (list.length > MAX_PEOPLE) throw new Error(`${MAX_PEOPLE} people at most`);
  const people = list.map(checkedPerson);
  const ids = people.flatMap((person) => person.id ? [person.id] : []);
  if (new Set(ids).size !== ids.length) throw new Error("someone is listed twice");
  const links = people.flatMap((person) => person.ha_person ? [person.ha_person] : []);
  if (new Set(links).size !== links.length) throw new Error("one Home Assistant person is linked to two people");
  const owners = people.filter((person) => person.role === "owner").length;
  if (people.length && owners !== 1) throw new Error("exactly one person runs the house");
  return people;
}

function checkedPerson(value: unknown): PersonForm {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("each person must be an object");
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim().toLowerCase() : "";
  if (id && !PERSON_ID.test(id)) throw new Error(`${String(record.id)} is not a person id`);
  const link = typeof record.ha_person === "string" ? record.ha_person.trim().toLowerCase() : "";
  if (link && !PERSON_ID.test(link)) throw new Error(`${link} is not a Home Assistant person`);
  const name = text(record.name, 40);
  if (!name) throw new Error(`${id} needs a name`);
  if (record.pronoun !== "he" && record.pronoun !== "she" && record.pronoun !== "they") throw new Error(`${name}: pronoun must be he, she or they`);
  if (record.role !== "owner" && record.role !== "adult" && record.role !== "child") throw new Error(`${name}: role must be owner, adult or child`);
  return {
    id,
    ha_person: link,
    name,
    short_name: text(record.short_name, 40),
    pronoun: record.pronoun,
    role: record.role,
    aliases: words(record.aliases, name),
    misheard_as: words(record.misheard_as, name),
  };
}

/** New people get their id once: the linked HA person's, else one made from the name. Never changed after. */
function withIds(people: PersonForm[]): PersonForm[] {
  const taken = new Set(people.flatMap((person) => person.id ? [person.id] : []));
  return people.map((person) => {
    if (person.id) return person;
    const base = person.ha_person && !taken.has(person.ha_person)
      ? person.ha_person
      : `person.${person.name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "someone"}`;
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}_${n}`;
    taken.add(id);
    return { ...person, id };
  });
}

function text(value: unknown, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error("names must be text");
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`"${trimmed.slice(0, 20)}..." is too long`);
  if (/[{}<>"\\]/.test(trimmed)) throw new Error(`"${trimmed}" can't hold { } < > " or \\`);
  return trimmed;
}

function words(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${name}: nicknames must be a list`);
  return (value as string[]).map((item) => text(item, 40)).filter(Boolean).slice(0, 20);
}
