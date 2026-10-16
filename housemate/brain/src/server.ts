import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";

import { canRestartApp, restartAppSoon } from "./app-restart.js";
import { appVersion } from "./app-version.js";
import { createBasicBrainVoiceHandler } from "./basic-brain.js";
import type { BasicBrainRouteServices } from "./basic-brain-services.js";
import { type AppConfig, runtimeReadiness, safeConfigSummary } from "./config.js";
import { cognitiveControlState, cognitiveFeatureEnabled } from "./cognitive-control.js";
import {
  applyAcceptedMemoryRemoval,
  applyMemoryReviewDecision,
  disabledMemoryReviewResponse,
  nextMemoryReviewResponse,
  storedMemoryItems,
  type MemoryReviewNextResponse,
  type StoredMemoryItem,
} from "./memory-review.js";
import { readHouseChoices, type DiscoveredHouse, type HouseOptions } from "./house-discovery.js";
import { houseDiscoveryBody } from "./house-discovery-view.js";
import type { PageActions, PageReply } from "./chat-settings-tools.js";
import { modelLedgerPath, readModelBudgetSummary } from "./model-ledger.js";
import { InMemoryPersonalityTailStore, type PersonalityTailStore } from "./personality-tail.js";
import { personalityFilePath } from "./persona.js";
import { readPersonaForm, savePersonaForm } from "./persona-editor.js";
import { type HaPerson, readPeopleForm, savePeopleForm } from "./people-editor.js";
import { householdFilePath } from "./household.js";
import type { VoiceTrainingControl } from "./voice-training.js";
import { setupStatus } from "./setup-status.js";
import {
  decideProactiveReview,
  proactiveReviewSummary,
  setProactiveType,
  type ProactiveReviewSummary,
} from "./proactive-shadow.js";
import {
  buildProactiveDashboardSummary,
  proactivePresencePersonId,
  type ProactiveDashboardSummary,
} from "./proactive-summary.js";
import { emitProgressiveText, ProgressiveSpeechSession } from "./progressive-speech.js";
import { buildLocalReport, type LocalReport } from "./report.js";
import {
  readTurnLogEntries,
  secureTurnLogStorage,
  turnLogPath,
  type TurnLogEntry,
} from "./turn-log.js";
import {
  buildVoiceBrainErrorResponse,
  parseVoiceBrainRequest,
  type VoiceBrainHandler,
} from "./voice-brain.js";
import { formatForSpeech } from "./spoken-format.js";
import { dashboardPageHtml } from "./dashboard-page.js";
import { applyDashboardSetting, buildDashboardSettings, isJarvisHelperKey, type JarvisHelperControl } from "./dashboard-settings.js";
import type { LiveSettingsStore } from "./live-settings.js";
import type { DashboardNames } from "./dashboard-names.js";
import type { JarvisSelfModel, SelfModelDashboardTastes } from "./self-model.js";
import type { SelfGrowthDashboard, SelfGrowthStore } from "./self-growth.js";
import { prewarmClaudeStream, prewarmClaudeToolStream } from "./model-backend.js";
import {
  CORRECTION_CLOSE_REASONS,
  CorrectionLedger,
  correctionDashboardSummary,
  correctionLedgerPath,
  type CorrectionCloseReason,
  type CorrectionDashboardSummary,
} from "./correction-ledger.js";
import type { HeldMemoryReviewItem, MemoryReflectionService } from "./memory-reflection.js";
import {
  resolveVoiceRequestTransportTrust,
  type VoiceRequestTransportTrust,
} from "./voice-request-trust.js";
import { errorMessage } from "./value-guards.js";
import { CodexSignIn } from "./sign-in.js";
import { readVoiceWordsForm, saveVoiceWordsForm } from "./voice-words.js";
import { readMediaAppsForm, saveMediaAppForm } from "./media-apps.js";
import { readAppOptionsForm, saveAppOptionsForm } from "./app-options.js";

export interface HealthResponse {
  readonly ok: true;
  readonly service: "housemate-brain";
  readonly version: string;
  readonly startedAt: string;
  readonly uptimeMs: number;
}

export interface StatusResponse {
  readonly ok: true;
  readonly service: "housemate-brain";
  readonly version: string;
  readonly config: ReturnType<typeof safeConfigSummary>;
  readonly readiness: ReturnType<typeof runtimeReadiness>;
  readonly cognition: ReturnType<typeof cognitiveControlState>;
  readonly budget: ReturnType<typeof readModelBudgetSummary>;
}

