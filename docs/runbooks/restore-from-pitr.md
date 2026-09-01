# Runbook — restore from point-in-time recovery

Data was destroyed or corrupted and you need a point in time back.

**PITR window:** `backup_retention_days` on the RDS instance —
**7 days in staging, 35 days in production**. Confirm the live value rather than
trusting this sentence:

```bash
terraform -chdir=infra/terraform/envs/$ENV output postgres_pitr_window_days
```

Outside that window there is no recovery. This is also the number the privacy
notice quotes, because a PITR window means deleted personal data survives in
backups for that long (decision D47 requires the window to be documented with
replay tombstones).

---

## 0. Stop the bleeding first

A restore into a system that is still corrupting data restores corruption.

```bash
ENV=prod
NS=montaj

# Stop writers. The API stays up so users get an error page rather than silence.
kubectl -n "$NS" scale deploy/montaj-scheduler --replicas=0
kubectl -n "$NS" scale deploy/montaj-worker-media deploy/montaj-worker-ai deploy/montaj-render --replicas=0

# Stop KEDA scaling them back up.
kubectl -n "$NS" patch scaledobject montaj-worker-ai    --type merge -p '{"spec":{"maxReplicaCount":0}}'
kubectl -n "$NS" patch scaledobject montaj-worker-media --type merge -p '{"spec":{"maxReplicaCount":0}}'
kubectl -n "$NS" patch scaledobject montaj-render       --type merge -p '{"spec":{"maxReplicaCount":0}}'
```

Then write down, before touching anything: **what happened, at what time (UTC),
and how you know**. The restore target depends on that timestamp and you will not
reconstruct it later.

## 1. Choose the restore point

```bash
SRC=montaj-$ENV
aws rds describe-db-instances --db-instance-identifier "$SRC" \
  --query 'DBInstances[0].LatestRestorableTime'
```

Pick a time **one minute before** the first bad write, not the moment you
noticed. `LatestRestorableTime` is typically about five minutes behind now.

```bash
RESTORE_TIME="2026-09-02T10:14:00Z"
TARGET="$SRC-restore-$(date -u +%Y%m%d%H%M)"
```

## 2. Restore to a NEW instance

Never restore in place. RDS will not do it, and you want the original intact
while you verify.

```bash
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "$SRC" \
  --target-db-instance-identifier "$TARGET" \
  --restore-time "$RESTORE_TIME" \
  --db-subnet-group-name "$SRC" \
  --vpc-security-group-ids "$(terraform -chdir=infra/terraform/envs/$ENV output -raw postgres_security_group_id 2>/dev/null || echo REPLACE)" \
  --db-parameter-group-name "$SRC-postgres16" \
  --no-publicly-accessible \
  --deletion-protection

aws rds wait db-instance-available --db-instance-identifier "$TARGET"
```

Restoring a large instance takes 20–60 minutes. It runs unattended; use the time
for step 3.

## 3. Work out what else has to move with it

The database is not the only stateful thing, and a restore that ignores the rest
leaves the system internally inconsistent.

| Store                                        | What a restore does to it                                                                             | What to do                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **S3 raw media** (`ws/.../raw.*`)            | Versioned, with non-current versions kept 7 days. Objects deleted inside that window are recoverable. | Restore specific objects by deleting the delete marker (below). Objects older than 7 non-current days are gone. |
| **R2 derived** (proxies, exports, waveforms) | Not versioned.                                                                                        | Do not try to recover. Everything here is regenerable from raw media; re-run the media jobs after the restore.  |
| **Redis / BullMQ**                           | Jobs enqueued after the restore point reference rows that no longer exist.                            | Drain and discard the queues (step 5). Replaying them would fail against the restored schema.                   |
| **Credit ledger**                            | Restored with the database. Anything settled between the restore point and now is undone.             | Reconcile against the payment provider before reopening (step 6). This is real money.                           |

Recovering a deleted S3 object inside the versioning window:

```bash
BUCKET=$(terraform -chdir=infra/terraform/envs/$ENV output -raw s3_raw_bucket)
KEY="ws/01H.../p/01H.../media/01H.../raw.mp4"

aws s3api list-object-versions --bucket "$BUCKET" --prefix "$KEY" \
  --query 'DeleteMarkers[0].VersionId' --output text
aws s3api delete-object --bucket "$BUCKET" --key "$KEY" --version-id "<that-id>"
```

