import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { MediaAcquirePayloadSchema } from "@montaj/repurpose-contracts";

import { MEDIA_JOB_KEYS, MEDIA_JOB_QUOTES } from "./media.constants.js";
import { ProbeResultSchema } from "./probe-result.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";
import { JobsService } from "../jobs/jobs.service.js";
import { mediaLimitsFor } from "../projects/plan-limits.js";
import { ReplaceMediaAlignTrigger } from "../replace-media/replace-media-align.trigger.js";
import { PRE_CANDIDATE_STATUSES, WINDOW_TOLERANCE_MS } from "../repurpose/repurpose.constants.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { ProbeResult, ProxyJobPayload } from "./probe-result.js";
import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../jobs/completion-handlers.js";
import type { QueueName } from "../jobs/contracts/queue-names.js";
import type { MediaAsset } from "@prisma/client";

/**
 * What a successful `media.probe` *means* (A07).
 *
 * The worker measures; this decides. Three things happen here and nowhere else:
 *
 * 1. **The result is validated.** A worker's `result` is untrusted input like any
 *    other, and `durationMs` decides a plan check — so it is parsed, not read.
 * 2. **The plan's duration cap is applied.** `entitlements.maxDurationMs` is
 *    policy and policy lives in the API. A file over the cap is not a *failed
 *    probe*: the probe did exactly what it was asked. The job succeeds, the asset
 *    is marked `failed` with `media/too_long`, and no proxy is built for bytes
 *    nothing may use.
 * 3. **`media.proxy` is enqueued as a child.** A06 used to enqueue both at upload,
 *    which took two admission slots for one upload and 429'd a Free workspace on
 *    its second concurrent file. The proxy is the second half of one piece of
 *    work, so it rides on `enqueueChild` with `skipAdmission` — it inherits the
 *    parent's workspace, project and priority, and it never counts against the
 *    plan lane the still-open probe is itself occupying.
 *
 * **Idempotent**, because a completion callback is at-least-once and this runs
 * before the status flip: the media update is a plain overwrite of measured facts,
 * and `enqueueChild` dedupes on `media.proxy:{mediaId}`, so a replay produces the
 * same row and the same child job id.
 */
@Injectable()
export class MediaProbeCompletionHandler implements JobCompletionHandler, OnModuleInit {
  private readonly logger = new Logger(MediaProbeCompletionHandler.name);

  readonly jobType: QueueName = "media.probe";

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly entitlements: EntitlementService,
    private readonly registry: JobCompletionRegistry,
    private readonly realign: ReplaceMediaAlignTrigger,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome> {
    const parsed = ProbeResultSchema.safeParse(context.result);
    if (!parsed.success) {
      // A throw leaves the job `running` and answers the worker 5xx, which is the
      // right signal for a body that does not parse: nothing about it will be
      // fixed by marking the job done.
      throw new Error(
        `media.probe returned a result that is not a ProbeResult: ${summarise(parsed.error.issues)}`,
      );
    }
    const probe = parsed.data;

    const media = await this.prisma.mediaAsset.findUnique({ where: { id: probe.mediaId } });
    if (media === null) {
      // The asset was deleted while the probe ran. Nothing to write and nothing to
      // build; the job is still a success, because the worker did its half.
      this.logger.warn(
        { jobId: context.job.id, mediaId: probe.mediaId },
        "probe completed for a media asset that no longer exists",
      );
      return { data: { mediaId: probe.mediaId, applied: false, reason: "media_deleted" } };
    }

    const limits = mediaLimitsFor(await this.entitlements.forWorkspace(context.job.workspaceId));
    // A clips run's download is held to the window it asked for, not to the
    // plan's upload cap: a 20-minute window of a 3-hour video is exactly what
    // a Free run is allowed, and the cap would refuse it (2026-09-27).
    const windowMs = await this.windowOf(media);
    const maxDurationMs = windowMs === null ? limits.maxDurationMs : windowMs + WINDOW_TOLERANCE_MS;
    const tooLong = probe.durationMs > maxDurationMs;

    if (tooLong && windowMs !== null) {
      // Before the media reads failed, so the reconciler failing the run from
      // it finds the numbers already there ("34:37 against a 20:00 window").
      // An old worker that ignored the window is the realistic way to get here.
      // A run already failed only gets them if that failure is this one: a
      // reconcile that got there first wrote `source_too_long` from the media row.
      await this.prisma.repurposeRun.updateMany({
        where: {
          sourceProjectId: media.projectId,
          OR: [
            { status: { in: [...PRE_CANDIDATE_STATUSES] } },
            { status: "failed", failureCode: "repurpose/source_too_long" },
          ],
        },
        data: {
          failureDetail: { durationMs: probe.durationMs, maxDurationMs: windowMs, windowMs },
        },
      });
    }

    await this.prisma.mediaAsset.update({
      where: { id: media.id },
      data: {
        ...technicalFacts(probe),
        status: tooLong ? "failed" : "probing",
        failureReason: tooLong ? "media/too_long" : null,
      },
    });

    if (tooLong) {
      this.logger.log(
        {
          jobId: context.job.id,
          mediaId: media.id,
          durationMs: probe.durationMs,
          maxDurationMs,
          windowMs,
        },
        windowMs === null
          ? "media rejected on the plan's duration cap"
          : "fetched media is longer than the window it was fetched for",
      );
      return {
        data: {
          mediaId: media.id,
          durationMs: probe.durationMs,
          maxDurationMs,
          ...(windowMs === null ? {} : { windowMs }),
          plan: limits.planKey,
          failureReason: "media/too_long",
          proxyEnqueued: false,
        },
      };
    }

    const child = await this.jobs.enqueueChild(context.job, {
      type: "media.proxy",
      payload: proxyPayload(media, probe),
      worstCaseTenths: MEDIA_JOB_QUOTES.proxyTenths,
      jobKey: MEDIA_JOB_KEYS.proxy(media.id),
      reason: `media.proxy · ${media.id}`,
      // The workspace was admitted for this upload when `media.probe` was
      // enqueued; the proxy is the rest of that same job (see the class comment).
      skipAdmission: true,
    });

    // B15 §5: a replaced media item's new bytes just probed. `needs_realign`
    // (`MediaService.replace`) is what tells us to re-run `ai.align` against
    // the project's existing transcript rather than treat this as a first
    // transcription.
    const realignJob = await this.realign.maybeEnqueue(context.job, media.id);

    return {
      data: {
        mediaId: media.id,
        durationMs: probe.durationMs,
        proxyJobId: child.job.id,
        proxyEnqueued: !child.deduplicated,
        ...(realignJob === undefined ? {} : { realignJobId: realignJob.jobId }),
      },
    };
  }

