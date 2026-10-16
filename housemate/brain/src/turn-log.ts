import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { AppConfig } from "./config.js";
import { validateTurnPaceLog, type TurnPaceLog } from "./turn-pace.js";

export type TurnChannel = "chat" | "voice" | "system" | "test";
// "disconnected": the voice client hung up before the turn finished; the
// response text is only what had already been committed to speech.
export type TurnOutcome = "ok" | "clarify" | "declined" | "error" | "disconnected";

export interface TurnRepairCandidate {
  readonly entityId: string;
  readonly areaId: string | null;
  readonly areaName: string | null;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface TurnRepairHint {
  readonly kind: "target_resolution";
  readonly route?: string;
  readonly phrase: string;
  readonly room: string | null;
  readonly targetQuery: string;
  readonly parserArea: string | null;
  readonly domain: string | null;
  readonly capability: string | null;
  readonly confidence: "none" | "ambiguous";
  readonly reason: string;
  readonly rejectedCount: number;
  readonly candidates: readonly TurnRepairCandidate[];
}

export interface TurnAnswerExplanation {
  readonly route: string;
  readonly confidence: "low" | "medium" | "high";
  readonly reason: string;
  readonly sourceSummary: string;
  readonly sourceLabels: readonly string[];
  readonly sourceEntityIds: readonly string[];
  readonly actionBoundary: string;
  readonly targetLabel?: string | null;
}

export interface TurnLogEntry {
  readonly schemaVersion: 1;
  readonly turnId: string;
  readonly timestamp: string;
  readonly channel: TurnChannel;
  readonly transcript?: string;
  readonly transcriptConfidence?: number | null;
  readonly responseText?: string;
  readonly room?: string | null;
  readonly sourceVia?: string | null;
  readonly sessionId?: string | null;
  readonly conversationMode?: boolean;
  readonly speakerName?: string | null;
  readonly speakerVoiceId?: string | null;
  readonly speakerConfidence?: number | null;
  readonly speakerTrustedActorId?: string | null;
  readonly speakerIdentitySource?: "none" | "ha_ingress" | "api_token";
  readonly route: string;
  readonly outcome: TurnOutcome;
  readonly modelUsed: boolean;
  readonly latencyMs: number;
  readonly actionTouchedEntities: readonly string[];
  readonly notes?: string;
  readonly repair?: TurnRepairHint;
  readonly explanation?: TurnAnswerExplanation;
  /** Time to first spoken words and the model's share of it (numbers only). */
  readonly pace?: TurnPaceLog;
}

export function turnLogPath(config: Pick<AppConfig, "dataDir">): string {
  return join(config.dataDir, "logs", "turns.jsonl");
}

export function appendTurnLogEntry(filePath: string, entry: TurnLogEntry): void {
  validateTurnLogEntry(entry);
  secureTurnLogStorage(filePath);
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(filePath, 0o600);
}

export function secureTurnLogStorage(filePath: string): void {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (existsSync(filePath)) {
    chmodSync(filePath, 0o600);
  }
}

export function readTurnLogEntries(filePath: string): TurnLogEntry[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const content = readFileSync(filePath, "utf8").trim();
  if (!content) {
    return [];
  }
  return content.split("\n").map((line) => {
    const entry = JSON.parse(line) as TurnLogEntry;
    validateTurnLogEntry(entry);
    return entry;
  });
}

export function validateTurnLogEntry(entry: TurnLogEntry): void {
  if (entry.schemaVersion !== 1) {
    throw new Error("turn log schemaVersion must be 1");
  }
  if (!entry.turnId.trim()) {
    throw new Error("turn log turnId is required");
  }
  if (Number.isNaN(Date.parse(entry.timestamp))) {
    throw new Error("turn log timestamp must be ISO-like");
  }
  if (!Number.isFinite(entry.latencyMs) || entry.latencyMs < 0) {
    throw new Error("turn log latencyMs must be non-negative");
  }
  validateOptionalString(entry.transcript, "transcript");
  if (
    entry.transcriptConfidence !== undefined
    && entry.transcriptConfidence !== null
    && (
      !Number.isFinite(entry.transcriptConfidence)
      || entry.transcriptConfidence < 0
      || entry.transcriptConfidence > 1
    )
  ) {
    throw new Error("turn log transcriptConfidence must be null or a number from 0 to 1");
  }
  validateOptionalString(entry.responseText, "responseText");
  validateOptionalNullableString(entry.room, "room");
  validateOptionalNullableString(entry.sourceVia, "sourceVia");
  validateOptionalNullableString(entry.sessionId, "sessionId");
  validateOptionalNullableString(entry.speakerName, "speakerName");
  validateOptionalNullableString(entry.speakerVoiceId, "speakerVoiceId");
  validateOptionalNullableString(entry.speakerTrustedActorId, "speakerTrustedActorId");
  if (
    entry.speakerIdentitySource !== undefined
    && entry.speakerIdentitySource !== "none"
    && entry.speakerIdentitySource !== "ha_ingress"
    && entry.speakerIdentitySource !== "api_token"
  ) {
    throw new Error("turn log speakerIdentitySource is unsupported");
  }
  if (entry.conversationMode !== undefined && typeof entry.conversationMode !== "boolean") {
    throw new Error("turn log conversationMode must be boolean");
  }
  if (
    entry.speakerConfidence !== undefined &&
    entry.speakerConfidence !== null &&
    (!Number.isFinite(entry.speakerConfidence) || entry.speakerConfidence < 0 || entry.speakerConfidence > 1)
  ) {
    throw new Error("turn log speakerConfidence must be null or a number from 0 to 1");
  }
  if (entry.repair) {
    validateRepairHint(entry.repair);
  }
  if (entry.explanation) {
    validateAnswerExplanation(entry.explanation);
  }
  if (entry.pace) {
    validateTurnPaceLog(entry.pace);
  }
}

function validateOptionalString(value: string | undefined, label: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`turn log ${label} must be a string`);
  }
}

