import { normalizeQuestionLeadIn } from "./routing-text.js";
import { normalizeSpeechForRouting } from "./speech-normalizer.js";
import { householdPersonByName, householdRegex } from "./household.js";
import { assistantNamePattern, persona } from "./persona.js";

export type AssistantSystemIntent =
  | { readonly kind: "speaker_identity" }
  | { readonly kind: "runtime_health"; readonly fact: "ready" | "locked" };

/**
 * What a sincere question about the assistant himself is asking: what he is, whether
 * he is conscious, alive or feels, his body, his memory, or which mind is
 * speaking. Code answers these from fixed facts.
 */
export type AssistantSelfTopic =
  | "nature"
  | "conscious"
  | "alive"
  | "feelings"
  | "body"
  | "memory"
  | "mind"
  | "maker"
  | "age"
  | "name"
  | "changed"
  | "control";

export interface AssistantSelfQuestion {
  readonly topic: AssistantSelfTopic;
  /** The question points at the previous reply ("was that Claude?"). */
  readonly previousReply: boolean;
}

export interface BasicSpeakerIdentityIntent {
  readonly mode: "question" | "statement";
  readonly claimedName: string | null;
}

export interface BasicSystemHealthIntent {
  readonly topic: "health" | "status" | "readiness";
  readonly fact: "ready" | "locked" | "health";
}

/**
 * Distinguish questions about the assistant and the current speaker from similarly
 * worded questions about house entities. This is an addressee/predicate parse,
 * not a list of complete benchmark phrases.
 */
export function parseAssistantSystemIntent(
  input: string,
  options: { readonly question: boolean } = { question: true },
): AssistantSystemIntent | null {
  const text = normalize(input);
  if (looksLikeSpeakerIdentityIntent(text, options.question)
    && !isExternalAssistantSpeechContext(text)
    && !isAssistantSelfIdentityContext(text)
    && !isThirdPartyIdentityContext(text)
    && !parseAssistantSelfQuestion(input)) {
    return { kind: "speaker_identity" };
  }
  if (!options.question) {
    return null;
  }
  if (looksLikeLockedControlIntent(text) && hasAssistantRuntimeSubject(text)) {
    return { kind: "runtime_health", fact: "locked" };
  }
  if (looksLikeRuntimeReadinessIntent(text) && hasAssistantRuntimeSubject(text)) {
    return { kind: "runtime_health", fact: "ready" };
  }
  return null;
}

/** Legacy standalone identity fallback used after the assistant-system boundary. */
export function parseBasicSpeakerIdentityIntent(input: string): BasicSpeakerIdentityIntent | null {
  const normalized = normalize(input);
  if (/\b(?:talking|speaking)\s+(?:about|of)\b/.test(normalized)
    || isExternalAssistantSpeechContext(normalized)
    || isAssistantSelfIdentityContext(input)
    || isThirdPartyIdentityContext(input)
    || parseAssistantSelfQuestion(input)) {
    return null;
  }
  const questionText = stripCasualQuestionTail(normalizeQuestionLeadIn(normalized));
  const statementText = stripCasualQuestionTail(normalized);
  if (looksLikeSpeakerIdentityQuestion(questionText)) {
    return { mode: "question", claimedName: claimedSpeakerName(questionText) };
  }
  if (looksLikeSpeakerIdentityStatement(statementText)) {
    return { mode: "statement", claimedName: claimedSpeakerName(statementText) };
  }
  return null;
}

