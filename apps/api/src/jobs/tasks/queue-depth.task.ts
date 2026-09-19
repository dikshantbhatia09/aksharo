import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { MetricsService } from "../../common/metrics/metrics.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { QUEUE_NAMES } from "../contracts/queue-names.js";
import { QUEUE_DEPTH_INTERVAL_MS } from "../jobs.config.js";
import { QueueRegistry } from "../queue.registry.js";

/** The scheduled task's name; also its BullMQ scheduler key. */
export const QUEUE_DEPTH_TASK = "jobs.queue-depth";

/**
 * Publish `montaj_queue_depth{queue,state}` for every contract queue.
 *
 * Two things depended on this series and neither had it:
 *
 *   * `MontajQueueBacklogGrowing` in `infra/observability/alerts/` queries
 *     `montaj_queue_depth{state="waiting"}`. Nothing emitted it, so the rule had
 *     never fired and never could — indistinguishable, on a dashboard, from a
 *     system whose queues never back up.
 *   * KEDA scaled the workers on the Redis **list** at `bull:<queue>:wait`. Every
 *     job this API enqueues carries a `priority` (`jobs.config.ts` assigns 1-5),
 *     and BullMQ puts a prioritised job in the `prioritized` *sorted set*, not in
 *     the `wait` list. So the scaler read a list that was very nearly always
 *     empty while the real backlog grew beside it, and the workers never scaled
 *     up (launch-readiness P0-04).
 *
 * `getJobCounts` asks Redis for all four states in one pipelined call per queue,
 * which is cheap enough to run every 15 s — fast enough for KEDA's default
 * polling interval to see a burst rather than the tail of one.
 *
 * Runs on every API replica, like `DlqDepthTask`... except it does not: it is
 * registered with the shared scheduler, so one replica per tick samples and
 * publishes. That is deliberate. These are queue-wide numbers, identical from
 * every process, and having ten replicas each publish their own copy would make
 * a `sum()` across pods ten times the truth.
 */
@Injectable()
export class QueueDepthTask implements OnModuleInit {
  private readonly logger = new Logger(QueueDepthTask.name);

  constructor(
    private readonly queues: QueueRegistry,
    private readonly metrics: MetricsService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: QUEUE_DEPTH_TASK,
      everyMs: QUEUE_DEPTH_INTERVAL_MS,
      run: async () => {
        await this.sample();
      },
    });
  }

  /** One pass over every contract queue. */
  async sample(): Promise<void> {
    for (const name of QUEUE_NAMES) {
      try {
        const counts = await this.queues.queue(name).getJobCounts(
          "wait",
          "prioritized",
          "delayed",
          "active",
        );
        // A queue that has drained must still report zero: a series that
        // disappears looks exactly like a healthy one that was never scraped
        // (METRICS.md §Conventions).
        this.metrics.queueDepth(name, "waiting", counts["wait"] ?? 0);
        this.metrics.queueDepth(name, "prioritized", counts["prioritized"] ?? 0);
        this.metrics.queueDepth(name, "delayed", counts["delayed"] ?? 0);
        this.metrics.queueDepth(name, "active", counts["active"] ?? 0);
      } catch (error) {
        // One unreachable queue must not stop the other thirteen being sampled,
        // and a metrics failure must never take the process with it.
        this.logger.warn(
          { queue: name, err: error instanceof Error ? error.message : String(error) },
          "queue depth gauge not refreshed",
        );
      }
    }
  }
}
