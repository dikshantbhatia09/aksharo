# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries are grouped by work package id (see `docs/PLAN.md`).

## [Unreleased]

### Added

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

### Changed

- **A03** — `docker-compose.yml` now runs `pgvector/pgvector:pg16` instead of
  `postgres:16`. `audio_assets.embedding` is a `vector(512)` column, so stock
  Postgres cannot apply the first migration. Managed Postgres needs `vector` on
  its extension allow-list (X05).
- **A03** — `@typescript-eslint/consistent-type-imports` is off for
  `apps/api/src/**`. A constructor parameter's type is the DI token NestJS resolves
  from `design:paramtypes`, and `import type` erases it to `Object`, so the
  provider fails to resolve at runtime while the code still type-checks.

[Unreleased]: https://github.com/aksharo/montaj/compare/main...HEAD
