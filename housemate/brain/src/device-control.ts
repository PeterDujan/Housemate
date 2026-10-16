import { canonicalHouseholdActorId } from "./actor-identity.js";
import type { AliasEntry } from "./alias-schema.js";
import type { BasicResult, ResolvedTarget } from "./basic-brain-contracts.js";
import type { BasicTurnPrincipal } from "./basic-turn-analysis.js";
import { climateTargetIsGeneric, type ClimateMode, type ClimateRequest } from "./climate-request.js";
import type { EntityActionIntent } from "./entity-action-intent.js";
import type { HaCommandClient } from "./ha-history.js";
import { domainFromEntityId, friendlyName, isGarageDoorLock, type HaEntityState, type HaStateCache } from "./ha-state-cache.js";
import { DEVICE_ACTION_PATTERN } from "./lexicon.js";
import { semanticTargetKey } from "./target-index.js";
import { capitalize, lowerCommonWords } from "./text-format.js";
import { isAdmittedIntakeSource } from "./turn-source-trust.js";
import type { VoiceBrainRequest } from "./voice-brain.js";
import type { VoiceExposure } from "./voice-exposure.js";
import { VacuumName } from "./house-config.js";

/**
 * The assistant works what the owner exposes to Assist (his
 * voice list, `voice-exposure.ts`), for a real household client only. Code
 * owns every step; the model never acts. One gate, in order: the kill switch,
 * a real client (evals, probes and replays never act), an exact target on the
 * voice list, the speaker (the household any device, everyone else lights
 * only), an operation the device supports, then "already there?" (nothing is
 * called and he says so), the call, and a reply only from HA's re-read state.
 */

/** On/off devices. Locks and the HVAC have their own steps below. */
const ON_OFF_DOMAINS: ReadonlySet<string> = new Set(["light", "switch", "input_boolean", "fan"]);
/** Anyone in the house, household or not, may switch the lights. */
const GUEST_DOMAINS: ReadonlySet<string> = new Set(["light"]);
/** The vacuum has its own owner (`vacuum-control.ts`): it runs through its queue, never a raw call here. */
const OWN_OWNER_DOMAINS: ReadonlySet<string> = new Set(["vacuum"]);

const HA_CALL_TIMEOUT_MS = 5_000;
/** How long each kind of device gets to show its new state before the reply. */
const SETTLE_MS: Readonly<Record<string, number>> = { lock: 6_000, climate: 5_000 };
const DEFAULT_SETTLE_MS = 3_000;
const STATE_POLL_MS = 100;

/** The HA side: the kill switch, the voice list and one service call. */
export interface DeviceSwitch {
  /** `device_control_enabled`, read per turn; off means the locked decline. */
  enabled(): boolean;
  exposed(entityId: string): boolean;
  call(domain: string, service: string, entityIds: readonly string[], data?: Readonly<Record<string, unknown>>): Promise<void>;
  /** Overrides every device's settle time (tests shorten it). */
  readonly settleMs?: number;
}

export class HaDeviceSwitch implements DeviceSwitch {
  readonly #client: HaCommandClient;
  readonly #exposure: VoiceExposure;
  readonly #isEnabled: () => boolean;

  constructor(client: HaCommandClient, exposure: VoiceExposure, isEnabled: () => boolean) {
    this.#client = client;
    this.#exposure = exposure;
    this.#isEnabled = isEnabled;
  }

  enabled(): boolean {
    return this.#isEnabled();
  }

  exposed(entityId: string): boolean {
    return this.#exposure.isExposed(entityId);
  }

  async call(domain: string, service: string, entityIds: readonly string[], data?: Readonly<Record<string, unknown>>): Promise<void> {
    await this.#client.sendCommand({
      type: "call_service",
      domain,
      service,
      ...(data ? { service_data: { ...data } } : {}),
      target: { entity_id: [...entityIds] },
    }, { signal: AbortSignal.timeout(HA_CALL_TIMEOUT_MS) });
  }
}

/** Whether a live service exists and its switch is on (for honest self-reports). */
export function deviceControlLive(control: DeviceSwitch | undefined): boolean {
  return control?.enabled() === true;
}

