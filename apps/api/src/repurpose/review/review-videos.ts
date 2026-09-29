import type { VideoShape } from "@montaj/repurpose-contracts";

import { SHAPE_OF_ASPECT } from "../repurpose.constants.js";

import type { ShapeVideo } from "./review-state.js";
import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { $Enums } from "@prisma/client";

/**
 * The captioned video a review is about, per shape of each clip (2026-10-03).
 *
 * The same file posting would send (`publishing/clip-videos.ts`), so a
 * decision is pinned to what goes out:
 *
 *   * **Autopilot's render** (`latest_export_id` set): that render once it is
 *     made. While a newer one is being made (the captions were edited), the
 *     previous file is still the one on screen, so it is the one a reviewer
 *     decides on - and the new one, when it lands, returns the decision to
 *     pending.
 *   * **By hand**: the newest finished MP4 of the clip's project.
 *
 * Only finished MP4s whose file is still stored count: a video retention has
 * deleted is no video to review.
 */
export interface ReviewVideo extends ShapeVideo {
  readonly storageKey: string;
  readonly durationMs: number | null;
}

const VIDEO_SELECT = {
  id: true,
  status: true,
  kind: true,
  storageKey: true,
  durationMs: true,
} as const;

interface VideoRow {
  readonly id: string;
  readonly status: $Enums.ExportStatus;
  readonly kind: $Enums.ExportKind;
  readonly storageKey: string | null;
  readonly durationMs: number | null;
}

function finished(row: VideoRow | null | undefined): row is VideoRow & { storageKey: string } {
  return (
    row !== null &&
    row !== undefined &&
    row.status === "succeeded" &&
    row.kind === "mp4" &&
    row.storageKey !== null &&
    row.storageKey !== ""
  );
}

/** Each clip's review video per shape. Clips with none are absent from the map. */
export async function reviewVideosOf(
  prisma: PrismaService,
  clipIds: readonly string[],
): Promise<Map<string, Map<VideoShape, ReviewVideo>>> {
  const byClip = new Map<string, Map<VideoShape, ReviewVideo>>();
  if (clipIds.length === 0) return byClip;
  const variants = await prisma.clipVariant.findMany({
    where: { clipId: { in: [...new Set(clipIds)] } },
    select: {
      clipId: true,
      aspect: true,
      latestExportId: true,
      latestExport: { select: VIDEO_SELECT },
      project: {
        select: {
          exports: {
            where: { status: "succeeded", kind: "mp4", storageKey: { not: null } },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: VIDEO_SELECT,
          },
        },
      },
    },
  });
  for (const variant of variants) {
    const latest = variant.latestExport;
    const chosen =
      variant.latestExportId !== null && finished(latest) ? latest : variant.project.exports[0];
    if (!finished(chosen)) continue;
    const shapes = byClip.get(variant.clipId) ?? new Map<VideoShape, ReviewVideo>();
    shapes.set(SHAPE_OF_ASPECT[variant.aspect], {
      exportId: chosen.id,
      storageKey: chosen.storageKey,
      durationMs: chosen.durationMs,
    });
    byClip.set(variant.clipId, shapes);
  }
  return byClip;
}
