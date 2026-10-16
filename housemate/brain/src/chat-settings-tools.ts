import { OPTION_GROUPS, supervisorAccess, type SupervisorAccess } from "./app-options.js";
import {
  HOUSE_SETTING_PARTS,
  type ChatSettingsToolName,
  type ChatToolCallContext,
  type ChatToolHandlers,
  type HouseSettingChange,
  type HouseSettingPart,
  type HousemateAction,
  type HousemateSection,
} from "./chat-tool-bridge.js";
import { houseDiscoveryBody, type HouseDiscoveryBody } from "./house-discovery-view.js";
import { checkedPage, readHouseChoices, type DiscoveredHouse, type HandMade, type HouseOption, type HouseOptions, type HousePage } from "./house-discovery.js";

/*
 * The Chat tab runs the whole app ("full control through chat... it
 * just should not be editing code"). The AI reads any section of the page, the House page's
 * settings and the app's own log, and proposes a change; code keeps it and makes it only when the
 * next Chat tab message is a plain yes, through the page's own action (same checks, same log
 * lines). The page's Chat tab only (Home Assistant's own login), never voice or guests. Keys and
 * tokens stay on the System page: chats are kept and remembered. Code is never changed here;
 * that comes with each release.
 */

interface PartSpec {
  readonly title: string;
  readonly kind: "one" | "many" | "device" | "names" | "budget" | "speaker";
  readonly key: keyof HousePage;
  readonly choices?: keyof HouseOptions;
  readonly handMade?: keyof HandMade;
}

const PARTS: Readonly<Record<HouseSettingPart, PartSpec>> = {
  house_power: { title: "Whole-house power", kind: "one", key: "power", choices: "power", handMade: "power" },
  house_energy: { title: "Whole-house energy", kind: "one", key: "houseEnergy", choices: "energy", handMade: "power" },
  solar_power: { title: "Solar power now", kind: "one", key: "solarPower", choices: "power", handMade: "power" },
  device_power: { title: "A device's power sensor", kind: "device", key: "devices", choices: "power", handMade: "power" },
  device_names: { title: "A device's other names", kind: "names", key: "devices", handMade: "power" },
  budget: { title: "Monthly electricity budget", kind: "budget", key: "budgetKwh", handMade: "budget" },
  doors_and_locks: { title: "Doors and locks it watches", kind: "many", key: "leftOpen", choices: "openings", handMade: "leftOpen" },
  vacuum: { title: "Robot vacuum", kind: "one", key: "vacuum", choices: "vacuums", handMade: "vacuum" },
  weather: { title: "Weather", kind: "one", key: "weather", choices: "weathers", handMade: "weather" },
  outside_temperature: { title: "Outside temperature", kind: "one", key: "outsideTemperature", choices: "temperatures", handMade: "weather" },
  outside_wind: { title: "Outside wind", kind: "one", key: "outsideWind", choices: "winds", handMade: "weather" },
  calendars: { title: "Calendars", kind: "many", key: "calendars", choices: "calendars", handMade: "calendars" },
  speaker_music: { title: "A speaker's music player", kind: "speaker", key: "speakers", choices: "musicPlayers" },
};

/** Each page section, by the page's own address for it. */
const SECTIONS: Readonly<Record<HousemateSection, string>> = {
  status: "/status",
  overview: "/dashboard",
  setup: "/setup",
  sign_in: "/signin",
  switches: "/settings",
  personality: "/settings/persona",
  people: "/settings/people",
  spoken_words: "/settings/voice-words",
  media_apps: "/settings/media-apps",
  app_settings: "/settings/app",
  names: "/settings/names",
  voice_training: "/voice-training",
  memory_review: "/memory/review/next",
};

