import { Module } from "@nestjs/common";

import { WebhookExportCompletedListener } from "./listeners/export-completed.listener.js";
import { WebhookDeliverySweepTask } from "./tasks/webhook-delivery-sweep.task.js";
import { WebhookDeliveryService } from "./webhook-delivery.service.js";
import { WebhookEndpointsService } from "./webhook-endpoints.service.js";
import { WebhookEventPollerService } from "./webhook-event-poller.service.js";
import { WebhooksController } from "./webhooks.controller.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * B14 §4: webhook endpoint CRUD, signed retried delivery and the event
 * pollers/listener that feed it. `CommonModule` (global) supplies
 * `PrismaService`, `RedisService` and `CommonAuditService`; `SchedulerModule`
 * (global) supplies `ScheduledTasksService` — neither is imported explicitly.
 */
@Module({
  imports: [WorkspacesModule],
  controllers: [WebhooksController],
  providers: [
    WebhookEndpointsService,
    WebhookDeliveryService,
    WebhookEventPollerService,
    WebhookExportCompletedListener,
    WebhookDeliverySweepTask,
  ],
  exports: [WebhookDeliveryService, WebhookEndpointsService],
})
export class WebhooksModule {}
