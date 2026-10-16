import { readFileSync } from "node:fs";
import { errorMessage } from "./value-guards.js";
import { householdOwnerId } from "./household.js";

export interface AppConfig {
  readonly port: number;
  readonly dataDir: string;
  /** The owner's projects folder, read-only, for the project chat tools. */
  readonly projectsDir: string;
  /** Where agents leave questions for the household; empty means the data folder's own. */
  readonly questionsDir: string;
  readonly haUrl: string;
  readonly plexUrl: string;
  readonly plexToken: string | null;
  readonly radarrUrl: string;
  readonly radarrApiKey: string | null;
  readonly sonarrUrl: string;
  readonly sonarrApiKey: string | null;
  readonly seerrUrl: string;
  readonly seerrApiKey: string | null;
  readonly backgroundWatchersEnabled: boolean;
  readonly modelBackend: ModelBackend;
  readonly model: string;
  readonly claudeHome: string;
  readonly claudeCredentialsPath: string;
  readonly claudeTimeoutMs: number;
  readonly claudeChatEffort: ClaudeChatEffort;
  readonly codexHome: string;
  readonly codexWorkingDirectory: string;
  readonly codexTimeoutMs: number;
  readonly monthlyBudgetUsd: number;
  readonly modelEnabled: boolean;
  readonly modelInputCostPerMillionUsd: number;
  readonly modelOutputCostPerMillionUsd: number;
  readonly aliasFilePath: string;
  readonly memoryCardsEnabled: boolean;
  readonly cognitiveSystemEnabled: boolean;
  readonly cognitiveLearningEnabled: boolean;
  readonly cognitiveRecallEnabled: boolean;
  readonly cognitiveProactiveEnabled: boolean;
  readonly cognitiveIngressUserId: string | null;
  readonly cognitiveApiToken: string | null;
  readonly cognitiveOperatorActorId: string;
  readonly memoryReflectionEnabled: boolean;
  readonly memoryRecallEnabled: boolean;
  readonly memoryArchiveEnabled: boolean;
  readonly speechToneEnabled: boolean;
  readonly selfGrowthEnabled: boolean;
  readonly correctionsLedgerEnabled: boolean;
  readonly correctionAskEnabled: boolean;
  readonly deviceControlEnabled: boolean;
  readonly chatToolsEnabled: boolean;
  readonly chatWebSearchEnabled: boolean;
  readonly householdRoster: string;
  readonly memoryApprovalNotifyService: string;
  readonly claudeAuthToken: string | null;
  /** The house's own Anthropic API key, when it uses one instead of a Claude sign-in. */
  readonly claudeApiKey: string | null;
  /** The house's own OpenAI API key for Codex, when it uses one instead of a ChatGPT sign-in. */
  readonly openaiApiKey: string | null;
  readonly homeAssistantToken: string | null;
  readonly hasClaudeAuth: boolean;
  readonly hasHomeAssistantToken: boolean;
  readonly hasCodexAuth: boolean;
}

export type ModelBackend = "codex" | "claude";

/** Claude Code `--effort` for spoken open chat and general knowledge; `default` passes no flag. */
export type ClaudeChatEffort = "default" | "low" | "medium" | "high";

export interface SafeConfigSummary {
  readonly values: OperatorConfigValues;
  readonly credentials: OperatorCredentialSummary;
}

export interface OperatorConfigValues {
  readonly port: number;
  readonly dataDir: string;
  readonly haUrl: string;
  readonly backgroundWatchersEnabled: boolean;
  readonly modelBackend: ModelBackend;
  readonly model: string;
  readonly claudeHome: string;
  readonly claudeCredentialsPath: string;
  readonly claudeTimeoutMs: number;
  readonly claudeChatEffort: ClaudeChatEffort;
  readonly codexHome: string;
  readonly codexWorkingDirectory: string;
  readonly codexTimeoutMs: number;
  readonly monthlyBudgetUsd: number;
  readonly modelEnabled: boolean;
  readonly modelInputCostPerMillionUsd: number;
  readonly modelOutputCostPerMillionUsd: number;
  readonly aliasFilePath: string;
  readonly memoryCardsEnabled: boolean;
  readonly cognitiveSystemEnabled: boolean;
  readonly cognitiveLearningEnabled: boolean;
  readonly cognitiveRecallEnabled: boolean;
  readonly cognitiveProactiveEnabled: boolean;
  readonly cognitiveIngressIdentityConfigured: boolean;
  readonly cognitiveApiIdentityConfigured: boolean;
  readonly cognitiveOperatorActorId: string;
  readonly memoryReflectionEnabled: boolean;
  readonly memoryRecallEnabled: boolean;
  readonly memoryArchiveEnabled: boolean;
  readonly speechToneEnabled: boolean;
  readonly selfGrowthEnabled: boolean;
  readonly correctionsLedgerEnabled: boolean;
  readonly correctionAskEnabled: boolean;
  readonly deviceControlEnabled: boolean;
  readonly chatToolsEnabled: boolean;
  readonly chatWebSearchEnabled: boolean;
  readonly memoryApprovalNotifyService: string;
}

