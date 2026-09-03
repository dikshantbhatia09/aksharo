import { beforeEach, describe, expect, it, vi } from "vitest";

import { MediaProxyCompletionHandler } from "./proxy.handler.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";
import { AutoTranscribeTrigger } from "../transcripts/auto-transcribe.trigger.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { JobCompletionContext } from "../jobs/completion-handlers.js";
import type { Job, MediaAsset } from "@prisma/client";

const WS = "01JCWS0000000000000000000A";
const PROJECT = "01JCPR0JECT000000000000000";
const MEDIA = "01JCMED1A00000000000000000";
const JOB = "01JCJ0B0000000000000000000";

function job(params: Record<string, unknown> = { mediaId: MEDIA }): Job {
  return {
    id: JOB,
    workspaceId: WS,
    projectId: PROJECT,
    type: "media.proxy",
    priority: 3,
    jobKey: `media.proxy:${MEDIA}`,
    attemptId: "01JCATTEMPT000000000000000",
    creditsChargedTenths: 0,
    params,
  } as unknown as Job;
}

function successContext(
  result: Record<string, unknown> = {},
  params?: Record<string, unknown>,
): JobCompletionContext {
  return {
    job: job(params),
    attemptId: "01JCATTEMPT000000000000000",
    result,
    usage: undefined,
    completion: { status: "succeeded", result },
  };
}

function failureContext(
  error?: { code: string; message: string; retryable: boolean },
  params?: Record<string, unknown>,
): JobCompletionContext {
  return {
    job: job(params),
    attemptId: "01JCATTEMPT000000000000000",
    result: {},
    usage: undefined,
    completion: { status: "failed", error },
  };
}

interface Harness {
  handler: MediaProxyCompletionHandler;
  findUnique: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
  registry: JobCompletionRegistry;
  autoTranscribe: ReturnType<typeof vi.fn>;
}

function harness(status: MediaAsset["status"] | null = "probing"): Harness {
  const asset = status === null ? null : ({ status } as MediaAsset);
  const findUnique = vi.fn(async () => asset);
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    mediaAsset: { findUnique, updateMany },
  } as unknown as PrismaService;

  const registry = new JobCompletionRegistry();
  const autoTranscribe = vi.fn(async () => undefined);
  const handler = new MediaProxyCompletionHandler(prisma, registry, {
    maybeEnqueue: autoTranscribe,
  } as unknown as AutoTranscribeTrigger);
  return { handler, findUnique, updateMany, registry, autoTranscribe };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe("MediaProxyCompletionHandler", () => {
  it("registers itself as the owner of media.proxy completions", () => {
    h.handler.onModuleInit();
    expect(h.registry.handlerFor("media.proxy")).toBe(h.handler);
    expect(h.handler.jobType).toBe("media.proxy");
  });

  // --- success -------------------------------------------------------------

  it("flips a probing asset to ready on success", async () => {
    await h.handler.handle(successContext());
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { id: MEDIA, status: "probing" },
      data: { status: "ready", failureReason: null },
    });
  });

  it("reads the media id off the job's own payload, not the worker's echo", async () => {
    // `gate-a.spec.ts` completes with an empty `result: {}` — no worker running,
    // no `mediaId` to echo — and this must still resolve the right asset.
    await h.handler.handle(successContext({}));
    expect(h.findUnique).toHaveBeenCalledWith({ where: { id: MEDIA }, select: { status: true } });
  });

  it("falls back to the result's mediaId when the job carries none", async () => {
    await h.handler.handle(successContext({ mediaId: MEDIA }, {}));
    expect(h.findUnique).toHaveBeenCalledWith({ where: { id: MEDIA }, select: { status: true } });
  });

  it("is a no-op when the worker's own write-back already landed ready", async () => {
    const ready = harness("ready");
    const outcome = await ready.handler.handle(successContext());
    expect(ready.updateMany).not.toHaveBeenCalled();
    expect(outcome?.data).toMatchObject({ applied: false });
  });

  it("keeps a failed asset failed — a conflicting success completion never wins", async () => {
    const failed = harness("failed");
    const outcome = await failed.handler.handle(successContext());
    expect(failed.updateMany).not.toHaveBeenCalled();
    expect(outcome?.data).toMatchObject({ applied: false });
  });

  it("does nothing when the asset was deleted while the job ran", async () => {
    const gone = harness(null);
    const outcome = await gone.handler.handle(successContext());
    expect(gone.updateMany).not.toHaveBeenCalled();
    expect(outcome?.data).toMatchObject({ applied: false });
  });

  it("returns undefined without touching the database when no mediaId can be found", async () => {
    const outcome = await h.handler.handle(successContext({}, {}));
    expect(h.findUnique).not.toHaveBeenCalled();
    expect(outcome).toBeUndefined();
  });

  // --- failure ---------------------------------------------------------------

  it("flips a probing asset to failed on a terminal failure", async () => {
    await h.handler.handleFailure?.(
      failureContext({ code: "media/corrupt", message: "bad", retryable: false }),
    );
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { id: MEDIA, status: "probing" },
      data: { status: "failed", failureReason: "media/corrupt" },
    });
  });

  it("falls back to media/probe_failed when the worker's error code is not one of ours", async () => {
    await h.handler.handleFailure?.(
      failureContext({ code: "jobs/queue_timeout", message: "timed out", retryable: true }),
    );
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { id: MEDIA, status: "probing" },
      data: { status: "failed", failureReason: "media/probe_failed" },
    });
  });

  it("falls back to media/probe_failed when there is no error at all", async () => {
    await h.handler.handleFailure?.(failureContext(undefined));
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { id: MEDIA, status: "probing" },
      data: { status: "failed", failureReason: "media/probe_failed" },
    });
  });

  it("is a no-op when the asset is already failed", async () => {
    const failed = harness("failed");
    await failed.handler.handleFailure?.(
      failureContext({ code: "media/corrupt", message: "bad", retryable: false }),
    );
    expect(failed.updateMany).not.toHaveBeenCalled();
  });

  it("overwrites a stray ready with failed — failed always wins a conflict", async () => {
    const ready = harness("ready");
    await ready.handler.handleFailure?.(
      failureContext({ code: "media/corrupt", message: "bad", retryable: false }),
    );
    expect(ready.updateMany).toHaveBeenCalledWith({
      where: { id: MEDIA, status: "ready" },
      data: { status: "failed", failureReason: "media/corrupt" },
    });
  });

  it("does nothing on failure when the asset was deleted while the job ran", async () => {
    const gone = harness(null);
    await gone.handler.handleFailure?.(
      failureContext({ code: "media/corrupt", message: "bad", retryable: false }),
    );
    expect(gone.updateMany).not.toHaveBeenCalled();
  });

  it("does nothing on failure when no mediaId can be found", async () => {
    await h.handler.handleFailure?.(
      failureContext({ code: "media/corrupt", message: "bad", retryable: false }, {}),
    );
    expect(h.findUnique).not.toHaveBeenCalled();
  });
});