/** Broad health/status wording, constrained to the assistant and its runtime policy. */
export function parseBasicSystemHealthIntent(input: string): BasicSystemHealthIntent | null {
  const normalized = normalize(input);
  const stripped = withoutPersonReadiness(stripCasualQuestionTail(normalizeQuestionLeadIn(normalized).replace(/^(?:one thing|quick thing)\s*,?\s*/g, "")));
  if (!stripped || !hasAssistantRuntimeSubject(stripped)) {
    return null;
  }
  const systemScope = householdRegex(String.raw`\b(?:{ASSISTANT}|system|brain|service|runtime|core routes?|actions?|action boundary|safety|operating mode|readiness|ready|healthy|health)\b`).test(stripped);
  const healthPredicate = /\b(?:status|health|healthy|check|mode|locked|enabled|ready|readiness|available|operating|running|normal|normally)\b/.test(stripped);
  const matched = householdRegex(String.raw`\b(system health|health check|{ASSISTANT} status)\b`).test(stripped)
    || stripped === "status"
    || /^(?:quick|brief|current|overall) status$/.test(stripped)
    || /^(?:check|show|tell me|give me) status$/.test(stripped)
    || householdRegex(String.raw`\bhealthy\b.*\b{ASSISTANT}\b|\b{ASSISTANT}\b.*\bhealthy\b`).test(stripped)
    || /\bwhat (?:status|mode) are you (?:in|running)\b/.test(stripped)
    || (systemScope && healthPredicate);
  if (!matched) {
    return null;
  }
  const fact = /\b(?:locked|safety|action boundary|actions?)\b/.test(stripped)
    ? "locked"
    : /\b(?:health|healthy)\b/.test(stripped)
      ? "health"
      : "ready";
  const topic = /\b(?:health|healthy)\b/.test(stripped)
    ? "health"
    : /\b(?:ready|readiness|available)\b/.test(stripped)
      ? "readiness"
      : "status";
  return { topic, fact };
}

/**
 * `question` is false when the turn is a statement. A statement only counts as
 * identity talk when it explicitly names or claims the speaker; inferring an
 * identity question from co-occurring words ("conversation", "you", "who")
 * applies to questions alone.
 */
function looksLikeSpeakerIdentityIntent(text: string, question: boolean): boolean {
  // "Talking about X" names the topic of speech, not the identity of the
  // current speaker. Do not let first/second-person complaint wording turn
  // that complement into a speaker-identification request.
  if (/\b(?:talking|speaking)\s+(?:about|of)\b/.test(text)) {
    return false;
  }
  // "the owner's location, not his identity" contains identity vocabulary, but
  // the contrast makes location the requested predicate. Keep the boundary
  // structural so other presence questions are not stolen by system routing.
  if (/\b(?:location|presence)\b.*\b(?:rather than|instead of|not)\b.*\bidentity\b/.test(text)) {
    return false;
  }
  if (householdRegex(String.raw`\b(?:you should know|chats?\b.*\bfrom me|chat dashboard)\b[\s\S]*\bi am\s+{NAMES}\b`).test(text)) {
    return false;
  }
  const speakerSubject = /\b(?:speaker|speaking|talking|voice|identity|identified|name|person|conversation|turn)\b/.test(text);
  const selfOrAddressee = /\b(?:i|me|my|this|current|you|your)\b/.test(text);
  const identityPredicate = /\b(?:who|identify|identified|identity|have|got|think|answering|talking|speaking|attached|current)\b/.test(text);
  const namedSpeakerRelation = householdRegex(String.raw`\b{NAMES}\b`).test(text)
    && (/\b(?:i am|i m|me as|my (?:name|identity)|speaker|speaking|talking|voice|identified|identity)\b/.test(text)
      || /\bcurrent\s+speaker\b/.test(text)
      || /\bthis\s+is\b/.test(text));
  const short = isShortTurn(text);
  return /\b(?:who am i|who i am|identify me|my identity|my name)\b/.test(text)
    || /\b(?:who|what name)\b.*\b(?:have|got|identify|identified)\b.*\bme\b.*\b(?:as|down as)\b/.test(text)
    || (short && /\bwho\b.*\b(?:speaking|talking|answering)\b/.test(text))
    || /\bwhose\s+voice\b/.test(text)
    || (short && /\bwho\b.*\byou\b.*\b(?:talking|speaking|answering)\b/.test(text))
    || (question && short && speakerSubject && selfOrAddressee && identityPredicate && !contentInstructionLead().test(text))
    || (short && namedSpeakerRelation);
}

