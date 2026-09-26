import { REPURPOSE_CLIP_ERRORS } from "./repurpose-clips.dto.js";
import { JOB_ERROR_CODES } from "../jobs/jobs.errors.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { $Enums, Prisma, RepurposeRun } from "@prisma/client";

/**
 * What a clip is doing, derived — never stored (2026-09-26).
 *
 * - `ready`: the mezzanine exists and the 9:16 child project could be made
 *   from it (or is still being made from it).
 * - `cutting`: its newest `media.clip` job is queued or running.
 * - `failed`: its newest job failed, was cancelled, stalled (below), or
 *   succeeded without the cut ever being recorded (a completion the old handler
 *   dropped because the run had failed). Or the cut landed but the child
 *   project's media failed its probe or proxy — the editor cannot open such a
 *   clip, and cutting it again is how it is repaired
 *   (`RepurposeClipCompletionHandler` re-runs the pipeline). Retry is offered.
 * - `waiting`: a cut was asked for and no job took it — the plan's lane was
 *   full. Either it has no job at all, or it was asked for again (a retry, a
 *   re-cut) after its newest job ended ({@link cutRequestedSince}).
 *   `RepurposeClipsService.reconcileClips` enqueues it once a slot frees;
 *   nobody has to press anything. Unless the source's original has been purged
 *   meanwhile (`sourceGone`): nothing can ever cut it then, so it is `failed`
 *   with `repurpose/source_expired` rather than waiting forever.
 *
 * Everything here is already in `repurpose_clips`, the child's `media_assets`
 * and `jobs`, so the state cannot drift from what actually happened, the way a
 * stored status column would the first time a producer forgot to write it.
 */
export type ClipState = "waiting" | "cutting" | "ready" | "failed";

/**
 * The newest `media.clip` job for one clip, as much of it as the state needs.
 * The timings are optional so a caller holding only the status still gets an
 * answer; without them a job is never read as stalled or as superseded.
 */
export interface LatestClipJob {
  readonly id: string;
  readonly status: $Enums.JobStatus;
  readonly error: Prisma.JsonValue | null;
  readonly queuedAt?: Date;
  readonly startedAt?: Date | null;
  readonly finishedAt?: Date | null;
  readonly maxQueueWaitMs?: number | null;
}

/** What {@link clipStateOf} reads of a clip row. */
export interface ClipFacts {
  readonly mezzanineKey: string | null;
  /**
   * Touched when a cut is asked for and the plan's lane refuses it
   * (`RepurposeClipsService`) — the only record that a cut is owed, since no
   * job exists to say so. The completion handler also writes the row, but
   * always while its job is still open, so only a touch after the newest job
   * ENDED means "cut this again". A new writer of `repurpose_clips` must keep to
   * that too (write only while the clip's job is open), or a failed clip it
   * touches would read `waiting` and be cut again without anyone asking.
   */
  readonly updatedAt?: Date;
  /**
   * The 9:16 child project's primary media: `undefined` when the caller did not
   * load it, `null` when the clip has none.
   */
  readonly childMedia?: { readonly status: string; readonly failureReason: string | null } | null;
}

/**
 * How long a `media.clip` may stay `running` before it is read as lost. A cut
 * is at most 181 s of output; even a 4K decode on this machine's CPU finishes
 * in minutes, retries included. Past this its worker died or its completion was
 * dropped, and production runs no scheduler that would ever notice
 * (`MONTAJ_SCHEDULER_DISABLED=1`): without this the clip would read "cutting",
 * refuse a retry and hold a plan-lane slot, all forever.
 */
export const CLIP_RUNNING_CEILING_MS = 60 * 60_000;

export function clipStateOf(
  clip: ClipFacts,
  latest: LatestClipJob | undefined,
  options: { readonly sourceGone?: boolean; readonly now?: number } = {},
): { readonly state: ClipState; readonly failureCode: string | null } {
  const now = options.now ?? Date.now();
  const live = latest !== undefined && isLiveJob(latest) && stalledCode(latest, now) === null;

  if (clip.mezzanineKey !== null && !childBroken(clip, latest, live)) {
    return { state: "ready", failureCode: null };
  }
  if (live) return { state: "cutting", failureCode: null };
  if (latest === undefined || cutRequestedSince(clip, latest)) {
    return options.sourceGone === true
      ? { state: "failed", failureCode: REPURPOSE_CLIP_ERRORS.sourceExpired }
      : { state: "waiting", failureCode: null };
  }
  const jobCode = stalledCode(latest, now) ?? errorCodeOf(latest.error);
  return {
    state: "failed",
    failureCode: clip.mezzanineKey === null ? jobCode : (clip.childMedia?.failureReason ?? jobCode),
  };
}

export function isLiveJob(job: Pick<LatestClipJob, "status">): boolean {
  return job.status === "queued" || job.status === "running";
}

