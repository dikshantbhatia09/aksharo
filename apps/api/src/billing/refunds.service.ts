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
  | { readonly outcome: "clawed_back"; readonly revokedTenths: number }
  | {
      readonly outcome: "manual_action_required";
      readonly revokedTenths: number;
      readonly shortfallTenths: number;
    };

/**
 * Credits clawback for a refunded pass/top-up purchase (B01b: "on
 * `payment.refunded` and on refund via the admin/API path, claw back the
 * credits granted by that payment"; B01d: switched onto B02b's
 * `CreditsFacade.revokeLot`).
 *
 * B01b/B01c called `LedgerCreditsFacade.reverse()` here, which was the wrong
 * primitive — built to refund a **settled job** (04 §Refunds & cancellation's
 * "a settled job with a bad artefact gets a reversal lot"), keyed on a
 * `credit_holds` row with a hard FK to `jobs.id`, and it **adds** tenths back
 * rather than subtracting them. A pass/top-up purchase's credits are granted
 * through `CreditsFacade.grantLot()` (`webhooks.service.ts`'s `grantPass`),
 * which creates only a `credit_lots` row — no job, no hold, ever — so
 * `reverse()` always threw `credits/reversal_source_not_found` here. See
 * B02's `credits/README.md` for `revokeLot` itself and the history of this
 * decision.
 *
 * `revokeLot({lotId, tenths?, reason, refundId})` is the right shape: keyed
 * on the **lot**, not a job, and it **subtracts** — never more than the lot
 * still has remaining, reporting the gap as `shortfallTenths` when a
 * customer already spent some of what is being refunded (credits already
 * spent are not recoverable this way; that gap is what needs a human, not a
 * ledger correction). It is also idempotent per `refundId` on the ledger's
 * own side (a partial unique index on `credit_ledger`), on top of this
 * service's own `passes_purchased.refunded_at` compare-and-swap.
 *
 * `manual_action_required` now means exactly one thing: `shortfallTenths >
 * 0` — some of what was refunded in money had already been spent in
 * credits, and a human needs to see that gap. It no longer means "the
 * primitive doesn't apply" (B01c's meaning), because now it does.
 *
 * Still calling {@link LedgerCreditsFacade} as a concrete class rather than
 * through the frozen `CREDITS_FACADE` token — `webhooks.service.ts`'s
 * `grantPass` and this file's admin path both need the real ledger
 * regardless of which implementation a test harness binds the token to
 * (`test/billing-harness.ts` binds it to `NoopCreditsFacade` for billing's
 * *own* mechanics — checkout, mandates, dunning — which is unrelated to
 * whether a clawback actually moves money).
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
    // eslint-disable-next-line security/detect-possible-timing-attacks -- sentinel comparison (null/undefined/boolean/empty-string), not a secret/MAC comparison -- reviewed for the same follow-up
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
        ...("shortfallTenths" in clawback ? { shortfallTenths: clawback.shortfallTenths } : {}),
      },
    });

    return { outcome: clawback.outcome, providerRefundId: refund.providerRefundId };
  }

  /**
   * Claw back the credits one pass/top-up purchase granted. Idempotent per
   * `passPurchaseId`: a second call (webhook replay, or a repeated admin
   * action) is a no-op, proven by the `updateMany` compare-and-swap on
   * `refunded_at` running before anything else — and, on top of that,
   * `revokeLot` itself is idempotent per `refundId` on the ledger side, so a
   * process crash between the two writes still cannot double-revoke.
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
      const { revokedTenths, shortfallTenths } = await this.ledger.revokeLot({
        lotId: pass.lotId,
        tenths: pass.creditsGrantedTenths,
        reason,
        // Makes the ledger's own idempotency keyed on this purchase, one
        // refund per purchase — the same identity `passPurchaseId` already
        // gives the compare-and-swap above.
        refundId: pass.id,
      });

      if (shortfallTenths > 0) {
        // Some of what was refunded in money had already been spent in
        // credits — not recoverable through the ledger, and a human needs
        // to see it (04 §Refunds & cancellation has no "partial credit
        // refund" concept; this is the operational escape hatch for it).
        this.logger.warn(
          { passPurchaseId, lotId: pass.lotId, revokedTenths, shortfallTenths },
          "credits clawback partial: some tenths were already spent",
        );
        await this.audit.record({
          action: B01_AUDIT_ACTIONS.creditsClawbackUnavailable,
          resource: "pass_purchase",
          resourceId: pass.id,
          workspaceId: pass.workspaceId,
          data: {
            reason: "shortfall",
            lotId: pass.lotId,
            revokedTenths,
            shortfallTenths,
            note: "Some tenths were already spent and could not be revoked; needs manual review.",
          },
        });
        return { outcome: "manual_action_required", revokedTenths, shortfallTenths };
      }

      await this.audit.record({
        action: B01_AUDIT_ACTIONS.creditsClawedBack,
        resource: "pass_purchase",
        resourceId: pass.id,
        workspaceId: pass.workspaceId,
        data: { lotId: pass.lotId, revokedTenths },
      });
      return { outcome: "clawed_back", revokedTenths };
    } catch (error) {
      if (error instanceof AppException && error.code === CREDIT_ERROR_CODES.lotNotFound) {
        // Defensive only: `grantPass` populates `passes_purchased.lot_id`
        // from the very `grantLot()` call that created it, so this should
        // not be reachable in practice. Treated the same as a shortfall —
        // nothing to revoke, a human should look.
        this.logger.warn(
          { passPurchaseId, lotId: pass.lotId },
          "credits clawback: the recorded lot no longer exists",
        );
        await this.audit.record({
          action: B01_AUDIT_ACTIONS.creditsClawbackUnavailable,
          resource: "pass_purchase",
          resourceId: pass.id,
          workspaceId: pass.workspaceId,
          data: { reason: "lot_not_found", lotId: pass.lotId },
        });
        return {
          outcome: "manual_action_required",
          revokedTenths: 0,
          shortfallTenths: pass.creditsGrantedTenths,
        };
      }
      throw error;
    }
  }
}
