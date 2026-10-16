import { hasDeterminer, nounPhrase, type NounPhrase, quantityPhrase, rawPhrase, renderPart, sentence, stripTrailingFullStop } from "./english-sentence.js";
import { assistantName } from "./persona.js";

export interface EntityStatusSentenceInput {
  readonly label: string;
  readonly state: string;
  readonly unit?: string | null;
}

export interface GroupEntityStatusSentenceInput {
  readonly label: string;
  readonly items: readonly GroupEntityStatusItem[];
}

export interface GroupEntityStatusItem {
  readonly label: string;
  readonly state: string;
  readonly unit?: string | null;
}

export interface StatusSentenceOptions {
  readonly compact?: boolean;
  readonly polarity?: "yes" | "no" | null;
}

export function entityStatusSentence(input: EntityStatusSentenceInput, options: StatusSentenceOptions = {}): string {
  const body = sentence({
    subject: subjectNounPhrase(input.label),
    verb: {
      lemma: "be",
      tense: "present",
      ...(options.compact ? {} : { adverbs: ["currently"] }),
      complements: [quantityPhrase({ value: input.state || "unknown", unit: input.unit })],
    },
  });
  return prefixPolarity(body, options.polarity ?? null);
}

export function groupEntityStatusSentence(input: GroupEntityStatusSentenceInput, options: StatusSentenceOptions = {}): string {
  const items = input.items.filter((item) => item.label.trim());
  if (items.length === 0) {
    return entityStatusSentence({ label: input.label, state: "unknown" }, options);
  }
  if (items.length === 1) {
    const item = items[0] as GroupEntityStatusItem;
    return entityStatusSentence({
      label: input.label || item.label,
      state: item.state,
      ...(item.unit ? { unit: item.unit } : {}),
    }, options);
  }

  const states = new Set(items.map((item) => statusPhrase(item)));
  if (states.size === 1) {
    const state = states.values().next().value as string;
    const body = sentence({
      subject: subjectNounPhrase(input.label),
      verb: {
        lemma: "be",
        tense: "present",
        ...(options.compact ? {} : { adverbs: ["currently"] }),
        complements: [rawPhrase(`all ${state}`)],
      },
    });
    return prefixPolarity(body, options.polarity ?? null);
  }

  const simpleStates = new Set(items.map((item) => item.state));
  const mixedLabel = simpleStates.has("on") && simpleStates.has("off") && simpleStates.size === 2
    ? "partly on"
    : "mixed";
  const body = sentence({
    subject: subjectNounPhrase(input.label),
    verb: {
      lemma: "be",
      tense: "present",
      complements: [rawPhrase(`${mixedLabel}: ${items.map(itemSummary).join(", ")}`)],
    },
  });
  return prefixPolarity(body, options.polarity ?? null);
}

export function defaultBrainNotWiredSentence(): string {
  return `${assistantName()} heard you, but the full brain route is not wired yet.`;
}

function subjectNounPhrase(label: string): NounPhrase {
  const text = stripTrailingFullStop(String(label || "").trim()).replace(/\s+/g, " ") || "that";
  return nounPhrase({
    text,
    determiner: hasDeterminer(text) ? null : "the",
    lowerInitial: true,
    number: "auto",
  });
}

function statusPhrase(item: GroupEntityStatusItem): string {
  return renderPart(quantityPhrase({ value: item.state || "unknown", unit: item.unit }));
}

function itemSummary(item: GroupEntityStatusItem): string {
  return `${shortStatusLabel(item.label)} ${statusPhrase(item)}`;
}

function shortStatusLabel(label: string): string {
  const clean = String(label || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^lights\s*-\s*/i, "");
  return stripTrailingFullStop(clean) || "unknown";
}

function prefixPolarity(text: string, polarity: StatusSentenceOptions["polarity"]): string {
  if (!polarity) {
    return text;
  }
  const lead = polarity === "yes" ? "Yes." : "No.";
  return `${lead} ${text}`;
}
