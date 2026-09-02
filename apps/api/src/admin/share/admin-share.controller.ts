import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { ResolveReportDto, ShareReportSummaryDto } from "./admin-share.dto.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { AppException, ERROR_CODES } from "../../common/errors/error-codes.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ShareLinksService } from "../../share/share-links.service.js";
import { AdminRoles } from "../admin-roles.decorator.js";
import { AdminGuard, adminOf } from "../admin.guard.js";

import type { AuthenticatedRequest } from "../../common/guards/principal.js";

/**
 * Share-link report review (B13 scope §2: "share-link reports (take down,
 * notify)"). "Notify" (emailing the reporter/workspace once resolved) is not
 * wired here — no NOTIFY_KINDS template exists for it yet; see this WP's
 * final report, "open questions". Take-down and resolution tracking are.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "Requires an admin session." })
@UseGuards(AdminGuard)
@Controller("admin/share-reports")
export class AdminShareController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shareLinks: ShareLinksService,
    private readonly audit: CommonAuditService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Unresolved share-link abuse reports, oldest first",
    operationId: "adminListShareReports",
  })
  @ApiOkResponse({ type: [ShareReportSummaryDto] })
  async list(): Promise<ShareReportSummaryDto[]> {
    const rows = await this.prisma.shareReport.findMany({
      where: { resolvedAt: null },
      orderBy: { dueAt: "asc" },
    });
    return rows.map((row) => ({
      id: row.id,
      shareLinkId: row.shareLinkId,
      category: row.category,
      receivedAt: row.receivedAt.toISOString(),
      dueAt: row.dueAt.toISOString(),
    }));
  }

  @Post(":id/resolve")
  @HttpCode(HttpStatus.NO_CONTENT)
  @AdminRoles("ops", "content", "superadmin")
  @ApiOperation({
    summary: "Resolve a report: take the link down, dismiss, or record a warning",
    operationId: "adminResolveShareReport",
  })
  @ApiNotFoundResponse({ description: "`common/not_found`." })
  async resolve(
    @Param("id") id: string,
    @Body() body: ResolveReportDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const report = await this.prisma.shareReport.findUnique({ where: { id } });
    if (report === null) {
      throw new AppException(ERROR_CODES.notFound, "No such report.", HttpStatus.NOT_FOUND);
    }
    const admin = adminOf(request);

    if (body.action === "take_down") {
      await this.shareLinks.adminTakedown(report.shareLinkId, admin.userId, body.note);
    }

    await this.prisma.shareReport.update({
      where: { id },
      data: { resolvedAt: new Date(), action: body.action },
    });

    await this.audit.record({
      action: "admin.share.report_resolved",
      resource: "share_report",
      resourceId: id,
      actorId: admin.userId,
      actorKind: "admin",
      ...(admin.ip === undefined ? {} : { ip: admin.ip }),
      data: { resolution: body.action, note: body.note, shareLinkId: report.shareLinkId },
    });
  }
}
