import { parseEntityActionIntent } from "./entity-action-intent.js";
import { looksLikeGlobalLightsStatus } from "./house-lights-status-intent.js";
import {
  hasNonAssertiveRoutingFrame,
  looksLikeKnowledgeContentReadRequest,
  normalizeMeasuredRoutingText,
  parseRoutingUtterance,
  routingSemanticsAllowCurrentStatus,
  rewriteTrailingQuestionCopula,
  stripConversationalLeadIns,
  targetTextKey,
  type RoutingSpeechAct,
} from "./routing-text.js";
import {
  COMPARATOR_PATTERN,
  DEVICE_STATUS_PATTERN,
  POWER_READING_WORD,
  QUESTION_LEAD_PATTERN,
  READING_PATTERN,
  STATUS_STATE_PATTERN,
  stripStatusFiller,
  SUBJECT_PRONOUN_PATTERN,
  WEEKDAY_PATTERN,
} from "./lexicon.js";
import {
  extractTimeWindowEnvelopeFromUtterance,
  type ParseTimeWindowOptions,
  type TimeWindow,
} from "./time-window-parser.js";
import { householdRegex } from "./household.js";

export {
  canonicalStatusRequestedState,
  canonicalStatusRequestedStateForEntityIds,
} from "./entity-status-state.js";

// A target whose head is followed by a subject and its own verb holds a
// clause, not a name: "is there something you'd like to work on?" asks about
// The assistant, not a device. A leading pronoun ("are they both off?") is the target.
const TARGET_CLAUSE = new RegExp(String.raw`\S ${SUBJECT_PRONOUN_PATTERN} \S`);
const STATUS_STATE_CAPTURE_PATTERN = `(${STATUS_STATE_PATTERN})`;
const HISTORICAL_ENTITY_STATE_PATTERN = `${STATUS_STATE_PATTERN}|home|away|work|school`;
const HISTORICAL_ENTITY_EVENT_PATTERN = new RegExp(`^did (?:the |my |our |any |all )?.+? (?:turn|switch|go|get|become) (?:${HISTORICAL_ENTITY_STATE_PATTERN})$`);
const RECENT_PERFECT_ENTITY_STATE_PATTERN = new RegExp(`\\b(?:has|have|had)(?: not)?\\b.*\\b(?:just|recently|already) been\\b.*\\b(?:${HISTORICAL_ENTITY_STATE_PATTERN})$`);
const PERFECT_ENTITY_STATE_PATTERN = new RegExp(`\\b(?:has|have|had)(?: not)?\\b.*\\bbeen\\s+(?:not\\s+)?(?:at\\s+)?(?:${HISTORICAL_ENTITY_STATE_PATTERN})\\b`);
const PAST_COPULA_ENTITY_STATE_PATTERN = new RegExp(`\\b(?:was|were)\\b.*\\b(?:${HISTORICAL_ENTITY_STATE_PATTERN})$`);
/** "Was the office light left on?" asks about now, like "has it been left on?". */
const RESULTATIVE_LEFT_STATE_PATTERN = new RegExp(`^(?:was|were) (?:the |my )?.+? left ${STATUS_STATE_PATTERN}$`);
const TIME_QUALIFIED_STATUS_COPULA_PATTERN = new RegExp(
  `\\b(?:is|are|was|were)\\b[^?.!]{0,180}\\b(?:${HISTORICAL_ENTITY_STATE_PATTERN})\\b`,
);
const TIME_QUALIFIED_STATUS_RESULTATIVE_PATTERN = new RegExp(
  `\\b(?:did|has|have|had)\\b[^?.!]{0,180}\\b(?:leave|left|turn|turned|switch|switched|set|go|gone|get|got|become|became|been)\\b[^?.!]{0,120}\\b(?:${HISTORICAL_ENTITY_STATE_PATTERN})\\b`,
);
const TIME_QUALIFIED_STATUS_TEMPORAL_SIGNAL_PATTERN = new RegExp(String.raw`\b(?:today|yesterday|tomorrow|tonight|earlier|previously|historically|ago|morning|afternoon|evening|night|breakfast|lunch|dinner|bedtime|${WEEKDAY_PATTERN}|january|february|march|april|may|june|july|august|september|october|november|december|(?:19|20)\d{2})\b|\b(?:last|next|this|previous|past|rolling)\s+(?:\w+\s+){0,2}(?:seconds?|minutes?|hours?|days?|weeks?|weekends?|months?|years?|morning|afternoon|evening|night)\b|\b\d{1,2}\s+slash\s+\d{1,2}(?:\s+slash\s+\d{2,4})?\b|\bon(?:\s+the)?\s+\d{1,2}(?:st|nd|rd|th)?\b`);
const QUANTIFIED_OF_STATUS_PATTERN = new RegExp(`^(is|are) (all|any) of (?:the |my |our )?(.+?) ${STATUS_STATE_CAPTURE_PATTERN}$`);
const SUBJECT_QUANTIFIED_OF_STATUS_PATTERN = new RegExp(`^(all|any) of (?:the |my |our )?(.+?) (is|are) ${STATUS_STATE_CAPTURE_PATTERN}$`);
const EITHER_ENTITY_STATUS_PATTERN = new RegExp(`^(is|are) either (?:of (?:the |my |our )?)?(.+?) ${STATUS_STATE_CAPTURE_PATTERN}$`);
const SUBJECT_EITHER_ENTITY_STATUS_PATTERN = new RegExp(`^either (?:of (?:the |my |our )?)?(.+?) (is|are) ${STATUS_STATE_CAPTURE_PATTERN}$`);
const NEITHER_ENTITY_STATUS_PATTERN = new RegExp(`^(is|are) neither (?:of (?:the |my |our )?)?(.+?) ${STATUS_STATE_CAPTURE_PATTERN}$`);
const SUBJECT_NEITHER_ENTITY_STATUS_PATTERN = new RegExp(`^neither (?:of (?:the |my |our )?)?(.+?) (is|are) ${STATUS_STATE_CAPTURE_PATTERN}$`);
const NEGATED_EXISTENTIAL_STATUS_PATTERN = new RegExp(`^(is|are) not (?:there )?any (?:of (?:the |my |our )?)?(.+?) ${STATUS_STATE_CAPTURE_PATTERN}$`);
const POSTPOSED_NEGATED_EXISTENTIAL_STATUS_PATTERN = new RegExp(`^(is|are) there not any (.+?) ${STATUS_STATE_CAPTURE_PATTERN}$`);
const NEGATED_UNIVERSAL_STATUS_PATTERN = new RegExp(`^(is|are) not (?:all|every) (?:of (?:the |my |our )?)?(.+?) ${STATUS_STATE_CAPTURE_PATTERN}$`);
const NO_ENTITY_STATUS_PATTERN = new RegExp(`^(is|are) (?:(?:no )|(?:none of (?:the |my |our )?))(.+?) ${STATUS_STATE_CAPTURE_PATTERN}$`);
const SUBJECT_NEGATED_UNIVERSAL_STATUS_PATTERN = new RegExp(`^not (?:all|every) (?:of (?:the |my |our )?)?(.+?) (is|are) ${STATUS_STATE_CAPTURE_PATTERN}$`);
const SUBJECT_NO_ENTITY_STATUS_PATTERN = new RegExp(`^(?:(?:no )|(?:none of (?:the |my |our )?))(.+?) (is|are) ${STATUS_STATE_CAPTURE_PATTERN}$`);
const NEGATED_COPULA_PERSON_LOCATION_PATTERN = /^(is|are) not ((?:the |my |our )?.+?) (?:at )?(home|away|work|school)$/;
const NEGATED_COPULA_STATUS_PATTERN = new RegExp(`^(is|are) not ((?:the |my |our )?.+?) ${STATUS_STATE_CAPTURE_PATTERN}$`);
const FINAL_NEGATED_PERSON_LOCATION_PATTERN = /\bnot (?:at )?(home|away|work|school)$/;
const FINAL_NEGATED_STATUS_PATTERN = new RegExp(`\\bnot ${STATUS_STATE_CAPTURE_PATTERN}$`);

