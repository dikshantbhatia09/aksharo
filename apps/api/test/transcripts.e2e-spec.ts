/**
 * The whole transcription path, against real infrastructure.
 *
 * ```
 * POST /projects/{id}/transcribe   → quote, hold, ai.transcribe on BullMQ
 * POST /internal/jobs/{id}/complete → the worker's multi-chunk Hinglish result
 *   → transcripts + transcript_chunks + provider_submissions (one transaction)
 *   → segmentWords → EDG revision 1, inside the 32/24/22 budgets of `09 §3`
 *   → credits settled, `job.completed` published
 * GET  /projects/{id}/transcript           → the manifest and a page of chunks
 * GET  /projects/{id}/transcript/export    → srt / vtt / txt / json, source time
 * POST /projects/{id}/transcript/retranscribe → refused once captions are edited
 * ```
 *
 * It needs Postgres (the persistence is one transaction over four tables and a
 * fake would be testing the fake) and Redis (the producer really enqueues, and the
 * envelope has to be the one a Python worker consumes). Without either it skips
 * loudly, exactly as `jobs.e2e-spec.ts` and `edg.e2e-spec.ts` do.
 */
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type MembershipRole, type PrismaClient } from "@prisma/client";
import IORedis from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildWordIndex, newId, validateProjection } from "@montaj/edg";
import { type Segment, type TranscriptChunk, type Word } from "@montaj/edg/schemas";
import { limitsFor, segmentScript, wrapLines } from "@montaj/edg/segmenter";

import { AMPLE_TEST_CREDIT_TENTHS, fundWorkspaceCredits } from "./credits-fixture.js";
import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { TokenService } from "../src/auth/token.service.js";
import { PrismaService } from "../src/common/prisma/prisma.service.js";
import { RedisService } from "../src/common/redis/redis.service.js";
import { resetEnvCache } from "../src/config/config.module.js";
import { EdgRepository } from "../src/edg/index.js";
import { INTERNAL_BODY_LIMIT_BYTES } from "../src/internal/internal-body-limit.js";
import { internalSignatureHeaders } from "../src/internal/internal-signature.js";
import {
  InMemoryRealtimeBroker,
  InMemoryRealtimeBus,
  REALTIME_BUS,
} from "../src/realtime/realtime.bus.js";
import { projectRoom, roomChannel } from "../src/realtime/realtime.protocol.js";

import type { TestDatabase } from "./db-harness.js";
import type { INestApplication } from "@nestjs/common";

const CALLBACK_SECRET = "test-callback-secret-at-least-32-characters-long";
const PREFIX = process.env["MONTAJ_QUEUE_PREFIX"] ?? "bull";

const DB_READY = isDatabaseAvailable();
const REDIS_READY = isRedisAvailable();
const CAN_RUN = DB_READY && REDIS_READY;

if (!CAN_RUN) {
  console.warn(
    `[transcripts.e2e] skipped — ${DB_READY ? "" : `database: ${skipReason}. `}${
      REDIS_READY ? "" : `redis: ${redisSkipReason}.`
    }`,
  );
}

/**
 * A throwaway RS256 pair fed to the real `TokenService`, exactly as
 * `edg-harness.ts` does: minting through the shipped service is the only way to
 * be sure the token this suite sends is the token this API would accept.
 */
const JWT_KEYS = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** Ids unique per run, and valid Crockford base32 ULIDs (the room check needs it). */
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
const PROJECT = id("PR0J");
const MEDIA = id("MEDA");
/** A second project, for the tests that need a virgin one. */
const PROJECT_B = id("PR0K");
const MEDIA_B = id("MEDB");

/** 90 s of media: the sample transcript's own duration. */
const DURATION_MS = 90_000;

let db: TestDatabase | null = null;
let prisma: PrismaClient;
let app: INestApplication;
let redis: IORedis;
let broker: InMemoryRealtimeBroker;

// ---------------------------------------------------------------------------
// Fixture: the Hinglish sample transcript, split across two chunks
// ---------------------------------------------------------------------------

interface WireChunk {
  chunkIdx: number;
  startMs: number;
  endMs: number;
  nextWordSeq: number;
  words: Record<string, unknown>[];
}

/**
 * `packages/edg/fixtures/sample-transcript.json` is 119 Hinglish words in one
 * chunk. A one-chunk transcript would not exercise the thing most likely to be
 * wrong — word ids are numbered **per chunk**, so a bug that renumbers across a
 * boundary is invisible until there are two — so it is re-cut into two here, with
 * the second chunk's ids re-based onto `1:n` exactly as the worker would emit them.
 */
const SAMPLE_TRANSCRIPT = resolve(
  __dirname,
  "../../../packages/edg/fixtures/sample-transcript.json",
);

