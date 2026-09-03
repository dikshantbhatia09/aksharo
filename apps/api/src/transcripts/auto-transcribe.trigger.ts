import { Injectable, Logger } from "@nestjs/common";

import { TranscriptsService } from "./transcripts.service.js";
import { PrismaService } from "../common/prisma/prisma.service.js";

/**
 * Start the first transcription as soon as the media is actually ready.
 *
 * The chain the product promises is upload → probe → proxy → transcript →
 * editing document, and until this existed the last two links were the browser's
 * job. `upload-job.ts` calls `POST /projects/{id}/transcribe` the moment the last
 * part lands — *before* `media.probe` has run — so the API correctly answers
 * `transcript/media_not_ready` (409), the client swallowed it and marked the
 * project "ready", and nothing retried. Probing takes seconds, so that race was
 * lost on essentially every real upload: the project opened with no transcript,
 * `EdgService` had no document to resolve, and the editor dead-ended on "This
 * project has no editing document yet."
 *
 * The fix belongs on the server because the client is the wrong owner for a
 * multi-step chain: a closed tab, a slept laptop or a dropped connection must not
 * decide whether a paid-for upload ever becomes editable.
 *
 * Safe to call on every `media.proxy` success:
 *
 * - It only acts on the project's **primary** media, once it is genuinely `ready`.
 * - A project that already has an editing document or a transcript is left alone,
 *   which is what keeps replace-media (B15 §5) and re-transcription on their own
 *   paths rather than through here.
 * - `TranscriptsService.transcribe` dedupes on `transcribe:{projectId}:{mediaId}`,
 *   so the browser's eager attempt and this one collapse to a single job and a
 *   single credit hold, whichever lands first.
 * - Nothing here can fail the proxy job. A workspace out of credits, or one that
 *   never chose a language, simply gets no automatic start; the failure is logged
 *   and the editor still offers to start transcription by hand.
 */
@Injectable()
export class AutoTranscribeTrigger {
  private readonly logger = new Logger(AutoTranscribeTrigger.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transcripts: TranscriptsService,
  ) {}

  /** @returns the enqueued job id, or `undefined` when this media is not a first transcription. */
  async maybeEnqueue(mediaId: string): Promise<{ jobId: string } | undefined> {
    const media = await this.prisma.mediaAsset.findUnique({
      where: { id: mediaId },
      select: { id: true, projectId: true, role: true, status: true, durationMs: true },
    });
    if (media === null || media.role !== "primary" || media.status !== "ready") return undefined;
    if (media.durationMs === null || media.durationMs <= 0) return undefined;

    const project = await this.prisma.project.findFirst({
      where: { id: media.projectId, deletedAt: null },
      select: {
        id: true,
        workspaceId: true,
        createdBy: true,
        sourceLanguage: true,
        edgDocument: { select: { id: true } },
      },
    });
    if (project === null || project.edgDocument !== null) return undefined;

    const transcripts = await this.prisma.transcript.count({ where: { projectId: project.id } });
    if (transcripts > 0) return undefined;

    // `createdBy` is nullable, and the credit hold has to be attributable to a
    // person; without one there is nobody to charge, so leave it to the editor.
    if (project.createdBy === null) return undefined;

    // No language means the project never went through a quick pick, so there is
    // no defensible guess to spend credits on: leave it to the editor to ask.
    if (project.sourceLanguage === null || project.sourceLanguage.trim() === "") {
      this.logger.log(
        { projectId: project.id, mediaId: media.id },
        "media is ready but the project has no source language; not auto-transcribing",
      );
      return undefined;
    }

    try {
      const accepted = await this.transcripts.transcribe({
        projectId: project.id,
        workspaceId: project.workspaceId,
        userId: project.createdBy,
        languages: [project.sourceLanguage],
      });
      this.logger.log(
        { projectId: project.id, mediaId: media.id, jobId: accepted.jobId },
        "auto-started the first transcription now that the media is ready",
      );
      return { jobId: accepted.jobId };
    } catch (error) {
      // Deliberately swallowed: the proxy genuinely succeeded, and failing its
      // completion would retry the whole proxy rather than the transcription.
      this.logger.warn(
        {
          projectId: project.id,
          mediaId: media.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "could not auto-start transcription; the project opens without one",
      );
      return undefined;
    }
  }
}