/**
 * Identity inferred from co-occurring words ("speaking", "you", "who") is only
 * plausible in a short question. A long turn that tells a story ("she makes
 * videos of herself speaking to the camera... What do you") is talk, not a
 * request to identify the speaker. Such a turn got "You are
 * The owner." Explicit forms ("who am I", "my name") are not length-gated.
 */
const SHORT_TURN_MAX_WORDS = 12;

function isShortTurn(text: string): boolean {
  return text.split(" ").filter(Boolean).length <= SHORT_TURN_MAX_WORDS;
}

export function isExternalAssistantSpeechContext(input: string): boolean {
  const text = normalize(input);
  const externalComplement = /\b(?:speaking|talking|presenting|answering)\s+(?:at|during|for|on|in)\b/.test(text);
  const currentConversation = /\b(?:here|current (?:speaker|voice|conversation|turn)|this (?:conversation|chat|turn)|right now)\b/.test(text);
  return externalComplement && !currentConversation;
}

export function isAssistantSelfIdentityContext(input: string): boolean {
  const text = normalize(input);
  const secondPersonIdentity = householdRegex(String.raw`\b(?:who|what)\s+(?:are|were)\s+you(?:\s+(?:really|then))?(?:\s+{ASSISTANT})?$`).test(text)
    || /\byour\s+(?:name|identity)\b/.test(text)
    || /\b(?:identify|describe)\s+yourself\b/.test(text)
    // In "who you are speaking to", `you` is the addressee doing the
    // speaking; it is not the subject of the requested identity.
    || /\bwho you are(?!\s+(?:speaking|talking|answering)\b)/.test(text)
    || /\bwhat to call you\b/.test(text);
  const firstPersonAsksForAddressee = /\bwho\s+am\s+i\s+(?:speaking|talking)\s+(?:to|with)\b/.test(text)
    || /\bhow\s+should\s+i\s+(?:address|refer to|call)\s+you\b/.test(text);
  return secondPersonIdentity || firstPersonAsksForAddressee;
}

/** Reject identity questions whose grammatical subject is some third party. */
export function isThirdPartyIdentityContext(input: string): boolean {
  const text = normalize(input);
  const interrogativeSpeakerWithComplement = /\bwho\s+(?:is|was|are|were)\s+(?:the\s+person\s+)?(?:talking|speaking|answering)\s+(?:to|with)\s+(?!you\b|ya\b)/.test(text);
  if (interrogativeSpeakerWithComplement) {
    return true;
  }
  const relation = /\bwho\s+(?:is|was|are|were)\s+(.+?)\s+(?:talking|speaking|answering)(?:\s+(?:to|with))?\b/.exec(text);
  if (relation?.[1]) {
    const subject = relation[1].replace(/^(?:the )/, "").trim();
    if (!/^(?:you|current speaker|speaker|person|person speaking)$/.test(subject)) {
      return true;
    }
  }
  return /\bwhose\s+voice\s+(?:is|was)\s+.+?\s+using\b/.test(text);
}

