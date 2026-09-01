# infra/terraform

Two root modules — `envs/staging` and `envs/prod` — composing nine reusable
modules. **Nothing here has ever been applied to a cloud account.** Everything is
validated statically: `terraform fmt`, `terraform validate` with a mock backend,
and `tflint` with the AWS ruleset, all run by the `infra-validate` CI job.

## Layout

```
infra/terraform/
  .tflint.hcl                 lint configuration (bundled terraform ruleset + AWS ruleset)
  modules/
    network/                  VPC, three subnet tiers, NAT, S3 gateway endpoint, flow logs
    eks/                      control plane, managed node groups (general + optional GPU), addons, IRSA
    rds-postgres16/           PostgreSQL 16, PITR, encrypted, pg_stat_statements, pgvector
    elasticache-redis7/       Redis 7 for BullMQ, tuned noeviction
    s3-raw/                   raw uploads, ap-south-1, versioned, lifecycle
    r2-derived/               Cloudflare R2 for derived objects, CORS, multipart abort
    secrets/                  KMS + one SSM parameter per CONTRACTS section 1 variable
    dns-cdn/                  Cloudflare records and zone settings for aksharo.ai
    github-oidc/              GitHub Actions deploy role, no long-lived keys
  envs/
    staging/                  cheapest configuration that still exercises every path
    prod/                     three AZs, Multi-AZ Postgres, read replica, 35-day PITR
```

## Running it

```bash
cd infra/terraform/envs/staging

# Validate only. No state, no credentials, no network calls beyond the registry.
terraform init -backend=false
terraform validate
tflint --config ../../.tflint.hcl

# Real use.
cp backend.hcl.example backend.hcl            # gitignored
cp terraform.tfvars.example terraform.tfvars  # gitignored
terraform init -backend-config=backend.hcl
terraform plan -out=tfplan
```

Credentials reach Terraform only through the environment (`AWS_PROFILE`,
`CLOUDFLARE_API_TOKEN`) and never through a file in this repository.

## Design decisions worth knowing

**Written against the providers directly, not against community modules.** The
`terraform-aws-modules/eks` module is excellent and roughly 4,000 lines. Every
IAM permission, every log type and every security-group rule in this cluster is
visible in `modules/eks/main.tf` and reviewable in one sitting, which matters
more here than the convenience does.

**The environments are symmetric on purpose.** Staging runs the same modules with
the same encryption, the same lifecycle rules and the same network policy as
production. It differs in five ways, all of them size:

|                           | staging                                | prod                                                |
| ------------------------- | -------------------------------------- | --------------------------------------------------- |
| Availability zones        | 2                                      | 3                                                   |
| NAT gateways              | 1 (shared)                             | one per zone                                        |
| PostgreSQL                | `db.t4g.medium`, single-AZ, 7-day PITR | `db.m7g.large`, Multi-AZ, read replica, 35-day PITR |
| Redis                     | 1 node                                 | 2 nodes, automatic failover                         |
| Kubernetes API allow-list | defaults to `0.0.0.0/0`                | no default; `0.0.0.0/0` is rejected                 |

A staging environment that differs in _behaviour_ proves nothing.

**No password is ever in Terraform state.** RDS manages and rotates the master
credential in Secrets Manager (`manage_master_user_password`). Every human-supplied
secret is created as a placeholder SSM parameter with
`lifecycle { ignore_changes = [value] }`, so `terraform plan` output contains
parameter names and nothing else (THREAT-MODEL T21).

**The backend is partial.** `backend.tf` declares `backend "s3" {}` with no
values, so the file can be read and validated by anyone, and `terraform init
-backend=false` works in CI with no credentials. Real values live in `backend.hcl`
(gitignored). State locking is native S3 (`use_lockfile = true`, Terraform 1.11+),
so there is no DynamoDB table to forget about.

**Residency is a precondition, not a comment.** `modules/s3-raw` fails the plan if
the provider region is not the residency region (THREAT-MODEL T24). Creating the
raw bucket in the wrong region is a compliance incident, not a typo to fix later.

## Cost notes

Order-of-magnitude monthly figures for `ap-south-1`, at on-demand rates, to make
the shape of the bill legible. Not a budget.

| Line              | staging                    | prod                                                        | Note                                                                                                                                                                              |
| ----------------- | -------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EKS control plane | USD 73                     | USD 73                                                      | Flat, per cluster.                                                                                                                                                                |
| General nodes     | 2 × `m7g.large` ≈ USD 120  | 3 × `m7g.xlarge` ≈ USD 360 baseline                         | Graviton is roughly 20 % cheaper per vCPU than the x86 equivalent; every image is built multi-arch.                                                                               |
| NAT gateway       | 1 × ≈ USD 33 + data        | 3 × ≈ USD 99 + data                                         | **The data charge usually exceeds the hourly one.** The S3 gateway endpoint in `modules/network` keeps media traffic off it entirely, which is the single largest avoidable line. |
| RDS               | `db.t4g.medium` ≈ USD 60   | `db.m7g.large` Multi-AZ ≈ USD 340, plus a replica ≈ USD 170 | Multi-AZ roughly doubles the instance cost and buys a synchronous standby.                                                                                                        |
| ElastiCache       | `cache.t4g.small` ≈ USD 25 | 2 × `cache.m7g.large` ≈ USD 240                             | Not burstable in prod: a broker that exhausts CPU credits looks exactly like an outage.                                                                                           |
| S3 raw            | small                      | scales with ingest                                          | Lifecycle purges raw media 7 days after the last job, so this stays roughly flat rather than growing forever.                                                                     |
| R2 derived        | USD 0.015/GB-month         | same                                                        | **Egress is free**, which is the whole point of decision D35.                                                                                                                     |
| Serverless GPU    | none (scale to zero)       | warm floor ≈ USD 290–1,150                                  | See `infra/gpu/COST.md`, which shows the arithmetic.                                                                                                                              |

Three levers that matter more than instance sizing:

1. **The S3 gateway endpoint.** Without it, every byte a worker reads from S3
   crosses the NAT gateway at USD 0.045/GB. With media workloads that is the
   difference between a rounding error and the largest line on the bill.
2. **R2 for anything a client downloads** (decision D35). Egress from S3 to the
   internet is USD 0.109/GB; from R2 it is zero.
3. **Scale to zero.** Every KEDA-scaled worker has `minReplicaCount: 0` in
   staging. An idle staging environment should cost the control plane, the
   baseline nodes and the databases, and nothing else.

## Module reference

Each module documents every variable inline. The ones with a README of their own
because they encode a decision rather than a resource:

- [`modules/r2-derived`](modules/r2-derived/README.md) — why R2 lifecycle cannot
  express plan retention under the frozen `CONTRACTS §6` keys, Fable's ruling
  that the scheduler (B16) owns it instead, and what that costs.

## What still needs a human

Everything marked `[H]` in [`../README.md`](../README.md). In short: the AWS and
Cloudflare accounts, the state bucket, the domain registration, and every real
secret value.
