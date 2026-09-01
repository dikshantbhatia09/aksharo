# @montaj/api

NestJS modular monolith — one feature module per work package
(`05-system-architecture.md` section 3). Postgres via Prisma, Redis/BullMQ for jobs,
OpenAPI as the contract that generates `@montaj/api-client`.

**Status:** A01 scaffold — config, health and OpenAPI only.

## Run

```bash
docker compose up -d                 # from the repo root
pnpm --filter @montaj/api dev        # http://localhost:3001
```

| Endpoint         | Purpose                                                          |
| ---------------- | ---------------------------------------------------------------- |
| `GET /health`    | liveness: `{ "status": "ok", "version": "0.1.0" }`               |
| `GET /docs`      | Swagger UI                                                       |
| `GET /docs-json` | OpenAPI JSON — the source `@montaj/api-client` is generated from |

## Configuration

`src/config/config.module.ts` loads the nearest `.env` (walking up to the repo
root, real environment variables always win), validates it with
`loadEnv()` from `@montaj/config`, and exposes it under the `ENV` token:

```ts
constructor(@Inject(ENV) private readonly env: Env) {}
```

Validation is fail-fast: a missing or malformed variable aborts startup with a
message naming every offending variable, before the port is bound. Never read
`process.env` directly in a module — inject `ENV` so tests can substitute it.

## Database

`prisma/schema.prisma` is intentionally **empty** (datasource + generator only).
The data model is designed in **A03** from `03-architecture/06-data-model.md`.

Anything Prisma cannot express — partial indexes, pgvector, triggers, RLS, the
single-statement conditional credit reserve — is hand-written SQL in
[`prisma/sql/`](prisma/sql/README.md) and applied from a migration.

```bash
pnpm --filter @montaj/api db:migrate   # prisma migrate deploy (guarded: no-op until A03)
pnpm --filter @montaj/api db:seed      # placeholder until A03
```

## Tests

```bash
pnpm --filter @montaj/api test        # unit (src/**/*.test.ts) + e2e (test/**/*.e2e-spec.ts)
pnpm --filter @montaj/api test:e2e    # e2e only
```

Vitest runs through `unplugin-swc` because NestJS DI needs `emitDecoratorMetadata`,
which esbuild cannot produce. `test/setup-env.ts` seeds a complete valid
environment so tests never depend on a developer's `.env`; the A01 e2e suite
needs no running infrastructure.

## Adding a module

1. `src/<feature>/<feature>.module.ts`, controller, service, DTOs.
2. Register it in `src/app.module.ts`.
3. Annotate the controller with `@ApiTags` so it appears in `/docs`.
4. Regenerate `@montaj/api-client` and run the contract test.
