/**
 * D08's eval harness API surface end to end, against real PostgreSQL and Redis:
 * a signed worker report reaches `POST /internal/evals/runs` and is persisted
 * (idempotently on the signed attempt id), `GET /admin/evals/leaderboard`
 * groups it correctly, and freeze/unfreeze is superadmin-only and audited.
 */
import { generateKeyPairSync } from "node:crypto";

import { type PrismaClient } from "@prisma/client";
import IORedis from "ioredis";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";

import { createAdminContext } from "./auth-harness.js";
import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { PrismaService } from "../src/common/prisma/prisma.service.js";
import { RedisService } from "../src/common/redis/redis.service.js";
import { ENV } from "../src/config/config.module.js";
import { CREDITS_FACADE } from "../src/credits/credits.facade.js";
import { NoopCreditsFacade } from "../src/credits/noop-credits.facade.js";
import { internalSignatureHeaders } from "../src/internal/internal-signature.js";

import type { TestDatabase } from "./db-harness.js";
import type { INestApplication } from "@nestjs/common";

const CALLBACK_SECRET = "test-callback-secret-at-least-32-characters-long";
const ISSUER = "http://localhost:3001";

const DB_READY = isDatabaseAvailable();
const REDIS_READY = isRedisAvailable();
const CAN_RUN = DB_READY && REDIS_READY;

if (!CAN_RUN) {
  console.warn(
    `[evals.e2e] skipped — ${DB_READY ? "" : `database: ${skipReason}. `}${
      REDIS_READY ? "" : `redis: ${redisSkipReason}.`
    }`,
  );
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM_PUBLIC = publicKey.export({ type: "spki", format: "pem" }).toString();
const PEM_PRIVATE = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

let db: TestDatabase | null = null;
let prisma: PrismaClient;
let app: INestApplication;
let redis: IORedis;

/** POST a signed internal callback exactly as the worker's `nightly.py` would. */
function post(path: string, body: unknown, attemptId: string) {
  const raw = JSON.stringify(body);
  return request(app.getHttpServer())
    .post(path)
    .set(internalSignatureHeaders({ secret: CALLBACK_SECRET, attemptId, body: raw }))
    .send(raw);
}

function nightlyBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    trigger: "nightly",
    startedAt: "2026-09-03T02:30:00.000Z",
    finishedAt: "2026-09-03T02:35:00.000Z",
    routingFrozen: false,
    gitSha: "deadbeef",
    summary: { datasetsRun: ["hindi-synth"], datasetsSkipped: [] },
    results: [
      {
        dataset: "hindi-synth",
        kind: "transcript",
        language: "hi",
        metricName: "corpusWer",
        metricValue: 0.12,
        itemCount: 3,
      },
      {
        dataset: "hindi-synth",
        kind: "transcript",
        language: "hi",
        metricName: "corpusCer",
        metricValue: 0.04,
        itemCount: 3,
      },
    ],
    ...overrides,
  };
}

beforeAll(async () => {
  if (!CAN_RUN) return;

  db = await createTestDatabase();
  if (db === null) throw new Error(`could not start a test database: ${skipReason}`);
  prisma = db.prisma;
  await prisma.$connect();

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
    .overrideProvider(CREDITS_FACADE)
    .useClass(NoopCreditsFacade)
    .compile();

  app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalFilters(new HttpExceptionFilter());
  setupOpenApi(app);
  await app.init();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await redis?.quit();
  await db?.stop();
});

