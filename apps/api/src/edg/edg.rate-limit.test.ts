import { describe, expect, it, vi } from "vitest";

import { EDG_OPS_BUCKET, EdgRateLimiter } from "./edg.rate-limit.js";
import { type RateLimitService } from "../common/guards/index.js";

describe("EdgRateLimiter", () => {
  it("spends the workspace's budget, not the caller's", async () => {
    const consume = vi.fn().mockResolvedValue({ allowed: true, remaining: 19, retryAfterSec: 0 });
    const limiter = new EdgRateLimiter({ consume } as unknown as RateLimitService);

    await limiter.consume("01JCWS000000000000000000AA");

    // One agency seat with twenty tabs is one document being edited: the subject
    // has to be the workspace, or the limit measures the wrong thing.
    expect(consume).toHaveBeenCalledWith(EDG_OPS_BUCKET, "01JCWS000000000000000000AA");
  });

  it("is a burst of 20 refilling at 5 a second", () => {
    expect(EDG_OPS_BUCKET).toMatchObject({ name: "edg:ops", capacity: 20, refillPerSec: 5 });
  });

  it("passes the refusal through with its Retry-After", async () => {
    const limiter = new EdgRateLimiter({
      consume: async () => ({ allowed: false, remaining: 0, retryAfterSec: 3 }),
    } as unknown as RateLimitService);

    await expect(limiter.consume("01JCWS000000000000000000AA")).resolves.toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSec: 3,
    });
  });
});