/** Require the health predicate to belong to the assistant/runtime policy, not a house or software noun phrase. */
export function hasAssistantRuntimeSubject(input: string): boolean {
  const text = normalize(input);
  if (/\b(?:operating system|code|codebase|software project|repository|repo|branch|build|version|release|development|source tree)\b/.test(text)) {
    return false;
  }
  const policySubject = /\b(?:device actions?|action boundary|device control|control policy|read[ -]?only)\b/.test(text)
    || (/\bactions?\b/.test(text) && /\b(?:locked|enabled|disabled|allowed|control|change|read[ -]?only)\b/.test(text));
  if (policySubject) {
    return true;
  }
  const explicitAssistantSubject = householdRegex(String.raw`\b(?:you|your|{ASSISTANT}|your end)\b`).test(text);
  const externallyOwnedRuntime = /\b(?:system|service|runtime|brain)\s+(?:(?:used|owned|run|operated)\s+by|for|in|inside|serving|attached\s+to|connected\s+to)\b/.test(text);
  if (externallyOwnedRuntime && !explicitAssistantSubject) {
    return false;
  }
  for (const match of text.matchAll(/\b([a-z]+)\s+(?:system|service|runtime|brain)\b/g)) {
    const modifier = match[1] ?? "";
    if (!["a", "the", "this", "your", "core"].includes(modifier) && !persona().aliases.includes(modifier)) {
      return false;
    }
  }
  const houseSubject = /\b(?:alarm|door|gate|garage|window|blind|shade|curtain|light|lamp|heater|heating|fan|vacuum|computer|outlet|switch|sensor)\b/.test(text);
  if (houseSubject) {
    return false;
  }
  const assistantSubject = explicitAssistantSubject;
  const runtimeSubject = /^(?:(?:what|how) (?:is|are) |(?:is|are|check|show|give me|tell me) )?(?:the )?(?:system|service|runtime|brain|core routes?)\b/.test(text)
    || /\b(?:status|health|readiness) (?:of|for) (?:the )?(?:system|service|runtime|brain|core routes?)\b/.test(text);
  const bareRuntimeRequest = householdRegex(String.raw`^(?:(?:quick|brief|current|overall) )?(?:status|health check|system health|{ASSISTANT} status)(?: please)?$`).test(text)
    || /^(?:everything )?(?:ready|healthy|working)(?: to go)?$/.test(text);
  return assistantSubject || runtimeSubject || bareRuntimeRequest;
}

// Self-question grammar. The subject is the assistant (second person or his name) and
// the predicate is one of his own properties; a question about anything else
// (another assistant, the house, what he meant) has a different subject or a
// complement and stays off this route.
const SELF_ADVERBS = "(?:(?:actually|really|truly|even|ever|just|honestly|genuinely|in fact|still|currently|now)\\s+)*";
// A belief frame around the question asks the same thing: "do you believe
// that you are conscious?", "would you call yourself alive?".
const SELF_BELIEF = `(?:(?:do you ${SELF_ADVERBS}(?:think|believe|reckon|feel|suppose)|would you say|is it true) (?:that )?)`;
const SELF_COPULA = `(?:${SELF_BELIEF}?(?:are you|you are|you re|is ${assistantNamePattern()})|(?:do you ${SELF_ADVERBS}(?:consider|count|see|think of) yourself|would you (?:call|consider|describe) yourself)(?: as| to be)?) ${SELF_ADVERBS}`;
const SELF_HAVE = `(?:do you have|have you got|do you ever have) ${SELF_ADVERBS}(?:a |an |any )?`;
const MIND_NAME = "(?:claude|chatgpt|chat gpt|codex|gpt(?: [0-9.]+)?|open ai|openai|anthropic|gemini|siri|alexa|google|(?:an? |the )?(?:ai |language |large language )?model|an? llm|llm|an? ai|ai|a bot|a robot|a person|a human)";
const MIND_OR_CODE = `(?:(?:from )?(?:you|${assistantNamePattern()}|code|just code|${MIND_NAME}))`;
const MIND_SOURCE = `(?:from code|just code|(?:from )?${MIND_NAME})`;
const REPLY_REF = "(?:that|this)(?: (?:answer|reply|one|last answer|last reply))?";

