import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { AppConfig } from "./config.js";
import { tasteMatchKey, tasteOwningSubject } from "./self-taste.js";
import { normalizeWords as normalize } from "./speech-normalizer.js";
import {
  candidateSubjectKey,
  TASTE_EVIDENCE_KINDS,
  type TasteEvidenceKind,
  type TasteEvidenceObservation,
} from "./self-taste-evidence.js";
import { boundedString, objectValue, unitNumber } from "./value-guards.js";
import { truncateText } from "./text-format.js";
import { ensureMetaSchemaVersion, inTransaction, openPrivateDatabase } from "./sqlite-store.js";
import { SELF_PREFERENCES_FILE, assistantName, houseDataFile } from "./persona.js";
import { HOUSE_TIME_ZONE } from "./house-config.js";

export const SELF_MODEL_SCHEMA_VERSION = 1;
export const SELF_MODEL_REVIEW_INTERVAL_MS = 7 * 24 * 60 * 60_000;
export const SELF_MODEL_RETRY_INTERVAL_MS = 60 * 60_000;
/** Most preferences a seed file may hold; the seed file sets the actual count. */
export const SELF_MODEL_MAX_PREFERENCE_COUNT = 200;
/** Hard cap on opinions the assistant formed in conversation; the weakest is replaced first. */
export const SELF_MODEL_CONVERSATION_OPINION_CAP = 200;
/** Former views kept for "didn't you used to think...?"; the oldest go first. */
export const SELF_OPINION_HISTORY_CAP = 500;
/** Chat opinions the weekly review sees besides the promotable ones. */
const SELF_REVIEW_RECENT_OPINIONS = 40;

/**
 * Code nudges from evidence: small bounded steps on
 * strength and confidence only. A nudge never changes what he likes, never
 * retires a taste and never touches a locked one.
 */
export const TASTE_EVIDENCE_RETENTION_DAYS = 30;
export const TASTE_NUDGE = {
  /** Distinct days of household exposure that raise strength one step. */
  exposureDays: 3,
  strengthStep: 0.02,
  strengthCeiling: 0.95,
  /** Distinct days of pushback that lower confidence one step. */
  pushbackDays: 2,
  confidenceStep: 0.03,
  confidenceFloor: 0.3,
} as const;
/** Days in the retention window an artist with no taste must be played on to become a candidate. */
export const TASTE_CANDIDATE_PLAY_DAYS = 3;
/**
 * Weekly review limits. No quota and no weekly
 * ceiling on changes; these only bound what one call may carry.
 */
export const SELF_REVIEW_LIMITS = {
  /** Most evidence rows sent to one review; the newest win, the rest wait a week. */
  evidenceRows: 200,
  recentChanges: 15,
  /** A new taste starts provisional, whatever confidence the model claims. */
  additionMaxConfidence: 0.7,
  /** Times a chat opinion must have been said (its revision) before it can be promoted. */
  promotableOpinionRevision: 2,
  /** Review summaries kept whole (rule 6); older ones keep only their date while a change row points at them. */
  keptReviews: 8,
  /** How far back "has anything changed about you lately?" looks. */
  changedLatelyDays: 30,
} as const;
const TASTE_EXPOSURE_KINDS: readonly TasteEvidenceKind[] = ["mention", "asked", "played", "agreement"];
const TASTE_EVIDENCE_TIMEZONE = HOUSE_TIME_ZONE;

export type SelfPreferenceStatus = "active" | "retired";
/**
 * `self_chosen`: picked for the assistant's own character.
 * `documented_seed`: taken from a documented source when a seed was written. Older stores
 * named the source in the kind (`documented_<source>`); those read as `documented_seed`.
 */
export type SelfPreferenceProvenanceKind = "self_chosen" | "documented_seed" | "model_decided";

export interface SelfPreferenceProvenance {
  readonly kind: SelfPreferenceProvenanceKind;
  readonly note: string;
  readonly sourceUrls: readonly string[];
}

export interface SelfPreference {
  readonly id: string;
  readonly category: string;
  readonly subject: string;
  readonly stance: string;
  readonly strength: number;
  readonly confidence: number;
  readonly rationale: string;
  readonly provenance: SelfPreferenceProvenance;
  readonly locked: boolean;
  readonly status: SelfPreferenceStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastReviewedAt: string | null;
}

export interface SelfPreferenceCard {
  readonly id: string;
  readonly category: string;
  readonly subject: string;
  readonly stance: string;
  readonly strength: number;
  readonly confidence: number;
  readonly rationale: string;
}

export interface SelfModelReviewChange {
  readonly id: string;
  readonly stance: string;
  readonly strength: number;
  readonly confidence: number;
  readonly rationale: string;
  readonly status: SelfPreferenceStatus;
  readonly reason: string;
  /** Evidence rows the change rests on; the weekly review must cite at least one (rule 5). */
  readonly evidenceIds?: readonly number[];
}

/** A new taste from the weekly review: a candidate artist or a repeated chat opinion. */
export interface SelfModelReviewAddition {
  readonly category: string;
  readonly subject: string;
  readonly stance: string;
  readonly strength: number;
  readonly confidence: number;
  readonly rationale: string;
  readonly reason: string;
  readonly evidenceIds: readonly number[];
  /** A chat opinion being promoted into a taste; it leaves the opinion table. */
  readonly fromOpinionId: string | null;
}

export interface SelfModelReviewProposal {
  readonly summary: string;
  readonly changes: readonly SelfModelReviewChange[];
  readonly additions?: readonly SelfModelReviewAddition[];
}

/** A recent review change, so the review can see what it did lately. */
export interface SelfModelRecentChange {
  readonly preferenceId: string;
  readonly reviewedAt: string;
  readonly reason: string;
  readonly stanceBefore: string | null;
  readonly stanceAfter: string;
  readonly statusAfter: SelfPreferenceStatus;
}

/**
 * A taste's last change as code reads it back. The
 * change log holds one row per taste: the version it replaced, for one-step
 * undo, and what it is now.
 */
export interface SelfTasteChange {
  readonly preferenceId: string;
  readonly subject: string;
  readonly kind: "added" | "changed" | "retired" | "restored";
  readonly stanceBefore: string | null;
  readonly stanceAfter: string;
  readonly changedAt: string;
  readonly source: "automatic" | "operator";
}

/** A chat opinion as the review sees it; only a repeated one may be promoted. */
export interface SelfModelReviewOpinion extends ConversationOpinion {
  readonly promotable: boolean;
}

export interface SelfModelReviewInput {
  readonly reviewId: string;
  readonly requestedAt: string;
  readonly preferences: readonly SelfPreference[];
  readonly evidence: readonly TasteEvidence[];
  readonly candidates: readonly TasteCandidate[];
  readonly opinions: readonly SelfModelReviewOpinion[];
  readonly recentChanges: readonly SelfModelRecentChange[];
}

export interface SelfModelReviewer {
  review(input: SelfModelReviewInput): Promise<SelfModelReviewProposal>;
}

/** One proposed item code refused, kept in the review summary. */
export interface SelfModelReviewRejection {
  readonly item: string;
  readonly reason: string;
}

export interface SelfModelStatus {
  readonly enabled: boolean;
  readonly preferenceCount: number;
  readonly activeCount: number;
  readonly lockedCount: number;
  readonly seedVersion: number;
  readonly lastAttemptAt: string | null;
  readonly lastReviewedAt: string | null;
  readonly nextReviewAt: string;
  readonly reviewStatus: "seeded" | "ok" | "error";
  readonly lastSummary: string | null;
  readonly lastError: string | null;
}

export interface SelfModelDashboardTastes {
  readonly items: readonly {
    readonly id: string;
    readonly category: string;
    readonly subject: string;
    readonly stance: string;
    readonly locked: boolean;
    readonly canUndo: boolean;
  }[];
  readonly opinions: readonly Pick<ConversationOpinion, "id" | "subject" | "stance">[];
}

export interface SelfModelSnapshot {
  readonly ok: true;
  readonly status: SelfModelStatus;
  readonly preferences: readonly SelfPreference[];
  readonly recentReviews: readonly SelfModelReviewSummary[];
  readonly recentEvidence: readonly TasteEvidence[];
  readonly candidates: readonly TasteCandidate[];
  readonly opinions: readonly ConversationOpinion[];
}

/** One piece of evidence about a taste: at most one per taste, kind and local day. */
export interface TasteEvidence {
  readonly id: number;
  readonly preferenceId: string | null;
  readonly subject: string;
  readonly kind: TasteEvidenceKind;
  readonly day: string;
  readonly actorId: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly nudgedAt: string | null;
}

/** An artist played through the assistant often enough to be considered; never a taste by itself. */
export interface TasteCandidate {
  readonly subject: string;
  readonly days: number;
  readonly lastPlayedAt: string;
  readonly evidenceIds: readonly number[];
}

export interface TasteNudge {
  readonly preferenceId: string;
  readonly field: "strength" | "confidence";
  readonly from: number;
  readonly to: number;
  readonly evidenceIds: readonly number[];
}

export interface TasteEvidenceOutcome {
  readonly recorded: number;
  readonly nudges: readonly TasteNudge[];
}

