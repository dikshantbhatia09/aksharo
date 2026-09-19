/**
 * B09b: `TranscriptsService.enqueueTranscription` merges the workspace's
 * consented `memory_entries` glossary/spelling terms into `params.hints`
 * alongside request-time hints, request-time first, deduplicated — and does
 * nothing at all when the caller has not granted the `memory` consent.
 *
 * Needs Postgres and Redis, exactly as `transcripts.e2e-spec.ts` does; without
 * either it skips loudly rather than failing.
 */
import { generateKeyPairSync } from "node:crypto";

import { type MembershipRole, type PrismaClient } from "@prisma/client";
import IORedis from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AMPLE_TEST_CREDIT_TENTHS, fundWorkspaceCredits } from "./credits-fixture.js";
import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { TokenService } from "../src/auth/token.service.js";
import { PrismaService } from "../src/common/prisma/prisma.service.js";
import { RedisService } from "../src/common/redis/redis.service.js";
import { resetEnvCache } from "../src/config/config.module.js";
import {
  InMemoryRealtimeBroker,
  InMemoryRealtimeBus,
  REALTIME_BUS,
} from "../src/realtime/realtime.bus.js";

import type { TestDatabase } from "./db-harness.js";
import type { INestApplication } from "@nestjs/common";

const CALLBACK_SECRET = "test-callback-secret-at-least-32-characters-long";

const DB_READY = isDatabaseAvailable();
const REDIS_READY = isRedisAvailable();
const CAN_RUN = DB_READY && REDIS_READY;

if (!CAN_RUN) {
  console.warn(
    `[memory-transcribe-hints.e2e] skipped — ${DB_READY ? "" : `database: ${skipReason}. `}${
      REDIS_READY ? "" : `redis: ${redisSkipReason}.`
    }`,
  );
}

const JWT_KEYS = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

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

const USER = id("US3R");
const WORKSPACE = id("WKSP");
const PROJECT_ON = id("PRJ1");
const MEDIA_ON = id("MDA1");
const PROJECT_OFF = id("PRJ2");
const MEDIA_OFF = id("MDA2");
const PROJECT_NO_HINTS = id("PRJ3");
const MEDIA_NO_HINTS = id("MDA3");

const DURATION_MS = 90_000;

let db: TestDatabase | null = null;
let prisma: PrismaClient;
let app: INestApplication;
let redis: IORedis;
let tokens: TokenService;

function accessToken(role: MembershipRole = "owner"): string {
  return tokens.mintAccessToken({ userId: USER, workspaceId: WORKSPACE, role, kind: "web" })
    .accessToken;
}

async function seed(): Promise<void> {
  await prisma.user.create({
    data: { id: USER, email: `b09b+${RUN}@example.test`, name: "B09b test" },
  });
  await prisma.workspace.create({
    data: {
      id: WORKSPACE,
      slug: `b09b-${RUN}`,
      name: `b09b-${RUN}`,
      ownerId: USER,
      billingCountry: "IN",
    },
  });
  await prisma.membership.create({
    data: { id: id("MBR1"), workspaceId: WORKSPACE, userId: USER, role: "owner", status: "active" },
  });

  for (const [projectId, mediaId] of [
    [PROJECT_ON, MEDIA_ON],
    [PROJECT_OFF, MEDIA_OFF],
    [PROJECT_NO_HINTS, MEDIA_NO_HINTS],
  ] as const) {
    await prisma.project.create({
      data: { id: projectId, workspaceId: WORKSPACE, title: `B09b ${projectId}`, aspect: "r9x16" },
    });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        projectId,
        role: "primary",
        storageKey: `ws/${WORKSPACE}/p/${projectId}/media/${mediaId}/raw.mp4`,
        audio16kKey: `ws/${WORKSPACE}/p/${projectId}/media/${mediaId}/audio16k.wav`,
        durationMs: DURATION_MS,
        fps: 30,
        width: 1080,
        height: 1920,
        status: "ready",
      },
    });
  }

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
  await prisma.job.deleteMany({ where: { workspaceId: WORKSPACE } });
  await prisma.memoryEntry.deleteMany({ where: { workspaceId: WORKSPACE } });
  await prisma.consentRecord.deleteMany({ where: { userId: USER } });
  await prisma.subscription.deleteMany({ where: { workspaceId: WORKSPACE } });
  await prisma.project.deleteMany({ where: { workspaceId: WORKSPACE } });
  await prisma.membership.deleteMany({ where: { userId: USER } });
  await prisma.workspace.deleteMany({ where: { id: WORKSPACE } });
  await prisma.user.deleteMany({ where: { id: USER } });
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
  process.env["JWT_PRIVATE_KEY"] = JWT_KEYS.privateKey;
  process.env["JWT_PUBLIC_KEY"] = JWT_KEYS.publicKey;
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
    .overrideProvider(REALTIME_BUS)
    .useValue(new InMemoryRealtimeBus(new InMemoryRealtimeBroker()))
    .compile();

  app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  app.useGlobalFilters(new HttpExceptionFilter());
  applyInternalBodyLimit(app);
  setupOpenApi(app);
  await app.init();

  await fundWorkspaceCredits(app, WORKSPACE, AMPLE_TEST_CREDIT_TENTHS);
  tokens = app.get(TokenService);
}, 180_000);

