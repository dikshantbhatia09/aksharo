import { Controller, Get, HttpStatus, Inject, Param, Query, Res, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import type { Env } from "@montaj/config";

import { AdminPendingAffiliateDto, Form16aQueryDto } from "./admin-affiliates.dto.js";
import { renderForm16aPdf } from "../../affiliates/form16a.js";
import { decryptPan } from "../../affiliates/pan-crypto.js";
import { AppException, ERROR_CODES } from "../../common/errors/error-codes.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ENV } from "../../config/config.module.js";
import { resolveSupplierConfig } from "../../invoices/supplier-config.js";
import { AdminRoles } from "../admin-roles.decorator.js";
import { AdminGuard } from "../admin.guard.js";

import type { Response } from "express";

/**
 * TDS reports (B13 scope §2: "TDS reports (B07 FY totals CSV, Form 16A
 * stubs)") plus the affiliate pending-review list. The commission engine,
 * TDS math (`affiliates/tds.ts`) and the Form 16A renderer are all B07's own
 * — this is only the admin-facing report surface B07 did not build a
 * controller for.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "Requires an admin session." })
@UseGuards(AdminGuard)
@Controller("admin/affiliates")
export class AdminAffiliatesController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get("pending")
  @ApiOperation({
    summary: "Affiliate applications awaiting review",
    operationId: "adminPendingAffiliates",
  })
  @ApiOkResponse({ type: [AdminPendingAffiliateDto] })
  async pending(): Promise<AdminPendingAffiliateDto[]> {
    const rows = await this.prisma.affiliate.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      code: row.code,
      status: row.status,
      country: row.country,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  @Get("tds/:fyLabel/export.csv")
  @AdminRoles("finance", "superadmin")
  @ApiProduces("text/csv")
  @ApiOperation({
    summary: "Every affiliate's FY gross/TDS/net totals, as CSV (finance/superadmin only)",
    operationId: "adminAffiliateTdsCsv",
  })
  async tdsCsv(@Param("fyLabel") fyLabel: string, @Res() res: Response): Promise<void> {
    const rows = await this.prisma.affiliateFyTotal.findMany({
      where: { fyLabel },
      include: {
        affiliate: { select: { code: true, legalName: true, pan: true, panVerifiedAt: true } },
      },
      orderBy: { grossMinor: "desc" },
    });
    const header = "affiliate_code,legal_name,pan_verified,gross_minor,tds_minor,net_minor\n";
    const lines = rows.map((row) => {
      const netMinor = row.grossMinor - row.tdsMinor;
      const legalName = (row.affiliate.legalName ?? "").replaceAll(",", " ");
      return `${row.affiliate.code},${legalName},${row.affiliate.panVerifiedAt !== null},${row.grossMinor},${row.tdsMinor},${netMinor}`;
    });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="affiliate-tds-${fyLabel}.csv"`);
    res.send(header + lines.join("\n") + (lines.length > 0 ? "\n" : ""));
  }

  @Get(":affiliateId/form16a")
  @AdminRoles("finance", "superadmin")
  @ApiProduces("application/pdf")
  @ApiOperation({
    summary: "Form 16A stub for one affiliate's FY totals (finance/superadmin only)",
    description:
      'Watermarked "DRAFT" unless `draft=false` — 194H vs 194-O needs a CA\'s confirmation.',
    operationId: "adminAffiliateForm16a",
  })
  @ApiNotFoundResponse({ description: "No FY total on file for this affiliate/year." })
  async form16a(
    @Param("affiliateId") affiliateId: string,
    @Query() query: Form16aQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const affiliate = await this.prisma.affiliate.findUnique({ where: { id: affiliateId } });
    if (affiliate === null) {
      throw new AppException(ERROR_CODES.notFound, "No such affiliate.", HttpStatus.NOT_FOUND);
    }
    const fyTotal = await this.prisma.affiliateFyTotal.findUnique({
      where: { affiliateId_fyLabel: { affiliateId, fyLabel: query.fy } },
    });
    if (fyTotal === null) {
      throw new AppException(
        ERROR_CODES.notFound,
        "No FY total on file for this affiliate/year.",
        HttpStatus.NOT_FOUND,
      );
    }

    const pan =
      affiliate.pan === null ? null : decryptPan(affiliate.pan, this.env.INTERNAL_CALLBACK_SECRET);
    const supplier = resolveSupplierConfig();

    const pdf = await renderForm16aPdf({
      affiliateLegalName: affiliate.legalName ?? affiliate.code,
      affiliatePan: pan,
      fyLabel: query.fy,
      tdsSection: "s194H",
      grossMinor: fyTotal.grossMinor,
      tdsMinor: fyTotal.tdsMinor,
      netMinor: fyTotal.grossMinor - fyTotal.tdsMinor,
      deductorName: supplier.legalName,
      draft: query.draft,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="form16a-${affiliate.code}-${query.fy}.pdf"`,
    );
    res.send(pdf);
  }
}
