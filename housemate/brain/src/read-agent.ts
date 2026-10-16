import type {
  ReadAgentClause,
  ReadAgentEvidence,
  ReadAgentModelProvider,
  ReadAgentModelStep,
  ReadAgentProvider,
  ReadAgentRecoveryRequest,
  ReadAgentRecoveryResult,
  ReadAgentToolCall,
} from "./read-agent-contracts.js";
import { projectReadAgentEvidenceForModel } from "./read-agent-evidence-projection.js";
import type { ReadAgentToolSession } from "./read-agent-tools.js";
import { boundedInteger } from "./value-guards.js";
import { abortError } from "./abort-error.js";
import { replaceControlCharacters } from "./text-format.js";
import { HOUSE_LOCALE } from "./house-config.js";

type ReadAgentToolSessionPort = Pick<
  ReadAgentToolSession,
  "execute" | "revalidate" | "refresh"
> & Partial<Pick<
  ReadAgentToolSession,
  "revalidateFresh" | "revalidationCost"
>>;

interface ReadAgentToolSessionFactoryOptions {
  readonly signal: AbortSignal;
}

export interface BoundedReadAgentOptions {
  readonly modelProvider: ReadAgentModelProvider;
  readonly createToolSession: (
    request: ReadAgentRecoveryRequest,
    options: ReadAgentToolSessionFactoryOptions,
  ) => ReadAgentToolSessionPort;
  readonly wallTimeoutMs?: number;
  readonly evidenceByteLimit?: number;
}

const MAX_MODEL_ROUNDS = 3;
const MAX_MODEL_TOOL_CALLS = 6;
const MAX_FRESHNESS_CALLS = MAX_MODEL_TOOL_CALLS * 3;
const MAX_PARALLEL_TOOL_CALLS = 3;
const MAX_FINAL_CLAUSES = 3;
const MAX_FINAL_FACTS = 4;
const MAX_FINAL_TEXT_LENGTH = 420;
// A planning round at low effort takes ~2-4 s; three rounds and the verdict
// fit well inside this, and a voice turn should not wait longer.
const DEFAULT_WALL_TIMEOUT_MS = 15_000;
/** Readable search matches whose current state software reads with the search. */
const SEARCH_STATE_ENTITY_LIMIT = 4;
const DEFAULT_EVIDENCE_BYTE_LIMIT = 16 * 1024;

export class BoundedReadAgent implements ReadAgentProvider {
  private readonly modelProvider: ReadAgentModelProvider;
  private readonly createToolSession: (
    request: ReadAgentRecoveryRequest,
    options: ReadAgentToolSessionFactoryOptions,
  ) => ReadAgentToolSessionPort;
  private readonly wallTimeoutMs: number;
  private readonly evidenceByteLimit: number;

  constructor(options: BoundedReadAgentOptions) {
    this.modelProvider = options.modelProvider;
    this.createToolSession = options.createToolSession;
    this.wallTimeoutMs = boundedInteger(
      options.wallTimeoutMs ?? DEFAULT_WALL_TIMEOUT_MS,
      1,
      120_000,
      "read agent wall timeout",
    );
    this.evidenceByteLimit = boundedInteger(
      options.evidenceByteLimit ?? DEFAULT_EVIDENCE_BYTE_LIMIT,
      1_024,
      256 * 1024,
      "read agent evidence byte limit",
    );
  }

