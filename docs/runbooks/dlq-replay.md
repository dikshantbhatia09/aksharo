# Runbook — dead-letter queue replay

Jobs have exhausted their retries and are sitting in the dead-letter queue.

A DLQ entry is not a transient failure — it already failed every retry. Replaying
one without understanding why it failed just burns the retry budget a second
time and leaves the user waiting twice as long.

**Nothing replays automatically. That is deliberate.**

---

## 0. The tool

Everything below runs through `tools/runbooks/dlq-replay.js`, which drives the
admin DLQ API (`/admin/dlq`, A08b). It needs two things:

```bash
export API_ORIGIN=https://api.aksharo.com          # or --api=
export MONTAJ_ADMIN_TOKEN=<an access token>        # or --token=
```

The token must belong to a user with `users.is_admin = true`; anything else is a
403 (THREAT-MODEL T20). Every replay and every discard writes an `audit_log` row
naming you.

```
node tools/runbooks/dlq-replay.js --help
```

`replay` and `discard` are **dry runs unless you pass `--confirm`**, and both
refuse to run with no target at all. Add `--json` to any command to get machine-
readable output.

In-cluster, prefix any of these with the pod:

```bash
kubectl -n montaj exec deploy/montaj-api -- node tools/runbooks/dlq-replay.js …
```

## 1. Look before you touch

```bash
node tools/runbooks/dlq-replay.js stats
```

That prints the three numbers you want per queue — how many, since when, and how
many distinct error codes:

```
QUEUE               PENDING   REPLAYED   DISCARDED   ERRORS   OLDEST PENDING
ai.transcribe       47        0          0           1        2026-09-02T08:03:11.204Z
media.probe         3         0          12          3        2026-09-01T19:40:02.887Z
```

From the dashboard, the same shape:

```promql
sum by (queue) (montaj_queue_dlq_depth)
sum by (queue) (increase(montaj_job_completed_total{status="failed"}[6h]))
```

Then read the actual errors, not a summary of them:

```bash
node tools/runbooks/dlq-replay.js list --queue=ai.transcribe --limit=20 --show-error
node tools/runbooks/dlq-replay.js show --job=01JD7…        # one entry, in full
```

## 2. Classify before you decide

| Pattern                                              | What it is                                                         | Action                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------- |
| Many jobs, **one** error, started at a point in time | Systemic: a bad release, an expired credential, a provider outage  | Fix the cause, **then** replay everything. §4  |
| Few jobs, **many different** errors                  | Bad inputs: corrupt uploads, unsupported codecs, zero-length audio | Do not replay. §5                              |
| Errors mention `jobs/signature_invalid`              | Callback verification failing (THREAT-MODEL T8)                    | Stop. §6                                       |
| Errors mention `credits/insufficient`                | Working as designed                                                | Do not replay. §7                              |
| Steady trickle, no pattern                           | The normal failure floor                                           | Sample a few, discard the rest, watch the rate |

`ERRORS` in the `stats` output is the fastest way to tell the first row from the
second: one distinct error code across forty entries is systemic; twelve codes
across fifteen entries is bad input.

The single most common mistake here is replaying a systemic failure before
fixing the cause. Check `OLDEST PENDING` against the deploy history before
anything else:

```bash
helm -n montaj history montaj
```

## 3. Stop the bleeding

If jobs are still arriving in the DLQ, the cause is still live. Fix it first:
[rollback.md](rollback.md) for a bad release, [scale-gpu.md](scale-gpu.md) for a
provider outage, [rotate-secrets.md](rotate-secrets.md) for a credential.

Confirm the flow has stopped before replaying — run `stats` twice a minute apart
and compare `PENDING`. If the producers themselves need to stop, that is
[`queue-drain.js`](../../tools/runbooks/queue-drain.js):

```bash
node tools/runbooks/queue-drain.js ai.transcribe --status
```

## 4. Replay a systemic failure

Replay in small batches. A DLQ that built up over hours will not drain in one
go, and a full-throttle replay competes with live user traffic for the same
workers. The API caps a single call at 100 entries for exactly that reason.

```bash
# Dry run FIRST — it prints what would be enqueued and reserves nothing.
# (It is the default; --confirm is what turns it off.)
node tools/runbooks/dlq-replay.js replay \
  --queue=ai.transcribe --since=2026-09-02T08:00:00Z

# Then a small batch, for real.
node tools/runbooks/dlq-replay.js replay \
  --queue=ai.transcribe --since=2026-09-02T08:00:00Z --limit=25 --confirm
```

The output is a line per entry and a count:

```
replayed        01JD7QK2…  ai.transcribe
failed          01JD7QK9…  ai.transcribe   The job is succeeded, not failed; there is nothing to replay.

selected 25  replayed 24  discarded 0  failed 1
```

A non-zero `failed` exits 1. Watch the first batch complete before sending the
next; if the same jobs fail again, stop — the cause is not fixed.

One entry, by job id or by entry id:

