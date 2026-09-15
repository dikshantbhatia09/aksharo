# Anthropic continuation handoff — Aksharo Repurposing Platform

**Prepared:** 15 September 2026
**Last updated:** 15 September 2026, after REP-003 to REP-009 were implemented  
**Workspace:** `C:\Dikshant\Crest Mond\Product 2\05-build\montaj`  
**Starting branch / commit:** `codex/clipping` / `7b539d4765cc283598d414c36daceb7104313dbd`  
**Canonical implementation checkpoint:** `CP-000` — Wave 0 is still in progress

This document is a continuation brief, not a replacement for the user-provided implementation plan. The next agent should reconcile it with any newer user instruction, then read the authoritative documents in full before editing code.

## Copy/paste prompt for Anthropic

```text
You are taking over implementation of the Aksharo Repurposing Platform in:

C:\Dikshant\Crest Mond\Product 2\05-build\montaj

Start by reading these files completely:

1. docs/repurposing-platform-master-plan/MASTER_IMPLEMENTATION_PLAN.md
2. docs/repurposing-platform-master-plan/WAVE-0-FOUNDATION.md
3. docs/adr/0002-repurposing-platform-boundaries.md
4. docs/repurposing-platform-master-plan/ANTHROPIC_HANDOFF.md

The canonical status is still CP-000 / Wave 0 in progress, because CP-010 needs evidence no engineer can produce. REP-001 to REP-009 ARE implemented and tested, all behind flags that are seeded off: the contracts and platform profiles, one additive Prisma migration for the repurposing core and the publishing ledger, five new queue names with their policies across all four runtimes, the run CRUD API, the five-stage UI shell and start form, and the pure source-URL normaliser. Nothing is reviewed, no provider is connected, no post has been sent, and a run cannot progress past `draft` because acquisition (REP-010) onwards does not exist. Do not claim that the overall goal is complete until CP-140 has direct evidence.

Preserve the dirty worktree. It contains substantial user-owned changes unrelated to this platform. Do not run git reset, git checkout --, broad clean commands, or delete untracked files. Do not change unrelated caption-style, font, editor, renderer, or Sarvam work simply to make a baseline test pass.

Use the plan's journal, decision log, blocker log, and active-work record as the source of truth. Before each ticket, add a STARTED entry; after it, add file paths, migrations, flags, tests, evidence, rollback notes, and remaining debt. Append corrections; do not rewrite prior evidence.

Complete Wave 0 evidence and its CP-010 gate before enabling any repurposing or provider behavior. Safe schema-only preparation may continue behind all-disabled feature flags, but direct/scheduled publishing must remain disabled until protected provider evidence and staging verification exist.

Use only isolated scratch infrastructure. Never use production app ports 3913 or 3914. Keep credentials, private callback URLs, license documents, test-account details, customer media, and provider tokens out of Git and logs.

Implement the remaining tickets in the dependency order specified below, verifying each checkpoint with direct evidence rather than assumptions.
```

## Authoritative documents and reference inputs

| Purpose | Exact path | How to use it |
| --- | --- | --- |
| Full product/engineering specification and checkpoint journal | `docs/repurposing-platform-master-plan/MASTER_IMPLEMENTATION_PLAN.md` | Read completely. It defines Waves 0–13, tickets, checkpoint evidence, data contracts, security requirements, and completion criteria. |
| Wave 0 evidence register | `docs/repurposing-platform-master-plan/WAVE-0-FOUNDATION.md` | Maintain protected-evidence gaps, provider/access status, fixture status, baseline test results, and scratch-stack rules. |
| Architecture and license boundary decision | `docs/adr/0002-repurposing-platform-boundaries.md` | Enforces Aksharo system-of-record, reference-source boundaries, flag rules, cohort limits, and downloader decision. |
| Capability draft | `docs/repurposing-platform-master-plan/platform-capabilities.v1.yaml` | All profiles are currently disabled and `download_only`; it is not authorization to publish. |
| Imported clipping reference | `opensource-clipping-main/` | Read-only algorithm/reference material. Do not merge its runtime or orchestration into Aksharo. |
| Imported Postiz reference | `postiz-app-main/` | Read-only publishing-service reference. Do not merge its schema, UI, DB, or token lifecycle into Aksharo. |
| This continuation brief | `docs/repurposing-platform-master-plan/ANTHROPIC_HANDOFF.md` | Current implementation and handoff checklist. Update it only if the handoff itself becomes stale; update the master-plan journal for actual work. |

The imported reference trees have no trustworthy Git provenance in this workspace. Their declared license information and source fingerprints are recorded in the Wave 0 register, but protected commercial/license evidence is still missing. Do not copy code from either tree into production modules until legal/product evidence has been reviewed and recorded.

## Current implementation status

### Overall state

