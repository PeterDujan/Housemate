import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelStreamTrace } from "./turn-pace.js";
import { isRecord } from "./value-guards.js";
import { abortErrorFromSignal } from "./abort-error.js";

/**
 * Streaming Claude Code runner with one pre-started spare process per launch
 * shape. A spare boots the CLI (auth, settings, system prompt) ahead of time
 * and waits on stream-json stdin, so a live turn only pays for the model
 * itself. Every turn still runs in a fresh process with no session history.
 */

export interface ClaudeStreamLaunch {
  /** Stable identity of the argv/env shape; spares are only reused for an identical key. */
  readonly key: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /**
   * Per-process extras, such as a secret MCP URL. Called once for each spawned
   * process; the spare-slot key must not depend on these arguments.
   */
  readonly perProcess?: (() => ClaudeProcessAttachment) | undefined;
}

export interface ClaudeProcessAttachment {
  readonly args: readonly string[];
  /** Opaque id the turn uses to bind itself to this process. */
  readonly handle: string;
  /** Called once when the process exits or fails to start. */
  readonly release: () => void;
}

export interface ClaudeStreamRunOptions {
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly maxOutputBytes?: number | undefined;
  /** Receives StructuredOutput partial JSON when structured, otherwise text deltas. */
  readonly onDelta?: ((delta: string) => void) | undefined;
  readonly structured: boolean;
  /**
   * Structured only: wait for the CLI's final result, which Claude Code has
   * checked against the schema (and retried), instead of taking the first
   * StructuredOutput block as final. Costs one API round; for background work.
   */
  readonly awaitCliResult?: boolean | undefined;
  /** Plain text only: a text block ended, so its last sentence is complete. */
  readonly onTextBoundary?: (() => void) | undefined;
  /** Plain text only: the model started a tool call (MCP name, e.g. mcp__jarvis__search_memory). */
  readonly onToolUse?: ((name: string) => void) | undefined;
  /**
   * Binds the turn to the process's attachment before the prompt is sent;
   * the returned function unbinds it when the turn settles.
   */
  readonly bindProcess?: ((handle: string) => () => void) | undefined;
  /** Timing only: which process ran the turn and when the stream moved. */
  readonly onTrace?: ((event: ModelStreamTrace) => void) | undefined;
}

export type SpawnClaudeStream = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  },
) => ChildProcessWithoutNullStreams;

interface ClaudeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly scratchDir: string;
  readonly spawnedAt: number;
  readonly attachment: ClaudeProcessAttachment | null;
  exited: boolean;
  stderr: string;
}

interface SpareSlot {
  process: ClaudeProcess | null;
  launch: ClaudeStreamLaunch;
  lastUsedAt: number;
  recycleTimer: NodeJS.Timeout | null;
}

const DEFAULT_MAX_DELTA_BYTES = 128 * 1024;
const MAX_PROTOCOL_BYTES = 8 * 1024 * 1024;
const STDERR_LIMIT = 16_384;
const PROCESS_TERMINATION_GRACE_MS = 1_000;
const SPARE_MAX_AGE_MS = 20 * 60_000;
const SPARE_KEEP_AFTER_USE_MS = 6 * 60 * 60_000;
const MAX_SPARE_SLOTS = 3;

export class ClaudeStreamPool {
  private readonly spawnImpl: SpawnClaudeStream;
  private readonly now: () => number;
  private readonly warm: boolean;
  private readonly slots = new Map<string, SpareSlot>();
  private stopped = false;

  constructor(options: {
    readonly spawnImpl?: SpawnClaudeStream;
    readonly now?: () => number;
    readonly warm?: boolean;
  } = {}) {
    this.spawnImpl = options.spawnImpl ?? defaultSpawn;
    this.now = options.now ?? Date.now;
    this.warm = options.warm ?? true;
  }

  /** Starts a spare for this launch shape without running a turn. */
  prewarm(launch: ClaudeStreamLaunch): void {
    if (!this.warm || this.stopped) {
      return;
    }
    const slot = this.slotFor(launch);
    slot.lastUsedAt = this.now();
    this.replenish(slot);
  }

