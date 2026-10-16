import { stripStatusFiller } from "./lexicon.js";
import {
  canonicalizeLeadingQuestionContractions,
  normalizeQuestionLeadIn,
} from "./routing-text.js";

export type HouseLightsStatusOperation =
  | "any_on"
  | "all_on"
  | "any_off"
  | "all_off"
  | "list_on"
  | "list_off"
  | "longest_on"
  | "summary";
export type HouseLightsStatusQuantifier = "any" | "all" | "which" | null;

const HOUSE_LIGHT_HISTORICAL_STATE_PATTERN = "(?:on|off|lit|dark|glowing|out)";
const PERFECT_HOUSE_LIGHT_HISTORY_PATTERN = new RegExp(`\\b(?:has|have|had)(?: not)?\\b.*\\bbeen\\s+(?:not\\s+)?${HOUSE_LIGHT_HISTORICAL_STATE_PATTERN}\\b`);
const SUBJECT_PERFECT_HOUSE_LIGHT_HISTORY_PATTERN = new RegExp(`\\b(?:lights?|lighting|house|home)\\b.*\\b(?:has|have|had)(?: not)?\\s+been\\s+(?:not\\s+)?${HOUSE_LIGHT_HISTORICAL_STATE_PATTERN}\\b`);
const RECENT_PERFECT_HOUSE_LIGHT_HISTORY_PATTERN = new RegExp(`\\b(?:has|have|had)(?: not)?\\b.*\\b(?:just|recently|already) been\\b.*${HOUSE_LIGHT_HISTORICAL_STATE_PATTERN}\\b`);
/** "Which lights have been on the longest?": the current on-run, read from when each light last changed. */
const LONGEST_ON_PATTERN = /^(?:which|what) (?:house )?lights? (?:has|have|s) been (?:on|lit) (?:for )?(?:the )?longest(?: time)?$/;

export interface HouseLightsStatusIntent {
  readonly operation: HouseLightsStatusOperation;
  readonly quantifier: HouseLightsStatusQuantifier;
}

/** Pure standalone whole-house light-status grammar shared by legacy and typed routing. */
export function parseHouseLightsStatusIntent(value: string): HouseLightsStatusIntent | null {
  const normalized = normalizeTypedHouseLightStatusSurface(value);
  if (!looksLikeGlobalLightsStatus(normalized)) {
    return null;
  }
  const operation = typedHouseLightsStatusOperation(normalized);
  return {
    operation,
    quantifier: houseLightsStatusQuantifier(operation),
  };
}

function typedHouseLightsStatusOperation(value: string): HouseLightsStatusOperation {
  const normalized = normalizeGlobalLightsStatusText(normalizeTypedHouseLightStatusSurface(value));
  if (LONGEST_ON_PATTERN.test(normalized)) return "longest_on";
  const state = requestedHouseLightState(normalized) ?? (looksLikeForgottenLightQuery(normalized) ? "on" : null);
  if (!state) return "summary";

  if (looksLikeHouseLightListQuery(normalized)) {
    return state === "on" ? "list_on" : "list_off";
  }
  if (looksLikeNegativeExistentialHouseLightQuery(normalized)) {
    return state === "on" ? "all_off" : "all_on";
  }
  if (looksLikeNegatedUniversalHouseLightQuery(normalized)
    || looksLikeNegatedWholeHouseSetQuery(normalized)) {
    return state === "on" ? "any_off" : "any_on";
  }
  if (looksLikeUniversalHouseLightQuery(normalized)) {
    return state === "on" ? "all_on" : "all_off";
  }
  if (looksLikeExistentialHouseLightQuery(normalized)) {
    return state === "on" ? "any_on" : "any_off";
  }

  // A state predicated of the definite whole-house set is a group-wide claim.
  if (/\b(?:whole\s+)?(?:house|home)\b/.test(normalized)) {
    return state === "on" ? "all_on" : "all_off";
  }
  return state === "on" ? "any_on" : "any_off";
}

