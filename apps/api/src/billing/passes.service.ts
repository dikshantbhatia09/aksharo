import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import {
  B01_AUDIT_ACTIONS,
  BILLING_ERRORS,
  FIRST_EXPORT_PRICE_INR_MINOR,
  TOPUP_TIERS,
  WEEK_PASS,
} from "./billing.constants.js";
import { type PassCheckoutResponse, PassCheckoutDto, TopupCheckoutDto } from "./billing.dto.js";
import { CheckoutService } from "./checkout.service.js";
import { parsePlanPrices } from "./money.js";
import { PlansService } from "./plans.service.js";
import { BILLING_PROVIDER, type BillingProvider } from "./provider.js";
import { AppException, PrismaService } from "../common/index.js";
import { NinePassEligibilityService } from "../offers/nine-pass-eligibility.service.js";
import { AuditService } from "../users/audit.service.js";

import type { RequestContextInfo } from "../users/profile.service.js";
import type { $Enums } from "@prisma/client";

/**
 * `POST /billing/passes/checkout` and `POST /billing/topups/checkout` (B01
 * brief §4): one-time orders that grant credits (and, for `week_pass`, a
 * temporary Starter-equivalent) rather than change the workspace's plan tier.
 *
 * The Razorpay/fake order's `notes` carry the credits and price this checkout
 * quoted, because `passes_purchased` has no `amountMinor`/`currency` columns
 * (06 does not give it any — see the README's "PassPurchase.kind: pay_once"
 * note on why passes stayed a credits-only concept in this work package). The
 * webhook handler reads those notes back to cross-check the payment and to
 * grant the right number of credits, rather than re-deriving them from a price
 * table that could have moved between checkout and payment.
 */
