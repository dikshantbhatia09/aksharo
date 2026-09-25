# Map — app shell, global chrome and the shared UI package

Area owner: the shell/UI designer. Spec: `docs/redesign/DESIGN.md` (it wins).
HIG pages are cited as `file › heading` from `~/.claude/skills/apple-design/references/hig/`.
File:line references in the audit point at the **pre-redesign** code (commit `0d5e1df0`).

Contrast figures are measured (WCAG 2.x relative luminance) from the token hexes in
`packages/ui/src/styles/tokens.css`; alpha tints are composited over the ground they sit on.

| Pair | Ratio |
|---|---|
| fg-2 `#a39a93` on sunken `#0e0c10` / bg-0 / surface / bg-2 | 7.05 / 6.73 / 6.09 / 5.37 |
| fg-disabled `#7c746e` on sunken | 4.25 (disabled, exempt) |
| accent `#f0508a` on surface / on bg-2 | 4.98 / **4.39** |
| accent on its own 10 % tint over surface (old JobProgress active chip) | **4.44** |
| accent-300 `#f78bb0` on bg-2 / on accent/10 over surface | 6.55 / 6.62 |
| accent-200 on accent/14 over sunken (active nav row) | 11.65 |
| accent-100 on accent-800 (old avatar) | 10.53 |
| ink on accent fill (primary) | 5.51 |
| rejected `#ef7d4f` on bg-2 / on rejected/10 over surface | 5.45 / 5.31 |
| accepted / proposed / info on their 10 % tints over surface | 7.28 / 7.09 / 5.85 |
| border `#36313a` vs sunken / bg-0 (non-text) | 1.54 / 1.47 |

---

## 1. Surfaces

### 1.1 App shell frame — every signed-in route except `/p/*`
- **Job:** hold the nav, the top bar and the page, and keep the session and realtime channel alive.
- **Renders:** `app/(app)/layout.tsx` → `components/shell/app-shell.tsx` → `NavRail` or `Sidebar` (by `useNavModel`), `TopBar`, `<main id="main">`, `CommandPalette`, `ReferralPromptSheet`, `WhatsNewModal`.
- **Reached:** after sign-in (middleware + bootstrap refresh), from any link into `(app)`. The editor (`/p/[id]`) gets only `<main>` and draws its own chrome.
- **States:** no loading skeleton for the shell itself (it renders immediately and waits for `bootstrapped` for realtime); an expired session redirects to `/login?reason=expired`.

| # | Sev | Finding | Where | Cite |
|---|---|---|---|---|
| S1 | Medium | Page gutter was 18 px / 22 px top / 34 px tail — off the 4 px grid and not DESIGN's 16 px mobile / 24 px desktop. | app-shell.tsx:322-326 | layout.md › Visual hierarchy (align to scan); DESIGN "Shape, space" |
| S2 | Low | `<main tabIndex=-1 focus:outline-none>` — acceptable: it is a programmatic skip-link target, never a tab stop. | app-shell.tsx:294,325 | accessibility.md › Mobility (keyboard) |
| S3 | Low | Skip link is present, first in order, styled in `globals.css` so it works before JS. Good. | app-shell.tsx:289 | accessibility.md › Mobility |

### 1.2 Navigation rail (68 px, default width)
- **Job:** one-click access to the eight primary destinations, with the credit balance and account at the foot.
- **Renders:** `nav-rail.tsx`, `brand-mark.tsx`, `use-nav-targets.ts` (resolves Editor → newest project, gates Clips pipeline by flag), `StreakChip`, `ProfileMenu compact`, Radix `Tooltip`.
- **Reached:** always visible at `lg+` when the width switch says "Rail"; below `lg` the same items live in the mobile sheet.

