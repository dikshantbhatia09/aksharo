# `billing` — Razorpay subscriptions, mandates, checkout, webhooks (B01)

Everything that turns a plan choice into money moving and an entitlement
changing: the `BillingProvider` port, the plan catalogue, checkout (plans,
passes, top-ups), the webhook state machine, subscription management, and the
renewal/dunning primitives B16 wires into the scheduler.

Design references: `docs/CONTRACTS.md` §1, §4, §8; `docs/THREAT-MODEL.md` T16;
`03-architecture/04-pricing-and-monetization.md` v2; `06-data-model.md`
(plans, subscriptions, mandates, passes_purchased, payments);
`07-api-and-contracts.md` §Billing; `12-redesign-decisions.md` D05, D39, D40;
`04-research/RR-05-payments-tax.md`.

## Manual live-key smoke test

There are **no live Razorpay keys in this environment**. Every test in this
work package runs against `FakeProvider`, an in-memory implementation that
emits webhook fixtures shaped exactly like the real thing (same envelope, same
`X-Razorpay-Signature` scheme — confirmed against the official SDK's own
`dist/utils/razorpay-utils.js`, not guessed). When `A00-02` lands real keys:

1. Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` in
   `.env`. `createBillingProvider` (`providers/provider.factory.ts`) switches
   to `RazorpayProvider` automatically — nothing else in `billing/` changes.
2. In the Razorpay dashboard (test mode), point a webhook at
   `POST {API_ORIGIN}/billing/webhooks/razorpay` with the same secret, and
   subscribe to: `subscription.authenticated`, `.activated`, `.charged`,
   `.pending`, `.halted`, `.cancelled`, `.completed`, `payment.captured`,
   `payment.failed`, `payment.refunded`, `order.paid`.
3. Run one checkout end to end per interval — `month`, `year`, `halfyear`
   (Studio only), `once` — and confirm: the `mandates` row's `provider_mandate_
