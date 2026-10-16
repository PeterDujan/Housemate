import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { ClaudeProcessAttachment } from "./claude-stream.js";
import { isRecord } from "./value-guards.js";
import { exampleHouseholdName, householdPeople, ownerPossessive, ownerPronounPossessive } from "./household.js";

/**
 * The assistant's internal MCP endpoint for open chat.
 *
 * Each pooled Claude process gets its own secret URL on a loopback-only port.
 * Before a turn's prompt is sent, the assistant binds that process to the turn; the
 * tools then act for the turn's verified speaker, channel and deadline. Nothing
 * a tool acts on comes from the model's arguments except the search text, so
 * the model cannot act as someone else; the household shares its memories
 * and a guest gets no tools. Every tool is read-only;
 * the house tools read through the read agent's policy-checked
 * session, so the same privacy rules hold and nothing can act on the house.
 */

export const CHAT_TOOL_LIMITS = Object.freeze({
  callsPerTurn: 4,
  /** The Chat tab sets up and troubleshoots the whole app: more reads before it answers. */
  settingsCallsPerTurn: 10,
  resultBytes: 1536,
  /** Code answer sources list a whole calendar or every routine. */
  codeResultBytes: 4096,
  /** Project notes are studied, not glanced at; the house's settings list every part. */
  projectResultBytes: 6144,
  toolTimeoutMs: 3_000,
  /** Looking the house over again reads Home Assistant's registries. */
  settingsToolTimeoutMs: 15_000,
  /** House reads go to Home Assistant's recorder, which is slower than local search. */
  houseToolTimeoutMs: 5_000,
  queryChars: 200,
  requestBytes: 64 * 1024,
});

export const CHAT_TOOL_SERVER_NAME = "housemate";

export type ChatHouseToolName =
  | "find_house_entities"
  | "read_house_states"
  | "read_house_history"
  | "read_house_statistics"
  | "read_house_energy";

/** Code the assistant's own answer sources. */
export type ChatCodeToolName =
  | "read_calendar"
  | "read_todo_lists"
  | "read_weather"
  | "who_is_home"
  | "read_household_routines"
  | "read_power_now"
  | "read_house_happenings";

/** The owner's projects folder, read-only. */
export type ChatProjectToolName = "list_projects" | "search_projects" | "read_project_file";

export const CHAT_PROJECT_TOOL_NAMES: readonly ChatProjectToolName[] = ["list_projects", "search_projects", "read_project_file"];

/** The whole app's settings and troubleshooting, from the page's Chat tab only. */
export type ChatSettingsToolName = "read_house_settings" | "change_house_setting" | "read_housemate" | "change_housemate" | "read_housemate_log";

export const CHAT_SETTINGS_TOOL_NAMES: readonly ChatSettingsToolName[] = ["read_house_settings", "change_house_setting", "read_housemate", "change_housemate", "read_housemate_log"];

/** The page's sections the Chat tab reads, as the page reads them. */
export const HOUSEMATE_SECTIONS = [
  "status", "overview", "setup", "sign_in", "switches", "personality", "people", "spoken_words", "media_apps",
  "app_settings", "names", "voice_training", "memory_review",
] as const;

export type HousemateSection = (typeof HOUSEMATE_SECTIONS)[number];

/** The page's actions the Chat tab may ask for, each made only on the next message's yes. */
export const HOUSEMATE_ACTIONS = [
  "switch", "quiet_and_speak_up", "personality", "people", "spoken_words", "media_app", "app_settings", "name",
  "voice_training_start", "voice_training_cancel", "restart", "memory_review", "forget_memory", "held_memory",
  "self_model", "close_correction", "idea_review", "idea_type", "codex_sign_in",
] as const;

export type HousemateAction = (typeof HOUSEMATE_ACTIONS)[number];

/** The House page's parts the Chat tab can read and change. */
export const HOUSE_SETTING_PARTS = [
  "house_power", "house_energy", "solar_power", "device_power", "device_names", "budget",
  "doors_and_locks", "vacuum", "weather", "outside_temperature", "outside_wind", "calendars", "speaker_music",
] as const;

export type HouseSettingPart = (typeof HOUSE_SETTING_PARTS)[number];

export interface HouseSettingChange {
  readonly part: HouseSettingPart;
  /** The device (its Energy dashboard sensor or name) or speaker (its HA device or name). */
  readonly item: string | null;
  /** An entity id, "none", or a number of kWh for the budget. */
  readonly to: string | null;
  readonly add: readonly string[];
  readonly remove: readonly string[];
  readonly names: readonly string[] | null;
}

