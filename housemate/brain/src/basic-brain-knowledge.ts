/**
 * General knowledge: offline Wikipedia first (exact titles, media
 * clarifiers, follow-up topics), then the bounded model fallback, and the
 * house-versus-knowledge evidence that decides which way an unclaimed
 * question leans. It left `basic-brain.ts` whole.
 */
import {
  resultId,
  clarify,
  declined,
  type BasicConversationTurn,
  type BasicResult,
  type PendingClarifierChoice,
  type ResolvedTarget,
} from "./basic-brain-contracts.js";
import type { BasicBrainRouteServices, BasicModelProvider, BasicModelAnswer } from "./basic-brain-services.js";
import { looksLikeOutdoorClothingMemoryQuestion } from "./basic-brain-memory.js";
import {
  looksLikeCurrentPowerRankingQuestion,
  looksLikeEnergyBudgetQuestion,
  looksLikeHistoryMetricQuestion,
  resolveMetricQuestion,
} from "./basic-brain-metrics.js";
import { looksLikeWeatherFastPathQuestion } from "./basic-brain-weather.js";
import type { AppConfig } from "./config.js";
import type { VoiceBrainRequest } from "./voice-brain.js";
import { labelsEquivalent } from "./target-index.js";
import { resolveUnsupportedMathPrompt } from "./scalar-calculator.js";
import { normalizeMeasuredRoutingText as normalize, looksLikeKnowledgeContentReadRequest, targetTextKey } from "./routing-text.js";
import { CALENDAR_DAY_WORD } from "./lexicon.js";
import {
  extractWikipediaTopic,
  looksLikeSubjectiveOpinionPrompt,
  selectSupportedWikipediaAnswerExcerpt,
  wikipediaExcerptSupportsQuestion,
  titleTokenSequenceInQuery,
  wikipediaLeadText,
  type WikipediaKnowledgeStore,
  type WikipediaKnowledgeHit,
} from "./wikipedia-knowledge-store.js";
import { joinAlternatives } from "./text-format.js";
import {
  houseEntityInventoryDomain,
  isBareNominalStatusRequest,
  isDefiniteReferentialStatusQuestion,
  looksLikeExplicitStatusTargetObject,
  looksLikeHouseFact,
  parseCurrentStatusPlan,
  resolveExactTarget,
  resolveStatusTarget,
} from "./basic-brain-status.js";
import { chatWebSearchActive, cleanModelText, conversationTurnsAllowedForModel, withProgressiveModelContext } from "./basic-brain-open-chat.js";

export interface FallbackRouteEvidence {
  readonly house: number;
  readonly knowledge: number;
}

export function entityLinkedKnowledgeQuestion(
  transcript: string,
  normalized: string,
): {
  readonly kind: "identity" | "location" | "relation";
  readonly topic: string;
} | null {
  const direct = /^(who|where)(?:\s+(?!(?:is|are|was|were)\b)[a-z]+){0,3}\s+(?:is|are|was|were)\s+(.+)$/.exec(normalized);
  const directSubject = direct?.[2]?.trim();
  if (directSubject) {
    return {
      kind: direct?.[1] === "who" ? "identity" : "location",
      topic: directSubject,
    };
  }
  const embedded = /^do you know\s+(who|where)\s+(.+?)\s+(?:is|are|was|were)$/.exec(normalized);
  const embeddedSubject = embedded?.[2]?.trim();
  if (embeddedSubject) {
    return {
      kind: embedded?.[1] === "who" ? "identity" : "location",
      topic: embeddedSubject,
    };
  }
  const relationalTopic = looksLikeStrongRelationalKnowledgeLead(normalized)
    ? extractWikipediaTopic(transcript)?.trim() ?? ""
    : "";
  return relationalTopic
    ? { kind: "relation", topic: relationalTopic }
    : null;
}

export function directEntityLinkedKnowledgeQuestion(
  normalized: string,
): {
  readonly kind: "identity" | "location";
  readonly topic: string;
} | null {
  const directiveIdentity = /^(?:identify|name)\s+(.+)$/.exec(normalized)?.[1]?.trim();
  if (directiveIdentity) {
    return {
      kind: "identity",
      topic: directiveIdentity,
    };
  }
  const linked = entityLinkedKnowledgeQuestion("", normalized);
  if (!linked || (linked.kind !== "identity" && linked.kind !== "location")) {
    return null;
  }
  return {
    kind: linked.kind,
    topic: linked.topic,
  };
}

/** What a knowledge answer reads: the turn, the offline index and the model. */
interface KnowledgeOptions {
  readonly request: VoiceBrainRequest;
  readonly turnId: string;
  readonly config?: AppConfig;
  readonly wikipediaKnowledge: WikipediaKnowledgeStore;
  readonly modelProvider: BasicModelProvider;
  readonly conversationTurns: readonly BasicConversationTurn[];
  readonly now: () => Date;
}

/** The model's knowledge answer, declined when no model ran. */
function knowledgeModelResult(model: BasicModelAnswer, turnId: string, notes: string): BasicResult {
  return {
    route: "general_knowledge",
    status: model.modelUsed ? "ok" : "declined",
    confidence: model.modelUsed ? "medium" : "low",
    text: model.text,
    modelUsed: model.modelUsed,
    resultId: resultId(turnId),
    touchedEntities: [],
    notes,
  };
}

