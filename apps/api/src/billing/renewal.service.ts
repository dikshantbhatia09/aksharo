import { Inject, Injectable, Logger } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { B01_AUDIT_ACTIONS } from "./billing.constants.js";
import { classifyDecline } from "./dunning.js";
import { BILLING_PROVIDER, type BillingProvider } from "./provider.js";
import { PrismaService } from "../common/index.js";
import { ENV } from "../config/config.module.js";
import { NotifyService } from "../notify/notify.service.js";
import { AuditService } from "../users/audit.service.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { $Enums } from "@prisma/client";

/**
 * Renewal and dunning **primitives** (B01 brief §7). Scheduler wiring — when
 * `initiateRenewal`/`graceExpiry` actually run — is B16's (`common/scheduler`);
 * this service only has to be correct when called, and idempotent when called
 * twice for the same subscription (a scheduler is at-least-once by
 * construction, same as every BullMQ consumer in this codebase).
 */
@Injectable()
export class RenewalService {
  private readonly logger = new Logger(RenewalService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly notify: NotifyService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Send the pre-debit notice ≥ 24h before the scheduled charge (D40, RBI
   * e-mandate framework B2). The charge itself is Razorpay's own — it
   * auto-debits a registered mandate on schedule and the result arrives as
   * `subscription.charged`/`payment.failed`; this method never calls
   * `chargeRenewal` itself, only `handleDecline`'s retry step does, because a
   * provider that already auto-charges must not also be told to charge again.
   *
   * A `cancelAtPeriodEnd` subscription (including every `once`/`card_once`
   * one-time purchase) still gets the notice — 04 §Offers promises pay-once
   * users "a reminder before expiry" — it is just informational: nothing bills
   * automatically, `renewsOn` reads as "expires on".
   */
  async initiateRenewal(subscriptionId: string): Promise<void> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        plan: { select: { name: true } },
        workspace: {
          include: { owner: { select: { id: true, email: true, name: true, locale: true } } },
        },
      },
    });
    if (subscription === null) return;
    if (!["active", "past_due", "trialing"].includes(subscription.status)) return;

    const owner = subscription.workspace.owner;
    const amount = formatMinor(subscription.listPriceMinor, subscription.currency);
    const link = new URL("/settings/billing", this.env.WEB_ORIGIN).toString();

    await this.notify.enqueue({
      kind: "renewal-notice",
      to: owner.email,
      locale: owner.locale,
      userId: owner.id,
      workspaceId: subscription.workspaceId,
      data: {
        plan: subscription.plan.name,
        amount,
        renewsOn: subscription.currentPeriodEnd.toISOString().slice(0, 10),
        days: daysUntil(subscription.currentPeriodEnd),
        link,
        name: owner.name ?? owner.email,
      },
      // At most one notice per subscription per period — a scheduler re-run
      // before the next tick must not resend it.
      idempotencyKey: `renewal-notice-${subscriptionId}-${subscription.currentPeriodEnd.toISOString()}`,
    });

    if (subscription.mandateId !== null) {
      await this.prisma.mandate.update({
        where: { id: subscription.mandateId },
        data: { lastNotificationAt: new Date() },
      });
    }

    await this.audit.record({
      action: B01_AUDIT_ACTIONS.renewalInitiated,
      resource: "subscription",
      resourceId: subscriptionId,
      workspaceId: subscription.workspaceId,
      data: { renewsOn: subscription.currentPeriodEnd.toISOString() },
    });
  }

  /**
   * One rung of the dunning ladder for a declined renewal (B01 brief §7):
   * classify the code, retry a bounded number of times, and stop offering a
   * fallback (card/eNACH/pay-once — the same three names as the checkout
   * `mandate_cap_exceeded` alternatives) once the ladder is exhausted.
   *
   * `attemptNo` comes from how many payment rows this subscription already has
   * for provider-side retries; the caller (the webhook handler, or a scheduled
   * retry) does not have to track it itself.
   */
  async handleDecline(subscriptionId: string, declineCode: string | undefined): Promise<void> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
    });
    if (subscription === null) return;

    const attemptNo = await this.prisma.payment.count({
      where: { mandateId: subscription.mandateId, status: "failed" },
    });
    const step = classifyDecline(declineCode, attemptNo);

    await this.audit.record({
      action: B01_AUDIT_ACTIONS.dunningStepped,
      resource: "subscription",
      resourceId: subscriptionId,
      workspaceId: subscription.workspaceId,
      data: {
        declineCode: declineCode ?? null,
        bucket: step.bucket,
        action: step.action,
        exhausted: step.exhausted,
      },
    });

    if (step.action !== "retry" || subscription.providerSubId === null) return;

    try {
      await this.provider.chargeRenewal({
        providerSubscriptionId: subscription.providerSubId,
        amountMinor: subscription.listPriceMinor,
        currency: subscription.currency,
      });
    } catch (error) {
      // `RazorpayProvider.chargeRenewal` is deliberately unimplemented against
      // the live API in this work package (README open questions) — a manual
      // retry there is logged, not fatal; the provider's own auto-retry (if
      // any) or the next scheduled dunning step still applies.
      this.logger.warn(
        { subscriptionId, err: error instanceof Error ? error.message : String(error) },
        "manual renewal retry could not be completed",
      );
    }
  }

  /**
   * 3-day entitlement grace expiry (D40, invariant 7): every `past_due`
   * subscription whose `graceUntil` has passed loses entitlement — `paused`,
   * not `cancelled`, because a mandate re-authenticated after this point should
   * still resume the same subscription rather than force a fresh checkout.
   * Returns how many it touched, for the scheduler's own log line.
   */
  async graceExpiry(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.subscription.findMany({
      where: { status: "past_due", graceUntil: { lt: now } },
      select: { id: true, workspaceId: true },
    });

    for (const subscription of due) {
      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: "paused", pausedUntil: null },
      });
      await this.entitlements.invalidate(subscription.workspaceId);
      await this.audit.record({
        action: B01_AUDIT_ACTIONS.subscriptionPaused,
        resource: "subscription",
        resourceId: subscription.id,
        workspaceId: subscription.workspaceId,
        data: { reason: "grace_expired" },
      });
    }
    return due.length;
  }
}

function daysUntil(date: Date, from: Date = new Date()): number {
  return Math.max(0, Math.ceil((date.getTime() - from.getTime()) / (24 * 60 * 60 * 1_000)));
}

function formatMinor(amountMinor: number, currency: $Enums.Currency): string {
  const major = amountMinor / 100;
  return currency === "INR"
    ? `₹${major.toLocaleString("en-IN")}`
    : `$${major.toLocaleString("en-US")}`;
}
