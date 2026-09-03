import { describe, expect, it, vi } from "vitest";

import {
  PARTNER_USAGE_REPORT_RETRY_TASK,
  PartnerUsageReportRetryTask,
} from "./partner-usage-report-retry.task.js";

import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import type { PartnerCatalogueService } from "../../partner-catalogue/partner-catalogue.service.js";

function harness(
  due: Array<{ id: string; clearanceGrantId: string | null; exportId: string | null }>,
  reportUsageImpl: (input: {
    grantId: string;
    exportId: string;
  }) => Promise<{ reportRef: string; reportedAt: Date }> = async () => ({
    reportRef: "ref",
    reportedAt: new Date("2026-09-10T00:00:00.000Z"),
  }),
) {
  const prisma = {
    assetUsage: {
      findMany: vi.fn(async () => due),
      update: vi.fn(async () => ({})),
    },
  };
  const partnerCatalogue = { reportUsage: vi.fn(reportUsageImpl) };
  const scheduler = { register: vi.fn() };
  const task = new PartnerUsageReportRetryTask(
    prisma as unknown as PrismaService,
    partnerCatalogue as unknown as PartnerCatalogueService,
    scheduler as unknown as ScheduledTasksService,
  );
  return { task, prisma, partnerCatalogue, scheduler };
}

describe("registration", () => {
  it("registers on a 15-minute cron, not a timer", () => {
    const { task, scheduler } = harness([]);
    task.onModuleInit();
    const registered = scheduler.register.mock.calls[0]?.[0] as { name: string; cron?: string };
    expect(registered.name).toBe(PARTNER_USAGE_REPORT_RETRY_TASK);
    expect(registered.cron).toBeTypeOf("string");
  });
});

describe("sweep", () => {
  it("reports every due, well-formed row and stamps reportedAt/reportRef", async () => {
    const { task, prisma, partnerCatalogue } = harness([
      { id: "u1", clearanceGrantId: "g1", exportId: "e1" },
      { id: "u2", clearanceGrantId: "g2", exportId: "e2" },
    ]);
    await expect(task.sweep()).resolves.toEqual({ reported: 2, stillFailing: 0 });
    expect(partnerCatalogue.reportUsage).toHaveBeenCalledWith({ grantId: "g1", exportId: "e1" });
    expect(partnerCatalogue.reportUsage).toHaveBeenCalledWith({ grantId: "g2", exportId: "e2" });
    expect(prisma.assetUsage.update).toHaveBeenCalledTimes(2);
  });

  it("a row with no clearanceGrantId or exportId counts as still failing, no call made", async () => {
    const { task, partnerCatalogue } = harness([
      { id: "u1", clearanceGrantId: null, exportId: "e1" },
      { id: "u2", clearanceGrantId: "g2", exportId: null },
    ]);
    await expect(task.sweep()).resolves.toEqual({ reported: 0, stillFailing: 2 });
    expect(partnerCatalogue.reportUsage).not.toHaveBeenCalled();
  });

  it("a reportUsage failure is caught, logged, and left for the next pass — the sweep does not throw", async () => {
    const { task } = harness([{ id: "u1", clearanceGrantId: "g1", exportId: "e1" }], async () => {
      throw new Error("partner catalogue is disabled");
    });
    await expect(task.sweep()).resolves.toEqual({ reported: 0, stillFailing: 1 });
  });

  it("is idempotent: nothing due sweeps to zero with no calls", async () => {
    const { task, partnerCatalogue } = harness([]);
    await expect(task.sweep()).resolves.toEqual({ reported: 0, stillFailing: 0 });
    expect(partnerCatalogue.reportUsage).not.toHaveBeenCalled();
  });
});
