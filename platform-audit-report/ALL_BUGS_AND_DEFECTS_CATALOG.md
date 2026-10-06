# Catalog of All Identified Bugs & Defects

This document details every single bug, failed process, and broken function discovered during the multi-angle platform audit.

---

### [CRITICAL] BUG-AI-001: Unimplemented Highlight Discovery Queue (ai.highlights)

- **Category:** `AI Worker & Pipeline`
- **Subsystem:** `Repurposing Engine / worker-ai`
- **File / Endpoint:** `apps/worker-ai/worker_ai/highlights/contracts.py`
- **Observed Symptom:** Every YouTube repurpose run halts indefinitely or fails at 'finding_clips' stage (0% progress).
- **Root Cause Analysis:** The queue 'ai.highlights' is registered across runtimes and consumed, but has NO processor in worker_ai. test_runtime.py literally asserts unimplemented == {'ai.highlights'}.
- **Reproduction:** 1. Navigate to /repurpose/new. 2. Submit valid YouTube link with rights check. 3. Video probes, proxies, transcribes, then halts at Finding Clips indefinitely.
- **Recommended Engineering Fix:** Implement the highlight discovery processor in apps/worker-ai/worker_ai/highlights/ using transcript word density, semantic chunking, and ranking models.

---

### [CRITICAL] BUG-AI-002: Missing Video Clipping Worker (media.clip)

- **Category:** `Pipeline & Queues`
- **Subsystem:** `Media Processing / worker-media`
- **File / Endpoint:** `apps/worker-media/src/queues.ts`
- **Observed Symptom:** Cannot materialize or cut approved video intervals into short clips for social export.
- **Root Cause Analysis:** The queue 'media.clip' is defined in contracts but explicitly excluded from MEDIA_QUEUES in worker-media ('media.clip is in QUEUE_NAMES from REP-005 but is NOT here').
- **Reproduction:** Attempt to progress a repurpose run from candidate selection to clip materialization; job cannot be enqueued or processed.
- **Recommended Engineering Fix:** Implement the ffmpeg interval cutter in worker-media using exact keyframe cuts and register 'media.clip' in MEDIA_QUEUES.

---

### [HIGH] BUG-AI-003: Missing Social Publishing Dispatch Workers (publish.dispatch / publish.reconcile)

- **Category:** `Pipeline & Queues`
- **Subsystem:** `Social Publishing / api & workers`
- **File / Endpoint:** `apps/worker-media/src/queues.ts`
- **Observed Symptom:** Social posting to Instagram, YouTube Shorts, TikTok, and LinkedIn is non-functional.
- **Root Cause Analysis:** Contracts exist in @montaj/publishing-contracts, but no worker or OAuth provider dispatcher exists in either worker-media or API.
- **Reproduction:** Review bundles cannot be dispatched to connected channel targets.
- **Recommended Engineering Fix:** Implement the social publishing dispatcher workers and token exchange lifecycle adapters.

---

### [HIGH] BUG-AI-004: Sarvam Transcripts Zero Timestamp Legacy Data Corruption

- **Category:** `AI Worker & Transcriber`
- **Subsystem:** `Transcripts & Alignment`
- **File / Endpoint:** `apps/worker-ai/worker_ai/providers/sarvam.py`
- **Observed Symptom:** All captions in historical Hindi/Hinglish projects transcribed before 2026-09-17 freeze at frame 0 (s:0, e:0).
- **Root Cause Analysis:** Sarvam codemix vendor adapter previously returned parallel arrays that collapsed into zero-length spans. While new calls are parsed, pre-existing database rows (e.g. project 01M2K1R52AANE4TH9RS5VH167D with 194 chunks, 2,193 words) remain corrupted in Postgres.
- **Reproduction:** Open project 01M2K1R52AANE4TH9RS5VH167D ('Air India Phuket Turbulence Incident') in editor or trigger export harness; all words have s:0, e:0.
- **Recommended Engineering Fix:** Run an automated data migration script using Sarvam API or Whisper re-aligner to recalculate word boundaries for all unaligned transcript_chunks.

