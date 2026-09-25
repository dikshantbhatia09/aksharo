# Caption editor — map and audit (Shirorekha pass, 2026-09-25)

Owner: editor designer. Files: `apps/web/components/editor/**`,
`apps/web/app/(app)/p/**`, `apps/web/app/(app)/export-harness/**`.
Spec: `docs/redesign/DESIGN.md`. HIG references are the local copies in
`~/.claude/skills/apple-design/references/hig/`, cited as `file › heading`.
This is a web app, so only the HIG's foundations and component principles are
applied; iOS/macOS-only conventions are not.

Contrast figures below are WCAG relative-luminance ratios computed from the
token hexes in `packages/ui/src/styles/tokens.css`.

---

## 1. Routes and surfaces

### `/p/[id]` — the caption editor

**Job:** turn one project's transcript into styled, timed captions and export
them as video or subtitle files.

**Who reaches it, from where:** a signed-in member of the workspace, from a
project card or row on `/projects` and Home, from the upload flow once
transcription starts, from the projects "⋯" menu's Export (`?export=1` opens the
export dialog on arrival), and from the command palette. `AppShell` drops the
dashboard sidebar on this route; the editor draws its own top bar.

**Renders:** `app/(app)/p/[id]/page.tsx` (server wrapper, reads
`AUDIO_DEEP_CLEAN_ENABLED`) → `editor-client.tsx` `EditorClient`, which picks
one of four states:

| State | Component | testid |
|---|---|---|
| Loading the document | inline in `EditorClient` | `editor-loading` |
| No editing document yet | `needs-transcription.tsx` `NeedsTranscription` (+ `ImportSubtitles`, `LanguagePicker`, `ProcessingScreen`) | `editor-needs-transcription` |
| Load failed | inline in `EditorClient` | `editor-error` |
| Ready | `EditorReady` (below) | `editor-root` |
| Render crash | `error.tsx` (route error boundary) | `editor-error-boundary` |

`EditorReady` layout, top to bottom, left to right:

1. **Top bar** — `EditorTopBar` (back link, project title with inline rename,
   `UpgradeButton`, `ProfileMenu` from the shell).
2. **Status strips** — offline notice, too-stale reload banner, `ReflowBanner`.
3. **Workspace** (`workspace/resizable.tsx`, three resizable columns):
   - **Left column**, split vertically:
     - `EditorRail` (Captions / Custom fonts / Library tabs) hosting the
       transcript column: `CaptionsPanelHeader` (title, find and replace,
       Caption tools popover holding `EditorMenubar`, `ScriptTabs`, Hide
       fillers, `BulkActionsBar`) over `TranscriptList` → `SegmentCard` →
       `WordChip` / `SpeakerChip`; `CustomFontsPanel`; `LibraryPanel`.
     - `Timeline` (canvas lanes: ruler, words/lines, segments, filmstrip,
       waveform, pass lanes; toolbar with search, granularity, zoom, split,
       merge, snapping, linked selection, Caption tools menu) with a right-click
       `ContextMenu`.
   - **Centre column** — the player: `CaptionStage` (CanvasKit caption render
     over the proxy video, drag box, safe area), `CropWindowOverlay`,
     `PlayerToolbar` (safe zones, resolution pill), `PlayerBottomBar`
     (scrubber, play, mute, clock, fullscreen).
   - **Right column** — the inspector: `RightPanel` (Captions/Edit mode switch,
     Style, Text, Emphasis, Animation, Audio, Insights, Passes tabs,
     `StylePicker`, `controls.tsx` rows, `AudioPanel`, `InsightsTab`,
     `PassesTab` → `ProposalCard`, `PromptedEditBox`, `PluginActivationCue`),
     footer = `ExportButton`.
4. **Dialogs** — `ExportDialog` (Video / Subtitles / To editor tabs,
   `WatermarkNotice`, `ExportUpsellPanel`, `ExportHistory`, `LocalModeNotice`),
   `RetranscribeDialog`, `FindReplaceDialog`, `ConflictDialog`, `ShareDialog`,
   `ShortcutsDialog`, `RegenerateTranslationDialog`, `ReplaceMediaButton`'s
   dialog, the resegment dialog in `BulkActionsBar`, `EditorCommandPalette`,
   `FirstRunCoachMarks`.