export interface OperatorCredentialSummary {
  readonly claudeConfigured: boolean;
  readonly homeAssistantConfigured: boolean;
  readonly codexConfigured: boolean;
}

export interface RuntimeReadiness {
  readonly claudeConfigured: boolean;
  readonly homeAssistantConfigured: boolean;
  readonly codexConfigured: boolean;
  readonly modelRenderAvailable: boolean;
}

export interface ConfigLoadOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly runtimeFilePath?: string | null;
}

type RuntimeConfigKey =
  | "dataDir"
  | "projectsDir"
  | "questionsDir"
  | "haUrl"
  | "plexUrl"
  | "plexToken"
  | "radarrUrl"
  | "radarrApiKey"
  | "sonarrUrl"
  | "sonarrApiKey"
  | "seerrUrl"
  | "seerrApiKey"
  | "backgroundWatchersEnabled"
  | "homeAssistantToken"
  | "modelBackend"
  | "model"
  | "claudeHome"
  | "claudeAuthToken"
  | "claudeApiKey"
  | "openaiApiKey"
  | "claudeCredentialsPath"
  | "claudeTimeoutMs"
  | "claudeChatEffort"
  | "codexHome"
  | "codexWorkingDirectory"
  | "codexTimeoutMs"
  | "modelEnabled"
  | "modelInputCostPerMillionUsd"
  | "modelOutputCostPerMillionUsd"
  | "monthlyBudgetUsd"
  | "port"
  | "aliasFilePath"
  | "memoryCardsEnabled"
  | "cognitiveSystemEnabled"
  | "cognitiveLearningEnabled"
  | "cognitiveRecallEnabled"
  | "cognitiveProactiveEnabled"
  | "cognitiveIngressUserId"
  | "cognitiveApiToken"
  | "cognitiveOperatorActorId"
  | "memoryReflectionEnabled"
  | "memoryRecallEnabled"
  | "memoryArchiveEnabled"
  | "speechToneEnabled"
  | "selfGrowthEnabled"
  | "correctionsLedgerEnabled"
  | "correctionAskEnabled"
  | "deviceControlEnabled"
  | "chatToolsEnabled"
  | "chatWebSearchEnabled"
  | "householdRoster"
  | "memoryApprovalNotifyService";

type RuntimeConfigFile = Partial<Record<RuntimeConfigKey, unknown>>;

export const CONFIG_DEFAULTS = {
  port: 3005,
  dataDir: "/share/jarvis-v5",
  projectsDir: "",
  questionsDir: "",
  haUrl: "ws://homeassistant.local:8123",
  // No media app by default: the house's own config.json names one, else its Home Assistant integration does.
  plexUrl: "",
  radarrUrl: "",
  sonarrUrl: "",
  seerrUrl: "",
  backgroundWatchersEnabled: true,
  modelBackend: "claude",
  model: "claude-sonnet-5",
  claudeHome: "/share/jarvis-v5/claude-home",
  claudeCredentialsPath: "",
  claudeTimeoutMs: 45000,
  claudeChatEffort: "default",
  codexHome: "/share/jarvis-v5/codex-home",
  codexWorkingDirectory: "/app",
  codexTimeoutMs: 45000,
  monthlyBudgetUsd: 7.5,
  modelInputCostPerMillionUsd: 0,
  modelOutputCostPerMillionUsd: 0,
  aliasFilePath: "/share/jarvis-v5/aliases.json",
  memoryCardsEnabled: true,
  cognitiveSystemEnabled: true,
  cognitiveLearningEnabled: false,
  cognitiveRecallEnabled: true,
  cognitiveProactiveEnabled: false,
  cognitiveOperatorActorId: "",
  memoryReflectionEnabled: false,
  memoryRecallEnabled: false,
  // The permanent tier is the off switch only: it also needs recall on and a trusted household speaker.
  memoryArchiveEnabled: true,
  // Code-picked spoken tone on every segment; off omits the field.
  speechToneEnabled: true,
  // His self-account is rewritten each night from the household's chats; off is SELF.md as written.
  selfGrowthEnabled: false,
  // Code writes each correction and the answer it corrects to a small ledger.
  correctionsLedgerEnabled: true,
  // On a bare correction or a repeat of a corrected question, code asks what was meant.
  correctionAskEnabled: true,
  // The assistant may switch what is on the owner's voice list (exposed to Assist) for a real household client.
  deviceControlEnabled: true,
  chatToolsEnabled: false,
  chatWebSearchEnabled: false,
  householdRoster: "",
  memoryApprovalNotifyService: "",
} as const;

type ConfigFieldKind = "boolean" | "enum" | "integer" | "nonEmptyString" | "nonNegativeNumber" | "positiveNumber" | "secret" | "url";

