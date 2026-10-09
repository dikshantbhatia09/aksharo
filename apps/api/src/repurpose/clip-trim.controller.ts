import { Body, Controller, Param, Patch, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";

import { CLIP_RATE_LIMITS } from "./repurpose-clips.dto.js";
import { TrimClipDto, trimClipSchema } from "./repurpose-steering.dto.js";
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

import type { ClipTrimResult } from "./repurpose-steering.service.js";

/**
 * Manual Timestamp Selection & Frame-Accurate Boundary Trimming Controller (Pillar 2 §08).
 *
 * Exposes `PATCH /api/v1/projects/:id/clips/:clipId/trim` and
 * `PATCH /projects/:id/clips/:clipId/trim` to validate clip boundary updates
 * (`0 <= startSec < endSec <= videoDurationSec`), invalidate cached preview renders,
 * and return real-time re-sliced transcript words and subtitle lines.
 */
@ApiTags("repurpose")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller()
export class ClipTrimController {
  constructor(private readonly steering: RepurposeSteeringService) {}

  @Patch("api/v1/projects/:id/clips/:clipId/trim")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Trim a clip's boundaries and re-slice transcript words",
    description:
      "Validates 0 <= startSec < endSec <= videoDurationSec, updates the clip entity, " +
      "invalidates cached preview renders, and re-slices cached transcript words.",
    operationId: "trimProjectClipV1",
  })
  @ApiBody(zodBody(trimClipSchema))
  async trimV1(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("id") id: string,
    @Param("clipId") clipId: string,
    @Body() body: TrimClipDto,
  ): Promise<ClipTrimResult> {
    return this.steering.trimClip(workspaceId, userId, id, clipId, body);
  }

  @Patch("api/v1/projects/:id/clips/:clipId")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Update a clip's boundaries and re-slice transcript words",
    operationId: "updateProjectClipBoundsV1",
  })
  @ApiBody(zodBody(trimClipSchema))
  async updateClipBoundsV1(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("id") id: string,
    @Param("clipId") clipId: string,
    @Body() body: TrimClipDto,
  ): Promise<ClipTrimResult> {
    return this.steering.trimClip(workspaceId, userId, id, clipId, body);
  }

  @Patch("projects/:id/clips/:clipId/trim")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Trim a project clip's boundaries and re-slice transcript words",
    operationId: "trimProjectClip",
  })
  @ApiBody(zodBody(trimClipSchema))
  async trimProjectClip(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("id") id: string,
    @Param("clipId") clipId: string,
    @Body() body: TrimClipDto,
  ): Promise<ClipTrimResult> {
    return this.steering.trimClip(workspaceId, userId, id, clipId, body);
  }
}

