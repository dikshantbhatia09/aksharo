import { describe, expect, it, vi } from "vitest";

import {
  LEDGER_RECONCILIATION_TASK,
  LedgerReconciliationTask,
} from "./ledger-reconciliation.task.js";

import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

function harness(
  rows: { accountId: string; workspaceId: string; balanceTenths: number; latest: number }[],
) {
  const queryRaw = vi.fn(async () => rows);
  const record = vi.fn(async (_event: Record<string, unknown>) => undefined);
  const prisma = { $queryRaw: queryRaw };
  const audit = { record };
  const scheduler = { register: vi.fn() };
  const task = new LedgerReconciliationTask(
    prisma as unknown as PrismaService,
    audit as unknown as import("../../common/audit/audit.service.js").CommonAuditService,
    scheduler as unknown as ScheduledTasksService,
  );
  return { task, queryRaw, record, scheduler };
}

describe("registration", () => {
  it("registers a daily cron", () => {
    const { task, scheduler } = harness([]);
    task.onModuleInit();
    const registered = scheduler.register.mock.calls[0]?.[0] as { name: string; cron?: string };
    expect(registered.name).toBe(LEDGER_RECONCILIATION_TASK);
    expect(registered.cron).toBeTypeOf("string");
  });
});

describe("reconcile", () => {
  it("reports no mismatches when every account's cache matches its newest ledger row", async () => {
    const { task, record } = harness([
      { accountId: "a1", workspaceId: "w1", balanceTenths: 100, latest: 100 },
      { accountId: "a2", workspaceId: "w2", balanceTenths: 0, latest: 0 },
    ]);
    const report = await task.reconcile();
    expect(report.accountsChecked).toBe(2);
    expect(report.mismatches).toEqual([]);
    expect(record).not.toHaveBeenCalled();
  });

  it("flags an account whose cached balance disagrees with its ledger, and pages once per run", async () => {
    const { task, record } = harness([
      { accountId: "a1", workspaceId: "w1", balanceTenths: 100, latest: 90 },
    ]);
    const report = await task.reconcile();
    expect(report.mismatches).toEqual([
      {
        accountId: "a1",
        workspaceId: "w1",
        balanceTenths: 100,
        latestLedgerBalanceAfterTenths: 90,
      },
    ]);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({ action: "billing.ledger.mismatch" });
  });

  it("is idempotent in the sense that matters: rerunning finds the same mismatches, not new ones", async () => {
    const rows = [{ accountId: "a1", workspaceId: "w1", balanceTenths: 5, latest: 3 }];
    const { task } = harness(rows);
    const first = await task.reconcile();
    const second = await task.reconcile();
    expect(first.mismatches).toEqual(second.mismatches);
  });
});
