import { spawn, type ChildProcess } from "node:child_process";

import { ensureIsolatedCodexHome, isolatedCodexEnvironment } from "./codex-model-contract.js";

/**
 * Signing the brain in, always through the vendors' own flows and the house's own
 * accounts. Codex: `codex login --device-auth` in the brain's own Codex home (the page shows the
 * vendor's link and one-time code; the person approves it on OpenAI's site), or the house's API key
 * through `codex login --with-api-key`. Claude: the person runs `claude setup-token` with their own
 * account and pastes the token into the settings, or sets their own API key there.
 */

export type SignInState = "idle" | "waiting" | "done" | "failed";

export interface SignInStatus {
  readonly state: SignInState;
  /** The vendor's sign-in page and one-time code while waiting. */
  readonly url: string | null;
  readonly code: string | null;
  readonly message: string | null;
}

const IDLE: SignInStatus = Object.freeze({ state: "idle", url: null, code: null, message: null });
const SIGN_IN_TIMEOUT_MS = 15 * 60_000;
const URL_PATTERN = /https:\/\/[^\s"'<>]+/u;
const CODE_PATTERN = /\b[A-Z0-9]{4,5}-[A-Z0-9]{4,6}\b/u;

export type SpawnCodex = (args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcess;

const spawnCodex: SpawnCodex = (args, env) => spawn("codex", [...args], { env, stdio: ["pipe", "pipe", "pipe"] });

export class CodexSignIn {
  private status: SignInStatus = IDLE;
  private child: ChildProcess | null = null;

  constructor(
    private readonly codexHome: string,
    private readonly run: SpawnCodex = spawnCodex,
  ) {}

  current(): SignInStatus {
    return this.status;
  }

  /** Starts the device sign-in, or returns the one already waiting. */
  start(): SignInStatus {
    if (this.child && this.status.state === "waiting") return this.status;
    const home = ensureIsolatedCodexHome(this.codexHome);
    this.status = { state: "waiting", url: null, code: null, message: "Starting the sign-in..." };
    const child = this.run(["login", "--device-auth"], isolatedCodexEnvironment(home));
    this.child = child;
    const timer = setTimeout(() => child.kill(), SIGN_IN_TIMEOUT_MS);
    const read = (chunk: Buffer | string) => {
      // Terminal colour codes (ESC [... m) out of the vendor's text.
      const text = String(chunk).replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu"), "");
      const url = URL_PATTERN.exec(text)?.[0] ?? null;
      const code = CODE_PATTERN.exec(text)?.[0] ?? null;
      if (url || code) {
        this.status = {
          state: "waiting",
          url: url ?? this.status.url,
          code: code ?? this.status.code,
          message: "Open the link, sign in with your own OpenAI account and enter the code.",
        };
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("error", (error) => {
      clearTimeout(timer);
      this.child = null;
      this.status = { state: "failed", url: null, code: null, message: `Codex couldn't start: ${error.message}` };
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      this.child = null;
      this.status = code === 0
        ? { state: "done", url: null, code: null, message: "Signed in to Codex." }
        : { state: "failed", url: null, code: null, message: "The Codex sign-in didn't finish. Try again." };
    });
    return this.status;
  }
}

/** The house's OpenAI API key into the brain's Codex home, once (when no sign-in is there yet). */
export function codexLoginWithApiKey(codexHome: string, apiKey: string, run: SpawnCodex = spawnCodex): Promise<boolean> {
  const home = ensureIsolatedCodexHome(codexHome);
  return new Promise((resolve) => {
    const child = run(["login", "--with-api-key"], isolatedCodexEnvironment(home));
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin?.end(`${apiKey.trim()}\n`);
  });
}