| Item | Status | Meaning |
| --- | --- | --- |
| `CP-000` / Wave 0 | **IN PROGRESS** | Foundation evidence and baseline triage are incomplete. |
| `CP-010` / Wave 0 exit | **BLOCKED / unproven** | Provider, license, fixture, staging-owner, and accepted-baseline evidence are missing. |
| `REP-000` | **Partially implemented** | Foundation documentation, feature flags, isolated test infrastructure, and evidence were added. |
| `REP-001` | **Completed provisionally** | Versioned contracts and fixtures exist; the API now depends on the package for tests only, and the upload-ticket parity check REP-001 asked for has been done. Cross-owner review still outstanding. |
| `REP-002` | **Completed provisionally** | Four disabled/test-only platform profiles exist, but no live capability is approved. |
| `REP-003` | **Implemented, unreviewed** | `RepurposeRun`, `ClipCandidate`, `RepurposeClip`, `ClipVariant` and their enums, in one additive migration with hand-written bounds/rights/progress constraints and partial indexes. 25 database tests. |
| `REP-004` | **Implemented, unreviewed** | `ReviewBundle`, `ReviewItem`, `ChannelConnection`, `PublishBatch`, `PublishTarget` in the same migration. No column can hold a provider token; one live target per idempotency key. |
| `REP-005` | **Implemented, unreviewed** | `media.acquire`, `media.clip`, `ai.highlights`, `publish.dispatch`, `publish.reconcile` registered in all four runtime copies with policies; `packages/publishing-contracts` created; job payload/result contracts and an `ai.highlights@1` Pydantic mirror added. Nothing enqueues them. |
| `REP-006` | **Implemented, unreviewed** | `apps/api/src/repurpose`: create/list/get/cancel/retry, workspace-scoped, idempotent, audited, emitting `repurpose.stage.changed`. Answers 404 while `repurpose_flow` is off. |
| `REP-007` / `REP-008` | **Implemented, unreviewed** | `/repurpose/new` and `/repurpose/[runId]`: the start form and the five-stage workspace, with 35 tests. Stages 2-5 say what they are waiting for rather than showing a mock. |
| `REP-009` | **Implemented, unreviewed** | The pure source-URL parser and normaliser, with an injection and look-alike-host corpus. `source-url-ingest.service.ts` was not loosened. |
| `REP-010` onward | **Not started** | No acquisition worker, highlight discovery, manual timestamp API, materialisation, review bundle service, OAuth or publishing behaviour exists. |

The implementation plan records the last completed item as `REP-008 — Unified source start form`. The next required actions are unchanged in kind: obtain the Wave 0 protected evidence and triage the baseline failures so `CP-010` can pass, and hold the cross-owner contract review `CP-020` requires (now over four packages plus nine Prisma models) with the migration proven on a staging snapshot. `REP-010` is the next implementation ticket and needs its security review before it is written.

### What the 2026-09-15 implementation session added

Everything below is behind `repurpose_flow`, which is seeded off, and every route answers 404 while it is. The evidence for each item is in the master plan's build journal (`BUILD-0013` to `BUILD-0021`) and test evidence log (`TEST-0013` to `TEST-0019`).

- `apps/api/prisma/migrations/20260915170000_repurpose_publish/` and `apps/api/prisma/sql/0008-rep-repurpose-publish.sql` — nine tables, thirteen enums, no change to any existing table. Applied and re-applied on a scratch PostgreSQL 16; the hand SQL is idempotent.
- `packages/publishing-contracts/` — connections, capabilities, batches, targets, callbacks, provider errors and the two publish job contracts. `ChannelConnectionViewSchema` refuses any payload carrying a secret-shaped key.
- `packages/repurpose-contracts/src/jobs.ts` — `media.acquire@1`, `media.clip@1`, `ai.highlights@1` with fixtures, job-key helpers and the storage-key builders.
- `apps/worker-ai/worker_ai/highlights/` — the Pydantic mirror, parsing the same fixtures the TypeScript tests parse.
- `apps/api/src/repurpose/` — the run module, the beginner projection, and the URL normaliser.
- `apps/web/components/repurpose/` and `apps/web/app/(app)/repurpose/` — the shell and the start form.
- `packages/api-client` — typed endpoints, hooks and query keys; `openapi.json` and `src/generated/operations.ts` regenerated. The regeneration also picked up `streamJobProgress`, an operation that existed in the API but was missing from the committed index.
- `docs/CONTRACTS.md` — amendments to sections 3 (queues), 6 (storage keys), 7 (the new realtime event) and 8 (error namespaces).

Three decisions were recorded before the code depended on them: `DEC-007` (the `publish` queue family never retries), `DEC-008` (a link source is refused while its worker does not exist, rather than creating a run that cannot move) and `DEC-009` (the API keeps its own DTOs and proves they agree with the contracts, rather than adopting an unreviewed package as its parser).

### Work completed in Wave 0 / REP-000

#### Architecture and safety boundaries

Created:

- `docs/adr/0002-repurposing-platform-boundaries.md`
- `docs/repurposing-platform-master-plan/WAVE-0-FOUNDATION.md`
- `docs/repurposing-platform-master-plan/platform-capabilities.v1.yaml`

The recorded decisions are:

