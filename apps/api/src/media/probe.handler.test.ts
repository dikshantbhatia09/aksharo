import { beforeEach, describe, expect, it, vi } from "vitest";

import { MediaProbeCompletionHandler } from "./probe.handler.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";

import type { ProbeResult } from "./probe-result.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { JobCompletionContext } from "../jobs/completion-handlers.js";
import type { JobsService } from "../jobs/jobs.service.js";
import type { ReplaceMediaAlignTrigger } from "../replace-media/replace-media-align.trigger.js";
import type { EntitlementService } from "../workspaces/entitlement.service.js";
import type { Job, MediaAsset } from "@prisma/client";

const WS = "01JCWS0000000000000000000A";
const PROJECT = "01JCPR0JECT000000000000000";
const MEDIA = "01JCMED1A00000000000000000";
const JOB = "01JCJ0B0000000000000000000";
const RAW_KEY = `ws/${WS}/p/${PROJECT}/media/${MEDIA}/raw.mp4`;

function probeResult(overrides: Partial<ProbeResult> = {}): Record<string, unknown> {
  return {
    mediaId: MEDIA,
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    mime: "video/mp4",
    durationMs: 10_000,
    sizeBytes: 1_048_576,
    hasVideo: true,
    hasAudio: true,
    video: {
      codec: "h264",
      width: 1080,
      height: 1920,
      fps: 30,
      rotation: 0,
      pixelFormat: "yuv420p",
      bitDepth: 8,
      colourTransfer: "bt709",
      colourPrimaries: "bt709",
      hdr: false,
    },
    audio: {
      codec: "aac",
      channels: 2,
      sampleRate: 48_000,
      loudnessLufs: -18.4,
      loudnessRangeLu: 6.2,
      truePeakDbfs: -1.5,
      silenceRatio: 0.12,
      silences: [{ startMs: 0, endMs: 1_200 }],
    },
    probedAt: "2026-09-02T00:00:00.000Z",
    toolVersion: "ffprobe version 9.0",
    ...overrides,
  } as Record<string, unknown>;
}