afterAll(async () => {
  if (!CAN_RUN) return;
  await app?.close();
  await cleanup();
  redis?.disconnect();
  await db?.stop();
}, 60_000);

describe.skipIf(!CAN_RUN)("transcribe enqueue merges memory glossary into hints", () => {
  it("consent withheld: no memory terms are appended, only request-time hints", async () => {
    const response = await request(app.getHttpServer())
      .post(`/projects/${PROJECT_OFF}/transcribe`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ languages: ["hi-Latn"], hints: ["OnlyMine"] })
      .expect(202);

    const job = await prisma.job.findUniqueOrThrow({
      where: { id: response.body.jobId as string },
    });
    const hints = (job.params as { hints?: string[] }).hints ?? [];
    expect(hints).toEqual(["OnlyMine"]);
  });

  it("consent withheld: Hinglish request with no hints and no consented memory sends no hints at all", async () => {
    const response = await request(app.getHttpServer())
      .post(`/projects/${PROJECT_NO_HINTS}/transcribe`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ languages: ["hi-Latn"] })
      .expect(202);

    const job = await prisma.job.findUniqueOrThrow({
      where: { id: response.body.jobId as string },
    });
    const hints = (job.params as { hints?: string[] }).hints ?? [];
    expect(hints).toEqual([]);
  });

  it("consent granted: request-time hints first, then the stored glossary term, deduplicated", async () => {
    // Grant the `memory` consent directly (the /consents route is A05's and
    // out of this work package's boundary; a direct row is equivalent to
    // what it would write).
    await prisma.consentRecord.create({
      data: {
        id: id("CNS1"),
        userId: USER,
        workspaceId: WORKSPACE,
        purpose: "memory",
        version: "v1",
        granted: true,
        noticeVersion: "v1",
      },
    });

    await request(app.getHttpServer())
      .post("/memory")
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ kind: "glossary", key: "Aksharo", value: "Aksharo" })
      .expect(201);
    await request(app.getHttpServer())
      .post("/memory")
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ kind: "spelling", key: "sarvm", value: "Sarvam", aliases: ["sarvm"] })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post(`/projects/${PROJECT_ON}/transcribe`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ languages: ["hi-Latn"], hints: ["aksharo", "Timeline"] })
      .expect(202);

    const job = await prisma.job.findUniqueOrThrow({
      where: { id: response.body.jobId as string },
    });
    const hints = (job.params as { hints?: string[] }).hints ?? [];
    // request-time hints first, case-insensitively deduplicated against the
    // stored "Aksharo" glossary term, and the "Sarvam" spelling term appended.
    expect(hints).toEqual(["aksharo", "Timeline", "Sarvam"]);
  });
});
