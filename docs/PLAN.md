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
| A01 | Monorepo scaffold, tooling, CI, docker-compose, env | — | Opus | in-progress |
| A02 | `@montaj/edg` v2 + `@montaj/caption-styles` v2 schemas + fixtures | A01 | Opus | briefed |
| A02b | EDG ops engine (rebase table, CAS, snapshots, migrations, property tests) | A02 | Opus | briefed |
| A02c | `@montaj/timemap` | A02 | Opus | briefed |
| A03 | api: Prisma schema v2 + hand SQL, migrations, seed, base modules | A01 | Opus | briefed |
| X05 | infra: Terraform, staging env, dashboards | A01 | Opus | briefed |
| X06 | Threat model → checklist (docs/THREAT-MODEL.md) | — | Fable | done |
| A04 | api: auth (families, device code, token exchange) | A03, X06 | Opus | briefed |
| A05 | api: users, workspaces (tax profile), memberships | A04 | Opus | briefed |
| A06 | api: projects + media (S3 raw, R2 derived) | A05 | Opus | briefed |
| A07 | worker-media: probe, 16k/48k audio, proxy, waveform, thumbs | A03, A06 | Opus | briefed |
| A08 | api: jobs, WS gateway, idempotent completion, CreditsFacade (no-op), admission control | A03 | Opus | briefed |
| A08b | DLQ + admin replay | A08 | Opus | briefed |
| A09 | worker-ai skeleton (BullMQ Python, mock provider, serverless Whisper adapter, VAD, alignment registry) | A08 | Opus | briefed |

Sub-wave order: A01 → {A02, A02b, A02c, A03, X05} → {A04–A08, A08b, A09}.

## Wave 2 — Core loop
A10, A11, A12, A13, A14, A15, A16, A17, A18a, A18b, A19, A20, A21, A22, A23, A24 (see 10-build-plan §4). **Gate A** at the end (+ X02 load test).

## Wave 3 — Monetisation
B01–B09, B16, B17.

## Wave 4 — Growth, passes, plugin foundations
B10–B15, B18–B20, C00, C01, C02. **Gate B**.

## Wave 5 — Plugins
C05a, C06, C06b, C08, C08b, C10, C11, C12, D08.

## Wave 6 — AE, local engine, library
C05b, C03a, C03b, C04, D04a, D05, D06, D09, X01. **Gate C** (human, real machines).

## Wave 7 — Remaining
D04b (contract-gated), D07, C09, X03, X04. **Gate D**.

## Gate definitions
- **Gate A:** new user captions a Hinglish sample end to end in the browser; cloud render works; parity gate green; X02 passes.
- **Gate B:** Razorpay test payment with mandate; credits reserved/settled/reconciled; Rule 46 invoice PDF; affiliate attributed by code and cookie; referral credits; autocut + zoom reviewed and exported in sync.
- **Gate C (human):** clean Windows + macOS installs; Premiere UXP sign-in, transcript injection, MOGRT captions; Resolve Free script captions; signed/notarised artefacts.
- **Gate D:** 20-minute gaming clip to reviewed export with cuts, zooms, SFX, captions in < 10 min user time; eval thresholds met.

## Verification gate procedure (every wave)
Fresh clone → `pnpm i` → `docker compose up -d` → `pnpm db:migrate && pnpm db:seed` → `pnpm test` → Playwright smoke → parity gate → screenshot review → update this file.