| # | Sev | Finding | Where | Cite |
|---|---|---|---|---|
| R1 | High | Captions were `text-[9px]` — below the HIG's 10 pt desktop minimum and DESIGN's 11 px meta floor, on the product's primary navigation. | nav-rail.tsx:70,90 | typography.md › Ensuring legibility; accessibility.md › Vision (minimum sizes) |
| R2 | High | Active row spent the accent three ways (16 % fill + accent-200 text + a 45 % accent inset ring). DESIGN budgets one tint + text. | nav-rail.tsx:56 | color.md › Best practices ("avoid using the same color to mean different things"); DESIGN accent budget |
| R3 | High | Credits bolt icon was `text-accent` — an accent icon in the nav reads as a second active item. | nav-rail.tsx:118 | sidebars.md › Best practices ("icon colors … serve a clear purpose"); DESIGN "no accent icons in lists" |
| R4 | Medium | Disabled items (Editor with no project, Clips pipeline when gated) were non-focusable `<span>`s, so a keyboard user could never reach the tooltip that explains *why*. `aria-disabled` on a role-less span also announces nothing. | nav-rail.tsx:64-68 | accessibility.md › Vision (describe interface for VoiceOver); menus.md › Labels ("show people when an item is unavailable") |
| R5 | Medium | Credits link had no padding: hit target ≈ 15 × 30 px, under the 32 px pointer floor. | nav-rail.tsx:110-113 | accessibility.md › Mobility (control size) |
| R6 | Medium | Icons 19 px (DESIGN: 20 px in nav, stroke 1.75). | nav-rail.tsx:69,89 | judgment / DESIGN "Icons" |
| R7 | Low | Rail edge hairline used `neutral-900` (≈ invisible, 1.2:1) rather than the border token. | nav-rail.tsx:38 | layout.md › Visual hierarchy (group with separators) |
| R8 | Low | Caption "Files" names the page "Projects" — two words for one place. (Owned by `lib/nav.ts`; see shared requests.) | lib/nav.ts:89 | writing.md › Best practices ("build language patterns") |

### 1.3 Sidebar (232 px) and mobile navigation sheet
- **Job:** the same destinations with labels, plus the secondary routes, workspace, credits, storage and account.
- **Renders:** `sidebar.tsx` (`NavRow`, `useStorageUsage`, `UpgradeButton`), `workspace-switcher.tsx`, `credits-card.tsx`, `StreakChip`, desktop-download link (flag + production origin), `ProfileMenu`. The mobile sheet is `top-bar.tsx` → `Sheet` → `Sidebar`.
- **Reached:** width switch "Sidebar" at `lg+`; the hamburger (`open-nav`) below `lg`.

| # | Sev | Finding | Where | Cite |
|---|---|---|---|---|
| D1 | High | Workspace switcher was a 10 px uppercase line (≈ 14 px tall hit target) — the one control that changes whose data you see was the smallest thing in the chrome. | sidebar.tsx:228; workspace-switcher.tsx:97-105 | accessibility.md › Mobility; typography.md › Ensuring legibility |
| D2 | High | Wordmark set in `font-display`; DESIGN reserves Anek for page titles and large figures. | sidebar.tsx:224 | typography.md › Conveying hierarchy ("minimize the number of typefaces"); DESIGN "Type" |
| D3 | Medium | "More" group label 9.5 px and not programmatically tied to its `<nav>`. | sidebar.tsx:247-250 | typography.md › Ensuring legibility; sidebars.md › Best practices (group titles) |
| D4 | Medium | Row text 13 px ad-hoc size; project-count badge 10 px; storage line 11 px ad-hoc. Off the type scale. | sidebar.tsx:132,171,271 | DESIGN "Type" scale |
| D5 | Medium | Disabled rows not focusable (same as R4). | sidebar.tsx:143-147 | as R4 |
| D6 | Medium | Single-workspace state drew a bordered box around plain text — looks like a control that does nothing. | workspace-switcher.tsx:84-89 | buttons.md › Best practices (buttons must be recognisable — and non-buttons must not look like them) |
| D7 | Low | Sidebar could not scroll; with "More" open on a short laptop the foot (credits, profile) was clipped. | sidebar.tsx:203 | layout.md › Adaptability |

### 1.4 Top bar
- **Job:** say where you are and hold global actions: width switch, search, New project, What's new, Upgrade.
- **Renders:** `top-bar.tsx`, `screen-title.ts`, `UpgradeButton` (from `sidebar.tsx`), `ShortcutHint`.

