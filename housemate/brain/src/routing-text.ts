import { normalizeSpeechForRouting } from "./speech-normalizer.js";
import { TextMemo } from "./text-memo.js";
import { DEFINITE_DETERMINER_PATTERN, DEVICE_CONTROL_PATTERN, NOW_PATTERN, PARTICIPANT_PATTERN, QUESTION_LEAD_PATTERN, stripStatusFiller } from "./lexicon.js";
import { householdRegex } from "./household.js";
import { assistantNamePattern } from "./persona.js";

interface RoutingLeadInOptions {
  readonly stripConditionalStatusLeadIns?: boolean;
  readonly preserveLeadingAssistantSubject?: boolean;
}

const ACTION_COMMAND_PATTERN = "(?:turn|switch|toggle|set|make|open|close|shut|lock|unlock|enable|disable|start|stop|pause|resume|dock|raise|lower|power\\s+(?:up|down)|light(?:\\s+up)?)";
const HOUSE_QUERY_SIGNAL = "(?:status|state|temperature|temp|power|electricity|energy|usage|load|loads|watts?|kw|kwh|solar|grid|battery|water|gas|weather|time|lights?|lamp|heater|fan|switch|sensor|outlet|lock|door|gate|garage|computer)";
const DEVICE_CONTROL_VERB_PATTERN = "(?:turn|switch|toggle|set|make|open|close|shut|lock|unlock|enable|disable|start|stop|pause|resume|dock|raise|lower|power\\s+(?:up|down)|light(?:\\s+up)?|change)";
const DEVICE_CONTROL_GERUND_PATTERN = "(?:turning|switching|toggling|setting|making|opening|closing|shutting|locking|unlocking|enabling|disabling|starting|stopping|pausing|resuming|docking|raising|lowering|powering|lighting|changing)";
const DEVICE_CONTROL_PARTICIPLE_PATTERN = "(?:turned|switched|toggled|set|made|opened|closed|shut|locked|unlocked|enabled|disabled|started|stopped|paused|resumed|docked|raised|lowered|powered|lit|changed)";
const DATA_MUTATION_VERB_PATTERN = "(?:add|create|delete|remove|erase|trash|purge|wipe|move|drop|clear|cancel|edit|update|rename|reschedule|schedule|book|mark|complete|tick|untick|save|write|send|post|forget|remember|approve|reject|redact|archive)";
const DATA_MUTATION_GERUND_PATTERN = "(?:adding|creating|deleting|removing|erasing|trashing|purging|wiping|moving|dropping|clearing|cancell?ing|editing|updating|renaming|rescheduling|scheduling|booking|marking|completing|ticking|unticking|saving|writing|sending|posting|forgetting|remembering|approving|rejecting|redacting|archiving)";
const DATA_MUTATION_PARTICIPLE_PATTERN = "(?:added|created|deleted|removed|erased|trashed|purged|wiped|moved|dropped|cleared|cancelled|canceled|edited|updated|renamed|rescheduled|scheduled|booked|marked|completed|ticked|unticked|saved|written|sent|posted|forgotten|remembered|approved|rejected|redacted|archived)";
const READ_DIRECTIVE_PATTERN = "(?:tell me|show me|give me|check|confirm|verify|read|identify|report|list|scan|compare|contrast|rank|break down|explain|define|summari[sz]e|find(?: out)?|work out)";
const READ_DIRECTIVE_GERUND_PATTERN = "(?:telling me|showing me|giving me|checking|confirming|verifying|reading|identifying|reporting|listing|scanning|comparing|contrasting|ranking|breaking down|explaining|defining|summari[sz]ing|finding out|working out)";
const READ_DIRECTIVE_PARTICIPLE_PATTERN = "(?:checked|confirmed|verified|read|identified|reported|listed|scanned|compared|contrasted|ranked|broken down|explained|defined|summari[sz]ed|found|worked out)";
const SOURCE_READ_DIRECTIVE_PATTERN = "(?:check|confirm|verify|read|identify|report|list|scan|compare|contrast|rank|break down|find(?: out)?|work out)";
const SOURCE_READ_GERUND_PATTERN = "(?:checking|confirming|verifying|reading|identifying|reporting|listing|scanning|comparing|contrasting|ranking|breaking down|finding out|working out)";
const SOURCE_READ_PARTICIPLE_PATTERN = "(?:checked|confirmed|verified|read|identified|reported|listed|scanned|compared|contrasted|ranked|broken down|found|worked out)";
const READ_ACQUISITION_VERB_PATTERN = "(?:get|obtain|retrieve|fetch|pull)";
const READ_ACQUISITION_OBJECT_PATTERN = "(?:(?:a|an|the|this|that|current|live|latest|new)\\s+)*(?:reading|readings|state|status|value|values|result|results|measurement|measurements)";
const INFORMATION_PRESENTATION_VERB_PATTERN = "(?:show|give)(?:\\s+(?:me|us))?";
const DISCOURSE_READ_SELECTION_PATTERN = "(?:(?:finish|end|close)(?:\\s+(?:up|out))?|wrap\\s+up)\\s+with";
const TYPED_READ_RESULT_HEAD_PATTERN = "(?:status|state|reading|readings|value|values|result|results|measurement|measurements|temperature|temp|power|electricity|energy|usage|consumption|draw|output|load|loads|wattage|watts?|kw|kwh|solar|grid|battery|water|gas|import|export|weather|forecast|time|date|calendar|agenda|schedule|reminder|reminders|tasks?|to\\s+do(?:\\s+list)?|shopping\\s+list|location|presence|lights?|lamps?|doors?|locks?|switch(?:es)?|sensors?|outlets?)";
const TASK_VERB_PATTERN = `(?:${DEVICE_CONTROL_VERB_PATTERN.slice(3, -1)}|${DATA_MUTATION_VERB_PATTERN.slice(3, -1)}|calculate|compute|evaluate|solve|work|subtract|multiply|divide|tell|show|give|check|confirm|verify|read|identify|report|list|scan|compare|contrast|rank|break down|explain|define)`;
const COURTESY_GUARD_PATTERN = "(?:if\\s+(?:(?:it\\s+is\\s+)?(?:possible|convenient|okay|alright)|it\\s+is\\s+not\\s+too\\s+much\\s+trouble|(?:you\\s+)?(?:are\\s+)?able(?:\\s+to)?|you\\s+(?:would\\s+not\\s+mind|are\\s+able\\s+to|can|could|would)))";
const CONDITION_GUARD_PATTERN = "(?:if|unless|provided(?:\\s+that)?|providing(?:\\s+that)?|assuming(?:\\s+that)?|on\\s+condition\\s+that)";
const REQUEST_MANNER_PATTERN = "(?:(?:please|possibly|kindly)\\s+)*";
const QUOTED_HEAD_DETERMINER_PATTERN = "(?:(?:the|this|these|that|those)(?:\\s+exact)?|my|your|his|her|our|their)";

export type RoutingSpeechAct = "query" | "command" | "statement" | "fragment" | "dialogue";

export type RoutingReferenceWorld = "actual" | "hypothetical" | "counterfactual";
export type RoutingExecution = "none" | "immediate" | "conditional" | "deferred";
export type RoutingGuard = "courtesy" | "condition";

interface RoutingSemanticCore {
  readonly coreSurface: string;
  readonly core: string;
}

export type RoutingSemantics =
  | (RoutingSemanticCore & {
    readonly use: "task";
    readonly force: RoutingSpeechAct;
    readonly authority: "speaker_direct";
    readonly embedding: "direct" | "indirect";
    readonly taskKind: "control" | "read" | "other";
    readonly world: RoutingReferenceWorld;
    readonly execution: RoutingExecution;
    readonly guards: readonly RoutingGuard[];
  })
  | (RoutingSemanticCore & {
    readonly use: "mention";
    readonly force: "query" | "statement";
    readonly authority: "none";
    readonly embedding: "reported" | "quoted";
    readonly world: RoutingReferenceWorld;
    readonly execution: "none";
    readonly guards: readonly [];
    readonly embeddedForce: Exclude<RoutingSpeechAct, "dialogue">;
    /**
     * The report sits inside a question about the conversation itself ("are
     * you aware I asked you about...", "did I tell you..."). Its object is
     * prior discourse, so no route may act on or read the reported content.
     */
    readonly priorConversation: boolean;
  });

export type RoutingDialogueAct =
  | "cancel"
  | "stop"
  | "gratitude"
  | "acknowledge"
  | "agree"
  | "disagree"
  | "rephrase"
  | "hold"
  | "resume"
  | "attention"
  | "greet"
  | "check_in"
  | "goodbye"
  | "apology"
  | "compliment"
  | "capability";

export type RoutingDialogueResponsePolicy = "deterministic" | "contextual";

export interface RoutingUtterance {
  readonly raw: string;
  readonly normalized: string;
  readonly coreSurface: string;
  readonly core: string;
  readonly speechAct: RoutingSpeechAct;
  readonly dialogueAct: RoutingDialogueAct | null;
  readonly dialogueResponsePolicy: RoutingDialogueResponsePolicy | null;
  readonly dialoguePrefix: RoutingDialogueAct | null;
  readonly resetBeforeCore: boolean;
  readonly semantics: RoutingSemantics;
}

export interface ParseRoutingUtteranceOptions {
  /** Enables discourse-dependent acts only after a real session frame exists. */
  readonly hasSessionContext?: boolean;
  /** Payload-redacted domains available for topic-linked discourse acts. */
  readonly contextFrameKinds?: readonly string[];
}

/**
 * Frames that describe, quote, or imagine a state are not assertions that the
 * assistant should enact or read as a live-house question. Keep this modality
 * decision ahead of domain target resolution so a coincidental alias can never
 * turn a hypothetical clause into intent ownership.
 */
export function hasNonAssertiveRoutingFrame(value: string): boolean {
  const text = clauseText(value);
  if (!text) return false;
  if (classifyMentionFrame(text)) return true;
  const taskCore = canonicalizeRoutingText(text);
  if (isCourtesyConditionalDirective(text, taskCore)) return false;
  return classifyReferenceWorld(text) !== "actual";
}

export function routingSemanticsAllowDirectAction(semantics: RoutingSemantics): boolean {
  return semantics.use === "task"
    && semantics.force === "command"
    && semantics.taskKind === "control"
    && semantics.authority === "speaker_direct"
    && semantics.world === "actual";
}

export function routingSemanticsAllowCurrentStatus(semantics: RoutingSemantics): boolean {
  return routingSemanticsAllowReadOnlyToolUse(semantics);
}

export function routingSemanticsAllowReadOnlyToolUse(semantics: RoutingSemantics): boolean {
  return semantics.use === "task"
    && semantics.world === "actual"
    && semantics.taskKind === "read"
    && (semantics.force === "query"
      || semantics.force === "fragment"
      || semantics.force === "command");
}

const GENERIC_KIND_SUBJECT = /\b(?:do|does|can|could|would|should|will|might|must)\s+(?:a|an)\s+[a-z]/;
const PARTICIPANT_WORD = new RegExp(`\\b${PARTICIPANT_PATTERN}\\b`);
const DEFINITE_WORD = new RegExp(`\\b${DEFINITE_DETERMINER_PATTERN}\\b`);

/**
 * A question about a kind of thing, not this house: an indefinite subject
 * under do-support or a modal ("how much gas does a car use", "can a kettle
 * trip a breaker") with no participant or definite noun phrase tying it to
 * the household. A past "did a door open" is an episode, not a kind.
 */
export function looksLikeGenericKindQuestion(core: string): boolean {
  return GENERIC_KIND_SUBJECT.test(core)
    && !PARTICIPANT_WORD.test(core)
    && !DEFINITE_WORD.test(core);
}

export function looksLikeDataMutationRequest(value: string): boolean {
  const text = clauseText(value, true);
  if (!text) {
    return false;
  }
  return new RegExp(`^(?:please\\s+)?${DATA_MUTATION_VERB_PATTERN}\\b`).test(text)
    || new RegExp(`^(?:can|could|would|will) you\\s+(?:(?:please|kindly)\\s+)?${DATA_MUTATION_VERB_PATTERN}\\b`).test(text)
    || new RegExp(`^why (?:do not you|not)\\s+${DATA_MUTATION_VERB_PATTERN}\\b`).test(text)
    || new RegExp(`^(?:how|what) about\\s+${DATA_MUTATION_GERUND_PATTERN}\\b`).test(text)
    || new RegExp(`^(?:please\\s+)?have\\s+.+\\s+${DATA_MUTATION_PARTICIPLE_PATTERN}$`).test(text)
    || new RegExp(`^(?:can|could|would|will|should)\\s+.+\\s+be\\s+${DATA_MUTATION_PARTICIPLE_PATTERN}$`).test(text)
    || new RegExp(`^i (?:want|need) you to\\s+${DATA_MUTATION_VERB_PATTERN}\\b`).test(text)
    || new RegExp(`^i would like you to\\s+${DATA_MUTATION_VERB_PATTERN}\\b`).test(text)
    || new RegExp(`^go ahead(?: and)?\\s+${DATA_MUTATION_VERB_PATTERN}\\b`).test(text)
    || containsEmbeddedDataMutationDirective(text);
}

