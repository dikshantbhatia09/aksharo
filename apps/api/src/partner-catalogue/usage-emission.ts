import type { PartnerCatalogueService } from "./partner-catalogue.service.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { Logger } from "@nestjs/common";

/**
 * D04b2 scope §3 — the inline half of usage reporting (B14b `export.completed`
 * precedent; `scheduler/tasks/partner-usage-report-retry.task.ts`'s own doc
 * comment named this file as "outside this work package's file boundary" —
 * D04b2 closes exactly that gap).
 *
 * Called from the render-completion handler right after an `Export` row
 * settles. Every `AssetUsage` row placed in this project that has drawn a
 * partner clearance grant (`clearanceGrantId` set) but has not yet been
 * attributed to an export (`exportedAt` still null) is stamped onto this
 * export and reported to the partner. The stamp
 * (`exportId`/`exportedAt`) is written *before* the network call, in its own
 * update, so a crash mid-report still leaves the row correctly attributed —
 * `PartnerUsageReportRetryTask`'s query (`exportedAt` set, `reportedAt`
 * still null, `clearanceGrantId` set) is exactly the row this leaves behind
 * on failure, so the retry sweep picks it up with no extra bookkeeping here.
 *
 * A no-op while `assets.partnerCatalogue` is off, and a no-op for a project
 * that used no partner asset (`due.length === 0`) — never a required read on
 * the common path.
 */
export async function reportPartnerUsageForExport(
  prisma: PrismaService,
  partnerCatalogue: PartnerCatalogueService,
  logger: Logger,
  params: { readonly workspaceId: string; readonly projectId: string; readonly exportId: string },
): Promise<void> {
  if (!partnerCatalogue.enabled) return;

  const due = await prisma.assetUsage.findMany({
    where: {
      workspaceId: params.workspaceId,
      projectId: params.projectId,
      exportedAt: null,
      clearanceGrantId: { not: null },
    },
    select: { id: true, clearanceGrantId: true },
  });
  if (due.length === 0) return;

  for (const row of due) {
    if (row.clearanceGrantId === null) continue;
    await prisma.assetUsage.update({
      where: { id: row.id },
      data: { exportId: params.exportId, exportedAt: new Date() },
    });
    try {
      const result = await partnerCatalogue.reportUsage({
        grantId: row.clearanceGrantId,
        exportId: params.exportId,
      });
      await prisma.assetUsage.update({
        where: { id: row.id },
        data: { reportedAt: result.reportedAt, reportRef: result.reportRef },
      });
    } catch (error) {
      // Left with exportedAt set, reportedAt null — exactly what
      // `PartnerUsageReportRetryTask.sweep()` picks up on its next pass.
      logger.warn(
        { assetUsageId: row.id, exportId: params.exportId, err: error },
        "partner usage report failed at export-completed time; left for the retry sweep",
      );
    }
  }
}
