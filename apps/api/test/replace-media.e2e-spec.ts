/**
 * Replace-media re-alignment, end to end (B15 brief §5, increment 3).
 *
 * ```
 * POST /projects/{id}/transcribe -> completion callback  -> a real EDG document
 * media_assets.needs_realign = true                      (what MediaService.replace
 *                                                          sets -- driven directly here;
 *                                                          the multipart upload it also
 *                                                          drives is A06/A07's own suite)
 * media.probe enqueued + its completion callback          -> MediaProbeCompletionHandler
 *                                                            sees needs_realign and
 *                                                            enqueues ai.align as a child
 * ai.align's completion callback (synthetic aligned words) -> AlignCompletionHandler
 *                                                            retimes the live words and
 *                                                            widens the segment, through
 *                                                            the real op-batch write path
 * ```
 *
 * Needs Postgres and Redis; skips loudly without either. No worker is spawned
 * and no object storage is touched -- both completions are the same signed
 * internal callback a real worker would post, exactly as transcripts.
 * e2e-spec.ts drives ai.transcribe's.
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
import { JobsService } from "../src/jobs/jobs.service.js";

import type { TestDatabase } from "./db-harness.js";
import type { INestApplication } from "@nestjs/common";

const CALLBACK_SECRET = "test-callback-secret-at-least-32-characters-long";

const DB_READY = isDatabaseAvailable();
const REDIS_READY = isRedisAvailable();
const CAN_RUN = DB_READY && REDIS_READY;

if (!CAN_RUN) {
  console.warn(
    `[replace-media.e2e] skipped — ${DB_READY ? "" : `database: ${skipReason}. `}${
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
const DURATION_MS = 2_000;

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

/** A tiny, hand-written two-word transcript — one chunk, one segment. */
function transcribeCompletionBody(transcriptId: string): Record<string, unknown> {
  return {
    status: "succeeded",
    result: {
      transcriptId,
      mediaId: MEDIA,
      language: "hi",
      provider: "sarvam",
      model: "saarika-v2",
      lane: "hinglish",
      durationMs: DURATION_MS,
      chunks: [
        {
          chunkIdx: 0,
          startMs: 0,
          endMs: DURATION_MS,
          nextWordSeq: 2,
          words: [
            { wid: "0:0", s: 0, e: 400, t: "namaste" },
            { wid: "0:1", s: 400, e: 900, t: "dosto" },
          ],
        },
      ],
      providerSubmissions: [],
    },
  };
}

