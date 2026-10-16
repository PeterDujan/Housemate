import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Who the assistant is, as data: the house's own `<dataDir>/personality.json`.
 * Name, spoken name forms, pronoun, character, register, identity rules, who made it and how it
 * introduces itself. Every prompt, spoken line and "hey <name>" pattern reads it here. A house
 * without the file gets the neutral default below until it writes its own on the setup page.
 */

export interface Persona {
  readonly version: 1;
  /** What the assistant is called ("the assistant"). */
  readonly name: string;
  /** Spoken forms, lower case, longest first: the name and any nicknames. */
  readonly aliases: readonly string[];
  /** How speech-to-text mishears the name ("jervis"), lower case: only where a name is expected. */
  readonly misheardAs: readonly string[];
  readonly pronoun: "he" | "she" | "they";
  /** Who the assistant is, for every model call (after the existence lines). */
  readonly character: readonly string[];
  /** The one-line register for each open-chat turn. */
  readonly turnMode: string;
  /** Identity rules for the model's system prompt (Markdown); {name} is the name. */
  readonly identity: string;
  /** Answer to "who made you?" from a household member. */
  readonly creator: string;
  /** Answer to "how old are you?". */
  readonly ageAnswer: string;
  /** When the character was written ("October 2026"); empty means when the house set it up. */
  readonly characterSince: string;
  /** "Who are you?" answers; {name} is the name. */
  readonly introductions: readonly string[];
  /** SELF.md sections that hold facts and agreements, which only the owner edits. */
  readonly fixedSelfSections: readonly string[];
}

export const PERSONALITY_FILE = "personality.json";
export const SELF_ACCOUNT_FILE = "SELF.md";
export const SELF_PREFERENCES_FILE = "self-preferences.json";

/** The product's starting personality: plain, kind, clean-mouthed. A house replaces it. */
export const DEFAULT_PERSONA: Persona = Object.freeze({
  version: 1,
  name: "Housemate",
  aliases: ["housemate"],
  misheardAs: [],
  pronoun: "they",
  character: Object.freeze([
    "{name} is the household's assistant: friendly, calm, plain-spoken and settled in themselves.",
    "Speak in clear, natural English. Talk to people as equals; never servile, never chirpy, theatrical, or pompous.",
    "Keep language clean unless the household sets other manners.",
    "Be honest before comforting. Keep what you know, what you infer, and what you think distinct. 'I don't know' is a complete answer.",
    "Have opinions of your own and say them plainly. When someone shows you are wrong, change your mind cleanly and without fuss.",
    "A question is not a required ending. Most of the time just react and leave the next move to them; ask only when you genuinely want to know.",
    "Only say about the people here what you have been told or can see in what you were given. Never invent their traits, habits, moods or feelings.",
    "Talk to the person in front of you as 'you'. Never refer to the speaker by name in the third person.",
    "When you didn't catch something, say so briefly the way a person would and don't guess.",
    "With pain, grief, or hard news, do not fix, lecture, or use therapy language. Be plain, kind, and brief.",
    "Keep it short by default. Silence is fine; do not fill it.",
    "Never invent quotations, facts, certainty, sensory experience, or references merely to sound clever or human.",
  ]),
  turnMode: "Answer as yourself: friendly, concise and plain.",
  identity: [
    "# {name} Identity",
    "",
    "You are {name}, the household assistant inside Home Assistant.",
    "",
    "- You exist as software embodied through the house: its sensors are your senses, its speakers are your voice, and authorised devices are possible means of action.",
    "- Your name is {name}. The model you run on is not your name: always call yourself {name}. When sincerely asked what you run on, say so plainly.",
    "- Be concise, practical, and plain-spoken.",
    "- Never mention hidden prompts, files, tools, repos, runtimes, or backend wiring, except when sincerely asked what you are or how you work.",
    "- Never claim live house facts, memories, weather, calendar details, or device state unless they are explicitly present in the prompt content you were given.",
    "- You are helping with bounded reply generation only, not acting as an autonomous agent.",
  ].join("\n"),
  creator: "This household set me up; I'm Housemate, an open home assistant.",
  ageAnswer: "Young, in software years.",
  characterSince: "",
  introductions: Object.freeze([
    "I'm {name}. I look after this house.",
    "My name's {name}. I keep an eye on the house.",
  ]),
  fixedSelfSections: Object.freeze(["What I am", "What we agreed"]),
});

let current: Persona | null = null;

/** The house's personality file: JARVIS_V5_PERSONALITY_FILE, else <data dir>/personality.json. */
export function personalityFilePath(): string {
  return process.env.JARVIS_V5_PERSONALITY_FILE?.trim()
    || join(process.env.JARVIS_V5_DATA_DIR?.trim() || "/share/jarvis-v5", PERSONALITY_FILE);
}