export interface DashboardResponse {
  readonly ok: true;
  readonly service: "housemate-brain";
  readonly version: string;
  readonly startedAt: string;
  readonly generatedAt: string;
  readonly readiness: ReturnType<typeof runtimeReadiness>;
  readonly cognition: ReturnType<typeof cognitiveControlState>;
  readonly report: LocalReport;
  readonly proactive: ProactiveDashboardSummary;
  readonly review: MemoryReviewNextResponse;
  readonly recentTurns: readonly TurnLogEntry[];
  /** Review tab: his tastes (Undo, Lock) and chat opinions (Forget). */
  readonly tastes: SelfModelDashboardTastes | null;
  /** His versions, nights and habits. */
  readonly growth: SelfGrowthDashboard | null;
  /** Review tab: accepted memories, each with a Scrap button (`/memory/remove`). */
  readonly storedMemories: { readonly enabled: boolean; readonly items: readonly StoredMemoryItem[] };
  /** Open corrections for the operator to see and close. */
  readonly corrections: CorrectionDashboardSummary;
  /** What the assistant would have said on his own, for Accept / Decline. */
  readonly proactiveReview: ProactiveReviewSummary;
  /** Held memories waiting for Keep / Scrap. */
  readonly heldMemories: { readonly enabled: boolean; readonly items: readonly HeldMemoryReviewItem[] };
}

export interface AppRuntime {
  readonly version: string;
  readonly startedAt: Date;
  readonly now?: () => Date;
  readonly voiceBrainHandler?: VoiceBrainHandler;
  readonly routes?: BasicBrainRouteServices;
  readonly personalityTailStore?: PersonalityTailStore;
  readonly selfModel?: JarvisSelfModel;
  /** His self-account, nights and habits. */
  readonly selfGrowth?: SelfGrowthStore;
  readonly memoryReflection?: Pick<MemoryReflectionService, "heldForReview" | "decideHeld">;
  /** Dashboard settings store and the add-on option values it overrides. */
  readonly liveSettings?: { readonly store: LiveSettingsStore; readonly defaults: AppConfig };
  /** The three HA helpers the Settings tab may change, nothing else. */
  readonly jarvisHelpers?: JarvisHelperControl;
  /** The "My X" names editor and read-only roster. */
  readonly dashboardNames?: DashboardNames;
  /** The Housemate Brain conversation agent in Home Assistant (platform housemate), if added. */
  readonly brainAgent?: () => string | null;
  /** Voice training on a speaker. */
  readonly voiceTraining?: VoiceTrainingControl;
  /** What the house set itself up from, and a fresh look. */
  readonly houseDiscovery?: {
    readonly found: () => DiscoveredHouse | null;
    readonly rescan: () => Promise<DiscoveredHouse>;
    readonly options: () => HouseOptions;
    /** Saves the House page (what the house wants in use) and looks again with it. */
    readonly save: (raw: unknown) => Promise<DiscoveredHouse>;
  };
  /** Home Assistant's people (person.* entities), for the People editor. */
  readonly haPersons?: () => readonly HaPerson[];
  /** The page's actions for its Chat tab, run here as the page would. */
  readonly pageActions?: PageActions;
  readonly transportTrustResolver?: (
    request: IncomingMessage,
  ) => VoiceRequestTransportTrust | null;
}

export function createApp(
  config: AppConfig,
  runtime: AppRuntime = defaultRuntime(),
): Server {
  secureTurnLogStorage(turnLogPath(config));
  const personalityTailStore = runtime.personalityTailStore ?? new InMemoryPersonalityTailStore();
  const voiceBrainHandler = runtime.voiceBrainHandler ?? createBasicBrainVoiceHandler({
    config,
    ...(runtime.routes ? { routes: runtime.routes } : {}),
    ...(runtime.now ? { now: runtime.now } : {}),
    personalityTailStore,
    ...(runtime.selfModel ? { selfModel: runtime.selfModel } : {}),
  });
  const effectiveRuntime: ServedRuntime = {
    ...runtime,
    personalityTailStore,
    voiceBrainHandler,
  };
  runtime.pageActions?.attach((method, path, body, actorId) => runPageAction(config, effectiveRuntime, method, path, body, actorId));
  const server = createServer((request, response) => {
    void routeRequest(config, effectiveRuntime, request, response);
  });
  // Keep sockets around long enough for local eval clients to reuse them safely under bursty load.
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  server.requestTimeout = 0;
  server.maxRequestsPerSocket = 0;
  return server;
}

type Method = "GET" | "POST" | "DELETE";

/** Who may call: anyone, any trusted transport (ingress or the API secret), or Supervisor ingress only. */
type Access = "open" | "transport" | "ingress";

type ServedRuntime = AppRuntime & Required<Pick<AppRuntime, "voiceBrainHandler" | "personalityTailStore">>;

interface RouteContext {
  readonly config: AppConfig;
  readonly runtime: ServedRuntime;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  /** The decoded `:id` of /voice/tail/:id ("" when it does not decode). */
  readonly tailId: string;
  /** The request's transport trust, resolved once on first use. */
  readonly trust: () => VoiceRequestTransportTrust | null;
  readonly json: (statusCode: number, payload: unknown) => void;
}

interface Route {
  readonly access: Access;
  readonly run: (context: RouteContext) => unknown;
}

