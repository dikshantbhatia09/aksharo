import { Injectable, Logger } from "@nestjs/common";

import { isBurstSignup, isRefundRatioExceeded } from "./fraud.js";
import { PrismaService } from "../common/index.js";
import { AuditService } from "../users/audit.service.js";

const BURST_LOOKBACK_HOURS = 24;

/**
 * Automated fraud flags (brief §7, THREAT-MODEL T17): burst sign-ups from one
 * IP/device, and a refund ratio over 30% of an affiliate's referrals, both
 * move the affiliate to `suspended_review` for manual review (B13 owns the
 * review queue UI; this service is the data those admin endpoints read).
 */
@Injectable()
export class FraudService {
  private readonly logger = new Logger(FraudService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Called right after a new referral is attributed (brief §7: "burst sign-ups from one IP/device"). */
  async checkBurstSignup(affiliateId: string, ipHash?: string, deviceHash?: string): Promise<void> {
    if (ipHash === undefined && deviceHash === undefined) return;
    const since = new Date(Date.now() - BURST_LOOKBACK_HOURS * 60 * 60 * 1000);
    const signupsFromSameFingerprint = await this.prisma.referral.count({
      where: {
        affiliateId,
        createdAt: { gte: since },
        OR: [
          ...(ipHash === undefined ? [] : [{ ipHash }]),
          ...(deviceHash === undefined ? [] : [{ deviceHash }]),
        ],
      },
    });
    if (isBurstSignup({ signupsFromSameFingerprint })) {
      await this.flag(affiliateId, "burst_signup");
    }
  }

  /** Called after a clawback (brief §7: "refunds > 30% of an affiliate's referrals"). */
  async checkRefundRatio(affiliateId: string): Promise<void> {
    const [totalReferrals, refundedOrClawedBackReferrals] = await Promise.all([
      this.prisma.referral.count({ where: { affiliateId } }),
      this.prisma.referral.count({
        where: { affiliateId, commissions: { some: { status: "clawed_back" } } },
      }),
    ]);
    if (isRefundRatioExceeded({ totalReferrals, refundedOrClawedBackReferrals })) {
      await this.flag(affiliateId, "refund_ratio");
    }
  }

  private async flag(affiliateId: string, reason: string): Promise<void> {
    const affiliate = await this.prisma.affiliate.findUnique({ where: { id: affiliateId } });
    if (affiliate === null || affiliate.status === "suspended_review") return;
    await this.prisma.affiliate.update({
      where: { id: affiliateId },
      data: { status: "suspended_review", fraudFlag: reason },
    });
    this.logger.warn({ affiliateId, reason }, "affiliate flagged for review");
    await this.audit.record({
      action: "affiliate.fraud.flagged",
      resource: "affiliate",
      resourceId: affiliateId,
      data: { reason },
    });
  }
}
