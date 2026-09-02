import type { $Enums } from "@prisma/client";

/**
 * `BillingProvider` — the payment-rail interface every billing route codes
 * against (B01 brief §1).
 *
 * `RazorpayProvider` is the production implementation (the official `razorpay`
 * SDK); `FakeProvider` is what every test in this work package runs against —
 * there are no live Razorpay keys in this environment (see `README.md`
 * "Manual live-key smoke test"). Nothing outside `billing/providers/*` and
 * `billing/provider.factory.ts` may import the SDK or reach the network, which is
 * what lets the whole module be exercised without one.
 *
 * Money is always integer minor units (paise / cents) with an ISO currency
 * (CONTRACTS §0). Every method that can fail with a provider-side rejection
 * throws {@link BillingProviderError}.
 */
/**
 * DI token. A constructor injects the interface, not a class:
 *
 * ```ts
 * constructor(@Inject(BILLING_PROVIDER) private readonly provider: BillingProvider) {}
 * ```
 */
export const BILLING_PROVIDER = Symbol("BILLING_PROVIDER");

export interface BillingProvider {
  createCustomer(input: CreateCustomerInput): Promise<CreateCustomerResult>;

  /**
   * A recurring subscription. For UPI Autopay / eNACH this also registers the
   * mandate — Razorpay's Subscriptions API authenticates the mandate as part of
   * creating the subscription, there is no separate "create mandate" call for
   * that path. `mandateCapMinor` is always the undiscounted list price (D40);
   * the caller has already applied the ₹15,000 UPI rule before calling this.
   */
  createSubscription(input: CreateSubscriptionInput): Promise<CreateSubscriptionResult>;

  /** A one-time order: passes, top-ups, pay-once purchases. No mandate. */
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;

  /**
   * Re-authenticate a mandate at a new cap without creating a new subscription
   * object — the change-plan path when the new plan's list price exceeds the
   * currently-registered cap (D40: mandates cannot be updated in place, only
   * re-registered with fresh authentication).
   */
  registerMandate(input: RegisterMandateInput): Promise<RegisterMandateResult>;

  /**
   * Force a renewal charge against a mandate outside its normal cycle — used by
   * the dunning ladder's retry step and by `RenewalService.initiateRenewal` when
   * the provider does not auto-charge (e.g. the fake provider, or a manual retry
   * after a decline).
   */
  chargeRenewal(input: ChargeRenewalInput): Promise<ChargeRenewalResult>;

  cancelSubscription(input: CancelSubscriptionInput): Promise<void>;

  refund(input: RefundInput): Promise<RefundResult>;

  /**
   * Verify the webhook signature and return a normalised event. Throws
   * {@link BillingSignatureError} when the signature does not verify — the
   * caller (webhook controller) turns that into 401, never a 200.
   */
  parseWebhook(rawBody: string | Buffer, signature: string): BillingEvent;

  listPaymentMethods(input: ListPaymentMethodsInput): Promise<PaymentMethodView[]>;
}

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

export type ProviderCurrency = $Enums.Currency;
export type ProviderInterval = $Enums.BillingInterval;
export type ProviderMandateMethod = $Enums.MandateMethod;

/** Raised for a rejection the provider itself reports (declined, invalid, etc). */
export class BillingProviderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BillingProviderError";
  }
}

/** Raised by `parseWebhook` when the signature does not verify (THREAT-MODEL T16). */
export class BillingSignatureError extends Error {
  constructor(message = "Webhook signature is invalid.") {
    super(message);
    this.name = "BillingSignatureError";
  }
}

export interface CreateCustomerInput {
  readonly workspaceId: string;
  readonly email: string;
  readonly name?: string;
  readonly contact?: string;
}

export interface CreateCustomerResult {
  readonly providerCustomerId: string;
}

export interface CreateSubscriptionInput {
  readonly providerCustomerId: string;
  readonly planKey: $Enums.PlanKey;
  /** Our internal id, echoed back in the provider's `notes` so a webhook can resolve it. */
  readonly subscriptionId: string;
  readonly interval: ProviderInterval;
  readonly currency: ProviderCurrency;
  readonly amountMinor: number;
  /** Undiscounted list price — the mandate's cap (D40). */
  readonly mandateCapMinor: number;
  readonly method: ProviderMandateMethod;
  readonly startAt?: Date;
  readonly totalCount?: number;
  readonly notes?: Record<string, string>;
}