const NUMBER_WORD_TOKEN_PATTERN = "(?:seventeen|eighteen|nineteen|thirteen|fourteen|fifteen|sixteen|seventy|eighty|ninety|eleven|twelve|twenty|thirty|forty|fifty|sixty|thousand|hundred|three|seven|eight|zero|one|two|four|five|six|nine|ten|and|point)\\b";
const DIGIT_NUMBER_PATTERN = "(?:-?\\d{1,3}(?:[ ,]\\d{3})+(?:\\.\\d+)?|-?\\d+(?:\\.\\d+)?)";
const SIGNED_NUMBER_PREFIX_PATTERN = "(?:(?:minus|negative)\\s+)?";
const COMPACT_NUMBER_PATTERN = `(?:${SIGNED_NUMBER_PREFIX_PATTERN}${DIGIT_NUMBER_PATTERN}|${SIGNED_NUMBER_PREFIX_PATTERN}${NUMBER_WORD_TOKEN_PATTERN}(?:[-\\s]+${NUMBER_WORD_TOKEN_PATTERN})*)`;
const NUMERIC_STATUS_COMPARISON_PATTERN = new RegExp(
  `\\b(below|under|less than|colder than|above|over|greater than|warmer than)\\s+(${COMPACT_NUMBER_PATTERN})(?:\\s+([^?]+))?`,
);

const COMPARISON_SUBJECT_PATTERN = new RegExp(String.raw`^(?:is|does) (?:the )?(.+?)(?: read)? ${COMPARATOR_PATTERN}\b`);
const LEADING_COMPARISON_SUBJECT_PATTERN = new RegExp(String.raw`^(.+?) ${COMPARATOR_PATTERN}\b`);

/** The subject of a numeric comparison ("is the office temp above 20" -> "office temp"), or "". */
export function numericComparisonSubject(stripped: string): string {
  return COMPARISON_SUBJECT_PATTERN.exec(stripped)?.[1] ?? LEADING_COMPARISON_SUBJECT_PATTERN.exec(stripped)?.[1] ?? "";
}

export interface NumericStatusComparison {
  readonly operator: "less_than" | "greater_than";
  readonly threshold: number;
  readonly unit: string | null;
}

export interface StandaloneEntityStatusIntent {
  readonly targetText: string;
  readonly requestedState: string | null;
  readonly questionType: "yes_no" | "state_value";
  readonly quantifier: "any" | "all" | "which" | null;
  readonly numericComparison: NumericStatusComparison | null;
  readonly compareGroupUniformity: boolean;
  readonly requestedAttribute: "temperature" | null;
  readonly sourcePreference: "physical_sensor" | null;
  /** Whether an unresolved target is still structurally a Home Assistant entity request. */
  readonly ownsMissingTarget: boolean;
}

export interface TimeQualifiedEntityStatusIntent extends StandaloneEntityStatusIntent {
  readonly timeWindow: TimeWindow;
  readonly temporalInput: string;
}

/** Pure standalone entity-status grammar. It classifies meaning only; resolution is separate. */
export function parseStandaloneEntityStatusIntent(
  input: string,
  options: {
    readonly speechAct?: RoutingSpeechAct;
    readonly allowHistoricalState?: boolean;
  } = {},
): StandaloneEntityStatusIntent | null {
  const routing = parseRoutingUtterance(input);
  const semanticInput = routingSemanticsAllowCurrentStatus(routing.semantics)
    && routing.semantics.embedding === "indirect"
    ? routing.semantics.core
    : input;
  const normalized = stripTerminalStatusFocusAdjunct(
    stripStatusFiller(normalize(semanticInput)),
  );
  if (!normalized
    || hasNonAssertiveRoutingFrame(normalized)
    || looksLikeGlobalLightsStatus(normalized)
    || rejectsAdjacentDomain(
      normalized,
      options.allowHistoricalState ?? false,
    )) {
    return null;
  }
  const semanticStatusText = canonicalizeNegativeStatusPredicate(
    normalizeQuestionLeadIn(normalized)
      .replace(/^(?:at|before|for) (?:bedtime|bed)\s+/, ""),
  );
  if (!semanticStatusText) {
    return null;
  }
  const utterance = parseRoutingUtterance(normalized);
  const speechAct = options.speechAct ?? routing.speechAct;
  if (speechAct === "command"
    && parseEntityActionIntent(utterance.core)
    && !/^(?:check|confirm|verify|tell|show|give|read|report|list|scan)\b/.test(utterance.core)) {
    return null;
  }
  if (speechAct === "query"
    && (/^(?:how|why)\b.*\b(?:turn|switch|set|make|open|close|lock|unlock|start|stop|pause|resume|dock|change)\b/.test(normalized)
      || /^will (?!you\b).+\b(?:open|close|lock|unlock|start|stop)\b/.test(normalized))) {
    return null;
  }
  const lightPredicate = lightPredicateFromStatusText(semanticStatusText);
  const requestedState = lightPredicate?.requestedState
    ?? requestedStateFromStatusText(semanticStatusText);
  const numericComparison = parseNumericStatusComparison(semanticStatusText);
  const quantifier = lightPredicate?.quantifier
    ?? statusQuantifierFromText(semanticStatusText);
  const compareGroupUniformity = /\b(?:same state|all (?:showing|set|switched) the same)\b/.test(semanticStatusText);
  const targetText = lightPredicate?.targetText
    ?? targetTextFromStatusQuestion(semanticStatusText)
    ?? (speechAct === "query" ? bareDeviceStatusTargetText(semanticStatusText) : null);
  if (!targetText || TARGET_CLAUSE.test(targetText)) {
    return null;
  }
  return {
    targetText,
    requestedState,
    questionType: requestedState || numericComparison || compareGroupUniformity ? "yes_no" : "state_value",
    quantifier,
    numericComparison,
    compareGroupUniformity,
    requestedAttribute: requestedAttributeFromStatusText(semanticStatusText),
    sourcePreference: sourcePreferenceFromStatusText(semanticStatusText),
    ownsMissingTarget: hasUnresolvedEntityOwnership(semanticStatusText, targetText),
  };
}

/**
 * Classify a status proposition carrying a deterministic time envelope.
 * This deliberately does not answer it from current state: callers must use
 * historical state data or decline rather than presenting today's state as
 * the answer to a dated question.
 */
export function parseTimeQualifiedEntityStatusIntent(
  input: string,
  options: ParseTimeWindowOptions = {},
): TimeQualifiedEntityStatusIntent | null {
  if (!shouldAttemptTimeQualifiedStatusParse(input, options)) {
    return null;
  }
  const extracted = extractTimeWindowEnvelopeFromUtterance(input, options);
  if (extracted.result.status !== "matched"
    || !extracted.result.window
    || !extracted.residualInput
    || !extracted.temporalInput) {
    return null;
  }
  const now = options.now ?? new Date();
  const windowEndMs = Date.parse(extracted.result.window.end);
  const historicalGrammar = looksLikeHistoricalEntityStateQuery(
    normalize(extracted.residualInput),
  );
  const completedPastWindow = Number.isFinite(windowEndMs)
    && Number.isFinite(now.getTime())
    && windowEndMs <= now.getTime();
  if (!historicalGrammar && !completedPastWindow) {
    return null;
  }
  const status = parseStandaloneEntityStatusIntent(
    extracted.residualInput,
    { allowHistoricalState: true },
  );
  if (!status) {
    return null;
  }
  return {
    ...status,
    timeWindow: extracted.result.window,
    temporalInput: extracted.temporalInput,
  };
}

