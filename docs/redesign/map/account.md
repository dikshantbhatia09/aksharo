# Account area map: billing, settings, team, affiliate, academy, help, plugins

Owner: the account-area designer on the Shirorekha rebuild (2026-09-25).
Spec: `docs/redesign/DESIGN.md`. HIG references are cited as `file.md › Heading`,
from `~/.claude/skills/apple-design/references/hig/`. This is a web app, so the
citations cover principles and foundations only, not iOS/macOS conventions.

File:line references in the audit point at the code **before** this pass (the
commit `0d5e1df0` tree). Changed files are listed under "Changes made".

## Measured contrast (WCAG 2.x, from the token hexes in `tokens.css`)

| Foreground / background | Ratio | Verdict |
|---|---|---|
| `fg-2` #a39a93 / surface #1f1c23 | 6.09 | pass |
| `fg-2` / `bg-2` #2a262f | 5.37 | pass |
| `neutral-400` #bcb3ac / surface | 8.15 | pass |
| `neutral-300` = `fg-1` / surface | 10.91 | pass |
| `fg-disabled` #7c746e / surface | 3.67 | disabled only (exempt) |
| accent #f0508a / surface | 4.98 | passes body text, but spends the accent budget |
| accent / bg-0 | 5.51 | pass |
| accent / bg-2 | **4.39** | **fails 4.5 for body text** (use `accent-300`) |
| `accent-300` #f78bb0 / bg-2 | 6.55 | pass |
| `accent-300` / accent-10 % tint on surface (accent badge) | 6.62 | pass |
| `accent-200` / accent-12 % tint on bg-0 (active nav row) | 11.38 | pass |
| ink #141217 / accent (primary button) | 5.51 | pass |
| black #000 / accent (old academy step dot) | 6.22 | passes, but raw black is banned |
| `info` / info-10 % tint | 5.85 | pass |
| `warning` / surface | 8.60 | pass |
| `accepted` / surface | 8.85 | pass |
| `rejected` / surface | 6.18 | pass |
| `neutral-800` track / surface (old credits meter) | 1.44 | non-text; the fill carries the value |

No text in this area fell below 4.5:1 once the tokens were applied. The
contrast problems were structural instead: text below the 11 px floor, and
unselected language chips faded to 70 % opacity.

---

## Routes and surfaces

Severity: **C** Critical, **H** High, **M** Medium, **L** Low.

### `/billing` (Overview) and the billing shell

- **Job:** show the plan, the credit balance and what the balance buys, then let the person change plan or see where the credits went.
- **Renders:** `app/(app)/billing/layout.tsx` (section nav), `page.tsx` → `components/billing/overview-panel.tsx` → `credits-buy-card.tsx`, `free-stack-notice.tsx`, `plan-table.tsx` (rail only), `usage-panel.tsx`, `streak/streak-widget` (flag), `checkout-sheet.tsx`.
- **Reached from:** the sidebar's "Subscription" entry, the credits widget, and upgrade gates across the app.
- **Audit:**
  - **C:** no page title anywhere on `/billing/*`. The layout rendered only the section nav, and each panel started with cards (`billing/layout.tsx:43`). `layout.md › Visual hierarchy` ("Order content by relative importance"); DESIGN › PageHeader.
  - **H:** four or more filled primaries on one surface: "See plans" (`overview-panel.tsx:121`), "Top up" (`:210`), "Change plan" (`:357`), plus a `primary` on every card of the embedded `PlanTable` (`plan-table.tsx:320`). `buttons.md › Style`; DESIGN › Components (once per surface).
  - **H:** accent spent as decoration: an accent "Your plan" kicker (`overview-panel.tsx:115`, `:337`), an accent badge for `active` (`:48`), and an accent border on the free-stack notice (`free-stack-notice.tsx:6`). `color.md › Best practices` ("Avoid using the same color to mean different things"); DESIGN › accent budget.
  - **H:** 10 px text (`text-[10px]` at `overview-panel.tsx:115`, `:152`, `:337`; `credits-buy-card.tsx:51`) is below the 11 px floor, and there were `text-[12.5px]` and `text-[13px]` one-offs off the type scale. `accessibility.md › Vision` (minimum sizes); `typography.md › Ensuring legibility`.
  - **M:** `font-display` on card headings and section headings (`overview-panel.tsx:116`, `:236`, `:242`, `:342`). DESIGN › Type allows it only on titles and large stat figures.
  - **M:** cards used `shadow-[var(--shadow-sm)]` with no border and `p-[18px]` (`:108`, `:151`) instead of the card recipe. Judgment / DESIGN › Components.
  - **M:** a credits error was rendered in muted grey with no `role="alert"` (`:156`). `writing.md › Best practices` (clear error messages).
  - **L:** the hand-built 3 px meter track was `neutral-800` on surface at 1.44:1, with no `progressbar` role (`:184`). `accessibility.md › Vision`.

