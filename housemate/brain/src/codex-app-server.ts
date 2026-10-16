import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

import type { AppConfig } from "./config.js";
import {
  buildJarvisCodexPrompt,
  effectiveCodexModelName,
  ensureIsolatedCodexHome,
  isolatedCodexEnvironment,
  jarvisCodexOutputSchema,
} from "./codex-model-contract.js";
import type { ModelTokenUsage } from "./model-ledger.js";
import { abortError } from "./abort-error.js";
import { assistantName } from "./persona.js";

export interface CodexAppServerResult {
  readonly outputText: string;
  readonly usage: ModelTokenUsage;
}

export interface CodexAppServerRunOptions {
  readonly signal?: AbortSignal;
  readonly webSearch?: boolean;
  readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
  readonly onDelta?: (delta: string) => void;
  readonly maxOutputBytes?: number;
}

type JsonRpcId = string | number;

interface JsonRpcResponse {
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
  };
}

interface JsonRpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface ActiveTurn {
  readonly child: ChildProcessWithoutNullStreams;
  readonly threadId: string;
  readonly scratchDir: string;
  readonly onDelta?: (delta: string) => void;
  readonly resolve: (result: CodexAppServerResult) => void;
  readonly reject: (error: Error) => void;
  readonly itemPhases: Map<string, "commentary" | "final_answer" | null>;
  readonly pendingUnknownDeltas: Map<string, string[]>;
  pendingUnknownBytes: number;
  usage: ModelTokenUsage;
  rawFinalText: string;
  codexTurnId: string | null;
  cancelRequested: boolean;
  streamedItemId: string | null;
  outputBytes: number;
  readonly maxOutputBytes: number;
  completed: boolean;
  timer: NodeJS.Timeout;
  abortListener: (() => void) | null;
  signal?: AbortSignal;
}

type SpawnCodexAppServer = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  },
) => ChildProcessWithoutNullStreams;

const ZERO_TOKENS: ModelTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
};
const PROCESS_RESTART_DELAY_MS = 1_000;
const STDERR_LIMIT = 16_384;
const MAX_PROTOCOL_LINE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
const RPC_TIMEOUT_MS = 30_000;
const PROCESS_TERMINATION_GRACE_MS = 2_000;

