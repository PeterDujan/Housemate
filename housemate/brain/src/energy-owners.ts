/**
 * Energy, power and metric owners: live readings, rankings,
 * history windows, comparisons and the monthly budget, claimed from their
 * own words and followed up on their own frames.
 */
import type { BasicContextViews } from "./basic-context-store.js";
import {
  declined,
  clarify,
  declinedWithContext,
  declinedReadFallback,
  withReadFallback,
  type BasicContextFrame,
  type BasicResult,
  type ComparisonWindowPair,
  type PendingClarifierChoice,
  type PendingClarifierFrame,
} from "./basic-brain-contracts.js";
import type { BasicBrainRouteServices } from "./basic-brain-services.js";
import { parseEnergyHistoryFollowUpIntent } from "./energy-history-followup-intent.js";
import {
  comparisonMetricAnswerForWindows,
  currentMetricAnswer,
  currentPowerRankingAnswer,
  defaultMetricById,
  historicalEnergySamePointLastYearAnswer,
  historyMetricAnswerForWindow,
  looksLikeComparisonMetricQuestion,
  looksLikeEnergyProjectionQuestion,
  parseMetricIntentFrame,
  resolveComparisonWindowsFromQuestion,
  resolveMentionedMetric,
  resolveMetricQuestion,
  resolveTimeWindowFromQuestion,
  contextualComparisonWindows,
  currentMetricBaselineAnswer,
  dynamicComparisonMetricAnswerForPhrasesAndWindows,
  dynamicCurrentMetricAnswerForPhrases,
  dynamicHistoryMetricAnswerForPhrasesAndWindow,
  energyBudgetAnswerWithUsage,
  hasMetricTimeWindow,
  historicalEnergyNormalityAnswer,
  looksLikeEnergyBudgetFollowUp,
  resolveFollowUpMetricTarget,
  dynamicMetricAnswer,
  hasIncompleteMetricTimeWindow,
  historyMetricAnswer,
  looksLikeCurrentPowerRankingQuestion,
  looksLikeEnergyBudgetQuestion,
  looksLikeHistoryMetricQuestion,
} from "./basic-brain-metrics.js";
import { looksLikeCalendarQuestion, looksLikeScheduleQuestion, looksLikeTodoQuestion } from "./basic-brain-schedule.js";
import { looksLikeWeatherFastPathQuestion } from "./basic-brain-weather.js";
import type { TimeWindow } from "./time-window-parser.js";
import { FOLLOW_UP_FRAGMENT_MAX_WORDS, POWER_LOAD_WORD, WINDOW_FOLLOW_UP_WORD } from "./lexicon.js";
import { spokenWordCount, joinAlternatives } from "./text-format.js";
import {
  FOCUS_RETURN,
  followUpContentText,
  hasPronounFollowUp,
  looksLikeContextualDomainFragment,
  looksLikeCorrectionFollowUp,
  looksLikeCurrentPowerSourceClarifierFollowUp,
  NOT_FOLLOW_UP,
  declinedContextReference,
  followUpSteps,
  isGenericFollowUpTargetReference,
  looksLikeAverageBaselineFollowUp,
  looksLikeCurrentMetricValueFollowUp,
  looksLikeCurrentPowerRankingFollowUp,
  looksLikeRankedCurrentPowerOrdinalFollowUp,
  type FollowUpTurn,
} from "./follow-up-turn.js";
import { looksLikeConversationRepair, fixedReply, sourceRead } from "./stateless-owners.js";
import { classifyDemonstrativeTarget } from "./entity-action-intent.js";
import type { Owner, OwnerTurn } from "./router.js";
import { routingSemanticsAllowReadOnlyToolUse } from "./routing-text.js";
import { looksLikeElectricitySummaryQuestion } from "./basic-brain-knowledge.js";

/**
 * A turn that names no metric continues the last one only as an ellipsis: a
 * follow-up fragment ("what about yesterday?"), anaphora ("what was it
 * yesterday?"), a reading or quantity ask ("how much last week?"), or a bare
 * time phrase ("last week?", "was last week higher?"). A complete sentence
 * with its own subject or question ("who won the grand final this year?",
 * "was the doorbell pressed last week?") only contains a window.
 */
function looksLikeMetricEllipsis(
  f: FollowUpTurn,
  intent: ReturnType<typeof parseMetricIntentFrame>,
  readingIntent: boolean,
): boolean {
  const normalized = f.normalized;
  if (
    looksLikeContextualDomainFragment(normalized)
    || hasPronounFollowUp(normalized)
    || readingIntent
    || intent.measure !== null
    || intent.aggregation !== null
    || intent.flow !== null
    || /^(?:(?:and|so|then)\s+)?how (?:much|many)\b/.test(normalized)
  ) {
    return true;
  }
  return spokenWordCount(normalized) <= FOLLOW_UP_FRAGMENT_MAX_WORDS
    && !/\b(?:i|i m|me|we|you|he|she|they|who|what|when|where|why|which|whose)\b/.test(normalized)
    && (f.windowResidual ?? []).every((word) => WINDOW_FOLLOW_UP_WORD.test(word));
}

