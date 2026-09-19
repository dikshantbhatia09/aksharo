import { randomBytes } from "node:crypto";

import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";

import { PrismaService } from "../common/prisma/prisma.service.js";
import { RedisService } from "../common/redis/redis.service.js";
import { DERIVED_STORE, RAW_STORE } from "../common/storage/object-store.js";

import type { ObjectStore } from "../common/storage/object-store.js";

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

/**
 * Where the boot-time canary object is written.
 *
 * A fixed prefix so the workload's IAM policy can grant exactly
 * `s3:PutObject`/`GetObject`/`DeleteObject` on `_montaj-health/*` and nothing
 * else, and so a lifecycle rule can sweep anything a crashed pod left behind.
 */
export const CANARY_PREFIX = "_montaj-health/";

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
export class HealthService implements OnApplicationBootstrap {
  private readonly logger = new Logger(HealthService.name);

  /**
   * Result of the boot-time write/read/delete canary, per store.
   *
   * `undefined` until it has run. A failed canary keeps readiness down for the
   * life of the process, which is the point: a pod whose object-store
   * credentials do not work cannot serve uploads or exports, and must never
   * join the load balancer. Under `helm --atomic` that turns an invalid
   * credential into an automatic rollback instead of a silently broken release.
   */
  private canary?: DependencyCheck;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(RAW_STORE) private readonly raw: ObjectStore,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
  ) {}

  /**
   * Prove, once, that this process can actually use both object stores.
   *
   * The old readiness probe sent an *unauthenticated* `HEAD` at the raw bucket
   * and counted 403 as "up" — so it passed with no credentials at all, with the
   * wrong credentials, with a read-only role, and with the derived store
   * entirely unreachable. It proved the endpoint resolved, and was read as
   * proof that storage worked (launch-readiness P0-10).
   *
   * This writes a small object, reads it back, checks the bytes and deletes it,
   * signed, on both stores. It runs at bootstrap rather than on every probe
   * because it is four round trips and a write; the per-probe check is the cheap
   * signed {@link ObjectStore.head} below, which still fails closed on a bad
   * credential.
   */
  async onApplicationBootstrap(): Promise<void> {
    this.canary = await timed(async () => {
      await Promise.all([this.runCanary(this.raw), this.runCanary(this.derived)]);
    });

    if (this.canary.status === "down") {
      this.logger.error(
        { err: this.canary.error },
        "object-store canary FAILED: this process cannot write, read back and delete " +
          "its own object. Readiness stays down — check the workload's credentials, " +
          "bucket names and IAM policy.",
      );
      return;
    }
    this.logger.log(
      { latencyMs: this.canary.latencyMs },
      `object-store canary passed on ${this.raw.bucket} and ${this.derived.bucket}`,
    );
  }

  /** Write, read back, verify and delete one object. Cleans up on failure too. */
  private async runCanary(store: ObjectStore): Promise<void> {
    // A per-process key, so two replicas booting together never race on one
    // object and read each other's bytes.
    const key = `${CANARY_PREFIX}${randomBytes(16).toString("hex")}`;
    const body = `montaj-canary ${randomBytes(8).toString("hex")}`;

    try {
      await store.put({ key, body, contentType: "text/plain" });
      const read = await store.get(key);
      if (read.toString("utf8") !== body) {
        throw new Error(`${store.bucket}: read back different bytes than were written`);
      }
    } finally {
      // Best effort: a canary object left behind is litter, not an outage, and
      // the delete must not mask the real failure above.
      await store.delete(key).catch(() => undefined);
    }
  }

  /**
   * Can this process reach the object stores, right now?
   *
   * A *signed* `head` on a key that does not exist. "Not found" is a success: it
   * means the store accepted the signature and answered about the bucket, which
   * is exactly what this probe claims to know. A bad credential, a missing
   * bucket or an unreachable endpoint all throw, and all mean down — unlike the
   * unauthenticated request this replaced, which could not tell any of them
   * apart from healthy.
   */
  private async checkStorage(): Promise<void> {
    const key = `${CANARY_PREFIX}probe`;
    await Promise.all([
      withTimeout(this.raw.head(key), CHECK_TIMEOUT_MS, `${this.raw.bucket} head`),
      withTimeout(this.derived.head(key), CHECK_TIMEOUT_MS, `${this.derived.bucket} head`),
    ]);
  }

  /**
   * Check every dependency in parallel and report each one separately.
   *
   * Deliberately not fail-fast: an operator needs to know that Redis is down AND
   * that Postgres is fine, which a short-circuiting probe cannot tell them.
   */
  async readiness(): Promise<ReadinessReport> {
    const [db, redis, reachable] = await Promise.all([
      timed(() => this.prisma.ping()),
      timed(() => this.redis.ping()),
      timed(() => this.checkStorage()),
    ]);

    // Reachability alone is not enough while the boot canary is failing or has
    // not finished: the process has not proved it can use the stores.
    const storage: DependencyCheck =
      reachable.status === "down"
        ? reachable
        : this.canary === undefined
          ? { status: "down", latencyMs: reachable.latencyMs, error: "canary has not run yet" }
          : this.canary.status === "down"
            ? { ...this.canary, error: `canary failed: ${this.canary.error ?? "unknown"}` }
            : reachable;

    const status =
      db.status === "up" && redis.status === "up" && storage.status === "up" ? "ok" : "degraded";

    return { status, checks: { db, redis, storage } };
  }
}

/** Reject rather than hang: a probe that never answers is a pod that never drains. */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${what} timed out after ${String(ms)}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
