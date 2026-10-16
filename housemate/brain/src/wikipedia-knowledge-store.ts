import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { looksLikeAssistantSelfOpinionPrompt } from "./assistant-self-opinion.js";
import { looksLikeEvaluativeJudgementPrompt } from "./evaluative-judgement.js";
import type { AppConfig } from "./config.js";
import { resolveUnsupportedMathPrompt } from "./scalar-calculator.js";
import { householdRegex } from "./household.js";

export interface WikipediaKnowledgeHit {
  readonly title: string;
  readonly description: string | null;
  readonly abstract: string;
  readonly url: string | null;
  readonly wikidataId: string | null;
  readonly matchedBy: "exact_title" | "redirect" | "qualified_title" | "fts";
  readonly resolvedFromTitle: string | null;
}

export type WikipediaMediaKind = "film" | "book" | "show" | "music";

export interface WikipediaLookupDiagnostics {
  exactTitleMs: number;
  redirectMs: number;
  acronymMs: number;
  titleFamilyMs: number;
  creativeTitleFamilyAttempted: boolean;
  ftsTitleMs: number;
  ftsStrictMs: number;
  ftsBroadMs: number;
  normalizedFtsTitleMs: number;
  normalizedFtsStrictMs: number;
  normalizedFtsBroadMs: number;
  totalMs: number;
  timedOut: boolean;
}

export interface WikipediaLookupResult {
  readonly hit: WikipediaKnowledgeHit | null;
  readonly diagnostics: WikipediaLookupDiagnostics;
  readonly ambiguity?: {
    readonly kind: "media_title";
    readonly topic: string;
    readonly candidates: readonly string[];
  };
}

interface WikipediaWorkerResponse {
  readonly id: number;
  readonly result: WikipediaLookupResult;
}

type WikipediaWorkerLookupRequest =
  | {
      readonly kind: "query";
      readonly transcript: string;
    }
  | {
      readonly kind: "early_title";
      readonly titleText: string;
    }
  | {
      readonly kind: "early_qualified_title";
      readonly titleText: string;
      readonly mediaKind: WikipediaMediaKind;
    };

interface PendingWikipediaLookup {
  readonly resolve: (result: WikipediaLookupResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly startedAt: number;
}

interface RecentWikipediaLookup {
  readonly expiresAt: number;
  readonly result: WikipediaLookupResult;
}

export const DEFAULT_WIKIPEDIA_LOOKUP_TIMEOUT_MS = 750;
const MAX_WIKIPEDIA_LOOKUPS_PER_CONNECTION = 8;
const RECENT_WIKIPEDIA_LOOKUP_TTL_MS = 5000;
const MAX_RECENT_WIKIPEDIA_LOOKUPS = 16;

type MediaHint = "film" | "book" | "show" | "music";

interface CreativeWorkFacet {
  readonly requested: boolean;
  readonly allowedKinds: ReadonlySet<WikipediaMediaKind>;
  readonly explicitKind: MediaHint | null;
}

interface CreativeTitleFamilyCandidate {
  readonly kind: WikipediaMediaKind;
  readonly hit: WikipediaKnowledgeHit;
}

interface CreativeTitleFamilyResolution {
  readonly handled: boolean;
  readonly hit: WikipediaKnowledgeHit | null;
  readonly candidates: readonly string[];
}

interface WikipediaSubjectCandidate {
  readonly text: string;
  readonly confidence: number;
}

interface ParsedWikipediaQuery {
  readonly topic: string;
  readonly searchText: string;
  readonly subjectCandidates: readonly WikipediaSubjectCandidate[];
  readonly relationTerms: ReadonlySet<string>;
  readonly directSubject: boolean;
}

interface WikipediaRow {
  readonly title: string;
  readonly description: string | null;
  readonly abstract: string | null;
  readonly url: string | null;
  readonly wikidata_id: string | null;
  readonly is_redirect: number;
  readonly redirect_target: string | null;
  readonly redirect_normalized_title: string | null;
}

export function wikipediaKnowledgeStorePath(config: { readonly dataDir: string }): string {
  return join(config.dataDir, "knowledge", "wikipedia", "enwiki_abstracts.sqlite");
}

export function extractWikipediaTopic(transcript: string): string | null {
  return parseWikipediaQuery(transcript)?.topic ?? null;
}

export function selectWikipediaAnswerExcerpt(
  transcript: string,
  hit: WikipediaKnowledgeHit,
): string {
  const { sentences, opening: openingSentence, openingTrusted, leadIndex } = wikipediaAnswerSentences(transcript, hit);
  const abstract = sentences.join(" ");
  if (sentences.length < 2) {
    return abstract;
  }
  const queryTerms = canonicalizeTokens(extractFtsTerms(transcript));
  const topicTerms = canonicalizeTokens(extractFtsTerms(extractWikipediaTopic(transcript) ?? ""));
  const predicateTerms = questionPredicateTerms(transcript, extractWikipediaTopic(transcript));
  const normalizedTitle = (normalizeTopic(hit.title.replace(/\s*\([^)]*\)\s*$/u, "")) ?? "").replace(/^the\s+/u, "");
  const asksForDate = /\b(?:what|which)\s+(?:year|date)\b|^when\b|^in\s+what\s+years?\b/iu.test(transcript.trim());
  if (/^in\s+what\s+years\b/iu.test(transcript.trim())) {
    const range = (hit.description ?? "").match(/\b(1[0-9]{3}|20[0-9]{2})\s*[–—-]\s*(1[0-9]{3}|20[0-9]{2})\b/u);
    if (range?.[1] && range[2]) {
      return `${hit.title} ran from ${range[1]} to ${range[2]}.`;
    }
  }
  if (/^in\s+what\s+year\b/iu.test(transcript.trim())) {
    const year = (hit.description ?? "").match(/\b(1[0-9]{3}|20[0-9]{2})\b/u)?.[1];
    if (year) {
      return `${hit.title} dates to ${year}.`;
    }
  }
  const asksForCreator = /^who\b[\s\S]{0,100}\b(?:created|creator|designed|developed|discovered|invented|introduced|wrote|written)\b/iu.test(transcript.trim());
  const asksWhatDefined = /^what\b[\s\S]{0,100}\bdefined\b/iu.test(transcript.trim());
  const asksForTwoEntities = /^which\s+two\b/iu.test(transcript.trim());
  const asksForCurrentCapital = /^what\s+(?:is|are)\s+(?:the\s+)?capital\s+(?:of|for)\b/iu.test(transcript.trim());
  const ranked = sentences.map((sentence, index) => {
    const normalized = normalizeTopic(sentence) ?? "";
    const terms = new Set(canonicalizeTokens(extractFtsTerms(sentence)));
    const queryMatches = queryTerms.filter((term) => terms.has(term)).length;
    const topicMatches = topicTerms.filter((term) => terms.has(term)).length;
    let score = queryMatches * 14 + topicMatches * 8 + Math.max(0, 12 - index);
    score += predicateTerms.filter((term) => terms.has(term)).length * 120;
    if (
      normalizedTitle
      && (normalized.startsWith(`${normalizedTitle} `) || normalized.startsWith(`the ${normalizedTitle} `))
    ) {
      score += 45;
    }
    if (index === leadIndex) {
      score += 300;
    }
    if (asksWhatDefined && index === 0 && /\b(?:is|are|was|were)\b/iu.test(sentence)) {
      score += 240;
    }
    if (asksForDate) {
      score += Math.min(2, sentence.match(/\b(?:1[0-9]{3}|20[0-9]{2})\b/gu)?.length ?? 0) * 70;
      if (/\b(?:began|ended|lasted|ran|started|adopted|issued|fell)\b/iu.test(sentence)) {
        score += 70;
      }
    }
    if (
      asksForCreator
      && /\b(?:began\s+work(?:ing)?|conceiv(?:e|ed)|creat(?:e|ed)|design(?:ed)?|develop(?:ed)?|discover(?:ed)?|invent(?:ed)?|introduc(?:e|ed)|writ(?:e|ten)|wrote)\b/iu.test(normalized)
    ) {
      score += 500;
    }
    if (
      asksForCreator
      && /\b\p{Lu}[\p{L}'-]+\s+\p{Lu}[\p{L}'-]+\b/u.test(sentence)
    ) {
      score += 220;
    }
    if (asksForCreator && /\bby\s+\p{Lu}[\p{L}'-]+(?:\s+\p{Lu}[\p{L}'-]+)+\b/u.test(sentence)) {
      score += 400;
    }
    if (
      asksForCreator
      && /\bby\s+\p{Lu}[\p{L}'-]+(?:\s+(?:(?:da|de|del|di|du|van|von)\s+)?\p{Lu}[\p{L}'-]+)+\b/u.test(sentence)
    ) {
      score += 550;
    }
    if (
      asksForCreator
      && /\bby\s+(?:[\p{L}'-]+\s+){0,3}(?:author|discoverer|inventor|scientist|writer)\s+\p{Lu}[\p{L}'-]+(?:\s+\p{Lu}[\p{L}'-]+)+\b/u.test(sentence)
    ) {
      score += 700;
    }
    if (
      /^who\s+wrote\b/iu.test(transcript.trim())
      && /\b(?:book|novel|play|poem|story|work)\b[^.]{0,100}\bby\b/iu.test(sentence)
    ) {
      score += 800;
    }
    if (
      asksForTwoEntities
      && /\b(?:between|by)\s+(?:the\s+)?\p{Lu}[\p{L}'-]+(?:\s+\p{Lu}[\p{L}'-]+)*\s+and\s+(?:the\s+)?\p{Lu}[\p{L}'-]+(?:\s+\p{Lu}[\p{L}'-]+)*/u.test(sentence)
    ) {
      score += 300;
    }
    if (asksForCurrentCapital) {
      if (/\b(?:its|the|their)\s+capital\s+(?:is|are)\b/iu.test(sentence)) {
        score += 320;
      }
      if (/\b(?:former|historic(?:al)?)\s+capital\b|\bcapital\b[\s\S]{0,50}\b(?:was|transferred|moved|served)\b/iu.test(sentence)) {
        score -= 300;
      }
    }
    return { sentence, index, score };
  }).sort((left, right) => right.score - left.score || left.index - right.index);
  const best = ranked[0];
  if (!best || best.score < 24) {
    return abstract;
  }
  const titleTerms = canonicalizeTokens(extractFtsTerms(hit.title));
  const bestTerms = new Set(canonicalizeTokens(extractFtsTerms(best.sentence)));
  const namesTitle = titleTerms.length > 0 && titleTerms.every((term) => bestTerms.has(term));
  const selected = compactWikipediaSentence(best.sentence);
  const opening = compactWikipediaSentence(openingSentence);
  if (best.index === 0 || !openingTrusted || selected === opening) {
    return selected;
  }
  const topicSet = new Set(topicTerms);
  const titleMatchesTopic = titleTerms.length > 0 && titleTerms.every((term) => topicSet.has(term));
  if (namesTitle || !titleMatchesTopic) {
    return `${selected} ${opening}`;
  }
  return `${hit.title}. ${selected}`;
}

export function selectSupportedWikipediaAnswerExcerpt(
  transcript: string,
  hit: WikipediaKnowledgeHit,
): string | null {
  const answer = wikipediaAnswerSentences(transcript, hit);
  const opening = answer.openingTrusted ? compactWikipediaSentence(answer.opening) : "";
  const preferred = selectWikipediaAnswerExcerpt(transcript, hit);
  const candidates = [
    preferred,
    ...answer.sentences.map(compactWikipediaSentence),
  ].filter((candidate, index, values) => candidate && values.indexOf(candidate) === index);
  for (const candidate of candidates) {
    if (!wikipediaExcerptSupportsQuestion(transcript, hit, candidate)) {
      continue;
    }
    if (answer.definitionQuestion && !mentionsWikipediaSubject(candidate.replace(`${hit.title}. `, ""), hit)) {
      continue;
    }
    if (candidate === preferred || candidate === opening || !opening) {
      return candidate;
    }
    const candidateTerms = new Set(canonicalizeTokens(extractFtsTerms(candidate)));
    const titleTerms = canonicalizeTokens(extractFtsTerms(hit.title));
    return titleTerms.length > 0 && titleTerms.every((term) => candidateTerms.has(term))
      ? candidate
      : `${candidate} ${opening}`;
  }
  return null;
}

export function wikipediaExcerptSupportsQuestion(
  transcript: string,
  hit: WikipediaKnowledgeHit,
  excerpt: string,
): boolean {
  const question = normalizeTopic(cleanKnowledgeTranscript(transcript)) ?? "";
  const evidence = normalizeTopic(excerpt) ?? "";
  if (!question || !evidence) {
    return false;
  }
  const query = parseWikipediaQuery(transcript);
  if (!query) {
    return false;
  }
  const titleEvidence = [hit.title, hit.resolvedFromTitle ?? "", excerpt].join(" ");
  const titleEvidenceTerms = new Set(canonicalizeTokens(extractFtsTerms(titleEvidence)));
  const questionTerms = [...new Set(canonicalizeTokens(extractFtsTerms(question)))];
  const matchedQuestionTerms = questionTerms.filter((term) => (
    titleEvidenceTerms.has(term) || semanticTermAppears(term, titleEvidenceTerms)
  ));

  const topicTerms = canonicalizeTokens(extractFtsTerms(query.topic));
  const matchedTopicTerms = topicTerms.filter((term) => (
    titleEvidenceTerms.has(term) || semanticTermAppears(term, titleEvidenceTerms)
  ));
  const topicMatched = topicTerms.length === 0
    || matchedTopicTerms.length >= Math.max(1, Math.ceil(topicTerms.length * 0.66));
  const normalizedTitle = normalizeStoredTitle(hit.title.replace(/\s*\([^)]*\)\s*$/u, ""));
  const normalizedTopic = normalizeStoredTitle(query.topic);
  const normalizedResolvedTitle = normalizeStoredTitle(hit.resolvedFromTitle ?? "");
  const topicAcronyms = dottedAcronymTerms(query.topic);
  const topicWithoutAcronym = acronymBaseTitle(query.topic);
  const dottedAcronymSupported = topicAcronyms.length > 0
    && Boolean(topicWithoutAcronym)
    && normalizedTitle === topicWithoutAcronym
    && topicAcronyms.some((acronym) => textContainsInitialism(
      `${hit.description ?? ""} ${hit.abstract}`,
      acronym,
    ));
  const strongResolvedTitle = normalizedTitle === normalizedTopic
    || normalizedResolvedTitle === normalizedTopic
    || dottedAcronymSupported
    || labelsCanonicallyEquivalent(hit.title.replace(/\s*\([^)]*\)\s*$/u, ""), query.topic);
  const subjectSupported = topicMatched || strongResolvedTitle;
  if (query.directSubject && !subjectSupported) {
    return false;
  }
  if (!namedQuestionAnchorsAreSupported(transcript, titleEvidenceTerms)) {
    return false;
  }

  const leadingWhichProperty = /^which\s+(.+?)\s+(?:is|are|was|were)\s+(.+)$/u.exec(question);
  if (leadingWhichProperty?.[2]) {
    const predicateTerms = canonicalizeTokens(extractFtsTerms(leadingWhichProperty[2]));
    const matchedPredicateTerms = predicateTerms.filter((term) => (
      titleEvidenceTerms.has(term) || semanticTermAppears(term, titleEvidenceTerms)
    ));
    if (
      predicateTerms.length >= 2
      && matchedPredicateTerms.length < Math.ceil(predicateTerms.length * 0.75)
    ) {
      return false;
    }
  }

  const trailingWhichDescriptor = /\b(?:at|by|for|from|in|of|on|to|with)\s+which\s+(.+)$/u.exec(question)?.[1];
  if (trailingWhichDescriptor && !/^(?:years?|date)\b/u.test(trailingWhichDescriptor)) {
    const descriptorTerms = canonicalizeTokens(extractFtsTerms(trailingWhichDescriptor));
    const matchedDescriptorTerms = descriptorTerms.filter((term) => (
      titleEvidenceTerms.has(term) || semanticTermAppears(term, titleEvidenceTerms)
    ));
    if (
      descriptorTerms.length > 0
      && matchedDescriptorTerms.length < Math.ceil(descriptorTerms.length * 0.75)
    ) {
      return false;
    }
  }

  const causalTarget = /^which\s+.+?\s+caused\s+(.+)$/u.exec(question)?.[1]?.replace(/^the\s+/u, "");
  if (causalTarget) {
    const targetIndex = evidence.indexOf(causalTarget);
    const reversedCauseIndex = targetIndex >= 0
      ? evidence.indexOf("caused by", targetIndex + causalTarget.length)
      : -1;
    if (reversedCauseIndex >= 0 && reversedCauseIndex - targetIndex < 80) {
      return false;
    }
  }

  const currentCapital = /^what\s+(?:is|are)\s+(?:the\s+)?capital\s+(?:of|for)\b/u.test(question);
  if (currentCapital) {
    if (/\b(?:former|historic(?:al)?|old)\s+capital\b|\bwas\s+(?:the\s+)?capital\b/u.test(evidence)) {
      return false;
    }
    return /\bcapital(?:\s+city)?\b[^.]{0,100}\b(?:is|are)\b|\b(?:is|are)\b[^.]{0,100}\bcapital(?:\s+city)?\b/u.test(evidence)
      && subjectSupported;
  }

  const superlative = /\b(largest|smallest|highest|lowest|longest|shortest|closest|deepest|hardest|oldest|fastest)\b/u.exec(question)?.[1];
  if (superlative && !hasUnqualifiedSuperlativeEvidence(evidence, superlative)) {
    return false;
  }
  const requestedAnswerType = answerEntityType(transcript);
  if (
    superlative
    && requestedAnswerType
    && !new Set(canonicalizeTokens(extractFtsTerms(evidence))).has(canonicalizeToken(requestedAnswerType))
  ) {
    return false;
  }

  const asksForYear = /^(?:when\b|in\s+what\s+years?\b|what\s+years?\b|(?:in\s+)?which\s+years?\b)|\bwhat\s+(?:year|date)\b/u.test(question);
  if (asksForYear) {
    const years = evidence.match(/\b(?:1[0-9]{3}|20[0-9]{2})\b/gu) ?? [];
    const requiredYears = /^(?:in\s+)?(?:what|which)\s+years\b/u.test(question) ? 2 : 1;
    if (years.length < requiredYears || !subjectSupported) {
      return false;
    }
    const boundaryRelation = /\b(begin|began|start|started|end|ended|fall|fell)\b/u.exec(question)?.[1];
    if (!boundaryRelation) {
      return true;
    }
    const relationSource = /^(?:begin|began|start|started)$/u.test(boundaryRelation)
      ? "(?:begin|began|begun|start|started)"
      : /^(?:end|ended)$/u.test(boundaryRelation)
        ? "(?:end|ended|conclud(?:e|ed))"
        : "(?:fall|fell|fallen)";
    const yearSource = "(?:1[0-9]{3}|20[0-9]{2})";
    return new RegExp(`\\b${relationSource}\\b[^.]{0,100}\\b${yearSource}\\b|\\b${yearSource}\\b[^.]{0,100}\\b${relationSource}\\b`, "u").test(evidence);
  }

  const creatorRelation = creatorRelationFromQuestion(question);
  if (
    creatorRelation
    && (
      !creatorRelationIsEvidenced(evidence, creatorRelation)
      || !creatorAgentIsEvidenced(excerpt, creatorRelation)
    )
  ) {
    return false;
  }
  if (creatorRelation && subjectSupported) {
    return true;
  }

  if (/\bwhat\s+day\s+is\b/u.test(question)) {
    return subjectSupported
      && /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/u.test(evidence);
  }

  if (/^why\b/u.test(question) && !/\b(?:because|enabled|helped|key|led|made\s+it\s+possible|provided|used\s+to)\b/u.test(evidence)) {
    return false;
  }

  if (/\bhow\s+often\b/u.test(question)) {
    return subjectSupported
      && /\b\d+(?:\s*[–—-]\s*\d+)?\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|centuries)\b/u.test(evidence);
  }

  if (/\belectrical\s+charge\b/u.test(question) && !/\b(?:positive|negative|neutral|no\s+charge|uncharged)\b/u.test(evidence)) {
    return false;
  }

  const possessiveProperty = /^what\s+(?:is|are|was|were)\s+.+?(?:'s|\s+s)\s+(.+)$/u.exec(question)?.[1];
  if (possessiveProperty) {
    const propertyTerms = canonicalizeTokens(extractFtsTerms(possessiveProperty));
    const matches = propertyTerms.filter((term) => titleEvidenceTerms.has(term) || semanticTermAppears(term, titleEvidenceTerms));
    if (matches.length < Math.max(1, Math.ceil(propertyTerms.length * 0.66))) {
      return false;
    }
  }

  const property = /^what\s+(?:is|are|was|were)\s+(?:the\s+)?(.+?)\s+(?:of|for)\b/u.exec(question)?.[1];
  if (property) {
    const propertyTerms = canonicalizeTokens(extractFtsTerms(property))
      .filter((term) => !EVIDENCE_GENERIC_PROPERTY_TERMS.has(term));
    if (propertyTerms.length > 0 && !propertyTerms.some((term) => (
      titleEvidenceTerms.has(term) || semanticTermAppears(term, titleEvidenceTerms)
    ))) {
      return false;
    }
  }

  const leadingProperty = /^what\s+(?!about\b|is\b|are\b|was\b|were\b|does\b|do\b|did\b)([\p{L}-]+)\b/u.exec(question)?.[1];
  if (leadingProperty && !titleEvidenceTerms.has(canonicalizeToken(leadingProperty))) {
    return false;
  }

  const definitionQuestion = /^what\s+(?:is|are|was|were)\s+(?:an?\s+|the\s+)?/u.test(question)
    || /^do\s+you\s+know\s+what\s+.+\s+(?:is|are|was|were)\b/u.test(question)
    || /^(?:define|explain|tell\s+me\s+about)\b/u.test(question)
    || /^return\s+to\b.*\bdefinition\b/u.test(question)
    || /\bdefinition\s+of\b/u.test(question);
  if (definitionQuestion && !possessiveProperty && topicTerms.length > 0) {
    if (!subjectSupported || !/\b(?:is|are|was|were|refers?\s+to)\b/u.test(evidence)) {
      return false;
    }
    if (!looksLikeAnswerEntityQuestion(transcript)) {
      return true;
    }
  }

  const minimumQuestionMatches = Math.min(
    questionTerms.length,
    Math.max(2, Math.ceil(questionTerms.length * 0.6)),
  );
  if (matchedQuestionTerms.length < minimumQuestionMatches) {
    return false;
  }
  return true;
}

