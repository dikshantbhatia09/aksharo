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
