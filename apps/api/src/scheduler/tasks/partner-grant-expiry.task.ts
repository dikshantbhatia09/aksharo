import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

export const PARTNER_GRANT_EXPIRY_TASK = "scheduler.partner-grant-expiry";

/** Hourly — same cadence `device-code-expiry.task.ts` uses for a TTL sweep. */
const PARTNER_GRANT_EXPIRY_CRON = "20 * * * *";
const BATCH = 500;

export interface PartnerGrantExpiryReport {
  readonly expired: number;
}

/**
 * D04b (brief §3: "grants expire per contract term"): a safelisting grant
 * (`asset_clearance_grants`, D04b's `providerLicenceId`/`useContext`/
 * `licenceSnapshot` columns) past its `expiresAt` is marked `expired` rather
 * than deleted — the row (and its TODO(H-28) licence snapshot) stays the
 * audit trail for whatever usage it already reported, exactly like
 * `AssetClearanceGrant`'s existing `revoked` status. Idempotent: a grant
 * already `expired`, `revoked`, or with no `expiresAt` at all is left alone
 * on every rerun, so the count only ever reflects genuinely-new expiries.
 */
@Injectable()
export class PartnerGrantExpiryTask implements OnModuleInit {
  private readonly logger = new Logger(PartnerGrantExpiryTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: PARTNER_GRANT_EXPIRY_TASK,
      cron: PARTNER_GRANT_EXPIRY_CRON,
      run: async ({ at }) => {
        const report = await this.sweep(at);
        if (report.expired > 0) {
          this.logger.log(report, "partner catalogue grants expired");
        }
      },
    });
  }

  /** `at` is the fake-clock hook: tests pass a fixed instant instead of `new Date()`. */
  async sweep(at: Date = new Date()): Promise<PartnerGrantExpiryReport> {
    const due = await this.prisma.assetClearanceGrant.findMany({
      where: { status: "active", expiresAt: { not: null, lte: at } },
      select: { id: true },
      take: BATCH,
    });
    if (due.length === 0) return { expired: 0 };

    const result = await this.prisma.assetClearanceGrant.updateMany({
      where: { id: { in: due.map((row) => row.id) } },
      data: { status: "expired" },
    });
    return { expired: result.count };
  }
}
