import {
  parseMemoryRecord,
  type EvidenceRecord,
  type MemoryRecord,
  type MemorySalience,
} from "./memory-schema.js";

const MAX_SIGNAL_VALUES = 24;
const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "been",
  "from",
  "have",
  "just",
  "more",
  "much",
  "that",
  "their",
  "them",
  "then",
  "they",
  "this",
  "with",
  "would",
]);

export function memorySalience(record: Pick<MemoryRecord, "salience" | "evidenceIds" | "subjectIds" | "summary" | "title" | "tags" | "payload">): MemorySalience {
  if (record.salience) {
    return record.salience;
  }
  return {
    returnCount: 0,
    recurrenceCount: 0,
    correctionCount: 0,
    reopenedCount: 0,
    unresolved: false,
    sourceEvidenceIds: [...record.evidenceIds],
    sourceRefs: [],
    sourceSlugs: deriveSlugs(record),
    sourceAliases: deriveAliases(record),
    memoryEditIds: [],
    correctionTargets: [],
  };
}

export function enrichMemorySalience(
  record: MemoryRecord,
  options: {
    readonly previous?: MemoryRecord | null;
    readonly evidenceRecords?: readonly EvidenceRecord[];
  } = {},
): MemoryRecord {
  const previous = options.previous ?? null;
  const recordSalience = memorySalience(record);
  const previousSalience = previous ? memorySalience(previous) : memorySalience(record);
  const evidenceRecords = options.evidenceRecords ?? [];
  const currentSlugs = deriveSlugs(record);
  const currentAliases = deriveAliases(record);
  const previousContradictionCount = previous?.contradictionCount ?? 0;
  const contradictionDelta = Math.max(0, record.contradictionCount - previousContradictionCount);
  const reviewEnteredUnresolved = previous
    ? !isUnresolved(previous) && isUnresolved(record)
    : false;
  const semanticEdit = previous ? semanticFieldsChanged(previous, record) : false;
  const addedSupersedes = previous ? difference(record.supersedesIds, previous.supersedesIds) : [...record.supersedesIds];
  const addedContradictions = previous ? difference(record.contradictedByIds, previous.contradictedByIds) : [...record.contradictedByIds];
  const sourceRefs = uniqueStrings([
    ...previousSalience.sourceRefs,
    ...recordSalience.sourceRefs,
    ...evidenceRecords.flatMap((evidence) => evidence.sourceRef ? [evidence.sourceRef] : []),
  ]);
  const sourceEvidenceIds = uniqueStrings([
    ...previousSalience.sourceEvidenceIds,
    ...recordSalience.sourceEvidenceIds,
    ...record.evidenceIds,
  ]);
  const sourceSlugs = uniqueStrings([
    ...previousSalience.sourceSlugs,
    ...recordSalience.sourceSlugs,
    ...currentSlugs,
    ...evidenceRecords.flatMap((evidence) => deriveEvidenceSlugs(evidence)),
  ]);
  const sourceAliases = uniqueStrings([
    ...previousSalience.sourceAliases,
    ...recordSalience.sourceAliases,
    ...currentAliases,
  ]);
  const correctionTargets = uniqueStrings([
    ...previousSalience.correctionTargets,
    ...recordSalience.correctionTargets,
    ...record.supersedesIds,
    ...record.contradictedByIds,
  ]);
  const addedCorrectionTargets = uniqueStrings([
    ...addedSupersedes,
    ...addedContradictions,
  ]);
  const correctionDelta = Math.max(
    semanticEdit ? 1 : 0,
    contradictionDelta,
    addedCorrectionTargets.length,
  );
  const correctionCount = Math.max(
    previousSalience.correctionCount + correctionDelta,
    recordSalience.correctionCount,
    correctionTargets.length,
  );
  const previousEvidenceCount = previous?.evidenceCount ?? 1;
  const recurrenceDelta = Math.max(0, record.evidenceCount - previousEvidenceCount);
  const recurrenceCount = Math.max(
    recordSalience.recurrenceCount,
    previousSalience.recurrenceCount + recurrenceDelta,
  );
  const reopenedCount = Math.max(
    recordSalience.reopenedCount,
    previousSalience.reopenedCount + (reviewEnteredUnresolved ? 1 : 0),
  );
  const memoryEditIds = uniqueStrings([
    ...previousSalience.memoryEditIds,
    ...recordSalience.memoryEditIds,
    ...(semanticEdit ? [`${record.id}:${record.updatedAt}`] : []),
  ]);
  const lastSeen = mostRecentIso([
    previousSalience.lastSeen,
    recordSalience.lastSeen,
    record.lastRetrievedAt,
    record.lastUsedAt,
    record.lastConfirmedAt,
    record.updatedAt,
    ...evidenceRecords.map((evidence) => evidence.observedAt),
  ]);

  return parseMemoryRecord({
    ...record,
    salience: {
      returnCount: Math.max(previousSalience.returnCount, recordSalience.returnCount),
      recurrenceCount,
      correctionCount,
      reopenedCount,
      unresolved: isUnresolved(record),
      ...(lastSeen ? { lastSeen } : {}),
      sourceEvidenceIds,
      sourceRefs,
      sourceSlugs,
      sourceAliases,
      memoryEditIds,
      correctionTargets,
    },
  });
}

