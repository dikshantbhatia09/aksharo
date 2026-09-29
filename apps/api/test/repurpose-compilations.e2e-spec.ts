/**
 * Compilations (2026-10-03) against a real PostgreSQL.
 *
 * `RepurposeCompilationsService` and its completion handler are driven
 * directly, the way `repurpose-runs.e2e-spec.ts` drives the run service: the
 * claims worth proving here are about the database - the migration, the one
 * compilation per request, the export row the file is filed as and its foreign
 * key, and the workspace boundary. The job queue, the audit sink and the object
 * store are stood in for; the store is an in-memory fake, so nothing here ever
 * reaches the object store the environment names.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";
import { RenderCompilationPayloadSchema } from "@montaj/repurpose-contracts";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { RepurposeCompilationCompletionHandler } from "../src/repurpose/compilation-completion.handler.js";
import { COMPILATION_ERRORS } from "../src/repurpose/compilations.dto.js";
import { RepurposeCompilationsService } from "../src/repurpose/compilations.service.js";

import type { TestDatabase } from "./db-harness.js";
import type { JobCompletionContext } from "../src/jobs/completion-handlers.js";
import type { Job, PrismaClient } from "@prisma/client";

const available = isDatabaseAvailable();
if (!available) {
  console.warn(`[repurpose-compilations.e2e] SKIPPED - no test database. Reason: ${skipReason}`);
}

const ULID_BASE = "01JT0000000000000000000000";
function id(suffix: string): string {
  return (ULID_BASE.slice(0, 26 - suffix.length) + suffix).toUpperCase();
}

const USER = id("U1");
const WS = id("W1");
const OTHER_WS = id("W2");
const OTHER_USER = id("U2");
const SOURCE = id("P1");
const RUN = id("R1");

let db: TestDatabase;
let prisma: PrismaClient;
let jobSeq = 0;
const cancelled: string[] = [];
const deleted: string[] = [];

/** The queue, standing in: every enqueue is a real `jobs` row (exports point at it). */
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
    cancel: async (jobId: string) => {
      cancelled.push(jobId);
      return prisma.job.update({ where: { id: jobId }, data: { status: "cancelled" } });
    },
  };
}

const store = {
  presignGet: async (key: string) => `https://files.test/${key}`,
  delete: async (key: string) => {
    deleted.push(key);
  },
};

function service(): RepurposeCompilationsService {
  return new RepurposeCompilationsService(
    prisma as never,
    fakeJobs() as never,
    {} as never,
    { record: async () => undefined } as never,
    { FEATURE_FLAGS_JSON: { repurpose_flow: true } } as unknown as Env,
    store as never,
  );
}

function handler(): RepurposeCompilationCompletionHandler {
  return new RepurposeCompilationCompletionHandler(
    prisma as never,
    { register: () => undefined } as never,
    store as never,
  );
}

/** A made clip: its moment, its 9:16 project and variant, and a captioned export. */
async function madeClip(n: number, startMs: number, durationMs: number): Promise<string> {
  const candidateId = id(`C${String(n)}`);
  const clipId = id(`K${String(n)}`);
  const projectId = id(`KP${String(n)}`);
  const exportId = id(`KE${String(n)}`);
  await prisma.clipCandidate.create({
    data: {
      id: candidateId,
      runId: RUN,
      source: "ai",
      rank: n,
      startMs,
      endMs: startMs + durationMs,
      title: `Moment ${String(n)}`,
      potentialScore: 80,
    },
  });
  await prisma.repurposeClip.create({
    data: {
      id: clipId,
      runId: RUN,
      candidateId,
      title: `Moment ${String(n)}`,
      sourceStartMs: startMs,
      sourceEndMs: startMs + durationMs,
      mezzanineKey: `ws/${WS}/p/${SOURCE}/repurpose/${RUN}/clips/${candidateId}/master.mp4`,
    },
  });
  await prisma.project.create({
    data: { id: projectId, workspaceId: WS, title: `Clip ${String(n)}` },
  });
  await prisma.export.create({
    data: {
      id: exportId,
      workspaceId: WS,
      projectId,
      status: "succeeded",
      kind: "mp4",
      bucket: "r2",
      storageKey: `ws/${WS}/p/${projectId}/exports/${exportId}.mp4`,
      durationMs,
      watermarked: true,
    },
  });
  await prisma.clipVariant.create({
    data: {
      id: id(`KV${String(n)}`),
      clipId,
      projectId,
      aspect: "r9x16",
      status: "ready",
      latestExportId: exportId,
    },
  });
  return clipId;
}

