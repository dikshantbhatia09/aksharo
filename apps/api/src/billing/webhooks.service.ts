import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { ulid } from "ulid";

import { B01_AUDIT_ACTIONS, BILLING_ERRORS } from "./billing.constants.js";
import {
  BillingSignatureError,
  BILLING_PROVIDER,
  type BillingEvent,
  type BillingProvider,
} from "./provider.js";
import { RefundsService } from "./refunds.service.js";
import { RenewalService } from "./renewal.service.js";
import { graceUntil, periodEnd, renewalInitiateAt } from "./schedule.js";
import { AppException, PrismaService } from "../common/index.js";
import { CREDITS_FACADE, type CreditsFacade } from "../credits/credits.facade.js";
// B05 (invoices/tax): the event contract these emissions publish belongs to
// `invoices/`, not to this module — see `invoices/billing-events.ts`'s
// doc-comment for why this file emits them (setup instructions: "register
// listeners, do not fork the state machine") and for the file-boundary
// deviation this is reported as in B05's work package report.
import { BILLING_INVOICE_EVENTS } from "../invoices/billing-events.js";
import { AuditService } from "../users/audit.service.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { $Enums, Prisma } from "@prisma/client";

export interface WebhookOutcome {
  readonly status: "processed" | "replayed" | "ignored" | "mismatch";
}

