import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import type { AppConfig } from "./config.js";
import { memoryClaimHashes } from "./memory-claim.js";
import {
  redactEvidenceTombstone,
  redactMemoryTombstone,
} from "./memory-redaction.js";
import { type EvidenceRecord, isoString, type MemoryRecord, parseMemoryRecord } from "./memory-schema.js";
import { MemoryStore, memoryStorePath } from "./memory-store.js";
import { optionalString, requiredString } from "./value-guards.js";
import { householdOwner } from "./household.js";

export type MemoryReviewActionType = "approve" | "edit" | "delete" | "redact" | "ignore";

export interface MemoryReviewItem {
  readonly schemaVersion: 1;
  readonly reviewId: string;
  readonly memory: MemoryRecord;
  readonly reason: string;
  readonly queuedAt: string;
  readonly priority: number;
  readonly sensitive: boolean;
  readonly status: "queued" | "resolved";
  readonly resolvedAt?: string;
  readonly resolution?: MemoryReviewActionType;
}

export interface MemoryReviewAction {
  readonly reviewId: string;
  readonly action: MemoryReviewActionType;
  readonly operatorId: string;
  readonly decidedAt: string;
  readonly editedMemory?: MemoryRecord;
  readonly note?: string;
}

export interface MemoryReviewAuditEntry {
  readonly schemaVersion: 1;
  readonly auditId: string;
  readonly reviewId: string;
  readonly memoryId: string;
  readonly action: MemoryReviewActionType;
  readonly operatorId: string;
  readonly decidedAt: string;
  readonly previousStatus: MemoryRecord["reviewStatus"];
  readonly newStatus: MemoryRecord["reviewStatus"];
  readonly note?: string;
}

export interface MemoryReviewDecision {
  readonly item: MemoryReviewItem;
  readonly memory: MemoryRecord;
  readonly audit: MemoryReviewAuditEntry;
}

export function memoryReviewAuditPath(config: Pick<AppConfig, "dataDir">): string {
  return join(config.dataDir, "memory", "review-audit.jsonl");
}

export function buildMemoryReviewItem(input: {
  readonly reviewId: string;
  readonly memory: MemoryRecord;
  readonly reason: string;
  readonly queuedAt: string;
  readonly priority?: number;
}): MemoryReviewItem {
  const memory = parseMemoryRecord(input.memory);
  const item = {
    schemaVersion: 1 as const,
    reviewId: requiredString(input.reviewId, "memory review reviewId"),
    memory,
    reason: requiredString(input.reason, "memory review reason"),
    queuedAt: isoString(input.queuedAt, "memory review queuedAt"),
    priority: priorityValue(input.priority ?? 0),
    sensitive: !memory.sensitivity.includes("none"),
    status: "queued" as const,
  };
  validateMemoryReviewItem(item);
  return item;
}

export function applyMemoryReviewAction(item: MemoryReviewItem, action: MemoryReviewAction): MemoryReviewDecision {
  validateMemoryReviewItem(item);
  validateMemoryReviewAction(action);
  if (item.status !== "queued") {
    throw new Error("memory review item is already resolved");
  }
  if (item.reviewId !== action.reviewId) {
    throw new Error("memory review action reviewId must match item");
  }

  const memory = memoryForAction(item.memory, action);
  const resolvedItem = {
    ...item,
    status: "resolved" as const,
    resolvedAt: action.decidedAt,
    resolution: action.action,
  };
  const audit = {
    schemaVersion: 1 as const,
    auditId: `memory-review-${item.reviewId}-${action.action}`,
    reviewId: item.reviewId,
    memoryId: item.memory.id,
    action: action.action,
    operatorId: action.operatorId,
    decidedAt: action.decidedAt,
    previousStatus: item.memory.reviewStatus,
    newStatus: memory.reviewStatus,
    ...(action.note ? { note: action.note } : {}),
  };
  validateMemoryReviewItem(resolvedItem);
  validateMemoryReviewAuditEntry(audit);
  return {
    item: resolvedItem,
    memory,
    audit,
  };
}

