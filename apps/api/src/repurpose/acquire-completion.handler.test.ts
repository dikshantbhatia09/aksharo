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

interface Harness {
  handler: RepurposeAcquireCompletionHandler;
  completeAcquisition: ReturnType<typeof vi.fn>;
  mediaUpdateMany: ReturnType<typeof vi.fn>;
  runUpdate: ReturnType<typeof vi.fn>;
  publishStage: ReturnType<typeof vi.fn>;
  registry: JobCompletionRegistry;
}

function harness(
  options: {
    asset?: Record<string, unknown> | null;
    run?: Record<string, unknown> | null;
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
          project: { id: PROJECT, workspaceId: WS, status: "draft" },
        }
      : options.asset;
  const run = options.run === undefined ? { id: RUN, status: "draft" } : options.run;

  const mediaUpdateMany = vi.fn(async () => ({ count: 1 }));
  const runUpdate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: RUN,
    ...args.data,
  }));
  const prisma = {
    mediaAsset: { findUnique: vi.fn(async () => asset), updateMany: mediaUpdateMany },
    repurposeRun: { findUnique: vi.fn(async () => run), update: runUpdate },
  } as unknown as PrismaService;

  const completeAcquisition = vi.fn(async () => ({
    media: { id: MEDIA },
    probeJobId: "01JCPR0BE000000000000000AA",
  }));
  const media = { completeAcquisition } as unknown as MediaService;

  const publishStage = vi.fn(async () => undefined);
  const runs = { publishStage } as unknown as RepurposeService;

  const registry = new JobCompletionRegistry();
  const handler = new RepurposeAcquireCompletionHandler(prisma, media, runs, registry);
  return { handler, completeAcquisition, mediaUpdateMany, runUpdate, publishStage, registry };
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
    it("fails the run with a safe code and tells the open tab", async () => {
      await h.handler.handleFailure(context({}));

      expect(h.mediaUpdateMany).toHaveBeenCalledTimes(1);
      const runData = h.runUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect(runData.data["status"]).toBe("failed");
      // A code from SAFE_ERROR_CODES, never the downloader's own sentence.
      expect(runData.data["failureCode"]).toBe("repurpose/source_unavailable");
      expect(h.publishStage).toHaveBeenCalledTimes(1);
    });

    it("leaves a run that is already finished alone", async () => {
      // The callback is at-least-once, and a cancelled run must not be dragged
      // back into `failed` by a download that was already on its way out.
      h = harness({ run: { id: RUN, status: "cancelled" } });
      await h.handler.handleFailure(context({}));
      expect(h.runUpdate).not.toHaveBeenCalled();
      expect(h.publishStage).not.toHaveBeenCalled();
    });

    it("does nothing when the job's own params no longer parse", async () => {
      const ctx = { ...context({}), job: { ...job(), params: { nonsense: true } } as Job };
      await h.handler.handleFailure(ctx);
      expect(h.mediaUpdateMany).not.toHaveBeenCalled();
      expect(h.runUpdate).not.toHaveBeenCalled();
    });
  });
});