@Injectable()
export class PassesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly plans: PlansService,
    private readonly checkout: CheckoutService,
    private readonly audit: AuditService,
    private readonly ninePassEligibility: NinePassEligibilityService,
  ) {}

  async passCheckout(
    workspaceId: string,
    actorId: string,
    body: PassCheckoutDto,
    context: RequestContextInfo,
  ): Promise<PassCheckoutResponse> {
    const workspace = await this.checkout.requireConfirmedWorkspace(workspaceId);
    const quote = await this.quotePass(body.kind, workspace.currency, body.planKey);

    // B04: server-side eligibility for the ₹9 pass, checked *after* `quotePass`
    // so a non-INR workspace still gets `quotePass`'s own pre-existing
    // `billing/pass_kind_unavailable` 400 (B01's contract, and its own
    // acceptance test) rather than this service's 409 — the two currency checks
    // agree, they just aren't allowed to race for which error the caller sees.
    // The once-per-30-days and never-on-a-paid-plan halves have no equivalent
    // upstream check, so they are only ever reported from here.
    if (body.kind === "first_export") {
      await this.ninePassEligibility.assertEligible(workspaceId);
    }

    const passPurchaseId = ulid();
    const order = await this.provider.createOrder({
      amountMinor: quote.amountMinor,
      currency: workspace.currency,
      purpose: `pass:${body.kind}`,
      refId: passPurchaseId,
      notes: {
        workspaceId,
        passPurchaseId,
        kind: body.kind,
        amountMinor: String(quote.amountMinor),
        creditsGrantedTenths: String(quote.creditsGrantedTenths),
        ...(quote.durationDays === undefined ? {} : { durationDays: String(quote.durationDays) }),
      },
    });

    await this.prisma.passPurchase.create({
      data: {
        id: passPurchaseId,
        workspaceId,
        kind: body.kind,
        provider: "razorpay",
        providerOrderId: order.providerOrderId,
        startsAt: new Date(),
        ...(quote.durationDays === undefined
          ? {}
          : { endsAt: new Date(Date.now() + quote.durationDays * 24 * 60 * 60 * 1_000) }),
        creditsGrantedTenths: quote.creditsGrantedTenths,
      },
    });

    await this.audit.record({
      action: B01_AUDIT_ACTIONS.passCheckoutCreated,
      resource: "pass_purchase",
      resourceId: passPurchaseId,
      actorId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { kind: body.kind, amountMinor: quote.amountMinor },
    });

    return {
      passPurchaseId,
      keyId: order.checkout.keyId,
      providerOrderId: order.providerOrderId,
      amountMinor: quote.amountMinor,
      currency: workspace.currency,
      creditsGrantedTenths: quote.creditsGrantedTenths,
    };
  }

  async topupCheckout(
    workspaceId: string,
    actorId: string,
    body: TopupCheckoutDto,
    context: RequestContextInfo,
  ): Promise<PassCheckoutResponse> {
    const workspace = await this.checkout.requireConfirmedWorkspace(workspaceId);

    const tier = TOPUP_TIERS.find((candidate) => candidate.credits === body.credits);
    if (tier === undefined) {
      throw new AppException(
        BILLING_ERRORS.topupInvalid,
        `No top-up pack of ${String(body.credits)} credits. Available: ${TOPUP_TIERS.map((t) => t.credits).join(", ")}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (tier.minPlan !== null) {
      const activePlan = await this.activePlanKey(workspaceId);
      if (activePlan === "free") {
        throw new AppException(
          BILLING_ERRORS.topupInvalid,
          `The ${String(tier.credits)}-credit pack needs a paid plan (Starter+).`,
          HttpStatus.CONFLICT,
        );
      }
    }

    const amountMinor = tier.prices[workspace.currency];
    const creditsGrantedTenths = tier.credits * 10;
    const passPurchaseId = ulid();

    const order = await this.provider.createOrder({
      amountMinor,
      currency: workspace.currency,
      purpose: `topup:${String(tier.credits)}`,
      refId: passPurchaseId,
      notes: {
        workspaceId,
        passPurchaseId,
        kind: "topup",
        amountMinor: String(amountMinor),
        creditsGrantedTenths: String(creditsGrantedTenths),
      },
    });

    await this.prisma.passPurchase.create({
      data: {
        id: passPurchaseId,
        workspaceId,
        kind: "topup",
        provider: "razorpay",
        providerOrderId: order.providerOrderId,
        startsAt: new Date(),
        creditsGrantedTenths,
      },
    });

    await this.audit.record({
      action: B01_AUDIT_ACTIONS.topupCheckoutCreated,
      resource: "pass_purchase",
      resourceId: passPurchaseId,
      actorId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { credits: tier.credits, amountMinor },
    });

    return {
      passPurchaseId,
      keyId: order.checkout.keyId,
      providerOrderId: order.providerOrderId,
      amountMinor,
      currency: workspace.currency,
      creditsGrantedTenths,
    };
  }

  /** The plan of the workspace's current live subscription, or `free` with none. */
  private async activePlanKey(workspaceId: string): Promise<$Enums.PlanKey> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { workspaceId, status: { in: ["trialing", "active", "past_due", "paused"] } },
      orderBy: { createdAt: "desc" },
      include: { plan: { select: { key: true } } },
    });
    return subscription?.plan.key ?? "free";
  }

  private async quotePass(
    kind: $Enums.PassPurchaseKind,
    currency: $Enums.Currency,
    planKey: $Enums.PlanKey | undefined,
  ): Promise<{ amountMinor: number; creditsGrantedTenths: number; durationDays?: number }> {
    switch (kind) {
      case "first_export": {
        if (currency !== "INR") {
          throw new AppException(
            BILLING_ERRORS.passKindUnavailable,
            "The clean-export pass is INR only (04 §Offers gives no international price).",
            HttpStatus.BAD_REQUEST,
          );
        }
        return { amountMinor: FIRST_EXPORT_PRICE_INR_MINOR, creditsGrantedTenths: 0 };
      }
      case "week_pass":
        return {
          amountMinor: WEEK_PASS.prices[currency],
          creditsGrantedTenths: WEEK_PASS.creditsTenths,
          durationDays: WEEK_PASS.days,
        };
      case "pay_once": {
        // Distinct from `POST /billing/checkout {interval:"once"}` (B01 brief
        // §2/§3, acceptance criterion 1: "pay-once creates a 30-day
        // subscription without a mandate", i.e. the full plan tier for 30
        // days). This pass buys the SAME plan's monthly credit allotment for
        // 30 days at the same monthly price without changing the workspace's
        // plan tier or feature set — a lighter, credits-only product. `06` has
        // no separate table for it (`passes_purchased.kind` already lists
        // `pay_once`), so it is priced here off the plan's own monthly price
        // rather than inventing a second number; see the README's open
        // question on this naming overlap.
        if (planKey === undefined) {
          throw new AppException(
            BILLING_ERRORS.passKindUnavailable,
            "`planKey` is required for a pay_once pass.",
            HttpStatus.BAD_REQUEST,
          );
        }
        const plan = await this.plans.require(planKey);
        const prices = parsePlanPrices(plan.prices);
        return {
          amountMinor: prices[currency].month,
          creditsGrantedTenths: plan.creditsPerMonthTenths,
          durationDays: 30,
        };
      }
      case "topup":
        throw new AppException(
          BILLING_ERRORS.passKindUnavailable,
          "Use POST /billing/topups/checkout for top-ups.",
          HttpStatus.BAD_REQUEST,
        );
    }
  }
}