export function looksLikeGlobalLightsStatus(normalized: string): boolean {
  const stripped = normalizeGlobalLightsStatusText(normalizeTypedHouseLightStatusSurface(normalized));
  if (/\b(?:entities|entity ids?)\b/.test(stripped)) {
    return false;
  }
  if (hasUnsupportedHouseLightPredicate(stripped) || hasNamedHouseLightScope(stripped)) {
    return false;
  }
  const lightingDomain = /\b(?:light|lights|lighting|lit|glowing|glow)\b/.test(stripped)
    || (/\bdark\b/.test(stripped) && /\b(?:house|home)\b/.test(stripped));
  const quantifiedCollection = /\b(?:any|all|every)\s+(?:house\s+)?lights?\b/.test(stripped)
    || /\b(?:anything|everything)\b.*\b(?:lit|on|off|dark)\b/.test(stripped);
  const wholeHomeCollection = /\b(?:whole\s+)?(?:house|home)\b.*\b(?:lights?|lighting|lit)\b/.test(stripped)
    || /\b(?:lights?|lighting|lit)\b.*\b(?:whole\s+)?(?:house|home)\b/.test(stripped);
  const forgottenCollection = /\b(?:leave|left|forget|forgot)\b.*\b(?:(?:any|all)\s+)?(?:lights?|anything)\b/.test(stripped);
  const unscopedLitCollection = looksLikeImplicitWholeHouseLightCollection(stripped);
  const measurementRequest = /\b(?:electricity|watts?|wattage|kilowatts?|kw|kwh|draw|drawing|usage|using|consumption|consume|consuming|output|generation)\b/.test(stripped)
    || /\b(?:how much|total|average|current|live)\b.*\b(?:power|energy)\b/.test(stripped)
    || /\b(?:power|energy)\b.*\b(?:use|using|used|draw|drawing|consume|consumption|output|generation)\b/.test(stripped);
  const areaScoped = looksAreaScopedLightsQuestion(stripped);
  if (measurementRequest) {
    return false;
  }
  if (!lightingDomain) {
    return false;
  }
  if (!areaScoped && looksLikeImplicitWholeHouseLightCollection(stripped)) {
    return true;
  }
  if (lightingDomain && !areaScoped && (quantifiedCollection || wholeHomeCollection || forgottenCollection || unscopedLitCollection)) {
    return true;
  }
  if (!lightingDomain || areaScoped) {
    return false;
  }
  const wholeHomeScope = /\b(?:house|home|whole|anywhere|somewhere|rooms|anything|everything|all|every|any|around)\b/.test(stripped);
  const collectionRequest = /\b(?:which|what|where|list|scan|summary|status|check|confirm|situation|rundown|picture|overview|report)\b/.test(stripped);
  const lightingState = /\b(?:on|off|lit|dark|left|forgot|forget|glowing|glow|status|summary)\b/.test(stripped);
  if ((lightingState && (wholeHomeScope || collectionRequest))
    || (wholeHomeScope && collectionRequest)
    || /\b(?:house|home) lights?\b/.test(stripped)) {
    return true;
  }
  return /^(?:are there |are |do we have |there are )?any (?:house )?lights (?:still |left )?on$/.test(stripped)
    || /^any (?:house )?lights (?:still |left )?on$/.test(stripped)
    || /^are (?:there )?(?:any )?lights (?:still |left )?on anywhere$/.test(stripped)
    || /^any lights (?:still |left )?on anywhere$/.test(stripped)
    || /^are lights on anywhere$/.test(stripped)
    || /^(?:the )?(?:house )?lights (?:that are |which are )?on$/.test(stripped)
    || /\blights\b.*\b(?:turned |switched )?on\b.*\b(?:house|home)\b/.test(stripped)
    || /\blights\b.*\b(?:house|home)\b.*\b(?:turned |switched )?on\b/.test(stripped)
    || /^(?:which|what) (?:house )?lights are on$/.test(stripped)
    || /^(?:tell me|show me|give me) (?:the )?(?:house )?lights (?:that are |which are )?on$/.test(stripped)
    || /^(?:tell me|show me|give me) which (?:house )?lights are on$/.test(stripped)
    || /^what(?:s| s| is) lit in the (?:house|home)$/.test(stripped)
    || /^(?:which|what) rooms have lights on$/.test(stripped)
    || looksLikeWholeHouseLightScopeQuestion(stripped)
    || (
      /\blights?\b/.test(stripped)
      && /\b(on|lit)\b/.test(stripped)
      && !looksAreaScopedLightsQuestion(stripped)
      && (
        /\b(house|home|rooms|anywhere)\b/.test(stripped)
        || /\bleft\b/.test(stripped)
        || /^do we have\b/.test(stripped)
        || /^are there\b/.test(stripped)
        || /^there are\b/.test(stripped)
        || /\b(?:any|what|which)\b/.test(stripped)
      )
    );
}

