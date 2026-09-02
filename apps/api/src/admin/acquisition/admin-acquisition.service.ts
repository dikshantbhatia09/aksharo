import { Injectable } from "@nestjs/common";

import { PrismaService } from "../../common/index.js";

import type { AcquisitionMetrics } from "./admin-acquisition.dto.js";

const DEFAULT_WINDOW_DAYS = 30;

/**
 * `/admin/metrics/acquisition` — aggregate stub over `product_events`
 * (B17 brief §2, `13-launch-plan.md` instrumentation). "Stub" because it is
 * the minimal grouping the launch dashboard needs (onboarding completions by
 * source and by code type over a trailing window); a richer funnel is
 * B13's admin console.
 */
@Injectable()
export class AdminAcquisitionService {
  constructor(private readonly prisma: PrismaService) {}

  async metrics(windowDays: number = DEFAULT_WINDOW_DAYS): Promise<AcquisitionMetrics> {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1_000);
    const rows = await this.prisma.productEvent.findMany({
      where: { kind: "onboarding_completed", createdAt: { gte: since } },
      select: { source: true, codeType: true },
    });

    return {
      windowDays,
      totalOnboardingCompleted: rows.length,
      bySource: countBy(rows.map((row) => row.source ?? "unspecified")),
      byCodeType: countBy(rows.map((row) => row.codeType ?? "none")),
      generatedAt: new Date().toISOString(),
    };
  }
}

function countBy(values: readonly string[]): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}
