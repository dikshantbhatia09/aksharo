import { Body, Controller, Get, HttpStatus, Param, Post, Req, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { AdminStylePresetDto, PublishStyleDto } from "./admin-styles.dto.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { AppException, ERROR_CODES } from "../../common/errors/error-codes.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { AdminRoles } from "../admin-roles.decorator.js";
import { AdminGuard, adminOf } from "../admin.guard.js";

import type { AuthenticatedRequest } from "../../common/guards/principal.js";
import type { StylePreset } from "@prisma/client";

/**
 * Styles catalogue admin (B13 scope §2): the system catalogue
 * (`workspaceId = null` rows) plus the A18a parity gate's own results
 * (`assRenderable`/`assExportable`/`requiresLayoutMetrics`/`parityScore`,
 * `style_presets`'s own doc comment: "written by the A18a parity gate,
 * never by hand" — this panel only reads them). `content`/`superadmin` may
 * publish/unpublish; every other admin role may view.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "Requires an admin session." })
@UseGuards(AdminGuard)
@Controller("admin/styles")
export class AdminStylesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: CommonAuditService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "The system style catalogue, with parity results",
    operationId: "adminListStyles",
  })
  @ApiOkResponse({ type: [AdminStylePresetDto] })
  async list(): Promise<AdminStylePresetDto[]> {
    const rows = await this.prisma.stylePreset.findMany({
      where: { workspaceId: null },
      orderBy: { key: "asc" },
    });
    return rows.map(toDto);
  }

  @Post(":id/publish")
  @AdminRoles("content", "superadmin")
  @ApiOperation({
    summary: "Publish or unpublish a system style (content/superadmin only)",
    description:
      "Unpublishing hides it from StylesService.list() without deleting it — parity data and " +
      "any workspace already using it are preserved. Reason is mandatory.",
    operationId: "adminPublishStyle",
  })
  @ApiOkResponse({ type: AdminStylePresetDto })
  @ApiNotFoundResponse({ description: "`common/not_found`." })
  async publish(
    @Param("id") id: string,
    @Body() body: PublishStyleDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<AdminStylePresetDto> {
    const before = await this.prisma.stylePreset.findFirst({ where: { id, workspaceId: null } });
    if (before === null) {
      throw new AppException(ERROR_CODES.notFound, "No such system style.", HttpStatus.NOT_FOUND);
    }
    const row = await this.prisma.stylePreset.update({
      where: { id },
      data: { published: body.published },
    });
    const admin = adminOf(request);
    await this.audit.record({
      action: body.published ? "admin.styles.published" : "admin.styles.unpublished",
      resource: "style_preset",
      resourceId: id,
      actorId: admin.userId,
      actorKind: "admin",
      ...(admin.ip === undefined ? {} : { ip: admin.ip }),
      data: { reason: body.reason, key: row.key },
    });
    return toDto(row);
  }
}

function toDto(row: StylePreset): AdminStylePresetDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    key: row.key,
    name: row.name,
    category: row.category,
    published: row.published,
    minPlan: row.minPlan,
    version: row.version,
    parity: {
      assRenderable: row.assRenderable,
      assExportable: row.assExportable,
      requiresLayoutMetrics: row.requiresLayoutMetrics,
      parityScore: row.parityScore,
    },
    updatedAt: row.updatedAt.toISOString(),
  };
}
