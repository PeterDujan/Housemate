import type { ChatToolCallContext, ChatToolHandlers } from "./chat-tool-bridge.js";
import type { ChatCodeToolHandlers } from "./chat-code-tools.js";
import type { ChatHouseToolHandlers } from "./chat-house-tools.js";
import type { ChatSettingsToolHandlers } from "./chat-settings-tools.js";
import type { MemoryArchive } from "./memory-archive.js";
import type { ProjectDocs } from "./project-docs.js";
import { queryWords, subjectLabel, type MemoryRecallSource } from "./memory-recall-index.js";
import type { SelfGrowthStore } from "./self-growth.js";
import type { JarvisSelfModel } from "./self-model.js";
import { turnWhenLabel, type TurnSearchHit, type TurnSearchIndex } from "./turn-search-index.js";
import type { WikipediaKnowledgeStore } from "./wikipedia-knowledge-store.js";
import { ownerPossessive } from "./household.js";

/**
 * The read-only tools open chat may use. Each acts
 * for the speaker in the bridge's turn binding, never for anyone the model
 * names, and returns short plain text the model uses silently.
 */

export const CHAT_TOOL_SEARCH_LIMITS = Object.freeze({
  facts: 8,
  episodes: 5,
  turns: 6,
  /** Past turns a memory search adds, for things said but never kept as a fact. */
  memoryTurns: 3,
  /** Items of each kind his own past returns. */
  past: 5,
});

const ENCYCLOPEDIA_TIMEOUT_MS = 2_500;

export function createChatToolHandlers(sources: {
  readonly memoryRecall: MemoryRecallSource | null;
  readonly turnSearch: Pick<TurnSearchIndex, "search"> | null;
  /** The permanent tier counts what searches bring back. */
  readonly archive?: Pick<MemoryArchive, "noteRecalled"> | null;
  readonly wikipediaKnowledge: Pick<WikipediaKnowledgeStore, "lookupEarlyTitleTextAsync" | "lookupWithDiagnosticsAsync"> | null;
  /** House reads; null when Home Assistant is not wired (tests, probes). */
  readonly house?: ChatHouseToolHandlers | null;
  /** Code the assistant's own answer sources; null when not wired (tests, probes). */
  readonly code?: ChatCodeToolHandlers | null;
  /** His own history; null when not wired (tests, probes). */
  readonly past?: {
    readonly growth: Pick<SelfGrowthStore, "versions" | "retiredHabits"> | null;
    readonly opinions: Pick<JarvisSelfModel, "formerOpinions"> | null;
  } | null;
  /** The owner's projects folder; null when not wired (tests, probes). */
  readonly projects?: Pick<ProjectDocs, "list" | "search" | "read"> | null;
  /** The House page's settings; null when not wired (tests, probes). */
  readonly settings?: ChatSettingsToolHandlers | null;
}): ChatToolHandlers {
  const house = sources.house ?? null;
  const code = sources.code ?? null;
  const archive = sources.archive ?? null;
  // The turn index never returns a forgotten turn; kept words are not shown twice.
  const noHouse = (): string => "House readings are unavailable right now.";
  return {
    find_house_entities: (input, context) => house ? house.find_house_entities(input, context) : noHouse(),
    read_house_states: (input, context) => house ? house.read_house_states(input, context) : noHouse(),
    read_house_history: (input, context) => house ? house.read_house_history(input, context) : noHouse(),
    read_house_statistics: (input, context) => house ? house.read_house_statistics(input, context) : noHouse(),
    read_house_energy: (input, context) => house ? house.read_house_energy(input, context) : noHouse(),
    read_calendar: (input, context) => code ? code.read_calendar(input, context) : noHouse(),
    read_todo_lists: (input, context) => code ? code.read_todo_lists(input, context) : noHouse(),
    read_weather: (input, context) => code ? code.read_weather(input, context) : noHouse(),
    who_is_home: (input, context) => code ? code.who_is_home(input, context) : noHouse(),
    read_household_routines: (input, context) => code ? code.read_household_routines(input, context) : noHouse(),
    read_power_now: (input, context) => code ? code.read_power_now(input, context) : noHouse(),
    read_house_happenings: (input, context) => code ? code.read_house_happenings(input, context) : noHouse(),

    list_projects: () => sources.projects?.list() ?? `${capitalised(ownerPossessive())} projects are not available right now.`,
    search_projects: ({ query, project }) => sources.projects?.search(query, project) ?? `${capitalised(ownerPossessive())} projects are not available right now.`,
    read_project_file: ({ path }) => sources.projects?.read(path) ?? `${capitalised(ownerPossessive())} projects are not available right now.`,

    read_house_settings: (input, context) => sources.settings?.read_house_settings(input, context) ?? "The house's settings are unavailable here.",
    change_house_setting: (input, context) => sources.settings?.change_house_setting(input, context) ?? "The house's settings are unavailable here.",
    read_housemate: (input, context) => sources.settings?.read_housemate(input, context) ?? "The house's settings are unavailable here.",
    change_housemate: (input, context) => sources.settings?.change_housemate(input, context) ?? "The house's settings are unavailable here.",
    read_housemate_log: (input, context) => sources.settings?.read_housemate_log(input, context) ?? "The house's settings are unavailable here.",

    search_memory({ query }, context) {
      const result = sources.memoryRecall?.recall({
        actorId: context.actorId,
        transcript: query,
        previousTranscript: null,
        channel: context.channel,
        now: context.now,
        limits: { facts: CHAT_TOOL_SEARCH_LIMITS.facts, episodes: CHAT_TOOL_SEARCH_LIMITS.episodes },
      });
      const shown = new Set((result?.episodes ?? []).flatMap((item) => item.kind === "kept" ? item.turnIds ?? [] : []));
      const turns = (sources.turnSearch?.search({
        actorId: context.actorId,
        query,
        daysBack: null,
        now: context.now,
        limit: CHAT_TOOL_SEARCH_LIMITS.memoryTurns,
        household: true,
      }) ?? []).filter((hit) => !shown.has(hit.turnId));
      archive?.noteRecalled(context.actorId, [
        ...(result?.episodes ?? []).flatMap((item) => item.turnIds ?? []),
        ...turns.map((hit) => hit.turnId),
      ], context.now);
      const lines: string[] = [];
      if (result && result.facts.length > 0) {
        lines.push("Known:", ...result.facts.map((item) => `- ${item.text}`));
      }
      if (result && result.episodes.length > 0) {
        lines.push("Earlier conversations:", ...result.episodes.map((item) => `- ${item.text}`));
      }
      if (turns.length > 0) {
        lines.push("Things said before:", ...turns.map((hit) => turnLine(hit, context)));
      }
      return lines.length > 0 ? lines.join("\n") : "Nothing found.";
    },

    search_conversations({ query, daysBack }, context) {
      if (!sources.turnSearch) return "Nothing found.";
      const hits = sources.turnSearch.search({
        actorId: context.actorId,
        query,
        daysBack,
        now: context.now,
        limit: CHAT_TOOL_SEARCH_LIMITS.turns,
        household: true,
      });
      if (hits.length === 0) return "Nothing found.";
      archive?.noteRecalled(context.actorId, hits.map((hit) => hit.turnId), context.now);
      return hits.map((hit) => turnLine(hit, context)).join("\n");
    },

    search_my_past({ query }, context) {
      return searchMyPast(query, sources.past ?? null, context.now);
    },

    async lookup_encyclopedia({ topic }, context: ChatToolCallContext) {
      const store = sources.wikipediaKnowledge;
      if (!store) return "Nothing found.";
      const byTitle = await store.lookupEarlyTitleTextAsync(topic, ENCYCLOPEDIA_TIMEOUT_MS);
      if (context.signal.aborted) return "Nothing found.";
      const hit = byTitle.hit
        ?? (await store.lookupWithDiagnosticsAsync(`what is ${topic}`, ENCYCLOPEDIA_TIMEOUT_MS)).hit;
      if (!hit) return "Nothing found.";
      const description = hit.description ? ` (${hit.description})` : "";
      return `Offline encyclopedia, may be out of date. ${hit.title}${description}: ${hit.abstract.trim()}`;
    },
  };
}

