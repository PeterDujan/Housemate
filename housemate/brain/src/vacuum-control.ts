import { readFileSync, statSync } from "node:fs";

import type { BasicResult } from "./basic-brain-contracts.js";
import type { BasicTurnPrincipal } from "./basic-turn-analysis.js";
import { errorText, liveState, settle, theLabel, verifiedSpeaker, type DeviceSwitch } from "./device-control.js";
import type { HaCommandClient } from "./ha-history.js";
import type { HaEntityState, HaStateCache } from "./ha-state-cache.js";
import { capitalize, joinNatural } from "./text-format.js";
import { recordOrNull } from "./value-guards.js";
import type { VacuumRequest, VacuumRoom, VacuumSettings } from "./vacuum-request.js";
import { VacuumName, houseConfig, vacuumName } from "./house-config.js";

/**
 * The vacuum by voice through the vacuum's own
 * logic. The assistant maps the words to one `lif_vacuum_queue` service and its
 * arguments; the queue does the rest, exactly as for the dashboards, so a
 * change there reaches the assistant with nothing to copy (hooks, never a
 * copy). The gate is every device's: the kill switch, a real household client,
 * The vacuum on the voice list, a household voice. Stop always checks first;
 * inside the assistant's silent hours every start does, and the whole house does
 * over existing work. Replies come from HA's re-read queue and vacuum state.
 * Agents never run it: tests use stubs.
 */

/** The house's vacuum (house.json, else the one discovery found); without one the vacuum owner says it can't. */
export function vacuumEntityId(): string {
  return houseConfig().vacuum.entity ?? "";
}
/** The house's vacuum queue (`lif_vacuum_queue`), when it has one; without it the vacuum is run directly. */
function vacuumQueueEntityId(): string {
  return houseConfig().vacuum.queueSensor ?? "";
}
/** The dashboard's rooms: the house's names for them and their Dreame segment ids. */
function dashboardRoomsPath(): string {
  return houseConfig().vacuum.roomsFile ?? "";
}
/** The rooms the vacuum may clean: the queue's own list, the one Clean All uses. */
function queueRoomsPath(): string {
  return houseConfig().vacuum.queueRoomsFile ?? "";
}

type QueueService = "clean_room" | "clean_house" | "stop" | "pause_cleaning" | "resume_cleaning" | "clear_warning";
/** The services that answer with what they did. */
const WITH_RESPONSE: ReadonlySet<QueueService> = new Set(["clean_room", "clean_house", "pause_cleaning", "resume_cleaning"]);
const HA_CALL_TIMEOUT_MS = 10_000;
const SETTLE_MS = 5_000;
/** Who started the job, as the queue records it. */
const SOURCE = "housemate";

/** The vacuum's HA side: the dashboard's rooms and one queue service. */
export interface VacuumQueue {
  /** The dashboard's rooms, marked allowed when the queue's list has them; read fresh whenever either file changes. */
  rooms(): readonly VacuumRoom[];
  /** One `lif_vacuum_queue` service; its response, when it gives one. */
  call(service: QueueService, data?: Readonly<Record<string, unknown>>): Promise<Record<string, unknown> | null>;
  /** Overrides the settle time (tests shorten it). */
  readonly settleMs?: number;
}

export class HaVacuumQueue implements VacuumQueue {
  readonly #client: HaCommandClient;
  #rooms: { readonly stamp: string; readonly rooms: readonly VacuumRoom[] } | null = null;

  constructor(client: HaCommandClient) {
    this.#client = client;
  }

  rooms(): readonly VacuumRoom[] {
    try {
      const stamp = `${statSync(dashboardRoomsPath()).mtimeMs}:${statSync(queueRoomsPath()).mtimeMs}`;
      if (this.#rooms?.stamp !== stamp) {
        const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
        this.#rooms = { stamp, rooms: vacuumRooms(read(dashboardRoomsPath()), read(queueRoomsPath())) };
      }
      return this.#rooms.rooms;
    } catch {
      return [];
    }
  }

