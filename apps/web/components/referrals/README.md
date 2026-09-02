# `components/referrals` — the give-get referral loop's UI (B07b)

Two components, both self-contained (they read their own data through
`@montaj/api-client`'s `useReferralStats`/`useMarkReferralPromptShown`/
`useClaimReferral` hooks — see `packages/api-client/src/hooks.ts`):

- **`ReferralPromptSheet`** — the in-app sheet shown once per workspace,
  right after the workspace's first completed export ("Give 30 credits, get
  30 credits", brief §3). Visibility is entirely server-decided: `GET
/referrals/me`'s `promptEligible` flag
  (`apps/api/src/referrals/referrals.service.ts`) is `true` exactly when the
  workspace has a succeeded export and has never been shown the sheet — this
  component never re-derives "first export" itself, it opens when the flag
  says to and marks it shown (`POST /referrals/prompt/shown`) the same
  instant, which is what makes "once per workspace" hold even across a
  closed tab.
- **`InviteFriendsTab`** — the Invite-friends tab content for the Refer &
  Earn page: code, share link, share buttons, and the pending/granted/
  not-eligible counts.

Both render `ReferralShareRow` (`referral-share-row.tsx`) for the
copy-code/copy-link/WhatsApp/X/Instagram-caption row, so the sheet and the
tab behave identically — `share-links.ts` is the one place that builds the
signup URL and the share message text.

## Mount points (neither is wired into a page yet)

B07 owns the Refer & Earn page shell (route, tab navigation, layout) and it
had not landed on `main` when this work package started; this work
package's file boundary is `apps/web/components/referrals/**`, not
`apps/web/app/**`. Both components ship ready to mount with no props:

- **`InviteFriendsTab`** → the content of B07's "Invite friends" tab on the
  Refer & Earn page.
- **`ReferralPromptSheet`** → mount it once, near the root of the signed-in
  shell (`apps/web/components/shell/app-shell.tsx`, alongside where
  `AppShell` already renders its other global providers) so it can open on
  any authenticated page — it is a global growth prompt, not scoped to the
  export dialog or one screen.

## Onboarding claim

`apps/web/app/(app)/onboarding/onboarding-flow.tsx` (A13) already collects a
code into its `referralCode` draft field and saves it into `users.onboarding`
through `PATCH /me` — that alone never claims a referral. This work package
made one small, additive edit to that file (outside this directory's
boundary, same shape as `invoices/billing-events.ts`'s documented B05
deviation): on a successful `finish()`, if `draft.referralCode` is non-empty,
it also fires `useClaimReferral()` — best-effort, errors are swallowed rather
than blocking the redirect to `/`, since a failed claim (an affiliate code,
a typo, an already-claimed workspace) must never strand a new user on
onboarding.
