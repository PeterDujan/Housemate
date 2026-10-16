import { normalizeSpeechForRouting } from "./speech-normalizer.js";
import { householdRegex, personNamedIn } from "./household.js";
export type { IntentConfidence, IntentRoute } from "./intent-contract.js";

export interface OutdoorAdviceSlots {
  readonly person: string | null;
  readonly asksClothingAdvice: boolean;
}

export function parseOutdoorAdviceSlots(input: string): OutdoorAdviceSlots | null {
  const text = normalize(input);
  if (/\b(?:preference|preferences|prefer|usually|normally|threshold|cutoff|what do you know|what you know|remember|remembered|memory|memories|recall|saved|what have i told|what have i said)\b/.test(text)) {
    return null;
  }
  const hasOutdoorWord = /\b(?:out|outside|outdoors|outdoor)\b/.test(text);
  const hasOutdoorMovement = /\b(?:go|going|head|heading|pop|popping|step|stepping|walk|walking|leave|leaving)\s+(?:out|outside|outdoors)\b/.test(text)
    || /\bgoing\s+for\s+(?:a\s+)?walk\b/.test(text);
  const hasLeavingSoon = /\b(?:we|i|me|us|they|he|she)\b/.test(text)
    && /\b(?:leaving|going|heading|ducking|stepping)\s+(?:soon|now|shortly|for a while|for a bit)\b/.test(text);
  const hasActor = householdRegex(String.raw`\b(?:i|me|my|we|us|{NAMES}|she|he|they)\b`).test(text);
  const hasClothingTerm = /\b(?:wear|wearing|dress|dressed|warmly|clothing|clothes|jacket|jumper|coat|layer|layers|layered|umbrella|shoe|shoes|footwear|sandals|rain gear|wet weather gear|sun protection)\b/.test(text);
  const hasAdviceTerm = /\b(?:should|need|needed|grab|take|bring|wear|dress|recommend|how|what|enough|weather|suit|suits|suitable|make sense|good idea|bad idea|avoid)\b/.test(text);
  const genericDeparturePacking = /\bwhat should (?:i|we|he|she|they) (?:take|bring|grab|wear)(?: with (?:me|us|him|her|them)| along)?$/.test(text);
  const asksStoredTemperatureRule = hasClothingTerm
    && householdRegex(String.raw`\b{NAMES}\b`).test(text)
    && /\b(?:if|at|below|under|threshold|cutoff)\b/.test(text)
    && /\b\d+(?:\.\d+)?\s*(?:c|degrees?)?\b/.test(text);
  if (asksStoredTemperatureRule) {
    return null;
  }
  const asksClothingAdvice = (hasOutdoorWord || /\bweather\b/.test(text)) && hasClothingTerm && hasAdviceTerm;
  const asksOutdoorPracticalAdvice = hasOutdoorWord && hasActor && hasAdviceTerm
    && /\b(?:what|should|need|take|bring|grab)\b/.test(text);
  const implicitWeatherClothing = hasClothingTerm && hasAdviceTerm
    && (hasActor || /\b(?:weather|suit|suits|suitable|make sense|good idea|bad idea|avoid)\b/.test(text));
  const implicitOutdoorProtection = hasClothingTerm && hasAdviceTerm
    && /\b(?:sun protection|umbrella|rain gear|wet weather gear)\b/.test(text);
  const explicitOccasionClothing = looksLikeOccasionClothingRequest(text);

  if (explicitOccasionClothing) {
    return null;
  }

  if (asksClothingAdvice || asksOutdoorPracticalAdvice || implicitWeatherClothing || implicitOutdoorProtection || (hasOutdoorMovement && hasActor) || (hasLeavingSoon && (hasClothingTerm || genericDeparturePacking))) {
    return {
      person: personFromText(text),
      asksClothingAdvice,
    };
  }
  return null;
}

export function looksLikeOccasionClothingRequest(input: string): boolean {
  const text = normalize(input);
  return /\b(?:wear|dress|dressed|clothes|clothing)\b/.test(text)
    && /\b(?:wedding|interview|funeral|party|costume|date|dinner|ceremony|event)\b/.test(text);
}

function personFromText(text: string): string | null {
  return personNamedIn(text)?.name.toLowerCase() ?? null;
}

function normalize(value: string): string {
  return normalizeSpeechForRouting(value)
    .replace(/^when s\b/g, "when is")
    .replace(/^whens\b/g, "when is");
}
