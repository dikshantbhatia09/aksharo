/**
 * Scripts and translation, against real infrastructure (A22).
 *
 * ```
 * seed: a 5-word Hinglish chunk + a real EDG document (EdgService.initialise)
 *
 * POST /projects/{id}/transcript/transliterate {script:"native"} → ai.transliterate, free
 *   worker: POST /internal/transcripts/{id}/scripts   → word.scripts.native written
 *   worker: POST /internal/jobs/{id}/complete
 * GET  /projects/{id}/transcript?script=native        → words projected onto native
 * GET  /projects/{id}/transcript/export?script=native  → srt cues in Devanagari
 *
 * POST /projects/{id}/transcript/translate {targets:["en"]} → ai.translate, 0.5cr/min
 *   worker: POST /internal/projects/{id}/edg/ops  {SetSegmentText script:"translated"}
 *   worker: POST /internal/jobs/{id}/complete
 * GET  /projects/{id}/transcript/scripts                → translated: available, language en
 * GET  /projects/{id}/transcript/export?script=translated → srt cues in English
 * ```
 *
 * The worker itself is not started here — every other e2e spec in this suite
 * simulates a worker's completion the same way (`internalSignatureHeaders` over
 * the real signed routes), because the contract under test is the API's side of
 * the wire, not BullMQ's delivery. `apps/worker-ai/tests/test_transliterate.py`
 * and `test_translate.py` exercise the worker's own half — the rule-table
 * transliteration, the provider chain, the length-aware retry and the glossary
 * masking — against a recording callback client, which is that suite's
 * equivalent of this one's `callback()` helper.
 *
 * Needs Postgres and Redis; skips loudly without either, exactly like
 * `transcripts.e2e-spec.ts`.
 */
import { generateKeyPairSync } from "node:crypto";

import { type PrismaClient } from "@prisma/client";
import IORedis from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { TokenService } from "../src/auth/token.service.js";
import { PrismaService } from "../src/common/prisma/prisma.service.js";
import { RedisService } from "../src/common/redis/redis.service.js";
import { resetEnvCache } from "../src/config/config.module.js";
import { EdgService } from "../src/edg/index.js";
import { internalSignatureHeaders } from "../src/internal/internal-signature.js";
import {
  InMemoryRealtimeBroker,
  InMemoryRealtimeBus,
  REALTIME_BUS,
} from "../src/realtime/realtime.bus.js";

import type { TestDatabase } from "./db-harness.js";
import type { INestApplication } from "@nestjs/common";

const CALLBACK_SECRET = "test-callback-secret-at-least-32-characters-long";
const PREFIX = process.env["MONTAJ_QUEUE_PREFIX"] ?? "bull";

const DB_READY = isDatabaseAvailable();
const REDIS_READY = isRedisAvailable();
const CAN_RUN = DB_READY && REDIS_READY;

