/**
 * The whole job path, against real infrastructure.
 *
 * enqueue → a BullMQ job carrying the CONTRACTS §3 envelope → a simulated worker
 * posting signed progress and completion → the row, the events, the credit
 * settlement and the WebSocket frames a browser would have seen.
 *
 * It needs Postgres (the `jobs` state machine is conditional SQL, and a fake would
 * be testing the fake) and Redis (the envelope has to be readable by the *real*
 * BullMQ, byte for byte, because a Python worker consumes it). Without either, the
 * suite skips loudly rather than failing.
 */
import { createSign, generateKeyPairSync } from "node:crypto";

import { type PrismaClient, type Job } from "@prisma/client";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import type { Env } from "@montaj/config";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { PrismaService } from "../src/common/prisma/prisma.service.js";
import { RedisService } from "../src/common/redis/redis.service.js";
import { ENV } from "../src/config/config.module.js";
import { NoopCreditsFacade } from "../src/credits/noop-credits.facade.js";
import {
  ATTEMPT_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  internalSignatureHeaders,
  signInternalRequest,
} from "../src/internal/internal-signature.js";
import { PLAN_ENQUEUED_CAP_TENTHS } from "../src/jobs/jobs.config.js";
import { JobsService } from "../src/jobs/jobs.service.js";
import { bullJobId } from "../src/jobs/queue.registry.js";
import { QueueTimeoutTask } from "../src/jobs/tasks/queue-timeout.task.js";
import {
  BEARER_SUBPROTOCOL_PREFIX,
  REALTIME_PATH,
  REALTIME_SUBPROTOCOL,
  projectRoom,
} from "../src/realtime/realtime.protocol.js";

import type { TestDatabase } from "./db-harness.js";
import type { INestApplication } from "@nestjs/common";

const CALLBACK_SECRET = "test-callback-secret-at-least-32-characters-long";
const PREFIX = process.env["MONTAJ_QUEUE_PREFIX"] ?? "bull";

const DB_READY = isDatabaseAvailable();
const REDIS_READY = isRedisAvailable();
const CAN_RUN = DB_READY && REDIS_READY;

