import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { CommonAuditService } from "../../common/audit/audit.service.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

export const PROVIDER_DELETION_FOLLOWUP_TASK = "scheduler.provider-deletion-followup";

/** Daily (06-data-model.md §Retention jobs: "provider deletion follow-ups"). */
const PROVIDER_DELETION_FOLLOWUP_CRON = "50 2 * * *";
const BATCH = 200;

/**
 * A registry of the third-party deletion APIs the platform can call today.
 *
 * Empty: none of the providers this codebase integrates with (Sarvam,
 * ElevenLabs, AssemblyAI, Anthropic, OpenAI, the GPU provider) exposed a
 * confirmed per-artefact deletion endpoint at the time of writing (checked
 * against each provider's public API reference; none publish one a server
 * can call with only the `externalRef` this row has). This is deliberately a
 * lookup a later work package extends, one provider at a time, rather than a
 * generic HTTP call built against nothing.
 */
const PROVIDER_DELETE_APIS: ReadonlyMap<
  string,
  (input: { readonly externalRef: string; readonly endpoint: string | null }) => Promise<boolean>
> = new Map();

export interface ProviderDeletionFollowupReport {
  readonly autoConfirmed: number;
  /** Rows with no known provider API — logged for a human to action by hand. */
  readonly manualTasksLogged: number;
}

/**
 * `provider_submissions.deleteRequestedAt` marks a third-party artefact (an ASR
 * upload, a TTS render, an LLM completion log — whatever `artefact_kind` says)
 * that the erasure cascade or a DSR asked deleted from the vendor's own
 * systems, which this API does not control.
 *
 * For a provider in {@link PROVIDER_DELETE_APIS}, the deletion call is made and
 * `deleteConfirmedAt` is stamped only once the provider itself confirms — never
 * speculatively, so `deleteConfirmedAt` stays true to its name.
 *
 * For every other provider (today, all of them — see the registry's own
 * comment) there is nothing to call: the row is left exactly as it is and one
 * `audit_log` entry summarises the batch still outstanding, tagged so an
 * operator's dashboard query (`action = 'privacy.provider_deletion.manual_task'`)
 * finds every provider row a human still owes a deletion request. Writing a
 * summary rather than mutating a row is what keeps two runs of this task
 * idempotent in the counts that matter (acceptance criterion 2): the same rows
 * are still outstanding, so the same count is still reported.
 */
@Injectable()
export class ProviderDeletionFollowupTask implements OnModuleInit {
  private readonly logger = new Logger(ProviderDeletionFollowupTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: CommonAuditService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: PROVIDER_DELETION_FOLLOWUP_TASK,
      cron: PROVIDER_DELETION_FOLLOWUP_CRON,
      run: async () => {
        const report = await this.sweep();
        if (report.autoConfirmed > 0 || report.manualTasksLogged > 0) {
          this.logger.log(report, "provider deletion follow-ups swept");
        }
      },
    });
  }

  async sweep(): Promise<ProviderDeletionFollowupReport> {
    const due = await this.prisma.providerSubmission.findMany({
      where: { deleteRequestedAt: { not: null }, deleteConfirmedAt: null },
      select: { id: true, provider: true, externalRef: true, endpoint: true, workspaceId: true },
      take: BATCH,
    });
    if (due.length === 0) return { autoConfirmed: 0, manualTasksLogged: 0 };

    let autoConfirmed = 0;
    const manual: typeof due = [];

    for (const row of due) {
      const call = PROVIDER_DELETE_APIS.get(row.provider);
      if (call === undefined || row.externalRef === null) {
        manual.push(row);
        continue;
      }
      try {
        const confirmed = await call({ externalRef: row.externalRef, endpoint: row.endpoint });
        if (confirmed) {
          await this.prisma.providerSubmission.update({
            where: { id: row.id },
            data: { deleteConfirmedAt: new Date() },
          });
          autoConfirmed += 1;
        } else {
          manual.push(row);
        }
      } catch (error) {
        this.logger.warn(
          { provider: row.provider, err: error instanceof Error ? error.message : String(error) },
          "provider deletion call failed; left for the next pass",
        );
        manual.push(row);
      }
    }

    if (manual.length > 0) {
      await this.audit.record({
        action: "privacy.provider_deletion.manual_task",
        resource: "provider_submission",
        actorKind: "system",
        data: {
          count: manual.length,
          providers: [...new Set(manual.map((row) => row.provider))],
          ids: manual.map((row) => row.id),
        },
      });
    }

    return { autoConfirmed, manualTasksLogged: manual.length };
  }
}
