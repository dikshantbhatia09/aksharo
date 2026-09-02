import { Injectable } from "@nestjs/common";

import {
  BillingProviderError,
  BillingSignatureError,
  type BillingEvent,
  type BillingProvider,
  type CancelSubscriptionInput,
  type ChargeRenewalInput,
  type ChargeRenewalResult,
  type CreateCustomerInput,
  type CreateCustomerResult,
  type CreateOrderInput,
  type CreateOrderResult,
  type CreateSubscriptionInput,
  type CreateSubscriptionResult,
  type ListPaymentMethodsInput,
  type PaymentMethodView,
  type RefundInput,
  type RefundResult,
  type RegisterMandateInput,
  type RegisterMandateResult,
} from "../provider.js";
import {
  normaliseRazorpayEvent,
  parseRazorpayWebhookBody,
  signRazorpayWebhook,
  verifyRazorpayWebhookSignature,
  type RazorpayWebhookBody,
} from "./webhook-envelope.js";

/** In-memory shadow of what a real Razorpay subscription/order looks like. */
interface FakeSubscription {
  id: string;
  status: string;
  amountMinor: number;
  currency: string;
  method: string;
  mandateCapMinor: number;
  notes: Record<string, string>;
  providerMandateId: string;
}

interface FakeOrder {
  id: string;
  status: string;
  amountMinor: number;
  currency: string;
  notes: Record<string, string>;
}

/**
 * A realistic in-memory Razorpay: every test in this work package runs against
 * it, because there are no live Razorpay keys in this environment (README
 * "Manual live-key smoke test"). It emits webhook fixtures shaped exactly like
 * `RazorpayProvider` would parse — same envelope, same signature scheme — so
 * `webhooks.service.ts` never branches on which provider produced an event.
 *
 * Two extra methods beyond {@link BillingProvider} exist purely for tests:
 * {@link emitWebhook} builds and signs a fixture for something that already
 * happened at the provider (a checkout, a renewal), and {@link signRaw} lets a
 * test produce a *wrong* signature on purpose (the tamper acceptance test).
 */
@Injectable()
export class FakeProvider implements BillingProvider {
  private readonly webhookSecret: string;
  private readonly customers = new Map<string, string>();
  private readonly subscriptions = new Map<string, FakeSubscription>();
  private readonly orders = new Map<string, FakeOrder>();
  /** Test hook: every `refund()` call, in order. */
  readonly refunds: { providerPaymentId: string; amountMinor: number }[] = [];
  private counter = 0;