  /**
   * The window this media was fetched for, when it is a clips run's download of
   * part of a longer video; null for everything else (an upload, a clip, a run
   * from before windows), which keeps the plan's upload cap.
   *
   * Read from the `media.acquire` job that fetched into THIS row - its payload
   * is what the worker was actually told - and, if that row has been pruned,
   * from the section the run recorded when the download landed.
   */
  private async windowOf(media: MediaAsset): Promise<number | null> {
    const run = await this.prisma.repurposeRun.findFirst({
      where: { sourceProjectId: media.projectId },
      select: { id: true, windowStartMs: true, windowEndMs: true },
    });
    if (run === null) return null;

    const acquire = await this.prisma.job.findFirst({
      where: {
        type: "media.acquire",
        projectId: media.projectId,
        params: { path: ["mediaId"], equals: media.id },
      },
      orderBy: { queuedAt: "desc" },
      select: { params: true },
    });
    if (acquire !== null) {
      const payload = MediaAcquirePayloadSchema.safeParse(acquire.params);
      if (payload.success) return payload.data.window?.maxMs ?? null;
    }
    if (run.windowStartMs !== null && run.windowEndMs !== null) {
      return Math.max(0, run.windowEndMs - run.windowStartMs);
    }
    return null;
  }
}

/** The measured facts that belong on `media_assets`, and only those. */
function technicalFacts(probe: ProbeResult): {
  durationMs: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  hasAudio: boolean;
  hdr: boolean;
  audioChannels: number | null;
  mime?: string;
} {
  return {
    durationMs: probe.durationMs,
    width: probe.video?.width ?? null,
    height: probe.video?.height ?? null,
    fps: probe.video?.fps ?? null,
    codec: probe.video?.codec ?? probe.audio?.codec ?? null,
    hasAudio: probe.hasAudio,
    hdr: probe.video?.hdr ?? false,
    audioChannels: probe.audio?.channels ?? null,
    // The container's own type beats the uploader's claim (THREAT-MODEL T7), but
    // only when the probe managed to name one.
    ...(probe.mime === null ? {} : { mime: probe.mime }),
  };
}

/** Everything `media.proxy` needs so it does not have to probe again. */
function proxyPayload(media: MediaAsset, probe: ProbeResult): ProxyJobPayload {
  const prefix = media.storageKey.slice(0, media.storageKey.lastIndexOf("/"));
  return {
    mediaId: media.id,
    projectId: media.projectId,
    bucket: media.bucket,
    key: media.storageKey,
    derivedBucket: "r2",
    derivedPrefix: prefix,
    durationMs: probe.durationMs,
    hasVideo: probe.hasVideo,
    hasAudio: probe.hasAudio,
    width: probe.video?.width ?? null,
    height: probe.video?.height ?? null,
    hdr: probe.video?.hdr ?? false,
  };
}

/** The first few Zod issues, as one line, with no user data in it. */
function summarise(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