if (!CAN_RUN) {
  console.warn(
    `[jobs.e2e] skipped — ${DB_READY ? "" : `database: ${skipReason}. `}${
      REDIS_READY ? "" : `redis: ${redisSkipReason}.`
    }`,
  );
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM_PUBLIC = publicKey.export({ type: "spki", format: "pem" }).toString();

/**
 * Fixture ids, distinct per run so re-runs against a developer's database never
 * collide — and valid **ULIDs**, because the realtime gateway validates a room's
 * id before it will join it. Crockford base32 excludes I, L, O and U, which is
 * why the tags below are spelled the way they are.
 */
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
const id = (kind: string): string => `01JC${kind}${RUN}`.padEnd(26, "0").slice(0, 26);

const USER = id("US3R");
const WORKSPACE = id("WKSP");
const OTHER_WORKSPACE = id("WKSX");
const PROJECT = id("PR0J");
const MEDIA = id("MEDA");

let db: TestDatabase | null = null;
let prisma: PrismaClient;
let app: INestApplication;
let jobs: JobsService;
let credits: NoopCreditsFacade;
let redis: IORedis;
let port: number;

function accessToken(workspaceId = WORKSPACE): string {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: USER,
    ws: workspaceId,
    role: "owner",
    kind: "web",
    jti: id("JT1"),
    iat: now,
    exp: now + 900,
    // A06 moved `/jobs` onto A04's `JwtAuthGuard`, which pins the issuer to
    // `API_ORIGIN`; the interim guard it replaced did not check `iss`.
    iss: process.env["API_ORIGIN"] ?? "http://localhost:3001",
  };
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signed = `${b64(header)}.${b64(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signed);
  signer.end();
  return `${signed}.${signer.sign(privateKey).toString("base64url")}`;
}

/** POST a signed internal callback exactly as a worker would. */
function callback(path: string, body: unknown, attemptId: string, now = Date.now()) {
  const raw = JSON.stringify(body);
  return request(app.getHttpServer())
    .post(path)
    .set(internalSignatureHeaders({ secret: CALLBACK_SECRET, attemptId, body: raw, now }))
    .send(raw);
}

async function seed(): Promise<void> {
  await prisma.user.create({
    data: { id: USER, email: `a08+${RUN}@example.test`, name: "A08 test" },
  });
  for (const [workspaceId, slug, membershipId] of [
    [WORKSPACE, `a08-${RUN}`, id("MBR1")],
    [OTHER_WORKSPACE, `a08-other-${RUN}`, id("MBR2")],
  ] as const) {
    await prisma.workspace.create({
      data: { id: workspaceId, slug, name: slug, ownerId: USER, billingCountry: "IN" },
    });
    await prisma.membership.create({
      data: { id: membershipId, workspaceId, userId: USER, role: "owner", status: "active" },
    });
  }
  await prisma.project.create({
    data: { id: PROJECT, workspaceId: WORKSPACE, title: "A08 fixture" },
  });
  await prisma.mediaAsset.create({
    data: { id: MEDIA, projectId: PROJECT, storageKey: `ws/${WORKSPACE}/raw.mp4` },
  });

  // A creator plan, so admission control has real headroom to test against.
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
}

async function cleanup(): Promise<void> {
  if (prisma === undefined) return;
  await prisma.job.deleteMany({ where: { workspaceId: { in: [WORKSPACE, OTHER_WORKSPACE] } } });
  await prisma.subscription.deleteMany({ where: { workspaceId: WORKSPACE } });
  await prisma.mediaAsset.deleteMany({ where: { projectId: PROJECT } });
  await prisma.project.deleteMany({ where: { workspaceId: WORKSPACE } });
  await prisma.membership.deleteMany({ where: { userId: USER } });
  await prisma.workspace.deleteMany({ where: { id: { in: [WORKSPACE, OTHER_WORKSPACE] } } });
  await prisma.user.deleteMany({ where: { id: USER } });

  // The prefix is unique to this process (test/setup-env.ts), so this only ever
  // deletes keys this run created.
  if (redis === undefined) return;
  const keys = await redis.keys(`${PREFIX}:*`);
  if (keys.length > 0) await redis.del(...keys);
}

let enqueued = 0;
/**
 * A fresh enqueue with a unique jobKey, unless one is given.
 *
 * The queue is `ai.clean` rather than `ai.transcribe` because this suite is about
 * the **job system** — the envelope, the state machine, the settlement, the
 * frames — and posts a deliberately generic `result`. Since A11, `ai.transcribe`
 * has an owner (`TranscribeCompletionHandler`) that validates its completion into
 * `transcript_chunks` and rightly refuses a payload that is not a transcript, so
 * borrowing that queue name as a stand-in would test A11's schema instead of
 * A08's state machine. `ai.clean` is the same CONTRACTS §3 family with nobody
 * registered against it.
 */
async function enqueue(overrides: Partial<Parameters<JobsService["enqueue"]>[0]> = {}) {
  enqueued += 1;
  return jobs.enqueue({
    type: "ai.clean",
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    params: { mediaId: MEDIA },
    jobKey: `a08-${RUN}-${String(enqueued)}`,
    worstCaseTenths: 100,
    ...overrides,
  });
}

beforeAll(async () => {
  if (!CAN_RUN) return;

  db = await createTestDatabase();
  if (db === null) throw new Error(`could not start a test database: ${skipReason}`);
  prisma = db.prisma;
  await prisma.$connect();
  await seed();

  redis = new IORedis(testRedisUrl(), { maxRetriesPerRequest: null });

  // Imported lazily so a skipped run never loads the Nest graph.
  const { Test } = await import("@nestjs/testing");
  const { AppModule } = await import("../src/app.module.js");
  const { HttpExceptionFilter } = await import("../src/common/errors/http-exception.filter.js");
  const { setupOpenApi } = await import("../src/openapi.js");
  const { resolveEnv } = await import("../src/config/config.module.js");

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
    // The suite mints its own RS256 tokens; everything else is the real env.
    .useValue({
      ...resolveEnv(),
      JWT_PUBLIC_KEY: PEM_PUBLIC,
      INTERNAL_CALLBACK_SECRET: CALLBACK_SECRET,
    } as Env)
    .compile();

  app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  app.useGlobalFilters(new HttpExceptionFilter());
  setupOpenApi(app);
  await app.listen(0, "127.0.0.1");
  port = Number(new URL(await app.getUrl()).port);

  jobs = app.get(JobsService);
  credits = app.get(NoopCreditsFacade);
}, 180_000);

/**
 * Every test leaves its job `queued`, and a queued job occupies the workspace's
 * concurrency lane (8 on the creator plan). Retiring them between tests is what
 * keeps the lane cap from failing the test *after* the one that filled it.
 */
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
  await cleanup();
  redis?.disconnect();
  await db?.stop();
}, 60_000);

/** A connected, authenticated WebSocket subscribed to the project room. */
async function watcher(): Promise<{
  next: (timeoutMs?: number) => Promise<Record<string, unknown>>;
  close: () => void;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${REALTIME_PATH}`, [
    REALTIME_SUBPROTOCOL,
    `${BEARER_SUBPROTOCOL_PREFIX}${accessToken()}`,
  ]);
  const queue: Record<string, unknown>[] = [];
  const waiters: ((frame: Record<string, unknown>) => void)[] = [];
  socket.on("message", (raw: Buffer) => {
    const frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter === undefined) queue.push(frame);
    else waiter(frame);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  const next = async (timeoutMs = 5_000): Promise<Record<string, unknown>> => {
    const queued = queue.shift();
    if (queued !== undefined) return queued;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
      waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  };

  await next(); // welcome
  socket.send(JSON.stringify({ t: "subscribe", rooms: [projectRoom(PROJECT)] }));
  const subscribed = await next();
  // Assert the join: a refused room would otherwise show up much later as a
  // mysterious "timed out waiting for a frame".
  expect(subscribed).toMatchObject({ t: "subscribed", rooms: [projectRoom(PROJECT)] });
  return { next, close: () => socket.close() };
}

