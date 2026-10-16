/**
 * Music, alarm and reminder owners: requests that play or schedule
 * something on the assistant device or watch the house for a change: music on the
 * speaker you are talking to, the alarm clock,
 * and deferred watches ("tell me when the door opens").
 */
import { declined, ok, type BasicResult } from "./basic-brain-contracts.js";
import type { BasicBrainRouteServices } from "./basic-brain-services.js";
import { parseConditionalReminderRequest, type ConditionalReminderRequest, type ConditionalReminderService } from "./conditional-reminders.js";
import { friendlyName, shortFriendlyName, type HaEntityState } from "./ha-state-cache.js";
import type { JarvisDeviceEndpoint } from "./housemate-device-endpoint.js";
import { musicCommandAnswer, speakerMusicPlayer, speakerPlayerActive, volumeAskPending } from "./music-control.js";
import { parseMusicRequest, type MusicRequest } from "./music-request.js";
import { isGuestSpeakerRequest, trustedSpeakerLabel, trustedSpeakerPersonId } from "./speaker-principal.js";
import type { VoiceBrainRequest } from "./voice-brain.js";
import { labelsEquivalent } from "./target-index.js";
import { normalizeMeasuredRoutingText as normalize, targetTextKey } from "./routing-text.js";
import { localDateOffset, zonedTimeToUtc } from "./zoned-time.js";
import { resolveStatusTarget } from "./basic-brain-status.js";
import { DEFAULT_TIMEZONE } from "./basic-brain-open-chat.js";
import type { Owner, OwnerServices, OwnerTurn } from "./router.js";
import { householdRegex } from "./household.js";
import { HOUSE_LOCALE } from "./house-config.js";

type AlarmClockRequest =
  | { readonly action: "set"; readonly fireAt: Date }
  | { readonly action: "stop" };

export function parseAlarmClockRequest(transcript: string, normalized: string, now: Date): AlarmClockRequest | null {
  if (looksLikeStopAlarmRequest(normalized)) {
    return { action: "stop" };
  }
  const setMatch = /^(?:please\s+)?(?:set|create|make)\s+(?:an?\s+)?alarm\s+(?:for|at)\s+(.+)$/i.exec(transcript.trim());
  const wakeMatch = /^(?:please\s+)?wake\s+me\s+up\s+(?:at|for)\s+(.+)$/i.exec(transcript.trim());
  const targetText = setMatch?.[1]?.trim() || wakeMatch?.[1]?.trim() || "";
  if (!targetText) {
    return null;
  }
  const fireAt = parseAlarmTargetTime(targetText, now);
  return fireAt ? { action: "set", fireAt } : null;
}

function looksLikeStopAlarmRequest(normalized: string): boolean {
  return householdRegex(String.raw`^(?:hey\s+{ASSISTANT}\s+)?(?:stop|cancel|dismiss|turn off|shut off)\s+(?:the\s+|my\s+)?alarm\b`).test(normalized)
    || /^alarm\s+(?:off|stop)$/.test(normalized);
}

function parseAlarmTargetTime(text: string, now: Date): Date | null {
  const normalized = normalize(text).replace(/^for\s+/, "").replace(/^at\s+/, "").trim();
  const relative = /^in\s+(\d{1,3})\s+(minutes?|mins?|hours?|hrs?)$/.exec(normalized);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2] ?? "";
    const ms = unit.startsWith("hour") || unit.startsWith("hr") ? amount * 60 * 60 * 1000 : amount * 60 * 1000;
    return new Date(now.getTime() + ms);
  }
  const dayOffset = /\btomorrow\b/.test(normalized) ? 1 : 0;
  const clockText = normalized.replace(/\b(today|tomorrow)\b/g, "").trim();
  const clock = parseAlarmClockText(clockText);
  if (!clock) {
    return null;
  }
  let target = localAlarmDateTime(now, dayOffset, clock.hour, clock.minute);
  if (dayOffset === 0 && target.getTime() <= now.getTime()) {
    target = localAlarmDateTime(now, 1, clock.hour, clock.minute);
  }
  return target;
}

function parseAlarmClockText(text: string): { readonly hour: number; readonly minute: number } | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!match) {
    return null;
  }
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const suffix = match[3] ?? null;
  if (minute < 0 || minute > 59) {
    return null;
  }
  if (suffix) {
    if (hour < 1 || hour > 12) {
      return null;
    }
    if (suffix === "pm" && hour !== 12) {
      hour += 12;
    }
    if (suffix === "am" && hour === 12) {
      hour = 0;
    }
  } else if (hour < 0 || hour > 23) {
    return null;
  }
  return { hour, minute };
}

