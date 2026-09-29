/**
 * Dubbing (2026-10-04) against a real PostgreSQL and a real Redis.
 *
 * `RepurposeDubsService` and its two completion handlers are driven directly,
 * as the compilations suite drives its service: the claims worth proving here
 * are the migration (`clip_dubs`, `clip_dub_variants`, `jobs.checkpoint`), the
 * consent and money on the dub row, the transcript a dubbed shape is given in
 * one transaction, and the day's rupee budget - whose reserve is a Lua script,
 * run here on a real Redis in this suite's own key space. The queue, the audit
 * sink, the project and media services and the object store are stood in for;
 * the store is in memory, so nothing here reaches the object store the
 * environment names.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";
import { AiDubPayloadSchema, MediaDubPayloadSchema } from "@montaj/repurpose-contracts";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { RedisService } from "../src/common/redis/redis.service.js";
import { DubBudget } from "../src/repurpose/dubbing/dub-budget.js";
import { RepurposeDubCompletionHandler } from "../src/repurpose/dubbing/dub-completion.handler.js";
import { RepurposeDubMuxCompletionHandler } from "../src/repurpose/dubbing/dub-mux-completion.handler.js";
import { dubCostTenths, dubVendorPaise } from "../src/repurpose/dubbing/dub-pricing.js";
import { DUB_ERRORS } from "../src/repurpose/dubbing/dubs.constants.js";
import { RepurposeDubsService } from "../src/repurpose/dubbing/dubs.service.js";

import type { TestDatabase } from "./db-harness.js";
import type { JobCompletionContext } from "../src/jobs/completion-handlers.js";
import type { Job, PrismaClient } from "@prisma/client";

const available = isDatabaseAvailable() && isRedisAvailable();
if (!available) {
  console.warn(
    `[repurpose-dubs.e2e] SKIPPED - ${skipReason || redisSkipReason || "no test infrastructure"}`,
  );
}

const ULID_BASE = "01JT0000000000000000000000";
function id(suffix: string): string {
  return (ULID_BASE.slice(0, 26 - suffix.length) + suffix).toUpperCase();
}

const USER = id("U1");
const WS = id("W1");
const OTHER_USER = id("U2");
const OTHER_WS = id("W2");
const SOURCE = id("P1");
const RUN = id("R1");
const CANDIDATE = id("C1");
const CLIP = id("K1");
const CLIP_PROJECT = id("KP1");
const CLIP_FOLDER = `ws/${WS}/p/${SOURCE}/repurpose/${RUN}/clips/${CANDIDATE}`;
const SRT =
  "1\n00:00:00,000 --> 00:00:02,000\nनमस्ते दोस्तों\n\n2\n00:00:02,200 --> 00:00:04,000\nआज की बात\n";

let db: TestDatabase;
let prisma: PrismaClient;
let redis: RedisService;
let budget: DubBudget;
let jobSeq = 0;
const objects = new Map<string, Buffer>();

/** The queue, standing in: every enqueue is a real `jobs` row. */
function fakeJobs() {
  return {
    enqueue: async (input: {
      type: string;
      workspaceId: string;
      projectId?: string | null;
      params?: Record<string, unknown>;
      jobKey: string;
    }): Promise<{ job: Job; deduplicated: boolean }> => {
      jobSeq += 1;
      const job = await prisma.job.create({
        data: {
          id: id(`J${String(jobSeq)}`),
          workspaceId: input.workspaceId,
          projectId: input.projectId ?? null,
          type: input.type,
          params: (input.params ?? {}) as object,
          jobKey: input.jobKey,
        },
      });
      return { job, deduplicated: false };
    },
    cancel: async (jobId: string) =>
      prisma.job.update({ where: { id: jobId }, data: { status: "cancelled" } }),
  };
}

const store = {
  kind: "r2" as const,
  presignGet: async (key: string) => `https://files.test/${key}`,
  head: async (key: string) =>
    objects.has(key) ? { sizeBytes: objects.get(key)?.length ?? 0, contentType: null } : null,
  get: async (key: string) => objects.get(key) ?? Buffer.alloc(0),
  put: async (input: { key: string; body: Buffer }) => {
    objects.set(`raw:${input.key}`, input.body);
  },
};