  async recover(request: ReadAgentRecoveryRequest): Promise<ReadAgentRecoveryResult | null> {
    const startedAtMs = Date.now();
    const deadlineMs = startedAtMs + this.wallTimeoutMs;
    const modelAbortController = new AbortController();
    let session: ReadAgentToolSessionPort;
    try {
      session = this.createToolSession(request, {
        signal: modelAbortController.signal,
      });
    } catch {
      return null;
    }

    let evidence: readonly ReadAgentEvidence[] = [];
    let toolCallCount = 0;
    let freshnessCallCount = 0;
    let refreshUsed = false;
    const seenCallIds = new Set<string>();
    const seenCallSignatures = new Set<string>();

    try {
      if (!this.modelProvider.unavailableReason?.()) {
        try {
          request.beforePlanning?.();
        } catch {
          // The holding line is a courtesy; it never changes the read.
        }
      }
      for (let round = 1; round <= MAX_MODEL_ROUNDS; round += 1) {
        const step = await withinDeadline(
          this.modelProvider.next(
            {
              turnId: request.turnId,
              transcript: request.transcript,
              requestedAt: request.requestedAt,
              fallbackRoute: request.fallbackRoute,
              fallbackReason: request.fallbackReason,
              ownPresenceWindow: request.ownPresenceWindow,
              canonicalTimeWindow: request.canonicalTimeWindow,
              contextQuestions: request.contextQuestions,
              round,
              maxRounds: MAX_MODEL_ROUNDS,
              remainingToolCalls: MAX_MODEL_TOOL_CALLS - toolCallCount,
              evidence,
            },
            { signal: modelAbortController.signal },
          ),
          deadlineMs,
          modelAbortController,
        );

        if (step.decision === "tool_calls") {
          validateToolBatch(
            step,
            seenCallIds,
            seenCallSignatures,
            toolCallCount,
          );
          if (round === MAX_MODEL_ROUNDS) {
            // No round is left to read the results: stop before running them.
            break;
          }
          const batch = step.tool_calls;
          const results = await withinDeadline(
            Promise.all(batch.map((call) => session.execute(call))),
            deadlineMs,
            modelAbortController,
          );
          toolCallCount += batch.length;
          evidence = appendUniqueEvidence(evidence, results);
          // Most reads are "find it, then read it": software reads the found
          // entities' current state now, so the next plan can already answer
          // instead of spending a round asking for get_states.
          const stateCall = searchStateCall(results, round);
          if (stateCall) {
            seenCallIds.add(stateCall.call_id);
            evidence = appendUniqueEvidence(evidence, [
              await withinDeadline(session.execute(stateCall), deadlineMs, modelAbortController),
            ]);
          }
          if (!evidenceFits(evidence, this.evidenceByteLimit)) {
            return usefulLimitation(
              request,
              evidence,
              "I found more source data than I can safely verify in one answer.",
              toolCallCount,
              freshnessCallCount,
              round,
              startedAtMs,
            );
          }
          continue;
        }

        const localValidation = validateFinalClauses(step, evidence);
        if (!localValidation.valid) {
          return null;
        }
        if (step.decision === "decline") {
          const beforeDecline = await refreshChangedDiscreteEvidence({
            session,
            evidence,
            deadlineMs,
            refreshUsed,
            toolCallCount,
            freshnessCallCount,
            abortController: modelAbortController,
            reserveForFinalPass: false,
          });
          freshnessCallCount = beforeDecline.freshnessCallCount;
          if (beforeDecline.status === "changed") {
            evidence = beforeDecline.evidence;
            refreshUsed = true;
            if (!evidenceFits(evidence, this.evidenceByteLimit)) {
              return usefulLimitation(
                request,
                evidence,
                "The refreshed source data is too large to verify safely in one answer.",
                toolCallCount,
                freshnessCallCount,
                round,
                startedAtMs,
              );
            }
            continue;
          }
          if (beforeDecline.status === "unavailable") {
            return usefulLimitation(
              request,
              evidence,
              "The live source became unavailable while I was checking it.",
              toolCallCount,
              freshnessCallCount,
              round,
              startedAtMs,
            );
          }
          if (beforeDecline.status === "unstable") {
            return usefulLimitation(
              request,
              evidence,
              "The live state kept changing while I was checking it.",
              toolCallCount,
              freshnessCallCount,
              round,
              startedAtMs,
            );
          }
          return usefulLimitation(
            request,
            beforeDecline.evidence,
            limitationFromEvidence(beforeDecline.evidence),
            toolCallCount,
            freshnessCallCount,
            round,
            startedAtMs,
          );
        }
        const citedEvidenceIds = evidenceIdsForClauses(step.clauses);

        const beforeVerification = await refreshChangedDiscreteEvidence({
          session,
          evidence,
          deadlineMs,
          refreshUsed,
          toolCallCount,
          freshnessCallCount,
          abortController: modelAbortController,
          reserveForFinalPass: true,
        });
        freshnessCallCount = beforeVerification.freshnessCallCount;
        if (beforeVerification.status === "unavailable") {
          return usefulLimitation(
            request,
            evidence,
            "The live source became unavailable while I was checking it.",
            beforeVerification.toolCallCount,
            beforeVerification.freshnessCallCount,
            round,
            startedAtMs,
          );
        }
        if (beforeVerification.status === "unstable") {
          return usefulLimitation(
            request,
            evidence,
            "The live state kept changing while I was checking it, so I won't pretend the old answer is current.",
            toolCallCount,
            freshnessCallCount,
            round,
            startedAtMs,
          );
        }
        if (beforeVerification.status === "changed") {
          if (!evidenceFits(beforeVerification.evidence, this.evidenceByteLimit)) {
            return usefulLimitation(
              request,
              beforeVerification.evidence,
              "The refreshed source data is too large to verify safely in one answer.",
              beforeVerification.toolCallCount,
              beforeVerification.freshnessCallCount,
              round,
              startedAtMs,
            );
          }
          evidence = beforeVerification.evidence;
          toolCallCount = beforeVerification.toolCallCount;
          refreshUsed = true;
          continue;
        }

        const verification = await withinDeadline(
          this.modelProvider.verify(
            {
              turnId: request.turnId,
              transcript: request.transcript,
              clauses: step.clauses,
              evidence,
            },
            { signal: modelAbortController.signal },
          ),
          deadlineMs,
          modelAbortController,
        );
        if (verification.verdict !== "supported") {
          return null;
        }

        const afterVerification = await refreshChangedDiscreteEvidence({
          session,
          evidence,
          deadlineMs,
          refreshUsed,
          toolCallCount,
          freshnessCallCount,
          abortController: modelAbortController,
          reserveForFinalPass: false,
        });
        freshnessCallCount = afterVerification.freshnessCallCount;
        if (afterVerification.status === "unavailable") {
          return usefulLimitation(
            request,
            evidence,
            "The live source became unavailable before I could finish checking the answer.",
            toolCallCount,
            freshnessCallCount,
            round,
            startedAtMs,
          );
        }
        if (afterVerification.status === "unstable") {
          return usefulLimitation(
            request,
            evidence,
            "The live state kept changing before I could finish checking the answer.",
            toolCallCount,
            freshnessCallCount,
            round,
            startedAtMs,
          );
        }
        if (afterVerification.status === "changed") {
          // Verification approved the old snapshot. Never spend a second
          // verifier call trying to rescue it: the evidence changed after the
          // verdict, so the only honest bounded response is a limitation.
          return usefulLimitation(
            request,
            afterVerification.evidence,
            "The live state changed after verification, so I won't pretend the old answer is current.",
            afterVerification.toolCallCount,
            afterVerification.freshnessCallCount,
            round,
            startedAtMs,
          );
        }

        const finalEvidence = evidence.filter((item) =>
          citedEvidenceIds.has(item.evidenceId));
        const text = speechFromClauses(
          step.clauses,
          finalEvidence,
          request.finalFraming,
        );
        return {
          status: step.decision === "answer" ? "answered" : "declined",
          text,
          confidence: step.confidence,
          evidence: finalEvidence,
          modelUsed: true,
          notes: [
            "bounded read agent",
            `rounds=${round}`,
            `model_tool_calls=${toolCallCount}`,
            `freshness_calls=${freshnessCallCount}`,
            `evidence=${evidence.length}`,
            `refreshed=${refreshUsed}`,
            `latency_ms=${Math.max(0, Date.now() - startedAtMs)}`,
            ...(step.decision === "answer"
              ? [missingCodeRouteNote(request, step.clauses, finalEvidence)]
              : []),
          ].join("; "),
        };
      }

      return evidence.length > 0
        ? usefulLimitation(
            request,
            evidence,
            "I checked the available sources but couldn't establish a supported answer within the read-only limit.",
            toolCallCount,
            freshnessCallCount,
            MAX_MODEL_ROUNDS,
            startedAtMs,
          )
        : null;
    } catch {
      return null;
    } finally {
      if (!modelAbortController.signal.aborted) {
        modelAbortController.abort(abortError("read agent run finished"));
      }
    }
  }
}

