# Hand-maintained DDL

Prisma's schema language cannot express everything PostgreSQL 16 gives us, and the
data model in `03-architecture/06-data-model.md` needs several of those features.
Anything in that category is written as SQL here and applied from a Prisma
migration, so the migration history stays the single source of truth.

## What belongs here

| Category                                                                      | Why Prisma cannot do it                            |
| ----------------------------------------------------------------------------- | -------------------------------------------------- |
| Partial and expression indexes                                                | not expressible in `@@index`                       |
| `pgvector` columns and HNSW/IVFFlat indexes                                   | 512-d audio and glossary embeddings                |
| Generated / stored columns, `CHECK` constraints beyond field level            | no schema syntax                                   |
| Triggers and functions (audit log, `updated_at`)                              | no schema syntax                                   |
| Row-level security policies                                                   | no schema syntax                                   |
| Concurrency-critical statements (single-statement conditional credit reserve) | written by hand, property-tested (THREAT-MODEL T9) |
| `packed float32 bytea` keyframe columns                                       | mapped as `Bytes`, indexed here                    |

## What is here (A03)

```
0001-extensions.sql   CREATE EXTENSION vector
0002-indexes.sql      partial, NULLS-LAST and HNSW indexes; NULL-safe uniqueness
0003-checks.sql       CHECK constraints for the money and credit invariants of 06
0004-comments.sql     retention rules recorded next to the data they govern
```

Every file is **idempotent** (`CREATE ... IF NOT EXISTS`, `COMMENT ON`, or a `DO`
block that looks the constraint up in `pg_constraint` first), because
`pnpm db:migrate` re-applies all of them on every run. That is deliberate: it turns
"someone dropped an index in staging" from a silent performance cliff into a
self-healing no-op.

## How a file is applied

`pnpm --filter @montaj/api db:migrate` runs `prisma migrate deploy` and then
`scripts/apply-sql.ts`, which executes each file in this folder in lexical order,
one transaction per file, and records the filename and its checksum in
`_montaj_sql_applied` so drift is visible in the database itself.

The two halves are one command on purpose. A database with the Prisma tables but
without the CHECK constraints looks fine and quietly accepts a UPI mandate above
the RBI cap, so there is no state in which only the first half has run.

The **one exception** is `CREATE EXTENSION vector`: `audio_assets.embedding` is
`vector(512)`, so the type has to exist before the migration that creates the
table. That statement therefore also opens
`prisma/migrations/20260902000000_init/migration.sql`. Prisma applies migrations
verbatim, so it travels with the schema change; `0001-extensions.sql` repeats it
only so this folder can repair a database on its own.

## Adding a file

1. Add a **new** numbered `.sql` file — never edit one that has been applied.
2. Make every statement idempotent.
3. Record the object as a comment on the model it belongs to in
   `prisma/schema.prisma`, so `prisma db pull` cannot silently drop it and the
   next reader of the schema knows it exists.
4. Assert it in `test/database.e2e-spec.ts` — by name for an index, and by
   expecting a failure for a constraint.

## Where an index belongs

Plain composite indexes and unique constraints go in `schema.prisma`, so
`prisma migrate diff` can see them and nothing is declared in two places. This
folder is for what Prisma has no syntax for: a `WHERE` predicate, an explicit NULL
ordering, an operator class. Two cases are easy to get wrong:

- **`(edg_id, seq)`, `(transcript_id, revision, chunk_idx)` and
  `(series, fiscal_year, number)`** are named in the A03 brief but ARE expressible
  in Prisma, so they live there; the integration test asserts all of them by name
  regardless of origin.
- **A `UNIQUE` constraint over a nullable column does not constrain the NULL rows**,
  because PostgreSQL treats every NULL as distinct. `@@unique([workspaceId, key])`
  on `style_presets` therefore does nothing for the system styles
  (`workspace_id IS NULL`), and a partial unique index here supplies it.

Owner: **A03**.
