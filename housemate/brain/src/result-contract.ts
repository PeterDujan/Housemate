import type { IntentConfidence, IntentRoute } from "./intent-contract.js";
import type { MathConfidence } from "./math-calculator.js";

export type ResultSchemaVersion = 1;
export type ResultStatus = "ok" | "clarify" | "declined" | "error";
export type ResultConfidence = IntentConfidence | MathConfidence;
export type ResultSafetySeverity = "info" | "warning" | "blocked";
export type ResultSessionDirective = "close" | "continue";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface ResultTarget {
  readonly kind: "entity" | "group" | "area" | "person" | "system" | "open";
  readonly id: string | null;
  readonly label: string;
  readonly entityIds: readonly string[];
}

export interface ResultSafetyNote {
  readonly severity: ResultSafetySeverity;
  readonly code: string;
  readonly message: string;
  readonly renderSafe: boolean;
}

export interface SafeRenderFact {
  readonly key: string;
  readonly label: string;
  readonly value: JsonValue;
  readonly unit?: string;
}

export interface SafeRenderHouseContext {
  readonly timezone: string;
  readonly occupancy: "occupied" | "empty" | "unknown";
  readonly timeMode: "awake" | "quiet_hours" | "bedtime";
  readonly compositeMode: "active_occupied" | "quiet_occupied" | "settling_occupied" | "idle_empty" | "quiet_empty" | "night_empty" | "unresolved";
  readonly localHour: number;
  readonly weekend: boolean;
  readonly quietHoursActive: boolean;
  readonly bedtimeActive: boolean;
  readonly presentPeople: readonly string[];
}

export type SafeRenderRecentEvent =
  | {
    readonly kind: "calendar_start";
    readonly detectedAt: string;
    readonly calendarName: string | null;
    readonly eventSummary: string;
    readonly eventStart: string;
  }
  | {
    readonly kind: "rain_start";
    readonly detectedAt: string;
    readonly label: string;
  }
  | {
    readonly kind: "person_arrived" | "person_departed";
    readonly detectedAt: string;
    readonly personName: string;
  }
  | {
    readonly kind: "opening_opened" | "opening_closed";
    readonly detectedAt: string;
    readonly label: string;
  };

export interface SafeRenderContext {
  readonly house: SafeRenderHouseContext | null;
  readonly recentEvents: readonly SafeRenderRecentEvent[];
}

export interface SafeRenderSummary {
  readonly schemaVersion: ResultSchemaVersion;
  readonly resultId: string;
  readonly turnId: string;
  readonly route: IntentRoute;
  readonly status: ResultStatus;
  readonly confidence: ResultConfidence;
  readonly target: Pick<ResultTarget, "kind" | "label"> | null;
  readonly facts: readonly SafeRenderFact[];
  readonly safety: readonly Pick<ResultSafetyNote, "severity" | "code" | "message">[];
  readonly suggestedPlainText: string | null;
  readonly modelPolishUseful: boolean;
  readonly session: ResultSessionDirective;
  readonly renderContext?: SafeRenderContext;
}
