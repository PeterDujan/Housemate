import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AppConfig } from "./config.js";
import { optionalString } from "./value-guards.js";

export type AlarmStatus = "scheduled" | "ringing" | "dismissed";

export interface AlarmRecord {
  readonly id: string;
  readonly fireAt: string;
  readonly createdAt: string;
  readonly status: AlarmStatus;
  readonly speakerName: string | null;
}

export interface SetAlarmRequest {
  readonly fireAt: Date;
  readonly speakerName: string | null;
}

export interface StopAlarmResult {
  readonly stopped: boolean;
  readonly alarm: AlarmRecord | null;
  readonly mode: "dismissed_ringing" | "cancelled_scheduled" | "none";
}

export interface AlarmClockService {
  setAlarm(request: SetAlarmRequest): AlarmRecord;
  stopAlarm(speakerName?: string | null): StopAlarmResult;
}

interface AlarmClockOptions {
  readonly now?: () => Date;
  readonly scheduler?: AlarmScheduler;
  readonly onRing?: (alarm: AlarmRecord) => void;
}

export interface AlarmScheduler {
  set(delayMs: number, callback: () => void): () => void;
}

interface AlarmFile {
  readonly alarms?: readonly unknown[];
}

export function alarmStorePath(config: Pick<AppConfig, "dataDir">): string {
  return join(config.dataDir, "alarms.json");
}

export class PersistentAlarmClock implements AlarmClockService {
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly scheduler: AlarmScheduler;
  private readonly onRing: (alarm: AlarmRecord) => void;
  private readonly timers = new Map<string, () => void>();
  private alarms: readonly AlarmRecord[];

  constructor(filePath: string, options: AlarmClockOptions = {}) {
    this.filePath = filePath;
    this.now = options.now ?? (() => new Date());
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onRing = options.onRing ?? (() => undefined);
    this.alarms = readAlarmFile(filePath);
    this.scheduleLoadedAlarms();
  }

  setAlarm(request: SetAlarmRequest): AlarmRecord {
    const now = this.now();
    const alarm: AlarmRecord = {
      id: `alarm-${now.toISOString().replaceAll(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`,
      fireAt: request.fireAt.toISOString(),
      createdAt: now.toISOString(),
      status: "scheduled",
      speakerName: request.speakerName,
    };
    this.alarms = [...this.alarms, alarm];
    this.write();
    this.schedule(alarm);
    return alarm;
  }

  stopAlarm(speakerName: string | null = null): StopAlarmResult {
    const active = this.matchingAlarms(speakerName, "ringing")[0] ?? null;
    if (active) {
      const stopped = this.updateAlarm(active.id, "dismissed");
      return { stopped: true, alarm: stopped, mode: "dismissed_ringing" };
    }
    const scheduled = [...this.matchingAlarms(speakerName, "scheduled")]
      .sort((left, right) => left.fireAt.localeCompare(right.fireAt))[0] ?? null;
    if (scheduled) {
      const stopped = this.updateAlarm(scheduled.id, "dismissed");
      return { stopped: true, alarm: stopped, mode: "cancelled_scheduled" };
    }
    return { stopped: false, alarm: null, mode: "none" };
  }

  private matchingAlarms(speakerName: string | null, status: AlarmStatus): readonly AlarmRecord[] {
    return this.alarms.filter((alarm) =>
      alarm.status === status
      && (!speakerName || !alarm.speakerName || alarm.speakerName === speakerName)
    );
  }

  private updateAlarm(id: string, status: AlarmStatus): AlarmRecord | null {
    let updated: AlarmRecord | null = null;
    this.cancelTimer(id);
    this.alarms = this.alarms.map((alarm) => {
      if (alarm.id !== id) {
        return alarm;
      }
      updated = { ...alarm, status };
      return updated;
    });
    this.write();
    return updated;
  }

  private scheduleLoadedAlarms(): void {
    const nowMs = this.now().getTime();
    for (const alarm of this.alarms) {
      if (alarm.status !== "scheduled") {
        continue;
      }
      const fireMs = Date.parse(alarm.fireAt);
      if (!Number.isFinite(fireMs)) {
        continue;
      }
      if (fireMs <= nowMs) {
        this.markRinging(alarm.id);
      } else {
        this.schedule(alarm);
      }
    }
  }

  private schedule(alarm: AlarmRecord): void {
    const delayMs = Date.parse(alarm.fireAt) - this.now().getTime();
    if (delayMs <= 0) {
      this.markRinging(alarm.id);
      return;
    }
    this.cancelTimer(alarm.id);
    this.timers.set(alarm.id, this.scheduler.set(delayMs, () => this.markRinging(alarm.id)));
  }

  private markRinging(id: string): void {
    const alarm = this.updateAlarm(id, "ringing");
    if (alarm) {
      this.onRing(alarm);
    }
  }

  private cancelTimer(id: string): void {
    this.timers.get(id)?.();
    this.timers.delete(id);
  }

  private write(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify({ alarms: this.alarms }, null, 2)}\n`);
  }
}

function readAlarmFile(filePath: string): readonly AlarmRecord[] {
  if (!existsSync(filePath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as AlarmFile;
    const rows = Array.isArray(parsed.alarms) ? parsed.alarms : [];
    return rows.map(parseAlarmRecord).filter((alarm): alarm is AlarmRecord => alarm !== null);
  } catch {
    return [];
  }
}

function parseAlarmRecord(value: unknown): AlarmRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const input = value as Record<string, unknown>;
  const id = optionalString(input.id);
  const fireAt = optionalString(input.fireAt);
  const createdAt = optionalString(input.createdAt);
  const status = alarmStatusValue(input.status);
  if (!id || !fireAt || !createdAt || !status || Number.isNaN(Date.parse(fireAt))) {
    return null;
  }
  return {
    id,
    fireAt,
    createdAt,
    status,
    speakerName: optionalString(input.speakerName),
  };
}

function alarmStatusValue(value: unknown): AlarmStatus | null {
  return value === "scheduled" || value === "ringing" || value === "dismissed" ? value : null;
}

const defaultScheduler: AlarmScheduler = {
  set(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};