/** Whether this turn may act at all: the switch is on and it came from a real household client. */
export function deviceControlLiveFor(
  control: DeviceSwitch | undefined,
  request: Pick<VoiceBrainRequest, "channel" | "sourceVia">,
): control is DeviceSwitch {
  return deviceControlLive(control) && isAdmittedIntakeSource({ channel: request.channel, sourceVia: request.sourceVia });
}

/** Every domain the assistant works: on/off, locks and the HVAC here, the vacuum through its queue. */
const WORKABLE_DOMAINS: ReadonlySet<string> = new Set([...ON_OFF_DOMAINS, "lock", "climate", ...OWN_OWNER_DOMAINS]);
/** The order he lists them in: lights first, then the doors, the HVAC, the rest. */
const LIST_ORDER = ["light", "lock", "climate"];

/** What the voice list holds for this speaker. Reads only. */
export interface VoiceListSummary {
  /** The speaker may use any device, not just the lights. */
  readonly household: boolean;
  /** Lights this speaker may switch. */
  readonly lights: number;
  /** Everything else this speaker may work, by name ("the front door lock"). */
  readonly others: readonly string[];
  /** On the list with no steps here yet ("I can't work X like that yet"). */
  readonly unsupported: readonly string[];
}

/**
 * The live voice list as the gate would treat this speaker: the same domains,
 * the same blocks and the same household test. Null while control is off.
 * Each device is named by its fullest alias ("Garage Door" over "Garage"),
 * else HA's name.
 */
export function voiceListSummary(
  control: DeviceSwitch | undefined,
  stateCache: HaStateCache | undefined,
  aliases: readonly AliasEntry[],
  principal: BasicTurnPrincipal,
): VoiceListSummary | null {
  if (!control || !deviceControlLive(control)) return null;
  const household = verifiedSpeaker(principal) !== null;
  const listed = (stateCache?.entries() ?? [])
    .filter((state) => control.exposed(state.entityId))
    .map((state) => ({ domain: domainFromEntityId(state.entityId), name: theLabel(spokenLabel(listName(state, aliases))) }))
    .filter(({ domain }) => household || GUEST_DOMAINS.has(domain))
    .sort((a, b) => rank(a.domain) - rank(b.domain) || a.name.localeCompare(b.name));
  const names = (keep: (domain: string) => boolean) => listed.filter(({ domain }) => keep(domain)).map(({ name }) => name);
  return {
    household,
    lights: listed.filter(({ domain }) => domain === "light").length,
    others: names((domain) => domain !== "light" && WORKABLE_DOMAINS.has(domain)),
    unsupported: names((domain) => !WORKABLE_DOMAINS.has(domain)),
  };
}

function listName(state: HaEntityState, aliases: readonly AliasEntry[]): string {
  const own = aliases
    .filter((entry) => entry.target.kind === "entity" && entry.target.entityId === state.entityId)
    .map((entry) => entry.alias);
  return own.reduce<string | null>((best, alias) => (best === null || alias.length > best.length ? alias : best), null) ?? friendlyName(state);
}

function rank(domain: string): number {
  const index = LIST_ORDER.indexOf(domain);
  return index === -1 ? LIST_ORDER.length : index;
}

/** What the turn asks: a parsed device action, or an HVAC request. */
export type DeviceRequest =
  | { readonly kind: "action"; readonly plan: EntityActionIntent }
  | { readonly kind: "climate"; readonly climate: ClimateRequest };

export interface DeviceActionInput {
  readonly control: DeviceSwitch;
  readonly stateCache: HaStateCache | undefined;
  readonly request: DeviceRequest;
  readonly target: ResolvedTarget;
  readonly principal: BasicTurnPrincipal;
}

interface GateContext {
  readonly control: DeviceSwitch | undefined;
  readonly request: Pick<VoiceBrainRequest, "channel" | "sourceVia">;
  readonly stateCache: HaStateCache | undefined;
  readonly aliases: readonly AliasEntry[];
  readonly principal: BasicTurnPrincipal;
}

/**
 * The gate's input when this turn may act on an exact target; null leaves the
 * turn to the locked decline (switch off, a test client, no exact target, a
 * deferred or conditional ask). Reads only: nothing is switched here.
 */
