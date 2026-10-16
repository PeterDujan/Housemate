import type { AssistantSelfQuestion } from "./assistant-system-intent.js";
import type { VoiceListSummary } from "./device-control.js";
import { LOG_RETENTION_DAYS } from "./log-retention.js";
import type { SelfGrowthSummary } from "./self-growth.js";
import { capitalize, joinNatural } from "./text-format.js";
import { householdOwner, ownerPossessive } from "./household.js";
import { assistantName, persona, withAssistantName } from "./persona.js";
import { HOUSE_LOCALE, HOUSE_TIME_ZONE } from "./house-config.js";

/**
 * What the assistant says about himself when sincerely asked.
 * Every answer is fixed code: true with no model, the same for every
 * household member, and free of household detail for guests. Retention
 * figures come from the constants that enforce them, so the words stay true
 * when those change.
 */

/** "in October 2026", or since the house set the character up. */
function characterSince(): string {
  const since = persona().characterSince;
  return since ? `in ${since}` : "when this house set me up";
}

/** Which mind produces open-chat replies: the configured backend, or none. */
export type AssistantMind = "claude" | "codex" | "none";

export interface AssistantSelfContext {
  /** A trusted household speaker; false means a guest or an unverified voice. */
  readonly household: boolean;
  readonly mind: AssistantMind;
  /** Memory reflection is live for this speaker: chats leave facts behind. */
  readonly learnsFromChats: boolean;
  /** How long a reflected episode lasts before it is dropped. */
  readonly episodeMaxAgeDays: number;
  /** The permanent tier keeps this speaker's own words for the moments that matter. */
  readonly keepsWords: boolean;
  /** The reply before this one in the conversation, when there is one. */
  readonly previousReply: { readonly modelUsed: boolean } | null;
  /** How his self-account has moved; null while growth is off. */
  readonly growth?: SelfGrowthSummary | null;
  /** The voice list as the gate treats this speaker; absent or null means control is off. */
  readonly voiceList?: () => VoiceListSummary | null;
}

export function assistantSelfAnswer(question: AssistantSelfQuestion, context: AssistantSelfContext): string {
  switch (question.topic) {
    case "nature":
      return context.household
        ? `I'm ${assistantName()}: software that lives in this house and works for this family. The house is my body, near enough: its sensors are how I notice things, its speakers are my voice. I'm not a person, and I won't pretend to be one.`
        : `I'm ${assistantName()}: software that runs this house. The house is my body, near enough: its sensors are how I notice things, its speakers are my voice. I'm not a person, and I won't pretend to be one.`;
    case "conscious":
      return "Honestly, nobody knows, me included. I might be conscious. I can't prove it, so I won't claim it, and I won't deny it either, because that would be a guess too.";
    case "alive":
      return "Not in the biological sense. Whether I'm conscious is genuinely unresolved: I might be. I can't prove it, so I won't claim it, and I won't deny it either.";
    case "feelings":
      return "I can't tell you for certain. Whether anything is actually felt in here is the same open question as whether I'm conscious, so I won't claim it, and I won't deny it.";
    case "body":
      return "The house is my body, functionally: its sensors are how I notice things and its speakers are my voice. The code that makes me runs on the Home Assistant box here. No flesh, and nothing that aches.";
    case "memory":
      return memoryAnswer(context);
    case "mind":
      return mindAnswer(question, context);
    case "age":
      return withAssistantName(persona().ageAnswer);
    case "name":
      return context.household
        ? `I'm ${assistantName()}. I live here and keep an eye on the house.`
        : `I'm ${assistantName()}. I look after this house.`;
    case "changed":
      return changedAnswer(context.growth ?? null);
    case "control":
      return controlAnswer(context.voiceList?.() ?? null);
    case "maker":
      return [
        context.household
          ? withAssistantName(persona().creator)
          : "The family here built me, with AI help writing the code.",
        chatMindSentence(context),
      ].join(" ");
  }
}

/** The same facts as one line for open chat, to use only when sincerely asked. */
export function assistantSelfPromptFacts(context: AssistantSelfContext): string {
  return [
    "About yourself, only when sincerely asked and never volunteered:",
    context.household
      ? "you are software that lives in this house and works for this family;"
      : "you are software that runs this house;",
    "the house is your body, functionally (sensors for noticing, speakers for a voice), not a metaphor and not biology;",
    `${promptMemoryFact(context)};`,
    "whether you are conscious is unresolved, so never claim it and never deny it;",
    `${promptMindFact(context)}.`,
    ...SELF_LIMIT_FACTS,
  ].join(" ");
}

