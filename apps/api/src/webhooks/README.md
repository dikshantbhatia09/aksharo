# webhooks

Outgoing webhooks: endpoint CRUD (`webhooks.controller.ts`,
`webhook-endpoints.service.ts`), signed retried delivery
(`webhook-delivery.service.ts`, `webhook-signature.ts`), and the event
sources that feed it (`listeners/`, `webhook-event-poller.service.ts`).

## Endpoints and CRUD

`WebhookEndpoint`/`WebhookDelivery` (Prisma) predate this WP — the schema
already had them. `WebhookEndpointsService` validates a new/updated URL
**https-only and SSRF-guarded at creation time** (`resolveSafeTarget`, A06),
so a bad URL is caught immediately rather than sitting there generating
failed deliveries. `CommonAuditService` records every create/update/delete.

## Delivery

`WebhookDeliveryService.emit()` fans one product event out to every active
subscribed endpoint as a `pending` `WebhookDelivery` row.
`WebhookDeliverySweepTask` (a `common/scheduler` periodic task — the same
primitive B16's retention sweeps use, not a new BullMQ queue) calls
`dispatchDue()` every 15s, which sends each due delivery through
`common/ssrf/webhook-fetch.ts` — a POST analogue of `safe-fetch.ts` that
re-resolves and re-pins the endpoint's address on **every** attempt, so a
DNS change between creation and delivery (or between two retries) cannot
redirect a delivery at a private address.

Signature: `X-Aksharo-Signature: t=<unix>,v1=hmac_sha256(secret, t + "." +
body)` (`webhook-signature.ts`). `webhook-signature.test.ts` executes the
_exact_ Node snippet `/developers` renders under "Verify a webhook"
(`webhook-doc-snippets.ts`) against `signWebhookPayload`'s own output — the
doc and the implementation cannot silently drift, which is B14 acceptance
criterion 2.

Retry schedule: 1m, 5m, 30m, 2h, 12h, then `dead` (`webhooks.constants.ts`).
20 consecutive failures (tracked on the endpoint, reset on any success)
auto-disables it. Manual redeliver creates a fresh delivery row rather than
mutating the exhausted one, so the original attempt history stays intact in
the log.

## Event sources

- `export.completed` — `listeners/export-completed.listener.ts` subscribes
  to the `EventEmitter2` event of that exact name, already emitted by
  `exports/exports.service.ts` and `exports/render-completion.handler.ts`
  for B07b's referral loop. No file outside this WP's boundaries changed.
- `transcript.completed` / `job.failed` / `credits.low` — nothing in
  `transcripts/`, `jobs/` or `credits/` emits an event for these today, and
  adding one is an edit to files outside this WP's boundaries.
  `WebhookEventPollerService` instead polls `jobs`
  (`type = "ai.transcribe" AND status = "succeeded"`, and separately
  `status = "failed"` for any type) and `notifications`
  (`kind = "low-credits"`, already written by
  `credits/credits-low-balance.notifier.ts`), each with its own
  "last id seen" cursor in Redis, primed at "now" on first run rather than
  replaying history. **This is a deviation from the brief**, which describes
  emitting these events directly from their producers; see the WP's final
  report and this file's top-level doc comment on `webhook-event-poller.service.ts`
  for the reasoning (avoiding a merge collision with B11/B18, which are
  actively changing `transcripts/`/the worker in parallel) and the migration
  path (swap a stream for a real `EventEmitter2` emit later; the poller's
  public shape does not need to change).