- Aksharo remains the system of record.
- `opensource-clipping-main/` is only an isolated algorithm/reference source; do not deploy its FastAPI/in-process-task architecture.
- `postiz-app-main/` is a separately deployed publishing service boundary; provider tokens and its lifecycle remain outside Aksharo.
- All relevant flags are disabled by default: `repurpose_flow`, `source_youtube_acquire`, `highlight_discovery`, `publishing_postiz`, and `publishing_tiktok`.
- Intended initial cohort: Meta/Instagram/Facebook, YouTube, and LinkedIn; TikTok only when approved; X is alternate; Snapchat and WhatsApp begin as truthful download/handoff rather than unofficial automation.
- The future Wave 3 acquisition implementation must use a pinned, checksummed official standalone Linux `yt-dlp` release (`2026.08.19`) with no runtime auto-update. This is a decision only, not an implementation.

#### Disabled server-side feature flags

Changed:

- `apps/api/prisma/seed-data.ts`
- `apps/api/prisma/seed-data.test.ts`
- `apps/api/prisma/seed.ts`
- `apps/api/test/database.e2e-spec.ts`

The five flags listed above are seeded off. Targeted verification passed:

```powershell
pnpm --filter @montaj/api exec vitest run prisma/seed-data.test.ts test/database.e2e-spec.ts -t 'FEATURE_FLAG_SEEDS\|seeds every reference feature flag'
```

Result: 3 passed / 49 unrelated skipped. This did not need a database migration. It also does not constitute a live feature implementation.

#### Isolated Docker / browser baseline hardening

Changed:

- `.dockerignore`
- `apps/api/Dockerfile.dockerignore`
- `apps/web/Dockerfile.dockerignore`
- `apps/worker-media/Dockerfile.dockerignore`
- `apps/render/Dockerfile.dockerignore`
- `docker-compose.test.yml`
- `scripts/e2e-stack.mjs`
- `apps/web/playwright.config.ts`

What this does:

- Prevents `.env` files, imported source archives, scratch files, virtual environments, caches, and oversized build context from entering test images.
- Uses an isolated Compose project and valid pinned Quay MinIO/minio-client images.
- Forces scratch app ports unless explicitly supplied by the process and rejects `3913` / `3914` for test API/web ports.
- Starts the test stack, runs the base seed, then the sample seed. The order matters because the sample seed depends on the base workspace.
- Allows browser reuse only when `E2E_REUSE_WEB=1`; normal Playwright operation does not reuse it.

Scratch ports are fixed by convention:

| Service | Scratch port |
| --- | ---: |
| API | `59923` |
| Web | `59924` |
| PostgreSQL | `59432` |
| Redis | `59379` |
| MinIO API | `59000` |
| MinIO console | `59001` |

The isolated stack is currently stopped. Retained named volumes are:

- `montaj-e2e_e2e-minio-data`
- `montaj-e2e_e2e-postgres-data`
- `montaj-e2e_e2e-redis-data`

Do not casually run `pnpm e2e:stack down`: its wrapper deletes volumes with `down -v`. The safe earlier cleanup used direct `docker compose -p montaj-e2e -f docker-compose.test.yml down` **without** `-v`.

#### REP-001 — provisional repurpose contracts

Created `packages/repurpose-contracts/`:

```text
packages/repurpose-contracts/
  README.md
  package.json
  tsconfig.json
  tsconfig.build.json
  eslint.config.mjs
  vitest.config.ts
  src/index.ts
  src/schema.ts
  src/schema.test.ts
  src/*.v1.json
```

It supplies strict Zod v1 schema drafts and fixtures for:

- run/config/status/state models;
- candidates and manual timestamp requests;
- clips and variants;
- stage progress and safe errors;
- URL/upload create-run request and response shapes;
- schema versions and editor deep-link validation.

Important limitations:

- There is no API, web, worker, or publishing-runtime import of this package.
- `ExistingUploadTicketSchema` is a provisional mirror and must be checked against the existing API before integration.
- All shapes require review by web, API, AI, media, and publishing owners before `CP-020`.

Recorded verification:

```powershell
pnpm --filter @montaj/repurpose-contracts typecheck
pnpm --filter @montaj/repurpose-contracts build
pnpm --filter @montaj/repurpose-contracts lint
pnpm --filter @montaj/repurpose-contracts test:coverage
```

Result: pass; 8 tests; 97.12% lines and 90.62% branches. Repository `pnpm typecheck` later passed 38 Turbo tasks.

#### REP-002 — provisional platform profiles

Created `packages/platform-profiles/`:

```text
packages/platform-profiles/
  README.md
  package.json
  tsconfig.json
  tsconfig.build.json
  eslint.config.mjs
  vitest.config.ts
  src/index.ts
  src/schema.ts
  src/schema.test.ts
  src/test-profiles.v1.json
```

It holds four `platform-profile@1` fixtures:

- Instagram Reel
- YouTube Short
- LinkedIn video
- TikTok video

