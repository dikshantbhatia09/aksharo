# Runbook — on-call

The index every alert in `infra/observability/alerts/montaj-alerts.yaml` should
point an on-call engineer at. If you were paged and landed here without a link
telling you which runbook to open next, match the alert name below.

---

## Rotation (template — H-27 names the people)

- One primary, one secondary, weekly handoff (Monday 09:00 IST).
- Primary acknowledges a page within **5 minutes**; escalates to secondary if
  unacknowledged at 10 minutes, then to the founder at 20 minutes.
- Handoff is a written note, not a meeting: open incidents, anything flapping,
  anything silenced and why, anything deployed in the last 24 hours.
- **[DRAFT — H-27]** Names, phone numbers and the paging tool (PagerDuty /
  Opsgenie / a WhatsApp group — not yet chosen) are pending; this runbook is
  written so any of those can be filled in without changing the escalation
  logic above.

## Escalation by alert

| Alert (`montaj-alerts.yaml`)                                                     | Meaning                                                                                       | Go to                                                                                                                                |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `MontajApiHigh5xxRate`, `MontajApiElevated5xxRate`                               | API error rate SLO breach                                                                     | Check `kubectl -n montaj logs deploy/montaj-api --since=15m`; if the database or Redis is the cause, `GET /health/ready` shows which |
| `MontajApiLatencySloBreach`, `MontajApiLatencySevere`                            | API p95 above `05-system-architecture.md` §10's 300 ms SLO                                    | Same as above; check `montaj_postgres_connections` for pool exhaustion first — the most common cause                                 |
| `MontajAdmissionControlSustained`                                                | 429s sustained — either genuine overload or a stuck downstream                                | §"Queue drain" below                                                                                                                 |
| `MontajJobFailureRateHigh`, `MontajJobSuccessBelowSlo`                           | Job success below the 99.5% SLO                                                               | Identify the failing `type`/provider from the jobs dashboard, then see "Provider outage failover"                                    |
| `MontajDlqNonEmpty`, `MontajDlqGrowing`                                          | Jobs exhausted retries                                                                        | [dlq-replay.md](dlq-replay.md)                                                                                                       |
| `MontajCallbackForgerySuspected`                                                 | An unsigned/mis-signed worker completion callback                                             | Treat as a security event — see `breach-first-hour.md`'s "declare an incident" step, do not just silence it                          |
| `MontajQueueWaitHigh`, `MontajQueueStalled`, `MontajQueueDepthGrowing`           | §"Queue drain" below                                                                          |                                                                                                                                      |
| `MontajGpuNoWarmWorker`, `MontajGpuColdStartsFrequent`, `MontajGpuDutyCycleHigh` | [scale-gpu.md](scale-gpu.md)                                                                  |                                                                                                                                      |
| `MontajCogsPerCreditAboveMarginFloor`, `MontajCogsExceedsRevenue`                | Cost problem, not an availability problem — [scale-gpu.md](scale-gpu.md) §5                   |                                                                                                                                      |
| `MontajRawBucketEgress`                                                          | Raw S3 bucket serving egress traffic — should be ≈0 (D35); investigate before assuming benign |                                                                                                                                      |
| `MontajPostgresDiskFilling`, `MontajPostgresDiskCritical`                        | Storage pressure on the primary                                                               | Check for a runaway table (`job_events`, `access_logs` retention jobs stalled?) before resizing                                      |
| `MontajRedisMemoryHigh`                                                          | Session/queue memory pressure                                                                 | Check for an unbounded key pattern before evicting                                                                                   |
| `MontajNodeDiskPressure`                                                         | Node-level disk pressure                                                                      | Standard k8s node triage                                                                                                             |
| `MontajExternalSecretNotReady`                                                   | A secret failed to sync                                                                       | [rotate-secrets.md](rotate-secrets.md)                                                                                               |

## Queue drain

Symptom: `MontajQueueDepthGrowing`/`MontajQueueStalled`/`MontajAdmissionControlSustained`
and workers are up but not draining.

1. Confirm workers are actually consuming: `kubectl -n montaj get pods -l app.kubernetes.io/component=worker`.
2. Check per-queue depth and wait against `montaj-service-health` dashboard
   (`infra/observability/dashboards/montaj-service-health.json`).
3. If one queue is stalled specifically (not all of them), it is almost always
   a provider outage — see below — or a poison job repeatedly crashing the
   worker on the same payload; find it with
   `kubectl -n montaj logs deploy/montaj-worker-ai --since=30m | grep -c "same jobId"`.
4. A poison job: cancel it (`AdminJobsController.cancel`,
   `POST /admin/jobs/:id/cancel`) rather than restarting the worker repeatedly.
5. Genuine backlog with no single bad job: [scale-gpu.md](scale-gpu.md) §2 for
   the AI queues, or scale the CPU media-worker deployment for `media`/`clean`.

## DLQ replay

A job in the DLQ already exhausted its retries. [dlq-replay.md](dlq-replay.md)
is the full procedure; the short version — inspect via
`GET /admin/dlq` (A08b), fix the underlying cause first (a provider outage, a
bad payload, a bug), then replay via `POST /admin/dlq/:id/replay`. Replaying
before fixing the cause just re-fills the DLQ.

## Provider outage failover (A10's routing chain)

A10's ASR routing is a chain — Sarvam (Hinglish/Indic primary) → ElevenLabs →
AssemblyAI → serverless GPU (`large-v3-turbo`) — and a provider outage should
already fail over automatically per that chain's circuit breaker. If it is not
failing over:

1. Confirm the provider is actually down, not rate-limiting:
   `montaj_provider_errors_total{provider="..."}` broken down by error code —
   429s should not open the circuit the same way 5xx/timeouts do.
2. Force the circuit open by hand if it has not tripped:
   `POST /admin/routing/:provider/disable` (`AdminRoutingController`, B13c).
3. Watch `montaj_job_completed_total{provider="..."}` shift to the next
   provider in the chain within a few minutes.
4. Re-enable the disabled provider once the vendor's status page confirms
   recovery, not the moment errors stop (a flapping provider re-opens the
   circuit and re-fails the next batch).

## GPU lane fallback

If the serverless GPU provider itself is down (last link in the A10 chain, and
also A20's render path): render falls back per A19c's decision — cloud render
above 1080p is already the default, so a GPU outage mainly affects the render
service's own encode step, not export availability broadly. Check
`montaj_gpu_requests_total{status="error"}`; if the primary GPU vendor is down,
`GPU_PROVIDER_URL` failover is a manual env change today (no automatic
secondary vendor as of this WP) — [scale-gpu.md](scale-gpu.md) §6 has the
detailed steps.

## SLO reference

From `05-system-architecture.md` §10 and `infra/observability/METRICS.md`:
API p95 < 300 ms; job success ≥ 99.5%; cloud render 1080p ≥ 2× realtime; COGS
per credit ≤ ₹0.58 (50% gross margin floor). Every alert above exists because
one of these numbers moved.

## Writing an incident up

Use [incident-template.md](incident-template.md). If personal data may have
been exposed at any point during the incident, stop and follow
[breach-first-hour.md](breach-first-hour.md) instead — that clock (72 h to the
Data Protection Board, no harm threshold) runs from detection, not from when
you finish the availability incident.
