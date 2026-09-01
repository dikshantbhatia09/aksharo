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

## Convention

```
sql/
  0001-extensions.sql        one file per concern, zero-padded and ordered
  0002-credit-ledger.sql
```

Every file must be **idempotent** (`CREATE ... IF NOT EXISTS`, `CREATE OR REPLACE`)
so re-running a migration is safe.

## How a file is applied

1. Add the `.sql` file here.
2. Create the migration: `pnpm --filter @montaj/api exec prisma migrate dev --create-only --name <name>`.
3. Paste (or `\i`) the statements into the generated `migration.sql`. Prisma applies
   migrations verbatim, so the hand-written SQL travels with the schema change and
   `prisma migrate deploy` reproduces it exactly in staging and production.
4. Record any Prisma-invisible object in `prisma/schema.prisma` as a comment so
   `prisma db pull` cannot silently drop it.

Owner: **A03**. A01 created the folder and this convention only.
