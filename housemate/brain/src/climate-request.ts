/**
 * The spoken shapes of an HVAC request, parsed from the routing
 * core. Pure: it names a mode, a setpoint or on/off and the words used for
 * the target; the device gate decides what the target is and whether to act.
 *
 *   turn on the heating / put the aircon on / turn the HVAC off / heater off
 *   set the HVAC to 22 / set the temperature to 22 degrees / heater to 21
 *   set the HVAC to heat / set the heating to 22 / put the HVAC on cool at 21
 *   turn the heater up to 22 / turn up the heater (one step)
 */

export type ClimateMode = "heat" | "cool" | "fan_only";

export interface ClimateRequest {
  /** The spoken target ("hvac", "heating", "temperature"). */
  readonly targetText: string;
  /** A mode the target itself names ("the heating"), or null. */
  readonly targetMode: ClimateMode | null;
  readonly power: "on" | "off" | null;
  /** A mode asked for as the value ("to heat"). */
  readonly mode: ClimateMode | null;
  readonly temperature: number | null;
  /** "turn up the heater": one step from the current setpoint. */
  readonly nudge: "up" | "down" | null;
}

/** Nouns that name both the HVAC and a mode. "Fan" is left out: it names fans. */
const MODE_TARGETS: Readonly<Record<string, ClimateMode>> = {
  heating: "heat",
  heater: "heat",
  cooling: "cool",
  aircon: "cool",
  "air con": "cool",
  "air conditioning": "cool",
  "air conditioner": "cool",
};

/** Targets that mean "the HVAC" without naming it. */
const GENERIC_TARGETS: ReadonlySet<string> = new Set(["temperature", "thermostat"]);

const MODE_VALUES: Readonly<Record<string, ClimateMode>> = {
  ...MODE_TARGETS,
  heat: "heat",
  cool: "cool",
  fan: "fan_only",
  "fan only": "fan_only",
};

const TARGET = String.raw`(?:the\s+)?([a-z][a-z' ]*?)`;
const POWER_FIRST = new RegExp(String.raw`^(?:turn|switch|put)\s+(on|off)\s+${TARGET}$`);
const POWER_LAST = new RegExp(String.raw`^(?:(?:turn|switch|put)\s+)?${TARGET}\s+(on|off)$`);
const SET_VALUE = new RegExp(String.raw`^(?:(?:set|put|turn|switch|change)\s+)?${TARGET}(?:\s+(?:up|down))?\s+(?:to|on|onto|at)\s+(.+)$`);
const NUDGE_FIRST = new RegExp(String.raw`^turn\s+(up|down)\s+${TARGET}$`);
const NUDGE_LAST = new RegExp(String.raw`^turn\s+${TARGET}\s+(up|down)$`);
/** Courtesy at the end of a request ("... please", "... For me, thanks"). */
const TRAILING_COURTESY = /(?:\s+(?:please|thanks|thank you|mate|for me|if you can|if you could))+$/;
const VALUE = /^(?:(heat|heating|cool|cooling|fan only|fan|aircon|air con)\s*)?(?:(?:at|to|on)\s+)?(?:(\d{1,2}(?:\.\d)?)\s*(?:degrees?|c|celsius)?)?$/;

export function parseClimateRequest(core: string): ClimateRequest | null {
  const text = core.trim().replace(/[.!?,]+$/, "").replace(/\s+/g, " ").replace(TRAILING_COURTESY, "");
  const powerFirst = POWER_FIRST.exec(text);
  if (powerFirst?.[1] && powerFirst[2]) return request(powerFirst[2], { power: powerFirst[1] as "on" | "off" });
  const powerLast = POWER_LAST.exec(text);
  if (powerLast?.[1] && powerLast[2]) return request(powerLast[1], { power: powerLast[2] as "on" | "off" });
  const nudge = NUDGE_FIRST.exec(text) ?? NUDGE_LAST.exec(text);
  if (nudge) {
    const first = NUDGE_FIRST.test(text);
    return request((first ? nudge[2] : nudge[1]) ?? "", { nudge: (first ? nudge[1] : nudge[2]) as "up" | "down" });
  }
  const set = SET_VALUE.exec(text);
  const value = set?.[2] ? VALUE.exec(set[2].trim()) : null;
  if (!set?.[1] || !value || (!value[1] && !value[2])) return null;
  return request(set[1], {
    mode: value[1] ? MODE_VALUES[value[1]] ?? null : null,
    temperature: value[2] ? Number(value[2]) : null,
  });
}

function request(
  target: string,
  parts: Partial<Pick<ClimateRequest, "power" | "mode" | "temperature" | "nudge">>,
): ClimateRequest | null {
  const targetText = target.trim();
  if (!targetText) return null;
  return {
    targetText,
    targetMode: MODE_TARGETS[targetText] ?? null,
    power: parts.power ?? null,
    mode: parts.mode ?? null,
    temperature: parts.temperature ?? null,
    nudge: parts.nudge ?? null,
  };
}

/** Whether the target words mean "the HVAC" without a name: a mode noun or "the temperature". */
export function climateTargetIsGeneric(request: Pick<ClimateRequest, "targetMode" | "targetText">): boolean {
  return request.targetMode !== null || GENERIC_TARGETS.has(request.targetText);
}

export interface ClimateQuestion {
  readonly targetText: string;
  readonly targetMode: ClimateMode | null;
  /** "is it on?", "is it off?", or "what is it set to?". */
  readonly asks: "on" | "off" | "setting";
}

const TIME_FILLER = /(?:\s+(?:right now|at the moment|currently|now|at present))+$/;
const ASK_STATE = new RegExp(String.raw`^(?:is|are)\s+${TARGET}\s+(on|off|running|going|working)$`);
const ASK_SETTING = new RegExp(String.raw`^(?:what(?:\s+temperature)?\s+is|whats)\s+${TARGET}\s+(?:set\s+(?:to|at|on)|on|at)$`);

/** "is the heater on?", "is the aircon off right now?", "what is the heater set to?" (read-only). */
export function parseClimateQuestion(core: string): ClimateQuestion | null {
  const text = core.trim().replace(/[.!?,]+$/, "").replace(/\s+/g, " ").replace(TRAILING_COURTESY, "").replace(TIME_FILLER, "");
  const state = ASK_STATE.exec(text);
  if (state?.[1] && state[2]) return question(state[1], state[2] === "off" ? "off" : "on");
  const setting = ASK_SETTING.exec(text);
  return setting?.[1] ? question(setting[1], "setting") : null;
}

function question(target: string, asks: ClimateQuestion["asks"]): ClimateQuestion | null {
  const targetText = target.trim();
  return targetText ? { targetText, targetMode: MODE_TARGETS[targetText] ?? null, asks } : null;
}