  async run(
    launch: ClaudeStreamLaunch,
    options: ClaudeStreamRunOptions,
  ): Promise<Record<string, unknown>> {
    if (this.stopped) {
      throw new Error("Claude stream pool is stopped");
    }
    if (options.signal?.aborted) {
      throw abortErrorFromSignal(options.signal);
    }
    const slot = this.warm ? this.slotFor(launch) : null;
    let proc = slot ? this.takeSpare(slot) : null;
    traceSafely(options, { kind: "process", spare: proc ? "warm" : "cold" });
    proc ??= this.start(launch);
    if (slot) {
      slot.lastUsedAt = this.now();
    }
    try {
      return await this.runTurn(proc, options);
    } finally {
      stopProcess(proc);
      if (slot) {
        this.replenish(slot);
      }
    }
  }

  /**
   * Run in a one-off process that never takes, creates or evicts a spare, so
   * background work cannot leave a live launch shape cold.
   */
  async runDetached(
    launch: ClaudeStreamLaunch,
    options: ClaudeStreamRunOptions,
  ): Promise<Record<string, unknown>> {
    if (this.stopped) {
      throw new Error("Claude stream pool is stopped");
    }
    if (options.signal?.aborted) {
      throw abortErrorFromSignal(options.signal);
    }
    const proc = this.start(launch);
    traceSafely(options, { kind: "process", spare: "detached" });
    try {
      return await this.runTurn(proc, options);
    } finally {
      stopProcess(proc);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const slot of this.slots.values()) {
      clearSlotTimer(slot);
      if (slot.process) {
        stopProcess(slot.process);
        slot.process = null;
      }
    }
    this.slots.clear();
  }

  /** Test/diagnostic view of live spare processes. */
  spareCount(): number {
    return [...this.slots.values()].filter((slot) => slot.process && !slot.process.exited).length;
  }

  private slotFor(launch: ClaudeStreamLaunch): SpareSlot {
    const existing = this.slots.get(launch.key);
    if (existing) {
      existing.launch = launch;
      return existing;
    }
    const slot: SpareSlot = {
      process: null,
      launch,
      lastUsedAt: this.now(),
      recycleTimer: null,
    };
    this.slots.set(launch.key, slot);
    this.evictExcessSlots();
    return slot;
  }

