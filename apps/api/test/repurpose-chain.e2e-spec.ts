/**
 * E2E tests for the repurpose chain (CORE-001, CORE-023, QAT-011):
 * - Happy path: transcript completed -> ai.highlights enqueued -> highlights completion
 *   -> media.clip enqueued -> clip completion -> run reaches terminal state.
 * - Failure paths: highlights fails, clip fails.
 */
import "reflect-metadata";

import Redis from "ioredis";
import { ulid } from "ulid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";
import { REPURPOSE_SCHEMA_VERSION } from "@montaj/repurpose-contracts";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { PLAN_SEEDS } from "../prisma/seed-data.js";
import { RepurposeClipCompletionHandler } from "../src/repurpose/clip-completion.handler.js";
import { RepurposeHighlightsCompletionHandler } from "../src/repurpose/highlights-completion.handler.js";
import { RepurposeTranscriptCompletedListener } from "../src/repurpose/listeners/transcript-completed.listener.js";
import { beginnerSafetyViolations, isCancellable } from "../src/repurpose/repurpose.projection.js";
import { RepurposeService } from "../src/repurpose/repurpose.service.js";
import { EntitlementService } from "../src/workspaces/entitlement.service.js";
import { workspacesRedisKeys } from "../src/workspaces/workspaces.constants.js";

import type { TestDatabase } from "./db-harness.js";
import type { CommonAuditService } from "../src/common/audit/audit.service.js";
import type { PrismaService } from "../src/common/prisma/prisma.service.js";
import type { RedisService } from "../src/common/redis/redis.service.js";
import type { ObjectStore } from "../src/common/storage/index.js";
import type { CreditsFacade } from "../src/credits/credits.facade.js";
import type { JobCompletionContext, JobCompletionRegistry } from "../src/jobs/completion-handlers.js";
import type { JobsService } from "../src/jobs/jobs.service.js";
import type { MediaService } from "../src/media/media.service.js";
import type { ProjectsService } from "../src/projects/projects.service.js";
import type { RealtimePublisher } from "../src/realtime/realtime.publisher.js";
import type { StylesService } from "../src/styles/styles.service.js";
import type { PrismaClient, RepurposeRunStatus } from "@prisma/client";

const DB_READY = isDatabaseAvailable();
const REDIS_READY = isRedisAvailable();
const CAN_RUN = DB_READY && REDIS_READY;
if (!CAN_RUN) {
  console.warn(
    `[repurpose-chain.e2e] SKIPPED — ${DB_READY ? "" : `db: ${skipReason}. `}${
      REDIS_READY ? "" : `redis: ${redisSkipReason}.`
    }`,
  );
}

function id(_suffix?: string): string {
  return ulid();
}

const USER_A = id("UA");
const WORKSPACE_A = id("WA");

const UPLOAD_SOURCE = {
  kind: "upload",
  filename: "episode-chain.mp4",
  mime: "video/mp4",
  sizeBytes: 50_000_000,
  issueUploadTicket: true,
} as const;

const SETUP = {
  sourceLanguage: "hi-Latn",
  caption: { outputLanguage: "same", scriptMode: "roman", styleId: "punch-pop" },
  discovery: {
    mode: "ai",
    requestedCandidates: 3,
    minDurationMs: 15_000,
    maxDurationMs: 60_000,
    contentGoal: "reach",
  },
} as const;

let db: TestDatabase;
let prisma: PrismaClient;
let redis: Redis;
let service: RepurposeService;
let highlightsHandler: RepurposeHighlightsCompletionHandler;
let clipHandler: RepurposeClipCompletionHandler;
let transcriptListener: RepurposeTranscriptCompletedListener;
let projectSeq = 0;
let published: { event: string; data: Record<string, unknown> }[] = [];
let audited: { action: string; data: Record<string, unknown> }[] = [];
let enqueued: { type: string; jobKey: string; params: Record<string, unknown>; id: string }[] = [];
/** What reached `MediaService.completeAcquisition`, and whether its transcript was already there. */
let acquired: {
  mediaId: string;
  status: string;
  transcriptsAtStart: number;
  inRaw: boolean;
}[] = [];
/**
 * The two object stores. `media.clip` writes its mezzanine to the DERIVED one;
 * the media pipeline reads only the RAW one.
 */
