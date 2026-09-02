import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import {
  affiliateStatsSchema,
  affiliateViewSchema,
  attachCodeSchema,
  recordClickSchema,
  type AdminAffiliateActionDto,
  type ApplyAffiliateDto,
  type AttachCodeDto,
  type RecordClickDto,
  applyAffiliateSchema,
} from "./affiliates.dto.js";
import { AffiliatesService } from "./affiliates.service.js";
import { AttributionService } from "./attribution.service.js";
import { FraudService } from "./fraud.service.js";
import { StatsService } from "./stats.service.js";
import { AdminGuard, adminOf } from "../admin/admin.guard.js";
import { zodBody, zodResponse } from "../auth/dto/openapi.js";
import { CurrentUser, JwtAuthGuard, Public } from "../common/guards/index.js";

import type { AuthPrincipal } from "../common/guards/index.js";
import type { AuthenticatedRequest } from "../common/guards/principal.js";
import type { Request } from "express";

/**
 * `/affiliate/*` (brief §1, §2, §5, §6). Application/dashboard routes are
 * scoped to the caller's own affiliate profile via the access token;
 * `/affiliate/r/click` and `/affiliate/attribution/attach` are public — the
 * former is called by the web `/r/[code]` route, the latter by sign-up/
 * checkout to resolve "code beats cookie" attribution once a workspace
 * exists. Admin approve/suspend/reject live here too (brief §1: "admin
 * endpoints; UI in B13").
 */
@ApiTags("affiliate")
@Controller("affiliate")
export class AffiliatesController {
  constructor(
    private readonly affiliates: AffiliatesService,
    private readonly attribution: AttributionService,
    private readonly stats: StatsService,
    private readonly fraud: FraudService,
  ) {}

  @Post("apply")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Apply to the affiliate programme (India only)",
    operationId: "applyAffiliate",
  })
  @ApiBody(zodBody(applyAffiliateSchema))
  @ApiOkResponse(zodResponse(affiliateViewSchema, "The new affiliate profile, status pending."))
  async apply(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: ApplyAffiliateDto,
    @Req() req: Request,
  ) {
    return this.affiliates.apply(principal.userId, body, { ip: req.ip });
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "The caller's own affiliate profile, or null",
    operationId: "getMyAffiliate",
  })
  @ApiOkResponse(zodResponse(affiliateViewSchema.nullable(), "Affiliate profile or null."))
  async me(@CurrentUser() principal: AuthPrincipal) {
    return this.affiliates.getForUser(principal.userId);
  }

  @Get("me/stats")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Dashboard stats for the caller's affiliate profile",
    operationId: "getMyAffiliateStats",
  })
  @ApiOkResponse(
    zodResponse(affiliateStatsSchema, "Clicks, sign-ups, pending/available/paid, FY TDS."),
  )
  async myStats(@CurrentUser() principal: AuthPrincipal) {
    const affiliate = await this.affiliates.getForUser(principal.userId);
    if (affiliate === null) throw new NotFoundException("affiliate/not_found");
    return this.stats.forAffiliate(affiliate.id);
  }

  @Post("r/click")
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Record a /r/<code> click (called by the web route)",
    operationId: "recordAffiliateClick",
  })
  @ApiBody(zodBody(recordClickSchema))
  async recordClick(@Body() body: RecordClickDto) {
    const result = await this.attribution.recordClick(body);
    return {
      attributed: result !== null,
      attributionExpiresAt: result?.attributionExpiresAt.toISOString() ?? null,
    };
  }

  @Post("attribution/attach")
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Resolve attribution for a newly-created workspace (code beats cookie)",
    operationId: "attachAffiliateAttribution",
  })
  @ApiBody(zodBody(attachCodeSchema))
  async attach(@Body() body: AttachCodeDto) {
    const result = await this.attribution.attach({
      referredWorkspaceId: body.referredWorkspaceId,
      referredUserId: body.referredUserId,
      enteredCode: body.code,
      cookieCode: body.cookieCode,
      cookieExpiresAt: body.cookieExpiresAt === undefined ? null : new Date(body.cookieExpiresAt),
      ipHash: body.ipHash,
      deviceHash: body.deviceHash,
      paymentFingerprint: body.paymentFingerprint,
    });
    if (result.status === "attributed" && result.affiliateId !== undefined) {
      await this.fraud.checkBurstSignup(result.affiliateId, body.ipHash, body.deviceHash);
    }
    return result;
  }

  @Post("admin/:affiliateId/approve")
  @UseGuards(AdminGuard)
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Approve a pending affiliate application (admin)",
    operationId: "adminApproveAffiliate",
  })
  @ApiOkResponse(zodResponse(affiliateViewSchema, "The approved affiliate."))
  async adminApprove(@Param("affiliateId") affiliateId: string, @Req() req: AuthenticatedRequest) {
    return this.affiliates.adminApprove(affiliateId, adminOf(req).userId);
  }

  @Post("admin/:affiliateId/suspend")
  @UseGuards(AdminGuard)
  @ApiBearerAuth("access-token")
  @ApiOperation({ summary: "Suspend an affiliate (admin)", operationId: "adminSuspendAffiliate" })
  @ApiOkResponse(zodResponse(affiliateViewSchema, "The suspended affiliate."))
  async adminSuspend(
    @Param("affiliateId") affiliateId: string,
    @Body() body: AdminAffiliateActionDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.affiliates.adminSuspend(affiliateId, adminOf(req).userId, body.reason);
  }

  @Post("admin/:affiliateId/reject")
  @UseGuards(AdminGuard)
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Reject a pending affiliate application (admin)",
    operationId: "adminRejectAffiliate",
  })
  @ApiOkResponse(zodResponse(affiliateViewSchema, "The rejected affiliate."))
  async adminReject(
    @Param("affiliateId") affiliateId: string,
    @Body() body: AdminAffiliateActionDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.affiliates.adminReject(affiliateId, adminOf(req).userId, body.reason);
  }

  @Post("admin/:affiliateId/revoke-code")
  @UseGuards(AdminGuard)
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Revoke and regenerate an affiliate's code (admin)",
    operationId: "adminRevokeAffiliateCode",
  })
  @ApiOkResponse(zodResponse(affiliateViewSchema, "The affiliate with a new code."))
  async adminRevokeCode(
    @Param("affiliateId") affiliateId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.affiliates.adminRevokeCode(affiliateId, adminOf(req).userId);
  }
}