if (!CAN_RUN) {
  console.warn(
    `[transcripts-scripts.e2e] skipped — ${DB_READY ? "" : `database: ${skipReason}. `}${
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
const TRANSCRIPT = id("TRAN");
const DURATION_MS = 5_000;

/** The five-word Hinglish golden sample `worker_ai`'s own tests use. */
const WORDS = [
  { wid: "0:0", s: 0, e: 400, t: "toh" },
  { wid: "0:1", s: 400, e: 800, t: "aaj" },
  { wid: "0:2", s: 800, e: 1_200, t: "hum" },
  { wid: "0:3", s: 1_200, e: 2_000, t: "video" },
  { wid: "0:4", s: 2_000, e: 2_400, t: "hai" },
] as const;
/** What `RuleTableTransliterationProvider` produces for the words above (native). */
const NATIVE_TEXT = { "0:0": "तो", "0:1": "आज", "0:2": "हम", "0:3": "video", "0:4": "है" };

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

/** POST a signed internal callback exactly as a worker would. */
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
    data: { id: USER, email: `a22+${RUN}@example.test`, name: "A22 test" },
  });
  await prisma.workspace.create({
    data: {
      id: WORKSPACE,
      slug: `a22-${RUN}`,
      name: `a22-${RUN}`,
      ownerId: USER,
      billingCountry: "IN",
    },
  });
  await prisma.membership.create({
    data: { id: id("MBR1"), workspaceId: WORKSPACE, userId: USER, role: "owner", status: "active" },
  });
  await prisma.project.create({
    data: { id: PROJECT, workspaceId: WORKSPACE, title: `A22 ${PROJECT}`, aspect: "r9x16" },
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

  // Creator plan: translation needs Starter+ for English, Creator+ for anything else.
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

  // B02's real LedgerCreditsFacade (now CREDITS_FACADE, replacing A08's no-op)
  // needs an account with a funded lot to reserve translation's 0.5 credit/min
  // against — a bare `subscriptions` row (what the checkout flow this test does
  // not run would eventually produce) grants nothing on its own.
  const account = await prisma.creditAccount.create({
    data: { id: id("CACT"), workspaceId: WORKSPACE, balanceTenths: 3_000 },
  });
  await prisma.creditLot.create({
    data: {
      id: id("CLOT"),
      accountId: account.id,
      source: "grant",
      grantedTenths: 3_000,
      remainingTenths: 3_000,
    },
  });

  // The transcript A11's TranscribeCompletionHandler would have written.
  await prisma.transcript.create({
    data: {
      id: TRANSCRIPT,
      projectId: PROJECT,
      language: "hi",
      currentRevision: 1,
      detectedLanguages: [{ language: "hi", confidence: 0.9, source: "provider" }],
    },
  });
  await prisma.transcriptChunk.create({
    data: {
      id: id("CHNK"),
      transcriptId: TRANSCRIPT,
      revision: 1,
      chunkIdx: 0,
      startMs: 0,
      endMs: DURATION_MS,
      words: [...WORDS],
      nextWordSeq: WORDS.length,
    },
  });

  // The EDG document A11's EdgService.initialise would have written.
  const edg = app.get(EdgService);
  await edg.initialise(PROJECT, {
    transcriptId: TRANSCRIPT,
    language: "hi",
    scripts: ["roman"],
    chunks: [{ chunkIdx: 0, startMs: 0, endMs: DURATION_MS, words: [...WORDS] }],
    author: null,
    source: "worker",
  });
}

async function cleanup(): Promise<void> {
  if (prisma === undefined) return;
  await prisma.job.deleteMany({ where: { workspaceId: WORKSPACE } });
  await prisma.jobEvent.deleteMany({ where: { job: { workspaceId: WORKSPACE } } });
  await prisma.subscription.deleteMany({ where: { workspaceId: WORKSPACE } });
  await prisma.project.deleteMany({ where: { workspaceId: WORKSPACE } });
  await prisma.membership.deleteMany({ where: { userId: USER } });
  await prisma.workspace.deleteMany({ where: { id: WORKSPACE } });
  await prisma.user.deleteMany({ where: { id: USER } });

  if (redis === undefined) return;
  const keys = await redis.keys(`${PREFIX}:*`);
  if (keys.length > 0) await redis.del(...keys);
}

beforeAll(async () => {
  if (!CAN_RUN) return;

  db = await createTestDatabase();
  if (db === null) throw new Error(`could not start a test database: ${skipReason}`);
  prisma = db.prisma;
  await prisma.$connect();

  redis = new IORedis(testRedisUrl(), { maxRetriesPerRequest: null });
  const broker = new InMemoryRealtimeBroker();

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

  tokens = app.get(TokenService);
  await seed();
}, 180_000);

afterAll(async () => {
  if (!CAN_RUN) return;
  await app?.close();
  await cleanup();
  redis?.disconnect();
  await db?.stop();
}, 60_000);

// ---------------------------------------------------------------------------

describe.skipIf(!CAN_RUN)("scripts and translation (A22)", () => {
  it("transliterates the transcript to Devanagari, free, and it shows up everywhere", async () => {
    const accepted = await request(app.getHttpServer())
      .post(`/projects/${PROJECT}/transcript/transliterate`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ script: "native" })
      .expect(202);

    expect(accepted.body).toMatchObject({ targetScript: "native", deduplicated: false });
    const jobId = accepted.body.jobId as string;
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    const attemptId = job.attemptId ?? "";

    // The worker's word-scripts write, exactly as `processors/transliterate.py`
    // sends it (fixture text matches `worker_ai`'s own golden test).
    const write = await callback(
      `/internal/transcripts/${TRANSCRIPT}/scripts`,
      {
        jobId,
        targetScript: "native",
        provider: "indicxlit-ruletable",
        words: Object.entries(NATIVE_TEXT).map(([wid, text]) => ({ wid, text })),
      },
      attemptId,
    ).expect(200);
    expect(write.body).toMatchObject({ transcriptId: TRANSCRIPT, wordsUpdated: 5 });

    await callback(
      `/internal/jobs/${jobId}/complete`,
      {
        status: "succeeded",
        result: {
          transcriptId: TRANSCRIPT,
          targetScript: "native",
          wordsUpdated: 5,
          wordsPreserved: 1,
          provider: "indicxlit-ruletable",
          applied: true,
        },
      },
      attemptId,
    ).expect(200);

    // GET .../transcript?script=native projects every word's `t` onto its
    // native variant, English preserved.
    const manifest = await request(app.getHttpServer())
      .get(`/projects/${PROJECT}/transcript?script=native`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .expect(200);
    const words = (manifest.body.chunks[0].words as { wid: string; t: string }[]).map(
      (word) => word.t,
    );
    expect(words).toEqual(["तो", "आज", "हम", "video", "है"]);
    // The original script is untouched: `scripts.roman` was never asked for,
    // and `word.t` in the manifest reads the primary text without ?script=.
    // No revision pinned either (A11d + A22c): transliteration bumped
    // transcripts.currentRevision, and the newest-row-at-or-before-revision
    // read must still return every chunk, not an empty page.
    const primary = await request(app.getHttpServer())
      .get(`/projects/${PROJECT}/transcript`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .expect(200);
    const primaryWords = primary.body.chunks[0].words as {
      t: string;
      scripts?: { native?: string };
    }[];
    expect(primaryWords).toHaveLength(WORDS.length);
    expect(primaryWords.map((word) => word.t)).toEqual(["toh", "aaj", "hum", "video", "hai"]);
    // The new script variant is there too - the manifest read did not lose it.
    expect(primaryWords.map((word) => word.scripts?.native)).toEqual([
      "तो",
      "आज",
      "हम",
      "video",
      "है",
    ]);
    expect(primary.body.transcript.revision).toBeGreaterThan(1);

    // GET .../transcript/scripts reports it available, with provenance.
    const scripts = await request(app.getHttpServer())
      .get(`/projects/${PROJECT}/transcript/scripts`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .expect(200);
    const native = (scripts.body.scripts as { script: string; available: boolean }[]).find(
      (row) => row.script === "native",
    );
    expect(native).toMatchObject({
      available: true,
      source: "transliteration",
      provider: "indicxlit-ruletable",
    });

    // Export in the native script.
    const exported = await request(app.getHttpServer())
      .get(`/projects/${PROJECT}/transcript/export?format=srt&script=native`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .expect(200);
    expect(exported.text).toContain("तो आज हम video है");
  });

  it("translates the transcript to English through the ordinary EDG op path", async () => {
    const document = await request(app.getHttpServer())
      .get(`/projects/${PROJECT}/edg`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .expect(200);
    const baseRevision = document.body.revision as number;
    const segmentId = (document.body.segments[0] as { id: string }).id;

    const accepted = await request(app.getHttpServer())
      .post(`/projects/${PROJECT}/transcript/translate`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ targets: ["en"] })
      .expect(202);

    expect(accepted.body.targets).toHaveLength(1);
    const target = accepted.body.targets[0] as { jobId: string; targetLanguage: string };
    expect(target.targetLanguage).toBe("en");
    // 0.5 credit / media minute (04 §Credits), 5s of media rounded up to 0.1 min.
    expect(accepted.body.quote.tenths).toBeGreaterThan(0);

    const translateJob = await prisma.job.findUniqueOrThrow({ where: { id: target.jobId } });
    const attemptId = translateJob.attemptId ?? "";
    // A valid ULID: `crockford()` never emits I/L/O/U, unlike a hand-typed one.
    const opId = crockford(123_456_789, 26);
    await callback(
      `/internal/projects/${PROJECT}/edg/ops`,
      {
        baseRevision,
        ops: [
          {
            opId,
            type: "SetSegmentText",
            segmentId,
            script: "translated",
            text: "So today we talk about video",
          },
        ],
        clientOpIds: [opId],
      },
      attemptId,
    ).expect(200);

    await callback(
      `/internal/jobs/${target.jobId}/complete`,
      {
        status: "succeeded",
        result: {
          targetLanguage: "en",
          segmentsTranslated: 1,
          provider: "llm-translate-mock",
          lengthRetries: 0,
          truncated: 0,
          applied: true,
        },
      },
      attemptId,
    ).expect(200);

    const scripts = await request(app.getHttpServer())
      .get(`/projects/${PROJECT}/transcript/scripts`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .expect(200);
    const translated = (
      scripts.body.scripts as { script: string; available: boolean; language?: string }[]
    ).find((row) => row.script === "translated");
    expect(translated).toMatchObject({
      available: true,
      source: "translation",
      language: "en",
      provider: "llm-translate-mock",
    });

    const exported = await request(app.getHttpServer())
      .get(`/projects/${PROJECT}/transcript/export?format=srt&script=translated`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .expect(200);
    expect(exported.text).toContain("So today we talk about video");

    // The EDG document itself carries the override and the language tag.
    const after = await request(app.getHttpServer())
      .get(`/projects/${PROJECT}/edg`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .expect(200);
    expect(after.body.hot.meta.engineVersions.translationLanguage).toBe("en");
    const translatedSegment = (
      after.body.segments as { id: string; textOverrides?: Record<string, string> }[]
    ).find((segment) => segment.id === segmentId);
    expect(translatedSegment?.textOverrides?.["translated"]).toBe("So today we talk about video");
  });

  it("refuses translation below Starter and non-English translation below Creator", async () => {
    const free = await prisma.plan.upsert({
      where: { key: "free" },
      update: {},
      create: { id: id("PLNF"), key: "free", name: "Free", creditsPerMonthTenths: 200 },
    });
    const starter = await prisma.plan.upsert({
      where: { key: "starter" },
      update: {},
      create: { id: id("PLNS"), key: "starter", name: "Starter", creditsPerMonthTenths: 1_500 },
    });

    await prisma.subscription.updateMany({
      where: { workspaceId: WORKSPACE },
      data: { planId: free.id },
    });
    await request(app.getHttpServer())
      .post(`/projects/${PROJECT}/transcript/translate`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ targets: ["en"] })
      .expect(402)
      .expect((response) => {
        expect(response.body.error.code).toBe("transcript/plan_required");
      });

    await prisma.subscription.updateMany({
      where: { workspaceId: WORKSPACE },
      data: { planId: starter.id },
    });
    await request(app.getHttpServer())
      .post(`/projects/${PROJECT}/transcript/translate`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ targets: ["hi"] })
      .expect(402)
      .expect((response) => {
        expect(response.body.error.code).toBe("transcript/plan_required");
      });
  });
});