```bash
node tools/runbooks/dlq-replay.js replay --job=01JD7QK2… --confirm
```

Three things the replay path handles, and which are worth verifying on the first
batch:

- **Idempotency.** The replay is a conditional claim on the DLQ row, so two
  operators — or a script retried after a timeout — produce one replay, not two.
  It mints a **fresh attempt ULID**, which makes the old attempt's late callback
  a `stale_attempt` no-op (CONTRACTS §3, THREAT-MODEL T8). `attemptNo` in the
  output tells you which attempt is now live: three failures then a replay is 4.
- **Credits.** Every replay reserves again, for the hold the original attempt
  carried (CONTRACTS §4). A replay that skips the reservation produces work
  nobody paid for. If the workspace has since run out, the replay fails with
  `credits/insufficient` and nothing is enqueued.
- **Staleness.** A job older than the raw media's retention (7 days after the
  last job, `05 §9`) may reference an object S3 has already purged. Those cannot
  be replayed at all — see §8.

## 5. Bad inputs

These will fail identically every time. Replaying them is theatre.

```bash
node tools/runbooks/dlq-replay.js list --queue=media.probe --show-error --limit=50 \
  | grep -iE 'unsupported|corrupt|zero-length|no audio stream'
```

Or let the API do the filtering — `--grep` matches the last error's code or
message:

```bash
node tools/runbooks/dlq-replay.js list --grep="no audio stream" --show-error
```

For each, the user is owed two things:

1. **Their credits back.** A discard releases the hold; verify it did by reading
   the entry back — `holdReleased` in the output, and `resolution` on the row.
2. **An explanation.** "Your file has no audio track" is a better outcome than a
   job that silently vanished. If the failure reason is not surfaced in the UI,
   that is a bug to file, not something to fix by replaying.

Then discard. `--reason` is **mandatory** — the API rejects a blank one:

```bash
node tools/runbooks/dlq-replay.js discard \
  --grep="no audio stream" --reason="unsupported input: no audio stream" --confirm

node tools/runbooks/dlq-replay.js discard \
  --ids=01JD7QK2…,01JD7QK9… --reason="corrupt upload" --confirm
```

Discarding records the reason on the row, releases the credit hold and audits.
Never discard silently — the DLQ is also the record of what the system could not
do, which is why the rows are kept for good and the job-event retention sweep
never touches them.

## 6. Callback verification failures

`jobs/signature_invalid` or a `stale_attempt` in the DLQ means the worker did the
work and the API refused the result (THREAT-MODEL T8).

**Do not replay.** Find out which it is first:

```bash
# Both sides must agree on INTERNAL_CALLBACK_SECRET.
kubectl -n montaj get secret montaj-env -o jsonpath='{.data.INTERNAL_CALLBACK_SECRET}' \
  | base64 -d | sha256sum
kubectl -n montaj exec deploy/montaj-worker-ai -- \
  sh -c 'printf "%s" "$INTERNAL_CALLBACK_SECRET" | sha256sum'
```

- **Hashes differ** — a rotation went wrong. [rotate-secrets.md](rotate-secrets.md) §B.
  Fix it, then replay. `INTERNAL_CALLBACK_SECRET_NEXT` exists so a roll loses no
  callbacks; if it is unset mid-roll, that is the bug.
- **Hashes match** — the signatures are being generated by something that does
  not hold the secret, or clocks have drifted past the five-minute skew window.
  Check node clocks; if they are fine, treat it as
  [breach-first-hour.md](breach-first-hour.md).

## 7. Credit exhaustion

`credits/insufficient` is the system working. The user ran out of credits; the
job was refused before any money was spent.

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
node tools/runbooks/dlq-replay.js list \
  --queue=ai.transcribe --until="$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)"
```

`show --job=<id>` prints the entry's `payload`, which is where the object key
lives; check it against the bucket before replaying. Anything whose media is gone
cannot be recovered by replay. Discard it, and — if the user is still waiting —
tell them. Silence is worse than the news:

```bash
node tools/runbooks/dlq-replay.js discard \
  --queue=ai.transcribe --until=2026-08-26T00:00:00Z \
  --reason="media purged after 7-day retention" --confirm
```

## 9. After the replay

- DLQ depth back to zero: `sum(montaj_queue_dlq_depth)`, or `stats` reporting
  `0 pending in total`.
- No orphaned credit holds from the incident window.
- `MontajDlqNonEmpty` and `MontajDlqGrowing` resolved.
- The audit trail reads correctly: every entry in the window has a `status` of
  `replayed` or `discarded`, a `resolvedBy`, and — for a discard — a `resolution`.
  ```bash
  node tools/runbooks/dlq-replay.js list --status=discarded --limit=100 --json
  ```
- Written down: how many replayed, how many discarded and why, and whether any
  user was left without an explanation.

If the same DLQ pattern recurs, the fix is not a better replay procedure. It is
whatever keeps putting jobs there.
