import { HttpStatus, Injectable, Logger } from "@nestjs/common";

import { computeRefundPolicy } from "./admin-refund-policy.js";
import { RefundsService } from "../../billing/refunds.service.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { AppException, ERROR_CODES } from "../../common/errors/error-codes.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { InvoicesService } from "../../invoices/invoices.service.js";
import { type AdminPrincipal } from "../admin.guard.js";

import type { AdminDunningEntryDto, AdminRefundDto } from "./admin-billing.dto.js";

export interface AdminRefundOutcome {
  readonly outcome: string;
  readonly providerRefundId: string;
  readonly policy: "full" | "pro_rata";
  readonly requestedAmountMinor: number;
  readonly refundAmountMinor: number;
  readonly creditNoteId?: string;
  readonly creditNoteNumber?: string;
  readonly creditNoteSkippedReason?: string;
}

/**
 * The admin refund + credit note surface (B13 scope §2: "refund + credit
 * note (B01 + B05) with policy checks"). Composes two already-shipped
 * services rather than reimplementing either:
 *
 *  - `RefundsService.refundPassPurchase` (B01b/B01d) — calls the payment
 *    provider's refund API and claws back the credits the purchase granted
 *    (`revokeLot`, full claw-back regardless of the refunded money amount —
 *    that credits/money split is B01's own design, unchanged here).
 *  - `InvoicesService.generateCreditNote` (B05) — the GST-correct credit
 *    note against the purchase's original tax invoice, when one exists.
 *
 * This service's own job is just the policy this WP owns: how much of the
 * original payment is refundable (`admin-refund-policy.ts`), and tying the
 * two calls together with one `audit_log` row that carries the reason code
 * a support/finance report groups by.
 */
@Injectable()
export class AdminBillingService {
  private readonly logger = new Logger(AdminBillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly refunds: RefundsService,
    private readonly invoices: InvoicesService,
    private readonly audit: CommonAuditService,
  ) {}

  /** Read-only mandate/dunning monitor (B13 scope §2). */
  async dunningMonitor(): Promise<AdminDunningEntryDto[]> {
    const subscriptions = await this.prisma.subscription.findMany({
      where: { status: "past_due" },
      orderBy: { graceUntil: "asc" },
    });
    const mandateIds = subscriptions
      .map((s) => s.mandateId)
      .filter((id): id is string => id !== null);
    const mandates =
      mandateIds.length === 0
        ? []
        : await this.prisma.mandate.findMany({ where: { id: { in: mandateIds } } });
    const mandateById = new Map(mandates.map((m) => [m.id, m]));

    return subscriptions.map((sub) => {
      const mandate = sub.mandateId === null ? undefined : mandateById.get(sub.mandateId);
      return {
        subscriptionId: sub.id,
        workspaceId: sub.workspaceId,
        status: sub.status,
        graceUntil: sub.graceUntil?.toISOString() ?? null,
        renewalInitiateAt: sub.renewalInitiateAt?.toISOString() ?? null,
        mandateStatus: mandate?.status ?? null,
        mandateMethod: mandate?.method ?? null,
      };
    });
  }

  async refundPassPurchase(
    passPurchaseId: string,
    body: AdminRefundDto,
    admin: AdminPrincipal,
    ip: string | undefined,
  ): Promise<AdminRefundOutcome> {
    const pass = await this.prisma.passPurchase.findUnique({ where: { id: passPurchaseId } });
    // eslint-disable-next-line security/detect-possible-timing-attacks -- sentinel comparison (null/undefined/boolean/empty-string), not a secret/MAC comparison -- reviewed for the same follow-up
    if (pass === null) {
      throw new AppException(ERROR_CODES.notFound, "No such pass purchase.", HttpStatus.NOT_FOUND);
    }
    if (pass.lotId === null) {
      throw new AppException(
        ERROR_CODES.notFound,
        "This purchase has no credit lot on file; nothing to price a refund against.",
        HttpStatus.CONFLICT,
      );
    }
    const lot = await this.prisma.creditLot.findUnique({ where: { id: pass.lotId } });
    if (lot === null) {
      throw new AppException(
        ERROR_CODES.notFound,
        "The purchase's credit lot no longer exists.",
        HttpStatus.CONFLICT,
      );
    }

    const baseAmountMinor = body.amountMinorOverride ?? lot.amountMinor;
    if (baseAmountMinor === null || baseAmountMinor === undefined) {
      throw new AppException(
        ERROR_CODES.validationFailed,
        "No amount on file for this purchase; pass amountMinorOverride.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const { policy, refundAmountMinor } = computeRefundPolicy({
      purchasedAt: pass.createdAt,
      now: new Date(),
      baseAmountMinor,
      grantedTenths: lot.grantedTenths,
      remainingTenths: lot.remainingTenths,
    });

    if (refundAmountMinor <= 0) {
      throw new AppException(
        ERROR_CODES.validationFailed,
        "The policy-computed refund amount is zero (the credits from this purchase are fully spent).",
        HttpStatus.CONFLICT,
      );
    }

    const refund = await this.refunds.refundPassPurchase(
      pass.workspaceId,
      passPurchaseId,
      {
        providerPaymentId: body.providerPaymentId,
        amountMinor: refundAmountMinor,
        reason: `[${body.reasonCode}] ${body.reason}`,
      },
      admin.userId,
      { ip },
    );

    let creditNoteId: string | undefined;
    let creditNoteNumber: string | undefined;
    let creditNoteSkippedReason: string | undefined;
    const originalInvoice = await this.prisma.invoice.findFirst({
      where: { passPurchaseId, docType: "tax_invoice" },
      orderBy: { issuedAt: "desc" },
    });
    if (originalInvoice === null) {
      creditNoteSkippedReason = "No original tax invoice on file for this purchase.";
      this.logger.warn(
        { passPurchaseId },
        "admin refund: no original invoice, skipping credit note",
      );
    } else {
      try {
        const creditNote = await this.invoices.generateCreditNote({
          originalInvoiceId: originalInvoice.id,
          refundAmountMinor,
          reasonCode: body.reasonCode,
        });
        creditNoteId = creditNote.id;
        creditNoteNumber = creditNote.number;
      } catch (error) {
        creditNoteSkippedReason = "Credit note generation failed; see logs.";
        this.logger.error({ passPurchaseId, error }, "admin refund: credit note generation failed");
      }
    }

    await this.audit.record({
      action: "admin.billing.refund_issued",
      resource: "pass_purchase",
      resourceId: passPurchaseId,
      workspaceId: pass.workspaceId,
      actorId: admin.userId,
      actorKind: "admin",
      ...(ip === undefined ? {} : { ip }),
      data: {
        reasonCode: body.reasonCode,
        reason: body.reason,
        policy,
        requestedAmountMinor: baseAmountMinor,
        refundAmountMinor,
        providerRefundId: refund.providerRefundId,
        clawbackOutcome: refund.outcome,
        creditNoteId: creditNoteId ?? null,
      },
    });

    return {
      outcome: refund.outcome,
      providerRefundId: refund.providerRefundId,
      policy,
      requestedAmountMinor: baseAmountMinor,
      refundAmountMinor,
      ...(creditNoteId === undefined ? {} : { creditNoteId }),
      ...(creditNoteNumber === undefined ? {} : { creditNoteNumber }),
      ...(creditNoteSkippedReason === undefined ? {} : { creditNoteSkippedReason }),
    };
  }
}
