import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import {
  B01_AUDIT_ACTIONS,
  BILLING_ERRORS,
  PAUSE_COOLDOWN_MS,
  UPI_AUTOPAY_CAP_MINOR,
} from "./billing.constants.js";
import {
  type CheckoutResponse,
  type ChangePreview,
  type MandateView,
  type SubscriptionView,
  ChangePlanDto,
  ChangePreviewQueryDto,
} from "./billing.dto.js";
import { CheckoutService } from "./checkout.service.js";
import { decideMandate, quotePrice } from "./money.js";
import { PlansService, toPricingPlan } from "./plans.service.js";
import { BILLING_PROVIDER, type BillingProvider, type PaymentMethodView } from "./provider.js";
import { periodEnd, renewalInitiateAt } from "./schedule.js";
import { AppException, ERROR_CODES, PrismaService } from "../common/index.js";
import { AuditService } from "../users/audit.service.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { RequestContextInfo } from "../users/profile.service.js";
import type { $Enums, Mandate, Subscription } from "@prisma/client";

/**
 * `GET /billing/subscription` and everything under it (B01 brief §6):
 * cancel/resume/pause, change-plan with proration preview and mandate
 * re-registration, mandate view/revoke, payment methods.
 */
@Injectable()
export class SubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly plans: PlansService,
    private readonly checkout: CheckoutService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
  ) {}

  async get(workspaceId: string): Promise<SubscriptionView | null> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      include: { plan: { select: { key: true } } },
    });
    return subscription === null ? null : toView(subscription, subscription.plan.key);
  }

  async cancel(
    workspaceId: string,
    actorId: string,
    context: RequestContextInfo,
  ): Promise<SubscriptionView> {
    const subscription = await this.requireLive(workspaceId);
    if (subscription.cancelAtPeriodEnd) {
      throw new AppException(
        BILLING_ERRORS.subscriptionNotCancellable,
        "This subscription is already set to cancel at period end.",
        HttpStatus.CONFLICT,
      );
    }

    if (subscription.providerSubId !== null && subscription.mandateId !== null) {
      await this.provider.cancelSubscription({
        providerSubscriptionId: subscription.providerSubId,
        atPeriodEnd: true,
      });
    }

    const updated = await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: { cancelAtPeriodEnd: true },
      include: { plan: { select: { key: true } } },
    });
    await this.audit.record({
      action: B01_AUDIT_ACTIONS.subscriptionCancelled,
      resource: "subscription",
      resourceId: subscription.id,
      actorId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { atPeriodEnd: true },
    });
    return toView(updated, updated.plan.key);
  }

  async resume(
    workspaceId: string,
    actorId: string,
    context: RequestContextInfo,
  ): Promise<SubscriptionView> {
    const subscription = await this.requireAny(workspaceId);

    if (subscription.cancelAtPeriodEnd && subscription.status !== "cancelled") {
      const updated = await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: { cancelAtPeriodEnd: false },
        include: { plan: { select: { key: true } } },
      });
      await this.audit.record({
        action: B01_AUDIT_ACTIONS.subscriptionResumed,
        resource: "subscription",
        resourceId: subscription.id,
        actorId,
        workspaceId,
        ...(context.ip === undefined ? {} : { ip: context.ip }),
      });
      return toView(updated, updated.plan.key);
    }

    if (subscription.status === "paused") {
      const updated = await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: "active", pausedUntil: null },
        include: { plan: { select: { key: true } } },
      });
      await this.entitlements.invalidate(workspaceId);
      await this.audit.record({
        action: B01_AUDIT_ACTIONS.subscriptionResumed,
        resource: "subscription",
        resourceId: subscription.id,
        actorId,
        workspaceId,
        ...(context.ip === undefined ? {} : { ip: context.ip }),
      });
      return toView(updated, updated.plan.key);
    }

    throw new AppException(
      BILLING_ERRORS.subscriptionNotResumable,
      "Nothing to resume: the subscription is neither pending cancellation nor paused.",
      HttpStatus.CONFLICT,
    );
  }

  /** Once per rolling 12 months (04 §Refunds & cancellation). */
  async pause(
    workspaceId: string,
    actorId: string,
    context: RequestContextInfo,
  ): Promise<SubscriptionView> {
    const subscription = await this.requireLive(workspaceId);
    if (subscription.status === "paused") {
      throw new AppException(
        BILLING_ERRORS.alreadyPaused,
        "This subscription is already paused.",
        HttpStatus.CONFLICT,
      );
    }

    // The last several `subscription.paused` rows, filtered in JS for
    // `reason: "customer"` — `graceExpiry`'s own pauses (`reason:
    // "grace_expired"`) share the action name and must not count against the
    // cooldown. A Prisma JSONB `path` filter could do this in one query, but
    // is fragile to get right across nullable-`Json` typings; a handful of
    // rows read and filtered here is simpler and just as correct.
    const recentPauses = await this.prisma.auditLog.findMany({
      where: { workspaceId, action: B01_AUDIT_ACTIONS.subscriptionPaused },
      orderBy: { at: "desc" },
      take: 5,
    });
    const lastCustomerPause = recentPauses.find(
      (row) => (row.data as { reason?: string } | null)?.reason === "customer",
    );
    if (
      lastCustomerPause !== undefined &&
      Date.now() - lastCustomerPause.at.getTime() < PAUSE_COOLDOWN_MS
    ) {
      throw new AppException(
        BILLING_ERRORS.pauseLimitReached,
        "A subscription can be paused once every 12 months.",
        HttpStatus.CONFLICT,
        { availableAt: new Date(lastCustomerPause.at.getTime() + PAUSE_COOLDOWN_MS).toISOString() },
      );
    }

    const skipUntil = periodEnd(subscription.currentPeriodEnd, subscription.interval);
    const updated = await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: "paused", pausedUntil: skipUntil },
      include: { plan: { select: { key: true } } },
    });
    await this.entitlements.invalidate(workspaceId);
    await this.audit.record({
      action: B01_AUDIT_ACTIONS.subscriptionPaused,
      resource: "subscription",
      resourceId: subscription.id,
      actorId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { reason: "customer", pausedUntil: skipUntil.toISOString() },
    });
    return toView(updated, updated.plan.key);
  }

  async changePreview(workspaceId: string, query: ChangePreviewQueryDto): Promise<ChangePreview> {
    const subscription = await this.requireLive(workspaceId);
    const newPlan = await this.plans.require(query.planKey);
    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });

    const quoted = quotePrice({
      plan: toPricingPlan(newPlan),
      currency: workspace.currency,
      interval: query.interval,
      ...(query.seats === undefined ? {} : { seats: query.seats }),
    });
    if (!quoted.ok) {
      throw new AppException(
        BILLING_ERRORS.intervalUnavailable,
        `"${query.interval}" is not available for plan "${query.planKey}".`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const totalMs =
      subscription.currentPeriodEnd.getTime() - subscription.currentPeriodStart.getTime();
    const remainingMs = Math.max(0, subscription.currentPeriodEnd.getTime() - Date.now());
    const remainingFraction = totalMs > 0 ? remainingMs / totalMs : 0;
    const prorationCreditMinor = Math.round(subscription.listPriceMinor * remainingFraction);
    const amountDueNowMinor = Math.max(0, quoted.quote.listPriceMinor - prorationCreditMinor);

    const currentMandateCap =
      subscription.mandateId === null
        ? 0
        : ((await this.prisma.mandate.findUnique({ where: { id: subscription.mandateId } }))
            ?.maxAmountMinor ?? 0);

    return {
      currentListPriceMinor: subscription.listPriceMinor,
      newListPriceMinor: quoted.quote.listPriceMinor,
      prorationCreditMinor,
      amountDueNowMinor,
      mandateReRegistrationRequired: quoted.quote.listPriceMinor > currentMandateCap,
      currency: workspace.currency,
    };
  }

  async changePlan(
    workspaceId: string,
    actorId: string,
    body: ChangePlanDto,
    context: RequestContextInfo,
  ): Promise<SubscriptionView | CheckoutResponse> {
    const subscription = await this.requireLive(workspaceId);
    const newPlan = await this.plans.require(body.planKey);
    const workspace = await this.checkout.requireConfirmedWorkspace(workspaceId);

    const quoted = quotePrice({
      plan: toPricingPlan(newPlan),
      currency: workspace.currency,
      interval: body.interval,
      ...(body.seats === undefined ? {} : { seats: body.seats }),
    });
    if (!quoted.ok) {
      throw new AppException(
        BILLING_ERRORS.intervalUnavailable,
        "That plan/interval is not available.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const decision = decideMandate({
      currency: workspace.currency,
      capMinor: quoted.quote.listPriceMinor,
      ...(body.method === undefined ? {} : { requestedMethod: body.method }),
    });
    if (!decision.ok) {
      throw new AppException(
        ERROR_CODES.billingMandateCapExceeded,
        `A UPI Autopay mandate cannot exceed ₹${String(UPI_AUTOPAY_CAP_MINOR / 100)}.`,
        HttpStatus.CONFLICT,
        { capMinor: quoted.quote.listPriceMinor },
      );
    }

    const currentMandate =
      subscription.mandateId === null
        ? null
        : await this.prisma.mandate.findUnique({ where: { id: subscription.mandateId } });
    const needsReRegistration =
      decision.kind === "recurring" &&
      quoted.quote.listPriceMinor > (currentMandate?.maxAmountMinor ?? 0);

    if (needsReRegistration) {
      // D40: a mandate cannot be updated in place, only re-registered with
      // fresh authentication. The old provider-side subscription is cancelled
      // immediately (not at period end — it is being replaced), and a new
      // mandate is registered at the new cap; the workspace keeps its
      // entitlement under the OLD terms until the new mandate authenticates
      // (the `subscription.authenticated`/`activated` webhook for the new
      // `providerSubId`), so an upgrade never has to wait on the customer.
      if (subscription.providerSubId !== null) {
        await this.provider.cancelSubscription({
          providerSubscriptionId: subscription.providerSubId,
          atPeriodEnd: false,
        });
      }

      const registered = await this.provider.registerMandate({
        providerCustomerId: (
          await this.provider.createCustomer(await this.checkout.customerInput(workspace))
        ).providerCustomerId,
        subscriptionId: subscription.id,
        planKey: newPlan.key,
        interval: body.interval,
        currency: workspace.currency,
        mandateCapMinor: quoted.quote.listPriceMinor,
        amountMinor: quoted.quote.listPriceMinor,
        method: decision.mandate.method,
        notes: { workspaceId },
      });

      const mandateId = ulid();
      await this.prisma.mandate.create({
        data: {
          id: mandateId,
          workspaceId,
          subscriptionId: subscription.id,
          provider: "razorpay",
          method: decision.mandate.method,
          maxAmountMinor: quoted.quote.listPriceMinor,
          currency: workspace.currency,
          frequency: body.interval,
          status: "pending",
          afaRequiredPerDebit: decision.mandate.afaRequiredPerDebit,
        },
      });
      if (currentMandate !== null) {
        await this.prisma.mandate.update({
          where: { id: currentMandate.id },
          data: { status: "revoked", revokedAt: new Date() },
        });
      }
      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          planId: newPlan.id,
          interval: body.interval,
          listPriceMinor: quoted.quote.listPriceMinor,
          seats: quoted.quote.seats,
          providerSubId: registered.providerSubscriptionId,
          mandateId,
          status: "pending",
        },
      });

      await this.audit.record({
        action: B01_AUDIT_ACTIONS.subscriptionChanged,
        resource: "subscription",
        resourceId: subscription.id,
        actorId,
        workspaceId,
        ...(context.ip === undefined ? {} : { ip: context.ip }),
        data: { planKey: newPlan.key, interval: body.interval, mandateReRegistered: true },
      });

      return {
        subscriptionId: subscription.id,
        status: "pending",
        keyId: registered.checkout.keyId,
        amountMinor: quoted.quote.listPriceMinor,
        currency: workspace.currency,
        interval: body.interval,
        mandateCapMinor: quoted.quote.listPriceMinor,
        method: decision.mandate.method,
        providerSubscriptionId: registered.providerSubscriptionId,
      };
    }

    // Same or lower cap: the existing mandate already covers it, so this is
    // bookkeeping only — no new authentication, no provider call.
    const end = periodEnd(new Date(), body.interval);
    const updated = await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        planId: newPlan.id,
        interval: body.interval,
        listPriceMinor: quoted.quote.listPriceMinor,
        seats: quoted.quote.seats,
        currentPeriodEnd: end,
        renewalInitiateAt: renewalInitiateAt(end),
      },
      include: { plan: { select: { key: true } } },
    });
    if (currentMandate !== null && quoted.quote.listPriceMinor !== currentMandate.maxAmountMinor) {
      await this.prisma.mandate.update({
        where: { id: currentMandate.id },
        data: { maxAmountMinor: quoted.quote.listPriceMinor },
      });
    }
    await this.entitlements.invalidate(workspaceId);
    await this.audit.record({
      action: B01_AUDIT_ACTIONS.subscriptionChanged,
      resource: "subscription",
      resourceId: subscription.id,
      actorId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { planKey: newPlan.key, interval: body.interval, mandateReRegistered: false },
    });
    return toView(updated, updated.plan.key);
  }

  async listMandates(workspaceId: string): Promise<MandateView[]> {
    const mandates = await this.prisma.mandate.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return mandates.map(toMandateView);
  }

  async revokeMandate(
    workspaceId: string,
    mandateId: string,
    actorId: string,
    context: RequestContextInfo,
  ): Promise<MandateView> {
    const mandate = await this.prisma.mandate.findFirst({ where: { id: mandateId, workspaceId } });
    if (mandate === null) {
      throw new AppException(
        BILLING_ERRORS.mandateNotFound,
        "No such mandate.",
        HttpStatus.NOT_FOUND,
      );
    }
    if (mandate.status === "revoked") {
      throw new AppException(
        BILLING_ERRORS.mandateAlreadyRevoked,
        "This mandate is already revoked.",
        HttpStatus.CONFLICT,
      );
    }

    const subscription =
      mandate.subscriptionId === null
        ? null
        : await this.prisma.subscription.findUnique({ where: { id: mandate.subscriptionId } });

    if (subscription?.providerSubId !== undefined && subscription?.providerSubId !== null) {
      await this.provider.cancelSubscription({
        providerSubscriptionId: subscription.providerSubId,
        atPeriodEnd: false,
      });
    }

    const updated = await this.prisma.mandate.update({
      where: { id: mandateId },
      data: { status: "revoked", revokedAt: new Date() },
    });
    if (subscription !== null && subscription.status !== "cancelled") {
      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: "cancelled" },
      });
      await this.entitlements.invalidate(workspaceId);
    }

    await this.audit.record({
      action: B01_AUDIT_ACTIONS.mandateRevoked,
      resource: "mandate",
      resourceId: mandateId,
      actorId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
    });
    return toMandateView(updated);
  }

  async paymentMethods(workspaceId: string): Promise<PaymentMethodView[]> {
    const workspace = await this.checkout.requireConfirmedWorkspace(workspaceId);
    const customer = await this.provider.createCustomer(
      await this.checkout.customerInput(workspace),
    );
    return this.provider.listPaymentMethods({ providerCustomerId: customer.providerCustomerId });
  }

  private async requireAny(workspaceId: string): Promise<Subscription> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    if (subscription === null) {
      throw new AppException(
        BILLING_ERRORS.subscriptionNotFound,
        "No subscription on file.",
        HttpStatus.NOT_FOUND,
      );
    }
    return subscription;
  }

  private async requireLive(workspaceId: string): Promise<Subscription> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { workspaceId, status: { in: ["trialing", "active", "past_due"] } },
      orderBy: { createdAt: "desc" },
    });
    if (subscription === null) {
      throw new AppException(
        BILLING_ERRORS.subscriptionNotFound,
        "No live subscription.",
        HttpStatus.NOT_FOUND,
      );
    }
    return subscription;
  }
}

function toView(subscription: Subscription, planKey: $Enums.PlanKey): SubscriptionView {
  return {
    id: subscription.id,
    planKey,
    status: subscription.status,
    interval: subscription.interval,
    currency: subscription.currency,
    listPriceMinor: subscription.listPriceMinor,
    currentPeriodStart: subscription.currentPeriodStart.toISOString(),
    currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
    renewalInitiateAt: subscription.renewalInitiateAt?.toISOString() ?? null,
    graceUntil: subscription.graceUntil?.toISOString() ?? null,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    pausedUntil: subscription.pausedUntil?.toISOString() ?? null,
    seats: subscription.seats,
    mandateId: subscription.mandateId,
  };
}

function toMandateView(mandate: Mandate): MandateView {
  return {
    id: mandate.id,
    method: mandate.method,
    maxAmountMinor: mandate.maxAmountMinor,
    currency: mandate.currency,
    status: mandate.status,
    afaRequiredPerDebit: mandate.afaRequiredPerDebit,
    validFrom: mandate.validFrom.toISOString(),
    validUntil: mandate.validUntil?.toISOString() ?? null,
  };
}
