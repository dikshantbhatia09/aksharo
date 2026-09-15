/**
 * The realtime client for `apps/api/src/realtime` (CONTRACTS §7).
 *
 * Realtime is a courtesy channel, not a source of truth: every event it carries
 * is also readable over REST, so this client never buffers, never sequences and
 * never resumes. It reconnects, re-subscribes, and tells the caller to re-read.
 *
 * The access token travels in `Sec-WebSocket-Protocol` because that is the only
 * header a browser can set on an upgrade, and a token in a query string ends up
 * in every access log (THREAT-MODEL T21).
 */

export const REALTIME_PROTOCOL = "aksharo.v1";

/** CONTRACTS §7 events, with the payload the gateway puts in `data`. */
export interface RealtimeEventMap {
  "job.progress": { jobId: string; progress: number; etaMs?: number; message?: string };
  "job.completed": { jobId: string; status: string; type?: string; error?: string };
  "edg.ops": { revision: number; ops: unknown[]; source: string };
  "comment.added": { commentId: string; projectId: string; authorId: string; at: string };
  /**
   * REP-006. Emitted on the WORKSPACE room, because a repurposing run outlives
   * any one project. The payload is a pointer plus enough to render a stage rail
   * without a refetch; it carries no job id, queue name or provider error.
   */
  "repurpose.stage.changed": {
    runId: string;
    status: string;
    stage: string;
    progress: number;
    message: string;
    at: string;
  };
}

export type RealtimeEventName = keyof RealtimeEventMap;

export interface RealtimeEvent<K extends RealtimeEventName = RealtimeEventName> {
  room: string;
  event: K;
  data: RealtimeEventMap[K];
  at: string;
}

export type RealtimeStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/** Close codes the gateway sends (realtime/README.md). */
export const CLOSE_CODES = {
  protocolError: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  heartbeatTimeout: 4408,
  shuttingDown: 4503,
} as const;

export interface RealtimeClientOptions {
  /** `ws(s)://host/realtime`. */
  url: string;
  /** The current access token, re-read on every connection attempt. */
  getAccessToken: () => string | null;
  /** Called on a 4401 so the shell can rotate before the next attempt. */
  refreshAccessToken?: () => Promise<string | null>;
  /**
   * Called after every `welcome`, once the rooms have been re-subscribed.
   * This is where a consumer re-reads what it missed (README §Reconnection).
   */
  onResync?: (rooms: readonly string[]) => void;
  onStatusChange?: (status: RealtimeStatus) => void;
  onEvent?: (event: RealtimeEvent) => void;
  /** Injected in tests; defaults to the platform `WebSocket`. */
  socketFactory?: (url: string, protocols: string[]) => WebSocketLike;
  /** Injected in tests so backoff does not make the suite slow. */
  setTimeoutFn?: (handler: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Injected in tests to make jitter deterministic. */
  random?: () => number;
}

/** The slice of `WebSocket` this client uses, so a fake is three methods. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/** 1 s, 2 s, 4 s … capped at 30 s, with jitter (README §Reconnection). */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
  // Full jitter over the lower half: a restarting API must not be met with a
  // thundering herd of clients that all waited exactly the same time.
  return Math.round(exponential * (0.5 + random() * 0.5));
}

export class RealtimeClient {
  private readonly options: RealtimeClientOptions;
  private socket: WebSocketLike | null = null;
  private status: RealtimeStatus = "idle";
  private readonly rooms = new Set<string>();
  private readonly forbiddenRooms = new Set<string>();
  private attempt = 0;
  private reconnectHandle: unknown = null;
  private stopped = true;
  private readonly handlers = new Map<string, Set<(event: RealtimeEvent) => void>>();

  constructor(options: RealtimeClientOptions) {
    this.options = options;
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }

  getRooms(): string[] {
    return [...this.rooms];
  }

  /** Open the connection. Idempotent. */
  connect(): void {
    this.stopped = false;
    if (this.socket !== null) return;
    this.open();
  }

  /** Close for good: no reconnect, no rooms retained. */
  disconnect(): void {
    this.stopped = true;
    this.clearReconnect();
    this.rooms.clear();
    this.socket?.close(1000, "client disconnect");
    this.socket = null;
    this.setStatus("closed");
  }

  /** Join rooms. Held across reconnects and re-sent after every `welcome`. */
  subscribe(...rooms: string[]): void {
    let added = false;
    for (const room of rooms) {
      if (this.forbiddenRooms.has(room)) continue;
      if (!this.rooms.has(room)) {
        this.rooms.add(room);
        added = true;
      }
    }
    if (added && this.status === "open") this.sendFrame({ t: "subscribe", rooms: [...this.rooms] });
  }

