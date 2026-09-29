import { createHash } from "node:crypto";

import {
  IMAGE_FILES,
  IMAGE_FILE_IDS,
  VIDEO_SHAPES,
  type ImageFileId,
  type StillRequest,
  type VideoShape,
} from "@montaj/repurpose-contracts";

/**
 * A clip's image formats (2026-09-29): which frames of which of its videos
 * become which images, and when they are due.
 *
 * Pure, so the view and Autopilot's pass read the same answer: the images are
 * made once every shape of the clip has settled (its captioned video made or
 * failed for good, or its cut abandoned), from the videos it has then. The set
 * is named by those videos (`fingerprint`), so new captions make new images
 * and nothing else does.
 */

/** Where a single image is taken, as a fraction of the clip. */
export const IMAGE_FRAME_AT = 0.3;
/** A carousel's slides, spread through the clip. */
export const CAROUSEL_FRAMES_AT = [0.15, 0.32, 0.5, 0.68, 0.85] as const;
/** How many failed `media.stills` jobs for one set before Autopilot leaves it. */
export const IMAGE_ATTEMPTS = 3;
/** How long an image link lasts; the page refetches the list far more often. */
export const IMAGE_URL_TTL_SECONDS = 3_600;

/** One shape's videos, as far as the images care. */
export interface ShapeVideos {
  readonly shape: VideoShape;
  /** The variant's captioned video is made, or failed for good. */
  readonly settled: boolean;
  /** The captioned video, when made and current. */
  readonly captioned: { readonly exportId: string; readonly key: string } | null;
  /** The clean cut (the variant project's primary media, in the derived store too). */
  readonly clean: { readonly mediaId: string; readonly key: string } | null;
}

export type ImagePlan =
  | { readonly kind: "waiting" }
  | { readonly kind: "none" }
  | {
      readonly kind: "ready";
      readonly fingerprint: string;
      readonly images: readonly StillRequest[];
      /** Which images crop a clean frame, whose focus the caller may set from faces. */
      readonly cleanFrom: VideoShape | null;
    };

/**
 * The images a clip is due.
 *
 * @param videos the clip's shapes that have a variant
 * @param abandoned shapes whose cut was given up, so nothing waits on them
 * @param folder where the clip's own files live (its master's folder)
 * @param durationMs the clip's length
 */
export function planClipImages(input: {
  readonly videos: readonly ShapeVideos[];
  readonly abandoned: ReadonlySet<VideoShape>;
  readonly folder: string;
  readonly durationMs: number;
}): ImagePlan {
  const byShape = new Map(input.videos.map((video) => [video.shape, video]));
  for (const shape of VIDEO_SHAPES) {
    const video = byShape.get(shape);
    if (video === undefined ? !input.abandoned.has(shape) : !video.settled) {
      return { kind: "waiting" };
    }
  }
  if (!(input.durationMs > 0)) return { kind: "none" };

  const used = new Set<string>();
  const images: StillRequest[] = [];
  let cleanFrom: VideoShape | null = null;
  for (const id of IMAGE_FILE_IDS) {
    // eslint-disable-next-line security/detect-object-injection -- key is a closed enum (image file id / video shape), not input
    const file = IMAGE_FILES[id];
    const video = byShape.get(file.from);
    const source = file.captioned ? video?.captioned : video?.clean;
    if (source === undefined || source === null) continue;
    used.add(
      "exportId" in source
        ? `${file.from}:${source.exportId}`
        : `${file.from}:clean:${source.mediaId}`,
    );
    if (!file.captioned) cleanFrom = file.from;
    const at = file.count === 1 ? [IMAGE_FRAME_AT] : CAROUSEL_FRAMES_AT.slice(0, file.count);
    at.forEach((fraction, index) => {
      const name = imageName(id, index);
      images.push({
        name,
        sourceKey: source.key,
        atMs: Math.floor(input.durationMs * fraction),
        width: file.width,
        height: file.height,
        destinationKey: `${input.folder}/images/${name}.jpg`,
      });
    });
  }
  if (images.length === 0) return { kind: "none" };
  return { kind: "ready", fingerprint: [...used].sort().join(","), images, cleanFrom };
}

export function imageName(id: ImageFileId, index: number): string {
  return `${id}-${String(index + 1)}`;
}

/** The folder a clip's own files sit in: its master's. */
export function clipFolder(mezzanineKey: string): string {
  return mezzanineKey.slice(0, mezzanineKey.lastIndexOf("/"));
}

/** Every `media.stills` job for a clip starts with this. */
export function stillsKeyPrefix(clipId: string): string {
  return `media.stills:${clipId}:`;
}

/** The job key of one set: a set failed three times is not asked for again. */
export function stillsJobKey(clipId: string, fingerprint: string): string {
  return `${stillsKeyPrefix(clipId)}${createHash("sha256").update(fingerprint).digest("hex").slice(0, 16)}`;
}

/** What `repurpose_clips.images` holds once a set is made. */
export interface StoredClipImages {
  readonly fingerprint: string;
  readonly images: readonly {
    readonly name: string;
    readonly key: string;
    readonly width: number;
    readonly height: number;
  }[];
}

/** Read the column; anything unrecognised is "none made yet". */
export function storedImagesOf(value: unknown): StoredClipImages | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const fingerprint = record["fingerprint"];
  const images = record["images"];
  if (typeof fingerprint !== "string" || !Array.isArray(images)) return null;
  const rows = images.filter(
    (row): row is StoredClipImages["images"][number] =>
      typeof row === "object" &&
      row !== null &&
      typeof (row as Record<string, unknown>)["name"] === "string" &&
      typeof (row as Record<string, unknown>)["key"] === "string" &&
      typeof (row as Record<string, unknown>)["width"] === "number" &&
      typeof (row as Record<string, unknown>)["height"] === "number",
  );
  return { fingerprint, images: rows };
}

/** The image file a stored image belongs to, from its name. */
export function fileOfImage(name: string): ImageFileId | null {
  const id = name.replace(/-\d+$/, "");
  return (IMAGE_FILE_IDS as readonly string[]).includes(id) ? (id as ImageFileId) : null;
}
