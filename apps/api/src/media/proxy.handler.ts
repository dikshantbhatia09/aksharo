import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { MEDIA_FAILURE_REASONS } from "./media.constants.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { AutoTranscribeTrigger } from "../transcripts/auto-transcribe.trigger.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";

import type { MediaFailureReason } from "./media.constants.js";
import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../jobs/completion-handlers.js";
import type { QueueName } from "../jobs/contracts/queue-names.js";

/**
 * What a `media.proxy` completion means, independently of the worker's own
 * write-back (A08's `PATCH /internal/media/{id}`).
 *
 * `apps/worker-media`'s `processProxy` already PATCHes `media_assets` — status,
 * derived keys, everything — before it ever calls this completion callback (see
 * `runtime.ts`: "the measured facts go in BEFORE the completion"). In the
 * ordinary case this handler therefore finds the asset already at the outcome
 * it is about to write and does nothing. It exists for the case that ordering
 * does not cover: the callback lands but the write-back did not (a crash
 * between the two calls, a test harness that drives `POST
 * /internal/jobs/{id}/complete` directly without a running worker — see
 * `apps/web/e2e/gate-a.spec.ts` — or a future producer of `media.proxy` that
 * forgets the patch entirely). Without an independent write here, a job the API
 * itself considers `succeeded` can leave `media_assets.status` stuck at
 * `probing` forever, and nothing downstream (`POST /transcribe`, the Gate A
 * card's own status badge) ever reads it as done.
 *
 * **Idempotent**, the same way `MediaProbeCompletionHandler` is: a completion
 * callback is at-least-once and this runs before the job's own status flip, so
 * a replay must find the same asset in the same state and change nothing the
 * second time.
 *
 * **Two writers, one asset, never two authoritative answers.** The worker's
 * `PATCH` and this handler can each declare an outcome for the same asset; when
 * they agree the second writer is a no-op, and when they do not, `failed` wins:
 * a success completion never undoes a `failed` some other writer already
 * recorded, and a failure completion overwrites a stray `ready`. Silently
 * calling a broken upload "ready" is the wrong direction to fail safe in.
 */
@Injectable()
export class MediaProxyCompletionHandler implements JobCompletionHandler, OnModuleInit {
  private readonly logger = new Logger(MediaProxyCompletionHandler.name);

  readonly jobType: QueueName = "media.proxy";

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobCompletionRegistry,
    private readonly autoTranscribe: AutoTranscribeTrigger,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome | undefined> {
    const mediaId = mediaIdOf(context);
    if (mediaId === undefined) return undefined;
    const applied = await this.resolve(context.job.id, mediaId, "ready", null);
    // The media is only now genuinely usable, which is the first moment
    // `POST /projects/{id}/transcribe` can succeed. Starting it here rather than
    // in the browser is what stops an upload from stalling forever with no
    // transcript and no editing document (see `AutoTranscribeTrigger`). Only on
    // the transition, so an at-least-once replay does not re-enqueue.
    const transcribe = applied ? await this.autoTranscribe.maybeEnqueue(mediaId) : undefined;
    return {
      data: {
        mediaId,
        applied,
        ...(transcribe === undefined ? {} : { transcribeJobId: transcribe.jobId }),
      },
    };
  }

  async handleFailure(context: JobCompletionContext): Promise<void> {
    const mediaId = mediaIdOf(context);
    if (mediaId === undefined) return;
    const reason = failureReasonOf(context.completion.error?.code);
    await this.resolve(context.job.id, mediaId, "failed", reason);
  }

  /** @returns whether this call actually changed the row. */
  private async resolve(
    jobId: string,
    mediaId: string,
    terminal: "ready" | "failed",
    failureReason: MediaFailureReason | null,
  ): Promise<boolean> {
    const media = await this.prisma.mediaAsset.findUnique({
      where: { id: mediaId },
      select: { status: true },
    });
    if (media === null) {
      // The asset was deleted while the proxy ran. Nothing to write.
      this.logger.warn(
        { jobId, mediaId },
        "media.proxy completed for a media asset that no longer exists",
      );
      return false;
    }

    if (media.status === terminal) {
      // The same outcome already landed — the worker's own write-back, almost
      // always. A no-op, not a re-write, so a replay never clobbers keys this
      // handler does not itself write (proxyKey, thumbKeys, ...).
      return false;
    }

    if (media.status === "failed" && terminal === "ready") {
      this.logger.warn(
        { jobId, mediaId },
        "media.proxy succeeded but the asset is already marked failed by another writer; keeping it failed",
      );
      return false;
    }

    if (media.status === "ready" && terminal === "failed") {
      this.logger.warn(
        { jobId, mediaId },
        "media.proxy failed but the asset was already marked ready by another writer; marking it failed",
      );
    }

    const { count } = await this.prisma.mediaAsset.updateMany({
      where: { id: mediaId, status: media.status },
      data: {
        status: terminal,
        failureReason: terminal === "failed" ? (failureReason ?? "media/probe_failed") : null,
      },
    });
    return count > 0;
  }
}

/**
 * The completion carries no `result` a test harness can be relied on to send
 * (`gate-a.spec.ts` completes with `result: {}`) and none at all on failure, so
 * this reads the id the API itself put on the job at enqueue time
 * (`probe.handler.ts`'s `proxyPayload`) rather than trusting the worker's echo.
 */
function mediaIdOf(context: JobCompletionContext): string | undefined {
  const params = context.job.params as Record<string, unknown> | null;
  const fromParams = params?.["mediaId"];
  if (typeof fromParams === "string" && fromParams.length > 0) return fromParams;
  const fromResult = context.result["mediaId"];
  return typeof fromResult === "string" && fromResult.length > 0 ? fromResult : undefined;
}

/** A worker-reported error code, if it happens to be one of the closed set; `null` otherwise. */
function failureReasonOf(code: string | undefined): MediaFailureReason | null {
  if (code !== undefined && (MEDIA_FAILURE_REASONS as readonly string[]).includes(code)) {
    return code as MediaFailureReason;
  }
  return null;
}
