export interface HaTimestampValidationOptions {
  readonly allowDateOnly?: boolean;
}

/**
 * Validates the timestamp shapes returned by Home Assistant read APIs.
 *
 * Date-only values are accepted only when the caller explicitly opts in.
 * Timed values must carry an explicit UTC marker or numeric offset so their
 * meaning never depends on the add-on host timezone.
 */
export function isValidHaTimestamp(
  value: string,
  options: HaTimestampValidationOptions = {},
): boolean {
  const dateOnly = DATE_ONLY_PATTERN.exec(value);
  if (dateOnly) {
    return options.allowDateOnly === true && validDateParts(dateOnly);
  }

  const timed = TIMED_PATTERN.exec(value);
  if (!timed || !validDateParts(timed)) {
    return false;
  }

  const hour = Number(timed[4]);
  const minute = Number(timed[5]);
  const second = timed[6] === undefined ? 0 : Number(timed[6]);
  const offsetHour = timed[7] === undefined ? 0 : Number(timed[7]);
  const offsetMinute = timed[8] === undefined ? 0 : Number(timed[8]);

  return hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 23
    && offsetMinute <= 59
    && Number.isFinite(Date.parse(value));
}

function validDateParts(match: RegExpExecArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const daysInMonth = [
    31,
    leapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= (daysInMonth[month - 1] ?? 0);
}

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const TIMED_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/u;
