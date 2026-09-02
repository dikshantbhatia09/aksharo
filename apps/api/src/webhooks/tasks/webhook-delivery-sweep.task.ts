import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { WebhookDeliveryService } from "../webhook-delivery.service.js";
import { WebhookEventPollerService } from "../webhook-event-poller.service.js";
import { WEBHOOK_SWEEP_INTERVAL_MS } from "../webhooks.constants.js";

export const WEBHOOK_DELIVERY_SWEEP_TASK = "webhooks.delivery-sweep";
export const WEBHOOK_EVENT_POLL_TASK = "webhooks.event-poll";

/**
 * Registers the two periodic ticks B14 §4 needs (`common/scheduler`'s
 * "register a task, get a BullMQ-backed timer" primitive — the same one B16's
 * retention sweeps and B02's grant reset use):
 *
 *   1. `webhooks.delivery-sweep` — dispatch every due delivery
 *      ({@link WebhookDeliveryService.dispatchDue}), every
 *      {@link WEBHOOK_SWEEP_INTERVAL_MS}.
 *   2. `webhooks.event-poll` — the transcript/job/credits pollers
 *      ({@link WebhookEventPollerService}), same interval: they only read a
 *      handful of indexed rows per tick, so sharing the cadence with the
 *      dispatch sweep keeps this to one extra periodic worker rather than two.
 */
@Injectable()
export class WebhookDeliverySweepTask implements OnModuleInit {
  private readonly logger = new Logger(WebhookDeliverySweepTask.name);

  constructor(
    private readonly delivery: WebhookDeliveryService,
    private readonly poller: WebhookEventPollerService,
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

    this.scheduler.register({
      name: WEBHOOK_EVENT_POLL_TASK,
      everyMs: WEBHOOK_SWEEP_INTERVAL_MS,
      run: async () => {
        const [transcripts, jobs, credits] = await Promise.all([
          this.poller.pollTranscriptsCompleted(),
          this.poller.pollJobsFailed(),
          this.poller.pollCreditsLow(),
        ]);
        const seen = transcripts.seen + jobs.seen + credits.seen;
        if (seen > 0) this.logger.debug({ transcripts, jobs, credits }, "webhook event poll");
      },
    });
  }
}