export async function resolveContextualMetricFollowUp(
  f: FollowUpTurn,
  routes: BasicBrainRouteServices,
  now: () => Date,
): Promise<BasicResult | null> {
  const normalized = f.normalized;
  const context = f.views.metrics;
  const metricFrames = context.history.map((entry) => entry.payload).filter((frame): frame is Extract<BasicContextFrame, {
    kind: "current_metric" | "current_power_ranking" | "history_metric" | "comparison_metric";
  }> => frame.kind === "current_metric"
    || frame.kind === "current_power_ranking"
    || frame.kind === "history_metric"
    || frame.kind === "comparison_metric");
  if (/\b(?:physics|definition|define|arithmetic|calculation|calculate|exponent)\b/.test(normalized)) {
    return null;
  }
  if (looksLikeCalendarQuestion(normalized)
    || looksLikeScheduleQuestion(normalized)
    || looksLikeWeatherFastPathQuestion(normalized)
    || looksLikeTodoQuestion(normalized)) {
    return null;
  }
  if (looksLikeEnergyProjectionQuestion(normalized) || looksLikeExplicitAverageBaselineQuestion(normalized)) {
    // A forecast is not a reading of a window, and "is that normal for this
    // time of night?" judges the reading it refers to; "this time of night"
    // is the comparison point, not a new window. The budget projection and
    // the normality rules own these.
    return null;
  }
  if (looksLikeCurrentPowerSourceClarifierFollowUp(normalized)) {
    // Source ordinals have their own follow-up step (`ENERGY_FOLLOW_UPS.powerSource`).
    // The semantic core may have stripped a repair wrapper such as "I mean",
    // so do not let the generic metric-context path answer first.
    return null;
  }

  const intent = parseMetricIntentFrame(normalized);
  const comparisonIntent = looksLikeComparisonMetricQuestion(normalized)
    || /\b(?:those|the|these|two)\s+(?:measured\s+)?days\b/.test(normalized)
    || /\bwhich\b.*\bday\b.*\b(?:higher|lower|more|less)\b/.test(normalized);
  // Context owns ellipses, not complete requests. Let the primary metric
  // resolver preserve an explicit source/unit, and let unsupported indoor
  // temperature history reach its direct boundary decline.
  const keepsMetricContext = hasPronounFollowUp(normalized) || FOCUS_RETURN.test(normalized);
  if ((resolveMetricQuestion(normalized) !== null
      && !keepsMetricContext
      && !comparisonIntent)
    || intent.measure === "temperature") {
    return null;
  }
  const explicitMetric = resolveMentionedMetric(normalized);
  const timeWindow = f.timeWindow;
  const rankingIntent = intent.ranking !== null;
  const partitiveReading = /\bhow much of (?:that|it|this)\b/.test(normalized);
  const readingIntent = /\b(?:reading|figure|value|watts?|wattage|output|draw|drawing|using|usage|energy|power|electricity)\b/.test(normalized);
  const focusIntent = FOCUS_RETURN.test(normalized);
  const statusObject = /\b(?:lights?|lighting|lamps?|switch(?:es)?|outlets?|plugs?|sockets?|doors?|locks?|pumps?|sensors?)\b/.test(normalized);
  if (statusObject && intent.measure === null) {
    return null;
  }
  if (metricFrames.length === 0) {
    if (!explicitMetric || !focusIntent) {
      return null;
    }
    if (timeWindow) {
      return historyMetricAnswerForWindow(explicitMetric, normalized, timeWindow, routes);
    }
    if (intent.measure === "power" || readingIntent) {
      return currentMetricAnswer(explicitMetric, normalized, routes)
        ?? declined("time_window_math", `I've got ${explicitMetric.label}, but I don't have a live current-state source for it.`, `explicit metric focus unavailable: ${explicitMetric.id}`);
    }
    return null;
  }

  const activeFrame = context.active?.payload ?? null;
  const activeFrameIsMetric = activeFrame?.kind === "current_metric"
    || activeFrame?.kind === "current_power_ranking"
    || activeFrame?.kind === "history_metric"
    || activeFrame?.kind === "comparison_metric";
  if (!activeFrameIsMetric && explicitMetric === null && !focusIntent) {
    return null;
  }

  const historyFrames = metricFrames.filter((frame): frame is Extract<BasicContextFrame, { kind: "history_metric" | "comparison_metric" }> =>
    frame.kind === "history_metric" || frame.kind === "comparison_metric");
  const latestHistory = historyFrames[0] ?? null;
  const historyMetric = explicitMetric
    ?? (latestHistory ? defaultMetricById(latestHistory.metricId) : null);
  const retainedHistory = historyFrames.find(
    (frame): frame is Extract<BasicContextFrame, { kind: "history_metric" }> =>
      frame.kind === "history_metric",
  ) ?? null;
  const energyHistoryFollowUp = parseEnergyHistoryFollowUpIntent(normalized);
  if (
    energyHistoryFollowUp?.kind === "same_point_last_year"
    && retainedHistory
  ) {
    const retainedMetric = explicitMetric
      ?? defaultMetricById(retainedHistory.metricId);
    return retainedMetric
      ? historicalEnergySamePointLastYearAnswer(
          retainedMetric,
          retainedHistory.window,
          routes,
          now(),
        )
      : declined(
          "time_window_math",
          "I don't have a retained historical metric to compare with last year.",
          "same-point last-year follow-up missing history metric definition",
        );
  }
  const activeMetricFrame = metricFrames[0] ?? null;
  const followUpPayload = followUpContentText(normalized);
  const followUpPayloadIntent = followUpPayload ? parseMetricIntentFrame(followUpPayload) : null;
  const subjectOnlyMetricSwap = explicitMetric !== null
    && followUpPayloadIntent !== null
    && followUpPayloadIntent.measure === null
    && followUpPayloadIntent.aggregation === null
    && followUpPayloadIntent.flow === null
    && followUpPayloadIntent.ranking === null
    && timeWindow === null;

  if (comparisonIntent && historyMetric) {
    const explicitWindows = resolveComparisonWindowsFromQuestion(normalized, now());
    const contextualWindows = explicitWindows ?? recentHistoryComparisonWindows(historyFrames, historyMetric.id);
    if (contextualWindows) {
      return comparisonMetricAnswerForWindows(historyMetric, normalized, routes, contextualWindows);
    }
  }

  // Without a named metric, only an ellipsis inherits the last one: "and this
  // week?" does, "I'm a bit tired today." merely contains a window.
  const inheritsMetric = explicitMetric !== null
    || looksLikeMetricEllipsis(f, intent, readingIntent);
  if (timeWindow && historyMetric && (latestHistory || explicitMetric) && inheritsMetric) {
    return historyMetricAnswerForWindow(historyMetric, normalized, timeWindow, routes);
  }

  if (subjectOnlyMetricSwap && activeMetricFrame?.kind === "history_metric" && !activeMetricFrame.composed) {
    return historyMetricAnswerForWindow(explicitMetric, normalized, activeMetricFrame.window, routes);
  }
  if (subjectOnlyMetricSwap && activeMetricFrame?.kind === "comparison_metric" && !activeMetricFrame.composed) {
    return historyMetricAnswerForWindow(explicitMetric, normalized, activeMetricFrame.windows.left, routes);
  }

  const hasCurrentContext = activeMetricFrame?.kind === "current_metric" || activeMetricFrame?.kind === "current_power_ranking";
  if (rankingIntent && hasCurrentContext) {
    return currentPowerRankingAnswer(normalized, routes);
  }

  if (explicitMetric && hasCurrentContext
    && (intent.measure === "power" || readingIntent || partitiveReading || focusIntent)) {
    const prompt = intent.measure === "power" ? normalized : `${normalized} power`;
    return currentMetricAnswer(explicitMetric, prompt, routes)
      ?? declined("time_window_math", `I've got ${explicitMetric.label}, but I don't have a live current-state source for it.`, `contextual current metric unavailable: ${explicitMetric.id}`);
  }

  if (!explicitMetric && latestHistory && timeWindow && inheritsMetric) {
    const inherited = defaultMetricById(latestHistory.metricId);
    return inherited ? historyMetricAnswerForWindow(inherited, normalized, timeWindow, routes) : null;
  }
  return null;
}

