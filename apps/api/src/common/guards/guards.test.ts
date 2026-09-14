import { HttpStatus } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";

import { RequestContext } from "../request-context.js";
import { ApiKeyGuard, hashApiKeySecret, parseApiKey } from "./api-key.guard.js";
import { bearerToken, JwtAuthGuard } from "./jwt-auth.guard.js";
import { clientIp, clientUserAgent, roleAtLeast } from "./principal.js";
import { ALLOW_BRIDGE_TOKEN_KEY, IS_PUBLIC_KEY } from "./public.decorator.js";
import { RateLimitGuard, RATE_LIMIT_KEY } from "./rate-limit.guard.js";
import { RateLimitService } from "./rate-limit.service.js";
import { ROLES_KEY, RolesGuard } from "./roles.guard.js";

import type { RateLimitRule } from "./rate-limit.guard.js";
import type { ExecutionContext } from "@nestjs/common";
import type { Request, Response } from "express";

/** An `ExecutionContext` with just enough of one to drive a guard. */
function contextFor(request: Partial<Request>, response: Partial<Response> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

/** A `Reflector` that answers one metadata key. */
function reflectorFor(values: Record<string, unknown>): Reflector {
  const reflector = new Reflector();
  vi.spyOn(reflector, "getAllAndOverride").mockImplementation(
    (key: unknown) => values[String(key)] as never,
  );
  return reflector;
}

describe("bearerToken", () => {
  it("reads a bearer header case-insensitively and rejects everything else", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken("Bearer")).toBeUndefined();
    expect(bearerToken("Bearer   ")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

describe("clientIp", () => {
  const socket = { remoteAddress: "10.0.0.9" } as Request["socket"];

  it("ignores X-Forwarded-For unless an operator says a proxy rewrites it", () => {
    delete process.env["TRUST_PROXY"];
    const request = {
      headers: { "x-forwarded-for": "1.2.3.4" },
      ip: "10.0.0.1",
      socket,
    } as unknown as Request;
    expect(clientIp(request)).toBe("10.0.0.1");
  });

  /**
   * `TRUST_PROXY` counts trusted hops, and the entry a trusted hop wrote is
   * counted from the RIGHT. The left of the header is whatever the client sent;
   * reading it — as this did until P0-08 — lets anyone mint a fresh rate-limit
   * bucket per request by prepending an address.
   */
  it("reads the entry the single trusted proxy wrote, not the client's prefix", () => {
    process.env["TRUST_PROXY"] = "1";
    try {
      const request = {
        headers: { "x-forwarded-for": " 1.2.3.4 , 5.6.7.8" },
        ip: "10.0.0.1",
        socket,
      } as unknown as Request;
      expect(clientIp(request)).toBe("5.6.7.8");

      const arrayHeader = {
        headers: { "x-forwarded-for": ["9.9.9.9"] },
        ip: "10.0.0.1",
        socket,
      } as unknown as Request;
      expect(clientIp(arrayHeader)).toBe("9.9.9.9");
    } finally {
      delete process.env["TRUST_PROXY"];
    }
  });

  it("steps in one entry per trusted hop", () => {
    process.env["TRUST_PROXY"] = "2";
    try {
      // Forged, then the client (recorded by Cloudflare), then Cloudflare
      // (recorded by the ingress).
      const request = {
        headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.7, 10.0.0.5" },
        ip: "10.0.0.1",
        socket,
      } as unknown as Request;
      expect(clientIp(request)).toBe("203.0.113.7");
    } finally {
      delete process.env["TRUST_PROXY"];
    }
  });

  it("cannot be shifted by prepending addresses, however many", () => {
    process.env["TRUST_PROXY"] = "2";
    try {
      const forged = ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"].join(", ");
      const request = {
        headers: { "x-forwarded-for": `${forged}, 203.0.113.7, 10.0.0.5` },
        ip: "10.0.0.1",
        socket,
      } as unknown as Request;
      expect(clientIp(request)).toBe("203.0.113.7");
    } finally {
      delete process.env["TRUST_PROXY"];
    }
  });

  /**
   * A request that reached this process without passing every declared proxy —
   * someone who found the origin directly — has no trustworthy entry at all.
   * The socket address is the only honest answer, and it is also the one that
   * makes a direct-origin attempt visible in the audit rows.
   */
  it("falls back to the socket when the chain is shorter than the trusted hops", () => {
    process.env["TRUST_PROXY"] = "2";
    try {
      const request = {
        headers: { "x-forwarded-for": "203.0.113.7" },
        ip: "10.0.0.1",
        socket,
      } as unknown as Request;
      expect(clientIp(request)).toBe("10.0.0.1");
    } finally {
      delete process.env["TRUST_PROXY"];
    }
  });

  it("treats a zero, negative or unparseable hop count as no proxy at all", () => {
    for (const value of ["0", "-1", "yes", ""]) {
      process.env["TRUST_PROXY"] = value;
      try {
        const request = {
          headers: { "x-forwarded-for": "1.2.3.4" },
          ip: "10.0.0.1",
          socket,
        } as unknown as Request;
        expect(clientIp(request), `TRUST_PROXY=${value}`).toBe("10.0.0.1");
      } finally {
        delete process.env["TRUST_PROXY"];
      }
    }
  });

  it("falls back to the socket address", () => {
    expect(clientIp({ headers: {}, socket } as unknown as Request)).toBe("10.0.0.9");
    expect(clientIp({ headers: {} } as unknown as Request)).toBe("unknown");
  });
});

describe("clientUserAgent", () => {
  it("truncates what an attacker controls", () => {
    expect(clientUserAgent({ headers: { "user-agent": "curl" } } as unknown as Request)).toBe(
      "curl",
    );
    const long = clientUserAgent({
      headers: { "user-agent": "x".repeat(2000) },
    } as unknown as Request);
    expect(long).toHaveLength(512);
    expect(clientUserAgent({ headers: {} } as unknown as Request)).toBeUndefined();
  });
});

describe("roleAtLeast", () => {
  it("ranks owner above admin above editor above viewer", () => {
    expect(roleAtLeast("owner", "viewer")).toBe(true);
    expect(roleAtLeast("admin", "editor")).toBe(true);
    expect(roleAtLeast("editor", "admin")).toBe(false);
    expect(roleAtLeast("viewer", "viewer")).toBe(true);
  });
});

describe("JwtAuthGuard", () => {
  // Built per test: `restoreMocks` strips the implementation off a shared `vi.fn()`.
  const makeVerifier = () => ({
    verifyAccessToken: vi.fn().mockResolvedValue({
      sub: "user-1",
      ws: "ws-1",
      role: "admin",
      kind: "web",
      jti: "session-1",
      iat: 1,
      exp: 2,
      iss: "http://localhost:3001",
    }),
  });

  it("lets a @Public() route through without a token", async () => {
    const guard = new JwtAuthGuard(reflectorFor({ [IS_PUBLIC_KEY]: true }), makeVerifier());
    await expect(guard.canActivate(contextFor({ headers: {} }))).resolves.toBe(true);
  });

  it("refuses a request with no bearer token", async () => {
    const guard = new JwtAuthGuard(reflectorFor({}), makeVerifier());
    await expect(guard.canActivate(contextFor({ headers: {} }))).rejects.toMatchObject({
      code: "common/unauthorized",
      httpStatus: HttpStatus.UNAUTHORIZED,
    });
  });

  it("attaches the principal from the claims and nothing from the request", async () => {
    const guard = new JwtAuthGuard(reflectorFor({}), makeVerifier());
    const request = {
      headers: { authorization: "Bearer token", "x-workspace-id": "ws-somebody-else" },
    } as unknown as Request & { principal?: unknown };

    await RequestContext.run({ requestId: "req-1" }, async () => {
      await guard.canActivate(contextFor(request));
      expect(RequestContext.get()).toMatchObject({ userId: "user-1", workspaceId: "ws-1" });
    });

    expect(request.principal).toEqual({
      userId: "user-1",
      workspaceId: "ws-1",
      role: "admin",
      kind: "web",
      jti: "session-1",
    });
  });

  // ---------------------------------------------------------------------
  // B08b (CONTRACTS §5): a bridge token never passes this guard for an
  // ordinary user route unless one opts in with `@AllowBridgeToken()`.
  // ---------------------------------------------------------------------

  const bridgeVerifier = () => ({
    verifyAccessToken: vi.fn().mockResolvedValue({
      sub: "user-1",
      ws: "ws-1",
      role: "editor",
      kind: "bridge",
      jti: "session-1",
      iat: 1,
      exp: 2,
      iss: "http://localhost:3001",
      deviceId: "device-1",
    }),
  });

  it("refuses a bridge token on a route with no @AllowBridgeToken()", async () => {
    const guard = new JwtAuthGuard(reflectorFor({}), bridgeVerifier());
    const request = { headers: { authorization: "Bearer token" } } as unknown as Request;
    await expect(guard.canActivate(contextFor(request))).rejects.toMatchObject({
      code: "common/forbidden",
      httpStatus: HttpStatus.FORBIDDEN,
    });
  });

  it("lets a bridge token through a route that opts in with @AllowBridgeToken()", async () => {
    const guard = new JwtAuthGuard(
      reflectorFor({ [ALLOW_BRIDGE_TOKEN_KEY]: true }),
      bridgeVerifier(),
    );
    const request = {
      headers: { authorization: "Bearer token" },
    } as unknown as Request & { principal?: unknown };
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.principal).toMatchObject({ kind: "bridge", deviceId: "device-1" });
  });
});

describe("RolesGuard", () => {
  const principal = { userId: "u", workspaceId: "w", role: "editor", kind: "web", jti: "j" };

  it("passes a route with no @Roles", () => {
    const guard = new RolesGuard(reflectorFor({}));
    expect(guard.canActivate(contextFor({ headers: {} }))).toBe(true);
  });

  it("admits a role at or above the requirement", () => {
    const guard = new RolesGuard(reflectorFor({ [ROLES_KEY]: ["editor"] }));
    expect(guard.canActivate(contextFor({ principal } as never))).toBe(true);
  });

  it("refuses a role below the requirement", () => {
    const guard = new RolesGuard(reflectorFor({ [ROLES_KEY]: ["admin"] }));
    expect(() => guard.canActivate(contextFor({ principal } as never))).toThrowError(
      expect.objectContaining({ code: "common/forbidden" }),
    );
  });

  it("refuses when no guard put a principal there", () => {
    const guard = new RolesGuard(reflectorFor({ [ROLES_KEY]: ["viewer"] }));
    expect(() => guard.canActivate(contextFor({ headers: {} }))).toThrowError(
      expect.objectContaining({ code: "common/unauthorized" }),
    );
  });
});

describe("parseApiKey", () => {
  it("splits `<prefix>.<secret>` and rejects anything else", () => {
    expect(parseApiKey("ak_livekey01.abcdefghijklmnopqrst")).toEqual({
      prefix: "ak_livekey01",
      secret: "abcdefghijklmnopqrst",
    });
    expect(parseApiKey("nodot")).toBeUndefined();
    expect(parseApiKey(".secret")).toBeUndefined();
    expect(parseApiKey("prefix.")).toBeUndefined();
    expect(parseApiKey("sh.rt")).toBeUndefined();
    expect(parseApiKey("ak_livekey01.short")).toBeUndefined();
  });

  it("hashes the secret half only", () => {
    expect(hashApiKeySecret("abcdefghijklmnopqrst")).toHaveLength(64);
    expect(hashApiKeySecret("a")).not.toBe(hashApiKeySecret("b"));
  });
});

describe("ApiKeyGuard", () => {
  const secret = "abcdefghijklmnopqrstuvwx";
  const record = {
    id: "key-1",
    hash: hashApiKeySecret(secret),
    scopes: ["projects_read", "projects_write"],
    revokedAt: null,
    expiresAt: null,
    workspaceId: "ws-1",
    workspace: { ownerId: "owner-1", deletedAt: null },
  };

  function guardWith(found: unknown, metadata: Record<string, unknown> = {}) {
    const prisma = { apiKey: { findUnique: vi.fn().mockResolvedValue(found) } };
    return new ApiKeyGuard(reflectorFor(metadata), prisma as never);
  }

  it("authenticates a live key and derives a principal capped at editor", async () => {
    const guard = guardWith(record);
    const request = { headers: { "x-api-key": `ak_prefix01.${secret}` } } as unknown as Request & {
      principal?: { role: string; workspaceId: string; kind: string };
    };
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.principal).toMatchObject({
      workspaceId: "ws-1",
      userId: "owner-1",
      role: "editor",
      kind: "api",
    });
  });

  it("never grants more than viewer without a write scope (D27)", async () => {
    const guard = guardWith({ ...record, scopes: ["projects_read"] });
    const request = { headers: { "x-api-key": `ak_prefix01.${secret}` } } as unknown as Request & {
      principal?: { role: string };
    };
    await guard.canActivate(contextFor(request));
    expect(request.principal?.role).toBe("viewer");
  });

  it("refuses a missing, malformed, unknown, wrong or revoked key alike", async () => {
    const cases: [string, unknown, Record<string, string>][] = [
      ["missing", record, {}],
      ["malformed", record, { "x-api-key": "nonsense" }],
      ["unknown", null, { "x-api-key": `ak_prefix01.${secret}` }],
      ["wrong secret", record, { "x-api-key": `ak_prefix01.${"z".repeat(24)}` }],
      ["revoked", { ...record, revokedAt: new Date() }, { "x-api-key": `ak_prefix01.${secret}` }],
      [
        "deleted workspace",
        { ...record, workspace: { ownerId: "o", deletedAt: new Date() } },
        { "x-api-key": `ak_prefix01.${secret}` },
      ],
      [
        "expired (rotation overlap elapsed)",
        { ...record, expiresAt: new Date(Date.now() - 1_000) },
        { "x-api-key": `ak_prefix01.${secret}` },
      ],
    ];

    for (const [, found, headers] of cases) {
      const guard = guardWith(found);
      await expect(guard.canActivate(contextFor({ headers } as never))).rejects.toMatchObject({
        code: "common/unauthorized",
      });
    }
  });

  it("enforces the scopes a route asked for", async () => {
    const guard = guardWith(
      { ...record, scopes: ["projects_read"] },
      { "montaj:api-scopes": ["projects_write"] },
    );
    await expect(
      guard.canActivate(contextFor({ headers: { "x-api-key": `ak_prefix01.${secret}` } } as never)),
    ).rejects.toMatchObject({ code: "common/forbidden" });
  });

  it("admits a key inside its rotation overlap window (expiresAt in the future)", async () => {
    const guard = guardWith({ ...record, expiresAt: new Date(Date.now() + 60_000) });
    await expect(
      guard.canActivate(contextFor({ headers: { "x-api-key": `ak_prefix01.${secret}` } } as never)),
    ).resolves.toBe(true);
  });
});

describe("RateLimitGuard", () => {
  const rule: RateLimitRule = { name: "test", by: "ip", capacity: 2, refillPerSec: 1 };

  function guardWith(
    rules: RateLimitRule[] | undefined,
    verdict: { allowed: boolean; remaining: number; retryAfterSec: number },
  ) {
    const limiter = { consume: vi.fn().mockResolvedValue(verdict) } as unknown as RateLimitService;
    const headers: Record<string, string> = {};
    const response = {
      setHeader(name: string, value: string) {
        // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
        headers[name] = value;
        return this;
      },
    } as unknown as Partial<Response>;
    const guard = new RateLimitGuard(reflectorFor({ [RATE_LIMIT_KEY]: rules }), limiter);
    return { guard, headers, response, limiter };
  }

  it("does nothing on a route with no buckets", async () => {
    const { guard, limiter } = guardWith(undefined, {
      allowed: true,
      remaining: 1,
      retryAfterSec: 0,
    });
    await expect(guard.canActivate(contextFor({ headers: {} }))).resolves.toBe(true);
    expect(limiter.consume).not.toHaveBeenCalled();
  });

  it("publishes the remaining allowance on a request it lets through", async () => {
    const { guard, headers, response } = guardWith([rule], {
      allowed: true,
      remaining: 1,
      retryAfterSec: 0,
    });
    await guard.canActivate(contextFor({ headers: {}, socket: {} } as never, response));
    expect(headers["X-RateLimit-Limit"]).toBe("2");
    expect(headers["X-RateLimit-Remaining"]).toBe("1");
  });

  it("answers 429 with Retry-After when the bucket is empty", async () => {
    const { guard, headers, response } = guardWith([rule], {
      allowed: false,
      remaining: 0,
      retryAfterSec: 7,
    });
    await expect(
      guard.canActivate(contextFor({ headers: {}, socket: {} } as never, response)),
    ).rejects.toMatchObject({ code: "common/rate_limited", httpStatus: 429 });
    expect(headers["Retry-After"]).toBe("7");
  });

  it("skips a bucket whose subject is not on the request", async () => {
    // No principal and no body email: a shared "unknown" bucket would let one
    // caller lock everybody else out, so the rule is skipped instead.
    const { guard, limiter } = guardWith(
      [
        { name: "by-user", by: "user", capacity: 1, refillPerSec: 1 },
        { name: "by-email", by: "email", capacity: 1, refillPerSec: 1 },
      ],
      { allowed: true, remaining: 1, retryAfterSec: 0 },
    );
    await expect(guard.canActivate(contextFor({ headers: {}, body: {} } as never))).resolves.toBe(
      true,
    );
    expect(limiter.consume).not.toHaveBeenCalled();
  });

  it("keys a bucket on the body address without putting it in the key", async () => {
    const { guard, limiter, response } = guardWith(
      [{ name: "by-email", by: "email", capacity: 1, refillPerSec: 1 }],
      { allowed: true, remaining: 1, retryAfterSec: 0 },
    );
    await guard.canActivate(
      contextFor({ headers: {}, body: { email: "Someone@Example.test" } } as never, response),
    );
    const subject = (limiter.consume as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[1];
    expect(subject).toMatch(/^[0-9a-f]{32}$/);
    expect(String(subject)).not.toContain("example");
  });
});
