import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { DERIVED_STORE } from "../../common/storage/index.js";
import { notExemptWorkspace, retentionExemptWorkspaceIds } from "../../media/retention-policy.js";

import type { ObjectStore } from "../../common/storage/index.js";

export const EXPORT_RETENTION_TASK = "scheduler.export-retention";

/** How long a shared video outlives the last link sharing it: a guest who opens it on its last day still gets it. */
export const SHARED_VIDEO_GRACE_MS = 24 * 60 * 60 * 1000;

/** Hourly (06-data-model.md §Retention jobs: "expire exports and manifests"). */
const EXPORT_RETENTION_CRON = "10 * * * *";
const BATCH = 500;

export interface ExportRetentionReport {
  readonly exportsExpired: number;
  /** Due, but shared through a live guest or client-review link: kept, with a later `expiresAt`. */
  readonly exportsKeptShared: number;
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
 *
 * **Shared videos are kept (2026-09-30).** A guest link lasts up to 30 days
 * (default 14) and a client review link up to 30, but a render lived 7, so a
 * guest opening their link in its second week found no captioned video. A due
 * export that is a clip shape's current captioned video - or a dubbed shape's -
 * on a run with a live link sharing it gets its `expiresAt` moved to a day after
 * that link ends, instead of being deleted. Moved rather than skipped, so kept
 * rows stop being due and never fill the batch.
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
    const { expired: exportsExpired, keptShared: exportsKeptShared } =
      await this.expireExports(now);
    const { count: manifestsExpired } = await this.prisma.exportManifest.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    return { exportsExpired, exportsKeptShared, manifestsExpired };
  }

  /**
   * The exports among `ids` that a live link shares, each with when it may go:
   * a clip shape's current captioned video on a run whose guest link covers that
   * clip, or whose client review link is live (a review shows the 9:16 only); a
   * dubbed shape's, when a guest link covering the clip includes dubs. A day past
   * the last such link's end.
   */
  async sharedUntil(ids: readonly string[], now: Date): Promise<Map<string, Date>> {
    const result = new Map<string, Date>();
    if (ids.length === 0) return result;
    const [variants, dubVariants] = await Promise.all([
      this.prisma.clipVariant.findMany({
        where: { latestExportId: { in: [...ids] } },
        select: { latestExportId: true, aspect: true, clip: { select: { id: true, runId: true } } },
      }),
      this.prisma.clipDubVariant.findMany({
        where: { latestExportId: { in: [...ids] } },
        select: { latestExportId: true, dub: { select: { clipId: true, runId: true } } },
      }),
    ]);
    const shared = [
      ...variants.flatMap((row) =>
        row.latestExportId === null
          ? []
          : [
              {
                exportId: row.latestExportId,
                runId: row.clip.runId,
                clipId: row.clip.id,
                dubbed: false,
                portrait: row.aspect === "r9x16",
              },
            ],
      ),
      ...dubVariants.flatMap((row) =>
        row.latestExportId === null
          ? []
          : [
              {
                exportId: row.latestExportId,
                runId: row.dub.runId,
                clipId: row.dub.clipId,
                dubbed: true,
                portrait: false,
              },
            ],
      ),
    ];
    if (shared.length === 0) return result;
    const live = {
      runId: { in: [...new Set(shared.map((item) => item.runId))] },
      revokedAt: null,
      expiresAt: { gt: now },
    };
    const [guestLinks, reviewLinks] = await Promise.all([
      this.prisma.clipGuestLink.findMany({
        where: live,
        select: { runId: true, allClips: true, clipIds: true, includeDubs: true, expiresAt: true },
      }),
      this.prisma.clipReviewLink.findMany({
        where: live,
        select: { runId: true, expiresAt: true },
      }),
    ]);
    for (const item of shared) {
      let until = 0;
      for (const link of guestLinks) {
        if (link.runId !== item.runId) continue;
        if (!link.allClips && !link.clipIds.includes(item.clipId)) continue;
        if (item.dubbed && !link.includeDubs) continue;
        until = Math.max(until, link.expiresAt.getTime());
      }
      for (const link of reviewLinks) {
        if (link.runId !== item.runId || !item.portrait) continue;
        until = Math.max(until, link.expiresAt.getTime());
      }
      if (until > 0) result.set(item.exportId, new Date(until + SHARED_VIDEO_GRACE_MS));
    }
    return result;
  }

  private async expireExports(now: Date): Promise<{ expired: number; keptShared: number }> {
    const due = await this.prisma.export.findMany({
      where: {
        expiresAt: { lte: now },
        storageKey: { not: null },
        // The owner's workspace is never swept (retention-policy.ts).
        ...notExemptWorkspace(retentionExemptWorkspaceIds()),
      },
      select: { id: true, storageKey: true },
      take: BATCH,
    });
    const sharedUntil = await this.sharedUntil(
      due.map((row) => row.id),
      now,
    );
    let count = 0;
    let keptShared = 0;
    for (const row of due) {
      if (row.storageKey === null) continue;
      const keepUntil = sharedUntil.get(row.id);
      if (keepUntil !== undefined) {
        await this.prisma.export.update({ where: { id: row.id }, data: { expiresAt: keepUntil } });
        keptShared += 1;
        continue;
      }
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
    return { expired: count, keptShared };
  }
}
