# @montaj/api

NestJS modular monolith — one feature module per work package
(`05-system-architecture.md` section 3). Postgres via Prisma, Redis/BullMQ for jobs,
OpenAPI as the contract that generates `@montaj/api-client`.

**Status:** A04 — schema, migrations, seed, base modules and **auth**. Projects and
media are A06, jobs are A08.

## Run

```bash
docker compose up -d                       # from the repo root
pnpm --filter @montaj/api db:migrate       # schema + hand SQL
pnpm --filter @montaj/api db:seed          # plans, styles, flags, demo workspace
pnpm --filter @montaj/api dev              # http://localhost:3001
```

| Endpoint            | Purpose                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `GET /health`       | liveness: `{ "status": "ok", "version": "0.1.0" }`                         |
| `GET /health/ready` | readiness: Postgres, Redis and object store; 503 when any is down          |
| `GET /docs`         | Swagger UI                                                                 |
| `GET /docs-json`    | OpenAPI JSON — the source `@montaj/api-client` is generated from           |
| `/auth/*`           | sign-in, sessions, the device grant — see [`src/auth`](src/auth/README.md) |

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

`test/database.e2e-spec.ts` needs a PostgreSQL **with pgvector**. It uses
`TEST_DATABASE_URL` if set, otherwise starts `pgvector/pgvector:pg16` through
testcontainers, and skips with an explanation when Docker is unavailable
(`MONTAJ_SKIP_DB_TESTS=1` skips it deliberately). Every other suite runs with no
infrastructure at all: `test/app-harness.ts` substitutes Prisma and Redis.

## Adding a module

1. `src/<feature>/<feature>.module.ts`, controller, service, DTOs.
2. Register it in `src/app.module.ts`.
3. Annotate the controller with `@ApiTags` so it appears in `/docs`.
4. Guard it: `@UseGuards(JwtAuthGuard, RolesGuard)` on the controller, `@Public()`
   on the routes that genuinely are. `AuthModule` is `@Global()`, so the guards
   resolve without importing anything. The workspace comes from the token's `ws`
   claim — never from a header (THREAT-MODEL T4).
5. Regenerate `@montaj/api-client` (`pnpm gen:client`) and run the contract test.