  async call(service: QueueService, data?: Readonly<Record<string, unknown>>): Promise<Record<string, unknown> | null> {
    if (!vacuumQueueEntityId()) return this.#direct(service);
    const result = await this.#client.sendCommand({
      type: "call_service",
      domain: "lif_vacuum_queue",
      service,
      ...(data ? { service_data: { ...data } } : {}),
      ...(WITH_RESPONSE.has(service) ? { return_response: true } : {}),
    }, { signal: AbortSignal.timeout(HA_CALL_TIMEOUT_MS) });
    return recordOrNull(recordOrNull(result)?.response);
  }

  /** A house without the queue: the vacuum's own services, answering the way the queue would. */
  async #direct(service: QueueService): Promise<Record<string, unknown> | null> {
    const step = DIRECT[service];
    if (!step) throw new Error(`${service} needs a vacuum queue`);
    await this.#client.sendCommand({
      type: "call_service",
      domain: "vacuum",
      service: step.service,
      target: { entity_id: vacuumEntityId() },
    }, { signal: AbortSignal.timeout(HA_CALL_TIMEOUT_MS) });
    return step.response;
  }
}

/** The queue's services a plain vacuum has: the whole house, home, pause and go again. */
const DIRECT: Partial<Record<QueueService, { readonly service: string; readonly response: Record<string, unknown> | null }>> = {
  clean_house: { service: "start", response: null },
  stop: { service: "return_to_base", response: null },
  pause_cleaning: { service: "pause", response: { paused: "vacuum" } },
  resume_cleaning: { service: "start", response: { resumed: "vacuum" } },
};

/**
 * The dashboard config's `rooms` (`{ id, name }`, id the Dreame segment), each
 * allowed only when the queue's config (`rooms: { <name>: { dreame_id } }`)
 * lists that segment.
 */
export function vacuumRooms(dashboard: unknown, queueConfig: unknown): VacuumRoom[] {
  const rooms = recordOrNull(dashboard)?.rooms;
  if (!Array.isArray(rooms)) return [];
  const allowed = new Set(Object.values(recordOrNull(recordOrNull(queueConfig)?.rooms) ?? {}).map((room) => String(recordOrNull(room)?.dreame_id)));
  return rooms.flatMap((room) => {
    const { id, name } = recordOrNull(room) ?? {};
    return typeof id === "number" && Number.isInteger(id) && id > 0 && typeof name === "string" && name.trim()
      ? [{ id, name: name.trim(), allowed: allowed.has(String(id)) }]
      : [];
  });
}

export interface VacuumInput {
  readonly control: DeviceSwitch;
  readonly queue: VacuumQueue;
  readonly stateCache: HaStateCache | undefined;
  readonly principal: BasicTurnPrincipal;
  readonly request: VacuumRequest;
  /** A yes to the assistant's check, so no check again. */
  readonly confirmed: boolean;
  /** Inside the assistant's silent hours (`input_datetime.<name>_silent_from/until`). */
  readonly quietHours: boolean;
  /** A real household client with device control on; anything else never acts. */
  readonly live: boolean;
}

export async function vacuumAnswer(input: VacuumInput): Promise<BasicResult> {
  const { request, control, queue } = input;
  const rooms = queue.rooms();
  if (request.kind === "status") return result("entity_status", "ok", statusText(input.stateCache, rooms), "vacuum status");
  const speaker = verifiedSpeaker(input.principal);
  const refuse = (text: string, why: string) => result("entity_action", "declined", text, `vacuum refused: ${why}; request=${request.kind}`);
  if (!control.enabled()) return refuse(`Device control is switched off, so I didn't touch ${vacuumName()}.`, "device control off");
  if (!input.live) return refuse(`I can't run ${vacuumName()} from here, so I didn't touch it.`, "not a real household client");
  if (!control.exposed(vacuumEntityId())) return refuse(`${VacuumName()} isn't on my voice list, so I didn't touch it.`, "not exposed");
  if (!speaker) return refuse(`Sorry, only the household can run ${vacuumName()}. I didn't touch it.`, `speaker not verified (trust=${input.principal.trust})`);
  const vacuum = liveState(input.stateCache, vacuumEntityId());
  if (!vacuum || vacuum.state === "unavailable" || vacuum.state === "unknown") {
    return refuse(`${VacuumName()} isn't responding right now, so I didn't touch it.`, "vacuum unavailable");
  }
  const run = new Run(input, speaker, rooms);
  switch (request.kind) {
    case "start": return rooms.length === 0 ? run.house({}) : refuse("Which room? Say clean the kitchen, or clean the whole house.", "no room named");
    case "unknown_room": return rooms.length === 0
      ? refuse(`I can only send ${vacuumName()} round the whole house. I didn't touch it.`, `no rooms known, asked for "${request.spoken}"`)
      : refuse(`${VacuumName()}'s map has no room called ${request.spoken}. I didn't touch it.`, `unknown room "${request.spoken}"`);
    case "stop": return run.stop();
    case "pause": return run.pause();
    case "resume": return run.resume();
    case "clear_warning": return run.clearWarning();
    case "rooms": return run.rooms(request.rooms, request.settings);
    case "house": return run.house(request.settings);
  }
}