function recentHistoryComparisonWindows(
  frames: readonly Extract<BasicContextFrame, { kind: "history_metric" | "comparison_metric" }>[],
  metricId: string,
): ComparisonWindowPair | null {
  const distinct: TimeWindow[] = [];
  for (const frame of frames) {
    if (frame.metricId !== metricId) {
      continue;
    }
    const candidates = frame.kind === "history_metric" ? [frame.window] : [frame.windows.left, frame.windows.right];
    for (const window of candidates) {
      if (!distinct.some((candidate) => candidate.start === window.start && candidate.end === window.end)) {
        distinct.push(window);
      }
      if (distinct.length === 2) {
        return { left: distinct[1] as TimeWindow, right: distinct[0] as TimeWindow };
      }
    }
  }
  return null;
}

function looksLikeExplicitAverageBaselineQuestion(normalized: string): boolean {
  return /^(?:and\s+)?is\s+(?:that|it|this)\s+(?:normal|usual|typical|expected|ok|okay|alright|fine)\b/.test(normalized);
}

export function currentPowerSourceClarifier(normalized: string, routes: BasicBrainRouteServices): PendingClarifierFrame | null {
  if (!/\bsource|sources\b/.test(normalized)) {
    return null;
  }
  if (!looksLikeCorrectionFollowUp(normalized) && !/\b(first|top|biggest|highest|most)\b/.test(normalized)) {
    return null;
  }
  const choices = [
    currentMetricClarifierChoice("solar_total_energy", "solar total", ["solar", "solar power", "pv"]),
    currentMetricClarifierChoice("battery_discharge_energy", "battery discharge", ["battery output", "battery discharge power"]),
    currentMetricClarifierChoice("battery_charge_energy", "battery charge", ["battery input", "battery charge power"]),
    currentMetricClarifierChoice("house_current_power", "house current power", ["house load", "house power", "current load"]),
  ].filter((choice): choice is PendingClarifierChoice => choice !== null)
    .filter((choice) => clarifierMetricHasLiveState(choice, routes))
    .slice(0, 5);
  if (choices.length < 2) {
    return null;
  }
  const prompt = `Do you mean ${joinAlternatives(choices.map((choice) => choice.label))}?`;
  return {
    kind: "clarifier",
    route: "time_window_math",
    prompt,
    choices,
  };
}

