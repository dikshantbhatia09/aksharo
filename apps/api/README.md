# @montaj/api

NestJS modular monolith — one feature module per work package
(`05-system-architecture.md` section 3). Postgres via Prisma, Redis/BullMQ for jobs,
OpenAPI as the contract that generates `@montaj/api-client`.

**Status:** A08b — schema and base modules (A03), auth (A04), jobs, the realtime
gateway, the signed internal callback surface, the no-op `CreditsFacade`, and the
dead-letter queue with admin replay. Projects and media are A06, the real credit
ledger is B02, the admin console is B13.

## Run

```bash
docker compose up -d                       # from the repo root
pnpm --filter @montaj/api db:migrate       # schema + hand SQL
pnpm --filter @montaj/api db:seed          # plans, styles, flags, demo workspace
pnpm --filter @montaj/api dev              # http://localhost:3001
```

| Endpoint                 | Purpose                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `GET /health`            | liveness: `{ "status": "ok", "version": "0.1.0" }`                         |
| `GET /health/ready`      | readiness: Postgres, Redis and object store; 503 when any is down          |
| `GET /docs`              | Swagger UI                                                                 |
| `GET /docs-json`         | OpenAPI JSON — the source `@montaj/api-client` is generated from           |
| `/auth/*`                | sign-in, sessions, the device grant — see [`src/auth`](src/auth/README.md) |
| `GET /jobs`              | the workspace's jobs, newest first, cursor-paginated                       |
| `GET /jobs/{id}`         | one job                                                                    |
| `GET /jobs/{id}/events`  | the job's event log (rows expire after 30 days)                            |
| `POST /jobs/{id}/cancel` | cancel a queued or running job and release its hold                        |
| `/admin/dlq`             | the dead-letter queue; admins only (A08b)                                  |
| `GET /internal/metrics`  | Prometheus exposition of the `METRICS.md` counters                         |
| `/realtime`              | WebSocket push (`src/realtime/README.md`)                                  |

## Configuration

`src/config/config.module.ts` loads the nearest `.env` (walking up to the repo
root, real environment variables always win), validates it with `loadEnv()` from
`@montaj/config`, and exposes it under the `ENV` token:

```ts
constructor(@Inject(ENV) private readonly env: Env) {}
```

Validation is fail-fast: a missing or malformed variable aborts startup with a
message naming every offending variable, before the port is bound. Never read
`process.env` directly in a module — inject `ENV` so tests can substitute it.

**Tracing is the one exception.** `OTEL_EXPORTER_OTLP_ENDPOINT` (or
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) and `OTEL_SERVICE_NAME` are read straight
from the process environment, because CONTRACTS section 1 is a frozen list of
_product_ configuration and these are named by the OpenTelemetry specification.
With no endpoint set, tracing is a no-op and the SDK is never even loaded.

## Database

`prisma/schema.prisma` covers every table in `03-architecture/06-data-model.md`
(68 models). Conventions, all enforced by tests: ULID `char(26)` ids,
`timestamptz`, money as integer minor units with a currency column, credits as
integer tenths, JSONB columns commented with the Zod schema that validates them,
and snake_case column names.

Anything Prisma cannot express is hand-written SQL in
[`prisma/sql/`](prisma/sql/README.md), applied by `db:migrate` straight after
`prisma migrate deploy`: the `vector` extension, partial and vector indexes, and
the CHECK constraints that hold the money and credit invariants of 06.

### Deviations from 06-data-model.md

Every table in 06 exists. Where the schema departs from the document, it is
because a frozen contract or a shipped package says otherwise:

