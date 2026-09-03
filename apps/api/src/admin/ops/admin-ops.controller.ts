import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Patch,
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

import { Audited } from "../../audit/audited.decorator.js";
import { AppException, ERROR_CODES } from "../../common/errors/error-codes.js";
import { OpsIncidentsService } from "../../ops/ops-incidents.service.js";
import { AdminGuard, adminOf } from "../admin.guard.js";

import type { AuthenticatedRequest } from "../../common/guards/principal.js";
import type { $Enums } from "@prisma/client";

/**
 * `ops_incidents` for platform staff — the public status page's incident list
 * (X04 §1), managed here rather than exposed as a write route on the public
 * `StatusController`. Neighbours B13b's admin controllers; added alongside,
 * nothing there was refactored.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`common/forbidden` — the caller is not an administrator." })
@UseGuards(AdminGuard)
@Controller("admin/ops/incidents")
export class AdminOpsController {
  constructor(private readonly incidents: OpsIncidentsService) {}

  @Get()
  @ApiOperation({ summary: "List ops incidents, newest first", operationId: "listOpsIncidents" })
  @ApiOkResponse({ description: "Array of ops incidents." })
  list() {
    return this.incidents.list();
  }

  @Post()
  @Audited("admin.ops_incident.created")
  @ApiOperation({ summary: "Open a status-page incident", operationId: "createOpsIncident" })
  @ApiOkResponse({ description: "The created incident." })
  async create(
    @Body()
    body: {
      title: string;
      body: string;
      component: string;
      severity?: $Enums.OpsIncidentSeverity;
      startedAt?: string;
    },
    @Req() request: AuthenticatedRequest,
  ) {
    const admin = adminOf(request);
    return this.incidents.create(
      {
        title: body.title,
        body: body.body,
        component: body.component,
        ...(body.severity === undefined ? {} : { severity: body.severity }),
        ...(body.startedAt === undefined ? {} : { startedAt: new Date(body.startedAt) }),
      },
      admin.userId,
      admin.ip,
    );
  }

  @Patch(":id")
  @Audited("admin.ops_incident.updated")
  @ApiOperation({
    summary: "Update, escalate or resolve a status-page incident",
    operationId: "updateOpsIncident",
  })
  @ApiOkResponse({ description: "The updated incident." })
  @ApiNotFoundResponse({ description: "No such incident." })
  async update(
    @Param("id") id: string,
    @Body()
    body: {
      title?: string;
      body?: string;
      severity?: $Enums.OpsIncidentSeverity;
      status?: $Enums.OpsIncidentStatus;
      resolvedAt?: string | null;
    },
    @Req() request: AuthenticatedRequest,
  ) {
    const admin = adminOf(request);
    const updated = await this.incidents.update(
      id,
      {
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.body === undefined ? {} : { body: body.body }),
        ...(body.severity === undefined ? {} : { severity: body.severity }),
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.resolvedAt === undefined
          ? {}
          : { resolvedAt: body.resolvedAt === null ? null : new Date(body.resolvedAt) }),
      },
      admin.userId,
      admin.ip,
    );
    if (updated === null) {
      throw new AppException(
        ERROR_CODES.notFound,
        `No ops incident "${id}".`,
        HttpStatus.NOT_FOUND,
      );
    }
    return updated;
  }
}