type RefreshResult =
  | {
      readonly status: "valid";
      readonly evidence: readonly ReadAgentEvidence[];
      readonly toolCallCount: number;
      readonly freshnessCallCount: number;
    }
  | {
      readonly status: "changed";
      readonly evidence: readonly ReadAgentEvidence[];
      readonly toolCallCount: number;
      readonly freshnessCallCount: number;
    }
  | {
      readonly status: "unavailable";
      readonly evidence: readonly ReadAgentEvidence[];
      readonly toolCallCount: number;
      readonly freshnessCallCount: number;
    }
  | {
      readonly status: "unstable";
      readonly evidence: readonly ReadAgentEvidence[];
      readonly toolCallCount: number;
      readonly freshnessCallCount: number;
    };

async function refreshChangedDiscreteEvidence(options: {
  readonly session: ReadAgentToolSessionPort;
  readonly evidence: readonly ReadAgentEvidence[];
  readonly deadlineMs: number;
  readonly refreshUsed: boolean;
  readonly toolCallCount: number;
  readonly freshnessCallCount: number;
  readonly abortController: AbortController;
  readonly reserveForFinalPass: boolean;
}): Promise<RefreshResult> {
  const stateEvidence = options.evidence.filter((item) =>
    item.status === "ok" || item.status === "empty");
  if (stateEvidence.length === 0) {
    return {
      status: "valid",
      evidence: options.evidence,
      toolCallCount: options.toolCallCount,
      freshnessCallCount: options.freshnessCallCount,
    };
  }

  const plannedProbeCost = stateEvidence.reduce(
    (total, item) =>
      total + (options.session.revalidationCost?.(item) ?? 0),
    0,
  );
  const reservedFinalCost = options.reserveForFinalPass
    ? plannedProbeCost
    : 0;
  if (
    options.freshnessCallCount + plannedProbeCost + reservedFinalCost
    > MAX_FRESHNESS_CALLS
  ) {
    return {
      status: "unstable",
      evidence: options.evidence,
      toolCallCount: options.toolCallCount,
      freshnessCallCount: options.freshnessCallCount,
    };
  }

  const checks: Array<{
    readonly original: ReadAgentEvidence;
    readonly result: ReturnType<ReadAgentToolSession["revalidate"]>;
  }> = [];
  for (
    let offset = 0;
    offset < stateEvidence.length;
    offset += MAX_PARALLEL_TOOL_CALLS
  ) {
    const batch = stateEvidence.slice(
      offset,
      offset + MAX_PARALLEL_TOOL_CALLS,
    );
    const results = await withinDeadline(
      Promise.all(batch.map(async (item) => {
        if (
          (options.session.revalidationCost?.(item) ?? 0) > 0
          && options.session.revalidateFresh
        ) {
          return options.session.revalidateFresh(item);
        }
        return options.session.revalidate(item);
      })),
      options.deadlineMs,
      options.abortController,
    );
    checks.push(...batch.map((original, index) => ({
      original,
      result: results[index] as ReturnType<
        ReadAgentToolSession["revalidate"]
      >,
    })));
  }
  const probeCallsUsed = checks.reduce(
    (total, check) => total + (check.result.toolCallsUsed ?? 0),
    0,
  );
  const checkedFreshnessCallCount =
    options.freshnessCallCount + probeCallsUsed;
  if (checkedFreshnessCallCount > MAX_FRESHNESS_CALLS) {
    return {
      status: "unstable",
      evidence: options.evidence,
      toolCallCount: options.toolCallCount,
      freshnessCallCount: options.freshnessCallCount,
    };
  }
  if (checks.some((check) => check.result.status === "unavailable")) {
    return {
      status: "unavailable",
      evidence: options.evidence,
      toolCallCount: options.toolCallCount,
      freshnessCallCount: checkedFreshnessCallCount,
    };
  }
  const changed = checks.filter((check) => check.result.status === "changed");
  if (changed.length === 0) {
    return {
      status: "valid",
      evidence: options.evidence,
      toolCallCount: options.toolCallCount,
      freshnessCallCount: checkedFreshnessCallCount,
    };
  }
  if (options.refreshUsed) {
    return {
      status: "unstable",
      evidence: options.evidence,
      toolCallCount: options.toolCallCount,
      freshnessCallCount: checkedFreshnessCallCount,
    };
  }

  const replacements = new Map<string, ReadAgentEvidence>();
  const needsRefresh = changed.filter((check) => {
    if (check.result.freshEvidence) {
      replacements.set(
        check.original.evidenceId,
        check.result.freshEvidence,
      );
      return false;
    }
    return true;
  });
  if (
    checkedFreshnessCallCount + needsRefresh.length
    > MAX_FRESHNESS_CALLS
  ) {
    return {
      status: "unstable",
      evidence: options.evidence,
      toolCallCount: options.toolCallCount,
      freshnessCallCount: checkedFreshnessCallCount,
    };
  }
  const refreshed: ReadAgentEvidence[] = [];
  for (
    let offset = 0;
    offset < needsRefresh.length;
    offset += MAX_PARALLEL_TOOL_CALLS
  ) {
    const batch = needsRefresh.slice(
      offset,
      offset + MAX_PARALLEL_TOOL_CALLS,
    );
    refreshed.push(...await withinDeadline(
      Promise.all(batch.map((check) =>
        options.session.refresh(check.original))),
      options.deadlineMs,
      options.abortController,
    ));
  }
  needsRefresh.forEach((check, index) => {
    replacements.set(
      check.original.evidenceId,
      refreshed[index] as ReadAgentEvidence,
    );
  });
  const nextEvidence = appendUniqueEvidence(
    options.evidence
      .map((item) => replacements.get(item.evidenceId) ?? item),
    [],
  );
  if (
    [...replacements.values()].some((item) =>
      item.status !== "ok" && item.status !== "empty")
  ) {
    return {
      status: "unavailable",
      evidence: nextEvidence,
      toolCallCount: options.toolCallCount,
      freshnessCallCount:
        checkedFreshnessCallCount + needsRefresh.length,
    };
  }
  return {
    status: "changed",
    evidence: nextEvidence,
    toolCallCount: options.toolCallCount,
    freshnessCallCount:
      checkedFreshnessCallCount + needsRefresh.length,
  };
}