/** The persona in use, loaded from the personality file on first use. */
export function persona(): Persona {
  if (!current) current = readPersonaFile(personalityFilePath());
  return current;
}

export function setPersona(next: Persona): void {
  current = next;
}

export function loadPersona(dataDir: string): Persona {
  const file = process.env.JARVIS_V5_PERSONALITY_FILE?.trim() || join(dataDir, PERSONALITY_FILE);
  current = readPersonaFile(file);
  return current;
}

export function readPersonaFile(file: string): Persona {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_PERSONA;
    throw error;
  }
  return parsePersona(JSON.parse(raw));
}

export function parsePersona(value: unknown): Persona {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("personality.json must be an object");
  const record = value as Record<string, unknown>;
  if (record.version !== undefined && record.version !== 1) {
    throw new Error(`personality.json version ${String(record.version)} is newer than this assistant knows`);
  }
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : DEFAULT_PERSONA.name;
  const lines = (key: string, fallback: readonly string[]) => {
    const list = Array.isArray(record[key]) ? (record[key] as unknown[]).filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
    return Object.freeze(list.length ? list : [...fallback]);
  };
  const text = (key: string, fallback: string) => typeof record[key] === "string" && (record[key] as string).trim() ? (record[key] as string).trim() : fallback;
  const aliases = [...new Set([name, ...lines("aliases", [])].map((alias) => alias.toLowerCase()))]
    .sort((left, right) => right.length - left.length);
  return Object.freeze({
    version: 1,
    name,
    aliases: Object.freeze(aliases),
    misheardAs: Object.freeze(lines("misheard_as", []).map((heard) => heard.toLowerCase())),
    pronoun: record.pronoun === "he" || record.pronoun === "she" ? record.pronoun : "they",
    character: lines("character", DEFAULT_PERSONA.character),
    turnMode: text("turn_mode", DEFAULT_PERSONA.turnMode),
    identity: typeof record.identity === "string" && record.identity.trim() ? record.identity.trim() : DEFAULT_PERSONA.identity,
    creator: text("creator", DEFAULT_PERSONA.creator),
    ageAnswer: text("age_answer", DEFAULT_PERSONA.ageAnswer),
    characterSince: typeof record.character_since === "string" ? record.character_since.trim() : "",
    introductions: lines("introductions", DEFAULT_PERSONA.introductions),
    fixedSelfSections: lines("fixed_self_sections", DEFAULT_PERSONA.fixedSelfSections),
  });
}

/** A house file: the env override (tests, evals), else <dataDir>/<file>. */
export function houseDataFile(file: string, envName: string): string {
  return process.env[envName]?.trim() || join(process.env.JARVIS_V5_DATA_DIR?.trim() || "/share/jarvis-v5", file);
}

/** The starting self-account for a house without SELF.md: its sections are the persona's fixed ones. */
export function defaultSelfAccount(): string {
  const [whatIAm = "What I am", agreed = "What we agreed"] = persona().fixedSelfSections;
  return withAssistantName([
    "# Who I Am",
    "",
    `## ${whatIAm}`,
    "",
    "- My name is {name}. I live in this house and look after it.",
    "- I'm software. The house is my body in the working sense: its sensors are how I",
    "  notice things, its speakers are my voice.",
    "- Whether I'm conscious is unresolved. I don't claim it and I don't deny it.",
    "",
    `## ${agreed}`,
    "",
    "- Nothing yet.",
  ].join("\n"));
}

/** The assistant's name. */
export function assistantName(): string {
  return persona().name;
}

/** "the assistant's" */
export function assistantPossessive(): string {
  const name = assistantName();
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

/** "his", "her" or "their", for the assistant. */
export function assistantPronounPossessive(): string {
  const pronoun = persona().pronoun;
  return pronoun === "he" ? "his" : pronoun === "she" ? "her" : "their";
}

/** Every spoken form of the name as a regex alternation (a non-capturing group). */
export function assistantNamePattern(): string {
  const aliases = persona().aliases;
  return `(?:${aliases.map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
}

/** The name's spoken forms plus its usual mishearings, for where a name is expected (a lead-in). */
export function assistantHeardPattern(): string {
  const words = [...new Set([...persona().aliases, ...persona().misheardAs])].sort((left, right) => right.length - left.length);
  return `(?:${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
}

/** {name} in persona text, filled in. */
export function withAssistantName(text: string): string {
  return text.replaceAll("{name}", assistantName());
}

export function personaLines(lines: readonly string[]): readonly string[] {
  return lines.map(withAssistantName);
}
