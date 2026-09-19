import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { type Env, surfaceEnabled } from "@montaj/config";

import { B01_AUDIT_ACTIONS, BILLING_ERRORS, UPI_AUTOPAY_CAP_MINOR } from "./billing.constants.js";
import { type CheckoutAlternative, type CheckoutResponse, CheckoutDto } from "./billing.dto.js";
import { decideMandate, quotePrice } from "./money.js";
import { PlansService, toPricingPlan } from "./plans.service.js";
import { BILLING_PROVIDER, type BillingProvider } from "./provider.js";
import { periodEnd, renewalInitiateAt } from "./schedule.js";
import { AppException, ERROR_CODES, PrismaService } from "../common/index.js";
import { ENV } from "../config/config.module.js";
import { AuditService } from "../users/audit.service.js";

import type { RequestContextInfo } from "../users/profile.service.js";
import type { $Enums, Plan, Workspace } from "@prisma/client";

/**
 * `POST /billing/checkout` and the shared pieces `SubscriptionService` (change
 * plan) and the passes/top-up flows reuse: the tax-profile gate, the workspace
 * → provider customer lookup, and the ₹15,000 mandate rule (B01 brief §3, D40).
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly plans: PlansService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async checkout(
    workspaceId: string,
    actorId: string,
    body: CheckoutDto,
    context: RequestContextInfo,
  ): Promise<CheckoutResponse> {
    const workspace = await this.requireConfirmedWorkspace(workspaceId);
    const plan = await this.plans.require(body.planKey);

    const quoted = quotePrice({
      plan: toPricingPlan(plan),
      currency: workspace.currency,
      interval: body.interval,
      ...(body.seats === undefined ? {} : { seats: body.seats }),
    });
    if (!quoted.ok) throw intervalError(quoted.reason, body.planKey, body.interval);

    if (body.interval === "once") {
      return this.checkoutOneTime(workspace, plan, {
        interval: "once",
        amountMinor: quoted.quote.listPriceMinor,
        seats: quoted.quote.seats,
        method: "card",
        cancelAtPeriodEnd: true,
        actorId,
        context,
      });
    }

    const decision = decideMandate({
      currency: workspace.currency,
      capMinor: quoted.quote.listPriceMinor,
      ...(body.method === undefined ? {} : { requestedMethod: body.method }),
    });

    if (!decision.ok) {
      const alternatives = await this.buildAlternatives(
        plan,
        workspace.currency,
        body.interval,
        quoted.quote.listPriceMinor,
        body.seats,
      );
      await this.audit.record({
        action: B01_AUDIT_ACTIONS.checkoutRefused,
        resource: "workspace",
        resourceId: workspaceId,
        actorId,
        workspaceId,
        ...(context.ip === undefined ? {} : { ip: context.ip }),
        data: {
          planKey: body.planKey,
          interval: body.interval,
          capMinor: quoted.quote.listPriceMinor,
        },
      });
      throw new AppException(
        ERROR_CODES.billingMandateCapExceeded,
        `A UPI Autopay mandate cannot exceed ₹${String(UPI_AUTOPAY_CAP_MINOR / 100)}.`,
        HttpStatus.CONFLICT,
        { capMinor: quoted.quote.listPriceMinor, alternatives },
      );
    }

    if (decision.kind === "one_time") {
      return this.checkoutOneTime(workspace, plan, {
        interval: body.interval,
        amountMinor: quoted.quote.listPriceMinor,
        seats: quoted.quote.seats,
        method: "card",
        cancelAtPeriodEnd: true,
        actorId,
        context,
      });
    }

    const subscriptionId = ulid();
    const mandateId = ulid();
    const customer = await this.provider.createCustomer(await this.customerInput(workspace));

    const created = await this.provider.createSubscription({
      providerCustomerId: customer.providerCustomerId,
      planKey: plan.key,
      subscriptionId,
      interval: body.interval,
      currency: workspace.currency,
      amountMinor: quoted.quote.listPriceMinor,
      mandateCapMinor: quoted.quote.listPriceMinor,
      method: decision.mandate.method,
      notes: { workspaceId },
    });

    const now = new Date();
    const end = periodEnd(now, body.interval);

    await this.prisma.withTransaction(async (tx) => {
      await tx.mandate.create({
        data: {
          id: mandateId,
          workspaceId,
          provider: "razorpay",
          ...(created.providerMandateId === undefined
            ? {}
            : { providerMandateId: created.providerMandateId }),
          method: decision.mandate.method,
          maxAmountMinor: quoted.quote.listPriceMinor,
          currency: workspace.currency,
          frequency: body.interval,
          status: "pending",
          afaRequiredPerDebit: decision.mandate.afaRequiredPerDebit,
        },
      });
      await tx.subscription.create({
        data: {
          id: subscriptionId,
          workspaceId,
          planId: plan.id,
          provider: "razorpay",
          providerSubId: created.providerSubscriptionId,
          status: "pending",
          interval: body.interval,
          currency: workspace.currency,
          listPriceMinor: quoted.quote.listPriceMinor,
          currentPeriodStart: now,
          currentPeriodEnd: end,
          renewalInitiateAt: renewalInitiateAt(end),
          seats: quoted.quote.seats,
          mandateId,
        },
      });
      await tx.mandate.update({ where: { id: mandateId }, data: { subscriptionId } });
    });

    await this.audit.record({
      action: B01_AUDIT_ACTIONS.checkoutCreated,
      resource: "subscription",
      resourceId: subscriptionId,
      actorId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: {
        planKey: plan.key,
        interval: body.interval,
        amountMinor: quoted.quote.listPriceMinor,
        method: decision.mandate.method,
      },
    });

    return {
      subscriptionId,
      status: "pending",
      keyId: created.checkout.keyId,
      amountMinor: quoted.quote.listPriceMinor,
      currency: workspace.currency,
      interval: body.interval,
      mandateCapMinor: quoted.quote.listPriceMinor,
      method: decision.mandate.method,
      providerSubscriptionId: created.providerSubscriptionId,
      prefill: { email: workspace.owner.email },
      ...(created.checkout.notes === undefined ? {} : { notes: created.checkout.notes }),
    };
  }

  /**
   * A one-time order: `once` (30-day pay-once, Starter/Creator), and a `card`
   * request above the UPI cap (`decideMandate`'s `"one_time"` branch — 04
   * §Offers' "one card ... charge" for Studio yearly). No mandate row.
   * `cancelAtPeriodEnd: true` so nothing renews it automatically; B01's
   * `RenewalService.initiateRenewal` still sends the reminder notice 04 §Offers
   * promises ("pay-once with a renewal reminder"), it just never charges.
   */
  async checkoutOneTime(
    workspace: WorkspaceWithOwner,
    plan: Plan,
    input: {
      readonly interval: $Enums.BillingInterval;
      readonly amountMinor: number;
      readonly seats: number;
      readonly method: "card";
      readonly cancelAtPeriodEnd: boolean;
      readonly actorId: string;
      readonly context: RequestContextInfo;
    },
  ): Promise<CheckoutResponse> {
    const subscriptionId = ulid();
    const order = await this.provider.createOrder({
      amountMinor: input.amountMinor,
      currency: workspace.currency,
      purpose: `${plan.key} (${input.interval}, pay-once)`,
      refId: subscriptionId,
      notes: { workspaceId: workspace.id, subscriptionId },
    });

    const now = new Date();
    const end = periodEnd(now, input.interval);

    await this.prisma.subscription.create({
      data: {
        id: subscriptionId,
        workspaceId: workspace.id,
        planId: plan.id,
        provider: "razorpay",
        providerSubId: order.providerOrderId,
        status: "pending",
        interval: input.interval,
        currency: workspace.currency,
        listPriceMinor: input.amountMinor,
        currentPeriodStart: now,
        currentPeriodEnd: end,
        renewalInitiateAt: renewalInitiateAt(end),
        cancelAtPeriodEnd: input.cancelAtPeriodEnd,
        seats: input.seats,
      },
    });

    await this.audit.record({
      action: B01_AUDIT_ACTIONS.checkoutCreated,
      resource: "subscription",
      resourceId: subscriptionId,
      actorId: input.actorId,
      workspaceId: workspace.id,
      ...(input.context.ip === undefined ? {} : { ip: input.context.ip }),
      data: {
        planKey: plan.key,
        interval: input.interval,
        amountMinor: input.amountMinor,
        payOnce: true,
      },
    });

    return {
      subscriptionId,
      status: "pending",
      keyId: order.checkout.keyId,
      amountMinor: input.amountMinor,
      currency: workspace.currency,
      interval: input.interval,
      mandateCapMinor: null,
      method: null,
      providerOrderId: order.providerOrderId,
      prefill: { email: workspace.owner.email },
      ...(order.checkout.notes === undefined ? {} : { notes: order.checkout.notes }),
    };
  }

  /** Every alternative retries the same request with one field changed. */
  private async buildAlternatives(
    plan: Plan,
    currency: $Enums.Currency,
    interval: $Enums.BillingInterval,
    capMinor: number,
    seats: number | undefined,
  ): Promise<CheckoutAlternative[]> {
    const alternatives: CheckoutAlternative[] = [];

    if (interval === "year") {
      const halfyear = quotePrice({
        plan: toPricingPlan(plan),
        currency,
        interval: "halfyear",
        ...(seats === undefined ? {} : { seats }),
      });
      if (halfyear.ok && halfyear.quote.listPriceMinor <= UPI_AUTOPAY_CAP_MINOR) {
        alternatives.push({
          kind: "halfyear_upi",
          interval: "halfyear",
          method: "upi_autopay",
          amountMinor: halfyear.quote.listPriceMinor,
          currency,
        });
      }
    }

    alternatives.push({
      kind: "card_once",
      interval,
      method: "card",
      amountMinor: capMinor,
      currency,
    });
    alternatives.push({
      kind: "enach",
      interval,
      method: "enach",
      amountMinor: capMinor,
      currency,
    });
    return alternatives;
  }

  /** Refuses `billing/checkout_disabled` if checkout surface is not enabled, and `billing/tax_profile_required` while the country is unconfirmed. */
  async requireConfirmedWorkspace(workspaceId: string): Promise<WorkspaceWithOwner> {
    if (!surfaceEnabled("checkout", this.env.FEATURE_FLAGS_JSON)) {
      throw new AppException(
        BILLING_ERRORS.checkoutDisabled,
        "Checkout is not available in this release.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      include: { owner: { select: { email: true, name: true } } },
    });
    if (workspace === null) {
      throw new AppException(ERROR_CODES.notFound, "No such workspace.", HttpStatus.NOT_FOUND);
    }
    if (workspace.billingCountryConfirmedAt === null) {
      throw new AppException(
        BILLING_ERRORS.taxProfileRequired,
        "Confirm the workspace's billing country and State before checkout (PUT /workspaces/{id}/tax-profile).",
        HttpStatus.CONFLICT,
      );
    }
    return workspace;
  }

  async customerInput(workspace: WorkspaceWithOwner): Promise<{
    workspaceId: string;
    email: string;
    name?: string;
  }> {
    return {
      workspaceId: workspace.id,
      email: workspace.owner.email,
      ...(workspace.owner.name === null ? {} : { name: workspace.owner.name }),
    };
  }
}

type WorkspaceWithOwner = Workspace & { owner: { email: string; name: string | null } };

function intervalError(
  reason: "plan_inactive" | "interval_unavailable",
  planKey: string,
  interval: string,
): AppException {
  if (reason === "plan_inactive") {
    return new AppException(
      BILLING_ERRORS.planInactive,
      `Plan "${planKey}" is no longer sold.`,
      HttpStatus.CONFLICT,
    );
  }
  return new AppException(
    BILLING_ERRORS.intervalUnavailable,
    `"${interval}" is not available for plan "${planKey}".`,
    HttpStatus.BAD_REQUEST,
    { planKey, interval },
  );
}
