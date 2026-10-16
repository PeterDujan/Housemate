import type { AppConfig } from "./config.js";
import type { HaCommandOptions } from "./ha-history.js";
import { nonBlankString } from "./value-guards.js";

export type HaWebSocketState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "stopped"
  | "error";

export interface HaWebSocketSnapshot {
  readonly state: HaWebSocketState;
  readonly url: string;
  readonly connected: boolean;
  readonly reconnectAttempt: number;
  readonly lastConnectedAt: string | null;
  readonly lastError: string | null;
}

export interface HaWebSocketMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface HaSocketEvent {
  readonly data?: unknown;
  readonly message?: string;
  readonly error?: unknown;
}

export type HaSocketEventName = "open" | "message" | "close" | "error";

export interface HaSocket {
  addEventListener(type: HaSocketEventName, listener: (event: HaSocketEvent) => void): void;
  send(data: string): void;
  close(): void;
}

export interface HaReconnectScheduler {
  schedule(delayMs: number, callback: () => void): () => void;
}

export interface HaWebSocketClientOptions {
  readonly url: string;
  readonly token: string;
  readonly socketFactory?: (url: string) => HaSocket;
  readonly scheduler?: HaReconnectScheduler;
  readonly reconnectInitialDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  readonly commandTimeoutMs?: number;
  readonly maxMessageBytes?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatScheduler?: HaReconnectScheduler;
  readonly now?: () => Date;
  readonly onMessage?: (message: HaWebSocketMessage) => void;
  readonly onStateChange?: (snapshot: HaWebSocketSnapshot) => void;
}

interface PendingCommand {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

export function createHomeAssistantWebSocketClient(
  config: Pick<AppConfig, "haUrl" | "homeAssistantToken">,
  options: Omit<HaWebSocketClientOptions, "token" | "url"> = {},
): HaWebSocketClient {
  if (!config.homeAssistantToken) {
    throw new Error("Home Assistant websocket client requires HA_TOKEN");
  }
  return new HaWebSocketClient({
    ...options,
    url: config.haUrl,
    token: config.homeAssistantToken,
  });
}

export function homeAssistantWebSocketUrl(haUrl: string): string {
  const url = new URL(haUrl);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = "/api/websocket";
  }
  return url.toString();
}

export class HaWebSocketClient {
  private readonly url: string;
  private readonly token: string;
  private readonly socketFactory: (url: string) => HaSocket;
  private readonly scheduler: HaReconnectScheduler;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly commandTimeoutMs: number;
  private readonly maxMessageBytes: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatScheduler: HaReconnectScheduler;
  private readonly now: () => Date;
  private readonly onMessage: ((message: HaWebSocketMessage) => void) | undefined;
  private readonly onStateChange: ((snapshot: HaWebSocketSnapshot) => void) | undefined;
  private socket: HaSocket | null = null;
  private cancelReconnect: (() => void) | null = null;
  private cancelHeartbeat: (() => void) | null = null;
  private state: HaWebSocketState = "idle";
  private reconnectAttempt = 0;
  private lastConnectedAt: string | null = null;
  private lastError: string | null = null;
  private stopped = false;
  private nextCommandId = 1;
  private readonly pendingCommands = new Map<number, PendingCommand>();
  private readonly expiredCommandIds = new Set<number>();

  constructor(options: HaWebSocketClientOptions) {
    this.url = homeAssistantWebSocketUrl(options.url);
    this.token = options.token;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.reconnectInitialDelayMs = options.reconnectInitialDelayMs ?? 1000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30000;
    this.commandTimeoutMs = normalizeCommandTimeoutMs(options.commandTimeoutMs);
    this.maxMessageBytes = normalizeMaxMessageBytes(options.maxMessageBytes);
    this.heartbeatIntervalMs = normalizeHeartbeatIntervalMs(options.heartbeatIntervalMs);
    this.heartbeatScheduler = options.heartbeatScheduler ?? defaultHeartbeatScheduler;
    this.now = options.now ?? (() => new Date());
    this.onMessage = options.onMessage;
    this.onStateChange = options.onStateChange;
  }

