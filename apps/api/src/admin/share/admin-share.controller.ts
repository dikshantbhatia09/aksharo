import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
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
import { NotifyService } from "../../notify/notify.service.js";
import { ShareLinksService } from "../../share/share-links.service.js";
import { AdminRoles } from "../admin-roles.decorator.js";
import { AdminGuard, adminOf } from "../admin.guard.js";

import type { AuthenticatedRequest } from "../../common/guards/principal.js";

const RESOLUTION_LABEL: Record<string, string> = {
  take_down: "taken down",
  dismiss: "dismissed — no action needed",
  warned: "resolved with a warning to the project owner",
};

/**
 * Share-link report review (B13 scope §2: "share-link reports (take down,
 * notify)"). B13b wires "notify" up: `share-report-resolved` (added this WP)
 * goes to the reporter, when they left contact details, and to the
 * workspace owner of the reported link — both as a courtesy that the report
 * was looked at, never a promise of what was done (the note is a short,
 * human summary, not the admin's internal reasoning).
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "Requires an admin session." })
@UseGuards(AdminGuard)
@Controller("admin/share-reports")
export class AdminShareController {
  private readonly logger = new Logger(AdminShareController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shareLinks: ShareLinksService,
    private readonly audit: CommonAuditService,
    private readonly notify: NotifyService,
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

    await this.notifyResolution(report, body);
  }

  /**
   * Best-effort: a notification is a courtesy on top of an already-completed
   * resolution, never a reason to fail the request (`NotifyService.enqueue`'s
   * own contract — see its doc comment — never throws for a delivery reason,
   * but a lookup here, e.g. a deleted workspace, still should not 500).
   */
  private async notifyResolution(
    report: { readonly shareLinkId: string; readonly reporterContact: string | null },
    body: ResolveReportDto,
  ): Promise<void> {
    const resolution = RESOLUTION_LABEL[body.action] ?? body.action;
    const reportedAt = new Date().toISOString().slice(0, 10);
    const data = { reportedAt, resolution, resolutionNote: body.note };

    try {
      if (report.reporterContact !== null && report.reporterContact.trim() !== "") {
        await this.notify.enqueue({
          kind: "share-report-resolved",
          to: report.reporterContact,
          data,
          idempotencyKey: `share-report-resolved-reporter-${report.shareLinkId}-${body.action}`,
        });
      }

      const link = await this.prisma.shareLink.findUnique({
        where: { id: report.shareLinkId },
        select: { project: { select: { workspace: { select: { id: true, ownerId: true } } } } },
      });
      const ownerId = link?.project.workspace.ownerId;
      if (ownerId !== undefined) {
        const owner = await this.prisma.user.findUnique({
          where: { id: ownerId },
          select: { email: true },
        });
        if (owner !== null) {
          await this.notify.enqueue({
            kind: "share-report-resolved",
            to: owner.email,
            userId: ownerId,
            workspaceId: link?.project.workspace.id,
            data,
            idempotencyKey: `share-report-resolved-owner-${report.shareLinkId}-${body.action}`,
          });
        }
      }
    } catch (error) {
      this.logger.error(
        { err: error, shareLinkId: report.shareLinkId },
        "share-report-resolved notification failed to enqueue",
      );
    }
  }
}
