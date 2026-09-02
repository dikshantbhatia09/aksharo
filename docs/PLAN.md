# PLAN.md — Montaj build orchestration (maintained by Fable 5.1)

Codename in code: `montaj` (package scope `@montaj/*`). Brand strings live only in `packages/config/src/brand.ts` so a rename after the legal review touches one file plus domains.

Roles: **Fable 5.1** designs, decides, writes briefs, verifies gates. **Opus 5 agents** write code from briefs. **Dikshant** owns [H] human items and gates that need real machines, accounts or professionals.

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
| A02 | `@montaj/edg` v2 + `@montaj/caption-styles` v2 schemas + fixtures | A01 | Opus | done |
| A02b | EDG ops engine (rebase table, CAS, snapshots, migrations, property tests) | A02 | Opus | done |
| A02c | `@montaj/timemap` | A02 | Opus | done |
| A03 | api: Prisma schema v2 + hand SQL, migrations, seed, base modules | A01 | Opus | done |
| A03b | api: seed loader injection, `registry.json` exclusion, `edg_segments.seq` → `text COLLATE "C"` migration (A02/A03 reconciliation) | A02, A03 | Opus | done |
| A03c | api: `PassStatus` enum `succeeded` → `ready` migration (package is source of truth) | A02b, A03b | Opus | done |
| X05 | infra: Terraform, staging env, dashboards | A01 | Opus | done |
| X06 | Threat model → checklist (docs/THREAT-MODEL.md) | — | Fable | done |
| A04 | api: auth (families, device code, token exchange) | A03, X06 | Opus | done |
| A05 | api: users, workspaces (tax profile), memberships | A04 | Opus | done |
| A06 | api: projects + media (S3 raw, R2 derived) | A05 | Opus | in-progress |
| A07 | worker-media: probe, 16k/48k audio, proxy, waveform, thumbs | A03, A06 | Opus | briefed |
| A08 | api: jobs, WS gateway, idempotent completion, CreditsFacade (no-op), admission control | A03 | Opus | done |
| A08b | DLQ + admin replay | A08 | Opus | done |
| A09 | worker-ai skeleton (BullMQ Python, mock provider, serverless Whisper adapter, VAD, alignment registry) | A08 | Opus | done |

Sub-wave order: A01 → {A02, A02b, A02c, A03, X05} → {A04–A08, A08b, A09}.

## Wave 2 — Core loop (all briefs ready in `05-build/_orchestration/`)
| WP | Title | Deps | Status |
|---|---|---|---|
| A10 | worker-ai vendor adapters, LID, routing, alignment registry, diarisation | A09 | in-progress |
| A11 | api transcripts, post-processing, segmentation → EDG init | A02b, A08, A09 | in-progress |
| A12 | api EDG module (ops, rebase, CAS, revisions, realtime) | A02b, A08 | done |
| A13 | web shell + `@montaj/ui` + auth pages + onboarding + settings | A04, A05 | in-progress |
| A14 | web Home + Projects + upload engine | A06, A08, A13 | briefed |
| A15 | web Editor transcript column + EDG client store | A12, A13 | briefed |
| A16 | render-core + render-canvaskit + 30 styles + panels | A02, A02c | done |
| A17 | web Timeline | A15, A16 | briefed |
| A18a | ass-exporter + parity gate | A16, A20 | briefed |
| A18b | fonts pipeline | A06, A07 | briefed |
| A19 | web browser export + export dialog | A16, A21, A02c | briefed |
| A20 | render service (Skia-Node + ffmpeg) + subtitle sidecars | A16, A08, A02c | in-progress |
| A21 | api exports module (manifests, cloud jobs) | A08, A20 | briefed |
| A22 | scripts + translation | A10, A11, A12 | briefed |
| A23 | e2e suite, seed sample, verify-wave script, X02 load harness | A13–A21 | briefed |
| A24 | marketing site v1 | A16 | briefed |
| A25 | notify consumer: transactional email (SES via IRSA / SMTP / dev outbox), templates en+hi, suppression, in-app notifications | A04, A08 | done |
Sub-wave order: {A10, A11, A12, A13, A16, A18b, A20, A25} → {A14, A15, A21, A22, A24} → {A17, A18a, A19} → {A23 + Gate A}.

## Wave 3 — Monetisation (all briefs ready in `05-build/_orchestration/`)
| WP | Title | Deps | Status |
|---|---|---|---|
| B01 | api billing core: `BillingProvider`, Razorpay subscriptions/orders, mandate cap + ₹15,000 UPI rule, half-yearly Studio, idempotent webhooks, dunning primitives | A03, A08 | briefed |
| B02 | api credits: lots, atomic conditional reserve, holds/settle/release/reversal, grants/expiry, entitlements engine, real `CreditsFacade`, concurrency property test | A03, A08 | briefed |
| B03 | web Subscription pages (overview, plans, methods/mandates, invoices, usage), checkout sheet with tax-profile step, `UpgradeGate` | B01, B02, B05, A13 | briefed |
| B04 | Offers: signup-gift export, ₹9 clean export, ₹59 week pass, pay-once, ₹149 Free top-up; export-dialog upsell | B01, B02, A21 | briefed |
| B05 | api invoices (Rule 46, series, credit notes, export under LUT, PDF + signature, IRN hook) + tax engine + FIRC records | B01 | briefed |
| B06 | Streak experiment engine (holdout flag, freezes, pause-not-reset, rewards) + widget | B01, B02, A21 | briefed |
| B07 | Affiliate v2: apply with PAN, 60-day cookie + code attribution, rate tiers, TDS accumulator, RazorpayX payouts, dashboard | B01, B02, B05 | briefed |
| B07b | Give-get referral loop (30/30 credits on first export, caps, abuse rules, prompt) | B02, A21 | briefed |
| B08 | Team/Agency workspaces, seat billing, pooled credits, client tags, devices/leases, licence keys | B01, B02, A05 | briefed |
| B09 | Memory & glossary (opt-in): spelling/timing/style entries, provider hints, matcher, settings page | A11, A15, A17 | briefed |
| B16 | Scheduler tasks (retention, renewals/dunning, grants/expiry, commissions, provider deletions), audit completion, privacy module (erasure cascade, DSR, export, breach, access logs) | B01, B02, B07 | briefed |
| B17 | Onboarding completion (defaults, language hints, source + code), sample project, coach marks, attribution events, Hindi strings | A13, B07, B07b | briefed |
Sub-wave order: {B01, B02, B05, B09} → {B03, B04, B06, B07, B07b, B08} → {B16, B17} → Gate B preparation (Wave 4 finishes Gate B).