  constructor(webhookSecret = "fake_test_webhook_secret") {
    this.webhookSecret = webhookSecret;
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_fake_${String(this.counter).padStart(6, "0")}`;
  }

  async createCustomer(input: CreateCustomerInput): Promise<CreateCustomerResult> {
    const existing = this.customers.get(input.workspaceId);
    if (existing !== undefined) return { providerCustomerId: existing };
    const providerCustomerId = this.nextId("cust");
    this.customers.set(input.workspaceId, providerCustomerId);
    return Promise.resolve({ providerCustomerId });
  }

  createSubscription(input: CreateSubscriptionInput): Promise<CreateSubscriptionResult> {
    const providerSubscriptionId = this.nextId("sub");
    const providerMandateId = this.nextId("token");
    this.subscriptions.set(providerSubscriptionId, {
      id: providerSubscriptionId,
      status: "created",
      amountMinor: input.amountMinor,
      currency: input.currency,
      method: input.method,
      mandateCapMinor: input.mandateCapMinor,
      notes: { subscriptionId: input.subscriptionId, ...(input.notes ?? {}) },
      providerMandateId,
    });
    return Promise.resolve({
      providerSubscriptionId,
      providerMandateId,
      status: "created",
      checkout: {
        keyId: "rzp_test_fake",
        amountMinor: input.amountMinor,
        currency: input.currency,
        providerSubscriptionId,
        name: "Aksharo",
        description: `${input.planKey} (${input.interval})`,
        notes: { subscriptionId: input.subscriptionId },
      },
    });
  }

  createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const providerOrderId = this.nextId("order");
    this.orders.set(providerOrderId, {
      id: providerOrderId,
      status: "created",
      amountMinor: input.amountMinor,
      currency: input.currency,
      notes: { refId: input.refId, ...(input.notes ?? {}) },
    });
    return Promise.resolve({
      providerOrderId,
      status: "created",
      checkout: {
        keyId: "rzp_test_fake",
        amountMinor: input.amountMinor,
        currency: input.currency,
        providerOrderId,
        name: "Aksharo",
        description: input.purpose,
        notes: { refId: input.refId },
      },
    });
  }

  registerMandate(input: RegisterMandateInput): Promise<RegisterMandateResult> {
    const providerSubscriptionId = this.nextId("sub");
    const providerMandateId = this.nextId("token");
    this.subscriptions.set(providerSubscriptionId, {
      id: providerSubscriptionId,
      status: "created",
      amountMinor: input.amountMinor,
      currency: input.currency,
      method: input.method,
      mandateCapMinor: input.mandateCapMinor,
      notes: { subscriptionId: input.subscriptionId, ...(input.notes ?? {}) },
      providerMandateId,
    });
    return Promise.resolve({
      providerSubscriptionId,
      checkout: {
        keyId: "rzp_test_fake",
        amountMinor: input.amountMinor,
        currency: input.currency,
        providerSubscriptionId,
        name: "Aksharo",
        description: "mandate re-registration",
        notes: { subscriptionId: input.subscriptionId },
      },
    });
  }

  chargeRenewal(input: ChargeRenewalInput): Promise<ChargeRenewalResult> {
    const subscription = this.subscriptions.get(input.providerSubscriptionId);
    if (subscription === undefined) {
      throw new BillingProviderError("No such subscription.", "subscription_not_found");
    }
    return Promise.resolve({ providerPaymentId: this.nextId("pay"), status: "captured" });
  }

  cancelSubscription(input: CancelSubscriptionInput): Promise<void> {
    const subscription = this.subscriptions.get(input.providerSubscriptionId);
    if (subscription !== undefined) subscription.status = "cancelled";
    return Promise.resolve();
  }

  refund(input: RefundInput): Promise<RefundResult> {
    this.refunds.push({
      providerPaymentId: input.providerPaymentId,
      amountMinor: input.amountMinor,
    });
    return Promise.resolve({ providerRefundId: this.nextId("rfnd"), status: "processed" });
  }

  parseWebhook(rawBody: string | Buffer, signature: string): BillingEvent {
    if (!verifyRazorpayWebhookSignature(this.webhookSecret, rawBody, signature)) {
      throw new BillingSignatureError();
    }
    const body = parseRazorpayWebhookBody(rawBody);
    if (body === undefined) {
      throw new BillingSignatureError("Webhook body could not be parsed.");
    }
    return normaliseRazorpayEvent(body);
  }

  listPaymentMethods(input: ListPaymentMethodsInput): Promise<PaymentMethodView[]> {
    // A workspace with no registered customer yet has nothing on file.
    const known = [...this.customers.values()].includes(input.providerCustomerId);
    if (!known) return Promise.resolve([]);
    return Promise.resolve([
      { method: "upi", label: "UPI", isDefault: true },
      { method: "card", label: "Visa •••• 4242", last4: "4242", network: "Visa" },
    ]);
  }

  // -------------------------------------------------------------------------
  // Test-only surface
  // -------------------------------------------------------------------------

  /** Sign arbitrary bytes with the fake's own webhook secret. Test helper. */
  signRaw(rawBody: string | Buffer): string {
    return signRazorpayWebhook(this.webhookSecret, rawBody);
  }

  /** Sign with a secret that is deliberately wrong — the tamper acceptance test. */
  signWrong(rawBody: string | Buffer): string {
    return signRazorpayWebhook(`not-${this.webhookSecret}`, rawBody);
  }

  /**
   * Build and sign a webhook fixture, shaped exactly like the real Razorpay
   * envelope, for something this fake provider is holding.
   */
  emitWebhook(input: {
    readonly event: string;
    readonly providerSubscriptionId?: string;
    readonly providerOrderId?: string;
    readonly amountMinor?: number;
    readonly currency?: string;
    readonly status?: string;
    readonly paymentStatus?: string;
    readonly declineCode?: string;
    readonly method?: string;
    readonly notes?: Record<string, string>;
    /**
     * Unix seconds this event happened at. Defaults to now; a caller building
     * more than one fixture for the same subscription within the same test
     * (two renewal charges, say) should space these out — `deriveEventId`
     * folds `created_at` into the idempotency key precisely so two real
     * charges months apart never collide, which means two *synthetic* ones a
     * millisecond apart in a test would, unless told otherwise.
     */
    readonly createdAt?: number;
  }): { rawBody: string; signature: string } {
    const subscription =
      input.providerSubscriptionId === undefined
        ? undefined
        : this.subscriptions.get(input.providerSubscriptionId);
    const order =
      input.providerOrderId === undefined ? undefined : this.orders.get(input.providerOrderId);

    if (subscription !== undefined && input.status !== undefined)
      subscription.status = input.status;
    if (order !== undefined && input.status !== undefined) order.status = input.status;

    const amountMinor = input.amountMinor ?? subscription?.amountMinor ?? order?.amountMinor ?? 0;
    const currency = input.currency ?? subscription?.currency ?? order?.currency ?? "INR";
    const notes = input.notes ?? subscription?.notes ?? order?.notes ?? {};
    const paymentId = this.nextId("pay");

    const body: RazorpayWebhookBody = {
      entity: "event",
      event: input.event,
      created_at: input.createdAt ?? Math.floor(Date.now() / 1000),
      payload: {
        ...(subscription === undefined
          ? {}
          : {
              subscription: {
                entity: {
                  id: subscription.id,
                  status: subscription.status,
                  notes: subscription.notes,
                },
              },
            }),
        ...(order === undefined
          ? {}
          : { order: { entity: { id: order.id, status: order.status, notes: order.notes } } }),
        // A real Razorpay `subscription.authenticated/activated/charged` and
        // `payment.*`/`order.paid` webhook all carry a nested `payment`
        // entity; so does any event a caller explicitly gave payment details
        // for (an amount, a decline code, an explicit payment status).
        ...(input.event.startsWith("payment.") ||
        input.event === "order.paid" ||
        input.event.startsWith("subscription.") ||
        input.amountMinor !== undefined ||
        input.declineCode !== undefined ||
        input.paymentStatus !== undefined
          ? {
              payment: {
                entity: {
                  id: paymentId,
                  status: input.paymentStatus ?? "captured",
                  amount: amountMinor,
                  currency,
                  method: input.method ?? "upi",
                  notes,
                  ...(subscription === undefined ? {} : { subscription_id: subscription.id }),
                  ...(order === undefined ? {} : { order_id: order.id }),
                  ...(input.declineCode === undefined ? {} : { error_code: input.declineCode }),
                },
              },
            }
          : {}),
      },
    };

    const rawBody = JSON.stringify(body);
    return { rawBody, signature: this.signRaw(rawBody) };
  }

  /** Test hook: reset all in-memory state between suites. */
  reset(): void {
    this.customers.clear();
    this.subscriptions.clear();
    this.orders.clear();
    this.counter = 0;
  }
}
