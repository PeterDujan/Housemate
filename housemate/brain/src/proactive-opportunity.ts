import { createHash } from "node:crypto";

import type { EventMemoryPayload, MemoryRecord, SensitivityCategory } from "./memory-schema.js";

/*
 * Proactive Opportunities: inferred judgement calls
 * in their own shape and queue, not household memory records. Detectors read
 * the house (`proactive-live-sources.ts`) or accepted event memories (below);
 * the eligibility gate decides per channel; the evaluator runs only in shadow
 * (`proactive-shadow.ts`). Code only, no model.
 */

export type ProactiveChannel = "chat" | "voice" | "notification";

export interface Opportunity {
  readonly id: string;
  readonly type: string;
  readonly targetPersonId: string;
  readonly title: string;
  readonly summary: string;
  readonly allowedChannels: readonly ProactiveChannel[];
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly cooldownUntil: string;
  readonly usefulness: number;
  readonly sensitivity: readonly SensitivityCategory[];
  readonly status: "queued" | "suppressed" | "delivered" | "expired";
  /** A live detector and its reason, or the accepted memory it came from. */
  readonly source: { readonly kind: "live"; readonly reason: string } | { readonly kind: "memory"; readonly memoryId: string };
  /** Detector detail: entity, weather kind, redaction marker. */
  readonly tags: readonly string[];
}

// The eligibility gate.

export type VoiceSlotMode = "closed" | "end_of_conversation" | "interrupt";

export type ProactiveSuppressionReason =
  | "delivery_not_queued"
  | "target_mismatch"
  | "channel_not_allowed"
  | "unsupported_voice_opportunity"
  | "not_before"
  | "expired"
  | "cooldown_active"
  | "chat_slot_closed"
  | "notification_disabled"
  | "voice_slot_closed"
  | "voice_interruption_blocked"
  | "no_household_audience_for_voice"
  | "target_not_present_for_voice"
  | "quiet_hours"
  | "sleep_gate"
  | "annoyance_budget_exhausted"
  | "sensitive_voice_blocked"
  | "usefulness_too_low";

export interface ProactiveEligibilityOptions {
  readonly now: string;
  readonly targetPersonId: string;
  readonly channels?: readonly ProactiveChannel[];
  readonly chatSlotOpen?: boolean;
  readonly notificationsEnabled?: boolean;
  readonly voiceSlotMode?: VoiceSlotMode;
  readonly voiceInterruptionAllowed?: boolean;
  readonly voiceAudiencePresent?: boolean;
  readonly voiceTargetPresent?: boolean;
  readonly quietHoursActive?: boolean;
  readonly quietHours?: { readonly startHourUtc: number; readonly endHourUtc: number };
  readonly targetSleeping?: boolean;
  readonly annoyanceBudgetRemaining?: number;
  readonly allowSensitiveVoice?: boolean;
  readonly minimumUsefulness?: number;
}

export interface ProactiveEligibleSlot {
  readonly opportunityId: string;
  readonly targetPersonId: string;
  readonly channel: ProactiveChannel;
  readonly slotType: "chat_queue" | "notification_queue" | "voice_end_of_conversation" | "voice_interrupt";
  readonly eligibleAt: string;
  readonly expiresAt: string;
  readonly usefulnessScore: number;
  readonly reasons: readonly string[];
}

export interface ProactiveEligibilityResult {
  readonly eligibleSlots: readonly ProactiveEligibleSlot[];
  readonly suppressions: readonly { readonly opportunityId: string; readonly channel: ProactiveChannel; readonly reason: ProactiveSuppressionReason }[];
  readonly suppressionCounts: Readonly<Record<ProactiveSuppressionReason, number>>;
}

const DEFAULT_CHANNELS: readonly ProactiveChannel[] = ["chat", "notification", "voice"];
const DEFAULT_MINIMUM_USEFULNESS = 0.45;
const SUPPORTED_VOICE_OPPORTUNITIES = new Set([
  "upcoming_event_reminder",
  "imminent_weather",
  "overdue_jobs",
  "device_problem",
  "calendar_conflict",
  "bin_night",
  "house_left_open",
  "upcoming_calendar_event",
  "upkeep",
]);

