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

/**
 * When Redis is gone, each replica keeps its own buckets at this fraction of the
 * configured capacity.
 *
 * The shared limiter is one bucket for the whole fleet; N in-process limiters are
 * N buckets, so granting each replica the full capacity would multiply the real
 * limit by the replica count at exactly the moment the system is already unwell.
 * Halving it keeps the degraded ceiling within the same order of magnitude as the
 * healthy one without being so tight that a Redis blip logs everyone out.
 */
const FALLBACK_CAPACITY_RATIO = 0.5;

/**
 * Distinct subjects the in-process fallback will track before it starts evicting
 * the least recently seen.
 *
 * Subjects are attacker-chosen (an address, an email), so an unbounded map is a
 * memory-exhaustion path that opens precisely when Redis is down. Eviction makes
 * the cap approximate under a spraying attack, which is the right trade: an
 * approximate limit is still a limit, and the process staying up matters more.
 */
const FALLBACK_MAX_SUBJECTS = 50_000;

interface LocalBucket {
  tokens: number;
  updatedMs: number;
}

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  /** Per-replica buckets, used only while Redis is unreachable. */
  private readonly fallback = new Map<string, LocalBucket>();
  /** So the degraded state is logged on transition, not on every request. */
  private degraded = false;

  constructor(private readonly redis: RedisService) {}

  /**
   * Consume `cost` tokens from `subject`'s bucket.
   *
   * **Degrades, rather than failing open.** A Redis outage must not lock every
   * user out of the product, but it must not remove the limit either: unlimited
   * sign-up, login and job admission is how a dependency incident becomes a
   * credential-stuffing run and an unbounded provider bill (launch-readiness
   * P0-08). So the request falls back to a per-replica token bucket at
   * {@link FALLBACK_CAPACITY_RATIO} of the configured capacity — a coarser,
   * fleet-multiplied, still finite ceiling — and the loss of the shared limiter
   * is logged once per transition and reported by the readiness probe.
   *
   * T1's other controls (argon2id, breached-password check, generic errors) hold
   * throughout.
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

      if (this.degraded) {
        this.degraded = false;
        this.fallback.clear();
        this.logger.log("rate limiter recovered; shared buckets are authoritative again");
      }
      return { allowed: raw[0] === 1, remaining: raw[1], retryAfterSec: raw[2] };
    } catch (error) {
      if (!this.degraded) {
        this.degraded = true;
        this.logger.error(
          { err: error, bucket: spec.name },
          "shared rate limiter unavailable; falling back to per-replica buckets at " +
            `${String(FALLBACK_CAPACITY_RATIO * 100)}% capacity`,
        );
      }
      return this.consumeLocally(spec, key, cost, nowMs);
    }
  }

  /**
   * The same token-bucket arithmetic as {@link TOKEN_BUCKET_LUA}, in process.
   *
   * Kept deliberately identical in shape so the degraded behaviour is a smaller
   * version of the healthy one rather than a second, differently-wrong limiter.
   */
  private consumeLocally(
    spec: BucketSpec,
    key: string,
    cost: number,
    nowMs: number,
  ): BucketVerdict {
    const capacity = Math.max(1, Math.floor(spec.capacity * FALLBACK_CAPACITY_RATIO));
    const refillPerSec = spec.refillPerSec * FALLBACK_CAPACITY_RATIO;

    const existing = this.fallback.get(key);
    const elapsedMs = existing === undefined ? 0 : Math.max(0, nowMs - existing.updatedMs);
    let tokens =
      existing === undefined
        ? capacity
        : Math.min(capacity, existing.tokens + (elapsedMs / 1000) * refillPerSec);

    const allowed = tokens >= cost;
    if (allowed) tokens -= cost;

    // Re-insert so the map's insertion order is a least-recently-used order.
    this.fallback.delete(key);
    this.fallback.set(key, { tokens, updatedMs: nowMs });
    if (this.fallback.size > FALLBACK_MAX_SUBJECTS) {
      const oldest = this.fallback.keys().next();
      if (oldest.done !== true) this.fallback.delete(oldest.value);
    }

    return {
      allowed,
      remaining: Math.floor(tokens),
      retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((cost - tokens) / refillPerSec)),
    };
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