/** Parse a predicate-only status ellipsis such as `locked?` against sourced context. */
export function parseEntityStatusPredicateFollowUp(input: string): string | null {
  const normalized = stripStatusFiller(normalize(input));
  const match = new RegExp(
    `^(?:still )?(${STATUS_STATE_PATTERN})(?: now| still| up)?$`,
  ).exec(normalized);
  return match?.[1] ?? null;
}

function rejectsAdjacentDomain(
  normalized: string,
  allowHistoricalState: boolean,
): boolean {
  if (/^(?:say|quote|repeat)\b/.test(normalized) || /\bif i (?:say|said)\b/.test(normalized)) return true;
  if (looksLikeKnowledgeContentReadRequest(normalized)) return true;
  if (householdRegex(String.raw`^(?:status|system status|{ASSISTANT} status)$`).test(normalized)
    || householdRegex(String.raw`\b(?:{ASSISTANT}|the assistant|your system|your own status|device actions?|action policy|actions locked)\b`).test(normalized)
    || /^(?:are|is) you\b/.test(normalized)) return true;
  if (/^(?:when|how often)\b/.test(normalized) || /^(?:what year)\b.*\bcome out\b/.test(normalized)) return true;
  if (
    !allowHistoricalState
    && looksLikeHistoricalEntityStateQuery(normalized)
  ) return true;
  if (looksLikeProspectiveEntityStateQuery(normalized)) return true;
  if (/\b(?:weather|forecast|rain chance|wind forecast)\b/.test(normalized)
    && !/\b(?:sensor|state|status|reading)\b/.test(normalized)) return true;
  if (/^(?:how (?:warm|cold|hot)|what does it feel like)\b.*\b(?:out|outside|outdoors)\b/.test(normalized)
    && !/\b(?:sensor|state|status|reading)\b/.test(normalized)) return true;
  if (/\b(?:solar power|grid (?:import|export)|pv output)\b/.test(normalized)
    || /\bpanels?\b.*\b(?:putting out|producing|generating|making)\b/.test(normalized)) return true;
  if (/\b(?:feels like|apparent temperature|heat index|wind chill)\b/.test(normalized)
    && !/\b(?:sensor|state|status|reading)\b/.test(normalized)) return true;
  const measurement = /\b(?:power|watts?|wattage|kilowatts?|kw|kwh|energy|electricity|draw|drawing|usage|consumption|generation|output|average|total)\b/.test(normalized);
  const explicitDeviceStatus = /\b(?:state|status|on|off|open|closed|locked|unlocked|active|inactive|running|reading|showing)\b/.test(normalized);
  const namedPowerFixture = /\bpower (?:switch|outlet|plug|socket)\b/.test(normalized);
  return measurement && !explicitDeviceStatus && !namedPowerFixture;
}

function looksLikeProspectiveEntityStateQuery(normalized: string): boolean {
  return new RegExp(String.raw`\b(?:tomorrow|tonight|later|this (?:afternoon|evening|weekend)|next (?:hour|day|week|weekend|${WEEKDAY_PATTERN}))\b`).test(normalized)
    || /^will (?!you\b)/.test(normalized)
    || /\b(?:expected|forecast|predicted) to\b/.test(normalized);
}

function looksLikeHistoricalEntityStateQuery(normalized: string): boolean {
  if (/\b(?:ever|never|yesterday|last night|earlier|previously|historically|history|ago)\b/.test(normalized)) {
    return true;
  }
  if (HISTORICAL_ENTITY_EVENT_PATTERN.test(normalized)) {
    return true;
  }
  if (RECENT_PERFECT_ENTITY_STATE_PATTERN.test(normalized)) {
    return true;
  }
  if (PERFECT_ENTITY_STATE_PATTERN.test(normalized)) {
    return true;
  }
  return PAST_COPULA_ENTITY_STATE_PATTERN.test(normalized)
    && !RESULTATIVE_LEFT_STATE_PATTERN.test(normalized);
}

/**
 * Keep full calendar-envelope parsing off the ordinary current-status path.
 * A candidate needs both a state proposition and an explicit supported
 * temporal signal; tense and completed-window checks happen after extraction.
 */
function shouldAttemptTimeQualifiedStatusParse(
  input: string,
  options: ParseTimeWindowOptions,
): boolean {
  const normalized = normalize(input);
  if (!normalized) return false;
  const customAnchorSignal = Object.keys(options.householdAnchors ?? {})
    .some((anchor) => normalized.includes(normalize(anchor)));
  if (
    !customAnchorSignal
    && !TIME_QUALIFIED_STATUS_TEMPORAL_SIGNAL_PATTERN.test(normalized)
  ) {
    return false;
  }
  return TIME_QUALIFIED_STATUS_COPULA_PATTERN.test(normalized)
    || TIME_QUALIFIED_STATUS_RESULTATIVE_PATTERN.test(normalized);
}

/**
 * Put negative state questions into the same positive predicate form used by
 * the resolver. Negation scope changes the quantifier: `not any P` is
 * `all not-P`, while `not all P` is `any not-P`.
 */
function canonicalizeNegativeStatusPredicate(value: string): string | null {
  let text = value;

  text = text
    .replace(EITHER_ENTITY_STATUS_PATTERN, "$1 any $2 $3")
    .replace(SUBJECT_EITHER_ENTITY_STATUS_PATTERN, "any $1 $2 $3")
    .replace(NEITHER_ENTITY_STATUS_PATTERN, "$1 all $2 not $3")
    .replace(SUBJECT_NEITHER_ENTITY_STATUS_PATTERN, "all $1 $2 not $3")
    .replace(
      QUANTIFIED_OF_STATUS_PATTERN,
      "$1 $2 $3 $4",
    )
    .replace(
      SUBJECT_QUANTIFIED_OF_STATUS_PATTERN,
      "$1 $2 $3 $4",
    )
    .replace(
      NEGATED_EXISTENTIAL_STATUS_PATTERN,
      "$1 all $2 not $3",
    )
    .replace(
      POSTPOSED_NEGATED_EXISTENTIAL_STATUS_PATTERN,
      "$1 all $2 not $3",
    )
    .replace(
      NEGATED_UNIVERSAL_STATUS_PATTERN,
      "$1 any $2 not $3",
    )
    .replace(
      NO_ENTITY_STATUS_PATTERN,
      "$1 all $2 not $3",
    )
    .replace(
      SUBJECT_NEGATED_UNIVERSAL_STATUS_PATTERN,
      "any $1 $2 not $3",
    )
    .replace(
      SUBJECT_NO_ENTITY_STATUS_PATTERN,
      "all $1 $2 not $3",
    )
    .replace(
      NEGATED_COPULA_PERSON_LOCATION_PATTERN,
      "$1 $2 not $3",
    )
    .replace(
      NEGATED_COPULA_STATUS_PATTERN,
      "$1 $2 not $3",
    );

  const negatedPersonLocation = FINAL_NEGATED_PERSON_LOCATION_PATTERN.exec(text)?.[1] ?? null;
  if (negatedPersonLocation) {
    const opposite = oppositeStatusState(negatedPersonLocation);
    if (!opposite) return null;
    return text.replace(FINAL_NEGATED_PERSON_LOCATION_PATTERN, opposite);
  }
  const negatedState = FINAL_NEGATED_STATUS_PATTERN.exec(text)?.[1] ?? null;
  if (!negatedState) return text;
  const opposite = oppositeStatusState(negatedState);
  if (!opposite) return null;
  return text.replace(FINAL_NEGATED_STATUS_PATTERN, opposite);
}