interface ConfigFieldDefinition {
  readonly key: keyof AppConfig;
  readonly envName: string;
  readonly runtimeName: RuntimeConfigKey;
  readonly kind: ConfigFieldKind;
  readonly defaultValue?: string | number | boolean;
  readonly min?: number;
  readonly max?: number;
  readonly enumValues?: readonly string[];
  readonly secret?: boolean;
  readonly safeSummary: "value" | "presence" | "hidden";
}

export const CONFIG_SCHEMA: readonly ConfigFieldDefinition[] = [
  {
    key: "port",
    envName: "JARVIS_V5_PORT",
    runtimeName: "port",
    kind: "integer",
    defaultValue: CONFIG_DEFAULTS.port,
    min: 1,
    max: 65535,
    safeSummary: "value",
  },
  {
    key: "dataDir",
    envName: "JARVIS_V5_DATA_DIR",
    runtimeName: "dataDir",
    kind: "nonEmptyString",
    defaultValue: CONFIG_DEFAULTS.dataDir,
    safeSummary: "value",
  },
  {
    key: "projectsDir",
    envName: "JARVIS_V5_PROJECTS_DIR",
    runtimeName: "projectsDir",
    kind: "nonEmptyString",
    defaultValue: CONFIG_DEFAULTS.projectsDir,
    safeSummary: "value",
  },
  {
    key: "questionsDir",
    envName: "JARVIS_V5_QUESTIONS_DIR",
    runtimeName: "questionsDir",
    kind: "nonEmptyString",
    defaultValue: CONFIG_DEFAULTS.questionsDir,
    safeSummary: "value",
  },
  {
    key: "haUrl",
    envName: "HA_URL",
    runtimeName: "haUrl",
    kind: "url",
    defaultValue: CONFIG_DEFAULTS.haUrl,
    safeSummary: "value",
  },
  {
    key: "plexUrl",
    envName: "JARVIS_V5_PLEX_URL",
    runtimeName: "plexUrl",
    kind: "url",
    defaultValue: CONFIG_DEFAULTS.plexUrl,
    safeSummary: "hidden",
  },
  {
    key: "plexToken",
    envName: "JARVIS_V5_PLEX_TOKEN",
    runtimeName: "plexToken",
    kind: "secret",
    secret: true,
    safeSummary: "hidden",
  },
  {
    key: "radarrUrl",
    envName: "JARVIS_V5_RADARR_URL",
    runtimeName: "radarrUrl",
    kind: "url",
    defaultValue: CONFIG_DEFAULTS.radarrUrl,
    safeSummary: "hidden",
  },
  {
    key: "radarrApiKey",
    envName: "JARVIS_V5_RADARR_API_KEY",
    runtimeName: "radarrApiKey",
    kind: "secret",
    secret: true,
    safeSummary: "hidden",
  },
  {
    key: "sonarrUrl",
    envName: "JARVIS_V5_SONARR_URL",
    runtimeName: "sonarrUrl",
    kind: "url",
    defaultValue: CONFIG_DEFAULTS.sonarrUrl,
    safeSummary: "hidden",
  },
  {
    key: "sonarrApiKey",
    envName: "JARVIS_V5_SONARR_API_KEY",
    runtimeName: "sonarrApiKey",
    kind: "secret",
    secret: true,
    safeSummary: "hidden",
  },
  {
    key: "seerrUrl",
    envName: "JARVIS_V5_SEERR_URL",
    runtimeName: "seerrUrl",
    kind: "url",
    defaultValue: CONFIG_DEFAULTS.seerrUrl,
    safeSummary: "hidden",
  },
  {
    key: "seerrApiKey",
    envName: "JARVIS_V5_SEERR_API_KEY",
    runtimeName: "seerrApiKey",
    kind: "secret",
    secret: true,
    safeSummary: "hidden",
  },
  {
    key: "backgroundWatchersEnabled",
    envName: "JARVIS_V5_BACKGROUND_WATCHERS_ENABLED",
    runtimeName: "backgroundWatchersEnabled",
    kind: "boolean",
    defaultValue: CONFIG_DEFAULTS.backgroundWatchersEnabled,
    safeSummary: "value",
  },
  {
    key: "modelBackend",
    envName: "JARVIS_V5_MODEL_BACKEND",
    runtimeName: "modelBackend",
    kind: "enum",
    enumValues: ["codex", "claude"],
    defaultValue: CONFIG_DEFAULTS.modelBackend,
    safeSummary: "value",
  },
  {
    key: "model",
    envName: "JARVIS_V5_MODEL",
    runtimeName: "model",
    kind: "nonEmptyString",
    defaultValue: CONFIG_DEFAULTS.model,
    safeSummary: "value",
  },
  {
    key: "claudeHome",
    envName: "JARVIS_V5_CLAUDE_HOME",
    runtimeName: "claudeHome",
    kind: "nonEmptyString",
    defaultValue: CONFIG_DEFAULTS.claudeHome,
    safeSummary: "value",
  },
  {
    key: "claudeAuthToken",
    envName: "JARVIS_V5_CLAUDE_AUTH_TOKEN",
    runtimeName: "claudeAuthToken",
    kind: "secret",
    secret: true,
    safeSummary: "presence",
  },
  {
    key: "claudeApiKey",
    envName: "JARVIS_V5_CLAUDE_API_KEY",
    runtimeName: "claudeApiKey",
    kind: "secret",
    secret: true,
    safeSummary: "presence",
  },
  {
    key: "openaiApiKey",
    envName: "JARVIS_V5_OPENAI_API_KEY",
    runtimeName: "openaiApiKey",
    kind: "secret",
    secret: true,
    safeSummary: "presence",
  },
  {
    key: "claudeCredentialsPath",
    envName: "JARVIS_V5_CLAUDE_CREDENTIALS_PATH",
    runtimeName: "claudeCredentialsPath",
    kind: "nonEmptyString",
    defaultValue: CONFIG_DEFAULTS.claudeCredentialsPath,
    safeSummary: "value",
  },
  {
    key: "claudeTimeoutMs",
    envName: "JARVIS_V5_CLAUDE_TIMEOUT_MS",
    runtimeName: "claudeTimeoutMs",
    kind: "integer",
    defaultValue: CONFIG_DEFAULTS.claudeTimeoutMs,
    min: 1000,
    max: 120000,
    safeSummary: "value",
  },
  {
    key: "claudeChatEffort",
    envName: "JARVIS_V5_CLAUDE_CHAT_EFFORT",
    runtimeName: "claudeChatEffort",
    kind: "enum",
    enumValues: ["default", "low", "medium", "high"],
    defaultValue: CONFIG_DEFAULTS.claudeChatEffort,
    safeSummary: "value",
  },
  {
    key: "codexHome",
    envName: "JARVIS_V5_CODEX_HOME",
    runtimeName: "codexHome",
    kind: "nonEmptyString",
    defaultValue: CONFIG_DEFAULTS.codexHome,
    safeSummary: "value",
  },
  {
    key: "codexWorkingDirectory",
    envName: "JARVIS_V5_CODEX_WORKING_DIRECTORY",
    runtimeName: "codexWorkingDirectory",
    kind: "nonEmptyString",
    defaultValue: CONFIG_DEFAULTS.codexWorkingDirectory,
    safeSummary: "value",
  },
  {
    key: "codexTimeoutMs",
    envName: "JARVIS_V5_CODEX_TIMEOUT_MS",
    runtimeName: "codexTimeoutMs",
    kind: "integer",
    defaultValue: CONFIG_DEFAULTS.codexTimeoutMs,
    min: 1000,
    max: 120000,
    safeSummary: "value",
  },
  {
    key: "monthlyBudgetUsd",
    envName: "JARVIS_V5_MONTHLY_BUDGET_USD",
    runtimeName: "monthlyBudgetUsd",
    kind: "positiveNumber",
    defaultValue: CONFIG_DEFAULTS.monthlyBudgetUsd,
    safeSummary: "value",
  },
  {
    key: "modelEnabled",
    envName: "JARVIS_V5_MODEL_ENABLED",
    runtimeName: "modelEnabled",
    kind: "boolean",
    defaultValue: true,
    safeSummary: "value",
  },
  {
    key: "modelInputCostPerMillionUsd",
    envName: "JARVIS_V5_MODEL_INPUT_COST_PER_MILLION_USD",
    runtimeName: "modelInputCostPerMillionUsd",
    kind: "nonNegativeNumber",
    defaultValue: CONFIG_DEFAULTS.modelInputCostPerMillionUsd,
    safeSummary: "value",
  },
  {
    key: "modelOutputCostPerMillionUsd",
    envName: "JARVIS_V5_MODEL_OUTPUT_COST_PER_MILLION_USD",
    runtimeName: "modelOutputCostPerMillionUsd",
    kind: "nonNegativeNumber",
    defaultValue: CONFIG_DEFAULTS.modelOutputCostPerMillionUsd,
    safeSummary: "value",
  },
  {
    key: "aliasFilePath",
    envName: "JARVIS_V5_ALIAS_FILE",
    runtimeName: "aliasFilePath",
    kind: "nonEmptyString",
    defaultValue: CONFIG_DEFAULTS.aliasFilePath,
    safeSummary: "value",
  },
  {
    key: "memoryCardsEnabled",
    envName: "JARVIS_V5_MEMORY_CARDS_ENABLED",
    runtimeName: "memoryCardsEnabled",
    kind: "boolean",
    defaultValue: CONFIG_DEFAULTS.memoryCardsEnabled,
    safeSummary: "value",
  },
  {
    key: "cognitiveSystemEnabled",
    envName: "JARVIS_V5_COGNITIVE_SYSTEM_ENABLED",
    runtimeName: "cognitiveSystemEnabled",
    kind: "boolean",
    defaultValue: CONFIG_DEFAULTS.cognitiveSystemEnabled,
    safeSummary: "value",
  },
  {
    key: "cognitiveLearningEnabled",
    envName: "JARVIS_V5_COGNITIVE_LEARNING_ENABLED",
    runtimeName: "cognitiveLearningEnabled",
    kind: "boolean",
    defaultValue: CONFIG_DEFAULTS.cognitiveLearningEnabled,
    safeSummary: "value",
  },
  {
    key: "cognitiveRecallEnabled",
    envName: "JARVIS_V5_COGNITIVE_RECALL_ENABLED",
    runtimeName: "cognitiveRecallEnabled",
    kind: "boolean",
    defaultValue: CONFIG_DEFAULTS.cognitiveRecallEnabled,
    safeSummary: "value",
  },
  {
    key: "cognitiveProactiveEnabled",
    envName: "JARVIS_V5_COGNITIVE_PROACTIVE_ENABLED",
    runtimeName: "cognitiveProactiveEnabled",
    kind: "boolean",
    defaultValue: CONFIG_DEFAULTS.cognitiveProactiveEnabled,
    safeSummary: "value",
  },
  {
    key: "cognitiveIngressUserId",
    envName: "JARVIS_V5_COGNITIVE_INGRESS_USER_ID",
    runtimeName: "cognitiveIngressUserId",
    kind: "secret",
    secret: true,
    safeSummary: "hidden",
  },
  {
    key: "cognitiveApiToken",
    envName: "JARVIS_V5_COGNITIVE_API_TOKEN",
    runtimeName: "cognitiveApiToken",
    kind: "secret",
    secret: true,
    safeSummary: "hidden",
  },
  {
    key: "cognitiveOperatorActorId",
    envName: "JARVIS_V5_COGNITIVE_OPERATOR_ACTOR_ID",
    runtimeName: "cognitiveOperatorActorId",
    kind: "nonEmptyString",
    defaultValue: CONFIG_DEFAULTS.cognitiveOperatorActorId,
    safeSummary: "value",
  },
  {
    key: "memoryReflectionEnabled",
    envName: "JARVIS_V5_MEMORY_REFLECTION_ENABLED",
    runtimeName: "memoryReflectionEnabled",
    kind: "boolean",
    defaultValue: CONFIG_DEFAULTS.memoryReflectionEnabled,
    safeSummary: "value",
  },
  {
    key: "memoryRecallEnabled",
    envName: "JARVIS_V5_MEMORY_RECALL_ENABLED",
    runtimeName: "memoryRecallEnabled",
    kind: "boolean",
    defaultValue: CONFIG_DEFAULTS.memoryRecallEnabled,
    safeSummary: "value",
  },
  {
    key: "memoryArchiveEnabled",
    envName: "JARVIS_V5_MEMORY_ARCHIVE_ENABLED",
    runtimeName: "memoryArchiveEnabled",
    kind: "boolean",
    defaultValue: CONFIG_DEFAULTS.memoryArchiveEnabled,
    safeSummary: "value",
  },
  {
    key: "speechToneEnabled",
    envName: "JARVIS_V5_SPEECH_TONE_ENABLED",
    runtimeName: "speechToneEnabled",
    kind: "boolean",
    defaultValue: CONFIG_DEFAULTS.speechToneEnabled,
    safeSummary: "value",
  },
  {
    key: "selfGrowthEnabled",
    envName: "JARVIS_V5_SELF_GROWTH_ENABLED",
    runtimeName: "selfGrowthEnabled",
    kind: "boolean",
    defaultValue: CONFIG_DEFAULTS.selfGrowthEnabled,
    safeSummary: "value",
  },
  {
    key: "correctionsLedgerEnabled",
    envName: "JARVIS_V5_CORRECTIONS_LEDGER_ENABLED",
    runtimeName: "correctionsLedgerEnabled",
    kind: "boolean",
    defaultValue: CONFIG_DEFAULTS.correctionsLedgerEnabled,
    safeSummary: "value",
  },
  {
    key: "correctionAskEnabled",
    envName: "JARVIS_V5_CORRECTION_ASK_ENABLED",
    runtimeName: "correctionAskEnabled",
    kind: "boolean",
    defaultValue: CONFIG_DEFAULTS.correctionAskEnabled,
    safeSummary: "value",
  },
  {
    key: "deviceControlEnabled",
    envName: "JARVIS_V5_DEVICE_CONTROL_ENABLED",
    runtimeName: "deviceControlEnabled",
    kind: "boolean",
    defaultValue: CONFIG_DEFAULTS.deviceControlEnabled,
    safeSummary: "value",
  },
  {
    key: "chatToolsEnabled",
    envName: "JARVIS_V5_CHAT_TOOLS_ENABLED",
    runtimeName: "chatToolsEnabled",
    kind: "boolean",
    defaultValue: CONFIG_DEFAULTS.chatToolsEnabled,
    safeSummary: "value",
  },
  {
    key: "chatWebSearchEnabled",
    envName: "JARVIS_V5_CHAT_WEB_SEARCH_ENABLED",
    runtimeName: "chatWebSearchEnabled",
    kind: "boolean",
    defaultValue: CONFIG_DEFAULTS.chatWebSearchEnabled,
    safeSummary: "value",
  },
  {
    key: "householdRoster",
    envName: "JARVIS_V5_HOUSEHOLD_ROSTER",
    runtimeName: "householdRoster",
    kind: "nonEmptyString",
    defaultValue: CONFIG_DEFAULTS.householdRoster,
    safeSummary: "value",
  },
  {
    key: "memoryApprovalNotifyService",
    envName: "JARVIS_V5_MEMORY_APPROVAL_NOTIFY_SERVICE",
    runtimeName: "memoryApprovalNotifyService",
    kind: "nonEmptyString",
    defaultValue: CONFIG_DEFAULTS.memoryApprovalNotifyService,
    safeSummary: "value",
  },
  {
    key: "homeAssistantToken",
    envName: "HA_TOKEN",
    runtimeName: "homeAssistantToken",
    kind: "secret",
    secret: true,
    safeSummary: "presence",
  },
] as const;

