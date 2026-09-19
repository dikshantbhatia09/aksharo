import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import { PrismaService } from "../../common/prisma/prisma.service.js";
import {
  TRANSCRIPT_COMPLETED_EVENT,
  type TranscriptCompletedPayload,
} from "../../transcripts/transcript-completed.event.js";
import { RepurposeService } from "../repurpose.service.js";

/**
 * Listens for TRANSCRIPT_COMPLETED_EVENT.
 * If the transcript belongs to a project that is the source of an active RepurposeRun,
 * automatically dispatches ai.highlights discovery.
 */
@Injectable()
export class RepurposeTranscriptCompletedListener {
  private readonly logger = new Logger(RepurposeTranscriptCompletedListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repurpose: RepurposeService,
  ) {}

  @OnEvent(TRANSCRIPT_COMPLETED_EVENT)
  async onTranscriptCompleted(payload: TranscriptCompletedPayload): Promise<void> {
    try {
      const run = await this.prisma.repurposeRun.findFirst({
        where: {
          sourceProjectId: payload.projectId,
          status: { in: ["draft", "acquiring", "preparing_media", "transcribing", "analyzing"] },
        },
      });

      if (!run) {
        return;
      }

      this.logger.log(
        { runId: run.id, projectId: payload.projectId, transcriptId: payload.transcriptId },
        "Transcript completed for repurpose source project; triggering ai.highlights discovery",
      );

      await this.repurpose.startHighlightDiscovery(run, payload.transcriptId);
    } catch (error) {
      this.logger.error(
        { err: error, projectId: payload.projectId, transcriptId: payload.transcriptId },
        "Failed to trigger highlight discovery on transcript completion",
      );
    }
  }
}
