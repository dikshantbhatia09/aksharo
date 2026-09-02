/**
 * Event names and payloads `billing/webhooks.service.ts` emits at the points
 * where it already transitions a subscription/order/pass to paid, or a
 * payment to refunded (brief §2: "generation triggered by B01 payment events
 * ... and refunds"; setup instructions: "register listeners, do not fork the
 * state machine").
 *
 * `WebhooksService` emits these with `EventEmitter2` (`@nestjs/event-emitter`,
 * registered once in `app.module.ts` via `EventEmitterModule.forRoot()`) right
 * after each existing state transition commits — no branch of its state
 * machine is duplicated or re-implemented here, only observed. This module
 * owns the event *contract* (names + payload shape) so `WebhooksService` (B01,
 * outside this work package's file boundary) and this work package's own
 * `BillingEventsListener` agree on it without either importing the other's
 * internals.
 *
 * **Deviation, flagged for the orchestrator:** emitting these events requires
 * two small, additive edits outside the brief's stated file boundary
 * (`apps/api/src/billing/webhooks.service.ts` and `billing.module.ts` remain
 * B01's files) — `EventEmitter2` injected into the constructor and one
 * `this.events.emit(...)` call added after each of the five existing
 * "processed" transitions. No branch, return type or existing behaviour of
 * `WebhooksService` changes; every one of B01's own billing tests should keep
 * passing unmodified. This was necessary because the setup instructions
 * explicitly ask for "listeners" on "the payment/refund events that must
 * trigger invoice and credit-note generation", which cannot exist without
 * something in `billing/` emitting them. Reported per "implement the brief
 * exactly and report conflicts instead of redesigning."
 */

export const BILLING_INVOICE_EVENTS = {
  /** A recurring subscription's first charge (activation) or a renewal charge. */
  subscriptionCharged: "billing.subscription.charged",
  /** A one-time (`interval: "once"`) subscription/order paid. */
  orderPaid: "billing.order.paid",
  /** A pass or top-up purchase paid. */
  passPaid: "billing.pass.paid",
  /** A payment refunded — triggers a credit note. */
  paymentRefunded: "billing.payment.refunded",
} as const;

export interface SubscriptionChargedEvent {
  readonly subscriptionId: string;
  readonly workspaceId: string;
  readonly amountMinor: number;
  readonly currency: "INR" | "USD";
  readonly providerPaymentId?: string;
  readonly isFirstCharge: boolean;
}

export interface OrderPaidEvent {
  readonly subscriptionId: string;
  readonly workspaceId: string;
  readonly amountMinor: number;
  readonly currency: "INR" | "USD";
  readonly providerPaymentId?: string;
}

export interface PassPaidEvent {
  readonly passPurchaseId: string;
  readonly workspaceId: string;
  readonly amountMinor: number;
  readonly currency: "INR" | "USD";
  readonly kind: string;
  readonly providerPaymentId?: string;
}

export interface PaymentRefundedEvent {
  readonly paymentId: string;
  readonly invoiceId: string | null;
  readonly workspaceId: string | null;
  readonly amountMinor: number;
  readonly reasonCode?: string;
}