export function appendMemoryReviewAuditEntry(filePath: string, entry: MemoryReviewAuditEntry): void {
  validateMemoryReviewAuditEntry(entry);
  const existing = readMemoryReviewAuditEntries(filePath)
    .find((candidate) => candidate.auditId === entry.auditId);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(entry)) {
      throw new Error(`memory review audit mismatch for ${entry.auditId}`);
    }
    return;
  }
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(filePath, 0o600);
}

export function readMemoryReviewAuditEntries(filePath: string): MemoryReviewAuditEntry[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const content = readFileSync(filePath, "utf8").trim();
  if (!content) {
    return [];
  }
  return content.split("\n").map((line) => {
    const entry = JSON.parse(line) as MemoryReviewAuditEntry;
    validateMemoryReviewAuditEntry(entry);
    return entry;
  });
}

export function validateMemoryReviewItem(item: MemoryReviewItem): void {
  if (item.schemaVersion !== 1) {
    throw new Error("memory review item schemaVersion must be 1");
  }
  requiredString(item.reviewId, "memory review reviewId");
  parseMemoryRecord(item.memory);
  requiredString(item.reason, "memory review reason");
  isoString(item.queuedAt, "memory review queuedAt");
  priorityValue(item.priority);
  if (item.status !== "queued" && item.status !== "resolved") {
    throw new Error(`memory review status is unsupported: ${String(item.status)}`);
  }
  if (item.status === "resolved") {
    isoString(item.resolvedAt, "memory review resolvedAt");
    if (!item.resolution) {
      throw new Error("memory review resolution is required when resolved");
    }
  }
}

function validateMemoryReviewAction(action: MemoryReviewAction): void {
  requiredString(action.reviewId, "memory review action reviewId");
  if (!["approve", "edit", "delete", "redact", "ignore"].includes(action.action)) {
    throw new Error(`memory review action is unsupported: ${String(action.action)}`);
  }
  requiredString(action.operatorId, "memory review action operatorId");
  isoString(action.decidedAt, "memory review action decidedAt");
  if (action.action === "edit" && !action.editedMemory) {
    throw new Error("memory review edit requires editedMemory");
  }
}

function validateMemoryReviewAuditEntry(entry: MemoryReviewAuditEntry): void {
  if (entry.schemaVersion !== 1) {
    throw new Error("memory review audit schemaVersion must be 1");
  }
  requiredString(entry.auditId, "memory review auditId");
  requiredString(entry.reviewId, "memory review audit reviewId");
  requiredString(entry.memoryId, "memory review audit memoryId");
  requiredString(entry.operatorId, "memory review audit operatorId");
  isoString(entry.decidedAt, "memory review audit decidedAt");
}

function memoryForAction(memory: MemoryRecord, action: MemoryReviewAction): MemoryRecord {
  switch (action.action) {
    case "approve":
      return acceptReviewedMemory(memory, action.decidedAt);
    case "edit": {
      const editedMemory = action.editedMemory;
      if (!editedMemory) {
        throw new Error("memory review edit requires editedMemory");
      }
      return acceptReviewedMemory(editedMemory, action.decidedAt);
    }
    case "delete":
      return scrubbedMemory(memory, "deleted", action.decidedAt);
    case "redact":
      return scrubbedMemory(memory, "redacted", action.decidedAt);
    case "ignore":
      return parseMemoryRecord({ ...memory, reviewStatus: "rejected", updatedAt: action.decidedAt });
  }
}

function acceptReviewedMemory(memory: MemoryRecord, decidedAt: string): MemoryRecord {
  const resolvesConflict = memory.reviewStatus === "needs_clarification"
    || memory.contradictionCount > 0
    || memory.contradictedByIds.length > 0;
  const accepted = {
    reviewStatus: "accepted" as const,
    updatedAt: decidedAt,
    reviewAfter: undefined,
    ...(resolvesConflict
      ? {
          contradictionCount: 0,
          contradictedByIds: [] as readonly string[],
          supersedesIds: [...new Set([
            ...memory.supersedesIds,
            ...memory.contradictedByIds,
          ])],
        }
      : {}),
  };
  if (memory.category === "routine" && memory.payload.category === "routine") {
    return parseMemoryRecord({
      ...memory,
      ...accepted,
      payload: {
        ...memory.payload,
        eligibleForReasoning: true,
      },
    });
  }
  return parseMemoryRecord({ ...memory, ...accepted });
}