describe.skipIf(!CAN_RUN)("jobs (e2e)", () => {
  it("puts a BullMQ job on the queue carrying the CONTRACTS §3 envelope", async () => {
    const { job } = await enqueue();

    const queue = new Queue("ai.clean", { connection: redis, prefix: PREFIX });
    try {
      const entry = await queue.getJob(bullJobId(job.id, job.attemptId ?? ""));
      expect(entry).toBeDefined();
      expect(entry?.name).toBe("ai.clean");
      expect(entry?.data).toEqual({
        jobId: job.id,
        attemptId: job.attemptId,
        workspaceId: WORKSPACE,
        projectId: PROJECT,
        priority: job.priority,
        jobKey: job.jobKey,
        createdAt: job.queuedAt.toISOString(),
        payload: { mediaId: MEDIA },
      });
      expect(entry?.opts.priority).toBe(job.priority);
    } finally {
      await queue.close();
    }

    const events = await prisma.jobEvent.findMany({ where: { jobId: job.id } });
    expect(events.map((event) => (event.data as { event: string }).event)).toEqual(["job.queued"]);
  });

  it("returns the same job for a repeated jobKey", async () => {
    const jobKey = `a08-${RUN}-dedupe`;
    const first = await enqueue({ jobKey });
    const second = await enqueue({ jobKey });
    expect(second.deduplicated).toBe(true);
    expect(second.job.id).toBe(first.job.id);
  });

  it("runs the full worker round trip and pushes it to a WebSocket client", async () => {
    const { job } = await enqueue();
    const attemptId = job.attemptId ?? "";
    const client = await watcher();

    try {
      const progress = await callback(
        `/internal/jobs/${job.id}/progress`,
        { progress: 40, etaMs: 12_000, message: "chunk 2/5" },
        attemptId,
      );
      expect(progress.status).toBe(200);
      expect(progress.body).toMatchObject({ applied: true, status: "running" });

      await expect(client.next()).resolves.toMatchObject({
        t: "event",
        room: projectRoom(PROJECT),
        event: "job.progress",
        data: { jobId: job.id, progress: 40, etaMs: 12_000 },
      });

      const settle = vi.spyOn(credits, "settle");
      const completion = await callback(
        `/internal/jobs/${job.id}/complete`,
        {
          status: "succeeded",
          result: { transcriptId: id("TRNS") },
          usage: { actualTenths: 60, provider: "sarvam", model: "saarika-v2", mediaSeconds: 360 },
        },
        attemptId,
      );
      expect(completion.status).toBe(200);
      expect(completion.body).toMatchObject({ applied: true, status: "succeeded" });

      await expect(client.next()).resolves.toMatchObject({
        event: "job.completed",
        data: { jobId: job.id, status: "succeeded" },
      });

      const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      expect(stored.status).toBe("succeeded");
      expect(stored.progress).toBe(100);
      expect(stored.creditsChargedTenths).toBe(60);
      expect(stored.provider).toBe("sarvam");
      expect(stored.finishedAt).toBeInstanceOf(Date);

      const events = await prisma.jobEvent.findMany({
        where: { jobId: job.id },
        orderBy: { id: "asc" },
      });
      expect(events.map((event) => (event.data as { event: string }).event)).toEqual([
        "job.queued",
        "job.started",
        "job.progress",
        "job.succeeded",
      ]);
      // Every row states its own 30-day expiry (D47).
      for (const event of events) {
        expect((event.data as { retentionDays: number }).retentionDays).toBe(30);
      }

      // A replay: 200, no change, and no second settlement (THREAT-MODEL T8/T9).
      settle.mockClear();
      const replay = await callback(
        `/internal/jobs/${job.id}/complete`,
        { status: "succeeded", usage: { actualTenths: 999 } },
        attemptId,
      );
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ applied: false, reason: "already_completed" });
      expect(settle).not.toHaveBeenCalled();
      expect(
        (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).creditsChargedTenths,
      ).toBe(60);
      settle.mockRestore();
    } finally {
      client.close();
    }
  });

  it("releases the hold and records the failure when a worker reports one", async () => {
    const { job } = await enqueue();
    const release = vi.spyOn(credits, "release");

    const response = await callback(
      `/internal/jobs/${job.id}/complete`,
      {
        status: "failed",
        finalAttempt: true,
        error: { code: "provider/timeout", message: "upstream timed out", retryable: true },
      },
      job.attemptId ?? "",
    );

    expect(response.status).toBe(200);
    expect(release).toHaveBeenCalledWith({ holdId: job.creditHoldId });
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("failed");
    expect(stored.creditsChargedTenths).toBe(0);

    const names = (
      await prisma.jobEvent.findMany({ where: { jobId: job.id }, orderBy: { id: "asc" } })
    ).map((event) => (event.data as { event: string }).event);
    expect(names).toContain("job.failed");
    expect(names).toContain("job.dead_lettered");
    release.mockRestore();
  });

  it("lets a worker enqueue a follow-up, inheriting the parent's tenancy", async () => {
    const { job } = await enqueue();

    const response = await callback(
      `/internal/jobs/${job.id}/enqueue-child`,
      { type: "media.proxy", payload: { mediaId: MEDIA }, worstCaseTenths: 0 },
      job.attemptId ?? "",
    );

    expect(response.status).toBe(200);
    const childId = (response.body as { childJobId: string }).childJobId;
    const child = await prisma.job.findUniqueOrThrow({ where: { id: childId } });
    expect(child.workspaceId).toBe(WORKSPACE);
    expect(child.projectId).toBe(PROJECT);
    expect(child.type).toBe("media.proxy");
  });

  it("accepts a signed media write-back on the allow-listed fields only", async () => {
    const response = await request(app.getHttpServer())
      .patch(`/internal/media/${MEDIA}`)
      .set(
        internalSignatureHeaders({
          secret: CALLBACK_SECRET,
          attemptId: id("ATMP"),
          body: JSON.stringify({ status: "ready", durationMs: 61_000, width: 1_080 }),
        }),
      )
      .send(JSON.stringify({ status: "ready", durationMs: 61_000, width: 1_080 }));

    expect(response.status).toBe(200);
    const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: MEDIA } });
    expect(asset.status).toBe("ready");
    expect(asset.durationMs).toBe(61_000);

    const rejected = await request(app.getHttpServer())
      .patch(`/internal/media/${MEDIA}`)
      .set(
        internalSignatureHeaders({
          secret: CALLBACK_SECRET,
          attemptId: id("ATMP"),
          body: JSON.stringify({ projectId: id("BAD0") }),
        }),
      )
      .send(JSON.stringify({ projectId: id("BAD0") }));
    expect(rejected.status).toBe(400);
    expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: MEDIA } })).projectId).toBe(
      PROJECT,
    );
  });
});

