/**
 * The images a render's overlays draw (2026-10-02): a brand kit's logo, in a
 * corner and on an end card.
 *
 * The payload names each image by id and format only. Its bytes are read from
 * the workspace's own brand prefix (`ws/{workspaceId}/brand/{assetId}.{ext}`),
 * with the workspace taken from the **signed** manifest, so a payload can
 * never point a render at another tenant's object — the same rule the
 * watermark follows.
 *
 * Unlike the watermark, an image the store cannot supply fails the render
 * rather than being skipped: the API only puts an image in a payload when the
 * workspace still has it, so a missing one is a store fault, and a retry is
 * better than a clip quietly made without its logo.
 */

import type { OverlayImage, RenderProjection } from "../queues.js";

/** The largest image a render decodes; uploads are capped far below it (2 MB). */
export const OVERLAY_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** The file extension an image of `format` is stored under. */
export function extensionOfFormat(format: OverlayImage["format"]): "png" | "jpg" | "webp" {
  switch (format) {
    case "png":
      return "png";
    case "jpeg":
      return "jpg";
    case "webp":
      return "webp";
  }
}

/** Every distinct image the projection's overlays draw, in the order they first appear. */
export function overlayImagesOf(projection: RenderProjection): OverlayImage[] {
  const found = new Map<string, OverlayImage>();
  for (const overlay of projection.overlays ?? []) {
    const image =
      overlay.kind === "logo" ? overlay.image : overlay.kind === "end-card" ? overlay.image : null;
    if (image !== null && image !== undefined && !found.has(image.assetId)) {
      found.set(image.assetId, image);
    }
  }
  return [...found.values()];
}

export class OverlayImageError extends Error {
  public override readonly name = "OverlayImageError";
  constructor(
    readonly code: "render/overlay-image-too-large" | "render/overlay-image-unreadable",
    message: string,
    readonly assetId: string,
  ) {
    super(message);
  }
}

/**
 * Reads every image, one at a time (there are one or two).
 *
 * @throws {OverlayImageError} when one cannot be read or is over
 *   {@link OVERLAY_IMAGE_MAX_BYTES}.
 */
export async function loadOverlayImages(
  images: readonly OverlayImage[],
  resolve: (image: OverlayImage) => Promise<Uint8Array>,
): Promise<{ assetId: string; bytes: Uint8Array }[]> {
  const loaded: { assetId: string; bytes: Uint8Array }[] = [];
  for (const image of images) {
    let bytes: Uint8Array;
    try {
      bytes = await resolve(image);
    } catch (error) {
      throw new OverlayImageError(
        "render/overlay-image-unreadable",
        `could not read the overlay image ${image.assetId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        image.assetId,
      );
    }
    if (bytes.byteLength > OVERLAY_IMAGE_MAX_BYTES) {
      throw new OverlayImageError(
        "render/overlay-image-too-large",
        `the overlay image ${image.assetId} is ${String(bytes.byteLength)} bytes, over the cap`,
        image.assetId,
      );
    }
    loaded.push({ assetId: image.assetId, bytes });
  }
  return loaded;
}
