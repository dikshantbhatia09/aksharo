# infra

Infrastructure as code for the Aksharo platform (engineering codename `montaj`).
Implemented by **X05**.

**Nothing here has been applied to a real cloud account.** Every artefact is
validated statically by the `infra-validate` CI job; applying any of it is a
deliberate human act, described below.

## Layout

| Path             | Contents                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `terraform/`     | Two environments (`staging`, `prod`) over nine modules. [README](terraform/README.md)                                   |
| `k8s/montaj/`    | Helm chart: 7 deployments, HPA, KEDA, PDBs, network policies, external-secrets, ingress. [README](k8s/montaj/README.md) |
| `gpu/`           | Serverless GPU endpoint definition and cost model (decision D15). [README](gpu/README.md)                               |
| `observability/` | Metric contract, Grafana dashboards, Prometheus alert rules. [README](observability/README.md)                          |
| `scripts/`       | Contract-parity and network-policy checks run by CI.                                                                    |

Operational procedures live in [`docs/runbooks/`](../docs/runbooks/README.md).

## Constraints that are already fixed

- **Data residency (THREAT-MODEL T24, `05 §9`).** Raw media and the database stay
  in `ap-south-1`. `modules/s3-raw` fails the plan if the provider region is
  anything else — a bucket in the wrong region is a compliance incident, not a
  typo. Derived objects go to Cloudflare R2 with an APAC location hint.
- **Secrets (THREAT-MODEL T21).** Every variable in `CONTRACTS §1` is an SSM
  parameter under `/montaj/{env}/`, encrypted with a per-environment KMS key and
  projected into the cluster by external-secrets. Terraform never handles a real
  secret value. CI fails if the SSM map, the chart and `CONTRACTS §1` disagree,
  or if anything credential-shaped is committed.
- **GPU (decision D15).** Per-second serverless GPU with a warm floor of one per
  region. The reserved GPU node group exists in the `eks` module behind
  `enable_gpu_node_group`, defaulted off until roughly 150,000 media-minutes a
  month.
- **Egress (decision D35).** Anything a client downloads comes from R2, where
  egress is free. The S3 gateway endpoint keeps worker-to-S3 traffic off the NAT
  gateway.
- **Retention (ruling, 2026-09-02).** `CONTRACTS §6` keys are frozen, and R2
  lifecycle can only match a literal key prefix, so plan retention (Free 7 d,
  Starter 30 d, Creator 90 d, Studio/Agency 365 d) is **swept by the scheduler in
  B16**, not enforced by storage. S3 still enforces what it can express:
  non-current versions expire after 7 days, abandoned multipart uploads after 1.
  The `montaj_storage_bytes{retention_class}` panel is the check that the sweep
  is running.
- **pgvector.** The parameter group allow-lists the `vector` extension, because
  A03's first migration opens with `CREATE EXTENSION IF NOT EXISTS vector` for
  `audio_assets.embedding vector(512)` (decision D44).

---

# Bootstrap order

Steps marked **[H]** need a human with real credentials. No agent and no CI job
holds them, and none of them can be automated away — they are account creation,
domain registration and secret entry.

Each step assumes the previous one succeeded. Run the whole sequence for
`staging` before starting `prod`.

### 1. Accounts and the state bucket — **[H]**

1. **AWS account** for the environment, with a Terraform admin role. Separate
   accounts for staging and prod is the better shape; one account works if
   exactly one environment sets `create_github_oidc_provider = true` (an account
   holds one OIDC provider per issuer).
2. **Cloudflare account** with R2 enabled. Note the account id.
3. **Terraform state bucket**, created by hand — it has to exist before
   Terraform can store state in it:
   ```bash
   aws s3api create-bucket --bucket montaj-tfstate-ap-south-1 \
     --region ap-south-1 --create-bucket-configuration LocationConstraint=ap-south-1
   aws s3api put-bucket-versioning --bucket montaj-tfstate-ap-south-1 \
     --versioning-configuration Status=Enabled
   aws s3api put-public-access-block --bucket montaj-tfstate-ap-south-1 \
     --public-access-block-configuration \
     BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
   # Then a KMS key aliased montaj-tfstate, and default encryption pointing at it.
   ```
   Versioning is not optional: it is the only way back from a corrupted state
   file. Native S3 locking (`use_lockfile = true`) needs no DynamoDB table.

### 2. Domain and zone — **[H]**

Register `aksharo.ai` and add it to Cloudflare (Wave 0 item **A00-12**, which is
also where brand approval and the trademark filings live — do not spend on the
brand before that item closes). Note the zone id.

### 3. Terraform

```bash
cd infra/terraform/envs/staging
cp backend.hcl.example backend.hcl                 # fill in the state bucket
cp terraform.tfvars.example terraform.tfvars       # fill in account and zone ids

export AWS_PROFILE=montaj-staging
export CLOUDFLARE_API_TOKEN=...                    # R2 admin + DNS edit on the zone

terraform init -backend-config=backend.hcl
terraform plan -out=tfplan                         # read every line
terraform apply tfplan
```