export class ConfigValidationError extends Error {
  readonly field: string;
  readonly envName: string;

  constructor(field: ConfigFieldDefinition, message: string) {
    super(`${field.envName}: ${message}`);
    this.name = "ConfigValidationError";
    this.field = String(field.key);
    this.envName = field.envName;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return loadConfigFromSources({ env });
}

export function loadConfigFromSources(options: ConfigLoadOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const runtimeConfig = loadRuntimeConfig(options.runtimeFilePath ?? env.JARVIS_V5_CONFIG_FILE);
  const values = Object.fromEntries(
    CONFIG_SCHEMA.map((field) => [
      field.key,
      parseField(field, resolveRawValue(field, env, runtimeConfig)),
    ]),
  ) as Record<keyof AppConfig, unknown>;
  const claudeAuthToken = values.claudeAuthToken as string | null;
  const claudeApiKey = values.claudeApiKey as string | null;
  const openaiApiKey = values.openaiApiKey as string | null;
  const homeAssistantToken = values.homeAssistantToken as string | null;
  const claudeHome = values.claudeHome as string;
  const claudeCredentialsPath = values.claudeCredentialsPath as string;
  const codexHome = values.codexHome as string;
  const modelBackend = values.modelBackend as ModelBackend;
  const hasClaudeAuth = modelBackend === "claude" && (claudeApiKey !== null || hasClaudeAuthConfigured(claudeAuthToken, claudeCredentialsPath));
  const hasCodexAuth = modelBackend === "codex" && hasReadableCodexAuth(codexHome);

  return {
    port: values.port as number,
    dataDir: values.dataDir as string,
    projectsDir: values.projectsDir as string,
    questionsDir: values.questionsDir as string,
    haUrl: values.haUrl as string,
    plexUrl: values.plexUrl as string,
    plexToken: values.plexToken as string | null,
    radarrUrl: values.radarrUrl as string,
    radarrApiKey: values.radarrApiKey as string | null,
    sonarrUrl: values.sonarrUrl as string,
    sonarrApiKey: values.sonarrApiKey as string | null,
    seerrUrl: values.seerrUrl as string,
    seerrApiKey: values.seerrApiKey as string | null,
    backgroundWatchersEnabled: values.backgroundWatchersEnabled as boolean,
    modelBackend,
    model: values.model as string,
    claudeHome,
    claudeCredentialsPath,
    claudeTimeoutMs: values.claudeTimeoutMs as number,
    claudeChatEffort: values.claudeChatEffort as ClaudeChatEffort,
    codexHome,
    codexWorkingDirectory: values.codexWorkingDirectory as string,
    codexTimeoutMs: values.codexTimeoutMs as number,
    monthlyBudgetUsd: values.monthlyBudgetUsd as number,
    modelEnabled: values.modelEnabled as boolean,
    modelInputCostPerMillionUsd: values.modelInputCostPerMillionUsd as number,
    modelOutputCostPerMillionUsd: values.modelOutputCostPerMillionUsd as number,
    aliasFilePath: values.aliasFilePath as string,
    memoryCardsEnabled: values.memoryCardsEnabled as boolean,
    cognitiveSystemEnabled: values.cognitiveSystemEnabled as boolean,
    cognitiveLearningEnabled: values.cognitiveLearningEnabled as boolean,
    cognitiveRecallEnabled: values.cognitiveRecallEnabled as boolean,
    cognitiveProactiveEnabled: values.cognitiveProactiveEnabled as boolean,
    cognitiveIngressUserId: values.cognitiveIngressUserId as string | null,
    cognitiveApiToken: values.cognitiveApiToken as string | null,
    // Empty means the household's owner (household.json), the one person who runs the house.
    cognitiveOperatorActorId: (values.cognitiveOperatorActorId as string) || householdOwnerId() || "",
    memoryReflectionEnabled: values.memoryReflectionEnabled as boolean,
    memoryRecallEnabled: values.memoryRecallEnabled as boolean,
    memoryArchiveEnabled: values.memoryArchiveEnabled as boolean,
    speechToneEnabled: values.speechToneEnabled as boolean,
    selfGrowthEnabled: values.selfGrowthEnabled as boolean,
    correctionsLedgerEnabled: values.correctionsLedgerEnabled as boolean,
    correctionAskEnabled: values.correctionAskEnabled as boolean,
    deviceControlEnabled: values.deviceControlEnabled as boolean,
    chatToolsEnabled: values.chatToolsEnabled as boolean,
    chatWebSearchEnabled: values.chatWebSearchEnabled as boolean,
    householdRoster: values.householdRoster as string,
    memoryApprovalNotifyService: values.memoryApprovalNotifyService as string,
    claudeAuthToken,
    claudeApiKey,
    openaiApiKey,
    homeAssistantToken,
    hasClaudeAuth,
    hasHomeAssistantToken: homeAssistantToken !== null,
    hasCodexAuth,
  };
}

export function safeConfigSummary(config: AppConfig): SafeConfigSummary {
  return {
    values: {
      port: config.port,
      dataDir: config.dataDir,
      haUrl: config.haUrl,
      backgroundWatchersEnabled: config.backgroundWatchersEnabled,
      modelBackend: config.modelBackend,
      model: config.model,
      claudeHome: config.claudeHome,
      claudeCredentialsPath: config.claudeCredentialsPath,
      claudeTimeoutMs: config.claudeTimeoutMs,
      claudeChatEffort: config.claudeChatEffort,
      codexHome: config.codexHome,
      codexWorkingDirectory: config.codexWorkingDirectory,
      codexTimeoutMs: config.codexTimeoutMs,
      monthlyBudgetUsd: config.monthlyBudgetUsd,
      modelEnabled: config.modelEnabled,
      modelInputCostPerMillionUsd: config.modelInputCostPerMillionUsd,
      modelOutputCostPerMillionUsd: config.modelOutputCostPerMillionUsd,
      aliasFilePath: config.aliasFilePath,
      memoryCardsEnabled: config.memoryCardsEnabled,
      cognitiveSystemEnabled: config.cognitiveSystemEnabled,
      cognitiveLearningEnabled: config.cognitiveLearningEnabled,
      cognitiveRecallEnabled: config.cognitiveRecallEnabled,
      cognitiveProactiveEnabled: config.cognitiveProactiveEnabled,
      cognitiveIngressIdentityConfigured: config.cognitiveIngressUserId !== null,
      cognitiveApiIdentityConfigured: config.cognitiveApiToken !== null,
      cognitiveOperatorActorId: config.cognitiveOperatorActorId,
      memoryReflectionEnabled: config.memoryReflectionEnabled,
      memoryRecallEnabled: config.memoryRecallEnabled,
      memoryArchiveEnabled: config.memoryArchiveEnabled,
      speechToneEnabled: config.speechToneEnabled,
      selfGrowthEnabled: config.selfGrowthEnabled,
      correctionsLedgerEnabled: config.correctionsLedgerEnabled,
      correctionAskEnabled: config.correctionAskEnabled,
      deviceControlEnabled: config.deviceControlEnabled,
      chatToolsEnabled: config.chatToolsEnabled,
      chatWebSearchEnabled: config.chatWebSearchEnabled,
      memoryApprovalNotifyService: config.memoryApprovalNotifyService,
    },
    credentials: {
      claudeConfigured: config.hasClaudeAuth,
      homeAssistantConfigured: config.hasHomeAssistantToken,
      codexConfigured: config.hasCodexAuth,
    },
  };
}

export function runtimeReadiness(config: AppConfig): RuntimeReadiness {
  return {
    claudeConfigured: config.hasClaudeAuth,
    homeAssistantConfigured: config.hasHomeAssistantToken,
    codexConfigured: config.hasCodexAuth,
    modelRenderAvailable: config.modelEnabled && (
      config.modelBackend === "claude" ? config.hasClaudeAuth : config.hasCodexAuth
    ),
  };
}

function loadRuntimeConfig(runtimeFilePath: string | null | undefined): RuntimeConfigFile {
  const trimmedPath = runtimeFilePath?.trim();
  if (!trimmedPath) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(trimmedPath, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("runtime config must be a JSON object");
    }
    return parsed as RuntimeConfigFile;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw new Error(`Failed to load runtime config ${trimmedPath}: ${errorMessage(error)}`);
  }
}