export async function generalKnowledgeAnswer(options: KnowledgeOptions): Promise<BasicResult> {
  const researchPrompt = looksLikeCurrentInformationResearchPrompt(options.request.transcript);
  if (researchPrompt && options.config && chatWebSearchActive(options.config)) {
    return generalKnowledgeModelFallback(options, "current information researched with web search");
  }
  if (researchPrompt) {
    const modelRequest = withProgressiveModelContext({
      turnId: options.turnId,
      purpose: "current_information",
      transcript: options.request.transcript.trim(),
      requestedAt: options.now().toISOString(),
      speakerName: options.request.speaker.name,
      channel: options.request.channel,
      conversationTurns: conversationTurnsAllowedForModel(
        options.conversationTurns,
      ),
    }, options.request);
    const model = await options.modelProvider.answer(modelRequest);
    return knowledgeModelResult(model, options.turnId, model.reason
      ? `current information research fallback: ${model.reason}`
      : `current information researched with Codex web search: ${model.sources?.map((source) => source.publisher).join(", ") ?? "sources unavailable"}`);
  }
  const wikipediaLookup = await options.wikipediaKnowledge.lookupWithDiagnosticsAsync(options.request.transcript);
  const identity = directEntityLinkedKnowledgeQuestion(
    normalize(options.request.transcript),
  );
  const mononymIdentity = identity?.kind === "identity"
    && targetTextKey(identity.topic).split(/\s+/).filter(Boolean).length === 1;
  if (mononymIdentity) {
    const hit = wikipediaLookup.hit;
    if (
      hit
      && isStrongWikipediaTitleHit(identity.topic, hit)
      && !looksLikeNameCatalogueWikipediaHit(hit)
    ) {
      return wikipediaKnowledgeResult(
        options.turnId,
        hit,
        wikipediaDiagnosticsNote(wikipediaLookup.diagnostics),
        options.request.transcript,
      );
    }
    return declined(
      "general_knowledge",
      "I don't know which person you mean; give me a surname or some context.",
      "ambiguous one-name identity question blocked from broad Wikipedia or model guessing",
    );
  }
  if (wikipediaLookup.hit) {
    const offline = wikipediaKnowledgeResult(
      options.turnId,
      wikipediaLookup.hit,
      wikipediaDiagnosticsNote(wikipediaLookup.diagnostics),
      options.request.transcript,
    );
    if (offline.status === "ok") {
      return offline;
    }
    return generalKnowledgeModelFallback(
      options,
      offline.notes,
    );
  }
  if (wikipediaLookup.ambiguity?.kind === "media_title") {
    return wikipediaMediaClarifierResult(
      wikipediaLookup.ambiguity.topic,
      wikipediaLookup.ambiguity.candidates,
    );
  }
  return generalKnowledgeModelFallback(
    options,
    wikipediaLookup.diagnostics.timedOut
      ? `offline Wikipedia lookup timed out; ${wikipediaDiagnosticsNote(wikipediaLookup.diagnostics)}`
      : `offline Wikipedia lookup found no supported answer; ${wikipediaDiagnosticsNote(wikipediaLookup.diagnostics)}`,
  );
}

async function generalKnowledgeModelFallback(options: KnowledgeOptions, offlineReason: string): Promise<BasicResult> {
  // The offline encyclopedia missed; with web search on, the model may look it up.
  const webSearch = options.config ? chatWebSearchActive(options.config) : false;
  const modelRequest = withProgressiveModelContext({
    turnId: options.turnId,
    purpose: "general_knowledge",
    transcript: options.request.transcript.trim(),
    speakerName: options.request.speaker.name,
    channel: options.request.channel,
    conversationTurns: conversationTurnsAllowedForModel(
      options.conversationTurns,
    ),
    ...(webSearch ? { webSearch: true, requestedAt: options.now().toISOString() } : {}),
  }, options.request);
  const model = await options.modelProvider.answer(modelRequest);
  return knowledgeModelResult(model, options.turnId, [
    offlineReason,
    model.reason ? `general knowledge model fallback: ${model.reason}` : "general knowledge model fallback answered",
  ].join("; "));
}

export function looksLikeCurrentInformationResearchPrompt(transcript: string): boolean {
  const normalized = normalize(transcript);
  const explicitFreshness = /\b(?:current|currently|latest|recent|recently|today|tonight|tomorrow|this (?:week|month|year)|right now|as of now|up to date|news)\b/.test(normalized);
  const prediction = /\b(?:will|would|likely|unlikely|chance|chances|odds|expect|expected|predict|prediction|think)\b/.test(normalized);
  const volatilePublicSubject = /\b(?:leadership|leader|premier|prime minister|president|minister|government|party|caucus|spill|challenge|election|poll|politic|parliament|senate|congress|mayor|ceo|chief executive|court|trial|war|conflict|ceasefire|strike|market|stock|share price|company|sports?|match|game|tournament|release date|launch|won|winners?|champions?|championship|premiership|premiers|grand final|finals?|cup|ladder|standings)\b/.test(normalized);
  const directResearchRequest = /\b(?:look up|research|check the web|search the web|check current reporting|what is being reported|news)\b/.test(normalized);
  // Present progressive about a public subject asks for its current state.
  const currentStateOfPublicSubject = /^what is (?:happening|going on) (?:with|in|at|around)\b/.test(normalized)
    && !looksLikeLocalReadSourceScope(normalized)
    && !/\b(?:my|our|here|room|office|kitchen|garage|bedroom|lounge)\b/.test(normalized);
  return currentStateOfPublicSubject
    || (directResearchRequest && (explicitFreshness || volatilePublicSubject))
    || (volatilePublicSubject && (explicitFreshness || prediction));
}

