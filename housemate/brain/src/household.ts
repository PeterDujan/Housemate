import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assistantHeardPattern, assistantNamePattern } from "./persona.js";

/**
 * The household: who lives here, as data. Every module that knows a person by name,
 * id, role or relation reads it here; nothing else holds names. The house's own copy is
 * `<dataDir>/household.json` (written by its owner or the setup page); `JARVIS_V5_HOUSEHOLD_FILE`
 * points somewhere else (tests, evals). No file means an empty household: everyone is a guest.
 */

export type HouseholdRole = "owner" | "adult" | "child";

export interface HouseholdPerson {
  /** Memory and actor id, e.g. person.sam. Memories, sessions and logs are keyed by it. */
  readonly id: string;
  /** How the assistant names them. */
  readonly name: string;
  /** The everyday short name, when there is one ("Sam" for "Samantha"). */
  readonly shortName: string;
  /** Spoken names, lower case, longest first: the name, the short name and any nicknames. */
  readonly aliases: readonly string[];
  /** Older or alternative ids that mean this person (e.g. A renamed person entity). */
  readonly otherIds: readonly string[];
  /** The Home Assistant person (person.* entity) this person is linked to on the page, if any. */
  readonly haPerson: string | null;
  readonly role: HouseholdRole;
  /** "he", "she" or "they": which of "his"/"her" birthday questions can mean them. */
  readonly pronoun: "he" | "she" | "they";
  /** Relation word (wife, dad, kid...) to the person id it means, from this person's side. */
  readonly relations: Readonly<Record<string, string>>;
  /** How speech-to-text tends to mishear the name, for the model's instructions. */
  readonly misheardAs: readonly string[];
}

export interface Household {
  readonly version: 1;
  readonly people: readonly HouseholdPerson[];
  /** The person who runs the house: approves memories, owns the projects folder. */
  readonly ownerId: string | null;
  /** Names that belong to the household but never speak (pets, close family elsewhere). */
  readonly otherNames: readonly string[];
}

export const HOUSEHOLD_FILE = "household.json";
const NEVER = "(?!)";

const EMPTY: Household = Object.freeze({ version: 1, people: [], ownerId: null, otherNames: [] });

let current: Household | null = null;
let cache = new Map<string, unknown>();

/** The house's household file: JARVIS_V5_HOUSEHOLD_FILE, else <data dir>/household.json. */
export function householdFilePath(): string {
  return process.env.JARVIS_V5_HOUSEHOLD_FILE?.trim()
    || join(process.env.JARVIS_V5_DATA_DIR?.trim() || "/share/jarvis-v5", HOUSEHOLD_FILE);
}

/** The household in use. Loaded from the household file on first use. */
export function household(): Household {
  if (!current) setHousehold(readHouseholdFile(householdFilePath()));
  return current as Household;
}

/** Boot (and tests): use this household from now on. */
export function setHousehold(next: Household): void {
  current = next;
  cache = new Map();
}

/** Loads the house's file from its data dir; a missing file is an empty household. */
export function loadHousehold(dataDir: string): Household {
  const file = process.env.JARVIS_V5_HOUSEHOLD_FILE?.trim() || join(dataDir, HOUSEHOLD_FILE);
  const loaded = readHouseholdFile(file);
  setHousehold(loaded);
  return loaded;
}

export function readHouseholdFile(file: string): Household {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
    throw error;
  }
  return parseHousehold(JSON.parse(raw));
}

export function parseHousehold(value: unknown): Household {
  const record = asRecord(value, "household");
  if (record.version !== undefined && record.version !== 1) {
    throw new Error(`household.json version ${String(record.version)} is newer than this assistant knows`);
  }
  const people = (Array.isArray(record.people) ? record.people : []).map(parsePerson);
  const ids = new Set(people.map((person) => person.id));
  if (ids.size !== people.length) throw new Error("household.json lists a person twice");
  const links = people.flatMap((person) => person.haPerson ? [person.haPerson] : []);
  if (new Set(links).size !== links.length) throw new Error("household.json links one Home Assistant person to two people");
  for (const person of people) {
    for (const target of Object.values(person.relations)) {
      if (!ids.has(target)) throw new Error(`household.json: ${person.id} relation points at unknown ${target}`);
    }
  }
  const ownerId = typeof record.owner === "string" && record.owner.trim() ? record.owner.trim().toLowerCase() : null;
  if (ownerId && !ids.has(ownerId)) throw new Error(`household.json: owner ${ownerId} is not in people`);
  return Object.freeze({
    version: 1,
    people: Object.freeze(people),
    ownerId,
    otherNames: Object.freeze(stringList(record.other_names)),
  });
}

