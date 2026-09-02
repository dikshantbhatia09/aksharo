/**
 * Enqueues `ai.align` for a replaced media item once its new bytes have
 * probed (B15 brief §5) — the producer half `AlignCompletionHandler` is the
 * consumer half of.
 *
 * `MediaProbeCompletionHandler` (A07) calls this after it has written the new
 * technical facts, exactly the way it enqueues `media.proxy`: `media_assets.
 * needs_realign` is the signal (set by `MediaService.replace`, cleared here
 * once the re-align job is actually in flight so a second probe of the same
 * bytes — a worker retry — does not enqueue a second alignment).
 */

import { Injectable, Logger } from "@nestjs/common";

import { buildAlignPayload } from "./align-payload.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { EdgRepository } from "../edg/edg.repository.js";
import { JobsService } from "../jobs/jobs.service.js";
import { MEDIA_JOB_KEYS, MEDIA_JOB_QUOTES } from "../media/media.constants.js";

import type { ReplaceMediaAlignParams } from "./align-completion.handler.js";
import type { Job } from "@prisma/client";

@Injectable()
export class ReplaceMediaAlignTrigger {
  private readonly logger = new Logger(ReplaceMediaAlignTrigger.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly edgRepository: EdgRepository,
    private readonly jobs: JobsService,
  ) {}

  /**
   * Called from `media.probe`'s own completion handler once the new bytes are
   * confirmed probed. A no-op — not an error — for a media item that never
   * asked for a re-align, or whose project has no EDG document to retime yet
   * (the ordinary "first transcription" path owns that case, not this one).
   */
  async maybeEnqueue(parentJob: Job, mediaId: string): Promise<{ jobId: string } | undefined> {
    const media = await this.prisma.mediaAsset.findUnique({ where: { id: mediaId } });
    if (media === null || !media.needsRealign) return undefined;

    const document = await this.prisma.edgDocument.findUnique({
      where: { projectId: media.projectId },
      select: { id: true },
    });
    if (document === null) return undefined;

    const edg = await this.edgRepository.projectionOf(document.id);
    const chunks = await this.edgRepository.loadChunks(edg.transcript.transcriptId);
    const words = chunks.flatMap((chunk) => chunk.words);
    const { segments, segmentWordIds } = buildAlignPayload(edg.segments, words);

    if (segments.length === 0) {
      this.logger.warn(
        { projectId: media.projectId, mediaId },
        "replace-media has nothing to re-align (no live segments)",
      );
      return undefined;
    }

    const params: ReplaceMediaAlignParams = {
      mode: "replace_media",
      projectId: media.projectId,
      segmentWordIds,
    };

    const { job, deduplicated } = await this.jobs.enqueueChild(parentJob, {
      type: "ai.align",
      payload: {
        mediaId,
        language: edg.transcript.language,
        segments,
        ...params,
      },
      worstCaseTenths: MEDIA_JOB_QUOTES.alignTenths,
      jobKey: MEDIA_JOB_KEYS.align(mediaId),
      reason: `ai.align · replace-media · ${mediaId}`,
      skipAdmission: true,
    });

    if (!deduplicated) {
      await this.prisma.mediaAsset.update({
        where: { id: mediaId },
        data: { needsRealign: false },
      });
    }

    return { jobId: job.id };
  }
}