let rawObjects: Map<string, Uint8Array>;
let derivedObjects: Map<string, Uint8Array>;

function fakeStore(kind: "s3" | "r2", objects: () => Map<string, Uint8Array>): ObjectStore {
  return {
    kind,
    bucket: kind === "s3" ? "montaj-raw" : "montaj-derived",
    head: async (key: string) => {
      const body = objects().get(key);
      return body === undefined ? null : { sizeBytes: body.length, contentType: "video/mp4" };
    },
    get: async (key: string) => Buffer.from(objects().get(key) ?? new Uint8Array()),
    put: async (input: { key: string; body: Uint8Array | string }) => {
      objects().set(
        input.key,
        typeof input.body === "string" ? Buffer.from(input.body) : input.body,
      );
    },
  } as unknown as ObjectStore;
}

function fakeProjects(): ProjectsService {
  return {
    create: async (workspaceId: string, userId: string, input: { title: string }) => {
      projectSeq += 1;
      const projectId = id(`P${String(projectSeq).padStart(2, "0")}`);
      await prisma.project.create({
        data: { id: projectId, workspaceId, title: input.title, createdBy: userId },
      });
      return { id: projectId, workspaceId, title: input.title };
    },
  } as unknown as ProjectsService;
}

function fakeStyles(): StylesService {
  return { list: async () => [{ id: "punch-pop" }] } as unknown as StylesService;
}

function fakeMedia(): MediaService {
  return {
    completeAcquisition: async (input: {
      media: { id: string; projectId: string; status: string };
    }) => {
      acquired.push({
        mediaId: input.media.id,
        status: input.media.status,
        transcriptsAtStart: await prisma.transcript.count({
          where: { projectId: input.media.projectId },
        }),
        inRaw: rawObjects.has((input.media as unknown as { storageKey: string }).storageKey),
      });
      return { media: input.media, probeJobId: id("PROBE") };
    },
    initUpload: async () => ({
      mediaId: id("MM"),
      uploadId: "upload-1",
      key: "ws/x/p/media/raw.mp4",
      bucket: "s3" as const,
      partSizeBytes: 16 * 1024 * 1024,
      parts: [{ partNumber: 1, url: "https://example.test/part-1" }],
      expiresAt: null,
      duplicate: false,
      media: {},
    }),
  } as unknown as MediaService;
}

function fakeJobs(): JobsService {
  return {
    enqueue: async (input: { type: string; jobKey: string; params: Record<string, unknown> }) => {
      const jobId = id();
      await prisma.job.create({
        data: {
          id: jobId,
          workspaceId: WORKSPACE_A,
          type: input.type,
          jobKey: input.jobKey,
          status: "running",
          priority: 3,
          attemptId: id(`ATT${String(enqueued.length + 1).padStart(2, "0")}`),
          attemptNo: 1,
        },
      });
      enqueued.push({ type: input.type, jobKey: input.jobKey, params: input.params, id: jobId });
      return {
        job: { id: jobId },
        deduplicated: false,
      };
    },
  } as unknown as JobsService;
}

function fakeRegistry(): JobCompletionRegistry {
  return {
    register: () => {},
  } as unknown as JobCompletionRegistry;
}

async function setFlag(key: string, enabled: boolean): Promise<void> {
  await prisma.featureFlag.upsert({
    where: { key },
    create: { id: id(key.slice(0, 2).toUpperCase()), key, enabled, targets: {} },
    update: { enabled },
  });
  await redis.del(workspacesRedisKeys.entitlement(WORKSPACE_A));
}