### `/billing/plans`

- **Job:** compare the paid plans and start checkout for one of them.
- **Renders:** `plan-table.tsx` (segmented interval and payment-mode controls, plan cards, offers ladder, credits-to-outcomes table, FAQ) → `checkout-sheet.tsx` → `tax-profile-step.tsx`.
- **Reached from:** the Overview, upgrade gates and the checkout "Change plan" button.
- **Audit:**
  - **H:** a filled `primary` on all four plan cards (`plan-table.tsx:320`), so no plan read as recommended. `buttons.md › Style`.
  - **H:** the selected segment of both segmented controls was an accent fill (`:106`, `:131`), and the segments were about 26 px tall (below 32 px). `accessibility.md › Mobility`; DESIGN › accent budget.
  - **M:** accent "+" glyphs in every feature list (`:311`) and an accent "Current plan" badge (`:237`). DESIGN › no accent icons in lists.
  - **M:** `font-display` on three section h2s (`:438`, `:468`, `:538`).
  - **M:** four "Buy" buttons with identical accessible names (`:448`). `writing.md › Best practices` (be action oriented; descriptive labels for screen readers).
  - **L:** the seat input used `bg-bg-1`, not the `bg-sunken` input recipe (`:293`).
  - **L:** the Razorpay widget colour was still Nocturne's `#9184d9` (`checkout-sheet.tsx:148`), and the gateway spinner was accent (`:264`).
  - **L:** the tax step's select used `bg-bg-1` (`tax-profile-step.tsx:37`).

### `/billing/methods`, `/billing/invoices`, `/billing/usage`

- **Job:** in turn, manage saved methods and mandates; download GST invoices; audit the credit ledger and download it as CSV.
- **Renders:** `payment-methods-panel.tsx`, `invoices-panel.tsx`, `usage-panel.tsx`. Methods and invoices are hidden without Razorpay (F07-C1).
- **Audit:**
  - **M:** accent badges on "Default" and on an `active` mandate (`payment-methods-panel.tsx:77`, `:100`). An `active` status is a signal (accepted), not the brand colour.
  - **M:** each usage row was its own card (`usage-panel.tsx:136`), a heavy stack for a ledger. DESIGN › Lists/tables (divided rows); `lists-and-tables.md › Best practices`.
  - **M:** empty states gave no next step: "No activity yet." (`usage-panel.tsx:130`), "Nothing on file yet" (`payment-methods-panel.tsx:63`). `writing.md › Best practices` ("Provide clear next steps on any blank screens").
  - **L:** "Download PDF" repeated on every invoice with no distinguishing name (`invoices-panel.tsx:130`), and "Revoke" had no object (`payment-methods-panel.tsx:127`).

### `/settings` → `/settings/profile` (and the settings shell)

