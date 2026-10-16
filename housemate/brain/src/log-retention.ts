import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import type { AppConfig } from "./config.js";
import { secureTurnLogStorage, turnLogPath } from "./turn-log.js";

// One turn log, and nothing older than 90 days is kept.
export const LOG_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 30_000;
const READ_CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

export interface TurnLogPruneResult {
  readonly kept: number;
  readonly removed: number;
}

export interface LogRetentionResult {
  readonly turnLog: TurnLogPruneResult;
  readonly evalRunsRemoved: number;
}

export function retentionCutoff(now: Date, days = LOG_RETENTION_DAYS): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

export function evalRunsPath(config: Pick<AppConfig, "dataDir">): string {
  return join(config.dataDir, "eval-runs");
}

// Keeps every line whose timestamp is at or after the cutoff. The log is not in time order
// (fixture-clock eval turns carry old timestamps), so every line is checked. Lines that cannot
// be dated are kept rather than guessed about. The rewrite is synchronous so no append from
// this process can land between the read and the rename.
export function pruneTurnLog(filePath: string, cutoff: Date): TurnLogPruneResult {
  if (!existsSync(filePath)) {
    return { kept: 0, removed: 0 };
  }
  const cutoffMs = cutoff.getTime();
  const tempPath = `${filePath}.prune-tmp`;
  rmSync(tempPath, { force: true });
  const input = openSync(filePath, "r");
  let output: number | null = null;
  let kept = 0;
  let removed = 0;
  try {
    output = openSync(tempPath, "w", 0o600);
    const out = output;
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    let carry = Buffer.alloc(0);
    const handleLine = (line: Buffer): void => {
      if (line.length === 0) {
        return;
      }
      if (lineIsExpired(line.toString("utf8"), cutoffMs)) {
        removed += 1;
        return;
      }
      kept += 1;
      writeSync(out, line);
      writeSync(out, "\n");
    };
    for (;;) {
      const bytesRead = readSync(input, chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        break;
      }
      const data = carry.length > 0
        ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
        : Buffer.from(chunk.subarray(0, bytesRead));
      let start = 0;
      for (let index = data.indexOf(NEWLINE); index !== -1; index = data.indexOf(NEWLINE, start)) {
        handleLine(data.subarray(start, index));
        start = index + 1;
      }
      carry = data.subarray(start);
    }
    handleLine(carry);
  } catch (error) {
    if (output !== null) {
      closeSync(output);
      output = null;
    }
    rmSync(tempPath, { force: true });
    throw error;
  } finally {
    closeSync(input);
    if (output !== null) {
      closeSync(output);
    }
  }
  if (removed === 0) {
    unlinkSync(tempPath);
    return { kept, removed };
  }
  renameSync(tempPath, filePath);
  secureTurnLogStorage(filePath);
  return { kept, removed };
}

// Removes top-level eval artefact files last modified before the cutoff. Directories and
// symlinks are left alone.
export function pruneEvalRuns(directory: string, cutoff: Date): number {
  if (!existsSync(directory)) {
    return 0;
  }
  const cutoffMs = cutoff.getTime();
  let removed = 0;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stats = lstatSync(path);
    if (stats.isFile() && stats.mtimeMs < cutoffMs) {
      unlinkSync(path);
      removed += 1;
    }
  }
  return removed;
}

export function applyLogRetention(config: Pick<AppConfig, "dataDir">, now: Date): LogRetentionResult {
  const cutoff = retentionCutoff(now);
  return {
    turnLog: pruneTurnLog(turnLogPath(config), cutoff),
    evalRunsRemoved: pruneEvalRuns(evalRunsPath(config), cutoff),
  };
}

export interface LogRetentionSchedule {
  readonly now: () => Date;
  readonly onResult?: (result: LogRetentionResult) => void;
  readonly onError?: (message: string) => void;
}

export function startLogRetention(config: Pick<AppConfig, "dataDir">, schedule: LogRetentionSchedule): void {
  const run = (): void => {
    try {
      schedule.onResult?.(applyLogRetention(config, schedule.now()));
    } catch (error) {
      schedule.onError?.(`log retention failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  setTimeout(() => {
    run();
    setInterval(run, DAY_MS).unref();
  }, FIRST_RUN_DELAY_MS).unref();
}

function lineIsExpired(line: string, cutoffMs: number): boolean {
  let timestamp: unknown;
  try {
    timestamp = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
  } catch {
    return false;
  }
  if (typeof timestamp !== "string") {
    return false;
  }
  const timestampMs = Date.parse(timestamp);
  return Number.isFinite(timestampMs) && timestampMs < cutoffMs;
}
