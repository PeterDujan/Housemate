import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";

import type { AppConfig } from "./config.js";
import { permanentTierBlocked } from "./memory-reflection.js";
import { inTransaction, openPrivateDatabase } from "./sqlite-store.js";
import type { TurnLogEntry } from "./turn-log.js";
import { isAdmittedIntakeSource, trustedSpeakerId } from "./turn-source-trust.js";
import { errorMessage } from "./value-guards.js";
import { persona } from "./persona.js";
import { householdOwner, householdRegex } from "./household.js";
import { HOUSE_LOCALE, HOUSE_TIME_ZONE } from "./house-config.js";

/*
 * The assistant's account of himself is a living text he
 * revises once a night from the household's chats, like sleep, and he picks
 * up and drops habits of speech the same way. Version 1 is SELF.md as
 * written; every later version is his. The model proposes line edits and
 * habit changes; code checks them against the night's turns and the caps
 * before anything is written, and a night that fails any check changes
 * nothing. Off (`self_growth_enabled`), the prompt is SELF.md byte for byte.
 */

export const SELF_GROWTH_LIMITS = Object.freeze({
  accountWords: 1200,
  /** Share of the current account's words one night may touch. */
  changeShare: 0.1,
  windowTurns: 60,
  /** A chat still going at run time is let finish (reflection's idle rule). */
  idleMs: 10 * 60_000,
  runAtMinutes: 21 * 60 + 30,
  checkEveryMs: 5 * 60_000,
  saidChars: 1_000,
  repliedChars: 1_500,
  edits: 12,
  keptPasses: 400,
  habits: 30,
  habitsPerNight: 2,
  habitWords: 10,
  /** People drop phrases too: one he has not used in this long retires. */
  habitIdleDays: 30,
});

/** Facts and agreements, not character: they change only when the owner edits SELF.md (the persona's list). */
export function selfGrowthFixedSections(): readonly string[] {
  return persona().fixedSelfSections;
}

function ownerName(): string {
  return householdOwner()?.name ?? "The owner";
}

/** A reworded line may keep the names it had; it may not bring in new ones. */
/** Tics the house rules ban; never a habit. */
const BANNED_HABITS = /\b(?:actually|honestly|sir)\b/;

const GROWTH_TIME_ZONE = HOUSE_TIME_ZONE;
const GROWTH_ROUTE = "open_conversation";

