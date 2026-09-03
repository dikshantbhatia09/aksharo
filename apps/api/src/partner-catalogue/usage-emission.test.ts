import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { reportPartnerUsageForExport } from "./usage-emission.js";

import type { PartnerCatalogueService } from "./partner-catalogue.service.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";

function fakePrisma(rows: { id: string; clearanceGrantId: string | null }[]) {
  const updates: { id: string; data: Record<string, unknown> }[] = [];
  return {
    assetUsage: {
      findMany: vi.fn(async () => rows),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          updates.push({ id: where.id, data });
          return {};
        },
      ),
    },
    __updates: updates,
  };
}

describe("reportPartnerUsageForExport (D04b2 scope §3)", () => {
  const logger = new Logger("test");

  it("is a no-op while the flag is off", async () => {
    const prisma = fakePrisma([{ id: "u1", clearanceGrantId: "g1" }]);
    const partnerCatalogue = {
      enabled: false,
      reportUsage: vi.fn(),
    } as unknown as PartnerCatalogueService;

    await reportPartnerUsageForExport(
      prisma as unknown as PrismaService,
      partnerCatalogue,
      logger,
      {
        workspaceId: "ws",
        projectId: "proj",
        exportId: "exp",
      },
    );

    expect(prisma.assetUsage.findMany).not.toHaveBeenCalled();
    expect(partnerCatalogue.reportUsage).not.toHaveBeenCalled();
  });

  it("stamps exportId/exportedAt then reports usage for every due row, idempotently by row", async () => {
    const prisma = fakePrisma([
      { id: "u1", clearanceGrantId: "g1" },
      { id: "u2", clearanceGrantId: "g2" },
    ]);
    const reportUsage = vi
      .fn()
      .mockResolvedValueOnce({ reportRef: "ref-1", reportedAt: "2026-09-03T00:00:00.000Z" })
      .mockResolvedValueOnce({ reportRef: "ref-2", reportedAt: "2026-09-03T00:00:00.000Z" });
    const partnerCatalogue = { enabled: true, reportUsage } as unknown as PartnerCatalogueService;

    await reportPartnerUsageForExport(
      prisma as unknown as PrismaService,
      partnerCatalogue,
      logger,
      {
        workspaceId: "ws",
        projectId: "proj",
        exportId: "exp-1",
      },
    );

    expect(reportUsage).toHaveBeenCalledTimes(2);
    expect(reportUsage).toHaveBeenCalledWith({ grantId: "g1", exportId: "exp-1" });
    expect(reportUsage).toHaveBeenCalledWith({ grantId: "g2", exportId: "exp-1" });

    // Each row: first the exportId/exportedAt stamp, then the reportedAt/reportRef write.
    const u1Updates = prisma.__updates.filter((u) => u.id === "u1");
    expect(u1Updates).toHaveLength(2);
    expect(u1Updates[0]?.data).toMatchObject({ exportId: "exp-1" });
    expect(u1Updates[1]?.data).toMatchObject({ reportRef: "ref-1" });
  });

  it("leaves the row stamped-but-unreported (for the retry sweep) when reportUsage throws", async () => {
    const prisma = fakePrisma([{ id: "u1", clearanceGrantId: "g1" }]);
    const reportUsage = vi.fn().mockRejectedValue(new Error("partner API down"));
    const partnerCatalogue = { enabled: true, reportUsage } as unknown as PartnerCatalogueService;

    await expect(
      reportPartnerUsageForExport(prisma as unknown as PrismaService, partnerCatalogue, logger, {
        workspaceId: "ws",
        projectId: "proj",
        exportId: "exp-1",
      }),
    ).resolves.toBeUndefined();

    // Only the exportId/exportedAt stamp landed — reportedAt/reportRef never wrote.
    expect(prisma.__updates).toHaveLength(1);
    expect(prisma.__updates[0]?.data).toMatchObject({ exportId: "exp-1" });
  });
});
