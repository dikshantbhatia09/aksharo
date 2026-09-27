import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { AlertSender } from "./alert-sender.js";
import { AlertStateStore, planAlerts } from "./alert-state.js";
import { OpsWatchChecks } from "./ops-watch.checks.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

import type { CheckResult, Finding } from "./alert-state.js";

/** The scheduled task's name; also its BullMQ scheduler key and its allowlist entry. */
export const OPS_WATCH_TASK = "ops.watch";

/** Every minute: the owner hears about a stall, a full disk or a dead worker within minutes. */
export const OPS_WATCH_INTERVAL_MS = 60_000;

/** A check that has not answered in this long is reported as failed rather than waited on. */
const CHECK_TIMEOUT_MS = 20_000;

export interface OpsWatchReport {
  /** Everything the checks found this pass, alerted or not. */
  readonly findings: number;
  readonly failedChecks: readonly string[];
  /** Notifications delivered / not delivered (retried next pass). */
  readonly sent: number;
  readonly unsent: number;
}

/**
 * `ops.watch`: nothing fails silently (2026-09-27).
 *
 * Before this, a job could stall, the dead-letter queue fill, a worker die at
 * boot or the disk run down to a gigabyte, and the first person to notice was
 * a user — there is no Sentry DSN, no mail and no Prometheus on this machine,
 * and the gauges the 24 alert rules read are published by the scheduler that
 * production keeps off. Every minute this runs the checks in
 * {@link OpsWatchChecks}, and sends what changed to `ALERT_WEBHOOK_URL`:
 * a problem once two passes in a row have seen it, a reminder every six hours
 * while it lasts, one "cleared" once it has been gone ten minutes
 * (`alert-state.ts` has the rules).
 *
 * A check that throws does not stop the others; it becomes its own finding
 * (`watch.check-failed`), so a watch that has gone blind says so. It cannot say
 * so if Redis is down — the scheduler that runs it lives on Redis — which is
 * what an external heartbeat is for.
 */
@Injectable()
export class OpsWatchTask implements OnModuleInit {
  private readonly logger = new Logger(OpsWatchTask.name);
  /** One pass at a time in this process; a slow pass skips a tick rather than doubling alerts. */
  private running = false;

  constructor(
    private readonly checks: OpsWatchChecks,
    private readonly state: AlertStateStore,
    private readonly sender: AlertSender,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: OPS_WATCH_TASK,
      everyMs: OPS_WATCH_INTERVAL_MS,
      run: async ({ at }) => {
        await this.tick(at);
      },
    });
  }

  /** One pass. `null` when a previous pass is still running. */
  async tick(now: Date = new Date()): Promise<OpsWatchReport | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.pass(now);
    } finally {
      this.running = false;
    }
  }

  private async pass(now: Date): Promise<OpsWatchReport> {
    const results = await Promise.all(
      this.checks.all().map(async (check): Promise<CheckResult> => {
        try {
          const { findings, partial } = await withTimeout(check.run(now), CHECK_TIMEOUT_MS);
          return { check: check.id, ok: true, partial, findings };
        } catch (error) {
          this.logger.error(
            { check: check.id, err: error instanceof Error ? error.message : String(error) },
            "ops check failed",
          );
          return { check: check.id, ok: false, findings: [] };
        }
      }),
    );

    const failed = results.filter((result) => !result.ok);
    const blind: Finding[] = failed.map((result) => ({
      check: "watch.check-failed",
      subject: result.check,
      severity: "notice",
      line: `${result.check} could not run (see the API log)`,
    }));
    const all: CheckResult[] = [
      ...results,
      { check: "watch.check-failed", ok: true, findings: blind },
    ];

    const state = await this.state.load();
    const plan = planAlerts({ now: now.getTime(), results: all, state });

    let sent = 0;
    let unsent = 0;
    for (const planned of plan.alerts) {
      if (await this.sender.send(planned.alert)) {
        sent += 1;
        await this.state.put(planned.put);
        await this.state.remove(planned.remove);
      } else {
        // Not recorded as said: a condition is planned again next pass because
        // it is still there; an event may not be (the checks look back fifteen
        // minutes), so it is written down as owed.
        unsent += 1;
        await this.state.put(planned.ifUnsent);
      }
    }
    await this.state.put(plan.put);
    await this.state.remove(plan.remove);

    return {
      findings: all.reduce((total, result) => total + result.findings.length, 0),
      failedChecks: failed.map((result) => result.check),
      sent,
      unsent,
    };
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)} ms`));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
