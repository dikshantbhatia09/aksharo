import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { WebhookDeliveryService } from "../webhook-delivery.service.js";
import { WEBHOOK_SWEEP_INTERVAL_MS } from "../webhooks.constants.js";

export const WEBHOOK_DELIVERY_SWEEP_TASK = "webhooks.delivery-sweep";

/**
 * Registers the periodic tick B14 §4 needs (`common/scheduler`'s "register a
 * task, get a BullMQ-backed timer" primitive — the same one B16's retention
 * sweeps and B02's grant reset use): dispatch every due delivery
 * ({@link WebhookDeliveryService.dispatchDue}), every
 * {@link WEBHOOK_SWEEP_INTERVAL_MS}.
 *
 * B14b removed the second tick this task used to register
 * (`webhooks.event-poll`, `WebhookEventPollerService`'s `jobs`/
 * `notifications` cursors) now that `transcript.completed`, `job.failed` and
 * `credits.low` are real `EventEmitter2` emits at their producers, delivered
 * the same way `export.completed` always was.
 */
@Injectable()
export class WebhookDeliverySweepTask implements OnModuleInit {
  private readonly logger = new Logger(WebhookDeliverySweepTask.name);

  constructor(
    private readonly delivery: WebhookDeliveryService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: WEBHOOK_DELIVERY_SWEEP_TASK,
      everyMs: WEBHOOK_SWEEP_INTERVAL_MS,
      run: async () => {
        const result = await this.delivery.dispatchDue();
        if (result.dispatched > 0) this.logger.debug(result, "webhook deliveries dispatched");
      },
    });
  }
}