| What                                                    | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edg_segments.seq` is `text COLLATE "C"`, not `numeric` | 06 says `numeric`, but CONTRACTS section 2 and `@montaj/edg` define `seq` as a base-62 fractional key over `0-9A-Za-z` (`seqBetween()` returns `1B`, `Zz`, `zzzV`). No NUMERIC column can hold those. The alphabet is in ASCII order so that string comparison IS key comparison, which holds only under byte collation — hence `COLLATE "C"`, pinned on the column because managed Postgres usually defaults to a linguistic one. Prisma cannot express a collation, so the integration suite asserts it. |
| `projects.folderId` has no FK                           | 06 lists the column but has no `folders` table; A06 adds one and converts it.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `jobs.type` is `String`, not an enum                    | The closed set is the queue table in CONTRACTS section 3, owned by A08.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Credit columns carry `*Tenths`                          | CONTRACTS section 0 is frozen and says credits are integer tenths; 06's `creditsPerMonth` / `creditsCharged` would leave the unit ambiguous at call sites.                                                                                                                                                                                                                                                                                                                                                 |
| ~15 enums invented                                      | 06 writes `status` / `level` without listing values. Each is marked `/// Not enumerated in 06` in the schema.                                                                                                                                                                                                                                                                                                                                                                                              |

| Script            | What it does                                                             |
| ----------------- | ------------------------------------------------------------------------ |
| `db:migrate`      | `prisma migrate deploy` + apply `prisma/sql/`. Idempotent; run it twice. |
| `db:seed`         | Plans, system styles, feature flags, admin + demo workspace. Idempotent. |
| `db:reset`        | Drop, migrate, apply SQL, seed. **Destructive**, local databases only.   |
| `db:sql`          | Apply `prisma/sql/` alone (repair a database whose DDL drifted).         |
| `prisma:generate` | Regenerate the client. Also runs on `postinstall` and before `build`.    |

### Regenerating the client

`pnpm gen:client` (from the repository root) compiles the API, builds the same
OpenAPI document `/docs-json` serves — with Prisma and Redis substituted, so it
needs no infrastructure — and writes `packages/api-client/openapi.json` and
`packages/api-client/src/generated/operations.ts`. Run it whenever a route,
a request body or a response shape changes.

### Adding a table or a column

1. Edit `prisma/schema.prisma`.
2. `pnpm --filter @montaj/api exec prisma migrate dev --name <what-changed>`.
3. If the change needs an object Prisma cannot express, add it to `prisma/sql/`
   as a **new** numbered file (never edit an applied one) and keep it idempotent.
4. Add the table to `TABLES_FROM_06` in `test/database.e2e-spec.ts` if 06 lists it.

## Base modules (`src/common`)

| Module                           | What you get                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `PrismaModule` / `PrismaService` | the client as a singleton, connected at boot, plus `withTransaction()`                                                        |
| `RedisModule` / `RedisService`   | one lazily-connected ioredis instance (BullMQ will share it in A08)                                                           |
| `LoggingModule`                  | pino with the request id on every line, and redaction of secrets and emails                                                   |
| `RequestContext`                 | AsyncLocalStorage carrying `requestId`, `userId?`, `workspaceId?`                                                             |
| `HttpExceptionFilter`            | the CONTRACTS section 8 envelope for every throwable                                                                          |
| `ZodValidationPipe` + `zodDto()` | request validation; a failure becomes `common/validation_failed` with the Zod issues                                          |
| `guards/`                        | `JwtAuthGuard`, `RolesGuard`, `ApiKeyGuard`, `@Public()`, `@Roles()`, `@CurrentUser()`, `@CurrentWorkspace()`, `@RateLimit()` |
| `startTelemetry()`               | OpenTelemetry traces to OTLP when configured, otherwise nothing                                                               |

`CommonModule` imports all of them and is imported once by `AppModule`; the
sub-modules are `@Global()`, so a feature module injects `PrismaService` or `ENV`
without importing anything.

### Metrics

`GET /internal/metrics` renders the Prometheus exposition format from an
in-process registry (`src/common/metrics`). Names follow
`infra/observability/METRICS.md`, which the shipped dashboards and the
`MontajDlqNonEmpty` / `MontajDlqGrowing` alert rules query:

| Metric                               | Type      | Labels             |
| ------------------------------------ | --------- | ------------------ |
| `montaj_job_completed_total`         | counter   | `queue`, `status`  |
| `montaj_queue_dlq_depth`             | gauge     | `queue`            |
| `montaj_queue_wait_duration_seconds` | histogram | `queue`            |
| `montaj_job_attempts`                | histogram | `queue`            |
| `montaj_dlq_resolved_total`          | counter   | `queue`, `outcome` |