  start(): void {
    if (this.state === "connecting" || this.state === "authenticating" || this.state === "connected") {
      return;
    }
    this.stopped = false;
    this.clearReconnect();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnect();
    this.clearHeartbeat();
    this.rejectPendingCommands("Home Assistant websocket stopped");
    this.expiredCommandIds.clear();
    this.setState("stopped");
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  snapshot(): HaWebSocketSnapshot {
    return {
      state: this.state,
      url: this.url,
      connected: this.state === "connected",
      reconnectAttempt: this.reconnectAttempt,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
    };
  }

  sendMessage(message: HaWebSocketMessage): void {
    if (this.state !== "connected" || !this.socket) {
      throw new Error("Home Assistant websocket is not connected");
    }
    this.socket.send(JSON.stringify(message));
  }

  sendCommand(
    command: Readonly<Record<string, unknown>>,
    options: HaCommandOptions = {},
  ): Promise<unknown> {
    if (this.state !== "connected" || !this.socket) {
      return Promise.reject(new Error("Home Assistant websocket is not connected"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(commandAbortError(options.signal));
    }
    const id = this.nextCommandId;
    this.nextCommandId += 1;
    const payload = { ...command, id };
    const socket = this.socket;
    return new Promise((resolve, reject) => {
      let abortListener: (() => void) | null = null;
      const timer = setTimeout(() => {
        const pending = this.pendingCommands.get(id);
        if (!pending) {
          return;
        }
        this.pendingCommands.delete(id);
        this.rememberExpiredCommand(id);
        const error = new Error(`Home Assistant command timed out after ${this.commandTimeoutMs}ms`);
        pending.cleanup();
        pending.reject(error);
        this.failConnection(socket, error);
      }, this.commandTimeoutMs);
      const pending: PendingCommand = {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          if (abortListener && options.signal) {
            options.signal.removeEventListener("abort", abortListener);
            abortListener = null;
          }
        },
      };
      this.pendingCommands.set(id, pending);
      if (options.signal) {
        abortListener = () => {
          const active = this.pendingCommands.get(id);
          if (!active) {
            return;
          }
          this.pendingCommands.delete(id);
          this.rememberExpiredCommand(id);
          active.cleanup();
          active.reject(commandAbortError(options.signal as AbortSignal));
        };
        if (options.signal.aborted) {
          abortListener();
          return;
        }
        options.signal.addEventListener("abort", abortListener, { once: true });
      }
      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        this.pendingCommands.delete(id);
        pending.cleanup();
        const sendError = error instanceof Error ? error : new Error(String(error));
        reject(sendError);
        this.failConnection(socket, sendError);
      }
    });
  }

  reconnect(reason = "Home Assistant websocket connection was invalidated"): void {
    if (this.stopped) {
      return;
    }
    const socket = this.socket;
    if (socket) {
      this.failConnection(socket, new Error(reason));
      return;
    }
    this.start();
  }

  private connect(): void {
    this.setState("connecting");
    this.lastError = null;
    const socket = this.socketFactory(this.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (!this.stopped && this.state === "connecting") {
        this.setState("connecting");
      }
    });
    socket.addEventListener("message", (event) => this.handleSocketMessage(socket, event.data));
    socket.addEventListener("close", () => this.handleSocketClose(socket));
    socket.addEventListener("error", (event) => {
      this.failConnection(socket, new Error(eventMessage(event)));
    });
  }

  private handleSocketMessage(socket: HaSocket, data: unknown): void {
    if (this.stopped || socket !== this.socket) {
      return;
    }

    let message: HaWebSocketMessage;
    try {
      message = parseMessage(data, this.maxMessageBytes);
    } catch (error) {
      this.failConnection(
        socket,
        error instanceof HaWebSocketFrameLimitError
          ? error
          : new Error("Home Assistant websocket sent an invalid frame"),
      );
      return;
    }
    if (message.type === "auth_required") {
      this.setState("authenticating");
      socket.send(JSON.stringify({ type: "auth", access_token: this.token }));
      return;
    }
    if (message.type === "auth_ok") {
      this.reconnectAttempt = 0;
      this.lastConnectedAt = this.now().toISOString();
      this.setState("connected");
      this.scheduleHeartbeat(socket);
      return;
    }
    if (message.type === "auth_invalid") {
      this.setState("error");
      this.stopped = true;
      this.lastError = nonBlankString(message.message) ?? "Home Assistant authentication failed";
      socket.close();
      return;
    }
    if (this.state === "connected") {
      if (message.type === "result" && typeof message.id === "number") {
        const pending = this.pendingCommands.get(message.id);
        if (pending) {
          this.pendingCommands.delete(message.id);
          pending.cleanup();
          if (message.success === false) {
            pending.reject(new Error(nonBlankString(message.error) ?? nonBlankString(message.message) ?? "Home Assistant command failed"));
          } else {
            pending.resolve(message.result ?? null);
          }
          return;
        }
        if (this.expiredCommandIds.delete(message.id)) {
          return;
        }
        // A result without a live matching command is never an event. Dropping
        // it prevents late history/registry arrays from being misclassified as
        // current state by downstream consumers.
        return;
      }
      this.onMessage?.(message);
    }
  }

  private handleSocketClose(socket: HaSocket): void {
    if (socket !== this.socket) {
      return;
    }
    this.socket = null;
    this.clearHeartbeat();
    this.rejectPendingCommands("Home Assistant websocket disconnected");
    this.expiredCommandIds.clear();
    if (this.stopped) {
      return;
    }
    this.scheduleReconnect();
  }

