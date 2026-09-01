import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";

import { queuePrefix, retryPolicyFor } from "./jobs.config.js";
import { RedisService } from "../common/redis/redis.service.js";

import type { QueueName } from "./contracts/queue-names.js";
import type { JobsOptions } from "bullmq";

/**
 * One BullMQ `Queue` per queue name, created on first use.
 *
 * They share the single `RedisService` connection rather than opening one pool
 * each: `RedisService` was already configured with `maxRetriesPerRequest: null`
 * precisely because "BullMQ will share it in A08".
 *
 * `Queue` is the *producer* side only. The API never runs a `Worker` on a contract
 * queue — those are `apps/worker-media`, `apps/worker-ai` and `apps/render`. The
 * one `Worker` the API does run is the internal `scheduler` queue
 * (`common/scheduler`), which is not a contract queue at all.
 */
@Injectable()
export class QueueRegistry implements OnModuleDestroy {
  private readonly logger = new Logger(QueueRegistry.name);
  private readonly queues = new Map<string, Queue>();
  readonly prefix = queuePrefix();

  constructor(private readonly redis: RedisService) {}

  queue(name: QueueName): Queue {
    const existing = this.queues.get(name);
    if (existing !== undefined) return existing;

    const queue = new Queue(name, { connection: this.redis.client, prefix: this.prefix });
    queue.on("error", (error: Error) => {
      // Producers must not die because Redis blinked; the enqueue call itself
      // rejects and the caller sees a 503.
      this.logger.warn({ queue: name, err: error.message }, "queue error");
    });
    this.queues.set(name, queue);
    return queue;
  }

  /**
   * BullMQ job options for one enqueue.
   *
   * `jobId` is `{jobId}-{attemptId}` because BullMQ forbids `:` in a custom id and
   * because A08b's replay adds a *new* BullMQ job for the same `jobs` row with a
   * fresh `attemptId`; deriving the id from the row means neither side has to store
   * a second identifier.
   */
  optionsFor(input: {
    readonly queueName: QueueName;
    readonly jobId: string;
    readonly attemptId: string;
    readonly priority: number;
  }): JobsOptions {
    const policy = retryPolicyFor(input.queueName);
    return {
      jobId: bullJobId(input.jobId, input.attemptId),
      priority: input.priority,
      attempts: policy.attempts,
      backoff: { type: "exponential", delay: policy.backoffMs },
      // The `jobs` table is the record of what happened; Redis only needs the
      // recent tail for the dashboard and for A08b's dead-letter copy.
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 3_600, count: 5_000 },
    };
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map(async (queue) => queue.close()));
    this.queues.clear();
  }
}

/** BullMQ custom job ids may not contain `:`. */
export function bullJobId(jobId: string, attemptId: string): string {
  return `${jobId}-${attemptId}`;
}