function currentMetricClarifierChoice(metricId: string, label: string, synonyms: readonly string[]): PendingClarifierChoice | null {
  const metric = defaultMetricById(metricId);
  if (!metric) {
    return null;
  }
  return {
    id: metric.id,
    label,
    synonyms,
    action: {
      kind: "metric_current",
      metricId: metric.id,
    },
  };
}

function clarifierMetricHasLiveState(choice: PendingClarifierChoice, routes: BasicBrainRouteServices): boolean {
  if (choice.action.kind !== "metric_current") {
    return true;
  }
  const metric = defaultMetricById(choice.action.metricId);
  const cache = routes.stateCache;
  if (!metric || !cache || cache.size() === 0) {
    return false;
  }
  return currentMetricAnswer(metric, `${metric.label} power`, routes)?.status === "ok";
}

export function metricFollowUpPrompt(targetText: string): string {
  return POWER_LOAD_WORD.test(targetText) ? targetText : `${targetText} power`;
}

export function annotateMetricFollowUpSource(result: BasicResult, followUpSource: "target_swap"): BasicResult {
  const contextFrame = result.contextFrame;
  if (!contextFrame) {
    return result;
  }
  if (contextFrame.kind !== "current_metric" && contextFrame.kind !== "history_metric" && contextFrame.kind !== "comparison_metric") {
    return result;
  }
  return {
    ...result,
    contextFrame: {
      ...contextFrame,
      followUpSource,
    },
  };
}

export function oldestTargetSwapMetricFrame(
  frames: readonly BasicContextFrame[],
): Extract<BasicContextFrame, { kind: "current_metric" | "history_metric" | "comparison_metric" }> | null {
  const candidates = frames.filter((frame): frame is Extract<BasicContextFrame, { kind: "current_metric" | "history_metric" | "comparison_metric" }> =>
    (frame.kind === "current_metric" || frame.kind === "history_metric" || frame.kind === "comparison_metric")
      && frame.followUpSource === "target_swap");
  return candidates.length > 0 ? candidates[candidates.length - 1] ?? null : null;
}

// --- Follow-ups ------------------------------------------------------------------

