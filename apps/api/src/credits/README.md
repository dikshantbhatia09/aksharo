# `credits` — the ledger, entitlements' plan resolution, and `CreditsFacade` (B02, B02b)

`LedgerCreditsFacade` behind the frozen `CreditsFacade` interface (CONTRACTS
§4): atomic conditional reserve/settle/release/reversal, lot expiry, monthly
grant resets, and a reconcile service. Replaces A08's `NoopCreditsFacade`,
which stays registered and exported for suites that want an in-memory double
rather than a database (`jobs.e2e-spec.ts`, `dlq.e2e-spec.ts`,
`billing.e2e-spec.ts` all bind `CREDITS_FACADE` back to it — those suites are
about their own mechanics, not the ledger's).

Design references: `docs/CONTRACTS.md` §4; `docs/THREAT-MODEL.md` T9, T23;
`03-architecture/04-pricing-and-monetization.md` v2; `06-data-model.md`
(`credit_accounts`, `credit_lots`, `credit_holds`, `credit_ledger`, invariants
1–2); `12-redesign-decisions.md` D32; `04-research/RR-09b-architecture-
critique.md` P0-4.

## Which number is authoritative

Two different things both look like "how much credit is committed right now",
and they answer different questions:

- **`credit_holds` where `status = 'held'`, summed per workspace.** This is
  the ledger's own live record — a hold moves out of `held` the instant
  `LedgerCreditsFacade.settle`/`.release` claims it, in the same transaction
  that moves the account balance. **`AdmissionService.admit` sums this**
  (B02b) for the enqueued-credit cap (THREAT-MODEL T23): it is the number that
  cannot drift from what the facade would itself report, because it _is_ what
  the facade reports.
- **`jobs.credits_charged_tenths`.** A denormalised DISPLAY column on the
  `jobs` row: the worst-case hold at enqueue, overwritten with the settled
  amount once `JobsService.complete()` calls `CreditsFacade.settle` and reads
  back its `settledTenths` (B02b — never the raw figure a worker reported,
  which the ledger may not have been able to fully honour; see
  "`needs_credits`" below). It is what `GET /jobs`, the admin console and this
  file's own comments read when they want "what did this job cost", and it is
  cheap because it needs no join — but it is a copy, not a source of truth,
  and nothing should gate a decision on it. Before B02b, admission control
  summed this column because the ledger did not exist yet; B02's own brief
  flagged the switch as a documented follow-up, and B02b makes it.

Both numbers should agree for any in-flight job (a hold that is still `held`
and a job row that has not yet completed carry the same figure), so a
divergence between "Σ open `credit_holds`" and "Σ `jobs.credits_charged_tenths`
for in-flight jobs" is itself worth investigating — see
`docs/runbooks/billing-reconcile.md`, though that runbook is about
`credit_lots`/`credit_ledger` against the account balance, not this pair.

## `needs_credits`

`JobsService.complete()` calls `CreditsFacade.settle(holdId, actualTenths)`
with the worker's (or completion handler's) **real** reported figure,
uncapped — B02 shipped the ledger's own delta-hold/`needs_credits` handling,
and B02b removed the clamp in `jobs.service.ts` that was keeping `settle` from
ever seeing an over-run. CONTRACTS §4's frozen `SettleResult` carries no
explicit flag for a shortfall, so the caller detects it structurally:
`settledTenths < actualTenths` **and** no `deltaHoldId` means the ledger could
not raise a delta charge to cover the difference (D32: "settle what is held
and return needs_credits").

When that happens, `JobsService.complete()`:

1. Writes `creditsChargedTenths` as `settledTenths` (what was actually
   charged), never the requested figure.
2. Merges `creditsShortfallTenths` into the job's `result` payload.
3. Appends a `job.needs_credits` event (`job_events`) with the requested,
   settled and shortfall figures.
4. Best-effort notifies the workspace owner through `NotifyService` with the
   `low-credits` kind (A25's template; the same kind
   `CreditsLowBalanceNotifier` uses for a balance crossing 20%/0% — a job
   coming up short is a different trigger reaching the same mailbox message).

None of step 4 blocks the completion callback: a notify failure is logged and
swallowed, exactly like `RealtimePublisher`/`WorkspaceNotifier`.

## `quote()`

`packages/config/src/credits.ts`'s `quote(operation, mediaMinutes)` is the one
call a producer should make for `{holdTenths, costTenths}` — it wraps
`creditCostTenths`/`worstCaseHoldTenths` so a producer never re-derives the
ms/minute conversion or the worst-case-vs-settled split by hand. A11's
`transcripts.quote.ts` predates `quote()` and calls the lower-level functions
directly (still correctly sourced from `BURN_RATES`, so not a drift risk);
A21's `exports`/subtitle quoting uses `quote()` directly (B02b).
