import { Injectable } from "@nestjs/common";

import { PrismaService } from "../../common/index.js";

import type { StreakCohortMetrics } from "./admin-streak.dto.js";

const WEEK4_MS = 28 * 24 * 60 * 60 * 1_000;

/**
 * `/admin/metrics/streak` (B06 brief §5): week-4 retention and export
 * frequency, experiment vs holdout — "measured against the holdout before it
 * leaves the flag" (04 §Streak rewards).
 */
@Injectable()
export class AdminStreakService {
  constructor(private readonly prisma: PrismaService) {}

  async cohortMetrics(now: Date = new Date()): Promise<StreakCohortMetrics> {
    const rows = await this.prisma.streakExperiment.findMany({
      select: { workspaceId: true, holdout: true, createdAt: true, paused: true },
    });

    const experiment = rows.filter((row) => !row.holdout);
    const holdout = rows.filter((row) => row.holdout);

    return {
      experiment: await this.cohort(experiment, now),
      holdout: await this.cohort(holdout, now),
      generatedAt: now.toISOString(),
    };
  }

  private async cohort(
    rows: { readonly workspaceId: string; readonly createdAt: Date; readonly paused: boolean }[],
    now: Date,
  ): Promise<{ workspaces: number; week4RetentionPct: number; avgExportsPerWeek: number }> {
    if (rows.length === 0) {
      return { workspaces: 0, week4RetentionPct: 0, avgExportsPerWeek: 0 };
    }

    // Retention: of the workspaces assigned at least 4 weeks ago, how many
    // still have a publish event in the week ending now (a live, active
    // workspace rather than one that churned).
    const eligibleForRetention = rows.filter(
      (row) => now.getTime() - row.createdAt.getTime() >= WEEK4_MS,
    );
    let retained = 0;
    let totalPublishEvents = 0;
    let totalWeeksTracked = 0;

    for (const row of rows) {
      const weeksTracked = Math.max(
        1,
        Math.floor((now.getTime() - row.createdAt.getTime()) / (7 * 24 * 60 * 60 * 1_000)),
      );
      const events = await this.prisma.publishEvent.count({
        where: { workspaceId: row.workspaceId, at: { gte: row.createdAt, lte: now } },
      });
      totalPublishEvents += events;
      totalWeeksTracked += weeksTracked;

      if (eligibleForRetention.includes(row)) {
        const recentEvents = await this.prisma.publishEvent.count({
          where: {
            workspaceId: row.workspaceId,
            at: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000), lte: now },
          },
        });
        if (recentEvents > 0) retained += 1;
      }
    }

    const week4RetentionPct =
      eligibleForRetention.length === 0 ? 0 : (retained / eligibleForRetention.length) * 100;
    const avgExportsPerWeek = totalWeeksTracked === 0 ? 0 : totalPublishEvents / totalWeeksTracked;

    return {
      workspaces: rows.length,
      week4RetentionPct: Math.round(week4RetentionPct * 100) / 100,
      avgExportsPerWeek: Math.round(avgExportsPerWeek * 100) / 100,
    };
  }
}
