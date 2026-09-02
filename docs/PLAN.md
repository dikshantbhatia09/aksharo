# PLAN.md — Montaj build orchestration (maintained by Fable 5.1)

Codename in code: `montaj` (package scope `@montaj/*`). Brand strings live only in `packages/config/src/brand.ts` so a rename after the legal review touches one file plus domains.

Roles: **Fable 5.1** designs, decides, writes briefs, verifies gates. **Opus 5 agents** write code from briefs. **Dikshant** owns [H] human items and gates that need real machines, accounts or professionals.

## Model roles
Fable 5.1 orchestrates, designs and decides; coding agents implement briefs. Coding agents ran on Opus 5 until 2026-09-02, when the Opus session limit terminated seven running agents; per the user's instruction the same day, coding agents run on **Sonnet 5** from then on (the "Agent" column in the Wave 1 table is historical).

## Status legend
`todo` · `briefed` · `in-progress` · `review` · `done` · `blocked(<reason>)`

## Wave 0 — Procurement & spikes (human; runs alongside Wave 1)
| WP | Item | Owner | Status | Blocks |
|---|---|---|---|---|
| A00-01 | Apple Developer org (D-U-N-S) + Developer ID; Windows OV cert via cloud-HSM CA | Dikshant | todo | C00, C10 |
| A00-02 | Razorpay account, international activation, Autopay/eNACH quotes, RazorpayX | Dikshant | todo | B01, B07 |
| A00-03 | UXP capability spike on real Premiere 26.x (see 10-build-plan) | Dikshant + Fable | todo | C05a, C06 |
| A00-04 | Resolve Free ≥ 19.1 script spike | Dikshant + Fable | todo | C08 |
| A00-05 | Hinglish + Indic eval sets (labelling vendor) | Dikshant | todo | D08, routing freeze |
| A00-06 | ASR/LLM DPAs (Sarvam, ElevenLabs, AssemblyAI, Anthropic/OpenAI); Bhashini enquiry | Dikshant | todo | A10 in production |
| A00-07 | Tier 0 audio pack commission (copyright assignment) | Dikshant | todo | D04a |
| A00-08 | GST registration + LUT; CA engagement | Dikshant | todo | B05, B07 |
| A00-09 | Legal entity/jurisdiction; ToS/Privacy/Refund/ASCI drafts (after RR-08) | Dikshant + counsel | todo | B16, launch |
| A00-10 | whisper.cpp word-timestamp spike vs cloud aligner | Fable + agent | todo | C03a |
| A00-11 | Music partner enquiries (Epidemic Partner API, Soundstripe, Storyblocks) | Dikshant | todo | D04b |
| A00-12 | Brand: approve/veto "Aksharo"; register aksharo.ai + aksharo.in (+ getaksharo.com); paid clearance search; file Class 9 + 42 in India; YouTube/Instagram handles | Dikshant + counsel | todo | any brand spend, A24 |
| A00-13 | Legal documents: standalone privacy notice (DPDP Rule 3 shape), ToS, AUP, refunds, DPA + sub-processor list, grievance officer, breach runbook + templates | Dikshant + counsel | todo | B16, F-504, launch |

