import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { houseDataPath } from "./house-config.js";

/*
 * The words the voice says and listens for: the greeting when a speaker
 * wakes, the goodbye, and the stop phrase ("bye bye Nabu"). The app starts the voice with the house's
 * `voice-words.json` over its defaults (made from the assistant's name), and tells the brain what is
 * in use (`JARVIS_V5_VOICE_WORDS`). The voice reads them at start, so a change waits for a restart.
 */

export interface VoiceWords {
  readonly greeting: string;
  readonly goodbye: string;
  readonly stop_phrase: string;
}

export interface VoiceWordsBody {
  readonly ok: true;
  readonly words: VoiceWords;
  readonly restartPending: boolean;
}

const KEYS = ["greeting", "goodbye", "stop_phrase"] as const;

export function voiceWordsPath(): string {
  return houseDataPath("voice-words.json", "JARVIS_V5_VOICE_WORDS_FILE");
}

/** What the voice was started with. */
export function voiceWordsInUse(): VoiceWords {
  try {
    return words(JSON.parse(process.env.JARVIS_V5_VOICE_WORDS ?? "{}"));
  } catch {
    return words({});
  }
}

export function readVoiceWordsForm(): VoiceWordsBody {
  const inUse = voiceWordsInUse();
  const saved = savedWords();
  const shown = { ...inUse, ...saved };
  return { ok: true, words: shown, restartPending: KEYS.some((key) => key in saved && saved[key] !== inUse[key]) };
}

export function saveVoiceWordsForm(input: unknown): VoiceWordsBody & { readonly applied: "restart" } {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const next: Record<string, string> = {};
  for (const key of KEYS) {
    const said = typeof value[key] === "string" ? (value[key] as string).trim() : "";
    if (!said) throw new Error(`${key.replace("_", " ")} can't be empty`);
    if (said.length > 60) throw new Error(`"${said.slice(0, 20)}..." is too long`);
    if (/[{}<>"\\]/.test(said)) throw new Error(`"${said}" can't hold { } < > " or \\`);
    next[key] = key === "stop_phrase" ? said.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim() : said;
  }
  if (next.stop_phrase && next.stop_phrase.split(" ").length < 2) throw new Error("the stop phrase needs two words or more, so it isn't said by accident");
  const file = voiceWordsPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  return { ...readVoiceWordsForm(), applied: "restart" };
}

function savedWords(): Partial<Record<(typeof KEYS)[number], string>> {
  try {
    const value = JSON.parse(readFileSync(voiceWordsPath(), "utf8")) as Record<string, unknown>;
    return Object.fromEntries(KEYS.flatMap((key) => typeof value[key] === "string" && value[key] ? [[key, value[key] as string]] : []));
  } catch {
    return {};
  }
}

function words(value: Record<string, unknown>): VoiceWords {
  const text = (key: string): string => typeof value[key] === "string" ? (value[key] as string) : "";
  return { greeting: text("greeting"), goodbye: text("goodbye"), stop_phrase: text("stop_phrase") };
}
