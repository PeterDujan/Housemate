import type { DatabaseSync } from "node:sqlite";

import { canonicalHouseholdActorId } from "./actor-identity.js";
import { householdNameTokens, householdPersonById, householdPersonByName, relationsOf } from "./household.js";
import type { HouseholdMemory } from "./household-memory.js";
import { memoryRecordRecallAllowed } from "./memory-access.js";
import type { MemoryArchive } from "./memory-archive.js";
import { memoryPlainText } from "./memory-recall.js";
import { parseMemoryRecord, type MemoryRecord } from "./memory-schema.js";
import { inTransaction } from "./sqlite-store.js";
import { persona } from "./persona.js";
import { HOUSE_LOCALE, HOUSE_TIME_ZONE } from "./house-config.js";

/*
 * Recall: derived FTS5 tables in the household memory database over accepted
 * facts and reflection episodes, so open chat gets the right few memories
 * without a model call or a full-table scan. Words from the permanent tier
 * are searched in their own table and compete for the same episode
 * slots. The tables are never the source of truth: they rebuild when the
 * records or reflection's state change, and every candidate is re-read from
 * the records and re-checked against the access policy before it can reach
 * a prompt. Episodes of a forgotten turn stay out.
 */

export const RECALL_BUDGET = Object.freeze({
  facts: 5,
  factWords: 25,
  episodes: 3,
  episodeWords: 40,
  rosterWords: 40,
});
export const RECALL_EPISODE_RETENTION_MS = 90 * 86_400_000;

/** FTS candidates read before access checks and ranking. */
const CANDIDATE_LIMIT = 40;
/** A candidate below this share of the best score is noise, not recall. */
const RELATIVE_FLOOR = 0.35;
const HOUSE_ZONE = HOUSE_TIME_ZONE;

export interface RecallQuery {
  /** Verified household speaker; recall is scoped to what they may see. */
  readonly actorId: string;
  readonly transcript: string;
  /** The speaker's previous turn, for short follow-ups ("what about her?"). */
  readonly previousTranscript?: string | null;
  readonly channel: string;
  readonly now: Date;
  /** Wider result counts for an explicit search; the pre-fetch uses RECALL_BUDGET. */
  readonly limits?: { readonly facts: number; readonly episodes: number };
}

export interface RecalledItem {
  readonly id: string;
  /** "kept": the speaker's own words from the permanent tier. */
  readonly kind: "fact" | "episode" | "kept";
  readonly text: string;
  readonly occurredAt: string;
  readonly score: number;
  /** Chat turns behind an episode or kept words; recall hits count toward keeping them. */
  readonly turnIds?: readonly string[];
}

export interface RecallResult {
  readonly facts: readonly RecalledItem[];
  /** Episodes and kept words together, under the one episode budget. */
  readonly episodes: readonly RecalledItem[];
  readonly terms: readonly string[];
  readonly elapsedMs: number;
  /** The permanent tier's lookup, when it ran. */
  readonly archive?: { readonly elapsedMs: number; readonly skipped: string | null };
}

export interface MemoryRecallSource {
  recall(query: RecallQuery): RecallResult;
}

interface RecallEpisodeSource {
  readonly actorId: string;
  readonly at: string;
  readonly text: string;
  readonly terms: readonly string[];
  readonly turnIds: readonly string[];
}