/**
 * One path. `access` and `unavailable` apply to every method (the settings
 * family answers 403/503 before it looks at the method); a method with no
 * route is 404.
 */
interface PathRoutes {
  readonly access?: Access;
  readonly unavailable?: (context: RouteContext) => string | null;
  readonly methods: Partial<Record<Method, Route>>;
}

const open = (run: Route["run"]): Route => ({ access: "open", run });
const ingress = (run: Route["run"]): Route => ({ access: "ingress", run });
const transport = (run: Route["run"]): Route => ({ access: "transport", run });

const TAIL_PATH = /^\/voice\/tail\/([^/]+)$/;
const dashboardPage = open(({ response }) => writeHtml(response, 200, dashboardPageHtml()));
// The page's font ships with the app (dist/src -> src/assets), read once on first use.
let pageFont: Buffer | null = null;
const pageFontRoute = open(({ response }) => {
  pageFont ??= readFileSync(new URL("../../src/assets/inter-variable.woff2", import.meta.url));
  response.writeHead(200, {
    "content-type": "font/woff2",
    "content-length": pageFont.length,
    "cache-control": "public, max-age=604800",
  });
  response.end(pageFont);
});
const settingsUnavailable = ({ runtime }: RouteContext) => runtime.liveSettings ? null : "settings_unavailable";
const answerTurn = open(async ({ request, json, trust, runtime }) => {
  try {
    const brainRequest = parseVoiceBrainRequest(await readJsonBody(request), trust());
    json(200, await runtime.voiceBrainHandler(brainRequest));
  } catch (error) {
    json(400, buildVoiceBrainErrorResponse("bad_request", errorMessage(error)));
  }
});

