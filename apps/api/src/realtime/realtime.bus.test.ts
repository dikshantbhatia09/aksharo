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