/** Each page action, and the section that shows what it changes. */
const ACTIONS: Readonly<Record<HousemateAction, { readonly path: string; readonly shows?: HousemateSection }>> = {
  switch: { path: "/settings", shows: "switches" },
  quiet_and_speak_up: { path: "/settings/helper", shows: "switches" },
  personality: { path: "/settings/persona", shows: "personality" },
  people: { path: "/settings/people", shows: "people" },
  spoken_words: { path: "/settings/voice-words", shows: "spoken_words" },
  media_app: { path: "/settings/media-apps" },
  app_settings: { path: "/settings/app", shows: "app_settings" },
  name: { path: "/settings/names" },
  voice_training_start: { path: "/voice-training/start" },
  voice_training_cancel: { path: "/voice-training/cancel" },
  restart: { path: "/system/restart" },
  memory_review: { path: "/memory/review/decision" },
  forget_memory: { path: "/memory/remove" },
  held_memory: { path: "/memory/held/decide" },
  self_model: { path: "/self-model/action" },
  close_correction: { path: "/corrections/close" },
  idea_review: { path: "/proactive/review/decide" },
  idea_type: { path: "/proactive/types" },
  codex_sign_in: { path: "/signin" },
};

const SECRET_SETTINGS = new Set(OPTION_GROUPS.flatMap((group) => group.fields.filter((field) => field.kind === "secret").map((field) => field.key)));

