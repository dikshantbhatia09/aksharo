import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { MEDIA_JOB_KEYS, MEDIA_JOB_QUOTES } from "./media.constants.js";
import { ProbeResultSchema } from "./probe-result.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";
import { JobsService } from "../jobs/jobs.service.js";
import { mediaLimitsFor } from "../projects/plan-limits.js";
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
    const tooLong = probe.durationMs > limits.maxDurationMs;

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
          maxDurationMs: limits.maxDurationMs,
        },
        "media rejected on the plan's duration cap",
      );
      return {
        data: {
          mediaId: media.id,
          durationMs: probe.durationMs,
          maxDurationMs: limits.maxDurationMs,
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

    return {
      data: {
        mediaId: media.id,
        durationMs: probe.durationMs,
        proxyJobId: child.job.id,
        proxyEnqueued: !child.deduplicated,
      },
    };
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