export type ChatToolName = "search_memory" | "search_conversations" | "lookup_encyclopedia" | "search_my_past" | ChatHouseToolName | ChatCodeToolName | ChatProjectToolName | ChatSettingsToolName;

export const CHAT_HOUSE_TOOL_NAMES: readonly ChatHouseToolName[] = [
  "find_house_entities",
  "read_house_states",
  "read_house_history",
  "read_house_statistics",
  "read_house_energy",
];

export const CHAT_CODE_TOOL_NAMES: readonly ChatCodeToolName[] = [
  "read_calendar",
  "read_todo_lists",
  "read_weather",
  "who_is_home",
  "read_household_routines",
  "read_power_now",
  "read_house_happenings",
];

export const CHAT_TOOL_NAMES: readonly ChatToolName[] = [
  "search_memory",
  "search_conversations",
  "lookup_encyclopedia",
  "search_my_past",
  ...CHAT_HOUSE_TOOL_NAMES,
  ...CHAT_CODE_TOOL_NAMES,
  ...CHAT_PROJECT_TOOL_NAMES,
  ...CHAT_SETTINGS_TOOL_NAMES,
];

export const CHAT_HOUSE_LIMITS = Object.freeze({
  entityIds: 5,
  /** The read agent's raw-history budget is one entity-day. */
  historyHoursBack: 24,
  statisticsDaysBack: 30,
  calendarDaysAhead: 14,
  weatherDaysAhead: 6,
  /** Hourly statistics beyond two days would overflow a result. */
  hourlyStatisticsDaysBack: 2,
});

export type ChatStatisticsPeriod = "hour" | "day" | "week";

/** Claude Code's names for the tools, for `--allowedTools`. */
export const CHAT_ALLOWED_TOOLS: readonly string[] = CHAT_TOOL_NAMES.map(
  (name) => `mcp__${CHAT_TOOL_SERVER_NAME}__${name}`,
);

export interface ChatToolCallContext {
  readonly turnId: string;
  /** Verified household speaker, from the turn binding. */
  readonly actorId: string;
  /** Display name of that speaker, for the house tools' privacy checks. */
  readonly actorLabel: string;
  readonly channel: string;
  readonly now: Date;
  readonly signal: AbortSignal;
}

export interface ChatToolHandlers {
  search_memory(input: { readonly query: string }, context: ChatToolCallContext): Promise<string> | string;
  search_conversations(
    input: { readonly query: string; readonly daysBack: number | null },
    context: ChatToolCallContext,
  ): Promise<string> | string;
  lookup_encyclopedia(input: { readonly topic: string }, context: ChatToolCallContext): Promise<string> | string;
  search_my_past(input: { readonly query: string }, context: ChatToolCallContext): Promise<string> | string;
  find_house_entities(
    input: { readonly query: string; readonly domain: string | null },
    context: ChatToolCallContext,
  ): Promise<string> | string;
  read_house_states(input: { readonly entityIds: readonly string[] }, context: ChatToolCallContext): Promise<string> | string;
  read_house_history(
    input: { readonly entityIds: readonly string[]; readonly hoursBack: number },
    context: ChatToolCallContext,
  ): Promise<string> | string;
  read_house_statistics(
    input: { readonly entityIds: readonly string[]; readonly daysBack: number; readonly period: ChatStatisticsPeriod },
    context: ChatToolCallContext,
  ): Promise<string> | string;
  read_house_energy(input: { readonly daysBack: number }, context: ChatToolCallContext): Promise<string> | string;
  read_calendar(
    input: { readonly kind: "household" | "bins" | "releases"; readonly daysAhead: number },
    context: ChatToolCallContext,
  ): Promise<string> | string;
  read_todo_lists(input: Record<string, never>, context: ChatToolCallContext): Promise<string> | string;
  read_weather(input: { readonly daysAhead: number }, context: ChatToolCallContext): Promise<string> | string;
  who_is_home(input: Record<string, never>, context: ChatToolCallContext): Promise<string> | string;
  read_household_routines(input: Record<string, never>, context: ChatToolCallContext): Promise<string> | string;
  read_power_now(input: Record<string, never>, context: ChatToolCallContext): Promise<string> | string;
  read_house_happenings(
    input: { readonly window: "today" | "while_i_was_out" },
    context: ChatToolCallContext,
  ): Promise<string> | string;
  list_projects(input: Record<string, never>, context: ChatToolCallContext): Promise<string> | string;
  search_projects(input: { readonly query: string; readonly project: string | null }, context: ChatToolCallContext): Promise<string> | string;
  read_project_file(input: { readonly path: string }, context: ChatToolCallContext): Promise<string> | string;
  read_house_settings(
    input: { readonly part: HouseSettingPart | null; readonly search: string; readonly lookAgain: boolean },
    context: ChatToolCallContext,
  ): Promise<string> | string;
  change_house_setting(input: HouseSettingChange, context: ChatToolCallContext): Promise<string> | string;
  read_housemate(input: { readonly section: HousemateSection; readonly pick: string }, context: ChatToolCallContext): Promise<string> | string;
  change_housemate(
    input: { readonly action: HousemateAction; readonly body: Record<string, unknown>; readonly summary: string },
    context: ChatToolCallContext,
  ): Promise<string> | string;
  read_housemate_log(input: { readonly search: string; readonly lines: number }, context: ChatToolCallContext): Promise<string> | string;
}