// What he can work. Devices in general, never one named device
// ("can you control the lights?" stays with the device owners).
const CONTROL_VERB = "(?:control|operate|work|switch|turn|switch on|turn on|switch off|turn off|switch on and off|turn on and off|switch on or off|turn on or off)";
const CONTROL_THINGS = "(?:devices|things|stuff|appliances|gadgets)";
const CONTROL_SCOPE = "(?: (?:in|around) (?:the|this|my|our) house| here| at home| for (?:me|us)| by voice| with your voice)?";
const CONTROL_ABLE = `(?:can you|could you|do you|are you able to|are you allowed to|re you (?:able|allowed) to) ${SELF_ADVERBS}`;

const SELF_TOPIC_GRAMMAR: readonly (readonly [AssistantSelfTopic, RegExp])[] = [
  ["conscious", new RegExp(`^${SELF_COPULA}(?:a )?(?:conscious|sentient|self aware|aware of yourself|conscious being|sentient being)(?: or not)?$`)],
  ["conscious", new RegExp(`^${SELF_HAVE}(?:consciousness|conscious mind|inner life|soul|mind of your own|self awareness)$`)],
  ["conscious", /^what (?:is |s )?it like (?:to be|being) you$/],
  // Answered from his own version history, never by the model.
  ["changed", /^(?:how (?:have|did|has) you (?:changed|grown)(?: (?:so far|lately|over time|since you started))?|(?:have|did) you (?:changed|grown)(?: (?:at all|much|lately|over time|since you started))?|how (?:are|re) you different(?: (?:now|these days|from before|from when you started))?|what (?:has |have |s )?changed (?:about|in) you(?: lately)?|in what ways? (?:have|did) you (?:changed|grown))$/],
  ["conscious", /^(?:is there )?(?:anyone|anybody|someone|somebody) (?:in there|home)$/],
  ["alive", new RegExp(`^${SELF_COPULA}(?:alive|a living (?:thing|being)|living)(?: or not)?$`)],
  ["feelings", new RegExp(`^(?:do|can) you ${SELF_ADVERBS}(?:have|feel|experience|get) (?:any )?(?:feelings|emotions|anything|things|pain|happiness|sadness|lonely|bored)$`)],
  ["feelings", new RegExp(`^(?:do|can) you ${SELF_ADVERBS}feel$`)],
  ["feelings", new RegExp(`^${SELF_HAVE}(?:feelings|emotions)$`)],
  ["nature", /^what (?:exactly |actually )?(?:are you|you are)(?: exactly| actually)?$/],
  ["nature", /^what (?:kind|sort|type) of (?:thing|being|creature|entity|machine|assistant) (?:are you|you are)$/],
  ["nature", new RegExp(`^${SELF_COPULA}(?:a |an )?(?:real )?(?:person|human|human being|people|robot|bot|chatbot|chat bot|machine|computer|computer program|program|software|ai|artificial intelligence|real)(?: or (?:a |an )?(?:real )?(?:person|human|robot|bot|machine|computer|program|software|ai|real|not))?$`)],
  ["body", new RegExp(`^${SELF_HAVE}(?:body|physical body|face|physical form|shape)$`)],
  ["body", /^(?:what|where) (?:is |s )?your body$/],
  ["body", /^is (?:the|this) house your body$/],
  ["body", new RegExp(`^where (?:do you|does ${assistantNamePattern()}) ${SELF_ADVERBS}(?:live|exist|run|stay)$`)],
  ["body", new RegExp(`^where are you ${SELF_ADVERBS}(?:physically|located|kept|running|living|based|from)$`)],
  ["body", /^what do you look like$/],
  ["memory", /^how (?:does|do) (?:your memory|you remember(?: things| stuff)?)(?: actually)?(?: work)?$/],
  ["memory", /^(?:how|what) (?:is |s )?your memory(?: like)?$/],
  ["memory", new RegExp(`^(?:do|can|will|would) you ${SELF_ADVERBS}(?:remember|recall|keep) (?:things|stuff|anything|what (?:we|i) (?:say|said|talk about|talked about|tell you|told you)|our (?:chats|conversations)|conversations)(?: (?:between|across|after) (?:chats|conversations|sessions|we talk|we stop talking|this)| next time| tomorrow| later| at all)?$`)],
  ["memory", /^will you remember (?:this|that|me)(?: (?:tomorrow|next time|later))?$/],
  ["memory", new RegExp(`^(?:do|will) you ${SELF_ADVERBS}forget(?: (?:things|stuff|what (?:we|i) (?:say|said|tell you|told you)|our (?:chats|conversations)))?$`)],
  ["memory", new RegExp(`^${SELF_HAVE}(?:memory|long term memory)$`)],
  ["memory", /^how long (?:do|will|can) you (?:remember|keep|hold on to) (?:things|stuff|anything|what (?:we|i) (?:say|said|tell you|told you)|our (?:chats|conversations)|conversations)(?: for)?$/],
  ["mind", new RegExp(`^(?:are you|is this|am i ${SELF_ADVERBS}(?:talking|speaking|chatting) (?:to|with)|have i been (?:talking|speaking|chatting) (?:to|with)) ${SELF_ADVERBS}${MIND_NAME}(?: or ${MIND_OR_CODE})*(?: right now| now)?$`)],
  // "Was that you?" alone could be about anything; "you" counts only as one
  // side of a choice ("was that you or Claude?").
  ["mind", new RegExp(`^(?:is|was) ${REPLY_REF} ${SELF_ADVERBS}${MIND_SOURCE}(?: or ${MIND_OR_CODE})*$`)],
  ["mind", new RegExp(`^(?:is|was) ${REPLY_REF} ${SELF_ADVERBS}${MIND_OR_CODE}(?: or ${MIND_OR_CODE})+$`)],
  ["mind", new RegExp(`^(?:did|does) ${REPLY_REF} come from ${MIND_SOURCE}(?: or ${MIND_OR_CODE})*$`)],
  ["mind", new RegExp(`^(?:did|does) ${REPLY_REF} come from ${MIND_OR_CODE}(?: or ${MIND_OR_CODE})+$`)],
  ["mind", new RegExp(`^(?:is|was) (?:this|that) ${SELF_ADVERBS}(?:${MIND_NAME}|code) (?:talking|speaking|answering)$`)],
  ["mind", /^(?:which|what) (?:mind|brain|model|ai|language model|llm) (?:is (?:this|that|talking|speaking|answering|running you)|are you|am i (?:talking|speaking|chatting) (?:to|with)|runs you|powers you|do you (?:use|run on)|are you (?:using|running|running on|based on|built on))$/],
  ["mind", /^what (?:runs|powers|drives) you$/],
  ["mind", /^what are you (?:running on|built on|powered by|based on)$/],
  ["maker", /^who (?:made|built|created|wrote|designed|programmed|coded) you$/],
  ["age", householdRegex(String.raw`^(?:how old (?:are you|is {ASSISTANT})|what (?:is |s )?your age|when were you (?:born|made|built|created|switched on|turned on)|how long have you (?:been (?:around|alive|running|here|going)|existed))$`)],
  // His name is the assistant whatever runs him; code owns it so
  // no title lookup ("What's Your Name", the album) can take the question.
  ["control", new RegExp(`^(?:what|which|what ${CONTROL_THINGS}|which ${CONTROL_THINGS}) ${CONTROL_ABLE}${CONTROL_VERB}${CONTROL_SCOPE}$`)],
  ["control", new RegExp(`^${CONTROL_ABLE}${CONTROL_VERB} (?:${CONTROL_THINGS}|anything|the house)${CONTROL_SCOPE}$`)],
  ["control", new RegExp(`^(?:what|which ${CONTROL_THINGS}) (?:is |s |are )?on your voice list$`)],
  ["name", /^(?:what (?:is |s )?your (?:name|real name)|what are you called|what (?:do|should|can) (?:i|we|people) call you|(?:do you have|have you got) a name)$/],
];

