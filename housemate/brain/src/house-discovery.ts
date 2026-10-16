import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

import type { HaCommandClient } from "./ha-history.js";
import type { HaEntityState } from "./ha-state-cache.js";
import { discoveryFilePath, houseConfigPath, houseDataPath, setDiscoveredHouseSections } from "./house-config.js";
import { houseDiscoveryBody, type HouseDiscoveryBody } from "./house-discovery-view.js";
import { normalizeWords } from "./speech-normalizer.js";

/*
 * House discovery: anything the code path needs per house is set up
 * from the house's own Home Assistant, never from hand-made files a stranger would have to write.
 * At start and once a day the brain reads the Energy dashboard, the states and the registry and
 * the People page's links, and keeps what it found in `<dataDir>/auto/house-discovery.json`.
 * Every loader takes the hand-made file first (house.json and catchup-sources.json by top-level
 * section, house-metrics.json whole), then this, then nothing. Nothing is written into HA.
 */

export interface DiscoveredHouse {
  readonly version: 1;
  readonly discoveredAt: string;
  /** house.json sections, in its own shape (`left_open`, `vacuum`). */
  readonly house: Readonly<Record<string, unknown>>;
  /** A whole house-metrics.json, or null when the house has no Energy dashboard or power sensor. */
  readonly metrics: Readonly<Record<string, unknown>> | null;
  /** catchup-sources.json sections, in its own shape (`people`, `calendars`, `weatherEntityId`). */
  readonly catchup: Readonly<Record<string, unknown>>;
  /** Each Assist speaker (by its HA device) and the Music Assistant player its music plays on. */
  readonly speakers?: Readonly<Record<string, { readonly name: string; readonly player: string | null }>>;
  /** The owner's phone, for approval notifications (notify.mobile_app_<phone>). */
  readonly approvalPhone?: string | null;
}

export interface DiscoveryInput {
  readonly states: readonly HaEntityState[];
  /** The HA device an entity belongs to, from the entity registry. */
  readonly deviceOf: (entityId: string) => string | null;
  /** `energy/get_prefs`, or null when the house has no Energy dashboard. */
  readonly energyPrefs: unknown;
  /** The People page: each person with their linked HA person. */
  readonly people: readonly { readonly id: string; readonly name: string; readonly haPerson: string | null; readonly owner?: boolean }[];
  readonly now: Date;
  /** What the house picked on its House page; anything left out is found automatically. */
  readonly choices?: HouseChoices;
  /** The house's Assist speakers (HA device and its name) and Music Assistant players. */
  readonly speakers?: readonly { readonly device: string; readonly name: string }[];
  readonly musicPlayers?: readonly { readonly entityId: string; readonly name: string }[];
  /** True for a setting, diagnostic, hidden or disabled entity in the HA registry (never a real light). */
  readonly isSetting?: (entityId: string) => boolean;
  /** The integration an entity comes from, for sensors that belong to no HA device. */
  readonly platformOf?: (entityId: string) => string | null;
}

/**
 * The house's changes on the House page (`<dataDir>/house-choices.json`), kept as edits on top of
 * what discovery finds, so anything new is still added by itself. `power`, `houseEnergy` and
 * `vacuum` take an entity id or "none"; lists add and remove; devices are keyed by their Energy
 * dashboard sensor. Anything absent is automatic.
 */
export interface HouseChoices {
  readonly power?: string;
  readonly houseEnergy?: string;
  readonly vacuum?: string;
  readonly leftOpen?: ListEdits;
  readonly calendars?: ListEdits;
  readonly devices?: Readonly<Record<string, DeviceEdits>>;
  /** A speaker's music player (by the speaker's HA device): an entity id or "none". */
  readonly speakers?: Readonly<Record<string, string>>;
  /** The weather entity and the outside temperature and wind sensors: an entity id or "none". */
  readonly weather?: string;
  readonly outsideTemperature?: string;
  readonly outsideWind?: string;
  /** A monthly electricity budget in kWh. */
  readonly budgetKwh?: number;
  /** The solar panels' live power sensor: an entity id or "none". */
  readonly solarPower?: string;
}

export interface ListEdits {
  readonly add: readonly string[];
  readonly remove: readonly string[];
}

export interface DeviceEdits {
  /** Its power sensor, or "none". */
  readonly power?: string;
  /** Other names it answers to ("the fridge"). */
  readonly names?: readonly string[];
}

/** The House page as the house sees it: what is in use for each part (null: none). */
export interface HousePage {
  readonly power: string | null;
  readonly houseEnergy: string | null;
  readonly vacuum: string | null;
  readonly leftOpen: readonly string[];
  readonly calendars: readonly string[];
  readonly devices: Readonly<Record<string, { readonly power: string | null; readonly names: readonly string[] }>>;
  /** Each speaker's music player (null: none). */
  readonly speakers: Readonly<Record<string, string | null>>;
  readonly weather: string | null;
  readonly outsideTemperature: string | null;
  readonly outsideWind: string | null;
  /** The monthly electricity budget in kWh (null: none). */
  readonly budgetKwh: number | null;
  /** The solar panels' live power (null: none, or no solar). */
  readonly solarPower: string | null;
}

/** One thing the house can pick, as the page shows it. */
export interface HouseOption {
  readonly id: string;
  readonly name: string;
  /** The live reading, for power sensors ("340 W"). */
  readonly value?: string;
}

export interface HouseOptions {
  readonly power: readonly HouseOption[];
  readonly energy: readonly HouseOption[];
  readonly vacuums: readonly HouseOption[];
  readonly openings: readonly HouseOption[];
  readonly calendars: readonly HouseOption[];
  readonly musicPlayers: readonly HouseOption[];
  readonly weathers: readonly HouseOption[];
  readonly temperatures: readonly HouseOption[];
  readonly winds: readonly HouseOption[];
}

// --- The store ---------------------------------------------------------------------

let loaded: DiscoveredHouse | null | undefined;
let revision = 0;

/** What discovery found last (read once from its file), or null before the first run. */
export function discoveredHouse(): DiscoveredHouse | null {
  if (loaded === undefined) {
    try {
      const value = JSON.parse(readFileSync(discoveryFilePath(), "utf8")) as DiscoveredHouse;
      loaded = value && value.version === 1 ? value : null;
    } catch {
      loaded = null;
    }
  }
  return loaded;
}

/** Bumped whenever discovery changes, so the loaders rebuild from it. */
export function discoveryRevision(): number {
  return revision;
}

