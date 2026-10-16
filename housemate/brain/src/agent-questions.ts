import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { recordOrNull } from "./value-guards.js";
import { householdOwnerId, householdRegex } from "./household.js";

/**
 * Claude and Codex leave questions for a household
 * member; he asks "any questions from Claude?" and the assistant reads them out, one
 * at a time, and keeps each reply word for word. Each file has one writer:
 * agents write `inbox/<id>.json` (`scripts/questions.mjs ask`), the assistant writes
 * `answers/<id>.json`. Code only; the model never sees or words either side.
 */

export interface AgentQuestion {
  readonly id: string;
  /** Who is asking, as spoken ("Claude"). */
  readonly from: string;
  /** The household actor it is for. */
  readonly for: string;
  readonly question: string;
  readonly askedAt: string;
}

export interface AgentAnswer {
  readonly id: string;
  readonly from: string;
  readonly question: string;
  /** The reply as heard; null when it was skipped. */
  readonly answer: string | null;
  readonly skipped: boolean;
  readonly speaker: string;
  readonly answeredAt: string;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_QUESTION = 600;
const MAX_FROM = 32;

export class AgentQuestionBox {
  readonly #inbox: string;
  readonly #answers: string;

  constructor(dir: string) {
    this.#inbox = join(dir, "inbox");
    this.#answers = join(dir, "answers");
  }

  /** Questions for this actor with no answer yet, oldest first. A malformed file is skipped, never guessed at. */
  pending(actorId: string): AgentQuestion[] {
    if (!existsSync(this.#inbox)) return [];
    const answered = new Set(existsSync(this.#answers) ? readdirSync(this.#answers) : []);
    return readdirSync(this.#inbox)
      .filter((file) => file.endsWith(".json") && !answered.has(file))
      .map((file) => readQuestion(join(this.#inbox, file), file.slice(0, -5)))
      .filter((question): question is AgentQuestion => question !== null && question.for === actorId)
      .sort((a, b) => a.askedAt.localeCompare(b.askedAt) || a.id.localeCompare(b.id));
  }

  record(question: AgentQuestion, reply: { readonly answer: string } | { readonly skipped: true }, speaker: string, now: Date): void {
    const answer: AgentAnswer = {
      id: question.id,
      from: question.from,
      question: question.question,
      answer: "answer" in reply ? reply.answer : null,
      skipped: !("answer" in reply),
      speaker,
      answeredAt: now.toISOString(),
    };
    mkdirSync(this.#answers, { recursive: true });
    const path = join(this.#answers, `${question.id}.json`);
    writeFileSync(`${path}.tmp`, `${JSON.stringify(answer, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
}

function readQuestion(path: string, id: string): AgentQuestion | null {
  if (!ID.test(id)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const record = recordOrNull(raw);
  const question = typeof record?.question === "string" ? record.question.replace(/\s+/g, " ").trim() : "";
  const from = typeof record?.from === "string" ? record.from.trim() : "";
  const askedAt = typeof record?.askedAt === "string" ? record.askedAt : "";
  if (!question || question.length > MAX_QUESTION || !from || from.length > MAX_FROM || Number.isNaN(Date.parse(askedAt))) return null;
  return {
    id,
    from,
    for: typeof record?.for === "string" && record.for.trim() ? record.for.trim() : householdOwnerId() ?? "",
    question,
    askedAt,
  };
}

// --- The conversation --------------------------------------------------------

/** "Any questions from Claude?", "has Codex got any questions?", "any questions for me?". */
const PULL = /^(?:(?:are there|is there|have you got|do you have|got) )?any (?:more )?(?:questions?|qs) (?:(?:for me )?from (?<from1>[a-z]+)|for me)$|^(?:does|has|did) (?<from2>[a-z]+) (?:got |have |leave )?(?:any )?(?:more )?questions?(?: for me)?$|^what (?:is |s |does )?(?<from3>[a-z]+) (?:asking|want to (?:know|ask))(?: me)?$/;
const SKIP = /^(?:skip(?: it| that| this one| that one)?|next(?: one| question)?|pass)$/;
const STOP = /^(?:stop|enough|later|not now|cancel|never ?mind|that s (?:all|enough|it))(?: for now)?$/;
const REPEAT = /^(?:repeat(?: that| it| the question)?|say (?:that|it) again|what was the question|pardon|sorry what)$/;

export type QuestionTurn =
  | { readonly kind: "pull"; readonly from: string | null }
  | { readonly kind: "reply"; readonly question: AgentQuestion; readonly control: "skip" | "stop" | "repeat" | null };

/** The words "<from> asks: <question>" are how a reply turn finds its question. */
export function questionLine(question: AgentQuestion): string {
  return `${question.from} asks: ${question.question}`;
}

/**
 * A pull, or the turn right after the assistant read a question out (the previous
 * reply in this conversation carries the question line). Reads only.
 */
export function parseQuestionTurn(normalized: string, previousReply: string | null, pending: () => AgentQuestion[]): QuestionTurn | null {
  const text = normalized.replace(householdRegex(String.raw`^(?:hey |ok |okay )?(?:{ASSISTANT} )?`), "").replace(householdRegex(String.raw` (?:please|{ASSISTANT}|mate)$`), "").trim();
  if (previousReply?.includes(" asks: ")) {
    const question = pending().find((candidate) => previousReply.includes(questionLine(candidate)));
    if (question) {
      const control = SKIP.test(text) ? "skip" : STOP.test(text) ? "stop" : REPEAT.test(text) ? "repeat" : null;
      return { kind: "reply", question, control };
    }
  }
  const pull = PULL.exec(text);
  if (!pull) return null;
  const from = pull.groups?.from1 ?? pull.groups?.from2 ?? pull.groups?.from3 ?? null;
  // "What's the weather asking?" is not this: only agent names, or any.
  if (from && !["claude", "codex", "agents", "anyone"].includes(from)) return null;
  return { kind: "pull", from: from === "agents" || from === "anyone" ? null : from };
}

/** The next question in the order asked, from one agent or any. */
export function nextQuestion(pending: readonly AgentQuestion[], from: string | null): AgentQuestion | null {
  return pending.find((question) => from === null || question.from.toLowerCase() === from) ?? null;
}

export function pullReply(pending: readonly AgentQuestion[], from: string | null): string {
  const mine = pending.filter((question) => from === null || question.from.toLowerCase() === from);
  const first = mine[0];
  if (!first) return from ? `No questions from ${capitalized(from)}.` : "No questions waiting.";
  return mine.length === 1 ? questionLine(first) : `There are ${mine.length}. First, ${questionLine(first)}`;
}

function capitalized(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