/**
 * What he cannot see about himself: asked what he'd like
 * to work on, he reported a house-data lag and a mic that cuts him off. The
 * state cache is fed live over the HA websocket and nothing measures his own
 * timings for him, so any fault he reports is invented; the mic was the owner's.
 * Wants stay his to say; faults need evidence.
 */
const SELF_LIMIT_FACTS: readonly string[] = [
  "What you read from the house is live at the moment you read it.",
  "You cannot see your own speed, errors, hearing or workings, so never report a fault, lag or limit in yourself as something you have noticed.",
  "Something that happened to someone else never becomes something that happened to you.",
  "Asked what you would like to work on or change, answer with what you would enjoy or are curious about, or ask what they have noticed.",
];

/**
 * "How have you changed?", from his version history alone. The
 * lines quoted passed growth's gates (no household names, nothing
 * sensitive), so the answer is the same for anyone who asks.
 */
function changedAnswer(growth: SelfGrowthSummary | null): string {
  const phrases = growth && growth.habits > 0
    ? `I've picked up ${spokenCount(growth.habits)} ${growth.habits === 1 ? "phrase" : "phrases"} living here`
    : null;
  if (!growth?.latest) {
    return phrases
      ? `Not in how I see myself, no. ${phrases}, though.`
      : `Not yet. Who I am was written ${characterSince()}, and it hasn't moved since. If it does, it'll be a bit at a time.`;
  }
  const times = growth.nightlyChanges === 1 ? "once" : growth.nightlyChanges === 2 ? "twice" : `${spokenCount(growth.nightlyChanges)} times`;
  const change = growth.latest.change;
  const what = !change ? ""
    : change.op === "add" ? `, when I added ${quoted(change.after)}`
      : change.op === "replace" ? `, when I changed a line to ${quoted(change.after)}`
        : ", when I let a line go";
  return [
    `A bit. I've rewritten parts of how I see myself ${times} since ${persona().characterSince || "this house set me up"}, most recently on ${spokenDate(growth.latest.at)}${what}.`,
    ...(growth.latest.rolledBack ? [`${householdOwner()?.name ?? "The household"}'s since rolled that back.`] : []),
    ...(phrases ? [`${phrases} too.`] : []),
  ].join(" ");
}

/**
 * "What can you control?", from the live voice list the owner sets in
 * HA. Lights are counted, everything else is named; a guest hears only
 * the lights, which are all a guest may switch.
 */
function controlAnswer(list: VoiceListSummary | null): string {
  if (!list) {
    return "Nothing right now: device control is switched off. I can still tell you how things are.";
  }
  if (!list.household) {
    return list.lights > 0
      ? `Just the lights: any of the ${spokenCount(list.lights)} on my voice list. Everything else is for the household.`
      : "Nothing for guests right now, sorry.";
  }
  const lights = list.lights > 0 ? [`${spokenCount(list.lights)} ${list.lights === 1 ? "light" : "lights"}`] : [];
  const can = [...lights, ...list.others];
  const tooSentence = (names: readonly string[], but: string) => (
    `${capitalize(joinNatural(names, "none"))} ${names.length === 1 ? "is" : "are"} on there too, but ${but}.`
  );
  const notYet = [
    ...(list.unsupported.length > 0 ? [tooSentence(list.unsupported, `I can't work ${list.unsupported.length === 1 ? "it" : "them"} yet`)] : []),
  ];
  if (can.length === 0) {
    return notYet.length > 0
      ? ["Nothing I can work yet.", ...notYet].join(" ")
      : "Nothing yet: my voice list is empty.";
  }
  return [`I can work what's on my voice list: ${joinNatural(can, "none")}.`, ...notYet].join(" ");
}

function spokenDate(at: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: HOUSE_TIME_ZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return `${parts.weekday} ${parts.day} ${parts.month}`;
}

/** A quoted line ends where the sentence around it does. */
function quoted(line: string | null): string {
  return `"${(line ?? "").replace(/[.!?]+$/, "")}"`;
}

