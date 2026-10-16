import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The house's own Home Assistant facts, as data: `<dataDir>/house.json`. Which weather
 * entity and sensors, which lights count as the house's, what "left open" means, the vacuum and its
 * room lists, the monthly energy sensors. Missing entries fall back to what any house has (its
 * weather entity, its lights) or switch the feature off. A section the file leaves out comes from
 * house discovery when it found one.
 * The file is read at start; an edit takes effect on the next restart. The time zone is the
 * Supervisor's TZ (Home Assistant's own).
 */

export const HOUSE_TIME_ZONE = process.env.TZ?.trim() || "UTC";
/** The house's locale for dates and times ("en-AU"): the app derives it from Home Assistant's language and country. */
export const HOUSE_LOCALE = process.env.JARVIS_V5_LOCALE?.trim() || "en-AU";
/** Where the house is ("Fairview, Ontario, Canada"), for anything local: the app's "Where the house is" setting. */
export function housePlace(): string {
  return process.env.JARVIS_V5_PLACE?.trim() || "";
}
export const HOUSE_CONFIG_FILE = "house.json";

export interface LeftOpenWatch {
  readonly entityId: string;
  readonly openState: string;
  readonly text: string;
}

export interface HouseConfig {
  readonly version: 1;
  readonly weather: {
    /** null: the house's first weather entity. */
    readonly entity: string | null;
    readonly hourlyEntity: string | null;
    /** A Bureau of Meteorology style sensor family, e.g. "sensor.town" for sensor.town_temp. */
    readonly sensorPrefix: string | null;
    readonly outsideTemperature: string | null;
    readonly outsideWindSpeed: string | null;
  };
  readonly lights: {
    /** The lights that count as the house's in "are any lights on?"; null means every light. */
    readonly reportable: readonly string[] | null;
    /** Lights whose names don't say "light" but are lights (a cabinet strip, a WLED). */
    readonly alsoLights: readonly string[];
  };
  readonly leftOpen: readonly LeftOpenWatch[];
  /** Battery devices that charge themselves (words in the entity id), beyond phones and tablets. */
  readonly rechargeableWords: readonly string[];
  readonly vacuum: {
    /** What the house calls it ("Robbie"); the replies use it. */
    readonly name: string | null;
    /** Spoken names besides its Assist aliases, lower case ("robbie", "robo"). */
    readonly names: readonly string[];
    readonly entity: string | null;
    readonly queueSensor: string | null;
    readonly roomsFile: string | null;
    readonly queueRoomsFile: string | null;
  };
  readonly energy: {
    readonly monthlyBudget: string | null;
    /** e.g. "input_number.{month}_kwh_budget" for past months. */
    readonly monthlyBudgetPattern: string | null;
    /** e.g. "input_number.{month}_kwh_actual". */
    readonly monthlyActualPattern: string | null;
    readonly monthlyUsed: string | null;
    readonly monthlyReportedLoad: string | null;
    readonly monthlyProjection: readonly string[];
    /** A monthly budget in kWh set on the House page (no helpers needed; usage comes from the Energy history). */
    readonly monthlyBudgetKwh: number | null;
  };
  /** The house's own sound files, by what they are called ("rain sounds" -> a file in Music Assistant's /media). */
  readonly sounds: Readonly<Record<string, string>>;
}

const EMPTY: HouseConfig = Object.freeze({
  version: 1,
  weather: { entity: null, hourlyEntity: null, sensorPrefix: null, outsideTemperature: null, outsideWindSpeed: null },
  lights: { reportable: null, alsoLights: [] },
  leftOpen: [],
  rechargeableWords: [],
  vacuum: { name: null, names: [], entity: null, queueSensor: null, roomsFile: null, queueRoomsFile: null },
  energy: { monthlyBudget: null, monthlyBudgetPattern: null, monthlyActualPattern: null, monthlyUsed: null, monthlyReportedLoad: null, monthlyProjection: [], monthlyBudgetKwh: null },
  sounds: {},
});

let current: HouseConfig | null = null;
let pinned = false;
let builtFrom = -1;
let discoveredSections: Readonly<Record<string, unknown>> | undefined;
let discoveredRevision = 0;

export function houseConfig(): HouseConfig {
  if (pinned && current) return current;
  if (!current || builtFrom !== discoveredRevision) {
    builtFrom = discoveredRevision;
    current = readHouseConfigFile(houseConfigPath(), discoveredHouseSections());
  }
  return current;
}

/** Where house discovery keeps what it found. */
export function discoveryFilePath(): string {
  return houseDataPath(join("auto", "house-discovery.json"), "JARVIS_V5_HOUSE_DISCOVERY_FILE");
}