/**
 * A job still open long past the point it could finish: queued past its plan's
 * `maxQueueWaitMs` (what the scheduled queue-timeout task would have failed it
 * for), or running past {@link CLIP_RUNNING_CEILING_MS}. Its code, or `null`.
 * `RepurposeClipsService` cancels such a job before it cuts the clip again,
 * since the enqueue would otherwise dedupe onto it.
 */
export function stalledCode(job: LatestClipJob, now: number = Date.now()): string | null {
  if (job.status === "queued") {
    const waitMs = job.maxQueueWaitMs ?? null;
    return job.queuedAt !== undefined && waitMs !== null && now - job.queuedAt.getTime() > waitMs
      ? JOB_ERROR_CODES.queueTimeout
      : null;
  }
  if (job.status === "running") {
    const since = job.startedAt ?? job.queuedAt;
    return since !== undefined && now - since.getTime() > CLIP_RUNNING_CEILING_MS
      ? REPURPOSE_CLIP_ERRORS.cutStalled
      : null;
  }
  return null;
}

/**
 * Whether a cut was asked for after `latest` ended — a retry or a re-cut the
 * plan's lane refused, so no newer job exists to show it. See
 * {@link ClipFacts.updatedAt}. Both timestamps come from the API's own clock
 * (`@updatedAt` and `JobsService` set them), so they compare.
 */
export function cutRequestedSince(clip: ClipFacts, latest: LatestClipJob): boolean {
  if (clip.updatedAt === undefined || isLiveJob(latest)) return false;
  const ended = latest.finishedAt ?? latest.queuedAt;
  return ended !== undefined && clip.updatedAt.getTime() > ended.getTime();
}

/**
 * A cut whose child project cannot be opened: its media failed the pipeline,
 * or it has none although the job that should have made it is over (the
 * completion handler never got that far). While that job is live the handler
 * may still be making it, and without a job at all there is nothing to say.
 */
function childBroken(clip: ClipFacts, latest: LatestClipJob | undefined, live: boolean): boolean {
  if (clip.childMedia === undefined) return false;
  if (clip.childMedia === null) return latest !== undefined && !live;
  return clip.childMedia.status === "failed";
}

/**
 * The Prisma `variants` selection {@link clipFactsOf} reads: the 9:16 variant's
 * profile and its project's newest primary media. Usable under `include` and
 * under `select`.
 */