/**
 * His own past, newest first: account lines he changed, phrases he
 * dropped, views he revised or let go. A query keeps the items that share a
 * word with it; empty, the most recent of each.
 */
function searchMyPast(
  query: string,
  past: NonNullable<Parameters<typeof createChatToolHandlers>[0]["past"]> | null,
  now: Date,
): string {
  const terms = queryWords(query);
  const matches = (text: string): boolean => {
    const lower = text.toLowerCase();
    return terms.length === 0 || terms.some((term) => lower.includes(term));
  };
  const when = (at: string): string => turnWhenLabel(at, now).replace(/ \d{1,2}:\d{2} [ap]m$/, "");
  const changes = (past?.growth?.versions(60) ?? [])
    .filter((version) => version.source !== "seed")
    .flatMap((version) => version.source === "rollback"
      ? [`- ${when(version.writtenAt)}: ${version.reason}`]
      : version.changes.map((change) => `- ${when(version.writtenAt)}: ${
        change.op === "add" ? `added "${change.after}"`
          : change.op === "remove" ? `dropped "${change.before}"`
            : `changed "${change.before}" to "${change.after}"`}`))
    .filter(matches)
    .slice(0, CHAT_TOOL_SEARCH_LIMITS.past);
  const habits = (past?.growth?.retiredHabits(30) ?? [])
    .map((habit) => `- "${habit.phrase}" (${habit.note}), dropped ${when(habit.retiredAt ?? habit.lastSeen)}`)
    .filter(matches)
    .slice(0, CHAT_TOOL_SEARCH_LIMITS.past);
  const views = (past?.opinions?.formerOpinions(100) ?? [])
    .map((view) => `- ${view.subject}: "${view.stance}" (last said ${when(view.lastSaid)}; ${view.why === "revised" ? "since changed" : "since let go"})`)
    .filter(matches)
    .slice(0, CHAT_TOOL_SEARCH_LIMITS.past);
  const lines = [
    ...(changes.length > 0 ? ["How you saw yourself:", ...changes] : []),
    ...(habits.length > 0 ? ["Phrases you used to use:", ...habits] : []),
    ...(views.length > 0 ? ["Views you used to hold:", ...views] : []),
  ];
  return lines.length > 0 ? lines.join("\n") : "Nothing found.";
}

function turnLine(hit: TurnSearchHit, context: Pick<ChatToolCallContext, "actorId" | "now">): string {
  const who = hit.actorId === context.actorId ? "they" : subjectLabel(hit.actorId) || "someone";
  return `- ${turnWhenLabel(hit.at, context.now)}: ${who} said "${hit.transcript}"${hit.response ? `; you said "${hit.response}"` : ""}`;
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
