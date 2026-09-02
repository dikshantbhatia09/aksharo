-- A12 — hand-maintained DDL for the EDG module.
--
-- `edg_revisions.client_op_ids` is the idempotency record: a retried batch is
-- recognised by asking whether any revision already carries one of its op ids,
-- which is the array-overlap operator `&&`. Prisma's `@@index` cannot express a
-- GIN index over a scalar list, so it lives here (see `sql/README.md`), and the
-- model carries a comment naming it so `prisma db pull` cannot silently drop it.
--
-- Without it the check is a sequential scan of every revision of the document,
-- which is the one query on the write path that grows with a project's age.
CREATE INDEX IF NOT EXISTS edg_revisions_client_op_ids_idx
  ON edg_revisions USING gin (client_op_ids);

COMMENT ON INDEX edg_revisions_client_op_ids_idx IS
  'A12: idempotency lookup for POST /projects/{id}/edg/ops (client_op_ids && $1).';
