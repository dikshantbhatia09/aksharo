# `offers` — signup gift, ₹9 clean export, week pass, ₹149 top-up (B04)

Backs the interfaces A21 left as no-ops, enforces the ₹9 pass's eligibility
rules server-side, and reads out the state the web upsell panel and the
Subscription overview render from.

Design references: `03-architecture/04-pricing-and-monetization.md` §Offers;
`12-redesign-decisions.md` D04, D55; `apps/api/src/exports/README.md` ("The ₹9
pass"); `apps/api/src/billing/README.md` (checkout, webhooks, `passes_purchased`).

## What this module owns, and what it does not

**Owns:** the real `NinePassLedger` (`nine-pass-ledger.impl.ts`), the ₹9
eligibility rules (`nine-pass-eligibility.ts` + `.service.ts`), the
`GET /offers/eligibility` / `GET /offers/passes` read model
(`offers.service.ts`), the ₹9-hypothesis instrumentation
(`offers-metrics.service.ts`, `admin-offers.controller.ts`), and two dev/test
routes (`offers-dev.controller.ts`).

**Does not own:**

- **The signup gift's lifecycle.** A21 already wired it end to end —
  `exports.service.ts` reads `workspace.signupGiftConsumedAt` and consumes it
  at manifest completion. `OffersService.eligibility()` only _reads_ that same
  column for the upsell panel's first line.
- **Checkout, webhooks, `passes_purchased` itself, week-pass entitlement
  elevation, and grantLot.** All B01/B02. This module reads their tables and,
  in one place (`billing/passes.service.ts#passCheckout`), calls into this
  module's eligibility check before a `first_export` order is created.

## The ₹9 pass: "paid" vs. "spent"

`passes_purchased.consumedAt` (B01) is stamped by
`billing/webhooks.service.ts#grantPass` the moment the payment webhook lands —
it means "paid," and exists as that handler's own replay guard. For a
`first_export` pass those are two different moments: paid at checkout, spent
later when a browser export actually completes. Reusing `consumedAt` for both
would make a freshly paid, unspent pass look already used the instant the
webhook landed.

This work package's migration (`20260902080000_b04_offers_nine_pass_redeem`)
adds `redeemedAt`/`redeemedManifestId` instead:

- `PassesNinePassLedger.isAvailable(workspaceId)` — a `first_export` row with
  `consumedAt IS NOT NULL AND redeemedAt IS NULL` exists.
- `PassesNinePassLedger.consume(workspaceId, manifestId)` — spends the oldest
  such row (`ORDER BY createdAt ASC`, a compare-and-swap on `redeemedAt IS
NULL`), idempotent per `manifestId` (a second call with the same id is a
  no-op, not a second spend).

Both are called by `exports.service.ts` exactly as A21 specified —
`isAvailable` at `POST /projects/{id}/exports`, `consume` at
`POST /exports/manifests/{id}/complete` — nothing about `exports/` changed
except the DI binding (`exports.module.ts` now imports `OffersModule` instead
of providing `NoopNinePassLedger` itself).

## Manifest re-issue after a ₹9 purchase — no new endpoint

The brief's "the same manifest is re-issued without watermark, no re-render
needed if the render has not started" turns out to already be what the
existing architecture does, once the ledger above is real: the client simply
calls `POST /projects/{id}/exports` **again**, with the exact same request
body, after the ₹9 payment lands. `decideExport` (A21, unmodified) re-reads
`ninePassAvailable` fresh on every call; once the pass is paid it flips from
`false` to `true` and the decision returns `watermark: false,
watermarkSource: "nine_pass"` — a new, clean signed manifest. Nothing about
the video, timeline or style changed, so if the browser has not started
rendering the earlier (watermarked) manifest, it just swaps to the new one; if
it already produced watermarked output, the caller re-runs with the new
manifest. `test/offers.e2e-spec.ts`'s "watermarked export → buys ₹9 →
re-requesting the same export is clean" test exercises exactly this, over
HTTP, end to end.

## Eligibility (`nine-pass-eligibility.ts`)

Pure, synchronous, table-tested — the same shape as `exports/decision.ts`.
Three independent reasons a workspace may not buy a new ₹9 pass right now,
checked in this order:

1. `currency_not_inr` — the workspace's billing currency is not INR (04
   §Offers gives no USD price).