describe.skipIf(!CAN_RUN)("repurpose full chain execution and failure paths", () => {
  beforeAll(async () => {
    const database = await createTestDatabase();
    if (database === null) throw new Error(`test database unavailable: ${skipReason}`);
    db = database;
    prisma = db.prisma;
    redis = new Redis(testRedisUrl(), { maxRetriesPerRequest: null });

    for (const plan of PLAN_SEEDS) {
      await prisma.plan.upsert({
        where: { key: plan.key },
        create: {
          id: `01JPLAN${plan.key.toUpperCase().padEnd(19, "0")}`.slice(0, 26),
          key: plan.key,
          name: plan.name,
          prices: plan.prices,
          creditsPerMonthTenths: plan.creditsPerMonthTenths,
          seatPrice: plan.seatPrice ?? undefined,
          entitlements: plan.entitlements,
          active: true,
        },
        update: { entitlements: plan.entitlements },
      });
    }

    await prisma.user.create({ data: { id: USER_A, email: "chain-a@example.test", name: "A" } });
    await prisma.workspace.create({
      data: {
        id: WORKSPACE_A,
        slug: "chain-a",
        name: "Chain Workspace",
        ownerId: USER_A,
        billingCountry: "IN",
      },
    });

    const entitlements = new EntitlementService(
      prisma as unknown as PrismaService,
      { client: redis } as unknown as RedisService,
    );
    const audit = {
      record: async (event: { action: string; data?: Record<string, unknown> }) => {
        audited.push({ action: event.action, data: event.data ?? {} });
      },
    } as unknown as CommonAuditService;
    const realtime = {
      publish: async (_room: string, event: string, data: Record<string, unknown>) => {
        published.push({ event, data });
      },
    } as unknown as RealtimePublisher;
    const env = { FEATURE_FLAGS_JSON: {} } as unknown as Env;

    const fakeCredits: CreditsFacade = {
      release: async () => {},
      reserve: async () => ({ holdId: id("HOLD") }),
      settle: async () => ({ settledTenths: 0 }),
      grantLot: async () => ({ lotId: id("LOT"), grantedTenths: 0, expiresAt: undefined }),
      revokeLot: async () => ({ revokedTenths: 0, shortfallTenths: 0 }),
    };

    service = new RepurposeService(
      prisma as unknown as PrismaService,
      fakeProjects(),
      fakeMedia(),
      fakeStyles(),
      entitlements,
      audit,
      realtime,
      fakeJobs(),
      env,
      fakeCredits,
      undefined,
    );

    const registry = fakeRegistry();
    highlightsHandler = new RepurposeHighlightsCompletionHandler(
      prisma as unknown as PrismaService,
      service,
      registry,
      realtime,
    );
    clipHandler = new RepurposeClipCompletionHandler(
      prisma as unknown as PrismaService,
      fakeProjects(),
      fakeMedia(),
      service,
      registry,
      realtime,
      fakeStore("s3", () => rawObjects),
      fakeStore("r2", () => derivedObjects),
    );
    transcriptListener = new RepurposeTranscriptCompletedListener(
      prisma as unknown as PrismaService,
      service,
    );
  });

  afterAll(async () => {
    await redis?.quit();
    await db?.stop();
  });

  beforeEach(async () => {
    published = [];
    audited = [];
    enqueued = [];
    acquired = [];
    rawObjects = new Map();
    derivedObjects = new Map();
    await prisma.job.deleteMany({});
    await prisma.clipVariant.deleteMany({});
    await prisma.repurposeClip.deleteMany({});
    await prisma.clipCandidate.deleteMany({});
    await prisma.transcriptChunk.deleteMany({});
    await prisma.transcript.deleteMany({});
    await prisma.mediaAsset.deleteMany({});
    await prisma.repurposeRun.deleteMany({});
    await setFlag("repurpose_flow", true);
  });

  it("drives full happy path: transcript completed -> ai.highlights enqueued -> highlights completion -> media.clip enqueued -> clip completion -> terminal state", async () => {
    // 1. Create repurpose run
    const createdRun = await service.create(WORKSPACE_A, USER_A, {
      source: UPLOAD_SOURCE,
      setup: SETUP,
    });
    const runId = createdRun.run.id;
    const sourceProjectId = createdRun.run.sourceProjectId;

    // 2. Setup source project media asset and transcript
    const mediaId = id("MEDIA01");
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        projectId: sourceProjectId,
        filename: "source.mp4",
        mime: "video/mp4",
        storageKey: `ws/${WORKSPACE_A}/p/${sourceProjectId}/media/${mediaId}/raw.mp4`,
        durationMs: 60_000,
        status: "ready",
        role: "primary",
      },
    });

    const transcriptId = id("TRANSCRIPT01");
    await prisma.transcript.create({
      data: {
        id: transcriptId,
        projectId: sourceProjectId,
        language: "hi-Latn",
        currentRevision: 1,
      },
    });

    await prisma.transcriptChunk.create({
      data: {
        id: id("CHUNK01"),
        transcriptId,
        revision: 1,
        chunkIdx: 0,
        startMs: 0,
        endMs: 60_000,
        words: [
          { t: "Welcome", s: 1000, e: 2000 },
          { t: "to", s: 2000, e: 2500 },
          { t: "this", s: 2500, e: 3000 },
          { t: "great", s: 3000, e: 3500 },
          { t: "highlight", s: 3500, e: 4000 },
          { t: "moment", s: 4000, e: 5000 },
        ],
        nextWordSeq: 7,
      },
    });

    // 3. Emit TRANSCRIPT_COMPLETED_EVENT via listener
    await transcriptListener.onTranscriptCompleted({
      workspaceId: WORKSPACE_A,
      projectId: sourceProjectId,
      transcriptId,
      jobId: id("TJ"),
    });

    // Assert ai.highlights was enqueued and run status moved to analyzing
    const highlightsJob = enqueued.find((j) => j.type === "ai.highlights");
    expect(highlightsJob).toBeDefined();
    expect(highlightsJob?.params["runId"]).toBe(runId);

    let run = await service.get(WORKSPACE_A, runId);
    expect(run.status).toBe("analyzing");
    expect(run.currentStage).toBe("finding_clips");

    // 4. Faked worker result for ai.highlights completion
    const proposal1 = {
      windowId: "win-0001",
      startMs: 1_000,
      endMs: 5_000,
      startWordId: "w1",
      endWordId: "w6",
      title: "Opening Hook Moment",
      transcriptExcerpt: "Welcome to this great highlight moment",
      potentialScore: 92,
      scoreBreakdown: {
        hook: 95,
        clarity: 90,
        emotion: 85,
        visualActivity: 88,
        novelty: 80,
        standaloneValue: 92,
        safety: 99,
      },
      reasons: [
        { label: "hook" as const, explanation: "High engagement opening" },
        { label: "standalone" as const, explanation: "Self-contained thought" },
      ],
    };

    const highlightsResult = {
      schemaVersion: REPURPOSE_SCHEMA_VERSION,
      runId,
      transcriptId,
      transcriptRevision: 1,
      proposals: [proposal1],
      featureVersion: "v1",
      promptVersion: "v1",
      model: "montaj-highlight-v1",
      windowsConsidered: 10,
    };

    const highlightsContext: JobCompletionContext = {
      job: {
        id: highlightsJob?.id ?? id("HJ"),
        workspaceId: WORKSPACE_A,
        projectId: sourceProjectId,
        type: "ai.highlights",
      } as any,
      attemptId: id("ATT01"),
      result: highlightsResult,
      usage: undefined,
      completion: { status: "succeeded", result: highlightsResult },
    };

    await highlightsHandler.handle(highlightsContext);

    // Assert candidates created and status is candidates_ready
    run = await service.get(WORKSPACE_A, runId);
    expect(run.status).toBe("candidates_ready");
    expect(run.currentStage).toBe("finding_clips");
    expect(run.candidateCount).toBe(1);

    const candidates = await service.listCandidates(WORKSPACE_A, runId);
    expect(candidates.candidates.length).toBe(1);
    const chosenCandidate = candidates.candidates[0]!;

    // 5. Select candidate and enqueue media.clip
    const clipResult = await service.createClip(
      WORKSPACE_A,
      USER_A,
      runId,
      chosenCandidate.id,
    );
    expect(clipResult.clipId).toBeDefined();

    const clipJob = enqueued.find((j) => j.type === "media.clip");
    expect(clipJob).toBeDefined();
    expect(clipJob?.params["clipId"]).toBe(clipResult.clipId);

    run = await service.get(WORKSPACE_A, runId);
    expect(run.status).toBe("materializing");
    expect(run.currentStage).toBe("styles_formats");

    // 6. Faked worker result for media.clip completion
    const mezzanineKey = `ws/${WORKSPACE_A}/clips/${clipResult.clipId}/master.mp4`;
    const mediaClipResult = {
      schemaVersion: REPURPOSE_SCHEMA_VERSION,
      clipId: clipResult.clipId,
      bucket: "s3" as const,
      key: mezzanineKey,
      checksum: "e".repeat(64),
      sizeBytes: 10_500_000,
      durationMs: 4_000,
      effectiveStartMs: 800,
      effectiveEndMs: 5_200,
      leadHandleMs: 200,
      tailHandleMs: 200,
      hasAudio: true,
      deduplicated: false,
    };

    // Where the worker really writes it (`processors/clip.ts`: `context.derived`).
    derivedObjects.set(mezzanineKey, new Uint8Array(4_096));

    const clipContext: JobCompletionContext = {
      job: {
        id: clipJob?.id ?? id("CJ"),
        workspaceId: WORKSPACE_A,
        projectId: sourceProjectId,
        type: "media.clip",
      } as any,
      attemptId: id("ATT02"),
      result: mediaClipResult,
      usage: undefined,
      completion: { status: "succeeded", result: mediaClipResult },
    };

    await clipHandler.handle(clipContext);

    // Assert clip and child variant created, status review_ready
    run = await service.get(WORKSPACE_A, runId);
    expect(run.status).toBe("review_ready");
    expect(run.currentStage).toBe("review");
    expect(run.clipCount).toBe(1);
    expect(run.variantCount).toBe(1);

    // The child project must become editable (2026-09-25): its mezzanine enters
    // the ordinary media pipeline unprobed — never stamped `ready` with no
    // dimensions — and only after the transcript slice is in place, so the
    // proxy's completion can build the editing document from it.
    const variant = await prisma.clipVariant.findFirstOrThrow({
      where: { clipId: clipResult.clipId },
    });
    const childMedia = await prisma.mediaAsset.findFirstOrThrow({
      where: { projectId: variant.projectId, role: "primary" },
    });
    expect(childMedia.storageKey).toBe(mezzanineKey);
    expect(childMedia.status).toBe("pending");
    expect(childMedia.bucket).toBe("s3");
    // Copied into the raw store — the only one probe, proxy and render read —
    // before the pipeline starts.
    expect(acquired).toEqual([
      { mediaId: childMedia.id, status: "pending", transcriptsAtStart: 1, inRaw: true },
    ]);
    const childTranscript = await prisma.transcript.findFirstOrThrow({
      where: { projectId: variant.projectId },
    });
    const childChunk = await prisma.transcriptChunk.findFirstOrThrow({
      where: { transcriptId: childTranscript.id },
    });
    // Words inside [800, 5200], shifted to the clip's own clock.
    expect((childChunk.words as { t: string; s: number }[]).map((w) => [w.t, w.s])).toEqual([
      ["Welcome", 200],
      ["to", 1_200],
      ["this", 1_700],
      ["great", 2_200],
      ["highlight", 2_700],
      ["moment", 3_200],
    ]);

    // A replayed completion must not push already-probed media back through the
    // pipeline.
    await prisma.mediaAsset.update({ where: { id: childMedia.id }, data: { status: "ready" } });
    await prisma.repurposeRun.update({
      where: { id: runId },
      data: { status: "materializing" },
    });
    await clipHandler.handle(clipContext);
    expect(acquired).toHaveLength(1);

    // A re-cut (profile "2" replacing a burned-in-captions cut): new bytes at
    // the same key. The child's picture is replaced and goes back through the
    // pipeline; its transcript and project stay.
    derivedObjects.set(mezzanineKey, new Uint8Array(8_192));
    rawObjects.set(mezzanineKey, new Uint8Array(4_096)); // the stale, burned-in copy
    await prisma.repurposeRun.update({ where: { id: runId }, data: { status: "materializing" } });
    const recutResult = { ...mediaClipResult, checksum: "f".repeat(64), sizeBytes: 8_192 };
    await clipHandler.handle({
      ...clipContext,
      result: recutResult,
      completion: { status: "succeeded", result: recutResult },
    });
    const recut = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: childMedia.id } });
    expect(recut.status).toBe("pending");
    expect(recut.contentHash).toBe("f".repeat(64));
    expect(rawObjects.get(mezzanineKey)?.length).toBe(8_192);
    expect(acquired).toHaveLength(2);
    expect(await prisma.transcript.count({ where: { projectId: variant.projectId } })).toBe(1);

    // Cutting a clip again is how a person retries one whose media pipeline
    // failed — even when the new cut is byte-identical.
    await prisma.mediaAsset.update({
      where: { id: childMedia.id },
      data: { status: "failed", failureReason: "media/corrupt" },
    });
    await prisma.repurposeRun.update({ where: { id: runId }, data: { status: "materializing" } });
    await clipHandler.handle({
      ...clipContext,
      result: recutResult,
      completion: { status: "succeeded", result: recutResult },
    });
    const retried = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: childMedia.id } });
    expect(retried.status).toBe("pending");
    expect(retried.failureReason).toBeNull();
    expect(acquired).toHaveLength(3);

    // 7. Advance to terminal state (published)
    await prisma.repurposeRun.update({
      where: { id: runId },
      data: {
        status: "published",
        currentStage: "publish",
        progress: 100,
        completedAt: new Date(),
      },
    });

    const terminalRun = await service.get(WORKSPACE_A, runId);
    expect(terminalRun.status).toBe("published");
    expect(terminalRun.currentStage).toBe("publish");
    expect(terminalRun.progress).toBe(100);
    expect(isCancellable(terminalRun.status as RepurposeRunStatus)).toBe(false);
    expect(terminalRun.canCancel).toBe(false);
    expect(terminalRun.canRetry).toBe(false);
    expect(beginnerSafetyViolations(terminalRun.message)).toEqual([]);
  });

  it("handles failure path: ai.highlights fails terminally", async () => {
    const createdRun = await service.create(WORKSPACE_A, USER_A, {
      source: UPLOAD_SOURCE,
      setup: SETUP,
    });
    const runId = createdRun.run.id;

    // Simulate start of highlight discovery
    await prisma.repurposeRun.update({
      where: { id: runId },
      data: { status: "analyzing", currentStage: "finding_clips" },
    });

    // Invoke failure handler
    const failContext: JobCompletionContext = {
      job: {
        id: id("JOBFAIL1"),
        workspaceId: WORKSPACE_A,
        projectId: createdRun.run.sourceProjectId,
        type: "ai.highlights",
        params: { runId },
      } as any,
      attemptId: id("ATTFAIL1"),
      result: {},
      usage: undefined,
      completion: {
        status: "failed",
        error: { code: "worker/failed", message: "Highlights inference failed", retryable: false },
      },
    };

    await highlightsHandler.handleFailure(failContext);

    const failedRun = await service.get(WORKSPACE_A, runId);
    expect(failedRun.status).toBe("failed");
    expect(failedRun.failureCode).toBe("repurpose/analysis_failed");
    expect(failedRun.canRetry).toBe(true);
    expect(failedRun.canCancel).toBe(false);
    expect(failedRun.message).toBe("Something went wrong. Your work is safe.");
    expect(beginnerSafetyViolations(failedRun.message)).toEqual([]);
  });

  it("handles failure path: media.clip fails terminally", async () => {
    const createdRun = await service.create(WORKSPACE_A, USER_A, {
      source: UPLOAD_SOURCE,
      setup: SETUP,
    });
    const runId = createdRun.run.id;

    // Simulate run at materializing
    await prisma.repurposeRun.update({
      where: { id: runId },
      data: { status: "materializing", currentStage: "styles_formats" },
    });

    // Invoke failure handler
    const failContext: JobCompletionContext = {
      job: {
        id: id("JOBFAIL2"),
        workspaceId: WORKSPACE_A,
        projectId: createdRun.run.sourceProjectId,
        type: "media.clip",
        params: { runId },
      } as any,
      attemptId: id("ATTFAIL2"),
      result: {},
      usage: undefined,
      completion: {
        status: "failed",
        error: { code: "media/probe_failed", message: "FFmpeg mezzanine encode failed", retryable: false },
      },
    };

    await clipHandler.handleFailure(failContext);

    const failedRun = await service.get(WORKSPACE_A, runId);
    expect(failedRun.status).toBe("failed");
    expect(failedRun.failureCode).toBe("repurpose/clip_failed");
    expect(failedRun.canRetry).toBe(true);
    expect(failedRun.canCancel).toBe(false);
    expect(failedRun.message).toBe("Something went wrong. Your work is safe.");
    expect(beginnerSafetyViolations(failedRun.message)).toEqual([]);
  });
});