export function looksLikeWholeHouseLightScopeQuestion(normalized: string): boolean {
  if (!/\b(light|lights|lighting|lit|glowing)\b/.test(normalized)) {
    return false;
  }
  if (!/\b(on|off|lit|dark|glowing|status|summary|situation)\b/.test(normalized)) {
    return false;
  }
  if (/\bunder house\b/.test(normalized)) {
    return false;
  }
  if (!/\b(house|home|rooms)\b/.test(normalized)) {
    return false;
  }
  return /\b(any|what|which|are|is|show|tell|check|rooms)\b/.test(normalized);
}

type HouseLightRequestedState = "on" | "off";

function requestedHouseLightState(normalized: string): HouseLightRequestedState | null {
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const stateTokens = new Set(["on", "off", "lit", "dark", "glow", "glowing", "out"]);
  const subjectTokens = new Set(["light", "lights", "lighting", "room", "rooms", "anything", "everything", "house", "home"]);
  const actionTokens = new Set(["turn", "turned", "switch", "switched", "set", "make", "made", "change", "changed"]);
  const passiveTokens = new Set(["is", "are", "was", "were", "been", "being"]);
  const clauseBoundaryTokens = new Set(["check", "confirm", "if", "list", "name", "show", "tell", "what", "where", "whether", "which"]);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (!stateTokens.has(token)) continue;

    const windowStart = Math.max(0, index - 10);
    const prior = tokens.slice(windowStart, index);
    const lastSubject = findLastTokenIndex(prior, subjectTokens);
    const lastAction = findLastTokenIndex(prior, actionTokens);
    const actionSeparatedFromSubject = lastAction >= 0
      && lastSubject > lastAction
      && prior.slice(lastAction + 1, lastSubject).some((entry) => clauseBoundaryTokens.has(entry));
    if (lastAction >= 0 && !actionSeparatedFromSubject) {
      const hasExistentialCopula = lastSubject >= 0
        && prior.slice(Math.max(0, lastSubject - 3), lastSubject).some((entry) => passiveTokens.has(entry));
      const isPassiveState = lastSubject >= 0
        && lastSubject < lastAction
        && (hasExistentialCopula
          || prior.slice(lastSubject + 1, lastAction + 1).some((entry) => passiveTokens.has(entry)));
      if (!isPassiveState) continue;
    }

    const hasStatusSubject = lastSubject >= 0;
    const implicitListPredicate = prior.slice(-5).join(" ").match(/\b(?:what s|what is|where is|where are)\b/) !== null;
    if (!hasStatusSubject && !implicitListPredicate) continue;
    const positiveState = token === "on" || token === "lit" || token === "glow" || token === "glowing";
    const negated = tokens[index - 1] === "not";
    return positiveState !== negated ? "on" : "off";
  }
  return null;
}

function findLastTokenIndex(tokens: readonly string[], accepted: ReadonlySet<string>): number {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (accepted.has(tokens[index] ?? "")) return index;
  }
  return -1;
}

function looksLikeHouseLightListQuery(normalized: string): boolean {
  return /\b(?:which|where)\b/.test(normalized)
    || /^(?:list|name|show)\b/.test(normalized)
    || /^(?:report|tell|give)\b.*\b(?:everything|all|lights?|rooms?)\b.*\b(?:that|which)\b.*\b(?:on|off|lit|dark|glowing)\b/.test(normalized)
    || /\bwhat(?: s| is| are)?\b.*\b(?:lights?|rooms?|lit|glowing)\b/.test(normalized)
    || /\b(?:lights?|rooms?)\b\s+(?:that|which)\s+(?:are|were|have been)\b/.test(normalized);
}

