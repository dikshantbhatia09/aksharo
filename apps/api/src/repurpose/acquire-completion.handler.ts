import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { MediaAcquirePayloadSchema, MediaAcquireResultSchema } from "@montaj/repurpose-contracts";

import { STAGE_OF_FAILURE, runFailureCode } from "./failure-codes.js";
import { PRE_CANDIDATE_STATUSES } from "./repurpose.constants.js";
import { RepurposeService } from "./repurpose.service.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";
import { MEDIA_FAILURE_REASONS } from "../media/media.constants.js";
import { MediaService } from "../media/media.service.js";

import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../jobs/completion-handlers.js";
import type { QueueName } from "../jobs/contracts/queue-names.js";
import type { MediaFailureReason } from "../media/media.constants.js";

/**
 * The media reason to record when the worker's own write never landed: the job's
 * code when it is one of the closed set (the worker names a refusal by its
 * reason), otherwise "the download failed".
 */
function mediaReasonOf(jobErrorCode: string | null): MediaFailureReason {
  return (MEDIA_FAILURE_REASONS as readonly string[]).includes(jobErrorCode ?? "")
    ? (jobErrorCode as MediaFailureReason)
    : "media/source_failed";
}

/**
 * What a settled `media.acquire` *means* (REP-010).
 *
 * The worker fetched the source, checked it against the limits it was given and
 * wrote it to the key this API chose. What happens next is policy, and policy
 * does not live in a worker any pod can run — so the same split `media.probe`
 * uses applies here: the worker measures, this decides.
 *
 * On success there is exactly one decision, and it is deliberately small:
 * **an acquired video becomes an ordinary upload.** `completeAcquisition` runs
 * the same tail `complete` does — the store's own size, the plan's purge dates,
 * the project's retention, `media.probe` as a child job — so everything
 * downstream (probe, proxy, auto-transcribe, the editor) sees a file that got
 * here the usual way. Nothing below this line knows the difference, which is the
 * point: a second ingest path is a second set of bugs.
 *
 * On terminal failure there is one more, because a person is watching a progress
 * rail: the run is marked `failed` with the code for what actually went wrong —
 * too long for the plan, private, blocked for now (`failure-codes.ts`). It used
 * to be `repurpose/source_unavailable` whatever happened, so a video that was
 * only too big read "We could not get that video — choose another".
 *
 * A run the person STOPPED gets nothing: a download that lands after the Stop
 * is not handed on, because probe → proxy → transcription would then spend
 * credits on a run they cancelled. One that is stopped while this is handing
 * it on has the probe it just queued stopped too (`stopIfCancelled`).
 *
 * The media row written is always the one the job's own params name (the API
 * wrote them); a result naming a different one is refused like a result that
 * does not parse.
 *
 * **Idempotent** in both directions, as the at-least-once callback contract
 * requires: the success path's writes are overwrites of measured facts and its
 * child enqueue dedupes on `media.probe:{mediaId}`; the failure path's writes are
 * conditional on the run not already being terminal.
 */
@Injectable()
export class RepurposeAcquireCompletionHandler implements JobCompletionHandler, OnModuleInit {
  private readonly logger = new Logger(RepurposeAcquireCompletionHandler.name);