Every profile is `test_only`, disabled, and restricted to `download_only`. No direct or scheduled mode is present, and no runtime consumer imports the registry. Its conservative 3–60 second / 250 MB / MP4 H.264/AAC values are Aksharo preparation choices, not claims about provider maxima. The schema structurally requires protected evidence before direct or schedule activation.

Recorded verification:

```powershell
pnpm --filter @montaj/platform-profiles typecheck
pnpm --filter @montaj/platform-profiles build
pnpm --filter @montaj/platform-profiles lint
pnpm --filter @montaj/platform-profiles test:coverage
```

Result: pass; 5 tests; 96.25% lines and 92.30% branches. A built-registry assertion confirmed every direct/scheduled mode is absent.

## Current blockers that require evidence or owner decisions

Do not bypass these by enabling flags, loosening validation, copying imported code, or relabeling a checkpoint.

| Blocker | What is missing | Required owner action | Safe work that may continue |
| --- | --- | --- | --- |
| `BLOCK-0002` — provider access | Credential owner, callback URI, approved scopes, app-review state, rights-cleared test account, fallback, and staging smoke for every launch surface | Product/provider owner records non-secret evidence in Wave 0 register | Schema and disabled profile work only; no direct/scheduled post |
| `BLOCK-0003` — license evidence | Protected evidence locations and terms for modification, deployment, white-label, distribution, attribution, and source offers for the imported references | Product/legal owner provides protected, non-Git evidence references | Isolated design/contract work; no production code copy |
| `BLOCK-0004` — baseline triage | Named ownership, fix, or explicit acceptance for pre-existing lint, unit, and browser failures | Existing code owners / product owner decide or fix with evidence | Scoped repurposing work that does not alter unrelated dirty files |
| `BLOCK-0005` — contract review | Cross-owner sign-off on four contract packages and nine Prisma models, and the migration applied to a staging snapshot | Web, API, AI, media and publishing owners; a named delivery lead | `CP-020` cannot pass without it. Further implementation on top of unreviewed contracts compounds the rework if a shape changes |
| Fixture register gap | Rights-cleared multilingual source videos, spoken/output-language examples, annotations, ownership, and retention/evidence | Product/content owner | Test harness design only; no use of unverified material |
| Staging ownership gap | Environment owner, secrets owner, provider test-account owner, rollback contact | Platform/product owner | Local isolated tests only |

Official provider documentation links in the repository are research context, **not** proof that an account, scope, review, or posting permission exists.

## Known verification evidence and baseline failures

### Passing recorded evidence

- Local tooling / version check was recorded as passing under the approved Node / pnpm baseline.
- API disabled-feature-flag test described above passed.
- `packages/repurpose-contracts` build, typecheck, lint, coverage passed.
- `packages/platform-profiles` build, typecheck, lint, coverage passed.
- Repository `pnpm typecheck` passed 38 Turbo tasks at the last recorded check.
- Scratch Compose stack passed: long-lived services were healthy; API `/health` returned 200; web `/` returned 200; base and sample seeds completed.
- Finished API/api-migrate/web image context checks passed and found no expected `.env` or imported-source content in image paths.
- `pnpm exec eslint scripts/e2e-stack.mjs` and scoped formatting/diff-whitespace checks passed.

### Baseline failures that remain unresolved

| Check | Current status | Evidence / affected paths |
| --- | --- | --- |
| `pnpm lint` | Fails baseline | 9 pre-existing worker-AI Ruff findings, principally `apps/worker-ai/worker_ai/processors/transcribe.py` and `apps/worker-ai/worker_ai/providers/local_whisper.py` |
| `pnpm test` | Fails baseline | 3 existing API assertions: user-owned `editorial-ghost-type` caption parity plus two memory-transcribe hint expectations |
| Browser smoke | Fails / interrupted baseline | `/share` lacks `data-testid=share-heading`; several Chromium/WebKit cases wait more than 90 seconds for `html[data-hydrated=true]` and time out |

Browser artifacts are intentionally untracked in:

```text
apps/web/test-results-wave0/**/error-context.md
```

The relevant smoke test and hydration fixture are:

- `apps/web/e2e/smoke.spec.ts`
- `apps/web/e2e/fixtures.ts`

Do not describe browser verification as green. Do not commit diagnostic browser artifacts unless they are intentionally required for a review.

### Reproduction commands

The repository declares `pnpm@9.15.9`. A later shell audit reported `pnpm 11.19.0`, so select and verify pnpm 9 before treating any reproduced result as equivalent to recorded evidence.

```powershell
git status --short
node --version
pnpm --version

pnpm --filter @montaj/repurpose-contracts typecheck
pnpm --filter @montaj/repurpose-contracts build
pnpm --filter @montaj/repurpose-contracts lint
pnpm --filter @montaj/repurpose-contracts test:coverage

pnpm --filter @montaj/platform-profiles typecheck
pnpm --filter @montaj/platform-profiles build
pnpm --filter @montaj/platform-profiles lint
pnpm --filter @montaj/platform-profiles test:coverage

pnpm --filter @montaj/api exec vitest run prisma/seed-data.test.ts test/database.e2e-spec.ts -t 'FEATURE_FLAG_SEEDS\|seeds every reference feature flag'
pnpm typecheck
```