function looksLikeUniversalHouseLightQuery(normalized: string): boolean {
  return /\b(?:all|every)\s+(?:of\s+)?(?:the\s+)?(?:single\s+)?(?:house\s+|home\s+)?lights?\b/.test(normalized)
    || /\beverything\b/.test(normalized)
    || /\b(?:house|home)\s+lights?\s+all\b/.test(normalized)
    || /\bwhole\s+(?:house|home)\b.*\b(?:on|off|lit|dark|glowing)\b/.test(normalized)
    || /\b(?:house|home)\b.*\b(?:completely|entirely)\s+(?:lit|dark)\b/.test(normalized);
}

function looksLikeNegativeExistentialHouseLightQuery(normalized: string): boolean {
  return /\bno\s+(?:house\s+|home\s+)?lights?\b/.test(normalized)
    || /\bnone of\s+(?:(?:the|our|my|your)\s+)?(?:house\s+|home\s+)?lights?\b/.test(normalized)
    || /\bnot any\s+(?:of\s+(?:(?:the|our|my|your)\s+)?)?(?:house\s+|home\s+)?lights?\b/.test(normalized)
    || /\b(?:is|are)\s+(?:there\s+)?no\s+(?:house\s+|home\s+)?lights?\b/.test(normalized)
    || /\b(?:is|are)\s+not\s+(?:there\s+)?any\s+(?:of\s+(?:(?:the|our|my|your)\s+)?)?(?:house\s+|home\s+)?lights?\b/.test(normalized)
    || /\b(?:is|are)\s+there\s+not\s+any\s+(?:of\s+(?:(?:the|our|my|your)\s+)?)?(?:house\s+|home\s+)?lights?\b/.test(normalized);
}

function looksLikeNegatedUniversalHouseLightQuery(normalized: string): boolean {
  return /\b(?:is|are)\s+not\s+(?:all|every)\s+(?:of\s+)?(?:the\s+)?(?:single\s+)?(?:house\s+|home\s+)?lights?\b/.test(normalized)
    || /\bnot\s+(?:all|every)\s+(?:of\s+)?(?:the\s+)?(?:single\s+)?(?:house\s+|home\s+)?lights?\b/.test(normalized);
}

function looksLikeNegatedWholeHouseSetQuery(normalized: string): boolean {
  return /\b(?:is|are)\s+not\s+(?:the\s+)?(?:whole\s+)?(?:house|home)\s+(?:lights?|lighting)\b/.test(normalized)
    || /\b(?:is|are)\s+not\s+(?:the\s+)?(?:lights?|lighting)\b.*\b(?:house|home)\b/.test(normalized)
    || /\b(?:is|are)\s+not\s+(?:the\s+)?whole\s+(?:house|home)\b.*\b(?:lit|dark|glowing)\b/.test(normalized);
}

function looksLikeExistentialHouseLightQuery(normalized: string): boolean {
  return /\b(?:any|anything)\b/.test(normalized)
    || /\b(?:is there|are there|there is|there are|can you see|do we have|have we got)\b/.test(normalized)
    || /\b(?:a|one)\s+(?:house\s+)?light\b.*\b(?:anywhere|somewhere)\b/.test(normalized)
    || /\b(?:anywhere|somewhere)\b/.test(normalized);
}

function looksLikeForgottenLightQuery(normalized: string): boolean {
  return /\b(?:leave|left|forget|forgot|forgotten)\b.*\b(?:lights?|anything)\b/.test(normalized)
    || /\b(?:lights?|anything)\b.*\b(?:leave|left|forgotten)\b/.test(normalized);
}

