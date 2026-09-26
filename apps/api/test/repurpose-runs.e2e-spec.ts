/**
 * REP-006's run CRUD against a real PostgreSQL.
 *
 * `RepurposeService` is driven directly, the way `entitlements.e2e-spec.ts`
 * drives its own service: the claims worth proving here are about the database
 * and the workspace boundary, and neither needs HTTP, auth or object storage to
 * be demonstrated. `ProjectsService`, `MediaService`, the audit sink and the
 * realtime publisher are stood in for — each has its own suite — while Prisma and
 * the entitlement/flag evaluation are real.
 *
 * What it proves:
 *
 *   * the whole surface is 404 while `repurpose_flow` is off, which is how it
 *     ships and how CP-010 requires it to stay;
 *   * a link source is refused while `source_youtube_acquire` is off, rather than
 *     creating a run that could never progress;
 *   * one live run per source per workspace, and workspace B is never affected;
 *   * every read is `(workspaceId, runId)`, so workspace B cannot see, cancel or
 *     retry workspace A's run — and gets "not found", not "forbidden";
 *   * cancel and retry follow the documented transitions, and cancelling twice is
 *     not an error;
 *   * nothing a person is shown contains a queue name, a job id or the codename.
 */
import "reflect-metadata";

import Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { PLAN_SEEDS } from "../prisma/seed-data.js";
import { IdempotencyService } from "../src/public-api/v1/idempotency.service.js";
import { withIdempotency } from "../src/public-api/v1/idempotent.helper.js";
import { RepurposeHighlightsCompletionHandler } from "../src/repurpose/highlights-completion.handler.js";
import { RepurposeReconciler } from "../src/repurpose/reconciler.js";
import { beginnerSafetyViolations } from "../src/repurpose/repurpose.projection.js";
import { RepurposeService } from "../src/repurpose/repurpose.service.js";
import { EntitlementService } from "../src/workspaces/entitlement.service.js";
import { workspacesRedisKeys } from "../src/workspaces/workspaces.constants.js";

import type { TestDatabase } from "./db-harness.js";
import type { CommonAuditService } from "../src/common/audit/audit.service.js";
import type { PrismaService } from "../src/common/prisma/prisma.service.js";
import type { RedisService } from "../src/common/redis/redis.service.js";
import type { CreditsFacade } from "../src/credits/credits.facade.js";
import type { JobCompletionContext, JobCompletionRegistry } from "../src/jobs/completion-handlers.js";
import type { JobsService } from "../src/jobs/jobs.service.js";
import type { MediaService } from "../src/media/media.service.js";
import type { ProjectsService } from "../src/projects/projects.service.js";
import type { RealtimePublisher } from "../src/realtime/realtime.publisher.js";
import type { RepurposeClipsService } from "../src/repurpose/repurpose-clips.service.js";
import type { StylesService } from "../src/styles/styles.service.js";
import type { AutoTranscribeTrigger } from "../src/transcripts/auto-transcribe.trigger.js";
import type { Job, PrismaClient } from "@prisma/client";
import type { Request } from "express";

const DB_READY = isDatabaseAvailable();
const REDIS_READY = isRedisAvailable();
const CAN_RUN = DB_READY && REDIS_READY;
if (!CAN_RUN) {
  console.warn(
    `[repurpose-runs.e2e] SKIPPED — ${DB_READY ? "" : `db: ${skipReason}. `}${
      REDIS_READY ? "" : `redis: ${redisSkipReason}.`
    }`,
  );
}

const ULID_BASE = "01JS0000000000000000000000";
function id(suffix: string): string {
  return (ULID_BASE.slice(0, 26 - suffix.length) + suffix).toUpperCase();
}

const USER_A = id("UA");
const USER_B = id("UB");
const WORKSPACE_A = id("WA");
const WORKSPACE_B = id("WB");

const UPLOAD_SOURCE = {
  kind: "upload",
  filename: "episode-12.mp4",
  mime: "video/mp4",
  sizeBytes: 148_372_910,
  // The API default. The web passes false and uses the existing upload queue.
  issueUploadTicket: true,
} as const;

const SETUP = {
  sourceLanguage: "hi-Latn",
  caption: { outputLanguage: "same", scriptMode: "roman", styleId: "punch-pop" },
  // ^ present in STYLE_CATALOGUE; `create` now refuses an id that is not.
  discovery: {
    mode: "ai",
    requestedCandidates: 5,
    minDurationMs: 15_000,
    maxDurationMs: 60_000,
    contentGoal: "reach",
  },
} as const;

let db: TestDatabase;
let prisma: PrismaClient;
let redis: Redis;
let service: RepurposeService;
let projectSeq = 0;
let created: { projectId: string; workspaceId: string }[] = [];
let published: { event: string; data: Record<string, unknown> }[] = [];
let audited: { action: string; data: Record<string, unknown> }[] = [];
let enqueued: { type: string; jobKey: string; params: Record<string, unknown> }[] = [];
let releasedCreditHolds: string[] = [];
/** Set to a thrower to simulate admission control refusing the acquisition. */
let enqueueFailure: Error | null = null;

/** Creates a real project row, so foreign keys and cascades are exercised. */
function fakeProjects(): ProjectsService {
  return {
    create: async (workspaceId: string, userId: string, input: { title: string }) => {
      projectSeq += 1;
      const projectId = id(`P${String(projectSeq).padStart(2, "0")}`);
      await prisma.project.create({
        data: { id: projectId, workspaceId, title: input.title, createdBy: userId },
      });
      created.push({ projectId, workspaceId });
      return { id: projectId, workspaceId, title: input.title };
    },
    softDelete: async (workspaceId: string, projectId: string) => {
      await prisma.project.update({
        where: { id: projectId, workspaceId },
        data: { deletedAt: new Date() },
      });
      return { id: projectId };
    },
  } as unknown as ProjectsService;
}

/** Set to a thrower to simulate a plan-cap refusal inside `initUpload`. */
let uploadFailure: Error | null = null;

/** The catalogue `StylesService.list` returns; only `id` is read. */
const STYLE_CATALOGUE = [{ id: "punch-pop" }, { id: "bold-drop" }];

function fakeStyles(): StylesService {
  return { list: async () => STYLE_CATALOGUE } as unknown as StylesService;
}