## Wave 1 — Foundations
| WP | Title | Deps | Agent | Status |
|---|---|---|---|---|
| A01 | Monorepo scaffold, tooling, CI, docker-compose, env | — | Opus | done |
| A02 | `@montaj/edg` v2 + `@montaj/caption-styles` v2 schemas + fixtures | A01 | Opus | done (A02b/c/d merged: SetWordTiming op + timeline word-edge drag) |
| A02b | EDG ops engine (rebase table, CAS, snapshots, migrations, property tests) | A02 | Opus | done |
| A02c | `@montaj/timemap` | A02 | Opus | done |
| A02d | `SetWordTiming` op end to end: EDG engine + rebase rule, API passthrough, client inverse op, timeline word-edge drag (A17 finding; CONTRACTS §2 amended) | A02b, A12, A17 | Sonnet | in-progress |
| A03 | api: Prisma schema v2 + hand SQL, migrations, seed, base modules | A01 | Opus | done |
| A03b | api: seed loader injection, `registry.json` exclusion, `edg_segments.seq` → `text COLLATE "C"` migration (A02/A03 reconciliation) | A02, A03 | Opus | done |
| A03c | api: `PassStatus` enum `succeeded` → `ready` migration (package is source of truth) | A02b, A03b | Opus | done |
| X05 | infra: Terraform, staging env, dashboards | A01 | Opus | done |
| X06 | Threat model → checklist (docs/THREAT-MODEL.md) | — | Fable | done |
| A04 | api: auth (families, device code, token exchange) | A03, X06 | Opus | done |
| A05 | api: users, workspaces (tax profile), memberships | A04 | Opus | done |
| A06 | api: projects + media (S3 raw, R2 derived) | A05 | Opus | done |
| A07 | worker-media: probe, 16k/48k audio, proxy, waveform, thumbs | A03, A06 | Opus | done (A07 + A07b merged: media.proxy completion handler with failure hook; export dialog automatable) |
| A08 | api: jobs, WS gateway, idempotent completion, CreditsFacade (no-op), admission control | A03 | Opus | done |
| A08b | DLQ + admin replay | A08 | Opus | done |
| A08c | api: Redis realtime bus connects lazily-created clients before subscribe/publish; gateway join rollback; real-Redis two-instance e2e (defect found by A12) | A08, A12 | Opus | done |
| A09 | worker-ai skeleton (BullMQ Python, mock provider, serverless Whisper adapter, VAD, alignment registry) | A08 | Opus | done |

Sub-wave order: A01 → {A02, A02b, A02c, A03, X05} → {A04–A08, A08b, A09}.

## Wave 2 — Core loop (all briefs ready in `05-build/_orchestration/`)
| WP | Title | Deps | Status |
|---|---|---|---|
| A10 | worker-ai vendor adapters, LID, routing, alignment registry, diarisation | A09 | done |
| A11 | api transcripts, post-processing, segmentation → EDG init | A02b, A08, A09 | done |
| A12 | api EDG module (ops, rebase, CAS, revisions, realtime) | A02b, A08 | done |
| A13 | web shell + `@montaj/ui` + auth pages + onboarding + settings | A04, A05 | done |
| A14 | web Home + Projects + upload engine | A06, A08, A13 | done |
| A15 | web Editor transcript column + EDG client store | A12, A13 | done (A15c merged: 27.9 fps on main vs ≥55 target — A15d profiling with a real trace after Gate A) |
| A16 | render-core + render-canvaskit + 30 styles + panels | A02, A02c | done |
| A17 | web Timeline | A15, A16 | done (word retiming → A02d; perf → A15c) |
| A18a | ass-exporter + parity gate | A16, A20 | done (A18a-c seed parity test aligned with D33) |
| A18b | fonts pipeline | A06, A07 | done |
| A19 | web browser export + export dialog | A16, A21, A02c | done (A19b + A19c merged: sources, readPixels, WebGL export surface, HW-encoder probe, cloud default ≥1080p, splice fades, onboarding preset; 0.15× realtime headless — H-19 real-machine measurement; A19d: add a 1080p 16:9 render preset) |
| A20 | render service (Skia-Node + ffmpeg) + subtitle sidecars | A16, A08, A02c | done |
| A21 | api exports module (manifests, cloud jobs) | A08, A20 | done (A21b merged: manifest sources + refresh, codec/audio eligibility, HDR cloud-only) |
| A22 | scripts + translation | A10, A11, A12 | done |
| A23 | e2e suite, seed sample, verify-wave script, X02 load harness | A13–A21 | done (merged: Gate A journey e2e both browsers, sample seed, verify-wave script, X02 harness (p95 FAIL on shared host, re-measure at Gate A); A23b harness deadlock + verify-wave run, A07b media.proxy handler) |
| A23a | api test isolation: one Postgres + one Redis container per vitest run (or `TEST_*` URLs), database per suite from a migrated template, Redis prefix per suite; CI service containers | A05, A12, A25 | done |
| A24 | marketing site v1 | A16 | done |
| A25 | notify consumer: transactional email (SES via IRSA / SMTP / dev outbox), templates en+hi, suppression, in-app notifications | A04, A08 | done |
| A26 | GPU model server `apps/model-server` (/transcribe, /align, /diarise, /detect-language; batching; RunPod + Modal packaging replacing X05 placeholders) | A10, X05 | done |
Sub-wave order: {A10, A11, A12, A13, A16, A18b, A20, A25, A26} → {A14, A15, A21, A22, A24} → {A17, A18a, A19} → {A23 + Gate A}.