/**
 * A sincere question about the assistant himself, parsed as addressee + predicate.
 * Returns null for questions whose subject is someone or something else.
 */
export function parseAssistantSelfQuestion(input: string): AssistantSelfQuestion | null {
  const text = selfQuestionText(input);
  if (!text) {
    return null;
  }
  for (const [topic, pattern] of SELF_TOPIC_GRAMMAR) {
    if (pattern.test(text)) {
      return {
        topic,
        previousReply: topic === "mind" && /^(?:is|was|did|does) (?:that|this) (?:answer|reply|one|last)|^(?:was|did) that\b/.test(text),
      };
    }
  }
  return null;
}

function selfQuestionText(input: string): string {
  let text = normalize(input)
    .replace(householdRegex(String.raw`^(?:(?:hey|ok|okay|so|well|and|but|um|hmm|oh)\s+)*(?:{ASSISTANT}\s+)?`), "")
    .replace(/^(?:(?:can i ask(?: you)?|let me ask you|tell me|be honest|honestly|seriously|genuinely|truthfully|i m curious|i wonder|i want to know|out of interest|just curious)\s+)*/, "")
    .replace(householdRegex(String.raw`^{ASSISTANT}\s+`), "")
    .replace(householdRegex(String.raw`(?:\s+(?:{ASSISTANT}|mate|really|honestly|seriously|though|then|at all|exactly|actually))+$`), "")
    .trim();
  // Embedded questions: "tell me if you're conscious" asks "are you conscious".
  text = text
    .replace(/^(?:if|whether) (?:you re|you are) /, "are you ")
    .replace(/^(?:if|whether) you (?=(?:have|remember|forget|feel|keep|recall)\b)/, "do you ")
    .replace(/^what you are$/, "what are you");
  return text;
}

