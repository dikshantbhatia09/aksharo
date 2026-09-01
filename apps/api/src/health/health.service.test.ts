import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "@montaj/config";

import { HealthService } from "./health.service.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { RedisService } from "../common/redis/redis.service.js";

const ENV = {
  S3_ENDPOINT: "http://storage.test:9000",
  S3_BUCKET_RAW: "montaj-raw",
} as unknown as Env;

function serviceWith(options: {
  db?: () => Promise<void>;
  redis?: () => Promise<void>;
  fetchStatus?: number | Error;
}): HealthService {
  const prisma = { ping: vi.fn(options.db ?? (async () => undefined)) } as unknown as PrismaService;
  const redis = {
    ping: vi.fn(options.redis ?? (async () => undefined)),
  } as unknown as RedisService;

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (options.fetchStatus instanceof Error) throw options.fetchStatus;
      return { status: options.fetchStatus ?? 403 } as Response;
    }),
  );

  return new HealthService(prisma, redis, ENV);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HealthService.readiness", () => {
  it("reports ok with a latency per dependency when all three answer", async () => {
    const report = await serviceWith({}).readiness();

    expect(report.status).toBe("ok");
    expect(report.checks.db.status).toBe("up");
    expect(report.checks.redis.status).toBe("up");
    expect(report.checks.storage.status).toBe("up");
    expect(report.checks.db.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("treats a 403 from the object store as reachable", async () => {
    // MinIO and S3 both answer 403 unauthenticated; that still proves the endpoint
    // is up, which is all this probe claims.
    const report = await serviceWith({ fetchStatus: 403 }).readiness();
    expect(report.checks.storage.status).toBe("up");
  });

  it("treats a 5xx from the object store as down", async () => {
    const report = await serviceWith({ fetchStatus: 503 }).readiness();
    expect(report.status).toBe("degraded");
    expect(report.checks.storage.status).toBe("down");
    expect(report.checks.storage.error).toContain("503");
  });

  it("still reports the healthy dependencies when one is down", async () => {
    const report = await serviceWith({
      redis: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
      },
    }).readiness();

    expect(report.status).toBe("degraded");
    expect(report.checks.db.status).toBe("up");
    expect(report.checks.redis.status).toBe("down");
    expect(report.checks.redis.error).toContain("ECONNREFUSED");
  });

  it("strips credentials out of a connection error before reporting it", async () => {
    const report = await serviceWith({
      db: async () => {
        throw new Error("Can't reach postgresql://montaj:s3cret@db:5432/montaj");
      },
    }).readiness();

    expect(report.checks.db.error).not.toContain("s3cret");
    expect(report.checks.db.error).toContain("//***@");
  });

  it("caps a very long error message", async () => {
    const report = await serviceWith({
      db: async () => {
        throw new Error("x".repeat(500));
      },
    }).readiness();
    expect(report.checks.db.error?.length).toBeLessThanOrEqual(200);
  });

  it("reports a non-Error rejection without crashing", async () => {
    const report = await serviceWith({
      redis: async () => {
        throw "plain string failure";
      },
    }).readiness();
    expect(report.checks.redis.error).toBe("plain string failure");
  });
});