function scrubbedMemory(
  memory: MemoryRecord,
  status: "deleted" | "redacted",
  decidedAt: string,
): MemoryRecord {
  return redactMemoryTombstone(memory, status, decidedAt);
}

export function scrubMemoryEvidence(
  evidence: EvidenceRecord,
  status: "deleted" | "redacted",
  decidedAt: string,
): EvidenceRecord {
  return redactEvidenceTombstone(evidence, status, decidedAt);
}

function priorityValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error("memory review priority must be an integer from 0 to 100");
  }
  return value;
}

export interface MemoryReviewNextResponse {
  readonly ok: true;
  readonly enabled: boolean;
  readonly item: MemoryReviewDisplayItem | null;
  readonly remaining: number;
}

interface MemoryReviewDisplayItem extends MemoryReviewItem {
  readonly evidence: readonly EvidenceRecord[];
}

interface MemoryReviewDecisionResponse {
  readonly ok: true;
  readonly action: MemoryReviewActionType;
  readonly memoryId: string;
  readonly previousStatus: MemoryRecord["reviewStatus"];
  readonly newStatus: MemoryRecord["reviewStatus"];
  readonly next: MemoryReviewNextResponse;
}

export interface StoredMemoryItem {
  readonly id: string;
  readonly category: MemoryRecord["category"];
  readonly title: string;
  readonly summary: string;
  readonly updatedAt: string;
}

