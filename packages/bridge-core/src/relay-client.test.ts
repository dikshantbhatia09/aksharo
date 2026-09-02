import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { RelayClient } from "./relay-client.js";

/** A fake `ws` socket good enough to drive `RelayClient` without a real network. */
class FakeSocket extends EventEmitter {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  static instances: FakeSocket[] = [];

  constructor(
    public url: string,
    public opts: unknown,
  ) {
    super();
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }
  ping(): void {}
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  openNow(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit("open");
  }
}

describe("RelayClient", () => {
  it("emits state transitions and sends device-token auth header", () => {
    FakeSocket.instances = [];
    const client = new RelayClient({
      url: "wss://api.example.test/bridge/relay",
      deviceToken: "device-token-1",
      WebSocketImpl: FakeSocket as never,
    });
    const states: string[] = [];
    client.on("state", (s) => states.push(s));
    client.connect();

    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0]?.opts).toMatchObject({
      headers: { authorization: "Bearer device-token-1" },
    });
    expect(states).toEqual(["connecting"]);

    FakeSocket.instances[0]?.openNow();
    expect(states).toEqual(["connecting", "open"]);
    expect(client.state).toBe("open");
  });

  it("reconnects with backoff after an unexpected close, capped by maxBackoffMs", async () => {
    vi.useFakeTimers();
    try {
      FakeSocket.instances = [];
      const client = new RelayClient({
        url: "wss://api.example.test/bridge/relay",
        deviceToken: "t",
        minBackoffMs: 10,
        maxBackoffMs: 20,
        WebSocketImpl: FakeSocket as never,
      });
      client.connect();
      FakeSocket.instances[0]?.openNow();
      FakeSocket.instances[0]?.emit("close");

      await vi.advanceTimersByTimeAsync(50);
      expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect after an explicit close()", async () => {
    vi.useFakeTimers();
    try {
      FakeSocket.instances = [];
      const client = new RelayClient({
        url: "wss://api.example.test/bridge/relay",
        deviceToken: "t",
        minBackoffMs: 5,
        maxBackoffMs: 10,
        WebSocketImpl: FakeSocket as never,
      });
      client.connect();
      FakeSocket.instances[0]?.openNow();
      client.close();
      await vi.advanceTimersByTimeAsync(100);
      expect(FakeSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("send() returns false when not open", () => {
    FakeSocket.instances = [];
    const client = new RelayClient({
      url: "wss://x",
      deviceToken: "t",
      WebSocketImpl: FakeSocket as never,
    });
    client.connect();
    expect(client.send("hi")).toBe(false);
    FakeSocket.instances[0]?.openNow();
    expect(client.send("hi")).toBe(true);
    expect(FakeSocket.instances[0]?.sent).toEqual(["hi"]);
  });
});