const SUPPRESSION_REASONS: readonly ProactiveSuppressionReason[] = [
  "delivery_not_queued",
  "target_mismatch",
  "channel_not_allowed",
  "unsupported_voice_opportunity",
  "not_before",
  "expired",
  "cooldown_active",
  "chat_slot_closed",
  "notification_disabled",
  "voice_slot_closed",
  "voice_interruption_blocked",
  "no_household_audience_for_voice",
  "target_not_present_for_voice",
  "quiet_hours",
  "sleep_gate",
  "annoyance_budget_exhausted",
  "sensitive_voice_blocked",
  "usefulness_too_low",
];

export function evaluateProactiveEligibility(
  opportunities: readonly Opportunity[],
  options: ProactiveEligibilityOptions,
): ProactiveEligibilityResult {
  const channels = options.channels ?? DEFAULT_CHANNELS;
  const nowMs = parseTime(options.now);
  const suppressions: { opportunityId: string; channel: ProactiveChannel; reason: ProactiveSuppressionReason }[] = [];
  const eligibleSlots: ProactiveEligibleSlot[] = [];
  for (const opportunity of opportunities) {
    for (const channel of channels) {
      const result = evaluateChannel(opportunity, channel, options, nowMs);
      if ("reason" in result) {
        suppressions.push({ opportunityId: opportunity.id, channel, reason: result.reason });
      } else {
        eligibleSlots.push(result);
      }
    }
  }
  const suppressionCounts = emptyProactiveSuppressionCounts();
  for (const suppression of suppressions) suppressionCounts[suppression.reason] += 1;
  return {
    eligibleSlots: eligibleSlots.sort((left, right) =>
      right.usefulnessScore - left.usefulnessScore
      || left.expiresAt.localeCompare(right.expiresAt)
      || left.opportunityId.localeCompare(right.opportunityId)
      || left.channel.localeCompare(right.channel),
    ),
    suppressions,
    suppressionCounts,
  };
}

export function emptyProactiveSuppressionCounts(): Record<ProactiveSuppressionReason, number> {
  return Object.fromEntries(SUPPRESSION_REASONS.map((reason) => [reason, 0])) as Record<ProactiveSuppressionReason, number>;
}

function evaluateChannel(
  opportunity: Opportunity,
  channel: ProactiveChannel,
  options: ProactiveEligibilityOptions,
  nowMs: number,
): ProactiveEligibleSlot | { readonly reason: ProactiveSuppressionReason } {
  if (opportunity.status !== "queued") return { reason: "delivery_not_queued" };
  if (opportunity.targetPersonId !== options.targetPersonId) return { reason: "target_mismatch" };
  if (!opportunity.allowedChannels.includes(channel)) return { reason: "channel_not_allowed" };
  if (channel === "voice" && !SUPPORTED_VOICE_OPPORTUNITIES.has(opportunity.type)) {
    return { reason: "unsupported_voice_opportunity" };
  }
  if (parseTime(opportunity.notBefore) > nowMs) return { reason: "not_before" };
  if (parseTime(opportunity.expiresAt) <= nowMs) return { reason: "expired" };
  if (parseTime(opportunity.cooldownUntil) > nowMs) return { reason: "cooldown_active" };
  const channelGate = channelSpecificGate(opportunity, channel, options, nowMs);
  if (channelGate) return { reason: channelGate };
  if (opportunity.usefulness < (options.minimumUsefulness ?? DEFAULT_MINIMUM_USEFULNESS)) {
    return { reason: "usefulness_too_low" };
  }
  const voiceSlotMode = options.voiceSlotMode ?? "closed";
  return {
    opportunityId: opportunity.id,
    targetPersonId: opportunity.targetPersonId,
    channel,
    slotType: channel === "chat"
      ? "chat_queue"
      : channel === "notification"
        ? "notification_queue"
        : voiceSlotMode === "interrupt" ? "voice_interrupt" : "voice_end_of_conversation",
    eligibleAt: options.now,
    expiresAt: opportunity.expiresAt,
    usefulnessScore: opportunity.usefulness,
    reasons: channel === "chat"
      ? ["queued_for_operator_chat"]
      : channel === "notification"
        ? ["notification_allowed", "budget_available"]
        : voiceSlotMode === "interrupt"
          ? ["voice_interruption_allowed", "household_audience_present", "budget_available"]
          : ["voice_end_of_conversation_slot", "household_audience_present", "budget_available"],
  };
}

