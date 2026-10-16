import type { AliasEntry } from "./alias-schema.js";
import type { HaHistoryFetcher, HaHistoryState } from "./ha-history.js";
import type { HaEntityState, HaStateCache } from "./ha-state-cache.js";
import { canonicalHouseholdPersonLabel } from "./speaker-principal.js";
import type { TimeWindow } from "./time-window-parser.js";
import { attributeText } from "./ha-state-cache.js";
import { HOUSE_LOCALE } from "./house-config.js";

const MINIMUM_ZONE_INTERVAL_MS = 15 * 60 * 1_000;
const MUCH_OF_DAY_MS = 8 * 60 * 60 * 1_000;
const MAXIMUM_WINDOW_MS = 26 * 60 * 60 * 1_000;
const DEFAULT_HISTORY_TIMEOUT_MS = 1_500;
const RESERVED_NON_LOCATION_STATES = new Set([
  "away",
  "not home",
  "unavailable",
  "unknown",
]);

export interface HistoricalPresenceOpportunity {
  readonly actorId: string;
  readonly window: TimeWindow;
  readonly fallbackText: string;
  readonly memorySnapshotToken: string;
}

export interface HistoricalPresenceInference {
  readonly text: string;
  readonly confidence: "medium";
  readonly sourceEntityIds: readonly string[];
  readonly notes: string;
}

export interface HistoricalPresenceInferenceServices {
  readonly stateCache?: Pick<HaStateCache, "get" | "entries">;
  readonly historyFetcher?: Partial<Pick<HaHistoryFetcher, "fetchHistory">>;
  readonly aliases?: readonly AliasEntry[];
}

interface ZoneIdentity {
  readonly entityId: string;
  readonly key: string;
  readonly label: string;
  readonly home: boolean;
}

interface PresenceInterval {
  readonly zone: ZoneIdentity;
  readonly startMs: number;
  readonly endMs: number;
}

interface ZoneSummary {
  readonly zone: ZoneIdentity;
  readonly totalMs: number;
  readonly intervals: readonly PresenceInterval[];
}

export async function inferHistoricalPresence(
  opportunity: HistoricalPresenceOpportunity,
  services: HistoricalPresenceInferenceServices,
  options: {
    readonly timeoutMs?: number;
  } = {},
): Promise<HistoricalPresenceInference | null> {
  const stateCache = services.stateCache;
  const fetchHistory = services.historyFetcher?.fetchHistory;
  if (!stateCache || !fetchHistory) {
    return null;
  }
  const startMs = Date.parse(opportunity.window.start);
  const endMs = Date.parse(opportunity.window.end);
  if (
    !Number.isFinite(startMs)
    || !Number.isFinite(endMs)
    || endMs <= startMs
    || endMs - startMs > MAXIMUM_WINDOW_MS
  ) {
    return null;
  }

  const personEntityId = resolveHistoricalPersonEntityId(
    opportunity.actorId,
    stateCache,
    services.aliases ?? [],
  );
  const zoneStates = registeredZoneStates(stateCache.entries());
  if (!personEntityId || zoneStates.size === 0) {
    return null;
  }

  try {
    const history = await withinDeadline(
      fetchHistory.call(services.historyFetcher, {
        entityIds: [personEntityId],
        window: opportunity.window,
        significantChangesOnly: true,
        minimalResponse: true,
        includeStartTimeState: true,
        noAttributes: true,
      }),
      options.timeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS,
    );
    const intervals = historicalPresenceIntervals(
      history.states,
      personEntityId,
      opportunity.window,
      zoneStates,
    );
    const evidenceSentence = renderPresenceEvidence(
      intervals,
      opportunity.window,
    );
    if (!evidenceSentence) {
      return null;
    }
    return {
      text: `${opportunity.fallbackText.trim()} ${evidenceSentence}`,
      confidence: "medium",
      sourceEntityIds: [personEntityId],
      notes: [
        "accepted episodic memory search found no match",
        "historical presence inferred from exact person history",
        `${intervals.length} bounded registered-zone interval${intervals.length === 1 ? "" : "s"}`,
        history.cached ? "history cache hit" : "history cache miss",
      ].join("; "),
    };
  } catch {
    return null;
  }
}

export function resolveHistoricalPersonEntityId(
  actorId: string,
  stateCache: Pick<HaStateCache, "get" | "entries">,
  aliases: readonly AliasEntry[],
): string | null {
  const canonicalLabel = canonicalHouseholdPersonLabel(actorId);
  if (!canonicalLabel) {
    return null;
  }
  if (actorId.startsWith("person.") && stateCache.get(actorId)) {
    return actorId;
  }
  const normalizedLabel = normalizeState(canonicalLabel);
  const matches = aliases.filter((alias) =>
    normalizeState(alias.normalizedAlias) === normalizedLabel
    && alias.target.kind === "entity"
    && alias.target.entityId.startsWith("person.")
    && stateCache.get(alias.target.entityId) !== null
  );
  if (matches.length !== 1) {
    return null;
  }
  const target = matches[0]?.target;
  return target?.kind === "entity" ? target.entityId : null;
}