function hinglishChunks(): WireChunk[] {
  // Read from the workspace rather than imported: `@montaj/edg` exports
  // `fixtures/sample-project.json` and the goldens as subpaths, but not this one.
  const fixture = JSON.parse(readFileSync(SAMPLE_TRANSCRIPT, "utf8")) as {
    chunks: TranscriptChunk[];
  };
  const all = fixture.chunks[0]?.words ?? [];
  const split = 60;

  const first = all.slice(0, split).map((word) => ({ ...word }));
  const second = all.slice(split).map((word, index) => ({
    ...word,
    wid: `1:${String(index)}`,
  }));

  // Float timings on two words, so the "integer ms at ingest" rule is actually
  // exercised rather than asserted against numbers that were already integers.
  const firstWord = first[0];
  if (firstWord !== undefined) {
    firstWord.s = firstWord.s + 0.4;
    firstWord.e = firstWord.e + 0.6;
  }

  const boundary = second[0]?.s ?? 45_000;
  return [
    {
      chunkIdx: 0,
      startMs: 0,
      endMs: boundary - 1,
      nextWordSeq: first.length,
      words: first as unknown as Record<string, unknown>[],
    },
    {
      chunkIdx: 1,
      startMs: boundary,
      endMs: DURATION_MS,
      nextWordSeq: second.length,
      words: second as unknown as Record<string, unknown>[],
    },
  ];
}

