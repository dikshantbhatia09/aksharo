import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { CommonAuditService } from "../../common/audit/audit.service.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { NotifyService } from "../../notify/notify.service.js";

export const PROJECT_RETENTION_TASK = "scheduler.project-retention";

/** Daily (06-data-model.md §Retention jobs: project retention warnings and purges). */
const PROJECT_RETENTION_CRON = "20 2 * * *";

const DAY_MS = 24 * 60 * 60 * 1_000;
/** D47: the plan-retention warning fires 14 days before `retentionUntil`. */
const WARNING_LEAD_DAYS = 14;
const RETENTION_BATCH = 500;

export interface ProjectRetentionReport {
  readonly warned: number;
  readonly purged: number;
}

/**
 * Project-level retention (D47), the half of the plan window `RetentionService`
 * does not cover: a project's own `retention_until`, not any one media row's
 * `derived_purge_at`.
 *
 * **Warning.** Every project whose `retentionUntil` falls in the 24 h bucket
 * exactly {@link WARNING_LEAD_DAYS} days out gets one `retention-warning`
 * email, deduplicated by `NotifyService`'s `idempotencyKey` (keyed on the
 * project and its exact `retentionUntil`) rather than a written flag — a
 * schedule that ticks twice for the same bucket must not double-send.
 *
 * **Purge.** A project whose `retentionUntil` has passed is soft-deleted
 * (`deletedAt`, `status: archived` — the same shape `ProjectsService.softDelete`
 * writes) and every one of its still-live media rows has its `rawPurgeAt` and
 * `derivedPurgeAt` pulled forward to now, **if** later than now — a row already
 * due sooner is left alone. The objects themselves are not touched here:
 * `MediaRetentionTask`'s next tick is what deletes bytes, exactly as
 * `media/retention.service.ts`'s own doc comment describes for every other
 * caller of `purgeDueMedia()`. This keeps one place ownin object deletes.
 */
@Injectable()
export class ProjectRetentionTask implements OnModuleInit {
  private readonly logger = new Logger(ProjectRetentionTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotifyService,
    private readonly audit: CommonAuditService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: PROJECT_RETENTION_TASK,
      cron: PROJECT_RETENTION_CRON,
      run: async ({ at }) => {
        const report = await this.sweep(at);
        if (report.warned > 0 || report.purged > 0) {
          this.logger.log(report, "project retention swept");
        }
      },
    });
  }

  async sweep(now: Date = new Date()): Promise<ProjectRetentionReport> {
    const warned = await this.warn(now);
    const purged = await this.purge(now);
    return { warned, purged };
  }

  private async warn(now: Date): Promise<number> {
    const windowStart = new Date(now.getTime() + (WARNING_LEAD_DAYS - 1) * DAY_MS);
    const windowEnd = new Date(now.getTime() + WARNING_LEAD_DAYS * DAY_MS);

    const due = await this.prisma.project.findMany({
      where: {
        deletedAt: null,
        retentionUntil: { gte: windowStart, lt: windowEnd },
      },
      select: {
        id: true,
        title: true,
        retentionUntil: true,
        workspaceId: true,
        workspace: {
          select: { owner: { select: { id: true, email: true, name: true, locale: true } } },
        },
      },
      take: RETENTION_BATCH,
    });

    for (const project of due) {
      if (project.retentionUntil === null) continue;
      const owner = project.workspace.owner;
      await this.notify.enqueue({
        kind: "retention-warning",
        to: owner.email,
        locale: owner.locale,
        userId: owner.id,
        workspaceId: project.workspaceId,
        data: {
          name: owner.name ?? owner.email,
          projectTitle: project.title,
          retentionUntil: project.retentionUntil.toISOString().slice(0, 10),
          days: WARNING_LEAD_DAYS,
        },
        idempotencyKey: `retention-warning-${project.id}-${project.retentionUntil.toISOString()}`,
      });
    }
    return due.length;
  }

  private async purge(now: Date): Promise<number> {
    const due = await this.prisma.project.findMany({
      where: { deletedAt: null, retentionUntil: { lte: now } },
      select: { id: true, workspaceId: true },
      take: RETENTION_BATCH,
    });
    if (due.length === 0) return 0;

    for (const project of due) {
      await this.prisma.$transaction([
        this.prisma.project.update({
          where: { id: project.id },
          data: { deletedAt: now, status: "archived" },
        }),
        this.prisma.mediaAsset.updateMany({
          where: {
            projectId: project.id,
            rawPurgedAt: null,
            OR: [{ rawPurgeAt: null }, { rawPurgeAt: { gt: now } }],
          },
          data: { rawPurgeAt: now },
        }),
        this.prisma.mediaAsset.updateMany({
          where: {
            projectId: project.id,
            derivedPurgedAt: null,
            OR: [{ derivedPurgeAt: null }, { derivedPurgeAt: { gt: now } }],
          },
          data: { derivedPurgeAt: now },
        }),
      ]);
      await this.audit.record({
        action: "project.retention.purged",
        resource: "project",
        resourceId: project.id,
        actorKind: "system",
        workspaceId: project.workspaceId,
        data: { reason: "retention_until_passed" },
      });
    }
    return due.length;
  }
}
