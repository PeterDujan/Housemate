import type { HaCommandClient } from "./ha-history.js";
import { isValidHaTimestamp } from "./ha-timestamp.js";
import { objectValue, optionalStringValue, serviceResponseValue } from "./value-guards.js";

/** Bin and waste collection calendars. */
export const WASTE_CALENDAR_PATTERN = /waste|bin|rubbish|trash|recycling|green/i;
/** Film, TV and release calendars (Radarr, Sonarr). */
export const MEDIA_CALENDAR_PATTERN = /radarr|sonarr|movie|film|release/i;

/** A household's own calendar: anything that is not a bin or media schedule (id and name text). */
export function isPersonalCalendarText(text: string): boolean {
  return !WASTE_CALENDAR_PATTERN.test(text) && !MEDIA_CALENDAR_PATTERN.test(text);
}

export interface HaCalendarEvent {
  readonly entityId: string;
  readonly calendarName: string | null;
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly location: string | null;
  readonly description: string | null;
}

export interface HaCalendarQuery {
  readonly entityIds: readonly string[];
  readonly start: string;
  readonly end: string;
  readonly calendarNames?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface HaCalendarFetcher {
  fetchEvents(query: HaCalendarQuery): Promise<readonly HaCalendarEvent[]>;
}

export const MAX_HA_CALENDAR_RESPONSE_ITEMS = 5_000;

export class HaCalendarService implements HaCalendarFetcher {
  private readonly client: HaCommandClient;

  constructor(client: HaCommandClient) {
    this.client = client;
  }

  async fetchEvents(query: HaCalendarQuery): Promise<readonly HaCalendarEvent[]> {
    query.signal?.throwIfAborted();
    if (query.entityIds.length === 0) {
      return [];
    }
    const response = await this.client.sendCommand(
      {
        type: "call_service",
        domain: "calendar",
        service: "get_events",
        service_data: {
          start_date_time: query.start,
          end_date_time: query.end,
        },
        target: { entity_id: [...query.entityIds] },
        return_response: true,
      },
      query.signal ? { signal: query.signal } : undefined,
    );
    return parseCalendarEventsResponse(
      response,
      query.calendarNames ?? {},
      query.entityIds,
    );
  }
}

export function parseCalendarEventsResponse(
  response: unknown,
  calendarNames: Readonly<Record<string, string>> = {},
  requestedEntityIds: readonly string[] = [],
): readonly HaCalendarEvent[] {
  const serviceResponse = serviceResponseValue(response, "calendar response");
  const entityIds = requestedEntityIds.length > 0
    ? [...requestedEntityIds]
    : Object.keys(serviceResponse);
  if (entityIds.length === 0) {
    throw new Error(
      "calendar response must contain at least one entity response",
    );
  }
  const events: HaCalendarEvent[] = [];
  let itemCount = 0;
  for (const entityId of entityIds) {
    if (!Object.hasOwn(serviceResponse, entityId)) {
      throw new Error(
        `calendar response omitted requested entity ${entityId}`,
      );
    }
    const entityResponse = objectValue(
      serviceResponse[entityId],
      `calendar response for ${entityId}`,
    );
    const rawEvents = entityResponse.events;
    if (!Array.isArray(rawEvents)) {
      throw new Error(
        `calendar response for ${entityId} must contain an events array`,
      );
    }
    itemCount += rawEvents.length;
    if (itemCount > MAX_HA_CALENDAR_RESPONSE_ITEMS) {
      throw new Error(
        `calendar response exceeded its ${MAX_HA_CALENDAR_RESPONSE_ITEMS}-item limit`,
      );
    }
    for (const rawEvent of rawEvents) {
      events.push(parseCalendarEvent(
        entityId,
        calendarNames[entityId] ?? null,
        rawEvent,
      ));
    }
  }
  return events.sort((left, right) => left.start.localeCompare(right.start) || left.summary.localeCompare(right.summary));
}

function parseCalendarEvent(entityId: string, calendarName: string | null, value: unknown): HaCalendarEvent {
  const input = objectValue(
    value,
    `calendar event for ${entityId}`,
  );
  const summary = optionalStringValue(
    input.summary,
    `calendar event summary for ${entityId}`,
  ) ?? optionalStringValue(
    input.message,
    `calendar event message for ${entityId}`,
  );
  const start = timestampValue(
    input.start,
    `calendar event start for ${entityId}`,
  );
  const end = timestampValue(
    input.end,
    `calendar event end for ${entityId}`,
  );
  if (!summary || !start || !end) {
    throw new Error(
      `calendar event for ${entityId} must contain summary, start, and end`,
    );
  }
  return {
    entityId,
    calendarName,
    summary,
    start,
    end,
    location: optionalStringValue(
      input.location,
      `calendar event location for ${entityId}`,
    ),
    description: optionalStringValue(
      input.description,
      `calendar event description for ${entityId}`,
    ),
  };
}

function timestampValue(value: unknown, label: string): string | null {
  const timestamp = optionalStringValue(value, label);
  if (!timestamp) {
    return null;
  }
  if (!isValidHaTimestamp(timestamp, { allowDateOnly: true })) {
    throw new Error(`${label} must be an ISO-like timestamp`);
  }
  return timestamp;
}