export function deviceActionInput(input: GateContext & {
  readonly plan: EntityActionIntent | null;
  /** The locked owner's execution target: exact provenance, or the same-session adjacent frame. */
  readonly target: ResolvedTarget | null;
}): DeviceActionInput | null {
  const { control, plan } = input;
  if (!deviceControlLiveFor(control, input.request) || !plan || plan.executionTiming) return null;
  const target = aliasTarget(plan.targetText, input.aliases, input.stateCache) ?? input.target;
  if (!target) return null;
  return { control, stateCache: input.stateCache, request: { kind: "action", plan }, target, principal: input.principal };
}

/**
 * An HVAC request's input: the target is the HVAC by name or alias, or, for
 * "the heating" / "the temperature", the one HVAC on the voice list. Null when
 * the words don't land on exactly one climate device, so other owners keep the
 * turn ("turn on the kitchen lights" parses as a shape here, but isn't one).
 */
export function climateActionInput(input: GateContext & {
  readonly climate: ClimateRequest;
  readonly resolve: (text: string) => ResolvedTarget | null;
  /** The same-session adjacent subject, for "turn it up". */
  readonly adjacent: ResolvedTarget | null;
  /** The mode the previous turn named ("is the aircon on?" then "turn it on"). */
  readonly adjacentMode: ClimateMode | null;
}): DeviceActionInput | null {
  const { control } = input;
  if (!deviceControlLiveFor(control, input.request)) return null;
  const pronoun = PRONOUN.test(input.climate.targetText);
  // "Turn it on" after "is the aircon on?" means the aircon. "Turn it off" means whatever is
  // running ("No, the aircon's on though." -> "Turn it off."), so off carries no mode.
  const climate = pronoun
    ? { ...input.climate, targetMode: input.climate.power === "off" ? null : input.adjacentMode }
    : input.climate;
  const named = pronoun
    ? input.adjacent
    : climateTargetIsGeneric(climate)
      ? onlyExposedClimate(control, input.stateCache, input.aliases)
      : aliasTarget(climate.targetText, input.aliases, input.stateCache) ?? input.resolve(climate.targetText);
  if (!named || named.entityIds.length !== 1 || domainFromEntityId(named.entityIds[0] as string) !== "climate") return null;
  return { control, stateCache: input.stateCache, request: { kind: "climate", climate }, target: named, principal: input.principal };
}

/** The one HVAC on the voice list, named by its alias ("HVAC") or else HA's name; null for none or several. */
function onlyExposedClimate(control: DeviceSwitch, stateCache: HaStateCache | undefined, aliases: readonly AliasEntry[]): ResolvedTarget | null {
  const climates = (stateCache?.entries() ?? []).filter((state) => domainFromEntityId(state.entityId) === "climate" && control.exposed(state.entityId));
  const only = climates.length === 1 ? climates[0] : null;
  if (!only) return null;
  const alias = aliases.find((entry) => entry.target.kind === "entity" && entry.target.entityId === only.entityId);
  // Named by its alias when it has one, so "turn it off" can follow (the pronoun carry needs a name).
  return alias
    ? { label: alias.alias, entityIds: [only.entityId], source: "alias" }
    : { label: friendlyName(only), entityIds: [only.entityId], source: "inferred" };
}

export const PRONOUN = /^(?:it|that|this|them|those)$/;

const DEVICE_IN_PLACE = new RegExp(String.raw`^(${DEVICE_ACTION_PATTERN})\s+(?:in|inside)\s+(?:the\s+)?(.+)$`);

/**
 * The owner's names first, by exact alias with plurals folded ("office light" is
 * the "office lights" alias, not the secondary light a word match prefers),
 * including the "<lights> in <place>" order. Never a fuzzy match; null when
 * no alias, or two different targets, carry that name.
 */
