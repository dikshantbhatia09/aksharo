import { describe, expect, it, vi } from "vitest";

import {
  MediaProbeRestart,
  neverProbed,
  probeJobPayload,
  PROMOTE_MAX_BYTES,
  promoteToRaw,
} from "./probe-restart.js";

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

/** A store holding `initial` (key -> size), recording what is written to it. */
function fakeStore(kind: "s3" | "r2", initial: Record<string, number> = {}) {
  const objects = new Map(Object.entries(initial));
  const put = vi.fn(async (input: { key: string; body: Uint8Array | string }) => {
    objects.set(input.key, input.body.length);
  });
  const store = {
    kind,
    head: vi.fn(async (key: string) => {
      const size = objects.get(key);
      return size === undefined ? null : { sizeBytes: size, contentType: "video/mp4" };
    }),
    get: vi.fn(async (key: string) => Buffer.alloc(objects.get(key) ?? 0)),
    put,
  };
  return store as unknown as ObjectStore & { put: typeof put; get: ReturnType<typeof vi.fn> };
}

function harness(enqueue: () => Promise<unknown>) {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const jobs = { enqueue: vi.fn(enqueue) } as unknown as JobsService;
  const prisma = { mediaAsset: { updateMany } } as unknown as PrismaService;
  const raw = fakeStore("s3", { [MEDIA.storageKey]: 1_000 });
  const restart = new MediaProbeRestart(prisma, jobs, raw, fakeStore("r2"));
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

// The pipeline reads a primary asset from the raw store only; `media.clip`
// writes its mezzanine to the derived one. Probing a clip without this copy
// answered 404 `media/unreadable` (found live, 2026-09-25).
describe("promoteToRaw", () => {
  const KEY = MEDIA.storageKey;

  it("copies a mezzanine that only the derived store has", async () => {
    const raw = fakeStore("s3");
    const derived = fakeStore("r2", { [KEY]: 4_096 });
    await expect(promoteToRaw({ raw, derived }, KEY, "video/mp4")).resolves.toBe(true);
    expect(raw.put).toHaveBeenCalledWith(
      expect.objectContaining({ key: KEY, contentType: "video/mp4" }),
    );
    expect(await raw.head(KEY)).toMatchObject({ sizeBytes: 4_096 });
  });

  it("does nothing when the raw store already has it", async () => {
    const raw = fakeStore("s3", { [KEY]: 4_096 });
    const derived = fakeStore("r2", { [KEY]: 4_096 });
    await expect(promoteToRaw({ raw, derived }, KEY, "video/mp4")).resolves.toBe(false);
    expect(derived.get).not.toHaveBeenCalled();
    expect(raw.put).not.toHaveBeenCalled();
  });

  it("refuses when neither store has it", async () => {
    await expect(
      promoteToRaw({ raw: fakeStore("s3"), derived: fakeStore("r2") }, KEY, "video/mp4"),
    ).rejects.toThrow(/neither the raw nor the derived store/);
  });

  it("refuses to buffer something far larger than a clip", async () => {
    const raw = fakeStore("s3");
    const derived = fakeStore("r2", { [KEY]: PROMOTE_MAX_BYTES + 1 });
    await expect(promoteToRaw({ raw, derived }, KEY, "video/mp4")).rejects.toThrow(/refusing/);
    expect(derived.get).not.toHaveBeenCalled();
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