class Run {
  readonly #input: VacuumInput;
  readonly #speaker: string;
  readonly #rooms: readonly VacuumRoom[];

  constructor(input: VacuumInput, speaker: string, rooms: readonly VacuumRoom[]) {
    this.#input = input;
    this.#speaker = speaker;
    this.#rooms = rooms;
  }

  async stop(): Promise<BasicResult> {
    const before = this.#view();
    if (!before.hasWork && before.vacuum?.state === "docked") return this.#reply("ok", `${VacuumName()}'s already home.`, "already home");
    if (!this.#input.confirmed) return this.#check(`Do you really want me to stop and send ${vacuumName()} home?`, "stop");
    return this.#call("stop", undefined, (view) => !view.hasWork && ["returning", "docked"].includes(view.vacuum?.state ?? ""), (view) => (
      view.vacuum?.state === "docked" ? `Stopped. ${VacuumName()}'s docked.` : view.vacuum?.state === "returning" ? `Stopped. ${VacuumName()}'s heading home.` : `I've told ${vacuumName()} to stop and go home. It doesn't show heading home yet.`
    ));
  }

  async pause(): Promise<BasicResult> {
    if (!vacuumQueueEntityId() && !["cleaning", "returning"].includes(this.#view().vacuum?.state ?? "")) {
      return this.#reply("ok", `${VacuumName()}'s got nothing to pause.`, "nothing to pause");
    }
    return this.#call("pause_cleaning", undefined, (view, response) => (
      response?.paused === "queue" ? view.paused : response?.paused === "vacuum" ? view.vacuum?.state === "paused" : true
    ), (view, response) => {
      const paused = response?.paused;
      if (paused === "queue") return view.paused ? `Paused. ${VacuumName()} won't start the next room.` : `I've asked ${vacuumName()}'s queue to pause. It doesn't show paused yet.`;
      if (paused === "vacuum") return view.vacuum?.state === "paused" ? `${VacuumName()}'s paused.` : `I've asked ${vacuumName()} to pause. It doesn't show paused yet.`;
      return `${VacuumName()}'s got nothing to pause.`;
    });
  }

  async resume(): Promise<BasicResult> {
    const before = this.#view();
    if (!before.paused && before.vacuum?.state !== "paused") return this.#reply("ok", "Nothing's paused.", "nothing paused");
    if (this.#input.quietHours && !this.#input.confirmed) return this.#check(`It's quiet hours. Do you still want ${vacuumName()} to go again?`, "resume in quiet hours");
    return this.#call("resume_cleaning", undefined, (view, response) => (
      response?.resumed === "queue" ? !view.paused : response?.resumed === "vacuum" ? view.vacuum?.state === "cleaning" : true
    ), (view, response) => {
      const resumed = response?.resumed;
      if (resumed === "queue") return view.paused ? `I've asked ${vacuumName()}'s queue to go again. It still shows paused.` : `${VacuumName()}'s queue is going again.`;
      if (resumed === "vacuum") return view.vacuum?.state === "cleaning" ? `${VacuumName()}'s going again.` : `I've asked ${vacuumName()} to go again. It doesn't show cleaning yet.`;
      return "Nothing's paused.";
    });
  }

  async clearWarning(): Promise<BasicResult> {
    if (this.#view().state !== "blocked") return this.#reply("ok", `${VacuumName()} hasn't got a warning to clear.`, "not blocked");
    return this.#call("clear_warning", undefined, (view) => view.state !== "blocked", (view) => (
      view.state === "blocked" ? `I've cleared ${vacuumName()}'s warning, but its queue is still held.` : `I've cleared ${vacuumName()}'s warning.`
    ));
  }

  async rooms(rooms: readonly VacuumRoom[], settings: VacuumSettings): Promise<BasicResult> {
    const barred = rooms.filter((room) => !room.allowed);
    if (barred.length > 0) {
      return this.#reply("declined", `${VacuumName()} isn't allowed in ${joinNatural(barred.map((room) => theLabel(room.name)))}. I didn't touch it.`, `barred ${barred.map((room) => room.id).join(",")}`);
    }
    const before = this.#view();
    const fresh = rooms.filter((room) => !before.items.some((item) => item.roomId === room.id));
    if (fresh.length === 0) return this.#reply("ok", rooms.map((room) => placeSentence(before, room, this.#rooms, true)).join(" "), "already queued");
    if (this.#input.quietHours && !this.#input.confirmed) {
      return this.#check(`It's quiet hours. Do you still want ${vacuumName()} to ${verb(settings)} ${joinNatural(rooms.map((room) => theLabel(room.name)))}?`, "room in quiet hours");
    }
    const known = new Set(before.items.map((item) => item.id));
    const responses: (Record<string, unknown> | null)[] = [];
    try {
      for (const room of fresh) {
        responses.push(await this.#input.queue.call("clean_room", { dreame_id: room.id, ...settings, source: SOURCE }));
      }
    } catch (error) {
      const text = responses.length > 0
        ? `Home Assistant only took ${joinNatural(fresh.slice(0, responses.length).map((room) => theLabel(room.name)))}.`
        : `Home Assistant didn't take that, so ${vacuumName()} has nothing new to do.`;
      return this.#reply("declined", text, `clean_room ha_failed after ${responses.length} error=${errorText(error)}`, responses.length > 0);
    }
    const added = (view: QueueView) => fresh.every((room) => view.items.some((item) => item.roomId === room.id && !known.has(item.id)));
    await settle(() => { const view = this.#view(); return added(view) && !(view.running === null && view.queue.length > 0); }, this.#settleMs());
    const after = this.#view();
    const sentences = rooms.map((room) => placeSentence(after, room, this.#rooms, !fresh.includes(room)));
    const note = settingsSentence(settings, responses[0] ?? null, fresh);
    return this.#reply(added(after) ? "ok" : "declined", [...sentences, ...(note ? [note] : [])].join(" "), `clean_room ${fresh.map((room) => room.id).join(",")} settings=${JSON.stringify(settings)} responses=${JSON.stringify(responses)}`, true);
  }

  async house(settings: VacuumSettings): Promise<BasicResult> {
    // Clean All runs every room on its own settings: "vacuum the house" is fine, a named setting is not.
    if (Object.keys(settings).some((key) => key !== "mode") || (settings.mode ?? 0) !== 0) {
      return this.#reply("declined", "The whole house runs on each room's own settings, so I can't change them for all of it. Say clean the whole house.", "house with settings");
    }
    const before = this.#view();
    // Without a queue, cleaning at all is the whole house.
    const onHouse = (view: QueueView): boolean => view.running?.jobType === "clean_all" || (!vacuumQueueEntityId() && view.vacuum?.state === "cleaning");
    if (onHouse(before)) return this.#reply("ok", `${VacuumName()}'s already on the whole house.`, "already cleaning the house");
    const busy = before.hasWork || vacuumBusy(before.vacuum);
    if (!this.#input.confirmed && (busy || this.#input.quietHours)) {
      return this.#check(busy
        ? `${this.#input.quietHours ? `It's quiet hours, and ${vacuumName()}` : VacuumName()}'s already got work on. Do you want me to replace that with the whole house?`
        : `It's quiet hours. Do you still want ${vacuumName()} to clean the whole house?`, busy ? "house over a queue" : "house in quiet hours");
    }
    return this.#call("clean_house", { source: SOURCE }, onHouse, (view) => (
      onHouse(view) ? `${VacuumName()}'s started on the whole house.` : `I've asked ${vacuumName()} to clean the whole house. It doesn't show started yet.`
    ));
  }

  /** Calls one service, waits for, and replies from what HA shows then. */
  async #call(
    service: QueueService,
    data: Readonly<Record<string, unknown>> | undefined,
    done: (view: QueueView, response: Record<string, unknown> | null) => boolean,
    reply: (view: QueueView, response: Record<string, unknown> | null) => string,
  ): Promise<BasicResult> {
    let response: Record<string, unknown> | null;
    try {
      response = await this.#input.queue.call(service, data);
    } catch (error) {
      return this.#reply("declined", `Home Assistant didn't take that, so ${vacuumName()} carries on as it was.`, `${service} ha_failed error=${errorText(error)}`);
    }
    await settle(() => done(this.#view(), response), this.#settleMs());
    const after = this.#view();
    return this.#reply(done(after, response) ? "ok" : "declined", reply(after, response), `${service} response=${JSON.stringify(response)} after=${after.state}/${after.vacuum?.state ?? "unknown"}`, true);
  }

  #check(question: string, why: string): BasicResult {
    return this.#reply("ok", question, `check: ${why}`);
  }

  #reply(status: "ok" | "declined", text: string, notes: string, touched = false): BasicResult {
    return result("entity_action", status, text, `vacuum: speaker=${this.#speaker} ${notes}`, touched ? [vacuumEntityId()] : []);
  }

  #view(): QueueView {
    return queueView(this.#input.stateCache);
  }

  #settleMs(): number {
    return this.#input.queue.settleMs ?? SETTLE_MS;
  }
}