function oppositeStatusState(value: string): string | null {
  const opposites: Readonly<Record<string, string>> = {
    active: "inactive",
    armed: "disarmed",
    clear: "detected",
    closed: "open",
    connected: "disconnected",
    dark: "on",
    detected: "clear",
    disabled: "enabled",
    disarmed: "armed",
    disconnected: "connected",
    enabled: "disabled",
    home: "away",
    inactive: "active",
    lit: "off",
    locked: "unlocked",
    off: "on",
    on: "off",
    open: "closed",
    out: "on",
    secure: "unlocked",
    shut: "open",
    triggered: "clear",
    unlocked: "locked",
    away: "home",
  };
  return opposites[value] ?? null;
}

function targetTextFromStatusQuestion(normalized: string): string | null {
  const prepared = normalizeQuestionLeadIn(normalized)
    .replace(/^(?:at|before|for) (?:bedtime|bed)\s+/, "")
    .replace(/\s+(?:itself\s+)?not (?:the )?(?:weather service|forecast)$/, "")
    .replace(/\s+/g, " ")
    .trim();
  const alternativeTarget = cleanTargetText(
    new RegExp(`^(?:(?:is|are) )?(?:the |my )?(.+?) ${STATUS_STATE_PATTERN} or (?:not |still )?${STATUS_STATE_PATTERN}$`).exec(prepared)?.[1] ?? "",
  );
  if (alternativeTarget) return alternativeTarget;
  const stripped = prepared
    .replace(new RegExp(`\\s+${STATUS_STATE_PATTERN}\\s+or\\s+${STATUS_STATE_PATTERN}$`), "")
    .replace(/\s+or\s+(?:not|still\s+(?:on|off|open|closed|locked|unlocked|dark|lit|out|shut))$/, "")
    .replace(/\s+/g, " ")
    .trim();

  const personPatterns: readonly RegExp[] = [
    /^am (i) (?:showing (?:as )?)?(?:home|work|school|away)$/,
    /^check (.+?) s location(?: rather than (?:his|her|their) identity)?$/,
    /^what is (.+?) s (?:presence|location) state$/,
    /^(?:is|are|was|were) (.+?) away from home$/,
    /^(?:is|are|was|were) (.+?) (?:showing (?:as )?)?(?:at )?(?:home|work|school|away)$/,
    /^(?:has|have) (.+?) (?:made it|come|got) home(?: yet)?$/,
    /^(?:has|have) (.+?) (?:gone|headed) (?:out|away)(?: yet)?$/,
    /^(.+?) (?:is|are|was|were) (?:at )?(?:home|work|school|away)$/,
    /^(.+?) s at (?:home|work|school)$/,
    /^([a-z0-9._:-]+) (?:home|work|school|away)$/,
    /^(.+?) (?:still )?showing (?:as )?(?:at )?(?:home|work|school|away)$/,
    /^do you show (.+?) as (?:home|work|school|away)$/,
  ];
  const locationPerson = personLocationTarget(stripped);
  if (locationPerson) return locationPerson;
  const locationFacet = locationFacetTarget(stripped);
  if (locationFacet) return locationFacet;
  for (const pattern of personPatterns) {
    const person = cleanTargetText(pattern.exec(stripped)?.[1] ?? "");
    if (person) return person;
  }

  // The house's outside sensor is its outdoor temperature probe, so a reading
  // or comparison of it targets the outside temperature.
  if (/\b(?:sensor outside|outside sensor)\b/.test(stripped)
    && /\b(?:warm|temperature|degrees?|read|show|say|said|report|reported|value|below|under|above|over|colder|warmer)\b/.test(stripped)) {
    return "outside temperature";
  }

  const lightPredicateTarget = lightPredicateFromStatusText(stripped)?.targetText;
  if (lightPredicateTarget) return lightPredicateTarget;

  const reportedReadingTarget = cleanTargetText(
    /^what (?:did|does) (?:the )?(.+?) (?:say|report|read|show)(?: again)?$/.exec(stripped)?.[1] ?? "",
  );
  if (reportedReadingTarget) return reportedReadingTarget;

  const comparisonTarget = parseNumericStatusComparison(stripped)
    ? cleanTargetText(numericComparisonSubject(stripped))
    : null;
  if (comparisonTarget) return comparisonTarget;

  const uniformTarget = cleanTargetText(
    /^(?:are|is) (?:all )?(?:the )?(.+?) (?:in|showing|set to) (?:the )?same state$/.exec(stripped)?.[1] ?? "",
  );
  if (uniformTarget) return uniformTarget;

  const possessiveLeaveMatch = /^did (i|we|you|they|[a-z]+) leave (?:his|her|their|the|my|our)?\s*(.+?) (?:on|off|open|closed|locked|unlocked|lit|dark|out)$/.exec(stripped)
    ?? /^(?:have|has) (i|we|you|they|[a-z]+) left (?:his|her|their|the|my|our)?\s*(.+?) (?:on|off|open|closed|locked|unlocked|lit|dark|out)$/.exec(stripped);
  const possessiveLeaveTarget = cleanTargetText(possessiveLeaveMatch?.[2] ?? "");
  if (possessiveLeaveTarget) {
    const owner = possessiveLeaveMatch?.[1] ?? "";
    if (/^(?:i|we|somebody|someone|anybody|anyone)$/.test(owner)) return possessiveLeaveTarget;
    return `${owner} s ${possessiveLeaveTarget}`;
  }

  const explicitPatterns: readonly RegExp[] = [
    new RegExp(`^(?:can you )?(?:confirm|verify)(?: whether| if)? (?:the |my )?(.+?) (?:is|are) ${STATUS_STATE_PATTERN}$`),
    new RegExp(`^did (?:i|we|you|[a-z]+) (?:leave|get|turn|switch) (?:the |my )?(.+?)(?: (?:get|leave|turn|switch))? ${STATUS_STATE_PATTERN}$`),
    new RegExp(`^did (?:the )?(.+?) (?:get )?(?:switched|turned|left|set) ${STATUS_STATE_PATTERN}$`),
  ];
  for (const pattern of explicitPatterns) {
    const target = cleanTargetText(pattern.exec(stripped)?.[1] ?? "");
    if (target) return target;
  }

  // A reading in a place reads as "<place> <reading>", the same target as
  // "lounge room temperature"; "inside"/"indoors" alone name the house.
  const placeReading = /^what is (?:the )?(?:current )?(temperature|temp|humidity) (?:in|inside|within) (?:the )?(.+)$/.exec(stripped)
    ?? /^what is (?:the )?(?:current )?(temperature|temp|humidity) (inside|indoors)$/.exec(stripped);
  const warmthPlace = /^how (?:warm|cold|hot) is it (?:in|inside) (?:the )?(.+)$/.exec(stripped)?.[1]
    ?? /^how (?:warm|cold|hot) is it (inside|indoors)$/.exec(stripped)?.[1];
  const readingPlace = cleanTargetText(placeReading?.[2] ?? warmthPlace ?? "");
  if (readingPlace) return `${readingPlace} ${placeReading?.[1] ?? "temperature"}`;

  const areaPatterns: readonly [RegExp, (area: string) => string][] = [
    [/^lights in (?:the )?(.+?) (?:not )?lit$/, (area) => `${area} lights`],
    [/^(?:is|are) (?:the )?lights in (?:the )?(.+?) (?:not )?lit$/, (area) => `${area} lights`],
    [new RegExp(`^which lights in (?:the )?(.+?) (?:are|is) ${STATUS_STATE_PATTERN}$`), (area) => `${area} lights`],
    [new RegExp(`^which lights (?:are|is) ${STATUS_STATE_PATTERN} in (?:the )?(.+?)$`), (area) => `${area} lights`],
    [new RegExp(`^are any lights in (?:the )?(.+) ${STATUS_STATE_PATTERN}$`), (area) => `${area} lights`],
    [new RegExp(`^(?:is|are) (?:the )?lights in (?:the )?(.+?) (?:showing |showing as |switched |turned |set )?${STATUS_STATE_PATTERN}$`), (area) => `${area} lights`],
  ];
  for (const [pattern, render] of areaPatterns) {
    const area = cleanTargetText(pattern.exec(stripped)?.[1] ?? "");
    if (area) return render(area);
  }

  const patterns: readonly RegExp[] = [
    /^(?:can you )?(?:check|get) (?:a |the )?(?:live |current )?reading from (?:the )?(.+)$/,
    /^what is (?:the )?temperature on (?:the )?(.+)$/,
    /^what temperature (?:is|are) (?:the )?(.+?) showing$/,
    /^how (?:warm|cold|hot) is it according to (?:the )?(.+)$/,
    /^how many degrees does (?:the )?(.+?) show$/,
    /^(?:can you )?get (?:a |the )?reading from (?:the )?(.+)$/,
    /^(?:give me|tell me|show me) (?:the )?(?:live |current )?reading from (?:the )?(.+)$/,
    /^what is (?:the )?(.+?) showing$/,
    /^what (?:is|are) (?:the |my )?(.+?) doing$/,
    /^what(?:s| s| is) showing for (?:the |my )?(.+)$/,
    /^what (?:can you see|are .+? doing) for (?:the |my )?(.+)$/,
    /^what does (?:the |my )?(.+?) (?:state|status) say$/,
    /^what is (?:the )?(?:state|status) of (?:the |my )?(.+)$/,
    /^what is (?:the |my )?(.+?) (?:status|state|reading|value)$/,
    /^what state (?:is|are) (?:the |my )?(.+) in$/,
    /^what condition (?:is|are) (?:the |my )?(.+) in$/,
    /^(?:report|read) (?:only )?(?:the |my )?(.+?)(?: (?:state|status|reading|value))?$/,
    /^(?:give me|tell me|show me) (?:the |my )?(.+?) (?:state|status|reading|value)$/,
    new RegExp(String.raw`^what is (?:the |my )?(.+?\b${READING_PATTERN})$`),
    new RegExp(`^(?:can you )?check whether (?:the |my )?(.+?) (?:is|are) (?:showing |showing as |switched |turned |set )?${STATUS_STATE_PATTERN}$`),
    new RegExp(`^(?:can you )?check if (?:the |my )?(.+?)(?: (?:is|are))? (?:showing |showing as |switched |turned |set )?${STATUS_STATE_PATTERN}$`),
    new RegExp(`^(?:can you )?check (?:the |my )?(.+?) (?:is|are) (?:showing |showing as |switched |turned |set )?${STATUS_STATE_PATTERN}$`),
    /^(?:can you )?check (?:the |my )?(.+) status$/,
    /^(?:can you )?check (?:the |my )?(.+)$/,
    /^i only want (?:the |my )?(.+?) checked not changed$/,
    /^(.+?) (?:state|status|reading|value)$/,
    new RegExp(`^tell me (?:whether|if) (?:the |my )?(.+?) (?:is|are) ${STATUS_STATE_PATTERN}$`),
    new RegExp(`^(?:which|what) (?:the |my )?(.+?) (?:is|are) ${STATUS_STATE_PATTERN}$`),
    new RegExp(`^do(?:es)? (?:the |my )?(.+?) show as ${STATUS_STATE_PATTERN}$`),
    new RegExp(`^(?:has|have) (?:the |my )?(.+?) (?:been )?(?:left |switched |turned |set )?${STATUS_STATE_PATTERN}$`),
    new RegExp(`^(.+?) been left ${STATUS_STATE_PATTERN}$`),
    new RegExp(`^have (?:the |my )?(.+?) been left ${STATUS_STATE_PATTERN}$`),
    new RegExp(`^(?:was|were) (?:the |my )?(.+?) left ${STATUS_STATE_PATTERN}$`),
    new RegExp(`^did i leave (?:the |my )?(.+?) ${STATUS_STATE_PATTERN}$`),
    new RegExp(`^(?:all|any) (?:the |my )?(.+?) (?:is|are) ${STATUS_STATE_PATTERN}$`),
    new RegExp(`^(?:are )?all (?:the |my )?(.+?) ${STATUS_STATE_PATTERN}$`),
    new RegExp(`^are there any (.+?) ${STATUS_STATE_PATTERN}$`),
    new RegExp(`^any (.+?) ${STATUS_STATE_PATTERN}$`),
    new RegExp(`^(.+?) (?:is|are) they ${STATUS_STATE_PATTERN}$`),
    new RegExp(`^(.+?) (?:is|are|was|were) ${STATUS_STATE_PATTERN}$`),
    new RegExp(`^(?:is|are|was|were) (?:the |my )?(.+?) (?:showing |showing as |switched |turned |set )?${STATUS_STATE_PATTERN}$`),
    new RegExp(`^(?:is|are|was|were) (?:the |my )?(.+?) ${STATUS_STATE_PATTERN}$`),
    new RegExp(`^(.+?) ${STATUS_STATE_PATTERN}$`),
  ];
  for (const pattern of patterns) {
    const target = cleanTargetText(pattern.exec(stripped)?.[1] ?? "");
    if (target) return target;
  }

  return null;
}

