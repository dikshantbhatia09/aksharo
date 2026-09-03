/**
 * The prompted-edits chain, against real infrastructure (D07).
 *
 * ```
 * POST /projects/{id}/transcribe                       -> a transcript (A11)
 * POST /projects/{id}/prompted-edits                    -> plan (mock planner, edit-plan@1)
 * GET  /projects/{id}/prompted-edits/{planId}            -> the plan preview
 * POST /projects/{id}/prompted-edits/{planId}/run        -> holds credits, starts the first pass
 * POST /internal/jobs/{id}/complete (autocut)            -> chain advances to music
 * POST /internal/jobs/{id}/complete (music)              -> chain settles, plan completes
 * ```
 *
 * Reuses `passes.e2e-spec.ts`'s harness shape (same seed/callback helpers,
 * same skip-loudly-without-Postgres-or-Redis behaviour).
 */
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type MembershipRole, type PrismaClient } from "@prisma/client";
import IORedis from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
    `[prompted-edits.e2e] skipped — ${DB_READY ? "" : `database: ${skipReason}. `}${
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
      language: "en",
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
    data: { id: USER, email: `d07+${RUN}@example.test`, name: "D07 test" },
  });
  await prisma.workspace.create({
    data: {
      id: WORKSPACE,
      slug: `d07-${RUN}`,
      name: `d07-${RUN}`,
      ownerId: USER,
      billingCountry: "IN",
    },
  });
  await prisma.membership.create({
    data: { id: id("MBR1"), workspaceId: WORKSPACE, userId: USER, role: "owner", status: "active" },
  });
  await prisma.project.create({
    data: { id: PROJECT, workspaceId: WORKSPACE, title: `D07 ${PROJECT}`, aspect: "r9x16" },
  });
  await prisma.mediaAsset.create({
    data: {
      id: MEDIA,
      projectId: PROJECT,
      role: "primary",
      storageKey: `ws/${WORKSPACE}/p/${PROJECT}/media/${MEDIA}/raw.mp4`,
      audio16kKey: `ws/${WORKSPACE}/p/${PROJECT}/media/${MEDIA}/audio16k.wav`,
      proxyKey: `ws/${WORKSPACE}/p/${PROJECT}/media/${MEDIA}/proxy540.mp4`,
      durationMs: DURATION_MS,
      fps: 30,
      width: 1080,
      height: 1920,
      status: "ready",
    },
  });

  const plan = await prisma.plan.upsert({
    where: { key: "studio" },
    update: {},
    create: { id: id("PLAN"), key: "studio", name: "Studio", creditsPerMonthTenths: 10_000 },
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
  await prisma.promptedEditPlan.deleteMany({ where: { workspaceId: WORKSPACE } });
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
  delete process.env["ANTHROPIC_API_KEY"];
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

describe.skipIf(!CAN_RUN)("prompted edits: plan -> run -> chained pass completions", () => {
  let transcriptId: string;
  let planId: string;

  it("transcribes the project first, so the planner and its passes have words to reason about", async () => {
    const started = await request(app.getHttpServer())
      .post(`/projects/${PROJECT}/transcribe`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({})
      .expect(202);
    const transcribeJobId = started.body.jobId as string;
    transcriptId = started.body.transcriptId as string;

    const job = await prisma.job.findUniqueOrThrow({ where: { id: transcribeJobId } });
    await callback(
      `/internal/jobs/${transcribeJobId}/complete`,
      transcribeCompletionBody(transcriptId),
      job.attemptId ?? "",
    ).expect(200);
  });

  it("plans a prompted edit from a free-text prompt (mock planner, edit-plan@1)", async () => {
    const response = await request(app.getHttpServer())
      .post(`/projects/${PROJECT}/prompted-edits`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ prompt: "Cut the silences and add some background music", engine: "flash" })
      .expect(201);

    planId = response.body.id as string;
    expect(response.body.status).toBe("planned");
    const kinds = (response.body.passes as { kind: string }[]).map((p) => p.kind);
    expect(kinds).toContain("autocut");
    expect(kinds).toContain("music");
    expect(response.body.rationale).toHaveLength(kinds.length);
    expect(response.body.holdTenths).toBeGreaterThan(0);

    const row = await prisma.promptedEditPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(row.status).toBe("planned");
    expect(row.provider).toBe("mock");
  });

  it("reads the plan back for the preview sheet", async () => {
    const response = await request(app.getHttpServer())
      .get(`/projects/${PROJECT}/prompted-edits/${planId}`)
      .set("Authorization", `Bearer ${accessToken("viewer")}`)
      .expect(200);
    expect(response.body.id).toBe(planId);
    expect(response.body.status).toBe("planned");
  });

  let firstJobId: string;
  let firstAttemptId: string;

  it("runs the plan: holds credits on source minutes, starts the first (autocut) pass", async () => {
    const response = await request(app.getHttpServer())
      .post(`/projects/${PROJECT}/prompted-edits/${planId}/run`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .expect(202);

    expect(response.body.firstPassKind).toBe("autocut");
    expect(response.body.status).toBe("running");
    expect(response.body.holdTenths).toBeGreaterThan(0);
    firstJobId = response.body.jobId as string;

    const row = await prisma.promptedEditPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(row.status).toBe("running");
    expect(row.holdId).not.toBeNull();
    expect(row.currentJobId).toBe(firstJobId);
    expect(row.remainingKinds).toEqual(["music"]);

    // The chain's first job carries the whole plan's macro hold (it is the
    // only job a `CreditHold` row can be minted against) — later chain steps
    // cost 0 on top of it (`skipCredits`).
    const firstJob = await prisma.job.findUniqueOrThrow({ where: { id: firstJobId } });
    expect(firstJob.creditsChargedTenths).toBe(response.body.holdTenths);
    expect(firstJob.creditHoldId).toBe(row.holdId);
    firstAttemptId = firstJob.attemptId ?? "";
  });

  it("completing the autocut pass advances the chain to music", async () => {
    const body = {
      status: "succeeded",
      result: { passId: "chain-autocut", passType: "autocut", preset: "standard", items: [] },
    };
    await callback(`/internal/jobs/${firstJobId}/complete`, body, firstAttemptId).expect(200);

    const row = await prisma.promptedEditPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(row.status).toBe("running");
    expect(row.remainingKinds).toEqual([]);
    expect(row.currentJobId).not.toBeNull();
    expect(row.currentJobId).not.toBe(firstJobId);
  });

  it("completing the music pass settles the plan's credit hold and marks it completed", async () => {
    const row = await prisma.promptedEditPlan.findUniqueOrThrow({ where: { id: planId } });
    const musicJobId = row.currentJobId;
    expect(musicJobId).not.toBeNull();
    const musicJob = await prisma.job.findUniqueOrThrow({ where: { id: musicJobId as string } });

    const body = {
      status: "succeeded",
      result: { passId: "chain-music", passType: "music", items: [] },
    };
    await callback(`/internal/jobs/${musicJobId}/complete`, body, musicJob.attemptId ?? "").expect(
      200,
    );

    const finished = await prisma.promptedEditPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(finished.status).toBe("completed");
    expect(finished.currentJobId).toBeNull();
    expect(finished.settledTenths).not.toBeNull();
    expect(finished.settledTenths as number).toBeGreaterThan(0);
  });

  it("run() on an already-running/completed plan is rejected", async () => {
    await request(app.getHttpServer())
      .post(`/projects/${PROJECT}/prompted-edits/${planId}/run`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .expect(409);
  });
});