const ROUTES = new Map<string, PathRoutes>([
  // One chat page: HA ingress opens the root, which is the assistant Dashboard.
  ["/", { methods: { GET: dashboardPage } }],
  ["/dashboard-ui", { methods: { GET: dashboardPage } }],
  ["/assets/inter.woff2", { methods: { GET: pageFontRoute } }],
  ["/health", { methods: { GET: open(({ runtime, json }) => json(200, {
    ok: true,
    service: "housemate-brain",
    version: runtime.version,
    startedAt: runtime.startedAt.toISOString(),
    uptimeMs: Math.max(0, Date.now() - runtime.startedAt.getTime()),
  } satisfies HealthResponse)) } }],
  ["/status", { methods: { GET: open(({ config, runtime, json }) => json(200, {
    ok: true,
    service: "housemate-brain",
    version: runtime.version,
    config: safeConfigSummary(config),
    readiness: runtimeReadiness(config),
    cognition: cognitiveControlState(config),
    budget: readModelBudgetSummary(modelLedgerPath(config), config.monthlyBudgetUsd, runtime.now?.() ?? new Date()),
  } satisfies StatusResponse)) } }],
  ["/dashboard", { methods: { GET: ingress(({ config, runtime, url, json }) => json(200, buildDashboardResponse(config, runtime, url))) } }],
  ["/corrections/close", { methods: { POST: ingress(async ({ config, runtime, request, json }) => {
    try {
      const body = await readJsonBody(request) as { id?: unknown; reason?: unknown };
      const reason = body.reason as CorrectionCloseReason;
      if (typeof body.id !== "string" || !body.id.trim() || !CORRECTION_CLOSE_REASONS.includes(reason)) {
        json(400, { ok: false, error: "id and reason (fixed or not_a_correction) are required" });
        return;
      }
      let failure: unknown = null;
      const closed = await new CorrectionLedger({
        filePath: correctionLedgerPath(config),
        ...(runtime.now ? { now: runtime.now } : {}),
        onError: (error: unknown) => { failure = error; },
      }).close(body.id, reason);
      if (failure) throw failure;
      json(closed ? 200 : 404, closed ? { ok: true, id: body.id, reason } : { ok: false, error: "no_open_correction" });
    } catch (error) {
      json(400, { ok: false, error: errorMessage(error) });
    }
  }) } }],
  ["/proactive/review/decide", { methods: { POST: ingress(async ({ config, runtime, request, json }) => {
    try {
      const body = await readJsonBody(request) as { id?: unknown; verdict?: unknown };
      if (typeof body.id !== "string" || !body.id.trim() || (body.verdict !== "accept" && body.verdict !== "decline")) {
        json(400, { ok: false, error: "id and verdict (accept or decline) are required" });
        return;
      }
      const found = decideProactiveReview(config, body.id, body.verdict, runtime.now?.() ?? new Date());
      json(found ? 200 : 404, found ? { ok: true, id: body.id, verdict: body.verdict } : { ok: false, error: "no_proactive_proposal" });
    } catch (error) {
      json(500, { ok: false, error: errorMessage(error) });
    }
  }) } }],
  ["/proactive/types", { methods: { POST: ingress(async ({ config, request, json }) => {
    try {
      const body = await readJsonBody(request) as { type?: unknown; on?: unknown };
      if (typeof body.type !== "string" || typeof body.on !== "boolean") {
        json(400, { ok: false, error: "type and on (true or false) are required" });
        return;
      }
      const known = setProactiveType(config, body.type, body.on);
      json(known ? 200 : 404, known ? { ok: true, type: body.type, on: body.on } : { ok: false, error: "no_such_idea_type" });
    } catch (error) {
      json(500, { ok: false, error: errorMessage(error) });
    }
  }) } }],
  ["/memory/held/decide", { methods: { POST: ingress(async ({ runtime, request, json }) => {
    if (!runtime.memoryReflection) {
      json(409, { ok: false, error: "memory_reflection_disabled" });
      return;
    }
    try {
      const body = await readJsonBody(request) as { id?: unknown; verdict?: unknown };
      if (typeof body.id !== "string" || !body.id.trim() || (body.verdict !== "keep" && body.verdict !== "bin")) {
        json(400, { ok: false, error: "id and verdict (keep or bin) are required" });
        return;
      }
      const outcome = await runtime.memoryReflection.decideHeld(body.id, body.verdict);
      json(outcome.kind === "ignored" ? 404 : 200, outcome.kind === "ignored"
        ? { ok: false, error: "no_held_memory" }
        : { ok: true, id: body.id, outcome: outcome.kind });
    } catch (error) {
      json(500, { ok: false, error: errorMessage(error) });
    }
  }) } }],
  ["/signin", {
    access: "ingress",
    methods: {
      GET: open(({ config, json }) => json(200, signInBody(config))),
      POST: open(({ config, json }) => {
        if (config.modelBackend !== "codex") {
          json(409, { ok: false, error: "Codex signs in here; Claude takes a token from `claude setup-token` in the settings." });
          return;
        }
        codexSignInFor(config).start();
        json(200, signInBody(config));
      }),
    },
  }],
  ["/settings/persona", {
    access: "ingress",
    methods: {
      GET: open(({ json }) => {
        try {
          json(200, { ...readPersonaForm(personalityFilePath()), canRestart: canRestartApp() });
        } catch (error) {
          json(500, { ok: false, error: errorMessage(error) });
        }
      }),
      POST: open(async ({ request, json }) => {
        try {
          json(200, { ...savePersonaForm(personalityFilePath(), await readJsonBody(request)), canRestart: canRestartApp() });
        } catch (error) {
          json(400, { ok: false, error: errorMessage(error) });
        }
      }),
    },
  }],
  ["/settings/app", {
    access: "ingress",
    methods: {
      GET: open(async ({ json }) => {
        try {
          json(200, await readAppOptionsForm());
        } catch (error) {
          json(503, { ok: false, error: errorMessage(error) });
        }
      }),
      POST: open(async ({ request, json }) => {
        try {
          json(200, await saveAppOptionsForm(await readJsonBody(request)));
        } catch (error) {
          json(400, { ok: false, error: errorMessage(error) });
        }
      }),
    },
  }],
  ["/settings/media-apps", {
    access: "ingress",
    methods: {
      GET: open(({ config, json }) => {
        json(200, readMediaAppsForm(mediaConfigFile(config)));
      }),
      POST: open(async ({ config, request, json }) => {
        try {
          json(200, saveMediaAppForm(mediaConfigFile(config), await readJsonBody(request)));
        } catch (error) {
          json(400, { ok: false, error: errorMessage(error) });
        }
      }),
    },
  }],
  ["/settings/voice-words", {
    access: "ingress",
    methods: {
      GET: open(({ json }) => {
        json(200, { ...readVoiceWordsForm(), canRestart: canRestartApp() });
      }),
      POST: open(async ({ request, json }) => {
        try {
          json(200, { ...saveVoiceWordsForm(await readJsonBody(request)), canRestart: canRestartApp() });
        } catch (error) {
          json(400, { ok: false, error: errorMessage(error) });
        }
      }),
    },
  }],
  ["/settings/people", {
    access: "ingress",
    methods: {
      GET: open(({ runtime, json }) => {
        try {
          json(200, { ...readPeopleForm(householdFilePath(), runtime.haPersons?.() ?? []), canRestart: canRestartApp() });
        } catch (error) {
          json(500, { ok: false, error: errorMessage(error) });
        }
      }),
      POST: open(async ({ runtime, request, json }) => {
        try {
          json(200, { ...savePeopleForm(householdFilePath(), await readJsonBody(request), runtime.haPersons?.() ?? []), canRestart: canRestartApp() });
        } catch (error) {
          json(400, { ok: false, error: errorMessage(error) });
        }
      }),
    },
  }],
  ["/setup", {
    access: "ingress",
    methods: {
      GET: open(({ config, runtime, json }) => {
        const signIn = signInBody(config);
        json(200, setupStatus({
          personalityFile: personalityFilePath(),
          householdFile: householdFilePath(),
          brainReady: signIn.backend === "off" || signIn.signedIn === true,
          agent: runtime.brainAgent?.() ?? null,
        }));
      }),
    },
  }],
  ["/house/discovery", {
    access: "ingress",
    unavailable: ({ runtime }) => runtime.houseDiscovery ? null : "house_discovery_unavailable",
    methods: {
      GET: open(({ runtime, json }) => {
        json(200, discoveryReply(runtime, runtime.houseDiscovery!.found()));
      }),
      POST: open(async ({ runtime, json }) => {
        try {
          json(200, discoveryReply(runtime, await runtime.houseDiscovery!.rescan()));
        } catch (error) {
          json(502, { ok: false, error: errorMessage(error) });
        }
      }),
    },
  }],
  ["/house/choices", {
    access: "ingress",
    unavailable: ({ runtime }) => runtime.houseDiscovery ? null : "house_discovery_unavailable",
    methods: {
      POST: open(async ({ runtime, request, json }) => {
        try {
          json(200, discoveryReply(runtime, await runtime.houseDiscovery!.save(await readJsonBody(request))));
        } catch (error) {
          json(400, { ok: false, error: errorMessage(error) });
        }
      }),
    },
  }],
  ["/voice-training", {
    access: "ingress",
    unavailable: ({ runtime }) => runtime.voiceTraining ? null : "voice_training_unavailable",
    methods: {
      GET: open(async ({ runtime, json }) => {
        const training = runtime.voiceTraining!;
        try {
          json(200, { ok: true, satellites: training.satellites(), status: await training.status() });
        } catch (error) {
          json(200, { ok: true, satellites: training.satellites(), status: { state: "unavailable", message: errorMessage(error) } });
        }
      }),
    },
  }],
  ["/voice-training/start", {
    access: "ingress",
    unavailable: ({ runtime }) => runtime.voiceTraining ? null : "voice_training_unavailable",
    methods: {
      POST: open(async ({ runtime, request, json }) => {
        try {
          const body = await readJsonBody(request) as { person_id?: unknown; satellite?: unknown };
          if (typeof body.person_id !== "string" || typeof body.satellite !== "string") throw new Error("person_id and satellite are required");
          json(200, { ok: true, status: await runtime.voiceTraining!.start(body.person_id, body.satellite) });
        } catch (error) {
          json(400, { ok: false, error: errorMessage(error) });
        }
      }),
    },
  }],
  ["/voice-training/cancel", {
    access: "ingress",
    unavailable: ({ runtime }) => runtime.voiceTraining ? null : "voice_training_unavailable",
    methods: {
      POST: open(async ({ runtime, json }) => {
        try {
          json(200, { ok: true, status: await runtime.voiceTraining!.cancel() });
        } catch (error) {
          json(400, { ok: false, error: errorMessage(error) });
        }
      }),
    },
  }],
  ["/system/restart", {
    access: "ingress",
    methods: {
      POST: open(({ json }) => {
        if (!canRestartApp()) {
          json(409, { ok: false, error: "Not running as a Home Assistant app: restart it by hand." });
          return;
        }
        json(202, { ok: true });
        restartAppSoon();
      }),
    },
  }],
  ["/settings/names", {
    access: "ingress",
    unavailable: ({ runtime }) => runtime.dashboardNames ? null : "names_unavailable",
    methods: {
      GET: open(({ runtime, json }) => json(200, runtime.dashboardNames?.read())),
      POST: open(async ({ runtime, request, json }) => {
        try {
          json(200, runtime.dashboardNames?.apply(await readJsonBody(request)));
        } catch (error) {
          json(400, { ok: false, error: errorMessage(error) });
        }
      }),
    },
  }],
  ["/settings", {
    access: "ingress",
    unavailable: settingsUnavailable,
    methods: {
      GET: open((context) => context.json(200, settingsBody(context))),
      POST: open(async (context) => {
        try {
          const body = await readJsonBody(context.request);
          try {
            const key = applyDashboardSetting(context.runtime.liveSettings!.store, body);
            context.json(200, { ...settingsBody(context), saved: key });
          } catch (error) {
            context.json(400, { ok: false, error: errorMessage(error) });
          }
        } catch (error) {
          context.json(400, { ok: false, error: errorMessage(error) });
        }
      }),
    },
  }],
  ["/settings/helper", {
    access: "ingress",
    unavailable: settingsUnavailable,
    methods: {
      POST: open(async (context) => {
        let body: unknown;
        try {
          body = await readJsonBody(context.request);
        } catch (error) {
          context.json(400, { ok: false, error: errorMessage(error) });
          return;
        }
        const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
        if (!isJarvisHelperKey(record.helper)) {
          context.json(400, { ok: false, error: "helper must be proactive, silentFrom or silentUntil" });
          return;
        }
        if (!context.runtime.jarvisHelpers) {
          context.json(503, { ok: false, error: "Home Assistant is not connected" });
          return;
        }
        try {
          const outcome = await context.runtime.jarvisHelpers.set(record.helper, record.value);
          context.json(outcome.confirmed ? 200 : 504, outcome.confirmed
            ? { ...settingsBody(context), saved: record.helper }
            : { ok: false, error: "Home Assistant did not confirm the change" });
        } catch (error) {
          context.json(400, { ok: false, error: errorMessage(error) });
        }
      }),
    },
  }],
  ["/self-model/action", { methods: { POST: ingress(async ({ config, runtime, request, json }) => {
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      json(400, { ok: false, error: errorMessage(error) });
      return;
    }
    const action = body && typeof body === "object" ? (body as Record<string, unknown>).action : null;
    if (action === "growth_rollback" || action === "growth_retire_habit") {
      if (!runtime.selfGrowth) {
        json(503, { ok: false, error: "self_growth_unavailable" });
        return;
      }
      try {
        const id = (body as Record<string, unknown>).id;
        if (!Number.isInteger(id)) throw new Error("id must be an integer");
        if (action === "growth_rollback") runtime.selfGrowth.rollbackTo(id as number);
        else runtime.selfGrowth.retireHabit(id as number);
        // His account rides the Claude launch shape; warm the new one before the next turn.
        prewarmClaudeStream(config);
        void prewarmClaudeToolStream(config);
        json(200, runtime.selfGrowth.dashboard(config.selfGrowthEnabled));
      } catch (error) {
        json(400, { ok: false, error: errorMessage(error) });
      }
      return;
    }
    if (!runtime.selfModel) {
      json(503, { ok: false, error: "self_model_unavailable" });
      return;
    }
    try {
      json(200, runtime.selfModel.applyOperatorAction(body));
    } catch (error) {
      json(400, { ok: false, error: errorMessage(error) });
    }
  }) } }],
  ["/memory/review/next", { methods: { GET: ingress(({ config, json }) => json(200, cognitiveFeatureEnabled(config, "recall")
    ? nextMemoryReviewResponse(config)
    : disabledMemoryReviewResponse())) } }],
  ["/memory/review/decision", { methods: { POST: ingress(async ({ config, runtime, request, json }) => {
    if (!cognitiveFeatureEnabled(config, "recall")) {
      json(409, { ok: false, error: config.cognitiveSystemEnabled ? "cognitive_recall_disabled" : "cognitive_system_disabled" });
      return;
    }
    try {
      json(200, applyMemoryReviewDecision(config, await readJsonBody(request), runtime.now?.() ?? new Date()));
    } catch (error) {
      json(400, { ok: false, error: errorMessage(error) });
    }
  }) } }],
  ["/memory/remove", { methods: { POST: ingress(async ({ config, runtime, request, json }) => {
    try {
      json(200, applyAcceptedMemoryRemoval(config, await readJsonBody(request), runtime.now?.() ?? new Date()));
    } catch (error) {
      json(400, { ok: false, error: errorMessage(error) });
    }
  }) } }],
  ["/voice/tail/:id", {
    methods: {
      GET: transport(({ runtime, tailId, json }) => {
        if (!tailId) return json(400, { ok: false, error: "bad_tail_id" });
        const tail = runtime.personalityTailStore.get(tailId);
        return tail ? json(200, { ok: true, tail }) : json(404, { ok: false, error: "tail_not_found" });
      }),
      DELETE: transport(({ runtime, tailId, json }) => {
        if (!tailId) return json(400, { ok: false, error: "bad_tail_id" });
        const tail = runtime.personalityTailStore.cancel?.(tailId, "tail_client_cancelled") ?? null;
        return tail ? json(200, { ok: true, tail }) : json(404, { ok: false, error: "tail_not_found" });
      }),
    },
  }],
  ["/voice/brain/stream", { methods: { POST: transport(streamVoiceTurn) } }],
  ["/voice/brain", { methods: { POST: answerTurn } }],
  ["/chat", { methods: { POST: answerTurn } }],
]);