/** Readings, rankings, windows and comparisons on the metric frames. */
export const ENERGY_FOLLOW_UPS = followUpSteps("metric", {
  metricContext(f, ctx) {
    return f.clarifier ? null : resolveContextualMetricFollowUp(f, ctx.routes, ctx.now);
  },
  metricContextAfterClarifier(f, ctx) {
    return f.clarifier ? resolveContextualMetricFollowUp(f, ctx.routes, ctx.now) : null;
  },
  powerSource(f, ctx) {
    const n = f.normalized;
    const currentPowerContext = f.currentPowerContext;
    const currentPowerSourceFollowUp = looksLikeCurrentPowerSourceClarifierFollowUp(f.surface)
      ? f.surface
      : looksLikeCurrentPowerSourceClarifierFollowUp(f.discourse)
        ? f.discourse
        : looksLikeCurrentPowerSourceClarifierFollowUp(n)
          ? n
          : null;
    const repairsPowerSource = Boolean(currentPowerSourceFollowUp) && (
      looksLikeCorrectionFollowUp(f.surface)
      || looksLikeCorrectionFollowUp(f.discourse)
      || looksLikeCorrectionFollowUp(n)
    );
    if (currentPowerContext && currentPowerSourceFollowUp && repairsPowerSource) {
      const metric = defaultMetricById(currentPowerContext.metricId);
      if (metric?.kind === "power") {
        const rankingClarifier = currentPowerSourceClarifier(currentPowerSourceFollowUp, ctx.routes);
        return rankingClarifier
          ? clarify("time_window_math", rankingClarifier.prompt, "corrected current power source needs source clarification", rankingClarifier)
          : currentPowerRankingAnswer(n, ctx.routes);
      }
    }
    if (currentPowerContext?.kind === "current_power_ranking" && looksLikeRankedCurrentPowerOrdinalFollowUp(n)) {
      const requestedDirection = parseMetricIntentFrame(n).ranking?.direction ?? currentPowerContext.direction;
      return currentPowerRankingAnswer(
        requestedDirection === "ascending"
          ? "which device is using the least power"
          : "which device is using the most power",
        ctx.routes,
      );
    }
    if (currentPowerContext && currentPowerSourceFollowUp) {
      const metric = defaultMetricById(currentPowerContext.metricId);
      if (metric?.kind === "power") {
        return currentPowerRankingAnswer(n, ctx.routes);
      }
    }
    return null;
  },
  /** "And the solar?" after a history or comparison answer keeps its window. */
  async explicitMetricSwap(f, ctx) {
    const explicitQuestion = f.explicitQuestion;
    if (!explicitQuestion) return null;
    const metric = resolveMetricQuestion(explicitQuestion);
    if (!metric || hasMetricTimeWindow(explicitQuestion)) return null;
    const metricFrame = f.metricFrame;
    const window = metricFrame?.kind === "history_metric"
      ? metricFrame.window
      : metricFrame?.kind === "comparison_metric"
        ? metricFrame.windows.left
        : null;
    if (!window) return null;
    const result = await historyMetricAnswerForWindow(metric, f.normalized, window, ctx.routes);
    return !isGenericFollowUpTargetReference(f.targetSwap) ? annotateMetricFollowUpSource(result, "target_swap") : result;
  },
  powerRanking(f, ctx) {
    if (!looksLikeCurrentPowerRankingFollowUp(f.normalized)) return null;
    const metric = f.currentPowerContext ? defaultMetricById(f.currentPowerContext.metricId) : null;
    if (metric?.kind !== "power") return null;
    const rankingClarifier = currentPowerSourceClarifier(f.normalized, ctx.routes);
    if (rankingClarifier) {
      return clarify("time_window_math", rankingClarifier.prompt, "current power follow-up needs source clarification", rankingClarifier);
    }
    return currentPowerRankingAnswer(f.normalized, ctx.routes);
  },
  energyHistory(f, ctx) {
    const metricFrame = f.metricFrame;
    const historyFrame = metricFrame?.kind === "history_metric" ? metricFrame : null;
    const energyHistoryFollowUp = historyFrame ? parseEnergyHistoryFollowUpIntent(f.normalized) : null;
    if (energyHistoryFollowUp?.kind === "same_point_last_year") {
      const metric = historyFrame ? defaultMetricById(historyFrame.metricId) : null;
      return metric && historyFrame
        ? historicalEnergySamePointLastYearAnswer(metric, historyFrame.window, ctx.routes, ctx.now())
        : declined("time_window_math", "I don't have a retained historical metric to compare with last year.", "same-point last-year follow-up missing history metric frame");
    }
    if (energyHistoryFollowUp?.kind === "normality" && historyFrame) {
      const metric = defaultMetricById(historyFrame.metricId);
      return metric
        ? historicalEnergyNormalityAnswer(metric, historyFrame.window, ctx.routes, ctx.now())
        : declined("time_window_math", "I lost the sourced metric definition, so I can't build that historical baseline.", "historical normality follow-up metric missing from catalog");
    }
    return null;
  },
  averageBaseline(f, ctx) {
    if (!looksLikeAverageBaselineFollowUp(f.normalized)) return null;
    // "Is that normal?" judges the latest answer; after a budget answer that
    // is the budget, not an older live reading.
    const latestMetricFrame = f.metricHistory[0] ?? null;
    if (latestMetricFrame?.kind === "energy_budget") {
      return energyBudgetAnswerWithUsage(ctx.routes, ctx.now(), f.normalized, latestMetricFrame.monthIndex);
    }
    const currentMetric = f.metricHistory.find((frame): frame is Extract<BasicContextFrame, { kind: "current_metric" }> => frame.kind === "current_metric");
    const metric = currentMetric ? defaultMetricById(currentMetric.metricId) : null;
    return metric
      ? currentMetricBaselineAnswer(metric, f.normalized, ctx.routes, ctx.now)
      : declinedContextReference(
        "time_window_math",
        "I don't have a current metric to compare with average.",
        "average follow-up missing current metric frame",
      );
  },
  budget(f, ctx) {
    if (!looksLikeEnergyBudgetFollowUp(f.normalized)) return null;
    const budgetFrame = f.metricHistory.find((frame): frame is Extract<BasicContextFrame, { kind: "energy_budget" }> => frame.kind === "energy_budget");
    return budgetFrame ? energyBudgetAnswerWithUsage(ctx.routes, ctx.now(), f.normalized, budgetFrame.monthIndex) : null;
  },
  async comparison(f, ctx) {
    const n = f.normalized;
    if (!looksLikeComparisonMetricQuestion(n)) return null;
    const metricFrame = latestHistoryOrComparison(f);
    const metric = metricFrame ? defaultMetricById(metricFrame.metricId) : null;
    const latestHistory = metricFrame?.kind === "history_metric" ? metricFrame : null;
    const explicitWindows = metric ? resolveComparisonWindowsFromQuestion(n, ctx.now()) : null;
    const dynamicWindows = metricFrame?.composed && latestHistory ? contextualComparisonWindows(n, latestHistory.window, ctx.now()) : null;
    const contextualWindows = metric && latestHistory ? contextualComparisonWindows(n, latestHistory.window, ctx.now()) : null;
    if (metricFrame?.composed) {
      const windows = resolveComparisonWindowsFromQuestion(n, ctx.now()) ?? dynamicWindows;
      if (windows) {
        const result = await dynamicComparisonMetricAnswerForPhrasesAndWindows(metricFrame.composed.targetPhrases, n, windows, ctx.routes);
        if (!result) return NOT_FOLLOW_UP;
        return latestHistory?.followUpSource === "target_swap" ? annotateMetricFollowUpSource(result, "target_swap") : result;
      }
    }
    const windows = explicitWindows ?? contextualWindows;
    if (metric && windows) {
      const result = await comparisonMetricAnswerForWindows(metric, n, ctx.routes, windows);
      return latestHistory?.followUpSource === "target_swap" ? annotateMetricFollowUpSource(result, "target_swap") : result;
    }
    return null;
  },
  async moreThan(f, ctx) {
    if (!/^(?:is that )?(?:more|less|higher|lower|greater) than\b/.test(f.normalized)) return null;
    const metricFrame = latestHistoryOrComparison(f);
    const metric = metricFrame ? defaultMetricById(metricFrame.metricId) : null;
    const latestHistory = metricFrame?.kind === "history_metric" ? metricFrame : null;
    const windows = metric && latestHistory ? contextualComparisonWindows(f.normalized, latestHistory.window, ctx.now()) : null;
    if (!metric || !windows) return null;
    const result = await comparisonMetricAnswerForWindows(metric, f.normalized, ctx.routes, windows);
    return latestHistory?.followUpSource === "target_swap" ? annotateMetricFollowUpSource(result, "target_swap") : result;
  },
  async metricWindow(f, ctx) {
    const timeWindow = f.timeWindow;
    const metricFrame = f.metricFrame;
    if (!timeWindow) return null;
    if (metricFrame?.composed) {
      const result = await dynamicHistoryMetricAnswerForPhrasesAndWindow(metricFrame.composed.targetPhrases, f.normalized, timeWindow, ctx.routes);
      if (result) {
        return metricFrame.followUpSource === "target_swap" ? annotateMetricFollowUpSource(result, "target_swap") : result;
      }
    }
    const metric = metricFrame ? defaultMetricById(metricFrame.metricId) : null;
    if (!metric) return null;
    if (metricFrame?.followUpSource === "target_swap" && timeWindow.source === "rolling_duration") {
      return declinedWithContext(
        "time_window_math",
        "I need you to restate the metric with that new time window instead of chaining another implicit follow-up.",
        "time-window follow-up declined after target-swapped metric context",
        oldestTargetSwapMetricFrame(f.metricHistory),
      );
    }
    const result = await historyMetricAnswerForWindow(metric, f.normalized, timeWindow, ctx.routes);
    return metricFrame?.followUpSource === "target_swap" ? annotateMetricFollowUpSource(result, "target_swap") : result;
  },
  metricRepair(f) {
    return f.metricFrame && looksLikeConversationRepair(f.normalized) ? NOT_FOLLOW_UP : null;
  },
  async dynamicTargetSwap(f, ctx) {
    const dynamicTargetSwap = f.dynamicTargetSwap;
    if (isGenericFollowUpTargetReference(dynamicTargetSwap)) return null;
    const dynamicTargetText = dynamicTargetSwap as string;
    const n = f.normalized;
    const metricFrame = f.metricFrame;
    const currentPowerContext = f.currentPowerContext;
    const historyWindow = metricFrame?.kind === "history_metric"
      ? metricFrame.window
      : metricFrame?.kind === "comparison_metric"
        ? metricFrame.windows.left
        : null;
    if (historyWindow) {
      const result = await dynamicHistoryMetricAnswerForPhrasesAndWindow([dynamicTargetText], n, historyWindow, ctx.routes);
      if (result) {
        return annotateMetricFollowUpSource(result, "target_swap");
      }
    }
    if (currentPowerContext?.kind === "current_metric" || currentPowerContext?.kind === "current_power_ranking") {
      const currentMetric = dynamicCurrentMetricAnswerForPhrases([dynamicTargetText], metricFollowUpPrompt(dynamicTargetText), ctx.routes)
        ?? dynamicCurrentMetricAnswerForPhrases([dynamicTargetText], n, ctx.routes);
      if (currentMetric) {
        return annotateMetricFollowUpSource(currentMetric, "target_swap");
      }
    }
    if (metricFrame?.composed?.sourceKind === "history_energy" && historyWindow) {
      const result = await dynamicHistoryMetricAnswerForPhrasesAndWindow([dynamicTargetText], n, historyWindow, ctx.routes);
      if (result) {
        return annotateMetricFollowUpSource(result, "target_swap");
      }
    }
    if (currentPowerContext?.kind === "current_metric" && currentPowerContext.composed?.sourceKind === "current_power") {
      const currentMetric = dynamicCurrentMetricAnswerForPhrases([dynamicTargetText], n, ctx.routes);
      if (currentMetric) {
        return annotateMetricFollowUpSource(currentMetric, "target_swap");
      }
    }
    return null;
  },
  /** "What about the solar?" on a metric frame. */
  async metricTargetSwap(f, ctx) {
    const targetSwapText = f.targetSwap;
    if (!targetSwapText || classifyDemonstrativeTarget(targetSwapText).kind !== "none") return null;
    const metric = resolveFollowUpMetricTarget(targetSwapText);
    const metricFrame = f.metricFrame;
    if (metric && metricFrame?.kind === "history_metric") {
      return annotateMetricFollowUpSource(await historyMetricAnswerForWindow(metric, f.normalized, metricFrame.window, ctx.routes), "target_swap");
    }
    if (metric && metricFrame?.kind === "comparison_metric") {
      return annotateMetricFollowUpSource(await historyMetricAnswerForWindow(metric, f.normalized, metricFrame.windows.left, ctx.routes), "target_swap");
    }
    if (metric && f.currentPowerContext?.kind === "current_power_ranking") {
      const currentMetric = currentMetricAnswer(metric, metricFollowUpPrompt(targetSwapText), ctx.routes);
      return currentMetric
        ? annotateMetricFollowUpSource(currentMetric, "target_swap")
        : declined("time_window_math", `I've got ${metric.label}, but I don't have a live current-state source for it.`, `ranking follow-up matched: ${metric.id}; no current answer`);
    }
    if (metric && metricFrame?.kind === "current_metric") {
      const currentMetric = currentMetricAnswer(metric, metricFollowUpPrompt(targetSwapText), ctx.routes);
      return currentMetric
        ? annotateMetricFollowUpSource(currentMetric, "target_swap")
        : declined("time_window_math", `I've got ${metric.label}, but I don't have a live current-state source for it.`, `metric follow-up matched: ${metric.id}; no current answer`);
    }
    return null;
  },
  currentMetricValue(f, ctx) {
    const activeMetricFrame = f.activeMetricFrame;
    if (activeMetricFrame?.kind !== "current_metric" || !looksLikeCurrentMetricValueFollowUp(f.normalized)) return null;
    if (activeMetricFrame.composed?.sourceKind === "current_power") {
      return dynamicCurrentMetricAnswerForPhrases(activeMetricFrame.composed.targetPhrases, f.normalized, ctx.routes) ?? NOT_FOLLOW_UP;
    }
    const metric = defaultMetricById(activeMetricFrame.metricId);
    return metric ? currentMetricAnswer(metric, f.normalized, ctx.routes) ?? NOT_FOLLOW_UP : null;
  },
  async historyPronoun(f, ctx) {
    const activeMetricFrame = f.activeMetricFrame;
    if (activeMetricFrame?.kind !== "history_metric" || !hasPronounFollowUp(f.normalized) || !hasMetricTimeWindow(f.normalized)) return null;
    if (activeMetricFrame.composed?.sourceKind === "history_energy") {
      return await dynamicHistoryMetricAnswerForPhrasesAndWindow(activeMetricFrame.composed.targetPhrases, f.normalized, activeMetricFrame.window, ctx.routes)
        ?? NOT_FOLLOW_UP;
    }
    const metric = defaultMetricById(activeMetricFrame.metricId);
    return metric ? historyMetricAnswerForWindow(metric, f.normalized, activeMetricFrame.window, ctx.routes) : null;
  },
});