2. `on_paid_plan` — the workspace's live subscription plan is not `free`.
3. `purchased_within_30_days` — a `first_export` purchase exists whose
   `createdAt` is less than 30 days old (`nextEligibleAt` in the response is
   exactly when that clears).

`NinePassEligibilityService.assertEligible()` is called from
`billing/passes.service.ts#passCheckout` **after** that method's own INR
check inside `quotePass` — deliberately, so a USD workspace still gets the
pre-existing `billing/pass_kind_unavailable` 400 (B01's own contract and
acceptance test) rather than this module's `409
offers/nine_pass_ineligible` racing it for which error the caller sees. The
two currency checks agree; only one of them is allowed to answer first.

## Instrumentation (`GET /admin/metrics/offers`)

D55's ₹9 hypothesis: "keep if ≥ 10% of buyers reach a paid plan within 60
days; replace with a ₹49 three-export pack if < 6% after 500 buyers."
`OffersMetricsService` derives both event kinds from tables B01/B04 already
write, rather than a separate event log:

- **purchase** — a `first_export` `passes_purchased` row with `consumedAt`
  set.
- **upgrade within 60 days** — that same workspace's earliest `subscriptions`
  row with `plan.key != 'free'`, not `pending`, whose `currentPeriodStart`
  falls within 60 days of the purchase.

The response includes the raw event list (capped at 500, newest first) and a
`recommendation` (`keep | replace | monitor`) computed straight from D55's own
numbers — not a new policy, a restatement of the one already agreed. Behind
`AdminGuard`, registered in `admin/admin.module.ts` (not here) per the
`AdminCreditsController` convention: every admin route lives in one place to
audit (THREAT-MODEL T20).

## Dev/test-only routes (`offers-dev.controller.ts`)

`POST /offers/dev/simulate-nine-pass-payment` and `POST
/offers/dev/consume-signup-gift`. Registered under `BillingModule` (the first
needs `BILLING_PROVIDER`/`WebhooksService`, both native there). Neither wears
an auth guard — see the controller's own doc comment for why (the Playwright
e2e that calls them drives the real web app in a separate OS process, and this
codebase's access token lives in browser memory, not a cookie a cross-origin
test client can forward) — and both refuse outright unless the running
`BILLING_PROVIDER` is `FakeProvider`, which is never true with live Razorpay
keys wired in.

## Layout

```
offers.module.ts                  DI wiring; imported by ExportsModule, BillingModule, AdminModule
offers.controller.ts              GET /offers/eligibility, GET /offers/passes
offers-dev.controller.ts          dev/test-only, registered under BillingModule
offers.service.ts                 the eligibility/passes read model
offers.dto.ts                     request/response shapes
offers.constants.ts               error codes, audit actions, tunables
nine-pass-eligibility.ts          the pure eligibility function (table-tested)
nine-pass-eligibility.service.ts  resolves DB state for it; passCheckout's gate
nine-pass-ledger.impl.ts          the real NinePassLedger (exports/nine-pass-ledger.ts's interface)
offers-metrics.service.ts         the ₹9-hypothesis instrumentation
admin-offers.controller.ts        GET /admin/metrics/offers (registered in admin/admin.module.ts)
```

## Deviations and assumptions

1. **₹9 pass eligibility is scoped per workspace, not "per account."** The
   brief and `04 §Offers` say "once per account per 30 days"; `passes_purchased`
   (06/B01) has no `userId` column, only `workspaceId` — the same resource the
   signup gift is scoped to. Interpreted as per-workspace, consistent with the
   gift, and flagged rather than guessed silently.
2. **The dev-only routes carry no bearer auth** (see above) — a deliberate,
   narrow trade-off for testability, not an oversight; both are inert outside
   a `FakeProvider` environment.
