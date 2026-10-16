import type { ChatHouseToolName, ChatStatisticsPeriod, ChatToolCallContext, ChatToolHandlers } from "./chat-tool-bridge.js";
import type { HaEnergySources, HaStatisticSample } from "./ha-history.js";
import type { ReadAgentEvidence, ReadAgentToolCall } from "./read-agent-contracts.js";
import { createReadAgentToolSession, type AgentReadServices, type ReadAgentToolSession } from "./read-agent-tools.js";
import { recordOrNull } from "./value-guards.js";
import { HOUSE_LOCALE } from "./house-config.js";

/**
 * Read-only house tools for open chat. Each call runs
 * through the read agent's tool session, so entity grants, person-location
 * privacy, freshness and history budgets are the read agent's, not new rules.
 * One session per turn: ids found by `find_house_entities` are what the other
 * tools may read, exactly as in the read agent. History and statistics windows
 * are built here from bounded hour/day counts and granted per read, so the
 * model never supplies a timestamp. Results are short plain text rendered here
 * from the session's checked payload.
 *
 * `read_house_energy` is the one exception to model-chosen ids: it reads the
 * statistics the house's Energy dashboard is configured with (HA's own
 * `energy/get_prefs`), so one call answers "how much do we use" without a
 * search round per meter. Those are whole-house meters, never personal data.
 */

export type ChatHouseToolHandlers = Pick<ChatToolHandlers, ChatHouseToolName>;

const SEARCH_LIMIT = 8;
const SESSIONS_KEPT = 4;
const SOURCE_TIMEOUT_MS = 4_500;
const HISTORY_ROWS = 24;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_WINDOW_MS = 31 * DAY_MS;
const ENERGY_SOURCES_TTL_MS = 10 * 60 * 1_000;

