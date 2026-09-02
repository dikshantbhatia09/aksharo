/**
 * The dead-letter path end to end, against real infrastructure.
 *
 * enqueue → three failing attempts → a `dlq` row with the last error → an admin
 * replays it as attempt 4 → the worker succeeds → and the admin discards a second
 * one, which releases its hold and writes an audit row.
 *
 * It needs Postgres, because the whole design is conditional SQL and a partial
 * unique index, and Redis, because the point of a replay is that a *real* BullMQ
 * job appears under the new attempt's id. Without either, the suite skips loudly.
 */
import { createSign, generateKeyPairSync } from "node:crypto";

import { type PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Env } from "@montaj/config";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { PrismaService } from "../src/common/prisma/prisma.service.js";
import { RedisService } from "../src/common/redis/redis.service.js";
import { ENV } from "../src/config/config.module.js";
import { NoopCreditsFacade } from "../src/credits/noop-credits.facade.js";
import { internalSignatureHeaders } from "../src/internal/internal-signature.js";
import { DlqService } from "../src/jobs/dlq.service.js";
import { JobsService } from "../src/jobs/jobs.service.js";
import { bullJobId } from "../src/jobs/queue.registry.js";
import { JobEventRetentionTask } from "../src/jobs/tasks/job-event-retention.task.js";

import type { TestDatabase } from "./db-harness.js";
import type { INestApplication } from "@nestjs/common";

const CALLBACK_SECRET = "test-callback-secret-at-least-32-characters-long";
const PREFIX = process.env["MONTAJ_QUEUE_PREFIX"] ?? "bull";

const DB_READY = isDatabaseAvailable();
const REDIS_READY = isRedisAvailable();
const CAN_RUN = DB_READY && REDIS_READY;