function looksLikeNameCatalogueWikipediaHit(
  hit: WikipediaKnowledgeHit,
): boolean {
  return /\b(?:given name|first name|forename|surname|family name|disambiguation|list of people)\b/i.test(
    `${hit.title} ${hit.description ?? ""}`,
  );
}

export function wikipediaKnowledgeResult(
  turnId: string,
  wikipedia: WikipediaKnowledgeHit,
  debugNote = "",
  transcript?: string,
): BasicResult {
  const supportedExcerpt = transcript
    ? selectSupportedWikipediaAnswerExcerpt(transcript, wikipedia)
    : wikipediaLeadText(wikipedia);
  if (!supportedExcerpt) {
    return declined(
      "general_knowledge",
      "I found related offline material, but not enough to answer that confidently.",
      [
        `offline Wikipedia evidence rejected: ${wikipedia.title} (${wikipedia.matchedBy})`,
        debugNote,
      ].filter(Boolean).join("; "),
    );
  }
  const renderedExcerpt = cleanModelText(
    supportedExcerpt,
    { maxLength: 220, maxSentences: 2 },
  );
  if (
    transcript
    && !wikipediaExcerptSupportsQuestion(transcript, wikipedia, renderedExcerpt)
  ) {
    return declined(
      "general_knowledge",
      "I found related offline material, but not enough to answer that confidently.",
      [
        `offline Wikipedia rendered evidence rejected: ${wikipedia.title} (${wikipedia.matchedBy})`,
        debugNote,
      ].filter(Boolean).join("; "),
    );
  }
  return {
    route: "general_knowledge",
    status: "ok",
    confidence: wikipedia.matchedBy === "fts" ? "medium" : "high",
    text: renderedExcerpt,
    modelUsed: false,
    resultId: resultId(turnId),
    touchedEntities: [],
    notes: [
      `general knowledge wikipedia fast path: ${wikipedia.title} (${wikipedia.matchedBy})`,
      debugNote,
    ].filter(Boolean).join("; "),
    contextFrame: {
      kind: "wikipedia_abstract",
      title: wikipedia.title,
      url: wikipedia.url,
      description: wikipedia.description,
      matchedBy: wikipedia.matchedBy,
      resolvedFromTitle: wikipedia.resolvedFromTitle,
    },
  };
}

interface WikipediaMediaClarifierCandidate {
  readonly title: string;
  readonly descriptor: string;
  readonly kind: "film" | "book" | "show" | "music" | "other";
  readonly synonyms: readonly string[];
}

const MAX_WIKIPEDIA_MEDIA_CLARIFIER_CHOICES = 5;

function wikipediaMediaClarifierResult(topic: string, titles: readonly string[]): BasicResult {
  const candidates = titles.map(wikipediaMediaClarifierCandidate);
  if (candidates.length === 0 || candidates.length > MAX_WIKIPEDIA_MEDIA_CLARIFIER_CHOICES) {
    return declined(
      "general_knowledge",
      `I found several works called ${topic}. Ask again with the type or release year so I don't guess.`,
      "large media-title ambiguity stayed bounded and required an explicit restatement",
    );
  }
  const choices: PendingClarifierChoice[] = candidates.map((candidate, index) => ({
    id: `wikipedia-media-${index + 1}`,
    label: `the ${candidate.descriptor}`,
    synonyms: wikipediaMediaChoiceSynonyms(candidate, candidates),
    action: {
      kind: "wikipedia_media",
      title: candidate.title,
    },
  }));
  const promptOptions = candidates.map((candidate) => (
    wikipediaMediaPromptOption(candidate, candidates)
  ));
  const prompt = `There is more than one work called ${topic}: ${joinAlternatives(promptOptions)}. Which one did you mean?`;
  return clarify(
    "general_knowledge",
    prompt,
    "ambiguous media title clarified from local Wikipedia title-family evidence without model guessing",
    {
      kind: "clarifier",
      route: "general_knowledge",
      prompt,
      choices,
    },
  );
}

function wikipediaMediaClarifierCandidate(title: string): WikipediaMediaClarifierCandidate {
  const qualifier = /\(([^()]*)\)\s*$/u.exec(title)?.[1]?.trim() ?? "work";
  const normalized = targetTextKey(qualifier);
  const year = /\b(?:18|19|20|21)\d{2}\b/u.exec(normalized)?.[0] ?? null;
  const identity = wikipediaMediaQualifierIdentity(normalized);
  const descriptor = wikipediaMediaQualifierDescriptor(normalized, identity.label);
  const aliases = wikipediaMediaIdentityAliases(identity.kind, identity.label);
  const qualifiedAliases = year
    ? aliases.map((alias) => `${year} ${alias}`)
    : aliases;
  return {
    title,
    descriptor,
    kind: identity.kind,
    synonyms: [...new Set([
      descriptor,
      qualifier,
      title,
      ...aliases,
      ...qualifiedAliases,
    ].filter(Boolean))],
  };
}

