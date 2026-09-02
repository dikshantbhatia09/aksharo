# webhooks

Outgoing webhooks: endpoint CRUD (`webhooks.controller.ts`,
`webhook-endpoints.service.ts`), signed retried delivery
(`webhook-delivery.service.ts`, `webhook-signature.ts`), and the event
listeners that feed it (`listeners/`).

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

Every one of the four subscribable events (`webhooks.constants.ts`'s
`WEBHOOK_EVENTS`) is a real `EventEmitter2` emit at its producer, picked up
by a listener in `listeners/` that calls `WebhookDeliveryService.emit()`.
B14b removed `WebhookEventPollerService` (the `jobs`/`notifications`
Redis-cursor poller B14 shipped for three of these) once each producer could
take the one-line edit directly:

| Event                  | Emitted from                                                                                           | Listener                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `export.completed`     | `exports/exports.service.ts`, `exports/render-completion.handler.ts` (B07b)                            | `listeners/export-completed.listener.ts`     |
| `transcript.completed` | `transcripts/transcribe.handler.ts`, right after the transcript is persisted and the EDG initialised   | `listeners/transcript-completed.listener.ts` |
| `job.failed`           | `jobs/jobs.service.ts::complete()`, once the row is `failed` and dead-letter handling (if any) has run | `listeners/job-failed.listener.ts`           |
| `credits.low`          | `credits/credits-low-balance.notifier.ts`, where it already raises the `low-credits` notification      | `listeners/credits-low.listener.ts`          |

Each producer's own event-name/payload contract lives next to it —
`transcripts/transcript-completed.event.ts`, `jobs/job-failed.event.ts`,
`credits/credits-low.event.ts` — the same shape
`referrals/export-completed.event.ts` already established for
`export.completed`, so the producer and this module's listener agree on the
event without either importing the other's internals.

`webhooks.e2e-spec.ts` proves the whole chain end to end: an API key, a
`/v1` project, a simulated worker completion, and a real signed HTTP
delivery to an in-process receiver (`WebhookDeliveryService.sendOverride`,
a test seam parallel to `sendWebhook`'s own `resolver`/`transport` seams,
since a receiver bound to `127.0.0.1` is exactly what `resolveSafeTarget`
exists to refuse in production).