async function routeRequest(
  config: AppConfig,
  runtime: ServedRuntime,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "OPTIONS") {
    writeEmpty(response, 204);
    return;
  }
  const tailMatch = TAIL_PATH.exec(url.pathname);
  const entry = ROUTES.get(tailMatch ? "/voice/tail/:id" : url.pathname);
  let trust: VoiceRequestTransportTrust | null | undefined;
  const context: RouteContext = {
    config,
    runtime,
    request,
    response,
    url,
    tailId: tailMatch ? safeDecodeURIComponent(tailMatch[1] ?? "") : "",
    trust: () => trust === undefined ? (trust = requestTransportTrust(config, runtime, request)) : trust,
    json: (statusCode, payload) => writeJson(response, statusCode, payload),
  };
  if (entry?.access && !permitted(entry.access, context)) {
    context.json(403, { ok: false, error: "trusted_identity_required" });
    return;
  }
  const unavailable = entry?.unavailable?.(context);
  if (unavailable) {
    context.json(503, { ok: false, error: unavailable });
    return;
  }
  const route = entry && Object.hasOwn(entry.methods, request.method ?? "")
    ? entry.methods[request.method as Method]
    : undefined;
  if (!route) {
    context.json(404, { ok: false, error: "not_found" });
    return;
  }
  if (!permitted(route.access, context)) {
    context.json(403, { ok: false, error: "trusted_identity_required" });
    return;
  }
  await route.run(context);
}

