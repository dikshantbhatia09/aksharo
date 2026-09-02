# `scheduler/` — B16

The scheduled tasks B16 owns directly, registered against the A08 primitive
(`common/scheduler/scheduled-tasks.service.ts`). Each task in `tasks/` is a
small class that constructs in its own `onModuleInit` and does one thing:

| Task                                 | Schedule | What                                                                                                                                                                                                |
| ------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `media-retention.task.ts`            | hourly   | Wires A06's `RetentionService.purgeDueMedia()` — object deletes then row updates, for `rawPurgeAt` and `derivedPurgeAt`.                                                                            |
| `project-retention.task.ts`          | daily    | −14 d `retention-warning` email (idempotency-keyed, not a written flag); past `retentionUntil`, soft-deletes the project and pulls its media's purge dates forward so the media task picks them up. |
| `export-retention.task.ts`           | hourly   | Deletes expired `exports` objects (row kept, `storageKey` nulled) and expired `export_manifests` rows outright.                                                                                     |
| `device-code-expiry.task.ts`         | hourly   | Deletes expired `device_codes`/`bridge_pairings`.                                                                                                                                                   |
| `renewal-dunning.task.ts`            | daily    | Wires B01's `RenewalService.initiateRenewal`/`graceExpiry`.                                                                                                                                         |
| `memory-entry-expiry.task.ts`        | daily    | Deletes `memory_entries` past their own `expiresAt`.                                                                                                                                                |
| `provider-deletion-followup.task.ts` | daily    | Calls a registered provider deletion API, or logs one audit summary of the manual queue.                                                                                                            |
| `access-log-purge.task.ts`           | daily    | 1-year retention on `access_logs`.                                                                                                                                                                  |
| `share-report-sla.task.ts`           | hourly   | Pages (one `audit_log` row) on any unresolved `share_reports` past `dueAt`.                                                                                                                         |
| `ledger-reconciliation.task.ts`      | daily    | Compares `credit_accounts.balance_tenths` against each account's newest `credit_ledger` row; pages on mismatch, never corrects.                                                                     |
| `export-filing-report.task.ts`       | monthly  | GSTR-1 aggregate over unclaimed `invoices` for the prior month; idempotent via `gstr1Period`.                                                                                                       |
| `usage-report.task.ts`               | monthly  | A stub, per the brief: counts succeeded jobs and `asset_usages` rows for the prior month.                                                                                                           |

**Not here.** `credits/tasks/*` (B02), `affiliates/tasks/*` (B07's commission
maturation and payout batch), `streak/*.task.ts` (B06) and `jobs/tasks/*`
(A08/A08c) registered themselves against the same primitive before this work
package landed; duplicating them here would double-run the sweep.

**Manual trigger.** Every task, including the ones registered elsewhere, is
listed at `GET /admin/scheduler/tasks` and can be run out of band with
`POST /admin/scheduler/tasks/:name/run` (`admin/scheduler/`), behind
`AdminGuard`.
