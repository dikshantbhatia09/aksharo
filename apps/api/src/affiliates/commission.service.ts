import { Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { rateForPayment, tierAfterActiveCount, applyRateBps } from "./commission-schedule.js";
import { computeTds } from "./tds.js";
import { PrismaService } from "../common/index.js";
import { fiscalYearFor } from "../invoices/fiscal-year.js";
import { AuditService } from "../users/audit.service.js";

import type { CommissionInterval } from "./commission-schedule.js";
import type { $Enums } from "@prisma/client";

/** 30-day maturation hold (brief §3). */
const MATURATION_DAYS = 30;

/**
 * The commission engine: turns one paid invoice of a referred workspace into
 * (at most) one `commissions` row, applying the rate schedule, the FY TDS
 * accumulator, and the tier switch after 10 active paying referrals (brief
 * §3–4). Invoked from `listeners/invoice-events.listener.ts`, never from the
 * invoices module directly — see `invoice-events.ts`'s doc-comment.
 */
@Injectable()
export class CommissionService {
  private readonly logger = new Logger(CommissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async onInvoiceIssued(input: {
    invoiceId: string;
    workspaceId: string;
    taxableValueMinor: number;
    issuedAt: Date;
  }): Promise<void> {
    const referral = await this.prisma.referral.findUnique({
      where: { referredWorkspaceId: input.workspaceId },
      include: { affiliate: true },
    });
    if (referral === null) return; // not a referred workspace — nothing to do.
    if (referral.status === "rejected") return; // self-referral or otherwise rejected.
    if (referral.affiliate.status !== "approved") return; // suspended affiliates earn nothing (brief acceptance §3).

    const alreadyCommissioned = await this.prisma.commission.findUnique({
      where: { referralId_invoiceId: { referralId: referral.id, invoiceId: input.invoiceId } },
    });
    if (alreadyCommissioned !== null) return; // idempotent against a re-delivered event.

    const invoice = await this.prisma.invoice.findUniqueOrThrow({ where: { id: input.invoiceId } });
    const interval = await this.intervalFor(invoice.subscriptionId);
    if (interval === null) return; // not a subscription payment (pass/top-up) — out of scope.

    const rate = rateForPayment({
      tier: referral.affiliate.tier as "standard" | "while_subscribed_30",
      interval,
      monthlyPaidCountSoFar: referral.monthlyPaidCount,
      yearlyCommissionPaid: referral.yearlyCommissionPaid,
    });
    if (rate.rateBps === null) return; // e.g. a second yearly payment at standard tier.
    const rateBps = rate.rateBps;

    const grossMinor = applyRateBps(input.taxableValueMinor, rateBps);
    const fyLabel = fiscalYearFor(input.issuedAt);

    await this.prisma.$transaction(async (tx) => {
      const fyTotal = await tx.affiliateFyTotal.findUnique({
        where: { affiliateId_fyLabel: { affiliateId: referral.affiliateId, fyLabel } },
      });
      const priorFyGrossMinor = fyTotal?.grossMinor ?? 0;
      const hasVerifiedPan =
        referral.affiliate.pan !== null && referral.affiliate.panVerifiedAt !== null;

      const tds = computeTds({ priorFyGrossMinor, grossMinor, hasVerifiedPan });

      const commission = await tx.commission.create({
        data: {
          id: ulid(),
          referralId: referral.id,
          invoiceId: input.invoiceId,
          grossMinor,
          rate: rateBps,
          fyLabel,
          tdsSection: "s194H",
          tdsRateBps: tds.tdsRateBps,
          tdsAmountMinor: tds.tdsAmountMinor,
          netPayableMinor: tds.netPayableMinor,
          status: "pending",
          availableAt: new Date(input.issuedAt.getTime() + MATURATION_DAYS * 24 * 60 * 60 * 1000),
        },
      });

      await tx.affiliateFyTotal.upsert({
        where: { affiliateId_fyLabel: { affiliateId: referral.affiliateId, fyLabel } },
        create: {
          id: ulid(),
          affiliateId: referral.affiliateId,
          fyLabel,
          grossMinor: tds.newFyGrossMinor,
          tdsMinor: tds.tdsAmountMinor,
        },
        update: {
          grossMinor: tds.newFyGrossMinor,
          tdsMinor: { increment: tds.tdsAmountMinor },
        },
      });

      const monthlyPaidCount = referral.monthlyPaidCount + (rate.incrementsMonthlyCount ? 1 : 0);
      const yearlyCommissionPaid = referral.yearlyCommissionPaid || rate.marksYearlyPaid;
      const countsTowardTier = true;
      await tx.referral.update({
        where: { id: referral.id },
        data: {
          firstPaidAt: referral.firstPaidAt ?? input.issuedAt,
          status: "converted",
          monthlyPaidCount,
          yearlyCommissionPaid,
          countsTowardTier,
        },
      });

      if (!referral.countsTowardTier) {
        const activeCount = await tx.referral.count({
          where: { affiliateId: referral.affiliateId, countsTowardTier: true },
        });
        // +1: this transaction's own update above hasn't necessarily been read
        // back by a fresh count in every driver ordering; count what will be
        // true once this transaction commits.
        const total = activeCount; // the update above is in the same tx, so `count` already reflects it.
        const nextTier = tierAfterActiveCount(
          total,
          referral.affiliate.tier as "standard" | "while_subscribed_30",
        );
        if (nextTier !== referral.affiliate.tier) {
          await tx.affiliate.update({
            where: { id: referral.affiliateId },
            data: { tier: nextTier },
          });
        }
      }

      this.logger.log(
        { referralId: referral.id, commissionId: commission.id, grossMinor, rateBps: rate.rateBps },
        "commission recorded",
      );
    });

    await this.audit.record({
      action: "affiliate.commission.recorded",
      resource: "commission",
      resourceId: input.invoiceId,
      workspaceId: input.workspaceId,
      data: { affiliateId: referral.affiliateId, grossMinor },
    });
  }

  /** Clawback on refund/chargeback (brief §3). Returns the affected affiliate id, if any. */
  async onCreditNoteIssued(input: {
    originalInvoiceId: string;
    refundTaxableValueMinor: number;
  }): Promise<string | null> {
    const commission = await this.prisma.commission.findFirst({
      where: { invoiceId: input.originalInvoiceId, status: { in: ["pending", "payable"] } },
      include: { referral: { include: { affiliate: true } } },
    });
    if (commission === null) return null;

    await this.prisma.$transaction(async (tx) => {
      await tx.commission.update({ where: { id: commission.id }, data: { status: "clawed_back" } });
      await tx.affiliateFyTotal.updateMany({
        where: { affiliateId: commission.referral.affiliateId, fyLabel: commission.fyLabel },
        data: {
          grossMinor: { decrement: commission.grossMinor },
          tdsMinor: { decrement: commission.tdsAmountMinor },
        },
      });
      if (commission.status === "payable" || commission.payoutId !== null) {
        // Already matured/paid: negative reconciliation against the running
        // balance, offset against the affiliate's next payout batch.
        await tx.affiliate.update({
          where: { id: commission.referral.affiliateId },
          data: { balanceMinor: { decrement: commission.netPayableMinor } },
        });
      }
    });

    await this.audit.record({
      action: "affiliate.commission.clawed_back",
      resource: "commission",
      resourceId: commission.id,
      data: { invoiceId: input.originalInvoiceId, grossMinor: commission.grossMinor },
    });
    return commission.referral.affiliateId;
  }

  private async intervalFor(subscriptionId: string | null): Promise<CommissionInterval | null> {
    if (subscriptionId === null) return null;
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: { interval: true },
    });
    return (subscription?.interval as CommissionInterval | undefined) ?? null;
  }
}

export type CommissionStatusEnum = $Enums.CommissionStatus;