- **Job:** change your name, see your sign-in address and role, and find where sign-in methods and devices live.
- **Renders:** `settings/layout.tsx` (section nav), `components/settings/section.tsx`, `profile/profile-view.tsx`.
- **Reached from:** the profile menu and the command palette. `/settings` redirects here.
- **Audit:**
  - **C:** every settings page title was a bare `font-display` `<h1>` without the shirorekha (`section.tsx:21`), so the settings pages never showed the signature. DESIGN › Signature.
  - **H:** the page's only real action ("Save") was `secondary` (`profile-view.tsx:78`). `buttons.md › Style`.
  - **M:** accent inline links (`text-lime-500`, `:102`) across every settings view. DESIGN › Components: links are `accent-300`, underlined.
  - **M:** the role badge showed a bare lowercase token ("owner") (`:86`). `writing.md › Best practices` (consistent language).
  - **L:** the section nav used `text-[12.5px]` off the type scale (`settings/layout.tsx:35`).

### `/settings/languages`

- **Job:** set the spoken languages and aspect ratio a new project assumes.
- **Audit:**
  - **H:** unselected language chips were faded to `opacity-70`, dropping the chip's text below its designed contrast, and the selection showed only as an accent ring, so the state rested on colour (`languages-view.tsx:112`). `accessibility.md › Vision` ("Convey information with more than color alone"); `color.md › Inclusive color`.
  - **M:** "Save defaults" was secondary on a page whose only action it is (`:143`).
  - **L:** the radio rows were about 36 px tall, with hover on the border only (`:126`).

### `/settings/memory`

- **Job:** view, edit, add, import and clear the spellings and glossary the app remembers.
- **Audit:**
  - **H:** three form controls had no accessible name: the glossary term input, which had only a placeholder (`memory-view.tsx:323`), the CSV textarea (`:361`), and the edit dialog's input (`:271`). `accessibility.md › Mobility` (label interface elements); `writing.md › Best practices` ("Show hints in text fields").
  - **M:** a hard-coded "Aksharo" in the copy (`:320`) instead of `BRAND.name`.
  - **M:** an accent badge for "This device only" (`:203`).
  - **L:** generic labels "Add" and "Import" (`:351`, `:391`); the dialog's Save was not the primary.

### `/settings/devices`

- **Job:** see and revoke every signed-in session and every registered plugin or desktop device.
- **Audit:**
  - **H:** the rename input had no accessible name, and there was no way to cancel a rename (`devices-view.tsx:193`). `accessibility.md › Mobility`.
  - **M:** accent "This device" badges (`:61`, `:206`).
  - **M:** rows did not wrap, so buttons overflowed at 360 px (`:57`, `:180`). `layout.md › Adaptability`.
  - **L:** the sessions list had no heading, while the devices list did (`:38`, `:160`).

### `/settings/privacy`

- **Job:** grant or withdraw each consent, export your data, and delete the account.
- **Audit:**
  - **M:** accent inline link (`privacy-view.tsx:205`).
  - **L:** headings used weight 500, not the 600 heading default.
  - Otherwise sound. The destructive card uses the rejected signal with words, the delete dialog requires typing DELETE (`managing-accounts.md › Deleting accounts`), and the consent toggles are native switches.

### `/settings/subscription`

- **Job:** a compact read of the plan, pass status and the ₹149 top-up.
- **Audit:**
  - **M:** no route onward to the full billing page. `writing.md › Best practices` ("provide a direct link").
  - **M:** an accent badge for an `active` status, showing the raw status word (`subscription-view.tsx:68`).
  - **L:** pass chips used the accent tone for `available` and `active` (`PassStatusChips.tsx:29-30`).

### `/settings/notifications`

- **Job:** say, honestly, that there are no notification choices yet.
- **Audit:** **L:** an h2 at weight 500. Otherwise correct and honest.

### `/settings/developers`

