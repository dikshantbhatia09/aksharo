import { beforeEach, describe, expect, it, vi } from "vitest";

import { REPURPOSE_SCHEMA_VERSION } from "@montaj/repurpose-contracts";

import { RepurposeAcquireCompletionHandler } from "./acquire-completion.handler.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";

import type { RepurposeService } from "./repurpose.service.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { JobCompletionContext } from "../jobs/completion-handlers.js";
import type { MediaService } from "../media/media.service.js";
import type { Job } from "@prisma/client";

const WS = "01JCWS0000000000000000000A";
const PROJECT = "01JCPR0JECT000000000000000";
const MEDIA = "01JCMED1A00000000000000000";
const RUN = "01JCRN0000000000000000000A";
const JOB = "01JCJ0B0000000000000000000";
const RAW_KEY = `ws/${WS}/p/${PROJECT}/media/${MEDIA}/raw.mp4`;

function acquireResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REPURPOSE_SCHEMA_VERSION,
    mediaId: MEDIA,
    bucket: "s3",
    key: RAW_KEY,
    filename: "source.mp4",
    mime: "video/mp4",
    sizeBytes: 12_345_678,
    checksum: "a".repeat(64),
    sourceMetadata: {
      provider: "youtube",
      sourceId: "youtube:dQw4w9WgXcQ",
      title: "A talk",
      channel: "A channel",
      durationMs: 600_000,
    },
    toolVersion: "yt-dlp 2026.08.19",
    deduplicated: false,
    probeToolVersion: "ffprobe version 9.0",
    ...overrides,
  };
}

function job(): Job {
  return {
    id: JOB,
    workspaceId: WS,
    projectId: PROJECT,
    type: "media.acquire",
    priority: 3,
    jobKey: `media.acquire:${RUN}:youtube:dQw4w9WgXcQ`,
    attemptId: "01JCATTEMPT000000000000000",
    creditsChargedTenths: 0,
    params: {
      schemaVersion: REPURPOSE_SCHEMA_VERSION,
      runId: RUN,
      projectId: PROJECT,
      mediaId: MEDIA,
      source: {
        kind: "youtube_url",
        normalizedUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        sourceId: "youtube:dQw4w9WgXcQ",
      },
      destination: { bucket: "s3", key: RAW_KEY },
      limits: { maxBytes: 524_288_000, maxDurationMs: 1_200_000, timeoutMs: 2_400_000 },
    },
  } as unknown as Job;
}

function context(result: Record<string, unknown>): JobCompletionContext {
  return {
    job: job(),
    attemptId: "01JCATTEMPT000000000000000",
    result,
    usage: undefined,
    completion: { status: "succeeded", result },
  };
}

/** A terminal failure, as `JobsService` reports it to the handler. */
function failure(code: string | null): JobCompletionContext {
  const error =
    code === null ? undefined : { code, message: "the worker's words", retryable: false };
  return {
    job: job(),
    attemptId: "01JCATTEMPT000000000000000",
    result: undefined,
    usage: undefined,
    completion: { status: "failed", ...(error === undefined ? {} : { error }) },
  } as unknown as JobCompletionContext;
}

interface Harness {
  handler: RepurposeAcquireCompletionHandler;
  completeAcquisition: ReturnType<typeof vi.fn>;
  mediaUpdateMany: ReturnType<typeof vi.fn>;
  failRun: ReturnType<typeof vi.fn>;
  reconcileRun: ReturnType<typeof vi.fn>;
  stopIfCancelled: ReturnType<typeof vi.fn>;
  registry: JobCompletionRegistry;
}