function job(): Job {
  return {
    id: JOB,
    workspaceId: WS,
    projectId: PROJECT,
    type: "media.probe",
    priority: 3,
    jobKey: `media.probe:${MEDIA}`,
    attemptId: "01JCATTEMPT000000000000000",
    creditsChargedTenths: 0,
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
  handler: MediaProbeCompletionHandler;
  update: ReturnType<typeof vi.fn>;
  enqueueChild: ReturnType<typeof vi.fn>;
  registry: JobCompletionRegistry;
}

function harness(options: { asset?: MediaAsset | null; maxDurationMs?: number } = {}): Harness {
  const asset =
    options.asset === undefined
      ? ({ id: MEDIA, projectId: PROJECT, bucket: "s3", storageKey: RAW_KEY } as MediaAsset)
      : options.asset;

  const update = vi.fn(async () => asset);
  const prisma = {
    mediaAsset: { findUnique: vi.fn(async () => asset), update },
  } as unknown as PrismaService;

  const enqueueChild = vi.fn(async () => ({
    job: { id: "01JCCH1LD00000000000000000" },
    deduplicated: false,
  }));
  const jobs = { enqueueChild } as unknown as JobsService;

  const entitlements = {
    forWorkspace: vi.fn(async () => ({
      planKey: "free",
      entitlements: { maxDurationMs: options.maxDurationMs ?? 20 * 60_000 },
    })),
  } as unknown as EntitlementService;

  const registry = new JobCompletionRegistry();
  const realign = {
    maybeEnqueue: vi.fn(async () => undefined),
  } as unknown as ReplaceMediaAlignTrigger;
  const handler = new MediaProbeCompletionHandler(prisma, jobs, entitlements, registry, realign);
  return { handler, update, enqueueChild, registry };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe("MediaProbeCompletionHandler", () => {
  it("registers itself as the owner of media.probe completions", () => {
    h.handler.onModuleInit();
    expect(h.registry.handlerFor("media.probe")).toBe(h.handler);
    expect(h.handler.jobType).toBe("media.probe");
  });

  it("writes the measured facts onto the asset and moves it to probing", async () => {
    await h.handler.handle(context(probeResult()));
    expect(h.update.mock.calls[0]?.[0]).toMatchObject({
      where: { id: MEDIA },
      data: {
        durationMs: 10_000,
        width: 1080,
        height: 1920,
        fps: 30,
        codec: "h264",
        hasAudio: true,
        hdr: false,
        audioChannels: 2,
        mime: "video/mp4",
        status: "probing",
        failureReason: null,
      },
    });
  });

  it("enqueues media.proxy as a child, outside the plan's admission lane", async () => {
    // A06 enqueued both at upload, which took two slots for one file and 429'd a
    // Free workspace on its second concurrent upload.
    const outcome = await h.handler.handle(context(probeResult()));
    expect(h.enqueueChild).toHaveBeenCalledTimes(1);
    const [parent, input] = h.enqueueChild.mock.calls[0] as [Job, Record<string, unknown>];
    expect(parent.id).toBe(JOB);
    expect(input["type"]).toBe("media.proxy");
    expect(input["jobKey"]).toBe(`media.proxy:${MEDIA}`);
    expect(input["worstCaseTenths"]).toBe(0);
    expect(input["skipAdmission"]).toBe(true);
    expect(outcome.data).toMatchObject({ proxyJobId: "01JCCH1LD00000000000000000" });
  });

  it("hands the proxy everything it would otherwise have to re-probe", async () => {
    await h.handler.handle(context(probeResult()));
    const [, input] = h.enqueueChild.mock.calls[0] as [Job, Record<string, unknown>];
    expect(input["payload"]).toMatchObject({
      mediaId: MEDIA,
      key: RAW_KEY,
      derivedPrefix: `ws/${WS}/p/${PROJECT}/media/${MEDIA}`,
      durationMs: 10_000,
      hasVideo: true,
      hasAudio: true,
      width: 1080,
      height: 1920,
      hdr: false,
    });
  });

  it("carries the HDR flag through to the row and to the proxy job", async () => {
    const hdr = probeResult({
      video: {
        codec: "hevc",
        width: 3840,
        height: 2160,
        fps: 60,
        rotation: 0,
        pixelFormat: "yuv420p10le",
        bitDepth: 10,
        colourTransfer: "smpte2084",
        colourPrimaries: "bt2020",
        hdr: true,
      },
    });
    await h.handler.handle(context(hdr));
    expect(h.update.mock.calls[0]?.[0]).toMatchObject({ data: { hdr: true, codec: "hevc" } });
    const [, input] = h.enqueueChild.mock.calls[0] as [Job, Record<string, unknown>];
    expect(input["payload"]).toMatchObject({ hdr: true });
  });

  it("fails the asset on the plan's duration cap and builds no proxy", async () => {
    // The probe did exactly what it was asked, so the JOB succeeds; the media is
    // what is rejected, and no bytes are spent on a proxy nothing may use.
    const capped = harness({ maxDurationMs: 5_000 });
    const outcome = await capped.handler.handle(context(probeResult({ durationMs: 600_000 })));

    expect(capped.update.mock.calls[0]?.[0]).toMatchObject({
      data: { status: "failed", failureReason: "media/too_long" },
    });
    expect(capped.enqueueChild).not.toHaveBeenCalled();
    expect(outcome.data).toMatchObject({
      failureReason: "media/too_long",
      proxyEnqueued: false,
      maxDurationMs: 5_000,
    });
  });

  it("takes the audio codec when there is no video stream", async () => {
    const audioOnly = probeResult({ hasVideo: false, video: null });
    await h.handler.handle(context(audioOnly));
    expect(h.update.mock.calls[0]?.[0]).toMatchObject({
      data: { codec: "aac", width: null, height: null, fps: null, hdr: false },
    });
  });

  it("throws on a result that is not a ProbeResult, so the worker retries", async () => {
    // A throw leaves the job `running` and answers 5xx; marking it done would make
    // the first bad body permanent.
    await expect(h.handler.handle(context({ mediaId: MEDIA }))).rejects.toThrow(/ProbeResult/);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.enqueueChild).not.toHaveBeenCalled();
  });

  it("refuses a durationMs that is not a number, because a plan check reads it", async () => {
    await expect(
      h.handler.handle(context(probeResult({ durationMs: "10000" as unknown as number }))),
    ).rejects.toThrow(/ProbeResult/);
  });

  it("tolerates a field the API does not know yet", async () => {
    // A worker rolled ahead of the API must not fail a job it did perfectly.
    const ahead = { ...probeResult(), bitrateBps: 8_000_000 };
    await expect(h.handler.handle(context(ahead))).resolves.toBeDefined();
  });

  it("succeeds quietly when the asset was deleted while the probe ran", async () => {
    const gone = harness({ asset: null });
    const outcome = await gone.handler.handle(context(probeResult()));
    expect(outcome.data).toMatchObject({ applied: false, reason: "media_deleted" });
    expect(gone.enqueueChild).not.toHaveBeenCalled();
  });

  it("is idempotent: a replayed completion writes the same row and dedupes the child", async () => {
    await h.handler.handle(context(probeResult()));
    h.enqueueChild.mockResolvedValueOnce({
      job: { id: "01JCCH1LD00000000000000000" },
      deduplicated: true,
    });
    const replay = await h.handler.handle(context(probeResult()));
    expect(replay.data).toMatchObject({
      proxyJobId: "01JCCH1LD00000000000000000",
      proxyEnqueued: false,
    });
    expect(h.update).toHaveBeenCalledTimes(2);
  });
});
