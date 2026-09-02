# `streak` — the streak experiment (B06)

Design references: `03-architecture/04-pricing-and-monetization.md` v2
§Streak rewards; `03-feature-spec.md` F-604; `06-data-model.md`
(`streak_experiments`, `publish_events`); `12-redesign-decisions.md` D52, D60;
`08-ux-design-system.md` §4 Streak widget.

## Shape

- `streak.engine.ts` — pure functions only: holdout assignment, the Mon-Sun
  week window in a workspace's own timezone, and the `rolloverWeek` state
  machine. No database, no clock but the one passed in — every transition is
  a table test (`streak.engine.test.ts`).
- `streak.service.ts` — DB orchestration: assignment (`ensureAssigned`), the
  `GET /streak` read model, `getDiscountPercent` (read by `StreakDiscountService`
  for B01), and `rolloverOne` (applies one week's transition and the rewards
  it triggers).
- `streak-discount.port.ts` / `streak-discount.service.ts` — the interface
  `billing/`'s `RenewalService` reads a discount percent through, so `billing/`
  never imports `streak/` directly; `StreakModule` binds the token, and
  `BillingModule` imports `StreakModule` to see it.
- `streak-rollover.task.ts` — hourly scheduled task (self-registered against
  `common/scheduler`, the same pattern every other periodic task in this
  codebase uses) that closes out any workspace's week once it has actually
  elapsed.
- `streak-nudge.task.ts` — the Tuesday-evening nudge, every 15 minutes,
  acting only once a workspace's own local clock reads Tuesday ≥ 18:00 and
  it has 0-1 publish days so far that week.
- `streak.controller.ts` — `GET /streak`, `POST /streak/test-hooks` (refused
  outside `NODE_ENV=test`).
- `../admin/streak/` — `GET /admin/metrics/streak`, cohort metrics.

## State machine

```
                    ensureAssigned()
                          │
              ┌───────────┴───────────┐
        flag off / minor        flag on, adult
              │                        │
        (no row, eligible:false)  assignHoldout(workspaceId)
                                        │
                          ┌─────────────┴─────────────┐
                     holdout=true                holdout=false
                  (row tracked, no rewards)     (row tracked, rewards apply)
                                        │
                                weekly rollover (rolloverWeek)
                                        │
        ┌───────────────┬──────────────┼──────────────┬──────────────┐
   kept (≥3 days)   missed, freeze   missed, no      kept, paused   kept, creditsOnly
        │            available        freeze              │              │
   consecutiveWeeks++         freezesRemaining--      resume:        consecutiveWeeks++
        │              (state otherwise unchanged)   consecutiveWeeks=1  │
   4 kept weeks?                                       paused=false  2 kept weeks?
        │                                                             │
   level = min(5, level+1)                                    +5 credits, counter resets
   consecutiveWeeks = 0
```

A level never decreases in any branch. A missed week with no freeze left sets
`paused=true` and resets the progression counter to 0 — **not** the level.

## Reward application points

- **L2/L3 (5%/10% off renewals)** — `StreakDiscountService.getDiscountPercent`
  (0 for holdout/paused/creditsOnly) is read by `billing/renewal.service.ts`'s
  `renewalAmountMinor`, applied via `billing/money.ts`'s `applyDiscountWithinCap`
  to both the pre-debit notice amount and the manual dunning retry charge.
  Never above the mandate cap: the cap **is** the undiscounted `listPriceMinor`.
- **L4/L5 (+50/+100 credits/month)** — `StreakService.rolloverOne`, on the
  tick a workspace levels into L4/L5 or a new calendar month starts while
  already there, calls `CreditsFacade.grantLot({source: "grant", tenths,
expiresAt: <end of that calendar month>})`.
- **Free credits-only (+5 after a 2-week streak)** — same `rolloverOne`, via
  `grantLot({source: "grant", tenths: 50})`, no expiry.
- **Holdout** — none of the above ever fire; `rolloverOne` returns before
  reaching any `grantLot` call, and `getView`/`getDiscountPercent` report `0`.

## Deviations and assumptions

1. **`streak_experiments` gained six columns** (`freezesRemaining`,
   `freezesMonth`, `paused`, `creditsOnly`, `lastNudgeAt`, `createdAt`) beyond
   06's original four-field sketch (`design pending RR-10`) — the brief names
   `freezesRemaining` explicitly; the rest are the minimum this work package
   needed to make pause-vs-freeze, the Free variant, the nudge's own
   idempotency and the admin cohort's week-4 anchor all persistent rather than
   recomputed from `publish_events` on every read.
2. **No admin endpoint to toggle a feature flag or force a workspace's level**
   exists yet — `POST /streak/test-hooks` covers publish days and a forced
   rollover (enough for the engine and reward acceptance tests); the
   Playwright suite writes `feature_flags`/`streak_experiments` rows directly
   with `pg`, the same pattern `editor-fixtures.ts#insertProbedMedia` uses for
   the one piece of setup no authenticated HTTP route reaches.
3. **The monthly L4/L5 credit grant is keyed off the calendar month**, not a
   subscription's own billing anniversary — 04 §Streak rewards says "credits
   /month" without tying it to a specific subscription, and the streak state
   has no subscription id to anchor on (a workspace can change plans mid
   streak). Flagged rather than guessed silently.
4. **`GET /streak`'s `nextRewardLabel`** is computed from `level + 1` purely
   for display — it is not itself a reward and carries no server-side
   guarantee about what a future rollover will actually do.

## Open questions

- Whether the two auto-freezes should reset on the calendar month or on a
  rolling 30 days from assignment — this work package reads D52 literally
  ("2 auto-applied freezes per month") as the calendar month.
- Whether a plan downgrade to Free mid-streak should force `creditsOnly=true`
  immediately or only at the next assignment read — not specified; current
  behaviour is "only re-evaluated if the row does not exist yet"
  (`ensureAssigned` never mutates an existing row's `creditsOnly`).