function wikipediaMediaQualifierDescriptor(normalizedQualifier: string, fallback: string): string {
  const descriptor = normalizedQualifier || fallback;
  return descriptor
    .replace(/\btv\b/gu, "TV")
    .replace(/\bep\b/gu, "EP");
}

function wikipediaMediaQualifierIdentity(normalizedQualifier: string): {
  readonly kind: WikipediaMediaClarifierCandidate["kind"];
  readonly label: string;
} {
  const withoutYear = normalizedQualifier.replace(/\b(?:18|19|20|21)\d{2}\b/gu, " ").replace(/\s+/g, " ").trim();
  if (/\b(?:film|movie)\b/u.test(withoutYear)) return { kind: "film", label: "film" };
  if (/\bnovel\b/u.test(withoutYear)) return { kind: "book", label: "novel" };
  if (/\bbook\b/u.test(withoutYear)) return { kind: "book", label: "book" };
  if (/\b(?:television|tv) series\b|\b(?:television|tv) show\b|\bseries\b|\bshow\b/u.test(withoutYear)) {
    return { kind: "show", label: "television series" };
  }
  if (/\bsoundtrack\b/u.test(withoutYear)) return { kind: "music", label: "soundtrack" };
  if (/\balbum\b/u.test(withoutYear)) return { kind: "music", label: "album" };
  if (/\bsingle\b/u.test(withoutYear)) return { kind: "music", label: "single" };
  if (/\bsong\b/u.test(withoutYear)) return { kind: "music", label: "song" };
  if (/\bep\b/u.test(withoutYear)) return { kind: "music", label: "EP" };
  return { kind: "other", label: withoutYear || "work" };
}

function wikipediaMediaIdentityAliases(
  kind: WikipediaMediaClarifierCandidate["kind"],
  label: string,
): readonly string[] {
  switch (kind) {
    case "film": return ["film", "movie"];
    case "book": return [label];
    case "show": return ["television series", "tv series", "television show", "tv show", "show", "series"];
    case "music": return [label];
    case "other": return [label];
  }
}

function wikipediaMediaChoiceSynonyms(
  candidate: WikipediaMediaClarifierCandidate,
  candidates: readonly WikipediaMediaClarifierCandidate[],
): readonly string[] {
  if (candidates.filter((other) => other.kind === candidate.kind).length !== 1) {
    return candidate.synonyms;
  }
  const kindAliases = candidate.kind === "book"
    ? ["book", "novel"]
    : candidate.kind === "music"
      ? ["music"]
      : [];
  return [...new Set([...candidate.synonyms, ...kindAliases])];
}

function wikipediaMediaPromptOption(
  candidate: WikipediaMediaClarifierCandidate,
  candidates: readonly WikipediaMediaClarifierCandidate[],
): string {
  const hasYear = /\b(?:18|19|20|21)\d{2}\b/u.test(candidate.descriptor);
  const sameKindCount = candidates.filter((other) => other.kind === candidate.kind).length;
  if (hasYear || sameKindCount > 1) {
    return `the ${candidate.descriptor}`;
  }
  return `${/^[aeiou]/iu.test(candidate.descriptor) ? "an" : "a"} ${candidate.descriptor}`;
}

export function wikipediaDiagnosticsNote(diagnostics: {
  readonly exactTitleMs: number;
  readonly redirectMs: number;
  readonly acronymMs: number;
  readonly titleFamilyMs: number;
  readonly ftsTitleMs: number;
  readonly ftsStrictMs: number;
  readonly ftsBroadMs: number;
  readonly normalizedFtsTitleMs: number;
  readonly normalizedFtsStrictMs: number;
  readonly normalizedFtsBroadMs: number;
  readonly totalMs: number;
  readonly timedOut: boolean;
}): string {
  return `wiki timings exact=${diagnostics.exactTitleMs} redirect=${diagnostics.redirectMs} acronym=${diagnostics.acronymMs} title_family=${diagnostics.titleFamilyMs} fts_title=${diagnostics.ftsTitleMs} fts_strict=${diagnostics.ftsStrictMs} fts_broad=${diagnostics.ftsBroadMs} norm_fts_title=${diagnostics.normalizedFtsTitleMs} norm_fts_strict=${diagnostics.normalizedFtsStrictMs} norm_fts_broad=${diagnostics.normalizedFtsBroadMs} total=${diagnostics.totalMs} timeout=${diagnostics.timedOut}`;
}

export function looksLikePersonalAdvicePrompt(normalized: string): boolean {
  if (looksLikeWeatherFastPathQuestion(normalized) || looksLikeOutdoorClothingMemoryQuestion(normalized)) {
    return false;
  }
  return /^what (?:color|colour|style|kind|type)\b.*\b(?:should i|would suit|looks better)\b/.test(normalized)
    || /^(?:what|which)\b.*\bshould i\b.*\b(?:paint|wear|pick|choose|buy|call|name|do|give|try|make|cook|watch)\b/.test(normalized)
    || /^do you like\b.+\bbetter\b/.test(normalized)
    || /^which\b.+\b(?:is )?better\b/.test(normalized)
    || /^would you\b.+\b(?:recommend|choose|pick)\b/.test(normalized)
    || /^how should i\b.*\b(?:start|approach|handle|deal|cope|begin)\b/.test(normalized)
    || /^what (?:is|would be) (?:a )?(?:good|sensible|practical|reasonable)\b.*\b(?:way|approach|step|thing to do)\b/.test(normalized)
    || /^what(?:s| is) (?:a )?(?:good|sensible|practical|reasonable)?\s*(?:first|next) step\b/.test(normalized);
}

