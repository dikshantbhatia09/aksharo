import { Module } from "@nestjs/common";

import { WebhookCreditsLowListener } from "./listeners/credits-low.listener.js";
import { WebhookExportCompletedListener } from "./listeners/export-completed.listener.js";
import { WebhookJobFailedListener } from "./listeners/job-failed.listener.js";
import { WebhookTranscriptCompletedListener } from "./listeners/transcript-completed.listener.js";
import { WebhookDeliverySweepTask } from "./tasks/webhook-delivery-sweep.task.js";
import { WebhookDeliveryService } from "./webhook-delivery.service.js";
import { WebhookEndpointsService } from "./webhook-endpoints.service.js";
import { WebhooksController } from "./webhooks.controller.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * B14 §4: webhook endpoint CRUD, signed retried delivery and the event
 * listeners that feed it. `CommonModule` (global) supplies `PrismaService`,
 * `RedisService` and `CommonAuditService`; `SchedulerModule` (global)
 * supplies `ScheduledTasksService` — neither is imported explicitly.
 *
 * B14b: every event source is now a real `EventEmitter2` emit at its
 * producer (`export.completed` already was; `transcript.completed`,
 * `job.failed` and `credits.low` join it here) — `WebhookEventPollerService`
 * and its Redis cursors are gone.
 */
@Module({
  imports: [WorkspacesModule],
  controllers: [WebhooksController],
  providers: [
    WebhookEndpointsService,
    WebhookDeliveryService,
    WebhookExportCompletedListener,
    WebhookTranscriptCompletedListener,
    WebhookJobFailedListener,
    WebhookCreditsLowListener,
    WebhookDeliverySweepTask,
  ],
  exports: [WebhookDeliveryService, WebhookEndpointsService],
})
export class WebhooksModule {}
