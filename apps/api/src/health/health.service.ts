import { Inject, Injectable } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { PrismaService } from "../common/prisma/prisma.service.js";
import { RedisService } from "../common/redis/redis.service.js";
import { ENV } from "../config/config.module.js";

export type DependencyStatus = "up" | "down";

export interface DependencyCheck {
  readonly status: DependencyStatus;
  readonly latencyMs: number;
  /** Present only when `status` is `"down"`; never carries a credential. */
  readonly error?: string;
}

export interface ReadinessReport {
  readonly status: "ok" | "degraded";
  readonly checks: {
    readonly db: DependencyCheck;
    readonly redis: DependencyCheck;
    readonly storage: DependencyCheck;
  };
}

/** How long a single dependency may take before the probe calls it down. */
const CHECK_TIMEOUT_MS = 2_000;

/** Error text, trimmed and with anything credential-shaped removed. */
function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\/\/[^@\s]*@/g, "//***@").slice(0, 200);
}

async function timed(fn: () => Promise<unknown>): Promise<DependencyCheck> {
  const started = Date.now();
  try {
    await fn();
    return { status: "up", latencyMs: Date.now() - started };
  } catch (error) {
    return { status: "down", latencyMs: Date.now() - started, error: describe(error) };
  }
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Is the object store reachable?
   *
   * An unauthenticated request to the raw bucket is enough: MinIO and S3 both
   * answer 403, and any HTTP status at all proves the endpoint is up and routable.
   * Signing the request would test the credentials too, but at the cost of an
   * S3 SDK dependency the API does not otherwise need until A06.
   */
  private async checkStorage(): Promise<void> {
    const url = `${this.env.S3_ENDPOINT.replace(/\/$/, "")}/${this.env.S3_BUCKET_RAW}`;
    const response = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    // 5xx means the store itself is unwell; 403/404 means it answered, which is
    // all this probe claims to know.
    if (response.status >= 500) {
      throw new Error(`storage returned ${response.status}`);
    }
  }

  /**
   * Check every dependency in parallel and report each one separately.
   *
   * Deliberately not fail-fast: an operator needs to know that Redis is down AND
   * that Postgres is fine, which a short-circuiting probe cannot tell them.
   */
  async readiness(): Promise<ReadinessReport> {
    const [db, redis, storage] = await Promise.all([
      timed(() => this.prisma.ping()),
      timed(() => this.redis.ping()),
      timed(() => this.checkStorage()),
    ]);

    const status =
      db.status === "up" && redis.status === "up" && storage.status === "up" ? "ok" : "degraded";

    return { status, checks: { db, redis, storage } };
  }
}