// --- What HA shows ----------------------------------------------------------------

interface QueueItem {
  readonly id: string;
  readonly roomId: number;
  readonly roomName: string;
  readonly jobType: string | null;
  readonly status: string;
}

interface QueueView {
  readonly state: string;
  readonly running: QueueItem | null;
  readonly queue: readonly QueueItem[];
  /** The running job, then the waiting ones. */
  readonly items: readonly QueueItem[];
  readonly paused: boolean;
  readonly hasWork: boolean;
  readonly vacuum: HaEntityState | null;
}

function queueView(stateCache: HaStateCache | undefined): QueueView {
  const sensor = liveState(stateCache, vacuumQueueEntityId());
  const running = queueItem(sensor?.attributes.running);
  const queue = Array.isArray(sensor?.attributes.queue) ? sensor.attributes.queue.flatMap((item) => queueItem(item) ?? []) : [];
  const state = sensor?.state ?? "unknown";
  return {
    state,
    running,
    queue,
    items: [...(running ? [running] : []), ...queue],
    paused: sensor?.attributes.paused === true,
    hasWork: state !== "idle" && state !== "unknown" && state !== "unavailable",
    vacuum: liveState(stateCache, vacuumEntityId()),
  };
}

function queueItem(value: unknown): QueueItem | null {
  const item = recordOrNull(value);
  if (!item || typeof item.id !== "string") return null;
  return {
    id: item.id,
    roomId: typeof item.dreame_id === "number" ? item.dreame_id : Number(item.dreame_id),
    roomName: typeof item.room_name === "string" ? item.room_name : "",
    jobType: typeof item.job_type === "string" ? item.job_type : null,
    status: typeof item.status === "string" ? item.status : "",
  };
}