describe.skipIf(!CAN_RUN)("D08 eval harness (e2e)", () => {
  afterEach(async () => {
    await prisma.evalResult.deleteMany({});
    await prisma.evalRun.deleteMany({});
    await prisma.routingFreeze.deleteMany({});
    await prisma.auditLog.deleteMany({ where: { resource: "routing_freeze" } });
  });

  it("POST /internal/evals/runs persists a run and its results", async () => {
    const attemptId = "01JEVR0000000000000000001A";
    const response = await post("/internal/evals/runs", nightlyBody(), attemptId);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ runId: attemptId, applied: true });

    const run = await prisma.evalRun.findUnique({
      where: { id: attemptId },
      include: { results: true },
    });
    expect(run).not.toBeNull();
    expect(run?.trigger).toBe("nightly");
    expect(run?.results).toHaveLength(2);
  });

  it("is idempotent: a replayed attempt id is not applied twice", async () => {
    const attemptId = "01JEVR0000000000000000002A";
    const first = await post("/internal/evals/runs", nightlyBody(), attemptId);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ applied: true });

    const replay = await post("/internal/evals/runs", nightlyBody(), attemptId);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ runId: attemptId, applied: false });

    const count = await prisma.evalRun.count({ where: { id: attemptId } });
    expect(count).toBe(1);
  });

  it("rejects an unsigned request", async () => {
    const response = await request(app.getHttpServer())
      .post("/internal/evals/runs")
      .send(nightlyBody());
    expect(response.status).toBe(401);
  });

  it("GET /admin/evals/leaderboard groups by dataset/language/metric with trend", async () => {
    const admin = await createAdminContext({ app, roles: ["ops"] });

    await post("/internal/evals/runs", nightlyBody(), "01JEVR0000000000000000010A");
    await post(
      "/internal/evals/runs",
      nightlyBody({
        startedAt: "2026-09-04T02:30:00.000Z",
        finishedAt: "2026-09-04T02:35:00.000Z",
        results: [
          {
            dataset: "hindi-synth",
            kind: "transcript",
            language: "hi",
            metricName: "corpusWer",
            metricValue: 0.09,
            itemCount: 3,
          },
        ],
      }),
      "01JEVR0000000000000000011A",
    );

    const response = await request(app.getHttpServer())
      .get("/admin/evals/leaderboard")
      .set("Authorization", `Bearer ${admin.accessToken}`);

    expect(response.status).toBe(200);
    const rows = response.body as {
      dataset: string;
      metricName: string;
      metricValue: number;
      previousMetricValue?: number;
      trend?: number;
    }[];
    const wer = rows.find((row) => row.dataset === "hindi-synth" && row.metricName === "corpusWer");
    expect(wer?.metricValue).toBeCloseTo(0.09);
    expect(wer?.previousMetricValue).toBeCloseTo(0.12);
    expect(wer?.trend).toBeCloseTo(-0.03);
  });

  it("freeze is superadmin-only, mandatory-reason, and audited; unfreeze reverses it", async () => {
    const ops = await createAdminContext({ app, roles: ["ops"] });
    const superadmin = await createAdminContext({ app, roles: ["superadmin"] });

    const forbidden = await request(app.getHttpServer())
      .post("/admin/evals/freeze")
      .set("Authorization", `Bearer ${ops.accessToken}`)
      .send({ reason: "trying anyway" });
    expect(forbidden.status).toBe(403);

    const noReason = await request(app.getHttpServer())
      .post("/admin/evals/freeze")
      .set("Authorization", `Bearer ${superadmin.accessToken}`)
      .send({});
    expect(noReason.status).toBe(400);

    const freeze = await request(app.getHttpServer())
      .post("/admin/evals/freeze")
      .set("Authorization", `Bearer ${superadmin.accessToken}`)
      .send({ reason: "shadow candidate regressed WER on the nightly run" });
    expect(freeze.status).toBe(201);
    expect((freeze.body as { frozen: boolean }).frozen).toBe(true);

    const state = await request(app.getHttpServer())
      .get("/admin/evals/freeze")
      .set("Authorization", `Bearer ${superadmin.accessToken}`);
    expect((state.body as { frozen: boolean }).frozen).toBe(true);

    const audited = await prisma.auditLog.findFirst({
      where: { action: "admin.evals.routing_frozen" },
      orderBy: { at: "desc" },
    });
    expect(audited).not.toBeNull();

    const unfreeze = await request(app.getHttpServer())
      .post("/admin/evals/unfreeze")
      .set("Authorization", `Bearer ${superadmin.accessToken}`)
      .send({ reason: "false alarm, unfreezing" });
    expect(unfreeze.status).toBe(201);
    expect((unfreeze.body as { frozen: boolean }).frozen).toBe(false);
  });
});
