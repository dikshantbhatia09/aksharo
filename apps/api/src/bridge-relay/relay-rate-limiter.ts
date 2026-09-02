/**
 * Per-remote-address token bucket for `/bridge/relay` upgrade attempts (brief
 * §3/§6: "message size/rate limits"). Deliberately in-process rather than
 * Redis-backed: it only needs to survive one instance's own upgrade rate, and a
 * restart resetting it costs nothing worse than a brief window of leniency.
 */
export interface RelayRateLimiterOptions {
  readonly windowMs: number;
  readonly max: number;
}

export class RelayRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly options: RelayRateLimiterOptions) {}

  consume(key: string, now = Date.now()): boolean {
    const windowStart = now - this.options.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    if (recent.length >= this.options.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  clear(): void {
    this.hits.clear();
  }
}
