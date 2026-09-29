import { createHash } from "node:crypto";

import { SHAPE_OF_ASPECT } from "../repurpose/repurpose.constants.js";

import type { VideoShape } from "./platforms.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { $Enums } from "@prisma/client";

/**
 * A clip's captioned videos, per shape, and whether each can be posted
 * (2026-09-29). Only a finished video with captions is posted, never the clean
 * cut and never one whose captions have changed since it was made.
 *
 * Two ways a clip's shape gets its captioned video:
 *
 *   * **Autopilot** (`captionClips`, CLAUDE.md §18-19): the variant records its
 *     render (`latest_export_id`) and whether it is current (`status`). Ready
 *     means `ready` - not `stale` (captions edited, a new render is coming),
 *     not `rendering`, not `failed`.
 *   * **By hand**: the person exported from the editor. The newest finished
 *     MP4 of the clip's project counts, if it was made after the captions were
 *     last changed.
 */

export interface ShapeVideo {
  readonly shape: VideoShape;
  readonly variantId: string;
  /** `ready` can be posted; `making` will be soon; `stale` needs a new export; `none` has none. */
  readonly state: "ready" | "making" | "stale" | "failed" | "none";
  /** The export to post, when `ready`. */
  readonly export: {
    readonly id: string;
    readonly storageKey: string;
    readonly bucket: $Enums.StorageBucket;
    readonly sizeBytes: number | null;
    readonly durationMs: number | null;
  } | null;
}

interface ExportRow {
  readonly id: string;
  readonly status: $Enums.ExportStatus;
  readonly kind: $Enums.ExportKind;
  readonly storageKey: string | null;
  readonly bucket: $Enums.StorageBucket;
  readonly sizeBytes: bigint | null;
  readonly durationMs: number | null;
  readonly createdAt: Date;
}

const EXPORT_SELECT = {
  id: true,
  status: true,
  kind: true,
  storageKey: true,
  bucket: true,
  sizeBytes: true,
  durationMs: true,
  createdAt: true,
} as const;

function postable(row: ExportRow | null | undefined): row is ExportRow & { storageKey: string } {
  return (
    row !== null &&
    row !== undefined &&
    row.status === "succeeded" &&
    row.kind === "mp4" &&
    row.storageKey !== null &&
    row.storageKey !== ""
  );
}

function exportOf(row: ExportRow & { storageKey: string }): NonNullable<ShapeVideo["export"]> {
  return {
    id: row.id,
    storageKey: row.storageKey,
    bucket: row.bucket,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    durationMs: row.durationMs,
  };
}

/** Every shape the clip has a variant in, with its captioned video's state. */
export async function clipVideos(
  prisma: PrismaService,
  clipId: string,
): Promise<Map<VideoShape, ShapeVideo>> {
  const variants = await prisma.clipVariant.findMany({
    where: { clipId },
    select: {
      id: true,
      aspect: true,
      status: true,
      latestExportId: true,
      latestExport: { select: EXPORT_SELECT },
      project: {
        select: {
          edgDocument: { select: { updatedAt: true } },
          exports: {
            where: { status: "succeeded", kind: "mp4", storageKey: { not: null } },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: EXPORT_SELECT,
          },
        },
      },
    },
  });

  const videos = new Map<VideoShape, ShapeVideo>();
  for (const variant of variants) {
    const shape = SHAPE_OF_ASPECT[variant.aspect];
    if (variant.latestExportId !== null || variant.status === "failed") {
      const latest = variant.latestExport;
      const state: ShapeVideo["state"] =
        variant.status === "ready"
          ? postable(latest)
            ? "ready"
            : "none"
          : variant.status === "stale" ||
              variant.status === "rendering" ||
              variant.status === "preparing"
            ? "making"
            : "failed";
      videos.set(shape, {
        shape,
        variantId: variant.id,
        state,
        export: state === "ready" && postable(latest) ? exportOf(latest) : null,
      });
      continue;
    }
    const newest = variant.project.exports[0];
    if (!postable(newest)) {
      videos.set(shape, { shape, variantId: variant.id, state: "none", export: null });
      continue;
    }
    const editedAt = variant.project.edgDocument?.updatedAt ?? null;
    const current = editedAt === null || newest.createdAt.getTime() >= editedAt.getTime();
    videos.set(shape, {
      shape,
      variantId: variant.id,
      state: current ? "ready" : "stale",
      export: current ? exportOf(newest) : null,
    });
  }
  return videos;
}

/**
 * What a post was agreed on, as a fingerprint: the export and the object it
 * points at. Re-checked when the post is sent; if the video it names has been
 * replaced or deleted since, the post fails instead of sending something else
 * (master plan §11.6).
 */
export function artifactFingerprint(video: {
  readonly id: string;
  readonly storageKey: string;
  readonly sizeBytes: number | null;
}): string {
  return createHash("sha256")
    .update(`${video.id}|${video.storageKey}|${String(video.sizeBytes ?? "")}`)
    .digest("hex");
}
