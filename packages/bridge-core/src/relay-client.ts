import { EventEmitter } from "node:events";

import WebSocket from "ws";

/**
 * Relay-first (brief §3): the bridge always opens an outbound WSS to the api
 * gateway `/bridge/relay`, authenticated with the device token (B08 devices;
 * A04 device-code flow for first sign-in). A browser client that cannot reach
 * loopback rides this tunnel; the api scopes RPC frames per session and never
 * persists payloads.
 *
 * Reconnection: exponential backoff with full jitter, capped, so many bridges
 * reconnecting after an api restart do not thunder-herd it.
 */

export interface RelayClientOptions {
  readonly url: string;
  readonly deviceToken: string;
  readonly heartbeatMs?: number;
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Injectable for tests; defaults to the real `ws` constructor. */
  readonly WebSocketImpl?: typeof WebSocket;
}

export type RelayConnectionState = "connecting" | "open" | "closed";

interface RelayClientEvents {
  state: [state: RelayConnectionState];
  message: [data: string];
  error: [error: Error];
}

export class RelayClient extends EventEmitter {
  // Narrows `EventEmitter#on`/`emit` for this class's three events without the
  // class+interface declaration-merging pattern eslint forbids here.
  override on<K extends keyof RelayClientEvents>(
    event: K,
    listener: (...args: RelayClientEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override emit<K extends keyof RelayClientEvents>(
    event: K,
    ...args: RelayClientEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  private socket: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private attempts = 0;
  private closedByUser = false;
  private readonly heartbeatMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly WebSocketImpl: typeof WebSocket;

  constructor(private readonly options: RelayClientOptions) {
    super();
    this.heartbeatMs = options.heartbeatMs ?? 20_000;
    this.minBackoffMs = options.minBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  }

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  send(data: string): boolean {
    if (this.socket?.readyState !== this.WebSocketImpl.OPEN) return false;
    this.socket.send(data);
    return true;
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.socket?.close(1000, "client closing");
    this.socket = undefined;
  }

  get state(): RelayConnectionState {
    if (this.socket === undefined) return "closed";
    return this.socket.readyState === this.WebSocketImpl.OPEN ? "open" : "connecting";
  }

  private open(): void {
    this.emit("state", "connecting");
    const socket = new this.WebSocketImpl(this.options.url, {
      headers: { authorization: `Bearer ${this.options.deviceToken}` },
    });
    this.socket = socket;

    socket.on("open", () => {
      this.attempts = 0;
      this.emit("state", "open");
      this.startHeartbeat();
    });
    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : Buffer.from(data as ArrayBuffer).toString("utf8");
      this.emit("message", text);
    });
    socket.on("close", () => {
      this.stopHeartbeat();
      this.emit("state", "closed");
      if (!this.closedByUser) this.scheduleReconnect();
    });
    socket.on("error", (error: Error) => {
      this.emit("error", error);
    });
  }

  private scheduleReconnect(): void {
    this.attempts += 1;
    const exp = Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** (this.attempts - 1));
    const jittered = Math.random() * exp;
    this.reconnectTimer = setTimeout(() => {
      if (!this.closedByUser) this.open();
    }, jittered);
    this.reconnectTimer.unref?.();
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === this.WebSocketImpl.OPEN) this.socket.ping();
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }
}
