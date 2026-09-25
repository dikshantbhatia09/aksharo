# Map and audit: Repurpose flow and Studio

Area owner: repurpose/studio designer. Spec: `docs/redesign/DESIGN.md` (Shirorekha).
HIG sources: `~/.claude/skills/apple-design/references/hig/*.md`, cited as `file › heading`.
This is a web app, so only the principles and foundations apply. iOS/macOS-only rules such as Dynamic Type sizes and push-button bezels are out of scope.

Line numbers in findings refer to the files **before** this pass (commit `HEAD` at the time of the audit).

## Measured contrast (WCAG 2.x, from token hexes)

| Pair | Ratio | Verdict |
|---|---|---|
| `text-white` on `bg-accent` (old download link) | **3.38:1** | fails 4.5:1 at 12 px |
| `text-on-accent` (ink) on `bg-accent` | 5.51:1 | pass |
| `text-accent` on `bg-surface` | 4.98:1 | pass (barely) |
| `text-accent` on `bg-bg-2` | 4.39:1 | fails, so use `accent-300` (6.55:1) |
| `text-accent` (`emerald` alias) on `accent/20` tint over surface (old "Viral Score" chip) | **3.84:1** | fails at 11 px |
| `text-neutral-500` (`#a39a93`) on surface / bg-0 / bg-2 | 6.09 / 6.73 / 5.37 | pass |
| `text-neutral-600` (`#7c746e`) on surface | 3.67:1 | fails; this is a disabled-only value |
| `text-accent-200` on `accent/14` over bg-0 (current step) | 11.0:1 | pass |
| `text-rejected` on surface / bg-0 | 6.18 / 6.84 | pass |
| `text-accepted` on `bg-bg-2` (done-step check) | 7.80:1 | pass |
| `text-fg-2` on `bg-sunken` | 7.05:1 | pass |
| `border-border` vs surface (non-text) | 1.33:1 | a hairline, not a control boundary; the controls that rely on it also have text labels |

---

## 1. `/repurpose` — the pipeline's front page

- **Job:** start a new clips run from a link, or get back into an existing run.
- **Renders:** `app/(app)/repurpose/page.tsx` → `repurpose-index-view.tsx` (`RepurposeIndexView`), using `EmptyState`, `Skeleton` and `Button` from `@montaj/ui`, `REPURPOSE_FLOW_FLAG` from `components/home/pipeline-banner`, and `formatRelative` from `components/projects/project-table`.
- **Reached from:** the rail/sidebar "Clips pipeline" entry and the Home pipeline banner. It links out to `/repurpose/new` (with `?url=`) and to `/repurpose/[runId]`.

| Sev | Finding | Where | Source |
|---|---|---|---|
| High | Page title was an ad-hoc `<h1 class="font-display text-[23px]">`, with no `PageHeader` and no shirorekha | `repurpose-index-view.tsx:63-72` | DESIGN.md › Signature; layout.md › Visual hierarchy |
| High | The live-run banner was an accent flood: `border-accent bg-accent/9`, an accent dot, and accent link text. That is a second rani block competing with the one primary ("Read the video") | `:103-117` | DESIGN.md › Accent budget; buttons.md › Style ("one or two prominent per view") |
| High | The flag-off state rendered a bare `EmptyState` with no page title, so the page had no `h1` | `:43-50` | accessibility.md › Vision (VoiceOver: describe the interface); layout.md › Visual hierarchy |
| Medium | `font-display` on the section heading "Your runs" | `:120` | DESIGN.md › Type |
| Medium | Raw pixel sizes (`text-[12.5px]`, `[11.5px]`, `[13px]`, `size-[13px]`) sat off the 11/12/14 scale | `:66,:113,:136-141` | DESIGN.md › Type; typography.md › Conveying hierarchy |
| Medium | Live and idle runs were told apart by dot colour alone (accent vs neutral) | `:126-132` | accessibility.md › Vision ("more than color alone") |
| Medium | The runs query had no error state. A failed fetch looked like an empty list | `:121-128` | loading.md › Showing progress; writing.md › Best practices (clear errors) |
| Medium | The link input used `bg-bg-0` instead of the spec's `bg-sunken`, and a 13 px icon | `:84-95` | DESIGN.md › Components (Inputs, Icons 16 px) |
| Low | "Upload a file" did not say it was the alternative to the link | `:99` | writing.md › Be action oriented |
| Low | Row hit targets were about 36 px because of `py-2.5`. They are acceptable, but uneven | `:128` | buttons.md › Best practices |