function hasUnsupportedHouseLightPredicate(normalized: string): boolean {
  if (LONGEST_ON_PATTERN.test(normalized)) return false;
  const countRequest = /\b(?:how many|number of|count(?: of)?|total number)\b.*\b(?:lights?|lighting|lit)\b/.test(normalized);
  const appearanceRequest = /\b(?:colou?r|hue|rgb|kelvin|brightness|dimming level|shade)\b/.test(normalized)
    || /\b(?:lights?|lighting)\b.*\b(?:red|green|blue|white|yellow|orange|purple|pink|cyan|magenta)\b/.test(normalized)
    || /\bhow (?:bright|dim)\b/.test(normalized)
    || /\b(?:lights?|lighting)\b.*\b(?:bright|dimmed)\b/.test(normalized);
  const definitionRequest = /\b(?:define|definition|explain|meaning of|what does|how does|how do)\b.*\b(?:lights?|lighting)\b/.test(normalized)
    || /^what (?:is|are) (?:an? |the )?(?:house |home )?(?:lights?|lighting)$/.test(normalized)
    || /\bwhat (?:is|are|do)\b.*\b(?:lights?|lighting)\b.*\b(?:for|mean|used for|do|work)\b/.test(normalized);
  const perfectHistory = /\b(?:ever|never)\b/.test(normalized)
    || PERFECT_HOUSE_LIGHT_HISTORY_PATTERN.test(normalized)
    || SUBJECT_PERFECT_HOUSE_LIGHT_HISTORY_PATTERN.test(normalized)
    || RECENT_PERFECT_HOUSE_LIGHT_HISTORY_PATTERN.test(normalized);
  const historicalRequest = /\b(?:yesterday|last night|earlier|previously|historically|history|ago)\b/.test(normalized)
    || /\b(?:lights?|lighting|house|home)\b.*\bused to (?:be )?(?:on|off|lit|dark|glowing)\b/.test(normalized)
    || /\b(?:when|what time|how long)\b.*\b(?:lights?|lighting|house|home)\b.*\b(?:on|off|lit|dark|glowing|turn|switch)\b/.test(normalized)
    || /\b(?:was|were)\b.*\b(?:lights?|lighting|house|home)\b.*\b(?:on|off|lit|dark|glowing)\b/.test(normalized)
    || /^did (?:the |my |our |any |all )?.*\b(?:lights?|lighting)\b.*\b(?:turn|switch|go|get|become)\b.*\b(?:on|off|lit|dark|glowing)\b/.test(normalized)
    || perfectHistory;
  const futureRequest = /\b(?:will|shall)\b.*\b(?:lights?|lighting|house|home)\b.*\b(?:on|off|lit|dark|glowing|turn|switch)\b/.test(normalized)
    || /\b(?:going to be|scheduled to be)\b.*\b(?:lights?|lighting)\b.*\b(?:on|off|lit|dark|glowing)\b/.test(normalized)
    || /\b(?:lights?|lighting|house|home)\b.*\b(?:will|shall|going to be)\b.*\b(?:on|off|lit|dark|glowing)\b/.test(normalized)
    || /\b(?:lights?|lighting|house|home)\b.*\b(?:on|off|lit|dark|glowing)\b.*\b(?:tomorrow|later|next (?:week|month|night|morning))\b/.test(normalized);
  const controlRequest = /^(?:(?:can|could|would|will) you\s+|should (?:i|we)\s+)?(?:turn|switch|set|make|change|toggle|dim|brighten)\b.*\b(?:lights?|lighting)\b/.test(normalized)
    || /^(?:which|what)\b.*\b(?:lights?|lighting)\b.*\b(?:should|can|could|would) (?:i|we|you)\s+(?:turn|switch|set|change|toggle|dim|brighten)\b/.test(normalized);
  return countRequest || appearanceRequest || definitionRequest || historicalRequest || futureRequest || controlRequest;
}

