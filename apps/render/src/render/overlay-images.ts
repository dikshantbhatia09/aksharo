/**
 * The images a render's overlays draw (2026-10-02): a brand kit's logo, in a
 * corner and on an end card; and a B-roll cutaway's picture (2026-10-05).
 *
 * The payload names each image by id and format only. Its bytes are read from
 * the workspace's own prefix - `ws/{workspaceId}/brand/{assetId}.{ext}` for a
 * logo, `ws/{workspaceId}/broll/{assetId}.{ext}` for a cutaway, by the kind of
 * overlay that draws it, never by anything the payload says - with the
 * workspace taken from the **signed** manifest, so a payload can never point a
 * render at another tenant's object — the same rule the watermark follows.
 *
 * Unlike the watermark, an image the store cannot supply fails the render
 * rather than being skipped: the API only puts an image in a payload when the
 * workspace still has it, so a missing one is a store fault, and a retry is
 * better than a clip quietly made without its logo or its cutaway.
 */

import { brandAssetKey, brollAssetKey } from "../storage.js";

import type { OverlayImage, RenderProjection } from "../queues.js";

/** The largest image a render decodes; logos are capped far below it (2 MB), B-roll at it. */
export const OVERLAY_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** Which of the workspace's folders an image is read from: a logo's, or the B-roll library's. */
export type OverlayImageLibrary = "brand" | "broll";

/** An image to read, and the folder its overlay's kind says it is in. */
export interface OverlayImageToLoad extends OverlayImage {
  readonly library: OverlayImageLibrary;
}

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

/**
 * Where an image is read from: its folder under `workspaceId` - the signed
 * manifest's, which is the only workspace a caller may pass - and nowhere else.
 *
 * @throws StorageError `storage/bad-key` for an id that is not a ULID.
 */
export function overlayImageKey(workspaceId: string, image: OverlayImageToLoad): string {
  const extension = extensionOfFormat(image.format);
  return image.library === "broll"
    ? brollAssetKey(workspaceId, image.assetId, extension)
    : brandAssetKey(workspaceId, image.assetId, extension);
}

/**
 * Every distinct image the projection's overlays draw, in the order they first
 * appear, each with the folder its overlay's kind reads it from. An id named
 * both as a logo and as a cutaway is read from both folders (it can only be
 * found in one, and then the render fails, as for any missing image).
 */
export function overlayImagesOf(projection: RenderProjection): OverlayImageToLoad[] {
  const found = new Map<string, OverlayImageToLoad>();
  for (const overlay of projection.overlays ?? []) {
    const image =
      overlay.kind === "logo" || overlay.kind === "b-roll" || overlay.kind === "end-card"
        ? overlay.image
        : undefined;
    if (image === undefined) continue;
    const library: OverlayImageLibrary = overlay.kind === "b-roll" ? "broll" : "brand";
    const key = `${library}:${image.assetId}`;
    if (!found.has(key)) found.set(key, { ...image, library });
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
 * Reads every image, one at a time (a logo or two, and a clip's few cutaways).
 *
 * @throws {OverlayImageError} when one cannot be read or is over
 *   {@link OVERLAY_IMAGE_MAX_BYTES}.
 */
export async function loadOverlayImages(
  images: readonly OverlayImageToLoad[],
  resolve: (image: OverlayImageToLoad) => Promise<Uint8Array>,
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
