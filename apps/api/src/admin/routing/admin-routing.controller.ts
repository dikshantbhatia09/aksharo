import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { ulid } from "ulid";

import { RoutingWeightOverrideDto, SetRoutingWeightDto } from "./admin-routing.dto.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { AdminRoles } from "../admin-roles.decorator.js";
import { AdminGuard, adminOf } from "../admin.guard.js";

import type { AuthenticatedRequest } from "../../common/guards/principal.js";
import type { RoutingWeightOverride } from "@prisma/client";

/**
 * Routing weight overrides (B13 scope §2/§4: "superadmin-only: ... routing
 * weights"; A10/D12's routing table). The base table is
 * `apps/worker-ai/worker_ai/routing.yaml` — this store is the admin
 * console's own record of what a human has changed, one row per
 * `(laneId, provider)`, with validation (a weight is 0-100; lane/provider
 * ids are the shape `routing.yaml`/the provider registry use) and history
 * as the ordinary `audit_log` trail. It does NOT read or merge against the
 * YAML file: `apps/api` and `apps/worker-ai` are separately deployed
 * processes/repos in this monorepo, and reaching across that boundary at
 * runtime to parse a sibling service's file would be exactly the kind of
 * cross-service filesystem coupling THREAT-MODEL steers away from. Making
 * an override here actually change what the worker does needs one more
 * seam this WP does not build — see this WP's final report, "open
 * questions" — most naturally the worker reading its table from this same
 * store (or an internal endpoint) instead of the bundled YAML.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "Requires an admin session with the superadmin role." })
@UseGuards(AdminGuard)
@AdminRoles("superadmin")
@Controller("admin/routing/weights")
export class AdminRoutingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: CommonAuditService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Every routing weight override on file",
    operationId: "adminListRoutingWeights",
  })
  @ApiOkResponse({ type: [RoutingWeightOverrideDto] })
  async list(): Promise<RoutingWeightOverrideDto[]> {
    const rows = await this.prisma.routingWeightOverride.findMany({
      orderBy: [{ laneId: "asc" }, { provider: "asc" }],
    });
    return rows.map(toDto);
  }

  @Put()
  @ApiOperation({
    summary: "Set (create or replace) one lane/provider's weight override",
    description: "Reason is mandatory.",
    operationId: "adminSetRoutingWeight",
  })
  @ApiOkResponse({ type: RoutingWeightOverrideDto })
  async set(
    @Body() body: SetRoutingWeightDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<RoutingWeightOverrideDto> {
    const admin = adminOf(request);
    const before = await this.prisma.routingWeightOverride.findUnique({
      where: { laneId_provider: { laneId: body.laneId, provider: body.provider } },
    });
    const row = await this.prisma.routingWeightOverride.upsert({
      where: { laneId_provider: { laneId: body.laneId, provider: body.provider } },
      create: {
        id: ulid(),
        laneId: body.laneId,
        provider: body.provider,
        weight: body.weight,
        updatedBy: admin.userId,
      },
      update: { weight: body.weight, updatedBy: admin.userId },
    });
    await this.audit.record({
      action: "admin.routing.weight_set",
      resource: "routing_weight_override",
      resourceId: row.id,
      actorId: admin.userId,
      actorKind: "admin",
      ...(admin.ip === undefined ? {} : { ip: admin.ip }),
      data: {
        reason: body.reason,
        laneId: body.laneId,
        provider: body.provider,
        beforeWeight: before?.weight ?? null,
        afterWeight: body.weight,
      },
    });
    return toDto(row);
  }

  @Delete(":laneId/:provider")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Remove an override, reverting that lane/provider to routing.yaml's base weight",
    operationId: "adminClearRoutingWeight",
  })
  async clear(
    @Param("laneId") laneId: string,
    @Param("provider") provider: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const admin = adminOf(request);
    const before = await this.prisma.routingWeightOverride.findUnique({
      where: { laneId_provider: { laneId, provider } },
    });
    if (before === null) return;
    await this.prisma.routingWeightOverride.delete({
      where: { laneId_provider: { laneId, provider } },
    });
    await this.audit.record({
      action: "admin.routing.weight_cleared",
      resource: "routing_weight_override",
      resourceId: before.id,
      actorId: admin.userId,
      actorKind: "admin",
      ...(admin.ip === undefined ? {} : { ip: admin.ip }),
      data: { laneId, provider, previousWeight: before.weight },
    });
  }
}

function toDto(row: RoutingWeightOverride): RoutingWeightOverrideDto {
  return {
    id: row.id,
    laneId: row.laneId,
    provider: row.provider,
    weight: row.weight,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}