function aliasTarget(spoken: string, aliases: readonly AliasEntry[], stateCache: HaStateCache | undefined): ResolvedTarget | null {
  // "the garage" is the "Garage" alias; "my" stays, it picks the speaker's own names.
  const targetText = spoken.replace(/^the\s+/, "");
  const place = DEVICE_IN_PLACE.exec(targetText);
  const keys = new Set([targetText, place?.[1] && place[2] ? `${place[2]} ${place[1]}` : ""].filter(Boolean).map(semanticTargetKey));
  const targets = new Map<string, ResolvedTarget>();
  for (const entry of aliases) {
    if (!keys.has(semanticTargetKey(entry.normalizedAlias))) continue;
    const entityIds = entry.target.kind === "entity" ? [entry.target.entityId] : entry.target.kind === "group" ? [...entry.target.entityIds] : [];
    if (entityIds.length === 0 || entityIds.some((entityId) => !stateCache?.get(entityId))) continue;
    targets.set([...entityIds].sort().join(","), { label: entry.alias, entityIds, source: "alias" });
  }
  return targets.size === 1 ? [...targets.values()][0] ?? null : null;
}

/** Runs the gate for an exact target; every refusal says why and touches nothing. */
export async function deviceActionAnswer(input: DeviceActionInput): Promise<BasicResult> {
  const { control, request, target } = input;
  const label = spokenLabel(target.label);
  const entityIds = [...new Set(target.entityIds)];
  const domains = new Set(entityIds.map(domainFromEntityId));
  const speaker = verifiedSpeaker(input.principal);
  const refuse = (text: string, why: string) => answer(target, "declined", text, `device action refused: ${why}; entities=${entityIds.join(",")}`);

  if (request.kind === "action" && request.plan.targetScope === "whole_house_lights") {
    return refuse("I can only switch named lights for now, not the whole house at once. I didn't touch anything.", "whole house");
  }
  if ([...domains].some((domain) => OWN_OWNER_DOMAINS.has(domain))) {
    return refuse(`${VacuumName()} takes rooms: say clean the kitchen, or clean the whole house. I didn't touch it.`, "vacuum runs through its own owner");
  }
  const unlisted = entityIds.filter((entityId) => !control.exposed(entityId));
  if (unlisted.length > 0) {
    return refuse(`${label} ${isPlural(label, entityIds) ? "aren't" : "isn't"} on my voice list, so I didn't touch ${pronoun(label, entityIds)}.`, `not exposed: ${unlisted.join(",")}`);
  }
  if (!speaker && [...domains].some((domain) => !GUEST_DOMAINS.has(domain))) {
    return refuse("Sorry, only the household can do that. I didn't touch anything.", `speaker not verified (trust=${input.principal.trust})`);
  }
  const who = speaker ?? `guest:${input.principal.trust}`;
  const settleMs = (domain: string) => control.settleMs ?? SETTLE_MS[domain] ?? DEFAULT_SETTLE_MS;
  const single = entityIds.length === 1 ? entityIds[0] as string : null;
  if (request.kind === "climate") {
    if (!single) return refuse(`I can only work one HVAC at a time. I didn't touch anything.`, "climate group");
    return runClimate(control, input.stateCache, target, single, climateSteps(request.climate), who, settleMs("climate"));
  }
  const operation = request.plan.operation;
  if ([...domains].every((domain) => ON_OFF_DOMAINS.has(domain)) && isSwitchOperation(operation)) {
    return runSwitch(control, input.stateCache, target, entityIds, operation, who, settleMs("light"));
  }
  if (single && domains.has("lock") && isLockOperation(operation)) {
    return runLock(control, input.stateCache, target, single, operation, who, settleMs("lock"));
  }
  if (single && domains.has("climate") && (operation === "turn_on" || operation === "turn_off")) {
    return runClimate(control, input.stateCache, target, single, { power: operation === "turn_on" ? "on" : "off", mode: null, temperature: null, nudge: null, modeTarget: null }, who, settleMs("climate"));
  }
  return refuse(`I can't work ${theLabel(label)} like that yet. I didn't touch anything.`, `operation ${operation} not supported`);
}

// --- On/off -------------------------------------------------------------------

type Position = "on" | "off";
type SwitchOperation = "turn_on" | "turn_off" | "toggle";

function isSwitchOperation(operation: EntityActionIntent["operation"]): operation is SwitchOperation {
  return operation === "turn_on" || operation === "turn_off" || operation === "toggle";
}

