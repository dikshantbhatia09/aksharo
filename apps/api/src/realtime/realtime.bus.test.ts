import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { InMemoryRealtimeBroker, InMemoryRealtimeBus, RedisRealtimeBus } from "./realtime.bus.js";
import { createFakeRedis } from "../../test/fakes.js";

import type { RedisService } from "../common/redis/redis.service.js";

describe("InMemoryRealtimeBus", () => {
  it("delivers only to buses subscribed to the channel", async () => {
    const broker = new InMemoryRealtimeBroker();
    const a = new InMemoryRealtimeBus(broker);
    const b = new InMemoryRealtimeBus(broker);
    const c = new InMemoryRealtimeBus(broker);

    const seenA: string[] = [];
    const seenB: string[] = [];
    const seenC: string[] = [];
    a.onMessage((_, payload) => seenA.push(payload));
    b.onMessage((_, payload) => seenB.push(payload));
    c.onMessage((_, payload) => seenC.push(payload));

    await a.subscribe("room:1");
    await b.subscribe("room:1");
    await c.subscribe("room:2");

    // The publisher is itself subscribed, so it gets its own message back —
    // exactly what Redis does, and what keeps delivery to one code path.
    await a.publish("room:1", "hello");

    expect(seenA).toEqual(["hello"]);
    expect(seenB).toEqual(["hello"]);
    expect(seenC).toEqual([]);
  });

  it("stops delivering after unsubscribe and after close", async () => {
    const broker = new InMemoryRealtimeBroker();
    const bus = new InMemoryRealtimeBus(broker);
    const seen: string[] = [];
    bus.onMessage((_, payload) => seen.push(payload));

    await bus.subscribe("room:1");
    await bus.publish("room:1", "one");
    await bus.unsubscribe("room:1");
    await bus.publish("room:1", "two");

    await bus.subscribe("room:1");
    await bus.close();
    await bus.publish("room:1", "three");

    expect(seen).toEqual(["one"]);
  });

  it("is idempotent on repeated subscribe and unsubscribe", async () => {
    const broker = new InMemoryRealtimeBroker();
    const bus = new InMemoryRealtimeBus(broker);
    const seen: string[] = [];
    bus.onMessage((_, payload) => seen.push(payload));

    await bus.subscribe("room:1");
    await bus.subscribe("room:1");
    await bus.publish("room:1", "once");
    expect(seen).toEqual(["once"]);

    await bus.unsubscribe("room:1");
    await expect(bus.unsubscribe("room:1")).resolves.toBeUndefined();
  });

  it("reports the channel a message arrived on", async () => {
    const broker = new InMemoryRealtimeBroker();
    const bus = new InMemoryRealtimeBus(broker);
    const channels: string[] = [];
    bus.onMessage((channel) => channels.push(channel));
    await bus.subscribe("room:1");
    await bus.subscribe("room:2");
    await bus.publish("room:2", "x");
    expect(channels).toEqual(["room:2"]);
  });
});

describe("RedisRealtimeBus", () => {
  it("subscribes on a DUPLICATE connection and publishes on the shared one", async () => {
    const redis = createFakeRedis();
    const subscriber = createFakeRedis().client;
    const duplicate = vi.fn(() => subscriber);
    const publish = vi.fn(async () => 1);
    const service = {
      ...redis,
      client: { ...redis.client, duplicate, publish },
    } as unknown as RedisService;

    const bus = new RedisRealtimeBus(service);
    bus.onMessage(() => undefined);
    await bus.subscribe("a08:realtime:workspace:x");
    await bus.publish("a08:realtime:workspace:x", "payload");

    // A client in subscriber mode refuses every other command, so it cannot be
    // the shared connection the health probe and BullMQ also use.
    expect(duplicate).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("a08:realtime:workspace:x", "payload");

    await bus.close();
    await expect(bus.unsubscribe("a08:realtime:workspace:x")).resolves.toBeUndefined();
    await expect(bus.onModuleDestroy()).resolves.toBeUndefined();
  });
});

/**
 * A client with the lifecycle `RedisService` actually hands out: `lazyConnect`, so
 * it starts in `wait`, and `enableOfflineQueue: false`, so a command issued before
 * the socket opens is **rejected** rather than queued.
 *
 * `createFakeRedis` reports `ready` from the first moment, which is precisely why
 * A08's unit tests passed against a bus that could not subscribe at all (A08c).
 */
class LazyRedisClient extends EventEmitter {
  status = "wait";
  connectCount = 0;
  readonly subscribed: string[] = [];
  readonly unsubscribed: string[] = [];
  readonly published: { channel: string; payload: string }[] = [];

  async connect(): Promise<void> {
    this.connectCount += 1;
    if (this.status !== "wait" && this.status !== "end") {
      throw new Error("Redis is already connecting/connected");
    }
    this.status = "ready";
    this.emit("ready");
  }

