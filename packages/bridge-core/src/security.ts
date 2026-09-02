import { timingSafeEqual } from "node:crypto";

import { BRAND, PLUGIN_IDS } from "@montaj/config/brand";

/**
 * Request-level security controls shared by the loopback HTTPS/WS server
 * (brief §2; THREAT-MODEL T10–T14). Every route runs all four checks, in this
 * order, before any RPC dispatch: bearer -> Host -> Origin -> size/rate.
 */

/** Constant-time bearer comparison — a `===` here would leak length/prefix via timing. */
export function bearerMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined || provided.length === 0) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Still do a constant-time compare against a same-length buffer so the
    // early return above is the only length-dependent branch, and it is taken
    // for every wrong-length guess a real attacker would ever try (they don't
    // know the length either).
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function extractBearer(authorizationHeader: string | undefined): string | undefined {
  if (authorizationHeader === undefined) return undefined;
  const match = /^Bearer (.+)$/.exec(authorizationHeader);
  return match?.[1];
}

/** `Host` must be `127.0.0.1:<port>` or `localhost:<port>` — never a DNS name an attacker controls. */
export function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (hostHeader === undefined) return false;
  return hostHeader === `127.0.0.1:${String(port)}` || hostHeader === `localhost:${String(port)}`;
}

/**
 * The `Origin` allowlist (brief §2): the hosted web app, UXP plugin origins, and
 * never `null` (a `null` Origin is what a local file, a sandboxed iframe, or a
 * crafted redirect sends — T12 in the threat model).
 */
export function allowedOrigins(): readonly string[] {
  return [
    `https://app.${BRAND.domain}`,
    `https://${BRAND.domain}`,
    `https://app.${BRAND.altDomain}`,
    `https://${BRAND.altDomain}`,
    // UXP/CEP plugin origins are `https://<pluginId>` in CEP99's embedded Chromium.
    `https://${PLUGIN_IDS.premiereUxp}`,
    `https://${PLUGIN_IDS.afterEffectsCep}`,
  ];
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === "null" || origin === "") return false;
  return allowedOrigins().includes(origin);
}

/** Chrome Local Network Access preflight header, only ever sent for an allowlisted origin. */
export const LOCAL_NETWORK_ACCESS_HEADER = "Access-Control-Allow-Private-Network";

export interface RateLimiterOptions {
  readonly windowMs: number;
  readonly max: number;
}

/** A tiny in-process token-bucket limiter keyed by remote address. No Redis: the bridge is single-instance. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly options: RateLimiterOptions) {}

  /** `true` when the request is allowed; records the hit either way is wrong — only allowed hits count. */
  consume(key: string, now = Date.now()): boolean {
    const windowStart = now - this.options.windowMs;
    const existing = this.hits.get(key) ?? [];
    const recent = existing.filter((t) => t > windowStart);
    if (recent.length >= this.options.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Diagnostics/tests only. */
  clear(): void {
    this.hits.clear();
  }
}
