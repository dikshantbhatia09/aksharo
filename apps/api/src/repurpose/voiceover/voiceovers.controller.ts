import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { CreateVoiceoverDto, createVoiceoverSchema } from "./voiceovers.dto.js";
import {
  RepurposeVoiceoversService,
  type VoiceoverListView,
  type VoiceoverView,
} from "./voiceovers.service.js";
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

import type { Response } from "express";

/**
 * A run's voice-over hooks (2026-10-01), beside the clips and dubs routes on
 * the same prefix and guard chain: `viewer` to read, `editor` to add, retry or
 * take off; 404 while `repurpose_flow` is off and 403 `voiceover/not_enabled`
 * while `repurpose_voiceover` is. A voice-over spends real money per
 * character, so every write takes the clip routes' rate limit on top of the
 * service's own guards (credits, five live a workspace, the day's rupee budget).
 */
@ApiTags("repurpose")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("repurpose/runs")
export class RepurposeVoiceoversController {
  constructor(private readonly voiceovers: RepurposeVoiceoversService) {}

  @Get(":runId/voiceovers")
  @Roles("viewer")
  @ApiOperation({
    summary: "The run's voice-over hooks, and what each clip would say",
    description:
      "`enabled` says whether voice-overs are on for this workspace. Each clip offers its " +
      "hook line and language; each voice-over its words, voice, status and a link to listen.",
    operationId: "listRepurposeVoiceovers",
  })
  @ApiOkResponse({
    description:
      "`{runId, enabled, tenthsPerVoiceover, maxTextChars, speakers, clips, voiceovers}`.",
  })
  async list(
    @CurrentWorkspace() workspaceId: string,
    @Param("runId") runId: string,
  ): Promise<VoiceoverListView> {
    return this.voiceovers.list(workspaceId, runId);
  }

  @Post(":runId/clips/:clipId/voiceovers")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Add a spoken hook to the start of a clip",
    description:
      "The clip's hook line (or `text`) read by a stock voice in the clip's language, laid at " +
      "the start of every shape with the clip's own sound turned down under it. 201 with the " +
      "new voice-over, 200 with the one the clip already has for the same words. Holds 2 " +
      "credits. Refusals: 403 `voiceover/not_enabled`, 400 `voiceover/no_text`, 409 " +
      "`voiceover/clip_not_ready` / `voiceover/language_unsupported` / `voiceover/already_has`, " +
      "402 `voiceover/no_credits`, 429 `voiceover/too_many` / `voiceover/budget_reached`, 503 " +
      "`voiceover/budget_unavailable`.",
    operationId: "createRepurposeVoiceover",
  })
  @ApiBody(zodBody(createVoiceoverSchema))
  async create(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Param("clipId") clipId: string,
    @Body() body: CreateVoiceoverDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<VoiceoverView> {
    const { voiceover, created } = await this.voiceovers.create(
      workspaceId,
      userId,
      runId,
      clipId,
      body,
    );
    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return voiceover;
  }

  @Post(":runId/voiceovers/:voiceoverId/retry")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Make a voice-over again after a failure",
    description:
      "409 `voiceover/not_retryable` for one that did not fail, or that the voice service refused.",
    operationId: "retryRepurposeVoiceover",
  })
  async retry(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Param("voiceoverId") voiceoverId: string,
  ): Promise<VoiceoverView> {
    return this.voiceovers.retry(workspaceId, userId, runId, voiceoverId);
  }

  @Post(":runId/voiceovers/:voiceoverId/remove")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Take a voice-over off its clip",
    description:
      "Its sound is taken off every shape (the captioned videos are made again without it); " +
      "one still being made is stopped and its credits come back.",
    operationId: "removeRepurposeVoiceover",
  })
  async remove(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Param("voiceoverId") voiceoverId: string,
  ): Promise<VoiceoverView> {
    return this.voiceovers.remove(workspaceId, userId, runId, voiceoverId);
  }
}
