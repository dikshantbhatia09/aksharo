import Razorpay from "razorpay";

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
  type ProviderCurrency,
  type ProviderInterval,
  type RefundInput,
  type RefundResult,
  type RegisterMandateInput,
  type RegisterMandateResult,
} from "../provider.js";
import {
  normaliseRazorpayEvent,
  parseRazorpayWebhookBody,
  verifyRazorpayWebhookSignature,
} from "./webhook-envelope.js";

/**
 * Razorpay's Subscriptions API bills off a Razorpay-side `plan` object (period,
 * interval, amount), which is a different thing from our own `plans` table —
 * theirs is "how often and how much", ours is "which product tier". A month or
 * halfyear plan at a given price is created once and reused; there is no list
 * endpoint keyed the way we would want one, so this in-memory cache is what
 * keeps `createSubscription` from minting a duplicate Razorpay plan on every
 * checkout. It is process-local and cold on restart, which is acceptable: a
 * second `plans.create` for the same terms is idempotent from Razorpay's side
 * (a harmless extra plan object), never a correctness problem.
 */
interface RazorpayPlanKey {
  readonly planKey: string;
  readonly interval: ProviderInterval;
  readonly currency: ProviderCurrency;
  readonly amountMinor: number;
}

type RazorpayPeriod = "daily" | "weekly" | "monthly" | "yearly";

const RAZORPAY_PERIOD: Record<ProviderInterval, { period: RazorpayPeriod; interval: number }> = {
  month: { period: "monthly", interval: 1 },
  halfyear: { period: "monthly", interval: 6 },
  year: { period: "yearly", interval: 1 },
  once: { period: "monthly", interval: 1 },
};

function planCacheKey(input: RazorpayPlanKey): string {
  return `${input.planKey}:${input.interval}:${input.currency}:${String(input.amountMinor)}`;
}

/**
 * The production `BillingProvider`, over the official `razorpay` SDK.
 *
 * **Never exercised end to end in this work package** — there are no live
 * Razorpay keys in this environment (README "Manual live-key smoke test"). Every
 * call shape below is read from the SDK's own shipped source
 * (`node_modules/razorpay/dist/resources/*.js`), which is why the webhook
 * signature scheme (`X-Razorpay-Signature: hex(hmac_sha256(secret, rawBody))`,
 * confirmed in `dist/utils/razorpay-utils.js`) is asserted with confidence while
 * the exact request shape for a *variable-amount, capped* UPI Autopay mandate is
 * not — see the README's open questions.
 */
export class RazorpayProvider implements BillingProvider {
  private readonly client: Razorpay;
  private readonly keyId: string;
  private readonly webhookSecret: string;
  private readonly planCache = new Map<string, string>();

  constructor(keyId: string, keySecret: string, webhookSecret: string) {
    this.client = new Razorpay({ key_id: keyId, key_secret: keySecret });
    this.keyId = keyId;
    this.webhookSecret = webhookSecret;
  }

