
import { capitalize } from "./text-format.js";export type GrammaticalNumber = "singular" | "plural" | "auto";
export type VerbTense = "present" | "past";

export type SentencePart = NounPhrase | QuantityPhrase | PrepositionalPhrase | RawPhrase;

export interface NounPhrase {
  readonly kind: "noun_phrase";
  readonly text: string;
  readonly determiner?: string | null;
  readonly number?: GrammaticalNumber;
  readonly titleCase?: boolean;
  readonly lowerInitial?: boolean;
  readonly postModifiers?: readonly PrepositionalPhrase[];
}

export interface QuantityPhrase {
  readonly kind: "quantity";
  readonly value: string | number;
  readonly unit?: string | null | undefined;
}

export interface PrepositionalPhrase {
  readonly kind: "prepositional_phrase";
  readonly preposition: string;
  readonly object: SentencePart;
}

export interface RawPhrase {
  readonly kind: "raw";
  readonly text: string;
}

export interface VerbPhrase {
  readonly lemma: string;
  readonly tense: VerbTense;
  readonly past?: string;
  readonly adverbs?: readonly string[];
  readonly object?: SentencePart;
  readonly complements?: readonly SentencePart[];
  readonly complementJoiner?: "space" | "comma";
}

export interface Clause {
  readonly subject: SentencePart;
  readonly verb: VerbPhrase;
}

export function nounPhrase(input: Omit<NounPhrase, "kind">): NounPhrase {
  return { kind: "noun_phrase", ...input };
}

export function quantityPhrase(input: Omit<QuantityPhrase, "kind">): QuantityPhrase {
  return { kind: "quantity", ...input };
}

export function rawPhrase(text: string): RawPhrase {
  return { kind: "raw", text };
}

export function sentence(clause: Clause | string): string {
  const fragment = typeof clause === "string" ? clause : renderClause(clause);
  return capitalize(ensureFullStop(fragment));
}

export function renderPart(part: SentencePart): string {
  switch (part.kind) {
    case "noun_phrase":
      return renderNounPhrase(part);
    case "quantity":
      return renderQuantity(part);
    case "prepositional_phrase":
      return `${cleanText(part.preposition)} ${renderPart(part.object)}`.trim();
    case "raw":
      return cleanText(part.text);
  }
}

export function grammaticalNumber(part: SentencePart): Exclude<GrammaticalNumber, "auto"> {
  if (part.kind !== "noun_phrase") {
    return "singular";
  }
  if (part.number === "singular" || part.number === "plural") {
    return part.number;
  }
  const words = renderNounPhrase(part).toLowerCase().split(/\s+/);
  const last = words[words.length - 1] ?? "";
  return last.endsWith("s") && !last.endsWith("ss") ? "plural" : "singular";
}

function renderClause(clause: Clause): string {
  const subject = renderPart(clause.subject);
  const subjectPlural = grammaticalNumber(clause.subject) === "plural";
  const verb = renderVerb(clause.verb, subjectPlural);
  return [subject, verb].filter(Boolean).join(" ");
}

function renderVerb(verb: VerbPhrase, subjectPlural: boolean): string {
  const head = conjugateVerb(verb, subjectPlural);
  const parts = [
    head,
    ...(verb.adverbs ?? []).map(cleanText).filter(Boolean),
    ...(verb.object ? [renderPart(verb.object)] : []),
  ];
  const complements = (verb.complements ?? []).map(renderPart).filter(Boolean);
  const base = parts.filter(Boolean).join(" ");
  if (complements.length === 0) {
    return base;
  }
  const separator = verb.complementJoiner === "comma" ? ", " : " ";
  return `${base} ${complements.join(separator)}`.trim();
}

function conjugateVerb(verb: VerbPhrase, subjectPlural: boolean): string {
  const lemma = cleanText(verb.lemma).toLowerCase();
  if (lemma === "be") {
    if (verb.tense === "past") {
      return subjectPlural ? "were" : "was";
    }
    return subjectPlural ? "are" : "is";
  }
  if (verb.tense === "past") {
    return cleanText(verb.past ?? verb.lemma);
  }
  if (lemma === "have") {
    return subjectPlural ? "have" : "has";
  }
  return subjectPlural ? lemma : thirdPersonPresent(lemma);
}

function renderNounPhrase(phrase: NounPhrase): string {
  const text = prepareNounText(phrase);
  const determiner = cleanText(phrase.determiner ?? "");
  const withDeterminer = determiner && !hasDeterminer(text) ? `${determiner} ${text}` : text;
  const postModifiers = (phrase.postModifiers ?? []).map(renderPart).filter(Boolean);
  return [withDeterminer, ...postModifiers].join(" ").trim();
}

function prepareNounText(phrase: NounPhrase): string {
  const clean = cleanText(stripTrailingFullStop(phrase.text));
  const titled = phrase.titleCase ? titleCaseWords(clean) : clean;
  return phrase.lowerInitial ? lowerInitialCommonNoun(titled) : titled;
}

function renderQuantity(phrase: QuantityPhrase): string {
  const value = cleanText(String(phrase.value === "" ? "unknown" : phrase.value));
  const unit = cleanText(phrase.unit ?? "");
  return unit ? `${value} ${unit}` : value;
}

function thirdPersonPresent(lemma: string): string {
  if (/(s|sh|ch|x|z|o)$/i.test(lemma)) {
    return `${lemma}es`;
  }
  if (/[^aeiou]y$/i.test(lemma)) {
    return `${lemma.slice(0, -1)}ies`;
  }
  return `${lemma}s`;
}

export function hasDeterminer(phrase: string): boolean {
  return /^(the|a|an|my|our|your)\s/i.test(phrase);
}

function lowerInitialCommonNoun(phrase: string): string {
  const [first = "", ...rest] = phrase.split(" ");
  if (!/^[A-Z][a-z]+$/.test(first)) {
    return phrase;
  }
  return [first.toLowerCase(), ...rest].join(" ");
}

function titleCaseWords(value: string): string {
  return value.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function ensureFullStop(value: string): string {
  const clean = cleanText(value);
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

export function stripTrailingFullStop(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

function cleanText(value: string | null | undefined): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}
