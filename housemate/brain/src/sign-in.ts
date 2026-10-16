import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureIsolatedCodexHome, isolatedCodexEnvironment, sanitizedModelEnvironment } from "./codex-model-contract.js";

/**
 * Signing the brain in, always through the vendors' own flows and the house's own
 * accounts. Codex: `codex login --device-auth` in the brain's own Codex home (the page shows the
 * vendor's link and one-time code; the person approves it on OpenAI's site), or the house's API key
 * through `codex login --with-api-key`. Claude: `claude setup-token` from the page (below), or the
 * person runs it on any computer and pastes the token into the settings, or sets an API key there.
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

/*
 * Claude from the page: `claude setup-token` with the house's own Claude account, in a throwaway
 * home. It wants a terminal, so it runs under Python's pty with a wide window (one line per URL).
 * The page shows Anthropic's sign-in link; the person signs in there and pastes the code they get
 * back; the token Claude prints is handed to `save` (the app's `claude_token` setting) and never
 * kept here, logged, or sent to the page.
 */

const PTY_RUN = [
  "import fcntl, os, pty, select, struct, sys, termios",
  "pid, fd = pty.fork()",
  "if pid == 0:",
  "    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 60, 2000, 0, 0))",
  "    os.execvp(sys.argv[1], sys.argv[1:])",
  "open_in = True",
  "while True:",
  "    ready = select.select([fd] + ([0] if open_in else []), [], [])[0]",
  "    if fd in ready:",
  "        try:",
  "            data = os.read(fd, 4096)",
  "        except OSError:",
  "            break",
  "        if not data:",
  "            break",
  "        os.write(1, data)",
  "    if 0 in ready:",
  "        data = os.read(0, 4096)",
  "        if data:",
  "            os.write(fd, data)",
  "        else:",
  "            open_in = False",
  "sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))",
].join("\n");
// Terminal control sequences (colours, cursor moves, titles) out of the vendor's screen.
// eslint-disable-next-line no-control-regex
const TERMINAL_CODES = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?<>=]*[ -/]*[@-~]|\u001b[()][0-9A-Za-z]|\u001b[=>78]/gu;
const CLAUDE_TOKEN = /sk-ant-oat\d*-[A-Za-z0-9_-]{20,}/u;
const CLAUDE_CODE_SHAPE = /^[A-Za-z0-9_#.~-]{10,600}$/u;

export type SpawnClaude = (args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcess;

const spawnClaude: SpawnClaude = (args, env) => spawn("python3", ["-c", PTY_RUN, "claude", ...args], { env, stdio: ["pipe", "pipe", "pipe"] });

export class ClaudeSignIn {
  private status: SignInStatus = IDLE;
  private child: ChildProcess | null = null;
  private home: string | null = null;
  private screen = "";
  private pasted = false;
  private saving = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly save: (token: string) => Promise<void>,
    private readonly run: SpawnClaude = spawnClaude,
    private readonly scratch: () => string = () => mkdtempSync(join(tmpdir(), "housemate-claude-signin-")),
  ) {}

  current(): SignInStatus {
    return this.status;
  }

  /** Starts `claude setup-token`, or returns the one already waiting. */
  start(): SignInStatus {
    if (this.child && this.status.state === "waiting") return this.status;
    const home = this.scratch();
    this.home = home;
    this.screen = "";
    this.pasted = false;
    this.saving = false;
    this.status = { state: "waiting", url: null, code: null, message: "Starting the sign-in..." };
    const env: NodeJS.ProcessEnv = { ...sanitizedModelEnvironment(), HOME: home, CLAUDE_CONFIG_DIR: home, TERM: "xterm-256color", BROWSER: "true" };
    const child = this.run(["setup-token"], env);
    this.child = child;
    this.timer = setTimeout(() => child.kill(), SIGN_IN_TIMEOUT_MS);
    const read = (chunk: Buffer | string) => {
      if (this.saving || this.child !== child) return;
      this.screen = `${this.screen}${String(chunk).replace(TERMINAL_CODES, "")}`.slice(-20_000);
      const token = CLAUDE_TOKEN.exec(this.screen)?.[0];
      if (token) {
        this.screen = "";
        this.finish(child, token);
        return;
      }
      const url = /https:\/\/\S*oauth\S*/u.exec(this.screen)?.[0] ?? null;
      if (url && !this.pasted) {
        this.status = { state: "waiting", url, code: null, message: "Open the link, sign in with your own Claude account, then paste the code it shows you here." };
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("error", (error) => {
      this.end(child, { state: "failed", url: null, code: null, message: `Claude couldn't start: ${error.message}` });
    });
    child.on("close", () => {
      if (this.status.state === "waiting" && !this.saving) this.end(child, { state: "failed", url: null, code: null, message: this.pasted ? "Claude didn't take that code. Start again and paste the newest code." : "The Claude sign-in stopped. Try again." });
    });
    return this.status;
  }

  /** The code the person got back from Anthropic's page, typed into the waiting `claude setup-token`. */
  paste(code: string): SignInStatus {
    const clean = code.trim();
    if (!this.child || this.status.state !== "waiting" || !this.status.url) throw new Error("start the Claude sign-in first");
    if (!CLAUDE_CODE_SHAPE.test(clean)) throw new Error("that doesn't look like the code from Claude's page");
    this.pasted = true;
    this.status = { ...this.status, message: "Checking the code..." };
    this.child.stdin?.write(`${clean}\r`);
    return this.status;
  }

  private finish(child: ChildProcess, token: string): void {
    this.saving = true;
    this.status = { state: "waiting", url: null, code: null, message: "Saving the sign-in..." };
    this.save(token).then(
      () => this.end(child, { state: "done", url: null, code: null, message: "Signed in to Claude. Restart Housemate to use it." }),
      (error: unknown) => this.end(child, { state: "failed", url: null, code: null, message: `Signed in, but the setting didn't save: ${error instanceof Error ? error.message : String(error)}` }),
    );
  }

  private end(child: ChildProcess, status: SignInStatus): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.child === child) this.child = null;
    if (child.exitCode === null) child.kill();
    this.status = status;
    if (this.home) rmSync(this.home, { recursive: true, force: true });
    this.home = null;
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