function channelSpecificGate(
  opportunity: Opportunity,
  channel: ProactiveChannel,
  options: ProactiveEligibilityOptions,
  nowMs: number,
): ProactiveSuppressionReason | null {
  if (channel === "chat") return options.chatSlotOpen === false ? "chat_slot_closed" : null;
  if (options.quietHoursActive) return "quiet_hours";
  if (options.quietHours && isQuietHour(nowMs, options.quietHours)) return "quiet_hours";
  if (options.targetSleeping) return "sleep_gate";
  if ((options.annoyanceBudgetRemaining ?? 1) <= 0) return "annoyance_budget_exhausted";
  if (channel === "notification") return options.notificationsEnabled ? null : "notification_disabled";
  const voiceSlotMode = options.voiceSlotMode ?? "closed";
  if (voiceSlotMode === "closed") return "voice_slot_closed";
  if (voiceSlotMode === "interrupt" && !options.voiceInterruptionAllowed) return "voice_interruption_blocked";
  if (!options.voiceAudiencePresent) return "no_household_audience_for_voice";
  if (options.voiceTargetPresent === false) return "target_not_present_for_voice";
  if (!options.allowSensitiveVoice && opportunity.sensitivity.some((item) => item !== "none")) return "sensitive_voice_blocked";
  return null;
}

function isQuietHour(nowMs: number, quietHours: { readonly startHourUtc: number; readonly endHourUtc: number }): boolean {
  const start = hour(quietHours.startHourUtc, "quiet hours startHourUtc");
  const end = hour(quietHours.endHourUtc, "quiet hours endHourUtc");
  const current = new Date(nowMs).getUTCHours();
  if (start === end) return true;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function hour(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 23) {
    throw new Error(`${label} must be an integer hour from 0 to 23`);
  }
  return value;
}

// The memory detector: an accepted upcoming event becomes a reminder opportunity.

export type MemoryOpportunitySuppressionReason =
  | "unsupported_memory_category"
  | "review_not_accepted"
  | "event_not_future"
  | "event_too_far"
  | "event_not_actionable"
  | "routine_not_eligible"
  | "routine_not_actionable"
  | "cooldown_active"
  | "usefulness_too_low";

export interface MemoryOpportunityOptions {
  readonly now: string;
  readonly defaultTargetPersonId: string;
  /** Queued opportunities, whose cooldowns hold back a new one from the same memory. */
  readonly queued?: readonly Opportunity[];
  readonly horizonHours?: number;
  readonly reminderLeadHours?: number;
  readonly minimumUsefulness?: number;
}

export function generateMemoryOpportunities(
  memories: readonly MemoryRecord[],
  options: MemoryOpportunityOptions,
): {
  readonly opportunities: readonly Opportunity[];
  readonly suppressions: readonly { readonly memoryId: string; readonly reason: MemoryOpportunitySuppressionReason }[];
} {
  const nowMs = parseTime(options.now);
  const cooldowns = new Map<string, number>();
  for (const opportunity of options.queued ?? []) {
    if (opportunity.source.kind !== "memory") continue;
    const sourceId = opportunity.source.memoryId;
    cooldowns.set(sourceId, Math.max(cooldowns.get(sourceId) ?? 0, parseTime(opportunity.cooldownUntil)));
  }
  const opportunities = new Map<string, Opportunity>();
  const suppressions: { memoryId: string; reason: MemoryOpportunitySuppressionReason }[] = [];
  for (const memory of memories) {
    const generated = opportunityForMemory(memory, options, nowMs, cooldowns);
    if ("reason" in generated) {
      suppressions.push({ memoryId: memory.id, reason: generated.reason });
    } else {
      opportunities.set(generated.id, generated);
    }
  }
  return {
    opportunities: [...opportunities.values()].sort((left, right) => left.id.localeCompare(right.id)),
    suppressions,
  };
}