if (!CAN_RUN) {
  console.warn(
    `[dlq.e2e] skipped — ${DB_READY ? "" : `database: ${skipReason}. `}${
      REDIS_READY ? "" : `redis: ${redisSkipReason}.`
    }`,
  );
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM_PUBLIC = publicKey.export({ type: "spki", format: "pem" }).toString();
const PEM_PRIVATE = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ISSUER = "http://localhost:3001";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function crockford(value: number, length: number): string {
  let out = "";
  let remaining = value;
  while (remaining > 0) {
    out = `${CROCKFORD[remaining % 32] ?? "0"}${out}`;
    remaining = Math.floor(remaining / 32);
  }
  return out.padStart(length, "0").slice(-length);
}
const RUN = crockford(Date.now(), 10);
const id = (kind: string): string => `01JD${kind}${RUN}`.padEnd(26, "0").slice(0, 26);

const ADMIN = id("ADMN");
const USER = id("US3R");
const WORKSPACE = id("WKSP");
const PROJECT = id("PR0J");

let db: TestDatabase | null = null;
let prisma: PrismaClient;
let app: INestApplication;
let jobs: JobsService;
let dlq: DlqService;
let redis: IORedis;

function accessToken(sub: string): string {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub,
    ws: WORKSPACE,
    role: "owner",
    kind: "web",
    jti: id("JT1"),
    iat: now,
    exp: now + 900,
    // A04's `TokenService` pins the issuer to `API_ORIGIN`.
    iss: ISSUER,
  };
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signed = `${b64(header)}.${b64(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signed);
  signer.end();
  return `${signed}.${signer.sign(privateKey).toString("base64url")}`;
}

const asAdmin = () => `Bearer ${accessToken(ADMIN)}`;
const asUser = () => `Bearer ${accessToken(USER)}`;

/** POST a signed internal callback exactly as a worker would. */
function callback(path: string, body: unknown, attemptId: string) {
  const raw = JSON.stringify(body);
  return request(app.getHttpServer())
    .post(path)
    .set(internalSignatureHeaders({ secret: CALLBACK_SECRET, attemptId, body: raw }))
    .send(raw);
}

let enqueued = 0;
async function enqueue(worstCaseTenths = 100) {
  enqueued += 1;
  return jobs.enqueue({
    type: "ai.transcribe",
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    params: { mediaId: id("MEDA") },
    jobKey: `a08b-${RUN}-${String(enqueued)}`,
    worstCaseTenths,
  });
}

/**
 * Drive a job through `attempts` failing attempts. Only the last one carries
 * `finalAttempt`, which is what BullMQ sets when the retry budget is spent — so
 * this is the shape of a genuine three-strikes failure, not a shortcut to the DLQ.
 */
async function failEveryAttempt(jobId: string, attempts: number, message: string) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    await callback(
      `/internal/jobs/${jobId}/complete`,
      {
        status: "failed",
        finalAttempt: attempt === attempts,
        error: { code: "provider/timeout", message, retryable: true },
      },
      job.attemptId ?? "",
    ).expect(200);

    if (attempt === attempts) break;
    // BullMQ retries on the SAME jobs row with a new attempt; simulate that.
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "queued",
        attemptNo: attempt + 1,
        attemptId: `01JDATT${crockford(Date.now() + attempt, 6)}`.padEnd(26, "0").slice(0, 26),
        finishedAt: null,
        creditsChargedTenths: job.creditsChargedTenths,
      },
    });
  }
}

beforeAll(async () => {
  if (!CAN_RUN) return;

  db = await createTestDatabase();
  if (db === null) throw new Error(`could not start a test database: ${skipReason}`);
  prisma = db.prisma;
  await prisma.$connect();

  await prisma.user.create({
    data: { id: ADMIN, email: `a08b-admin+${RUN}@example.test`, isAdmin: true },
  });
  await prisma.user.create({
    data: { id: USER, email: `a08b-user+${RUN}@example.test`, isAdmin: false },
  });
  await prisma.workspace.create({
    data: {
      id: WORKSPACE,
      slug: `a08b-${RUN}`,
      name: "A08b",
      ownerId: ADMIN,
      billingCountry: "IN",
    },
  });
  await prisma.membership.create({
    data: {
      id: id("MBR1"),
      workspaceId: WORKSPACE,
      userId: ADMIN,
      role: "owner",
      status: "active",
    },
  });
  await prisma.project.create({
    data: { id: PROJECT, workspaceId: WORKSPACE, title: "A08b fixture" },
  });

  // A creator plan, so the free-tier daily cap in the no-op facade does not fail
  // the fifth enqueue of the suite instead of the thing under test.
  const plan = await prisma.plan.upsert({
    where: { key: "creator" },
    update: {},
    create: { id: id("PLAN"), key: "creator", name: "Creator", creditsPerMonthTenths: 3_000 },
  });
  await prisma.subscription.create({
    data: {
      id: id("SUBS"),
      workspaceId: WORKSPACE,
      planId: plan.id,
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  });

  redis = new IORedis(testRedisUrl(), { maxRetriesPerRequest: null });

  const { Test } = await import("@nestjs/testing");
  const { AppModule } = await import("../src/app.module.js");
  const { HttpExceptionFilter } = await import("../src/common/errors/http-exception.filter.js");
  const { resolveEnv } = await import("../src/config/config.module.js");
  const { setupOpenApi } = await import("../src/openapi.js");

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(
      Object.assign(prisma, {
        ping: async () => undefined,
        withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => prisma.$transaction(fn),
      }),
    )
    .overrideProvider(RedisService)
    .useValue({
      client: redis,
      ping: async () => undefined,
      onModuleDestroy: async () => undefined,
    })
    .overrideProvider(ENV)
    .useValue({
      ...resolveEnv(),
      API_ORIGIN: ISSUER,
      JWT_PUBLIC_KEY: PEM_PUBLIC,
      JWT_PRIVATE_KEY: PEM_PRIVATE,
      INTERNAL_CALLBACK_SECRET: CALLBACK_SECRET,
    } as Env)
    .compile();

  app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  app.useGlobalFilters(new HttpExceptionFilter());
  setupOpenApi(app);
  await app.init();

  jobs = app.get(JobsService);
  dlq = app.get(DlqService);
}, 180_000);

afterEach(async () => {
  if (!CAN_RUN) return;
  await prisma.job.updateMany({
    where: { workspaceId: WORKSPACE, status: { in: ["queued", "running"] } },
    data: { status: "cancelled", finishedAt: new Date(), creditsChargedTenths: 0 },
  });
});

afterAll(async () => {
  if (!CAN_RUN) return;
  await app?.close();
  if (prisma !== undefined) {
    await prisma.auditLog.deleteMany({ where: { workspaceId: WORKSPACE } });
    await prisma.job.deleteMany({ where: { workspaceId: WORKSPACE } });
    await prisma.subscription.deleteMany({ where: { workspaceId: WORKSPACE } });
    await prisma.project.deleteMany({ where: { workspaceId: WORKSPACE } });
    await prisma.membership.deleteMany({ where: { workspaceId: WORKSPACE } });
    await prisma.workspace.deleteMany({ where: { id: WORKSPACE } });
    await prisma.user.deleteMany({ where: { id: { in: [ADMIN, USER] } } });
  }
  if (redis !== undefined) {
    const keys = await redis.keys(`${PREFIX}:*`);
    if (keys.length > 0) await redis.del(...keys);
    redis.disconnect();
  }
  await db?.stop();
}, 60_000);

describe.skipIf(!CAN_RUN)("dead-letter queue, end to end", () => {
  it("lands a job that failed every attempt in the DLQ with the last error", async () => {
    const { job } = await enqueue(120);
    await failEveryAttempt(job.id, 3, "upstream timed out");

    const entry = await prisma.dlqEntry.findFirstOrThrow({ where: { jobId: job.id } });
    expect(entry.status).toBe("pending");
    expect(entry.queue).toBe("ai.transcribe");
    expect(entry.attempts).toBe(3);
    expect(entry.worstCaseTenths).toBe(120);
    expect(entry.lastError).toMatchObject({
      code: "provider/timeout",
      message: "upstream timed out",
    });

    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("failed");
    expect(row.dlq).toBe(true);
    expect(row.dlqReason).toBe("provider/timeout");
  });

  it("replays it as attempt 4, onto a real BullMQ queue, and the worker succeeds", async () => {
    const { job } = await enqueue(120);
    await failEveryAttempt(job.id, 3, "upstream timed out");

    const response = await request(app.getHttpServer())
      .get("/admin/dlq")
      .query({ queue: "ai.transcribe" })
      .set("Authorization", asAdmin())
      .expect(200);
    const entryId = (response.body as { items: { id: string; jobId: string }[] }).items.find(
      (row) => row.jobId === job.id,
    )?.id;
    expect(entryId).toBeTypeOf("string");

    const replay = await request(app.getHttpServer())
      .post(`/admin/dlq/${entryId ?? ""}/replay`)
      .set("Authorization", asAdmin())
      .expect(200);
    const { attemptId, attemptNo } = replay.body as { attemptId: string; attemptNo: number };
    expect(attemptNo).toBe(4);

    // A REAL BullMQ job exists under the new attempt's id.
    const queue = new Queue("ai.transcribe", { connection: redis, prefix: PREFIX });
    try {
      const bull = await queue.getJob(bullJobId(job.id, attemptId));
      expect(bull).not.toBeUndefined();
      expect(bull?.data).toMatchObject({ jobId: job.id, attemptId, jobKey: job.jobKey });
    } finally {
      await queue.close();
    }

    // ...and the worker's completion for THAT attempt lands.
    await callback(`/internal/jobs/${job.id}/complete`, { status: "succeeded" }, attemptId).expect(
      200,
    );
    const finished = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(finished.status).toBe("succeeded");
    expect(finished.attemptNo).toBe(4);
    expect(finished.dlq).toBe(false);
  });

  it("discards, releases the hold and writes an audit row", async () => {
    const { job } = await enqueue(80);
    await failEveryAttempt(job.id, 1, "no audio stream");
    const entry = await prisma.dlqEntry.findFirstOrThrow({ where: { jobId: job.id } });

    const credits = app.get(NoopCreditsFacade);
    const release = vi.spyOn(credits, "release");

    const response = await request(app.getHttpServer())
      .post(`/admin/dlq/${entry.id}/discard`)
      .set("Authorization", asAdmin())
      .send({ reason: "unsupported input" })
      .expect(200);

    expect(response.body).toMatchObject({ holdReleased: true, reason: "unsupported input" });
    expect(release).toHaveBeenCalled();
    release.mockRestore();

    const after = await prisma.dlqEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(after.status).toBe("discarded");
    expect(after.resolution).toBe("unsupported input");
    expect(after.resolvedBy).toBe(ADMIN);

    const audit = await prisma.auditLog.findFirst({
      where: { resource: "dlq", resourceId: entry.id },
    });
    expect(audit).toMatchObject({ action: "dlq.discard", actorId: ADMIN, actorKind: "admin" });
  });

  it("filters by a substring of the last error, which is what triage needs", async () => {
    const { job } = await enqueue();
    await failEveryAttempt(job.id, 1, "a very distinctive phrase");

    const found = await dlq.list({ reason: "very distinctive" });
    expect(found.items.map((row) => row.jobId)).toContain(job.id);

    const missing = await dlq.list({ reason: "not in any message at all" });
    expect(missing.items.map((row) => row.jobId)).not.toContain(job.id);
  });

  it("reports per-queue stats: how many, since when, how many distinct errors", async () => {
    const { job } = await enqueue();
    await failEveryAttempt(job.id, 1, "stats fixture");

    const response = await request(app.getHttpServer())
      .get("/admin/dlq/stats")
      .set("Authorization", asAdmin())
      .expect(200);

    const body = response.body as {
      pending: number;
      queues: { queue: string; pending: number; oldestFailedAt: string | null }[];
    };
    const transcribe = body.queues.find((row) => row.queue === "ai.transcribe");
    expect(transcribe?.pending).toBeGreaterThan(0);
    expect(transcribe?.oldestFailedAt).toBeTypeOf("string");
  });
});

describe.skipIf(!CAN_RUN)("admin authorisation (THREAT-MODEL T20)", () => {
  it("403s an authenticated non-admin on every DLQ route", async () => {
    // Each request is built inside the loop: supertest listens on the server per
    // call, so a batch created up front races itself.
    const routes: [method: "get" | "post", path: string, body?: unknown][] = [
      ["get", "/admin/dlq"],
      ["get", "/admin/dlq/stats"],
      ["get", `/admin/dlq/${id("N0PE")}`],
      ["post", `/admin/dlq/${id("N0PE")}/replay`],
      ["post", `/admin/dlq/${id("N0PE")}/discard`, { reason: "x" }],
      ["post", "/admin/dlq/replay", { dryRun: true }],
      ["post", "/admin/dlq/discard", { dryRun: true, discardReason: "x" }],
    ];

    for (const [method, path, body] of routes) {
      const call =
        method === "get"
          ? request(app.getHttpServer()).get(path)
          : request(app.getHttpServer())
              .post(path)
              .send(body ?? {});
      const response = await call.set("Authorization", asUser());
      expect(response.status, path).toBe(403);
      expect((response.body as { error: { code: string } }).error.code).toBe("common/forbidden");
    }
  });

  it("401s with no token at all", async () => {
    await request(app.getHttpServer()).get("/admin/dlq").expect(401);
  });
});

describe.skipIf(!CAN_RUN)("the jobKey uniqueness index", () => {
  it("lets one of two concurrent enqueues win and dedupes the other", async () => {
    const jobKey = `a08b-race-${RUN}`;
    const results = await Promise.all([
      jobs.enqueue({
        type: "ai.clean",
        workspaceId: WORKSPACE,
        jobKey,
        worstCaseTenths: 10,
      }),
      jobs.enqueue({
        type: "ai.clean",
        workspaceId: WORKSPACE,
        jobKey,
        worstCaseTenths: 10,
      }),
    ]);

    expect(results[0].job.id).toBe(results[1].job.id);
    expect(results.filter((result) => result.deduplicated)).toHaveLength(1);

    const live = await prisma.job.count({
      where: { workspaceId: WORKSPACE, jobKey, status: { in: ["queued", "running"] } },
    });
    expect(live).toBe(1);
  });

  it("is scoped to the workspace, not global", async () => {
    const other = id("WKSY");
    await prisma.workspace.create({
      data: {
        id: other,
        slug: `a08b-other-${RUN}`,
        name: "other",
        ownerId: ADMIN,
        billingCountry: "IN",
      },
    });
    try {
      const jobKey = `a08b-shared-key-${RUN}`;
      const mine = await jobs.enqueue({
        type: "notify",
        workspaceId: WORKSPACE,
        jobKey,
        worstCaseTenths: 0,
      });
      const theirs = await jobs.enqueue({
        type: "notify",
        workspaceId: other,
        jobKey,
        worstCaseTenths: 0,
      });

      // Two workspaces, the same unit of work, two jobs. The A08 index was
      // UNIQUE (job_key) with no workspace column, which made this a 500.
      expect(theirs.deduplicated).toBe(false);
      expect(theirs.job.id).not.toBe(mine.job.id);
    } finally {
      await prisma.job.deleteMany({ where: { workspaceId: other } });
      await prisma.workspace.deleteMany({ where: { id: other } });
    }
  });
});

describe.skipIf(!CAN_RUN)("job-event retention", () => {
  it("deletes rows past `data.retainUntil` and keeps the rest", async () => {
    const { job } = await enqueue();
    const expired = await prisma.jobEvent.create({
      data: {
        id: id("EXPD"),
        jobId: job.id,
        message: "expired",
        data: { event: "job.progress", retainUntil: new Date(Date.now() - 1_000).toISOString() },
      },
    });

    const deleted = await app.get(JobEventRetentionTask).sweep();

    expect(deleted).toBeGreaterThan(0);
    expect(await prisma.jobEvent.findUnique({ where: { id: expired.id } })).toBeNull();
    // The `job.queued` event this job wrote carries a marker 30 days out.
    expect(await prisma.jobEvent.count({ where: { jobId: job.id } })).toBeGreaterThan(0);
  });

  it("falls back to `at` for rows written before the marker existed", async () => {
    const { job } = await enqueue();
    const ancient = await prisma.jobEvent.create({
      data: {
        id: id("0LD1"),
        jobId: job.id,
        message: "pre-marker",
        at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        data: { event: "job.progress" },
      },
    });

    await app.get(JobEventRetentionTask).sweep();

    expect(await prisma.jobEvent.findUnique({ where: { id: ancient.id } })).toBeNull();
  });

  it("never touches the dead-letter rows themselves", async () => {
    const { job } = await enqueue();
    await failEveryAttempt(job.id, 1, "kept for good");

    await app.get(JobEventRetentionTask).sweep();

    expect(await prisma.dlqEntry.count({ where: { jobId: job.id } })).toBe(1);
  });
});

describe.skipIf(!CAN_RUN)("GET /internal/metrics", () => {
  it("exposes the counters, gauges and histograms in the Prometheus format", async () => {
    const { job } = await enqueue();
    // The queue-wait histogram is recorded on FIRST PICKUP, which is the first
    // progress callback — the only moment the API learns a worker has the job.
    await callback(
      `/internal/jobs/${job.id}/progress`,
      { progress: 5 },
      job.attemptId ?? "",
    ).expect(200);
    await failEveryAttempt(job.id, 1, "metrics fixture");

    const response = await request(app.getHttpServer()).get("/internal/metrics").expect(200);
    expect(response.headers["content-type"]).toContain("text/plain");

    const text = response.text;
    expect(text).toContain("# TYPE montaj_job_completed_total counter");
    expect(text).toContain("# TYPE montaj_queue_dlq_depth gauge");
    expect(text).toContain("# TYPE montaj_jobs_failed_total counter");
    expect(text).toContain("# TYPE montaj_dlq_depth gauge");
    expect(text).toContain("# TYPE montaj_job_queue_wait_ms histogram");
    expect(text).toContain("# TYPE montaj_queue_wait_duration_seconds histogram");
    expect(text).toContain('montaj_jobs_failed_total{queue="ai.transcribe"}');
  });

  it("is not in the OpenAPI document: it is plumbing, not product API", async () => {
    const document = await request(app.getHttpServer()).get("/docs-json").expect(200);
    const paths = Object.keys((document.body as { paths: Record<string, unknown> }).paths);
    expect(paths).not.toContain("/internal/metrics");
    expect(paths).toContain("/admin/dlq");
  });
});