### `/export-harness` — export engine test harness

**Job:** expose the editor store, renderer and export engine on
`window.__exportHarness` so Playwright can drive a real browser export.

**Renders:** `app/(app)/export-harness/page.tsx` only (`Harness`,
`HarnessRoot`). Not linked from any navigation; reached only by
`e2e/export.spec.ts` and `e2e/export-fallback.spec.ts` with
`?projectId=`. It has no user-facing design and is deliberately left as bare
text; see finding H-1.

---

## 2. Audit

Severity: **Critical** = misleads the user or blocks a task; **High** = fails
the accessibility floor or the design system's core rules on a primary surface;
**Medium** = inconsistency or a secondary-surface failure; **Low** = polish.
Line numbers are from the pre-change files (commit `0d5e1df0`).

### Critical

| # | Finding | Where | Reference |
|---|---|---|---|
| C-1 | The Audio tab showed a hard-coded "Remaining Credits — 3 credits available" card and a "Real-time Processing" feature checklist. Neither read any data, so every workspace was told it had 3 credits, whatever its real balance. | `components/editor/audio/AudioPanel.tsx:272-307` | writing.md › Best practices ("be accurate"); judgment |

### High

| # | Finding | Where | Reference |
|---|---|---|---|
| H-2 | The timeline canvas was still painted in Nocturne: `ACCENT = "#9184d9"` (blurple), indigo selection edges `#7c8ff0`, green waveform bed `#214a3c`/`#6dc99e`, zinc ruler `#212126`. Nothing on the timeline matched the new system. | `timeline/Timeline.tsx:113-114, 674-1067` | DESIGN.md › Colour; color.md › Best practices |
| H-3 | The playing word's label on the timeline was white on the accent, **3.4:1** at 10.5 px. | `timeline/Timeline.tsx:858` | accessibility.md › Vision (4.5:1 below 18 pt) |
| H-4 | The word under the playhead in the transcript was accent text on a 20 % accent tint over the panel, **3.8:1** at 15 px. | `transcript/WordChip.tsx:123-124` | accessibility.md › Vision |
| H-5 | Filler words used `text-fg-disabled` (`#7c746e`), **3.7:1** on `bg-1`. They are content, not disabled controls. | `transcript/WordChip.tsx:127` | accessibility.md › Vision; DESIGN.md › Colour ("disabled only") |
| H-6 | No filled primary on the screen at all: Export was `variant="secondary"` repainted to a mint fill by `editor.css`, while the Audio tab's "Clean audio", the Style tab's "Save as template", the rail's "Add font", the back-to-projects tile and the too-stale "Reload" all wore the accent. Six accent blocks competed and the real key action was not a primary button. | `export/ExportButton.tsx:64`; `editor.css:419-430`; `audio/AudioPanel.tsx:198-203`; `panels/StylePicker.tsx:279`; `rail/CustomFontsPanel.tsx:213`; `EditorTopBar.tsx:65`; `editor-client.tsx:960` | DESIGN.md › Components (primary once per surface); buttons.md › Best practices; layout.md › Visual hierarchy |
| H-7 | No page title and no `h1`: the project title was a plain button in a 42 px bar, so the page had no heading for assistive tech and no shirorekha. | `EditorTopBar.tsx:94-103` | DESIGN.md › Signature; typography.md › Conveying hierarchy |
| H-8 | Player controls were shrunk by `editor.css` to **18 × 26 px** (the component asks for 32 × 32). | `editor.css:157-161` | accessibility.md › Mobility (control size); DESIGN.md › Accessibility floor |
| H-9 | Load-failed state was a single red sentence with no heading and no way forward; the error boundary used `white/10` and `black/30` literals and an undefined `text-fg-3`. | `editor-client.tsx:298-304`; `app/(app)/p/[id]/error.tsx:40-48` | writing.md › Best practices (say what to do next); DESIGN.md › Colour |
| H-10 | `needs-transcription.tsx` (the screen every fresh project lands on) had only `h2`s, a centred block, and a default-variant (outline) start button. | `app/(app)/p/[id]/needs-transcription.tsx:218-426` | DESIGN.md › Components (`PageHeader`); layout.md › Visual hierarchy |

