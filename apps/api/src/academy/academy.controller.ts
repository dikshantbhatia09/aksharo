import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import {
  academyProgressResponseSchema,
  changelogDismissedResponseSchema,
  DismissChangelogDto,
  markStepDoneResultSchema,
  type AcademyProgressResponse,
  type ChangelogDismissedResponse,
  type MarkStepDoneResult,
} from "./academy.dto.js";
import { AcademyService } from "./academy.service.js";
import { zodResponse } from "../auth/dto/openapi.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { AuthPrincipal } from "../common/guards/index.js";

/**
 * `/academy/*` (B12): track progress, the one-time per-track reward, and the
 * What's-new dismissal marker. Same guard stack as `/referrals/*`.
 */
@ApiTags("academy")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller()
export class AcademyController {
  constructor(
    private readonly academy: AcademyService,
    private readonly audit: CommonAuditService,
  ) {}

  @Get("academy/progress")
  @Roles("viewer")
  @ApiOperation({
    summary: "This workspace's Academy progress",
    operationId: "getAcademyProgress",
  })
  @ApiOkResponse(zodResponse(academyProgressResponseSchema, "Per-track completed steps and rewards."))
  async progress(@CurrentUser() principal: AuthPrincipal): Promise<AcademyProgressResponse> {
    return this.academy.getProgress(principal.workspaceId, principal.userId);
  }

  @Post("academy/tracks/:trackId/steps/:stepId/done")
  @Roles("viewer")
  @ApiOperation({
    summary: "Mark an Academy step done ('Mark done')",
    description:
      "Idempotent. When this completes the track's last step, grants the one-time " +
      "credit reward (capped 25/track, 100/workspace lifetime) automatically.",
    operationId: "markAcademyStepDone",
  })
  @ApiOkResponse(zodResponse(markStepDoneResultSchema, "Whether the track completed and a reward was granted."))
  async markStepDone(
    @CurrentUser() principal: AuthPrincipal,
    @Param("trackId") trackId: string,
    @Param("stepId") stepId: string,
  ): Promise<MarkStepDoneResult> {
    const result = await this.academy.markStepDone(
      principal.workspaceId,
      principal.userId,
      trackId,
      stepId,
      "manual",
    );
    await this.audit.record({
      action: "academy.step.completed",
      resource: "academy_progress",
      resourceId: `${trackId}:${stepId}`,
      actorId: principal.userId,
      workspaceId: principal.workspaceId,
      data: { trackId, stepId, trackCompleted: result.trackCompleted, rewardGranted: result.rewardGranted },
    });
    return result;
  }

  @Get("academy/changelog/dismissed")
  @Roles("viewer")
  @ApiOperation({
    summary: "The last changelog version this user dismissed",
    operationId: "getDismissedChangelogVersion",
  })
  @ApiOkResponse(zodResponse(changelogDismissedResponseSchema, "Null when never dismissed."))
  async dismissed(@CurrentUser() principal: AuthPrincipal): Promise<ChangelogDismissedResponse> {
    return this.academy.getDismissedChangelogVersion(principal.userId);
  }

  @Post("academy/changelog/dismissed")
  @Roles("viewer")
  @ApiOperation({
    summary: "Mark the What's-new modal seen for a changelog version",
    operationId: "dismissChangelogVersion",
  })
  @ApiOkResponse(zodResponse(changelogDismissedResponseSchema, "The now-dismissed version."))
  async dismiss(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: DismissChangelogDto,
  ): Promise<ChangelogDismissedResponse> {
    return this.academy.dismissChangelog(principal.userId, body.version);
  }
}