function hasNamedHouseLightScope(normalized: string): boolean {
  if (/\b(?:lights?|lighting)\s+on\s+(?:the\s+)?(?:house|home)\b/.test(normalized)) {
    return true;
  }
  if (/\b(?:under|beneath|outside|above|below|near|beside|behind) (?:the )?(?:house|home)\b/.test(normalized)) {
    return true;
  }
  if (/\b(?:upstairs|downstairs|outside|outdoor|indoors|indoor)\s+(?:(?:house|home)\s+)?(?:lights?|lighting)\b/.test(normalized)) {
    return true;
  }
  if (/\b(?:lights?|lighting|lit|glowing)\b(?:\s+[a-z0-9]+){0,6}\s+\b(?:upstairs|downstairs|outside|outdoors)\b/.test(normalized)) {
    return true;
  }
  if (/\blights?\s+on\s+the\s+(?!house\b|home\b)[a-z0-9]+\b/.test(normalized)) {
    return true;
  }
  return hasNamedAttributiveHouseLightScope(normalized);
}

function hasNamedAttributiveHouseLightScope(normalized: string): boolean {
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const lightHeads = new Set(["light", "lights", "lighting"]);
  const allowedModifiers = new Set([
    "a", "all", "an", "any", "every", "house", "household", "home", "my", "no", "none", "our", "remaining", "single", "the", "these", "those", "whole", "your",
  ]);
  const boundaries = new Set([
    "are", "around", "at", "been", "can", "check", "confirm", "dark", "did", "do", "does", "exactly", "for", "forget", "forgot", "give", "glowing", "got", "had", "has", "have", "if", "is", "just", "leave", "left", "list", "lit", "me", "name", "not", "now", "of", "off", "on", "only", "out", "quick", "scan", "see", "show", "still", "tell", "there", "to", "was", "we", "were", "what", "where", "whether", "which", "will", "would", "you",
  ]);

  for (let index = 0; index < tokens.length; index += 1) {
    if (!lightHeads.has(tokens[index] ?? "")) continue;
    for (let offset = 1; offset <= 3 && index - offset >= 0; offset += 1) {
      const modifier = tokens[index - offset] ?? "";
      if (allowedModifiers.has(modifier)) continue;
      if (boundaries.has(modifier)) break;
      return true;
    }
  }
  return false;
}

function houseLightsStatusQuantifier(operation: HouseLightsStatusOperation): HouseLightsStatusQuantifier {
  switch (operation) {
    case "any_on": return "any";
    case "all_on": return "all";
    case "any_off": return "any";
    case "all_off": return "all";
    case "list_on": return "which";
    case "list_off": return "which";
    case "longest_on": return "which";
    case "summary": return null;
  }
}

function normalizeGlobalLightsStatusText(normalized: string): string {
  let stripped = normalizeQuestionLeadIn(stripStatusFiller(normalized))
    .replace(/^(?:and|then|so)\s+/, "");
  const leadIns = [
    /^(?:check|tell me|show me|give me|let me know)\s+/,
    /^(?:can you tell me|can you show me)\s+/,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of leadIns) {
      const next = stripped.replace(pattern, "").trim();
      if (next !== stripped) {
        stripped = next;
        changed = true;
      }
    }
  }
  return stripped
    .replace(/^there are\s+any /, "are there any ")
    .replace(/^there are\s+/, "are there ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksAreaScopedLightsQuestion(normalized: string): boolean {
  if (looksLikeImplicitWholeHouseLightCollection(normalized)) {
    return false;
  }
  if (/\bin (?:the )?(?:house|home)\b/.test(normalized)
    || /\banywhere\b/.test(normalized)
    || /^(?:what|which) rooms?\b.*\b(?:lights?|lit|dark)\b/.test(normalized)
    || /^(?:are there (?:any )?|do we have (?:any )?|any )lights?\b/.test(normalized)) {
    return false;
  }
  if (/\blit\b.*\bin (?!the (?:house|home)\b)(?:the )?[a-z]/.test(normalized)) {
    return true;
  }
  const scopedStateSubject = /^(?:are |is )?(?:not )?(?:any |all |which |what )?(.+?) (?:still )?(?:lit|dark)$/.exec(normalized)?.[1] ?? "";
  if (scopedStateSubject
    && !/\b(?:report|tell|show|give|check|list|everything|anything|all|any|every|what|which)\b/.test(scopedStateSubject)
    && !/^(?:anything|everything|what(?: is)?|which|house|home|whole house|whole home|rooms?|lights?|lighting)$/.test(normalizeHouseLightTargetText(scopedStateSubject))) {
    return true;
  }
  const areaCandidateText = normalized
    .replace(/^(?:what is|what are|which|check|confirm|verify|tell me|show me|give me|list|name|where are)\s+(?:the )?/, "")
    .replace(/^(?:have|did)\s+(?:i|we)\s+(?:left|leave)\s+/, "")
    .replace(/^(?:are there (?:any )?|are |is |were |was |do we have |have )/, "")
    .trim();
  const prefixedAreaLightsMatch = /^(.+?) (?:lights?|lighting)\b/.exec(areaCandidateText);
  const prefixedArea = normalizeHouseLightTargetText(prefixedAreaLightsMatch?.[1] ?? "");
  const quantifiedArea = prefixedArea.replace(/^(?:any|all|every|the)(?:\s+|$)/, "");
  const semanticArea = quantifiedArea
    .replace(/\b(?:still|currently|on|off|lit|dark|glowing|is|are|was|were)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/\bunder (?:the )?house\b/.test(prefixedArea)) {
    return true;
  }
  if (
    semanticArea
    && !/\b(?:what|which|where|list|scan|check|confirm|tell|show|give|quick|for|whole|house|home)\b/.test(semanticArea)
    && !/\b(?:house|home)\b/.test(semanticArea)
  ) {
    return true;
  }
  return /\blights?\b.*\bin (?!the (?:house|home)\b)(?:the )?[a-z]/.test(normalized)
    || /\bin (?!the (?:house|home)\b)(?:the )?.+\blights?\b/.test(normalized);
}

