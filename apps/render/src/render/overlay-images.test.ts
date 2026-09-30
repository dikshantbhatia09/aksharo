import { describe, expect, it } from "vitest";

import {
  extensionOfFormat,
  loadOverlayImages,
  OVERLAY_IMAGE_MAX_BYTES,
  OverlayImageError,
  overlayImageKey,
  overlayImagesOf,
} from "./overlay-images.js";
import { RenderProjectionSchema } from "../queues.js";
import { brandAssetKey, brollAssetKey, StorageError } from "../storage.js";

import type { OverlayImage, RenderProjection } from "../queues.js";

const LOGO: OverlayImage = {
  assetId: "01JASSET000000000000000000",
  format: "webp",
  width: 512,
  height: 256,
};

const projection = (overlays: RenderProjection["overlays"]): RenderProjection => ({
  canvas: { width: 1080, height: 1920 },
  segments: [],
  words: [],
  ...(overlays === undefined ? {} : { overlays }),
});

describe("overlayImagesOf", () => {
  it("lists each image the logo and the end card draw, once", () => {
    const images = overlayImagesOf(
      projection([
        {
          id: "a",
          kind: "hook-title",
          text: "Hook",
          startMs: 0,
          endMs: 2_500,
        },
        {
          id: "b",
          kind: "logo",
          startMs: 0,
          endMs: 30_000,
          image: LOGO,
          corner: "top-right",
          sizePct: 16,
          opacity: 1,
          marginPct: 4,
        },
        {
          id: "c",
          kind: "end-card",
          startMs: 27_000,
          endMs: 30_000,
          cta: "Follow",
          background: "#000000",
          image: LOGO,
        },
      ]),
    );
    expect(images).toEqual([{ ...LOGO, library: "brand" }]);
  });

  it("is empty for a projection with no image to draw", () => {
    expect(overlayImagesOf(projection(undefined))).toEqual([]);
    expect(
      overlayImagesOf(
        projection([
          { id: "c", kind: "end-card", startMs: 0, endMs: 1, cta: "x", background: "#000000" },
        ]),
      ),
    ).toEqual([]);
  });
});

describe("extensionOfFormat", () => {
  it("names the file the way the upload stored it", () => {
    expect(extensionOfFormat("png")).toBe("png");
    expect(extensionOfFormat("jpeg")).toBe("jpg");
    expect(extensionOfFormat("webp")).toBe("webp");
    expect(brandAssetKey("01JWKSPACE0000000000000000", LOGO.assetId, "webp")).toBe(
      `ws/01JWKSPACE0000000000000000/brand/${LOGO.assetId}.webp`,
    );
  });
});

describe("loadOverlayImages", () => {
  it("reads each image through the resolver it is given", async () => {
    const asked: string[] = [];
    const loaded = await loadOverlayImages([{ ...LOGO, library: "brand" }], (image) => {
      asked.push(image.assetId);
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    });
    expect(asked).toEqual([LOGO.assetId]);
    expect(loaded).toEqual([{ assetId: LOGO.assetId, bytes: new Uint8Array([1, 2, 3]) }]);
  });

  it("fails the render on an image it cannot read, or one over the cap", async () => {
    const logo = { ...LOGO, library: "brand" as const };
    await expect(
      loadOverlayImages([logo], () => Promise.reject(new Error("NoSuchKey"))),
    ).rejects.toMatchObject({ code: "render/overlay-image-unreadable", assetId: LOGO.assetId });
    await expect(
      loadOverlayImages([logo], () => Promise.resolve(new Uint8Array(OVERLAY_IMAGE_MAX_BYTES + 1))),
    ).rejects.toBeInstanceOf(OverlayImageError);
  });
});