The A08b brief names three of these differently, so those names are emitted too,
as **aliases of the same data**: `montaj_jobs_failed_total{queue}`,
`montaj_dlq_depth{queue}` and `montaj_job_queue_wait_ms`. Retiring one set is an
ADR, not a refactor — METRICS.md is explicit that a name there is as frozen as an
API route.

Every record also goes to the OpenTelemetry metrics API, which is a no-op until a
`MeterProvider` is registered, exactly as tracing is a no-op with no OTLP
endpoint. `MONTAJ_METRICS_TOKEN`, when set, requires
`Authorization: Bearer <token>` on the endpoint; unset, it is open, which is the
right default behind the chart's NetworkPolicy given that METRICS.md forbids
workspace, project, job and user ids as labels.

### Validating a request body

```ts
const CreateProject = z.object({ title: z.string().min(1) });
class CreateProjectDto extends zodDto(CreateProject) {}

@Post()
create(@Body() body: CreateProjectDto) { /* already parsed and stripped */ }
```

### Raising a domain error

```ts
throw new AppException(
  ERROR_CODES.entitlementUpgradeRequired,
  "Creator or above is required.",
  HttpStatus.PAYMENT_REQUIRED,
  { requiredPlan: "creator" }, // reaches the client as `details`
);
```

> A constructor parameter's type **is** the DI token. `import type` erases it from
> the `design:paramtypes` metadata and the provider silently fails to resolve,
> which is why `@typescript-eslint/consistent-type-imports` is off for `src/`.

## Jobs (`src/jobs`, `src/internal`)

The producer side of every queue in CONTRACTS section 3, and the `jobs` /
`job_events` state machine behind them. Other modules never touch BullMQ; they
call `JobsService.enqueue`.

```ts
const { job } = await this.jobs.enqueue({
  type: "ai.transcribe", // a CONTRACTS section 3 queue name
  workspaceId,
  projectId,
  params: { mediaId }, // the queue payload; its shape is yours
  jobKey: `transcribe:${mediaId}`, // one live job per (workspace, key)
  worstCaseTenths: 120, // held before anything is enqueued
});
```

The order inside `enqueue` is the design, and it is worth knowing before changing
it:

```
dedupe by jobKey -> admission control (T23) -> jobs row
  -> CreditsFacade.reserve (T9) -> BullMQ add -> job_events
```

The row exists before the reservation because a hold is keyed on a job id, and the
BullMQ job is added last because that is the only step a consumer can see. Every
earlier failure unwinds with nothing enqueued; a failure at the last step releases
the hold and fails the row. **A job that reaches Redis always has a row and a hold
behind it.**

### Admission control (THREAT-MODEL T23)

Per-workspace caps, from the plan tables in `src/jobs/jobs.config.ts`:

| Cap                      | Config key                 | Exceeded                                       |
| ------------------------ | -------------------------- | ---------------------------------------------- |
| Sum of in-flight holds   | `PLAN_ENQUEUED_CAP_TENTHS` | 429 `jobs/enqueue_cap`                         |
| Count of in-flight jobs  | `PLAN_CONCURRENCY_LANE`    | 429 `jobs/concurrency_cap`                     |
| Time allowed in `queued` | `PLAN_MAX_QUEUE_WAIT_MS`   | job failed `jobs/queue_timeout`, hold released |
| Free-tier daily minutes  | `FREE_TIER_DAILY_MINUTES`  | 402 `credits/insufficient`                     |

The queue-wait sweep is a scheduled task (`jobs.queue-timeout`, every 30 s) on the
`ScheduledTasksService` primitive in `src/common/scheduler`. Register periodic work
there rather than starting a timer:

```ts
this.scheduler.register({ name: "billing.renewals", cron: "0 3 * * *", run: async () => {} });
```

### Worker callbacks (`src/internal`)

Workers report back over a shared-secret HMAC, never a JWT: they have no user.

```
POST  /internal/jobs/{id}/progress       { progress, etaMs?, message? }
POST  /internal/jobs/{id}/complete       { status, result?, error?, usage? }
POST  /internal/jobs/{id}/enqueue-child  { type, payload, worstCaseTenths?, jobKey? }
PATCH /internal/media/{id}               a narrow allow-list of probe results

X-Montaj-Attempt:   <attemptId>
X-Montaj-Timestamp: <unix seconds>
X-Montaj-Signature: hex(hmac_sha256(INTERNAL_CALLBACK_SECRET, timestamp + "." + body))
```