function service(): RepurposeDubsService {
  return new RepurposeDubsService(
    prisma as never,
    fakeJobs() as never,
    {} as never,
    { record: async () => undefined } as never,
    budget,
    { FEATURE_FLAGS_JSON: { repurpose_flow: true, repurpose_dubbing: true } } as unknown as Env,
    store as never,
  );
}

describe.skipIf(!available)("dubbing against PostgreSQL and Redis (2026-10-04)", () => {
  beforeAll(async () => {
    const created = await createTestDatabase();
    if (created === null) throw new Error(`no test database: ${skipReason}`);
    db = created;
    prisma = db.prisma;
    redis = new RedisService({ REDIS_URL: testRedisUrl() } as unknown as Env);
    budget = new DubBudget(redis);
    budget.capPaise = () => 50_000;

    await prisma.user.create({ data: { id: USER, email: "dub-a@example.test", name: "A" } });
    await prisma.user.create({ data: { id: OTHER_USER, email: "dub-b@example.test", name: "B" } });
    await prisma.workspace.create({
      data: { id: WS, slug: "dub-a", name: "A", ownerId: USER, billingCountry: "IN" },
    });
    await prisma.workspace.create({
      data: { id: OTHER_WS, slug: "dub-b", name: "B", ownerId: OTHER_USER, billingCountry: "IN" },
    });
    await prisma.creditAccount.create({
      data: { id: id("CA1"), workspaceId: WS, balanceTenths: 10_000 },
    });
    await prisma.project.create({ data: { id: SOURCE, workspaceId: WS, title: "Podcast" } });
    await prisma.repurposeRun.create({
      data: {
        id: RUN,
        workspaceId: WS,
        sourceProjectId: SOURCE,
        sourceKind: "upload",
        mode: "ai",
        status: "review_ready",
        createdBy: USER,
        config: { sourceLanguage: "auto" },
      },
    });
    await prisma.clipCandidate.create({
      data: {
        id: CANDIDATE,
        runId: RUN,
        source: "ai",
        rank: 1,
        startMs: 10_000,
        endMs: 44_000,
        title: "The turbulence story",
      },
    });
    await prisma.repurposeClip.create({
      data: {
        id: CLIP,
        runId: RUN,
        candidateId: CANDIDATE,
        title: "The turbulence story",
        sourceStartMs: 10_000,
        sourceEndMs: 44_000,
        mezzanineKey: `${CLIP_FOLDER}/master.mp4`,
        mezzanineDurationMs: 34_000,
      },
    });
    await prisma.project.create({
      data: { id: CLIP_PROJECT, workspaceId: WS, title: "Clip (9:16)", sourceLanguage: "en" },
    });
    await prisma.mediaAsset.create({
      data: {
        id: id("KM1"),
        projectId: CLIP_PROJECT,
        filename: "mezzanine.mp4",
        mime: "video/mp4",
        storageKey: `${CLIP_FOLDER}/master.mp4`,
        durationMs: 34_000,
        status: "ready",
        role: "primary",
      },
    });
    await prisma.transcript.create({
      data: { id: id("KT1"), projectId: CLIP_PROJECT, language: "en", currentRevision: 1 },
    });
    await prisma.clipVariant.create({
      data: {
        id: id("KV1"),
        clipId: CLIP,
        projectId: CLIP_PROJECT,
        aspect: "r9x16",
        status: "ready",
        captionConfig: { styleId: "punch-pop", styleVersion: 1 },
      },
    });
  });

  afterAll(async () => {
    redis?.client.disconnect();
    await db?.stop();
  });

  let dubId: string;

  it("records the dub, its consent and its money, and asks for one vendor job", async () => {
    const { dub, created } = await service().create(WS, USER, RUN, CLIP, {
      languages: ["hi-IN", "ta-IN"],
      consent: true,
    });
    dubId = dub.id;
    expect(created).toBe(true);
    expect(dub.status).toBe("dubbing");

    const row = await prisma.clipDub.findUniqueOrThrow({ where: { id: dub.id } });
    expect(row).toMatchObject({
      sourceLanguage: "en-IN",
      languages: ["hi-IN", "ta-IN"],
      consentBy: USER,
      costTenths: dubCostTenths(34_000, 2),
      budgetPaise: dubVendorPaise(34_000, 2),
      attempts: 1,
    });
    expect(row.consentAt).toBeInstanceOf(Date);
    const job = await prisma.job.findUniqueOrThrow({ where: { id: row.jobId ?? "" } });
    expect(job.type).toBe("ai.dub");
    expect(AiDubPayloadSchema.parse(job.params)).toMatchObject({
      targetLanguages: ["hi-IN", "ta-IN"],
    });

    // The day's tally, on the real Redis, holds exactly this request's rupees.
    const spent = await redis.client.get(
      `${process.env["MONTAJ_REDIS_PREFIX"] ?? "montaj"}:dub:spend:v1:${row.budgetDay ?? ""}`,
    );
    expect(Number(spent)).toBe(dubVendorPaise(34_000, 2));
  });

  it("keeps the vendor's job id a worker wrote on its job", async () => {
    const row = await prisma.clipDub.findUniqueOrThrow({ where: { id: dubId } });
    await prisma.job.update({
      where: { id: row.jobId ?? "" },
      data: { checkpoint: { vendorJobId: "vendor-1", vendorPhase: "started" } },
    });
    const job = await prisma.job.findUniqueOrThrow({ where: { id: row.jobId ?? "" } });
    expect(job.checkpoint).toEqual({ vendorJobId: "vendor-1", vendorPhase: "started" });
  });

  it("files the vendor's files, settles on the languages back, and lays them under the clip", async () => {
    const row = await prisma.clipDub.findUniqueOrThrow({ where: { id: dubId } });
    const job = await prisma.job.findUniqueOrThrow({ where: { id: row.jobId ?? "" } });
    const folder = `ws/${WS}/p/${SOURCE}/repurpose/${RUN}/dubs/${dubId}`;
    objects.set(`${folder}/hi-IN/captions.srt`, Buffer.from(SRT, "utf8"));
    const dubs = service();
    const handler = new RepurposeDubCompletionHandler(dubs, { register: () => undefined } as never);
    const outcome = await handler.handle({
      job,
      attemptId: id("AT1"),
      result: {
        schemaVersion: 1,
        action: "dub",
        dubId,
        vendorJobId: "vendor-1",
        vendorStatus: "partial_failure",
        tracks: [
          {
            language: "hi-IN",
            status: "ready",
            audio: { key: `${folder}/hi-IN/audio.mp3`, contentType: "audio/mpeg", sizeBytes: 1000 },
            captions: { key: `${folder}/hi-IN/captions.srt`, sizeBytes: SRT.length },
          },
          { language: "ta-IN", status: "failed", reason: "Sarvam did not dub this language." },
        ],
      },
      usage: undefined,
      completion: { status: "succeeded" },
    } as JobCompletionContext);
    expect(outcome.actualTenths).toBe(dubCostTenths(34_000, 1));

    await dubs.reconcileDubSoon(dubId);
    const after = await prisma.clipDub.findUniqueOrThrow({ where: { id: dubId } });
    expect(after).toMatchObject({ status: "making", vendorJobId: "vendor-1" });
    const mux = await prisma.job.findFirstOrThrow({ where: { type: "media.dub" } });
    expect(mux.jobKey).toBe(`media.dub:${dubId}:hi-IN:9x16`);
    expect(MediaDubPayloadSchema.parse(mux.params)).toMatchObject({
      video: { key: `${CLIP_FOLDER}/master.mp4` },
      destination: { key: `${folder}/hi-IN/9x16.mp4` },
    });
  });

  it("gives the dubbed shape its own project, its media and its words in one go", async () => {
    const mux = await prisma.job.findFirstOrThrow({ where: { type: "media.dub" } });
    const folder = `ws/${WS}/p/${SOURCE}/repurpose/${RUN}/dubs/${dubId}`;
    objects.set(`${folder}/hi-IN/9x16.mp4`, Buffer.from("dubbed-video"));
    const completed: string[] = [];
    const handler = new RepurposeDubMuxCompletionHandler(
      prisma as never,
      {
        create: async (
          workspaceId: string,
          userId: string,
          input: { title: string; sourceLanguage: string },
        ) =>
          prisma.project.create({
            data: {
              id: id("DP1"),
              workspaceId,
              createdBy: userId,
              title: input.title,
              sourceLanguage: input.sourceLanguage,
            },
          }),
      } as never,
      {
        completeAcquisition: async (input: { media: { id: string } }) => {
          completed.push(input.media.id);
          return { media: input.media, probeJobId: "p" };
        },
      } as never,
      service(),
      { register: () => undefined } as never,
      store as never,
      store as never,
    );
    const outcome = await handler.handle({
      job: mux,
      attemptId: id("AT2"),
      result: {
        schemaVersion: 1,
        dubId,
        clipId: CLIP,
        language: "hi-IN",
        shape: "9:16",
        key: `${folder}/hi-IN/9x16.mp4`,
        checksum: "a".repeat(64),
        sizeBytes: 12,
        durationMs: 34_000,
        audioDurationMs: 35_100,
        fit: "trimmed",
        adjustMs: 1_100,
        mixed: false,
      },
      usage: undefined,
      completion: { status: "succeeded" },
    } as JobCompletionContext);
    expect(outcome.data).toMatchObject({ applied: true, projectId: id("DP1") });

    const variant = await prisma.clipDubVariant.findFirstOrThrow({ where: { dubId } });
    expect(variant).toMatchObject({ language: "hi-IN", aspect: "r9x16", projectId: id("DP1") });
    expect(variant.captionConfig).toEqual({ styleId: "punch-pop", styleVersion: 1 });
    const project = await prisma.project.findUniqueOrThrow({ where: { id: id("DP1") } });
    expect(project).toMatchObject({
      title: "The turbulence story (9:16, Hindi)",
      sourceLanguage: "hi",
    });
    const media = await prisma.mediaAsset.findFirstOrThrow({ where: { projectId: id("DP1") } });
    expect(media).toMatchObject({ role: "primary", storageKey: `${folder}/hi-IN/9x16.mp4` });
    expect(completed).toEqual([media.id]);
    const transcript = await prisma.transcript.findFirstOrThrow({
      where: { projectId: id("DP1") },
      include: { chunks: true },
    });
    expect(transcript.language).toBe("hi");
    const words = transcript.chunks[0]?.words as { t: string }[];
    expect(words.map((word) => word.t)).toEqual(["नमस्ते", "दोस्तों", "आज", "की", "बात"]);
  });

  it("refuses what the day's budget cannot afford, and gives back what was never spent", async () => {
    budget.capPaise = () => dubVendorPaise(34_000, 2) + 100;
    const refused = await service()
      .create(WS, USER, RUN, CLIP, { languages: ["bn-IN"], consent: true })
      .catch((error: unknown) => error as { code?: string });
    expect(refused).toMatchObject({ code: DUB_ERRORS.budgetReached });

    budget.capPaise = () => 50_000;
    const waiting = await service().create(WS, USER, RUN, CLIP, {
      languages: ["bn-IN"],
      consent: true,
    });
    const day = (await prisma.clipDub.findUniqueOrThrow({ where: { id: waiting.dub.id } }))
      .budgetDay;
    const key = `${process.env["MONTAJ_REDIS_PREFIX"] ?? "montaj"}:dub:spend:v1:${day ?? ""}`;
    const before = Number(await redis.client.get(key));
    // Cancelled before its vendor job ever started: its rupees come back.
    const cancelled = await service().cancel(WS, USER, RUN, waiting.dub.id);
    expect(cancelled.status).toBe("cancelled");
    expect(Number(await redis.client.get(key))).toBe(before - dubVendorPaise(34_000, 1));
  });

  it("keeps a run's dubs inside its workspace", async () => {
    const error = await service()
      .list(OTHER_WS, RUN)
      .catch((thrown: unknown) => thrown as { httpStatus?: number });
    expect(error).toMatchObject({ httpStatus: 404 });
  });
});
