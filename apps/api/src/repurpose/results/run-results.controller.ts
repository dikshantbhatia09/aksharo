import { Body, Controller, Get, Param, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";

import {
  EstimateQueryDto,
  HookTitlesDto,
  RetitleDto,
  hookTitlesSchema,
  retitleSchema,
} from "./run-results.dto.js";
import { RepurposeResultsService } from "./run-results.service.js";
import { zodBody } from "../../auth/dto/openapi.js";
import {
  CurrentUser,
  CurrentWorkspace,
  JwtAuthGuard,
  RateLimit,
  RateLimitGuard,
  Roles,
  RolesGuard,
} from "../../common/guards/index.js";
import { WorkspaceMemberGuard } from "../../workspaces/workspace-member.guard.js";
import { CLIP_RATE_LIMITS } from "../repurpose-clips.dto.js";

import type { RunEstimate, TranscriptLine } from "./run-results.service.js";

/**
 * A run's results page (2026-10-01, OpusClip parity): edit a clip's title in
 * place, switch Autopilot's hook titles off or on for the run, read a clip's
 * words on the original video's clock, and see what a new run would cost.
 */
@ApiTags("repurpose")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("repurpose")
export class RepurposeResultsController {
  constructor(private readonly results: RepurposeResultsService) {}

  @Put("runs/:runId/candidates/:candidateId/title")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Rename a clip",
    description:
      "The moment's title, its clip's, and the title in its words to post. Files and posts " +
      "are named after it from now on.",
    operationId: "retitleRepurposeCandidate",
  })
  @ApiBody(zodBody(retitleSchema))
  async retitle(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Param("candidateId") candidateId: string,
    @Body() body: RetitleDto,
  ): Promise<{ readonly candidateId: string; readonly title: string }> {
    return this.results.retitle(workspaceId, userId, runId, candidateId, body.title);
  }

  @Put("runs/:runId/hook-titles")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Switch Autopilot's hook titles off or on for a run",
    description:
      "Off takes Autopilot's own hook title out of every clip and keeps new clips from getting " +
      "one; on puts it back. A hook title a person added is never touched. 409 " +
      "`repurpose/hook_titles_manual` on a run whose person makes the clips.",
    operationId: "setRepurposeHookTitles",
  })
  @ApiBody(zodBody(hookTitlesSchema))
  async hookTitles(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Body() body: HookTitlesDto,
  ): Promise<{ readonly enabled: boolean; readonly changed: number }> {
    return this.results.setHookTitles(workspaceId, userId, runId, body.enabled);
  }

  @Get("runs/:runId/candidates/:candidateId/transcript")
  @Roles("viewer")
  @ApiOperation({
    summary: "A clip's words, on the original video's clock",
    operationId: "getRepurposeCandidateTranscript",
  })
  async transcript(
    @CurrentWorkspace() workspaceId: string,
    @Param("runId") runId: string,
    @Param("candidateId") candidateId: string,
  ): Promise<{ readonly offsetMs: number; readonly lines: TranscriptLine[] }> {
    return this.results.transcript(workspaceId, runId, candidateId);
  }

  @Get("estimate")
  @Roles("viewer")
  @ApiOperation({
    summary: "What a new run would cost",
    description:
      "For the start form, as it is filled in: how much of the video would be processed and " +
      "the credits that takes, with Autopilot's finished videos estimated on top.",
    operationId: "estimateRepurposeRun",
  })
  async estimate(
    @CurrentWorkspace() workspaceId: string,
    @Query() query: EstimateQueryDto,
  ): Promise<RunEstimate> {
    return this.results.estimate(workspaceId, query);
  }
}
