import { Module } from "@nestjs/common";

import { AccessLogPurgeTask } from "./tasks/access-log-purge.task.js";
import { DeviceCodeExpiryTask } from "./tasks/device-code-expiry.task.js";
import { EvalNightlyTask } from "./tasks/eval-nightly.task.js";
import { ExportFilingReportTask } from "./tasks/export-filing-report.task.js";
import { ExportRetentionTask } from "./tasks/export-retention.task.js";
import { LedgerReconciliationTask } from "./tasks/ledger-reconciliation.task.js";
import { MediaRetentionTask } from "./tasks/media-retention.task.js";
import { MemoryEntryExpiryTask } from "./tasks/memory-entry-expiry.task.js";
import { ProjectRetentionTask } from "./tasks/project-retention.task.js";
import { ProviderDeletionFollowupTask } from "./tasks/provider-deletion-followup.task.js";
import { RenewalDunningTask } from "./tasks/renewal-dunning.task.js";
import { ShareReportSlaTask } from "./tasks/share-report-sla.task.js";
import { UsageReportTask } from "./tasks/usage-report.task.js";
import { BillingModule } from "../billing/billing.module.js";
import { MediaModule } from "../media/media.module.js";

/**
 * The scheduled tasks B16 owns directly (`06-data-model.md` §Retention jobs).
 *
 * Every task here registers itself with `ScheduledTasksService` from its own
 * `onModuleInit` (the A08 primitive, `common/scheduler`) — this module's only
 * job is to construct them and give them the feature services they call.
 *
 * Not here: `credits/tasks/*` (grant reset, lot expiry — B02's own),
 * `affiliates/tasks/*` (commission maturation, payout batch — B07's own),
 * `streak/*.task.ts` (B06's own), `jobs/tasks/*` (A08/A08c's own). Those
 * modules registered their own schedule directly against the same primitive,
 * ahead of this work package landing; duplicating them here would double-run
 * the sweep. See the final report's "already covered" table.
 */
@Module({
  imports: [MediaModule, BillingModule],
  providers: [
    MediaRetentionTask,
    ProjectRetentionTask,
    ExportRetentionTask,
    DeviceCodeExpiryTask,
    RenewalDunningTask,
    MemoryEntryExpiryTask,
    ProviderDeletionFollowupTask,
    AccessLogPurgeTask,
    ShareReportSlaTask,
    LedgerReconciliationTask,
    ExportFilingReportTask,
    UsageReportTask,
    EvalNightlyTask,
  ],
})
export class SchedulerTasksModule {}