`body` is the **raw request bytes**, which is why `main.ts` creates the app with
`{ rawBody: true }`. Signing a re-serialised body passes in Node and fails against
a Python worker, because `JSON.stringify` and `json.dumps` disagree on separators.

Every handler is idempotent on `(jobId, attemptId)`: a replay answers 200 with
`applied: false` and settles nothing (THREAT-MODEL T8). A timestamp outside a
five-minute window is 401 `jobs/timestamp_skew`; anything else that fails
verification is 401 `jobs/signature_invalid`, with the specific reason logged and
never returned.

**Rotating the callback secret.** Set `INTERNAL_CALLBACK_SECRET_NEXT` to the new
value, roll the workers onto it one at a time, then promote it to
`INTERNAL_CALLBACK_SECRET` and clear it. While both are set the API accepts either,
so no callback is lost mid-roll; a callback verified by the second key is logged,
which is how you tell the roll is finished.

The whole `/internal` surface is `@ApiExcludeController`, so it never reaches
`/docs` or `@montaj/api-client`.

### Retry, stall and dead-letter policy (A08b)

`src/jobs/jobs.config.ts` holds one policy per queue family, with per-queue
overrides for the long ones:

| Family   | Attempts | Backoff (exponential) | Jitter | Lock  | Stall check |
| -------- | -------- | --------------------- | ------ | ----- | ----------- |
| `media`  | 3        | 5 s                   | 0.2    | 2 min | 30 s        |
| `ai`     | 2        | 15 s                  | 0.3    | 2 min | 30 s        |
| `render` | 2        | 30 s                  | 0.3    | 5 min | 60 s        |
| `notify` | 5        | 2 s                   | 0.5    | 30 s  | 15 s        |

| Queue override                 | Lock   |
| ------------------------------ | ------ |
| `ai.transcribe`, `ai.diarise`  | 10 min |
| `ai.align`                     | 5 min  |
| `render.video`                 | 10 min |

Jitter is not decoration: a provider outage fails every in-flight job at almost
the same instant, and an un-jittered exponential backoff retries them all at
almost the same instant too.

`attempts` and `backoff` travel to the worker inside the BullMQ job options.
`lockDurationMs`, `stalledIntervalMs` and `maxStalledCount` are `Worker`
constructor options and have to be **read** from this table by each worker
package. `heartbeatIntervalMs(queue)` is a third of the lock, and the heartbeat IS
the progress callback — which is why a progress call on a `queued` job promotes it
to `running`.

### Dead letters (`src/jobs/dlq.service.ts`, `src/admin/dlq`)

When the last attempt fails — the worker sets `finalAttempt`, or declares the
error unretryable — the job is copied into `dlq` and `jobs.dlq` is set. The copy
is taken from the row **before** the completion update, so it still remembers the
credit hold a later replay has to reserve again. It is idempotent on
`(jobId, attemptId)`, so an at-least-once callback writes one row.

| Route                          | What it does                                          |
| ------------------------------ | ----------------------------------------------------- |
| `GET /admin/dlq`               | filter by queue, status, workspace, error text, dates |
| `GET /admin/dlq/stats`         | per queue: how many, since when, distinct errors      |
| `GET /admin/dlq/{id}`          | one entry, by entry id **or** job id                  |
| `POST /admin/dlq/{id}/replay`  | re-enqueue with a fresh attempt                       |
| `POST /admin/dlq/{id}/discard` | release the hold, record why                          |
| `POST /admin/dlq/replay`       | bulk, by ids or filter; **dry run by default**        |
| `POST /admin/dlq/discard`      | bulk; `discardReason` mandatory                       |

Everything is behind `AdminGuard`, which reads `users.is_admin` from the database
on every request — the flag is not in the token claim set (CONTRACTS section 5 is
frozen), and one indexed lookup is the price of revocation taking effect at once.
A non-admin is 403 `common/forbidden`. Admin routes are **not** workspace-scoped,
which is why every replay and discard writes an `audit_log` row (THREAT-MODEL
T20).

