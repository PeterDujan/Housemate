import type { HaCommandClient } from "./ha-history.js";
import { isValidHaTimestamp } from "./ha-timestamp.js";
import { objectValue, optionalStringValue, serviceResponseValue } from "./value-guards.js";

export interface HaTodoItem {
  readonly entityId: string;
  readonly listName: string | null;
  readonly summary: string;
  readonly uid: string | null;
  readonly status: string | null;
  readonly due: string | null;
  readonly description: string | null;
}

export interface HaTodoQuery {
  readonly entityIds: readonly string[];
  readonly statuses?: readonly string[];
  readonly listNames?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface HaTodoFetcher {
  fetchItems(query: HaTodoQuery): Promise<readonly HaTodoItem[]>;
}

export const MAX_HA_TODO_RESPONSE_ITEMS = 5_000;

export class HaTodoService implements HaTodoFetcher {
  private readonly client: HaCommandClient;

  constructor(client: HaCommandClient) {
    this.client = client;
  }

  async fetchItems(query: HaTodoQuery): Promise<readonly HaTodoItem[]> {
    query.signal?.throwIfAborted();
    if (query.entityIds.length === 0) {
      return [];
    }
    const response = await this.client.sendCommand(
      {
        type: "call_service",
        domain: "todo",
        service: "get_items",
        service_data: query.statuses && query.statuses.length > 0 ? { status: [...query.statuses] } : {},
        target: { entity_id: [...query.entityIds] },
        return_response: true,
      },
      query.signal ? { signal: query.signal } : undefined,
    );
    return parseTodoItemsResponse(
      response,
      query.listNames ?? {},
      query.entityIds,
    );
  }
}

export function parseTodoItemsResponse(
  response: unknown,
  listNames: Readonly<Record<string, string>> = {},
  requestedEntityIds: readonly string[] = [],
): readonly HaTodoItem[] {
  const serviceResponse = serviceResponseValue(response, "todo response");
  const entityIds = requestedEntityIds.length > 0
    ? [...requestedEntityIds]
    : Object.keys(serviceResponse);
  if (entityIds.length === 0) {
    throw new Error(
      "todo response must contain at least one entity response",
    );
  }
  const items: HaTodoItem[] = [];
  let itemCount = 0;
  for (const entityId of entityIds) {
    if (!Object.hasOwn(serviceResponse, entityId)) {
      throw new Error(`todo response omitted requested entity ${entityId}`);
    }
    const entityResponse = objectValue(
      serviceResponse[entityId],
      `todo response for ${entityId}`,
    );
    const rawItems = entityResponse.items;
    if (!Array.isArray(rawItems)) {
      throw new Error(
        `todo response for ${entityId} must contain an items array`,
      );
    }
    itemCount += rawItems.length;
    if (itemCount > MAX_HA_TODO_RESPONSE_ITEMS) {
      throw new Error(
        `todo response exceeded its ${MAX_HA_TODO_RESPONSE_ITEMS}-item limit`,
      );
    }
    for (const rawItem of rawItems) {
      items.push(parseTodoItem(
        entityId,
        listNames[entityId] ?? null,
        rawItem,
      ));
    }
  }
  return items;
}

function parseTodoItem(entityId: string, listName: string | null, value: unknown): HaTodoItem {
  const input = objectValue(value, `todo item for ${entityId}`);
  const summary = optionalStringValue(
    input.summary,
    `todo item summary for ${entityId}`,
  );
  if (!summary) {
    throw new Error(`todo item for ${entityId} must contain a summary`);
  }
  return {
    entityId,
    listName,
    summary,
    uid: optionalStringValue(input.uid, `todo item uid for ${entityId}`),
    status: optionalStringValue(
      input.status,
      `todo item status for ${entityId}`,
    ),
    due: firstOptionalTimestamp(
      input,
      ["due", "due_datetime", "due_date"],
      `todo item due for ${entityId}`,
    ),
    description: optionalStringValue(
      input.description,
      `todo item description for ${entityId}`,
    ),
  };
}

function firstOptionalTimestamp(
  input: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): string | null {
  for (const key of keys) {
    if (!Object.hasOwn(input, key)) {
      continue;
    }
    const timestamp = optionalStringValue(input[key], label);
    if (!timestamp) {
      continue;
    }
    if (!isValidHaTimestamp(timestamp, { allowDateOnly: true })) {
      throw new Error(`${label} must be an ISO-like timestamp`);
    }
    return timestamp;
  }
  return null;
}
