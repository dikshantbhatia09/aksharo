/**
 * B14b's webhook path against real infrastructure: `transcript.completed` and
 * `job.failed` are now real `EventEmitter2` emits at their producers (no more
 * `WebhookEventPollerService` cursor) and this suite proves the whole chain —
 * API key → `/v1` project → a simulated worker completion → a signed
 * delivery a receiver can verify, plus the retry schedule on a receiver that
 * fails twice.
 *
 * **Deviation, documented here rather than silently:** the brief describes
 * creating the `/v1` project "from a local fixture URL". `sourceUrl` ingest
 * (`SourceUrlIngestService`) is SSRF-guarded (`resolveSafeTarget`, A06) and
 * refuses loopback/private addresses by construction — the one address an
 * in-process fixture server can bind to in CI. Going through it for real
 * would mean relaxing that guard, which is outside every file this WP may
 * touch. This suite instead creates the project via the real `POST
 * /v1/projects` (title only, exercising the API-key path the brief asks
 * for) and attaches the fixture media the same way `transcripts.e2e-spec.ts`
 * and `jobs.e2e-spec.ts` already do — directly through Prisma, the same
 * seam A11's own suite uses for the identical reason.
 *
 * The same SSRF guard governs *delivery* (`common/ssrf/webhook-fetch.ts`,
 * outside this WP's boundary): a real delivery to `127.0.0.1` is refused by
 * design. `WebhookDeliveryService.sendOverride` (added this WP, inside its
 * boundary) is the test seam that lets this suite's in-process receiver
 * stand in for a real internet endpoint without touching the guard itself —
 * see the doc comment on that field.
 *
 * Needs Postgres and Redis; skips loudly without either, exactly like
 * `jobs.e2e-spec.ts`/`transcripts.e2e-spec.ts`.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { resolve } from "node:path";

import { type PrismaClient } from "@prisma/client";
import IORedis from "ioredis";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { TranscriptChunk } from "@montaj/edg/schemas";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { PrismaService } from "../src/common/prisma/prisma.service.js";
import { RedisService } from "../src/common/redis/redis.service.js";
import { resetEnvCache } from "../src/config/config.module.js";
import { CREDITS_FACADE } from "../src/credits/credits.facade.js";
import { NoopCreditsFacade } from "../src/credits/noop-credits.facade.js";
import { internalSignatureHeaders } from "../src/internal/internal-signature.js";
import { JobsService } from "../src/jobs/jobs.service.js";
import { ApiKeysService } from "../src/public-api/keys/api-keys.service.js";
import { WebhookDeliveryService } from "../src/webhooks/webhook-delivery.service.js";
import { verifyWebhookSignature } from "../src/webhooks/webhook-signature.js";

import type { TestDatabase } from "./db-harness.js";
import type { SendWebhookInput, SendWebhookResult } from "../src/common/ssrf/webhook-fetch.js";
import type { INestApplication } from "@nestjs/common";

const CALLBACK_SECRET = "test-callback-secret-at-least-32-characters-long";

const DB_READY = isDatabaseAvailable();
const REDIS_READY = isRedisAvailable();
const CAN_RUN = DB_READY && REDIS_READY;

if (!CAN_RUN) {
  console.warn(
    `[webhooks.e2e] skipped — ${DB_READY ? "" : `database: ${skipReason}. `}${
      REDIS_READY ? "" : `redis: ${redisSkipReason}.`
    }`,
  );
}

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
const MEDIA = id("MEDA");
const DURATION_MS = 6_000;

let db: TestDatabase | null = null;
let prisma: PrismaClient;
let app: INestApplication;
let redis: IORedis;
let jobs: JobsService;
let delivery: WebhookDeliveryService;
let apiKey: string;

/** The first ten words of A11's fixture, as a single chunk — this suite is about webhooks, not postprocessing. */
const SAMPLE_TRANSCRIPT = resolve(
  __dirname,
  "../../../packages/edg/fixtures/sample-transcript.json",
);
function oneChunk(): Record<string, unknown> {
  const fixture = JSON.parse(readFileSync(SAMPLE_TRANSCRIPT, "utf8")) as {
    chunks: TranscriptChunk[];
  };
  const words = (fixture.chunks[0]?.words ?? []).slice(0, 10);
  return {
    chunkIdx: 0,
    startMs: 0,
    endMs: DURATION_MS,
    nextWordSeq: words.length,
    words,
  };
}