// Words that carry no topic: grammar, question frames, and talk about talk.
const STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "ago", "all", "also", "am", "an", "and", "any", "anything", "are",
  "around", "as", "ask", "asked", "at", "aware", "be", "because", "been", "before", "being", "but", "by",
  "can", "chat", "chatted", "could", "day", "days", "did", "do", "does", "doing", "done", "earlier", "else",
  "ever", "fave", "favorite", "favourite", "for", "from", "get", "got", "had", "has", "have", "he", "hear", "her", "here", "hers", "him",
  "his", "how", "i", "if", "im", "in", "into", "is", "it", "its", "just", "know", "knew", "last",
  "let", "like", "me", "mention", "mentioned", "mine", "more", "much", "my", "myself", "no", "not", "now",
  "of", "off", "ok", "okay", "on", "once", "one", "or", "other", "our", "out", "over", "please", "recall",
  "remember", "remind", "right", "said", "say", "says", "she", "should", "so", "some", "something", "spoke",
  "still", "talk", "talked", "tell", "than", "that", "the", "their", "them", "then", "there", "these",
  "they", "thing", "things", "think", "this", "those", "time", "to", "told", "too", "up", "us", "very",
  "was", "we", "were", "what", "whats", "when", "where", "which", "while", "who", "whom", "why", "will",
  "with", "would", "yeah", "yes", "yesterday", "you", "your", "yours",
  // Contractions with the apostrophe gone ("who's" -> "whos") and spoken filler: none names a topic,
  // yet each matched old chats word for word.
  "arent", "cant", "couldnt", "didnt", "doesnt", "dont", "hadnt", "hasnt", "havent", "hed", "hes", "hows", "isnt",
  "itll", "ive", "lets", "shes", "shouldnt", "thats", "theres", "theyd", "theyll", "theyre", "theyve", "wasnt",
  "wed", "weve", "werent", "wheres", "whos", "whys", "wont", "wouldnt", "youd", "youll", "youre", "youve",
  "actually", "agree", "alright", "basically", "believe", "bit", "bye", "cheers", "cool", "even", "fine", "gonna",
  "good", "gotta", "great", "guess", "hey", "kind", "later", "lot", "maybe", "mean", "nice", "pretty", "probably",
  "really", "see", "sort", "stuff", "sure", "thank", "thanks", "true", "uh", "uhm", "um", "umm", "wanna", "well", "yep",
  "answer", "answered", "answers", "asking", "conversation", "discussion", "interesting", "previous", "question",
  "questions", "rephrase", "repeat", "sorry", "speak", "understand", "wonder", "wondering",
]);
const FIRST_PERSON = /\b(?:i|me|my|mine|myself|i'm|i've|i'd)\b/;
const BOOKKEEPING_TAGS = new Set([
  "cognitive_consolidated",
  "owner_kept",
  "explicit_remember",
  "memory_reflected",
  "people_fact",
  "preferences_file",
  "reflected_fact",
  "reflection_visible",
  "routine",
  "v3_import",
  "v3_tidied",
]);

interface DocRow {
  readonly id: string;
  readonly kind: "fact" | "episode" | "kept";
  readonly subject_ids: string;
  readonly actor_scope: string;
  readonly occurred_at: string;
  readonly text: string;
  readonly terms: string;
  readonly turn_ids: string;
  readonly rank: number;
}

export class MemoryRecallIndex implements MemoryRecallSource {
  private readonly memory: Pick<HouseholdMemory, "database" | "reflectionVersion" | "forgottenAmong">;
  private readonly archive: MemoryArchive | null;
  private memoryVersion: string | null = null;
  private episodeVersion: number | null = null;

  constructor(options: {
    readonly memory: Pick<HouseholdMemory, "database" | "reflectionVersion" | "forgottenAmong">;
    readonly archive: MemoryArchive | null;
  }) {
    this.memory = options.memory;
    this.archive = options.archive;
  }

  /** Bring the recall tables up to date with their sources; cheap when nothing changed. */
  sync(now = new Date()): DatabaseSync | null {
    const db = this.memory.database();
    if (!db) return null;
    const version = memoryDataVersion(db);
    if (version !== this.memoryVersion) {
      this.rebuildFacts(db);
      this.memoryVersion = version;
    }
    const episodeVersion = this.memory.reflectionVersion();
    if (episodeVersion !== this.episodeVersion) {
      this.rebuildEpisodes(db, readEpisodeSources(db), now);
      this.episodeVersion = episodeVersion;
    }
    return db;
  }

  recall(query: RecallQuery): RecallResult {
    const startedAt = performance.now();
    const actorId = canonicalHouseholdActorId(query.actorId);
    const db = actorId ? this.sync(query.now) : null;
    if (!actorId || !db) {
      return { facts: [], episodes: [], terms: [], elapsedMs: 0 };
    }
    const current = queryWords(query.transcript);
    // The previous line only stands in for a follow-up with no topic of its own ("what about her?");
    // otherwise its words filled the slots for "Alright, I'll see you later".
    const previous = current.length > 0 ? [] : queryWords(query.previousTranscript ?? "");
    const named = namedSubjects(query.transcript, actorId);
    const firstPerson = FIRST_PERSON.test(query.transcript.toLowerCase());
    const terms = [...current, ...previous];

    const candidates = new Map<string, DocRow & { readonly previousOnly: boolean }>();
    if (terms.length > 0) {
      const rows = db.prepare(`
        SELECT d.id, d.kind, d.subject_ids, d.actor_scope, d.occurred_at, d.text, d.terms, d.turn_ids,
               bm25(recall_fts, 1.0, 1.5) AS rank
        FROM recall_fts JOIN recall_docs d ON d.rowid = recall_fts.rowid
        WHERE recall_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery(terms), CANDIDATE_LIMIT) as unknown as DocRow[];
      for (const row of rows) {
        const docWords = new Set(queryWords(`${row.text} ${row.terms}`, { keepNames: true }));
        const previousOnly = !current.some((word) => docWords.has(word) || prefixHit(word, docWords));
        candidates.set(row.id, { ...row, previousOnly });
      }
    }

    const scored: { readonly row: DocRow; readonly score: number }[] = [];
    const nowMs = query.now.getTime();
    // An episode built from a turn the speaker asked the assistant to forget stays out.
    const forgotten = this.memory.forgottenAmong([...candidates.values()].flatMap((row) => parseList(row.turn_ids)));
    for (const row of candidates.values()) {
      if (parseList(row.turn_ids).some((turnId) => forgotten.has(turnId))) continue;
      const subjects = parseList(row.subject_ids);
      const aboutNamed = subjects.some((subject) => named.has(subject));
      const aboutSpeaker = subjects.includes(actorId);
      // A question about someone is about them: other people's facts stay out,
      // except the speaker's own when they compare ("does Sam like it too?").
      if (row.kind === "fact" && named.size > 0 && !aboutNamed && !(firstPerson && aboutSpeaker)) continue;
      let score = Math.max(-row.rank, 1e-9);
      if (row.previousOnly) score *= 0.5;
      if (aboutNamed) score *= 2;
      if (firstPerson && aboutSpeaker) score *= 1.5;
      else if (firstPerson && named.size === 0 && row.kind === "fact") score *= 0.4;
      if (row.kind === "episode") score *= recencyFactor(row.occurred_at, nowMs);
      scored.push({ row, score });
    }
    const archive = this.archive && terms.length > 0
      ? this.archive.searchForRecall(actorId, { terms, current, transcript: query.transcript })
      : null;
    for (const kept of archive?.rows ?? []) {
      const docWords = new Set(queryWords(kept.words, { keepNames: true }));
      const previousOnly = !current.some((word) => docWords.has(word) || prefixHit(word, docWords));
      let score = Math.max(-kept.rank, 1e-9);
      if (previousOnly) score *= 0.5;
      score *= recencyFactor(kept.saidAt, nowMs);
      scored.push({
        row: {
          id: `kept:${kept.turnId}`,
          kind: "kept",
          subject_ids: JSON.stringify([kept.actorId]),
          actor_scope: JSON.stringify([kept.actorId]),
          occurred_at: kept.saidAt,
          text: kept.words,
          terms: "",
          turn_ids: JSON.stringify([kept.turnId]),
          rank: kept.rank,
        },
        score,
      });
    }
    const best = Math.max(0, ...scored.map((item) => item.score));
    const relevant = scored
      .filter((item) => item.score >= best * RELATIVE_FLOOR)
      .sort((left, right) => right.score - left.score || right.row.occurred_at.localeCompare(left.row.occurred_at));

    const limits = query.limits ?? { facts: RECALL_BUDGET.facts, episodes: RECALL_BUDGET.episodes };
    const facts = this.admitFacts(
      db,
      relevant.filter((item) => item.row.kind === "fact").map((item) => item.row),
      relevant,
      { actorId, channel: query.channel, now: query.now, limit: limits.facts },
    );
    const episodes = relevant
      .filter((item) => item.row.kind === "episode" || item.row.kind === "kept")
      .slice(0, limits.episodes)
      .map((item): RecalledItem => {
        const turnIds = parseList(item.row.turn_ids);
        return {
          id: item.row.id,
          kind: item.row.kind,
          text: item.row.kind === "kept"
            ? `As of ${spokenDate(item.row.occurred_at)}, ${subjectLabel(parseList(item.row.subject_ids)[0] ?? "") || "they"} said: "${capWords(item.row.text, RECALL_BUDGET.episodeWords)}"`
            : `${episodeWhen(item.row.occurred_at, item.row.text, query.now)}: ${capWords(item.row.text, RECALL_BUDGET.episodeWords)}`,
          occurredAt: item.row.occurred_at,
          score: roundScore(item.score),
          ...(turnIds.length > 0 ? { turnIds } : {}),
        };
      });
    return {
      facts,
      episodes,
      terms,
      elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
      ...(archive ? { archive: { elapsedMs: archive.elapsedMs, skipped: archive.skipped } } : {}),
    };
  }

  /** Re-read each fact from the memory store and admit it only if policy still allows it. */
  private admitFacts(
    db: DatabaseSync,
    rows: readonly DocRow[],
    relevant: readonly { readonly row: DocRow; readonly score: number }[],
    access: { readonly actorId: string; readonly channel: string; readonly now: Date; readonly limit: number },
  ): readonly RecalledItem[] {
    const scores = new Map(relevant.map((item) => [item.row.id, item.score]));
    const read = db.prepare("SELECT record_json FROM memory_records WHERE id = ?");
    const admitted: RecalledItem[] = [];
    for (const row of rows) {
      if (admitted.length >= access.limit) break;
      const raw = read.get(row.id) as { readonly record_json: string } | undefined;
      if (!raw) continue;
      let record: MemoryRecord;
      try {
        record = parseMemoryRecord(JSON.parse(raw.record_json));
      } catch {
        continue;
      }
      if (!recallEligible(record) || !memoryRecordRecallAllowed(record, {
        actorId: access.actorId,
        channel: access.channel,
        purpose: "model_context",
        now: access.now.toISOString(),
      })) {
        continue;
      }
      admitted.push({
        id: record.id,
        kind: "fact",
        text: capWords(recallDocText(record), RECALL_BUDGET.factWords),
        occurredAt: row.occurred_at,
        score: roundScore(scores.get(row.id) ?? 0),
      });
    }
    return admitted;
  }

  private rebuildFacts(db: DatabaseSync): void {
    const rows = db.prepare("SELECT record_json FROM memory_records").all() as unknown as { record_json: string }[];
    const records = rows.flatMap((row) => {
      try {
        return [parseMemoryRecord(JSON.parse(row.record_json))];
      } catch {
        return [];
      }
    }).filter(recallEligible);
    replaceDocs(db, "fact", records.map((record) => ({
      id: record.id,
      actorScope: record.recallPolicy
        ? record.recallPolicy.visibility === "household" && record.recallPolicy.allowedActorIds.length === 0
          ? "household"
          : JSON.stringify([...record.recallPolicy.allowedActorIds])
        : "household",
      subjectIds: aboutSubjects(record),
      sensitivity: [...record.sensitivity],
      visibility: record.recallPolicy?.visibility ?? "household",
      occurredAt: record.lastConfirmedAt ?? record.updatedAt,
      text: recallDocText(record),
      terms: factTerms(record),
      turnIds: [],
    })));
  }

  private rebuildEpisodes(db: DatabaseSync, episodes: readonly RecallEpisodeSource[], now: Date): void {
    const cutoff = now.getTime() - RECALL_EPISODE_RETENTION_MS;
    replaceDocs(db, "episode", episodes
      .filter((episode) => Date.parse(episode.at) >= cutoff)
      .map((episode) => ({
        id: `episode:${episode.actorId}:${episode.at}`,
        actorScope: JSON.stringify([episode.actorId]),
        subjectIds: [episode.actorId],
        sensitivity: ["none"],
        visibility: "named_actors",
        occurredAt: episode.at,
        text: episode.text,
        terms: episode.terms.join(" "),
        turnIds: episode.turnIds,
      })));
  }
}

interface DocInput {
  readonly id: string;
  readonly actorScope: string;
  readonly subjectIds: readonly string[];
  readonly sensitivity: readonly string[];
  readonly visibility: string;
  readonly occurredAt: string;
  readonly text: string;
  readonly terms: string;
  readonly turnIds: readonly string[];
}

function replaceDocs(db: DatabaseSync, kind: "fact" | "episode", docs: readonly DocInput[]): void {
  inTransaction(db, () => {
    db.prepare("DELETE FROM recall_fts WHERE rowid IN (SELECT rowid FROM recall_docs WHERE kind = ?)").run(kind);
    db.prepare("DELETE FROM recall_docs WHERE kind = ?").run(kind);
    const insertDoc = db.prepare(`
      INSERT INTO recall_docs (id, kind, actor_scope, subject_ids, sensitivity, visibility, occurred_at, text, terms, turn_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare("INSERT INTO recall_fts (rowid, text, terms) VALUES (?, ?, ?)");
    for (const doc of docs) {
      const result = insertDoc.run(
        doc.id,
        kind,
        doc.actorScope,
        JSON.stringify(doc.subjectIds),
        JSON.stringify(doc.sensitivity),
        doc.visibility,
        doc.occurredAt,
        doc.text,
        doc.terms,
        JSON.stringify(doc.turnIds),
      );
      insertFts.run(Number(result.lastInsertRowid), doc.text, doc.terms);
    }
  });
}

/** Accepted, current, and a kind of memory that belongs in conversation. */
function recallEligible(record: MemoryRecord): boolean {
  return record.reviewStatus === "accepted"
    && record.contradictionCount === 0;
}

function aboutSubjects(record: MemoryRecord): readonly string[] {
  const subjects = new Set(record.subjectIds.map((subject) => canonicalHouseholdActorId(subject) ?? subject));
  if (record.payload.category === "preference") {
    subjects.add(canonicalHouseholdActorId(record.payload.subjectId) ?? record.payload.subjectId);
  }
  return [...subjects];
}

/**
 * The sentence recall shows the model. Tidied and reflected memories carry a
 * written sentence; older structured ones render from their payload.
 */
export function recallDocText(record: MemoryRecord): string {
  const reflected = record.provenance?.derivation === "memory_reflection" || record.tags.includes("memory_reflected");
  if (!record.tags.includes("v3_tidied") && !reflected) {
    return memoryPlainText(record);
  }
  const summary = record.summary.trim();
  const subject = aboutSubjects(record)[0] ?? "";
  const person = householdPersonById(subject);
  if (!person || new RegExp(`\\b(?:${person.name}|${person.shortName})\\b`, "i").test(summary)) {
    return summary;
  }
  return `${person.name}: ${summary}`;
}

function factTerms(record: MemoryRecord): string {
  const labels = record.payload.category === "preference"
    ? [record.payload.preferenceType]
    : record.payload.category === "fact"
      ? [record.payload.factType]
      : [];
  const tags = record.tags.filter((tag) => !tag.includes(":") && !BOOKKEEPING_TAGS.has(tag));
  return [...(record.recallTerms ?? []), ...labels, ...tags]
    .filter((term) => term !== "stated")
    .join(" ")
    .replaceAll("_", " ");
}

/** A household member's name, for saying whose memory it is. */
export function subjectLabel(subjectId: string): string {
  return householdPersonById(subjectId)?.name ?? "";
}

function namedSubjects(transcript: string, actorId: string): ReadonlySet<string> {
  const subjects = new Set<string>();
  const relations = relationsOf(actorId);
  for (const word of transcript.toLowerCase().split(/[^a-z']+/)) {
    const bare = word.replace(/'s$/, "");
    const subject = householdPersonByName(bare)?.id ?? relations[bare];
    if (subject) subjects.add(subject);
  }
  return subjects;
}

/** Content words of an utterance, lowercased; household names are dropped unless asked for. */
export function queryWords(text: string, options: { readonly keepNames?: boolean } = {}): string[] {
  const words = text
    .toLowerCase()
    .replaceAll(/[’']/g, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3
      && /[a-z]/.test(word)
      && !STOP_WORDS.has(word)
      && !persona().aliases.includes(word)
      && (options.keepNames || !householdNameTokens().has(word)));
  return [...new Set(words)];
}

export function ftsQuery(words: readonly string[]): string {
  // Prefix queries run on porter stems, so "injured" finds "injury".
  return words.map((word) => word.length >= 4 ? `"${word}"*` : `"${word}"`).join(" OR ");
}

export function prefixHit(word: string, docWords: ReadonlySet<string>): boolean {
  const stem = word.slice(0, Math.max(4, word.length - 3));
  for (const docWord of docWords) {
    if (docWord.startsWith(stem) || (docWord.length >= 4 && word.startsWith(docWord.slice(0, Math.max(4, docWord.length - 3))))) {
      return true;
    }
  }
  return false;
}

/** Episodes fade over weeks, not days: a 30-day half-life, never below a quarter. */
function recencyFactor(occurredAt: string, nowMs: number): number {
  const ageDays = Math.max(0, (nowMs - Date.parse(occurredAt)) / 86_400_000);
  return Math.max(0.25, 0.5 ** (ageDays / 30));
}

function whenLabel(occurredAt: string, now: Date): string {
  const day = (value: Date): number => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat(HOUSE_LOCALE, {
      timeZone: HOUSE_ZONE,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(value).map((part) => [part.type, part.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86_400_000;
  };
  const days = Math.round(day(now) - day(new Date(occurredAt)));
  if (days <= 0) return "Earlier today";
  if (days === 1) return "Yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

// "Mentioned the assistant will interview Sam later today", recalled two days on, was taken as today.
const RELATIVE_DAY = /\b(?:today|tonight|tomorrow|yesterday|this (?:morning|afternoon|evening|week|weekend))\b/i;

/** An older episode that speaks of "today" says which day that was. */
function episodeWhen(occurredAt: string, text: string, now: Date): string {
  const when = whenLabel(occurredAt, now);
  return when !== "Earlier today" && RELATIVE_DAY.test(text)
    ? `${when}, on ${spokenDate(occurredAt)} (its "today" means that day)`
    : when;
}

/** "30 September 2026", in house time: kept words are stamped "as of" the day they were said. */
function spokenDate(occurredAt: string): string {
  // Built from parts: some Node ICU builds order en-AU dates American-style.
  const parts = Object.fromEntries(new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: HOUSE_ZONE,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatToParts(new Date(occurredAt)).map((part) => [part.type, part.value]));
  return `${parts.day} ${parts.month} ${parts.year}`;
}

export function capWords(text: string, maximum: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maximum) return words.join(" ");
  return `${words.slice(0, maximum).join(" ").replace(/[,;:.]+$/, "")}...`;
}

function parseList(value: string): readonly string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function roundScore(value: number): number {
  return Number(value.toPrecision(4));
}

function memoryDataVersion(db: DatabaseSync): string {
  // data_version moves when another connection commits; count and newest update
  // cover a restart, where this connection is new.
  const data = (db.prepare("PRAGMA data_version").get() as { readonly data_version: number }).data_version;
  const summary = db.prepare("SELECT count(*) AS n, max(updated_at) AS u FROM memory_records").get() as {
    readonly n: number;
    readonly u: string | null;
  };
  return `${data}|${summary.n}|${summary.u ?? ""}`;
}

/** Reflection's episodes, oldest first, with the checks the old file reader made. */
function readEpisodeSources(db: DatabaseSync): readonly RecallEpisodeSource[] {
  const rows = db.prepare("SELECT actor_id, episode FROM reflection_episodes ORDER BY id").all() as unknown as {
    readonly actor_id: string; readonly episode: string;
  }[];
  return rows.flatMap((row) => {
    const actorId = canonicalHouseholdActorId(row.actor_id);
    const episode = JSON.parse(row.episode) as { readonly at?: unknown; readonly text?: unknown; readonly terms?: unknown; readonly turnIds?: unknown };
    if (!actorId || typeof episode.at !== "string" || typeof episode.text !== "string" || !episode.text.trim()) return [];
    if (Number.isNaN(Date.parse(episode.at))) return [];
    return [{
      actorId,
      at: episode.at,
      text: episode.text.trim(),
      terms: Array.isArray(episode.terms) ? episode.terms.filter((term): term is string => typeof term === "string") : [],
      turnIds: Array.isArray(episode.turnIds) ? episode.turnIds.filter((id): id is string => typeof id === "string") : [],
    }];
  });
}
