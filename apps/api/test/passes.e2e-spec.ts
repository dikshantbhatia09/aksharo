/**
 * The autocut pass path, against real infrastructure (B18).
 *
 * ```
 * POST /projects/{id}/transcribe            → a transcript + EDG document (A11)
 * POST /internal/jobs/{id}/complete          → the ai.transcribe worker result
 * POST /projects/{id}/passes/autocut         → quote, hold, ai.pass on BullMQ
 * POST /internal/jobs/{id}/complete          → a fake ai.pass worker result
 *   → PassCompletionHandler builds a MergePass op → edg_passes + edg_pass_items
 * GET  /projects/{id}/passes                 → the pass and its proposed items
 * ```
 *
 * Needs Postgres and Redis, and skips loudly without either, exactly as
 * `transcripts.e2e-spec.ts` does — this suite reuses its harness shape rather
 * than inventing a second one.
 */
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type MembershipRole, type PrismaClient } from "@prisma/client";
import IORedis from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@montaj/edg";
import { type TranscriptChunk } from "@montaj/edg/schemas";

import { AMPLE_TEST_CREDIT_TENTHS, fundWorkspaceCredits } from "./credits-fixture.js";
import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { TokenService } from "../src/auth/token.service.js";
import { PrismaService } from "../src/common/prisma/prisma.service.js";
import { RedisService } from "../src/common/redis/redis.service.js";
import { resetEnvCache } from "../src/config/config.module.js";
import { internalSignatureHeaders } from "../src/internal/internal-signature.js";
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
    `[passes.e2e] skipped — ${DB_READY ? "" : `database: ${skipReason}. `}${
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
const PROJECT = id("PR0J");
const MEDIA = id("MEDA");

const DURATION_MS = 90_000;

let db: TestDatabase | null = null;
let prisma: PrismaClient;
let app: INestApplication;
let redis: IORedis;
let broker: InMemoryRealtimeBroker;
let tokens: TokenService;

const SAMPLE_TRANSCRIPT = resolve(
  __dirname,
  "../../../packages/edg/fixtures/sample-transcript.json",
);

function sampleWords(): Record<string, unknown>[] {
  const fixture = JSON.parse(readFileSync(SAMPLE_TRANSCRIPT, "utf8")) as {
    chunks: TranscriptChunk[];
  };
  return (fixture.chunks[0]?.words ?? []) as unknown as Record<string, unknown>[];
}

function transcribeCompletionBody(transcriptId: string): Record<string, unknown> {
  return {
    status: "succeeded",
    result: {
      transcriptId,
      mediaId: MEDIA,
      language: "hi",
      provider: "sarvam",
      model: "saarika-v2",
      durationMs: DURATION_MS,
      chunks: [
        {
          chunkIdx: 0,
          startMs: 0,
          endMs: DURATION_MS,
          nextWordSeq: sampleWords().length,
          words: sampleWords(),
        },
      ],
      providerSubmissions: [],
    },
    usage: { mediaSeconds: DURATION_MS / 1_000, provider: "sarvam", model: "saarika-v2" },
  };
}

function accessToken(role: MembershipRole = "owner"): string {
  return tokens.mintAccessToken({ userId: USER, workspaceId: WORKSPACE, role, kind: "web" })
    .accessToken;
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
    data: { id: USER, email: `b18+${RUN}@example.test`, name: "B18 test" },
  });
  await prisma.workspace.create({
    data: {
      id: WORKSPACE,
      slug: `b18-${RUN}`,
      name: `b18-${RUN}`,
      ownerId: USER,
      billingCountry: "IN",
    },
  });
  await prisma.membership.create({
    data: { id: id("MBR1"), workspaceId: WORKSPACE, userId: USER, role: "owner", status: "active" },
  });
  await prisma.project.create({
    data: { id: PROJECT, workspaceId: WORKSPACE, title: `B18 ${PROJECT}`, aspect: "r9x16" },
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
  const keys = await redis.keys("bull:*");
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
  broker = new InMemoryRealtimeBroker();

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
    .useValue(new InMemoryRealtimeBus(broker))
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

describe.skipIf(!CAN_RUN)("autocut pass: producer → worker completion → MergePass", () => {
  let transcribeJobId: string;
  let transcribeAttemptId: string;
  let transcriptId: string;

  let passJobId: string;
  let passAttemptId: string;
  let passId: string;

  it("transcribes the project first, so autocut has words to reason about", async () => {
    const started = await request(app.getHttpServer())
      .post(`/projects/${PROJECT}/transcribe`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({})
      .expect(202);
    transcribeJobId = started.body.jobId as string;
    transcriptId = started.body.transcriptId as string;

    const job = await prisma.job.findUniqueOrThrow({ where: { id: transcribeJobId } });
    transcribeAttemptId = job.attemptId ?? "";

    await callback(
      `/internal/jobs/${transcribeJobId}/complete`,
      transcribeCompletionBody(transcriptId),
      transcribeAttemptId,
    ).expect(200);

    const transcript = await prisma.transcript.findUniqueOrThrow({ where: { id: transcriptId } });
    expect(transcript.projectId).toBe(PROJECT);
  });

  let protectedRangeId: string;
  const PROTECTED_S = 1_000;
  const PROTECTED_E = 3_000;

  it("marks a protected range on the timeline via SetProtectedRanges", async () => {
    const before = await request(app.getHttpServer())
      .get(`/projects/${PROJECT}/edg`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .expect(200);
    const baseRevision = before.body.revision as number;

    protectedRangeId = newId();
    const opId = newId();
    const response = await request(app.getHttpServer())
      .post(`/projects/${PROJECT}/edg/ops`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({
        baseRevision,
        ops: [
          {
            opId,
            type: "SetProtectedRanges",
            ranges: [{ id: protectedRangeId, s: PROTECTED_S, e: PROTECTED_E }],
          },
        ],
        clientOpIds: [opId],
      })
      .expect(200);
    expect(response.body).toMatchObject({ applied: [opId], rejected: [] });

    const after = await request(app.getHttpServer())
      .get(`/projects/${PROJECT}/edg`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .expect(200);
    expect(after.body.hot.protected).toEqual([
      { id: protectedRangeId, s: PROTECTED_S, e: PROTECTED_E, reason: "user" },
    ]);
  });

  it("refuses to start autocut for a project with no transcript", async () => {
    // A second, virgin project, media only, no transcript.
    const virgin = id("PR0V");
    const virginMedia = id("MEDV");
    await prisma.project.create({
      data: { id: virgin, workspaceId: WORKSPACE, title: "no transcript", aspect: "r9x16" },
    });
    await prisma.mediaAsset.create({
      data: {
        id: virginMedia,
        projectId: virgin,
        role: "primary",
        storageKey: `ws/${WORKSPACE}/p/${virgin}/media/${virginMedia}/raw.mp4`,
        audio16kKey: `ws/${WORKSPACE}/p/${virgin}/media/${virginMedia}/audio16k.wav`,
        durationMs: DURATION_MS,
        status: "ready",
      },
    });

    const response = await request(app.getHttpServer())
      .post(`/projects/${virgin}/passes/autocut`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ preset: "standard" })
      .expect(409);
    expect(response.body.error.code).toBe("pass/transcript_not_ready");
  });

  it("quotes and enqueues an autocut pass", async () => {
    const response = await request(app.getHttpServer())
      .post(`/projects/${PROJECT}/passes/autocut`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ preset: "standard" })
      .expect(202);

    expect(response.body).toMatchObject({
      status: "queued",
      deduplicated: false,
      // 90s is 1.5 minutes: 15 tenths at the flash rate (1 credit/min).
      quote: { tenths: 15, credits: "1.5", durationMs: DURATION_MS },
    });
    expect(response.body.passId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    passJobId = response.body.jobId as string;
    passId = response.body.passId as string;

    const job = await prisma.job.findUniqueOrThrow({ where: { id: passJobId } });
    expect(job.type).toBe("ai.pass");
    expect(job.projectId).toBe(PROJECT);
    expect(job.creditsChargedTenths).toBe(15);
    const params = job.params as Record<string, unknown>;
    expect(params["passId"]).toBe(passId);
    expect(params["passType"]).toBe("autocut");
    expect(Array.isArray(params["words"])).toBe(true);
    expect((params["words"] as unknown[]).length).toBeGreaterThan(0);
    // The stored SetProtectedRanges range travels to the worker as protectedRanges,
    // so an autocut run is told never to propose a cut, zoom or reframe inside it.
    expect(params["protectedRanges"]).toEqual([[PROTECTED_S, PROTECTED_E]]);
    passAttemptId = job.attemptId ?? "";
  });

  it("deduplicates a second click while the pass is still running", async () => {
    const response = await request(app.getHttpServer())
      .post(`/projects/${PROJECT}/passes/autocut`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ preset: "standard" })
      .expect(202);
    expect(response.body).toMatchObject({ deduplicated: true, jobId: passJobId, passId });
  });

  it("accepts a fake worker completion and merges the proposed cuts", async () => {
    const words = sampleWords();
    const firstWord = words[0] as { wid: string; s: number; e: number };
    const secondWord = words[1] as { wid: string; s: number; e: number };

    const body = {
      status: "succeeded",
      result: {
        passId,
        passType: "autocut",
        preset: "standard",
        params: { minSilenceMs: 600, maxRemovalRatio: 0.3, paddingMs: 80 },
        counts: { silence: 1, pause: 0, filler: 1, retake: 0 },
        totalRemovedMs: 900,
        totalKeptMs: DURATION_MS - 900,
        items: [
          {
            startMs: firstWord.s,
            endMs: firstWord.e,
            reason: "filler",
            confidence: 0.95,
            wordIds: [firstWord.wid],
          },
          {
            startMs: secondWord.e + 80,
            endMs: secondWord.e + 780,
            reason: "silence",
            confidence: 0.8,
            wordIds: [],
          },
        ],
      },
      usage: { mediaSeconds: DURATION_MS / 1_000 },
    };

    const response = await callback(
      `/internal/jobs/${passJobId}/complete`,
      body,
      passAttemptId,
    ).expect(200);
    expect(response.body).toMatchObject({ applied: true, status: "succeeded" });
  });

  it("lists the merged pass and its proposed items through GET /projects/{id}/passes", async () => {
    const response = await request(app.getHttpServer())
      .get(`/projects/${PROJECT}/passes`)
      .set("Authorization", `Bearer ${accessToken("viewer")}`)
      .expect(200);

    const passes = response.body.passes as Record<string, unknown>[];
    const landed = passes.find((pass) => pass["passId"] === passId);
    expect(landed).toBeDefined();
    expect(landed).toMatchObject({ type: "autocut", status: "ready" });

    const items = landed?.["items"] as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item["kind"]).toBe("cut");
      expect(item["state"]).toBe("proposed");
      expect(item["payload"]).toEqual({});
      // wordIds must NOT have leaked into the frozen empty CutPayloadSchema.
      expect(item["payload"]).not.toHaveProperty("wordIds");
    }
    const reasons = items.map((item) => item["reason"]).sort();
    expect(reasons).toEqual(["filler", "silence"]);
  });

  it("replaying the same completion is a no-op (MergePass is idempotent per passId)", async () => {
    const before = await prisma.edgPassItem.count({ where: { passId } });

    const body = {
      status: "succeeded",
      result: { passId, passType: "autocut", preset: "standard", items: [] },
    };
    await callback(`/internal/jobs/${passJobId}/complete`, body, passAttemptId).expect(200);

    const after = await prisma.edgPassItem.count({ where: { passId } });
    expect(after).toBe(before);
  });
});
