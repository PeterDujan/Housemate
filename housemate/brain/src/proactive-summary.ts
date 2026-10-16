import { existsSync } from "node:fs";

import type { AliasEntry } from "./alias-schema.js";
import type { AppConfig } from "./config.js";
import { cognitiveFeatureEnabled } from "./cognitive-control.js";
import type { HouseStateProvider, HouseStateSnapshot } from "./house-state.js";
import type { MemoryRecord, SensitivityCategory } from "./memory-schema.js";
import { MemoryStore, memoryStorePath } from "./memory-store.js";
import {
  emptyProactiveSuppressionCounts,
  evaluateProactiveEligibility,
  generateMemoryOpportunities,
  type Opportunity,
  type ProactiveChannel,
  type ProactiveEligibleSlot,
  type ProactiveSuppressionReason,
} from "./proactive-opportunity.js";
import { canonicalHouseholdPersonLabel } from "./speaker-principal.js";
import { householdOwnerId } from "./household.js";

const DASHBOARD_CHANNELS: readonly ProactiveChannel[] = ["chat", "voice"];
const TOP_ELIGIBLE_LIMIT = 5;

export interface ProactiveDashboardHouseSummary {
  readonly timezone: string | null;
  readonly occupancy: HouseStateSnapshot["modes"]["occupancy"] | null;
  readonly timeMode: HouseStateSnapshot["modes"]["time"] | null;
  readonly householdAudiencePresent: boolean;
  readonly targetPersonPresent: boolean;
  readonly audiencePersonIds: readonly string[];
  readonly quietHoursActive: boolean;
  readonly bedtimeActive: boolean;
}

export interface ProactiveDashboardSourceSummary {
  readonly existingOpportunityCount: number;
  readonly generatedOpportunityCount: number;
  readonly liveSourceOpportunityCount: number;
  readonly candidateOpportunityCount: number;
}

export interface ProactiveDashboardEligibleSlot {
  readonly opportunityId: string;
  readonly title: string;
  readonly summary: string;
  readonly opportunityType: string;
  readonly channel: ProactiveChannel;
  readonly slotType: ProactiveEligibleSlot["slotType"];
  readonly targetPersonId: string;
  readonly usefulnessScore: number;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly sensitivity: readonly SensitivityCategory[];
  readonly source: "memory" | "live";
  readonly sourceReason: string | null;
}

export interface ProactiveDashboardRejectedCandidate {
  readonly opportunityId: string;
  readonly title: string;
  readonly summary: string;
  readonly opportunityType: string;
  readonly source: "memory" | "live";
  readonly usefulnessScore: number;
  readonly reasons: readonly (ProactiveSuppressionReason | "already_logged")[];
}

export interface ProactiveDashboardSummary {
  readonly targetPersonId: string;
  readonly storePresent: boolean;
  readonly house: ProactiveDashboardHouseSummary;
  readonly sources: ProactiveDashboardSourceSummary;
  readonly eligible: Readonly<Record<"chat" | "voice", number>>;
  readonly suppressionCounts: Readonly<Record<ProactiveSuppressionReason, number>>;
  readonly topEligible: readonly ProactiveDashboardEligibleSlot[];
  readonly rejectedCandidates: readonly ProactiveDashboardRejectedCandidate[];
}

