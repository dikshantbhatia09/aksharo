/**
 * Webhook delivery tuning (B14 brief §4).
 *
 * Retries at 1m, 5m, 30m, 2h, 12h — five attempts after the first — then the
 * delivery is `exhausted`. 20 **consecutive** failed endpoints (across
 * deliveries, not attempts of one delivery) auto-disable the endpoint.
 */
export const WEBHOOK_RETRY_SCHEDULE_MS: readonly number[] = [
  60_000, // 1 minute
  5 * 60_000, // 5 minutes
  30 * 60_000, // 30 minutes
  2 * 60 * 60_000, // 2 hours
  12 * 60 * 60_000, // 12 hours
];

/** First attempt plus every retry in {@link WEBHOOK_RETRY_SCHEDULE_MS}. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_SCHEDULE_MS.length + 1;

/** Consecutive failures across an endpoint's deliveries before it is auto-disabled. */
export const WEBHOOK_AUTO_DISABLE_THRESHOLD = 20;

/** Every event a webhook endpoint may subscribe to (B14 §4). Stored as `String[]` in the schema. */
export const WEBHOOK_EVENTS = [
  "transcript.completed",
  "export.completed",
  "job.failed",
  "credits.low",
] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

/** How often the delivery sweep looks for due deliveries. */
export const WEBHOOK_SWEEP_INTERVAL_MS = 15_000;

/** Deliveries dispatched per sweep tick, so one pass cannot hold the loop forever. */
export const WEBHOOK_SWEEP_BATCH = 50;

/** Per-attempt HTTP timeout. */
export const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;

export const WEBHOOK_ERRORS = {
  endpointNotFound: "webhooks/endpoint_not_found",
  invalidUrl: "webhooks/invalid_url",
  deliveryNotFound: "webhooks/delivery_not_found",
} as const;