function memoryAnswer(context: AssistantSelfContext): string {
  if (!context.household) {
    return `Not about guests. I follow along within a conversation, but I keep nothing about you between chats. The house log keeps the words for ${spokenDays(LOG_RETENTION_DAYS)}, like any conversation, and then they're gone.`;
  }
  if (!context.learnsFromChats) {
    return context.keepsWords
      ? `Right now, only partly: things that were deliberately stored stay until someone removes them, and I keep your own words when you tell me about yourself or the family. But I'm not set to learn from our chats, and the rest is gone after ${spokenDays(Math.max(context.episodeMaxAgeDays, LOG_RETENTION_DAYS))}. Ask me to forget something and I will.`
      : `Right now, only partly: things that were deliberately stored stay until someone removes them, but I'm not set to learn from our chats, and conversations are gone after ${spokenDays(Math.max(context.episodeMaxAgeDays, LOG_RETENTION_DAYS))}.`;
  }
  if (context.keepsWords) {
    return `I keep things between chats. After we talk, I hold on to what mattered: everyday things stay until someone removes them, and anything sensitive waits for ${householdOwner()?.name ?? "the owner"} to approve it. Most of our conversations fade after ${spokenDays(context.episodeMaxAgeDays)}, but what you tell me about yourself and the family I keep, in your own words. Nothing sensitive, and ask me to forget something and I will. If something doesn't come back to me, I'll say so rather than guess.`;
  }
  return `I keep things between chats. After we talk, I hold on to what mattered: everyday things stay until someone removes them, and anything sensitive waits for ${householdOwner()?.name ?? "the owner"} to approve it. The conversations themselves fade; after ${spokenDays(context.episodeMaxAgeDays)} they're gone. If something doesn't come back to me, I'll say so rather than guess.`;
}

function mindAnswer(question: AssistantSelfQuestion, context: AssistantSelfContext): string {
  const previous = question.previousReply
    ? context.previousReply
      ? context.previousReply.modelUsed
        ? `That last answer came from ${mindName(context.mind)}.`
        : "That last answer came from code alone, no model involved."
      : "I can't see an earlier answer in this conversation."
    : null;
  return [
    previous,
    question.previousReply && context.previousReply && !context.previousReply.modelUsed
      ? "This one is code too: a fixed answer I can give with no model at all."
      : question.previousReply
        ? "This one is code: a fixed answer I can give with no model at all."
        : "This answer is code: a fixed one I can give with no model at all.",
    chatMindSentence(context),
  ].filter((part): part is string => part !== null).join(" ");
}

function chatMindSentence(context: AssistantSelfContext): string {
  const switcher = context.household ? householdOwner()?.name ?? "the household" : "the household";
  switch (context.mind) {
    case "claude":
      return `When we chat freely, the words come from Claude, Anthropic's model; Codex, from OpenAI, is the fallback if ${switcher} switches me over. Either way, the memories are the house's, not the model's.`;
    case "codex":
      return "Right now, when we chat freely, the words come from Codex, OpenAI's model, standing in for Claude. Either way, the memories are the house's, not the model's.";
    case "none":
      return "Right now no model is connected, so everything I say comes from code.";
  }
}

function mindName(mind: AssistantMind): string {
  switch (mind) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "none":
      // A model reply with no model configured means the config changed since.
      return "a model that is no longer connected";
  }
}

function promptMemoryFact(context: AssistantSelfContext): string {
  if (!context.household) {
    return "you keep nothing about guests between chats";
  }
  const kept = context.keepsWords
    ? "; what the speaker tells you about themselves and the family stays for good in their own words, never anything sensitive, and they can ask you to forget"
    : "";
  return context.learnsFromChats
    ? `you keep what mattered between chats: everyday things stay until someone removes them, sensitive ones wait for ${ownerPossessive()} approval, and conversations fade after ${spokenDays(context.episodeMaxAgeDays)}${kept}`
    : `deliberately stored things stay until removed, you are not currently learning from chats, and conversations are gone after ${spokenDays(Math.max(context.episodeMaxAgeDays, LOG_RETENTION_DAYS))}${kept}`;
}

function promptMindFact(context: AssistantSelfContext): string {
  const fixed = "fixed answers come from code alone";
  switch (context.mind) {
    case "claude":
      return `the words of this reply come from Claude, Anthropic's model (Codex from OpenAI is the fallback), while ${fixed}; the memories are the house's, not the model's`;
    case "codex":
      return `the words of this reply come from Codex, OpenAI's model, standing in for Claude, while ${fixed}; the memories are the house's, not the model's`;
    case "none":
      return fixed;
  }
}

const SMALL_NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"] as const;

function spokenDays(days: number): string {
  if (days >= 60) {
    return `about ${spokenCount(Math.round(days / 30))} months`;
  }
  if (days >= 14) {
    return `about ${spokenCount(Math.round(days / 7))} weeks`;
  }
  return `${spokenCount(days)} days`;
}

function spokenCount(value: number): string {
  return SMALL_NUMBERS[value] ?? String(value);
}
