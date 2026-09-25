import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { PrismaService } from "../common/prisma/prisma.service.js";
import { derivedKey } from "../common/storage/storage.keys.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";
import { JobsService } from "../jobs/jobs.service.js";

import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../jobs/completion-handlers.js";
import type { QueueName } from "../jobs/contracts/queue-names.js";

/** `ai.faces` for one media asset: one live job at a time, whoever asks. */
export function facesJobKey(mediaId: string): string {
  return `ai.faces:${mediaId}`;
}

/**
 * Queues `ai.faces` for a video whose proxy is ready and which has no face
 * track yet — the input the caption renderer uses to keep captions off faces
 * (`packages/render-core/src/frame/placement.ts`).
 *
 * Free (`worstCaseTenths: 0`) and outside the plan's concurrency cap
 * (`skipAdmission`): it is part of preparing media the workspace was already
 * admitted for, like `media.probe` asking for `media.proxy`, and it must never
 * take the Free plan's second lane from the transcription behind it.
 *
 * Never throws: a missing face track only means captions keep their style's own
 * position, which is how every caption was placed before this existed.
 */
@Injectable()
export class FacesTrigger {
  private readonly logger = new Logger(FacesTrigger.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  /**
   * @param options.onlyIfNeverTried skip a media that has had an `ai.faces` job
   *   before, whatever became of it — for the lazy path (`GET .../urls`), which
   *   runs every few minutes an editor is open and must not retry a video whose
   *   detection failed.
   * @returns the job id, or `undefined` when this media needs no face track.
   */
  async maybeEnqueue(
    mediaId: string,
    options: { readonly onlyIfNeverTried?: boolean } = {},
  ): Promise<{ jobId: string } | undefined> {
    try {
      if (options.onlyIfNeverTried === true) {
        const tried = await this.prisma.job.count({
          where: { type: "ai.faces", jobKey: facesJobKey(mediaId) },
        });
        if (tried > 0) return undefined;
      }
      const media = await this.prisma.mediaAsset.findUnique({
        where: { id: mediaId },
        select: {
          id: true,
          projectId: true,
          status: true,
          width: true,
          proxyKey: true,
          facesKey: true,
          derivedPurgedAt: true,
          project: { select: { workspaceId: true, deletedAt: true } },
        },
      });
      if (
        media === null ||
        media.status !== "ready" ||
        media.width === null ||
        media.proxyKey === null ||
        media.facesKey !== null ||
        media.derivedPurgedAt !== null ||
        media.project.deletedAt !== null
      ) {
        return undefined;
      }
      const { job } = await this.jobs.enqueue({
        type: "ai.faces",
        workspaceId: media.project.workspaceId,
        projectId: media.projectId,
        params: { mediaId: media.id, projectId: media.projectId },
        jobKey: facesJobKey(media.id),
        worstCaseTenths: 0,
        reason: "ai.faces · caption placement",
        skipAdmission: true,
      });
      return { jobId: job.id };
    } catch (error) {
      this.logger.warn(
        { mediaId, error: error instanceof Error ? error.message : String(error) },
        "could not queue face detection; captions keep their style's position",
      );
      return undefined;
    }
  }
}

/**
 * Records the `faces.json` an `ai.faces` job wrote. The key must be exactly
 * that media's own `faces.json` — a worker cannot point a media row at any
 * other object (THREAT-MODEL T4, as `assertOwnKeys` does for the proxy).
 */
@Injectable()
export class MediaFacesCompletionHandler implements JobCompletionHandler, OnModuleInit {
  private readonly logger = new Logger(MediaFacesCompletionHandler.name);

  readonly jobType: QueueName = "ai.faces";

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobCompletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome> {
    const params = context.job.params as Record<string, unknown> | null;
    const mediaId = params?.["mediaId"];
    if (typeof mediaId !== "string") {
      return { actualTenths: 0, data: { applied: false, reason: "no_media_id" } };
    }
    const media = await this.prisma.mediaAsset.findUnique({
      where: { id: mediaId },
      select: { id: true, projectId: true, project: { select: { workspaceId: true } } },
    });
    if (media === null) {
      this.logger.warn({ mediaId }, "ai.faces completed for a media asset that no longer exists");
      return { actualTenths: 0, data: { applied: false, reason: "media_not_found" } };
    }

    const expected = derivedKey(media.project.workspaceId, media.projectId, media.id, "faces.json");
    if (context.result["facesKey"] !== expected) {
      throw new Error(`ai.faces reported a faces key outside this media's own prefix`);
    }
    await this.prisma.mediaAsset.update({
      where: { id: media.id },
      data: { facesKey: expected },
    });
    return { actualTenths: 0, data: { applied: true, mediaId: media.id } };
  }
}