export function createChatHouseToolHandlers(options: {
  /** Projected at call time so live fetchers stay current. */
  readonly services: () => AgentReadServices;
  /** HA's Energy dashboard sources; absent means `read_house_energy` is unavailable. */
  readonly energySources?: (signal?: AbortSignal) => Promise<HaEnergySources>;
  readonly timezone: string;
}): ChatHouseToolHandlers {
  let energyCache: { readonly at: number; readonly sources: HaEnergySources } | null = null;
  const sessions = new Map<string, ReadAgentToolSession>();
  // Parallel tool calls in one turn share a session; windowed reads take turns
  // so each runs under the window granted for it.
  const windowLocks = new WeakMap<ReadAgentToolSession, Promise<unknown>>();
  let sequence = 0;

  const sessionFor = (context: ChatToolCallContext): ReadAgentToolSession => {
    const key = `${context.turnId}\u0000${context.actorId}`;
    let session = sessions.get(key);
    if (!session) {
      session = createReadAgentToolSession({
        services: options.services(),
        principal: { actorId: context.actorId, label: context.actorLabel },
        historyTimeoutMs: SOURCE_TIMEOUT_MS,
        now: () => context.now,
      });
      sessions.set(key, session);
      while (sessions.size > SESSIONS_KEPT) {
        sessions.delete(sessions.keys().next().value as string);
      }
    }
    return session;
  };

  const run = async (context: ChatToolCallContext, call: Partial<ReadAgentToolCall> & Pick<ReadAgentToolCall, "name">): Promise<ReadAgentEvidence> => {
    sequence += 1;
    return sessionFor(context).execute({
      call_id: `chat-${sequence}`,
      query: null,
      entity_ids: [],
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
      ...call,
    });
  };

  const windowedRead = (
    context: ChatToolCallContext,
    window: { readonly start: Date; readonly end: Date },
    call: Partial<ReadAgentToolCall> & Pick<ReadAgentToolCall, "name">,
  ): Promise<ReadAgentEvidence> => {
    const session = sessionFor(context);
    const read = (windowLocks.get(session) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        const start = window.start.toISOString();
        const end = window.end.toISOString();
        session.grantCanonicalTimeWindow({ start, end });
        return run(context, { ...call, start, end });
      });
    windowLocks.set(session, read);
    return read;
  };

  const time = (value: unknown): string => localTime(value, options.timezone);

  return {
    async read_house_energy({ daysBack }, context) {
      const fetchStatistics = options.services().historyFetcher?.fetchStatistics;
      if (!options.energySources || !fetchStatistics) return "The energy readings are unavailable right now.";
      if (!energyCache || context.now.getTime() - energyCache.at > ENERGY_SOURCES_TTL_MS) {
        energyCache = { at: context.now.getTime(), sources: await options.energySources(context.signal) };
      }
      const sources = energyCache.sources;
      const ids = [...new Set(Object.values(sources).flat())];
      if (ids.length === 0) return "The house has no energy dashboard set up.";
      const end = context.now;
      // HA includes the day containing `start`; it is the baseline for the next day's usage.
      const start = new Date(end.getTime() - daysBack * DAY_MS);
      const result = await fetchStatistics.call(options.services().historyFetcher, {
        statisticIds: ids,
        window: { start: start.toISOString(), end: end.toISOString(), timezone: options.timezone, label: `last ${daysBack} days` },
        period: "day",
        types: ["sum"],
        fresh: true,
        signal: context.signal,
      });
      const units = (id: string): string => {
        const unit = options.services().stateCache?.get(id)?.attributes.unit_of_measurement;
        return typeof unit === "string" ? unit : "";
      };
      return energySummary(sources, result.samples, units, (value) => localTime(value, options.timezone, "day"));
    },

    async find_house_entities({ query, domain }, context) {
      const evidence = await run(context, { name: "search_entities", query, domain, limit: SEARCH_LIMIT });
      return failure(evidence) ?? (rows(evidence.payload.entities).map((row) => row.metadata_only === true
        ? `- ${text(row.label)} (${text(row.entity_id)}): a person; whether they are home is in who_is_home, never in this tool`
        : `- ${text(row.label)} (${text(row.entity_id)})${row.area ? `, ${text(row.area)}` : ""}${row.readable === false ? ", not readable" : ""}`,
      ).join("\n") || "Nothing found.");
    },

    async read_house_states({ entityIds }, context) {
      const evidence = await run(context, { name: "get_states", entity_ids: entityIds });
      return failure(evidence) ?? (rows(evidence.payload.states).map((row) => {
        const attributes = recordOrNull(row.attributes);
        const unit = attributes ? optionalText(attributes.unit_of_measurement) : "";
        const extras = ["current_temperature", "temperature", "humidity", "battery_level"]
          .filter((key) => typeof attributes?.[key] === "number" || typeof attributes?.[key] === "string")
          .map((key) => `${key.replaceAll("_", " ")} ${text(attributes?.[key])}`);
        return `- ${text(row.label)}: ${text(row.state)}${unit ? ` ${unit}` : ""}${extras.length > 0 ? ` (${extras.join(", ")})` : ""}, as of ${time(row.last_updated)}`;
      }).join("\n") || "Nothing found.");
    },

    async read_house_history({ entityIds, hoursBack }, context) {
      const end = context.now;
      const start = new Date(end.getTime() - hoursBack * HOUR_MS);
      const evidence = await windowedRead(context, { start, end }, { name: "get_history", entity_ids: entityIds });
      const failed = failure(evidence);
      if (failed) return failed;
      const units = recordOrNull(evidence.payload.units);
      const labels = labelsFor(evidence);
      const all = rows(evidence.payload.states);
      const shown = all.slice(-HISTORY_ROWS);
      const lines = shown.map((row) => {
        const entityId = text(row.entity_id);
        const unit = optionalText(units?.[entityId]);
        return `- ${time(row.last_changed ?? row.last_updated)}: ${labels.get(entityId) ?? entityId} ${text(row.state)}${unit ? ` ${unit}` : ""}`;
      });
      if (lines.length === 0) return `No recorded changes in the last ${hoursBack} hours.`;
      return [
        `Changes in the last ${hoursBack} hours${all.length > shown.length || evidence.truncated ? " (latest only)" : ""}:`,
        ...lines,
      ].join("\n");
    },

    async read_house_statistics({ entityIds, daysBack, period }, context) {
      const end = context.now;
      // One extra period in front, so the first period's usage has a baseline,
      // inside the read agent's 31-day window.
      const start = new Date(end.getTime() - Math.min(daysBack * DAY_MS + periodMs(period), MAX_WINDOW_MS));
      const evidence = await windowedRead(context, { start, end }, {
        name: "get_statistics",
        entity_ids: entityIds,
        period,
        types: ["mean", "min", "max", "sum"],
      });
      const failed = failure(evidence);
      if (failed) return failed;
      const units = recordOrNull(evidence.payload.units);
      const labels = labelsFor(evidence);
      const periodTime = (value: unknown): string => localTime(value, options.timezone, period);
      const sections: string[] = [];
      for (const entityId of entityIds) {
        const samples = rows(evidence.payload.samples).filter((row) => row.statistic_id === entityId);
        if (samples.length === 0) continue;
        const unit = optionalText(units?.[entityId]);
        const label = labels.get(entityId) ?? entityId;
        sections.push(samples.some((row) => typeof row.sum === "number")
          ? usageSection(label, unit, samples, period, periodTime)
          : measurementSection(label, unit, samples, periodTime));
      }
      if (sections.length === 0) return "No statistics recorded for that period.";
      if (evidence.truncated) sections.push("Cut short: ask for fewer entities or a longer period.");
      return sections.join("\n");
    },
  };
}

