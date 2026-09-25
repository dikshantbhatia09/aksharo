# Map: Home, projects, onboarding, updates

Area owner: designer 1 of 8 (Shirorekha rebuild, 2026-09-25). Spec: `docs/redesign/DESIGN.md`.
HIG references are cited as `file › heading` from `~/.claude/skills/apple-design/references/hig/`.
Line numbers in the audit are for the files **before** this pass.

Contrast figures were calculated with the WCAG formula from the token hexes in `tokens.css`
(alpha tints are composited over the surface they sit on):

| Pair | Ratio |
|---|---|
| `accent` #f0508a text on `surface` #1f1c23 | 4.98 |
| `accent` text on `bg-2` #2a262f | **4.39 (fails 4.5)** |
| `accent` label on an `accent` fill (Prepare media button) | **1.00** |
| `accent-300` on `bg-2` | 6.55 |
| `accent-200` on `accent/14` over surface | 9.88 |
| `fg-2` / `neutral-500` #a39a93 on surface / bg-2 / sunken | 6.09 / 5.37 / 7.05 |
| `fg-1` on surface | 10.9 |
| `on-accent` on `accent` (primary button) | 5.51 |
| `accepted` / `info` / `proposed` / `rejected` on surface | 8.85 / 6.95 / 8.60 / 6.18 |
| `border` #36313a vs surface (non-text) | 1.33 |
| `neutral-600` #7c746e vs surface (non-text) | 3.67 |

---

## Routes and surfaces

### `/` (served from `app/(app)/home`) — Home, "Studio"

- **Job:** start a new captioned project from a file, and get back to recent work.
- **Renders:** `home/page.tsx` → `home-view.tsx` → `PipelineBanner`, `QuickPickRow` (`LanguagePicker`,
  `StyleQuickPick`, aspect menu), `DropZone`, `BatchApplyToAllSheet`, `BatchProgressView`,
  `PrepareMediaModal` (+ `ProcessingScreen`), `UploadTray`, `WorkingNowCard`, `ThisMonthCard`,
  `ProjectGrid`/`ProjectCard`/`ProjectKebabMenu`, `LocalProjectsSection` (desktop shell only).
- **Reached from:** `middleware.ts` rewrites a signed-in `/` here; the rail's Studio item; the top
  bar's "New project" and the command palette (`/?new=1` focuses the drop card); the end of
  onboarding ("Open the studio").

### `/projects` — Projects

- **Job:** find, filter and manage every project in the workspace.
- **Renders:** `projects/page.tsx` → `projects-view.tsx` → `ProjectToolbar`, `FolderSidebar`,
  `ProjectTable` (default) or `ProjectGrid`, `BulkActionBar`, `ProjectDetailSheet`, `ProjectKebabMenu`.
- **Reached from:** the rail's Projects item; Home's "All projects"; the command palette.

### `/onboarding` — Set up your account

- **Job:** ask three short questions (what you make, languages you speak, how you found us) and turn
  the answers into Home's defaults.
- **Renders:** `onboarding/page.tsx` → `onboarding-flow.tsx` (`ChoiceGrid`, `Field`, `SampleProjectButton`).
- **Reached from:** the post-sign-up redirect; it is skippable and exits to `/`.

### `/updates` — Changelog

- **Job:** list what shipped, newest first.
- **Renders:** `updates/page.tsx` → `components/academy/changelog-list.tsx` (**not owned by this area**).
- **Reached from:** the What's-new modal's "See full changelog", `lib/nav.ts` secondary nav.

### Shared components this area owns that render elsewhere

`LanguagePicker`, `ProcessingScreen`/`DidYouKnow`/`IndeterminateBar` (also the editor's waiting
screen, `needs-transcription.tsx`), `StreakChip` (sidebar) and `StreakWidget` (subscription page).

---

## Audit

### Critical

