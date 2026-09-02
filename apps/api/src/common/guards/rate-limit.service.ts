import { Injectable, Logger } from "@nestjs/common";

import { redisKeyPrefix } from "../redis/redis-keys.js";
import { RedisService } from "../redis/redis.service.js";

/** One bucket's shape: `capacity` tokens, refilled at `refillPerSec`. */
export interface BucketSpec {
  /** Appears in the Redis key and in the 429 details, so keep it stable. */
  readonly name: string;
  readonly capacity: number;
  readonly refillPerSec: number;
  /** Tokens this request costs. Defaults to 1. */
  readonly cost?: number;
}

export interface BucketVerdict {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until `cost` tokens exist again. `0` when the request was allowed. */
  readonly retryAfterSec: number;
}

/**
 * A token bucket evaluated inside Redis, so concurrent requests on different API
 * instances cannot each read-modify-write their way past the limit.
 *
 * Returns `{allowed, remaining, retryAfterSec}`. Millisecond timestamps come from
 * the caller rather than from `TIME` inside the script, which keeps the script
 * deterministic (Redis refuses non-deterministic commands before writes in older
 * versions) and makes the unit tests able to advance the clock.
 */
export const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end

local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + (elapsed / 1000.0) * refill)

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', KEYS[1], math.ceil(capacity / refill) + 1)

local retry = 0
if allowed == 0 then
  retry = math.ceil((cost - tokens) / refill)
  if retry < 1 then retry = 1 end
end
return { allowed, math.floor(tokens), retry }
`;

/**
 * Namespace for every rate-limit key, so a FLUSHDB in dev is obvious about what
 * it drops.
 *
 * A function since A23b, for the reason {@link redisKeyPrefix} explains.
 */
export function rateLimitPrefix(): string {
  return `${redisKeyPrefix()}:rl`;
}

/** The key one bucket lives at. Exported because the e2e harnesses clear buckets. */
export function rateLimitKey(bucketName: string, subject: string): string {
  return `${rateLimitPrefix()}:${bucketName}:${subject}`;
}

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Consume `cost` tokens from `subject`'s bucket.
   *
   * **Fails open.** A Redis outage must not lock every user out of the product;
   * the loss of the limiter is logged and reported by the readiness probe. T1's
   * other controls (argon2id, breached-password check, generic errors) still hold
   * while it is down.
   */
  async consume(spec: BucketSpec, subject: string, nowMs = Date.now()): Promise<BucketVerdict> {
    const key = rateLimitKey(spec.name, subject);
    const cost = spec.cost ?? 1;
    try {
      const raw = (await this.redis.client.eval(
        TOKEN_BUCKET_LUA,
        1,
        key,
        String(spec.capacity),
        String(spec.refillPerSec),
        String(cost),
        String(nowMs),
      )) as [number, number, number];

      return { allowed: raw[0] === 1, remaining: raw[1], retryAfterSec: raw[2] };
    } catch (error) {
      this.logger.warn(
        { err: error, bucket: spec.name },
        "rate limiter unavailable; allowing the request",
      );
      return { allowed: true, remaining: spec.capacity, retryAfterSec: 0 };
    }
  }

  /** Drop a bucket, e.g. after a successful login clears the failure counter. */
  async reset(spec: BucketSpec, subject: string): Promise<void> {
    try {
      await this.redis.client.del(rateLimitKey(spec.name, subject));
    } catch (error) {
      this.logger.warn({ err: error, bucket: spec.name }, "could not reset a rate-limit bucket");
    }
  }
}
