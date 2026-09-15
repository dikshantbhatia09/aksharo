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
import { beginnerSafetyViolations } from "../src/repurpose/repurpose.projection.js";
import { RepurposeService } from "../src/repurpose/repurpose.service.js";
import { EntitlementService } from "../src/workspaces/entitlement.service.js";
import { workspacesRedisKeys } from "../src/workspaces/workspaces.constants.js";

import type { TestDatabase } from "./db-harness.js";
import type { CommonAuditService } from "../src/common/audit/audit.service.js";
import type { PrismaService } from "../src/common/prisma/prisma.service.js";
import type { RedisService } from "../src/common/redis/redis.service.js";
import type { MediaService } from "../src/media/media.service.js";
import type { ProjectsService } from "../src/projects/projects.service.js";
import type { RealtimePublisher } from "../src/realtime/realtime.publisher.js";
import type { StylesService } from "../src/styles/styles.service.js";
import type { PrismaClient } from "@prisma/client";
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
  } as unknown as MediaService;
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

  return new RepurposeService(
    prisma as unknown as PrismaService,
    fakeProjects(),
    fakeMedia(),
    fakeStyles(),
    entitlements,
    audit,
    realtime,
    env,
  );
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
        { FEATURE_FLAGS_JSON: { repurpose_flow: false } } as unknown as Env,
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

      // Once the newer one is out of the way, the retry goes through.
      await service.cancel(WORKSPACE_A, USER_A, second.run.id);
      await expect(service.retry(WORKSPACE_A, USER_A, first.run.id)).resolves.toMatchObject({
        status: "draft",
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
});