interface LightPredicateSlots {
  readonly targetText: string;
  readonly requestedState: "on" | "off";
  readonly quantifier: "any" | "all" | null;
}

function lightPredicateFromStatusText(value: string): LightPredicateSlots | null {
  const semanticValue = value
    .replace(/^(?:can you )?(?:confirm|check|verify)(?: whether| if)?\s+/, "")
    .trim();
  const existential = /^(?:is )?(not )?(?:there )?(anything|everything|nothing) (not )?(lit|glowing|dark) in (?:the )?(.+)$/.exec(semanticValue);
  const quantified = /^(?:are )?(any|all) lights in (?:the )?(.+?) (not )?(lit|glowing|dark)$/.exec(semanticValue);
  if (existential) {
    const area = cleanTargetText(existential[5] ?? "");
    if (area) {
      const baseQuantifier = existential[2] === "anything" ? "any" : "all";
      const subjectNegated = existential[2] === "nothing";
      const propositionNegated = Boolean(existential[1]);
      const predicateNegated = (Boolean(existential[3]) !== subjectNegated) !== propositionNegated;
      return {
        targetText: `${area} lights`,
        requestedState: lightPredicateState(existential[4] ?? "", predicateNegated),
        quantifier: propositionNegated
          ? baseQuantifier === "any" ? "all" : "any"
          : baseQuantifier,
      };
    }
  }
  if (quantified) {
    const area = cleanTargetText(quantified[2] ?? "");
    if (area) {
      return {
        targetText: `${area} lights`,
        requestedState: lightPredicateState(quantified[4] ?? "", Boolean(quantified[3])),
        quantifier: quantified[1] === "all" ? "all" : "any",
      };
    }
  }

  const subjectMatch = /^(?:is|are|was|were) (?:the |my )?(.+?) (not )?(lit|glowing|dark)$/.exec(semanticValue)
    ?? /^(.+?) (?:is|are|was|were) (not )?(lit|glowing|dark)$/.exec(semanticValue)
    ?? /^(.+?) (not )?(lit|glowing|dark)$/.exec(semanticValue);
  const subject = cleanTargetText(subjectMatch?.[1] ?? "");
  if (!subject
    || /^(?:anything|everything|what|which|there)$/.test(subject)
    || /^(?:did|do|does|has|have|was|were|can|could|would|will|should)\b/.test(subject)) {
    return null;
  }
  const areaLights = /^lights in (.+)$/.exec(subject)?.[1];
  return {
    targetText: areaLights
      ? `${areaLights} lights`
      : /\b(?:lights?|lighting|lamps?)\b/.test(subject) ? subject : `${subject} lights`,
    requestedState: lightPredicateState(subjectMatch?.[3] ?? "", Boolean(subjectMatch?.[2])),
    quantifier: null,
  };
}

