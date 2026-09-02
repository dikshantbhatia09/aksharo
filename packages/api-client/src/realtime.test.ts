import { describe, expect, it, vi } from "vitest";

import {
  backoffDelayMs,
  CLOSE_CODES,
  REALTIME_PROTOCOL,
  RealtimeClient,
  rooms,
} from "./realtime.js";

import type { WebSocketLike } from "./realtime.js";

class FakeSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: string[] = [];
  closed: { code?: number } | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closed = code === undefined ? {} : { code };
  }

  /** Test helper: deliver a server frame. */
  receive(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }
}

/** A client wired to fake sockets and a fake clock. */
function harness(options: { token?: string | null; refresh?: () => Promise<string | null> } = {}) {
  const accessToken = "token" in options ? options.token : "access-token";
  const sockets: FakeSocket[] = [];
  const timers: { handler: () => void; ms: number }[] = [];
  const events: { event: string; data: unknown }[] = [];
  const statuses: string[] = [];
  const resyncs: string[][] = [];

  const client = new RealtimeClient({
    url: "ws://api.test/realtime",
    getAccessToken: () => accessToken ?? null,
    ...(options.refresh === undefined ? {} : { refreshAccessToken: options.refresh }),
    socketFactory: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    setTimeoutFn: (handler, ms) => {
      timers.push({ handler, ms });
      return timers.length - 1;
    },
    clearTimeoutFn: () => undefined,
    random: () => 0.5,
    onEvent: (event) => events.push({ event: event.event, data: event.data }),
    onStatusChange: (status) => statuses.push(status),
    onResync: (held) => resyncs.push([...held]),
  });

  const welcome = (socket: FakeSocket): void => {
    socket.onopen?.({});
    socket.receive({
      t: "welcome",
      connectionId: "01JC",
      userId: "01JU",
      workspaceId: "01JW",
      heartbeatMs: 30_000,
      protocol: REALTIME_PROTOCOL,
    });
  };

  return { client, sockets, timers, events, statuses, resyncs, welcome };
}

describe("backoffDelayMs", () => {
  it("doubles and then caps at 30 s", () => {
    const noJitter = () => 1;
    expect(backoffDelayMs(1, noJitter)).toBe(1_000);
    expect(backoffDelayMs(2, noJitter)).toBe(2_000);
    expect(backoffDelayMs(3, noJitter)).toBe(4_000);
    expect(backoffDelayMs(10, noJitter)).toBe(30_000);
  });

  it("jitters over the lower half so clients do not reconnect in lockstep", () => {
    expect(backoffDelayMs(3, () => 0)).toBe(2_000);
    expect(backoffDelayMs(3, () => 1)).toBe(4_000);
  });
});