---

### [MEDIUM] BUG-AI-005: Mypy Typecheck Failure on LogRecord.chunkKeys in worker-ai

- **Category:** `Quality Gates & CI`
- **Subsystem:** `Testing & Type Safety`
- **File / Endpoint:** `apps/worker-ai/tests/test_vendor_adapters.py:529`
- **Observed Symptom:** pnpm turbo run typecheck fails across the monorepo.
- **Root Cause Analysis:** Line 529 accesses `warnings[0].chunkKeys`, but `LogRecord` does not have statically typed attribute `chunkKeys`.
- **Reproduction:** Run: pnpm --filter @montaj/worker-ai typecheck (or node scripts/py.mjs -m mypy --strict .).
- **Recommended Engineering Fix:** Change to `getattr(warnings[0], 'chunkKeys', [])` or add type ignore comment `# type: ignore[attr-defined]`.

---

### [CRITICAL] BUG-SEC-001: CRITICAL: Memory Glossary Terms Leaked When User Withholds Consent (DPDP Act Violation)

- **Category:** `Security & Data Privacy`
- **Subsystem:** `Transcripts / Memory Service`
- **File / Endpoint:** `apps/api/test/memory-transcribe-hints.e2e-spec.ts`
- **Observed Symptom:** User glossary and personal terminology ('bedroom', 'villa', 'Lonavala') automatically injected into ASR hints even when ConsentPurpose.memory is FALSE.
- **Root Cause Analysis:** In TranscriptsService.transcribe(), memory terms query does not strictly verify active consent row before joining workspace terms into hints payload.
- **Reproduction:** Run: pnpm --filter @montaj/api exec vitest run test/memory-transcribe-hints.e2e-spec.ts. Both consent-withheld and consent-granted tests FAIL.
- **Recommended Engineering Fix:** Add consent check `const consent = await this.consentsService.hasConsent(workspaceId, ConsentPurpose.memory); if (!consent) return [];` before merging memory terms.

---

### [HIGH] BUG-API-002: Seed Data Parity Gate Failure for editorial-ghost-type Style

- **Category:** `Quality Gates & Backend`
- **Subsystem:** `Caption Styles / Database Seed`
- **File / Endpoint:** `apps/api/prisma/seed-data.test.ts:180`
- **Observed Symptom:** Backend test suite fails on seed data verification: editorial-ghost-type expected assExportable true, received false.
- **Root Cause Analysis:** The style definition for 'editorial-ghost-type' in packages/caption-styles has `parity: { assExportable: false }`, violating the invariant that all seeded system styles must be exportable to ASS.
- **Reproduction:** Run: pnpm --filter @montaj/api exec vitest run prisma/seed-data.test.ts.
- **Recommended Engineering Fix:** Update editorial-ghost-type style parity configuration or update the test expectation if ASS export is intentionally unsupported.

---

### [MEDIUM] BUG-DB-003: Orphaned & Stale Media Assets Stuck in 'uploading' / 'probing' State

- **Category:** `Database & Storage`
- **Subsystem:** `Media Ingest & Retention`
- **File / Endpoint:** `apps/api/src/media/retention.service.ts`
- **Observed Symptom:** 12 media asset rows in montaj_main remain indefinitely in 'uploading' or 'probing' status dating back weeks.
- **Root Cause Analysis:** Retention sweeper only cleans up deleted or expired media; incomplete uploads that never called /complete have no automated Reaper task.
- **Reproduction:** Query DB: `SELECT id, status, created_at FROM media_assets WHERE status IN ('uploading', 'probing') AND created_at < NOW() - INTERVAL '7 days'`. Returns 12 rows.
- **Recommended Engineering Fix:** Add a scheduled sweeper task `markStaleUploadsFailed` that marks assets stuck > 2 hours as 'failed' and frees storage reservation.

