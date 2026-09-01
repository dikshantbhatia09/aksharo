# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries are grouped by work package id (see `docs/PLAN.md`).

## [Unreleased]

### Added

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
