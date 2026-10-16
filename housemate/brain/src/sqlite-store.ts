import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * One way to open the assistant's private SQLite stores: owner-only
 * directory and file, WAL, a busy timeout, then the store's own schema step.
 * The database is closed again if any step throws.
 */
export function openPrivateDatabase(
  filePath: string,
  options: {
    readonly busyTimeoutMs: number;
    readonly foreignKeys?: boolean;
    /** Also tighten an existing directory to 0700. */
    readonly lockDirectory?: boolean;
    readonly setup?: (db: DatabaseSync) => void;
  },
): DatabaseSync {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (options.lockDirectory) chmodSync(directory, 0o700);
  const db = new DatabaseSync(filePath);
  try {
    chmodSync(filePath, 0o600);
    if (options.foreignKeys) db.exec("PRAGMA foreign_keys = ON");
    db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs}`);
    db.exec("PRAGMA journal_mode = WAL");
    options.setup?.(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** Schema by a `schema_version` row in the store's own meta table; any other version is refused. */
export function ensureMetaSchemaVersion(db: DatabaseSync, table: string, version: number, label: string): void {
  const existing = db.prepare(`SELECT value FROM ${table} WHERE key = 'schema_version'`).get() as
    { readonly value: string } | undefined;
  if (!existing) {
    db.prepare(`INSERT INTO ${table} (key, value) VALUES ('schema_version', ?)`).run(String(version));
  } else if (Number(existing.value) !== version) {
    throw new Error(`${label} schema version is unsupported: ${existing.value}`);
  }
}

/**
 * Runs in one write transaction (BEGIN IMMEDIATE), rolled back if it
 * throws. Inside an open transaction it joins it, so one household forget can
 * span several stores' writes on the shared memory database.
 */
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) return work();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