---

### [HIGH] BUG-API-004: Unimplemented Live Razorpay Renewal Charges in Billing Provider

- **Category:** `Billing & Payments`
- **Subsystem:** `Razorpay Integration`
- **File / Endpoint:** `apps/api/src/billing/providers/razorpay.provider.ts:201`
- **Observed Symptom:** Manual retry of failed recurring subscription renewals throws BillingProviderError('manual_charge_unsupported').
- **Root Cause Analysis:** chargeRenewal() throws an unhandled BillingProviderError exception instead of managing invoice collection or creating a payment link addon.
- **Reproduction:** Trigger subscription renewal retry via API or billing worker.
- **Recommended Engineering Fix:** Implement Razorpay Invoice API fallback or customer notification workflow with checkout link for subscription retry.

---

### [MEDIUM] BUG-API-005: Partner Catalogue License Snapshots Hardcoded to 'TODO(H-28)' Placeholder

- **Category:** `Backend Architecture`
- **Subsystem:** `Audio Assets / Licensing`
- **File / Endpoint:** `apps/api/src/partner-catalogue/licence-snapshot.ts:15`
- **Observed Symptom:** All music and sound effects asset grants persist placeholder license records with `licenceType: 'TODO(H-28)'` and `pending: true`.
- **Root Cause Analysis:** Digital rights management contract integration with Epidemic Sound was stubbed with sentinel constant `TODO_H28_LICENCE_TYPE = 'TODO(H-28)'`.
- **Reproduction:** Inspect database: `SELECT id, licence_snapshot FROM asset_clearance_grants`. Every row has licenceType 'TODO(H-28)'.
- **Recommended Engineering Fix:** Implement actual provider license metadata generator and rights verification signing.

---

### [HIGH] BUG-PIPE-006: Dead Letter Queue: Audio-Only Source Causes render.video Job Crash

- **Category:** `Pipeline & Queues`
- **Subsystem:** `Remotion / Skia Render Engine`
- **File / Endpoint:** `apps/render/src/workers/render-worker.ts`
- **Observed Symptom:** When user attempts to export video on an audio-only project (e.g. welcome.wav), job crashes with 'has no video stream to render over' and lands in DLQ.
- **Root Cause Analysis:** Export pipeline permits selecting video presets even when source media asset has `hasVideo: false`.
- **Reproduction:** Inspect DLQ entry in montaj_main: job 01M1MCJHRWJ6F9WMW9WBDYVVYK failed with `render/no-video-stream`.
- **Recommended Engineering Fix:** Enforce validation in POST /projects/{id}/exports: reject `kind: 'video'` with 400 Bad Request `media/no_video_stream` if source media has no video track.

---

### [HIGH] BUG-PIPE-007: Dead Letter Queue: YouTube Bot Detection Blocks media.acquire

- **Category:** `Pipeline & Queues`
- **Subsystem:** `worker-media / yt-dlp`
- **File / Endpoint:** `apps/worker-media/src/yt-dlp.ts`
- **Observed Symptom:** YouTube video downloads fail with 'Sign in to confirm you're not a bot' and move to DLQ.
- **Root Cause Analysis:** yt-dlp running on local/datacenter IP without authenticated cookie file triggers Google bot challenge.
- **Reproduction:** Inspect DLQ entry: job 01M2NRC4T1DC2ZQ19SPYK4ZHST failed with `Sign in to confirm you're not a bot. Use --cookies-from-browser`.
- **Recommended Engineering Fix:** Support configuring `YT_DLP_COOKIES_PATH` in environment and passing `--cookies` parameter to yt-dlp process.

---

### [RESOLVED] BUG-CODE-008: Lint Failures Across Packages in Monorepo

