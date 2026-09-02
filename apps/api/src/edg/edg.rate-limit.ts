import { Injectable } from "@nestjs/common";

import { type BucketSpec, type BucketVerdict, RateLimitService } from "../common/guards/index.js";

/**
 * The op-batch budget, per workspace.
 *
 * Not `@RateLimit()` on the route: the shared guard keys buckets on the IP, the
 * user or the body's email, and an EDG batch has to be limited **per workspace**
 * — one agency seat opening twenty tabs is one document being edited, and the
 * cost the limit protects is a row lock on that workspace's documents, not the
 * caller's socket. The token bucket itself is the shared one (one Lua script in
 * Redis, so two API instances cannot each let the same batch through), only the
 * subject differs.
 *
 * 20 tokens refilling at 5/s is a burst of twenty batches and a sustained five a
 * second: a keystroke-per-batch editor coalesces long before that, and a runaway
 * client is stopped inside a second.
 */
export const EDG_OPS_BUCKET: BucketSpec = {
  name: "edg:ops",
  capacity: 20,
  refillPerSec: 5,
};

@Injectable()
export class EdgRateLimiter {
  constructor(private readonly limiter: RateLimitService) {}

  /**
   * Spend one batch of the workspace's budget.
   *
   * Fails **open** on a Redis outage, exactly as {@link RateLimitService} does
   * everywhere else: losing the limiter must not make the editor read-only.
   */
  async consume(workspaceId: string): Promise<BucketVerdict> {
    return this.limiter.consume(EDG_OPS_BUCKET, workspaceId);
  }
}
