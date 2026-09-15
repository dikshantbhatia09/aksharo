# Wave 0 foundation record

**Work item:** REP-000  
**Recorded:** 2026-09-15  
**Canonical checkpoint:** CP-000  
**Status:** IN_PROGRESS

This record contains no credentials, tokens, private callback URLs, customer
content, or private license documents. Evidence locations below must point to an
access-controlled system rather than copying secrets into Git.

## Reproducible source baseline

| Source                      | Location                    | Version / revision                                                          | Reproducibility evidence                                                                    | Workspace status                                      |
| --------------------------- | --------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Aksharo (`montaj` codename) | repository root             | Git `7b539d4765cc283598d414c36daceb7104313dbd` on `codex/clipping` at start | Git commit plus preserved dirty-tree inventory in the master-plan journal                   | pnpm workspace system of record                       |
| Open Source Clipping        | `opensource-clipping-main/` | package version `1.12.0`; archive has no `.git` metadata                    | SHA-256 tree fingerprint `9bd07c83843a503810e5ccabd9393048ed3e16a9192881d01225df9fb3104f9d` | isolated reference; absent from `pnpm-workspace.yaml` |
| Postiz                      | `postiz-app-main/`          | package version `1.0.0`; archive has no `.git` metadata                     | SHA-256 tree fingerprint `e746ddc4fa6cad9b124bb5f124145aa359df567389dfbd9270471ef0c7e7e300` | isolated reference; absent from `pnpm-workspace.yaml` |

The tree fingerprint is SHA-256 over sorted `relative/path sha256(file)` lines,
excluding `.git`. Recompute it whenever an imported tree is replaced; a package
version alone is not sufficient archive provenance.

## License and compliance register

| Source               | Repository-visible license                                                       | Additional grant status                               | Required evidence before CP-010                                                                                                                                                   | Owner                     | Status          |
| -------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------- |
| Aksharo              | root package is private and `UNLICENSED`; root `LICENSE` controls repository use | n/a                                                   | Product entity and internal ownership record                                                                                                                                      | Product/legal, unassigned | OPEN            |
| Open Source Clipping | MIT, copyright Muhammad Naufal Rizqullah (2026)                                  | Product owner confirmed required licenses are secured | Access-controlled evidence location; modification, deployment, white-label, distribution, attribution, and source-offer terms marked applicable/not applicable                    | Product/legal, unassigned | BLOCKING_CP_010 |
| Postiz               | archive declares AGPL-3.0                                                        | Product owner confirmed required licenses are secured | Access-controlled commercial/additional grant, licensed deployment scope, modification/white-label/distribution terms, attribution/source-offer duties, renewal/termination terms | Product/legal, unassigned | BLOCKING_CP_010 |

No production code has been copied from either imported tree during Wave 0.

## Launch-provider decision

The intended launch cohort is Instagram/Facebook, YouTube, LinkedIn, and TikTok
only if its approval is ready. X is the alternate fourth integration. This is a
scope decision, not an enablement decision: every direct/scheduled route remains
disabled until its provider row is verified. Snapchat and WhatsApp initially use
truthful handoff/download behavior.

The versioned capability draft is
`docs/repurposing-platform-master-plan/platform-capabilities.v1.yaml`.

## Provider credential and test-account inventory

Never put credential values in this table.

| Provider/surface         | Credential owner | Redirect URI registered                   | Required scopes approved | App review | Rights-cleared test account | Fallback         | Gate status            |
| ------------------------ | ---------------- | ----------------------------------------- | ------------------------ | ---------- | --------------------------- | ---------------- | ---------------------- |
| Instagram Reels/Feed     | Unassigned       | Not recorded                              | Not recorded             | Unknown    | Not recorded                | Download only    | BLOCKING_CP_010        |
| Facebook Reels/Page      | Unassigned       | Not recorded                              | Not recorded             | Unknown    | Not recorded                | Download only    | BLOCKING_CP_010        |
| YouTube Shorts/video     | Unassigned       | Not recorded                              | Not recorded             | Unknown    | Not recorded                | Download only    | BLOCKING_CP_010        |
| LinkedIn member/page     | Unassigned       | Not recorded                              | Not recorded             | Unknown    | Not recorded                | Download only    | BLOCKING_CP_010        |
| TikTok                   | Unassigned       | Not recorded                              | Not recorded             | Unknown    | Not recorded                | Download only    | CONDITIONAL_LAUNCH     |
| X (alternate)            | Unassigned       | Not recorded                              | Not recorded             | Unknown    | Not recorded                | Download only    | ALTERNATE_NOT_SELECTED |
| Snapchat Spotlight/Story | Unassigned       | Not recorded                              | Not recorded             | Unknown    | Not recorded                | Download/handoff | DEFERRED_DIRECT        |
| WhatsApp Status          | Unassigned       | n/a until an official handoff is selected | n/a                      | Unknown    | Not recorded                | Download         | HANDOFF_ONLY           |