For an isolated stack:

```powershell
pnpm e2e:stack up
Invoke-WebRequest http://127.0.0.1:59923/health
Invoke-WebRequest http://127.0.0.1:59924/
docker compose -p montaj-e2e -f docker-compose.test.yml ps
```

For browser smoke, explicitly use scratch origins and DB/Redis values, set `E2E_REUSE_WEB=1`, and invoke:

```powershell
pnpm --filter @montaj/web exec playwright test e2e/smoke.spec.ts --output=test-results-wave0
```

Use direct Compose cleanup without `-v` if preserving scratch data is intended:

```powershell
docker compose -p montaj-e2e -f docker-compose.test.yml down
```

## Dirty-worktree safety map

The workspace was already dirty before this repurposing work. Treat all unrelated changes and untracked files as user-owned unless the user explicitly authorizes changes to them.

### Repurposing-scope files already changed or added

```text
.dockerignore
apps/api/Dockerfile.dockerignore
apps/api/prisma/seed-data.test.ts
apps/api/prisma/seed-data.ts
apps/api/prisma/seed.ts
apps/api/test/database.e2e-spec.ts
apps/render/Dockerfile.dockerignore
apps/web/Dockerfile.dockerignore
apps/web/playwright.config.ts
apps/worker-media/Dockerfile.dockerignore
docker-compose.test.yml
docs/adr/0002-repurposing-platform-boundaries.md
docs/repurposing-platform-master-plan/
packages/platform-profiles/
packages/repurpose-contracts/
pnpm-lock.yaml
scripts/e2e-stack.mjs
apps/web/test-results-wave0/              # diagnostics, normally do not commit

# Added 2026-09-15 by the REP-003 … REP-009 session
apps/api/prisma/schema.prisma
apps/api/prisma/migrations/20260915170000_repurpose_publish/
apps/api/prisma/sql/0008-rep-repurpose-publish.sql
apps/api/src/repurpose/
apps/api/src/app.module.ts
apps/api/src/realtime/realtime.protocol.ts
apps/api/src/jobs/contracts/queue-names.ts
apps/api/src/jobs/jobs.config.ts
apps/api/test/repurpose-schema.e2e-spec.ts
apps/api/test/repurpose-runs.e2e-spec.ts
apps/worker-media/src/queues.ts
apps/worker-media/src/policies.ts
apps/worker-ai/worker_ai/queues.py
apps/worker-ai/worker_ai/policies.py
apps/worker-ai/worker_ai/highlights/
apps/web/components/repurpose/
apps/web/app/(app)/repurpose/
packages/publishing-contracts/
packages/repurpose-contracts/src/jobs.ts
packages/api-client/                      # endpoints, hooks, types, regenerated index
docs/CONTRACTS.md
```

### Examples of unrelated user-owned dirty areas

```text
apps/web/components/editor/**
apps/web/scripts/copy-render-assets.mjs
apps/web/tsconfig.json
apps/worker-ai/**/sarvam* and vendor fixtures
packages/caption-styles/**
packages/fonts/**
packages/render-core/**
scratch/**
opensource-clipping-main/
postiz-app-main/
```

Before every implementation ticket, inspect `git status --short` and narrow changes to the target files. Never use a broad revert, clean, or reset to obtain a green baseline.

## Remaining implementation backlog

The table below identifies the next engineering work. The full acceptance detail, edge cases, and ticket criteria remain in `MASTER_IMPLEMENTATION_PLAN.md`; read it before coding each ticket.

### Wave 1 — core models, ledger, and queue contracts (`CP-020`)

> **REP-003, REP-004 and REP-005 are implemented** (2026-09-15). What remains for `CP-020` is the cross-owner review and a migration run against a staging snapshot. The ticket descriptions below are kept as the acceptance criteria to review against.

#### REP-003 — Prisma repurpose core

Primary paths:

```text
apps/api/prisma/schema.prisma
apps/api/prisma/migrations/<timestamp>_repurpose_publish/
apps/api/prisma/** tests
```

Implement non-destructive Prisma models/enums and tests for:

- `RepurposeRun`, `ClipCandidate`, `RepurposeClip`, and `ClipVariant`;
- relations to `Workspace`, `Project`, `Export`, and `Job`;
- source kind, run mode/status, candidate source/state, and variant status enums;
- tenant boundaries on every relation/query;
- candidate bounds: `startMs >= 0`, `endMs > startMs`, service validation against source duration, and initial configurable 3–180 second limits;
- exact-bounds uniqueness per run, one materialized clip family per candidate, one child project per variant, and appropriate workspace/status/source-project indexes.

Test an empty database and representative populated snapshot. Verify tenant isolation, foreign keys, invalid ranges, and uniqueness. Do not make destructive schema changes. Document migration rollback behavior.

#### REP-004 — publishing ledger schema

Primary paths:

