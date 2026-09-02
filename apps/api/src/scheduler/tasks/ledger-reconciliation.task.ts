import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { CommonAuditService } from "../../common/audit/audit.service.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

import type { Prisma } from "@prisma/client";

export const LEDGER_RECONCILIATION_TASK = "scheduler.ledger-reconciliation";

/** Daily (06-data-model.md §Retention jobs: "ledger reconciliation report"). */
const LEDGER_RECONCILIATION_CRON = "0 4 * * *";

export interface LedgerMismatch {
  readonly accountId: string;
  readonly workspaceId: string;
  readonly balanceTenths: number;
  readonly latestLedgerBalanceAfterTenths: number;
}

export interface LedgerReconciliationReport {
  readonly accountsChecked: number;
  readonly mismatches: readonly LedgerMismatch[];
}

/**
 * `credit_accounts.balance_tenths` is a **cache** of the ledger (06 invariant
 * 1, `CreditAccount`'s own schema comment): every credits mutation writes a
 * `credit_ledger` row in the same transaction as the balance update, with
 * `balanceAfterTenths` taken from that same `UPDATE`'s `RETURNING`. The two
 * can only drift if that invariant was violated somewhere — a hand-run
 * `UPDATE`, a bug, a restored-from-backup partial write — which is exactly why
 * this checks rather than trusts it: the cache is the fast path every credits
 * read uses, and this is what would ever have to catch the fast path lying.
 *
 * A mismatched account's newest ledger row's `balanceAfterTenths` is compared
 * against the account's current `balanceTenths`; every account with newer
 * activity than its last check is re-verified (there is no cursor — this reads
 * every account with at least one ledger row, which is cheap: one indexed
 * `DISTINCT ON` per account, no full ledger scan).
 *
 * On a mismatch the task pages the same way `ProviderDeletionFollowupTask` and
 * `ShareReportSlaTask` do: an `audit_log` row an operator's alert on
 * `action = 'billing.ledger.mismatch'` can find, plus an `error`-level log line
 * for whatever already scrapes this process's logs (Sentry, per 05 §10). It
 * never repairs the balance itself — a scheduler silently "fixing" money is a
 * worse failure mode than a page.
 */
@Injectable()
export class LedgerReconciliationTask implements OnModuleInit {
  private readonly logger = new Logger(LedgerReconciliationTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: CommonAuditService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: LEDGER_RECONCILIATION_TASK,
      cron: LEDGER_RECONCILIATION_CRON,
      run: async () => {
        const report = await this.reconcile();
        if (report.mismatches.length > 0) {
          this.logger.error(report, "credit ledger reconciliation found a mismatch");
        } else {
          this.logger.log({ accountsChecked: report.accountsChecked }, "credit ledger reconciled");
        }
      },
    });
  }

  async reconcile(): Promise<LedgerReconciliationReport> {
    const rows = await this.prisma.$queryRaw<
      { accountId: string; workspaceId: string; balanceTenths: number; latest: number }[]
    >`
      SELECT a.id AS "accountId", a.workspace_id AS "workspaceId", a.balance_tenths AS "balanceTenths",
             l.balance_after_tenths AS "latest"
      FROM credit_accounts a
      JOIN LATERAL (
        SELECT balance_after_tenths
        FROM credit_ledger
        WHERE account_id = a.id
        ORDER BY at DESC, id DESC
        LIMIT 1
      ) l ON true
    `;

    const mismatches: LedgerMismatch[] = rows
      .filter((row) => row.balanceTenths !== row.latest)
      .map((row) => ({
        accountId: row.accountId,
        workspaceId: row.workspaceId,
        balanceTenths: row.balanceTenths,
        latestLedgerBalanceAfterTenths: row.latest,
      }));

    if (mismatches.length > 0) {
      await this.audit.record({
        action: "billing.ledger.mismatch",
        resource: "credit_account",
        actorKind: "system",
        data: { mismatches } as unknown as Prisma.InputJsonValue,
      });
    }

    return { accountsChecked: rows.length, mismatches };
  }
}