/** Out on a job, by the robot's own state. */
function vacuumBusy(vacuum: HaEntityState | null): boolean {
  return ["cleaning", "returning", "paused"].includes(vacuum?.state ?? "");
}

function itemName(item: QueueItem, rooms: readonly VacuumRoom[]): string {
  if (item.jobType === "clean_all") return "the whole house";
  return theLabel(rooms.find((room) => room.id === item.roomId)?.name ?? item.roomName);
}

/** Where a room sits now: started, its place in the queue, or not showing. */
function placeSentence(view: QueueView, room: VacuumRoom, rooms: readonly VacuumRoom[], already: boolean): string {
  const name = theLabel(room.name);
  const index = view.items.findIndex((item) => item.roomId === room.id);
  if (index === -1) return `I asked ${vacuumName()} to clean ${name}, but it doesn't show in the queue yet.`;
  if (index === 0 && view.running) {
    return already ? `${VacuumName()}'s already on ${name}.` : view.running.status === "preparing" ? `${VacuumName()}'s getting ready for ${name}.` : `${VacuumName()}'s started on ${name}.`;
  }
  const place = `${ordinal(index + 1)} in the queue`;
  if (already) return `${capitalize(name)}'s already ${place}.`;
  return index === 0 ? `${VacuumName()}'s about to start on ${name}.` : `Added ${name}; it's ${place}${view.running ? `, after ${itemName(view.running, rooms)}` : ""}.`;
}

