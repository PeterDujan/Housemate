/**
 * Input validators shared by every JSON, config and store parser.
 * A dependency-free leaf: each parser used to carry its own copy.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A plain object, or null for anything else (never throws). */
export function recordOrNull(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function arrayValue(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

/** A non-blank string, trimmed, or null. */
export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A non-blank string exactly as given (not trimmed), or null. */
export function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** A non-blank string, trimmed; otherwise throws "<label> <problem>". */
export function requiredString(value: unknown, label: string, problem = "is required"): string {
  const parsed = optionalString(value);
  if (!parsed) {
    throw new Error(`${label} ${problem}`);
  }
  return parsed;
}

/** Absent is null; present must be a string (trimmed, blank is null). */
export function optionalStringValue(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value.trim() || null;
}

export function unitNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
  return value;
}

/** A trimmed string of 1 to `maximum` characters. */
export function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum} characters`);
  }
  return value.trim();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Required-field readers for one record type; every error reads
 * "<subject> <field> must be..." (house patterns and observations).
 */
export function requiredFields(subject: string) {
  const fail = (field: string, problem: string): never => {
    throw new Error(`${subject} ${field} must be ${problem}`);
  };
  const string = (value: unknown, field: string): string =>
    typeof value === "string" && value.trim() ? value.trim() : fail(field, "a non-empty string");
  const strings = (value: unknown, field: string): readonly string[] =>
    Array.isArray(value) && value.length >= 1
      ? value.map((entry) => string(entry, field))
      : fail(field, "a non-empty string array");
  const number = (value: unknown, field: string): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fail(field, "numeric");
  const positiveInteger = (value: unknown, field: string): number => {
    const parsed = number(value, field);
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : fail(field, "a positive integer");
  };
  const date = (value: unknown, field: string): string => {
    const parsed = string(value, field);
    return /^\d{4}-\d{2}-\d{2}$/.test(parsed) ? parsed : fail(field, "YYYY-MM-DD");
  };
  const iso = (value: unknown, field: string): string => {
    const parsed = string(value, field);
    return Number.isFinite(new Date(parsed).getTime()) ? parsed : fail(field, "an ISO timestamp");
  };
  return { string, strings, number, positiveInteger, date, iso };
}

/** The payload of an HA service call made with return_response, under either wrapper key. */
export function serviceResponseValue(response: unknown, label: string): Record<string, unknown> {
  const root = objectValue(response, label);
  if (Object.hasOwn(root, "response")) {
    return objectValue(root.response, `${label} response`);
  }
  if (Object.hasOwn(root, "service_response")) {
    return objectValue(root.service_response, `${label} service_response`);
  }
  return root;
}

export function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}