  async createCustomer(input: CreateCustomerInput): Promise<CreateCustomerResult> {
    try {
      const customer = await this.client.customers.create({
        name: input.name ?? input.email,
        email: input.email,
        ...(input.contact === undefined ? {} : { contact: input.contact }),
        notes: { workspaceId: input.workspaceId },
        // 06 has no `workspaces.providerCustomerId` column, so a customer is
        // looked up by email on every checkout rather than cached locally;
        // `fail_existing: 0` is what makes a second `createCustomer` for the
        // same email idempotent instead of a 400.
        fail_existing: 0,
      });
      return { providerCustomerId: customer.id };
    } catch (error) {
      throw wrap(error, "customer_create_failed");
    }
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<CreateSubscriptionResult> {
    const planId = await this.resolvePlan({
      planKey: input.planKey,
      interval: input.interval,
      currency: input.currency,
      amountMinor: input.amountMinor,
    });
    try {
      const subscription = await this.client.subscriptions.create({
        plan_id: planId,
        customer_notify: 1,
        quantity: 1,
        total_count: input.totalCount ?? defaultTotalCount(input.interval),
        ...(input.startAt === undefined
          ? {}
          : { start_at: Math.floor(input.startAt.getTime() / 1000) }),
        notes: {
          subscriptionId: input.subscriptionId,
          mandateCapMinor: String(input.mandateCapMinor),
          method: input.method,
          ...(input.notes ?? {}),
        },
      });
      return {
        providerSubscriptionId: subscription.id,
        status: subscription.status,
        checkout: {
          keyId: this.keyId,
          amountMinor: input.amountMinor,
          currency: input.currency,
          providerSubscriptionId: subscription.id,
          name: "Aksharo",
          description: `${input.planKey} (${input.interval})`,
          notes: { subscriptionId: input.subscriptionId },
        },
      };
    } catch (error) {
      throw wrap(error, "subscription_create_failed");
    }
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    try {
      const order = await this.client.orders.create({
        amount: input.amountMinor,
        currency: input.currency,
        receipt: input.refId,
        notes: { refId: input.refId, ...(input.notes ?? {}) },
      });
      return {
        providerOrderId: String(order.id),
        status: String(order.status),
        checkout: {
          keyId: this.keyId,
          amountMinor: input.amountMinor,
          currency: input.currency,
          providerOrderId: String(order.id),
          name: "Aksharo",
          description: input.purpose,
          notes: { refId: input.refId },
        },
      };
    } catch (error) {
      throw wrap(error, "order_create_failed");
    }
  }

  /**
   * D40: a mandate cannot be updated in place, only re-registered with fresh
   * authentication. Razorpay has no "update this subscription's mandate" call
   * either, so this creates a fresh subscription at the new cap and leaves
   * cancelling the old one to the caller (`SubscriptionService.changePlan`),
   * exactly as the fake provider does.
   */
  async registerMandate(input: RegisterMandateInput): Promise<RegisterMandateResult> {
    const created = await this.createSubscription({
      subscriptionId: input.subscriptionId,
      providerCustomerId: input.providerCustomerId,
      planKey: input.planKey,
      interval: input.interval,
      currency: input.currency,
      amountMinor: input.amountMinor,
      mandateCapMinor: input.mandateCapMinor,
      method: input.method,
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    });
    return { providerSubscriptionId: created.providerSubscriptionId, checkout: created.checkout };
  }

  async chargeRenewal(input: ChargeRenewalInput): Promise<ChargeRenewalResult> {
    // Razorpay auto-charges recurring mandates on schedule; there is no public
    // "charge now" call for a subscription. A manual retry after a decline goes
    // through `subscriptions.create` for a fresh addon charge in the real
    // account — not exercised here without live keys (README open questions).
    throw new BillingProviderError(
      "Manual renewal charges are not implemented against the live Razorpay API in this work package; " +
        "Razorpay auto-charges on schedule. See README open questions.",
      "manual_charge_unsupported",
      { providerSubscriptionId: input.providerSubscriptionId },
    );
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<void> {
    try {
      await this.client.subscriptions.cancel(input.providerSubscriptionId, input.atPeriodEnd);
    } catch (error) {
      throw wrap(error, "subscription_cancel_failed");
    }
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    try {
      const refund = await this.client.payments.refund(input.providerPaymentId, {
        amount: input.amountMinor,
        ...(input.reason === undefined ? {} : { notes: { reason: input.reason } }),
      });
      return { providerRefundId: refund.id, status: refund.status };
    } catch (error) {
      throw wrap(error, "refund_failed");
    }
  }

  parseWebhook(rawBody: string | Buffer, signature: string): BillingEvent {
    if (!verifyRazorpayWebhookSignature(this.webhookSecret, rawBody, signature)) {
      throw new BillingSignatureError();
    }
    const body = parseRazorpayWebhookBody(rawBody);
    if (body === undefined) throw new BillingSignatureError("Webhook body could not be parsed.");
    return normaliseRazorpayEvent(body);
  }

  async listPaymentMethods(input: ListPaymentMethodsInput): Promise<PaymentMethodView[]> {
    try {
      const tokens = await this.client.customers.fetchTokens(input.providerCustomerId);
      const items = (tokens as { items?: unknown[] }).items ?? [];
      return items.map((raw) => tokenToView(raw));
    } catch (error) {
      throw wrap(error, "payment_methods_failed");
    }
  }

  private async resolvePlan(input: RazorpayPlanKey): Promise<string> {
    const key = planCacheKey(input);
    const cached = this.planCache.get(key);
    if (cached !== undefined) return cached;

    const period = RAZORPAY_PERIOD[input.interval];
    try {
      const plan = await this.client.plans.create({
        period: period.period,
        interval: period.interval,
        item: {
          name: `${input.planKey} (${input.interval})`,
          amount: input.amountMinor,
          currency: input.currency,
        },
        notes: { planKey: input.planKey, interval: input.interval },
      });
      this.planCache.set(key, plan.id);
      return plan.id;
    } catch (error) {
      throw wrap(error, "plan_create_failed");
    }
  }
}

function defaultTotalCount(interval: ProviderInterval): number {
  switch (interval) {
    case "month":
      return 120; // 10 years of monthly cycles; Razorpay requires a bound.
    case "halfyear":
      return 20; // 10 years of half-yearly cycles.
    case "year":
      return 10; // 10 years of yearly cycles.
    case "once":
      return 1;
  }
}

function tokenToView(raw: unknown): PaymentMethodView {
  const record = raw as Record<string, unknown>;
  const method = typeof record["method"] === "string" ? record["method"] : "card";
  const card = record["card"] as Record<string, unknown> | undefined;
  return {
    method: method as PaymentMethodView["method"],
    label: card?.["network"] !== undefined ? `${String(card["network"])} card` : method,
    ...(typeof card?.["last4"] === "string" ? { last4: card["last4"] } : {}),
    ...(typeof card?.["network"] === "string" ? { network: card["network"] } : {}),
  };
}

/**
 * Razorpay rejects with `{statusCode, error: {code, description, ...}}`, not
 * necessarily an `Error` instance (the SDK's promise wrapper passes the API's
 * own JSON body straight through) — so both shapes are read defensively.
 */
function wrap(error: unknown, code: string): BillingProviderError {
  const record = error as { error?: { description?: string }; message?: string } | undefined;
  const description = record?.error?.description ?? record?.message;
  return new BillingProviderError(
    description ?? "Razorpay request failed.",
    code,
    description === undefined ? undefined : { cause: description },
  );
}