## 2. `/repurpose/new` — start a run

- **Job:** collect the source (a link or a file), rights, the spoken language, the caption language, the script, the style and how clips are chosen, then create the run and navigate to it.
- **Renders:** `new/page.tsx` → `new/repurpose-new-view.tsx` → `components/repurpose/SourceStartForm.tsx`, with `LanguagePicker`, `WritingScriptPicker` and `SYSTEM_STYLES` (read-only, other owners), plus `useUploadQueue`.
- **Reached from:** `/repurpose` (the form and "Upload a file instead"), the Home pipeline banner (`?url=`), the run error card ("Choose another video") and the run-missing page.

| Sev | Finding | Where | Source |
|---|---|---|---|
| Critical | The page's key action "Start finding clips" used the default (`secondary`) variant, so the screen had **no** primary action | `SourceStartForm.tsx:461` | buttons.md › Style; DESIGN.md › Components |
| High | Title was `<h1 class="text-lg">`: no PageHeader, no shirorekha, and a body-sized page title | `repurpose-new-view.tsx:128` | DESIGN.md › Signature; typography.md › Conveying hierarchy |
| High | A nested `<main>` inside the shell's `<main id="main">` created a duplicate landmark | `repurpose-new-view.tsx:127` | accessibility.md › Vision (VoiceOver) |
| High | Selected tab and selected style used accent-tinted fills (`border-lime-500/45 bg-lime-500/12`) | `SourceStartForm.tsx:191,368` | DESIGN.md › Accent budget (a selected card uses `ring-1 ring-accent`; tabs use an underline) |
| High | The tablist had no arrow-key support, no `aria-controls`, no roving `tabIndex`, and panels were not labelled by their tab | `:177-201,252` | accessibility.md › Mobility (keyboard); focus-and-selection.md |
| Medium | Checkbox and radio hit targets were the native 13 px box with a text-only label row, under 32 px | `:227-237,400-416` | buttons.md › Best practices (hit region); DESIGN.md › Accessibility floor |
| Medium | "Advanced settings" was a 12 px underlined text button, about 16 px tall, with no disclosure glyph | `:422-433` | layout.md › Visual hierarchy (progressive disclosure); buttons.md › Best practices |
| Medium | Setup panel on `bg-bg-1` with `p-4`. Selects and inputs on `bg-bg-2`/`bg-bg-1` blended into the card | `:278,316` | DESIGN.md › Components (Cards p-5, Inputs bg-sunken) |
| Medium | Two ungrouped blocks (source, setup) had no headings, so the hierarchy came only from spacing | `:175-278` | layout.md › Visual hierarchy ("Group related items") |
| Medium | Copy used "we" ("How should we choose the clips?", "We could not start this just now") | `:390`, `repurpose-new-view.tsx:119` | writing.md › Best practices ("Avoid using *we*") |
| Low | The file input was unstyled native chrome | `:258-267` | judgment |
| Low | "How many suggestions?" gave no range and no reason when disabled | `:436-448` | writing.md › Show hints in text fields |

## 3. `/repurpose/[runId]` — the resumable run workspace

- **Job:** show where one run is, open a stage, act on candidate moments (create or download 9:16 clips), stop or retry the run.
- **Renders:** `[runId]/page.tsx` → `[runId]/repurpose-run-view.tsx`, using `RunStageRail`, `StagePanel`/`StageErrorCard` (`StagePanel.tsx`), `RunActionBar`/`PersistentPreview` (`RunActionBar.tsx`) and `copy.ts`.
- **Reached from:** `/repurpose` rows and the live card, a `/repurpose/new` submit, the Home banner, and bookmarks.

