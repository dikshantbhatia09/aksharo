"use client";

/**
 * How many of the workspace's videos are being made into clips right now
 * (2026-10-01, OpusClip's processing indicator in its nav): the Clips entry of
 * the rail and the sidebar shows it, so a person on another page can see work
 * is still going without opening the run.
 *
 * The same list Home's banner reads, with its own poll (20 s while a run moves
 * on its own, none otherwise) and the realtime stage events refreshing it, and
 * Home's rule for "working" (`serverIsWorking`): from the download until the
 * moments are found, and while clips are cut or rendered. A run waiting on its
 * person, an upload still being sent, and an Autopilot run already showing its
 * moments while it makes the other sizes are not counted, as on Home.
 */
import { useFeatureFlag, useRepurposeRuns } from "@montaj/api-client";

import { REPURPOSE_FLOW_FLAG } from "@/components/home/pipeline-banner";
import { serverIsWorking } from "@/components/repurpose/run-activity";

export function useRunsInProgress(): number {
  const enabled = useFeatureFlag(REPURPOSE_FLOW_FLAG);
  const runs = useRepurposeRuns(enabled);
  if (!enabled) return 0;
  return (runs.data?.items ?? []).filter((run) => serverIsWorking(run)).length;
}

/** "1 video in progress", "3 videos in progress". */
export function inProgressLabel(count: number): string {
  return count === 1 ? "1 video in progress" : `${String(count)} videos in progress`;
}