| # | Sev | Finding | Where | Cite |
|---|---|---|---|---|
| T1 | High | Header repeated each page's title as a 15 px `font-display` tagline ("Every style, every word tunable"). With `PageHeader` on every page that makes two display-face titles per screen, and the tagline is a slogan, not a location. | top-bar.tsx:82-87; screen-title.ts:25-49 | toolbars.md › Titles ("if titling … seems redundant, leave it empty"; "concise … under 15 characters"); DESIGN "font-display only on page titles" |
| T2 | High | Header crumbs disagreed with the nav: "Library" for Projects, "Caption styles" for Styles, "Aksharo studio" (the app name) for Studio. | screen-title.ts:23-48 | writing.md › Build language patterns; toolbars.md › Titles ("don't title windows with your app name") |
| T3 | High | `UpgradeButton` was `variant="primary"` in global chrome, so any page with its own primary had two rani fills. | sidebar.tsx:350 | toolbars.md › Actions ("only specify one primary action"); buttons.md › Style ("one or two per view"); DESIGN accent budget |
| T4 | Medium | Width switch segments ≈ 22 px tall at 11.5 px; the active segment used the accent (a second "you are here"); a 9.5 px "Nav" label stood in for a group name. | top-bar.tsx:50-55,96-125 | accessibility.md › Mobility; segmented-controls (judgment) |
| T5 | Medium | Search disappeared entirely below `md` — no way to open the palette on a phone except the keyboard shortcut. | top-bar.tsx:131 | searching.md › Best practices (make search easy to find); layout.md › Adaptability |
| T6 | Medium | Search field hover turned the border accent; field was 30 px tall at 12.5 px. | top-bar.tsx:131 | DESIGN accent budget; accessibility.md › Mobility |
| T7 | Low | "New project" is icon-only below `sm` and relied on hidden text for its name. | top-bar.tsx:139-142 | accessibility.md › Vision (label every control) |

### 1.5 Profile menu (rail, sidebar, editor top bar)
- **Job:** who am I signed in as; switch workspace; profile/privacy/devices; language; sign out.
- **Renders:** `profile-menu.tsx` on Radix `DropdownMenu`. Also mounted by `components/editor/EditorTopBar.tsx` (`editor` variant, styled by `editor.css`).

| # | Sev | Finding | Where | Cite |
|---|---|---|---|---|
| P1 | Medium | Menu header was the raw role ("owner") styled as an uppercase group label; it never named the person. | profile-menu.tsx:145 | menus.md › Labels; writing.md › Consider each screen's purpose |
| P2 | Medium | Rail avatar trigger 28 × 28 px. | profile-menu.tsx:120 | accessibility.md › Mobility |
| P3 | Medium | Avatar was an accent-800 disc on every screen — accent spent on identity, not state. | profile-menu.tsx:129 | DESIGN accent budget |
| P4 | Low | "Devices & sessions" used the Settings gear. | profile-menu.tsx:194 | menus.md › Icons ("represent common actions consistently") |
| P5 | Low | Roles shown lowercase ("editor") next to proper-noun workspace names. | profile-menu.tsx:173 | writing.md › capitalization |

### 1.6 Credits card (sidebar foot)
- **Job:** remaining credits against the monthly grant, as minutes, and when it refills.
- **Renders:** `credits-card.tsx` (reads `useWorkspaceCredits`, `useEntitlement`).

| # | Sev | Finding | Where | Cite |
|---|---|---|---|---|
| C1 | High | "CREDITS" kicker in `text-accent` — an accent heading, explicitly forbidden. | credits-card.tsx:52 | DESIGN accent budget; color.md › Best practices |
| C2 | Medium | Balance 11 px, caption 11 px, kicker 10 px; bar 3 px — the key number was the smallest text in the card. | credits-card.tsx:52-80 | typography.md › Conveying hierarchy |
| C3 | Low | Card had no border (every other card has the hairline). | credits-card.tsx:49 | DESIGN "Cards" |

### 1.7 Command palette (Ctrl/⌘ K)
- **Job:** jump to any project, route or action from the keyboard.
- **Renders:** `command-palette.tsx` on `@montaj/ui` `CommandDialog` (cmdk inside Radix Dialog).

| # | Sev | Finding | Where | Cite |
|---|---|---|---|---|
| K1 | Low | Recent projects used a Sparkles icon — reads as "AI", not "a video project". | command-palette.tsx:136 | menus.md › Icons |
| K2 | Low | Selected row painted `bg-bg-2` (a raised well) rather than the hover tint; DESIGN allows glass on the palette and it had none. | command.tsx:130, :47 | DESIGN "Depth"; judgment |
| K3 | Low | Empty copy "Nothing matches that." is fine; made it name what was searched. | command-palette.tsx:124 | writing.md › Provide clear next steps |

### 1.8 App error boundary `(app)/error.tsx` and root `global-error.tsx`
- **Job:** keep a failure local, show the real message, offer the likeliest fix.