  private failConnection(socket: HaSocket, error: Error): void {
    if (this.stopped || socket !== this.socket) {
      return;
    }
    this.socket = null;
    this.clearHeartbeat();
    this.lastError = error.message;
    this.rejectPendingCommands("Home Assistant websocket disconnected");
    this.expiredCommandIds.clear();
    socket.close();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.setState("reconnecting");
    this.reconnectAttempt += 1;
    const delayMs = Math.min(
      this.reconnectInitialDelayMs * 2 ** (this.reconnectAttempt - 1),
      this.reconnectMaxDelayMs,
    );
    this.cancelReconnect = this.scheduler.schedule(delayMs, () => {
      this.cancelReconnect = null;
      if (!this.stopped) {
        this.connect();
      }
    });
  }

  private clearReconnect(): void {
    this.cancelReconnect?.();
    this.cancelReconnect = null;
  }

  private scheduleHeartbeat(socket: HaSocket): void {
    this.clearHeartbeat();
    if (this.heartbeatIntervalMs === 0 || this.stopped || socket !== this.socket || this.state !== "connected") {
      return;
    }
    this.cancelHeartbeat = this.heartbeatScheduler.schedule(this.heartbeatIntervalMs, () => {
      this.cancelHeartbeat = null;
      if (this.stopped || socket !== this.socket || this.state !== "connected") {
        return;
      }
      void this.sendCommand({ type: "get_config" }).then(
        () => this.scheduleHeartbeat(socket),
        () => {
          // A command timeout already tears down the half-open connection.
          // A prompt HA error still proves the application channel is alive.
          if (!this.stopped && socket === this.socket && this.state === "connected") {
            this.scheduleHeartbeat(socket);
          }
        },
      );
    });
  }

  private clearHeartbeat(): void {
    this.cancelHeartbeat?.();
    this.cancelHeartbeat = null;
  }

  private rejectPendingCommands(message: string): void {
    for (const pending of this.pendingCommands.values()) {
      pending.cleanup();
      pending.reject(new Error(message));
    }
    this.pendingCommands.clear();
  }

  private rememberExpiredCommand(id: number): void {
    this.expiredCommandIds.add(id);
    while (this.expiredCommandIds.size > MAX_EXPIRED_COMMAND_IDS) {
      const oldestId = this.expiredCommandIds.values().next().value as number | undefined;
      if (oldestId === undefined) {
        break;
      }
      this.expiredCommandIds.delete(oldestId);
    }
  }

  private setState(next: HaWebSocketState): void {
    this.state = next;
    this.onStateChange?.(this.snapshot());
  }
}

const defaultScheduler: HaReconnectScheduler = {
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_HA_WEBSOCKET_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_HA_WEBSOCKET_MESSAGE_BYTES = 64 * 1024 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_HEARTBEAT_INTERVAL_MS = 300_000;
const MAX_EXPIRED_COMMAND_IDS = 256;

function normalizeCommandTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Home Assistant command timeout must be a positive finite number");
  }
  return Math.max(1, Math.min(Math.floor(value), MAX_COMMAND_TIMEOUT_MS));
}

function normalizeMaxMessageBytes(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_HA_WEBSOCKET_MESSAGE_BYTES;
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_HA_WEBSOCKET_MESSAGE_BYTES) {
    throw new Error(
      `Home Assistant websocket message limit must be an integer from 1 to ${MAX_HA_WEBSOCKET_MESSAGE_BYTES}`,
    );
  }
  return value;
}

function normalizeHeartbeatIntervalMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_HEARTBEAT_INTERVAL_MS;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Home Assistant heartbeat interval must be a non-negative finite number");
  }
  return Math.min(Math.floor(value), MAX_HEARTBEAT_INTERVAL_MS);
}

const defaultHeartbeatScheduler: HaReconnectScheduler = {
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

function defaultSocketFactory(url: string): HaSocket {
  if (!globalThis.WebSocket) {
    throw new Error("global WebSocket is not available in this Node.js runtime");
  }
  return new globalThis.WebSocket(url) as unknown as HaSocket;
}

function parseMessage(
  data: unknown,
  maxMessageBytes: number,
): HaWebSocketMessage {
  if (typeof data !== "string") {
    throw new Error("Home Assistant websocket message must be text JSON");
  }
  if (Buffer.byteLength(data, "utf8") > maxMessageBytes) {
    throw new HaWebSocketFrameLimitError(maxMessageBytes);
  }
  const parsed = JSON.parse(data) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Home Assistant websocket message must be a JSON object");
  }
  const message = parsed as Partial<HaWebSocketMessage>;
  if (typeof message.type !== "string" || !message.type.trim()) {
    throw new Error("Home Assistant websocket message type is required");
  }
  return parsed as HaWebSocketMessage;
}

class HaWebSocketFrameLimitError extends Error {
  constructor(maxMessageBytes: number) {
    super(
      `Home Assistant websocket frame exceeded its ${maxMessageBytes}-byte limit`,
    );
    this.name = "HaWebSocketFrameLimitError";
  }
}

function commandAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const error = reason instanceof Error
    ? new Error(reason.message)
    : new Error("Home Assistant command aborted");
  error.name = "AbortError";
  return error;
}

function eventMessage(event: HaSocketEvent): string {
  return nonBlankString(event.message) ?? nonBlankString(event.error) ?? "Home Assistant websocket error";
}
