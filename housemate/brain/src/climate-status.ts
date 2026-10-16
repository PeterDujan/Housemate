import type { AliasEntry } from "./alias-schema.js";
import type { BasicResult, ResolvedTarget } from "./basic-brain-contracts.js";
import { climateTargetIsGeneric, type ClimateMode, type ClimateQuestion } from "./climate-request.js";
import { domainFromEntityId, friendlyName, type HaEntityState, type HaStateCache } from "./ha-state-cache.js";
import { capitalize, lowerCommonWords } from "./text-format.js";

/**
 * "is the heater on?" answered from the HVAC's
 * live mode and setpoint, in the household's words: the heater is heat mode,
 * the aircon is cool mode. "If the cooler is on and we ask if the heater is
 * on, he should reply 'No, the aircon is on though'." Read-only; code-owned.
 */

/** What the household calls each mode. */
const MODE_NAMES: Readonly<Record<string, string>> = { heat: "heater", cool: "aircon" };

/**
 * The climate device the words mean: "the heater" / "the temperature" is the
 * house's only HVAC; a name or alias must land on a climate device. Null
 * otherwise, so other owners keep the turn.
 */
export function climateQuestionTarget(
  question: Pick<ClimateQuestion, "targetText" | "targetMode">,
  stateCache: HaStateCache | undefined,
  aliases: readonly AliasEntry[],
  resolve: (text: string) => ResolvedTarget | null,
  /** The same-session adjacent subject, for "what is it set to?". */
  adjacent: ResolvedTarget | null,
): ResolvedTarget | null {
  if (/^(?:it|that|this)$/.test(question.targetText)) {
    return adjacent && adjacent.entityIds.length === 1 && domainFromEntityId(adjacent.entityIds[0] as string) === "climate" ? adjacent : null;
  }
  if (climateTargetIsGeneric(question)) {
    const climates = (stateCache?.entries() ?? []).filter((state) => domainFromEntityId(state.entityId) === "climate");
    const only = climates.length === 1 ? climates[0] : null;
    if (!only) return null;
    const alias = aliases.find((entry) => entry.target.kind === "entity" && entry.target.entityId === only.entityId);
    // Named by its alias when it has one, so "turn it off" can follow.
    return alias
      ? { label: alias.alias, entityIds: [only.entityId], source: "alias" }
      : { label: friendlyName(only), entityIds: [only.entityId], source: "inferred" };
  }
  const named = resolve(question.targetText);
  return named && named.entityIds.length === 1 && domainFromEntityId(named.entityIds[0] as string) === "climate" ? named : null;
}

export function climateQuestionAnswer(question: ClimateQuestion, target: ResolvedTarget, stateCache: HaStateCache | undefined): BasicResult {
  const state = stateCache?.hasReceivedStateSnapshot() ? stateCache.get(target.entityIds[0] as string) ?? null : null;
  const device = `the ${lowerCommonWords(target.label)}`;
  const reply = (status: "ok" | "declined", text: string) => ({
    route: "entity_status" as const,
    status,
    confidence: "high" as const,
    text,
    modelUsed: false,
    resultId: null,
    touchedEntities: [],
    notes: `climate question: asks=${question.asks} target=${question.targetText} mode=${state?.state ?? "unknown"} setpoint=${setpoint(state) ?? "none"}`,
    ...(status === "ok"
      ? { contextFrame: { kind: "entity_status" as const, target }, entityStatusTargetAcquisition: "explicit" as const, entityStatusActionSourceQuery: target.label }
      : {}),
  });
  const mode = state?.state ?? null;
  if (!state || !mode || mode === "unavailable" || mode === "unknown") {
    return reply("declined", `${capitalize(device)} isn't responding right now, so I can't tell you.`);
  }
  const running = runningPhrase(state);
  if (question.asks === "setting") {
    if (mode === "off") return reply("ok", `${capitalize(device)} is off.`);
    if (mode === "fan_only") return reply("ok", `${capitalize(device)} is on fan only, so there's no temperature set.`);
    const degrees = setpoint(state);
    return reply("ok", degrees ? `The ${MODE_NAMES[mode] ?? "HVAC"}'s set to ${degrees} degrees.` : `${capitalize(running)}, with no temperature showing.`);
  }
  const asked = question.targetMode;
  // Is what they asked about the thing that's running?
  const isOn = asked ? mode === asked : mode !== "off";
  const yes = question.asks === "on" ? isOn : !isOn;
  if (asked && mode !== asked && mode !== "off") {
    // The other mode is running: "No, the aircon is on though."
    return reply("ok", `${yes ? "Yes" : "No"}, ${running} though.`);
  }
  if (mode === "off") return reply("ok", `${yes ? "Yes" : "No"}, ${device} is off.`);
  return reply("ok", `${yes ? "Yes" : "No"}, ${running}.`);
}

/** "the heater's on at 22 degrees", "the aircon's on", "the HVAC is on fan only". */
function runningPhrase(state: HaEntityState): string {
  const name = MODE_NAMES[state.state as ClimateMode];
  if (!name) return state.state === "fan_only" ? "the HVAC is on fan only" : `the HVAC is ${state.state}`;
  const degrees = setpoint(state);
  return `the ${name}'s on${degrees ? ` at ${degrees} degrees` : ""}`;
}

function setpoint(state: HaEntityState | null): number | null {
  const value = state?.attributes.temperature;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
