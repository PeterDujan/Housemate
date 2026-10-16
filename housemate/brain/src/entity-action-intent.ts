import {
  hasNonAssertiveRoutingFrame,
  normalizeRoutingText as normalize,
  type RoutingExecution,
} from "./routing-text.js";
import {
  DEVICE_ACTION_PATTERN,
  DEVICE_PLURAL_PATTERN,
  stripStatusFiller,
} from "./lexicon.js";
import { householdRegex } from "./household.js";

export type EntityActionOperation =
  | "turn_on"
  | "turn_off"
  | "toggle"
  | "set_state"
  | "open"
  | "close"
  | "lock"
  | "unlock"
  | "start"
  | "stop"
  | "pause"
  | "resume"
  | "dock";

export interface EntityActionIntent {
  readonly operation: EntityActionOperation;
  readonly targetText: string;
  readonly requestedState: string | null;
  /** Proven positive assertion shape; target resolution must never manufacture this evidence. */
  readonly assertionEvidence: "root_positive" | "licensed_positive_complement" | "elliptical_positive";
  /** Whether the verb-particle construction itself proves device-control intent. */
  readonly targetEvidence: "device_control_syntax" | "target_required";
  /** Explicit collection policy derived from the action target, never incidental clause text. */
  readonly targetScope?: "whole_house_lights";
  /** Deferred/deadline controls remain recognized but cannot authorize immediate execution. */
  readonly executionTiming?: "deferred" | "conditional";
}

export function applyRoutingExecutionToEntityActionIntent(
  intent: EntityActionIntent,
  execution: RoutingExecution,
): EntityActionIntent {
  if (intent.executionTiming || execution === "none" || execution === "immediate") {
    return intent;
  }
  return {
    ...intent,
    executionTiming: execution,
  };
}

export type DemonstrativeTargetReference =
  | { readonly kind: "none" }
  | {
    readonly kind: "contextual";
    readonly descriptor: string | null;
    readonly expectedCardinality: number | null;
    readonly minimumCardinality: number | null;
    readonly singularPersonAllowed: boolean;
  }
  | {
    readonly kind: "underspecified";
    readonly descriptor: string | null;
    readonly reason?: "exclusion";
  }
  | {
    readonly kind: "descriptive";
    readonly descriptor: string;
    readonly expectedCardinality: number | null;
  };

