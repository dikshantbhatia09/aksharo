import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { ulid } from "ulid";

import { CreateFlagDto, FeatureFlagDto, UpdateFlagDto } from "./admin-flags.dto.js";
import { toFeatureFlagDto } from "./admin-flags.mapper.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { AppException, ERROR_CODES } from "../../common/errors/error-codes.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { AdminRoles } from "../admin-roles.decorator.js";
import { AdminGuard, adminOf } from "../admin.guard.js";

import type { AuthenticatedRequest } from "../../common/guards/principal.js";

/**
 * Feature flags CRUD (B13 scope §2/§4: "superadmin-only: ... flags global
 * changes"). Reads are open to any admin role; every mutation is
 * `superadmin` only and requires a reason.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "Requires an admin session." })
@UseGuards(AdminGuard)
@Controller("admin/flags")
export class AdminFlagsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: CommonAuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List every feature flag", operationId: "adminListFlags" })
  @ApiOkResponse({ type: [FeatureFlagDto] })
  async list(): Promise<FeatureFlagDto[]> {
    const rows = await this.prisma.featureFlag.findMany({ orderBy: { key: "asc" } });
    return rows.map(toFeatureFlagDto);
  }

  @Get(":key")
  @ApiOperation({ summary: "One flag's current state", operationId: "adminGetFlag" })
  @ApiOkResponse({ type: FeatureFlagDto })
  @ApiNotFoundResponse({ description: "`common/not_found`." })
  async get(@Param("key") key: string): Promise<FeatureFlagDto> {
    const row = await this.prisma.featureFlag.findUnique({ where: { key } });
    if (row === null) {
      throw new AppException(ERROR_CODES.notFound, "No such flag.", HttpStatus.NOT_FOUND);
    }
    return toFeatureFlagDto(row);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @AdminRoles("superadmin")
  @ApiOperation({ summary: "Create a flag (superadmin only)", operationId: "adminCreateFlag" })
  @ApiOkResponse({ type: FeatureFlagDto })
  @ApiConflictResponse({ description: "A flag with this key already exists." })
  async create(
    @Body() body: CreateFlagDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<FeatureFlagDto> {
    const existing = await this.prisma.featureFlag.findUnique({ where: { key: body.key } });
    if (existing !== null) {
      throw new AppException(
        ERROR_CODES.conflict,
        "A flag with this key already exists.",
        HttpStatus.CONFLICT,
      );
    }
    const row = await this.prisma.featureFlag.create({
      data: {
        id: ulid(),
        key: body.key,
        ...(body.description === undefined ? {} : { description: body.description }),
        enabled: body.enabled,
        rolloutPct: body.rolloutPct,
        targets: body.targets,
      },
    });
    const admin = adminOf(request);
    await this.audit.record({
      action: "admin.flags.created",
      resource: "feature_flag",
      resourceId: row.id,
      actorId: admin.userId,
      actorKind: "admin",
      ...(admin.ip === undefined ? {} : { ip: admin.ip }),
      data: { key: row.key, enabled: row.enabled, rolloutPct: row.rolloutPct },
    });
    return toFeatureFlagDto(row);
  }

  @Put(":key")
  @AdminRoles("superadmin")
  @ApiOperation({
    summary: "Update a flag's rollout, targets or enabled state (superadmin only)",
    description:
      "Reason is mandatory — a global flag change is a B13 §1 money/credit-grade action.",
    operationId: "adminUpdateFlag",
  })
  @ApiOkResponse({ type: FeatureFlagDto })
  @ApiNotFoundResponse({ description: "`common/not_found`." })
  async update(
    @Param("key") key: string,
    @Body() body: UpdateFlagDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<FeatureFlagDto> {
    const before = await this.prisma.featureFlag.findUnique({ where: { key } });
    if (before === null) {
      throw new AppException(ERROR_CODES.notFound, "No such flag.", HttpStatus.NOT_FOUND);
    }
    const row = await this.prisma.featureFlag.update({
      where: { key },
      data: {
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.rolloutPct === undefined ? {} : { rolloutPct: body.rolloutPct }),
        ...(body.targets === undefined ? {} : { targets: body.targets }),
      },
    });
    const admin = adminOf(request);
    await this.audit.record({
      action: "admin.flags.updated",
      resource: "feature_flag",
      resourceId: row.id,
      actorId: admin.userId,
      actorKind: "admin",
      ...(admin.ip === undefined ? {} : { ip: admin.ip }),
      data: {
        reason: body.reason,
        before: { enabled: before.enabled, rolloutPct: before.rolloutPct, targets: before.targets },
        after: { enabled: row.enabled, rolloutPct: row.rolloutPct, targets: row.targets },
      },
    });
    return toFeatureFlagDto(row);
  }

  @Delete(":key")
  @HttpCode(HttpStatus.NO_CONTENT)
  @AdminRoles("superadmin")
  @ApiOperation({ summary: "Delete a flag (superadmin only)", operationId: "adminDeleteFlag" })
  @ApiNotFoundResponse({ description: "`common/not_found`." })
  async remove(@Param("key") key: string, @Req() request: AuthenticatedRequest): Promise<void> {
    const before = await this.prisma.featureFlag.findUnique({ where: { key } });
    if (before === null) {
      throw new AppException(ERROR_CODES.notFound, "No such flag.", HttpStatus.NOT_FOUND);
    }
    await this.prisma.featureFlag.delete({ where: { key } });
    const admin = adminOf(request);
    await this.audit.record({
      action: "admin.flags.deleted",
      resource: "feature_flag",
      resourceId: before.id,
      actorId: admin.userId,
      actorKind: "admin",
      ...(admin.ip === undefined ? {} : { ip: admin.ip }),
      data: { key },
    });
  }
}
