import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { appVersion } from "./app-version.js";
import { loadConfig } from "./config.js";
import { buildLocalReport } from "./report.js";
import { createApp } from "./server.js";
import { InMemoryPersonalityTailStore } from "./personality-tail.js";
import { buildVoiceBrainResponse, type VoiceBrainHandler } from "./voice-brain.js";

interface ProbeResult {
  readonly name: string;
  readonly ok: boolean;
  readonly status: number;
  readonly route?: string;
}

const probePort = process.env.JARVIS_V5_PROBE_PORT ?? process.env.JARVIS_V5_PORT ?? "3015";
const probeHost = process.env.JARVIS_V5_PROBE_HOST ?? "127.0.0.1";
const probeToken = "jarvis-v5-local-probe-token";
const dataDir = mkdtempSync(join(tmpdir(), "jarvis-v5-probe-"));
const config = loadConfig({
  ...process.env,
  JARVIS_V5_PORT: probePort,
  JARVIS_V5_DATA_DIR: dataDir,
  JARVIS_V5_MODEL_ENABLED: "false",
  JARVIS_V5_COGNITIVE_API_TOKEN: probeToken,
});
const startedAt = new Date();
const tailStore = new InMemoryPersonalityTailStore();
const server = createApp(config, {
  version: appVersion(),
  startedAt,
  now: () => new Date("2026-05-03T16:30:00.000Z"),
  voiceBrainHandler: fixtureBrainHandler(),
  personalityTailStore: tailStore,
});

try {
  const baseUrl = await listen(server);
  if (process.env.JARVIS_V5_PROBE_SERVE === "true") {
    console.log(JSON.stringify({
      ok: true,
      baseUrl,
      serving: true,
    }, null, 2));
    await waitForSignal();
  } else {
  const results = [
    await getJson(`${baseUrl}/health`, "health"),
    await getJson(`${baseUrl}/status`, "status"),
    await postJson(`${baseUrl}/voice/brain`, "voice-brain", {
      utterance: "system health",
      room: "office",
      channel: "test",
    }),
    await postJson(`${baseUrl}/chat`, "chat", {
      utterance: "confirm turn on the office lights",
      room: "office",
      channel: "test",
    }),
    await postJson(`${baseUrl}/voice/brain`, "voice-tail-lead", {
      utterance: "tail probe",
      room: "office",
      channel: "test",
    }),
  ];
  const tailResult = await pollTail(`${baseUrl}/voice/tail/probe-tail-turn`, probeToken);
  results.push(tailResult);
  const report = buildLocalReport(config, new Date("2026-05-03T16:30:00.000Z"));
  const failed = results.filter((result) => !result.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    baseUrl,
    results,
    report: {
      generatedAt: report.generatedAt,
      latency: report.latency,
    },
  }, null, 2));
  if (failed.length > 0) {
    process.exitCode = 1;
  }
  }
} finally {
  await close(server);
  rmSync(dataDir, { recursive: true, force: true });
}

function fixtureBrainHandler(): VoiceBrainHandler {
  return (request) => {
    if (request.transcript.toLowerCase().includes("tail probe")) {
      tailStore.start("probe-tail-turn", "The office is 20.2 C.", Promise.resolve({
        schemaVersion: 1,
        status: "ready",
        text: "Bit fresh, but manageable.",
        fishText: "Bit fresh, but manageable.",
        fishTags: [],
        reason: null,
        latencyMs: 42,
        modelUsed: false,
      }));
      return buildVoiceBrainResponse({
        text: "The office is 20.2 C.",
        session: "close",
        route: {
          route: "entity_status",
          confidence: "high",
          status: "ok",
          resultId: "probe-tail-result",
          turnId: "probe-tail-turn",
        },
        tail: {
          turn_id: "probe-tail-turn",
          status: "pending",
          poll_path: "/voice/tail/probe-tail-turn",
        },
      });
    }
    const action = request.transcript.toLowerCase().includes("turn on") ? "entity_action" : "system_health";
    const status = action === "entity_action" ? "declined" : "ok";
    return buildVoiceBrainResponse({
      text: action === "entity_action" ? "Dry run only. No device was touched." : "The fixture brain is responding.",
      fishText: action === "entity_action" ? "[calm] Dry run only. No device was touched." : "[calm] The fixture brain is responding.",
      session: "close",
      route: {
        route: action,
        confidence: "high",
        status,
        resultId: `probe-${action}`,
        turnId: `probe-${action}`,
      },
    });
  };
}

async function pollTail(url: string, token: string): Promise<ProbeResult> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(url, {
      headers: { "x-jarvis-token": token },
    });
    const payload = await response.json() as { readonly ok?: unknown; readonly tail?: { readonly status?: unknown; readonly text?: unknown } };
    const status = typeof payload.tail?.status === "string" ? payload.tail.status : "";
    if (response.ok && payload.ok === true && status !== "pending") {
      return {
        name: "voice-tail",
        ok: status === "ready" && payload.tail?.text === "Bit fresh, but manageable.",
        status: response.status,
        route: status,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return {
    name: "voice-tail",
    ok: false,
    status: 408,
    route: "timeout",
  };
}

async function listen(target: typeof server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    target.once("error", reject);
    target.listen(config.port, probeHost, () => resolve());
  });
  const address = target.address() as AddressInfo;
  const host = address.address === "0.0.0.0" || address.address === "::" ? "127.0.0.1" : address.address;
  return `http://${host}:${address.port}`;
}

async function close(target: typeof server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    target.close((error) => error ? reject(error) : resolve());
  });
}

async function waitForSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
}

async function getJson(url: string, name: string): Promise<ProbeResult> {
  const response = await fetch(url);
  const body = await response.json() as Record<string, unknown>;
  return {
    name,
    ok: response.ok && body.ok === true,
    status: response.status,
  };
}

async function postJson(url: string, name: string, body: Record<string, unknown>): Promise<ProbeResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as { readonly ok?: unknown; readonly route?: { readonly route?: unknown } };
  const route = typeof payload.route?.route === "string" ? payload.route.route : null;
  return {
    name,
    ok: response.ok && payload.ok === true,
    status: response.status,
    ...(route ? { route } : {}),
  };
}