- **Job:** create, rotate and revoke API keys; register, test and inspect webhooks.
- **Audit:**
  - **C:** two `<h1>`s on one page, because the view rendered two `SettingsSection`s ("Developers" and "Webhooks") (`developers-view.tsx:68`, `:83`). `layout.md › Visual hierarchy`; DESIGN › PageHeader (exactly one).
  - **H:** the icon-only webhook delete button had no accessible name (`:366-374`). `accessibility.md › Vision` (describe the interface for VoiceOver).
  - **M:** no primary on the page, "Copy" and "Done" were reversed in emphasis in the reveal-secret dialog (`:556-566`), and a `target="_blank"` link had no `rel` (`:75`).
  - **L:** the reveal box was `bg-bg-2`, the key prefix and webhook URL were not monospace, and the "Delivery log" toggle had no `aria-expanded`.

### `/settings/support`

- **Job:** file a support ticket, optionally with diagnostics, and follow its status.
- **Renders:** `components/support/support-view.tsx`.
- **Audit:**
  - **H:** a hand-rolled `<input>` and `<select>` (`support-view.tsx:143`, `:153`) bypassed the input recipe (`bg-bg-1`, `rounded-md`), and "Send" was the default secondary.
  - **M:** "Settings → Privacy" was plain text where a link belonged (`:204`). `writing.md › Best practices` ("provide a direct link").
  - **L:** the unstyled native file input.

### `/team`

- **Job:** see members, invite, change roles, remove members, transfer ownership, and read the seat cost.
- **Renders:** `app/(app)/team/team-view.tsx`.
- **Reached from:** the sidebar's "More" section and the command palette.
- **Audit:**
  - **C:** an ad-hoc `font-display` h1 with no shirorekha (`team-view.tsx:154`).
  - **H:** "Invite" (`:160`) was the default secondary on a page whose main job is inviting.
  - **M:** member rows could not wrap (`:346`), and hand-rolled selects used `bg-bg-1 rounded-md` (`:182`, `:358`). `layout.md › Adaptability`.
  - **M:** the transfer dialog had no way to back out except closing it (`:305`). `alerts.md › Buttons`.
  - **M:** the empty state had no action (`:232`). `writing.md › Best practices`.
  - **L:** "Remove" had no object for screen readers (`:383`).

### `/affiliate`

- **Job:** apply to the affiliate programme, then track the referral link, stats, tier and FY TDS.
- **Renders:** `app/(app)/affiliate/affiliate-view.tsx`. The route is gated by `assertServerSurfaceEnabled("affiliates")`.
- **Audit:**
  - **C:** the title was repeated in three branches (`affiliate-view.tsx:94`, `:288`, `:300`), and the loading and error states had no title at all (`:69-84`).
  - **H:** the apply button was secondary and read "Apply" (`:368`). `writing.md › Best practices` (the label names what happens).
  - **M:** "Pending review" used the accent tone (`:43`), the read-only link input had no name (`:123`), and the FY table stayed 3 columns at 360 px (`:202`).
  - **L:** the arrow-glyph link "Open the asset pack →" (`:240`).

### `/affiliate/assets`

- **Job:** the scripts, demo cuts, disclosure labels and programme rules an affiliate needs.
- **Audit:**
  - **C:** an ad-hoc h1 (`assets/page.tsx:36`).
  - **M:** the disclosure table had no `scope` and no overflow handling at 360 px (`:95`); placeholders sat on `bg-bg-2`; "Aksharo" was hard-coded in the rules (`:119`).
  - **L:** the back link was an accent text link placed under the description (`:41`).

### `/academy` and `/academy/[trackId]`