## 4. Verify the restored instance before cutting over

Connect to `$TARGET` from a debug pod and check that it is what you think it is:

```sql
-- Is the data actually there?
SELECT count(*) FROM projects;
SELECT max(created_at) FROM edg_revisions;

-- Does the timeline stop where you asked?
SELECT max(created_at) FROM job_events;

-- Is the parameter group applied? pg_stat_statements needs a reboot to load.
SHOW shared_preload_libraries;
SELECT count(*) FROM pg_stat_statements;
```

If `pg_stat_statements` is missing, reboot the restored instance once — the
parameter group is attached but `shared_preload_libraries` is `pending-reboot`.

## 5. Cut over

```bash
# 1. Rename the old instance out of the way.
aws rds modify-db-instance --db-instance-identifier "$SRC" \
  --new-db-instance-identifier "$SRC-broken-$(date -u +%Y%m%d)" --apply-immediately
aws rds wait db-instance-available --db-instance-identifier "$SRC-broken-$(date -u +%Y%m%d)"

# 2. Rename the restored instance into its place, so DATABASE_URL keeps working.
aws rds modify-db-instance --db-instance-identifier "$TARGET" \
  --new-db-instance-identifier "$SRC" --apply-immediately
aws rds wait db-instance-available --db-instance-identifier "$SRC"

# 3. Flush the queues. Jobs from the lost window reference rows that no longer
#    exist; replaying them produces errors, not recovery.
kubectl -n "$NS" exec deploy/montaj-api -- node dist/scripts/queue-drain.js --all --confirm

# 4. Bring the workers back.
kubectl -n "$NS" patch scaledobject montaj-worker-ai    --type merge -p '{"spec":{"maxReplicaCount":20}}'
kubectl -n "$NS" patch scaledobject montaj-worker-media --type merge -p '{"spec":{"maxReplicaCount":24}}'
kubectl -n "$NS" patch scaledobject montaj-render       --type merge -p '{"spec":{"maxReplicaCount":24}}'
kubectl -n "$NS" scale deploy/montaj-scheduler --replicas=1
kubectl -n "$NS" rollout restart deploy -l app.kubernetes.io/instance=montaj
```

**Do not delete the old instance.** Keep it until the incident is closed: it is
the only copy of the data written between the restore point and the incident,
and someone will want it.

## 6. Reconcile money

Between the restore point and now, users may have paid for things the restored
database has no record of. Before reopening billing:

```bash
kubectl -n "$NS" exec deploy/montaj-api -- \
  node dist/scripts/billing-reconcile.js --since "$RESTORE_TIME" --dry-run
```

Compare against the payment provider's records for the same window. Credit
purchases that succeeded at Razorpay but vanished in the restore must be
re-applied by hand. **Err towards the user**: a wrongly granted credit costs a
few rupees, a wrongly removed one costs a customer.

## 7. Terraform state

Renaming instances outside Terraform makes the state wrong. Reconcile before the
next apply, or the next plan will propose to recreate your database:

```bash
cd infra/terraform/envs/$ENV
terraform plan          # expect a diff on aws_db_instance
terraform apply -refresh-only
terraform plan          # must now be clean
```

## 8. Write the record

Decision D47 requires deletion evidence and a documented PITR window with replay
tombstones. A restore is the case where those meet: data a user asked to have
deleted may have come back.

Record and act on:

- The restore point, the window restored, and who authorised it.
- **Any erasure request settled between the restore point and now.** Those
  deletions were undone by the restore and must be re-applied:
  ```bash
  kubectl -n "$NS" exec deploy/montaj-api -- \
    node dist/scripts/privacy-replay-tombstones.js --since "$RESTORE_TIME"
  ```
- Whether personal data was exposed at any point. If so,
  [breach-first-hour.md](breach-first-hour.md) and its notification clock apply.

## Restore drills

`05 §10` requires a quarterly restore drill. Run this whole runbook against
staging with a real restore, time it, and record the number. A PITR window you
have never exercised is a belief, not a backup.
