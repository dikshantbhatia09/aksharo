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
 * Turn off the in-process scheduler worker. **Authoritative**: `1` means no task
 * runs from the queue, whatever `MONTAJ_SCHEDULER_TASKS` says.
 *
 * Set for one-shot processes (migrations, the OpenAPI emitter) and in tests, which
 * drive tasks directly through `ScheduledTasksService.runNow()` instead of waiting
 * for a tick; and it is the operator's emergency stop. All three rely on it
 * meaning "off": the OpenAPI emitter never exits while a worker blocks on Redis,
 * and an e2e app that ran the lease reaper would fail the suite's own fixture
 * rows. A task list inherited from a `.env` or a shell must not undo it.
 */
export function schedulerEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return source["MONTAJ_SCHEDULER_DISABLED"] !== "1";
}

/**
 * `MONTAJ_SCHEDULER_TASKS`: the only tasks this process may run, as a comma (or
 * whitespace) separated list of task names; `null` when unset.
 *
 * **Set but empty is an empty list — nothing runs — not "no list".** The
 * variable exists to keep money-moving tasks off, so the value it is most
 * likely to be left with by mistake (`MONTAJ_SCHEDULER_TASKS=`) fails closed.
 *
 * Why it exists (2026-09-27): `MONTAJ_SCHEDULER_DISABLED` is all or nothing
 * across thirty tasks, and those include affiliate payouts, renewal dunning and
 * credit grant resets. Production kept the whole scheduler off rather than
 * switch those on, and so also lost the dead-letter gauge and every watchdog —
 * two zombie jobs held lane slots for 24 days. An allowlist turns on exactly
 * the operational tasks and leaves the rest off.
 */
export function schedulerTaskAllowlist(
  source: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> | null {
  const raw = source["MONTAJ_SCHEDULER_TASKS"];
  if (raw === undefined) return null;
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((name) => name.trim())
      .filter((name) => name !== ""),
  );
}

/** What the scheduler does in this process, from the two variables together. */
export interface SchedulerMode {
  /** Start the BullMQ queue and worker at all. */
  readonly run: boolean;
  /** When set, only these tasks are installed and executed; `null` means every task. */
  readonly allow: ReadonlySet<string> | null;
}

/**
 * The two variables combined.
 *
 * | `MONTAJ_SCHEDULER_DISABLED` | `MONTAJ_SCHEDULER_TASKS` | runs             |
 * | --------------------------- | ------------------------ | ---------------- |
 * | unset / `0`                 | unset                    | every task       |
 * | unset / `0`                 | `a,b`                    | only `a` and `b` |
 * | unset / `0`                 | set but empty            | nothing          |
 * | `1`                         | anything                 | nothing          |
 *
 * The kill switch wins and the list only ever narrows, so neither variable can
 * switch on a task the other one kept off. Production therefore runs with
 * `MONTAJ_SCHEDULER_DISABLED=0` and the list, not with `1` and the list.
 */
export function schedulerMode(source: NodeJS.ProcessEnv = process.env): SchedulerMode {
  const allow = schedulerTaskAllowlist(source);
  return { run: schedulerEnabled(source) && (allow === null || allow.size > 0), allow };
}

/**
 * How many finished ticks BullMQ keeps. Without a limit it keeps every one
 * (`removeOnComplete` defaults to keep-all), and a 60-second task alone leaves
 * 1,440 job hashes a day in a Redis that never evicts (`noeviction`, AOF on).
 * A few hundred completed is enough to see the recent history in a queue
 * browser; failures are kept longer because they are what someone looks for.
 */
export const SCHEDULER_KEEP_COMPLETED = 200;
export const SCHEDULER_KEEP_FAILED = 1_000;