```text
apps/api/prisma/schema.prisma
apps/api/prisma/migrations/<timestamp>_repurpose_publish/
apps/api/prisma/** tests
```

Add `ChannelConnection`, `ReviewBundle`, `ReviewItem`, `PublishBatch`, and `PublishTarget` to the same non-destructive migration where appropriate.

Requirements:

- Aksharo stores safe integration IDs / metadata only; provider tokens remain in Postiz.
- A target freezes `artifactFingerprint`, `exportId`, copy/settings versions, provider/mode/schedule, idempotency key, and safe error status.
- Enforce live idempotency with handwritten SQL if Prisma cannot express the required conditional uniqueness.
- Editing a variant invalidates only its affected approval/review/publish targets.

#### REP-005 — queue and cross-runtime contract expansion

Primary paths:

```text
packages/publishing-contracts/                    # create
packages/repurpose-contracts/
docs/CONTRACTS.md
apps/api/src/jobs/contracts/queue-names.ts
apps/worker-ai/worker_ai/queues.py
apps/worker-media/src/queues.ts                   # or actual current queue registry
apps/api/src/jobs/**
apps/worker-ai/** queue tests / fixtures
apps/worker-media/** queue tests / fixtures
```

Create missing `packages/publishing-contracts` with versioned schemas/fixtures for connections, capabilities, batches, targets, callbacks, provider errors, and post-copy/settings. Add Pydantic mirrors and fixtures for `ai.highlights@1`.

Add queue names and parity tests for:

- `media.acquire`
- `media.clip`
- `ai.highlights`
- `publish.dispatch`
- `publish.reconcile`

Each must have versioned payload/result schemas, storage-key conventions, signed envelopes, retry/backoff/timeout/concurrency/DLQ/retention policy, TypeScript/Python JSON round-trip tests, and metrics. A candidate is not a completed highlight until it has been selected.

`CP-020` needs reviewed versioned contracts, a migration proven on a staging snapshot, Prisma generation/typecheck/relevant tests, queue cross-runtime parity, and no endpoint consuming unversioned JSON.

### Wave 2 — guided run shell (`CP-030`)

> **REP-006, REP-007 and REP-008 are implemented** (2026-09-15) behind the disabled flag. `CP-030` is NOT claimed: it needs a tenant-isolated user driving the real HTTP surface in a browser, which needs the flag on, which needs `CP-010`. The upload path also still needs the returned ticket wired into the existing upload queue.

#### REP-006 — Run CRUD API

Create a repurpose API module, preferably under:

```text
apps/api/src/repurpose/
apps/api/src/projects/
apps/api/src/media/
apps/api/src/jobs/
apps/api/test/**
```

Implement create/list/get/retry/cancel with workspace authorization, create/cancel idempotency, audit events, safe errors, entitlement stub, flags, realtime stage events, and a beginner-safe projection. Create source projects through existing project/media seams. Reuse the existing multipart-media initialization rather than duplicating it. URL and upload flows only converge after media readiness.

#### REP-007 — Five-stage UI shell

Create:

```text
apps/web/app/(app)/repurpose/new/
apps/web/app/(app)/repurpose/[runId]/
apps/web/components/repurpose/
apps/web/e2e/**
```

Build a fixed five-stage rail and reuse existing `LanguagePicker`, `WritingScriptPicker`, caption preset registry, upload queue, UI primitives, and realtime patterns. Implement `RunStageRail`, `RunStageNode`, `StagePanel`, `PersistentPreview`, and `RunActionBar`, including loading, empty, permission, cancelled, and failed states.

Use REP-001 fixtures for unavailable downstream stages. Persist a run before background work. Support refresh/resume through realtime plus bounded polling fallback. Add stable semantic `data-testid`s. Never expose queue names, Postiz, raw errors, or “montaj” to end users.

#### REP-008 — Unified source start form

Primary paths:

```text
apps/web/app/(app)/repurpose/new/
apps/web/components/repurpose/
apps/api/src/repurpose/
apps/api/src/media/
```

Implement link/upload tabs; source, output language, writing script, style, and method preferences; advanced settings; rights attestation; and existing-upload initialization integration. Revalidate every client input server-side.

`CP-030` needs a tenant-isolated user able to create URL/upload-shaped runs, refresh/resume them, and demonstrate idempotent create plus responsive, accessible browser tests even without downstream engines.

### Wave 3 — authorized acquisition (`CP-040`)

> **REP-009 is implemented** (2026-09-15). `REP-010` is the next ticket to write, and the plan requires its threat review and an isolated staging spike BEFORE any production wiring.

#### REP-009 — YouTube URL normalizer

Primary paths:

```text
apps/api/src/repurpose/
apps/api/src/public-api/v1/source-url-ingest.service.ts
apps/api/test/**
```

Implement a pure YouTube-specific parser/normalizer: HTTPS only, recognized hosts, no credentials, source-ID dedupe, rights attestation, rejection codes, and safe handling of direct-media URLs through the existing direct-media path. Reject unknown HTML pages in MVP. Do **not** loosen `source-url-ingest.service.ts` to accept YouTube watch pages.