export function buildProactiveDashboardSummary(
  config: Pick<AppConfig, "dataDir"> & Partial<Pick<AppConfig, "cognitiveSystemEnabled" | "cognitiveProactiveEnabled">>,
  options: {
    readonly now?: Date;
    readonly houseState?: HouseStateProvider;
    readonly targetPersonId?: string;
    readonly targetPresencePersonId?: string;
    readonly channels?: readonly ProactiveChannel[];
    readonly minimumUsefulness?: number;
    /** The opportunity queue in the household memory database. */
    readonly queuedOpportunities?: readonly Opportunity[];
    readonly liveSourceOpportunities?: readonly Opportunity[];
    readonly excludeOpportunityIds?: ReadonlySet<string>;
  } = {},
): ProactiveDashboardSummary {
  const now = options.now ?? new Date();
  const targetPersonId = options.targetPersonId ?? (householdOwnerId() ?? "");
  if (!cognitiveFeatureEnabled(config, "proactive")) {
    return emptySummary(targetPersonId, null, options.targetPresencePersonId);
  }
  const houseSnapshot = options.houseState?.snapshot(now) ?? null;
  const filePath = memoryStorePath(config);
  if (!existsSync(filePath)) {
    return emptySummary(targetPersonId, houseSnapshot, options.targetPresencePersonId);
  }

  const store = new MemoryStore(filePath);
  let records: readonly MemoryRecord[];
  try {
    records = store.listMemoryRecords();
  } finally {
    store.close();
  }

  const existingOpportunities = options.queuedOpportunities ?? [];
  const generated = generateMemoryOpportunities(records, {
    now: now.toISOString(),
    defaultTargetPersonId: targetPersonId,
    queued: existingOpportunities,
  });
  const liveSourceOpportunities = options.liveSourceOpportunities ?? [];
  const candidates = mergeOpportunityCandidates(existingOpportunities, [
    ...generated.opportunities,
    ...liveSourceOpportunities,
  ]);
  const eligible = evaluateProactiveEligibility(candidates, {
    now: now.toISOString(),
    targetPersonId,
    channels: options.channels ?? DASHBOARD_CHANNELS,
    chatSlotOpen: true,
    voiceSlotMode: "end_of_conversation",
    voiceAudiencePresent: householdAudiencePresent(houseSnapshot),
    voiceTargetPresent: proactiveTargetPersonPresent(
      houseSnapshot,
      targetPersonId,
      options.targetPresencePersonId,
    ),
    quietHoursActive: houseSnapshot?.activity.quietHoursActive ?? false,
    annoyanceBudgetRemaining: 1,
    allowSensitiveVoice: false,
    ...(options.minimumUsefulness === undefined ? {} : { minimumUsefulness: options.minimumUsefulness }),
  });
  const candidatesById = new Map(candidates.map((record) => [record.id, record]));
  const eligibleOpportunityIds = new Set(eligible.eligibleSlots.map((slot) => slot.opportunityId));

  return {
    targetPersonId,
    storePresent: true,
    house: summarizeHouse(houseSnapshot, targetPersonId, options.targetPresencePersonId),
    sources: {
      existingOpportunityCount: existingOpportunities.length,
      generatedOpportunityCount: generated.opportunities.length,
      liveSourceOpportunityCount: liveSourceOpportunities.length,
      candidateOpportunityCount: candidates.length,
    },
    eligible: {
      chat: eligible.eligibleSlots.filter((slot) => slot.channel === "chat").length,
      voice: eligible.eligibleSlots.filter((slot) => slot.channel === "voice").length,
    },
    suppressionCounts: eligible.suppressionCounts,
    rejectedCandidates: candidates.flatMap((record) => {
      const reasons = options.excludeOpportunityIds?.has(record.id)
        ? ["already_logged" as const]
        : [...new Set(eligible.suppressions.filter((item) => item.opportunityId === record.id).map((item) => item.reason))];
      if (eligibleOpportunityIds.has(record.id) && reasons.length === 0) return [];
      return [{
        opportunityId: record.id,
        title: record.title,
        summary: record.summary,
        opportunityType: record.type,
        source: record.source.kind,
        usefulnessScore: record.usefulness,
        reasons,
      }];
    }),
    topEligible: eligible.eligibleSlots
      .filter((slot) => !options.excludeOpportunityIds?.has(slot.opportunityId))
      .slice(0, TOP_ELIGIBLE_LIMIT)
      .flatMap((slot) => {
        const record = candidatesById.get(slot.opportunityId);
        return record ? [summarizeEligibleSlot(slot, record)] : [];
      }),
  };
}

