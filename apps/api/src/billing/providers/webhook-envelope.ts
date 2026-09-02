import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { BillingEvent, ProviderCurrency } from "../provider.js";

/**
 * The Razorpay webhook envelope, shared by {@link FakeProvider} (which emits
 * fixtures shaped exactly like this) and {@link RazorpayProvider} (which parses
 * the real thing), so `webhooks.service.ts` handles one normalised shape
 * regardless of which provider is wired up.
 *
 * **Signature.** `X-Razorpay-Signature: hex(hmac_sha256(webhook_secret, raw_body))`
 * — documented Razorpay behaviour, mirrored here exactly as CONTRACTS §3 mirrors
 * it for worker callbacks.
 *
 * **Event id.** Razorpay's webhook JSON body does not carry a stable top-level
 * event id in every account configuration; some deliveries add an
 * `X-Razorpay-Event-Id` header instead, which this interface's `parseWebhook`
 * cannot see (`docs/CONTRACTS.md`/the B01 brief pin its signature to
 * `(rawBody, signature)`). Rather than depend on a header that could not be
 * verified without a live account, the event id is **derived from the body**:
 * `sha256(event + "|" + primaryEntityId + "|" + created_at)`. That is stable
 * across retries of the same delivery (a replay reproduces the same body) and
 * distinct across events, which is everything THREAT-MODEL T16's idempotency
 * requirement needs — see the README's open question if a live account later
 * shows the header disagreeing with this derivation.
 */

export interface RazorpayEntity {
  readonly id: string;
  readonly status?: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly notes?: Record<string, string>;
  readonly method?: string;
  readonly error_code?: string;
  readonly subscription_id?: string;
  readonly order_id?: string;
  readonly [key: string]: unknown;
}

export interface RazorpayWebhookBody {
  readonly entity: "event";
  readonly account_id?: string;
  readonly event: string;
  readonly created_at: number;
  readonly payload: {
    readonly subscription?: { readonly entity: RazorpayEntity };
    readonly payment?: { readonly entity: RazorpayEntity };
    readonly order?: { readonly entity: RazorpayEntity };
    readonly refund?: { readonly entity: RazorpayEntity };
    readonly mandate?: { readonly entity: RazorpayEntity };
  };
}

export function signRazorpayWebhook(secret: string, rawBody: string | Buffer): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyRazorpayWebhookSignature(
  secret: string,
  rawBody: string | Buffer,
  signature: string,
): boolean {
  const expected = signRazorpayWebhook(secret, rawBody);
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(signature, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** The entity a given event type carries as its primary subject. */
function primaryEntity(body: RazorpayWebhookBody): RazorpayEntity | undefined {
  return (
    body.payload.subscription?.entity ??
    body.payload.payment?.entity ??
    body.payload.order?.entity ??
    body.payload.refund?.entity ??
    body.payload.mandate?.entity
  );
}

export function deriveEventId(body: RazorpayWebhookBody): string {
  const entityId = primaryEntity(body)?.id ?? "no-entity";
  return createHash("sha256")
    .update(`${body.event}|${entityId}|${String(body.created_at)}`)
    .digest("hex");
}

export function parseRazorpayWebhookBody(
  rawBody: string | Buffer,
): RazorpayWebhookBody | undefined {
  try {
    const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "event" in parsed &&
      "payload" in parsed &&
      typeof (parsed as { event: unknown }).event === "string"
    ) {
      return parsed as RazorpayWebhookBody;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function asCurrency(value: string | undefined): ProviderCurrency | undefined {
  return value === "INR" || value === "USD" ? value : undefined;
}

/** Body → the normalised {@link BillingEvent} every downstream handler reads. */
export function normaliseRazorpayEvent(body: RazorpayWebhookBody): BillingEvent {
  const subscription = body.payload.subscription?.entity;
  const payment = body.payload.payment?.entity;
  const order = body.payload.order?.entity;
  const mandate = body.payload.mandate?.entity;
  const primary = primaryEntity(body);

  return {
    eventId: deriveEventId(body),
    eventType: body.event,
    ...(subscription?.id === undefined ? {} : { providerSubscriptionId: subscription.id }),
    ...((order?.id ?? payment?.order_id) === undefined
      ? {}
      : { providerOrderId: order?.id ?? payment?.order_id }),
    ...(payment?.id === undefined ? {} : { providerPaymentId: payment.id }),
    ...(mandate?.id === undefined ? {} : { providerMandateId: mandate.id }),
    ...(payment?.amount === undefined ? {} : { amountMinor: payment.amount }),
    ...(asCurrency(payment?.currency) === undefined
      ? {}
      : { currency: asCurrency(payment?.currency) }),
    ...(primary?.status === undefined ? {} : { status: primary.status }),
    ...(payment?.error_code === undefined ? {} : { declineCode: payment.error_code }),
    ...(payment?.method === undefined ? {} : { method: payment.method }),
    ...((subscription?.notes ?? order?.notes ?? payment?.notes) === undefined
      ? {}
      : { notes: subscription?.notes ?? order?.notes ?? payment?.notes }),
    createdAt: new Date(body.created_at * 1000),
    raw: body,
  };
}
