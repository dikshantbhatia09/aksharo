import { Injectable, type OnModuleInit } from "@nestjs/common";

import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { DlqService } from "../dlq.service.js";
import { DLQ_DEPTH_INTERVAL_MS } from "../jobs.config.js";

/** The scheduled task's name; also its BullMQ scheduler key. */
export const DLQ_DEPTH_TASK = "jobs.dlq-depth";

/**
 * Re-samples `montaj_queue_dlq_depth` from Postgres.
 *
 * `DlqService` already refreshes the gauge after every write, which covers the
 * instance that did the writing. This exists for the other instances: the API is
 * stateless behind a load balancer (`05 §10`), the metric registry is per process,
 * and a pod that has not handled a dead letter since it booted would otherwise
 * scrape as a confident zero — which is exactly the failure METRICS.md warns
 * about, "a missing series looks exactly like a healthy zero".
 *
 * A minute is fast enough: `MontajDlqNonEmpty` fires on a five-minute `for`, and
 * the query is one grouped count over a partial index.
 */
@Injectable()
export class DlqDepthTask implements OnModuleInit {
  constructor(
    private readonly dlq: DlqService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: DLQ_DEPTH_TASK,
      everyMs: DLQ_DEPTH_INTERVAL_MS,
      run: async () => {
        await this.dlq.refreshDepth();
      },
    });
  }
}
