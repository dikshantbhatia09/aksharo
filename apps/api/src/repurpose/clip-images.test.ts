import { describe, expect, it, vi } from "vitest";

import {
  CAROUSEL_FRAMES_AT,
  clipFolder,
  fileOfImage,
  planClipImages,
  stillsJobKey,
  storedImagesOf,
  type ShapeVideos,
} from "./clip-images.js";
import { RepurposeStillsCompletionHandler } from "./stills-completion.handler.js";

const CLIP = "01JCC0000000000000000000CP";
const RUN = "01JCR0000000000000000000RN";

const made = (shape: ShapeVideos["shape"], tag: string): ShapeVideos => ({
  shape,
  settled: true,
  captioned: { exportId: `exp-${tag}`, key: `exports/${tag}.mp4` },
  clean: { mediaId: `med-${tag}`, key: `clips/c/master-${tag}.mp4` },
});
const ALL = [made("9:16", "9x16"), made("4:5", "4x5"), made("1:1", "1x1"), made("16:9", "16x9")];

describe("planClipImages", () => {
  const base = {
    abandoned: new Set<ShapeVideos["shape"]>(),
    folder: "clips/c",
    durationMs: 40_000,
  };

  it("takes fifteen frames from the four videos, into the clip's own folder", () => {
    const plan = planClipImages({ ...base, videos: ALL });
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;
    expect(plan.images).toHaveLength(15);
    const carousel = plan.images.filter((row) => row.name.startsWith("carousel-"));
    expect(carousel.map((row) => row.atMs)).toEqual(
      CAROUSEL_FRAMES_AT.map((at) => Math.floor(40_000 * at)),
    );
    expect(plan.images.every((row) => row.destinationKey.startsWith("clips/c/images/"))).toBe(true);
    expect(plan.cleanFrom).toBe("16:9");
    expect(plan.fingerprint).toContain("16:9:clean:med-16x9");
  });

  it("waits for a shape that has not settled, or has not been cut and was not given up", () => {
    expect(
      planClipImages({ ...base, videos: [{ ...ALL[0]!, settled: false }, ...ALL.slice(1)] }).kind,
    ).toBe("waiting");
    expect(planClipImages({ ...base, videos: ALL.slice(0, 3) }).kind).toBe("waiting");
  });

  it("makes what it can when a shape was given up", () => {
    const plan = planClipImages({
      ...base,
      videos: ALL.slice(0, 3),
      abandoned: new Set(["16:9"]),
    });
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;
    expect(plan.images.some((row) => row.name.startsWith("youtube-banner"))).toBe(false);
    expect(plan.images.some((row) => row.name === "pin-1")).toBe(true);
  });

  it("changes its fingerprint when a captioned video is made again", () => {
    const first = planClipImages({ ...base, videos: ALL });
    const again = planClipImages({
      ...base,
      videos: [
        { ...ALL[0]!, captioned: { exportId: "exp-new", key: "exports/new.mp4" } },
        ...ALL.slice(1),
      ],
    });
    if (first.kind !== "ready" || again.kind !== "ready") throw new Error("not ready");
    expect(again.fingerprint).not.toBe(first.fingerprint);
    expect(stillsJobKey(CLIP, again.fingerprint)).not.toBe(stillsJobKey(CLIP, first.fingerprint));
  });
});

describe("clip image helpers", () => {
  it("reads names, folders and the stored column", () => {
    expect(fileOfImage("carousel-3")).toBe("carousel");
    expect(fileOfImage("youtube-banner-1")).toBe("youtube-banner");
    expect(fileOfImage("nonsense-1")).toBeNull();
    expect(clipFolder("a/b/master.mp4")).toBe("a/b");
    expect(storedImagesOf({})).toBeNull();
    expect(
      storedImagesOf({
        fingerprint: "f",
        images: [{ name: "pin-1", key: "k", width: 1, height: 2 }, 3],
      }),
    ).toEqual({
      fingerprint: "f",
      images: [{ name: "pin-1", key: "k", width: 1, height: 2 }],
    });
  });
});

describe("RepurposeStillsCompletionHandler", () => {
  const params = {
    schemaVersion: 1,
    runId: RUN,
    clipId: CLIP,
    destination: { bucket: "s3", key: "clips/c/images" },
    images: [
      {
        name: "pin-1",
        sourceKey: "exports/9x16.mp4",
        atMs: 9_000,
        width: 1000,
        height: 1500,
        destinationKey: "clips/c/images/pin-1.jpg",
      },
    ],
    fingerprint: "9:16:exp-9x16",
  };
  const result = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    clipId: CLIP,
    fingerprint: "9:16:exp-9x16",
    images: [
      {
        name: "pin-1",
        key: "clips/c/images/pin-1.jpg",
        width: 1000,
        height: 1500,
        sizeBytes: 9,
        atMs: 9_000,
      },
    ],
    ...overrides,
  });
  function handler() {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const instance = new RepurposeStillsCompletionHandler(
      { repurposeClip: { updateMany } } as never,
      { register: vi.fn() } as never,
    );
    const context = (body: Record<string, unknown>) =>
      ({ job: { id: "job", params }, result: body }) as never;
    return { instance, updateMany, context };
  }

  it("files the images on the clip", async () => {
    const { instance, updateMany, context } = handler();
    const outcome = await instance.handle(context(result()));
    expect(outcome.data).toMatchObject({ applied: true, images: 1 });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: CLIP },
      data: {
        images: {
          fingerprint: "9:16:exp-9x16",
          images: [{ name: "pin-1", key: "clips/c/images/pin-1.jpg", width: 1000, height: 1500 }],
        },
      },
    });
  });

  it("applies nothing a worker was not asked for", async () => {
    const { instance, updateMany, context } = handler();
    const stray = result({
      images: [
        { name: "pin-1", key: "ws/other/secret.jpg", width: 1, height: 1, sizeBytes: 1, atMs: 0 },
      ],
    });
    expect((await instance.handle(context(stray))).data).toMatchObject({ applied: false });
    expect((await instance.handle(context(result({ fingerprint: "old" })))).data).toMatchObject({
      applied: false,
    });
    expect(updateMany).not.toHaveBeenCalled();
  });
});
