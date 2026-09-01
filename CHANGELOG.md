# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries are grouped by work package id (see `docs/PLAN.md`).

## [Unreleased]

### Added

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
