import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { MediaStillsPayloadSchema, MediaStillsResultSchema } from "@montaj/repurpose-contracts";

import { PrismaService } from "../common/prisma/prisma.service.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";

import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../jobs/completion-handlers.js";
import type { QueueName } from "../jobs/contracts/queue-names.js";
import type { Prisma } from "@prisma/client";

/**
 * Files a clip's images (`media.stills`, 2026-09-29) on the clip:
 * `repurpose_clips.images` becomes `{ fingerprint, images }`.
 *
 * The worker's answer is held to what it was asked, as the clip cut's is: the
 * same clip, the same set, and only keys it was given — so a worker bug cannot
 * attach another clip's (or another workspace's) objects to this one.
 *
 * A failure needs nothing here: the job row reads failed, and Autopilot asks
 * again, up to `IMAGE_ATTEMPTS` times per set.
 */
@Injectable()
export class RepurposeStillsCompletionHandler implements JobCompletionHandler, OnModuleInit {
  private readonly logger = new Logger(RepurposeStillsCompletionHandler.name);

  readonly jobType: QueueName = "media.stills";

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobCompletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome> {
    const result = MediaStillsResultSchema.safeParse(context.result);
    if (!result.success) {
      throw new Error(
        `media.stills returned an invalid result: ${result.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      );
    }
    const asked = MediaStillsPayloadSchema.safeParse(context.job.params);
    const askedKeys = new Set(
      asked.success ? asked.data.images.map((row) => row.destinationKey) : [],
    );
    if (
      !asked.success ||
      result.data.clipId !== asked.data.clipId ||
      result.data.fingerprint !== asked.data.fingerprint ||
      !result.data.images.every((row) => askedKeys.has(row.key))
    ) {
      this.logger.error(
        { jobId: context.job.id, clipId: result.data.clipId },
        "media.stills reported images it was not asked for; nothing applied",
      );
      return { actualTenths: 0, data: { applied: false, reason: "result_mismatch" } };
    }

    const images = {
      fingerprint: result.data.fingerprint,
      images: result.data.images.map((row) => ({
        name: row.name,
        key: row.key,
        width: row.width,
        height: row.height,
      })),
    } satisfies Prisma.InputJsonValue;
    const updated = await this.prisma.repurposeClip.updateMany({
      where: { id: result.data.clipId },
      data: { images },
    });
    if (updated.count === 0) {
      return { actualTenths: 0, data: { applied: false, reason: "clip_not_found" } };
    }
    this.logger.log(
      { clipId: result.data.clipId, count: images.images.length },
      "clip images filed",
    );
    return { actualTenths: 0, data: { applied: true, images: images.images.length } };
  }
}