/**
 * The people talking are the topic ("tell me about yourself", "tell me a bit about me", "describe
 * yourself"): a conversation, not an article. "Tell me about yourself" was
 * answered with the Wikipedia article on a J-pop single called "Yourself".
 */
export function asksAboutParticipant(normalized: string): boolean {
  return /^(?:tell me|tell us)(?: a (?:little )?(?:bit )?)? about (?:you|yourself|me|myself|us|ourselves)\b/.test(normalized)
    || /^(?:describe|introduce) (?:yourself|me|myself)\b/.test(normalized);
}

export function looksLikeGeneralKnowledgePrompt(normalized: string): boolean {
  const stableKnowledgeGrammar = looksLikeStableKnowledgeGrammar(normalized);
  if (asksAboutParticipant(normalized)
    || looksLikeDeterministicOpenConversationPrompt(normalized)
    || looksLikePersonalAdvicePrompt(normalized)
    || looksLikeSubjectiveOpinionPrompt(normalized)
    || (looksLikeEphemeralTimedPrompt(normalized) && !stableKnowledgeGrammar)
    || (resolveUnsupportedMathPrompt(normalized) && !looksLikeChemicalFormulaKnowledgePrompt(normalized))) {
    return false;
  }
  const topicalQuestion = !refersToConversation(normalized)
    && !looksLikeLocalReadSourceScope(normalized);
  return stableKnowledgeGrammar
    || looksLikeKnowledgeContentReadRequest(normalized)
    || (topicalQuestion && /^(?:what|which)\b.*\b(?:is|are|was|were|did|does|do|has|have|can|could|would|should)\b/.test(normalized))
    || (topicalQuestion && /^(?:when|where|who)\s+(?:is|are|was|were|did|does|do|has|have|can|could|would|should)\b/.test(normalized))
    || /^do you know\s+(?:what|who|where|when|why|how)\b/.test(normalized)
    || /^how\s+(?:many|much|long|old|big|small|tall|wide|deep|heavy|fast)\b/.test(normalized)
    || /^(?:tell me about|define|describe)\b/.test(normalized)
    || /^(?:identify|name)\s+\S/.test(normalized)
    || /^(?:give me|tell me)(?: (?:a|the|one paragraph))? summary of\b/.test(normalized)
    || /^(?:summari[sz]e|summarise)\b/.test(normalized)
    || /^explain\b(?!.*\b(?:why you|what you used|where that came from|how do you know)\b)/.test(normalized)
    || looksLikeStrongRelationalKnowledgeLead(normalized);
}

export function looksLikeStableKnowledgeGrammar(normalized: string): boolean {
  // A question put to the assistant is never an encyclopedia lead, whatever verb it
  // carries ("what do you think you would push back on, based on...").
  if (refersToConversation(normalized)) {
    return false;
  }
  return /^(?:in what years?|(?:along|at|by|for|from|to|with) which|where and when)\b/.test(normalized)
    || /^what (?:type|kind) of .+\s+(?:is|are|was|were)\b/.test(normalized)
    || /^what (?:is|was) (?:the )?(?:atomic number|capital|chemical formula|main function) (?:of|for)\b/.test(normalized)
    || /^(?:who|which|what)\b.*\b(?:allows?|allowed|associated|based|carries|carried|composed|contained|contains|continued|created|defined|developed|directed|discovered|dominated|flow|followed|formed|founded|introduced|invented|landed|painted|recorded|released|spans?|spanned|wrote)\b/.test(normalized)
    || looksLikeChemicalFormulaKnowledgePrompt(normalized);
}

/**
 * Speaker or listener as the subject of the question ("what did we chat
 * about", "what jobs do you do"), or a deictic pronoun ("is that the office
 * light", "how cool is that", "what was it the day before"), ties it to this
 * conversation rather than to an encyclopedia topic. A possessive alone does
 * not: "what is My Cousin Vinny" is a title.
 */
export function refersToConversation(normalized: string): boolean {
  const deictic = "(?:that|this|it|those|these)";
  // "what do you think is the capital": a parenthetical frame, not a participant.
  const unframed = normalized.replace(/\b(?:do|would) you (?:think|reckon|suppose|guess) (?=(?:is|are|was|were|will|would|did|has|had)\b)/, "");
  return /\b(?:am|are|were|do|did|can|could|would|will|should|have|had|shall|might|must)\s+(?:i|you|we)\b/.test(unframed)
    // The addressee's possession as the subject ("what is your name") asks
    // About the assistant, not a public topic. A bare "my" stays open to titles
    // ("What is My Cousin Vinny?"); the speaker's own facts route earlier.
    || /^(?:what|which|who|where|when|how)\s+(?:is|are|was|were)\s+your\b/.test(normalized)
    || new RegExp(`^(?:(?:what|which|who|how \\w+)\\s+)?(?:is|was|are|were)\\s+${deictic}\\b(?!\\s+(?:true|possible|from|to|like)\\b)`).test(normalized)
    || new RegExp(`\\b(?:is|was|are|were)\\s+${deictic}$`).test(normalized)
    || new RegExp(`^(?:why|how come)\\s+${deictic}\\b`).test(normalized);
}

