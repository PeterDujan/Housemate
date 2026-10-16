import { followUpSteps } from "./follow-up-turn.js";
import {
  calendarAnswer,
  looksLikeCalendarQuestion,
  looksLikeScheduleQuestion,
  looksLikeTodoQuestion,
  scheduleAnswer,
  todoAnswer,
  upcomingCommitmentsAnswer,
} from "./basic-brain-schedule.js";
import { looksLikeUpcomingCommitmentsQuestion } from "./upcoming-commitments-intent.js";
import { sourceRead } from "./stateless-owners.js";
/**
 * Schedule owners: calendar, to-do, upcoming commitments and the
 * day's schedule, claimed from their own words and followed up on the
 * calendar frame. The answers live in `basic-brain-schedule.ts`.
 */

// --- Follow-ups ------------------------------------------------------------------

/** A new window on the calendar frame ("and tomorrow?", "the rest of the week"). */
export const SCHEDULE_FOLLOW_UPS = followUpSteps("schedule", {
  calendarWindow(f, ctx) {
    const calendarFrame = f.views.calendar.active?.payload
      ?? (f.returnsToPriorFocus ? f.views.calendar.recent?.payload ?? null : null);
    const window = f.timeWindow;
    return calendarFrame && window
      && /\b(?:calendar|diary|appointment|appointments|schedule|week|day|today|tomorrow|show|rest|back|return)\b/.test(f.normalized)
      ? calendarAnswer(ctx.routes, ctx.now(), f.normalized, { entityIds: calendarFrame.entityIds, window })
      : null;
  },
  activeCalendarWindow(f, ctx) {
    const activeCalendarFrame = f.views.calendar.active?.payload ?? null;
    const window = f.timeWindow;
    return activeCalendarFrame && window
      ? calendarAnswer(ctx.routes, ctx.now(), f.normalized, { entityIds: activeCalendarFrame.entityIds, window })
      : null;
  },
});

// --- Owners ----------------------------------------------------------------------

/** "My calendar, not the weather": the calendar asked by name over the forecast. */
export const calendarOverWeatherOwner = sourceRead(
  "calendar_over_weather",
  "correction",
  ({ normalized: n }) => /\b(?:calendar|diary|appointments?)\b[\s\S]*\b(?:not|rather than|instead of)\b[\s\S]*\b(?:weather|forecast)\b/.test(n)
    && (looksLikeCalendarQuestion(n) || looksLikeScheduleQuestion(n)),
  (ctx) => calendarAnswer(ctx.routes, ctx.now(), ctx.turn.normalized),
  "read_source_unavailable",
);

/** "What have I got on this week?": calendar, school and routine commitments together. */
export const upcomingOwner = sourceRead(
  "upcoming",
  "explicit",
  (turn) => looksLikeUpcomingCommitmentsQuestion(turn.normalized),
  (ctx) => upcomingCommitmentsAnswer(ctx.config, ctx.routes, ctx.turn.request, ctx.turn.normalized, ctx.now()),
  "cross_source_read_required",
);

/** "What's Alex's schedule today?". */
export const scheduleOwner = sourceRead(
  "schedule",
  "explicit",
  (turn) => looksLikeScheduleQuestion(turn.normalized),
  (ctx) => scheduleAnswer(ctx.config, ctx.routes, ctx.turn.request, ctx.turn.transcript, ctx.turn.normalized, ctx.now()),
  "cross_source_read_required",
);

/** "What's on the shopping list?". */
export const todoOwner = sourceRead("todo", "explicit", (turn) => looksLikeTodoQuestion(turn.normalized), (ctx) => todoAnswer(ctx.routes, ctx.turn.normalized), "read_source_unavailable");

/** "What's on the calendar tomorrow?". */
export const calendarOwner = sourceRead(
  "calendar",
  "explicit",
  (turn) => looksLikeCalendarQuestion(turn.normalized),
  (ctx) => calendarAnswer(ctx.routes, ctx.now(), ctx.turn.normalized),
  "read_source_unavailable",
);