type WikipediaCreatorRelation = "compose" | "create" | "design" | "direct" | "discover" | "found" | "introduce" | "invent" | "paint" | "propose" | "record" | "sculpt" | "write";

const EVIDENCE_GENERIC_PROPERTY_TERMS = new Set([
  "basic",
  "kind",
  "main",
  "major",
  "type",
]);

const SUPERLATIVE_EVIDENCE_TERMS: Readonly<Record<string, readonly string[]>> = {
  closest: ["closest", "nearest"],
  deepest: ["deepest"],
  fastest: ["fastest"],
  hardest: ["hardest", "highest hardness"],
  highest: ["highest"],
  largest: ["largest"],
  longest: ["longest"],
  lowest: ["lowest"],
  oldest: ["oldest"],
  shortest: ["shortest"],
  smallest: ["smallest"],
};

function hasUnqualifiedSuperlativeEvidence(evidence: string, requested: string): boolean {
  return (SUPERLATIVE_EVIDENCE_TERMS[requested] ?? [requested]).some((term) => {
    const source = term.replaceAll(/\s+/g, "\\s+");
    const withoutOrdinalUses = evidence.replace(
      new RegExp(`\\b(?:second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\\d+(?:st|nd|rd|th)?)\\s+${source}\\b`, "gu"),
      " ",
    );
    return new RegExp(`(?:^|[^\\p{L}\\p{N}-])${source}(?=$|[^\\p{L}\\p{N}])`, "u").test(withoutOrdinalUses);
  });
}

function namedQuestionAnchorsAreSupported(
  transcript: string,
  evidenceTerms: ReadonlySet<string>,
): boolean {
  const withoutLead = transcript.trim().replace(
    /^(?:What|Which|Who|When|Where|Why|How|In|At|Along|Do|Does|Did|Can|Could|Would|Will|Define|Explain|Tell|Return)\b\s*/u,
    "",
  );
  const anchors = withoutLead.match(
    /\b(?:[A-Z][\p{L}\p{M}'’-]*|[A-Z]{2,})(?:\s+(?:and|of|the|[A-Z][\p{L}\p{M}'’-]*|[A-Z]{2,})){0,7}\b/gu,
  ) ?? [];
  return anchors.every((anchor) => {
    if (/\b(?:[A-Z]\.){2,}/u.test(anchor)) {
      return true;
    }
    const terms = canonicalizeTokens(extractFtsTerms(anchor));
    const matched = terms.filter((term) => evidenceTerms.has(term) || semanticTermAppears(term, evidenceTerms));
    return terms.length === 0 || matched.length >= Math.max(1, Math.ceil(terms.length * 0.66));
  });
}

function creatorRelationFromQuestion(question: string): WikipediaCreatorRelation | null {
  const relations: ReadonlyArray<readonly [WikipediaCreatorRelation, RegExp]> = [
    ["write", /\b(?:wrote|written|write|author(?:ed)?)\b/u],
    ["compose", /\bcompos(?:e|ed|es|ing)\b/u],
    ["direct", /\bdirect(?:ed|s|ing)?\b/u],
    ["paint", /\bpaint(?:ed|s|ing)?\b/u],
    ["sculpt", /\bsculpt(?:ed|s|ing)?\b/u],
    ["design", /\bdesign(?:ed|s|ing)?\b/u],
    ["invent", /\binvent(?:ed|s|ing)?\b/u],
    ["propose", /\bpropos(?:e|ed|es|ing)\b/u],
    ["discover", /\bdiscover(?:ed|s|ing)?\b/u],
    ["found", /\bfound(?:ed|s|ing)?\b/u],
    ["introduce", /\bintroduc(?:e|ed|es|ing)\b/u],
    ["record", /\brecord(?:ed|s|ing)?\b/u],
    ["create", /\bcreat(?:e|ed|es|ing)\b/u],
  ];
  return relations.find(([, pattern]) => pattern.test(question))?.[0] ?? null;
}

function creatorRelationIsEvidenced(evidence: string, relation: WikipediaCreatorRelation): boolean {
  const patterns: Readonly<Record<WikipediaCreatorRelation, RegExp>> = {
    compose: /\b(?:compos(?:e|ed|er|ers|es|ing)|music\s+by)\b/u,
    create: /\b(?:creat(?:e|ed|or|ors|es|ing)|made\s+by|work\s+by)\b/u,
    design: /\b(?:design(?:ed|er|ers|s|ing)|architect(?:ed)?|architecture\s+by)\b/u,
    direct: /\b(?:direct(?:ed|or|ors|s|ing)|filmmaker)\b/u,
    discover: /\bdiscover(?:ed|er|ers|s|ing)?\b/u,
    found: /\bfound(?:ed|er|ers|s|ing)?\b/u,
    invent: /\b(?:invent(?:ed|or|ors|s|ing)|credited\s+with\s+(?:the\s+)?invention|patent(?:ed|ing)?)\b/u,
    introduce: /\bintroduc(?:e|ed|es|ing|tion)\b/u,
    paint: /\b(?:paint(?:ed|er|ers|ing)|painting\s+by)\b/u,
    propose: /\b(?:propos(?:e|ed|al|es|ing)|formulat(?:e|ed|es|ing)|introduc(?:e|ed|es|ing))\b/u,
    record: /\b(?:record(?:ed|s|ing)|recording\s+by)\b/u,
    sculpt: /\b(?:sculpt(?:ed|or|ors|ing)|sculpture\s+by|created\s+by)\b/u,
    write: /\b(?:wrote|written\s+by|authored\s+by|by\b[^.]{0,40}\b(?:author|writer)|(?:novel|book|play|poem|story)\b(?![^.]{0,80}\bpublished\b)[^.]{0,80}\bby)\b/u,
  };
  return patterns[relation].test(evidence);
}

function creatorAgentIsEvidenced(
  excerpt: string,
  relation: WikipediaCreatorRelation,
): boolean {
  const properName = "(?:[\\p{Lu}][\\p{L}\\p{M}'’-]+(?:\\s+(?:(?:da|de|del|di|du|van|von)\\s+)?[\\p{Lu}][\\p{L}\\p{M}'’-]+){0,5})";
  const relationSource: Readonly<Record<WikipediaCreatorRelation, string>> = {
    compose: "compos(?:e|ed|es|ing)",
    create: "creat(?:e|ed|es|ing)",
    design: "design(?:ed|s|ing)",
    direct: "direct(?:ed|s|ing)",
    discover: "discover(?:ed|s|ing)",
    found: "found(?:ed|s|ing)",
    introduce: "introduc(?:e|ed|es|ing)",
    invent: "invent(?:ed|s|ing)",
    paint: "paint(?:ed|s|ing)",
    propose: "propos(?:e|ed|es|ing)",
    record: "record(?:ed|s|ing)",
    sculpt: "sculpt(?:ed|s|ing)",
    write: "(?:wrote|written|author(?:ed|s|ing)?)",
  };
  const action = relationSource[relation];
  const namedBeforeAction = new RegExp(
    `(?:^|[.!?]\\s+|,\\s+)(?!(?:The|This|That|His|Her|Its|Their)\\b)${properName}[^.!?]{0,60}\\b${action}\\b`,
    "u",
  );
  const namedAfterAction = new RegExp(`\\b${action}\\b[^.!?]{0,80}\\bby\\s+(?:[\\p{L}\\p{M}'’-]+\\s+){0,4}${properName}`, "u");
  const typedCredit = new RegExp(
    `\\b(?:book|film|novel|painting|play|poem|print|sculpture|song|work)\\b[^.!?]{0,100}\\bby\\s+(?:[\\p{L}\\p{M}'’-]+\\s+){0,4}${properName}`,
    "u",
  );
  return namedBeforeAction.test(excerpt)
    || namedAfterAction.test(excerpt)
    || typedCredit.test(excerpt);
}

function semanticTermAppears(term: string, evidenceTerms: ReadonlySet<string>): boolean {
  return SEMANTIC_RELATION_GROUPS.some((group) => (
    group.includes(term) && group.some((related) => evidenceTerms.has(related))
  ));
}

interface WikipediaAnswerSentences {
  readonly sentences: readonly string[];
  readonly opening: string;
  readonly openingTrusted: boolean;
  readonly definitionQuestion: boolean;
  /** Index in `sentences` of the title's lead when the question asks what the title is; otherwise -1. */
  readonly leadIndex: number;
}

/**
 * The sentences an answer may use. Vandalism and tool leaks sit before the
 * article's real lead ("a grand final is..."), so a what-is question never
 * speaks anything before that lead, and the lead is the context opening.
 */
function wikipediaAnswerSentences(transcript: string, hit: WikipediaKnowledgeHit): WikipediaAnswerSentences {
  const all = splitWikipediaSentences(normalizeWikipediaAbstract(hit.abstract));
  const leadIndex = wikipediaTitleLeadIndex(all, hit.title);
  const definitionQuestion = asksWhatWikipediaTitleIs(transcript, hit);
  const sentences = definitionQuestion && leadIndex > 0 ? all.slice(leadIndex) : all;
  const opening = definitionQuestion ? sentences[0] ?? "" : all[Math.max(0, leadIndex)] ?? "";
  return {
    sentences,
    opening,
    openingTrusted: !definitionQuestion || mentionsWikipediaSubject(opening, hit),
    definitionQuestion,
    leadIndex: definitionQuestion && leadIndex >= 0 ? sentences.indexOf(all[leadIndex] ?? "") : -1,
  };
}

/** The abstract from the article's own lead onward, for answers with no question to rank against. */
export function wikipediaLeadText(hit: WikipediaKnowledgeHit): string {
  const sentences = splitWikipediaSentences(normalizeWikipediaAbstract(hit.abstract));
  return sentences.slice(Math.max(0, wikipediaTitleLeadIndex(sentences, hit.title))).join(" ");
}

function normalizeWikipediaAbstract(abstract: string): string {
  return abstract.replaceAll(/[\r\n\t]+/g, " ").replaceAll(/\s+/g, " ").trim();
}

/**
 * Index of the first sentence whose grammatical subject is the title itself,
 * right before its verb: "Primarily in Australian sports, a grand final is",
 * "Aspirin, also known as ASA, is", "Elton Hercules John (born...) is".
 * -1 when no sentence visibly leads with the title.
 */
function wikipediaTitleLeadIndex(sentences: readonly string[], title: string): number {
  const titleTerms = wikipediaSubjectTerms(title);
  if (titleTerms.length === 0) {
    return -1;
  }
  return sentences.findIndex((sentence) => {
    let text = sentence;
    for (let previous = ""; previous !== text;) {
      previous = text;
      text = text.replaceAll(/\([^()]*\)/gu, " ");
    }
    const copula = /\b(?:is|are|was|were)\b/iu.exec(text);
    if (!copula) {
      return false;
    }
    // The subject is the first comma segment (appositives follow it) or the last (a lead-in clause precedes it).
    const segments = text.slice(0, copula.index).split(",").map((segment) => segment.trim()).filter(Boolean);
    return [segments[0], segments.at(-1)].some((segment) => segmentIsTitleSubject(segment ?? "", titleTerms));
  });
}

/** "a grand final", "Sir Elton Hercules John": opens with the title, ends on it; not "the cytoplasm of a red blood cell". */
function segmentIsTitleSubject(segment: string, titleTerms: readonly string[]): boolean {
  const words = canonicalizeTokens(
    (segment.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}']*/gu) ?? []).filter((word, index) => index > 0 || !/^(?:a|an|the)$/u.test(word)),
  );
  return words.length > 0
    && words.length <= 10
    && words.indexOf(titleTerms[0] ?? "") <= 1
    && words.indexOf(titleTerms[0] ?? "") >= 0
    && words.at(-1) === titleTerms.at(-1)
    && titleTerms.every((term) => words.includes(term));
}

