import { loadConfig } from "./config.js";
import type { HaHistoryState } from "./ha-history.js";
import { runHouseRoutineRefresh } from "./house-routine-refresh.js";

// Manual routine refresh from this box: `JARVIS_HA_TOKEN=... Npm run patterns:refresh-routines [-- --dry-run]`.
const token = process.env.JARVIS_HA_TOKEN?.trim();
if (!token) throw new Error("JARVIS_HA_TOKEN is required");
const baseUrl = (process.env.JARVIS_HA_URL?.trim() || "http://homeassistant.local:8123").replace(/\/$/, "");

const result = await runHouseRoutineRefresh({
  config: loadConfig(process.env),
  now: new Date(),
  dryRun: process.argv.includes("--dry-run"),
  async fetchStates(entityIds, start, end) {
    const url = `${baseUrl}/api/history/period/${start.toISOString()}?end_time=${encodeURIComponent(end.toISOString())}`
      + `&filter_entity_id=${entityIds.join(",")}&minimal_response&no_attributes`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`HA history request failed: ${response.status}`);
    const series = await response.json() as { entity_id?: string; state: string; last_changed: string }[][];
    return series.flatMap((rows) => rows.map((row): HaHistoryState => ({
      entityId: rows[0]?.entity_id ?? "",
      state: row.state,
      lastChanged: row.last_changed,
      lastUpdated: row.last_changed,
      attributes: {},
    })));
  },
});
console.log(JSON.stringify({
  outputPath: result.outputPath,
  written: result.written,
  kept: result.kept,
  dropped: result.dropped,
  patterns: result.catalog.patterns.map((pattern) => ({ id: pattern.id, validThrough: pattern.validThrough, answer: (pattern.answers as { default: string }).default })),
}, null, 2));
