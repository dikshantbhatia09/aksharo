/**
 * What a run is doing, in the one vocabulary every surface shares.
 *
 * The API's stage projection marks the current stage `running` whenever the
 * run is neither failed nor published — which includes a run that is waiting
 * for the person (moments ready, videos ready to review) and a run they stopped.
 * Surfaces that read "a stage is running" as "work is happening" therefore
 * called a cancelled run "In progress", told people "we'll keep working" on a
 * run that was waiting for them, and let an old review-ready run hide a fresh
 * failure on Home. They all decide from `status` through this instead.
 */
import type { RepurposeRunView } from "@montaj/api-client";

export type RunActivity =
  /** Something is running on the server; the page can be left. */
  | "working"
  /** The next step is the person's: pick moments, review videos, approve. */
  | "needs_you"
  | "failed"
  | "stopped"
  | "done";

const NEEDS_YOU: ReadonlySet<string> = new Set([
  "candidates_ready",
  "review_ready",
  "changes_requested",
  "approved",
  "partially_published",
]);

export function runActivity(run: Pick<RepurposeRunView, "status">): RunActivity {
  if (run.status === "failed") return "failed";
  if (run.status === "cancelled") return "stopped";
  if (run.status === "published") return "done";
  return NEEDS_YOU.has(run.status) ? "needs_you" : "working";
}

/**
 * Whether the server is doing something for this run right now: the one rule
 * behind the run page's "we'll keep working" and Home's progress bar.
 *
 * `draft` is `working` to {@link runActivity} (nobody has a choice to make),
 * but nothing on the server moves it: it is an upload run waiting for a file
 * the browser is still sending, or for one that never arrives (the upload
 * never started, failed, or was dismissed). Home counted it as work, so a
 * stuck upload sat there at 0% indefinitely, ahead of runs waiting for the
 * person, while the run page already said otherwise.
 */
export function serverIsWorking(run: Pick<RepurposeRunView, "status">): boolean {
  return runActivity(run) === "working" && run.status !== "draft";
}

/**
 * Statuses at which the source's transcript exists, so a moment can be added by
 * time (`POST /repurpose/runs/{id}/candidates` is refused before then).
 */
const TRANSCRIPT_READY: ReadonlySet<string> = new Set([
  "analyzing",
  "candidates_ready",
  "materializing",
  "rendering",
  "review_ready",
  "changes_requested",
  "approved",
  "publishing",
  "partially_published",
]);

/**
 * Failures a run can carry once its transcript exists: moments can still be
 * added. The API's own list (`FAILED_AFTER_TRANSCRIPT` in
 * `repurpose-clips.service.ts`), which is what accepts or refuses them; the two
 * drifted once already — a discovery that timed out offered no form here while
 * the API would have taken a moment, and any failed run with candidates offered
 * one the API then refused.
 */
const FAILED_AFTER_TRANSCRIPT: ReadonlySet<string> = new Set([
  "repurpose/highlights_failed",
  "repurpose/analysis_failed",
  "repurpose/highlights_no_candidates",
  "repurpose/stage_timeout",
  "repurpose/clip_failed",
]);

export function canAddMoments(
  run: Pick<RepurposeRunView, "status" | "failureCode" | "currentStage">,
): boolean {
  if (TRANSCRIPT_READY.has(run.status)) return true;
  if (run.status !== "failed") return false;
  const code = run.failureCode ?? "";
  if (!FAILED_AFTER_TRANSCRIPT.has(code)) return false;
  // A timeout can also strike while the video is still being fetched, and the
  // run keeps the stage it stopped on: no transcript can exist before
  // "Find clips". (One that stopped while transcribing still passes here; the
  // API then refuses the moment, and the form says the transcript is not ready.)
  return code !== "repurpose/stage_timeout" || run.currentStage !== "getting_video";
}
