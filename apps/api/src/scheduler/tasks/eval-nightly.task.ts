import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

export const EVAL_NIGHTLY_TASK = "scheduler.eval-nightly";

/** 02:30 UTC, off the API's own peak hours (this is the CPU-lane job D74 costs). */
const EVAL_NIGHTLY_CRON = "30 2 * * *";

/** D08 §5: eval_runs/eval_results are retained 90 days. */
const RETENTION_DAYS = 90;

export interface EvalNightlyReport {
  readonly triggered: boolean;
  readonly exitCode: number | null;
  readonly runsPurged: number;
}

/**
 * Triggers `apps/worker-ai`'s nightly eval job (D08 §5) and purges
 * `eval_runs`/`eval_results` past their 90-day retention.
 *
 * **How this reaches the worker.** `apps/api` and `apps/worker-ai` are
 * separately deployed processes (different runtimes: Node and a Python
 * venv) — CONTRACTS §3's frozen queue list has no `eval.*` entry, and adding
 * one is an ADR this WP does not have standing to make for a job that is a
 * nightly batch report, not a per-request job with a credits hold. Pre-Gate-A,
 * every app still shares one monorepo checkout on one host, so this task
 * shells out to the worker's own CLI (`pnpm --filter @montaj/worker-ai eval`,
 * which runs `python -m worker_ai.evals nightly --post`) exactly the way an
 * operator would run it by hand. That is a documented simplification, not the
 * final production shape: once the API and worker run in separate pods, this
 * task's job becomes "ask something that *can* reach the worker's CPU lane to
 * run it" (a k8s CronJob calling the worker image directly is the more likely
 * replacement) rather than executing it in-process. See this WP's final
 * report, "open questions for A00-05" section, for the same note.
 *
 * A failed spawn (non-zero exit, or the binary missing) is logged and does
 * not throw: a missed report is a monitoring gap, not an outage, and B16's
 * `ScheduledTasksService` already tracks task failures for its own alerting.
 */
@Injectable()
export class EvalNightlyTask implements OnModuleInit {
  private readonly logger = new Logger(EvalNightlyTask.name);
  private readonly execFileAsync = promisify(execFile);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: EVAL_NIGHTLY_TASK,
      cron: EVAL_NIGHTLY_CRON,
      run: async ({ at }) => {
        const report = await this.run(at);
        this.logger.log(report, "nightly eval job triggered");
      },
    });
  }

  async run(now: Date = new Date()): Promise<EvalNightlyReport> {
    const runsPurged = await this.purgeExpired(now);
    const trigger = await this.triggerWorker();
    return { ...trigger, runsPurged };
  }

  /** Deletes `eval_runs` (and, via cascade, their `eval_results`) past retention. */
  private async purgeExpired(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.evalRun.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return count;
  }

  private async triggerWorker(): Promise<{ triggered: boolean; exitCode: number | null }> {
    try {
      await this.execFileAsync(
        "pnpm",
        ["--filter", "@montaj/worker-ai", "run", "eval", "--", "--post"],
        {
          cwd: process.cwd(),
          timeout: 30 * 60 * 1000,
        },
      );
      return { triggered: true, exitCode: 0 };
    } catch (error) {
      const exitCode =
        typeof error === "object" && error !== null && "code" in error
          ? ((error as { code?: number }).code ?? null)
          : null;
      this.logger.error({ err: error, exitCode }, "nightly eval job failed to run");
      return { triggered: false, exitCode };
    }
  }
}
