import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { Queue, Worker } from "bullmq";

import { SCHEDULER_QUEUE, schedulerEnabled } from "./scheduler.types.js";
import { queuePrefix } from "../../jobs/jobs.config.js";
import { RedisService } from "../redis/redis.service.js";

import type { ScheduledTask } from "./scheduler.types.js";
import type { Job as BullJob } from "bullmq";

/**
 * Cron for the API, on BullMQ job schedulers.
 *
 * One repeatable entry per registered task on an internal `scheduler` queue, and
 * one `Worker` per API instance to execute them. Redis is what makes this safe
 * with more than one instance: a scheduled tick becomes exactly one job, and only
 * one worker gets it — which is the whole reason this is not `setInterval`.
 *
 * (CONTRACTS §3 records repeatable jobs as *unsupported by the Python worker*;
 * that is a statement about `apps/worker-ai`, which does not consume this queue.
 * Nothing outside the API ever sees `scheduler`.)
 *
 * Tasks register in `onModuleInit` of their own module and are installed once,
 * at bootstrap, so registration order does not matter.
 */
@Injectable()
export class ScheduledTasksService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ScheduledTasksService.name);
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly prefix = queuePrefix();
  private queue?: Queue;
  private worker?: Worker;
  private started = false;

  constructor(private readonly redis: RedisService) {}

  /** Register a task. Must happen before bootstrap; later calls still install. */
  register(task: ScheduledTask): void {
    if ((task.everyMs === undefined) === (task.cron === undefined)) {
      throw new Error(`Scheduled task "${task.name}" needs exactly one of everyMs or cron.`);
    }
    if (this.tasks.has(task.name)) {
      throw new Error(`Scheduled task "${task.name}" is already registered.`);
    }
    this.tasks.set(task.name, task);
    if (this.started) void this.install(task);
  }

  /** Registered task names, in registration order. */
  get registered(): readonly string[] {
    return [...this.tasks.keys()];
  }

  /**
   * Run one task now, in this process, bypassing the queue.
   *
   * The test seam: a suite asserts the sweeper's behaviour without waiting for a
   * tick, and an operator can force a run from a REPL.
   */
  async runNow(name: string): Promise<void> {
    const task = this.tasks.get(name);
    if (task === undefined) throw new Error(`No scheduled task named "${name}".`);
    await task.run({ name, at: new Date() });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!schedulerEnabled()) {
      this.logger.log("scheduler disabled (MONTAJ_SCHEDULER_DISABLED=1)");
      return;
    }
    this.started = true;

    this.queue = new Queue(SCHEDULER_QUEUE, {
      connection: this.redis.client,
      prefix: this.prefix,
    });
    this.queue.on("error", (error: Error) => {
      this.logger.warn({ err: error.message }, "scheduler queue error");
    });

    this.worker = new Worker(SCHEDULER_QUEUE, async (job: BullJob) => this.execute(job.name), {
      connection: this.redis.client,
      prefix: this.prefix,
      // Periodic work is I/O bound and short; more than a couple at once only
      // makes a slow sweep collide with its own next tick.
      concurrency: 2,
    });
    this.worker.on("error", (error: Error) => {
      this.logger.warn({ err: error.message }, "scheduler worker error");
    });
    this.worker.on("failed", (job: BullJob | undefined, error: Error) => {
      this.logger.error({ task: job?.name, err: error.message }, "scheduled task failed");
    });

    for (const task of this.tasks.values()) await this.install(task);
    this.logger.log(`scheduler running ${String(this.tasks.size)} task(s)`);
  }

  async onModuleDestroy(): Promise<void> {
    this.started = false;
    await this.worker?.close();
    await this.queue?.close();
    this.worker = undefined;
    this.queue = undefined;
  }

  private async install(task: ScheduledTask): Promise<void> {
    if (this.queue === undefined) return;
    try {
      await this.queue.upsertJobScheduler(
        task.name,
        task.everyMs === undefined ? { pattern: task.cron } : { every: task.everyMs },
        { name: task.name },
      );
    } catch (error) {
      this.logger.error(
        { task: task.name, err: error instanceof Error ? error.message : String(error) },
        "could not install scheduled task",
      );
    }
  }

  private async execute(name: string): Promise<void> {
    const task = this.tasks.get(name);
    if (task === undefined) {
      // A task removed from the code but not from Redis. Log it: the leftover
      // schedule needs deleting by hand.
      this.logger.warn({ task: name }, "tick for an unregistered task");
      return;
    }
    await task.run({ name, at: new Date() });
  }
}