/** Options listed per read; a search narrows a long list. */
const OPTIONS_SHOWN = 40;
/** A proposal waits this long for its yes. */
const PENDING_MS = 10 * 60_000;
/** A section longer than this is read a part at a time. */
const SECTION_CHARS = 5_800;
/** Terminal colour codes in the log. */
// eslint-disable-next-line no-control-regex
const ANSI_COLOUR = /\u001b\[[0-9;]*m/g;
/** Log lines looked through, newest last. */
const LOG_SCAN_LINES = 3_000;

export interface HouseSettingsAccess {
  readonly found: () => DiscoveredHouse | null;
  readonly rescan: () => Promise<DiscoveredHouse>;
  readonly options: () => HouseOptions;
  readonly save: (raw: unknown) => Promise<DiscoveredHouse>;
}

export interface PageReply {
  readonly status: number;
  readonly body: unknown;
}

/** The page's own actions, run in the server for the person in the Chat tab; attached when the server starts. */
export class PageActions {
  #run: ((method: "GET" | "POST", path: string, body: unknown, actorId: string) => Promise<PageReply>) | null = null;

  attach(run: (method: "GET" | "POST", path: string, body: unknown, actorId: string) => Promise<PageReply>): void {
    this.#run = run;
  }

  call(method: "GET" | "POST", path: string, body: unknown, actorId: string): Promise<PageReply> {
    if (!this.#run) return Promise.reject(new Error("the page isn't running"));
    return this.#run(method, path, body, actorId);
  }
}

interface Pending {
  readonly said: string;
  readonly apply: () => Promise<string>;
  readonly turnId: string;
  readonly at: number;
}

export type ChatSettingsToolHandlers = Pick<ChatToolHandlers, ChatSettingsToolName>;

export class HousemateChat {
  readonly #house: HouseSettingsAccess | null;
  readonly #page: PageActions;
  readonly #supervisor: SupervisorAccess;
  readonly #log: (line: string) => void;
  readonly #pending = new Map<string, Pending>();

  constructor(options: {
    readonly house: HouseSettingsAccess | null;
    readonly page: PageActions;
    readonly supervisor?: SupervisorAccess;
    readonly log?: (line: string) => void;
  }) {
    this.#house = options.house;
    this.#page = options.page;
    this.#supervisor = options.supervisor ?? supervisorAccess();
    this.#log = options.log ?? ((line) => console.log(`[brain] ${line}`));
  }

  handlers(): ChatSettingsToolHandlers {
    const notChanged = (error: unknown): string => `Not changed: ${error instanceof Error ? error.message : String(error)}.`;
    return {
      read_house_settings: (input) => this.readHouse(input),
      change_house_setting: (input, context) => {
        try {
          return this.proposeHouse(input, context);
        } catch (error) {
          return notChanged(error);
        }
      },
      read_housemate: (input, context) => this.readSection(input.section, input.pick, context.actorId),
      change_housemate: async (input, context) => {
        try {
          return await this.proposeAction(input, context);
        } catch (error) {
          return notChanged(error);
        }
      },
      read_housemate_log: (input) => this.readLog(input.search, input.lines),
    };
  }

  /** What is in use, or one part with what it can be set to. */
  async readHouse({ part, search, lookAgain }: { readonly part: HouseSettingPart | null; readonly search: string; readonly lookAgain: boolean }): Promise<string> {
    if (!this.#house) return "The House page isn't available here.";
    const found = lookAgain ? await this.#house.rescan() : this.#house.found();
    if (!found) return "The house hasn't been looked at yet; ask to look again.";
    const body = this.#houseBody(found);
    if (!part) {
      return [
        "In use now (\"by hand\": set by a file of the house's own; changing it moves it onto the House page):",
        ...HOUSE_SETTING_PARTS.flatMap((name) => partLines(name, body)),
        "Read one part to see what it can be set to.",
      ].join("\n");
    }
    const spec = PARTS[part];
    const lines = [`${spec.title}:`, ...partLines(part, body)];
    if (spec.kind === "device" || spec.kind === "names") {
      lines.push("Devices (by their Energy dashboard sensor):", ...body.devices.map((device) => `- ${device.label} [${device.id}]`));
    }
    if (spec.kind === "speaker") {
      lines.push("Speakers:", ...body.speakers.map((speaker) => `- ${speaker.label} [${speaker.id}]`));
    }
    if (spec.choices) {
      const words = search.toLowerCase().split(/\s+/).filter(Boolean);
      const all = body.options[spec.choices];
      const shown = all.filter((option) => words.every((word) => `${option.name} ${option.id}`.toLowerCase().includes(word)));
      lines.push(
        words.length ? `What it can be set to, matching "${search}" (${shown.length} of ${all.length}):` : `What it can be set to (${all.length}):`,
        ...shown.slice(0, OPTIONS_SHOWN).map(optionLine),
        ...(shown.length > OPTIONS_SHOWN ? [`...and ${shown.length - OPTIONS_SHOWN} more; search to narrow.`] : []),
        ...(spec.kind === "many" ? [] : ["Or none."]),
      );
    }
    return lines.join("\n");
  }

  /** Checks a House page change and keeps it for the speaker's yes; nothing changes yet. */
  proposeHouse(change: HouseSettingChange, context: Pick<ChatToolCallContext, "actorId" | "turnId" | "now">): string {
    const house = this.#house;
    if (!house) return "The House page isn't available here.";
    const found = house.found();
    if (!found) return "The house hasn't been looked at yet; ask to look again.";
    const body = this.#houseBody(found);
    const { values, said } = changedValues(change, body);
    // The House page's own checks, before anything is promised.
    checkedPage({ ...body.page, ...values }, body.options, body.page.devices, new Set(Object.keys(body.page.devices)), body.page.speakers, body.page);
    const spec = PARTS[change.part];
    const byHand = spec.handMade !== undefined && body.handMade[spec.handMade];
    const full = `${said}${byHand ? ". That part is set up by hand now; this moves it onto the House page (the file is kept as a backup)" : ""}`;
    return this.#keep(context, full, async () => {
      const now = house.found();
      if (!now) throw new Error("the house hasn't been looked at yet");
      const page = houseDiscoveryBody(now).page;
      await house.save({
        ...page,
        ...values,
        devices: { ...page.devices, ...values.devices },
        speakers: { ...page.speakers, ...values.speakers },
      });
      return `Done. ${full}.`;
    });
  }

  /** One page section as the page reads it, or one part of it. */
  async readSection(section: HousemateSection, pick: string, actorId: string): Promise<string> {
    const reply = await this.#page.call("GET", SECTIONS[section], undefined, actorId);
    if (reply.status >= 300) return `The page couldn't read ${section}: ${pageError(reply)}.`;
    let value = reply.body;
    for (const step of pick.split(".").filter(Boolean)) {
      value = Array.isArray(value) && /^\d+$/.test(step) ? value[Number(step)] : record(value)[step];
      if (value === undefined) return `${section} has no ${pick}.`;
    }
    const text = JSON.stringify(value);
    if (text.length <= SECTION_CHARS || !value || typeof value !== "object") return text;
    const parts = Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key} (${JSON.stringify(item)?.length ?? 0} characters)`);
    return `This is long; read it a part at a time with pick${pick ? ` ("${pick}.<part>")` : ""}. Its parts: ${parts.join(", ")}.`;
  }

  /** Checks a page action and keeps it for the speaker's yes; nothing changes yet. */
  async proposeAction(
    input: { readonly action: HousemateAction; readonly body: Record<string, unknown>; readonly summary: string },
    context: Pick<ChatToolCallContext, "actorId" | "turnId" | "now">,
  ): Promise<string> {
    const { action, body } = input;
    if (action === "app_settings" && Object.keys(body).some((key) => SECRET_SETTINGS.has(key))) {
      throw new Error("keys and tokens go on the System page, never in chat (chats are kept)");
    }
    if (action === "media_app" && typeof body.key === "string" && body.key.trim()) {
      throw new Error("keys go on the System page, never in chat (chats are kept); the address can be set here");
    }
    const shows = ACTIONS[action].shows;
    const before = shows ? await this.#page.call("GET", SECTIONS[shows], undefined, context.actorId) : null;
    const detail = changeDetail(action, body, before && before.status < 300 ? before.body : null);
    const said = detail ? `${input.summary.replace(/[.\s]+$/, "")} (${detail})` : input.summary.replace(/[.\s]+$/, "");
    return this.#keep(context, said, async () => {
      const reply = await this.#page.call("POST", ACTIONS[action].path, body, context.actorId);
      if (reply.status >= 300) throw new Error(pageError(reply));
      if (action === "restart") return "Restarting Housemate now; it's back in about a minute.";
      return `Done. ${said}.${record(reply.body).applied === "restart" ? " It takes effect after a restart of the app; say if you want it restarted now." : ""}`;
    });
  }

  /** The app's own recent log (the brain and the voice), newest last, keys hidden. */
  async readLog(search: string, count: number): Promise<string> {
    if (!this.#supervisor.token) return "The log can only be read when Housemate runs as a Home Assistant app.";
    const response = await this.#supervisor.fetch("http://supervisor/addons/self/logs", {
      headers: { authorization: `Bearer ${this.#supervisor.token}`, accept: "text/plain" },
    });
    if (!response.ok) return "Home Assistant didn't give the log.";
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    const lines = (await response.text()).split("\n").slice(-LOG_SCAN_LINES)
      .map((line) => hideSecrets(line.replace(ANSI_COLOUR, "")).trimEnd())
      .filter((line) => line && words.every((word) => line.toLowerCase().includes(word)));
    if (!lines.length) return words.length ? `No recent log lines hold "${search}".` : "The log is empty.";
    return lines.slice(-count).join("\n");
  }

  /**
   * A Chat tab message after a proposal: a plain yes makes the change, a plain no drops it (each
   * answered here, by code); anything else drops it and the turn goes on as usual (null).
   */
  async answer(actorId: string, transcript: string, turnId: string, now: Date): Promise<string | null> {
    const pending = this.#pending.get(actorId);
    if (!pending || pending.turnId === turnId) return null;
    this.#pending.delete(actorId);
    if (now.getTime() - pending.at > PENDING_MS) return null;
    if (isPlainNo(transcript)) return "Left it as it was.";
    if (!isPlainYes(transcript)) return null;
    let done: string;
    try {
      done = await pending.apply();
    } catch (error) {
      return `That didn't save: ${(error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/, "")}.`;
    }
    this.#log(`housemate settings: changed from the Chat tab (${pending.said})`);
    return done;
  }

  #keep(context: Pick<ChatToolCallContext, "actorId" | "turnId" | "now">, said: string, apply: () => Promise<string>): string {
    this.#pending.set(context.actorId, { said, apply, turnId: context.turnId, at: context.now.getTime() });
    return `Not changed yet. Tell them exactly what will change: ${said}. Then ask them to reply yes; it changes only when their next message is yes.`;
  }

  #houseBody(found: DiscoveredHouse): HouseDiscoveryBody {
    return houseDiscoveryBody(found, { choices: readHouseChoices(), options: this.#house?.options() ?? NO_OPTIONS });
  }
}

