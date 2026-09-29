import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import {
  CreateCompilationDto,
  CreateSeriesDto,
  createCompilationSchema,
  createSeriesSchema,
} from "./compilations.dto.js";
import { RepurposeCompilationsService, type CompilationView } from "./compilations.service.js";
import { CLIP_RATE_LIMITS } from "./repurpose-clips.dto.js";
import { RepurposeSeriesService, type SeriesView } from "./series.service.js";
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

import type { Response } from "express";

/**
 * A run's compilations and series (2026-10-03), beside `RepurposeController`
 * on the same `/repurpose/runs` prefix and guard chain: `viewer` to read,
 * `editor` to make or delete, and 404 while `repurpose_flow` is off. Making
 * one renders video, so it takes the clip routes' rate limit.
 *
 * Both writes are idempotent by what they ask for: the same clips, shape and
 * title are one compilation (answered 200 with it rather than 201), and a clip
 * already in a series is refused rather than labelled twice.
 */
@ApiTags("repurpose")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("repurpose/runs")
export class RepurposeCompilationsController {
  constructor(
    private readonly compilations: RepurposeCompilationsService,
    private readonly series: RepurposeSeriesService,
  ) {}

  @Get(":runId/compilations")
  @Roles("viewer")
  @ApiOperation({
    summary: "The run's compilations: each with its state, and its file to play and download",
    operationId: "listRepurposeCompilations",
  })
  @ApiOkResponse({ description: "`{runId, compilations}`, newest first." })
  async list(
    @CurrentWorkspace() workspaceId: string,
    @Param("runId") runId: string,
  ): Promise<{ readonly runId: string; readonly compilations: CompilationView[] }> {
    return this.compilations.list(workspaceId, runId);
  }

  @Get(":runId/compilations/:compilationId")
  @Roles("viewer")
  @ApiOperation({ summary: "One compilation", operationId: "getRepurposeCompilation" })
  async get(
    @CurrentWorkspace() workspaceId: string,
    @Param("runId") runId: string,
    @Param("compilationId") compilationId: string,
  ): Promise<CompilationView> {
    return this.compilations.get(workspaceId, runId, compilationId);
  }

  @Post(":runId/compilations")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Join clips into one video: a best of, in one shape, with an optional title card",
    description:
      "Joins each clip's captioned video in `shape`, in the order given, with a half-second " +
      "fade between them and, with a `title`, a two-second card first in the brand kit's " +
      "colours. 201 with the new compilation, 200 with the one these clips, shape and title " +
      "already made. 409 `repurpose/compilation_clips_not_ready` (`details.clipIds`) when a " +
      "clip has no captioned video in that shape; 400 `repurpose/compilation_too_long` past " +
      "15 minutes. Costs the cloud render rate on the joined video's minutes.",
    operationId: "createRepurposeCompilation",
  })
  @ApiBody(zodBody(createCompilationSchema))
  async create(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Body() body: CreateCompilationDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CompilationView> {
    const { compilation, created } = await this.compilations.create(
      workspaceId,
      userId,
      runId,
      body,
    );
    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return compilation;
  }

  @Post(":runId/compilations/:compilationId/retry")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Make a compilation again: failed, expired, or its clips changed since",
    description:
      "Joins the clips' current captioned videos; the earlier file is replaced. 409 " +
      "`repurpose/compilation_not_retryable` while it is being made, or when it is made and " +
      "current.",
    operationId: "retryRepurposeCompilation",
  })
  async retry(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Param("compilationId") compilationId: string,
  ): Promise<CompilationView> {
    return this.compilations.retry(workspaceId, userId, runId, compilationId);
  }

  @Delete(":runId/compilations/:compilationId")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Delete a compilation and its file",
    description: "A compilation being made stops.",
    operationId: "deleteRepurposeCompilation",
  })
  async remove(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Param("compilationId") compilationId: string,
  ): Promise<{ readonly id: string }> {
    await this.compilations.remove(workspaceId, userId, runId, compilationId);
    return { id: compilationId };
  }

  @Get(":runId/series")
  @Roles("viewer")
  @ApiOperation({
    summary: "The run's series: clips labelled Part 1, Part 2, ...",
    operationId: "listRepurposeSeries",
  })
  async listSeries(
    @CurrentWorkspace() workspaceId: string,
    @Param("runId") runId: string,
  ): Promise<{ readonly runId: string; readonly series: SeriesView[] }> {
    return this.series.list(workspaceId, runId);
  }

  @Post(":runId/series")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Make a series: each clip says Part N of M, and but the last, Part N+1 next",
    description:
      "Numbered in the order the clips play in the video. The labels go on every shape of " +
      "each clip as hook titles (Autopilot's own hook title gives way and is kept for " +
      "undoing; a person's own is never touched), and the captioned videos are made again. " +
      "409 `repurpose/series_clips_not_ready` or `repurpose/series_clip_taken` (a clip is " +
      "in another series).",
    operationId: "createRepurposeSeries",
  })
  @ApiBody(zodBody(createSeriesSchema))
  async createSeries(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Body() body: CreateSeriesDto,
  ): Promise<SeriesView> {
    return this.series.create(workspaceId, userId, runId, body);
  }

  @Delete(":runId/series/:seriesId")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Remove series labels: every label comes off, and what it replaced goes back",
    operationId: "deleteRepurposeSeries",
  })
  async removeSeries(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Param("seriesId") seriesId: string,
  ): Promise<{ readonly id: string; readonly restored: number }> {
    return this.series.remove(workspaceId, userId, runId, seriesId);
  }
}
