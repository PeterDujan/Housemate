import type { HaStateCache } from "./ha-state-cache.js";
import { assistantName } from "./persona.js";

/** The house's helper switches, named after the assistant (input_boolean.housemate_proactive for Housemate). */
const HELPER_SLUG = assistantName().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "housemate";
export const JARVIS_PROACTIVE_ENTITY_ID = `input_boolean.${HELPER_SLUG}_proactive`;
export const JARVIS_SILENT_FROM_ENTITY_ID = `input_datetime.${HELPER_SLUG}_silent_from`;
export const JARVIS_SILENT_UNTIL_ENTITY_ID = `input_datetime.${HELPER_SLUG}_silent_until`;

export function proactiveHelperEnabled(stateCache: HaStateCache | undefined): boolean {
  const state = stateCache?.get(JARVIS_PROACTIVE_ENTITY_ID)?.state.trim().toLowerCase();
  return state === undefined || state === "on";
}

export function silentHelperHours(
  stateCache: HaStateCache | undefined,
): { readonly startHourLocal: number; readonly endHourLocal: number } | null {
  const start = parseTimeHour(stateCache?.get(JARVIS_SILENT_FROM_ENTITY_ID)?.state);
  const end = parseTimeHour(stateCache?.get(JARVIS_SILENT_UNTIL_ENTITY_ID)?.state);
  return start === null || end === null ? null : { startHourLocal: start, endHourLocal: end };
}

function parseTimeHour(value: string | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value?.trim() ?? "");
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return null;
  }
  return hour + minute / 60;
}