async function seed(): Promise<void> {
  await prisma.user.create({
    data: { id: USER, email: `b15rm+${RUN}@example.test`, name: "B15 test" },
  });
  await prisma.workspace.create({
    data: {
      id: WORKSPACE,
      slug: `b15rm-${RUN}`,
      name: `b15rm-${RUN}`,
      ownerId: USER,
      billingCountry: "IN",
    },
  });
  await prisma.membership.create({
    data: { id: id("MBR1"), workspaceId: WORKSPACE, userId: USER, role: "owner", status: "active" },
  });
  await prisma.project.create({
    data: { id: PROJECT, workspaceId: WORKSPACE, title: "Replace-media e2e", aspect: "r9x16" },
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

describe.skipIf(!CAN_RUN)("replace-media re-alignment (B15 §5)", () => {
  it("retimes the live words and widens the segment, without touching text", async () => {
    const server = app.getHttpServer();

    // 1. A real transcription, so there is a real EDG document with one
    // segment covering both words.
    const transcribeResponse = await request(server)
      .post(`/projects/${PROJECT}/transcribe`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ languages: ["hi"] })
      .expect(202);
    const { jobId: transcribeJobId, transcriptId } = transcribeResponse.body as {
      jobId: string;
      transcriptId: string;
    };
    const transcribeJob = await prisma.job.findUniqueOrThrow({ where: { id: transcribeJobId } });
    await callback(
      `/internal/jobs/${transcribeJobId}/complete`,
      transcribeCompletionBody(transcriptId),
      transcribeJob.attemptId ?? "",
    ).expect(200);

    const edgBefore = await prisma.edgDocument.findUniqueOrThrow({ where: { projectId: PROJECT } });
    const segmentBefore = await prisma.edgSegment.findFirstOrThrow({
      where: { edgId: edgBefore.id },
    });
    expect(segmentBefore.startMs).toBe(0);

    // 2. Simulate MediaService.replace()'s own effect (new bytes, same row):
    // the row is marked needs_realign and a fresh media.probe is run.
    await prisma.mediaAsset.update({ where: { id: MEDIA }, data: { needsRealign: true } });

    const jobsService = app.get(JobsService);
    const { job: probeJob } = await jobsService.enqueue({
      type: "media.probe",
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      params: { mediaId: MEDIA },
      jobKey: `media.probe:${MEDIA}:replace`,
      worstCaseTenths: 0,
      reason: "replace-media e2e",
    });

    await callback(
      `/internal/jobs/${probeJob.id}/complete`,
      {
        status: "succeeded",
        result: {
          mediaId: MEDIA,
          container: "mov,mp4,m4a,3gp,3g2,mj2",
          mime: "video/mp4",
          durationMs: DURATION_MS,
          sizeBytes: 2_000_000,
          hasVideo: true,
          hasAudio: true,
          video: {
            codec: "h264",
            width: 1080,
            height: 1920,
            fps: 30,
            rotation: 0,
            pixelFormat: "yuv420p",
            bitDepth: 8,
            colourTransfer: "bt709",
            colourPrimaries: "bt709",
            hdr: false,
          },
          audio: { codec: "aac", channels: 2, sampleRate: 48_000 },
          probedAt: new Date().toISOString(),
        },
      },
      probeJob.attemptId ?? "",
    ).expect(200);

    // 3. The probe's own completion handler should have enqueued ai.align as
    // a child, because needs_realign was set.
    const alignJob = await prisma.job.findFirstOrThrow({
      where: { workspaceId: WORKSPACE, type: "ai.align", jobKey: `ai.align:${MEDIA}` },
    });
    expect((alignJob.params as Record<string, unknown>)["mode"]).toBe("replace_media");

    const clearedMedia = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: MEDIA } });
    expect(clearedMedia.needsRealign).toBe(false);

    // 4. The (fake) worker's forced-alignment answer: both words shifted
    // 200 ms later, in the same order they were sent.
    await callback(
      `/internal/jobs/${alignJob.id}/complete`,
      {
        status: "succeeded",
        result: {
          mediaId: MEDIA,
          language: "hi-IN",
          alignerModel: "proportional",
          words: [
            { s: 200, e: 600, t: "namaste" },
            { s: 600, e: 1100, t: "dosto" },
          ],
        },
      },
      alignJob.attemptId ?? "",
    ).expect(200);

    // 5. The document's words moved; the text is untouched; a new revision exists.
    const edgAfter = await prisma.edgDocument.findUniqueOrThrow({ where: { projectId: PROJECT } });
    expect(edgAfter.revision).toBeGreaterThan(edgBefore.revision);

    const chunk = await prisma.transcriptChunk.findFirstOrThrow({
      where: { transcriptId },
    });
    const words = chunk.words as unknown as { wid: string; s: number; e: number; t: string }[];
    expect(words.find((word) => word.wid === "0:0")).toMatchObject({
      s: 200,
      e: 600,
      t: "namaste",
    });
    expect(words.find((word) => word.wid === "0:1")).toMatchObject({ s: 600, e: 1100, t: "dosto" });

    const segmentAfter = await prisma.edgSegment.findFirstOrThrow({
      where: { edgId: edgAfter.id },
    });
    expect(segmentAfter.startMs).toBe(0); // unchanged — the first word already started at 0
    expect(segmentAfter.endMs).toBeGreaterThanOrEqual(1100);

    // The completion's own diff report lands in the job.succeeded event data.
    const succeededEvent = await prisma.jobEvent.findFirstOrThrow({
      where: { jobId: alignJob.id, message: "succeeded" },
    });
    expect(succeededEvent.data).toMatchObject({
      diff: { wordsApplied: 2, wordsUnmatched: [] },
    });
  }, 60_000);
});