/**
 * True only for a structurally explicit source-inspection request. Polysemous
 * presentation verbs become reads only when their grammatical object is a
 * typed result/source noun; creative and action objects remain ordinary tasks.
 */
export function looksLikeExplicitReadRequest(value: string): boolean {
  const text = clauseText(value, true);
  if (!text) {
    return false;
  }
  if (looksLikeKnowledgeContentReadRequest(text)) {
    return false;
  }
  if (looksLikeReadAcquisitionRequest(text)) {
    return true;
  }
  if (extractTypedReadPresentationObject(text)) {
    return true;
  }
  const manner = "(?:(?:please|possibly|kindly)\\s+)*";
  return new RegExp(`^(?:please\\s+|kindly\\s+)?${SOURCE_READ_DIRECTIVE_PATTERN}\\b`).test(text)
    || new RegExp(`^(?:can|could|would|will) (?:you|we|i)\\s+${manner}${SOURCE_READ_DIRECTIVE_PATTERN}\\b`).test(text)
    || new RegExp(`^(?:is|was|would|could) it (?:at all )?possible(?: for (?:you|us|me))? to\\s+${SOURCE_READ_DIRECTIVE_PATTERN}\\b`).test(text)
    || new RegExp(`^(?:do|would) you mind\\s+${SOURCE_READ_GERUND_PATTERN}\\b`).test(text)
    || new RegExp(`^(?:how|what) about\\s+${SOURCE_READ_GERUND_PATTERN}\\b`).test(text)
    || new RegExp(`^(?:can|could|would|will|should)\\s+.+\\s+(?:be|get)\\s+${SOURCE_READ_PARTICIPLE_PATTERN}\\b`).test(text);
}

/** A request to consume information about a topic, rather than inspect a source. */
export function looksLikeKnowledgeContentReadRequest(value: string): boolean {
  const text = clauseText(value, true);
  const manner = "(?:(?:please|possibly|kindly)\\s+)*";
  return new RegExp(
    `^(?:(?:can|could|would|will) you\\s+${manner}|${manner})read\\s+about\\b`,
  ).test(text)
    || /^(?:do|would) you mind\s+reading\s+about\b/.test(text);
}

/** The semantic object of a direct source-inspection directive, if present. */
export function extractExplicitReadRequestObject(value: string): string | null {
  const text = clauseText(value, true);
  const sourceInspectionObject = new RegExp(
    `^(?:please\\s+|kindly\\s+)?${SOURCE_READ_DIRECTIVE_PATTERN}\\s+(.+)$`,
  ).exec(text)?.[1]?.trim() ?? "";
  return sourceInspectionObject
    || extractTypedReadPresentationObject(text)
    || null;
}

/** Parse the utterance boundary once, before individual domains inspect it. */
export function parseRoutingUtterance(
  value: string,
  options: ParseRoutingUtteranceOptions = {},
): RoutingUtterance {
  const surface = normalizeSpeechForRouting(markRoutingClauseBoundaries(value), {
    preserveEntityChars: true,
    preserveMathChars: true,
  });
  const addressed = surface.replace(householdRegex(String.raw`^(?:hey\s+)?{ASSISTANT}\b[\s,:]*`), "").trim();
  const split = splitLeadingDialoguePrefix(addressed);
  const dominantClause = selectDominantRoutingClause(split?.tail ?? addressed);
  const outerIndirectQuery = extractIndirectQueryComplement(dominantClause);
  const framedCore = stripOuterRequestFrame(dominantClause);
  const core = canonicalizeRoutingText(framedCore);
  const dialogueText = normalizeDialogueText(framedCore);
  const standaloneDialogueAct = split
    ? null
    : classifyStandaloneDialogueAct(dialogueText)
      ?? (options.hasSessionContext
        ? classifyContextualDialogueAct(dialogueText, options.contextFrameKinds ?? [])
        : null);
  const indirectQuery = outerIndirectQuery
    ?? extractIndirectQueryComplement(framedCore);
  const structuralNonReadFrame = !indirectQuery
    && (
      looksLikeDataMutationRequest(dominantClause)
      || (
        looksLikeSpeakerDirectedTaskFrame(
          canonicalizeCommonContractions(dominantClause),
        )
        && !looksLikeSpeakerDirectedReadRequest(
          canonicalizeCommonContractions(dominantClause),
        )
      )
    );
  const readWrappedQueryCore = (
    looksLikeSpeakerDirectedReadRequest(dominantClause)
    || looksLikeSpeakerDirectedReadRequest(framedCore)
  ) && new RegExp(String.raw`^${QUESTION_LEAD_PATTERN}\b`).test(core);
  const speechAct = standaloneDialogueAct
    ? "dialogue"
    : indirectQuery
      ? "query"
      : structuralNonReadFrame
        ? "command"
        : readWrappedQueryCore
          ? "query"
          : classifyRoutingSpeechAct(framedCore, /\?\s*$/.test(value));
  const semantics = buildRoutingSemantics({
    surface: addressed,
    coreSurface: framedCore,
    core,
    speechAct,
    indirectQuery,
  });
  return {
    raw: value,
    normalized: canonicalizeRoutingText(surface),
    coreSurface: framedCore.trim(),
    core,
    speechAct,
    dialogueAct: standaloneDialogueAct,
    dialogueResponsePolicy: standaloneDialogueAct
      ? responsePolicyForDialogueAct(dialogueText, standaloneDialogueAct)
      : null,
    dialoguePrefix: split?.act ?? null,
    resetBeforeCore: split?.act === "cancel",
    semantics,
  };
}

function buildRoutingSemantics(options: {
  readonly surface: string;
  readonly coreSurface: string;
  readonly core: string;
  readonly speechAct: RoutingSpeechAct;
  readonly indirectQuery: string | null;
}): RoutingSemantics {
  // "Can you tell me if..." is an indirect question from the current
  // speaker, not a report that somebody uttered its complement.
  // A report of the conversation itself outranks that reading: "do you
  // remember I asked you to..." asks about what was said.
  const frame = classifyMentionFrame(options.coreSurface);
  const mention = frame && (frame.priorConversation || !options.indirectQuery) ? frame : null;
  if (mention) {
    const mentionCore = canonicalizeRoutingText(mention.complement);
    return {
      use: "mention",
      force: options.speechAct === "query" ? "query" : "statement",
      authority: "none",
      embedding: mention.mode,
      world: classifyReferenceWorld(mention.complement),
      execution: "none",
      guards: [],
      coreSurface: mention.complement,
      core: mentionCore,
      embeddedForce: classifyRoutingSpeechAct(mention.complement),
      priorConversation: mention.priorConversation,
    };
  }
  const semanticCoreSurface = options.indirectQuery ?? options.coreSurface;
  const semanticCore = options.indirectQuery
    ? canonicalizeRoutingText(options.indirectQuery, {
      preserveLeadingAssistantSubject: true,
    })
    : options.core;
  const worldInput = (
    hasLeadingCourtesyGuard(options.surface)
    || looksLikeSpeakerDirectedReadRequest(options.surface)
    || looksLikeSpeakerDirectedReadRequest(options.coreSurface)
  )
    ? semanticCore
    : options.indirectQuery ?? options.surface;
  const world = looksLikeCurrentStatePlanningRead(options.surface, semanticCore)
    ? "actual"
    : classifyReferenceWorld(worldInput);
  const courtesy = isCourtesyConditionalDirective(options.surface, semanticCore);
  const conditionalDirective = options.speechAct === "command"
    && !courtesy
    && hasRealConditionalGuard(options.surface);
  const deferredDirective = options.speechAct === "command"
    && (/\s+(?:before|after|when|once|until)\s+/.test(semanticCore)
      || /^(?:before|after|when|once|until)\s+(?:i|we|you|he|she|they)\b/.test(options.surface));
  const execution: RoutingExecution = options.speechAct !== "command"
    ? "none"
    : conditionalDirective
      ? "conditional"
      : deferredDirective
        ? "deferred"
        : "immediate";
  const guards: RoutingGuard[] = [];
  if (courtesy) guards.push("courtesy");
  if (conditionalDirective) guards.push("condition");
  const embeddedNonReadTask = looksLikeEmbeddedNonReadTask(semanticCore)
    && !whHasPostposedModalAdjunct(semanticCore);
  const epistemicRead = looksLikeSpeakerEpistemicRead(options.surface);
  const typedReadPresentation =
    extractTypedReadPresentationObject(semanticCoreSurface) !== null;
  const taskKind = options.speechAct === "command"
    ? embeddedNonReadTask
      ? "control"
      : typedReadPresentation
        ? "read"
        : looksLikeDirectiveCore(semanticCore)
          ? "control"
          : looksLikeReadDirectiveCore(semanticCore)
            || looksLikeSpeakerDirectedReadRequest(semanticCoreSurface)
            ? "read"
            : "other"
    : options.speechAct === "query" || options.speechAct === "fragment"
      ? epistemicRead
        ? "read"
        : (
        looksLikeAdviceQuery(semanticCore)
        || embeddedNonReadTask
        )
          ? "other"
          : "read"
      : "other";
  return {
    use: "task",
    force: options.speechAct,
    authority: "speaker_direct",
    embedding: options.indirectQuery ? "indirect" : "direct",
    taskKind,
    world: options.speechAct === "command" && taskKind !== "read"
      ? "actual"
      : world,
    execution,
    guards: Object.freeze(guards),
    coreSurface: semanticCoreSurface,
    core: semanticCore,
  };
}

interface MentionFrame {
  readonly mode: "reported" | "quoted";
  readonly complement: string;
  readonly priorConversation: boolean;
}