export function noteMemoryRetrieved(record: MemoryRecord, options: {
  readonly now: string;
  readonly sourceRef?: string;
}): MemoryRecord {
  const salienceState = memorySalience(record);
  return parseMemoryRecord({
    ...record,
    lastRetrievedAt: options.now,
    salience: {
      ...salienceState,
      returnCount: salienceState.returnCount + 1,
      lastSeen: mostRecentIso([salienceState.lastSeen, options.now]) ?? options.now,
      sourceRefs: uniqueStrings([
        ...salienceState.sourceRefs,
        ...(options.sourceRef ? [options.sourceRef] : []),
      ]),
    },
  });
}

export function memorySalienceScore(record: MemoryRecord): number {
  const salienceState = memorySalience(record);
  const positive = Math.min(2.2, salienceState.returnCount * 0.22)
    + Math.min(1.6, salienceState.recurrenceCount * 0.2)
    + Math.min(1.2, salienceState.reopenedCount * 0.3)
    + Math.min(1.4, salienceState.correctionCount * 0.22);
  const unresolvedPenalty = salienceState.unresolved ? 0.9 : 0;
  return Number((positive - unresolvedPenalty).toFixed(3));
}

export function buildMemorySalienceEvidenceLines(record: MemoryRecord): readonly string[] {
  const salienceState = memorySalience(record);
  const lines: string[] = [];
  if (salienceState.returnCount > 0) {
    lines.push(`returned ${countLabel(salienceState.returnCount, "time")}`);
  }
  if (salienceState.recurrenceCount > 0) {
    lines.push(`supported by ${countLabel(salienceState.recurrenceCount + 1, "observation")}`);
  }
  if (salienceState.correctionCount > 0) {
    lines.push(`corrected ${countLabel(salienceState.correctionCount, "time")}`);
  }
  if (salienceState.reopenedCount > 0) {
    lines.push(`reopened ${countLabel(salienceState.reopenedCount, "time")}`);
  }
  if (salienceState.unresolved) {
    lines.push("still unresolved");
  }
  if (salienceState.sourceRefs.length > 0) {
    lines.push(`source refs: ${salienceState.sourceRefs.slice(0, 3).join(", ")}`);
  }
  return lines;
}

function isUnresolved(record: MemoryRecord): boolean {
  return record.reviewStatus === "queued"
    || record.reviewStatus === "needs_clarification"
    || record.contradictionCount > 0;
}

function semanticFieldsChanged(left: MemoryRecord, right: MemoryRecord): boolean {
  return left.title !== right.title
    || left.summary !== right.summary
    || JSON.stringify(left.payload) !== JSON.stringify(right.payload);
}

function deriveEvidenceSlugs(evidence: EvidenceRecord): readonly string[] {
  return tokenizeSlugs([
    evidence.sourceRef ?? "",
    evidence.textSummary ?? "",
    JSON.stringify(evidence.structuredSummary ?? ""),
  ].join(" "));
}

function deriveSlugs(record: Pick<MemoryRecord, "title" | "summary" | "tags" | "subjectIds" | "payload">): readonly string[] {
  return tokenizeSlugs([
    record.title,
    record.summary,
    ...record.tags,
    ...record.subjectIds,
    JSON.stringify(record.payload),
  ].join(" "));
}

function deriveAliases(record: Pick<MemoryRecord, "subjectIds" | "payload">): readonly string[] {
  const aliases = new Set<string>();
  for (const subjectId of record.subjectIds) {
    const normalized = normalizeMemoryText(subjectId);
    if (!normalized) {
      continue;
    }
    aliases.add(normalized);
    const tail = normalized.split(".").pop();
    if (tail) {
      aliases.add(tail);
    }
  }
  if (record.payload.category === "person") {
    for (const alias of record.payload.aliases) {
      const normalized = normalizeMemoryText(alias);
      if (normalized) {
        aliases.add(normalized);
      }
    }
  }
  if (record.payload.category === "place") {
    for (const alias of record.payload.aliases) {
      const normalized = normalizeMemoryText(alias);
      if (normalized) {
        aliases.add(normalized);
      }
    }
  }
  return limitStrings([...aliases]);
}

function tokenizeSlugs(text: string): readonly string[] {
  const tokens = normalizeMemoryText(text)
    .split(" ")
    .filter((token) => token.length >= 4 && !STOP_WORDS.has(token));
  const phrases: string[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const phrase = `${tokens[index]}_${tokens[index + 1]}`;
    if (phrase.length <= 40) {
      phrases.push(phrase);
    }
  }
  return limitStrings([...tokens, ...phrases]);
}

/** Lower case, every run of characters other than letters, digits and dots one space. */
export function normalizeMemoryText(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9.]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return limitStrings(values.filter((value) => value.trim()));
}

function limitStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].slice(0, MAX_SIGNAL_VALUES);
}

function difference(left: readonly string[], right: readonly string[]): readonly string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function mostRecentIso(values: readonly (string | undefined)[]): string | null {
  const parsed = values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  return parsed[0] ?? null;
}

function countLabel(count: number, noun: string): string {
  return count === 1 ? `once` : `${count} ${noun}s`;
}