export interface ChatToolCallRecord {
  readonly tool: string;
  readonly outcome: "ok" | "error" | "timeout" | "refused";
  readonly latencyMs: number;
  readonly resultBytes: number;
}

export interface ChatToolTurn {
  readonly turnId: string;
  readonly actorId: string;
  readonly actorLabel: string;
  readonly channel: string;
  /** The page's Chat tab through Home Assistant's login. */
  readonly settings?: boolean | undefined;
  readonly handlers: ChatToolHandlers;
  readonly now?: (() => Date) | undefined;
  readonly onCall?: ((record: ChatToolCallRecord) => void) | undefined;
}

interface BoundTurn {
  readonly turn: ChatToolTurn;
  readonly signal: AbortSignal;
  calls: number;
}

interface ProcessEntry {
  bound: BoundTurn | null;
}

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const QUERY_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: CHAT_TOOL_LIMITS.queryChars,
} as const;

const ENTITY_IDS_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: CHAT_HOUSE_LIMITS.entityIds,
  items: { type: "string", pattern: "^[a-z0-9_]+\\.[a-z0-9_]+$" },
  description: "Exact entity ids returned by find_house_entities earlier in this turn.",
} as const;

const NO_INPUT_SCHEMA = { type: "object", properties: {}, additionalProperties: false } as const;