export function looksLikeChemicalFormulaKnowledgePrompt(normalized: string): boolean {
  return /^what (?:is|was) (?:the )?chemical formula (?:of|for)\b/.test(normalized);
}

export function looksLikeLocalReadSourceScope(normalized: string): boolean {
  return /\bhome assistant\b/.test(normalized)
    || /\b(?:my|our)\s+(?:house|home|devices?|entities?|sensors?|switch(?:es)?|lights?|lamps?|outlets?|locks?|doors?|windows?|garage|heaters?|fans?|thermostats?|calendar|diary|appointments?|reminders?|to do|todos?|shopping list|weather|forecast|media|plex|movie library|music library)\b/.test(normalized)
    || /\b(?:the|this|in the|around the)\s+(?:house|home|household)\b(?!\s+of\b)/.test(normalized)
    || /\b(?:house|home)\s+(?:status|state|summary|devices?|entities?|sensors?|switch(?:es)?|lights?|locks?|doors?|windows?|power|energy|battery|weather|events?)\b/.test(normalized)
    || /\b(?:entity id|live (?:house|home|device|entity|sensor|state)|current (?:device|entity|sensor) state)\b/.test(normalized);
}

function looksLikeKnowledgeLeadPrompt(normalized: string): boolean {
  if (resolveUnsupportedMathPrompt(normalized) && !looksLikeChemicalFormulaKnowledgePrompt(normalized)) {
    return false;
  }
  return looksLikeStableKnowledgeGrammar(normalized)
    || /^(?:what|who|where|when)\s+(?:is|are|was|were)\b/.test(normalized)
    || /^what day is\b/.test(normalized)
    || /^what year did\b/.test(normalized)
    || /^when did\b/.test(normalized)
    || /^do you know\s+(?:what|who|where|when)\b/.test(normalized)
    || /^(?:tell me|teach me)\s+about\b/.test(normalized)
    || /^(?:give me|show me)\s+(?:a\s+)?summary\s+of\b/.test(normalized)
    || /^(?:summari[sz]e|summarise|describe|define|explain)\b/.test(normalized)
    || /^(?:who|which)\b.*\b(?:directed|wrote|created|invented|discovered|founded|played|portrayed|composed|designed)\b/.test(normalized)
    || /^(?:is|are there)\b.*\b(?:surname|family name|film|movie|book|novel|song|person|people)\b/.test(normalized)
    || /^(?:is|was)\b.*\b(?:surname|family name)\b/.test(normalized)
    || /^(?:back|return|go back) to\b.*\b(?:definition|meaning|biography|history|article)\b/.test(normalized)
    || /^(?:what about|how about)\b/.test(normalized);
}

/**
 * Latency lead for turns that intent already classes as knowledge, before any
 * house, self, time or memory route. Two shapes qualify: relational knowledge
 * grammar ("who directed Jaws?", "what is the capital of France?"), and a
 * definitional question whose whole object is a multi-word name that is
 * exactly an article title ("tell me about The Weather Man"), the same way an
 * exact alias names a device. A partial or broad hit never classes a turn, so
 * "What is the weather?" or "Who are you?" reach their own routes whether or
 * not the index is warm. Every other knowledge question gets the lookup at the
 * end of the route cascade, once no other route owns it.
 */
export async function earlyExactWikipediaKnowledgeResult(
  turnId: string,
  transcript: string,
  routes: BasicBrainRouteServices,
  wikipediaKnowledge: WikipediaKnowledgeStore,
): Promise<BasicResult | null> {
  const normalized = normalize(transcript);
  const topic = extractWikipediaTopic(transcript);
  if (!topic || !looksLikeGeneralKnowledgePrompt(normalized)) {
    return null;
  }
  const relationalLead = looksLikeStrongRelationalKnowledgeLead(normalized);
  if (
    !relationalLead
    && !(looksLikeKnowledgeLeadPrompt(normalized) && looksLikeTitleShapedKnowledgeTopic(topic))
  ) {
    return null;
  }
  const lookup = relationalLead
    ? await wikipediaKnowledge.lookupWithDiagnosticsAsync(transcript)
    : await wikipediaKnowledge.lookupEarlyTitleTextAsync(topic);
  const hit = lookup.hit;
  if (!hit || (!relationalLead && !wikipediaHitNamesWholeTopic(topic, hit))) {
    return null;
  }
  const evidence = fallbackRouteEvidence(transcript, normalized, routes);
  if (preferHouseFallback(evidence) && hasStrongHouseFallbackCandidate(transcript, normalized, routes)) {
    return null;
  }
  const result = wikipediaKnowledgeResult(
    turnId,
    hit,
    wikipediaDiagnosticsNote(lookup.diagnostics),
    transcript,
  );
  return result.status === "ok" ? result : null;
}

/**
 * The article title is the whole spoken topic (exact, redirect, qualified,
 * or the topic minus a dotted acronym), not a word inside it: "Day" does not
 * name "day it is".
 */