| # | Sev | Finding | Where | Cite |
|---|---|---|---|---|
| E1 | Medium | `(app)/error.tsx` hand-rolled two buttons at ≈ 30 px, neither the design system's `Button`; no primary; heading was an `h2` on a screen that had lost its `h1`. | (app)/error.tsx:37-60 | buttons.md › Role (assign the primary role); accessibility.md › Mobility |
| E2 | Medium | `global-error.tsx` still carried pre-Nocturne greys (`#0b0b0c`, `#a1a1aa`, `rgba(255,255,255,…)`) — the one screen that cannot read tokens drifted furthest. | global-error.tsx:37-76 | DESIGN "Never raw hex" (tokens written out is the only option here) |
| E3 | Low | Copy "This screen hit a problem" → says what happened, no reassurance that work is saved. | (app)/error.tsx:37-40 | writing.md › Write clear error messages |

### 1.9 Root layout, providers, globals.css
- `app/layout.tsx`: fonts, runtime config, `Providers`. `components/providers.tsx`: query/API/session/locale/tooltip/toaster. `app/globals.css`: Tailwind + tokens import, the three native editor controls, skip link.

| # | Sev | Finding | Where | Cite |
|---|---|---|---|---|
| G1 | Medium | `themeColor` was Nocturne's `#161826`; browser chrome no longer matched the page. | layout.tsx:41 | color.md › Best practices |
| G2 | Low | `.panel-swatch` inner radius 7 px inside a 6 px control (not concentric); range thumb used a raw `rgb(0 0 0 / .4)` shadow. | globals.css:51,85,90 | toolbars.md › Best practices (concentric radii); DESIGN "Depth" |
| G3 | Low | `providers.tsx` has no visual surface; nothing to change. | — | — |

### 1.10 `@montaj/ui` primitives and shared components

| # | Sev | Finding | Where | Cite |
|---|---|---|---|---|
| U1 | Critical | `text-fg-3` is not a token: Kbd, ContextMenuShortcut, context-menu submenu chevron and MenubarShortcut rendered with **no colour class at all** (inheriting whatever the row had). | kbd.tsx:25; context-menu.tsx:149,169; menubar.tsx:209 | accessibility.md › Vision (contrast must be designed, not inherited) |
| U2 | High | Dialog and Sheet close buttons were a bare 16 px icon — a 16 × 16 hit target on every modal in the product. | dialog.tsx:47; sheet.tsx:50 | accessibility.md › Mobility; toolbars.md › Navigation (standard Close) |
| U3 | High | Menu radio/checkbox indicators were accent on `bg-bg-2` (4.39:1, and DESIGN forbids accent on bg-2). | dropdown-menu.tsx:60; context-menu.tsx:96; menubar.tsx:125 | accessibility.md › Vision; DESIGN colour table |
| U4 | High | JobProgress active stage chip: accent 11 px text on its own 10 % tint = 4.44:1, under AA. | job-progress.tsx:72 | accessibility.md › Vision (4.5:1 up to 17 pt) |
| U5 | High | Destructive menu rows used Tailwind's stock `text-red-400` (#f87171), not the rejected signal — a red that sits next to the pink accent. | context-menu.tsx:60; menubar.tsx:93 | color.md › Inclusive color; DESIGN "rejected is pushed toward orange so it never reads as the pink accent" |
| U6 | Medium | Menu row highlight used `bg-bg-1` — *darker* than the `bg-bg-2` menu it sits in, so hover read as a hole. | dropdown-menu.tsx:36 (+ copies) | DESIGN "Hover tints … neutral-100/7" |
| U7 | Medium | `white/10`, `white/5` in Kbd and Menubar. | kbd.tsx:25; menubar.tsx:33,51 | DESIGN "Never white/NN" |
| U8 | Medium | Kbd and MenubarShortcut at 10 px. | kbd.tsx:25; menubar.tsx:209 | typography.md › Ensuring legibility |
| U9 | Medium | Switch (20 px) and Checkbox (16 px) hit areas under the pointer floor. | toggles.tsx:25,50 | toggles.md › Best practices; accessibility.md › Mobility |
| U10 | Medium | Inputs on `bg-bg-1` (DESIGN: `bg-sunken`); Textarea had no hover or disabled state. | input.tsx:21,40 | text-fields (judgment); DESIGN "Inputs" |
| U11 | Medium | Dialog radius `rounded-md` (DESIGN: 16 px for dialogs and sheets); panel shadow instead of the `lg` elevation. | dialog.tsx:38; sheet.tsx:22 | DESIGN "Shape"; sheets.md › Anatomy |
| U12 | Medium | Toast action button was a rani fill — a second primary on whatever page it floats over. | toast.tsx:24 | buttons.md › Style; DESIGN accent budget |
| U13 | Medium | CreditMeter "Top up" was an 11 px accent label, ≈ 16 px hit target. | credit-meter.tsx:164-170 | accessibility.md › Mobility; buttons.md › Content |
| U14 | Medium | JobProgress Retry was an unstyled underline, ≈ 18 px target. | job-progress.tsx:97 | accessibility.md › Mobility |
| U15 | Medium | EmptyState and UpgradeGate used dashed borders (drop-zone look) where DESIGN says a card is a solid hairline on `bg-surface`; EmptyState's action had no separation from its sentence. | empty-state.tsx:27; upgrade-gate.tsx:56 | writing.md › Provide clear next steps; DESIGN "Empty states", "Cards" |
| U16 | Low | Tabs used the historical `lime-500` name for the indicator and had no disabled state. | tabs.tsx:32 | DESIGN "Tabs" |
| U17 | Low | Chips `ShortcutHint` at a one-off 4 px radius. | chips.tsx:30 | DESIGN "Radii" |
| U18 | Low | Menubar trigger 26 px tall inside a 32 px bar — at the HIG macOS default (28) but under DESIGN's 32. Enlarging it changes the editor top bar's height. | menubar.tsx:33,50 | accessibility.md › Mobility |
| U20 | Medium | UpgradeGate's CTA was `variant="primary"`; `/plugins` renders two gates, so the page carried two filled primaries. | upgrade-gate.tsx:72; plugins-view.tsx:122,147 | buttons.md › Style; DESIGN accent budget |
| U19 | Low | Badge `accent` tone is an accent-tinted pill. Legal (accent-300 on a 10 % tint = 6.6:1) but it spends the budget; callers should prefer `neutral`. | surface.tsx:26 | DESIGN accent budget |

