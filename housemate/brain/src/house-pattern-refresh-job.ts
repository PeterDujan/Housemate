import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { AppConfig } from "./config.js";
import { defaultHouseObservationCatalogPath } from "./house-pattern-observations.js";
import { type RoutineHistoryFetch, runHouseRoutineRefresh } from "./house-routine-refresh.js";
import { household } from "./household.js";

/**
 * Weekly refresh of both reviewed household catalogues into `<dataDir>/patterns/`,
 * which the loaders prefer over the source-controlled files. Each catalogue is
 * replaced only when its gates pass; a failed run keeps the current one and
 * retries at the next check. Checks run every six hours, so a restart or a
 * missed week catches up instead of waiting for a fixed weekday.
 */
export const PATTERN_REFRESH_SCHEDULE = Object.freeze({
  maxAgeMs: 7 * 86_400_000,
  checkEveryMs: 6 * 60 * 60_000,
  firstCheckMs: 10 * 60_000,
  stepTimeoutMs: 20 * 60_000,
});

export interface PatternRefreshJob {
  readonly now: () => Date;
  readonly fetchStates: RoutineHistoryFetch;
  readonly log: (message: string) => void;
}

export function startHousePatternRefresh(config: Pick<AppConfig, "dataDir" | "haUrl" | "homeAssistantToken">, job: PatternRefreshJob): void {
  let running = false;
  const check = (): void => {
    if (running) return;
    running = true;
    void refreshDueCatalogues(config, job).finally(() => {
      running = false;
    });
  };
  setTimeout(() => {
    check();
    setInterval(check, PATTERN_REFRESH_SCHEDULE.checkEveryMs).unref();
  }, PATTERN_REFRESH_SCHEDULE.firstCheckMs).unref();
}

async function refreshDueCatalogues(config: Pick<AppConfig, "dataDir" | "haUrl" | "homeAssistantToken">, job: PatternRefreshJob): Promise<void> {
  const directory = join(config.dataDir, "patterns");
  const now = job.now();
  if (isDue(join(directory, "house-patterns.json"), now)) {
    try {
      const people = household().people.map((person) => ({ id: person.id, name: person.name, aliases: person.aliases, haPerson: person.haPerson }));
      const result = await runHouseRoutineRefresh({ config, fetchStates: job.fetchStates, now, people });
      const dropped = result.dropped.map((entry) => `${entry.id} (${entry.reason})`).join("; ");
      job.log(`routines refreshed: kept ${result.kept.length}${dropped ? `, dropped ${dropped}` : ""}`);
    } catch (error) {
      job.log(`routine refresh failed, keeping the current routines: ${message(error)}`);
    }
  }
  if (isDue(join(directory, "house-pattern-observations.json"), now) && config.homeAssistantToken) {
    try {
      job.log(`observations refreshed: ${await refreshObservations(config, directory)}`);
    } catch (error) {
      job.log(`observation refresh failed, keeping the current observations: ${message(error)}`);
    }
  }
}

/** The pattern-lab manual refresh (mine, review against the previous catalogue, access eval), staged and swapped in only when all three pass. */
async function refreshObservations(config: Pick<AppConfig, "dataDir" | "haUrl" | "homeAssistantToken">, directory: string): Promise<string> {
  const staging = join(directory, ".staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    const candidates = join(staging, "candidates.json");
    const catalog = join(staging, "house-pattern-observations.json");
    const env = { ...process.env, JARVIS_HA_TOKEN: config.homeAssistantToken ?? "" };
    await runStep(["pattern-lab/mine_current_ha.mjs", "--base-url", httpBaseUrl(config.haUrl), "--output", candidates], env);
    await runStep([
      "pattern-lab/review_current_ha_patterns.mjs",
      "--input", candidates,
      "--output", catalog,
      "--review-output", join(config.dataDir, "pattern-analysis", "current-ha-pattern-review.json"),
      "--previous-catalog", defaultHouseObservationCatalogPath(config),
    ], env);
    await runStep(["pattern-lab/evaluate_house_pattern_access.mjs", catalog], env);
    const summary = (JSON.parse(readFileSync(catalog, "utf8")) as { observations?: unknown[]; validThrough?: string });
    renameSync(catalog, join(directory, "house-pattern-observations.json"));
    return `${summary.observations?.length ?? 0} observations valid through ${summary.validThrough ?? "?"}`;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function runStep(args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "ignore", "pipe"], timeout: PATTERN_REFRESH_SCHEDULE.stepTimeoutMs });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-500);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${args[0]} exited ${code}: ${stderr.trim()}`));
    });
  });
}

function isDue(path: string, now: Date): boolean {
  if (!existsSync(path)) return true;
  try {
    const generatedAt = Date.parse((JSON.parse(readFileSync(path, "utf8")) as { generatedAt?: string }).generatedAt ?? "");
    return !(now.getTime() - generatedAt < PATTERN_REFRESH_SCHEDULE.maxAgeMs);
  } catch {
    return true;
  }
}

function httpBaseUrl(haUrl: string): string {
  // ws://host:8123/api/websocket or, inside an add-on, ws://supervisor/core/websocket.
  return haUrl.replace(/^ws/, "http").replace(/\/(?:api\/)?websocket\/?$/, "").replace(/\/$/, "");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
