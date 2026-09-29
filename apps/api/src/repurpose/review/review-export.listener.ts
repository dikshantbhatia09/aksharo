import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import { ClipReviewService } from "./clip-review.service.js";
import {
  EXPORT_COMPLETED_EVENT,
  type ExportCompletedPayload,
} from "../../referrals/export-completed.event.js";

/**
 * A finished export may be a clip's new captioned video (2026-10-03): Autopilot
 * made it again after the captions were edited, or a person exported the clip
 * from the editor. When it replaces a video a review decision was pinned to,
 * the clip goes back to pending (`ClipReviewService.sync`) the moment the new
 * file exists, not when someone next opens the run.
 *
 * The fast path only: every read of a run's review and every client page load
 * run the same check, so a missed event (a restart mid-emit) costs nothing but
 * a few seconds. Never throws back into the emitter.
 */
@Injectable()
export class ReviewExportListener {
  private readonly logger = new Logger(ReviewExportListener.name);

  constructor(private readonly reviews: ClipReviewService) {}

  @OnEvent(EXPORT_COMPLETED_EVENT)
  async onExportCompleted(payload: ExportCompletedPayload): Promise<void> {
    try {
      await this.reviews.syncForExport(payload.workspaceId, payload.exportId);
    } catch (error) {
      this.logger.warn(
        { err: error, workspaceId: payload.workspaceId, exportId: payload.exportId },
        "could not check a finished export against its clip's review",
      );
    }
  }
}
