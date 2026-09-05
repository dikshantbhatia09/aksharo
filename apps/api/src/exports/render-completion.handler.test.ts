import { describe, expect, it, vi } from "vitest";

import {
  RenderSubtitleCompletionHandler,
  RenderVideoCompletionHandler,
} from "./render-completion.handler.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { JobCompletionContext, JobCompletionRegistry } from "../jobs/completion-handlers.js";
import type { PartnerCatalogueService } from "../partner-catalogue/partner-catalogue.service.js";
import type { EventEmitter2 } from "@nestjs/event-emitter";

const MANIFEST = {
  manifestId: "01MANIFEST",
  workspaceId: "01WORKSPACE",
  projectId: "01PROJECT",
  exportId: "01EXPORT",
  watermark: null,
  output: { width: 1080, height: 1920, preset: "subtitles", container: "srt" },
};

function harness(sidecars: ReadonlyArray<{ format: string; key: string }>) {
  const createMany = vi.fn(async () => ({ count: Math.max(0, sidecars.length - 1) }));
  const upsert = vi.fn(async () => ({}));
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    exportManifest: { updateMany: vi.fn(async () => ({ count: 1 })) },
    export: { createMany, upsert, updateMany },
    publishEvent: { create: vi.fn(async () => ({})) },
  } as unknown as PrismaService;
  const registry = { register: vi.fn() } as unknown as JobCompletionRegistry;
  const events = { emit: vi.fn() } as unknown as EventEmitter2;
  const handler = new RenderSubtitleCompletionHandler(prisma, registry, events);
  const context = {
    job: { id: "01JOB", params: { manifest: MANIFEST } },
    attemptId: "01ATTEMPT",
    result: {
      exportId: MANIFEST.exportId,
      outputMs: 20_200,
      sidecars: sidecars.map((sidecar) => ({
        ...sidecar,
        script: "native",
        sizeBytes: 512,
        cues: 3,
      })),
    },
    usage: undefined,
    completion: {},
  } as unknown as JobCompletionContext;
  return { handler, context, createMany, upsert, updateMany };
}

/** The video twin of {@link harness} — same fakes, the other handler. */
function videoHarness() {
  const upsert = vi.fn(async () => ({}));
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    exportManifest: { updateMany: vi.fn(async () => ({ count: 1 })) },
    export: { upsert, updateMany },
    publishEvent: { create: vi.fn(async () => ({})) },
    assetUsage: { findMany: vi.fn(async () => []) },
  } as unknown as PrismaService;
  const registry = { register: vi.fn() } as unknown as JobCompletionRegistry;
  const events = { emit: vi.fn() } as unknown as EventEmitter2;
  const partnerCatalogue = {} as unknown as PartnerCatalogueService;
  const handler = new RenderVideoCompletionHandler(prisma, registry, events, partnerCatalogue);
  const context = {
    job: { id: "01JOB", params: { manifest: MANIFEST } },
    attemptId: "01ATTEMPT",
    result: {
      exportId: MANIFEST.exportId,
      outputKey: "derived/01EXPORT.mp4",
      outputMs: 20_200,
      sizeBytes: 4_096,
      width: 1080,
      height: 1920,
      watermarked: false,
    },
    usage: undefined,
    completion: {},
  } as unknown as JobCompletionContext;
  return { handler, context, upsert, updateMany };
}

/** The single `export.updateMany` argument a `handleFailure` made. */
function failureCall(updateMany: ReturnType<typeof vi.fn>): unknown {
  return (
    updateMany.mock.calls[0] as unknown as [
      { where: { id: string; status: string }; data: { status: string } },
    ]
  )[0];
}

/** A terminal failure carries no `result` — only the job and its params. */
function failureContext(params: unknown): JobCompletionContext {
  return {
    job: { id: "01JOB", params },
    attemptId: "01ATTEMPT",
    result: {},
    usage: undefined,
    completion: { status: "failed", finalAttempt: true },
  } as unknown as JobCompletionContext;
}