**Replay semantics.** The dead letter is claimed first with a conditional update,
so two concurrent replays produce one. The **same `jobs` row** is reused, so the
job id a client is polling never changes and `jobKey` still holds; a **fresh
`attemptId`** ULID is minted and `attemptNo` incremented, which makes the old
attempt's late callback a `stale_attempt` no-op. Credits are reserved again, and
the BullMQ job is added last — so a failure at any earlier step unwinds with
nothing enqueued. Nothing is re-signed: workers sign their own callbacks.

### Retention

`job_events` rows carry `data.retainUntil`, 30 days out (D47), and
`jobs.event-retention` (nightly, 03:25) deletes on it in batches of 5 000,
falling back to `at < now() - 30 days` for rows written before the marker
existed. `dlq` rows are **never** purged: once resolved they are the record of
what the system could not do.

### Credits

`CREDITS_FACADE` is the only way to touch credits (CONTRACTS section 4). A08 binds
it to `NoopCreditsFacade`: real interface, real idempotency, no ledger. B02 changes
one `useClass` in `src/credits/credits.module.ts` and nothing else.

## Realtime (`src/realtime`)

`/realtime` is a WebSocket over plain `ws`, with rooms `project:{id}` and
`workspace:{id}`, Redis pub/sub fan-out between API instances, and a 30-second
heartbeat. To emit an event from any module:

```ts
await this.realtime.jobProgress({ workspaceId, projectId }, { jobId, progress });
```

The wire protocol, the room authorisation rules, the close codes and the
reconnection contract are in [`src/realtime/README.md`](src/realtime/README.md).

## Notifications (`src/notify`)

Transactional mail and the in-app bell. To send anything from any module:

```ts
await this.notify.enqueue({
  kind: "export-ready",
  to: user.email,
  locale: user.locale,
  userId: user.id,
  workspaceId,
  data: { project: project.name, link, days: 7 },
  idempotencyKey: `export-ready-${exportId}`,
});
```

`NotifyModule` is `@Global()`, so nothing needs importing. `enqueue` never throws
for a delivery reason — a notification is a side effect of work the caller cares
about — and the `idempotencyKey` is the BullMQ job id, which is what makes a
repeat enqueue a no-op.

`MAIL_PROVIDER` picks the transport: `ses` (the pod's IRSA role, region from
`S3_REGION`, no key anywhere), `smtp` (from `SMTP_URL`), or `dev`, which writes to
the Redis outbox A04 introduced instead of sending. For a real client locally:

```bash
docker compose --profile mail up -d     # Mailpit: SMTP 1025, UI http://localhost:8025
node tools/runbooks/mail-outbox.js      # or just read the dev outbox
```

The consumer runs inside this process; `NOTIFY_WORKER_ENABLED=0` turns it off for
one-shot processes and test runs, exactly as `MONTAJ_SCHEDULER_DISABLED` does for
the scheduler. Templates, the kind table, the suppression rules and the SES/SNS
webhook are in [`src/notify/README.md`](src/notify/README.md).

## Runbook scripts

Operational helpers live in `tools/runbooks/` at the repo root and resolve their
dependencies from this package, so they run with plain `node` from anywhere.

| Script                          | What it does                                                |
| ------------------------------- | ----------------------------------------------------------- |
| `tools/runbooks/queue-drain.js` | Pause a queue and wait for its active jobs to finish (A08). |
| `tools/runbooks/dlq-replay.js`  | Inspect, replay and discard dead-lettered jobs (A08b).      |
| `tools/runbooks/mail-outbox.js` | Print the development mail outbox (A25).                    |

```bash
node tools/runbooks/queue-drain.js ai.transcribe --timeout=300000
node tools/runbooks/queue-drain.js ai.transcribe --status --json
node tools/runbooks/queue-drain.js ai.transcribe --resume
```

`queue-drain` pauses the queue (workers stop picking up new jobs; running ones are
untouched), polls until `active` reaches zero or the timeout expires, and prints
the counts. It leaves the queue **paused**, which is the point of draining, and
exits non-zero if jobs were still running when it gave up. `--help` lists every
option.