- **Status:** `RESOLVED` (Owned by ENG-008, RLS-008)
- **Category:** `Quality Gates & Lint`
- **Subsystem:** `Static Analysis`
- **File / Endpoint:** `turbo.json / eslint.config.mjs`
- **Observed Symptom:** `pnpm turbo run lint` initially failed on packages with import order, line length, explicit `any`, and unannotated security rules.
- **Root Cause Analysis:** Rule drift, loose `any` types on repurpose endpoints and hooks, missing newline formatting after imports in helper scripts, and unannotated ephemeral scratch filesystem paths.
- **Resolution:**
  - Resolved all genuine rule violations package-by-package across `@montaj/worker-ai`, `@montaj/worker-media`, `@montaj/api-client`, `@montaj/web`, `@montaj/config`, and `@montaj/api`.
  - Replaced all explicit `any` usages with strongly typed interfaces (`RepurposeCandidateItem`, `RepurposeClipItem`, `Record<string, unknown>`).
  - Narrowly documented ephemeral workspace scratch filesystem suppressions with squad ownership (`@aksharo/core-pipelines`, `@aksharo/release-dx`).
  - Proved 100% green uncached pass: `pnpm turbo run lint --force` passes with 37/37 tasks successful, zero cached, zero errors, zero warnings under Node 22 / pnpm 9.
  - Verified `pnpm format:changed:check` reports clean.

---

### [MEDIUM] BUG-UI-001: Public Status Page Displays 1970 Epoch Date & Empty Components

- **Category:** `Frontend UI & Public`
- **Subsystem:** `Operations & Status`
- **File / Endpoint:** `apps/web/app/(site)/(marketing)/status/page.tsx`
- **Observed Symptom:** Visiting https://aksharo.crestmondtechnologies.com/status shows 'Last updated 1 Jan 1970, 5:30 am' and 'No component checks published yet'.
- **Root Cause Analysis:** MONTAJ_SCHEDULER_DISABLED=1 disables StatusPublishTask, so ops_status_snapshots table has 0 rows. StatusController returns fallback epoch 0.
- **Reproduction:** Navigate to http://127.0.0.1:3914/status in browser; observe 1 Jan 1970 timestamp.
- **Recommended Engineering Fix:** Either run StatusPublishTask on startup or seed a valid initial operational snapshot in database migrations.

---

### [HIGH] BUG-UI-002: Un-timeouted Server-Side Fetch in loadStatusSnapshot() Risks SSR Hang

- **Category:** `Frontend Architecture`
- **Subsystem:** `SSR Performance`
- **File / Endpoint:** `apps/web/app/(site)/(marketing)/status/status-data.ts:52`
- **Observed Symptom:** Page navigation to /status can hang up to 10-12 seconds on slow networks or DNS delays.
- **Root Cause Analysis:** fetch(`${apiOrigin}/ops/status.json`) lacks an `AbortSignal.timeout(2000)` parameter.
- **Reproduction:** Block or throttle apiOrigin domain; observe Playwright timeout 12000ms exceeded on /status.
- **Recommended Engineering Fix:** Add `signal: AbortSignal.timeout(2500)` to the fetch call.

---

### [MEDIUM] BUG-UI-003: Desktop Download Page Renders Placeholder Text & Missing Installers

- **Category:** `Frontend UI & Public`
- **Subsystem:** `Marketing / Download`
- **File / Endpoint:** `apps/web/app/(site)/(marketing)/download/page.tsx:87`
- **Observed Symptom:** Download cards display 'Download link placeholder — the signed installer ships with C10' and screenshot placeholders.
- **Root Cause Analysis:** Native desktop clients (Electron / Tauri) have not been packaged, signed, or uploaded to R2/MinIO.
- **Reproduction:** Visit http://127.0.0.1:3914/download; observe placeholder text on Windows, macOS, and Linux cards.
- **Recommended Engineering Fix:** Build and publish signed installer artifacts or update copy to indicate 'Coming Soon / Join Waitlist'.

---

### [HIGH] BUG-UI-004: Editor Right Panel Tabs Inaccessible via DOM Clicks When Viewport Resizes

