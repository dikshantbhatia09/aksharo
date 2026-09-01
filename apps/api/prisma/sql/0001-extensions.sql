-- 0001 — extensions
--
-- `audio_assets.embedding` is `vector(512)` (06 §Content & ops, D44), a type
-- Prisma models as `Unsupported`. The extension therefore has to exist BEFORE the
-- first migration creates that table, which is why the same statement also opens
-- `prisma/migrations/0001_init/migration.sql`. It is repeated here so that the
-- hand-SQL step is self-sufficient: applying `prisma/sql/` against a database that
-- somehow lost the extension repairs it instead of failing three files later.
--
-- The compose Postgres image is `pgvector/pgvector:pg16` (A03 changed it from
-- `postgres:16`); managed Postgres needs `vector` on its allow-list (X05).

CREATE EXTENSION IF NOT EXISTS vector;