export function saveDiscoveredHouse(found: DiscoveredHouse): void {
  const file = discoveryFilePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(found, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  useDiscoveredHouse(found);
}

/** Uses a discovery without writing it (tests): null forgets it, undefined reads its file again. */
export function useDiscoveredHouse(found: DiscoveredHouse | null | undefined): void {
  loaded = found;
  revision += 1;
  setDiscoveredHouseSections(found === undefined ? undefined : found?.house ?? null);
}

// --- Discovery ---------------------------------------------------------------------

export function discoverHouse(input: DiscoveryInput): DiscoveredHouse {
  const states = new Map(input.states.map((state) => [state.entityId, state]));
  return {
    version: 1,
    discoveredAt: input.now.toISOString(),
    house: {
      ...leftOpenSection(input.states, input.choices?.leftOpen),
      ...vacuumSection(input.states, input.choices?.vacuum),
      ...weatherSection(input),
      ...lightsSection(input),
      ...rechargeableSection(input),
      ...(input.choices?.budgetKwh ? { energy: { monthly_budget_kwh: input.choices.budgetKwh } } : {}),
    },
    metrics: metricCatalog(input, states),
    catchup: catchupSections(input),
    speakers: speakerPlayers(input),
    approvalPhone: ownerPhone(input),
  };
}

/** The owner's phone's notify service: the mobile-app phone their HA person tracks (one, or none). */
function ownerPhone(input: DiscoveryInput): string | null {
  const owner = input.people.find((person) => person.owner && person.haPerson);
  const person = owner ? input.states.find((state) => state.entityId === owner.haPerson) : undefined;
  const trackers = Array.isArray(person?.attributes.device_trackers) ? person.attributes.device_trackers.filter((id): id is string => typeof id === "string") : [];
  const phones = trackers.filter((id) => id.startsWith("device_tracker.") && (input.platformOf?.(id) ?? "mobile_app") === "mobile_app");
  return phones.length === 1 ? `notify.mobile_app_${(phones[0] as string).slice("device_tracker.".length)}` : null;
}

/**
 * Each Assist speaker's music player: the Music Assistant player named like the speaker's device
 * (Music Assistant names a player after the speaker it plays on), or the house's pick.
 */
function speakerPlayers(input: DiscoveryInput): Record<string, { name: string; player: string | null }> {
  const key = (name: string): string => normalizeWords(name);
  return Object.fromEntries((input.speakers ?? []).map((speaker) => {
    const picked = input.choices?.speakers?.[speaker.device];
    const found = (input.musicPlayers ?? []).find((player) => key(player.name) === key(speaker.name))?.entityId ?? null;
    return [speaker.device, { name: speaker.name, player: picked === "none" ? null : picked ?? found }];
  }));
}

/** The music player for an Assist speaker's turn (`assist-<HA device>`), as discovery and the House page set it. */
export function speakerPlayerFor(endpointId: string): string | null {
  if (!endpointId.startsWith("assist-")) return null;
  return discoveredHouse()?.speakers?.[endpointId.slice("assist-".length)]?.player ?? null;
}

/** Locks left unlocked and garage doors left open, with the house's own additions and removals. */
function leftOpenSection(states: readonly HaEntityState[], edits: ListEdits | undefined): Record<string, unknown> {
  const watches = states.flatMap((state) => {
    const watch = openingWatch(state);
    if (!watch || edits?.remove.includes(state.entityId)) return [];
    // By itself: locks and garages; doors and windows when the house adds them.
    const automatic = state.entityId.startsWith("lock.") || ["garage_door", "garage", "gate"].includes(String(state.attributes.device_class));
    return automatic || edits?.add.includes(state.entityId) ? [watch] : [];
  });
  return watches.length > 0 ? { left_open: watches } : {};
}

/** How an opening is watched: what "left open" is for it, and how it is said. */
function openingWatch(state: HaEntityState): { entity: string; open_state: string; text: string } | null {
  const name = openingName(state);
  const deviceClass = String(state.attributes.device_class ?? "");
  if (state.entityId.startsWith("lock.")) return { entity: state.entityId, open_state: "unlocked", text: `the ${name} is unlocked` };
  if (state.entityId.startsWith("binary_sensor.") && ["door", "garage_door", "window"].includes(deviceClass)) return { entity: state.entityId, open_state: "on", text: `the ${name} is open` };
  if (state.entityId.startsWith("cover.") && ["door", "garage", "gate", "window"].includes(deviceClass)) return { entity: state.entityId, open_state: "open", text: `the ${name} is open` };
  return null;
}

/** The house's one robot vacuum (with two or more, none is guessed), or the one it picked. */
function vacuumSection(states: readonly HaEntityState[], picked: string | undefined): Record<string, unknown> {
  if (picked === "none") return {};
  const vacuums = states.filter((state) => state.entityId.startsWith("vacuum.") && (!picked || state.entityId === picked));
  if (vacuums.length !== 1) return {};
  const vacuum = vacuums[0] as HaEntityState;
  const name = friendly(vacuum);
  return { vacuum: { entity: vacuum.entityId, names: name && name !== "vacuum" ? [name] : [] } };
}

/** The house's weather entity: weather.home, else the first that is not an hourly one (or the house's pick). */
function houseWeather(input: DiscoveryInput): string | null {
  const picked = input.choices?.weather;
  if (picked === "none") return null;
  const weather = input.states.filter((state) => state.entityId.startsWith("weather."));
  if (picked && weather.some((state) => state.entityId === picked)) return picked;
  return (weather.find((state) => state.entityId === "weather.home")
    ?? weather.find((state) => !/\bhourly\b/i.test(friendly(state)))
    ?? weather[0])?.entityId ?? null;
}

/** The weather entity, an hourly one, a Bureau-style sensor family, and the outside temperature and wind. */
function weatherSection(input: DiscoveryInput): Record<string, unknown> {
  const states = input.states;
  const outside = (deviceClass: string): string | null => states
    .filter((state) => state.entityId.startsWith("sensor.") && state.attributes.device_class === deviceClass
      && /\b(?:outside|outdoor|outdoors|exterior|external)\b/i.test(`${friendly(state)} ${state.entityId.replace(/[._]/g, " ")}`))
    .map((state) => state.entityId).sort()[0] ?? null;
  const pick = (key: "outsideTemperature" | "outsideWind", found: string | null): string | null => {
    const picked = input.choices?.[key];
    return picked === "none" ? null : picked && states.some((state) => state.entityId === picked) ? picked : found;
  };
  // A Bureau of Meteorology style family: sensor.<place>_temp_feels_like beside sensor.<place>_temp.
  const prefix = states.map((state) => /^(sensor\.[a-z0-9_]+)_temp_feels_like$/.exec(state.entityId)?.[1])
    .find((family) => family && states.some((state) => state.entityId === `${family}_temp`)) ?? null;
  const entity = houseWeather(input);
  const hourly = states.find((state) => state.entityId.startsWith("weather.") && /\bhourly\b/i.test(friendly(state)))?.entityId ?? null;
  const weather = {
    ...(entity ? { entity } : {}),
    ...(hourly ? { hourly_entity: hourly } : {}),
    ...(prefix ? { sensor_prefix: prefix } : {}),
    ...(pick("outsideTemperature", outside("temperature")) ? { outside_temperature: pick("outsideTemperature", outside("temperature")) } : {}),
    ...(pick("outsideWind", outside("wind_speed")) ? { outside_wind_speed: pick("outsideWind", outside("wind_speed")) } : {}),
  };
  return Object.keys(weather).length ? { weather } : {};
}

/** Lights whose names don't say "light" (a strip, a WLED) still count as lights; settings never do. */
function lightsSection(input: DiscoveryInput): Record<string, unknown> {
  const also = input.states
    .filter((state) => state.entityId.startsWith("light.") && !input.isSetting?.(state.entityId)
      && !/\blights?\b/i.test(friendly(state)) && !/\b(?:all|ring|screen|led|indicator|notification|status|backlight|dnd)\b/i.test(friendly(state)))
    .map((state) => state.entityId).sort();
  return also.length ? { lights: { also_lights: also } } : {};
}

/**
 * Batteries that charge themselves, so they are never "time to replace the battery": phones and
 * tablets already, plus any battery on a device that reports charging, a robot vacuum, or the
 * house's home battery (on the Energy dashboard).
 */
function rechargeableSection(input: DiscoveryInput): Record<string, unknown> {
  const charging = new Set(input.states.flatMap((state) => {
    const device = input.deviceOf(state.entityId);
    const charges = state.attributes.device_class === "battery_charging" || /(?:charging|battery_state|charger)/.test(state.entityId) || state.entityId.startsWith("vacuum.");
    return device && charges ? [device] : [];
  }));
  const prefs = record(input.energyPrefs);
  for (const source of list(prefs.energy_sources).map(record).filter((item) => item.type === "battery")) {
    for (const id of [text(source.stat_energy_from), text(source.stat_energy_to)]) {
      const device = id ? input.deviceOf(id) : null;
      if (device) charging.add(device);
    }
  }
  const batteries = input.states
    .filter((state) => state.entityId.startsWith("sensor.") && state.attributes.device_class === "battery")
    .filter((state) => { const device = input.deviceOf(state.entityId); return device !== null && charging.has(device); })
    .map((state) => state.entityId.replace(/\./g, "\\.")).sort();
  return batteries.length ? { rechargeable_words: batteries } : {};
}

function catchupSections(input: DiscoveryInput): Record<string, unknown> {
  const people = Object.fromEntries(input.people.flatMap((person) => (
    person.haPerson ? [[person.id, { entityId: person.haPerson, label: person.name }]] : []
  )));
  const calendars = input.states.map((state) => state.entityId)
    .filter((id) => id.startsWith("calendar.") && !input.choices?.calendars?.remove.includes(id)).sort();
  const weatherEntity = houseWeather(input);
  return {
    ...(Object.keys(people).length > 0 ? { people } : {}),
    ...(calendars.length > 0 ? { calendars } : {}),
    ...(weatherEntity ? { weatherEntityId: weatherEntity } : {}),
  };
}

// --- Power and energy --------------------------------------------------------------

interface RawMetric {
  id: string;
  label: string;
  kind: "energy" | "power" | "water" | "gas";
  scope: "house" | "source" | "device" | "derived";
  source: "ha_energy_dashboard" | "live_helper" | "derived";
  unit: string;
  aliases: string[];
  entityId?: string;
  statisticId?: string;
  relatedPowerEntityId?: string;
  fallbackEntityIds?: string[];
  components?: { metricId: string; operation: "add" | "subtract" }[];
}

const ALIASES: Readonly<Record<string, readonly string[]>> = {
  house_consumption_energy: ["house energy", "house consumption", "home consumption", "total house energy", "house use", "house used", "house consumed", "home energy use", "total power consumed"],
  house_current_power: ["house power", "current house power", "home power", "house load", "current load", "power now", "home electricity", "household electricity", "whole house power"],
  grid_import_energy: ["grid import", "imported energy", "grid consumption", "electricity imported", "import from grid"],
  grid_export_energy: ["grid export", "exported energy", "energy returned", "electricity exported", "feed in"],
  grid_net_import_energy: ["net grid", "net grid import", "grid net", "net electricity imported"],
  battery_discharge_energy: ["battery discharge", "battery output", "battery used"],
  battery_charge_energy: ["battery charge", "battery input", "battery charged"],
  solar_total_energy: ["solar", "solar energy", "solar generated", "solar production", "pv total", "solar panel", "solar panels", "panels", "pv"],
  water_usage: ["water", "water usage", "water consumed"],
  gas_usage: ["gas", "gas usage", "gas consumed"],
};

const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;

function metricCatalog(input: DiscoveryInput, states: ReadonlyMap<string, HaEntityState>): Record<string, unknown> | null {
  const prefs = record(input.energyPrefs);
  const sources = Array.isArray(prefs.energy_sources) ? prefs.energy_sources.map(record) : [];
  const devices = Array.isArray(prefs.device_consumption) ? prefs.device_consumption.map(record) : [];
  const metrics: RawMetric[] = [];
  const unitOf = (id: string, fallback: string): string => text(states.get(id)?.attributes.unit_of_measurement) ?? fallback;
  const add = (metric: RawMetric): void => { metrics.push(metric); };
  const energy = (id: string, label: string, statistic: string, scope: RawMetric["scope"], power: string | null): void => add({
    id, label, kind: "energy", scope, source: "ha_energy_dashboard", unit: unitOf(statistic, "kWh"), aliases: [...(ALIASES[id] ?? [])],
    entityId: statistic, statisticId: statistic, ...(power ? { relatedPowerEntityId: power } : {}),
  });

  // Older dashboards list the grid's meters under flow_from / flow_to; newer ones name them directly.
  const grid = sources.filter((source) => source.type === "grid");
  const gridIn = grid.flatMap((source) => [text(source.stat_energy_from), ...list(source.flow_from).map((flow) => text(record(flow).stat_energy_from))]).filter(isEntity);
  const gridOut = grid.flatMap((source) => [text(source.stat_energy_to), ...list(source.flow_to).map((flow) => text(record(flow).stat_energy_to))]).filter(isEntity);
  const solar = sources.filter((source) => source.type === "solar").map((source) => text(source.stat_energy_from)).filter(isEntity);
  const battery = sources.filter((source) => source.type === "battery");
  const batteryOut = battery.map((source) => text(source.stat_energy_from)).filter(isEntity);
  const batteryIn = battery.map((source) => text(source.stat_energy_to)).filter(isEntity);
  const water = sources.filter((source) => source.type === "water").map((source) => text(source.stat_energy_from)).filter(isEntity);
  const gas = sources.filter((source) => source.type === "gas").map((source) => text(source.stat_energy_from)).filter(isEntity);

  if (gridIn[0]) energy("grid_import_energy", "Grid import energy", gridIn[0], "source", null);
  if (gridOut[0]) energy("grid_export_energy", "Grid export energy", gridOut[0], "source", null);
  if (gridIn[0] && gridOut[0]) {
    add({ id: "grid_net_import_energy", label: "Grid net import energy", kind: "energy", scope: "derived", source: "derived", unit: "kWh",
      aliases: [...(ALIASES.grid_net_import_energy ?? [])],
      components: [{ metricId: "grid_import_energy", operation: "add" }, { metricId: "grid_export_energy", operation: "subtract" }] });
  }
  if (batteryOut[0]) energy("battery_discharge_energy", "Battery discharge energy", batteryOut[0], "source", powerBeside(batteryOut[0], input, states, /\bdischarg/));
  if (batteryIn[0]) energy("battery_charge_energy", "Battery charge energy", batteryIn[0], "source", powerBeside(batteryIn[0], input, states, /(?<!dis)\bcharg|\bbat(?:tery)?\s+charge\b/));
  const solarPick = input.choices?.solarPower;
  const solarPower = (found: string | null): string | null => solarPick === "none" ? null : solarPick && states.has(solarPick) ? solarPick : found;
  if (solar.length === 1) {
    energy("solar_total_energy", "Solar total energy", solar[0] as string, "source", solarPower(powerBeside(solar[0] as string, input, states, /\b(?:pv|solar)\b/) ?? onlyPower(input.states, /\b(?:pv|solar)\b(?!\s*\d)/)));
  } else if (solar.length > 1) {
    solar.forEach((id, index) => energy(`solar_${index + 1}_energy`, `Solar ${index + 1} energy`, id, "source", null));
    // The panels' total live power: the one PV power sensor beside a string meter that isn't a single string's.
    const total = solarPower(solar.map((id) => powerBeside(id, input, states, /\b(?:pv|solar)\b(?!\s*\d)/)).find(Boolean) ?? onlyPower(input.states, /\b(?:pv|solar)\b(?!\s*\d)/));
    add({ id: "solar_total_energy", label: "Solar total energy", kind: "energy", scope: "derived", source: "derived", unit: "kWh",
      aliases: [...(ALIASES.solar_total_energy ?? [])],
      ...(total ? { relatedPowerEntityId: total } : {}),
      components: solar.map((_id, index) => ({ metricId: `solar_${index + 1}_energy`, operation: "add" as const })) });
  }
  if (water[0]) add({ id: "water_usage", label: "Water usage", kind: "water", scope: "source", source: "ha_energy_dashboard", unit: unitOf(water[0], "L"), aliases: [...(ALIASES.water_usage ?? [])], entityId: water[0], statisticId: water[0] });
  if (gas[0]) add({ id: "gas_usage", label: "Gas usage", kind: "gas", scope: "source", source: "ha_energy_dashboard", unit: unitOf(gas[0], "m³"), aliases: [...(ALIASES.gas_usage ?? [])], entityId: gas[0], statisticId: gas[0] });

  // Each device on the dashboard, with the power sensor the dashboard itself names for it.
  const deviceIds = new Set<string>();
  for (const device of devices) {
    const statistic = text(device.stat_consumption);
    if (!isEntity(statistic)) continue;
    const name = text(device.name) ?? friendly(states.get(statistic)).replace(/\s+energy$/i, "");
    if (!name) continue;
    let id = `device_${slug(name)}_energy`;
    for (let n = 2; deviceIds.has(id); n += 1) id = `device_${slug(name)}_${n}_energy`;
    deviceIds.add(id);
    const edits = input.choices?.devices?.[statistic];
    const power = edits?.power === "none" ? null : edits?.power ?? text(device.stat_rate);
    add({ id, label: name, kind: "energy", scope: "device", source: "ha_energy_dashboard", unit: unitOf(statistic, "kWh"),
      aliases: [name.toLowerCase(), `${name.toLowerCase()} power`, `${name.toLowerCase()} energy`, `${name.toLowerCase()} usage`, ...(edits?.names ?? []).map((alias) => alias.toLowerCase())],
      entityId: statistic, statisticId: statistic, ...(isEntity(power) ? { relatedPowerEntityId: power } : {}) });
  }

  // The whole house: a sensor that says it is the house's, else (no solar, no battery) the grid meter's own power.
  const gridPower = solar.length === 0 && batteryOut.length === 0 && gridIn[0] ? powerBeside(gridIn[0], input, states) : null;
  const housePower = houseSensors(input.states, "power");
  const picked = input.choices?.power;
  const powerIds = picked === "none" ? [] : picked && states.has(picked) ? [picked] : housePower.length > 0 ? housePower : gridPower ? [gridPower] : [];
  if (powerIds[0]) {
    add({ id: "house_current_power", label: "House current power", kind: "power", scope: "house", source: "live_helper", unit: unitOf(powerIds[0], "W"),
      aliases: [...(ALIASES.house_current_power ?? [])], entityId: powerIds[0], statisticId: powerIds[0],
      ...(powerIds.length > 1 ? { fallbackEntityIds: powerIds.slice(1) } : {}) });
  }
  const energyPick = input.choices?.houseEnergy;
  const houseEnergy = energyPick === "none" ? [] : energyPick && states.has(energyPick) ? [energyPick] : houseSensors(input.states, "energy");
  // "none": no sensor of its own, so it is worked out from the meters.
  if (houseEnergy[0]) {
    add({ id: "house_consumption_energy", label: "House consumption energy", kind: "energy", scope: "house", source: "live_helper", unit: unitOf(houseEnergy[0], "kWh"),
      aliases: [...(ALIASES.house_consumption_energy ?? [])], entityId: houseEnergy[0], statisticId: houseEnergy[0],
      ...(houseEnergy.length > 1 ? { fallbackEntityIds: houseEnergy.slice(1) } : {}) });
  } else if (gridIn[0]) {
    // What the house used: from the grid, plus the sun and the battery, less what went back.
    const has = (id: string): boolean => metrics.some((metric) => metric.id === id);
    add({ id: "house_consumption_energy", label: "House consumption energy", kind: "energy", scope: "derived", source: "derived", unit: "kWh",
      aliases: [...(ALIASES.house_consumption_energy ?? [])],
      components: [
        { metricId: "grid_import_energy", operation: "add" },
        ...(has("grid_export_energy") ? [{ metricId: "grid_export_energy", operation: "subtract" as const }] : []),
        ...(has("solar_total_energy") ? [{ metricId: "solar_total_energy", operation: "add" as const }] : []),
        ...(has("battery_discharge_energy") ? [{ metricId: "battery_discharge_energy", operation: "add" as const }] : []),
        ...(has("battery_charge_energy") ? [{ metricId: "battery_charge_energy", operation: "subtract" as const }] : []),
      ] });
  }
  if (metrics.length === 0) return null;
  return {
    schemaVersion: 1,
    source: "house_discovery",
    sourceRef: "energy/get_prefs",
    notes: ["Built by house discovery from the Home Assistant Energy dashboard and live states."],
    metrics: uniqueNames(metrics),
  };
}

/**
 * Sensors whose names say they are the whole house's ("Home consumption power", "House load"),
 * best first: a house often has two (the inverter's and the meter's), the first answers and the
 * rest stand in when it is down. Names that say "consumption" or "load" beat a bare "house power".
 */
function houseSensors(states: readonly HaEntityState[], kind: "power" | "energy"): string[] {
  const words = (state: HaEntityState): string => `${friendly(state)} ${state.entityId.replace(/[._]/g, " ")}`;
  return states
    .filter((state) => (
      state.entityId.startsWith("sensor.")
      && state.attributes.device_class === kind
      && /\b(?:home|house|household|whole house)\s+(?:consumption|load|usage|use|power|energy)\b/i.test(words(state))
      && !/\b(?:export|returned|feed in|solar|pv|battery|grid|lights?|lighting)\b/i.test(words(state))
    ))
    .map((state) => ({ id: state.entityId, rank: /\b(?:consumption|load)\b/i.test(words(state)) ? 0 : 1 }))
    .sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id))
    .map((item) => item.id);
}