  duplicate(): LazyRedisClient {
    return new LazyRedisClient();
  }

  async subscribe(channel: string): Promise<number> {
    this.guard();
    this.subscribed.push(channel);
    return 1;
  }

  async unsubscribe(channel: string): Promise<number> {
    this.guard();
    this.unsubscribed.push(channel);
    return 1;
  }

  async publish(channel: string, payload: string): Promise<number> {
    this.guard();
    this.published.push({ channel, payload });
    return 1;
  }

  disconnect(): void {
    this.status = "end";
  }

  private guard(): void {
    if (this.status !== "ready") {
      throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    }
  }
}

interface LazyService {
  service: RedisService;
  shared: LazyRedisClient;
  subscriber: LazyRedisClient;
}

function lazyService(): LazyService {
  const shared = new LazyRedisClient();
  const subscriber = new LazyRedisClient();
  shared.duplicate = () => subscriber;
  return {
    service: {
      client: shared,
      ping: async () => undefined,
      onModuleDestroy: async () => undefined,
    } as unknown as RedisService,
    shared,
    subscriber,
  };
}

describe("RedisRealtimeBus connection handling (A08c)", () => {
  it("connects the duplicated subscriber, which starts in `wait`, before subscribing", async () => {
    const { service, subscriber } = lazyService();
    const bus = new RedisRealtimeBus(service);
    bus.onMessage(() => undefined);

    expect(subscriber.status).toBe("wait");
    await expect(bus.subscribe("a08c:realtime:workspace:x")).resolves.toBeUndefined();

    expect(subscriber.connectCount).toBe(1);
    expect(subscriber.subscribed).toEqual(["a08c:realtime:workspace:x"]);
    await bus.close();
  });

  it("connects once, however many rooms are joined", async () => {
    const { service, subscriber } = lazyService();
    const bus = new RedisRealtimeBus(service);
    bus.onMessage(() => undefined);

    await bus.subscribe("a08c:realtime:workspace:x");
    await bus.subscribe("a08c:realtime:project:y");

    expect(subscriber.connectCount).toBe(1);
    expect(subscriber.subscribed).toHaveLength(2);
    await bus.close();
  });

  it("connects the shared client before publishing on it", async () => {
    const { service, shared } = lazyService();
    const bus = new RedisRealtimeBus(service);

    await expect(bus.publish("a08c:realtime:workspace:x", "payload")).resolves.toBeUndefined();

    expect(shared.connectCount).toBe(1);
    expect(shared.published).toEqual([
      { channel: "a08c:realtime:workspace:x", payload: "payload" },
    ]);
    await bus.close();
  });

  it("waits for `ready` when another caller is already connecting", async () => {
    const { service, subscriber } = lazyService();
    const bus = new RedisRealtimeBus(service);
    bus.onMessage(() => undefined);
    subscriber.status = "connecting";

    const pending = bus.subscribe("a08c:realtime:workspace:x");
    subscriber.status = "ready";
    subscriber.emit("ready");

    await expect(pending).resolves.toBeUndefined();
    // It never called `connect()` itself, which would have thrown
    // "Redis is already connecting/connected".
    expect(subscriber.connectCount).toBe(0);
    await bus.close();
  });

  it("rejects rather than hanging when the connection errors out", async () => {
    const { service, subscriber } = lazyService();
    const bus = new RedisRealtimeBus(service);
    bus.onMessage(() => undefined);
    subscriber.status = "connecting";

    const pending = bus.subscribe("a08c:realtime:workspace:x");
    subscriber.emit("error", new Error("ECONNREFUSED"));

    await expect(pending).rejects.toThrow("ECONNREFUSED");
    await bus.close();
  });

  it("reconnects after close, because close() drops the duplicate", async () => {
    const { service, subscriber } = lazyService();
    const bus = new RedisRealtimeBus(service);
    bus.onMessage(() => undefined);

    await bus.subscribe("a08c:realtime:workspace:x");
    await bus.close();
    expect(subscriber.status).toBe("end");

    // A fresh duplicate, connected from scratch.
    bus.onMessage(() => undefined);
    await expect(bus.subscribe("a08c:realtime:workspace:x")).resolves.toBeUndefined();
    await bus.close();
  });

  it("does not try to unsubscribe a connection that never came up", async () => {
    const { service, subscriber } = lazyService();
    const bus = new RedisRealtimeBus(service);
    bus.onMessage(() => undefined);

    // The duplicate exists (onMessage made it) but is still `wait`; an
    // UNSUBSCRIBE here would fail exactly the way a cold SUBSCRIBE did.
    await expect(bus.unsubscribe("a08c:realtime:workspace:x")).resolves.toBeUndefined();
    expect(subscriber.unsubscribed).toEqual([]);
    await bus.close();
  });
});