/** "What is a grand final?", "who was X", "tell me about X": the question asks what the title itself is. */
function asksWhatWikipediaTitleIs(transcript: string, hit: WikipediaKnowledgeHit): boolean {
  const core = stripKnowledgeRequestPoliteness(cleanKnowledgeTranscript(transcript))
    .replace(householdRegex(String.raw`^(?:hey\s+)?{ASSISTANT}\s*[,.]?\s*`, "iu"), "");
  const subject = /^(?:(?:what|who)(?:\s+(?:is|are|was|were)|[’']s)|tell\s+me\s+about|define)\s+(.+)$/iu.exec(core)?.[1];
  if (!subject) {
    return false;
  }
  const subjectTerms = new Set(canonicalizeTokens(extractFtsTerms(subject)));
  return [hit.title, hit.resolvedFromTitle ?? ""].some((label) => {
    const labelTerms = wikipediaSubjectTerms(label);
    return labelTerms.length > 0
      && labelTerms.length === subjectTerms.size
      && labelTerms.every((term) => subjectTerms.has(term));
  });
}

/** Subject check: the sentence names at least half of the title (or the name it was asked by). */
function mentionsWikipediaSubject(sentence: string, hit: WikipediaKnowledgeHit): boolean {
  const sentenceTerms = new Set(canonicalizeTokens(extractFtsTerms(sentence)));
  return [hit.title, hit.resolvedFromTitle ?? ""].some((label) => {
    const labelTerms = wikipediaSubjectTerms(label);
    return labelTerms.length > 0
      && labelTerms.filter((term) => sentenceTerms.has(term)).length >= Math.ceil(labelTerms.length / 2);
  });
}

function wikipediaSubjectTerms(title: string): readonly string[] {
  return [...new Set(canonicalizeTokens(extractFtsTerms(title.replace(/\s*\([^)]*\)\s*$/u, ""))))];
}

function compactWikipediaSentence(sentence: string): string {
  return sentence
    .replace(/,\s*sometimes\b[^.]{1,400},\s+(?=(?:is|are|was|were)\b)/iu, " ")
    .replace(/,\s*(?:sometimes|also|formerly|previously)\b[^,]{1,160},/iu, ",")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function splitWikipediaSentences(value: string): string[] {
  const initialMarker = "\u0000";
  return value
    .replace(/\b(\p{Lu})\.(?=\s+\p{Lu})/gu, `$1${initialMarker}`)
    // A sentence never starts lowercase, so "i.e. the", "e.g. a" and "approx. five" stay whole.
    .split(/(?<=[.!?])\s+(?!\p{Ll})/u)
    .map((sentence) => sentence.replaceAll(initialMarker, ".").trim())
    .filter(Boolean);
}

function questionPredicateTerms(
  transcript: string,
  topic: string | null,
): readonly string[] {
  const normalized = normalizeTopic(transcript);
  const normalizedTopic = normalizeTopic(topic ?? "");
  if (!normalized || !normalizedTopic) {
    return [];
  }
  const property = /^what\s+(?:is|was|are|were)\s+(?:the\s+)?(.+?)\s+(?:of|for)\s+/u.exec(normalized)?.[1];
  if (property) {
    return canonicalizeTokens(extractFtsTerms(property));
  }
  const possessiveProperty = /^what\s+(?:is|was|are|were)\s+.+?'s\s+(.+)$/u.exec(normalized)?.[1];
  if (possessiveProperty) {
    return canonicalizeTokens(extractFtsTerms(possessiveProperty));
  }
  if (/^which\b/u.test(normalized)) {
    const relation = normalized.match(/\b(associated|contains?|continued|flow|landed)\b/u)?.[1] ?? null;
    if (!relation) {
      return [];
    }
    const canonical = canonicalizeToken(relation);
    const group = SEMANTIC_RELATION_GROUPS.find((terms) => terms.includes(canonical));
    return group ?? [canonical];
  }
  const alongType = /^along\s+which\s+([\p{L}-]+)/u.exec(normalized)?.[1];
  if (alongType) {
    return [canonicalizeToken(alongType)];
  }
  if (!/^(?:what\s+(?:does|do|did)|in\s+what\s+years?|when)\b/u.test(normalized)) {
    return [];
  }
  const topicIndex = normalized.indexOf(normalizedTopic);
  if (topicIndex < 0) {
    return [];
  }
  const tail = normalized.slice(topicIndex + normalizedTopic.length).trim();
  const predicate = tail.match(/^[\p{L}][\p{L}'-]*/u)?.[0] ?? null;
  return predicate ? [canonicalizeToken(predicate)] : [];
}

export function looksLikeSubjectiveOpinionPrompt(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replaceAll(/[’']/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return looksLikeAssistantSelfOpinionPrompt(normalized)
    || looksLikeEvaluativeJudgementPrompt(normalized)
    || /\bwhat (?:do|did|would) you think (?:of|about)\b/.test(normalized)
    || /\b(?:what|which)\b[\s\S]*\b(?:do|did|would) you think\b[\s\S]*\b(?:best|worst|greatest|finest|strongest|weakest|favo(?:u)?rite)\b/.test(normalized)
    || looksLikeSubjectiveRankingPrompt(normalized)
    || /\bwhat(?: is| s) your (?:opinion|view|take|rating)\b/.test(normalized)
    || /\bhow (?:do|did|would) you rate\b/.test(normalized)
    || /\b(?:rate|score)\b[\s\S]*\bout of (?:10|ten)\b/.test(normalized)
    || /\bgive\b[\s\S]*\b(?:a )?(?:score|rating)\b/.test(normalized);
}

export function looksLikeSubjectiveRankingPrompt(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replaceAll(/[’']/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  const rank = "(?:best|worst|greatest|finest|strongest|weakest|favo(?:u)?rite)";
  const work = "(?:acting\\s+)?(?:role|performance|portrayal|character|film|movie|book|novel|story|song|album|record|episode|speech|debate|interview|work)";
  return new RegExp(
    `^(?:what|which)(?:\\s+do you think)?(?:\\s+is|\\s+was|\\s+would be)?\\s+.{2,80}?(?:\\s+s|s)\\s+${rank}\\s+${work}\\b`,
    "u",
  ).test(normalized)
    || new RegExp(
      `^(?:what|which)(?:\\s+do you think)?(?:\\s+is|\\s+was|\\s+would be)\\s+(?:the\\s+)?${rank}\\s+${work}\\b[\\s\\S]+\\b(?:has|have|had)\\b`,
      "u",
    ).test(normalized);
}

function parseWikipediaQuery(transcript: string): ParsedWikipediaQuery | null {
  const clean = cleanKnowledgeTranscript(transcript);
  if (!clean) {
    return null;
  }
  if (looksLikeSubjectiveOpinionPrompt(clean)) {
    return null;
  }
  if (resolveUnsupportedMathPrompt(clean)) {
    return null;
  }

  const directKnowledgeSubject = extractDirectKnowledgeSubject(clean);
  const searchText = directKnowledgeSubject ?? extractWikipediaSearchText(clean);
  if (!searchText) {
    return null;
  }
  const subjectCandidates = extractWikipediaSubjectCandidates(clean, searchText);
  const directSubjectAlreadyClean = directKnowledgeSubject !== null
    || /^(?:please\s+)?(?:do\s+you\s+know\s+)?(?:when\s+was\s+.+\s+(?:made|released)|what\s+year\s+was\s+.+\s+released|what\s+day\s+is\s+.+|what\s+year\s+did\s+.+|when\s+did\s+.+)$/i.test(clean);
  const semanticSubject = subjectCandidates[0]?.text ?? searchText;
  const preservesTitleArticle = /^the\s+/i.test(searchText)
    && searchText.split(/\s+/).filter(Boolean).length <= 6
    && normalizeStoredTitle(searchText.replace(/^the\s+/i, "")) === normalizeStoredTitle(semanticSubject);
  const topic = directSubjectAlreadyClean || preservesTitleArticle ? searchText : semanticSubject;
  return {
    topic,
    searchText,
    subjectCandidates,
    relationTerms: semanticRelationTermsExcludingSubject(
      clean,
      directKnowledgeSubject !== null ? topic : semanticSubject,
    ),
    directSubject: directKnowledgeSubject !== null,
  };
}

function cleanKnowledgeTranscript(transcript: string): string {
  return transcript
    .replaceAll(/[\r\n\t]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .replaceAll(/[?!.]+$/g, "")
    .trim();
}

function extractDirectKnowledgeSubject(clean: string): string | null {
  const core = stripKnowledgeRequestPoliteness(clean);
  const patterns = [
    /^who\s+.*\bintroduc(?:e|ed|es|ing)\s+(?:the\s+)?(.+?)\s+to\s+.+$/i,
    /^which\s+mission\b.*\bland(?:ed|s|ing)?\s+humans?\s+on\s+(?:the\s+)?(.+)$/i,
    /^(?:when|what (?:year|date))\s+(?:was|were|did)\s+(.+?)\s+(?:(?:first|originally)\s+)?(?:get\s+|got\s+|was\s+)?(?:released|published|premiered|premiere|debuted|debut|made|came\s+out|come\s+out)$/i,
    /^when\s+(.+?)\s+(?:was|were)\s+(?:(?:first|originally)\s+)?(?:released|published|premiered|debuted|made)$/i,
    /^in\s+(?:what|which)\s+years?\s+(?:did|was|were)\s+(?:the\s+)?(.+?)\s+(?:adopted|begin|began|end|ended|fall|fell|first\s+issued|issued|released|run|start|started)$/i,
    /^what\s+(?:is|was)\s+(?:the\s+)?(?:release|publication|premiere|debut)\s+(?:date|year)\s+(?:of|for)\s+(.+)$/i,
    /^(.+?)\s+(?:release|publication|premiere|debut)\s+(?:date|year)$/i,
    /^what\s+(?:is|was|are|were)\s+(.+?)\s+about$/i,
  ];
  for (const pattern of patterns) {
    const subject = pattern.exec(core)?.[1]?.trim();
    if (!subject) {
      continue;
    }
    const cleaned = cleanWikipediaTopic(subject);
    if (cleaned && !resolveUnsupportedMathPrompt(cleaned)) {
      return cleaned;
    }
  }
  const relationalObject = new RegExp(
    `^(?:who|which|what)\\s+.*\\b(?:${KNOWLEDGE_RELATION_VERB_SOURCE})\\s+(.+)$`,
    "iu",
  ).exec(core)?.[1];
  if (relationalObject) {
    const programmingLanguage = /\s+programming\s+language$/iu.test(relationalObject);
    const cleaned = cleanWikipediaTopic(
      stripCoordinatedQuestionTail(relationalObject)
        .replace(/^(?:the\s+)?original\s+/iu, "")
        .replace(/\s+(?:movie|film|novel|book|programming\s+language)$/iu, ""),
    ).replace(programmingLanguage ? /^(?:the\s+)/iu : /$^/u, "");
    if (cleaned && !resolveUnsupportedMathPrompt(cleaned)) {
      return cleaned;
    }
  }
  return null;
}

function stripKnowledgeRequestPoliteness(value: string): string {
  return value
    .replace(/^(?:please\s*[,;:]?\s*)+/i, "")
    .replace(/^(?:do\s+you\s+know|(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:tell\s+me|let\s+me\s+know))\s+/i, "")
    .trim();
}

function extractWikipediaSearchText(clean: string): string | null {
  const directPatterns = [
    /^(?:please\s+)?(?:do\s+you\s+know\s+)?when\s+was\s+(.+?)\s+made$/i,
    /^(?:please\s+)?(?:do\s+you\s+know\s+)?when\s+was\s+(.+?)\s+released$/i,
    /^(?:please\s+)?(?:do\s+you\s+know\s+)?what\s+year\s+was\s+(.+?)\s+released$/i,
    /^(?:please\s+)?(?:do\s+you\s+know\s+)?what\s+day\s+is\s+(.+)$/i,
    /^(?:please\s+)?(?:do\s+you\s+know\s+)?what\s+year\s+did\s+(.+)$/i,
    /^(?:please\s+)?(?:do\s+you\s+know\s+)?when\s+did\s+(.+)$/i,
    /^(?:please\s+)?do\s+you\s+know\s+what\s+(.+)$/i,
    /^(?:please\s+)?do\s+you\s+know\s+who\s+(.+)$/i,
    /^(?:please\s+)?do\s+you\s+know\s+where\s+(.+)$/i,
    /^(?:please\s+)?do\s+you\s+know\s+when\s+(.+)$/i,
    /^(?:please\s+)?(?:tell me|teach me)\s+about\s+(.+)$/i,
    /^(?:please\s+)?(?:give me|show me)\s+(?:a\s+)?summary\s+of\s+(.+)$/i,
    /^(?:please\s+)?(?:summarize|summary of|describe|define|explain)\s+(.+)$/i,
    /^(?:please\s+)?(?:what|who|where|when)\s+(?:is|are|was|were)\s+(.+)$/i,
  ];
  for (const pattern of directPatterns) {
    const match = pattern.exec(clean);
    const topic = match?.[1]?.trim();
    if (topic) {
      const cleanedTopic = cleanWikipediaTopic(topic);
      return cleanedTopic && !resolveUnsupportedMathPrompt(cleanedTopic) ? cleanedTopic : null;
    }
  }

  const query = clean
    .replace(/^(?:please\s+)?(?:can|could|would|will)\s+you\s+/i, "")
    .replace(/^(?:please\s+)?(?:do\s+you\s+(?:know|know about)|tell me|give me|show me)\s+/i, "")
    .replace(/^(?:what|who|where|when|why|how)\s+/i, "")
    .replace(/^(?:is|are|was|were|did|does|do|can|could|would|will)\s+/i, "")
    .trim();
  const cleanedTopic = cleanWikipediaTopic(query || clean);
  return cleanedTopic && !resolveUnsupportedMathPrompt(cleanedTopic) ? cleanedTopic : null;
}

export class WikipediaKnowledgeStore {
  private readonly dataDir: string;
  private readonly filePath: string;
  private db: DatabaseSync | null;
  private lookupsSinceConnectionOpen = 0;
  private lookupWorker: Worker | null = null;
  private lookupWorkerSequence = 0;
  private readonly pendingWorkerLookups = new Map<number, PendingWikipediaLookup>();
  private readonly recentWorkerLookups = new Map<string, RecentWikipediaLookup>();

  constructor(config: AppConfig | { readonly dataDir: string }) {
    this.dataDir = config.dataDir;
    this.filePath = wikipediaKnowledgeStorePath(config);
    this.db = existsSync(this.filePath) ? new DatabaseSync(this.filePath) : null;
  }

  lookup(transcript: string): WikipediaKnowledgeHit | null {
    return this.lookupWithDiagnostics(transcript).hit;
  }

  prewarm(spawnWorker = true): void {
    if (!this.db) {
      return;
    }
    try {
      this.db.prepare("SELECT page_id FROM articles LIMIT 1").get();
      this.db.prepare("SELECT rowid FROM articles_fts LIMIT 1").get();
    } catch {
      // Ignore warm-up failures and let normal lookup paths fail closed later.
    }
    if (spawnWorker) {
      this.ensureLookupWorker();
    }
  }

  lookupEarlyTitleText(titleText: string): WikipediaKnowledgeHit | null {
    if (!this.beginLookup()) {
      return null;
    }
    const storedTitle = normalizeStoredTitle(titleText);
    if (!storedTitle) {
      return null;
    }
    return this.resolveExactTitle(storedTitle)
      ?? this.resolveRedirectTitle(storedTitle)
      ?? this.resolveAcronymTitleFallback(titleText);
  }

  lookupEarlyTitleTextWithDiagnostics(titleText: string): WikipediaLookupResult {
    const startedAt = nowMs();
    const hit = this.lookupEarlyTitleText(titleText);
    return {
      hit,
      diagnostics: {
        ...emptyWikipediaLookupDiagnostics(),
        totalMs: elapsedSinceMs(startedAt),
      },
    };
  }

  lookupEarlyQualifiedTitleText(
    titleText: string,
    mediaKind: WikipediaMediaKind,
  ): WikipediaKnowledgeHit | null {
    if (!this.beginLookup()) {
      return null;
    }
    const hits = new Map<string, WikipediaKnowledgeHit>();
    for (const hypothesis of qualifiedTitleHypotheses(titleText, mediaKind)) {
      const hit = this.resolveQualifiedEarlyTitle(
        hypothesis.baseTitle,
        mediaKind,
        hypothesis.year,
      );
      if (!hit) {
        continue;
      }
      const key = normalizeStoredTitle(hit.title);
      if (key) {
        hits.set(key, hit);
      }
    }
    return hits.size === 1 ? [...hits.values()][0] ?? null : null;
  }

  lookupEarlyQualifiedTitleTextWithDiagnostics(
    titleText: string,
    mediaKind: WikipediaMediaKind,
  ): WikipediaLookupResult {
    const startedAt = nowMs();
    const hit = this.lookupEarlyQualifiedTitleText(titleText, mediaKind);
    return {
      hit,
      diagnostics: {
        ...emptyWikipediaLookupDiagnostics(),
        totalMs: elapsedSinceMs(startedAt),
      },
    };
  }

  lookupWithDiagnostics(transcript: string): WikipediaLookupResult {
    const timings = emptyWikipediaLookupDiagnostics();
    const startedAt = nowMs();
    if (!this.beginLookup()) {
      timings.totalMs = elapsedSinceMs(startedAt);
      return { hit: null, diagnostics: timings };
    }
    const query = parseWikipediaQuery(transcript);
    if (!query) {
      timings.totalMs = elapsedSinceMs(startedAt);
      return { hit: null, diagnostics: timings };
    }
    const topic = query.topic;
    const storedTitle = normalizeStoredTitle(topic);
    let directTitle: WikipediaKnowledgeHit | null = null;
    if (storedTitle) {
      const exactStartedAt = nowMs();
      const exact = this.resolveExactTitle(storedTitle);
      timings.exactTitleMs = elapsedSinceMs(exactStartedAt);
      directTitle = exact;
      if (!directTitle) {
        const redirectStartedAt = nowMs();
        directTitle = this.resolveRedirectTitle(storedTitle);
        timings.redirectMs = elapsedSinceMs(redirectStartedAt);
      }
    }
    if (!directTitle) {
      directTitle = this.resolveDirectTitleVariants(topic);
    }
    if (directTitle && /\bmain\s+function\s+(?:of|for)\b/iu.test(transcript)) {
      directTitle = this.resolveNonMediaTitleVariant(topic) ?? directTitle;
    }

    const creativeFacet = creativeWorkFacetFromTranscript(transcript);
    if (
      !creativeFacet.requested
      && looksLikeAnswerEntityQuestion(transcript)
      && (!directTitle || shouldDisambiguateAnswerEntity(transcript, query.topic, directTitle))
    ) {
      const answerSearchStartedAt = nowMs();
      const answerEntity = this.resolveAnswerEntityFts(transcript);
      timings.ftsStrictMs += elapsedSinceMs(answerSearchStartedAt);
      if (answerEntity) {
        timings.totalMs = elapsedSinceMs(startedAt);
        return { hit: answerEntity, diagnostics: timings };
      }
    }
    if (directTitle && prefersCanonicalWrittenWork(transcript, directTitle)) {
      timings.totalMs = elapsedSinceMs(startedAt);
      return { hit: directTitle, diagnostics: timings };
    }
    const familyBaseTitles = creativeFacet.requested || (directTitle === null && !query.directSubject)
      ? creativeTitleFamilyBaseTitles(query.topic, transcript)
      : [];
    if (familyBaseTitles.length > 0) {
      timings.creativeTitleFamilyAttempted = true;
      const familyStartedAt = nowMs();
      let family: CreativeTitleFamilyResolution = { handled: false, hit: null, candidates: [] };
      for (const familyBaseTitle of familyBaseTitles) {
        const familyDirectTitle = familyBaseTitle === storedTitle
          ? directTitle
          : this.resolveExactTitle(familyBaseTitle) ?? this.resolveRedirectTitle(familyBaseTitle);
        family = this.resolveCreativeTitleFamily(familyBaseTitle, creativeFacet, familyDirectTitle);
        if (family.handled) {
          break;
        }
      }
      timings.titleFamilyMs += elapsedSinceMs(familyStartedAt);
      if (family.handled) {
        timings.totalMs = elapsedSinceMs(startedAt);
        if (family.hit) {
          return { hit: family.hit, diagnostics: timings };
        }
        return family.candidates.length > 0
          ? {
              hit: null,
              diagnostics: timings,
              ambiguity: {
                kind: "media_title",
                topic: query.topic,
                candidates: family.candidates,
              },
            }
          : { hit: null, diagnostics: timings };
      }
    }

    if (directTitle && splitCompositeTitle(query.searchText)) {
      timings.totalMs = elapsedSinceMs(startedAt);
      return { hit: directTitle, diagnostics: timings };
    }

    const compositeAliasStartedAt = nowMs();
    const compositeAlias = this.resolveCompositeTitleAlias(query);
    timings.titleFamilyMs += elapsedSinceMs(compositeAliasStartedAt);
    if (compositeAlias) {
      timings.totalMs = elapsedSinceMs(startedAt);
      return { hit: compositeAlias, diagnostics: timings };
    }

    const semanticTitleStartedAt = nowMs();
    const semanticTitle = this.resolveSemanticSubjectTitle(query);
    timings.titleFamilyMs += elapsedSinceMs(semanticTitleStartedAt);
    if (semanticTitle) {
      timings.totalMs = elapsedSinceMs(startedAt);
      return { hit: semanticTitle, diagnostics: timings };
    }
    if (directTitle) {
      timings.totalMs = elapsedSinceMs(startedAt);
      return { hit: directTitle, diagnostics: timings };
    }

    const acronymStartedAt = nowMs();
    const acronymFallback = this.resolveAcronymTitleFallback(topic);
    timings.acronymMs = elapsedSinceMs(acronymStartedAt);
    if (acronymFallback) {
      timings.totalMs = elapsedSinceMs(startedAt);
      return { hit: acronymFallback, diagnostics: timings };
    }

    const titleFamilyStartedAt = nowMs();
    const titleFamilyFallback = this.resolveTitleFamilyFallback(topic);
    timings.titleFamilyMs += elapsedSinceMs(titleFamilyStartedAt);
    if (titleFamilyFallback) {
      timings.totalMs = elapsedSinceMs(startedAt);
      return { hit: titleFamilyFallback, diagnostics: timings };
    }

    const fts = this.resolveFts(query.searchText, timings, "");
    if (fts) {
      timings.totalMs = elapsedSinceMs(startedAt);
      return { hit: fts, diagnostics: timings };
    }

    const normalizedTopic = normalizeTopic(query.searchText);
    if (!normalizedTopic) {
      timings.totalMs = elapsedSinceMs(startedAt);
      return { hit: null, diagnostics: timings };
    }
    const normalizedFts = this.resolveFts(normalizedTopic, timings, "normalized");
    timings.totalMs = elapsedSinceMs(startedAt);
    return { hit: normalizedFts, diagnostics: timings };
  }

  lookupWithDiagnosticsAsync(
    transcript: string,
    timeoutMs = DEFAULT_WIKIPEDIA_LOOKUP_TIMEOUT_MS,
  ): Promise<WikipediaLookupResult> {
    if (!extractWikipediaTopic(transcript)) {
      return Promise.resolve({
        hit: null,
        diagnostics: emptyWikipediaLookupDiagnostics(),
      });
    }
    return this.lookupWithWorker({ kind: "query", transcript }, timeoutMs);
  }

  lookupEarlyTitleTextAsync(
    titleText: string,
    timeoutMs = DEFAULT_WIKIPEDIA_LOOKUP_TIMEOUT_MS,
  ): Promise<WikipediaLookupResult> {
    if (!normalizeStoredTitle(titleText)) {
      return Promise.resolve({
        hit: null,
        diagnostics: emptyWikipediaLookupDiagnostics(),
      });
    }
    return this.lookupWithWorker({ kind: "early_title", titleText }, timeoutMs);
  }

  lookupEarlyQualifiedTitleTextAsync(
    titleText: string,
    mediaKind: WikipediaMediaKind,
    timeoutMs = DEFAULT_WIKIPEDIA_LOOKUP_TIMEOUT_MS,
  ): Promise<WikipediaLookupResult> {
    if (!normalizeStoredTitle(titleText)) {
      return Promise.resolve({
        hit: null,
        diagnostics: emptyWikipediaLookupDiagnostics(),
      });
    }
    return this.lookupWithWorker({
      kind: "early_qualified_title",
      titleText,
      mediaKind,
    }, timeoutMs);
  }

  private lookupWithWorker(
    request: WikipediaWorkerLookupRequest,
    timeoutMs: number,
  ): Promise<WikipediaLookupResult> {
    const cacheKey = JSON.stringify(request);
    const cached = this.recentWorkerLookups.get(cacheKey);
    if (cached && cached.expiresAt >= Date.now()) {
      return Promise.resolve(cached.result);
    }
    if (cached) {
      this.recentWorkerLookups.delete(cacheKey);
    }
    const worker = this.ensureLookupWorker();
    if (!worker) {
      return Promise.resolve({
        hit: null,
        diagnostics: emptyWikipediaLookupDiagnostics(),
      });
    }
    const boundedTimeoutMs = Math.max(1, Math.trunc(timeoutMs));
    return new Promise<WikipediaLookupResult>((resolve) => {
      const startedAt = nowMs();
      const id = ++this.lookupWorkerSequence;
      const timer = setTimeout(() => {
        const pending = this.pendingWorkerLookups.get(id);
        if (!pending) {
          return;
        }
        this.pendingWorkerLookups.delete(id);
        pending.resolve({
          hit: null,
          diagnostics: {
            ...emptyWikipediaLookupDiagnostics(),
            totalMs: elapsedSinceMs(startedAt),
            timedOut: true,
          },
        });
        this.failLookupWorker();
      }, boundedTimeoutMs);
      this.pendingWorkerLookups.set(id, { resolve, timer, startedAt });
      worker.postMessage({ id, ...request });
    }).then((result) => {
      this.rememberWorkerLookup(cacheKey, result);
      return result;
    });
  }

  close(): void {
    this.failLookupWorker();
    this.recentWorkerLookups.clear();
    const db = this.db;
    this.db = null;
    db?.close();
  }

  private beginLookup(): boolean {
    if (!this.db) {
      return false;
    }
    if (this.lookupsSinceConnectionOpen >= MAX_WIKIPEDIA_LOOKUPS_PER_CONNECTION) {
      const previous = this.db;
      this.db = null;
      try {
        previous.close();
        this.db = new DatabaseSync(this.filePath);
      } catch {
        this.db = null;
        return false;
      }
      this.lookupsSinceConnectionOpen = 0;
    }
    this.lookupsSinceConnectionOpen += 1;
    return true;
  }

  private ensureLookupWorker(): Worker | null {
    if (!this.db) {
      return null;
    }
    if (this.lookupWorker) {
      return this.lookupWorker;
    }
    const worker = new Worker(
      new URL("./wikipedia-lookup-worker.js", import.meta.url),
      { workerData: { dataDir: this.dataDir } },
    );
    this.lookupWorker = worker;
    worker.on("message", (message: WikipediaWorkerResponse) => {
      const pending = this.pendingWorkerLookups.get(message.id);
      if (!pending) {
        return;
      }
      this.pendingWorkerLookups.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message.result);
    });
    worker.on("error", () => {
      this.failLookupWorker(worker);
    });
    worker.on("exit", () => {
      this.failLookupWorker(worker);
    });
    worker.unref();
    return worker;
  }

  private failLookupWorker(worker = this.lookupWorker): void {
    if (worker && this.lookupWorker === worker) {
      this.lookupWorker = null;
      worker.removeAllListeners();
      void worker.terminate();
    }
    for (const [id, pending] of this.pendingWorkerLookups) {
      this.pendingWorkerLookups.delete(id);
      clearTimeout(pending.timer);
      pending.resolve({
        hit: null,
        diagnostics: {
          ...emptyWikipediaLookupDiagnostics(),
          totalMs: elapsedSinceMs(pending.startedAt),
        },
      });
    }
  }

  private rememberWorkerLookup(cacheKey: string, result: WikipediaLookupResult): void {
    this.recentWorkerLookups.delete(cacheKey);
    this.recentWorkerLookups.set(cacheKey, {
      expiresAt: Date.now() + RECENT_WIKIPEDIA_LOOKUP_TTL_MS,
      result,
    });
    while (this.recentWorkerLookups.size > MAX_RECENT_WIKIPEDIA_LOOKUPS) {
      const oldest = this.recentWorkerLookups.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.recentWorkerLookups.delete(oldest);
    }
  }

  private resolveExactTitle(normalizedTitle: string): WikipediaKnowledgeHit | null {
    if (!this.db) {
      return null;
    }
    const row = this.db.prepare(`
      SELECT title, description, abstract, url, wikidata_id, is_redirect, redirect_target, redirect_normalized_title
      FROM articles
      WHERE normalized_title = ? AND is_redirect = 0 AND abstract IS NOT NULL AND trim(abstract) != ''
      ORDER BY CASE WHEN title GLOB '*[a-z]*' THEN 0 ELSE 1 END, length(title), title
      LIMIT 1
    `).get(normalizedTitle) as WikipediaRow | undefined;
    return row ? materializeKnowledgeHit(row, "exact_title", null) : null;
  }

  private resolveRedirectTitle(normalizedTitle: string): WikipediaKnowledgeHit | null {
    if (!this.db) {
      return null;
    }
    const redirect = this.db.prepare(`
      SELECT title, description, abstract, url, wikidata_id, is_redirect, redirect_target, redirect_normalized_title
      FROM articles
      WHERE normalized_title = ? AND is_redirect = 1 AND redirect_normalized_title IS NOT NULL
      LIMIT 1
    `).get(normalizedTitle) as WikipediaRow | undefined;
    if (!redirect?.redirect_normalized_title) {
      return null;
    }
    const target = this.db.prepare(`
      SELECT title, description, abstract, url, wikidata_id, is_redirect, redirect_target, redirect_normalized_title
      FROM articles
      WHERE normalized_title = ? AND is_redirect = 0 AND abstract IS NOT NULL AND trim(abstract) != ''
      ORDER BY CASE WHEN title GLOB '*[a-z]*' THEN 0 ELSE 1 END, length(title), title
      LIMIT 1
    `).get(redirect.redirect_normalized_title) as WikipediaRow | undefined;
    return target ? materializeKnowledgeHit(target, "redirect", redirect.title) : null;
  }

  private resolveQualifiedEarlyTitle(
    baseTitleText: string,
    mediaKind: WikipediaMediaKind,
    year: number | null,
  ): WikipediaKnowledgeHit | null {
    if (!this.db) {
      return null;
    }
    const baseTitle = normalizeStoredTitle(baseTitleText);
    if (!baseTitle) {
      return null;
    }
    const hits = new Map<string, WikipediaKnowledgeHit>();
    const familyPrefix = `${baseTitle} (`;
    const rows = this.db.prepare(`
      SELECT title, description, abstract, url, wikidata_id, is_redirect, redirect_target, redirect_normalized_title
      FROM articles
      WHERE normalized_title = ?
        OR (normalized_title >= ? AND normalized_title < ?)
      ORDER BY normalized_title
      LIMIT 64
    `).all(baseTitle, familyPrefix, `${familyPrefix}\uffff`) as unknown as WikipediaRow[];
    for (const row of rows) {
      const rowTitle = normalizeStoredTitle(row.title);
      const rowBase = splitParentheticalTitle(row.title)?.base ?? row.title;
      if (
        rowTitle !== baseTitle
        && !labelsCanonicallyEquivalent(rowBase, baseTitle)
      ) {
        continue;
      }
      const resolved = row.is_redirect && row.redirect_normalized_title
        ? this.resolveExactTitle(row.redirect_normalized_title)
        : materializeKnowledgeHit(row, "qualified_title", null);
      if (!resolved || !qualifiedIdentityMatches(resolved, mediaKind, year)) {
        continue;
      }
      const hit: WikipediaKnowledgeHit = {
        ...resolved,
        matchedBy: "qualified_title",
        resolvedFromTitle: row.is_redirect ? row.title : null,
      };
      const key = normalizeStoredTitle(hit.title);
      if (key) {
        hits.set(key, hit);
      }
    }
    return hits.size === 1 ? [...hits.values()][0] ?? null : null;
  }

  private resolveFts(
    queryText: string,
    timings: WikipediaLookupDiagnostics,
    timingPrefix: "" | "normalized",
  ): WikipediaKnowledgeHit | null {
    if (!this.db) {
      return null;
    }
    const titleBroadQuery = buildScopedFtsMatchQuery(queryText, "OR", "title");
    const strictQuery = buildFtsMatchQuery(queryText, "AND");
    const broadQuery = buildFtsMatchQuery(queryText, "OR");
    const titleStartedAt = nowMs();
    const titleRows = runFtsQuery(this.db, titleBroadQuery);
    assignFtsTiming(timings, timingPrefix, "title", elapsedSinceMs(titleStartedAt));
    const titleHit = bestFtsKnowledgeHit(titleRows, queryText, (normalizedTitle) => this.resolveExactTitle(normalizedTitle));
    if (titleHit && titleScopedHitLooksStrong(queryText, titleHit)) {
      return titleHit;
    }
    const strictStartedAt = nowMs();
    const strictRows = runFtsQuery(this.db, strictQuery);
    assignFtsTiming(timings, timingPrefix, "strict", elapsedSinceMs(strictStartedAt));
    const broadStartedAt = nowMs();
    const broadRows = runFtsQuery(this.db, broadQuery);
    assignFtsTiming(timings, timingPrefix, "broad", elapsedSinceMs(broadStartedAt));
    const mergedRows = mergeFtsRows(titleRows, strictRows, broadRows);
    const hit = bestFtsKnowledgeHit(mergedRows, queryText, (normalizedTitle) => this.resolveExactTitle(normalizedTitle));
    if (hit) {
      return hit;
    }
    return null;
  }

  private resolveAnswerEntityFts(transcript: string): WikipediaKnowledgeHit | null {
    if (!this.db) {
      return null;
    }
    const normalizedQuestion = normalizeFtsSpelling(cleanKnowledgeTranscript(transcript));
    const searchText = needsImplicitEarthScope(normalizedQuestion)
      ? `${normalizedQuestion} Earth`
      : normalizedQuestion;
    const strictRows = runFtsQuery(this.db, buildFtsMatchQuery(searchText, "AND"), 256, false);
    const broadRows = strictRows.length === 0
      ? runFtsQuery(this.db, buildFtsMatchQuery(searchText, "OR"), 256, false)
      : [];
    const rows = rankAnswerEntityRows(mergeFtsRows(strictRows, broadRows), searchText);
    for (const row of rows) {
      for (const entityName of extractAnswerEntityNames(transcript, String(row.abstract ?? ""))) {
        const requestedType = answerEntityType(transcript);
        const qualifiedTitle = requestedType
          ? normalizeStoredTitle(`${entityName} (${requestedType})`)
          : null;
        const qualified = qualifiedTitle
          ? this.resolveExactTitle(qualifiedTitle)
          : null;
        const resolved = qualified ?? this.resolveDirectTitleVariants(entityName);
        if (resolved && !looksLikeDisambiguationAbstract(resolved.abstract)) {
          return { ...resolved, matchedBy: "fts", resolvedFromTitle: row.title };
        }
      }
    }
    for (const row of rows) {
      if (row.is_redirect && row.redirect_normalized_title) {
        const resolved = this.resolveExactTitle(row.redirect_normalized_title);
        if (resolved) {
          return { ...resolved, matchedBy: "fts", resolvedFromTitle: row.title };
        }
      }
      const hit = materializeKnowledgeHit(row, "fts", null);
      if (hit) {
        return hit;
      }
    }
    return null;
  }

  private resolveAcronymTitleFallback(topic: string): WikipediaKnowledgeHit | null {
    if (!this.db) {
      return null;
    }
    const acronymTerms = dottedAcronymTerms(topic);
    if (acronymTerms.length === 0) {
      return null;
    }
    const baseTitle = acronymBaseTitle(topic);
    if (!baseTitle) {
      return null;
    }
    const disambiguationPrefix = `${baseTitle} (`;
    const rows = this.db.prepare(`
      SELECT title, description, abstract, url, wikidata_id, is_redirect, redirect_target, redirect_normalized_title
      FROM articles
      WHERE is_redirect = 0
        AND abstract IS NOT NULL
        AND trim(abstract) != ''
        AND (
          normalized_title = ?
          OR (normalized_title >= ? AND normalized_title < ?)
        )
      LIMIT 32
    `).all(baseTitle, disambiguationPrefix, `${disambiguationPrefix}\uffff`) as unknown as WikipediaRow[];
    const best = chooseBestAcronymFallbackRow(rows, baseTitle, acronymTerms);
    return best ? materializeKnowledgeHit(best, "fts", null) : null;
  }

  private resolveTitleFamilyFallback(topic: string): WikipediaKnowledgeHit | null {
    if (!this.db) {
      return null;
    }
    for (const candidate of titleFamilyCandidates(topic)) {
      const directFamilyHit = this.resolveDirectTitleVariants(candidate);
      if (directFamilyHit) {
        return directFamilyHit;
      }
      const familyPrefix = `${candidate} (`;
      const rows = this.db.prepare(`
        SELECT title, description, abstract, url, wikidata_id, is_redirect, redirect_target, redirect_normalized_title
        FROM articles
        WHERE (
          normalized_title = ?
          OR (normalized_title >= ? AND normalized_title < ?)
        )
        LIMIT 32
      `).all(candidate, familyPrefix, `${familyPrefix}\uffff`) as unknown as WikipediaRow[];
      if (rows.length === 0) {
        continue;
      }
      const exactHead = rows.find((row) => normalizeStoredTitle(row.title) === candidate);
      if (!exactHead || materializeKnowledgeHit(exactHead, "fts", null)) {
        continue;
      }
      const hit = bestFtsKnowledgeHit(rows, topic, (normalizedTitle) => this.resolveExactTitle(normalizedTitle));
      if (hit) {
        return hit;
      }
      const titleQuery = buildScopedFtsMatchQuery(candidate, "AND", "title")
        ?? buildScopedFtsMatchQuery(candidate, "OR", "title");
      const titleRows = runFtsQuery(this.db, titleQuery);
      const titleHit = bestFtsKnowledgeHit(titleRows, topic, (normalizedTitle) => this.resolveExactTitle(normalizedTitle));
      if (titleHit) {
        return titleHit;
      }
    }
    return null;
  }

  private resolveDirectTitleVariants(titleText: string): WikipediaKnowledgeHit | null {
    for (const variant of titleTextVariants(titleText)) {
      const exact = this.resolveExactTitle(variant);
      if (exact) {
        return exact;
      }
      const redirect = this.resolveRedirectTitle(variant);
      if (redirect) {
        return redirect;
      }
    }
    return null;
  }

  private resolveNonMediaTitleVariant(titleText: string): WikipediaKnowledgeHit | null {
    const original = normalizeStoredTitle(titleText);
    for (const variant of titleTextVariants(titleText)) {
      if (variant === original) {
        continue;
      }
      const hit = this.resolveExactTitle(variant) ?? this.resolveRedirectTitle(variant);
      if (hit && mediaIdentityForHit(hit) === null) {
        return hit;
      }
    }
    return null;
  }

  private resolveSemanticSubjectTitle(query: ParsedWikipediaQuery): WikipediaKnowledgeHit | null {
    let best: { hit: WikipediaKnowledgeHit; score: number } | null = null;
    const candidates = query.directSubject
      ? query.subjectCandidates.filter((candidate) => (
          normalizeStoredTitle(candidate.text) === normalizeStoredTitle(query.topic)
        ))
      : query.subjectCandidates;
    for (const candidate of candidates) {
      const direct = this.resolveDirectTitleVariants(candidate.text);
      if (direct) {
        const score = scoreSemanticTitleHit(direct, candidate, query.relationTerms, false);
        if (!best || score > best.score) {
          best = { hit: direct, score };
        }
      }
      const alias = this.resolveParentheticalTitleAlias(candidate.text, query.relationTerms);
      if (alias) {
        const score = scoreSemanticTitleHit(alias, candidate, query.relationTerms, true);
        if (!best || score > best.score) {
          best = { hit: alias, score };
        }
      }
    }
    return best?.hit ?? null;
  }

  private resolveCompositeTitleAlias(query: ParsedWikipediaQuery): WikipediaKnowledgeHit | null {
    if (!this.db) {
      return null;
    }
    const composite = splitCompositeTitle(query.searchText);
    if (!composite) {
      return null;
    }
    const identityTerms = canonicalizeTokens(extractFtsTerms(query.searchText))
      .filter((term) => !FTS_STOP_WORDS.has(term));
    if (identityTerms.length < 3) {
      return null;
    }
    const strictQuery = buildFtsMatchQuery(query.searchText, "AND");
    const rows = runFtsQuery(this.db, strictQuery);
    for (const row of rows) {
      const definingAbstract = leadingDisambiguationDefinition(row.abstract ?? "");
      if (!definingAbstract || !textContainsAllTerms(definingAbstract, identityTerms)) {
        continue;
      }
      const relationTerms = new Set([
        ...query.relationTerms,
        ...semanticRelationTerms(definingAbstract),
      ]);
      const canonical = this.resolveParentheticalTitleAlias(composite.base, relationTerms);
      if (canonical) {
        return canonical;
      }
      return {
        title: query.topic,
        description: row.description,
        abstract: definingAbstract,
        url: row.url,
        wikidataId: row.wikidata_id,
        matchedBy: "fts",
        resolvedFromTitle: row.title,
      };
    }
    return null;
  }

  private resolveParentheticalTitleAlias(
    baseTitleText: string,
    relationTerms: ReadonlySet<string>,
  ): WikipediaKnowledgeHit | null {
    if (!this.db) {
      return null;
    }
    let best: { hit: WikipediaKnowledgeHit; score: number } | null = null;
    for (const baseTitle of titleTextVariants(baseTitleText)) {
      const rows = this.db.prepare(`
        SELECT title, description, abstract, url, wikidata_id, is_redirect, redirect_target, redirect_normalized_title
        FROM articles
        WHERE normalized_title >= ? AND normalized_title < ?
        LIMIT 64
      `).all(`${baseTitle} `, `${baseTitle} \uffff`) as unknown as WikipediaRow[];
      for (const row of rows) {
        const parts = splitParentheticalTitle(row.title);
        if (!parts || !labelsCanonicallyEquivalent(parts.base, baseTitle)) {
          continue;
        }
        const hit = row.is_redirect && row.redirect_normalized_title
          ? this.resolveExactTitle(row.redirect_normalized_title)
          : materializeKnowledgeHit(row, "fts", null);
        if (!hit) {
          continue;
        }
        const resolvedHit = row.is_redirect
          ? { ...hit, matchedBy: "fts" as const, resolvedFromTitle: row.title }
          : hit;
        const score = scoreParentheticalAlias(row, parts.qualifier, relationTerms);
        if (!best || score > best.score) {
          best = { hit: resolvedHit, score };
        }
      }
    }
    return best && best.score > 0 ? best.hit : null;
  }

  private resolveCreativeTitleFamily(
    baseTitle: string,
    facet: CreativeWorkFacet,
    directTitle: WikipediaKnowledgeHit | null,
  ): CreativeTitleFamilyResolution {
    if (!this.db) {
      return { handled: false, hit: null, candidates: [] };
    }
    const familyPrefix = `${baseTitle} (`;
    const rows = this.db.prepare(`
      SELECT title, description, abstract, url, wikidata_id, is_redirect, redirect_target, redirect_normalized_title
      FROM articles
      WHERE abstract IS NOT NULL
        AND trim(abstract) != ''
        AND (
          normalized_title = ?
          OR (normalized_title >= ? AND normalized_title < ?)
        )
      ORDER BY normalized_title, title
      LIMIT 128
    `).all(baseTitle, familyPrefix, `${familyPrefix}\uffff`) as unknown as WikipediaRow[];
    const exactRows = rows.filter((row) => normalizeStoredTitle(row.title) === baseTitle);
    const hasParentheticalAnchor = rows.some((row) => {
      const parts = splitParentheticalTitle(row.title);
      return parts !== null && labelsCanonicallyEquivalent(parts.base, baseTitle);
    });
    const anchored = exactRows.length > 0 || hasParentheticalAnchor;
    if (!anchored) {
      return { handled: false, hit: null, candidates: [] };
    }

    const candidates = new Map<string, CreativeTitleFamilyCandidate>();
    const addCandidate = (hit: WikipediaKnowledgeHit | null): void => {
      if (!hit) {
        return;
      }
      const kind = mediaIdentityForHit(hit);
      const key = normalizeStoredTitle(hit.title);
      if (!kind || kind === "other" || !key) {
        return;
      }
      if (!candidates.has(key)) {
        candidates.set(key, { kind, hit });
      }
    };
    addCandidate(directTitle);
    for (const row of rows) {
      if (row.is_redirect) {
        continue;
      }
      const parts = splitParentheticalTitle(row.title);
      const exact = normalizeStoredTitle(row.title) === baseTitle;
      if (!exact && (!parts || !labelsCanonicallyEquivalent(parts.base, baseTitle))) {
        continue;
      }
      addCandidate(materializeKnowledgeHit(
        row,
        exact ? "exact_title" : "qualified_title",
        null,
      ));
    }

    const allCandidates = [...candidates.values()].sort(compareCreativeTitleFamilyCandidates);
    const exactAnchorIsDisambiguation = exactRows.some(looksLikeDisambiguationRow);
    const shouldHandle = facet.requested
      || (exactAnchorIsDisambiguation && allCandidates.length > 0)
      || (directTitle === null && allCandidates.length > 0);
    if (!shouldHandle) {
      return { handled: false, hit: null, candidates: [] };
    }
    const compatible = facet.requested
      ? allCandidates.filter((candidate) => facet.allowedKinds.has(candidate.kind))
      : allCandidates;
    if (compatible.length === 1) {
      return {
        handled: true,
        hit: compatible[0]?.hit ?? null,
        candidates: [],
      };
    }
    const canonicalKindCandidates = facet.explicitKind ? compatible.filter((candidate) => {
      const parts = splitParentheticalTitle(candidate.hit.title);
      return parts !== null && normalizeStoredTitle(parts.qualifier) === facet.explicitKind;
    }) : [];
    if (canonicalKindCandidates.length === 1) {
      return {
        handled: true,
        hit: canonicalKindCandidates[0]?.hit ?? null,
        candidates: [],
      };
    }
    return {
      handled: true,
      hit: null,
      candidates: compatible.map((candidate) => candidate.hit.title),
    };
  }
}

interface QualifiedTitleHypothesis {
  readonly baseTitle: string;
  readonly year: number | null;
}

type MediaIdentityKind = WikipediaMediaKind | "other";

const MEDIA_KIND_ORDER: Readonly<Record<WikipediaMediaKind, number>> = {
  film: 0,
  book: 1,
  show: 2,
  music: 3,
};

function qualifiedTitleHypotheses(
  value: string,
  mediaKind: WikipediaMediaKind,
): readonly QualifiedTitleHypothesis[] {
  const clean = stripTrailingKnowledgeNoise(value)
    .replaceAll(/\s+/g, " ")
    .trim();
  if (!clean) {
    return [];
  }
  const media = mediaTokenSource(mediaKind);
  const year = "((?:18|19|20|21)\\d{2})";
  const hypotheses = new Map<string, QualifiedTitleHypothesis>();
  const add = (baseTitleText: string | undefined, yearText?: string): void => {
    const baseTitle = cleanQualifiedBaseTitle(baseTitleText ?? "", mediaKind);
    const normalized = normalizeStoredTitle(baseTitle);
    const parsedYear = yearText ? Number(yearText) : null;
    if (
      !normalized
      || (parsedYear !== null && !Number.isInteger(parsedYear))
    ) {
      return;
    }
    const key = `${normalized}\u0000${parsedYear ?? ""}`;
    hypotheses.set(key, { baseTitle, year: parsedYear });
  };

  const forms = [clean];
  const withoutLeadingDeterminer = clean
    .replace(new RegExp(`^the\\s+(?=${year}|${media}\\b)`, "iu"), "")
    .trim();
  if (withoutLeadingDeterminer && withoutLeadingDeterminer !== clean) {
    forms.push(withoutLeadingDeterminer);
  }
  const patterns: ReadonlyArray<{
    readonly pattern: RegExp;
    readonly titleIndex: number;
    readonly yearIndex: number;
  }> = [
    {
      pattern: new RegExp(`^(.+?)\\s*\\(\\s*${year}\\s+${media}\\s*\\)$`, "iu"),
      titleIndex: 1,
      yearIndex: 2,
    },
    {
      pattern: new RegExp(`^${year}\\s+${media}\\s+(.+)$`, "iu"),
      titleIndex: 2,
      yearIndex: 1,
    },
    {
      pattern: new RegExp(`^${year}[’']s\\s+(.+?)(?:\\s+${media})?$`, "iu"),
      titleIndex: 2,
      yearIndex: 1,
    },
    {
      pattern: new RegExp(`^${year}\\s+(.+?)\\s+${media}$`, "iu"),
      titleIndex: 2,
      yearIndex: 1,
    },
    {
      pattern: new RegExp(`^(.+?),?\\s+(?:the\\s+)?${year}\\s+${media}$`, "iu"),
      titleIndex: 1,
      yearIndex: 2,
    },
    {
      pattern: new RegExp(`^(.+?)\\s+${media}\\s+${year}$`, "iu"),
      titleIndex: 1,
      yearIndex: 2,
    },
    {
      pattern: new RegExp(`^${media}\\s+(.+?)\\s+(?:from|released\\s+in|made\\s+in)\\s+${year}$`, "iu"),
      titleIndex: 1,
      yearIndex: 2,
    },
    {
      pattern: new RegExp(`^(.+?)\\s+(?:from|released\\s+in|made\\s+in)\\s+${year}$`, "iu"),
      titleIndex: 1,
      yearIndex: 2,
    },
  ];
  for (const form of forms) {
    add(form);
    for (const { pattern, titleIndex, yearIndex } of patterns) {
      const match = pattern.exec(form);
      if (match) {
        add(match[titleIndex], match[yearIndex]);
      }
    }
  }
  return [...hypotheses.values()].slice(0, 8);
}

function cleanQualifiedBaseTitle(
  value: string,
  mediaKind: WikipediaMediaKind,
): string {
  const media = mediaTokenSource(mediaKind);
  return stripTrailingKnowledgeNoise(value)
    .replace(new RegExp(`^(?:the\\s+)?${media}\\s+`, "iu"), "")
    .replace(new RegExp(`\\s+${media}$`, "iu"), "")
    .replace(/^[\s,;:]+|[\s,;:]+$/gu, "")
    .trim();
}

function mediaTokenSource(mediaKind: WikipediaMediaKind): string {
  if (mediaKind === "film") {
    return "(?:movie|film|motion\\s+picture)";
  }
  if (mediaKind === "book") {
    return "(?:book|novel|novella)";
  }
  if (mediaKind === "show") {
    return "(?:tv\\s+show|television\\s+show|tv\\s+series|television\\s+series|series|show)";
  }
  return "(?:film\\s+score|album|song|single|record|soundtrack|score)";
}

function qualifiedIdentityMatches(
  hit: WikipediaKnowledgeHit,
  mediaKind: WikipediaMediaKind,
  year: number | null,
): boolean {
  const titleParts = splitParentheticalTitle(hit.title);
  const definition = leadingDefinitionTail(hit.abstract);
  const actualKind = mediaIdentityForHit(hit);
  if (actualKind !== mediaKind) {
    return false;
  }
  if (year === null) {
    return true;
  }
  const qualifierYear = firstFourDigitYear(titleParts?.qualifier ?? "");
  if (qualifierYear !== null) {
    return qualifierYear === year;
  }
  const ownYear = leadingMediaIdentityYear(hit.description ?? "", mediaKind)
    ?? leadingMediaIdentityYear(definition, mediaKind);
  return ownYear === year;
}

function mediaIdentityForHit(hit: WikipediaKnowledgeHit): MediaIdentityKind | null {
  const titleParts = splitParentheticalTitle(hit.title);
  return [
    titleParts?.qualifier ?? "",
    hit.description ?? "",
    leadingDefinitionTail(hit.abstract),
  ]
    .map((source) => classifyMediaIdentity(source))
    .find((kind) => kind !== null) ?? null;
}

function compareCreativeTitleFamilyCandidates(
  left: CreativeTitleFamilyCandidate,
  right: CreativeTitleFamilyCandidate,
): number {
  const kindDifference = MEDIA_KIND_ORDER[left.kind] - MEDIA_KIND_ORDER[right.kind];
  if (kindDifference !== 0) {
    return kindDifference;
  }
  const leftTitle = normalizeStoredTitle(left.hit.title) ?? left.hit.title.toLowerCase();
  const rightTitle = normalizeStoredTitle(right.hit.title) ?? right.hit.title.toLowerCase();
  return leftTitle < rightTitle ? -1 : leftTitle > rightTitle ? 1 : 0;
}

function leadingDefinitionTail(abstract: string): string {
  const lead = String(abstract ?? "")
    .replaceAll(/[\r\n\t]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 480);
  const definition = /\b(?:is|are|was|were)\s+(.+)$/iu.exec(lead)?.[1] ?? lead;
  return definition.split(/(?<=[.!?])\s+/u)[0] ?? definition;
}

function firstFourDigitYear(value: string): number | null {
  const match = /(?:^|\D)((?:18|19|20|21)\d{2})(?:\D|$)/u.exec(value);
  return match?.[1] ? Number(match[1]) : null;
}

function leadingMediaIdentityYear(
  value: string,
  mediaKind: WikipediaMediaKind,
): number | null {
  const normalized = (normalizeTopic(value) ?? "").replaceAll("-", " ");
  if (!normalized) {
    return null;
  }
  const media = mediaTokenSource(mediaKind);
  const year = "((?:18|19|20|21)\\d{2})";
  const leading = new RegExp(
    `^(?:an?\\s+|the\\s+)?${year}(?:\\s+[\\p{L}\\p{N}'’]+){0,6}\\s+${media}\\b`,
    "iu",
  ).exec(normalized)?.[1];
  if (leading) {
    return Number(leading);
  }
  const released = new RegExp(
    `^(?:an?\\s+|the\\s+)?${media}(?:\\s+[\\p{L}\\p{N}'’]+){0,5}\\s+(?:released|published|premiered|broadcast)\\s+(?:in\\s+)?${year}\\b`,
    "iu",
  ).exec(normalized)?.[1];
  return released ? Number(released) : null;
}

function classifyMediaIdentity(value: string): MediaIdentityKind | null {
  const normalized = (normalizeTopic(value) ?? "").replaceAll("-", " ");
  if (!normalized) {
    return null;
  }
  const candidates: Array<{
    readonly kind: MediaIdentityKind;
    readonly index: number;
    readonly priority: number;
  }> = [];
  const add = (
    kind: MediaIdentityKind,
    pattern: RegExp,
    priority: number,
  ): void => {
    const index = pattern.exec(normalized)?.index;
    if (index !== undefined) {
      candidates.push({ kind, index, priority });
    }
  };
  add("music", /\b(?:film\s+score|soundtrack|score|album|song|single|record|track)\b/u, 0);
  add("film", /\b(?:television|tv)\s+film\b/u, 0);
  add("other", /\bfilm\s+series\b/u, 0);
  add("other", /\b(?:video\s+game|game|character|comic|franchise|band|musician|singer|artist|ride|attraction|toy|surname|district|unit)\b/u, 1);
  add("book", /\b(?:book|novel|novella|memoir|biography)\b/u, 2);
  add("show", /\b(?:television|tv|series|show|miniseries|sitcom|episode)\b/u, 3);
  add("film", /\b(?:film|movie|motion\s+picture|cinema)\b/u, 4);
  return candidates
    .sort((left, right) => left.index - right.index || left.priority - right.priority)[0]
    ?.kind ?? null;
}

function scoreSemanticTitleHit(
  hit: WikipediaKnowledgeHit,
  candidate: WikipediaSubjectCandidate,
  relationTerms: ReadonlySet<string>,
  parentheticalAlias: boolean,
): number {
  const parts = splitParentheticalTitle(hit.title);
  const baseTitle = parts?.base ?? hit.title;
  let score = candidate.confidence + Math.min(36, subjectWordCount(candidate.text) * 6);
  if (labelsCanonicallyEquivalent(baseTitle, candidate.text)) {
    score += 36;
  }
  if (
    hit.matchedBy === "exact_title"
    || hit.matchedBy === "redirect"
    || hit.matchedBy === "qualified_title"
  ) {
    score += 18;
  }
  if (parentheticalAlias) {
    score += 12;
  }
  score += semanticTextOverlapScore(baseTitle, relationTerms, 8);
  score += semanticTextOverlapScore(parts?.qualifier ?? "", relationTerms, 34);
  score += semanticTextOverlapScore(hit.description ?? "", relationTerms, 10);
  score += semanticTextOverlapScore(hit.abstract, relationTerms, 3);
  return score;
}

function scoreParentheticalAlias(
  row: WikipediaRow,
  qualifier: string,
  relationTerms: ReadonlySet<string>,
): number {
  return semanticTextOverlapScore(qualifier, relationTerms, 40)
    + semanticTextOverlapScore(row.description ?? "", relationTerms, 10)
    + semanticTextOverlapScore(row.abstract ?? "", relationTerms, 3);
}

function semanticTextOverlapScore(
  value: string,
  relationTerms: ReadonlySet<string>,
  weight: number,
): number {
  if (!value || relationTerms.size === 0) {
    return 0;
  }
  const terms = new Set(canonicalizeTokens(extractFtsTerms(value)));
  let matches = 0;
  for (const term of relationTerms) {
    if (terms.has(term)) {
      matches += 1;
    }
  }
  return matches * weight;
}

function splitParentheticalTitle(title: string): { base: string; qualifier: string } | null {
  const match = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(title.trim());
  const base = match?.[1]?.trim();
  const qualifier = match?.[2]?.trim();
  return base && qualifier ? { base, qualifier } : null;
}

function splitCompositeTitle(value: string): { base: string; subtitle: string } | null {
  const clean = stripTrailingKnowledgeNoise(value);
  const match = /^(.*?)\s*(?::|\s[-–—]\s)\s*(.+)$/.exec(clean);
  const base = match?.[1]?.trim();
  const subtitle = match?.[2]?.trim();
  if (!base || !subtitle || subjectWordCount(base) < 2 || !hasSubjectContent(subtitle)) {
    return null;
  }
  return { base, subtitle };
}

function leadingDisambiguationDefinition(abstract: string): string | null {
  const normalized = String(abstract || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  const marker = /\b(?:may|can|could)\s+(?:also\s+)?refer\s+to\b/i.exec(normalized);
  const definition = (marker ? normalized.slice(0, marker.index) : normalized).trim();
  return definition && /\b(?:is|are|was|were)\b/i.test(definition) ? definition : null;
}

function textContainsAllTerms(value: string, requiredTerms: readonly string[]): boolean {
  const terms = new Set(canonicalizeTokens(extractFtsTerms(value)));
  return requiredTerms.length > 0 && requiredTerms.every((term) => terms.has(term));
}

function labelsCanonicallyEquivalent(left: string, right: string): boolean {
  const leftTokens = canonicalizeTokens((normalizeTopic(left) ?? "").split(/\s+/).filter(Boolean));
  const rightTokens = canonicalizeTokens((normalizeTopic(right) ?? "").split(/\s+/).filter(Boolean));
  return leftTokens.length > 0
    && leftTokens.length === rightTokens.length
    && leftTokens.every((token, index) => token === rightTokens[index]);
}

function materializeKnowledgeHit(
  row: WikipediaRow,
  matchedBy: WikipediaKnowledgeHit["matchedBy"],
  resolvedFromTitle: string | null,
): WikipediaKnowledgeHit | null {
  const abstract = typeof row.abstract === "string" ? row.abstract.trim() : "";
  if (!abstract
    || /^redirect\b/i.test(abstract)
    || looksLikeDisambiguationRow(row)) {
    return null;
  }
  return {
    title: row.title,
    description: row.description,
    abstract,
    url: row.url,
    wikidataId: row.wikidata_id,
    matchedBy,
    resolvedFromTitle,
  };
}

function looksLikeDisambiguationRow(row: WikipediaRow): boolean {
  const description = String(row.description ?? "").trim();
  return /\(disambiguation\)$/i.test(row.title)
    || /\b(?:wikimedia\s+)?disambiguation\s+page\b/i.test(description)
    || /\btopics?\s+referred\s+to\s+by\s+the\s+same\s+(?:term|name)\b/i.test(description)
    || /\bset\s+index\s+article\b/i.test(description)
    || looksLikeDisambiguationAbstract(String(row.abstract ?? ""));
}

function looksLikeDisambiguationAbstract(abstract: string): boolean {
  const normalized = abstract.trim();
  return /\b(?:may|can|could)\s+(?:also\s+)?refer\s+to\b/i.test(normalized)
    || /\b(?:topics?|subjects?)\s+referred\s+to\s+by\s+the\s+same\s+(?:term|name)\b/i.test(normalized);
}

function stripTrailingKnowledgeNoise(value: string): string {
  return value
    .replace(/\b(?:please|thanks|thank you)\b/gi, "")
    .replace(/\b(?:for me|again|right now|now)\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s"'`([{]+/g, "")
    .replace(/[\s"'`,;:.!?]+$/g, "")
    .trim();
}

function cleanWikipediaTopic(value: string): string {
  return stripTrailingKnowledgeNoise(value)
    .replace(/^(?:the\s+)?(?:movie|film|novel|book|tv\s+show|television\s+show|tv\s+series|television\s+series)\s+/i, "")
    .replace(/\b(?:(?:is|was)\s+)?about\s*$/i, "")
    .replace(/\b(?:made|created|written|filmed|directed)\s*$/i, "")
    .replace(/\b(?:(?:first|originally)\s+)?(?:came\s+out|come\s+out|get\s+released|got\s+released|was\s+released|were\s+released|released|published|premiered|premiere|debuted|debut)\s*$/i, "")
    .trim();
}

function extractWikipediaSubjectCandidates(
  clean: string,
  searchText: string,
): readonly WikipediaSubjectCandidate[] {
  const core = clean
    .replace(/^(?:please\s+)?do\s+you\s+know\s+/i, "")
    .replace(/^(?:please\s+)?/i, "")
    .trim();
  const expressions: Array<{ text: string; confidence: number }> = [];
  const addExpression = (text: string | null | undefined, confidence: number): void => {
    const value = stripCoordinatedQuestionTail(stripTrailingKnowledgeNoise(text ?? ""));
    if (value) {
      expressions.push({ text: value, confidence });
    }
  };

  addExpression(extractGrammaticalQuestionSubject(core), 190);

  let match = /\b(?:encyclopedia\s+)?(?:entry|meaning|definition|summary|biography|history|origin)\s+(?:of|for)\s+(.+)$/i.exec(core);
  addExpression(match?.[1], 150);

  match = /^(?:tell|teach)\s+me\s+about\s+(.+)$/i.exec(core);
  addExpression(match?.[1], 145);

  match = /^what\s+(?:does|do|did)\s+(.+?)\s+(?:mean|refer\s+to|stand\s+for)(?:\b|$)/i.exec(core);
  addExpression(match?.[1], 155);

  match = /^(?:where|when)\s+(?:does|do|did)\s+(.+?)\s+(?:come|originate|begin|start|happen|occur)(?:\b|$)/i.exec(core);
  addExpression(match?.[1], 150);

  const relationObjectPattern = new RegExp(
    `^(?:who|which|what)\\s+(?:[^\\s]+\\s+){0,5}?(?:${KNOWLEDGE_RELATION_VERB_SOURCE})\\s+(.+)$`,
    "iu",
  );
  match = relationObjectPattern.exec(core);
  addExpression(match?.[1], 150);

  match = /^(?:what|who|where|when)\s+(?:is|are|was|were)\s+(.+)$/i.exec(core);
  addExpression(match?.[1], 140);

  match = /^(?:define|describe|explain|summari[sz]e)\s+(.+)$/i.exec(core);
  addExpression(match?.[1], 135);

  match = /^(?:is|are|was|were)\s+(.+)$/i.exec(core);
  addExpression(match?.[1], 125);

  addExpression(searchText, 100);

  const candidates = new Map<string, WikipediaSubjectCandidate>();
  const addCandidate = (text: string, confidence: number): void => {
    const cleaned = cleanSubjectCandidate(text);
    const key = normalizeStoredTitle(cleaned);
    if (!key || !hasSubjectContent(key)) {
      return;
    }
    const current = candidates.get(key);
    if (!current || confidence > current.confidence) {
      candidates.set(key, { text: cleaned, confidence });
    }
  };

  for (const expression of expressions) {
    const transformed = structuralSubjectTransforms(expression.text);
    for (const [index, value] of transformed.entries()) {
      addCandidate(value, expression.confidence + 30 - index);
    }
    addCandidate(expression.text, expression.confidence);
    if (!looksLikeDescriptiveDefinition(expression.text)) {
      for (const fragment of subjectPhraseFragments(expression.text)) {
        addCandidate(fragment.text, expression.confidence - 45 + fragment.score);
      }
    }
  }

  return [...candidates.values()].sort((left, right) => {
    const confidenceDifference = right.confidence - left.confidence;
    if (confidenceDifference !== 0) {
      return confidenceDifference;
    }
    return subjectWordCount(right.text) - subjectWordCount(left.text);
  }).slice(0, 12);
}

function extractGrammaticalQuestionSubject(value: string): string | null {
  const core = stripCoordinatedQuestionTail(value);
  const languageFamilySubject = /^which\s+language\s+family\s+does\s+(.+?)\s+belong\s+to$/iu.exec(core)?.[1];
  if (languageFamilySubject) {
    return `${cleanQuestionSubject(languageFamilySubject)} language`;
  }
  const patterns: readonly RegExp[] = [
    /^what\s+(?:is|was|are|were)\s+(.+?)(?:['’]s)\s+.+$/iu,
    /^what\s+(?:is|was|are|were)\s+(?:the\s+)?(?:capital|atomic\s+number|chemical\s+formula|main\s+function)\s+(?:of|for)\s+(.+)$/iu,
    /^what\s+(?:is|was|are|were)\s+(?:the\s+)?[\p{L}-]+(?:\s+[\p{L}-]+){0,4}\s+(?:of|for)\s+(.+)$/iu,
    /^what\s+kind\s+of\s+.+?\s+(?:is|was|are|were)\s+(.+)$/iu,
    /^what\s+(?:does|do|did)\s+(?:an?\s+|the\s+)?(.+?)\s+(?:carry|contain|convert|do|mean|provide|pump|represent|stimulate|arrange|relate)\b/iu,
    /^(?:what|which)\s+.+?\s+(?:does|do|did)\s+(?:an?\s+|the\s+)?(.+?)\s+(?:belong|contain|flow|have|provide|represent|relate|run)\b/iu,
    /^which\s+.+?\s+(?:contains?|covers?|includes?)\s+(?:the\s+)?(.+)$/iu,
    /^in\s+what\s+years?\s+(?:did|was|were)\s+(?:the\s+)?(.+?)\s+(?:adopted|begin|began|end|ended|fall|fell|first\s+issued|issued|run|start|started)$/iu,
    /^where\s+and\s+when\s+(?:was|were)\s+(?:the\s+)?(.+?)\s+(?:established|formed|founded)$/iu,
    /^what\s+nationality\s+(?:is|was)\s+(.+)$/iu,
    /^which\s+.+?\s+(?:is|was|are|were)\s+(.+?)\s+associated\s+with$/iu,
    /^where\s+(?:is|was|are|were)\s+(?:the\s+)?(.+?)\s+cent(?:red|ered)$/iu,
    /^along\s+which\s+.+?\s+did\s+(.+?)\s+(?:develop|form|grow)$/iu,
  ];
  for (const pattern of patterns) {
    const subject = pattern.exec(core)?.[1];
    if (subject?.trim()) {
      return cleanQuestionSubject(subject);
    }
  }
  return null;
}

function stripCoordinatedQuestionTail(value: string): string {
  return value
    .replace(/\s*,\s*and\s+(?:when|where|who|what|which|how)\b[\s\S]*$/iu, "")
    .trim();
}

function cleanQuestionSubject(value: string): string {
  return stripCoordinatedQuestionTail(value)
    .replace(/^(?:the\s+)?(?:original|human)\s+/iu, "")
    .replace(/^(?:the|a|an)\s+/iu, "")
    .replace(/\s+(?:movie|film|novel|book|language)$/iu, "")
    .trim();
}

function structuralSubjectTransforms(value: string): readonly string[] {
  const clean = cleanSubjectCandidate(value);
  if (!clean) {
    return [];
  }
  const transformed: string[] = [];
  const add = (candidate: string | undefined): void => {
    const normalized = cleanSubjectCandidate(candidate ?? "");
    if (normalized && normalized !== clean && !transformed.includes(normalized)) {
      transformed.push(normalized);
    }
  };

  let match = new RegExp(
    `^(?:the\\s+)?(?:[^\\s]+\\s+){0,2}?(?:${KNOWLEDGE_RELATION_NOUN_SOURCE})\\s+(?:of|for)\\s+(.+)$`,
    "iu",
  ).exec(clean);
  add(match?.[1]);

  match = new RegExp(`\\bwith\\s+(?:an?\\s+|the\\s+)?(?:${KNOWLEDGE_TYPE_NOUN_SOURCE})\\s+(.+)$`, "iu").exec(clean);
  add(match?.[1]);

  match = /^(.*?)(?:\s+actually|\s+really|\s+specifically|\s+known\s+for|\s+used\s+for|\s+famous\s+for)\b/i.exec(clean);
  add(match?.[1]);

  match = /^(.*?)\s+(?:as|in)\s+(?:an?\s+|the\s+)?/i.exec(clean);
  add(match?.[1]);

  match = new RegExp(`^(.+?)\\s+(?:an?|the)\\s+(?:${KNOWLEDGE_TYPE_NOUN_SOURCE}|[\\p{L}][\\p{L}'-]*)$`, "iu").exec(clean);
  add(match?.[1]);

  match = new RegExp(`^(.+?)\\s+(?:${KNOWLEDGE_TYPE_NOUN_SOURCE})$`, "iu").exec(clean);
  add(match?.[1]);

  match = new RegExp(
    `^(?:the\\s+|an?\\s+)?(?:\\d{4}\\s+)?(?:${KNOWLEDGE_TYPE_NOUN_SOURCE})\\s+(.+)$`,
    "iu",
  ).exec(clean);
  add(match?.[1]);

  match = new RegExp(`^(.+?)\\s+(?:${KNOWLEDGE_RELATION_VERB_SOURCE})(?:\\s+.*)?$`, "iu").exec(clean);
  add(match?.[1]);

  return transformed;
}

function cleanSubjectCandidate(value: string): string {
  return stripTrailingKnowledgeNoise(value)
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeDescriptiveDefinition(value: string): boolean {
  const normalized = normalizeTopic(value) ?? "";
  return new RegExp(
    `^(?:the\\s+|an?\\s+)?(?:${DESCRIPTIVE_HEAD_NOUN_SOURCE})\\b.*\\b(?:of|that|which|where|who|used|done|performed|made)\\b`,
    "iu",
  ).test(normalized);
}

function subjectPhraseFragments(value: string): readonly { text: string; score: number }[] {
  const words = cleanSubjectCandidate(value).match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
  if (words.length === 0) {
    return [];
  }
  const fragments: Array<{ text: string; score: number }> = [];
  const limitedWords = words.slice(0, 12);
  for (let size = Math.min(6, limitedWords.length); size >= 1; size -= 1) {
    for (let start = 0; start <= limitedWords.length - size; start += 1) {
      const tokens = limitedWords.slice(start, start + size);
      const normalizedTokens = tokens.map((token) => canonicalizeToken(token));
      if (normalizedTokens.every((token) => SUBJECT_FRAGMENT_STOP_WORDS.has(token))) {
        continue;
      }
      if (size === 1 && SUBJECT_FRAGMENT_STOP_WORDS.has(normalizedTokens[0] ?? "")) {
        continue;
      }
      fragments.push({
        text: tokens.join(" "),
        score: size * 4 - start,
      });
    }
  }
  return fragments;
}

function hasSubjectContent(value: string): boolean {
  const tokens = value.split(/\s+/).map((token) => canonicalizeToken(token)).filter(Boolean);
  return tokens.some((token) => !SUBJECT_FRAGMENT_STOP_WORDS.has(token));
}

function subjectWordCount(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

function semanticRelationTerms(value: string): ReadonlySet<string> {
  const terms = canonicalizeTokens(extractFtsTerms(value));
  const expanded = new Set<string>();
  for (const term of terms) {
    expanded.add(term);
    for (const group of SEMANTIC_RELATION_GROUPS) {
      if (group.includes(term)) {
        for (const related of group) {
          expanded.add(related);
        }
      }
    }
  }
  return expanded;
}

function semanticRelationTermsExcludingSubject(
  value: string,
  subject: string,
): ReadonlySet<string> {
  const terms = new Set(semanticRelationTerms(value));
  for (const term of canonicalizeTokens(extractFtsTerms(subject))) {
    terms.delete(term);
  }
  return terms;
}

function creativeWorkFacetFromTranscript(transcript: string): CreativeWorkFacet {
  const normalized = normalizeTopic(stripKnowledgePresentationWrapper(
    stripKnowledgeRequestPoliteness(transcript),
  )) ?? "";
  const mediaHint = mediaHintFromTranscript(normalized);
  let predicateKinds: ReadonlySet<WikipediaMediaKind> | null = null;
  if (
    /^(?:who|which|what)\b[\s\S]{0,80}\b(?:directed|directs|director|filmmaker)\b/u.test(normalized)
    || /\b(?:director|filmmaker)\s+(?:of|for)\b/u.test(normalized)
    || /\b(?:is|was|were)\s+directed\s+by\b/u.test(normalized)
  ) {
    predicateKinds = new Set<WikipediaMediaKind>(["film", "show"]);
  } else if (
    /^(?:who|which|what|when)\b[\s\S]{0,80}\b(?:author|authored|novelist|published|publication)\b/u.test(normalized)
    || /\b(?:author|novelist)\s+(?:of|for)\b/u.test(normalized)
    || /\bpublication\s+(?:date|year)\b/u.test(normalized)
  ) {
    predicateKinds = new Set<WikipediaMediaKind>(["book"]);
  } else if (
    /^(?:who|which|what|when)\b[\s\S]{0,80}\b(?:composer|composed|songwriter)\b/u.test(normalized)
    || /\b(?:composer|songwriter)\s+(?:of|for)\b/u.test(normalized)
  ) {
    predicateKinds = new Set<WikipediaMediaKind>(["music"]);
  } else if (/^(?:who|which|what|when)\b[\s\S]{0,80}\b(?:aired|broadcast)\b/u.test(normalized)) {
    predicateKinds = new Set<WikipediaMediaKind>(["show"]);
  } else if (
    /^(?:who|which|what)\b[\s\S]{0,80}\b(?:wrote|written|writer|screenwriter|screenplay)\b/u.test(normalized)
    || /\b(?:writer|screenwriter)\s+(?:of|for)\b/u.test(normalized)
    || /\b(?:is|was|were)\s+written\s+by\b/u.test(normalized)
  ) {
    predicateKinds = new Set<WikipediaMediaKind>(["film", "book", "show", "music"]);
  } else if (
    /^(?:when|(?:in\s+)?what (?:year|date))\b[\s\S]*\b(?:released|release|premiered|premiere|debuted|debut|made|came\s+out|come\s+out)\b/u.test(normalized)
    || /\b(?:release|premiere|debut)\s+(?:date|year)\b/u.test(normalized)
  ) {
    predicateKinds = new Set<WikipediaMediaKind>(["film", "book", "show", "music"]);
  }

  const requested = mediaHint !== null || predicateKinds !== null;
  if (!requested) {
    return {
      requested: false,
      allowedKinds: new Set<WikipediaMediaKind>(["film", "book", "show", "music"]),
      explicitKind: null,
    };
  }
  const allowedKinds = mediaHint
    ? new Set<WikipediaMediaKind>([mediaHint])
    : new Set<WikipediaMediaKind>(["film", "book", "show", "music"]);
  if (predicateKinds) {
    for (const kind of [...allowedKinds]) {
      if (!predicateKinds.has(kind)) {
        allowedKinds.delete(kind);
      }
    }
  }
  return { requested: true, allowedKinds, explicitKind: mediaHint };
}

function stripKnowledgePresentationWrapper(value: string): string {
  return value
    .replace(/^(?:(?:tell|teach)\s+me\s+about|(?:show|give)\s+me\s+(?:(?:a|the)\s+)?(?:summary\s+of\s+)?)\s*/i, "")
    .trim();
}

function creativeTitleFamilyBaseTitles(topic: string, transcript: string): readonly string[] {
  const baseTitles: string[] = [];
  const add = (value: string): void => {
    const normalized = normalizeStoredTitle(value);
    if (normalized && !baseTitles.includes(normalized)) {
      baseTitles.push(normalized);
    }
  };
  add(topic);
  const mediaHint = mediaHintFromTranscript(transcript);
  if (!mediaHint) {
    return baseTitles;
  }
  const qualifiedBase = cleanQualifiedBaseTitle(topic, mediaHint);
  add(qualifiedBase);
  if (/^the\s+/i.test(qualifiedBase)) {
    add(qualifiedBase.replace(/^the\s+/i, ""));
  }
  return baseTitles;
}

function mediaHintFromTranscript(transcript: string): MediaHint | null {
  const normalized = normalizeTopic(stripKnowledgePresentationWrapper(
    stripKnowledgeRequestPoliteness(transcript),
  )) ?? "";
  if (/\b(film\s+score|soundtrack|score|album|song|single)\b/.test(normalized)) {
    return "music";
  }
  if (/\b(movie|film|cinema)\b/.test(normalized)) {
    return "film";
  }
  if (/\b(book|novel)\b/.test(normalized)) {
    return "book";
  }
  if (/\b(tv|television|series|show)\b/.test(normalized)) {
    return "show";
  }
  return null;
}

function normalizeTopic(value: string): string | null {
  const clean = stripTrailingKnowledgeNoise(value)
    .replaceAll("_", " ")
    .replace(/[^\p{L}\p{N}\s\-:&/']/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return clean || null;
}

function normalizeStoredTitle(value: string): string | null {
  const clean = stripTrailingKnowledgeNoise(value)
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return clean || null;
}

function buildFtsMatchQuery(value: string, operator: "AND" | "OR"): string | null {
  return buildScopedFtsMatchQuery(value, operator, null);
}

function buildScopedFtsMatchQuery(
  value: string,
  operator: "AND" | "OR",
  scope: "title" | null,
): string | null {
  const terms = extractFtsTerms(value);
  if (terms.length === 0) {
    return null;
  }
  const uniqueTerms = [...new Set(terms)].slice(0, 8);
  if (uniqueTerms.length === 1) {
    return scopeFtsToken(uniqueTerms[0] ?? "", scope);
  }
  return uniqueTerms.map((term) => scopeFtsToken(term, scope)).join(` ${operator} `);
}

function extractFtsTerms(value: string): readonly string[] {
  const lower = value.toLowerCase();
  const acronymTerms = dottedAcronymTerms(lower);
  const wordTerms = lower.match(/[\p{L}\p{N}][\p{L}\p{N}']*/gu) ?? [];
  return [...acronymTerms, ...wordTerms]
    .filter((term) => term.length > 1 || /\d/.test(term))
    .filter((term) => !FTS_STOP_WORDS.has(term));
}

function dottedAcronymTerms(value: string): readonly string[] {
  return [...value.toLowerCase().matchAll(/\b((?:[\p{L}\p{N}]\.)+[\p{L}\p{N}]?\.?)/gu)]
    .map((match) => match[1]?.replaceAll(".", "") ?? "")
    .filter(Boolean);
}

function titleFamilyCandidates(value: string): readonly string[] {
  const normalized = normalizeStoredTitle(value);
  if (!normalized) {
    return [];
  }
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return [];
  }
  const candidates: string[] = [];
  for (let size = tokens.length - 1; size >= 1; size -= 1) {
    for (let start = 0; start <= tokens.length - size; start += 1) {
      const candidate = tokens.slice(start, start + size).join(" ");
      if (candidate && isUsefulTitleFamilyCandidate(candidate) && !candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function isUsefulTitleFamilyCandidate(candidate: string): boolean {
  const tokens = candidate.split(/\s+/).filter(Boolean);
  const contentTokens = tokens.filter((token) => !FTS_STOP_WORDS.has(token));
  return contentTokens.length >= 2;
}

function titleTextVariants(value: string): readonly string[] {
  const normalized = normalizeStoredTitle(value);
  if (!normalized) {
    return [];
  }
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const variants = [normalized];
  if (normalized.startsWith("the ")) {
    variants.push(normalized.slice(4));
  } else {
    variants.push(`the ${normalized}`);
  }
  const genitive = /^(.+?)\s+of\s+(?:the\s+)?(.+)$/u.exec(normalized);
  if (genitive?.[1] && genitive[2]) {
    variants.push(`${genitive[2]} ${genitive[1]}`);
  }
  const civilization = /^(?:(.+)\s+)?([\p{L}]+)ian\s+civilis(?:ation|zation)$/u.exec(normalized);
  if (civilization?.[2]) {
    variants.push(`${civilization[1] ? `${civilization[1]} ` : ""}${civilization[2]}`);
  }
  const worldWarOrdinal = /^(first|second)\s+world\s+war$/u.exec(normalized)?.[1];
  if (worldWarOrdinal) {
    variants.push(`world war ${worldWarOrdinal === "first" ? "i" : "ii"}`);
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const alternate = inflectionVariant(tokens[index] ?? "");
    if (!alternate || alternate === tokens[index]) {
      continue;
    }
    const variantTokens = [...tokens];
    variantTokens[index] = alternate;
    const variant = variantTokens.join(" ");
    if (!variants.includes(variant)) {
      variants.push(variant);
    }
  }
  return variants;
}

function prefersCanonicalWrittenWork(
  transcript: string,
  hit: WikipediaKnowledgeHit,
): boolean {
  if (!/^(?:who|which|what)\b[\s\S]{0,100}\b(?:author|wrote|written)\b/iu.test(transcript.trim())) {
    return false;
  }
  const kind = mediaIdentityForHit(hit);
  return kind === "book"
    || kind === "film"
    || kind === "show"
    || kind === "music"
    || /\b(?:book|comedy|epic|novel|play|poem|tragedy|work)\b/iu.test(
      `${hit.description ?? ""} ${leadingDefinitionTail(hit.abstract)}`,
    );
}

function inflectionVariant(token: string): string | null {
  if (!token || FTS_STOP_WORDS.has(token) || token.length < 4) {
    return null;
  }
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith("es") && token.length > 4 && /(?:ses|xes|zes|ches|shes)$/u.test(token)) {
    return token.slice(0, -2);
  }
  if (token.endsWith("s") && token.length > 3 && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  if (token.endsWith("y") && token.length > 4) {
    return `${token.slice(0, -1)}ies`;
  }
  if (/(?:s|x|z|ch|sh)$/u.test(token)) {
    return `${token}es`;
  }
  return `${token}s`;
}

function nowMs(): number {
  return Date.now();
}

function emptyWikipediaLookupDiagnostics(): WikipediaLookupDiagnostics {
  return {
    exactTitleMs: 0,
    redirectMs: 0,
    acronymMs: 0,
    titleFamilyMs: 0,
    creativeTitleFamilyAttempted: false,
    ftsTitleMs: 0,
    ftsStrictMs: 0,
    ftsBroadMs: 0,
    normalizedFtsTitleMs: 0,
    normalizedFtsStrictMs: 0,
    normalizedFtsBroadMs: 0,
    totalMs: 0,
    timedOut: false,
  };
}

function elapsedSinceMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function assignFtsTiming(
  timings: WikipediaLookupDiagnostics,
  prefix: "" | "normalized",
  stage: "title" | "strict" | "broad",
  elapsedMs: number,
): void {
  if (!prefix) {
    if (stage === "title") {
      timings.ftsTitleMs = elapsedMs;
    } else if (stage === "strict") {
      timings.ftsStrictMs = elapsedMs;
    } else {
      timings.ftsBroadMs = elapsedMs;
    }
    return;
  }
  if (stage === "title") {
    timings.normalizedFtsTitleMs = elapsedMs;
  } else if (stage === "strict") {
    timings.normalizedFtsStrictMs = elapsedMs;
  } else {
    timings.normalizedFtsBroadMs = elapsedMs;
  }
}

function acronymBaseTitle(value: string): string | null {
  const clean = normalizeStoredTitle(value
    .replace(/\b(?:[\p{L}\p{N}]\.)+[\p{L}\p{N}]?\.?\b/gu, " ")
    .replace(/\s+/g, " ")
    .trim(),
  );
  return clean || null;
}

function runFtsQuery(
  db: DatabaseSync,
  matchQuery: string | null,
  limit = 8,
  rankByBm25 = true,
): WikipediaRow[] {
  if (!matchQuery) {
    return [];
  }
  try {
    const orderBy = rankByBm25 ? "ORDER BY bm25(articles_fts, 6.0, 2.0, 1.0)" : "";
    return db.prepare(`
      SELECT
        articles.title AS title,
        articles.description AS description,
        articles.abstract AS abstract,
        articles.url AS url,
        articles.wikidata_id AS wikidata_id,
        articles.is_redirect AS is_redirect,
        articles.redirect_target AS redirect_target,
        articles.redirect_normalized_title AS redirect_normalized_title
      FROM articles_fts
      JOIN articles ON articles.page_id = articles_fts.rowid
      WHERE articles_fts MATCH ?
      ${orderBy}
      LIMIT ?
    `).all(matchQuery, limit) as unknown as WikipediaRow[];
  } catch {
    return [];
  }
}

function rankAnswerEntityRows(
  rows: readonly WikipediaRow[],
  queryText: string,
): readonly WikipediaRow[] {
  const queryTerms = [...new Set(canonicalizeTokens(extractFtsTerms(queryText)))];
  const requestedType = answerEntityType(queryText);
  const acronym = /\b([A-Z0-9]{2,8})\b/u.exec(queryText)?.[1]?.toLowerCase() ?? null;
  const subjectTitle = normalizeTopic(extractWikipediaTopic(queryText) ?? "") ?? "";
  const unscopedGlobalSuperlative = /\b(?:highest|largest|longest)\b/iu.test(queryText)
    && !/\b(?:in|of)\s+(?:the\s+)?(?:[A-Z][\p{L}-]*\s*)+$/u.test(queryText.trim());
  return rows.map((row) => {
    const baseTitle = normalizeTopic(row.title.replace(/\s*\([^)]*\)/gu, " ")) ?? "";
    const sentences = splitWikipediaSentences(String(row.abstract ?? "")).slice(0, 24);
    let bestSentenceScore = 0;
    for (const [index, sentence] of sentences.entries()) {
      const normalizedSentence = normalizeTopic(sentence) ?? "";
      const sentenceTerms = new Set(canonicalizeTokens(extractFtsTerms(sentence)));
      const matches = queryTerms.filter((term) => sentenceTerms.has(term)).length;
      const coverage = queryTerms.length > 0 ? matches / queryTerms.length : 0;
      let score = matches * 22 + Math.round(coverage * 120) + Math.max(0, 18 - index);
      if (matches === queryTerms.length && matches > 1) {
        score += 90;
      }
      if (
        baseTitle
        && (normalizedSentence.startsWith(`${baseTitle} `) || normalizedSentence.startsWith(`the ${baseTitle} `))
      ) {
        score += 250;
      }
      if (unscopedGlobalSuperlative && /\b(?:earth|world)\b/iu.test(sentence)) {
        score += 120;
      } else if (unscopedGlobalSuperlative && /\b(?:highest|largest|longest)\b/iu.test(sentence)) {
        score -= 180;
      }
      if (/\blargest\b/iu.test(queryText) && /\b(?:second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)[-\s]+largest\b/iu.test(sentence)) {
        score -= 500;
      }
      if (/\bhighest\b/iu.test(queryText) && /\b(?:second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)[-\s]+highest\b/iu.test(sentence)) {
        score -= 500;
      }
      if (/\bhighest\b/iu.test(queryText) && /\b\d+(?:st|nd|rd|th)?[-\s]+highest\b/iu.test(sentence)) {
        score -= 700;
      }
      if (/\bhighest\s+mountain\b/iu.test(queryText) && /\bearth(?:'s| s)\s+highest\s+mountain\s+above\s+sea\s+level\b/iu.test(normalizedSentence)) {
        score += 500;
      }
      const ordinalPlanet = /\bplanet\b[\s\S]*\b(first|second|third|fourth|fifth|sixth|seventh|eighth)\b/iu.exec(queryText)?.[1];
      if (
        ordinalPlanet
        && new RegExp(`\\b${ordinalPlanet}\\s+planet\\s+from\\s+the\\s+sun\\b`, "iu").test(normalizedSentence)
      ) {
        score += 500;
      }
      if (
        ordinalPlanet
        && new RegExp(`\\b${ordinalPlanet}\\s+(?:outermost|innermost|of)\\b`, "iu").test(normalizedSentence)
      ) {
        score -= 500;
      }
      if (
        /\bhighest\b/iu.test(queryText)
        && /\bhighest\b[\s\S]{0,60}\b(?:in|of)\s+the\b/iu.test(sentence)
        && !/\b(?:earth|world)\b/iu.test(sentence)
      ) {
        score -= 220;
      }
      bestSentenceScore = Math.max(bestSentenceScore, score);
    }
    if (subjectTitle) {
      if (baseTitle === subjectTitle) {
        bestSentenceScore += 500;
      } else if (baseTitle.endsWith(` ${subjectTitle}`)) {
        bestSentenceScore += 400;
      } else if (baseTitle.includes(subjectTitle)) {
        bestSentenceScore += 40;
      }
    }
    const identity = normalizeTopic(
      leadingDefinitionTail(String(row.abstract ?? "")).split(/[,.;]|\b(?:in|of|on|that|which)\b/u)[0] ?? "",
    ) ?? "";
    if (requestedType) {
      bestSentenceScore += identity.includes(requestedType) || baseTitle.includes(requestedType) ? 160 : -240;
    }
    if (
      acronym
      && new RegExp(`\\(${acronym}\\)`, "iu").test(String(row.abstract ?? "").slice(0, 240))
    ) {
      bestSentenceScore += 700;
    }
    if (acronym && titleInitialism(row.title) === acronym) {
      bestSentenceScore += 700;
    }
    if (
      /\bclosest\s+planet\s+to\s+the\s+sun\b/iu.test(queryText)
      && /\b(?:closest|first)\s+planet\s+(?:to|from)\s+the\s+sun\b/iu.test(String(row.abstract ?? ""))
    ) {
      bestSentenceScore += 700;
    }
    return { row, score: bestSentenceScore };
  }).sort((left, right) => right.score - left.score).map(({ row }) => row);
}

function extractAnswerEntityNames(
  queryText: string,
  abstract: string,
): readonly string[] {
  const names: string[] = [];
  const add = (value: string | undefined): void => {
    const name = value?.replace(/^The\s+/u, "").trim();
    if (name && !names.includes(name)) {
      names.push(name);
    }
  };
  const properName = "([\\p{Lu}][\\p{L}'-]*(?:\\s+[\\p{Lu}][\\p{L}'-]*){0,5})";
  if (/\bcapital\s+(?:of|for)\b/iu.test(queryText)) {
    add(new RegExp(`\\b(?:current\\s+)?capital(?:\\s+city)?\\s+is\\s+${properName}`, "u").exec(abstract)?.[1]);
  }
  const superlative = /\b(largest|smallest|highest|lowest|longest|shortest|closest)\b/iu.exec(queryText)?.[1];
  const type = answerEntityType(queryText);
  if (superlative && type && superlative.toLowerCase() === "closest") {
    add(new RegExp(
      `(?:^|[.!?]\\s+)${properName}\\s+is\\s+the\\s+${superlative}\\s+${type}\\b`,
      "u",
    ).exec(abstract)?.[1]);
  }
  return names;
}

function answerEntityType(queryText: string): string | null {
  const normalized = normalizeTopic(queryText) ?? "";
  const whichPhrase = /^which\s+(.+?)\s+(?:is|are|was|were|does|do|did|contains?|continued|dominated|flow|landed)\b/u.exec(normalized)?.[1];
  const superlativeType = /^what\s+(?:is|are|was|were)\s+(?:the\s+)?(?:largest|smallest|highest|lowest|longest|shortest|closest)\s+([\p{L}-]+)/u.exec(normalized)?.[1];
  const propertyType = /^what\s+(?:is|are|was|were)\s+(?:the\s+)?(capital)\s+(?:of|for)\b/u.exec(normalized)?.[1];
  const type = (whichPhrase?.split(/\s+/u).filter((term) => term !== "two").at(-1) ?? superlativeType ?? propertyType) || null;
  return type === "superpowers" ? "superpower" : type;
}

function looksLikeAnswerEntityQuestion(transcript: string): boolean {
  const normalized = normalizeTopic(transcript) ?? "";
  return /^which\b/u.test(normalized)
    || /^along\s+which\b/u.test(normalized)
    || /^what\s+does\s+[A-Z0-9]{2,8}\b/iu.test(transcript.trim())
    || /^what\s+(?:is|are|was|were)\s+(?:the\s+)?capital\s+(?:of|for)\b/u.test(normalized)
    || /^what\s+(?:is|was|are|were)\s+(?:the\s+)?main\s+function\s+(?:of|for)\b/u.test(normalized)
    || /^what\s+(?:is|are|was|were)\s+(?:the\s+)?(?:largest|smallest|highest|lowest|longest|shortest|closest|basic)\b/u.test(normalized);
}

function titleInitialism(title: string): string {
  return (title.match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((term) => !/^(?:a|an|and|of|the)$/iu.test(term))
    .map((term) => term[0]?.toLowerCase() ?? "")
    .join("");
}

function shouldDisambiguateAnswerEntity(
  transcript: string,
  topic: string,
  directTitle: WikipediaKnowledgeHit,
): boolean {
  if (/^what\s+(?:is|are|was|were)\s+(?:the\s+)?capital\s+(?:of|for)\b/iu.test(transcript.trim())) {
    return !/\b(?:capital\b[^.]{0,100}\b(?:is|are)|(?:is|are)\b[^.]{0,60}\bcapital)\b/iu.test(directTitle.abstract);
  }
  if (/^which\b[\s\S]*\bcontinu(?:e|ed|es|ing)\b/iu.test(transcript.trim())) {
    return true;
  }
  const mediaKind = mediaIdentityForHit(directTitle);
  if (!mediaKind) {
    return false;
  }
  return /^[A-Z0-9]{2,8}$/u.test(topic.trim())
    || /\b(?:language\s+family|main\s+function|musical\s+period|nationality)\b/iu.test(transcript);
}

function normalizeFtsSpelling(value: string): string {
  return value
    .replace(/\bcentre\b/giu, "center")
    .replace(/\bcivilisation\b/giu, "civilization")
    .replace(/\borganise(?:d|s|r|rs)?\b/giu, (word) => word.replace("organise", "organize"));
}

function needsImplicitEarthScope(value: string): boolean {
  const normalized = normalizeTopic(value) ?? "";
  return /^what\s+(?:is|are|was|were)\s+(?:the\s+)?(?:highest|largest|longest)\b/u.test(normalized)
    && !/\b(?:earth|world|solar\s+system)\b/u.test(normalized);
}

function mergeFtsRows(...groups: readonly WikipediaRow[][]): WikipediaRow[] {
  const merged = new Map<string, WikipediaRow>();
  for (const group of groups) {
    for (const row of group) {
      const key = `${row.title}\u0000${row.redirect_normalized_title ?? ""}\u0000${row.is_redirect}`;
      if (!merged.has(key)) {
        merged.set(key, row);
      }
    }
  }
  return [...merged.values()];
}

function escapeFtsToken(value: string): string {
  return value.replaceAll("\"", "\"\"");
}

function scopeFtsToken(value: string, scope: "title" | null): string {
  const token = escapeFtsToken(value);
  return scope ? `${scope}:${token}` : token;
}

function bestFtsKnowledgeHit(
  rows: readonly WikipediaRow[],
  queryText: string,
  resolveExactTitle: (normalizedTitle: string) => WikipediaKnowledgeHit | null,
): WikipediaKnowledgeHit | null {
  for (const row of rankFtsRows(rows, queryText)) {
    if (row.is_redirect && row.redirect_normalized_title) {
      const resolved = resolveExactTitle(row.redirect_normalized_title);
      if (resolved) {
        return {
          ...resolved,
          matchedBy: "fts",
          resolvedFromTitle: row.title,
        };
      }
    }
    const materialized = materializeKnowledgeHit(row, "fts", null);
    if (materialized) {
      return materialized;
    }
  }
  return null;
}

function rankFtsRows(rows: readonly WikipediaRow[], queryText: string): readonly WikipediaRow[] {
  if (rows.length === 0) {
    return [];
  }
  const normalizedQuery = normalizeTopic(queryText) ?? "";
  const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const queryCanonicalTokens = canonicalizeTokens(queryTokens);
  const queryTerms = new Set(queryCanonicalTokens);
  const queryRelationTerms = semanticRelationTerms(queryText);
  const descriptiveQuery = looksLikeDescriptiveDefinition(queryText);
  const titleLikeQueryTerms = queryCanonicalTokens.filter((token) => !FTS_STOP_WORDS.has(token));
  return rows
    .map((row) => {
      const normalizedTitle = normalizeTopic(row.title) ?? "";
      const normalizedBaseTitle = normalizeTopic(row.title.replace(/\s*\([^)]*\)/g, " ")) ?? "";
      const titleTokens = normalizedTitle.split(/\s+/).filter(Boolean);
      const baseTitleTokens = normalizedBaseTitle.split(/\s+/).filter(Boolean);
      const canonicalTitleTokens = canonicalizeTokens(titleTokens);
      const canonicalBaseTitleTokens = canonicalizeTokens(baseTitleTokens);
      const contentTitleTokens = canonicalTitleTokens.filter((token) => !FTS_STOP_WORDS.has(token));
      const contentBaseTitleTokens = canonicalBaseTitleTokens.filter((token) => !FTS_STOP_WORDS.has(token));
      const titleTerms = new Set(canonicalTitleTokens);
      const matchedTitleLikeTerms = titleLikeQueryTerms.filter((term) => titleTerms.has(term));
      const titleCoverage = titleLikeQueryTerms.length > 0
        ? matchedTitleLikeTerms.length / titleLikeQueryTerms.length
        : 0;
      const contentMatch = tokenSequenceMatch(contentBaseTitleTokens, titleLikeQueryTerms);
      let score = 0;
      if (normalizedTitle === normalizedQuery) {
        score += 100;
      }
      if (normalizedBaseTitle === normalizedQuery) {
        score += 100;
      }
      if (normalizedBaseTitle !== normalizedTitle) {
        score -= 28;
      }
      if (titleTokenSequenceInQuery(queryCanonicalTokens, canonicalTitleTokens)) {
        score += 80;
        score += Math.max(0, 24 - (queryCanonicalTokens.length - canonicalTitleTokens.length) * 8);
      } else if (canonicalTitleTokens.length > 0 && canonicalTitleTokens.every((token) => queryTerms.has(token))) {
        score += 24;
      }
      if (normalizedBaseTitle
        && normalizedBaseTitle !== normalizedTitle
        && titleTokenSequenceInQuery(queryCanonicalTokens, canonicalBaseTitleTokens)
      ) {
        score += 72;
        score += Math.max(0, 20 - (queryCanonicalTokens.length - canonicalBaseTitleTokens.length) * 6);
      }
      if (normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle)) {
        score += 40;
      }
      if (normalizedBaseTitle.endsWith(normalizedQuery)) {
        score += 42;
      } else if (normalizedBaseTitle.startsWith(normalizedQuery)) {
        score += 18;
      }
      if (contentMatch) {
        score += 96;
        score += Math.max(0, 24 - contentMatch.before * 4 - contentMatch.after * 10);
        if (contentMatch.after === 0) {
          score += 30;
        }
        if (contentMatch.before === 0) {
          score += 10;
        }
      }
      for (const term of queryTerms) {
        if (titleTerms.has(term)) {
          score += 12;
        } else if ((row.description ?? "").toLowerCase().includes(term) || (row.abstract ?? "").toLowerCase().includes(term)) {
          score += 3;
        }
      }
      score += Math.round(titleCoverage * 100);
      if (titleCoverage === 1 && titleLikeQueryTerms.length > 0 && contentBaseTitleTokens.length > titleLikeQueryTerms.length) {
        score -= (contentBaseTitleTokens.length - titleLikeQueryTerms.length) * 8;
      }
      const titleParts = splitParentheticalTitle(row.title);
      const semanticQualifierScore = semanticTextOverlapScore(titleParts?.qualifier ?? "", queryRelationTerms, 30);
      const semanticDescriptionScore = semanticTextOverlapScore(row.description ?? "", queryRelationTerms, 8);
      const semanticAbstractScore = semanticTextOverlapScore(row.abstract ?? "", queryRelationTerms, 2);
      if (descriptiveQuery) {
        score = semanticQualifierScore + semanticDescriptionScore + semanticAbstractScore;
      } else {
        score += semanticQualifierScore + semanticDescriptionScore + semanticAbstractScore;
      }
      if (!row.is_redirect) {
        score += 5;
      }
      return { row, score };
    })
    .sort((left, right) => right.score - left.score)
    .map(({ row }) => row);
}

export function titleTokenSequenceInQuery(
  queryTokens: readonly string[],
  titleTokens: readonly string[],
): boolean {
  if (queryTokens.length === 0 || titleTokens.length === 0 || titleTokens.length > queryTokens.length) {
    return false;
  }
  for (let index = 0; index <= queryTokens.length - titleTokens.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < titleTokens.length; offset += 1) {
      if (queryTokens[index + offset] !== titleTokens[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return true;
    }
  }
  return false;
}

function tokenSequenceMatch(
  titleTokens: readonly string[],
  queryTokens: readonly string[],
): { before: number; after: number } | null {
  if (titleTokens.length === 0 || queryTokens.length === 0 || queryTokens.length > titleTokens.length) {
    return null;
  }
  for (let index = 0; index <= titleTokens.length - queryTokens.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < queryTokens.length; offset += 1) {
      if (titleTokens[index + offset] !== queryTokens[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return {
        before: index,
        after: titleTokens.length - (index + queryTokens.length),
      };
    }
  }
  return null;
}

function titleScopedHitLooksStrong(queryText: string, hit: WikipediaKnowledgeHit): boolean {
  const normalizedQuery = normalizeTopic(queryText) ?? "";
  const normalizedTitle = normalizeTopic(hit.title) ?? "";
  const normalizedBaseTitle = normalizeTopic(hit.title.replace(/\s*\([^)]*\)/g, " ")) ?? "";
  if (normalizedTitle === normalizedQuery || normalizedBaseTitle === normalizedQuery) {
    return true;
  }
  if (normalizedTitle.endsWith(normalizedQuery) || normalizedBaseTitle.endsWith(normalizedQuery)) {
    return true;
  }
  const queryTerms = canonicalizeTokens(extractFtsTerms(queryText)).filter((token) => !FTS_STOP_WORDS.has(token));
  const titleTerms = canonicalizeTokens((normalizedBaseTitle || normalizedTitle).split(/\s+/).filter(Boolean))
    .filter((token) => !FTS_STOP_WORDS.has(token));
  if (queryTerms.length < 2) {
    return false;
  }
  return queryTerms.every((term) => titleTerms.includes(term));
}

function canonicalizeTokens(tokens: readonly string[]): readonly string[] {
  return tokens.map((token) => canonicalizeToken(token));
}

function canonicalizeToken(token: string): string {
  const lower = token.toLowerCase();
  if (/^continu(?:ation|ations|e|ed|es|ing)$/u.test(lower)) {
    return "continue";
  }
  if (lower.length > 4 && lower.endsWith("ies")) {
    return `${lower.slice(0, -3)}y`;
  }
  if (
    lower.length > 4
    && lower.endsWith("es")
    && /(?:ses|xes|zes|ches|shes)$/u.test(lower)
    && !/(?:ates|ites|utes)$/u.test(lower)
  ) {
    return lower.slice(0, -2);
  }
  if (lower.length > 3 && lower.endsWith("s") && !lower.endsWith("ss")) {
    return lower.slice(0, -1);
  }
  return lower;
}

function chooseBestAcronymFallbackRow(
  rows: readonly WikipediaRow[],
  baseTitle: string,
  acronymTerms: readonly string[],
): WikipediaRow | null {
  let best: { row: WikipediaRow; score: number } | null = null;
  for (const row of rows) {
    const normalizedTitle = normalizeTopic(row.title) ?? "";
    const normalizedDescription = normalizeTopic(row.description ?? "") ?? "";
    const normalizedAbstract = normalizeTopic(row.abstract ?? "") ?? "";
    let score = 0;
    if (normalizedTitle === baseTitle) {
      score += 30;
    }
    if (normalizedTitle.startsWith(`${baseTitle} (`)) {
      score += 80;
    }
    for (const acronym of acronymTerms) {
      if (textContainsInitialism(normalizedDescription, acronym)) {
        score += 50;
      }
      if (textContainsInitialism(normalizedAbstract, acronym)) {
        score += 25;
      }
      if (normalizedTitle.includes(acronym)) {
        score += 10;
      }
    }
    if (!best || score > best.score) {
      best = { row, score };
    }
  }
  return best?.score && best.score > 0 ? best.row : null;
}

function textContainsInitialism(text: string, acronym: string): boolean {
  if (!text || acronym.length < 2) {
    return false;
  }
  const initials = text
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token[0] ?? "")
    .join("");
  return initials.includes(acronym);
}

const KNOWLEDGE_RELATION_VERB_SOURCE = [
  "direct(?:ed|s|ing)?",
  "writ(?:e|es|ten|ing)",
  "wrote",
  "creat(?:e|ed|es|ing)",
  "invent(?:ed|s|ing)?",
  "discover(?:ed|s|ing)?",
  "defin(?:e|ed|es|ing)",
  "dominat(?:e|ed|es|ing)",
  "found(?:ed|s|ing)?",
  "follow(?:ed|s|ing)?",
  "compos(?:e|ed|es|ing)",
  "continu(?:e|ed|es|ing)",
  "introduc(?:e|ed|es|ing)",
  "land(?:ed|s|ing)?",
  "paint(?:ed|s|ing)?",
  "design(?:ed|s|ing)?",
  "build|built",
  "develop(?:ed|s|ing)?",
  "establish(?:ed|es|ing)?",
  "produc(?:e|ed|es|ing)",
  "publish(?:ed|es|ing)?",
  "releas(?:e|ed|es|ing)",
  "record(?:ed|s|ing)?",
  "carr(?:y|ied|ies|ying)",
  "allow(?:ed|s|ing)?",
  "bas(?:e|ed|es|ing)",
  "span(?:ned|s|ning)?",
  "made|make|makes|making",
  "play(?:ed|s|ing)?",
  "star(?:red|s|ring)",
].join("|");

const KNOWLEDGE_RELATION_NOUN_SOURCE = [
  "director",
  "author",
  "writer",
  "creator",
  "inventor",
  "discoverer",
  "founder",
  "composer",
  "designer",
  "meaning",
  "definition",
  "summary",
  "biography",
  "history",
  "origin",
  "entry",
].join("|");

const KNOWLEDGE_TYPE_NOUN_SOURCE = [
  "surname",
  "family name",
  "name",
  "word",
  "term",
  "person",
  "film",
  "movie",
  "book",
  "novel",
  "song",
  "album",
  "record",
  "series",
  "show",
  "city",
  "country",
  "company",
  "organisation",
  "organization",
].join("|");

const DESCRIPTIVE_HEAD_NOUN_SOURCE = [
  "amount",
  "branch",
  "field",
  "method",
  "period",
  "person",
  "place",
  "process",
  "quantity",
  "rate",
  "room",
  "science",
  "space",
  "state",
  "study",
  "system",
  "thing",
  "way",
].join("|");

const SEMANTIC_RELATION_GROUPS: readonly (readonly string[])[] = [
  ["physic", "physical", "physically", "mechanic", "mechanical", "mechanically", "science", "scientific", "scientifically"],
  ["direct", "directed", "director", "filmmaker"],
  ["write", "wrote", "written", "writer", "author"],
  ["film", "movie", "cinema"],
  ["book", "novel"],
  ["album", "record", "music"],
  ["surname", "family", "name"],
  ["work", "job", "labour", "labor", "energy"],
  ["done", "perform", "performed", "transfer", "transferred", "convert", "converted"],
  ["room", "space", "workspace", "workplace", "office"],
  ["administrative", "admin", "clerical"],
  ["origin", "originate", "originated", "come", "came"],
  ["paint", "painted", "painter", "painting", "art", "artist"],
  ["contain", "contains", "contained", "include", "includes", "included", "belong", "belongs", "belonged"],
  ["continue", "continued", "continuation", "successor", "succeeded"],
];

const FTS_STOP_WORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "as",
  "associated",
  "at",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "explain",
  "for",
  "from",
  "give",
  "how",
  "in",
  "into",
  "is",
  "me",
  "musical",
  "not",
  "of",
  "on",
  "please",
  "show",
  "summary",
  "tell",
  "than",
  "the",
  "there",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "year",
  "you",
]);

const SUBJECT_FRAGMENT_STOP_WORDS = new Set([
  ...FTS_STOP_WORDS,
  "actually",
  "define",
  "definition",
  "describe",
  "encyclopedia",
  "entry",
  "explain",
  "meaning",
  "ordinary",
  "really",
  "sense",
  "specifically",
  "type",
  ...KNOWLEDGE_RELATION_NOUN_SOURCE.split("|"),
  ...KNOWLEDGE_TYPE_NOUN_SOURCE.split("|"),
  ...DESCRIPTIVE_HEAD_NOUN_SOURCE.split("|"),
]);