#### REP-010 — `media.acquire` worker

Primary paths:

```text
apps/api/src/jobs/
apps/api/src/media/
apps/worker-media/
apps/worker-media/Dockerfile.dockerignore
docs/CONTRACTS.md
```

First make an isolated staging spike, then production work behind flags. Requirements include pinned/checksummed `yt-dlp 2026.08.19`, no shell or user-controlled arguments, metadata preflight, SSRF protection, duration/size/temp-disk/wall-time limits, a job-scoped temp directory, ffprobe validation, checksum, standard raw storage key, atomic persistence plus exactly one existing `media.probe`, retry/cancel cleanup, DLQ/metrics, and health/job tool version reporting.

Test security/property cases, private/live/oversized/unavailable media, storage/full-disk/worker-death/restart failure, and a rights-cleared staging video. Ten repeated acquisitions of the same test video must yield one logical source per idempotency request, no duplicate storage/transcription, and no orphan jobs.

### Wave 4 — highlight discovery (`CP-050`)

Primary areas:

```text
apps/worker-ai/
apps/api/src/repurpose/
packages/repurpose-contracts/
docs/repurposing-platform-master-plan/
opensource-clipping-main/clipping/studio/        # reference only
```

Create a private rights-cleared multilingual benchmark and annotations before implementation. Build deterministic transcript windows with stable word IDs; bounded audio/visual/scene/face/speaker/reframe features; a strict `highlight-candidates@1` prompt that selects enumerated IDs rather than free timecodes; Pydantic/Zod validation plus one repair retry; clamping/snapping/deduplication/diversity/safety; transactional persistence with provenance; credit handling; and Stage 2 candidate UI for selection, preview, regeneration, and non-content analytics.

Required gate: zero invalid timestamps; top-5 approved moment in at least 85% of benchmark videos; fewer than 5% duplicates; no supported language more than 10 points behind aggregate without mitigation; 100% valid manual range creation.

### Wave 5 — manual timestamps (`CP-060`)

Primary areas:

```text
apps/api/src/repurpose/
apps/web/components/repurpose/
apps/web/app/(app)/repurpose/[runId]/
packages/repurpose-contracts/
```

Implement numeric and `hh:mm:ss(.SSS)` parsing to milliseconds, source-duration validation, word-boundary snapping with requested/effective bounds, frame-accurate draggable/keyboard controls, exact-bounds override, “Chosen by you” UI, and preservation across AI regeneration/retry. The manual path must materialize successfully when AI discovery is unavailable.

### Wave 6 — materialization and editable variants (`CP-070`)

Primary areas:

```text
apps/api/src/projects/
apps/api/src/media/
apps/api/src/edg/
apps/api/src/exports/
apps/worker-media/
apps/render/
packages/edg/
packages/render-manifest/
```

Implement durable `media.clip@1` orchestration: accurate ffmpeg cuts, A/V sync, rotation/SAR normalization, handles, standard mezzanine, trusted-object attach/import through existing media seams, one child project per selected aspect family, transcript/speaker/script rebase, standard EDG initialization, existing reframe/caption/render reuse, editable copy, low-cost review render, fingerprints/events, editor return links, stale propagation, and regeneration that creates new exports rather than overwriting approved artifacts.

### Wave 7 — captions and language/script wiring (`CP-080`)

Primary areas:

```text
apps/web/components/projects/prepare-media-modal.tsx
apps/web/components/repurpose/
apps/api/src/repurpose/
apps/worker-ai/
apps/worker-media/
packages/caption-styles/
packages/render-core/
packages/edg/
```

Wire source language, output language, and writing script end-to-end. Finish the currently presentational writing-script choice in `prepare-media-modal.tsx`. Use `hi-Latn` consistently through API, workers, EDG, analytics, and UI. Add style/version snapshots, platform safe zones, missing-glyph preflight, invalidation, appropriate SRT/VTT behavior, and preview/export goldens for English, Hindi, Hinglish, bilingual, and regional scripts.

### Wave 8 — review and approval (`CP-090`)

Primary areas:

```text
apps/api/src/repurpose/
apps/api/src/projects/
apps/api/src/exports/
apps/web/components/repurpose/
apps/web/app/(app)/repurpose/[runId]/
```

Build run-level review bundles/items, reuse existing share links/comments where appropriate, make copy editing provider-limit-aware, and bind approvals to artifact fingerprints. Publishing must reject changed, stale, or unapproved outputs (including HTTP 409 where applicable).

### Wave 9 — Postiz connection, read-only first (`CP-100`)

Primary areas:

```text
apps/api/src/publishing/
apps/api/src/repurpose/
apps/web/components/repurpose/
postiz-app-main/apps/sdk/src/index.ts            # reference only
postiz-app-main/** public DTO/controllers         # reference only
```

Deploy a dedicated licensed Postiz staging environment with independent DB, Redis, Temporal, storage, secrets, and pinned version/digest. Create a bounded `PostizClient` with timeouts, validation, redaction, health, circuit breaking, connection sync, signed OAuth state/callback, safe metadata only, refresh/disconnect, Stage 5 UI, and a synthetic health check that never posts. Use callback signing or documented polling-only reconciliation. No post is permitted in Wave 9.