const NO_OPTIONS: HouseOptions = { power: [], energy: [], vacuums: [], openings: [], calendars: [], musicPlayers: [], weathers: [], temperatures: [], winds: [] };

/** What a page action changes, from what the page shows now (empty when that can't be said). */
function changeDetail(action: HousemateAction, body: Record<string, unknown>, shown: unknown): string {
  const page = record(shown);
  const diff = (now: Record<string, unknown>): string => {
    const changed = Object.entries(body).filter(([key, value]) => JSON.stringify(now[key]) !== JSON.stringify(value));
    if (!changed.length) throw new Error("that is already how it is");
    return changed.map(([key, value]) => `${key.replace(/_/g, " ")}: ${short(now[key])} -> ${short(value)}`).join("; ");
  };
  switch (action) {
    case "personality":
      return diff(record(page.fields));
    case "spoken_words":
      return diff(record(page.words));
    case "app_settings":
      return diff(Object.fromEntries(list(page.groups).flatMap((group) => list(record(group).fields)).map((field) => [record(field).key, record(field).value])));
    case "switch": {
      const row = list(page.rows).map(record).find((item) => item.key === body.key);
      if (!row) throw new Error(`${short(body.key)} isn't one of the switches`);
      return `${short(row.label)}: ${short(row.value)} -> ${body.reset === true ? `${short(row.defaultValue)} (the app's own setting)` : short(body.value)}`;
    }
    case "quiet_and_speak_up":
      return `${short(body.helper)}: ${short(record(page.helpers)[String(body.helper)])} -> ${short(body.value)}`;
    case "people": {
      const before = list(page.people).map(record);
      const after = list(body.people).map(record);
      const name = (person: Record<string, unknown>): string => short(person.name);
      const lines = [
        ...after.filter((person) => !before.some((was) => was.id && was.id === person.id)).map((person) => `add ${name(person)}`),
        ...before.filter((was) => !after.some((person) => person.id === was.id)).map((was) => `remove ${name(was)}`),
        ...after.flatMap((person) => {
          const was = before.find((item) => item.id && item.id === person.id);
          return was ? Object.keys(person).filter((key) => JSON.stringify(was[key]) !== JSON.stringify(person[key]))
            .map((key) => `${name(person)} ${key.replace(/_/g, " ")}: ${short(was[key])} -> ${short(person[key])}`) : [];
        }),
      ];
      if (!lines.length) throw new Error("that is already how it is");
      return lines.join("; ");
    }
    default:
      return Object.keys(body).length ? Object.entries(body).map(([key, value]) => `${key.replace(/_/g, " ")}: ${short(value)}`).join("; ") : "";
  }
}

function short(value: unknown): string {
  if (value === null || value === undefined || value === "") return "none";
  const text = typeof value === "string" ? `"${value}"` : Array.isArray(value) && value.every((item) => typeof item === "string") ? value.join(", ") || "none" : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function pageError(reply: PageReply): string {
  const error = record(reply.body).error;
  return typeof error === "string" && error ? error : `the page said ${reply.status}`;
}

/** Bearer tokens and long key-like strings, hidden from the AI. */
function hideSecrets(line: string): string {
  return line
    .replace(/\b(bearer|token|key|secret|password)(["':=\s]+)[^\s"',]+/gi, "$1$2[hidden]")
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, (match) => (match.match(/\d/g) ?? []).length >= 3 && /[A-Za-z]/.test(match) ? "[hidden]" : match);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The page values a change sets, and what it says in the house's own names. */
function changedValues(change: HouseSettingChange, body: HouseDiscoveryBody): { readonly values: Partial<HousePage>; readonly said: string } {
  const spec = PARTS[change.part];
  const page = body.page;
  const options = spec.choices ? body.options[spec.choices] : [];
  const pick = (): string | null => {
    const to = change.to?.trim() ?? "";
    if (!to) throw new Error("say what to set it to (an id from the list, or none)");
    if (/^none$/i.test(to)) return null;
    return to;
  };
  switch (spec.kind) {
    case "one": {
      const to = pick();
      const was = page[spec.key] as string | null;
      return { values: { [spec.key]: to }, said: `${spec.title}: ${named(to, options, body)} (was ${named(was, options, body)})` };
    }
    case "many": {
      const now = page[spec.key] as readonly string[];
      const add = change.add.filter((id) => !now.includes(id));
      const remove = change.remove.filter((id) => now.includes(id));
      if (!add.length && !remove.length) throw new Error("nothing to add or remove: each is already that way");
      const next = [...now.filter((id) => !remove.includes(id)), ...add];
      return {
        values: { [spec.key]: next },
        said: `${spec.title}: ${[add.length ? `add ${add.map((id) => named(id, options, body)).join(", ")}` : "", remove.length ? `remove ${remove.map((id) => named(id, options, body)).join(", ")}` : ""].filter(Boolean).join("; ")}`,
      };
    }
    case "device":
    case "names": {
      const device = which(change.item, body.devices, "device");
      const was = page.devices[device.id] ?? { power: null, names: [] };
      if (spec.kind === "device") {
        const to = pick();
        return { values: { devices: { [device.id]: { ...was, power: to } } }, said: `${device.label} power sensor: ${named(to, options, body)} (was ${named(was.power, options, body)})` };
      }
      const names = (change.names ?? []).map((name) => name.trim()).filter(Boolean);
      return { values: { devices: { [device.id]: { ...was, names } } }, said: `${device.label} also called: ${names.join(", ") || "nothing else"} (was ${was.names.join(", ") || "nothing else"})` };
    }
    case "speaker": {
      const speaker = which(change.item, body.speakers, "speaker");
      const to = pick();
      return { values: { speakers: { [speaker.id]: to } }, said: `${speaker.label} music player: ${named(to, options, body)} (was ${named(page.speakers[speaker.id] ?? null, options, body)})` };
    }
    case "budget": {
      const to = pick();
      const kwh = to === null ? null : Number(to.replace(/\s*kwh$/i, ""));
      if (kwh !== null && !(Number.isFinite(kwh) && kwh > 0)) throw new Error("the budget is a number of kWh a month, or none");
      const shown = (value: number | null): string => value === null ? "none" : `${Math.round(value)} kWh a month`;
      return { values: { budgetKwh: kwh === null ? null : Math.round(kwh) }, said: `${spec.title}: ${shown(kwh)} (was ${shown(page.budgetKwh)})` };
    }
  }
}

function which(item: string | null, list: readonly { readonly id: string; readonly label: string }[], kind: string): { readonly id: string; readonly label: string } {
  const wanted = item?.trim().toLowerCase() ?? "";
  const found = list.find((entry) => entry.id.toLowerCase() === wanted) ?? list.find((entry) => entry.label.toLowerCase() === wanted);
  if (!found) throw new Error(`say which ${kind}, by an id from the list`);
  return found;
}

function partLines(part: HouseSettingPart, body: HouseDiscoveryBody): string[] {
  const spec = PARTS[part];
  const byHand = spec.handMade !== undefined && body.handMade[spec.handMade] ? " (by hand)" : "";
  const options = spec.choices ? body.options[spec.choices] : [];
  const page = body.page;
  switch (spec.kind) {
    case "one":
      return [`${spec.title}: ${shownId(page[spec.key] as string | null, options, body)}${byHand}`];
    case "many": {
      const ids = page[spec.key] as readonly string[];
      return [`${spec.title}${byHand}: ${ids.length ? ids.map((id) => shownId(id, options, body)).join(", ") : "none"}`];
    }
    case "budget":
      return [`${spec.title}${byHand}: ${page.budgetKwh === null ? "none" : `${page.budgetKwh} kWh a month`}`];
    case "device":
      return body.devices.map((device) => `${device.label} [${device.id}] power${byHand}: ${shownId(page.devices[device.id]?.power ?? null, options, body)}`);
    case "names":
      return body.devices.map((device) => `${device.label} [${device.id}] also called: ${page.devices[device.id]?.names.join(", ") || "nothing else"}`);
    case "speaker":
      return body.speakers.length
        ? body.speakers.map((speaker) => `${speaker.label} [${speaker.id}] music: ${shownId(page.speakers[speaker.id] ?? null, options, body)}`)
        : ["Speakers: none found"];
  }
}

function named(id: string | null, options: readonly HouseOption[], body: HouseDiscoveryBody): string {
  if (id === null) return "none";
  return options.find((option) => option.id === id)?.name
    ?? Object.values(body.options).flat().find((option) => option.id === id)?.name
    ?? id;
}

function shownId(id: string | null, options: readonly HouseOption[], body: HouseDiscoveryBody): string {
  return id === null ? "none" : `${named(id, options, body)} [${id}]`;
}

function optionLine(option: HouseOption): string {
  return `- ${option.name} [${option.id}]${option.value ? ` ${option.value}` : ""}`;
}

/** What Housemate has settings for, as people name them. */
const SETTING_THINGS = String.raw`(?:sensors?|calendars?|budget|weather|forecast|doors?|locks?|vacuum|speakers?|(?:music )?players?|house power|house energy|whole[- ]house|solar|outside (?:temperature|temp|wind)|settings?|name|nicknames?|personality|character|pronoun|greeting|goodbye|stop phrase|wake word|hearing|speech|voice|model|brain|ai|plex|radarr|sonarr|overseerr|seerr|media apps?|people|person|household|alias(?:es)?|memor(?:y|ies)|training|quiet hours|speak[- ]up|switch(?:es)?|proactive|thinking|tone|corrections|housemate|app|logs?)`;
const SETTING_ASK = new RegExp(String.raw`^(?:(?:please|can you|could you|would you|hey|now)\s+)*(?:use|set|change|switch to|pick|choose|find|untick|tick|stop using|start using|don't use|do not use|add|remove|drop|watch|stop watching|ignore|include|exclude|rename|call|link|unlink|enable|disable|forget|delete|train|restart|reset|update|edit|fix)\b.*\b${SETTING_THINGS}\b`, "iu");
const SETTING_QUESTION = new RegExp(String.raw`^(?:what|which)\b.*\b${SETTING_THINGS}\b.*\b(?:are you|is it|do you|does it|is housemate|does housemate)\s+(?:using|use|watching|watch|set to)\b`, "iu");
/** "Why isn't the music working?": the AI looks at the status and the log. */
const TROUBLE = /^(?:why|how come)\b.*\b(?:not|isn't|doesn't|won't|didn't|can't|cannot|wasn't|fail(?:s|ed|ing)?|broken|wrong|errors?)\b|\b(?:troubleshoot|not working|stopped working|isn't working|doesn't work|broken)\b|\b(?:the|your|housemate's) logs?\b/iu;
/** Asks to work a device, or the house's lists and calendar events, never a setting. */
const NOT_A_SETTING = /\b(?:volume|brightness|percent|degrees|timer|alarm|reminder|shopping|to-?do|list|event|appointment|meeting)\b|%/iu;

/**
 * A Chat tab message about Housemate's own settings or trouble ("untick the Radarr calendar",
 * "change your greeting", "why isn't music working?"), which goes to the AI with its settings
 * tools rather than to the code answers that share its words (the calendar, the weather, music).
 */
export function looksLikeHouseSettingRequest(transcript: string): boolean {
  const said = transcript.trim();
  if (TROUBLE.test(said)) return true;
  return !NOT_A_SETTING.test(said) && (SETTING_ASK.test(said) || SETTING_QUESTION.test(said));
}

const YES_FIRST = new Set(["yes", "yeah", "yep", "yup", "yea", "sure", "ok", "okay", "do", "go", "please", "confirm", "confirmed", "correct"]);
const YES_WORDS = new Set([...YES_FIRST, "it", "ahead", "for", "thanks", "mate", "that's", "thats", "right", "change", "make", "the", "that", "one"]);
const NO_FIRST = new Set(["no", "nope", "nah", "cancel", "don't", "dont", "stop", "leave"]);

function words(transcript: string): string[] {
  return transcript.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);
}

export function isPlainYes(transcript: string): boolean {
  const said = words(transcript);
  return said.length > 0 && said.length <= 6 && YES_FIRST.has(said[0] as string) && said.every((word) => YES_WORDS.has(word));
}

export function isPlainNo(transcript: string): boolean {
  const said = words(transcript);
  return said.length > 0 && said.length <= 6 && NO_FIRST.has(said[0] as string);
}
