# Runbook — rollback

The release is bad. Get back to the last good one.

**Rollback is cheap and reversible; diagnosis under load is neither.** If the
symptom started within an hour of a deploy, roll back first and diagnose from
the logs afterwards.

---

## 1. Roll back the application

```bash
ENV=staging                      # or prod
NS=montaj

helm -n "$NS" history montaj     # find the last REVISION with status "deployed"
helm -n "$NS" rollback montaj <REVISION> --wait --timeout 10m
```

With no revision number Helm goes back exactly one release, which is usually
what you want:

```bash
helm -n "$NS" rollback montaj --wait --timeout 10m
```

Verify:

```bash
for c in api web realtime worker-media worker-ai render scheduler; do
  kubectl -n "$NS" rollout status "deploy/montaj-$c" --timeout=5m
done
kubectl -n "$NS" get pods -l app.kubernetes.io/instance=montaj
```

## 2. The database question

**A Helm rollback does not roll back a migration.** Decide which case you are in
before doing anything else:

| Case                                                                                               | What to do                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The migration was additive (new nullable column, new table, new index) and the old code ignores it | Nothing. Leave the schema ahead of the code. This is the normal case and the reason migrations must be backward compatible.                                                                                  |
| The migration was destructive (dropped or renamed a column, narrowed a type)                       | The old code will fail against the new schema. Do **not** run a down-migration under load: go forward with a fix instead, or accept the outage and restore per [restore-from-pitr.md](restore-from-pitr.md). |
| The migration failed part-way                                                                      | The schema is in an unknown state. Stop. [restore-from-pitr.md](restore-from-pitr.md).                                                                                                                       |

A down-migration on a live production database is almost always the wrong
answer: it destroys the data written since the deploy, and that data belongs to
users who did nothing wrong.

## 3. Drain the damage

A bad release usually leaves work behind it.

```bash
# Jobs that failed during the bad window are in the dead-letter queue.
kubectl -n "$NS" exec deploy/montaj-api -- node dist/scripts/dlq-stats.js
```

Two things need attention, in this order:

1. **Credit holds.** Every job reserves credits before enqueue and settles or
   releases them on completion (CONTRACTS section 4). A job killed mid-flight may
   hold credits that were never spent. Find and release them:
   ```bash
   kubectl -n "$NS" exec deploy/montaj-api -- node dist/scripts/credits-orphaned-holds.js --since "2h ago"
   ```
   Leaving this undone turns an outage into a billing dispute.
2. **The DLQ.** Replay per [dlq-replay.md](dlq-replay.md), but only after you are
   confident the failure cause is gone. Replaying into a broken release just
   burns the retry budget again.

## 4. Roll back an infrastructure change

Terraform has no `rollback`. What it has is a previous state version and a git
history.

```bash
cd infra/terraform/envs/$ENV
git log --oneline -- .                 # find the commit before the change
git checkout <good-sha> -- .
terraform init -backend-config=backend.hcl
terraform plan -out=tfplan              # read every line
terraform apply tfplan
```

Before applying, check what the plan proposes to destroy:

```bash
terraform show -json tfplan \
  | python -c "import json,sys; [print(c['address'], c['change']['actions']) for c in json.load(sys.stdin)['resource_changes'] if c['change']['actions'] != ['no-op']]"
```

**Stop if the plan touches any of these:**

- `aws_db_instance` — a replace destroys the database.
- `aws_elasticache_replication_group` — a replace loses every queued job.
- `aws_s3_bucket` — a replace destroys raw user media, and the bucket cannot be
  recreated under the same name for a while afterwards.
- `aws_kms_key` — scheduling a key for deletion makes everything it encrypted
  unreadable when the window expires.

For those, the answer is a targeted fix forward, not a wholesale revert.

## 5. Roll back a bad secret rotation

If the release broke because a rotated secret is wrong, do not roll back the
deploy — fix the parameter and let external-secrets re-project it:

```bash
aws ssm put-parameter --name "/montaj/$ENV/INTERNAL_CALLBACK_SECRET" \
  --value "$OLD_VALUE" --type SecureString --overwrite

kubectl -n "$NS" annotate externalsecret montaj-env \
  force-sync="$(date +%s)" --overwrite
kubectl -n "$NS" rollout restart deploy -l app.kubernetes.io/instance=montaj
```

See [rotate-secrets.md](rotate-secrets.md) for why `INTERNAL_CALLBACK_SECRET` in
particular must be rotated with both values accepted for a window.

## 6. Write it down

Before you close the incident:

- Which revision was bad, and which is now running.
- Whether the schema is ahead of the code, and if so, in what way.
- Whether any credit holds were released by hand.
- Whether the DLQ was replayed or discarded, and how many jobs.

An hour of this now saves the next person the whole investigation.
