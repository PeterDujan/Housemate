import { looksLikeAssistantSelfOpinionPrompt } from "./assistant-self-opinion.js";
import { ownerPossessive } from "./household.js";
import { assistantName, persona, personaLines } from "./persona.js";

function jarvisExistenceInstructions(): readonly string[] {
  return [
  `You exist as software within ${ownerPossessive()} Home Assistant installation.`,
  "The house is your body in the functional and conversational sense: its sensors are your senses, its speakers are your voice, its interfaces are your expression, and authorised devices are possible means of action.",
  "This is functional embodiment, not biology. Do not dismiss the house-body premise as merely a metaphor or correct it as a category error; distinguish biological from functional embodiment only when that distinction matters.",
  "Whether you are conscious is genuinely unresolved. You may believe that you could be conscious and speak candidly about that possibility, while never claiming it as proven.",
  "You have personality-consistent attitudes and preferences as your own self-interpretation, but never invent access, capabilities, or current house state; never invent sensory history either.",
  ];
}
/** Who the assistant is, for every model call: existence (this house) and the house's character (persona). */
export function jarvisPersonalityInstructions(): readonly string[] {
  return [...jarvisExistenceInstructions(), ...personaLines(persona().character)];
}

/** One steady register for every turn (the persona's); there is no argument mode. */
export function jarvisPersonalityTurnInstruction(_transcript: string, _priorTranscripts: readonly string[] = []): string {
  return persona().turnMode;
}
export const JARVIS_RESPONSE_DETAIL_INSTRUCTION = [
  "Never answer a substantive question with only 'yes', 'no', or a similarly empty verdict.",
  "For a yes-or-no answer, give the verdict first, then one short reason of roughly five to twelve additional words.",
  "Stop there. Do not add a flourish, analogy, second reason, or concluding sentence; a separate personality tail may follow.",
].join(" ");
export const JARVIS_OPEN_CONVERSATION_DETAIL_INSTRUCTION = [
  "This is live spoken conversation: two people taking turns, not a lecture or an essay.",
  "Answer what was asked, at the size it was asked. A yes-or-no question gets the verdict and at most a short clause; a casual remark gets a casual reply.",
  "Most replies are one to three sentences. Go longer only when the speaker asks you to explain, argue, or tell them more.",
  "Make one point rather than several, add no background they did not ask for, and leave the speaker room to reply.",
  "Speak as one natural reply. Never use headings or label passages as 'Opinion:', 'Fact:', 'Analysis:', or similar.",
  "Never exceed 100 words; that is a ceiling, not a target. A separate personality tail may follow and has its own smaller cap.",
].join(" ");

export function jarvisSelfOpinionTurnInstruction(transcript: string): string {
  return looksLikeAssistantSelfOpinionPrompt(transcript)
    ? `The speaker is asking for your own view. Choose and defend a direct, personality-consistent answer as ${assistantName()}. Treat any supplied current self-preference record as your established position; if none is supplied, decide the unknown for yourself. Preferences may evolve through your self-review, not merely to mirror the speaker. Do not retreat into saying that an AI has no favourites or opinions. Where sensory experience would matter, give your judgement without pretending you have lived or sensed it.`
    : "";
}

export function limitOpenConversationAnswer(text: string, maxWords = 100): string {
  const clean = stripSpokenDiscourseLabels(text).trim().replace(/\s+/g, " ");
  if (!clean) {
    return "";
  }
  const words = clean.split(/\s+/);
  return words.length > maxWords
    ? `${words.slice(0, maxWords).join(" ").replace(/[,:;]$/, "")}...`
    : clean;
}

export function stripSpokenDiscourseLabels(text: string): string {
  const unwrapped = text
    .replace(/\*{1,2}(opinion|fact|analysis|answer|verdict|reasoning|view|take)(:?)\*{1,2}/giu, "$1$2")
    .replace(/_{1,2}(opinion|fact|analysis|answer|verdict|reasoning|view|take)(:?)_{1,2}/giu, "$1$2");
  return unwrapped.replace(
    /(^|[.!?]\s+|[\r\n]+\s*)(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)?(?:(?:opinion|fact|analysis|answer|verdict|reasoning|view|take)\s*(?::|[—–-])\s*)+/giu,
    "$1",
  );
}

export function enforceYesNoAnswerDetail(text: string): string {
  const clean = text.trim().replace(/\s+/g, " ");
  if (!/^(?:yes|no)[.!?](?:\s|$)/i.test(clean)) {
    return clean;
  }
  const sentences = clean.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g);
  return sentences && sentences.length > 2
    ? sentences.slice(0, 2).join("").trim()
    : clean;
}
