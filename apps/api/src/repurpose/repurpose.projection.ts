import type { $Enums } from "@prisma/client";

/**
 * The beginner-facing projection (REP-006, master plan §3.2 and §13.4).
 *
 * Pure functions, no database and no Nest: this is the layer that decides what a
 * person is told, so it is the layer worth testing exhaustively.
 *
 * Two rules it exists to enforce:
 *
 *   * **nothing technical leaks.** No queue name, no job id, no worker error, no
 *     "Postiz", no "montaj". `assertBeginnerSafe` is the test hook for that;
 *   * **status is derived once.** The five visible stages and their states are
 *     computed here from the run's coarse status, rather than each surface
 *     inventing its own mapping.
 */

/** The five stages, in the fixed order the rail draws them (§3.2). */
export const STAGES = [
  "getting_video",
  "finding_clips",
  "styles_formats",
  "review",
  "publish",
] as const;
export type Stage = (typeof STAGES)[number];

export type StageState = "waiting" | "running" | "complete" | "failed";

export interface StageView {
  readonly stage: Stage;
  readonly state: StageState;
  /** One short line. Present tense while running, past tense when complete. */
  readonly label: string;
}

export interface RunProjection {
  readonly id: string;
  readonly status: $Enums.RepurposeRunStatus;
  readonly currentStage: Stage;
  readonly progress: number;
  readonly stages: readonly StageView[];
  /** Plain language for the stage that is running, or the one that failed. */
  readonly message: string;
  readonly failureCode: string | null;
  readonly canCancel: boolean;
  /**
   * Whether the status allows a retry at all. The run's own view narrows it
   * with the retry plan (`RepurposeService.retryPossible`): a failed upload
   * whose file could not be read is `failed`, and still has nothing to retry.
   */
  readonly canRetry: boolean;
}

/**
 * Which visible stage each internal status belongs to.
 *
 * `draft` is `getting_video` rather than a sixth stage: a run that exists but has
 * no media yet is, to the person who made it, still adding the video.
 */
const STAGE_BY_STATUS: Readonly<Record<$Enums.RepurposeRunStatus, Stage>> = Object.freeze({
  draft: "getting_video",
  acquiring: "getting_video",
  preparing_media: "getting_video",
  transcribing: "finding_clips",
  analyzing: "finding_clips",
  candidates_ready: "finding_clips",
  materializing: "styles_formats",
  rendering: "styles_formats",
  review_ready: "review",
  changes_requested: "review",
  approved: "review",
  publishing: "publish",
  partially_published: "publish",
  published: "publish",
  // A failed or cancelled run keeps the stage it stopped on, which the caller
  // passes in; these two entries are the fallback when it is unknown.
  failed: "getting_video",
  cancelled: "getting_video",
});

/**
 * The sentence shown under the active stage.
 *
 * Deliberately about the video, not the system: "Creating the transcript", never
 * "ai.transcribe queued" (§13.4).
 */
const MESSAGE_BY_STATUS: Readonly<Record<$Enums.RepurposeRunStatus, string>> = Object.freeze({
  draft: "Add a video to get started.",
  acquiring: "Getting your video.",
  preparing_media: "Preparing audio and preview.",
  transcribing: "Creating the transcript.",
  analyzing: "Finding promising moments.",
  candidates_ready: "Your suggested moments are ready.",
  materializing: "Creating your clips.",
  rendering: "Adding captions and preparing each size.",
  review_ready: "Your videos are ready to review.",
  changes_requested: "You asked for changes on some videos.",
  approved: "Everything is approved and ready to publish.",
  publishing: "Publishing to your accounts.",
  partially_published: "Some posts are done; some still need you.",
  published: "All done.",
  failed: "Something went wrong. Your work is safe.",
  cancelled: "You stopped this run. Nothing else will happen.",
});

/** Coarse progress for a list row. The stage rail derives its own detail. */
const PROGRESS_BY_STATUS: Readonly<Record<$Enums.RepurposeRunStatus, number>> = Object.freeze({
  draft: 0,
  acquiring: 5,
  preparing_media: 15,
  transcribing: 30,
  analyzing: 45,
  candidates_ready: 55,
  materializing: 65,
  rendering: 75,
  review_ready: 85,
  changes_requested: 85,
  approved: 90,
  publishing: 95,
  partially_published: 97,
  published: 100,
  failed: 0,
  cancelled: 0,
});

/** Statuses a person may still stop. Cancelling a finished run means nothing. */
const CANCELLABLE: ReadonlySet<$Enums.RepurposeRunStatus> = new Set([
  "draft",
  "acquiring",
  "preparing_media",
  "transcribing",
  "analyzing",
  "candidates_ready",
  "materializing",
  "rendering",
  "review_ready",
  "changes_requested",
  "approved",
  "publishing",
]);

export function stageForStatus(status: $Enums.RepurposeRunStatus): Stage {
  // eslint-disable-next-line security/detect-object-injection -- lookup on a closed enum key, not attacker-controlled
  return STAGE_BY_STATUS[status];
}