  readonly jobType: QueueName = "media.acquire";

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly runs: RepurposeService,
    private readonly registry: JobCompletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome> {
    const parsed = MediaAcquireResultSchema.safeParse(context.result);
    if (!parsed.success) {
      // A throw leaves the job `running` and answers the worker 5xx, which is the
      // right signal for a body that does not parse: nothing about it will be
      // fixed by marking the job done.
      throw new Error(
        `media.acquire returned a result that is not a MediaAcquireResult: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      );
    }
    const result = parsed.data;

    // The row written is the one the API queued this job for, never one the
    // worker names: a worker that mixed up two concurrent downloads would
    // otherwise complete another run's media — possibly another workspace's —
    // with these bytes. Same answer as a body that does not parse.
    const payload = MediaAcquirePayloadSchema.safeParse(context.job.params);
    if (payload.success && payload.data.mediaId !== result.mediaId) {
      throw new Error(
        `media.acquire returned a result for media ${result.mediaId}, but job ${context.job.id} fetches into ${payload.data.mediaId}`,
      );
    }

    const media = await this.prisma.mediaAsset.findUnique({
      where: { id: result.mediaId },
      include: { project: true },
    });
    if (media === null || media.project === null) {
      // The run was deleted while the download ran. The worker did its half, so
      // the job succeeded; there is simply nothing left to attach the bytes to.
      this.logger.warn(
        { jobId: context.job.id, mediaId: result.mediaId },
        "media.acquire completed for a media asset that no longer exists",
      );
      return { data: { mediaId: result.mediaId, applied: false, reason: "media_deleted" } };
    }

    const run = payload.success
      ? await this.prisma.repurposeRun.findUnique({ where: { id: payload.data.runId } })
      : null;
    if (run?.status === "cancelled") {
      // Nothing downstream may start. The bytes are marked for the next raw
      // purge rather than left as a live upload nobody asked to keep.
      await this.prisma.mediaAsset.updateMany({
        where: { id: media.id, status: { in: ["pending", "uploading"] } },
        data: { status: "failed", rawPurgeAt: new Date() },
      });
      this.logger.log(
        { jobId: context.job.id, runId: run.id, mediaId: media.id },
        "media.acquire completed for a cancelled run; not handed on",
      );
      return { data: { mediaId: media.id, applied: false, reason: "run_cancelled" } };
    }

    const { project, ...asset } = media;
    const completed = await this.media.completeAcquisition({
      media: asset,
      project,
      parent: context.job,
      sizeBytes: result.sizeBytes,
      mime: result.mime,
      contentHash: result.checksum,
    });

    this.logger.log(
      {
        jobId: context.job.id,
        mediaId: asset.id,
        provider: result.sourceMetadata.provider,
        durationMs: result.sourceMetadata.durationMs,
        probeJobId: completed.probeJobId,
      },
      "acquired source joined the ordinary media pipeline",
    );
    // Stop may have been pressed between the look above and the probe being
    // queued, and `cancel` only stops the jobs it can see: look again now the
    // probe exists, and stop it if so — past the probe is a paid transcription.
    const stopped = run !== null && (await this.runs.stopIfCancelled(run.id));
    if (run !== null && !stopped) await this.runs.reconcileRun(run.id);

    return {
      data: {
        mediaId: asset.id,
        ...(stopped ? { runCancelled: true } : {}),
        // Safe fields only: a title and a channel are shown to the person who
        // asked for them, but the URL never returns to a log line (§17.4).
        provider: result.sourceMetadata.provider,
        sourceId: result.sourceMetadata.sourceId,
        durationMs: result.sourceMetadata.durationMs,
        sizeBytes: result.sizeBytes,
        toolVersion: result.toolVersion,
        probeJobId: completed.probeJobId,
      },
    };
  }

  /**
   * A download that will not be retried again.
   *
   * The run is the thing a person is looking at, so it is the thing that has to
   * say so. `failureCode` is a code from `SAFE_ERROR_CODES` and never the
   * downloader's own words — "Sign in to confirm you're not a bot" is a sentence
   * about our infrastructure, not about their video.
   */
  async handleFailure(context: JobCompletionContext): Promise<void> {
    const payload = MediaAcquirePayloadSchema.safeParse(context.job.params);
    if (!payload.success) {
      this.logger.warn(
        { jobId: context.job.id },
        "media.acquire failed with params that no longer parse; nothing to mark",
      );
      return;
    }
    const { mediaId, runId } = payload.data;
    const jobErrorCode = context.completion.error?.code ?? null;
    const run = await this.prisma.repurposeRun.findUnique({ where: { id: runId } });

    // The worker marks the media failed with its reason before it reports the
    // job; this is for when that write never landed, or the API ended the job
    // itself (a queue timeout, a cancel). A cancelled run's bytes, if any made
    // it, go at the next purge.
    await this.prisma.mediaAsset
      .updateMany({
        where: { id: mediaId, status: { in: ["pending", "uploading"] } },
        data:
          run?.status === "cancelled"
            ? { status: "failed", rawPurgeAt: new Date() }
            : { status: "failed", failureReason: mediaReasonOf(jobErrorCode) },
      })
      .catch((error: unknown) => {
        this.logger.warn({ jobId: context.job.id, err: error }, "could not mark the media failed");
      });

    if (run === null || !(PRE_CANDIDATE_STATUSES as readonly string[]).includes(run.status)) return;

    const [media, newest] = await Promise.all([
      this.prisma.mediaAsset.findUnique({
        where: { id: mediaId },
        select: { failureReason: true },
      }),
      this.prisma.mediaAsset.findFirst({
        where: { projectId: run.sourceProjectId, role: "primary" },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      }),
    ]);
    // A retry fetches into a new media row. A late failure of the fetch it
    // replaced is about a file the run no longer stands on.
    if (newest !== null && newest.id !== mediaId) return;

    await this.runs.failRun(
      run,
      runFailureCode({
        failedAt: "acquire",
        mediaReason: media?.failureReason ?? null,
        jobErrorCode,
      }),
      STAGE_OF_FAILURE.acquire,
    );
  }
}