async function runSwitch(
  control: DeviceSwitch,
  stateCache: HaStateCache | undefined,
  target: ResolvedTarget,
  entityIds: readonly string[],
  operation: SwitchOperation,
  speaker: string,
  settleMs: number,
): Promise<BasicResult> {
  const label = spokenLabel(target.label);
  const plural = isPlural(label, entityIds);
  const before = positions(stateCache, entityIds);
  const log = (outcome: string, after: readonly (Position | null)[] = before) => (
    `device action: speaker=${speaker} operation=${operation} entities=${entityIds.join(",")} before=${before.map(shown).join(",")} after=${after.map(shown).join(",")} outcome=${outcome}`
  );
  if (before.some((position) => position === null)) {
    return answer(target, "declined", `${label} ${plural ? "aren't" : "isn't"} responding right now, so I didn't touch ${pronoun(label, entityIds)}.`, log("unavailable"));
  }
  const wanted: Position = operation === "toggle"
    ? (before.every((position) => position === "off") ? "on" : "off")
    : operation === "turn_on" ? "on" : "off";
  const toChange = entityIds.filter((_, index) => before[index] !== wanted);
  if (toChange.length === 0) {
    return answer(target, "ok", `${label} ${plural ? "are" : "is"} already ${wanted}.`, log("already"));
  }
  try {
    for (const [domain, ids] of byDomain(toChange)) {
      await control.call(domain, wanted === "on" ? "turn_on" : "turn_off", ids);
    }
  } catch (error) {
    const after = positions(stateCache, entityIds);
    return answer(
      target,
      "declined",
      `Home Assistant didn't take that, so ${theLabel(label)} ${plural ? "are" : "is"} still ${summary(after, before)}.`,
      `${log("ha_failed", after)} error=${errorText(error)}`,
      toChange,
    );
  }
  await settle(() => positions(stateCache, entityIds).every((position) => position === wanted), settleMs);
  const after = positions(stateCache, entityIds);
  if (after.some((position) => position !== wanted)) {
    return answer(
      target,
      "declined",
      after.some((position) => position === null)
        ? `I asked, but I can't see ${theLabel(label)} now, so I can't tell you ${plural ? "they" : "it"} changed.`
        : `I asked, but ${theLabel(label)} still ${plural ? "show" : "shows"} ${summary(after, before)}.`,
      log("not_changed", after),
      toChange,
    );
  }
  return answer(target, "ok", `${label} ${plural ? "are" : "is"} ${wanted}.`, log("done", after), toChange);
}

function positions(stateCache: HaStateCache | undefined, entityIds: readonly string[]): (Position | null)[] {
  return entityIds.map((entityId) => {
    const value = liveState(stateCache, entityId)?.state;
    return value === "on" || value === "off" ? value : null;
  });
}

/** "on", "off", or "partly on" for a group that split. */
function summary(current: readonly (Position | null)[], fallback: readonly (Position | null)[]): string {
  const known = current.map((position, index) => position ?? fallback[index] ?? null);
  if (known.every((position) => position === "on")) return "on";
  if (known.every((position) => position === "off")) return "off";
  return "partly on";
}

function shown(position: string | null): string {
  return position ?? "unknown";
}

// --- Locks (the front door, and the garage door, which HA keeps as a lock) -----

type LockOperation = "lock" | "unlock" | "open" | "close";
type LockPosition = "locked" | "unlocked";

function isLockOperation(operation: EntityActionIntent["operation"]): operation is LockOperation {
  return operation === "lock" || operation === "unlock" || operation === "open" || operation === "close";
}

/**
 * Open and close mean unlock and lock (the garage door opens and
 * closes when told). Only a garage's "lock" is the door itself (HA keeps the
 * garage door as a lock driven by its door sensor), so only it answers in
 * door words, and only when asked in them: "close the garage" -> "Garage is
 * closed", "lock the garage" -> "Garage is locked". A real lock says what
 * its bolt does: "Front door is unlocked", whichever word was used.
 */