| Sev | Finding | Where | Source |
|---|---|---|---|
| Critical | The download link used `text-white` on `bg-accent`: **3.38:1** at 12 px. It also used a raw `white` and hand-rolled button chrome | `repurpose-run-view.tsx:234` | accessibility.md › Vision (4.5:1); DESIGN.md › Colour |
| Critical | Every candidate row rendered its own `variant="primary"` "Create 9:16 Clip", plus the filled download link, so N rani buttons appeared on one surface | `:245-260,229-238` | buttons.md › Style ("one or two per view"); DESIGN.md › Components |
| High | A fabricated score: `cand.potentialScore ?? cand.score ?? 80` showed "Viral Score: 80%" for a candidate with no score. It was also a raw `emerald-*` chip at 3.84:1 | `:202-204` | writing.md › Best practices (clarity); accessibility.md › Vision; judgment (honesty) |
| High | The page title repeated the marketing pitch "One long video, nine posts" on every run instead of naming the run. No PageHeader | `:119-124` | layout.md › Visual hierarchy; writing.md › Consider each screen's purpose |
| High | Raw palette throughout the candidate card: `neutral-800/900/70`, `bg-black`, `amber-400`, `neutral-100/400` | `:196,216,220,240,266` | DESIGN.md › Colour ("Never raw hex or white/NN") |
| High | The error/missing state used `font-display` h1 and an accent text link, with no PageHeader | `:87-100` | DESIGN.md › Type, Signature |
| Medium | Title case in the UI ("Viral Score", "Create 9:16 Clip", "Download 9:16 Clip", "Highlight Moment") | `:203,237,217,259` | writing.md › Adopt capitalization rules; DESIGN.md › Writing |
| Medium | Candidates were `<div>`s, not a list. The per-row buttons had identical accessible names ("Create 9:16 Clip" × N) | `:184-279` | accessibility.md › Vision (VoiceOver); lists-and-tables.md |
| Medium | "Discovered 5 highlight moments" had no singular form, and its instruction said "Pick a moment" while the actual control is a button | `:180-181` | writing.md › Be action oriented |
| Medium | The loading skeleton was not announced | `:74-77` | loading.md › Showing progress |
| Medium | The `<video>` had no accessible name | `:267-273` | accessibility.md › Vision |
| Low | The pulsing "Cutting…" text had no icon and no status role | `:240` | progress-indicators.md › Best practices |
| Low | The error title "We could not find that video project" uses "we". It is pinned by `repurpose-run-view.test.tsx:116` | `:88` | writing.md › Best practices |

### Components used by the run view

**`components/repurpose/RunStageRail.tsx`**

| Sev | Finding | Where | Source |
|---|---|---|---|
| High | Accent on every *completed* step (`bg-accent-800 text-accent-100` dot) plus an accent border on hover. The accent should mark only the current step | `:88,92` (orig. `:235,244`) | DESIGN.md › Accent budget |
| Medium | 11.5 px labels and an 11 px glyph were off the type scale. The pill was about 34 px tall without a declared minimum | `:89-90` | DESIGN.md › Type; buttons.md › Best practices |
| Low | The waiting step used `bg-neutral-900`, a ramp value rather than a surface token | `:248` | DESIGN.md › Colour |

**`components/repurpose/StagePanel.tsx`**

| Sev | Finding | Where | Source |
|---|---|---|---|
| High | Accent step number (`text-accent`), a `font-display` h2 and a card with no border | `:45-55` | DESIGN.md › Accent budget, Type, Components (Cards) |
| Medium | The error card's "Try again" was the default secondary even though it is the recommended action. When retry was unavailable there was no primary at all | `:151-165` | buttons.md › Role ("Assign the primary role to the button people are most likely to choose") |
| Medium | The error and done states used bare "!" and "✓" glyphs | `:144,96` | icons.md; accessibility.md › Vision |

**`components/repurpose/RunActionBar.tsx`**

| Sev | Finding | Where | Source |
|---|---|---|---|
| High | `PersistentPreview` used a radial gradient of `accent-900` → ink, which the spec explicitly bans | `:23` | DESIGN.md › Accent budget ("No … gradients") |
| Medium | 9.5 px eyebrow (below the 11 px minimum), a duplicated "Source" label, and a duplicated "Nothing is posted…" line that the action bar already says | `:20,60-63` | DESIGN.md › Type; accessibility.md › Vision (minimum sizes) |
| Low | An empty `<p>` rendered when there was no note | `:73` | judgment |

## 4. Review share links — `components/review/ShareLinksPanel.tsx`

- **Job:** create, list, copy and revoke review links for a project.
- **Renders:** mounted by `components/editor/ShareDialog.tsx` (not owned here) inside the editor's Share dialog.
- **Reached from:** the editor's Share action and the project kebab menu's Share entry.

