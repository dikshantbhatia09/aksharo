import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";

import { B01_AUDIT_ACTIONS, BILLING_ERRORS } from "./billing.constants.js";
import { BILLING_PROVIDER, type BillingProvider } from "./provider.js";
import { AppException, PrismaService } from "../common/index.js";
import { CREDIT_ERROR_CODES } from "../credits/credits.errors.js";
import { LedgerCreditsFacade } from "../credits/ledger-credits.facade.js";
import { AuditService } from "../users/audit.service.js";

import type { RefundPassDto } from "./billing.dto.js";
import type { RequestContextInfo } from "../users/profile.service.js";

export type ClawbackOutcome =
  | { readonly outcome: "already_processed" }
  | { readonly outcome: "nothing_to_claw_back" }
  | { readonly outcome: "clawed_back"; readonly lotIds: readonly string[] }
  | { readonly outcome: "manual_action_required" };

/**
 * Credits clawback for a refunded pass/top-up purchase (B01b follow-up: "on
 * `payment.refunded` and on refund via the admin/API path, claw back the
 * credits granted by that payment").
 *
 * **Read this before changing the call to `LedgerCreditsFacade.reverse()`
 * below.** `reverse()` (`apps/api/src/credits/ledger-credits.facade.ts`) is
 * built to refund a **settled job** — 04 §Refunds & cancellation's "a settled
 * job with a bad artefact gets a reversal lot with the original expiry" — and
 * its precondition is a `credit_holds` row keyed by `jobId` (a hard foreign
 * key to `jobs.id`) to inherit a lot's expiry from. A pass/top-up purchase's
 * credits are granted through `CreditsFacade.grantLot()`
 * (`webhooks.service.ts`'s `grantPass`), which creates **only** a
 * `credit_lots` row — no job, no hold, ever. Calling `reverse()` for a
 * grant-sourced lot therefore always throws
 * `credits/reversal_source_not_found` (`CREDIT_ERROR_CODES.
 * reversalSourceNotFound`); `reverse()` also **adds** tenths back to the
 * balance (compensating a customer for bad work), the opposite direction
 * from "claw back", which needs to **subtract** tenths a refunded payment
 * granted.
 *
 * There is no existing primitive on `CreditsFacade`/`LedgerCreditsFacade`
 * that subtracts a grant-sourced lot's tenths — `grantLot` only ever adds
 * (its `tenths` parameter is asserted non-negative), and `reserve()`/
 * `settle()` require a real `jobs.id` (same hard FK). This is reported as an
 * open conflict in `billing/README.md` "Credits clawback: an open primitive
 * gap" — the fix needs a new method on `LedgerCreditsFacade` (B02's file,
 * outside this work package's boundary), e.g. `revokeLot(lotId, tenths,
 * reason)` or a signed `adjust(workspaceId, deltaTenths, reason)`.
 *
 * Until then, this service does everything that IS correctly its own to do:
 * resolve exactly which lot a refunded purchase granted, guard the whole
 * operation so a replayed webhook or a repeated admin call is a no-op
 * (`passes_purchased.refunded_at`, set with a compare-and-swap `updateMany`),
 * attempt the call the B01b brief asks for, and — because that attempt is
 * expected to fail for every real pass/top-up refund in this codebase today
 * — catch exactly `credits/reversal_source_not_found` and turn it into a
 * clearly labelled, fully detailed `audit_log` row an operator can act on
 * manually, rather than silently doing nothing or crashing the webhook.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerCreditsFacade,
    private readonly audit: AuditService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  /**
   * The admin/API refund path (B01b): a support agent supplies the
   * provider's payment id (this codebase never stores one for a pass/top-up
   * order -- there is no `payments` row for those, see `webhooks.service.ts`'s
   * `onPaymentRefunded`). Calls the provider's refund API, then the same
   * clawback {@link clawbackPassPurchase} the webhook path uses -- so whichever
   * arrives first (the webhook Razorpay sends once the refund settles, or this
   * call) does the work, and the second is a clean no-op.
   */
  async refundPassPurchase(
    workspaceId: string,
    passPurchaseId: string,
    body: RefundPassDto,
    actorId: string,
    context: RequestContextInfo,
  ): Promise<{ readonly outcome: ClawbackOutcome["outcome"]; readonly providerRefundId: string }> {
    const pass = await this.prisma.passPurchase.findFirst({
      where: { id: passPurchaseId, workspaceId },
    });
    if (pass === null) {
      throw new AppException(
        BILLING_ERRORS.passPurchaseNotFound,
        "No such pass purchase.",
        HttpStatus.NOT_FOUND,
      );
    }
    if (pass.refundedAt !== null) {
      throw new AppException(
        BILLING_ERRORS.alreadyRefunded,
        "This purchase has already been refunded.",
        HttpStatus.CONFLICT,
      );
    }

    const refund = await this.provider.refund({
      providerPaymentId: body.providerPaymentId,
      amountMinor: body.amountMinor,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    });

    const clawback = await this.clawbackPassPurchase(
      passPurchaseId,
      body.reason ?? `admin refund (provider payment ${body.providerPaymentId})`,
    );

    await this.audit.record({
      action: B01_AUDIT_ACTIONS.refundIssued,
      resource: "pass_purchase",
      resourceId: passPurchaseId,
      actorId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: {
        providerRefundId: refund.providerRefundId,
        amountMinor: body.amountMinor,
        clawback: clawback.outcome,
      },
    });

    return { outcome: clawback.outcome, providerRefundId: refund.providerRefundId };
  }

  /**
   * Claw back the credits one pass/top-up purchase granted. Idempotent per
   * `passPurchaseId`: a second call (webhook replay, or a repeated admin
   * action) is a no-op, proven by the `updateMany` compare-and-swap on
   * `refunded_at` running before anything else.
   */
  async clawbackPassPurchase(passPurchaseId: string, reason: string): Promise<ClawbackOutcome> {
    const claimed = await this.prisma.passPurchase.updateMany({
      where: { id: passPurchaseId, refundedAt: null },
      data: { refundedAt: new Date() },
    });
    if (claimed.count === 0) {
      this.logger.log({ passPurchaseId }, "credits clawback already processed for this purchase");
      return { outcome: "already_processed" };
    }

    const pass = await this.prisma.passPurchase.findUniqueOrThrow({
      where: { id: passPurchaseId },
    });
    if (pass.lotId === null || pass.creditsGrantedTenths <= 0) {
      await this.audit.record({
        action: B01_AUDIT_ACTIONS.creditsClawbackUnavailable,
        resource: "pass_purchase",
        resourceId: pass.id,
        workspaceId: pass.workspaceId,
        data: { reason: "no_lot_on_file", kind: pass.kind },
      });
      return { outcome: "nothing_to_claw_back" };
    }

    try {
      const result = await this.ledger.reverse({
        workspaceId: pass.workspaceId,
        // No job/hold will ever match a grant-sourced lot — see the class
        // doc comment. Kept as `pass.id` (a ULID, the right shape) rather
        // than a placeholder string, so the failure path below is exercised
        // exactly the way a real call would hit it.
        jobId: pass.id,
        tenths: pass.creditsGrantedTenths,
        reason,
      });
      await this.audit.record({
        action: B01_AUDIT_ACTIONS.creditsClawedBack,
        resource: "pass_purchase",
        resourceId: pass.id,
        workspaceId: pass.workspaceId,
        data: { tenths: pass.creditsGrantedTenths, lotIds: result.lotIds },
      });
      return { outcome: "clawed_back", lotIds: result.lotIds };
    } catch (error) {
      if (
        error instanceof AppException &&
        error.code === CREDIT_ERROR_CODES.reversalSourceNotFound
      ) {
        this.logger.warn(
          { passPurchaseId, lotId: pass.lotId, tenths: pass.creditsGrantedTenths },
          "credits clawback not applicable: no job/hold behind this grant-sourced lot (see billing/README.md)",
        );
        await this.audit.record({
          action: B01_AUDIT_ACTIONS.creditsClawbackUnavailable,
          resource: "pass_purchase",
          resourceId: pass.id,
          workspaceId: pass.workspaceId,
          data: {
            reason: "reverse_requires_job_hold",
            lotId: pass.lotId,
            tenthsOriginallyGranted: pass.creditsGrantedTenths,
            note:
              "CreditsFacade.reverse() requires a credit_holds row keyed by jobId; a grant-sourced " +
              "lot has none. Manual credit_lots adjustment needed until B02 adds a deduct primitive.",
          },
        });
        return { outcome: "manual_action_required" };
      }
      throw error;
    }
  }
}