- **Category:** `Editor & Accessibility`
- **Subsystem:** `Editor Layout`
- **File / Endpoint:** `apps/web/components/editor/panels/panel-tabs.tsx`
- **Observed Symptom:** Clicking 'Styles' or 'Templates' tab times out with 'element is not visible' in browser automation and small viewports.
- **Root Cause Analysis:** Panel tabs overflow or get obscured behind canvas wrapper without accessible scrolling or visible aria-expanded state.
- **Reproduction:** Playwright script elementHandle.click on right panel tabs times out after 30000ms.
- **Recommended Engineering Fix:** Ensure tab strip has overflow-x-auto, clear pointer-events, and accessible focus management.

---

### [LOW] BUG-UI-005: HTMLCanvasElement getContext() Mock Missing in Vitest Environment

- **Category:** `Quality Gates & Testing`
- **Subsystem:** `Web Test Suite`
- **File / Endpoint:** `components/editor/timeline/Timeline.test.tsx`
- **Observed Symptom:** Unit tests spit out 'Not implemented: HTMLCanvasElement getContext() method: without installing the canvas npm package'.
- **Root Cause Analysis:** jsdom does not implement native HTML5 canvas 2D context by default.
- **Reproduction:** Run: pnpm --filter @montaj/web test.
- **Recommended Engineering Fix:** Install `jest-canvas-mock` in apps/web/vitest.setup.ts.

---

### [HIGH] BUG-UI-006: SSL Protocol Error and Broken Navigation Link on /settings/developers

- **Category:** `Frontend Navigation`
- **Subsystem:** `Settings / Developer Surface`
- **File / Endpoint:** `apps/web/app/(app)/settings/developers/page.tsx`
- **Observed Symptom:** Console logs `net::ERR_SSL_PROTOCOL_ERROR` and `Failed to fetch RSC payload for http://127.0.0.1:3914/developers`.
- **Root Cause Analysis:** Anchor tag or documentation button links to `/developers` instead of `/docs/developers` or mixes HTTP/HTTPS protocols.
- **Reproduction:** Navigate to /settings/developers and inspect console logs.
- **Recommended Engineering Fix:** Correct the internal documentation link to `/docs/developers`.

---

### [MEDIUM] BUG-UI-007: Repurpose Start Form DOM Detach Error on Rapid URL Input

- **Category:** `Frontend UX`
- **Subsystem:** `Repurposing UI`
- **File / Endpoint:** `apps/web/app/(app)/repurpose/new/page.tsx`
- **Observed Symptom:** Rapid pasting or filling into sourceUrl input causes 'Element is not attached to the DOM' due to unkeyed re-rendering.
- **Root Cause Analysis:** Component re-renders parent wrapper unconditionally on input debounce, unmounting and remounting the input element.
- **Reproduction:** Rapidly fill URL input in Playwright test; element detached exception thrown.
- **Recommended Engineering Fix:** Use uncontrolled input with React `useRef` or isolate debounce state inside the form component.

---

### [LOW] BUG-UI-008: Missing Empty State Graphic on Projects Search Filter

- **Category:** `Frontend UX`
- **Subsystem:** `Projects Library`
- **File / Endpoint:** `apps/web/components/projects/project-grid.tsx`
- **Observed Symptom:** Typing a query with no matches produces an unstyled blank white area rather than a helpful empty state with clear action.
- **Root Cause Analysis:** Missing `<EmptyState />` fallback component when filtered project list length is 0.
- **Reproduction:** Type 'zzzzzz' in projects search bar on /projects.
- **Recommended Engineering Fix:** Render Nocturne styled empty state card with 'No matching projects found. Clear filter'.

---

### [HIGH] BUG-CAP-001: Split & Conflicting "Caption Tools" Menus Between Header and Timeline