describe.skipIf(!CAN_RUN)("internal callback signatures (THREAT-MODEL T8)", () => {
  let job: Job;

  beforeEach(async () => {
    job = (await enqueue()).job;
  });

  it("rejects a request with no signature at all", async () => {
    const response = await request(app.getHttpServer())
      .post(`/internal/jobs/${job.id}/complete`)
      .send({ status: "succeeded" });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("jobs/signature_invalid");
  });

  it("rejects a wrong signature", async () => {
    const body = JSON.stringify({ status: "succeeded" });
    const response = await request(app.getHttpServer())
      .post(`/internal/jobs/${job.id}/complete`)
      .set({
        "content-type": "application/json",
        [ATTEMPT_HEADER]: job.attemptId ?? "",
        [TIMESTAMP_HEADER]: String(Math.floor(Date.now() / 1000)),
        [SIGNATURE_HEADER]: "0".repeat(64),
      })
      .send(body);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("jobs/signature_invalid");
  });

  it("rejects a signature over a different body", async () => {
    const signed = JSON.stringify({ status: "succeeded" });
    const sent = JSON.stringify({ status: "failed" });
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await request(app.getHttpServer())
      .post(`/internal/jobs/${job.id}/complete`)
      .set({
        "content-type": "application/json",
        [ATTEMPT_HEADER]: job.attemptId ?? "",
        [TIMESTAMP_HEADER]: String(timestamp),
        [SIGNATURE_HEADER]: signInternalRequest({
          secret: CALLBACK_SECRET,
          timestamp,
          body: signed,
        }),
      })
      .send(sent);
    expect(response.status).toBe(401);
  });

  it("rejects a timestamp outside the five-minute window", async () => {
    const response = await callback(
      `/internal/jobs/${job.id}/complete`,
      { status: "succeeded" },
      job.attemptId ?? "",
      Date.now() - 6 * 60_000,
    );
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("jobs/timestamp_skew");
  });

  it("ignores a callback from a superseded attempt", async () => {
    const response = await callback(
      `/internal/jobs/${job.id}/complete`,
      { status: "succeeded" },
      id("OLDA"),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ applied: false, reason: "stale_attempt" });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("queued");
  });

  it("keeps the internal routes out of the public OpenAPI document", async () => {
    const response = await request(app.getHttpServer()).get("/docs-json");
    const paths = Object.keys((response.body as { paths: Record<string, unknown> }).paths);
    expect(paths.filter((path) => path.startsWith("/internal"))).toEqual([]);
    expect(paths).toContain("/jobs");
    expect(paths).toContain("/jobs/{id}");
    expect(paths).toContain("/jobs/{id}/events");
    expect(paths).toContain("/jobs/{id}/cancel");
  });
});

