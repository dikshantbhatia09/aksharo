/**
 * Import transcript & align, end to end (B15 brief §6, increment 4).
 *
 * ```
 * POST /projects/{id}/import (SRT)  -> parses cues, stores the sidecar,
 *                                       enqueues ai.align with a worker-shaped
 *                                       {segments:[{startMs,endMs,text}]} payload
 * ai.align's completion callback     -> AlignCompletionHandler (mode "import")
 * (synthetic aligned words)             persists one transcript chunk and
 *                                       initialises a brand-new EDG document
 * ```
 *
 * Needs Postgres and Redis; skips loudly without either. No worker is spawned;
 * the completion is the same signed internal callback a real worker would post.
 */
import { generateKeyPairSync } from "node:crypto";

import { type PrismaClient } from "@prisma/client";
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
import { internalSignatureHeaders } from "../src/internal/internal-signature.js";

import type { TestDatabase } from "./db-harness.js";
import type { INestApplication } from "@nestjs/common";

const CALLBACK_SECRET = "test-callback-secret-at-least-32-characters-long";

const DB_READY = isDatabaseAvailable();
const REDIS_READY = isRedisAvailable();
const CAN_RUN = DB_READY && REDIS_READY;

if (!CAN_RUN) {
  console.warn(
    `[import-align.e2e] skipped — ${DB_READY ? "" : `database: ${skipReason}. `}${
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
const id = (kind: string): string => `01JE${kind}${RUN}`.padEnd(26, "0").slice(0, 26);

const USER = id("US3R");
const WORKSPACE = id("WKSP");
const PROJECT = id("PR0J");
const MEDIA = id("MEDA");
const DURATION_MS = 2_000;

const SAMPLE_SRT = [
  "1",
  "00:00:00,000 --> 00:00:00,900",
  "hello world",
  "",
  "2",
  "00:00:00,900 --> 00:00:01,500",
  "again",
  "",
].join("\n");

let db: TestDatabase | null = null;
let prisma: PrismaClient;
let app: INestApplication;
let redis: IORedis;
let tokens: TokenService;

function accessToken(): string {
  return tokens.mintAccessToken({
    userId: USER,
    workspaceId: WORKSPACE,
    role: "owner",
    kind: "web",
  }).accessToken;
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

async function seed(): Promise<void> {
  await prisma.user.create({
    data: { id: USER, email: `b15ia+${RUN}@example.test`, name: "B15 test" },
  });
  await prisma.workspace.create({
    data: {
      id: WORKSPACE,
      slug: `b15ia-${RUN}`,
      name: `b15ia-${RUN}`,
      ownerId: USER,
      billingCountry: "IN",
    },
  });
  await prisma.membership.create({
    data: { id: id("MBR1"), workspaceId: WORKSPACE, userId: USER, role: "owner", status: "active" },
  });
  await prisma.project.create({
    data: { id: PROJECT, workspaceId: WORKSPACE, title: "Import-align e2e", aspect: "r9x16" },
  });
  await prisma.mediaAsset.create({
    data: {
      id: MEDIA,
      projectId: PROJECT,
      role: "primary",
      storageKey: `ws/${WORKSPACE}/p/${PROJECT}/media/${MEDIA}/raw.mp4`,
      audio16kKey: `ws/${WORKSPACE}/p/${PROJECT}/media/${MEDIA}/audio16k.wav`,
      durationMs: DURATION_MS,
      fps: 30,
      width: 1080,
      height: 1920,
      status: "ready",
    },
  });
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
  await prisma.subscription.deleteMany({ where: { workspaceId: WORKSPACE } });
  await prisma.project.deleteMany({ where: { workspaceId: WORKSPACE } });
  await prisma.membership.deleteMany({ where: { userId: USER } });
  await prisma.workspace.deleteMany({ where: { id: WORKSPACE } });
  await prisma.user.deleteMany({ where: { id: USER } });
  if (redis === undefined) return;
  const prefix = process.env["MONTAJ_REDIS_PREFIX"] ?? "montaj";
  const keys = await redis.keys(`${prefix}:*${RUN}*`);
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

describe.skipIf(!CAN_RUN)("import transcript & align (B15 §6)", () => {
  it("imports an SRT, aligns it, and creates a fresh EDG document with the cue text intact", async () => {
    const server = app.getHttpServer();

    const importResponse = await request(server)
      .post(`/projects/${PROJECT}/import`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ kind: "srt", content: SAMPLE_SRT, language: "en", mediaId: MEDIA })
      .expect(201);
    const { jobId: alignJobId } = importResponse.body as { jobId: string };

    const alignJob = await prisma.job.findUniqueOrThrow({ where: { id: alignJobId } });
    expect(alignJob.type).toBe("ai.align");
    const params = alignJob.params as Record<string, unknown>;
    expect(params["mode"]).toBe("import");
    // The worker-shaped payload the producer fix built from the two SRT cues.
    expect(params["segments"]).toEqual([
      { startMs: 0, endMs: 900, text: "hello world" },
      { startMs: 900, endMs: 1500, text: "again" },
    ]);
    expect(params["cueWordCounts"]).toEqual([2, 1]);

    // The (fake) worker's forced-alignment answer for the whole cue text.
    await callback(
      `/internal/jobs/${alignJobId}/complete`,
      {
        status: "succeeded",
        result: {
          mediaId: MEDIA,
          language: "en-IN",
          alignerModel: "proportional",
          words: [
            { s: 0, e: 400, t: "hello" },
            { s: 400, e: 900, t: "world" },
            { s: 900, e: 1500, t: "again" },
          ],
        },
      },
      alignJob.attemptId ?? "",
    ).expect(200);

    const edg = await prisma.edgDocument.findUniqueOrThrow({ where: { projectId: PROJECT } });
    expect(edg.revision).toBe(1);

    const transcript = await prisma.transcript.findUniqueOrThrow({
      where: { id: (params["transcriptId"] as string) ?? "" },
    });
    expect(transcript.language).toBe("en");

    const chunk = await prisma.transcriptChunk.findFirstOrThrow({
      where: { transcriptId: transcript.id },
    });
    const words = chunk.words as unknown as { wid: string; s: number; e: number; t: string }[];
    expect(words).toEqual([
      { wid: "0:0", s: 0, e: 400, t: "hello" },
      { wid: "0:1", s: 400, e: 900, t: "world" },
      { wid: "0:2", s: 900, e: 1500, t: "again" },
    ]);

    const segments = await prisma.edgSegment.findMany({
      where: { edgId: edg.id },
      orderBy: { seq: "asc" },
    });
    expect(segments.length).toBeGreaterThan(0);
    // Text comes from the words the segments address, and those words are the
    // exact cue text — nothing invented, nothing dropped.
    expect(segments.map((segment) => segment.startWordId)).toContain("0:0");
  }, 60_000);
});
