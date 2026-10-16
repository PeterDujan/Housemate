import { looksLikeAddresseeJudgementPrompt } from "./evaluative-judgement.js";
import { canonicalizeRoutingText } from "./routing-text.js";
import { normalizeSpeechForRouting } from "./speech-normalizer.js";

const DIRECT_PREFERENCE_NOUN = "(?:(?:least\\s+)?favo(?:u)?rite|preferred|preference|preferences|taste|tastes|top choice|first choice)";
// "barrack" is the Australian verb for backing a team.
const SUBJECTIVE_VERB = "(?:like|love|enjoy|prefer|favo(?:u)?r|admire|appreciate|respect|value|barrack)";
const EVALUATIVE_VERB = "(?:rate|rank|score)";
const EVALUATIVE_ADJECTIVE = "(?:best|worst|most|least|compelling|interesting|appealing|beautiful|important|impressive|engaging|persuasive)";
const OPTIONAL_ADVERBS = "(?:(?:personally|really|actually|generally|usually|especially|particularly|simply|rather|honestly)\\s+){0,3}";
const DIRECT_PREFERENCE_PATTERN = new RegExp(`\\byour\\s+${DIRECT_PREFERENCE_NOUN}\\b`);
const SUBJECTIVE_AUXILIARY_PATTERN = new RegExp(`\\b(?:do|did|would|could|can|will) you\\s+${OPTIONAL_ADVERBS}${SUBJECTIVE_VERB}\\b`);
const SUBJECTIVE_SUPERLATIVE_PATTERN = new RegExp(`\\byou\\s+${OPTIONAL_ADVERBS}${SUBJECTIVE_VERB}\\s+(?:the\\s+)?(?:most|best|least)\\b`);
const EVALUATIVE_AUXILIARY_PATTERN = new RegExp(`\\b(?:do|did|would|could|can) you\\s+${OPTIONAL_ADVERBS}${EVALUATIVE_VERB}\\b`);
const EVALUATIVE_ADJECTIVE_PATTERN = new RegExp(`\\b(?:do|did|would|could) you\\s+${OPTIONAL_ADVERBS}(?:find|consider|regard)\\b.{0,80}\\b${EVALUATIVE_ADJECTIVE}\\b`);
const ACTION = "(?:turn|switch|toggle|set|make|open|close|shut|lock|unlock|enable|disable|start|stop|pause|resume|dock|raise|lower|play|queue|add|create|delete|remove|forget|remember)";
const MODAL_ACTION_PATTERN = new RegExp(`^(?:can|could|would|will) you\\s+(?:please\\s+)?${ACTION}\\b`);
const TRAILING_ACTION_PATTERN = new RegExp(`\\b(?:and|then)\\s+(?:please\\s+)?${ACTION}\\b`);
const SELF_HOLDER_SIGNAL = /\b(?:you|your)\b/i;
const SUBJECTIVE_SIGNAL = /\b(?:favo(?:u)?rite|preferred|preference|taste|like|love|enjoy|prefer|favo(?:u)?r|admire|appreciate|respect|value|barrack|rate|rank|score|find|consider|regard|appeal|appeals|appealed|suit|suits|drawn|partial|rather|choose|pick|keep|save|select)\b/i;

/**
 * True only when the speaker is asking the assistant for the assistant's own subjective
 * preference, evaluation, or hypothetical choice. Another person's favourite
 * remains a memory or knowledge question; a factual superlative remains
 * general knowledge.
 */
export function looksLikeAssistantSelfOpinionPrompt(value: string): boolean {
  if (!SELF_HOLDER_SIGNAL.test(value)) {
    return false;
  }
  const normalized = normalizeSpeechForRouting(value);
  const text = /^(?:if you|would you rather)\b/.test(normalized)
    ? normalized
    : canonicalizeRoutingText(normalized);
  if (!text || containsActionDirective(text)) {
    return false;
  }

  // Holder frames are read before canonicalisation, which strips courtesy
  // modals such as "would you" from "would you say X is overrated".
  if (looksLikeAddresseeJudgementPrompt(normalized) || looksLikeAddresseeJudgementPrompt(text)) {
    return true;
  }
  if (!SUBJECTIVE_SIGNAL.test(text)) {
    return false;
  }

  const questionLead = /^(?:what|which|who|how|do|did|would|could|can|will|if)\b/.test(text);
  if (!questionLead) {
    return false;
  }

  if (DIRECT_PREFERENCE_PATTERN.test(text)
    || /\b(?:appeals?|appealed) to you\b/.test(text)
    || /\bsuits? your taste\b/.test(text)
    || /\b(?:are|were|would be) you (?:most |least )?(?:drawn|partial) to\b/.test(text)) {
    return true;
  }

  if (SUBJECTIVE_AUXILIARY_PATTERN.test(text)
    || SUBJECTIVE_SUPERLATIVE_PATTERN.test(text)
    || /\bwould you rather\b/.test(text)) {
    return true;
  }

  if (EVALUATIVE_AUXILIARY_PATTERN.test(text)
    || EVALUATIVE_ADJECTIVE_PATTERN.test(text)) {
    return true;
  }

  if (/\b(?:what|which|who)\b.{0,120}\bwould you\s+(?:(?:personally|actually|really)\s+)?(?:choose|pick|keep|save|select)\b/.test(text)) {
    return true;
  }

  return /^if you (?:could|had to|were (?:able|allowed) to)\b.{1,140}\b(?:what|which|who) would (?:it|that|they) be\b/.test(text);
}

function containsActionDirective(text: string): boolean {
  return MODAL_ACTION_PATTERN.test(text)
    || TRAILING_ACTION_PATTERN.test(text)
    || /\b(?:turn|switch|toggle|set|make|open|close|shut|lock|unlock|enable|disable|start|stop|pause|resume|dock|raise|lower|play|queue|add|create|delete|remove|forget|remember)\s+(?:it|that|this|them|those|the (?:light|lights|song|track|music|device|devices|door|doors))\b/.test(text);
}
