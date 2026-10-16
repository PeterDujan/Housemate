import type { HaCommandClient } from "./ha-history.js";
import { isValidHaTimestamp } from "./ha-timestamp.js";
import { objectValue, optionalStringValue, serviceResponseValue } from "./value-guards.js";
import { timezoneOffsetMs, zonedDateTimeParts } from "./zoned-time.js";
import { HOUSE_TIME_ZONE } from "./house-config.js";

export interface HaWeatherForecastPoint {
  readonly datetime: string;
  readonly condition: string | null;
  readonly precipitationProbability: number | null;
  readonly precipitation: number | null;
  readonly temperature: number | null;
  readonly windSpeed: number | null;
  readonly windGustSpeed: number | null;
  readonly humidity: number | null;
  readonly uvIndex: number | null;
}

export interface HaDailyWeatherForecastPoint {
  readonly datetime: string;
  readonly condition: string | null;
  readonly precipitationProbability: number | null;
  readonly precipitation: number | null;
  readonly temperature: number | null;
  readonly templow: number | null;
}

export interface HaWeatherForecastFetchOptions {
  readonly signal?: AbortSignal;
}

export interface HaWeatherForecastFetcher {
  fetchHourly(
    entityId: string,
    options?: HaWeatherForecastFetchOptions,
  ): Promise<readonly HaWeatherForecastPoint[]>;
  fetchDaily(
    entityId: string,
    options?: HaWeatherForecastFetchOptions,
  ): Promise<readonly HaDailyWeatherForecastPoint[]>;
}

export const MAX_HA_WEATHER_FORECAST_ITEMS = 1_000;

export class HaWeatherForecastService implements HaWeatherForecastFetcher {
  private readonly client: HaCommandClient;
  private readonly timezone: string;

  constructor(client: HaCommandClient, timezone = HOUSE_TIME_ZONE) {
    this.client = client;
    this.timezone = timezone;
  }

  async fetchHourly(
    entityId: string,
    options: HaWeatherForecastFetchOptions = {},
  ): Promise<readonly HaWeatherForecastPoint[]> {
    options.signal?.throwIfAborted();
    const response = await this.client.sendCommand(
      {
        type: "call_service",
        domain: "weather",
        service: "get_forecasts",
        service_data: { type: "hourly" },
        target: { entity_id: [entityId] },
        return_response: true,
      },
      options.signal ? { signal: options.signal } : undefined,
    );
    return parseHourlyForecastResponse(response, entityId, { naiveTimezone: this.timezone });
  }

  async fetchDaily(
    entityId: string,
    options: HaWeatherForecastFetchOptions = {},
  ): Promise<readonly HaDailyWeatherForecastPoint[]> {
    options.signal?.throwIfAborted();
    const response = await this.client.sendCommand(
      {
        type: "call_service",
        domain: "weather",
        service: "get_forecasts",
        service_data: { type: "daily" },
        target: { entity_id: [entityId] },
        return_response: true,
      },
      options.signal ? { signal: options.signal } : undefined,
    );
    return parseDailyForecastResponse(response, entityId, { naiveTimezone: this.timezone });
  }
}

export function parseHourlyForecastResponse(
  response: unknown,
  entityId: string,
  options: { readonly naiveTimezone?: string } = {},
): readonly HaWeatherForecastPoint[] {
  const serviceResponse = serviceResponseValue(response, "weather response");
  const entityResponse = requestedEntityResponse(serviceResponse, entityId);
  const forecast = entityResponse.forecast;
  if (!Array.isArray(forecast)) {
    throw new Error(
      `weather response for ${entityId} must contain a forecast array`,
    );
  }
  assertForecastItemLimit(forecast);
  return forecast.map((point) => parseForecastPoint(point, entityId, options.naiveTimezone));
}

export function parseDailyForecastResponse(
  response: unknown,
  entityId: string,
  options: { readonly naiveTimezone?: string } = {},
): readonly HaDailyWeatherForecastPoint[] {
  const serviceResponse = serviceResponseValue(response, "weather response");
  const entityResponse = requestedEntityResponse(serviceResponse, entityId);
  const forecast = entityResponse.forecast;
  if (!Array.isArray(forecast)) {
    throw new Error(
      `weather response for ${entityId} must contain a forecast array`,
    );
  }
  assertForecastItemLimit(forecast);
  return forecast.map((point) => parseDailyForecastPoint(point, entityId, options.naiveTimezone));
}

function requestedEntityResponse(
  serviceResponse: Readonly<Record<string, unknown>>,
  entityId: string,
): Record<string, unknown> {
  if (!Object.hasOwn(serviceResponse, entityId)) {
    throw new Error(`weather response omitted requested entity ${entityId}`);
  }
  return objectValue(
    serviceResponse[entityId],
    `weather response for ${entityId}`,
  );
}

