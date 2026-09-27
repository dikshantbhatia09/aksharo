import { describe, expect, it } from "vitest";

import {
  SOURCE_GATE_BASE_MS,
  SOURCE_GATE_MAX_MS,
  SOURCE_GATE_MEMORY_MS,
  SOURCE_GATE_PROBE_MS,
  SourceGate,
  gateDelayMs,
} from "./source-gate.js";

import type { RedisService } from "../common/redis/redis.service.js";

const MINUTE = 60_000;
const NOW = Date.parse("2026-09-27T10:00:00Z");

/** Just enough of ioredis for the gate: GET, SET with PX and NX, DEL, and a clock for expiry. */
function fakeRedis(options: { broken?: boolean } = {}) {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  let clock = NOW;
  const live = (key: string) => {
    const entry = store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= clock) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };
  const fail = () => {
    if (options.broken === true) throw new Error("ECONNREFUSED");
  };
  const client = {
    status: "ready",
    connect: async () => undefined,
    get: async (key: string) => {
      fail();
      return live(key)?.value ?? null;
    },
    set: async (key: string, value: string, ...args: (string | number)[]) => {
      fail();
      const px = args.indexOf("PX");
      const nx = args.includes("NX");
      if (nx && live(key) !== undefined) return null;
      store.set(key, { value, expiresAt: px === -1 ? null : clock + Number(args[px + 1]) });
      return "OK";
    },
    del: async (...keys: string[]) => {
      fail();
      for (const key of keys) store.delete(key);
      return keys.length;
    },
  };
  return {
    redis: { client } as unknown as RedisService,
    advance: (ms: number) => {
      clock += ms;
    },
    at: () => clock,
  };
}

describe("gateDelayMs", () => {
  it("waits 15 minutes, doubling per refusal in a row, never more than two hours", () => {
    expect(gateDelayMs(1)).toBe(SOURCE_GATE_BASE_MS);
    expect(gateDelayMs(2)).toBe(2 * SOURCE_GATE_BASE_MS);
    expect(gateDelayMs(3)).toBe(4 * SOURCE_GATE_BASE_MS);
    expect(gateDelayMs(10)).toBe(SOURCE_GATE_MAX_MS);
  });
});

describe("SourceGate", () => {
  it("is closed until YouTube refuses a download, and lets every fetch through", async () => {
    const { redis } = fakeRedis();
    const gate = new SourceGate(redis);
    expect(await gate.state(NOW)).toEqual({ openUntil: null, trips: 0 });
    expect(await gate.mayFetch(NOW)).toBe(true);
    expect(await gate.mayFetch(NOW)).toBe(true);
  });

  it("opens on a refusal and holds every fetch until it is due to close", async () => {
    const { redis } = fakeRedis();
    const gate = new SourceGate(redis);
    const until = await gate.trip(NOW);
    expect(until).toBe(NOW + SOURCE_GATE_BASE_MS);
    expect(await gate.state(NOW)).toEqual({ openUntil: until, trips: 1 });
    expect(await gate.mayFetch(NOW + 14 * MINUTE)).toBe(false);
  });

  it("lets exactly one fetch through once the wait is over, and the rest wait for its answer", async () => {
    const { redis, advance } = fakeRedis();
    const gate = new SourceGate(redis);
    await gate.trip(NOW);
    advance(16 * MINUTE);
    const later = NOW + 16 * MINUTE;
    expect(await gate.state(later)).toEqual({ openUntil: null, trips: 1 });
    expect(await gate.mayFetch(later)).toBe(true);
    expect(await gate.mayFetch(later)).toBe(false);
    // The probe that is never answered frees the way for the next one.
    advance(SOURCE_GATE_PROBE_MS + 1);
    expect(await gate.mayFetch(later + SOURCE_GATE_PROBE_MS + 1)).toBe(true);
  });

  it("closes and forgets its refusals when a fetch gets through", async () => {
    const { redis, advance } = fakeRedis();
    const gate = new SourceGate(redis);
    await gate.trip(NOW);
    advance(16 * MINUTE);
    expect(await gate.mayFetch(NOW + 16 * MINUTE)).toBe(true);
    await gate.passed();
    expect(await gate.state(NOW + 16 * MINUTE)).toEqual({ openUntil: null, trips: 0 });
    expect(await gate.mayFetch(NOW + 16 * MINUTE)).toBe(true);
    expect(await gate.mayFetch(NOW + 16 * MINUTE)).toBe(true);
  });

  it("waits longer after a refused probe, and starts counting again after a quiet spell", async () => {
    const { redis, advance } = fakeRedis();
    const gate = new SourceGate(redis);
    await gate.trip(NOW);
    advance(16 * MINUTE);
    const second = await gate.trip(NOW + 16 * MINUTE);
    expect(second).toBe(NOW + 16 * MINUTE + 2 * SOURCE_GATE_BASE_MS);

    const quiet = NOW + 16 * MINUTE + SOURCE_GATE_MEMORY_MS + MINUTE;
    advance(SOURCE_GATE_MEMORY_MS + MINUTE);
    expect(await gate.trip(quiet)).toBe(quiet + SOURCE_GATE_BASE_MS);
  });

  it("never becomes the outage: with Redis down it is closed and fetches go ahead", async () => {
    const { redis } = fakeRedis({ broken: true });
    const gate = new SourceGate(redis);
    expect(await gate.state(NOW)).toEqual({ openUntil: null, trips: 0 });
    expect(await gate.mayFetch(NOW)).toBe(true);
    await expect(gate.trip(NOW)).resolves.toBe(NOW + SOURCE_GATE_BASE_MS);
    await expect(gate.passed()).resolves.toBeUndefined();
  });
});
