import { Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { PrismaService } from "../common/prisma/prisma.service.js";

import type { $Enums } from "@prisma/client";

export interface LotView {
  readonly id: string;
  readonly source: $Enums.CreditLotSource;
  readonly grantedTenths: number;
  readonly remainingTenths: number;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface CreditsSummaryView {
  readonly workspaceId: string;
  readonly balanceTenths: number;
  readonly monthlyGrantTenths: number;
  readonly grantResetAt: string | null;
  /** Live lots (`remainingTenths > 0`), soonest-expiring first then FIFO — the
   *  same order `reserve` consumes them in. */
  readonly lots: readonly LotView[];
}

export interface UsageEntryView {
  readonly id: string;
  readonly deltaTenths: number;
  readonly kind: $Enums.CreditLedgerKind;
  readonly refType: string;
  readonly refId: string | null;
  readonly lotId: string | null;
  readonly balanceAfterTenths: number;
  readonly at: string;
  /** The job's queue, when `refType === "job"` and that job still exists — the
   *  per-job attribution the usage page renders next to each ledger line. */
  readonly jobType: string | null;
}

export interface UsagePage {
  readonly items: readonly UsageEntryView[];
  readonly nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * The read side of the ledger: `GET /workspaces/{id}/credits` (balance, next
 * reset, live lots) and `GET /workspaces/{id}/usage` (ledger history, per-job
 * attribution, cursor pagination) — brief §7.
 *
 * Deliberately separate from {@link LedgerCreditsFacade}: that class is
 * mutation-only (CONTRACTS §4 plus the reversal/expiry/reset surface beyond it),
 * and giving it read methods too would make "does this touch the balance" a
 * question a reviewer has to answer per-method instead of per-file.
 */
@Injectable()
export class CreditsQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(workspaceId: string): Promise<CreditsSummaryView> {
    const account = await this.prisma.creditAccount.upsert({
      where: { workspaceId },
      create: {
        id: ulid(),
        workspaceId,
        balanceTenths: 0,
        monthlyGrantTenths: 0,
        grantResetAt: null,
      },
      update: {},
    });

    const lots = await this.prisma.creditLot.findMany({
      where: { accountId: account.id, remainingTenths: { gt: 0 } },
      orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }],
    });

    return {
      workspaceId,
      balanceTenths: account.balanceTenths,
      monthlyGrantTenths: account.monthlyGrantTenths,
      grantResetAt: account.grantResetAt?.toISOString() ?? null,
      lots: lots.map((lot) => ({
        id: lot.id,
        source: lot.source,
        grantedTenths: lot.grantedTenths,
        remainingTenths: lot.remainingTenths,
        expiresAt: lot.expiresAt?.toISOString() ?? null,
        createdAt: lot.createdAt.toISOString(),
      })),
    };
  }

  async getUsage(
    workspaceId: string,
    options: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<UsagePage> {
    const account = await this.prisma.creditAccount.findUnique({ where: { workspaceId } });
    if (account === null) return { items: [], nextCursor: null };

    const take = clampLimit(options.limit);
    const rows = await this.prisma.creditLedger.findMany({
      where: { accountId: account.id },
      orderBy: { id: "desc" },
      ...(options.cursor === undefined ? {} : { cursor: { id: options.cursor }, skip: 1 }),
      take: take + 1,
    });

    const page = rows.length <= take ? rows : rows.slice(0, take);
    const nextCursor = rows.length <= take ? null : (page[page.length - 1]?.id ?? null);

    const jobIds = [
      ...new Set(page.filter((r) => r.refType === "job").map((r) => r.refId ?? "")),
    ].filter((id) => id !== "");
    const jobs =
      jobIds.length === 0
        ? []
        : await this.prisma.job.findMany({
            where: { id: { in: jobIds } },
            select: { id: true, type: true },
          });
    const jobTypeById = new Map(jobs.map((j) => [j.id, j.type]));

    return {
      items: page.map((row) => ({
        id: row.id,
        deltaTenths: row.deltaTenths,
        kind: row.kind,
        refType: row.refType,
        refId: row.refId,
        lotId: row.lotId,
        balanceAfterTenths: row.balanceAfterTenths,
        at: row.at.toISOString(),
        jobType:
          row.refType === "job" && row.refId !== null ? (jobTypeById.get(row.refId) ?? null) : null,
      })),
      nextCursor,
    };
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}
