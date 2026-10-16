import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AppConfig } from "./config.js";
import { cognitiveFeatureEnabled } from "./cognitive-control.js";
import type { HouseStateProvider, HouseStateSnapshot } from "./house-state.js";
import type { HouseholdMemory } from "./household-memory.js";
import type { HaCalendarFetcher } from "./ha-calendar.js";
import type { HaStateCache } from "./ha-state-cache.js";
import type { HaTodoFetcher } from "./ha-todo.js";
import type { HaWeatherForecastFetcher } from "./ha-weather-forecast.js";
import { proactiveHelperEnabled } from "./housemate-controls.js";
import type { Opportunity, ProactiveSuppressionReason } from "./proactive-opportunity.js";
import {
  collectDeviceProblemOpportunities,
  collectHouseCareOpportunities,
  collectRemoteProactiveOpportunities,
} from "./proactive-live-sources.js";
import {
  buildProactiveDashboardSummary,
  type ProactiveDashboardEligibleSlot,
  type ProactiveDashboardSummary,
} from "./proactive-summary.js";
import { householdOwnerId } from "./household.js";

type ProactiveShadowConfig = Pick<AppConfig, "dataDir">
  & Partial<Pick<AppConfig, "cognitiveSystemEnabled" | "cognitiveRecallEnabled" | "cognitiveProactiveEnabled">>;

export interface ProactiveShadowProposal {
  readonly proposedText: string;
  readonly opportunityId: string;
  readonly opportunityType: string;
  readonly targetPersonId: string;
  readonly channel: ProactiveDashboardEligibleSlot["channel"];
  readonly slotType: ProactiveDashboardEligibleSlot["slotType"];
  readonly usefulnessScore: number;
  readonly sensitivity: ProactiveDashboardEligibleSlot["sensitivity"];
  readonly source: ProactiveDashboardEligibleSlot["source"];
  readonly why: string;
  /** The "why" in plain words, for Review. */
  readonly plainWhy?: string;
}

/**
 * Each kind of idea, as the owner sees it in Settings. New detectors
 * add their kind here.
 */
export const PROACTIVE_IDEA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  imminent_weather: "Weather warnings",
  upcoming_event_reminder: "Reminders from memory",
  overdue_jobs: "Overdue jobs",
  calendar_conflict: "Calendar clashes",
  device_problem: "Device faults",
  bin_night: "Bin night",
  house_left_open: "Door or garage left open",
  upcoming_calendar_event: "Calendar heads-ups",
  upkeep: "Weekly upkeep",
});

export type ProactiveHeldBackReason = ProactiveSuppressionReason | "switched_off";

/**
 * A gate that stopped an idea that was otherwise due, in the owner's words. Any
 * other reason (not due yet, expired, said already) is not "held back" and is
 * not logged.
 */
const HELD_BACK_REASONS: Partial<Record<ProactiveHeldBackReason, string>> = {
  switched_off: "you switched this kind off",
  target_not_present_for_voice: "you weren't home",
  no_household_audience_for_voice: "nobody was home",
  quiet_hours: "quiet hours",
  sleep_gate: "bedtime",
  usefulness_too_low: "not important enough",
  sensitive_voice_blocked: "too private to say out loud",
  annoyance_budget_exhausted: "he'd said enough already",
  voice_slot_closed: "not a good moment",
  voice_interruption_blocked: "not a good moment",
  unsupported_voice_opportunity: "he can't say this kind out loud",
};

/** An idea that was due but a gate stopped; logged once per idea. */
export interface ProactiveHeldBackIdea {
  readonly opportunityId: string;
  readonly opportunityType: string;
  readonly proposedText: string;
  readonly reasons: readonly ProactiveHeldBackReason[];
}

export interface ProactiveShadowEntry {
  readonly timestamp: string;
  readonly mode: "shadow_only";
  readonly fingerprint: string;
  readonly targetPersonId: string;
  readonly proposals: readonly ProactiveShadowProposal[];
  readonly heldBack: readonly ProactiveHeldBackIdea[];
  readonly context: ProactiveDashboardSummary["house"];
  readonly sources: ProactiveDashboardSummary["sources"];
  readonly suppressionCounts: ProactiveDashboardSummary["suppressionCounts"];
  readonly outcome: "would_suggest" | "held_back" | "nothing_eligible";
}