describe.skipIf(!available)("compilations against PostgreSQL (2026-10-03)", () => {
  let clipA: string;
  let clipB: string;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (created === null) throw new Error(`no test database: ${skipReason}`);
    db = created;
    prisma = db.prisma;
    await prisma.user.create({ data: { id: USER, email: "comp-a@example.test", name: "A" } });
    await prisma.user.create({ data: { id: OTHER_USER, email: "comp-b@example.test", name: "B" } });
    await prisma.workspace.create({
      data: { id: WS, slug: "comp-a", name: "A", ownerId: USER, billingCountry: "IN" },
    });
    await prisma.workspace.create({
      data: { id: OTHER_WS, slug: "comp-b", name: "B", ownerId: OTHER_USER, billingCountry: "IN" },
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
      },
    });
    clipA = await madeClip(1, 10_000, 30_000);
    clipB = await madeClip(2, 60_000, 28_000);
  });

  afterAll(async () => {
    await db?.stop();
  });

  let compilationId: string;

  it("files the compilation as an export of the source project and asks for its render", async () => {
    const { compilation, created } = await service().create(WS, USER, RUN, {
      clipIds: [clipB, clipA],
      shape: "9:16",
      title: "Best of",
    });
    compilationId = compilation.id;
    expect(created).toBe(true);
    expect(compilation).toMatchObject({ status: "rendering", durationMs: 58_000 + 2_000 - 1_000 });

    const row = await prisma.repurposeCompilation.findUniqueOrThrow({
      where: { id: compilation.id },
    });
    expect(row).toMatchObject({
      aspect: "r9x16",
      title: "Best of",
      attempts: 1,
      status: "rendering",
    });
    expect(row.clipIds).toEqual([clipB, clipA]);
    expect(row.sources).toEqual([
      { clipId: clipB, exportId: id("KE2"), durationMs: 28_000 },
      { clipId: clipA, exportId: id("KE1"), durationMs: 30_000 },
    ]);
    const exported = await prisma.export.findUniqueOrThrow({ where: { id: row.exportId ?? "" } });
    expect(exported).toMatchObject({
      projectId: SOURCE,
      status: "rendering",
      preset: "compilation-9x16",
      watermarked: true,
      jobId: row.jobId,
    });
    const job = await prisma.job.findUniqueOrThrow({ where: { id: row.jobId ?? "" } });
    expect(job.type).toBe("render.compilation");
    expect(RenderCompilationPayloadSchema.parse(job.params).exportId).toBe(exported.id);
  });

  it("answers the same request with the same compilation", async () => {
    const again = await service().create(WS, USER, RUN, {
      clipIds: [clipB, clipA],
      shape: "9:16",
      title: "  Best   of ",
    });
    expect(again.created).toBe(false);
    expect(again.compilation.id).toBe(compilationId);
    expect(await prisma.repurposeCompilation.count({ where: { runId: RUN } })).toBe(1);
  });

  it("is made once its completion lands: the file, its seven days, and ready", async () => {
    const row = await prisma.repurposeCompilation.findUniqueOrThrow({
      where: { id: compilationId },
    });
    const job = await prisma.job.findUniqueOrThrow({ where: { id: row.jobId ?? "" } });
    const outputKey = `ws/${WS}/p/${SOURCE}/exports/${row.exportId ?? ""}.mp4`;
    const outcome = await handler().handle({
      job,
      attemptId: id("AT1"),
      result: {
        schemaVersion: 1,
        compilationId,
        exportId: row.exportId,
        outputKey,
        outputMs: 59_033,
        sizeBytes: 9_000_000,
        width: 1080,
        height: 1920,
        fps: 30,
        clips: 2,
        intro: true,
      },
      usage: undefined,
      completion: { status: "succeeded" },
    } as JobCompletionContext);
    expect(outcome.actualTenths).toBeGreaterThan(0);

    const exported = await prisma.export.findUniqueOrThrow({ where: { id: row.exportId ?? "" } });
    expect(exported).toMatchObject({
      status: "succeeded",
      storageKey: outputKey,
      durationMs: 59_033,
    });
    expect(exported.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3_600_000);
    const [view] = (await service().list(WS, RUN)).compilations;
    expect(view).toMatchObject({
      status: "ready",
      durationMs: 59_033,
      stale: false,
      playUrl: `https://files.test/${outputKey}`,
    });
  });

  it("is stale once a clip's captioned video is made again, and is made again from it", async () => {
    // Clip A's captions were edited: a new captioned export replaced its old one.
    const newer = id("KE1B");
    await prisma.export.create({
      data: {
        id: newer,
        workspaceId: WS,
        projectId: id("KP1"),
        status: "succeeded",
        kind: "mp4",
        bucket: "r2",
        storageKey: `ws/${WS}/p/${id("KP1")}/exports/${newer}.mp4`,
        durationMs: 29_000,
        watermarked: true,
      },
    });
    await prisma.clipVariant.update({ where: { id: id("KV1") }, data: { latestExportId: newer } });
    const [stale] = (await service().list(WS, RUN)).compilations;
    expect(stale).toMatchObject({ stale: true, canRetry: true });

    const before = await prisma.repurposeCompilation.findUniqueOrThrow({
      where: { id: compilationId },
    });
    const again = await service().retry(WS, USER, RUN, compilationId);
    expect(again.status).toBe("rendering");
    // The earlier file and its export went; the new attempt has its own.
    expect(deleted).toContain(`ws/${WS}/p/${SOURCE}/exports/${before.exportId ?? ""}.mp4`);
    expect(await prisma.export.findUnique({ where: { id: before.exportId ?? "" } })).toBeNull();
    const after = await prisma.repurposeCompilation.findUniqueOrThrow({
      where: { id: compilationId },
    });
    expect(after.exportId).not.toBe(before.exportId);
    expect(after.attempts).toBe(2);
    expect(after.sources).toContainEqual({ clipId: clipA, exportId: newer, durationMs: 29_000 });
  });

  it("marks the attempt failed on a terminal failure, in the page's words", async () => {
    const row = await prisma.repurposeCompilation.findUniqueOrThrow({
      where: { id: compilationId },
    });
    const job = await prisma.job.findUniqueOrThrow({ where: { id: row.jobId ?? "" } });
    await handler().handleFailure({
      job,
      attemptId: id("AT2"),
      result: {},
      usage: undefined,
      completion: {
        status: "failed",
        error: { code: "storage/unreadable", message: "gone", retryable: true },
        finalAttempt: true,
      },
    } as JobCompletionContext);
    const failed = await prisma.repurposeCompilation.findUniqueOrThrow({
      where: { id: compilationId },
    });
    expect(failed).toMatchObject({ status: "failed", failureCode: COMPILATION_ERRORS.sourceGone });
    expect(
      (await prisma.export.findUniqueOrThrow({ where: { id: row.exportId ?? "" } })).status,
    ).toBe("failed");
  });

  it("is invisible to another workspace, and gone for good once deleted", async () => {
    await expect(service().get(OTHER_WS, RUN, compilationId)).rejects.toMatchObject({
      httpStatus: 404,
    });
    const row = await prisma.repurposeCompilation.findUniqueOrThrow({
      where: { id: compilationId },
    });
    await service().remove(WS, USER, RUN, compilationId);
    expect(
      await prisma.repurposeCompilation.findUnique({ where: { id: compilationId } }),
    ).toBeNull();
    expect(await prisma.export.findUnique({ where: { id: row.exportId ?? "" } })).toBeNull();
  });

  it("goes with its run", async () => {
    const { compilation } = await service().create(WS, USER, RUN, {
      clipIds: [clipA, clipB],
      shape: "9:16",
    });
    await prisma.repurposeRun.delete({ where: { id: RUN } });
    expect(
      await prisma.repurposeCompilation.findUnique({ where: { id: compilation.id } }),
    ).toBeNull();
  });
});