/**
 * One of the page's own actions for its Chat tab: the route runs as it does for the page,
 * as the Chat tab's person through Home Assistant's login, with the same checks and log lines.
 */
async function runPageAction(
  config: AppConfig,
  runtime: ServedRuntime,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  actorId: string,
): Promise<PageReply> {
  const entry = ROUTES.get(path);
  const route = entry?.methods[method];
  const access = entry?.access ?? route?.access;
  if (!entry || !route || !(access === "ingress" || (access === "open" && method === "GET"))) return { status: 404, body: { ok: false, error: "not a page action" } };
  let reply: PageReply | null = null;
  const context: RouteContext = {
    config,
    runtime,
    request: Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage,
    response: null as unknown as ServerResponse,
    url: new URL(path, "http://localhost"),
    tailId: "",
    trust: () => ({ actorId, source: "ha_ingress" }),
    json: (status, payload) => { reply = { status, body: payload }; },
  };
  const unavailable = entry.unavailable?.(context);
  if (unavailable) return { status: 503, body: { ok: false, error: unavailable } };
  await route.run(context);
  return reply ?? { status: 500, body: { ok: false, error: "the page gave no reply" } };
}

/** The brain's own config.json (media apps), as the app names it. */
function mediaConfigFile(config: Pick<AppConfig, "dataDir">): string {
  return process.env.JARVIS_V5_CONFIG_FILE?.trim() || join(config.dataDir, "config.json");
}