/**
 * A turn that opens with a writing or making instruction ("now write a voice
 * description for...") is a request for content, not talk about the speaker
 * or the microphone, however many identity or voice words it contains.
 * Two such requests were answered "You are the owner." and
 * "Got it." by code.
 */
export const contentInstructionLead = (): RegExp => householdRegex(String.raw`^(?:(?:now|ok|okay|right|alright|so|and|then|please|{ASSISTANT}|can you|could you|would you)\s+)*(?:write|draft|compose|describe|create|design|generate|make|give|list|explain|read)\b`);

function looksLikeSpeakerIdentityQuestion(stripped: string): boolean {
  const identitySubject = /\b(?:identity|speaker|speaking|talking|voice|name|person|conversation|turn)\b/.test(stripped);
  const selfReference = /\b(?:i|me|my|this|current|you|your|turn|conversation)\b/.test(stripped);
  const identityPredicate = /\b(?:who|identify|identified|identity|attached|answering|talking|speaking|using|got|have|think|name|current)\b/.test(stripped);
  const addresseeQuestion = /\b(?:who|which person)\b.*\b(?:you|current)\b.*\b(?:answering|talking|speaking|think)\b/.test(stripped)
    || /\bconfirm\b.*\bwho\b.*\b(?:talking|speaking)\b/.test(stripped);
  return /^(?:do you know )?(?:who am i|who i am)\??$/.test(stripped)
    || /^(?:tell me )?who(?: s| is) speaking(?: here)?\??$/.test(stripped)
    || /^(?:tell me )?who(?: s| is) (?:talking|speaking) to (?:you|ya)\??$/.test(stripped)
    || /^(?:tell me )?who(?: re| are) you (?:talking|speaking) to\??$/.test(stripped)
    || householdRegex(String.raw`^(?:you(?:ve| ve| have) got me as|have you got me as) {OWNER}\b.*\??$`).test(stripped)
    || householdRegex(String.raw`^(?:same speaker|same voice|same person)(?:\s+{OWNER})?\??$`).test(stripped)
    || /\b(?:who am i|identify me|my identity|my name)\b/.test(stripped)
    || (isShortTurn(stripped) && identitySubject && selfReference && identityPredicate && !contentInstructionLead().test(stripped))
    || (isShortTurn(stripped) && addresseeQuestion);
}

