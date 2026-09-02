import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { PAYOUT_PROVIDER, type PayoutMethod, type PayoutProvider } from "./payout-provider.js";
import { AppException, PrismaService } from "../../common/index.js";
import { AuditService } from "../../users/audit.service.js";

/** ₹1,000 in paise (brief §5: "minimum ₹1,000 net"). */
export const PAYOUT_MINIMUM_NET_MINOR = 100_000;

export interface PayoutBatchResult {
  readonly payoutsCreated: number;
  readonly skippedBelowMinimum: number;
  readonly totalNetMinor: number;
}

/**
 * Monthly payout batching (brief §5; scheduler wiring is B16's, this work
 * package only implements the task `tasks/payout-batch.task.ts` registers).
 * Matures no commissions itself — `tasks/commission-maturation.task.ts` moves
 * `pending` → `payable` after the 30-day hold; this only sweeps `payable`
 * commissions into payout batches.
 */
@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(PAYOUT_PROVIDER) private readonly provider: PayoutProvider,
  ) {}

  /** Moves matured commissions (`pending`, `availableAt` in the past) to `payable`. Idempotent. */
  async matureCommissions(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.commission.updateMany({
      where: { status: "pending", availableAt: { lte: now } },
      data: { status: "payable" },
    });
    if (result.count > 0)
      this.logger.log({ count: result.count }, "commissions matured to payable");
    return result.count;
  }

  /** One monthly run: batch every approved affiliate's payable, unpaid commissions. */
  async runMonthlyBatch(): Promise<PayoutBatchResult> {
    const affiliates = await this.prisma.affiliate.findMany({
      where: {
        status: "approved",
        referrals: { some: { commissions: { some: { status: "payable", payoutId: null } } } },
      },
    });

    let payoutsCreated = 0;
    let skippedBelowMinimum = 0;
    let totalNetMinor = 0;

    for (const affiliate of affiliates) {
      const commissions = await this.prisma.commission.findMany({
        where: { referral: { affiliateId: affiliate.id }, status: "payable", payoutId: null },
      });
      if (commissions.length === 0) continue;

      const netMinor = commissions.reduce((sum, c) => sum + c.netPayableMinor, 0);
      const tdsMinor = commissions.reduce((sum, c) => sum + c.tdsAmountMinor, 0);
      const netWithBalance = netMinor + affiliate.balanceMinor;

      if (netWithBalance <= 0 || netWithBalance < PAYOUT_MINIMUM_NET_MINOR) {
        skippedBelowMinimum += 1;
        continue;
      }

      const method = affiliate.payoutMethod as unknown as PayoutMethod;
      const idempotencyKey = `payout:${affiliate.id}:${new Date().toISOString().slice(0, 7)}`;
      const providerResult = await this.provider.createPayout({
        affiliateId: affiliate.id,
        amountMinor: netWithBalance,
        currency: "INR",
        method,
        idempotencyKey,
        narration: "Aksharo affiliate commission",
      });

      const payoutStatus =
        providerResult.status === "processed"
          ? "paid"
          : providerResult.status === "failed"
            ? "failed"
            : providerResult.status === "reversed"
              ? "reversed"
              : "processing";

      await this.prisma.$transaction(async (tx) => {
        const payout = await tx.payout.create({
          data: {
            id: ulid(),
            affiliateId: affiliate.id,
            amountMinor: netWithBalance,
            tdsTotalMinor: tdsMinor,
            rail: method.rail,
            providerRef: providerResult.providerRef,
            providerFeeMinor: providerResult.providerFeeMinor,
            status: payoutStatus,
          },
        });
        await tx.commission.updateMany({
          where: { id: { in: commissions.map((c) => c.id) } },
          data: { status: "paid", payoutId: payout.id },
        });
        await tx.affiliate.update({ where: { id: affiliate.id }, data: { balanceMinor: 0 } });
      });

      payoutsCreated += 1;
      totalNetMinor += netWithBalance;
      await this.audit.record({
        action: "affiliate.payout.created",
        resource: "payout",
        resourceId: affiliate.id,
        data: { amountMinor: netWithBalance, tdsMinor, commissions: commissions.length },
      });
    }

    this.logger.log(
      { payoutsCreated, skippedBelowMinimum, totalNetMinor },
      "monthly payout batch complete",
    );
    return { payoutsCreated, skippedBelowMinimum, totalNetMinor };
  }

  async listForAffiliate(affiliateId: string) {
    return this.prisma.payout.findMany({ where: { affiliateId }, orderBy: { at: "desc" } });
  }

  async requireAffiliateId(userId: string): Promise<string> {
    const affiliate = await this.prisma.affiliate.findUnique({ where: { userId } });
    if (affiliate === null) {
      throw new AppException(
        "affiliate/not_found",
        "No affiliate profile for this account.",
        HttpStatus.NOT_FOUND,
      );
    }
    return affiliate.id;
  }
}
