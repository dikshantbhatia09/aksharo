import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { RenewalService } from "../../billing/renewal.service.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

export const RENEWAL_DUNNING_TASK = "scheduler.renewal-dunning";

/** Daily (06-data-model.md §Retention jobs: renewal initiation, dunning). */
const RENEWAL_DUNNING_CRON = "0 3 * * *";
const BATCH = 500;

export interface RenewalDunningReport {
  readonly renewalsInitiated: number;
  readonly gracePaused: number;
}

/**
 * Wires B01's renewal and grace-expiry primitives (`billing/renewal.service.ts`)
 * into the scheduler — B01's own doc comment on `RenewalService` says this is
 * B16's to do.
 *
 * **Renewal initiation.** Every subscription past its `renewalInitiateAt` (≥ 48 h
 * before `currentPeriodEnd`, D40) gets `initiateRenewal` called. Calling it more
 * than once for the same subscription before the period rolls over is safe:
 * `initiateRenewal`'s own `NotifyService.enqueue` uses an `idempotencyKey` keyed
 * on `(subscriptionId, currentPeriodEnd)` as the BullMQ `jobId`, so a second tick
 * before the next period is a no-op re-add, not a second email.
 *
 * **Dunning.** `graceExpiry` is the ladder's terminal step — 3 days past
 * `graceUntil`, a `past_due` subscription is paused (D40 invariant 7) — and it
 * is already idempotent (`status: "past_due"` is part of its own `WHERE`, so a
 * subscription it already paused does not match on the next tick). The earlier
 * rungs of the ladder (`handleDecline`, per-attempt retries) are driven by the
 * provider's own decline webhook, not a clock, so they are not scheduled here.
 */
@Injectable()
export class RenewalDunningTask implements OnModuleInit {
  private readonly logger = new Logger(RenewalDunningTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly renewal: RenewalService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: RENEWAL_DUNNING_TASK,
      cron: RENEWAL_DUNNING_CRON,
      run: async ({ at }) => {
        const report = await this.sweep(at);
        if (report.renewalsInitiated > 0 || report.gracePaused > 0) {
          this.logger.log(report, "renewal initiation and dunning swept");
        }
      },
    });
  }

  async sweep(now: Date = new Date()): Promise<RenewalDunningReport> {
    const due = await this.prisma.subscription.findMany({
      where: {
        renewalInitiateAt: { lte: now },
        status: { in: ["active", "past_due", "trialing"] },
        currentPeriodEnd: { gt: now },
      },
      select: { id: true },
      take: BATCH,
    });
    for (const subscription of due) {
      await this.renewal.initiateRenewal(subscription.id);
    }

    const gracePaused = await this.renewal.graceExpiry(now);
    return { renewalsInitiated: due.length, gracePaused };
  }
}