/** The tools offered to the model, worded for this household. */
export function chatToolDefinitions() {
  const names = householdPeople().map((person) => person.name).join(", ");
  const projects = ownerPossessive();
  return [
  {
    name: "search_memory",
    description: `Search what you know about the speaker and the household from earlier conversations: things anyone in the house (${names}) told you, what past chats were about, and matching things they said; the household shares its memories. Use it when the answer depends on something they told you before that is not already in front of you.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { ...QUERY_SCHEMA, description: "Several plain words they might have used, any of which may match, e.g. \"injury injured hurt broke crushed accident hand arm leg\"." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "search_conversations",
    description: `Search the household's earlier conversations with you over the last 90 days: what the speaker or anyone else in the house (${names}) asked or said, and what you answered. Each line says who. Use it for questions like "what did I ask you earlier?" or "what was ${exampleHouseholdName()} telling you about?".`,
    inputSchema: {
      type: "object",
      properties: {
        query: { ...QUERY_SCHEMA, description: "Several words they might have used, any of which may match; leave empty for their most recent conversations." },
        days_back: { type: "integer", minimum: 1, maximum: 90, description: "How many days back to look (default 90)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lookup_encyclopedia",
    description: "Look up a named person, place, thing or work in an offline encyclopedia (a Wikipedia snapshot). Use it for stable facts you are unsure of. It has nothing current, such as news, listings or prices.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { ...QUERY_SCHEMA, description: "The topic's name, e.g. \"Blink-182\"." },
      },
      required: ["topic"],
      additionalProperties: false,
    },
  },
  {
    name: "search_my_past",
    description: "Look up how you yourself have changed: lines you added to or dropped from how you see yourself, phrases you used to use, and views you used to hold. Use it only when someone asks how you've changed or whether you used to think something, or you wonder about your own past.",
    inputSchema: {
      type: "object",
      properties: {
        query: { ...QUERY_SCHEMA, description: "A few words about the subject, e.g. \"jokes humour\"; leave empty for the most recent changes." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "find_house_entities",
    description: "Find things in this house's Home Assistant (sensors, lights, switches, people, climate and so on) by name or kind. Returns their names and entity ids. The other house tools need ids found here first, in this same turn.",
    inputSchema: {
      type: "object",
      properties: {
        query: { ...QUERY_SCHEMA, description: "What to find, e.g. \"grid energy\", \"lounge temperature\", \"solar\"." },
        domain: { type: "string", pattern: "^[a-z_]+$", description: "Optional Home Assistant domain to narrow it, e.g. \"sensor\", \"light\", \"person\"." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_house_states",
    description: "Read the current state of house entities found by find_house_entities.",
    inputSchema: {
      type: "object",
      properties: { entity_ids: ENTITY_IDS_SCHEMA },
      required: ["entity_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "read_house_history",
    description: "Read how house entities changed over the last few hours (state changes with times). A full day covers one entity; use read_house_statistics for longer spans.",
    inputSchema: {
      type: "object",
      properties: {
        entity_ids: ENTITY_IDS_SCHEMA,
        hours_back: { type: "integer", minimum: 1, maximum: CHAT_HOUSE_LIMITS.historyHoursBack, description: "How many hours back from now (default 24)." },
      },
      required: ["entity_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "read_house_statistics",
    description: "Read long-term statistics for house sensors: energy, gas and water used per period, or the mean, minimum and maximum of a measurement such as temperature or power.",
    inputSchema: {
      type: "object",
      properties: {
        entity_ids: ENTITY_IDS_SCHEMA,
        days_back: { type: "integer", minimum: 1, maximum: CHAT_HOUSE_LIMITS.statisticsDaysBack, description: "How many days back from now (default 7; hourly periods cover at most 2 days)." },
        period: { type: "string", enum: ["hour", "day", "week"], description: "Size of each period (default day)." },
      },
      required: ["entity_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "read_house_energy",
    description: "The house's whole energy picture in one read, from its energy dashboard: electricity from the grid, sent back to the grid, solar, battery, and the home's own use per day, plus gas and water. Use it for any question about how much energy, electricity, gas or water the house uses; no ids needed.",
    inputSchema: {
      type: "object",
      properties: {
        days_back: { type: "integer", minimum: 1, maximum: CHAT_HOUSE_LIMITS.statisticsDaysBack, description: "How many whole days back from now (default 7)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_calendar",
    description: "Read the household calendar (or the bin-collection or film-release calendar) for today and the coming days: every event with its day and time. Use it for plans, appointments, what's on, and bin nights.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["household", "bins", "releases"], description: "Which calendar (default household)." },
        days_ahead: { type: "integer", minimum: 1, maximum: CHAT_HOUSE_LIMITS.calendarDaysAhead, description: "How many days from today, today included (default 7)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_todo_lists",
    description: "Read the household's to-do, shopping and reminder lists: every open item, by list.",
    inputSchema: NO_INPUT_SCHEMA,
  },
  {
    name: "read_weather",
    description: "Read the weather outside the house now and the forecast for the coming days, from the house's weather station and forecast.",
    inputSchema: {
      type: "object",
      properties: {
        days_ahead: { type: "integer", minimum: 0, maximum: CHAT_HOUSE_LIMITS.weatherDaysAhead, description: "Forecast days after today (default 2)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "who_is_home",
    description: "Who in the household is home right now and who is out, from the house's presence tracking. Home or out only.",
    inputSchema: NO_INPUT_SCHEMA,
  },
  {
    name: "read_household_routines",
    description: "The household's usual routines, worked out from the house's own history: when people usually leave for and get home from work or school, which days, and how long they are usually out. Use it for questions about anyone's usual times, days or habits.",
    inputSchema: NO_INPUT_SCHEMA,
  },
  {
    name: "read_power_now",
    description: "Which devices are drawing the most power in the house right now, in watts.",
    inputSchema: NO_INPUT_SCHEMA,
  },
  {
    name: "read_house_happenings",
    description: "What happened at home, from the house's own records: doors and openings, who came and went, energy, alerts and calendar events, either today so far or while the speaker was out.",
    inputSchema: {
      type: "object",
      properties: {
        window: { type: "string", enum: ["today", "while_i_was_out"], description: "Today so far, or the speaker's latest time out (default today)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_projects",
    description: `List ${projects} projects (${ownerPronounPossessive()} projects folder): each project's name, title and what it is about. Start here when someone asks about one of ${projects} projects, the people in them, or what is being worked on.`,
    inputSchema: NO_INPUT_SCHEMA,
  },
  {
    name: "search_projects",
    description: `Search the notes in ${projects} projects for passages about something, best first, each with the note it came from. Use several plain words, e.g. "garden watering timer". Study what comes back before you answer.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { ...QUERY_SCHEMA, description: "Words to look for in the project notes." },
        project: { type: "string", maxLength: 80, description: "Optional project name from list_projects, to search only that one." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_project_file",
    description: `Read one note from ${projects} projects from its start, by the path search_projects showed in brackets (e.g. "Garden/README.md").`,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", minLength: 1, maxLength: 300 } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "read_house_settings",
    description: "Only in the Housemate page's Chat tab: read this house's Housemate settings, the House page's parts (what it uses from Home Assistant for whole-house power and energy, solar, each device's power sensor and other names, the electricity budget, doors and locks, the robot vacuum, weather, calendars, and each speaker's music player). Without a part: everything in use. With a part: what that part can be set to, with ids.",
    inputSchema: {
      type: "object",
      properties: {
        part: { type: "string", enum: HOUSE_SETTING_PARTS, description: "One part, to see what it can be set to." },
        search: { type: "string", maxLength: 80, description: "Words to narrow a part's list, e.g. \"shelly\"." },
        look_again: { type: "boolean", description: "Look the house's Home Assistant over again first, for something just added." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "change_house_setting",
    description: "Only in the Housemate page's Chat tab: propose a change to one House page part, with ids from read_house_settings. Nothing changes yet: tell them what it returns and ask for a yes; their next message being yes makes the change.",
    inputSchema: {
      type: "object",
      properties: {
        part: { type: "string", enum: HOUSE_SETTING_PARTS },
        item: { type: "string", maxLength: 200, description: "For device_power, device_names and speaker_music: the device or speaker id." },
        to: { type: "string", maxLength: 200, description: "The entity id to use, or \"none\"; for budget, kWh a month or \"none\"." },
        add: { type: "array", maxItems: 20, items: { type: "string", maxLength: 200 }, description: "For doors_and_locks and calendars: ids to add." },
        remove: { type: "array", maxItems: 20, items: { type: "string", maxLength: 200 }, description: "For doors_and_locks and calendars: ids to remove." },
        names: { type: "array", maxItems: 10, items: { type: "string", maxLength: 40 }, description: "For device_names: every other name it answers to (replaces the list)." },
      },
      required: ["part"],
      additionalProperties: false,
    },
  },
  {
    name: "read_housemate",
    description: "Only in the Housemate page's Chat tab: read one section of the Housemate page as JSON, exactly as the page shows it. status: version, readiness and AI budget; overview: the page's front summary; setup: what is left to set up; sign_in: the AI sign-in; switches: Housemate's on/off and choice settings plus quiet hours and speak-up; personality: the name and personality; people: who lives here and their Home Assistant links; spoken_words: greeting, goodbye and stop phrase; media_apps: Plex, Radarr, Sonarr and Overseerr; app_settings: AI, hearing, voice, place and approval phone; names: the house's own names for devices; voice_training: speakers and voice training status; memory_review: the next memory waiting for review. Keys are never shown, only whether one is set.",
    inputSchema: {
      type: "object",
      properties: {
        section: { type: "string", enum: HOUSEMATE_SECTIONS },
        pick: { type: "string", maxLength: 120, description: "Optional dotted path inside the JSON to read just that part, e.g. \"fields.character\" or \"rows\"." },
      },
      required: ["section"],
      additionalProperties: false,
    },
  },
  {
    name: "change_housemate",
    description: "Only in the Housemate page's Chat tab: propose one change the Housemate page can make, with the same JSON body the page sends. Read the section first and change only what was asked. switch {key, value} or {key, reset: true} (switches rows); quiet_and_speak_up {helper: proactive|silentFrom|silentUntil, value}; personality {any personality fields}; people {people: [every person, as read, with the change]}; spoken_words {greeting, goodbye, stop_phrase}; media_app {app, url} (empty url: back to Home Assistant's integration); app_settings {any app_settings keys}; name {action: save, alias, entityIds, notes?, previousAlias?} or {action: remove, alias}; voice_training_start {person_id, satellite}; voice_training_cancel {}; restart {} (restarts the app, about a minute); memory_review {reviewId, action, ...}; forget_memory {memoryId, action: delete|redact}; held_memory {id, verdict: keep|bin}; self_model {action, ...}; close_correction {id, reason: fixed|not_a_correction}; idea_review {id, verdict: accept|decline}; idea_type {type, on}; codex_sign_in {}. Keys and tokens are never set from chat: they go on the System page. Nothing changes yet: tell them the summary and ask for a yes; their next message being yes makes it.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: HOUSEMATE_ACTIONS },
        body: { type: "object", description: "The page's JSON body for this action." },
        summary: { type: "string", minLength: 1, maxLength: 200, description: "What will change, in plain words for them, e.g. \"Change the greeting to 'Yeah?'\"." },
      },
      required: ["action", "body", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "read_housemate_log",
    description: "Only in the Housemate page's Chat tab: read the app's own recent log (the brain and the voice), newest last, to troubleshoot. Search narrows it to lines holding all the words.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", maxLength: 80, description: "Words every line must hold, e.g. \"music error\"." },
        lines: { type: "integer", minimum: 1, maximum: 80, description: "How many lines (default 40)." },
      },
      additionalProperties: false,
    },
  },
  ] as const;
}

export class ChatToolBridge {
  private server: Server | null = null;
  private port: number | null = null;
  private starting: Promise<void> | null = null;
  private readonly processes = new Map<string, ProcessEntry>();

  /** Starts the loopback listener once; later calls return the same promise. */
  ready(): Promise<void> {
    if (this.port !== null) {
      return Promise.resolve();
    }
    this.starting ??= new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handle(request, response);
      });
      server.once("error", (error) => {
        this.starting = null;
        reject(error);
      });
      server.listen(0, "127.0.0.1", () => {
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
        server.unref();
        resolve();
      });
    });
    return this.starting;
  }

  isReady(): boolean {
    return this.port !== null;
  }

  /** Mints a secret URL for one Claude process. */
  register(): ClaudeProcessAttachment {
    if (this.port === null) {
      throw new Error("chat tool bridge is not listening");
    }
    const handle = randomBytes(24).toString("base64url");
    this.processes.set(handle, { bound: null });
    const config = {
      mcpServers: {
        [CHAT_TOOL_SERVER_NAME]: {
          type: "http",
          url: `http://127.0.0.1:${this.port}/mcp/${handle}`,
        },
      },
    };
    return {
      args: ["--mcp-config", JSON.stringify(config)],
      handle,
      release: () => {
        this.processes.delete(handle);
      },
    };
  }

  /** Binds a process to the turn it is about to answer. */
  bind(handle: string, turn: ChatToolTurn, signal: AbortSignal): () => void {
    const entry = this.processes.get(handle);
    if (!entry) {
      throw new Error("chat tool process is not registered");
    }
    const bound: BoundTurn = { turn, signal, calls: 0 };
    entry.bound = bound;
    return () => {
      if (entry.bound === bound) {
        entry.bound = null;
      }
    };
  }

  /** Test/diagnostic view of registered processes. */
  registeredCount(): number {
    return this.processes.size;
  }

  url(handle: string): string | null {
    return this.port === null || !this.processes.has(handle)
      ? null
      : `http://127.0.0.1:${this.port}/mcp/${handle}`;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.port = null;
    this.starting = null;
    this.processes.clear();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const match = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec(request.url ?? "");
    const entry = match?.[1] ? this.processes.get(match[1]) : undefined;
    if (!entry) {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "POST") {
      request.resume();
      // No server-initiated stream and no sessions to delete.
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    let body: string;
    try {
      body = await readBody(request, CHAT_TOOL_LIMITS.requestBytes);
    } catch {
      response.writeHead(413).end();
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      sendJson(response, rpcError(null, -32700, "Parse error"));
      return;
    }
    if (Array.isArray(message)) {
      const replies = (await Promise.all(message.map((item) => this.dispatch(entry, item))))
        .filter((reply): reply is Record<string, unknown> => reply !== null);
      if (replies.length === 0) {
        response.writeHead(202).end();
      } else {
        sendJson(response, replies);
      }
      return;
    }
    const reply = await this.dispatch(entry, message);
    if (reply === null) {
      response.writeHead(202).end();
    } else {
      sendJson(response, reply);
    }
  }

  private async dispatch(entry: ProcessEntry, message: unknown): Promise<Record<string, unknown> | null> {
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return isRecord(message) && "id" in message ? rpcError(rpcId(message.id), -32600, "Invalid request") : null;
    }
    if (!("id" in message)) {
      return null;
    }
    const id = rpcId(message.id);
    const params = isRecord(message.params) ? message.params : {};
    switch (message.method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return rpcResult(id, {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: CHAT_TOOL_SERVER_NAME, version: "1" },
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: chatToolDefinitions() });
      case "tools/call":
        return rpcResult(id, await this.callTool(entry, params));
      default:
        return rpcError(id, -32601, "Method not found");
    }
  }

  private async callTool(entry: ProcessEntry, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = typeof params.name === "string" ? params.name : "";
    const args = isRecord(params.arguments) ? params.arguments : {};
    const bound = entry.bound;
    if (!bound || bound.signal.aborted) {
      return toolResult("No conversation is active.", true);
    }
    const { turn } = bound;
    const startedAt = Date.now();
    const record = (outcome: ChatToolCallRecord["outcome"], resultBytes: number): void => {
      try {
        turn.onCall?.({ tool: name || "unknown", outcome, latencyMs: Date.now() - startedAt, resultBytes });
      } catch {
        // The ledger never fails a tool call.
      }
    };
    if (!(CHAT_TOOL_NAMES as readonly string[]).includes(name)) {
      record("refused", 0);
      return toolResult(`Unknown tool ${name || "(none)"}.`, true);
    }
    if ((CHAT_SETTINGS_TOOL_NAMES as readonly string[]).includes(name) && turn.settings !== true) {
      record("refused", 0);
      return toolResult("Settings are changed only from the Chat tab on the Housemate page.", true);
    }
    if (bound.calls >= (turn.settings === true ? CHAT_TOOL_LIMITS.settingsCallsPerTurn : CHAT_TOOL_LIMITS.callsPerTurn)) {
      record("refused", 0);
      return toolResult("No more lookups this turn. Answer with what you have.", true);
    }
    bound.calls += 1;
    const toolController = new AbortController();
    const timeoutMs = (CHAT_SETTINGS_TOOL_NAMES as readonly string[]).includes(name)
      ? CHAT_TOOL_LIMITS.settingsToolTimeoutMs
      : (CHAT_HOUSE_TOOL_NAMES as readonly string[]).includes(name) || (CHAT_CODE_TOOL_NAMES as readonly string[]).includes(name)
        ? CHAT_TOOL_LIMITS.houseToolTimeoutMs
        : CHAT_TOOL_LIMITS.toolTimeoutMs;
    const timer = setTimeout(() => toolController.abort(), timeoutMs);
    const signal = AbortSignal.any([bound.signal, toolController.signal]);
    const context: ChatToolCallContext = {
      turnId: turn.turnId,
      actorId: turn.actorId,
      actorLabel: turn.actorLabel,
      channel: turn.channel,
      now: turn.now?.() ?? new Date(),
      signal,
    };
    try {
      const text = await raceAbort(runHandler(turn.handlers, name as ChatToolName, args, context), signal);
      const capped = capUtf8(
        text.trim() || "Nothing found.",
        (CHAT_PROJECT_TOOL_NAMES as readonly string[]).includes(name) || (CHAT_SETTINGS_TOOL_NAMES as readonly string[]).includes(name)
          ? CHAT_TOOL_LIMITS.projectResultBytes
          : (CHAT_CODE_TOOL_NAMES as readonly string[]).includes(name) ? CHAT_TOOL_LIMITS.codeResultBytes : CHAT_TOOL_LIMITS.resultBytes,
      );
      record("ok", Buffer.byteLength(capped, "utf8"));
      return toolResult(capped, false);
    } catch (error) {
      const timedOut = signal.aborted;
      record(timedOut ? "timeout" : "error", 0);
      if (!timedOut) {
        console.warn(`[brain] chat tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return toolResult(timedOut ? "That lookup took too long." : "That lookup failed.", true);
    } finally {
      clearTimeout(timer);
    }
  }
}

function runHandler(
  handlers: ChatToolHandlers,
  name: ChatToolName,
  args: Record<string, unknown>,
  context: ChatToolCallContext,
): Promise<string> {
  return Promise.resolve().then(() => {
    switch (name) {
      case "search_memory":
        return handlers.search_memory({ query: requiredText(args.query, "query") }, context);
      case "search_conversations":
        return handlers.search_conversations({
          query: optionalText(args.query),
          daysBack: daysBack(args.days_back),
        }, context);
      case "lookup_encyclopedia":
        return handlers.lookup_encyclopedia({ topic: requiredText(args.topic, "topic") }, context);
      case "search_my_past":
        return handlers.search_my_past({ query: optionalText(args.query) }, context);
      case "find_house_entities":
        return handlers.find_house_entities({
          query: requiredText(args.query, "query"),
          domain: typeof args.domain === "string" && /^[a-z_]{1,40}$/.test(args.domain) ? args.domain : null,
        }, context);
      case "read_house_states":
        return handlers.read_house_states({ entityIds: entityIds(args.entity_ids) }, context);
      case "read_house_history":
        return handlers.read_house_history({
          entityIds: entityIds(args.entity_ids),
          hoursBack: clampInteger(args.hours_back, 1, CHAT_HOUSE_LIMITS.historyHoursBack, 24),
        }, context);
      case "read_house_statistics": {
        const period: ChatStatisticsPeriod = args.period === "hour" || args.period === "week" ? args.period : "day";
        return handlers.read_house_statistics({
          entityIds: entityIds(args.entity_ids),
          daysBack: clampInteger(
            args.days_back,
            1,
            period === "hour" ? CHAT_HOUSE_LIMITS.hourlyStatisticsDaysBack : CHAT_HOUSE_LIMITS.statisticsDaysBack,
            period === "hour" ? 1 : 7,
          ),
          period,
        }, context);
      }
      case "read_house_energy":
        return handlers.read_house_energy({
          daysBack: clampInteger(args.days_back, 1, CHAT_HOUSE_LIMITS.statisticsDaysBack, 7),
        }, context);
      case "read_calendar":
        return handlers.read_calendar({
          kind: args.kind === "bins" || args.kind === "releases" ? args.kind : "household",
          daysAhead: clampInteger(args.days_ahead, 1, CHAT_HOUSE_LIMITS.calendarDaysAhead, 7),
        }, context);
      case "read_todo_lists":
        return handlers.read_todo_lists({}, context);
      case "read_weather":
        return handlers.read_weather({
          daysAhead: clampInteger(args.days_ahead, 0, CHAT_HOUSE_LIMITS.weatherDaysAhead, 2),
        }, context);
      case "who_is_home":
        return handlers.who_is_home({}, context);
      case "read_household_routines":
        return handlers.read_household_routines({}, context);
      case "read_power_now":
        return handlers.read_power_now({}, context);
      case "read_house_happenings":
        return handlers.read_house_happenings({
          window: args.window === "while_i_was_out" ? "while_i_was_out" : "today",
        }, context);
      case "list_projects":
        return handlers.list_projects({}, context);
      case "search_projects":
        return handlers.search_projects({
          query: requiredText(args.query, "query"),
          project: typeof args.project === "string" && args.project.trim() ? args.project.trim().slice(0, 80) : null,
        }, context);
      case "read_project_file":
        return handlers.read_project_file({ path: requiredText(args.path, "path") }, context);
      case "read_house_settings":
        return handlers.read_house_settings({
          part: settingPart(args.part),
          search: optionalText(args.search).slice(0, 80),
          lookAgain: args.look_again === true,
        }, context);
      case "change_house_setting": {
        const part = settingPart(args.part);
        if (!part) throw new Error("part is required");
        return handlers.change_house_setting({
          part,
          item: optionalText(args.item) || null,
          to: optionalText(args.to) || null,
          add: idList(args.add, 20),
          remove: idList(args.remove, 20),
          names: Array.isArray(args.names) ? idList(args.names, 10) : null,
        }, context);
      }
      case "read_housemate": {
        const section = HOUSEMATE_SECTIONS.find((item) => item === args.section);
        if (!section) throw new Error("section is required");
        return handlers.read_housemate({ section, pick: optionalText(args.pick).slice(0, 120) }, context);
      }
      case "change_housemate": {
        const action = HOUSEMATE_ACTIONS.find((item) => item === args.action);
        if (!action) throw new Error("action is required");
        return handlers.change_housemate({ action, body: isRecord(args.body) ? args.body : {}, summary: requiredText(args.summary, "summary") }, context);
      }
      case "read_housemate_log":
        return handlers.read_housemate_log({ search: optionalText(args.search).slice(0, 80), lines: clampInteger(args.lines, 1, 80, 40) }, context);
    }
  });
}

function requiredText(value: unknown, label: string): string {
  const text = optionalText(value);
  if (!text) {
    throw new Error(`${label} is required`);
  }
  return text;
}

function optionalText(value: unknown): string {
  return typeof value === "string"
    ? value.replaceAll(/\s+/g, " ").trim().slice(0, CHAT_TOOL_LIMITS.queryChars)
    : "";
}

function settingPart(value: unknown): HouseSettingPart | null {
  return typeof value === "string" && (HOUSE_SETTING_PARTS as readonly string[]).includes(value) ? value as HouseSettingPart : null;
}

function idList(value: unknown, max: number): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, max)
    : [];
}

function entityIds(value: unknown): readonly string[] {
  const ids = Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && /^[a-z0-9_]+\.[a-z0-9_]+$/.test(item)))]
    : [];
  if (ids.length === 0) {
    throw new Error("entity_ids is required");
  }
  return ids.slice(0, CHAT_HOUSE_LIMITS.entityIds);
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function daysBack(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? Math.min(90, value)
    : null;
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function capUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  const ellipsis = "…";
  const cut = Buffer.from(text, "utf8")
    .subarray(0, maxBytes - Buffer.byteLength(ellipsis, "utf8"))
    .toString("utf8")
    .replace(/�$/u, "");
  return `${cut.trimEnd()}${ellipsis}`;
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        request.destroy();
        reject(new Error("request too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
}

function toolResult(text: string, isError: boolean): Record<string, unknown> {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

let sharedBridge: ChatToolBridge | null = null;

export function chatToolBridge(): ChatToolBridge {
  sharedBridge ??= new ChatToolBridge();
  return sharedBridge;
}

export function stopChatToolBridge(): void {
  sharedBridge?.stop();
  sharedBridge = null;
}
