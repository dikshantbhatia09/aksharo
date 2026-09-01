/**
 * The cron primitive every periodic job in the API registers with.
 *
 * A08 lands it with one task (the queue-timeout sweeper); B16's retention and
 * reconciliation sweeps, B01's renewal initiation and B02's grant reset all
 * register here rather than each growing its own timer.
 */

/** A task that runs on a schedule. */
export interface ScheduledTask {
  /**
   * Stable identifier, `namespace.what`. It is the BullMQ job-scheduler key, so
   * renaming one leaves the old schedule behind until it is removed by hand.
   */
  readonly name: string;
  /** Run every N milliseconds. Mutually exclusive with {@link cron}. */
  readonly everyMs?: number;
  /** Standard 5- or 6-field cron expression. Mutually exclusive with {@link everyMs}. */
  readonly cron?: string;
  /** What to do. Must be idempotent: a scheduler at-least-once fires twice. */
  readonly run: (context: ScheduledTaskContext) => Promise<void>;
}

export interface ScheduledTaskContext {
  readonly name: string;
  /** When the tick fired, so a task can measure its own lateness. */
  readonly at: Date;
}

/** The internal queue periodic work runs on. Not a CONTRACTS §3 queue. */
export const SCHEDULER_QUEUE = "scheduler";

/**
 * Turn off the in-process scheduler worker.
 *
 * Set for one-shot processes (migrations, the OpenAPI emitter) and in tests, which
 * drive tasks directly through `ScheduledTasksService.runNow()` instead of waiting
 * for a tick.
 */
export function schedulerEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return source["MONTAJ_SCHEDULER_DISABLED"] !== "1";
}