export function messageForStatus(status: $Enums.RepurposeRunStatus): string {
  // eslint-disable-next-line security/detect-object-injection -- lookup on a closed enum key, not attacker-controlled
  return MESSAGE_BY_STATUS[status];
}

/**
 * `candidates_ready` with nothing to pick (2026-09-26). An empty suggestion list
 * is a legitimate answer — a manual-mode run asks for none, and discovery can
 * find no moment worth cutting — and "your suggested moments are ready" over an
 * empty list read as a page that had failed to load them. The page offers adding
 * a moment by its times instead.
 */
export const NO_CANDIDATES_MESSAGE = "Your video is ready. Add the moments you want to clip.";

export function progressForStatus(status: $Enums.RepurposeRunStatus): number {
  // eslint-disable-next-line security/detect-object-injection -- lookup on a closed enum key, not attacker-controlled
  return PROGRESS_BY_STATUS[status];
}

export function isCancellable(status: $Enums.RepurposeRunStatus): boolean {
  return CANCELLABLE.has(status);
}

/** Only a failed run retries. A cancelled one is a decision, not an error. */
export function isRetryable(status: $Enums.RepurposeRunStatus): boolean {
  return status === "failed";
}

function stageIndex(stage: Stage): number {
  return STAGES.indexOf(stage);
}

const STAGE_LABELS: Readonly<Record<Stage, { running: string; complete: string; waiting: string }>> =
  Object.freeze({
    getting_video: {
      waiting: "Add video",
      running: "Getting your video",
      complete: "Video added",
    },
    finding_clips: {
      waiting: "Find clips",
      running: "Finding clips",
      complete: "Clips found",
    },
    styles_formats: {
      waiting: "Style formats",
      running: "Preparing your formats",
      complete: "Formats ready",
    },
    review: { waiting: "Review", running: "Ready to review", complete: "Reviewed" },
    publish: { waiting: "Publish", running: "Publishing", complete: "Published" },
  });

/**
 * Build the whole view a stage rail renders.
 *
 * `currentStage` is stored on the run rather than recomputed, because a failed or
 * cancelled run must keep the stage it stopped on — the status alone no longer
 * says where it was.
 */
export function projectRun(input: {
  readonly id: string;
  readonly status: $Enums.RepurposeRunStatus;
  readonly currentStage: string;
  readonly failureCode: string | null;
  readonly progress?: number;
  /** When known: `candidates_ready` with none says so rather than promising some. */
  readonly candidateCount?: number;
}): RunProjection {
  const stored = (STAGES as readonly string[]).includes(input.currentStage)
    ? (input.currentStage as Stage)
    : stageForStatus(input.status);
  const current =
    input.status === "failed" || input.status === "cancelled" ? stored : stageForStatus(input.status);
  const currentIndex = stageIndex(current);
  const failed = input.status === "failed";

  const stages = STAGES.map<StageView>((stage) => {
    const index = stageIndex(stage);
    // eslint-disable-next-line security/detect-object-injection -- `stage` is one of the five literals of STAGES
    const labels = STAGE_LABELS[stage];
    if (index < currentIndex) return { stage, state: "complete", label: labels.complete };
    if (index > currentIndex) return { stage, state: "waiting", label: labels.waiting };
    if (failed) return { stage, state: "failed", label: labels.waiting };
    if (input.status === "published") return { stage, state: "complete", label: labels.complete };
    return { stage, state: "running", label: labels.running };
  });

  return {
    id: input.id,
    status: input.status,
    currentStage: current,
    // A stored ZERO means "nobody has written this", not "no progress". The
    // column exists for a producer that reports a finer-grained number than the
    // status can — a download percentage, say — and no such producer exists yet,
    // so it sits at its default while the status moves underneath it. `??` only
    // falls back on null, so the default won and the bar stayed at 0% through
    // acquiring, preparing and transcribing while the rail beside it advanced.
    // Two things on one screen disagreeing about the same run is worse than
    // either being coarse.
    progress:
      input.progress !== undefined && input.progress > 0
        ? input.progress
        : progressForStatus(input.status),
    stages,
    message:
      input.status === "candidates_ready" && input.candidateCount === 0
        ? NO_CANDIDATES_MESSAGE
        : messageForStatus(input.status),
    failureCode: input.failureCode,
    canCancel: isCancellable(input.status),
    canRetry: isRetryable(input.status),
  };
}

/**
 * Words that must never appear in anything a person reads (§3.2, §13.4).
 *
 * The engineering codename is on the list because CONTRACTS §0 allows it inside
 * queue names and package names only; a user has never heard of it.
 */
export const FORBIDDEN_USER_FACING_WORDS = [
  "montaj",
  "postiz",
  "queue",
  "worker",
  "webhook",
  "ffmpeg",
  "manifest",
  "edg",
  "bullmq",
  "prisma",
  "redis",
  "s3",
  "stack trace",
] as const;

/** Every forbidden word `text` contains, lower-cased. Empty means it is safe. */
export function beginnerSafetyViolations(text: string): string[] {
  const haystack = text.toLowerCase();
  return FORBIDDEN_USER_FACING_WORDS.filter((word) => haystack.includes(word));
}
