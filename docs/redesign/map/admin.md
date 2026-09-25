# Admin console and UI kit — map and audit

Area owner files: `apps/web/app/(admin)/**`, `apps/web/components/admin/**`.
Audited against `docs/redesign/DESIGN.md` (Shirorekha) and the Apple HIG pages
in `~/.claude/skills/apple-design/references/hig/`. Line numbers in the
findings refer to the files **before** this pass (commit `HEAD` at the start of
the redesign branch). This is a web app: HIG platform-only rules (tab bars,
menu bars) are not applied; the principles and foundations are.

## Who reaches it, and how

- **/admin/**: staff with a verified admin TOTP only. `middleware.ts` answers
  404 on `/admin/**` without the admin-hint cookie (except `/admin/step-up`),
  and every panel's fetch is re-checked by `AdminGuard` on the API. There is no
  link from the product; an admin types the URL, steps up at
  `/admin/step-up`, and lands on `/admin`. From there the console sidebar
  (`components/admin/admin-shell.tsx`) is the only navigation.
- **/ui-kit/**: developers and reviewers, by URL. It sits in the `(admin)`
  route group for layout reasons only; middleware does not gate it and it
  carries no admin data. Playwright (`ui-kit.spec.ts`, `a11y.spec.ts`,
  `style-preview.spec.ts`, `offers-nine-pass.spec.ts`, `smoke.spec.ts`)
  drives it.

## Measured contrast (WCAG 2 ratios, from the token hexes)

| Pair | Ratio | Verdict |
|---|---|---|
| `neutral-500` #a39a93 on `neutral-950` #0b0a0c (old muted text on old shell bg) | 7.15 | pass |
| `neutral-600` #7c746e on `neutral-950` (old `text-neutral-600` "(kind)" / "—" in evals) | 4.31 | **fail** 4.5 |
| `neutral-600` on `bg-0` #141217 | 4.06 | **fail** |
| `#737373` (old bar-chart label fill) on `neutral-950` | 4.17 | **fail**, and a raw hex |
| `fg-2` #a39a93 on `bg-0` / `surface` #1f1c23 / `sunken` #0e0c10 | 6.73 / 6.09 / 7.05 | pass |
| `fg-1` #d6cfc8 on `bg-0` | 12.07 | pass |
| `rejected` #ef7d4f on `bg-0` / `surface` | 6.84 / 6.18 | pass |
| `accepted` #6fcf97 on `bg-0` | 9.79 | pass |
| `accent` #f0508a on `bg-0` / `surface` | 5.51 / 4.98 | pass (not used as text here) |
| `accent-300` #f78bb0 on `bg-2` #2a262f | 6.55 | pass |
| `neutral-700` #5a534f (candidate bar fill) on `surface` | 2.23 | fails 3:1 non-text — rejected; bars use `neutral-500` |

## Routes

Each entry: path · its one job · what renders it · findings (severity, where,
citation).

### Shell — `components/admin/admin-shell.tsx`, `app/(admin)/layout.tsx`

Job: frame every admin panel with one navigation and the session's roles, and
gate panels behind a step-up.

- **Critical** · admin-shell.tsx:42 · The gate `session === null && pathname !== "/admin/step-up"`
  applied to **every** route in the `(admin)` group, so `/ui-kit`,
  `/ui-kit/style-gallery` and `/ui-kit/export-upsell` showed "Admin step-up
  required" to anyone without an admin session — the kit was unreachable for
  its intended reviewers and the e2e specs that drive it could not pass.
  Middleware already exempts `/ui-kit`. · judgment (HIG writing › Best practices, "Consider each screen's purpose").
- **High** · admin-shell.tsx:9-24 · `/admin/evals` existed but was not in the nav; the only way to reach it was typing the URL. · HIG sidebars › Best practices.
- **High** · admin-shell.tsx:14 items flat, no grouping · fifteen destinations in one undifferentiated list. · HIG sidebars › Best practices ("use succinct, descriptive labels to title each group"); HIG layout › Visual hierarchy ("Group related items").
- **High** · admin-shell.tsx:64 · `bg-neutral-950` (#0b0a0c) is the video-canvas ink, not the page; DESIGN.md › Colour reserves `bg-ink` for video. Nav `text-neutral-500` label, `rounded` (4 px, not a token radius).
- **Medium** · admin-shell.tsx:74-80 · active row has no `aria-current`, and only matched exact paths, so `/admin/users/:id` highlighted nothing. · HIG accessibility › Vision (convey state with more than colour); lists-and-tables › Best practices ("persistently highlights the selected row").
- **Medium** · admin-shell.tsx:64 · fixed `w-56` sidebar with no small-screen layout: at 360 px the content column is ~130 px. · HIG layout › Adaptability; DESIGN.md › Accessibility floor (360 px).
- **Medium** · admin-shell.tsx:89-97 · "End admin session" is a 12 px underlined text button, well under 32 px tall. · HIG accessibility › Mobility ("Offer sufficiently sized controls").
- **Medium** · admin-shell.tsx:44-58 + step-up/page.tsx:50 · On `/admin/step-up` with no session the shell rendered the full nav (every link bounced back to the gate) and wrapped the page's own `<main>` in a second `<main>`. · judgment (landmarks).
- **Low** · admin-shell.tsx:42 · "Loading…" had no `role="status"`. · HIG loading › Best practices.

### /admin — `app/(admin)/admin/page.tsx`, `components/admin/bar-chart.tsx`

Job: show whether anything is on fire (jobs, dunning) and the latest growth snapshots.

- **High** · page.tsx:111 · ad-hoc `<h1>`; no shirorekha, no PageHeader. · DESIGN.md › Signature.
- **High** · page.tsx:75-76 · job and dunning state initialised to `[]`, so before (or instead of) a response the tiles read a confident **0 failed / 0 past due**. A failed fetch was indistinguishable from a healthy system. · HIG feedback › Best practices; HIG loading › Best practices.
- **High** · bar-chart.tsx:37,68 · raw hex `#a3a3a3` bars and `#737373` labels (4.17:1). · DESIGN.md › Colour ("Never raw hex"); HIG accessibility › Vision.
- **Medium** · bar-chart.tsx:50,69 · labels were SVG `<text>` inside a `preserveAspectRatio="none"` viewBox, so they stretched horizontally with the card width, and values were only in a hover `<title>`. · HIG charts › Enhancing the accessibility of a chart; HIG charts › Best practices.
- **Medium** · page.tsx:113,127 · `grid-cols-3` at every width; tiles and charts squeeze to unreadable at 360 px. · HIG layout › Adaptability.
- **Medium** · page.tsx:116 · stat figures in Inter `text-2xl` — DESIGN.md › Type reserves the display face for large figures and they should read as the page's hierarchy anchors. · HIG typography › Conveying hierarchy.
- **Low** · page.tsx:136 · "last 30d" abbreviation. · HIG charts › accessibility ("avoid potentially ambiguous formats and abbreviations").

### /admin/step-up — `step-up/page.tsx`

Job: exchange an authenticator code for a 30-minute admin session.

- **High** · :56-64 · the code input had only a placeholder ("123456"), no label. · HIG text-fields › Best practices ("include a separate label"); HIG accessibility › Vision.
- **High** · :51 · ad-hoc `<h1>`. · DESIGN.md › Signature.
- **Medium** · :56 · no `autoComplete="one-time-code"`; password managers and OS code autofill cannot offer the code. · HIG text-fields › Best practices.
- **Medium** · :73 · primary action was an off-system `bg-neutral-100 text-neutral-900` block, not `Button variant="primary"`. · HIG buttons › Style.
- **Low** · :65 · error text colour only (`text-red-400`, stock Tailwind, off-token), no icon. · HIG accessibility › Vision.

### /admin/users, /admin/users/[id] — `users/page.tsx`, `users/[id]/page.tsx`

Job: find an account; see its roles, devices and workspaces.

- **High** · users/page.tsx:50 · search input labelled only by placeholder. · HIG search-fields › Best practices; text-fields › Best practices.
- **High** · both :42/:37 · ad-hoc `<h1>`.
- **Medium** · users/page.tsx:64 · table had no empty state ("no users found") and no loading state — an empty result and a slow request looked the same. · HIG writing › Best practices ("Provide clear next steps on any blank screens"); HIG loading.
- **Medium** · users/page.tsx:82 · Admin column showed "yes" or nothing. · HIG lists-and-tables › Content.
- **Medium** · users/[id]:48-55 · memberships were plain text with no link to the workspace, forcing a second search. · HIG layout › Visual hierarchy; judgment.
- **Medium** · users/[id]:32 · no way back to the list besides the sidebar. · judgment.
- **Low** · users/[id]:38 · `grid-cols-2` `dl` collapses badly on narrow screens.

### /admin/workspaces, /admin/workspaces/[id]

Job: find a workspace; see its plan, balance, owner; jump to credits.

- **High** · workspaces/page.tsx:62-71 · results rendered as a bare `<ul>` of underlined names with "(slug, type, currency)" run-on text — not scannable. · HIG lists-and-tables › Best practices ("Prefer displaying text in a list or table"), › Content ("descriptive column headings").
- **High** · both · ad-hoc `<h1>`; search input placeholder-only.
- **Medium** · workspaces/[id]:57 · "Adjust credits" was a raw `<a>` (full page reload) styled as a grey block, not the page's primary action. · HIG buttons › Style.

### /admin/credits

Job: grant credits to a workspace or reverse a job's charge.

- **High** · :104 · submit button said "Submit". · HIG writing › Best practices ("Be action oriented"); DESIGN.md › Writing.
- **High** · :47-60 · mode toggle had no `aria-pressed`/selected semantics; state was colour only (`bg-neutral-100` vs `bg-neutral-800`). · HIG accessibility › Vision.
- **Medium** · :108 · success printed raw JSON in `text-green-400` (off-token). · HIG feedback › Best practices ("confirm that a significant action or task has completed").
- **Medium** · :84 · "Tenths of a credit" with no hint of the conversion. · HIG text-fields › Best practices.

### /admin/billing/refunds

Job: refund a pass or top-up purchase, with an audited reason.

- **High** · :105 · "Refund" button on an off-system white block; no pending state, so a double click could post twice. · HIG buttons › Style; HIG feedback.
- **Medium** · :85 · reason codes shown as `snake_case`. · HIG writing › Best practices.
- **Medium** · :109, :119 · result/error colour-only, off-token (`text-green-400`, `text-red-400`). · HIG accessibility › Vision.
- **Low** · :91 · label "(min 10 characters — mandatory)" repeats `required`. Kept the "Reason (min 10 characters" prefix: `admin.spec.ts` selects the field by it.

### /admin/flags, /admin/styles

Job: turn a feature flag on or off / publish or unpublish a caption style, with a reason.

- **High** · flags:67-72, styles:70-74 · per-row reason inputs had no label at all (styles had not even a placeholder). · HIG text-fields › Best practices; HIG accessibility › Vision.
- **High** · flags:80 · "Toggle" does not say what happens. · HIG writing › "Be action oriented".
- **Medium** · flags:64, styles:66 · state as lowercase "on/off", "yes/no". · HIG lists-and-tables › Content.
- **Medium** · both · no loading or empty state.
- **Low** · both · buttons `px-2 py-1` ≈ 28 px tall. · HIG accessibility › Mobility.

### /admin/jobs

Job: see queue depth and cancel a stuck job.

- **High** · :76 · status filter `<select>` with no label. · HIG accessibility › Vision.
- **Medium** · :100 · status as plain lowercase text; failures not distinguishable at a glance. · HIG lists-and-tables › Content.
- **Medium** · :107 · "Cancel" in a job row is ambiguous for screen-reader users (which job?). · HIG writing › Best practices.
- **Medium** · no loading/empty state for either table.

### /admin/evals

Job: read the nightly eval leaderboard; freeze or release provider routing.

- **High** · :125-132 · trend conveyed **by colour alone** (red/green), and "up" meaning "worse" is unstated. · HIG accessibility › Vision ("Convey information with more than color alone"); HIG color › Inclusive color.
- **High** · :78-83 · reason input placeholder-only. · HIG text-fields.
- **Medium** · :87 · "Freeze" used `bg-red-900` — a destructive style on a protective action. · HIG buttons › Role.
- **Medium** · :120, :128 · `text-neutral-600` on the old bg at 4.31:1. · HIG accessibility › Vision.
- **Medium** · not reachable from the nav (see Shell).

### /admin/routing

Job: record a routing-weight override (not yet read by the worker).

- **High** · :72-96 · four inputs labelled only by placeholder. · HIG text-fields › Best practices.
- **High** · :97 · "Set". · HIG writing.
- **Medium** · :48 · the only warning that overrides have no effect was `text-xs text-neutral-500` referring to "the final report's open questions". · HIG writing › "Consider each screen's purpose".

### /admin/affiliates

Job: see pending affiliate applications; export a financial year's TDS totals.

- **High** · :66 · `<p>` inside `<ul>` (invalid HTML; screen readers announce a list of 0 items plus stray text).
- **High** · :70 · FY input unlabelled.
- **Medium** · :62 · pending list as run-on text "CODE (IN)". · HIG lists-and-tables.

### /admin/referrals, /admin/share-reports

Job: approve or reject held referrals / take down or dismiss reported share links, each with an audited note.

- **High** · referrals:77-82, share-reports:62-67 · per-row note inputs placeholder-only.
- **Medium** · share-reports:68 · "Take down" styled identically to "Dismiss"; the destructive action was not distinguishable. · HIG buttons › Role ("Destructive").
- **Medium** · referrals:93, share-reports:85 · `<p>` inside `<ul>` for the empty state.
- **Low** · share-reports:50 · description leaked an internal WP code (`share-report-resolved`, B13b).

### /admin/support

Job: triage tickets: change status, reply.

- **High** · :100-110 · per-ticket status `<select>` and reply input unlabelled.
- **Medium** · :92 · `[category] subject` bracket formatting; status as raw `in_progress`. · HIG writing.
- **Medium** · :129 · `<p>` inside `<ul>`.

### /admin/partner-catalogue

Job: list partner-asset grants and revoke an active one.

- **Medium** · off-token `neutral-*` colours, 24 px "Revoke" button. · HIG accessibility › Mobility.
- **Medium** · no loading state. (Empty state "No grants." kept verbatim — `page.test.tsx` asserts it.)

### /ui-kit — `ui-kit/page.tsx`, `ui-kit-view.tsx`

Job: show every token and shared component in its states, for screenshot and axe review.

- **Critical** · unreachable without an admin session (see Shell).
- **High** · ui-kit-view.tsx:119 · type specimen said "Bricolage Grotesque display"; the display face is Anek Latin. · DESIGN.md › Type.
- **High** · ui-kit-view.tsx:84-100 · palette showed Nocturne-era names (`lime-500`, `lime-600`) and no accent ramp, neutral ramp, sunken or ink. · DESIGN.md › Colour.
- **High** · no PageHeader / shirorekha demonstration, and the kit's own title was an ad-hoc `<h1>`.
- **Medium** · no type scale; no guidance on when to use primary. · DESIGN.md › Type, › Components.
- **Low** · :144 · icon-only button `aria-label="Sparkles"` names the glyph, not the action. · HIG buttons › Content.
- **Low** · :379 · EmptyState demo used a second `primary` on the same surface as the Button section's. · DESIGN.md › Accent budget.

### /ui-kit/style-gallery, /ui-kit/export-upsell

Jobs: the caption-style editing harness / a standalone mount of the ₹9 export upsell panel.

- **Medium** · style-gallery/page.tsx:21 · `font-display` on an ad-hoc `<h1>`.
- **Medium** · export-upsell-demo.tsx:82 · success message in `text-lime-500` — the accent spent as a status colour. · DESIGN.md › Accent budget ("Signals are never decoration" / accent is not a signal).
- **Low** · export-upsell-demo.tsx:66 · "watermark preview" lower case.

## Changes made

- **New `components/admin/admin-ui.tsx`**: the console's small kit —
  `AdminPage` (one column width and 32 px section gap), `AdminSection` (h2 +
  description + card), `adminCard` (`rounded-md border border-border bg-surface p-5`),
  `AdminError` (`role="alert"`, icon + words), `AdminSuccess` (`role="status"`),
  `AdminLoading`, `AdminEmpty`, `AdminTable` (scrolls inside its own card so
  wide tables never scroll the page), `th/td/tr` row recipes (hover
  `bg-neutral-100/5`, `border-border` dividers), `AdminSelect` (native select
  dressed like `Input`), `StatTile` (display-face figure), `rowLink`.
- **Shell**: `/ui-kit/**` now renders bare (fixes the Critical); nav grouped
  into Overview / People / Money / Content / Platform with **Evals added**;
  active row `bg-accent/14 text-accent-200` + `aria-current="page"`, matching
  detail pages; `bg-bg-0` page, `bg-sunken` rail; stacks above content with a
  horizontally scrolling row under `md`; 32 px rows; "End admin session" is a
  ghost `Button`; the no-session gate is a `PageHeader` + one primary; step-up
  renders without the console. New `admin-shell.test.tsx` covers all three.
- **Every page title is a `<PageHeader>`** with an eyebrow naming its nav group
  and a one-sentence description of what the page does; exactly one per page.
  The dashboard's carries `data-testid="admin-heading"` (what `smoke.spec.ts`
  expects); the style gallery's keeps `data-testid="styles-heading"`.
- **One primary per surface**: Issue refund, Grant credits / Reverse charge,
  Save override, Step up, Export FY totals (CSV), Adjust credits (workspace
  detail), Step up (gate). Every row action is `secondary size="sm"`; "Take
  down" is `danger`. Freeze/Unfreeze swap secondary/ghost by state instead of a
  red fill on a non-destructive action.
- **Every input has a label** (visible `Field` label, or `aria-label` naming the
  row for per-row inputs); search forms have `role="search"` and an sr-only label.
- **Loading / empty / error states** on every list: `null` initial state →
  "Loading…", then an empty headline, and errors in `AdminError`. Dashboard
  tiles show "—" until their request answers, never a fake 0.
- **Status in words, tone second**: flags On/Off, styles Published/Draft, job
  statuses, grant status, eval freeze all use `Badge`; eval trend reads
  "+0.0123 worse" / "better" / "no change".
- **Copy**: buttons say what happens (Turn on/off, Cancel job, Send reply,
  Issue refund, Save override); reason codes and ticket statuses in sentence
  case (API values unchanged); internal WP codes removed from descriptions.
- **Tables**: users and workspaces lists are proper tables; user detail links
  each membership to its workspace; detail pages get an "All users"/"All
  workspaces" back link; IDs and keys in `font-mono`.
- **BarChart**: neutral `fill-neutral-500` bars, labels and values moved to
  HTML under the plot (no more stretched SVG text), sr-only value list, card
  recipe, `h3` title. `barColor` prop kept.
- **Credits** mode toggle is a segmented control with `aria-pressed`.
  **Refunds** gets a pending state ("Refunding…") so a double click cannot post twice.
- **Off-token colours removed**: no `neutral-950/900/800` fills, `red-*`,
  `green-*`, `emerald-*`, raw hex or `lime-*` remain in owned files.
- **UI kit**: PageHeader title; palette regrouped (surfaces incl. sunken/ink,
  text, accent + full 100–900 ramp + on-accent, neutral ramp, signals);
  type section names Anek Latin / Inter / JetBrains Mono with the full
  11–44 px scale and a Devanagari fallback sample; new "PageHeader and the
  shirorekha" section (md with actions, lg), rendered `as="h2"` so the page
  keeps one h1; button usage note; icon button labelled by action; EmptyState
  demo action demoted to secondary. `data-testid="ui-kit"` and `kit-palette` kept.
- **Style gallery / export upsell**: PageHeader titles; upsell success uses
  `text-accepted` + `role="status"`, signed-out uses `role="alert"`.

Verification: `pnpm exec tsc --noEmit` clean; `npx vitest run "app/(admin)"
components/admin` 3 files / 11 tests pass; `pnpm exec eslint "app/(admin)"
components/admin` 0 problems.

## Deferred

- **Primitive `Input`/`Textarea` use `bg-bg-1`, DESIGN.md says `bg-sunken`.**
  Not mine to change (packages/ui); the admin forms follow whatever the
  primitive does.
- **A shared `Select` primitive.** `AdminSelect` is a local stand-in; the
  product has the same need.
- **Row actions still fire without confirmation** (Take down, Revoke, Cancel
  job, flag toggles). HIG feedback › "Warn people when they initiate a task
  that can cause data loss that's unexpected and irreversible" argues for a
  confirm dialog on Take down / Revoke; that is a behaviour change, left for an
  owner decision.
- **Server errors are shown verbatim** (`err.message`) and client-side
  validation messages ("A reason (min 10 characters) is required…") appear in a
  page-level banner, not next to the row's field. Moving them inline needs
  per-row error state; left as is to avoid touching the request flow.
- **Dashboard charts are snapshots, not trends** — a backend gap already
  documented in the page's header comment.
- **Admin screens remain desktop-first**: tables scroll horizontally inside
  their cards at 360 px rather than reflowing into cards.
- **`e2e/smoke.spec.ts` expects `admin-heading` on `/admin` without a
  step-up**, but middleware 404s that path; the testid now exists on the
  dashboard, but the test's premise (a public placeholder) predates the gate.
  e2e is outside this area.

## Reviewer pass (2026-09-25)

Checked the implementer's diff: every `data-testid` survives (12 removed, the
same 12 re-added, plus the new `admin-heading`); no API call, request body or
handler changed. Fixed in review:

- `admin-heading` and `styles-heading` sat on the whole `<header>` (eyebrow and
  description included); they now sit on the title text, as the original `<h1>`
  did and as `studio/styles` already does.
- `/admin/jobs`: a failed `/admin/jobs/stats` request left the Queues section on
  "Loading…" forever; it now shows an error. Job status badges read in sentence
  case ("Failed", not "failed"); the filter still sends the raw value.
- Back links on the user and workspace detail pages are now 32 px tall targets.

Accepted as-is: the UI kit shows several `primary` buttons and two demo
`PageHeader`s (as `h2`, inside cards) because it is a specimen sheet whose job
is to show every variant; its own title is the single `h1`. `AdminSelect` uses
`bg-bg-1` to match the shared `Input`, pending the Input/spec alignment request.