function validateOptionalNullableString(value: string | null | undefined, label: string): void {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new Error(`turn log ${label} must be null or a string`);
  }
}

function validateRepairHint(repair: TurnRepairHint): void {
  if (repair.kind !== "target_resolution") {
    throw new Error("turn log repair kind is unsupported");
  }
  if (!repair.phrase.trim()) {
    throw new Error("turn log repair phrase is required");
  }
  if (!repair.targetQuery.trim()) {
    throw new Error("turn log repair targetQuery is required");
  }
  if (!repair.reason.trim()) {
    throw new Error("turn log repair reason is required");
  }
  if (repair.confidence !== "none" && repair.confidence !== "ambiguous") {
    throw new Error("turn log repair confidence is unsupported");
  }
  if (!Number.isInteger(repair.rejectedCount) || repair.rejectedCount < 0) {
    throw new Error("turn log repair rejectedCount must be non-negative");
  }
  for (const candidate of repair.candidates) {
    if (!candidate.entityId.trim()) {
      throw new Error("turn log repair candidate entityId is required");
    }
    if (!Number.isFinite(candidate.score)) {
      throw new Error("turn log repair candidate score must be finite");
    }
  }
}

function validateAnswerExplanation(explanation: TurnAnswerExplanation): void {
  if (!explanation.route.trim()) {
    throw new Error("turn log explanation route is required");
  }
  if (explanation.confidence !== "low" && explanation.confidence !== "medium" && explanation.confidence !== "high") {
    throw new Error("turn log explanation confidence is unsupported");
  }
  if (!explanation.reason.trim()) {
    throw new Error("turn log explanation reason is required");
  }
  if (!explanation.sourceSummary.trim()) {
    throw new Error("turn log explanation sourceSummary is required");
  }
  if (!explanation.actionBoundary.trim()) {
    throw new Error("turn log explanation actionBoundary is required");
  }
  for (const label of explanation.sourceLabels) {
    if (!label.trim()) {
      throw new Error("turn log explanation sourceLabels must not contain empty values");
    }
  }
  for (const entityId of explanation.sourceEntityIds) {
    if (!entityId.trim()) {
      throw new Error("turn log explanation sourceEntityIds must not contain empty values");
    }
  }
  validateOptionalNullableString(explanation.targetLabel, "explanation targetLabel");
}