| Sev | Finding | Where | Source |
|---|---|---|---|
| High | The error text used raw `text-red-400` and had no `role="alert"` | `:118` | DESIGN.md › Colour; writing.md › Write clear error messages |
| High | The "Live" status used the `accent` badge tone, so brand colour was spent as a status signal | `:38` | DESIGN.md › Accent budget ("Signals are never decoration" and the reverse) |
| Medium | The 🔒 emoji was the only password indicator. It had a `title` but no accessible text | `:139-143` | accessibility.md › Vision; DESIGN.md › Components (Icons: lucide) |
| Medium | Inputs were `py-1` (about 26 px, under 32 px), on `bg-bg-0`, and the three form fields were not grouped | `:84-113` | buttons.md › Best practices; DESIGN.md › Inputs |
| Medium | Each list row showed the raw enum (`view` / `comment` / `approve`) | `:137` | writing.md › Build language patterns |
| Medium | "Create link" was not primary, so the dialog had no primary action | `:115` | buttons.md › Style |
| Low | `<p>` directly inside `<ul>` (invalid). "+" in labels ("View + comment") | `:180,23-25` | judgment; DESIGN.md › Writing |

## 5. `/studio` and `/studio/styles`

- **`/studio`:** `studio/page.tsx`. Its only job is to redirect old bookmarks to `/projects`. It has no UI, so there is nothing to audit.
- **`/studio/styles`:** `studio/styles/page.tsx` → `styles-view.tsx`.
  - **Job:** browse the caption-style catalogue, previewed by the real renderer, in a chosen script.
  - **Renders:** `StylePreviewCanvas` and `SYSTEM_STYLES`/`SYSTEM_STYLE_MAP` (read-only).
  - **Reached from:** the rail's Styles entry and the command palette.

| Sev | Finding | Where | Source |
|---|---|---|---|
| High | The title was an ad-hoc `font-display` h1, with no PageHeader | `styles-view.tsx:100-105` | DESIGN.md › Signature |
| High | The filter and script pills used an accent flood when selected (`border-accent bg-accent/14 text-accent-200`) and an accent border on *hover*. Every tile also got an accent ring on hover | `:45-51,165-167` | DESIGN.md › Accent budget (selection = ring; hover = neutral tint) |
| Medium | Pills were about 26 px tall (`py-[5px] text-[11.5px]`), under the 32 px floor | `:46` | buttons.md › Best practices; DESIGN.md › Accessibility floor |
| Medium | 9.5 px uppercase meta ("Preview script", category) and 10.5 px placeholder text were below the 11 px minimum | `:113,184,200` | accessibility.md › Vision (minimum sizes); DESIGN.md › Type |
| Medium | Category labels were raw lowercase keys styled with `capitalize` (title-casing multi-word keys). The count read "1 styles" | `:146,152` | writing.md › Adopt capitalization rules |
| Medium | "Preview not bundled" is developer jargon | `:184` | writing.md › Best practices |
| Low | The tile border used `shadow-[0_0_0_1px_var(--color-neutral-900)]` instead of `border-border` | `:164` | DESIGN.md › Components (Cards) |
| Low | The script control was labelled only by `aria-label`, and its visible label was a separate span | `:112-116` | accessibility.md › Vision |

---

## Changes made

All changes are in the owned files. Every `data-testid`, route, API call, prop contract and data flow is unchanged.

- **PageHeader on every page, exactly once:**
  - `/repurpose` (including the flag-off state), with eyebrow "Clips pipeline".
  - `/repurpose/new`.
  - `/repurpose/[runId]`. Its title is now the run's source (`sourceDisplay`), not the repeated pitch, and `run.message` is the description (it keeps `data-testid="run-status"`).
  - The run-missing and error state.
  - `/studio/styles`. The script switcher moved into the header's `actions`, and `styles-heading` is kept on the title text.
- **One primary per surface:**
  - `/repurpose`: "Read the video".
  - `/repurpose/new`: "Start finding clips", which is now actually `primary`.
  - The run view has no primary in normal state. Per-candidate "Create 9:16 clip" and "Download clip" are demoted to `secondary`, and the download link is now a real `Button asChild` with ink-safe colours, which fixes the 3.38:1 failure.
  - The error card's recommended action is primary: retry when it is possible, otherwise "Choose another video".
  - Share dialog: "Create link".