export function proactiveShadowLogPath(config: Pick<AppConfig, "dataDir">): string {
  return join(config.dataDir, "cognition", "proactive-shadow.jsonl");
}

/**
 * The owner's verdicts on what the assistant would have said (Review tab). Accept and
 * decline are stored as the ratings and `bad`; `badly_timed` is an
 * older rating kept readable. Verdicts only record his view for tuning: they
 * never make the assistant speak.
 */
export type ProactiveReviewRating = "good" | "bad" | "badly_timed";
export type ProactiveReviewVerdict = "accept" | "decline";

export interface ProactiveReviewItem {
  /** He would have said it (Accept/Decline); a gate stopped it. */
  readonly kind: "said" | "held";
  readonly id: string;
  readonly timestamp: string;
  readonly proposedText: string;
  readonly opportunityType: string;
  /** Plain words: why he'd say it, or what held it back. */
  readonly why: string;
  readonly rating: ProactiveReviewRating | null;
  readonly decidedAt: string | null;
}

export interface ProactiveIdeaTypeRow {
  readonly type: string;
  readonly label: string;
  readonly on: boolean;
  readonly accepted: number;
  readonly declined: number;
}

export interface ProactiveReviewSummary {
  readonly enabled: boolean;
  readonly waiting: number;
  readonly items: readonly ProactiveReviewItem[];
  /** Settings: one switch per kind of idea, with the owner's verdict counts. */
  readonly types: readonly ProactiveIdeaTypeRow[];
}

interface ProactiveReviewDecision {
  readonly schemaVersion: 1;
  readonly auditId: string;
  readonly reviewId: string;
  readonly rating: ProactiveReviewRating;
  readonly operatorId: string;
  readonly decidedAt: string;
}

const RATINGS: ReadonlySet<string> = new Set<ProactiveReviewRating>(["good", "bad", "badly_timed"]);
const VERDICT_RATING: Readonly<Record<ProactiveReviewVerdict, ProactiveReviewRating>> = { accept: "good", decline: "bad" };

export function proactiveReviewPath(config: Pick<AppConfig, "dataDir">): string {
  return join(config.dataDir, "cognition", "proactive-review.jsonl");
}

/** Newest first: waiting ones, then the last few decided, then the last few held back. */
export function proactiveReviewSummary(config: ProactiveShadowConfig, shownLimit = 10): ProactiveReviewSummary {
  const decisions = new Map<string, ProactiveReviewDecision>();
  for (const value of readJsonLines(proactiveReviewPath(config))) {
    const decision = value as Partial<ProactiveReviewDecision>;
    if (typeof decision.reviewId === "string" && typeof decision.rating === "string" && RATINGS.has(decision.rating)
      && typeof decision.decidedAt === "string") {
      decisions.set(decision.reviewId, decision as ProactiveReviewDecision);
    }
  }
  const entries = storedEntries(proactiveShadowLogPath(config));
  const said = entries
    .flatMap((entry) => entry.proposals.map((proposal): ProactiveReviewItem => {
      const id = reviewIdFor(entry, proposal);
      const decision = decisions.get(id);
      return {
        kind: "said",
        id,
        timestamp: entry.timestamp,
        proposedText: proposal.proposedText,
        opportunityType: proposal.opportunityType,
        why: proposal.plainWhy ?? plainWhyOf(proposal.why),
        rating: decision?.rating ?? null,
        decidedAt: decision?.decidedAt ?? null,
      };
    }))
    .sort(newestFirst);
  // Once an idea got through, its earlier hold no longer matters.
  const saidIds = new Set(entries.flatMap((entry) => entry.proposals.map((proposal) => proposal.opportunityId)));
  const held = entries
    .flatMap((entry) => entry.heldBack
      .filter((idea) => !saidIds.has(idea.opportunityId))
      .map((idea): ProactiveReviewItem => ({
        kind: "held",
        id: `held-${idea.opportunityId}`,
        timestamp: entry.timestamp,
        proposedText: idea.proposedText,
        opportunityType: idea.opportunityType,
        why: `Held back: ${[...new Set(idea.reasons.map((reason) => HELD_BACK_REASONS[reason] ?? reason))].join(", ")}.`,
        rating: null,
        decidedAt: null,
      })))
    .sort(newestFirst);
  const waiting = said.filter((item) => item.rating === null);
  const off = proactiveTypesOff(config);
  return {
    enabled: cognitiveFeatureEnabled(config, "proactive"),
    waiting: waiting.length,
    items: [...waiting, ...said.filter((item) => item.rating !== null).slice(0, shownLimit), ...held.slice(0, shownLimit)],
    types: Object.entries(PROACTIVE_IDEA_TYPES).map(([type, label]) => ({
      type,
      label,
      on: !off.has(type),
      accepted: said.filter((item) => item.opportunityType === type && item.rating === "good").length,
      declined: said.filter((item) => item.opportunityType === type && (item.rating === "bad" || item.rating === "badly_timed")).length,
    })),
  };
}

