import { describe, expect, it, vi } from "vitest";

import { RateLimitService, TOKEN_BUCKET_LUA, rateLimitPrefix } from "./rate-limit.service.js";

import type { RedisService } from "../redis/redis.service.js";

function serviceWith(eval_: unknown, del = vi.fn()) {
  const redis = { client: { eval: eval_, del } } as unknown as RedisService;
  return { service: new RateLimitService(redis), del };
}

const SPEC = { name: "test", capacity: 5, refillPerSec: 1 };

describe("RateLimitService", () => {
  it("evaluates the bucket script against a namespaced key", async () => {
    const evalSpy = vi.fn().mockResolvedValue([1, 4, 0]);
    const { service } = serviceWith(evalSpy);

    const verdict = await service.consume(SPEC, "subject-1", 1_000);

    expect(verdict).toEqual({ allowed: true, remaining: 4, retryAfterSec: 0 });
    expect(evalSpy).toHaveBeenCalledWith(
      TOKEN_BUCKET_LUA,
      1,
      `${rateLimitPrefix()}:test:subject-1`,
      "5",
      "1",
      "1",
      "1000",
    );
  });

  it("passes a custom cost through", async () => {
    const evalSpy = vi.fn().mockResolvedValue([0, 0, 3]);
    const { service } = serviceWith(evalSpy);

    const verdict = await service.consume({ ...SPEC, cost: 3 }, "subject-1", 2_000);

    expect(verdict).toEqual({ allowed: false, remaining: 0, retryAfterSec: 3 });
    expect(evalSpy.mock.calls[0]?.[5]).toBe("3");
  });

  it("fails open when Redis is unreachable", async () => {
    const { service } = serviceWith(vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    // A Redis outage must not lock every user out of the product.
    await expect(service.consume(SPEC, "subject-1")).resolves.toEqual({
      allowed: true,
      remaining: 5,
      retryAfterSec: 0,
    });
  });

  it("drops a bucket on reset, and survives a failure doing so", async () => {
    const del = vi.fn().mockResolvedValue(1);
    const { service } = serviceWith(vi.fn(), del);
    await service.reset(SPEC, "subject-1");
    expect(del).toHaveBeenCalledWith(`${rateLimitPrefix()}:test:subject-1`);

    const failing = serviceWith(vi.fn(), vi.fn().mockRejectedValue(new Error("nope")));
    await expect(failing.service.reset(SPEC, "subject-1")).resolves.toBeUndefined();
  });
});

describe("the bucket script", () => {
  it("refills over time rather than on a fixed window", () => {
    // The behaviour is asserted end-to-end in `test/auth.e2e-spec.ts` against a
    // real Redis; this only pins the shape of the script the service ships.
    expect(TOKEN_BUCKET_LUA).toContain("HMGET");
    expect(TOKEN_BUCKET_LUA).toContain("math.min(capacity");
    expect(TOKEN_BUCKET_LUA).toContain("EXPIRE");
    // The clock is a parameter, not `TIME`: the script must stay deterministic.
    expect(TOKEN_BUCKET_LUA).not.toContain("TIME");
  });
});
