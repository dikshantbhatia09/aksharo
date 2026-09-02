import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import { JOB_FAILED_EVENT, type JobFailedPayload } from "../../jobs/job-failed.event.js";
import { WebhookDeliveryService } from "../webhook-delivery.service.js";

/**
 * `job.failed` (B14b) — replaces the polled `jobs` cursor
 * `WebhookEventPollerService` used with a real `EventEmitter2` subscription to
 * the event `jobs/jobs.service.ts::complete()` emits once a job's row is
 * `failed` and dead-letter handling (if any) has run.
 */
@Injectable()
export class WebhookJobFailedListener {
  private readonly logger = new Logger(WebhookJobFailedListener.name);

  constructor(private readonly delivery: WebhookDeliveryService) {}

  @OnEvent(JOB_FAILED_EVENT)
  async onJobFailed(payload: JobFailedPayload): Promise<void> {
    try {
      await this.delivery.emit({
        workspaceId: payload.workspaceId,
        event: "job.failed",
        data: {
          jobId: payload.jobId,
          jobType: payload.jobType,
          projectId: payload.projectId,
          error: payload.error,
        },
      });
    } catch (error) {
      this.logger.error(
        { err: error, workspaceId: payload.workspaceId, jobId: payload.jobId },
        "could not fan out job.failed to webhooks",
      );
    }
  }
}