export const CLIP_CHILD_VARIANTS = {
  where: { aspect: "r9x16" },
  select: {
    aspect: true,
    profileVersion: true,
    project: {
      select: {
        mediaAssets: {
          where: { role: "primary" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { role: true, status: true, failureReason: true, createdAt: true },
        },
      },
    },
  },
} as const satisfies Prisma.RepurposeClip$variantsArgs;

/** A clip row with its variants, as {@link CLIP_CHILD_VARIANTS} or a full include loads them. */
export interface ClipRowWithChild {
  readonly mezzanineKey: string | null;
  readonly updatedAt?: Date;
  readonly variants?: readonly {
    readonly aspect: string;
    readonly profileVersion: string;
    readonly project?: {
      readonly mediaAssets: readonly {
        readonly role: string;
        readonly status: string;
        readonly failureReason: string | null;
        readonly createdAt: Date;
      }[];
    };
  }[];
}

/**
 * {@link ClipFacts} and the 9:16 variant's profile, from a clip row. Filters
 * and orders again what the query already did, so a broader include (every
 * variant, every media) reads the same.
 */
export function clipFactsOf(
  clip: ClipRowWithChild,
): ClipFacts & { readonly profileVersion: string | null } {
  const base = {
    mezzanineKey: clip.mezzanineKey,
    ...(clip.updatedAt === undefined ? {} : { updatedAt: clip.updatedAt }),
  };
  if (clip.variants === undefined) return { ...base, profileVersion: null };
  const variant = clip.variants.find((row) => row.aspect === "r9x16");
  const media = (variant?.project?.mediaAssets ?? [])
    .filter((row) => row.role === "primary")
    .reduce<ClipRowWithChildMedia | undefined>(
      (newest, row) =>
        newest === undefined || row.createdAt.getTime() > newest.createdAt.getTime() ? row : newest,
      undefined,
    );
  return {
    ...base,
    profileVersion: variant?.profileVersion ?? null,
    childMedia:
      media === undefined ? null : { status: media.status, failureReason: media.failureReason },
  };
}

type ClipRowWithChildMedia = NonNullable<
  NonNullable<ClipRowWithChild["variants"]>[number]["project"]
>["mediaAssets"][number];

function errorCodeOf(error: Prisma.JsonValue | null): string | null {
  if (typeof error !== "object" || error === null || Array.isArray(error)) return null;
  const code = (error as Record<string, unknown>)["code"];
  return typeof code === "string" ? code : null;
}

/**
 * Whether a run's source can no longer be cut from: `media.clip` reads the raw
 * original, which retention deletes seven days after the last job (D47).
 */
export async function sourceRawPurged(
  prisma: PrismaService,
  sourceProjectId: string,
): Promise<boolean> {
  const media = await prisma.mediaAsset.findFirst({
    where: { projectId: sourceProjectId, role: "primary" },
    orderBy: { createdAt: "desc" },
    select: { rawPurgedAt: true },
  });
  return media !== null && media.rawPurgedAt !== null;
}

/**
 * The newest `media.clip` job per candidate, in one query. A clip's jobs are
 * found by key (`media.clip:{candidateId}:{bounds}:{profile}`, `mediaClipJobKey`)
 * because the key is what every cut of that moment, at any bounds or profile,
 * has in common.
 */
export async function latestClipJobs(
  prisma: PrismaService,
  workspaceId: string,
  candidateIds: readonly string[],
): Promise<Map<string, LatestClipJob>> {
  const latest = new Map<string, LatestClipJob>();
  if (candidateIds.length === 0) return latest;
  const jobs = await prisma.job.findMany({
    where: {
      workspaceId,
      type: "media.clip",
      OR: candidateIds.map((id) => ({ jobKey: { startsWith: `media.clip:${id}:` } })),
    },
    orderBy: [{ queuedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      jobKey: true,
      status: true,
      error: true,
      queuedAt: true,
      startedAt: true,
      finishedAt: true,
      maxQueueWaitMs: true,
    },
  });
  for (const job of jobs) {
    const candidateId = job.jobKey.split(":")[1];
    if (candidateId !== undefined && !latest.has(candidateId)) latest.set(candidateId, job);
  }
  return latest;
}

/**
 * Move a run on once none of its clips is still to come:
 *
 * - `materializing` → `review_ready` when any clip is ready, otherwise back to
 *   its moments (`candidates_ready`).
 * - `candidates_ready` → `review_ready` when a clip is ready. A clip can be cut
 *   while the run is still analysing (a moment of the person's own), and the
 *   highlights completion then moves the run to `candidates_ready` with that
 *   clip already made — nothing else would ever take it on to review.
 *
 * Any other status is left alone — a clip never decides that a run has failed.
 *
 * `finishingJobId` is the `media.clip` job whose failure is being handled
 * right now. Completion handlers run before the job's own status flips
 * (`JobsService.complete`), so its row still says `running`; it is counted as
 * failed, because it is. Two clips failing at the same instant can each see the
 * other as live and both leave the run as it is — the next reconcile (every
 * clip-list read) settles it.
 *
 * @returns the run as it now is, when this moved it.
 */
export async function settleRunAfterClips(
  prisma: PrismaService,
  runId: string,
  options: { readonly finishingJobId?: string } = {},
): Promise<RepurposeRun | undefined> {
  const run = await prisma.repurposeRun.findUnique({ where: { id: runId } });
  if (run === null || (run.status !== "materializing" && run.status !== "candidates_ready")) {
    return undefined;
  }

  const clips = await prisma.repurposeClip.findMany({
    where: { runId: run.id },
    select: {
      candidateId: true,
      mezzanineKey: true,
      updatedAt: true,
      variants: CLIP_CHILD_VARIANTS,
    },
  });
  const latest = await latestClipJobs(
    prisma,
    run.workspaceId,
    clips.map((clip) => clip.candidateId),
  );
  const finishedAt = new Date();
  const jobOf = (candidateId: string): LatestClipJob | undefined => {
    const job = latest.get(candidateId);
    return job !== undefined && job.id === options.finishingJobId
      ? { ...job, status: "failed", finishedAt: job.finishedAt ?? finishedAt }
      : job;
  };

  // Only asked when a clip is waiting, the one state it can change.
  const sourceGone =
    clips.some(
      (clip) => clipStateOf(clipFactsOf(clip), jobOf(clip.candidateId)).state === "waiting",
    ) && (await sourceRawPurged(prisma, run.sourceProjectId));

  let ready = 0;
  for (const clip of clips) {
    const { state } = clipStateOf(clipFactsOf(clip), jobOf(clip.candidateId), { sourceGone });
    if (state === "cutting" || state === "waiting") return undefined;
    if (state === "ready") ready += 1;
  }
  if (run.status === "candidates_ready" && ready === 0) return undefined;

  const next =
    ready > 0
      ? { status: "review_ready" as const, currentStage: "review", progress: 85 }
      : { status: "candidates_ready" as const, currentStage: "finding_clips", progress: 55 };
  // Conditional, so a concurrent move (a cancel, a completion) wins over this one.
  const { count } = await prisma.repurposeRun.updateMany({
    where: { id: run.id, status: run.status },
    data: next,
  });
  return count > 0 ? { ...run, ...next } : undefined;
}