- **Job:** pick an outcome-based track; work through its steps and earn the credit reward.
- **Renders:** `components/academy/academy-track-list.tsx`, `academy-track-detail.tsx`. Also `changelog-list.tsx` (rendered by `/updates`, outside this area's routes) and `whats-new-modal.tsx` (mounted by the shell).
- **Audit:**
  - **C:** ad-hoc display h1s (`academy-track-list.tsx:30`, `academy-track-detail.tsx:30`, `changelog-list.tsx:15`).
  - **H:** a filled "Mark done" on every unfinished step (`academy-track-detail.tsx:80`).
  - **H:** the done step dot was `bg-lime-500 text-black`, raw black and an accent fill (`:62`).
  - **M:** accent icons on every track card (`academy-track-list.tsx:46`); the track-card links sat in `<li>` without `no-underline`, so the base stylesheet underlined whole cards (`:43`).
  - **M:** an internal "Help centre" link carried an external-link icon (`academy-track-detail.tsx:124`). Judgment.
  - **L:** a 2xs italic helper (`academy-track-detail.tsx:72`); `bg-bg-2` tags (`changelog-list.tsx:40`, `whats-new-modal.tsx:110`); the modal's "Got it" was not the primary.

### `/help` and `/help/[slug]`

- **Job:** search or browse the help articles, read one, and reach support.
- **Renders:** `components/help/help-centre.tsx`, `help-article-view.tsx`.
- **Audit:**
  - **C:** ad-hoc display h1s (`help-centre.tsx:59`, `help-article-view.tsx:14`).
  - **M:** an accent icon plus an accent link in the support card (`help-centre.tsx:123`, `:128`); card links inside `<li>` were underlined by the base stylesheet (`:84`, `:104`); the no-results message was a `<p>` inside a `<ul>` (invalid markup) and gave no next step (`:80`). `writing.md › Best practices`.
  - **L:** the 12 px back link was about 16 px tall (`help-article-view.tsx:11`). `accessibility.md › Mobility`.

### `/plugins/keys` and `/plugins-app`

- **Job:** in turn, manage offline licence keys; install, connect and manage the Adobe and Resolve plugins.
- **Renders:** `app/(app)/plugins/keys/license-keys-view.tsx`; `app/(app)/plugins-app/plugins-view.tsx` → `components/plugins/activation-card.tsx`, `plugin-status.ts`, `billing-upgrade-gate.tsx`, plus `LicenseKeysView` embedded.
- **Audit:**
  - **C:** `/plugins-app` rendered two `<h1>`s, its own "Plugins" and the embedded `LicenseKeysView`'s "Licence keys" (`plugins-view.tsx:86`, `:147`; `license-keys-view.tsx:86`).
  - **H:** the loading and error states of `/plugins-app` had no title (`plugins-view.tsx:52-66`).
  - **M:** the download links were 12 px accent text, about 16 px tall (`activation-card.tsx:107`); accent inline links (`:124`, `:128`, `:201`); `font-display` on the card title (`:78`); the `signed_in` state used the accent tone (`:19`). `accessibility.md › Mobility`.
  - **M:** licence rows could not wrap; "Revoke" had no object; "Create" and "Copy" labels were generic.
  - **L:** Adobe's trademark line hard-coded "Aksharo".

### Components with no route of their own

- `components/referrals/invite-friends-tab.tsx`: not mounted anywhere (B07's page never landed). **M:** `font-display` on an h2 (`:46`); a 3-column stat grid at 360 px (`:57`).
- `components/referrals/referral-prompt-sheet.tsx` and `referral-share-row.tsx`: mounted by the shell. They already have one primary (WhatsApp), and the copy buttons' accessible names contain their visible labels. No change.
- `components/billing/billing-upgrade-gate.tsx`: wraps `@montaj/ui`'s `UpgradeGate`. No visual code here.

---

## Changes made

**One title per page, with the shirorekha:**

- `components/settings/section.tsx`: `SettingsSection` now renders `<PageHeader eyebrow="Settings">`. That covers every settings page, still as an `h1` (the shell test pins it). It gains an optional `actions` slot, a new `SettingsGroup` (an h2 group for two related tools on one page), and a shared `INLINE_LINK_CLASS` (`accent-300`, underlined).
- `billing/layout.tsx`: a `PageHeader` "Subscription" above the section nav. The description changes with the payment rail.
- Team, affiliate (one header across loading, error, apply and dashboard), the asset pack, licence keys, plugins (in its loading and error states too), help centre, help article, academy list, academy track and the changelog all use `PageHeader`. Back links sit above the title as 32 px neutral links.
- `developers-view.tsx`: one "Developers" page with "API keys" and "Webhooks" as `SettingsGroup`s. `data-testid="settings-webhooks"` moved to the group.
- `license-keys-view.tsx`: a new optional `embedded` prop. `/plugins-app` passes it, which gives an h2 and a secondary "New key", so that page keeps one h1.

**One primary per surface:**

- Overview: the plan card's action (See plans / Change plan). "Top up credits" is secondary, and the embedded `PlanTable` gets `emphasis="none"`. `PlanTable` has a new optional `emphasis` prop, defaulting to "recommended": only Creator is filled, the others are secondary, and the current plan's button is ghost.
- Profile: "Save profile". Languages: "Save defaults". Developers: "New API key" (webhooks secondary). Team: "Invite a member". Affiliate: "Send application", or "Copy link" once approved. Licence keys: "New key". Support: "Send ticket". Academy track: only the next manual step's "Mark done". Dialogs: the confirm action is primary and cancel is ghost (API key, webhook, memory edit, team transfer, what's new, reveal secret with "Copy secret").

**Accent discipline:**

- Status tones moved off the accent onto signals, each with its word: subscription `active`, mandate `active`, pass `available`/`active`, plugin `signed_in` → accepted; affiliate `pending` → warning. "Default", "This device", "This device only" and "Current plan" → neutral. The current plan card carries `ring-1 ring-accent` instead.
- Removed the accent kickers, the accent "+" list glyphs (now a neutral lucide `Check`), the accent icons (academy cards, help support card), the accent spinner, the accent notice border, the accent-filled segmented controls (now a raised neutral well plus weight, with `aria-pressed`), and the `bg-lime-500 text-black` step dot (now accepted-tint plus a check glyph).
- Every inline `text-lime-500` or `text-accent` link → `INLINE_LINK_CLASS`, or a secondary button where it was really an action ("Contact support", "Open the help centre", "Download for {host}").
- Razorpay widget colour updated from Nocturne `#9184d9` to rani `#f0508a`. It stays a literal, because the widget is a third-party iframe.

**Type:** removed `font-display` from every non-title. It stays on the credit balance and the referral stat figures (large stats). `text-[10px]`, `[11px]`, `[12.5px]`, `[13px]`, `[17px]`, `[25px]` and `[34px]` were replaced with scale steps (2xs, xs, sm, lg, xl, 4xl). Headings are weight 600.

**Accessibility:**

- Accessible names added to: the glossary input, the CSV textarea, the memory edit input, the device rename input, the webhook delete icon button, the referral link input, the invoice download buttons, the offers "Buy" buttons, and team "Remove" and licence "Revoke". Each name contains the visible label (WCAG 2.5.3).
- `aria-expanded` added on "Delivery log"; `rel="noopener noreferrer"` on the API-docs link.
- Hit targets raised to 32 px or more: segments, back links, the `<summary>`, checkbox rows, language chips, and radio rows (40 px).
- Rows wrap at 360 px: sessions, devices, keys, webhooks, members, tickets, invoices-adjacent rows, the FY grid, and the referral stats.
- The disclosure table got `scope` and horizontal overflow.
- Language chips no longer fade, and selection shows a check mark as well as the ring.
- The credits meter uses the `ProgressBar` primitive, with its role and label.

**Structure and copy:**

- The usage ledger, lots and help article lists are one card with divided rows, not a stack of cards.
- Empty states now name the next step (usage, methods, mandates, invoices, tickets, devices, team with an invite action for admins, licence keys, help no-results, changelog).
- Labels say what happens: "Save profile", "Top up credits", "Pause subscription", "Cancel subscription", "Resume subscription", "Revoke mandate", "Download CSV", "Add term", "Import terms", "Save name", "Create key", "Copy key", "Invite a member", "Keep ownership".
- `/settings/subscription` gains "Open billing". The support privacy hint is a real link. Hard-coded "Aksharo" → `BRAND.name`, except in the ASCI disclosure labels, which are fixed legal text.
- Inputs and selects use the `bg-sunken border-border rounded-sm` recipe; support uses the `Input` primitive.

**Verification** (from `apps/web`):

- `pnpm exec tsc --noEmit`: clean.
- `npx vitest run` over every owned directory plus `components/shell/app-shell.test.tsx`: 21 files, 98 tests, all pass. One copy assertion ("no checkout or payment details are required") was kept verbatim rather than rewritten.
- `packages/ui` vitest: 119/119 pass.
- `eslint` on all 36 changed files: 0 errors (one import-order issue fixed).
- No `data-testid` was removed or renamed; no API call, hook or business rule changed.

## Review pass (same day)

A reviewer re-read the diff and fixed:

- `UsagePanel` gained an optional `nested` prop (additive, presentational). The Overview passes it, so "Credit lots" and "History" render as `h3` under "Where the credits went"; `/billing/usage` keeps them as `h2`.
- `/affiliate`: while the affiliate record is loading, the header no longer shows the approved-dashboard description; it shows a neutral one.
- `overview-panel.tsx`: the last arbitrary `gap-[9px]` became `gap-2`.
- Corrected audit line references that pointed at diff offsets instead of the `0d5e1df0` files (payment methods, usage, settings layout, languages, subscription, plugins, asset pack, help centre, invoices, academy track).
- Checked: no `data-testid` removed (`registered-devices` moved onto `SettingsGroup`, `settings-webhooks` likewise; `help-search-results` now also marks the no-results message); e2e role/label locators in the area still match (Playwright name matching is substring, so `Revoke` still finds `Revoke {label}`).
- Still open: settings puts its title in the content column under the section nav on phones, while billing puts it above the nav. Both work; they are not the same pattern.

## Deferred

- **Confirmation before destructive one-click actions (H, behaviour change):** team "Remove", session "Revoke" and "Sign out here", device "Revoke", API key "Revoke", licence key "Revoke" and webhook delete all act on one click. `alerts.md › Best practices` and `managing-accounts.md` argue for a confirm step, but adding one changes flows that e2e specs click straight through (`team-devices-licensing.spec.ts:48`). Needs an owner decision.
- **The activation card's "Sign out this device" and "Revoke" call the same mutation** (`activation-card.tsx`), so the two buttons differ only in name. Both have test ids. Merging them is a product call.
- **The settings and billing section nav on phones** is a horizontally scrolling row with no scroll affordance (M). A select or disclosure on small screens would be better, but that is a navigation-pattern change best made alongside the shell's mobile work.
- **Languages and defaults persist only in `localStorage`** (existing, documented behaviour); the page does not say so. Needs copy agreed with the A05 owner.
- **`InviteFriendsTab` is still unmounted.** It was restyled but not placed; placing it is a routing decision.
- **Dark-only appearance** is a DESIGN.md decision (HIG `dark-mode.md` prefers following the system), recorded there, not reopened here.

## Shared requests (files I do not own)

1. `@montaj/ui`: a `TextLink` (or `Link` variant) primitive, so the `accent-300` underlined inline link is not an app-local constant (`INLINE_LINK_CLASS` in `components/settings/section.tsx` is the stop-gap).
2. `@montaj/ui`: a native `Select` primitive matching `Input` (`bg-sunken border-border rounded-sm h-9`). It is hand-rolled in team (two places), support and the tax step.
3. `@montaj/ui`: a `SegmentedControl` primitive (raised neutral well, `aria-pressed`, `min-h-8`). `plan-table.tsx` hand-rolls two.
4. `@montaj/ui` `PageHeader`: an optional `back` slot (href and label), so pages stop hand-placing a back link above it (help article, academy track, asset pack).
5. `@montaj/ui` `EmptyState`: a heading-level prop (it always renders an `h3`, which skips a level on pages whose next heading is the `h1`).
6. `@montaj/ui` `ProgressBar`: its fill still uses the historical `bg-lime-500` name. Renaming it to `bg-accent` is cosmetic, but it would make the accent budget greppable.