/** The newest history or comparison frame among the metric frames. */
function latestHistoryOrComparison(f: FollowUpTurn): Extract<BasicContextFrame, { kind: "history_metric" | "comparison_metric" }> | undefined {
  return f.metricHistory.find((frame): frame is Extract<BasicContextFrame, { kind: "history_metric" | "comparison_metric" }> =>
    frame.kind === "history_metric" || frame.kind === "comparison_metric");
}

// --- Owners ----------------------------------------------------------------------

/** Metric questions read house sources; a mention or a hypothetical does not. */
const readsMetrics = (turn: OwnerTurn): boolean => routingSemanticsAllowReadOnlyToolUse(turn.analysis.semantics);

/** "How much power is the dishwasher using?": a metric composed from the house's own names. */
export const dynamicMetricOwner = {
  id: "dynamic_metric",
  tier: "explicit",
  claim: (turn) => readsMetrics(turn) || null,
  async answer(_claim, ctx) {
    const result = await dynamicMetricAnswer(ctx.turn.transcript, ctx.turn.normalized, ctx.routes, ctx.now);
    return result ? withReadFallback(result, "cross_source_read_required") : null;
  },
} satisfies Owner<true>;

/** "Are we on budget this month?", "how's our electricity going?". */
export const energyBudgetOwner = sourceRead(
  "energy_budget",
  "explicit",
  (turn) => readsMetrics(turn) && (looksLikeEnergyBudgetQuestion(turn.normalized) || looksLikeElectricitySummaryQuestion(turn.normalized)),
  (ctx) => energyBudgetAnswerWithUsage(ctx.routes, ctx.now(), ctx.turn.normalized),
  "cross_source_read_required",
);