/** A worker's `POST /internal/jobs/{id}/complete` body (A09's shape). */
function completionBody(transcriptId: string, overrides: Record<string, unknown> = {}) {
  return {
    status: "succeeded",
    result: {
      transcriptId,
      mediaId: MEDIA,
      language: "hi",
      provider: "sarvam",
      model: "saarika-v2",
      durationMs: DURATION_MS,
      chunks: [oneChunk()],
      providerSubmissions: [],
    },
    usage: { mediaSeconds: DURATION_MS / 1_000, provider: "sarvam", model: "saarika-v2" },
    ...overrides,
  };
}

function callback(path: string, body: unknown, attemptId: string) {
  const raw = JSON.stringify(body);
  return request(app.getHttpServer())
    .post(path)
    .set(
      internalSignatureHeaders({ secret: CALLBACK_SECRET, attemptId, body: raw, now: Date.now() }),
    )
    .set("Content-Type", "application/json")
    .send(raw);
}

/**
 * A real (loopback) HTTP receiver, exactly as a customer's webhook endpoint
 * would look from this suite's side — it only differs from the internet in
 * being reachable at `127.0.0.1`, which is why `sendOverride` (not
 * `sendWebhook`) is what reaches it; see the file's top doc comment.
 */
interface Receiver {
  readonly url: string;
  readonly requests: { readonly body: string; readonly headers: Record<string, string> }[];
  /** Status codes served in order for successive requests; the last one repeats. */
  statuses: number[];
  close(): Promise<void>;
}

