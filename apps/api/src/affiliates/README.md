# `affiliates` — Affiliate programme v2 (B07)

Application/approval, `/r/<code>` attribution, the commission engine, the FY
TDS accumulator, `PayoutProvider`-backed monthly payouts, fraud flags, and
the dashboard/asset-pack API surface.

Design references: `03-architecture/04-pricing-and-monetization.md` v2
§Affiliate; `06-data-model.md` (affiliates, referrals, commissions,
affiliate_fy_totals, payouts, coupons); `08-ux-design-system.md` §4 Refer &
Earn; `12-redesign-decisions.md` D42, D54, D68; `docs/THREAT-MODEL.md` T17;
`04-research/RR-10-gtm-growth.md`, `RR-05-payments-tax.md`.

## Manual live-key smoke test (RazorpayX)

There are **no RazorpayX keys in this environment**. Every test in this work
package runs against `FakePayoutProvider`, an in-memory implementation with
deterministic ids and no network call. `RazorpayXProvider` reads the public
Payouts API shape (`POST /v1/payouts`) directly — unlike
`billing/providers/razorpay.provider.ts`, there is no vendored SDK for
payouts specifically to read the exact request/response shape from, so this
is **unverified** until a real RazorpayX account exercises it. When
`RAZORPAYX_ACCOUNT_NUMBER` and the existing `RAZORPAY_KEY_ID`/
`RAZORPAY_KEY_SECRET` are all set, `payouts/payout.factory.ts` switches to
`RazorpayXProvider` automatically — nothing else in `affiliates/` changes.

1. Set `RAZORPAYX_ACCOUNT_NUMBER` in `.env` (RazorpayX virtual account, not a
   Contact/Fund Account id).
2. Create a `contact` + `fund_account` for a test affiliate in the RazorpayX
   dashboard (test mode) — `RazorpayXProvider.createPayout` does not create
   these itself; it assumes a `fund_account`-equivalent target is already
   resolvable from `affiliates.payoutMethod`. This is the biggest gap
   between this stub and a real integration and should be the first thing
   confirmed against a live account.
3. Run `ScheduledTasksService.runNow(PAYOUT_BATCH_TASK)` (or wait for the
   monthly cron once B16 wires it) against a workspace with a matured,
   unpaid commission over ₹1,000 net, and confirm a payout appears in the
   RazorpayX dashboard with a matching UTR.
4. Confirm a repeated batch run for the same affiliate/month is a no-op
   (`X-Payout-Idempotency` header, keyed `payout:<affiliateId>:<yyyy-mm>`).

## PAN encryption at rest

`pan-crypto.ts`: AES-256-GCM, key derived via HKDF-SHA256 from
`INTERNAL_CALLBACK_SECRET` (already a required, rotating env var —
`INTERNAL_CALLBACK_SECRET_NEXT` is not consulted here, so a full rotation
requires re-encrypting existing PAN rows; the affiliate population is small
enough that this is an acceptable trade against adding a dedicated secret
the brief never asked for). Only the last 4 digits (`panLast4`) ever reach a
response body or the dashboard.

## Commission engine

`commission-schedule.ts` and `tds.ts` are pure — no Prisma, no I/O — so the
brief's rate-table and TDS-threshold acceptance tests are exact minor-unit
arithmetic assertions with no database. `commission.service.ts` is the only
place that touches Prisma: one `$transaction` per paid invoice that creates
the `commissions` row, updates `affiliate_fy_totals`, advances the
referral's `monthlyPaidCount`/`yearlyCommissionPaid`/`countsTowardTier`, and
flips the affiliate's `tier` the moment its 10th referral starts counting.

It is driven by `invoice-events.ts`, a small event contract this module owns
(the same relationship `invoices/billing-events.ts` has to `billing/`) —
`invoices/invoices.service.ts` gained one `EventEmitter2` injection and two
`emit()` calls, right before its two existing "issued" `return` statements,
to make `invoices.invoice.issued` / `invoices.credit_note.issued` observable
without forking `InvoicesService`'s own logic. `listeners/invoice-
events.listener.ts` is this work package's own subscriber.

## Fraud

`fraud.ts` is pure (self-referral, burst-signup, refund-ratio predicates);
`fraud.service.ts` supplies the DB-derived counts and writes the
`suspended_review` flag + audit row. A `suspended_review` affiliate earns
nothing going forward (`commission.service.ts` checks `status ===
"approved"` before recording) but nothing already paid is clawed back
automatically — that is a manual admin decision (B13).

## Testing

- `commission-schedule.test.ts`, `tds.test.ts`, `attribution.test.ts`,
  `fraud.test.ts` — pure-function unit tests, no database.
- `apps/api/test/affiliates.e2e-spec.ts` — attribution precedence and
  self-referral rejection against a real database; a full attribution → real
  paid invoice (via B01's `FakeProvider` and the real `TaxEngineService`) →
  pending commission → 30-day maturation → payout-batch-includes-it e2e.
  Reuses `test/billing-harness.ts` (B01) rather than building a parallel
  harness, and additionally seeds a `TaxRegistration` in `beforeAll`
  (`billing-harness.ts` does not, since B01's own suite never generates an
  invoice) — see `invoices-harness.ts` for the precedent.
- `apps/web/e2e/affiliate.spec.ts` — Playwright + axe over the apply form and
  the pending-state dashboard (a fresh test account has no affiliate
  profile, and reaching `approved` needs an admin action B13 owns, out of
  this work package's scope) and the asset pack page.