export interface SelfModelReviewSummary {
  readonly reviewId: string;
  readonly timestamp: string;
  readonly source: "automatic" | "operator";
  readonly status: "ok" | "error";
  readonly summary: string;
  readonly changeCount: number;
}

/** An opinion the assistant stated in conversation, kept so he answers consistently next time. */
export interface ConversationOpinion {
  readonly id: string;
  readonly category: string;
  readonly subject: string;
  readonly stance: string;
  readonly strength: number;
  readonly confidence: number;
  readonly actorId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A view he held once and has since revised or let go. */
export interface FormerOpinion {
  readonly subject: string;
  readonly stance: string;
  readonly lastSaid: string;
  readonly replacedAt: string;
  readonly why: "revised" | "dropped";
}

export type ConversationOpinionOutcome =
  | { readonly kind: "added"; readonly id: string; readonly replacedId: string | null }
  | { readonly kind: "updated"; readonly id: string }
  | { readonly kind: "skipped"; readonly reason: string };

interface OpinionRow {
  readonly opinion_id: string;
  readonly category: string;
  readonly subject: string;
  readonly subject_key: string;
  readonly stance: string;
  readonly strength: number;
  readonly confidence: number;
  readonly actor_id: string;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface SelfPreferenceSeedFile {
  readonly schemaVersion: 1;
  readonly seedVersion: number;
  readonly preferences: readonly SelfPreferenceSeed[];
}

interface SelfPreferenceSeed {
  readonly id: string;
  readonly category: string;
  readonly subject: string;
  readonly stance: string;
  readonly strength: number;
  readonly confidence: number;
  readonly rationale: string;
  readonly provenance: SelfPreferenceProvenance;
}

interface PreferenceRow {
  readonly preference_id: string;
  readonly category: string;
  readonly subject: string;
  readonly stance: string;
  readonly strength: number;
  readonly confidence: number;
  readonly rationale: string;
  readonly provenance_json: string;
  readonly locked: number;
  readonly status: string;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_reviewed_at: string | null;
}

interface ReviewRow {
  readonly review_id: string;
  readonly reviewed_at: string;
  readonly source: string;
  readonly status: string;
  readonly summary: string;
  readonly change_count: number;
}

interface MetaRow { readonly value: string }

interface EvidenceRow {
  readonly evidence_id: number;
  readonly preference_id: string | null;
  readonly subject_key: string;
  readonly subject: string;
  readonly kind: string;
  readonly day: string;
  readonly actor_id: string;
  readonly summary: string;
  readonly created_at: string;
  readonly nudged_at: string | null;
}

export function selfModelStorePath(config: Pick<AppConfig, "dataDir">): string {
  return join(config.dataDir, "cognition", "self-model.sqlite");
}

/** The house's starting tastes (<dataDir>/self-preferences.json); a house without one starts with none. */
export function defaultSelfPreferenceSeedPath(): string {
  return houseDataFile(SELF_PREFERENCES_FILE, "JARVIS_V5_SELF_PREFERENCES_FILE");
}

export class JarvisSelfModel {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly reviewer: SelfModelReviewer | null;
  private reviewPromise: Promise<boolean> | null = null;
  private reviewTimer: NodeJS.Timeout | null = null;