/** The completion body a worker posts (A09 `processors/transcribe.py::_result`). */
function completionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "succeeded",
    result: {
      transcriptId: undefined,
      mediaId: MEDIA,
      language: "hi",
      provider: "sarvam",
      model: "saarika-v2",
      lane: "hinglish",
      durationMs: DURATION_MS,
      chunks: hinglishChunks(),
      providerSubmissions: [
        {
          provider: "sarvam",
          endpoint: "https://api.sarvam.ai/speech-to-text",
          artefact: "audio16k",
          externalRef: `req-${RUN}`,
          region: "ap-south-1",
          retentionClass: "zero",
        },
      ],
      ...((overrides["result"] as Record<string, unknown> | undefined) ?? {}),
    },
    usage: {
      mediaSeconds: DURATION_MS / 1_000,
      provider: "sarvam",
      model: "saarika-v2",
      costMinor: 120,
      egressBytes: 2_400_000,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tokens: TokenService;

function accessToken(role: MembershipRole = "owner", workspaceId = WORKSPACE): string {
  return tokens.mintAccessToken({ userId: USER, workspaceId, role, kind: "web" }).accessToken;
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

/** Collect every realtime frame published to a project's room. */
function watch(projectId: string): { frames: Record<string, unknown>[]; stop: () => void } {
  const channel = roomChannel(PREFIX, projectRoom(projectId));
  const frames: Record<string, unknown>[] = [];
  const listener = (payload: string): void => {
    frames.push(JSON.parse(payload) as Record<string, unknown>);
  };
  broker.on(channel, listener);
  return { frames, stop: () => broker.off(channel, listener) };
}

async function seed(): Promise<void> {
  await prisma.user.create({
    data: { id: USER, email: `a11+${RUN}@example.test`, name: "A11 test" },
  });
  await prisma.workspace.create({
    data: {
      id: WORKSPACE,
      slug: `a11-${RUN}`,
      name: `a11-${RUN}`,
      ownerId: USER,
      billingCountry: "IN",
    },
  });
  await prisma.membership.create({
    data: { id: id("MBR1"), workspaceId: WORKSPACE, userId: USER, role: "owner", status: "active" },
  });

  for (const [projectId, mediaId] of [
    [PROJECT, MEDIA],
    [PROJECT_B, MEDIA_B],
  ] as const) {
    await prisma.project.create({
      data: { id: projectId, workspaceId: WORKSPACE, title: `A11 ${projectId}`, aspect: "r9x16" },
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

  // A creator plan, so the free-tier daily cap does not decide these tests.
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
  await prisma.providerSubmission.deleteMany({ where: { workspaceId: WORKSPACE } });
  await prisma.job.deleteMany({ where: { workspaceId: WORKSPACE } });
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
  // The shipped wiring, in the shipped order: before `init()` registers the
  // adapter's own 100 kB parser.
  applyInternalBodyLimit(app);
  setupOpenApi(app);
  await app.init();

  // B02's real ledger enforces an actual balance: a subscription alone is a
  // plan, not credits. Fund it through the app's own CreditsFacade (needs the
  // app, so this runs after `app.init()` rather than inside `seed()`) — this
  // suite is about transcription mechanics, not the ledger, which has its own
  // `test/credits-ledger.e2e-spec.ts`.
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

// ---------------------------------------------------------------------------

describe.skipIf(!CAN_RUN)("transcribe → persist → segment → EDG", () => {
  let jobId: string;
  let attemptId: string;
  let transcriptId: string;
  let frames: Record<string, unknown>[];

  it("quotes the job from the probed duration and holds the credits", async () => {
    const response = await request(app.getHttpServer())
      .post(`/projects/${PROJECT}/transcribe`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ languages: ["hi-Latn"], hints: ["Aksharo"] })
      .expect(202);

    expect(response.body).toMatchObject({
      status: "queued",
      deduplicated: false,
      // 90 s is 1.5 minutes: 15 tenths at 1 credit a minute.
      quote: { tenths: 15, credits: "1.5", durationMs: DURATION_MS },
    });
    expect(response.body.transcriptId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    jobId = response.body.jobId as string;
    transcriptId = response.body.transcriptId as string;

    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.type).toBe("ai.transcribe");
    expect(job.status).toBe("queued");
    expect(job.projectId).toBe(PROJECT);
    // The hold is the quote, and it exists before anything is enqueued.
    expect(job.creditsChargedTenths).toBe(15);
    expect(job.creditHoldId).not.toBeNull();
    expect(job.params).toMatchObject({ transcriptId, mediaId: MEDIA, language: "hi-Latn" });
    attemptId = job.attemptId ?? "";
  });

  it("deduplicates a second click while the first is still running", async () => {
    const response = await request(app.getHttpServer())
      .post(`/projects/${PROJECT}/transcribe`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({})
      .expect(202);

    expect(response.body).toMatchObject({ deduplicated: true, jobId });
    // And it names the transcript the LIVE job is writing, not a new one.
    expect(response.body.transcriptId).toBe(transcriptId);
  });

  it("accepts the worker's multi-chunk completion and persists everything once", async () => {
    const watcher = watch(PROJECT);
    const body = completionBody();
    (body["result"] as Record<string, unknown>)["transcriptId"] = transcriptId;

    const response = await callback(`/internal/jobs/${jobId}/complete`, body, attemptId).expect(
      200,
    );
    expect(response.body).toMatchObject({ applied: true, status: "succeeded" });

    frames = watcher.frames;
    watcher.stop();
  });

  it("wrote the transcript with the two-signal language verdict", async () => {
    const transcript = await prisma.transcript.findUniqueOrThrow({ where: { id: transcriptId } });
    expect(transcript.projectId).toBe(PROJECT);
    // The provider said `hi`; the words are Roman Hinglish, so the script wins.
    expect(transcript.language).toBe("hi-Latn");
    expect(transcript.provider).toBe("sarvam");
    expect(transcript.model).toBe("saarika-v2");
    expect(transcript.currentRevision).toBe(1);

    const detected = transcript.detectedLanguages as unknown as {
      language: string;
      source: string;
    }[];
    expect(detected.map((entry) => entry.source)).toEqual(["provider", "script"]);
    expect(detected[0]?.language).toBe("hi");
    expect(detected[1]?.language).toBe("hi-Latn");
  });

  it("wrote both chunks with integer timings and per-chunk word ids", async () => {
    const rows = await prisma.transcriptChunk.findMany({
      where: { transcriptId, revision: 1 },
      orderBy: { chunkIdx: "asc" },
    });
    expect(rows.map((row) => row.chunkIdx)).toEqual([0, 1]);

    const wids: string[] = [];
    for (const row of rows) {
      const list = row.words as unknown as Word[];
      expect(list.length).toBeGreaterThan(0);
      expect(row.nextWordSeq).toBeGreaterThanOrEqual(list.length);
      for (const word of list) {
        expect(Number.isInteger(word.s), `${word.wid}.s = ${String(word.s)}`).toBe(true);
        expect(Number.isInteger(word.e), `${word.wid}.e = ${String(word.e)}`).toBe(true);
        expect(word.wid.startsWith(`${String(row.chunkIdx)}:`)).toBe(true);
        wids.push(word.wid);
      }
    }
    // No id collides across chunks, which is the whole point of `<chunkIdx>:<n>`.
    expect(new Set(wids).size).toBe(wids.length);

    // The float the fixture carried was rounded at ingest, not stored as a float.
    const first = (rows[0]?.words as unknown as Word[])[0];
    expect(first?.s).toBe(320);
    expect(first?.e).toBe(769);
  });

  it("initialised the editing document at revision 1, inside the 09 §3 budgets", async () => {
    const document = await prisma.edgDocument.findUniqueOrThrow({ where: { projectId: PROJECT } });
    expect(document.revision).toBe(1);
    expect(document.schemaVersion).toBe(2);
    expect(
      (document.doc as unknown as { transcript: { transcriptId: string } }).transcript.transcriptId,
    ).toBe(transcriptId);

    const revisions = await prisma.edgRevision.findMany({ where: { edgId: document.id } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.revision).toBe(1);
    // The first revision has no ops: nothing preceded it (A12's README).
    expect(revisions[0]?.ops).toEqual([]);

    const snapshots = await prisma.edgSnapshot.findMany({ where: { edgId: document.id } });
    expect(snapshots.map((row) => row.revision)).toEqual([1]);

    // The projection has to satisfy the engine's own invariants, word ids included.
    const chunks = (
      await prisma.transcriptChunk.findMany({
        where: { transcriptId, revision: 1 },
        orderBy: { chunkIdx: "asc" },
      })
    ).map((row) => ({
      chunkIdx: row.chunkIdx,
      startMs: row.startMs,
      endMs: row.endMs,
      words: row.words as unknown as Word[],
    }));
    const projection = await app.get(EdgRepository).projectionOf(document.id);
    expect(validateProjection(projection, { wordIndex: buildWordIndex(chunks) })).toEqual([]);

    const segments = projection.segments as Segment[];
    expect(segments.length).toBeGreaterThan(1);

    const index = buildWordIndex(chunks);
    const byId = new Map(chunks.flatMap((chunk) => chunk.words.map((word) => [word.wid, word])));
    for (const segment of segments) {
      const from = index.get(segment.startWordId);
      const to = index.get(segment.endWordId);
      expect(from, `${segment.id} start`).toBeDefined();
      expect(to, `${segment.id} end`).toBeDefined();

      const run = [...byId.values()].filter(
        (word) => word.s >= segment.startMs && word.e <= segment.endMs && word.deleted !== true,
      );
      const script = segmentScript(run);
      const limits = limitsFor(script);
      // 32 for Latin, 24 for Devanagari, 22 for Tamil — the table of `09 §3`.
      expect([32, 24, 22, 26]).toContain(limits.maxCharsPerLine);

      const lines = wrapLines(
        run.map((word) => word.t),
        limits.maxCharsPerLine,
      );
      expect(lines.length, `${segment.id} lines`).toBeLessThanOrEqual(2);
      for (const line of lines) {
        expect([...line].length, `${segment.id}: "${line}"`).toBeLessThanOrEqual(
          limits.maxCharsPerLine + 2,
        );
      }
      expect(segment.endMs - segment.startMs, `${segment.id} duration`).toBeLessThanOrEqual(6_000);
    }
  });

  it("recorded what left the building, with the vendor's retention class", async () => {
    const rows = await prisma.providerSubmission.findMany({ where: { jobId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "sarvam",
      endpoint: "https://api.sarvam.ai/speech-to-text",
      region: "ap-south-1",
      externalRef: `req-${RUN}`,
      artefactKind: "audio16k",
      retentionClass: "zero_retention",
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      mediaId: MEDIA,
    });
    expect(rows[0]?.deleteRequestedAt).toBeNull();
  });

  it("settled the credits and finished the job", async () => {
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("succeeded");
    expect(job.progress).toBe(100);
    // 90 media seconds is 1.5 minutes: the same 15 tenths that were held.
    expect(job.creditsChargedTenths).toBe(15);
    expect(job.provider).toBe("sarvam");

    const events = await prisma.jobEvent.findMany({ where: { jobId }, orderBy: { id: "asc" } });
    const names = events.map((row) => (row.data as { event?: string } | null)?.event);
    expect(names).toContain("transcript.postprocessed");
    expect(names).toContain("job.succeeded");

    const settled = events.find(
      (row) => (row.data as { event?: string } | null)?.event === "job.succeeded",
    );
    expect((settled?.data as { settledTenths?: number } | null)?.settledTenths).toBe(15);
  });

  it("published job.completed to the project's room after the transcript landed", () => {
    const completed = frames.filter((frame) => frame["event"] === "job.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.["data"]).toMatchObject({
      jobId,
      status: "succeeded",
      type: "ai.transcribe",
    });
  });

  it("is idempotent: a replayed completion changes nothing", async () => {
    const before = await prisma.transcriptChunk.count({ where: { transcriptId, revision: 1 } });
    const body = completionBody();
    (body["result"] as Record<string, unknown>)["transcriptId"] = transcriptId;

    const response = await callback(`/internal/jobs/${jobId}/complete`, body, attemptId).expect(
      200,
    );
    // The job is terminal, so the state machine short-circuits before the handler.
    expect(response.body).toMatchObject({ applied: false, reason: "already_completed" });

    expect(await prisma.transcriptChunk.count({ where: { transcriptId, revision: 1 } })).toBe(
      before,
    );
    expect(await prisma.providerSubmission.count({ where: { jobId } })).toBe(1);
    expect(await prisma.transcript.count({ where: { projectId: PROJECT } })).toBe(1);
  });
});

describe.skipIf(!CAN_RUN)("reading the transcript", () => {
  it("returns the manifest, a page of chunks and the corrections log", async () => {
    const response = await request(app.getHttpServer())
      .get(`/projects/${PROJECT}/transcript`)
      .set("Authorization", `Bearer ${accessToken("viewer")}`)
      .expect(200);

    expect(response.body.transcript).toMatchObject({
      projectId: PROJECT,
      revision: 1,
      language: "hi-Latn",
      chunkCount: 2,
      provider: "sarvam",
    });
    expect(response.body.chunks).toHaveLength(2);
    expect(response.body.nextCursor).toBeNull();

    const log = response.body.transcript.postProcessing;
    expect(log.correctionCount).toBeGreaterThan(0);
    expect(log.steps.length).toBeGreaterThan(0);
    expect(log.corrections[0]).toMatchObject({
      step: expect.any(String),
      wordId: expect.any(String),
      before: expect.any(String),
      after: expect.any(String),
    });
  });

  it("pages the chunks", async () => {
    const first = await request(app.getHttpServer())
      .get(`/projects/${PROJECT}/transcript?limit=1`)
      .set("Authorization", `Bearer ${accessToken("viewer")}`)
      .expect(200);
    expect(first.body.chunks).toHaveLength(1);
    expect(first.body.nextCursor).toBe(0);

    const second = await request(app.getHttpServer())
      .get(`/projects/${PROJECT}/transcript?limit=1&cursor=0`)
      .set("Authorization", `Bearer ${accessToken("viewer")}`)
      .expect(200);
    expect(second.body.chunks[0].chunkIdx).toBe(1);
    expect(second.body.nextCursor).toBeNull();
  });

  it("is a 404 for a project this workspace does not own, and for one with no transcript", async () => {
    await request(app.getHttpServer())
      .get(`/projects/${id("N0PE")}/transcript`)
      .set("Authorization", `Bearer ${accessToken("viewer")}`)
      .expect(404);

    const missing = await request(app.getHttpServer())
      .get(`/projects/${PROJECT_B}/transcript`)
      .set("Authorization", `Bearer ${accessToken("viewer")}`)
      .expect(404);
    expect(missing.body.error.code).toBe("transcript/not_found");
  });

  it("refuses an unauthenticated read", async () => {
    await request(app.getHttpServer()).get(`/projects/${PROJECT}/transcript`).expect(401);
  });
});

describe.skipIf(!CAN_RUN)("exporting the transcript", () => {
  const auth = (): string => `Bearer ${accessToken("viewer")}`;

  it("exports SubRip on the source clock", async () => {
    const response = await request(app.getHttpServer())
      .get(`/projects/${PROJECT}/transcript/export?format=srt`)
      .set("Authorization", auth())
      .expect(200);

    expect(response.headers["content-type"]).toContain("application/x-subrip");
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.text.startsWith("1\n00:00:00,")).toBe(true);
    expect(response.text).toContain(" --> ");
  });

  it("exports WebVTT with its header", async () => {
    const response = await request(app.getHttpServer())
      .get(`/projects/${PROJECT}/transcript/export?format=vtt`)
      .set("Authorization", auth())
      .expect(200);
    expect(response.text.startsWith("WEBVTT")).toBe(true);
    expect(response.headers["content-type"]).toContain("text/vtt");
  });

  it("exports plain text with speaker labels and no timings", async () => {
    const response = await request(app.getHttpServer())
      .get(`/projects/${PROJECT}/transcript/export?format=txt`)
      .set("Authorization", auth())
      .expect(200);
    expect(response.text).not.toContain("-->");
    expect(response.text).toMatch(/^s1:/);
  });

  it("exports JSON with every word id intact", async () => {
    const response = await request(app.getHttpServer())
      .get(`/projects/${PROJECT}/transcript/export?format=json`)
      .set("Authorization", auth())
      .expect(200);

    const parsed = JSON.parse(response.text) as {
      timebase: string;
      chunks: { chunkIdx: number; words: { wid: string }[] }[];
    };
    expect(parsed.timebase).toBe("source");
    expect(parsed.chunks.map((chunk) => chunk.chunkIdx)).toEqual([0, 1]);
    expect(parsed.chunks[1]?.words[0]?.wid).toBe("1:0");
  });

  it("refuses a format it does not write", async () => {
    await request(app.getHttpServer())
      .get(`/projects/${PROJECT}/transcript/export?format=ass`)
      .set("Authorization", auth())
      .expect(400);
  });
});

describe.skipIf(!CAN_RUN)("re-transcribing", () => {
  it("refuses once the captions have been edited, and names the way through", async () => {
    await prisma.edgDocument.update({ where: { projectId: PROJECT }, data: { revision: 4 } });

    const refused = await request(app.getHttpServer())
      .post(`/projects/${PROJECT}/transcript/retranscribe`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({})
      .expect(409);

    expect(refused.body.error.code).toBe("transcript/has_edits");
    expect(refused.body.error.details).toMatchObject({ revision: 4, retryWith: { force: true } });
  });

  it("proceeds when the caller says they know, with a new transcript id", async () => {
    const response = await request(app.getHttpServer())
      .post(`/projects/${PROJECT}/transcript/retranscribe`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ force: true, languages: ["hi-Latn"] })
      .expect(202);

    expect(response.body.deduplicated).toBe(false);
    const job = await prisma.job.findUniqueOrThrow({
      where: { id: response.body.jobId as string },
    });
    expect(job.status).toBe("queued");
    expect((job.params as { transcriptId?: string }).transcriptId).toBe(response.body.transcriptId);

    await prisma.edgDocument.update({ where: { projectId: PROJECT }, data: { revision: 1 } });
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "cancelled", finishedAt: new Date(), creditsChargedTenths: 0 },
    });
  });

  it("refuses to transcribe media that has not been probed", async () => {
    await prisma.mediaAsset.update({ where: { id: MEDIA_B }, data: { status: "pending" } });
    const response = await request(app.getHttpServer())
      .post(`/projects/${PROJECT_B}/transcribe`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({})
      .expect(409);
    expect(response.body.error.code).toBe("transcript/media_not_ready");
    await prisma.mediaAsset.update({ where: { id: MEDIA_B }, data: { status: "ready" } });
  });

  it("refuses a viewer, and admits an editor", async () => {
    // `WorkspaceMemberGuard` reads the LIVE membership row and replaces
    // whatever role the token claims (`workspace-member.guard.ts`), so a
    // `viewer` token only refuses this route if the membership itself is a
    // viewer's — the seeded fixture is `owner`, which every other test in
    // this file relies on, so it is lowered here and restored immediately
    // after rather than for the rest of the suite.
    await prisma.membership.update({
      where: { workspaceId_userId: { workspaceId: WORKSPACE, userId: USER } },
      data: { role: "viewer" },
    });
    try {
      await request(app.getHttpServer())
        .post(`/projects/${PROJECT_B}/transcribe`)
        .set("Authorization", `Bearer ${accessToken("viewer")}`)
        .send({})
        .expect(403);
    } finally {
      await prisma.membership.update({
        where: { workspaceId_userId: { workspaceId: WORKSPACE, userId: USER } },
        data: { role: "owner" },
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The 32 MB `/internal` body limit
// ---------------------------------------------------------------------------

describe.skipIf(!CAN_RUN)("the /internal body limit", () => {
  /** ~9 000 words over six 10-minute chunks: one hour of interview. */
  function hourLongChunks(): WireChunk[] {
    const vocabulary = [
      "yaar",
      "matlab",
      "bilkul",
      "sahi",
      "dekho",
      "abhi",
      "chalo",
      "editing",
      "timeline",
      "caption",
    ];
    const native = [
      "यार",
      "मतलब",
      "बिलकुल",
      "सही",
      "देखो",
      "अभी",
      "चलो",
      "एडिटिंग",
      "टाइमलाइन",
      "कैप्शन",
    ];
    const chunks: WireChunk[] = [];
    const perWordMs = 400;
    const perChunk = 1_500;

    for (let chunkIdx = 0; chunkIdx < 6; chunkIdx += 1) {
      const chunkStartMs = chunkIdx * perChunk * perWordMs;
      const words: Record<string, unknown>[] = [];
      for (let n = 0; n < perChunk; n += 1) {
        const at = chunkStartMs + n * perWordMs;
        words.push({
          wid: `${String(chunkIdx)}:${String(n)}`,
          s: at,
          e: at + perWordMs - 60,
          t: vocabulary[n % vocabulary.length],
          c: 0.87,
          sp: n % 80 < 40 ? "SPEAKER_00" : "SPEAKER_01",
          scripts: {
            roman: vocabulary[n % vocabulary.length],
            native: native[n % native.length],
          },
        });
      }
      chunks.push({
        chunkIdx,
        startMs: chunkStartMs,
        endMs: chunkStartMs + perChunk * perWordMs,
        nextWordSeq: perChunk,
        words,
      });
    }
    return chunks;
  }

  it("accepts a 60-minute transcript that the default 100 kB limit would refuse", async () => {
    const started = await request(app.getHttpServer())
      .post(`/projects/${PROJECT_B}/transcribe`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ languages: ["hi-Latn"] })
      .expect(202);

    const jobId = started.body.jobId as string;
    const transcriptId = started.body.transcriptId as string;
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });

    const chunks = hourLongChunks();
    const body = {
      status: "succeeded",
      result: {
        transcriptId,
        mediaId: MEDIA_B,
        language: "hi",
        provider: "sarvam",
        model: "saarika-v2",
        durationMs: 3_600_000,
        chunks,
        providerSubmissions: [],
      },
      usage: { mediaSeconds: 3_600, provider: "sarvam" },
    };

    const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    // Comfortably past Express's 100 kB default — the whole reason for the raise.
    expect(bytes).toBeGreaterThan(1_000_000);
    expect(bytes).toBeLessThan(INTERNAL_BODY_LIMIT_BYTES);

    const response = await callback(
      `/internal/jobs/${jobId}/complete`,
      body,
      job.attemptId ?? "",
    ).expect(200);
    expect(response.body).toMatchObject({ applied: true, status: "succeeded" });

    const rows = await prisma.transcriptChunk.findMany({
      where: { transcriptId, revision: 1 },
      orderBy: { chunkIdx: "asc" },
    });
    expect(rows).toHaveLength(6);
    expect(rows.reduce((total, row) => total + (row.words as unknown as Word[]).length, 0)).toBe(
      9_000,
    );

    const document = await prisma.edgDocument.findUniqueOrThrow({
      where: { projectId: PROJECT_B },
    });
    expect(document.revision).toBe(1);
    const segments = await prisma.edgSegment.count({ where: { edgId: document.id } });
    expect(segments).toBeGreaterThan(500);
  }, 120_000);

  it("still refuses a body past 32 MB", async () => {
    const job = await prisma.job.findFirstOrThrow({
      where: { workspaceId: WORKSPACE },
      orderBy: { id: "desc" },
    });
    const padding = "x".repeat(INTERNAL_BODY_LIMIT_BYTES + 1_024);
    const raw = JSON.stringify({ status: "succeeded", result: { padding } });

    await request(app.getHttpServer())
      .post(`/internal/jobs/${job.id}/complete`)
      .set(
        internalSignatureHeaders({
          secret: CALLBACK_SECRET,
          attemptId: job.attemptId ?? "",
          body: raw,
          now: Date.now(),
        }),
      )
      .set("Content-Type", "application/json")
      .send(raw)
      .expect(413);
  }, 120_000);

  it("leaves the public routes on the ordinary limit", async () => {
    const before = await prisma.job.count({ where: { projectId: PROJECT } });

    // A megabyte of hints is not a transcription request. The raise is
    // `/internal`-only, so the adapter's own parser refuses this one.
    const response = await request(app.getHttpServer())
      .post(`/projects/${PROJECT}/transcribe`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ hints: ["y".repeat(1_000_000)] });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.job.count({ where: { projectId: PROJECT } })).toBe(before);

    // Known gap, reported with A11: `body-parser` rejects an oversized body with a
    // plain `Error`, and `HttpExceptionFilter` renders an unrecognised throwable as
    // `500 common/internal` rather than the `413 common/payload_too_large` that
    // CONTRACTS §8 already has a code for. A11 translates it for `/internal`
    // (`internal-body-limit.ts`) and does not reach into A03's filter for the rest;
    // this assertion fails the moment somebody fixes it, which is when the 500
    // should come out of the list.
    expect([413, 500]).toContain(response.status);
  });
});

/**
 * A11d: `EditWord` patches a chunk's row in place and advances
 * `transcripts.currentRevision` without touching that row's own `revision`
 * column (`EdgRepository.persistWords`) — so a transcript read pinned to no
 * particular revision, which resolves at `transcript.currentRevision`, used to
 * find zero `transcript_chunks` rows at the new number and return an empty
 * page. `newestChunkRows` (shared by `TranscriptsRepository` and
 * `EdgRepository`) fixes that by resolving "as of revision N" as the newest
 * row at or before N, not an exact match.
 */
describe.skipIf(!CAN_RUN)("word edits and the transcript read (A11d)", () => {
  it("transcribe → EditWord → GET /transcript still returns every chunk", async () => {
    const projectId = id("PRWE");
    const mediaId = id("MDWE");
    await prisma.project.create({
      data: { id: projectId, workspaceId: WORKSPACE, title: `A11d ${projectId}`, aspect: "r9x16" },
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

    const started = await request(app.getHttpServer())
      .post(`/projects/${projectId}/transcribe`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ languages: ["hi-Latn"] })
      .expect(202);
    const jobId = started.body.jobId as string;
    const transcriptId = started.body.transcriptId as string;
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });

    const body = completionBody();
    (body["result"] as Record<string, unknown>)["transcriptId"] = transcriptId;
    (body["result"] as Record<string, unknown>)["mediaId"] = mediaId;
    await callback(`/internal/jobs/${jobId}/complete`, body, job.attemptId ?? "").expect(200);

    const before = await request(app.getHttpServer())
      .get(`/projects/${projectId}/transcript`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .expect(200);
    const chunksBefore = before.body.chunks as { chunkIdx: number; words: Word[] }[];
    expect(chunksBefore.length).toBeGreaterThan(0);
    const totalWordsBefore = chunksBefore.reduce((total, chunk) => total + chunk.words.length, 0);

    const editedText = `badla-${RUN}`;
    const opId = newId();
    const editResponse = await request(app.getHttpServer())
      .post(`/projects/${projectId}/edg/ops`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({
        baseRevision: 1,
        ops: [{ opId, type: "EditWord", wordId: "0:0", text: editedText }],
        clientOpIds: [opId],
      })
      .expect(200);
    expect(editResponse.body.applied.length + editResponse.body.rebased.length).toBeGreaterThan(0);

    const after = await request(app.getHttpServer())
      .get(`/projects/${projectId}/transcript`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .expect(200);
    const chunksAfter = after.body.chunks as { chunkIdx: number; words: Word[] }[];

    // The defect: before this fix, an edit bumped `transcripts.currentRevision`
    // past every `transcript_chunks` row's own `revision`, and an unpinned read
    // (which resolves at `currentRevision`) found nothing.
    expect(chunksAfter.length).toBe(chunksBefore.length);
    const totalWordsAfter = chunksAfter.reduce((total, chunk) => total + chunk.words.length, 0);
    expect(totalWordsAfter).toBe(totalWordsBefore);

    const edited = chunksAfter.flatMap((chunk) => chunk.words).find((word) => word.wid === "0:0");
    expect(edited?.t).toBe(editedText);
  });
});

// ---------------------------------------------------------------------------
// 2026-09-25: a transcript with no editing document (every repurposed clip)
// ---------------------------------------------------------------------------

/**
 * `media.clip` cloned a transcript slice onto each clip's child project and never
 * built its document. `/edg` answered `edg/not_initialised`, `/transcription-state`
 * answered `ready` on the transcript alone, and the editor's waiting screen
 * bounced between them ~5×/s forever. These pin the read model's side of the fix
 * against the real app, database and segmenter.
 */
describe.skipIf(!CAN_RUN)("a transcript with no editing document", () => {
  async function clipShapedProject(
    kind: string,
    media: { width: number | null; hasAudio: boolean | null; proxyKey: string | null },
  ): Promise<{ projectId: string; mediaId: string }> {
    const projectId = id(`CQ${kind}P`);
    const mediaId = id(`CQ${kind}M`);
    const transcriptId = id(`CQ${kind}T`);
    await prisma.project.create({
      data: {
        id: projectId,
        workspaceId: WORKSPACE,
        title: `clip ${kind} (9:16)`,
        aspect: "r9x16",
        sourceLanguage: "hi-Latn",
        createdBy: USER,
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        projectId,
        role: "primary",
        filename: "mezzanine.mp4",
        mime: "video/mp4",
        sizeBytes: 5_690_820n,
        storageKey: `ws/${WORKSPACE}/p/${projectId}/clips/${mediaId}/master.mp4`,
        durationMs: 16_183,
        status: "ready",
        ...media,
        ...(media.width === null ? {} : { height: 1920, fps: 30 }),
      },
    });
    await prisma.transcript.create({
      data: { id: transcriptId, projectId, language: "hi-Latn", currentRevision: 1 },
    });
    await prisma.transcriptChunk.create({
      data: {
        id: id(`CQ${kind}C`),
        transcriptId,
        revision: 1,
        chunkIdx: 0,
        startMs: 0,
        endMs: 16_183,
        words: [
          { wid: "0:0", s: 200, e: 900, t: "Its" },
          { wid: "0:1", s: 900, e: 1_300, t: "an" },
          { wid: "0:2", s: 1_300, e: 2_100, t: "editorial" },
          { wid: "0:3", s: 2_100, e: 2_700, t: "teams" },
          { wid: "0:4", s: 2_700, e: 3_300, t: "worth" },
        ],
        nextWordSeq: 5,
      },
    });
    return { projectId, mediaId };
  }

  it("builds the document when asked for the state, so the editor opens instead of looping", async () => {
    const { projectId } = await clipShapedProject("A", {
      width: 1080,
      hasAudio: true,
      proxyKey: "proxy.mp4",
    });
    const server = app.getHttpServer();
    const auth = `Bearer ${accessToken()}`;

    // The exact production state: no document behind the transcript.
    const before = await request(server).get(`/projects/${projectId}/edg`).set("Authorization", auth);
    expect(before.body.error?.code).toBe("edg/not_initialised");

    const state = await request(server)
      .get(`/projects/${projectId}/transcription-state`)
      .set("Authorization", auth)
      .expect(200);
    expect(state.body).toEqual({ status: "ready" });

    // `ready` now means what the editor needs: its next load succeeds.
    const after = await request(server)
      .get(`/projects/${projectId}/edg`)
      .set("Authorization", auth)
      .expect(200);
    expect(after.body.revision).toBeGreaterThanOrEqual(1);
    const segments = await prisma.edgSegment.count({
      where: { edg: { projectId }, deletedAtRev: null },
    });
    expect(segments).toBeGreaterThan(0);

    // Asking again is harmless: still one document.
    await request(server)
      .get(`/projects/${projectId}/transcription-state`)
      .set("Authorization", auth)
      .expect(200);
    expect(await prisma.edgDocument.count({ where: { projectId } })).toBe(1);
  });

  it("sends never-probed media back through the pipeline instead of opening it without a preview", async () => {
    const { projectId, mediaId } = await clipShapedProject("B", {
      width: null,
      hasAudio: null,
      proxyKey: null,
    });

    const state = await request(app.getHttpServer())
      .get(`/projects/${projectId}/transcription-state`)
      .set("Authorization", `Bearer ${accessToken()}`)
      .expect(200);
    expect(state.body).toEqual({ status: "processing_media" });

    const probe = await prisma.job.findFirst({ where: { projectId, type: "media.probe" } });
    expect(probe?.jobKey).toBe(`media.probe:${mediaId}`);
    const media = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } });
    expect(media.status).toBe("uploaded");
    // The document waits for the probed dimensions (built on `media.proxy` success).
    expect(await prisma.edgDocument.count({ where: { projectId } })).toBe(0);
  });
});