function resolveRawValue(
  field: ConfigFieldDefinition,
  env: NodeJS.ProcessEnv,
  runtimeConfig: RuntimeConfigFile,
): unknown {
  const envValue = env[field.envName];
  if (envValue !== undefined && envValue.trim() !== "") {
    return envValue;
  }
  if (Object.hasOwn(runtimeConfig, field.runtimeName)) {
    return runtimeConfig[field.runtimeName];
  }
  return undefined;
}

function parseField(field: ConfigFieldDefinition, rawValue: unknown): unknown {
  const value = normalizeRawValue(field, rawValue);
  if (value === undefined || value === "") {
    if (field.kind === "secret") {
      return null;
    }
    if (field.defaultValue !== undefined) {
      return field.defaultValue;
    }
    throw new ConfigValidationError(field, "missing required value");
  }

  switch (field.kind) {
    case "boolean":
      return parseBoolean(field, value);
    case "enum":
      return parseEnum(field, value);
    case "integer":
      return parseInteger(field, value);
    case "nonEmptyString":
      return value;
    case "nonNegativeNumber":
      return parseNonNegativeNumber(field, value);
    case "positiveNumber":
      return parsePositiveNumber(field, value);
    case "secret":
      return value;
    case "url":
      return parseUrl(field, value);
  }
}