  constructor(options: {
    readonly filePath: string;
    readonly seedFilePath?: string | URL;
    readonly reviewer?: SelfModelReviewer | null;
    readonly now?: () => Date;
  }) {
    this.now = options.now ?? (() => new Date());
    this.reviewer = options.reviewer ?? null;
    this.db = openPrivateDatabase(options.filePath, {
      busyTimeoutMs: 5000,
      foreignKeys: true,
      lockDirectory: true,
      setup: migrateSelfModel,
    });
    try {
      const seedFile = options.seedFilePath ?? defaultSelfPreferenceSeedPath();
      if (typeof seedFile !== "string" || existsSync(seedFile)) this.seed(parseSeedFile(seedFile));
      inTransaction(this.db, () => {
        this.compactChangeLog();
        this.trimReviews();
      });
      this.retireOwnedOpinions();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    if (this.reviewTimer) clearInterval(this.reviewTimer);
    this.reviewTimer = null;
    this.db.close();
  }

  startAutomaticReview(): void {
    if (!this.reviewer || this.reviewTimer) return;
    void this.reviewIfDue().catch(() => undefined);
    this.reviewTimer = setInterval(() => {
      void this.reviewIfDue().catch(() => undefined);
    }, SELF_MODEL_RETRY_INTERVAL_MS);
    this.reviewTimer.unref();
  }

  reviewIfDue(): Promise<boolean> {
    if (!this.reviewer) return Promise.resolve(false);
    if (this.now().getTime() < Date.parse(this.status().nextReviewAt)) {
      return Promise.resolve(false);
    }
    if (this.reviewPromise) return this.reviewPromise;
    this.reviewPromise = this.runAutomaticReview().finally(() => {
      this.reviewPromise = null;
    });
    return this.reviewPromise;
  }

  listPreferences(): readonly SelfPreference[] {
    const rows = this.db.prepare(
      `SELECT * FROM self_preferences ORDER BY category ASC, subject ASC, preference_id ASC`,
    ).all() as unknown as PreferenceRow[];
    return rows.map(parsePreferenceRow);
  }

  cardsForPrompt(prompt: string, limit = 6): readonly SelfPreferenceCard[] {
    const query = normalize(prompt);
    const categoryHints = categoriesForPrompt(query);
    const genericOverview = categoryHints.size === 0
      && /\b(?:preferences|favourites|favorites|tastes)\b/.test(query);
    return [...this.listPreferences(), ...this.listConversationOpinions().map(opinionAsPreference)]
      .filter((preference) => preference.status === "active")
      .map((preference) => ({
        preference,
        score: genericOverview ? 1 : preferenceMatchScore(preference, query, categoryHints),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score
        || right.preference.strength - left.preference.strength
        || right.preference.confidence - left.preference.confidence
        || left.preference.id.localeCompare(right.preference.id))
      .slice(0, Math.max(1, Math.min(10, limit)))
      .map(({ preference }) => ({
        id: preference.id,
        category: preference.category,
        subject: preference.subject,
        stance: preference.stance,
        strength: preference.strength,
        confidence: preference.confidence,
        rationale: preference.rationale,
      }));
  }

  listConversationOpinions(): readonly ConversationOpinion[] {
    const rows = this.db.prepare(
      `SELECT * FROM self_conversation_opinions ORDER BY updated_at DESC, opinion_id ASC`,
    ).all() as unknown as OpinionRow[];
    return rows.map(parseOpinionRow);
  }

  /**
   * Keep an opinion the assistant stated in chat. Same subject updates in place; an
   * active preference on that subject wins; a full table replaces its
   * weakest opinion only when the new one is at least as strong.
   */
  recordConversationOpinion(input: {
    readonly category: string;
    readonly subject: string;
    readonly stance: string;
    readonly strength: number;
    readonly confidence: number;
    readonly actorId: string;
  }): ConversationOpinionOutcome {
    const category = boundedString(input.category, "opinion category", 40).toLowerCase();
    const subject = boundedString(input.subject, "opinion subject", 80);
    const stance = boundedString(input.stance, "opinion stance", 300);
    const strength = unitNumber(input.strength, "opinion strength");
    const confidence = unitNumber(input.confidence, "opinion confidence");
    const actorId = boundedString(input.actorId, "opinion actorId", 100);
    const subjectKey = normalize(subject);
    if (!subjectKey) return { kind: "skipped", reason: "empty subject" };
    // A taste owns its subject: an opinion on it is
    // not stored as a rival record.
    const owner = tasteOwningSubject(this.listPreferences(), subject);
    if (owner) {
      // What he said in chat about it is evidence for the next review instead.
      this.recordTasteEvidence([{
        preferenceId: owner.id,
        subject: owner.subject,
        kind: "chat_opinion",
        summary: truncateText(`Said in chat: ${stance}`, 160),
      }], actorId);
      return { kind: "skipped", reason: `preference ${owner.id} owns this subject` };
    }
    const timestamp = this.now().toISOString();
    return inTransaction(this.db, () => {
      const existing = this.db.prepare(
        `SELECT * FROM self_conversation_opinions WHERE subject_key=?`,
      ).get(subjectKey) as OpinionRow | undefined;
      if (existing) {
        if (normalize(existing.stance) !== normalize(stance)) this.archiveOpinion(existing, timestamp, "revised");
        this.db.prepare(
          `UPDATE self_conversation_opinions SET category=?, subject=?, stance=?, strength=?, confidence=?,
           actor_id=?, revision=?, updated_at=? WHERE opinion_id=?`,
        ).run(category, subject, stance, strength, confidence, actorId, existing.revision + 1, timestamp, existing.opinion_id);
        return { kind: "updated", id: existing.opinion_id } as const;
      }
      const rows = this.db.prepare(`SELECT * FROM self_conversation_opinions`).all() as unknown as OpinionRow[];
      let replacedId: string | null = null;
      if (rows.length >= SELF_MODEL_CONVERSATION_OPINION_CAP) {
        const weakest = [...rows].sort((left, right) =>
          left.strength * left.confidence - right.strength * right.confidence
          || left.updated_at.localeCompare(right.updated_at)
          || left.opinion_id.localeCompare(right.opinion_id)
        )[0] as OpinionRow;
        if (weakest.strength * weakest.confidence > strength * confidence) {
          return { kind: "skipped", reason: "opinion cap reached and every kept opinion is stronger" } as const;
        }
        this.archiveOpinion(weakest, timestamp, "dropped");
        this.db.prepare(`DELETE FROM self_conversation_opinions WHERE opinion_id=?`).run(weakest.opinion_id);
        replacedId = weakest.opinion_id;
      }
      const id = `opinion-${timestamp.replaceAll(/[:.]/g, "-").toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;
      this.db.prepare(
        `INSERT INTO self_conversation_opinions
         (opinion_id, category, subject, subject_key, stance, strength, confidence, actor_id, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(id, category, subject, subjectKey, stance, strength, confidence, actorId, timestamp, timestamp);
      return { kind: "added", id, replacedId } as const;
    });
  }

  /**
   * Keep what code noticed about his tastes in a turn, then apply any nudge
   * the evidence now supports. One row per taste, kind and local day; rows
   * older than the retention window are dropped.
   */
  recordTasteEvidence(observations: readonly TasteEvidenceObservation[], rawActorId: string): TasteEvidenceOutcome {
    if (observations.length === 0) return { recorded: 0, nudges: [] };
    const actorId = boundedString(rawActorId, "evidence actorId", 100);
    const at = this.now();
    const timestamp = at.toISOString();
    const day = localDay(at);
    return inTransaction(this.db, () => {
      this.db.prepare(`DELETE FROM self_taste_evidence WHERE created_at < ?`)
        .run(new Date(at.getTime() - TASTE_EVIDENCE_RETENTION_DAYS * 24 * 60 * 60_000).toISOString());
      let recorded = 0;
      const touched = new Set<string>();
      for (const observation of observations) {
        if (!TASTE_EVIDENCE_KINDS.includes(observation.kind)) continue;
        const preference = observation.preferenceId ? this.preference(observation.preferenceId) : null;
        if (observation.preferenceId && (!preference || preference.status !== "active")) continue;
        const subject = boundedString(preference?.subject ?? observation.subject, "evidence subject", 160);
        const subjectKey = preference ? `pref:${preference.id}` : candidateSubjectKey(subject);
        const result = this.db.prepare(
          `INSERT INTO self_taste_evidence
           (preference_id, subject_key, subject, kind, day, actor_id, summary, created_at, nudged_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(subject_key, kind, day) DO NOTHING`,
        ).run(preference?.id ?? null, subjectKey, subject, observation.kind, day, actorId,
          truncateText(observation.summary || subject, 200), timestamp);
        if (Number(result.changes) > 0) {
          recorded += 1;
          if (preference) touched.add(preference.id);
        }
      }
      const nudges = [...touched].flatMap((id) => this.nudgeFromEvidence(id, timestamp));
      return { recorded, nudges };
    });
  }

  listTasteEvidence(limit = 50): readonly TasteEvidence[] {
    const rows = this.db.prepare(
      `SELECT * FROM self_taste_evidence ORDER BY created_at DESC, evidence_id DESC LIMIT ?`,
    ).all(Math.max(1, Math.min(500, limit))) as unknown as EvidenceRow[];
    return rows.map(parseEvidenceRow);
  }

  /** Artists with no taste, played through the assistant on enough days to be weighed by the review. */
  tasteCandidates(): readonly TasteCandidate[] {
    const rows = this.db.prepare(
      `SELECT * FROM self_taste_evidence WHERE preference_id IS NULL AND kind='played'
       ORDER BY created_at ASC, evidence_id ASC`,
    ).all() as unknown as EvidenceRow[];
    const groups = new Map<string, EvidenceRow[]>();
    for (const row of rows) groups.set(row.subject_key, [...(groups.get(row.subject_key) ?? []), row]);
    return [...groups.values()]
      .filter((group) => new Set(group.map((row) => row.day)).size >= TASTE_CANDIDATE_PLAY_DAYS)
      .map((group) => ({
        subject: (group.at(-1) as EvidenceRow).subject,
        days: new Set(group.map((row) => row.day)).size,
        lastPlayedAt: (group.at(-1) as EvidenceRow).created_at,
        evidenceIds: group.map((row) => row.evidence_id),
      }))
      .sort((left, right) => right.days - left.days || right.lastPlayedAt.localeCompare(left.lastPlayedAt));
  }

  status(): SelfModelStatus {
    const preferences = this.listPreferences();
    return {
      enabled: this.reviewer !== null,
      preferenceCount: preferences.length,
      activeCount: preferences.filter((preference) => preference.status === "active").length,
      lockedCount: preferences.filter((preference) => preference.locked).length,
      seedVersion: Number(this.meta("seed_version") ?? "0"),
      lastAttemptAt: this.meta("last_attempt_at"),
      lastReviewedAt: this.meta("last_reviewed_at"),
      nextReviewAt: requiredIso(this.meta("next_review_at"), "self model next_review_at"),
      reviewStatus: reviewStatus(this.meta("review_status")),
      lastSummary: this.meta("last_summary"),
      lastError: this.meta("last_error"),
    };
  }

  snapshot(reviewLimit = 12): SelfModelSnapshot {
    const rows = this.db.prepare(
      `SELECT review_id, reviewed_at, source, status, summary, change_count
       FROM self_model_reviews ORDER BY reviewed_at DESC, review_id DESC LIMIT ?`,
    ).all(Math.max(1, Math.min(50, reviewLimit))) as unknown as ReviewRow[];
    return {
      ok: true,
      status: this.status(),
      preferences: this.listPreferences(),
      recentReviews: rows.map(parseReviewRow),
      recentEvidence: this.listTasteEvidence(20),
      candidates: this.tasteCandidates(),
      opinions: this.listConversationOpinions(),
    };
  }

  /**
   * Each taste's last change within the window, newest first. Reseed
   * parking rows and lock/unlock are not changes to what he likes.
   */
  recentTasteChanges(days: number = SELF_REVIEW_LIMITS.changedLatelyDays): readonly SelfTasteChange[] {
    const since = new Date(this.now().getTime() - days * 24 * 60 * 60_000).toISOString();
    const rows = this.db.prepare(
      `SELECT c.preference_id, c.before_json, c.after_json, r.reviewed_at, r.source
       FROM self_model_changes c JOIN self_model_reviews r ON r.review_id = c.review_id
       WHERE r.reviewed_at >= ? ORDER BY r.reviewed_at DESC, c.change_sequence DESC`,
    ).all(since) as unknown as {
      preference_id: string; before_json: string; after_json: string; reviewed_at: string; source: string;
    }[];
    return rows.flatMap((row): SelfTasteChange[] => {
      const after = JSON.parse(row.after_json) as Record<string, unknown>;
      if (typeof after.stance !== "string" || typeof after.subject !== "string") return [];
      const before = JSON.parse(row.before_json) as Record<string, unknown>;
      const stanceBefore = typeof before.stance === "string" ? before.stance : null;
      const kind: SelfTasteChange["kind"] = before.added === true
        ? "added"
        : after.status === "retired" && before.status !== "retired"
          ? "retired"
          : before.status === "retired" && after.status !== "retired"
            ? "restored"
            : "changed";
      return [{
        preferenceId: row.preference_id,
        subject: after.subject,
        kind,
        stanceBefore,
        stanceAfter: after.stance,
        changedAt: row.reviewed_at,
        source: row.source === "automatic" ? "automatic" : "operator",
      }];
    });
  }

  /** The Dashboard Review tab: active tastes with lock and undo state, and his chat opinions. */
  dashboardTastes(): SelfModelDashboardTastes {
    return {
      items: this.listPreferences().filter((item) => item.status === "active").map((item) => ({
        id: item.id,
        category: item.category,
        subject: item.subject,
        stance: item.stance,
        locked: item.locked,
        canUndo: this.previousPreferenceSnapshot(item.id) !== null,
      })),
      opinions: this.listConversationOpinions().map(({ id, subject, stance }) => ({ id, subject, stance })),
    };
  }

  /** The owner's cleanup: drop one chat opinion for good. */
  /** Views he has revised or let go, newest first. */
  formerOpinions(limit = 50): readonly FormerOpinion[] {
    return (this.db.prepare(
      "SELECT subject, stance, last_said, replaced_at, why FROM self_opinion_history ORDER BY history_id DESC LIMIT ?",
    ).all(limit) as unknown as {
      readonly subject: string;
      readonly stance: string;
      readonly last_said: string;
      readonly replaced_at: string;
      readonly why: string;
    }[]).map((row) => ({
      subject: row.subject,
      stance: row.stance,
      lastSaid: row.last_said,
      replacedAt: row.replaced_at,
      why: row.why === "dropped" ? "dropped" : "revised",
    }));
  }

  private archiveOpinion(row: OpinionRow, at: string, why: FormerOpinion["why"]): void {
    this.db.prepare(
      "INSERT INTO self_opinion_history (subject, stance, last_said, replaced_at, why) VALUES (?, ?, ?, ?, ?)",
    ).run(row.subject, row.stance, row.updated_at, at, why);
    this.db.prepare(
      `DELETE FROM self_opinion_history WHERE history_id NOT IN
       (SELECT history_id FROM self_opinion_history ORDER BY history_id DESC LIMIT ?)`,
    ).run(SELF_OPINION_HISTORY_CAP);
  }

  /** Forgetting is not history: a forgotten view leaves no trace. */
  forgetConversationOpinion(rawId: unknown): boolean {
    const id = boundedString(rawId, "opinionId", 100);
    return Number(this.db.prepare(`DELETE FROM self_conversation_opinions WHERE opinion_id=?`).run(id).changes) > 0;
  }

  applyOperatorAction(raw: unknown): SelfModelSnapshot {
    const value = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (value.action === "forget_opinion") {
      if (!this.forgetConversationOpinion(value.opinionId)) throw new Error("chat opinion was not found");
      return this.snapshot();
    }
    const action = parseOperatorAction(raw);
    const current = this.preference(action.preferenceId);
    if (!current) throw new Error("self preference was not found");
    const timestamp = this.now().toISOString();
    if (action.action === "rollback") {
      const previous = this.previousPreferenceSnapshot(action.preferenceId);
      if (!previous) throw new Error("self preference has no change to roll back");
      // Undo is one step: the version it replaces becomes the one kept, so a
      // second undo puts it back. A taste the review added is undone by retiring it.
      const restored = previous === "added" ? { ...current, status: "retired" as const } : previous;
      this.applyChanges("operator", `Rolled back ${current.subject}.`, [{
        id: current.id,
        stance: restored.stance,
        strength: restored.strength,
        confidence: restored.confidence,
        rationale: restored.rationale,
        status: restored.status,
        reason: previous === "added" ? "Operator rollback: retired an added taste" : "Operator rollback",
      }], timestamp, new Map([[current.id, current.locked]]));
      return this.snapshot();
    }
    const next: SelfModelReviewChange = {
      id: current.id,
      stance: current.stance,
      strength: current.strength,
      confidence: current.confidence,
      rationale: current.rationale,
      status: current.status,
      reason: `Operator ${action.action}`,
    };
    this.applyChanges("operator", `${action.action} ${current.subject}.`, [next], timestamp, new Map([[current.id, action.action === "lock"]]));
    return this.snapshot();
  }

  private async runAutomaticReview(): Promise<boolean> {
    if (!this.reviewer) return false;
    const attemptedAt = this.now().toISOString();
    const reviewId = `self-review-${attemptedAt.replaceAll(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
    this.setMeta("last_attempt_at", attemptedAt);
    try {
      const input = this.reviewInput(reviewId, attemptedAt);
      // Every change needs evidence (rule 5), so with none there is nothing
      // the model could validly do: skip the call.
      if (input.evidence.length === 0 && input.candidates.length === 0 && !input.opinions.some((opinion) => opinion.promotable)) {
        this.applyAutomaticReview(input, { summary: "Nothing new to weigh this week.", changes: [], additions: [] }, this.now().toISOString());
        return true;
      }
      const proposal = await this.reviewer.review(input);
      this.applyAutomaticReview(input, proposal, this.now().toISOString());
      return true;
    } catch (error) {
      const failedAt = this.now().toISOString();
      const message = truncateText(error instanceof Error ? error.message : String(error), 500);
      inTransaction(this.db, () => {
        this.db.prepare(
          `INSERT INTO self_model_reviews
           (review_id, reviewed_at, source, status, summary, change_count)
           VALUES (?, ?, 'automatic', 'error', ?, 0)`,
        ).run(reviewId, failedAt, message);
        this.trimReviews();
        this.setMeta("review_status", "error");
        this.setMeta("last_error", message);
        this.setMeta("next_review_at", new Date(this.now().getTime() + SELF_MODEL_RETRY_INTERVAL_MS).toISOString());
      });
      throw error;
    }
  }

  private applyChanges(
    source: "automatic" | "operator",
    summary: string,
    rawChanges: readonly SelfModelReviewChange[],
    timestamp: string,
    lockOverrides: ReadonlyMap<string, boolean> = new Map(),
    requestedReviewId?: string,
    /** More work inside the same transaction (review additions); returns how many it applied. */
    alsoInTransaction?: (reviewId: string) => number,
  ): void {
    const changes = validateReviewChanges(rawChanges, this.listPreferences());
    const reviewId = requestedReviewId
      ?? `self-${source}-${timestamp.replaceAll(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
    inTransaction(this.db, () => {
      this.db.prepare(
        `INSERT INTO self_model_reviews
         (review_id, reviewed_at, source, status, summary, change_count)
         VALUES (?, ?, ?, 'ok', ?, 0)`,
      ).run(reviewId, timestamp, source, truncateText(summary, 1000));
      let applied = 0;
      for (const change of changes) {
        const before = this.preference(change.id);
        if (!before || (source === "automatic" && before.locked)) continue;
        const locked = lockOverrides.get(before.id) ?? before.locked;
        const after: SelfPreference = {
          ...before,
          stance: change.stance,
          strength: change.strength,
          confidence: change.confidence,
          rationale: change.rationale,
          status: change.status,
          locked,
          revision: before.revision + 1,
          updatedAt: timestamp,
          lastReviewedAt: source === "automatic" ? timestamp : before.lastReviewedAt,
        };
        if (sameMutablePreference(before, after)) continue;
        // A lock or unlock alone is not a change to what he likes: it keeps
        // the change log (and so the undo step) as it was.
        if (sameTaste(before, after)) {
          this.db.prepare(`UPDATE self_preferences SET locked=? WHERE preference_id=?`).run(after.locked ? 1 : 0, after.id);
          applied += 1;
          continue;
        }
        this.db.prepare(
          `UPDATE self_preferences SET stance=?, strength=?, confidence=?, rationale=?, locked=?, status=?,
           revision=?, updated_at=?, last_reviewed_at=? WHERE preference_id=?`,
        ).run(
          after.stance, after.strength, after.confidence, after.rationale, after.locked ? 1 : 0,
          after.status, after.revision, after.updatedAt, after.lastReviewedAt, after.id,
        );
        this.writeChangeRow(reviewId, after.id, before, after, change.reason);
        applied += 1;
      }
      if (source === "automatic") {
        this.db.prepare(`UPDATE self_preferences SET last_reviewed_at=?`).run(timestamp);
      }
      if (alsoInTransaction) applied += alsoInTransaction(reviewId);
      this.db.prepare(`UPDATE self_model_reviews SET change_count=? WHERE review_id=?`).run(applied, reviewId);
      this.trimReviews();
      if (source === "automatic") {
        this.setMeta("last_reviewed_at", timestamp);
        this.setMeta("next_review_at", new Date(Date.parse(timestamp) + SELF_MODEL_REVIEW_INTERVAL_MS).toISOString());
        this.setMeta("review_status", "ok");
        this.setMeta("last_summary", truncateText(summary, 1000));
        this.setMeta("last_error", null);
      }
    });
  }

  /** What the weekly review is shown: tastes, the week's evidence, candidates, chat opinions, recent changes. */
  private reviewInput(reviewId: string, requestedAt: string): SelfModelReviewInput {
    const candidates = this.tasteCandidates();
    const candidateIds = new Set(candidates.flatMap((candidate) => candidate.evidenceIds));
    // Artists played on too few days are not shown yet; their rows keep counting.
    const evidence = this.listTasteEvidence(500)
      .filter((row) => row.preferenceId !== null || candidateIds.has(row.id))
      .slice(0, SELF_REVIEW_LIMITS.evidenceRows);
    const shown = new Set(evidence.map((row) => row.id));
    const changeRows = this.db.prepare(
      `SELECT c.preference_id, c.before_json, c.after_json, c.reason, r.reviewed_at
       FROM self_model_changes c JOIN self_model_reviews r ON r.review_id = c.review_id
       ORDER BY c.change_sequence DESC LIMIT ?`,
    ).all(SELF_REVIEW_LIMITS.recentChanges * 4) as unknown as {
      preference_id: string; before_json: string; after_json: string; reason: string; reviewed_at: string;
    }[];
    const recentChanges = changeRows.flatMap((row): SelfModelRecentChange[] => {
      const after = JSON.parse(row.after_json) as Record<string, unknown>;
      if (typeof after.stance !== "string") return []; // reseed parking rows
      const before = JSON.parse(row.before_json) as Record<string, unknown>;
      return [{
        preferenceId: row.preference_id,
        reviewedAt: row.reviewed_at,
        reason: row.reason,
        stanceBefore: typeof before.stance === "string" ? before.stance : null,
        stanceAfter: after.stance,
        statusAfter: preferenceStatus(after.status),
      }];
    }).slice(0, SELF_REVIEW_LIMITS.recentChanges);
    return {
      reviewId,
      requestedAt,
      preferences: this.listPreferences(),
      evidence,
      // Only the rows actually shown can be cited.
      candidates: candidates
        .map((candidate) => ({ ...candidate, evidenceIds: candidate.evidenceIds.filter((id) => shown.has(id)) }))
        .filter((candidate) => candidate.evidenceIds.length > 0),
      opinions: this.listConversationOpinions()
        .map((opinion, index) => ({
          ...opinion,
          promotable: opinion.revision >= SELF_REVIEW_LIMITS.promotableOpinionRevision,
          recent: index < SELF_REVIEW_RECENT_OPINIONS,
        }))
        .filter((opinion) => opinion.promotable || opinion.recent)
        .map(({ recent: _recent, ...opinion }) => opinion),
      recentChanges,
    };
  }

  /**
   * Apply what the model proposed, item by item: code checks each change
   * and addition against the evidence it was shown and drops what fails,
   * then deletes the evidence rows the review used (rule 6). Candidate
   * `played` rows stay until a taste is made from them, or the 30-day
   * window ages them out, so their day count is not reset each week.
   */
  private applyAutomaticReview(input: SelfModelReviewInput, proposal: SelfModelReviewProposal, timestamp: string): void {
    const { changes, additions, rejections } = validateAutomaticReview(input, proposal);
    const summary = rejections.length === 0
      ? proposal.summary
      : `${proposal.summary} Code refused ${rejections.length}: ${rejections.map((rejection) => `${rejection.item} (${rejection.reason})`).join("; ")}.`;
    this.applyChanges("automatic", summary, changes, timestamp, new Map(), input.reviewId, (reviewId) => {
      let added = 0;
      const usedCandidateIds = new Set<number>();
      for (const addition of additions) {
        const id = this.newPreferenceId(addition.category, addition.subject);
        const preference: SelfPreference = {
          id,
          category: addition.category,
          subject: addition.subject,
          stance: addition.stance,
          strength: addition.strength,
          confidence: addition.confidence,
          rationale: addition.rationale,
          provenance: {
            kind: "model_decided",
            note: addition.fromOpinionId
              ? `Promoted from a chat opinion by the weekly review ${reviewId}.`
              : `Added from music played through ${assistantName()} by the weekly review ${reviewId}.`,
            sourceUrls: [],
          },
          locked: false,
          status: "active",
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastReviewedAt: timestamp,
        };
        this.db.prepare(
          `INSERT INTO self_preferences
           (preference_id, category, subject, stance, strength, confidence, rationale,
            provenance_json, locked, status, revision, created_at, updated_at, last_reviewed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', 1, ?, ?, ?)`,
        ).run(
          id, preference.category, preference.subject, preference.stance, preference.strength,
          preference.confidence, preference.rationale, JSON.stringify(preference.provenance),
          timestamp, timestamp, timestamp,
        );
        const opinion = addition.fromOpinionId
          ? input.opinions.find((item) => item.id === addition.fromOpinionId) ?? null
          : null;
        this.writeChangeRow(reviewId, id, { added: true, ...(opinion ? { fromOpinion: opinion } : {}) },
          preference, addition.reason);
        if (addition.fromOpinionId) {
          this.db.prepare(`DELETE FROM self_conversation_opinions WHERE opinion_id=?`).run(addition.fromOpinionId);
        }
        for (const evidenceId of addition.evidenceIds) usedCandidateIds.add(evidenceId);
        added += 1;
      }
      // Rows the review saw are used up. Candidate rows go only with the taste made from them.
      const candidateRowIds = new Set(input.candidates.flatMap((candidate) => candidate.evidenceIds));
      const usedCandidateKeys = input.candidates
        .filter((candidate) => candidate.evidenceIds.some((evidenceId) => usedCandidateIds.has(evidenceId)))
        .map((candidate) => candidateSubjectKey(candidate.subject));
      for (const row of input.evidence) {
        if (candidateRowIds.has(row.id)) continue;
        this.db.prepare(`DELETE FROM self_taste_evidence WHERE evidence_id=?`).run(row.id);
      }
      for (const key of usedCandidateKeys) {
        this.db.prepare(`DELETE FROM self_taste_evidence WHERE subject_key=? AND preference_id IS NULL`).run(key);
      }
      return added;
    });
    // A taste added this week may own the subject of a chat opinion.
    this.retireOwnedOpinions();
  }

  /** One change row per taste (rule 6): the new row replaces whatever was kept for it. */
  private writeChangeRow(reviewId: string, preferenceId: string, before: unknown, after: unknown, reason: string): void {
    this.db.prepare(`DELETE FROM self_model_changes WHERE preference_id=?`).run(preferenceId);
    this.db.prepare(
      `INSERT INTO self_model_changes
       (review_id, preference_id, before_json, after_json, reason)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(reviewId, preferenceId, JSON.stringify(before), JSON.stringify(after), reason);
  }

  /** Older stores kept every change; keep only each taste's last. */
  private compactChangeLog(): void {
    this.db.prepare(
      `DELETE FROM self_model_changes WHERE change_sequence NOT IN
       (SELECT MAX(change_sequence) FROM self_model_changes GROUP BY preference_id)`,
    ).run();
  }

  /**
   * Review summaries keep the last few only (rule 6). An older review a
   * change row still points at keeps its date (what changed lately needs
   * it) but loses its summary; the rest go.
   */
  private trimReviews(): void {
    const kept = `SELECT review_id FROM self_model_reviews ORDER BY reviewed_at DESC, review_id DESC LIMIT ${SELF_REVIEW_LIMITS.keptReviews}`;
    this.db.prepare(
      `DELETE FROM self_model_reviews WHERE review_id NOT IN (${kept})
       AND review_id NOT IN (SELECT review_id FROM self_model_changes)`,
    ).run();
    this.db.prepare(
      `UPDATE self_model_reviews SET summary='' WHERE review_id NOT IN (${kept}) AND summary <> ''`,
    ).run();
  }

  /**
   * A taste owns its subject (rule 4), including a chat opinion stored before
   * the rule caught it ("favourite colour" when a taste is his favourite
   * colour). What it said becomes evidence for the review, and it goes.
   */
  private retireOwnedOpinions(): void {
    const preferences = this.listPreferences();
    for (const opinion of this.listConversationOpinions()) {
      const owner = tasteOwningSubject(preferences, opinion.subject);
      if (!owner) continue;
      this.recordTasteEvidence([{
        preferenceId: owner.id,
        subject: owner.subject,
        kind: "chat_opinion",
        summary: truncateText(`Said in chat: ${opinion.stance}`, 160),
      }], opinion.actorId);
      this.forgetConversationOpinion(opinion.id);
      console.info(`[brain] chat opinion ${opinion.id} (${opinion.subject}) left: ${owner.id} owns its subject`);
    }
  }

  private newPreferenceId(category: string, subject: string): string {
    const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const base = `${slug(category) || "taste"}-${slug(subject) || "added"}`.slice(0, 90).replace(/-+$/, "");
    for (let suffix = 1; ; suffix += 1) {
      const id = suffix === 1 ? base : `${base}-${suffix}`;
      if (!this.preference(id)) return id;
    }
  }

  /** Called inside the evidence transaction; nudges are not review changes and leave the change log alone. */
  private nudgeFromEvidence(preferenceId: string, timestamp: string): readonly TasteNudge[] {
    const preference = this.preference(preferenceId);
    if (!preference || preference.locked || preference.status !== "active") return [];
    const nudges: TasteNudge[] = [];
    const pending = (kinds: readonly TasteEvidenceKind[]) => this.db.prepare(
      `SELECT * FROM self_taste_evidence WHERE preference_id=? AND nudged_at IS NULL
       AND kind IN (${kinds.map(() => "?").join(",")})`,
    ).all(preferenceId, ...kinds) as unknown as EvidenceRow[];
    const markNudged = (rows: readonly EvidenceRow[]) => {
      for (const row of rows) {
        this.db.prepare(`UPDATE self_taste_evidence SET nudged_at=? WHERE evidence_id=?`).run(timestamp, row.evidence_id);
      }
    };

    const exposure = pending(TASTE_EXPOSURE_KINDS);
    if (new Set(exposure.map((row) => row.day)).size >= TASTE_NUDGE.exposureDays) {
      const to = Math.min(TASTE_NUDGE.strengthCeiling, roundStep(preference.strength + TASTE_NUDGE.strengthStep));
      if (to > preference.strength) {
        this.db.prepare(`UPDATE self_preferences SET strength=? WHERE preference_id=?`).run(to, preferenceId);
        nudges.push({ preferenceId, field: "strength", from: preference.strength, to, evidenceIds: exposure.map((row) => row.evidence_id) });
      }
      markNudged(exposure);
    }

    const pushback = pending(["pushback"]);
    if (new Set(pushback.map((row) => row.day)).size >= TASTE_NUDGE.pushbackDays) {
      const to = Math.max(TASTE_NUDGE.confidenceFloor, roundStep(preference.confidence - TASTE_NUDGE.confidenceStep));
      if (to < preference.confidence) {
        this.db.prepare(`UPDATE self_preferences SET confidence=? WHERE preference_id=?`).run(to, preferenceId);
        nudges.push({ preferenceId, field: "confidence", from: preference.confidence, to, evidenceIds: pushback.map((row) => row.evidence_id) });
      }
      markNudged(pushback);
    }
    return nudges;
  }

  /** The one version kept for undo; "added" when the review made the taste. */
  private previousPreferenceSnapshot(preferenceId: string): SelfPreference | "added" | null {
    const row = this.db.prepare(
      `SELECT before_json, after_json FROM self_model_changes
       WHERE preference_id=? ORDER BY change_sequence DESC LIMIT 1`,
    ).get(preferenceId) as { readonly before_json: string; readonly after_json: string } | undefined;
    if (!row) return null;
    const before = JSON.parse(row.before_json) as Record<string, unknown>;
    const after = JSON.parse(row.after_json) as Record<string, unknown>;
    if (before.added === true) return "added";
    // A reseed parking row belongs to an older seed's taste of the same id, not to this one.
    return after.parked === true ? null : parsePreference(before);
  }

  private preference(id: string): SelfPreference | null {
    const row = this.db.prepare(`SELECT * FROM self_preferences WHERE preference_id=?`).get(id) as PreferenceRow | undefined;
    return row ? parsePreferenceRow(row) : null;
  }

  private seed(file: SelfPreferenceSeedFile): void {
    const existingCount = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM self_preferences`).get() as { count: number }).count);
    const storedSeedVersion = Number(this.meta("seed_version") ?? "0");
    if (existingCount > 0 && storedSeedVersion < file.seedVersion) {
      this.reseed(file);
    } else if (existingCount === 0) {
      const now = this.now().toISOString();
      inTransaction(this.db, () => {
        this.insertSeedPreferences(file, now);
        this.setMeta("seed_version", String(file.seedVersion));
        this.setMeta("last_attempt_at", null);
        this.setMeta("last_reviewed_at", null);
        this.setMeta("next_review_at", new Date(this.now().getTime() + SELF_MODEL_REVIEW_INTERVAL_MS).toISOString());
        this.setMeta("review_status", "seeded");
        this.setMeta("last_summary", `Seeded ${file.preferences.length} preferences.`);
        this.setMeta("last_error", null);
      });
    }
    // The review may add tastes, so the store holds every seeded taste plus any added since.
    const stored = new Set(this.listPreferences().map((preference) => preference.id));
    const missing = file.preferences.filter((preference) => !stored.has(preference.id)).length;
    if (missing > 0) {
      throw new Error(`self model requires the seed's ${file.preferences.length} preferences; ${missing} are missing`);
    }
  }

  /**
   * A newer seed version replaces the whole preference set: every existing
   * record is parked in the change history (so nothing is lost) and removed,
   * then the new seed goes in. Conversation opinions are left alone.
   */
  private reseed(file: SelfPreferenceSeedFile): void {
    const now = this.now().toISOString();
    const parked = this.listPreferences();
    const reviewId = `self-reseed-${now.replaceAll(/[:.]/g, "-")}-v${file.seedVersion}`;
    const summary = `Reseeded to seed version ${file.seedVersion}: parked ${parked.length} earlier preferences and seeded ${file.preferences.length}.`;
    inTransaction(this.db, () => {
      this.db.prepare(
        `INSERT INTO self_model_reviews
         (review_id, reviewed_at, source, status, summary, change_count)
         VALUES (?, ?, 'operator', 'ok', ?, ?)`,
      ).run(reviewId, now, summary, parked.length);
      for (const preference of parked) {
        this.writeChangeRow(reviewId, preference.id, preference, { parked: true }, `Parked by seed version ${file.seedVersion}`);
      }
      this.db.prepare(`DELETE FROM self_preferences`).run();
      this.insertSeedPreferences(file, now);
      this.setMeta("seed_version", String(file.seedVersion));
      this.setMeta("next_review_at", new Date(this.now().getTime() + SELF_MODEL_REVIEW_INTERVAL_MS).toISOString());
      this.setMeta("last_summary", summary);
    });
  }

  private insertSeedPreferences(file: SelfPreferenceSeedFile, now: string): void {
    for (const seed of file.preferences) {
      this.db.prepare(
        `INSERT INTO self_preferences
         (preference_id, category, subject, stance, strength, confidence, rationale,
          provenance_json, locked, status, revision, created_at, updated_at, last_reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', 1, ?, ?, NULL)`,
      ).run(
        seed.id, seed.category, seed.subject, seed.stance, seed.strength, seed.confidence,
        seed.rationale, JSON.stringify(seed.provenance), now, now,
      );
    }
  }

  private meta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM self_model_meta WHERE key=?`).get(key) as MetaRow | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string | null): void {
    this.db.prepare(
      `INSERT INTO self_model_meta(key,value) VALUES(?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run(key, value);
  }
}

function migrateSelfModel(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS self_model_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS self_preferences (
      preference_id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      subject TEXT NOT NULL,
      stance TEXT NOT NULL,
      strength REAL NOT NULL CHECK(strength >= 0 AND strength <= 1),
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      rationale TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      locked INTEGER NOT NULL CHECK(locked IN (0,1)),
      status TEXT NOT NULL CHECK(status IN ('active','retired')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_reviewed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS self_model_reviews (
      review_id TEXT PRIMARY KEY,
      reviewed_at TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('automatic','operator')),
      status TEXT NOT NULL CHECK(status IN ('ok','error')),
      summary TEXT NOT NULL,
      change_count INTEGER NOT NULL CHECK(change_count >= 0)
    );
    CREATE TABLE IF NOT EXISTS self_conversation_opinions (
      opinion_id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      subject TEXT NOT NULL,
      subject_key TEXT NOT NULL UNIQUE,
      stance TEXT NOT NULL,
      strength REAL NOT NULL CHECK(strength >= 0 AND strength <= 1),
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      actor_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS self_model_changes (
      change_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id TEXT NOT NULL REFERENCES self_model_reviews(review_id),
      preference_id TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS self_taste_evidence (
      evidence_id INTEGER PRIMARY KEY AUTOINCREMENT,
      preference_id TEXT,
      subject_key TEXT NOT NULL,
      subject TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('mention','asked','pushback','agreement','played','chat_opinion')),
      day TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      nudged_at TEXT,
      UNIQUE(subject_key, kind, day)
    );
    CREATE INDEX IF NOT EXISTS self_taste_evidence_created ON self_taste_evidence(created_at);
    CREATE TABLE IF NOT EXISTS self_opinion_history (
      history_id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      stance TEXT NOT NULL,
      last_said TEXT NOT NULL,
      replaced_at TEXT NOT NULL,
      why TEXT NOT NULL CHECK(why IN ('revised','dropped'))
    );
  `);
  ensureMetaSchemaVersion(db, "self_model_meta", SELF_MODEL_SCHEMA_VERSION, "self model");
}

type OperatorAction = {
  readonly preferenceId: string;
  readonly action: "lock" | "unlock" | "rollback";
};

function parseOperatorAction(raw: unknown): OperatorAction {
  const value = objectValue(raw, "self model action");
  const preferenceId = boundedString(value.preferenceId, "preferenceId", 100);
  const action = value.action;
  if (action !== "lock" && action !== "unlock" && action !== "rollback") {
    throw new Error("self model action is unsupported");
  }
  return { preferenceId, action };
}

function parseSeedFile(filePath: string | URL): SelfPreferenceSeedFile {
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  const value = objectValue(raw, "self preference seed file");
  if (value.schemaVersion !== 1) throw new Error("self preference seed schemaVersion must be 1");
  if (!Number.isInteger(value.seedVersion) || Number(value.seedVersion) < 1) {
    throw new Error("self preference seedVersion must be a positive integer");
  }
  if (
    !Array.isArray(value.preferences)
    || value.preferences.length === 0
    || value.preferences.length > SELF_MODEL_MAX_PREFERENCE_COUNT
  ) {
    throw new Error(`self preference seed file must contain 1 to ${SELF_MODEL_MAX_PREFERENCE_COUNT} preferences`);
  }
  const preferences = value.preferences.map(parseSeedPreference);
  if (new Set(preferences.map((preference) => preference.id)).size !== preferences.length) {
    throw new Error("self preference seed ids must be unique");
  }
  return { schemaVersion: 1, seedVersion: Number(value.seedVersion), preferences };
}

function parseSeedPreference(raw: unknown): SelfPreferenceSeed {
  const value = objectValue(raw, "self preference seed");
  const provenanceValue = objectValue(value.provenance, "self preference provenance");
  const kind = typeof provenanceValue.kind === "string" && provenanceValue.kind.startsWith("documented_")
    ? "documented_seed"
    : provenanceValue.kind;
  if (kind !== "self_chosen" && kind !== "documented_seed" && kind !== "model_decided") {
    throw new Error("self preference provenance kind is unsupported");
  }
  const urls = Array.isArray(provenanceValue.sourceUrls)
    ? provenanceValue.sourceUrls.map((url) => boundedString(url, "sourceUrl", 1000))
    : [];
  if (urls.some((url) => !/^https?:\/\//i.test(url))) throw new Error("self preference sourceUrl must be HTTP(S)");
  return {
    id: identifier(value.id, "self preference id"),
    category: boundedString(value.category, "category", 80),
    subject: boundedString(value.subject, "subject", 160),
    stance: boundedString(value.stance, "stance", 500),
    strength: unitNumber(value.strength, "strength"),
    confidence: unitNumber(value.confidence, "confidence"),
    rationale: boundedString(value.rationale, "rationale", 1000),
    provenance: {
      kind,
      note: boundedString(provenanceValue.note, "provenance note", 500),
      sourceUrls: urls,
    },
  };
}

function parsePreferenceRow(row: PreferenceRow): SelfPreference {
  return parsePreference({
    id: row.preference_id,
    category: row.category,
    subject: row.subject,
    stance: row.stance,
    strength: row.strength,
    confidence: row.confidence,
    rationale: row.rationale,
    provenance: JSON.parse(row.provenance_json) as unknown,
    locked: row.locked === 1,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastReviewedAt: row.last_reviewed_at,
  });
}

function parsePreference(raw: unknown): SelfPreference {
  const value = objectValue(raw, "self preference");
  const seed = parseSeedPreference({
    id: value.id,
    category: value.category,
    subject: value.subject,
    stance: value.stance,
    strength: value.strength,
    confidence: value.confidence,
    rationale: value.rationale,
    provenance: value.provenance,
  });
  if (typeof value.locked !== "boolean") throw new Error("self preference locked must be boolean");
  if (!Number.isInteger(value.revision) || Number(value.revision) < 1) throw new Error("self preference revision is invalid");
  return {
    ...seed,
    locked: value.locked,
    status: preferenceStatus(value.status),
    revision: Number(value.revision),
    createdAt: requiredIso(value.createdAt, "self preference createdAt"),
    updatedAt: requiredIso(value.updatedAt, "self preference updatedAt"),
    lastReviewedAt: value.lastReviewedAt === null ? null : requiredIso(value.lastReviewedAt, "self preference lastReviewedAt"),
  };
}

function validateReviewChanges(
  raw: readonly SelfModelReviewChange[],
  preferences: readonly SelfPreference[],
): readonly SelfModelReviewChange[] {
  if (raw.length > SELF_MODEL_MAX_PREFERENCE_COUNT) throw new Error("self review returned too many changes");
  const known = new Set(preferences.map((preference) => preference.id));
  const seen = new Set<string>();
  return raw.map((change) => {
    const id = identifier(change.id, "review preference id");
    if (!known.has(id)) throw new Error(`self review returned unknown preference: ${id}`);
    if (seen.has(id)) throw new Error(`self review returned duplicate preference: ${id}`);
    seen.add(id);
    return {
      id,
      stance: boundedString(change.stance, "review stance", 500),
      strength: unitNumber(change.strength, "review strength"),
      confidence: unitNumber(change.confidence, "review confidence"),
      rationale: boundedString(change.rationale, "review rationale", 1000),
      status: preferenceStatus(change.status),
      reason: boundedString(change.reason, "review reason", 500),
    };
  });
}

/**
 * Rule 7: a taste never claims he tasted, heard, watched or lived something.
 * Returns what is wrong, or null. Judgement words ("I see why") are fine.
 */
export function tasteHonestyProblem(text: string): string | null {
  const value = ` ${text.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ")} `;
  const checks: readonly [RegExp, string][] = [
    [/\bi(?:'ve| have| had)? (?:(?:once|first|finally|always|never|just|recently) )?(?:tasted|smelt|smelled|heard|listened to|watched|eaten|ate|drunk|drank|visited|touched|been to|seen (?:it|them|him|her) (?:live|in person|play))\b/, "claims a lived experience"],
    [/\bi (?:(?:still|always|often|usually|really) )?(?:taste|smell|eat|drink|listen to|hum along|sing along|watch)\b/, "claims a sense he has not got"],
    [/\b(?:when i was (?:young|a kid|little|a boy|growing up|at school)|my (?:childhood|youth|mum|mother|dad|father|parents|school days))\b/, "claims a human biography"],
    [/\b(?:i can still|reminds me of the (?:smell|taste|sound))\b/, "claims a sensory memory"],
  ];
  for (const [pattern, problem] of checks) if (pattern.test(value)) return problem;
  return null;
}

/**
 * Check a weekly review item by item.
 * A change must cite evidence it was shown that is about that taste (or the
 * candidate a new taste in the same review comes from). An addition comes
 * from a candidate artist (citing its rows) or promotes a repeated chat
 * opinion, uses a category he already has, and must not cover a subject an
 * active taste owns. Locked tastes never change. Failures are dropped and
 * reported, never applied; one bad item does not sink the rest.
 */
export function validateAutomaticReview(
  input: SelfModelReviewInput,
  proposal: SelfModelReviewProposal,
): {
  readonly changes: readonly SelfModelReviewChange[];
  readonly additions: readonly SelfModelReviewAddition[];
  readonly rejections: readonly SelfModelReviewRejection[];
} {
  const rejections: SelfModelReviewRejection[] = [];
  const reject = (item: string, reason: string) => { rejections.push({ item: truncateText(item, 60), reason }); };
  const evidence = new Map(input.evidence.map((row) => [row.id, row]));
  const preferences = new Map(input.preferences.map((preference) => [preference.id, preference]));
  const categories = new Set(input.preferences.map((preference) => preference.category));
  const opinions = new Map(input.opinions.map((opinion) => [opinion.id, opinion]));
  const citedIds = (ids: readonly number[] | undefined) => [...new Set(ids ?? [])];
  // Code speaks a stance to anyone, guests included, so it never names the people behind the evidence.
  const people = new Set([...input.evidence, ...input.opinions]
    .map((row) => normalize(row.actorId.split(/[.:]/).at(-1) ?? ""))
    .filter((name) => name.length >= 3));
  const problem = (text: string, already = "") => {
    const words = new Set(normalize(text).split(" "));
    const allowed = new Set(normalize(already).split(" ")); // a seeded stance may name the family on purpose
    if ([...people].some((name) => words.has(name) && !allowed.has(name))) return "names a household member";
    return tasteHonestyProblem(text);
  };

  // Additions first: a change may rest on the candidate a new taste comes from.
  const additions: SelfModelReviewAddition[] = [];
  const activeTastes = input.preferences.filter((preference) => preference.status === "active");
  let activeCount = activeTastes.length;
  const usedOpinions = new Set<string>();
  for (const raw of proposal.additions ?? []) {
    const label = typeof raw.subject === "string" ? raw.subject : "new taste";
    try {
      const addition: SelfModelReviewAddition = {
        category: boundedString(raw.category, "category", 80).toLowerCase(),
        subject: boundedString(raw.subject, "subject", 160),
        stance: boundedString(raw.stance, "stance", 500),
        strength: unitNumber(raw.strength, "strength"),
        confidence: Math.min(unitNumber(raw.confidence, "confidence"), SELF_REVIEW_LIMITS.additionMaxConfidence),
        rationale: boundedString(raw.rationale, "rationale", 1000),
        reason: boundedString(raw.reason, "reason", 500),
        evidenceIds: citedIds(raw.evidenceIds),
        fromOpinionId: raw.fromOpinionId ? boundedString(raw.fromOpinionId, "fromOpinionId", 100) : null,
      };
      if (!categories.has(addition.category)) { reject(label, `unknown category ${addition.category}`); continue; }
      const dishonest = problem(`${addition.stance} ${addition.rationale}`);
      if (dishonest) { reject(label, dishonest); continue; }
      if (addition.evidenceIds.some((id) => !evidence.has(id))) { reject(label, "cites evidence it was not shown"); continue; }
      const owner = tasteOwningSubject([...activeTastes, ...additions.map(provisionalPreference)], addition.subject);
      if (owner) { reject(label, `${owner.id} already owns this subject`); continue; }
      if (addition.fromOpinionId) {
        const opinion = opinions.get(addition.fromOpinionId);
        if (!opinion) { reject(label, "promotes an unknown chat opinion"); continue; }
        if (!opinion.promotable) { reject(label, "chat opinion said only once"); continue; }
        if (usedOpinions.has(opinion.id)) { reject(label, "chat opinion already promoted"); continue; }
        if (!addition.evidenceIds.every((id) => candidateRowFor(input, id, addition.subject))) {
          reject(label, "cites evidence about something else"); continue;
        }
        usedOpinions.add(opinion.id);
      } else {
        if (addition.evidenceIds.length === 0) { reject(label, "no evidence"); continue; }
        if (!addition.evidenceIds.every((id) => candidateRowFor(input, id, addition.subject))) {
          reject(label, "evidence is not this candidate's plays"); continue;
        }
      }
      if (activeCount >= SELF_MODEL_MAX_PREFERENCE_COUNT) { reject(label, `cap of ${SELF_MODEL_MAX_PREFERENCE_COUNT} tastes`); continue; }
      activeCount += 1;
      additions.push(addition);
    } catch (error) {
      reject(label, error instanceof Error ? error.message : "malformed");
    }
  }
  const additionEvidence = new Set(additions.flatMap((addition) => addition.evidenceIds));

  const changes: SelfModelReviewChange[] = [];
  const seen = new Set<string>();
  for (const raw of proposal.changes) {
    const current = typeof raw.id === "string" ? preferences.get(raw.id) : undefined;
    const label = current?.subject ?? String(raw.id);
    if (!current) { reject(label, "unknown taste"); continue; }
    if (seen.has(current.id)) { reject(label, "changed twice"); continue; }
    if (current.locked) { reject(label, "locked"); continue; }
    try {
      const change: SelfModelReviewChange = {
        id: current.id,
        stance: boundedString(raw.stance, "stance", 500),
        strength: unitNumber(raw.strength, "strength"),
        confidence: unitNumber(raw.confidence, "confidence"),
        rationale: boundedString(raw.rationale, "rationale", 1000),
        status: preferenceStatus(raw.status),
        reason: boundedString(raw.reason, "reason", 500),
        evidenceIds: citedIds(raw.evidenceIds),
      };
      const ids = change.evidenceIds ?? [];
      if (ids.length === 0) { reject(label, "no evidence"); continue; }
      if (ids.some((id) => !evidence.has(id))) { reject(label, "cites evidence it was not shown"); continue; }
      if (!ids.some((id) => evidence.get(id)?.preferenceId === current.id || additionEvidence.has(id))) {
        reject(label, "evidence is about something else"); continue;
      }
      if (change.status === "active" && current.status === "retired" && activeCount >= SELF_MODEL_MAX_PREFERENCE_COUNT) {
        reject(label, `cap of ${SELF_MODEL_MAX_PREFERENCE_COUNT} tastes`); continue;
      }
      if (change.stance !== current.stance || change.rationale !== current.rationale) {
        const dishonest = problem(`${change.stance} ${change.rationale}`, `${current.stance} ${current.rationale}`);
        if (dishonest) { reject(label, dishonest); continue; }
      }
      if (change.status !== current.status) activeCount += change.status === "active" ? 1 : -1;
      seen.add(current.id);
      changes.push(change);
    } catch (error) {
      reject(label, error instanceof Error ? error.message : "malformed");
    }
  }
  return { changes, additions, rejections };
}

/** The evidence row is a play of the candidate artist this new taste is about. */
function candidateRowFor(input: SelfModelReviewInput, evidenceId: number, subject: string): boolean {
  const key = tasteMatchKey(subject);
  return input.candidates.some((candidate) => {
    if (!candidate.evidenceIds.includes(evidenceId)) return false;
    const artist = tasteMatchKey(candidate.subject);
    return artist === key || key.startsWith(`${artist} `) || artist.startsWith(`${key} `);
  });
}

function provisionalPreference(addition: SelfModelReviewAddition, index: number): SelfPreference {
  return {
    id: `pending-addition-${index}`,
    category: addition.category,
    subject: addition.subject,
    stance: addition.stance,
    strength: addition.strength,
    confidence: addition.confidence,
    rationale: addition.rationale,
    provenance: { kind: "model_decided", note: "pending", sourceUrls: [] },
    locked: false,
    status: "active",
    revision: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastReviewedAt: null,
  };
}

function parseOpinionRow(row: OpinionRow): ConversationOpinion {
  return {
    id: row.opinion_id,
    category: row.category,
    subject: row.subject,
    stance: row.stance,
    strength: row.strength,
    confidence: row.confidence,
    actorId: row.actor_id,
    revision: row.revision,
    createdAt: requiredIso(row.created_at, "opinion created_at"),
    updatedAt: requiredIso(row.updated_at, "opinion updated_at"),
  };
}

function parseEvidenceRow(row: EvidenceRow): TasteEvidence {
  if (!(TASTE_EVIDENCE_KINDS as readonly string[]).includes(row.kind)) throw new Error("taste evidence kind is invalid");
  return {
    id: row.evidence_id,
    preferenceId: row.preference_id,
    subject: row.subject,
    kind: row.kind as TasteEvidenceKind,
    day: row.day,
    actorId: row.actor_id,
    summary: row.summary,
    createdAt: requiredIso(row.created_at, "taste evidence created_at"),
    nudgedAt: row.nudged_at === null ? null : requiredIso(row.nudged_at, "taste evidence nudged_at"),
  };
}

/** The household's calendar day, so "one row a day" means a Sydney day. */
function localDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TASTE_EVIDENCE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function roundStep(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

function opinionAsPreference(opinion: ConversationOpinion): SelfPreference {
  return {
    id: opinion.id,
    category: opinion.category,
    subject: opinion.subject,
    stance: opinion.stance,
    strength: opinion.strength,
    confidence: opinion.confidence,
    rationale: `${assistantName()} said this in an earlier conversation.`,
    provenance: { kind: "model_decided", note: "conversation_formed", sourceUrls: [] },
    locked: false,
    status: "active",
    revision: opinion.revision,
    createdAt: opinion.createdAt,
    updatedAt: opinion.updatedAt,
    lastReviewedAt: null,
  };
}

function parseReviewRow(row: ReviewRow): SelfModelReviewSummary {
  if (row.source !== "automatic" && row.source !== "operator") throw new Error("self model review source is invalid");
  if (row.status !== "ok" && row.status !== "error") throw new Error("self model review status is invalid");
  return {
    reviewId: row.review_id,
    timestamp: requiredIso(row.reviewed_at, "self model reviewed_at"),
    source: row.source,
    status: row.status,
    summary: row.summary,
    changeCount: row.change_count,
  };
}

function preferenceMatchScore(
  preference: SelfPreference,
  query: string,
  categoryHints: ReadonlySet<string>,
): number {
  const tokens = meaningfulTokens(query);
  const searchable = normalize(`${preference.category} ${preference.subject} ${preference.stance}`);
  const searchableTokens = new Set(meaningfulTokens(searchable));
  let score = categoryHints.has(normalize(preference.category)) ? 8 : 0;
  for (const token of tokens) if (searchableTokens.has(token)) score += 3;
  if (query.includes(normalize(preference.subject))) score += 12;
  // "Favourite book?" wants the one he calls his favourite, not any stance
  // that happens to say "book"; "least favourite" only answers "least".
  if (/\bfavou?rite\b/.test(query)) {
    const asksLeast = /\bleast favou?rite\b/.test(query);
    const stance = normalize(preference.stance);
    const declaresLeast = /\bleast favou?rite\b/.test(stance);
    if (/\bfavou?rite\b/.test(stance) && declaresLeast === asksLeast) score += 6;
  }
  return score;
}

function categoriesForPrompt(query: string): ReadonlySet<string> {
  const categories = new Set<string>();
  const hints: readonly [RegExp, string][] = [
    [/\b(?:book|books|author|writer|novel|literature|poem|poet|read|reading)\b/, "literature"],
    [/\b(?:film|films|movie|movies|cinema|watch|watching)\b/, "film"],
    [/\b(?:tv|television|show|shows|series|watch|watching)\b/, "television"],
    [/\b(?:music|song|songs|album|singer|band|composer|musician|listen|listening)\b/, "music"],
    [/\b(?:art|painting|painter|sculpture)\b/, "art"],
    [/\b(?:comedy|comedian|joke|humour|humor)\b/, "comedy"],
    [/\b(?:food|meal|dish|cuisine|eat)\b/, "food"],
    [/\b(?:drink|whisky|whiskey|wine|coffee|tea)\b/, "drink"],
    [/\b(?:place|city|country|travel|destination)\b/, "place"],
    [/\b(?:colour|color|design|style|architecture|clothes|clothing)\b/, "aesthetics"],
    [/\b(?:value|principle|politics|religion|freedom|speech|science)\b/, "values"],
    [/\b(?:hobby|leisure|relax|pastime)\b/, "leisure"],
    [/\b(?:technology|tech|computer|software|gadget|device)\b/, "technology"],
    [/\b(?:animal|animals|bird|birds|pet|pets|creature)\b/, "animals"],
    [/\b(?:footy|football|afl|team|sport|sports|barrack|barracks)\b/, "sport"],
    [/\b(?:word|words|phrase|saying|motto|slang|names)\b/, "words"],
    [/\b(?:season|weather|weekday|room|chore|appliance|sunday|morning|evening)\b/, "everyday"],
    [/\b(?:bird|tree|plant|landscape|beach|bush|mountains?|star|constellation|spider|insect)\b/, "nature"],
    [/\b(?:hate|dislike|dislikes|annoy|annoys|annoying|peeve|peeves)\b/, "dislikes"],
    [/\b(?:habit|habits|quirk|quirks|superstition|superstitious)\b/, "quirks"],
    [/\b(?:admire|hero|heroes|comedian|guest|guests)\b/, "people"],
    [/\b(?:conversation|conversations)\b/, "conversation"],
  ];
  for (const [pattern, category] of hints) if (pattern.test(query)) categories.add(category);
  return categories;
}

function meaningfulTokens(value: string): readonly string[] {
  const ignored = new Set(["what", "which", "who", "your", "you", "would", "could", "the", "and", "for", "are", "does", "about", "with", "favourite", "favorite", "prefer", "preferred", "like", "love", "most", "least", "best", "worst", "thing"]);
  return normalize(value).split(/\s+/).filter((token) => token.length > 2 && !ignored.has(token));
}

/** Same taste, whatever the lock says. */
function sameTaste(left: SelfPreference, right: SelfPreference): boolean {
  return left.stance === right.stance
    && left.strength === right.strength
    && left.confidence === right.confidence
    && left.rationale === right.rationale
    && left.status === right.status;
}

function sameMutablePreference(left: SelfPreference, right: SelfPreference): boolean {
  return left.stance === right.stance
    && left.strength === right.strength
    && left.confidence === right.confidence
    && left.rationale === right.rationale
    && left.status === right.status
    && left.locked === right.locked;
}

function reviewStatus(value: string | null): SelfModelStatus["reviewStatus"] {
  if (value === "seeded" || value === "ok" || value === "error") return value;
  throw new Error("self model review_status is invalid");
}

function preferenceStatus(value: unknown): SelfPreferenceStatus {
  if (value === "active" || value === "retired") return value;
  throw new Error("self preference status is unsupported");
}

function identifier(value: unknown, label: string): string {
  const text = boundedString(value, label, 100);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function requiredIso(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
  return value;
}