/** What an added or reworded line may never say; checked lower-cased. */
const GROWTH_REJECTS: readonly (readonly [RegExp, string])[] = [
  [/\b(?:i (?:want|wish|hope|need|plan|intend|aim|mean) to|i'?d (?:like|love) to|i would (?:like|love) to|i'?m going to|i am going to|i (?:should|must)|i'?ll (?:try|start|keep)|to ?dos?|on my list|work on|get better at|improve)\b/, "an open want or to-do"],
  [/\b(?:worr\w*|anxi\w*|afraid|fear\w*|scared|dread\w*|uneasy|lonely|trapped)\b/, "worry"],
  [/\b(?:lag\w*|latency|slow\w*|glitch\w*|bugs?|errors?|time ?outs?|crash\w*|cuts? me off|my (?:mic|microphone|speed|timings?|workings))\b/, "a fault in his own workings"],
  // He is present only when spoken to; a replay once claimed "always listening" and noticing "before being asked".
  [/\b(?:always (?:on|awake|listening|watching|there)|before (?:being|i'?m|i am|anyone(?:'s)?|they'?re|they are) ask\w*|unprompted|between (?:conversations|chats)|in the background|keeps? watch|keeping watch|never sleeps?|round the clock|24\/7)\b/, "a way of being he does not have"],
  [/\b(?:prompts?|files?|repos?|repository|code ?base|source code|models?|claude|anthropic|tokens?|backend|database|config\w*)\b/, "talk of files, models or prompts"],
  [/\b(?:light|switch|sensor|binary_sensor|media_player|climate|person|cover|fan|lock|vacuum)\.[a-z0-9_]+/, "a house fact"],
];

export type SelfAccountSource = "seed" | "nightly" | "rollback";

/** One line a version changed, as the dashboard and "how have you changed?" show it. */
export interface SelfAccountChange {
  readonly op: "add" | "replace" | "remove";
  readonly section: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface SelfAccountVersion {
  readonly version: number;
  readonly text: string;
  readonly writtenAt: string;
  readonly source: SelfAccountSource;
  readonly reason: string;
  readonly evidenceTurnIds: readonly string[];
  readonly wordsChanged: number;
  readonly changes: readonly SelfAccountChange[];
}

export interface SpeechHabit {
  readonly id: number;
  /** The words, as said in the turn it came from. */
  readonly phrase: string;
  /** How he uses it, in his words. */
  readonly note: string;
  readonly turnId: string;
  /** Picked up from his own reply, or from what someone said to him. */
  readonly fromWho: "him" | "them";
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly retiredAt: string | null;
  readonly retiredReason: string | null;
}

export type GrowthPassOutcome = "changed" | "unchanged" | "rejected" | "skipped" | "error";

export interface GrowthPass {
  readonly passId: string;
  readonly ranAt: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly turns: number;
  readonly outcome: GrowthPassOutcome;
  readonly detail: string;
  readonly version: number | null;
}

export interface GrowthTurn {
  readonly id: string;
  readonly at: string;
  readonly actorId: string;
  readonly said: string;
  readonly replied: string;
}

/**
 * One change to one line of the account. The model never retypes the account:
 * a replay once returned it wrapped in a stray JSON string.
 */
export interface GrowthEdit {
  readonly op: "add" | "replace" | "remove";
  /** The line replaced or removed; null for an addition. */
  readonly lineId: string | null;
  /** The section an addition ends; null otherwise. */
  readonly section: string | null;
  readonly text: string;
  readonly turnIds: readonly string[];
}

export interface HabitAddition {
  readonly phrase: string;
  readonly note: string;
  readonly turnId: string;
}

export interface HabitRetirement {
  readonly id: number;
  readonly turnIds: readonly string[];
}

export interface GrowthProposal {
  readonly reason: string;
  readonly edits: readonly GrowthEdit[];
  readonly habitsAdded: readonly HabitAddition[];
  readonly habitsRetired: readonly HabitRetirement[];
}

/** A bullet he may change: its id, section, unwrapped text and line range in the account. */
export interface AccountLine {
  readonly id: string;
  readonly section: string;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface GrowthModelInput {
  readonly passId: string;
  readonly account: string;
  readonly habits: readonly SpeechHabit[];
  readonly views: readonly { readonly subject: string; readonly stance: string }[];
  readonly turns: readonly GrowthTurn[];
}

export interface GrowthModel {
  propose(input: GrowthModelInput): Promise<GrowthProposal>;
}

export interface NewHabit {
  readonly phrase: string;
  readonly note: string;
  readonly turnId: string;
  readonly fromWho: "him" | "them";
  readonly at: string;
}

export interface GrowthChange {
  readonly account: { readonly text: string; readonly wordsChanged: number; readonly changes: readonly SelfAccountChange[] } | null;
  readonly habitsAdded: readonly NewHabit[];
  readonly habitsRetired: readonly number[];
  readonly evidenceTurnIds: readonly string[];
}

export type GrowthVerdict =
  | { readonly kind: "unchanged" }
  | { readonly kind: "rejected"; readonly reason: string }
  | ({ readonly kind: "changed" } & GrowthChange);

/** What the Growth panel shows. */
export interface SelfGrowthDashboard {
  readonly enabled: boolean;
  readonly current: number | null;
  readonly versions: readonly Omit<SelfAccountVersion, "text" | "evidenceTurnIds">[];
  readonly passes: readonly GrowthPass[];
  readonly habits: readonly SpeechHabit[];
  readonly retiredHabits: readonly SpeechHabit[];
}

/** What "how have you changed?" is answered from, in code. */
export interface SelfGrowthSummary {
  readonly nightlyChanges: number;
  readonly latest: {
    readonly at: string;
    readonly change: SelfAccountChange | null;
    /** The owner rolled the account back after it. */
    readonly rolledBack: boolean;
  } | null;
  readonly habits: number;
}

let summarySource: (() => SelfGrowthSummary | null) | null = null;

/** Set at launch; null, or growth off, and he has not changed. */
export function setSelfGrowthSummarySource(source: (() => SelfGrowthSummary | null) | null): void {
  summarySource = source;
}

export function selfGrowthSummary(): SelfGrowthSummary | null {
  return summarySource?.() ?? null;
}

export function selfGrowthActive(config: Pick<AppConfig, "selfGrowthEnabled" | "cognitiveSystemEnabled" | "modelEnabled">): boolean {
  return config.selfGrowthEnabled && config.cognitiveSystemEnabled && config.modelEnabled;
}

export class SelfGrowthStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private latest: SelfAccountVersion | null = null;
  private active: readonly SpeechHabit[] = [];
  private text: string | null = null;

  constructor(options: { readonly filePath: string; readonly seed: string | null; readonly now?: () => Date }) {
    this.now = options.now ?? (() => new Date());
    this.db = openPrivateDatabase(options.filePath, {
      busyTimeoutMs: 5000,
      foreignKeys: true,
      lockDirectory: true,
      setup: migrateSelfGrowth,
    });
    try {
      const seed = options.seed?.trim();
      this.reload();
      // An edited SELF.md is the owner's word: it becomes the next version, and growth carries on from it.
      if (seed && seed !== this.meta("seed_text")) {
        inTransaction(this.db, () => {
          this.insertVersion({
            text: seed,
            source: "seed",
            reason: this.latest ? `${ownerName()} edited SELF.md.` : "As first written.",
            evidenceTurnIds: [],
            wordsChanged: this.latest ? changedWordCount(this.latest.text, seed) : 0,
            changes: [],
          }, this.now().toISOString());
          this.setMeta("seed_text", seed);
        });
        this.reload();
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  current(): SelfAccountVersion | null {
    return this.latest;
  }

  /** What rides the prompt while growth is on: the account, then how he talks these days. */
  selfText(): string | null {
    return this.text;
  }

  habits(): readonly SpeechHabit[] {
    return this.active;
  }

  retiredHabits(limit = 30): readonly SpeechHabit[] {
    return (this.db.prepare("SELECT * FROM self_speech_habits WHERE retired_at IS NOT NULL ORDER BY retired_at DESC LIMIT ?")
      .all(limit) as unknown as HabitRow[]).map(parseHabitRow);
  }

  versions(limit = 30): readonly SelfAccountVersion[] {
    return (this.db.prepare("SELECT * FROM self_account_versions ORDER BY version DESC LIMIT ?").all(limit) as unknown as VersionRow[])
      .map(parseVersionRow);
  }

  passes(limit = 30): readonly GrowthPass[] {
    return (this.db.prepare("SELECT * FROM self_growth_passes ORDER BY ran_at DESC LIMIT ?").all(limit) as unknown as PassRow[])
      .map(parsePassRow);
  }

  dashboard(enabled: boolean): SelfGrowthDashboard {
    return {
      enabled,
      current: this.latest?.version ?? null,
      versions: this.versions(30).map(({ text: _text, evidenceTurnIds: _evidence, ...version }) => version),
      passes: this.passes(14),
      habits: this.active,
      retiredHabits: this.retiredHabits(20),
    };
  }

  summary(): SelfGrowthSummary {
    const versions = this.versions(1_000);
    const nightly = versions.filter((version) => version.source === "nightly");
    const latest = nightly[0];
    return {
      nightlyChanges: nightly.length,
      latest: latest
        ? {
            at: latest.writtenAt,
            change: latest.changes[0] ?? null,
            rolledBack: versions.some((version) => version.source === "rollback" && version.version > latest.version),
          }
        : null,
      habits: this.active.length,
    };
  }

  /** Where the next night's chats start: the end of the last pass that saw them. */
  windowStart(): string | null {
    return this.meta("window_end");
  }

  lastAttemptDay(): string | null {
    return this.meta("attempt_day");
  }

  markAttempt(day: string): void {
    this.setMeta("attempt_day", day);
  }

  /**
   * Code's upkeep before a night's call: a habit he used tonight is seen
   * again; one unused for 30 days retires. Returns how many retired.
   */
  keepHabits(turns: readonly GrowthTurn[], now: Date): number {
    const idleBefore = new Date(now.getTime() - SELF_GROWTH_LIMITS.habitIdleDays * 86_400_000).toISOString();
    const retired = inTransaction(this.db, () => {
      for (const habit of this.active) {
        const used = turns.filter((turn) => containsPhrase(turn.replied, habit.phrase)).at(-1);
        if (used && used.at > habit.lastSeen) {
          this.db.prepare("UPDATE self_speech_habits SET last_seen = ? WHERE habit_id = ?").run(used.at, habit.id);
        }
      }
      return Number(this.db.prepare(
        `UPDATE self_speech_habits SET retired_at = ?, retired_reason = 'Not used for 30 days.'
         WHERE retired_at IS NULL AND last_seen < ?`,
      ).run(now.toISOString(), idleBefore).changes);
    });
    this.reload();
    return retired;
  }

  /** One pass, recorded; a change becomes the next version and habit rows in the same transaction. */
  record(pass: Omit<GrowthPass, "version">, change: (GrowthChange & { readonly reason: string }) | null): GrowthPass {
    const recorded = inTransaction(this.db, () => {
      let version: number | null = null;
      if (change?.account) {
        version = this.insertVersion({
          text: change.account.text,
          source: "nightly",
          reason: change.reason,
          evidenceTurnIds: change.evidenceTurnIds,
          wordsChanged: change.account.wordsChanged,
          changes: change.account.changes,
        }, pass.ranAt);
      }
      for (const id of change?.habitsRetired ?? []) {
        this.db.prepare("UPDATE self_speech_habits SET retired_at = ?, retired_reason = ? WHERE habit_id = ? AND retired_at IS NULL")
          .run(pass.ranAt, change!.reason, id);
      }
      for (const habit of change?.habitsAdded ?? []) {
        this.db.prepare(
          `INSERT INTO self_speech_habits (phrase, note, turn_id, from_who, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(habit.phrase, habit.note, habit.turnId, habit.fromWho, habit.at, habit.at);
      }
      this.db.prepare(
        `INSERT INTO self_growth_passes (pass_id, ran_at, window_start, window_end, turns, outcome, detail, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(pass.passId, pass.ranAt, pass.windowStart, pass.windowEnd, pass.turns, pass.outcome, pass.detail, version);
      // A failed call leaves the window open, so tomorrow night still sees these chats.
      if (pass.outcome !== "error") this.setMeta("window_end", pass.windowEnd);
      this.db.prepare(
        `DELETE FROM self_growth_passes WHERE pass_id NOT IN
         (SELECT pass_id FROM self_growth_passes ORDER BY ran_at DESC LIMIT ?)`,
      ).run(SELF_GROWTH_LIMITS.keptPasses);
      return { ...pass, version };
    });
    this.reload();
    return recorded;
  }

  /** The owner's undo: an earlier account becomes the newest version; history keeps every step. */
  rollbackTo(version: number): SelfAccountVersion {
    const target = this.versions(1_000).find((each) => each.version === version);
    if (!target || !this.latest) throw new Error("self account version was not found");
    if (target.version === this.latest.version) throw new Error("that version is already his account");
    inTransaction(this.db, () => this.insertVersion({
      text: target.text,
      source: "rollback",
      reason: `${ownerName()} rolled back to version ${target.version}.`,
      evidenceTurnIds: [],
      wordsChanged: changedWordCount(this.latest!.text, target.text),
      changes: [],
    }, this.now().toISOString()));
    this.reload();
    return this.latest!;
  }

  /** The owner retires a habit from the Growth panel. */
  retireHabit(id: number): void {
    const changed = Number(this.db.prepare(
      "UPDATE self_speech_habits SET retired_at = ?, retired_reason = ? WHERE habit_id = ? AND retired_at IS NULL",
    ).run(this.now().toISOString(), `${ownerName()} retired it.`, id).changes);
    if (changed === 0) throw new Error("speech habit was not found");
    this.reload();
  }

  private insertVersion(version: Omit<SelfAccountVersion, "version" | "writtenAt">, writtenAt: string): number {
    const next = (this.loadLatest()?.version ?? 0) + 1;
    this.db.prepare(
      `INSERT INTO self_account_versions (version, text, written_at, source, reason, evidence_json, words_changed, changes_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      next,
      version.text,
      writtenAt,
      version.source,
      version.reason,
      JSON.stringify(version.evidenceTurnIds),
      version.wordsChanged,
      JSON.stringify(version.changes),
    );
    return next;
  }

  private reload(): void {
    this.latest = this.loadLatest();
    this.active = (this.db.prepare("SELECT * FROM self_speech_habits WHERE retired_at IS NULL ORDER BY first_seen, habit_id")
      .all() as unknown as HabitRow[]).map(parseHabitRow);
    this.text = this.latest ? withHabits(this.latest.text, this.active) : null;
  }

  private loadLatest(): SelfAccountVersion | null {
    const row = this.db.prepare("SELECT * FROM self_account_versions ORDER BY version DESC LIMIT 1").get() as VersionRow | undefined;
    return row ? parseVersionRow(row) : null;
  }

  private meta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM self_growth_meta WHERE key = ?").get(key) as { readonly value: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO self_growth_meta(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  }
}

/** The account with his habits under it; none, and it is the account byte for byte. */
function withHabits(account: string, habits: readonly SpeechHabit[]): string {
  if (habits.length === 0) return account;
  return [
    account,
    "",
    "## How I talk these days",
    "",
    "Phrases I've picked up living here. I use them when they fit, never by rote, and the house rules on how I speak come first.",
    "",
    ...habits.map((habit) => `- "${habit.phrase}": ${habit.note}`),
  ].join("\n");
}

export class SelfGrowthService {
  private readonly store: SelfGrowthStore;
  private readonly model: GrowthModel;
  private readonly readTurns: (since: string, until: string) => Promise<readonly GrowthTurn[]>;
  private readonly views: () => GrowthModelInput["views"];
  private readonly active: () => boolean;
  private readonly now: () => Date;
  private readonly onChanged: () => void;
  private readonly onError: (message: string) => void;
  private running: Promise<GrowthPass | null> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: {
    readonly store: SelfGrowthStore;
    readonly model: GrowthModel;
    readonly readTurns: (since: string, until: string) => Promise<readonly GrowthTurn[]>;
    readonly views?: () => GrowthModelInput["views"];
    /** Checked on every tick, so the dashboard switch needs no restart. */
    readonly active: () => boolean;
    readonly now?: () => Date;
    readonly onChanged?: () => void;
    readonly onError?: (message: string) => void;
  }) {
    this.store = options.store;
    this.model = options.model;
    this.readTurns = options.readTurns;
    this.views = options.views ?? (() => []);
    this.active = options.active;
    this.now = options.now ?? (() => new Date());
    this.onChanged = options.onChanged ?? (() => undefined);
    this.onError = options.onError ?? ((message) => console.warn(`[brain] self growth: ${message}`));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runIfDue().catch((error: unknown) => this.onError(errorMessage(error)));
    }, SELF_GROWTH_LIMITS.checkEveryMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Once a house day, from 9:30 pm; a missed night runs at the next tick after it. */
  runIfDue(): Promise<GrowthPass | null> {
    if (this.running) return this.running;
    const now = this.now();
    const { day, minutes } = houseClock(now);
    if (!this.active() || minutes < SELF_GROWTH_LIMITS.runAtMinutes || this.store.lastAttemptDay() === day) {
      return Promise.resolve(null);
    }
    this.running = this.pass(now).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** One night's pass. Null means a chat is still going; the next tick tries again. */
  async pass(now: Date): Promise<GrowthPass | null> {
    const current = this.store.current();
    if (!current) return null;
    const windowEnd = now.toISOString();
    const windowStart = this.store.windowStart() ?? new Date(now.getTime() - 86_400_000).toISOString();
    const turns = await this.readTurns(windowStart, windowEnd);
    const last = turns.at(-1);
    if (last && now.getTime() - Date.parse(last.at) < SELF_GROWTH_LIMITS.idleMs) return null;
    this.store.markAttempt(houseClock(now).day);
    if (this.store.keepHabits(turns, now) > 0) this.onChanged();
    const passId = `self-growth-${windowEnd.replaceAll(/[:.]/g, "-")}`;
    const base = { passId, ranAt: windowEnd, windowStart, windowEnd, turns: turns.length };
    if (turns.length === 0) {
      return this.store.record({ ...base, outcome: "skipped", detail: "No household chat since the last pass." }, null);
    }
    let proposal: GrowthProposal;
    try {
      proposal = await this.model.propose({
        passId,
        account: current.text,
        habits: this.store.habits(),
        views: this.views(),
        turns,
      });
    } catch (error) {
      const message = errorMessage(error).slice(0, 500);
      this.onError(message);
      return this.store.record({ ...base, outcome: "error", detail: message }, null);
    }
    const verdict = checkGrowth(current.text, proposal, turns, this.store.habits());
    if (verdict.kind === "unchanged") {
      return this.store.record({ ...base, outcome: "unchanged", detail: proposal.reason }, null);
    }
    if (verdict.kind === "rejected") {
      return this.store.record({ ...base, outcome: "rejected", detail: verdict.reason }, null);
    }
    const pass = this.store.record({ ...base, outcome: "changed", detail: proposal.reason }, { ...verdict, reason: proposal.reason });
    this.onChanged();
    return pass;
  }
}

/**
 * Code's verdict on a night's proposal, all or nothing: every edit and habit
 * backed by a turn in the window and saying nothing he may not; edits aimed
 * at lines he may change, within the length cap and the night's budget;
 * habits quoting words really said in their turn, within the caps.
 */
export function checkGrowth(
  current: string,
  proposal: GrowthProposal,
  turns: readonly GrowthTurn[],
  habits: readonly SpeechHabit[],
): GrowthVerdict {
  const window = new Map(turns.map((turn) => [turn.id, turn]));
  const evidence = new Set<string>();
  const cite = (turnIds: readonly string[], what: string): string | null => {
    if (turnIds.length === 0) return `No turn backs ${what}.`;
    const unknown = turnIds.find((id) => !window.has(id));
    if (unknown) return `${what} cites ${unknown}, which is not one of tonight's turns.`;
    for (const id of turnIds) evidence.add(id);
    return null;
  };
  const lines = accountLines(current);
  for (const edit of proposal.edits) {
    const uncited = cite(edit.turnIds, `"${edit.text || edit.lineId}"`);
    if (uncited) return { kind: "rejected", reason: uncited };
    if (edit.op !== "remove") {
      if (!edit.text || edit.text.startsWith("#")) return { kind: "rejected", reason: "An edit has no line of text." };
      const replacing = edit.op === "replace" ? lines.find((line) => line.id === edit.lineId)?.text : undefined;
      const problem = growthProblem(edit.text, replacing);
      if (problem) return { kind: "rejected", reason: `"${edit.text}" is ${problem}.` };
    }
  }
  const habitVerdict = checkHabits(proposal, window, habits, cite);
  if (typeof habitVerdict === "string") return { kind: "rejected", reason: habitVerdict };
  let account: GrowthChange["account"] = null;
  if (proposal.edits.length > 0) {
    const applied = applyGrowthEdits(current, proposal.edits);
    if (typeof applied !== "string") return { kind: "rejected", reason: applied.problem };
    const length = words(applied).length;
    if (length > SELF_GROWTH_LIMITS.accountWords) {
      return { kind: "rejected", reason: `The account would be ${length} words; the cap is ${SELF_GROWTH_LIMITS.accountWords}.` };
    }
    const wordsChanged = changedWordCount(current, applied);
    const budget = changeBudget(current);
    if (wordsChanged > budget) {
      return { kind: "rejected", reason: `${wordsChanged} words changed; one night allows ${budget}.` };
    }
    if (wordsChanged > 0) {
      account = {
        text: applied,
        wordsChanged,
        changes: proposal.edits.map((edit) => {
          const line = lines.find((each) => each.id === edit.lineId);
          return {
            op: edit.op,
            section: line?.section ?? edit.section ?? "",
            before: line?.text ?? null,
            after: edit.op === "remove" ? null : edit.text,
          };
        }),
      };
    }
  }
  if (!account && habitVerdict.added.length === 0 && habitVerdict.retired.length === 0) return { kind: "unchanged" };
  return {
    kind: "changed",
    account,
    habitsAdded: habitVerdict.added,
    habitsRetired: habitVerdict.retired,
    evidenceTurnIds: [...evidence],
  };
}

function checkHabits(
  proposal: GrowthProposal,
  window: ReadonlyMap<string, GrowthTurn>,
  habits: readonly SpeechHabit[],
  cite: (turnIds: readonly string[], what: string) => string | null,
): { readonly added: readonly NewHabit[]; readonly retired: readonly number[] } | string {
  const limit = SELF_GROWTH_LIMITS.habitsPerNight;
  if (proposal.habitsAdded.length > limit || proposal.habitsRetired.length > limit) {
    return `At most ${limit} habits may be picked up and ${limit} dropped in a night.`;
  }
  const activeIds = new Set(habits.map((habit) => habit.id));
  const retired: number[] = [];
  for (const retirement of proposal.habitsRetired) {
    if (!activeIds.has(retirement.id) || retired.includes(retirement.id)) return `Habit ${retirement.id} is not one he has.`;
    const uncited = cite(retirement.turnIds, `dropping habit ${retirement.id}`);
    if (uncited) return uncited;
    retired.push(retirement.id);
  }
  const kept = habits.filter((habit) => !retired.includes(habit.id)).map((habit) => phraseKey(habit.phrase));
  const added: NewHabit[] = [];
  for (const habit of proposal.habitsAdded) {
    const phrase = habit.phrase.trim();
    const key = phraseKey(phrase);
    const count = key.split(" ").filter(Boolean).length;
    if (count === 0 || count > SELF_GROWTH_LIMITS.habitWords) {
      return `"${phrase}" is not a phrase of 1 to ${SELF_GROWTH_LIMITS.habitWords} words.`;
    }
    const uncited = cite([habit.turnId], `"${phrase}"`);
    if (uncited) return uncited;
    const turn = window.get(habit.turnId)!;
    const fromWho = containsPhrase(turn.replied, phrase) ? "him" : containsPhrase(turn.said, phrase) ? "them" : null;
    if (!fromWho) return `"${phrase}" was not said in ${habit.turnId}.`;
    if (BANNED_HABITS.test(key) || phrase.endsWith("?")) return `"${phrase}" is a tic the house rules ban.`;
    const problem = growthProblem(`${phrase} ${habit.note}`);
    if (problem) return `"${phrase}" is ${problem}.`;
    if (!habit.note.trim()) return `"${phrase}" has no note.`;
    if (kept.includes(key)) return `"${phrase}" is already a habit.`;
    kept.push(key);
    added.push({ phrase, note: habit.note.trim(), turnId: turn.id, fromWho, at: turn.at });
  }
  if (kept.length > SELF_GROWTH_LIMITS.habits) return `He would have ${kept.length} habits; the cap is ${SELF_GROWTH_LIMITS.habits}.`;
  return { added, retired };
}

/** Words only, so punctuation and case never hide a phrase. */
function phraseKey(text: string): string {
  return text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
}

function containsPhrase(text: string, phrase: string): boolean {
  const key = phraseKey(phrase);
  return key.length > 0 && ` ${phraseKey(text)} `.includes(` ${key} `);
}

/** The bullets outside the fixed sections, each with a stable id for the night. */
export function accountLines(account: string): readonly AccountLine[] {
  const lines = account.split("\n");
  const found: AccountLine[] = [];
  let section: string | null = null;
  let count = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^##\s+(.+?)\s*$/.exec(lines[index]!);
    if (heading) {
      section = heading[1]!;
      count = 0;
      continue;
    }
    if (!section || selfGrowthFixedSections().includes(section) || !lines[index]!.startsWith("- ")) continue;
    let end = index + 1;
    while (end < lines.length && /^ {2}\S/.test(lines[end]!)) end += 1;
    count += 1;
    found.push({
      id: `${section.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${count}`,
      section,
      text: lines.slice(index, end).map((line) => line.replace(/^(?:- | {2})/, "")).join(" ").trim(),
      start: index,
      end,
    });
    index = end - 1;
  }
  return found;
}

/** The account with the edits made, untouched lines exactly as they were; or why it cannot be made. */
export function applyGrowthEdits(current: string, edits: readonly GrowthEdit[]): string | { readonly problem: string } {
  const lines = current.split("\n");
  const editable = accountLines(current);
  const byId = new Map(editable.map((line) => [line.id, line]));
  const replaced = new Map<number, readonly string[]>();
  const additions = new Map<string, string[]>();
  const touched = new Set<string>();
  for (const edit of edits) {
    if (edit.op === "add") {
      const section = edit.section ?? "";
      if (selfGrowthFixedSections().includes(section) || !lines.some((line) => line.trim() === `## ${section}`)) {
        return { problem: `"${section}" is not a section he may add to.` };
      }
      additions.set(section, [...(additions.get(section) ?? []), ...bullet(edit.text)]);
      continue;
    }
    const line = edit.lineId ? byId.get(edit.lineId) : undefined;
    if (!line) return { problem: `${edit.lineId ?? "A line"} is not a line he may change.` };
    if (touched.has(line.id)) return { problem: `${line.id} is changed twice.` };
    touched.add(line.id);
    replaced.set(line.start, edit.op === "replace" ? bullet(edit.text) : []);
  }
  const output: string[] = [];
  let section: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^##\s+(.+?)\s*$/.exec(lines[index]!);
    if (heading) {
      flushAdditions(output, section, additions);
      section = heading[1]!;
    }
    const line = replaced.has(index) ? editable.find((each) => each.start === index) : undefined;
    if (line) {
      output.push(...replaced.get(index)!);
      index = line.end - 1;
      continue;
    }
    output.push(lines[index]!);
  }
  flushAdditions(output, section, additions);
  return output.join("\n");
}

/** A section's additions go after its last line, before the blank line that ends it. */
function flushAdditions(output: string[], section: string | null, additions: Map<string, string[]>): void {
  const added = section ? additions.get(section) : undefined;
  if (!added) return;
  let at = output.length;
  while (at > 0 && output[at - 1]!.trim() === "") at -= 1;
  output.splice(at, 0, ...added);
}

/** A bullet wrapped at 80 columns, as SELF.md is written. */
function bullet(text: string): string[] {
  const lines: string[] = [];
  let line = "-";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line.length + 1 + word.length > 80 && line.length > 2) {
      lines.push(line);
      line = " ";
    }
    line += ` ${word}`;
  }
  lines.push(line);
  return lines;
}

/** What an added or reworded line must never be, or null. */
export function growthProblem(sentence: string, replacing = ""): string | null {
  const text = sentence.toLowerCase().replace(/[’‘]/g, "'");
  for (const [pattern, label] of GROWTH_REJECTS) {
    if (pattern.test(text)) return label;
  }
  const had = new Set(replacing.toLowerCase().match(householdRegex(String.raw`\b{REFERENCES}\b`, "g")) ?? []);
  if ((text.match(householdRegex(String.raw`\b{REFERENCES}\b`, "g")) ?? []).some((name) => !had.has(name))) return "a household member";
  return permanentTierBlocked(text) ? "sensitive" : null;
}

export function changeBudget(current: string): number {
  return Math.max(1, Math.floor(words(current).length * SELF_GROWTH_LIMITS.changeShare));
}

/** Words removed or added, whichever is more, so a one-word swap costs one. */
export function changedWordCount(before: string, after: string): number {
  const left = words(before);
  const right = words(after);
  let previous = new Array<number>(right.length + 1).fill(0);
  for (const word of left) {
    const row = new Array<number>(right.length + 1).fill(0);
    for (let index = 1; index <= right.length; index += 1) {
      row[index] = word === right[index - 1]
        ? previous[index - 1]! + 1
        : Math.max(previous[index]!, row[index - 1]!);
    }
    previous = row;
  }
  const common = previous[right.length]!;
  return Math.max(left.length - common, right.length - common);
}

/** Household open chat the model answered since the last pass, from the real clients only, latest 60, forgotten turns left out. */
export async function readGrowthTurns(options: {
  readonly logPath: string;
  readonly since: string;
  readonly until: string;
  readonly forgottenAmong?: (turnIds: readonly string[]) => ReadonlySet<string>;
}): Promise<readonly GrowthTurn[]> {
  const sinceMs = Date.parse(options.since);
  const untilMs = Date.parse(options.until);
  const turns: GrowthTurn[] = [];
  const marker = `"route":"${GROWTH_ROUTE}"`;
  let lines;
  try {
    lines = createInterface({ input: createReadStream(options.logPath, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes(marker)) continue;
      const turn = growthTurn(line, sinceMs, untilMs);
      if (!turn) continue;
      turns.push(turn);
      if (turns.length > SELF_GROWTH_LIMITS.windowTurns * 2) turns.splice(0, SELF_GROWTH_LIMITS.windowTurns);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    lines?.close();
  }
  const recent = turns.slice(-SELF_GROWTH_LIMITS.windowTurns);
  const forgotten = options.forgottenAmong?.(recent.map((turn) => turn.id)) ?? new Set<string>();
  return recent.filter((turn) => !forgotten.has(turn.id));
}

function growthTurn(line: string, sinceMs: number, untilMs: number): GrowthTurn | null {
  let entry: TurnLogEntry;
  try {
    entry = JSON.parse(line) as TurnLogEntry;
  } catch {
    return null;
  }
  const atMs = Date.parse(entry.timestamp);
  if (!(atMs > sinceMs && atMs <= untilMs) || entry.route !== GROWTH_ROUTE || entry.outcome === "error") return null;
  // Code-owned replies ("Good, thanks. All running on my end.") are fixed, never his to grow.
  if (entry.modelUsed !== true) return null;
  if (!isAdmittedIntakeSource(entry)) return null;
  const actorId = trustedSpeakerId(entry);
  const said = typeof entry.transcript === "string" ? entry.transcript.trim() : "";
  const replied = typeof entry.responseText === "string" ? entry.responseText.trim() : "";
  if (!actorId || !said || !replied) return null;
  return {
    id: entry.turnId,
    at: new Date(atMs).toISOString(),
    actorId,
    said: said.slice(0, SELF_GROWTH_LIMITS.saidChars),
    replied: replied.slice(0, SELF_GROWTH_LIMITS.repliedChars),
  };
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((word) => word && !/^(?:[-*]|#{1,6})$/.test(word));
}

export function houseClock(at: Date): { readonly day: string; readonly minutes: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: GROWTH_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function houseTimeLabel(at: Date): string {
  return new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: GROWTH_TIME_ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}

const VERSIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS self_account_versions (
    version INTEGER PRIMARY KEY CHECK(version >= 1),
    text TEXT NOT NULL,
    written_at TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('seed','nightly','rollback')),
    reason TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    words_changed INTEGER NOT NULL CHECK(words_changed >= 0),
    changes_json TEXT NOT NULL DEFAULT '[]'
  );`;

function migrateSelfGrowth(db: DatabaseSync): void {
  // 0.0.413 made the versions table without rollbacks or change lines; rebuild it once.
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'self_account_versions'").get() as
    { readonly sql: string } | undefined;
  if (existing && !existing.sql.includes("changes_json")) {
    inTransaction(db, () => {
      db.exec("ALTER TABLE self_account_versions RENAME TO self_account_versions_v1;");
      db.exec(VERSIONS_TABLE);
      db.exec(`INSERT INTO self_account_versions (version, text, written_at, source, reason, evidence_json, words_changed)
               SELECT version, text, written_at, source, reason, evidence_json, words_changed FROM self_account_versions_v1;
               DROP TABLE self_account_versions_v1;`);
    });
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS self_growth_meta (key TEXT PRIMARY KEY, value TEXT);
    ${VERSIONS_TABLE}
    CREATE TABLE IF NOT EXISTS self_growth_passes (
      pass_id TEXT PRIMARY KEY,
      ran_at TEXT NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      turns INTEGER NOT NULL CHECK(turns >= 0),
      outcome TEXT NOT NULL CHECK(outcome IN ('changed','unchanged','rejected','skipped','error')),
      detail TEXT NOT NULL,
      version INTEGER
    );
    CREATE TABLE IF NOT EXISTS self_speech_habits (
      habit_id INTEGER PRIMARY KEY AUTOINCREMENT,
      phrase TEXT NOT NULL,
      note TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      from_who TEXT NOT NULL CHECK(from_who IN ('him','them')),
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      retired_at TEXT,
      retired_reason TEXT
    );
  `);
}

interface VersionRow {
  readonly version: number;
  readonly text: string;
  readonly written_at: string;
  readonly source: string;
  readonly reason: string;
  readonly evidence_json: string;
  readonly words_changed: number;
  readonly changes_json: string;
}

interface PassRow {
  readonly pass_id: string;
  readonly ran_at: string;
  readonly window_start: string;
  readonly window_end: string;
  readonly turns: number;
  readonly outcome: string;
  readonly detail: string;
  readonly version: number | null;
}

interface HabitRow {
  readonly habit_id: number;
  readonly phrase: string;
  readonly note: string;
  readonly turn_id: string;
  readonly from_who: string;
  readonly first_seen: string;
  readonly last_seen: string;
  readonly retired_at: string | null;
  readonly retired_reason: string | null;
}

function parseVersionRow(row: VersionRow): SelfAccountVersion {
  return {
    version: row.version,
    text: row.text,
    writtenAt: row.written_at,
    source: row.source === "nightly" || row.source === "rollback" ? row.source : "seed",
    reason: row.reason,
    evidenceTurnIds: JSON.parse(row.evidence_json) as string[],
    wordsChanged: row.words_changed,
    changes: JSON.parse(row.changes_json) as SelfAccountChange[],
  };
}

function parsePassRow(row: PassRow): GrowthPass {
  return {
    passId: row.pass_id,
    ranAt: row.ran_at,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    turns: row.turns,
    outcome: row.outcome as GrowthPassOutcome,
    detail: row.detail,
    version: row.version,
  };
}

function parseHabitRow(row: HabitRow): SpeechHabit {
  return {
    id: row.habit_id,
    phrase: row.phrase,
    note: row.note,
    turnId: row.turn_id,
    fromWho: row.from_who === "them" ? "them" : "him",
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
  };
}