/** A Codex sign-in in this home: a ChatGPT account or an API key login. */
export function hasReadableCodexAuth(codexHome: string): boolean {
  try {
    const payload = JSON.parse(readFileSync(`${codexHome}/auth.json`, "utf8")) as unknown;
    return Boolean(
      payload
      && typeof payload === "object"
      && !Array.isArray(payload)
      && (("auth_mode" in payload && ["chatgpt", "apikey"].includes(String(payload.auth_mode).trim().toLowerCase()))
        || ("OPENAI_API_KEY" in payload && typeof payload.OPENAI_API_KEY === "string" && payload.OPENAI_API_KEY.trim().length > 0)),
    );
  } catch {
    return false;
  }
}

function hasClaudeAuthConfigured(
  claudeAuthToken: string | null,
  claudeCredentialsPath: string,
): boolean {
  if (claudeAuthToken !== null) {
    return true;
  }
  return hasReadableClaudeAccessToken(claudeCredentialsPath);
}

function hasReadableClaudeAccessToken(claudeCredentialsPath: string): boolean {
  try {
    const payload = JSON.parse(readFileSync(claudeCredentialsPath, "utf8")) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return false;
    }
    const oauth = "claudeAiOauth" in payload ? payload.claudeAiOauth : null;
    return Boolean(
      oauth
      && typeof oauth === "object"
      && !Array.isArray(oauth)
      && "accessToken" in oauth
      && typeof oauth.accessToken === "string"
      && oauth.accessToken.trim().length > 0,
    );
  } catch {
    return false;
  }
}

