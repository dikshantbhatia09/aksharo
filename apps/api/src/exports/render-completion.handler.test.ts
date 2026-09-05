import { describe, expect, it, vi } from "vitest";

import { RenderSubtitleCompletionHandler } from "./render-completion.handler.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { JobCompletionContext, JobCompletionRegistry } from "../jobs/completion-handlers.js";
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
  const createMany = vi.fn(async () => ({ count: sidecars.length }));
  const prisma = {
    exportManifest: { updateMany: vi.fn(async () => ({ count: 1 })) },
    export: { createMany },
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
  return { handler, context, createMany };
}

describe("RenderSubtitleCompletionHandler", () => {
  // F06 found the dialog's download 404ing for every subtitle export: the cloud
  // path writes no `exports` row at POST time, and this handler minted fresh ids,
  // so the id the client was handed never became a row.
  it("records the first sidecar under the export id the client already holds", async () => {
    const { handler, context, createMany } = harness([
      { format: "srt", key: "derived/01EXPORT.srt" },
      { format: "vtt", key: "derived/01EXPORT.vtt" },
    ]);
    await expect(handler.handle(context)).resolves.toMatchObject({
      data: { exportId: "01EXPORT", sidecars: 2 },
    });
    expect(createMany).toHaveBeenCalledTimes(1);
    const rows = (
      createMany.mock.calls[0] as unknown as [
        { data: Array<{ id: string; kind: string; status: string }> },
      ]
    )[0].data;
    expect(rows[0]).toMatchObject({ id: "01EXPORT", kind: "srt", status: "succeeded" });
    expect(rows[1]?.id).not.toBe("01EXPORT");
    expect(rows[1]).toMatchObject({ kind: "vtt", status: "succeeded" });
  });

  it("writes nothing on a replayed completion", async () => {
    const { handler, context, createMany } = harness([{ format: "srt", key: "k" }]);
    (context.job as unknown as { id: string }).id = "01JOB";
    const prisma = (
      handler as unknown as { prisma: { exportManifest: { updateMany: ReturnType<typeof vi.fn> } } }
    ).prisma;
    prisma.exportManifest.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(handler.handle(context)).resolves.toMatchObject({
      data: { exportId: "01EXPORT", replayed: true },
    });
    expect(createMany).not.toHaveBeenCalled();
  });
});
