import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";

import { type LicenseKeyView, LicenseKeysService } from "./license-keys.service.js";
import {
  CreateLicenseKeyDto,
  createLicenseKeySchema,
  licenseKeyViewSchema,
} from "./licensing.dto.js";
import { zodArrayResponse, zodBody, zodResponse } from "../auth/dto/openapi.js";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "../common/guards/index.js";
import { context } from "../users/users.controller.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { AuthPrincipal } from "../common/guards/index.js";
import type { Request } from "express";

/**
 * `/workspaces/{id}/license-keys` (brief §3, 07 §Workspaces). `:id`-scoped
 * like every other workspace route (THREAT-MODEL T4).
 */
@ApiTags("licensing")
@Controller("workspaces")
export class LicenseKeysController {
  constructor(private readonly licenseKeys: LicenseKeysService) {}

  @Get(":id/license-keys")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("admin")
  @ApiBearerAuth("access-token")
  @ApiOperation({ summary: "This workspace's licence keys", operationId: "listLicenseKeys" })
  @ApiOkResponse(zodArrayResponse(licenseKeyViewSchema, "Licence keys."))
  async list(@Param("id") workspaceId: string): Promise<LicenseKeyView[]> {
    return this.licenseKeys.list(workspaceId);
  }

  @Post(":id/license-keys")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("admin")
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Create a licence key",
    description: "Returns `AK-XXXX-XXXX-XXXX`, shown once in full.",
    operationId: "createLicenseKey",
  })
  @ApiBody(zodBody(createLicenseKeySchema))
  @ApiCreatedResponse(zodResponse(licenseKeyViewSchema, "The new licence key."))
  async create(
    @Param("id") workspaceId: string,
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: CreateLicenseKeyDto,
    @Req() request: Request,
  ): Promise<LicenseKeyView> {
    return this.licenseKeys.create(workspaceId, body, principal.userId, context(request));
  }

  @Delete(":id/license-keys/:keyId")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("admin")
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Revoke a licence key",
    description: "Every device it activated is revoked too; propagates on next heartbeat.",
    operationId: "revokeLicenseKey",
  })
  @ApiOkResponse(zodResponse(licenseKeyViewSchema, "The revoked licence key."))
  async revoke(
    @Param("id") workspaceId: string,
    @Param("keyId") keyId: string,
    @CurrentUser() principal: AuthPrincipal,
    @Req() request: Request,
  ): Promise<LicenseKeyView> {
    return this.licenseKeys.revoke(workspaceId, keyId, principal.userId, context(request));
  }
}
