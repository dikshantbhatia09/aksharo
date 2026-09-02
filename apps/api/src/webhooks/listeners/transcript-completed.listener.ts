import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import {
  TRANSCRIPT_COMPLETED_EVENT,
  type TranscriptCompletedPayload,
} from "../../transcripts/transcript-completed.event.js";
import { WebhookDeliveryService } from "../webhook-delivery.service.js";

/**
 * `transcript.completed` (B14b) — replaces the polled `jobs` cursor
 * `WebhookEventPollerService` used with a real `EventEmitter2` subscription to
 * the event `transcripts/transcribe.handler.ts` emits once a transcription is
 * persisted and the editing document initialised.
 */
@Injectable()
export class WebhookTranscriptCompletedListener {
  private readonly logger = new Logger(WebhookTranscriptCompletedListener.name);

  constructor(private readonly delivery: WebhookDeliveryService) {}

  @OnEvent(TRANSCRIPT_COMPLETED_EVENT)
  async onTranscriptCompleted(payload: TranscriptCompletedPayload): Promise<void> {
    try {
      await this.delivery.emit({
        workspaceId: payload.workspaceId,
        event: "transcript.completed",
        data: {
          projectId: payload.projectId,
          transcriptId: payload.transcriptId,
          jobId: payload.jobId,
        },
      });
    } catch (error) {
      this.logger.error(
        { err: error, workspaceId: payload.workspaceId, transcriptId: payload.transcriptId },
        "could not fan out transcript.completed to webhooks",
      );
    }
  }
}
