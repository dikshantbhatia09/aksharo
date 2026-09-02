# `academy` — tracks, progress, one-time rewards, What's-new (B12)

Outcome-based Academy tracks, per-user step progress, a one-time per-track
credit reward, and the What's-new modal's per-user dismissed-version marker.

Design references: `03-architecture/03-feature-spec.md` F-801/F-802;
`08-ux-design-system.md` §4 Academy/Help/Changelog.

## What this module owns

- `GET /academy/progress` — this workspace's per-track completed steps and
  reward state, for the current user.
- `POST /academy/tracks/:trackId/steps/:stepId/done` — "Mark done". Idempotent;
  automatically grants the track's reward when it completes the last step.
- `GET/POST /academy/changelog/dismissed` — the current user's last dismissed
  changelog version, backing the once-per-version What's-new modal.
- `AcademyExportCompletedListener` — subscribes to `export.completed`
  (`referrals/export-completed.event.ts`, already emitted by `exports/`) and
  marks every catalogue step whose `completionEvent` is `"export.completed"`
  done for the workspace's owner.

## Content vs. state

Track/step *copy* (titles, outcome text, demo video placeholder, body markdown)
lives as MDX in `apps/web/content/academy/*.mdx`, validated at build by zod
schemas in `apps/web/lib/content/schema.ts`. This module does **not** read
those files — a different app, a different deploy. Instead,
`academy.catalog.ts` is a small, authoritative, hand-kept-in-sync copy of the
same track/step ids, `completionEvent`s and `creditReward`s, which is what the
API validates progress writes against and computes rewards from. If the two
ever drift, the MDX file is still what a user reads, but this catalogue is
what the API and the ledger agree happened — keep them in sync by hand when
either changes.

## Reward rules (brief §2)

- **Exactly once per workspace per track.** `academy_rewards` is unique on
  `(workspace_id, track_id)`. A concurrent double-grant race is closed by that
  constraint — a duplicate `create` is caught (`P2002`) and treated as "someone
  else already granted it," the same shape `referrals.service.ts` uses for its
  `pending → granted` race.
- **Capped 25 credits per track.** Enforced in content (`AcademyTrackFrontmatterSchema`
  `.max(25)`) and mirrored in the catalogue; `content.schema.test.ts` also
  checks it.
- **Capped 100 credits lifetime per workspace.** Before granting, the sum of
  every `academy_rewards.tenths` already recorded for the workspace is checked
  against `ACADEMY_LIFETIME_CAP_TENTHS` (1000 tenths). A track whose reward
  would cross the cap is never granted for that workspace — no partial grant —
  and because the cap only grows (rewards are additive, never reversed), a
  track that lost the race against the cap stays lost.
- **Reward is workspace-scoped, progress is user-scoped.** Credits are a
  workspace resource, so the reward keys on `(workspaceId, trackId)`, but which
  steps are done is tracked per `(workspaceId, userId, trackId, stepId)` — two
  editors in the same workspace each see their own checklist.

## Conflict with CONTRACTS §4, flagged for the orchestrator

The brief's §2 says `grantLot(source: "academy")`. CONTRACTS §4's
`CreditLotSource` is a frozen closed union — `"grant" | "topup" | "pass" |
"referral" | "adjust" | "reversal"` — with no `"academy"` member. This module
calls `grantLot({ source: "adjust", ... })` instead (a manual credit
adjustment, the closest existing member) rather than widening a frozen type
without an ADR. `reason` and `refId` on the lot still identify it as an
Academy grant for the credit history and B13's admin view. Revisit if/when
CONTRACTS §4 gains an `"academy"` (or generic `"reward"`) source.

## What B13 (admin console) reads

`academy_progress` and `academy_rewards` directly — no admin-only route exists
here yet. Both tables are documented above; add an admin read route in this
module rather than forking the query if B13 needs one beyond raw table access.
