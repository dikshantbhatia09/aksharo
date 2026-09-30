import type { PerformanceSignal } from "@montaj/repurpose-contracts";

import { WHAT_WORKS_MAX_POSTS } from "./performance.constants.js";
import { loadPostFacts, timeZoneFor } from "./post-facts.js";
import { insightsOf, steeringSignalOf } from "./what-works.js";

import type { PrismaService } from "../../common/prisma/prisma.service.js";

/**
 * The track record a run's `ai.highlights` is sent (2026-10-05): what a year
 * of the workspace's posts says worked, or null while they are too few to say
 * anything (`steeringSignalOf`). Read once, when discovery starts; the run
 * page's candidates carry what it did to them as `track_record` reasons.
 */
export const STEERING_WINDOW_MS = 365 * 24 * 60 * 60_000;

export async function performanceSignalFor(
  prisma: Pick<PrismaService, "clipPost" | "publishBatch">,
  workspaceId: string,
  now: Date,
): Promise<PerformanceSignal | null> {
  const since = new Date(now.getTime() - STEERING_WINDOW_MS);
  const [posts, timeZone] = await Promise.all([
    loadPostFacts(prisma, workspaceId, since, WHAT_WORKS_MAX_POSTS),
    timeZoneFor(prisma, workspaceId),
  ]);
  return steeringSignalOf(posts, insightsOf(posts, timeZone));
}