### Medium

| # | Finding | Where | Reference |
|---|---|---|---|
| M-1 | `text-fg-3` is not a token; 23 uses across the export dialog, insights, script tabs and local-mode gate silently inherited `fg-0`, flattening the hierarchy those lines were meant to show. | e.g. `export/ExportDialog.tsx:253`, `insights/ChaptersPanel.tsx:32`, `export/VideoTab.tsx:103` | DESIGN.md › Colour; typography.md › Conveying hierarchy |
| M-2 | Export dialog outcomes used stock Tailwind colours (`text-red-400`, `text-emerald-400`, `bg-amber-400/10 text-amber-200`) and neither error nor success was announced to assistive tech. | `export/ExportDialog.tsx:327-363` | DESIGN.md › Colour; accessibility.md › Vision; feedback.md |
| M-3 | The export button in the dialog said only "Export" on every tab. | `export/ExportDialog.tsx:398-401` | writing.md › Best practices (a button says what happens) |
| M-4 | "Replace my edits" on re-transcribe is destructive but was a primary, not danger. | `RetranscribeDialog.tsx:248-256` | buttons.md › Best practices (destructive style); DESIGN.md › Components |
| M-5 | Accent spent on non-state things: accent-tinted segmented controls in Audio and Style tabs, the "AI-Powered" pill, an accent track icon and a camera icon in `editor-emphasis` on the timeline labels, a 10 % accent-filled transition tile, accent "line/word" text. | `audio/AudioPanel.tsx:52,114`; `panels/StylePicker.tsx:40`; `timeline/Timeline.tsx:394,417`; `panels/RightPanel.tsx:1487,1594` | DESIGN.md › Accent budget |
| M-6 | Status used the brand accent: Export history "Succeeded" and plugin "signed in" badges were `tone="accent"`. | `export/ExportHistory.tsx:155`; `passes/PluginActivationCue.tsx:19` | DESIGN.md › Colour ("signals are never decoration") |
| M-7 | Reflow banner: whole sentence in the warning hue and a warning-filled button. | `transcript/ReflowBanner.tsx:35,49` | DESIGN.md › Accent budget / Signals |
| M-8 | Active inspector tab underline was `fg-0`, not the accent; tab labels 13.5 px. | `panels/RightPanel.tsx:260-262` | DESIGN.md › Components (Tabs) |
| M-9 | Active rail tab distinguished only by a slightly lighter background (bg-1 vs bg-2). | `rail/EditorRail.tsx:76` | accessibility.md › Vision (more than colour alone); DESIGN.md › Accent budget |
| M-10 | Inspector section headings put an `h3` inside a `button` (invalid: a heading is not phrasing content). | `panels/RightPanel.tsx:418-434` | voiceover.md; judgment |
| M-11 | Sub-32 px hit targets: timeline tool buttons 28 px, search 28 px, reset buttons 22 px, caption header pills 31 px, lock guard ~20 px, preset delete 22 px, inspector collapse toggle 14 × 34. | `timeline/Timeline.tsx:205,208,1978`; `panels/controls.tsx:84,417`; `transcript/CaptionsPanelHeader.tsx:62,76`; `canvas/CaptionStage.tsx:486`; `panels/StylePicker.tsx:262`; `editor.css:179-193` | accessibility.md › Mobility |
| M-12 | Text below the 11 px floor: 9 px segment timestamps, 10 px lock label, 10.5 px rail labels, 10 px timeline ruler. | `editor.css:104`; `canvas/CaptionStage.tsx:497,502`; `rail/EditorRail.tsx:81`; `timeline/Timeline.tsx:678` | accessibility.md › Vision (minimum sizes); DESIGN.md › Type |
| M-13 | Nocturne's fading rule under the inspector tabs, commented as "the Nocturne signature". | `editor.css:224-233` | DESIGN.md › Shape ("plain hairlines") |
| M-14 | The resolution pill read "Res" beside a gold dot, with the actual geometry only in an `sr-only` span. | `toolbar/PlayerToolbar.tsx:96-104` | writing.md › Best practices (clarity) |
| M-15 | Title-case labels: "Audio Enhancement", "Caption Tools", "Font Face", "Font Family", "Font Size", "Text Stroke", "Text Alignment", "Display Settings", "Custom Fonts", "Speed Mode: Dynamic", "Transitions will be Applied on". | `AudioPanel.tsx:116`; `CaptionsPanelHeader.tsx:78`; `RightPanel.tsx:577,816,857,1093,1109,1382,1594,1644`; `Timeline.tsx:2064`; `EditorRail.tsx:31` | DESIGN.md › Writing (sentence case) |
| M-16 | `font-display` on the Audio tab's `h3`. | `audio/AudioPanel.tsx:116` | DESIGN.md › Type |
| M-17 | Raw colours outside the canvas: `bg-white border-black` drag handles, `text-amber-400` lock icon, `text-red-400` in the command palette, `rgba(20,20,22,.72)` player pills, Nocturne `#101220` style-preview clear colour. | `canvas/CaptionStage.tsx:496,508-515`; `EditorCommandPalette.tsx:100`; `toolbar/PlayerToolbar.tsx:46`; `canvas/StylePreviewCanvas.tsx:56` | DESIGN.md › Colour |
| M-18 | Offline notice was a bare warning-coloured line with no role, promising nothing about the user's pending edits. | `editor-client.tsx:946-949` | feedback.md; writing.md |
| M-19 | Hidden caption rows faded to 40 % opacity, taking their words well under 4.5:1. | `transcript/SegmentCard.tsx:184` | accessibility.md › Vision |
| M-20 | The resegment "dialog" in `BulkActionsBar` is a hand-rolled fixed `div` with `role="dialog"`: no backdrop, no focus trap, no Escape. | `transcript/BulkActionsBar.tsx:84-160` | modality.md; accessibility.md › Mobility |
| M-21 | Timeline pass-lane colours (`#7c8ff0`, `#4ade80`, `#facc15`, `#f87171`) come from `lib/timeline/lanes.ts`, outside this area. | `lib/timeline/lanes.ts:124-135` | DESIGN.md › Colour |

