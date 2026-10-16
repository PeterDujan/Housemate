import { HOUSE_LOCALE } from "./house-config.js";
/**
 * Wall-clock parts in a named timezone and the way back to UTC, shared by
 * the time parser, the answer modules and the HA readers.
 */

export interface ZonedDateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

// Building a formatter costs far more than using one; this runs several times per turn.
const formatters = new Map<string, Intl.DateTimeFormat>();

export function zonedDateTimeParts(date: Date, timezone: string): ZonedDateTimeParts {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const part = (type: string): number => {
    const value = parts.find((item) => item.type === type)?.value;
    if (!value) {
      throw new Error(`timezone formatter did not return ${type}`);
    }
    return Number(value);
  };
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}

/** How far the zone's wall clock is ahead of UTC at. */
export function timezoneOffsetMs(date: Date, timezone: string): number {
  const parts = zonedDateTimeParts(date, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant a wall-clock time in the zone names (offset checked twice for DST edges). */
export function zonedTimeToUtc(parts: ZonedDateTimeParts, timezone: string): Date {
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let utc = new Date(localAsUtc - timezoneOffsetMs(new Date(localAsUtc), timezone));
  utc = new Date(localAsUtc - timezoneOffsetMs(utc, timezone));
  return utc;
}

/** The local hour (0-23) of an ISO instant. */
export function hourInTimezone(iso: string, timezone: string): number {
  const hour = zonedDateTimeParts(new Date(iso), timezone).hour;
  return Number.isFinite(hour) ? hour : -1;
}

/** Local weekday, 0 = Sunday. */
export function localWeekday(date: Date, timezone: string): number {
  const parts = zonedDateTimeParts(date, timezone);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

/** The local calendar date, YYYY-MM-DD. */
export function localDate(date: Date, timezone: string): string {
  return localDateOffset(date, timezone, 0);
}

/** The local calendar date `dayOffset` days from `now`, YYYY-MM-DD. */
export function localDateOffset(now: Date, timezone: string, dayOffset: number): string {
  const parts = zonedDateTimeParts(now, timezone);
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** "at 5:31 pm" today, "yesterday at 9:53 pm", "on Saturday at 8:53 pm" within the week, else "on 26 September at...". */
export function spokenWhen(at: number, now: Date, timezone: string): string {
  const time = new Intl.DateTimeFormat(HOUSE_LOCALE, { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true })
    .format(at).replace(/\s+/g, " ").toLowerCase();
  const day = dayKey(at, timezone);
  if (day === dayKey(now.getTime(), timezone)) return `at ${time}`;
  if (day === dayKey(now.getTime() - DAY_MS, timezone)) return `yesterday at ${time}`;
  if (now.getTime() - at < 6 * DAY_MS) {
    return `on ${new Intl.DateTimeFormat(HOUSE_LOCALE, { timeZone: timezone, weekday: "long" }).format(at)} at ${time}`;
  }
  return `on ${spokenDay(at, timezone)} at ${time}`;
}

export function spokenDay(at: number, timezone: string): string {
  // Australian order ("26 September") whatever the runtime's ICU data says.
  const parts = new Intl.DateTimeFormat(HOUSE_LOCALE, { timeZone: timezone, day: "numeric", month: "long" }).formatToParts(at);
  return `${parts.find((part) => part.type === "day")?.value ?? ""} ${parts.find((part) => part.type === "month")?.value ?? ""}`;
}

function dayKey(at: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

const DAY_MS = 24 * 60 * 60 * 1000;