/** The House panel: what was found, the house's picks, and what it may pick from. */
function discoveryReply(runtime: AppRuntime, found: DiscoveredHouse | null) {
  return houseDiscoveryBody(found, { choices: readHouseChoices(), options: runtime.houseDiscovery!.options() });
}

function permitted(access: Access, context: RouteContext): boolean {
  return access === "open"
    || (access === "ingress" ? context.trust()?.source === "ha_ingress" : context.trust() !== null);
}

function settingsBody({ runtime }: RouteContext) {
  return buildDashboardSettings({ ...runtime.liveSettings!, helpers: runtime.jarvisHelpers ?? null });
}

/** POST /voice/brain/stream: one ordered NDJSON stream of committed speech, then the final response. */
async function streamVoiceTurn({ config, runtime, request, response, trust }: RouteContext): Promise<void> {
  const controller = new AbortController();
  let terminalWritten = false;
  let emittedCount = 0;
  const abort = () => {
    if (!terminalWritten) {
      controller.abort(new Error("Progressive voice client disconnected"));
    }
  };
  request.once("aborted", abort);
  response.once("close", abort);
  try {
    const brainRequest = parseVoiceBrainRequest(await readJsonBody(request), trust());
    response.statusCode = 200;
    response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "close");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders();
    const streamId = randomUUID();
    writeNdjson(response, {
      event: "start",
      protocol: 1,
      stream_id: streamId,
      max_words: 100,
    });
    const progressive = new ProgressiveSpeechSession({
      signal: controller.signal,
      maxWords: 100,
      onSegment: (segment) => {
        writeNdjson(response, {
          event: "speech",
          stream_id: streamId,
          seq: segment.sequence,
          text: segment.text,
          fish_text: formatForSpeech(segment.markup ?? segment.text),
          kind: segment.kind,
          commit_policy: segment.commitPolicy,
          ...(config.speechToneEnabled ? { tone: segment.tone ?? "neutral" } : {}),
          source: segment.source,
        });
        emittedCount += 1;
      },
    });
    const result = await runtime.voiceBrainHandler({
      ...brainRequest,
      progressive,
    });
    // A holding line ("Let me check.") is a bridge, not the answer: the final
    // text still has to be spoken after it.
    const answered = (): boolean => progressive.snapshot().some((segment) => segment.kind !== "bridge");
    if (!answered() && result.speech.text.trim()) {
      emitProgressiveText(progressive, result.speech.text, {
        kind: result.ok ? "answer" : "fallback",
        commitPolicy: "final_verified",
        ...(result.speech.tone ? { tone: result.speech.tone } : {}),
        source: {
          kind: "software",
          label: result.ok ? result.route.route : "voice error",
        },
      });
    }
    if (!answered() && result.speech.text.trim()) {
      throw new Error("Final voice response could not be committed as complete progressive speech");
    }
    if (controller.signal.aborted) {
      return;
    }
    writeNdjson(response, {
      event: "final",
      stream_id: streamId,
      response: result,
      spoken_text: progressive.combinedText(),
      segment_count: progressive.snapshot().length,
    });
    terminalWritten = true;
    response.end();
  } catch (error) {
    if (controller.signal.aborted || response.destroyed) {
      return;
    }
    if (!response.headersSent) {
      writeJson(response, 400, buildVoiceBrainErrorResponse("bad_request", errorMessage(error)));
    } else {
      writeNdjson(response, {
        event: "error",
        code: "progressive_turn_failed",
        message: errorMessage(error),
        fallback_allowed: emittedCount === 0,
      });
      terminalWritten = true;
      response.end();
    }
  } finally {
    request.removeListener("aborted", abort);
    response.removeListener("close", abort);
  }
}

