import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import { EXPORT_COMPLETED_EVENT, type ExportCompletedPayload } from "./export-completed.event.js";
import { ReferralsService } from "./referrals.service.js";

/**
 * Listens for `export.completed` (emitted by `exports/` — see the doc
 * comment on `export-completed.event.ts`) and offers each one to
 * `ReferralsService.grantForExport`, which itself is a no-op unless the
 * export's workspace has a still-`pending` referral.
 *
 * Handlers never throw back into the emitter
 * (`invoices/listeners/billing-events.listener.ts`'s precedent) — a listener
 * failure must not fail the export completion it is reacting to.
 */
@Injectable()
export class ExportCompletedListener {
  private readonly logger = new Logger(ExportCompletedListener.name);

  constructor(private readonly referrals: ReferralsService) {}

  @OnEvent(EXPORT_COMPLETED_EVENT)
  async onExportCompleted(payload: ExportCompletedPayload): Promise<void> {
    try {
      await this.referrals.grantForExport(payload.workspaceId);
    } catch (error) {
      this.logger.error(
        { err: error, workspaceId: payload.workspaceId, exportId: payload.exportId },
        "referral grant failed for a completed export",
      );
    }
  }
}
