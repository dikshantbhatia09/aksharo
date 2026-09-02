import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import {
  ClaimReferralDto,
  claimReferralResultSchema,
  dismissPromptResultSchema,
  referralStatsSchema,
  type ClaimReferralResult,
  type DismissPromptResult,
  type ReferralStats,
} from "./referrals.dto.js";
import { ReferralsService } from "./referrals.service.js";
import { zodResponse } from "../auth/dto/openapi.js";
import {
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
  clientIp,
  clientUserAgent,
} from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { AuthPrincipal, AuthenticatedRequest } from "../common/guards/index.js";

/**
 * `/referrals/*` (B07b): the personal code, claim-at-onboarding, and the
 * give-get sheet's "shown once" marker.
 *
 * Same guard stack as `/offers/*` — no `:id` in the path, scoped through the
 * access token via `WorkspaceMemberGuard` (THREAT-MODEL T4).
 */
@ApiTags("referrals")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("referrals")
export class ReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  @Get("me")
  @Roles("viewer")
  @ApiOperation({
    summary: "This workspace's referral code and reward counts",
    description:
      "Backs the Invite-friends tab and the give-get sheet. Creates the code if it did not exist yet.",
    operationId: "getReferralsMe",
  })
  @ApiOkResponse(
    zodResponse(referralStatsSchema, "Personal code, reward counts, bonus/prompt state."),
  )
  async me(@CurrentUser() principal: AuthPrincipal): Promise<ReferralStats> {
    return this.referrals.myStats(principal.workspaceId);
  }

  @Post("claim")
  @Roles("viewer")
  @ApiOperation({
    summary: "Claim a code posted at onboarding",
    description:
      "Accepts both referral (`AK-XXXXXX`) and affiliate codes; a non-referral code is a no-op here " +
      "(`claimed: false`) — attribution for it is B07's concern.",
    operationId: "claimReferral",
  })
  @ApiOkResponse(
    zodResponse(
      claimReferralResultSchema,
      "Whether the code was claimed, and its resulting state.",
    ),
  )
  async claim(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: ClaimReferralDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ClaimReferralResult> {
    return this.referrals.claim({
      workspaceId: principal.workspaceId,
      code: body.code,
      ip: clientIp(request),
      userAgent: clientUserAgent(request),
    });
  }

  @Post("prompt/shown")
  @Roles("viewer")
  @ApiOperation({
    summary: "Mark the give-get sheet as shown for this workspace",
    description:
      "Idempotent — the sheet shows once per workspace; a repeat call returns the first timestamp.",
    operationId: "markReferralPromptShown",
  })
  @ApiOkResponse(zodResponse(dismissPromptResultSchema, "When the sheet was first shown."))
  async promptShown(@CurrentUser() principal: AuthPrincipal): Promise<DismissPromptResult> {
    const shownAt = await this.referrals.markPromptShown(principal.workspaceId);
    return { shownAt };
  }
}