function localAlarmDateTime(now: Date, dayOffset: number, hour: number, minute: number): Date {
  const date = localDateOffset(now, DEFAULT_TIMEZONE, dayOffset);
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) {
    throw new Error(`invalid local alarm date: ${date}`);
  }
  return zonedTimeToUtc({ year, month, day, hour, minute, second: 0 }, DEFAULT_TIMEZONE);
}

function alarmTimeForSpeech(date: Date): string {
  return new Intl.DateTimeFormat(HOUSE_LOCALE, {
    timeZone: DEFAULT_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date).replace(/\s+/g, " ");
}

export async function alarmClockAnswer(routes: BasicBrainRouteServices, request: VoiceBrainRequest, alarm: AlarmClockRequest): Promise<BasicResult> {
  if (!routes.alarmClock) {
    return declined("alarm_clock", "Alarm clock support isn't wired in yet.", "alarm requested without alarm clock route service");
  }
  if (alarm.action === "stop") {
    const result = routes.alarmClock.stopAlarm(request.speaker.name);
    if (!result.stopped) {
      return declined("alarm_clock", "I don't have an alarm to stop.", "stop alarm found no ringing or scheduled alarm");
    }
    const verb = result.mode === "cancelled_scheduled" ? "Cancelled" : "Stopped";
    const endpoint = defaultJarvisDeviceEndpoint(routes.deviceEndpoints);
    const endpointResult = endpoint ? await endpoint.stopAlarm({ alarm: result.alarm }) : { touchedEntities: [] };
    return {
      ...ok(
        "alarm_clock",
        `${verb} the alarm.`,
        `alarm ${result.mode} id=${result.alarm?.id ?? "unknown"} endpoint=${endpoint?.id ?? "none"}`,
        null,
        { kind: "alarm_stopped", action: result.mode === "cancelled_scheduled" ? "cancelled" : "stopped" },
      ),
      touchedEntities: endpointResult.touchedEntities,
    };
  }
  const record = routes.alarmClock.setAlarm({
    fireAt: alarm.fireAt,
    speakerName: request.speaker.name,
  });
  const timeText = alarmTimeForSpeech(alarm.fireAt);
  return ok(
    "alarm_clock",
    `Alarm set for ${timeText}.`,
    `alarm set id=${record.id} fireAt=${record.fireAt}`,
    null,
    { kind: "alarm_set", timeText },
  );
}

export async function deferredWatchAnswer(
  routes: BasicBrainRouteServices,
  request: VoiceBrainRequest,
  reminder: ConditionalReminderRequest,
): Promise<BasicResult> {
  const service = routes.conditionalReminder;
  if (!service) {
    return declined("deferred_watch", "Deferred watches aren't wired in yet.", "deferred watch requested without service");
  }
  const result = await deferredWatchServiceResult(service, routes, request, reminder);
  return result.status === "ok"
    ? ok("deferred_watch", result.text, result.notes)
    : declined("deferred_watch", result.text, result.notes);
}

function defaultJarvisDeviceEndpoint(endpoints: readonly JarvisDeviceEndpoint[] | undefined): JarvisDeviceEndpoint | null {
  return endpoints?.[0] ?? null;
}

/** Words after "play X in/on..." that name a room or speaker. */
function isMusicRoom(text: string, routes: BasicBrainRouteServices): boolean {
  const normalized = normalize(text).replace(/^the /, "");
  return householdRegex(String.raw`\b(?:speakers?|show|{ASSISTANT} show|echo|kitchen|lounge|office|bedroom|cinema|garage|everywhere)\b`).test(normalized)
    || routes.registry?.areaNamed(normalized) != null;
}

function claimMusic(turn: OwnerTurn, ctx: OwnerServices): MusicRequest | null {
  const fromSpeaker = speakerMusicPlayer(turn.request, ctx.routes) !== null;
  const active = fromSpeaker && speakerPlayerActive(turn.request, ctx.routes);
  const request = parseMusicRequest(turn.transcript, turn.normalized, (text) => isMusicRoom(text, ctx.routes), {
    fromSpeaker,
    active,
    volumeAsked: fromSpeaker && volumeAskPending(turn.request, ctx.now()),
  });
  if (!request) {
    return null;
  }
  if (request.needsActivePlayer && !active) {
    return null;
  }
  // "Louder" on its own is the speaker's volume: from a speaker only.
  if ((request.command.kind === "volume_step" || request.command.kind === "mute" || request.command.kind === "volume_ask")
    && !/\b(?:music|volume|song)\b/.test(turn.normalized)
    && !fromSpeaker) {
    return null;
  }
  return request;
}

/** True for a whole "play X" request (the follow-up stage leaves it alone). */
export function looksLikeMusicPlayRequest(transcript: string, normalized: string): boolean {
  const request = parseMusicRequest(transcript, normalized, () => false);
  return request?.command.kind === "play" || request?.command.kind === "different_version";
}

function resolveDeferredWatchPerson(
  query: string,
  routes: BasicBrainRouteServices,
  request: VoiceBrainRequest,
): { readonly entityId: string; readonly label: string } | null {
  const normalized = normalize(query);
  if (/^(?:i|me|myself)$/.test(normalized)) {
    const speakerPersonId = trustedSpeakerPersonId(request);
    if (!speakerPersonId) {
      return null;
    }
    const state = routes.stateCache?.get(speakerPersonId);
    return {
      entityId: speakerPersonId,
      label: state ? shortFriendlyName(state) : trustedSpeakerLabel(request) ?? speakerPersonId,
    };
  }
  const target = resolveStatusTarget(query, routes);
  if (!target || target.entityIds.length !== 1) {
    return null;
  }
  const entityId = target.entityIds[0] as string | undefined;
  if (!entityId?.startsWith("person.")) {
    return null;
  }
  const state = routes.stateCache?.get(entityId);
  return {
    entityId,
    label: state ? shortFriendlyName(state) : target.label,
  };
}

function resolveDeferredWatchOpening(
  query: string,
  routes: BasicBrainRouteServices,
): { readonly entityId: string; readonly label: string } | null {
  const target = resolveStatusTarget(query, routes);
  if (target && target.entityIds.length === 1) {
    const entityId = target.entityIds[0] as string | undefined;
    if (entityId?.startsWith("binary_sensor.")) {
      const state = routes.stateCache?.get(entityId);
      if (state && isOpeningWatcherState(state)) {
        return {
          entityId,
          label: shortFriendlyName(state),
        };
      }
    }
  }
  return resolveDeferredWatchOpeningFallback(query, routes);
}

function resolveDeferredWatchOpeningFallback(
  query: string,
  routes: BasicBrainRouteServices,
): { readonly entityId: string; readonly label: string } | null {
  const normalized = targetTextKey(query);
  const openingStates = (routes.stateCache?.entries() ?? []).filter((state) => isOpeningWatcherState(state));
  const candidates = openingStates
    .map((state) => ({
      state,
      score: deferredWatchOpeningScore(normalized, state),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || friendlyName(left.state).localeCompare(friendlyName(right.state)));
  const best = candidates[0];
  if (!best) {
    return null;
  }
  if (candidates.filter((entry) => entry.score === best.score).length > 1) {
    return null;
  }
  return {
    entityId: best.state.entityId,
    label: shortFriendlyName(best.state),
  };
}

function deferredWatchOpeningScore(normalizedQuery: string, state: HaEntityState): number {
  const label = targetTextKey(friendlyName(state));
  if (!normalizedQuery || !label) {
    return 0;
  }
  if (labelsEquivalent(label, normalizedQuery)) {
    return 100;
  }
  if (label.includes(normalizedQuery)) {
    return 80;
  }
  if (normalizedQuery.includes(label)) {
    return 70;
  }
  const queryTokens = deferredWatchMeaningfulTokens(normalizedQuery);
  const labelTokens = new Set(deferredWatchMeaningfulTokens(label));
  const overlap = queryTokens.filter((token) => labelTokens.has(token)).length;
  if (overlap === 0) {
    return 0;
  }
  return overlap * 10 + (label.startsWith(queryTokens[0] ?? "") ? 3 : 0);
}

function deferredWatchMeaningfulTokens(value: string): readonly string[] {
  return value
    .split(" ")
    .filter((token) => token.length >= 3 && !["the", "and", "for", "with", "when", "open", "opens", "close", "closes"].includes(token));
}

async function deferredWatchServiceResult(
  service: ConditionalReminderService,
  routes: BasicBrainRouteServices,
  request: VoiceBrainRequest,
  reminder: ConditionalReminderRequest,
) {
  switch (reminder.kind) {
    case "calendar_start":
      return service.createCalendarStartReminder({ eventQuery: reminder.eventQuery, speakerName: request.speaker.name });
    case "rain_before_event":
      return service.createRainBeforeEventReminder({ eventQuery: reminder.eventQuery, speakerName: request.speaker.name });
    case "rain_start":
      return service.createRainStartReminder({ speakerName: request.speaker.name });
    case "person_arrived":
    case "person_departed": {
      if (isGuestSpeakerRequest(request)) {
        return {
          status: "declined" as const,
          text: "I can't set that watch up.",
          notes: `guest mode blocked personal deferred watch for ${reminder.personQuery}`,
        };
      }
      const target = resolveDeferredWatchPerson(reminder.personQuery, routes, request);
      if (!target) {
        return {
          status: "declined" as const,
          text: "I couldn't match that person to a live Home Assistant person entity.",
          notes: `deferred watch person target not found: ${reminder.personQuery}`,
        };
      }
      return reminder.kind === "person_arrived"
        ? service.createPersonArrivedReminder({ personId: target.entityId, personName: target.label, speakerName: request.speaker.name })
        : service.createPersonDepartedReminder({ personId: target.entityId, personName: target.label, speakerName: request.speaker.name });
    }
    case "opening_opened":
    case "opening_closed": {
      const target = resolveDeferredWatchOpening(reminder.targetQuery, routes);
      if (!target) {
        return {
          status: "declined" as const,
          text: "I couldn't match that to a single watched door, window, or opening sensor.",
          notes: `deferred watch opening target not found: ${reminder.targetQuery}`,
        };
      }
      return reminder.kind === "opening_opened"
        ? service.createOpeningOpenedReminder({ entityId: target.entityId, label: target.label, speakerName: request.speaker.name })
        : service.createOpeningClosedReminder({ entityId: target.entityId, label: target.label, speakerName: request.speaker.name });
    }
  }
}

function isOpeningWatcherState(state: HaEntityState): boolean {
  const value = state.attributes.device_class;
  return typeof value === "string" && ["door", "garage_door", "window", "opening"].includes(value.trim().toLowerCase());
}

// --- Owners ----------------------------------------------------------------------

/** "Tell me when the garage door opens": a deferred watch on the house. */
export const reminderOwner = {
  id: "reminder",
  tier: "explicit",
  // Deferred-watch grammar owns the directive frame ("tell me if", "remind
  // me when"). The semantic routing core intentionally unwraps indirect
  // questions, so parse this domain from the immutable utterance surface.
  claim: (turn) => parseConditionalReminderRequest(turn.analysis.normalizedSurface),
  answer: (request, ctx) => deferredWatchAnswer(ctx.routes, ctx.turn.request, request),
} satisfies Owner<ConditionalReminderRequest>;

/** "Wake me at seven". */
export const alarmOwner = {
  id: "alarm",
  tier: "explicit",
  claim: (turn, ctx) => parseAlarmClockRequest(turn.transcript, turn.normalized, ctx.now()),
  answer: (alarm, ctx) => alarmClockAnswer(ctx.routes, ctx.turn.request, alarm),
} satisfies Owner<AlarmClockRequest>;

/** "pause", "next", "louder", "what's playing?" on the speaker's own player. */
export const musicControlOwner = {
  id: "music_control",
  tier: "explicit",
  claim: (turn, ctx) => {
    const request = claimMusic(turn, ctx);
    return request && request.command.kind !== "play" && request.command.kind !== "different_version" ? request : null;
  },
  answer: (request, ctx) => musicCommandAnswer(ctx.routes, ctx.turn.request, request.command, ctx.now, request.heardAlike === true),
} satisfies Owner<MusicRequest>;

/** "Play Yellow", "play some music", "a different version". */
export const musicOwner = {
  id: "music",
  tier: "explicit",
  claim: (turn, ctx) => {
    const request = claimMusic(turn, ctx);
    return request && (request.command.kind === "play" || request.command.kind === "different_version") ? request : null;
  },
  answer: (request, ctx) => musicCommandAnswer(ctx.routes, ctx.turn.request, request.command, ctx.now, request.heardAlike === true),
} satisfies Owner<MusicRequest>;