describe.skipIf(!CAN_RUN)("the public jobs API", () => {
  it("refuses an unauthenticated caller", async () => {
    const response = await request(app.getHttpServer()).get("/jobs");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("common/unauthorized");
  });

  it("lists, reads and pages the caller's own jobs", async () => {
    const { job } = await enqueue();
    const bearer = `Bearer ${accessToken()}`;

    const list = await request(app.getHttpServer())
      .get("/jobs?limit=1")
      .set("authorization", bearer);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.nextCursor).toBeTypeOf("string");

    const one = await request(app.getHttpServer())
      .get(`/jobs/${job.id}`)
      .set("authorization", bearer);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: job.id, type: "ai.clean", status: "queued" });
    expect(one.body).not.toHaveProperty("creditHoldId");

    const events = await request(app.getHttpServer())
      .get(`/jobs/${job.id}/events`)
      .set("authorization", bearer);
    expect(events.status).toBe(200);
    expect(events.body.items[0]).toMatchObject({ level: "info" });
  });

  it("hides another workspace's job behind a 404 (THREAT-MODEL T5)", async () => {
    const { job } = await enqueue();
    const response = await request(app.getHttpServer())
      .get(`/jobs/${job.id}`)
      .set("authorization", `Bearer ${accessToken(OTHER_WORKSPACE)}`);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("jobs/not_found");
  });

  it("cancels a queued job, releases the hold and drops the queue entry", async () => {
    const { job } = await enqueue();
    const release = vi.spyOn(credits, "release");

    const response = await request(app.getHttpServer())
      .post(`/jobs/${job.id}/cancel`)
      .set("authorization", `Bearer ${accessToken()}`);

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("cancelled");
    expect(release).toHaveBeenCalledWith({ holdId: job.creditHoldId });

    const queue = new Queue("ai.clean", { connection: redis, prefix: PREFIX });
    try {
      expect(await queue.getJob(bullJobId(job.id, job.attemptId ?? ""))).toBeUndefined();
    } finally {
      await queue.close();
    }
    release.mockRestore();
  });
});

