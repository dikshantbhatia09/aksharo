import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { MediaAcquirePayloadSchema, MediaAcquireResultSchema } from "@montaj/repurpose-contracts";

import { RepurposeService } from "./repurpose.service.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";
import { MediaService } from "../media/media.service.js";

import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../jobs/completion-handlers.js";
import type { QueueName } from "../jobs/contracts/queue-names.js";

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
 * rail: the run is marked `failed` with `repurpose/source_unavailable`, a code
 * the web already has a sentence for. Without that the rail would sit on "getting
 * your video" until the tab was closed.
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

    return {
      data: {
        mediaId: asset.id,
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

    await this.prisma.mediaAsset
      .updateMany({
        where: { id: payload.data.mediaId, status: { in: ["pending", "uploading"] } },
        data: { status: "failed", failureReason: "media/unsupported" },
      })
      .catch((error: unknown) => {
        this.logger.warn({ jobId: context.job.id, err: error }, "could not mark the media failed");
      });

    const run = await this.prisma.repurposeRun.findUnique({ where: { id: payload.data.runId } });
    if (run === null || ["failed", "cancelled", "published"].includes(run.status)) return;

    const failed = await this.prisma.repurposeRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        failureCode: "repurpose/source_unavailable",
        completedAt: new Date(),
      },
    });
    await this.runs.publishStage(failed);
  }
}