/**
 * The power sensor on the same HA device as an energy meter (not the export side). A device with
 * several (an inverter: battery, solar, grid, load) gives the one its role names, when only one does.
 */
function powerBeside(energyId: string, input: DiscoveryInput, states: ReadonlyMap<string, HaEntityState>, role?: RegExp): string | null {
  // Its HA device, else (sensors with no device) the integration they come from.
  const group = (entityId: string): string | null => input.deviceOf(entityId) ?? (input.platformOf?.(entityId) ? `platform:${input.platformOf(entityId)}` : null);
  const device = group(energyId);
  if (!device) return null;
  const words = (state: HaEntityState): string => `${friendly(state)} ${state.entityId.replace(/[._]/g, " ")}`.toLowerCase();
  const powers = [...states.values()].filter((state) => (
    state.entityId.startsWith("sensor.")
    && state.attributes.device_class === "power"
    && group(state.entityId) === device
    && !/\b(?:export|returned|reactive|apparent)\b/i.test(words(state))
  ));
  if (powers.length === 1) return (powers[0] as HaEntityState).entityId;
  const named = role ? powers.filter((state) => role.test(words(state))) : [];
  return named.length === 1 ? (named[0] as HaEntityState).entityId : null;
}

/** The one power sensor in the house whose name says what it is, or null when none or several do. */
function onlyPower(states: readonly HaEntityState[], role: RegExp): string | null {
  const named = states.filter((state) => {
    const words = `${friendly(state)} ${state.entityId.replace(/[._]/g, " ")}`.toLowerCase();
    return state.entityId.startsWith("sensor.") && state.attributes.device_class === "power" && role.test(words)
      && !/\b(?:forecast|estimated|peak|predicted|tomorrow)\b/.test(words);
  });
  return named.length === 1 ? (named[0] as HaEntityState).entityId : null;
}