function assertForecastItemLimit(forecast: readonly unknown[]): void {
  if (forecast.length > MAX_HA_WEATHER_FORECAST_ITEMS) {
    throw new Error(
      `weather response exceeded its ${MAX_HA_WEATHER_FORECAST_ITEMS}-item limit`,
    );
  }
}

function parseForecastPoint(
  value: unknown,
  entityId: string,
  naiveTimezone: string | undefined,
): HaWeatherForecastPoint {
  const input = objectValue(
    value,
    `weather forecast point for ${entityId}`,
  );
  const datetime = timestampValue(
    input.datetime,
    `weather forecast datetime for ${entityId}`,
    false,
    naiveTimezone,
  );
  if (!datetime) {
    throw new Error(
      `weather forecast point for ${entityId} must contain datetime`,
    );
  }
  return {
    datetime,
    condition: optionalStringValue(
      input.condition,
      `weather forecast condition for ${entityId}`,
    ),
    precipitationProbability: numberValue(
      input.precipitation_probability,
      `weather forecast precipitation_probability for ${entityId}`,
    ),
    precipitation: numberValue(
      input.precipitation,
      `weather forecast precipitation for ${entityId}`,
    ),
    temperature: numberValue(
      input.temperature,
      `weather forecast temperature for ${entityId}`,
    ),
    windSpeed: numberValue(
      input.wind_speed,
      `weather forecast wind_speed for ${entityId}`,
    ),
    windGustSpeed: numberValue(
      input.wind_gust_speed,
      `weather forecast wind_gust_speed for ${entityId}`,
    ),
    humidity: numberValue(
      input.humidity,
      `weather forecast humidity for ${entityId}`,
    ),
    uvIndex: numberValue(
      input.uv_index,
      `weather forecast uv_index for ${entityId}`,
    ),
  };
}

function parseDailyForecastPoint(
  value: unknown,
  entityId: string,
  naiveTimezone: string | undefined,
): HaDailyWeatherForecastPoint {
  const input = objectValue(
    value,
    `weather forecast point for ${entityId}`,
  );
  const datetime = timestampValue(
    input.datetime,
    `weather forecast datetime for ${entityId}`,
    true,
    naiveTimezone,
  );
  if (!datetime) {
    throw new Error(
      `weather forecast point for ${entityId} must contain datetime`,
    );
  }
  return {
    datetime,
    condition: optionalStringValue(
      input.condition,
      `weather forecast condition for ${entityId}`,
    ),
    precipitationProbability: numberValue(
      input.precipitation_probability,
      `weather forecast precipitation_probability for ${entityId}`,
    ),
    precipitation: numberValue(
      input.precipitation,
      `weather forecast precipitation for ${entityId}`,
    ),
    temperature: numberValue(
      input.temperature,
      `weather forecast temperature for ${entityId}`,
    ),
    templow: numberValue(
      input.templow,
      `weather forecast templow for ${entityId}`,
    ),
  };
}

function timestampValue(
  value: unknown,
  label: string,
  allowDateOnly: boolean,
  naiveTimezone: string | undefined,
): string | null {
  const timestamp = optionalStringValue(value, label);
  if (!timestamp) {
    return null;
  }
  if (isValidHaTimestamp(timestamp, { allowDateOnly })) return timestamp;
  const normalized = naiveTimezone ? normalizeNaiveWeatherTimestamp(timestamp, naiveTimezone) : null;
  if (normalized && isValidHaTimestamp(normalized, { allowDateOnly })) return normalized;
  throw new Error(`${label} must be an ISO-like timestamp`);
}

function normalizeNaiveWeatherTimestamp(value: string, timezone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(value);
  if (!match) return null;
  const expected = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  };
  if (expected.month < 1 || expected.month > 12 || expected.day < 1 || expected.day > 31
    || expected.hour > 23 || expected.minute > 59 || expected.second > 59) return null;
  const localAsUtc = Date.UTC(expected.year, expected.month - 1, expected.day, expected.hour, expected.minute, expected.second);
  let utcMs = localAsUtc - timezoneOffsetMs(new Date(localAsUtc), timezone);
  utcMs = localAsUtc - timezoneOffsetMs(new Date(utcMs), timezone);
  const resolved = zonedDateTimeParts(new Date(utcMs), timezone);
  return Object.entries(expected).every(([key, number]) => resolved[key as keyof typeof resolved] === number)
    ? new Date(utcMs).toISOString()
    : null;
}

function numberValue(value: unknown, label: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must be a finite number`);
    }
    return value;
  }
  if (typeof value === "string" && !value.trim()) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a finite number`);
  }
  const text = value.trim();
  if (!DECIMAL_NUMBER_PATTERN.test(text)) {
    throw new Error(`${label} must be a finite number`);
  }
  const number = Number(text);
  if (!Number.isFinite(number)) {
    throw new Error(`${label} must be a finite number`);
  }
  return number;
}

const DECIMAL_NUMBER_PATTERN =
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;