function validateToolBatch(
  step: Extract<ReadAgentModelStep, { readonly decision: "tool_calls" }> | ReadAgentModelStep,
  seenCallIds: Set<string>,
  seenCallSignatures: Set<string>,
  priorToolCalls: number,
): void {
  const calls = step.tool_calls;
  if (calls.length === 0) {
    throw new Error("read agent requested an empty tool batch");
  }
  if (calls.length > MAX_PARALLEL_TOOL_CALLS) {
    throw new Error("read agent parallel tool limit exceeded");
  }
  if (priorToolCalls + calls.length > MAX_MODEL_TOOL_CALLS) {
    throw new Error("read agent total tool limit exceeded");
  }

  for (const call of calls) {
    if (seenCallIds.has(call.call_id)) {
      throw new Error("read agent repeated a call id");
    }
    const signature = toolCallSignature(call);
    if (seenCallSignatures.has(signature)) {
      throw new Error("read agent repeated or cycled a tool call");
    }
    seenCallIds.add(call.call_id);
    seenCallSignatures.add(signature);
  }
}

function toolCallSignature(call: ReadAgentToolCall): string {
  return JSON.stringify({
    name: call.name,
    query: normalizedOptional(call.query),
    entity_ids: [...call.entity_ids].map(normalizedRequired).sort(),
    start: normalizedOptional(call.start),
    end: normalizedOptional(call.end),
    limit: call.limit,
    domain: normalizedOptional(call.domain),
    area: normalizedOptional(call.area),
    mode: call.mode,
    period: call.period,
    types: [...call.types].sort(),
    statuses: [...call.statuses].map(normalizedRequired).sort(),
    media_kind: call.media_kind,
    media_filter: call.media_filter,
  });
}