function registeredZoneStates(
  states: readonly HaEntityState[],
): ReadonlyMap<string, ZoneIdentity> {
  const candidates = new Map<string, ZoneIdentity[]>();
  for (const state of states) {
    if (!state.entityId.startsWith("zone.")) {
      continue;
    }
    const objectId = state.entityId.slice("zone.".length);
    const label = attributeText(state, "friendly_name")
      || titleCase(objectId.replaceAll("_", " "));
    const identity: ZoneIdentity = {
      entityId: state.entityId,
      key: normalizeState(label),
      label,
      home: state.entityId === "zone.home",
    };
    addZoneCandidate(candidates, identity.key, identity);
    if (identity.home && identity.key !== "home") {
      addZoneCandidate(candidates, "home", identity);
    }
  }
  return new Map(
    [...candidates.entries()].flatMap(([key, identities]) =>
      identities.length === 1 && identities[0]
        ? [[key, identities[0]] as const]
        : []
    ),
  );
}

function addZoneCandidate(
  candidates: Map<string, ZoneIdentity[]>,
  key: string,
  identity: ZoneIdentity,
): void {
  if (!key) return;
  const current = candidates.get(key) ?? [];
  if (!current.some((candidate) => candidate.entityId === identity.entityId)) {
    current.push(identity);
  }
  candidates.set(key, current);
}

function historicalPresenceIntervals(
  states: readonly HaHistoryState[],
  personEntityId: string,
  window: TimeWindow,
  zoneStates: ReadonlyMap<string, ZoneIdentity>,
): readonly PresenceInterval[] {
  const windowStartMs = Date.parse(window.start);
  const windowEndMs = Date.parse(window.end);
  const sortedStates = states
    .filter((state) => state.entityId === personEntityId)
    .map((state) => ({
      state: state.state,
      changedAtMs: Date.parse(state.lastChanged),
    }))
    .filter((state) =>
      Number.isFinite(state.changedAtMs)
      && state.changedAtMs < windowEndMs
    )
    .sort((left, right) => left.changedAtMs - right.changedAtMs);
  const openingState = sortedStates
    .filter((state) => state.changedAtMs <= windowStartMs)
    .at(-1);
  const personStates = [
    ...(openingState ? [openingState] : []),
    ...sortedStates.filter((state) => state.changedAtMs > windowStartMs),
  ];

  const intervals: PresenceInterval[] = [];
  for (let index = 0; index < personStates.length; index += 1) {
    const state = personStates[index];
    if (!state) continue;
    const stateKey = normalizeState(state.state);
    if (RESERVED_NON_LOCATION_STATES.has(stateKey)) {
      continue;
    }
    const zone = zoneStates.get(stateKey);
    if (!zone) continue;
    const next = personStates[index + 1];
    const intervalStartMs = Math.max(state.changedAtMs, windowStartMs);
    const endMs = Math.min(next?.changedAtMs ?? windowEndMs, windowEndMs);
    if (endMs - intervalStartMs < MINIMUM_ZONE_INTERVAL_MS) {
      continue;
    }
    intervals.push({
      zone,
      startMs: intervalStartMs,
      endMs,
    });
  }
  return intervals;
}

function renderPresenceEvidence(
  intervals: readonly PresenceInterval[],
  window: TimeWindow,
): string | null {
  const summaries = summarizeZones(intervals);
  const home = summaries.find((summary) => summary.zone.home) ?? null;
  const named = summaries
    .filter((summary) => !summary.zone.home)
    .sort((left, right) =>
      right.totalMs - left.totalMs
      || left.zone.label.localeCompare(right.zone.label)
    );
  if (named.length === 0) {
    return home
      ? "Home Assistant's presence history suggests you were home for part of that day."
      : null;
  }

  const primary = named[0];
  if (!primary) return null;
  const later = primary.intervals.some((interval) =>
    localHour(interval.endMs - 1, window.timezone) >= 17
  );
  if (named.length === 1) {
    if (home && home.totalMs >= MUCH_OF_DAY_MS && later) {
      return `Home Assistant's presence history suggests you were home for much of the day and at ${primary.zone.label} later that day.`;
    }
    return later
      ? `Home Assistant's presence history suggests you were at ${primary.zone.label} later that day.`
      : `Home Assistant's presence history suggests you were at ${primary.zone.label} for part of that day.`;
  }

  const labels = named.slice(0, 3).map((summary) => summary.zone.label);
  return `Home Assistant's presence history suggests you were at ${joinLabels(labels)} during parts of that day.`;
}

function summarizeZones(
  intervals: readonly PresenceInterval[],
): readonly ZoneSummary[] {
  const grouped = new Map<string, PresenceInterval[]>();
  for (const interval of intervals) {
    const current = grouped.get(interval.zone.key) ?? [];
    current.push(interval);
    grouped.set(interval.zone.key, current);
  }
  return [...grouped.values()].flatMap((zoneIntervals) => {
    const zone = zoneIntervals[0]?.zone;
    if (!zone) return [];
    return [{
      zone,
      totalMs: zoneIntervals.reduce(
        (total, interval) => total + interval.endMs - interval.startMs,
        0,
      ),
      intervals: zoneIntervals,
    }];
  });
}

function localHour(timestampMs: number, timezone: string): number {
  const part = new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: timezone,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestampMs))
    .find((candidate) => candidate.type === "hour")?.value;
  return Number(part ?? Number.NaN);
}

function normalizeState(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim()
    .replaceAll(/\s+/g, " ");
}

function titleCase(value: string): string {
  return value.replaceAll(/\b\w/g, (letter) => letter.toUpperCase());
}

function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

function withinDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("historical presence query timed out")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