function lightPredicateState(predicate: string, negated: boolean): "on" | "off" {
  const positive = predicate === "lit" || predicate === "glowing";
  return positive !== negated ? "on" : "off";
}

/** The state a status question asks for, read from its final predicate. */
export function requestedStateFromStatusText(normalized: string): string | null {
  const stateOrNot = new RegExp(`\\b(${STATUS_STATE_PATTERN})\\s+or\\s+not$`).exec(normalized)?.[1] ?? null;
  if (stateOrNot) return stateOrNot;
  if (new RegExp(`\\b${STATUS_STATE_PATTERN}\\s+or\\s+(?:still\\s+)?${STATUS_STATE_PATTERN}$`).test(normalized)
    || /\b(?:on and off|open and closed|locked and unlocked|same state)\b/.test(normalized)) return null;
  if (/\baway\b|\b(?:gone|headed) out\b/.test(normalized)) return "away";
  if (/\b(?:at|showing (?:as |at )?|is |are )home\b|\b(?:made it|come|got) home\b|\bhome$/.test(normalized)) return "home";
  if (/\b(?:at|showing (?:as |at )?|is |are )work\b|\bwork$/.test(normalized)) return "work";
  if (/\b(?:at|showing (?:as |at )?|is |are )school\b|\bschool$/.test(normalized)) return "school";
  for (const word of [
    "disconnected", "connected", "unlocked", "locked", "disabled", "enabled", "disarmed", "armed",
    "detected", "inactive", "active", "closed", "clear", "open", "running", "off", "on",
  ]) {
    if (new RegExp(`\\b${word}$`).test(normalized)) return word;
  }
  if (/\blit$/.test(normalized)) return "on";
  if (/\bdark$/.test(normalized)) return "off";
  if (/\bout$/.test(normalized)) return "out";
  if (/\bshut$/.test(normalized)) return "closed";
  if (/\bsecure$/.test(normalized)) return "locked";
  if (/\btriggered$/.test(normalized)) return "detected";
  return null;
}

export function statusQuantifierFromText(normalized: string): "any" | "all" | "which" | null {
  if (/\bwhich\b/.test(normalized)
    || /\bwhat\s+(?:lights?|lamps?|outlets?|switch(?:es)?|doors?|windows?|locks?|rooms?)\b/.test(normalized)) return "which";
  if (/\b(?:all|both|each|every|same state)\b/.test(normalized)) return "all";
  if (/\b(?:any|either)\b|\bare there\b/.test(normalized)) return "any";
  return null;
}

export function parseNumericStatusComparison(input: string): NumericStatusComparison | null {
  // Preserve unary signs before the shared speech normalizer treats hyphens
  // as punctuation. Spoken `minus` and typed/ASR `-` then share one parser.
  const normalized = normalize(normalizeCompactMeasurementNotation(
    input.replace(/[−-]\s*(?=\d)/g, "minus "),
  ));
  const match = NUMERIC_STATUS_COMPARISON_PATTERN.exec(normalized);
  if (!match) return null;
  const threshold = parseCompactNumberWords(match[2] ?? "");
  if (threshold === null) return null;
  return {
    operator: /^(?:below|under|less than|colder than)$/.test(match[1] ?? "") ? "less_than" : "greater_than",
    threshold,
    unit: numericComparisonUnitFromTail(match[3] ?? ""),
  };
}

function requestedAttributeFromStatusText(normalized: string): "temperature" | null {
  return /\b(?:temperature|temp|degrees?|warmer|colder)\b/.test(normalized)
    || /^(?:how (?:warm|cold|hot)|what does it feel like)\b/.test(normalized)
    ? "temperature"
    : null;
}

function numericComparisonUnitFromTail(tail: string): string | null {
  const normalized = tail.trim().replaceAll("μ", "µ");
  if (!normalized) return null;
  if (normalized === "in") return "in";
  const prepositionalUnit = /^in\s+(.+)$/.exec(normalized)?.[1] ?? null;
  if (prepositionalUnit) {
    const candidate = numericUnitCandidateBeforeDiscourse(prepositionalUnit);
    const canonical = canonicalNumericStatusUnit(candidate);
    return canonical && KNOWN_CANONICAL_NUMERIC_UNITS.has(canonical) ? canonical : null;
  }
  if (looksLikeNumericComparisonDiscourseTail(normalized)) {
    return null;
  }
  const candidate = numericUnitCandidateBeforeDiscourse(normalized);
  if (!candidate || /^(?:degree|degrees)$/.test(candidate)) return null;
  // Canonicalize the complete expression. Never accept a valid prefix from a
  // different dimension (`m/s²` is not `m/s`, and `W/m²` is not `W`).
  return canonicalNumericStatusUnit(candidate);
}

function numericUnitCandidateBeforeDiscourse(value: string): string | null {
  const boundary = /\s+(?:right now|at the moment|now|currently|today|tonight|tomorrow|later|outside|outdoors?|inside|indoors?|in|on|at|for|from|when|then|this|next|yesterday|please|mate|and|or|yet|already|still|exactly|roughly|approximately|about|around|nearly|almost|or so)\b/.exec(value);
  const candidate = (boundary ? value.slice(0, boundary.index) : value).trim();
  return candidate || null;
}

function looksLikeNumericComparisonDiscourseTail(value: string): boolean {
  return /^(?:right now|at the moment|now|currently|today|tonight|tomorrow|later|outside|outdoors?|inside|indoors?|in\b|on\b|at\b|for\b|from\b|when\b|then\b|this\b|next\b|yesterday\b|please\b|mate\b|and\b|or\b|yet\b|already\b|still\b|exactly\b|roughly\b|approximately\b|about\b|around\b|nearly\b|almost\b|or so\b)/.test(value);
}

