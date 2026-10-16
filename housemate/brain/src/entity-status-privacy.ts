import type { HaEntityState } from "./ha-state-cache.js";

export interface EntityLocationPrivacyContext {
  readonly knownPersonLabels: readonly string[];
  labelsForEntity(entityId: string): readonly string[];
}

interface EntityPrivacyRegistryEntry {
  readonly entityId: string;
  readonly domain: string;
  readonly name: string | null;
  readonly originalName: string | null;
  readonly deviceName: string | null;
}

interface EntityPrivacyRegistrySource {
  allEntities(): readonly EntityPrivacyRegistryEntry[];
}

interface EntityPrivacyAliasEntry {
  readonly alias: string;
  readonly target: {
    readonly kind: string;
    readonly entityId?: string;
    readonly entityIds?: readonly string[];
  };
}

/** Shared grammatical class for a person's location-bearing field. */
export const PERSON_LOCATION_FIELD_PATTERN_SOURCE =
  "(?:address|area|city|coordinates?|coords?|country|destination|district|elevation|geofence|latitude|lat|location|longitude|lon|place|position|presence|region|room|street|suburb|whereabouts|zone|altitude)";

/**
 * Build one turn-scoped privacy view from the same fresh sources used for
 * resolution. Area names are deliberately excluded: an entity merely being in
 * "the owner Room" must not make an ordinary temperature sensor personal.
 */
export function buildEntityLocationPrivacyContext(input: {
  readonly registry?: EntityPrivacyRegistrySource | null | undefined;
  readonly states?: Iterable<HaEntityState>;
  readonly aliases?: readonly EntityPrivacyAliasEntry[];
  readonly additionalKnownPersonEntityIds?: readonly string[];
  readonly additionalKnownPersonLabels?: readonly string[];
}): EntityLocationPrivacyContext {
  const registryEntities = input.registry?.allEntities() ?? [];
  const states = [...(input.states ?? [])];
  const aliases = input.aliases ?? [];
  const personEntityIds = new Set<string>([
    ...registryEntities
      .filter((entry) => entry.domain === "person")
      .map((entry) => entry.entityId),
    ...states
      .filter((state) => entityDomain(state.entityId) === "person")
      .map((state) => state.entityId),
    ...(input.additionalKnownPersonEntityIds ?? [])
      .filter((entityId) => entityDomain(entityId) === "person"),
  ]);
  const entityLabels = new Map<string, Set<string>>();
  const addEntityLabel = (entityId: string, label: string | null | undefined): void => {
    if (!label?.trim()) return;
    const labels = entityLabels.get(entityId) ?? new Set<string>();
    labels.add(label.trim());
    entityLabels.set(entityId, labels);
  };

  for (const entry of registryEntities) {
    addEntityLabel(entry.entityId, entry.name);
    addEntityLabel(entry.entityId, entry.originalName);
    addEntityLabel(entry.entityId, entry.deviceName);
  }
  for (const entry of aliases) {
    for (const entityId of aliasEntityIds(entry)) {
      addEntityLabel(entityId, entry.alias);
    }
  }

  const knownPersonLabels = new Set<string>(
    input.additionalKnownPersonLabels?.filter((label) => label.trim()) ?? [],
  );
  for (const entry of registryEntities) {
    if (entry.domain !== "person") continue;
    for (const label of [entry.entityId, entry.name, entry.originalName]) {
      if (label?.trim()) knownPersonLabels.add(label.trim());
    }
  }
  for (const state of states) {
    if (entityDomain(state.entityId) !== "person") continue;
    knownPersonLabels.add(state.entityId);
    const friendlyName = normalizedAttributeString(state.attributes.friendly_name);
    if (friendlyName) knownPersonLabels.add(friendlyName);
  }
  for (const entry of aliases) {
    if (aliasEntityIds(entry).some((entityId) =>
      personEntityIds.has(entityId) || entityDomain(entityId) === "person")) {
      knownPersonLabels.add(entry.alias);
    }
  }

  const frozenLabels = new Map(
    [...entityLabels].map(([entityId, labels]) => [
      entityId,
      Object.freeze([...labels]),
    ] as const),
  );
  return Object.freeze({
    knownPersonLabels: Object.freeze([...knownPersonLabels]),
    labelsForEntity: (entityId: string) => frozenLabels.get(entityId) ?? EMPTY_LABELS,
  });
}

/** One privacy boundary shared by legacy answers and typed candidate routing. */
export function isSensitiveLocationEntity(
  entityId: string,
  state: Pick<HaEntityState, "attributes"> | null,
  additionalLabels: readonly string[] = [],
  knownPersonLabels: readonly string[] = [],
): boolean {
  if (SENSITIVE_LOCATION_DOMAINS.has(entityDomain(entityId))) return true;
  const deviceClass = normalizedAttributeString(
    state?.attributes.device_class,
  );
  if (deviceClass && SENSITIVE_LOCATION_DEVICE_CLASSES.has(deviceClass)) return true;
  if (state && Object.keys(state.attributes).some(isLocationBearingAttributeKey)) {
    return true;
  }
  const friendlyName = normalizedAttributeString(
    state?.attributes.friendly_name,
  );
  const semanticLabels = [
    entityId,
    ...(friendlyName ? [friendlyName] : []),
    ...additionalLabels,
  ];
  return semanticLabels.some(isLocationBearingSemanticText)
    || (
      PERSON_LINKED_LOCATION_DOMAINS.has(entityDomain(entityId))
      && isKnownPersonLocationSemanticText(
        semanticLabels.join(" "),
        knownPersonLabels,
      )
    );
}