/** The shape `MediaService.initUpload` returns, without touching storage. */
function fakeMedia(): MediaService {
  return {
    initUpload: async (_workspaceId: string, projectId: string) => {
      if (uploadFailure !== null) throw uploadFailure;
      return {
        mediaId: id("MM"),
        uploadId: "upload-1",
        key: `ws/x/p/${projectId}/media/m/raw.mp4`,
        bucket: "s3" as const,
        partSizeBytes: 16 * 1024 * 1024,
        parts: [{ partNumber: 1, url: "https://example.test/part-1" }],
        expiresAt: null,
        duplicate: false,
        media: {},
      };
    },
    reserveAcquisition: async (project: { id: string }) => {
      mediaSeq += 1;
      const mediaId = id("MA" + String(mediaSeq).padStart(2, "0"));
      const key = "ws/x/p/" + project.id + "/media/" + mediaId + "/raw.mp4";
      await prisma.mediaAsset.create({
        data: { id: mediaId, projectId: project.id, role: "primary", storageKey: key },
      });
      return { media: { id: mediaId }, bucket: "s3" as const, key };
    },
  } as unknown as MediaService;
}

/** Sequence for the reserved media rows, so ids stay distinct within a file. */
let mediaSeq = 0;

/**
 * Records what the producer asked for instead of writing a `jobs` row.
 *
 * What these tests are about is what the API decided - the queue name, the key it
 * deduplicates on, the limits it froze into the payload - not that BullMQ works.
 */
function fakeJobs(): JobsService {
  return {
    enqueue: async (input: { type: string; jobKey: string; params: Record<string, unknown> }) => {
      if (enqueueFailure !== null) throw enqueueFailure;
      enqueued.push({ type: input.type, jobKey: input.jobKey, params: input.params });
      return {
        job: { id: id("J" + String(enqueued.length).padStart(2, "0")) },
        deduplicated: false,
      };
    },
  } as unknown as JobsService;
}

function fakeCredits(): CreditsFacade {
  return {
    release: async ({ holdId }) => {
      releasedCreditHolds.push(holdId);
    },
    reserve: async () => ({ holdId: id("HOLD") }),
    settle: async () => ({ settledTenths: 0 }),
    grantLot: async () => ({ lotId: id("LOT"), grantedTenths: 0, expiresAt: undefined }),
    revokeLot: async () => ({ revokedTenths: 0, shortfallTenths: 0 }),
  };
}

async function makeService(): Promise<RepurposeService> {
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

  const service = new RepurposeService(
    prisma as unknown as PrismaService,
    fakeProjects(),
    fakeMedia(),
    fakeStyles(),
    entitlements,
    audit,
    realtime,
    fakeJobs(),
    env,
    fakeCredits(),
    undefined,
  );
  // Retry re-drives a run through the reconciler (2026-09-26); the module
  // registers it at boot, a hand-built harness has to do the same.
  new RepurposeReconciler(
    prisma as unknown as PrismaService,
    service,
    { maybeEnqueue: async () => undefined } as unknown as AutoTranscribeTrigger,
    { reconcileClips: async () => undefined } as unknown as RepurposeClipsService,
  ).onModuleInit();
  return service;
}

/** Set a rollout flag's row, then drop the entitlement cache that reads it. */
async function setFlag(key: string, enabled: boolean): Promise<void> {
  await prisma.featureFlag.upsert({
    where: { key },
    create: { id: id(key.slice(0, 2).toUpperCase()), key, enabled, targets: {} },
    update: { enabled },
  });
  // The flag reaches the service through the entitlement snapshot, which is
  // cached for 60 s; dropping the key is how the production invalidation hook
  // does it too (`EntitlementService.invalidate`).
  for (const workspaceId of [WORKSPACE_A, WORKSPACE_B]) {
    await redis.del(workspacesRedisKeys.entitlement(workspaceId));
  }
}