function validateFinalClauses(
  step: ReadAgentModelStep,
  evidence: readonly ReadAgentEvidence[],
): { readonly valid: boolean } {
  if (step.decision === "tool_calls") {
    return { valid: false };
  }
  if (step.clauses.length === 0 || step.clauses.length > MAX_FINAL_CLAUSES) {
    return { valid: false };
  }
  if (step.decision === "decline" && step.clauses.some((clause) => clause.kind !== "limitation")) {
    return { valid: false };
  }
  if (step.decision === "answer" && step.clauses.some((clause) => clause.kind === "limitation")) {
    return { valid: false };
  }
  if (
    step.decision === "answer"
    && !step.clauses.some((clause) => clause.kind === "fact" || clause.kind === "inference")
  ) {
    return { valid: false };
  }

  return { valid: validateClausesAgainstEvidence(step.clauses, evidence) };
}

function validateClausesAgainstEvidence(
  clauses: readonly ReadAgentClause[],
  evidence: readonly ReadAgentEvidence[],
): boolean {
  const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]));
  const factById = new Map(evidence.flatMap((item) =>
    item.facts.map((fact) => [fact.factId, { fact, evidence: item }] as const)));
  const allSelectedFactIds = new Set<string>();
  for (const clause of clauses) {
    const uniqueIds = [...new Set(clause.evidence_ids)];
    const uniqueFactIds = [...new Set(clause.fact_ids)];
    if (uniqueIds.length !== clause.evidence_ids.length) {
      return false;
    }
    if (uniqueFactIds.length !== clause.fact_ids.length) {
      return false;
    }
    if (clause.kind === "limitation") {
      if (clause.fact_ids.length > 0 || clause.inference_kind !== "none") {
        return false;
      }
      if (uniqueIds.some((id) => !evidenceById.has(id))) {
        return false;
      }
      continue;
    }
    if (clause.kind === "fact" && clause.inference_kind !== "none") {
      return false;
    }
    if (
      clause.kind === "inference"
      && (
        clause.inference_kind === "none"
        || !inferenceKindFitsFacts(
          clause.inference_kind,
          uniqueFactIds,
          factById,
        )
      )
    ) {
      return false;
    }
    if (uniqueFactIds.length === 0) {
      return false;
    }
    uniqueFactIds.forEach((id) => allSelectedFactIds.add(id));
    if (allSelectedFactIds.size > MAX_FINAL_FACTS) {
      return false;
    }
    const selectedFacts = uniqueFactIds.map((id) => factById.get(id) ?? null);
    if (selectedFacts.some((selected) => selected === null)) {
      return false;
    }
    const owningEvidenceIds = [...new Set(selectedFacts
      .filter((selected): selected is NonNullable<typeof selected> => selected !== null)
      .map((selected) => selected.evidence.evidenceId))].sort();
    if (
      owningEvidenceIds.length !== uniqueIds.length
      || owningEvidenceIds.some((id, index) => id !== [...uniqueIds].sort()[index])
    ) {
      return false;
    }
    if (clause.kind === "fact" || clause.kind === "inference") {
      if (uniqueIds.length === 0) {
        return false;
      }
      if (uniqueIds.some((id) => {
        const cited = evidenceById.get(id);
        return !cited
          || (cited.status !== "ok" && cited.status !== "empty")
          || cited.truncated;
      })) {
        return false;
      }
    }
  }
  return true;
}

