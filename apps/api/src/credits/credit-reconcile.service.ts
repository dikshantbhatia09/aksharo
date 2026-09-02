import { Injectable, Logger } from "@nestjs/common";

import { PrismaService } from "../common/prisma/prisma.service.js";

export interface AccountReconciliation {
  readonly accountId: string;
  readonly workspaceId: string;
  readonly balanceTenths: number;
  readonly lotsSumTenths: number;
  readonly ledgerSumTenths: number;
  /** `true` when `balanceTenths === lotsSumTenths === ledgerSumTenths` (06 invariant 1). */
  readonly ok: boolean;
  /** `balanceTenths - lotsSumTenths`; zero when `ok`. */
  readonly lotsDriftTenths: number;
  /** `balanceTenths - ledgerSumTenths`; zero when `ok`. */
  readonly ledgerDriftTenths: number;
}

/**
 * `reconcile(accountId)` — 06 invariant 1 as a detection query: recomputes
 * `Σ credit_lots.remaining_tenths` and `Σ credit_ledger.delta_tenths` for an
 * account and compares both against the cached `credit_accounts.balance_tenths`.
 *
 * **Detection only, never correction.** The three numbers are supposed to be
 * inseparable — every mutating method in {@link LedgerCreditsFacade} moves all
 * three in one transaction — so drift here means something wrote outside that
 * discipline (a hand edit, a bug, a restored backup that missed a table) and the
 * fix belongs to a human who can see which of the three is wrong, not to a
 * nightly job silently overwriting one number to match the others.
 *
 * B16's nightly reconciliation job calls {@link reconcileAll} and pages on any
 * mismatch (04 §Entitlement enforcement, 06 §Retention jobs); `docs/runbooks/
 * billing-reconcile.md` and `tools/runbooks/billing-reconcile.js` are the manual
 * escape hatch for one account during an incident.
 */
@Injectable()
export class CreditReconcileService {
  private readonly logger = new Logger(CreditReconcileService.name);

  constructor(private readonly prisma: PrismaService) {}

  async reconcile(accountId: string): Promise<AccountReconciliation> {
    const account = await this.prisma.creditAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { id: true, workspaceId: true, balanceTenths: true },
    });

    const [lotsAgg, ledgerAgg] = await Promise.all([
      this.prisma.creditLot.aggregate({
        where: { accountId },
        _sum: { remainingTenths: true },
      }),
      this.prisma.creditLedger.aggregate({
        where: { accountId },
        _sum: { deltaTenths: true },
      }),
    ]);

    const lotsSumTenths = lotsAgg._sum.remainingTenths ?? 0;
    const ledgerSumTenths = ledgerAgg._sum.deltaTenths ?? 0;
    const lotsDriftTenths = account.balanceTenths - lotsSumTenths;
    const ledgerDriftTenths = account.balanceTenths - ledgerSumTenths;
    const ok = lotsDriftTenths === 0 && ledgerDriftTenths === 0;

    if (!ok) {
      this.logger.error(
        {
          accountId,
          workspaceId: account.workspaceId,
          balanceTenths: account.balanceTenths,
          lotsSumTenths,
          ledgerSumTenths,
          lotsDriftTenths,
          ledgerDriftTenths,
        },
        "credit ledger reconciliation drift",
      );
    }

    return {
      accountId: account.id,
      workspaceId: account.workspaceId,
      balanceTenths: account.balanceTenths,
      lotsSumTenths,
      ledgerSumTenths,
      ok,
      lotsDriftTenths,
      ledgerDriftTenths,
    };
  }

  /** Every account, oldest id first. Used by the nightly job and the runbook's `--all`. */
  async reconcileAll(): Promise<readonly AccountReconciliation[]> {
    const accounts = await this.prisma.creditAccount.findMany({
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const results: AccountReconciliation[] = [];
    for (const { id } of accounts) results.push(await this.reconcile(id));
    return results;
  }
}