describe.skipIf(!CAN_RUN)("repurpose run CRUD (REP-006)", () => {
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

    await prisma.user.create({ data: { id: USER_A, email: "rep-run-a@example.test", name: "A" } });
    await prisma.user.create({ data: { id: USER_B, email: "rep-run-b@example.test", name: "B" } });
    await prisma.workspace.create({
      data: {
        id: WORKSPACE_A,
        slug: "rep-run-a",
        name: "A",
        ownerId: USER_A,
        billingCountry: "IN",
      },
    });
    await prisma.workspace.create({
      data: {
        id: WORKSPACE_B,
        slug: "rep-run-b",
        name: "B",
        ownerId: USER_B,
        billingCountry: "IN",
      },
    });

    service = await makeService();
  });

  afterAll(async () => {
    await redis?.quit();
    await db?.stop();
  });

  beforeEach(async () => {
    created = [];
    published = [];
    audited = [];
    uploadFailure = null;
    enqueued = [];
    releasedCreditHolds = [];
    enqueueFailure = null;
    await prisma.repurposeRun.deleteMany({});
    await prisma.idempotencyRecord.deleteMany({});
    await setFlag("repurpose_flow", true);
    await setFlag("source_youtube_acquire", false);
  });

  describe("the flag gate", () => {
    it("answers not-found for every route while the flow is off", async () => {
      await setFlag("repurpose_flow", false);

      await expect(
        service.create(WORKSPACE_A, USER_A, { source: UPLOAD_SOURCE, setup: SETUP }),
      ).rejects.toMatchObject({ code: "repurpose/not_available" });
      await expect(service.list(WORKSPACE_A, { limit: 20 })).rejects.toMatchObject({
        code: "repurpose/not_available",
      });
      await expect(service.get(WORKSPACE_A, id("RX"))).rejects.toMatchObject({
        code: "repurpose/not_available",
      });
      await expect(service.cancel(WORKSPACE_A, USER_A, id("RX"))).rejects.toMatchObject({
        code: "repurpose/not_available",
      });
    });

    it("lets the deployment kill switch win over an enabled row", async () => {
      // `FEATURE_FLAGS_JSON` has to be able to turn a feature off without a
      // database write; that is the whole point of an emergency switch.
      const killed = new RepurposeService(
        prisma as unknown as PrismaService,
        fakeProjects(),
        fakeMedia(),
        fakeStyles(),
        new EntitlementService(
          prisma as unknown as PrismaService,
          { client: redis } as unknown as RedisService,
        ),
        { record: async () => undefined } as unknown as CommonAuditService,
        { publish: async () => undefined } as unknown as RealtimePublisher,
        fakeJobs(),
        { FEATURE_FLAGS_JSON: { repurpose_flow: false } } as unknown as Env,
        fakeCredits(),
      );

      await expect(killed.list(WORKSPACE_A, { limit: 20 })).rejects.toMatchObject({
        code: "repurpose/not_available",
      });
    });
  });

  describe("creating a run", () => {
    it("creates the source project and an ordinary upload ticket", async () => {
      const response = await service.create(WORKSPACE_A, USER_A, {
        source: UPLOAD_SOURCE,
        setup: SETUP,
      });

      expect(created).toHaveLength(1);
      expect(response.projectId).toBe(created[0]?.projectId);
      expect(response.upload?.partSizeBytes).toBe(16 * 1024 * 1024);
      expect(response.run.status).toBe("draft");
      expect(response.run.currentStage).toBe("getting_video");
      expect(response.next.href).toBe(`/repurpose/${response.run.id}`);

      const stored = await prisma.repurposeRun.findUniqueOrThrow({
        where: { id: response.run.id },
      });
      expect(stored.workspaceId).toBe(WORKSPACE_A);
      expect(stored.sourceKind).toBe("upload");
      // An upload needs no attestation; an external link does (§9.3).
      expect(stored.rightsAttestedAt).toBeNull();
      expect(stored.sourceUrlEncrypted).toBeNull();
    });

    it("freezes the setup as a versioned snapshot", async () => {
      const response = await service.create(WORKSPACE_A, USER_A, {
        source: UPLOAD_SOURCE,
        setup: SETUP,
      });
      const stored = await prisma.repurposeRun.findUniqueOrThrow({
        where: { id: response.run.id },
      });
      const config = stored.config as Record<string, unknown>;

      expect(stored.configVersion).toBe(1);
      expect(config["schemaVersion"]).toBe(1);
      expect(config["sourceLanguage"]).toBe("hi-Latn");
      expect((config["caption"] as Record<string, unknown>)["scriptMode"]).toBe("roman");
    });

    it("emits a stage event and an audit record with no external URL in it", async () => {
      await service.create(WORKSPACE_A, USER_A, { source: UPLOAD_SOURCE, setup: SETUP });

      expect(published.map((entry) => entry.event)).toEqual(["repurpose.stage.changed"]);
      expect(audited.map((entry) => entry.action)).toEqual(["repurpose.run.created"]);
      expect(JSON.stringify(audited)).not.toContain("http");
    });

    it("refuses a caption style that is not in the workspace's catalogue", async () => {
      // The run FREEZES the style id, so an unknown one would surface as a render
      // failure much later with nothing to say about why.
      await expect(
        service.create(WORKSPACE_A, USER_A, {
          source: UPLOAD_SOURCE,
          setup: { ...SETUP, caption: { ...SETUP.caption, styleId: "no-such-style" } },
        }),
      ).rejects.toMatchObject({ code: "repurpose/style_unknown" });

      // And it refuses before anything is written.
      expect(created).toHaveLength(0);
      expect(await prisma.repurposeRun.count()).toBe(0);
    });

    it("leaves no orphan project when the upload ticket is refused", async () => {
      // This is the FIRST refusal a beginner over the plan's size cap hits, and it
      // happens after the project row exists - so it has to be compensated.
      uploadFailure = new Error("media/too_large");

      await expect(
        service.create(WORKSPACE_A, USER_A, { source: UPLOAD_SOURCE, setup: SETUP }),
      ).rejects.toThrow("media/too_large");

      expect(created).toHaveLength(1);
      const project = await prisma.project.findUniqueOrThrow({
        where: { id: created[0]?.projectId ?? "" },
      });
      expect(project.deletedAt).not.toBeNull();
      expect(await prisma.repurposeRun.count()).toBe(0);
    });

    it("refuses a link while acquisition is switched off", async () => {
      await expect(
        service.create(WORKSPACE_A, USER_A, {
          source: {
            kind: "url",
            url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            rightsAttested: true,
          },
          setup: SETUP,
        }),
      ).rejects.toMatchObject({ code: "repurpose/source_unsupported" });

      expect(await prisma.repurposeRun.count()).toBe(0);
      // And no orphan project was left behind by the refusal.
      expect(created).toHaveLength(0);
    });

    it("refuses a direct media link too, not just YouTube", async () => {
      // A direct-media run has no acquisition path either, and this service does
      // not persist the full URL - so one created today could never be fetched.
      await expect(
        service.create(WORKSPACE_A, USER_A, {
          source: {
            kind: "url",
            url: "https://cdn.example.test/videos/ep12.mp4",
            rightsAttested: true,
          },
          setup: SETUP,
        }),
      ).rejects.toMatchObject({ code: "repurpose/source_unsupported" });
      expect(await prisma.repurposeRun.count()).toBe(0);
    });

    it("records the attestation and the safe display form for an allowed link", async () => {
      await setFlag("source_youtube_acquire", true);

      const response = await service.create(WORKSPACE_A, USER_A, {
        source: {
          kind: "url",
          url: "https://youtu.be/dQw4w9WgXcQ?si=trackingparam",
          rightsAttested: true,
        },
        setup: SETUP,
      });

      const stored = await prisma.repurposeRun.findUniqueOrThrow({
        where: { id: response.run.id },
      });
      expect(stored.sourceKind).toBe("youtube_url");
      expect(stored.sourceFingerprint).toBe("youtube:dQw4w9WgXcQ");
      expect(stored.rightsAttestedAt).not.toBeNull();
      expect(stored.rightsAttestedBy).toBe(USER_A);
      expect(stored.sourceDisplay).not.toContain("trackingparam");
      expect(response.upload).toBeNull();
    });

    it("refuses a malformed link with a plain sentence", async () => {
      await setFlag("source_youtube_acquire", true);
      await expect(
        service.create(WORKSPACE_A, USER_A, {
          source: { kind: "url", url: "http://www.youtube.com/watch?v=dQw4w9WgXcQ", rightsAttested: true },
          setup: SETUP,
        }),
      ).rejects.toMatchObject({ code: "repurpose/source_invalid_url" });
    });

    it("refuses a second live run for the same video, and frees it when the first ends", async () => {
      await setFlag("source_youtube_acquire", true);
      const source = {
        kind: "url",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        rightsAttested: true,
      } as const;

      const first = await service.create(WORKSPACE_A, USER_A, { source, setup: SETUP });
      await expect(
        service.create(WORKSPACE_A, USER_A, { source, setup: SETUP }),
      ).rejects.toMatchObject({ code: "repurpose/source_already_running" });

      // Workspace B is a different tenant and is never blocked by ours.
      await expect(
        service.create(WORKSPACE_B, USER_B, { source, setup: SETUP }),
      ).resolves.toBeTruthy();

      await service.cancel(WORKSPACE_A, USER_A, first.run.id);
      await expect(
        service.create(WORKSPACE_A, USER_A, { source, setup: SETUP }),
      ).resolves.toBeTruthy();
    });
  });

  describe("idempotent create", () => {
    /** The controller's exact call, minus HTTP. */
    async function createWithKey(
      key: string,
      body: Record<string, unknown>,
    ): Promise<{ run: { id: string } }> {
      const idempotency = new IdempotencyService(prisma as unknown as PrismaService);
      const request = { headers: { "idempotency-key": key } } as unknown as Request;
      return withIdempotency(
        idempotency,
        request,
        WORKSPACE_A,
        "POST /repurpose/runs",
        body,
        async () =>
          service.create(WORKSPACE_A, USER_A, body as unknown as Parameters<typeof service.create>[2]),
      ) as Promise<{ run: { id: string } }>;
    }

    it("replays the first answer instead of starting a second run", async () => {
      // A dropped response and a double-clicked button are the same request. The
      // cost of getting this wrong is two transcriptions and two projects for one
      // video, so it is the guarantee most worth a test.
      const body = { source: UPLOAD_SOURCE, setup: SETUP };
      const first = await createWithKey("key-abc", body);
      const second = await createWithKey("key-abc", body);

      expect(second.run.id).toBe(first.run.id);
      expect(await prisma.repurposeRun.count()).toBe(1);
      expect(created).toHaveLength(1);
    });

    it("refuses the same key with a different body rather than replaying the wrong answer", async () => {
      await createWithKey("key-def", { source: UPLOAD_SOURCE, setup: SETUP });

      await expect(
        createWithKey("key-def", {
          source: { ...UPLOAD_SOURCE, filename: "a-different-video.mp4" },
          setup: SETUP,
        }),
      ).rejects.toMatchObject({ code: "public_api/idempotency_conflict" });
    });

    it("keeps two different keys as two different runs", async () => {
      const body = { source: UPLOAD_SOURCE, setup: SETUP };
      const first = await createWithKey("key-one", body);
      const second = await createWithKey("key-two", body);

      expect(second.run.id).not.toBe(first.run.id);
      expect(await prisma.repurposeRun.count()).toBe(2);
    });

    it("still creates a run when no key is sent, because a browser form sends none", async () => {
      const idempotency = new IdempotencyService(prisma as unknown as PrismaService);
      const request = { headers: {} } as unknown as Request;
      await withIdempotency(
        idempotency,
        request,
        WORKSPACE_A,
        "POST /repurpose/runs",
        {},
        async () => service.create(WORKSPACE_A, USER_A, { source: UPLOAD_SOURCE, setup: SETUP }),
      );
      expect(await prisma.repurposeRun.count()).toBe(1);
    });
  });

  describe("the acquisition producer", () => {
    /**
     * A link source has no browser to push bytes, so `create` is the producer.
     * These assert what the API DECIDED - which queue, which dedupe key, which
     * limits were frozen - because everything after that point is the worker's
     * and is tested against a real yt-dlp over in `apps/worker-media`.
     */
    it("queues exactly one download, with the plan's limits frozen into it", async () => {
      await setFlag("source_youtube_acquire", true);

      const response = await service.create(WORKSPACE_A, USER_A, {
        source: {
          kind: "url",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          rightsAttested: true,
        },
        setup: SETUP,
      });

      expect(enqueued).toHaveLength(1);
      const job = enqueued[0];
      expect(job?.type).toBe("media.acquire");
      // The key names the RUN and the SOURCE, not the media row: ten submissions
      // of the same video inside one run are one download (master plan 9.5).
      expect(job?.jobKey).toBe(`media.acquire:${response.run.id}:youtube:dQw4w9WgXcQ`);

      const params = job?.params as {
        source: { kind: string; normalizedUrl: string; sourceId: string };
        destination: { bucket: string; key: string };
        limits: { maxBytes: number; maxDurationMs: number; timeoutMs: number };
      };
      expect(params.source.kind).toBe("youtube_url");
      // Canonical, and stripped of the tracking parameter the user pasted.
      expect(params.source.normalizedUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      expect(params.source.sourceId).toBe("youtube:dQw4w9WgXcQ");
      // The key is ours, built from ids: a remote title never chooses a path.
      expect(params.destination.key).toContain(`/p/${response.projectId}/media/`);

      // The plan in force at confirmation travels with the job, so a plan change
      // between enqueue and run cannot retroactively widen what was allowed.
      expect(params.limits.maxBytes).toBe(500 * 1024 * 1024);
      expect(params.limits.maxDurationMs).toBe(20 * 60 * 1000);
      expect(params.limits.timeoutMs).toBeGreaterThan(0);

      // And a media row is waiting for the bytes, which is what makes the stage
      // rail read "getting your video" without a second source of truth.
      const media = await prisma.mediaAsset.findFirstOrThrow({
        where: { projectId: response.projectId },
      });
      expect(media.status).toBe("pending");
      expect(media.storageKey).toBe(params.destination.key);
    });

    it("queues nothing for an upload, which brings its own bytes", async () => {
      await service.create(WORKSPACE_A, USER_A, { source: UPLOAD_SOURCE, setup: SETUP });
      expect(enqueued).toHaveLength(0);
    });

    it("leaves nothing behind when the download cannot be queued", async () => {
      // Admission control refusing is the realistic case. The project row already
      // exists by then, so without compensation a workspace at its limit collects
      // an empty titled project every time it pastes a link.
      await setFlag("source_youtube_acquire", true);
      enqueueFailure = new Error("jobs/admission_denied");

      await expect(
        service.create(WORKSPACE_A, USER_A, { source: {
          kind: "url",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          rightsAttested: true,
        }, setup: SETUP }),
      ).rejects.toThrow("jobs/admission_denied");

      expect(await prisma.repurposeRun.count()).toBe(0);
      const project = await prisma.project.findUniqueOrThrow({
        where: { id: created[0]?.projectId ?? "" },
      });
      expect(project.deletedAt).not.toBeNull();
    });

    it("still refuses a direct file link, even with acquisition switched on", async () => {
      // The flag turns on the PROVIDER path. A direct media URL is an arbitrary
      // host the caller chose, and pointing a downloader running on our own
      // machine at one needs an egress policy that does not exist yet.
      await setFlag("source_youtube_acquire", true);

      await expect(
        service.create(WORKSPACE_A, USER_A, {
          source: {
            kind: "url",
            url: "https://cdn.example.test/videos/ep12.mp4",
            rightsAttested: true,
          },
          setup: SETUP,
        }),
      ).rejects.toMatchObject({ code: "repurpose/source_unsupported" });

      expect(enqueued).toHaveLength(0);
      expect(created).toHaveLength(0);
    });
  });

  describe("the stage a person is shown", () => {
    /** Put a media row on the run's source project, as the upload pipeline would. */
    async function attachMedia(projectId: string, status: string, suffix: string): Promise<void> {
      await prisma.mediaAsset.create({
        data: {
          id: id(`M${suffix}`),
          projectId,
          role: "primary",
          storageKey: `ws/x/p/${projectId}/media/m/raw.mp4`,
          status: status as "pending",
        },
      });
    }

    it("stays on the first stage while there is nothing to work on", async () => {
      const run = await service.create(WORKSPACE_A, USER_A, {
        source: UPLOAD_SOURCE,
        setup: SETUP,
      });
      const detail = await service.get(WORKSPACE_A, run.run.id);
      expect(detail.status).toBe("draft");
      expect(detail.currentStage).toBe("getting_video");
    });

    it("follows the source project through the existing media pipeline", async () => {
      // The run's own `status` column never moves here — no producer exists yet.
      // What moves is the SOURCE PROJECT, because it is an ordinary project and
      // the existing pipeline is already working on it. §4.2 says to derive the
      // visible progress from the child records rather than store it twice, and
      // this is why: without it the rail would say "Add a video to get started"
      // while the video was demonstrably being transcribed.
      const run = await service.create(WORKSPACE_A, USER_A, {
        source: UPLOAD_SOURCE,
        setup: SETUP,
      });
      const projectId = created[0]?.projectId ?? "";

      await attachMedia(projectId, "uploading", "01");
      expect((await service.get(WORKSPACE_A, run.run.id)).currentStage).toBe("getting_video");

      await prisma.mediaAsset.update({
        where: { id: id("M01") },
        data: { status: "probing" },
      });
      let detail = await service.get(WORKSPACE_A, run.run.id);
      expect(detail.status).toBe("preparing_media");
      expect(detail.message).toBe("Preparing audio and preview.");

      await prisma.mediaAsset.update({ where: { id: id("M01") }, data: { status: "ready" } });
      detail = await service.get(WORKSPACE_A, run.run.id);
      expect(detail.status).toBe("transcribing");
      expect(detail.currentStage).toBe("finding_clips");

      await prisma.transcript.create({
        data: { id: id("TR1"), projectId, language: "hi-Latn" },
      });
      detail = await service.get(WORKSPACE_A, run.run.id);
      expect(detail.status).toBe("analyzing");
      expect(detail.message).toBe("Finding promising moments.");

      // And the stored column is untouched throughout: the derivation is a view,
      // not a second writer racing the producers that arrive in later waves.
      const stored = await prisma.repurposeRun.findUniqueOrThrow({ where: { id: run.run.id } });
      expect(stored.status).toBe("draft");
    });

    it("shows the same derived stage on the list as on the run's own page", async () => {
      // The home page pipeline banner reads `list()`, not `get()`. Before this
      // test existed, `list()` returned the raw stored `status` — always
      // "draft" here — so the banner said "Add a video to get started" for a
      // run whose transcript had already landed, while the run's own page
      // (which does derive it) said "Finding promising moments." Two surfaces
      // disagreeing about the same run is exactly what §4.2 warns against.
      const run = await service.create(WORKSPACE_A, USER_A, {
        source: UPLOAD_SOURCE,
        setup: SETUP,
      });
      const projectId = created[0]?.projectId ?? "";

      await attachMedia(projectId, "ready", "03");
      await prisma.transcript.create({
        data: { id: id("TR3"), projectId, language: "hi-Latn" },
      });

      const detail = await service.get(WORKSPACE_A, run.run.id);
      expect(detail.status).toBe("analyzing");
      expect(detail.currentStage).toBe("finding_clips");

      const listed = await service.list(WORKSPACE_A, { limit: 20 });
      const item = listed.items.find((entry) => entry.id === run.run.id);
      expect(item?.status).toBe("analyzing");
      expect(item?.currentStage).toBe("finding_clips");
      expect(item?.message).toBe("Finding promising moments.");
    });

    it("never walks a cancelled or failed run forwards", async () => {
      const run = await service.create(WORKSPACE_A, USER_A, {
        source: UPLOAD_SOURCE,
        setup: SETUP,
      });
      const projectId = created[0]?.projectId ?? "";
      await attachMedia(projectId, "ready", "02");
      await service.cancel(WORKSPACE_A, USER_A, run.run.id);

      const detail = await service.get(WORKSPACE_A, run.run.id);
      expect(detail.status).toBe("cancelled");
      expect(detail.message).toContain("stopped");
    });
  });

  describe("the upload ticket", () => {
    it("is issued by default, for a caller with no upload pipeline of its own", async () => {
      const response = await service.create(WORKSPACE_A, USER_A, {
        source: UPLOAD_SOURCE,
        setup: SETUP,
      });
      expect(response.upload).not.toBeNull();
    });

    it("is declined by a caller that owns one, so no orphan media row is left", async () => {
      // The web app hands the file to the existing upload queue, and that queue
      // calls `media/init` itself. Asking for a ticket we would then ignore
      // leaves a `pending` media row behind every single upload.
      const response = await service.create(WORKSPACE_A, USER_A, {
        source: { ...UPLOAD_SOURCE, issueUploadTicket: false },
        setup: SETUP,
      });
      expect(response.upload).toBeNull();
      expect(response.projectId).toBe(created[0]?.projectId);
      expect(
        await prisma.mediaAsset.count({ where: { projectId: response.projectId } }),
      ).toBe(0);
    });
  });

  describe("the workspace boundary", () => {
    it("never returns, cancels or retries another workspace's run", async () => {
      const mine = await service.create(WORKSPACE_A, USER_A, {
        source: UPLOAD_SOURCE,
        setup: SETUP,
      });

      // Not "forbidden": a tenant must not learn that an id exists at all.
      await expect(service.get(WORKSPACE_B, mine.run.id)).rejects.toMatchObject({
        code: "repurpose/not_found",
      });
      await expect(service.cancel(WORKSPACE_B, USER_B, mine.run.id)).rejects.toMatchObject({
        code: "repurpose/not_found",
      });
      await expect(service.retry(WORKSPACE_B, USER_B, mine.run.id)).rejects.toMatchObject({
        code: "repurpose/not_found",
      });

      const theirs = await service.list(WORKSPACE_B, { limit: 20 });
      expect(theirs.items).toHaveLength(0);
    });

    it("lists only this workspace's runs, newest first, with a cursor", async () => {
      for (let index = 0; index < 3; index += 1) {
        await service.create(WORKSPACE_A, USER_A, { source: UPLOAD_SOURCE, setup: SETUP });
      }
      await service.create(WORKSPACE_B, USER_B, { source: UPLOAD_SOURCE, setup: SETUP });

      const firstPage = await service.list(WORKSPACE_A, { limit: 2 });
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.nextCursor).not.toBeNull();
      expect(firstPage.items.every((run) => run.workspaceId === WORKSPACE_A)).toBe(true);

      const secondPage = await service.list(WORKSPACE_A, {
        limit: 2,
        cursor: firstPage.nextCursor ?? undefined,
      });
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.nextCursor).toBeNull();

      const ids = [...firstPage.items, ...secondPage.items].map((run) => run.id);
      expect(new Set(ids).size).toBe(3);
      expect([...ids].sort().reverse()).toEqual(ids);
    });
  });

  describe("cancel and retry", () => {
    it("stops a run, keeps the stage it stopped on, and is safe to repeat", async () => {
      const run = await service.create(WORKSPACE_A, USER_A, {
        source: UPLOAD_SOURCE,
        setup: SETUP,
      });

      const cancelled = await service.cancel(WORKSPACE_A, USER_A, run.run.id);
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.canCancel).toBe(false);
      expect(cancelled.currentStage).toBe("getting_video");

      // Cancelling twice is what a double-clicked button does. It is not an error.
      const again = await service.cancel(WORKSPACE_A, USER_A, run.run.id);
      expect(again.status).toBe("cancelled");

      const stored = await prisma.repurposeRun.findUniqueOrThrow({ where: { id: run.run.id } });
      expect(stored.cancelledAt).not.toBeNull();
    });

    it("freezes on the stage it had actually reached, not the stage the stored column never left", async () => {
      // `run.status` never moves past "draft" for the early stages -- the same
      // fact "the stage a person is shown" tests above exist to pin -- so a run
      // that had visibly reached "Finding promising moments" was, until this
      // fix, cancelled straight back to "Add video": `cancel()` froze the rail
      // on `stageForStatus(run.status)`, the raw stored (and stale) status,
      // instead of the same observed status the run's own page was showing the
      // person the moment they clicked Stop.
      const run = await service.create(WORKSPACE_A, USER_A, {
        source: UPLOAD_SOURCE,
        setup: SETUP,
      });
      const projectId = created.at(-1)?.projectId ?? "";
      await prisma.mediaAsset.create({
        data: {
          id: id("M04"),
          projectId,
          role: "primary",
          storageKey: `ws/x/p/${projectId}/media/m/raw.mp4`,
          status: "ready",
        },
      });
      await prisma.transcript.create({
        data: { id: id("TR4"), projectId, language: "hi-Latn" },
      });
      expect((await service.get(WORKSPACE_A, run.run.id)).currentStage).toBe("finding_clips");

      const cancelled = await service.cancel(WORKSPACE_A, USER_A, run.run.id);
      expect(cancelled.currentStage).toBe("finding_clips");

      const stored = await prisma.repurposeRun.findUniqueOrThrow({ where: { id: run.run.id } });
      expect(stored.currentStage).toBe("finding_clips");
    });

    it("refuses to cancel a finished run", async () => {
      const run = await service.create(WORKSPACE_A, USER_A, {
        source: UPLOAD_SOURCE,
        setup: SETUP,
      });
      await prisma.repurposeRun.update({
        where: { id: run.run.id },
        data: { status: "published", completedAt: new Date() },
      });

      await expect(service.cancel(WORKSPACE_A, USER_A, run.run.id)).rejects.toMatchObject({
        code: "repurpose/not_cancellable",
      });
    });

    it("refuses a retry that would collide with a newer run for the same video", async () => {
      await setFlag("source_youtube_acquire", true);
      const source = {
        kind: "url",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        rightsAttested: true,
      } as const;

      const first = await service.create(WORKSPACE_A, USER_A, { source, setup: SETUP });
      await prisma.repurposeRun.update({
        where: { id: first.run.id },
        data: { status: "failed", failureCode: "repurpose/source_unavailable" },
      });

      // A failed run is outside the live-source set, so the same video may be
      // started again - which is deliberate.
      const second = await service.create(WORKSPACE_A, USER_A, { source, setup: SETUP });

      // Retrying the first would now put two live runs on one fingerprint. That
      // must be our sentence, not a raw database conflict.
      await expect(service.retry(WORKSPACE_A, USER_A, first.run.id)).rejects.toMatchObject({
        code: "repurpose/source_already_running",
      });

      // Once the newer one is out of the way, the retry goes through - and it
      // really fetches again (2026-09-26: it used to reset the row and queue
      // nothing, so the run sat "in progress" forever).
      await service.cancel(WORKSPACE_A, USER_A, second.run.id);
      await expect(service.retry(WORKSPACE_A, USER_A, first.run.id)).resolves.toMatchObject({
        status: "acquiring",
        failureCode: null,
      });
    });

    it("retries only a failed run, and clears its failure", async () => {
      const run = await service.create(WORKSPACE_A, USER_A, {
        source: UPLOAD_SOURCE,
        setup: SETUP,
      });

      // A cancelled run is a decision, not an error: there is nothing to retry.
      await service.cancel(WORKSPACE_A, USER_A, run.run.id);
      await expect(service.retry(WORKSPACE_A, USER_A, run.run.id)).rejects.toMatchObject({
        code: "repurpose/not_retryable",
      });

      await prisma.repurposeRun.update({
        where: { id: run.run.id },
        data: { status: "failed", failureCode: "repurpose/source_unavailable" },
      });

      const retried = await service.retry(WORKSPACE_A, USER_A, run.run.id);
      expect(retried.status).toBe("draft");
      expect(retried.failureCode).toBeNull();
      expect(audited.at(-1)?.action).toBe("repurpose.run.retried");
    });
  });

  describe("what a person is shown", () => {
    it("carries no queue name, job id, provider name or codename", async () => {
      const run = await service.create(WORKSPACE_A, USER_A, {
        source: UPLOAD_SOURCE,
        setup: SETUP,
      });
      const detail = await service.get(WORKSPACE_A, run.run.id);

      const words = [
        detail.message,
        ...detail.stages.map((stage) => stage.label),
        ...published.map((entry) => String(entry.data["message"])),
      ];
      for (const text of words) {
        expect(beginnerSafetyViolations(text), text).toEqual([]);
      }
    });

    it("describes all five stages, with the first one running", async () => {
      const run = await service.create(WORKSPACE_A, USER_A, {
        source: UPLOAD_SOURCE,
        setup: SETUP,
      });
      const detail = await service.get(WORKSPACE_A, run.run.id);

      expect(detail.stages.map((stage) => stage.stage)).toEqual([
        "getting_video",
        "finding_clips",
        "styles_formats",
        "review",
        "publish",
      ]);
      expect(detail.stages[0]?.state).toBe("running");
      expect(detail.stages.slice(1).every((stage) => stage.state === "waiting")).toBe(true);
      expect(detail.candidateCount).toBe(0);
      expect(detail.clipCount).toBe(0);
      expect(detail.variantCount).toBe(0);
    });
  });

  describe("stuck runs scheduled sweep (CORE-023)", () => {
    it("(a) a run truly stuck in finding_clips past its deadline is failed and only its own hold is released", async () => {
      const run = await service.create(WORKSPACE_A, USER_A, {
        source: UPLOAD_SOURCE,
        setup: SETUP,
      });

      const fortyFiveMinutesAgo = new Date(Date.now() - 45 * 60 * 1000);

      // Simulate the run being on "Finding promising moments" (analyzing) past the deadline
      await prisma.repurposeRun.update({
        where: { id: run.run.id },
        data: {
          status: "analyzing",
          currentStage: "finding_clips",
          createdAt: fortyFiveMinutesAgo,
          updatedAt: fortyFiveMinutesAgo,
        },
      });
      await prisma.mediaAsset.updateMany({
        where: { projectId: run.run.sourceProjectId },
        data: {
          status: "ready",
          createdAt: fortyFiveMinutesAgo,
          uploadedAt: fortyFiveMinutesAgo,
        },
      });

      // Simulate a job with a credit hold owned by this run
      const jobId = id("JOBHOLD");
      const holdId = id("HOLD01");
      await prisma.job.create({
        data: {
          id: jobId,
          workspaceId: WORKSPACE_A,
          projectId: run.run.sourceProjectId,
          type: "ai.highlights",
          status: "running",
          priority: 3,
          jobKey: `ai.highlights:${run.run.id}`,
          params: { runId: run.run.id },
          attemptId: id("ATT01"),
          attemptNo: 1,
          creditHoldId: holdId,
          creditsChargedTenths: 10,
          queuedAt: fortyFiveMinutesAgo,
          startedAt: fortyFiveMinutesAgo,
        },
      });

      await prisma.creditAccount.upsert({
        where: { workspaceId: WORKSPACE_A },
        create: { id: id("ACC01"), workspaceId: WORKSPACE_A, balanceTenths: 1000 },
        update: {},
      });
      await prisma.creditHold.create({
        data: {
          id: holdId,
          accountId: id("ACC01"),
          jobId,
          amountTenths: 10,
          status: "held",
          at: fortyFiveMinutesAgo,
        },
      });

      // Run the sweep
      const report = await service.sweepStuckRuns(new Date());

      expect(report.failedRuns).toContain(run.run.id);
      expect(report.releasedHolds).toContain(holdId);
      expect(releasedCreditHolds).toContain(holdId);

      // Verify the run moved to terminal failed state with customer-readable reason
      const updatedRun = await service.get(WORKSPACE_A, run.run.id);
      expect(updatedRun.status).toBe("failed");
      expect(updatedRun.failureCode).toBe("repurpose/stage_timeout");
      expect(updatedRun.currentStage).toBe("finding_clips");
      expect(updatedRun.message).toBe("Something went wrong. Your work is safe.");
      expect(beginnerSafetyViolations(updatedRun.message)).toEqual([]);

      // Verify realtime event was published with customer-readable message
      const stageEvent = [...published]
        .reverse()
        .find(
          (e) => e.event === "repurpose.stage.changed" && e.data["runId"] === run.run.id,
        );
      expect(stageEvent).toBeDefined();
      expect(stageEvent?.data["status"]).toBe("failed");
      expect(stageEvent?.data["message"]).toBe(
        "This stage took longer than expected. Your work is safe.",
      );
      expect(beginnerSafetyViolations(String(stageEvent?.data["message"]))).toEqual([]);

      // Verify in-flight job was cancelled
      const job = await prisma.job.findUnique({ where: { id: jobId } });
      expect(job?.status).toBe("cancelled");
    });

    it("(b) a draft waiting 2 hours for an upload is NOT failed", async () => {
      const run = await service.create(WORKSPACE_A, USER_A, {
        source: UPLOAD_SOURCE,
        setup: SETUP,
      });

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

      await prisma.repurposeRun.update({
        where: { id: run.run.id },
        data: {
          createdAt: twoHoursAgo,
          updatedAt: twoHoursAgo,
        },
      });
      await prisma.mediaAsset.updateMany({
        where: { projectId: run.run.sourceProjectId },
        data: {
          status: "pending",
          createdAt: twoHoursAgo,
        },
      });

      const report = await service.sweepStuckRuns(new Date());

      expect(report.failedRuns).not.toContain(run.run.id);

      const currentRun = await service.get(WORKSPACE_A, run.run.id);
      expect(currentRun.status).toBe("draft");
      expect(currentRun.failureCode).toBeNull();
    });

    it("(c) a run whose transcription is still progressing is NOT failed", async () => {
      const run = await service.create(WORKSPACE_A, USER_A, {
        source: UPLOAD_SOURCE,
        setup: SETUP,
      });

      const fiftyMinutesAgo = new Date(Date.now() - 50 * 60 * 1000);
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

      await prisma.repurposeRun.update({
        where: { id: run.run.id },
        data: {
          createdAt: fiftyMinutesAgo,
          updatedAt: fiftyMinutesAgo,
        },
      });
      await prisma.mediaAsset.updateMany({
        where: { projectId: run.run.sourceProjectId },
        data: {
          status: "ready",
          createdAt: fiftyMinutesAgo,
          uploadedAt: new Date(Date.now() - 45 * 60 * 1000),
        },
      });

      const transcriptId = id("TR01");
      await prisma.transcript.create({
        data: {
          id: transcriptId,
          projectId: run.run.sourceProjectId,
          language: "hi",
          createdAt: new Date(Date.now() - 35 * 60 * 1000),
        },
      });
      await prisma.transcriptChunk.create({
        data: {
          id: id("TC01"),
          transcriptId,
          revision: 1,
          chunkIdx: 0,
          startMs: 0,
          endMs: 5000,
          createdAt: twoMinutesAgo,
        },
      });

      const report = await service.sweepStuckRuns(new Date());

      expect(report.failedRuns).not.toContain(run.run.id);

      const currentRun = await service.get(WORKSPACE_A, run.run.id);
      expect(currentRun.status).not.toBe("failed");
      expect(currentRun.failureCode).toBeNull();
    });

    it("(d) an unrelated export job with a held credit hold on the same project is untouched", async () => {
      const run = await service.create(WORKSPACE_A, USER_A, {
        source: UPLOAD_SOURCE,
        setup: SETUP,
      });

      const fortyFiveMinutesAgo = new Date(Date.now() - 45 * 60 * 1000);

      await prisma.repurposeRun.update({
        where: { id: run.run.id },
        data: {
          status: "analyzing",
          currentStage: "finding_clips",
          createdAt: fortyFiveMinutesAgo,
          updatedAt: fortyFiveMinutesAgo,
        },
      });
      await prisma.mediaAsset.updateMany({
        where: { projectId: run.run.sourceProjectId },
        data: {
          status: "ready",
          createdAt: fortyFiveMinutesAgo,
          uploadedAt: fortyFiveMinutesAgo,
        },
      });

      // Run's own job with a held credit hold
      const runJobId = id("RJ01");
      const runHoldId = id("RHOLD1");
      await prisma.job.create({
        data: {
          id: runJobId,
          workspaceId: WORKSPACE_A,
          projectId: run.run.sourceProjectId,
          type: "ai.highlights",
          status: "running",
          priority: 3,
          jobKey: `ai.highlights:${run.run.id}`,
          params: { runId: run.run.id },
          attemptId: id("ATT03"),
          attemptNo: 1,
          creditHoldId: runHoldId,
          creditsChargedTenths: 10,
          queuedAt: fortyFiveMinutesAgo,
          startedAt: fortyFiveMinutesAgo,
        },
      });

      await prisma.creditAccount.upsert({
        where: { workspaceId: WORKSPACE_A },
        create: { id: id("ACC01"), workspaceId: WORKSPACE_A, balanceTenths: 1000 },
        update: {},
      });
      await prisma.creditHold.create({
        data: {
          id: runHoldId,
          accountId: id("ACC01"),
          jobId: runJobId,
          amountTenths: 10,
          status: "held",
          at: fortyFiveMinutesAgo,
        },
      });

      // Unrelated export job on the SAME project with a held credit hold
      const exportJobId = id("EXPJ01");
      const exportHoldId = id("EXPH01");
      await prisma.job.create({
        data: {
          id: exportJobId,
          workspaceId: WORKSPACE_A,
          projectId: run.run.sourceProjectId,
          type: "export.cloud",
          status: "running",
          priority: 2,
          jobKey: `export:${run.run.sourceProjectId}:cloud`,
          params: { exportId: id("EXP01") },
          attemptId: id("ATTEXP"),
          attemptNo: 1,
          creditHoldId: exportHoldId,
          creditsChargedTenths: 50,
          queuedAt: fortyFiveMinutesAgo,
          startedAt: fortyFiveMinutesAgo,
        },
      });
      await prisma.creditHold.create({
        data: {
          id: exportHoldId,
          accountId: id("ACC01"),
          jobId: exportJobId,
          amountTenths: 50,
          status: "held",
          at: fortyFiveMinutesAgo,
        },
      });

      const report = await service.sweepStuckRuns(new Date());

      // The stuck run failed
      expect(report.failedRuns).toContain(run.run.id);

      // ONLY the run's own hold was released
      expect(report.releasedHolds).toContain(runHoldId);
      expect(report.releasedHolds).not.toContain(exportHoldId);
      expect(releasedCreditHolds).not.toContain(exportHoldId);

      // Unrelated export job is still running and untouched
      const exportJob = await prisma.job.findUnique({ where: { id: exportJobId } });
      expect(exportJob?.status).toBe("running");

      // Unrelated export hold is still "held"
      const exportHold = await prisma.creditHold.findUnique({ where: { id: exportHoldId } });
      expect(exportHold?.status).toBe("held");
    });

    it("(e) a late highlights completion for a failed run changes nothing", async () => {
      const run = await service.create(WORKSPACE_A, USER_A, {
        source: UPLOAD_SOURCE,
        setup: SETUP,
      });

      // Mark the run failed
      await prisma.repurposeRun.update({
        where: { id: run.run.id },
        data: {
          status: "failed",
          failureCode: "repurpose/stage_timeout",
        },
      });

      const highlightsHandler = new RepurposeHighlightsCompletionHandler(
        prisma as unknown as PrismaService,
        service,
        { register: () => {} } as unknown as JobCompletionRegistry,
        { publish: async () => {} } as unknown as RealtimePublisher,
      );

      const outcome = await highlightsHandler.handle({
        job: {
          id: id("JHLA01"),
          workspaceId: WORKSPACE_A,
          projectId: run.run.sourceProjectId,
          type: "ai.highlights",
          params: { runId: run.run.id },
          creditHoldId: id("HOLD99"),
        } as unknown as Job,
        attemptId: id("ATTHL"),
        result: {
          schemaVersion: 1,
          runId: run.run.id,
          transcriptId: id("TR01"),
          transcriptRevision: 1,
          promptVersion: "highlights-v1",
          featureVersion: "features-v1",
          model: "test-model",
          windowsConsidered: 10,
          proposals: [
            {
              windowId: "w-01",
              startMs: 1000,
              endMs: 15000,
              startWordId: "0:0",
              endWordId: "0:10",
              title: "Late Proposal",
              transcriptExcerpt: "excerpt",
              potentialScore: 85,
              scoreBreakdown: {
                hook: 80,
                clarity: 80,
                emotion: 80,
                visualActivity: 80,
                novelty: 80,
                standaloneValue: 80,
                safety: 100,
              },
              reasons: [{ label: "hook", explanation: "Great hook" }],
            },
          ],
        },
        usage: undefined,
      } as unknown as JobCompletionContext);

      expect(outcome.actualTenths).toBe(0);
      expect((outcome.data as { applied: boolean })?.applied).toBe(false);

      // Verify run status was NOT updated to candidates_ready
      const currentRun = await prisma.repurposeRun.findUnique({ where: { id: run.run.id } });
      expect(currentRun?.status).toBe("failed");

      // Verify no candidates were inserted
      const candidateCount = await prisma.clipCandidate.count({ where: { runId: run.run.id } });
      expect(candidateCount).toBe(0);
    });
  });
});