function parsePerson(value: unknown): HouseholdPerson {
  const record = asRecord(value, "person");
  const id = requiredString(record.id, "person id").toLowerCase();
  const name = requiredString(record.name, `${id} name`);
  const shortName = typeof record.short_name === "string" && record.short_name.trim() ? record.short_name.trim() : name;
  const role = record.role === "owner" || record.role === "child" ? record.role : "adult";
  const pronoun = record.pronoun === "he" || record.pronoun === "she" ? record.pronoun : "they";
  const aliases = [...new Set([name, shortName, ...stringList(record.aliases)].map((alias) => alias.toLowerCase()))]
    .sort((left, right) => right.length - left.length);
  const relations: Record<string, string> = {};
  for (const [word, target] of Object.entries(asRecord(record.relations ?? {}, `${id} relations`))) {
    if (typeof target === "string" && target.trim()) relations[word.toLowerCase()] = target.trim().toLowerCase();
  }
  return Object.freeze({
    id,
    name,
    shortName,
    aliases: Object.freeze(aliases),
    otherIds: Object.freeze(stringList(record.other_ids).map((other) => other.toLowerCase())),
    haPerson: typeof record.ha_person === "string" && /^person\.[a-z0-9_]+$/.test(record.ha_person.trim().toLowerCase())
      ? record.ha_person.trim().toLowerCase()
      : null,
    role,
    pronoun,
    relations: Object.freeze(relations),
    misheardAs: Object.freeze(stringList(record.misheard_as)),
  });
}

/** Derived values are worked out once per household. */
function derived<T>(key: string, build: (house: Household) => T): T {
  const house = household();
  if (!cache.has(key)) cache.set(key, build(house));
  return cache.get(key) as T;
}

export function householdPeople(): readonly HouseholdPerson[] {
  return household().people;
}

/** The person for an id, an older id or a spoken name; null for anyone else. */
export function householdPerson(value: string | null | undefined): HouseholdPerson | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) return null;
  return derived("lookup", (house) => {
    const map = new Map<string, HouseholdPerson>();
    for (const person of house.people) {
      for (const key of [person.id, ...person.otherIds, ...(person.haPerson ? [person.haPerson] : []), ...person.aliases]) map.set(key, person);
    }
    return map;
  }).get(normalized) ?? null;
}

/** The person a spoken name or alias means ("sammy"), never an id. */
export function householdPersonByName(value: string | null | undefined): HouseholdPerson | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized ? derived("byName", (house) => new Map(
    house.people.flatMap((person) => person.aliases.map((alias) => [alias, person] as const)),
  )).get(normalized) ?? null : null;
}

/** The person an id, older id or linked Home Assistant person means ("person.samantha"), never a spoken name. */
export function householdPersonById(value: string | null | undefined): HouseholdPerson | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized ? derived("byId", (house) => new Map(
    house.people.flatMap((person) => [person.id, ...person.otherIds, ...(person.haPerson ? [person.haPerson] : [])].map((id) => [id, person] as const)),
  )).get(normalized) ?? null : null;
}

/** The first household member (in household order) a text names by any of their spoken names. */
export function personNamedIn(text: string): HouseholdPerson | null {
  return householdPeople().find((person) => personNameRegex(person).test(text)) ?? null;
}

/** Everyone a text names. */
export function peopleNamedIn(text: string): readonly HouseholdPerson[] {
  return householdPeople().filter((person) => personNameRegex(person).test(text));
}

function personNameRegex(person: HouseholdPerson): RegExp {
  return derived(`person/${person.id}`, () => new RegExp(`\\b${alternation(person.aliases)}\\b`, "i"));
}

/** Display name for an id, an alias or a bare tail ("person.sam", "sam"): the household name, else Capitalised. */
export function displayPersonName(value: string): string {
  const person = householdPerson(value) ?? householdPerson(value.split(".").pop() ?? value);
  if (person) return person.name;
  const tail = (value.split(".").pop() ?? value).trim();
  return tail ? tail.charAt(0).toUpperCase() + tail.slice(1) : "";
}

