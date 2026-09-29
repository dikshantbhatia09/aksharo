import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";

import { CLIP_RATE_LIMITS } from "./repurpose-clips.dto.js";
import { AdjustCandidateDto, adjustCandidateSchema } from "./repurpose-steering.dto.js";
import { RepurposeSteeringService } from "./repurpose-steering.service.js";
import { zodBody } from "../auth/dto/openapi.js";
import {
  CurrentUser,
  CurrentWorkspace,
  JwtAuthGuard,
  RateLimit,
  RateLimitGuard,
  Roles,
  RolesGuard,
} from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { SteeringResult } from "./repurpose-steering.service.js";

/**
 * Steering a run's moments (2026-09-29): remove one, bring it back, change its
 * times. Beside `RepurposeController` on the same `/repurpose/runs` prefix,
 * with the same guard chain - `editor` to change anything - and the clip
 * routes' rate limit, since each can cut or cancel a clip.
 *
 * All three are naturally idempotent, so no `Idempotency-Key` is needed:
 * removing a removed moment, restoring a restored one, or asking for the times
 * a moment already has changes nothing.
 */
@ApiTags("repurpose")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("repurpose/runs")
export class RepurposeSteeringController {
  constructor(private readonly steering: RepurposeSteeringService) {}

  @Patch(":runId/candidates/:candidateId")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Change a moment's start and end",
    description:
      "Snapped to the nearest word start and word end. A moment with a clip is cut again " +
      "at the new times, and its captions, other shapes and images are made again from it. " +
      "400 `repurpose/clip_bounds_invalid` outside 3 s - 3 min or the video; 409 " +
      "`repurpose/clip_bounds_taken`, `repurpose/clip_busy` (being cut right now) or " +
      "`repurpose/candidate_removed`.",
    operationId: "adjustRepurposeCandidate",
  })
  @ApiBody(zodBody(adjustCandidateSchema))
  async adjust(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Param("candidateId") candidateId: string,
    @Body() body: AdjustCandidateDto,
  ): Promise<SteeringResult> {
    return this.steering.adjustCandidate(workspaceId, userId, runId, candidateId, body);
  }

  @Post(":runId/candidates/:candidateId/remove")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Remove a moment and its clip",
    description:
      "Stops everything still being made for its clip and hides the clip; what was made is " +
      "kept for a restore. On an Autopilot run the best moment in reserve is cut in its place " +
      "(`promoted`).",
    operationId: "removeRepurposeCandidate",
  })
  async remove(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Param("candidateId") candidateId: string,
  ): Promise<SteeringResult> {
    return this.steering.removeCandidate(workspaceId, userId, runId, candidateId);
  }

  @Post(":runId/candidates/:candidateId/restore")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Bring back a removed moment",
    description: "Its clip comes back as it was, and whatever removing it stopped is made again.",
    operationId: "restoreRepurposeCandidate",
  })
  async restore(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Param("candidateId") candidateId: string,
  ): Promise<SteeringResult> {
    return this.steering.restoreCandidate(workspaceId, userId, runId, candidateId);
  }
}