function emptySummary(
  targetPersonId: string,
  houseSnapshot: HouseStateSnapshot | null,
  targetPresencePersonId?: string,
): ProactiveDashboardSummary {
  return {
    targetPersonId,
    storePresent: false,
    house: summarizeHouse(houseSnapshot, targetPersonId, targetPresencePersonId),
    sources: {
      existingOpportunityCount: 0,
      generatedOpportunityCount: 0,
      liveSourceOpportunityCount: 0,
      candidateOpportunityCount: 0,
    },
    eligible: {
      chat: 0,
      voice: 0,
    },
    suppressionCounts: emptyProactiveSuppressionCounts(),
    rejectedCandidates: [],
    topEligible: [],
  };
}

function summarizeHouse(
  snapshot: HouseStateSnapshot | null,
  targetPersonId: string,
  targetPresencePersonId?: string,
): ProactiveDashboardHouseSummary {
  return {
    timezone: snapshot?.timezone ?? null,
    occupancy: snapshot?.modes.occupancy ?? null,
    timeMode: snapshot?.modes.time ?? null,
    householdAudiencePresent: householdAudiencePresent(snapshot),
    targetPersonPresent: proactiveTargetPersonPresent(snapshot, targetPersonId, targetPresencePersonId),
    audiencePersonIds: snapshot?.presence.presentPersonIds ?? [],
    quietHoursActive: snapshot?.activity.quietHoursActive ?? false,
    bedtimeActive: snapshot?.activity.bedtimeActive ?? false,
  };
}

export function proactiveTargetPersonPresent(
  snapshot: HouseStateSnapshot | null,
  targetPersonId: string,
  targetPresencePersonId?: string,
): boolean {
  if (!snapshot) return false;
  return snapshot.presence.presentPersonIds.includes(targetPresencePersonId ?? targetPersonId);
}

export function proactivePresencePersonId(
  targetPersonId: string,
  aliases: readonly AliasEntry[],
): string | null {
  const targetLabel = canonicalHouseholdPersonLabel(targetPersonId)?.trim().toLowerCase();
  if (!targetLabel) return null;
  const matches = aliases.filter((entry) =>
    entry.normalizedAlias === targetLabel
      && entry.target.kind === "entity"
      && entry.target.entityId.startsWith("person.")
  );
  return matches.length === 1 && matches[0]?.target.kind === "entity"
    ? matches[0].target.entityId
    : null;
}

function householdAudiencePresent(snapshot: HouseStateSnapshot | null): boolean {
  return snapshot?.modes.occupancy === "occupied";
}

function summarizeEligibleSlot(
  slot: ProactiveEligibleSlot,
  record: Opportunity,
): ProactiveDashboardEligibleSlot {
  return {
    opportunityId: record.id,
    title: record.title,
    summary: record.summary,
    opportunityType: record.type,
    channel: slot.channel,
    slotType: slot.slotType,
    targetPersonId: slot.targetPersonId,
    usefulnessScore: slot.usefulnessScore,
    notBefore: record.notBefore,
    expiresAt: record.expiresAt,
    sensitivity: record.sensitivity,
    source: record.source.kind,
    sourceReason: record.source.kind === "live" ? record.source.reason : null,
  };
}

function mergeOpportunityCandidates(
  existing: readonly Opportunity[],
  generated: readonly Opportunity[],
): readonly Opportunity[] {
  const merged = new Map<string, Opportunity>();
  for (const record of existing) {
    merged.set(record.id, record);
  }
  for (const record of generated) {
    if (!merged.has(record.id)) {
      merged.set(record.id, record);
    }
  }
  return [...merged.values()].sort((left, right) => right.usefulness - left.usefulness
    || left.expiresAt.localeCompare(right.expiresAt)
    || left.id.localeCompare(right.id));
}