## Wave 4 — Growth, passes, plugin foundations (all briefs ready in `05-build/_orchestration/`)
| WP | Title | Deps | Status |
|---|---|---|---|
| B10 | Audio clean: 48 kHz deep-filter path, loudness targets, A/B preview, applied in browser + cloud exports | A09, A20, A19 | briefed |
| B11 | LLM features (chapters, summary, hooks) + `packages/prompts` registry, region pinning, evals, Insights tab | A11, B02 | briefed |
| B12 | Academy tracks + rewards, Changelog + What's new, Help centre, support tickets with diagnostics | A13, B02 | briefed |
| B13 | Admin console: roles + step-up, users/credits/refunds, flags, styles/parity, routing weights, jobs/DLQ, mandates, TDS, affiliate review, DSR/breach, share reports, metrics | B01–B12, B16 | briefed |
| B14 | Public API v1 + scoped API keys + signed webhooks + SSRF-guarded URL import + developer docs | B02, A21, A06 | briefed |
| B15 | Share/review links (view/comment/approve, hygiene), comments, batch, replace media (re-align), import transcript & align | A12, A21, A10, B08 | briefed |
| B18 | Autocut pass (silences, filler lexicons, retakes, protection, pacing) → pass items | A10, A11, A02c | briefed |
| B19 | Reframe & zoom pass (scene detection, subject tracking, cues, packed keyframes) | A07, A11, B18 | briefed |
| B20 | Proposal review UI + exports apply cuts/zooms via `timemap` (browser + cloud) + parity fixtures | A17, A19, A20, B18, B19 | briefed |
| C00 | Signing & release pipeline (notarytool + 24 h buffer, cloud-HSM Windows signing, `.ccx`, ZXP, Resolve bundle, channels, SBOM); dry-run until A00-03 | A01 | briefed |
| C01 | Local bridge v2: `bridge-core` + Node SEA app, relay-first WSS, loopback HTTPS + per-install cert, pairing, 12 h pair tokens, api relay module | A04, A08, B08 | briefed |
| C02 | Desktop shell: Electron loading the hosted web app (decision D71), deep links, updater with channels, tray, embedded bridge, hardened defaults | A13, C00, C01 | briefed |
Sub-wave order: {B10, B11, B18, C00} → {B12, B14, B15, B19, C01} → {B13, B20, C02} → **Gate B**.

## Wave 5 — Plugins
C05a, C06, C06b, C08, C08b, C10, C11, C12, D08.

## Wave 6 — AE, local engine, library
C05b, C03a, C03b, C04, D04a, D05, D06, D09, X01. **Gate C** (human, real machines).

## Wave 7 — Remaining
D04b (contract-gated), D07, C09, X03, X04, X08 (Cilium FQDN egress adoption for prod — chart variant exists from X05; prod-hardening item before Gate C). **Gate D**.

## Gate log
- **2026-09-02 — Wave 1 interim gate (A01, A02, A02b, A02c, A03, A03b, A03c, A04, A05, A08, A08b, A09, X05) PASSED** from a fresh clone at `cf18498`: frozen install, build 15/15, migrations + 5 SQL guard files on a new database, seed (5 plans, 7 system styles from the package, 4 flags), tests — api 673, edg 253, timemap 149, caption-styles 34, worker-ai 321 (+5 skipped), web Playwright smoke 10. A06 and A07 remain; the final Wave 1 gate re-runs after they merge.

## Gate definitions
- **Gate A:** new user captions a Hinglish sample end to end in the browser; cloud render works; parity gate green; X02 passes.
- **Gate B:** Razorpay test payment with mandate; credits reserved/settled/reconciled; Rule 46 invoice PDF; affiliate attributed by code and cookie; referral credits; autocut + zoom reviewed and exported in sync.
- **Gate C (human):** clean Windows + macOS installs; Premiere UXP sign-in, transcript injection, MOGRT captions; Resolve Free script captions; signed/notarised artefacts.
- **Gate D:** 20-minute gaming clip to reviewed export with cuts, zooms, SFX, captions in < 10 min user time; eval thresholds met.

## Verification gate procedure (every wave)
Fresh clone → `pnpm i` → `docker compose up -d` → `pnpm db:migrate && pnpm db:seed` → `pnpm test` → Playwright smoke → parity gate → screenshot review → update this file.