describe("a B-roll cutaway's picture (2026-10-05)", () => {
  const WORKSPACE = "01JWKSPACE0000000000000000";
  const OTHER = "01JQTHER000000000000000000";
  const PICTURE: OverlayImage = {
    assetId: "01JPX0000000000000000000C1",
    format: "jpeg",
    width: 1440,
    height: 2560,
  };
  const cutaway = (image: OverlayImage) => ({
    id: "01JBR0000000000000000000C1",
    kind: "b-roll" as const,
    startMs: 4_000,
    endMs: 7_000,
    image,
    mode: "full" as const,
    motion: "push-in" as const,
  });

  it("is read from the B-roll folder, a logo from the brand folder, each once", () => {
    const images = overlayImagesOf(
      projection([
        cutaway(PICTURE),
        { ...cutaway(PICTURE), id: "01JBR0000000000000000000C2", startMs: 9_000, endMs: 11_000 },
        {
          id: "b",
          kind: "logo",
          startMs: 0,
          endMs: 30_000,
          image: LOGO,
          corner: "top-right",
          sizePct: 16,
          opacity: 1,
          marginPct: 4,
        },
      ]),
    );
    expect(images).toEqual([
      { ...PICTURE, library: "broll" },
      { ...LOGO, library: "brand" },
    ]);
    expect(overlayImageKey(WORKSPACE, { ...PICTURE, library: "broll" })).toBe(
      `ws/${WORKSPACE}/broll/${PICTURE.assetId}.jpg`,
    );
    expect(overlayImageKey(WORKSPACE, { ...LOGO, library: "brand" })).toBe(
      `ws/${WORKSPACE}/brand/${LOGO.assetId}.webp`,
    );
    expect(brollAssetKey(WORKSPACE, PICTURE.assetId, "png")).toBe(
      `ws/${WORKSPACE}/broll/${PICTURE.assetId}.png`,
    );
  });

  it("is only ever read under the workspace it is given, the signed manifest's", async () => {
    // A store holding the same asset id under two workspaces: the render asks
    // for the one under its own, and a picture only another workspace has is
    // an unreadable image, never that workspace's file.
    const store = new Map<string, Uint8Array>([
      [`ws/${OTHER}/broll/${PICTURE.assetId}.jpg`, new Uint8Array([9, 9, 9])],
    ]);
    const asked: string[] = [];
    const resolve = (image: Parameters<typeof overlayImageKey>[1]) => {
      const key = overlayImageKey(WORKSPACE, image);
      asked.push(key);
      const bytes = store.get(key);
      return bytes === undefined ? Promise.reject(new Error("NoSuchKey")) : Promise.resolve(bytes);
    };
    await expect(
      loadOverlayImages(overlayImagesOf(projection([cutaway(PICTURE)])), resolve),
    ).rejects.toMatchObject({ code: "render/overlay-image-unreadable" });
    expect(asked).toEqual([`ws/${WORKSPACE}/broll/${PICTURE.assetId}.jpg`]);

    store.set(`ws/${WORKSPACE}/broll/${PICTURE.assetId}.jpg`, new Uint8Array([1, 2, 3]));
    await expect(
      loadOverlayImages(overlayImagesOf(projection([cutaway(PICTURE)])), resolve),
    ).resolves.toEqual([{ assetId: PICTURE.assetId, bytes: new Uint8Array([1, 2, 3]) }]);
  });

  it("refuses an id that is a path, and a workspace that is not a ULID", () => {
    expect(() =>
      overlayImageKey(WORKSPACE, {
        ...PICTURE,
        assetId: `../../${OTHER}/broll/${PICTURE.assetId}`,
        library: "broll",
      }),
    ).toThrow(StorageError);
    expect(() => brollAssetKey("../other", PICTURE.assetId, "jpg")).toThrow(StorageError);
    // The payload itself never carries one: the schema holds image ids to ULIDs.
    expect(
      RenderProjectionSchema.safeParse(
        projection([cutaway({ ...PICTURE, assetId: `../../${OTHER}/broll/x` })]),
      ).success,
    ).toBe(false);
  });
});
