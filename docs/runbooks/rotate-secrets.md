# Runbook — rotate secrets

Planned rotation, or a credential you believe is exposed.

Every credential in CONTRACTS section 1 lives in AWS SSM Parameter Store under
`/montaj/{ENV}/`, encrypted with that environment's KMS key, and reaches pods
through external-secrets. Terraform creates the parameter and then ignores its
value forever (THREAT-MODEL T21) — so rotation is an SSM write plus a re-sync,
never a `terraform apply`.

**If you are here because a credential leaked, go to
[breach-first-hour.md](breach-first-hour.md) first, then come back.**

---

## The two kinds of rotation

| Kind               | Which credentials                                                                                                                                          | Method                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Cut-over**       | Anything a single side holds: provider API keys, OAuth client secrets, R2 tokens                                                                           | Replace the value, re-sync, restart. Brief failures while pods pick it up.                        |
| **Two-key window** | Anything two sides must agree on at the same instant: `INTERNAL_CALLBACK_SECRET` (via `INTERNAL_CALLBACK_SECRET_NEXT`), `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` | Accept both old and new for a window, then retire the old. A straight swap breaks in-flight work. |

Getting this wrong on `INTERNAL_CALLBACK_SECRET` rejects every completion
callback from every worker mid-flight (THREAT-MODEL T8) — jobs that already did
the expensive work fail at the last step, and their credit holds go stale.

---

## A. Cut-over rotation

Example: `ELEVENLABS_API_KEY`.

```bash
ENV=staging
NS=montaj
NAME=ELEVENLABS_API_KEY
```

1. **[H]** Create the new credential at the provider. Do not revoke the old one
   yet.
2. Write it to SSM. Read the value from a file or a prompt, never as a shell
   argument — an argument lands in your shell history:
   ```bash
   read -rs -p "new $NAME: " NEW_VALUE; echo
   aws ssm put-parameter \
     --name "/montaj/$ENV/$NAME" \
     --value "$NEW_VALUE" \
     --type SecureString \
     --key-id "alias/montaj-$ENV-secrets" \
     --overwrite
   unset NEW_VALUE
   ```
3. Force external-secrets to re-project immediately rather than waiting for the
   refresh interval:
   ```bash
   kubectl -n "$NS" annotate externalsecret montaj-env force-sync="$(date +%s)" --overwrite
   kubectl -n "$NS" wait --for=condition=Ready externalsecret/montaj-env --timeout=2m
   ```
4. Restart the components that read it. For a provider key, that is the AI
   worker:
   ```bash
   kubectl -n "$NS" rollout restart deploy/montaj-worker-ai
   kubectl -n "$NS" rollout status  deploy/montaj-worker-ai --timeout=5m
   ```
5. Confirm it works before revoking the old one: run one job through the
   provider and watch `montaj_provider_errors_total{error_kind="auth"}` stay at
   zero.
6. **[H]** Revoke the old credential at the provider.

## B. Two-key rotation — `INTERNAL_CALLBACK_SECRET`

The API verifies `X-Montaj-Signature` on every worker callback. Workers and the
API must not disagree for even a second, or every completion callback from every
worker is rejected mid-flight (THREAT-MODEL T8) — jobs that already did the
expensive work fail at the last step, and their credit holds go stale.

`INTERNAL_CALLBACK_SECRET_NEXT` exists for exactly this window. It is optional in
`CONTRACTS §1`: while it holds a real value the API accepts a callback signed
with **either** key (behaviour owned by A08). Terraform creates it as a
placeholder, so the parameter always exists.

> **Never delete the parameter.** `external-secrets` fails the whole
> `ExternalSecret` when any listed key is missing, which would take down every
> pod's entire environment, not just this one value. Retiring the second key
> means resetting it to the placeholder, which step 5 does.

1. Generate a new secret:

   ```bash
   ENV=staging
   NS=montaj
   NEW=$(openssl rand -hex 32)
   ```

2. Publish it as the **secondary** key, keeping the primary as it is:

   ```bash
   aws ssm put-parameter --name "/montaj/$ENV/INTERNAL_CALLBACK_SECRET_NEXT" \
     --value "$NEW" --type SecureString \
     --key-id "alias/montaj-$ENV-secrets" --overwrite
   ```

3. Sync and restart the **API only**. It now accepts both; workers still sign
   with the old key.

   ```bash
   kubectl -n "$NS" annotate externalsecret montaj-env force-sync="$(date +%s)" --overwrite
   kubectl -n "$NS" wait --for=condition=Ready externalsecret/montaj-env --timeout=2m
   kubectl -n "$NS" rollout restart deploy/montaj-api
   kubectl -n "$NS" rollout status  deploy/montaj-api --timeout=5m
   ```

4. Promote: set `INTERNAL_CALLBACK_SECRET` to the new value, sync, and restart
   the workers. They now sign with the new key, which the API already accepts.

   ```bash
   aws ssm put-parameter --name "/montaj/$ENV/INTERNAL_CALLBACK_SECRET" \
     --value "$NEW" --type SecureString \
     --key-id "alias/montaj-$ENV-secrets" --overwrite

   kubectl -n "$NS" annotate externalsecret montaj-env force-sync="$(date +%s)" --overwrite
   kubectl -n "$NS" rollout restart deploy/montaj-worker-ai deploy/montaj-worker-media deploy/montaj-render
   ```