export function storedMemoryItems(config: AppConfig): readonly StoredMemoryItem[] {
  const store = new MemoryStore(memoryStorePath(config));
  try {
    return store.listMemoryRecords()
      .filter((memory) => memory.reviewStatus === "accepted")
      .map(({ id, category, title, summary, updatedAt }) => ({ id, category, title, summary, updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  } finally {
    store.close();
  }
}

export function nextMemoryReviewResponse(config: AppConfig): MemoryReviewNextResponse {
  const store = new MemoryStore(memoryStorePath(config));
  try {
    const snapshot = store.refreshSnapshot();
    const queue = snapshot.reviewQueue
      .filter((memory) =>
        !blockedByClaimTombstone(memory, snapshot.records)
      )
      .map((memory) => reviewDisplayItemForMemory(store, memory));
    queue.sort((a, b) => b.priority - a.priority || a.queuedAt.localeCompare(b.queuedAt) || a.reviewId.localeCompare(b.reviewId));
    return {
      ok: true,
      enabled: true,
      item: queue[0] ?? null,
      remaining: queue.length,
    };
  } finally {
    store.close();
  }
}

export function disabledMemoryReviewResponse(): MemoryReviewNextResponse {
  return {
    ok: true,
    enabled: false,
    item: null,
    remaining: 0,
  };
}

export function applyMemoryReviewDecision(
  config: AppConfig,
  raw: unknown,
  decidedAt: Date,
): MemoryReviewDecisionResponse {
  const request = parseMemoryReviewDecisionRequest(raw);
  const store = new MemoryStore(memoryStorePath(config));
  try {
    const memoryId = request.reviewId.replace(/^review-/, "");
    const decidedAtIso = decidedAt.toISOString();
    const committed = store.applyMemoryMutationAtomically<MemoryReviewAuditEntry>({
      mutationId: memoryReviewMutationId(request),
      memoryId,
      committedAt: decidedAtIso,
    }, (memory, evidenceRecords) => {
      if (memory.reviewStatus !== "queued" && memory.reviewStatus !== "needs_clarification") {
        throw new Error("memory review item is no longer queued");
      }
      const item = reviewItemForMemory(memory);
      if (item.reviewId !== request.reviewId) {
        throw new Error("memory review item mismatch");
      }
      const edited = request.action === "edit"
        ? editedMemory(memory, request)
        : null;
      if (
        (request.action === "approve" || request.action === "edit")
        && blockedByClaimTombstone(
          edited ?? memory,
          store.listMemoryRecords(),
        )
      ) {
        throw new Error(
          "memory claim is blocked by a redacted or deleted tombstone",
        );
      }
      const decision = applyMemoryReviewAction(item, {
        reviewId: request.reviewId,
        action: request.action,
        operatorId: config.cognitiveOperatorActorId,
        decidedAt: decidedAtIso,
        ...(request.note
            && request.action !== "delete"
            && request.action !== "redact"
          ? { note: request.note }
          : {}),
        ...(edited ? { editedMemory: edited } : {}),
      });
      const evidenceRemovalStatus = request.action === "delete"
        ? "deleted"
        : request.action === "redact"
          ? "redacted"
          : null;
      const removal = evidenceRemovalStatus
        ? removalMutationRecords(
            store,
            decision.memory,
            evidenceRecords,
            evidenceRemovalStatus,
            decidedAtIso,
          )
        : null;
      const conflictResolution = !removal
        && (request.action === "approve" || request.action === "edit")
        ? resolveReviewedMemoryConflict(
            store,
            memory,
            decision.memory,
            decidedAtIso,
          )
        : null;
      return {
        memory: removal?.memory ?? conflictResolution?.memory ?? decision.memory,
        relatedMemoryRecords: conflictResolution?.relatedMemoryRecords ?? [],
        evidenceRecords: removal?.evidenceRecords ?? [],
        result: decision.audit,
      };
    });
    const audit = committed.result;
    appendMemoryReviewAuditEntry(memoryReviewAuditPath(config), audit);
    return {
      ok: true,
      action: audit.action,
      memoryId: audit.memoryId,
      previousStatus: audit.previousStatus,
      newStatus: audit.newStatus,
      next: nextMemoryReviewResponse(config),
    };
  } finally {
    store.close();
  }
}

interface ParsedMemoryRemovalRequest {
  readonly memoryId: string;
  readonly action: "delete" | "redact";
  readonly note?: string;
}

export function applyAcceptedMemoryRemoval(
  config: AppConfig,
  raw: unknown,
  decidedAt: Date,
): Omit<MemoryReviewDecisionResponse, "next"> {
  const request = parseMemoryRemovalRequest(raw);
  const decidedAtIso = decidedAt.toISOString();
  const reviewId = `removal-${request.memoryId}`;
  const store = new MemoryStore(memoryStorePath(config));
  try {
    const committed = store.applyMemoryMutationAtomically<MemoryReviewAuditEntry>({
      mutationId: `memory-removal-${request.memoryId}-${request.action}`,
      memoryId: request.memoryId,
      committedAt: decidedAtIso,
    }, (memory, evidenceRecords) => {
      if (memory.reviewStatus === "deleted" || memory.reviewStatus === "redacted") {
        throw new Error("memory record is already removed");
      }
      const decision = applyMemoryReviewAction(buildMemoryReviewItem({
        reviewId,
        memory,
        reason: "Authenticated operator removal",
        queuedAt: decidedAtIso,
        priority: 100,
      }), {
        reviewId,
        action: request.action,
        operatorId: config.cognitiveOperatorActorId,
        decidedAt: decidedAtIso,
      });
      const removal = removalMutationRecords(
        store,
        decision.memory,
        evidenceRecords,
        removalStatus(request.action),
        decidedAtIso,
      );
      return {
        memory: removal.memory,
        evidenceRecords: removal.evidenceRecords,
        result: decision.audit,
      };
    });
    const audit = committed.result;
    appendMemoryReviewAuditEntry(memoryReviewAuditPath(config), audit);
    return {
      ok: true,
      action: audit.action,
      memoryId: audit.memoryId,
      previousStatus: audit.previousStatus,
      newStatus: audit.newStatus,
    };
  } finally {
    store.close();
  }
}

function parseMemoryRemovalRequest(raw: unknown): ParsedMemoryRemovalRequest {
  if (!raw || typeof raw !== "object") {
    throw new Error("memory removal body must be an object");
  }
  const input = raw as Record<string, unknown>;
  const action = input.action;
  if (action !== "delete" && action !== "redact") {
    throw new Error("memory removal action is unsupported");
  }
  return {
    memoryId: requiredString(input.memoryId, "memoryId"),
    action,
    ...(optionalString(input.note) ? { note: optionalString(input.note) as string } : {}),
  };
}

function removalStatus(action: "delete" | "redact"): "deleted" | "redacted" {
  return action === "delete" ? "deleted" : "redacted";
}

function resolveReviewedMemoryConflict(
  store: MemoryStore,
  original: MemoryRecord,
  accepted: MemoryRecord,
  decidedAt: string,
): {
  readonly memory: MemoryRecord;
  readonly relatedMemoryRecords: readonly MemoryRecord[];
} {
  const directConflictIds = new Set(original.contradictedByIds);
  const acceptedClaimHashes = new Set(memoryClaimHashes(accepted));
  const resolvesEpisodicClaim = accepted.category === "episodic";
  const related = store.listMemoryRecords().filter((record) =>
    record.id !== original.id
    && record.reviewStatus !== "deleted"
    && record.reviewStatus !== "redacted"
    && record.reviewStatus !== "rejected"
    && (
      directConflictIds.has(record.id)
      || record.contradictedByIds.includes(original.id)
      || (
        resolvesEpisodicClaim
        && memoryClaimHashes(record).some((hash) =>
          acceptedClaimHashes.has(hash)
        )
      )
    )
  );
  if (
    original.reviewStatus !== "needs_clarification"
    && original.contradictionCount === 0
    && original.contradictedByIds.length === 0
    && related.length === 0
  ) {
    return { memory: accepted, relatedMemoryRecords: [] };
  }
  const relatedIds = related.map((record) => record.id);
  return {
    memory: parseMemoryRecord({
      ...accepted,
      reviewStatus: "accepted",
      contradictionCount: 0,
      contradictedByIds: [],
      supersedesIds: [...new Set([
        ...accepted.supersedesIds,
        ...relatedIds,
      ])],
      reviewAfter: undefined,
      updatedAt: decidedAt,
    }),
    relatedMemoryRecords: related.map((record) => {
      const contradictedByIds = [...new Set([
        ...record.contradictedByIds,
        original.id,
      ])];
      return parseMemoryRecord({
        ...record,
        reviewStatus: "rejected",
        contradictionCount: Math.max(
          record.contradictionCount,
          contradictedByIds.length,
        ),
        contradictedByIds,
        reviewAfter: undefined,
        updatedAt: decidedAt,
      });
    }),
  };
}

function removalMutationRecords(
  store: MemoryStore,
  memory: MemoryRecord,
  evidenceRecords: readonly EvidenceRecord[],
  status: "deleted" | "redacted",
  decidedAt: string,
): {
  readonly memory: MemoryRecord;
  readonly evidenceRecords: readonly EvidenceRecord[];
} {
  const referencedElsewhere = new Set(
    store.listMemoryRecords()
      .filter((record) =>
        record.id !== memory.id
        && record.reviewStatus !== "deleted"
        && record.reviewStatus !== "redacted"
      )
      .flatMap((record) => record.evidenceIds),
  );
  const exclusiveEvidence = evidenceRecords.filter((evidence) =>
    !referencedElsewhere.has(evidence.id)
  );
  const evidenceIds = exclusiveEvidence.map((evidence) => evidence.id);
  return {
    memory: parseMemoryRecord({
      ...memory,
      evidenceIds,
      evidenceCount: evidenceIds.length,
    }),
    evidenceRecords: exclusiveEvidence.map((evidence) =>
      scrubMemoryEvidence(evidence, status, decidedAt)
    ),
  };
}

interface ParsedMemoryReviewDecisionRequest {
  readonly reviewId: string;
  readonly action: MemoryReviewActionType;
  readonly note?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly value?: string;
  readonly outcome?: string;
  readonly occurredAt?: string;
}

function parseMemoryReviewDecisionRequest(raw: unknown): ParsedMemoryReviewDecisionRequest {
  if (!raw || typeof raw !== "object") {
    throw new Error("memory review decision body must be an object");
  }
  const input = raw as Record<string, unknown>;
  const reviewId = requiredString(input.reviewId, "reviewId");
  const action = input.action;
  if (action !== "approve" && action !== "edit" && action !== "ignore" && action !== "delete" && action !== "redact") {
    throw new Error("memory review action is unsupported");
  }
  const outcome = input.outcome === undefined
    ? null
    : requiredString(input.outcome, "outcome");
  const occurredAt = input.occurredAt === undefined
    ? null
    : canonicalReviewTimestamp(input.occurredAt, "occurredAt");
  if (action !== "edit" && (outcome !== null || occurredAt !== null)) {
    throw new Error("episodic edit fields require the edit action");
  }
  return {
    reviewId,
    action,
    ...(optionalString(input.note) ? { note: optionalString(input.note) as string } : {}),
    ...(optionalString(input.title) ? { title: optionalString(input.title) as string } : {}),
    ...(optionalString(input.summary) ? { summary: optionalString(input.summary) as string } : {}),
    ...(optionalString(input.value) ? { value: optionalString(input.value) as string } : {}),
    ...(outcome !== null ? { outcome } : {}),
    ...(occurredAt !== null ? { occurredAt } : {}),
  };
}

function reviewItemForMemory(memory: MemoryRecord): MemoryReviewItem {
  return buildMemoryReviewItem({
    reviewId: `review-${memory.id}`,
    memory,
    reason: memory.reviewStatus === "needs_clarification" ? "Needs clarification" : `Queued for ${householdOwner()?.name ?? "owner"} review`,
    queuedAt: memory.createdAt,
    priority: memory.sensitivity.includes("child") || memory.sensitivity.includes("private") ? 80 : 40,
  });
}

function reviewDisplayItemForMemory(store: MemoryStore, memory: MemoryRecord): MemoryReviewDisplayItem {
  return {
    ...reviewItemForMemory(memory),
    evidence: memory.evidenceIds
      .map((id) => store.getEvidenceRecord(id))
      .filter((record): record is EvidenceRecord => Boolean(record)),
  };
}

function editedMemory(memory: MemoryRecord, request: ParsedMemoryReviewDecisionRequest): MemoryRecord {
  const title = request.title ?? memory.title;
  const summary = request.summary ?? memory.summary;
  let payload = memory.payload;
  if (memory.payload.category === "episodic") {
    if (!request.outcome) {
      throw new Error("episodic memory edit requires outcome");
    }
    if (request.value !== undefined) {
      throw new Error("preference value is invalid for an episodic memory edit");
    }
    payload = {
      ...memory.payload,
      outcome: request.outcome,
      ...(request.occurredAt ? { occurredAt: request.occurredAt } : {}),
    };
  } else {
    if (request.outcome !== undefined || request.occurredAt !== undefined) {
      throw new Error("episodic edit fields require an episodic memory");
    }
    if (request.value && memory.payload.category === "preference") {
      payload = { ...memory.payload, value: request.value };
    }
  }
  return {
    ...memory,
    title,
    summary,
    payload,
    tags: memory.tags,
  };
}

function memoryReviewMutationId(
  request: ParsedMemoryReviewDecisionRequest,
): string {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(request), "utf8")
    .digest("hex")
    .slice(0, 20);
  return `memory-review-${request.reviewId}-${request.action}-${fingerprint}`;
}

function blockedByClaimTombstone(
  memory: MemoryRecord,
  records: readonly MemoryRecord[],
): boolean {
  const claimHashes = new Set(memoryClaimHashes(memory));
  if (claimHashes.size === 0) return false;
  return records.some((candidate) =>
    candidate.id !== memory.id
    && (
      candidate.reviewStatus === "redacted"
      || candidate.reviewStatus === "deleted"
    )
    && memoryClaimHashes(candidate).some((hash) => claimHashes.has(hash))
  );
}

function canonicalReviewTimestamp(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)) {
    throw new Error(`${label} must be a canonical UTC ISO-8601 timestamp`);
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== text) {
    throw new Error(`${label} must be a valid calendar timestamp`);
  }
  return text;
}
