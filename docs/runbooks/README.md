# Runbooks

Operational procedures for the Aksharo platform (engineering codename `montaj`).
Authored by **X05**; every alert rule in `infra/observability/alerts/` links to
one of these.

| Runbook                                      | When you reach for it                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| [deploy.md](deploy.md)                       | Shipping a release to staging or production.                                |
| [rollback.md](rollback.md)                   | The release is bad. Get back to the last good one.                          |
| [rotate-secrets.md](rotate-secrets.md)       | Planned rotation, or a credential you believe is exposed.                   |
| [restore-from-pitr.md](restore-from-pitr.md) | Data was destroyed or corrupted and you need a point in time back.          |
| [scale-gpu.md](scale-gpu.md)                 | Transcripts are queueing, or GPU spend is out of line.                      |
| [dlq-replay.md](dlq-replay.md)               | Jobs have exhausted their retries and are sitting in the dead-letter queue. |
| [breach-first-hour.md](breach-first-hour.md) | Suspected compromise or personal-data exposure. Read this one first.        |

## Conventions used throughout

- **[H]** marks a step only a human with real credentials can perform. No agent
  and no CI job holds them.
- Commands assume `AWS_PROFILE` and `KUBECONFIG` point at the environment you
  named out loud before you started. Say it aloud; production and staging differ
  by one word in a shell prompt.
- `ENV` is `staging` or `prod` and appears in every resource name, every SSM
  path (`/montaj/{ENV}/`) and every Helm release.
- Terraform is never applied from a laptop against production without a second
  person watching the plan.

## Before you touch anything

Three questions, in order:

1. **Is user data at risk right now?** If yes, [breach-first-hour.md](breach-first-hour.md)
   comes before everything else here, including fixing the outage.
2. **Is this a bad release?** If the symptom started within an hour of a deploy,
   [rollback.md](rollback.md) is faster than diagnosis and is always reversible.
3. **Is anything still queued?** Jobs hold credit reservations
   (CONTRACTS section 4). An outage that ends with abandoned holds is an outage
   plus a billing dispute. Check `montaj_queue_depth` before you declare it over.

## Escalation

| Role                    | Owns                                                                            |
| ----------------------- | ------------------------------------------------------------------------------- |
| On-call engineer        | Everything below, first response.                                               |
| Dikshant                | [H] credentials, cloud account access, provider accounts.                       |
| Grievance officer       | Named in the privacy notice; the contact for a personal-data breach under DPDP. |
| Data protection counsel | Regulator notification decisions (A00-09, A00-13).                              |
