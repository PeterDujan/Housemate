import { deviceLabel, inUse, pageValues, type DiscoveredHouse, type HandMade, type HouseChoices, type HouseOptions, type HousePage } from "./house-discovery.js";

/*
 * The page's House > "Set up from your Home Assistant" panel: everything in use, whether
 * discovery filled it in or a file of the house's own sets it up by hand, and every part can be
 * changed there (one Save for the lot).
 */

export interface HouseDiscoveryBody {
  readonly ok: true;
  readonly discoveredAt: string | null;
  /** Parts a file of the house's own sets now; changing one on the page moves it onto the page. */
  readonly handMade: HandMade;
  /** The vacuum is set up by hand to clean room by room (changing it on the page ends that). */
  readonly vacuumRooms: boolean;
  /** What is in use now. */
  readonly page: HousePage;
  /** The house's changes on top of discovery. */
  readonly choices: HouseChoices;
  readonly options: HouseOptions;
  /** The Energy dashboard's devices in its order, by their energy sensor. */
  readonly devices: readonly { readonly id: string; readonly label: string }[];
  /** The people linked on the People page. */
  readonly people: readonly string[];
  /** The house's Assist speakers, by HA device. */
  readonly speakers: readonly { readonly id: string; readonly label: string }[];
}

const NO_OPTIONS: HouseOptions = { power: [], energy: [], vacuums: [], openings: [], calendars: [], musicPlayers: [], weathers: [], temperatures: [], winds: [] };
const EMPTY_PAGE: HousePage = {
  power: null, houseEnergy: null, vacuum: null, leftOpen: [], calendars: [], devices: {}, speakers: {},
  weather: null, outsideTemperature: null, outsideWind: null, budgetKwh: null, solarPower: null,
};

export function houseDiscoveryBody(found: DiscoveredHouse | null, picks: { readonly choices: HouseChoices; readonly options: HouseOptions } = { choices: {}, options: NO_OPTIONS }): HouseDiscoveryBody {
  const current = found ? inUse(found) : null;
  const view = current?.view ?? null;
  const metrics = Array.isArray(view?.metrics?.metrics) ? view.metrics.metrics.map(record) : [];
  const vacuum = record(view?.house.vacuum);
  return {
    ok: true,
    discoveredAt: found?.discoveredAt ?? null,
    handMade: current?.handMade ?? { power: false, leftOpen: false, vacuum: false, people: false, calendars: false, weather: false, budget: false },
    vacuumRooms: Boolean(current?.handMade.vacuum && (text(vacuum.queue_sensor) || text(vacuum.rooms_file))),
    page: view ? pageValues(view) : EMPTY_PAGE,
    choices: picks.choices,
    options: picks.options,
    devices: metrics.filter((metric) => metric.scope === "device" && text(metric.statisticId))
      .map((metric) => ({ id: text(metric.statisticId) as string, label: deviceLabel(text(metric.label) ?? "") })),
    people: Object.values(record(view?.catchup.people)).map((person) => text(record(person).label) ?? ""),
    speakers: Object.entries(found?.speakers ?? {}).map(([id, speaker]) => ({ id, label: speaker.name })),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
