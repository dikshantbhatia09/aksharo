import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import {
  EXPORT_COMPLETED_EVENT,
  type ExportCompletedPayload,
} from "../../referrals/export-completed.event.js";
import { WebhookDeliveryService } from "../webhook-delivery.service.js";

/**
 * `export.completed` (B14 §4) — already emitted, event name and all, by
 * `exports/` for B07b's referral loop (`referrals/export-completed.event.ts`,
 * `EXPORT_COMPLETED_EVENT = "export.completed"`). No file outside this WP's
 * boundary needs to change for this one: `EventEmitter2` is global, so this
 * listener subscribes to the same event `ExportCompletedListener` (referrals)
 * already does, purely additively.
 */
@Injectable()
export class WebhookExportCompletedListener {
  private readonly logger = new Logger(WebhookExportCompletedListener.name);

  constructor(private readonly delivery: WebhookDeliveryService) {}

  @OnEvent(EXPORT_COMPLETED_EVENT)
  async onExportCompleted(payload: ExportCompletedPayload): Promise<void> {
    try {
      await this.delivery.emit({
        workspaceId: payload.workspaceId,
        event: "export.completed",
        data: { exportId: payload.exportId },
      });
    } catch (error) {
      this.logger.error(
        { err: error, workspaceId: payload.workspaceId, exportId: payload.exportId },
        "could not fan out export.completed to webhooks",
      );
    }
  }
}