  private evictExcessSlots(): void {
    if (this.slots.size <= MAX_SPARE_SLOTS) {
      return;
    }
    const oldest = [...this.slots.entries()]
      .sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)
      .slice(0, this.slots.size - MAX_SPARE_SLOTS);
    for (const [key, slot] of oldest) {
      clearSlotTimer(slot);
      if (slot.process) {
        stopProcess(slot.process);
      }
      this.slots.delete(key);
    }
  }

  private takeSpare(slot: SpareSlot): ClaudeProcess | null {
    const spare = slot.process;
    slot.process = null;
    clearSlotTimer(slot);
    if (!spare) {
      return null;
    }
    if (spare.exited || this.now() - spare.spawnedAt >= SPARE_MAX_AGE_MS) {
      stopProcess(spare);
      return null;
    }
    return spare;
  }

  private replenish(slot: SpareSlot): void {
    if (this.stopped || this.slots.get(slot.launch.key) !== slot) {
      return;
    }
    if (this.now() - slot.lastUsedAt >= SPARE_KEEP_AFTER_USE_MS) {
      this.slots.delete(slot.launch.key);
      return;
    }
    if (slot.process && !slot.process.exited) {
      return;
    }
    try {
      slot.process = this.start(slot.launch);
    } catch {
      slot.process = null;
      return;
    }
    clearSlotTimer(slot);
    slot.recycleTimer = setTimeout(() => {
      slot.recycleTimer = null;
      if (slot.process) {
        stopProcess(slot.process);
        slot.process = null;
      }
      this.replenish(slot);
    }, SPARE_MAX_AGE_MS);
    slot.recycleTimer.unref();
  }

  private start(launch: ClaudeStreamLaunch): ClaudeProcess {
    const scratchDir = mkdtempSync(join(tmpdir(), "housemate-claude-"));
    let attachment: ClaudeProcessAttachment | null = null;
    let child: ChildProcessWithoutNullStreams;
    try {
      attachment = launch.perProcess?.() ?? null;
      child = this.spawnImpl(launch.command, attachment ? [...launch.args, ...attachment.args] : launch.args, {
        cwd: scratchDir,
        env: launch.env,
      });
    } catch (error) {
      attachment?.release();
      rmSync(scratchDir, { recursive: true, force: true });
      throw error;
    }
    const proc: ClaudeProcess = {
      child,
      scratchDir,
      spawnedAt: this.now(),
      attachment,
      exited: false,
      stderr: "",
    };
    child.stderr.on("data", (chunk) => {
      proc.stderr = `${proc.stderr}${String(chunk)}`.slice(-STDERR_LIMIT);
    });
    child.stdin.on("error", () => undefined);
    const markExited = (): void => {
      if (!proc.exited) {
        proc.exited = true;
        attachment?.release();
        rmSync(scratchDir, { recursive: true, force: true });
      }
    };
    child.once("exit", markExited);
    child.once("error", markExited);
    return proc;
  }

  private runTurn(
    proc: ClaudeProcess,
    options: ClaudeStreamRunOptions,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const { child } = proc;
      const maxDeltaBytes = options.maxOutputBytes ?? DEFAULT_MAX_DELTA_BYTES;
      let buffered = "";
      let protocolBytes = 0;
      let deltaBytes = 0;
      let structuredBlockIndex: number | null = null;
      let structuredBlockClosed = false;
      let structuredJson = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let settled = false;
      // Text blocks either side of a tool call are one spoken answer.
      const textBlocks: string[] = [];
      let textBlockIndex: number | null = null;
      let unbind: (() => void) | null = null;

      const finish = (error: Error | null, result?: Record<string, unknown>): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        unbind?.();
        child.stdout.off("data", onData);
        child.off("exit", onExit);
        child.off("error", onError);
        if (options.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }
        if (error) {
          reject(error);
        } else {
          resolve(result as Record<string, unknown>);
        }
      };
      const emitDelta = (delta: string): void => {
        if (!options.onDelta || !delta) {
          return;
        }
        deltaBytes += Buffer.byteLength(delta, "utf8");
        if (deltaBytes > maxDeltaBytes) {
          throw new Error(`Model backend output exceeded ${maxDeltaBytes} bytes`);
        }
        options.onDelta(delta);
      };
      const handleEvent = (event: Record<string, unknown>): void => {
        if (event.type === "result") {
          finish(null, !options.structured && textBlocks.length > 1
            ? { ...event, result: textBlocks.join(" ") }
            : event);
          return;
        }
        if (event.type !== "stream_event" || !isRecord(event.event)) {
          return;
        }
        const streamEvent = event.event;
        const index = typeof streamEvent.index === "number" ? streamEvent.index : null;
        if (streamEvent.type === "message_start") {
          traceSafely(options, { kind: "message_start" });
          // Each API round restarts block indexes; only the first StructuredOutput block may stream.
          if (structuredBlockIndex !== null) {
            structuredBlockClosed = true;
          }
          if (isRecord(streamEvent.message) && isRecord(streamEvent.message.usage)) {
            inputTokens += tokenCount(streamEvent.message.usage.input_tokens)
              + tokenCount(streamEvent.message.usage.cache_read_input_tokens)
              + tokenCount(streamEvent.message.usage.cache_creation_input_tokens);
          }
          return;
        }
        if (streamEvent.type === "message_delta") {
          if (isRecord(streamEvent.usage)) {
            outputTokens += tokenCount(streamEvent.usage.output_tokens);
          }
          if (structuredBlockClosed && structuredJson && !options.awaitCliResult) {
            // The CLI spends one more API round acknowledging the tool call; the
            // caller validates the schema locally, so the closed block is final.
            let structuredOutput: unknown;
            try {
              structuredOutput = JSON.parse(structuredJson);
            } catch {
              return;
            }
            finish(null, {
              type: "result",
              subtype: "success",
              structured_output: structuredOutput,
              usage: {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
              },
            });
          }
          return;
        }
        if (streamEvent.type === "content_block_start" && isRecord(streamEvent.content_block)) {
          const block = streamEvent.content_block;
          if (block.type === "thinking" || block.type === "redacted_thinking") {
            traceSafely(options, { kind: "thinking" });
          }
          if (block.type === "tool_use" && block.name !== "StructuredOutput") {
            traceSafely(options, { kind: "tool_use" });
          }
          if (!options.structured && block.type === "tool_use" && typeof block.name === "string") {
            options.onToolUse?.(block.name);
            return;
          }
          if (!options.structured && block.type === "text") {
            if (textBlocks.length > 0) {
              emitDelta(" ");
            }
            textBlocks.push("");
            textBlockIndex = index;
            return;
          }
          if (
            options.structured
            && structuredBlockIndex === null
            && block.type === "tool_use"
            && block.name === "StructuredOutput"
          ) {
            structuredBlockIndex = index;
          }
          return;
        }
        if (streamEvent.type === "content_block_stop" && index !== null && index === structuredBlockIndex) {
          structuredBlockClosed = true;
          return;
        }
        if (streamEvent.type === "content_block_stop" && index !== null && index === textBlockIndex) {
          textBlockIndex = null;
          options.onTextBoundary?.();
          return;
        }
        if (streamEvent.type !== "content_block_delta" || !isRecord(streamEvent.delta)) {
          return;
        }
        const delta = streamEvent.delta;
        if (options.structured) {
          if (
            !structuredBlockClosed
            && index !== null
            && index === structuredBlockIndex
            && delta.type === "input_json_delta"
            && typeof delta.partial_json === "string"
          ) {
            structuredJson += delta.partial_json;
            emitDelta(delta.partial_json);
          }
          return;
        }
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          if (textBlocks.length === 0) {
            textBlocks.push("");
          }
          textBlocks[textBlocks.length - 1] += delta.text;
          emitDelta(delta.text);
        }
      };
      const onData = (chunk: unknown): void => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        protocolBytes += Buffer.byteLength(text, "utf8");
        if (protocolBytes > MAX_PROTOCOL_BYTES) {
          finish(new Error(`Model backend output exceeded ${MAX_PROTOCOL_BYTES} bytes`));
          return;
        }
        buffered += text;
        let newline = buffered.indexOf("\n");
        while (newline >= 0 && !settled) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
          if (!line) {
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (!isRecord(parsed)) {
            continue;
          }
          try {
            handleEvent(parsed);
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        }
      };
      const onExit = (code: number | null): void => {
        const detail = proc.stderr.trim();
        finish(new Error(detail || `Model backend exited ${code ?? "unexpectedly"}`));
      };
      const onError = (error: Error): void => finish(error);
      const onAbort = (): void => {
        finish(abortErrorFromSignal(options.signal as AbortSignal));
      };
      const timer = setTimeout(() => {
        finish(new Error(`Model backend timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);

      if (proc.exited) {
        finish(new Error("Claude process exited before the turn started"));
        return;
      }
      child.stdout.on("data", onData);
      child.once("exit", onExit);
      child.once("error", onError);
      if (options.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (proc.attachment && options.bindProcess) {
        try {
          unbind = options.bindProcess(proc.attachment.handle);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      child.stdin.write(`${JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: options.prompt,
        },
      })}\n`);
      traceSafely(options, { kind: "sent" });
    });
  }
}

function traceSafely(options: ClaudeStreamRunOptions, event: ModelStreamTrace): void {
  try {
    options.onTrace?.(event);
  } catch {
    // Timing must never change a turn.
  }
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
}

function stopProcess(proc: ClaudeProcess): void {
  if (proc.exited) {
    return;
  }
  try {
    proc.child.stdin.end();
  } catch {
    // stdin already closed.
  }
  signalProcess(proc, "SIGTERM");
  const forceKill = setTimeout(() => {
    if (!proc.exited) {
      signalProcess(proc, "SIGKILL");
    }
  }, PROCESS_TERMINATION_GRACE_MS);
  forceKill.unref();
}

function signalProcess(proc: ClaudeProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && proc.child.pid) {
      process.kill(-proc.child.pid, signal);
      return;
    }
  } catch {
    // Fall back to the direct child below.
  }
  try {
    proc.child.kill(signal);
  } catch {
    // The process already exited.
  }
}

function clearSlotTimer(slot: SpareSlot): void {
  if (slot.recycleTimer) {
    clearTimeout(slot.recycleTimer);
    slot.recycleTimer = null;
  }
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

let sharedPool: ClaudeStreamPool | null = null;

export function claudeStreamPool(): ClaudeStreamPool {
  sharedPool ??= new ClaudeStreamPool();
  return sharedPool;
}

export function stopClaudeStreams(): void {
  sharedPool?.stop();
  sharedPool = null;
}
