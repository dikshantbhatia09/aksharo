import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { RepurposeEpisodePackService, type EpisodePackView } from "./episode-pack.service.js";
import { REPURPOSE_RATE_LIMITS } from "./repurpose.constants.js";
import {
  CurrentWorkspace,
  JwtAuthGuard,
  RateLimit,
  RateLimitGuard,
  Roles,
  RolesGuard,
} from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

/**
 * `/repurpose/runs/{runId}/episode-pack` (2026-09-29): the text a clips run
 * writes for its whole video (`episode-pack.service.ts`).
 *
 * The same guard chain as the run's other routes: `viewer` to read, `editor`
 * to ask for it, and 404 while `repurpose_flow` is off. Asking is free for the
 * person and does nothing while the pack is written or being written, so the
 * rate limit is the run routes' ordinary one.
 */
@ApiTags("repurpose")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("repurpose/runs")
export class RepurposeEpisodePackController {
  constructor(private readonly packs: RepurposeEpisodePackService) {}

  @Get(":runId/episode-pack")
  @Roles("viewer")
  @ApiOperation({
    summary: "The run's episode text: chapters, descriptions and posts for the whole video",
    operationId: "getRepurposeEpisodePack",
  })
  @ApiOkResponse({ description: "`{runId, status, pack, createdAt, disclosure}`." })
  async get(
    @CurrentWorkspace() workspaceId: string,
    @Param("runId") runId: string,
  ): Promise<EpisodePackView> {
    return this.packs.view(workspaceId, runId);
  }

  @Post(":runId/episode-pack")
  @Roles("editor")
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(RateLimitGuard)
  @RateLimit(REPURPOSE_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Write the run's episode text now (or again, after it failed)",
    operationId: "writeRepurposeEpisodePack",
  })
  @ApiOkResponse({ description: "The pack as it now stands, usually `writing`." })
  async write(
    @CurrentWorkspace() workspaceId: string,
    @Param("runId") runId: string,
  ): Promise<EpisodePackView> {
    return this.packs.write(workspaceId, runId);
  }
}