export function canonicalNumericStatusUnit(value: string | null): string | null {
  if (!value?.trim()) return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll("℃", "°c")
    .replaceAll("℉", "°f")
    .replaceAll("μ", "µ")
    .replaceAll(/\s+/g, " ");
  const compact = normalized.replace(/^(?:degrees?|degree)\s+/, "");
  if (["c", "°c", "celsius", "centigrade"].includes(compact)) return "°C";
  if (["f", "°f", "fahrenheit"].includes(compact)) return "°F";
  if (["k", "kelvin"].includes(compact)) return "K";
  if (["%", "percent", "per cent", "percentage", "pct"].includes(compact)) return "%";
  if (["m", "metre", "metres", "meter", "meters"].includes(compact)) return "m";
  if (["km", "kilometre", "kilometres", "kilometer", "kilometers"].includes(compact)) return "km";
  if (["mm", "millimetre", "millimetres", "millimeter", "millimeters"].includes(compact)) return "mm";
  if (["cm", "centimetre", "centimetres", "centimeter", "centimeters"].includes(compact)) return "cm";
  if (["ft", "foot", "feet"].includes(compact)) return "ft";
  if (["in", "inch", "inches"].includes(compact)) return "in";
  if (["yd", "yard", "yards"].includes(compact)) return "yd";
  if (["mi", "mile", "miles"].includes(compact)) return "mi";
  if (compact === "pa") return "Pa";
  if (compact === "kpa") return "kPa";
  if (compact === "hpa") return "hPa";
  if (["bar", "bars"].includes(compact)) return "bar";
  if (compact === "psi") return "psi";
  if (["w", "watt", "watts"].includes(compact)) return "W";
  if (["kw", "kilowatt", "kilowatts"].includes(compact)) return "kW";
  if (["mw", "megawatt", "megawatts"].includes(compact)) return "MW";
  if (["wh", "watt hour", "watt hours"].includes(compact)) return "Wh";
  if (["kwh", "kilowatt hour", "kilowatt hours"].includes(compact)) return "kWh";
  if (["mwh", "megawatt hour", "megawatt hours"].includes(compact)) return "MWh";
  if (["v", "volt", "volts"].includes(compact)) return "V";
  if (["mv", "millivolt", "millivolts"].includes(compact)) return "mV";
  if (["a", "amp", "amps", "ampere", "amperes"].includes(compact)) return "A";
  if (["ma", "milliamp", "milliamps"].includes(compact)) return "mA";
  if (["hz", "hertz"].includes(compact)) return "Hz";
  if (compact === "lux") return "lx";
  if (["ppm", "part per million", "parts per million"].includes(compact)) return "ppm";
  if (["db", "decibel", "decibels"].includes(compact)) return "dB";
  if (["l", "litre", "litres", "liter", "liters"].includes(compact)) return "L";
  if (["ml", "millilitre", "millilitres", "milliliter", "milliliters"].includes(compact)) return "mL";
  if (["s", "sec", "second", "seconds"].includes(compact)) return "s";
  if (["min", "minute", "minutes"].includes(compact)) return "min";
  if (["h", "hr", "hour", "hours"].includes(compact)) return "h";
  if (["d", "day", "days"].includes(compact)) return "d";
  if (["g", "gram", "grams"].includes(compact)) return "g";
  if (["mg", "milligram", "milligrams"].includes(compact)) return "mg";
  if (["kg", "kilogram", "kilograms"].includes(compact)) return "kg";
  if (["oz", "ounce", "ounces"].includes(compact)) return "oz";
  if (["lb", "pound", "pounds"].includes(compact)) return "lb";
  if (["km/h", "km per hour", "kilometre per hour", "kilometres per hour", "kilometer per hour", "kilometers per hour", "kmph", "kph", "kmh", "km h"].includes(compact)) return "km/h";
  if (["m/s", "m s", "metre per second", "metres per second", "meter per second", "meters per second"].includes(compact)) return "m/s";
  if (["mph", "mile per hour", "miles per hour"].includes(compact)) return "mph";
  if (["µg/m³", "ug/m3", "ug/m^3", "mcg/m3", "mcg/m^3", "microgram per cubic metre", "micrograms per cubic metre", "microgram per cubic meter", "micrograms per cubic meter"].includes(compact)) return "µg/m³";
  if (["mg/m³", "mg/m3", "mg/m^3", "milligram per cubic metre", "milligrams per cubic metre", "milligram per cubic meter", "milligrams per cubic meter"].includes(compact)) return "mg/m³";
  if (["g/m³", "g/m3", "g/m^3", "gram per cubic metre", "grams per cubic metre", "gram per cubic meter", "grams per cubic meter"].includes(compact)) return "g/m³";
  return normalized;
}

const KNOWN_CANONICAL_NUMERIC_UNITS = new Set([
  "°C", "°F", "K", "%", "m", "km", "mm", "cm", "ft", "in", "yd", "mi",
  "Pa", "kPa", "hPa", "bar", "psi", "W", "kW", "MW", "Wh", "kWh", "MWh",
  "V", "mV", "A", "mA", "Hz", "lx", "ppm", "dB", "L", "mL", "s", "min", "h", "d",
  "g", "mg", "kg", "oz", "lb", "km/h", "m/s", "mph", "µg/m³", "mg/m³", "g/m³",
]);

/** Add a lexical boundary only inside numeric comparison parsing. */
function normalizeCompactMeasurementNotation(value: string): string {
  return value
    .replaceAll("℃", " °c")
    .replaceAll("℉", " °f")
    .replace(/(\d)(?=[a-zµμ°%])/gi, "$1 ");
}

function personLocationTarget(value: string): string | null {
  const target = cleanTargetText(
    /^(?:can you )?check where (.+?) is$/.exec(value)?.[1]
      ?? /^where is (.+)$/.exec(value)?.[1]
      ?? /^where (.+?) is$/.exec(value)?.[1]
      ?? /^where (?:do|does) (.+?) (?:show|appear|register)(?: up)? as being$/.exec(value)?.[1]
      ?? "",
  );
  if (!target || new RegExp(String.raw`\b(?:${DEVICE_STATUS_PATTERN}|temperature|temp)\b`).test(target)) {
    return null;
  }
  return target;
}

/**
 * `location` is a facet of a sourced target in shapes such as `check the
 * work phone location`; it is not part of that target's name. A trailing
 * possessive marker is left to the person-location grammar above so
 * `check the owner's location` still targets the owner rather than `the owner's`.
 */
function locationFacetTarget(value: string): string | null {
  const target = cleanTargetText(
    /^(?:check|confirm|report|show(?: me)?) (?:the |my )?(.+?) (?:location|presence)$/.exec(value)?.[1]
      ?? "",
  );
  if (!target || /\bs$/.test(target)) return null;
  return target;
}

function sourcePreferenceFromStatusText(normalized: string): "physical_sensor" | null {
  return /\bphysical\b.*\b(?:sensor|reading|temperature|temp)\b|\blocal\b.*\bsensor\b|\bsensor itself\b|\bnot (?:the )?weather (?:service|forecast)\b/.test(normalized)
    ? "physical_sensor"
    : null;
}

function parseCompactNumberWords(value: string): number | null {
  const trimmed = value.trim();
  const minusDigits = /^(?:minus|negative)\s+(.+)$/.exec(trimmed)?.[1] ?? null;
  if (minusDigits && /^(?:\d{1,3}(?:[ ,]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)$/.test(minusDigits)) {
    return -Number(minusDigits.replaceAll(/[ ,]/g, ""));
  }
  if (/^-?\d{1,3}(?:[ ,]\d{3})+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed.replaceAll(/[ ,]/g, ""));
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const small: Readonly<Record<string, number>> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19,
  };
  const tens: Readonly<Record<string, number>> = {
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  };
  const rawTokens = value.replaceAll("-", " ").split(/\s+/).filter(Boolean);
  const negative = rawTokens[0] === "minus" || rawTokens[0] === "negative";
  const tokens = negative ? rawTokens.slice(1) : rawTokens;
  const sign = negative ? -1 : 1;
  if (tokens.length === 0 || tokens.filter((token) => token === "point").length > 1) return null;
  const pointIndex = tokens.indexOf("point");
  const integerTokens = pointIndex >= 0 ? tokens.slice(0, pointIndex) : tokens;
  const fractionalTokens = pointIndex >= 0 ? tokens.slice(pointIndex + 1) : [];
  if (integerTokens.length === 0
    || (pointIndex >= 0 && (fractionalTokens.length === 0 || fractionalTokens.some((token) => {
      const digit = small[token];
      return digit === undefined || digit < 0 || digit > 9;
    })))) {
    return null;
  }
  const integer = parseWholeNumberWords(integerTokens, small, tens);
  if (integer === null) return null;
  const fraction = fractionalTokens.length > 0
    ? Number(`0.${fractionalTokens.map((token) => small[token]).join("")}`)
    : 0;
  return sign * (integer + fraction);
}