## Wave 3 — Monetisation (all briefs ready in `05-build/_orchestration/`)
| WP | Title | Deps | Status |
|---|---|---|---|
| B01 | api billing core: `BillingProvider`, Razorpay subscriptions/orders, mandate cap + ₹15,000 UPI rule, half-yearly Studio, idempotent webhooks, dunning primitives | A03, A08 | done |
| B02 | api credits: lots, atomic conditional reserve, holds/settle/release/reversal, grants/expiry, entitlements engine, real `CreditsFacade`, concurrency property test | A03, A08 | done |
| B03 | web Subscription pages (overview, plans, methods/mandates, invoices, usage), checkout sheet with tax-profile step, `UpgradeGate` | B01, B02, B05, A13 | done |
| B04 | Offers: signup-gift export, ₹9 clean export, ₹59 week pass, pay-once, ₹149 Free top-up; export-dialog upsell | B01, B02, A21 | done (B04b/c merged: upsell demo session bootstrap; webhook PassPurchase lookup scoped to unconsumed rows) |
| B05 | api invoices (Rule 46, series, credit notes, export under LUT, PDF + signature, IRN hook) + tax engine + FIRC records | B01 | done |
| B06 | Streak experiment engine (holdout flag, freezes, pause-not-reset, rewards) + widget | B01, B02, A21 | done (B06/B06b merged: plan-derived creditsOnly, GET /streak null fix; streak chip e2e failing on main → M02) |
| B07 | Affiliate v2: apply with PAN, 60-day cookie + code attribution, rate tiers, TDS accumulator, RazorpayX payouts, dashboard | B01, B02, B05 | done (merged; TDS section pending H-18; RazorpayX unverified pending H-15) |
| B07b | Give-get referral loop (30/30 credits on first export, caps, abuse rules, prompt) | B02, A21 | done |
| B08 | Team/Agency workspaces, seat billing, pooled credits, client tags, devices/leases, licence keys | B01, B02, A05 | done (B08 + B08b merged/merging: teams, devices/leases, licence keys, per-device bridge tokens keyed by deviceId) |
| B09 | Memory & glossary (opt-in): spelling/timing/style entries, provider hints, matcher, settings page | A11, A15, A17 | done (B09 + B09b merged: hooks wired at timeline sink, editor spelling fix, transcribe hints) |
| B16 | Scheduler tasks (retention, renewals/dunning, grants/expiry, commissions, provider deletions), audit completion, privacy module (erasure cascade, DSR, export, breach, access logs) | B01, B02, B07 | done (merged: 12 scheduler tasks, erasure cascade with DMMF residue check, audit-completeness contract test found 4 gaps, access logs; D81 recorded) |
| B17 | Onboarding completion (defaults, language hints, source + code), sample project, coach marks, attribution events, Hindi strings | A13, B07, B07b | done (merged: step 4, MAKE_DEFAULTS, coach marks, product_events + /admin/metrics/acquisition, code classifier; defaultExportPreset consumed by A19c) |
Sub-wave order: {B01, B02, B05, B09} → {B03, B04, B06, B07, B07b, B08} → {B16, B17} → Gate B preparation (Wave 4 finishes Gate B).

