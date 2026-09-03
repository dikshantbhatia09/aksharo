# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries are grouped by work package id (see `docs/PLAN.md`).

## [Unreleased]

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

- C09: DaVinci Resolve Studio Workflow Integration panel (`plugins/resolve-panel`) — docked React shell over `aksharo_core`'s loopback server (discover → bearer → JSON-RPC), `WorkflowIntegrationHost` adapter + mock, sign-in mirrored from the script, timeline picker, "Caption this timeline", passes review + "Apply in Resolve", version/update banner; C08 loopback server gains `session.status`, `transcribe.start`, `passes.list` (`plugins/resolve/aksharo_core_app/session.py|transcribe.py|passes.py`) plus a `?token=` query-param bearer path for browser `WebSocket` callers; `tools/release`'s `package-resolve` now also stages the panel bundle for Studio installs.

### Added

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