- **Category:** `Editor & UX Architecture`
- **Subsystem:** `Caption Tools Menus`
- **File / Endpoint:** `apps/web/app/(app)/p/[id]/editor-client.tsx` (L1037-1064) vs `apps/web/components/editor/timeline/Timeline.tsx` (L1920-2220)
- **Observed Symptom:** Editors encounter two conflicting menus named "Caption Tools". The one in the Captions panel header (`[data-testid="captions-panel-tools-trigger"]`) contains menubar duplicates (`File`, `Edit`, `View`, `Help`), script tabs, and bulk action buttons (`Merge short`, `Split long`, `Auto-resegment`), but none of the actual caption cleanup tools. Meanwhile, the actual caption cleanup tools (Remove Punctuation, Remove Emphasis, Remove Gaps, Remove Emojis, Caption Delay slider) are hidden inside an unlabeled sliders icon on the timeline toolbar (`[data-testid="timeline-caption-tools-trigger"]`).
- **Root Cause Analysis:** Architectural divergence during UI refactoring. `CaptionsPanelHeader` accepted `{children}` and wrapped the top application menubar inside a dropdown popover labeled "Caption Tools ⌄", while the timing and linguistic cleanup actions were implemented separately inside the timeline component.
- **Reproduction:** 1. Open any project in editor (`/p/{id}`). 2. Click "Caption Tools ⌄" in the transcript panel header. Note that Remove Punctuation/Gaps/Delay are missing. 3. Look at timeline toolbar and click the slider icon to find the cleanup actions.
- **Recommended Engineering Fix:** Unify caption tooling into a cohesive, consolidated menu or persistent toolbar. Expose cleanup tools (punctuation, gaps, delay, emojis) directly in the transcript panel header or RightPanel, and remove the redundant `EditorMenubar` wrapper from inside the header popover.

---

### [HIGH] BUG-CAP-002: ScriptTabs (Roman/Native/EN) Inaccessible and Hidden Inside Popover

- **Category:** `Editor & Multilingual UI`
- **Subsystem:** `Transcript Script Switching`
- **File / Endpoint:** `apps/web/app/(app)/p/[id]/editor-client.tsx` (L1043)
- **Observed Symptom:** Multilingual script tabs (Romanized, Native script e.g. Devanagari, English translation, and Add Translation) are completely invisible during regular caption editing. The editor cannot see or switch between scripts while reviewing and editing words without first clicking into the "Caption Tools" popover.
- **Root Cause Analysis:** `<ScriptTabs />` was placed inside the popover children of `CaptionsPanelHeader` (`hidden={!open}` when popover is closed) rather than being rendered as a permanent subheader above `TranscriptList`.
- **Reproduction:** Load editor with a multilingual transcript. Observe that the user cannot see which script is currently active, and cannot click between Roman/Native/EN without opening the popover.
- **Recommended Engineering Fix:** Mount `<ScriptTabs />` directly underneath `CaptionsPanelHeader` as a sticky subheader in the transcript column, ensuring it is always visible and one click away for the editor.

---

### [MEDIUM] BUG-CAP-003: Hex Color Input Paste Truncation & 3-Character Shorthand Discard

- **Category:** `Editor Controls & Inputs`
- **Subsystem:** `ColorPicker / controls.tsx`
- **File / Endpoint:** `apps/web/components/editor/panels/controls.tsx` (L345-351)
- **Observed Symptom:** Pasting standard hex codes (e.g. `#10B981` or `#FF5500`) into the Hex input field results in the last character being truncated (`#10B98`), failing validation and silently discarding the user's color input back to the previous color. Additionally, standard 3-character hex shorthand (e.g. `FFF` or `#000`) is rejected.
- **Root Cause Analysis:** The input element has `maxLength={6}` and validates on blur with `/^[0-9a-f]{6}$/i`. Pasting `#` takes up index 0, forcing the 6th hex digit to be dropped by HTML maxLength constraint.
- **Reproduction:** 1. In RightPanel `Text` tab, click Text Color swatch. 2. Focus Hex input field and paste `#10B981`. 3. Press Tab or click outside. Observe input reverts to previous color.
- **Recommended Engineering Fix:** Set `maxLength={7}` on the input. In the `onChange` and `onBlur` handlers, strip any leading `#` automatically: `val.replace(/^#/, '')`. Update validation regex to accept both 3-char and 6-char hex: `/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i` and expand 3-character shorthand to 6-character hex.