function speechFromClauses(
  clauses: readonly ReadAgentClause[],
  evidence: readonly ReadAgentEvidence[],
  framing: ReadAgentRecoveryRequest["finalFraming"],
): string {
  const factById = new Map(evidence.flatMap((item) =>
    item.facts.map((fact) => [fact.factId, fact.text] as const)));
  const segments: {
    readonly kind: "fact" | "inference";
    readonly text: string;
  }[] = [];
  const spokenFactIds = new Set<string>();
  const spokenInferenceKinds = new Set<ReadAgentClause["inference_kind"]>();
  for (const clause of clauses) {
    if (clause.kind === "fact" || clause.kind === "inference") {
      for (const factId of clause.fact_ids) {
        if (spokenFactIds.has(factId)) {
          continue;
        }
        const fact = factById.get(factId);
        if (!fact) {
          throw new Error("read agent selected a missing software fact");
        }
        spokenFactIds.add(factId);
        segments.push({ kind: "fact", text: sentence(fact) });
      }
    }
    if (
      clause.kind === "inference"
      && !spokenInferenceKinds.has(clause.inference_kind)
    ) {
      spokenInferenceKinds.add(clause.inference_kind);
      segments.push({
        kind: "inference",
        text: sentence(renderInference(clause.inference_kind)),
      });
    }
  }

  if (segments.length === 0) {
    throw new Error("read agent final text is empty");
  }
  const speechPrefix = finalSpeechPrefix(framing);
  const separatorBudget = segments.length - 1;
  const contentBudget = MAX_FINAL_TEXT_LENGTH
    - speechPrefix.length
    - separatorBudget;
  const inferenceSegments = segments.filter((segment) =>
    segment.kind === "inference");
  const factSegments = segments.filter((segment) => segment.kind === "fact");
  const inferenceBudget = Math.min(
    inferenceSegments.reduce((total, segment) => total + segment.text.length, 0),
    Math.max(0, contentBudget - factSegments.length),
  );
  const fittedInferences = fitSpeechSegments(
    inferenceSegments.map((segment) => segment.text),
    inferenceBudget,
  );
  const factBudget = contentBudget
    - fittedInferences.reduce((total, text) => total + text.length, 0);
  const fittedFacts = fitSpeechSegments(
    factSegments.map((segment) => segment.text),
    factBudget,
  );
  let factIndex = 0;
  let inferenceIndex = 0;
  const body = segments.map((segment) =>
    segment.kind === "fact"
      ? fittedFacts[factIndex++] ?? ""
      : fittedInferences[inferenceIndex++] ?? ""
  ).filter(Boolean).join(" ");
  const text = `${speechPrefix}${body}`;
  if (!body || text.length > MAX_FINAL_TEXT_LENGTH) {
    throw new Error("read agent final text could not fit its code-owned budget");
  }
  return text;
}

function finalSpeechPrefix(
  framing: ReadAgentRecoveryRequest["finalFraming"],
): string {
  return framing.kind === "deterministic_lead"
    ? `${sentence(trustedDeterministicLead(framing.text))} `
    : "";
}

function trustedDeterministicLead(value: string): string {
  const text = value.trim();
  if (
    !text
    || text.length > 280
    || [...text].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new Error("read agent deterministic lead is invalid");
  }
  return text;
}

function fitSpeechSegments(
  values: readonly string[],
  totalBudget: number,
): readonly string[] {
  if (values.length === 0) {
    return [];
  }
  if (totalBudget < values.length) {
    throw new Error("read agent final text budget cannot represent every selected clause");
  }
  const allocations = new Array<number>(values.length).fill(0);
  let remainingBudget = totalBudget;
  let pending = values.map((_value, index) => index);
  while (pending.length > 0) {
    const fairShare = Math.floor(remainingBudget / pending.length);
    const fitting = pending.filter((index) => values[index]!.length <= fairShare);
    if (fitting.length === 0) {
      pending.forEach((index, offset) => {
        allocations[index] = fairShare + (offset < remainingBudget % pending.length ? 1 : 0);
      });
      break;
    }
    for (const index of fitting) {
      allocations[index] = values[index]!.length;
      remainingBudget -= allocations[index]!;
    }
    const fitted = new Set(fitting);
    pending = pending.filter((index) => !fitted.has(index));
  }
  return values.map((value, index) =>
    truncateSpeechSentence(value, allocations[index] ?? 0));
}

