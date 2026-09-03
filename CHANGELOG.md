# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries are grouped by work package id (see `docs/PLAN.md`).

## [Unreleased]

- **M18: `gate-a.spec.ts` green deterministically on chromium — harness mode
  confirmed, and the real tile blocker M14/M16 left open.**
  - **Harness mode ruling:** mode A (no workers; `internal-callback.ts`'s
    signed completion callback drives `media.probe`/`media.proxy`/
    transcription/subtitle-render/video-render) was already the spec's own
    design — `docs/PLAN.md`'s "one journey test" convention `upload.spec.ts` /
    `editor-fixtures.ts` already use. The "assert queued, then complete"
    tension GATE-B-CHECKLIST's run notes flagged was never a harness
    ambiguity: `playwright.config.ts`'s `webServer` only starts `api`/`web`,
    so nothing but this spec's own `completeJobForTest` calls ever consume
    its jobs — running gate-a against a stack with `worker-media`/
    `worker-ai`/`render` alive (as several earlier Gate B attempts did) is
    what raced the `probeJob` assertion, not the spec. No harness change was
    needed; only documenting the rule below.
  - **Tile blocker root cause (not a coach mark, and not off-screen
    virtualisation):** `style-picker-tile-punch-pop` really was "visible,
    enabled and stable" by Playwright's own actionability checks, and still
    unclickable — instrumenting the failing run (`getBoundingClientRect` +
    `elementFromPoint` at the tile's own centre, dumped from a temporary
    debug copy of the spec, deleted after use) showed the tile's box at
    `{width: 144, height: 2}`, positioned over the **timeline canvas**, not
    the style panel. The editor's timeline row
    (`apps/web/app/(app)/p/[id]/editor-client.tsx`,
    `data-testid="editor-timeline-row"`) had no height cap: `Timeline.tsx`
    sizes its canvas to `laneTops.totalHeight` (more pass types / protected
    ranges = taller), and that row sat in `editor-root`'s fixed
    `h-[calc(100dvh-3.5rem)]` flex column with no `max-h`, so it took
    whatever it wanted and the `flex min-h-0 flex-1` row above it — transcript,
    canvas preview and the style picker — got only what was left. On a fresh
    signup's journey (a split segment turns the reflow banner on, adding
    another ~56px of header) that left ~228px for the whole row on a
    1280x720 viewport, and `StylePicker.tsx`'s grid (`min-h-0 flex-1
overflow-y-auto`) collapsed to 0px: CSS Grid's automatic minimum size for
    a track is 0 (not its content size) once a grid item sets
    `overflow: hidden`, which every tile button does. Every tile rendered at
    ~2px, occupying whatever the collapsed grid track gave it, well outside
    the panel's own visible box. Real users on an ordinary laptop-height
    viewport with a lane-heavy timeline (or mid-reflow-prompt, exactly gate-a's
    own sequence) hit the identical collapse — this was a genuine
    responsiveness defect in the editor layout, not a test artefact.
  - **Fix:** `editor-timeline-row` gained `max-h-[38dvh] shrink-0
overflow-y-auto` (the row scrolls its own lanes past that budget instead
    of shrinking its siblings to nothing), and the content row above it
    (`flex min-h-[220px] flex-1`) gained an explicit floor so it can never be
    squeezed to zero even on a shorter viewport. `apps/web/components/editor/
panels/StylePicker.tsx` and `RightPanel.tsx` were read end to end and are
    correct as written — the defect was purely in the layout budget one level
    up, in `editor-client.tsx`.
  - **Second, unrelated fixture drift found past the layout fix:** with the
    tile now clickable, the journey reached its browser-export eligibility
    check and failed there — `mode: "auto"` now returned `"cloud"`, not
    `"browser"`. Root cause: merging current `main` pulled in the A19c ruling
    (`decision.ts`'s `softwareEncoderAboveHd`, already reflected in
    `export.spec.ts`'s own comments) that routes `auto` at 1080p-and-up to
    the cloud whenever the client does not report `capabilities.
hardwareEncoder`. `gate-a.spec.ts`'s capabilities payload for this step
    predates that ruling and never set the field, so every `auto` request —
    real headless Chromium included — now gets `cloud` regardless of
    eligibility. Fixed by adding `hardwareEncoder: true` to that payload,
    matching the step's own documented intent ("the same decision the
    dialog's click would have gotten" on a real desktop Chrome, most of
    which do report one).
  - **Verification:** `gate-a.spec.ts` chromium 3/3 green, `export.spec.ts`
    2/2 green, `timeline.spec.ts` 10/10 green (1 flaky axe-scan retry,
    pre-existing per `GATE-B-CHECKLIST.md` run 5's own note, unrelated to
    this change) — see this package's final report for the exact result
    lines.

- **M19: `scripts/local-ai-smoke.mjs` now derives its target database from
  `DATABASE_URL` instead of a hardcoded `montaj_m15`.** The script's `docker
exec psql` calls used a literal `montaj_m15`, so a run from any other
  worktree seeded credits into the wrong database and hit an FK violation on
  `credit_accounts.workspace_id`. New `scripts/lib/db-url.mjs` exports
  `parseDatabaseName(url)`, which parses the database name out of a
  `postgresql://`/`postgres://` connection string and throws a clear error
  if `DATABASE_URL` is unset, invalid, or has no path segment; the smoke
  script now calls it against the loaded `.env`'s `DATABASE_URL`. Covered by
  `scripts/lib/db-url.test.mjs` (`node:test`). The Redis key prefix
  (`MONTAJ_REDIS_PREFIX`) was already read from the environment with no
  hardcoded fallback beyond the shared default, so no change was needed
  there. Verified with a real dry run of `node scripts/local-ai-smoke.mjs`
  against `montaj_m19` (API + worker-media + worker-ai + render running from
  the M19 worktree): full sign-up/transcribe/export cycle passed, and the
  `psql` calls it made along the way targeted `montaj_m19`, not `montaj_m15`.

- **M16: first-run coach marks intercepted the editor's own click targets
  (gate-a blocker after M14).** Root cause: `FirstRunCoachMarks`
  (`apps/web/components/editor/coach-marks/FirstRunCoachMarks.tsx`) rendered
  its floating callout as a plain positioned box with no `pointer-events`
  handling. Each step is placed off the target's own `getBoundingClientRect()`
  (`data-coach-mark="transcript|style|export"`, marked by
  `editor-client.tsx`), and for a panel docked at the viewport edge — the
  "style" step's right-hand panel has nowhere to put a 288px-wide box beside
  it — the callout ends up sitting on top of the very panel it names, fully
  clickable, so it swallows the click a real user (or `gate-a.spec.ts`) makes
  on the panel underneath. M10's `installCoachMarkAutoDismiss` fixture
  (`e2e/fixtures.ts`) papered over this for specs that reach the editor before
  the mark renders, but M14 confirmed it still blocked the journey — the
  fixture cannot out-race a mark whose wrapper stays fully interactive for as
  long as it is mounted.
  - **Fix:** the callout (`role="dialog"`, `data-testid="coach-mark"`) is now
    `pointer-events: none` by default — a click anywhere on its body passes
    through to whatever is really there — with `pointer-events: auto`
    re-enabled only on the Skip/Next control row, so the mark's own buttons
    stay clickable. Applied as both the `pointer-events-none`/
    `pointer-events-auto` Tailwind utilities and matching inline styles (the
    inline styles are what make the behavior testable and correct without
    depending on the Tailwind build being present). The component already
    unmounts entirely (`return null`) once dismissed or once every step is
    shown, so there is no leftover overlay after dismissal — confirmed by a
    new test that asserts no `.fixed` node remains in the DOM. No change to
    when or how a mark is shown, its copy, or the dismiss/advance logic.
  - **Tests:** `apps/web/components/editor/coach-marks/FirstRunCoachMarks.test.tsx`
    (new) — a click on the target element the "style" step's callout overlaps
    now reaches its `onClick` (regression: failed before the fix, the click
    landed on the callout and never fired); the mark and its Skip control have
    the right `pointerEvents`; Skip and the mark's own controls stay clickable;
    the mark is absent once every step is already dismissed
    (`onboarding.coachMarksShownAt` set) and unmounts with no stray fixed/
    absolute node once dismissed interactively.
  - **Fixture hardening:** `installCoachMarkAutoDismiss` now waits for the
    mark's own Skip control to be visible before clicking it, rather than
    clicking as soon as the wrapper (`data-testid="coach-mark"`) is detected —
    the wrapper's own `role="dialog"` node can attach a render before the
    `useEffect` that measures the target's rect has run, so the control inside
    it was not always there yet. Kept, though with the pointer-events fix it
    is no longer load-bearing for correctness — only a convenience so specs
    that assert on hidden state don't have to skip the mark themselves.
  - **`gate-a.spec.ts`:** the style-picker click this WP was opened to unblock
    is fixed at the component level (see above); the fixture and mark's own
    behavior are covered by the new component test. The spec's own end-to-end
    run could not be completed on this host: `next build` for `apps/web`
    fails deterministically (`Error: <Html> should not be imported outside of
pages/_document`, prerendering the auto-generated `/404` page, tracing
    through `StyleGallery.tsx` → `@montaj/render-core` → `harfbuzzjs`'s
    top-level-await chunk) — reproduced identically from a from-scratch
    `next build` on a pristine `main` checkout (`_worktrees/main`, HEAD
    `92392d9`), so it is a pre-existing, host-level build defect unrelated to
    this WP's diff (`apps/web/components/editor/coach-marks/**`,
    `apps/web/e2e/fixtures.ts` only) and outside this WP's file boundaries to
    fix. `pnpm typecheck`/`eslint` (which do not require a production build)
    are clean on the changed files; the new component test is green. See the
    final report for the full incident note on the `main`-worktree
    reproduction attempt.
- **M14: realtime op self-echo showed a bogus "someone else edited this
  word" conflict right after the editor's own edit.** Root cause:
  `EdgOpQueue.absorbRemoteOps` (`apps/web/lib/edg/queue.ts`) rebased every
  incoming realtime `edg.ops` event against the queue's still-`pending` ops
  with no notion of who produced it — including the client's own
  just-submitted batch, echoed back over the socket to every room member
  (sender included, by design; `apps/api/src/edg/edg.service.ts`'s "The
  realtime echo" comment). That self-echo typically beats the batch's own
  HTTP response back to the same client, so it was still `pending` when the
  echo arrived, got rebased against itself, and `rebaseOps` reported a
  same-word conflict whose `yours`/`theirs` were the identical text of the
  one edit the user actually made (`gate-a.spec.ts`'s repro: the dialog pops
  right after the first word edit and blocks the next click). `EdgOpsEvent`'s
  `source` field (CONTRACTS §7, "so an editor can ignore its own echo") turns
  out to be the wrong granularity for this — it names the write-path kind
  (`web`/`desktop`/`worker`), not a per-session identity, so it cannot tell
  one browser tab's echo from another's genuine edit. `opId`, already unique
  per op and already carried on the wire, is the real origin tag.
  - **Fix:** `EdgOpQueue` now tracks every `opId` this client has minted
    (`submittedOpIds`) and `absorbRemoteOps` filters them out of an incoming
    batch before rebasing — whether the echo arrives while the op is still
    pending (the common race) or after it already landed (an out-of-order
    echo, by which point it's simply gone from `pending` and the filter is a
    no-op). `EditorStore`'s and `EdgOpQueue`'s own idempotency-by-`opId`
    (already documented, `packages/edg/README.md` "Idempotency") were correct
    all along — only the _queue_'s local rebase step was missing the same
    check. As a second line of defense, `dropIdenticalConflicts` now filters
    any conflict (server-reported or locally rebased) whose `yours` and
    `theirs` text are identical before it reaches `onConflict` — nothing to
    choose between, so it auto-resolves silently rather than surfacing a
    dialog that would read as a bug even for a case this opId filter did not
    anticipate. No API/schema change: the fix is entirely in
    `apps/web/lib/edg/queue.ts`.
  - **Tests:** `apps/web/lib/edg/queue.test.ts` — self-echo of a pending op
    (no conflict, no rebase), an out-of-order echo of an already-confirmed op
    (no-op), and identical-text auto-resolve, alongside the pre-existing
    genuine-remote-conflict case (kept, still asserts `yours`/`theirs` differ).
    `apps/web/lib/edg/store.test.ts` — the same self-echo scenario through
    `EditorStore.absorbRemoteOps`, and a genuine two-session same-word
    conflict still raising the chooser with different texts. Verified the
    fix reverts the bug: with `queue.ts` stashed back to `main`, the new
    self-echo test fails with `{yours: "mine", theirs: "mine"}` — the exact
    bogus-identical-text conflict `gate-a.spec.ts` hit.
  - **e2e:** `gate-a.spec.ts` (chromium): the word-edit step this bug used to
    block (`chip.press("Enter")` through `editor-pending-count` reaching
    `"0"`) now passes clean with no conflict dialog, confirmed over two full
    runs against a freshly seeded `montaj_m14` database. The spec's full
    run is separately blocked by two pre-existing, out-of-scope issues hit
    while chasing it green end to end, both outside this WP's file
    boundaries and unrelated to realtime ops: (1) `montaj_m14` had never been
    seeded (`workspace/plans_missing`, fixed by running the worktree's own
    `db:seed` — an environment gap, not a code defect) and (2) a
    `data-coach-mark="style"` wrapper (`FirstRunCoachMarks`,
    `components/editor/coach-marks/`) intercepts the style-picker click
    later in the journey — `e2e/fixtures.ts`'s own
    `installCoachMarkAutoDismiss` comment already documents this as a known
    gap ("No spec dismisses it today"). Neither touches `apps/web/lib/edg/**`
    or the realtime path this WP owns.
- **M10: Gate B defects (Docker build, streak widget, timeline drag, audit
  completeness).**
  - Item 0 (blocking): `docker compose -f docker-compose.test.yml build render
worker-media worker-ai` failed building `render` — no `.dockerignore`/
    `Dockerfile.dockerignore` for `apps/render` meant the build context
    included the host's own `node_modules`, whose `pnpm`-created symlinks are
    absolute host paths on Windows (e.g. `packages/config/node_modules/
typescript -> C:\...\node_modules\.pnpm\typescript@5.9.3\...`); `COPY
packages/config ./packages/config` (and the other package COPYs)
    overwrote the image's own correctly-linked `node_modules` with those
    broken absolute symlinks, so `tsc` (and anything else resolved through a
    workspace package) failed `MODULE_NOT_FOUND` inside the container. Added
    `apps/render/Dockerfile.dockerignore` (mirrors `apps/worker-media`'s).
    Three further build breaks surfaced once that was fixed and are fixed in
    the same Dockerfile: `pnpm deploy`'s `--legacy` flag does not exist in
    pnpm 9.x (`Unknown option: 'legacy'`); `pnpm deploy` rejects a filter
    matching more than one project (`@montaj/render...` for build, `@montaj/
render` alone for deploy); and `pnpm deploy`'s workspace validation
    needs `@montaj/fonts`/`@montaj/render-canvaskit` (devDependencies-only,
    tooling) present in the workspace manifest set, but building them (no
    source was copied for either) then had to be excluded from the build
    filter. Proven with a real `docker compose -p montaj-m10 -f
docker-compose.test.yml build render worker-media worker-ai` (all three
    built), then removed with `--rmi local`.
  - Item 1: the streak widget never mounted on `/billing` because
    `apps/web/components/billing/overview-panel.tsx` read the flag under the
    key `"streak.enabled"`, which nothing ever sets — every other reader
    (`shell/sidebar.tsx`, `streak-chip.tsx`) reads `"growth.streakWidget"`.
    Fixed to the correct key; added two `<OverviewPanel />` unit tests
    (mounts with the flag on, never mounts with it off) and confirmed
    `streak.spec.ts` 3/3 on chromium.
  - Item 2: dragging a proposed cut item's edge on the timeline never landed
    (`timeline.spec.ts` B20b case). Two real defects, both fixed:
    (a) `apps/web/lib/timeline/pass-item-drag.ts`'s `clampPassItemEdge` never
    rounded `pxToMs`'s fractional-millisecond output, so the API 400'd
    (`common/validation_failed`, "endMs: expected int, received number");
    now rounds to the nearest ms before clamping. (b)
    `apps/api/src/edg/edg.working-set.ts`'s `analyseWorkingSet` had no case
    for `EditPassItem`, so the target item's row was never loaded into the
    op-apply working set and every `EditPassItem` op was rejected
    `unknown-id` regardless of whether the item existed; added the missing
    case. `timeline.spec.ts` 10/10 on chromium after both fixes (one run
    flaked on the pre-existing axe-violations case's login timeout under
    host load, passed on Playwright's own retry).
  - Item 3: `export.spec.ts`'s harness-driven test always timed out at
    `page.waitForFunction(() => window.__exportHarness?.ready === true)`
    (60s, "check H-19 host throughput vs. real defect" per Gate B run 4) —
    not throughput: `apps/web/next.config.ts`'s CSP `script-src` had
    `'unsafe-inline'` but no `'wasm-unsafe-eval'`, so Chrome refused to
    compile CanvasKit's wasm (`Aborted(CompileError...)`) and the
    renderer — every editor route's, including the harness's — never
    initialised; `ready` was never set regardless of the host. Fixed by
    adding `'wasm-unsafe-eval'` (not the broader `'unsafe-eval'`, which
    would also permit plain JS `eval`). The dialog-driven test
    (`drives the real export dialog...`) failed separately: it imported
    `test`/`expect` from `@playwright/test` directly rather than
    `./fixtures`, so it never got `fixtures.ts`'s auto-dismiss for
    `WhatsNewModal`, whose overlay blocked the click on the real dialog's
    Export button; fixed by importing from `./fixtures` like every other
    spec. Both `export.spec.ts` cases pass on chromium after both fixes.
  - Item 4: `gate-a.spec.ts`'s cloud-render journey failed at
    `expect(probeJob).toBeDefined()` (Gate B run 4) because zero bytes of
    the uploaded sample ever reached storage: the browser's raw-media
    upload `PUT`s go straight to `S3_ENDPOINT` (CONTRACTS §6, bypassing
    the API), and in dev/e2e that is a plain `http://localhost:9000`,
    which `connect-src` never listed — every such `PUT` was silently
    CSP-blocked, so no `media.probe` job was ever created. Fixed the same
    way `API_ORIGIN` already was: `S3_ENDPOINT` added to `connect-src`.
    Reproduced with `apps/worker-media` and `apps/render` running
    (`node --env-file=../../.env dist/index.js`); `apps/worker-ai`'s
    Python startup was not additionally exercised — the spec itself settles
    every job through the signed internal callback rather than a live
    worker, by its own header note, and running real workers turned out to
    be actively harmful here (below), so a third component racing the same
    queues would only add noise.
    Third defect, found while chasing the residual flakiness: `.env`
    (copied from `main` per setup) carries `MONTAJ_QUEUE_PREFIX=bull` —
    BullMQ's own default, used unchanged by every work package's worktree on
    this shared Redis instance. Every concurrent work package's
    `apps/worker-media`/`apps/render` therefore listens on the exact same
    `media.probe`/`media.proxy`/`render.*` queues regardless of which
    worktree or database enqueued a job — so as soon as `apps/worker-media`
    was started (per this item's own instruction), it (or, once M10's own
    was stopped, another work package's own worker still running on the
    same shared host) raced gate-a.spec.ts's `GET /jobs?status=queued`
    check and had already finished the job by the time the assertion ran,
    reproducing `expect(probeJob).toBeDefined()` failing even with every
    CSP fix in place. `jobs.config.ts`'s own doc comment names exactly this
    escape hatch ("a parallel test run can isolate a Redis instance shared
    with other work"); set `MONTAJ_QUEUE_PREFIX=montaj-m10` in this
    worktree's `.env` (gitignored, not a code change) and the `probeJob`
    failure stopped reproducing across every subsequent run.
    With all three fixes (CSP wasm, CSP S3 upload, coach-mark dismiss) plus
    the queue-prefix isolation, the journey deterministically clears
    sign-up, upload, transcription and the first editor edits (word edit,
    segment split, script switch) every run — several minutes further than
    any prior Gate B run, and no longer flaky at the point it used to fail.
    It now stops at a **fourth, distinct defect**, out of this item's
    original four-defect scope: right after the word-edit step, a
    `data-testid="realtime-conflict"`-shaped dialog ("Someone else edited
    this word at the same time... Yours: namastey / Theirs: namastey" — both
    sides showing the _same_ text) covers the right panel and blocks the
    next click (`style-picker-tile-punch-pop`). Both versions being
    identical text strongly suggests the realtime client is receiving its
    _own_ just-submitted op back over the websocket and mistaking it for a
    concurrent remote edit rather than recognising its own actor/session —
    an EDG realtime-sync issue, not a CSP or queue-isolation one. Not fixed
    in this pass: it sits underneath a different subsystem than this item's
    other three findings, was only reachable once they were fixed, and
    warrants its own root-cause pass rather than a guess under this
    package's time budget — left for a follow-up work package with the
    reproduction above.
  - Item 5 (added mid-package): `audit-completeness.test.ts` failed on `main`
    after D07 merged — `apps/api/src/prompted-edits/prompted-edits.
controller.ts`'s `create`/`run` routes had no audit-writer reference, and
    (a pre-existing, unrelated defect the same test already caught)
    `apps/api/src/passes/passes.controller.ts`'s six `start*` routes had
    none either. Both now write `CommonAuditService.record(...)` rows
    (`prompted_edit.plan.created`/`prompted_edit.plan.run`;
    `pass.<kind>.started`); new unit tests for both controllers assert the
    audit call on every mutating route. Neither file was added to
    `EXEMPT_FILES`.
- **M13: autocut — protection survives merge/bridge; zero-width protected
  ranges are illegal.** `apps/worker-ai/worker_ai/passes/autocut.py`'s
  `run_autocut` re-applies `_apply_protection` after `_merge_overlaps` and
  again after `_bridge_short_kept_segments`: either step can combine two cut
  candidates that individually cleared a protected range into one that newly
  swallows it (found via `test_items_respect_protected_ranges`, a Hypothesis
  property test, failing with a merged filler-run candidate straddling a
  legal 1ms protected range). Separately, `packages/edg/src/ops/apply.ts`
  already rejects `SetProtectedRanges` ranges with `s >= e` as
  `invalid-range` — protected ranges are half-open `[s, e)` with `e > s`, so
  a zero-width range can never reach the worker from the engine — so
  `tests/test_autocut.py`'s `_random_transcript` strategy no longer generates
  one; a regression `@example` and a `packages/edg` unit test cover the
  smallest legal 1ms range.
- **M11: pass follow-ups — auto beat-alignment for music beds, LLM sentiment
  through the B11 seam, prompted-edit chain retry-from-partial-failure.**
  - **Auto beat-alignment (D05 follow-up):** `apps/worker-ai/worker_ai/passes/
music/beats.py` (new) mirrors `packages/timemap/src/beats.ts`'s
    `alignCutBoundariesToBeats` on the Python side (same ±120 ms
    `DEFAULT_BEAT_SNAP_TOLERANCE_MS`); `build_music_items` (`placement.py`)
    snaps a bed's `start_ms` to the nearest beat of the section's `bpm_target`
    whenever the resolved `loop_policy != "none"` (on by default,
    `align_to_beat=True`), never landing inside a protected range — a
    `loopPolicy: "none"` bed, or a snap that would violate tolerance or a
    protected range, is left at its raw section boundary. New placement-level
    tests (`tests/test_music_pass.py`) cover snapping, the `"none"`-policy
    skip, the protected-range refusal and the `align_to_beat=False` opt-out.
  - **LLM sentiment (D05 follow-up):** `packages/prompts` gains the
    `music-mood@1` template (`templates/music-mood.ts`, registry entry,
    per-fixture eval in `eval/music-mood.eval.test.ts` against a deterministic
    mock scorer) and its Python mirror (`worker_ai/llm/templates.py`,
    `schemas.py`, `providers/mock.py`). `worker_ai/passes/music/sentiment.py`
    (new) scores transcript sentences through B11's LLM client seam
    (`generate_insight`), falling back to the old lexicon scorer — ported
    from `apps/api`'s now-removed `sentimentCuesOf` stub — on any provider
    failure or region block; every `Section` (`analysis.py`) carries an
    explicit `sentiment_source: "lexicon" | "llm"`. `apps/api/src/passes/
passes.service.ts`'s `startMusic` now ships raw `sentences` (plus
    `language`/`region`) instead of a precomputed score, matching CONTRACTS'
    "all AI runs in apps/worker-ai" — the real Anthropic/OpenAI client path is
    type-checked only (no `ANTHROPIC_API_KEY` on this machine); tests run
    against the mock provider and the lexicon fallback.
  - **Chain retry (D07 follow-up):** `POST /projects/{id}/prompted-edits/
{planId}/retry` (`prompted-edits.controller.ts`, minimal addition —
    `passes/prompted-chain.ts`'s `fail()` now keeps `currentJobId` and the
    credit hold on a chain step's failure instead of releasing them, so a
    retry has a job to identify the failed kind from and a hold to reuse) —
    re-enqueues the failed pass kind with no new `CreditHold` (`skipCredits:
true`, same as any other chain-internal step), keeps every completed kind
    done and every kind still in `remainingKinds` ahead of it, audit-written
    via `CommonAuditService` (`prompted_edit.plan.retried`). Dedup collision
    with an in-flight manual pass of the same kind is handled by the existing
    `JobsService.enqueue` job-key dedup (retry attaches to the live job
    rather than starting a second one) — proven by a unit test in
    `prompted-edits.service.test.ts`; the full fail -> retry -> complete path
    is proven end to end in `apps/api/test/prompted-edits.e2e-spec.ts`.

- **D04b: partner catalogue integration (contract-gated) — H-28 open, plumbing
  built dark behind `assets.partnerCatalogue` (default off).**
  - `apps/api/src/partner-catalogue/**`: the `PartnerCatalogue` interface
    (`search`/`stream`/`grant`/`reportUsage`/`revoke`), `MockPartnerCatalogue`
    (in-memory fixtures shaped after Epidemic Sound's public Partner API
    field names — no real partner data, never seeded), and
    `EpidemicPartnerCatalogue`, a skeleton that throws the H-28 contract-gate
    error (`partner-catalogue/contract_gate`) on every method until
    `EPIDEMIC_PARTNER_API_KEY`/`EPIDEMIC_PARTNER_API_SECRET` are set.
    `PartnerCatalogueService` gates every call on `assets.partnerCatalogue`
    (`FEATURE_FLAGS_JSON`, default off) and persists grants to
    `asset_clearance_grants` with a `licenceSnapshot` carrying a
    `TODO(H-28)` placeholder sentinel until the contract signs
    (`licence-snapshot.ts`).
  - `apps/api/prisma`: `asset_clearance_grants` gains `asset_id`,
    `use_context`, `licence_snapshot` columns (migration
    `20260903150000_d04b_partner_catalogue_grants`) — the existing D04a
    grant/usage tables (`asset_clearance_grants`, `asset_usages`) are reused
    rather than duplicated.
  - `apps/api/src/audio-assets/asset-allowed.ts`: the licence predicate gains
    `partnerCatalogueEnabled` (defaults to refuse) and the
    `partner-catalogue-disabled` reason — every non-`owned` asset is refused
    on every surface, cloud render included, while the flag is off; proven
    with property tests.
  - `apps/api/src/exports/decision.ts`: `hasPartnerCatalogueAssets` refuses
    the browser export path unconditionally (D43: partner assets are
    cloud-render-only), with `export/unsupported_in_browser` for an explicit
    browser request.
  - `apps/api/src/scheduler/tasks/partner-grant-expiry.task.ts` (hourly) and
    `partner-usage-report-retry.task.ts` (every 15 min): grant expiry and the
    B16 usage-report retry sweep, both idempotent and fake-clock-tested.
  - Tests: interface contract tests against the mock (11), H-28 contract-gate
    tests against the real adapter skeleton (9), licence-snapshot placeholder
    tests (3), service unit tests (8), scheduler task tests (9), an e2e spec
    against a real Postgres proving flag-off refusal / grant persistence /
    expiry (4), plus new `decision.ts` (6) and `asset-allowed.ts` (3)
    property/unit tests. Not built in this pass: an HTTP surface for
    search/grant/revoke, the B13 admin grants table, the Passes-tab D43
    badge, and render-time grant fetch — see the work package's final report
    for the full list and reasoning.

- **D04b2: partner catalogue wiring — HTTP surface, pass wiring, usage
  emission, render grant check, admin table, web badge (still behind
  `assets.partnerCatalogue`, H-28 still open).**
  - `apps/api/src/partner-catalogue/partner-catalogue.controller.ts` (new):
    `GET /partner-catalogue/search`, `POST /partner-catalogue/grants`,
    `DELETE /partner-catalogue/grants/{grantId}` — workspace-member-gated,
    rate-limited, and every route 404s (not 403) while the flag is off, so
    the feature stays invisible rather than merely refusing. Grant
    create/revoke are audit-logged (`partner_catalogue.grant.created` /
    `.revoked`). `apps/api/src/partner-catalogue/partner-catalogue.dto.ts`
    (new) carries the zod request/response schemas.
  - `apps/api/src/partner-catalogue/internal-partner-grant.controller.ts`
    (new): `POST /internal/partner-catalogue/verify-grant`, signed like
    every other worker → API callback (`InternalSignatureGuard`) —
    `apps/render`'s pre-download check. `PartnerCatalogueService.
verifyActiveGrant` looks the grant up by `partnerUserId` (a partner grant
    carries no local `AudioAsset` row) and is `false` while the flag is off.
  - `apps/api/src/passes/partner-catalogue-items.ts` (new) +
    `passes.service.ts`: `sfxCatalogueOf`/`musicCatalogueOf` now append
    mock/partner catalogue hits (via `PartnerCatalogueService.search`) only
    while the flag is on, mapped through a pure, unit-tested bridge
    (`partnerHitsToSfxRows`/`partnerHitsToMusicRows`) — a partner row is
    tagged `id: "partner:<providerAssetId>"`, `packId: "partner-catalogue"`,
    and `licenceSnapshot.partner: true`. A partner-search failure never
    fails the whole pass; the local catalogue is unaffected either way.
  - `apps/api/src/partner-catalogue/usage-emission.ts` (new) +
    `apps/api/src/exports/render-completion.handler.ts`: on
    `render.video` completion, `reportPartnerUsageForExport` stamps every
    not-yet-exported `AssetUsage` row carrying a `clearanceGrantId` onto
    this export (`exportId`/`exportedAt`) and reports it through
    `PartnerCatalogueService.reportUsage`, before the report call so a
    crash mid-report leaves exactly the row shape
    `PartnerUsageReportRetryTask.sweep()` already picks up — no change to
    that task was needed.
  - `apps/render/src/render/partner-grant.ts` (new) + `pipeline.ts` +
    `callbacks.ts` + `processors/render-video.ts`: before downloading any
    `sfx`/`music` track whose `packId` is the `"partner-catalogue"`
    sentinel, `renderVideo` calls `CallbackClient.verifyPartnerGrant`
    (signed, no retry) and throws rather than downloading when it does not
    resolve to an explicit `{ allowed: true }` — fails closed on a
    transport error, a non-2xx status, an unparseable body, or no verifier
    configured at all.
  - `apps/api/src/admin/partner-catalogue/admin-partner-catalogue.
controller.ts` (new) + `PartnerCatalogueService.listGrants`/`adminRevoke`:
    `GET /admin/partner-catalogue/grants` and
    `POST /admin/partner-catalogue/grants/{id}/revoke`, gated by
    `AdminGuard` alone (no named owning role yet) and working even while
    the flag is off for that workspace, so staff can always see and revoke
    what a workspace holds. `apps/web/app/(admin)/admin/partner-catalogue/
page.tsx` (new): the grants table (asset, workspace, use context, expiry,
    usage-report status, revoke), added to the admin nav.
  - `apps/web/components/editor/passes/ProposalCard.tsx`: a
    "Partner — cloud render only" badge for any `sfx`/`music` item whose
    `payload.licenceSnapshot.partner === true`.
  - `packages/api-client` regenerated (`pnpm gen:client`) for the three new
    public routes.
  - Tests: pass-wiring bridge unit tests (4), usage-emission unit tests
    (3), `PartnerCatalogueService.verifyActiveGrant`/`listGrants`/
    `adminRevoke` unit tests, admin controller unit tests (2),
    `CallbackClient.verifyPartnerGrant` + `assertPartnerGrantForTrack` unit
    tests (11), `ProposalCard` badge tests (4), the admin grants page
    component test (4), and a new HTTP e2e section in
    `apps/api/test/partner-catalogue.e2e-spec.ts` against a real Postgres +
    Redis: flag-off 404s on all three routes plus a 401 with no token (5),
    flag-on search/grant/revoke round-trip including audit-row assertions
    and 404s for an unknown asset/grant (7).

- **M12: one shared markdown block parser for docs + help content.**
  - `apps/web/lib/markdown/blocks.ts`: new pure `parseBlocks()` (paragraphs,
    headings h1-h3, ordered/unordered lists, fenced code, GFM pipe tables,
    blockquotes) with a documented cursor-progress invariant and a
    `fast-check` property test (`blocks.test.ts`) asserting termination and
    exactly-once line consumption for arbitrary input. Replaces the two
    hand-rolled, independently-duplicated block parsers previously in
    `apps/web/lib/docs/markdown.tsx` (X03) and `apps/web/lib/content/
markdown.tsx` (B12), which carried the identical M07 infinite-loop bug (a
    paragraph-collection loop that could match its own stop condition on its
    first line and never advance the cursor).
  - `apps/web/lib/docs/markdown.tsx` and `apps/web/lib/content/markdown.tsx`
    are now thin renderers over the shared `parseBlocks()`, keeping their
    prior, divergent inline policies unchanged (docs: no single-`*` italic,
    internal-vs-external link `target` policy for plugin-README links;
    content: single-`*` italic, no link-target policy) and their existing
    output snapshots/tests, including both files' M07 regression tests.

- **D07: prompted edits — planner, Flash/Pro engines, plan preview, chained
  passes, credits held on source minutes and settled on finished minutes.**
  - `packages/prompts`: `edit-plan@1` template (`{passes[], style?, script?,
rationale[]}`), per-kind param schemas, guardrails (`validateEditPlan`
    — only known pass kinds/params, per-plan-tier pass-count budget, `pro`
    engine tier allowlist, style must be an existing project style), 12
    prompt fixtures (English, Hindi, Tamil, Hinglish) and a deterministic
    mock planner wired into the shared eval runner (`pnpm --filter
@montaj/prompts eval`: PASS 24/24).
  - `packages/config/src/engines.ts`: Flash (VAD-only cut, 540p tracking,
    cached picks, no ASR re-pass) / Pro (LLM re-ranked cuts, full-res
    tracking, an ASR re-pass model) preset table; mirrored in Python at
    `apps/worker-ai/worker_ai/passes/engines.py`.
  - `apps/api/src/prompted-edits/**`: `POST /projects/{id}/prompted-edits`
    (plan only — calls the planner through a `PlannerClient` port, bound to
    a deterministic mock by default and to a real Anthropic client only
    when `ANTHROPIC_API_KEY` is set; re-checks guardrails server-side, never
    trusts the planner's own schema validity alone), `GET .../{planId}`,
    `POST .../{planId}/run` (holds credits on the source duration and
    starts the plan's dependency-ordered chain — autocut before zoom/
    reframe before sfx/music before textfx).
  - `apps/api/src/passes/prompted-chain.ts` (`PromptedChainAdvancer`):
    steps a running plan from each `ai.pass` completion — reusing
    `PassesService.start*` for every real per-kind payload (words, catalogue,
    protected ranges, ...) rather than duplicating it — and settles the
    plan's credit hold on the finished (post-cut) duration once the chain
    lands; wired into `PassCompletionHandler` without a circular module
    import (`PassesModule` never imports `PromptedEditsModule`).
    `PassesService` gains an additive `skipCredits`/`costOverrideTenths`
    pair on every `Start*Request` so a chain-internal pass never double-bills
    a plan that already holds its cost, plus a public `finishedDurationMs()`.
    `CreditHold.jobId` is a real, unique FK into `jobs`, so the plan's whole
    macro hold rides on the chain's first job via `costOverrideTenths`
    rather than a second `reserve()` call.
  - `apps/web`: `PromptedEditBox` (prompt textarea, Plan button, preview
    sheet — pass chips, rationale, style/script, credits hold estimate,
    Flash/Pro engine toggle that re-plans, Confirm & run, first-pass
    realtime progress) mounted on the Passes tab.
  - Tests: planner schema/guardrail unit tests, `quotePromptedEdit` credit
    math (hold-on-source/settle-on-finished, Flash vs Pro, never-more-
    than-hold), `PromptedEditsService` unit tests (guardrail rejections
    never reach the database, chain-order-not-plan-order, macro hold folded
    into the first job only), a full API e2e chain (plan → run → autocut
    completion → chain advance → music completion → settle → completed),
    Python engine-preset tests, web unit tests for the prompt box/preview
    sheet. Deviation flagged below.

- **D04e-4: music bed mixing (both engines).** `manifest.timemap.audio.
music[]` (D05's own additive field, `MusicTrackSchema`) wired into both
  mixers, on top of D04e-1/2's `sfx` cue plumbing:
  - `apps/render/src/ffmpeg/audio-mix.ts`: `buildMusicFilters` gains D05's
    own fixed fade pair (`MUSIC_FADE_IN_MS`=300, `MUSIC_FADE_OUT_MS`=800 —
    `MusicTrackSchema`'s own doc comment: "fade lengths are D05's own fixed
    constants... applied at mix time"), applied at the bed's own window
    edges the same way `buildCueFilters` fades a cue at its own edges
    (only the piece touching the real edge, when a bed is split by a cut).
    `apps/render/src/render/pipeline.ts` downloads every accepted `music`
    track's `storageKey` the same way as an `sfx` cue's, probing the
    downloaded asset (new `probe.ts#probeAudioAsset` — `probeMedia` minus
    its "must have a video stream" requirement, since a pack asset is
    audio-only) for `MusicMixCue.assetDurationMs` (needed to decide
    whether/how much `loopPolicy: "loop"` loops).
  - `apps/web/lib/export/audio-mix.ts`: `mixMusicCueIntoChunk` gains the
    identical fixed fade pair, plus `bedDuck` (the same `duckGainAt`
    trapezoid an `sfx` cue's `duck` uses) and `loopPolicy: "loop"`
    wraparound via a modulo asset-index lookup. `engine.ts` gains
    `decodeMusicCues` (mirrors `decodeSfxCues` exactly: fetch+decode once
    per distinct `assetId`, only when the manifest carries accepted music
    beds) and a `mixMusicCuesIntoChunk` call alongside the `sfx` one in the
    audio-encode loop.
  - New tests throughout: `audio-mix.test.ts` (both apps) gains fade-edge
    and `bedDuck`/loop cases; `pipeline.test.ts` gains a full download+loop
    end-to-end case; `engine.test.ts` gains `decodeMusicCues` cases
    (fetch/decode/cache, the fetchCueAsset-required error, no-beds no-op).
    Full suites green: `apps/render` 133 tests (17 in `pipeline.test.ts`
    alone), `apps/web/lib/export` 100 tests.

- **D04e-3: audio-mix envelope parity gate (`apps/render/parity`).** New
  `parity/audio-mix-fixtures.ts` (a 6-second, three-cue fixture: a "ding"
  with a 50ms fade in/out, a "whoosh" ducked -12dB under a speech range, a
  plain "pop" — the WP brief's own description), `parity/audio-mix-parity.ts`
  (50ms-window RMS-in-dBFS comparison, `computeAudioMixParity`, plus
  `cueWindowIsPresent`), and `parity/run-audio-mix-parity.ts` (renders the
  fixture through the _real_ cloud ffmpeg graph and decodes it back to PCM;
  computes a reference PCM signal from the same closed-form gain/fade/duck
  arithmetic `apps/web/lib/export/audio-mix.ts`'s `mixSfxCueIntoChunk`
  applies, ported rather than imported — apps do not import one another —
  the same convention D04c's SFX-duck gate's `browserDuckGainAt` already
  follows; the base clip and cloud output both use lossless PCM, not AAC, so
  the comparison measures the mixing math, not codec noise). Writes
  `results.json`'s `audioMix` key, merge-preserving next to `edits`/`audio`/
  `titles`/`sfx`. Max deviation ≈0.05 dB over 120 windows against the
  brief's 0.5 dB tolerance; every cue window present on both sides.
  - **A real bug found and fixed, not worked around**: the gate's first run
    measured a ~2.8 dB deviation concentrated entirely inside the "whoosh"
    cue's duck ramp. Cause: ffmpeg's `volume=eval=frame` filter recomputes
    its expression once per _frame_, not per sample — at whatever frame
    size the graph otherwise settled on, the real ramp was a coarse
    staircase rather than the smooth trapezoid the expression (and the
    browser's per-sample mixer) describe. Fixed in `apps/render/src/ffmpeg/
audio-mix.ts` by forcing a 64-sample (~1.3ms) frame with `asetnsamples`
    immediately before every duck filter (`DUCK_FRAME_SAMPLES`) — a genuine
    improvement to the cloud render's own duck-curve fidelity, not a gate-
    specific hack, and something D04c's symbolic (never-rendered) SFX-duck
    parity gate could not have caught.

- **D04e-2: browser sfx cue mixing (`apps/web/lib/export`).** Closes D04d's
  first flagged deviation, browser half. `apps/web/lib/export/audio-mix.ts`
  (module written in an earlier pass of this WP) mixes a decoded cue's
  samples directly into whichever export audio chunk overlaps it, in place
  — `engine.ts`'s audio path streams `AudioBuffer` chunks straight off
  Mediabunny's `AudioSampleSink` with no Web Audio graph at all, so there is
  no `OfflineAudioContext` to schedule an `AudioBufferSourceNode`/`GainNode`
  pair against (the WP brief assumed one exists; documented as a deviation
  in `audio-mix.ts`'s own doc comment rather than silently built anyway).
  Wired into `engine.ts`: `RunExportOptions` gains `fetchCueAsset` (the
  D04d signed-URL hook) and `decodeCueAsset` (defaults to a scratch
  `AudioContext`'s `decodeAudioData`, injectable for tests); new
  `decodeSfxCues` fetches+decodes each distinct `assetId` once (cached),
  eagerly and only when the manifest actually carries accepted `sfx`
  cues — no `fetchCueAsset` needed otherwise, same "pay for what you use"
  shape the watermark/clean-audio paths already follow. The audio-encode
  loop now tracks a running _output_-clock position across every chunk of
  every retained range (distinct from `applySpliceFades`'s per-range
  `elapsedMs`) and calls `mixSfxCuesIntoChunk` before each chunk is added
  to the output. New tests: `decodeSfxCues` (fetch/decode/cache, the
  fetchCueAsset-required error, no-cues no-op) in `engine.test.ts`; the
  mixer itself (`audio-mix.test.ts`, synthetic `AudioBuffer`s, no network,
  including a cue split across a cut via `@montaj/timemap`'s `mapRange`).

- **D04e-1: cloud sfx cue mixing (`apps/render`).** Closes D04d's first
  flagged deviation, cloud half. New `apps/render/src/ffmpeg/audio-mix.ts`:
  `speechRangesFromWords` (duplicated from `apps/api/src/passes/
passes.service.ts`'s helper of the same shape — apps do not import one
  another), `buildCueFilters`/`buildMusicFilters` (one ffmpeg filter chain
  per accepted `sfx`/`music` item: `atrim`/`asetpts` → static `volume` for
  the item's own `gainDb` → `afade` in/out at the item's own edges (not at
  an internal cut split) → `adelay` to the item's _output_-clock start via
  `@montaj/timemap`'s `mapRange` — the same cuts/ripples remap B20's crop
  keyframes and D06b's titles already get — → an `eval=frame` `volume`
  duck expression (`sfx-duck-expr.ts`'s closed form) when the item carries
  a `duck`/`bedDuck` curve), and `buildAudioMixPlan` (assigns each cue its
  own extra ffmpeg input, `amix`es every cue/music label with the existing
  dialogue bus, or with an `anullsrc` bed when there is no dialogue track
  at all). Wired into `ffmpeg/graph.ts` (`GraphInput` gains `sfxCues`/
  `musicCues`/`speechRanges`/`timemap`; a cue mix disables the passthrough
  `-c:a copy` fast path, same as any other edit) and `render/pipeline.ts`
  (downloads every accepted `sfx` track's `storageKey` from the derived
  bucket to the job's scratch dir, derives `speechRanges` from
  `payload.projection.words`). Unit tests on the filter strings
  (`audio-mix.test.ts`, `graph.test.ts`'s new "D04e" block, including a cue
  split across a cut) plus a real-ffmpeg render (`audio-mix.integration.
test.ts`) and a full-pipeline download+mix case (`pipeline.test.ts`'s new
  "D04e" block) proving the cue's own window rises well past the brief's
  ≥6 dB bar (measured: baseline ≈ −180 dBFS true silence vs. mixed
  ≈ −11.8 dBFS, a ≈168 dB delta on this fixture — the bar is met with
  large margin because the baseline fixture is silent, not merely quiet).
  - **Deviation from the brief's prose**: the brief describes ducking as
    "dialogue bus `volume` driven by the duck expression"; this ducks the
    _cue_ under speech instead, matching the already-shipped, parity-tested
    D04a contract (`sfx-duck-expr.ts`'s own doc comment: "applied to the
    SFX layer itself"; `apps/web/lib/export/engine.ts`'s `applySfxDucking`
    likewise multiplies the cue buffer, never the dialogue track). Flagged
    rather than silently reinterpreted either way.

- **M09: fixed the CSP regression blocking every authenticated Playwright
  spec at the shared sign-up helper.** `next.config.ts`'s CSP `connect-src`
  (added by the X01 threat-model hardening) was `'self' https: wss:` — the
  `https:` keyword only matches TLS origins, so it silently blocked every
  `fetch()` to a plain-`http://` API, which is what every local dev server
  and Playwright run uses (`http://127.0.0.1:<port>`, a different port from
  the web origin so `'self'` did not cover it either). The sign-up request
  never left the browser (no network entry — just a CSP console error), so
  `e2e/fixtures.ts#signUpAndVerify`'s `getByTestId("signup-sent")` wait timed
  out on every authenticated spec (`admin`, `streak`, `share`, `export`,
  `academy-help`, `team-devices-licensing`, `gate-a`, `plugins`, and more),
  while public specs (`docs`, `marketing-smoke`) were unaffected. Fixed by
  listing the API's actual `API_ORIGIN` explicitly in `connect-src` — read at
  server start, so dev/e2e's `http://` origin and production's `https://`
  one are both allowed without a wildcard scheme. `apps/web/next.config.ts`,
  test coverage in `apps/web/next.config.test.ts`.
  - **Also fixed (found while re-running the spec list):** `WhatsNewModal`
    (academy/help work) opens the first time any signed-in account reaches
    the shell and its overlay intercepts pointer events on the rest of the
    page, which blocked whatever click a spec made next if it did not
    already know to expect it (`streak`, `export`, `gate-a`). Installed a
    `Page#addLocatorHandler` in `e2e/fixtures.ts`'s shared `context` fixture
    that dismisses the modal automatically wherever it appears, covering
    every spec without each one learning to check for it.
  - **Known, pre-existing issues found but out of scope for this fix**
    (neither is the sign-up regression and neither regressed from this
    change): `streak.spec.ts`'s "Subscription widget" case still fails — the
    streak widget (`components/streak/streak-widget.tsx`) is not mounted
    anywhere on `/billing`'s overview page. `export.spec.ts`'s two real
    browser-export cases still time out waiting for `export-done` — the
    export pipeline itself does not finish inside the test's timeout in this
    environment (no GPU worker configured, `GPU_PROVIDER=none`).

- **D05: music pass — sections, mood, BPM, retrieval, placement; beat-alignment
  utility; `RenderManifest.timemap.audio.music[]`.** Fills in `MusicPayload`
  (edg schema and route already prepared by D04c's CONTRACTS §2 amendment).
  - `apps/worker-ai/worker_ai/passes/music/**` (new package): `analysis.py`
    (`detect_sections` — a sliding window over speech ratio and cut density,
    merging adjacent same-mood windows; `classify_mood`, a fixed six-mood rule
    table over sentiment x energy; `bpm_target_from_cut_cadence`, mapping
    average cut gap onto the fixture pack's two BPM bands), `retrieval.py`
    (`rank_music_assets` — CLAP similarity + mood-tag match + BPM proximity,
    weighted 0.5/0.3/0.2, deterministic ties by id), `placement.py`
    (`build_music_items` — one bed per section, `loopPolicy` from the bed's
    own measured length vs. the section's, dropped outright on a protected
    range). `apps/worker-ai/worker_ai/processors/music_pass.py`: the `ai.pass`
    (`passType: "music"`) queue adapter, wired into `autocut_pass.
process_pass`'s dispatch. Every accepted item gets the same `-12dB/150ms`
    bed duck `sfx_pass.py` uses. **Deviation:** mood classification's
    "sentiment" input is a tiny deterministic word-list scorer
    (`PassesService.sentimentCuesOf`), not a real B11 LLM client call — wiring
    an actual prompted round trip into pass _production_ was out of reach in
    this pass; the seam (`(tMs, score)` pairs) is ready for B11 to replace.
  - `apps/api/src/passes/passes.service.ts`: `startMusic` (mirrors `startSfx`
    exactly — finished-timeline quote, licence-gated catalogue, protected
    ranges); `musicCatalogueOf` reads `AudioAssetsRepository.
findCatalogueWithEmbeddings("music")`. `passes.quote.ts`: `quoteMusic`, a
    thin sibling of `quoteSfx` sharing `sfxMusicPass`'s burn rate (finished
    minutes, Studio+) rather than a new rate. `passes.controller.ts`:
    `POST /projects/{id}/passes/music`. `passes-completion.handler.ts`:
    `MusicResultSchema`/`handleMusic`, minting `PassItem{kind:"music"}` rows
    the same way `handleSfx` mints `sfx` ones.
  - `apps/api/src/audio-assets/manifest.schema.ts`: `introMs`/`outroMs` added
    to a manifest asset (D04a's `AudioAsset.introMs`/`outroMs` columns existed
    but were never written); `audio-assets.repository.ts`'s `upsertRow` now
    writes them and `findCatalogueWithEmbeddings` returns `mood`/`bpm`/
    `introMs`/`outroMs`/`durationMs` for every kind (harmless additive fields
    for `sfx` callers, load-bearing for `music`'s loop-policy maths). A music
    bed's safe loop region is `[introMs, durationMs - outroMs]` — no new
    columns needed.
  - `fixtures/audio-pack/generate.mjs`: 8 new music beds (4 moods x 2 BPM
    bands: upbeat/calm/tense/dramatic x 92/128 BPM), `kind:"music"`, each
    carrying `mood`/`bpm`/`introMs`/`outroMs`. **Deviation:** beds are 4s
    loopable patterns, not the brief's 30-60s — a fixture only needs to
    exercise loop-policy/BPM-target maths correctly, and a dozen 40s WAVs
    would blow well past this pack's "a few hundred KB" budget.
  - `packages/edg/src/ops/apply.ts`: `EditPassItem` (drag-to-adjust) now
    accepts `music` alongside `cut`/`zoom`/`reframe`/`sfx`, keeping
    `payload.startMs`/`durationMs` in lockstep with the item's own bounds.
  - `packages/render-manifest`: `MusicTrackSchema` (mirrors `SfxTrackSchema`:
    `itemId, startMs, endMs, assetId, packId, storageKey, gainDb, loopPolicy,
bedDuck, mood, bpm` — no fade fields, since `MusicPayload` carries none;
    D05's own fixed 300ms/800ms fades apply at mix time) and
    `RenderManifest.timemap.audio.music[]`, additive and optional. New
    `apps/api/src/passes/music-tracks.ts` (`resolveMusicTracks`/
    `acceptedMusicAssetIds`, mirroring `sfx-tracks.ts`), wired into
    `manifest-builder.ts`/`exports.service.ts` alongside the existing `sfx`
    line. **Scope note:** populating `timemap.audio.music[]` is this work
    package's job; mixing it into an export (loop, fades, bed duck under the
    amix graph) is D04d's, running in parallel — `apps/render/**` and
    `apps/web/lib/export/engine.ts`'s audio mixing are untouched by design,
    per the orchestrator's addendum, so the brief's own "export unit + parity
    fixture" acceptance item is deferred to D04d/a follow-up rather than
    built here against a moving target.
  - `packages/timemap/src/beats.ts` (new): `alignCutBoundariesToBeats` —
    snaps a cut boundary to the nearest beat of a target BPM within ±120ms
    (never further), never landing inside a protected range; works entirely
    in output-clock milliseconds, off by default (the caller decides whether
    to request it — nothing in this work package auto-applies it yet).
    `beatTimesInRange` lists a grid's own instants (tests/UI overlays).
    Property-tested (`beats.properties.test.ts`, fast-check): every emitted
    adjustment lands exactly on the beat grid, never inside a protected
    range, and never exceeds the configured tolerance, across generated
    cuts/bpm/anchor/protected-range combinations.
  - `apps/web/components/editor/passes/ProposalCard.tsx`: a `music` block
    (mood/BPM/loop-policy read-out, an optional `<audio>` preview, and a
    "swap bed" button via a new `onSwapMusicBed` callback seam — this card
    has no catalogue of its own to re-rank against, so the caller supplies
    the swap, the same split `onGainDbPreview` already uses for `sfx`).
    `apps/web/lib/timeline/lanes.ts` and `PassesTab.tsx`'s kind filter
    already had `music` wired by D04c; unchanged here.
  - Tests: `apps/worker-ai/tests/test_music_pass.py` (analysis/retrieval/
    placement unit tests), `test_music_pass_processor.py` (the queue
    adapter); `packages/timemap/src/beats.test.ts` +
    `beats.properties.test.ts`; `packages/render-manifest/src/manifest.test.ts`
    (`MusicTrackSchema` round-trip); `apps/api/src/passes/passes.quote.test.ts`
    (`quoteMusic`), `music-tracks.test.ts`, `audio-assets/
manifest.schema.test.ts` (fixture-pack validation, `introMs`/`outroMs`);
    `apps/api/test/passes.e2e-spec.ts` (producer -> worker completion ->
    `MergePass` -> `GET /projects/{id}/passes`, end to end against the
    fixture catalogue); `packages/edg/src/ops/apply.test.ts` (`EditPassItem`
    on a `music` item); `apps/web/components/editor/passes/
ProposalCard.test.tsx` (the new music block).
- **D09: apply passes inside Premiere and Resolve — sfx/music audio clips, title MOGRT/Text+
  instances.** New `plugins/shared-apply` (TS, no Node-only deps): `buildApplyPlan` turns
  `accepted` EDG pass items into host-neutral `ApplyOp`s (`deleteRange`/`motionKeyframes`/
  `audioClip`/`title`), re-checking the D43 licence predicate (`allowsRawFileDelivery` +
  `licenceSnapshot.surface` includes `panel`) before ever letting a partner-catalogue asset reach
  a track, and mapping `TitlePayload.motionPreset` (CONTRACTS §2 amendment; there is no
  `text_fx` kind) to the frozen MOGRT/Text+ param table via `motionPresets.ts`. A checked-in
  fixture pair (`fixtures/sample-items.json` -> `sample-plan.json`) is the parity source both
  `planBuilder.test.ts` and the new `plugins/resolve/tests/test_apply_plan_parity.py` assert
  against — JSON exchange was chosen over a full Python port of the plan-building logic to avoid
  two independently-maintained copies of the licence gate/preset table; only the small static
  tables (`licence.py`, `motion_presets.py`) are ported, mirroring the risk the brief's "pick one
  and justify" question was about.
  `plugins/premiere-uxp`: `src/apply/sfxMusic.ts` places accepted sfx/music clips on dedicated
  audio tracks (new `PremiereHost.ensureTrack`/`setClipGainKeyframes`), with gain/fade keyframes
  and ducking approximated as dialogue-track gain keyframes; `src/apply/titles.ts` inserts the
  new title `.mogrt` this WP added to C06b's generator (`mogrt/title-params.ts`,
  `generateTitleMogrtDefinition` — the frozen 14 caption params plus one new `MotionPreset`
  param, index 14) or falls back to an overlay clip for a preset the table can't express (no D06
  preset triggers this today). `ApplyMode` gains `sfxMusic`/`titles` (dry-run preview counts,
  `ApplyPanel`). New `src/api/client.ts` wraps `GET /styles` (A14), `GET /projects/{id}/transcript`
  (A11) and `GET /projects/{id}/edg/segments` (A12) behind one typed client, per the orchestrator
  addendum after C05a/C05b/C09.
  `plugins/resolve`: `sfx_music.py` (audio clips via new `ResolveHost.import_audio_clip`/
  `set_volume_keyframes`, the latter documented as an open A00-04 question — the scripting
  README describes `SetProperty` as a single-value setter, not a keyframe-track API) and
  `titles.py` (Text+ macro instances via `append_text_plus`, same preset mapping) mirror the
  Premiere modules' behaviour; `api_client.py` mirrors the same three GETs over `httpx`.
  Deviation: `ResolveHost.add_track` has no idempotent "find by name" contract the way
  `PremiereHost.ensureTrack` does, so `sfx_music.py` only dedupes a shared "Aksharo SFX"/"Aksharo
  Music" track within one `apply_sfx_music` call, not across repeated calls/re-applies — flagged
  as an open follow-up, not silently accepted as solved.

- **D04d: audio mix pipeline — signed pack-asset URLs and real energy cues;
  browser/cloud cue-audio mixing deferred (see Deviations).** Closes two of
  D04c's three flagged deviations.
  - `apps/api/src/audio-assets`: `GET /audio-assets/{assetId}/url` (new
    `AudioAssetsController`/`AudioAssetsService`) — a workspace-member,
    rate-limited (60/min), audit-free ten-minute signed GET onto one pack
    asset's bytes. The licence predicate (`assetAllowed`) is **re-checked at
    signing time**, not trusted from whatever produced the caller's
    `assetId`: surface is read off the caller's own token `kind`
    (`desktop`/`api`/`panel`), plan via `resolveWorkspacePlan`, territory
    `"WORLD"` (the same flagged assumption `passes.service.ts`'s
    `sfxCatalogueOf` already carries). New `AudioAssetsRepository.findById`.
    E2e (`audio-assets.e2e-spec.ts`, new HTTP describe block): mints a real
    token, fetches the signed URL over a real Postgres/Redis/MinIO stack, and
    fetches the URL itself to prove the bytes that come back are the
    fixture's own — plus 404 (unknown id), 403 (a partner asset with no
    established clearance, re-checked regardless of what produced the id),
    401 (no token).
  - `packages/api-client`: client regenerated (`getAudioAssetUrl`);
    `audioAssetsEndpoints.getUrl`, `useAudioAssetUrl`/`useAudioAssetUrls`
    (`useQueries`-backed, ten-minute `staleTime`, keyed by asset id alone —
    the bytes at `packs/{packId}/{assetId}.wav` do not vary by workspace).
  - `apps/web/components/editor/passes/PassesTab.tsx`: closes D04c's
    deviation (3) — when no `resolveSfxPreviewUrl` override is supplied,
    `PassesTab` now resolves every visible `sfx` item's preview URL itself
    via `useAudioAssetUrls`, so `ProposalCard`'s `<audio>` preview has a real
    URL source in production; the prop stays as a test/storybook override.
  - `apps/worker-ai`: closes D04c's deviation (1) — `sfx_pass.py` now
    samples real RMS energy from the 540p proxy when the producer's payload
    carries no `rmsSamples` (same 10 Hz windows B19b's `zoom`/`reframe`
    passes already sample), instead of always feeding `detect_energy_cues`
    an empty series. The proxy-download boilerplate B19b's
    `reframe_zoom_pass._sample_from_proxy` inlined is factored into a shared
    `processors/proxy_media.download_proxy`, used by both processors — `sfx`
    samples audio only (no frame/scene decode; it has no use for it).
    `passes.service.ts`'s `startSfx` docstring updated to match. New tests:
    the storage-unconfigured path (mirroring B19b's own), and an energy
    spike in supplied `rmsSamples` producing a ducked `sfx` item.
  - **Deviations, and why**: the browser (`OfflineAudioContext`, scheduled
    cue playback + `applySfxDucking`, output-clock remap) and cloud
    (`apps/render` ffmpeg `adelay`/`volume`/`afade` graph over D04a's
    closed-form duck) byte-mixing pipelines, and the loudness/envelope
    parity fixture proving them equivalent, were **not implemented in this
    pass** — the scope this WP's brief led with. `apps/web/lib/export/
engine.ts` already carries the duck-curve math (`duckGainAt`,
    `applySfxDucking`, D04a/D04c) and `apps/render/src/ffmpeg/
sfx-duck-expr.ts` already carries the cloud-side closed form and its own
    parity gate (`parity:sfx`, D04c) — neither export path calls into either
    to actually decode, schedule and mix a cue's bytes onto the output audio
    track yet. This is the same class of gap D06 left open for its own title
    track (closed later by D06b) and D04c left open for `sfx` before it.
    Flagged rather than rushed: mixing on the output clock (cue starts must
    shift across accepted cuts/ripples, B20's own remap) is exactly the kind
    of timing bug that reads fine in a unit test and is wrong on a real
    multi-cut export, and neither export path nor the parity fixture proving
    them equal should be the thing a coordinator finds out is faked. A
    follow-up WP should pick this up starting from the two files named
    above.

- **D06b: text FX draw path — browser export engine, cloud render, parity
  fixture.** D06 shipped the presets, the layout solver and the worker
  pass, and `RenderManifest.timemap.titles` carried the data, but nothing
  drew it; this closes that gap. New `packages/render-core/src/textfx/
frame.ts`: `renderTitleFrame`, the one shared step that turns a manifest's
  accepted title items into `DrawCommand[]` for one output millisecond —
  finds every title on screen, evaluates its motion preset, shapes its text
  (heavier weight of the render's own default caption style, borrowed
  colours), places its box with `placeTitleBox` against the active
  caption's live safe area, and hands it to D06's `drawTextFxTitle`. New
  `packages/render-core/src/textfx/count.ts`: `countUpText` finds the
  number inline in a `count-up` title's text (`TitleTrackSchema` carries no
  separate numeric field) and re-formats the animated value in the title's
  own script's digits (Devanagari for Hindi/Marathi, Tamil numerals for
  Tamil) via `Intl.NumberFormat`'s `numberingSystem`. Wired into both
  render paths from the same call site: `apps/web/lib/export/engine.ts`
  (browser, CanvasKit) and `apps/render/src/render/frames.ts` (cloud,
  Skia-node) each call `renderTitleFrame` after their own caption commands
  for the frame, using `layoutFrame`'s own geometry (`captionBoxFromLayouts`)
  for the safe area — so a title draws identically on both backends by
  construction, not by convention. New parity fixture
  `apps/render/parity/textfx-fixtures.ts` + `run-textfx-parity.ts`: one
  title per D06 motion preset across a 6-second clip, rasterised by both
  `@montaj/render-canvaskit` and `@montaj/render-skia-node` and diffed
  pixel for pixel (`pnpm --filter @montaj/render parity:titles`);
  `results.json` gains a merge-preserving `titles` block alongside B20b's
  `edits` and B10b's `audio`. Every preset measured well inside a 2%
  tolerance (max ~0.44%), comfortably under decision D33's general 1% SLO.
  Deviation: the caption safe-area geometry is recomputed once more per
  frame (`layoutFrame` called a second time, after `renderFrame`'s own
  internal call) rather than threading it out of `renderFrame` itself,
  to stay inside this work package's file boundary
  (`packages/render-core/src/textfx/**`, not `frame/render-frame.ts`); a
  follow-up could return the active caption box from `renderFrame` directly
  to remove the duplicate layout pass.
- **D04c: SFX pass wiring — `edg` schemas, the `ai.pass` producer/completion, the
  Passes-tab SFX card, and the timeline lane.** Closes the gap D04a's final
  report flagged ("the `ai.pass` producer→worker→`MergePass` completion wiring
  for `passType: "sfx"` needs `packages/edg`'s schemas extended"), now that
  CONTRACTS' 2026-09-03 amendment defines the shape.
  - `packages/edg`: `SfxPayloadSchema`/`MusicPayloadSchema` rewritten to the
    amendment's shape (`assetId, packId, startMs, durationMs, gainDb, fadeInMs,
fadeOutMs, duck: {depthDb, attackMs, releaseMs} | null, licenceSnapshot,
cueReason`, plus `MusicPayload`'s `loopPolicy`/`bedDuck`/`mood`/`bpm`) —
    `PassTypeSchema`/`ItemKindSchema` already carried `sfx`/`music` from the
    amendment landing on `main` ahead of this WP. New `PackIdSchema` primitive
    (mirrors `audio-assets/pack-keys.ts`'s slug pattern — CONTRACTS §6's
    `packs/{packId}/{assetId}.wav`, no longer an open question). `EditPassItem`
    (`ops/apply.ts`) now accepts `sfx` alongside `cut`/`zoom`/`reframe`,
    keeping `payload.startMs`/`durationMs` in lockstep with the item's own
    `startMs`/`endMs` on every drag — a render-manifest consumer reads only
    `payload` for placement. Tests: round-trip parse for both payloads, move +
    lockstep, stale-after-reject.
  - `apps/api`: `AudioAssetsRepository.findCatalogueWithEmbeddings`/
    `findStorageKeysByIds` (new reads over `audio_assets`, one for the
    producer's stateless-worker catalogue, one for the exporter's manifest
    build). `PassesService.startSfx` (`POST /projects/{id}/passes/sfx`):
    quotes `quoteSfx` on the finished timeline (D04a's own quote fn, unused
    until now), holds credits, enqueues `ai.pass` with the whole
    `assetAllowed`-filtered `sfx` catalogue, emphasis/question/silence-gap cue
    inputs (derived from the live transcript and segments — energy cues are
    out of scope this pass, no proxy-sampling wired for `sfx`, flagged below),
    and the accepted-cut/protected ranges every other pass already sends.
    `PassCompletionHandler.handleSfx` turns the worker's cues into
    `PassItem{kind:"sfx"}` and merges them via `MergePass`. `../passes/
sfx-tracks.ts`: resolves accepted `sfx` items into the render manifest's
    `timemap.audio.sfx[]` (wired into `manifest-builder.ts`/`exports.service.ts`
    alongside B20b's `keyframeTracks`). E2e (`passes.e2e-spec.ts`,
    `audio-assets.e2e-spec.ts`) prove route → fake worker completion →
    `MergePass` → `GET /passes` against real Postgres/Redis.
  - `apps/worker-ai`: `processors/sfx_pass.py` — the `ai.pass` consumer for
    `passType: "sfx"`, calling D04a's `worker_ai.passes.sfx.build_sfx_items`
    over the producer's cues/catalogue and shaping the result for the
    completion callback; every cue but a `silence_gap` transition beat gets
    D04a's default `-12dB/150ms` duck. Wired into `processors/autocut_pass.py`'s
    `process_pass` dispatcher. Unit tests over the queue adapter (emphasis/
    question cues, protected-range guard, catalogue-required, silence-gap
    cues never duck).
  - `apps/web`: `ProposalCard` gained an `sfx` block — an `<audio>` preview
    from a caller-supplied signed URL (`sfxPreviewUrl`, a callback seam like
    `onPreview`, not an embedded fetch — no signed-URL-issuing endpoint exists
    yet for pack assets, flagged below) and a gain slider (`onGainDbPreview`;
    UI-only preview, since CONTRACTS has no `EdgOp` to persist `payload.gainDb`
    — only `EditPassItem`'s `startMs`/`endMs` are writable). The timeline's
    `sfx` lane needed **no new code**: `lib/timeline/lanes.ts`'s `audio` lane
    (B20) already groups `sfx`/`music` kinds generically.
  - `packages/render-manifest`: `SfxTrackSchema`/`DuckTrackSchema` and
    `timemap.audio.sfx[]` (additive optional, same backward-compatible
    convention as `keyframes`/`titles` — a manifest built before this field
    existed stays valid).
  - `apps/render`: a second, independent parity gate — `parity/run-sfx-
parity.ts` writes `results.json`'s own `sfx` key (never touching `run.ts`'s
    `edits` or `run-audio-parity.ts`'s `audio`), measuring the browser
    `duckGainAt` vs. the cloud `buildSfxDuckVolumeExpr` over three
    representative `SfxPayload.duck` curves; all three agree to
    floating-point noise against a `1e-6` tolerance (`run-sfx-parity.test.ts`
    asserts the same on every `pnpm test`).
  - **Deviations, and why**: (1) real audio-energy cues (`detect_energy_cues`)
    are not wired for `sfx` — B19b's proxy-frame/RMS sampling is `zoom`/
    `reframe`-specific; only the word/text-derived cue kinds fire. (2) the
    manifest carries `timemap.audio.sfx[]`, but neither `apps/web/lib/export/
engine.ts` nor `apps/render`'s ffmpeg graph actually mixes the cue's audio
    into an export yet — the same class of gap D06 left for its own harder
    consumption side (`RenderManifest.timemap.titles`, still uncomposited);
    the duck _curve_'s parity is proven (above), but the real byte-mixing
    pipeline (downloading each pack asset, an `amix`/`adelay` filter chain
    remapped onto the output clock) was out of reach in this pass. (3) no
    HTTP route issues a signed URL for a pack asset yet, so `ProposalCard`'s
    `<audio>` preview needs a caller-supplied URL and renders nothing without
    one.

- **D04a: Tier 0 owned audio-pack ingestion, licence predicate, SFX cue-detection/
  retrieval, and export/render ducking — against a synthetic fixture pack.**
  The commissioned Tier 0 pack (A00-07) does not exist yet, so this WP builds and
  proves the whole pipeline against `fixtures/audio-pack/` (a dozen generated WAV
  cues across the taxonomy — impact, whoosh, pop, ding, riser, boom, comedic,
  notification — with a manifest carrying full D44 licence fields), so the real
  pack drops in through the same manifest unchanged. The `audio_assets`/
  `asset_usages`/`asset_clearance_grants` schema (typed licence columns, pgvector
  `embedding vector(512)`, HNSW index) already existed on `main` from A03's base
  schema (D43/D44's target design) — this WP builds the application layer on top
  of it rather than re-defining it, which the brief's literal "audio_assets...
  audio_packs..." schema sketch predates; noted as a brief/architecture
  reconciliation, not a silent deviation.
  - `apps/api/src/audio-assets/`: `assetAllowed` — the one licence predicate
    every retrieval path must call, surface/plan/territory/clearance/term gates,
    evaluated before any CLAP ranking (D43: only `allowsRawFileDelivery` assets
    ever reach panel/desktop/api; partner assets are `cloud_render`-only and
    additionally Studio-plan- and clearance-gated) — proven by 8 `fast-check`
    property tests (monotonicity, partner-catalogue exclusion, term windows,
    purity). `AudioAssetsRepository` — idempotent upsert (raw SQL for the
    `Unsupported("vector(512)")` column Prisma cannot type) keyed on
    `(provider, providerAssetId)`, and pgvector `<=>` cosine-ranked retrieval
    (`ORDER BY distance ASC, id ASC` for determinism). `manifest.schema.ts` (zod)
    validates a pack manifest 1:1 against `AudioAsset`'s typed columns.
    `loudness.ts` runs ffmpeg's `ebur128` filter (a small standalone twin of
    `worker-media`'s identical pass — apps don't depend on one another here, only
    `packages/*`). `embedder.ts`: `StubEmbedder` (deterministic, content-hashed,
    L2-normalised 512-dim) is the default; `ClapSubprocessEmbedder` shells out to
    `apps/worker-ai`'s `python -m worker_ai.audio_embed` only when
    `CLAP_MODEL_PATH` is set (H-22: the frozen LAION checkpoint is a model
    weight, never committed, absent on this machine).
  - `apps/api/scripts/ingest-audio-pack.ts` (`pnpm --filter @montaj/api
ingest:audio-pack <manifest>`): validate → measure loudness → embed → upload
    to the derived bucket → idempotent upsert. **Open question for the
    coordinator**: uploads to `packs/{packId}/{assetId}.wav`, a key
    `docs/CONTRACTS.md` §6 does not enumerate (every existing prefix is
    workspace/project-scoped; a shared audio-pack library is neither) —
    documented in `pack-keys.ts` rather than silently added to the frozen
    contract.
  - `apps/worker-ai/worker_ai/audio_embed/`: the `Embedder` protocol,
    `StubEmbedder`, and `ClapEmbedder` (lazy `laion_clap` import, guarded by
    `CLAP_MODEL_PATH`; its own real-model test is `slow`-marked and skips
    without the checkpoint). `python -m worker_ai.audio_embed <file>` is the
    subprocess CLI `ClapSubprocessEmbedder` calls.
  - `apps/worker-ai/worker_ai/passes/sfx.py`: pure, deterministic cue detection
    (RMS energy z-score peaks, emphasis words, question-intonation-by-punctuation
    proxy, silence-gap transitions) → text query → CLAP retrieval over an
    already licence-filtered candidate catalogue (cosine distance, matching the
    SQL repository's tie-break) → rate-limited to ≤ 1 cue per 4 s, dropped
    (never clamped) inside a protected range or over an accepted cut. 13 unit
    tests cover detection, ranking determinism and every guard.
  - `packages/config/src/credits.ts`'s `BURN_RATES.sfxMusicPass` (basis
    `finishedMinute`, Studio+ only) already existed ahead of this WP;
    `apps/api/src/passes/passes.quote.ts` adds `quoteSfx`, quoting against the
    _finished_ (post-cut) timeline per that basis, the same "rate lives in
    `@montaj/config`, duration choice lives with the producer" split
    `quoteAutocut`/`quoteReframeZoom` already established.
  - Ducking (−12 dB under speech, 150 ms linear ramps on both edges of every
    speech range, D04a): `apps/web/lib/export/engine.ts`'s `duckGainAt`/
    `applySfxDucking` (browser, per-sample) and
    `apps/render/src/ffmpeg/sfx-duck-expr.ts`'s `buildSfxDuckVolumeExpr`
    (cloud, an exact closed-form ffmpeg `volume=eval=frame` trapezoid, unlike
    `crop-expr.ts`'s keyframe-chain approximation) are proven numerically
    equivalent by `apps/render/parity/sfx-parity.ts` (21 web tests, 8+4 render
    tests).
  - **Deferred, and why**: the `ai.pass` producer→worker→`MergePass` completion
    wiring for `passType: "sfx"` needs `packages/edg`'s `PassTypeSchema`/
    `PassItem` schemas extended for the `sfx` kind — outside this WP's file
    boundaries (`packages/edg/**` is not listed) and adjacent to a frozen
    interface, so raised here rather than changed unilaterally. Full HTTP route
    - completion-handler wiring, the Passes-tab SFX card with a preview player,
      and the timeline `sfx` lane are consequently not built this pass — the
      licence predicate, ingestion, retrieval/ranking, cue detection, quoting and
      both render paths' ducking curves are, and are exercised end to end against
      real PostgreSQL/pgvector and MinIO in `apps/api/test/audio-assets.e2e-spec.ts`.

- **D06: text FX pass — key phrases to titles, with a no-overlap layout
  solver.** New worker pass `textfx` (`apps/worker-ai/worker_ai/passes/
text_fx.py` + `processors/text_fx_pass.py`): runs the `keyphrases@1`
  prompt (B11's template, now fully wired end to end — `_build_keyphrases`,
  `KeyphrasesOutput`, and the mock provider's deterministic generator all
  landed here) through B11's LLM client, caps proposals at 1 per 20s and 12
  per 10 min, snaps each phrase to the transcript word(s) it actually covers,
  classifies intent (`title`/`stat`/`quote`/`hook` from surface cues — a
  question mark, a digit, a quote) and drops anything inside a protected
  range or an accepted cut. New `packages/render-core/src/textfx/` module:
  a deterministic layout solver (`placeTitleBox`, property-tested with
  `fast-check` for "never overlaps the caption, for any caption position ×
  title length"), six motion presets (`pop`, `slide-up`, `typewriter`,
  `underline`, `count-up`, `fade`) as pure phase functions, and
  `drawTextFxTitle` turning a placement + phase into the same portable
  `DrawCommand[]` every other item kind emits. API: `POST /projects/{id}/
passes/textfx` (quoted on the finished timeline, `textFxPass` burn rate —
  1 credit/finished-minute, `packages/config/src/credits.ts`), a completion
  handler landing proposals as `PassItem{kind:"title"}` (CONTRACTS' frozen
  `ItemKind` has no separate `text_fx` kind, so the extra classification
  fields — `intent`, `motionPreset`, `anchorWordIds`, `layoutHint` — ride on
  `TitlePayload` as new optional fields, additive to the frozen shape).
  Editor: `ProposalCard` shows the title's text and motion preset; the
  timeline gained a `textfx` lane. `RenderManifestSchema.timemap.titles`
  (optional, not defaulted, same backward-compatible pattern as `keyframes`)
  carries accepted title items through to a render. **Deviation from the
  brief:** the actual pixel-level draw path inside `apps/web/lib/export/
engine.ts` and `apps/render` (compositing `drawTextFxTitle`'s output onto
  a real frame, plus the render-parity fixture) was not implemented in this
  pass — the manifest carries the data, but no engine consumes it yet. Left
  as an explicit follow-up rather than a rushed, untested wiring into the
  frozen render-parity gate.
- **M07 — fixed the `@montaj/web` build OOM (`FATAL ERROR: ... JavaScript
heap out of memory`, worker exit 134) that made `pnpm --filter @montaj/web
build` unreliable even with `NODE_OPTIONS=--max-old-space-size=3072` (X03
  reported 6144 also failed).** Root cause was a real infinite-loop bug, not
  a memory-size problem: `apps/web/lib/docs/markdown.tsx`'s `toBlocks()`
  paragraph branch stopped collecting lines on a bare `/^[-*#]|...` test,
  which also matches a line that merely **starts** with `*` (e.g.
  `**Status:** ...` — how every plugin README under `plugins/*/README.md`
  opens its first paragraph) without being a bullet (`^[-*]\s+`). On such a
  line the collection `while` ran zero iterations, the cursor `i` never
  advanced, and the outer loop pushed empty paragraph blocks forever —
  `/docs/plugins/premiere` alone was enough to exhaust any heap size the
  static-generation worker was given (confirmed both via `next build` and by
  reproducing the hang directly with `renderToStaticMarkup` outside of
  Next). Fixed by narrowing the stop condition to the exact patterns the
  branches above it test (bullet needs `\s+`, heading is `^#{1,3}\s`, etc.)
  plus a defensive backstop that forces the cursor forward if a block is
  ever collected empty. Also memoised two build-time derivations that
  `/docs/**` static generation was redundantly recomputing on every one of
  its ~20 pages instead of once per worker process — `loadApiGroups()`
  (`apps/web/lib/docs/openapi.ts`, re-parsing all of
  `packages/api-client/openapi.json` per call) and
  `loadDocsSearchDocs()`/`loadDocsSearchIndexSerialised()`
  (`apps/web/lib/docs/content.ts`, rebuilding the whole MiniSearch index per
  call) — real waste, but not itself the crash (measured at ~58KB/tens of
  ms, confirmed by a bisection that ruled out page count/order effects
  before the actual markdown bug was found). Added `experimental.cpus: 1`
  and `experimental.webpackMemoryOptimizations: true` to
  `apps/web/next.config.ts` as a documented safety margin for this shared,
  memory-constrained build host — not a substitute for the fix, and
  confirmed unnecessary on its own (the bug reproduced identically with 1 or
  4 workers). Verified: `NODE_OPTIONS=--max-old-space-size=3072 pnpm
--filter @montaj/web build` succeeded twice from a clean `.next` (117/117
  pages), peak main-process RSS ~1.9GB / heap ~718MB via
  `next build --experimental-debug-memory-usage`; `pnpm --filter @montaj/web
test -- --maxWorkers=2` and `turbo run typecheck --filter=@montaj/web`
  green. Annotated the two pre-existing `security/detect-object-injection`
  and `security/detect-unsafe-regex` findings in the two files this touched
  (`lib/docs/openapi.ts`, `lib/docs/markdown.tsx`) per the C02c convention;
  three more pre-existing findings in files this WP did not touch
  (`app/(site)/(marketing)/docs/guides/page.tsx`,
  `lib/docs/plugin-guides.ts`) were confirmed present on `main` before this
  work (via `git stash`) and left alone as out of this WP's boundary.

- **M07 (scope extension) — fixed the identical infinite-loop bug in
  `apps/web/lib/content/markdown.tsx` (B12's own copy of the same
  block-parser structure).** Its `toBlocks()` had the same bare `^[-*#]`
  paragraph stop-condition bug as `lib/docs/markdown.tsx` — a line starting
  with bold or italic text (e.g. two or one leading asterisks) satisfies
  that test without being a bullet, so the paragraph-collection loop ran
  zero iterations, the cursor never advanced, and the outer loop pushed
  empty paragraph blocks forever. No current academy/help/changelog body
  happens to open a paragraph that way, so this copy never actually crashed
  a build, but the bug was live and would have. Fixed with the same
  narrowed stop condition, adapted to this file's own heading branches
  (level-2 and level-3 headings only), plus the same cursor-progress
  backstop. Compared the two files in full before choosing an approach:
  they diverge enough (the docs copy adds GFM pipe-table parsing, a
  level-1 heading block kind, and a different inline-link target policy;
  the content copy adds single-asterisk italic) that extracting one shared
  block parser would not have been a small change, so both copies were
  fixed independently rather than merged — the duplication between
  `lib/docs/markdown.tsx` and `lib/content/markdown.tsx` remains and is
  worth a dedicated follow-up to unify if a third caller ever needs this
  kind of renderer. Added a regression test to the neighbouring test file
  in each case (`lib/docs/markdown.test.tsx`, and a new
  `lib/content/markdown.test.tsx` — no test file existed for
  `MarkdownBody` before this) that renders a paragraph opening with bold
  text and one opening with italic text, and asserts exactly one
  (non-empty) paragraph is produced. `pnpm --filter @montaj/web test --
maxWorkers=2`, lint and typecheck green; `format:changed` /
  `format:changed:check` clean (this WP's convention is scoped formatting,
  not repo-wide `format:check`, per the brief's formatting rule — ran that
  instead, equivalent for the files this WP touched).

- **M08: mounted C11's `PluginActivationCue` in the Passes tab.** C11 shipped
  the cue (`apps/web/components/editor/passes/PluginActivationCue.tsx`) but
  it was never wired into `PassesTab`. This WP adds a `PluginActivationCues`
  row (rendered next to the run-autocut toolbar, i.e. the apply-to-NLE
  affordance) that reuses `useDevices`/`useEntitlement` and
  `components/plugins/plugin-status.ts` — the same activation-state
  derivation the Plugins page and the cue itself already use — to decide,
  per Premiere/Resolve host, whether the cue is worth showing: hidden while
  loading/erroring, hidden entirely once every host is `signed_in`, hidden
  when the workspace has paired no plugin device at all (nothing to nudge
  yet), and hidden for a local project (C04b — passes/plugins need the
  cloud). Otherwise shows one cue per host still short of `signed_in`. No
  changes to `PluginActivationCue.tsx` itself — its own shown-in-every-state
  behaviour (used by the Plugins page later) stays intact. Tests added to
  `PassesTab.test.tsx` cover the matrix: both hosts activated (hidden), one
  host pending while another device is paired (shown, "Not installed" /
  "Device limit reached"), no device paired at all (hidden), and local mode
  (hidden).

- **M06: `eslint-plugin-security` promoted to `error` repo-wide.** C02c drove
  `apps/api`, `apps/web`, `packages/bridge-core` and `apps/desktop` to zero
  findings; this WP reviewed every remaining finding across the other 21
  packages (559 warnings: 275 `detect-non-literal-fs-filename`, 255
  `detect-object-injection`, 14 `detect-unsafe-regex`, 10
  `detect-possible-timing-attacks`, 5 `detect-non-literal-regexp`). Every one
  was a false positive of this plugin's known-noisy heuristics — bounded,
  linear regexes (commit-subject classifiers, kebab-case ids, SVG path-token
  scanners) flagged as "unsafe"; enum-/manifest-bounded bracket access flagged
  as "object injection"; internal build, manifest- and config-driven paths
  flagged as "non-literal fs filename"; null/status/hash sentinel `===`
  checks flagged as "timing attacks" (the one real constant-time comparison,
  `packages/render-manifest/src/signature.ts`'s `verifyManifestSignature`,
  already uses `crypto.timingSafeEqual`) — verified by re-running the flagged
  regexes against adversarial input (no exponential blowup) and by reading
  every object-injection/fs-filename site's key/path provenance. No real fix
  was needed; every finding was annotated with a reasoned
  `eslint-disable-next-line security/<rule> -- <reason>` following C02c's
  convention. `packages/config/eslint.config.base.mjs`'s `securityRules` is
  now `error` by default (no more `warn` floor), `securityRulesStrict` is
  kept as an alias for callers that still import it, and the now-redundant
  per-package `{ rules: securityRulesStrict }` overrides in `apps/api`,
  `apps/web`, `apps/desktop` and `packages/bridge-core` were removed. Three
  of this WP's own annotations landed inside JSX children
  (`plugins/premiere-uxp/.../ApplyPanel.tsx`, `packages/ui/.../chips.tsx`,
  `packages/ui/.../job-progress.tsx`) where a `//` line comment is literal
  text, not a disable directive; caught by the follow-up lint run and fixed
  to `{/* eslint-disable-next-line ... */}` — a gap worth knowing about for
  future JSX annotations. After merging `main` (which had since pulled in
  X03's docs site and X04's status/legal pages), `apps/web` — already at
  `error` from C02c — picked up 7 new findings in `lib/docs/openapi.ts`,
  `lib/docs/markdown.tsx`, `lib/docs/plugin-guides.ts` and
  `app/(site)/(marketing)/docs/guides/page.tsx`; reviewed and annotated the
  same way (a fixed-list bracket lookup, an `fs` call on a path built from a
  hardcoded plugin list, and a linear markdown-table-separator regex, timed
  clean against adversarial input).

- **M05 — main hygiene: hermetic free-tier daily-cap workspace id in
  `noop-credits.facade.test.ts`.** Investigated a reported flake in
  "free-tier daily cap (THREAT-MODEL T23) > gives the allowance back when a
  hold is released" under `pnpm --filter @montaj/api test -- --maxWorkers=2
src`, described as cross-file interference on a shared Redis daily-cap key
  (same workspace id + UTC date). That premise does not hold for the current
  code: `NoopCreditsFacade`'s free-tier allowance
  (`apps/api/src/credits/noop-credits.facade.ts`) is tracked entirely
  in-memory (a `Map` keyed only by `workspaceId`, on the instance) — there is
  no Redis key, no date component, and no `MONTAJ_REDIS_PREFIX` involvement
  at all (confirmed against `apps/api/src/common/redis/redis-keys.ts`, which
  has no daily-cap builder). Each test constructs a fresh
  `NoopCreditsFacade` in `beforeEach`, and Vitest's default per-file module
  isolation (never overridden in this repo's Vitest configs) means that even
  a module-level singleton — which doesn't exist here — could not leak
  across test files. The full `src` unit suite ran green with
  `--maxWorkers=2` three times after merging `main` (166/166 files, 1784/1784
  tests each run) and the file alone twice (18/18), so the failure did not
  reproduce. Applied the requested hardening anyway as defence-in-depth:
  `noop-credits.facade.test.ts`'s fixed `WORKSPACE` literal
  (`01JCWS0000000000000000000A`, a literal also reused verbatim by ~17
  unrelated test files for unrelated fixtures) is now generated per test run
  from `Date.now()` and `Math.random()` rather than hard-coded, so a future
  change to isolation settings or to the facade's storage key would need one
  fewer coincidence to collide. No product behaviour changed.

- **C02c: Electron major bump, `eslint-plugin-security`, WS ticket exchange
  (X01 follow-ups).** `apps/desktop`'s `electron` `^33.4.11` → `^44.1.1`
  (past X01's `>=39.8.10` floor, fixing the named use-after-free/context-
  isolation/cross-origin-protocol issues), with `electron-updater` → `^6.8.9`,
  `electron-builder` → `^26.15.3`, `@electron/fuses` → `^2.1.3`; fuses
  re-verified, `pnpm pack:dry` and the full desktop vitest suite green, the
  Playwright-Electron smoke run once locally (pass). `eslint-plugin-security`'s
  `recommended` ruleset added to `packages/config/eslint.config.base.mjs`
  (`warn`, repo-wide); every finding in `apps/api`, `apps/web`,
  `packages/bridge-core` and `apps/desktop` fixed or annotated (one real
  ReDoS-shaped regex fixed in `apps/api/src/media/import/subtitle-parsers.ts`;
  the rest reviewed as false positives), then promoted to `error` for those
  four packages (`securityRulesStrict`). C09's `?token=` WebSocket
  query-parameter bearer fallback replaced with a one-time ticket exchange
  (T11 follow-up): `plugins/resolve/aksharo_core_app/server.py` answers a
  bodyless `GET /session/ws-ticket` (bearer header) with a 30-second
  single-use ticket before the WebSocket handshake begins, and
  `plugins/resolve-panel/src/rpc/wsTransport.ts` fetches one and connects with
  `?ticket=` instead of the raw bearer.
- C04b: local mode follow-ups — transcript chunks in the local store, engine `/probe`,
  editor gating copy, local resegment.
  - `apps/desktop/src/local`: a fifth SQLite table, `local_transcript_chunks` (one row per
    `chunkIdx`, kept current), so `LocalStore.saveEdgSnapshot`/`latestSnapshot` carry
    transcript chunks; `apps/web/lib/edg/store.ts`'s local `EditorStore` branch now runs
    the full EDG op set — `EditWord`/`DeleteWord`/`SetWordTiming`/`InsertWordAfter` resolve
    against a real word index instead of rejecting `unknown-id`, and `Resegment` runs
    locally (mints its own op, applies through the same `packages/edg` engine the cloud
    path uses) instead of throwing `LocalResegmentUnsupportedError` unconditionally.
  - `apps/engine`: `POST /probe` (duration, fps, width, height, audio channels/sample rate,
    an HDR flag) — `FakeBackend.probe` returns deterministic fixture values;
    `packages/engine-client` gained the typed `probe()` method and schemas; a standalone
    `apps/engine/src/probe.ts` shells the manifest's ffprobe (sibling of `bin/ffmpeg`) for a
    future real backend to call unchanged. `LocalStore.importMedia` now probes an imported
    file via the engine when the caller does not already supply duration/fps/width/height.
  - `POST /projects/{id}/edg/import` accepts an optional `chunks` array; when given,
    `EdgRepository.createDocument` writes a fresh `Transcript` + `TranscriptChunk`
    generation alongside the document, so "Upload to cloud" keeps every word-addressed
    edit intact.
  - `apps/web/components/editor/local-mode-gate.tsx`: the shared "cloud project — upload
    to use" affordance (`LocalModeNotice`) and `uploadLocalProjectToCloud`; wired into
    `PassesTab` (autocut), `AudioPanel` (audio clean) and `ExportDialog`'s cloud-render
    fallback via an optional `isLocalProject` prop — a cloud project caller sees no change.
  - `apps/desktop/README.md`: manual Electron smoke steps updated for word edits, resegment
    and upload-to-cloud (Electron cannot launch in this sandbox).

- **M04 — main hygiene: consent-purpose drift, worker env-var contract drift, bridge consent sync, audit-scan gap.**
  - Consent purposes: `apps/api/test/users-workspaces.e2e-spec.ts` and
    `apps/api/src/consents/consents.service.test.ts` still encoded C12's old
    5-purpose list. Derived the e2e assertions from `CONSENT_PURPOSES` (one
    source) and swapped the "outside the enum" sample from `telemetry`
    (now valid) to `profiling`. `PRIVACY_NOTICE` (`apps/api/src/privacy/privacy-notice.ts`)
    was also missing the `telemetry` purpose entry; added it (its test
    already derives from the enum, so no drift is possible going forward).
    `docs/06-data-model.md`'s consent-purpose enum note still lists only 5
    purposes — doc row needed, not edited here (out of file boundaries).
  - Worker env-var contract: `packages/config/src/env.ts`'s `CONTRACT_ENV_VARS`
    gained `LICENSE_SIGNING_KID` but `apps/worker-ai/worker_ai/settings.py`
    kept its own hand-copied tuple, so `test_contract_list_matches_typescript`
    failed. `packages/config`'s build now emits `contract-env-vars.json`
    (`packages/config/src/emit-contract-env.mjs`, wired into `build`/new
    `gen:contract-env` script) and `settings.py` reads that JSON at import
    time, falling back to a last-known-good tuple only when the JSON hasn't
    been generated yet — the parity test still fails loudly if the fallback
    ever goes stale, so the two lists cannot silently drift again.
  - Bridge consent sync: `apps/bridge` read `GET /consents` nowhere and
    defaulted `telemetryConsent` to `false` forever. `ConsentsController.list`
    (`GET /consents`) now opts into `@AllowBridgeToken()`; the bridge
    (`apps/bridge/src/consent-sync.ts`, wired into `main.ts`) reads it on
    startup and polls it every 5 minutes, starting/stopping the telemetry
    client live on a change. No push channel exists from the API to an
    unpaired bridge process (`/bridge/relay` only pairs one bridge with one
    connected client), so this is a poll rather than the
    `consent.withdrawn`/`granted` event push the brief first asked for —
    flagged for the orchestrator as a deviation, same as `memory/consent-events.ts`'s.
  - Audit-scan gap: `apps/api/src/audit/audit-completeness.test.ts` flagged
    D08's `evals/internal-evals.controller.ts` (`POST /internal/evals/runs`).
    It's an HMAC-signed worker-to-API callback exactly like
    `internal-jobs.controller.ts`, not a user/admin action, and its durable
    trail is `EvalRun`/`EvalResult`, not `audit_log` — added the same
    documented exemption to `EXEMPT_FILES`
    (`apps/api/src/audit/audited-routes.scan.ts`).
  - Lint hygiene: `packages/fonts/e2e/server.mjs`'s long-standing no-console
    warning fixed with the same `eslint-disable-next-line` style already used
    elsewhere in the repo; `pnpm -w lint` is clean.

- **X03 — Docs site & API docs.** One docs surface at `apps/web/app/(site)/(marketing)/docs`
  (`/docs`): Guides (B12 help articles reused via the same `lib/content/loader.ts`), Plugins
  (guide pages generated from each `plugins/*/README.md`), Developers (the public API expanded
  into per-resource pages generated at build time from `packages/api-client/openapi.json`,
  covering parameters/responses/curl-Node-Python examples, webhooks, rate limits, SSRF rules
  and the product changelog), and Legal (links to the existing `/legal` scaffolds). Shared
  chrome (`docs-shell.tsx`) provides a sidebar nav, breadcrumb and a client-side MiniSearch
  index built at build time (no external service), plus a version switcher for the API
  reference (only `v1` published so far).
  - New generators under `apps/web/lib/docs/**`: `openapi.ts` (groups `/v1/*` endpoints by
    resource — the OpenAPI document's own `tags` are uniformly `public` and would collapse
    every endpoint into one group — and templates curl/Node/Python snippets), `plugin-guides.ts`
    (reads the four plugin READMEs from the repo root), `markdown.tsx` (a sibling of
    `lib/content/markdown.tsx` with GitHub-style pipe-table support, since the READMEs use
    tables that renderer doesn't parse), `nav.ts`, `search.ts` and `link-check.ts` (a
    deterministic, synchronous broken-internal-link check used by the generator unit tests).
  - `next.config.ts`: `/developers` (B14) now redirects (308) to `/docs/developers` — every
    inbound link keeps working, and the expanded reference lives at the new address.
    `(app)/help` (B12's authenticated in-product help) is untouched; `/docs/guides` is a
    second, public entry point onto the same MDX.
  - `apps/web/app/(site)/sitemap.ts` gained every `/docs/**` route (guides, plugin guides,
    developer API groups).
  - **Deviation from the brief**: the per-endpoint pages are grouped by the resource segment
    of the path (`projects`, `exports`, `jobs`) rather than by the OpenAPI `tag` literally,
    for the reason above — flagged rather than shipping a nav with one meaningless "Public"
    group.
- C10: installers, plugins page and the real `/plugins/manifest`.
  - `GET /plugins/manifest` extends the C11 stub into a real channel manifest: fetches
    `tools/release`'s published `plugins-manifest.json` (5-minute Redis cache), reporting
    `available: false` per channel/host only until that channel is actually published.
    Additive fields `channel`/`notes` plus a new `desktop` (per-OS download) entry;
    `premiere-uxp`/`ae-cep`/`resolve-script`'s existing `available`/`version`/
    `minHostVersion`/`maxHostVersion`/`downloadUrl` fields are unchanged.
  - `tools/release`: `build-desktop` enforces the installer size budget
    (Windows NSIS ≤ 150 MB, macOS DMG ≤ 180 MB, `03-architecture/05-system-architecture.md`
    §6-7) and throws `InstallerBudgetExceededError` over budget; `publish` now accepts
    `--ccx-artifact`/`--resolve-artifact` and writes `plugins-manifest.json` to the
    published channel dir; `package-resolve` stages a `VERSION` file, an uninstaller
    (`uninstall.sh`/`uninstall.ps1`) alongside the existing installers (works for both
    Resolve Free and Studio — same per-user Fusion path), and copies any generated Fusion
    macro (`plugins/resolve/installer/manifest.json`, C08b) into its own per-OS Macros path.
  - `apps/desktop/electron-builder.yml`: real installer targets (Windows NSIS, macOS
    dmg + pkg) with per-user install, a silent-install flag, a directory picker and
    differential-update blockmaps; a custom NSIS uninstall hook
    (`apps/desktop/build/installer.nsh`) removes the local bridge's discovery file
    (`~/.aksharo/bridge.json`) on uninstall. `pnpm pack:dry`'s `--dir` output (C02b's
    Playwright-Electron e2e) is unaffected — electron-builder's `--dir` CLI flag always
    wins over the yml's declared targets.
  - `marketplace/premiere-uxp/`: Adobe Exchange listing copy, a screenshot list (none
    captured yet — no Premiere Pro on any build host), and an Adobe trademark-usage-form
    checklist for the still-outstanding human action (H-24) — no submission made.
  - Marketing `/plugins` and `/download` (`apps/web/app/(site)/(marketing)`) now read
    `/plugins/manifest` live (server-side fetch with a static-copy fallback) for per-OS/
    per-host download buttons and a checksum-verification note, alongside the existing
    SmartScreen/Gatekeeper first-run copy and D65 non-affiliation line.
- **C05b — After Effects CEP 12 panel (minimal).** New `plugins/ae-cep` (`@montaj/ae-cep`):
  CEP 12 manifest (`CSXS/manifest.xml`, bundle id `ai.aksharo.ae` from `@montaj/config`,
  `AEFT` host min version `24.0`), bridge sign-in (device-code, same pattern as C05a's
  Premiere panel), WAV mixdown via Adobe Media Encoder, styled text layers per segment
  (mapped through a hand-copied mirror of C08b/C06b's shared style classification table —
  19 supported / 6 approximate / 5 unsupported of 30 system styles, `docs/AE-STYLE-COVERAGE.md`),
  alpha overlay import for unsupported/approximate styles, one `app.beginUndoGroup`/
  `endUndoGroup` per apply, host-id map via a layer marker comment, and re-sync (a re-apply for
  the same project replaces only its own previously tagged layers). Every host call is isolated
  behind `AeHost` (`src/host/ae.ts`) with `MockAeHost`; ExtendScript (`src/jsx/aksharo.jsx`) is
  a small ES3-compatible subset enforced by a dedicated lint config
  (`eslint.extendscript.mjs`) — no real After Effects exists on the build host, so
  `createRealAeHost()` throws until a human runs the new `docs/GATE-C-CHECKLIST.md`.
  `tools/release/src/commands/signZxp.ts` now stages only the shippable subset (`CSXS`,
  `index.html`, `dist`, `src/jsx`) from a real plugin tree before zipping, the same way
  `packageCcx.ts` already staged the UXP plugin — `pnpm release sign-zxp --dry-run` now
  packages the real panel instead of a placeholder. Deviation from the brief: the package
  lives at `plugins/ae-cep` (the directory `docs/CONTRACTS.md`, `release.config.ts` and the
  licensing plugin-channel schema already use), not the brief's literal
  `plugins/after-effects-cep`.

- C04: local mode (v1 = local-only) — `apps/desktop/src/local/**`: a SQLite (`sql.js`, WASM, MIT) store (`local_projects`/`local_media`/`local_edg_snapshots`/`local_exports`), a typed IPC surface (`window.aksharoDesktop.local`) delegating transcription/alignment/render to the local engine sidecar (C03a's `@montaj/engine-client`), the main-process network guard that blocks any upload to the hosted API while a local project is open, and the Starter+ `localMode` entitlement gate (`packages/config`'s `hasLocalMode`). `apps/web/lib/edg/store.ts` gained a local branch (`createLocalEditorStoreDeps`) so the hosted editor runs against the same IPC with no API calls for a local project; Home shows a desktop-only "Local projects" section. `POST /projects/{id}/edg/import` (new route) is the API side of "Upload to cloud" — writes a whole EDG v2 document as revision 1 of a fresh cloud project, never a merge.
- C03b: local engine quality-gate harness (`apps/engine/bench/**`) — for each model (`turbo-q5_0`, `small`), calls `/transcribe`+`/align` through `@montaj/engine-client` against a committed Hinglish reference set (`apps/engine/fixtures/hinglish-reference.json`: A23's 90s sample + D08's `hinglish-mini` references vs. a committed cloud-aligner snapshot), scores WER/CER/median word-boundary error via a thin Python metrics bridge (`apps/worker-ai/worker_ai/evals/local_engine.py`, reusing D08's `worker_ai.evals.metrics`), checks tiered latency (A<=60s/B<=90s/C<=120s) and a harness-vs-`/health` tier cross-check, and writes a dated `docs/verification/local-engine-<profile>-<date>.md`+`.json` report; thresholds (`apps/engine/bench/thresholds.ts`) are pure and unit-tested. Runs end to end against C03a's `FakeBackend` here (`gate: skipped-fake-backend` — plumbing only) and CI (`.github/workflows/local-engine-bench.yml`) keeps it green on every push/PR touching the engine; the gate itself only passes from a real-backend run on a Gate C machine (`docs/GATE-C-CHECKLIST.md`'s new "Local engine quality gate" section). Deleted the A01 scaffold `engine/montaj-engine/**` (superseded by `apps/engine`, C03a) and fixed the one stale reference to it (root `README.md`'s layout table).
- C09: DaVinci Resolve Studio Workflow Integration panel (`plugins/resolve-panel`) — docked React shell over `aksharo_core`'s loopback server (discover → bearer → JSON-RPC), `WorkflowIntegrationHost` adapter + mock, sign-in mirrored from the script, timeline picker, "Caption this timeline", passes review + "Apply in Resolve", version/update banner; C08 loopback server gains `session.status`, `transcribe.start`, `passes.list` (`plugins/resolve/aksharo_core_app/session.py|transcribe.py|passes.py`) plus a `?token=` query-param bearer path for browser `WebSocket` callers; `tools/release`'s `package-resolve` now also stages the panel bundle for Studio installs.

### Added

- **B20b — Passes follow-ups: keyframe tracks wired into manifests,
  `EditPassItem` drag-to-adjust, keyframe markers, canvas overlays, scrub
  preview, crop parity in the gate report.**
  `packages/edg`: `schemas/ops.ts` adds `EditPassItem{itemId, startMs,
endMs}` (CONTRACTS §2), rebase field `item:<itemId>` (reusing `DecideItems`'
  own field helper), last-write-wins; `ops/apply.ts`'s `applyEditPassItem`
  accepts only `proposed`/`accepted` cut/zoom/reframe items, clamps to the
  media duration and to neighbouring _accepted_ items of the same kind, and
  linearly re-times an inline `payload.keyframes` curve to the item's new
  duration (a `keyframesRef` curve is left for the worker to re-base on the
  next pass).
  `apps/api`: `src/passes/keyframe-tracks.ts` (new) resolves every accepted
  zoom/reframe item's packed curve — inline `payload.keyframes` as-is, or a
  `keyframesRef` fetched from derived storage — into `KeyframeTrack[]`;
  `exports.service.ts`'s `requestExport` calls it and passes the result to
  `manifest-builder.ts`'s `keyframeTracks` input (previously wired but
  unpopulated pending B19b), so both the browser and cloud manifests now
  carry `timemap.keyframes` for accepted items (`exports.e2e-spec.ts` proves
  it on both paths).
  `apps/web`: `lib/edg/ops.ts` adds the `editPassItem` builder and its undo
  inverse (`InverseState.items`); `Timeline.tsx` adds drag-to-adjust on a
  proposed/accepted cut/zoom/reframe lane item's edge (`lib/timeline/
pass-item-drag.ts`'s clamp/resolve pipeline, mirroring `snapping.ts`),
  keyframe markers and the zoom lane's mini scale-curve plot
  (`lib/timeline/keyframe-markers.ts`), and one Playwright chromium case
  (`e2e/timeline.spec.ts`, seeded via a new `mergePassForTest` internal-HMAC
  helper). `components/editor/canvas/CaptionStage.tsx`'s `children` prop now
  also accepts a `({fit, canvas}) => ReactNode` render function, so
  `CropWindowOverlay.tsx` (new) can draw the current zoom/reframe crop
  window over the stage without CaptionStage needing to know about it;
  `lib/timeline/current-crop-rect.ts` samples an accepted item's inline
  curve at the playhead, and `lib/timeline/scrub-preview.ts` computes the
  brief's ±1.5 s scrub window and the `"frames"`/`"rect-only"` mode name a
  caller's CanvasKit-readiness flag maps to (the fallback the brief allows
  when real frames are not available).
  `apps/render`: `parity/` (new) — `run.ts`/`crop-fixtures.ts` measure the
  same two crop-window fixtures `src/ffmpeg/crop-parity.test.ts` already
  checks (a cut+zoom and a cut+reframe) and write `parity/results.json`'s
  `edits` block plus a `README.md` gate report; independent of the caption
  _style_ parity gate (`packages/caption-styles/parity/results.json`,
  untouched). `vitest.config.ts` gained `parity/**` in its test `include`
  so the gate's own unit test runs under `pnpm test`.
  **Deviation:** the Playwright case (`timeline.spec.ts`'s "dragging a
  proposed cut item's edge lands an EditPassItem op") is written, wired end
  to end, and passes at the component-test level (`Timeline.test.tsx`), but
  could not be confirmed green in a live browser run in this environment —
  the shared host was under severe memory pressure (free RAM as low as
  ~1.9 GB across repeated attempts, ~15-20 concurrent Node processes from
  other agents), and every `next build`/`nest build` invocation the
  Playwright harness needs timed out or produced no output before the
  420 s webServer window elapsed, even after pre-warming `.next` with a
  standalone build. See the final report for the full account.
- **X01 — security review before Gate C.** Threat-model audit re-verifying
  every `docs/THREAT-MODEL.md` row (T1-T25) against implementing code and
  tests: `docs/security/threat-model-audit-2026-09-03.md`. Local `pnpm audit`
  and `pip-audit` triage (all findings are transitive build/desktop-packaging
  deps, none reachable at runtime — Electron flagged High for a follow-up
  version bump), a local secret-scan sweep (clean — 53 hits, all test
  fixtures/local dev creds, no real secrets), and a pen-test hand-off doc with
  in-scope surfaces, a seeded test-account procedure, and rules of engagement:
  `docs/security/pentest-scope.md` (includes the H-26 human-action text to
  engage an external tester before Gate C).

### Fixed

- **X01 — `GET /auth/device/code/:userCode` had no rate limit.** The
  approval-screen lookup requires an authenticated session (correct per
  THREAT-MODEL T3) but carried no `@RateLimit` decorator, unlike its sibling
  device-code routes; `RateLimitGuard` is a no-op with no rule attached, so
  any signed-in account could grind the 8-character user-code space to read
  someone else's pending device grant (host app, OS, IP, coarse location).
  Added a `deviceDescribeUser` bucket (`apps/api/src/auth/auth.constants.ts`)
  and applied it to the route (`apps/api/src/auth/device.controller.ts`), with
  a new negative test in `apps/api/test/auth.e2e-spec.ts`.
- **X01 — no security response headers on the web app or the API.** Neither
  `apps/web/next.config.ts` nor `apps/web/middleware.ts` set CSP, HSTS,
  `X-Frame-Options`/`frame-ancestors`, or `Referrer-Policy`, and
  `apps/api/src/main.ts` never installed `helmet`. Added a `headers()`
  function to `next.config.ts` (CSP, HSTS, no-sniff, deny-framing,
  strict-origin-when-cross-origin referrer policy, a conservative
  Permissions-Policy) with a new test (`apps/web/next.config.test.ts`), and
  `helmet()` to the API's bootstrap with CSP left off (Swagger UI at `/docs`
  needs inline scripts) but HSTS/frameguard/referrer-policy applied.

- C12: consent-gated desktop/bridge telemetry (`POST /telemetry/events|crash`), `crash_reports` with 30-day retention, shared redaction in `bridge-core`, diagnostics bundle attached to support tickets, server-side Sentry/PostHog forwarding behind env keys.

- C06b (follow-up): `plugins/premiere-uxp/src/apply/types.ts`'s `MOGRT_PARAM_ORDER`/`MogrtParamName` now import from `mogrt/params.ts` (14 params, append-only) instead of re-declaring their own copy of the appendix table, so there is exactly one source of truth across C06 and C06b; `MogrtCaptionParams` gained the optional `BoxFill`/`BoxOpacity` fields to match. `mogrtCaptions.ts` and its tests needed no other changes.

### Fixed

- **C00b — `apps/desktop` real electron-builder packaging over a pnpm workspace.**
  `pnpm --filter @montaj/desktop pack:dry` (`electron-builder --dir`) used to fail
  before producing any output: `node_modules/@montaj/{bridge-core,config}` are pnpm
  symlinks whose real path resolves to `packages/*`, outside `apps/desktop/`, and
  app-builder-lib's asar packager refused any file it couldn't express as a path
  relative to the app dir (`<file> must be under <appDir>`), so `tools/release`'s
  `build-desktop` always fell back to a placeholder tree and the `e2e` CI job would
  have hit the same failure on real runners. Fixed by esbuild-bundling the Electron
  main/preload/pairing-preload entry points into single CommonJS files under
  `apps/desktop/dist/**` (`scripts/bundle.mjs`) — every workspace dependency inlined,
  only `electron` and Node builtins left external — and pointing electron-builder's
  `directories.app` at that dependency-free `dist/` tree instead of the repo-managed
  `apps/desktop/package.json`. `scripts/pack.mjs` wraps the `electron-builder`
  invocation to pass `-c.extraMetadata.version`/`-c.extraMetadata.productName` sourced
  from `@montaj/config`'s `BRAND` so those values can't drift from
  `docs/CONTRACTS.md` §0. `tools/release build-desktop` now consumes this real output
  by default and only falls back to (or is forced onto, via a new `--placeholder`
  flag) the synthesized placeholder tree when no real build exists.

- **A23b — a real Postgres 40P01 ("deadlock detected") in `auth-harness.ts`'s
  `reset()`.** Several background writers the API starts inside a test app
  outlive the HTTP request a test awaits: `AccessLogInterceptor` fires
  `recordAccess` from a `tap()` that runs after the response has gone out, and
  a plain `this.events.emit(...)` (`members.service.ts`'s
  `MEMBERSHIP_SEAT_EVENTS.seatsChanged`, and the same pattern in `referrals`,
  `invoices`, `webhooks`, `credits`, `exports`) starts an `@OnEvent` listener —
  `SeatBillingListener` among them — without awaiting it. Either can still be
  writing `access_logs`/`audit_log`/`subscriptions`/`credit_accounts` when the
  next test's `beforeEach` truncates those tables, racing `TRUNCATE`'s
  `AccessExclusiveLock` and occasionally losing to Postgres's own deadlock
  detector. `test/auth-harness.ts` now patches (test-only, nothing under
  `src/` changed) `EventEmitter2.prototype._on` and
  `CommonAuditService.prototype.record`/`recordAccess` to track every such
  write, and `reset()` drains them — alongside the existing `NotifyConsumer`
  drain — before truncating, with a 40P01 retry (5 attempts, growing 150ms
  backoff) as a last line of defence. Two new regression tests in
  `users-workspaces.e2e-spec.ts` reproduce each race directly (a fire-and-forget
  `recordAccess`, and a throwaway `EventEmitter2` listener) and assert `reset()`
  waits for them. `scripts/verify-wave.mjs` and `docker-compose.test.yml` were
  run end to end once on this host; see `docs/verification/verify-wave-2026-09-03.md`.

### Added

- **X04 — Launch checklist: status page, backups + restore drill, on-call
  runbooks, legal pages, DPDP records, sub-processor list.** Public status
  surface: `ops_incidents`/`ops_status_snapshots` (Prisma), a 5-minute
  `StatusPublishTask` (`apps/api/src/scheduler/tasks/status-publish.task.ts`)
  publishing `GET /ops/status.json` and `GET /ops/status/rss.xml`
  (`apps/api/src/ops/status.controller.ts`), an admin CRUD for incidents
  (`AdminOpsController`, added alongside B13b's controllers, none refactored),
  and `apps/web/app/(site)/(marketing)/status/page.tsx` reading it (a proxy
  RSS route, and an honest "degraded" fallback if the API is unreachable —
  a status page must never itself be the outage). Backups: `docs/runbooks/backup-restore.md`
  ties together the existing PITR/S3-versioning runbook and the EDG snapshot
  tables (ordinary Postgres rows, restored with the rest of PITR — no separate
  procedure), plus a new scripted local drill, `scripts/ops/restore-drill.mjs`
  (dump → scratch database → `prisma migrate deploy` → seed smoke → drop),
  run for real against the compose stack during this WP, and
  `.github/workflows/ops-restore-drill.yml` running it weekly against a CI
  Postgres service. On-call: `docs/runbooks/on-call.md` (rotation template,
  per-alert escalation table keyed to `infra/observability/alerts/montaj-alerts.yaml`,
  queue-drain, DLQ replay, A10 provider-outage failover, GPU lane fallback),
  `docs/runbooks/incident-template.md`, and `docs/runbooks/breach-pipeline.md`
  (the DPDP 72-hour Board clock alongside the separate, shorter CERT-In
  6-hour clock — both starting from the same `detectedAt`). Legal: a cookie
  notice (`content/site/legal.ts`) and a sub-processors page
  (`apps/web/app/(site)/(marketing)/legal/sub-processors/page.tsx`,
  mirroring `apps/api/content/sub-processors.json` byte-for-byte, same
  pattern as the existing privacy-notice mirror), both linked from the legal
  index and the footer nav. DPDP records: `docs/compliance/dpdp-records.md`,
  generated by `scripts/ops/dpdp-records-generate.mjs` from
  `apps/api/prisma/schema.prisma` (any model with a direct relation to `User`
  or `Workspace`) and `docs/compliance/dpdp-records.manifest.json` (the
  hand-maintained purpose/retention decisions); `--check` fails CI
  (`.github/workflows/ops-dpdp-records.yml`) when a new personal-data table
  has no manifest entry or the doc is stale. HI translation of the legal
  pages was not attempted — no site-wide i18n exists yet (A24 confirmed no
  `next-intl`/ICU setup beyond the home page's bespoke `formatIcuLite`),
  and building one is out of this WP's scope; reported as an open item.
  H-27 (grievance officer / legal review) does not exist in `HUMAN-ACTIONS.md`
  as of this WP — the closest existing item is #11 ("Legal documents,
  A00-13"), which already covers a grievance officer appointment; reported
  as a brief/reality mismatch rather than invented.

- **D08 — Eval harness & quality gates: datasets, nightly runs, shadow
  routing, admin leaderboard, routing freeze.** Built on synthetic and fixture
  datasets only (A00-05's licensed Indic sets have not reported).
  `apps/worker-ai/worker_ai/evals/datasets/`: a `Dataset(name, kind, language,
script, licence, items[])` loader — `licence` mandatory — searching bundled
  `generated/` (six hand-authored synthetic sets: Hinglish/Hindi/Tamil
  transcript, transliteration pairs drawn from A22's real dictionary tables,
  autocut ground-truth cut lists, LLM check outcomes), `fixtures/` (an
  adapter reusing A09's `hinglish-mini` set without duplicating its
  audio/words files) and, if `EVAL_LICENSED_DATASETS_DIR` is set, an external
  root for A00-05's real corpus with no code change. `checksums.py` writes/
  verifies a SHA-256 `manifest.json` over every bundled file.
  `evals/metrics.py`: Indic-aware `normalise()` now folds ZWJ/ZWNJ and all
  nine nukta letters (four with no Unicode canonical decomposition, mapped by
  hand) in addition to the existing case/punctuation/whitespace folding, so a
  provider's spelling convention is never charged as a WER/CER error; new
  `word_boundary_error`, `diarisation_der` (dependency-free, grid-based, no
  `pyannote.metrics`), `transliteration_accuracy`, `autocut_precision_recall`
  (tolerance-windowed greedy matching) and `llm_pass_rate`.
  `evals/runner_datasets.py` dispatches `run_dataset` by kind (transcript
  reuses A09's `EvalSet`/provider path; the rest score directly).
  `evals/nightly.py`: `run_nightly` (cost-capped per D74:
  `DEFAULT_MAX_ITEMS_PER_DATASET`), `write_report` (`eval-results/<date>/
report.{json,md}`), `post_nightly_report` (signed like a job-completion
  callback, `POST {API_ORIGIN}/internal/evals/runs`); `python -m
worker_ai.evals nightly[--post]` and `pnpm --filter @montaj/worker-ai eval`.
  `routing.py`: `RoutingCandidate.shadow` — a shadow candidate is excluded
  from `resolve`/`resolve_chain` entirely (never a fallback, never returned)
  while `shadow_candidates()` lists the ones this deployment could run in
  parallel for a nightly comparison; `ROUTING_FROZEN=1` (or an upstream admin
  toggle) makes `load_routing_table_guarded()` skip `routing.yaml` and serve
  the last-approved snapshot (`write_routing_snapshot`/`load_routing_snapshot`)
  instead — reloads are refused outright while frozen. `apps/api`: new Prisma
  models `EvalRun`/`EvalResult`/`RoutingFreeze` (migration
  `20260903130000_d08_evals`); `POST /internal/evals/runs`
  (`src/evals/`, signed like other internal callbacks, idempotent on the
  signed attempt id used as `EvalRun.id`); `GET /admin/evals/leaderboard`
  (groups a recent window of results by dataset/language/provider/metric,
  reporting each group's latest value and trend vs. the previous run),
  `GET|POST /admin/evals/freeze`, `POST /admin/evals/unfreeze` (superadmin
  only, mandatory reason, audited — `src/admin/evals/`); B16 scheduler task
  `eval-nightly.task.ts` purges `eval_runs`/`eval_results` past 90 days and
  shells out to `pnpm --filter @montaj/worker-ai eval -- --post` (a
  documented pre-Gate-A simplification: the two apps share one monorepo
  checkout today; see the WP's final report for the production-shape follow-
  up). `apps/web`: `(admin)/admin/evals` panel (leaderboard table, freeze/
  unfreeze form). `packages/api-client` regenerated. Tests: Python unit tests
  for the Indic normalisation edge cases, dataset loader/manifest/licence
  checks, per-kind runner dispatch, shadow-exclusion and freeze-precedence
  routing tests; API unit tests (leaderboard grouping, freeze audit) and an
  e2e spec against real Postgres/Redis (signed ingestion + idempotency,
  leaderboard trend, freeze role-gating and audit, unfreeze). Deviations and
  open questions for A00-05 are in the WP's final report.

- **B13b — admin console follow-ups: routing overrides reach the worker,
  share-report/support-reply notifications, a real support panel, a
  server-side admin gate, admin Playwright, dashboard charts.**
  `GET /internal/routing/overrides` (`apps/api/src/internal/routing-overrides.controller.ts`)
  is a new, HMAC-signed (`InternalSignatureGuard`) internal endpoint serving
  `RoutingWeightOverride` rows as the `{ lanes: { candidates: { weight } } }`
  shape `worker_ai.routing.RoutingTable.apply_overrides` already expects,
  with a weak-ETag `Cache-Control: private, max-age=60`. The worker's new
  `worker_ai/routing_overrides.py` fetches it with a 60s in-process cache
  revalidated by that ETag, falls back to the last-known-good body on any
  network/5xx/404, and defers to D08's forthcoming routing-freeze flag via
  `getattr(settings, "routing_freeze", False)` (skips the fetch entirely
  when set, so freeze wins over an override with no code change needed on
  either side once that flag lands) — `worker_ai/runtime.py`'s
  `fetch_routing_overrides` now delegates to it, kept for import
  compatibility with `tests/test_routing.py`. Two new `NOTIFY_KINDS`,
  `share-report-resolved` and `support-ticket-reply` (kind + en/hi templates
  only, per this WP's file boundary): `AdminShareController.resolve` now
  emails the reporter (when they left contact details) and the workspace
  owner once a report is resolved; the new `AdminSupportService`/
  `AdminSupportController` (`admin/support/**`) replace B13's
  `available: false` stub with a real queue over B12's `support_tickets` —
  list/filter by status and category, a `support`/`superadmin`-gated status
  transition (the schema's own comment names this "B13 (admin) transitions
  it"), and a reply sent via the notify interface, both audited
  (`admin.support.status_set`, `admin.support.replied`). `apps/web/middleware.ts`
  gates the whole `(admin)` route group with a routing-only, httpOnly
  `aksharo_admin_hint` cookie (`lib/admin/admin-hint-cookie.ts`,
  `app/api/admin-hint/route.ts`, set by the step-up page and cleared by
  "End admin session") — a visitor who has never stepped up gets a plain
  404 rather than a redirect that would announce `/admin` exists;
  `AdminGuard` on the API is unchanged and remains the real authorization.
  A new dependency-free `BarChart` (`components/admin/bar-chart.tsx`, plain
  SVG, no CDN) renders the acquisition/streak/offers panels on the admin
  dashboard as bar breakdowns — an honest simplification, since none of the
  three source endpoints bucket by day yet (see the component's own doc
  comment and "open questions" below). New `apps/web/e2e/admin.spec.ts`
  seeds `admin_roles`/`admin_totp` directly with `pg` (no self-service grant
  route exists, the same gap `streak.spec.ts` documents for its own
  fixtures) and proves the 404 gate, and that `support` is refused by
  `AdminGuard`'s role check on a refund while `finance` clears it.
  **Deliberately not built**: the chained-self-referral device/IP signal
  (recorded here, per the orchestrator's ruling, as a clustering candidate
  for a future anti-abuse pass, not code) — a workspace pair that shares a
  device fingerprint or IP across `referral_rewards` rows is a signal this
  WP was told to name, not implement; see the doc comment on
  `AdminReferralsController` (`admin/referrals/admin-referrals.controller.ts`).
- **X08 — Cilium FQDN egress adoption for production (D73's staged rollout,
  prod hardening before Gate C).** `infra/k8s/montaj/values.yaml`'s
  `networkPolicy.fqdn.enabled` boolean becomes `networkPolicy.fqdn.mode:
off | audit | enforce`: `off` is unchanged from X05 (the coarse
  `0.0.0.0/0:443`-minus-private-ranges rule); `audit` (new) renders the
  `CiliumNetworkPolicy` with Cilium's `policy.cilium.io/audit-mode: "true"`
  annotation so a denial is logged (Hubble/`cilium monitor`) rather than
  dropped, with the coarse rule still up underneath it; `enforce` drops the
  coarse rule and lets Cilium reject anything outside
  `networkPolicy.providerAllowlist`/`providerAllowlistSuffixes`
  (`templates/networkpolicy.yaml`, `templates/networkpolicy-fqdn.yaml`).
  `.github/workflows/infra.yml` now `helm lint`/`helm template`s the `audit`
  and `enforce` variants (previously only the single `fqdn.enabled=true`
  case) and asserts the audit annotation is present on `audit` and absent on
  `enforce`. New `infra/policies/egress-inventory.json`, generated by
  `infra/scripts/generate-egress-inventory.mjs` from a source scan of
  `apps/api/src`, `apps/worker-ai`, `apps/worker-media/src`, `apps/render/src`
  and `apps/model-server` (`infra/scripts/egress-hosts.mjs`): 17 hostnames
  across ASR/LLM vendors, RunPod, R2, Sentry, Razorpay/RazorpayX, Google OAuth,
  HIBP and AWS SES/SNS, each with an owner and a purpose. `--check` (wired into
  `infra-validate` in CI) fails the build on drift against the committed file
  or on any outbound hostname a provider adapter dials with no metadata entry —
  the mechanism scope item 1 asked for ("a CI check fails when a new outbound
  host appears in code without an inventory entry"). Host guard note: this
  host has no `helm` binary (shared machine, ~13 concurrent agents; nothing
  vendored per instruction, no new root dependency added either), so
  `infra/scripts/validate-chart-local.mjs` substitutes a dependency-free,
  line-oriented structural scan (`node:fs`/`node:path` only) of `values.yaml`'s
  `providerAllowlist`/`providerAllowlistSuffixes` (every entry has a host and a
  reason) and `components.*` (every enabled component has `kind`, `repository`
  and a `network` block, cross-checked against the allow-list when
  `allowProviderEgress` is set), plus balanced `{{- if/range/with/define }}`/
  `{{- end }}` counts across every template; the real `helm
lint`/`helm template`/`kubeconform` pipeline still runs in
  `.github/workflows/infra.yml`, which already had Helm 3.19 and kubeconform
  0.8 installed from X05. New `docs/runbooks/egress-policy.md`: the mode
  table, how to roll a mode change out and back, reading a DNS-proxy denial via
  Hubble/`cilium monitor`, and adding a vendor (allow-list entry + metadata +
  regenerate). 19 new tests: `infra/scripts/egress-hosts.test.mjs` (9),
  `infra/scripts/generate-egress-inventory.test.mjs` (4, CLI-level) and
  `infra/scripts/validate-chart-local.test.mjs` (6).

- **M03 — Main hygiene: academy lot source, load-sensitive assertions, DLQ/jobs/offers
  e2e triage, help-slug wiring.** `apps/api/prisma`: migration
  `20260902222436_m03_academy_lot_source` adds `academy` to the
  `CreditLotSource` enum (CONTRACTS §4, 2026-09-03); `academy.service.ts`
  grants with `source: "academy"` instead of B12's stopgap `"adjust"`, and
  `ledger-credits.facade.ts`'s `ledgerKindForSource` ledgers it as a `grant`.
  `apps/api/test`: `edg.e2e-spec.ts`'s "costs the same on a 9,000-segment
  document" ratio budget widened from `3x`/30ms to `5x`/150ms (a real host
  observation of ~3.5x under load was ordinary jitter, not an O(n)
  regression); `dlq.e2e-spec.ts` and `jobs.e2e-spec.ts` switched their
  generic-completion fixture queue from `ai.clean` to `ai.vad` after B10
  registered a real `AudioCleanCompletionHandler` against `ai.clean` that
  400s a bare `{status:"succeeded"}` completion; `offers.e2e-spec.ts`'s ₹9
  pass suite now sends a real capability probe on its explicit
  `mode:"browser"` export request, which A21b started requiring. `apps/web`:
  the editor's right panel (`RightPanel.tsx`) gains a "?" affordance per tab
  opening the matching help article via B12's `help-slug-map.ts`
  (Style/Colors/Look → `caption-styles`, Anim → `emphasis-timing`, Audio →
  `caption-styles`), unit-tested against the real slug catalogue
  (`RightPanel.help.test.ts`). Verified: `dlq.e2e-spec.ts`, `jobs.e2e-spec.ts`
  and `offers.e2e-spec.ts` green 3× on the compose stack after merging main
  (which independently landed B13's `createAdminContext` fix for the same
  admin-auth 403s these suites hit, and B13d's chained-self-referral hold,
  which `referrals-http.e2e-spec.ts` already passes 3×).
- **C03a — `apps/engine` local sidecar (whisper.cpp/Silero/deep-filter/ffmpeg
  supervisor), model manager, backend detection, `@montaj/engine-client`.**
  New app `apps/engine`: a Node supervisor (no native compilation in the
  repo — every binary and model weight comes from `MODEL_WEIGHTS_BASE_URL`
  via a versioned, SHA-256-verified manifest, `manifest.ts`/`defaultManifest()`,
  the H-22 pattern) exposing a localhost-only (`127.0.0.1`, bound port) HTTP/WS
  contract — `GET /health` (unauthenticated, mirrors `model-server`'s
  `/healthz`), `GET /models`, `POST /models/download`, `POST /models/delete`,
  `POST /transcribe` (+ streaming partials over a `/transcribe` WS, bearer via
  query param since a WS handshake carries no header), `POST /align`,
  `POST /clean`, `POST /render` — every bearer/Host check reusing
  `@montaj/bridge-core`'s `bearerMatches`/`extractBearer`/`isAllowedHost`/
  `RateLimiter` rather than reimplementing them. `detection.ts` computes the
  backend (`metal-coreml`/`vulkan`/`cuda`/`cpu`) and latency tier A–D from an
  injected `SystemInfo` per `05-system-architecture.md` §7's table (Apple
  Silicon ≥16GB → A, Windows ≥8 cores/16GB+GPU → B, 4-8 cores/8GB → C,
  <8GB → D, local disabled). `ModelManager` (`model-manager.ts`) downloads
  manifest entries with resumable `Range` requests, verifies SHA-256 before
  an atomic rename into place (a checksum failure deletes the bad file and
  throws rather than risk running a tampered binary), enforces a disk budget,
  supports delete, and re-verifies every installed file's hash on launch
  (THREAT-MODEL T22). `discovery.ts` writes `~/.aksharo/engine.json` (0600,
  bearer, ephemeral port) — a file separate from the bridge's own
  `bridge.json`, reusing `aksharoDir()`/`generateBearerToken()` from
  `bridge-core`. `FakeBackend` (`backends/fake-backend.ts`) answers every
  route deterministically from a fixture manifest keyed by an `audio` path
  substring, so `apps/engine`'s full contract-test suite runs with zero real
  models on disk and the engine reports `modelsMissing: true` correctly with
  none present — the real whisper.cpp/Silero/deep-filter backends are C03b's
  to wire behind the same `EngineBackend` interface and exercise on real
  hardware. New package `packages/engine-client`: Zod schemas mirroring
  `apps/model-server`'s `/transcribe`/`/align` word shape plus the
  local-only routes, and a typed `EngineClient` (fetch + `ws`) for
  `apps/desktop` and `apps/web` to share verbatim. `tools/release`'s
  `build-desktop` gained an additive, dry-run-only step
  (`bundleEngineSupervisor`) that copies a built `apps/engine/dist` into the
  app tree's `resources/engine` (mac: `Contents/Resources/engine`) when one
  exists, reported via a new `engineBundled` result field; it never touches
  signing or `discoverNestedBinaries` (the copied tree is plain `.js`).
  **Open for C03b/A00-10:** the real whisper.cpp Metal/CoreML and
  Vulkan/CUDA backends, the quality gate (≤80ms median word-boundary error
  vs. the cloud aligner), and the faster-whisper Windows fallback are not
  implemented here — only their detection/versioning surface is, per the
  brief's own scope split.
- **C06b — Aksharo caption `.mogrt` authoring: frozen param table, generator,
  verifier, placeholder, style mapping mirrored with C08b.** No After Effects
  on the build host, so this ships everything except the binary `.aep`:
  `plugins/premiere-uxp/mogrt/params.ts` freezes the 14-param order (`Text`,
  `Font`, `Size`, `Colour`, `StrokeColour`, `StrokeWidth`, `ShadowOpacity`,
  `PositionY`, `HighlightColour`, `HighlightStart`, `HighlightEnd`, `StyleId`,
  `BoxFill`, `BoxOpacity`) C06 depends on — the first 12 are C06's own
  appendix table verbatim; `BoxFill`/`BoxOpacity` were appended (never
  reordering the original 12) once C08b's Resolve rule set landed mid-WP, so a
  whole-cue background box classifies the same real capability gap on both
  hosts instead of MOGRT blanket-rejecting every boxed style. `generate.ts`
  builds `definition.json` deterministically (golden fixture in
  `definition.golden.json`); `zip.ts` is a small dependency-free STORE-only zip
  reader/writer; `verify.ts` unzips a `.mogrt`, validates `definition.json`
  against the frozen table and reports mismatches by name/index, and checks for
  a `.aep` unless the file is marked `placeholder`; `build-placeholder.ts`
  builds the committed `mogrt/placeholder.mogrt` (definition + a `PLACEHOLDER.txt`
  note, no `.aep`); `verify-cli.ts` is the CI entry point
  (`pnpm --filter @montaj/premiere-uxp verify:mogrt`).
  `src/styles/classification-rules.ts` mirrors C08b's
  `plugins/resolve/aksharo_core_app/fusion/classification_rules.json`
  (same rule ids/predicates/status, reworded reasons for AE/Premiere), plus a
  `classification-rules.test.ts` check that it matches the canonical file
  byte-for-structure once `wp/C08b` is on `main`. `src/styles/mogrt-map.ts`
  applies those rules (plus one MOGRT-only font-bundling rule) to classify all
  30 `@montaj/caption-styles` system styles as supported/approximate/unsupported
  with reasons — **19 supported / 6 approximate / 5 unsupported**, matching
  C08b's own `RESOLVE-STYLE-COVERAGE.md` counts and per-style buckets exactly
  (checked against commit `704c92b` on `wp/C08b`); `generate-coverage.ts`
  writes `docs/MOGRT-STYLE-COVERAGE.md` deterministically. `docs/MOGRT-PARAMS.md`
  documents the frozen table, the `BoxFill`/`BoxOpacity` addition, and the
  `definition.json`/Adobe-EGP distinction; `docs/README-AUTHORING.md` is the
  step-by-step AE authoring guide for H-25 (a human task, not done here). One
  CI step (`.github/workflows/ci.yml`) verifies the placeholder.

- **C06 — Premiere Pro apply modes: transcript injection, MOGRT captions, alpha
  overlay, SRT to bin, cuts/zooms/audio, transactions, host-id map + re-sync.**
  `PremiereHost` (`plugins/premiere-uxp/src/host/premiere.ts`) grows the apply-mode
  surface — `importTranscript`, `insertMogrt`/`setMogrtParams`/`getMogrtParams`,
  `rippleDelete`, `setMotionKeyframes`, `importMediaToBin`/`placeOnTrack`,
  `replaceAudioRange`, `transaction`, `setItemMetadata`/`getItemMetadata`/
  `listAksharoItems`/`removeItem` — each cited to an Adobe UXP doc path,
  implemented deterministically in `MockPremiereHost` (including true
  snapshot/rollback for `transaction()`), and left throwing a clear
  `"... (Gate C)"` error in `createRealPremiereHost()`. New `src/apply/**`:
  `transcript.ts` builds an idempotent EDG→transcript import; `mogrtCaptions.ts`
  resolves the appendix param table by name (with an index-fallback helper for
  a host adapter that turns out to need it) and runs a start-up self-test that
  inserts a scratch MOGRT instance and confirms params round-trip;
  `alphaOverlay.ts`/`srtBin.ts` import a downloaded render/SRT into the bin;
  `cutsZoomsAudio.ts` ripple-deletes accepted cuts, converts decoded MKF2 rows to
  frame-relative Motion keyframes for accepted zooms, and replaces a cleaned-audio
  range; `runApply.ts` wraps a selected mode set in one `host.transaction`,
  reporting `apply.begin/step/commit/abort` to the bridge (rollback + abort on any
  thrown step) and computes dry-run preview counts (`planApply`); `resync.ts`
  diffs marker-guid host-id map entries against a fetched EDG revision, removing
  items whose segment is gone and flagging the rest `stale`/`upToDate` without
  re-applying anything on the caller's behalf. New panel component
  `src/ui/components/ApplyPanel.tsx`: one checkbox + dry-run count per apply mode,
  a mode disabled with a message (e.g. a failed MOGRT self-test), and an Apply
  button gated on at least one selection. `docs/GATE-C-CHECKLIST.md` gained a
  verification item per new host call. Per-word caption highlight
  (`HighlightStart`/`HighlightEnd` keyframes inside one MOGRT instance) is scoped
  down to `computeWordHighlightWindows` (the per-word time windows only) — real
  keyframing of a MOGRT's own component params is unverified until Gate C, flagged
  as a follow-up rather than invented. Native captions-track writing remains out
  of scope, per the brief.
- **C11 — Plugin licensing & devices UI: the activation card, and a
  `/plugins/manifest` stub for C10's download links.** `apps/api/src/
licensing/`: `GET /plugins/manifest` (public, `pluginManifest` operation) —
  the per-host channel manifest (`premiere-uxp`, `ae-cep`, `resolve-script`)
  the Plugins page and installer links read; every channel reports
  `available: false` with no download URL until C10 (installer builds and
  hosting) lands. B08's activation-limit enforcement, device revocation ->
  next-heartbeat-403 propagation, heartbeat-nonce replay refusal and the
  offline `licenseSnapshot`'s 7-day window with ±5 min clock-skew tolerance
  were already implemented and covered by its own e2e/unit suites — verified
  rather than re-built, per this WP's brief.
  `apps/web`: a new Plugins page (`app/(app)/plugins-app` — see routing note
  below) renders the activation card v2 (08 §4): one card per D65 product
  name ("Aksharo Panel — works with Adobe Premiere Pro and Adobe After
  Effects" and "Aksharo — works with DaVinci Resolve"), each with its
  Install/Connect/Caption-your-timeline steps, per-channel download links (or
  "Download coming soon" while `/plugins/manifest` reports a channel
  unavailable), the device list with "Sign out this device"/"Revoke", the
  plan's device-limit state with a `BillingUpgradeGate` upgrade link once
  reached, honest capability notes ("Premiere native captions track: waiting
  on Adobe", Resolve "Undo: not supported by Resolve's own API"), and B08's
  licence-key management merged onto the same page. A read-only Passes-tab
  licensing cue (`components/editor/passes/PluginActivationCue.tsx`) shows
  the same installed/not-installed/limit-reached state for the
  "Apply in Premiere/Resolve" affordance, sharing its derivation
  (`components/plugins/plugin-status.ts`) with the Plugins page — not wired
  into `PassesTab.tsx` itself, which is outside this WP's file boundary.
  **Routing note:** `(site)/(marketing)/plugins/page.tsx` (A24) already
  answers `/plugins` for a signed-out visitor, so the signed-in screen lives
  at the internal route `/plugins-app` and `middleware.ts` rewrites
  `/plugins` -> `/plugins-app` for an authenticated request, exactly like the
  existing `"/"` -> `/home` rewrite; fixed a latent middleware bug the same
  change exposed, where `PROTECTED`'s `"/p"` prefix matched `pathname.
startsWith()` on any `/p*` path (so adding `/plugins` to the matcher briefly
  sent a signed-out visitor to a redirect the marketing page should have
  answered) — `isUnderPath()` now requires a segment boundary.
  `packages/api-client`: `PluginManifestResponse`/`PluginManifestChannel`
  types, `endpoints.plugins.manifest`, `usePluginManifest()`.

- **C08 — DaVinci Resolve `aksharo_core`: Workspace ▸ Scripts launcher, in-Resolve
  loopback server, bridge client, Text+ captions, cuts, dynamic zoom, marker
  customData map.** New workspace `plugins/resolve` (Python 3.12, same
  `pyproject.toml`/`scripts/py.mjs` tooling as `apps/worker-ai`): the Resolve
  entry bootstrap `aksharo_core.py` (installed to Fusion's `Scripts/Utility`
  by C10) delegates to the real, unit-tested library `aksharo_core_app/`.
  `host/resolve.py` is the only module importing the real
  `DaVinciResolveScript` (lazily); `FakeResolveHost` mirrors the documented
  object model (ProjectManager → Project → MediaPool → Timeline →
  TimelineItem, plus a Fusion comp for Text+) so everything else — the Text+
  caption builder (`captions.py`, with an alpha-overlay fallback for styles
  A18a marks `assRenderable=false`), the accepted-cut applier (`cuts.py`,
  `Timeline.DeleteClips(items, ripple=True)`), the accepted-zoom applier
  (`zooms.py`, MKF2-decoded keyframes collapsed to Resolve's two-point Dynamic
  Zoom via `TimelineItem.SetProperty`), and the `{aksharo: {projectId,
segmentId|itemId, rev}}` marker `customData` re-sync mapping
  (`markers.py`) — is tested headless. `keyframes.py` ports
  `packages/edg/src/passes/keyframes.ts`'s MKF2 codec byte-for-byte
  (round-trip tested against fixture bytes produced by the TS encoder).
  `bridge/` is a `websockets`-based JSON-RPC 2.0 client for the C01 local
  bridge protocol plus a Python port of `apps/bridge/src/device-auth.ts`'s
  B08b device-code bootstrap (`clientKind: "resolve"`). `server.py` is the
  in-Resolve loopback JSON-RPC server (`host.info`, `timeline.current`,
  `apply.*`, ports 47841-47843, bearer from a new `~/.aksharo/resolve.json`
  discovery file distinct from the desktop bridge's). `tools/release/src/
commands/packageResolve.ts` now stages and zips the real `aksharo_core.py` +
  `aksharo_core_app/` tree (previously a placeholder `.lua` file) plus per-OS
  installer scripts. `docs/GATE-C-CHECKLIST.md` (new) records the manual
  first-run steps for a real DaVinci Resolve (Free and Studio) once human
  spike A00-04 reports; several Resolve-side assumptions (the Utility-script
  `resolve` global on Free, whether a loopback server may run inside Resolve,
  the exact `SetProperty` keys Dynamic Zoom keyframes, and the absence of a
  scriptable undo-transaction API) are called out there and in
  `plugins/resolve/README.md` as unverified pending that spike.
- **C08b — Resolve Fusion Text+ macro authoring, style→param mapping, style
  coverage report.** New `plugins/resolve/aksharo_core_app/fusion/`:
  `macro.py` generates and parses `AksharoCaption.setting`
  (`scripts/generate_macro.py`; golden-file + round-trip tested) — a
  deterministic Text+-based Fusion macro with 11 published inputs (`Text`,
  `Font`, `Size`, `Colour`, `StrokeColour`, `StrokeWidth`, `ShadowOpacity`,
  `PositionY`, `HighlightColour`, and keyframed `HighlightStart`/
  `HighlightEnd` character-range highlight timing) plus a `StyleId` comment;
  there is no Resolve/Fusion on this build host, so the generator emits and
  parses a small, explicitly-documented text subset rather than Fusion's real
  `.setting` grammar byte-for-byte (real-Fusion verification is
  `docs/GATE-C-CHECKLIST.md` §8). `style_map.py` classifies each of the 30
  `@montaj/caption-styles` documents (font onto a bundled OFL font from
  `@montaj/fonts`, plus supported/approximate/unsupported against Text+'s
  capabilities) using the explicit predicate table in
  `classification_rules.json` — the same table C06b mirrors for its Premiere
  MOGRT style→param mapping — and writes
  `plugins/resolve/docs/RESOLVE-STYLE-COVERAGE.md`
  (`scripts/generate_style_coverage.py`; 19 supported, 6 approximate, 5
  unsupported of 30). Every style still reaches picture regardless of this
  classification: C08's alpha-overlay fallback is unchanged.
  `aksharo_core_app/captions.py`'s `build_segment_item` now uses the macro
  (via `fusion_macro_available()`) when installed, adding
  `fusion_macro`/`highlight_color`/`highlight_keyframes` to the existing
  minimal params dict, and falls through to the C08 minimal Text+ path
  unchanged when it is not; `CaptionStyle.highlight_color` and
  `CaptionSegment.word_highlights` are new optional fields (both default to
  `None`/prior behaviour). `plugins/resolve/installer/manifest.json` (new)
  lists the macro file and the per-OS Fusion `Macros` folder destinations for
  C10's installer to copy it into; `tools/release`'s existing
  `packageResolve.ts` already stages the whole `aksharo_core_app/` tree, so
  the new `fusion/` subpackage (including the generated `.setting`) is
  included in `pnpm release package-resolve --dry-run` with no change there.
- **C05a — Premiere Pro UXP plugin foundation.** New workspace
  `plugins/premiere-uxp` (`@montaj/premiere-uxp`): UXP manifest v5
  (`ai.aksharo.panel`, host `PPRO` min `25.6`, minimal `requiredPermissions`
  — no clipboard, no `launchProcess`, network limited to the API origin and
  the loopback bridge ports 47831–47833); every UXP/Premiere-specific call is
  isolated behind `src/host/premiere.ts`'s `PremiereHost` interface, with
  `MockPremiereHost` exercised by every test and `createRealPremiereHost()`
  written (typechecks) but throwing on `requestMixdown`/`readFile` until the
  A00-03 human spike confirms the underlying EncoderManager/file-system calls
  (`docs/GATE-C-CHECKLIST.md`). Bridge sign-in: a typed JSON-RPC caller over
  `@montaj/bridge-core`'s protocol (`src/bridge/client.ts`) plus a `fetch`-based
  production transport (`src/bridge/httpTransport.ts`); `src/auth/session.ts`
  is a device-code/tray-gesture pairing state machine that holds the session
  **in memory only** (THREAT-MODEL T13 / D25 — a deliberate deviation from the
  WP brief's "UXP secure storage" line, documented in the plugin README).
  Sequence/in-out/selection reads, an audio-mixdown-to-transcribe pipeline
  (`src/upload/mixdown.ts`: mixdown → `media.uploadTicket` → presigned PUT →
  `POST /transcribe`), a `/plugins/manifest` min/max-version update banner
  (`src/version/manifestCheck.ts`), and a React panel UI (sign-in, source +
  "Transcribe this sequence", status/progress, open-in-web-editor link,
  footer version line with the D65 non-affiliation copy) round out the
  foundation. `src/i18n/strings.ts` is this package's own English/Hindi
  string table (no shared `packages/i18n` exists yet). Coverage gate 60/50
  lines/branches (CONTRACTS §9's `apps/web` UI tier) added via
  `coverageThresholds()` in the package's own `vitest.config.ts`.

- **B10b — Audio clean wiring: `SetAudio.clean.cleanId`, Audio panel mounted,
  audio parity gate, API e2e, RSS bound.** `packages/edg`: `AudioCleanSchema`
  (`schemas/document.ts`) gains a first-class `cleanId` field (CONTRACTS §2,
  amended 2026-09-03), replacing B10's interim `preset: "b10:<cleanId>"`
  encoding; the EDG v2 loader (`migrations/migrate.ts`) rewrites any stored
  document still carrying that encoding on load, and
  `exports.service.ts#resolveAudioClean` reads `cleanId` directly (falling
  back to the old `preset` form belt-and-braces). `apps/web`: the editor's
  right panel gains an "Audio" tab (`RightPanel.tsx`) mounting B10's
  `AudioPanel`, wired to the editor's `EdgOpQueue` via a new `onSetAudio`
  handler in `editor-client.tsx` (undoable, like every other panel op);
  `use-audio-clean.ts`'s `applyCleanOp`/`clearCleanOp` now build
  `{clean: {enabled, cleanId, targetLufs}}` instead of the preset string. D82:
  the panel exposes a Quick clean / Deep clean tier toggle, greying Deep clean
  out with "coming to cloud renders" copy until the server-read
  `AUDIO_DEEP_CLEAN_ENABLED=1` (new env var, `.env.example`) is set. Parity:
  `apps/render/parity/audio-parity.ts` hashes the audio bytes the browser
  export path (`sources.cleanedAudioUrl`) and the cloud render path
  (`manifest.audio.cleanKey`) would each mux in for `audio.strategy:
"replace"`, reporting a match; `parity:audio` writes this package's
  `parity/results.json` `audio` block (render README documents both parity
  sections). `apps/api/test/audio.e2e-spec.ts`: clean → simulated worker
  completion → signed URLs and metrics → `SetAudio.clean.cleanId` applied →
  a browser export's manifest and sources carry the cleaned track, end to
  end against real Postgres/Redis. `apps/worker-ai`: fixed a real defect the
  orchestrator's addendum flagged after a host-memory-pressure failure —
  `true_peak_dbtp` oversampled the _whole_ reassembled signal 4x in one
  `np.interp` allocation (~5.5 GB at 60 minutes), defeating
  `run_clean_chain`'s 10-minute denoise chunking entirely; `true_peak_dbtp`
  and `integrated_loudness`'s high-pass stage (`clean/dsp.py`) now measure in
  bounded 30 s windows with boundary carry-over, and a new `slow`
  (`RUN_SLOW=1`) test asserts < 2 GB peak RSS over baseline on a synthetic
  60-minute file (`psutil`, added to worker-ai's dev deps).

- **B19b — Reframe/zoom wiring: one keyframe codec, keyframe storage, `zoom`
  pass type, word-timed emphasis cues, frame/RMS sampling from the proxy.**
  `packages/edg`: `src/keyframes.ts` (`MKF1`) is deleted — `src/passes/
keyframes.ts`'s `encodeKeyframes`/`decodeKeyframes` (`MKF2`) is the only
  packed-keyframe codec now; `schemas/pass.ts`'s `PassTypeSchema` gains
  `"zoom"`, and `ZoomPayloadSchema`/`ReframePayloadSchema` accept exactly one
  of `keyframes` (base64 inline, <= 64 KiB) or `keyframesRef` (derived
  storage) per the amended CONTRACTS §2 keyframe payload rule.
  `apps/worker-ai`: `worker_ai/passes/frame_sampling.py` (new) samples video
  frames and RMS audio energy from the 540p proxy at 10 Hz, downscaled to
  <= 320 px wide (piped as raw `rgb24`, no JPEG round trip); `processors/
reframe_zoom_pass.py` calls it (`_sample_from_proxy`) whenever the producer
  sent no `detections`/`sceneFrames`/`rmsSamples`, feeds frames through
  `BrightBlobDetector` (gated behind `PASS_FACE_DETECTOR=yunet` +
  `PASS_FACE_DETECTOR_WEIGHTS` for a real detector, unprovisioned this WP,
  H-22), and packs `MKF2` (`pack_keyframes`, now `{tMs, zoom, cx, cy, ease}`
  rows); `_keyframe_storage_fields` mints each item's id and decides inline
  vs. an `ObjectStore.upload` to `ws/{workspaceId}/passes/{passId}/{itemId}.mkf`
  (CONTRACTS §6). `apps/worker-media`: `src/frames/sample.ts` (new) — a
  10 Hz, <= 320 px JPEG filmstrip helper via ffmpeg's `fps` filter, for a TS
  consumer (worker-ai samples the proxy itself instead, in-process). `apps/api`:
  `passes.service.ts`'s `startZoom`/`startReframe` reject a project with no
  proxy (`passes/proxy_required`, 409) and resolve emphasis cues to the
  emphasised word's own `s` (`emphasisCuesOf`, was the segment's `startMs`);
  `passes-completion.handler.ts` lands a zoom pass as `type: "zoom"` (was
  `"reframe"`) and implements the inline/derived keyframe payload rule instead
  of computing an unwritten `keyframesRef`. `prisma/schema.prisma`'s
  `PassType` enum gains `zoom` (migration `20260903120000_b19b_zoom_pass_type`).

- **C01 — Local bridge v2: `packages/bridge-core` + `apps/bridge` (Node SEA);
  relay-first WSS; loopback HTTPS + per-install cert; pairing; api
  `bridge-relay` module.** `packages/bridge-core`: a JSON-RPC 2.0 protocol
  (`hello`, `pair.request`/`pair.confirm`, `session.exchange`, `host.list`,
  `engine.status`, `fs.pickMedia`, `media.stat`/`uploadTicket`,
  `transcript.push`, `apply.begin/step/commit/abort`, `events.subscribe`) with
  zod schemas for every method; a loopback HTTPS+WS server on the first free
  port of 47831-47833 bound to `127.0.0.1` with bearer-on-every-route
  (constant-time compare), `Host` allowlist, `Origin` allowlist (`null` never
  allowed, Chrome Local Network Access header only for allowlisted origins),
  message-size and rate limits; a per-install self-signed leaf certificate
  (RSA 2048 — see the ECDSA P-256 deviation note in `cert.ts`) cached under
  `~/.aksharo/cert/` and fingerprinted into the `~/.aksharo/bridge.json`
  discovery file (mode 0600); tray-gesture pairing with an 8-character
  code fallback and 12-hour HMAC-signed scoped pair tokens, revocable by
  `clientId`; a relay client (`RelayClient`) with heartbeat and jittered
  exponential-backoff reconnection; a small documented public API
  (`BridgeCore`: `start`/`stop`/`getStatus`/`status` events/pairing) that is
  the only surface `apps/bridge` and the desktop shell (C02) import. 45 tests,
  85.7%/82.2% line/branch coverage (threshold 75/70). `apps/bridge`: the Node
  22 SEA wrapper (`main.ts` + `config.ts` for `~/.aksharo/config.json`);
  `scripts/build-sea.mjs` bundles with esbuild, runs
  `--experimental-sea-config`, and injects the blob with `postject`; smoke
  tested locally on Windows (binary starts, binds a loopback port, writes a
  valid discovery file, exits clean) and wired into CI as the `bridge-sea`
  matrix job (Windows + macOS) via `scripts/ci/bridge-sea-smoke.mjs`. A real
  system tray (brief §5) is not implemented — `createConsoleTray` is the
  documented headless fallback; see the WP report for why and what a
  follow-up needs. `apps/api/src/bridge-relay`: the `/bridge/relay` WS module
  pairing one bridge connection to one client connection per workspace and
  forwarding opaque JSON-RPC text between them (payloads are never parsed or
  stored), with bearer/rate-limit/message-size guards, heartbeat, and a
  `bridge_sessions` audit table (new Prisma model + migration
  `20260902195854_c01_bridge_sessions`); e2e-tested against real Postgres with
  a fake bridge and fake client. Deviation: the brief assumes a per-device
  bridge token: CONTRACTS §5's `sub` claim is always the user id and B08
  registers devices by fingerprint under a normal user session rather than
  minting one token per device, so relay pairing is keyed by
  workspace+user (one paired bridge per signed-in user per workspace) until a
  follow-up work package adds a real per-device bridge credential — see the
  WP report's open questions.
- **C01b — Bridge follow-ups: native tray for standalone installs, OS
  keychain/DPAPI for the per-install key, CI matrix dry run.** `apps/bridge`:
  a real system tray (`native-tray.ts`) via `systray2` (MIT) — a prebuilt
  per-OS helper binary spawned over stdio, the only tray option compatible
  with the Node SEA bundling model (a native addon has no stable path once
  `esbuild` folds everything into one `dist/bundle.cjs`); `build-sea.mjs`
  copies `systray2`'s helper binaries into `dist/traybin` next to the
  packaged executable. Falls back to `bridge-core`'s console tray on Linux
  with no `DISPLAY`, in any `CI` environment, if the helper binary is
  missing, or if the helper fails/times out (3 s) — the CI-env skip exists
  because the tray helper was observed to hang indefinitely on this runner
  outside that guard, which would otherwise make the `bridge-sea` matrix job
  flaky. `packages/bridge-core`: a `KeyStore` interface (`keystore.ts`) with
  `KeychainKeyStore` (macOS, shells out to `security`), `DpapiKeyStore`
  (Windows, shells out to `powershell.exe`'s
  `System.Security.Cryptography.ProtectedData`), `FileKeyStore` (the
  original `0600` file, kept as the documented fallback) and
  `InMemoryKeyStore` for tests; `createDefaultKeyStore()` probes the
  platform-appropriate backend once and falls back to the file store if the
  probe fails. No new native/npm dependency: a real keychain client library
  is a native addon on every OS, incompatible with the SEA bundle for the
  same reason a native tray is. `cert.ts`'s `loadOrCreateCertificate` now
  stores the private key through a `KeyStore` (defaulting to
  `createDefaultKeyStore()`) instead of a plaintext file, migrating an
  existing plaintext `leaf.key.pem` into the key store (and deleting it) on
  first run so existing pairings survive the upgrade; it is now `async`.
  CI: `.github/workflows/ci.yml` gained `workflow_dispatch: {}` so the
  `bridge-sea` job (and the rest of the matrix) can be re-run manually
  without an empty commit; the local dry-run steps are documented in
  `apps/bridge/README.md`. `apps/desktop/src/bridge/adapter.ts`: replaced the
  pre-C01 stub with `createBridgeAdapter`, a real `BridgeAdapter` wrapping
  `BridgeCore` (`createStubBridgeAdapter` is kept for a "bridge disabled"
  caller). Documented interface gap: `approvePairing`'s `BridgePairResult`
  predates `bridge-core`'s actual protocol — a local/tray approval only
  flips a pairing to `"approved"`; the pairing _client_ mints its own
  `clientId` by calling `pair.confirm` afterwards, so the approver never
  observes that id synchronously. `createBridgeAdapter` returns the
  `pairingId` in its place (documented, not the wire `clientId`) rather than
  inventing an unverified shape — flagged for whoever wires this into C02's
  UI. 12 new tests across the three packages (bridge-core: `keystore.test.ts`
  - cert migration tests; apps/bridge: `native-tray.test.ts`; apps/desktop:
    two new `createBridgeAdapter` cases), all suites green.
- **C02b — Desktop shell follow-ups: real bridge adapter wiring, pairing
  approval UX, `approvePairing` contract, Electron e2e in CI, packaging via
  C00.** Resolves the C01b/C02 interface gap: `packages/bridge-core`'s
  `BridgeCore` now emits a `clientConnected` event (`{pairingId, clientId,
clientKind}`) once `pair.confirm` mints the real wire `clientId` (in-process
  only — no wire `events.subscribe` broadcast transport exists yet;
  `BridgeEventKind`/`events.subscribe` stay schema-only in `protocol.ts`).
  `apps/desktop/src/bridge/adapter.ts`: `approvePairing(pairingId)` now
  returns `{pairingId, approved: true}` (no `clientId`) per the ruling; added
  `denyPairing(pairingId)`, `onPairingRequested` (fires with the pending
  pairing's code/clientKind/clientName/expiresAt) and `onClientConnected`
  (fires once the real `clientId` is known) to `BridgeAdapter`. New pairing
  approval window (`src/main/pairing-window.ts` + `pairing-approval.{html,ts}`
  - `pairing-preload.ts`): a small, focused window showing the code and
    client name/kind, Approve/Deny buttons, 60s auto-deny — its own minimal
    `contextIsolation`/`sandbox` preload, no new privileges on the main hosted
    renderer (THREAT-MODEL T25). Tray (`src/tray/index.ts`) gained a
    `hasPendingPairing()`-driven "Approve pairing…" item that re-focuses the
    approval window; `main/index.ts` wires tray/approval-window/preload to
    whichever `BridgeAdapter` is active and can swap the stub adapter for a real
    one at runtime (`attachRealBridge`) once a device/bridge-token exists.
    New device bootstrap (`src/bridge/device-bootstrap.ts`): registers this
    install (`POST /devices/register`, B08) and mints a `kind:"bridge"` token
    (`POST /devices/{id}/bridge-token`, B08b) given a user access token, caching
    both (plus a generated per-install fingerprint) in `bridge-core`'s OS
    keystore so a restart skips re-registration until the lease needs
    refreshing; never logs the token in plaintext. The access-token hand-off
    itself (`desktop:bridge-provide-access-token` IPC/preload
    `bridge.provideAccessToken`) is wired on the desktop side only — the hosted
    web app calling it is out of this WP's `apps/desktop/**` boundary (open
    question for whoever owns that `apps/web` integration). CI:
    `.github/workflows/release-desktop.yml` gained an `e2e` job (mac/win
    matrix, real runners) running `pnpm --filter @montaj/desktop build`,
    `electron-builder --dir`, then the Playwright-Electron smoke — the smoke
    stays a documented manual step locally
    (`pnpm --filter @montaj/desktop test:e2e`), since it needs a real Electron
    runtime/display this sandbox doesn't have (ran it here: fails with "Process
    failed to launch!", consistent with the brief's "Chromium network-service
    crash under container restrictions" note, reproduced twice as instructed
    then stopped). Packaging: `tools/release/src/commands/buildDesktop.ts`'s
    `ensureAppTree` now prefers a real `electron-builder --dir` output under
    `<desktopAppDir>/release` (`findRealElectronBuilderOutput`) over the
    synthesized placeholder tree, falling back to the placeholder when no real
    output is present yet — verified with new tests
    (`tests/buildDesktopRealOutput.test.ts`) constructing a fake real tree.
    **Known blocker, not introduced by this WP:** running the real
    `electron-builder --dir` in this pnpm workspace fails before producing
    output — `node_modules/@montaj/{bridge-core,config}` are pnpm symlinks
    whose real path resolves outside `apps/desktop/`, and app-builder-lib's
    asar packager throws `"<file> must be under <appDir>"` for their contents.
    Reproduces with only pre-existing C01/C02 dependencies; flagged for C00
    (release pipeline owner) rather than worked around — the standard fix
    (`pnpm deploy`, an app-local hoisted linker, or bundling the main process)
    is bigger than this WP's boundary. The new CI `e2e` job's
    `electron-builder --dir` step will likely hit the same failure until that's
    fixed. 25 new/changed tests across bridge-core, apps/desktop and
    tools/release, all suites green (`pnpm lint`/`typecheck`/`format:check`
    scoped to touched packages).
- **B08b — Per-device bridge credential: `kind:"bridge"` tokens carry
  `deviceId`; relay pairing keyed per device (resolves C01's deviation).**
  `TokenService.mintAccessToken` now requires (and `verifyAccessToken`/the
  interim realtime verifier both parse) a `deviceId` claim whenever
  `kind === "bridge"` (CONTRACTS §5, amended 2026-09-03); minting one without
  it is refused. New `POST /devices/{id}/bridge-token`: for a registered,
  leased device the caller owns, mints that bridge token; refuses with
  `licensing/device_revoked` (the device was revoked) or
  `licensing/device_lease_expired` (its lease needs renewing first, via
  `POST /devices/register`) — the same `licensing/device_revoked` code
  `plugins.service.ts`'s heartbeat already used. `bridge-relay.gateway.ts`:
  pairing is now keyed by `workspaceId:deviceId` instead of
  `workspaceId:sub`, and `handleUpgrade` refuses a bridge token without
  `deviceId` before it ever reaches the connection map — several devices for
  the same user now pair and relay concurrently (e2e: two devices, one user,
  both attached and relaying independently). Guard rail: `JwtAuthGuard`
  refuses a `kind:"bridge"` token on any route unless it opts in with the new
  `@AllowBridgeToken()` decorator; nothing does yet, so this is a flat
  refusal today (contract test in `common/guards/guards.test.ts`).
  `apps/bridge`: a new `device-auth.ts` gets this install its own credential
  on first run — the RFC 8628 device-code grant as `kind:"desktop"` (a
  bridge-kind device code is never redeemed directly: no device row exists
  yet at that point, and `mintAccessToken` would refuse it), then
  `POST /devices/register`, then `POST /devices/{id}/bridge-token` — and
  re-mints the bridge token on later runs via `POST /auth/refresh` without
  the pairing screen again, falling back to a fresh sign-in once the stored
  refresh token is no longer good for anything; `config.ts` gained
  `apiOrigin`/`deviceId`/`sessionRefreshToken`/`deviceTokenExpiresAt`
  alongside the existing `deviceToken`/`relayUrl`/`autostart`. Deviation
  (documented, out of this WP's file boundary but required for the
  acceptance criteria): `AccessTokenClaims`/`AuthPrincipal`
  (`common/guards/principal.ts`), `JwtAuthGuard`
  (`common/guards/jwt-auth.guard.ts`, `public.decorator.ts`) and the interim
  realtime verifier (`realtime/auth/access-token.ts`) all needed the
  `deviceId` claim and the bridge-token guard rail threaded through; each
  change is additive (a new optional field, a new decorator) and does not
  alter behaviour for any other `kind`.
- **B20 — Passes tab, ProposalCard, bulk accept, timeline lanes; export application
  of accepted cuts/zoom/reframe through `@montaj/timemap` (browser + cloud).**
  - **Review UI** (`apps/web/components/editor/passes/**`): `PassesTab` (run-autocut
    dialog with a client-side credits estimate, kind/status/confidence filters, bulk
    accept — "Accept all ≥ 0.8", "Accept all cuts", "Reset decisions" — a summary bar,
    J/K/A/R/Space keyboard review) and `ProposalCard` (reason, confidence,
    accept/reject/undo, a before/after preview callback seam). Decisions are real
    `DecideItems` ops sent through the existing `EditorStore.submitOps` (A12's
    debounce/optimistic-apply/rebase path, unmodified). `apps/web/lib/passes/**`:
    `decisions.ts` (pure op-builder + filter/bulk-accept predicates + `summaryDurations`
    over `@montaj/timemap`), `client.ts`/`quote.ts` (the `startAutocutPass` endpoint
    descriptor + a client-side quote estimate), `realtime.ts`
    (`usePassRunProgress`, a `job.progress`/`job.completed` subscription).
  - **Timeline lanes** (`apps/web/lib/timeline/lanes.ts`, `components/editor/timeline/
Timeline.tsx`, extending A17): the merged "Zoom & reframe" lane split into
    separate `zoom`/`reframe` rows; `laneItemStrokeStyle` — accepted dimmed +
    struck-through, proposed dashed; hover reports an item's reason
    (`onHoverPassItem`) and click selects it (`onSelectPassItem`).
  - **Export application, browser + cloud** — the render-manifest schema gained an
    optional `timemap.keyframes: KeyframeTrack[]` field (`{itemId, itemStartMs,
kind, packed}`, base64 of B19's real `@montaj/edg` `passes/keyframes.ts`
    ("MKF2") rows). `packages/render-core`'s new `frame/crop-window.ts`
    (`sampleCropWindow`, pure interpolation + easing over a normalised source crop
    rect) and `frame/keyframe-track.ts` (`outputCropKeyframesFromTracks`: decode +
    remap onto the output clock via `TimeMap.mapKeyframes`, pinning at every
    splice) are the one implementation both `apps/web/lib/export/engine.ts`
    (samples the crop window per frame, draws the corresponding sub-rect of the
    cover-fit source canvas) and `apps/render`'s ffmpeg graph (a hand-verified
    `crop=w:h:x:y` expression builder, `ffmpeg/crop-expr.ts`, spliced before the
    cover-fit scale) consume — proven to agree via
    `apps/render/src/ffmpeg/crop-parity.test.ts`'s two fixtures (cut+zoom,
    cut+reframe).
  - **Output-length verification** (B18's leftover TODO): `apps/web/lib/export/
output-length.test.ts` proves only `accepted` cut items shorten
    `fromAcceptedItems`' `outputDurationMs`.
  - **Known gaps, reported not fixed here:** (1) the API's manifest builder
    (`apps/api/src/exports/manifest-builder.ts`) has the additive
    `keyframeTracks` field wired but nothing populates it from accepted
    zoom/reframe items yet — blocked on B19's keyframe-bytes storage (its own
    final report already flags this as the "keyframesRef gap"); (2) drag-to-adjust
    cut boundaries needs an `EditPassItem` op that does not exist in CONTRACTS §2 —
    not added unilaterally, per the brief's own instruction to report first;
    (3) A18a's parity gate (`packages/ass-exporter/parity`) measures caption
    _style_ rendering fidelity and has no axis for "a cut/zoom was applied" — the
    crop-window parity is proven separately (above) rather than forced into that
    harness; (4) the CanvasKit preview's live zoom-rectangle/reframe-crop-window
    overlay and "preview with cuts" scrubbing are not implemented — the shared
    crop-window primitives are ready for that integration.
- **B18b — Protected ranges end to end: `SetProtectedRanges` op, editor
  marking UI, passes honour the stored set.** `packages/edg`: `EdgHot.protected[]`
  (CONTRACTS §2) and the `SetProtectedRanges{ranges:[{id,s,e}]}` op — apply
  clamps every range to the primary media's duration, merges overlapping or
  touching ranges, drops empty ones, and stamps `reason: "user"`; rebase adds
  the `doc:protected` field (last write wins); a property test
  (`ops/properties.test.ts`) holds the stored set sorted and non-overlapping
  after any sequence of ops; `edg-v2.json`/`edg-ops-v2.json` regenerated.
  `apps/api/src/passes/passes.service.ts`: `protectedRanges` sent to every
  `ai.pass` is now the stored `EdgHot.protected` set concatenated with the
  existing emphasis/textOverrides-derived `guardedRanges`; e2e in
  `passes.e2e-spec.ts` proves a `SetProtectedRanges` op reaches the enqueued
  autocut job's `protectedRanges`. `apps/web`: `lib/edg/ops.ts` gets
  `setProtectedRanges`, `toggleProtectedRange` (adds, merges, subtracts or
  removes a range against the current selection) and `isFullyProtected`, plus
  a `SetProtectedRanges` inverse for undo; `Timeline.tsx` draws a
  `--color-info` band for every protected range and wires the "P" key (and a
  "Protect (P)" button) to toggle protection on the selected segment or word;
  one chromium Playwright case in `timeline.spec.ts`.
- **B12 — Academy tracks, Help centre, in-app Changelog and What's-new, and
  support tickets with diagnostics.** Four outcome-based Academy tracks (MDX,
  `apps/web/content/academy/**`) with step-by-step progress
  (`academy_progress`), a one-time per-track credit reward
  (`academy_rewards`, capped 25/track and 100/workspace lifetime, granted via
  `CreditsFacade.grantLot({ source: "adjust", ... })` — CONTRACTS §4 has no
  `"academy"` source, flagged as a conflict) and automatic completion on
  `export.completed`; ten real Help articles (`apps/web/content/help/**`)
  with a build-time MiniSearch index and a "Contact support" entry; an
  in-app `/updates` changelog (renamed from `/changelog`, which the
  marketing site already owns) sourced from MDX plus an RSS feed and a
  per-user "What's new" modal (`changelog_dismissals`);
  `POST/GET /support/tickets`
  (`support_tickets`) with an optional consent-gated diagnostics bundle
  (app version, browser/OS, workspace id, last 10 job statuses, a
  console-error ring buffer — never media), emailed to `BRAND.supportEmail`
  via a new `notify` kind (`support-ticket-created`) and listed back in
  Settings → Support.
- **C00 — Signing & release pipeline (dry-run only; credentials do not exist yet).**
  New `tools/release` package (`@montaj/release`) exposing `pnpm release <cmd>`:
  `version` (conventional-commit semver bump + `CHANGELOG.md` section assembly),
  `build-desktop --platform mac|win --channel alpha|beta|stable --dry-run`
  (electron-builder config generated from one root `release.config.ts`; builds
  against a placeholder app tree when `apps/desktop` has no code yet),
  `sign-nested` (walks a built app and signs/verifies every Mach-O/PE binary —
  main, helpers, engine sidecar, ffmpeg, bridge SEA, updater — outer bundle
  last), `notarize` (notarytool submit/wait/staple; records a ledger entry and
  enforces the **24h buffer** before the `stable` channel, `--force --reason`
  to override), `package-ccx` (UXP plugin -> `.ccx` zip, `manifest.json`
  validated against `ai.aksharo.panel` / Premiere minVersion 25.6),
  `sign-zxp` (AE CEP panel -> `.zxp`, ZXPSignCmd in signed mode / self-signed
  dev-cert marker in dry-run), `package-resolve` (`aksharo_core` script +
  per-OS installer scripts), `sbom` (CycloneDX document), `checksums`
  (`CHECKSUMS.sha256` + HMAC-signed `SIGNATURES.txt`), `publish --channel`
  (artifacts + `latest.yml`/`latest-mac.yml` electron-updater feeds; `.release/publish/<channel>`
  locally in dry-run, R2 in signed mode), `promote --from --to` (channel
  promotion; re-checks the 24h gate for `stable`), `verify-release`
  (re-hashes a published channel against its checksum manifest).
  `SignProvider` interface with `AzureTrustedSigningProvider` (brief default),
  `DigiCertKeyLockerProvider` (practical default — see "Known gap" below) and
  `MacDeveloperIdProvider`, all behind `RELEASE_MODE` (`dry-run` default,
  never touches a real signer/notarytool/R2; `signed` fails closed —
  `ReleaseFailClosedError` — listing every missing secret). New GitHub
  Actions workflows `release-desktop.yml` (mac/win matrix, unsigned dry-run
  on PRs, signed only on `release/*` tags behind `release-mac`/`release-win`
  environments), `release-plugins.yml` (ccx/zxp/resolve), `promote.yml`
  (manual channel promotion with the 24h check) plus SLSA provenance
  attestation (`actions/attest-build-provenance`). `docs/RELEASE.md` runbook.
  Adds `tools/*` to the pnpm workspace and a root `pnpm release` script.
  **Known gap (reported, not fixed here):** RR-07 §P0 — Azure Trusted
  Signing public-trust certs are not issued to an Indian entity (D69), so
  `WIN_SIGN_PROVIDER=digicert-key-locker` is the practical default until
  that changes or the entity structure does; `AzureTrustedSigningProvider`
  still ships per the brief with the same fail-closed secret gate.
  **CONTRACTS §1 ruling (2026-09-03):** the ~20 release-pipeline secret names
  (Apple notarisation, Azure/DigiCert signing, ZXP, R2 publish,
  checksum-manifest signing) are CI/GitHub-environment secrets, not
  application runtime config, so they do **not** go into CONTRACTS §1 or the
  root `.env.example` (that would fail `packages/config`'s one-key-per-contract-
  variable parity test). They live in `tools/release/.env.example` instead;
  the CLI loads `tools/release/.env` itself (`src/env.ts::loadReleaseDotEnv`).
  `docs/RELEASE.md` lists them as the GitHub-environment secrets to set.

- **B14b — Webhook events: real event emits replace the poller.**
  `transcript.completed` (`transcripts/transcribe.handler.ts`), `job.failed`
  (`jobs/jobs.service.ts::complete()`, after DLQ handling) and `credits.low`
  (`credits/credits-low-balance.notifier.ts`) are now real `EventEmitter2`
  emits at their producers, each with its own `<module>/*.event.ts` name +
  payload contract (the `referrals/export-completed.event.ts` precedent) and
  a `webhooks/listeners/*.listener.ts` subscriber. `WebhookEventPollerService`
  and its Redis cursors are deleted; `webhooks.e2e-spec.ts` proves the whole
  chain (API key → `/v1` project → simulated worker completion → a signed
  delivery a receiver can verify, plus retries on a receiver that fails
  twice) end to end. `WebhookDeliveryService.sendOverride` is a new,
  production-inert test seam (parallel to `sendWebhook`'s own resolver/
  transport seams) that lets that suite's in-process receiver stand in for a
  real internet endpoint without touching the SSRF guard.
- **B15 — share links, threaded review comments, intermediary-hygiene report
  flow and batch orchestration.** `ShareLinksService`/`PublicViewerController`
  add a `scope` (`view|comment|approve`), password (argon2), expiry, view-cap
  and `clientTag` to `share_links` (previously A12/B16 groundwork only), and
  the public `/s/:token` surface: resolve, password unlock (`X-Share-Session`
  header, HMAC-signed, no cookie middleware added), report-abuse
  (`share_reports`, category-driven SLA — 3h NCII / 36h other, matching
  `ShareReportSlaTask`) with automatic disable after 3 pending reports, and the
  approve/request-changes decision (new `projects.review_status`).
  `CommentsService`/`CommentsController` add threaded, time-anchored comments
  reachable from a workspace member or a public `comment`/`approve`-scope
  reviewer (a guest's email is hashed, never stored), notifying the project
  owner via the existing `share-comment` notify kind.
  `BatchService`/`BatchController` add `/batch/quote`, `/batch` (tags the
  projects `POST /projects/batch` already creates with a new `batches` row and
  `projects.batch_id`) and `/batch/:id/apply` (enqueues `TranscriptsService.
transcribe()` per project), plus `/batch/:id` for per-project progress.
  Migrations: `20260903000000_b15_share_review_batch` (share-link scope/
  password/expiry/views/client-tag, `comments.author_email_hash`,
  `projects.review_status`), `20260903001000_b15_batch` (`batches`,
  `projects.batch_id`). Replace-media re-alignment and import-transcript-align
  (brief §5, §6) are not implemented in this work package — see its final
  report.
- **B11b — LLM follow-up reconciliation: per-kind burn rates, one filler
  lexicon, EDG-segment transcript payload.** `packages/config/src/credits.ts`:
  the flat `chaptersSummaryHook` burn rate (2 credits/job for every kind) is
  retired in favour of three per-kind operations — `insightsChapters` (2),
  `insightsSummary` (1), `insightsHooks` (2) — now the single source for
  insight pricing; `apps/api/src/insights/insights.quote.ts` reads them
  through `creditCostTenths` instead of carrying its own local table, and
  `03-architecture/04-pricing-and-monetization.md`'s credits table row is
  updated to match. `packages/prompts`: B11's flat, in-code
  `src/lexicon/fillers.ts` word arrays are deleted; `src/lexicon/index.ts`
  (`loadFillers(language)`, `loadLexiconFile`, `lexiconLanguages`) reads B18's
  richer per-language JSON lexicon (`packages/prompts/lexicons/fillers/*.json`)
  directly, so the package has one filler lexicon instead of two that could
  drift apart (the worker's `autocut.py::load_lexicon` already read the JSON;
  no import-path change was needed there). `apps/api/src/insights/insights.service.ts`:
  the `ai.llm` job's transcript payload is now built from the project's EDG
  caption segments when it has one — each live segment's
  `startWordId`/`endWordId` resolved to text via `EdgRepository.projectionOf`
  and `loadChunks` (the same read path `ExportsModule` uses) — so the
  templates see the creator's edited captions (cuts, re-segmentation, text
  fixes already applied) rather than the raw ASR chunks; a project with no EDG
  document yet (or one with no live segments) falls back to the original
  `TranscriptsService.chunks()` path unchanged.
- **C02 — Desktop shell.** `@montaj/desktop`: Electron main/preload loading
  the hosted web app (`?desktop=1`, `AksharoDesktop/<version>` User-Agent
  suffix, decision D71 — one web codebase, no packaged bundle until C04),
  `contextIsolation`/`sandbox`/`nodeIntegration:false`/`webSecurity:true`,
  navigation/`window.open`/`shell.openExternal` allowlists
  (`src/security/allowlist.ts`), strict-CSP packaged offline page with retry,
  `aksharo://` deep links (`auth/callback`, `project/<ulid>`, `pair`) with
  single-instance-lock hand-off, `electron-updater` wired to C00's
  `releases/<channel>/` feed layout with alpha/beta/stable channels and a
  deterministic staged-rollout gate, native menu + tray (bridge/pairing status,
  approve pairing, check for updates, copy diagnostics), Electron fuses
  flipped in the `electron-builder` `afterPack` hook. `src/bridge/adapter.ts`
  defines the `BridgeAdapter` interface and a stub implementation, since C01
  (`bridge-core`) is not yet merged. `apps/web/lib/desktop.ts`: the
  desktop-detection hook agreed with A13. Unit tests (vitest) for the
  allowlists, deep-link parsing, updater feed/rollout math and the bridge
  stub; a Playwright-Electron smoke suite (`e2e/smoke.spec.ts`, run via
  `pnpm test:e2e`, needs a built app and a display).
- **B13a — Admin roles, TOTP step-up, `AdminGuard(role)`.** CONTRACTS §5
  (amended 2026-09-03): `kind: "admin"` access tokens, minted only by
  `POST /admin/auth/step-up` after a TOTP check, 30-minute lifetime, never
  refreshable, carrying `adminRoles: ("support"|"finance"|"ops"|"content"|
"superadmin")[]`. New tables `admin_roles` (grant/revoke, re-checked by
  `AdminGuard` on every request so revocation is immediate rather than
  waiting out the token) and `admin_totp` (hand-rolled RFC 6238 TOTP,
  `apps/api/src/admin/auth/totp.ts` — no new dependency, same reasoning as
  `TokenService`'s hand-rolled RS256). `apps/api/src/admin/auth/
admin-step-up.{controller,service,dto,constants}.ts`: TOTP enrol/verify
  and step-up, rate-limited per user and per IP. `AdminGuard` rewritten to
  require `kind: "admin"` (not merely `users.is_admin`) plus, when a route
  carries the new `@AdminRoles(...)` decorator, a matching non-revoked
  `admin_roles` grant (`superadmin` always satisfies any role list). Role
  matrix contract test: `apps/api/src/admin/admin.guard.test.ts`.

- **B13b — Admin users/workspaces search+detail, credits adjust/reverse,
  refunds + credit notes.** `apps/api/src/admin/users/**`: read-only
  cross-tenant search and detail (memberships, device count, active admin
  roles; owner, member count, credit account, subscription) — open to any
  admin role, no `@AdminRoles(...)` restriction (the brief's own e2e case:
  support can view). `admin-credits.controller.ts` gains `POST
/admin/credits/adjust` (wraps `CreditsFacade.grantLot(source: "adjust")`)
  and `POST /admin/credits/reverse` (wraps `LedgerCreditsFacade.reverse()`,
  named in that method's own doc comment as one of its two intended
  callers), both `finance`/`superadmin` only, reason mandatory (min 10
  chars), audited. `apps/api/src/admin/billing/**`: `POST
/admin/billing/passes/:id/refund` — `admin-refund-policy.ts`'s pure
  policy (within 7 days of purchase: full refund of the amount on file;
  after: pro-rated by the fraction of the purchase's credits still unspent,
  via `credit_lots.remaining_tenths`/`granted_tenths`) composed with B01's
  `RefundsService.refundPassPurchase` (provider refund + credits clawback)
  and B05's `InvoicesService.generateCreditNote` (skipped, not failed, when
  no original tax invoice is on file). `AdminBillingModule`/
  `AdminUsersModule` are their own modules (not folded into `AdminModule`)
  to avoid a cycle: `InvoicesModule` already imports `AdminModule`.
  `test/auth-harness.ts`'s new `createAdminContext` mints a real `kind:
"admin"` token via an actual step-up (grant admin_roles, enrol a
  deterministic TOTP secret, verify, step up) — every existing admin e2e
  fixture (`dlq.e2e-spec.ts`, `offers.e2e-spec.ts`,
  `users-workspaces.e2e-spec.ts`) that used to hand-mint a plain `kind:
"web"` admin token now goes through it.

- **B13c — Admin flags CRUD, styles catalogue publish/unpublish, routing
  weight overrides.** `apps/api/src/admin/flags/**`: full CRUD over
  `feature_flags` — reads open to any admin role, every mutation
  `superadmin`-only with a mandatory reason and a before/after audit diff.
  `FlagTargetsSchema` (the shape `schema.prisma`'s own comment had promised
  since A05) adds `excludeWorkspaceIds` — B13's "holdouts" — as an additive
  extension to `workspaces/entitlement.service.ts`'s existing
  `flagTargets()`, checked first so a held-out workspace stays excluded even
  if it also matches the allow-list. `apps/api/src/admin/styles/**`: the
  system style catalogue with the A18a parity gate's own results
  (`assRenderable`/`assExportable`/`requiresLayoutMetrics`/`parityScore`,
  read-only here) and a new `published` column (migration `20260903030000`)
  so `content`/`superadmin` can unpublish a style without deleting it.
  `apps/api/src/admin/routing/**`: a `routing_weight_overrides` table (same
  migration), CRUD, validation (weight 0-100, id shapes matching
  `routing.yaml`/the provider registry), history via `audit_log` —
  deliberately does NOT read or merge against
  `apps/worker-ai/worker_ai/routing.yaml` at runtime (separately deployed
  process/repo; see the controller's own doc comment and this WP's final
  report "open questions" for the seam this leaves: the worker reading its
  table from this store instead of the bundled YAML).

- **B13d — job monitor + cancel, mandate/dunning monitor, TDS reports,
  affiliate review + chained self-referral hold, DSR/breach (consumed,
  B16), share-link report resolution, support stub (B12 absent).**
  `apps/api/src/admin/jobs/**`: cross-tenant job list/stats/cancel — the
  live-queue half of "job monitor (queues, counts, failed, DLQ)"; A08b's
  `AdminDlqController` already had the dead-letter half.
  `apps/api/src/admin/billing/admin-billing.controller.ts` gains `GET
/admin/billing/dunning` (past-due subscriptions with mandate status/next
  actions — read-only). `apps/api/src/admin/affiliates/**`: pending-review
  list, `GET .../tds/:fy/export.csv` (every affiliate's FY gross/TDS/net),
  `GET .../:id/form16a` (B07's existing PDF stub renderer, wired to a
  controller for the first time); the 4 existing admin approve/suspend/
  reject/revoke-code routes in `affiliates.controller.ts` now carry
  `@AdminRoles("ops", "finance", "superadmin")`. **Orchestrator addendum**
  (chained self-referral): `referral_rewards.hold_reason` (migration
  `20260903040000`) — a referred workspace whose owner claimed as referred
  for a different referrer within 90 days stays `pending` and is held out
  of `grantForExport`'s auto-grant; `apps/api/src/admin/referrals/**`
  reviews the queue (`ops`/`finance`/`superadmin`) and approves (settles
  through the normal cap-check path) or rejects. The addendum's other
  signal — a bare device/IP fingerprint match against any prior claim — was
  tried and dropped: it false-positived on every claim sharing a
  reused/NAT'd IP or common user agent (real traffic, not just this WP's
  own e2e fixtures), which is exactly the failure mode
  `immediateRejectionReason`'s narrowly-scoped "same as the referrer's OWN
  session" check was built to avoid; left as a follow-up rather than shipped
  as a blunt instrument. `apps/api/src/admin/share/**`: `GET
/admin/share-reports` + `POST .../:id/resolve` (take-down calls a new
  `ShareLinksService.adminTakedown`; "notify" is not wired — no
  NOTIFY_KINDS template exists for it, see "open questions").
  `apps/api/src/admin/support/admin-support.controller.ts`: a stub
  (`GET /admin/support/status`) — `apps/api/src/support/**` (B12) had not
  merged as of this commit.

- **B13e — the `(admin)` web shell, dashboard, admin e2e (role matrix +
  refund).** `apps/web/app/(admin)/**`: a separate layout with no product
  chrome; the admin session (a `kind: "admin"` step-up token) lives in
  `sessionStorage` (`lib/admin/admin-session.ts`), distinct from the regular
  product session — `lib/admin/admin-fetch.ts` is a small standalone fetch
  wrapper for it (the shared `@montaj/api-client` stays wired to the
  regular session's token). New typed endpoints `adminAuth.{totpEnroll,
totpVerify,stepUp}` in `packages/api-client` for step-up itself (the one
  call still made with the regular session's bearer token); every other
  admin route is called directly by the shell. Panels: users/workspaces
  search+detail, credits adjust/reverse, refunds, flags, routing weight
  overrides, styles catalogue, affiliates (pending queue + TDS CSV export),
  referral review queue, share-report resolution, jobs monitor (list/
  stats/cancel), a support stub, and a small numbers-only dashboard (no
  chart library — see "open questions", the scope this WP still had to
  cover left no room for it). `pnpm gen:client` regenerated (272
  operations). **Simplifications flagged rather than hidden:** the layout
  gates on session presence, not a genuine server-side "404 for
  non-admins" (every panel's own fetch still 403s against `AdminGuard`
  regardless of what the shell renders); no Playwright browser e2e for the
  admin UI (would need its own step-up-aware browser harness) — instead,
  `apps/api/test/admin-billing.e2e-spec.ts` proves the brief's literal
  acceptance case ("support role can view but not refund; finance can
  refund with reason") end to end against real Postgres/Redis, seeding a
  genuine top-up purchase + credit lot (billing-harness.ts binds
  `CREDITS_FACADE` to `NoopCreditsFacade` on purpose, so the lot is seeded
  directly rather than re-testing B02's own ledger).

- **A23 — Gate A e2e journey, sample-project seed, wave verification script,
  X02 load harness.** `apps/web/e2e/gate-a.spec.ts`: sign-up (adult, India)
  through onboarding, a real MinIO upload, transcription completion via the
  signed internal callback (standing in for a running `worker-ai` mock
  provider, per this suite's established convention), word edit, segment
  split, script switch, `punch-pop` style, SRT export (content verified),
  browser MP4 export on chromium (webkit asserts the cloud fallback), a
  cloud render job, and reload persistence — both browsers.
  `apps/api/prisma/seed-sample.ts`: a 90-second, deterministic Hinglish
  sample project (hand-generated WAV, no ffmpeg dependency; scripted
  transcript fixture so ASR is not in the loop), already transcribed,
  segmented, and carrying one `autocut` pass with three items in `proposed`
  state for Wave 4's review UI. `docker-compose.test.yml` +
  `scripts/e2e-stack.mjs` (`pnpm e2e:stack up|down`): api/web (from the
  mounted repo — see the compose file's header for why, and for the
  `AI_PROVIDER=mock` vs. actual `WORKER_AI_ALLOW_MOCK` naming note) plus
  worker-media/worker-ai/render (their existing Dockerfiles), postgres,
  redis, minio. `scripts/verify-wave.mjs`: fresh clone → install → compose
  up → migrate/seed → unit tests → e2e → parity gate → screenshots →
  `docs/verification/<date>-wave<n>.md`. `load/run.mjs` (+
  `load/k6-transcribe.js` for a machine with k6 installed): 100 concurrent
  `POST /projects/{id}/transcribe` calls, asserting p95 < 300 ms, all
  accepted, and a WS `job.*` event delivered; writes
  `docs/verification/load-<date>.md`. `.github/workflows/e2e.yml`: the Gate
  A journey plus the load harness against the compose stack, on PRs into a
  wave branch.

### Added

- **A07b — a `media.proxy` completion handler, and a real-dialog export e2e.**
  `apps/api/src/media/proxy.handler.ts` (`MediaProxyCompletionHandler`)
  registers on `JobCompletionRegistry` alongside A07's probe handler: it
  independently flips `media_assets.status` to `ready`/`failed` off the
  job's own completion, alongside (never instead of) the worker's `PATCH
/internal/media/{id}` write-back — closing the gap A23 found where a
  completed `media.proxy` job left the asset stuck unless that separate
  write-back happened to land. Idempotent both ways: the same outcome
  twice is a no-op, and a conflicting outcome always resolves to `failed`
  (a stray `ready` is overwritten; a success completion never undoes an
  existing `failed`). Failure completions needed a new, additive
  `JobCompletionHandler.handleFailure?` hook (`apps/api/src/jobs/
completion-handlers.ts`) and one call site in `JobsService.complete`
  (`apps/api/src/jobs/jobs.service.ts`) — every existing handler is
  unaffected since none implements it. `apps/web/e2e/gate-a.spec.ts` no
  longer needs `patchMediaForTest` to reach `status: "ready"`.

  `apps/web/components/editor/export/use-export-dialog.ts` now accepts a
  `preferFileSystemAccess` dep (default `true`) and, in non-production
  builds only, reads `window.__aksharoE2E?.noFilePicker` to force `false`
  — a synthetic Playwright click is not a "user activation"
  `showSaveFilePicker` recognises, so without this a real click on the
  export dialog's own button aborted the export before this fix.
  `apps/web/e2e/export.spec.ts` adds a second chromium test that drives the
  real `ExportDialog` end to end (open → Video tab → Export → the software-
  encoder cloud-offer override where a headless browser needs it → `export-
done`), verified against `GET /projects/{id}/exports`, alongside the
  existing `/export-harness`-driven ffprobe assertion.

### Fixed

- **A23 — the e2e fixtures' dev-outbox Redis key ignored
  `MONTAJ_REDIS_PREFIX`.** `apps/web/e2e/fixtures.ts` hard-coded
  `montaj:auth:dev-outbox`, but the API writes it under
  `${MONTAJ_REDIS_PREFIX}:auth:dev-outbox` (`apps/api/src/common/redis/
redis-keys.ts`); any worktree with a non-default prefix (A05/A23a's
  per-suite isolation) timed out every sign-up fixture after 45s waiting for
  a message that had actually arrived under a different key. `env.ts` now
  exports `redisKeyPrefix()`, read the same way the API's own reads it, and
  `fixtures.ts` builds the outbox key from it; covered by `env.test.ts` (a
  `node:test` file — see its header for why it is not a Vitest or Playwright
  file). Also added `apps/web/e2e/README.md`'s `--project`/worktree-`.env`
  note per the same addendum.

- **B06b — a Free downgrade now switches the streak row to credits-only
  immediately, not just at assignment.** B06's `ensureAssigned` only set
  `creditsOnly` on first insert, so a workspace that downgraded to Free
  mid-streak kept its L2/L3 renewal discount and L4/L5 credit-lot
  entitlement (04 §Streak: Free earns credits only). `StreakService` now
  re-derives `creditsOnly` from the workspace's _current_ plan on every
  `getView`/`getDiscountPercent` read and every `rolloverOne`, persisting
  the flip; `streak.engine.ts#rolloverWeek` takes a `planIsFree` input and
  resets the progression counter on a flip (the level-up track and the Free
  2-week credit track count different things); a later upgrade flips
  `creditsOnly` back and restores the discount at the next rollover. A
  level never decreases either way. Also fixed two pre-existing gaps this
  surfaced: `StreakService.getView`'s `discountPercent`/`creditGrantTenths`
  did not check `creditsOnly`/`paused` (only `getDiscountPercent` did), and
  the monthly L4/L5 credit grant in `rolloverOne` did not guard against a
  workspace that leveled up pre-downgrade and is now credits-only. See
  `apps/api/src/streak/README.md` §"Plan-derived `creditsOnly`".

- **A18a-c — fixed the stale seed parity-flag assertion in
  `apps/api/test/database.e2e-spec.ts`.** The "leaves the parity flags at their
  pessimistic defaults" test predated A18a's change to `apps/api/prisma/seed.ts`,
  which reads each system style's `parity` block (from
  `packages/caption-styles/styles/*.json`, written by the parity gate's
  `apply-flags`) into `style_presets.assRenderable`/`assExportable`/
  `requiresLayoutMetrics`/`parityScore` — so the old test failed on main whenever a
  style's gate result was `assRenderable: true` (13/30 styles). Replaced it with
  "seeds each system style's parity flags from its own style document (D33)": for
  every seeded system style, the four columns equal the style document's own
  `parity` block when present, and the schema defaults (`false`/`false`/`true`/
  `null`) when absent, plus a style-doc/flag consistency check
  (`assRenderable: true` implies a numeric `parityScore`) — already covered more
  strongly for every shipped style by
  `packages/caption-styles/src/registry.test.ts`'s "has parity flags written by
  the A18a gate for every shipped style (D33)", referenced in the new test rather
  than duplicated.
- **A15c — editor transcript scroll performance.** `TranscriptList`'s `MeasuredRow` no
  longer calls `getBoundingClientRect()` synchronously on every newly-mounted row (a
  forced layout, ~20-30 times a frame during the adversarial "jump the whole list every
  frame" scroll pattern); rows now seed the virtualiser with a content-based estimate
  (`estimateSegmentHeight()`, `lib/edg/virtual-list.ts`, from word count alone — no DOM
  read) and let the already-shared `ResizeObserver` correct it asynchronously.
  `SegmentCard` and `WordChip` are now `React.memo`'d, and `TranscriptList` caches each
  visible segment's `wordsOf()` result by segment id so re-renders that do not actually
  change a row's content (most of a natural wheel scroll, and the overlap between
  overscan windows) get a stable `words` array reference instead of a fresh one every
  render — both were previously defeated by `wordsOf()` recomputing on every call.
  `SegmentCard`'s per-word `onSelect` closure is now `useCallback`-memoised so it does
  not itself break `WordChip.memo`. Overscan reduced from 8 to 6 rows per the brief.

### Fixed

- **B03b — unified the two `apps/web/lib/billing/razorpay.ts` modules B03 and B04 each
  wrote (add/add conflict merging main).** One module now backs both: the checkout
  sheet's subscription/mandate flow and B04's one-time purchases (`ExportUpsellPanel`'s
  ₹9 clean export and week pass, `TopupCard`'s top-ups). `loadRazorpayCheckout()` keeps
  B03's non-throwing, typed-constructor return (`Promise<RazorpayConstructor | null>`);
  `openRazorpayCheckout()` keeps B04's stricter contract — a typed `RazorpayOutcome`
  (`success` with payment/order ids, or `dismissed`), rejecting rather than resolving
  falsely when the widget cannot load or open. `checkout-sheet.tsx` and `plan-table.tsx`
  (the offers-ladder purchases) were updated to the outcome/throwing contract; their
  tests and `lib/billing/razorpay.test.ts` updated to match. Also: the sidebar
  `CreditMeter` (`apps/web/components/shell/sidebar.tsx`) now reads B02's real
  `GET /workspaces/{id}/credits` via `packages/api-client`'s `useWorkspaceCredits()`
  instead of the wrong `pending.usage` path, so the meter shows a live balance and reset
  date instead of an honest zero. `lib/nav.test.ts`'s `SETTINGS_NAV` assertion updated
  to include B04's "subscription" settings section.

### Added

- **B19 — Reframe & zoom pass: scene detection, subject tracking, cue
  detection, velocity-eased keyframes packed as bytea.** Reuses B18's
  generic `ai.pass` runner end to end (no second pass runner) for two new
  pass kinds. Worker (`apps/worker-ai/worker_ai/passes/{scenes,tracking,
zoom,reframe}.py`, `apps/worker-ai/worker_ai/processors/
reframe_zoom_pass.py`): a `ContentDetector`-style scene-cut metric
  (re-implemented directly rather than depending on `pyscenedetect`); an
  IoU-linked subject track with a one-euro filter, speaking-speaker/largest-
  face multi-face resolution and a saliency-centre fallback (the YuNet ONNX
  face detector the brief names could not be fetched or committed in this
  CPU-only, no-download environment — a `FrameDetector` seam and a
  brightness-blob stand-in are documented in `passes/README.md`'s "Gap"
  section, matching A10/B18's own pattern for an unavailable model weight);
  a zoom pass turning emphasis-word/audio-energy/sentence-start cues into
  rate-limited (>=2.5s apart, never across a scene cut or an accepted `cut`
  item) punch-in events (180ms ease-out-cubic in, >=600ms hold, 260ms out,
  subtle/standard/punchy presets); a reframe pass building an 8%-deadzone,
  velocity-capped, scene-hard-cut 16:9→9:16/1:1 crop track at 10Hz,
  simplified with Ramer–Douglas–Peucker. Packed-keyframe byte format
  (`[tMs, cx, cy, scale]` little-endian float32 rows, `MKF1` v1 header):
  `packKeyframes`/`unpackKeyframes`/`loadKeyframes` in `@montaj/edg`
  (`packages/edg/src/keyframes.ts`, documented in its README) with a
  byte-for-byte-matching Python encoder in the worker, round-trip and
  property tests both sides. API (`apps/api/src/passes/**`, extended):
  `POST /projects/{id}/passes/{zoom,reframe}` quoted against `@montaj/
config`'s existing `reframeZoomPass` burn rate (flash tier — the brief's
  literal "3 credits/minute" is that rate's _pro_ tier; flagged for
  reconciliation, the same kind of gap B18 flagged for `autocutPass`),
  `PassCompletionHandler` extended to merge zoom/reframe items. Two frozen-
  interface gaps found and flagged rather than silently worked around
  (`passes-completion.handler.ts`'s class docstring): `PassTypeSchema` has
  no `"zoom"` value, so both land as `type: "reframe"` distinguished by
  `kind`/`engine`; and neither the inline-bytea nor the derived-storage
  write path for `keyframesRef` exists yet (`PassItem` carries only a
  string ref, `ObjectStore` has no `putObject` by design), so this work
  package computes the addendum's key shape and sets it, but does not yet
  write the bytes anywhere — flagged as an open question for a follow-up
  (B20 already touches keyframe consumption). Also flagged: real detections/
  scene frames need decoded video (out of scope here — no video-decode
  dependency was added), so the producer sends them empty for now; the
  worker still runs correctly on emphasis-only zoom cues with a saliency
  fallback, while reframe fails non-retryably (`worker/invalid_payload`)
  until that producer-side gap closes. See `apps/worker-ai/worker_ai/
passes/README.md` for models used, presets and the full gap list. Also
  added `packages/edg/src/passes/keyframes.ts` — `encodeKeyframes`/
  `decodeKeyframes` over B20's own `Keyframe = {tMs, zoom, cx, cy, ease}`
  shape (a second, `MKF2` on-disk format, distinct from the `MKF1` one
  above; reconciling the two is flagged as an open question) — so B20 can
  code against this exact name/shape ahead of B19 landing.

- **B10 — Audio clean: denoise, loudness normalise, A/B preview, applied to
  browser and cloud exports.** Worker (`apps/worker-ai/worker_ai/clean/**`):
  `ai.clean` denoises via spectral-subtraction gating (a DeepFilterNet3
  stand-in — no model weights could be fetched or committed in this
  environment; see `dsp.py`'s module docstring), an optional harder gate for
  de-reverb and a sibilance-band gain reducer for de-essing, then
  loudness-normalises to a target (social/youtube/podcast, `light`/`medium`/
  `strong` mix presets) with a soft-knee peak limiter and an approximate-LUFS
  meter (documented deviation from full ITU-R BS.1770 K-weighting); long
  files run in 10-minute windows with a 1 s equal-power crossfade to bound
  memory. Outputs `clean48k-{cleanId}.wav` plus original/cleaned 20 s A/B
  preview MP3s to the derived bucket (`storage.py` gains `ObjectStore.
upload()` — the worker's first write path). API (`apps/api/src/audio/**`,
  `prisma` migration `b10_audio_clean`): `POST/GET
/projects/{id}/audio/clean(s)`, quoted via `packages/config`'s
  `audioClean` burn rate and gated on the `audioClean` entitlement, an
  `ai.clean` completion handler, and a read-time reconciliation for a job
  that failed or is still running (the completion handler only runs on
  success). Exports: `EdgHot.audio.clean` (`SetAudio`'s frozen
  `{enabled, preset?, targetLufs?}` shape — no `cleanId` field, so B10
  encodes it as `preset: "b10:<cleanId>"`, a documented adaptation of the
  brief's literal `{cleanId, strength}` wording) now drives
  `manifest-builder.ts`'s `audio.strategy`: `"replace"` plus `cleanId`/
  `cleanKey`, which `apps/render`'s ffmpeg graph already consumed and which
  `exports.service.ts` now presigns into `ExportSources.cleanedAudioUrl`;
  the browser engine (`apps/web/lib/export/engine.ts`) reads it as
  `RunExportOptions.cleanAudioSource` and mixes it in instead of always
  failing "replace" as before. Web: an Audio panel
  (`apps/web/components/editor/audio/**`) with strength/target controls, an
  A/B toggle over the two preview clips, metrics, and an "apply to export"
  `Switch` that builds the `SetAudio` op (enqueuing it is left to the
  editor's own `EdgOpQueue` — see the final report's reported gap).

- **B14 — Public API v1, API keys, outgoing webhooks, `/developers` docs.**
  API: `apps/api/src/public-api/**` — `ApiKeysService`/`ApiKeysController`
  (`POST|GET /workspaces/{id}/api-keys`, `POST .../rotate`, `DELETE
.../{keyId}`) mints `ak_live_<prefix>.<secret>` against A04's `ApiKeyGuard`
  contract, gated on the `apiAccess` entitlement (Studio/Agency), with a 24h
  rotation-overlap window via `expiresAt` (`ApiKeyGuard` now also refuses an
  expired key). `ApiKeyScope` (schema) narrowed to exactly `projects_read`,
  `projects_write`, `transcripts_read`, `exports_write`, `webhooks_manage` —
  no admin/billing scope exists. `/v1` (`public-api/v1/**`): `POST|GET
/v1/projects`, `POST /v1/projects/{id}/transcribe`, `GET
/v1/projects/{id}/transcript?format=json|srt|vtt`, `POST
/v1/projects/{id}/exports` (cloud path only), `GET /v1/exports/{id}`, `GET
/v1/jobs/{id}` — `X-Api-Key` only, `ApiKeyRateLimitGuard` (`RateLimit-*`
  headers, 60/120 default, 120/240 Agency), `IdempotencyService`
  (`Idempotency-Key`, 24h, new `idempotency_records` table) wraps every
  mutating route. `sourceUrl` project creation
  (`SourceUrlIngestService`) reuses A06's `safeFetch` SSRF guard (https only,
  every resolved address judged and the connection pinned, redirects
  re-validated and capped, content-type allow-list) rather than a parallel
  implementation. Webhooks: `apps/api/src/webhooks/**` — CRUD at
  `/workspaces/{id}/webhooks` against the schema's existing (pre-B14)
  `WebhookEndpoint`/`WebhookDelivery` tables, `X-Aksharo-Signature:
t=<unix>,v1=hmac_sha256(secret, t + "." + body)`
  (`webhook-signature.ts`; `webhook-signature.test.ts` executes the exact
  Node verification snippet the docs page renders, proving they cannot
  drift), delivery via `common/ssrf/webhook-fetch.ts` (POST analogue of
  `safeFetch`, same resolve-judge-pin sequence, re-validated on every
  attempt), retry schedule 1m/5m/30m/2h/12h then `dead`, auto-disable after
  20 consecutive failures, manual redeliver, "send test event". Delivery is
  a `common/scheduler` sweep (`WebhookDeliverySweepTask`), not a new BullMQ
  contract queue. `export.completed` is wired via the existing `EventEmitter2`
  event of that exact name (B07b); `transcript.completed`/`job.failed`/
  `credits.low` have no existing event to subscribe to, so
  `WebhookEventPollerService` polls the `jobs`/`notifications` tables with a
  Redis cursor instead of editing `transcripts/`, `jobs/` or `credits/` —
  flagged as a deviation in the WP's final report. Web:
  `apps/web/app/(app)/settings/developers/**` (keys + webhooks CRUD, scope/
  event pickers, reveal-once secret dialog, delivery log with redeliver) and
  `apps/web/app/(site)/developers/**` (endpoint list read live from
  `@montaj/api-client/openapi.json`, scopes, rate limits, SSRF rules, webhook
  signature verification with curl/Node/Python tabs) — a small custom
  renderer rather than Scalar/Redoc bundled locally (neither vendored in
  this repo; flagged as a deviation). `@montaj/api-client` gained
  `useApiKeys`/`useCreateApiKey`/`useRotateApiKey`/`useRevokeApiKey`/
  `useWebhookEndpoints`/`useCreateWebhookEndpoint`/`useUpdateWebhookEndpoint`/
  `useDeleteWebhookEndpoint`/`useSendWebhookTestEvent`/`useWebhookDeliveries`/
  `useRedeliverWebhookDelivery` and the matching types, generated
  `openapi.json` re-exported at `@montaj/api-client/openapi.json` for the
  docs page. `apps/web/lib/nav.ts` gained one additive "Developers" entry
  (outside this WP's stated file boundary; flagged as a deviation — the
  settings page would otherwise be unreachable from the sidebar).
- **B11 — LLM features: chapters, summary, hooks/titles/hashtags (F-206/F-207),
  `@montaj/prompts` template registry, region-pinned providers, an Insights tab.**
  `packages/prompts`: versioned template registry (`chapters@1`, `summary@1`,
  `hooks@1`, `keyphrases@1`) with Zod input/output schemas, a shared
  prompt-injection guardrail (transcript fenced as `<transcript>` DATA), a filler
  lexicon (`en`/`hi`/`hi-Latn`/`ta`; B11b later replaced this in-code lexicon
  with a typed loader over B18's JSON lexicon, the single source), a fake-provider generator
  and an eval runner (`pnpm --filter @montaj/prompts eval`) over four fixture
  transcripts (English, Hindi, Hinglish, Tamil) with five automatic checks
  (schema validity, timestamp validity/ordering, hallucination guard, length
  limits, language consistency), writing `eval-results/report.{json,md}`.
  `apps/worker-ai/worker_ai/llm/`: a Python mirror of the same templates and
  version strings (the `translate.ts`/`translate/providers/prompts.py` split),
  `LlmProvider` adapters (`mock`, `anthropic`, `openai` — Claude Sonnet 5
  primary, OpenAI fallback, config-selected via `LLM_PROVIDER`), region pinning
  (`region.py`: an EU workspace never selects a non-EU-capable provider, fails
  closed on an unknown/unsupported region) and `generate_insight()` (build →
  call with retry → validate → one repair attempt); `processors/llm.py` wires
  it to the now-implemented `ai.llm` queue. `apps/api/src/insights/`:
  `POST /projects/{id}/insights {kinds, tone?, regenerate?}` quotes and holds
  credits per kind (chapters 2, summary 1, hooks 2 — reconciled into
  `packages/config`'s `BURN_RATES` by B11b, see that entry and the README),
  builds the job's transcript payload from `TranscriptsService.chunks()`
  (language, optional media title, segments only — no user identity, brief's
  PII minimisation; B11b later added the EDG-segment path), and enqueues one
  `ai.llm` job per kind; `GET
/projects/{id}/insights` reads the latest `llm_outputs` row per kind plus the
  ASCI-friendly disclosure line. Migration adds `llm_outputs` (id, projectId,
  workspaceId, jobId, kind, templateVersion, provider, region, output jsonb,
  usage jsonb, createdAt). `apps/web/components/editor/insights/`: the Insights
  tab — chapters list with "copy as YouTube description" and jump-to, summary
  with a length switch, hooks/titles/hashtags with platform tabs and copy
  buttons, regenerate, loading/empty/error states, the disclosure line
  ("Generated by AI from your transcript"). `@montaj/api-client` gained
  `useProjectInsights`/`useRequestInsights` and the `Insight*` types. See
  `apps/api/src/insights/README.md` for the credits/region/PII notes and the
  eval report format.

- **B18 — autocut pass: VAD silences, filler lexicons, repeated takes, protection
  rules, pacing presets → `edg_pass_items`.** Worker (`apps/worker-ai`):
  `worker_ai/passes/autocut.py` — a pure, deterministic pipeline (silence gaps
  between VAD speech regions, mid-sentence long pauses, per-language filler
  lexicon with `always`/`isolated_only` context rules, adjacent-sentence retake
  detection by n-gram similarity, protection/merge/removal-cap post-processing)
  behind `run_autocut()`; `processors/autocut_pass.py` wires it to `ai.pass`
  (`passType: "autocut"`; real VAD when `mediaId` is given, else a word-derived
  approximation) — `ai.pass` moves from `not_implemented` to
  `IMPLEMENTED_AI_QUEUES` (any other `passType`, e.g. B19's reframe/zoom, still
  answers `worker/not_implemented` from inside the processor). Lexicons:
  `packages/prompts/lexicons/fillers/{en,hi,hinglish,ta,te,bn,mr,gu,kn,ml,pa,ur}.json`
  (en/hi/hinglish curated in depth; the other nine seeded and unit-tested, flagged
  for follow-up linguistic review). API: `apps/api/src/passes/` —
  `POST /projects/{id}/passes/autocut` (quotes `BURN_RATES.autocutPass`, holds
  credits, enqueues `ai.pass` with the transcript's words, real VAD hint, and
  guarded ranges from segments carrying `emphasis`/`textOverrides`),
  `GET /projects/{id}/passes`, and `PassCompletionHandler`, which turns the
  worker's proposed cuts into a `MergePass` op (A12) — idempotent per `passId`.
  Pacing presets: gentle (1.0s/15%), standard (0.6s/30%), tight (0.4s/45%);
  80ms padding; 350ms minimum kept segment; retake window 20s at similarity
  ≥0.8. **CONTRACTS gap**: `EdgHot.protected[]` (user-marked protected ranges)
  does not exist yet — `protectedRanges` is always sent empty; only the
  `emphasis`/`textOverrides` guard is enforced today. See the B18 final report
  for the full metrics/coverage summary.

- **A19c — browser export throughput: offscreen WebGL CanvasKit surface,
  hardware-encoder capability probe, cloud-default policy above 1080p, 5ms
  splice fades.** `packages/render-canvaskit`: `createExportSurface(ck,
width, height)` — the export worker's off-screen counterpart to A16's
  `createBrowserSurface`, trying an `OffscreenCanvas`-backed
  `MakeWebGLCanvasSurface` first and falling back to the plain CPU raster
  `MakeSurface` A19b used exclusively; both are Skia, proven equal by
  `engine-parity.test.ts`'s new fallback-path check (Node has no
  `OffscreenCanvas`, so the CPU fallback is what vitest exercises; the GPU
  path is exercised for real by `apps/web/e2e/export.spec.ts`'s
  `caption-surface-backend` annotation and by `render-canvaskit`'s own
  browser e2e suite, which shares the same GPU-first/CPU-fallback logic).
  `apps/web/lib/export/engine.ts` now allocates the caption layer through
  `createExportSurface` and reports which backend ran
  (`EngineResult.captionSurfaceBackend`). `apps/web/lib/export/probe.ts`:
  `probeHardwareEncoder` — a dedicated `VideoEncoder.isConfigSupported`
  check with `hardwareAcceleration: "prefer-hardware"` against the probe's
  best H.264 rung, reported as `ExportCapabilityProbe.hardwareEncoder` /
  `capabilities.hardwareEncoder`, `false` (not thrown) when the browser
  answers `supported: false` or throws outright (observed in this sandbox).
  `apps/api/src/exports/decision.ts`: an `auto` request at 1080p or larger
  now defaults to the cloud when `capabilities.hardwareEncoder` is not
  `true` (`SOFTWARE_ENCODER_CLOUD_DEFAULT_REASON`); an explicit `mode:
"browser"` request still bypasses it, with a warned reason
  (`SOFTWARE_ENCODER_BROWSER_WARNING`) carried in `reasons` for the dialog.
  `apps/web/components/editor/export/ExportDialog.tsx` offers an "Export in
  this browser anyway" button (BRAND-worded warned copy) on the cloud-offer
  panel when this specific policy, not some other cloud reason, is why the
  request landed there. `apps/web/e2e/export.spec.ts`'s throughput check is
  now a _reported_ `realtime-multiplier`/`caption-surface-backend`
  annotation on every run, with a hard ≥0.5x floor gated on
  `capabilities.hardwareEncoder === true` only (this sandbox's headless
  chromium has neither a hardware encoder nor a GPU context proven, so it
  still only asserts forward progress — see `apps/web/lib/export/README.md`).
  Audio: `applySpliceFades` applies a 5ms linear gain ramp at each join
  `retainedSourceRangesMs` creates between two cut-separated retained
  ranges (A19b left this unimplemented); the outer edges of the whole
  track are never faded, only a join adjacent to a removed range.

- **A19c (orchestrator addendum) — export dialog pre-selects B17's onboarding
  export preset.** `apps/web/components/editor/export/onboarding-preset.ts`:
  a small named-preset table (resolution + aspect + `RenderPreset`, e.g.
  `reels-1080-vertical`, `youtube-1080`, `podcast-clip`) and
  `resolveOnboardingExportPreset`, mapping B17's free-form
  `me.onboarding.defaultExportPreset` label (`onboarding-flow.tsx`'s
  `MAKE_DEFAULTS`: `reels`/`youtube`/`podcast-clip`/`client-review`/
  `highlights`) onto one of the dialog's own `RenderPreset` values —
  falling back to `reels-1080-vertical` when the field is absent or
  unrecognised. `ExportDialog.tsx` applies it once, the first time
  `useCurrentUser()` resolves, and never overwrites a manual preset choice.
  `youtube` and `client-review` both want 16:9, but `@montaj/render-manifest`'s
  frozen `RENDER_PRESETS` has no 1080p 16:9 entry — both fall back to
  `youtube-4k` (the only 16:9 option) rather than inventing a preset value;
  reported as an open gap.

- **B09b — wired B09's three memory learning hooks to their real producers/consumers
  (A17/A02d timing nudge, the editor's spelling fix, and transcribe hints).**
  Web: `apps/web/lib/timeline/memory-nudge-sink.ts`'s `createMemoryNudgeSink` is
  the real `TimingNudgeSink` (`nudge.ts`) — consent-gated, debounced per drag,
  `POST /memory/hooks/timing-nudge` — wired via `use-memory-nudge-sink.ts` as
  `Timeline.tsx`'s effective default sink; `editor-client.tsx`'s
  `onFixSpellingEverywhere` now posts `POST /memory/hooks/spelling-fix`
  (`{wrong, right, script}`) once the correction's own op batch has landed
  (`EditorStore.flush()`), consent-gated the same way (predicate exported as
  `shouldRecordSpellingFix` for unit testing). `@montaj/api-client` gained
  `useRecordTimingNudgeMemory`/`useRecordSpellingFixMemory`/`useRecordStylePrefMemory`
  hooks over B09's existing hook routes. API: `MemoryService.glossaryTermsFor()`
  is a new, non-throwing consent-gated read (glossary + spelling terms,
  deduplicated, most-recent-first); `TranscriptsService.buildHints()` merges it
  into `params.hints` at enqueue, request-time hints first, capped at
  `MAX_TRANSCRIBE_HINTS` (200). Worker: `processors/transcribe.py::_hints()` now
  runs `prepare_hints()` (`worker_ai/hints/glossary.py`, already built) over the
  incoming list before any provider shapes its own vocabulary parameter. Consent
  off produces zero memory requests and zero memory hints at all three sites
  (unit-tested); see `apps/api/src/memory/README.md`.
- **B17 — onboarding completion: defaults, code classification, sample
  project, coach marks, attribution events, Hindi UI.** Extends A13's
  three-step wizard (`apps/web/app/(app)/onboarding/onboarding-flow.tsx`) with
  a fourth "you're set" step (drop-zone equivalent via the existing
  `SampleProjectButton`) and turns the answers already collected into real
  defaults: "what you make" now derives a default aspect, caption style and
  export-preset label (`MAKE_DEFAULTS`), persisted onto `onboarding` and
  adopted by the Home quick-pick row (`home-view.tsx`) the same way it already
  adopted the language; "languages you speak on camera" now rides along as
  routing hints on the _next_ transcribe request (`upload-job.ts`'s
  `tryStartTranscription`, `languages: [primary, ...secondary]` plus
  `captions.styleRef`), not just the first pick. The code field classifies by
  prefix (`apps/api/src/users/onboarding/code-classifier.ts`, mirrored
  client-side): `AK-` routes to B07b's existing `/referrals/claim`; anything
  else affiliate-shaped calls B07's `/affiliate/attribution/attach` (newly
  wired into `@montaj/api-client` as `useAttachAffiliateAttribution`, not
  previously called from anywhere in `apps/web`); anything else shows an
  inline "that doesn't look right" error without blocking the wizard.
  `product_events` (new table, migration `20260902150000_b17_product_events`)
  records `onboarding_completed` with `source`/`codeType`/`props` the first
  time `onboarding.completedAt` appears (`ProfileService.update`, guarded so a
  later unrelated `PATCH /me` never re-fires it); `GET /admin/metrics/acquisition`
  aggregates it by source and code type over a trailing window (default 30
  days), following `AdminStreakController`'s shape. Three first-run coach
  marks (transcript editing, style picker, export) render once in the editor
  (`FirstRunCoachMarks.tsx`, positioned off `data-coach-mark` containers
  `editor-client.tsx` already carries elsewhere), gated on a new
  `onboarding.coachMarksShownAt` flag. A minimal ICU MessageFormat i18n layer
  (`apps/web/lib/i18n/locale-provider.tsx`, `intl-messageformat`, already
  pinned in the lockfile for the API's notification templates) ships English
  and Hindi catalogues for the onboarding flow and the coach marks, with a
  language switch in the profile menu (persisted through the existing
  `locale` field on `/me`). No `PATCH /me/onboarding` route was added: A13/A05
  already built onboarding persistence as a free-form field on the existing,
  frozen `PATCH /me`, and every new field here (`codeType`, `defaultAspect`,
  `defaultStyleId`, `defaultExportPreset`, `coachMarksShownAt`) fits its
  existing bounded schema — a parallel route would only duplicate that seam.

- **B09 — learned memory (spellings, glossary, timing nudge, style prefs), opt-in
  and erasable (F-204, D62).** `apps/api/src/memory/`: `MemoryService` — a
  consent-gated CRUD/import/clear surface over `memory_entries` (the table and
  its consent-filtered reader, `MemoryGlossarySource`, already existed from
  A11). Every mutating call re-reads the caller's live, un-withdrawn `memory`
  consent record rather than trusting a cached flag (the same shape as
  `MemoryGlossarySource`'s own gate), so nothing is stored without consent and
  a withdrawal is honoured on the very next write. `GET/POST/PATCH/DELETE
/memory`, `DELETE /memory` (clear all), `POST /memory/import` (CSV bulk
  glossary import: `term` or `term,alias1;alias2` per line), plus three
  learning-hook routes other work packages call into: `POST
/memory/hooks/spelling-fix` (A15's "Fix spelling everywhere" -> a `spelling`
  entry, script-aware), `POST /memory/hooks/timing-nudge` (a drag delta ->
  a rolling median per-workspace caption offset, `medianOf`), `POST
/memory/hooks/style-pref` (last style/template used per aspect). Entries
  carry a 12-month rolling expiry refreshed on every write, `hits`/`lastUsedAt`
  usage counters, and a `deviceOnly` flag; withdrawing the `memory` consent
  erases every entry for the user via a new `consent.withdrawn` event
  (`memory/consent-events.ts`) emitted from `ConsentsService` — a small,
  documented, additive edit outside this work package's file boundary (same
  precedent as `invoices/billing-events.ts`). `apps/worker-ai/worker_ai/hints/`:
  `prepare_hints()`, a pure dedupe/trim/cap step for glossary terms ahead of
  the provider-specific shaping (`word_boost`, `vocabulary`, `keyterms`,
  `initial_prompt`) A09/A11 already built per-provider. `packages/api-client`:
  real `/memory` endpoints and hooks (`useMemoryEntries`, `useCreateMemoryEntry`,
  `useUpdateMemoryEntry`, `useDeleteMemoryEntry`, `useClearMemory`,
  `useImportMemoryGlossary`) replacing the B09 pending stubs. `apps/web/app/(app)/settings/memory/`:
  edit/delete per entry, a glossary add-one-term control and CSV import, usage
  counters and expiry display, alongside the existing consent-gated empty/disabled
  states and clear-all confirmation.

- **A02d — `SetWordTiming{wordId, s, e}` end to end.** CONTRACTS §2's new op lands in
  `packages/edg`: `applyOps` writes `Word.s/e` (integer ms) after checking `s < e`, no
  overlap with the previous/next **live** word in the same chunk, the range stays inside
  that chunk's own bounds, and it stays inside the segment that currently contains the
  word — segment bounds are never recomputed, that is `SetSegmentBounds`'s job, but
  `validateProjection` still has to hold. Rebase field `timing:<wordId>` is last-write-
  wins, `stale` after a `DeleteWord` of the same word, and — being word-level, not
  segment-addressed — untouched by a `Resegment` in between. `edg-ops-v2.json`
  regenerated; README's op list and rebase table updated; the property test now fires
  random `SetWordTiming`s too. `apps/api/src/edg`: the op flows through the existing
  batch endpoint and `persistWords`/`transcripts.currentRevision` unchanged; the working
  set (`edg.working-set.ts`) gained `timingWordIds` and `edg.repository.ts`'s new
  `resolveTimingSegments` reads a retimed word's own chunk first so the containing
  segment (unlike every other word op, `SetWordTiming` carries no `segmentId`) is loaded
  for the bounds check without loading the whole document; two new e2e cases prove
  persistence through `GET /projects/{id}/transcript` and rejection on overlap.
  `apps/web/lib/edg/ops.ts` gained the `setWordTiming` builder and its
  `computeInverseOps` case (inverts to the word's prior `s/e`), picked up by A15's
  existing generic op batching and undo stack with no further wiring. The timeline's
  word lane (`apps/web/components/editor/timeline/Timeline.tsx`) is no longer read-only:
  each word's edges are draggable with the same 40 ms neighbour-boundary snapping as a
  segment edge (`lib/timeline/snapping.ts`'s new `resolveWordEdgeDrag`/`MIN_WORD_MS`,
  proven by the same never-overlaps property test as segments), clamped so a drag can
  never invert or overlap, emits one `SetWordTiming` on pointer-up, and Alt+Arrow nudges
  the selected word's active edge (Alt+Tab toggles which edge) the same way plain Arrow
  already nudges a selected segment. Drag/nudge deltas feed `lib/timeline/nudge.ts`'s
  sink through two new kinds, `word-start`/`word-end`, alongside the existing
  `segment-start`/`segment-end`.
- **B16 — scheduler tasks, audit log completion, and the privacy module
  (erasure cascade, DSR tracking, data export, breach incidents, consent
  completion, access logs, sub-processor list).**
  - `apps/api/src/scheduler/tasks/`: the scheduler wiring several already-landed
    services documented themselves as waiting on — `media-retention.task.ts`
    (A06's `RetentionService.purgeDueMedia`) and `renewal-dunning.task.ts`
    (B01's `RenewalService.initiateRenewal`/`graceExpiry`) — plus tasks B16
    owns outright: `project-retention.task.ts` (−14 d `retention-warning`
    email, then soft-delete + pulls media purge dates forward),
    `export-retention.task.ts` (expires `exports`/`export_manifests`),
    `device-code-expiry.task.ts`, `memory-entry-expiry.task.ts`,
    `provider-deletion-followup.task.ts` (calls a provider deletion API where
    one is registered, else logs one audit summary of the manual queue),
    `access-log-purge.task.ts` (1-year retention), `share-report-sla.task.ts`,
    `ledger-reconciliation.task.ts` (pages on a cache/ledger mismatch, never
    repairs), `export-filing-report.task.ts` (monthly GSTR-1 aggregate,
    idempotent via `invoices.gstr1Period`) and `usage-report.task.ts`
    (explicitly a stub per the brief). Commission maturation, payout batching,
    credit grant reset/lot expiry and streak rollover/nudge were already
    registered by B07/B02/B06 against the same A08 primitive and are not
    duplicated here. `admin/scheduler/admin-scheduler.controller.ts` is the
    one manual-trigger surface for every registered task
    (`POST /admin/scheduler/tasks/:name/run`).
  - `apps/api/src/privacy/erasure-cascade.service.ts` + `.task.ts`: the
    30-day cascade `DELETE /me` (A05) starts — object stores first, rows
    second, per workspace the requester owns; billing documents (`invoices`)
    are retained with `recipientEmail` minimised, never hard-deleted, because
    `invoices.workspace_id` is `onDelete: Cascade` in this schema and a hard
    workspace delete would take 72-month-retained billing records with it
    (flagged as a seam for a future ADR, not changed here). Added the 409
    `me/owner_of_workspaces` refusal (B16 addendum after A05) to
    `ProfileService.requestErasure`.
  - `apps/api/src/privacy/residue-check.service.ts`: reads the Prisma DMMF to
    find every model with a `userId`/`workspaceId` column and count residue —
    used by the erasure-sweep contract test, and by
    `POST /admin/privacy/erasure/replay-tombstones` /
    `tools/runbooks/privacy-replay-tombstones.js` (`docs/runbooks/
breach-first-hour.md`'s "replay the tombstones" step after a PITR
    restore).
  - `apps/api/src/privacy/breach-incidents.service.ts` +
    `breach-templates.ts`: `breach_incidents` CRUD, the 72-hour Board-notice
    clock, and plain-string (no LLM) Board-report/user-notice drafts, behind
    `admin/privacy/admin-privacy.controller.ts`.
  - `apps/api/src/users/data-export.service.ts` (A05): extended the
    `GET /me/data` bundle with a media manifest and moved the signed link's
    TTL from 1 hour to 7 days, per the brief.
  - `apps/api/src/notify/suppression.service.ts` (A25 addendum): a durable
    `mail_suppressions` table the Redis live set is rebuilt from at boot and
    kept in sync by `suppress`/`releaseTransient` — no change needed at the
    SNS handler call sites.
  - `apps/api/src/common/audit/audit.service.ts`: `CommonAuditService`, the
    collapse of A04's `AuthAuditService` and A05's `AuditService` into one
    writer with an open action union (B16 addendum after A05) — both original
    classes now subclass it and keep their names, constants and call sites.
  - `apps/api/src/audit/`: `@Audited`, and the audit-completeness contract
    test (`audited-routes.scan.ts` + `audit-completeness.test.ts`) — every
    controller with a mutating route must reference an audit writer somewhere
    in its local dependency graph, or be in `EXEMPT_FILES` with why. Fixed
    four routes it found with no audit trail at all
    (`admin/credits/admin-credits.controller.ts`,
    `fonts/fonts.controller.ts`, `exports/brand-assets.controller.ts`,
    `referrals/referrals.controller.ts`).
  - `apps/api/src/privacy/access-log.decorator.ts` +
    `.interceptor.ts`: `@LogAccess(resource)` writes `access_logs` (not
    `audit_log`) for a successful personal-data read, applied to
    `GET /projects/:projectId`, `GET /media/:mediaId`,
    `GET /projects/:projectId/transcript` and
    `GET /exports/:exportId/download`.
  - `apps/api/content/sub-processors.json` + `GET /privacy/sub-processors`.
  - `tools/runbooks/privacy-replay-tombstones.js`.

- **B06 — streak experiment: 3-day weekly bar, auto-freezes, pause-not-reset,
  level-ups, discounts/credit grants, holdout, and the widget.** `apps/api/src/streak/`:
  a pure state machine (`streak.engine.ts`, table-tested with fake clocks) —
  deterministic 50/50 holdout by `sha256(workspaceId)`, a Mon-Sun week window in the
  workspace's own IANA timezone, a 3-publish-day bar, 2 auto-applied freezes/month
  (consumed before a pause is ever reached), pause-not-reset on a missed week with no
  freeze left, 4 consecutive kept weeks → level up (a level never decreases, capped at
  L5), L2 5%/L3 10% off renewals, L4 +50/L5 +100 credits/month, yearly subscribers
  start at L4, and a Free-plan credits-only variant (+5 credits after a two-week kept
  streak). `StreakService` orchestrates assignment (`ensureAssigned`, minors and a
  disabled `streak_experiment` flag both refuse a row), the `GET /streak` read model,
  the weekly rollover (`StreakRolloverTask`, self-registered hourly against
  `common/scheduler`) and the Tuesday-evening nudge (`StreakNudgeTask`, the new
  `streak-nudge` notify kind, in-app + email, for 0-1 publish days by Tuesday
  evening local time). `POST /streak/test-hooks` (refused outside `NODE_ENV=test`)
  simulates publish days and forces a rollover for tests. A holdout workspace's row
  still tracks real state (for cohort measurement) but `rolloverOne` never calls
  `CreditsFacade.grantLot` for it, and `getView`/`getDiscountPercent` always answer
  `0` for one.
  **Billing integration**: `billing/money.ts` gained `applyDiscountWithinCap`
  (never below zero, never above the undiscounted `listPriceMinor` — which already
  IS the mandate cap); `RenewalService` takes an `@Optional()` `STREAK_DISCOUNT_PROVIDER`
  (`streak/streak-discount.port.ts`, bound to `StreakDiscountService` inside
  `StreakModule`, imported by `BillingModule`) and applies it to both the pre-debit
  notice amount and the manual dunning retry charge — 0% with no provider bound, so
  every existing billing test keeps passing unchanged.
  **Credits integration**: rewards go through the existing `CreditsFacade.grantLot`
  (`source: "grant"`), the monthly L4/L5 grant expiring at the end of the calendar
  month it was granted in.
  **Admin**: `GET /admin/metrics/streak` (`admin/streak/`) reports week-4 retention
  and average exports/week, experiment vs holdout, behind `AdminGuard`.
  **Web**: `apps/web/components/streak/streak-chip.tsx` (sidebar, "3 of 3 publish
  days · L2 · 2 freezes left", paused reads "streak paused — one export restores it",
  never a reset) and `streak-widget.tsx` (the Subscription overview's slot,
  `overview-panel.tsx`) — both render nothing at all for an ineligible or holdout
  workspace. `packages/api-client` gained `StreakView`, `streakEndpoints.getStreak`
  and `useStreak()` (hand-written, generated `operations.ts` regenerated via
  `pnpm gen:client`).
  **Schema**: `streak_experiments` gained `freezesRemaining`/`freezesMonth`/`paused`/
  `creditsOnly`/`lastNudgeAt`/`createdAt` (migration `20260902122834_b06_streak_experiment`,
  additive only, a throwaway `freezes_month` default keeps it safe against a
  populated table).
- **A21b — api: browser-path gaps A19 found (source URLs, H.264/audio eligibility, HDR).**
  - **`sources: {rawUrl, proxyUrl?, watermarkUrl?}`** alongside a browser manifest
    (never inside it — it is not signed, and is freely re-issuable): 15-minute
    presigned GETs for the ORIGINAL media (S3, `RAW_STORE`) — a 540p proxy cannot
    produce a clean 1080p export — the proxy when one exists, and the watermark
    PNG (R2, `brandAssetKey`) when the manifest carries one. Built from the signed
    manifest's own `source.mediaId`, never the project's current primary media, so
    a refresh minutes later still points at exactly what was signed.
  - **`GET /exports/manifests/{id}/sources`** reissues a fresh set once the
    originals expire mid-export. Same ownership checks as
    `POST .../complete` (workspace-owned, browser mode, not expired) minus the
    nonce claim — refreshing does not consume anything, so a manifest already
    completed has nothing left to refresh (`export/manifest_already_consumed`).
  - **`decision.ts`: H.264 decode+encode and a usable audio path, at every
    resolution.** Previously the capability gate only ran inside the 4K branch;
    it now runs first, for 1080p too. `capabilities.codecs` is A19's own wire
    shape (`VideoEncoder.isConfigSupported` results, gated on `VideoDecoder`
    existing at all) rather than the brief's literal `capabilities.codecs.h264`
    object — an avc1-prefixed entry is evidence of both decode and encode, so
    the existing DTO did not need a breaking shape change; noted as an adapted
    deviation, not a silent redesign. `capabilities.audioEncoder`, or the new
    `audioCopyPossible` escape hatch (an audio strategy that needs no
    re-encode — always `false` today; `ExportsService` does not yet probe the
    source's audio codec, a documented simplification) must also hold.
  - **HDR sources (`MediaAsset.hdr`) are cloud-only.** Wired into
    `ExportDecisionInput.isHdrSource`; refused the browser path with a
    tone-mapping reason, exactly like alpha/green-screen and mobile.
  - 61 decision-table tests (up from 44), 6 new e2e cases for the sources
    shape/TTL and the refresh route's ownership checks
    (`test/exports.e2e-spec.ts`), against a real Postgres and Redis.

- **B03 — web Subscription pages, checkout sheet and `UpgradeGate` wiring.** `/billing`
  (Overview: plan card with status/renewal/mandate cap, credits meter with lots and
  expiries, pause/cancel/resume with confirmations, streak slot behind a flag),
  `/billing/plans` (INR/USD from `GET /billing/plans`, monthly/yearly toggle, Agency
  seat stepper, offers ladder, credits-to-outcomes table, pay-once vs Autopay
  explainer, FAQ), `/billing/methods` (payment methods, mandates with the 24-hour
  pre-debit notice, revoke with a consequence-explained confirmation),
  `/billing/invoices` (GST break-up, credit-note linking, signed PDF download; built
  against B05's `invoices` row shape and resilient to `GET /invoices` 404ing while
  B05 is still landing), `/billing/usage` (ledger history, per-job attribution, lots,
  CSV export). The shared `CheckoutSheet` (`apps/web/components/billing/`) drives tax
  profile (State + optional GSTIN with checksum and state auto-fill for India,
  country elsewhere) → method (UPI Autopay / Card / pay-once; Netbanking marked
  unsupported by B01's checkout schema) → confirm (GST-inclusive break-up) → gateway
  (Razorpay Checkout.js from its official script URL, webhook-driven status polling)
  → success/failed, and handles the `409 billing/mandate_cap_exceeded` alternatives.
  `BillingUpgradeGate` composes `packages/ui`'s `UpgradeGate` with the sheet so any
  other work package can gate a control with one import. A typed client layer lives
  in `apps/web/lib/billing/` (endpoints, hooks, money/GST/checkout-state pure logic)
  rather than in `packages/api-client`, which is outside this work package's file
  boundary — see the report's Deviations. `apps/web/lib/nav.ts` flips the sidebar's
  "Subscription" item to `ready: true` and adds `BILLING_NAV`.

### Fixed

- **A05b — `onboardingSchema` rejected the multi-select onboarding answers.** Reported
  by A13. `apps/api/src/users/users.dto.ts`'s `onboardingSchema` accepted only
  `boolean | number | string` per `onboarding` value, so `PATCH /me` answered
  `400 common/validation_failed` (`path: "onboarding.makes"`, `code: "invalid_union"`)
  the moment either of onboarding steps 1–2 ("what you make", "languages you speak on
  camera" — both multi-select per `03-architecture/08-ux-design-system.md`
  §Onboarding) carried an answer, even though `CurrentUser.onboarding` /
  `OnboardingProfile` in `packages/api-client` and the onboarding screen had agreed on
  a `string[]` shape since A13 shipped. The value union now also accepts
  `z.array(z.string().max(64)).max(32)`; record keys are still capped at 48 characters
  each, and the record itself at 64 keys (up from 32, headroom for future onboarding
  questions) — every other bound unchanged. New unit tests in `profile.service.test.ts`
  cover an accepted array, one over the 32-element cap, one over the 64-character
  element cap, and a nested object still refused either as a top-level value or inside
  an array; a new `users-workspaces.e2e-spec.ts` case round-trips `makes`/`languages`
  arrays through `PATCH /me` and `GET /me` against a real database.
  `apps/web/e2e/auth.spec.ts`'s sign-up → onboarding → shell journey test is restored
  to its original assertions — the "documented failure" workaround A13 left in a
  comment in that file is gone.

- **A16e — the CanvasKit backdrop blur is clipped to its bounds.** Reported by A20.
  `render-core` documents a `backdrop` blur as blurring what is already on the surface
  **inside `bounds`**, and `@montaj/render-skia-node` clips to honour that. The browser
  executor passed the bounds to `saveLayer` and stopped there — but Skia treats
  `SaveLayerRec`'s bounds as a hint about how much surface the layer needs, not as a
  boundary on what the filter may touch, so it softened a sigma-wide band right across
  the frame. Over real footage that is the difference between a frosted caption panel
  and a fogged video. `executeCommands` now issues a `clipRect` before the layer.
  - Every committed baseline used a **flat** ground, on which blurring outside the panel
    changes nothing, which is why A16's own suite never saw it. The new
    `liquid-glass-hard-edge` baseline lays a hard edge through the panel: inside it must
    be blurred, outside it must stay razor hard, so a filter that does nothing and a
    filter that fogs the frame both fail. `BaselineFrame` gained an optional `ground`
    for this. Removing the clip moves 5,280 pixels and fails three assertions.
  - `render-skia-node`'s parity suite asserted the divergence on purpose
    (`outsideDiffering > 0`, "if `render-canvaskit` is fixed, this drops to zero"); it now
    asserts `0`, and the two backends agree inside **and** outside the panel. Affected
    baselines and the `liquid-glass` catalogue preview regenerated; the browser lane holds
    at 0 pixels differing on all eight frames.

### Added

- **B08 — api: team/agency seat billing sync + pooled credits, ownership transfer, client tags, devices, licence keys, plugin activate/heartbeat; web: Team, Devices (registered devices), Licence keys pages.**
  - **Seat billing and pooled credits react to membership changes.** `workspaces/teams/seat-billing.service.ts` listens for `workspaces.membership.seats_changed` (emitted by `members.service.ts#accept`/`#remove`, a two-line, documented deviation outside this work package's file boundary) and (1) syncs a live Studio/Agency subscription's `seats` to the workspace's actual active-membership count through `SubscriptionService.changePlan` — the same proration/mandate-reregistration path a manual plan change uses — and (2) raises `credit_accounts.monthly_grant_tenths` to match the recomputed entitlement, granting the difference as an immediate lot (`CreditsFacade.grantLot`), never clawing back. `EntitlementService.compute()` (A05) is extended to multiply `creditsPerMonthTenths` and `entitlements.activeDevices` by the live subscription's billed seats for a plan marked `perSeat` (Agency) — the one change to an existing file outside `teams/`.
  - **Ownership transfer** (orchestrator addendum after A05): `POST /workspaces/{id}/transfer-ownership {toMembershipId, confirmToken?}` — owner only, target must be an active member, a two-step confirmation-token flow (10-minute single-use token, mailed to the _current_ owner through a new `WorkspaceNotifier.ownershipTransferRequested`) rather than re-authentication, which an HTTP-only service has no way to verify. Sessions are left untouched.
  - **Client tags** on projects (already existed, A06) and now folders (`folders.client_tag`, migration `20260902090000_b08_folder_client_tag`): `GET/PATCH .../client-tag`, `GET /workspaces/{id}/client-tags` (tag catalogue with counts), `GET .../client-tags/{tag}/projects` (the filter).
  - **Devices** (`devices/`): `POST /devices/register` (fingerprint-keyed upsert, refreshes the 7-day lease without double-counting), `GET/PATCH/DELETE /devices`, enforcing the plan's device limit (Free 1, Starter 1, Creator 2, Studio 5, Agency 3 per seat, read from the now-per-seat-scaled entitlement) with `409 devices/limit_reached` and the revocable list.
  - **Licence keys** (`licensing/`): `POST/GET/DELETE /workspaces/{id}/license-keys` mint `AK-XXXX-XXXX-XXXX` (22-symbol unambiguous alphabet); `POST /plugins/activate {licenseKey|deviceCode, device}` (the `deviceCode` branch polls the same `DeviceCodeService.poll` `POST /auth/device/token` uses — no forked state machine) and `POST /plugins/heartbeat {nonce, deviceId, licenseKey?}` renew a device's 7-day lease and return the licence's `revocationSerial`; `GET /plugins/revocation-snapshot` is a signed daily snapshot (24h cached) for fully offline clients. `signing.service.ts` signs both the per-activation `licenseSnapshot` and the revocation snapshot with `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` (reused rather than a new key pair; `LICENSE_SIGNING_KID` new env var, default `k1`) using the same hand-rolled RS256 compact-token scheme `auth/token.service.ts` uses for access tokens; `licensing/offline-verify.ts` is the client-side reference verifier (unit-tested for signature tampering, wrong key, `alg:none`, and the 7-day window ± 5-minute clock skew).
  - **web**: `/team` (members, invite, role change, remove, seats/cost preview from `useEntitlement`, client tags, ownership transfer dialog), `/plugins/keys` (create — key shown once — list, revoke), and a new "Devices" section on `/settings/devices` alongside the existing session list (a `devices` row is a plugin/desktop registration counted against the plan limit, distinct from an auth session). `packages/api-client` gained hand-written types/endpoints/hooks for members (previously unwired despite A05 shipping the routes), devices, licensing and client tags, plus the generated `operations.ts`/`openapi.json` refresh (`pnpm gen:client`).
  - **Tests**: `test/b08-teams.e2e-spec.ts` (seat proration incl. the mandate-reregistration D40 edge case, pooled credits, ownership transfer incl. the invalid-target case, client tags, a role-matrix contract test) and `test/b08-devices-licensing.e2e-spec.ts` (device limits/revocation → heartbeat failure, per-seat Agency device scaling, licence key creation/activation/heartbeat/nonce-replay/revocation propagation, device-code activation), both against a real Postgres/Redis; `licensing/offline-verify.test.ts` and `licensing/license-key.util.test.ts` (pure unit tests, signature/clock-skew); `apps/web/e2e/team-devices-licensing.spec.ts` (functional, chromium + WebKit) and three new screens added to `apps/web/e2e/a11y.spec.ts`'s existing signed-in axe pass.
  - **Deviations** (reported per the brief, not hidden): (1) `members.service.ts` and `auth/auth.module.ts`/`workspaces/workspaces.module.ts` needed small additive edits outside this work package's stated file boundary — an event emit, an `AuthModule` export, a `WORKSPACE_NOTIFIER` export — the same pattern B05's `billing-events.ts` used for the equivalent billing-events edit. (2) Licence-key signing reuses the access-token RSA key pair rather than a second one — no second key pair exists anywhere in this codebase's env schema, and the brief only names `kid`, not a distinct pair. (3) A licence-key-activated device (no signed-in person) is attributed to the workspace owner (`devices.user_id` is `NOT NULL`; 06 does not say who else it could be). (4) A real, pre-existing bug found while writing these tests and fixed in the same commit: `test/billing-harness.ts`'s pattern of clearing `billing_events` between tests was not something this suite's own new harness copied at first, which silently made `FakeProvider`'s deterministic event ids collide across tests and get treated as webhook replays — fixed in `test/b08-harness.ts#reset()`.
- **B07b — the give-get referral loop (D53, F-607): personal `AK-XXXXXX` codes, claim at onboarding, 30/30 credits on the referred workspace's first completed export, caps and abuse rules, the tiered bonus, the in-app prompt and the Invite-friends tab.**
  - **`apps/api/src/referrals/**` (new `ReferralsModule`).** `POST /referrals/claim
{code}` classifies a posted code by prefix (`AK-` is a referral code; anything
    else is a no-op here — B07's affiliate attribution owns it) and creates a
    `pending` `referral_rewards` row, running every check decidable immediately:
    self-referral, either side a declared minor (D60), a disposable referred-email
    domain, or the same device/IP fingerprint as the referrer's most recent session
    (THREAT-MODEL T17) — all four reject at claim time. `GET /referrals/me` lazily
    allocates the workspace's personal code and reports reward counts, the tiered-
    bonus timestamp, and `promptEligible` (computed server-side: a succeeded export
    exists and the sheet has not been shown yet, so the frontend never re-derives
    "first export" itself). `POST /referrals/prompt/shown` marks the sheet shown,
    once, idempotently.
  - **The grant.** `ExportCompletedListener` reacts to a new `export.completed`
    `EventEmitter2` event (`export-completed.event.ts`) emitted from
    `exports/exports.service.ts`'s browser `completeManifest()` and both cloud
    completion handlers in `exports/render-completion.handler.ts` (one shared
    `recordPublishEvent()` helper covers `render.video` and `render.subtitle`) —
    additive, non-forking edits outside this work package's file boundary, flagged
    per `invoices/billing-events.ts`'s precedent. `ReferralsService.grantForExport`
    is a no-op unless the workspace has a still-`pending` referral; when it does, it
    checks the referrer's Free-plan monthly cap (10 granted rewards/calendar month,
    checked at grant time since it moves between claim and export) and resolves the
    row to `granted` or `rejected: cap` with the same conditional `UPDATE … WHERE
status = 'pending'` idempotency trick `claimManifest` uses for a replayed
    completion — so a duplicate event grants at most once. A granted row calls
    `CreditsFacade.grantLot({source: "referral", tenths: 300})` for both sides as
    non-expiring lots (B02); a 3rd granted referral for one referrer additionally
    grants a once-only 1000-tenths (100-credit) tier bonus
    (13-launch-plan), guarded by a new `workspaces.referral_bonus_granted_at`.
  - **Data**: migration `20260902090000_b07b_referral_loop` reshapes A03's unused
    `referral_rewards` (no application code read or wrote it) into the brief's
    two-workspace shape — `referrerWorkspaceId`, `referredWorkspaceId` (unique, the
    exactly-once grant guarantee), separate `referrerLotId`/`referredLotId`,
    `reason`, `deviceHash`/`ipHash` — and adds `workspaces.referral_code` (unique),
    `referral_bonus_granted_at`, `referral_prompt_shown_at`.
  - **web: `apps/web/components/referrals/**`.** `ReferralPromptSheet` (the give-get
    sheet, "Give 30 credits, get 30 credits") and `InviteFriendsTab`, both
    self-contained (they read `useReferralStats`/`useMarkReferralPromptShown`/
    `useClaimReferral` themselves) and shipped with a documented mount point rather
    than wired into a page — B07's Refer & Earn page shell had not landed on `main`
    yet. `ReferralPromptSheet` is mounted into `components/shell/app-shell.tsx`
    (documented, additive) so a workspace sees it once, on any authenticated page,
    after its first completed export; `onboarding-flow.tsx` gets one additive,
    best-effort `useClaimReferral()` call on a successful `finish()` (documented,
    additive) so the code the form already collected is actually claimed.
    `ReferralShareRow`/`share-links.ts` back the copy-code/copy-link/WhatsApp/X/
    Instagram-caption row both surfaces render.
  - **Tests**: `apps/api/src/referrals/*.test.ts` (code generation/classification,
    disposable-email); `apps/api/test/referrals.e2e-spec.ts` (26 cases against a
    real Postgres and the real `LedgerCreditsFacade` — claim, all four abuse
    rejections, idempotent claim, the Free cap and its Starter exemption, the tiered
    bonus and its once-only guard, `promptEligible` transitions, idempotent grant
    under a duplicate `grantForExport` call); `apps/api/test/referrals-http.e2e-spec.ts`
    (the same grant proven over real HTTP through the real `export.completed` emit,
    not by calling the service directly); web component tests for both components;
    `apps/web/e2e/referral-prompt.spec.ts` (Playwright + axe: the sheet opens once,
    marks itself shown, does not reopen, no serious/critical a11y violations).
- **A19b — web: A21b integration, raw pixel readback, coverScaleCrop parity, real
  audio re-encode, HDR-to-cloud, the watermark upsell mount.** Follow-up after A21b
  (`cfa5485`) closed the source-URL and eligibility gaps A19 reported. Consumes
  `sources: {rawUrl, proxyUrl?, watermarkUrl?}` and `GET
/exports/manifests/{id}/sources` (`endpoints.ts`, `manifest.ts`) — `ExportButton.tsx`'s
  proxy-only workaround is gone. `engine.ts`'s frame loop no longer round-trips the
  caption layer through a PNG encode/decode: a persistent `MakeSurface` raster surface
  and scratch 2D canvas are reused for the whole export, with `readPixels` →
  `putImageData` → `drawImage` per frame (measured 0.12× realtime at 1080p on this
  sandbox's headless, no-hardware-encode chromium — see `apps/web/lib/export/README.md`'s
  Throughput section for why that number is not the ≥1× target's last word). Uses
  `@montaj/render-manifest`'s own `coverScaleCrop` for the cover fit instead of
  Mediabunny's `fit: "cover"` heuristic, and adds a real D33 parity check
  (`engine-parity.test.ts`) comparing `engine.ts`'s exact compositing path against
  `@montaj/render-skia-node`'s cloud renderer on `@montaj/render-canvaskit`'s baseline
  frames. Cut audio is now really re-encoded (retained source ranges fed through
  `AudioSampleSink`/`AudioBufferSource`, concatenated with no gap); `"replace"` audio and
  any `speed`/`hold` edit route to the cloud with a documented reason (no signed URL for
  cleaned-track bytes yet; no resampled rate implemented). HDR sources route to the cloud
  automatically via A21b's `decision.ts` — no client-side LUT work needed. B04's
  `ExportUpsellPanel` is now mounted inside `WatermarkNotice`, exactly at its documented
  mount point. `cfa5485` had landed on `wp/A21`, not yet `main`, when this pass started;
  cherry-picked directly rather than waiting, since it is a small, self-contained
  `apps/api`/`api-client`-only commit — see the final report.

- **A19 — web: browser-native export (WebCodecs + Mediabunny + CanvasKit).**
  `apps/web/lib/export/**`: a capability probe (H.264 codec ladder, AAC/`AudioEncoder`,
  File System Access, a 2 s throughput sample), manifest handling (`RenderManifest`
  request/sanity-check/completion against the real, HMAC-signed `@montaj/render-manifest`
  document — no client-side signature verification, see the deviation below), the
  audio decision tree (packet copy / native AAC encode / lazy `@mediabunny/aac-encoder`
  polyfill / cloud), client-side SRT/VTT/TXT subtitle generation from the projection +
  `@montaj/timemap`, and the decode → composite → encode → mux engine itself: Mediabunny
  `Input`/`CanvasSink` decodes the source, `@montaj/render-core`'s `renderFrame` (same
  `DrawCommand[]` the cloud renderer uses, watermark included whenever the manifest
  carries one) is rasterised per frame by `@montaj/render-canvaskit` and composited over
  the decoded frame, and Mediabunny's `CanvasSource`/`EncodedAudioPacketSource`/
  `AudioBufferSource` encode and mux to MP4 — streamed to a File System Access sink when
  available, else buffered in memory, with progress, cancellation and a hard duration cap
  (1080p ≤ 20 min, 4K ≤ 10 min desktop-Chromium-only). `apps/web/components/editor/export/**`:
  the editor's Export dialog (Video/Subtitles/To-editor tabs, a watermark notice with no
  client-side toggle, credit cost, progress and cancel), mounted from a new `ExportButton`
  in `editor-client.tsx`'s toolbar. `apps/web/app/(app)/export-harness/page.tsx` is a bare,
  unlinked page exposing the engine on `window` for the Playwright suite to drive with real
  WebCodecs. `apps/web/next.config.ts` rewrites `node:` specifiers to their bare form for the
  client bundle (`NormalModuleReplacementPlugin`) so `@montaj/render-manifest`'s
  `node:crypto` import (server-only signing code, unreachable at runtime from the browser
  exporter) does not fail the webpack build. New Playwright specs: `e2e/export.spec.ts`
  (chromium) exports a real 10 s fixture MP4 end to end — real API-issued signed manifest,
  real WebCodecs decode/encode, `ffprobe`-verified duration and codec, a sampled frame
  hashed, `POST /exports/manifests/{id}/complete` accepted — and `e2e/export-fallback.spec.ts`
  (webkit) asserts the capability probe reports the browser path ineligible and that the
  dialog's own mode selection (never `"auto"` for an ineligible probe) still gets a working
  cloud decision back. See `apps/web/lib/export/README.md` for the full design, the browser
  support matrix, and every deviation from the brief (no client-side manifest signature
  verification — the package signs with a symmetric HMAC, not a keypair, mirroring A21's own
  reported deviation; the raw-bucket source and the watermark-asset bytes have no
  client-reachable signed-URL endpoint yet; `@montaj/ass-exporter` is still A01's unimplemented
  skeleton so ASS export is greyed out; the cleaned/cut audio re-encode path is wired through
  the audio decision tree but not yet connected to a resampled sample source).
- **B07 — api + web: Affiliate v2 (apply with PAN, 60-day cookie + code attribution,
  rate tiers, FY-to-date TDS accumulator, RazorpayX payouts, fraud rules, dashboard,
  asset pack pages).**
  - **Application (`POST /affiliate/apply`).** India-only at launch (`affiliate/
region_unsupported` otherwise); PAN validated (`AAAAA9999A`) and stored
    AES-256-GCM-encrypted at rest (key HKDF-derived from `INTERNAL_CALLBACK_SECRET`,
    domain-separated — no new frozen-contract env var); a non-guessable 8-character
    Crockford-base32 code, revocable by admin. Admin `approve`/`suspend`/`reject`/
    `revoke-code` routes behind `AdminGuard` (UI is B13's).
  - **Attribution (`/r/<code>` in web, `apps/web/app/(site)/r/[code]/route.ts`).** Sets a
    first-party, `httpOnly`, 60-day last-click cookie and records an `affiliate_clicks`
    row; `POST /affiliate/attribution/attach` resolves precedence — an entered code
    always wins over an unexpired cookie (`affiliates/attribution.ts`, pure and unit
    tested) — and rejects a self-referral (same user, device, or payment fingerprint)
    with an audit row.
  - **Commission engine (`affiliates/commission-schedule.ts` + `commission.service.ts`).**
    Months 1–3 of a monthly subscription at 40%, months 4–12 at 15%, a yearly payment at
    20% once per referral; after 10 active paying referrals the affiliate's tier becomes
    `while_subscribed_30` — a flat 30% on every subsequent payment, forward-only. Base
    excludes GST (the invoice's `taxableValueMinor`); commissions are `pending` with a
    30-day `availableAt` hold, `clawed_back` (negative reconciliation against the running
    balance) on a refund/chargeback credit note. Driven by two new events
    (`affiliates/invoice-events.ts`) emitted from `invoices/invoices.service.ts` right
    after its two existing "issued" transitions — additive, observe-only, mirroring the
    precedent `invoices/billing-events.ts` already set for B01→B05.
  - **TDS (`affiliates/tds.ts`).** `affiliate_fy_totals` FY (Apr–Mar) accumulator; once
    the running gross crosses ₹20,000 the crossing commission and every later one that FY
    are taxed at 2% (20% without a verified PAN), `tdsSection` always `194H` — the
    `affiliate_tds_section` flag only switches the Form 16A stub between final and a
    "DRAFT — pending CA confirmation" watermark (H-18/RR-05, 194H vs 194-O).
  - **Payouts (`affiliates/payouts/`).** `PayoutProvider` interface, `FakePayoutProvider`
    (every test in this environment — no RazorpayX keys) and a `RazorpayXProvider` stub
    reading the public Payouts API shape (unverified without live keys, documented in
    `affiliates/README.md`); monthly batch task sweeps `payable` commissions per
    affiliate, skips a batch under the ₹1,000 net minimum (rolls forward), records
    `providerFeeMinor`/`challanRef`/`tdsTotalMinor` on `payouts`.
  - **Fraud (`affiliates/fraud.ts` + `fraud.service.ts`, THREAT-MODEL T17).** Burst
    sign-ups from one IP/device hash and a refund ratio over 30% of an affiliate's
    referrals both move it to `suspended_review` (new `AffiliateStatus` value); a
    suspended or under-review affiliate earns nothing (`CommissionService` checks
    `status === "approved"` before recording).
  - **Dashboard (`apps/web/app/(app)/affiliate/**`).** Apply form with PAN and the ASCI
    disclosure clause verbatim; once approved, the link/code with copy, clicks/sign-ups/
    paid/pending/available/paid-out stats, tier progress toward `while_subscribed_30`,
    FY-to-date gross/TDS/net, and a link to `/affiliate/assets` (scripts, 9:16 demo cut
    and before/after-clip placeholders, the permitted disclosure labels table, and the
    programme rules).
  - Two scheduler tasks (`affiliates.commission-maturation`, `affiliates.payout-batch`)
    register with the shared `ScheduledTasksService` for B16 to wire a production cron
    trigger to; this work package implements the task bodies and drives them directly
    (`runNow`) in tests.
  - Schema: `AffiliateStatus.suspended_review`; `affiliates.tier`/`fraudFlag`; new
    `affiliate_clicks` table; `referrals.ipHash`/`deviceHash`/`paymentFingerprint`/
    `monthlyPaidCount`/`yearlyCommissionPaid`/`countsTowardTier` (migration
    `20260902090000_b07_affiliate_v2`, additive only).
  - Tests: attribution precedence and expiry, the full commission schedule table
    (exact minor-unit arithmetic), the TDS threshold crossing with/without a verified
    PAN, self-referral/burst/refund-ratio fraud predicates — all pure-function unit
    tests — plus an API e2e suite (`apps/api/test/affiliates.e2e-spec.ts`) covering
    attribution → a real paid invoice (via B01's `FakeProvider`) → pending commission →
    30-day maturation → payout batch, and self-referral rejection; a Playwright spec
    (`apps/web/e2e/affiliate.spec.ts`) axe-checks the apply form, the pending-state
    dashboard, and the asset pack page.

- **B04 — api: the `offers` module (real signup-gift/₹9-pass/week-pass/top-up backing, ₹9 eligibility, instrumentation); web: export-dialog upsell panel, credits-meter top-up card, Subscription overview pass chips.**
  - **`OffersModule` backs the interfaces A21 left as no-ops.** `PassesNinePassLedger`
    (`nine-pass-ledger.impl.ts`) replaces `NoopNinePassLedger` as `ExportsModule`'s
    `NINE_PASS_LEDGER` binding: a `first_export` pass is "available" once
    `billing/webhooks.service.ts`'s `grantPass` stamps it paid (`consumedAt`) and stays
    available until `consume()` stamps a new `redeemedAt`/`redeemedManifestId` pair at
    manifest completion — a migration
    (`20260902080000_b04_offers_nine_pass_redeem`) adds both columns to
    `passes_purchased` specifically so "paid" and "spent" cannot collide (B01's own
    `consumedAt` already meant "the webhook landed," not "the workspace used it").
    **Manifest re-issue needs no new endpoint**: the client just re-calls `POST
/projects/{id}/exports` with the same parameters after the pass is paid — the
    decision engine (A21, unmodified) re-evaluates `ninePass.isAvailable` fresh and
    returns a clean manifest, satisfying "no re-render needed if the render has not
    started; if already rendered, re-run" without inventing a parallel mechanism.
  - **Eligibility, enforced server-side.** `nine-pass-eligibility.ts` is a pure,
    table-tested function (INR-only, never on a paid plan, once per workspace per 30
    days); `NinePassEligibilityService` resolves the DB state and is called from
    `billing/passes.service.ts#passCheckout` _after_ its existing INR check (so the
    pre-existing `billing/pass_kind_unavailable` 400 for a USD workspace is
    unchanged) and refuses with `409 offers/nine_pass_ineligible` otherwise.
  - **`GET /offers/eligibility`** (signup gift / ₹9 pass / week pass / ₹149 top-up,
    every amount read from `billing/billing.constants.ts`) and **`GET
/offers/passes`** (every pass, newest first, with a computed
    `pending_payment|available|active|redeemed|expired` status) back the web upsell
    panel and the Subscription overview's pass chips.
  - **`GET /admin/metrics/offers`** (`AdminOffersController`, registered in
    `admin.module.ts` per the `AdminCreditsController` convention): the ₹9 hypothesis
    (D55) — purchases, upgrades within 60 days, conversion rate, and a
    keep/replace/monitor recommendation from D55's own thresholds — derived from
    `passes_purchased`/`subscriptions` rather than a separate event log.
  - **Two dev/test-only routes**, `POST /offers/dev/simulate-nine-pass-payment` and
    `POST /offers/dev/consume-signup-gift` (`offers-dev.controller.ts`, registered
    under `BillingModule`): both refuse outright unless `BILLING_PROVIDER` resolves
    to `FakeProvider`, and carry no bearer auth (the Playwright e2e that calls them
    runs against the web app's own httpOnly-cookie session, which a cross-origin test
    client cannot attach as a header) — self-limited instead by needing an
    unguessable `passPurchaseId`/`workspaceId` already returned by a real
    authenticated call.
  - **Web**: `components/editor/export/upsell/ExportUpsellPanel.tsx` (signup gift →
    ₹9 clean export via Razorpay Checkout → week pass → "See plans", self-contained
    since the editor's own export dialog had not landed — A15/A19 own it; mount point
    documented in the component's header, exercised standalone at
    `/ui-kit/export-upsell`), `components/billing/passes/{PassStatusChips,
TopupCard}.tsx`, a new `/settings/subscription` page (Subscription overview did
    not exist before this work package), and `lib/billing/razorpay.ts` (the Checkout
    widget loader). `packages/api-client` gains `offersEndpoints`,
    `billingEndpoints` (subscription, pass/top-up checkout) and `creditsEndpoints`
    (balance), plus matching hooks and types.
  - Tests: the ₹9 eligibility table (currency/plan/30-day-window boundaries), a
    decision-engine test proving a ₹9 pass never clears a cloud render's watermark
    (acceptance criterion 1), and `test/offers.e2e-spec.ts` (pass lifecycle, checkout
    eligibility gating, week-pass entitlement raise and expiry via a fake `endsAt`,
    the Free top-up lot, manifest re-issue after a ₹9 purchase end to end, and
    `/admin/metrics/offers`) against a real PostgreSQL and Redis. Playwright:
    `e2e/offers-nine-pass.spec.ts` drives the real panel through a faked Razorpay
    widget and the dev-only webhook simulator.
- **A14 — web: Home and Projects, the presigned-multipart upload engine, and the style catalogue API.**
  - **Home (`/`, rewritten from `(app)/home/page.tsx` — see Deviations below).** A drop
    zone that goes straight to presigned S3/MinIO multipart URLs, never through the API
    process: parts hash client-side with a pure-JS streaming SHA-256 (a Web Worker when
    available, inline otherwise), upload in parallel (3 at a time), resume from an
    IndexedDB-persisted record after a reload, and report progress per file. The
    quick-pick row defaults to Hinglish (Roman) and `punch-pop` first (08 §Home), and
    opens A16's real `StylePicker` against the new `GET /styles` catalogue. "Try with a
    sample" creates the seeded sample project and opens it.
  - **Projects (`/projects`).** Search, status/language filters, an Agency-only client
    tag filter, sort, folders (create/rename/filter), bulk select (archive/delete),
    infinite scroll, and a detail sheet with retention date and job history. Cards read
    live job state from the realtime client (queued/processing/ready/failed), piggy-
    backing on `AppShell`'s existing `["ws", id, "jobs"]` realtime invalidation via a
    nested query key.
  - **`GET /styles`** (`apps/api/src/styles`) merges the seeded `style_presets` system
    catalogue with a workspace's own custom presets; the new
    `/workspaces/{id}/style-presets` `POST`/`PATCH`/`DELETE` routes validate a full
    StyleDoc v2 document server-side (D64's naming rule; a preset may not shadow or
    duplicate a key) and carry the same guard stack as the rest of `/workspaces/:id/*`.
  - **`POST /projects/sample`** creates a project from a small bundled WAV fixture,
    PUTting it directly to storage (not through the multipart path a real upload uses)
    and enqueuing `media.probe`, for Home's "Try with a sample".
  - Wired the real `POST /projects/{id}/transcribe` (A11, merged after this branch was
    cut) into the upload engine's best-effort "start transcribing" step and into
    `useTranscribe`; both treat `transcript/media_not_ready` as a normal outcome, not
    a failure.
  - **Deviations from the brief.** The brief's file boundary was
    `apps/web/app/(app)/(home)/**`; Next.js refuses two page files that resolve to the
    same path, and `(app)/(home)/page.tsx` and the marketing site's own homepage both
    resolve to `/`. Home lives at the real segment `apps/web/app/(app)/home/page.tsx`
    instead, with `middleware.ts` rewriting an authenticated `GET /` to it — the
    address bar, and the sidebar's Home link, never show `/home`.
- **A18a — `@montaj/ass-exporter` and the render parity gate (D33).**
  `toAss(projection, transcript, styleCatalogue, canvas, opts)` maps StyleDoc v2 to an
  ASS v4+ document (`[Script Info]`/`[V4+ Styles]`/`[Events]`): font/size/colours,
  `\bord`/`\shad`, `BorderStyle=3` boxes, `\pos` from the style's own layout anchor,
  and `\kf` karaoke fill for `karaoke-fill` styles on **Latin script only** — Devanagari
  and Tamil karaoke stay disabled and warn (`karaoke_non_latin_disabled`) until a parity
  test proves otherwise (RR-04 F7). Other word highlights (`color`, `scale`,
  `underline`, `glow`) degrade deterministically to one `Dialogue:` event per word,
  reported through a `warnings[]` list rather than silently dropped.
  `packages/ass-exporter/parity/run.ts` renders every shipped style three ways —
  browser CanvasKit vs cloud Skia (widening A20's own harness from one style to all 30)
  and `.ass` via `ffmpeg -vf ass=` (libass, `shaping=complex` verified for
  Devanagari/Tamil against RR-04 F6/F14 — see `parity/golden-devanagari.test.ts`) —
  and writes `packages/caption-styles/parity/results.json`;
  `parity/apply-flags.ts` is the **only** writer of each style's `assRenderable` /
  `assExportable` / `requiresLayoutMetrics` / `parityScore` fields (never by hand). A
  libass-less `ffmpeg` marks `assVsSkia` "not measured" rather than fabricating a score.
  `apps/api/src/exports/decision.ts` now gates an `ass` subtitle export on
  `assStylesRenderable` (every StyleDoc a project's captions reference having passed
  the gate) instead of refusing unconditionally; `apps/api/prisma/seed.ts` reads the
  same flags off each style document into `style_presets`' parity columns.
  `apps/render`'s `render.video` `path: "ass"` guard now checks the real flags rather
  than refusing unconditionally, naming the unrenderable style when one is found;
  burning the sidecar into pixels (the ffmpeg libass path replacing Skia rasterisation)
  is A20/A21 follow-up work, outside this package's own file boundary. New CI job
  `.github/workflows/parity.yml` runs the full 30 × 4 × 3 sweep on PRs touching the
  render packages or the style catalogue and fails with a diff if the flags moved,
  rather than committing them silently.

- **A15 — web: editor transcript column, EDG op queue, undo/redo, conflict
  chooser, reflow.** The left column of `/p/{id}` (08 §4) and the store
  everything else in the editor reads from.
  - **`EditorStore` (`apps/web/lib/edg/store.ts`)** is a plain class, not a
    hook: `serverState` (confirmed by the API) and `localState`
    (`serverState` with `EdgOpQueue.pendingOps()` applied through
    `@montaj/edg/ops`' own `applyOps`) are kept separate so optimistic edits,
    a 409 rebase and a realtime `edg.ops` merge all converge on the same
    function rather than three bespoke reconciliation paths.
  - **`EdgOpQueue` (`lib/edg/queue.ts`)** batches ops (debounce 250 ms, cap 50
    a batch — the brief's own numbers; the orchestrator's later "Facts
    decided" summary says ~400 ms with no cap, a discrepancy reported rather
    than silently picked), and rebases the still-pending queue against
    `opsSince` on a 409 using the identical `rebaseOps` the server ran
    (`packages/edg`'s rebase table). **Found and fixed in this work package:**
    `edg/too_stale` left the pending batch in place, so `flush()`'s own
    drain-more-while-in-flight check re-sent the unrebaseable batch forever —
    an infinite retry loop that reliably ran the test process out of memory.
    A `stalled` flag (cleared by `EditorStore.reload()`, the same recovery
    `edg/too_stale` already needed) closes it; `queue.test.ts` asserts
    `pendingOps()` is empty immediately after the failure, not just
    eventually.
  - **Undo/redo (`lib/edg/history.ts`, `ops.ts`'s `computeInverseOps`)** as
    inverse ops, grouped per action, 100 steps. Most of CONTRACTS §2's ops
    invert exactly; `DeleteWord` and `MergeSegments` cannot by construction
    (word and segment ids are never reused, D28) — their inverses are
    behaviourally exact (same text, timing, style, position) under a _fresh_
    id, which `ops.test.ts` checks directly. The property test (acceptance
    criterion 3: 100 random ops undone in order restore the initial
    projection) draws from the subset with an exact, id-preserving inverse —
    `EditWord`, `HideSegment`, `SetEmphasis`, `SetSegmentPosition`,
    `SetStyle` — since only that subset makes "back to the initial
    projection" a literal equality rather than a visual one.
  - **Conflict handling never drops a keystroke.** A same-word/same-caption
    409 surfaces both texts (`ConflictDialog.tsx`); resolving submits the
    chosen text as an ordinary fresh op, not a special "resolve" endpoint.
    `store.test.ts` runs two `EditorStore`s against one in-memory fake server
    (`FakeEdgServer`, the same `applyOps`/`rebaseOps` the real API calls) to
    prove same-word edits conflict and different-segment edits merge cleanly
    (acceptance criterion 2).
  - **Reflow, never silent (orchestrator addendum, D78).** `lib/edg/
caption-budgets.ts` compares the current style's `fitBudget` against
    `EdgHot.meta.engineVersions.captionBudgets` (A11's record of what it
    segmented with); a difference shows `ReflowBanner.tsx`, never an
    automatic `Resegment`. `fitBudget`'s `belowComfortableMinimum` is
    surfaced next to `RightPanel` (A16's own file; not this WP's to edit) as
    "this style shows one short word per caption".
  - **`TranscriptList.tsx`** virtualises with a hand-rolled variable-height
    windower (`lib/edg/virtual-list.ts`, prefix-sum + binary search — no
    external dependency was added for this), because segments vary in height
    with word count. `WordChip.tsx`: contenteditable, low-confidence
    underlined amber, fillers dimmed or hidden by toggle, a click selects and
    seeks, a double-click is "fix spelling everywhere"
    (`lib/edg/find-replace.ts`'s matcher, shared with Ctrl+F's dialog).
    `SegmentCard.tsx`: speaker chip, hide/merge buttons, right-click "insert
    word after". `BulkActionsBar.tsx`: merge-short/split-long
    (`lib/edg/bulk-actions.ts`, plain ops through the same queue) plus
    auto-resegment (server-minted, `EditorStore.resegment`).
  - **Keyboard map (08 §4)**: `Space`/`J`/`K`/`L` (wired to a local
    `PlayheadStore` scaffold — A17 owns the real one and does not exist yet),
    `S` split, `M` merge, `E` emphasise, `Del` delete word, `Ctrl+F`,
    `Ctrl+Z`/`Ctrl+Y`. One `window` listener
    (`lib/edg/keyboard-shortcuts.ts`), not one per `WordChip`, reading the
    live selection through a ref so a shortcut fires exactly once regardless
    of which chip has DOM focus.
  - **Integrates A16's `CaptionStage`/`RightPanel`** (already on `main`, not
    rebuilt) rather than the placeholders the original brief text describes —
    the orchestrator's later addenda assume them. `lib/edg/render-projection.
ts` bridges `EdgState` (this WP's domain model) to `@montaj/render-core`'s
    narrower render-only `EdgProjection`.
  - **Deviations from the literal file boundary**, reported rather than
    silently taken: `@montaj/edg` added to `apps/web/package.json`
    (the brief's own "op queue... with `@montaj/edg` `applyOps`" requires it;
    `pg`/`@types/pg` added as devDependencies for e2e seeding, `pg` chosen
    over reaching into `apps/api`'s own `node_modules` for `@prisma/client`);
    `apps/web/middleware.ts` gained `/p` in `PROTECTED` (every other
    authenticated route redirects server-side before HTML ships; `/p` did
    not); `apps/web/e2e/*` used for Playwright specs, since the brief's file
    boundary omits it but the brief itself requires e2e coverage and every
    other WP's specs already share that directory.

- **B05 — api: invoices (Rule 46), tax engine, credit notes, export invoices
  under LUT, signed PDFs, e-invoicing hook, FIRC records, tax registrations.**
  - **`tax/`** — place of supply (GSTIN → recorded State → billing address,
    D41), intra-state (CGST 9% + SGST 9%) / inter-state (IGST 18%) / export
    (0%, LUT) / `import_rcm` (self-invoice, reverse charge) rate selection,
    Rule 35 GST-inclusive back-computation with explicit, reconciled rounding
    (`roundOffMinor`), and a pluggable USD→INR exchange-rate provider
    (`ManualFallbackExchangeRateProvider` today — no live RBI feed key exists
    in this environment, same posture `billing/providers/provider.factory.ts`
    takes for Razorpay).
  - **`invoices/`** — numbering per `(series, fiscalYear)` off a real Postgres
    `SEQUENCE`, lazily created under an advisory lock so 200 concurrent
    invoices in one series/year get unique, gap-free numbers with no lock on
    the hot path; document types `tax_invoice`, `export_invoice`,
    `credit_note` (every refund, linked to the original, reason code),
    `debit_note`, `self_invoice`, `bill_of_supply`; **India B2C invoices hard-fail
    without a recorded State** (`invoices/state_required`, D41); `gstr1Period`
    stamped on every row.
  - **PDF** (`invoices/pdf/`) — `pdfkit`, no headless browser; every Rule 46
    particular, the GST break-up, "incl. GST" display, HSN/SAC, the LUT
    export endorsement verbatim, and a visible "Digitally signed" block.
    Detached signature (`signature.service.ts`): SHA-256 of the exact stored
    PDF bytes, HMAC-SHA256 by default (over `INTERNAL_CALLBACK_SECRET`) or
    RSA-SHA256 when an optional, non-contract `INVOICE_SIGNING_KEY` is set;
    stored as its own small JSON record next to the PDF in derived storage.
  - **`einvoice/`** — `EInvoiceProvider` interface, `NoopEInvoiceProvider`, and
    a government e-invoice (IRP) schema payload builder, gated on
    `FEATURE_FLAGS_JSON.einvoice_enabled` (off by default) — not wired to a
    GSP.
  - **`firc/`** — `firc_records` from a settled USD payment, and a monthly
    export-filing CSV (`GET /admin/firc-records/csv?month=YYYY-MM`, EDF-regime
    placeholder).
  - **`tax-registrations/`** — admin-editable GSTIN/LUT rows
    (`/admin/tax-registrations`, `AdminGuard`) and a startup check that warns
    when USD activity exists with no valid LUT on file.
  - **Triggered from `billing/webhooks.service.ts`'s existing state
    transitions via `EventEmitter2`** (`EventEmitterModule.forRoot()`,
    registered once in `app.module.ts`), not a fork of the state machine —
    five `this.events.emit(...)` calls added after the transitions that were
    already there; `invoices/listeners/billing-events.listener.ts` turns each
    into an invoice or credit note. See `invoices/billing-events.ts`'s
    doc-comment and the work package report for the file-boundary deviation
    this required.
  - Billing documents are exempt from every purge by construction: `media/
retention.service.ts`'s `purgeDueMedia` only ever queries `media_assets`,
    never `invoices` — asserted by a new test rather than by a special case.
  - Golden PDFs (India B2C intra-state, India B2B inter-state, USD export
    under LUT, credit note), text-extracted and asserted against every Rule 46
    particular. Text extraction is a small dependency-free extractor
    (`pdf-text-extract.ts`), not a library — see its doc-comment: the obvious
    choice, `pdf-parse`, throws `bad XRef entry` on a valid PDF the moment
    `zlib` has been used anywhere earlier in the same process, reproduced in
    isolation with no `pdfkit` involved.
  - **Deviations, all reported in full in the work package's final message:**
    a placeholder default SAC code (`998316`) pending CA confirmation; the
    brief's own `AKS/26-27/IN/000123` example is 19 characters against its own
    "(≤ 16 chars)" annotation — implemented against the shipped
    `invoices_number_length_check` CHECK (the `number` column, 6 digits) with
    the full string composed only for display; supplier legal
    name/address/PAN read from optional, non-contract environment variables
    (`SUPPLIER_LEGAL_NAME` etc.) pending real registered-office details;
    invoice/credit-note email reuses `MailProvider` directly rather than
    `NotifyService`'s closed `NotifyKind` catalogue (adding a kind would edit
    `notify.kinds.test.ts`'s hard-pinned ten-value list; the closest existing
    kind's copy — "kept for N days, then deleted" — is false for a document
    retained 72 months).
- **A17 — web: editor timeline (waveform, word/segment lanes, playhead, zoom,
  lanes API, keyboard nudge, output-time mode).**
  - **`Timeline.tsx` (`apps/web/components/editor/timeline/`)** draws the
    whole row — A07's `waveform.json` peaks/RMS, a time ruler, the word and
    segment lanes and three read-only pass-item lanes (cuts/zoom/audio) — on
    one Canvas2D surface, the same "no DOM per row" precedent A16's
    `CaptionStage` set for the preview canvas, and for the same reason: one
    `<div>` per word in a multi-hour transcript is what the brief's own
    55 fps floor rules out. All the maths lives in `apps/web/lib/timeline/*.ts`,
    unit-tested without a browser (`coords.ts` time↔px and zoom,
    `snapping.ts`, `output-clock.ts`, `lanes.ts`, `waveform-view.ts`,
    `nudge.ts`) — 51 tests, including a `fast-check` property test that
    dragging never produces an overlapping or inverted segment.
  - **Segment-edge drag and the arrow-key nudge both resolve through
    `resolveSegmentDrag`** (snap to the nearest word boundary within 40 ms,
    then clamp to the bounds invariants) into one `SetSegmentBounds`
    (CONTRACTS §2) on drop/keypress — never per pointer move, same discipline
    `CaptionStage`'s own drag handle already uses for `SetSegmentPosition`.
    Double-click splits at the nearest word; a button merges with the next
    segment.
  - **Output-time mode** (`lib/timeline/output-clock.ts`) maps the ruler and
    playhead onto `@montaj/timemap`'s output clock once an accepted cut
    exists; scrubbing always resolves back to source ms for the (still
    source-time) proxy `<video>`, per the brief.
  - **The lanes API** (`lib/timeline/lanes.ts`) turns a document's pass items
    into three typed, coloured-by-state rows B20 can add accept/reject
    affordances to without this module changing.
  - **A timing-nudge interface** (`lib/timeline/nudge.ts`) — every resolved
    drag/keyboard delta is emitted to a `TimingNudgeSink`; `noopNudgeSink` is
    the only implementation until B09 exists, matching the brief's own
    wording ("an interface with a no-op sink now").
  - **Deviation, reported rather than resolved:** the brief's "word block
    drag → `EditWord` op" has no backing op — `EditWordOpSchema` (CONTRACTS
    §2) carries only `{wordId, text, script?}`, never `s`/`e`; word timing is
    set once at transcription and is not client-editable through any op in
    `packages/edg`. Word blocks are therefore read-only/selectable (click
    seeks and selects, low-confidence tint, filler dim, tombstoned hidden);
    all retiming happens on the segment lane, which matches
    `SetSegmentBoundsOpSchema` exactly.
  - **Integration outside the brief's literal file boundary:** wiring
    `<Timeline>` into `apps/web/app/(app)/p/[id]/editor-client.tsx` (mount,
    `SetSegmentBounds` submit path, `CaptionStage`'s `src` pointed at the
    real proxy URL) required a small additive patch to that file, which A15's
    own file-boundary note already anticipated for A16's `CaptionStage`. A
    new `apps/web/lib/timeline/use-timeline-media.ts` fetches the proxy/
    waveform signed URLs via `@montaj/api-client`'s documented
    `defineEndpoint` + `useRawApiClient()` escape hatch — "for a call the
    hooks do not cover yet" — rather than editing that package's curated
    `endpoints.ts`.
  - **e2e:** `apps/web/e2e/timeline.spec.ts` (6 tests: draw, segment-edge
    drag lands the op, ruler scrub, zoom, keyboard nudge, axe) on chromium
    and webkit; `timeline-performance.spec.ts` measures a 3-hour,
    54,000-word timeline's scroll/zoom fps. A fresh e2e sign-up's workspace
    has no credit grant (only `prisma/seed.ts`'s demo workspace does), so
    `apps/web/e2e/timeline-credits.ts` grants one directly (same
    `credit_accounts`/`credit_lots`/`credit_ledger` shape the seed script
    writes), the same "one non-HTTP step" precedent as `editor-fixtures.ts`'s
    `insertProbedMedia`.
- **A22 — scripts and translation: transliteration (`ai.transliterate`), translation
  (`ai.translate`), the producers, and the editor's script tabs.**
  - **Transliteration writes per word, translation writes per segment, and each
    gets the write path that shape actually needs.** `word.scripts` can carry
    thousands of values per job and CONTRACTS §2's `EdgOp` union has no bulk op for
    it, so the worker writes those through a new signed surface,
    `POST /internal/transcripts/{id}/scripts` (`apps/api/src/transcripts/scripts/
scripts-internal.controller.ts`), which patches only the `transcript_chunks`
    rows a job actually touched. Translation is a few hundred segments at most and
    CONTRACTS §2 already has `SetSegmentText{segmentId, script, text}`, so it
    reuses A12's **existing** `POST /internal/projects/{id}/edg/ops` unchanged —
    landing as `textOverrides.translated`, revisioned, rebased and undoable exactly
    like an interactive edit, with a genuine conflict coming back as the same 409 a
    concurrent human edit would.
  - **Transliteration is free** (`04-pricing-and-monetization.md` has no burn-rate
    row for it); the job is still admitted through `JobsService.enqueue` with a
    zero-tenths hold, so CONTRACTS §4's "every producer reserves" rule holds even
    when the reservation is for nothing. **Translation reuses the existing
    `translation` burn rate** (0.5 credit / media minute / target language) and
    adds the plan gate `04 §Plans` describes: refused outright below Starter,
    refused for anything but English below Creator (`transcript/plan_required`).
  - **IndicXlit, without a vendor key.** No AI4Bharat model weight exists in this
    environment (A00-06), so `RuleTableTransliterationProvider`
    (`apps/worker-ai/worker_ai/transliterate/`) is a deterministic dictionary +
    syllable-table transliterator for Hindi/Devanagari and Tamil, plus numeral and
    punctuation rules that apply to every supported language. The Hinglish rule —
    English words stay Roman — is a curated dictionary and a morphology check
    (`-ing`, `-tion`, …), checked before any script mapping runs.
    `IndicXlitHttpProvider` is the seam for a served model; **no `apps/model-server`
    route was added**, because there is nothing to serve yet (decision recorded in
    `apps/worker-ai/worker_ai/transliterate/provider.py`).
  - **The translation provider chain** — `SarvamMayuraProvider` →
    `IndicTrans2Provider` (self-hosted, only when `WORKER_AI_INDICTRANS2_URL` is
    set) → `LLMTranslateProvider` (`LLM_PROVIDER=anthropic|openai|mock`) — tries
    each in order until one succeeds. **Glossary terms are masked to opaque
    placeholders before any provider sees the text** (`translate/glossary.py`), so
    every adapter gets verbatim preservation for free rather than depending on a
    provider-specific instruction. A segment still over the **1.3x length budget**
    after one "shorter, please" retry is hard-truncated on a word boundary
    (`translate/length.py`), so the budget holds unconditionally, not just usually.
  - **A pre-existing gap between A11's chunk-read contract and A12's word-patch
    contract, found and routed around, not fixed.** `TranscriptsRepository.
chunkPage`/`allChunks` (`GET /projects/{id}/transcript`, the exporters) select
    `transcript_chunks` by an exact `revision` match; `EdgRepository.persistWords`
    (`EditWord`) bumps `transcripts.currentRevision` without changing the row's own
    `revision` at all, so a client reading the default revision after any word edit
    gets an empty page. Reachable today through an ordinary `EditWord` op — this
    work package's own write avoids adding a second way to hit it by never bumping
    `currentRevision` for a transliteration, but the underlying gap is unresolved
    and is reported to the orchestrator (`apps/api/src/transcripts/scripts/
scripts.repository.ts`'s class doc) rather than patched here.
  - **`?script=` on `GET /projects/{id}/transcript` and the transcript export**
    (`roman | native | en | translated`): the manifest projects each word's `t`
    onto `scripts[script]`, falling back to the word's own primary text; export
    threads the same choice through `transcript-export.ts`'s `toCues`, preferring a
    segment's own `textOverrides[script]` first. Omitted, both keep their exact
    pre-A22 behaviour.
  - **`GET /projects/{id}/transcript/scripts`** reports availability and provenance
    per script — `roman`/`native`/`en` from a scan of the transcript's own words,
    `translated` from the EDG segments plus the `transcript.scripts_updated` /
    `transcript.translated` job events this work package's two completion handlers
    log, so the editor's tabs and the "regenerate" confirmation know what is
    already there and who made it.
  - **`ScriptTabs`/`RegenerateTranslationDialog`**
    (`apps/web/components/editor/transcript/scripts/`) and three new
    `@montaj/api-client` hooks (`useTranscriptScripts`, `useTransliterateTranscript`,
    `useTranslateTranscript`) — self-contained and tested against a mocked `fetch`,
    because **A15 (the transcript editor) and A19 (the export dialog) are not yet
    on `main`** to wire into; the integration note each leaves behind names exactly
    what dropping them in involves once those work packages land.
  - Golden transliteration tests (Hinglish sentence → Devanagari with English words
    preserved; a Tamil sentence) in `apps/worker-ai/tests/test_transliterate.py`;
    provider-chain, length-aware-retry and glossary-preservation tests plus fixture
    tests for all three translation adapters in `test_translate.py`; a real-database
    e2e (`apps/api/test/transcripts-scripts.e2e-spec.ts`) that runs a transliteration
    and a translation through the real signed write paths against a seeded Hinglish
    transcript and asserts the per-word scripts, the segment override, the
    provenance read and the export in each script.

- **A21 — api: the exports module (decision engine, signed render manifests, cloud render/subtitle jobs, downloads, brand assets).**
  - **`POST /projects/{id}/exports`** runs the decision engine (`src/exports/decision.ts`,
    ≥25 table tests): browser vs. cloud per D34's technical caps (1080p ≤ 20 min on
    every plan; 4K only with `capabilities.isDesktopChromium && fileSink && ≤ 10 min`;
    mobile and alpha/green-screen always cloud), the plan's resolution entitlement
    checked _before_ the path is even chosen (`entitlement/upgrade_required` for a 4K
    request on a 1080p plan), and the watermark decision (D04): Free carries one unless
    the signup gift or an unconsumed ₹9 pass clears it, and only ever on the browser
    path, ≤ 10 minutes. Every branch returns UI-safe `reasons[]` strings for the export
    dialog. Subtitle requests always go to the cloud (`render.subtitle`, 0 credits);
    `ass` is refused everywhere (A18a's parity gate has not landed) and `md`/`docx`
    are plan-gated by `entitlements.subtitleFormats` (`docx` itself is not generated
    anywhere yet and stays refused).
  - **The server alone authors the manifest.** `manifest-builder.ts` snapshots the EDG
    revision, the resolved `style_presets` docs (content-hashed into
    `catalogueSnapshotIds`, `<key>@<sha256 prefix>`), the primary media's storage key,
    a `@montaj/timemap` `fromAcceptedItems` timemap over every pass's accepted `cut`
    items, and the decision's caps/watermark, then hands it to
    `common/crypto/manifest-signer.ts` (the one place `INTERNAL_CALLBACK_SECRET` meets
    `@montaj/render-manifest`) for the canonical-JSON HMAC signature A20 defined.
    Browser mode writes `export_manifests` + an `exports` row (`pending_browser`) and
    returns the signed document; cloud mode (video or subtitle) reserves credits and
    enqueues through the existing `JobsService.enqueue` (0.5 credits/output-minute,
    held on the _source_ duration) with the manifest embedded in the payload.
  - **`POST /exports/manifests/{id}/complete`**: single-use nonce via a conditional
    `UPDATE … WHERE consumed_at IS NULL` (409 `export/manifest_already_consumed` on
    replay, 410 `export/manifest_expired` past `expiresAt`), marks the export
    succeeded, spends the signup gift / ₹9 pass the decision flagged, and writes a
    `publish_events` row. The ₹9 pass is `nine-pass-ledger.ts`, an interface with a
    no-op implementation exactly as CONTRACTS §4 describes `CreditsFacade` — B04 backs
    it with `passes_purchased`.
  - **`RenderVideoCompletionHandler` / `RenderSubtitleCompletionHandler`**
    (`render-completion.handler.ts`) register on `JobCompletionRegistry`: the manifest's
    nonce is claimed as the _first_ write (idempotent on a handler retry after a
    throw), then the `exports` row (video: one, upserted on the manifest's own
    `exportId`; subtitle: one per sidecar) is written from the worker's real result,
    a `publish_events` row follows, and credits settle at the cloud-render rate off the
    _rendered_ `outputMs` — never more than the hold.
  - **Downloads and retention.** `GET /exports/{id}/download` presigns a 5-minute R2
    GET and 409s `export/not_ready` for a browser export, which never uploads
    anything; `purgeExpiredExports()` deletes the R2 object and the row past its
    7-day `expiresAt` (D47) — a method, not a schedule; B16 wires the call.
  - **Brand assets** (`ws/{workspaceId}/brand/{assetId}.png`, CONTRACTS §6):
    `POST/GET/DELETE /workspaces/{id}/brand-assets` for a workspace's own watermark or
    logo, presigned straight to R2. A request's `options.brandAssetId` lets an
    already-unwatermarked (paid) export deliberately overlay one anyway.
  - **The default Free-tier mark is provisioned, not assumed.** Running the real
    `apps/render` worker in `test/exports-render.e2e-spec.ts` proved that A20's own
    `brandAssetKey` resolves _every_ `watermark.assetId` — including the platform's
    own default — per workspace, with no bundled fallback anywhere in the render path;
    a manifest naming it failed `storage/unreadable` before the object existed.
    `default-watermark.service.ts` provisions a small synthesised placeholder PNG
    (`default-watermark.ts`; real artwork is a design asset outside this work
    package) at that key the first time a workspace needs it.
  - **e2e proof, against real infrastructure.** `test/exports-render.e2e-spec.ts`
    builds and spawns `apps/render` (`node dist/index.js`, the same binary a container
    runs) against the shared Redis, uploads a real ffmpeg-generated clip to MinIO,
    requests a cloud export, verifies the signed manifest's signature/caps/watermark,
    waits for the real render, and asserts the `exports` row, the derived object at
    its CONTRACTS §6 key in R2, a signed download URL that actually resolves, and
    `jobs.credits_charged_tenths` settled at the real rendered length.
    `test/exports.e2e-spec.ts` covers the browser path (signup-gift-clean first
    export, watermarked second, nonce reuse, expiry, entitlement and format refusals)
    against a real Postgres and Redis. `common/crypto/manifest-signer.test.ts` proves
    a flipped signature byte, an edited watermark and a manifest signed under a
    different key are all refused.
  - **Deviation, reported per the brief.** The brief's original scope item 4
    (`GET /.well-known/aksharo-manifest-keys.json`, an ES256/JWKS key set) predates
    A20's landed design: `@montaj/render-manifest` signs with a canonical-JSON HMAC
    over `INTERNAL_CALLBACK_SECRET` (with `_NEXT` rotation), not an asymmetric
    keypair. Publishing verification material for an HMAC would let a client forge
    manifests, so this work package does not implement the JWKS endpoint — every
    manifest (browser and cloud alike) is issued and verified through
    `@montaj/render-manifest` as A20 built it instead.
  - New tables: `brand_assets`; `export_manifests.manifest` (the full signed
    document, replacing the pre-A20 `watermark`/`caps`/`codec_ladder`/`signature`
    columns) plus `consumes_signup_gift`/`consumes_nine_pass`; `exports.status`
    (`pending_browser|succeeded|failed`), `workspace_id` and `checksum`;
    `workspaces.signup_gift_consumed_at`.
- **B02 — the credits ledger: lots, atomic reserve, holds/settle/release/reversal,
  grants and expiry, the entitlements engine and the real `CreditsFacade`.**
  - **`LedgerCreditsFacade`** replaces A08's `NoopCreditsFacade` behind `CREDITS_FACADE`
    (CONTRACTS §4), unchanged interface. Every balance move is a single conditional
    `UPDATE credit_accounts SET balance_tenths = balance_tenths ± $amt WHERE … RETURNING`
    plus one `credit_ledger` row in the same transaction (06 invariant 1, D32). Lots
    are consumed soonest-expiring first then FIFO (`apps/api/src/credits/lot-allocation.ts`,
    pure and unit-tested); `settle` is idempotent via a claim-first CAS on
    `credit_holds.status`; over-settlement attempts a delta charge folded into the
    same hold (`credit_holds.job_id` is unique, so a delta is not a second hold row)
    and settles only what is held — `needs_credits` — when it cannot be covered.
  - **Reversal, expiry, monthly reset, reconcile** beyond the frozen interface: `reverse()`
    creates a new lot inheriting the original lot's expiry (split proportionally when a
    hold spanned more than one lot); `expireLots()` sweeps expired lots into an `expire`
    ledger entry; `resetMonthlyGrants()` grants the anniversary allowance, idempotent
    under an at-least-once scheduler; `CreditReconcileService` recomputes Σ lots and Σ
    ledger against the cached balance (detection only).
  - **Entitlements engine.** `EntitlementService.compute()` (A05's stub) now resolves
    the workspace's live subscription plan (an active week pass raises it to at least
    Starter) and merges the plan's seeded entitlement JSON with computed feature
    flags; still a 60 s Redis cache with the existing invalidation hook.
    `@RequiresEntitlement(check)` + `RequiresEntitlementGuard` (new `entitlements`
    module) gate a route on it.
  - **`quote(operation, mediaMinutes)`** in `@montaj/config`'s `credits.ts`: one call
    for a producer's `{holdTenths, costTenths}`, replacing hand-rolled worst-case math.
  - **Usage API**: `GET /workspaces/{id}/credits` (balance, next reset, live lots) and
    `GET /workspaces/{id}/usage` (ledger history, per-job attribution, cursor paging).
  - **Runbooks**: `tools/runbooks/credits-orphaned-holds.js` and `billing-reconcile.js`
    (+ `docs/runbooks/*.md`), driving new `/admin/credits/*` routes.
  - **Concurrency property test** (`test/credits-ledger.property.spec.ts`, fast-check,
    `pnpm --filter @montaj/api test:property`): N=50 concurrent workers, 2,000 random
    `reserve`/`settle`/`release`/`reverse`/`grantLot`/`expireLots` operations against one
    account, asserting `balance = Σ lots = Σ ledger ≥ 0` after every batch.
  - A11/A21/A22 (the intended `quote()` callers) had not landed when this WP was
    written; nothing there to switch over yet.
- **A24b — the pricing page now fetches B01's live `GET /billing/plans`.** Follow-up
  to A24, once B01 shipped the endpoint. `content/site/pricing-live.ts` calls it through
  `@montaj/api-client` (a plain `ApiClient` — the route is public, no session needed),
  with Next.js ISR (`next: { revalidate: 300 }`) rather than a fetch on every request; the
  server component (`pricing/page.tsx`) resolves the catalogue before rendering and hands
  it to the client component as props. `content/site/pricing-data.ts`'s
  `FALLBACK_PLAN_CATALOGUE` is kept as the fallback for when the API is unreachable — never
  throws, logs a warning and serves the static mirror instead, exercised automatically by
  any build that runs without the API up (a bare `pnpm --filter @montaj/web build`).
  `packages/api-client` gained the one missing piece: a `billingEndpoints.listPlans`
  descriptor and a `PlanCatalogueEntry` type (B01 had only regenerated the OpenAPI
  operation index, not this hand-written layer) — outside A24's original file boundary,
  touched here on the coordinator's explicit instruction. A new pricing e2e test fetches
  `GET /billing/plans` from the suite's own API instance and asserts every rendered plan
  card's price equals it exactly.

- **B01 — api: billing core — `BillingProvider` (Razorpay + fake), plan
  catalogue, checkout with the ₹15,000 UPI mandate rule, passes/top-ups,
  idempotent signed webhooks with a subscription state machine, subscription
  management and the renewal/dunning primitives.**
  - **`BillingProvider`** (`billing/provider.ts`): `createCustomer`,
    `createSubscription`, `createOrder`, `registerMandate`, `chargeRenewal`,
    `cancelSubscription`, `refund`, `parseWebhook`, `listPaymentMethods`.
    `FakeProvider` (in-memory, emits signed webhook fixtures) is what every
    test in this work package runs against — there are no live Razorpay keys
    in this environment; `RazorpayProvider` wraps the official `razorpay` SDK
    and its call shapes are read from the SDK's own shipped source. The
    factory (`providers/provider.factory.ts`) picks between them exactly as
    `notify/mail/mail.factory.ts` does for `MAIL_PROVIDER`.
  - **Checkout** (`POST /billing/checkout`): resolves the plan/currency/
    interval price (`money.ts`), computes the mandate cap as the undiscounted
    list price (D40), and refuses a UPI Autopay mandate above ₹15,000 with
    `billing/mandate_cap_exceeded` and actionable `halfyear_upi`/`card_once`/
    `enach` alternatives (D05). Refused with `billing/tax_profile_required`
    until the workspace confirms its billing country (orchestrator addendum
    after A04). `interval: "once"` and a `card` request above the cap both
    create a one-time order with no mandate.
  - **Passes and top-ups** (`POST /billing/passes/checkout`,
    `POST /billing/topups/checkout`): one-time orders that grant credits
    through `CreditsFacade.grantLot` on payment.
  - **Webhooks** (`POST /billing/webhooks/razorpay`, THREAT-MODEL T16):
    signature-verified, idempotent by an event id derived from the payload
    (`billing_events`, new table via migration), amount/currency
    cross-checked against the stored subscription/order and flagged +
    audited on mismatch rather than applied. Drives the `subscriptions.status`
    state machine (`pending → active → past_due → paused/cancelled/expired`
    — `pending` is a new `SubscriptionStatus` value, additive migration),
    invalidates the entitlement cache, writes `audit_log`.
  - **Subscription management**: `GET /billing/subscription`, cancel (at
    period end), resume, pause (once per 12 months), change-plan with a
    proration preview (`GET .../change-preview`) and mandate re-registration
    when the new cap exceeds the current one (D40), mandate list/revoke,
    payment methods.
  - **Renewal and dunning primitives** (`renewal.service.ts`, scheduler
    wiring is B16's): `initiateRenewal` (pre-debit notice via `NotifyService`'s
    `renewal-notice` template, ≥ 24h ahead), `handleDecline` (a
    substring-matched dunning ladder — `dunning.ts` — offering a card/eNACH/
    pay-once fallback per decline-code class), `graceExpiry` (3-day
    entitlement grace, D40 invariant 7).
  - **`CreditsFacade.grantLot`** (`credits/credits.facade.ts`) gained three
    optional fields — `currency`, `amountMinor`, `invoiceId` — signature only;
    `NoopCreditsFacade` (A08's file) is unchanged.
  - Coverage on `apps/api/src/billing/**`: 86% lines / 75% branches (own
    subset), against the CONTRACTS §9 threshold of 75/70.
  - See `apps/api/src/billing/README.md` for the state machine diagram,
    mandate rules as implemented, and open questions (Razorpay behaviours
    that could not be verified without live keys).

- **A24 — the marketing site (`apps/web`'s `(site)` route group): home, features, styles
  gallery, pricing, plugins, download, comparison and legal pages.**
  - **Home.** A hero condensing the eight value propositions to three lines, with an
    English/Hindi headline toggle (a small local ICU-syntax formatter — no `next-intl`
    dependency, see `content/site/hero-copy.ts` for why), and a live browser demo:
    a bundled 15-second Hinglish mock transcript rendered by the real
    `@montaj/render-canvaskit` + `@montaj/render-core` pipeline (no ASR call) with a
    `punch-pop`-first style switcher.
  - **Features.** Every value proposition with its own section; the accuracy section
    carries the target Hinglish/English/alignment numbers from
    `02-product-vision.md §Success metrics` with the measured column left honestly
    blank pending the public eval run (D08).
  - **Styles gallery.** All 30 system styles, hover-to-animate (`StylePreviewCanvas`,
    reused from the editor unmodified), filterable by category and by preview script
    (Roman / Devanagari / Tamil).
  - **Pricing.** The full plan ladder, an INR/USD toggle (always INR by default,
    remembered per visitor), the offers ladder, a credits-to-outcomes table, the burn-rate
    table sourced live from `@montaj/config`'s `BURN_RATES` (never duplicated), the full
    plan comparison matrix transcribed from `04-pricing-and-monetization.md §Plans`, and
    an FAQ answering both Pause's own FAQ questions and the India-payments objections
    (mandates, refunds, GST-inclusive display, the ₹15,000 UPI mandate cap on Studio
    yearly). Prices come from a static mirror of `apps/api/prisma/seed-data.ts`'s
    `PLAN_SEEDS`, not a live `GET /billing/plans` — no billing module exists in
    `apps/api/src` yet (Billing is Wave 2); `content/site/pricing-data.ts` documents the
    swap-to-live-fetch seam.
  - **Plugins.** D65-compliant naming throughout ("Aksharo Panel — works with Adobe
    Premiere Pro and Adobe After Effects", "Aksharo — works with DaVinci Resolve"), the
    three-step activation card, honest capability notes ("waiting on Adobe", "not
    supported by Resolve's API"), and the Adobe/Blackmagic attribution line.
  - **Download.** Platform detection (Windows/macOS/Linux from the user agent),
    SmartScreen/Gatekeeper first-run notes, and the publisher name from `BRAND` — every
    download link is a labelled placeholder pending C10's signed builds.
  - **Comparison pages** (`/vs/kalakar`, `/vs/captik`, `/vs/submagic`, `/vs/autocut`),
    every fact transcribed from `01-competitive-analysis.md` with a dated
    "last verified" line and a source citation (the competitor's own site where the
    research doc gives one; the research doc itself, dated, where it does not — no
    external URL is guessed).
  - **Legal & footer.** Privacy, Terms, AUP, Refunds and DPA scaffolds, each carrying a
    "draft — pending counsel" banner (A00-13 is still `todo`); the privacy page also
    renders the real, already-implemented itemised notice (`apps/api/src/privacy/
privacy-notice.ts`, statically mirrored — see the file for why not a live build-time
    fetch); a Grievance Officer page with the IT Rules response-time targets; the
    Adobe/Blackmagic attribution line in the footer of every page.
  - **SEO/perf.** `sitemap.xml`, `robots.txt`, per-page canonical/OpenGraph metadata,
    build-time-generated OpenGraph images (home, pricing, features, plugins, styles, and
    one per comparison slug).
    `robots.ts` lives at the true `app/` root rather than under `(site)/` — a
    `(site)/robots.ts` built silently to nothing (no `robots.txt` route, confirmed
    against `.next/server/app` and a live 404), unlike `sitemap.ts`, which resolves
    correctly from inside a route group; that one file is the sole exception to this
    WP's `apps/web/app/(site)/**` file boundary.
  - **Tests.** Playwright on chromium and webkit: smoke, axe, a dedicated codename-guard
    spec (extends A13's own `smoke.spec.ts` check to every page this WP adds), SEO
    metadata checks, the pricing currency/interval toggle, the styles gallery filters and
    real-renderer pixel output, the live demo's real-renderer output and its "no ASR
    request fires" assertion, plugin naming compliance, and the legal draft banners.
    Vitest unit tests for the content-data layer (`app/(site)/(marketing)/_test/
site-content.test.ts` — colocated under `app/` because `vitest.config.ts`'s coverage
    scope, set by A13, does not include `content/**` or `app/**`, the same reason its own
    route code is Playwright-covered rather than unit-covered).
  - **Deviations reported in the WP's final message:** no live plan-catalogue endpoint
    exists to fetch from; the task instructions' Hindi-copy request and the brief
    document's own "out of scope: localisation" line disagree, and the instructions were
    followed at the smallest defensible scope; no bundled sample video existed for the
    live demo, so it draws over a placeholder frame; Lighthouse was run manually rather
    than wired into CI (no `@lhci/cli` dependency added without discussion); a manual
    Lighthouse pass found the live demo's CanvasKit bootstrap driving home's performance
    score to 51 (throttled to 15 fps and deferred behind `requestIdleCallback` in
    response — both real fixes, kept — but the score did not recover on this shared
    sandboxed host, where the same page loads and the demo becomes interactive in
    ~1.2 s under a plain automated run; see the final report for the full reasoning).
- **A11c — api: unify A11's and A07's completion-handler registries; bind
  `CAPTION_RENDER_CONTEXT` (D78) to the bundled font pack.**
  - A07 (`media.probe`) independently converged on the same `JobCompletionRegistry`
    design as A11 — same interfaces, same "runs before the status flip" contract,
    same `actualTenths` override. Merging `main` kept A07's `completion-handlers.ts`,
    `jobs.service.ts`, `jobs.module.ts` and `job-events.service.ts` as the one
    registry both `TranscribeCompletionHandler` and `MediaProbeCompletionHandler`
    register against; `JOB_EVENT_NAMES` keeps both producers' domain events
    (`job.completion_handler_failed` from A07, `transcript.postprocessed` from A11)
    under the file's existing `job.*` lifecycle / `<domain>.<verb>` fact convention.
  - **The fit half of D78 is live.** `apps/api/src/edg/init/caption-render-context.ts`
    builds the `CaptionRenderContext` `TranscriptsModule` provides for
    `CAPTION_RENDER_CONTEXT` from `@montaj/fonts/node`'s `loadPack()` (the bundled
    open-licence pack, now that A18b is on `main`) and `@montaj/render-core`'s
    `createHarfBuzzShaper`, built once per process and reused. `resolveBudgets()`
    now measures the real Inter/Noto Sans faces and reports `source: "fit"` rather
    than falling back to the readability cap.

- **A11 — api: transcripts, post-processing, segmentation and the EDG hand-off.**
  - **The worker stays stateless.** `ai.transcribe` completions carry
    `result.chunks` already shaped like `transcript_chunks` (A09's
    `processors/transcribe.py::_result`), and everything that turns them into a
    project happens in one place: `TranscribeCompletionHandler`.
  - **A per-job-type completion handler registry** in `apps/api/src/jobs/completion-handlers.ts`.
    A08 owns the state machine — the conditional `UPDATE`, the settlement, the
    dead letter, the realtime echo — and it is the same for every queue; what a
    completion _means_ is not, so a queue's owner registers a handler at boot and
    `jobs` never learns what a transcript is. Exactly one handler per queue; a
    second is a boot-time error.
  - **The handler runs before the status flip**, so a throw leaves the job
    `running` and the worker's at-least-once retry re-drives it. The alternative
    would make the first transient database error permanent, because the replay
    would be answered `already_completed` before the handler was reached. Every
    write is therefore idempotent: an upsert on the **producer-minted**
    `transcriptId` that travels in the job payload, a delete-and-rewrite of the
    revision's chunks and of the job's provider submissions, and A12's
    `EdgService.initialise`, which is idempotent by project.
  - **One transaction** for `transcripts` + `transcript_chunks` +
    `provider_submissions` + the project's language and scripts. The EDG document
    is deliberately outside it — A12's repository opens its own and Prisma cannot
    nest one — in the safe order: the transcript exists before anything points at
    it, and both halves converge on a retry.
  - **Post-processing (`09 §3`)**, pure and table-tested across Roman Hinglish,
    Devanagari and Tamil: ASR timings rounded to **integer milliseconds** at the
    trust boundary and clamped into their chunk; speaker labels renumbered `s1…`
    by first appearance in the media; **two-signal LID** (D14) combining the
    provider's answer with the script the words are actually written in, so
    Hindi in Roman letters is `hi-Latn` and both signals are stored;
    punctuation from pauses ≥ 600 ms with a danda for Devanagari and capitals
    only where a script has them; Indian numeral grouping (`ek lakh bees hazaar`
    → `1,20,000`, `rupaye pachaas` → `₹50`) that refuses any run which does not
    read as a number; glossary and remembered-spelling correction on a phonetic
    key plus edit distance ≤ 2; and filler tagging from `fillers.json`, where a
    contextual entry such as `toh` is tagged only when a pause brackets it.
  - **The consent gate is the query.** `MemoryGlossarySource` reads
    `memory_entries` only while the memory consent record is granted and
    un-withdrawn and the entry is unexpired — there is no boolean a caller can
    forget to pass. B09 writes those entries; A11 reads them.
  - **Every change is logged.** Each step reports `{step, wordId, before, after,
reason}`; the log is written to `job_events` as `transcript.postprocessed`
    and returned by `GET /projects/{id}/transcript` as `postProcessing`.
  - **Caption budgets (D78).** `maxChars = min(readability cap, fit cap,
workspace preference)`, resolved per script from the project's canvas in
    `src/edg/init/caption-budgets.ts` and recorded on
    `EdgHot.meta.engineVersions.captionBudgets` so A15 can offer "Reflow
    captions". The fit half calls A16d's `fitBudget` for real; it needs a font
    registry and a shaper, which **A18b** registers, so until something binds
    `CAPTION_RENDER_CONTEXT` the budget is the readability cap and says so
    (`source: "readability"`). The call is covered through
    `@montaj/render-core/testing`'s fixture renderer, so binding a registry is
    the only change left. Landscape footage overrides an _untouched_ 9:16
    default; a chosen aspect is never second-guessed.
  - **Endpoints**, all behind `WorkspaceMemberGuard` with roles, and a project in
    another workspace is a 404 (THREAT-MODEL T4, T5):
    `POST /projects/{id}/transcribe` (quotes from the probed duration at 1 credit
    a media minute, reserves, enqueues), `GET /projects/{id}/transcript` (paged
    chunks), `GET /projects/{id}/transcript/export?format=json|srt|vtt|txt`
    (**source time**; output-time exports are A21's), and
    `POST /projects/{id}/transcript/retranscribe`, refused with
    `transcript/has_edits` once the captions have been edited unless `force`.
  - **The `/internal` JSON body limit is 32 MB** (`internal-body-limit.ts`),
    because a 60-minute transcript is megabytes of words — with a test that posts
    one. `/internal` only: that surface needs `INTERNAL_CALLBACK_SECRET`, and
    raising the limit globally would let any anonymous request tie up 32 MB.
  - **Widow rebalancing in `@montaj/edg`'s segmenter.** A forced break must not
    leave one word alone in a caption when the caption before it can give up its
    last word and both halves still fit; a speaker change and a full stop are
    left alone, because a one-word caption after a full stop is the speaker's.
    Goldens regenerated (`pnpm --filter @montaj/edg golden:build`).

- **A18b — `@montaj/fonts`: the bundled open-licence catalogue, upload with licence
  attestation, validation/subsetting/WOFF2, and the `RENDER_FONT_DIR` v1 pack.**
  - **The catalogue.** 21 families (Inter, Montserrat, Poppins, Playfair Display,
    Roboto Mono, Anton, Bricolage Grotesque, JetBrains Mono, plus a Noto Sans per
    script) at 400/700 or the weights the 30 system styles actually name — OFL-1.1
    or Apache-2.0 only, licence text committed beside the bytes in `pack/licences/`,
    every upstream file pinned to one `google/fonts` commit and checked against
    `sources.lock.json`. No system fonts, ever (D33): nothing is fetched at
    runtime. `SCHEDULED_LANGUAGES`/`REQUIRED_SCRIPTS` name the 22 Eighth-Schedule
    languages' scripts plus Latin, and `catalogue.test.ts` checks the shipped
    faces' own character maps cover every one — not a claim in a table.
  - **Validation (T7, `validateFont`).** Cheapest-first refusals, each a `fonts/*`
    code: size, empty, unknown format, unparsable, `.ttc` collections, no outlines,
    `OS/2.fsType` embedding restrictions (checked **before** the licence attestation
    is even recorded — the file itself says the uploader lacks the right the
    attestation would warrant), too many glyphs, a script claim under 90% of its
    required repertoire, no supported script at all, and metrics outside a sane
    `unitsPerEm`.
  - **Subsetting and WOFF2** (`hb-subset` via `subset-font`, both formats from two
    independent runs over the same character set, never by compressing the first
    result). A variable source is **instanced** — every axis pinned before the
    static face is written, so nothing ships variable and the browser and the
    cloud cannot disagree about a default. `subset.test.ts` shapes Devanagari,
    Tamil and Latin samples through the real HarfBuzz shaper on the original and
    the subset face and asserts identical clusters, advances and offsets (glyph
    ids alone differ — `hb-subset` renumbers them).
  - **Upload API**: `POST /workspaces/{id}/fonts/init` (plan limit 0/5/15/50/50,
    presigned PUT, the exact attestation text to show) → `POST /fonts/{id}/complete
{licenceAttested: true, licenceNote?}` (refused without the warranty; records
    `licenceAttestedBy`/`attestedAt`/the attestation text version; validates,
    subsets and writes the WOFF2 inline — CONTRACTS §3's queue list is frozen and
    has none for fonts, so this follows A05's precedent for the same wall) →
    `GET /workspaces/{id}/fonts/{fontId}/url` and `GET /workspaces/{id}/fonts/manifest`
    for signed, workspace-scoped URLs (five minutes; another workspace's font id is
    a 404, T5). `FontsService.purgeWorkspace` deletes every font object a
    workspace owns, for B16's erasure cascade (D70).
  - **Serving**: `GET /fonts/manifest` and `GET /styles/fonts/catalog` (session
    required — product surface) and public, year-cached `GET /fonts/pack/{file}`
    (OFL/Apache bytes, identical for every tenant, so no signature and no tenant
    scope apply).
  - **`FontManifest`** (`fonts.json`, `v: 1`) is a superset of `apps/render`'s own
    `FontPackSchema` — same `{id, family, weight, italic, file, scripts}` in the
    same order, plus `scriptTags` (ISO 15924, the catalogue/coverage truth),
    `woff2`, sizes, `sha256`, licence and provenance. One file, so `apps/render`
    parses a manifest written here without a second schema that can drift.
  - **Loaders**: `@montaj/fonts/node`'s `loadPack()`/`registerManifestFonts()` for
    the cloud (bundled pack off disk, or a fetched manifest's faces into an
    existing `FontRegistry`, warning rather than throwing on one unreachable
    custom font); `@montaj/fonts/browser`'s `loadFontsInBrowser()` (fetch, decode
    WOFF2 with an **injected** decompressor since `woff2-encoder` is ESM-only,
    register the sfnt) and `installCssFontFaces()` for the picker's own-typeface
    preview.
  - **`pack/`** is committed: `fonts.json` plus a `.ttf` and a `.woff2` per face
    and `licences/*.txt`, built by `scripts/build-pack.ts` (`pnpm --filter
@montaj/fonts pack:build`) and reported by the new `pack:report` script.
    `apps/render/src/render/fonts.ts`'s `RENDER_FONT_DIR` reads this exact layout
    (its `FontPackSchema` is the v1 subset of this manifest by design); the render
    image bakes the directory in. `apps/render/src/render/font-pack.test.ts` loads
    the real committed pack and shapes Devanagari, Tamil and Latin samples with the
    fixture-fallback warning asserted **absent**.
  - `apps/render/package.json` gained the `@montaj/fonts` devDependency the new
    test needed; `.gitignore` gained `packages/fonts/.cache/` (the pack build's
    gitignored download cache).
  - Coverage (CONTRACTS §9, `packages/fonts` = 90/85): 97.3% lines, 85.6% branches,
    150 tests across 8 files, plus a Playwright suite that fetches the pack's own
    WOFF2 files over a static server, decompresses and draws a Latin, a Devanagari
    and a Tamil caption in Chromium.

- **A13 — web app shell: auth screens, onboarding step 0, settings, `@montaj/ui` and the typed client layer.**
  - `@montaj/ui`: the design system of `03-architecture/08-ux-design-system.md`
    §1–§2. `src/styles/tokens.css` _is_ the Tailwind v4 preset — the near-black
    and lime palette, the signal colours, 8/12/16 radii, the type scale, the
    120–200 ms motion band, one lime focus ring and a `prefers-reduced-motion`
    rule that applies to chrome only, because caption animation is the product's
    output rather than decoration. `src/tokens.ts` carries the same values as
    data and a test fails if the two drift. shadcn/ui primitives over Radix
    (Button, Input, Field, Dialog, Sheet, Tabs, Tooltip, DropdownMenu, Toast,
    Command palette, Switch, Checkbox, Separator, Card, Badge, Skeleton,
    ProgressBar) plus the product components: `CreditMeter` (credits, minutes,
    reset date, burn-rate tooltip with runway, streak badge behind a flag),
    `JobProgress` (stage chips and ETA), `UpgradeGate` (the exact plan and a
    checkout-sheet slot), `StatusChip`, `LangChip`, `ShortcutHint`,
    `EmptyState`. The nine Indic Noto families load on demand — `loadIndicFont`
    inserts one the first time that script is rendered, rather than putting
    ~1.5 MB of webfont in front of a first paint nobody needs it for.
  - The package is consumed as **source** through Next's `transpilePackages`, so
    the app's own compiler handles the `"use client"` boundaries and there is no
    build artefact to keep in step.
  - `@montaj/api-client`: the fetch layer and hooks on top of A04's generated
    operation index. Typed endpoint descriptors checked against that index by
    `contract.test.ts`, which fails both ways — a route that moved, and a route
    marked `pending` that has since landed. A13 was written against a `pending`
    stub for the whole A05 surface (`/me`, `/workspaces`, `/entitlement`,
    `/usage`, `/consents`, `/memory`); A05 merged first, so `accountEndpoints`
    (`/me`, `/workspaces`, `/workspaces/{id}/entitlement`, `/consents`) call the
    real routes and `useCurrentUser`/`useWorkspaces`/`useEntitlement`/
    `useConsents` no longer need a fallback. `/usage` (the credit ledger, B02)
    and `/memory` (D62, B09) are still declared `pending` and raise
    `client/not_implemented` without a request, so the shell renders honestly
    for the weeks before those two work packages land instead of showing an
    error state everyone learns to ignore.
  - The client owns the bearer header, the CONTRACTS §8 envelope and one
    single-flight refresh: ten parallel 401s cause one rotation. A 401 on a
    **public** route is a domain answer, not an expired session — refreshing
    there signed the user out of a session they were in the middle of creating,
    which is the bug the login e2e caught.
  - `RealtimeClient` for CONTRACTS §7: subprotocol `aksharo.v1` plus
    `bearer.<token>` (never a query string, T21), backoff with jitter capped at
    30 s, re-subscribe after every `welcome`, `onResync` so a client that was
    offline converges by re-reading rather than replaying, refused rooms
    remembered, and 4401/4403/4503 handled distinctly.
  - The package is ESM-only. A CommonJS build resolves `@tanstack/react-query`
    through the `require` condition while the app resolves it through `import`,
    which makes two `QueryClient` contexts and an error that points nowhere near
    its cause.
  - `apps/web`: the shell of 08 §3 — sidebar with the full information
    architecture (items whose routes have not been built are disabled with a
    "Soon" chip rather than shipped as dead links), workspace switcher over
    `POST /auth/token/exchange`, credit meter, desktop download, profile menu,
    top bar with Ctrl+K, New project, What's new and Upgrade, a drawer at phone
    width, a skip link and a focusable `main`.
  - Auth screens: `/signup` (credentials, then onboarding **step 0** — date of
    birth, jurisdiction and two consent switches that both start off), `/login`,
    `/magic`, `/verify`, `/auth/callback` (Google `status=registration` asks
    step 0 before the account exists), `/auth/desktop-landing`, `/device`.
    `/auth/verify-email` and `/auth/magic-link` forward to the first two,
    because that is where A04's emails point.
  - Sign-up copy never distinguishes a new address from a taken one, because the
    API deliberately answers 202 either way; an e2e test compares the two
    responses character for character.
  - D60 throughout: the browser checks the same age floors the API enforces so a
    15-year-old gets an explanation instead of a red error after typing a
    password; a blocked sign-up is offered the parental waiting list; a declared
    minor never gets analytics whatever the toggle says.
  - Settings: profile, languages and defaults, "What Aksharo learned" (disabled
    until the memory consent exists, D62), devices and sessions (revoke a family
    from a list with the current one marked), privacy (consents, data export,
    deletion behind a typed confirmation), notifications — a placeholder that
    says why there is nothing to choose yet rather than offering switches that
    do nothing.
  - Sessions: the refresh token lives in an httpOnly SameSite=Lax cookie only
    `app/api/session/*` can read, and the access token lives in memory for its
    15 minutes (T2). Both handlers refuse a cross-site request, because a route
    that writes a session cookie is a session-fixation primitive otherwise.
    `middleware.ts` keeps signed-out visitors out of the studio before any HTML
    is sent — a routing decision; the shell still rotates on mount, because a
    cookie is not proof the family is alive.
  - Analytics loads **after** consent and not before: `posthog-js` is a dynamic
    import, so before consent it is not in the page and there is no request to
    any analytics host. Sentry runs through a scrubber that replaces addresses,
    JWTs, bearer headers and signed URL parameters, with tracing and replay off.
  - `/(admin)/ui-kit` renders every component state; Playwright screenshots it
    and the auth, shell, onboarding and settings screens into
    `apps/web/e2e/__screenshots__/` and runs axe over each one.
  - Tests: 82 component tests in `@montaj/ui`, 78 in `@montaj/api-client`, 115
    in `apps/web`, and a Playwright suite on chromium and webkit covering sign-up
    → onboarding → shell, the enumeration-safe 202, the age gate and the
    waiting list, sign-in and sign-out, magic links, device-code approval and
    refusal, consent persistence, "no analytics before consent", and an axe pass
    on every screen.
  - Two things A13 changed for everyone else: `/studio/*` is now behind a
    session, so A16's `/studio/styles` harness signs in before it navigates;
    and the end-to-end suite takes one confirmed account per Playwright worker
    rather than one per test, because A04's development outbox is a 50-entry
    Redis list every work package's local API shares and eighteen sign-ups in
    one run lose their own message.
  - The realtime channel found a live defect on the way in: joining a room took
    the API process down, because `RedisRealtimeBus` duplicated a connection
    created with `lazyConnect: true` and `enableOfflineQueue: false`, so the
    duplicate was never dialled and the first `SUBSCRIBE` was rejected outright.
    A08c has since fixed it (A12 reported the same thing independently), so the
    shell connects by default; `FEATURE_FLAGS_JSON={"realtime.enabled":false}`
    remains as a kill switch.
  - `onboardingSchema` rejected the multi-select answers this screen collects
    (found during this verification: `apps/api/src/users/users.dto.ts` accepted
    only `boolean | number | string` per `onboarding` value, so `PATCH /me`
    answered `400 common/validation_failed` on `onboarding.makes`/`.languages`
    every time — outside `apps/web/**`, so reported rather than fixed here). A05b
    has since fixed it: the schema gained the missing array branch, and
    `e2e/auth.spec.ts`'s journey test is back to its original "lands in the
    shell" assertions.
- **A10c — the model-server alignment rung, and the stale-reference sweep after A26.**
  - `worker_ai/alignment/gpu.py`: `GpuCtcAligner`, `POST /align` on
    `apps/model-server`. It sits at rank 35 — **below** the two local CTC rungs,
    which cost only the CPU pod they already run in, and **above** the paid
    ElevenLabs one. The `ai.*` pool is the CPU pool and carries no weights, so on
    a normal deployment this is the rung that actually runs: the chain becomes
    model server, then paid, then proportional.
  - Three facts from A26's response shape the adapter, and each is pinned by a
    test: words come back in **file time** (the server adds `startS` itself, so
    only the caller's `offset_ms` is applied); there is always **one word per
    input word**, a word outside the checkpoint's vocabulary getting
    `probability: 0.0` and a mention in `skipped[]` rather than being dropped;
    and `licence` is per checkpoint, so which family answered is recorded.
  - `fixtures/vendor/gpu-whisper/session.json` gained a **real** `/align`
    response, produced by driving `apps/model-server`'s own test client rather
    than hand-written from prose. A26's `tests/test_contract_fixtures.py` reads
    the same file from the other side, so neither app can change the shape
    without the other's tests failing. `fixtures/vendor/gpu-align-skipped/`
    records the degraded case.
  - **`apps/worker-ai/Dockerfile.gpu` is deleted.** It described the GPU image
    before that image existed; `apps/model-server/Dockerfile` is the real one, and
    two files describing one image is how they drift. The README's GPU section now
    names `apps/model-server` and tables the four routes this worker calls with
    their clients, and `alignment/xlsr.py` cites
    `apps/model-server/scripts/bake_models.py --aligner-global` instead of X05's
    removed `infra/gpu/runpod/bake_models.py`.

- **A26 — model-server: the GPU model server (`apps/model-server`), serving
  `/transcribe`, `/align`, `/diarise` and `/detect-language` for the serverless
  GPU lane (D15), with dynamic batching, warm-model lifecycle, a memory guard,
  cost accounting, and RunPod/Modal packaging.**
  - **The wire contract is the worker's, not this app's.** `apps/worker-ai`
    already had three clients written against a server that did not exist
    (`providers/serverless_whisper.py`, `diarisation/pyannote.py`, `lid.py`), and
    A10 recorded their exchanges in
    `worker_ai/fixtures/vendor/gpu-whisper/session.json`.
    `tests/test_contract_fixtures.py` asserts every live response is a **superset
    with matching types** of that recording, and `tests/test_worker_adapter.py`
    drives the worker's own three clients over a real socket against a real
    uvicorn — the only test that fails when the two apps disagree. Times on the
    wire stay **seconds** everywhere except `/detect-language`'s `windows`, which
    is milliseconds because `lid.py` already sends it that way.
  - **Dynamic batching for `/transcribe`** (`model_server/batching.py`): up to
    `MODEL_SERVER_BATCH_MAX_SIZE` chunks inside a 50 ms window, handed to the ASR
    backend as one call. Decision **D74** makes this load-bearing rather than an
    optimisation — X05's re-derivation gives ₹0.19 per media minute without
    batching against the ₹0.09–0.13 band in `05 §12` — so
    `model_server_batch_size` measures what actually happened and
    `usage.gpuSeconds` is the group's wall clock **divided by `batchSize`**, with
    `batchSize` on the wire so the division can be audited. Charging each request
    the whole group would inflate COGS per credit by exactly the batching factor.
  - **Models load once, at startup, from the baked image.** No request ever
    triggers a load. `MODEL_SERVER_PRELOAD` selects which backends are
    instantiated at all, so a CPU worker that only transcribes never pages
    pyannote into memory. A backend that fails to load does **not** take the
    process down: it is recorded, `model_server_model_ready` stays at 0, its
    routes answer 503 with the reason, and the others keep serving — on a
    serverless worker a hard exit is a crash loop that still bills. SIGTERM flips
    readiness **before** uvicorn winds down, so a load balancer stops sending work
    to a worker that is about to stop.
  - **A memory guard, not a CUDA OOM.** A request reserves an estimate before the
    model call and is refused with `503` + `Retry-After` when it does not fit; the
    worker's HTTP client already retries 5xx and already obeys the header, so a
    refusal costs a wait rather than a job.
  - **Decision D77 is enforced, not merely documented.** IndicWav2Vec (MIT) for
    Indic languages and XLSR-53 CTC fine-tunes (Apache-2.0) for global ones;
    **MMS never** — `scripts/bake_models.py` fails the image build if any
    argument names an MMS checkpoint, so the CC-BY-NC-4.0 problem cannot be
    reintroduced by a `--build-arg`. pyannote community-1's CC-BY-4.0 attribution
    is surfaced in `engineVersions` on every diarised response, byte-identical to
    the worker's constant, with a test that asserts they match.
  - **Script projection stays in the caller.** `/align` tokenises the words it is
    given against the checkpoint's vocabulary and reports what it could not
    represent in `skipped`; the Devanagari projection for Roman-script Hinglish
    (`09 §2`) lives in `worker_ai/alignment/romanisation.py` with IndicXlit
    behind it as A22's work, and a second, disagreeing table here would be worse
    than none.
  - **Auth is a boot condition.** `GPU_PROVIDER_TOKEN` is compared in constant
    time on all four routes, ahead of body validation so a 401 never reveals which
    fields were wrong; with the token empty the process **refuses to start**
    unless `MODEL_SERVER_ALLOW_ANONYMOUS=1` says a human meant it. `/healthz`,
    `/readyz` and `/metrics` are unauthenticated and carry no user data. Logs are
    JSON with a redaction chokepoint: no audio, no transcript text, no credential,
    and presigned URLs reduced to scheme, host and path (THREAT-MODEL T21).
  - **Packaging** replaces X05's placeholders, which pointed at
    `apps/worker-ai/requirements-gpu.lock` and a `montaj_worker_ai.gpu` package
    that never existed. `apps/model-server/Dockerfile` is multi-stage: a `cpu`
    target CI builds and boots with no GPU, no weights and no Hugging Face token,
    and a CUDA `runtime` target that bakes every weight and runs offline.
    `scripts/bake_models.py` is the single bake step both providers run and also
    exports the CTC heads to ONNX in the layout `worker_ai/alignment/ctc.py`
    reads. `model_server/runpod_handler.py` serves RunPod's queue API from the
    **same** app, batcher and warm models. `infra/gpu/runpod/endpoint.json` and
    `infra/gpu/COST.md` are X05's and stay; `infra/gpu/runpod/Dockerfile` and
    `infra/gpu/runpod/bake_models.py` are deleted rather than left as a second,
    wrong source of truth.
  - **Cost accounting** (`apps/model-server/cost.md`): `usage {gpuSeconds,
audioSeconds, model, batchSize}` on every response, the arithmetic behind it,
    the measured CPU-`tiny` numbers, and the empty table the first real GPU run
    fills in. The honest CPU finding, carried up into `infra/gpu/COST.md`: **on
    CPU, batching costs rather than saves** (batched RTF 1.4–1.8 against
    serial 0.95–1.6), because CTranslate2 already uses every core. That says
    nothing about a GPU, where a single stream leaves the card idle — but it
    does mean the CPU lane should run `MODEL_SERVER_BATCH_MAX_SIZE=1`.
  - **Metrics** `model_server_*` registered in `infra/observability/METRICS.md`
    §11 **before** the code, per D75. They are the only names in that file
    without the `montaj.` prefix, because a RunPod or Modal sandbox has no OTel
    collector beside it and this process is scraped directly in native Prometheus
    form.
  - 199 tests, `ruff`, `ruff format --check` and `mypy --strict` clean;
    coverage **95.3 % lines / 88.4 % branches** against the CONTRACTS §9 gate
    of 75/70, checked by `scripts/coverage_gate.py` because `--cov-fail-under`
    blends the two into one number that can pass while the contract fails.
- **A20b — the rasteriser moves to worker threads, and `pnpm format:changed`.**
  - Skia now runs on `min(cores − 1, 4)` worker threads
    (`apps/render/src/render/pool.ts`), so it overlaps with ffmpeg instead of taking
    turns with it: **1080p goes from 1.13× to 2.31× realtime**, and the whole render
    (12.97 s for 30 s of output) now costs about what the encoder alone costs (13.22 s),
    which is the ceiling this architecture has. 540p is 4.87×, 4K 0.45×.
  - Frames never cross the thread boundary: each slot is a `SharedArrayBuffer` the main
    thread allocates once and a worker draws into in place (`FrameOptions.into` on
    `@montaj/render-skia-node`'s batch). Only the finished `DrawCommand[]` is sent, about
    12 KB. Memory is `slots × width × height × 4` with `slots = workers × 2` — 66 MB at
    1080p, 265 MB at 4K — whatever the length of the video.
  - Layout, the frame-diff hash and the cache decision stay on the main thread, so the
    cache is exactly as exact as it was single-threaded and two thirds of a render never
    reach a worker. A slot is released only when `stream.write`'s completion callback
    fires, reference-counted per frame, which is what stops a slot being redrawn
    underneath a caption still queued in the pipe.
  - `src/render/pool.test.ts` renders every frame both ways and asserts the bytes are
    **identical** — which is how a missing watermark was caught: each worker has its own
    Skia and its own image table, and nothing had put the mark in it. The nineteen-frame
    parity table is unchanged to four decimal places.
  - `RENDER_RASTER_WORKERS` sizes the pool; `0`, a machine without worker threads, or an
    image missing `workers/raster-worker.mjs` all fall back to rasterising inline, with a
    warning and the same pixels.
  - **`pnpm format:changed`** (and `format:changed:check`) runs Prettier over what the
    branch actually changed — the merge base with `main`, plus the working tree — instead
    of the whole repository. Every work package so far has had to hand-revert a
    `pnpm format` run over files it never touched; the root `README.md` now says to use
    this one.

- **A06 — api: projects, folders, media ingest, derived URLs, subtitle import and
  retention.**
  - `apps/api/src/common/storage/`: an `ObjectStore` port with two instances —
    `RAW_STORE` (`S3_BUCKET_RAW`, AWS S3 `ap-south-1` in production) and
    `DERIVED_STORE` (`R2_BUCKET_DERIVED`, Cloudflare R2), both MinIO locally.
    Presigned multipart PUT, presigned GET with a five-minute TTL, HEAD, delete
    and object tagging over the AWS SDK v3. `storage.keys.ts` is the TypeScript
    twin of `apps/worker-ai/worker_ai/storage.py` and refuses to build a
    CONTRACTS section 6 key from anything that is not a ULID (THREAT-MODEL T5).
  - **The bytes never pass through the API.** `POST /projects/{id}/media/init`
    checks the plan cap and returns one presigned URL per 16 MiB part;
    `POST /media/{mediaId}/complete` closes the multipart upload, records the
    store's own byte count, sets `raw_purge_at` (upload + 7 days) and
    `derived_purge_at` (the plan's retention), and enqueues `media.probe` then
    `media.proxy`. Both are deduplicated on `jobKey`, so a retried completion
    returns the same two job ids rather than four jobs.
  - `POST /projects/{id}/media/{mediaId}/replace` puts new bytes on the **same**
    media row — transcripts, the EDG document and exports all reference that id —
    clears everything that described the old bytes and sets `needs_realign`.
  - `GET /projects/{id}/media/{mediaId}/urls` signs only the derived artefacts
    that exist, so the response doubles as "what is ready".
  - `POST /projects/{id}/import` and `/import-url` parse SRT, WebVTT, ASS and
    plain text into one normalised cue list (BOM and CRLF handled, ASS override
    tags stripped, Devanagari untouched), store it as a JSON sidecar under the
    media prefix as a `media_assets` row with role `subtitle`, and enqueue
    `ai.align`. Plain text is marked untimed, which is the signal alignment needs.
  - `apps/api/src/common/net/safe-fetch.ts`: the egress-restricted client of
    THREAT-MODEL **T6** — http(s) on ports 80/443 only, every resolved address
    judged against a deny list (RFC1918, loopback, link-local including
    `169.254.169.254`, CGNAT, IPv6 ULA, multicast, IPv4-mapped and NAT64), the
    vetted address **pinned** for the connection, three redirects, 2 MB and ten
    seconds. A refusal reaches the caller as `import/blocked_url` with no detail.
  - `RetentionService.purgeDueMedia()` (D47): two independent clocks, raw at seven
    days and derived at the plan's retention. The object is deleted before the row
    is marked, so a crash leaves a retryable sweep rather than stranded storage.
    It registers no schedule — B16 owns that wiring.
  - `POST /projects/batch` creates up to 50 projects in one transaction; folders
    are a real table with cycle and depth checks and an "empty before delete" rule.
  - Every `/projects`, `/folders` and `/media` route wears `JwtAuthGuard`,
    `WorkspaceMemberGuard` and `RolesGuard`. Another tenant's id is a **404**, never
    a 403 (T5).
  - Media types are an allow-list (T7): `application/octet-stream` is accepted only
    when the filename's extension is one we know, and the extension that reaches a
    key is chosen from the same lists, never from the filename directly.

- **A07 — worker-media: probe, 16 kHz + 48 kHz audio, 540p proxy, waveform,
  thumbnails.**
  - `apps/worker-media`: a BullMQ worker consuming `media.probe` and
    `media.proxy` (CONTRACTS §3) with concurrency and queue selection from
    `WORKER_MEDIA_*` env, a ten-minute lock with a heartbeat at a third of it
    (`src/policies.ts`, kept in step with `apps/api/src/jobs/jobs.config.ts` by
    a source-parsing drift guard, same as the Python worker's), graceful
    shutdown that aborts every ffmpeg child before closing the workers, and
    structured logs with `jobId` on every line. Refuses to start when
    ffmpeg/ffprobe are missing or older than major 6
    (`assertMediaToolsAvailable`) rather than silently producing flat HDR
    proxies and no progress.
  - **The source is never downloaded.** ffprobe and ffmpeg read the raw object
    through a presigned GET URL; the only files on disk are the outputs
    `+faststart` and a patched WAV header need a seekable destination for, in a
    scratch directory `withWorkspace` deletes in a `finally`.
  - **`media.probe`**: `ffprobe` for duration, fps, dimensions, rotation
    (display-matrix side data, not just the `rotate` tag), codec, audio
    channels/sample rate and HDR (`smpte2084`/`arib-std-b67` transfer curves);
    one audio-only `ebur128`+`silencedetect` decode for loudness range, true
    peak and silence ratio/spans, never fatal to the probe itself. Writes the
    measured facts through `PATCH /internal/media/{id}` and reports the full
    result on `POST /internal/jobs/{id}/complete`; the plan's duration cap and
    whether a proxy gets built at all are the API's decision, not the worker's.
  - **`media.proxy`**: `audio16k.wav` (mono PCM s16le, for ASR/alignment),
    `audio48k.wav` (mono PCM s16le, `09 §5` mastering), `waveform.json` (peaks
    at 100/s and RMS at 10/s, both 0–1 of full scale, streamed off the 16 kHz
    WAV in 64 KiB chunks so a sixty-minute file never sits in memory),
    `proxy540.mp4` (H.264 main profile, short side 540 computed in TypeScript
    and never upscaled, CRF 28, faststart, AAC 96k) and ten `thumb-{n}.jpg`
    filmstrip frames (320px wide, midpoints of even slices, input-seek so a
    sixty-minute source costs one range request per frame instead of a decode
    from zero). Audio-only inputs skip the video half entirely; a silent video
    skips the audio half. HDR sources are tone-mapped to BT.709
    (`zscale` → `tonemap=hable` → `zscale`) ahead of the scale filter, with a
    same-job fallback to a flat SDR encode when this ffmpeg has no `libzimg`.
    CONTRACTS §6 names no poster key, so `thumb-0.jpg` is the poster and an
    audio-only asset simply has an empty `thumbKeys`.
  - **A06's upload path changes here**: `POST /media/{id}/complete` now
    enqueues only `media.probe`.
    `apps/api/src/media/probe.handler.ts` (`MediaProbeCompletionHandler`) is
    the probe's completion handler and enqueues `media.proxy` as a **child
    job** via `JobsService.enqueueChild({ skipAdmission: true })` — the proxy
    is the second half of one piece of work the workspace was already admitted
    for at upload, and enqueuing it from `complete` used to cost two admission
    slots for one file, 429ing a Free workspace on its second concurrent
    upload. `skipAdmission` is unreachable from a worker (THREAT-MODEL T23): it
    keeps the plan's priority and queue-wait budget but checks neither cap, and
    only `MediaProbeCompletionHandler` ever sets it. `probeJobId`/`proxyJobId`
    stay in the `complete` response for compatibility; `proxyJobId` is now
    always `null`.
  - `apps/api/src/jobs/completion-handlers.ts` (`JobCompletionRegistry`): one
    completion handler per queue, registered by the feature module that owns
    it rather than a `switch` inside `JobsService`. Runs **before** the
    conditional status-flip `UPDATE`, so a handler that throws leaves the job
    `running` and the callback answers 5xx for the worker to retry — flipping
    first would make the first transient failure permanent, since a replay
    would find a terminal job and never reach the handler again.
  - `apps/api/src/internal/internal-media.controller.ts`: `PATCH
/internal/media/{id}`'s allow-list gained `codec`, `hasAudio`, `hdr`,
    `failureReason` (a closed `media/*` set — `MEDIA_FAILURE_REASONS` in
    `apps/api/src/media/media.constants.ts` — since it is rendered to the
    user) and `thumbKeys`, plus `assertOwnKeys()`: every derived key in a
    patch must resolve, after rejecting `..`, under the asset's own
    `ws/{ws}/p/{project}/media/{media}` prefix rebuilt from the row — never
    from anything in the request body — so a worker with a stolen callback
    secret can write nonsense about its own asset but cannot repoint
    `proxyKey` at another tenant's object (THREAT-MODEL T5).
  - `media_assets` gained `codec`, `has_audio`, `hdr` and `failure_reason`
    (all nullable with no default — `NULL` means "not probed yet", a different
    statement from `false`).
  - `apps/api/src/jobs/jobs.config.ts` and the Python `worker_ai/policies.py`
    both give `media.probe`/`media.proxy` a 600 000 ms lock: the family
    default of two minutes was sized for "ffprobe a short clip", and would
    declare a 4K sixty-minute proxy encode stalled and hand it to a second
    worker while the first is still writing the same derived keys.
  - Tests: unit coverage for every module above; `processors.test.ts` runs
    both processors against real ffmpeg (fixtures generated with
    `testsrc`/`sine` at test time, never committed) with the object store
    faked; `apps/api/test/media-pipeline.e2e-spec.ts` uploads a synthetic clip
    through A06's presigned flow to MinIO, spawns the built worker as a
    process against the shared Redis, and asserts every CONTRACTS §6 object
    exists, that the row was updated through the allow-listed patch, and that
    the proxy ran as a child job — plus the audio-only, HDR and corrupt-input
    paths.
  - `apps/worker-media/Dockerfile`: a `turbo prune`-based multi-stage build
    (Debian trixie, ffmpeg from the distro archive) so a media pod carries
    ffmpeg and this package's compiled output and nothing else.

- **A20 — the cloud render service: `apps/render`, `@montaj/render-skia-node`,
  `@montaj/render-manifest`.**
  - `@montaj/render-skia-node` is implemented: the same `DrawCommand[]` the browser
    executes, run against Skia's native build (`@napi-rs/canvas` 1.0.8, pinned), with
    `outlineTextCommands` converting every glyph run to a path because Canvas2D has no
    glyph-id entry point. No system font is ever consulted (D33). Frames come out as
    straight RGBA through a reusable batch buffer — a 1080×1920 frame is 8.3 MB and a
    ninety-second Reel is 2,700 of them.
  - **Parity against CanvasKit is measured, not asserted.** Nineteen frames — A16's
    seven baselines plus the four caption fixtures at three instants — of which sixteen
    are inside decision D33's SLO (≤ 1% of pixels off by more than 2/255) and the mean
    is 0.83%. Everything except text is bit-exact; the residual is Skia's glyph cache
    against an analytic path fill, and it grows as the type gets smaller.
    `neon-glow-english` (3.31%) and the two entry-instant frames (1.10% and 1.20%) are
    over, pinned with their measured values and their reason. Four conversions with a
    unit in them — blur sigma, shadow sigma, the miter limit and layer opacity — are
    asserted on their own so a regression names the conversion rather than a whole
    frame.
  - `@montaj/render-manifest` defines the server-signed `RenderManifest` of `05 §5.2`:
    project and EDG revision, style-catalogue snapshot ids, timemap edits, aspect,
    resolution and fps, the watermark decision, the plan's caps, the audio strategy and
    the subtitle request. Signed with `INTERNAL_CALLBACK_SECRET` over canonical JSON
    under a domain-separation prefix, verified against `INTERNAL_CALLBACK_SECRET_NEXT`
    too, so one rotation procedure covers manifests and callbacks and no new secret was
    added. Five refusals with stable codes: malformed, bad signature, expired, not yet
    valid, caps exceeded.
  - `apps/render` consumes `render.video` and `render.subtitle`. A render verifies the
    manifest, builds the timemap (D30), and checks the caps against the _rendered_
    length — all **before a byte of media moves** — then downloads the source, probes
    it, draws frames on Skia and pipes them into ffmpeg as a second `rawvideo` input.
    Cuts become `trim`/`concat` per retained span so video and audio are cut at the same
    instants; the base is forced to the output frame rate immediately before `overlay`
    so the two streams stay frame-aligned; presets get a centre cover `scale`/`crop`.
    x264 `veryfast` at CRF 20 (1080p) / 18 (4K) with `+faststart`, or ProRes 4444 /
    VP9-alpha for an alpha export and a solid chroma ground for green-screen. Output to
    R2 under CONTRACTS §6, with `usage.outputSeconds` and `egressBytes: 0` (D35).
  - **The watermark decision is the server's** (THREAT-MODEL T10): it travels inside the
    signature, is drawn from the manifest rather than the projection, and stripping it
    from a signed document is a `manifest/bad-signature` refusal — tested with that
    exact attack.
  - A frame cache keyed on `hashCommands` reuses the previous frame's pixels whenever
    the command list is unchanged: two thirds of the frames of the sample project at
    1080p, four fifths at 4K. It is exact rather than heuristic, because outlining is a
    pure function of the hashed list.
  - `render.subtitle` writes SRT, VTT, TXT and Markdown, one file per (format × script),
    with every cue remapped onto the output clock and a segment straddling a splice
    split into two cues. ASS is refused with a message naming A18a.
  - The signed callback client is a TypeScript mirror of
    `apps/worker-ai/worker_ai/callbacks.py`, down to the header names and the rule that
    the bytes signed are the bytes sent; the A08b retry, stall and heartbeat table is
    mirrored with a test that parses the API's own source to prove it has not drifted.
  - `BENCHMARK.md` reports measured throughput: **1.05× realtime at 1080p**, 3.85× at
    540p, 0.30× at 4K, on a 12-thread desktop. The ≥ 2× target is not met; the file
    contains the stage split showing that Skia and x264 do not overlap because
    rasterising blocks Node's only thread, the two optimisations tried (bounded layer
    surfaces, landed, 0.69× → ~1.1×; a pipe run-ahead buffer, reverted, slower), and the
    worker-thread change that would close the gap.

- **A10b — Meta MMS excluded on licence grounds (D77); tests no longer read a
  developer's `.env`.**
  - `worker_ai/alignment/mms.py` is **deleted**. The common
    `facebook/mms-300m-1130-forced-aligner` export is CC-BY-NC-4.0, which is
    non-commercial. Rung 3 of the `09 §2` chain is now split by language family:
    `IndicWav2VecAligner` (AI4Bharat, **MIT**) for the eleven Indic languages,
    and the new `worker_ai/alignment/xlsr.py` — `jonatasgrosman/wav2vec2-large-xlsr-53-*`
    per-language CTC fine-tunes, **Apache-2.0**, which is what the GPU model
    server already bakes in — for the global ones.
  - `mms` joins `bhashini` in `routing.NEVER_ROUTE`, and the check now covers all
    three places it could come back: a lane in `routing.yaml`, an admin routing
    override, and the aligner registry itself. Each raises at load time. A licence
    exclusion an operator can switch back on is not an exclusion.
  - Each XLSR-53 fine-tune carries its own vocabulary in its own script, so
    nothing is romanised any more; `alignment/romanisation.py` keeps the
    Roman-to-Devanagari projection the Indic heads need and drops the reverse
    table that only MMS used.
  - **Tests no longer depend on the machine's `.env`.** The eval CLI's `--live`
    path calls `load_settings()` against the _process_ environment, so
    `test_live_asks_the_registry_rather_than_the_fixtures` failed on a fresh
    clone with "REDIS_URL is missing" instead of the live-path error it asserts —
    and would have passed for the wrong reason on a machine holding a Sarvam key.
    A `contract_env` fixture now pins the required variables and blanks every
    optional credential. The whole suite was run with `.env` renamed away to
    prove it: 506 passed, 13 skipped, no other test had the same dependency.

- **A12 — api: the EDG module (hot document, `/edg/ops` with server-side rebase
  and compare-and-swap, revisions, snapshots and restore, realtime `edg.ops`).**
  - `apps/api/src/edg/edg.repository.ts`: A02b's `EdgRepository` over Prisma. One
    batch is one transaction — `SELECT … FOR UPDATE` on the document row,
    `rebaseOps` against the ops since the client's base, `applyOps` on a partial
    state, row-level writes, then
    `UPDATE edg_documents SET revision = revision + 1 … WHERE revision = $observed
RETURNING revision`. The lock makes read-decide-write atomic; the CAS is the
    same invariant written into the statement rather than into a convention, so
    `edg_documents.revision` rises by exactly one per accepted batch (06
    invariant 3) even if a later caller forgets the lock.
  - **The working set** (`edg.working-set.ts`). A batch reads the rows its ops
    name plus exactly the neighbours `@montaj/edg/ops` reaches for — the segment
    after the last one addressed (a split mints a `seq` between them), everything
    between the addressed ones (a merge checks contiguity), the segments a deleted
    word bounds, and one transcript chunk either side of each one named. Most
    edits read no words at all: setting text, style, position or `hidden` never
    asks the engine about a word. Measured on the compose Postgres, a single-op
    batch is **median 33 ms, p95 67 ms on a 9,000-segment document** — no slower
    than on a twelve-segment one, which is the claim the design makes.
    `Resegment` is the one op with no bounded form and says so rather than
    guessing.
  - **Rebase, or 409.** A client that is behind is rebased server-side and
    applied (`OpBatchResponse.rebased`). Two things the server may not decide for
    the user come back as `409`: a `conflict` verdict — two writers typing
    different text into the same caption or correcting the same word — carrying
    `{latestRevision, opsSince, conflicts}` with **both texts** and never the
    document (D29); and `edg/too_stale` past 200 revisions or across a state
    replacement.
  - **Word edits touch one row.** `EditWord`, `DeleteWord` and `InsertWordAfter`
    patch only the `transcript_chunks` row the word lives in, raise its
    `next_word_seq` (ids are never reused, 06 invariant 4), and move
    `transcripts.current_revision` only when a word actually changed.
  - **Snapshots** every 100 revisions (`SNAPSHOT_EVERY`, D28) plus one at
    creation, stored without the transcript chunks — they live in their own
    table. `POST /edg/snapshots/{n}/restore` **appends** a revision that replaces
    the state; history is never rewritten, so restoring a later snapshot undoes
    it. A revision with no ops is the log's way of saying "the state was
    replaced", and anybody rebasing across one is told to reload.
  - **Idempotency** on `edg_revisions.client_op_ids` with a GIN index
    (`prisma/sql/0006-a12-edg.sql`): a retry after a dropped response returns the
    revision the first attempt produced instead of applying the edit twice.
  - **Rate limiting** per workspace — 20 batches of burst refilling at 5/s —
    because one seat with twenty tabs is one document being edited. Exhaustion is
    `429 common/rate_limited` whose `details.rejected` marks every op
    `rate-limited`, the one reason in `packages/edg`'s closed enum the API raises
    and the engine never does. Fails open on a Redis outage.
  - **`MergePass` is worker-only.** "worker" is never a claim in a user's token;
    the only route that submits ops as one is
    `POST /internal/projects/{id}/edg/ops`, behind the CONTRACTS §3 HMAC.
  - `EdgService.initialise(projectId, transcript)` — the entry point A11 calls
    once a transcript is segmented. Idempotent by project.
  - Realtime `edg.ops {revision, ops, source}` to `project:{id}` after the commit
    (CONTRACTS §7); the envelope's `at` is the server time.
  - Schema: `edg_pass_items.keyframes_ref` (CONTRACTS §2 freezes
    `PassItem.keyframesRef`; the table had only the bytes column) and
    `edg_segments (edg_id, start_word_id)` / `(edg_id, end_word_id)`, which is how
    a word delete finds the segments it bounds.
- **A16c — per-script type sizes (`typography.scriptScale`) and track-level shrink.**
  - **The problem.** Shrink-to-fit is decided per caption, so a short caption is drawn at
    full size and the next one, one word longer, smaller: the type size jitters shot to
    shot inside one video, and the picker's tile — short preview text, never shrunk —
    shows a size no real caption uses. 28 of 30 styles hit the shrink floor on a
    budget-filling caption.
  - **`typography.scriptScale`**, an optional, additive field on StyleDoc v2 (the schema
    generation stays 2; a document without it renders exactly as before): a per-script
    multiplier on `sizePct`, keyed by the lowercase OpenType tag (`latn`, `deva`,
    `taml`). `render-core` applies the entry for the script it is actually laying out —
    the script of the words on screen, not the project's language — so a Hinglish
    caption picks the right one line by line. `sizePct` keeps recording the size the
    style was drawn for.
  - It exists because the budgets are counted in **base characters** with combining marks
    excluded (that is what reading speed depends on) while width is a different question:
    a 22-character Tamil line is ~37 code points and about **21 em** wide, against 15.3 em
    for a full 32-character Latin line. One size per style cannot satisfy both.
  - `src/styles/fit.ts` measures the worst shrink over the four caption fixtures **and** a
    budget-filling caption per script, at every instant a `wordsPerCue` style rotates
    through, on both canvases; `worstFitForScript` restricts that to the layouts a given
    multiplier can move, which is what makes per-script tuning well-defined.
    `scripts/tune-style-sizes.ts` bisects each multiplier; `src/styles/fit.test.ts` asserts
    shrink ≥ 0.95 at 1080×1920 and ≥ 0.9 at 1920×1080, per script, for all 30 styles.
  - **`computeTrackShrink({projection, catalogue, registry, shaper, canvas, script})`**
    lays every caption out once and returns the minimum shrink per (styleId, script);
    `renderFrame` and `layoutFrame` take the map and apply it uniformly, so every caption
    in a style is one size for the whole video. Per-caption shrink remains the fallback
    when no map is given. It is a pure function and costs one layout per caption, so the
    exporters (A19, A20) and the preview stage compute it once per session — on a change
    of document, catalogue or canvas — and cache it; nothing calls it per frame.
  - Goldens, PNG baselines and the 30 catalogue previews regenerated; browser parity holds
    at 0 pixels differing.
  - **Reported, because it is a product decision.** Latin needed a multiplier below 1 in
    **28 of 30 styles** (0.45–0.94), so Latin does not in fact keep its authored size. The
    cause is the same arithmetic: 32 characters is roughly 16 em, and 16 em inside 78–90%
    of a 1080-wide portrait frame forces an em of ~2.8% of frame height whatever the
    script. The 32/24/22 budgets fit a 16:9 subtitle comfortably (a 4.2% line has ~33 em
    of room there) and are simply generous for 9:16. A 9:16-specific budget — nearer
    20–26 Latin characters — would let every `latn` multiplier go back to 1.
    `word-pop` and `impact-shout` need no multipliers at all: they show one word at a time.
  - **A12b:** a snapshot restore is now validated against the transcript as it
    stands before anything is written. The transcript is deliberately not rolled
    back with the captions, so a snapshot old enough to predate a `DeleteWord`
    still names that word; writing it would leave a caption bounded by something
    nothing can render. `validateProjection` runs over the projection the restore
    would produce, with a word index built from the **live** words only (a
    tombstoned word is as good as a missing one here), and any issue refuses the
    whole restore with `409 edg/restore_invalid` — `details.danglingWordIds`
    names the words, `details.issues` carries the validator's findings.
- **A16c/A16d — line budgets come from the type (decision D78), per-script sizes, and
  track-level shrink.**
  - **The problem.** `09 §3`'s 32/24/22 characters a line are readability caps, and were
    being treated as caption lengths. A full 32-character Latin line is about 16 em; 16 em
    inside 78–90% of a 1080-wide portrait frame needs an em of ~2.8% of frame height. Every
    style was therefore overflowing and shrinking, so two captions in one video were two
    different sizes and the picker's tile showed a size no real caption used.
  - **`fitBudget({style, script, canvas, registry, shaper}) → {maxChars, maxLines}`** in
    `@montaj/render-core`. It measures the average advance per **base character** by running
    a fixed, committed per-script sample through the real shaper with the resolved font, then
    divides the caption box — less box padding, inside the safe area — by it. The answer is
    `min(readabilityCap, whatFits)`, with caps 32/24/22 and two lines. `limitedByFit` says
    which of the two decided; `belowComfortableMinimum` flags a style so large that captions
    are one short word a line, rather than inflating the number and putting the overflow back.
  - `layoutSegment` now wraps at that budget instead of at the table. Wrapping at the cap
    re-joined words the segmenter had deliberately separated, which is what made the caption
    overflow in the first place. The segmenter and the layout now share one number.
  - **`@montaj/edg/segmenter` takes `maxCharsByScript`**, the shape `fitBudget` produces —
    per script, because the segmenter resolves its limit from the script of the run it is
    closing and a Hinglish transcript needs Roman and Devanagari runs to differ. It falls
    back to the flat `maxChars`, then to the table. `packages/edg/README.md` gains
    "Budgets come from `fitBudget`; readability caps are maxima".
  - **`typography.scriptScale`**, optional and additive (StyleDoc stays at generation 2): a
    per-script multiplier on `sizePct`, keyed by lowercase OpenType tag. Every style keeps
    the `sizePct` it was drawn for and **no style carries a `latn` entry**. The Indic entries
    stay on readability grounds, not fit: at the same em a Tamil budget collapses to five or
    six characters, and a modest reduction roughly doubles it.
  - **`computeTrackShrink({projection, catalogue, registry, shaper, canvas, script})`** lays
    every caption out once and returns the minimum shrink per (styleId, script);
    `renderFrame` and `layoutFrame` apply it uniformly so a style is one size for the whole
    video. Per-caption shrink stays the fallback. The value is floored to two decimals
    rather than rounded, because a value a hair above one caption's true need would leave
    that caption at its own size and show two sizes instead of one. It is pure and costs one
    layout per caption, so exporters (A19, A20) and the preview stage compute it once per
    session and cache it; nothing calls it per frame.
  - Tests: `fitBudget` (17), the per-script fit suite driven by the measured budget for all
    30 styles × 3 scripts × 2 canvases at shrink ≥ 0.95 (9:16) and ≥ 0.9 (16:9), track
    shrink (12), and the segmenter's per-script budgets. Goldens, PNG baselines and the 30
    catalogue previews regenerated; browser parity holds at 0 pixels differing.
  - A11 calls `fitBudget` at EDG initialisation from the project aspect and default style;
    A15 offers "Reflow captions" (a `Resegment` op) when a style change moves the budget.
    Neither is implemented here.

- **A16 — `@montaj/render-core`, `@montaj/render-canvaskit`, the 30 system styles and
  the editor's caption canvas.**
  - `@montaj/render-core` is implemented: `(StyleDoc, segment, words, time, canvas) →
DrawCommand[]`, pure TypeScript, HarfBuzz-wasm shaping (`harfbuzzjs` 1.6.1, pinned),
    a `FontRegistry` abstraction and no system fonts (D33). `layoutSegment` produces
    absolute geometry; `animate` turns it into commands as a pure function of time;
    `renderFrame` maps output time to source time through `@montaj/timemap` (D30),
    resolves each visible segment's effective style and draws them in `seq` order.
  - The `DrawCommand` union: `text` (shaped glyph ids with paired absolute positions
    and clusters), `rect`, `roundRect`, `path`, `image`, `group`, `transform`, `clip`,
    `shadow` and `blur` — the last with a `backdrop` flag for the styles that sample the
    video behind them. Fills and strokes take a solid or gradient `Paint`. Everything is
    JSON-serialisable and quantised, so a command list hashes stably and can be stored,
    diffed and shipped to a worker. `outlineTextCommands()` converts every glyph run to
    a path for a backend that cannot draw glyph ids, which is how A20's Canvas2D surface
    executes the same list.
  - Line breaking reproduces the segmenter's split rather than inventing one: the same
    greedy character wrap with the same counting rule (base code points, combining marks
    excluded). Only genuine metric overflow changes anything, and then the answer is
    shrink-to-fit; re-wrapping by width happens only at the shrink floor, and a break
    inside a word only when one word alone is too wide — always on a HarfBuzz cluster
    boundary, so a Devanagari matra or a Tamil conjunct is never cut in half.
  - Sizes stay relative: type, position and safe area off the canvas height, stroke,
    shadow, padding and radius off the font size, so one document renders identically at
    1080×1920 and at the 540p proxy. Document-level overrides are read from
    `styles.inline.doc` and beaten by a segment's own `overrides`.
  - `@montaj/render-canvaskit` executes the command list on Skia-WASM (`canvaskit-wasm`
    0.42.0, pinned): WebGL where available, CPU raster otherwise, both reported to the
    caller. Per-frame Skia objects live in an arena that is released however the frame
    ends, and a missing font or image is reported rather than thrown.
  - The 23 remaining styles in `styles/registry.json` are drawn, so all 30 validate,
    render and have a committed preview. Four need a capability StyleDoc v2 has no field
    for (two gradients, one backdrop blur, two raster passes); that ink lives in
    `render-core`'s `styles/capabilities.ts` keyed by style id rather than in a widened
    frozen schema.
  - `apps/web`: `StylePreviewCanvas` (a style drawn live, still or looping its
    three-second preview), `CaptionStage` (proxy video plus the CanvasKit overlay, safe
    zones, and a draggable caption box that emits exactly one `SetSegmentPosition` per
    drop, scrubbed with `requestVideoFrameCallback`), and the Style/Colors/Look/Anim
    right panel whose every control emits one `SetStyle` at the current scope.
    `/studio/styles` mounts the panel against the system catalogue.
  - Tests: golden `DrawCommand[]` hashes for 30 styles × 4 caption fixtures (Hinglish,
    Hindi, Tamil, English) × 3 instants plus full committed command lists; determinism
    tests; a chromium Playwright lane that executes a stored command list with CanvasKit
    and compares the encoded frame against the PNG Skia-in-Node drew from the same list,
    within D33's parity SLO. `render-core` sits at 99% lines / 93% branches against the
    90/85 gate, and a two-line 1080p frame lays out and draws in **0.11 ms** (p50)
    against a 2 ms target.
- **A25 — api: `notify` consumer, transactional email (SES/SMTP/dev outbox),
  English and Hindi templates, suppression, in-app notifications.**
  - `apps/api/src/notify`: a `MailProvider` port with three adapters chosen once
    at boot by `MAIL_PROVIDER` — `SesProvider` (AWS SDK v3 SESv2, credentials from
    the pod's IRSA role and region from `S3_REGION`, so there is still no mail key
    in CONTRACTS section 1), `SmtpProvider` (pooled nodemailer from `SMTP_URL`;
    Mailpit locally under the new compose profile `mail`), and `DevOutboxProvider`,
    which writes A04's Redis list at A04's key in A04's entry shape plus the
    rendered message and refuses to run in production. A misconfigured transport is
    a startup failure rather than a queue quietly filling with undeliverable jobs.
  - `NotifyService.enqueue({kind, to, locale, data, idempotencyKey})` — the brief's
    payload, carried as the `payload` of the frozen CONTRACTS section 3 envelope so
    a future out-of-process consumer parses the same shape. The idempotency key is
    the BullMQ job id, which is what makes a repeated enqueue a no-op; a message
    produced before a user belongs to anything uses the documented sentinel
    `workspaceId: "none"`, because the envelope requires a non-empty one.
    Enqueueing never throws for a delivery reason: a notification is a side effect
    of work the caller cares about, so a Redis hiccup is logged, exactly as
    `RealtimePublisher` already swallows one.
  - `NotifyConsumer`: one BullMQ `Worker` inside the API process behind
    `NOTIFY_WORKER_ENABLED` (default on; `0` for one-shot processes and test runs,
    the same lever `MONTAJ_SCHEDULER_DISABLED` is for the scheduler). Sending is a
    render and one HTTPS call, so a second deployable would be a rollout and an
    on-call surface for work the API is already sized for. Per job: suppression,
    then a ten-an-hour per-recipient bucket that the account-security kinds skip,
    then a delivery receipt checked before the render and written after the send —
    so the queue's five retries cannot deliver the same message twice. A malformed
    payload or a template missing a variable is an `UnrecoverableError`, because no
    amount of retrying fixes either.
  - Ten templates (`verify-email`, `magic-link`, `password-changed`,
    `device-approval`, `login-new-device`, `parental-waitlist`, `renewal-notice`,
    `low-credits`, `export-ready`, `share-comment`) as hand-written responsive HTML
    plus a real text part, from ICU MessageFormat strings in English and Hindi
    (08 section 6). **No remote images and therefore no tracking pixel**; values are
    escaped before ICU formats them, so a project called `<b>` is text and not
    markup; brand words arrive as `{brand}`/`{support}` from
    `packages/config/src/brand.ts` rather than being written into a string
    (CONTRACTS section 0). `List-Unsubscribe` (RFC 8058 one-click) only on
    `low-credits` and `share-comment` — everything else is transactional or, for
    the pre-debit `renewal-notice`, legally required.
  - `POST /internal/mail/events`: the SES bounce and complaint feed over SNS,
    authenticated by the **SNS message signature** rather than by
    `InternalSignatureGuard`, because SNS will not compute our HMAC. Canonical
    string, RSA-SHA1/SHA-256 verify, and a signing certificate fetched only from
    `https://sns.<region>.amazonaws.com/*.pem` (05 section 8's SSRF rule) — without
    that check the route would let anyone suppress any address they can name. SNS
    posts `text/plain`, so a middleware parses the body for that one route instead
    of widening the global parser. A `SubscriptionConfirmation` is verified and
    logged but never auto-confirmed: confirming is an outbound GET to a URL that
    arrived in a request.
  - Suppression: permanent for a hard bounce or any complaint, a fortnight for a
    transient one, released early by a later `Delivery`. The live set is in Redis
    keyed by SHA-256 of the address (a Redis dump should not be a mailing list) and
    every change — including each message _not_ sent — is an `audit_log` row with
    the address masked, because a cache is not an answer to "why did we stop
    mailing this customer?".
  - In-app notifications: a `notifications` table (`id`, `userId`, `workspaceId?`,
    `kind`, `data`, `readAt`, `createdAt`, both keys cascading so erasure takes the
    bell with it), `GET /me/notifications` and `POST /me/notifications/{id}/read`
    scoped to the user from the access token, and a realtime `notification.created`
    event on the workspace room. Rows carry no body text: wording is rendered per
    locale at read time, so switching language switches the bell.
  - A04's `AuthMailerService` is now a thin adapter onto `NotifyService.enqueue`
    instead of a logger. Its e2e suite completes real sign-up, verification and
    magic-link flows unchanged — delivery became asynchronous, so `auth-harness`
    drains the queue before reading the outbox rather than sleeping and hoping.
  - `MAIL_SNS_TOPIC_ARN` (optional): when set, `POST /internal/mail/events` refuses
    a correctly signed SNS message published to any other topic, and refuses it
    before fetching the certificate. The signature proves AWS published the
    message, not that we own the topic it came from, so an account can sign a
    perfectly valid bounce for any address from a topic of its own. Unset, any
    topic is accepted — a deployment that has not configured it is better off
    receiving bounces than silently discarding them.
  - Auth mail is written in the recipient's language: `users.locale` (default
    `en-IN`) reaches `AuthMailerService` from both call sites, and
    `test/notify-locale.e2e-spec.ts` drives a real sign-up to prove a `hi-IN`
    account receives the Hindi subject and greeting — a chain that runs from the
    sign-up request through the stored row, the notify job and the renderer, and
    that no single-layer test would catch breaking.
  - `tools/runbooks/mail-outbox.js` prints the development outbox.
  - 130 notify tests (template snapshots in both languages, provider selection and
    each adapter, SNS signature verification against a per-run self-signed
    certificate, suppression, retry and idempotency semantics, both bell endpoints)
    plus an HTTP suite for the `text/plain` webhook body. `apps/api` sits at 93.9%
    lines and 87.2% branches against the CONTRACTS section 9 gate of 75/70.
- **A10 — worker-ai: vendor adapters, two-signal LID, routing chain, forced
  alignment, diarisation and the result cache.**
  - `worker_ai/providers/elevenlabs.py`, `sarvam.py`, `assemblyai.py`: the three
    vendor adapters of decision **D12**, behind the A09 `Provider` interface.
    Scribe v2 is one multipart request per chunk with word timestamps and
    diarisation included, which is why a Scribe-routed job runs neither the
    aligner nor pyannote. Saaras v4 is **Batch only** (init, blob upload, start,
    poll, download) because its REST endpoint caps at 30 s of audio, and returns
    chunk-level timestamps only, which is why its lane is `alignment: required`
    (RR-02 F1). Universal-2 is upload / submit / poll and speaks **milliseconds**
    where every other vendor speaks seconds.
  - `worker_ai/providers/http.py`: one retry policy for every vendor — 429 and
    5xx retried with `Retry-After` honoured and jittered exponential backoff,
    every other 4xx fatal, and no credential ever in a log line or an exception
    message.
  - **No vendor key exists yet (A00-06)**, so every adapter is driven by recorded
    HTTP under `worker_ai/fixtures/vendor/` replayed through
    `httpx2.MockTransport` (`evals/replay.py`). `tests/test_vendor_smoke.py` is
    the documented manual path for the day the keys arrive, skipped unless
    `RUN_VENDOR_SMOKE=1`.
  - `worker_ai/lid.py`: the two-signal language identification of **D14** —
    Whisper LID over 60 s + two 15 s windows (or the routed provider's own answer)
    plus a local classifier on the first chunk. The code-mix lane needs _both_
    signals on Hindi/Hinglish and `codeMixScore ≥ 0.3`, because RR-02 F4 measured
    IndicLID's romanised head at F1 0.75 and it cannot carry that decision alone.
    A disagreement takes the acoustic signal and raises `lowConfidence`. The whole
    decision is logged per job and travels in the completion `result`.
  - `worker_ai/routing.py`: `resolve_chain` returns every candidate a deployment
    can run, primary first, so `ai.transcribe` falls through to the next vendor on
    a `ProviderError` instead of failing the job. Admin weights are laid over
    `routing.yaml` from `ROUTING_OVERRIDES_JSON` and, when B13 ships it, from
    `GET /internal/routing`. **Naming Bhashini in a lane is now a load-time
    error** (`NEVER_ROUTE`): its public API is proof-of-concept-only by its own
    terms (RR-02 F3, D63).
  - `worker_ai/alignment/ctc.py`: CTC forced alignment in numpy — the Viterbi pass
    over the blank-interleaved lattice, with the repeated-character rule that is
    the classic place a hand-rolled aligner goes wrong. `IndicWav2VecAligner`
    (MIT) and `MmsAligner` load ONNX checkpoints lazily from
    `WORKER_AI_ALIGN_MODEL_DIR`; `ElevenLabsForcedAligner` is the paid rung; the
    proportional + VAD fallback still needs no model. Roman Hinglish is projected
    onto Devanagari and MMS input is romanised first, both by rule tables.
  - `worker_ai/diarisation/pyannote.py` and `mapping.py`: pyannote
    **community-1** over the whole file through the D15 model server, with speaker
    labels joined onto words by overlap (nearest turn when a word overlaps none).
    Where the provider already labelled the words — Scribe does, and it is priced
    in — pyannote does not run. The **CC-BY-4.0 attribution** is a module constant
    and ships in `engineVersions`.
  - `worker_ai/cache.py`: the `09 §1` result cache, keyed by
    `contentHash + language + provider + model` (plus the lane's mode and the
    chunk span), 30-day TTL, per-entry size cap, Redis or memory or off. A hit
    skips the vendor call and sets `usage.cached`. A cache outage is a miss, never
    a failure.
  - `worker_ai/metrics.py` and `GET /metrics`: Prometheus counters per provider,
    language and lane — calls by outcome, media seconds, estimated paise, cache
    hits, routing fallbacks. No workspace, project or media id is ever a label.
  - `worker_ai/fixtures/speech-5s/`: a five-second **CC0** speech-shaped clip,
    generated by the committed `make_clip.py`, so the `slow` LocalWhisper test
    feeds a model real audio and the eval harness's vendor lanes have media.
  - The eval CLI scores every adapter: `evals run --set vendor-replay --provider
sarvam` replays the recorded session, `--live` calls the configured vendor.
  - **Security fix:** `httpx2` logs every request URL at INFO, and Sarvam's Batch
    API hands back Azure blob SAS URLs with the signature in the query string —
    so that one line would have written a live credential into the pod's logs on
    every job. `logging_setup.configure_logging` now holds the HTTP client
    loggers at WARNING, and `providers/http.py` logs the path with the query
    string stripped (THREAT-MODEL T21).

- **A09 — worker-ai: the BullMQ Python worker, provider interface, VAD and
  chunking, alignment and diarisation registries, evals.**
  - `apps/worker-ai/worker_ai/runtime.py`: one `bullmq.Worker` per `ai.*` queue.
    `ai.vad`, `ai.transcribe`, `ai.align` and `ai.diarise` are implemented;
    `ai.translate`, `ai.transliterate`, `ai.clean`, `ai.pass` and `ai.llm` are
    consumed and answered `worker/not_implemented` naming the work package that
    owns them, so a producer gets an error in seconds instead of a job that rots
    in Redis until the queue-wait sweeper finds it.
  - **Retry semantics against A08.** A job has two BullMQ attempts but one
    `attemptId`, so a failed completion posted on a non-final attempt would move
    the row to `failed` and make the retry invisible. The worker therefore posts a
    failed completion only on the final attempt (`finalAttempt: true`) or when the
    error is non-retryable (`error.retryable: false`) — the two flags
    `markDeadLetterIfFinal` reads — and re-raises either way.
  - `worker_ai/callbacks.py`: the signed progress and completion client of
    CONTRACTS section 3. The body is serialised once, signed as those exact bytes
    and posted unchanged; the worker signs with the primary
    `INTERNAL_CALLBACK_SECRET` only (`INTERNAL_CALLBACK_SECRET_NEXT` is the API's
    verification key during a roll). Bounded retries on transport, 5xx and 429;
    a 4xx is fatal; `applied: false` is reported as the success it is.
  - `worker_ai/vad.py` and `chunking.py`: decision **D14** — a full-file VAD pass,
    then nominal 10-minute chunks cut at the longest silence within ±30 s, never
    mid-region, no overlap. Silero v5 through onnxruntime (torch-free) when a model
    file is configured, and a deterministic energy backend otherwise, which is what
    CI and the property tests run on.
  - `worker_ai/providers/`: the `Provider` interface with a capability record, a
    cost estimate and a `ProviderSubmission` trail, plus a registry that reports
    _why_ an adapter is disabled. `MockProvider` (deterministic, Hinglish sample),
    `LocalWhisperProvider` (faster-whisper, optional `local-asr` extra) and
    `ServerlessWhisperProvider` (the D15 per-second GPU endpoint) ship; ElevenLabs
    Scribe v2, Sarvam Saaras v4 and AssemblyAI are shells carrying their
    capabilities and prices until A10.
  - `worker_ai/routing.yaml` + `routing.py`: the v2 routing table of `09 §1`
    (decision **D12**) as data, read-only, with a resolver that walks a lane and
    takes the first provider the deployment enables.
  - `worker_ai/alignment/` and `diarisation/`: the **D13** registries.
    `ProportionalAligner` distributes words by character length onto the VAD speech
    timeline and repairs monotonicity — the always-available rung; IndicWav2Vec,
    MMS and ElevenLabs FA are shells with their models and licences recorded.
    `NoopDiariser` labels every region `S1`; the pyannote community-1 shell records
    the model name and its CC-BY-4.0 licence.
  - `worker_ai/transcript.py`: stable `"<chunkIdx>:<n>"` word ids, chunk-local and
    dense, with the post-processing hook A11 replaces.
  - `worker_ai/control.py`: `GET /health`, `GET /providers` (every adapter, its
    enable flag and its reason, plus the routing table and both registries) and a
    `POST /evals/run` stub, on port 8091, pod-internal.
  - `worker_ai/evals/`: a fixture-manifest format, WER/CER over normalised text
    (Devanagari danda included), a runner and
    `python -m worker_ai.evals run --set fixtures/hinglish-mini --max-wer 0.15`,
    which is the gate `09 §8` needs to block a routing change on a regression.
  - `apps/worker-ai/Dockerfile` (CPU: ffmpeg, onnxruntime, faster-whisper and the
    Silero model baked in) and `Dockerfile.gpu`, a placeholder documenting the
    serverless-GPU image contract of D15.
  - `worker_ai/policies.py`: A08b's retry, stall and heartbeat table, mirrored from
    `apps/api/src/jobs/jobs.config.ts` and pinned by a parity test that parses the
    TypeScript. `attempts` and `backoff` reach the worker inside the job options,
    but `lockDurationMs`, `stalledIntervalMs` and `maxStalledCount` are `Worker`
    constructor options a worker has to read — and **the progress callback is the
    heartbeat**, so `JobContext.heartbeat()` reposts the last percentage every
    third of the lock and `ai.transcribe` beats while a chunk is inside a provider.
    Without it a ten-minute chunk on a two-minute lock would be declared stalled
    and handed to a second worker mid-transcription.
  - Tests: 321 unit and property tests with the CONTRACTS section 9 coverage gate,
    a callback suite verified against a server that implements the section 3
    signature, and `tests/test_integration.py` — a real BullMQ job from the API's
    own producer modules, consumed by a real worker, completing against the real
    API (`RUN_INTEGRATION=1`).

- **A05 — api: users, workspaces (tax profile), memberships, consent, privacy.**
  - `apps/api/src/users/`: `GET`/`PATCH /me` (name, avatar, locale, onboarding
    state, marketing opt-in, with a change to the opt-in also appending a
    `consent_records` row); `GET /me/data`, the DPDP access and portability right
    — a `dsr_requests` row of kind `export`, a JSON bundle of every row the
    account holds, and a single-use download link carrying 256 bits of entropy
    that expires in an hour; `DELETE /me`, the erasure right — a `dsr_requests`
    row of kind `erasure`, the account marked deleted, the address anonymised to
    an RFC 2606 `.invalid` mailbox and every session revoked in one transaction
    (the cascade over media and transcripts is B16). Both stamp `dueAt` 30 days
    out (DPDP Rule 14). The module also owns `AuditService`, the `audit_log` +
    `access_logs` writer every other A05 module uses.
  - `apps/api/src/workspaces/`: `GET`/`POST /workspaces`, `GET`/`PATCH`/`DELETE
/workspaces/{id}` (settings merged rather than replaced; a personal workspace
    that is the caller's only one cannot be deleted); `PUT
/workspaces/{id}/tax-profile` with the D41 rules — India requires a State code
    from the 36 live GST codes, an optional GSTIN is checked against its base-36
    check digit and must name that same State, currency is derived
    (`IN → INR`, else `USD`) and locked once a subscription exists, and confirming
    a profile stamps the new `billingCountryConfirmedAt` that B01 requires before a
    checkout; `GET /workspaces/{id}/entitlement`, the Free-plan stub cached in
    Redis for 60 seconds (B02 computes it for real); members
    (`GET`/`POST /workspaces/{id}/members`, `PATCH`/`DELETE .../{membershipId}`)
    with exactly one immutable owner, no granting a role above your own, and every
    session of a removed member revoked at once; and `/invitations` — accepted from
    the invitee's own verified address, so the id in the mail is a lookup key
    rather than a bearer secret.
  - `WorkspaceMemberGuard` on **every** `/workspaces/:id` route (THREAT-MODEL T4):
    the id in the path must be the token's `ws` claim, an active membership must
    still exist, and the principal's role is replaced with the one in the database
    so a demotion bites on the next request rather than at the end of the token's
    fifteen minutes. `test/workspace-guard.e2e-spec.ts` enumerates the shipped
    route table from the router and drives every `:id` route as a stranger, as a
    removed member and with no token, so a route added without the guard fails
    without anybody editing the test.
  - `apps/api/src/consents/`: `GET`/`POST /consents` over an append-only
    `consent_records` log (a refusal is a row, a withdrawal closes the grants it
    supersedes, and `users.marketingOptIn` / `analyticsConsentAt` /
    `memoryConsentAt` are mirrored in the same transaction); `reconsentRequired`
    reports an answer given against an older notice (D61, D62).
  - `apps/api/src/privacy/`: `GET /privacy/notice`, the itemised notice's version
    and purpose list, public because a person has to read it before creating an
    account; and `GET /admin/parental-waitlist`, which lives in A08b's
    `AdminModule` behind `AdminGuard` (`users.is_admin`) because the waiting list
    belongs to nobody's workspace and no membership could authorise reading it.
  - **Schema:** `workspaces.billing_country_confirmed_at` (the sign-up default is a
    guess, not a statement the customer made) and the `parental_waitlist` table
    (`sha256(address)`, jurisdiction, age bracket, `notifiedAt`), which
    `ParentalWaitlistService` drains A04's Redis hash into at boot. Migration
    `20260902030000_a05_billing_country_confirmed_and_parental_waitlist`.
  - No new environment variables and no new feature flags; `pnpm gen:client`
    regenerated `packages/api-client` (53 operations).
  - `apps/api/test/db-harness.ts`: the Docker probe waits 60 s rather than 20 s.
    Vitest collects the suite files in parallel, so every Docker-backed suite
    probes the daemon at once, and A05 took that from three suites to five; a
    timeout there does not fail a run, it silently skips every integration suite.
    A daemon that is genuinely absent still fails in milliseconds.

- **A08b — api: dead-letter queue, admin replay, retry/stall policy, job-event
  retention.**
  - `apps/api/prisma`: the `dlq` table (migration
    `20260902030000_a08b_dlq_replay`) — one row per attempt that exhausted its
    retry budget, carrying the queue, the payload, the last error, the attempt
    ordinal and the credit hold a replay has to reserve again — plus
    `jobs.dlq` / `dlq_reason` / `dlq_at` / `attempt_no` and `users.is_admin`. The
    migration **backfills** from the `job.dead_lettered` events A08 wrote when
    there was nowhere else to put them, so no dead letter is lost.
  - `apps/api/src/jobs/dlq.service.ts`: the dead-letter path. The copy is taken
    from the job row _before_ the completion update, so it remembers the hold, and
    it is idempotent on `(jobId, attemptId)` so an at-least-once callback writes
    one row. **Replay** claims the entry with a conditional update (two admins,
    one replay), reuses the same `jobs` row, mints a fresh `attemptId` and
    increments `attempt_no` — which makes the old attempt's late callback a
    `stale_attempt` no-op (THREAT-MODEL T8) — reserves credits again through the
    facade, and adds the BullMQ job last, so every earlier failure unwinds with
    nothing enqueued. **Discard** releases the hold and records a mandatory reason.
  - `apps/api/src/admin`: `AdminGuard`, which reads `users.is_admin` from the
    database on every request rather than from a token claim, so revoking an admin
    takes effect at once; and `GET /admin/dlq`, `/admin/dlq/stats`,
    `/admin/dlq/{id}`, `POST /admin/dlq/{id}/replay`, `/{id}/discard` and the bulk
    `/admin/dlq/replay` and `/admin/dlq/discard`, which **dry-run by default**.
    Every replay and discard writes an `audit_log` row (THREAT-MODEL T20); a
    non-admin is 403.
  - **Retry and stall policy per queue** (`jobs.config.ts`): attempts (media 3,
    ai 2, render 2, notify 5), exponential backoff **with jitter** — an
    un-jittered backoff retries a whole outage into the same dead provider at the
    same millisecond — and lock durations and stall intervals tuned per queue,
    with ten minutes on `ai.transcribe`, `ai.diarise` and `render.video`.
    `heartbeatIntervalMs()` is a third of the lock, and the heartbeat is the
    existing progress callback.
  - **Job-event retention** (D47): `jobs.event-retention`, nightly, deletes rows
    past their own `data.retainUntil` in batches, falling back to `at` for rows
    written before the marker existed. `dlq` rows are never purged.
  - **Metrics** and `GET /internal/metrics`, a Prometheus exposition rendered from
    an in-process registry that also mirrors into the OpenTelemetry metrics API.
    Names follow `infra/observability/METRICS.md` — `montaj_job_completed_total`,
    `montaj_queue_dlq_depth`, `montaj_queue_wait_duration_seconds`,
    `montaj_job_attempts`, `montaj_dlq_resolved_total` — with the A08b brief's
    `montaj_jobs_failed_total`, `montaj_dlq_depth` and `montaj_job_queue_wait_ms`
    emitted as aliases of the same data, because the shipped dashboards and the
    `MontajDlqNonEmpty` / `MontajDlqGrowing` rules query the METRICS.md names.
  - `tools/runbooks/dlq-replay.js`: `stats`, `list`, `show`, `replay` and
    `discard` against the admin API — not against Postgres, because the policy a
    replay has to honour lives in `DlqService`. `replay` and `discard` are dry runs
    unless `--confirm`, and refuse to run with no target.
    `docs/runbooks/dlq-replay.md` is rewritten around the real commands.
  - New optional environment variable `MONTAJ_METRICS_TOKEN` (non-contract): when
    set, `GET /internal/metrics` requires it as a bearer token.

- **A02b — `@montaj/edg` ops engine: apply, rebase, segmenter, snapshots, migrations.**
  - `@montaj/edg/ops`: `EdgState` (hot document, segments by id in `seq` order,
    passes and items, the transcript word index, tombstones and a 10,000-entry
    `opId` idempotency window) with `fromProjection`/`toProjection`, and
    `applyOps(state, ops, ctx)` implementing all 16 ops of CONTRACTS section 2.
    Pure TypeScript with no database access, so the API module (A12) and the
    browser client run the identical code; per-op atomic, so one rejected op never
    rolls back the rest of a batch; `toProjection` is canonical, so two clients
    that applied the same commuting ops in a different order serialise the same
    bytes.
  - `@montaj/edg/ops`: `rebaseOps(incoming, opsSince)` — the D29 transform table.
    Last writer wins per `(target, field)` for the scalar fields; a `Resegment`
    since the base revision invalidates segment-addressed ops but keeps
    word-level ones; a word deleted since the base makes any op naming it
    `stale`; a concurrent edit of the same text — `EditWord` on one word,
    `SetSegmentText` on one `(segment, script)` — is a `conflict` rather than a
    silent drop, so the 409 carries both texts and the client resolves it;
    segments merged away are remapped onto the segment that swallowed them where
    the op still means something, and a `MergeSegments` list grows the children
    of any segment split since the base. It reads only ops, never the document.
  - `MergeSegments` spans the outermost words of the segments it joins rather
    than the first and last segment's own ends: `seq` decides what shows when and a
    client may set bounds that do not follow the transcript, so taking the ends on
    trust could leave a caption whose range ran backwards. Found by the projection
    property, not by a hand-written case.
  - `@montaj/edg/ops`: `snapshot`/`restore`/`replay` over `EdgSnapshotSchema`
    (`{schemaVersion: 2, projection, chunks?}`), and the types-only
    `EdgRepository` (`loadHot`, `loadSegments`, `loadItems`, `appendRevision`
    returning either the new revision or `{latestRevision, opsSince}`,
    `snapshotEvery = 100`) that A12 implements.
  - `@montaj/edg/segmenter`: `segmentWords` with the script-aware limits of
    `09 §3` — Latin 32 characters a line at 20 CPS, Devanagari 24 at 15, Tamil 22
    at 15, anything else 26 at 15 — detected per word by Unicode block, with
    speaker-change and sentence breaks, a 150 ms minimum breakable pause, 700 to
    6,000 ms captions and a merge pass that absorbs anything shorter. Deterministic
    by construction.
  - `@montaj/edg/migrations`: `migrate(snapshot, targetVersion)` with a registered
    `v1` to `v2` step that turns v1's flat word array and index-addressed
    `wordRange: [i, j]` segments into `transcript_chunks` with stable word ids,
    deriving the chunk index from the cumulative `chunkSizes` v1 stored (or from
    10-minute windows when it did not), preserving segment texts and timings.
  - Fixtures: `fixtures/segmenter-golden.json` (Roman Hinglish, Devanagari Hindi
    and Tamil, with the wrapped lines and their character counts so the limits can
    be reviewed by eye, regenerated by `pnpm --filter @montaj/edg golden:build`)
    and `fixtures/legacy-v1-document.json` for the migration test.
  - 253 tests at 98.9% lines and 92.9% branches, over the CONTRACTS section 9 gate
    of 90/85: a table-driven case per op (happy path and every rejection reason),
    the transform table case by case, and eleven fast-check properties — a batch
    that fully applied leaves the document untouched when it arrives twice and a
    replay never re-applies what already landed, commuting ops converge whatever
    the order, `validateProjection` holds after any random op sequence, `rebaseOps`
    never produces an op naming a tombstoned id and never drops a caption-text
    edit silently, and the segmenter covers every live word exactly once inside
    its limits, deterministically. Benchmarks: 1,000 ops on a 9,000-segment
    document in ~20 ms (budget 200 ms) and 54,000 words segmented in ~205 ms
    (budget 500 ms).

- **A04 — api: auth (email/password, Google PKCE, magic link, refresh families,
  device grant, token exchange, sessions).**
  - `apps/api/src/auth/`: sign-up with the D60 age gate (India under 18 and the EU
    under 16 are refused with `auth/age_restricted` and offered a parental-consent
    waitlist) and per-purpose consent written into `consent_records`; email
    verification and magic links as single-use Redis tokens; login over argon2id
    (64 MiB, t=3, p=1) with a feature-flagged, fail-open breached-password check
    against HIBP's k-anonymity range API; Google sign-in with PKCE, a single-use
    state entry and a handoff code so no token ever rides in a redirect URL, plus
    the https `/auth/desktop-landing` page that triggers the deep-link scheme for
    desktop and panel clients; the RFC 8628 device grant with an 8-character
    unambiguous user code, a 10-minute TTL, a five-per-address cap on flows in
    flight, a server-enforced poll interval and an approval screen naming the host
    application, the device, the address and a coarse location; RS256 access
    tokens carrying exactly the CONTRACTS section 5 claims; refresh-token families
    rotated in place with a 60-second grace that replays the same pair, and reuse
    outside the window revoking the whole family and auditing it; workspace token
    exchange, session listing and session revocation.
  - `apps/api/src/common/guards/`: `JwtAuthGuard`, `RolesGuard`, `ApiKeyGuard`
    (B14 issues the keys; the guard and the scope check ship now), `@Public()`,
    `@Roles()`, `@CurrentUser()`, `@CurrentWorkspace()`, and a Redis token-bucket
    rate limiter behind `@RateLimit(...)` that answers 429 with `Retry-After`.
  - `apps/api/src/users/`: the minimal accounts surface auth needs — create a user
    with a personal workspace, an owner membership and the consent rows in one
    transaction, look one up, and answer membership questions.
  - `pnpm gen:client` regenerates `packages/api-client/openapi.json` and
    `src/generated/operations.ts` from the API's own OpenAPI document.
  - `TRUST_PROXY` (local process setting, not part of CONTRACTS section 1): the API
    reads the client address from `X-Forwarded-For` only when it is `1`, so per-IP
    rate limits cannot be side-stepped by setting the header.
  - Tests: 53 e2e cases against a real PostgreSQL and Redis (testcontainers) plus
    unit suites for the token service, the password policy, the guards, the age
    gate and the token primitives. THREAT-MODEL T1–T4 are mapped to evidence in
    `apps/api/src/auth/README.md`.
  - Fixed `apps/api/vitest.config.ts`: `mergeConfig` takes two configs and a
    boolean, so the four-argument call had been silently dropping the CONTRACTS
    section 9 coverage gate and the exclude list.

- **A08 — api: jobs module, realtime gateway, idempotent completion callbacks,
  no-op `CreditsFacade`, admission control.**
  - `apps/api/src/jobs`: `JobsService` — the producer for every queue in
    CONTRACTS section 3 — with the enqueue order that makes the whole thing safe
    (dedupe by `jobKey`, admission control, `jobs` row, `CreditsFacade.reserve`,
    BullMQ add, `job_events`), so a job that reaches Redis always has a row and a
    credit hold behind it and every earlier failure unwinds cleanly. Cursor-paged
    `GET /jobs`, `GET /jobs/{id}`, `GET /jobs/{id}/events` and
    `POST /jobs/{id}/cancel`, all scoped to the token's workspace, with another
    workspace's job answering 404 rather than 403 (THREAT-MODEL T5).
  - **Admission control** (THREAT-MODEL T23): per-workspace enqueued-credit cap
    (429 `jobs/enqueue_cap`), concurrency lane (429 `jobs/concurrency_cap`),
    per-plan `maxQueueWaitMs` swept every 30 s into `jobs/queue_timeout` with the
    hold released, and the free-tier daily allowance enforced in the facade.
  - `apps/api/src/internal`: the signed worker callbacks —
    `POST /internal/jobs/{id}/progress`, `/complete`, `/enqueue-child` and
    `PATCH /internal/media/{id}` — behind `X-Montaj-Signature`
    (`hmac_sha256(secret, timestamp + "." + rawBody)`), a five-minute skew window
    and constant-time comparison. Completion is idempotent on `(jobId, attemptId)`
    through a conditional `UPDATE ... WHERE status IN ('queued','running')`, so a
    replay answers 200 and settles nothing (THREAT-MODEL T8/T9). Two-key rotation
    via the new optional `INTERNAL_CALLBACK_SECRET_NEXT`. The whole surface is
    excluded from `/docs`.
  - `apps/api/src/realtime`: `/realtime` over plain `ws` — authentication at the
    upgrade (`Sec-WebSocket-Protocol: aksharo.v1, bearer.<token>`, or an
    `Authorization` header), rooms `project:{id}` / `workspace:{id}` authorised
    against the token's workspace _and_ a live membership, Redis pub/sub fan-out
    with reference-counted subscriptions, a 30-second heartbeat and documented
    reconnection semantics (`apps/api/src/realtime/README.md`). The four events of
    CONTRACTS section 7 are typed now; A12 and B15 emit two of them later.
  - `apps/api/src/credits`: the CONTRACTS section 4 `CreditsFacade` interface plus
    a `grantLot` signature for Wave 3, and `NoopCreditsFacade` — real shape, real
    idempotency, no ledger. B02 changes one `useClass`.
  - `apps/api/src/common/scheduler`: `ScheduledTasksService`, cron for the API on
    BullMQ job schedulers, so periodic work is one registration rather than a
    timer per module. `jobs.queue-timeout` is its first task.
  - `tools/runbooks/queue-drain.js`: pause a queue, wait for its active jobs to
    drain with a timeout, print the counts; `--status`, `--resume`, `--json`.
  - New optional environment variables: `INTERNAL_CALLBACK_SECRET_NEXT`
    (CONTRACTS section 1, rotation), and the non-contract `MONTAJ_QUEUE_PREFIX`
    (defaults to BullMQ's own `bull`) and `MONTAJ_SCHEDULER_DISABLED`.
- **A03c — api: `PassStatus.succeeded` becomes `ready`.**
  - `@montaj/edg`'s `PassStatusSchema` is the source of truth for the pass
    lifecycle; A03 had written `succeeded` by analogy with `JobStatus`, but a pass
    whose job succeeded is not finished — its items are `ready` for review, and
    only a `MergePass` op moves it to `merged`. Migration
    `20260902020000_pass_status_ready` renames the value in place (no row rewrite);
    `JobStatus.succeeded` is untouched, since it mirrors the completion callback of
    CONTRACTS section 3.
  - The integration suite now compares `PassStatus` and `ItemState` in the database
    against the package's own enums, so this class of drift fails a test instead of
    reaching a client.

- **A03b — api: seq is a base-62 string; style loader hardened.**
  - `edg_segments.seq` becomes `text COLLATE "C"` (migration
    `20260902010000_edg_segment_seq_text`). A03 read 06's "seq numeric" literally;
    A02 has since shipped `seqBetween()` in `@montaj/edg`, which returns base-62
    keys such as `1B` and `Zz` that no NUMERIC column can hold. The alphabet
    `0-9A-Za-z` is in ASCII order so that `ORDER BY seq` is the comparison
    `compareSeqKeys()` makes, which holds only under byte collation — pinned on the
    column because managed Postgres usually defaults to a linguistic one, and
    asserted by a test that inserts `1`, `1B`, `2`, `Zz`, `a`, `zzzV`.
  - `edg_segments_live_seq_idx` becomes UNIQUE: two _live_ segments may not share a
    fractional key. Partial rather than a plain unique constraint, because a
    tombstoned segment keeps its key and a later edit may legitimately reclaim it.
  - The seed's style loader takes an injected module loader, so the fixtures and
    placeholder tiers stay testable now that `@montaj/caption-styles` always
    resolves; the fixtures tier accepts only documents that parse as StyleDoc v2
    with an `id`, so `styles/registry.json` — the catalogue index A02 ships
    alongside the styles — is no longer seeded as a style.
  - `pnpm db:seed` now reports `source: package` and seeds A02's seven system
    styles.

- **A02c — `@montaj/timemap`: source ↔ output time mapping (D30).**
  - `buildTimeMap({sourceDurationMs, edits, fps?, snapCutsToFrames?})` turns a list of
    `cut`, `speed` and `hold` edits into a frozen, ordered span list covering both
    clocks, with `O(log n)` lookups either way: `toOutput` (`null` strictly inside a
    cut), `toSource` (total — the inverse used for scrubbing), `locateSource` /
    `locateOutput` for the same answers with `insideCut`, `held` and `clamped` attached,
    and `mapRange` for a source range split by cuts.
  - Sample-accurate boundary rules: a cut removes the half-open source range, both its
    edges map to the one output splice, and `toSource` of that splice is the frame after
    the cut. Cuts win every conflict — overlapping and touching cuts merge, speed ranges
    are clipped out of them, holds strictly inside one are dropped — and structurally
    invalid edits raise a typed `TimeMapError` with a stable `code`.
  - Caption helpers: `mapSegment` (a segment whose live words all fall in cuts is
    hidden, partial overlaps are clipped, tombstoned words ignored) and `mapWord`;
    `mapKeyframes`, which drops keyframes inside cuts and pins the curve with an edge
    keyframe at each side of every splice it crosses, optionally interpolated.
  - `fromAcceptedItems(items, {sourceDurationMs, …})` builds a map from accepted `cut`
    pass items and ignores every other kind; `serialize()` / `parseTimeMap()` are a
    versioned JSON fixed point; `snapToFrame`/`frameDurationMs`/`frameAt` work on the
    exact frame grid, and `snapCutsToFrames` puts every cut edge on a boundary.
  - Guarantees proved with fast-check: monotonicity both ways, exact inverse on retained
    source when nothing is retimed (and a stable round trip on both clocks for every
    map), `outputDurationMs === sourceDurationMs − Σcuts + Σholds`, and `mapRange` pieces
    that are ordered, disjoint and cover exactly the retained part of the input range.
  - Pure and browser-safe (no Node-only imports, asserted against the build output);
    CommonJS in `dist/` and ES modules in `dist/esm/` with declarations for both.
    149 tests, 100% lines / 99.6% branches against the CONTRACTS section 9 gate (90/85).
    5,000 cuts on a six-hour source: 100,000 `toOutput` lookups in ~15 ms.
- **A03 — api: Prisma schema v2, hand SQL, migrations, seed, base modules.**
  - `apps/api/prisma/schema.prisma`: 68 models covering every table in
    `03-architecture/06-data-model.md` — identity and tenancy, media and editing
    (EDG v2, including `transcript_chunks`, the six `edg_*` tables, `style_presets`,
    `brand_kits`, `fonts`, `memory_entries`, `comments`, `share_links`,
    `share_reports`), jobs and outputs (with `provider_submissions` and
    `export_manifests`), billing and credits (`mandates`, Rule 46 `invoices`,
    `payments`, `firc_records`, `tax_registrations`, and the four credit tables),
    growth and the content/ops tables. ULID `char(26)` ids, `timestamptz`
    throughout, money as integer minor units beside a currency, credits as integer
    tenths, snake_case columns, and every JSONB column commented with the Zod
    schema that validates it.
  - `apps/api/prisma/sql/`: hand-maintained DDL applied straight after
    `prisma migrate deploy` — the `vector` extension, 31 partial and vector indexes
    (lot consumption order with `NULLS LAST`, retention sweeps, live-session and
    pending-device-code slices, an HNSW cosine index on `audio_assets.embedding`,
    and NULL-safe uniqueness for system style presets), 13 CHECK constraints
    holding the invariants of 06 (no UPI mandate above ₹15,000, no negative credit
    balance or over-consumed lot, a State code on every Indian invoice), and table
    comments recording the retention rules where `\d+` shows them.
  - `pnpm --filter @montaj/api db:migrate` (migrate deploy + idempotent hand SQL,
    tracked in `_montaj_sql_applied`), `db:seed`, `db:reset`, `db:sql`;
    `prisma generate` wired into `postinstall` and `build`; the CONTRACTS section 9
    coverage gate for `apps/api` (75/70).
  - `prisma/seed.ts`: the five plans of `04 §Plans` with INR/USD prices, monthly
    credit grants and entitlements whose operation gating is **derived** from the
    burn-rate table in `@montaj/config`; the system caption styles with their
    parity flags left at the pessimistic defaults only the A18a gate may write;
    four feature flags, all off; an admin user and a demo personal workspace with a
    credit account, lot and ledger row that satisfy invariant 1, and a free-plan
    subscription. Idempotent: every row is keyed on a natural key or a
    deterministic ULID.
  - `apps/api/src/common`: `PrismaService` (eager connect, shutdown hooks,
    `withTransaction`), `RedisService`, pino logging with request-id correlation
    and redaction of secrets and emails (THREAT-MODEL T21), an AsyncLocalStorage
    `RequestContext` carrying `requestId`/`userId`/`workspaceId`, a global
    exception filter producing the CONTRACTS section 8 envelope, a thin Zod
    validation pipe with `zodDto()`, and an OpenTelemetry bootstrap that is a
    genuine no-op when no OTLP endpoint is configured.
  - `GET /health/ready` reports Postgres, Redis and object-store reachability and
    answers 503 when any of them is down; `GET /health` stays dependency-free.
  - 109 tests: unit suites for redaction, request context, error codes, the
    exception filter, the validation pipe, telemetry and the health service; HTTP
    e2e for the error envelope (unknown route and validation failure) with no
    infrastructure; and an integration suite on a testcontainers
    `pgvector/pgvector:pg16` asserting all 68 tables against `information_schema`,
    the named indexes and constraints, seed idempotency, and a segment round trip
    in fractional `seq` order.
- **A02 — `@montaj/edg` v2 and `@montaj/caption-styles` v2 schemas + fixtures.**
  - `@montaj/edg`: Zod schemas and inferred types for the whole EDG v2 document —
    `WordId`, `Word`, `TranscriptChunk`, `TranscriptManifest`, `Segment`, `Pass`,
    `PassItem` (a discriminated union with a typed payload per `kind`), `EdgHot` and
    `EdgProjection` — plus the complete 16-member `EdgOp` union and the
    `OpBatchRequest`/`OpBatchResponse`/`OpConflict` envelopes from CONTRACTS section 2.
  - `@montaj/edg` helpers: a monotonic ULID factory, `makeWordId`/`parseWordId`,
    base-62 fractional ordering for `Segment.seq` (`seqBetween`, proved with
    fast-check), `buildWordIndex`/`wordsBetween` over transcript chunks, and
    `validateProjection` for the document invariants.
  - `@montaj/edg` artefacts: `schemas/edg-v2.json` and `schemas/edg-ops-v2.json`
    generated from the Zod schemas at build time and guarded by an "up to date" test;
    `fixtures/sample-project.json` (90 s, 3-speaker Hinglish, 12 segments, an autocut
    pass with 4 cut items and a reframe pass with 1 zoom item) with its matching
    transcript, validated by Ajv against the generated schema.
  - `@montaj/edg` build: CommonJS in `dist/` and ES modules in `dist/esm/`, each with
    declarations, behind the `.`, `./schemas` and `./seq` subpath exports.
  - `@montaj/caption-styles`: the `StyleDoc` v2 schema (typography, colours, box,
    stroke, shadow, layout, animation, emphasis presets, `minPlan`, CI-written parity
    flags), the D64 naming-rule validator with an admin-extendable deny-list in
    `src/naming/denylist.json`, seven system styles (`punch-pop`, `hype-bold`,
    `vertical-clean`, `karaoke-fill`, `podcast-duo`, `word-pop`,
    `minimal-lower-third`), a 30-style `styles/registry.json` and
    `loadSystemStyles()`, which A03's database seed loads.
  - Coverage gates per CONTRACTS section 9: 90/85 on both packages.

- **A01 — Monorepo scaffold, tooling, CI, docker-compose, env.**
  - pnpm 9 workspaces (`apps/*`, `packages/*`, `plugins/*`, `engine/*`) driven by
    Turborepo 2, with cached `build`, `lint`, `typecheck`, `test`, `test:e2e`,
    `db:migrate` and `db:seed` tasks.
  - `@montaj/config`: strict TypeScript bases (ES2022, NodeNext, React), the shared
    ESLint flat config, the Prettier config and the Vitest preset; `BRAND` per
    CONTRACTS section 0; the credit burn-rate table as typed constants; a Zod schema
    for every variable in CONTRACTS section 1 with a fail-fast `loadEnv()`.
  - Package skeletons with a passing test and a README each: `edg`, `timemap`,
    `caption-styles`, `render-core`, `render-canvaskit`, `render-skia-node`,
    `ass-exporter`, `api-client`, `ui`, `prompts`.
  - `apps/api`: NestJS 11 with `GET /health`, OpenAPI at `/docs` (JSON at
    `/docs-json`), a config module built on `loadEnv()`, an empty Prisma schema plus
    `prisma/sql/` for hand-maintained DDL, and a supertest e2e suite.
  - `apps/web`: Next.js 15 App Router, React 19, Tailwind v4 and shadcn/ui, with a
    placeholder page per route group (`(site)`, `(app)`, `(share)`, `(admin)`), a
    `/health` route handler and a Playwright smoke test on chromium and webkit.
  - `apps/worker-media`: BullMQ worker on `media.probe` with a stub processor and an
    ffmpeg/ffprobe boot check that refuses to start with clear install instructions.
  - `apps/worker-ai`: Python 3.12 project (pip-tools locks, ruff, `mypy --strict`,
    pytest, hypothesis) with a BullMQ worker on `ai.transcribe`, a FastAPI control
    app serving `GET /health`, and the abstract `Provider` interface.
  - `apps/render`: BullMQ worker on `render.video` with a stub processor.
  - README-only placeholders for `apps/desktop`, `apps/bridge`, `plugins/premiere-uxp`,
    `plugins/ae-cep`, `plugins/resolve` and `engine/montaj-engine`.
  - `docker-compose.yml`: Postgres 16, Redis 7 and MinIO with healthchecks, plus a
    one-shot `mc` bootstrap creating `montaj-raw` and `montaj-derived`; and
    `docker-compose.override.example.yml`.
  - `.env.example` covering all 31 CONTRACTS section 1 variables with local defaults.
  - GitHub Actions CI: TypeScript (Node 22), Python (3.12), a Playwright smoke lane
    and a `docker compose config` lane, with a concurrency group.
  - Repo hygiene: `.editorconfig`, `.gitattributes`, `.gitignore`, `.nvmrc`,
    `.node-version`, `CODEOWNERS`, `LICENSE`, the pull-request Definition-of-Done
    template, and `docs/adr/0001-monorepo-tooling.md`.

- **X05 — Infrastructure as code (staging/prod skeleton, no apply).**
  - `infra/terraform`: root modules `envs/staging` and `envs/prod` over nine
    reusable modules — `network` (VPC, three subnet tiers, NAT, S3 gateway
    endpoint, flow logs), `eks` (control plane, managed node groups with an
    optional GPU pool, addons, IRSA, access entries), `rds-postgres16` (PITR,
    KMS-encrypted, `pg_stat_statements` preloaded, `vector` allow-listed for
    A03's pgvector column), `elasticache-redis7` (`maxmemory-policy noeviction`,
    a BullMQ correctness requirement), `s3-raw` (`ap-south-1`, SSE, versioning
    with 7-day non-current expiry, 1-day abort-incomplete-multipart, CORS for
    presigned PUT from `WEB_ORIGIN`), `r2-derived` (bucket, CORS, and a
    multipart-abort rule on the `ws/` root — plan retention is swept by the
    scheduler in B16, not by lifecycle, because CONTRACTS section 6 keys are
    frozen), `secrets` (KMS plus one SSM parameter per
    CONTRACTS section 1 variable), `dns-cdn` (`aksharo.ai`, `app.`, `api.`,
    zone TLS settings, null-MX/SPF/DMARC) and `github-oidc` (keyless deploy
    role). `backend.tf` is a partial S3 backend with native locking; every
    variable is documented; no credential is committed.
  - `infra/gpu`: RunPod serverless endpoint definition with a warm floor of one
    per region and queue-delay autoscaling (decision D15), the model-server
    Dockerfile with large-v3-turbo, forced alignment and pyannote community-1
    pre-baked, a Modal equivalent, and `COST.md` showing the arithmetic behind
    the `05 §12` cost band rather than restating it.
  - `infra/k8s/montaj`: Helm chart for `api`, `web`, `realtime`, `worker-media`,
    `worker-ai`, `render` and `scheduler`, with HPAs on CPU for the
    request-serving components, KEDA ScaledObjects on BullMQ queue depth for the
    workers, PodDisruptionBudgets, default-deny network policies plus an optional
    Cilium FQDN allow-list, external-secrets pulling all 31 contract variables
    from SSM, TLS ingress, resource requests and limits, and
    `values-staging.yaml` / `values-prod.yaml`.
  - `infra/observability`: `METRICS.md` defining the OTel metric contract
    (names, units, labels, cardinality rules); two Grafana dashboards covering
    API latency, queue depth per queue, job success rate, GPU utilisation and
    COGS per credit; and a `PrometheusRule` with 4 recording rules and 24 alerts.
  - `docs/runbooks/`: deploy, rollback, rotate secrets, restore from PITR, scale
    GPU, DLQ replay and a breach first-hour checklist wired to THREAT-MODEL.
  - `.github/workflows/infra.yml`: the `infra-validate` job — `terraform fmt`,
    `terraform validate` against a mock backend for every module and both
    environments, `tflint`, `helm lint`, `kubeconform -strict`,
    `promtool check rules`, plus checks that the SSM map and the chart match
    CONTRACTS section 1 exactly, that the lifecycle rules encode the retention
    contract, that worker egress is denied by default, and that nothing
    credential-shaped is committed.

### Fixed

- **A08c — `RedisRealtimeBus` could not subscribe against a real Redis.** Reported
  by A12. `RedisService` builds its client with `lazyConnect: true` and
  `enableOfflineQueue: false`; `duplicate()` inherits both, so the realtime
  subscriber sat in `wait` and its very first `SUBSCRIBE` was rejected outright
  with `Stream isn't writeable and enableOfflineQueue options is false` rather than
  being queued until the socket opened. Nothing retried it, so every room was
  silently never delivered to — in production only, because the realtime e2e ran
  over `InMemoryRealtimeBus` and the Redis fake reported `ready` from its first
  moment. `RedisRealtimeBus` now connects each client explicitly before issuing a
  command (subscriber _and_ the shared publishing client, which has the same
  problem on an instance whose first Redis traffic is a realtime publish), waits
  for `ready` when another caller is already connecting, and skips an
  `UNSUBSCRIBE` on a connection that never came up.
  - `RealtimeGateway` no longer lets a fan-out failure escape: a room whose
    subscription cannot be established is refused with
    `refused: [{room, reason: "unavailable"}]` and its local membership rolled
    back, and the fire-and-forget frame handler catches instead of turning a
    rejection into a process exit.
  - `apps/api/test/realtime-redis.e2e-spec.ts` runs the real bus, the real
    `RedisService` options and two gateway instances against the compose Redis,
    publishing on one and receiving on the other; the unit suite gained a Redis
    fake with the lazy lifecycle, because the old one was `ready` from the start
    and could never have caught this.

- **A08b — `jobKey` deduplication was scoped globally, not per workspace.** A08's
  `jobs_live_job_key_key` was `UNIQUE (job_key) WHERE status IN
('queued','running')` with no workspace column, so two tenants with the same
  live job key collided and the second enqueue failed with an unexplainable unique
  violation. `prisma/sql/0005-a08b-dlq.sql` replaces it with
  `jobs_live_workspace_job_key_key` on `(workspace_id, job_key)`, and
  `JobsService.enqueue` now handles the unique violation by returning the existing
  job — the `findLiveByKey` read cannot exclude a writer that commits a
  microsecond later, so the index is the actual guarantee.

### Changed

- **A23b — Redis test isolation is a key prefix, not a logical database.**
  - A23a gave every e2e suite a logical Redis database of its own. Redis ships
    with sixteen and `apps/api` now has twenty-two e2e suites, so from the
    seventeenth onwards two suites shared one — and a `KEYS montaj:* / DEL` sweep
    between tests took the sibling's keys with it. A21 watched
    `auth.e2e-spec.ts` lose its dev-outbox messages exactly that way.
  - `apps/api/src/common/redis/redis-keys.ts` (new) exports `redisKeyPrefix()`:
    `MONTAJ_REDIS_PREFIX` when set, `montaj` otherwise. Unset — which is every
    deployment — every key keeps the name it has always had.
  - The five modules that hard-coded `montaj:` now build their namespace from it:
    `authRedisPrefix()` (`auth.constants.ts`, which carries the development mail
    outbox), `rateLimitPrefix()` and the new `rateLimitKey()`
    (`rate-limit.service.ts`), `notifyRedisPrefix()` (the suppression list and the
    delivery receipts), `accountRedisPrefix()` (the data-export bundles) and
    `workspacesRedisPrefix()` (the entitlement cache). `exports/daily-cap.ts`
    wrote `exports:daily-browser-manifests:…` outside the `montaj:` namespace
    altogether; it is prefixed now too. All six are the same shape as
    `queuePrefix()` — a function reading `process.env`, because CONTRACTS section
    1 is the frozen list of _product_ configuration and this is naming.
  - BullMQ structures and realtime pub/sub channels are deliberately NOT moved.
    They are named by `MONTAJ_QUEUE_PREFIX`, which `apps/worker-media`,
    `apps/render` and `apps/worker-ai` have to agree with the API on, and which
    the test harness already sets per suite.
  - `test/suite-context.ts` sets `MONTAJ_REDIS_PREFIX` alongside
    `MONTAJ_QUEUE_PREFIX`, so a suite's keys are its own before its module graph
    is loaded. `auth-harness.reset()` sweeps `${redisKeyPrefix()}:*` rather than
    `montaj:*` — the sweep that used to reach across.
  - Logical databases are now a **second** separator, taken when the run has more
    of them than suites. A logical database named in `TEST_REDIS_URL` is an
    instruction rather than a starting point: `redis://localhost:6379/0` puts the
    whole suite in database 0, which is how this is verified.
  - `test/isolation-probe.ts` grew the proof: both halves pin the SAME logical
    database, write `redisKeys.devOutbox()`, and one of them runs the between-tests
    sweep — the other's key has to survive it. It also writes the product's real
    key builder now rather than a hard-coded literal.

- **A23a — the API test suite starts two containers per run instead of one pair
  per suite, and isolates the suites from each other properly.**
  - Every Docker-backed suite used to start its own PostgreSQL and Redis through
    testcontainers. One run asked Docker for eight containers; a machine running
    several agents at once asked for thirty or forty, and the daemon answered with
    HTTP 500s and `beforeAll` timeouts — failures that had nothing to do with the
    code under test and cost every agent a re-run.
  - `apps/api/test/global-setup.ts` (new, wired in as Vitest's `globalSetup`)
    resolves **one** `pgvector/pgvector:pg16` and **one** `redis:7-alpine` for the
    whole run, or reuses the servers `TEST_DATABASE_URL` / `TEST_REDIS_URL` point
    at and starts nothing. It builds `montaj_test_template` once with
    `prisma migrate deploy` followed by `prisma/sql/` — the same code path
    `pnpm db:migrate` uses — under a PostgreSQL advisory lock, and stamps it with a
    fingerprint of the migrations and the hand SQL, so a second run (or a second
    agent on the same server) reuses it instead of re-migrating.
  - Each suite then gets a database of its own,
    `CREATE DATABASE montaj_t_<runId>_<suite> TEMPLATE montaj_test_template`,
    dropped in `afterAll`. A clone is a file copy, so it costs a fraction of a
    second where a migration run costs twenty — and a suite may now `TRUNCATE` any
    table it likes while a dozen others do the same. A05 and A12 both reported the
    opposite: setting `TEST_DATABASE_URL` made the suites truncate each other.
  - Each suite also gets its own **logical Redis database**, which is what isolates
    the keys the product hard-codes (`montaj:auth:*`, `montaj:rl:*`) with no
    product change, and its own **`MONTAJ_QUEUE_PREFIX`**, which is what isolates
    BullMQ structures and realtime channels — Redis pub/sub ignores the logical
    database, so the prefix is the only isolation there. A run leaves logical
    database 0 alone — a developer's own compose stack lives there — until there
    are more suites than databases above it, and then claims it too rather than
    make two suites share one, saying so on the way past.
  - `apps/api/test/test-run.ts` and `apps/api/test/suite-context.ts` are the new
    contract and the worker-side accessors. Slots are assigned from the sorted list
    of every `*.e2e-spec.ts` in the package rather than the subset being run, so a
    suite keeps the same database name, logical Redis database and queue prefix
    whether it runs alone or with all the others — which is what makes a parallel
    failure reproducible with one `vitest run test/<file>`.
  - **The public harness API did not change.** `createTestDatabase()`,
    `createAuthTestContext()`, `createEdgTestContext()`, `isDatabaseAvailable()`,
    `isRedisAvailable()` and `testRedisUrl()` keep their signatures; no spec was
    edited. The `docker info` probe that gated the skip path still exists, moved
    into the global setup, where it runs once per run instead of once per suite on
    the very daemon the suites were about to overload.
  - `apps/api/test/isolation-alpha.e2e-spec.ts` and `-beta` are the deliberate
    collision test. They rendezvous through the filesystem so their writes really
    do overlap, then insert the same primary key into the same table from both
    sides, truncate that table from one side, and write the same hard-coded Redis
    key from both — each of which fails loudly if the isolation regresses.
    `rendezvous()`'s own timeout (30s) is documented as "not a failure", but every
    `it` calling it now gets an explicit Vitest timeout well above that (40s single
    barrier, 70s for the two sequential Redis barriers) — found stress-testing this
    work package on a machine busy enough that a sibling could still be running:
    Vitest's global 30s `testTimeout` matched `rendezvous()`'s default exactly, so
    it could kill the test itself a hair before the graceful "proves less" path
    got to return, turning "the sibling never arrived" into a hard timeout failure.
  - One PostgreSQL for the run is also one connection budget for the run, so the
    suite database URL pins `connection_limit=3` and both context harnesses reuse
    the client `createTestDatabase()` already opened instead of a second one of
    their own. Prisma sizes a pool at `cpus * 2 + 1` by default — twenty-five on a
    twelve-core laptop — which cost nothing while every suite had a container to
    itself, and sank a dozen concurrent suites against one server's
    `max_connections` of 100 with "Can't reach database server" the moment they
    shared.
  - `DROP DATABASE` forces an immediate checkpoint and waits for it: measured at
    eleven seconds with two suites dropping at once on a laptop already running
    thirty containers. `afterAll` therefore bounds the drop with a
    `statement_timeout` and hands anything slower to the run teardown, which sweeps
    sequentially; a crashed run's databases are swept by the next one. The
    cancellation is safe — PostgreSQL removes the files only after the checkpoint
    it is waiting on.
  - `.github/workflows/ci.yml` gains an `api` job with PostgreSQL and Redis service
    containers and the `TEST_*` URLs pointed at them, so the suite runs with no
    Docker-in-Docker at all; a step asserts that nothing labelled
    `org.testcontainers` was started. `@montaj/api` is excluded from the
    `typescript` job's unit-test step so the suite does not run twice.
  - `apps/api/README.md` §Tests rewritten: how the isolation works, how to point a
    run at the compose stack, how to debug one suite. The `TEST_DATABASE_URL`
    hazard note is gone, because the hazard is.
- **A06 — `WorkspaceMemberGuard` now guards routes with no workspace id in the
  path.** On a `/workspaces/:id` route both of its rules are unchanged; on a route
  without an `:id` — every `/projects/*` route — there is nothing to compare, so it
  performs only its second check (an active membership still exists, and the
  principal's role is re-read from the database). It previously returned `true`
  there, which was correct while only `/workspaces/:id` wore it and would have been
  a silent hole the moment another controller did.
- **A06 — `/jobs` moved onto A04's `JwtAuthGuard` and the interim access-token
  guard is deleted.** `JobsController` now uses `JwtAuthGuard`,
  `@CurrentWorkspace()` and `RolesGuard` (reads are `viewer`, cancel is `editor`),
  and `src/realtime/auth/access-token.guard.ts` is gone. `AccessTokenService`
  stays: a WebSocket handshake is not a Nest route, and the gateway has to verify
  the token itself. A04's verifier pins the `iss` claim to `API_ORIGIN`, which the
  interim guard did not check, so A08's e2e suite mints tokens with it.
- **A06 — schema.** New `folders` table, `projects.folder_id` converted to a real
  foreign key, `media_assets` gains `filename`, `upload_id`, `part_size_bytes`,
  `needs_realign`, `thumb_keys`, `raw_purged_at` and `derived_purged_at`, and
  `MediaRole` gains `subtitle`
  (`prisma/migrations/20260902050000_a06_folders_media_upload`).
- **A25** — `.env.example`, `packages/config/src/env.ts`, the Terraform secrets
  contract and the Helm chart all gained `MAIL_PROVIDER`, `MAIL_FROM` and
  `SMTP_URL`, the three variables CONTRACTS section 1 added after A04, and
  `GPU_PROVIDER_URL` (non-secret) and `GPU_PROVIDER_TOKEN` (secret, human-filled),
  the two it added after A09 — A25 was the next work package to touch all four
  files, so it carried them across rather than leaving the parity check red.
  `MAIL_SNS_TOPIC_ARN` followed after A25's first review.
  `apps/worker-ai/worker_ai/settings.py` mirrors that list and its test enforces
  the mirror, so the six names were added there too and the GPU pair moved out
  of `WORKER_ENV_VARS`: they are product configuration now, not deployment
  naming. `infra/scripts/check-contracts-parity.py` reports 38/38 on both sides.
  `loadEnv()` also gained a cross-field check (`crossFieldProblems`): `ses` and
  `smtp` require `MAIL_FROM`, and `smtp` requires `SMTP_URL`. It lives beside the
  schema rather than inside it because a `.superRefine()` would remove
  `envSchema.shape`, which the contract test walks.
- **A25** — `REALTIME_EVENTS` gained `notification.created`, now also named in
  CONTRACTS section 7.
- **A25** — `UsersService.findByEmail` selects `locale`. It is the only lookup the
  auth flows do before sending a message, and A25 renders that message in the
  recipient's language; the alternative was a second query on the sign-in path.

- **A02b** — `OpRejectionReasonSchema` gained `invalid-range`, `not-contiguous`,
  `invariant`, `rebased-away` and `stale-after-resegment`. The reason list is a
  closed enum that the ops engine was always meant to extend rather than send free
  text (A02 said so in `packages/edg/README.md`); `schemas/edg-ops-v2.json` is
  regenerated to match. `EdgSourceSchema` was lifted out of `EdgOpsEventSchema` so
  the engine can name the writer that submitted a batch — the same six values,
  now a `$def`.
- **A03** — `docker-compose.yml` now runs `pgvector/pgvector:pg16` instead of
  `postgres:16`. `audio_assets.embedding` is a `vector(512)` column, so stock
  Postgres cannot apply the first migration. Managed Postgres needs `vector` on
  its extension allow-list (X05).
- **A03** — `@typescript-eslint/consistent-type-imports` is off for
  `apps/api/src/**`. A constructor parameter's type is the DI token NestJS resolves
  from `design:paramtypes`, and `import type` erases it to `Object`, so the
  provider fails to resolve at runtime while the code still type-checks.

[Unreleased]: https://github.com/aksharo/montaj/compare/main...HEAD