Roughly 25 minutes, most of it the EKS control plane and RDS. Records for `app.`
and `api.` are created pointing at TEST-NET-1 (`192.0.2.1`), which cannot route
anywhere — step 7 repoints them.

### 4. Fill in the secrets — **[H]**

Terraform created one SSM parameter per `CONTRACTS §1` variable. Eleven hold real
values it computed; the rest hold `REPLACE_ME_SEE_infra_README_H_ITEMS` and are
waiting for you.

```bash
terraform output human_supplied_parameters
```

| Parameter                                                           | Where it comes from                                                                                                                                                                           | Blocked on                                                               |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`                                                      | Assembled from the RDS-managed secret — see the snippet below                                                                                                                                 | —                                                                        |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`                                 | `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048` on a machine that is not this cluster                                                                                          | —                                                                        |
| `INTERNAL_CALLBACK_SECRET`                                          | `openssl rand -hex 32`                                                                                                                                                                        | —                                                                        |
| `INTERNAL_CALLBACK_SECRET_NEXT`                                     | Leave the placeholder. It only holds a real value during a rotation (`docs/runbooks/rotate-secrets.md` section B), and it must never be deleted: a missing key fails the whole ExternalSecret | —                                                                        |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY`                                    | Prefer IRSA and leave the placeholder. Only fill in for a workload that genuinely cannot assume a role                                                                                        | —                                                                        |
| `R2_ACCESS_KEY`, `R2_SECRET_KEY`                                    | Cloudflare dashboard, an API token scoped to this bucket. R2 has no IRSA equivalent, so these are genuinely static                                                                            | —                                                                        |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`              | Google Cloud console, OAuth client with PKCE                                                                                                                                                  | —                                                                        |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Razorpay dashboard                                                                                                                                                                            | **A00-02** (account, international activation)                           |
| `SARVAM_API_KEY`, `ELEVENLABS_API_KEY`, `ASSEMBLYAI_API_KEY`        | Each provider's console                                                                                                                                                                       | **A00-06** — do not populate before the DPA is signed (THREAT-MODEL T18) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`                               | Each provider's console                                                                                                                                                                       | **A00-06**                                                               |
| `SENTRY_DSN`, `POSTHOG_KEY`                                         | Project settings in each tool                                                                                                                                                                 | —                                                                        |

`DATABASE_URL`, assembled from the secret RDS manages and rotates:

```bash
ENV=staging
SECRET_ARN=$(terraform output -raw postgres_master_user_secret_arn)
HOST=$(terraform output -raw postgres_endpoint)
CREDS=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text)
USER=$(echo "$CREDS" | python -c 'import json,sys; print(json.load(sys.stdin)["username"])')
PASS=$(echo "$CREDS" | python -c 'import json,sys,urllib.parse; print(urllib.parse.quote(json.load(sys.stdin)["password"], safe=""))')

aws ssm put-parameter --name "/montaj/$ENV/DATABASE_URL" \
  --value "postgresql://$USER:$PASS@$HOST/montaj?schema=public&sslmode=require" \
  --type SecureString --key-id "alias/montaj-$ENV-secrets" --overwrite
unset CREDS PASS
```

The password is URL-encoded because an unencoded `@` or `/` produces a connection
string that parses wrongly and fails confusingly three layers in.

Never pass a secret as a shell argument — it lands in your history. Use
`read -rs` or a file, and `--overwrite` on the SSM call.

### 5. Cluster add-ons

The chart depends on CRDs from these; install them first, in this order:

| Add-on                  | Why                                      | Notes                                                                          |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| `external-secrets`      | Projects SSM into Kubernetes Secrets     | Annotate its service account with `terraform output external_secrets_role_arn` |
| `keda`                  | Queue-depth autoscaling                  | Provides `ScaledObject`                                                        |
| `ingress-nginx`         | Ingress                                  | Its Service creates the load balancer whose hostname step 7 needs              |
| `cert-manager`          | TLS certificates                         | Plus a `ClusterIssuer` named in the chart's ingress annotations                |
| `kube-prometheus-stack` | Metrics, alerting, Grafana               | Provides `PrometheusRule`                                                      |
| OpenTelemetry collector | Traces and metrics from the applications | Endpoint is in the chart's `config`                                            |

```bash
aws eks update-kubeconfig --name montaj-staging --region ap-south-1

kubectl -n external-secrets annotate serviceaccount external-secrets \
  "eks.amazonaws.com/role-arn=$(terraform output -raw external_secrets_role_arn)" --overwrite
```

### 6. Fill in the chart values

Three fields in `k8s/montaj/values-staging.yaml` come from `terraform output` and
have no sensible default:

