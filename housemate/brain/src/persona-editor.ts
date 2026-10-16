import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { DEFAULT_PERSONA, parsePersona, persona, setPersona, type Persona } from "./persona.js";

/**
 * The page's Name & Personality editor: reads and writes the house's personality file.
 * The file stays the source of truth; keys the page does not edit are kept as they are. A save is
 * checked by the same parser the assistant boots with, written whole (temp file, rename), and the
 * last version is kept as `<file>.prev`. Wording applies at once; the name, nicknames, mishearings
 * and pronoun are compiled into patterns at start, so those wait for a restart of the app.
 */

export interface PersonaForm {
  readonly name: string;
  readonly pronoun: "he" | "she" | "they";
  readonly aliases: readonly string[];
  readonly misheard_as: readonly string[];
  readonly character: readonly string[];
  readonly turn_mode: string;
  readonly identity: string;
  readonly creator: string;
  readonly age_answer: string;
  readonly introductions: readonly string[];
}

export interface PersonaFormBody {
  readonly ok: true;
  readonly fields: PersonaForm;
  readonly defaults: PersonaForm;
  /** The saved file names the assistant differently from what is running: a restart is waiting. */
  readonly restartPending: boolean;
}

export interface PersonaSaveResult extends PersonaFormBody {
  readonly applied: "live" | "restart";
}

const TEXT_KEYS = ["name", "turn_mode", "identity", "creator", "age_answer"] as const;
const LIST_KEYS = ["aliases", "misheard_as", "character", "introductions"] as const;
const LIMITS: Record<string, number> = { name: 40, turn_mode: 400, identity: 8000, creator: 400, age_answer: 400 };
const MAX_LINES = 60;
const MAX_LINE = 600;

export const PERSONA_DEFAULTS: PersonaForm = Object.freeze({
  name: DEFAULT_PERSONA.name,
  pronoun: DEFAULT_PERSONA.pronoun,
  aliases: [],
  misheard_as: [],
  character: DEFAULT_PERSONA.character,
  turn_mode: DEFAULT_PERSONA.turnMode,
  identity: DEFAULT_PERSONA.identity,
  creator: DEFAULT_PERSONA.creator,
  age_answer: DEFAULT_PERSONA.ageAnswer,
  introductions: DEFAULT_PERSONA.introductions,
});

export function readPersonaForm(file: string, running: Persona = persona()): PersonaFormBody {
  const saved = parsePersona(readRaw(file));
  return { ok: true, fields: formOf(saved), defaults: PERSONA_DEFAULTS, restartPending: !sameStartup(saved, running) };
}

export function savePersonaForm(file: string, input: unknown, running: Persona = persona()): PersonaSaveResult {
  const raw = readRaw(file);
  const next = { ...raw, version: 1, ...checkedForm(input) };
  const parsed = parsePersona(next);
  if (existsSync(file)) copyFileSync(file, `${file}.prev`);
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  const live = sameStartup(parsed, running);
  if (live) setPersona(parsed);
  return { ...readPersonaForm(file, live ? parsed : running), applied: live ? "live" : "restart" };
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
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("personality.json must be an object");
  return value as Record<string, unknown>;
}

/** The page's fields from a parsed persona (nicknames without the name itself). */
function formOf(saved: Persona): PersonaForm {
  const name = saved.name.toLowerCase();
  return {
    name: saved.name,
    pronoun: saved.pronoun,
    aliases: saved.aliases.filter((alias) => alias !== name),
    misheard_as: saved.misheardAs,
    character: saved.character,
    turn_mode: saved.turnMode,
    identity: saved.identity,
    creator: saved.creator,
    age_answer: saved.ageAnswer,
    introductions: saved.introductions,
  };
}

/** What only takes effect at start: the name's patterns and the pronoun. */
function sameStartup(left: Persona, right: Persona): boolean {
  return left.name === right.name
    && left.pronoun === right.pronoun
    && left.aliases.join("|") === right.aliases.join("|")
    && left.misheardAs.join("|") === right.misheardAs.join("|");
}

/** Only the page's own keys, each checked; anything else in the request is refused. */
function checkedForm(input: unknown): Partial<Record<string, unknown>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("expected the personality fields");
  const record = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key === "pronoun") {
      if (record.pronoun !== "he" && record.pronoun !== "she" && record.pronoun !== "they") throw new Error("pronoun must be he, she or they");
      out.pronoun = record.pronoun;
    } else if ((TEXT_KEYS as readonly string[]).includes(key)) {
      const value = record[key];
      if (typeof value !== "string" || !value.trim()) throw new Error(`${label(key)} can't be empty`);
      if (value.trim().length > LIMITS[key]!) throw new Error(`${label(key)} is too long (${LIMITS[key]} characters at most)`);
      if (key === "name" && /[{}<>"\\]/.test(value)) throw new Error("the name can't hold { } < > \" or \\");
      out[key] = value.trim();
    } else if ((LIST_KEYS as readonly string[]).includes(key)) {
      const value = record[key];
      if (!Array.isArray(value) || value.some((line) => typeof line !== "string")) throw new Error(`${label(key)} must be lines of text`);
      const lines = (value as string[]).map((line) => line.trim()).filter(Boolean);
      if (lines.length > MAX_LINES) throw new Error(`${label(key)} has too many lines (${MAX_LINES} at most)`);
      if (lines.some((line) => line.length > MAX_LINE)) throw new Error(`a line in ${label(key)} is too long (${MAX_LINE} characters at most)`);
      if ((key === "character" || key === "introductions") && !lines.length) throw new Error(`${label(key)} can't be empty`);
      out[key] = lines;
    } else {
      throw new Error(`${key} is not a personality field`);
    }
  }
  return out;
}

function label(key: string): string {
  return ({
    name: "the name", turn_mode: "the chat style", identity: "the identity", creator: "\"who made you\"",
    age_answer: "\"how old are you\"", aliases: "nicknames", misheard_as: "mishearings", character: "the character",
    introductions: "introductions",
  } as Record<string, string>)[key] ?? key;
}
