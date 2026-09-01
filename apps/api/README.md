# @montaj/api

NestJS modular monolith — one feature module per work package
(`05-system-architecture.md` section 3). Postgres via Prisma, Redis/BullMQ for jobs,
OpenAPI as the contract that generates `@montaj/api-client`.

**Status:** A08 — schema and base modules (A03), plus jobs, the realtime gateway,
the signed internal callback surface and the no-op `CreditsFacade`. Auth is A04,
projects and media are A06, the real credit ledger is B02.

## Run

```bash
docker compose up -d                       # from the repo root
pnpm --filter @montaj/api db:migrate       # schema + hand SQL
pnpm --filter @montaj/api db:seed          # plans, styles, flags, demo workspace
pnpm --filter @montaj/api dev              # http://localhost:3001
```

| Endpoint                 | Purpose                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `GET /health`            | liveness: `{ "status": "ok", "version": "0.1.0" }`                |
| `GET /health/ready`      | readiness: Postgres, Redis and object store; 503 when any is down |
| `GET /docs`              | Swagger UI                                                        |
| `GET /docs-json`         | OpenAPI JSON — the source `@montaj/api-client` is generated from  |
| `GET /jobs`              | the workspace's jobs, newest first, cursor-paginated              |
| `GET /jobs/{id}`         | one job                                                           |
| `GET /jobs/{id}/events`  | the job's event log (rows expire after 30 days)                   |
| `POST /jobs/{id}/cancel` | cancel a queued or running job and release its hold               |
| `/realtime`              | WebSocket push (`src/realtime/README.md`)                         |

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

### Adding a table or a column

1. Edit `prisma/schema.prisma`.
2. `pnpm --filter @montaj/api exec prisma migrate dev --name <what-changed>`.
3. If the change needs an object Prisma cannot express, add it to `prisma/sql/`
   as a **new** numbered file (never edit an applied one) and keep it idempotent.
4. Add the table to `TABLES_FROM_06` in `test/database.e2e-spec.ts` if 06 lists it.

## Base modules (`src/common`)

| Module                           | What you get                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `PrismaModule` / `PrismaService` | the client as a singleton, connected at boot, plus `withTransaction()`               |
| `RedisModule` / `RedisService`   | one lazily-connected ioredis instance (BullMQ will share it in A08)                  |
| `LoggingModule`                  | pino with the request id on every line, and redaction of secrets and emails          |
| `RequestContext`                 | AsyncLocalStorage carrying `requestId`, `userId?`, `workspaceId?`                    |
| `HttpExceptionFilter`            | the CONTRACTS section 8 envelope for every throwable                                 |
| `ZodValidationPipe` + `zodDto()` | request validation; a failure becomes `common/validation_failed` with the Zod issues |
| `startTelemetry()`               | OpenTelemetry traces to OTLP when configured, otherwise nothing                      |

`CommonModule` imports all of them and is imported once by `AppModule`; the
sub-modules are `@Global()`, so a feature module injects `PrismaService` or `ENV`
without importing anything.

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

## Runbook scripts

Operational helpers live in `tools/runbooks/` at the repo root and resolve their
dependencies from this package, so they run with plain `node` from anywhere.

| Script                          | What it does                                                |
| ------------------------------- | ----------------------------------------------------------- |
| `tools/runbooks/queue-drain.js` | Pause a queue and wait for its active jobs to finish (A08). |
| `tools/runbooks/dlq-replay.js`  | Re-enqueue or discard dead-lettered jobs (A08b).            |

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

## Tests

```bash
pnpm --filter @montaj/api test           # unit + e2e + integration
pnpm --filter @montaj/api test:coverage  # with the CONTRACTS section 9 gate (75/70)
```

Vitest runs through `unplugin-swc` because NestJS DI needs `emitDecoratorMetadata`,
which esbuild cannot produce. `test/setup-env.ts` seeds a complete valid
environment so tests never depend on a developer's `.env`.

`test/database.e2e-spec.ts` needs a PostgreSQL **with pgvector**. It uses
`TEST_DATABASE_URL` if set, otherwise starts `pgvector/pgvector:pg16` through
testcontainers, and skips with an explanation when Docker is unavailable
(`MONTAJ_SKIP_DB_TESTS=1` skips it deliberately). `test/jobs.e2e-spec.ts` needs
that database **and** a Redis, because its whole point is that real BullMQ can read
the envelope a real producer wrote; `MONTAJ_SKIP_REDIS_TESTS=1` skips it. Every
other suite runs with no infrastructure at all: `test/app-harness.ts` substitutes
Prisma, Redis and the realtime bus, and `test/fakes.ts` holds the in-memory Prisma
and queue stubs the unit suites share.

Two variables shape a test run:

| Variable                    | Effect                                                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONTAJ_QUEUE_PREFIX`       | Redis key prefix for BullMQ and realtime. `setup-env.ts` sets a per-process value so two runs never share keys; a deployment leaves it at `bull`, which is what the workers expect. |
| `MONTAJ_SCHEDULER_DISABLED` | `1` stops this process running the scheduler worker. Set in tests, which call `ScheduledTasksService.runNow(name)` instead.                                                         |

## Adding a module

1. `src/<feature>/<feature>.module.ts`, controller, service, DTOs.
2. Register it in `src/app.module.ts`.
3. Annotate the controller with `@ApiTags` so it appears in `/docs`.
4. Regenerate `@montaj/api-client` and run the contract test.