/** Labels and aliases must each name one metric: a later clash is dropped (a label gets " device"). */
function uniqueNames(metrics: readonly RawMetric[]): RawMetric[] {
  const seen = new Set<string>();
  return metrics.map((metric) => {
    let label = metric.label;
    if (seen.has(normalizeWords(label))) label = `${label} device`;
    seen.add(normalizeWords(label));
    const aliases = metric.aliases.filter((alias) => {
      const key = normalizeWords(alias);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...metric, label, aliases };
  });
}

/** How it is said: its HA name in lower case, each word once (HA often repeats the device's name: "Front Door Lock Front Door"). */
function friendly(state: HaEntityState | undefined): string {
  const name = (text(state?.attributes.friendly_name) ?? state?.entityId.split(".")[1]?.replace(/_/g, " ") ?? "").toLowerCase();
  return [...new Set(name.split(/\s+/).filter(Boolean))].join(" ");
}

/** A door or lock as said in a sentence: "the garage door", not "the garage door sensor". */
function openingName(state: HaEntityState): string {
  return friendly(state).replace(/\s+(?:sensor|contact|status)$/, "") || friendly(state);
}

function slug(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "device";
}

function isEntity(value: string | null | undefined): value is string {
  return typeof value === "string" && ENTITY_ID.test(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// --- The runner --------------------------------------------------------------------

export interface HouseDiscoveryOptions {
  readonly client: () => HaCommandClient;
  readonly states: () => readonly HaEntityState[];
  readonly deviceOf: (entityId: string) => string | null;
  readonly people: () => DiscoveryInput["people"];
  /** The house's Assist speakers and Music Assistant players (from the HA registry). */
  readonly speakers?: () => NonNullable<DiscoveryInput["speakers"]>;
  readonly musicPlayers?: () => NonNullable<DiscoveryInput["musicPlayers"]>;
  readonly isSetting?: (entityId: string) => boolean;
  readonly platformOf?: (entityId: string) => string | null;
  readonly now: () => Date;
  readonly log: (line: string) => void;
}

export const HOUSE_DISCOVERY_EVERY_MS = 24 * 60 * 60_000;

/** The house as Home Assistant shows it now, with the house's saved changes. */
async function lookInput(options: HouseDiscoveryOptions): Promise<DiscoveryInput> {
  let energyPrefs: unknown = null;
  try {
    energyPrefs = await options.client().sendCommand({ type: "energy/get_prefs" });
  } catch {
    // No Energy dashboard yet: no power or energy metrics.
  }
  return {
    states: options.states(), deviceOf: options.deviceOf, energyPrefs, people: options.people(), now: options.now(), choices: readHouseChoices(),
    speakers: options.speakers?.() ?? [], musicPlayers: options.musicPlayers?.() ?? [],
    ...(options.isSetting ? { isSetting: options.isSetting } : {}),
    ...(options.platformOf ? { platformOf: options.platformOf } : {}),
  };
}

/** Looks at the house now, keeps what it found, and says what that was. */
export async function runHouseDiscovery(options: HouseDiscoveryOptions): Promise<DiscoveredHouse> {
  return keep(discoverHouse(await lookInput(options)), options);
}

/**
 * A House page save: the page says what it wants in use; what differs from what discovery would
 * pick by itself is kept as the house's changes, and every change goes to the log.
 */
export async function saveHousePage(options: HouseDiscoveryOptions, raw: unknown): Promise<DiscoveredHouse> {
  const input = await lookInput(options);
  const automatic = pageValues(discoverHouse({ ...input, choices: {} }));
  const houseOptionsNow = houseOptions(input.states, input.musicPlayers);
  const current = inUse(discoverHouse(input));
  const before = pageValues(current.view);
  const wanted = checkedPage(raw, houseOptionsNow, before.devices, new Set([...Object.keys(automatic.devices), ...Object.keys(before.devices)]), before.speakers, before);
  // A part set up by hand that the page changed moves onto the page (its file kept as a backup);
  // one left alone stays by hand, with nothing kept for it here.
  const kept: Record<string, unknown> = {};
  for (const [part, keys] of PAGE_PARTS) {
    if (!current.handMade[part]) continue;
    if (keys.some((key) => JSON.stringify(before[key]) !== JSON.stringify(wanted[key]))) {
      options.log(`House page: ${PART_NAMES[part]} now set on the page (the hand-made file is kept as ${retireOwnPart(part, options.now())})`);
    } else {
      for (const key of keys) kept[key] = automatic[key];
    }
  }
  const choices = editsFromPage({ ...wanted, ...kept } as HousePage, automatic);
  saveHouseChoices(choices);
  for (const line of describePageChange(before, wanted, houseOptionsNow, current.view)) options.log(line);
  return keep(discoverHouse({ ...input, choices }), options);
}

/** The page's parts that can be set up by hand, and the values each covers. */
const PAGE_PARTS: readonly (readonly [Exclude<keyof HandMade, "people">, readonly (keyof HousePage)[]])[] = [
  ["power", ["power", "houseEnergy", "devices", "solarPower"]],
  ["leftOpen", ["leftOpen"]],
  ["vacuum", ["vacuum"]],
  ["calendars", ["calendars"]],
  ["weather", ["weather", "outsideTemperature", "outsideWind"]],
  ["budget", ["budgetKwh"]],
];
const PART_NAMES: Readonly<Record<string, string>> = { power: "power and devices", leftOpen: "doors and locks", vacuum: "robot vacuum", calendars: "calendars", weather: "weather", budget: "electricity budget" };

/** A part leaves the house's own file, which is kept first as `<file>.bak-<time>`; returns that backup's name. */
function retireOwnPart(part: Exclude<keyof HandMade, "people">, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15);
  if (part === "power") {
    const file = houseDataPath("house-metrics.json", "JARVIS_V5_HOUSE_METRICS_FILE");
    renameSync(file, `${file}.bak-${stamp}`);
    return `${basename(file)}.bak-${stamp}`;
  }
  const file = part === "calendars" ? houseDataPath("catchup-sources.json", "JARVIS_V5_CATCHUP_SOURCES_FILE") : houseConfigPath();
  const key = part === "leftOpen" ? "left_open" : part === "budget" ? "energy" : part;
  copyFileSync(file, `${file}.bak-${stamp}`);
  const { [key]: _moved, ...rest } = record(JSON.parse(readFileSync(file, "utf8")));
  writeFileSync(`${file}.tmp`, `${JSON.stringify(rest, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  return `${basename(file)}.bak-${stamp}`;
}

function keep(found: DiscoveredHouse, options: HouseDiscoveryOptions): DiscoveredHouse {
  saveDiscoveredHouse(found);
  options.log(`house discovery: ${discoverySummary(found)}`);
  options.log(`house settings: ${houseSettingsLine(houseDiscoveryBody(found, { choices: readHouseChoices(), options: houseOptions(options.states(), options.musicPlayers?.() ?? []) }))}`);
  return found;
}

/** Once at start (when Home Assistant is up) and then every day. */
export function startHouseDiscovery(ready: Promise<unknown>, options: HouseDiscoveryOptions): void {
  const run = (): void => {
    void runHouseDiscovery(options).catch((error: unknown) => options.log(`house discovery failed, keeping the last: ${error instanceof Error ? error.message : String(error)}`));
  };
  void ready.then(() => {
    run();
    setInterval(run, HOUSE_DISCOVERY_EVERY_MS).unref();
  }, () => undefined);
}

/** What each part uses now and whether that is by itself, changed on the page, or set up by hand. */
export function houseSettingsLine(body: HouseDiscoveryBody): string {
  const how = (handMade: boolean, changed: boolean): string => handMade ? "set up by hand" : changed ? "changed" : "automatic";
  const one = (value: string | null): string => value ?? "none";
  return [
    `power ${one(body.page.power)} (${how(body.handMade.power, body.choices.power !== undefined)})`,
    `house energy ${body.page.houseEnergy ?? "from the meters"} (${how(body.handMade.power, body.choices.houseEnergy !== undefined)})`,
    `${Object.keys(body.page.devices).length} devices (${how(body.handMade.power, body.choices.devices !== undefined)})`,
    `${body.page.leftOpen.length} doors and locks (${how(body.handMade.leftOpen, body.choices.leftOpen !== undefined)})`,
    `vacuum ${one(body.page.vacuum)} (${how(body.handMade.vacuum, body.choices.vacuum !== undefined)})`,
    `${body.people.length} people (${how(body.handMade.people, false)})`,
    `${body.page.calendars.length} calendars (${how(body.handMade.calendars, body.choices.calendars !== undefined)})`,
  ].join(", ");
}

export function discoverySummary(found: DiscoveredHouse): string {
  const metrics = Array.isArray(found.metrics?.metrics) ? found.metrics.metrics as { scope?: string; id?: string }[] : [];
  const leftOpen = Array.isArray(found.house.left_open) ? found.house.left_open.length : 0;
  const people = Object.keys(record(found.catchup.people)).length;
  const calendars = Array.isArray(found.catchup.calendars) ? found.catchup.calendars.length : 0;
  return [
    `${metrics.filter((metric) => metric.scope === "device").length} devices on the Energy dashboard`,
    metrics.some((metric) => metric.id === "house_current_power") ? "house power found" : "no house power sensor",
    `${leftOpen} doors and locks to watch`,
    record(found.house.vacuum).entity ? "a vacuum" : "no vacuum",
    `${people} linked people`,
    `${calendars} calendars`,
  ].join(", ");
}

// --- The House page ----------------------------------------------------------------

export function houseChoicesPath(): string {
  return houseDataPath("house-choices.json", "JARVIS_V5_HOUSE_CHOICES_FILE");
}

export function readHouseChoices(): HouseChoices {
  try {
    return checkedChoices(JSON.parse(readFileSync(houseChoicesPath(), "utf8")));
  } catch {
    return {};
  }
}

export function saveHouseChoices(choices: HouseChoices): void {
  const file = houseChoicesPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(choices, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/** What the page can offer: every power and energy sensor (with its reading), vacuum, door, window, lock and calendar. */
export function houseOptions(states: readonly HaEntityState[], musicPlayers: readonly { readonly entityId: string; readonly name: string }[] = []): HouseOptions {
  const option = (state: HaEntityState): HouseOption => ({
    id: state.entityId,
    name: displayName(state),
    ...(Number.isFinite(Number(state.state)) && state.entityId.startsWith("sensor.") ? { value: `${state.state} ${text(state.attributes.unit_of_measurement) ?? ""}`.trim() } : {}),
  });
  const sorted = (items: HouseOption[]): HouseOption[] => items.sort((left, right) => left.name.localeCompare(right.name));
  const sensors = (deviceClass: string): HouseOption[] => sorted(states.filter((state) => state.entityId.startsWith("sensor.") && state.attributes.device_class === deviceClass).map(option));
  return {
    power: sensors("power"),
    energy: sensors("energy"),
    vacuums: sorted(states.filter((state) => state.entityId.startsWith("vacuum.")).map(option)),
    openings: sorted(states.filter((state) => openingWatch(state) !== null).map(option)),
    calendars: sorted(states.filter((state) => state.entityId.startsWith("calendar.")).map(option)),
    musicPlayers: sorted(musicPlayers.map((player) => ({ id: player.entityId, name: player.name }))),
    weathers: sorted(states.filter((state) => state.entityId.startsWith("weather.")).map(option)),
    temperatures: sensors("temperature"),
    winds: sensors("wind_speed"),
  };
}

/** A device's name as the page shows it: its label without a trailing "energy". */
export function deviceLabel(label: string): string {
  return label.replace(/\s+energy$/i, "") || label;
}

/** The page's values from a discovery or from what is in use (`inUse`). A device's other names are its aliases beyond the ones its own name gives. */
export function pageValues(found: DiscoveredHouse): HousePage {
  const metrics = Array.isArray(found.metrics?.metrics) ? found.metrics.metrics.map(record) : [];
  const metric = (id: string) => metrics.find((item) => item.id === id);
  const devices = Object.fromEntries(metrics.filter((item) => item.scope === "device" && text(item.statisticId)).map((item) => {
    const id = text(item.statisticId) as string;
    const base = deviceLabel(text(item.label) ?? "").toLowerCase();
    const own = new Set([base, `${base} power`, `${base} energy`, `${base} usage`, (text(item.label) ?? "").toLowerCase()]);
    const names = list(item.aliases).map(text).filter((name): name is string => Boolean(name) && !own.has((name as string).toLowerCase()));
    return [id, { power: text(item.relatedPowerEntityId), names }];
  }));
  return {
    power: text(metric("house_current_power")?.entityId),
    houseEnergy: text(metric("house_consumption_energy")?.entityId),
    vacuum: text(record(found.house.vacuum).entity),
    leftOpen: list(found.house.left_open).map((watch) => text(record(watch).entity)).filter((id): id is string => Boolean(id)),
    calendars: list(found.catchup.calendars).map(text).filter((id): id is string => Boolean(id)),
    devices,
    speakers: Object.fromEntries(Object.entries(found.speakers ?? {}).map(([device, speaker]) => [device, speaker.player])),
    weather: text(record(found.house.weather).entity),
    outsideTemperature: text(record(found.house.weather).outside_temperature),
    outsideWind: text(record(found.house.weather).outside_wind_speed),
    budgetKwh: typeof record(found.house.energy).monthly_budget_kwh === "number" ? record(found.house.energy).monthly_budget_kwh as number : null,
    solarPower: text(metric("solar_total_energy")?.relatedPowerEntityId),
  };
}

/** Which page parts a file of the house's own sets, and the file it lives in. */
export interface HandMade {
  readonly weather: boolean;
  readonly budget: boolean;
  readonly power: boolean;
  readonly leftOpen: boolean;
  readonly vacuum: boolean;
  readonly people: boolean;
  readonly calendars: boolean;
}

/** What is in use now: the house's own files where they set a part (as the loaders read them), else discovery. */
export function inUse(found: DiscoveredHouse): { readonly view: DiscoveredHouse; readonly handMade: HandMade } {
  const own = (file: string): Record<string, unknown> | null => {
    try {
      return record(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return null;
    }
  };
  const metrics = own(houseDataPath("house-metrics.json", "JARVIS_V5_HOUSE_METRICS_FILE"));
  const house = own(houseConfigPath()) ?? {};
  const catchup = own(houseDataPath("catchup-sources.json", "JARVIS_V5_CATCHUP_SOURCES_FILE")) ?? {};
  return {
    view: { ...found, metrics: metrics ?? found.metrics, house: { ...found.house, ...house }, catchup: { ...found.catchup, ...catchup } },
    handMade: {
      power: metrics !== null, leftOpen: "left_open" in house, vacuum: "vacuum" in house, people: "people" in catchup, calendars: "calendars" in catchup,
      weather: "weather" in house, budget: "energy" in house,
    },
  };
}

/** The house's changes: only what differs from what discovery picks by itself. */
export function editsFromPage(wanted: HousePage, automatic: HousePage): HouseChoices {
  const one = (want: string | null, auto: string | null): string | undefined => want === auto ? undefined : want ?? "none";
  const edits = (want: readonly string[], auto: readonly string[]): ListEdits | undefined => {
    const add = want.filter((id) => !auto.includes(id));
    const remove = auto.filter((id) => !want.includes(id));
    return add.length || remove.length ? { add, remove } : undefined;
  };
  const devices = Object.fromEntries(Object.entries(wanted.devices).flatMap(([id, device]) => {
    const power = one(device.power, automatic.devices[id]?.power ?? null);
    const change = { ...(power ? { power } : {}), ...(device.names.length ? { names: [...device.names] } : {}) };
    return Object.keys(change).length ? [[id, change]] : [];
  }));
  const power = one(wanted.power, automatic.power);
  const houseEnergy = one(wanted.houseEnergy, automatic.houseEnergy);
  const vacuum = one(wanted.vacuum, automatic.vacuum);
  const leftOpen = edits(wanted.leftOpen, automatic.leftOpen);
  const calendars = edits(wanted.calendars, automatic.calendars);
  const speakers = Object.fromEntries(Object.entries(wanted.speakers).flatMap(([device, player]) => {
    const change = one(player, automatic.speakers[device] ?? null);
    return change ? [[device, change]] : [];
  }));
  const weather = one(wanted.weather, automatic.weather);
  const outsideTemperature = one(wanted.outsideTemperature, automatic.outsideTemperature);
  const outsideWind = one(wanted.outsideWind, automatic.outsideWind);
  const solarPower = one(wanted.solarPower, automatic.solarPower);
  return {
    ...(solarPower ? { solarPower } : {}),
    ...(weather ? { weather } : {}),
    ...(outsideTemperature ? { outsideTemperature } : {}),
    ...(outsideWind ? { outsideWind } : {}),
    ...(wanted.budgetKwh ? { budgetKwh: wanted.budgetKwh } : {}),
    ...(Object.keys(speakers).length ? { speakers } : {}),
    ...(power ? { power } : {}),
    ...(houseEnergy ? { houseEnergy } : {}),
    ...(vacuum ? { vacuum } : {}),
    ...(leftOpen ? { leftOpen } : {}),
    ...(calendars ? { calendars } : {}),
    ...(Object.keys(devices).length ? { devices } : {}),
  };
}

/** A page save, checked: only what the house has may be picked; names are short plain words. */
/** The devices as they are (the save changes only the ones it names); `known`: every device it may name. */
/**
 * `current`: what is in use now; a value already in use passes even when HA no longer has it (a
 * hand-made file naming a removed entity must not stop the page saving another part).
 */
export function checkedPage(raw: unknown, options: HouseOptions, base: HousePage["devices"], known: ReadonlySet<string> = new Set(Object.keys(base)), speakerBase: HousePage["speakers"] = {}, current?: HousePage): HousePage {
  const value = record(raw);
  const inUse = (key: string, id: string): boolean => {
    const now = current?.[key as keyof HousePage];
    return now === id || (Array.isArray(now) && now.includes(id));
  };
  const one = (key: string, choices: readonly HouseOption[]): string | null => {
    const picked = value[key] === null ? null : text(value[key]);
    if (picked !== null && !inUse(key, picked) && !choices.some((option) => option.id === picked)) throw new Error(`${picked} isn't in this house`);
    return picked;
  };
  const many = (key: string, choices: readonly HouseOption[]): string[] => {
    if (!Array.isArray(value[key])) throw new Error(`${key} must be a list`);
    const ids = [...new Set((value[key] as unknown[]).map(text).filter((id): id is string => Boolean(id)))];
    const unknown = ids.find((id) => !inUse(key, id) && !choices.some((option) => option.id === id));
    if (unknown) throw new Error(`${unknown} isn't in this house`);
    return ids;
  };
  const devices = Object.fromEntries(Object.entries(record(value.devices)).map(([id, raw]) => {
    if (!known.has(id)) throw new Error(`${id} isn't on the Energy dashboard`);
    const device = record(raw);
    const power = device.power === null ? null : text(device.power);
    if (power !== null && power !== base[id]?.power && !options.power.some((option) => option.id === power)) throw new Error(`${power} isn't in this house`);
    const names = (Array.isArray(device.names) ? device.names : []).map(text).filter((name): name is string => Boolean(name));
    if (names.length > 10 || names.some((name) => name.length > 40 || /[{}<>"\\]/.test(name))) throw new Error("names must be short plain words");
    return [id, { power, names: [...new Set(names)] }];
  }));
  const speakers = Object.fromEntries(Object.entries(record(value.speakers)).map(([device, raw]) => {
    if (!(device in speakerBase)) throw new Error(`${device} isn't one of the house's speakers`);
    const player = raw === null ? null : text(raw);
    if (player !== null && !options.musicPlayers.some((option) => option.id === player)) throw new Error(`${player} isn't a Music Assistant player here`);
    return [device, player];
  }));
  const budget = value.budgetKwh === null || value.budgetKwh === undefined || value.budgetKwh === "" ? null : Number(value.budgetKwh);
  if (budget !== null && !(Number.isFinite(budget) && budget > 0 && budget <= 100_000)) throw new Error("the budget must be a number of kWh above zero");
  return {
    speakers: { ...speakerBase, ...speakers },
    weather: one("weather", options.weathers),
    outsideTemperature: one("outsideTemperature", options.temperatures),
    outsideWind: one("outsideWind", options.winds),
    solarPower: one("solarPower", options.power),
    budgetKwh: budget === null ? null : Math.round(budget),
    power: one("power", options.power),
    houseEnergy: one("houseEnergy", options.energy),
    vacuum: one("vacuum", options.vacuums),
    leftOpen: many("leftOpen", options.openings),
    calendars: many("calendars", options.calendars),
    devices: { ...base, ...devices },
  };
}

/** A saved changes file, read back (anything malformed is left out). */
export function checkedChoices(raw: unknown): HouseChoices {
  const value = record(raw);
  const one = (key: string): string | undefined => text(value[key]) ?? undefined;
  const edits = (key: string): ListEdits | undefined => {
    const item = record(value[key]);
    const ids = (field: unknown): string[] => (Array.isArray(field) ? field : []).map(text).filter((id): id is string => Boolean(id));
    return Array.isArray(item.add) || Array.isArray(item.remove) ? { add: ids(item.add), remove: ids(item.remove) } : undefined;
  };
  const devices = Object.fromEntries(Object.entries(record(value.devices)).map(([id, raw]) => {
    const device = record(raw);
    const names = (Array.isArray(device.names) ? device.names : []).map(text).filter((name): name is string => Boolean(name));
    return [id, { ...(text(device.power) ? { power: text(device.power) as string } : {}), ...(names.length ? { names } : {}) }];
  }));
  const picks = {
    power: one("power"), houseEnergy: one("houseEnergy"), vacuum: one("vacuum"), leftOpen: edits("leftOpen"), calendars: edits("calendars"),
    weather: one("weather"), outsideTemperature: one("outsideTemperature"), outsideWind: one("outsideWind"), solarPower: one("solarPower"),
    budgetKwh: typeof value.budgetKwh === "number" && value.budgetKwh > 0 ? value.budgetKwh : undefined,
  };
  const speakers = Object.fromEntries(Object.entries(record(value.speakers)).flatMap(([device, player]) => text(player) ? [[device, text(player) as string]] : []));
  return {
    ...(Object.keys(speakers).length ? { speakers } : {}),
    ...Object.fromEntries(Object.entries(picks).filter(([, item]) => item !== undefined)),
    ...(Object.keys(devices).length ? { devices } : {}),
  } as HouseChoices;
}

/** What a House page save changed, one line each, in the house's own names (for the log). */
export function describePageChange(before: HousePage, after: HousePage, options: HouseOptions, automatic: DiscoveredHouse): string[] {
  const all = [...options.power, ...options.energy, ...options.vacuums, ...options.openings, ...options.calendars];
  const named = (id: string | null): string => id === null ? "none" : all.find((option) => option.id === id)?.name ?? id;
  const labels = new Map(list(automatic.metrics?.metrics).map(record).filter((item) => item.scope === "device").map((item) => [text(item.statisticId), deviceLabel(text(item.label) ?? "")]));
  const lines: string[] = [];
  const one = (title: string, from: string | null, to: string | null): void => { if (from !== to) lines.push(`House page: ${title} -> ${named(to)}`); };
  const many = (title: string, from: readonly string[], to: readonly string[]): void => {
    const added = to.filter((id) => !from.includes(id)).map(named);
    const removed = from.filter((id) => !to.includes(id)).map(named);
    if (added.length || removed.length) lines.push(`House page: ${title} ${[added.length ? `added ${added.join(", ")}` : "", removed.length ? `removed ${removed.join(", ")}` : ""].filter(Boolean).join("; ")}`);
  };
  one("whole-house power", before.power, after.power);
  one("whole-house energy", before.houseEnergy, after.houseEnergy);
  one("solar power", before.solarPower, after.solarPower);
  one("robot vacuum", before.vacuum, after.vacuum);
  one("weather", before.weather, after.weather);
  one("outside temperature", before.outsideTemperature, after.outsideTemperature);
  one("outside wind", before.outsideWind, after.outsideWind);
  if (before.budgetKwh !== after.budgetKwh) lines.push(`House page: electricity budget -> ${after.budgetKwh === null ? "none" : `${after.budgetKwh} kWh a month`}`);
  many("doors and locks", before.leftOpen, after.leftOpen);
  many("calendars", before.calendars, after.calendars);
  for (const [device, player] of Object.entries(after.speakers)) {
    if ((before.speakers[device] ?? null) !== player) {
      lines.push(`House page: ${automatic.speakers?.[device]?.name ?? device} music -> ${player === null ? "none" : (options.musicPlayers.find((option) => option.id === player)?.name ?? player)}`);
    }
  }
  for (const [id, device] of Object.entries(after.devices)) {
    const was = before.devices[id];
    const label = labels.get(id) ?? id;
    if ((was?.power ?? null) !== device.power) lines.push(`House page: ${label} power sensor -> ${named(device.power)}`);
    if (JSON.stringify(was?.names ?? []) !== JSON.stringify(device.names)) lines.push(`House page: ${label} also called -> ${device.names.join(", ") || "nothing else"}`);
  }
  return lines;
}

/** The name the house gave it in HA, as written ("FoxESS Home Consumption Power"). */
function displayName(state: HaEntityState): string {
  return text(state.attributes.friendly_name) ?? state.entityId;
}