function newestFirst(left: ProactiveReviewItem, right: ProactiveReviewItem): number {
  return right.timestamp.localeCompare(left.timestamp);
}

// Proposals logged before carry only the long reason; its second
// clause is the live source's own reason.
function plainWhyOf(why: string): string {
  const parts = why.split("; ");
  return why.startsWith("validated live") && parts[1] ? sentence(parts[1]) : "From something he remembers.";
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}${/[.!?]$/.test(trimmed) ? "" : "."}`;
}

export function proactiveTypesPath(config: Pick<AppConfig, "dataDir">): string {
  return join(config.dataDir, "cognition", "proactive-types.json");
}

/** The kinds of idea the owner switched off; a broken file switches nothing off. */
export function proactiveTypesOff(config: Pick<AppConfig, "dataDir">): ReadonlySet<string> {
  try {
    const value = JSON.parse(readFileSync(proactiveTypesPath(config), "utf8")) as { readonly off?: unknown };
    return new Set(Array.isArray(value.off) ? value.off.filter((type): type is string => typeof type === "string") : []);
  } catch {
    return new Set();
  }
}

/** Switches one kind of idea on or off; false for an unknown kind. */
export function setProactiveType(config: Pick<AppConfig, "dataDir">, type: string, on: boolean): boolean {
  if (!Object.hasOwn(PROACTIVE_IDEA_TYPES, type)) return false;
  const off = new Set(proactiveTypesOff(config));
  if (on) off.delete(type);
  else off.add(type);
  const filePath = proactiveTypesPath(config);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, off: [...off].sort() })}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, filePath);
  return true;
}

/** Records the owner's verdict; false when no logged proposal has that id. */
export function decideProactiveReview(
  config: Pick<AppConfig, "dataDir">,
  id: string,
  verdict: ProactiveReviewVerdict,
  now = new Date(),
): boolean {
  const known = storedEntries(proactiveShadowLogPath(config))
    .some((entry) => entry.proposals.some((proposal) => reviewIdFor(entry, proposal) === id));
  if (!known) return false;
  appendEntry(proactiveReviewPath(config), {
    schemaVersion: 1,
    auditId: `proactive-review-${randomUUID()}`,
    reviewId: id,
    rating: VERDICT_RATING[verdict],
    operatorId: householdOwnerId() ?? "",
    decidedAt: now.toISOString(),
  } satisfies ProactiveReviewDecision);
  return true;
}

// Same id the retired review screen used, so earlier verdicts still match.
function reviewIdFor(entry: StoredShadowEntry, proposal: ProactiveShadowProposal): string {
  const digest = createHash("sha256")
    .update(`${entry.timestamp}:${entry.fingerprint}:${proposal.opportunityId}`)
    .digest("hex")
    .slice(0, 20);
  return `opportunity-review-${digest}`;
}

export class PersistentProactiveShadowService {
  private readonly loggedFingerprints: Set<string>;
  private readonly loggedOpportunityIds: Set<string>;
  /** Held-back ideas already logged; kept apart so a hold never stops the idea later. */
  private readonly loggedHeldBackIds: Set<string>;
  private evaluationInFlight: Promise<ProactiveShadowEntry | null> | null = null;
  private remoteSourceCache: {
    readonly refreshAfterMs: number;
    readonly opportunities: readonly Opportunity[];
  } | null = null;

  constructor(
    private readonly config: ProactiveShadowConfig,
    private readonly options: {
      readonly houseState?: HouseStateProvider;
      readonly stateCache?: HaStateCache;
      readonly weatherForecastFetcher?: HaWeatherForecastFetcher;
      readonly todoFetcher?: HaTodoFetcher;
      readonly calendarFetcher?: HaCalendarFetcher;
      readonly targetPersonId?: string;
      readonly targetPresencePersonId?: string;
      /** Where queued opportunities wait (the household memory database). */
      readonly memory?: Pick<HouseholdMemory, "queuedOpportunities">;
      readonly now?: () => Date;
      readonly onError?: (message: string) => void;
    } = {},
  ) {
    const logged = loggedState(proactiveShadowLogPath(config));
    this.loggedFingerprints = logged.fingerprints;
    this.loggedOpportunityIds = logged.opportunityIds;
    this.loggedHeldBackIds = logged.heldBackIds;
  }

  async evaluateNow(): Promise<ProactiveShadowEntry | null> {
    const startedAt = this.options.now?.() ?? new Date();
    const proactiveEnabled = cognitiveFeatureEnabled(this.config, "proactive");
    const helperEnabled = proactiveHelperEnabled(this.options.stateCache);
    if (!proactiveEnabled || !helperEnabled) return null;
    if (this.options.stateCache && !this.options.stateCache.hasReceivedStateSnapshot()) return null;
    if (this.evaluationInFlight) return this.evaluationInFlight;
    const evaluation = this.evaluateOnce(startedAt);
    this.evaluationInFlight = evaluation;
    try {
      return await evaluation;
    } finally {
      if (this.evaluationInFlight === evaluation) this.evaluationInFlight = null;
    }
  }

  private async evaluateOnce(now: Date): Promise<ProactiveShadowEntry | null> {
    const houseSnapshot = this.options.houseState?.snapshot(now) ?? null;
    const live = await this.liveSourceOpportunities(now, houseSnapshot);
    const summary = buildProactiveDashboardSummary(this.config, {
      now,
      channels: ["voice"],
      minimumUsefulness: 0.7,
      ...(houseSnapshot ? { houseState: { snapshot: () => houseSnapshot } } : {}),
      ...(this.options.targetPersonId ? { targetPersonId: this.options.targetPersonId } : {}),
      ...(this.options.targetPresencePersonId
        ? { targetPresencePersonId: this.options.targetPresencePersonId }
        : {}),
      queuedOpportunities: this.options.memory?.queuedOpportunities() ?? [],
      liveSourceOpportunities: live,
      excludeOpportunityIds: this.loggedOpportunityIds,
    });
    const built = buildProactiveShadowEntry(summary, now, this.loggedOpportunityIds, {
      typesOff: proactiveTypesOff(this.config),
      heldBackLogged: this.loggedHeldBackIds,
    });
    const entry = this.loggedFingerprints.has(built.fingerprint) && built.proposals.length > 0
      ? { ...built, proposals: [], outcome: built.heldBack.length > 0 ? "held_back" as const : "nothing_eligible" as const }
      : built;
    if (entry.proposals.length === 0 && entry.heldBack.length === 0) return null;
    appendEntry(proactiveShadowLogPath(this.config), entry);
    if (entry.proposals.length > 0) this.loggedFingerprints.add(entry.fingerprint);
    for (const proposal of entry.proposals) this.loggedOpportunityIds.add(proposal.opportunityId);
    for (const idea of entry.heldBack) this.loggedHeldBackIds.add(idea.opportunityId);
    return entry;
  }

  private async liveSourceOpportunities(
    now: Date,
    houseSnapshot: HouseStateSnapshot | null,
  ): Promise<readonly Opportunity[]> {
    const stateCache = this.options.stateCache;
    if (!stateCache || !houseSnapshot) return [];
    const device = collectDeviceProblemOpportunities({
      now,
      targetPersonId: this.options.targetPersonId ?? householdOwnerId() ?? "",
      stateCache,
    });
    if (!this.remoteSourceCache || now.getTime() >= this.remoteSourceCache.refreshAfterMs) {
      const collected = await collectRemoteProactiveOpportunities({
        now,
        targetPersonId: this.options.targetPersonId ?? householdOwnerId() ?? "",
        timezone: houseSnapshot.timezone,
        houseSnapshot,
        stateCache,
        ...(this.options.weatherForecastFetcher ? { weatherForecastFetcher: this.options.weatherForecastFetcher } : {}),
        ...(this.options.todoFetcher ? { todoFetcher: this.options.todoFetcher } : {}),
        ...(this.options.calendarFetcher ? { calendarFetcher: this.options.calendarFetcher } : {}),
      });
      for (const failure of collected.failures) {
        this.options.onError?.(`${failure.source} opportunity source failed: ${failure.message}`);
      }
      this.remoteSourceCache = {
        refreshAfterMs: now.getTime() + (collected.failures.length > 0 ? 60_000 : 5 * 60_000),
        opportunities: collected.opportunities,
      };
    }
    const houseCare = collectHouseCareOpportunities({
      now,
      targetPersonId: this.options.targetPersonId ?? householdOwnerId() ?? "",
      stateCache,
      houseSnapshot,
    });
    return [...device, ...houseCare, ...this.remoteSourceCache.opportunities];
  }
}

export function buildProactiveShadowEntry(
  summary: ProactiveDashboardSummary,
  now: Date,
  excludedOpportunityIds: ReadonlySet<string> = new Set(),
  options: {
    /** Kinds the owner switched off: held back, never proposed. */
    readonly typesOff?: ReadonlySet<string>;
    readonly heldBackLogged?: ReadonlySet<string>;
  } = {},
): ProactiveShadowEntry {
  const typesOff = options.typesOff ?? new Set<string>();
  const voiceSlots = summary.topEligible
    .filter((slot) => slot.channel === "voice" && !excludedOpportunityIds.has(slot.opportunityId));
  const proposals = voiceSlots
    .filter((slot) => !typesOff.has(slot.opportunityType))
    .map((slot) => proposal(slot, summary, now));
  const heldBack: ProactiveHeldBackIdea[] = [
    ...voiceSlots
      .filter((slot) => typesOff.has(slot.opportunityType))
      .map((slot) => ({
        opportunityId: slot.opportunityId,
        opportunityType: slot.opportunityType,
        proposedText: proposedText(slot.opportunityType, slot.summary),
        reasons: ["switched_off" as const],
      })),
    ...summary.rejectedCandidates.flatMap((candidate): ProactiveHeldBackIdea[] => {
      const reasons: ProactiveHeldBackReason[] = [
        ...(typesOff.has(candidate.opportunityType) ? ["switched_off" as const] : []),
        ...candidate.reasons.filter((reason): reason is ProactiveSuppressionReason => reason !== "already_logged"),
      ];
      const due = candidate.reasons.length > 0
        && candidate.reasons.every((reason) => reason !== "already_logged" && HELD_BACK_REASONS[reason] !== undefined);
      return due && !excludedOpportunityIds.has(candidate.opportunityId)
        ? [{
          opportunityId: candidate.opportunityId,
          opportunityType: candidate.opportunityType,
          proposedText: proposedText(candidate.opportunityType, candidate.summary),
          reasons,
        }]
        : [];
    }),
  ].filter((idea) => !options.heldBackLogged?.has(idea.opportunityId));
  const fingerprint = proposalFingerprint(summary.targetPersonId, proposals);
  return {
    timestamp: now.toISOString(),
    mode: "shadow_only",
    fingerprint,
    targetPersonId: summary.targetPersonId,
    proposals,
    heldBack,
    context: summary.house,
    sources: summary.sources,
    suppressionCounts: summary.suppressionCounts,
    outcome: proposals.length > 0 ? "would_suggest" : heldBack.length > 0 ? "held_back" : "nothing_eligible",
  };
}

function proposal(
  slot: ProactiveDashboardEligibleSlot,
  summary: ProactiveDashboardSummary,
  now: Date,
): ProactiveShadowProposal {
  const context = [
    `${slot.source === "live" ? "validated live" : "accepted memory"} ${slot.opportunityType.replaceAll("_", " ")} passed the ${slot.channel} gates`,
    `safe slot ${slot.slotType.replaceAll("_", " ")}`,
    `usefulness ${slot.usefulnessScore.toFixed(3)}`,
    `household audience ${summary.house.audiencePersonIds.join(", ") || "none"}`,
    `target present ${String(summary.house.targetPersonPresent)}`,
    `quiet hours ${String(summary.house.quietHoursActive)}`,
    `bedtime ${String(summary.house.bedtimeActive)}`,
  ];
  if (slot.sourceReason) context.splice(1, 0, slot.sourceReason);
  if (slot.opportunityType === "upcoming_event_reminder") {
    context.splice(1, 0, `event due ${timeUntil(slot.expiresAt, now)}`);
  }
  const plainWhy = slot.sourceReason
    ? sentence(slot.sourceReason)
    : `From something he remembers${slot.opportunityType === "upcoming_event_reminder" ? `; it's due ${timeUntil(slot.expiresAt, now)}` : ""}.`;
  return {
    proposedText: proposedText(slot.opportunityType, slot.summary),
    opportunityId: slot.opportunityId,
    opportunityType: slot.opportunityType,
    targetPersonId: slot.targetPersonId,
    channel: slot.channel,
    slotType: slot.slotType,
    usefulnessScore: slot.usefulnessScore,
    sensitivity: slot.sensitivity,
    source: slot.source,
    why: context.join("; "),
    plainWhy,
  };
}

function proposedText(opportunityType: string, summary: string): string {
  const separator = summary.indexOf(": ");
  const base = separator >= 0 ? summary.slice(separator + 2) : summary;
  return opportunityType === "upcoming_event_reminder" ? `Reminder: ${base}` : base;
}

function timeUntil(expiresAt: string, now: Date): string {
  const minutes = Math.max(0, Math.round((Date.parse(expiresAt) - now.getTime()) / 60_000));
  if (minutes < 90) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `in ${hours} hours`;
}

function proposalFingerprint(targetPersonId: string, proposals: readonly ProactiveShadowProposal[]): string {
  return createHash("sha256")
    .update(JSON.stringify({
      targetPersonId,
      proposals: proposals.map((item) => ({
        opportunityId: item.opportunityId,
        proposedText: item.proposedText,
        channel: item.channel,
      })),
    }))
    .digest("hex");
}

function appendEntry(filePath: string, entry: ProactiveShadowEntry | ProactiveReviewDecision): void {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function loggedState(filePath: string): {
  readonly fingerprints: Set<string>;
  readonly opportunityIds: Set<string>;
  readonly heldBackIds: Set<string>;
} {
  const fingerprints = new Set<string>();
  const opportunityIds = new Set<string>();
  const heldBackIds = new Set<string>();
  for (const entry of storedEntries(filePath)) {
    if (entry.proposals.length > 0) fingerprints.add(proposalFingerprint(entry.targetPersonId, entry.proposals));
    for (const proposal of entry.proposals) opportunityIds.add(proposal.opportunityId);
    for (const idea of entry.heldBack) heldBackIds.add(idea.opportunityId);
  }
  return { fingerprints, opportunityIds, heldBackIds };
}

interface StoredShadowEntry {
  readonly timestamp: string;
  readonly fingerprint: string;
  readonly targetPersonId: string;
  readonly proposals: readonly ProactiveShadowProposal[];
  readonly heldBack: readonly ProactiveHeldBackIdea[];
}

function storedEntries(filePath: string): StoredShadowEntry[] {
  return readJsonLines(filePath).flatMap((value) => {
    const entry = value as Partial<StoredShadowEntry>;
    if (typeof entry.targetPersonId !== "string" || !Array.isArray(entry.proposals)) return [];
    const proposals = entry.proposals.filter(isStoredProposal);
    const heldBack = Array.isArray(entry.heldBack) ? entry.heldBack.filter(isStoredHeldBack) : [];
    return proposals.length > 0 || heldBack.length > 0
      ? [{
        timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
        fingerprint: typeof entry.fingerprint === "string" ? entry.fingerprint : "",
        targetPersonId: entry.targetPersonId,
        proposals,
        heldBack,
      }]
      : [];
  });
}

function readJsonLines(filePath: string): unknown[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8").trim().split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      // Ignore an incomplete tail; append-only recovery must not stop the assistant.
      return [];
    }
  });
}

function isStoredHeldBack(value: unknown): value is ProactiveHeldBackIdea {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const idea = value as Partial<ProactiveHeldBackIdea>;
  return typeof idea.opportunityId === "string"
    && typeof idea.opportunityType === "string"
    && typeof idea.proposedText === "string"
    && Array.isArray(idea.reasons);
}

function isStoredProposal(value: unknown): value is ProactiveShadowProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proposal = value as Partial<ProactiveShadowProposal>;
  return typeof proposal.opportunityId === "string"
    && typeof proposal.proposedText === "string"
    && typeof proposal.opportunityType === "string"
    && typeof proposal.why === "string"
    && proposal.channel === "voice";
}