async function runLock(
  control: DeviceSwitch,
  stateCache: HaStateCache | undefined,
  target: ResolvedTarget,
  entityId: string,
  operation: LockOperation,
  speaker: string,
  settleMs: number,
): Promise<BasicResult> {
  const label = spokenLabel(target.label);
  const door = (operation === "open" || operation === "close") && isGarageDoorLock(entityId, target.label);
  const wanted: LockPosition = operation === "lock" || operation === "close" ? "locked" : "unlocked";
  const word = (position: string | null) => (door && position === "locked" ? "closed" : door && position === "unlocked" ? "open" : shown(position));
  const before = liveState(stateCache, entityId)?.state ?? null;
  const log = (outcome: string, after: string | null = before) => (
    `device action: speaker=${speaker} operation=${operation} entities=${entityId} before=${shown(before)} after=${shown(after)} outcome=${outcome}`
  );
  if (before === "jammed") {
    return answer(target, "declined", `${label} is jammed, so I didn't touch it.`, log("jammed"));
  }
  if (before === "locking" || before === "unlocking" || before === "opening") {
    return answer(target, "declined", `${label} is already moving, so I didn't touch it.`, log("moving"));
  }
  if (before !== "locked" && before !== "unlocked") {
    return answer(target, "declined", `${label} isn't responding right now, so I didn't touch it.`, log("unavailable"));
  }
  if (before === wanted) {
    return answer(target, "ok", `${label} is already ${word(wanted)}.`, log("already"));
  }
  try {
    await control.call("lock", wanted === "locked" ? "lock" : "unlock", [entityId]);
  } catch (error) {
    return answer(target, "declined", `Home Assistant didn't take that, so ${theLabel(label)} is still ${word(before)}.`, `${log("ha_failed")} error=${errorText(error)}`, [entityId]);
  }
  await settle(() => liveState(stateCache, entityId)?.state === wanted, settleMs);
  const after = liveState(stateCache, entityId)?.state ?? null;
  if (after === wanted) {
    return answer(target, "ok", `${label} is ${word(wanted)}.`, log("done", after), [entityId]);
  }
  if (after === "locking" || after === "unlocking") {
    return answer(target, "ok", `${label} is ${door ? (wanted === "locked" ? "closing" : "opening") : after} now.`, log("moving", after), [entityId]);
  }
  // A garage door takes about 13 s to come down, and its sensor says closed only at the bottom.
  const verb = door ? (wanted === "locked" ? "close" : "open") : wanted === "locked" ? "lock" : "unlock";
  return answer(target, "ok", `I've told ${theLabel(label)} to ${verb}. It doesn't show ${word(wanted)} yet.`, log("not_yet", after), [entityId]);
}

// --- The HVAC -------------------------------------------------------------------

interface ClimateSteps {
  readonly power: "on" | "off" | null;
  readonly mode: ClimateMode | null;
  readonly temperature: number | null;
  /** "turn up the heater": one step from the current setpoint. */
  readonly nudge: "up" | "down" | null;
  /** The mode the target named ("the heating"): the reply's subject, and what "off" means. */
  readonly modeTarget: ClimateMode | null;
}

function climateSteps(request: ClimateRequest): ClimateSteps {
  const modeTarget = request.targetMode;
  return {
    power: request.power,
    // "turn on the heating" asks for heat; "set the heating to 22" too.
    mode: request.mode ?? (modeTarget && request.power !== "off" ? modeTarget : null),
    temperature: request.temperature,
    nudge: request.nudge,
    modeTarget,
  };
}

const MODE_WORDS: Readonly<Record<string, string>> = { heat: "heating", cool: "cooling", fan_only: "on fan only", off: "off" };