### Low

| # | Finding | Where | Reference |
|---|---|---|---|
| L-1 | Caption row action buttons (style, hide, merge) are 24 px; hide and merge are absolutely positioned by `editor.css`, so growing them would collide with the speaker chip. | `transcript/SegmentCard.tsx:261,277,307`; `editor.css:111-125` | accessibility.md › Mobility |
| L-2 | Timeline chips carry an 8.5 px "𝑇 Text" sub-label copied from the reference; it names nothing. | `timeline/Timeline.tsx:865,910` | writing.md; DESIGN.md › Type |
| L-3 | The segment index column is decorative but was `fg-disabled` (3.7:1). | `transcript/SegmentCard.tsx:191` | accessibility.md › Vision |
| L-4 | The editor's minimum workspace width (1000 px, `overflow-x: auto` under 1100 px) means no mobile layout. Deliberate for a desktop editing tool, but it breaks the 360 px floor. | `editor.css:601-611` | layout.md › Adaptability; DESIGN.md › Accessibility floor |
| L-5 | `/export-harness` is reachable by URL by any signed-in user and exposes the store and API client on `window`. Not a design issue; worth a guard to non-production builds. | `app/(app)/export-harness/page.tsx` | judgment |
| L-6 | The editor has no `prefers-contrast` or light appearance; the dark-only choice is documented in DESIGN.md. | — | dark-mode.md; accessibility.md › Vision |

### States check

| Surface | Empty | Loading | Error |
|---|---|---|---|
| Editor route | `NeedsTranscription` offer (now `PageHeader` + primary) | "Opening the project…", `role=status` | `PageHeader` + Try again / Back to projects (was a red sentence) |
| Render crash | — | — | `error.tsx`, `PageHeader`, details collapsed, primary Reload |
| Transcript | Script tab without translation shows an inline hint | store-driven | conflict dialog |
| Style › My presets | one-line headline + hint | — | — |
| Export dialog | To editor tab explains itself | progress bar + frame count / cloud progress | `text-rejected`, `role=alert` (was stock red, silent) |
| Audio | "No clean run yet." | status line | `role=alert` in `text-rejected` |

