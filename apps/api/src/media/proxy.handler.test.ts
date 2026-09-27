import { beforeEach, describe, expect, it, vi } from "vitest";

import { FacesTrigger } from "./faces.js";
import { MediaProxyCompletionHandler } from "./proxy.handler.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";
import { AutoTranscribeTrigger } from "../transcripts/auto-transcribe.trigger.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { JobCompletionContext } from "../jobs/completion-handlers.js";
import type { JobsService } from "../jobs/jobs.service.js";
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
  projectUpdate: ReturnType<typeof vi.fn>;
  registry: JobCompletionRegistry;
  autoTranscribe: ReturnType<typeof vi.fn>;
  faces: ReturnType<typeof vi.fn>;
  /** `prisma.job.findMany`: the live first transcriptions of the media. */
  findJobs: ReturnType<typeof vi.fn>;
  /** `JobsService.cancel`. */
  cancel: ReturnType<typeof vi.fn>;
}

interface HarnessOptions {
  /** The live `ai.transcribe` rows the failure path finds. */
  readonly liveTranscriptions?: readonly { id: string }[];
  readonly cancel?: () => Promise<unknown>;
}

/**
 * FIX-05 copies the media's presentation facts onto the project row. The handler
 * reads the asset twice with two different `select`s — the status it resolves,
 * then the facts it copies — so the mock answers on the shape asked for.
 */
type PresentedFacts = Pick<MediaAsset, "projectId" | "role" | "durationMs" | "thumbKeys">;