/** Parse device-control grammar only. Target resolution and policy stay outside this helper. */
export function parseEntityActionIntent(input: string): EntityActionIntent | null {
  let clause = stripTrailingActionModifiers(normalize(input)
    .replace(/^(?:actually|now|just)\s+/, "")
    .replace(/^(?:please|go ahead and|try to|try)\s+/, "")
    .replace(/^turning\b/, "turn")
    .replace(/^switching\b/, "switch")
    .replace(/^changing\b/, "change"))
    .replace(/\s+/g, " ")
    .trim();
  const semanticClause = clause;
  if (hasNonAssertiveRoutingFrame(semanticClause)) {
    return null;
  }
  const executionTiming = /\s+before\b/.test(semanticClause)
    ? "deferred" as const
    : /\s+if\b/.test(semanticClause)
      ? "conditional" as const
      : null;
  clause = stripTrailingActionModifiers(clause
    .replace(/\s+before\s+(?:i|we)\s+(?:go|leave|head|turn in)\b.*$/, "")
    .replace(/\s+if\s+.+$/, "")
    .replace(/\s+now(?:\s+that)?\s+(?:the\s+)?[a-z][a-z ]*?\s+(?:is|are|has|have|was|were)\b.*$/, "")
    .trim());
  if (/^(?:never|do\s+not|dont|cannot|can\s+not|will\s+not|wont)\b/.test(clause)
    || /^i\s+(?:do\s+not|dont)\s+(?:want|need)\b/.test(clause)) {
    return null;
  }
  if (/^(?:turn|switch)\s+(?:on|off)\b/.test(clause)) {
    clause = clause
      .replace(/\s+(?:that|which)\s+(?:is|are|was|were)\s+(?:still\s+)?(?:on|off)$/, "")
      .replace(/\s+(?:i|we)\s+(?:left|leave|had)\s+(?:on|off)$/, "")
      .trim();
  }
  if (!clause || /^(?:know|check|verify|whether|which|what|who|where|when|why|how)\b/.test(clause)) {
    return null;
  }

  const directActions: Readonly<Record<string, { readonly operation: EntityActionOperation; readonly state: string | null }>> = {
    enable: { operation: "turn_on", state: "on" },
    disable: { operation: "turn_off", state: "off" },
    open: { operation: "open", state: "open" },
    raise: { operation: "open", state: "open" },
    unlock: { operation: "unlock", state: "unlocked" },
    lock: { operation: "lock", state: "locked" },
    close: { operation: "close", state: "closed" },
    shut: { operation: "close", state: "closed" },
    lower: { operation: "close", state: "closed" },
    start: { operation: "start", state: "running" },
    stop: { operation: "stop", state: "stopped" },
    pause: { operation: "pause", state: "paused" },
    resume: { operation: "resume", state: "running" },
    dock: { operation: "dock", state: "docked" },
    toggle: { operation: "toggle", state: null },
  };
  const normalizeActionState = (value: string | undefined): string | null => {
    if (!value) return null;
    if (value === "close" || value === "shut") return "closed";
    if (value === "light" || value === "lit") return "on";
    if (value === "dark") return "off";
    return value;
  };
  const operationForState = (state: string | null): EntityActionOperation => {
    if (state === "on") return "turn_on";
    if (state === "off") return "turn_off";
    if (state === "open") return "open";
    if (state === "closed") return "close";
    if (state === "locked") return "lock";
    if (state === "unlocked") return "unlock";
    if (state === "running") return "start";
    if (state === "stopped") return "stop";
    if (state === "paused") return "pause";
    if (state === "docked") return "dock";
    return "set_state";
  };
  const finish = (
    target: string,
    state: string | null,
    operation: EntityActionOperation,
    targetEvidence: EntityActionIntent["targetEvidence"] = "target_required",
    semanticTargetScope: EntityActionIntent["targetScope"] | null = null,
    assertionEvidence: EntityActionIntent["assertionEvidence"] = "root_positive",
  ): EntityActionIntent | null => {
    const rawTarget = stripTrailingActionAspect(target
      .replace(/^(?:up|down)\s+/, "")
      .replace(/\b(?:up|down)$/, ""));
    const targetText = cleanTargetText(rawTarget);
    if (!targetText) return null;
    const targetScope = semanticTargetScope ?? (isWholeHouseLightActionTarget(rawTarget, semanticClause, operation)
      ? "whole_house_lights" as const
      : null);
    return {
      operation,
      targetText,
      requestedState: state,
      assertionEvidence,
      targetEvidence,
      ...(targetScope ? { targetScope } : {}),
      ...(executionTiming ? { executionTiming } : {}),
    };
  };

  const switchMatch = /^(?:turn|switch)\s+(?:(on|off)\s+)?(.+?)(?:\s+(on|off))?$/.exec(clause);
  if (switchMatch) {
    const state = normalizeActionState(switchMatch[1] ?? switchMatch[3]);
    return finish(switchMatch[2] ?? "", state, operationForState(state), "device_control_syntax");
  }
  const lightUpMatch = /^light\s+up\s+(.+)$/.exec(clause);
  if (lightUpMatch) {
    return finish(lightUpMatch[1] ?? "", "on", "turn_on", "device_control_syntax");
  }
  if (/^make\s+(?:(?:absolutely|really|quite)\s+)?(?:sure|certain)\b/.test(clause)) {
    return null;
  }
  const makeMatch = /^(?:make|set|change)\s+(.+?)\s+(?:to\s+)?(on|off|open|closed|locked|unlocked|running|stopped|paused|lit|dark)$/.exec(clause);
  if (makeMatch) {
    const state = normalizeActionState(makeMatch[2]);
    const targetScope = isWholeHouseLightingStateTarget(makeMatch[1] ?? "", makeMatch[2] ?? "")
      ? "whole_house_lights" as const
      : null;
    return finish(makeMatch[1] ?? "", state, operationForState(state), "target_required", targetScope);
  }
  const shutdownMatch = /^(?:shut|power)\s+(.+?)\s+down$/.exec(clause);
  if (shutdownMatch) {
    return finish(shutdownMatch[1] ?? "", "off", "turn_off", "device_control_syntax");
  }
  const shutdownParticleMatch = /^(?:shut|power)\s+down\s+(.+)$/.exec(clause);
  if (shutdownParticleMatch) {
    return finish(shutdownParticleMatch[1] ?? "", "off", "turn_off", "device_control_syntax");
  }
  const powerUpMatch = /^power\s+(.+?)\s+up$/.exec(clause);
  if (powerUpMatch) {
    return finish(powerUpMatch[1] ?? "", "on", "turn_on", "device_control_syntax");
  }
  const powerUpParticleMatch = /^power\s+up\s+(.+)$/.exec(clause);
  if (powerUpParticleMatch) {
    return finish(powerUpParticleMatch[1] ?? "", "on", "turn_on", "device_control_syntax");
  }
  const directMatch = /^(enable|disable|open|raise|unlock|lock|close|shut|lower|start|stop|pause|resume|dock|toggle)\s+(.+)$/.exec(clause);
  if (directMatch) {
    const action = directActions[directMatch[1] ?? ""];
    return action ? finish(directMatch[2] ?? "", action.state, action.operation) : null;
  }
  const desiredStateMatch = /^(?:i (?:need|want)(?: to have)?\s+)?(.+?)\s+(on|off|open|closed|locked|unlocked|running|stopped|paused|lit|dark)(?:\s+(?:everywhere|around (?:the )?(?:house|home)))?$/.exec(clause);
  if (desiredStateMatch
    && !hasNonPositiveDesiredStateFraming(desiredStateMatch[1] ?? "")
    && !/^(?:tell|show|give|check|confirm|read|verify|report|list|scan)\b/.test(clause)) {
    const state = normalizeActionState(desiredStateMatch[2]);
    const targetScope = isWholeHouseLightingStateTarget(
      desiredStateMatch[1] ?? "",
      desiredStateMatch[2] ?? "",
    ) ? "whole_house_lights" as const : null;
    const assertionEvidence = /^i (?:need|want)(?: to have)?\b/.test(clause)
      ? "licensed_positive_complement" as const
      : "elliptical_positive" as const;
    return finish(
      desiredStateMatch[1] ?? "",
      state,
      operationForState(state),
      "target_required",
      targetScope,
      assertionEvidence,
    );
  }
  return null;
}