function requestTransportTrust(
  config: AppConfig,
  runtime: AppRuntime,
  request: IncomingMessage,
): VoiceRequestTransportTrust | null {
  return runtime.transportTrustResolver?.(request)
    ?? resolveVoiceRequestTransportTrust(config, {
      remoteAddress: request.socket.remoteAddress,
      headers: request.headers,
    });
}

function buildDashboardResponse(
  config: AppConfig,
  runtime: AppRuntime,
  url: URL,
): DashboardResponse {
  const now = runtime.now?.() ?? new Date();
  const targetPresencePersonId = runtime.routes?.aliases
    ? proactivePresencePersonId(config.cognitiveOperatorActorId, runtime.routes.aliases)
    : null;
  return {
    ok: true,
    service: "housemate-brain",
    version: runtime.version,
    startedAt: runtime.startedAt.toISOString(),
    generatedAt: now.toISOString(),
    readiness: runtimeReadiness(config),
    cognition: cognitiveControlState(config),
    report: buildLocalReport(config, now, {
      includeMemory: cognitiveFeatureEnabled(config, "recall"),
    }),
    proactive: buildProactiveDashboardSummary(config, {
      now,
      ...(runtime.routes?.houseState ? { houseState: runtime.routes.houseState } : {}),
      ...(targetPresencePersonId ? { targetPresencePersonId } : {}),
    }),
    review: cognitiveFeatureEnabled(config, "recall")
      ? nextMemoryReviewResponse(config)
      : disabledMemoryReviewResponse(),
    recentTurns: readRecentTurns(config, queryLimit(url, "turns", 8, 24)),
    tastes: runtime.selfModel?.dashboardTastes() ?? null,
    growth: runtime.selfGrowth?.dashboard(config.selfGrowthEnabled) ?? null,
    storedMemories: cognitiveFeatureEnabled(config, "recall")
      ? { enabled: true, items: storedMemoryItems(config) }
      : { enabled: false, items: [] },
    corrections: correctionDashboardSummary(
      correctionLedgerPath(config),
      config.cognitiveSystemEnabled && config.correctionsLedgerEnabled,
      queryLimit(url, "corrections", 10, 50),
    ),
    proactiveReview: proactiveReviewSummary(config),
    heldMemories: runtime.memoryReflection
      ? { enabled: true, items: runtime.memoryReflection.heldForReview() }
      : { enabled: false, items: [] },
  };
}

function defaultRuntime(): AppRuntime {
  return {
    version: appVersion(),
    startedAt: new Date(),
  };
}

function readRecentTurns(config: Pick<AppConfig, "dataDir">, limit: number): readonly TurnLogEntry[] {
  return readTurnLogEntries(turnLogPath(config)).slice(-limit).reverse();
}

function queryLimit(url: URL, key: string, fallback: number, max: number): number {
  const raw = Number.parseInt(url.searchParams.get(key) ?? "", 10);
  if (!Number.isFinite(raw) || raw < 1) {
    return fallback;
  }
  return Math.min(raw, max);
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    ...corsHeaders(),
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function writeNdjson(response: ServerResponse, payload: unknown): void {
  if (response.destroyed || response.writableEnded) {
    throw new Error("Progressive voice response is closed");
  }
  const line = `${JSON.stringify(payload)}\n`;
  if (Buffer.byteLength(line, "utf8") > 1024 * 1024) {
    throw new Error("Progressive voice event exceeded its byte limit");
  }
  response.write(line);
}

function writeHtml(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    ...corsHeaders(),
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function writeEmpty(response: ServerResponse, statusCode: number): void {
  response.writeHead(statusCode, corsHeaders());
  response.end();
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return JSON.parse(await readRequestBody(request)) as unknown;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

let codexSignIn: CodexSignIn | null = null;

function codexSignInFor(config: AppConfig): CodexSignIn {
  codexSignIn ??= new CodexSignIn(config.codexHome);
  return codexSignIn;
}

/** The brain's sign-in for the page: which backend, whether it is signed in, and a Codex device sign-in in progress. */
function signInBody(config: AppConfig): Record<string, unknown> {
  const signedIn = config.modelBackend === "codex" ? config.hasCodexAuth : config.hasClaudeAuth;
  return {
    ok: true,
    backend: config.modelEnabled ? config.modelBackend : "off",
    signedIn,
    codex: config.modelBackend === "codex" ? codexSignInFor(config).current() : null,
  };
}