describe("RenderSubtitleCompletionHandler", () => {
  // F06 found the dialog's download 404ing for every subtitle export: the cloud
  // path wrote no `exports` row at POST time, and this handler minted fresh ids,
  // so the id the client was handed never became a row. S05 writes that row at
  // POST time instead, and the first sidecar now finishes it rather than racing
  // it with an insert of the same id.
  it("finishes the export id the client already holds, and creates only the extras", async () => {
    const { handler, context, createMany, upsert } = harness([
      { format: "srt", key: "derived/01EXPORT.srt" },
      { format: "vtt", key: "derived/01EXPORT.vtt" },
    ]);
    await expect(handler.handle(context)).resolves.toMatchObject({
      data: { exportId: "01EXPORT", sidecars: 2 },
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    const args = (
      upsert.mock.calls[0] as unknown as [
        {
          where: { id: string };
          create: { id: string; kind: string; status: string };
          update: { status: string; jobId: string; kind: string; storageKey: string };
        },
      ]
    )[0];
    expect(args.where).toEqual({ id: "01EXPORT" });
    expect(args.create).toMatchObject({ id: "01EXPORT", kind: "srt", status: "succeeded" });
    expect(args.update).toMatchObject({
      status: "succeeded",
      jobId: "01JOB",
      kind: "srt",
      storageKey: "derived/01EXPORT.srt",
    });

    // The extras keep their own ids, and the upserted id is never inserted again.
    expect(createMany).toHaveBeenCalledTimes(1);
    const rows = (
      createMany.mock.calls[0] as unknown as [
        { data: Array<{ id: string; kind: string; status: string }> },
      ]
    )[0].data;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toBe("01EXPORT");
    expect(rows[0]).toMatchObject({ kind: "vtt", status: "succeeded" });
  });

  it("writes no createMany at all when the job produced a single sidecar", async () => {
    const { handler, context, createMany, upsert } = harness([
      { format: "srt", key: "derived/01EXPORT.srt" },
    ]);
    await handler.handle(context);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("writes nothing on a replayed completion", async () => {
    const { handler, context, createMany, upsert } = harness([{ format: "srt", key: "k" }]);
    (context.job as unknown as { id: string }).id = "01JOB";
    const prisma = (
      handler as unknown as { prisma: { exportManifest: { updateMany: ReturnType<typeof vi.fn> } } }
    ).prisma;
    prisma.exportManifest.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(handler.handle(context)).resolves.toMatchObject({
      data: { exportId: "01EXPORT", replayed: true },
    });
    expect(createMany).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  /**
   * S05: a render that failed terminally used to leave nothing at all — the row
   * was only ever written by the success path, so the history simply lost the
   * export. `handleFailure` (`completion-handlers.ts:68`) is the documented seam
   * for exactly this.
   */
  describe("handleFailure", () => {
    it("flips only a still-rendering row to failed", async () => {
      const { handler, updateMany } = harness([{ format: "srt", key: "k" }]);
      await handler.handleFailure(failureContext({ manifest: MANIFEST }));
      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(failureCall(updateMany)).toEqual({
        where: { id: "01EXPORT", status: "rendering" },
        data: { status: "failed" },
      });
    });

    it("writes nothing when the job's params are not a render manifest", async () => {
      const { handler, updateMany } = harness([{ format: "srt", key: "k" }]);
      await handler.handleFailure(failureContext({ nothing: "useful" }));
      await handler.handleFailure(failureContext(null));
      expect(updateMany).not.toHaveBeenCalled();
    });
  });
});

describe("RenderVideoCompletionHandler", () => {
  // A row written before S05 has no `jobId` at all; the completion that finishes
  // it is the moment that row can learn which job made it.
  it("carries the job id into the update branch so a pre-S05 row heals", async () => {
    const { handler, context, upsert } = videoHarness();
    await handler.handle(context);
    expect(upsert).toHaveBeenCalledTimes(1);
    const args = (
      upsert.mock.calls[0] as unknown as [
        { where: { id: string }; update: { status: string; jobId: string } },
      ]
    )[0];
    expect(args.where).toEqual({ id: "01EXPORT" });
    expect(args.update).toMatchObject({ status: "succeeded", jobId: "01JOB" });
  });

  describe("handleFailure", () => {
    it("flips only a still-rendering row to failed", async () => {
      const { handler, updateMany } = videoHarness();
      await handler.handleFailure(failureContext({ manifest: MANIFEST }));
      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(failureCall(updateMany)).toEqual({
        where: { id: "01EXPORT", status: "rendering" },
        data: { status: "failed" },
      });
    });

    it("writes nothing when the job's params are not a render manifest", async () => {
      const { handler, updateMany } = videoHarness();
      await handler.handleFailure(failureContext({ manifest: { exportId: "" } }));
      expect(updateMany).not.toHaveBeenCalled();
    });
  });
});