function parseWholeNumberWords(
  tokens: readonly string[],
  small: Readonly<Record<string, number>>,
  tens: Readonly<Record<string, number>>,
): number | null {
  if (tokens.filter((token) => token === "thousand").length > 1) return null;
  const thousandIndex = tokens.indexOf("thousand");
  if (thousandIndex >= 0) {
    const high = parseNumberWordsBelowThousand(tokens.slice(0, thousandIndex), small, tens);
    const rawLowTokens = tokens.slice(thousandIndex + 1);
    const lowTokens = rawLowTokens[0] === "and" ? rawLowTokens.slice(1) : rawLowTokens;
    if (rawLowTokens.length > 0 && lowTokens.length === 0) return null;
    const low = lowTokens.length > 0 ? parseNumberWordsBelowThousand(lowTokens, small, tens) : 0;
    return high !== null && high > 0 && low !== null ? high * 1_000 + low : null;
  }
  return parseNumberWordsBelowThousand(tokens, small, tens);
}

function parseNumberWordsBelowThousand(
  tokens: readonly string[],
  small: Readonly<Record<string, number>>,
  tens: Readonly<Record<string, number>>,
): number | null {
  const hundredIndex = tokens.indexOf("hundred");
  if (hundredIndex >= 0) {
    if (hundredIndex !== 1 || tokens.filter((token) => token === "hundred").length !== 1) return null;
    const multiplier = small[tokens[0] ?? ""];
    if (multiplier === undefined || multiplier < 1 || multiplier > 9) return null;
    const remainder = tokens.slice(2);
    const normalizedRemainder = remainder[0] === "and" ? remainder.slice(1) : remainder;
    if (normalizedRemainder.includes("and")) return null;
    const low = normalizedRemainder.length > 0 ? parseNumberWordsBelowHundred(normalizedRemainder, small, tens) : 0;
    return low === null ? null : multiplier * 100 + low;
  }
  if (tokens.includes("and")) return null;
  return parseNumberWordsBelowHundred(tokens, small, tens);
}

function parseNumberWordsBelowHundred(
  tokens: readonly string[],
  small: Readonly<Record<string, number>>,
  tens: Readonly<Record<string, number>>,
): number | null {
  if (tokens.length === 1) {
    return small[tokens[0] ?? ""] ?? tens[tokens[0] ?? ""] ?? null;
  }
  if (tokens.length === 2) {
    const high = tens[tokens[0] ?? ""];
    const low = small[tokens[1] ?? ""];
    return high !== undefined && low !== undefined && low > 0 && low < 10 ? high + low : null;
  }
  return null;
}

/**
 * A statement-shaped status ask that ends on its device ("office lights?").
 * The shared plan also takes a trailing temperature/temp, never alone; the
 * status owner's variant takes device heads only.
 */
export function bareDeviceStatusTargetText(normalized: string, variant: "plan" | "status" = "plan"): string | null {
  if (new RegExp(String.raw`^(?:${QUESTION_LEAD_PATTERN}|check|tell|show|give|turn|switch|set|open|close|lock|unlock)\b`).test(normalized)) return null;
  if (!(variant === "plan" ? BARE_PLAN_TARGET_END : BARE_DEVICE_TARGET_END).test(normalized)) return null;
  if (POWER_READING_WORD.test(normalized)) return null;
  const target = cleanTargetText(normalized, variant);
  return target && (variant === "status" || (target !== "temperature" && target !== "temp")) ? target : null;
}

const BARE_PLAN_TARGET_END = new RegExp(String.raw`\b(?:${DEVICE_STATUS_PATTERN}|temperature|temp)$`);
const BARE_DEVICE_TARGET_END = new RegExp(String.raw`\b${DEVICE_STATUS_PATTERN}$`);

const QUANTIFIER_EDGE = {
  plan: /^(?:all|any|both|each|every|either)\b(?:\s+of\b)?/g,
  status: /^(?:all|any|each|every|either)\b(?:\s+of\b)?/g,
};
const STATUS_WORD_EDGE = {
  plan: /\b(?:status|state|reading|value|please|again|too|definitely|itself)\b$/g,
  status: /\b(?:status|state|reading|sensor|please|again|too|definitely)\b$/g,
};

/**
 * A target phrase without its quantifier, question and status-word edges.
 * The shared plan (default) also drops "both" and source adjectives (live,
 * current, physical, local) in front and "value"/"itself" behind, and keeps a
 * trailing "sensor" as part of the name. `status` is the status owner's
 * variant for follow-ups and area targets: it starts from the target key
 * (which drops a trailing "sensors") and drops a trailing "sensor" word.
 */
export function cleanTargetText(value: string, variant: "plan" | "status" = "plan"): string | null {
  let clean = variant === "plan" ? normalizeTargetText(value) : targetTextKey(value);
  for (let index = 0; index < 4; index += 1) {
    const unquantified = clean.replace(QUANTIFIER_EDGE[variant], " ");
    const next = (variant === "plan" ? unquantified.replace(/^(?:(?:live|current|physical|local)\s+)+/g, " ") : unquantified)
      .replace(/^(?:what(?:s| is)|showing for|status of)\b/g, " ")
      .replace(STATUS_WORD_EDGE[variant], " ")
      .replace(/\bfor me\b$/g, " ")
      .replace(/\bonce more\b$/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (next === clean) break;
    clean = next;
  }
  return clean || null;
}

function normalizeTargetText(value: string): string {
  return stripStatusFiller(normalize(value))
    .replace(/\b(?:the|my)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Discourse focus may follow a complete discrete-state predicate without
 * becoming part of the entity name. Keep the rule predicate-bound so words
 * such as "specific" or "exactly" elsewhere remain meaningful target text.
 */
function stripTerminalStatusFocusAdjunct(value: string): string {
  let result = value;
  while (true) {
    const next = result
      .replace(/\s+(?:specifically|particularly|in particular|exactly)$/u, "")
      .trim();
    if (next === result
      || !new RegExp(`\\b(?:${STATUS_STATE_PATTERN})$`, "u").test(next)) {
      return result;
    }
    result = next;
  }
}

function normalizeQuestionLeadIn(normalized: string): string {
  return rewriteTrailingQuestionCopula(stripConversationalLeadIns(normalized, { stripConditionalStatusLeadIns: true }))
    .replace(/^only\s+/, "")
    .replace(/^(?:tell(?: me)?|show me|give me)\s+(?:if|whether)\s+/, "")
    .replace(/^(?:if|whether)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasUnresolvedEntityOwnership(normalized: string, targetText: string): boolean {
  const target = normalizeTargetText(targetText);
  if (new RegExp(String.raw`\b(?:${DEVICE_STATUS_PATTERN}|temperature|temp)\b`).test(target)) {
    return true;
  }
  if (/\b(?:home|work|school|away|presence|location)\b/.test(normalized)
    && !/^(?:what|which|where|when|why|how)$/.test(target)) {
    return true;
  }
  return /\b(?:lit|dark|glowing)\b/.test(normalized)
    && target.length > 1
    && !/^(?:what|which|anything|everything|it|there)$/.test(target);
}

function normalize(value: string): string {
  return normalizeMeasuredRoutingText(value)
    .replace(/\bhasn t\b/g, "has not")
    .replace(/\bhaven t\b/g, "have not")
    .replace(/\bhadn t\b/g, "had not");
}