id` matches the dashboard, the ₹15,000 UPI Autopay refusal actually
   surfaces in Razorpay's own checkout widget for a Studio yearly attempt, and
   a webhook delivered twice (dashboard has a manual "resend" button) is a
   no-op on our side.
4. Confirm the exact shape of a mandate-related webhook — see "Open
   questions" below; nothing in this codebase depends on it being wrong, but
   `webhooks.service.ts`'s `mandate.*` handling is unverified without one.

## `BillingProvider` (`provider.ts`)

```ts
interface BillingProvider {
  createCustomer(input): Promise<{ providerCustomerId }>;
  createSubscription(
    input,
  ): Promise<{ providerSubscriptionId; providerMandateId?; status; checkout }>;
  createOrder(input): Promise<{ providerOrderId; status; checkout }>;
  registerMandate(input): Promise<{ providerSubscriptionId; checkout }>; // D40 re-registration
  chargeRenewal(input): Promise<{ providerPaymentId; status }>; // manual retry only
  cancelSubscription(input): Promise<void>;
  refund(input): Promise<{ providerRefundId; status }>;
  parseWebhook(rawBody, signature): BillingEvent; // throws BillingSignatureError
  listPaymentMethods(input): Promise<PaymentMethodView[]>;
}
```

Two implementations, one factory (`providers/provider.factory.ts`, the same
shape as `notify/mail/mail.factory.ts`):

- **`FakeProvider`** — in-memory, deterministic ids, emits signed webhook
  fixtures via `emitWebhook()` (test-only). Every acceptance test in this
  work package runs against it.
- **`RazorpayProvider`** — the official `razorpay` npm SDK. Every call shape
  is read from the SDK's own shipped source
  (`node_modules/razorpay/dist/resources/*.js` and its `.d.ts` files), not
  Razorpay's public docs, because there is no way to check the docs against a
  live account here. `parseWebhook` is exercised in
  `razorpay.provider.test.ts` without a network call — it is pure HMAC
  verification.

`registerMandate` exists because D40 is explicit that **a mandate cannot be
updated in place, only re-registered with fresh authentication**: an upgrade
that raises the cap cancels the old provider-side subscription and creates a
new one at the new cap.

## Endpoints (07 §Billing)

| Method | Path                                      | Auth      | Notes                                                                                                                        |
| ------ | ----------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/billing/plans`                          | public    | INR + USD catalogue                                                                                                          |
| POST   | `/billing/checkout`                       | admin     | `{planKey, interval, coupon?, seats?, method?}` → checkout payload or `409 billing/mandate_cap_exceeded` with `alternatives` |
| POST   | `/billing/passes/checkout`                | admin     | `{kind: first_export\|week_pass\|pay_once, planKey?}`                                                                        |
| POST   | `/billing/topups/checkout`                | admin     | `{credits}`                                                                                                                  |
| POST   | `/billing/webhooks/razorpay`              | signature | idempotent by derived event id                                                                                               |
| GET    | `/billing/subscription`                   | viewer    | current subscription, or `null`                                                                                              |
| POST   | `/billing/subscription/cancel`            | admin     | at period end                                                                                                                |
| POST   | `/billing/subscription/resume`            | admin     | undoes cancel, or unpauses                                                                                                   |
| POST   | `/billing/subscription/pause`             | admin     | once per 12 months                                                                                                           |
| GET    | `/billing/subscription/change-preview`    | viewer    | proration preview                                                                                                            |
| POST   | `/billing/subscription/change-plan`       | admin     | applies the change; re-registers the mandate when needed                                                                     |
| GET    | `/billing/mandates`                       | viewer    |                                                                                                                              |
| POST   | `/billing/mandates/{mandateId}/revoke`    | admin     | cancels the linked subscription too                                                                                          |
| GET    | `/billing/payment-methods`                | viewer    |                                                                                                                              |
| POST   | `/billing/passes/{passPurchaseId}/refund` | admin     | B01b: admin/API refund path -- calls the provider's refund API, attempts the credits clawback                                |

None of these routes carry a workspace id in the path — like `/projects/*`,
they are scoped through the access token via `WorkspaceMemberGuard`. **The
mandate-revoke route param is named `:mandateId`, not `:id`** — `Workspace
MemberGuard` special-cases a literal `id` param as the workspace id (07
§Conventions), and a mandate id would never match one, which is a bug this
work package's own e2e suite caught before it shipped.

## State machine (`webhooks.service.ts`)

```
                    checkout()
                        │
                        ▼
                  ┌───────────┐
     ┌───────────▶│  pending  │◀────────────────────────────┐
     │            └─────┬─────┘                              │
     │        authenticated / activated /                    │
     │            order.paid (once, card_once)                │
     │                  │                                     │
     │                  ▼                                     │
     │            ┌───────────┐   subscription.charged   ┌────┴────┐
     │            │  active   │──────────────────────────▶│ active  │ (period advances)
     │            └─────┬─────┘                            └─────────┘
     │       subscription.pending / .halted /               │
     │       payment.failed                                 │ subscription.charged
     │                  │                                    │ (recovers)
     │                  ▼                                    │
     │            ┌───────────┐                              │
     │            │ past_due  │──────────────────────────────┘
     │            └─────┬─────┘
     │        graceUntil elapsed (RenewalService.graceExpiry)
     │                  │
     │                  ▼
     │            ┌───────────┐
     └────────────│  paused   │  (resume re-authenticates or resumes billing)
                  └───────────┘

  subscription.cancelled ──▶ cancelled     (any state; mandate revoked)
  subscription.completed ──▶ expired       (fixed-term ran out)
```

- **`pending`** is B01's own addition to `SubscriptionStatus` (migration
  `20260902070000_b01_billing_events`; see "Deviations" below) — A03's
  original enum had no state for "checkout created, awaiting the first
  authentication/charge".
- **`renewalInitiateAt`** = `currentPeriodEnd − 48h` (D40: 24h RBI notice +
  gateway hold + retry headroom), recomputed on every period advance.
- **`graceUntil`** = `currentPeriodEnd + 3d`, set once on the first failure of
  a cycle and never pushed out by a later retry of the same cycle (D40
  invariant 7).
- A **`once`** subscription (pay-once, and a `card` checkout above the UPI
  cap — see "Mandate rules") has `mandateId: null` and is activated by
  `order.paid`/`payment.captured` against its `providerSubId`, which for
  these rows is a Razorpay **order** id, not a subscription id — the two
  share one column because a webhook resolves either kind the same way.

## Mandate rules, as implemented (D05, D40, THREAT-MODEL T16)

- **Mandate cap = undiscounted list price**, always — `money.ts`'s
  `quotePrice()` computes the full price (base + extra seats) and that number
  becomes the cap regardless of any future coupon (B06, out of scope here;
  the amount currently _charged_ also equals the cap, since no discount logic
  exists yet — documented as an assumption).
- **No UPI Autopay mandate above ₹15,000** (`UPI_AUTOPAY_CAP_MINOR =
1_500_000` paise) — a **hard block**, not "AFA required above it": UPI
  Autopay does not support recurring debits above the cap at all (RR-05 C4).
  Enforced twice: in application code (`money.ts`'s `decideMandate`) and in
  the database (`prisma/sql/0003-checks.sql`'s `mandates_upi_cap_check`).
- **Card and eNACH have no such ceiling.** Above ₹15,000 they need fresh
  authentication (AFA) on _every_ debit instead of once
  (`mandates.afaRequiredPerDebit`), except:
- **A `card` request above the cap becomes a one-time charge, not a
  recurring mandate** (`decideMandate`'s `"one_time"` branch) — the "one
  card ... charge" reading of 04 §Offers' "Studio yearly ... is sold as two
  half-yearly UPI debits of ₹9,996, or one card/eNACH charge, or pay-once
  with a reminder". This is a judgement call the source docs do not spell
  out mechanically; see "Deviations".
- **International (USD) checkout has no UPI concept** — Razorpay's
  international rail is cards only (D39) — so `currency: "USD"` always
  resolves to a recurring `card` mandate with no cap check.
- **Refusal returns actionable alternatives**, each a retry of the same
  request with one field changed:
  - `halfyear_upi` — `interval: "halfyear"` (only offered when the original
    request was `year` and the plan has a halfyear price — Studio/INR today).
  - `card_once` — `method: "card"` (becomes the one-time-charge branch above).
  - `enach` — `method: "enach"` (recurring, `afaRequiredPerDebit: true`).
- **Change-plan re-registers the mandate only when the new cap exceeds the
  current one** (D40: cannot be updated in place). A downgrade or same-cap
  change is bookkeeping only — the existing mandate already covers it.

## Renewal and dunning primitives (`renewal.service.ts`, `dunning.ts`)

Scheduler wiring is B16's (`common/scheduler`); these are the callable
primitives it will register:

- **`initiateRenewal(subscriptionId)`** — sends the pre-debit notice via
  `NotifyService` (`renewal-notice`, variables `{plan, amount, renewsOn,
days, link, name}` per the orchestrator addendum) ≥ 24h before the charge.
  It never calls `chargeRenewal` itself — Razorpay auto-charges a registered
  mandate on its own schedule; this only sends the notice and stamps
  `mandates.lastNotificationAt`. A `cancelAtPeriodEnd` subscription (every
  `once`/`card_once` purchase included) still gets the notice, informationally
  — 04 §Offers promises pay-once users a reminder before expiry.
- **`handleDecline(subscriptionId, declineCode)`** — one rung of the dunning
  ladder (`dunning.ts`'s `classifyDecline`): a `mandate`-class code offers a
  fallback immediately (no retry — the mandate is gone), a `card`-class code
  does the same, `insufficient_funds` gets a short retry ladder, everything
  else falls into a `generic` bucket with a longer one. A `retry` step calls
  `provider.chargeRenewal` — against `FakeProvider` this succeeds; against
  `RazorpayProvider` it currently throws `manual_charge_unsupported` (see
  "Open questions") and the failure is logged, not fatal.
- **`graceExpiry()`** — every `past_due` subscription whose `graceUntil` has
  passed moves to `paused` (not `cancelled` — a later re-authentication
  should resume the same subscription rather than force a fresh checkout).

Exact Razorpay decline-code strings could not be verified without a live
account; `classifyDecline` matches by **substring** against the buckets RR-05
and the RBI framework name (`mandate`, `card`, `insufficient`), rather than an
exhaustive enum that would silently miss a real code spelled slightly
differently.

## `grantLot` extension (`credits/credits.facade.ts`)

Per the brief, only the **signature** was extended — the no-op implementation
(`NoopCreditsFacade`, A08's file) is untouched:

```ts
export interface GrantLotInput {
  readonly workspaceId: string;
  readonly source: CreditLotSource;
  readonly tenths: number;
  readonly expiresAt?: Date;
  readonly reason: string;
  readonly refId?: string;
  readonly currency?: "INR" | "USD"; // new, optional
  readonly amountMinor?: number; // new, optional
  readonly invoiceId?: string; // new, optional
}
```

All three additions are optional so every existing call site (and A08's own
unit test) keeps compiling unchanged. `passes.service.ts`'s
`webhooks.service.ts#grantPass` passes `currency`/`amountMinor` when granting
a paid pass or top-up; B02's real facade is expected to write them straight
onto `credit_lots.currency`/`credit_lots.amount_minor` (06 already has both
columns).

## Passes, top-ups and the `PassPurchaseKind.pay_once` overlap

`passes_purchased.kind` (06) lists `first_export | week_pass | pay_once |
topup` — and `pay_once` visually collides with the brief's own `POST
/billing/checkout {interval: "once"}` ("pay-once creates a 30-day
subscription without a mandate", acceptance criterion 1). Neither source
document reconciles the two, so this work package keeps them **distinct
products**:

- `POST /billing/checkout {planKey: starter|creator, interval: "once"}` —
  the **full plan tier** (features, limits) for 30 days, no mandate. Backed
  by a `subscriptions` row.
- `POST /billing/passes/checkout {kind: "pay_once", planKey}` — that same
  plan's **monthly credit allotment only**, at the same monthly price, for 30
  days, **without** changing the workspace's plan tier. Backed by a
  `passes_purchased` row plus a `CreditsFacade.grantLot` call.

Flagged as an open question below rather than guessed silently.

## Deviations and assumptions (report these, don't hide them)

1. **`SubscriptionStatus` gained a `pending` value** (migration
   `20260902070000_b01_billing_events`, `ALTER TYPE ... ADD VALUE 'pending'`,
   same mechanism A06 used for `MediaRole`). A03's enum
   (`trialing|active|past_due|paused|cancelled|expired`) had no state for
   "checkout created, not yet authenticated or charged" — but the brief's own
   acceptance criteria requires it verbatim ("records subscriptions (status
   pending)"). This is additive only (a new enum value, nothing removed or
   renamed) and is outside `docs/CONTRACTS.md`'s frozen list (§0–§10 do not
   name `SubscriptionStatus`'s values), so it was made rather than worked
   around with a misleading existing value.
2. **Currency-lock predicate doesn't check price or invoices.**
   `workspaces/workspaces.service.ts`'s `lockedWorkspaces()` (A05's file, out
   of this work package's boundary) locks currency on _any_ subscription in
   `trialing|active|past_due|paused`, not only non-zero-priced ones, and does
   not check for a paid invoice — the orchestrator addendum after A05 says it
   should be "a subscription with a non-zero price ... or any paid invoice
   exists". In practice this work package never creates a zero-priced
   subscription (Free is never sold through checkout) or an invoice (B05's
   job), so the gap has no observable effect on anything this work package
   ships — but `prisma/seed.ts` _does_ create a Free-plan demo subscription,
   which would incorrectly lock that workspace's currency under the current
   predicate. Reported, not fixed (outside the file boundary).
3. **Seat pricing for `year`/`halfyear` intervals is not spelled out** in `04
§Plans` (only a flat monthly `seatPrice` is seeded). `money.ts`'s
   `quotePrice()` multiplies the monthly seat price by the same "pay N
   months" factor the base price uses (×10 year, ×5 halfyear) — a documented
   assumption, not a value from the source docs.
4. **Coupon/streak discounts are out of scope** (B06) — `checkoutSchema`
   accepts an optional `coupon` field for forward API compatibility, but no
   discount is applied; the amount charged always equals the undiscounted
   list price today.
5. **`payment.refunded` credits clawback (B01b, fixed in B01d): fully
   working.** See "Credits clawback" below — B01b/B01c called `reverse()`,
   the wrong primitive (it refunds a _settled job_, keyed on a `credit_holds`
   row a grant-sourced lot never has); B01d switched to B02b's
   `CreditsFacade.revokeLot({lotId, tenths?, reason, refundId})`, which is
   keyed on the lot itself and subtracts, reporting any `shortfallTenths`
   (credits already spent before the refund) for manual review instead of
   failing.
6. **`chargeRenewal` against the live `RazorpayProvider` throws.** Razorpay
   auto-charges a registered recurring mandate on its own schedule; there is
   no publicly documented "charge this subscription now" call for a manual
   retry. `RazorpayProvider.chargeRenewal` says so explicitly rather than
   silently doing nothing; `RenewalService.handleDecline`'s retry step
   catches and logs the failure rather than crashing the webhook path.
7. **`event id` is derived from the webhook body**, not read from an
   `X-Razorpay-Event-Id` header — see "Open questions".

## Credits clawback (B01b, fixed in B01d)

The B01b follow-up asked for "`payment.refunded` (and refund via the
admin/API path) claws back the credits granted by that payment". B01b/B01c
implemented this against `LedgerCreditsFacade.reverse()`, and that call was
expected to fail for every real pass/top-up refund in this codebase:
`reverse()` refunds a _settled job_ — it is 04 §Refunds & cancellation's "a
settled job with a bad artefact gets a reversal lot", keyed on a
`credit_holds` row with a hard FK to `jobs.id`, and it **adds** tenths back.
A pass/top-up purchase's credits come from `CreditsFacade.grantLot()`
(`webhooks.service.ts`'s `grantPass`), which creates only a `credit_lots`
row — never a hold, never a job — so `reverse()`'s precondition could never
be satisfied by a grant, and the attempt always fell into a caught
`credits/reversal_source_not_found` → `manual_action_required` audit.

B01d closes that gap using B02b's `CreditsFacade.revokeLot({lotId, tenths?,
reason, refundId})` → `{revokedTenths, shortfallTenths}` (see
`../credits/README.md`), the primitive `reverse()` should have been:

- **Keyed on the lot, not a job.** `revokeLot` takes `lotId` directly —
  exactly what `passes_purchased.lot_id` already records.
- **Subtracts**, never more than the lot still has remaining. If a customer
  already spent some of what is being refunded, the shortfall — the part
  that cannot be recovered from the ledger — comes back as
  `shortfallTenths` rather than throwing.
- **Idempotent per `refundId`** on the ledger's own side (a partial unique
  index on `credit_ledger`), on top of `RefundsService`'s own
  compare-and-swap on `passes_purchased.refunded_at`.

`RefundsService.clawbackPassPurchase` resolves which lot a purchase granted
(`passes_purchased.lot_id`, populated by `grantPass`), guards the whole
operation with the compare-and-swap so a replayed webhook or a repeated
admin call is a clean no-op, then calls `revokeLot({lotId, tenths:
creditsGrantedTenths, reason, refundId: passPurchaseId})`. The outcome is
now one of:

- `already_processed` — a replay of an already-clawed-back purchase.
- `nothing_to_claw_back` — the purchase never recorded a lot (e.g. this
  suite's own harness, see below).
- `clawed_back` (with `revokedTenths`) — the full amount came back.
- `manual_action_required` (with `revokedTenths` and `shortfallTenths`) —
  `shortfallTenths > 0`: some of what was refunded in money had already been
  spent in credits and cannot be recovered from the ledger; a human needs to
  see the gap. This is also what a defensive `credits/lot_not_found` catch
  reports (the lot referenced by `passes_purchased.lot_id` no longer
  exists — should not be reachable in practice, since `grantPass` populates
  that column from the very `grantLot()` call that created the lot).

`shortfallTenths` is carried onto the `billing.refund.issued` audit row from
the admin/API path too, so support can see the gap without cross-referencing
the clawback audit separately. `refunds.service.test.ts` covers every branch
above against a mocked `LedgerCreditsFacade`, and `billing.e2e-spec.ts`'s
"B01d: fake provider refund revokes the real lot and reduces the real
balance" test proves the full path against the real ledger: it seeds a real
lot through `app.get(LedgerCreditsFacade)`, links it onto a purchase exactly
as `grantPass` would once `CREDITS_FACADE` binds to the real ledger, fires
the fake provider's `payment.refunded` webhook, and asserts both
`credit_lots.remaining_tenths` and `credit_accounts.balance_tenths` actually
moved — and that a replayed webhook does not move them twice.

Subscription-renewal payment refunds are narrower still: B02's periodic
`credit-grant-reset.task.ts` grants the monthly allowance on the billing
anniversary, not per payment, so there is no B01-owned lot tied to a specific
subscription `payments` row to begin with — `onPaymentRefunded` marks the
payment `refunded` (idempotent, via a `status` compare-and-swap) and audits
that no clawback applies, honestly, rather than pretending otherwise.

**A second, smaller gap found while testing this (B01b):**
`passes_purchased.lot_id` has a real foreign key to `credit_lots`, which the
production `LedgerCreditsFacade` always satisfies (it creates the row in the
same transaction as `grantLot`). This suite's own harness
(`test/billing-harness.ts`) deliberately binds `CREDITS_FACADE` to
`NoopCreditsFacade` for billing's tests — "this suite is about billing's own
logic ... not on the ledger actually moving money" — whose `grantLot` returns
a synthetic id with no row behind it. Storing that id on `passes_purchased.
lot_id` violated the foreign key (Prisma `P2003`, mapped to a bare 409 by the
shared `HttpExceptionFilter`) on every pass/top-up checkout in this suite,
which had nothing to do with the clawback logic actually under test. Two
fixes were possible: bind the real `LedgerCreditsFacade` in this harness (a
bigger change, and against the harness's own stated purpose), or make the
one write that needs a real lot tolerate a synthetic one. `grantPass`
(`webhooks.service.ts`) now catches that specific write in a `try`/`catch` —
the lot link is bookkeeping for a best-effort clawback, not part of granting
the credits itself, so a failure to record it must not fail the webhook. The
practical effect in this suite: a purchase made through the normal checkout
flow in this harness leaves `passes_purchased.lot_id` as `null`, so the
webhook-driven and admin-path clawback tests in that position exercise
`"nothing_to_claw_back"`. The `manual_action_required`/shortfall branches are
covered by `refunds.service.test.ts` (mocking `LedgerCreditsFacade`
directly), and the full `clawed_back` path against a real lot and a real
balance is covered by `billing.e2e-spec.ts`'s "B01d" test, which fetches
`LedgerCreditsFacade` from the app directly (`ctx.app.get(...)`) to seed a
real lot without needing the harness's `CREDITS_FACADE` override changed.

## Open questions (Razorpay behaviours not verifiable without live keys)

1. **Exact webhook event id source.** Razorpay's webhook JSON does not
   consistently carry a stable top-level event id in every account
   configuration; some deliveries add an `X-Razorpay-Event-Id` header, which
   this work package's `parseWebhook(rawBody, signature)` signature (pinned
   by the brief) cannot see. `deriveEventId` instead hashes `(event,
primaryEntityId, created_at)` from the body — stable across retries of the
   same delivery, distinct across genuinely different events. Confirm against
   a live account whether the header ever disagrees with this derivation, and
   if the controller should also accept `X-Razorpay-Event-Id` as an
   additional signal.
2. **Exact shape of a "mandate" webhook event.** RR-05 did not confirm
   distinct `mandate.*` events for the Subscriptions API (UPI Autopay/eNACH
   mandate state is normally conveyed through `subscription.*` events); this
   work package defines a speculative `mandate.activated/revoked/paused`
   family in `provider.ts`'s `BillingEventType` and `webhooks.service.ts`'s
   `onMandateEvent`, but `FakeProvider.emitWebhook` cannot build a realistic
   fixture for it (no `mandate` entity in its payload) — the e2e test only
   exercises the "nothing to resolve" no-op branch. Card tokenisation's
   `token.confirmed`/`token.rejected` events may be the real mechanism
   instead; needs a live account to confirm.
3. **The exact request shape for a variable-amount, capped UPI Autopay
   mandate.** Razorpay's Subscriptions API bills off a Razorpay-side `plan`
   object (fixed amount); how a _capped, variable_ amount is actually
   registered (an `addons`-based flow, a dashboard-configured AFA ceiling, or
   something else) could not be confirmed. This work package's own mandate
   cap enforcement does not depend on Razorpay accepting a "cap" parameter —
   it is enforced by our own `mandates.maxAmountMinor` plus the database CHECK
   constraint, provider-independent and fully tested against `FakeProvider` —
   but the live Razorpay account's own AFA ceiling should be confirmed
   operationally before go-live as a second line of defence.
4. **eNACH's real per-debit cap**: RR-05 flagged a contradiction between
   Razorpay's docs (₹1,00,00,000) and a Razorpay blog post (₹10 lakh). Not
   load-bearing here (`decideMandate` never rejects an eNACH mandate for
   being too large), but relevant to any future UI copy promising a ceiling.
5. **Whether `payments.refund` is refunded on refunds** (RR-05 open question 7) — affects the unit-economics figures, not this work package's code.
