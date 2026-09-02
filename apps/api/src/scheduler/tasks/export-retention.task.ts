import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { DERIVED_STORE } from "../../common/storage/index.js";

import type { ObjectStore } from "../../common/storage/index.js";

export const EXPORT_RETENTION_TASK = "scheduler.export-retention";

/** Hourly (06-data-model.md §Retention jobs: "expire exports and manifests"). */
const EXPORT_RETENTION_CRON = "10 * * * *";
const BATCH = 500;

export interface ExportRetentionReport {
  readonly exportsExpired: number;
  readonly manifestsExpired: number;
}

/**
 * `exports` live 7 days and `export_manifests` are single-use, short-lived
 * replay-protection rows (CONTRACTS §6, A21) — this expires both.
 *
 * An export past `expiresAt` has its R2 object deleted and `storageKey`
 * nulled, exactly the "delete then mark" order `RetentionService.purgeDueMedia`
 * uses, for the same crash-safety reason: an interrupted sweep must retry a
 * delete, never silently strand a paid-for object. The `exports` row itself is
 * kept (usage history, `asset_usages` FKs into it); only the bytes go.
 *
 * A manifest past `expiresAt` is deleted outright — it is the signed
 * render-manifest audit trail A21 wrote for one browser or cloud render, and
 * once that render has either completed (the `exports` row now carries the
 * real audit) or the nonce has simply expired unused, the manifest row itself
 * has no further purpose. `consumedAt` is not checked: a manifest that was
 * never consumed and a manifest that was are both safe to drop once expired.
 */
@Injectable()
export class ExportRetentionTask implements OnModuleInit {
  private readonly logger = new Logger(ExportRetentionTask.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: EXPORT_RETENTION_TASK,
      cron: EXPORT_RETENTION_CRON,
      run: async ({ at }) => {
        const report = await this.sweep(at);
        if (report.exportsExpired > 0 || report.manifestsExpired > 0) {
          this.logger.log(report, "export retention swept");
        }
      },
    });
  }

  async sweep(now: Date = new Date()): Promise<ExportRetentionReport> {
    const exportsExpired = await this.expireExports(now);
    const { count: manifestsExpired } = await this.prisma.exportManifest.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    return { exportsExpired, manifestsExpired };
  }

  private async expireExports(now: Date): Promise<number> {
    const due = await this.prisma.export.findMany({
      where: { expiresAt: { lte: now }, storageKey: { not: null } },
      select: { id: true, storageKey: true },
      take: BATCH,
    });
    let count = 0;
    for (const row of due) {
      if (row.storageKey === null) continue;
      try {
        await this.derived.delete(row.storageKey);
        await this.prisma.export.update({ where: { id: row.id }, data: { storageKey: null } });
        count += 1;
      } catch (error) {
        this.logger.warn(
          { exportId: row.id, err: error instanceof Error ? error.message : String(error) },
          "export object not purged; will retry",
        );
      }
    }
    return count;
  }
}
