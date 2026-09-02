import { Injectable } from "@nestjs/common";

import { ACTIVE_REFERRALS_FOR_TIER_UPGRADE } from "./commission-schedule.js";
import { PrismaService } from "../common/index.js";
import { fiscalYearFor } from "../invoices/fiscal-year.js";

import type { AffiliateStats } from "./affiliates.dto.js";

/** Dashboard stats (brief §6): clicks, sign-ups, paid, pending, paid out, FY-to-date. */
@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  async forAffiliate(affiliateId: string): Promise<AffiliateStats> {
    const fyLabel = fiscalYearFor(new Date());

    const [
      clicks,
      signups,
      paidReferrals,
      activeReferrals,
      pendingAgg,
      availableAgg,
      paidAgg,
      fyTotal,
      affiliate,
    ] = await Promise.all([
      this.prisma.affiliateClick.count({ where: { affiliateId } }),
      this.prisma.referral.count({ where: { affiliateId } }),
      this.prisma.referral.count({ where: { affiliateId, status: "converted" } }),
      this.prisma.referral.count({ where: { affiliateId, countsTowardTier: true } }),
      this.prisma.commission.aggregate({
        where: { referral: { affiliateId }, status: "pending" },
        _sum: { netPayableMinor: true },
      }),
      this.prisma.commission.aggregate({
        where: { referral: { affiliateId }, status: "payable" },
        _sum: { netPayableMinor: true },
      }),
      this.prisma.payout.aggregate({
        where: { affiliateId, status: "paid" },
        _sum: { amountMinor: true },
      }),
      this.prisma.affiliateFyTotal.findUnique({
        where: { affiliateId_fyLabel: { affiliateId, fyLabel } },
      }),
      this.prisma.affiliate.findUniqueOrThrow({ where: { id: affiliateId } }),
    ]);

    const fyGrossMinor = fyTotal?.grossMinor ?? 0;
    const fyTdsMinor = fyTotal?.tdsMinor ?? 0;

    return {
      clicks,
      signups,
      paidReferrals,
      activeReferrals,
      pendingCommissionMinor: pendingAgg._sum.netPayableMinor ?? 0,
      availableCommissionMinor: availableAgg._sum.netPayableMinor ?? 0,
      paidOutMinor: paidAgg._sum.amountMinor ?? 0,
      fyLabel,
      fyGrossMinor,
      fyTdsMinor,
      fyNetMinor: fyGrossMinor - fyTdsMinor,
      tier: affiliate.tier,
      activeReferralsForTierUpgrade: ACTIVE_REFERRALS_FOR_TIER_UPGRADE,
    };
  }
}
