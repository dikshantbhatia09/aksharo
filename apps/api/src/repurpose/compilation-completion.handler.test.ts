import { beforeEach, describe, expect, it, vi } from "vitest";

import { quote } from "@montaj/config";

import { RepurposeCompilationCompletionHandler } from "./compilation-completion.handler.js";
import { COMPILATION_ERRORS } from "./compilations.dto.js";

import type { JobCompletionContext } from "../jobs/completion-handlers.js";

const WS = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const COMPILATION = "01JCC0MP11AT10N00000000000";
const EXPORT = "01JCEXP0RT0000000000000000";
const KEY = `ws/${WS}/p/${PROJECT}/exports/${EXPORT}.mp4`;

const params = {
  schemaVersion: 1,
  runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  compilationId: COMPILATION,
  exportId: EXPORT,
  projectId: PROJECT,
  shape: "9:16",
  width: 1080,
  height: 1920,
  fps: 30,
  fadeMs: 500,
  clips: [
    {
      clipId: "01JCC11PA00000000000000000",
      key: `ws/${WS}/p/01JCC11PPR0JECTA0000000000/exports/01JCEXP0RTA000000000000000.mp4`,
      durationMs: 30_000,
    },
  ],
};

const result = {
  schemaVersion: 1,
  compilationId: COMPILATION,
  exportId: EXPORT,
  outputKey: KEY,
  outputMs: 90_000,
  sizeBytes: 12_345,
  width: 1080,
  height: 1920,
  fps: 30,
  clips: 3,
  intro: true,
};

let prisma: {
  repurposeCompilation: {
    findFirst: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  export: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
};
let derived: { delete: ReturnType<typeof vi.fn> };

function handler(): RepurposeCompilationCompletionHandler {
  return new RepurposeCompilationCompletionHandler(
    prisma as never,
    { register: vi.fn() } as never,
    derived as never,
  );
}

function context(overrides: Partial<JobCompletionContext> = {}): JobCompletionContext {
  return {
    job: { id: "01JCJ0B0000000000000000001", workspaceId: WS, params } as never,
    attemptId: "01JCATTEMPT000000000000001",
    result,
    usage: undefined,
    completion: { status: "succeeded", result },
    ...overrides,
  };
}

beforeEach(() => {
  prisma = {
    repurposeCompilation: {
      findFirst: vi.fn(async () => ({ id: COMPILATION })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    export: {
      findUnique: vi.fn(async () => ({ id: EXPORT })),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  derived = { delete: vi.fn(async () => undefined) };
});

describe("RepurposeCompilationCompletionHandler (2026-10-03)", () => {
  it("finishes the export, starts its seven days, and charges the cloud rate on the measured length", async () => {
    const before = Date.now();
    const outcome = await handler().handle(context());
    expect(outcome.actualTenths).toBe(quote("cloudRender", 1.5).costTenths);
    const exportWrite = prisma.export.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(exportWrite.where.id).toBe(EXPORT);
    expect(exportWrite.data).toMatchObject({
      status: "succeeded",
      storageKey: KEY,
      sizeBytes: 12_345n,
      durationMs: 90_000,
      resolution: "1080x1920",
    });
    const expires = (exportWrite.data["expiresAt"] as Date).getTime();
    expect(expires - before).toBeGreaterThanOrEqual(7 * 24 * 60 * 60_000 - 1_000);
    expect(prisma.repurposeCompilation.updateMany).toHaveBeenCalledWith({
      where: { id: COMPILATION, exportId: EXPORT },
      data: { status: "ready", durationMs: 90_000, failureCode: null },
    });
    expect(derived.delete).not.toHaveBeenCalled();
  });

  it("files nothing a worker reports that it was not asked for", async () => {
    for (const odd of [
      { ...result, exportId: "01JCEXP0RT0000000000000009" },
      { ...result, compilationId: "01JCC0MP11AT10N00000000009" },
      { ...result, outputKey: `ws/01JCWS0000000000000000000B/p/${PROJECT}/exports/${EXPORT}.mp4` },
    ]) {
      const outcome = await handler().handle(context({ result: odd }));
      expect(outcome).toEqual({
        actualTenths: 0,
        data: { applied: false, reason: "result_mismatch" },
      });
    }
    expect(prisma.export.update).not.toHaveBeenCalled();
  });

  it("drops the file of a compilation deleted or made again while it rendered, and charges nothing", async () => {
    prisma.repurposeCompilation.findFirst.mockResolvedValueOnce(null);
    const outcome = await handler().handle(context());
    expect(outcome.actualTenths).toBe(0);
    expect(derived.delete).toHaveBeenCalledWith(KEY);
    expect(prisma.export.update).not.toHaveBeenCalled();
  });

  it("throws on a result that does not parse, so the worker is told", async () => {
    await expect(
      handler().handle(context({ result: { ...result, outputMs: -1 } })),
    ).rejects.toThrow("invalid result");
  });

  it("marks this attempt failed, in the page's words, on a terminal failure", async () => {
    await handler().handleFailure(
      context({
        completion: {
          status: "failed",
          error: { code: "storage/unreadable", message: "gone", retryable: true },
          finalAttempt: true,
        },
      }),
    );
    expect(prisma.export.updateMany).toHaveBeenCalledWith({
      where: { id: EXPORT, status: "rendering" },
      data: { status: "failed" },
    });
    expect(prisma.repurposeCompilation.updateMany).toHaveBeenCalledWith({
      where: { id: COMPILATION, exportId: EXPORT, status: "rendering" },
      data: { status: "failed", failureCode: COMPILATION_ERRORS.sourceGone },
    });
  });
});