function parseEnum(field: ConfigFieldDefinition, value: string): string {
  const normalized = value.toLowerCase();
  if (field.enumValues?.includes(normalized)) {
    return normalized;
  }
  throw new ConfigValidationError(field, `must be one of: ${(field.enumValues ?? []).join(", ")}`);
}

function normalizeRawValue(
  field: ConfigFieldDefinition,
  rawValue: unknown,
): string | undefined {
  if (rawValue === undefined || rawValue === null) {
    return undefined;
  }
  if (typeof rawValue === "string") {
    return rawValue.trim();
  }
  if (typeof rawValue === "number" || typeof rawValue === "boolean") {
    return String(rawValue);
  }
  throw new ConfigValidationError(field, "must be a string, number, boolean, or null");
}

function parseInteger(field: ConfigFieldDefinition, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new ConfigValidationError(field, "must be an integer");
  }
  if (field.min !== undefined && parsed < field.min) {
    throw new ConfigValidationError(field, `must be at least ${field.min}`);
  }
  if (field.max !== undefined && parsed > field.max) {
    throw new ConfigValidationError(field, `must be at most ${field.max}`);
  }
  return parsed;
}

function parsePositiveNumber(field: ConfigFieldDefinition, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigValidationError(field, "must be a positive number");
  }
  return parsed;
}

function parseNonNegativeNumber(field: ConfigFieldDefinition, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ConfigValidationError(field, "must be a non-negative number");
  }
  return parsed;
}

function parseBoolean(field: ConfigFieldDefinition, value: string): boolean {
  const normalized = value.toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new ConfigValidationError(field, "must be a boolean");
}

function parseUrl(field: ConfigFieldDefinition, value: string): string {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
      throw new ConfigValidationError(field, "must use http, https, ws, or wss");
    }
    return value;
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      throw error;
    }
    throw new ConfigValidationError(field, "must be a valid URL");
  }
}
