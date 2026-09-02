import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import { CREDITS_LOW_EVENT, type CreditsLowPayload } from "../../credits/credits-low.event.js";
import { WebhookDeliveryService } from "../webhook-delivery.service.js";

/**
 * `credits.low` (B14b) — replaces the polled `notifications` cursor
 * `WebhookEventPollerService` used with a real `EventEmitter2` subscription to
 * the event `credits/credits-low-balance.notifier.ts` emits right where it
 * already raises the `low-credits` notification.
 */
@Injectable()
export class WebhookCreditsLowListener {
  private readonly logger = new Logger(WebhookCreditsLowListener.name);

  constructor(private readonly delivery: WebhookDeliveryService) {}

  @OnEvent(CREDITS_LOW_EVENT)
  async onCreditsLow(payload: CreditsLowPayload): Promise<void> {
    try {
      await this.delivery.emit({
        workspaceId: payload.workspaceId,
        event: "credits.low",
        data: {
          thresholdFraction: payload.thresholdFraction,
          balanceTenths: payload.balanceTenths,
        },
      });
    } catch (error) {
      this.logger.error(
        { err: error, workspaceId: payload.workspaceId },
        "could not fan out credits.low to webhooks",
      );
    }
  }
}