describe.skipIf(!CAN_RUN)("admission control (THREAT-MODEL T23)", () => {
  it("refuses an enqueue that would cross the plan's enqueued-credit cap", async () => {
    const filler = await enqueue({ worstCaseTenths: PLAN_ENQUEUED_CAP_TENTHS.creator - 10 });
    try {
      const failure = await enqueue({ worstCaseTenths: 100 }).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "jobs/enqueue_cap",
        httpStatus: 429,
        details: { plan: "creator", enqueuedCapTenths: PLAN_ENQUEUED_CAP_TENTHS.creator },
      });
    } finally {
      await jobs.cancel(filler.job.id, WORKSPACE);
    }
  });

  it("fails a job that waited longer than its plan allows, and gives the credits back", async () => {
    const { job } = await enqueue();
    const release = vi.spyOn(credits, "release");

    // Age the row past its own maxQueueWaitMs.
    await prisma.job.update({
      where: { id: job.id },
      data: { queuedAt: new Date(Date.now() - (job.maxQueueWaitMs ?? 0) - 60_000) },
    });

    const swept = await app.get(QueueTimeoutTask).sweep();

    expect(swept).toBeGreaterThanOrEqual(1);
    const stored = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("failed");
    expect(stored.creditsChargedTenths).toBe(0);
    expect((stored.error as { code: string }).code).toBe("jobs/queue_timeout");
    expect(release).toHaveBeenCalledWith({ holdId: job.creditHoldId });
    release.mockRestore();
  });
});