async function runClimate(
  control: DeviceSwitch,
  stateCache: HaStateCache | undefined,
  target: ResolvedTarget,
  entityId: string,
  asked: ClimateSteps,
  speaker: string,
  settleMs: number,
): Promise<BasicResult> {
  const state = liveState(stateCache, entityId);
  const steps = withNudge(asked, state);
  // The HVAC by its own name ("the HVAC"); "the heating" when that is what was asked about.
  const device = theLabel(target.label);
  const Device = capitalize(device);
  const label = steps.modeTarget ? capitalize(MODE_WORDS[steps.modeTarget] ?? device) : Device;
  const before = state?.state ?? null;
  const setpoint = (current: HaEntityState | null) => numberAttribute(current, "temperature");
  const describe = (current: HaEntityState | null) => {
    const mode = current?.state ?? "unknown";
    const degrees = mode === "heat" || mode === "cool" ? setpoint(current) : null;
    return `${MODE_WORDS[mode] ?? mode}${degrees ? ` at ${degrees} degrees` : ""}`;
  };
  const log = (outcome: string, after: HaEntityState | null = state) => (
    `device action: speaker=${speaker} climate=${JSON.stringify(steps)} entities=${entityId} before=${describe(state)} after=${describe(after)} outcome=${outcome}`
  );
  const refuse = (text: string, outcome: string) => answer(target, "declined", text, log(outcome));
  if (!state || !before || before === "unavailable" || before === "unknown") {
    return refuse(`${Device} isn't responding right now, so I didn't touch it.`, "unavailable");
  }
  const modes = stringList(state.attributes.hvac_modes);
  if (steps.mode && !modes.includes(steps.mode)) {
    return refuse(`${Device} can't do ${MODE_WORDS[steps.mode] ?? steps.mode}. I didn't touch it.`, "mode not offered");
  }
  if (steps.nudge && steps.temperature === null && steps.modeTarget && before !== steps.modeTarget) {
    return refuse(`${label} isn't on. ${Device} is ${describe(state)}. I didn't touch it.`, "nudge on a mode that isn't running");
  }
  if (steps.nudge && steps.temperature === null) {
    return refuse(`${Device} is ${describe(state)}, so there's no temperature to turn ${steps.nudge}. I didn't touch it.`, "nudge without a setpoint");
  }
  if (steps.temperature !== null) {
    const min = numberAttribute(state, "min_temp");
    const max = numberAttribute(state, "max_temp");
    const step = numberAttribute(state, "target_temp_step") ?? 1;
    if (min === null || max === null || steps.temperature < min || steps.temperature > max || !onStep(steps.temperature, min, step)) {
      return refuse(`${Device} goes from ${min ?? "?"} to ${max ?? "?"} degrees${step === 1 ? " in whole degrees" : ""}. I didn't touch it.`, "temperature out of range");
    }
    const mode = steps.mode ?? before;
    if (mode === "fan_only") return refuse(`${Device} is on fan only, so there's no temperature to set. I didn't touch it.`, "no setpoint on fan");
    if (mode === "off") return refuse(`${Device} is off. Say heat or cool to ${steps.temperature} and I'll start it.`, "setpoint while off");
  }

  // What to call, and how to know it worked; "already" when nothing would change.
  let service: string;
  let data: Record<string, unknown> | undefined;
  let done: (current: HaEntityState | null) => boolean;
  let reply: (current: HaEntityState | null) => string;
  if (steps.power === "off") {
    if (steps.modeTarget && before !== steps.modeTarget) {
      const other = before === "off" ? "" : ` ${Device} is ${describe(state)}.`;
      return answer(target, "ok", `${label} is already off.${other}`, log("already"));
    }
    if (before === "off") return answer(target, "ok", `${label} is already off.`, log("already"));
    service = "turn_off";
    done = (current) => current?.state === "off";
    reply = () => `${label} is off.`;
  } else if (steps.mode || steps.temperature !== null) {
    const mode = steps.mode ?? before;
    const degrees = steps.temperature;
    if (before === mode && (degrees === null || setpoint(state) === degrees)) {
      return answer(target, "ok", `${Device} is already ${describe(state)}.`, log("already"));
    }
    service = degrees === null ? "set_hvac_mode" : "set_temperature";
    data = degrees === null ? { hvac_mode: mode } : { temperature: degrees, ...(steps.mode ? { hvac_mode: mode } : {}) };
    done = (current) => current?.state === mode && (degrees === null || setpoint(current) === degrees);
    reply = (current) => `${Device} is ${describe(current)}.`;
  } else {
    if (before !== "off") return answer(target, "ok", `${Device} is already on, ${describe(state)}.`, log("already"));
    service = "turn_on";
    done = (current) => Boolean(current && current.state !== "off");
    reply = (current) => `${Device} is on, ${describe(current)}.`;
  }
  try {
    await control.call("climate", service, [entityId], data);
  } catch (error) {
    return answer(target, "declined", `Home Assistant didn't take that, so ${device} is still ${describe(state)}.`, `${log("ha_failed")} error=${errorText(error)}`, [entityId]);
  }
  await settle(() => done(liveState(stateCache, entityId)), settleMs);
  const after = liveState(stateCache, entityId);
  if (!done(after)) {
    return answer(target, "declined", `I asked, but ${device} still shows ${describe(after)}.`, log("not_changed", after), [entityId]);
  }
  return answer(target, "ok", reply(after), log("done", after), [entityId]);
}

