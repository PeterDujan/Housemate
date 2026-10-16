import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  parseEvidenceRecord,
  parseMemoryRecord,
  type EvidenceRecord,
  type JsonValue,
  type MemoryCategory,
  type MemoryRecord,
  type MemoryTier,
  type ReviewStatus,
} from "./memory-schema.js";
import { enrichMemorySalience } from "./memory-salience.js";
import { ensureMetaSchemaVersion, inTransaction, openPrivateDatabase } from "./sqlite-store.js";

export const MEMORY_STORE_SCHEMA_VERSION = 1;

export interface MemoryStoreSnapshot {
  readonly records: readonly MemoryRecord[];
  readonly byId: ReadonlyMap<string, MemoryRecord>;
  readonly byCategory: ReadonlyMap<MemoryCategory, readonly MemoryRecord[]>;
  readonly byTier: ReadonlyMap<MemoryTier, readonly MemoryRecord[]>;
  readonly bySubjectId: ReadonlyMap<string, readonly MemoryRecord[]>;
  readonly byReviewStatus: ReadonlyMap<ReviewStatus, readonly MemoryRecord[]>;
  readonly reviewQueue: readonly MemoryRecord[];
}

interface MemoryRow {
  readonly record_json: string;
}

interface EvidenceRow {
  readonly record_json: string;
}

interface MemoryMutationReceiptRow {
  readonly mutation_id: string;
  readonly memory_id: string;
  readonly result_json: string;
  readonly committed_at: string;
}

export interface AtomicMemoryMutation<TResult> {
  readonly memory: MemoryRecord;
  readonly relatedMemoryRecords?: readonly MemoryRecord[];
  readonly evidenceRecords?: readonly EvidenceRecord[];
  readonly result: TResult;
}

export interface AtomicMemoryMutationResult<TResult> {
  readonly result: TResult;
  readonly replayed: boolean;
}

export interface MemoryMutationReceipt {
  readonly mutationId: string;
  readonly memoryId: string;
  readonly result: JsonValue;
  readonly committedAt: string;
}

export function memoryStorePath(config: { readonly dataDir: string }): string {
  return join(config.dataDir, "memory", "memory.sqlite");
}

