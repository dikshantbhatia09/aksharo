# infra

Terraform, Kubernetes manifests, serverless-GPU configuration and Grafana
dashboards.

**Status:** placeholder — no code yet. The folder exists because
`03-architecture/10-build-plan.md` section 1 puts it in the repository layout.
**Implemented by:** **X05** (Terraform, staging environment, dashboards), with
`03-architecture/05-system-architecture.md` section 1 as the source of truth for
the target topology.

## What will live here

| Path         | Contents                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| `terraform/` | Kubernetes cluster, PostgreSQL 16, Redis 7, S3 (`ap-south-1`), Cloudflare R2, serverless GPU, region routing |
| `k8s/`       | Deployments for `api`, `worker-media`, `worker-ai`, `render`, `scheduler`                                    |
| `grafana/`   | Dashboards fed by OpenTelemetry; per-job cost tags                                                           |

## Constraints that are already fixed

- **Data residency (THREAT-MODEL T24):** raw media and the database stay in
  `ap-south-1`; derived objects go to R2 with an APAC location hint; the region is
  pinned per workspace and the sub-processor list is published.
- **Secrets (THREAT-MODEL T21):** KMS-managed environment, log redaction and
  secret scanning in CI. The variable set is exactly `docs/CONTRACTS.md` section 1
  — take it from `packages/config/src/env.ts` rather than retyping it, so staging
  cannot drift from the schema the applications validate against.
- **GPU:** a warm floor plus burst on the serverless provider (decision D15).
