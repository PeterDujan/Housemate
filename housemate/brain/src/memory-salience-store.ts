import type { AppConfig } from "./config.js";
import { cognitiveFeatureEnabled } from "./cognitive-control.js";
import { MemoryStore, memoryStorePath } from "./memory-store.js";
import { noteMemoryRetrieved } from "./memory-salience.js";
import type { MemoryRecord } from "./memory-schema.js";

export function touchRetrievedMemories(
  config: Pick<AppConfig, "dataDir"> & Partial<Pick<
    AppConfig,
    "cognitiveSystemEnabled" | "cognitiveLearningEnabled"
  >>,
  memoryIds: readonly string[],
  options: { readonly now: string; readonly sourceRef?: string },
): void {
  touchMemories(config, memoryIds, (record) => noteMemoryRetrieved(record, options));
}

function touchMemories(
  config: Pick<AppConfig, "dataDir"> & Partial<Pick<
    AppConfig,
    "cognitiveSystemEnabled" | "cognitiveLearningEnabled"
  >>,
  memoryIds: readonly string[],
  updater: (record: MemoryRecord) => MemoryRecord,
): void {
  if (!cognitiveFeatureEnabled(config, "learning")) {
    return;
  }
  const ids = [...new Set(memoryIds.filter(Boolean))];
  if (ids.length === 0) {
    return;
  }
  const store = new MemoryStore(memoryStorePath(config));
  try {
    for (const memoryId of ids) {
      store.updateMemoryRecord(memoryId, (current) =>
        current.reviewStatus === "accepted" && current.contradictionCount === 0
          ? updater(current)
          : null
      );
    }
  } finally {
    store.close();
  }
}