/** The house.json sections discovery found: house-discovery.ts hands them over; undefined reads its file again. */
export function setDiscoveredHouseSections(sections: Readonly<Record<string, unknown>> | null | undefined): void {
  discoveredSections = sections === undefined ? undefined : sections ?? {};
  discoveredRevision += 1;
}

function discoveredHouseSections(): Readonly<Record<string, unknown>> {
  if (discoveredSections === undefined) {
    try {
      discoveredSections = record(record(JSON.parse(readFileSync(discoveryFilePath(), "utf8"))).house);
    } catch {
      discoveredSections = {};
    }
  }
  return discoveredSections;
}

/** Fixes the house config (tests); discovery no longer changes it. */
export function setHouseConfig(next: HouseConfig): void {
  current = next;
  pinned = true;
}

export function houseConfigPath(): string {
  return process.env.JARVIS_V5_HOUSE_FILE?.trim()
    || join(process.env.JARVIS_V5_DATA_DIR?.trim() || "/share/jarvis-v5", HOUSE_CONFIG_FILE);
}

/** A house data file in the data dir (or its env override for tests and evals). */
export function houseDataPath(file: string, envName: string): string {
  return process.env[envName]?.trim() || join(process.env.JARVIS_V5_DATA_DIR?.trim() || "/share/jarvis-v5", file);
}

/** The house file, each section it leaves out taken from `discovered` (house.json's own shape). */
export function readHouseConfigFile(file: string, discovered: Readonly<Record<string, unknown>> = {}): HouseConfig {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.keys(discovered).length ? parseHouseConfig(discovered) : EMPTY;
    throw error;
  }
  return parseHouseConfig({ ...discovered, ...record(JSON.parse(raw)) });
}

export function parseHouseConfig(value: unknown): HouseConfig {
  const root = record(value);
  if (root.version !== undefined && root.version !== 1) {
    throw new Error(`house.json version ${String(root.version)} is newer than this assistant knows`);
  }
  const weather = record(root.weather);
  const lights = record(root.lights);
  const vacuum = record(root.vacuum);
  const energy = record(root.energy);
  return Object.freeze({
    version: 1,
    weather: Object.freeze({
      entity: text(weather.entity),
      hourlyEntity: text(weather.hourly_entity),
      sensorPrefix: text(weather.sensor_prefix),
      outsideTemperature: text(weather.outside_temperature),
      outsideWindSpeed: text(weather.outside_wind_speed),
    }),
    lights: Object.freeze({
      reportable: Array.isArray(lights.reportable) ? Object.freeze(list(lights.reportable)) : null,
      alsoLights: Object.freeze(list(lights.also_lights)),
    }),
    leftOpen: Object.freeze((Array.isArray(root.left_open) ? root.left_open : []).flatMap((item) => {
      const watch = record(item);
      const entityId = text(watch.entity);
      const openState = text(watch.open_state);
      const said = text(watch.text);
      return entityId && openState && said ? [Object.freeze({ entityId, openState, text: said })] : [];
    })),
    rechargeableWords: Object.freeze(list(root.rechargeable_words)),
    vacuum: Object.freeze({
      name: text(vacuum.name),
      names: Object.freeze(list(vacuum.names).map((name) => name.toLowerCase())),
      entity: text(vacuum.entity),
      queueSensor: text(vacuum.queue_sensor),
      roomsFile: text(vacuum.rooms_file),
      queueRoomsFile: text(vacuum.queue_rooms_file),
    }),
    energy: Object.freeze({
      monthlyBudget: text(energy.monthly_budget),
      monthlyBudgetPattern: text(energy.monthly_budget_pattern),
      monthlyActualPattern: text(energy.monthly_actual_pattern),
      monthlyUsed: text(energy.monthly_used),
      monthlyReportedLoad: text(energy.monthly_reported_load),
      monthlyProjection: Object.freeze(list(energy.monthly_projection)),
      monthlyBudgetKwh: typeof energy.monthly_budget_kwh === "number" && energy.monthly_budget_kwh > 0 ? energy.monthly_budget_kwh : null,
    }),
    sounds: Object.freeze(Object.fromEntries(Object.entries(record(root.sounds)).flatMap(([name, path]) => {
      const file = text(path);
      return name.trim() && file ? [[name.trim().toLowerCase(), file]] : [];
    }))),
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}

/** The vacuum mid-sentence: its house name ("Robbie") or "the vacuum". */
export function vacuumName(): string {
  return houseConfig().vacuum.name ?? "the vacuum";
}

/** The vacuum at the start of a sentence. */
export function VacuumName(): string {
  const name = vacuumName();
  return name.charAt(0).toUpperCase() + name.slice(1);
}