/** "What's using the most power?". */
export const powerRankingOwner = sourceRead(
  "power_ranking",
  "explicit",
  (turn) => readsMetrics(turn) && looksLikeCurrentPowerRankingQuestion(turn.normalized),
  (ctx) => currentPowerRankingAnswer(ctx.turn.normalized, ctx.routes),
  "cross_source_read_required",
);

/** "How much solar since..." with the window cut off: asked again, not guessed. */
export const incompleteWindowOwner = fixedReply(
  "incomplete_window",
  "unsupported",
  (turn) => readsMetrics(turn) && hasIncompleteMetricTimeWindow(turn.normalized),
  () => declined(
    "time_window_math",
    "I did not catch the end of that time window. Please say it again.",
    "incomplete metric time-window token declined before current-reading fallback",
  ),
);

/** A catalogue metric: its history over a window, or its live reading. */
export const metricOwner = {
  id: "metric",
  tier: "explicit",
  claim: (turn) => (readsMetrics(turn) ? resolveMetricQuestion(turn.normalized) : null),
  async answer(metric, ctx) {
    const { transcript, normalized } = ctx.turn;
    if (hasMetricTimeWindow(normalized)) {
      return withReadFallback(
        await historyMetricAnswer(metric, transcript, normalized, ctx.routes, ctx.now),
        "historical_state_required",
      );
    }
    const currentMetric = currentMetricAnswer(metric, normalized, ctx.routes);
    if (currentMetric) {
      return withReadFallback(currentMetric, "current_source_unresolved");
    }
    return declinedReadFallback(
      "time_window_math",
      "I matched that metric, but the time-window calculation path is not wired yet, so I will not guess.",
      `metric source matched: ${metric.id}; metric question blocked before current status or model fallback`,
      "cross_source_read_required",
    );
  },
} satisfies Owner<NonNullable<ReturnType<typeof resolveMetricQuestion>>>;

/** A metric history question with no catalogue source. */
export const unresolvedMetricOwner = fixedReply(
  "unresolved_metric",
  "unsupported",
  (turn) => readsMetrics(turn) && looksLikeHistoryMetricQuestion(turn.normalized),
  () => declined(
    "time_window_math",
    "I know this is a metric question, but the time-window calculation path is not wired yet, so I will not guess.",
    "metric source not resolved yet; metric question blocked before current status or model fallback",
  ),
);
