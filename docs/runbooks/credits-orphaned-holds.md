# Runbook — orphaned credit holds

A `credit_holds` row is still `status = 'held'` for a job that has already
finished. The workspace's credits are locked up for work that is no longer
running, and nobody is going to settle or release the hold on their own.

## Why this happens

`JobsService.complete` always settles or releases a hold in the **same call**
that flips the job to a terminal status (`succeeded`/`failed`/`cancelled`). An
orphan means that call was interrupted between the two — the job row updated,
the credits call never ran, or ran and failed silently:

- a completion callback that crashed (or lost its database connection) after
  the job update but before the credits call;
- the API process killed between the two statements;
- a hand-edited `jobs` row during an incident.

None of these are "should never happen" the way a CHECK-constraint violation
is. They are exactly the two-writes-are-not-one-transaction gap this runbook
exists for.

## 0. The tool

Everything below runs through `tools/runbooks/credits-orphaned-holds.js`, which
drives the admin credits API (`/admin/credits/orphaned-holds*`, B02):

```bash
export API_ORIGIN=https://api.aksharo.com          # or --api=
export MONTAJ_ADMIN_TOKEN=<an access token>        # or --token=
```

The token must belong to a user with `users.is_admin = true`; anything else is
a 403 (THREAT-MODEL T20).

```
node tools/runbooks/credits-orphaned-holds.js --help
```

`resolve` is a **dry run unless you pass `--confirm`**. Add `--json` to either
command for machine-readable output.

In-cluster, prefix with the pod:

```bash
kubectl -n montaj exec deploy/montaj-api -- node tools/runbooks/credits-orphaned-holds.js …
```

## 1. Look before you touch

```bash
node tools/runbooks/credits-orphaned-holds.js list
```

```
HOLD                        JOB                        QUEUE             JOB STATUS  TENTHS   HELD SINCE
01JD7QK2Z8N9…                01JD7QJ9C0M1…               ai.transcribe     succeeded   120      2026-09-02T08:03:11.204Z

1 orphaned hold(s)
```

If the list is empty, there is nothing to do — a job finishing normally never
shows up here.

## 2. Resolve

```bash
# Dry run FIRST — it prints what would happen and changes nothing (the default).
node tools/runbooks/credits-orphaned-holds.js resolve

# Then for real.
node tools/runbooks/credits-orphaned-holds.js resolve --confirm
```

The resolution follows the job, not a guess:

- **`succeeded`** → **settle** for whatever `jobs.credits_charged_tenths`
  already records. The completion handler already decided that number; this
  runbook does not re-derive it.
- **`failed` / `cancelled`** → **release** the hold in full. Those paths never
  charge.

Output is one line per hold and a count:

```
settled         01JD7QK2Z8N9…  01JD7QJ9C0M1…  ai.transcribe

1 hold(s); 0 failed
```

A non-zero "failed" count exits 1 — read the printed error for each and treat
it as its own incident (it usually means the hold or the job disappeared
between `list` and `resolve`, which is safe to re-run: both actions are
idempotent through `LedgerCreditsFacade`).

To resolve only specific holds:

```bash
node tools/runbooks/credits-orphaned-holds.js resolve --ids=01JD7QK2…,01JD7QK9… --confirm
```

## 3. After

- `list` again — it should be empty, or show only holds newer than your
  incident window.
- Run [billing-reconcile.md](billing-reconcile.md) for the affected
  workspace(s): a settle/release here credits or debits the account, and it is
  worth confirming the three invariant-1 numbers line up afterward.
- If the same job keeps re-appearing as orphaned across multiple runs, that is
  not a credits bug — it means the completion callback is failing
  systematically. Check `job_events` for that job id and treat it as a
  [dlq-replay.md](dlq-replay.md) investigation instead.