---

### [MEDIUM] BUG-CAP-004: Find & Replace Overlay Clashes With RightPanel & Obscures Style Inspector Tabs

- **Category:** `Editor Layout & Overlays`
- **Subsystem:** `Transcript Search / FindReplaceDialog`
- **File / Endpoint:** `apps/web/components/editor/transcript/FindReplaceDialog.tsx` & `apps/web/app/(app)/p/[id]/editor-client.tsx`
- **Observed Symptom:** Clicking the search icon (`[data-testid="captions-panel-search"]`) in the transcript header mounts the Find & Replace overlay directly over the top of the **RightPanel**, completely obscuring the inspector tabs (`Text`, `Templates`, `Transitions`, `AI Audio`) and active styling controls.
- **Root Cause Analysis:** `FindReplaceDialog` is rendered inside or docked to the right sidebar layout slot rather than being positioned as a floating bar above the transcript virtual list where the actual matches exist.
- **Reproduction:** 1. In transcript header, click the magnifying glass search icon. 2. Observe the search box covers the inspector tabs on the right side of the screen.
- **Recommended Engineering Fix:** Reposition `FindReplaceDialog` to dock cleanly atop the `TranscriptList` column or float as an anchored popover under `CaptionsPanelHeader`, leaving the RightPanel fully accessible.

---

### [MEDIUM] BUG-CAP-005: Font Search Autocomplete Display Reversion on Case Mismatch

- **Category:** `Editor Controls & Typography`
- **Subsystem:** `SearchSelectField / controls.tsx`
- **File / Endpoint:** `apps/web/components/editor/panels/controls.tsx` (L808)
- **Observed Symptom:** When an editor types a valid font name in lowercase (e.g. `montserrat` or `roboto`) and presses Enter or blurs the field, the input text reverts to the previously selected font name even though the font was matched in the dropdown list.
- **Root Cause Analysis:** The onBlur handler tests `!options.some(opt => opt.value === event.target.value)` using strict case-sensitive equality (`===`), while the autocomplete filtering is case-insensitive. Because `"Montserrat" !== "montserrat"`, the blur logic treats it as an invalid value and calls `setText(value)`, reverting the display.
- **Reproduction:** 1. Click the font family search field in RightPanel. 2. Type `montserrat` in all lowercase. 3. Click outside the input. Observe the text reverts to `Inter` (or previous font).
- **Recommended Engineering Fix:** Change the blur comparison to case-insensitive matching: `!options.some(opt => opt.value.toLowerCase() === event.target.value.toLowerCase())` and normalize the matched option's canonical case into state.

---

### [MEDIUM] BUG-CAP-006: Timeline Caption Tools Menu Clipped by Viewport & Obscures Audio Waveform

- **Category:** `Editor UI & Ergonomics`
- **Subsystem:** `Timeline Toolbar / Timeline.tsx`
- **File / Endpoint:** `apps/web/components/editor/timeline/Timeline.tsx` (L1935)
- **Observed Symptom:** Clicking the caption tools button on the timeline toolbar opens a long popover (`max-h-[75vh]`) directly downwards, which completely covers the audio waveform and video tracks. On standard 768p/900p displays, the bottom action buttons (Structure / Bulk resegment) overflow below the browser viewport, requiring awkward nested scrolling.
- **Root Cause Analysis:** The popover direction is hardcoded or defaults to opening downwards from the timeline toolbar, which is already situated near the bottom of the screen.
- **Reproduction:** 1. In the timeline toolbar, click the sliders icon (`[data-testid="timeline-caption-tools-trigger"]`). 2. Observe the popover covers the waveform below and its bottom buttons are clipped offscreen.
- **Recommended Engineering Fix:** Set popover `side="top"` or `align="start"` with automatic collision boundary detection so it expands upwards into the canvas/preview area with adequate headroom, and constrain its internal max-height.