The following documentation references were checked on 2026-09-15 for the four
REP-002 test profiles. They establish preparation/API context, not credential
ownership, approved scopes, account capability, app review, or successful test
posts. Every provider row above remains gated.

| Test profile   | Official platform/owner references                                                                                                                                                                                                                                            | Context recorded, not access proof                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Instagram Reel | [Meta's Instagram API Reels collection](https://www.postman.com/meta/instagram/folder/830j7my/reels-publishing)                                                                                                                                                               | Reel container/publish flow and video format guidance                |
| YouTube Short  | [YouTube `videos.insert`](https://developers.google.com/youtube/v3/docs/videos/insert); [Shorts eligibility](https://support.google.com/youtube/answer/15424877?hl=en)                                                                                                        | Upload scope/audit context and square/vertical Shorts categorization |
| LinkedIn video | [LinkedIn Videos API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?tabs=http&view=li-lms-2026-03); [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-01) | Video-URN upload and post flow; member/page permissions vary         |
| TikTok video   | [TikTok Direct Post guide](https://developers.tiktok.com/docs/en/content-posting-api-get-started)                                                                                                                                                                             | Scope/audit requirements and live creator-info capability check      |

## Test media inventory

The repository has media fixtures for existing tests, but they are not presumed
to be rights-cleared provider-posting fixtures. CP-010 requires an owner and an
evidence identifier for each of these non-secret assets:

| Fixture                                 | Required coverage                          | Owner      | Evidence id/location | Status  |
| --------------------------------------- | ------------------------------------------ | ---------- | -------------------- | ------- |
| English talking-head long video         | acquisition, highlights, captions, publish | Unassigned | Not recorded         | MISSING |
| Hindi native-script long video          | transcription, highlights, captions        | Unassigned | Not recorded         | MISSING |
| Roman Hinglish long video               | `hi-Latn`, mixed-script brands, publish    | Unassigned | Not recorded         | MISSING |
| Two regional-language videos            | regional scripts and fonts                 | Unassigned | Not recorded         | MISSING |
| Slides/no-face and multi-speaker videos | highlight/reframe edge cases               | Unassigned | Not recorded         | MISSING |

## Environments and secret ownership

| Environment           | Purpose                                      | Data rule                                                       | Secret owner                        | Status      |
| --------------------- | -------------------------------------------- | --------------------------------------------------------------- | ----------------------------------- | ----------- |
| `repurpose-e2e-local` | isolated automated checks                    | synthetic/test data; scratch ports only                         | Local test harness                  | DEFINED     |
| `aksharo-staging`     | Aksharo integration and provider smoke tests | rights-cleared test data only                                   | Infrastructure/security, unassigned | NEEDS_OWNER |
| `postiz-staging`      | licensed provider integration lifecycle      | provider test accounts only; separate DB/Redis/Temporal/storage | Infrastructure/security, unassigned | NEEDS_OWNER |

Production ports `3913` and `3914` are prohibited for repurposing development and
verification. The compose baseline uses API `59923`, web `59924`, PostgreSQL
`59432`, Redis `59379`, MinIO API `59000`, and MinIO console `59001` unless a
conflict requires another recorded scratch range.

## Runtime tools and acquisition packaging decision

| Tool    | Local baseline                        | Container/runtime decision                                                                                                                                                        |
| ------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js | `v24.19.0`                            | repository engine floor remains Node 22; container tags stay pinned                                                                                                               |
| pnpm    | `9.15.9`                              | matches `packageManager` and is the approved package manager                                                                                                                      |
| ffmpeg  | `9.0-full_build-www.gyan.dev` locally | media worker installs Debian trixie's supported ffmpeg and validates its minimum version at boot                                                                                  |
| ffprobe | `9.0-full_build-www.gyan.dev` locally | shipped with the media-worker ffmpeg package and validated at boot                                                                                                                |
| yt-dlp  | `2026.08.19` locally                  | Wave 3 packages the official standalone Linux release at exactly `2026.08.19`, pins its SHA-256, reports the version in health/job results, and updates only through reviewed PRs |

## Feature flags

All flags are server-side, seeded disabled, and start at zero rollout:

| Flag                     | Boundary                                               |
| ------------------------ | ------------------------------------------------------ |
| `repurpose_flow`         | entire guided repurposing surface                      |
| `source_youtube_acquire` | external YouTube acquisition producer/consumer         |
| `highlight_discovery`    | AI candidate discovery                                 |
| `publishing_postiz`      | Postiz connection and publishing adapter               |
| `publishing_tiktok`      | TikTok-specific connection/publish path after approval |

Existing `FEATURE_FLAGS_JSON` deployment overrides remain the emergency kill
switch. No new environment variable is introduced.

## Baseline verification

All commands were run from the repository root on 2026-09-15 without using
ports `3913` or `3914`.

| Evidence    | Command/environment                | Result        | Notes                                                                                                                                                                                                                                                                                              |
| ----------- | ---------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0-BASE-001 | `node --version`; `pnpm --version` | PASS          | Node `v24.19.0`; pnpm `9.15.9`                                                                                                                                                                                                                                                                     |
| W0-BASE-002 | `pnpm typecheck`                   | PASS          | 35 Turbo tasks passed                                                                                                                                                                                                                                                                              |
| W0-BASE-003 | `pnpm lint`                        | FAIL_BASELINE | 9 Ruff findings in pre-existing `worker_ai/processors/transcribe.py` and `worker_ai/providers/local_whisper.py`; neither file is part of REP-000                                                                                                                                                   |
| W0-BASE-004 | `pnpm test`                        | FAIL_BASELINE | 3 API assertions failed: caption parity for user-owned `editorial-ghost-type`, plus two memory-transcribe hint expectations affected by environment/fixture hints. Reported remainder: API 2,658 passed/19 skipped; web 1,321 passed; worker-ai 877 passed/17 skipped; other package suites passed |
| W0-BASE-005 | isolated compose e2e stack         | PASS          | All long-lived services healthy on scratch ports; API `/health` returned 200 `status: ok`, web `/` returned 200; test-only base/sample seeds passed after running base seed before sample seed                                                                                                     |
| W0-BASE-006 | Playwright browser smoke           | FAIL_BASELINE | With explicit scratch env and compose reuse, Chromium home/health/codename and WebKit health passed; `/share` placeholder was absent, and several pages exceeded 90-second hydration wait. Run interrupted after repeated failures; see `apps/web/test-results-wave0/`                             |

Repository `.env` contains `E2E_*` port overrides for non-scratch services.
`scripts/e2e-stack.mjs` now forces the scratch defaults unless the invoking
process explicitly overrides them; direct compose commands must set all six
`E2E_*_PORT` variables. No test process bound `3913` or `3914`.
The one-command stack now runs the documented base/demo seed before the sample
seed. After verification, only `montaj-e2e` containers/network were stopped;
the named MinIO, PostgreSQL, and Redis test volumes were retained.
Finished API, API-migration, and web images were also checked for the absence of
local `.env` files and the imported clipping/Postiz trees at their expected
paths. Intermediate Docker caches were not inspected or pruned.

The working tree was already dirty. REP-000 does not fix, revert, or absorb these
unrelated failures.

### Accepted baseline (2026-09-15)

The repository owner, acting as product owner, has **explicitly accepted** the three
failures above as the known baseline rather than having them repaired, and directed
that the files carrying them are not to be touched. The reason is specific: all three
overlap work that is still in flight in the dirty tree (the `editorial-ghost-type`
caption parity, the Sarvam vendor fixtures, the font and render-core changes), so a
repair made from outside that work risks the work itself.

| Accepted failure | Files | Why it is accepted rather than fixed | Revisit when |
| --- | --- | --- | --- |
| 9 Ruff findings | `apps/worker-ai/worker_ai/processors/transcribe.py`, `providers/local_whisper.py` | Both files are part of the in-flight Hinglish transcription work | The transcription work lands |
| Caption parity assertion for `editorial-ghost-type` | API test suite; style document is user-owned and uncommitted | The style is still being authored; the assertion is measuring a moving target | The typography release is finalised |
| Two memory-transcribe hint expectations | API test suite | Environment/fixture dependent, same in-flight area | As above |
| `/share` missing `data-testid=share-heading`; Chromium/WebKit hydration timeouts | `apps/web/e2e/smoke.spec.ts`, `apps/web/e2e/fixtures.ts` | Browser baseline was interrupted, not diagnosed; the hydration wait is a harness question, not a product failure | Before CP-030 needs browser evidence |

This acceptance closes the CP-010 checklist item for the baseline. It does **not**
close `BLOCK-0002` (provider access) or `BLOCK-0003` (licence evidence), which still
require protected evidence that does not exist in this repository.

## Deferred MVP features

- automatic B-roll insertion;
- AI voice-over and synthetic avatars;
- editable automation topology;
- auto-publish without explicit review and confirmation;
- analytics-driven training on private content;
- a community workflow marketplace;
- providers beyond the verified cohort;
- native Snapchat and WhatsApp posting until official access is proven.

## CP-010 unblock checklist

- [ ] Product/legal owners and protected evidence locations are recorded.
- [ ] Each launch provider has a credential owner, redirect URI, scopes, review
      state, rights-cleared account, and fallback.
- [ ] Rights-cleared multilingual and edge-case fixtures are registered.
- [ ] Aksharo and Postiz staging owners and secret boundaries are assigned.
- [x] Baseline lint/test failures are **explicitly accepted** by the repository/product
      owner on 2026-09-15 — see "Accepted baseline" above. Not repaired, by decision.
- [ ] The isolated compose/browser evidence passes on scratch ports.
- [ ] Focused feature-flag seed tests pass with all new flags disabled.