describe("RealtimeClient", () => {
  it("sends the token in the subprotocol, never in the URL (THREAT-MODEL T21)", () => {
    const { client, sockets } = harness();
    client.connect();
    expect(sockets[0]?.url).toBe("ws://api.test/realtime");
    expect(sockets[0]?.protocols).toEqual([REALTIME_PROTOCOL, "bearer.access-token"]);
  });

  it("does not connect without a token", () => {
    const { client, sockets } = harness({ token: null });
    client.connect();
    expect(sockets).toHaveLength(0);
    expect(client.getStatus()).toBe("closed");
  });

  it("waits for welcome before subscribing, then sends the full room set", () => {
    const { client, sockets, welcome } = harness();
    client.subscribe(rooms.workspace("01JW"));
    client.connect();
    const socket = sockets[0] as FakeSocket;
    expect(socket.sent).toHaveLength(0);

    welcome(socket);
    expect(socket.frames()).toEqual([{ t: "subscribe", rooms: ["workspace:01JW"] }]);
    expect(client.getStatus()).toBe("open");
  });

  it("delivers events to name-specific listeners", () => {
    const { client, sockets, welcome, events } = harness();
    const onProgress = vi.fn();
    client.on("job.progress", onProgress);
    client.connect();
    const socket = sockets[0] as FakeSocket;
    welcome(socket);

    socket.receive({
      t: "event",
      room: "workspace:01JW",
      event: "job.progress",
      data: { jobId: "01JJOB", progress: 42, etaMs: 20_000 },
      at: "2026-09-02T00:00:00.000Z",
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "job.progress",
        data: { jobId: "01JJOB", progress: 42, etaMs: 20_000 },
      }),
    );
    expect(events).toHaveLength(1);
  });

  it("ignores a malformed frame instead of dropping the connection", () => {
    const { client, sockets, welcome, events } = harness();
    client.connect();
    const socket = sockets[0] as FakeSocket;
    welcome(socket);
    socket.receive("not json");
    socket.receive({ t: "nonsense" });
    expect(events).toHaveLength(0);
    expect(client.getStatus()).toBe("open");
  });

  it("drops a refused room and never asks for it again", () => {
    const { client, sockets, welcome } = harness();
    client.connect();
    const socket = sockets[0] as FakeSocket;
    welcome(socket);
    client.subscribe(rooms.project("01JOTHER"));
    socket.receive({
      t: "subscribed",
      rooms: [],
      refused: [{ room: "project:01JOTHER", reason: "forbidden" }],
    });

    expect(client.getRooms()).not.toContain("project:01JOTHER");
    const before = socket.sent.length;
    client.subscribe(rooms.project("01JOTHER"));
    expect(socket.sent).toHaveLength(before);
  });

  it("re-subscribes and asks the caller to re-read after a reconnect", () => {
    const { client, sockets, timers, welcome, resyncs } = harness();
    client.subscribe(rooms.workspace("01JW"), rooms.project("01JP"));
    client.connect();
    welcome(sockets[0] as FakeSocket);
    expect(resyncs).toHaveLength(1);

    (sockets[0] as FakeSocket).onclose?.({ code: CLOSE_CODES.shuttingDown });
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(750);

    timers[0]?.handler();
    const second = sockets[1] as FakeSocket;
    welcome(second);

    expect(second.frames()[0]).toEqual({
      t: "subscribe",
      rooms: ["workspace:01JW", "project:01JP"],
    });
    // The room set is not a delta and state is not replayed: the caller re-reads.
    expect(resyncs[1]).toEqual(["workspace:01JW", "project:01JP"]);
  });

  it("refreshes the access token before retrying a 4401", async () => {
    const refresh = vi.fn().mockResolvedValue("fresh-token");
    const { client, sockets } = harness({ refresh });
    client.connect();
    (sockets[0] as FakeSocket).onclose?.({ code: CLOSE_CODES.unauthenticated });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it("stops for good when the refresh fails", async () => {
    const refresh = vi.fn().mockResolvedValue(null);
    const { client, sockets, timers } = harness({ refresh });
    client.connect();
    (sockets[0] as FakeSocket).onclose?.({ code: CLOSE_CODES.unauthenticated });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(timers).toHaveLength(0);
  });

  it("does not reconnect after an explicit disconnect", () => {
    const { client, sockets, timers } = harness();
    client.connect();
    client.disconnect();
    (sockets[0] as FakeSocket).onclose?.({ code: 1000 });
    expect(timers).toHaveLength(0);
    expect(client.getRooms()).toEqual([]);
  });

  it("answers with an application ping for surfaces that cannot see protocol frames", () => {
    const { client, sockets, welcome } = harness();
    client.connect();
    const socket = sockets[0] as FakeSocket;
    welcome(socket);
    client.ping();
    expect(socket.frames().at(-1)).toEqual({ t: "ping" });
  });

  it("unsubscribes only the rooms it holds", () => {
    const { client, sockets, welcome } = harness();
    client.subscribe(rooms.project("01JP"));
    client.connect();
    const socket = sockets[0] as FakeSocket;
    welcome(socket);
    client.unsubscribe(rooms.project("01JP"), rooms.project("01JNEVER"));
    expect(socket.frames().at(-1)).toEqual({ t: "unsubscribe", rooms: ["project:01JP"] });
  });
});

describe("rooms", () => {
  it("names the rooms of CONTRACTS §7", () => {
    expect(rooms.project("01JP")).toBe("project:01JP");
    expect(rooms.workspace("01JW")).toBe("workspace:01JW");
  });
});
