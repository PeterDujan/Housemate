/**
 * Evaluative-judgement grammar.
 *
 * A question asks for a judgement, not a fact, when its main predicate is
 * inherently evaluative (overrated, worth doing, a good idea, better to...) or
 * when it asks the addressee to judge something ("what do you make of",
 * "do you reckon... Is the best"). Such questions have no source-backed
 * answer, so they belong to open conversation and must never be settled, or
 * re-routed, by a knowledge lookup. Measurable superlatives, prices, net worth,
 * value comparisons, and judgements attributed to someone else stay factual.
 */

const JUDGEMENT_PREDICATE = "(?:overrated|underrated|overhyped|underappreciated|overpriced)";
const JUDGEMENT_ADJECTIVE = "(?:beautiful|boring|annoying|enjoyable|interesting|impressive|fun|pointless|satisfying)";
const ADVISABILITY = "(?:a )?(?:good|bad|smart|sensible|wise|dumb|stupid|silly|terrible|great) (?:idea|move|call|choice)";
const WORTH_OBJECT = [
  "it",
  "(?:the )?(?:money|effort|time|hype|price|cost|wait|trouble|bother|investment|risk|upgrade)",
  "a (?:visit|look|watch|read|listen|try|go|shot|punt)",
  "(?!(?:any|some|no|every)thing\\b)[a-z]+ing",
].join("|");
const WORTH_OF_DOING = new RegExp(`\\bworth (?:(?:really|actually|even) )?(?:${WORTH_OBJECT})\\b|\\bworthwhile\\b`);
const INHERENT_JUDGEMENT = new RegExp(`\\b${JUDGEMENT_PREDICATE}\\b`);
const EVALUATIVE_COMPLEMENT = new RegExp(
  `\\b(?:best|worst|greatest|finest|better|worse|favo(?:u)?rite|any good|good value|${JUDGEMENT_PREDICATE}`
  + `|(?:most|least) ${JUDGEMENT_ADJECTIVE}|${ADVISABILITY})\\b`,
);
const ATTRIBUTED_JUDGEMENT = /\b(?:called|described|named|labell?ed|voted|ranked|listed|considered|regarded|dubbed|according to|critics?|reviewers?|surveys?|polls?)\b/;
const ADDRESSEE_COGNITION = /\b(?:do|did|would|will) you (?:(?:really|honestly|personally|actually) )?(?:reckon|think|figure|suppose|say|believe)\b|\bin your (?:honest )?(?:opinion|view|book|estimation)\b/;
const POLAR_LEAD = /^(?:is|are|was|were|would|will|isn t|aren t|wasn t|wouldn t)\b/;
const QUESTION_LEAD = /^(?:is|are|was|were|would|will|isn t|aren t|wasn t|wouldn t|what|which|who|whose)\b/;

function normalizeJudgementText(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[’']/g, " ")
    .replaceAll(/[^\p{L}\p{N}\s]+/gu, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function asksWorthOfDoing(text: string): boolean {
  return WORTH_OF_DOING.test(text)
    && !/\b(?:how much|net worth|worth of)\b/.test(text);
}

function asksAdvisability(text: string): boolean {
  return new RegExp(`^(?:is|was|would|will|isn t|wouldn t) (?:it|that|this) (?:(?:really|actually) )?(?:be )?${ADVISABILITY}\\b`).test(text)
    || /^(?:is|would|isn t|wouldn t) it (?:(?:really|actually) )?(?:be )?(?:better|best|wiser|smarter|worse) to\b/.test(text);
}

/**
 * True when the question's own predicate is a judgement with no holder named:
 * "Is it worth learning chess as an adult?", "Is jazz overrated?",
 * "Is it better to rent or buy?". It says nothing about who holds the view.
 */
export function looksLikeEvaluativeJudgementPrompt(value: string): boolean {
  const text = normalizeJudgementText(value);
  if (!text || ATTRIBUTED_JUDGEMENT.test(text)) {
    return false;
  }
  if (POLAR_LEAD.test(text) && (asksWorthOfDoing(text) || asksAdvisability(text))) {
    return true;
  }
  return QUESTION_LEAD.test(text) && INHERENT_JUDGEMENT.test(text);
}

/**
 * True when the speaker asks the assistant to judge something: "What do you make of
 * X?", "How do you feel about X?", or a holder frame ("do you reckon/think",
 * "in your opinion") whose complement is evaluative. A holder frame around a
 * factual complement ("what do you think is the capital of Australia?") is not
 * a judgement request. Stance adjuncts attach to the whole utterance, so
 * callers should also test the full surface, not only the dominant clause.
 */
export function looksLikeAddresseeJudgementPrompt(value: string): boolean {
  const text = normalizeJudgementText(value);
  if (!text) {
    return false;
  }
  if (/\bwhat (?:do|did|would) you (?:(?:honestly|really|personally) )?make of\b/.test(text)
    || /\bhow (?:do|did|would) you (?:(?:honestly|really|personally) )?feel about\b/.test(text)
    || /\b(?:what is|what s|whats) your (?:honest )?(?:take|verdict|view|opinion|thoughts) (?:on|of|about)\b/.test(text)) {
    return true;
  }
  if (!ADDRESSEE_COGNITION.test(text) || ATTRIBUTED_JUDGEMENT.test(text)) {
    return false;
  }
  return hasEvaluativeComplement(text.slice(text.search(ADDRESSEE_COGNITION)));
}

/**
 * True when a clause's predicate is evaluative (best, overrated, worth doing,
 * a good idea...). Used to bind a holder stance found elsewhere in the
 * utterance to the dominant clause without letting it capture an unrelated
 * factual or house question.
 */
export function hasEvaluativeComplement(value: string): boolean {
  const text = normalizeJudgementText(value);
  return EVALUATIVE_COMPLEMENT.test(text)
    || asksWorthOfDoing(text)
    || looksLikeEvaluativeJudgementPrompt(text);
}