```bash
export API_ORIGIN=http://localhost:3001 MONTAJ_ADMIN_TOKEN=<admin access token>
node tools/runbooks/dlq-replay.js stats
node tools/runbooks/dlq-replay.js list --queue=ai.transcribe --show-error
node tools/runbooks/dlq-replay.js replay --queue=ai.transcribe --since=2026-09-02T08:00:00Z
node tools/runbooks/dlq-replay.js replay --job=<job or entry id> --confirm
node tools/runbooks/dlq-replay.js discard --ids=a,b --reason="unsupported input" --confirm
```

`dlq-replay` talks to `/admin/dlq` over HTTP rather than to Postgres, because a
replay has to reserve credits, mint an attempt, enqueue and audit, and all of that
policy lives in `DlqService`. `replay` and `discard` are **dry runs unless you
pass `--confirm`**, and both refuse to run with no target at all.
[`docs/runbooks/dlq-replay.md`](../../docs/runbooks/dlq-replay.md) is the
procedure these commands belong to.

## Tests

```bash
pnpm --filter @montaj/api test           # unit + e2e + integration
pnpm --filter @montaj/api test:coverage  # with the CONTRACTS section 9 gate (75/70)
```

Vitest runs through `unplugin-swc` because NestJS DI needs `emitDecoratorMetadata`,
which esbuild cannot produce. `test/setup-env.ts` seeds a complete valid
environment so tests never depend on a developer's `.env`.

`test/auth.e2e-spec.ts` needs a PostgreSQL **and** a Redis; it reuses
`TEST_DATABASE_URL` / `TEST_REDIS_URL` when they are set and otherwise starts both
through testcontainers. Auth is the one module that cannot be tested against
substituted infrastructure: refresh families are a database invariant and the
rotation grace is a Redis entry.

`test/notify.e2e-spec.ts` needs neither, but it does need `openssl` on `PATH` to
build the throwaway X.509 certificate the SNS signature cases sign against; the
cases that need it skip with a reason when it is absent.

`test/database.e2e-spec.ts` needs a PostgreSQL **with pgvector**. It uses
`TEST_DATABASE_URL` if set, otherwise starts `pgvector/pgvector:pg16` through
testcontainers, and skips with an explanation when Docker is unavailable
(`MONTAJ_SKIP_DB_TESTS=1` skips it deliberately). `test/jobs.e2e-spec.ts` and
`test/dlq.e2e-spec.ts` need that database **and** a Redis, because their whole
point is that real BullMQ can read the envelope a real producer wrote — including
the one an admin replay writes under a fresh attempt id;
`MONTAJ_SKIP_REDIS_TESTS=1` skips them. Every
other suite runs with no infrastructure at all: `test/app-harness.ts` substitutes
Prisma, Redis and the realtime bus, and `test/fakes.ts` holds the in-memory Prisma
and queue stubs the unit suites share.

Two variables shape a test run:

| Variable                    | Effect                                                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONTAJ_QUEUE_PREFIX`       | Redis key prefix for BullMQ and realtime. `setup-env.ts` sets a per-process value so two runs never share keys; a deployment leaves it at `bull`, which is what the workers expect. |
| `MONTAJ_SCHEDULER_DISABLED` | `1` stops this process running the scheduler worker. Set in tests, which call `ScheduledTasksService.runNow(name)` instead.                                                         |
| `MONTAJ_METRICS_TOKEN`      | When set, `GET /internal/metrics` requires `Authorization: Bearer <token>`. Unset, the endpoint is open (A08b).                                                                    |
| `NOTIFY_WORKER_ENABLED`     | `0` stops this process draining the `notify` queue. `setup-env.ts` sets it; `test/auth-harness.ts` turns it back on, because that suite delivers to the outbox and reads it.        |

## Adding a module

1. `src/<feature>/<feature>.module.ts`, controller, service, DTOs.
2. Register it in `src/app.module.ts`.
3. Annotate the controller with `@ApiTags` so it appears in `/docs`.
4. Guard it: `@UseGuards(JwtAuthGuard, RolesGuard)` on the controller, `@Public()`
   on the routes that genuinely are. `AuthModule` is `@Global()`, so the guards
   resolve without importing anything. The workspace comes from the token's `ws`
   claim — never from a header (THREAT-MODEL T4).
5. Regenerate `@montaj/api-client` (`pnpm gen:client`) and run the contract test.