```bash
terraform output -raw vpc_cidr_block   # -> networkPolicy.vpcCidr
terraform output -raw redis_url        # -> redis.address (host:port, no scheme)
# image.registry is the account's ECR registry
```

An empty `redis.address` makes every KEDA scaler read nothing, which looks
exactly like an empty queue. The chart's NOTES warn about it; heed the warning.

### 7. Deploy, then repoint DNS — **[H]** for the DNS step

Follow [`docs/runbooks/deploy.md`](../docs/runbooks/deploy.md). Its "First deploy
of an environment" section covers the one-time steps. The last of them:

```bash
kubectl -n ingress-nginx get svc ingress-nginx-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}{"\n"}'
```

Put that hostname into `ingress_target` in the environment's tfvars and apply.
Until then `terraform output dns_targets_are_placeholders` is `true` and the
environment is not reachable — which is the correct state for a half-built
environment.

### 8. Observability

```bash
kubectl -n observability apply -f infra/observability/alerts/montaj-alerts.yaml
# Import both dashboards from infra/observability/dashboards/ into Grafana.
```

### 9. Serverless GPU — **[H]**

[`gpu/README.md`](gpu/README.md). Build and push the model-server image, create
the endpoint, and put the endpoint id and API key into SSM. Read
[`gpu/COST.md`](gpu/COST.md) before enabling the warm floor: below roughly 2,500
media-minutes a month it costs more than the cold starts it prevents.

---

# Every [H] item in one list

| #   | Item                                                                   | Blocks                                               | Wave 0 dependency |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------- | ----------------- |
| H1  | AWS account and Terraform admin role                                   | everything                                           | —                 |
| H2  | Cloudflare account with R2                                             | R2 bucket, DNS                                       | —                 |
| H3  | Terraform state bucket, versioned and encrypted                        | `terraform init`                                     | —                 |
| H4  | `aksharo.ai` registered and in Cloudflare                              | DNS, TLS                                             | **A00-12**        |
| H5  | Kubernetes API allow-list CIDRs (office, VPN, CI)                      | prod plan fails without them                         | —                 |
| H6  | JWT keypair, generated offline                                         | auth                                                 | —                 |
| H7  | `INTERNAL_CALLBACK_SECRET`                                             | worker callbacks                                     | —                 |
| H8  | `INTERNAL_CALLBACK_SECRET_NEXT` (placeholder only, outside a rotation) | callback-secret rotation without dropped completions | —                 |
| H9  | `DATABASE_URL` from the RDS-managed secret                             | every service                                        | —                 |
| H10 | R2 API token                                                           | derived storage                                      | H2                |
| H11 | Google OAuth client                                                    | sign-in                                              | —                 |
| H12 | Razorpay credentials                                                   | billing                                              | **A00-02**        |
| H13 | ASR provider keys                                                      | transcription                                        | **A00-06** (DPA)  |
| H14 | LLM provider keys                                                      | chapters, hooks, prompted edits                      | **A00-06** (DPA)  |
| H15 | Sentry DSN, PostHog key                                                | observability                                        | —                 |
| H16 | ECR registry and first image push                                      | deploy                                               | —                 |
| H17 | Cluster add-ons installed                                              | chart install                                        | H1                |
| H18 | DNS repointed at the ingress load balancer                             | reachability                                         | H4, H17           |
| H19 | RunPod (or Modal) account, endpoint, API key                           | GPU ASR                                              | —                 |
| H20 | GitHub environments `staging` and `production`, with reviewers         | OIDC deploy                                          | H1                |

The provider keys behind **A00-06** carry a rule that is not merely procedural:
do not populate them before the DPA is signed. THREAT-MODEL T18 and the privacy
commitments in `05 §9` both depend on the contract terms being in place _before_
the first byte of user media reaches that provider.

---

# Validation

```bash
# Terraform
cd infra/terraform/envs/staging && terraform init -backend=false && terraform validate
cd infra/terraform && tflint --recursive --config "$(pwd)/.tflint.hcl"
terraform fmt -check -recursive infra/terraform

# Helm
helm lint infra/k8s/montaj
helm template montaj infra/k8s/montaj -f infra/k8s/montaj/values-staging.yaml > /tmp/staging.yaml
kubeconform -strict -kubernetes-version 1.33.0 -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
  /tmp/staging.yaml

# Contracts and policy
python3 infra/scripts/check-contracts-parity.py
python3 infra/scripts/check-network-policy.py /tmp/staging.yaml

# Alert rules
python3 infra/observability/scripts/extract-rules.py infra/observability/alerts/montaj-alerts.yaml > /tmp/rules.yaml
promtool check rules /tmp/rules.yaml
```

All of the above runs in CI as the `infra-validate` job
(`.github/workflows/infra.yml`), which holds no cloud credentials and cannot
reach a cloud account.
