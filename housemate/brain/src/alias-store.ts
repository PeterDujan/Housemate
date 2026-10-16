import { copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

import { type AliasEntry, type AliasMap, parseAliasMap } from "./alias-schema.js";

export interface AliasStoreSnapshot {
  readonly filePath: string;
  readonly loaded: boolean;
  readonly entryCount: number;
  readonly lastLoadedAt: string | null;
  readonly fileModifiedAt: string | null;
}

export class AliasStore {
  private aliasMap: AliasMap = EMPTY_ALIAS_MAP;
  private loaded = false;
  private lastLoadedAt: string | null = null;
  private fileModifiedAt: string | null = null;

  constructor(private readonly filePath: string) {}

  load(now: Date = new Date()): AliasMap {
    if (!existsSync(this.filePath)) {
      this.aliasMap = EMPTY_ALIAS_MAP;
      this.loaded = true;
      this.lastLoadedAt = now.toISOString();
      this.fileModifiedAt = null;
      return this.aliasMap;
    }

    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
    this.aliasMap = parseAliasMap(parsed);
    this.loaded = true;
    this.lastLoadedAt = now.toISOString();
    this.fileModifiedAt = statSync(this.filePath).mtime.toISOString();
    return this.aliasMap;
  }

  reload(now: Date = new Date()): AliasMap {
    return this.load(now);
  }

  /**
   * Writes a whole alias list. The
   * list is checked by the same parser as a load, the previous file is kept
   * as `aliases.json.bak-dashboard`, and the swap is a rename so a reader
   * never sees half a file.
   */
  save(entries: readonly AliasEntry[], now: Date = new Date()): AliasMap {
    const raw = {
      schemaVersion: 1,
      entries: entries.map((entry) => ({
        alias: entry.alias,
        target: cloneTarget(entry.target),
        ...(entry.notes ? { notes: entry.notes } : {}),
      })),
    };
    parseAliasMap(raw);
    if (existsSync(this.filePath)) {
      copyFileSync(this.filePath, `${this.filePath}.bak-dashboard`);
    }
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o644 });
    renameSync(temporary, this.filePath);
    return this.load(now);
  }

  entries(): readonly AliasEntry[] {
    return this.aliasMap.entries.map((entry) => ({
      ...entry,
      target: cloneTarget(entry.target),
    }));
  }

  snapshot(): AliasStoreSnapshot {
    return {
      filePath: this.filePath,
      loaded: this.loaded,
      entryCount: this.aliasMap.entries.length,
      lastLoadedAt: this.lastLoadedAt,
      fileModifiedAt: this.fileModifiedAt,
    };
  }
}

const EMPTY_ALIAS_MAP: AliasMap = {
  schemaVersion: 1,
  entries: [],
};

function cloneTarget(target: AliasEntry["target"]): AliasEntry["target"] {
  if (target.kind === "group") {
    return {
      ...target,
      entityIds: [...target.entityIds],
    };
  }
  return { ...target };
}