export function isDeicticActionTarget(value: string): boolean {
  return classifyDemonstrativeTarget(value).kind !== "none";
}

/** Incomplete turn/switch grammar owns the action route but cannot authorize a target. */
export function entityActionIntentCanResolveTarget(intent: EntityActionIntent): boolean {
  return intent.executionTiming === undefined
    && (intent.operation !== "set_state" || intent.requestedState !== null);
}

/**
 * Separate pure anaphora from a demonstrative that names its own sourced target.
 * A descriptive miss must fail closed; it must never silently bind old context.
 */
export function classifyDemonstrativeTarget(value: string): DemonstrativeTargetReference {
  const preposed = parsePreposedReferenceQuantifier(normalizeReferenceTargetText(value));
  const normalized = preposed.targetText
    .replace(/^the\s+(?=(?:very\s+)?same\b)/, "")
    .replace(/^very\s+(?=same\b)/, "");
  if (hasReferenceExclusion(normalized)) {
    return { kind: "underspecified", descriptor: normalized, reason: "exclusion" };
  }
  if (preposed.forceUnderspecified) {
    return { kind: "underspecified", descriptor: normalized || null };
  }
  const anaphora = classifyAnaphoricTarget(normalized, preposed.expectedCardinality);
  if (anaphora) {
    return anaphora;
  }
  const determined = /^(the|my|our|your)\s+(.+)$/.exec(normalized);
  if (determined?.[1] && determined[2]) {
    const determinedDescriptor = parseLeadingReferenceDescriptor(determined[2]);
    if (determinedDescriptor.forceUnderspecified
      || (determined[1] !== "the"
        && (!determinedDescriptor.descriptor
          || isGenericActionTargetDescriptor(determinedDescriptor.descriptor)))) {
      return { kind: "underspecified", descriptor: determinedDescriptor.descriptor || null };
    }
    if (determinedDescriptor.matched
      && determinedDescriptor.expectedCardinality !== null
      && determinedDescriptor.descriptor
      && !isGenericActionTargetDescriptor(determinedDescriptor.descriptor)) {
      return {
        kind: "descriptive",
        descriptor: determinedDescriptor.descriptor,
        expectedCardinality: determinedDescriptor.expectedCardinality,
      };
    }
    if (["exact", "specific"].includes(determinedDescriptor.modifier ?? "")
      && determinedDescriptor.descriptor) {
      return {
        kind: "descriptive",
        descriptor: determinedDescriptor.descriptor,
        expectedCardinality: null,
      };
    }
    if (determined[1] === "the" && !determinedDescriptor.descriptor) {
      return {
        kind: "contextual",
        descriptor: null,
        expectedCardinality: determinedDescriptor.expectedCardinality,
        minimumCardinality: null,
        singularPersonAllowed: false,
      };
    }
    if (isGenericActionTargetDescriptor(determinedDescriptor.descriptor)) {
      return {
        kind: "contextual",
        descriptor: determinedDescriptor.descriptor,
        expectedCardinality: determinedDescriptor.expectedCardinality
          ?? impliedSingularReferenceCardinality(determinedDescriptor.descriptor),
        minimumCardinality: impliedPluralReferenceCardinality(determinedDescriptor.descriptor),
        singularPersonAllowed: false,
      };
    }
  }
  const directModifiedDescriptor = parseLeadingReferenceDescriptor(normalized);
  if (directModifiedDescriptor.matched
    && !directModifiedDescriptor.descriptor
    && /^(?:all|both)$/.test(normalized)) {
    return {
      kind: "contextual",
      descriptor: null,
      expectedCardinality: directModifiedDescriptor.expectedCardinality,
      minimumCardinality: directModifiedDescriptor.modifier === "both" ? 2 : null,
      singularPersonAllowed: false,
    };
  }
  if (!directModifiedDescriptor.forceUnderspecified
    && ["exact", "specific"].includes(directModifiedDescriptor.modifier ?? "")
    && directModifiedDescriptor.descriptor) {
    return {
      kind: "descriptive",
      descriptor: directModifiedDescriptor.descriptor,
      expectedCardinality: null,
    };
  }
  if (directModifiedDescriptor.forceUnderspecified
    || (directModifiedDescriptor.matched && !directModifiedDescriptor.descriptor)) {
    return { kind: "underspecified", descriptor: directModifiedDescriptor.descriptor || null };
  }
  const match = /^(that|this|those|these|same)(?:\s+(.+))?$/.exec(normalized);
  if (!match) {
    if ((preposed.expectedCardinality !== null || preposed.universal) && normalized) {
      if (isGenericActionTargetDescriptor(normalized)) {
        return { kind: "underspecified", descriptor: normalized };
      }
      return {
        kind: "descriptive",
        descriptor: normalized,
        expectedCardinality: preposed.expectedCardinality,
      };
    }
    return { kind: "none" };
  }
  const demonstrative = match[1] ?? "";
  const deicticDescriptor = normalizeDeicticDescriptor(match[2]?.trim() ?? "");
  if (deicticDescriptor.forceUnderspecified) {
    return { kind: "underspecified", descriptor: deicticDescriptor.descriptor || null };
  }
  const modifiedDescriptor = parseLeadingReferenceDescriptor(deicticDescriptor.descriptor);
  const expectedCardinality = preposed.expectedCardinality
    ?? modifiedDescriptor.expectedCardinality
    ?? (["that", "this", "same"].includes(demonstrative)
      ? impliedSingularReferenceCardinality(modifiedDescriptor.descriptor)
        ?? (["that", "this"].includes(demonstrative) ? 1 : null)
      : null);
  if (modifiedDescriptor.forceUnderspecified
    || (preposed.expectedCardinality !== null
      && modifiedDescriptor.expectedCardinality !== null
      && preposed.expectedCardinality !== modifiedDescriptor.expectedCardinality)) {
    return { kind: "underspecified", descriptor: modifiedDescriptor.descriptor || null };
  }
  const descriptor = modifiedDescriptor.descriptor;
  if (!descriptor
    || /^(?:one|ones)$/.test(descriptor)
    || isGenericActionTargetDescriptor(descriptor)) {
    return {
      kind: "contextual",
      descriptor: descriptor || null,
      expectedCardinality,
      minimumCardinality: ["those", "these"].includes(demonstrative)
        ? 2
        : impliedPluralReferenceCardinality(descriptor),
      singularPersonAllowed: false,
    };
  }
  return { kind: "descriptive", descriptor, expectedCardinality };
}

