-- A03b — `edg_segments.seq` becomes a base-62 fractional-index STRING.
--
-- A03 read `06-data-model.md` ("seq numeric") literally and stored NUMERIC,
-- serialising it as a decimal string to satisfy CONTRACTS §2. A02 has since
-- shipped the actual generator: `seqBetween()` in `@montaj/edg` returns base-62
-- keys over the digits `0-9A-Za-z` — `1B`, `Zz`, `zzzV`. Those are not numbers,
-- and no NUMERIC column can hold them. CONTRACTS §2 wins: `seq` is `text`.
--
-- COLLATE "C" is the load-bearing part. The base-62 alphabet is in ASCII order
-- precisely so that string comparison IS fractional-key comparison, which holds
-- only under byte ordering. Under a linguistic collation such as en_US.UTF-8,
-- `a` sorts before `B` and the document silently comes back in the wrong order.
-- The compose Postgres is initialised with `--locale=C`, but managed Postgres
-- usually is not, so the collation is pinned on the column rather than inherited.
--
-- Existing rows: `seq::text` renders NUMERIC as `1.000000000000000000000000000000`,
-- which is not a valid key. Only development databases and test fixtures ever held
-- such rows (no environment has real segments yet), and they are recreated by
-- `db:reset`. The cast is kept explicit so the migration cannot fail on a
-- non-empty table.

ALTER TABLE "edg_segments"
  ALTER COLUMN "seq" TYPE text COLLATE "C" USING "seq"::text;

-- `ALTER COLUMN … TYPE` rebuilds every index on the column. The composite read
-- path the editor pages through is declared in schema.prisma and is recreated by
-- Postgres automatically; this is a belt-and-braces check that it survived.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'edg_segments_edg_id_seq_idx'
  ) THEN
    CREATE INDEX "edg_segments_edg_id_seq_idx" ON "edg_segments" ("edg_id", "seq");
  END IF;
END
$$;