export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly ownsDb: boolean;

  /** A file path opens its own connection; a database is the household memory's shared one. */
  constructor(source: string | DatabaseSync) {
    this.ownsDb = typeof source === "string";
    this.db = typeof source === "string" ? openMemoryDatabase(source) : source;
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }

  putMemoryRecord(record: MemoryRecord): void {
    const parsed = parseMemoryRecord(record);
    inTransaction(this.db, () => {
      this.writeMemoryRecord(parsed);
    });
  }

  restoreMemoryRecord(record: MemoryRecord): void {
    const parsed = parseMemoryRecord(record);
    inTransaction(this.db, () => {
      this.writeMemoryRecord(parsed, false);
    });
  }

  updateMemoryRecord(
    id: string,
    updater: (current: MemoryRecord) => MemoryRecord | null,
  ): MemoryRecord | null {
    let updated: MemoryRecord | null = null;
    inTransaction(this.db, () => {
      const current = this.getMemoryRecord(id);
      if (!current) {
        return;
      }
      const next = updater(current);
      if (!next) {
        return;
      }
      const parsed = parseMemoryRecord(next);
      if (parsed.id !== id) {
        throw new Error("memory record updater cannot change the record id");
      }
      this.writeMemoryRecord(parsed);
      updated = this.getMemoryRecord(id);
    });
    return updated;
  }

  applyMemoryMutationAtomically<TResult>(
    input: {
      readonly mutationId: string;
      readonly memoryId: string;
      readonly committedAt: string;
    },
    buildMutation: (
      current: MemoryRecord,
      evidenceRecords: readonly EvidenceRecord[],
    ) => AtomicMemoryMutation<TResult>,
  ): AtomicMemoryMutationResult<TResult> {
    const mutationId = requiredIdentifier(input.mutationId, "memory mutation id");
    const memoryId = requiredIdentifier(input.memoryId, "memory mutation memory id");
    if (Number.isNaN(Date.parse(input.committedAt))) {
      throw new Error("memory mutation committedAt must be ISO-like");
    }
    return inTransaction(this.db, () => {
      const existing = this.db
        .prepare(
          `SELECT memory_id, result_json
           FROM memory_mutation_receipts
           WHERE mutation_id = ?`,
        )
        .get(mutationId) as MemoryMutationReceiptRow | undefined;
      if (existing) {
        if (existing.memory_id !== memoryId) {
          throw new Error(`memory mutation receipt mismatch for ${mutationId}`);
        }
        return {
          result: JSON.parse(existing.result_json) as TResult,
          replayed: true,
        };
      }

      const current = this.getMemoryRecord(memoryId);
      if (!current) {
        throw new Error(`memory record not found: ${memoryId}`);
      }
      const currentEvidence = current.evidenceIds
        .map((evidenceId) => this.getEvidenceRecord(evidenceId))
        .filter((record): record is EvidenceRecord => Boolean(record));
      const mutation = buildMutation(current, currentEvidence);
      const memory = parseMemoryRecord(mutation.memory);
      if (memory.id !== memoryId) {
        throw new Error("memory mutation cannot change the record id");
      }
      const relatedMemoryRecords = (mutation.relatedMemoryRecords ?? [])
        .map(parseMemoryRecord);
      const relatedMemoryIds = new Set<string>();
      for (const related of relatedMemoryRecords) {
        if (related.id === memoryId || relatedMemoryIds.has(related.id)) {
          throw new Error("memory mutation related records must be unique and exclude the primary record");
        }
        if (!this.getMemoryRecord(related.id)) {
          throw new Error(`memory mutation related record not found: ${related.id}`);
        }
        relatedMemoryIds.add(related.id);
      }
      const evidenceRecords = (mutation.evidenceRecords ?? [])
        .map(parseEvidenceRecord);
      const linkedEvidenceIds = new Set(current.evidenceIds);
      if (evidenceRecords.some((record) => !linkedEvidenceIds.has(record.id))) {
        throw new Error("memory mutation can only update linked evidence records");
      }
      const resultJson = JSON.stringify(mutation.result);
      if (resultJson === undefined) {
        throw new Error("memory mutation result must be JSON-compatible");
      }

      for (const evidence of evidenceRecords) {
        this.writeEvidenceRecord(evidence);
      }
      for (const related of relatedMemoryRecords) {
        this.writeMemoryRecord(related);
      }
      this.writeMemoryRecord(memory);
      this.db
        .prepare(
          `INSERT INTO memory_mutation_receipts (
            mutation_id,
            memory_id,
            result_json,
            committed_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .run(mutationId, memoryId, resultJson, input.committedAt);
      return {
        result: mutation.result,
        replayed: false,
      };
    });
  }

  getMemoryRecord(id: string): MemoryRecord | null {
    const row = this.db
      .prepare("SELECT record_json FROM memory_records WHERE id = ?")
      .get(id) as MemoryRow | undefined;
    return row ? parseMemoryRecord(JSON.parse(row.record_json)) : null;
  }

  listMemoryRecords(): readonly MemoryRecord[] {
    const rows = this.db
      .prepare("SELECT record_json FROM memory_records ORDER BY updated_at DESC, id ASC")
      .all() as unknown as MemoryRow[];
    return rows.map((row) => parseMemoryRecord(JSON.parse(row.record_json)));
  }

  putEvidenceRecord(record: EvidenceRecord): void {
    const parsed = parseEvidenceRecord(record);
    inTransaction(this.db, () => {
      this.writeEvidenceRecord(parsed);
    });
  }

  getEvidenceRecord(id: string): EvidenceRecord | null {
    const row = this.db
      .prepare("SELECT record_json FROM evidence_records WHERE id = ?")
      .get(id) as EvidenceRow | undefined;
    return row ? parseEvidenceRecord(JSON.parse(row.record_json)) : null;
  }

  listEvidenceRecords(): readonly EvidenceRecord[] {
    const rows = this.db
      .prepare("SELECT record_json FROM evidence_records ORDER BY ingested_at DESC, id ASC")
      .all() as unknown as EvidenceRow[];
    return rows.map((row) => parseEvidenceRecord(JSON.parse(row.record_json)));
  }

  listMemoryMutationReceipts(): readonly MemoryMutationReceipt[] {
    const rows = this.db
      .prepare(
        `SELECT mutation_id, memory_id, result_json, committed_at
         FROM memory_mutation_receipts
         ORDER BY committed_at ASC, mutation_id ASC`,
      )
      .all() as unknown as MemoryMutationReceiptRow[];
    return rows.map(parseMemoryMutationReceiptRow);
  }

  refreshSnapshot(): MemoryStoreSnapshot {
    const records = this.listMemoryRecords();
    return {
      records,
      byId: new Map(records.map((record) => [record.id, record])),
      byCategory: mapBy(records, (record) => [record.category]),
      byTier: mapBy(records, (record) => [record.tier]),
      bySubjectId: mapBy(records, (record) => record.subjectIds),
      byReviewStatus: mapBy(records, (record) => [record.reviewStatus]),
      reviewQueue: records.filter((record) =>
        record.reviewStatus === "queued" || record.reviewStatus === "needs_clarification"
      ),
    };
  }

  private writeMemoryRecord(parsed: MemoryRecord, enrich = true): void {
    const previous = this.getMemoryRecord(parsed.id);
    const terminal = parsed.reviewStatus === "redacted"
      || parsed.reviewStatus === "deleted";
    const enriched = terminal || !enrich
      ? parsed
      : enrichMemorySalience(parsed, {
          previous,
          evidenceRecords: parsed.evidenceIds
            .map((evidenceId) => this.getEvidenceRecord(evidenceId))
            .filter((evidence): evidence is EvidenceRecord => Boolean(evidence)),
        });
    this.db
      .prepare(
        `INSERT INTO memory_records (
          id,
          category,
          tier,
          scope,
          review_status,
          confidence,
          source_reliability,
          retrieval_strength,
          storage_strength,
          updated_at,
          subject_ids_json,
          sensitivity_json,
          record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          category = excluded.category,
          tier = excluded.tier,
          scope = excluded.scope,
          review_status = excluded.review_status,
          confidence = excluded.confidence,
          source_reliability = excluded.source_reliability,
          retrieval_strength = excluded.retrieval_strength,
          storage_strength = excluded.storage_strength,
          updated_at = excluded.updated_at,
          subject_ids_json = excluded.subject_ids_json,
          sensitivity_json = excluded.sensitivity_json,
          record_json = excluded.record_json`,
      )
      .run(
        enriched.id,
        enriched.category,
        enriched.tier,
        enriched.scope,
        enriched.reviewStatus,
        enriched.confidence,
        enriched.sourceReliability,
        enriched.retrievalStrength,
        enriched.storageStrength,
        enriched.updatedAt,
        JSON.stringify(enriched.subjectIds),
        JSON.stringify(enriched.sensitivity),
        JSON.stringify(enriched),
      );
    this.db.prepare("DELETE FROM memory_subject_index WHERE memory_id = ?").run(enriched.id);
    const insertSubject = this.db.prepare(
      "INSERT INTO memory_subject_index (memory_id, subject_id) VALUES (?, ?)",
    );
    for (const subjectId of enriched.subjectIds) {
      insertSubject.run(enriched.id, subjectId);
    }
  }

  private writeEvidenceRecord(parsed: EvidenceRecord): void {
    this.db
      .prepare(
        `INSERT INTO evidence_records (
          id,
          source_type,
          observed_at,
          ingested_at,
          subject_ids_json,
          record_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_type = excluded.source_type,
          observed_at = excluded.observed_at,
          ingested_at = excluded.ingested_at,
          subject_ids_json = excluded.subject_ids_json,
          record_json = excluded.record_json`,
      )
      .run(
        parsed.id,
        parsed.sourceType,
        parsed.observedAt,
        parsed.ingestedAt,
        JSON.stringify(parsed.subjectIds),
        JSON.stringify(parsed),
      );
    this.db.prepare("DELETE FROM evidence_subject_index WHERE evidence_id = ?").run(parsed.id);
    const insertSubject = this.db.prepare(
      "INSERT INTO evidence_subject_index (evidence_id, subject_id) VALUES (?, ?)",
    );
    for (const subjectId of parsed.subjectIds) {
      insertSubject.run(parsed.id, subjectId);
    }
  }
}

/** The household memory database (`memory/memory.sqlite`): owner-only, records and evidence tables ready. */
export function openMemoryDatabase(filePath: string): DatabaseSync {
  return openPrivateDatabase(filePath, {
    busyTimeoutMs: 5000,
    foreignKeys: true,
    lockDirectory: true,
    setup: migrateMemoryStore,
  });
}

/** A value in the database's own meta table (turn index position, reflection generation, migration marker). */
export function readMemoryMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM memory_store_meta WHERE key = ?").get(key) as { readonly value: string } | undefined;
  return row?.value ?? null;
}

export function writeMemoryMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO memory_store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

function migrateMemoryStore(db: DatabaseSync): void {
  inTransaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    ensureMetaSchemaVersion(db, "memory_store_meta", MEMORY_STORE_SCHEMA_VERSION, "memory store");
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        tier TEXT NOT NULL,
        scope TEXT NOT NULL,
        review_status TEXT NOT NULL,
        confidence REAL NOT NULL,
        source_reliability REAL NOT NULL,
        retrieval_strength REAL NOT NULL,
        storage_strength REAL NOT NULL,
        updated_at TEXT NOT NULL,
        subject_ids_json TEXT NOT NULL,
        sensitivity_json TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_records_category ON memory_records(category);
      CREATE INDEX IF NOT EXISTS idx_memory_records_tier ON memory_records(tier);
      CREATE INDEX IF NOT EXISTS idx_memory_records_review ON memory_records(review_status);
      CREATE INDEX IF NOT EXISTS idx_memory_records_updated ON memory_records(updated_at);
      CREATE TABLE IF NOT EXISTS memory_subject_index (
        memory_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        PRIMARY KEY (memory_id, subject_id),
        FOREIGN KEY (memory_id) REFERENCES memory_records(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_memory_subject_index_subject ON memory_subject_index(subject_id);
      CREATE TABLE IF NOT EXISTS evidence_records (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        subject_ids_json TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_records_source ON evidence_records(source_type);
      CREATE INDEX IF NOT EXISTS idx_evidence_records_ingested ON evidence_records(ingested_at);
      CREATE TABLE IF NOT EXISTS evidence_subject_index (
        evidence_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        PRIMARY KEY (evidence_id, subject_id),
        FOREIGN KEY (evidence_id) REFERENCES evidence_records(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_subject_index_subject ON evidence_subject_index(subject_id);
      CREATE TABLE IF NOT EXISTS memory_mutation_receipts (
        mutation_id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        committed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_mutation_receipts_memory
        ON memory_mutation_receipts(memory_id);
    `);
  });
}

function requiredIdentifier(value: string, label: string): string {
  const parsed = value.trim();
  if (!parsed) {
    throw new Error(`${label} is required`);
  }
  return parsed;
}

function parseMemoryMutationReceipt(
  input: MemoryMutationReceipt,
): MemoryMutationReceipt {
  const mutationId = requiredIdentifier(input.mutationId, "memory mutation receipt id");
  const memoryId = requiredIdentifier(input.memoryId, "memory mutation receipt memory id");
  if (Number.isNaN(Date.parse(input.committedAt))) {
    throw new Error("memory mutation receipt committedAt must be ISO-like");
  }
  const resultJson = JSON.stringify(input.result);
  if (resultJson === undefined) {
    throw new Error("memory mutation receipt result must be JSON-compatible");
  }
  return {
    mutationId,
    memoryId,
    result: JSON.parse(resultJson) as JsonValue,
    committedAt: input.committedAt,
  };
}

function parseMemoryMutationReceiptRow(
  row: MemoryMutationReceiptRow,
): MemoryMutationReceipt {
  return parseMemoryMutationReceipt({
    mutationId: row.mutation_id,
    memoryId: row.memory_id,
    result: JSON.parse(row.result_json) as JsonValue,
    committedAt: row.committed_at,
  });
}

function mapBy<TKey, TValue>(
  values: readonly TValue[],
  keysForValue: (value: TValue) => readonly TKey[],
): ReadonlyMap<TKey, readonly TValue[]> {
  const map = new Map<TKey, TValue[]>();
  for (const value of values) {
    for (const key of keysForValue(value)) {
      const existing = map.get(key);
      if (existing) {
        existing.push(value);
      } else {
        map.set(key, [value]);
      }
    }
  }
  return map;
}