/** Usage per day for each statistic: the change in its cumulative sum, keyed by period start. */
function dailyUsage(samples: readonly HaStatisticSample[], id: string, toBase: number): Map<string, number> {
  const rows = samples.filter((sample) => sample.statisticId === id && typeof sample.sum === "number")
    .sort((left, right) => left.start.localeCompare(right.start));
  const usage = new Map<string, number>();
  for (let index = 1; index < rows.length; index += 1) {
    usage.set(rows[index]!.start, ((rows[index]!.sum as number) - (rows[index - 1]!.sum as number)) * toBase);
  }
  return usage;
}

/** Electricity meters to kWh; anything else stays in its own unit. */
function kwhFactor(unit: string): number | null {
  return unit === "kWh" ? 1 : unit === "Wh" ? 0.001 : unit === "MWh" ? 1_000 : null;
}

function energySummary(
  sources: HaEnergySources,
  samples: readonly HaStatisticSample[],
  unitOf: (id: string) => string,
  day: (value: unknown) => string,
): string {
  const electric = (ids: readonly string[]): Map<string, number> | null => {
    const total = new Map<string, number>();
    let any = false;
    for (const id of ids) {
      const factor = kwhFactor(unitOf(id));
      if (factor === null) continue;
      for (const [start, value] of dailyUsage(samples, id, factor)) {
        total.set(start, (total.get(start) ?? 0) + value);
        any = true;
      }
    }
    return any ? total : null;
  };
  const series = {
    gridIn: electric(sources.gridImport),
    gridOut: electric(sources.gridExport),
    solar: electric(sources.solar),
    batteryIn: electric(sources.batteryIn),
    batteryOut: electric(sources.batteryOut),
  };
  const days = [...new Set(Object.values(series).flatMap((item) => item ? [...item.keys()] : []))].sort();
  if (days.length === 0) return "No energy statistics recorded for that period.";
  const at = (item: Map<string, number> | null, start: string): number => item?.get(start) ?? 0;
  const home = new Map(days.map((start) => [start,
    at(series.gridIn, start) + at(series.solar, start) - at(series.gridOut, start)
    + at(series.batteryOut, start) - at(series.batteryIn, start)]));
  // A meter glitch (a counter jump) shows as a negative day; such days are left
  // out of every total rather than dragging the averages into nonsense.
  const faulty = new Set(days.filter((start) => (home.get(start) ?? 0) < 0
    || Object.values(series).some((item) => at(item, start) < -0.01)));
  const good = days.filter((start) => !faulty.has(start));
  if (good.length === 0) return "The energy meters' readings for that period are faulty.";
  const total = (item: Map<string, number> | null): number => good.reduce((sum, start) => sum + at(item, start), 0);
  const line = (label: string, item: Map<string, number> | null): string | null =>
    item ? `- ${label}: ${round(total(item))} kWh (${round(total(item) / good.length)} a day)` : null;
  const lines = [
    `Energy for the last ${days.length} day${days.length === 1 ? "" : "s"}, today so far included, from the house's energy dashboard:`,
    line("Home's own electricity use", home),
    line("From the grid", series.gridIn),
    line("Sent back to the grid", series.gridOut),
    line("Solar made", series.solar),
    line("Battery charged", series.batteryIn),
    line("Battery discharged", series.batteryOut),
  ].filter((item): item is string => item !== null);
  for (const [label, ids] of [["Gas", sources.gas], ["Water", sources.water]] as const) {
    const id = ids[0];
    if (!id) continue;
    const usage = dailyUsage(samples, id, 1);
    const used = good.reduce((sum, start) => sum + (usage.get(start) ?? 0), 0);
    lines.push(`- ${label}: ${round(used)} ${unitOf(id)} (${round(used / good.length)} a day)`);
  }
  lines.push("Home use = grid + solar - sent back + battery discharged - battery charged.");
  if (faulty.size > 0) {
    lines.push(`${faulty.size} day${faulty.size === 1 ? "" : "s"} with faulty meter readings left out: ${[...faulty].map(day).join(", ")}.`);
  }
  lines.push(`Home use by day: ${good.map((start) => `${day(start)} ${round(home.get(start))}`).join("; ")}.`);
  return lines.join("\n");
}