1. **A competitor's name, in a user-visible claim.** `components/projects/processing-tips.tsx:27`
   rotated "Kalakar is the most accurate captioning tool for South Asian languages." through every
   upload and waiting screen. Kalakar is the product being studied, not this one (CLAUDE.md §4c).
   — HIG writing.md › Best practices ("Build language patterns"; the voice must be the app's own), judgment.
2. **The Prepare media primary button had an invisible label.** `prepare-media-modal.tsx:237`
   layered `text-accent` over the primary's `bg-accent`: 1.00:1 at rest. It is the button that
   starts a paid transcription. — accessibility.md › Vision ("Strive to meet color contrast minimum standards").
3. **Two switches that did nothing.** `prepare-media-modal.tsx:206,225` — "Audio Enhancement" and
   "Emojis" toggled local state that never reached `onGenerate` or any request. A person could turn
   on a paid-sounding option and get nothing. — writing.md › Best practices ("Keep settings labels
   clear"), judgment (the codebase's own F07-E1 rule: UI never promises what the pipeline does not do).

### High

4. **No page title on `/projects`.** `projects-view.tsx:138` opened straight on the toolbar; there
   was no `h1` at all, so a screen-reader user landing here had no heading to orient by, and the
   Shirorekha page contract (one `PageHeader`) was unmet. — layout.md › Visual hierarchy ("Order
   content by relative importance"), accessibility.md › Vision (VoiceOver).
5. **Home's title was not a page title.** `home-view.tsx:218-227` put the `h1` inside the New project
   card in `font-display` at 26 px under an accent 10 px eyebrow; no shirorekha, and the accent
   spent on a label. — typography.md › Conveying hierarchy; DESIGN.md › Signature.
6. **Up to three filled primaries on Home.** `pipeline-banner.tsx:133` ("Start a run"),
   `this-month-card.tsx:82` ("Top up") and the empty grid's "Try with a sample" could all render at
   once. — buttons.md › Style ("Keep the number of prominent buttons to one or two per view").
7. **Accent floods on Home.** `pipeline-banner.tsx:86` an accent ring round the whole card, `:94` an
   accent eyebrow, `:164` accent stage numbers; `working-now-card.tsx:63-64` accent dot and accent
   count in the heading; `drop-zone.tsx:199,202,220` accent dashed frame, accent icon and an
   accent-tinted badge; `processing-tips.tsx:67,126` accent "Did you know?" and an accent-tinted
   icon disc. — color.md › Best practices ("Avoid using the same color to mean different things");
   DESIGN.md › Accent budget.
8. **Text below the 11 px floor.** 9 px stage numbers (`pipeline-banner.tsx:163`), 9.5 px chip
   kickers (`quick-pick-row.tsx:96`, `style-quick-pick.tsx:52`, `language-picker.tsx:175`,
   `folder-sidebar.tsx:49`), 10 px headings/labels (`this-month-card.tsx:41`, `working-now-card.tsx:60`,
   `project-card.tsx:139`, `folder-sidebar.tsx:129`), 10.5 px status (`project-card.tsx:156`).
   — typography.md › Ensuring legibility (minimum sizes), accessibility.md › Vision.
9. **Hit targets under 32 px.** Kebab trigger 28 px (`project-kebab-menu.tsx:111`), folder rename 22 px
   (`folder-sidebar.tsx:134`), stage pills ~24 px (`pipeline-banner.tsx:149`), view toggle ~24 px
   (`projects-view.tsx:134`), onboarding chips ~26 px (`onboarding-flow.tsx:444`), quick-pick chips
   ~30 px. — accessibility.md › Mobility ("Offer sufficiently sized controls"), buttons.md › Best practices.
10. **A control invisible while keyboard-focused.** The folder rename button was `opacity-0` until
    `group-hover` (`folder-sidebar.tsx:134`); tabbing onto it focused nothing visible.
    — accessibility.md › Mobility (Full Keyboard Access), DESIGN.md › Accessibility floor (visible focus).
11. **Status dots spent the accent on list rows.** `project-status.ts:39-46` drew Ready in the accent
    and Working/Queued in accent-400/700 — the accent in every row of the table. — DESIGN.md › Accent
    budget ("No … accent icons in lists"); color.md › Inclusive color (the word beside each dot stays).
12. **Selection shown by colour alone in onboarding.** Icon rows (`onboarding-flow.tsx:485`) changed
    only border/tint colour when chosen; no check. — accessibility.md › Vision ("Convey information
    with more than color alone"), color.md › Inclusive color.
13. **Accent-tinted selected states and accent headings** in the onboarding step dots
    (`onboarding-flow.tsx:240-243`), chips and rows (`:447,:470`), the language/script chips
    (`language-picker.tsx:166`, `writing-script-picker.tsx:110`), the applied filter
    (`project-toolbar.tsx:89`), and an accent hover ring on every project card (`project-card.tsx:101`).
    — DESIGN.md › Components ("Selected: ring-1 ring-accent"; "No accent fill").

### Medium

14. **Prepare media modal copy and layering.** Title case ("Prepare Your Media", "Generate
    Transcription →", "Audio Enhancement", "Creator Plan", "✦ AI-Powered") against the product's
    sentence case; a big accent "play" disc that looked like a play button but did nothing, and a
    blurred chip on content (`prepare-media-modal.tsx:123-140`). — writing.md › Best practices
    ("Adopt capitalization rules … consistently"); DESIGN.md (blur only on floating chrome).
15. **Table empty state was a dead end.** `project-table.tsx:179` passed no action on a cold start,
    while the grid offered "Try with a sample". — writing.md › Best practices ("Provide clear next
    steps on any blank screens").
16. **Blank table headers.** Thumbnail and kebab columns had empty `<th>`s (`project-table.tsx:192`).
    — lists-and-tables.md › Content ("Use descriptive column headings").
17. **Raw palette colour.** `text-red-400` for the batch error (`BatchApplyToAllSheet.tsx:130`), raw
    `rounded-[4px]/[6px]/[10px]` radii throughout. — DESIGN.md › Colour (tokens only).
18. **Destructive dialog built from bare buttons,** with "moves to Archive-then-delete" copy that does
    not say what happens (`project-kebab-menu.tsx:203-222`). — writing.md › Best practices ("Be action
    oriented"), buttons.md › Role.
19. **Batch confirm had no prominent style** (default secondary) though it is the step's one action
    (`BatchApplyToAllSheet.tsx:118`). — buttons.md › Style.
20. **`font-display` off-spec:** pipeline heading (`pipeline-banner.tsx:99`), library heading
    (`home-view.tsx:320`), onboarding card heading (`onboarding-flow.tsx:253`). — DESIGN.md › Type.
21. **Streak level badge in accent tint** (`streak-widget.tsx:38`); batch in-progress badges in accent
    (`BatchProgressView.tsx:25`). — DESIGN.md › Accent budget.
22. **Upload copy promised speed** ("great captions take seconds", "hang tight!").
    — writing.md › Best practices (clear, not cute); progress-indicators.md › Best practices ("Be accurate").

### Low

23. `/updates` uses `ChangelogList`'s own ad-hoc `h1` (`components/academy/changelog-list.tsx:15`),
    so it has no shirorekha. Owned by another area (see shared requests).
24. Streak copy "streak paused — one export restores it" starts lower-case; pinned verbatim by
    `streak-chip.test.tsx`/`streak-widget.test.tsx` as the 08 §4 copy. — writing.md › capitalization.
25. `ProjectCard` is a link that contains the kebab button and, in select mode, a checkbox
    (nested interactive content). Works with a mouse and the kebab stops propagation, but an axe
    run would flag it. — accessibility.md › Vision (VoiceOver), judgment.
26. Language group heading "Desi & Regional" is title case; pinned by `language-picker.test.tsx`.

### What already worked

- The drop zone is a real `<button>` with a sibling file input (no nested interactive), Enter/Space
  reachable. Language never defaults (FIX-04). Status always carries a word beside the dot. Upload
  rows have Pause/Resume/Cancel. Onboarding steps are `role=checkbox/radio` with `aria-checked`,
  are skippable, and save a draft locally. — progress-indicators.md › "let people halt processing";
  onboarding.md › Best practices ("brief", "consider making it optional").

---

## Changes made

**Page structure**
- Home: one `PageHeader size="lg"` ("Captions that match how you talk", the name in the eyebrow when
  known, the pitch as description). The New project card now comes first (every account can use it;
  the pipeline is cohort-only) with the upload tray and batch progress directly under it, then the
  pipeline banner, then Working now / Credits this month, then the library. Section gap 32 px.
- `/projects`: added `PageHeader` "Projects" with a one-line description; the toolbar sits under it.
- `/onboarding`: the step question is now the page's `PageHeader` (one shirorekha, `aria-live` so a
  step change is announced); the answers sit in a standard card below it.

**Accent budget**
- Home has at most one filled primary: "Start a run" → secondary, "Top up" → secondary (renamed
  "Top up credits"), "Usage" → ghost "See usage". The empty-state "Try with a sample" and the batch
  "Create N projects" are the contextual primaries; while the batch sheet is open the empty
  library's sample button drops to an outline so the two never render filled together (review pass).
- Prepare media's "Upload and transcribe" is the dialog's own primary (a dialog is its own surface).
- Removed: the pipeline card's accent ring and accent eyebrow/numbers; working-now's accent dot and
  count; the drop zone's accent frame/icon/badge (the frame turns rani only while a file is over it);
  the accent "Did you know?" and icon disc; the accent play disc and blurred chip in Prepare media;
  accent status dots (now `accepted`/`info`/`proposed`/`rejected`/neutral); the accent hover ring on
  cards (now a neutral border step; selected is `ring-1 ring-accent`); accent-tinted language/script
  chips and filter chips (answered = plain, unanswered = dashed neutral outline; applied filter =
  raised `bg-2` with "Status: Archived" in words); accent-tinted onboarding dots/chips/rows
  (selected = accent ring + a check); accent streak and batch badges.
- Kept (in budget): meters (credits, working-now rows, pipeline progress, indeterminate bar), the
  active pipeline stage's outline, the selected folder's active-nav tint (`bg-accent/14
  text-accent-200`, 9.9:1, now with `aria-current`).
- Links in running text use `text-accent-300` underlined (duplicate "Open the original", "Upgrade
  your plan").

**Type, size, targets**
- Every sub-11 px label raised to `text-2xs`/`text-xs`; `font-display` now only on page titles
  (via `PageHeader`) and the credits figure.
- Kebab and folder-rename triggers are 32 × 32; the rename button also shows on `focus-visible`.
  Stage pills, view toggle, chips, quick picks, folder rows and onboarding chips are ≥ 32 px;
  onboarding rows ≥ 44 px.
- Table: `<th>`s for the thumbnail and actions columns get screen-reader names; row hover is
  `neutral-100/5`; the title link has a taller hit area and underlines on hover instead of turning
  accent. Card surfaces are `rounded-md border border-border bg-surface p-5` throughout.

**Copy and honesty**
- Replaced the Kalakar tip with a `BRAND.name` line; dropped "great captions take seconds".
- Prepare media: sentence case throughout, "Upload and transcribe" as the action (it is what happens),
  the file shown as a plain row. Audio enhancement and Emojis are now visibly disabled and say "Not
  available yet" (test ids kept).
- Delete confirm: `Button ghost` Cancel + `Button danger` "Delete project", with copy that says what
  happens to the project and its files.
- Batch sheet: "Create N projects with the same settings" + what that means; the error names a way
  out and uses `text-rejected` with `role="alert"`.
- `/projects` table empty state now offers "Try with a sample" on a cold start, like the grid.

**Files changed:** `app/(app)/home/home-view.tsx`, `app/(app)/home/local-projects-section.tsx`,
`app/(app)/projects/projects-view.tsx`, `app/(app)/onboarding/onboarding-flow.tsx`,
`components/home/{pipeline-banner,this-month-card,working-now-card}.tsx`,
`components/projects/{drop-zone,folder-sidebar,language-picker,prepare-media-modal,processing-tips,project-card,project-kebab-menu,project-status,project-table,project-toolbar,quick-pick-row,style-quick-pick,upload-tray,writing-script-picker}.tsx|ts`,
`components/batch/{BatchApplyToAllSheet,BatchProgressView}.tsx`, `components/streak/streak-widget.tsx`.
No `data-testid` removed or renamed; no API call, prop contract or business logic changed. The
pipeline headline stays "One long video, nine posts" because `components/repurpose/repurpose.test.tsx`
(another area) pins it.

**Verification:** `pnpm exec tsc --noEmit` clean; `npx vitest run` over every owned directory plus
`components/repurpose`, `needs-transcription` and `RetranscribeDialog` (consumers of owned
components) — all pass; `packages/ui` vitest 119/119; `eslint` on all owned directories: 0 errors,
0 warnings.

## Deferred

- **`/updates` title** (Low 23): needs `components/academy/changelog-list.tsx` to render
  `PageHeader` — requested from its owner rather than duplicating the list here.
- **Nested interactive `ProjectCard`** (Low 25): moving the kebab and checkbox out of the `<Link>`
  means an overlay-link card structure and touching the card's tests; worth its own change.
- **Streak copy capitalisation** (Low 24) and **"Desi & Regional"** (Low 26): both strings are pinned
  verbatim by tests as spec copy; changing them is a copy decision, not a restyle.
- **Pipeline headline "nine posts"** overstates a five-stage pipeline that never promises nine
  outputs; pinned by another area's test (`repurpose.test.tsx`).
- **"Creator plan" lock on Translation** in Prepare media: whether translation really is a Creator
  entitlement was not verified against the plan table; wording kept.
- **Home `/?new=1` focus target**: focuses the card (`tabIndex=-1`) rather than the drop button,
  so a keyboard user still has one Tab to reach the picker. Kept to avoid changing that behaviour.