function looksLikeSpeakerIdentityStatement(stripped: string): boolean {
  return (/\b(i am|i m|from me|this is|talking to)\b/.test(stripped)
    && householdRegex(String.raw`\b(you should know|you know|know i am|know who i am|chat dashboard|chats from|{OWNER})\b`).test(stripped))
    || householdRegex(String.raw`(?:\byou (?:already )?know\b|\byou should know\b).*\b(?:speaking|talking)\s+(?:to|with)\s+{OWNER}\b`).test(stripped)
    || householdRegex(String.raw`\byou(?: re| are)? (?:talking|speaking)\s+(?:to|with)\s+{OWNER}\b`).test(stripped)
    || householdRegex(String.raw`\byou(?:ve| ve| have) got me as\s+{OWNER}\b`).test(stripped);
}

function looksLikeLockedControlIntent(text: string): boolean {
  const assistantOrPolicy = householdRegex(String.raw`\b(?:you|your|{ASSISTANT}|device|actions?|control|safety|read[ -]?only)\b`).test(text)
    || (/\bstill\b/.test(text) && /\b(?:check|inspect|read|look)\b/.test(text));
  const mutation = /\b(?:control|change|touch|act|actions?|switch|turn|operate|write|check|inspect|read|look)\b/.test(text);
  const restriction = /\b(?:locked|read[ -]?only|only|cannot|cant|can not|not able|unable|not allowed|disabled)\b/.test(text);
  const contrast = /\b(?:check|inspect|read|look)\b.*\b(?:not|without|rather than)\b.*\b(?:change|control|touch|act|operate|write)\b/.test(text);
  return assistantOrPolicy && mutation && (restriction || contrast);
}

// Readiness that belongs to a person, not the assistant: "I'm just getting ready
// to go to work", "Sam's nearly ready". It is not a question about the runtime.
const personReadiness = (): RegExp => householdRegex(String.raw`\b(?:(?:i|i m|im|we|we re|were|he|she|they|they re|{NAMES})(?: s)?(?: (?:am|is|are|was|were))?(?: (?:just|still|nearly|almost|all|about|finally|already))*(?: (?:getting|get|got))? ready|(?:getting|get|got) ready)\b`, "g");

function withoutPersonReadiness(text: string): string {
  return text.replace(personReadiness(), " ").replace(/\s+/g, " ").trim();
}

function looksLikeRuntimeReadinessIntent(input: string): boolean {
  const text = withoutPersonReadiness(input);
  const assistant = householdRegex(String.raw`\b(?:you|your|{ASSISTANT}|system|runtime|your end)\b`).test(text)
    || /\b(?:answer|respond)\s+me\b/.test(text);
  const readiness = /\b(?:ready|healthy|health|status|up and running|working (?:normally|properly|correctly)|operating (?:normally|properly|correctly)|running (?:normally|properly|correctly)|responding|available)\b/.test(text)
    || /\b(?:answer|respond)\b.*\b(?:right now|now)\b/.test(text)
    || /\beverything\b.*\b(?:okay|ok|ready|working)\b/.test(text);
  return assistant && readiness;
}

function normalize(value: string): string {
  return normalizeSpeechForRouting(value, { preserveEntityChars: true })
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripCasualQuestionTail(normalized: string): string {
  return normalized
    .toLowerCase()
    .replaceAll(/[’']/g, "")
    .replaceAll(/[^a-z0-9]+/g, " ")
    .replace(/(?:\b(?:yeah|mate|right|please)\b\s*)+\??$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function claimedSpeakerName(text: string): string | null {
  const match = householdRegex(String.raw`\b({NAMES})\b`).exec(text)?.[1] ?? null;
  return householdPersonByName(match)?.name ?? null;
}