function harness(
  options: {
    asset?: Record<string, unknown> | null;
    run?: Record<string, unknown> | null;
    /** What the worker wrote on the media row before reporting, if anything. */
    failureReason?: string | null;
    /** The source project's newest primary media, when a retry replaced this one. */
    newestMediaId?: string;
  } = {},
): Harness {
  const asset =
    options.asset === undefined
      ? {
          id: MEDIA,
          projectId: PROJECT,
          bucket: "s3",
          storageKey: RAW_KEY,
          status: "pending",
          failureReason: options.failureReason ?? null,
          project: { id: PROJECT, workspaceId: WS, status: "draft" },
        }
      : options.asset;
  const run =
    options.run === undefined
      ? { id: RUN, status: "draft", sourceProjectId: PROJECT, workspaceId: WS }
      : options.run;

  const mediaUpdateMany = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    mediaAsset: {
      findUnique: vi.fn(async () => asset),
      findFirst: vi.fn(async () => ({ id: options.newestMediaId ?? MEDIA })),
      updateMany: mediaUpdateMany,
    },
    repurposeRun: { findUnique: vi.fn(async () => run) },
  } as unknown as PrismaService;

  const completeAcquisition = vi.fn(async () => ({
    media: { id: MEDIA },
    probeJobId: "01JCPR0BE000000000000000AA",
  }));
  const media = { completeAcquisition } as unknown as MediaService;

  const failRun = vi.fn(async () => null);
  const reconcileRun = vi.fn(async () => undefined);
  const stopIfCancelled = vi.fn(async () => false);
  const runs = { failRun, reconcileRun, stopIfCancelled } as unknown as RepurposeService;

  const registry = new JobCompletionRegistry();
  const handler = new RepurposeAcquireCompletionHandler(prisma, media, runs, registry);
  return {
    handler,
    completeAcquisition,
    mediaUpdateMany,
    failRun,
    reconcileRun,
    stopIfCancelled,
    registry,
  };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe("RepurposeAcquireCompletionHandler", () => {
  it("registers itself as the owner of media.acquire completions", () => {
    h.handler.onModuleInit();
    expect(h.registry.handlerFor("media.acquire")).toBe(h.handler);
    expect(h.handler.jobType).toBe("media.acquire");
  });

  it("hands an acquired source to the ordinary upload tail", async () => {
    // The whole point: past this line an acquired video is indistinguishable
    // from an uploaded one, so probe, proxy, transcribe and the editor need no
    // second code path.
    const outcome = await h.handler.handle(context(acquireResult()));

    expect(h.completeAcquisition).toHaveBeenCalledTimes(1);
    const call = h.completeAcquisition.mock.calls[0]?.[0] as {
      media: { id: string };
      project: { id: string };
      parent: Job;
      sizeBytes: number;
      contentHash: string;
    };
    expect(call.media.id).toBe(MEDIA);
    expect(call.project.id).toBe(PROJECT);
    // The parent is passed through so the probe rides on the admission slot this
    // acquisition already holds rather than queuing for its own.
    expect(call.parent.id).toBe(JOB);
    expect(call.sizeBytes).toBe(12_345_678);
    expect(call.contentHash).toBe("a".repeat(64));

    expect(outcome.data?.["probeJobId"]).toBe("01JCPR0BE000000000000000AA");
    // And the run is moved from what now exists, without waiting for a read.
    expect(h.reconcileRun).toHaveBeenCalledWith(RUN);
  });

  it("does not hand on a download for a run the person stopped", async () => {
    // Probe → proxy → transcription would spend credits on a run they
    // cancelled, whose page says "Nothing else will happen".
    h = harness({ run: { id: RUN, status: "cancelled", sourceProjectId: PROJECT } });
    const outcome = await h.handler.handle(context(acquireResult()));

    expect(h.completeAcquisition).not.toHaveBeenCalled();
    expect(outcome.data).toMatchObject({ applied: false, reason: "run_cancelled" });
    const write = h.mediaUpdateMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(write.data["status"]).toBe("failed");
    // The bytes the worker uploaded go at the next raw purge.
    expect(write.data["rawPurgeAt"]).toBeInstanceOf(Date);
    expect(h.reconcileRun).not.toHaveBeenCalled();
  });

  it("stops the probe it just queued when the run was stopped meanwhile", async () => {
    // Stop pressed between this handler's look at the run and the probe being
    // queued: `cancel` could not see the probe yet, and past the probe is a
    // paid transcription of a video the person stopped.
    h.stopIfCancelled.mockResolvedValueOnce(true);
    const outcome = await h.handler.handle(context(acquireResult()));

    expect(h.stopIfCancelled).toHaveBeenCalledWith(RUN);
    // Asked only once the probe exists, so one of the two always sees the other.
    expect(h.stopIfCancelled.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.completeAcquisition.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(h.reconcileRun).not.toHaveBeenCalled();
    expect(outcome.data).toMatchObject({ runCancelled: true });
  });

  it("refuses a result for a media row the job does not fetch into", async () => {
    // A worker that mixed up two concurrent downloads would complete another
    // run's media -- possibly another workspace's -- with these bytes.
    await expect(
      h.handler.handle(context(acquireResult({ mediaId: "01JCMED1A0000000000000000Z" }))),
    ).rejects.toThrow(/fetches into/);
    expect(h.completeAcquisition).not.toHaveBeenCalled();
    expect(h.mediaUpdateMany).not.toHaveBeenCalled();
  });

  it("never puts the source URL in the audit trail", async () => {
    const outcome = await h.handler.handle(context(acquireResult()));
    expect(JSON.stringify(outcome.data)).not.toContain("youtube.com/watch");
  });

  it("throws on a result it cannot parse, so the attempt is retried", async () => {
    // A throw leaves the job `running` and answers the worker 5xx. Marking it
    // done would strand a media row at `pending` with no way back.
    await expect(
      h.handler.handle(context(acquireResult({ checksum: "not-a-sha" }))),
    ).rejects.toThrow(/MediaAcquireResult/);
    expect(h.completeAcquisition).not.toHaveBeenCalled();
  });

  it("succeeds without writing when the run was deleted mid-download", async () => {
    h = harness({ asset: null });
    const outcome = await h.handler.handle(context(acquireResult()));
    expect(outcome.data?.["applied"]).toBe(false);
    expect(h.completeAcquisition).not.toHaveBeenCalled();
  });

  describe("a download that will not be retried", () => {
    function mediaWrite(): Record<string, unknown> {
      return (h.mediaUpdateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    }

    it("fails the run with the code for the reason the worker recorded", async () => {
      // The run used to say "We could not get that video" whatever happened, so
      // a video that was only too big for the plan read "choose another".
      h = harness({ failureReason: "media/too_large" });
      await h.handler.handleFailure(failure("media/unreadable"));

      expect(h.failRun).toHaveBeenCalledWith(
        expect.objectContaining({ id: RUN }),
        "repurpose/source_too_large",
        "getting_video",
      );
    });

    it.each([
      ["media/source_private", "repurpose/source_private"],
      ["media/source_blocked", "repurpose/source_blocked"],
      ["media/too_long", "repurpose/source_too_long"],
    ])(
      "reads the job's code %s when the worker's own write never landed",
      async (code, runCode) => {
        await h.handler.handleFailure(failure(code));

        // The media row gets the reason too, so every later read agrees.
        expect(mediaWrite()).toMatchObject({ status: "failed", failureReason: code });
        expect(h.failRun).toHaveBeenCalledWith(expect.anything(), runCode, "getting_video");
      },
    );

    it.each(["jobs/queue_timeout", "media/unreadable", null])(
      "names a failure it cannot place (%s) 'could not get it', never 'unsupported'",
      async (code) => {
        await h.handler.handleFailure(failure(code));

        expect(mediaWrite()).toMatchObject({
          status: "failed",
          failureReason: "media/source_failed",
        });
        // A code from SAFE_ERROR_CODES, never the downloader's own sentence.
        expect(h.failRun).toHaveBeenCalledWith(
          expect.anything(),
          "repurpose/source_unavailable",
          "getting_video",
        );
      },
    );

    it("leaves a run the person stopped alone, and purges whatever bytes arrived", async () => {
      // The callback is at-least-once, and a cancelled run must not be dragged
      // back into `failed` by a download that was already on its way out.
      h = harness({ run: { id: RUN, status: "cancelled", sourceProjectId: PROJECT } });
      await h.handler.handleFailure(failure("jobs/cancelled"));

      expect(mediaWrite()["rawPurgeAt"]).toBeInstanceOf(Date);
      expect(h.failRun).not.toHaveBeenCalled();
    });

    it("leaves a run that has moved on alone", async () => {
      for (const status of ["failed", "candidates_ready", "published"]) {
        h = harness({ run: { id: RUN, status, sourceProjectId: PROJECT } });
        await h.handler.handleFailure(failure("media/source_blocked"));
        expect(h.failRun, status).not.toHaveBeenCalled();
      }
    });

    it("ignores a late failure of a download a retry has already replaced", async () => {
      h = harness({ newestMediaId: "01JCMED1A0000000000000000B" });
      await h.handler.handleFailure(failure("media/source_blocked"));
      expect(h.failRun).not.toHaveBeenCalled();
    });

    it("does nothing when the job's own params no longer parse", async () => {
      const ctx = { ...failure(null), job: { ...job(), params: { nonsense: true } } as Job };
      await h.handler.handleFailure(ctx);
      expect(h.mediaUpdateMany).not.toHaveBeenCalled();
      expect(h.failRun).not.toHaveBeenCalled();
    });
  });
});
