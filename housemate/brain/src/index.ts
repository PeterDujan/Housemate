import { appVersion } from "./app-version.js";
import { hasReadableCodexAuth, loadConfig } from "./config.js";
import { codexLoginWithApiKey } from "./sign-in.js";
import { loadHousehold } from "./household.js";
import { stopChatToolBridge } from "./chat-tool-bridge.js";
import { stopClaudeStreams } from "./claude-stream.js";
import { stopCodexAppServers } from "./codex-app-server.js";
import { createLaunchRuntime } from "./launch-runtime.js";
import { LiveSettingsStore, liveSettingsPath, withLiveSettings } from "./live-settings.js";
import { createApp } from "./server.js";

// Who lives here comes from <dataDir>/household.json; config reads the owner from it.
const household = loadHousehold(process.env.JARVIS_V5_DATA_DIR?.trim() || "/share/jarvis-v5");
console.log(`[brain] household: ${household.people.length} people`);
const bootConfig = loadConfig();
// Dashboard settings win over the add-on options, live, without a restart.
const settings = new LiveSettingsStore({ filePath: liveSettingsPath(bootConfig) });
const config = withLiveSettings(bootConfig, settings);
// The house's own OpenAI API key signs Codex in once, when no sign-in is there yet.
if (config.modelBackend === "codex" && config.openaiApiKey && !hasReadableCodexAuth(config.codexHome)) {
  void codexLoginWithApiKey(config.codexHome, config.openaiApiKey).then((ok) => {
    console.log(`[brain] codex api key sign-in ${ok ? "done" : "failed"}`);
  });
}
const server = createApp(config, createLaunchRuntime(config, {
  version: appVersion(),
  startedAt: new Date(),
  settings,
  settingsDefaults: bootConfig,
}));

server.listen(config.port, () => {
  console.log(`[brain] listening on ${config.port}`);
});

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[brain] ${signal} received; shutting down`);
  stopCodexAppServers();
  stopClaudeStreams();
  stopChatToolBridge();
  server.close(() => process.exit(0));
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
};

server.once("close", () => {
  stopCodexAppServers();
  stopClaudeStreams();
  stopChatToolBridge();
});
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