function opportunityForMemory(
  memory: MemoryRecord,
  options: MemoryOpportunityOptions,
  nowMs: number,
  cooldowns: ReadonlyMap<string, number>,
): Opportunity | { readonly reason: MemoryOpportunitySuppressionReason } {
  if (memory.reviewStatus !== "accepted") return { reason: "review_not_accepted" };
  if (memory.category === "event" && memory.payload.category === "event") {
    return eventOpportunity(memory, memory.payload, options, nowMs, cooldowns);
  }
  if (memory.category === "routine" && memory.payload.category === "routine") {
    // A routine is background evidence, not news. It may later help detect a
    // deviation or support a taught Behaviour, but merely remembering it is not
    // a useful reason to start talking.
    return { reason: memory.payload.eligibleForReasoning ? "routine_not_actionable" : "routine_not_eligible" };
  }
  return { reason: "unsupported_memory_category" };
}

function eventOpportunity(
  memory: MemoryRecord,
  payload: EventMemoryPayload,
  options: MemoryOpportunityOptions,
  nowMs: number,
  cooldowns: ReadonlyMap<string, number>,
): Opportunity | { readonly reason: MemoryOpportunitySuppressionReason } {
  if (payload.status === "cancelled" || payload.status === "completed") return { reason: "event_not_actionable" };
  const eventTime = eventTimeMs(payload);
  if (eventTime <= nowMs) return { reason: "event_not_future" };
  if (eventTime - nowMs > hours(options.horizonHours ?? 168)) return { reason: "event_too_far" };
  if ((cooldowns.get(memory.id) ?? 0) > nowMs) return { reason: "cooldown_active" };
  const usefulness = eventUsefulness(memory, eventTime, nowMs);
  if (usefulness < (options.minimumUsefulness ?? 0.45)) return { reason: "usefulness_too_low" };
  const notBefore = new Date(Math.max(nowMs, eventTime - hours(options.reminderLeadHours ?? 24))).toISOString();
  const type = "upcoming_event_reminder";
  return {
    id: `mem-opportunity-${createHash("sha256").update(`${type}:${memory.id}`).digest("hex").slice(0, 16)}`,
    type,
    targetPersonId: options.defaultTargetPersonId,
    title: `Opportunity: ${memory.title}`,
    summary: `Upcoming event opportunity from memory ${memory.id}: ${memory.summary}`,
    allowedChannels: memory.sensitivity.every((item) => item === "none") ? ["chat", "voice"] : ["chat"],
    notBefore,
    expiresAt: new Date(eventTime).toISOString(),
    cooldownUntil: notBefore,
    usefulness,
    sensitivity: memory.sensitivity,
    status: "queued",
    source: { kind: "memory", memoryId: memory.id },
    tags: [],
  };
}

function eventUsefulness(memory: MemoryRecord, eventTime: number, nowMs: number): number {
  const hoursUntil = (eventTime - nowMs) / 3_600_000;
  const timingBoost = hoursUntil <= 36 ? 0.18 : hoursUntil <= 96 ? 0.1 : 0.02;
  const sensitivityBoost = memory.sensitivity.some((item) => item === "child" || item === "school" || item === "safety")
    ? 0.08
    : 0;
  return roundScore(
    memory.confidence * 0.32
    + memory.sourceReliability * 0.25
    + memory.retrievalStrength * 0.18
    + memory.storageStrength * 0.12
    + timingBoost
    + sensitivityBoost,
  );
}

function eventTimeMs(payload: EventMemoryPayload): number {
  if (payload.startsAt) return parseTime(payload.startsAt);
  if (payload.date) return parseTime(`${payload.date}T00:00:00.000Z`);
  throw new Error("event memory payload requires startsAt or date");
}

function parseTime(value: string): number {
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new Error(`invalid opportunity time: ${value}`);
  return time;
}

function hours(value: number): number {
  return value * 3_600_000;
}

function roundScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1_000) / 1_000;
}