export function householdOwner(): HouseholdPerson | null {
  const ownerId = household().ownerId;
  return ownerId ? householdPerson(ownerId) : null;
}

/** "Sam's" for the owner, else "the household's". */
export function ownerPossessive(): string {
  const owner = householdOwner();
  return owner ? `${owner.name}'s` : "the household's";
}

/** "his", "her" or "their", for the owner. */
export function ownerPronounPossessive(): string {
  const pronoun = householdOwner()?.pronoun;
  return pronoun === "he" ? "his" : pronoun === "she" ? "her" : "their";
}

/** Someone in the house other than the owner, for examples in the model's instructions. */
export function exampleHouseholdName(): string {
  const house = household();
  return house.people.find((person) => person.id !== house.ownerId)?.name ?? "someone";
}

export function householdOwnerId(): string | null {
  return household().ownerId;
}

/** Every spoken name and alias as a regex alternation (longest first); never matches when empty. */
export function householdNamePattern(): string {
  return derived("names", (house) => alternation(house.people.flatMap((person) => person.aliases)));
}

/** The household's spoken names plus the names of those who never speak (pets, family elsewhere). */
export function householdReferencePattern(): string {
  return derived("references", (house) => alternation([
    ...house.people.flatMap((person) => person.aliases),
    ...house.otherNames.map((name) => name.toLowerCase()),
  ]));
}

/** The owner's spoken names; never matches without an owner. */
export function ownerNamePattern(): string {
  return derived("owner", (house) => alternation(house.people.find((person) => person.id === house.ownerId)?.aliases ?? []));
}

/**
 * A regex over household names, built once per household. In `source`, {NAMES} is every spoken
 * name, {OWNER} the owner's, {CHILDREN} the children's, {REFERENCES} the names plus otherNames,
 * {ASSISTANT} the assistant's name (persona.ts) and {ASSISTANT_HEARD} that plus its mishearings;
 * each is a non-capturing group.
 */
export function householdRegex(source: string, flags = ""): RegExp {
  const assistant = assistantNamePattern();
  const heard = assistantHeardPattern();
  return derived(`re/${flags}/${assistant}/${heard}/${source}`, () => new RegExp(source
    .replaceAll("{ASSISTANT_HEARD}", heard)
    .replaceAll("{ASSISTANT}", assistant)
    .replaceAll("{NAMES}", householdNamePattern())
    .replaceAll("{OWNER}", ownerNamePattern())
    .replaceAll("{CHILDREN}", childNamePattern())
    .replaceAll("{REFERENCES}", householdReferencePattern()), flags));
}

export function householdNameTokens(): ReadonlySet<string> {
  return derived("tokens", (house) => new Set(house.people.flatMap((person) => person.aliases)));
}

export function isChildId(id: string | null | undefined): boolean {
  return householdPerson(id)?.role === "child";
}

/** A regex over the children's spoken names, for text about them; never matches without children. */
export function childNamePattern(): string {
  return derived("children", (house) => alternation(
    house.people.filter((person) => person.role === "child").flatMap((person) => person.aliases),
  ));
}

/** "Sam, Alex and Jo": everyone's name, for the model's instructions. */
export function householdNameList(): string {
  return derived("nameList", (house) => joinNames(house.people.map((person) => person.name)));
}

/** "person.sam, person.alex, person.jo" */
export function householdIdList(): string {
  return derived("idList", (house) => house.people.map((person) => person.id).join(", "));
}

export function relationsOf(id: string | null | undefined): Readonly<Record<string, string>> {
  return householdPerson(id)?.relations ?? {};
}

/** Every relation word anyone in the house uses (wife, dad...). */
export function householdRelationWords(): ReadonlySet<string> {
  return derived("relationWords", (house) => new Set(house.people.flatMap((person) => Object.keys(person.relations))));
}

export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function alternation(words: readonly string[]): string {
  const unique = [...new Set(words.filter(Boolean))].sort((left, right) => right.length - left.length);
  return unique.length ? `(?:${unique.map(escapeRegex).join("|")})` : NEVER;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`household.json: ${what} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`household.json: ${what} is missing`);
  return value.trim();
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}