---

## Changes made

Shell (`apps/web/components/shell/**`):
- **Brand mark** — glyph now `text-fg-0` on a surface tile with a 3 px rani bar across the top: the shirorekha, on one of the three places DESIGN allows it. Was an accent-outlined accent glyph.
- **Nav rail** — captions 9 px → 11 px (`text-2xs`); icons 20 px, stroke 1.75; active row is exactly `bg-accent/14 text-accent-200` (ring removed); inactive `text-fg-2` with `neutral-100/7` hover; disabled items are focusable `role="link" aria-disabled` with an accessible name that says "unavailable", so the explaining tooltip is keyboard-reachable; credits bolt neutral, credits link a 56 px-wide, 32 px+ tall target; edge hairline on `--color-border`. (R1–R7)
- **Sidebar** — lockup is one home link (mark + Inter 600 wordmark) with the workspace switcher as its own full-width control underneath; rows `text-sm`, `min-h-9`, neutral icons, `neutral-100/7` hover; "More" heading 11 px and wired with `aria-labelledby` (`useId`, since two sidebars can be mounted); badges/storage on the type scale; sidebar scrolls. (D1–D7)
- **Workspace switcher** — compact trigger 12 px, 32 px tall, sentence case; single-workspace state is a plain line, not a box; roles capitalised. (D1, D6)
- **Credits card** — neutral "Credits" label, balance `text-xs text-fg-0 tabular-nums`, 4 px meter (the only accent), hairline card border. (C1–C3)
- **Top bar** — location is one Inter `text-sm` line in the nav's own words ("Settings / Profile" for sub-pages), never the display face; width switch is a labelled `role="group"` with 32 px segments and a neutral selection; search field 32 px on `bg-sunken`, neutral hover; a new icon-only search button below `md` (`data-testid="open-palette-compact"`); New project has an accessible name at every width; gutter `lg:px-6`. (T1, T2, T4–T7)
- **Upgrade CTA** — `variant="secondary"` in both the shell and the editor top bar. (T3)
- **screen-title.ts** — rewritten: `title` is now optional and only used for sub-pages; crumbs match `PRIMARY_NAV` labels; billing and plugin sub-pages added, plus `/templates` (reviewer fix: it fell back to "Studio"). New `screen-title.test.ts` pins the crumb = nav label rule.
- **Profile menu** — header shows the person's name and their role; rail trigger 32 px; neutral avatar; Devices icon is `MonitorSmartphone`; roles capitalised. (P1–P5)
- **Command palette** — projects use the `Film` icon, titles truncate, empty copy names what was searched. (K1, K3)
- **App shell** — page gutter 16 px / 24 px at `lg`, 24 px top, 40 px tail. (S1)