---

## Changes made

All in owned files; no `data-testid` removed or renamed, no API calls, props
contracts or business logic changed.

**Primary and accent budget**
- `ExportButton` is now the editor's one `variant="primary"`; the mint
  repaint in `editor.css` is gone (the footer only sizes it) (H-6).
- Demoted to secondary/neutral: Audio "Clean audio", Style "Save as
  template", rail "Add font", the too-stale "Reload", the back link (now a
  32 px ghost icon button with an arrow) (H-6).
- Export dialog: the start button is `primary` and names its action ("Export
  video" / "Export subtitles"); when a cloud render is done, "Download file"
  takes the fill and Export steps down to secondary (M-3).
- Force re-transcribe ("replace my edits") is `danger` (M-4).
- Segmented controls in Audio, Style, Timeline, transition scope and
  `controls.tsx` use the neutral raised well; transition tiles and style tiles
  use the selected-card ring (`border-accent ring-1 ring-accent`); proposal
  focus ring and confidence meter use the accent (M-5).
- Status badges use signals: export "Succeeded" and plugin "signed in" are
  `accepted` (M-6). Reflow banner text is `fg-1` with a `proposed` icon and a
  neutral outline button (M-7).
- Active inspector tab has the accent underline (M-8); active rail tab gains a
  2 px accent bar (M-9).

**Page title and states**
- The project title in `EditorTopBar` is the page's `h1`, in the display face,
  hung from the `shirorekha` bar; the bar is 48 px tall to fit it (H-7).
  `PageHeader` itself is not used there (see Deferred D-1).
- `editor-client.tsx`: loading is `role=status`; load failure is a
  `PageHeader` with "Try again" (primary) and "Back to projects"; the offline
  strip is a `role=status` notice telling people to keep the tab open; the
  too-stale strip is `role=alert` and says what Reload does (H-9, M-18).
- `error.tsx`: `PageHeader`, the error message in a collapsed "Technical
  details" block, primary "Reload the editor", ghost "Back to projects",
  tokens only (H-9).
- `needs-transcription.tsx`: every state title is a `PageHeader`
  in a left-aligned 576 px column; "Start transcription" / "Try again" is the
  primary; "no media" gains a way back to projects; copy tightened (H-10).

**Contrast and colour**
- Timeline canvas: a single `CANVAS` palette naming each token it copies;
  words are warm-neutral chips (fg-0 on neutral-700, 6.4:1), fillers
  neutral-800 with fg-1 (7.6:1), the playing word is the accent with ink text
  (5.5:1, was 3.4:1), selection edges in the accent, waveform neutral, ruler
  on `editor-ruler`, search/low-confidence in `proposed`, protected ranges fall
  back to `info` (H-2, H-3).
- Transcript: the playing word is `accent-200` on `accent-900` (11.8:1, was
  3.8:1); fillers are `fg-2` italic (6.1:1, was 3.7:1); hidden rows 60 %
  (M-19); index column `fg-2` (L-3) (H-4, H-5).
- 23 `text-fg-3` → `text-fg-2` (M-1). Export dialog outcomes use
  `rejected`/`accepted`/`warning` tokens with `role=alert`/`status` (M-2).
- Raw colours replaced: drag handles `bg-fg-0 border-ink`, lock guard neutral,
  palette danger `text-rejected`, player pills `bg-overlay`, style preview
  clear colour `#0e0c10` (sunken), video stage `bg-ink` (M-17).
- Links on panels use `accent-300` + underline (upsell "See plans", plugin
  "Set up").

**Targets, type, structure, copy**
- 32 px: player controls (H-8), timeline tool buttons and search, caption
  header pills, segmented items (28 px inside a 34 px track), lock guard
  (28 px), inspector mode and colour-mode buttons; resets and preset delete
  24–28 px; inspector collapse toggle 16 × 40 with a border (M-11).
- 11 px floor: segment timestamps, lock label, rail labels, ruler (M-12).
- Inspector tab rule is a plain hairline (M-13); inspector section headings
  are `h3 > button` (M-10).
- Resolution pill shows `1080×1920 · 9:16` in mono (M-14).
- Sentence case throughout the listed labels; Audio heading is Inter 600
  (M-15, M-16). The fake credits card and feature checklist are removed (C-1).
- Test updates: `SegmentCard.test.tsx` (hidden row `opacity-60`) and
  `segment-card-menu.test.tsx` (destructive row `text-rejected`, which the
  shared context-menu primitive now emits).

Verification: `pnpm exec tsc --noEmit` clean; `npx vitest run components/editor
app/(app)/p --maxWorkers=2` 50 files / 393 tests pass; `packages/ui` 119 tests
pass; `eslint` on all three owned directories exits 0.

## Deferred

- **D-1 `PageHeader` in the editor top bar.** The editor's title is an inline
  rename control in a tool bar; `PageHeader`'s 28 px title and description
  would cost the footage ~40 px of height. The title uses the same
  `shirorekha` utility and display face directly. If the orchestrator wants
  `PageHeader` literally, it needs a compact size (`size="sm"`, ~18 px title,
  no bottom margin) in `packages/ui` — requested below.
- **D-2 Resegment dialog (M-20)** should move to `@montaj/ui` `Dialog` for a
  focus trap and Escape; left because `BulkActionsBar` renders in two places
  (transcript column and the timeline's Caption tools menu) and its tests drive
  the current DOM.
- **D-3 Caption row action targets (L-1)** stay 24 px; growing them needs the
  absolute offsets in `editor.css` and the speaker chip reworked together.
- **D-4 Pass-lane colours (M-21)** live in `lib/timeline/lanes.ts`, outside
  this area — requested below.
- **D-5 Processing states** in `needs-transcription.tsx` render the shared
  `ProcessingScreen`, whose title is a centred `h2`; those two states have no
  `h1` and no shirorekha. Requested below.
- **D-6 Mobile (L-4):** the editor keeps its 1000 px minimum; a phone layout
  is a product decision, not a restyle.
- **D-7 `.panel-range` / `.panel-switch` / `.panel-swatch`** were not touched
  (globals.css, shell-owned). The editor's own `.panel-range` override in
  `editor.css` paints the filled part `fg-disabled`; DESIGN.md allows "a filled
  meter" in the accent, but a slider is not a meter, so it was left neutral.
- **D-8** The `/export-harness` production guard (L-5) is left for a
  follow-up. (L-2 was fixed in review, below.)

## Review pass (2026-09-25)

A second designer checked the implementation above against DESIGN.md. No
`data-testid` was removed or renamed and no logic changed. These leftovers were
fixed:

- `ExportHistory` "No link, try again" was still `text-red-400`. It is now
  `text-rejected` with `role=alert`.
- `RetranscribeDialog`'s has-edits warning was still `text-amber-200`. It is
  now `text-warning`.
- The timeline Caption tools menu's Caption delay "Apply" was a second
  accent-filled button on screen next to Export, in a non-modal popover. It is
  now a neutral outline button.
- Title case was still used for "Font Face" (the weight row's visible label),
  "Max Chars", "Remove Punctuation", "Remove Emphasis", "Remove Gaps in
  Captions", "Remove Emojis" and "Caption Delay". They are now sentence case
  ("Max chars" became "Max characters").
- L-2: the 8.5 px "𝑇 Text" sub-label under every timeline chip is removed, and
  chip labels are now 11 px instead of 10.5 px.
- The find and replace panel's close button was 28 px. It is now 32 px.
- The canvas lock guard had `aria-pressed` and also changed its label when
  pressed, which makes screen readers announce the state twice. It keeps the
  label that names the state and no longer sets `aria-pressed`.
- `needs-transcription` "Back to projects" is now a `next/link` `Link`
  instead of a plain `<a>`.

Still open: D-2 (the resegment dialog has no focus trap), D-3 (24 px caption
row buttons), D-4 (pass-lane colours in `lib/`), D-5 (`ProcessingScreen` has
no `h1`), D-6 (no mobile layout). `FirstRunCoachMarks`,
`RegenerateTranslationDialog` and `ReplaceMediaButton` each have their own
`variant="primary"`. They are left as they are because each is a separate
modal or coach-mark surface.