function truncateSpeechSentence(value: string, maximum: number): string {
  if (value.length <= maximum) {
    return value;
  }
  if (maximum <= 1) {
    return "…".slice(0, maximum);
  }
  const target = maximum - 1;
  const codePointSafe = Array.from(value).reduce((result, character) =>
    result.length + character.length <= target
      ? `${result}${character}`
      : result, "");
  const lastSpace = codePointSafe.lastIndexOf(" ");
  const wordSafe = lastSpace >= Math.min(24, Math.floor(target / 2))
    ? codePointSafe.slice(0, lastSpace)
    : codePointSafe;
  const clean = wordSafe.trimEnd().replace(/[,:;.!?]+$/u, "");
  return `${clean.slice(0, target)}…`;
}

function sentence(value: string): string {
  const clean = replaceControlCharacters(value)
    .replaceAll(/\s+/g, " ")
    .trim();
  if (!clean) {
    throw new Error("read agent clause text is empty");
  }
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

function inferenceKindFitsFacts(
  inferenceKind: ReadAgentClause["inference_kind"],
  factIds: readonly string[],
  factById: ReadonlyMap<
    string,
    {
      readonly fact: ReadAgentEvidence["facts"][number];
      readonly evidence: ReadAgentEvidence;
    }
  >,
): boolean {
  const selected = factIds
    .map((factId) => factById.get(factId) ?? null)
    .filter((item): item is NonNullable<typeof item> => item !== null);
  if (selected.length !== factIds.length) {
    return false;
  }
  if (selected.some((item) => item.evidence.status !== "ok")) {
    return false;
  }
  const tools = new Set(selected.map((item) => item.evidence.tool));
  const evidenceIds = new Set(selected.map((item) => item.evidence.evidenceId));
  const kinds = new Set(selected.map((item) => item.fact.kind));
  const sourceIncomplete = selected.some((item) =>
    item.evidence.tool === "search_media"
    && item.evidence.payload.complete !== true);
  switch (inferenceKind) {
    case "presence_location_estimate":
      return tools.size === 1
        && tools.has("get_my_presence_history")
        && kinds.size <= 2
        && [...kinds].every((kind) =>
          kind === "history_state" || kind === "history_measurement");
    case "numeric_pattern":
      return selected.length >= 2
        && [...tools].every((tool) =>
          tool === "get_history" || tool === "get_statistics")
        && [...kinds].every((kind) =>
          kind === "history_measurement" || kind === "statistic_sample");
    case "weather_outlook":
      return tools.size === 1
        && tools.has("get_weather")
        && kinds.size === 1
        && kinds.has("weather_forecast");
    case "planned_not_observed":
      return [...tools].every((tool) =>
        tool === "get_calendar" || tool === "get_todos")
        && [...kinds].every((kind) =>
          kind === "calendar_event" || kind === "todo_item");
    case "media_match":
      return !sourceIncomplete
        && tools.size === 1
        && tools.has("search_media")
        && kinds.size === 1
        && kinds.has("media_item");
    case "event_pattern":
      return selected.length >= 2
        && tools.size === 1
        && tools.has("get_recent_events")
        && kinds.size === 1
        && kinds.has("recent_event");
    case "cross_source_likelihood":
      return !sourceIncomplete
        && evidenceIds.size >= 2
        && tools.size >= 2
        && !kinds.has("empty_result");
    case "none":
      return false;
  }
}

function renderInference(
  inferenceKind: Exclude<ReadAgentClause["inference_kind"], "none"> | ReadAgentClause["inference_kind"],
): string {
  switch (inferenceKind) {
    case "presence_location_estimate":
      return "That presence evidence makes the recorded location the best estimate, but it cannot establish what you were doing";
    case "numeric_pattern":
      return "Those readings suggest a pattern, but they do not establish its cause";
    case "weather_outlook":
      return "Those forecast points are the best available outlook, not a guarantee";
    case "planned_not_observed":
      return "Those calendar or to-do records show what was planned, not proof it happened";
    case "media_match":
      return "That catalogue evidence makes this the strongest available match, not a certainty";
    case "event_pattern":
      return "Those positive event observations suggest a pattern, but the feed is not complete";
    case "cross_source_likelihood":
      return "Taken together, those different read views support the same estimate, but they do not prove it";
    case "none":
      throw new Error("fact or limitation cannot be rendered as an inference");
  }
}

function evidenceIdsForClauses(
  clauses: readonly ReadAgentClause[],
): ReadonlySet<string> {
  return new Set(clauses.flatMap((clause) => clause.evidence_ids));
}

function appendUniqueEvidence(
  current: readonly ReadAgentEvidence[],
  incoming: readonly ReadAgentEvidence[],
): readonly ReadAgentEvidence[] {
  const result: ReadAgentEvidence[] = [];
  const ids = new Set<string>();
  for (const item of [...current, ...incoming]) {
    if (!item.evidenceId.trim() || ids.has(item.evidenceId)) {
      throw new Error("read agent evidence id is empty or duplicated");
    }
    ids.add(item.evidenceId);
    result.push(item);
  }
  return result;
}

function evidenceFits(
  evidence: readonly ReadAgentEvidence[],
  byteLimit: number,
): boolean {
  return Buffer.byteLength(
    JSON.stringify(evidence.map(projectReadAgentEvidenceForModel)),
    "utf8",
  ) <= byteLimit;
}

function usefulLimitation(
  request: ReadAgentRecoveryRequest,
  evidence: readonly ReadAgentEvidence[],
  text: string,
  toolCallCount: number,
  freshnessCallCount: number,
  round: number,
  startedAtMs: number,
): ReadAgentRecoveryResult {
  const framedText = request.finalFraming.kind === "deterministic_lead"
    ? `${finalSpeechPrefix(request.finalFraming)}${sentence(text)}`
    : sentence(text);
  return {
    status: "declined",
    text: truncateSpeechSentence(framedText, MAX_FINAL_TEXT_LENGTH),
    confidence: "low",
    evidence,
    modelUsed: true,
    notes: [
      "bounded read agent limitation",
      `fallback=${request.fallbackReason}`,
      `rounds=${round}`,
      `model_tool_calls=${toolCallCount}`,
      `freshness_calls=${freshnessCallCount}`,
      `evidence=${evidence.length}`,
      `latency_ms=${Math.max(0, Date.now() - startedAtMs)}`,
    ].join("; "),
  };
}

function limitationFromEvidence(
  evidence: readonly ReadAgentEvidence[],
): string {
  if (evidence.length === 0) {
    return "I couldn't establish that from the available read-only sources.";
  }
  if (evidence.some((item) => item.status === "unavailable")) {
    return "One or more live read sources were unavailable, so I couldn't establish a supported answer.";
  }
  if (evidence.some((item) => item.status === "error")) {
    return "A read-only lookup failed validation, so I couldn't establish a supported answer.";
  }
  if (evidence.every((item) => item.status === "empty")) {
    return "I checked the available read-only sources, but they returned no matching evidence.";
  }
  return "I checked the available sources, but the evidence wasn't enough to support an answer.";
}

async function withinDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
  abortController?: AbortController,
): Promise<T> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    const error = abortError("read agent wall timeout");
    abortController?.abort(error);
    throw error;
  }
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = abortError("read agent wall timeout");
          abortController?.abort(error);
          reject(error);
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function normalizedOptional(value: string | null): string | null {
  return value === null ? null : normalizedRequired(value);
}

