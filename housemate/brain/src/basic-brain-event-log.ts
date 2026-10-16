import { canonicalHouseholdActorId } from "./actor-identity.js";
import {
  buildCatchupDigest,
  catchupSourceEntityIds,
  renderCatchupSpeech,
  type CatchupDigest,
  type CatchupServices,
} from "./catchup-digest.js";
import type { PassiveEventWatcherService, PassiveWatcherEvent } from "./event-watchers.js";
import { parseTimeWindow } from "./time-window-parser.js";
import type { EventLogScope } from "./basic-brain-contracts.js";
import type { BasicSpeechRenderPlan } from "./basic-speech-response.js";
import { HOUSE_LOCALE, HOUSE_TIME_ZONE } from "./house-config.js";

const DEFAULT_TIMEZONE = HOUSE_TIME_ZONE;
const RECENT_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_EVENT_LINES = 5;
const EVENT_LOG_PATTERNS: readonly RegExp[] = [
  /^(?:what(?:'s|\s+is|\s+has)?|what)\s+happened(?:\s+(?:today|tonight|recently|lately|so far))?$/,
  /^what\s+changed(?:\s+(?:today|tonight|recently|lately|so far))?$/,
  /^what(?:'s|\s+is|\s+has)?\s+been\s+going\s+on(?:\s+(?:today|tonight|recently|lately|so far))?$/,
  /^(?:give me|show me|run me through)\s+(?:the\s+)?(?:house\s+)?(?:event\s+)?(?:log|timeline)(?:\s+for)?(?:\s+(?:today|tonight|recently|lately))?$/,
];
const WHILE_OUT_PATTERNS: readonly RegExp[] = [
  /^what(?:'s|\s+is|\s+has)?\s*(?:been\s+going\s+on|happened|changed)\s+while i was out$/,
  /^(?:give me|show me|run me through)\s+(?:what happened\s+)?while i was out$/,
];

/*
 * Catch-up grammar: a catch-up frame (miss / happen /
 * change / report / news / catch me up) with an optional absence or
 * since-contact scope, and nothing else. Anything after the frame is another
 * topic ("what did I miss in the footy"), so the whole utterance must parse.
 */
const ABSENCE_SCOPE = "while i (?:was|ve been) (?:out|gone|away|not home|not here)";
const CONTACT_SCOPE = "since (?:we|i) (?:last )?(?:spoke|talked|chatted)|since (?:the )?last time (?:we|i) (?:spoke|talked|chatted)";
const TODAY_SCOPE = "today|so far today|today so far|during the day|through the day|all day";
const CATCHUP_TAIL = `(?: (${ABSENCE_SCOPE}|${CONTACT_SCOPE}|${TODAY_SCOPE}))?(?: then)?`;
const CATCHUP_FRAMES: readonly string[] = [
  // what did I miss / have I missed anything / anything I missed
  "(?:so )?what (?:did|have|ve) i (?:miss|missed)",
  "(?:did|have) i (?:miss|missed) anything(?: important| interesting)?",
  "anything (?:i missed|i should know about|i need to know about)",
  // anything happen / did anything change
  "(?:did |has )?anything (?:interesting |important |exciting )?(?:happen|happened|change|changed|go on|gone on)",
  "(?:what is|what has|what s|what) (?:been )?(?:happened|happening|going on|changed)",
  "what (?:happened|changed)",
  // anything to report / any news / what's new
  "(?:(?:have you got|do you have|you got|got|is there) )?anything (?:new )?to report",
  "(?:(?:have you got|do you have|you got|got|is there) )?any news",
  "(?:what is|what s) new",
  "anything new",
  // catch me up
  "(?:catch|fill) me (?:up|in)",
  "bring me up to speed",
];
const CATCHUP_PATTERN = new RegExp(`^(?:${CATCHUP_FRAMES.join("|")})${CATCHUP_TAIL}$`);
// A bare "what happened" / "what changed" stays the recent house log; those
// frames are catch-ups only with a scope.
const SCOPE_REQUIRED_PATTERN = /^(?:(?:what is|what has|what s|what) (?:been )?(?:happened|happening|going on|changed)|what (?:happened|changed))(?: then)?$/;

export type CatchupScope = Extract<EventLogScope, "while_i_was_out" | "since_last_spoke" | "today">;

/** The catch-up scope for a whole-utterance catch-up ask, else null. */
export function catchupScope(normalized: string): CatchupScope | null {
  if (!normalized || SCOPE_REQUIRED_PATTERN.test(normalized)) {
    return null;
  }
  const match = CATCHUP_PATTERN.exec(normalized);
  if (!match) {
    return null;
  }
  const scope = match[1] ?? "";
  if (new RegExp(`^(?:${TODAY_SCOPE})$`).test(scope)) {
    // "What's happening today?" asks what's on (calendar); only the perfect
    // "what's been happening today?" looks back over the day.
    return /^(?:what is|what s|what) (?:happening|going on)\b/.test(normalized) ? null : "today";
  }
  return new RegExp(`^${ABSENCE_SCOPE}$`).test(scope) ? "while_i_was_out" : "since_last_spoke";
}

/**
 * Looser than `catchupScope`: an absence or since-contact phrase anywhere.
 * Only decides whether an open-chat turn may carry the catch-up digest.
 */
export function mentionsCatchupScope(normalized: string): CatchupScope | null {
  if (new RegExp(`\\b(?:${ABSENCE_SCOPE})\\b`).test(normalized)) {
    return "while_i_was_out";
  }
  return new RegExp(`\\b(?:${CONTACT_SCOPE})\\b`).test(normalized) ? "since_last_spoke" : null;
}

export type { EventLogScope } from "./basic-brain-contracts.js";

export interface EventLogAnswer {
  readonly status: "ok" | "declined";
  readonly text: string;
  readonly notes: string;
  readonly scope: EventLogScope;
  readonly sourceEntityIds: readonly string[];
  readonly sourceSummary: string;
  readonly speechPlan?: BasicSpeechRenderPlan | null;
  /** Catch-up scopes only: the digest the answer was spoken from. */
  readonly digest?: CatchupDigest;
  /** Withheld from an untrusted voice: never spoken, the turn goes to open chat (BasicResult.withheld). */
  readonly withheld?: true;
}

export function looksLikeEventLogQuestion(normalized: string): boolean {
  if (!normalized) {
    return false;
  }
  if (WHILE_OUT_PATTERNS.some((pattern) => pattern.test(normalized)) || catchupScope(normalized)) {
    return true;
  }
  return EVENT_LOG_PATTERNS.some((pattern) => pattern.test(normalized));
}

export async function buildEventLogAnswer(options: {
  readonly eventWatcher: PassiveEventWatcherService | undefined;
  readonly now: Date;
  readonly normalized: string;
  readonly timezone?: string;
  readonly guestMode: boolean;
  readonly trustedSpeakerPersonId: string | null;
  readonly catchup?: {
    readonly services: CatchupServices;
    /** Start of the current conversation, for "since we last spoke". */
    readonly sessionStartedAt: Date;
  };
}): Promise<EventLogAnswer | null> {
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const scope = resolveScope(options.normalized);
  if (scope === "while_i_was_out" || scope === "since_last_spoke") {
    return catchupAnswer(options, scope, timezone);
  }
  // Today's digest is built from HA history. Guests, and a brain
  // without history wired, keep the watched house log, which hides people.
  if (scope === "today" && options.catchup?.services.fetchHistory && !options.guestMode && options.trustedSpeakerPersonId) {
    return catchupAnswer(options, scope, timezone);
  }
  if (!options.eventWatcher) {
    return null;
  }

  const sourceEntityIds = new Set<string>();
  const recentEvents = options.eventWatcher.recentEvents(120);
  const sourceSummary = "passive watcher event log";
  const range = scopeRange(scope, options.now, timezone);
  const filteredEvents = filterEvents(recentEvents, range.start, range.end, options.guestMode);
  const lead = scopeLead(scope);

  const visibleEvents = filteredEvents.slice(-MAX_EVENT_LINES);
  for (const event of visibleEvents) {
    const entityId = eventSourceEntityId(event);
    if (entityId) {
      sourceEntityIds.add(entityId);
    }
  }

  if (visibleEvents.length === 0) {
    return {
      status: "ok",
      text: quietLogSentence(scope, lead),
      notes: `event log ${scope} found no notable watcher events`,
      scope,
      sourceEntityIds: [...sourceEntityIds].sort(),
      sourceSummary,
      speechPlan: {
        kind: "event_log",
        scope,
        lead,
        entries: [],
        quiet: true,
      },
    };
  }

  const eventLines = visibleEvents.map((event) => renderEventLine(event, timezone));
  const timeline = eventLines.join(" ");
  return {
    status: "ok",
    text: `${lead} ${timeline}`.trim(),
    notes: `event log ${scope} from ${visibleEvents.length} watcher events`,
    scope,
    sourceEntityIds: [...sourceEntityIds].sort(),
    sourceSummary,
    speechPlan: {
      kind: "event_log",
      scope,
      lead,
      entries: eventLines,
      quiet: false,
    },
  };
}

async function catchupAnswer(
  options: Parameters<typeof buildEventLogAnswer>[0],
  scope: CatchupScope,
  timezone: string,
): Promise<EventLogAnswer> {
  const sourceSummary = "catch-up digest from Home Assistant history";
  const actorId = options.guestMode ? null : canonicalHouseholdActorId(options.trustedSpeakerPersonId);
  if (!actorId) {
    return {
      status: "declined",
      text: "",
      notes: `catch-up ${scope} blocked for guest speaker`,
      withheld: true,
      scope,
      sourceEntityIds: [],
      sourceSummary,
    };
  }
  if (!options.catchup) {
    return {
      status: "declined",
      text: "I can't build a catch-up yet because the house history isn't wired.",
      notes: `catch-up ${scope} missing services`,
      scope,
      sourceEntityIds: [],
      sourceSummary,
    };
  }
  const built = await buildCatchupDigest({
    scope,
    actorId,
    now: options.now,
    sessionStartedAt: options.catchup.sessionStartedAt,
    timezone,
    services: options.catchup.services,
  });
  if (built.status === "declined") {
    return {
      status: "declined",
      text: built.text,
      notes: built.notes,
      scope,
      sourceEntityIds: built.sourceEntityIds,
      sourceSummary,
    };
  }
  const digest = built.digest;
  const speech = renderCatchupSpeech(digest, options.now);
  return {
    status: "ok",
    text: speech.text,
    notes: `catch-up ${scope} ${digest.window.basis} window ${digest.window.start}..${digest.window.end}: `
      + `${digest.items.length} items${digest.failures.length > 0 ? `, failed ${digest.failures.join("/")}` : ""}`,
    scope,
    sourceEntityIds: catchupSourceEntityIds(digest),
    sourceSummary,
    speechPlan: {
      kind: "catchup",
      scope,
      lead: speech.lead,
      entries: speech.entries,
      closing: speech.closing,
      quiet: speech.quiet,
    },
    digest,
  };
}

function resolveScope(normalized: string): EventLogScope {
  const catchup = catchupScope(normalized);
  if (catchup) {
    return catchup;
  }
  if (/\bwhile i was out\b/.test(normalized)) {
    return "while_i_was_out";
  }
  if (/\btonight\b/.test(normalized)) {
    return "tonight";
  }
  if (/\btoday\b|\bso far\b/.test(normalized)) {
    return "today";
  }
  return "recent";
}

function scopeRange(scope: EventLogScope, now: Date, timezone: string): { readonly start: string; readonly end: string } {
  if (scope === "recent") {
    return {
      start: new Date(now.getTime() - RECENT_WINDOW_MS).toISOString(),
      end: now.toISOString(),
    };
  }
  const windowText = scope === "tonight" ? "tonight" : "today";
  const parsed = parseTimeWindow(windowText, { now, timezone });
  if (parsed.status === "matched" && parsed.window) {
    return { start: parsed.window.start, end: parsed.window.end };
  }
  return {
    start: new Date(now.getTime() - RECENT_WINDOW_MS).toISOString(),
    end: now.toISOString(),
  };
}

function filterEvents(
  events: readonly PassiveWatcherEvent[],
  startIso: string,
  endIso: string,
  guestMode: boolean,
): readonly PassiveWatcherEvent[] {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  return [...events]
    .reverse()
    .filter((event) => {
      const detectedAtMs = Date.parse(event.detectedAt);
      if (!Number.isFinite(detectedAtMs) || detectedAtMs < startMs || detectedAtMs > endMs) {
        return false;
      }
      if (guestMode && (event.kind === "person_arrived" || event.kind === "person_departed")) {
        return false;
      }
      return true;
    });
}

function quietLogSentence(scope: EventLogScope, lead: string): string {
  switch (scope) {
    case "today":
      return `${lead} it has been quiet on the watched house log so far.`;
    case "tonight":
      return `${lead} it has been quiet on the watched house log so far.`;
    case "while_i_was_out":
      return `${lead} nothing notable showed up in the watched house log.`;
    default:
      return `${lead} it has been quiet on the watched house log recently.`;
  }
}

function scopeLead(scope: EventLogScope): string {
  switch (scope) {
    case "today":
      return "Today:";
    case "tonight":
      return "Tonight so far:";
    case "while_i_was_out":
      return "While you were out:";
    default:
      return "Recently:";
  }
}

function renderEventLine(event: PassiveWatcherEvent, timezone: string): string {
  const at = formatLocalTime(event.detectedAt, timezone);
  switch (event.kind) {
    case "calendar_start":
      return `${event.eventSummary} started at ${at}.`;
    case "rain_start":
      return `Rain started around ${at}.`;
    case "person_arrived":
      return `${event.personName} arrived at ${at}.`;
    case "person_departed":
      return `${event.personName} left at ${at}.`;
    case "opening_opened":
      return `${event.label} opened at ${at}.`;
    case "opening_closed":
      return `${event.label} closed at ${at}.`;
  }
}

function eventSourceEntityId(event: PassiveWatcherEvent): string | null {
  switch (event.kind) {
    case "calendar_start":
      return event.calendarEntityId;
    case "rain_start":
      return event.entityId;
    case "person_arrived":
    case "person_departed":
      return event.personId;
    case "opening_opened":
    case "opening_closed":
      return event.entityId;
  }
}

function formatLocalTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(value)).replace(/\s+/g, " ");
}