## Wave 4 — Growth, passes, plugin foundations (all briefs ready in `05-build/_orchestration/`)
| WP | Title | Deps | Status |
|---|---|---|---|
| B10 | Audio clean: 48 kHz deep-filter path, loudness targets, A/B preview, applied in browser + cloud exports | A09, A20, A19 | done pending merge (B10 + B10b: Quick clean chain, SetAudio.cleanId, Audio tab + op queue, D82 tier toggle, audio parity block, bounded-window DSP < 2 GB RSS) |
| B11 | LLM features (chapters, summary, hooks) + `packages/prompts` registry, region pinning, evals, Insights tab | A11, B02 | done (B11/B11b merged: per-kind burn rates in config, one lexicon loader, EDG-segment insights payload) |
| B12 | Academy tracks + rewards, Changelog + What's new, Help centre, support tickets with diagnostics | A13, B02 | done (merged + verified: 4 academy tracks with exactly-once rewards, 10 help articles, /updates changelog + What's new + RSS, support tickets; academy lot source + academy-help Playwright → M03) |
| B13 | Admin console: roles + step-up, users/credits/refunds, flags, styles/parity, routing weights, jobs/DLQ, mandates, TDS, affiliate review, DSR/breach, share reports, metrics | B01–B12, B16 | done pending merge (158b118: roles + TOTP step-up + AdminGuard(role), users/credits/refunds policy, flags/styles/routing overrides, jobs/dunning/TDS/affiliate review/share reports, (admin) shell + dashboard; B13b follow-ups) |
| B14 | Public API v1 + scoped API keys + signed webhooks + SSRF-guarded URL import + developer docs | B02, A21, A06 | done (B14 + B14b merged: keys, /v1, idempotency, SSRF ingest, signed webhooks with real event emits + fixture-server e2e, Developers docs) |
| B15 | Share/review links (view/comment/approve, hygiene), comments, batch, replace media (re-align), import transcript & align | A12, A21, A10, B08 | in-progress (API half merged: share links scope ladder/password/expiry/view cap/auto-disable, comments, batch; web viewer + replace-media re-align + import-align running on wp/B15) |
| B18 | Autocut pass (silences, filler lexicons, retakes, protection, pacing) → pass items | A10, A11, A02c | done (B18 + B18b merged: autocut pass, protected ranges op + timeline protect + passes payload) |
| B19 | Reframe & zoom pass (scene detection, subject tracking, cues, packed keyframes) | A07, A11, B18 | done (B19 + B19b merging: single MKF2 codec, zoom PassType, inline/ref keyframe storage, proxy frame + RMS sampling, word-timed cues; 30-min pass 2.4 min after two perf fixes; H-22 weights) |
| B20 | Proposal review UI + exports apply cuts/zooms via `timemap` (browser + cloud) + parity fixtures | A17, A19, A20, B18, B19 | done (merged: shared crop-window curve for browser + ffmpeg, Passes tab/ProposalCard/bulk accept, split lanes, output-length test, crop parity; B20b after B19b) |
| C00 | Signing & release pipeline (notarytool + 24 h buffer, cloud-HSM Windows signing, `.ccx`, ZXP, Resolve bundle, channels, SBOM); dry-run until A00-03 | A01 | done (merged: dry-run release CLI + workflows, fail-closed signed mode, 24 h notarisation gate, SBOM/checksums/feeds; release secrets in tools/release/.env.example; H-23) |
| C01 | Local bridge v2: `bridge-core` + Node SEA app, relay-first WSS, loopback HTTPS + per-install cert, pairing, 12 h pair tokens, api relay module | A04, A08, B08 | done (C01 + C01b + B08b merged: bridge-core protocol, loopback TLS + relay, per-install cert in keychain/DPAPI with file fallback, flagged native tray (off), per-device bridge tokens) |
| C02 | Desktop shell: Electron loading the hosted web app (decision D71), deep links, updater with channels, tray, embedded bridge, hardened defaults | A13, C00, C01 | done (C02 merged; C02b running: real bridge adapter wiring, pairing approval UX, Electron e2e in the release workflow) |
Sub-wave order: {B10, B11, B18, C00} → {B12, B14, B15, B19, C01} → {B13, B20, C02} → **Gate B**.

## Wave 5 — Plugins
C05a, C06, C06b, C08, C08b, C10, C11, C12, D08.

| ID | Package | Deps | Status |
|---|---|---|---|
| C11 | Plugin licensing & devices UI (activation limits, revoke, offline lease, activation card) | B08, B08b, C01 | running |
| C12 | Desktop/plugin telemetry (consent), crash reporting, diagnostics bundle | C02, A05, B12, B16 | running |
| C05a | Premiere UXP plugin foundation over a mocked host adapter (Gate C runs it on a real machine) | C01, C00, A00-03 | running |
| C08 | Resolve `aksharo_core` over a FakeResolve adapter | C01, A00-04 | done pending merge (a109dfc; DynamicZoom property keys flagged for Gate C) |
| C08b | Fusion Text+ macro generator + style coverage report | C08 | briefed |
| C10 | Installers (NSIS/pkg/Resolve/.ccx), `/plugins/manifest`, plugins + download pages | C00, C02, C05a, C08 | briefed |
| D08 | Eval harness & quality gates on fixture datasets, shadow routing, routing freeze, admin leaderboard | A10, B13, B16 | briefed |
| C06, C06b, C08b | Premiere apply modes, MOGRT authoring, Text+ macro | C05a / C08 | to brief after C05a/C08 land |