export interface CreateSubscriptionResult {
  readonly providerSubscriptionId: string;
  readonly providerMandateId?: string;
  readonly status: string;
  /** What the client renders to complete checkout (key id, prefill, short URL). */
  readonly checkout: ProviderCheckoutPayload;
}

export interface CreateOrderInput {
  readonly amountMinor: number;
  readonly currency: ProviderCurrency;
  readonly purpose: string;
  /** Our internal id (subscription, pass purchase or top-up), for webhook resolution. */
  readonly refId: string;
  readonly notes?: Record<string, string>;
}

export interface CreateOrderResult {
  readonly providerOrderId: string;
  readonly status: string;
  readonly checkout: ProviderCheckoutPayload;
}

export interface RegisterMandateInput {
  readonly providerCustomerId: string;
  readonly subscriptionId: string;
  readonly planKey: $Enums.PlanKey;
  readonly previousProviderSubscriptionId?: string;
  readonly interval: ProviderInterval;
  readonly currency: ProviderCurrency;
  readonly mandateCapMinor: number;
  readonly amountMinor: number;
  readonly method: ProviderMandateMethod;
  readonly notes?: Record<string, string>;
}

export interface RegisterMandateResult {
  readonly providerSubscriptionId: string;
  readonly checkout: ProviderCheckoutPayload;
}

export interface ChargeRenewalInput {
  readonly providerSubscriptionId: string;
  readonly amountMinor: number;
  readonly currency: ProviderCurrency;
}

export interface ChargeRenewalResult {
  readonly providerPaymentId: string;
  readonly status: string;
}

export interface CancelSubscriptionInput {
  readonly providerSubscriptionId: string;
  /** `true` lets the current period run out; `false` cancels immediately. */
  readonly atPeriodEnd: boolean;
}

export interface RefundInput {
  readonly providerPaymentId: string;
  readonly amountMinor: number;
  readonly reason?: string;
}

export interface RefundResult {
  readonly providerRefundId: string;
  readonly status: string;
}

export interface ListPaymentMethodsInput {
  readonly providerCustomerId: string;
}

export interface PaymentMethodView {
  readonly method: ProviderMandateMethod | "netbanking" | "wallet" | "upi";
  readonly label: string;
  readonly last4?: string;
  readonly network?: string;
  readonly isDefault?: boolean;
}

/** What the client SDK (Razorpay Checkout) needs to complete a payment. */
export interface ProviderCheckoutPayload {
  readonly keyId: string;
  readonly amountMinor: number;
  readonly currency: ProviderCurrency;
  readonly providerSubscriptionId?: string;
  readonly providerOrderId?: string;
  readonly name: string;
  readonly description: string;
  readonly prefill?: { readonly email?: string; readonly contact?: string };
  readonly notes?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * The Razorpay webhook entities this module understands (07 §Billing, B01 brief
 * §5): `subscription.authenticated/activated/charged/pending/halted/cancelled/
 * completed`, `payment.captured/failed/refunded`, `order.paid`, and mandate
 * events (normalised to the `mandate.*` family below — see the README's open
 * question on exact Razorpay mandate event names, which RR-05 did not confirm).
 */
export const BILLING_EVENT_TYPES = [
  "subscription.authenticated",
  "subscription.activated",
  "subscription.charged",
  "subscription.pending",
  "subscription.halted",
  "subscription.cancelled",
  "subscription.completed",
  "payment.captured",
  "payment.failed",
  "payment.refunded",
  "order.paid",
  "mandate.activated",
  "mandate.revoked",
  "mandate.paused",
] as const;

export type BillingEventType = (typeof BILLING_EVENT_TYPES)[number];

export function isBillingEventType(value: string): value is BillingEventType {
  return (BILLING_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * A verified, normalised webhook event. `raw` is the full provider payload,
 * stored verbatim in `billing_events.payload` for audit and dispute evidence.
 * `notes` carries whatever our own `notes`/`receipt` fields on the order or
 * subscription said, which is how a one-time order (no `providerSubId` on our
 * side to look up) resolves back to a `subscriptions`, `passes_purchased` or
 * top-up row.
 */
export interface BillingEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly providerSubscriptionId?: string;
  readonly providerOrderId?: string;
  readonly providerPaymentId?: string;
  readonly providerMandateId?: string;
  readonly amountMinor?: number;
  readonly currency?: ProviderCurrency;
  readonly status?: string;
  readonly declineCode?: string;
  readonly method?: string;
  readonly notes?: Record<string, string>;
  readonly createdAt: Date;
  readonly raw: unknown;
}