function normalizedRequired(value: string): string {
  return value.trim().toLocaleLowerCase(HOUSE_LOCALE).replaceAll(/\s+/g, " ");
}

/**
 * A get_states call for the readable entities the batch's searches found,
 * or null when they found none. Built by software, never by the model, and
 * held to the same tool policy as any other call.
 */
function searchStateCall(
  results: readonly ReadAgentEvidence[],
  round: number,
): ReadAgentToolCall | null {
  const entityIds = [...new Set(results
    .filter((item) => item.tool === "search_entities" && item.status === "ok")
    .flatMap((item) => item.entityIds))]
    .slice(0, SEARCH_STATE_ENTITY_LIMIT);
  if (entityIds.length === 0) {
    return null;
  }
  return {
    call_id: `housemate-search-states-${round}`,
    name: "get_states",
    query: null,
    entity_ids: entityIds,
    start: null,
    end: null,
    limit: 0,
    domain: null,
    area: null,
    mode: "none",
    period: "none",
    types: [],
    statuses: [],
    media_kind: "any",
    media_filter: "none",
  };
}

/**
 * Every question the agent answers is a question code could not (offline
 * first): the turn log keeps its shape so a code route can be added later.
 * The transcript sits beside it in the same log entry.
 */
function missingCodeRouteNote(
  request: ReadAgentRecoveryRequest,
  clauses: readonly ReadAgentClause[],
  evidence: readonly ReadAgentEvidence[],
): string {
  return `missing_code_route=${JSON.stringify({
    route: request.fallbackRoute,
    reason: request.fallbackReason,
    window: request.canonicalTimeWindow?.label ?? null,
    tools: [...new Set(evidence.map((item) => item.tool))].sort(),
    facts: [...new Set(evidence.flatMap((item) => item.facts.map((fact) => fact.kind)))].sort(),
    inferences: [...new Set(clauses
      .map((clause) => clause.inference_kind)
      .filter((kind) => kind !== "none"))].sort(),
  })}`;
}