5. Wait for the longest in-flight job to finish — `montaj_queue_depth{state="active"}`
   reaches zero across every queue — then retire the second key by resetting it
   to the placeholder, and restart the API:

   ```bash
   aws ssm put-parameter --name "/montaj/$ENV/INTERNAL_CALLBACK_SECRET_NEXT" \
     --value "REPLACE_ME_SEE_infra_README_H_ITEMS" --type SecureString \
     --key-id "alias/montaj-$ENV-secrets" --overwrite

   kubectl -n "$NS" annotate externalsecret montaj-env force-sync="$(date +%s)" --overwrite
   kubectl -n "$NS" rollout restart deploy/montaj-api
   ```

   Leaving a real second key in place indefinitely would quietly double the
   number of secrets that can authorise a credit settlement.

6. Watch `montaj_job_callback_rejected_total{reason="bad_signature"}` throughout.
   It must stay at zero. If it moves, put the old value back into
   `INTERNAL_CALLBACK_SECRET` immediately — the secondary key from step 2 is
   still valid, so there is always a way back until step 5.

## C. Two-key rotation — JWT signing keys

Access tokens live 15 minutes and refresh tokens are opaque (CONTRACTS section
5), so a key rotation drains itself in about fifteen minutes if the verifier
accepts both keys during the window.

1. Generate a keypair **offline**, on a machine that is not this cluster:
   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt-new.key
   openssl rsa -in jwt-new.key -pubout -out jwt-new.pub
   ```
2. Publish the new **public** key first, as the secondary verification key.
   Verification must accept the new key before anything signs with it.
3. Wait one full access-token lifetime (15 minutes).
4. Swap `JWT_PRIVATE_KEY` to the new private key. New tokens are now signed with
   it and verified by the key published in step 2.
5. Wait another 15 minutes, then remove the old public key.
6. `shred -u jwt-new.key` on the machine that generated it. The only copy that
   should survive is the one in SSM.

If the private key was **exposed**, skip the window: swap immediately, revoke
every refresh-token family, and force re-authentication. Sessions are cheap;
forged tokens are not.

## D. Database password

Managed by RDS, not by you: `manage_master_user_password = true` puts it in
Secrets Manager with AWS rotation.

```bash
SECRET_ARN=$(terraform -chdir=infra/terraform/envs/$ENV output -raw postgres_master_user_secret_arn)
aws secretsmanager rotate-secret --secret-id "$SECRET_ARN"
```

Then rebuild `DATABASE_URL` from the rotated secret and write it to SSM:

```bash
HOST=$(terraform -chdir=infra/terraform/envs/$ENV output -raw postgres_endpoint)
CREDS=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text)
USER=$(echo "$CREDS" | python -c 'import json,sys; print(json.load(sys.stdin)["username"])')
PASS=$(echo "$CREDS" | python -c 'import json,sys,urllib.parse; print(urllib.parse.quote(json.load(sys.stdin)["password"], safe=""))')

aws ssm put-parameter --name "/montaj/$ENV/DATABASE_URL" \
  --value "postgresql://$USER:$PASS@$HOST/montaj?schema=public&sslmode=require" \
  --type SecureString --key-id "alias/montaj-$ENV-secrets" --overwrite
unset CREDS PASS
```

Sync, then restart `api`, `scheduler` and every worker. Note the URL-encoding of
the password: an unencoded `@` or `/` in a generated password produces a
connection string that parses wrongly and fails in a confusing way.

## E. Object-storage credentials

- **S3** — prefer IRSA and leave `S3_ACCESS_KEY` / `S3_SECRET_KEY` at their
  placeholders. If a static key genuinely exists, rotate it as a cut-over, and
  create the new key before deleting the old (IAM allows two per user precisely
  for this).
- **R2** — no IRSA equivalent, so `R2_ACCESS_KEY` / `R2_SECRET_KEY` are always
  static. **[H]** Create a new API token in the Cloudflare dashboard scoped to
  this bucket, rotate as a cut-over, then delete the old token.

---

## Rotation schedule

| Credential                           | Interval                                        | Why                                                                                                                                           |
| ------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` | 90 days                                         | Signing keys age badly; the window makes it painless.                                                                                         |
| `INTERNAL_CALLBACK_SECRET`           | 90 days                                         | Internal, but it authorises credit settlement. Rotated through `INTERNAL_CALLBACK_SECRET_NEXT`, which is reset to its placeholder afterwards. |
| Provider API keys                    | 180 days, or on staff change                    | Vendor-side exposure is outside our control.                                                                                                  |
| `RAZORPAY_*`                         | 180 days, or immediately on any suspicion       | Money.                                                                                                                                        |
| Database master password             | 90 days, automated by RDS                       | Free; no reason not to.                                                                                                                       |
| R2 tokens                            | 180 days                                        | Static by necessity, so rotate on a clock.                                                                                                    |
| KMS keys                             | Automatic yearly rotation, enabled in Terraform | Nothing to do.                                                                                                                                |

## Afterwards

1. Confirm nothing still references the old value:
   ```bash
   kubectl -n "$NS" get pods -l app.kubernetes.io/instance=montaj \
     -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.startTime}{"\n"}{end}'
   ```
   Every pod's start time must be after the rotation.
2. Check the dashboards for a spike in provider auth errors or rejected
   callbacks.
3. Record the rotation: which credential, when, who, and whether the old one was
   revoked. If the rotation was a response to an exposure, that record is
   evidence.
