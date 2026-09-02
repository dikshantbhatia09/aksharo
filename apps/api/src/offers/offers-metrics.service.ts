import { Injectable } from "@nestjs/common";

import {
  NINE_PASS_HYPOTHESIS_WINDOW_DAYS,
  NINE_PASS_KEEP_THRESHOLD,
  NINE_PASS_REPLACE_MIN_BUYERS,
  NINE_PASS_REPLACE_THRESHOLD,
} from "./offers.constants.js";
import { PrismaService } from "../common/prisma/prisma.service.js";

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

export interface NinePassPurchaseEvent {
  readonly workspaceId: string;
  readonly purchasedAt: string;
  readonly upgradedAt: string | null;
}

export type NinePassHypothesisRecommendation = "keep" | "replace" | "monitor";

export interface NinePassHypothesisMetrics {
  readonly windowDays: number;
  readonly totalPurchases: number;
  readonly upgradedWithinWindow: number;
  /** `upgradedWithinWindow / totalPurchases`, `0` with no purchases yet. */
  readonly conversionRate: number;
  readonly thresholds: {
    readonly keepAtOrAbove: number;
    readonly replaceBelow: number;
    readonly replaceAfterBuyers: number;
  };
  readonly recommendation: NinePassHypothesisRecommendation;
  /** Newest first, capped so the admin view stays readable. */
  readonly events: readonly NinePassPurchaseEvent[];
}

/**
 * Instrumentation for the ₹9 hypothesis (D55, `04 §Offers`, orchestrator
 * addendum): "keep if ≥ 10% of buyers reach a paid plan within 60 days;
 * replace with a ₹49 three-export pack if < 6% after 500 buyers."
 *
 * Derives both event kinds from tables B01/B04 already write rather than a
 * separate event log: a "purchase" is a `first_export` `passes_purchased` row
 * once `billing/webhooks.service.ts#grantPass` has stamped it paid
 * (`consumedAt`); an "upgrade" is that same workspace's earliest paid
 * `subscriptions` row (`plan.key != 'free'`, actually activated — `pending`
 * excluded) landing within {@link NINE_PASS_HYPOTHESIS_WINDOW_DAYS} of the
 * purchase. `GET /admin/metrics/offers` (`admin-offers.controller.ts`) is the
 * only reader.
 */
@Injectable()
export class OffersMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async ninePassHypothesis(): Promise<NinePassHypothesisMetrics> {
    const purchases = await this.prisma.passPurchase.findMany({
      where: { kind: "first_export", consumedAt: { not: null } },
      select: { workspaceId: true, consumedAt: true },
      orderBy: { consumedAt: "desc" },
    });

    const events: NinePassPurchaseEvent[] = [];
    let upgradedWithinWindow = 0;

    for (const purchase of purchases) {
      const purchasedAt = purchase.consumedAt;
      if (purchasedAt === null) continue; // narrowed by the query, kept for TS

      const windowEnd = new Date(
        purchasedAt.getTime() + NINE_PASS_HYPOTHESIS_WINDOW_DAYS * MS_PER_DAY,
      );
      const upgrade = await this.prisma.subscription.findFirst({
        where: {
          workspaceId: purchase.workspaceId,
          status: { not: "pending" },
          currentPeriodStart: { gte: purchasedAt, lte: windowEnd },
          plan: { key: { not: "free" } },
        },
        orderBy: { currentPeriodStart: "asc" },
        select: { currentPeriodStart: true },
      });

      if (upgrade !== null) upgradedWithinWindow += 1;
      events.push({
        workspaceId: purchase.workspaceId,
        purchasedAt: purchasedAt.toISOString(),
        upgradedAt: upgrade?.currentPeriodStart.toISOString() ?? null,
      });
    }

    const totalPurchases = purchases.length;
    const conversionRate = totalPurchases === 0 ? 0 : upgradedWithinWindow / totalPurchases;

    let recommendation: NinePassHypothesisRecommendation = "monitor";
    if (
      totalPurchases >= NINE_PASS_REPLACE_MIN_BUYERS &&
      conversionRate < NINE_PASS_REPLACE_THRESHOLD
    ) {
      recommendation = "replace";
    } else if (conversionRate >= NINE_PASS_KEEP_THRESHOLD) {
      recommendation = "keep";
    }

    return {
      windowDays: NINE_PASS_HYPOTHESIS_WINDOW_DAYS,
      totalPurchases,
      upgradedWithinWindow,
      conversionRate,
      thresholds: {
        keepAtOrAbove: NINE_PASS_KEEP_THRESHOLD,
        replaceBelow: NINE_PASS_REPLACE_THRESHOLD,
        replaceAfterBuyers: NINE_PASS_REPLACE_MIN_BUYERS,
      },
      recommendation,
      events: events.slice(0, 500),
    };
  }
}
