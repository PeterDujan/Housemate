import type { BasicBrainRouteServices } from "./basic-brain-services.js";
import { calendarOutlookLines, todoListLines } from "./basic-brain-schedule.js";
import { weatherOutlookLines } from "./basic-brain-weather.js";
import { currentPowerLoadLines } from "./basic-brain-metrics.js";
import {
  buildCatchupDigest,
  catchupDigestFacts,
  loadCatchupSourcesConfig,
  type CatchupServices,
} from "./catchup-digest.js";
import type { ChatCodeToolName, ChatToolHandlers } from "./chat-tool-bridge.js";
import type { AppConfig } from "./config.js";
import { currentHouseRoutineLines } from "./house-pattern-catalog.js";
import { currentPersonObservationLines } from "./house-pattern-observations.js";
import { presenceRollCallAnswer } from "./house-presence.js";

/**
 * Open chat reads what code the assistant reads ("the
 * AI should ALSO access 100% of that"). Each tool calls the function the
 * matching code route answers from, so there is one truth: calendar, to-do
 * lists, weather, who's home, the household's reviewed routines, live power
 * loads and the house's own record of what happened. All read-only, for the
 * verified household speaker the bridge binds (guests never get tools).
 * Anything these miss, the house tools can still look up in Home Assistant.
 */

export type ChatCodeToolHandlers = Pick<ChatToolHandlers, ChatCodeToolName>;

export function createChatCodeToolHandlers(options: {
  readonly config: Pick<AppConfig, "dataDir">;
  /** Projected at call time so live sources stay current. */
  readonly routes: () => BasicBrainRouteServices;
  readonly catchupServices: () => CatchupServices;
  readonly timezone: string;
}): ChatCodeToolHandlers {
  return {
    read_calendar({ kind, daysAhead }, context) {
      return calendarOutlookLines(options.routes(), context.now, kind, daysAhead, context.signal);
    },

    read_todo_lists(_input, context) {
      return todoListLines(options.routes(), context.signal);
    },

    read_weather({ daysAhead }, context) {
      return weatherOutlookLines(options.routes(), context.now, daysAhead);
    },

    who_is_home(_input, context) {
      const stateCache = options.routes().stateCache;
      if (!stateCache) return "Who's home is unavailable right now.";
      const answer = presenceRollCallAnswer({
        form: "who",
        speakerActorId: context.actorId,
        people: loadCatchupSourcesConfig().people,
        stateOf: (entityId) => stateCache.get(entityId),
      });
      return `${answer.text} (Home or out only; where someone is when out is not shared.)`;
    },

    read_household_routines(_input, context) {
      const lines = [
        ...currentHouseRoutineLines(options.config, context.actorId, context.now),
        ...currentPersonObservationLines(options.config, context.now),
      ];
      return lines.length > 0
        ? ["Reviewed routines from the house's own history (\"you\" is the speaker):", ...lines.map((line) => `- ${line}`)].join("\n")
        : "No reviewed routines are current.";
    },

    read_power_now() {
      return currentPowerLoadLines(options.routes());
    },

    async read_house_happenings({ window }, context) {
      const built = await buildCatchupDigest({
        scope: window,
        actorId: context.actorId,
        now: context.now,
        sessionStartedAt: context.now,
        timezone: options.timezone,
        services: options.catchupServices(),
      });
      return built.status === "ok" ? catchupDigestFacts(built.digest, context.now) : built.text;
    },
  };
}