function classifyMentionFrame(value: string): MentionFrame | null {
  const text = clauseText(value)
    .replace(/\s*[,;:]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;

  const priorReport = classifyPriorConversationReport(text);
  if (priorReport) {
    return { mode: "reported", complement: priorReport, priorConversation: true };
  }
  const frame = classifyUtteranceMentionFrame(text);
  return frame ? { ...frame, priorConversation: false } : null;
}

const PRIOR_CONVERSATION_MATRIX = "(?:(?:are|were) you aware(?: of the fact)?|(?:do|did|can|could) you (?:still )?(?:remember|recall|know)|you (?:remember|recall)|have you forgotten|did you forget|(?:(?:can|could|would|will) you )?(?:tell|remind) me)";
const PRIOR_CONVERSATION_REPORT_VERB = "(?:asked|told|mentioned|said|talked|spoke|discussed|raised|brought up|(?:was|were) (?:asking|telling|talking|saying|speaking|discussing)|(?:have|had) (?:asked|told|mentioned|said|talked|spoken|discussed|raised|brought up))";
const PRIOR_CONVERSATION_BASE_VERB = "(?:ask|asking|tell|telling|mention|say|saying|talk|talking|speak|speaking|discuss|discussing|raise|bring up|bringing up)";

/**
 * A question whose object is the conversation so far: an epistemic/memory
 * matrix over a report by the speaker's side ("are you aware that earlier I
 * asked you about X", "do you remember I asked you to X"), a yes/no question
 * about what the speaker said ("did I tell you X"), or a wh-question about it
 * ("what did we talk about"). Returns the reported content, or the whole
 * question when the report has no object.
 *
 * `either_side` also counts the assistant's own words and meaning ("what did you say
 * about X", "what did you mean by X", "what was the last thing you said").
 * Routing keeps those as reads, because code answers "what did you say about
 * the office lights" by reading the lights again (sem5000-0803); only the
 * read-agent wake asks the wider question (`asksAboutConversation`).
 */
function classifyPriorConversationReport(
  value: string,
  scope: "speaker_side" | "either_side" = "speaker_side",
): string | null {
  const text = value
    .replace(/\b(?:uh|um|erm)\b/g, " ")
    .replace(/[.?!]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const subject = "(?:i|we)";
  const participant = "(?:i|we|you)";
  const adverb = "(?:(?:already|just|ever|previously|earlier|once|also)\\s+)?";
  const whHead = `^(?:${PRIOR_CONVERSATION_MATRIX}\\s+)?(?:what|which|when|why|how|who)\\b(?:\\s+[a-z0-9'-]+){0,3}?`;
  const patterns: readonly RegExp[] = [
    new RegExp(`^${PRIOR_CONVERSATION_MATRIX}\\s+(?:(?:that|if|whether|when|how)\\s+)?(?:[a-z0-9'-]+\\s+){0,8}?${subject}\\s+${adverb}${PRIOR_CONVERSATION_REPORT_VERB}\\b\\s*(.*)$`),
    new RegExp(`^(?:did|have|had)\\s+${subject}\\s+${adverb}${PRIOR_CONVERSATION_BASE_VERB}\\b\\s*(.*)$`),
    new RegExp(`${whHead}\\s+(?:did|have|had|was|were)\\s+${subject}\\s+${adverb}${PRIOR_CONVERSATION_BASE_VERB}\\b\\s*(.*)$`),
    // A wh-question timed by a speech event in this conversation, the assistant's
    // own included: "what were the last two things before you said X"
    //.
    new RegExp(`^(?:what|which|who)\\b.*?\\b(?:before|after|when)\\s+${participant}\\s+${adverb}${PRIOR_CONVERSATION_REPORT_VERB}\\b\\s*(.*)$`),
    ...(scope === "either_side"
      ? [
          new RegExp(`${whHead}\\s+(?:did|have|had|was|were)\\s+you\\s+${adverb}${PRIOR_CONVERSATION_BASE_VERB}\\b\\s*(.*)$`),
          // Meaning is about an utterance in any tense: "what do you mean by
          // X". A bare "what do you mean?" is the answer-trace repair's.
          new RegExp(`${whHead}\\s+(?:do|did)\\s+${participant}\\s+${adverb}mean\\s+(\\S.*)$`),
          // Which thing a speech event was: "what was the last thing you
          // said". The noun phrase follows the copula directly, so a state
          // question with a relative clause ("what lights are on that I
          // asked about") stays a read.
          new RegExp(`^(?:what|which|who)\\s+(?:is|was|are|were)\\s+(?:[a-z0-9'-]+\\s+){1,5}?(?:that\\s+)?${participant}\\s+${adverb}${PRIOR_CONVERSATION_REPORT_VERB}\\b\\s*(.*)$`),
        ]
      : []),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const object = (match[1] ?? "")
      .replace(/^(?:(?:to|with)\s+)?(?:you|me|us)\b\s*/, "")
      .replace(/^(?:about|regarding|on|over|for|to|that|whether|if)\b\s*/, "")
      .replace(/(?:^|\s+)(?:earlier|before|previously|just now|last time|yesterday|today|(?:during|in) (?:this|our|the) (?:conversation|chat))(?:\s+(?:today|on|then))?$/, "")
      .trim();
    return object || text;
  }
  return null;
}

/**
 * Whether a question is about the conversation itself, the assistant's own words
 * and meaning included. The read agent cannot see the conversation, so it is
 * never woken for one ("what did you say about the water usage"
 * reached it as a water metric).
 */
export function asksAboutConversation(value: string): boolean {
  const text = clauseText(value)
    .replace(/\s*[,;:]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text !== "" && classifyPriorConversationReport(text, "either_side") !== null;
}

function classifyUtteranceMentionFrame(text: string): Omit<MentionFrame, "priorConversation"> | null {

  // A speaker-directed read request may have a temporal preface, but that
  // does not turn it into reported speech merely because it contains "tell".
  if (looksLikeSpeakerDirectedReadRequest(text)) return null;

  const example = /^(?:for|as) (?:an )?example\s+(.+)$/.exec(text);
  if (example?.[1] && looksLikeEmbeddedTaskClause(example[1])) {
    return { mode: "quoted", complement: example[1] };
  }
  const nominalCopular = new RegExp(`^(?:${QUOTED_HEAD_DETERMINER_PATTERN}\\s+)?(?:words?|phrase|sentence|quote|example|command|instruction)\\s+(?:is|was|were)\\s+(?:that\\s+|to\\s+)?(.+)$`).exec(text);
  if (nominalCopular?.[1] && looksLikeEmbeddedTaskClause(nominalCopular[1])) {
    return { mode: "quoted", complement: nominalCopular[1] };
  }
  const nominal = new RegExp(`^(?:${QUOTED_HEAD_DETERMINER_PATTERN}\\s+)?(?:words?|phrase|sentence|quote|example|command|instruction)\\b\\s+(.+)$`).exec(text);
  if (nominal?.[1] && looksLikeEmbeddedTaskClause(nominal[1])) {
    return { mode: "quoted", complement: nominal[1] };
  }
  const quotedImperative = /^(?:say|repeat|quote|read back)\b[\s,:-]*(.+)$/.exec(text);
  if (quotedImperative?.[1] && looksLikeEmbeddedTaskClause(quotedImperative[1])) {
    return { mode: "quoted", complement: quotedImperative[1] };
  }

  const reportVerb = "(?:say|says|said|ask|asks|asked|tell|tells|told|report|reports|reported|quote|quotes|quoted|repeat|repeats|repeated|write|writes|wrote|instruct|instructs|instructed|order|orders|ordered|request|requests|requested|mention|mentions|mentioned)";
  const active = new RegExp(`^(?:[a-z0-9][a-z0-9'_-]*(?:\\s+[a-z0-9][a-z0-9'_-]*){0,7})\\s+${reportVerb}\\b\\s+(.+)$`).exec(text);
  const activeComplement = active?.[1] ? extractReportedTaskComplement(active[1]) : "";
  if (activeComplement && looksLikeEmbeddedTaskClause(activeComplement)) {
    return { mode: "reported", complement: activeComplement };
  }

  const passive = /^(?:[a-z0-9][a-z0-9'_-]*(?:\s+[a-z0-9][a-z0-9'_-]*){0,5})\s+(?:am|is|are|was|were|have been|has been|had been)\s+(?:told|asked|instructed|quoted)\b\s*(?:that|to)?\s+(.+)$/.exec(text);
  if (passive?.[1] && looksLikeEmbeddedTaskClause(passive[1])) {
    return { mode: "reported", complement: passive[1] };
  }
  return null;
}

function looksLikeEmbeddedTaskClause(value: string): boolean {
  const text = value.replace(/^[\s,:-]+/, "").trim();
  if (new RegExp(`^(?:please\\s+)?${TASK_VERB_PATTERN}\\b`).test(text)) {
    return true;
  }
  const deviceSubject = new RegExp(`\\b(?:${HOUSE_QUERY_SIGNAL}|cabinets?|blinds?|shades?|curtains?|vacuum|speaker|television|tv|device)\\b`).test(text);
  const statePredicate = /\b(?:is|are|was|were|be|been)\s+(?:still\s+)?(?:on|off|open|closed|locked|unlocked|running|stopped|paused|active|inactive|home|away|lit|dark)\b/.test(text);
  return (deviceSubject && statePredicate) || looksLikeDirectiveCore(text);
}

function extractReportedTaskComplement(value: string): string {
  const text = value.trim();
  const candidates = [
    /^(?:that|to)\s+(.+)$/.exec(text)?.[1] ?? "",
    /^(?:[a-z0-9][a-z0-9'_-]*\s+){1,5}(?:that|to)\s+(.+)$/.exec(text)?.[1] ?? "",
    text,
  ];
  return candidates.find((candidate) => candidate && looksLikeEmbeddedTaskClause(candidate))?.trim() ?? "";
}

function extractIndirectQueryComplement(value: string): string | null {
  const text = canonicalizeCommonContractions(normalizeSpeechForRouting(value, {
    preserveEntityChars: true,
    preserveMathChars: true,
  }))
    .replace(/[.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const patterns: readonly RegExp[] = [
    /^(?:(?:can|could|would|will) you\s+)?(?:(?:please|kindly)\s+)?(?:find out|work out)\s+((?:what|where|who|when|which|how)\b.+)$/,
    /^(?:(?:please|kindly)\s+)?(?:remember|recall)\s+((?:what|where|who|when|which|how|if|whether)\b.+)$/,
    /^(?:tell(?: me)?|check|find out|work out|confirm) (?:if|whether)\s+(.+)$/,
    /^i (?:wonder|am wondering|was wondering|(?:would like|want|need) to know) (?:if|whether)\s+(.+)$/,
    /^i (?:am|was|have been) (?:curious|unsure|uncertain) (?:if|whether)\s+(.+)$/,
    /^(?:do|did|can|could|would) you (?:(?:happen|need|want) to )?(?:think|believe|reckon|know|see|remember|recall)\s+(?:(?:if|whether)\s+)?(.+)$/,
    /^(?:can|could|would|will) you (?:tell(?: me)?|check|find out|work out|confirm) (?:if|whether)\s+(.+)$/,
    /^(?:do you have |have you got )?any idea (?:if|whether)\s+(.+)$/,
    /^(?:would|could) you have any idea (?:if|whether)\s+(.+)$/,
  ];
  for (const pattern of patterns) {
    const complement = pattern.exec(text)?.[1]?.trim() ?? "";
    if (complement) return complement;
  }
  return null;
}

function classifyReferenceWorld(value: string): RoutingReferenceWorld {
  const text = clauseText(value);
  if (looksLikeObservedTrendProjection(text)) {
    return "actual";
  }
  if (/^what if\b/.test(text)
    || (
      /\b(?:would|could|might|will)\b/.test(text)
      && /\b(?:if|were)\b/.test(text)
    )
    || /^(?:had|were|should)\s+(?:i|we|you|he|she|they)\b.+\b(?:would|could|might|will)\b/.test(text)) {
    return "counterfactual";
  }
  if (looksLikeSpeakerEpistemicRead(text)) {
    return "actual";
  }
  if (/\b(?:would|could|might)\s+(?:[a-z][a-z'-]*\s+){0,6}have\s+[a-z][a-z'-]*\b/.test(text)) {
    return "counterfactual";
  }
  if (/\b(?:would|could|might)\s+(?:not\s+)?(?:[a-z][a-z'-]*\s+){0,8}(?:be|remain|stay|happen|help|work|fix|change|use|draw|consume|produce|generate)\b/.test(text)) {
    return "hypothetical";
  }
  if (whModalScopesRootClause(text)) {
    return "hypothetical";
  }
  if (/^(?:would|could|might|will)\b.+\bbe\s+(?:on|off|open|closed|locked|unlocked|running|stopped|paused|active|inactive|home|away|lit|dark)\b/.test(text)) {
    return "hypothetical";
  }
  if (/^(?:suppose|supposing|imagine|imagining|assume|assuming|hypothetically|maybe|perhaps|possibly|if)\b/.test(text)
    || /^i (?:wish|hope)\b/.test(text)) {
    return "hypothetical";
  }
  return "actual";
}

/**
 * A projection can be sourced from the observed rate without asserting a
 * hypothetical device state. Keep that distinct from counterfactual
 * questions such as "what would this light use if it were on?"
 */
function looksLikeObservedTrendProjection(text: string): boolean {
  const asksProjectedOutcome = /^(?:what|where|when|how much)\b/.test(text)
    && /\bwill\b/.test(text)
    && /\b(?:finish|end up|land|reach|total|come to)\b/.test(text);
  const holdsObservedTrendConstant = /\bif\s+(?:this|that|things?|the (?:current )?(?:rate|trend|pace))\s+(?:keeps? (?:going|up)|continues?|carries on|stays? (?:the same|steady)|remains? (?:the same|steady))\b/.test(text);
  return asksProjectedOutcome && holdsObservedTrendConstant;
}

/**
 * A modal inside a postposed relative or purpose clause does not move the
 * main question out of the actual world:
 * "Which lights are on that I could switch off?"
 *
 * Root-clause modals precede the finite auxiliary of a WH question (or are
 * that auxiliary). A later modal belongs to an embedded clause, so current
 * state tools remain admissible for the main predicate.
 */
function whModalScopesRootClause(text: string): boolean {
  if (!/^(?:what|which|who|when|where|why|how)\b/.test(text)) {
    return false;
  }
  const modalIndex = text.search(/\b(?:would|could|might)\b/);
  if (modalIndex < 0) {
    return false;
  }
  const finiteAuxiliaryIndex = text.search(/\b(?:am|is|are|was|were|do|does|did|has|have|had)\b/);
  return finiteAuxiliaryIndex < 0 || modalIndex < finiteAuxiliaryIndex;
}

function whHasPostposedModalAdjunct(text: string): boolean {
  if (!/^(?:what|which|who|when|where|why|how)\b/.test(text)) {
    return false;
  }
  const modalIndex = text.search(/\b(?:would|could|might)\b/);
  const finiteAuxiliaryIndex = text.search(/\b(?:am|is|are|was|were|do|does|did|has|have|had)\b/);
  if (modalIndex < 0 || finiteAuxiliaryIndex < 0 || finiteAuxiliaryIndex > modalIndex) {
    return false;
  }
  const preModalClause = text.slice(finiteAuxiliaryIndex, modalIndex);
  return /\b(?:that|which|who|so(?: that)?|because)\b/.test(preModalClause);
}

/**
 * A conditional personal plan can still ask for the house's current state:
 * "If I left now, which doors would I be leaving open?" The condition changes
 * the speaker's plan, not the truth time of the device predicate.
 */
function looksLikeCurrentStatePlanningRead(surface: string, core: string): boolean {
  const text = clauseText(surface);
  const personalCondition = /\bif\s+(?:i|we)\b/.test(text);
  if (!personalCondition) return false;
  if (!/\b(?:leave|left|go|went|head|headed|depart|departed|turn in|turned in|go to bed|went to bed)\b/.test(text)) {
    return false;
  }
  const persistentStateProjection =
    /\bwould (?:(?:i|we) be (?:leaving|keeping)|(?:still )?(?:remain|stay|be))\b/.test(core);
  return /^(?:which|what|how many)\b/.test(core)
    && /\b(?:lights?|lighting|lamps?|outlets?|switch(?:es)?|locks?|doors?|windows?|gates?|garage|heaters?|fans?|devices?)\b/.test(core)
    && persistentStateProjection
    && /\b(?:on|off|open|closed|locked|unlocked|running|stopped|lit|dark)\b/.test(core);
}

function looksLikeSpeakerDirectedReadRequest(text: string): boolean {
  const requestManner = "(?:(?:please|possibly|kindly)\\s+)*";
  if (looksLikeReadAcquisitionRequest(text)) {
    return true;
  }
  if (extractTypedReadPresentationObject(text)) {
    return true;
  }
  if (new RegExp(`^(?:can|could|would|will) (?:you|we|i)\\s+${requestManner}${READ_DIRECTIVE_PATTERN}\\b`).test(text)) {
    return true;
  }
  if (new RegExp(`^(?:is|was|would|could) it (?:at all )?possible(?: for (?:you|us|me))? to\\s+${READ_DIRECTIVE_PATTERN}\\b`).test(text)) {
    return true;
  }
  if (new RegExp(`^(?:do|would) you mind\\s+${READ_DIRECTIVE_GERUND_PATTERN}\\b`).test(text)) {
    return true;
  }
  if (new RegExp(`^(?:how|what) about\\s+${READ_DIRECTIVE_GERUND_PATTERN}\\b`).test(text)) {
    return true;
  }
  if (new RegExp(`^(?:can|could|would|will|should)\\s+.+\\s+(?:be|get)\\s+${READ_DIRECTIVE_PARTICIPLE_PATTERN}\\b`).test(text)) {
    return true;
  }
  return new RegExp(`^(?:(?:before|after|when|once|until)\\b.{1,80}\\s+)?(?:(?:please|kindly|only|just)\\s+)*${READ_DIRECTIVE_PATTERN}\\b`).test(text);
}

function looksLikeReadAcquisitionRequest(text: string): boolean {
  const requestFrame = "(?:(?:can|could|would|will) (?:you|we|i)\\s+)?(?:(?:please|possibly|kindly)\\s+)*";
  const recipient = "(?:(?:me|us)\\s+)?";
  const objectLedSource = new RegExp(
    `^${requestFrame}${READ_ACQUISITION_VERB_PATTERN}\\s+${recipient}${READ_ACQUISITION_OBJECT_PATTERN}\\s+(?:from|of)\\s+\\S`,
  );
  const sourceToken = "[a-z0-9][a-z0-9'_-]*";
  const typedValue = "(?:reading|readings|state|status|value|values|result|results|measurement|measurements)";
  const readOnlyTail = `(?:\\s+(?:${NOW_PATTERN}|again|please|for me|for us))*[?.!]*$`;
  const sourceLedValue = new RegExp(
    `^${requestFrame}${READ_ACQUISITION_VERB_PATTERN}\\s+${recipient}(?:(?:a|an|the|this|that|current|live|latest|new)\\s+)*(?:${sourceToken}\\s+){1,8}${typedValue}${readOnlyTail}`,
  );
  return objectLedSource.test(text) || sourceLedValue.test(text);
}

/**
 * "Show/give [me] <information>" and discourse selections such as
 * "finish with <information>" are the same read act when the complement is a
 * typed HA result noun. The payload grammar, rather than the exact wording,
 * keeps pictures, advice, how-to requests, mutations, and device controls out.
 */
function extractTypedReadPresentationObject(value: string): string | null {
  const text = clauseText(value, true);
  const match = new RegExp(
    `^(?:(?:please|kindly|just)\\s+)*(?:(${INFORMATION_PRESENTATION_VERB_PATTERN})|(${DISCOURSE_READ_SELECTION_PATTERN}))\\s+(.+)$`,
  ).exec(text);
  const presentationVerb = match?.[1]?.trim() ?? "";
  const object = match?.[3]?.trim() ?? "";
  if (!object || !looksLikeTypedReadResultObject(object, presentationVerb)) {
    return null;
  }
  return object;
}

function looksLikeTypedReadResultObject(
  value: string,
  presentationVerb: string,
): boolean {
  const object = value
    .replace(/\s+(?:please|for me|for us)$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!object
    || /^(?:about|how|why)\b/.test(object)
    || /\b(?:advice|instructions?|tutorial|picture|photo|image|video|story|poem|joke)\b/.test(object)) {
    return false;
  }
  if (new RegExp(`\\b(?:${DEVICE_CONTROL_GERUND_PATTERN}|${DATA_MUTATION_GERUND_PATTERN}|${DEVICE_CONTROL_PARTICIPLE_PATTERN}|${DATA_MUTATION_PARTICIPLE_PATTERN})\\b`).test(object)
    || new RegExp(`^(?:${DEVICE_CONTROL_VERB_PATTERN}|${DATA_MUTATION_VERB_PATTERN})\\b`).test(object)
    || /\b(?:on|off|open|closed|locked|unlocked|running|stopped|paused)\s+(?:state|setting|mode)\b/.test(object)) {
    return false;
  }
  if (/^give\b/.test(presentationVerb)
    && /\b(?:power|electricity|water|gas)$/.test(object)
    && !/\b(?:current|live|latest|present|now|today|tonight|yesterday|reading|value|status|usage|consumption|draw|load|total|average|mean|minimum|maximum|min|max|top|bottom|highest|lowest|most|least)\b/.test(object)) {
    return false;
  }
  const trailingTime = `(?:\\s+(?:${NOW_PATTERN}|today|tonight|yesterday))?`;
  return new RegExp(`\\b${TYPED_READ_RESULT_HEAD_PATTERN}${trailingTime}$`).test(object);
}

function looksLikeSpeakerDirectedTaskFrame(text: string): boolean {
  if (containsNestedNonReadModalPredicate(text)) {
    return true;
  }
  if (looksLikeSpeakerDirectedReadRequest(text)) {
    return false;
  }
  return /^(?:can|could|would|will) (?:you|we|i)\s+(?:(?:please|possibly|kindly)\s+)*(?:[a-z][a-z'-]*)(?:\s|$)/.test(text)
    || /^(?:is|was|would|could)\s+[a-z][a-z'-]*ing\b.{0,160}\bpossible\b/.test(text)
    || /^(?:(?:is|was) it|(?:would|could) it be) (?:at all )?possible(?: for (?:you|us|me))? to\s+[a-z][a-z'-]*\b/.test(text)
    || /^(?:(?:is|was) there|(?:would|could) there be) (?:any|a) way(?: for (?:you|us|me))? to\s+[a-z][a-z'-]*\b/.test(text)
    || /^(?:do|would) you mind\s+[a-z][a-z'-]*ing\b/.test(text)
    || /^(?:how|what) about\s+[a-z][a-z'-]*ing\b/.test(text)
    || /^why (?:do not (?:you|we)|not)\s+[a-z][a-z'-]*\b/.test(text)
    || /^(?:can|could|would|will|should)\s+.+\s+(?:be|get)\s+(?:[a-z][a-z'-]*\s+){0,2}[a-z][a-z'-]*(?:ed|en|t)\b/.test(text)
    || /^(?:please\s+|go ahead(?: and)?\s+|i (?:want|need) you to\s+|i would like you to\s+)[a-z][a-z'-]*\b/.test(text);
}

function looksLikeEmbeddedNonReadTask(text: string): boolean {
  const normalized = canonicalizeCommonContractions(text)
    .replace(/[?.!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (looksLikeSpeakerDirectedTaskFrame(normalized)
    || looksLikeDataMutationRequest(normalized)
    || containsEmbeddedDeviceControlDirective(normalized)) {
    return true;
  }
  return containsNonReadModalPredicate(normalized);
}

function containsEmbeddedDataMutationDirective(text: string): boolean {
  const modalSubject =
    "(?:[a-z0-9][a-z0-9'_-]*|[a-z0-9][a-z0-9'_-]*\\s+s\\s+[a-z0-9][a-z0-9'_-]*(?:\\s+[a-z0-9][a-z0-9'_-]*){0,2}|(?:the|a|an|this|that|these|those|my|your|our|their)\\s+[a-z0-9][a-z0-9'_-]*(?:\\s+[a-z0-9][a-z0-9'_-]*){0,3})";
  const modalActive = new RegExp(
    `(?:^|\\b(?:if|whether|that|and|or|then)\\s+)${modalSubject}\\s+(?:can|could|would|will|should|may|might)\\s+${DATA_MUTATION_VERB_PATTERN}\\b`,
  );
  const modalQuestion = new RegExp(
    `^(?:can|could|would|will|should|may|might)\\s+${modalSubject}\\s+${DATA_MUTATION_VERB_PATTERN}\\b`,
  );
  const modalPassive = new RegExp(
    `\\b(?:can|could|would|will|should|may|might|must)\\s+(?:possibly\\s+)?be\\s+${DATA_MUTATION_PARTICIPLE_PATTERN}\\b`,
  );
  const gerundPossibility = new RegExp(
    `(?:^|\\b)${DATA_MUTATION_GERUND_PATTERN}\\b.{0,160}\\b(?:is|are|was|were|would be|could be)\\s+(?:at all )?(?:possible|allowed|permitted)\\b`,
  );
  const infinitivePossibility = new RegExp(
    `\\b(?:any|a|some)\\s+way\\b.{0,120}\\bto\\s+${DATA_MUTATION_VERB_PATTERN}\\b`,
  );
  const instructionalInfinitive = new RegExp(
    `\\b(?:how|whether)\\s+to\\s+${DATA_MUTATION_VERB_PATTERN}\\b`,
  );
  const coordinated = new RegExp(
    `\\b(?:and|then|also)\\s+(?:(?:please|kindly)\\s+)?${DATA_MUTATION_VERB_PATTERN}\\b`,
  );
  return modalActive.test(text)
    || modalQuestion.test(text)
    || modalPassive.test(text)
    || gerundPossibility.test(text)
    || infinitivePossibility.test(text)
    || instructionalInfinitive.test(text)
    || coordinated.test(text);
}

function containsEmbeddedDeviceControlDirective(text: string): boolean {
  const modalSubject =
    "(?:[a-z0-9][a-z0-9'_-]*|[a-z0-9][a-z0-9'_-]*\\s+s\\s+[a-z0-9][a-z0-9'_-]*(?:\\s+[a-z0-9][a-z0-9'_-]*){0,2}|(?:the|a|an|this|that|these|those|my|your|our|their)\\s+[a-z0-9][a-z0-9'_-]*(?:\\s+[a-z0-9][a-z0-9'_-]*){0,3})";
  const modalActive = new RegExp(
    `(?:^|\\b(?:if|whether|that|and|or|then)\\s+)${modalSubject}\\s+(?:can|could|would|will|should|may|might)\\s+${DEVICE_CONTROL_VERB_PATTERN}\\b`,
  );
  const modalQuestion = new RegExp(
    `^(?:can|could|would|will|should|may|might)\\s+${modalSubject}\\s+${DEVICE_CONTROL_VERB_PATTERN}\\b`,
  );
  const modalPassive = new RegExp(
    `\\b(?:can|could|would|will|should|may|might|must)\\s+(?:possibly\\s+)?be\\s+${DEVICE_CONTROL_PARTICIPLE_PATTERN}\\b`,
  );
  const gerundPossibility = new RegExp(
    `(?:^|\\b)${DEVICE_CONTROL_GERUND_PATTERN}\\b.{0,160}\\b(?:is|are|was|were|would be|could be)\\s+(?:at all )?(?:possible|allowed|permitted)\\b`,
  );
  const infinitivePossibility = new RegExp(
    `\\b(?:any|a|some)\\s+way\\b.{0,120}\\bto\\s+${DEVICE_CONTROL_VERB_PATTERN}\\b`,
  );
  const instructionalInfinitive = new RegExp(
    `\\b(?:how|whether)\\s+to\\s+${DEVICE_CONTROL_VERB_PATTERN}\\b`,
  );
  const coordinated = new RegExp(
    `\\b(?:and|then|also)\\s+(?:(?:please|kindly)\\s+)?${DEVICE_CONTROL_VERB_PATTERN}\\b`,
  );
  return modalActive.test(text)
    || modalQuestion.test(text)
    || modalPassive.test(text)
    || gerundPossibility.test(text)
    || infinitivePossibility.test(text)
    || instructionalInfinitive.test(text)
    || coordinated.test(text);
}

function containsNestedNonReadModalPredicate(text: string): boolean {
  const marker = /\b(?:if|whether|checking|confirming|verifying|finding out|working out)\b/.exec(text);
  return marker
    ? containsNonReadModalPredicate(text.slice(marker.index + marker[0].length))
    : false;
}

function containsNonReadModalPredicate(text: string): boolean {
  for (const match of text.matchAll(
    /\b(?:i|we|you|he|she|they)\s+(?:can|could|would|will|should)\s+([a-z][a-z'-]*(?:\s+out)?)/g,
  )) {
    const predicate = match[1] ?? "";
    if (
      predicate
      && !/^(?:and|or|if|whether|then|please|possibly|kindly)$/.test(predicate)
      && !new RegExp(`^${READ_DIRECTIVE_PATTERN}\\b`).test(predicate)
    ) {
      return true;
    }
  }
  return false;
}

function looksLikeSpeakerEpistemicRead(text: string): boolean {
  const match = new RegExp(
    `^(?:what|which|who|where|when|how(?:\\s+(?:much|many))?)\\s+(?:would|could|might) you\\s+(?:say|tell me|show me|report|estimate|reckon|think|believe|know|find out|work out|describe|explain|summari[sz]e|identify|assess)\\b\\s*(.*)$`,
  ).exec(text);
  const complement = match?.[1]?.trim() ?? "";
  return match !== null
    && !/\b(?:would|could|might)\b/.test(complement)
    && !/\b(?:if|were)\b/.test(complement);
}

function isCourtesyConditionalDirective(surface: string, core: string): boolean {
  const text = clauseText(surface);
  const conditionalCourtesy = new RegExp(`^${COURTESY_GUARD_PATTERN}\\b`).test(text);
  const modalCourtesy = new RegExp(`^(?:can|could|would|will) you\\s+${REQUEST_MANNER_PATTERN}(?=${DEVICE_CONTROL_VERB_PATTERN}\\b)`).test(text);
  return (conditionalCourtesy || modalCourtesy) && looksLikeDirectiveCore(core);
}

function hasLeadingCourtesyGuard(value: string): boolean {
  const text = clauseText(value);
  return new RegExp(`^${COURTESY_GUARD_PATTERN}\\b`).test(text);
}

function looksLikeAdviceQuery(value: string): boolean {
  const text = value.replace(/\s+/g, " ").trim();
  if (looksLikeQuantitativeConstraintQuery(text)) return false;
  if (/\b(?:should|ought to|had better)\b/.test(text)) return true;
  if (/^how (?:do|can|could|would|should) (?:i|we|you|someone)\b/.test(text)
    || /^what (?:is|would be) (?:the )?(?:best |right |proper )?way to\b/.test(text)) {
    return true;
  }
  const evaluativePredicate = "(?:good|bad|wise|unwise|sensible|insensible|safe|unsafe|advisable|inadvisable|better|worse)";
  return new RegExp(`\\b(?:is|are|be|being|seem|seems|seemed)\\s+(?:a\\s+)?${evaluativePredicate}(?:\\s+(?:idea|choice|move))?\\b`).test(text);
}

/**
 * "How much should we average to stay under the allowance?" asks for a
 * scalar constrained by sourced values. The modal expresses the constraint,
 * not open-ended advice.
 */
function looksLikeQuantitativeConstraintQuery(text: string): boolean {
  const quantitativeLead = /^(?:how (?:much|many)|what (?:amount|quantity|rate|average|total))\b/.test(text);
  const modal = /\b(?:should|can|could|may)\b/.test(text);
  const scalar = /\b(?:average|amount|quantity|rate|total|per (?:day|week|month)|daily|weekly|monthly)\b/.test(text);
  const constraint = /\b(?:allowance|budget|limit|cap|target|remaining|left|under|within|over)\b/.test(text);
  return quantitativeLead && modal && scalar && constraint;
}

function looksLikeDirectiveCore(value: string): boolean {
  const text = value
    .replace(/\s+/g, " ")
    .replace(/\s+(?:please|for me)$/, "")
    .replace(/\s+(?:everywhere|around (?:the )?(?:house|home))$/, "")
    .trim();
  if (new RegExp(`^(?:please\\s+)?${DEVICE_CONTROL_VERB_PATTERN}\\b`).test(text)) return true;
  if (looksLikeDataMutationRequest(text)) return true;
  if (/^try (?:to )?(?:turn|switch|toggle|set|make|open|close|shut|lock|unlock|enable|disable|start|stop|pause|resume|dock|raise|lower|power\s+(?:up|down)|turning|switching|toggling|setting|opening|closing|locking|unlocking)\b/.test(text)) {
    return true;
  }
  return new RegExp(String.raw`\b${DEVICE_CONTROL_PATTERN}\s+(?:on|off|open|closed|locked|unlocked|running|stopped|paused|dark|lit)$`).test(text);
}

function looksLikeReadDirectiveCore(value: string): boolean {
  return new RegExp(`^${READ_DIRECTIVE_PATTERN}\\b`).test(value)
    || extractTypedReadPresentationObject(value) !== null;
}

function hasRealConditionalGuard(value: string): boolean {
  const text = canonicalizeCommonContractions(normalizeSpeechForRouting(value, {
    preserveEntityChars: true,
  }))
    .replace(/\s+/g, " ")
    .trim();
  const guard = new RegExp(`(?:^|\\s)${CONDITION_GUARD_PATTERN}\\b`);
  return guard.test(text);
}

/** Routing text of a phrase: speech-normalised (entity characters kept), then canonicalised. */
export function normalizeRoutingText(value: string): string {
  return canonicalizeRoutingText(normalizeSpeechForRouting(value, { preserveEntityChars: true }));
}

/** As `normalizeRoutingText`, also keeping measurement characters (°, %, /). */
export function normalizeMeasuredRoutingText(value: string): string {
  return canonicalizeRoutingText(normalizeSpeechForRouting(value, {
    preserveEntityChars: true,
    preserveMeasurementChars: true,
  }));
}

const targetKeyMemo = new TextMemo();

/** A spoken target as status code compares it: status filler, the/my and a trailing "sensor(s)" dropped. */
export function targetTextKey(value: string): string {
  return targetKeyMemo.get(value) ?? targetKeyMemo.set(value, stripStatusFiller(normalizeMeasuredRoutingText(value))
    .replace(/\b(the|my)\b/g, " ")
    .replace(/\bsensors?\b$/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

/** A status question without its conversational and "if/whether" lead-ins. */
export function normalizeQuestionLeadIn(normalized: string): string {
  return rewriteTrailingQuestionCopula(stripConversationalLeadIns(normalized, { stripConditionalStatusLeadIns: true }))
    .replace(/^(?:if|whether)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// One cache per option combination, keyed by the raw text itself.
const routingTextMemos = Array.from({ length: 4 }, () => new TextMemo());

export function canonicalizeRoutingText(
  value: string,
  options: RoutingLeadInOptions = {},
): string {
  const memo = routingTextMemos[
    (options.stripConditionalStatusLeadIns ? 1 : 0) | (options.preserveLeadingAssistantSubject ? 2 : 0)
  ] as TextMemo;
  return memo.get(value) ?? memo.set(value, canonicalizeRouting(value, options));
}

function canonicalizeRouting(value: string, options: RoutingLeadInOptions): string {
  let text = canonicalizeCommonContractions(value)
    .replace(/\.(?=\s|$)/g, " ")
    .replace(/\b(?:uh|um)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (let index = 0; index < 8; index += 1) {
    const next = rewriteTrailingQuestionCopula(
      canonicalizeLeadingQuestionContractions(
        rewriteBareQueryLeadIns(
          stripConversationalLeadIns(
            canonicalizeLeadingQuestionContractions(text),
            options,
          ),
        ),
      ),
    ).replace(/\s+/g, " ").trim();
    if (next === text) {
      break;
    }
    text = next;
  }
  return text;
}

export function stripConversationalLeadIns(value: string, options: RoutingLeadInOptions = {}): string {
  let text = canonicalizeLeadingQuestionContractions(value)
    .replace(/^[^a-z0-9]+/g, " ")
    .replace(/\b(show me|tell me|give me)\s+me\b/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  text = unwrapRecognizedRequestFrame(text);
  const patterns: readonly RegExp[] = [
    ...(options.preserveLeadingAssistantSubject
      ? []
      : [householdRegex(String.raw`^(?:hey\s+{ASSISTANT}|{ASSISTANT})\b[\s,]*`, "g")]),
    new RegExp(`^(?:please|just checking|just|quick(?: one| check)?|right|okay|ok|mate|${COURTESY_GUARD_PATTERN}|for me)\\b[\\s,]*`, "g"),
    /^(?:well|alright|righto)\b[\s,]*/g,
    /^(?:can you answer this|answer this)\b[:\s,]*/g,
    /^(?:can you|could you|would you)\b[\s,]*/g,
    /^(?:go ahead(?: and)?|go on(?: and)?)\b[\s,]*/g,
    /^(?:check|tell me|show me|give me|let me know)\s+(?=(?:what|whats|how|where|who|which|is|are|do|does|did|can|could|would|should|has|have)\b)/g,
    new RegExp(`^confirm(?:\\s+please)?\\b(?=\\s+${ACTION_COMMAND_PATTERN}\\b)[\\s,]*`, "g"),
    ...(options.stripConditionalStatusLeadIns
      ? [/^(?:check|tell me|show me|give me|let me know)(?: if| whether)\s+/g]
      : []),
  ];
  for (let index = 0; index < 8; index += 1) {
    let next = text;
    for (const pattern of patterns) {
      next = next.replace(pattern, "");
    }
    next = next.replace(/\s+/g, " ").trim();
    if (next === text) {
      break;
    }
    text = next;
  }
  return text;
}

function classifyRoutingSpeechAct(value: string, questionPunctuation = false): Exclude<RoutingSpeechAct, "dialogue"> {
  const structuralText = canonicalizeCommonContractions(normalizeSpeechForRouting(value, {
    preserveEntityChars: true,
    preserveMathChars: true,
  }))
    .replace(/^[^a-z0-9]+/g, "")
    .replace(/[.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const speakerDirectedRead = looksLikeSpeakerDirectedReadRequest(structuralText);
  if (hasNonAssertiveRoutingFrame(structuralText) && !speakerDirectedRead) {
    return questionPunctuation
      || /^(?:what|which|who|when|where|why|how)\b/.test(structuralText)
      ? "query"
      : "statement";
  }
  if (looksLikeDataMutationRequest(structuralText)
    || looksLikeSpeakerDirectedTaskFrame(structuralText)) {
    return "command";
  }
  if (speakerDirectedRead) {
    return "command";
  }
  const text = canonicalizeRoutingText(value)
    .replace(/\b(?:please|for me)\b$/g, "")
    .trim();
  if (!text) {
    return "fragment";
  }
  if (looksLikeExistentialStateQuery(text)) {
    return "query";
  }
  if (looksLikeNominalStatusFragment(text)) {
    return "fragment";
  }
  if (looksLikeNominalMetricReadFragment(text)) {
    return "fragment";
  }
  const modalControl = new RegExp(`^(?:(?:can|could|would|will) you\\s+)+${REQUEST_MANNER_PATTERN}(?:(?:go ahead and|confirm)\\s+)?${DEVICE_CONTROL_VERB_PATTERN}\\b`).test(text);
  const attemptedControl = /^try (?:to )?(?:turn|switch|toggle|set|make|open|close|shut|lock|unlock|enable|disable|start|stop|pause|resume|dock|raise|lower|power\s+(?:up|down)|turning|switching|toggling|setting|opening|closing|locking|unlocking)\b/.test(text);
  const separablePowerControl = /^(?:(?:can|could|would|will) you\s+)?(?:please\s+)?power\s+.+\s+(?:up|down)$/.test(text);
  if (modalControl
    || attemptedControl
    || separablePowerControl
    || new RegExp(`^(?:please )?${DEVICE_CONTROL_VERB_PATTERN}\\b`).test(text)
    || new RegExp(`^(?:i (?:need|want)(?: you)?(?: to| to have)?|i would like you to) ${DEVICE_CONTROL_VERB_PATTERN}\\b`).test(text)) {
    return "command";
  }
  // Main-verb "have" before a determiner is an imperative ("have a look"),
  // not an auxiliary opening a question, unless it is asked as one.
  if (!questionPunctuation && /^have (?:a|an|some|fun)\b/.test(text)) {
    return "statement";
  }
  if (new RegExp(String.raw`^${QUESTION_LEAD_PATTERN}\b`).test(text)) {
    return "query";
  }
  if (questionPunctuation && !new RegExp(`^(?:please )?${DEVICE_CONTROL_VERB_PATTERN}\\b`).test(text)) {
    return "query";
  }
  const scopedControlText = text.replace(/\s+(?:everywhere|around (?:the )?(?:house|home))$/, "");
  const terminalStateCommand = new RegExp(
    `^(?:i (?:need|want)(?: to have)? )?((?:the |my |our )?[a-z0-9 ._-]+) (on|off|open|closed|locked|unlocked|running|stopped|paused|dark|lit)$`,
  ).exec(scopedControlText);
  const terminalStateTarget = terminalStateCommand?.[1] ?? "";
  if (!/^(?:back|return|go back|report|read|list|tell|show|give|check|confirm)\b/.test(scopedControlText)
    && terminalStateCommand
    && !/\b(?:is|are|was|were|be|been|being)$/.test(terminalStateTarget)
    && /\b(?:lights?|lighting|lamps?|cabinets?|outlets?|switch(?:es)?|locks?|doors?|windows?|gates?|garage|heaters?|fans?|vacuums?|computers?|devices?)\b/.test(terminalStateTarget)) {
    return "command";
  }
  if (new RegExp(`^(?:${TASK_VERB_PATTERN})\\b`).test(text)) {
    return "command";
  }
  return text.split(/\s+/).length <= 3 ? "fragment" : "statement";
}

function looksLikeExistentialStateQuery(text: string): boolean {
  const existentialSubject = /^(?:any|anything|any of (?:the|my|our))\b/.test(text);
  const statePredicate = /\b(?:on|off|open|closed|locked|unlocked|running|stopped|paused)$/.test(text);
  return existentialSubject && statePredicate;
}

function looksLikeNominalStatusFragment(text: string): boolean {
  return new RegExp(`\\b${HOUSE_QUERY_SIGNAL}\\b`).test(text)
    && /\b(?:status|state|reading)$/.test(text)
    && !/\b(?:is|are|was|were|be|been|being)\b/.test(text)
    && !new RegExp(`^(?:${TASK_VERB_PATTERN})\\b`).test(text);
}

/**
 * Voice input often drops both punctuation and a question auxiliary. A
 * bounded, verbless metric noun phrase still denotes a read when it carries
 * an aggregation/comparison/time slot; ordinary assertions keep statement
 * force.
 */
function looksLikeNominalMetricReadFragment(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 12) {
    return false;
  }
  if (/\b(?:am|is|are|was|were|be|been|being|do|does|did|has|have|had|will|would|could|might|should)\b/.test(text)) {
    return false;
  }
  const metric = /\b(?:temperature|temp|power|electricity|energy|usage|consumption|load|watts?|kw|kwh|solar|grid|battery|water|gas|import|export)\b/.test(text);
  const readSlot = /\b(?:average|mean|minimum|maximum|min|max|total|net|balance|import|export|usage|consumption|today|yesterday|tonight|week|month|year|versus|vs|after|before)\b/.test(text);
  return metric
    && readSlot
    && new RegExp(`\\b${HOUSE_QUERY_SIGNAL}\\b`).test(text);
}

// Clause boundaries after a comma are decided by closed-class grammar only
//. A question after a comma
// puts the verb before its subject: an auxiliary then a pronoun, determiner
// or capitalised proper noun ("is it raining", "is Sam home"); otherwise the
// auxiliary continues the sentence ("the model, which is you, is not able
// to"). A wh-word straight before a third-person pronoun is a relative or
// embedded clause in statement order ("an artwork, where it will look like
// a photo frame"); I/you/we stay splittable for "how you going". "Which"
// before an auxiliary, a pronoun or an -ly adverb is a relative pronoun
// ("..., which is usually due to a power out"); before a noun it asks
// ("..., which lights are on").
const WH_WORDS = new Set(["what", "who", "when", "where", "why", "how"]);
const THIRD_PERSON_SUBJECTS = new Set(["it", "he", "she", "they", "this", "that", "these", "those", "there"]);
const AUXILIARIES = new Set(["is", "are", "was", "were", "do", "does", "did", "has", "have", "had", "can", "could", "would", "will", "should", "might", "may", "must", "s"]);
const PERSONAL_PRONOUNS = new Set(["i", "you", "we", "they", "he", "she", "it"]);
const SUBJECT_HEADS = new Set([
  ...PERSONAL_PRONOUNS,
  "there", "the", "a", "an", "my", "your", "our", "his", "her", "their", "this", "that", "these", "those",
  "any", "anyone", "anything", "anybody", "someone", "something", "everyone", "everything",
]);
const QUESTION_AUXILIARIES = new Set(["is", "are", "was", "were", "do", "does", "did", "has", "have", "can", "could", "would", "will", "should"]);
const CLAUSE_TASK_VERB = new RegExp(`^(?:${TASK_VERB_PATTERN})\\b`, "iu");

function commaStartsClause(rest: string): boolean {
  const text = rest.replace(/^\s*(?:(?:only|just)\s+)?/iu, "");
  const [firstRaw = "", secondRaw = ""] = text.split(/\s+/u, 2).map((word) => word.replace(/[^\p{L}'’]+$/u, ""));
  const contracted = /['’]s$/u.test(firstRaw);
  const first = firstRaw.toLowerCase().replace(/['’]s$/u, "");
  const second = secondRaw.toLowerCase();
  if (WH_WORDS.has(first)) {
    // "what's it doing": the verb already precedes the subject.
    return contracted || !THIRD_PERSON_SUBJECTS.has(second);
  }
  if (first === "which") {
    return !(contracted || AUXILIARIES.has(second) || PERSONAL_PRONOUNS.has(second) || /ly$/u.test(second));
  }
  if (QUESTION_AUXILIARIES.has(first) && !contracted) {
    return SUBJECT_HEADS.has(second) || /^\p{Lu}/u.test(secondRaw);
  }
  return CLAUSE_TASK_VERB.test(text);
}

function markRoutingClauseBoundaries(value: string): string {
  const sentenceMarked = value.replace(/[;!?—–]+/gu, ". ");
  if (classifyMentionFrame(value)) {
    return sentenceMarked;
  }
  if (/\b(?:if i|if we|if you|say|said|quote|quoted|example|hypothetical|phrase)\b[^:]*:/iu.test(sentenceMarked)) {
    return sentenceMarked;
  }
  return sentenceMarked.replace(/,/gu, (comma, offset: number, whole: string) =>
    commaStartsClause(whole.slice(offset + 1)) ? "." : comma);
}

function selectDominantRoutingClause(value: string): string {
  const clauses = value
    .split(/\.(?:\s+|$)/g)
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (clauses.length <= 1) {
    return value;
  }
  for (let index = clauses.length - 1; index >= 0; index -= 1) {
    const clause = clauses[index] ?? "";
    const canonicalClause = canonicalizeCommonContractions(clause)
      .replace(/^(?:for now|at present|at the moment)\s+/, "")
      .replace(/^(?:only|just)\s+/, "");
    const framed = stripOuterRequestFrame(canonicalClause);
    const negatedControlConstraint = /^(?:do not|never|cannot)\b/.test(framed)
      && new RegExp(`\\b(?:${DEVICE_CONTROL_VERB_PATTERN}|act|touch)\\b`).test(framed);
    const reassuranceClause = /^(?:do not|never)\s+(?:stress|worry)(?:\b.*)?$/.test(framed);
    if (negatedControlConstraint || reassuranceClause) {
      continue;
    }
    if (
      looksLikeAnswerabilityMetaClause(canonicalClause)
      && clauses.slice(0, index).some((prior) => {
        const act = classifyRoutingSpeechAct(stripOuterRequestFrame(
          canonicalizeCommonContractions(prior),
        ));
        return act === "query" || act === "command";
      })
    ) {
      continue;
    }
    const act = classifyRoutingSpeechAct(framed);
    if (act === "query" || act === "command") {
      const priorTargetClause = clauses
        .slice(0, index)
        .reverse()
        .find((prior) => prior.split(/\s+/).length <= 8
          && new RegExp(`\\b(?:${HOUSE_QUERY_SIGNAL}|cabinets?|refrigeration|fridge|freezer)\\b`).test(prior)
          && classifyRoutingSpeechAct(prior) !== "query"
          && classifyRoutingSpeechAct(prior) !== "command");
      if (priorTargetClause && /^(?:is|are|was|were) (?:it|that|this|they|them|those|these)\b/.test(framed)) {
        return `${priorTargetClause} ${framed}`;
      }
      const focusDirective = clauses
        .slice(0, index)
        .reverse()
        .find((prior) => /^(?:back|go back|return) to\b/.test(prior));
      if (focusDirective) {
        return `${focusDirective} ${framed}`;
      }
      const trailingTarget = clauses.slice(index + 1).join(" ").trim();
      if (act === "query"
        && trailingTarget
        && /\b(?:which|what|where|it|that|one|ones|them|those|these)\b/.test(framed)
        && new RegExp(`\\b(?:${HOUSE_QUERY_SIGNAL}|cabinets?|refrigeration|fridge|freezer)\\b`).test(trailingTarget)) {
        return `${framed} ${trailingTarget}`;
      }
      const sourceQualifier = clauses
        .slice(0, index)
        .reverse()
        .find((prior) => /\b(?:based on|according to|from|using)\b.*\b(?:remember|memory|weather|forecast|sensor|calendar|diary)\b/.test(prior));
      if (sourceQualifier) {
        return `${sourceQualifier} ${framed}`;
      }
      const priorTopic = clauses
        .slice(0, index)
        .reverse()
        .map((prior) => /\b(lights?|lighting|lamps?|outlets?|switch(?:es)?|locks?|doors?|windows?|garage|weather|forecast|outside|outdoors|power|energy|calendar|diary)\b/.exec(prior)?.[1] ?? null)
        .find((topic): topic is string => topic !== null);
      const outdoorPlan = clauses
        .slice(0, index)
        .reverse()
        .find((prior) => /\b(?:i|we|me|us|they|he|she)\b/.test(prior)
          && /\b(?:go|going|head|heading|pop|popping|step|stepping|walk|walking|leave|leaving)\s+(?:out|outside|outdoors)\b/.test(prior));
      if (outdoorPlan
        && /\b(?:it|outside|weather|cold|hot|warm|wet|windy|rain)\b/.test(framed)) {
        return `${framed} ${outdoorPlan}`;
      }
      const ellipticalStateRequest = !/\b(?:lights?|lighting|lamps?|outlets?|switch(?:es)?|locks?|doors?|windows?|garage|weather|forecast|outside|outdoors|power|energy|calendar|diary)\b/.test(framed)
        && /\b(?:what|which|it|that|them|those|these|still|state|status|on|off|open|closed|locked|unlocked|lit|dark|cold|hot|warm|wet|windy|rain)\b/.test(framed);
      return priorTopic && ellipticalStateRequest ? `${framed} ${priorTopic}` : framed;
    }
  }
  return value;
}

function looksLikeAnswerabilityMetaClause(value: string): boolean {
  return /^(?:(?:can|could|would|will) you|are you able to)\s+(?:actually\s+)?(?:answer|respond to)\s+(?:that|this|it)(?:\s+or not)?$/.test(value);
}

function splitLeadingDialoguePrefix(value: string): { readonly act: RoutingDialogueAct; readonly tail: string } | null {
  const normalizedValue = canonicalizeCommonContractions(value);
  const prefixes: readonly { readonly act: RoutingDialogueAct; readonly pattern: RegExp }[] = [
    { act: "cancel", pattern: /^(?:never mind|nevermind|forget (?:it|that|those|them|(?:the )?[a-z][a-z ]{0,30})|cancel (?:that|it)|drop (?:that|it)|leave (?:that|it|this)(?: there| alone)?)\b/ },
    { act: "gratitude", pattern: /^(?:thank you|thanks|cheers|ta|good on you)\b/ },
    { act: "apology", pattern: /^(?:sorry|apologies|pardon me)\b/ },
    { act: "disagree", pattern: /^(?:no )?(?:(?:that|this)(?: answer| response)? is (?:not right|wrong|off)|you misunderstood(?: me)?|(?:that|this)(?: answer| response)? (?:missed (?:the|my) point|is not (?:useful|helpful|relevant)))\b/ },
    { act: "agree", pattern: /^(?:(?:yes|yeah|yep) (?:exactly|right|correct)|(?:that|this) (?:sounds|looks|seems) (?:right|correct)|(?:that|this) is what i (?:mean|meant)|we agree)\b/ },
    { act: "acknowledge", pattern: /^(?:got it|understood|(?:okay|ok|right|yep) (?:i )?(?:understand|follow|get it|clear)|(?:that|this)(?: [a-z]+){0,3} (?:makes sense|is clear))\b/ },
    { act: "greet", pattern: householdRegex(String.raw`^(?:(?:hello|hi|hey)(?: again| there| mate| {ASSISTANT})?|(?:good )?(?:morning|afternoon|evening)(?: mate| {ASSISTANT})?)\b`) },
    { act: "acknowledge", pattern: /^(?:okay|ok|right|fine|good)\b/ },
  ];
  for (const prefix of prefixes) {
    const match = prefix.pattern.exec(normalizedValue);
    if (!match) {
      continue;
    }
    const tail = normalizedValue.slice(match[0].length).replace(/^[\s,.:;]+/, "").trim();
    if (prefix.act === "greet" && looksLikeGreeting(`${match[0]} ${tail}`.replace(/\.(?=\s|$)/g, " ").replace(/\s+/g, " ").trim())) {
      return null;
    }
    const nested = tail ? splitLeadingDialoguePrefix(tail) : null;
    if (nested) {
      return nested;
    }
    if (
      tail
      && classifyStandaloneDialogueAct(normalizeDialogueText(tail)) !== null
    ) {
      return null;
    }
    const tailAct = classifyRoutingSpeechAct(stripOuterRequestFrame(tail));
    if (tail && (tailAct === "query" || tailAct === "command")) {
      return { act: prefix.act, tail };
    }
  }
  return null;
}

function normalizeDialogueText(value: string): string {
  return canonicalizeCommonContractions(value)
    .replace(/\.(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripOuterRequestFrame(value: string): string {
  let text = unwrapRecognizedRequestFrame(value);
  const politeGerund = /^(?:(?:do|would) you mind|(?:how|what) about)\s+(.+)$/.exec(text)?.[1]?.trim() ?? "";
  if (politeGerund) {
    const canonical = canonicalTaskGerundPhrase(politeGerund);
    if (canonical) return canonical;
  }
  const possibleInfinitive =
    /^(?:(?:(?:is|was) it|(?:would|could) it be) (?:at all )?possible(?: for (?:you|us|me))?|(?:(?:is|was) there|(?:would|could) there be) (?:any|a) way(?: for (?:you|us|me))?) to\s+(.+)$/.exec(text)?.[1]?.trim()
    ?? "";
  if (possibleInfinitive) {
    return possibleInfinitive;
  }
  const passiveReadRequest = /^i (?:only |just )?(?:want|need) (?:to have )?(.+?) (checked|confirmed|verified|read|reported|listed|scanned)(?:,? not (?:changed|touched|controlled|switched|turned))?[.]?$/.exec(text);
  if (passiveReadRequest?.[1] && passiveReadRequest[2]) {
    const verb = passiveReadRequest[2] === "read" ? "read" : "check";
    return `${verb} ${passiveReadRequest[1]}`.trim();
  }
  text = text.replace(
    new RegExp(String.raw`^i (?:only |just )?(?:want|need) to know\s+(?=${QUESTION_LEAD_PATTERN}\b)`),
    "",
  ).trim();
  const taskStart = new RegExp(`(?=${TASK_VERB_PATTERN}\\b)`);
  const frames = [
    new RegExp(`^(?:can|could|would|will) you\\s+${REQUEST_MANNER_PATTERN}${taskStart.source}`),
    new RegExp(`^i (?:want|need) you to\\s+${taskStart.source}`),
    new RegExp(`^i would like you to\\s+${taskStart.source}`),
    new RegExp(`^go ahead(?: and)?\\s+${taskStart.source}`),
    new RegExp(`^(?:(?:house|device|final|one)\\s+)?(?:command|instruction|job)\\s+${taskStart.source}`),
    new RegExp(`^do (?:this|it)(?: now)?\\s+${taskStart.source}`),
  ];
  for (const frame of frames) {
    text = text.replace(frame, "").trim();
  }
  return text;
}

function canonicalTaskGerundPhrase(value: string): string | null {
  const match = /^([a-z][a-z'-]*)(.*)$/.exec(value);
  const gerund = match?.[1] ?? "";
  const remainder = match?.[2] ?? "";
  const base = new Map<string, string>([
    ["adding", "add"],
    ["archiving", "archive"],
    ["booking", "book"],
    ["checking", "check"],
    ["clearing", "clear"],
    ["closing", "close"],
    ["confirming", "confirm"],
    ["creating", "create"],
    ["deleting", "delete"],
    ["disabling", "disable"],
    ["docking", "dock"],
    ["editing", "edit"],
    ["enabling", "enable"],
    ["erasing", "erase"],
    ["finding", "find"],
    ["identifying", "identify"],
    ["listing", "list"],
    ["locking", "lock"],
    ["moving", "move"],
    ["opening", "open"],
    ["pausing", "pause"],
    ["purging", "purge"],
    ["reading", "read"],
    ["recalling", "recall"],
    ["remembering", "remember"],
    ["removing", "remove"],
    ["renaming", "rename"],
    ["reporting", "report"],
    ["rescheduling", "reschedule"],
    ["resuming", "resume"],
    ["scanning", "scan"],
    ["scheduling", "schedule"],
    ["starting", "start"],
    ["stopping", "stop"],
    ["switching", "switch"],
    ["toggling", "toggle"],
    ["trashing", "trash"],
    ["turning", "turn"],
    ["updating", "update"],
    ["verifying", "verify"],
    ["wiping", "wipe"],
    ["working", "work"],
  ]).get(gerund);
  return base ? `${base}${remainder}`.trim() : null;
}

function unwrapRecognizedRequestFrame(value: string): string {
  const separator = value.indexOf(":");
  if (separator < 0) {
    return value;
  }
  const prefix = value.slice(0, separator).trim();
  const remainder = value.slice(separator + 1).trim();
  const calculationFrame = /\b(?:calculation|maths?|arithmetic)\b/.test(prefix);
  if (!remainder || (!calculationFrame && !isSemanticUtteranceStart(remainder)) || !isRecognizedRequestFrame(prefix)) {
    return value;
  }
  if (/\b(?:weather|forecast)\b/.test(prefix)
    && !/\b(?:weather|forecast|rain|wind|temperature|humidity)\b/.test(remainder)) {
    return `weather ${remainder}`;
  }
  return remainder;
}

function isRecognizedRequestFrame(prefix: string): boolean {
  if (/\b(?:do not|don t|dont|not want|if i|if we|if you|say|said|quote|quoted|example|hypothetical|phrase)\b/.test(prefix)) {
    return false;
  }
  return prefix.split(/\s+/).length <= 9
    && /\b(?:answer|check|command|instruction|job|question|reading|status|summary|thing|one|side|clear|literally|mean|need|want|confirm|final|quick|fresh|calculation|maths?|arithmetic|device|lighting|weather|power|historical|personal)\b/.test(prefix);
}

function isSemanticUtteranceStart(text: string): boolean {
  return new RegExp(`^(?:what|which|who|when|where|why|how|is|are|was|were|do|does|did|can|could|would|will|should|has|have|${TASK_VERB_PATTERN}|take|sum)\\b`).test(text);
}

function classifyStandaloneDialogueAct(text: string): RoutingDialogueAct | null {
  const utterance = canonicalizeLeadingQuestionContractions(text).trim();
  const courteousTail = stripLeadingCourtesy(utterance);
  if (looksLikeListeningCheck(courteousTail)) return "capability";
  if (looksLikeUnderstandingCheck(courteousTail)) return "acknowledge";
  if (looksLikeGoodbye(courteousTail)) return "goodbye";
  if (looksLikeRephraseOffer(courteousTail)) return "rephrase";
  if (looksLikePauseOrHesitation(courteousTail)) return "hold";
  if (looksLikeRejection(courteousTail)) return "disagree";
  if (looksLikeCancellation(courteousTail)) return "cancel";
  if (looksLikeStop(courteousTail)) return "stop";
  if (/^(?:go on|continue|carry on|resume)$/.test(courteousTail)) return "resume";
  if (/^(?:sorry|my mistake|apologies|pardon me|i got that wrong)$/.test(utterance)) return "apology";
  if (/^(?:nice work|good answer|well done|that was helpful|you are getting good at this)$/.test(courteousTail)) return "compliment";
  if (/^(?:thank you|thanks|cheers|appreciate it|good on you)$/.test(utterance)) return "gratitude";
  if (looksLikeAgreement(courteousTail)) return "agree";
  if (looksLikeAcknowledgement(courteousTail)) return "acknowledge";
  if (/^(?:are you there|quick question|got a moment|can i ask you something|ready for another question)$/.test(courteousTail)) return "attention";
  if (looksLikePresenceCheck(courteousTail)) return "attention";
  if (looksLikeCheckIn(courteousTail)) return "check_in";
  if (looksLikeGreeting(courteousTail)) return "greet";
  return null;
}

function responsePolicyForDialogueAct(
  text: string,
  act: RoutingDialogueAct,
): RoutingDialogueResponsePolicy {
  const utterance = canonicalizeLeadingQuestionContractions(text).trim();
  const courteousTail = stripLeadingCourtesy(utterance);
  if (act === "acknowledge") {
    return looksLikeUnderstandingCheck(courteousTail)
      ? "contextual"
      : "deterministic";
  }
  return [
    "agree",
    "disagree",
    "rephrase",
    "resume",
    "apology",
    "compliment",
  ].includes(act)
    ? "contextual"
    : "deterministic";
}

function stripLeadingCourtesy(value: string): string {
  return value
    .replace(/^(?:thank you|thanks|cheers|sorry|all right|alright)(?:\s+|$)/, "")
    .replace(/^(?:please)(?:\s+|$)/, "")
    .trim() || value;
}

function looksLikeListeningCheck(text: string): boolean {
  return /^(?:(?:can|could|do|did) you (?:still )?(?:hear|catch) (?:me|that)(?: clearly)?|are you (?:still )?listening|did (?:that|it) (?:come|go) through|is (?:this|our) conversation working)$/.test(text);
}

function looksLikeUnderstandingCheck(text: string): boolean {
  const intendedMeaning = "what i (?:mean|meant|am saying|was saying)";
  return new RegExp(`^(?:(?:do|did|can|could) you (?:understand|follow|get) (?:that|this|it|me|${intendedMeaning})|have you got (?:that|this|it|${intendedMeaning})|are we (?:on )?the same page|are we (?:clear|aligned))$`).test(text);
}

function looksLikeGoodbye(text: string): boolean {
  return /^(?:goodbye|bye|see you(?: later)?|see ya|catch you later|talk later|i am done for now)$/.test(text)
    || isTerminalDeparture(text)
    || isPartingWish(text);
}

/** "Have a nice night": an imperative wish over the coming period is a leave-taking. */
function isPartingWish(text: string): boolean {
  return new RegExp(
    `^(?:(?:you|and you) )?(?:have|enjoy) (?:a|an|the rest of (?:the|your)) (?:[a-z]+ )?(?:night|day|evening|afternoon|morning|weekend|one|sleep|rest)${SOCIAL_TAIL}$`,
  ).test(text);
}

const PERSONAL_PRESENT = "(?:i am|we are)";
const PERSONAL_FUTURE = "(?:i|we) will";
const CLOSURE_HORIZON = "(?:now|today|tonight|the night|this evening)";
const SOCIAL_TAIL = "(?:\\s+(?:then|instead|mate|please))*";
const TERMINAL_DESTINATION_TAIL = `(?:\\s+(?:now|tonight|for the night))?${SOCIAL_TAIL}`;
/** A departure closes the conversation only when its destination is terminal. */
function isTerminalDeparture(text: string): boolean {
  const callItANight = new RegExp(
    `^(?:${PERSONAL_PRESENT} calling|${PERSONAL_PRESENT} going to call|${PERSONAL_FUTURE} call|let us call|call|calling) it a night${SOCIAL_TAIL}$`,
  );
  const bedtimeDeclaration = new RegExp(
    `^(?:it is )?(?:bedtime|time (?:for bed|to (?:(?:go|head)(?: off)? to (?:bed|sleep)|sleep|turn in|call it a night)))${TERMINAL_DESTINATION_TAIL}$`,
  );
  const personalSleepDestination = new RegExp(
    `^${PERSONAL_PRESENT} (?:(?:going|heading)(?: off)? to (?:bed|sleep)|off to (?:bed|sleep)|turning in)${TERMINAL_DESTINATION_TAIL}$`,
  );
  const ellipticalSleepDestination = new RegExp(
    `^(?:(?:going|heading)(?: off)? to (?:bed|sleep)|off to (?:bed|sleep)|turning in)${TERMINAL_DESTINATION_TAIL}$`,
  );
  const barePersonalDeparture = new RegExp(
    `^${PERSONAL_PRESENT} (?:going|heading|leaving|off)(?: now)?${SOCIAL_TAIL}$`,
  );
  const conventionalNightLeave = new RegExp(
    `^(?:good ?night|night|bedtime|time for bed|off to bed)${SOCIAL_TAIL}$`,
  );
  return callItANight.test(text)
    || bedtimeDeclaration.test(text)
    || personalSleepDestination.test(text)
    || ellipticalSleepDestination.test(text)
    || barePersonalDeparture.test(text)
    || conventionalNightLeave.test(text);
}

function looksLikePauseOrHesitation(text: string): boolean {
  const pauseRequest = /^(?:do not answer yet\b|(?:please )?(?:hold on|hang on|wait)(?:\b(?: there| here| a moment| a second| until i\b| while i\b| for (?:a )?(?:moment|second|bit))?)|(?:please )?pause(?:$| for (?:a )?(?:moment|second|bit)| while i\b| until i\b)|give me (?:a|one) (?:moment|second)\b|one moment\b)/.test(text);
  const speakerHesitation = /\b(?:i am not sure (?:how to (?:ask|say|phrase|word|start)(?: this| that)?|where to (?:begin|start))|i (?:have )?lost my train of thought|i cannot find the words|let me (?:think|find the words))\b/.test(text)
    || /^i am (?:still )?thinking$/.test(text);
  return pauseRequest || speakerHesitation;
}

function looksLikeRephraseOffer(text: string): boolean {
  return /^(?:let me (?:rephrase|reword|put) (?:that|this)(?: differently)?|i will (?:ask|say|try) (?:it |that |this )?(?:another way|again|differently)|give me (?:a|one) moment to (?:rephrase|reword|phrase) (?:it|that|this))$/.test(text);
}

function looksLikeRejection(text: string): boolean {
  const repairSubject = "(?:(?:that|this)(?: answer| response)?|the answer|your answer|your response)";
  return new RegExp(`^(?:no )?(?:${repairSubject} (?:is (?:wrong|off|not (?:right|useful|helpful|relevant)|not what i (?:asked|wanted|meant))|missed (?:the|my) point(?: entirely)?)|you (?:have )?misunderstood(?: me)?|you did not (?:understand|answer) (?:me|that|what i asked))$`).test(text)
    || /^(?:no )?that is not the answer i (?:asked for|wanted)$/.test(text)
    || /^(?:no )?(?:that|this) did not answer (?:me|my question|what i asked)$/.test(text)
    || /^(?:no )?i did not (?:ask for|mean) (?:that|this)$/.test(text)
    || /^leave (?:that|this|the) answer\b.*\bnot (?:useful|helpful|relevant)$/.test(text);
}

function looksLikeCancellation(text: string): boolean {
  const withoutFiller = text.replace(/^(?:okay|ok|fine)\s+/, "");
  return /^(?:never mind|nevermind)(?:\b.*)?$/.test(withoutFiller)
    || /^(?:forget|cancel|scrap)\b(?:\s+.*)?$/.test(withoutFiller)
    || /^(?:(?:we can|let us) )?drop (?:it|that|this|(?:the|my|our|this|that)\b.*)$/.test(withoutFiller)
    || /^(?:let us )?leave (?:it|that|this)(?: (?:there|here|alone))?$/.test(withoutFiller)
    || /^(?:let us )?leave (?:the|my|our|this|that)\b.*\b(?:there|here|alone)$/.test(withoutFiller)
    || /^(?:i am|we are) (?:done|finished) with (?:the|my|our|this|that)\s+.+$/.test(withoutFiller)
    || /^(?:okay |ok |fine )?done with (?:it|that|this)$/.test(text);
}

function looksLikeStop(text: string): boolean {
  const withoutPositiveLead = text.replace(/^(?:good|okay|ok|right|fine)\s+/, "");
  if (hasNonConversationEnoughComplement(withoutPositiveLead)) {
    return false;
  }
  return isTerminalCompletion(withoutPositiveLead)
    || /^(?:(?:we can )?stop(?: there| here| now| talking(?: now)?)?|that is all(?: (?:i|we) (?:need|needed|wanted))?|that is (?:the |this |that )?.+ done|done(?: now)?|finished(?: now)?)$/.test(withoutPositiveLead)
    || /^(?:that|this) (?:will|should) (?:do|be (?:enough|sufficient))$/.test(withoutPositiveLead)
    || /^(?:[a-z0-9-]+\s+){0,4}(?:check|task|job|conversation) (?:is )?(?:complete|finished|done)$/.test(withoutPositiveLead)
    || /^(?:that is )?enough(?:\s+(?!to\b|for\b)[a-z0-9-]+)*(?: for now)?$/.test(withoutPositiveLead)
    || /^no more\s+[a-z0-9-]+(?:\s+[a-z0-9-]+)*(?: for now)?$/.test(withoutPositiveLead)
    || /^(?:let us )?leave (?:it|that|this) at that$/.test(withoutPositiveLead)
    || /^(?:i am|we are) (?:done|finished) with\b.+$/.test(withoutPositiveLead);
}

/** "That is enough X" is a referential stop only when X can refer to an
 * active conversation. Without context it remains an ordinary quantity or
 * state assertion; purpose/result complements remain assertions everywhere. */
function classifyContextualDialogueAct(
  text: string,
  contextFrameKinds: readonly string[],
): RoutingDialogueAct | null {
  const withoutPositiveLead = text.replace(/^(?:good|okay|ok|right|fine)\s+/, "");
  const match = /^(?:that|this|it) is enough\s+(.+)$/.exec(withoutPositiveLead);
  if (!match?.[1]) return null;
  const complement = match[1]
    .replace(new RegExp(`\\s+for ${CLOSURE_HORIZON}${SOCIAL_TAIL}$`), "")
    .replace(new RegExp(`${SOCIAL_TAIL}$`), "")
    .trim();
  if (!complement
    || /\b(?:to|for)\b/.test(complement)
    || !/^[a-z0-9-]+(?:\s+[a-z0-9-]+){0,7}$/.test(complement)) {
    return null;
  }
  return isConversationWorkComplement(complement, contextFrameKinds) ? "stop" : null;
}

/** Completion owns the whole clause; an object or quantity complement does not. */
function isTerminalCompletion(text: string): boolean {
  const completionState = new RegExp(
    `^(?:(?:i am|we are|it is|that is|this is) )?(?:all )?(?:done|finished|complete)(?: here| for ${CLOSURE_HORIZON})?(?: now)?${SOCIAL_TAIL}$`,
  );
  const enoughClosure = new RegExp(
    `^(?:(?:that|this|it) is )?enough(?: for ${CLOSURE_HORIZON})?${SOCIAL_TAIL}$`,
  );
  const allClosure = new RegExp(
    `^(?:that|this|it) is (?:all|all (?:i|we) (?:need|needed|wanted))(?: for ${CLOSURE_HORIZON})?${SOCIAL_TAIL}$`,
  );
  const demonstrativeCompletion = new RegExp(
    `^(?:that|this) (?:will|should) do(?: it)?${SOCIAL_TAIL}$`,
  );
  return completionState.test(text)
    || enoughClosure.test(text)
    || allClosure.test(text)
    || demonstrativeCompletion.test(text);
}

function hasNonConversationEnoughComplement(text: string): boolean {
  const match = /^(?:(?:that|this|it) is )?enough\s+(.+)$/.exec(text);
  if (!match?.[1]) {
    return false;
  }
  const complement = match[1]
    .replace(new RegExp(`\\s+for ${CLOSURE_HORIZON}$`), "")
    .trim();
  if (!complement || /^(?:for )?(?:now|today|tonight|the night|this evening)$/.test(complement)) {
    return false;
  }
  return !isConversationWorkComplement(complement, []);
}

function isConversationWorkComplement(
  complement: string,
  contextFrameKinds: readonly string[],
): boolean {
  if (/\b(?:answers?|arithmetic|calculations?|checks?|checking|conversation|details?|discussion|figures|jobs?|maths?|numbers|reporting|research|tasks?|troubleshooting|hopping)\b/.test(complement)) {
    return true;
  }
  const kinds = new Set(contextFrameKinds);
  return ((kinds.has("history_metric") || kinds.has("comparison_metric"))
      && /\b(?:history|historical|comparison|comparisons)\b/.test(complement))
    || (kinds.has("wikipedia_abstract")
      && /\b(?:biography|encyclopedia|history|research|topic|topics|reading)\b/.test(complement))
    || (kinds.has("calculation")
      && /\b(?:arithmetic|calculation|calculations|math|maths|numbers)\b/.test(complement))
    || (kinds.has("weather")
      && /\b(?:weather|forecast|forecasts)\b/.test(complement))
    || (kinds.has("calendar")
      && /\b(?:calendar|diary|schedule|scheduling)\b/.test(complement));
}

function looksLikeAgreement(text: string): boolean {
  return /^(?:(?:yes|yeah|yep)(?: exactly| right| correct)|(?:that|this) (?:sounds|looks|seems) (?:right|correct)|(?:that|this) is what i (?:mean|meant)|correct|exactly|agreed|we agree(?: then)?)$/.test(text);
}

function looksLikeAcknowledgement(text: string): boolean {
  const hasPositiveLead = /^(?:okay|ok|right|fine|good|yep)\s+/.test(text);
  const withoutPositiveLead = text.replace(/^(?:okay|ok|right|fine|good|yep)\s+/, "");
  return /^(?:got it|understood|clear|i (?:understand|follow|get it)|(?:that|this)(?: [a-z0-9-]+){0,4} (?:makes sense|is clear))$/.test(withoutPositiveLead)
    || /^i will (?:dress|prepare|plan|wear|take|bring)\b.*\b(?:for it|for that|accordingly)$/.test(withoutPositiveLead)
    || /^(?:got it|understood)\b(?:\s+leave everything as it is)?$/.test(text)
    || /^i (?:understand|follow|get) (?:it|that|this|the difference|your point|what you mean)$/.test(withoutPositiveLead)
    || /^(?:that|this)(?: [a-z0-9-]+){0,4} makes sense\b/.test(withoutPositiveLead)
    || (hasPositiveLead && /^(?:i (?:understand|follow|get)\b|(?:i|we) will\b.+\b(?:it|that|them|ourselves|myself|for it)$)/.test(withoutPositiveLead));
}

const GREETING_LEAD = `(?:(?:hello|hi|hey)(?: again| there| mate| ${assistantNamePattern()})*|(?:good )?(?:morning|afternoon|evening)(?: mate| ${assistantNamePattern()})?)`;
const CHECK_IN_PHRASE = `(?:how are you(?: doing| going| today| keeping)?(?: today)?|how (?:you|ya) going|how is it going|how are things with you|how have you been|you (?:doing )?(?:all right|alright|okay|ok|good))(?: mate| ${assistantNamePattern()})?`;
const PRESENCE_PHRASE = `(?:(?:are )?you (?:awake|up|there)|(?:are )?you still (?:awake|up|there))(?: mate| ${assistantNamePattern()})?`;

function looksLikeGreeting(text: string): boolean {
  return new RegExp(`^${GREETING_LEAD}$`).test(text)
    || looksLikeCheckIn(text)
    || looksLikePresenceCheck(text);
}

/** "How are you?" asks after the assistant; a greeting in front does not change that. */
function looksLikeCheckIn(text: string): boolean {
  return new RegExp(`^(?:${GREETING_LEAD} )?${CHECK_IN_PHRASE}$`).test(text);
}

/** "You there?" / "Are you awake?" only want to know someone is listening. */
function looksLikePresenceCheck(text: string): boolean {
  return new RegExp(`^(?:${GREETING_LEAD} )?${PRESENCE_PHRASE}$`).test(text);
}

function rewriteBareQueryLeadIns(value: string): string {
  let text = value;
  const pattern = new RegExp(
    `^(?:show me|tell me|give me|let me know)\\s+(?!about\\b|summary\\b|(?:a|the|one paragraph)\\s+summary\\b|when\\b|if\\b|whether\\b|what\\b|who\\b|where\\b|which\\b|how\\b|why\\b)(?=.*\\b${HOUSE_QUERY_SIGNAL}\\b)`,
  );
  const chainedPattern = new RegExp(
    `^check\\s+(?:show me|tell me|give me|let me know)\\s+(?!about\\b|summary\\b|(?:a|the|one paragraph)\\s+summary\\b|when\\b|if\\b|whether\\b|what\\b|who\\b|where\\b|which\\b|how\\b|why\\b)(?=.*\\b${HOUSE_QUERY_SIGNAL}\\b)`,
  );
  for (let index = 0; index < 8; index += 1) {
    const next = text.replace(pattern, "check ").replace(chainedPattern, "check ").replace(/\s+/g, " ").trim();
    if (next === text) {
      break;
    }
    text = next;
  }
  return text;
}

export function rewriteTrailingQuestionCopula(value: string): string {
  return value
    // Embedded "what day it is": a pronoun subject inverts ("what day is it"),
    // it is not the predicate ("what is day it").
    .replace(/^(?:(?:check|tell me|show me|give me|let me know)\s+)?what\s+(.+)\s+(it|this|that)\s+is$/g, "what $1 is $2")
    .replace(/^(?:check|tell me|show me|give me|let me know)\s+what\s+(.+)\s+is$/g, "what is $1")
    .replace(/^(?:check|tell me|show me|give me|let me know)\s+how\s+(.+)\s+is$/g, "how is $1")
    .replace(/^what (.+) is$/g, "what is $1")
    .replace(/^how (.+) is$/g, "how is $1")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalizeLeadingQuestionContractions(value: string): string {
  return canonicalizeCommonContractions(value);
}

const COMMON_CONTRACTION_PATTERN = /\b(?:there s been|theres been|there s|theres|when s|whens|what s|whats|who s|whos|where s|wheres|how s|hows|that s|thats|that ll|it s|i m|i ll|i ve|we re|we ll|we ve|you re|you ll|you ve|they re|they ll|let s|don t|doesn t|didn t|can t|won t|wouldn t|wouldnt|isn t|aren t)\b/g;
const COMMON_CONTRACTION_REPLACEMENTS: ReadonlyMap<string, string> = new Map([
  ["there s been", "there has been"],
  ["theres been", "there has been"],
  ["there s", "there is"],
  ["theres", "there is"],
  ["when s", "when is"],
  ["whens", "when is"],
  ["what s", "what is"],
  ["whats", "what is"],
  ["who s", "who is"],
  ["whos", "who is"],
  ["where s", "where is"],
  ["wheres", "where is"],
  ["how s", "how is"],
  ["hows", "how is"],
  ["that s", "that is"],
  ["thats", "that is"],
  ["that ll", "that will"],
  ["it s", "it is"],
  ["i m", "i am"],
  ["i ll", "i will"],
  ["i ve", "i have"],
  ["we re", "we are"],
  ["we ll", "we will"],
  ["we ve", "we have"],
  ["you re", "you are"],
  ["you ll", "you will"],
  ["you ve", "you have"],
  ["they re", "they are"],
  ["they ll", "they will"],
  ["let s", "let us"],
  ["don t", "do not"],
  ["doesn t", "does not"],
  ["didn t", "did not"],
  ["can t", "cannot"],
  ["won t", "will not"],
  ["wouldn t", "would not"],
  ["wouldnt", "would not"],
  ["isn t", "is not"],
  ["aren t", "are not"],
]);

/**
 * Clause text for the structural recognisers: speech-normalised with entity
 * characters, common contractions expanded, leading punctuation dropped and,
 * when asked, trailing full stops.
 */
function clauseText(value: string, dropTrailingStops = false): string {
  const text = canonicalizeCommonContractions(normalizeSpeechForRouting(value, { preserveEntityChars: true }))
    .replace(/^[^a-z0-9]+/g, "");
  return (dropTrailingStops ? text.replace(/[?.!]+$/g, "") : text).replace(/\s+/g, " ").trim();
}

function canonicalizeCommonContractions(value: string): string {
  return value.replace(
    COMMON_CONTRACTION_PATTERN,
    (match) => COMMON_CONTRACTION_REPLACEMENTS.get(match) ?? match,
  );
}
