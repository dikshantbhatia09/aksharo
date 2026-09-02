# Runbook — credit ledger reconciliation

06 invariant 1: `credit_accounts.balance_tenths` = Σ `credit_lots.remaining_tenths`
= Σ `credit_ledger.delta_tenths`, for every account, always. Every mutating
method on `LedgerCreditsFacade` moves all three numbers in one transaction, so
they are supposed to be inseparable. This runbook is what you reach for when
you suspect they came apart — a workspace disputing their balance, or the
nightly reconciliation job (B16) paging on a mismatch.

**Detection only.** Nothing here writes to the database. A mismatch means one
of the three numbers is wrong, and only a human who can see the account's full
history — which write did it, and why — should decide how to fix it.

## 0. The tool

`tools/runbooks/billing-reconcile.js` drives the admin credits API
(`/admin/credits/reconcile*`, B02):

```bash
export API_ORIGIN=https://api.aksharo.com          # or --api=
export MONTAJ_ADMIN_TOKEN=<an access token>        # or --token=
```

```
node tools/runbooks/billing-reconcile.js --help
```

## 1. Check everything

```bash
node tools/runbooks/billing-reconcile.js
```

```
ACCOUNT                     WORKSPACE                    BALANCE    Σ LOTS     Σ LEDGER   OK
01JD7Q…                     01JD7P…                       4820       4820       4820       yes
01JD7R…                     01JD7Q…                       0          -50        0          NO
  drift: lots -50  ledger +0

2 account(s) checked; 1 in drift
```

A non-zero exit code means at least one account is in drift — this is the
number `MontajCreditLedgerDrift` (B16) pages on.

## 2. Check one workspace

When a support ticket names a workspace, find its `credit_accounts.id` first
(the workspace's `GET /workspaces/{id}/credits` response carries no account id
directly — read it from the database, or from the workspace's row in the
`--json` output of the all-accounts check), then:

```bash
node tools/runbooks/billing-reconcile.js --account=01JD7R…
```

## 3. Read the drift

- **`lotsDriftTenths` (`balance - Σ lots`) is non-zero.** The cached balance and
  the lots disagree. Positive means the balance thinks there is more money than
  the lots hold — a lot was decremented (or expired) without the matching
  account-level `UPDATE`, or vice versa for negative. Pull every
  `credit_ledger` row for the account (`GET /workspaces/{id}/usage`, or query
  `credit_ledger WHERE account_id = …  ORDER BY at`) and every `credit_lots`
  row, and replay the arithmetic by hand from the oldest row forward — the
  first place a lot's `remaining_tenths` does not match what its ledger entries
  say it should is where the bug happened.
- **`ledgerDriftTenths` (`balance - Σ ledger`) is non-zero.** The append-only
  ledger and the cached balance disagree — a balance was moved by something
  that did not also write a ledger row (D32 invariant 1 says every balance
  move is one statement **and** a ledger row, in the same transaction). This
  one points at a bug or a hand edit, not at a timing window; treat it as an
  incident.
- **Both are non-zero and different.** Three-way disagreement — the least
  common case, and the one most likely to be a restored backup that missed a
  table (`restore-from-pitr.md`) or a migration that touched credit rows
  directly.

## 4. Fix it (a human, not this script)

There is no automated correction on purpose (04 §Entitlement enforcement:
credits are real money to the workspace). Once you know which number is right:

- A lot's `remaining_tenths` is wrong → write a `credit_ledger` `adjust` row and
  correct the lot in the same transaction, by hand, with the incident ticket
  number in the ledger row's context.
- The cached `balance_tenths` is wrong → the safe fix is almost always to set it
  to `Σ credit_lots.remaining_tenths` (the lots and their expiries are the
  source of truth D32 describes; the balance is explicitly documented as "a
  cache", 06 §Billing & credits) and write a `credit_ledger` `adjust` row
  recording the correction and its size.
- Never delete a `credit_ledger` row. It is append-only for a reason — the
  correction is a new row, not an edit to history.

## 5. After

- Re-run the check for the affected account(s); it should read `yes`.
- If the same account drifts again shortly after a manual fix, stop reconciling
  by hand and find the code path still writing outside
  `LedgerCreditsFacade` — a repeat is a live bug, not a one-off.
- Note the incident and the affected workspace(s) for support: a workspace that
  was overcharged during the drift window may be owed a `reversal` lot
  (D32 — inherits the original lot's expiry) via the admin console (B13).
