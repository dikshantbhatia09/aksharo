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

import { HeldReferralDto, RejectHoldDto } from "./admin-referrals.dto.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ReferralsService } from "../../referrals/referrals.service.js";
import { AdminRoles } from "../admin-roles.decorator.js";
import { AdminGuard, adminOf } from "../admin.guard.js";

import type { AuthenticatedRequest } from "../../common/guards/principal.js";

/**
 * The referral fraud review queue (B13 orchestrator addendum, after B07b):
 * "chained self-referral" holds — still `status: "pending"`, never
 * auto-granted (`ReferralsService.grantForExport`'s own check) — surfaced
 * here for `ops`/`finance`/`superadmin` to approve or reject.
 *
 * **Clustering candidate, not built (B13b, orchestrator ruling 2026-09-03,
 * item 7).** Today's hold reason is purely referral-graph shape (a chain of
 * self-referrals). A device-fingerprint or IP signal shared across two
 * workspaces' `referral_rewards` rows — the same device or address behind
 * both the referrer and the referred signup — is a stronger fraud signal
 * this queue does not surface: it would need joining `referral_rewards`
 * against B08's device rows (or a request-IP log this WP does not have) and
 * a clustering pass to flag pairs, and it stays a documented follow-up
 * rather than code this WP was told to write.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({
  description: "Requires an admin session with the ops, finance or superadmin role.",
})
@UseGuards(AdminGuard)
@AdminRoles("ops", "finance", "superadmin")
@Controller("admin/referrals")
export class AdminReferralsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly referrals: ReferralsService,
    private readonly audit: CommonAuditService,
  ) {}

  @Get("review-queue")
  @ApiOperation({
    summary: "Referral rewards held for review (chained self-referral)",
    operationId: "adminReferralReviewQueue",
  })
  @ApiOkResponse({ type: [HeldReferralDto] })
  async reviewQueue(): Promise<HeldReferralDto[]> {
    const rows = await this.prisma.referralReward.findMany({
      where: { status: "pending", holdReason: { not: null } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => ({
      id: row.id,
      referrerWorkspaceId: row.referrerWorkspaceId,
      referredWorkspaceId: row.referredWorkspaceId,
      code: row.code,
      holdReason: row.holdReason ?? "",
      createdAt: row.createdAt.toISOString(),
    }));
  }

  @Post(":id/approve")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Clear a hold and settle the reward through the normal grant/cap path",
    operationId: "adminApproveReferralHold",
  })
  @ApiNotFoundResponse({ description: "`common/not_found` — no pending held reward with that id." })
  async approve(@Param("id") id: string, @Req() request: AuthenticatedRequest): Promise<void> {
    await this.referrals.adminApproveHold(id);
    const admin = adminOf(request);
    await this.audit.record({
      action: "admin.referrals.hold_approved",
      resource: "referral_reward",
      resourceId: id,
      actorId: admin.userId,
      actorKind: "admin",
      ...(admin.ip === undefined ? {} : { ip: admin.ip }),
    });
  }

  @Post(":id/reject")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Reject a held reward", operationId: "adminRejectReferralHold" })
  @ApiNotFoundResponse({ description: "`common/not_found` — no pending held reward with that id." })
  async reject(
    @Param("id") id: string,
    @Body() body: RejectHoldDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.referrals.adminRejectHold(id, body.reason);
    const admin = adminOf(request);
    await this.audit.record({
      action: "admin.referrals.hold_rejected",
      resource: "referral_reward",
      resourceId: id,
      actorId: admin.userId,
      actorKind: "admin",
      ...(admin.ip === undefined ? {} : { ip: admin.ip }),
      data: { reason: body.reason },
    });
  }
}