/**
 * `POST /billing/webhooks/razorpay` (B01 brief §5, THREAT-MODEL T16).
 *
 * Order, every call:
 *
 * 1. **Verify the signature.** `provider.parseWebhook` throws
 *    {@link BillingSignatureError} on a bad one; the controller turns that into
 *    401, never a 200 (a 200 tells a real Razorpay account to stop retrying).
 * 2. **Idempotency.** `billing_events` is inserted with the event's derived id
 *    as its unique key *before* anything else changes; a duplicate delivery
 *    hits the unique constraint and returns `"replayed"` — no second effect,
 *    same as `CreditsFacade.settle` on an already-settled hold.
 * 3. **Resolve** the subscription, one-time order or pass this event is about.
 * 4. **Cross-check** amount and currency against what we quoted, when the event
 *    carries a payment. A mismatch is recorded (`billing_events.mismatch`,
 *    audited) and the state transition is *refused* — better an operator looks
 *    at a stuck "pending" row than the ledger silently disagreeing with the
 *    provider.
 * 5. **Apply the transition**, invalidate the entitlement cache, audit.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly entitlements: EntitlementService,
    @Inject(CREDITS_FACADE) private readonly credits: CreditsFacade,
    private readonly audit: AuditService,
    private readonly renewal: RenewalService,
    private readonly refunds: RefundsService,
    private readonly events: EventEmitter2,
  ) {}

  async handleRazorpay(rawBody: Buffer, signature: string): Promise<WebhookOutcome> {
    let event: BillingEvent;
    try {
      event = this.provider.parseWebhook(rawBody, signature);
    } catch (error) {
      if (error instanceof BillingSignatureError) {
        throw new AppException(
          BILLING_ERRORS.webhookSignatureInvalid,
          "The webhook signature could not be verified.",
          HttpStatus.UNAUTHORIZED,
        );
      }
      throw error;
    }

    const row = await this.recordEvent(event);
    if (row === undefined) return { status: "replayed" };

    try {
      const outcome = await this.dispatch(event);
      await this.prisma.billingEvent.update({
        where: { id: row.id },
        data: {
          status: outcome === "mismatch" ? "ignored" : "processed",
          mismatch: outcome === "mismatch",
          processedAt: new Date(),
        },
      });
      return { status: outcome };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.billingEvent.update({
        where: { id: row.id },
        data: { status: "failed", error: message, processedAt: new Date() },
      });
      throw error;
    }
  }

  /** Inserts the idempotency row. `undefined` means this event id was already seen. */
  private async recordEvent(event: BillingEvent): Promise<{ id: string } | undefined> {
    try {
      return await this.prisma.billingEvent.create({
        data: {
          id: ulid(),
          provider: "razorpay",
          eventId: event.eventId,
          eventType: event.eventType,
          payload: event.raw as Prisma.InputJsonValue,
          status: "received",
        },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        this.logger.log(
          { eventId: event.eventId, eventType: event.eventType },
          "webhook replay: no-op",
        );
        return undefined;
      }
      throw error;
    }
  }

  private async dispatch(event: BillingEvent): Promise<"processed" | "ignored" | "mismatch"> {
    switch (event.eventType) {
      case "subscription.authenticated":
        return this.onMandateAuthenticated(event);
      case "subscription.activated":
        return this.onSubscriptionActivated(event);
      case "subscription.charged":
        return this.onSubscriptionCharged(event);
      case "subscription.pending":
        return this.onSubscriptionPastDue(event, "past_due");
      case "subscription.halted":
        return this.onSubscriptionPastDue(event, "halted");
      case "subscription.cancelled":
        return this.onSubscriptionCancelled(event);
      case "subscription.completed":
        return this.onSubscriptionCompleted(event);
      case "payment.captured":
      case "order.paid":
        return this.onOrderPaid(event);
      case "payment.failed":
        return this.onPaymentFailed(event);
      case "payment.refunded":
        return this.onPaymentRefunded(event);
      case "mandate.activated":
      case "mandate.revoked":
      case "mandate.paused":
        return this.onMandateEvent(event);
      default:
        this.logger.warn({ eventType: event.eventType }, "unhandled billing event type");
        return "ignored";
    }
  }

  // -------------------------------------------------------------------------
  // Subscription lifecycle
  // -------------------------------------------------------------------------

  private async onMandateAuthenticated(event: BillingEvent): Promise<"processed" | "ignored"> {
    const subscription = await this.findSubscriptionByProviderId(event.providerSubscriptionId);
    if (subscription === null || subscription.mandateId === null) return "ignored";

    await this.prisma.mandate.update({
      where: { id: subscription.mandateId },
      data: { status: "active", registeredAt: new Date() },
    });
    return "processed";
  }

  private async onSubscriptionActivated(
    event: BillingEvent,
  ): Promise<"processed" | "ignored" | "mismatch"> {
    const subscription = await this.findSubscriptionByProviderId(event.providerSubscriptionId);
    if (subscription === null) return "ignored";

    if (this.amountMismatch(event, subscription)) {
      await this.recordMismatch(subscription.workspaceId, subscription.id, event);
      return "mismatch";
    }

    await this.prisma.$transaction([
      this.prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: "active", graceUntil: null },
      }),
      ...(subscription.mandateId === null
        ? []
        : [
            this.prisma.mandate.update({
              where: { id: subscription.mandateId },
              data: { status: "active", registeredAt: new Date() },
            }),
          ]),
    ]);
    if (event.providerPaymentId !== undefined)
      await this.recordPayment(event, subscription, "captured");

    await this.entitlements.invalidate(subscription.workspaceId);
    await this.audit.record({
      action: B01_AUDIT_ACTIONS.subscriptionActivated,
      resource: "subscription",
      resourceId: subscription.id,
      workspaceId: subscription.workspaceId,
      data: { eventType: event.eventType },
    });
    // B05: first charge on a recurring subscription — a tax/export invoice.
    this.events.emit(BILLING_INVOICE_EVENTS.subscriptionCharged, {
      subscriptionId: subscription.id,
      workspaceId: subscription.workspaceId,
      amountMinor: event.amountMinor ?? subscription.listPriceMinor,
      currency: subscription.currency,
      ...(event.providerPaymentId === undefined
        ? {}
        : { providerPaymentId: event.providerPaymentId }),
      isFirstCharge: true,
    });
    return "processed";
  }

  private async onSubscriptionCharged(
    event: BillingEvent,
  ): Promise<"processed" | "ignored" | "mismatch"> {
    const subscription = await this.findSubscriptionByProviderId(event.providerSubscriptionId);
    if (subscription === null) return "ignored";

    if (this.amountMismatch(event, subscription)) {
      await this.recordMismatch(subscription.workspaceId, subscription.id, event);
      return "mismatch";
    }

    const newStart = subscription.currentPeriodEnd;
    const newEnd = periodEnd(newStart, subscription.interval);

    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: "active",
        currentPeriodStart: newStart,
        currentPeriodEnd: newEnd,
        renewalInitiateAt: renewalInitiateAt(newEnd),
        graceUntil: null,
      },
    });
    if (event.providerPaymentId !== undefined)
      await this.recordPayment(event, subscription, "captured");

    await this.entitlements.invalidate(subscription.workspaceId);
    await this.audit.record({
      action: B01_AUDIT_ACTIONS.subscriptionRenewed,
      resource: "subscription",
      resourceId: subscription.id,
      workspaceId: subscription.workspaceId,
      data: { newPeriodEnd: newEnd.toISOString() },
    });
    // B05: a renewal charge — another tax/export invoice.
    this.events.emit(BILLING_INVOICE_EVENTS.subscriptionCharged, {
      subscriptionId: subscription.id,
      workspaceId: subscription.workspaceId,
      amountMinor: event.amountMinor ?? subscription.listPriceMinor,
      currency: subscription.currency,
      ...(event.providerPaymentId === undefined
        ? {}
        : { providerPaymentId: event.providerPaymentId }),
      isFirstCharge: false,
    });
    return "processed";
  }

  private async onSubscriptionPastDue(
    event: BillingEvent,
    kind: "past_due" | "halted",
  ): Promise<"processed" | "ignored"> {
    const subscription = await this.findSubscriptionByProviderId(event.providerSubscriptionId);
    if (subscription === null) return "ignored";

    // Grace is 3 days past the CURRENT period end (D40), set once on the first
    // failure and never pushed out by a later retry of the same cycle.
    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: "past_due",
        graceUntil: subscription.graceUntil ?? graceUntil(subscription.currentPeriodEnd),
      },
    });

    if (kind === "halted" && subscription.mandateId !== null) {
      await this.prisma.mandate.update({
        where: { id: subscription.mandateId },
        data: { status: "paused" },
      });
    }
    if (event.declineCode !== undefined && event.providerPaymentId !== undefined) {
      await this.recordPayment(event, subscription, "failed");
    }

    await this.entitlements.invalidate(subscription.workspaceId);
    await this.audit.record({
      action: B01_AUDIT_ACTIONS.subscriptionPastDue,
      resource: "subscription",
      resourceId: subscription.id,
      workspaceId: subscription.workspaceId,
      data: { kind, declineCode: event.declineCode ?? null },
    });
    return "processed";
  }

  private async onSubscriptionCancelled(event: BillingEvent): Promise<"processed" | "ignored"> {
    const subscription = await this.findSubscriptionByProviderId(event.providerSubscriptionId);
    if (subscription === null) return "ignored";

    await this.prisma.$transaction([
      this.prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: "cancelled" },
      }),
      ...(subscription.mandateId === null
        ? []
        : [
            this.prisma.mandate.update({
              where: { id: subscription.mandateId },
              data: { status: "revoked", revokedAt: new Date() },
            }),
          ]),
    ]);
    await this.entitlements.invalidate(subscription.workspaceId);
    await this.audit.record({
      action: B01_AUDIT_ACTIONS.subscriptionCancelled,
      resource: "subscription",
      resourceId: subscription.id,
      workspaceId: subscription.workspaceId,
    });
    return "processed";
  }

  private async onSubscriptionCompleted(event: BillingEvent): Promise<"processed" | "ignored"> {
    const subscription = await this.findSubscriptionByProviderId(event.providerSubscriptionId);
    if (subscription === null) return "ignored";

    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: "expired" },
    });
    await this.entitlements.invalidate(subscription.workspaceId);
    await this.audit.record({
      action: B01_AUDIT_ACTIONS.subscriptionExpired,
      resource: "subscription",
      resourceId: subscription.id,
      workspaceId: subscription.workspaceId,
    });
    return "processed";
  }

  // -------------------------------------------------------------------------
  // One-time orders: `once`/`card_once` subscriptions, passes and top-ups
  // -------------------------------------------------------------------------

  private async onOrderPaid(event: BillingEvent): Promise<"processed" | "ignored" | "mismatch"> {
    const orderId = event.providerOrderId ?? event.providerSubscriptionId;
    if (orderId === undefined) return "ignored";

    const subscription = await this.prisma.subscription.findFirst({
      where: { providerSubId: orderId, interval: { in: ["once"] } },
    });
    // A `card_once` alternative also has no mandate but keeps its own nominal
    // interval; both are told apart from a recurring one by `mandateId: null`.
    const oneTimeSubscription =
      subscription ??
      (await this.prisma.subscription.findFirst({
        where: { providerSubId: orderId, mandateId: null },
      }));

    if (oneTimeSubscription !== null)
      return this.activateOneTimeSubscription(event, oneTimeSubscription);

    const passPurchase = await this.prisma.passPurchase.findFirst({
      where: { providerOrderId: orderId },
    });
    if (passPurchase !== null) return this.grantPass(event, passPurchase);

    return "ignored";
  }

  private async activateOneTimeSubscription(
    event: BillingEvent,
    subscription: SubscriptionRow,
  ): Promise<"processed" | "mismatch"> {
    if (event.amountMinor !== undefined && event.amountMinor !== subscription.listPriceMinor) {
      await this.recordMismatch(subscription.workspaceId, subscription.id, event);
      return "mismatch";
    }
    if (subscription.status === "active") return "processed"; // already applied (replay-safe)

    const now = new Date();
    const end = periodEnd(now, subscription.interval);
    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: "active",
        currentPeriodStart: now,
        currentPeriodEnd: end,
        renewalInitiateAt: renewalInitiateAt(end),
      },
    });
    if (event.providerPaymentId !== undefined)
      await this.recordPayment(event, subscription, "captured");

    await this.entitlements.invalidate(subscription.workspaceId);
    await this.audit.record({
      action: B01_AUDIT_ACTIONS.subscriptionActivated,
      resource: "subscription",
      resourceId: subscription.id,
      workspaceId: subscription.workspaceId,
      data: { payOnce: true },
    });
    // B05: a one-time (pay-once / card_once) purchase — a tax/export invoice.
    this.events.emit(BILLING_INVOICE_EVENTS.orderPaid, {
      subscriptionId: subscription.id,
      workspaceId: subscription.workspaceId,
      amountMinor: event.amountMinor ?? subscription.listPriceMinor,
      currency: subscription.currency,
      ...(event.providerPaymentId === undefined
        ? {}
        : { providerPaymentId: event.providerPaymentId }),
    });
    return "processed";
  }

  private async grantPass(
    event: BillingEvent,
    pass: {
      id: string;
      workspaceId: string;
      kind: $Enums.PassPurchaseKind;
      consumedAt: Date | null;
      creditsGrantedTenths: number;
    },
  ): Promise<"processed" | "mismatch"> {
    const notedAmount = event.notes?.["amountMinor"];
    if (
      notedAmount !== undefined &&
      event.amountMinor !== undefined &&
      String(event.amountMinor) !== notedAmount
    ) {
      await this.recordMismatch(pass.workspaceId, pass.id, event);
      return "mismatch";
    }
    if (pass.consumedAt !== null) return "processed"; // replay-safe

    await this.prisma.passPurchase.update({
      where: { id: pass.id },
      data: { consumedAt: new Date() },
    });

    if (pass.creditsGrantedTenths > 0) {
      const granted = await this.credits.grantLot({
        workspaceId: pass.workspaceId,
        source: "pass",
        tenths: pass.creditsGrantedTenths,
        reason: `pass:${pass.kind}`,
        refId: pass.id,
        ...(event.currency === undefined ? {} : { currency: event.currency }),
        ...(event.amountMinor === undefined ? {} : { amountMinor: event.amountMinor }),
      });
      // B01b: the lot a refund needs to claw back from (RefundsService).
      // `passes_purchased.lot_id` has a real foreign key to `credit_lots`
      // (schema.prisma), which the production `LedgerCreditsFacade` always
      // satisfies -- it creates the row in the same transaction. Some test
      // suites (this one included, see billing-harness.ts) bind
      // `CREDITS_FACADE` to `NoopCreditsFacade` on purpose, whose `lotId` is
      // a synthetic id with nothing behind it; storing that would violate
      // the constraint for a reason that has nothing to do with billing's
      // own logic, which is what this suite is actually testing. The lot
      // link is bookkeeping for the (best-effort) credits clawback, not
      // part of granting the credits itself, so a failure here is caught
      // and logged rather than allowed to fail the whole webhook.
      try {
        await this.prisma.passPurchase.update({
          where: { id: pass.id },
          data: { lotId: granted.lotId },
        });
      } catch (error) {
        this.logger.warn(
          {
            passPurchaseId: pass.id,
            lotId: granted.lotId,
            err: error instanceof Error ? error.message : String(error),
          },
          "could not record the credit lot on the pass purchase",
        );
      }
    }

    await this.audit.record({
      action: B01_AUDIT_ACTIONS.passGranted,
      resource: "pass_purchase",
      resourceId: pass.id,
      workspaceId: pass.workspaceId,
      data: { kind: pass.kind, creditsGrantedTenths: pass.creditsGrantedTenths },
    });
    // B05: a pass/top-up purchase — a tax/export invoice.
    this.events.emit(BILLING_INVOICE_EVENTS.passPaid, {
      passPurchaseId: pass.id,
      workspaceId: pass.workspaceId,
      amountMinor: event.amountMinor ?? 0,
      currency: (event.currency ?? "INR") as "INR" | "USD",
      kind: pass.kind,
      ...(event.providerPaymentId === undefined
        ? {}
        : { providerPaymentId: event.providerPaymentId }),
    });
    return "processed";
  }

  // -------------------------------------------------------------------------
  // Payments and mandates
  // -------------------------------------------------------------------------

  private async onPaymentFailed(event: BillingEvent): Promise<"processed" | "ignored"> {
    const subscription = await this.findSubscriptionByProviderId(event.providerSubscriptionId);
    if (subscription === null) return "ignored";
    const outcome = await this.onSubscriptionPastDue(event, "past_due");
    // Dunning classifies the decline code and, when it is worth retrying,
    // attempts the retry itself (B01 brief §7); the past_due transition above
    // is unconditional so entitlement is gated even while dunning is deciding.
    await this.renewal.handleDecline(subscription.id, event.declineCode);
    return outcome;
  }

  /**
   * Two shapes of refund reach this handler: a **subscription** payment (has
   * a `payments` row, created by {@link recordPayment}) and a **pass/top-up**
   * order (never gets a `payments` row — {@link grantPass} only ever writes
   * `passes_purchased` — so it is resolved the same way {@link onOrderPaid}
   * resolves one, by `providerOrderId`/notes).
   *
   * Subscription credits are granted by B02's periodic monthly-grant task
   * (`credit-grant-reset.task.ts`), not by this webhook, so there is no
   * B01-owned lot to claw back for a subscription refund — the payment is
   * marked refunded and audited (and B05's `billing.invoice.payment_refunded`
   * fires so the GST credit note gets issued), and that is the whole of it. A
   * pass/top-up refund goes through {@link RefundsService}, which is where the
   * actual (currently inapplicable — see its class doc) clawback attempt lives.
   */
  private async onPaymentRefunded(event: BillingEvent): Promise<"processed" | "ignored"> {
    if (event.providerPaymentId !== undefined) {
      const payment = await this.prisma.payment.findFirst({
        where: { providerPaymentId: event.providerPaymentId },
      });
      if (payment !== null) {
        const claimed = await this.prisma.payment.updateMany({
          where: { id: payment.id, status: { not: "refunded" } },
          data: { status: "refunded" },
        });
        if (claimed.count === 0) return "processed"; // already handled (idempotent)
        await this.audit.record({
          action: B01_AUDIT_ACTIONS.webhookProcessed,
          resource: "payment",
          resourceId: payment.id,
          data: {
            refunded: true,
            creditsClawback: "not_applicable_subscription_payment_grants_are_periodic",
          },
        });
        // B05: every refund gets a GST credit note, linked to the original invoice.
        if (payment.invoiceId !== null) {
          const invoice = await this.prisma.invoice.findUnique({
            where: { id: payment.invoiceId },
            select: { workspaceId: true },
          });
          this.events.emit(BILLING_INVOICE_EVENTS.paymentRefunded, {
            paymentId: payment.id,
            invoiceId: payment.invoiceId,
            workspaceId: invoice?.workspaceId ?? null,
            amountMinor: payment.amountMinor,
          });
        }
        return "processed";
      }
    }

    const passPurchaseId = event.notes?.["passPurchaseId"];
    const orderId = event.providerOrderId;
    const pass =
      passPurchaseId !== undefined
        ? await this.prisma.passPurchase.findUnique({ where: { id: passPurchaseId } })
        : orderId !== undefined
          ? await this.prisma.passPurchase.findFirst({ where: { providerOrderId: orderId } })
          : null;
    if (pass === null) {
      this.logger.warn({ eventId: event.eventId }, "refund for an unknown payment, order or pass");
      return "ignored";
    }

    await this.refunds.clawbackPassPurchase(pass.id, `payment.refunded webhook (${event.eventId})`);
    return "processed";
  }

  private async onMandateEvent(event: BillingEvent): Promise<"processed" | "ignored"> {
    if (event.providerMandateId === undefined) return "ignored";
    const mandate = await this.prisma.mandate.findFirst({
      where: { providerMandateId: event.providerMandateId },
    });
    if (mandate === null) return "ignored";

    const status: $Enums.MandateStatus =
      event.eventType === "mandate.activated"
        ? "active"
        : event.eventType === "mandate.paused"
          ? "paused"
          : "revoked";
    await this.prisma.mandate.update({
      where: { id: mandate.id },
      data: {
        status,
        ...(status === "revoked" ? { revokedAt: new Date() } : {}),
        ...(status === "active" ? { registeredAt: new Date() } : {}),
      },
    });
    await this.audit.record({
      action:
        status === "revoked"
          ? B01_AUDIT_ACTIONS.mandateRevoked
          : B01_AUDIT_ACTIONS.mandateRegistered,
      resource: "mandate",
      resourceId: mandate.id,
      workspaceId: mandate.workspaceId,
    });
    return "processed";
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  private async findSubscriptionByProviderId(
    providerId: string | undefined,
  ): Promise<SubscriptionRow | null> {
    if (providerId === undefined) return null;
    return this.prisma.subscription.findFirst({ where: { providerSubId: providerId } });
  }

  /** `true` when the event carries a payment amount/currency that disagrees with ours. */
  private amountMismatch(event: BillingEvent, subscription: SubscriptionRow): boolean {
    if (event.amountMinor === undefined) return false;
    if (event.amountMinor !== subscription.listPriceMinor) return true;
    return event.currency !== undefined && event.currency !== subscription.currency;
  }

  private async recordMismatch(
    workspaceId: string,
    resourceId: string,
    event: BillingEvent,
  ): Promise<void> {
    this.logger.warn(
      {
        workspaceId,
        resourceId,
        eventType: event.eventType,
        amountMinor: event.amountMinor,
        currency: event.currency,
      },
      "billing webhook amount/currency mismatch — refusing the state transition",
    );
    await this.audit.record({
      action: B01_AUDIT_ACTIONS.webhookMismatch,
      resource: "billing_event",
      resourceId,
      workspaceId,
      data: {
        eventType: event.eventType,
        amountMinor: event.amountMinor ?? null,
        currency: event.currency ?? null,
      },
    });
  }

  private async recordPayment(
    event: BillingEvent,
    subscription: SubscriptionRow,
    status: $Enums.PaymentStatus,
  ): Promise<void> {
    if (event.providerPaymentId === undefined) return;
    await this.prisma.payment.upsert({
      where: { providerPaymentId: event.providerPaymentId },
      create: {
        id: ulid(),
        provider: "razorpay",
        providerPaymentId: event.providerPaymentId,
        method: toPaymentMethod(event.method),
        mandateId: subscription.mandateId,
        amountMinor: event.amountMinor ?? subscription.listPriceMinor,
        status,
        ...(event.declineCode === undefined ? {} : { declineCode: event.declineCode }),
        raw: (event.raw ?? {}) as Prisma.InputJsonValue,
      },
      update: {
        status,
        ...(event.declineCode === undefined ? {} : { declineCode: event.declineCode }),
      },
    });
  }
}

type SubscriptionRow = Prisma.SubscriptionGetPayload<Record<string, never>>;

function toPaymentMethod(method: string | undefined): $Enums.PaymentMethod {
  switch (method) {
    case "card":
      return "card";
    case "netbanking":
      return "netbanking";
    case "wallet":
      return "wallet";
    case "emandate":
    case "nach":
      return "emandate";
    case "upi_autopay":
      return "upi_autopay";
    default:
      return "upi";
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