/**
 * "Turn up the heater": one step (the HVAC's own `target_temp_step`) from the
 * setpoint it has now, while heating or cooling. Otherwise the temperature
 * stays unset and the gate says why.
 */
function withNudge(steps: ClimateSteps, state: HaEntityState | null): ClimateSteps {
  if (!steps.nudge || steps.temperature !== null) return steps;
  const mode = steps.mode ?? state?.state;
  const setpoint = numberAttribute(state, "temperature");
  if ((mode !== "heat" && mode !== "cool") || state?.state !== mode || setpoint === null) return steps;
  const step = numberAttribute(state, "target_temp_step") ?? 1;
  return { ...steps, temperature: setpoint + (steps.nudge === "up" ? step : -step) };
}

function numberAttribute(state: HaEntityState | null, key: string): number | null {
  const value = state?.attributes[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function onStep(value: number, min: number, step: number): boolean {
  const steps = (value - min) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
}

// --- Shared ---------------------------------------------------------------------

export function verifiedSpeaker(principal: BasicTurnPrincipal): string | null {
  if (principal.trust !== "canonical" && principal.trust !== "recognized") return null;
  return canonicalHouseholdActorId(principal.trustedPersonId);
}

export function liveState(stateCache: HaStateCache | undefined, entityId: string): HaEntityState | null {
  return stateCache?.hasReceivedStateSnapshot() ? stateCache.get(entityId) ?? null : null;
}

export async function settle(done: () => boolean, settleMs: number): Promise<void> {
  const deadline = Date.now() + settleMs;
  while (!done() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
  }
}

function byDomain(entityIds: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const entityId of entityIds) {
    const domain = domainFromEntityId(entityId);
    groups.set(domain, [...groups.get(domain) ?? [], entityId]);
  }
  return groups;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The name for the start of a sentence: title-case words lowered ("Office
 * Lights" -> "Office lights"), acronyms and possessives kept ("HVAC", "Sam's").
 */
function spokenLabel(label: string): string {
  return capitalize(lowerCommonWords(label.trim().replace(/^lights\s*-\s*/i, "")));
}

/** The name mid-sentence: "the office lights", "the HVAC", "Sam's bedroom lights". */
export function theLabel(label: string): string {
  const lowered = lowerCommonWords(label);
  return /^\S+'s\b/.test(lowered) ? lowered : `the ${lowered}`;
}

function isPlural(label: string, entityIds: readonly string[]): boolean {
  return entityIds.length > 1 || /[^s]s$/i.test(label.trim().split(" ").at(-1) ?? "");
}

function pronoun(label: string, entityIds: readonly string[]): string {
  return isPlural(label, entityIds) ? "them" : "it";
}

/** A confirmed state keeps the target as the adjacent subject, so "turn them off" can follow. */
function answer(
  target: ResolvedTarget,
  status: "ok" | "declined",
  text: string,
  notes: string,
  touched: readonly string[] = [],
): BasicResult {
  return {
    route: "entity_action",
    status,
    confidence: "high",
    text,
    modelUsed: false,
    resultId: null,
    touchedEntities: [...touched],
    notes,
    ...(status === "ok"
      ? {
          contextFrame: { kind: "entity_status" as const, target },
          entityStatusTargetAcquisition: "explicit" as const,
          entityStatusActionSourceQuery: target.label,
        }
      : {}),
  };
}