- **Accent floods removed:**
  - The live-run banner is now a plain card with an "In progress" label.
  - Done steps in the rail are neutral with an `accepted` check. Only the current step keeps `bg-accent/14 text-accent-200`, the active-row recipe.
  - The accent step number is gone, and so is the gradient preview (now `bg-ink`).
  - Selected tab and style: underline tab and `ring-1 ring-accent` respectively.
  - Style pills are segmented controls with the ring on selection and a neutral hover. Tiles hover neutral.
  - The "Live" share badge uses `accepted`.
- **`font-display`** removed from every section heading, stage heading and error h1. It remains only through PageHeader.
- **Tokens:**
  - All `neutral-800/900`, `bg-black`, `emerald-*`, `amber-*`, `red-400`, `text-white` and raw px sizes are replaced with `fg-*`, `bg-sunken`, `bg-ink`, `border-border`, `text-rejected` and the 11/12/14/16/18 scale.
  - Inputs and selects are `bg-sunken` at `h-9`.
  - Cards are `rounded-md border border-border bg-surface p-5`.
- **Accessibility:**
  - Real tablist semantics with arrow/Home/End keys, roving `tabIndex`, `aria-controls` and `aria-labelledby`.
  - Checkbox and radio rows are at least 32 px. "Advanced settings" is a 32 px ghost button with a disclosure chevron.
  - Rail pills are at least 32 px.
  - Candidates are a `<ul>` of `<li>`. Per-row buttons carry unique `aria-label`s ("Create 9:16 clip: {title}", keeping the visible text inside the name per WCAG 2.5.3), and the `<video>` has a name.
  - The loading skeleton is `role="status"` with a label, and "Cutting…" is `role="status"` with a spinner icon.
  - Live runs say "In progress" in words, not only by dot colour.
  - The nested `<main>` is removed.
  - The share-panel emoji is replaced with a lucide lock icon plus the word "Password", and the error has `role="alert"`.
  - The styles count is `aria-live`.
- **Copy:**
  - Sentence case throughout.
  - No fabricated "80%" score: a candidate with no score shows no badge, and a score that exists reads "Potential N%" in a neutral badge.
  - Singular and plural are handled ("1 moment found", "1 style").
  - "How should the clips be chosen?", "Suggest the strongest moments for me", "Number of suggested moments" (with a range hint).
  - Scope labels in words. "No preview for this style yet".
  - Error sentences say what to do and drop "we" where no test pins them.
- **Structure:**
  - `/repurpose` has a "Start a new run" section and a "Your runs" section, and a runs error state.
  - `/repurpose/new` is split into "Your video" (source tabs) and "Captions and clips" (the setup card).
  - The share form groups the password and view limit on one row.
  - The action bar sits on a hairline at the foot of the stage card.
- **Tests:** `repurpose.test.tsx` now asserts the legend's new wording ("How should the clips be chosen?"). It still protects the fieldset being a named group.

## Deferred

- The error titles "We could not find that video project" and the `SAFE_ERROR_COPY` entries ("We could not get that video", and others) still say "we" (writing.md › Best practices). They are pinned by `repurpose-run-view.test.tsx:104,116` and `repurpose.test.tsx:174` and belong to a product copy decision in `copy.ts`. Changing them should be one pass across copy and tests.
- `STAGE_COPY.styles_formats.title` "Style formats" is ambiguous. Renaming a stage title is a product decision, and the tests match titles in the rail's accessible names.
- The candidate time range still assumes clips shorter than an hour (`m:ss`).
- Upload-tab drag-and-drop is not offered. That would be a feature, not a restyle.
- `ShareLinksPanel`'s revoke has no confirmation. That is a behaviour change, so it is left alone.
- The rail's glyphs (✓ ● ! ○) are text characters, not lucide icons. The `stage-icon-*` testids wrap them, and they are `aria-hidden`, with the state spoken as a word.

## Reviewer pass

- Checked every `data-testid` in the diff. Each removed line has a matching added line, so none were dropped or renamed.
- Reverted one behaviour change. The `/repurpose` link input had gained `type="url"`, and because it sits in a submitted `<form>`, native validation would have blocked a link without a scheme (for example `youtu.be/…`) before `start()` passed it to `/repurpose/new`, which does the real check. `inputMode="url"` stays, so mobile keyboards still get the URL layout.
- Primary count per surface verified: `/repurpose` has one ("Read the video"), `/repurpose/new` has one ("Start finding clips"), the run view has none in the normal state and one on the error card, and the share dialog has one ("Create link"). There is one `PageHeader` per page, and no `font-display`, raw palette or `outline-none` is left in the owned files.