function looksLikeImplicitWholeHouseLightCollection(normalized: string): boolean {
  if (/\b(?:under|beneath) (?:the )?house\b/.test(normalized)) return false;
  if (/\b(?:in|inside|under|beneath|by|near) (?!the (?:house|home)\b)(?:the )?[a-z]/.test(normalized)) return false;
  const lightMeaning = /\b(?:lights?|lighting|lit|glowing)\b/.test(normalized);
  if (!lightMeaning) return false;
  return /^(?:what|which) (?:house )?lights?\b/.test(normalized)
    || /^(?:the )?lights?\s+(?:that|which)\s+(?:are|were|have been)\s+(?:on|off|lit|dark|glowing)\b/.test(normalized)
    || /^(?:what(?: is| s)?|where(?: are| is)?) (?:still )?(?:lit|glowing)\b/.test(normalized)
    || /^(?:what|which) rooms?\b.*\b(?:lights?|lit|glowing|on)\b/.test(normalized)
    || /^where (?:are|is) (?:the )?lights?\b/.test(normalized)
    || /^(?:is there|are there|can you see|do we have|have we got)\b.*\b(?:any|a|every)\s+(?:house\s+)?lights?\b.*\b(?:on|off|lit|glowing)\b/.test(normalized)
    || /^(?:any|all|every) (?:house )?lights?\b/.test(normalized)
    || /^(?:anything|everything)\b.*\b(?:on|off|lit|glowing)\b/.test(normalized)
    || /^(?:did|have) (?:i|we)\b.*\b(?:leave|left|forget|forgot)\b.*\b(?:(?:any|every)\s+(?:house\s+)?lights?|anything)\b/.test(normalized)
    || /\b(?:any|all|every)\s+(?:house\s+)?lights?\b/.test(normalized)
    || /\blights?\b.*\b(?:somewhere|anywhere|around (?:the )?(?:house|home))\b/.test(normalized);
}

function normalizeHouseLightTargetText(value: string): string {
  return stripStatusFiller(value)
    .replace(/\b(?:the|my)\b/g, " ")
    .replace(/\bsensors?\b$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHouseLightStatusSurface(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTypedHouseLightStatusSurface(value: string): string {
  return canonicalizeLeadingQuestionContractions(normalizeHouseLightStatusSurface(value))
    .replace(/\bhasn t\b/g, "has not")
    .replace(/\bhaven t\b/g, "have not")
    .replace(/\bhadn t\b/g, "had not")
    .replace(/\s+/g, " ")
    .trim();
}
