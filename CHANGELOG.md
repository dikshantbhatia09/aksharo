# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries are grouped by work package id (see `docs/PLAN.md`).

## [Unreleased]

### Added

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
    marked `pending` that has since landed. The A05 surface (`/me`,
    `/workspaces`, `/entitlement`, `/usage`, `/consents`, `/memory`) is declared
    `pending` and raises `client/not_implemented` without a request, so the shell
    renders honestly for the weeks between the two work packages instead of
    showing an error state everyone learns to ignore.
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
  - Found and reported, not fixed here (A08's files): the API's
    `RedisRealtimeBus` duplicates a connection created with `lazyConnect: true`
    and `enableOfflineQueue: false`, so the duplicate is never dialled and the
    first `SUBSCRIBE` rejects with "Stream isn't writeable" — which takes the
    process down. A08's suite only exercises the in-memory bus. The shell's
    WebSocket is therefore behind `FEATURE_FLAGS_JSON={"realtime.enabled":true}`
    until that is fixed.

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

### Changed

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