const MODE_WORDS = ["vacuum only", "mop only", "vacuum and mop"];
const SUCTION_WORDS = ["quiet", "standard", "strong", "turbo"];
const WATER_WORDS = ["", "slightly dry", "moist", "wet"];
const PASS_WORDS = ["", "once", "twice", "three times"];

function verb(settings: VacuumSettings): string {
  return settings.mode === 0 ? "vacuum" : settings.mode === 1 ? "mop" : "clean";
}

/**
 * The settings the words named, as the queue resolved them: "Mop only, twice."
 * A carpet room asked to mop says why it won't.
 */
function settingsSentence(asked: VacuumSettings, response: Record<string, unknown> | null, rooms: readonly VacuumRoom[]): string | null {
  if (!response || Object.keys(asked).length === 0) return null;
  const value = (key: keyof VacuumSettings) => (typeof response[key] === "number" ? response[key] as number : null);
  const mode = value("mode");
  if (asked.mode !== undefined && asked.mode !== 0 && mode === 0) {
    return `${capitalize(theLabel(rooms[0]?.name ?? "that room"))} is carpet, so vacuum only.`;
  }
  const words = [
    asked.mode !== undefined && mode !== null ? MODE_WORDS[mode] : null,
    asked.suction !== undefined && value("suction") !== null ? `on ${SUCTION_WORDS[value("suction") as number]}` : null,
    asked.water !== undefined && value("water") !== null ? WATER_WORDS[value("water") as number] : null,
    asked.passes !== undefined && value("passes") !== null ? PASS_WORDS[value("passes") as number] : null,
  ].filter((word): word is string => Boolean(word));
  return words.length > 0 ? `${capitalize(words.join(", "))}.` : null;
}

function statusText(stateCache: HaStateCache | undefined, rooms: readonly VacuumRoom[]): string {
  const view = queueView(stateCache);
  const vacuum = view.vacuum;
  if (!vacuum || vacuum.state === "unavailable" || vacuum.state === "unknown") return `I can't see ${vacuumName()} right now.`;
  const docked = String(vacuum.attributes.status ?? "").toLowerCase() === "charging" ? `${VacuumName()}'s docked and charging` : `${VacuumName()}'s docked`;
  const doing = view.state === "blocked"
    ? `${VacuumName()}'s queue is held and needs a look`
    : view.running
      ? view.paused || vacuum.state === "paused"
        ? `${VacuumName()}'s paused on ${itemName(view.running, rooms)}`
        : view.running.status === "preparing" ? `${VacuumName()}'s getting ready for ${itemName(view.running, rooms)}` : `${VacuumName()}'s cleaning ${itemName(view.running, rooms)}`
      : view.paused ? `${VacuumName()}'s queue is paused`
        : vacuum.state === "cleaning" ? `${VacuumName()}'s cleaning`
          : vacuum.state === "returning" ? `${VacuumName()}'s heading home`
            : vacuum.state === "paused" ? `${VacuumName()}'s paused`
              : vacuum.state === "docked" ? docked
                : `${VacuumName()}'s ${vacuum.state}`;
  const waiting = view.queue.map((item) => itemName(item, rooms));
  const next = waiting.length > 0
    ? `. Then ${joinNatural(waiting)}.`
    : view.running ? ". Nothing else is queued." : ", with nothing queued.";
  const error = typeof vacuum.attributes.error === "string" && !/^no error$/i.test(vacuum.attributes.error) ? ` It says: ${vacuum.attributes.error}.` : "";
  return `${doing}${next}${error}`;
}

function ordinal(position: number): string {
  return ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"][position - 1] ?? `number ${position}`;
}

function result(route: "entity_status" | "entity_action", status: "ok" | "declined", text: string, notes: string, touched: readonly string[] = []): BasicResult {
  return { route, status, confidence: "high", text, modelUsed: false, resultId: null, touchedEntities: [...touched], notes };
}