/** Energy, gas and water: the cumulative sum, turned into usage per period. */
function usageSection(
  label: string,
  unit: string,
  samples: readonly Record<string, unknown>[],
  period: ChatStatisticsPeriod,
  time: (value: unknown) => string,
): string {
  const lines: string[] = [];
  let total = 0;
  let counted = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]?.sum;
    const current = samples[index]?.sum;
    if (typeof previous !== "number" || typeof current !== "number") continue;
    const used = current - previous;
    total += used;
    counted += 1;
    lines.push(`- ${time(samples[index]?.start)}: ${round(used)}`);
  }
  if (counted === 0) return `${label}: not enough data.`;
  return [
    `${label}, used per ${period}${unit ? ` in ${unit}` : ""} (period start: amount):`,
    ...lines,
    `Total ${round(total)}${unit ? ` ${unit}` : ""} over ${counted} ${period}${counted === 1 ? "" : "s"}, average ${round(total / counted)} per ${period}. The latest ${period} may still be in progress.`,
  ].join("\n");
}

function measurementSection(
  label: string,
  unit: string,
  samples: readonly Record<string, unknown>[],
  time: (value: unknown) => string,
): string {
  return [
    `${label}${unit ? ` (${unit})` : ""}, per period (start: mean, min, max):`,
    ...samples.slice(1).map((row) =>
      `- ${time(row.start)}: ${["mean", "min", "max"].map((key) => typeof row[key] === "number" ? round(row[key]) : "?").join(", ")}`),
  ].join("\n");
}

function failure(evidence: ReadAgentEvidence): string | null {
  if (evidence.status === "ok" || evidence.status === "empty") {
    return null;
  }
  const reason = typeof evidence.payload.reason === "string" ? evidence.payload.reason : "";
  return reason || "That house reading is unavailable right now.";
}

function labelsFor(evidence: ReadAgentEvidence): Map<string, string> {
  return new Map(evidence.entityIds.map((entityId, index) => [entityId, evidence.sourceLabels[index] ?? entityId]));
}

function periodMs(period: ChatStatisticsPeriod): number {
  return period === "hour" ? HOUR_MS : period === "week" ? 7 * DAY_MS : DAY_MS;
}

function localTime(value: unknown, timezone: string, period: ChatStatisticsPeriod = "hour"): string {
  const date = typeof value === "string" ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return "unknown time";
  // Assembled from parts: some Node ICU builds render en-AU in US order.
  const parts = Object.fromEntries(new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const day = `${parts.weekday} ${parts.day} ${parts.month}`;
  if (period === "week") return `week of ${day}`;
  if (period === "day") return day;
  return `${day}, ${parts.hour}:${parts.minute} ${String(parts.dayPeriod ?? "").toLowerCase()}`.trimEnd();
}

function round(value: unknown): string {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(number)) return "?";
  return String(Math.abs(number) >= 100 ? Math.round(number) : Math.round(number * 100) / 100);
}

function rows(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => recordOrNull(item) !== null) : [];
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value).replaceAll(/\s+/g, " ").trim()
    : "";
}

function optionalText(value: unknown): string {
  return typeof value === "string" ? text(value) : "";
}
