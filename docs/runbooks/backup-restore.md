# Runbook — backups and the restore drill

`05-system-architecture.md` §10: "Backups: PITR on Postgres; versioned EDG
snapshots; quarterly restore drills." This is the index that ties the three
real procedures together and the **local, scripted drill** this work package
adds so "quarterly restore drill" is not only a sentence on a checklist.

## The three things that get backed up

| Store                                                                                                | Mechanism                                                         | Procedure                                                                            |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Postgres** (users, projects, transcripts, `edg_revisions`, `edg_snapshots`, everything relational) | RDS automated backups + PITR, 7 days staging / 35 days production | [restore-from-pitr.md](restore-from-pitr.md)                                         |
| **S3 raw media** (`ws/.../raw.*`)                                                                    | Bucket versioning, non-current versions kept 7 days               | Covered inside [restore-from-pitr.md](restore-from-pitr.md) §3                       |
| **R2 derived** (proxies, exports, waveforms, fonts)                                                  | Not versioned, and deliberately not backed up                     | Regenerated from raw media by re-running the media jobs; there is nothing to restore |

## EDG snapshot restore (A12) is not a separate procedure

`edg_snapshots` (a full projection written every 100 `edg_revisions`, so replay
stays bounded) and `edg_revisions` (the append-only semantic-op log) are
ordinary Postgres tables — `apps/api/prisma/schema.prisma`'s `EdgSnapshot` and
`EdgRevision` models. A Postgres PITR restore already brings them back exactly
as they stood at the restore point; there is no separate EDG backup to manage
and no extra step to run. What _is_ worth checking after any restore, before
declaring an edited project usable again:

```sql
-- The snapshot and every revision after it must exist together, or replay breaks.
SELECT edg_id, max(revision) FROM edg_snapshots GROUP BY edg_id;
SELECT edg_id, max(revision) FROM edg_revisions GROUP BY edg_id;
```

If a project's latest `edg_revisions.revision` is behind its `edg_snapshots`
row (should never happen — the snapshot writer only fires after the revision
commits, same transaction), replay from the snapshot forward will simply stop
early; treat that project as needing manual review, not automatic replay.

## The scripted local drill: `scripts/ops/restore-drill.mjs`

The quarterly drill described in `restore-from-pitr.md`'s last section runs
the _whole_ runbook against a real staging RDS instance — the only thing that
proves the actual PITR window works. That is deliberately not automated (it
costs a real restore-time RDS instance and needs a human watching cutover).

What **is** automated, and safe to run in CI or on a laptop against the local
`docker compose` stack, is the part that is easy to silently rot: _does a dump
of the schema actually restore into an empty database and come up clean?_ —
migrations apply in order, the seed smoke passes, nothing was silently broken
by a migration that only ever ran incrementally on a database that already had
the tables.

```bash
# From the repo root, compose stack up (docker compose, not from a worktree):
node scripts/ops/restore-drill.mjs
```

What it does, every step against `montaj_restore_drill` (a scratch database it
creates and drops itself — never touches `montaj`, `montaj_test`, or any
work-package database):

1. `pg_dump` the database named by `RESTORE_DRILL_SOURCE_URL` (defaults to
   `DATABASE_URL`) — this stands in for "the latest backup" locally, since
   there is no RDS snapshot to pull in a compose stack.
2. Drop and recreate `montaj_restore_drill`.
3. `psql` the dump into it.
4. Run `prisma migrate deploy` against it (proves every migration in
   `apps/api/prisma/migrations/` still applies cleanly, in order, from
   whatever the dump captured).
5. Run the seed smoke: `prisma/seed.ts` against the restored database, then a
   handful of read queries (`SELECT count(*) FROM users`, `projects`,
   `edg_snapshots`) that must return non-zero.
6. Drop `montaj_restore_drill` and print a timed summary.

Exit code is non-zero on any failure, so a CI job can gate on it. It never
touches S3/R2 or the real backup mechanism — it is a schema-and-seed integrity
check, not a substitute for the real quarterly drill above.

### CI

`.github/workflows/ops-restore-drill.yml` runs this weekly (`schedule:`) against
the CI compose stack, `workflow_dispatch` for an on-demand run. It is a dry run
in the sense that it never touches a cloud account — everything happens inside
the job's own compose stack, torn down with the runner.

### Running it yourself right now

```bash
docker compose up -d postgres          # from the repo root, not a worktree
node scripts/ops/restore-drill.mjs
```

If it fails, the failure is almost always one of:

- A migration that assumes a column/enum value only present because of a
  previous migration's `UPDATE`, not its own `CREATE` — i.e., a migration
  that is not actually replayable from a bare dump.
- `prisma/seed.ts` assuming rows created by a different work package's manual
  testing rather than by the seed itself.

Both are real bugs the drill exists to catch, not drill bugs to work around.
