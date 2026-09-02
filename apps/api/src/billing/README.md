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

| Method | Path                                   | Auth      | Notes                                                                                                                        |
| ------ | -------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/billing/plans`                       | public    | INR + USD catalogue                                                                                                          |
| POST   | `/billing/checkout`                    | admin     | `{planKey, interval, coupon?, seats?, method?}` → checkout payload or `409 billing/mandate_cap_exceeded` with `alternatives` |
| POST   | `/billing/passes/checkout`             | admin     | `{kind: first_export\|week_pass\|pay_once, planKey?}`                                                                        |
| POST   | `/billing/topups/checkout`             | admin     | `{credits}`                                                                                                                  |
| POST   | `/billing/webhooks/razorpay`           | signature | idempotent by derived event id                                                                                               |
| GET    | `/billing/subscription`                | viewer    | current subscription, or `null`                                                                                              |
| POST   | `/billing/subscription/cancel`         | admin     | at period end                                                                                                                |
| POST   | `/billing/subscription/resume`         | admin     | undoes cancel, or unpauses                                                                                                   |
| POST   | `/billing/subscription/pause`          | admin     | once per 12 months                                                                                                           |
| GET    | `/billing/subscription/change-preview` | viewer    | proration preview                                                                                                            |
| POST   | `/billing/subscription/change-plan`    | admin     | applies the change; re-registers the mandate when needed                                                                     |
| GET    | `/billing/mandates`                    | viewer    |                                                                                                                              |
| POST   | `/billing/mandates/{mandateId}/revoke` | admin     | cancels the linked subscription too                                                                                          |
| GET    | `/billing/payment-methods`             | viewer    |                                                                                                                              |

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
5. **`payment.refunded` does not claw back credits.** `CreditsFacade`
   (CONTRACTS §4, frozen for Wave 1) has no "reverse a lot" method — only
   `reserve`/`settle`/`release`/`grantLot`. The refund is recorded on the
   `payments` row and audited; the credit ledger is left untouched. B02 owns
   the real ledger and the reversal semantics.
6. **`chargeRenewal` against the live `RazorpayProvider` throws.** Razorpay
   auto-charges a registered recurring mandate on its own schedule; there is
   no publicly documented "charge this subscription now" call for a manual
   retry. `RazorpayProvider.chargeRenewal` says so explicitly rather than
   silently doing nothing; `RenewalService.handleDecline`'s retry step
   catches and logs the failure rather than crashing the webhook path.
7. **`event id` is derived from the webhook body**, not read from an
   `X-Razorpay-Event-Id` header — see "Open questions".

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