/** Return the named descriptor inside a demonstrative reference, if present. */
export function demonstrativeActionTargetDescriptor(value: string): string | null {
  const reference = classifyDemonstrativeTarget(value);
  return reference.kind === "descriptive" ? reference.descriptor : null;
}

/** Bare device classes remain referential even if an operator alias happens to share the word. */
export function isGenericActionTargetDescriptor(value: string): boolean {
  const normalized = normalizeTargetText(value).replace(
    /^(?:(?:same|other|another|exact|specific|both|either|neither|first|second|third|fourth|fifth|last|next|previous|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+)+/,
    "",
  );
  return /^(?:one|ones|thing|things|lights?|lighting|lamps?|cabinets?|outlets?|plugs?|sockets?|switch(?:es)?|locks?|doors?|windows?|blinds?|shades?|curtains?|gates?|garage|heaters?|fans?|vacuums?|computers?|media players?|speakers?|televisions?|tvs?|devices?)$/.test(normalized);
}

/**
 * Source-resolution forms for one action target. These are grammatical
 * equivalents only; they do not select an entity or weaken provenance.
 */
export function entityActionTargetResolutionVariants(value: string): readonly string[] {
  const normalized = normalizeTargetText(value);
  const variants = new Set<string>([normalized]);
  if (/\broom\b/.test(normalized)) {
    variants.add(normalized.replace(/\broom\b/g, "bedroom"));
  }
  if (/\bbedroom\b/.test(normalized)) {
    variants.add(normalized.replace(/\bbedroom\b/g, "room"));
  }
  return [...variants].filter(Boolean);
}

/** Canonicalize separable opening language against the resolved device domain. */
export function canonicalEntityActionOperationForDomain(
  operation: EntityActionOperation,
  domain: string,
): EntityActionOperation {
  if (domain !== "lock") {
    return operation;
  }
  if (operation === "open") {
    return "unlock";
  }
  if (operation === "close") {
    return "lock";
  }
  return operation;
}

/** One operation/domain contract shared by typed arbitration and legacy execution guards. */
export function entityActionOperationSupportsDomain(
  operation: EntityActionOperation,
  domain: string,
): boolean {
  const canonicalOperation = canonicalEntityActionOperationForDomain(operation, domain);
  switch (canonicalOperation) {
    case "turn_on":
    case "turn_off":
    case "toggle":
    case "set_state":
      return ["climate", "fan", "input_boolean", "light", "media_player", "switch"].includes(domain);
    case "open":
    case "close":
      return domain === "cover";
    case "lock":
    case "unlock":
      return domain === "lock";
    case "dock":
      return domain === "vacuum";
    case "pause":
    case "resume":
      return domain === "media_player" || domain === "vacuum";
    case "start":
    case "stop":
      return ["fan", "media_player", "switch", "vacuum"].includes(domain);
  }
}

export function hasEntityActionDeviceLanguage(value: string): boolean {
  const normalized = normalizeTargetText(value);
  return new RegExp(String.raw`(?:^|\s)${DEVICE_ACTION_PATTERN}$`).test(normalized)
    || /^(?:house|home|everywhere)$/.test(normalized);
}

function cleanTargetText(value: string): string | null {
  const referentialSurface = normalizeReferenceTargetText(value);
  const determinedGeneric = /^(the|my|our|your)\s+(.+)$/.exec(referentialSurface);
  let clean = normalizeTargetText(value);
  for (let index = 0; index < 4; index += 1) {
    const hasUniversalPrefix = /^(?:all|each|every|everything)\b/.test(clean);
    const preserveUniversal = hasUniversalPrefix
      && (hasReferenceExclusion(clean) || !isWholeHouseLightCollectionReference(clean));
    const quantifierClean = preserveUniversal
      ? clean
      : clean.replace(/^(?:all|each|every)\s+(?:of\s+)?/g, " ");
    const next = quantifierClean
      .replace(/^(?:what(?:s| is)|showing for|status of)\b/g, " ")
      .replace(/\b(?:please|again|too|definitely)\b$/g, " ")
      .replace(/\bfor me\b$/g, " ")
      .replace(/\bonce more\b$/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (next === clean) break;
    clean = next;
  }
  if (!clean) {
    return null;
  }
  if (determinedGeneric?.[1]
    && determinedGeneric[2]
    && isGenericActionTargetDescriptor(determinedGeneric[2])) {
    return `${determinedGeneric[1]} ${normalizeTargetText(determinedGeneric[2])}`;
  }
  return clean;
}

function parsePreposedReferenceQuantifier(value: string): {
  readonly targetText: string;
  readonly expectedCardinality: number | null;
  readonly forceUnderspecified: boolean;
  readonly universal: boolean;
} {
  const match = /^(all|each|every|both|either|neither|any|no|none|zero|a|an|some|several|few|most|many|half|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:(of)\s+)?(?:the\s+)?(.+)$/.exec(value);
  if (!match) {
    return { targetText: value, expectedCardinality: null, forceUnderspecified: false, universal: false };
  }
  const quantifier = match[1] ?? "";
  const hasPartitive = match[2] === "of";
  const targetText = match[3]?.trim() ?? "";
  const pureAnaphor = /^(?:it|them|they|their(?: state)?|one|ones)$/.test(targetText);
  const malformedAnaphoricComplement = pureAnaphor
    && (!hasPartitive || /^(?:it|one)$/.test(targetText));
  const cardinalities: Readonly<Record<string, number>> = {
    both: 2,
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  const numericCardinality = /^\d+$/.test(quantifier) ? Number.parseInt(quantifier, 10) : null;
  return {
    targetText,
    expectedCardinality: cardinalities[quantifier] ?? numericCardinality,
    forceUnderspecified: [
      "either", "neither", "any", "no", "none", "zero", "a", "an", "some", "several", "few", "most", "many", "half",
    ].includes(quantifier) || malformedAnaphoricComplement,
    universal: ["all", "each", "every"].includes(quantifier),
  };
}

function parseLeadingReferenceDescriptor(value: string): {
  readonly descriptor: string;
  readonly expectedCardinality: number | null;
  readonly forceUnderspecified: boolean;
  readonly matched: boolean;
  readonly modifier: string | null;
} {
  const match = /^(all|both|either|neither|any|anything|everything|no|none|nothing|something|whatever|whichever|each|every|zero|a|an|some|several|few|most|many|half|one|two|three|four|five|six|seven|eight|nine|ten|\d+|another|other|others|rest|remaining|remainder|balance|next|previous|first|second|third|fourth|fifth|last|exact|specific)(?:\s+(.+))?$/.exec(value);
  if (!match) {
    return { descriptor: value, expectedCardinality: null, forceUnderspecified: false, matched: false, modifier: null };
  }
  const modifier = match[1] ?? "";
  const descriptor = match[2]?.trim() ?? "";
  const cardinalities: Readonly<Record<string, number>> = {
    both: 2,
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  const numericCardinality = /^\d+$/.test(modifier) ? Number.parseInt(modifier, 10) : null;
  return {
    descriptor,
    expectedCardinality: cardinalities[modifier] ?? numericCardinality,
    forceUnderspecified: [
      "either", "neither", "any", "anything", "everything", "no", "none", "nothing", "something", "whatever", "whichever", "zero",
      "a", "an", "some", "several", "few", "most", "many", "half", "another", "other", "next", "previous",
      "others", "rest", "remaining", "remainder", "balance",
      "first", "second", "third", "fourth", "fifth", "last",
    ].includes(modifier)
      || (["exact", "specific"].includes(modifier)
        && (!descriptor || isGenericActionTargetDescriptor(descriptor))),
    matched: true,
    modifier,
  };
}

function classifyAnaphoricTarget(
  value: string,
  expectedCardinality: number | null,
): DemonstrativeTargetReference | null {
  if (/^(?:it|them|they|their(?: state)?|one|ones)$/.test(value)) {
    const singular = /^(?:it|one)$/.test(value) ? 1 : null;
    return {
      kind: "contextual",
      descriptor: null,
      expectedCardinality: expectedCardinality ?? singular,
      minimumCardinality: /^(?:them|they|their(?: state)?|ones)$/.test(value) ? 2 : null,
      singularPersonAllowed: expectedCardinality === null
        && /^(?:them|they|their(?: state)?)$/.test(value),
    };
  }
  const postposed = /^(them|they|ones)\s+(all|both)$/.exec(value);
  if (postposed) {
    return {
      kind: "contextual",
      descriptor: null,
      expectedCardinality: postposed[2] === "both" ? 2 : expectedCardinality,
      minimumCardinality: 2,
      singularPersonAllowed: false,
    };
  }
  if (/^(?:it|them|they|their|one|ones)\s+/.test(value)) {
    return { kind: "underspecified", descriptor: value };
  }
  return null;
}

function isWholeHouseLightCollectionReference(value: string): boolean {
  return /^(?:all|each|every)\s+(?:of\s+)?(?:the\s+)?(?:(?:house|home)\s+)?(?:lights?|lighting)$/.test(value);
}

function impliedSingularReferenceCardinality(value: string): number | null {
  const normalized = normalizeTargetText(value);
  if (!normalized || /(?:s|lighting)$/.test(normalized)) {
    return null;
  }
  return isGenericActionTargetDescriptor(normalized) ? 1 : null;
}

function impliedPluralReferenceCardinality(value: string): number | null {
  const normalized = normalizeTargetText(value);
  return new RegExp(String.raw`^${DEVICE_PLURAL_PATTERN}$`).test(normalized)
    ? 2
    : null;
}

function normalizeDeicticDescriptor(value: string): {
  readonly descriptor: string;
  readonly forceUnderspecified: boolean;
} {
  const descriptor = value.replace(/^very\s+(?=same\b)/, "").trim();
  return {
    descriptor,
    forceUnderspecified: /\b(?:(?:right\s+)?here|(?:over\s+)?there)$/.test(descriptor),
  };
}

function hasReferenceExclusion(value: string): boolean {
  return /(?:\b(?:but|except|excepting|excluding|minus|not|without)\b|\b(?:other\s+than|apart\s+from|save\s+for)\b|\bwith\s+the\s+exception\s+of\b)/.test(value);
}

/** The terminal-state fallback has no explicit action head, so its captured frame must prove positive polarity. */
function hasNonPositiveDesiredStateFraming(value: string): boolean {
  return /\b(?:not|never|cannot|dont|wont|cant|shouldnt|mustnt|couldnt|wouldnt|neednt|mightnt)\b|\b(?:shouldn|mustn|couldn|wouldn|needn|mightn)\s+t\b/.test(value)
    || /\b(?:is|are|was|were|be|been|being)$/.test(value)
    || hasNonAssertiveRoutingFrame(value);
}

function stripTrailingActionAspect(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (/(?:\b(?:at|in|from|near|toward|towards|down)\s+(?:the\s+)?back|\bout\s+back)$/i.test(clean)) {
    return clean;
  }
  return clean.replace(/\s+(?:back|again)$/i, "").trim();
}

function isWholeHouseLightActionTarget(
  rawTarget: string,
  semanticClause: string,
  operation: EntityActionOperation,
): boolean {
  const target = normalizeReferenceTargetText(rawTarget);
  const explicitLightCollection = /^(?:all|each|every)\s+(?:of\s+)?(?:the\s+)?(?:(?:house|home)\s+)?(?:lights?|lighting)$/.test(target);
  const namedHouseLights = /^(?:the\s+)?(?:house|home)\s+(?:lights?|lighting)$/.test(target);
  const explicitLocationSuffix = /^(?:the\s+)?(?:lights?|lighting)$/.test(target)
    && /\s+(?:everywhere|around\s+(?:the\s+)?(?:house|home))$/.test(semanticClause);
  const activeLightCleanup = operation === "turn_off"
    && /^any\s+(?:of\s+)?(?:the\s+)?lights?$/.test(target)
    && /\b(?:lights?\s+(?:i|we)\s+(?:left|leave|had)\s+on|lights?\s+that\s+(?:are|were)\s+(?:still\s+)?on)\b/.test(semanticClause);
  return explicitLightCollection || namedHouseLights || explicitLocationSuffix || activeLightCleanup;
}

function isWholeHouseLightingStateTarget(rawTarget: string, rawState: string): boolean {
  return /^(?:the\s+)?(?:house|home)$/.test(normalizeReferenceTargetText(rawTarget))
    && /^(?:dark|lit)$/.test(rawState);
}

function stripTrailingActionModifiers(value: string): string {
  let clean = value.replace(/\s+/g, " ").trim();
  for (let index = 0; index < 10; index += 1) {
    const next = clean.replace(
      householdRegex(String.raw`\s+(?:as soon as you can|when you get a chance|at the moment|right now|once more|thank you|would you|could you|can you|will you|if you can|when you can|for me|for us|straight away|real quick|please|again|then|now|too|definitely|quickly|thanks|cheers|mate|{ASSISTANT}|ta)$`, "i"),
      "",
    ).trim();
    if (next === clean) {
      break;
    }
    clean = next;
  }
  return clean;
}

function normalizeTargetText(value: string): string {
  return normalizeReferenceTargetText(value)
    .replace(/\b(the|my)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeReferenceTargetText(value: string): string {
  return stripStatusFiller(normalize(value))
    .replace(/\bsensors?\b$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
