import { describe, expect, it } from "vitest";

import {
  extensionOfFormat,
  loadOverlayImages,
  OVERLAY_IMAGE_MAX_BYTES,
  OverlayImageError,
  overlayImagesOf,
} from "./overlay-images.js";
import { brandAssetKey } from "../storage.js";

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
    expect(images).toEqual([LOGO]);
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
    const loaded = await loadOverlayImages([LOGO], (image) => {
      asked.push(image.assetId);
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    });
    expect(asked).toEqual([LOGO.assetId]);
    expect(loaded).toEqual([{ assetId: LOGO.assetId, bytes: new Uint8Array([1, 2, 3]) }]);
  });

  it("fails the render on an image it cannot read, or one over the cap", async () => {
    await expect(
      loadOverlayImages([LOGO], () => Promise.reject(new Error("NoSuchKey"))),
    ).rejects.toMatchObject({ code: "render/overlay-image-unreadable", assetId: LOGO.assetId });
    await expect(
      loadOverlayImages([LOGO], () => Promise.resolve(new Uint8Array(OVERLAY_IMAGE_MAX_BYTES + 1))),
    ).rejects.toBeInstanceOf(OverlayImageError);
  });
});