export class CodexAppServerClient {
  private readonly config: AppConfig;
  private readonly codexHome: string;
  private readonly spawnImpl: SpawnCodexAppServer;
  private readonly restartDelayMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly terminationGraceMs: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: ReadLineInterface | null = null;
  private initializePromise: Promise<void> | null = null;
  private nextRequestId = 0;
  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly cancelledThreads = new Map<string, NodeJS.Timeout>();
  private readonly terminationTimers = new Map<ChildProcessWithoutNullStreams, NodeJS.Timeout>();
  private stderrTail = "";
  private keepWarm = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    config: AppConfig,
    options: {
      readonly spawnImpl?: SpawnCodexAppServer;
      readonly restartDelayMs?: number;
      readonly rpcTimeoutMs?: number;
      readonly terminationGraceMs?: number;
    } = {},
  ) {
    this.config = config;
    this.codexHome = canonicalCodexHome(config.codexHome);
    this.spawnImpl = options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, args, {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      stdio: ["pipe", "pipe", "pipe"],
    }));
    this.restartDelayMs = Math.max(0, options.restartDelayMs ?? PROCESS_RESTART_DELAY_MS);
    this.rpcTimeoutMs = Math.max(1, options.rpcTimeoutMs ?? RPC_TIMEOUT_MS);
    this.terminationGraceMs = Math.max(0, options.terminationGraceMs ?? PROCESS_TERMINATION_GRACE_MS);
  }

  async warm(): Promise<void> {
    this.assertUsable();
    this.keepWarm = true;
    await this.ensureInitialized();
  }

  async run(
    request: Record<string, unknown>,
    options: CodexAppServerRunOptions = {},
  ): Promise<CodexAppServerResult> {
    this.assertUsable();
    const timeoutMs = Math.max(1, this.config.codexTimeoutMs);
    const deadline = Date.now() + timeoutMs;
    await waitForRunStage(
      this.ensureInitialized(),
      deadline,
      options.signal,
      `Codex app-server timed out after ${timeoutMs}ms during initialization`,
    );
    assertRunCanContinue(deadline, options.signal, timeoutMs);

    const scratchDir = mkdtempSync(join(tmpdir(), "housemate-codex-app-"));
    mkdirSync(scratchDir, { recursive: true });
    const reasoningEffort = options.webSearch ? "low" : (options.reasoningEffort ?? "medium");
    let threadId = "";
    try {
      const threadChild = this.child;
      if (!threadChild) {
        throw new Error("Codex app-server process disappeared before thread/start");
      }
      const threadStartPromise = this.request("thread/start", {
        model: effectiveCodexModelName(this.config),
        cwd: scratchDir,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        config: {
          web_search: options.webSearch ? "live" : "disabled",
          model_reasoning_effort: reasoningEffort,
        },
        baseInstructions: [
          `You are the authenticated Codex-backed text model for ${assistantName()}.`,
          "Do not act as a coding agent. Do not inspect files, run commands, modify anything, or mention backend internals.",
          options.webSearch
            ? "Only native live web search is permitted for the requested current public information."
            : "Do not browse or use tools. Answer only from the supplied prompt.",
          "Return only the schema-constrained final response.",
        ].join(" "),
      });
      const threadResponse = recordOrEmpty(await waitForRunStage(
        threadStartPromise,
        deadline,
        options.signal,
        `Codex app-server timed out after ${timeoutMs}ms during thread/start`,
        (lateResponse) => this.deleteStartedThread(threadChild, lateResponse),
      ));
      threadId = stringOrEmpty(recordOrEmpty(threadResponse.thread).id);
      if (!threadId) {
        throw new Error("Codex app-server thread/start did not return a thread id");
      }
      if (this.child !== threadChild) {
        throw new Error("Codex app-server process changed during thread/start");
      }
      if (options.signal?.aborted || remainingTime(deadline) <= 0) {
        this.deleteThread(threadId, threadChild);
        assertRunCanContinue(deadline, options.signal, timeoutMs);
      }

      return await new Promise<CodexAppServerResult>((resolve, reject) => {
        const remainingMs = remainingTime(deadline);
        if (remainingMs <= 0 || options.signal?.aborted) {
          this.deleteThread(threadId, threadChild);
          reject(options.signal?.aborted
            ? abortError("Codex app-server turn aborted")
            : abortError(`Codex app-server timed out after ${timeoutMs}ms`));
          return;
        }
        const turn: ActiveTurn = {
          child: threadChild,
          threadId,
          scratchDir,
          ...(options.onDelta ? { onDelta: options.onDelta } : {}),
          resolve,
          reject,
          itemPhases: new Map(),
          pendingUnknownDeltas: new Map(),
          pendingUnknownBytes: 0,
          usage: ZERO_TOKENS,
          rawFinalText: "",
          codexTurnId: null,
          cancelRequested: false,
          streamedItemId: null,
          outputBytes: 0,
          maxOutputBytes: Math.max(1, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES),
          completed: false,
          timer: setTimeout(() => {
            this.interruptAndReject(
              threadId,
              abortError(`Codex app-server timed out after ${timeoutMs}ms`),
            );
          }, remainingMs),
          abortListener: null,
          ...(options.signal ? { signal: options.signal } : {}),
        };
        if (options.signal) {
          turn.abortListener = () => {
            this.interruptAndReject(threadId, abortError("Codex app-server turn aborted"));
          };
          options.signal.addEventListener("abort", turn.abortListener, { once: true });
        }
        this.activeTurns.set(threadId, turn);
        if (options.signal?.aborted) {
          this.interruptAndReject(threadId, abortError("Codex app-server turn aborted"));
          return;
        }
        void this.request("turn/start", {
          threadId,
          input: [{
            type: "text",
            text: buildJarvisCodexPrompt(request, { webSearch: options.webSearch ?? false }),
            text_elements: [],
          }],
          cwd: scratchDir,
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            networkAccess: false,
          },
          model: effectiveCodexModelName(this.config),
          effort: reasoningEffort,
          outputSchema: jarvisCodexOutputSchema(request),
        }).then((rawResponse: unknown) => {
          if (this.child !== threadChild) {
            return;
          }
          const active = this.activeTurns.get(threadId);
          if (active) {
            active.codexTurnId = stringOrEmpty(recordOrEmpty(recordOrEmpty(rawResponse).turn).id) || null;
            if (active.cancelRequested && active.codexTurnId) {
              void this.request("turn/interrupt", {
                threadId,
                turnId: active.codexTurnId,
              }).catch(() => undefined);
            }
          } else if (this.cancelledThreads.has(threadId)) {
            const turnId = stringOrEmpty(recordOrEmpty(recordOrEmpty(rawResponse).turn).id);
            if (turnId) {
              void this.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
            }
          }
        }, (error: unknown) => {
          this.finishTurnError(threadId, asError(error));
        });
      });
    } catch (error) {
      rmSync(scratchDir, { recursive: true, force: true });
      throw error;
    }
  }

  stop(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.keepWarm = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (child) {
      this.retireChild(child, new Error("Codex app-server stopped"), false);
    } else {
      this.failProcess(new Error("Codex app-server stopped"), false);
    }
    this.initializePromise = null;
    this.clearCancelledThreads();
  }

  dispose(): void {
    this.stop();
  }

  [Symbol.dispose](): void {
    this.stop();
  }

  private ensureInitialized(): Promise<void> {
    this.assertUsable();
    if (this.initializePromise) {
      return this.initializePromise;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const attempt = this.startAndInitialize();
    let guardedAttempt: Promise<void>;
    guardedAttempt = attempt.catch((error: unknown) => {
      if (this.initializePromise === guardedAttempt) {
        this.initializePromise = null;
      }
      this.scheduleWarmRestart();
      throw error;
    });
    this.initializePromise = guardedAttempt;
    return guardedAttempt;
  }

  private async startAndInitialize(): Promise<void> {
    this.assertUsable();
    if (this.child) {
      throw new Error("Codex app-server lifecycle error: a child already exists");
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnImpl(
        "codex",
        ["app-server", "--listen", "stdio://"],
        {
          cwd: this.codexHome,
          env: isolatedCodexEnvironment(this.codexHome),
        },
      );
    } catch (error) {
      throw asError(error);
    }
    this.child = child;
    this.stderrTail = "";
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(child, line));
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (this.child !== child) {
        return;
      }
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-STDERR_LIMIT);
    });
    child.once("error", (error) => this.handleProcessExit(child, error));
    child.once("exit", (code, signal) => {
      this.clearTerminationTimer(child);
      this.handleProcessExit(child, new Error(
        `Codex app-server exited code=${String(code)} signal=${String(signal)}${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`,
      ));
    });

    try {
      await this.request("initialize", {
        clientInfo: {
          name: "housemate-brain",
          title: "Housemate",
          version: "1",
        },
        capabilities: {},
      });
      if (this.child !== child || this.disposed) {
        throw new Error("Codex app-server initialization was superseded");
      }
      this.notify("initialized", {});
    } catch (error) {
      if (this.child === child) {
        this.retireChild(child, asError(error), true);
      }
      throw error;
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex app-server RPC ${method} timed out`));
      }, this.rpcTimeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      try {
        this.write({ method, id, params });
      } catch (error) {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(asError(error));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(message: unknown): void {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) {
      throw new Error("Codex app-server stdin is unavailable");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.child !== child) {
      return;
    }
    if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
      this.retireChild(
        child,
        new Error("Codex app-server protocol line exceeded its byte limit"),
        true,
      );
      return;
    }
    let rawMessage: unknown;
    try {
      rawMessage = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) {
      return;
    }
    const message = rawMessage as JsonRpcResponse | JsonRpcNotification;
    if (
      "id" in message
      && isJsonRpcId(message.id)
      && ("result" in message || "error" in message)
    ) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(
          `Codex app-server RPC failed${message.error.code !== undefined ? ` (${message.error.code})` : ""}: ${message.error.message ?? "unknown error"}`,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (
      "id" in message
      && isJsonRpcId(message.id)
      && "method" in message
      && typeof message.method === "string"
    ) {
      try {
        this.write({
          id: message.id,
          error: {
            code: -32601,
            message: `Housemate does not support Codex server request ${message.method}`,
          },
        });
      } catch {
        // Process teardown will reject the active turn.
      }
      return;
    }
    if ("method" in message && typeof message.method === "string") {
      this.handleNotification(message.method, message.params);
    }
  }

  private handleNotification(method: string, rawParams: unknown): void {
    const params = recordOrEmpty(rawParams);
    const threadId = stringOrEmpty(params.threadId);
    if (!threadId) {
      return;
    }
    const turn = this.activeTurns.get(threadId);
    if (!turn && method === "turn/started" && this.cancelledThreads.has(threadId)) {
      const startedTurn = recordOrEmpty(params.turn);
      const turnId = stringOrEmpty(startedTurn.id);
      if (turnId) {
        void this.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      }
      return;
    }
    if (!turn) {
      return;
    }

    if (method === "item/started") {
      const item = recordOrEmpty(params.item);
      if (item.type === "agentMessage") {
        const itemId = stringOrEmpty(item.id);
        const phase = item.phase === "commentary" || item.phase === "final_answer"
          ? item.phase
          : null;
        if (itemId) {
          turn.itemPhases.set(itemId, phase);
          this.flushUnknownDeltas(turn, itemId);
        }
      }
      return;
    }

    if (method === "turn/started") {
      const startedTurn = recordOrEmpty(params.turn);
      turn.codexTurnId = stringOrEmpty(startedTurn.id) || turn.codexTurnId;
      if (turn.cancelRequested && turn.codexTurnId) {
        void this.request("turn/interrupt", {
          threadId,
          turnId: turn.codexTurnId,
        }).catch(() => undefined);
      }
      return;
    }

    if (method === "item/agentMessage/delta") {
      const itemId = stringOrEmpty(params.itemId);
      const delta = stringOrEmpty(params.delta);
      if (!itemId || !delta) {
        return;
      }
      const phase = turn.itemPhases.get(itemId);
      if (phase === undefined) {
        const pending = turn.pendingUnknownDeltas.get(itemId) ?? [];
        pending.push(delta);
        turn.pendingUnknownDeltas.set(itemId, pending);
        turn.pendingUnknownBytes += Buffer.byteLength(delta, "utf8");
        if (turn.outputBytes + turn.pendingUnknownBytes > turn.maxOutputBytes) {
          this.interruptAndReject(threadId, new Error("Codex app-server output exceeded its byte limit"));
        }
        return;
      }
      if (phase === "commentary") {
        return;
      }
      if (turn.streamedItemId && turn.streamedItemId !== itemId) {
        this.finishTurnError(threadId, new Error("Codex app-server emitted multiple final answer streams"));
        return;
      }
      turn.streamedItemId = itemId;
      turn.outputBytes += Buffer.byteLength(delta, "utf8");
      if (turn.outputBytes > turn.maxOutputBytes) {
        this.interruptAndReject(threadId, new Error("Codex app-server output exceeded its byte limit"));
        return;
      }
      turn.rawFinalText += delta;
      try {
        turn.onDelta?.(delta);
      } catch (error) {
        this.interruptAndReject(threadId, asError(error));
      }
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      const tokenUsage = recordOrEmpty(params.tokenUsage);
      const last = recordOrEmpty(tokenUsage.last);
      turn.usage = {
        inputTokens: nonNegativeInteger(last.inputTokens),
        outputTokens: nonNegativeInteger(last.outputTokens),
      };
      return;
    }

    if (method === "turn/completed") {
      const completed = recordOrEmpty(params.turn);
      const status = stringOrEmpty(completed.status);
      if (status !== "completed") {
        const failure = recordOrEmpty(completed.error);
        this.finishTurnError(
          threadId,
          new Error(`Codex app-server turn ${status || "failed"}: ${stringOrEmpty(failure.message) || "unknown error"}`),
        );
        return;
      }
      const finalText = finalAgentMessageText(completed.items) || turn.rawFinalText;
      if (!finalText.trim()) {
        this.finishTurnError(threadId, new Error("Codex app-server returned no final agent message"));
        return;
      }
      if (Buffer.byteLength(finalText, "utf8") > turn.maxOutputBytes) {
        this.interruptAndReject(threadId, new Error("Codex app-server output exceeded its byte limit"));
        return;
      }
      this.finishTurnSuccess(threadId, {
        outputText: finalText,
        usage: turn.usage,
      });
    }
  }

  private flushUnknownDeltas(turn: ActiveTurn, itemId: string): void {
    const pending = turn.pendingUnknownDeltas.get(itemId);
    if (!pending) {
      return;
    }
    turn.pendingUnknownDeltas.delete(itemId);
    turn.pendingUnknownBytes = Math.max(
      0,
      turn.pendingUnknownBytes - pending.reduce(
        (total, delta) => total + Buffer.byteLength(delta, "utf8"),
        0,
      ),
    );
    if (turn.itemPhases.get(itemId) === "commentary") {
      return;
    }
    for (const delta of pending) {
      if (turn.streamedItemId && turn.streamedItemId !== itemId) {
        this.finishTurnError(turn.threadId, new Error("Codex app-server emitted multiple final answer streams"));
        return;
      }
      turn.streamedItemId = itemId;
      turn.outputBytes += Buffer.byteLength(delta, "utf8");
      if (turn.outputBytes > turn.maxOutputBytes) {
        this.interruptAndReject(turn.threadId, new Error("Codex app-server output exceeded its byte limit"));
        return;
      }
      turn.rawFinalText += delta;
      try {
        turn.onDelta?.(delta);
      } catch (error) {
        this.interruptAndReject(turn.threadId, asError(error));
        return;
      }
    }
  }

  private interruptAndReject(threadId: string, error: Error): void {
    const turn = this.activeTurns.get(threadId);
    if (!turn || turn.completed) {
      return;
    }
    turn.cancelRequested = true;
    const existingTombstone = this.cancelledThreads.get(threadId);
    if (existingTombstone) {
      clearTimeout(existingTombstone);
    }
    this.cancelledThreads.set(threadId, setTimeout(() => {
      this.cancelledThreads.delete(threadId);
    }, 60_000));
    if (turn.codexTurnId) {
      if (this.child === turn.child) {
        void this.request("turn/interrupt", {
          threadId,
          turnId: turn.codexTurnId,
        }).catch(() => undefined);
      }
    }
    this.finishTurnError(threadId, error);
  }

  private finishTurnSuccess(threadId: string, result: CodexAppServerResult): void {
    const turn = this.takeTurn(threadId, true);
    if (!turn) {
      return;
    }
    turn.resolve(result);
  }

  private finishTurnError(threadId: string, error: Error): void {
    const turn = this.takeTurn(threadId, true);
    if (!turn) {
      return;
    }
    turn.reject(error);
  }

  private takeTurn(threadId: string, deleteThread: boolean): ActiveTurn | null {
    const turn = this.activeTurns.get(threadId);
    if (!turn || turn.completed) {
      return null;
    }
    turn.completed = true;
    this.activeTurns.delete(threadId);
    clearTimeout(turn.timer);
    if (turn.abortListener && turn.signal) {
      turn.signal.removeEventListener("abort", turn.abortListener);
    }
    rmSync(turn.scratchDir, { recursive: true, force: true });
    if (deleteThread) {
      this.deleteThread(threadId, turn.child);
    }
    return turn;
  }

  private handleProcessExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) {
      return;
    }
    this.retireChild(child, error, true);
  }

  private retireChild(
    child: ChildProcessWithoutNullStreams,
    error: Error,
    restartIfWarm: boolean,
  ): void {
    if (this.child !== child) {
      this.terminateChild(child);
      return;
    }
    this.child = null;
    this.lines?.close();
    this.lines = null;
    this.initializePromise = null;
    this.failProcess(error, false);
    this.clearCancelledThreads();
    const childWasRunning = child.exitCode === null && child.signalCode === null;
    this.terminateChild(child);
    if (restartIfWarm) {
      this.scheduleWarmRestart(
        childWasRunning ? this.terminationGraceMs + 25 : this.restartDelayMs,
      );
    }
  }

  private failProcess(error: Error, deleteThreads: boolean): void {
    for (const [id, pending] of this.pendingRequests) {
      this.pendingRequests.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const threadId of [...this.activeTurns.keys()]) {
      const turn = this.takeTurn(threadId, deleteThreads);
      turn?.reject(error);
    }
  }

  private deleteStartedThread(
    child: ChildProcessWithoutNullStreams,
    rawResponse: unknown,
  ): void {
    const threadId = stringOrEmpty(recordOrEmpty(recordOrEmpty(rawResponse).thread).id);
    if (threadId) {
      this.deleteThread(threadId, child);
    }
  }

  private deleteThread(
    threadId: string,
    expectedChild: ChildProcessWithoutNullStreams,
  ): void {
    if (this.child !== expectedChild || this.disposed) {
      return;
    }
    void this.request("thread/delete", { threadId }).catch(() => undefined);
  }

  private scheduleWarmRestart(minimumDelayMs = this.restartDelayMs): void {
    if (!this.keepWarm || this.disposed || this.restartTimer || this.child) {
      return;
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.disposed || !this.keepWarm) {
        return;
      }
      void this.ensureInitialized().catch((restartError: unknown) => {
        console.warn(`[brain] Codex app-server restart failed: ${asError(restartError).message}`);
      });
    }, Math.max(this.restartDelayMs, minimumDelayMs));
    this.restartTimer.unref?.();
  }

  private terminateChild(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode !== null || child.signalCode !== null) {
      this.clearTerminationTimer(child);
      return;
    }
    try {
      child.stdin.end();
    } catch {
      // Best effort; the process signal below is authoritative.
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // A failed signal generally means the process has already gone away.
    }
    if (this.terminationGraceMs === 0) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best effort.
      }
      return;
    }
    if (this.terminationTimers.has(child)) {
      return;
    }
    const timer = setTimeout(() => {
      this.terminationTimers.delete(child);
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort.
        }
      }
    }, this.terminationGraceMs);
    timer.unref?.();
    this.terminationTimers.set(child, timer);
  }

  private clearTerminationTimer(child: ChildProcessWithoutNullStreams): void {
    const timer = this.terminationTimers.get(child);
    if (timer) {
      clearTimeout(timer);
      this.terminationTimers.delete(child);
    }
  }

  private clearCancelledThreads(): void {
    for (const timer of this.cancelledThreads.values()) {
      clearTimeout(timer);
    }
    this.cancelledThreads.clear();
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new Error("Codex app-server client is disposed");
    }
  }
}

const warmClients = new Map<string, CodexAppServerClient>();

export function codexAppServerClient(config: AppConfig): CodexAppServerClient {
  const key = canonicalCodexHome(config.codexHome);
  const existing = warmClients.get(key);
  if (existing) {
    return existing;
  }
  const client = new CodexAppServerClient(config);
  warmClients.set(key, client);
  return client;
}

export function disposeCodexAppServer(config: Pick<AppConfig, "codexHome">): void {
  const key = canonicalCodexHome(config.codexHome);
  const client = warmClients.get(key);
  if (!client) {
    return;
  }
  warmClients.delete(key);
  client.dispose();
}

export function stopCodexAppServers(): void {
  const clients = [...warmClients.values()];
  warmClients.clear();
  for (const client of clients) {
    client.dispose();
  }
}

export function warmCodexAppServer(config: AppConfig): void {
  if (!config.modelEnabled || config.modelBackend !== "codex" || !config.hasCodexAuth) {
    return;
  }
  void codexAppServerClient(config).warm().then(
    () => console.log("[brain] Codex app-server warm and ready"),
    (error: unknown) => console.warn(`[brain] Codex app-server warm-up failed: ${asError(error).message}`),
  );
}

function finalAgentMessageText(rawItems: unknown): string {
  if (!Array.isArray(rawItems)) {
    return "";
  }
  const messages = rawItems.flatMap((rawItem): string[] => {
    const item = recordOrEmpty(rawItem);
    if (
      item.type !== "agentMessage"
      || item.phase === "commentary"
      || typeof item.text !== "string"
      || !item.text.trim()
    ) {
      return [];
    }
    return [item.text];
  });
  return messages.at(-1) ?? "";
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function canonicalCodexHome(codexHome: string): string {
  const home = ensureIsolatedCodexHome(resolve(codexHome.trim()));
  return realpathSync.native(home);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "number" || typeof value === "string";
}

function remainingTime(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function assertRunCanContinue(
  deadline: number,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): void {
  if (signal?.aborted) {
    throw abortError("Codex app-server turn aborted");
  }
  if (remainingTime(deadline) <= 0) {
    throw abortError(`Codex app-server timed out after ${timeoutMs}ms`);
  }
}

function waitForRunStage<T>(
  promise: Promise<T>,
  deadline: number,
  signal: AbortSignal | undefined,
  timeoutMessage: string,
  onLateSuccess?: (value: T) => void,
): Promise<T> {
  const remainingMs = remainingTime(deadline);
  if (signal?.aborted) {
    promise.then(onLateSuccess, () => undefined);
    return Promise.reject(abortError("Codex app-server turn aborted"));
  }
  if (remainingMs <= 0) {
    promise.then(onLateSuccess, () => undefined);
    return Promise.reject(abortError(timeoutMessage));
  }
  return new Promise<T>((resolveValue, rejectValue) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener("abort", abortListener);
      }
    };
    const rejectEarly = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      rejectValue(error);
    };
    const timer = setTimeout(() => {
      rejectEarly(abortError(timeoutMessage));
    }, remainingMs);
    const abortListener = (): void => {
      rejectEarly(abortError("Codex app-server turn aborted"));
    };
    if (signal) {
      signal.addEventListener("abort", abortListener, { once: true });
    }
    promise.then(
      (value) => {
        if (settled) {
          onLateSuccess?.(value);
          return;
        }
        settled = true;
        cleanup();
        if (signal?.aborted) {
          onLateSuccess?.(value);
          rejectValue(abortError("Codex app-server turn aborted"));
          return;
        }
        resolveValue(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        rejectValue(asError(error));
      },
    );
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