async function receiver(statuses: number[] = [200]): Promise<Receiver> {
  const requests: Receiver["requests"] = [];
  const state = { statuses };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[key.toLowerCase()] = value;
      }
      requests.push({ body, headers });
      const status =
        state.statuses[Math.min(requests.length - 1, state.statuses.length - 1)] ?? 200;
      res.writeHead(status, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}/hook`,
    requests,
    statuses,
    close: () => new Promise((res) => server.close(() => res())),
  };
}

/** Bypasses `resolveSafeTarget` (loopback would otherwise be refused) — see the file's top comment. */
function directSender(): (input: SendWebhookInput) => Promise<SendWebhookResult> {
  return (input) =>
    new Promise<SendWebhookResult>((res, reject) => {
      const url = new URL(input.url);
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: { ...input.headers, "content-length": Buffer.byteLength(input.body) },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            res({
              status: response.statusCode ?? 0,
              bodySnippet: Buffer.concat(chunks).toString("utf8").slice(0, 4_096),
            }),
          );
        },
      );
      req.on("error", reject);
      req.setTimeout(input.timeoutMs ?? 10_000, () => req.destroy(new Error("timeout")));
      req.end(input.body);
    });
}

async function endpoint(events: string[], url: string): Promise<{ id: string; secret: string }> {
  const endpointId = id(`EP${String(Math.floor(Math.random() * 1_000))}`);
  const secret = randomBytes(32).toString("hex");
  await prisma.webhookEndpoint.create({
    data: { id: endpointId, workspaceId: WORKSPACE, url, secret, events, active: true },
  });
  return { id: endpointId, secret };
}

/**
 * The producer's `EventEmitter2.emit()` (`referrals/export-completed.event.ts`'s
 * precedent, kept here rather than switched to `emitAsync`) does not await its
 * listeners — `WebhookDeliveryService.emit()`'s `webhook_deliveries` insert
 * therefore lands on its own microtask, not necessarily before the HTTP
 * callback that triggered it has already answered 200. A production sweep
 * tick 15s later never notices; this suite calling `dispatchDue()`
 * immediately would, so it polls for the row first.
 */
async function waitForPendingDelivery(
  event: string,
  endpointId: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = await prisma.webhookDelivery.count({ where: { event, endpointId } });
    if (count > 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `no pending webhook_deliveries row for "${event}" within ${String(timeoutMs)}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function seed(): Promise<void> {
  await prisma.user.create({
    data: { id: USER, email: `b14b+${RUN}@example.test`, name: "B14b test" },
  });
  await prisma.workspace.create({
    data: {
      id: WORKSPACE,
      slug: `b14b-${RUN}`,
      name: `b14b-${RUN}`,
      ownerId: USER,
      billingCountry: "IN",
    },
  });
  await prisma.membership.create({
    data: { id: id("MBR1"), workspaceId: WORKSPACE, userId: USER, role: "owner", status: "active" },
  });

  // Studio: the one plan tier `entitlements.apiAccess` is true for
  // (`prisma/seed-data.ts`), which `ApiKeysService.create` requires.
  const plan = await prisma.plan.upsert({
    where: { key: "studio" },
    update: {},
    create: {
      id: id("PLAN"),
      key: "studio",
      name: "Studio",
      creditsPerMonthTenths: 30_000,
      entitlements: { apiAccess: true },
    },
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
  await prisma.webhookDelivery.deleteMany({ where: { endpoint: { workspaceId: WORKSPACE } } });
  await prisma.webhookEndpoint.deleteMany({ where: { workspaceId: WORKSPACE } });
  // transcripts/chunks cascade from the project delete below (schema.prisma onDelete: Cascade).
  await prisma.job.deleteMany({ where: { workspaceId: WORKSPACE } });
  await prisma.apiKey.deleteMany({ where: { workspaceId: WORKSPACE } });
  await prisma.subscription.deleteMany({ where: { workspaceId: WORKSPACE } });
  await prisma.project.deleteMany({ where: { workspaceId: WORKSPACE } });
  await prisma.membership.deleteMany({ where: { userId: USER } });
  await prisma.workspace.deleteMany({ where: { id: WORKSPACE } });
  await prisma.user.deleteMany({ where: { id: USER } });

  if (redis === undefined) return;
  const prefix = process.env["MONTAJ_QUEUE_PREFIX"] ?? "bull";
  const keys = await redis.keys(`${prefix}:*`);
  if (keys.length > 0) await redis.del(...keys);
}

beforeAll(async () => {
  if (!CAN_RUN) return;

  db = await createTestDatabase();
  if (db === null) throw new Error(`could not start a test database: ${skipReason}`);
  prisma = db.prisma;
  await prisma.$connect();
  await seed();

  redis = new IORedis(testRedisUrl(), { maxRetriesPerRequest: null });

  process.env["DATABASE_URL"] = db.url;
  process.env["REDIS_URL"] = testRedisUrl();
  process.env["INTERNAL_CALLBACK_SECRET"] = CALLBACK_SECRET;
  resetEnvCache();

  const { Test } = await import("@nestjs/testing");
  const { AppModule } = await import("../src/app.module.js");
  const { HttpExceptionFilter } = await import("../src/common/errors/http-exception.filter.js");
  const { setupOpenApi } = await import("../src/openapi.js");
  const { applyInternalBodyLimit } = await import("../src/internal/internal-body-limit.js");

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(
      Object.assign(prisma, {
        ping: async () => undefined,
        withTransaction: async (
          fn: (tx: unknown) => Promise<unknown>,
          options: { timeoutMs?: number; maxWaitMs?: number } = {},
        ) =>
          prisma.$transaction(async (tx) => fn(tx), {
            timeout: options.timeoutMs ?? 10_000,
            maxWait: options.maxWaitMs ?? 5_000,
          }),
      }),
    )
    .overrideProvider(RedisService)
    .useValue({
      client: redis,
      ping: async () => undefined,
      onModuleDestroy: async () => undefined,
    })
    // This suite is about webhook events firing off the job/transcript state
    // machines, not ledger balances (`jobs.e2e-spec.ts`'s own reasoning).
    .overrideProvider(CREDITS_FACADE)
    .useFactory({ factory: (noop: NoopCreditsFacade) => noop, inject: [NoopCreditsFacade] })
    .compile();

  app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  app.useGlobalFilters(new HttpExceptionFilter());
  applyInternalBodyLimit(app);
  setupOpenApi(app);
  await app.init();

  jobs = app.get(JobsService);
  delivery = app.get(WebhookDeliveryService);

  const minted = await app.get(ApiKeysService).create({
    workspaceId: WORKSPACE,
    userId: USER,
    name: "b14b e2e",
    scopes: ["projects_write", "projects_read"],
  });
  apiKey = minted.key;
}, 180_000);

afterEach(() => {
  delivery.sendOverride = undefined;
});

afterAll(async () => {
  if (!CAN_RUN) return;
  await app?.close();
  await cleanup();
  redis?.disconnect();
  await db?.stop();
}, 60_000);

describe.skipIf(!CAN_RUN)("webhooks (e2e)", () => {
  let projectId: string;

  it("creates a project via /v1 with an API key", async () => {
    const response = await request(app.getHttpServer())
      .post("/v1/projects")
      .set("X-Api-Key", apiKey)
      .send({ title: `B14b ${RUN}` })
      .expect(201);

    projectId = response.body.id as string;
    expect(projectId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // Fixture media, attached directly (the file's top comment explains why:
    // the SSRF-guarded sourceUrl path is A06/B14's own, out of this WP's
    // boundary, and not what this suite is proving).
    await prisma.mediaAsset.create({
      data: {
        id: MEDIA,
        projectId,
        role: "primary",
        storageKey: `ws/${WORKSPACE}/p/${projectId}/media/${MEDIA}/raw.mp4`,
        durationMs: DURATION_MS,
        status: "ready",
      },
    });
  });

  it("delivers transcript.completed with a valid X-Aksharo-Signature once the fake worker completes it", async () => {
    const receive = await receiver();
    const { id: endpointId, secret } = await endpoint(["transcript.completed"], receive.url);
    delivery.sendOverride = directSender();

    const transcriptId = id("TR4NSCR1PT");
    const { job } = await jobs.enqueue({
      type: "ai.transcribe",
      workspaceId: WORKSPACE,
      projectId,
      params: { transcriptId, mediaId: MEDIA, hints: [] },
      jobKey: `b14b-transcribe-${RUN}`,
      worstCaseTenths: 100,
    });

    await callback(
      `/internal/jobs/${job.id}/complete`,
      completionBody(transcriptId),
      job.attemptId ?? "",
    ).expect(200);

    await waitForPendingDelivery("transcript.completed", endpointId);
    const dispatched = await delivery.dispatchDue();
    expect(dispatched.dispatched).toBeGreaterThanOrEqual(1);

    expect(receive.requests).toHaveLength(1);
    const [received] = receive.requests;
    expect(received).toBeDefined();
    const signature = received?.headers["x-aksharo-signature"];
    expect(signature).toBeDefined();
    expect(verifyWebhookSignature(secret, received?.body ?? "", signature ?? "", Infinity)).toBe(
      true,
    );

    const payload = JSON.parse(received?.body ?? "{}") as {
      event: string;
      data: Record<string, unknown>;
    };
    expect(payload.event).toBe("transcript.completed");
    expect(payload.data).toMatchObject({ transcriptId, projectId });

    await receive.close();
  });

  it("delivers job.failed once a job is forced to fail (DLQ handling included)", async () => {
    const receive = await receiver();
    const { id: endpointId1 } = await endpoint(["job.failed"], receive.url);
    delivery.sendOverride = directSender();

    const { job } = await jobs.enqueue({
      type: "ai.transcribe",
      workspaceId: WORKSPACE,
      projectId,
      params: { transcriptId: id("TR4NSFA1L"), mediaId: MEDIA, hints: [] },
      jobKey: `b14b-fail-${RUN}`,
      worstCaseTenths: 100,
    });

    await callback(
      `/internal/jobs/${job.id}/complete`,
      {
        status: "failed",
        finalAttempt: true,
        error: { code: "provider/timeout", message: "gave up", retryable: false },
      },
      job.attemptId ?? "",
    ).expect(200);

    await waitForPendingDelivery("job.failed", endpointId1);
    await delivery.dispatchDue();

    expect(receive.requests).toHaveLength(1);
    const payload = JSON.parse(receive.requests[0]?.body ?? "{}") as {
      event: string;
      data: Record<string, unknown>;
    };
    expect(payload.event).toBe("job.failed");
    expect(payload.data).toMatchObject({ jobId: job.id, jobType: "ai.transcribe" });

    await receive.close();
  });

  it("retries on 500 twice, then delivers on the third attempt (1m, then 5m)", async () => {
    const receive = await receiver([500, 500, 200]);
    const { id: endpointId2 } = await endpoint(["job.failed"], receive.url);
    delivery.sendOverride = directSender();

    const { job } = await jobs.enqueue({
      type: "ai.transcribe",
      workspaceId: WORKSPACE,
      projectId,
      params: { transcriptId: id("TR4NSRETRY"), mediaId: MEDIA, hints: [] },
      jobKey: `b14b-retry-${RUN}`,
      worstCaseTenths: 100,
    });
    await callback(
      `/internal/jobs/${job.id}/complete`,
      {
        status: "failed",
        finalAttempt: true,
        error: { code: "provider/timeout", message: "gave up", retryable: false },
      },
      job.attemptId ?? "",
    ).expect(200);

    await waitForPendingDelivery("job.failed", endpointId2);
    const now = Date.now();
    await delivery.dispatchDue(new Date(now)); // attempt 1 → 500 → nextRetryAt = +1m
    expect(receive.requests).toHaveLength(1);

    await delivery.dispatchDue(new Date(now + 61_000)); // attempt 2 → 500 → nextRetryAt = +5m
    expect(receive.requests).toHaveLength(2);

    await delivery.dispatchDue(new Date(now + 61_000 + 301_000)); // attempt 3 → 200 → delivered
    expect(receive.requests).toHaveLength(3);

    await receive.close();
  });
});
