import { describe, expect, it, vi } from "vitest";

import { MediaProbeRestart, neverProbed, probeJobPayload } from "./probe-restart.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { ObjectStore } from "../common/storage/index.js";
import type { JobsService } from "../jobs/jobs.service.js";

const MEDIA = {
  id: "01MEDIA",
  projectId: "01PROJECT",
  storageKey: "ws/01WS/p/01SRC/repurpose/01RUN/clips/01CLIP/master.mp4",
  mime: "video/mp4",
  sizeBytes: 5_690_820n,
};

function harness(enqueue: () => Promise<unknown>) {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const jobs = { enqueue: vi.fn(enqueue) } as unknown as JobsService;
  const prisma = { mediaAsset: { updateMany } } as unknown as PrismaService;
  const restart = new MediaProbeRestart(
    prisma,
    jobs,
    { kind: "s3" } as ObjectStore,
    { kind: "r2" } as ObjectStore,
  );
  return { restart, jobs, updateMany };
}

describe("neverProbed", () => {
  it("is the signature media.clip left: ready, with nothing measured and no preview", () => {
    expect(neverProbed({ status: "ready", hasAudio: null, width: null, proxyKey: null })).toBe(true);
  });

  it.each([
    ["an audio-only file that was probed", { hasAudio: true }],
    ["a video with measured dimensions", { width: 1080 }],
    ["a video with a preview", { proxyKey: "p/proxy.mp4" }],
    ["media still in the pipeline", { status: "probing" }],
  ])("is false for %s", (_label, patch) => {
    expect(
      neverProbed({ status: "ready", hasAudio: null, width: null, proxyKey: null, ...patch }),
    ).toBe(false);
  });
});

describe("MediaProbeRestart.restart", () => {
  it("queues the ordinary probe, then marks the asset as back in the pipeline", async () => {
    const { restart, jobs, updateMany } = harness(async () => ({
      job: { id: "01PROBE" },
      deduplicated: false,
    }));

    await expect(restart.restart(MEDIA, "01WS")).resolves.toBe(true);

    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "media.probe",
        workspaceId: "01WS",
        projectId: "01PROJECT",
        jobKey: "media.probe:01MEDIA",
        params: probeJobPayload(MEDIA, "01PROJECT", { raw: "s3", derived: "r2" }),
      }),
    );
    // Conditional on still being unprobed, so a probe that landed is never undone.
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "01MEDIA", status: "ready", hasAudio: null, width: null, proxyKey: null },
      data: { status: "uploaded" },
    });
  });

  it("leaves the asset alone when the probe cannot be queued", async () => {
    const { restart, updateMany } = harness(async () => {
      throw new Error("jobs/concurrency_cap");
    });
    await expect(restart.restart(MEDIA, "01WS")).resolves.toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("probeJobPayload", () => {
  it("names the object, its buckets and the folder derived files go in", () => {
    expect(probeJobPayload(MEDIA, "01PROJECT", { raw: "s3", derived: "r2" })).toEqual({
      mediaId: "01MEDIA",
      projectId: "01PROJECT",
      bucket: "s3",
      key: MEDIA.storageKey,
      mime: "video/mp4",
      sizeBytes: 5_690_820,
      derivedBucket: "r2",
      derivedPrefix: "ws/01WS/p/01SRC/repurpose/01RUN/clips/01CLIP",
    });
  });
});