## Wave 6 — AE, local engine, library
C05b, C03a, C03b, C04, D04a, D05, D06, D09, X01. **Gate C** (human, real machines).

## Wave 7 — Remaining
D04b (contract-gated), D07, C09, X03, X04, X08 (Cilium FQDN egress adoption for prod — chart variant exists from X05; prod-hardening item before Gate C), X07 hardening also includes: split `packages/api-client`'s hand-written `endpoints/hooks/index/query-keys/types` into per-module files with a generated barrel (three WPs in a row — A22, A14, B04 — conflicted on those five files; B07 found a second latent defect there: Nest controllers returning bare `null` send an empty body which `readJson` turns into `undefined` — `GET /billing/subscription` still does this; wrap nullable responses in an object), D81 schema migration (invoice/ledger/commission foreign keys to workspaces → Restrict; workspaces soft-delete only), the web e2e fixture's hard-coded `montaj:auth:dev-outbox` key (A23 addendum), and under D08: extend A22's rule-table transliteration (Hindi + Tamil today) to the remaining AI4Bharat languages as table data once A00-05 eval sets exist. **Gate D**.

## Gate log
- **2026-09-02 — Wave 1 interim gate (A01, A02, A02b, A02c, A03, A03b, A03c, A04, A05, A08, A08b, A09, X05) PASSED** from a fresh clone at `cf18498`: frozen install, build 15/15, migrations + 5 SQL guard files on a new database, seed (5 plans, 7 system styles from the package, 4 flags), tests — api 673, edg 253, timemap 149, caption-styles 34, worker-ai 321 (+5 skipped), web Playwright smoke 10. A06 and A07 remain; the final Wave 1 gate re-runs after they merge.

- **2026-09-02 — Wave 1 FINAL gate PASSED** from a fresh clone at `693d22b` (all Wave 1 packages incl. A06, A07, A08c, A23a, plus early Wave 2 merges A10–A12, A16, A18b, A20, A25, A26): frozen install, build 17/17, 8 migrations + SQL guards on a new database, seed (5 plans, 30 system styles from the package, 4 flags); tests — api **93 files / 1,261 tests** against the compose stack with 0 containers started (A23a path), worker-media 165 (real ffmpeg), edg 256, timemap 149, render-core 464, render-canvaskit 30, render-skia-node 94, render 210, render-manifest 44, fonts 150, caption-styles 39, web 51 + Playwright 14 (both browsers), worker-ai 523 (+13 skipped), model-server 196 (+6 skipped); lint, typecheck, format check clean. `apps/worker-media` Docker image (`turbo prune` multi-stage, Debian trixie ffmpeg) built successfully once Docker Desktop recovered from the orphaned-container storm (38 leftover test containers removed first); gate complete. Lesson recorded: clean `org.testcontainers=true` containers before gating.

## Gate definitions
- **Gate A:** new user captions a Hinglish sample end to end in the browser; cloud render works; parity gate green; X02 passes.
- **Gate B:** Razorpay test payment with mandate; credits reserved/settled/reconciled; Rule 46 invoice PDF; affiliate attributed by code and cookie; referral credits; autocut + zoom reviewed and exported in sync.
- **Gate C (human):** clean Windows + macOS installs; Premiere UXP sign-in, transcript injection, MOGRT captions; Resolve Free script captions; signed/notarised artefacts.
- **Gate D:** 20-minute gaming clip to reviewed export with cuts, zooms, SFX, captions in < 10 min user time; eval thresholds met.

## Verification gate procedure (every wave)
Fresh clone → `pnpm i` → `docker compose up -d` → `pnpm db:migrate && pnpm db:seed` → `pnpm test` → Playwright smoke → parity gate → screenshot review → update this file.
