import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

export const DEVICE_CODE_EXPIRY_TASK = "scheduler.device-code-expiry";

/** Hourly (06-data-model.md §Retention jobs: "expire device codes/pairings"). */
const DEVICE_CODE_EXPIRY_CRON = "15 * * * *";

export interface DeviceCodeExpiryReport {
  readonly deviceCodesDeleted: number;
  readonly pairingsDeleted: number;
}

/**
 * `device_codes` (TTL ≤ 10 minutes, CONTRACTS §5) and `bridge_pairings` (12 h
 * tokens, THREAT-MODEL T13) are both transient auth artefacts with no value once
 * expired — unlike a `session`, which is kept revoked-but-present for its
 * refresh-reuse detection, a device code or a bridge pairing past `expiresAt`
 * has nothing left to check it against, so the row is deleted rather than
 * marked.
 *
 * A pairing already `revokedAt` is left for the next pass exactly like an
 * expired one — this task only ever deletes on `expiresAt`, so a revoked-but-
 * not-yet-expired row stays queryable for its own audit trail until then.
 */
@Injectable()
export class DeviceCodeExpiryTask implements OnModuleInit {
  private readonly logger = new Logger(DeviceCodeExpiryTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: DEVICE_CODE_EXPIRY_TASK,
      cron: DEVICE_CODE_EXPIRY_CRON,
      run: async ({ at }) => {
        const report = await this.sweep(at);
        if (report.deviceCodesDeleted > 0 || report.pairingsDeleted > 0) {
          this.logger.log(report, "device codes / bridge pairings expired");
        }
      },
    });
  }

  async sweep(now: Date = new Date()): Promise<DeviceCodeExpiryReport> {
    const [deviceCodes, pairings] = await Promise.all([
      this.prisma.deviceCode.deleteMany({ where: { expiresAt: { lte: now } } }),
      this.prisma.bridgePairing.deleteMany({ where: { expiresAt: { lte: now } } }),
    ]);
    return { deviceCodesDeleted: deviceCodes.count, pairingsDeleted: pairings.count };
  }
}
