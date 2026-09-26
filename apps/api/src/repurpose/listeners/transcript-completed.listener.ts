import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import { PrismaService } from "../../common/prisma/prisma.service.js";
import {
  TRANSCRIPT_COMPLETED_EVENT,
  type TranscriptCompletedPayload,
} from "../../transcripts/transcript-completed.event.js";
import { PRE_CANDIDATE_STATUSES } from "../repurpose.constants.js";
import { RepurposeService } from "../repurpose.service.js";

/**
 * Listens for TRANSCRIPT_COMPLETED_EVENT.
 * If the transcript belongs to a project that is the source of an active RepurposeRun,
 * automatically dispatches ai.highlights discovery.
 *
 * This is the FAST path only (2026-09-26). The event is in-memory and emitted
 * from inside the transcription's completion, so a restart, a thrown handler or
 * a refused enqueue loses it — and it used to be the only thing that ever
 * started discovery, which is how a run sat on "Finding promising moments" for
 * ten days. `startHighlightDiscovery` now records every outcome itself, and the
 * reconciler (every read of the run) starts discovery for any run with a
 * transcript and no discovery job, whether or not this ever ran.
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
          status: { in: [...PRE_CANDIDATE_STATUSES] },
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
      // Whatever that did — queued, refused for now, a manual run that went
      // straight to picking moments — the reconciler now reads the result from
      // durable state, and starts discovery again if nothing is queued, rather
      // than leaving that to whenever the run is next read.
      await this.repurpose.reconcileRun(run.id);
    } catch (error) {
      // An emitter swallows a listener's rejection; the reconciler is what
      // recovers the run, so logging is all that is left to do here.
      this.logger.error(
        { err: error, projectId: payload.projectId, transcriptId: payload.transcriptId },
        "Failed to trigger highlight discovery on transcript completion",
      );
    }
  }
}