const SENSITIVE_LOCATION_DOMAINS = new Set([
  "device_tracker",
  "geo_location",
  "person",
  "proximity",
  "zone",
]);
const SENSITIVE_LOCATION_DEVICE_CLASSES = new Set(["geolocation", "gps", "location"]);
const LOCATION_ATTRIBUTE_TERMS = new Set([
  "address",
  "administrative_area",
  "coordinates",
  "formatted_address",
  "geocode",
  "geocoded_location",
  "gps_accuracy",
  "latitude",
  "locality",
  "location",
  "location_name",
  "longitude",
  "person_id",
  "persons",
  "place_name",
  "postal_code",
  "sub_administrative_area",
  "tracked_person",
  "zone_name",
]);
const LOCATION_SEMANTIC_TERMS = new Set([
  ...LOCATION_ATTRIBUTE_TERMS,
  "coord",
  "coordinate",
  "coords",
  "geocoded",
  "geolocation",
  "gps",
  "lat",
  "lng",
  "location",
  "locator",
  "lon",
  "postcode",
  "whereabouts",
]);
const PERSON_LINKED_LOCATION_TERMS = new Set([
  "area",
  "altitude",
  "away",
  "bearing",
  "city",
  "commute",
  "country",
  "destination",
  "district",
  "elevation",
  "geofence",
  "home",
  "occupancy",
  "occupied",
  "place",
  "position",
  "presence",
  "present",
  "region",
  "room",
  "street",
  "suburb",
  "tracker",
  "travel",
  "work",
  "zone",
]);
const PERSON_LINKED_LOCATION_DOMAINS = new Set([
  "binary_sensor",
  "counter",
  "input_boolean",
  "input_number",
  "number",
  "sensor",
]);
const NON_LOCATION_MEASUREMENT_TERMS = new Set([
  "battery",
  "carbon",
  "co2",
  "consumption",
  "current",
  "duration",
  "energy",
  "humidity",
  "illuminance",
  "light",
  "moisture",
  "power",
  "pressure",
  "runtime",
  "signal",
  "strength",
  "temp",
  "temperature",
  "usage",
  "voltage",
]);
const PERSON_LABEL_STOP_TERMS = new Set([
  "device",
  "entity",
  "home",
  "mobile",
  "person",
  "phone",
  "sensor",
  "tracker",
]);
const EMPTY_LABELS: readonly string[] = Object.freeze([]);

function aliasEntityIds(entry: EntityPrivacyAliasEntry): readonly string[] {
  if (entry.target.kind === "entity" && entry.target.entityId) {
    return [entry.target.entityId];
  }
  if (entry.target.kind === "group" && entry.target.entityIds) {
    return entry.target.entityIds;
  }
  return EMPTY_LABELS;
}

function isLocationBearingAttributeKey(key: string): boolean {
  const normalized = normalizeSemanticText(key);
  if (LOCATION_ATTRIBUTE_TERMS.has(normalized)) return true;
  return /(?:^|_)(?:latitude|longitude|location|address|coordinates|geocode)(?:_|$)/.test(normalized);
}

function isLocationBearingSemanticText(value: string): boolean {
  const normalized = normalizeSemanticText(value);
  const tokens = normalized.split("_").filter(Boolean);
  if (tokens.some((token) => LOCATION_SEMANTIC_TERMS.has(token))) {
    return true;
  }
  if (/(?:^|_)(?:distance_(?:to|from)|(?:home|person|zone)_distance)(?:_|$)/.test(normalized)) {
    return true;
  }
  return [
    "administrative_area",
    "distance_to_home",
    "formatted_address",
    "geocoded_location",
    "gps_accuracy",
    "location_name",
    "place_name",
    "postal_code",
    "sub_administrative_area",
    "tracked_person",
    "zone_name",
  ].some((term) => `_${normalized}_`.includes(`_${term}_`));
}

function isKnownPersonLocationSemanticText(
  value: string,
  knownPersonLabels: readonly string[],
): boolean {
  const tokens = new Set(normalizeSemanticText(value).split("_").filter(Boolean));
  if (![...tokens].some((token) => PERSON_LINKED_LOCATION_TERMS.has(token))) {
    return false;
  }
  if ([...tokens].some((token) => NON_LOCATION_MEASUREMENT_TERMS.has(token))) {
    return false;
  }
  return knownPersonLabels.some((label) =>
    normalizeSemanticText(label)
      .split("_")
      .filter((token) =>
        token.length >= 3
        && !PERSON_LABEL_STOP_TERMS.has(token))
      .some((token) => tokens.has(token)));
}

function normalizeSemanticText(value: string): string {
  return value
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizedAttributeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function entityDomain(entityId: string): string {
  return entityId.split(".", 1)[0]?.toLowerCase() ?? "";
}
