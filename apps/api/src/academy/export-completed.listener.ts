import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import { AcademyService } from "./academy.service.js";
import {
  EXPORT_COMPLETED_EVENT,
  type ExportCompletedPayload,
} from "../referrals/export-completed.event.js";

/**
 * Listens for `export.completed` (already emitted by `exports/`, wired for
 * `referrals/` — see `referrals/export-completed.event.ts`'s doc comment for
 * why the event exists and where it's raised) and offers each one to
 * `AcademyService`, which marks every catalogue step whose
 * `completionEvent` is `"export.completed"` done for the workspace's owner.
 *
 * Same event, two independent listeners — nothing here changes `referrals/`
 * or requires a second emit site, exactly the "never by forking" rule the
 * event's own doc comment states.
 */
@Injectable()
export class AcademyExportCompletedListener {
  private readonly logger = new Logger(AcademyExportCompletedListener.name);

  constructor(private readonly academy: AcademyService) {}

  @OnEvent(EXPORT_COMPLETED_EVENT)
  async onExportCompleted(payload: ExportCompletedPayload): Promise<void> {
    try {
      await this.academy.completeExportStepsForWorkspace(payload.workspaceId);
    } catch (error) {
      this.logger.error(
        { err: error, workspaceId: payload.workspaceId, exportId: payload.exportId },
        "academy step completion failed for a completed export",
      );
    }
  }
}