---

### [LOW] BUG-CAP-007: Base Typography Underline Toggle Doesn't Reflect or Clear Emphasis Preset Underline State

- **Category:** `Editor Styling & State`
- **Subsystem:** `RightPanel Typography & Emphasis`
- **File / Endpoint:** `apps/web/components/editor/panels/RightPanel.tsx` (L947)
- **Observed Symptom:** When an emphasis preset with underline styling is applied to words, the base typography Underline toggle button in the Text tab shows unpressed state (`aria-pressed="false"`). Clicking it adds a redundant underline property to the base style rather than toggling or overriding the active word's underline styling.
- **Root Cause Analysis:** Base typography state (`typography.underline`) and emphasis style state (`emphasis.style.underline`) are managed as independent style layers without a unified computed style inspector indicator.
- **Reproduction:** 1. Apply a style preset that underlines active/emphasized words. 2. Inspect the Underline toggle button in RightPanel. Note it is inactive. 3. Toggle it on and off; active word underline remains unchanged.
- **Recommended Engineering Fix:** Compute effective style state including active emphasis overrides, and display a partial/override state on the underline toggle button.

---

### [LOW] BUG-CAP-008: ASS Subtitle Export Option Hard-Disabled in Export Modal

- **Category:** `Export & Interoperability`
- **Subsystem:** `Export Dialog / SubtitlesTab.tsx`
- **File / Endpoint:** `apps/web/components/editor/export/SubtitlesTab.tsx`
- **Observed Symptom:** Subtitles tab in the Export dialog displays "Advanced SubStation Alpha (ASS)" as permanently disabled with copy "ASS export ships once @montaj/ass-exporter lands." Editors needing styled captions for VLC or Aegisub cannot export ASS format.
- **Root Cause Analysis:** `@montaj/ass-exporter` package was stubbed or planned as a future work package and disabled in the UI pending library completion.
- **Reproduction:** 1. Click Export in top bar. 2. Select Subtitles tab. 3. Note ASS radio button is disabled (`disabled={true}`).
- **Recommended Engineering Fix:** Implement ASS generation using the existing `@montaj/render-core` styles projection or remove the placeholder until ready.

---

### [HIGH] BUG-CAP-009: Hardcoded Production Host aksharo-api.crestmondtechnologies.com Returning 401 in Dev/Local Environment

- **Category:** `API & Environment Configuration`
- **Subsystem:** `EDG Client & Network Layer`
- **File / Endpoint:** `apps/web/lib/edg/client.ts` / `apps/web/lib/api.ts`
- **Observed Symptom:** Network inspector in browser shows `GET https://aksharo-api.crestmondtechnologies.com/projects/01M2K1R52AANE4TH9RS5VH167D/edg` failing with HTTP 401 Unauthorized during editor session on `http://127.0.0.1:3914`.
- **Root Cause Analysis:** The API client base URL is falling back to the production API domain `https://aksharo-api.crestmondtechnologies.com` instead of honoring `NEXT_PUBLIC_API_URL=http://127.0.0.1:3913` or local environment variables when making direct client-side fetch requests for EDG state. Because session tokens are minted locally on `127.0.0.1:3913`, sending them to production fails with 401 Unauthorized.
- **Reproduction:** 1. Load `http://127.0.0.1:3914/p/{id}` with local session cookies. 2. Inspect Network console. Observe 401 error to `aksharo-api.crestmondtechnologies.com`.
- **Recommended Engineering Fix:** Ensure all EDG endpoints use `process.env.NEXT_PUBLIC_API_URL` or a relative `/api/proxy` route so requests are correctly routed to the active local API server in development.