App (`apps/web/app/**` owned files):
- `layout.tsx` — `themeColor` `#141217`. (G1)
- `(app)/error.tsx` — a single card: `h1` "This screen stopped working", reassurance that work is saved, the message in a mono well, `Button variant="primary"` Try again (`app-error-retry` kept) + secondary "Back to projects". No shirorekha (an error is not a destination). (E1, E3)
- `global-error.tsx` — Shirorekha values written out as a `TOKENS` constant (the file cannot read CSS), card layout, 36 px rani "Try again". (E2)
- `globals.css` — swatch inner radius concentric with `--radius-sm`; range thumb uses `--shadow-sm`. (G2)

`@montaj/ui`:
- **Kbd / shortcuts** — `text-fg-2` on `bg-bg-2` with the border token, 11 px. (U1, U7, U8)
- **Menus (dropdown, context, menubar)** — highlight `neutral-100/7`; check indicators `text-fg-0`; destructive rows `text-rejected` (tests updated from `text-red-400` to `text-rejected`, still asserting the destructive styling); submenu open state tinted; menubar border/hover tokens. (U1, U3, U5, U6, U7)
- **Dialog / Sheet** — `bg-surface`, dialogs `rounded-lg`, `--shadow-lg`; close button a 32 × 32 target with hover tint; dialog title reserves room for it (`pr-8`). (U2, U11)
- **Input / Textarea** — `bg-sunken`, `border-border-hover` on hover, Textarea gains hover/disabled. (U10)
- **Tabs** — `border-accent` indicator, 36 px min height, colour transition, disabled state. (U16)
- **Toast** — action button is an outlined secondary; close button tokenised; toasts get `--shadow-md`. (U12)
- **Switch / Checkbox** — invisible `::after` extends the hit area to ≥ 32 px without changing layout; checkbox sits on `bg-sunken`; checked state uses `accent` by name. (U9)
- **Card / ProgressBar** — `bg-surface`; bar fill `bg-accent`. (naming only; same colours)
- **Command** — palette gets the DESIGN-sanctioned glass (`bg-bg-1/95 backdrop-blur-md`), selected row `neutral-100/7`, row icons `text-fg-2`. (K2)
- **JobProgress** — active stage is a neutral raised chip with the spinner (the progress bar below carries the accent); Retry is a 32 px control. (U4, U14)
- **CreditMeter** — "Top up" is `Button variant="link" size="sm"` (accent-300, 32 px); balance `tabular-nums`. (U13)
- **EmptyState** — solid hairline card on `bg-surface`, headline `font-semibold`, action spaced below the sentence. **UpgradeGate** — solid hairline card. (U15)
- **Chips** — `ShortcutHint` on `rounded-sm`. (U17)
- **UpgradeGate CTA** (reviewer fix) — `variant="secondary"`, not primary. `/plugins` renders two `BillingUpgradeGate`s on one page, so a primary gate put two rani fills on one surface (U20; buttons.md › Style, DESIGN accent budget).

No `data-testid` removed or renamed; one added (`open-palette-compact`, `profile-menu-identity`). No API calls, props contracts or business logic changed. `ScreenTitle.title` became optional; its only consumer is `top-bar.tsx`.

Verification (from the worktree): `apps/web` `pnpm exec tsc --noEmit` clean; `npx vitest run components/shell` 4 files / 63 tests pass, plus the new `screen-title.test.ts` (3); `packages/ui` `pnpm exec vitest run` 8 files / 119 tests pass; `eslint` on every changed file in both packages: 0 problems.

## Deferred

- **U18 Menubar trigger height** (Low) — raising it to 32 px grows the editor's top bar; belongs with the editor owner's layout pass.
- **U19 Badge accent tone** (Low) — kept; it is legal. Call sites should move to `neutral` where the badge is not a selection.
- **Header blur** — the sticky top bar keeps `bg-bg-0/95 backdrop-blur`; DESIGN allows blur on floating chrome, and removing it is a judgment call, not a defect.
- **Rail caption "Files" vs "Projects"**, **"Refer & Earn" title case** — both live in `lib/nav.ts` (not owned); see shared requests.
- **Editor avatar and editor upgrade sizing** — `components/editor/editor.css` `.editor-profile > span:first-child` still paints the avatar accent-800 (via `--color-editor-avatar`), and `.editor-upgrade` was sized for a filled button; now that `UpgradeButton` is secondary it may want its padding revisited. Editor owner.
- **Light appearance / increased-contrast** — DESIGN records dark-only as deliberate (color.md › Best practices asks for both). Not reopened here.
