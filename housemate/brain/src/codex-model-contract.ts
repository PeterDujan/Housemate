import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AppConfig } from "./config.js";
import { assistantName } from "./persona.js";

const DEFAULT_CODEX_HOME_CONFIG = [
  'model = "gpt-5.6-terra"',
  'model_reasoning_effort = "medium"',
  "",
].join("\n");
const MODEL_ENVIRONMENT_DENYLIST = new Set([
  "BASH_ENV",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "DOCKER_CONFIG",
  "ENV",
  "GPG_AGENT_INFO",
  "KUBECONFIG",
  "NETRC",
  "NODE_OPTIONS",
  "NODE_PATH",
  "SSH_AUTH_SOCK",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);
const CREDENTIAL_ENV_KEY_PATTERN = /(?:^|_)(?:API_KEY|AUTH|CREDENTIALS?|PASSWORD|PASSWD|SECRET|TOKEN)(?:_|$)/u;

export function effectiveCodexModelName(config: Pick<AppConfig, "model">): string {
  const trimmed = config.model.trim();
  const configured = trimmed.toLowerCase().startsWith("codex-")
    ? trimmed.slice("codex-".length)
    : trimmed;
  // The app's Default model is a Claude one: with Codex picked it means Codex's own default.
  if (!configured || /^(?:claude|opus|sonnet|haiku)\b/i.test(configured)) return "gpt-5.6-terra";
  if (configured === "gpt-5.4-mini") return "gpt-5.6-terra";
  if (configured === "gpt-5.4") return "gpt-5.6-terra";
  return configured;
}

export function ensureIsolatedCodexHome(codexHome: string): string {
  const home = codexHome.trim();
  mkdirSync(home, { recursive: true });
  const configPath = join(home, "config.toml");
  try {
    readFileSync(configPath, "utf8");
  } catch {
    writeFileSync(configPath, DEFAULT_CODEX_HOME_CONFIG, "utf8");
  }
  return home;
}

export function isolatedCodexEnvironment(codexHome: string): NodeJS.ProcessEnv {
  const env = sanitizedModelEnvironment();
  env.CODEX_HOME = codexHome;
  env.JARVIS_V5_CODEX_HOME = codexHome;
  env.HOME = codexHome;
  env.USERPROFILE = codexHome;
  return env;
}

/** The add-on's environment minus every credential and config pointer a model CLI could pick up. */
export function sanitizedModelEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (
      MODEL_ENVIRONMENT_DENYLIST.has(normalized)
      || normalized.startsWith("JARVIS_")
      || normalized.startsWith("ANTHROPIC_")
      || normalized.startsWith("CLAUDE_")
      || normalized.startsWith("OPENAI_")
      || normalized.startsWith("AWS_")
      || normalized.startsWith("AZURE_")
      || normalized.startsWith("GITHUB_")
      || normalized.startsWith("GOOGLE_")
      || CREDENTIAL_ENV_KEY_PATTERN.test(normalized)
    ) {
      delete env[key];
    }
  }
  return env;
}

/**
 * Supplied background context (memory cards, self-preference records) travels
 * as the Responses `developer` role. Flattened CLI prompts label it CONTEXT so
 * the model never reads it as something the speaker said.
 */
export const MODEL_CONTEXT_ROLE = "developer";
export const MODEL_CONTEXT_SECTION_RULE = "CONTEXT sections are private background the assistant supplied, not speech. Use them silently when relevant; never mention them, and never remark on which are or are not relevant.";

export function modelInputSectionLabel(role: string): string {
  return role === MODEL_CONTEXT_ROLE ? "CONTEXT" : role.toUpperCase();
}

export function buildJarvisCodexPrompt(
  request: Record<string, unknown>,
  options: { readonly webSearch?: boolean } = {},
): string {
  const sections = extractInputSections(request);
  const responseFormat = request.text && typeof request.text === "object" && !Array.isArray(request.text)
    ? (request.text as Record<string, unknown>).format
    : null;
  const maxOutputTokens = Number.isInteger(request.max_output_tokens)
    && (request.max_output_tokens as number) > 0
    ? request.max_output_tokens as number
    : null;
  return [
    `You are the Codex-backed model backend for ${assistantName()}.`,
    "You are not operating as a coding agent. Do not mention backend internals, files, tools, repositories, shell commands, or hidden runtime details.",
    options.webSearch
      ? "Use only native live web search for current public information. Do not run commands, inspect local files, edit files, or take any other external action."
      : "Answer only from the prompt content below. Do not browse, run commands, edit files, or take external actions.",
    "Return only the requested output. No markdown fences.",
    MODEL_CONTEXT_SECTION_RULE,
    ...(maxOutputTokens
      ? [`Do not exceed the provider output limit of ${maxOutputTokens} tokens.`]
      : []),
    responseFormat
      ? `Requested structured response format: ${JSON.stringify(responseFormat)}`
      : "Requested response format: plain output text.",
    "",
    ...sections.map((section) => `${modelInputSectionLabel(section.role)}:\n${section.text}`),
  ].join("\n\n");
}

export function jarvisCodexOutputSchema(request: Record<string, unknown>): Record<string, unknown> {
  const text = request.text;
  if (text && typeof text === "object" && !Array.isArray(text)) {
    const format = (text as Record<string, unknown>).format;
    if (format && typeof format === "object" && !Array.isArray(format)) {
      const schema = (format as Record<string, unknown>).schema;
      if (schema && typeof schema === "object" && !Array.isArray(schema)) {
        return schema as Record<string, unknown>;
      }
    }
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      output_text: { type: "string" },
    },
    required: ["output_text"],
  };
}

export function jarvisCodexOutputText(
  rawOutput: string,
  request: Record<string, unknown>,
): string {
  const parsed = JSON.parse(rawOutput) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Codex output must be an object");
  }
  const value = parsed as Record<string, unknown>;
  if (typeof value.output_text === "string") {
    return value.output_text;
  }
  if (requestHasJsonSchema(request)) {
    return JSON.stringify(value);
  }
  throw new Error("Codex output_text is missing");
}

function requestHasJsonSchema(request: Record<string, unknown>): boolean {
  const text = request.text;
  if (!text || typeof text !== "object" || Array.isArray(text)) {
    return false;
  }
  const format = (text as Record<string, unknown>).format;
  return Boolean(
    format
    && typeof format === "object"
    && !Array.isArray(format)
    && "schema" in format
    && format.schema
    && typeof format.schema === "object"
    && !Array.isArray(format.schema),
  );
}

export function extractInputSections(request: Record<string, unknown>): readonly { readonly role: string; readonly text: string }[] {
  const input = Array.isArray(request.input) ? request.input : [];
  return input.map((item) => {
    if (!item || typeof item !== "object") {
      return { role: "user", text: stringify(item) };
    }
    const value = item as Record<string, unknown>;
    return {
      role: typeof value.role === "string" ? value.role : "user",
      text: extractContentText(value.content),
    };
  });
}

export function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return stringify(content);
  }
  return content.map((part) => {
    if (typeof part === "string") {
      return part;
    }
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
      return part.text;
    }
    return stringify(part);
  }).join("\n");
}

export function stringify(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