  unsubscribe(...rooms: string[]): void {
    const removed = rooms.filter((room) => this.rooms.delete(room));
    if (removed.length > 0 && this.status === "open") {
      this.sendFrame({ t: "unsubscribe", rooms: removed });
    }
  }

  /** Listen to one event name. Returns the unsubscribe function. */
  on<K extends RealtimeEventName>(
    event: K,
    handler: (event: RealtimeEvent<K>) => void,
  ): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as (event: RealtimeEvent) => void);
    this.handlers.set(event, set);
    return () => {
      set.delete(handler as (event: RealtimeEvent) => void);
    };
  }

  private open(): void {
    const token = this.options.getAccessToken();
    // eslint-disable-next-line security/detect-possible-timing-attacks -- equality check on a null/undefined/status/hash sentinel, not a secret or MAC comparison -- reviewed for M06's eslint-plugin-security promotion
    if (token === null) {
      this.setStatus("closed");
      return;
    }

    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    const factory =
      this.options.socketFactory ??
      ((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike);
    const socket = factory(this.options.url, [REALTIME_PROTOCOL, `bearer.${token}`]);
    this.socket = socket;

    socket.onopen = () => {
      // `welcome` is what actually confirms the handshake; `open` only means the
      // upgrade succeeded, so nothing is sent until the server speaks first.
      this.attempt = 0;
    };

    socket.onmessage = (event) => {
      this.handleFrame(event.data);
    };

    socket.onerror = () => {
      // A socket error is always followed by a close; the close handler owns
      // the reconnect so there is exactly one path.
    };

    socket.onclose = (event) => {
      this.socket = null;
      this.setStatus("closed");
      if (this.stopped) return;
      void this.handleClose(event.code);
    };
  }

  private async handleClose(code: number): Promise<void> {
    if (code === CLOSE_CODES.unauthenticated && this.options.refreshAccessToken !== undefined) {
      // "Refresh the access token first" (README §Reconnection). One attempt: if
      // the family is revoked, the shell has already been told to sign out.
      const token = await this.options.refreshAccessToken();
      // eslint-disable-next-line security/detect-possible-timing-attacks -- equality check on a null/undefined/status/hash sentinel, not a secret or MAC comparison -- reviewed for M06's eslint-plugin-security promotion
      if (token === null) {
        this.stopped = true;
        return;
      }
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    this.attempt += 1;
    const delay = backoffDelayMs(this.attempt, this.options.random ?? Math.random);
    this.setStatus("reconnecting");
    const schedule = this.options.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
    this.reconnectHandle = schedule(() => {
      this.reconnectHandle = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectHandle === null) return;
    const clear = this.options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as never));
    clear(this.reconnectHandle);
    this.reconnectHandle = null;
  }

  private handleFrame(raw: unknown): void {
    if (typeof raw !== "string") return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (frame["t"]) {
      case "welcome": {
        this.setStatus("open");
        if (this.rooms.size > 0) this.sendFrame({ t: "subscribe", rooms: [...this.rooms] });
        this.options.onResync?.([...this.rooms]);
        return;
      }
      case "subscribed": {
        const refused = Array.isArray(frame["refused"]) ? frame["refused"] : [];
        for (const entry of refused) {
          const { room, reason } = entry as { room?: unknown; reason?: unknown };
          if (typeof room !== "string") continue;
          this.rooms.delete(room);
          // `forbidden` and `not_found` will not become allowed by retrying, so
          // the room is remembered and never asked for again on this client.
          if (reason === "forbidden" || reason === "not_found") this.forbiddenRooms.add(room);
        }
        return;
      }
      case "event": {
        const { room, event, data, at } = frame as {
          room?: unknown;
          event?: unknown;
          data?: unknown;
          at?: unknown;
        };
        if (typeof room !== "string" || typeof event !== "string") return;
        const payload: RealtimeEvent = {
          room,
          event: event as RealtimeEventName,
          data: data as RealtimeEventMap[RealtimeEventName],
          at: typeof at === "string" ? at : new Date().toISOString(),
        };
        this.options.onEvent?.(payload);
        for (const handler of this.handlers.get(event) ?? []) handler(payload);
        return;
      }
      default:
        return;
    }
  }

  /** Application-level liveness check, for surfaces that cannot see pings. */
  ping(): void {
    this.sendFrame({ t: "ping" });
  }

  private sendFrame(frame: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(frame));
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatusChange?.(status);
  }
}

/** `project:{projectId}` and `workspace:{workspaceId}` (CONTRACTS §7). */
export const rooms = {
  project: (projectId: string): string => `project:${projectId}`,
  workspace: (workspaceId: string): string => `workspace:${workspaceId}`,
} as const;
