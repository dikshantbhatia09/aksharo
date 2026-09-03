import { Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { CommonAuditService } from "../../common/audit/audit.service.js";
import { PartnerCatalogueService } from "../../partner-catalogue/partner-catalogue.service.js";
import { AdminGuard, adminOf } from "../admin.guard.js";

import type { AuthenticatedRequest } from "../../common/guards/principal.js";

/**
 * D04b2 scope §5 — the B13 admin grants table: asset, workspace, use
 * context, expiry, usage-report status, with revoke. Gated by
 * {@link AdminGuard} alone, no `@AdminRoles(...)`, matching
 * `admin/affiliates`'s read-only pending list — nobody has been named an
 * owning role for partner-catalogue grants yet, and read-plus-revoke here is
 * no more sensitive than the affiliate/credit reads every admin already has.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`common/forbidden` — the caller is not an administrator." })
@UseGuards(AdminGuard)
@Controller("admin/partner-catalogue")
export class AdminPartnerCatalogueController {
  constructor(
    private readonly catalogue: PartnerCatalogueService,
    private readonly audit: CommonAuditService,
  ) {}

  @Get("grants")
  @ApiOperation({
    summary:
      "Every partner-catalogue grant, newest first (asset, workspace, use context, expiry, usage-report status)",
    operationId: "adminListPartnerCatalogueGrants",
  })
  @ApiOkResponse({ description: "Up to 500 grants, newest first." })
  async listGrants() {
    return this.catalogue.listGrants();
  }

  @Post("grants/:id/revoke")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Revoke a partner-catalogue grant (works even while the flag is off for that workspace)",
    operationId: "adminRevokePartnerCatalogueGrant",
  })
  async revoke(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
  ): Promise<{ revoked: true }> {
    const admin = adminOf(request);
    await this.catalogue.adminRevoke(id);
    await this.audit.record({
      action: "admin.partner_catalogue.grant_revoked",
      resource: "asset_clearance_grant",
      resourceId: id,
      actorId: admin.userId,
      actorKind: "admin",
      ...(admin.ip === undefined ? {} : { ip: admin.ip }),
      data: {},
    });
    return { revoked: true };
  }
}