### Wave 10 — publish, schedule, reconcile (`CP-110`)

Primary areas:

```text
apps/api/src/publishing/
apps/api/src/jobs/
apps/worker-media/
apps/worker-ai/                                  # if contract coordination is needed
packages/publishing-contracts/
packages/platform-profiles/
apps/web/components/repurpose/
```

Enable one provider at a time and only behind the approved flags. Implement plan validation against profiles/live capability, frozen batch/target rows, correct MP4 MIME upload, dispatch/reconcile workers, persisted external references before subsequent calls, signed callback/polling, partial success, failed-only retry, uncertain-state operator reconcile, timezone/scheduling/cancellation behavior, and no ordinary retry path that can duplicate a post.

### Waves 11–13 — handoff truthfulness, reliability, and rollout

| Wave / checkpoint | Required outcome | Main areas |
| --- | --- | --- |
| Wave 11 / `CP-120` | Snapchat/WhatsApp accurately labelled Direct, Handoff, or Download; no unofficial automation or false “published” state | `apps/api/src/publishing/`, `apps/web/components/repurpose/`, platform profiles |
| Wave 12 / `CP-130` | Failure injection, traces, DLQ/admin tools, SLO dashboards, fairness, load/security/privacy/accessibility/localization testing, dependency scanning, backup/restore, runbooks, and cost approval | API, workers, infra, docs/runbooks, observability |
| Wave 13 / `CP-140` | Staff dogfood, 10–20 creator pilot, flag cohorts, and two consecutive weeks meeting all release criteria | All surfaces plus analytics and operations |

Do not mark the overall objective complete until the plan's final acceptance scenario passes across English, Hindi native, Hinglish, regional-script, desktop/mobile, and interruption cases and the two-week GA metrics are evidenced.

## Checkpoint checklist

| Checkpoint | Minimum direct evidence needed before passing |
| --- | --- |
| `CP-010` | Protected license/provider/test-account/staging-owner evidence; rights-cleared fixtures; isolated baseline resolved or explicitly accepted; all flags disabled |
| `CP-020` | Cross-owner contract review; migration on staging snapshot; Prisma and queue parity tests; versioned payloads only |
| `CP-030` | Tenant-isolated CRUD; accessible resumable five-stage shell; idempotency and browser evidence |
| `CP-040` | Secure idempotent acquisition, converged flow, forced-failure recovery/security evidence |
| `CP-050` | Multilingual highlight benchmark meets all timestamp, quality, and fairness gates |
| `CP-060` | Accurate AI-independent manual timestamp/materialization path |
| `CP-070` | Idempotent editable variants; A/V sync and crash recovery |
| `CP-080` | Language/script/style wiring and preview/export goldens |
| `CP-090` | Fingerprint-bound approval and stale-output protection |
| `CP-100` | Secure Postiz staging connection boundary, token-boundary tests, no post sent |
| `CP-110` | Per-provider publishing/scheduling/reconciliation matrix with no duplicate failure path |
| `CP-120` | Truthful Snapchat/WhatsApp behavior |
| `CP-130` | Reliability/security/load/restore/cost/runbook gates |
| `CP-140` | Pilot metrics hold for two consecutive weeks and all release gates pass |

## First-session execution order for the successor

1. Read the four authoritative documents at the top of this handoff.
2. Run `git status --short`; preserve the dirty tree and identify only files needed for the current ticket.
3. Confirm Node and pnpm versions, selecting pnpm 9.15.9 before comparing test results to recorded evidence.
4. Read the master-plan top block, active work record, journal, decision log, and blocker log; append a `STARTED` record for the next scoped ticket.
5. Obtain or request the missing protected Wave 0 evidence. Record only non-secret references in Git.
6. If proceeding with safe engineering while evidence is pending, review `REP-001` and `REP-002` across owners, then begin `REP-003` with a non-destructive schema design and migration test plan. Keep every feature flag disabled.
7. After each change, run the narrowest relevant checks, add test evidence to the master-plan journal, and state precisely which checkpoint remains unproven.

## Non-negotiable safety invariants

- No provider token in Aksharo's database, Git history, test output, or client.
- No direct/scheduled publishing until protected evidence, staging verification, and the matching checkpoint gate pass.
- Every persisted repurposing record and lookup must enforce workspace/tenant isolation.
- External side effects must have versioned contracts, idempotency keys, bounded retry/cancel behavior, safe errors, and durable reconciliation.
- Do not execute user-controlled shell command fragments for media acquisition.
- Do not expand generic URL ingestion to fetch arbitrary web pages as a shortcut for YouTube support.
- Preserve source attribution/license boundaries; reference trees are not drop-in dependencies.
- Keep all new behavior off by default until it is explicitly approved and gated.
- Never claim a checkpoint passed based on code existence alone; record direct test, audit, and owner evidence.