function harness(
  status: MediaAsset["status"] | null = "probing",
  presented: PresentedFacts | null = null,
  options: HarnessOptions = {},
): Harness {
  // Stateful, so what the failure path reads after `resolve` is what it wrote.
  const asset = status === null ? null : ({ status, projectId: PROJECT } as MediaAsset);
  const findUnique = vi.fn(async (args: { select?: Record<string, boolean> }) =>
    args.select?.["role"] === true ? presented : asset,
  );
  const updateMany = vi.fn(async (args?: { data?: { status?: MediaAsset["status"] } }) => {
    if (asset !== null && args?.data?.status !== undefined) asset.status = args.data.status;
    return { count: 1 };
  });
  const projectUpdate = vi.fn(async () => ({}));
  const findJobs = vi.fn(async () => options.liveTranscriptions ?? []);
  const prisma = {
    mediaAsset: { findUnique, updateMany },
    project: { update: projectUpdate },
    job: { findMany: findJobs },
  } as unknown as PrismaService;

  const registry = new JobCompletionRegistry();
  const autoTranscribe = vi.fn(async () => undefined);
  const faces = vi.fn(async () => undefined);
  const cancel = vi.fn(options.cancel ?? (async () => ({})));
  const handler = new MediaProxyCompletionHandler(
    prisma,
    registry,
    { maybeEnqueue: autoTranscribe } as unknown as AutoTranscribeTrigger,
    { maybeEnqueue: faces } as unknown as FacesTrigger,
    { cancel } as unknown as JobsService,
  );
  return {
    handler,
    findUnique,
    updateMany,
    projectUpdate,
    registry,
    autoTranscribe,
    faces,
    findJobs,
    cancel,
  };
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

  it("keeps a ready asset ready when the lease reaper settles the proxy as stalled", async () => {
    // The encode finished and wrote the asset back; only its completion was lost.
    const ready = harness("ready");
    await ready.handler.handleFailure?.(
      failureContext({ code: "jobs/stalled", message: "stalled", retryable: true }),
    );
    expect(ready.updateMany).not.toHaveBeenCalled();
  });

  it("still fails a probing asset whose proxy was reaped as stalled", async () => {
    await h.handler.handleFailure?.(
      failureContext({ code: "jobs/stalled", message: "stalled", retryable: true }),
    );
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { id: MEDIA, status: "probing" },
      data: { status: "failed", failureReason: "media/probe_failed" },
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

describe("project presentation facts (FIX-05)", () => {
  // The grid renders from the project row alone — no join onto media_assets —
  // so the duration and the first thumbnail have to land on the row itself the
  // moment the derived assets exist.
  it("copies durationMs and the first thumb key onto the project for a primary asset", async () => {
    const primary = harness("probing", {
      projectId: PROJECT,
      role: "primary",
      durationMs: 20_200,
      thumbKeys: ["derived/thumb-0.jpg", "derived/thumb-1.jpg"],
    });
    await primary.handler.handle(successContext());
    expect(primary.projectUpdate).toHaveBeenCalledWith({
      where: { id: PROJECT },
      data: { durationMs: 20_200, thumbnailKey: "derived/thumb-0.jpg" },
    });
  });

  it("leaves the project alone for a non-primary asset", async () => {
    const broll = harness("probing", {
      projectId: PROJECT,
      role: "broll",
      durationMs: 20_200,
      thumbKeys: ["derived/thumb-0.jpg"],
    });
    await broll.handler.handle(successContext());
    expect(broll.projectUpdate).not.toHaveBeenCalled();
  });
});

describe("first transcription", () => {
  // Regression: this was gated on the status actually changing, but worker-media
  // patches the asset to `ready` itself, so the completion normally sees no
  // change — and every real upload silently skipped its own transcription.
  it("starts it even when the worker already marked the asset ready", async () => {
    const ready = harness("ready");
    await ready.handler.handle(successContext());
    expect(ready.autoTranscribe).toHaveBeenCalledWith(MEDIA, expect.anything());
  });

  it("starts it on the ordinary transition too", async () => {
    await h.handler.handle(successContext());
    expect(h.autoTranscribe).toHaveBeenCalledWith(MEDIA, expect.anything());
  });

  // W5: the transcription usually started on the audio, before this job's
  // encode. If that one already failed, the proxy finishing must not quietly
  // start (and charge for) a second one behind a run that says it failed.
  it("asks only for a first attempt: an early start that already ended is not repeated", async () => {
    await h.handler.handle(successContext());
    expect(h.autoTranscribe).toHaveBeenCalledWith(MEDIA, { firstAttemptOnly: true });
  });
});

describe("a transcription started on the audio, when the proxy then fails (W5)", () => {
  const TRANSCRIBE = "01JCJ0BTRANSCR1BE000000000";
  const failure = () => failureContext({ code: "media/corrupt", message: "bad", retryable: false });

  it("is stopped, so nobody is charged for words of media no editor will open", async () => {
    const early = harness("probing", null, { liveTranscriptions: [{ id: TRANSCRIBE }] });
    await early.handler.handleFailure?.(failure());
    expect(early.findJobs).toHaveBeenCalledWith({
      where: {
        workspaceId: WS,
        type: "ai.transcribe",
        // Only this media's first transcription: the key names it.
        jobKey: `transcribe:${PROJECT}:${MEDIA}`,
        status: { in: ["queued", "running"] },
      },
      select: { id: true },
    });
    expect(early.cancel).toHaveBeenCalledWith(TRANSCRIBE, WS);
    // The media is marked first, so the cancel's own handlers read it failed.
    expect(early.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      early.cancel.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("stops nothing when there is nothing in flight", async () => {
    await h.handler.handleFailure?.(failure());
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("never fails the failure path when the transcription finished a moment ago", async () => {
    const raced = harness("probing", null, {
      liveTranscriptions: [{ id: TRANSCRIBE }],
      cancel: async () => {
        throw new Error("The job finished before it could be cancelled.");
      },
    });
    await expect(raced.handler.handleFailure?.(failure())).resolves.toBeUndefined();
    expect(raced.cancel).toHaveBeenCalled();
  });

  it("leaves transcriptions alone when the media is gone", async () => {
    const gone = harness(null, null, { liveTranscriptions: [{ id: TRANSCRIBE }] });
    await gone.handler.handleFailure?.(failure());
    expect(gone.cancel).not.toHaveBeenCalled();
  });

  it("stops nothing on success", async () => {
    const early = harness("probing", null, { liveTranscriptions: [{ id: TRANSCRIBE }] });
    await early.handler.handle(successContext());
    expect(early.cancel).not.toHaveBeenCalled();
  });
});