function wikipediaHitNamesWholeTopic(topic: string, hit: WikipediaKnowledgeHit): boolean {
  if (
    hit.matchedBy === "exact_title"
    || hit.matchedBy === "redirect"
    || hit.matchedBy === "qualified_title"
  ) {
    return true;
  }
  const normalizedTopic = normalize(topic);
  const normalizedTitle = normalize(hit.title);
  if (normalizedTitle === normalizedTopic) {
    return true;
  }
  if (!/\b(?:[\p{L}\p{N}]\.)+[\p{L}\p{N}]?\.?\b/u.test(topic)) {
    return false;
  }
  const baseTopic = normalize(
    topic
      .replace(/\b(?:[\p{L}\p{N}]\.)+[\p{L}\p{N}]?\.?\b/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return Boolean(baseTopic)
    && (normalizedTitle === baseTopic || normalizedTitle.startsWith(`${baseTopic} `));
}

function looksLikeStrongRelationalKnowledgeLead(normalized: string): boolean {
  return looksLikeStableKnowledgeGrammar(normalized)
    || /^(?:who|which|what)\b.*\b(?:directed|wrote|created|invented|discovered|founded|played|portrayed|composed|designed)\b/.test(normalized)
    || /^(?:is|are|was|were|where|what)\b.*\b(?:surname|family name)\b/.test(normalized)
    || /^(?:back|return|go back) to\b.*\b(?:definition|meaning|biography|history|article)\b/.test(normalized);
}

export async function exactWikipediaKnowledgeFollowUpResult(
  turnId: string,
  transcript: string,
  targetText: string | null,
  routes: BasicBrainRouteServices,
  wikipediaKnowledge: WikipediaKnowledgeStore,
): Promise<BasicResult | null> {
  if (!targetText || targetText === "that" || targetText === "it" || targetText === "this") {
    return null;
  }
  if (!looksLikeTitleShapedKnowledgeTopic(targetText)) {
    return null;
  }
  const lookup = await wikipediaKnowledge.lookupEarlyTitleTextAsync(targetText);
  const hit = lookup.hit;
  if (!hit || !isStrongWikipediaTitleHit(targetText, hit)) {
    return null;
  }
  const normalizedTarget = normalize(targetText);
  const evidence = fallbackRouteEvidence(targetText, normalizedTarget, routes);
  if (preferHouseFallback(evidence) && hasStrongHouseFallbackCandidate(targetText, normalizedTarget, routes)) {
    return null;
  }
  if (!looksLikeKnowledgeLeadPrompt(normalize(transcript)) && evidence.house > evidence.knowledge) {
    return null;
  }
  return wikipediaKnowledgeResult(
    turnId,
    hit,
    wikipediaDiagnosticsNote(lookup.diagnostics),
    transcript,
  );
}

function looksLikeTitleShapedKnowledgeTopic(topic: string | null): boolean {
  if (!topic) {
    return false;
  }
  const clean = topic
    .replace(/^[\s"'`([{]+/g, "")
    .replace(/[\s"'`)\]}.,;:!?]+$/g, "")
    .trim();
  if (!clean) {
    return false;
  }
  const tokens = clean.split(/\s+/).filter(Boolean);
  const coreTokens = tokens.filter((token) => !/^(?:the|a|an|my|our|your|about)$/i.test(token));
  if (coreTokens.length >= 2) {
    return true;
  }
  return coreTokens.length >= 1 && /[.'-]/.test(clean);
}

export function fallbackRouteEvidence(
  transcript: string,
  normalized: string,
  routes: BasicBrainRouteServices,
): FallbackRouteEvidence {
  let house = 0;
  let knowledge = 0;

  if (resolveMetricQuestion(normalized) || looksLikeHistoryMetricQuestion(normalized) || looksLikeCurrentPowerRankingQuestion(normalized)) {
    house += 5;
  }
  if (looksLikeElectricitySummaryQuestion(normalized) || looksLikeEnergyBudgetQuestion(normalized)) {
    house += 6;
  }
  if (parseCurrentStatusPlan(transcript)) {
    house += 5;
  }
  if (houseEntityInventoryDomain(normalized) || looksLikeHouseFact(normalized)) {
    house += 4;
  }
  const exactTarget = resolveExactTarget(transcript, routes);
  if (
    exactTarget
    && !exactTargetLooksLikeKnowledgeTitleCollision(
      exactTarget,
      transcript,
      normalized,
    )
  ) {
    house += 6;
  }
  if (/\b(?:electricity|energy|usage|power|solar|grid|battery|lights?|lamp|lock|door|garage|sensor|switch|temperature|weather)\b/.test(normalized)) {
    house += 6;
  }
  if (/\b(?:my|house|home)\b/.test(normalized)) {
    house += 2;
  }

  if (looksLikeGeneralKnowledgePrompt(normalized)) {
    knowledge += 4;
  }
  if (extractWikipediaTopic(transcript)) {
    knowledge += 3;
  }
  if ((/^(?:tell me about|define|describe|explain)\b/.test(normalized) && !asksAboutParticipant(normalized))
    || /^(?:give me|tell me)(?: (?:a|the|one paragraph))? summary of\b/.test(normalized)
    || /^(?:summari[sz]e|summarise)\b/.test(normalized)) {
    knowledge += 2;
  }

  return { house, knowledge };
}

export function preferHouseFallback(evidence: FallbackRouteEvidence): boolean {
  return evidence.house >= 6
    && evidence.house >= evidence.knowledge + 2;
}

export function hasStrongHouseFallbackCandidate(
  transcript: string,
  normalized: string,
  routes: BasicBrainRouteServices,
): boolean {
  const exactTarget = resolveExactTarget(transcript, routes);
  if (exactTarget && exactTargetLooksLikeKnowledgeTitleCollision(exactTarget, transcript, normalized)) {
    return false;
  }
  if (exactTarget) {
    return true;
  }
  if (looksLikeEnergyBudgetQuestion(normalized) || looksLikeElectricitySummaryQuestion(normalized)) {
    return true;
  }
  if (resolveMetricQuestion(normalized) || looksLikeHistoryMetricQuestion(normalized) || looksLikeCurrentPowerRankingQuestion(normalized)) {
    return true;
  }
  if (isDefiniteReferentialStatusQuestion(normalized)) {
    return true;
  }
  const queryPlan = parseCurrentStatusPlan(transcript);
  return Boolean(
    queryPlan?.intent === "current_status"
    && queryPlan.targetText
    && (
      resolveStatusTarget(queryPlan.targetText, routes)
      || looksLikeExplicitStatusTargetObject(queryPlan.targetText)
      || isBareNominalStatusRequest(normalized, queryPlan.targetText)
    ),
  );
}

export function exactTargetLooksLikeKnowledgeTitleCollision(
  target: ResolvedTarget,
  transcript: string,
  normalized: string,
): boolean {
  if (!looksLikeKnowledgeLeadPrompt(normalized)) {
    return false;
  }
  const topic = extractWikipediaTopic(transcript);
  if (!looksLikeTitleShapedKnowledgeTopic(topic)) {
    return false;
  }
  if (!topic) {
    return false;
  }
  const normalizedTopic = normalize(topic);
  const normalizedTarget = normalize(target.label);
  if (!normalizedTopic || !normalizedTarget || labelsEquivalent(normalizedTopic, normalizedTarget)) {
    return false;
  }
  const targetWordCount = normalizedTarget.split(/\s+/).filter(Boolean).length;
  if (targetWordCount > 2 || !normalizedTopic.includes(normalizedTarget)) {
    return false;
  }
  return normalizedTopic.startsWith(`${normalizedTarget} `)
    || normalizedTopic.endsWith(` ${normalizedTarget}`)
    || normalizedTopic.includes(` ${normalizedTarget} `);
}

function isStrongWikipediaTitleHit(topic: string, hit: WikipediaKnowledgeHit): boolean {
  if (
    hit.matchedBy === "exact_title"
    || hit.matchedBy === "redirect"
    || hit.matchedBy === "qualified_title"
  ) {
    return true;
  }
  const normalizedTopic = normalize(topic);
  const normalizedTitle = normalize(hit.title);
  if (normalizedTitle === normalizedTopic) {
    return true;
  }
  const topicTokens = normalizedTopic?.split(/\s+/).filter(Boolean) ?? [];
  const titleTokens = normalizedTitle?.split(/\s+/).filter(Boolean) ?? [];
  if (titleTokenSequenceInQuery(topicTokens, titleTokens)) {
    return true;
  }
  const hasDottedAcronym = /\b(?:[\p{L}\p{N}]\.)+[\p{L}\p{N}]?\.?\b/u.test(topic);
  const baseTopic = normalize(
    topic
      .replace(/\b(?:[\p{L}\p{N}]\.)+[\p{L}\p{N}]?\.?\b/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return hasDottedAcronym
    && Boolean(baseTopic)
    && (normalizedTitle === baseTopic || normalizedTitle.startsWith(`${baseTopic} `));
}

export function looksLikeElectricitySummaryQuestion(normalized: string): boolean {
  if (/\b(watts?|kw|power draw|drawing|load|loads?|biggest|highest|lowest|most|least|ranking)\b/.test(normalized)) {
    return false;
  }
  if (/\b(compare|compared|difference|versus|vs|more than|less than|higher than|lower than)\b/.test(normalized)
    || /\b(more|less|higher|lower|greater)\b.*\bthan\b/.test(normalized)) {
    return false;
  }
  if (!/\b(electricity|energy)\b/.test(normalized)) {
    return false;
  }
  if (!/\b(usage|used|summary|overview|tracking|track)\b/.test(normalized)) {
    return false;
  }
  return /\b(summary|overview|paragraph)\b/.test(normalized)
    || /\bhow (?:are|s) (?:we|it)\b/.test(normalized)
    || /\b(?:give me|tell me)\b/.test(normalized);
}

function looksLikeDeterministicOpenConversationPrompt(normalized: string): boolean {
  return /\b(joke|funny|laugh)\b/.test(normalized)
    || /^(?:thanks|thank you|cheers|ta)\b/.test(normalized)
    || /\bwho are you\b|\bwhat are you\b/.test(normalized)
    || /\brepeating yourself\b|\bwhy did you\b|\bwhy are you\b/.test(normalized)
    || /\bwhat should i check first\b|\bwhat should i do first\b|\bsensible next step\b|\bwhat could wait until tomorrow\b|\bten minutes\b/.test(normalized);
}

export function looksLikeEphemeralTimedPrompt(normalized: string): boolean {
  return CALENDAR_DAY_WORD.test(normalized)
    || /\b(?:after|before|around|at|by|from)\s+(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:am|pm)?\b/.test(normalized)
    || /\b(?:[1-9]|1[0-2])\s*(?:am|pm)\b/.test(normalized);
}
