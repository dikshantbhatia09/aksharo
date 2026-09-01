# Runbook — dead-letter queue replay

Jobs have exhausted their retries and are sitting in the dead-letter queue.

A DLQ entry is not a transient failure — it already failed every retry. Replaying
one without understanding why it failed just burns the retry budget a second
time and leaves the user waiting twice as long.

**Nothing replays automatically. That is deliberate.**

---

## 1. Look before you touch

```bash
ENV=prod
NS=montaj

kubectl -n "$NS" exec deploy/montaj-api -- node dist/scripts/dlq-stats.js
```

You want three numbers per queue: how many, since when, and how many distinct
error messages. From the dashboard:

```promql
sum by (queue) (montaj_queue_dlq_depth)
sum by (queue, job_kind) (increase(montaj_job_completed_total{status="failed"}[6h]))
```

Then read the actual errors, not a summary of them:

```bash
kubectl -n "$NS" exec deploy/montaj-api -- \
  node dist/scripts/dlq-list.js --queue ai.transcribe --limit 20 --show-error
```

## 2. Classify before you decide

| Pattern                                              | What it is                                                         | Action                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------- |
| Many jobs, **one** error, started at a point in time | Systemic: a bad release, an expired credential, a provider outage  | Fix the cause, **then** replay everything. §4  |
| Few jobs, **many different** errors                  | Bad inputs: corrupt uploads, unsupported codecs, zero-length audio | Do not replay. §5                              |
| Errors mention `bad_signature` or `attempt_mismatch` | Callback verification failing (THREAT-MODEL T8)                    | Stop. §6                                       |
| Errors mention `CreditsInsufficientError`            | Working as designed                                                | Do not replay. §7                              |
| Steady trickle, no pattern                           | The normal failure floor                                           | Sample a few, discard the rest, watch the rate |

The single most common mistake here is replaying a systemic failure before
fixing the cause. Check the timestamp of the **first** DLQ entry against the
deploy history before anything else:

```bash
helm -n "$NS" history montaj
```

## 3. Stop the bleeding

If jobs are still arriving in the DLQ, the cause is still live. Fix it first:
[rollback.md](rollback.md) for a bad release, [scale-gpu.md](scale-gpu.md) for a
provider outage, [rotate-secrets.md](rotate-secrets.md) for a credential.

Confirm the flow has stopped before replaying:

```bash
watch -n 30 'kubectl -n montaj exec deploy/montaj-api -- node dist/scripts/dlq-stats.js'
```

## 4. Replay a systemic failure

Replay in small batches. A DLQ that built up over hours will not drain in one
go, and a full-throttle replay competes with live user traffic for the same
workers.

```bash
# Always dry-run first: it prints what would be enqueued and reserves nothing.
kubectl -n "$NS" exec deploy/montaj-api -- \
  node dist/scripts/dlq-replay.js --queue ai.transcribe --since "2026-09-02T08:00:00Z" --dry-run

# Then a small batch.
kubectl -n "$NS" exec deploy/montaj-api -- \
  node dist/scripts/dlq-replay.js --queue ai.transcribe --since "2026-09-02T08:00:00Z" --limit 25 --confirm
```

Watch the first batch complete before sending the next. If the same jobs fail
again, stop: the cause is not fixed.

Three things the replay path must handle, and which are worth verifying on the
first batch:

- **Idempotency.** Jobs are idempotent by `jobKey` and completion is idempotent
  by `(jobId, attemptId)` (CONTRACTS section 3). A replay of a job that actually
  succeeded must be a no-op, not a double charge.
- **Credits.** Every replay needs a fresh `reserve` (CONTRACTS section 4). A
  replay that skips the reservation produces work nobody paid for.
- **Staleness.** A job older than the raw media's retention (7 days after the
  last job, `05 §9`) may reference an object S3 has already purged. Those cannot
  be replayed at all — see §8.

## 5. Bad inputs

These will fail identically every time. Replaying them is theatre.

```bash
kubectl -n "$NS" exec deploy/montaj-api -- \
  node dist/scripts/dlq-list.js --queue media.probe --show-error --limit 50 \
  | grep -iE 'unsupported|corrupt|zero-length|no audio stream'
```

For each, the user is owed two things:

1. **Their credits back.** A job that failed on a bad input must have released
   its hold. Verify, and release by hand if not:
   ```bash
   kubectl -n "$NS" exec deploy/montaj-api -- \
     node dist/scripts/credits-orphaned-holds.js --since "24h ago"
   ```
2. **An explanation.** "Your file has no audio track" is a better outcome than a
   job that silently vanished. If the failure reason is not surfaced in the UI,
   that is a bug to file, not something to fix by replaying.

Then discard:

```bash
kubectl -n "$NS" exec deploy/montaj-api -- \
  node dist/scripts/dlq-discard.js --queue media.probe --ids <id1>,<id2> --reason "unsupported input" --confirm
```

Discarding records a reason. Never discard silently — the DLQ is also the record
of what the system could not do.

## 6. Callback verification failures

`bad_signature` or `attempt_mismatch` in the DLQ means the worker did the work
and the API refused the result (THREAT-MODEL T8).

**Do not replay.** Find out which it is first:

```bash
# Both sides must agree on INTERNAL_CALLBACK_SECRET.
kubectl -n "$NS" get secret montaj-env -o jsonpath='{.data.INTERNAL_CALLBACK_SECRET}' | base64 -d | sha256sum
kubectl -n "$NS" exec deploy/montaj-worker-ai -- sh -c 'printf "%s" "$INTERNAL_CALLBACK_SECRET" | sha256sum'
```

- **Hashes differ** — a rotation went wrong. [rotate-secrets.md](rotate-secrets.md) §B.
  Fix it, then replay.
- **Hashes match** — the signatures are being generated by something that does
  not hold the secret, or clocks have drifted past the five-minute skew window.
  Check node clocks; if they are fine, treat it as
  [breach-first-hour.md](breach-first-hour.md).

## 7. Credit exhaustion

`CreditsInsufficientError` is the system working. The user ran out of credits;
the job was refused before any money was spent.

Do not replay and do not grant credits to make the DLQ tidy. If the volume is
surprising, the interesting question is upstream: is the burn rate wrong, or is
the reservation worst case far too pessimistic? Check the **credit reserve
accuracy** panel — a settled/reserved ratio well under 0.5 means users are being
blocked by holds for credits they would never have spent.

## 8. Jobs too old to replay

Raw media purges 7 days after the last job (`05 §9`), enforced by the S3
lifecycle rule on the `montaj:lifecycle=purge` tag. A DLQ entry older than that
may point at an object that no longer exists.

```bash
kubectl -n "$NS" exec deploy/montaj-api -- \
  node dist/scripts/dlq-list.js --queue ai.transcribe --older-than 7d --check-media
```

Anything reported as missing media cannot be recovered by replay. Discard it
with the reason `media purged`, release the hold, and — if the user is still
waiting — tell them. Silence is worse than the news.

## 9. After the replay

- DLQ depth back to zero: `sum(montaj_queue_dlq_depth)`.
- No orphaned credit holds from the incident window.
- `MontajDlqNonEmpty` and `MontajDlqGrowing` resolved.
- Written down: how many replayed, how many discarded and why, and whether any
  user was left without an explanation.

If the same DLQ pattern recurs, the fix is not a better replay procedure. It is
whatever keeps putting jobs there.
