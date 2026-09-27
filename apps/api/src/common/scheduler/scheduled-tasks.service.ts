import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { Queue, Worker } from "bullmq";

import {
  SCHEDULER_KEEP_COMPLETED,
  SCHEDULER_KEEP_FAILED,
  SCHEDULER_QUEUE,
  schedulerEnabled,
  schedulerMode,
} from "./scheduler.types.js";
import { queuePrefix } from "../../jobs/jobs.config.js";
import { RedisService } from "../redis/redis.service.js";

import type { ScheduledTask, SchedulerMode } from "./scheduler.types.js";
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
 *
 * **Finished ticks are pruned** ({@link SCHEDULER_KEEP_COMPLETED}): BullMQ keeps
 * every job by default, which for a minute-by-minute task is Redis memory that
 * grows for as long as the scheduler runs.
 *
 * **The allowlist** (`MONTAJ_SCHEDULER_TASKS`, {@link schedulerMode}) is enforced
 * at all three points a task can run from the queue, not just at install: a
 * schedule installed by an earlier boot without an allowlist lives on in Redis and
 * keeps producing ticks, and a tick for a registered task would otherwise run it.
 * So bootstrap removes the leftover schedules, and a tick that still arrives for
 * a task outside the list is dropped and its schedule removed. `runNow` — the
 * admin console's explicit "run this once" — is deliberately not restricted.
 */
@Injectable()
export class ScheduledTasksService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ScheduledTasksService.name);
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly prefix = queuePrefix();
  private queue?: Queue;
  private worker?: Worker;
  private started = false;
  private mode: SchedulerMode = { run: false, allow: null };

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
    if (this.started && this.allows(task.name)) void this.install(task);
  }

  /** Registered task names, in registration order. */
  get registered(): readonly string[] {
    return [...this.tasks.keys()];
  }

  /**
   * The registered tasks the queue will actually run, in registration order:
   * none while the scheduler is off, all of them with no allowlist.
   */
  get scheduled(): readonly string[] {
    if (!this.started) return [];
    return this.registered.filter((name) => this.allows(name));
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
    this.mode = schedulerMode();
    if (!this.mode.run) {
      this.logger.log(
        schedulerEnabled()
          ? "scheduler disabled (MONTAJ_SCHEDULER_TASKS is set but lists no task)"
          : "scheduler disabled (MONTAJ_SCHEDULER_DISABLED=1)",
      );
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
      // On the worker as well as the template: a tick produced by a schedule an
      // earlier release installed carries no limit of its own, and the worker's
      // is what applies to it.
      removeOnComplete: { count: SCHEDULER_KEEP_COMPLETED },
      removeOnFail: { count: SCHEDULER_KEEP_FAILED },
    });
    this.worker.on("error", (error: Error) => {
      this.logger.warn({ err: error.message }, "scheduler worker error");
    });
    this.worker.on("failed", (job: BullJob | undefined, error: Error) => {
      this.logger.error({ task: job?.name, err: error.message }, "scheduled task failed");
    });

    await this.removeDisallowedSchedules();
    for (const task of this.tasks.values()) {
      if (this.allows(task.name)) await this.install(task);
    }
    this.announce();
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
        {
          name: task.name,
          opts: {
            removeOnComplete: { count: SCHEDULER_KEEP_COMPLETED },
            removeOnFail: { count: SCHEDULER_KEEP_FAILED },
          },
        },
      );
    } catch (error) {
      this.logger.error(
        { task: task.name, err: error instanceof Error ? error.message : String(error) },
        "could not install scheduled task",
      );
    }
  }

  private async execute(name: string): Promise<void> {
    if (!this.allows(name)) {
      // A schedule that survived `removeDisallowedSchedules` — installed by an
      // older process while this one was booting, say. Running it would switch
      // on exactly what the allowlist exists to keep off.
      this.logger.warn({ task: name }, "tick for a task outside MONTAJ_SCHEDULER_TASKS; dropped");
      await this.removeSchedule(name);
      return;
    }
    const task = this.tasks.get(name);
    if (task === undefined) {
      // A task removed from the code but not from Redis. Log it: the leftover
      // schedule needs deleting by hand.
      this.logger.warn({ task: name }, "tick for an unregistered task");
      return;
    }
    await task.run({ name, at: new Date() });
  }

  private allows(name: string): boolean {
    return this.mode.allow === null || this.mode.allow.has(name);
  }

  /**
   * Remove every schedule in Redis the allowlist does not cover, registered in
   * this process or not. Schedules are durable: one installed before the
   * allowlist existed would otherwise keep firing forever. With no allowlist
   * this is a no-op, so a plain boot leaves an unknown schedule alone exactly as
   * before (and {@link execute} logs its ticks).
   */
  private async removeDisallowedSchedules(): Promise<void> {
    if (this.queue === undefined || this.mode.allow === null) return;
    try {
      const schedules = await this.queue.getJobSchedulers(0, -1);
      for (const schedule of schedules) {
        if (!this.allows(schedule.key)) await this.removeSchedule(schedule.key);
      }
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "could not list scheduled tasks to prune; ticks outside the allowlist are still dropped",
      );
    }
  }

  private async removeSchedule(name: string): Promise<void> {
    try {
      if ((await this.queue?.removeJobScheduler(name)) === true) {
        this.logger.log({ task: name }, "removed a schedule outside MONTAJ_SCHEDULER_TASKS");
      }
    } catch (error) {
      this.logger.warn(
        { task: name, err: error instanceof Error ? error.message : String(error) },
        "could not remove a schedule outside MONTAJ_SCHEDULER_TASKS",
      );
    }
  }

  /** One line at boot saying what runs, and every allowlisted name nobody registered. */
  private announce(): void {
    const running = this.scheduled;
    if (this.mode.allow === null) {
      this.logger.log(`scheduler running ${String(running.length)} task(s)`);
      return;
    }
    // A typo in the variable is a task that silently never runs; say so.
    const unknown = [...this.mode.allow].filter((name) => !this.tasks.has(name));
    this.logger.log(
      { tasks: running, ...(unknown.length === 0 ? {} : { unregistered: unknown }) },
      `scheduler running ${String(running.length)} of ${String(this.tasks.size)} task(s) (MONTAJ_SCHEDULER_TASKS)`,
    );
    if (unknown.length > 0) {
      this.logger.warn(
        { unregistered: unknown },
        "MONTAJ_SCHEDULER_TASKS names tasks nobody registered",
      );
    }
  }
}
