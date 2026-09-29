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

import { CreateDubDto, createDubSchema } from "./dubs.dto.js";
import { RepurposeDubsService, type DubListView, type DubView } from "./dubs.service.js";
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
 * A run's dubs (2026-10-04), beside the clips routes on the same prefix and
 * guard chain: `viewer` to read, `editor` to dub, retry or cancel; 404 while
 * `repurpose_flow` is off and 403 `dub/not_enabled` while `repurpose_dubbing`
 * is. Dubbing spends real money per minute per language, so every write takes
 * the clip routes' rate limit on top of the service's own guards (credits, the
 * plan's hold, three live dubs a workspace, the day's rupee budget).
 */
@ApiTags("repurpose")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("repurpose/runs")
export class RepurposeDubsController {
  constructor(private readonly dubs: RepurposeDubsService) {}

  @Get(":runId/dubs")
  @Roles("viewer")
  @ApiOperation({
    summary: "The run's dubs, and what each clip can be dubbed into",
    description:
      "`enabled` says whether dubbing is on for this workspace. Each clip offers its language, " +
      "its length and the languages already dubbed or being dubbed; each dub its languages, " +
      "each with its shapes' captioned and clean videos once made.",
    operationId: "listRepurposeDubs",
  })
  @ApiOkResponse({ description: "`{runId, enabled, tenthsPerMinute, languages, clips, dubs}`." })
  async list(
    @CurrentWorkspace() workspaceId: string,
    @Param("runId") runId: string,
  ): Promise<DubListView> {
    return this.dubs.list(workspaceId, runId);
  }

  @Post(":runId/clips/:clipId/dubs")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Dub a clip into other languages, in the speaker's own voice",
    description:
      "One vendor job for every language asked for; then every shape of the clip in each " +
      "language, captioned in it. `consent: true` records that the caller may use and clone " +
      "the speaker's voice. 201 with the new dub, 200 with the one these languages already have. " +
      "Holds 25 credits a minute a language. Refusals: 403 `dub/not_enabled`, 400 " +
      "`dub/consent_required` / `dub/same_language`, 409 `dub/clip_not_ready` / " +
      "`dub/source_unsupported` / `dub/language_taken`, 402 `dub/no_credits` / " +
      "`dub/plan_limit`, 429 `dub/too_many` / `dub/budget_reached`, 503 `dub/budget_unavailable`.",
    operationId: "createRepurposeDub",
  })
  @ApiBody(zodBody(createDubSchema))
  async create(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Param("clipId") clipId: string,
    @Body() body: CreateDubDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DubView> {
    const { dub, created } = await this.dubs.create(workspaceId, userId, runId, clipId, body);
    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return dub;
  }

  @Post(":runId/dubs/:dubId/retry")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Dub again after a failure",
    description:
      "A vendor job that did not itself fail is resumed, not paid for again. 409 " +
      "`dub/not_retryable` for a dub that did not fail, or that the vendor refused.",
    operationId: "retryRepurposeDub",
  })
  async retry(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Param("dubId") dubId: string,
  ): Promise<DubView> {
    return this.dubs.retry(workspaceId, userId, runId, dubId);
  }

  @Post(":runId/dubs/:dubId/cancel")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Stop a dub that is waiting or with the vendor",
    description:
      "The vendor's job is cancelled too and the credits held come back. 409 " +
      "`dub/not_cancellable` once the vendor has finished.",
    operationId: "cancelRepurposeDub",
  })
  async cancel(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Param("dubId") dubId: string,
  ): Promise<DubView> {
    return this.dubs.cancel(workspaceId, userId, runId, dubId);
  }
}
