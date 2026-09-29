import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { $Enums } from "@prisma/client";

/**
 * A publish batch's cached summary, recomputed from its posts (master plan
 * §6.8: "counts are a cached summary; the targets remain authoritative").
 * Called after any post in it changes; never throws - a stale header is
 * better than a failed dispatch.
 */
export function batchStatusOf(statuses: readonly $Enums.PublishTargetStatus[]): {
  readonly status: $Enums.PublishBatchStatus;
  readonly publishedCount: number;
  readonly failedCount: number;
} {
  const published = statuses.filter((status) => status === "published").length;
  const failed = statuses.filter(
    (status) =>
      status === "failed_permanent" ||
      status === "failed_retryable" ||
      status === "action_required",
  ).length;
  const cancelled = statuses.filter((status) => status === "cancelled").length;
  const scheduled = statuses.filter((status) => status === "scheduled").length;
  const total = statuses.length;
  let status: $Enums.PublishBatchStatus;
  if (total === 0 || cancelled === total) status = "cancelled";
  else if (published + cancelled === total) status = "published";
  else if (failed + cancelled === total) status = "failed";
  else if (published > 0) status = "partially_published";
  else if (published + failed + cancelled + scheduled === total && scheduled > 0 && failed === 0)
    // Everything is handed over and waiting for its time.
    status = "pending";
  else status = "publishing";
  return { status, publishedCount: published, failedCount: failed };
}

export async function refreshBatch(prisma: PrismaService, batchId: string): Promise<void> {
  try {
    const targets = await prisma.publishTarget.findMany({
      where: { batchId },
      select: { status: true },
    });
    const summary = batchStatusOf(targets.map((target) => target.status));
    await prisma.publishBatch.update({
      where: { id: batchId },
      data: { ...summary, targetCount: targets.length },
    });
  } catch {
    // The summary is a cache; the next change recomputes it.
  }
}
