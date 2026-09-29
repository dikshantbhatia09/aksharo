import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { BulkRunsService } from "./bulk-runs.service.js";
import { AUTOMATION_RATE_LIMITS } from "./source-watch.constants.js";
import {
  BulkRunsDto,
  CreateWatchDto,
  ResolveChannelDto,
  UpdateWatchDto,
  bulkRunsResponseSchema,
  bulkRunsSchema,
  createWatchSchema,
  resolveChannelSchema,
  resolvedChannelSchema,
  updateWatchSchema,
  watchListSchema,
  watchViewSchema,
} from "./source-watch.dto.js";
import { SourceWatchService } from "./source-watch.service.js";
import { zodBody, zodResponse } from "../../auth/dto/openapi.js";
import {
  CurrentUser,
  CurrentWorkspace,
  JwtAuthGuard,
  RateLimit,
  RateLimitGuard,
  Roles,
  RolesGuard,
} from "../../common/guards/index.js";
import { IdempotencyService } from "../../public-api/v1/idempotency.service.js";
import { withIdempotency } from "../../public-api/v1/idempotent.helper.js";
import { WorkspaceMemberGuard } from "../../workspaces/workspace-member.guard.js";

import type {
  BulkRunsResponse,
  ResolvedChannelView,
  WatchList,
  WatchView,
} from "./source-watch.dto.js";
import type { Request } from "express";

/**
 * Channel automations (2026-10-02): `/repurpose/watches`.
 *
 * The guard chain every workspace-scoped module uses (`JwtAuthGuard` +
 * `WorkspaceMemberGuard` + `RolesGuard`); the workspace comes from the token,
 * never the path. `editor` to connect, change, pause, resume or remove a
 * channel - the same people who could start its runs by hand - and `viewer`
 * to read. Every route answers 404 while `repurpose_automations`,
 * `repurpose_flow` or `source_youtube_acquire` is off for the workspace.
 *
 * `resolve` is a POST because it reads YouTube and the link belongs in a body,
 * not in a query string and every access log after it. It has its own, small
 * rate limit; what it finds is cached, so the save after a preview is free.
 */
@ApiTags("repurpose")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("repurpose/watches")
export class SourceWatchController {
  constructor(private readonly watches: SourceWatchService) {}

  @Post("resolve")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(AUTOMATION_RATE_LIMITS.resolve)
  @ApiOperation({
    summary: "Which YouTube channel a link is",
    description:
      "For the form's preview: the channel's id and name, and this workspace's automation of it " +
      "when there is one. 400 `repurpose/channel_url_invalid`; 422 `repurpose/channel_not_found`; " +
      "503 `repurpose/youtube_busy` while YouTube is refusing this server; 502 " +
      "`repurpose/channel_unreadable`.",
    operationId: "resolveRepurposeChannel",
  })
  @ApiBody(zodBody(resolveChannelSchema))
  @ApiOkResponse(zodResponse(resolvedChannelSchema, "The channel."))
  async resolve(
    @CurrentWorkspace() workspaceId: string,
    @Body() body: ResolveChannelDto,
  ): Promise<ResolvedChannelView> {
    return this.watches.resolve(workspaceId, body.url);
  }

  @Get()
  @Roles("viewer")
  @ApiOperation({
    summary: "This workspace's channel automations",
    description:
      "`checksEnabled` false: this server reads no feeds right now, so nothing new starts.",
    operationId: "listRepurposeWatches",
  })
  @ApiOkResponse(zodResponse(watchListSchema, "Every automation, newest first."))
  async list(@CurrentWorkspace() workspaceId: string): Promise<WatchList> {
    return this.watches.list(workspaceId);
  }

  @Post()
  @Roles("editor")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @RateLimit(AUTOMATION_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Connect a YouTube channel: its new videos become clips on Autopilot",
    description:
      "Every video the channel publishes from now on starts a run with `setup` (the start form's " +
      "setup, always on Autopilot), as you; `backfill` (0-3) also makes clips of its latest " +
      "videos. 409 `repurpose/watch_exists` (`details.watchId`) or `repurpose/watch_limit`; " +
      "400 `repurpose/watch_setup_invalid`-style validation or `repurpose/style_unknown`.",
    operationId: "createRepurposeWatch",
  })
  @ApiBody(zodBody(createWatchSchema))
  @ApiOkResponse(zodResponse(watchViewSchema, "The automation."))
  async create(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Body() body: CreateWatchDto,
  ): Promise<WatchView> {
    return this.watches.create(workspaceId, userId, body);
  }

  @Get(":watchId")
  @Roles("viewer")
  @ApiOperation({ summary: "One channel automation", operationId: "getRepurposeWatch" })
  @ApiOkResponse(zodResponse(watchViewSchema, "The automation and its recent videos."))
  async get(
    @CurrentWorkspace() workspaceId: string,
    @Param("watchId") watchId: string,
  ): Promise<WatchView> {
    return this.watches.get(workspaceId, watchId);
  }

  @Patch(":watchId")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(AUTOMATION_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Change the settings its next runs start with",
    description: "Runs it has already started keep the settings they started with.",
    operationId: "updateRepurposeWatch",
  })
  @ApiBody(zodBody(updateWatchSchema))
  @ApiOkResponse(zodResponse(watchViewSchema, "The automation."))
  async update(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("watchId") watchId: string,
    @Body() body: UpdateWatchDto,
  ): Promise<WatchView> {
    return this.watches.update(workspaceId, userId, watchId, body);
  }

  @Post(":watchId/pause")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(AUTOMATION_RATE_LIMITS.mutate)
  @ApiOperation({ summary: "Stop picking up new videos", operationId: "pauseRepurposeWatch" })
  @ApiOkResponse(zodResponse(watchViewSchema, "The paused automation."))
  async pause(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("watchId") watchId: string,
  ): Promise<WatchView> {
    return this.watches.pause(workspaceId, userId, watchId);
  }

  @Post(":watchId/resume")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(AUTOMATION_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Pick up new videos again",
    description:
      "Checked at the next tick; a video that could not start (credits) is started then. 409 " +
      "`repurpose/watch_creator_gone` when the person it runs as is no longer an editor here.",
    operationId: "resumeRepurposeWatch",
  })
  @ApiOkResponse(zodResponse(watchViewSchema, "The automation, active again."))
  async resume(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("watchId") watchId: string,
  ): Promise<WatchView> {
    return this.watches.resume(workspaceId, userId, watchId);
  }

  @Delete(":watchId")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(AUTOMATION_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Stop following a channel",
    description: "The runs it started stay.",
    operationId: "deleteRepurposeWatch",
  })
  async remove(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("watchId") watchId: string,
  ): Promise<{ id: string }> {
    return this.watches.remove(workspaceId, userId, watchId);
  }
}

/**
 * "Several links" (2026-10-02): `POST /repurpose/runs/bulk`, beside
 * `RepurposeController` on the same prefix and guard chain. One request is one
 * token of its own small bucket; each run it starts is one token of the start
 * form's (`BulkRunsService`). Honours `Idempotency-Key` like a single start.
 */
@ApiTags("repurpose")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("repurpose/runs")
export class BulkRunsController {
  constructor(
    private readonly bulk: BulkRunsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post("bulk")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(AUTOMATION_RATE_LIMITS.bulk)
  @ApiOperation({
    summary: "Start one run per YouTube link, with one setup",
    description:
      "Up to 20 links. Line by line: `started`, `already_running` (with that run), `duplicate` " +
      "(the same video as an earlier line) or `refused` with the code a single start answers " +
      "with. Partial success is a 200.",
    operationId: "createRepurposeRunsBulk",
  })
  @ApiBody(zodBody(bulkRunsSchema))
  @ApiOkResponse(zodResponse(bulkRunsResponseSchema, "One result per link, in order."))
  async startMany(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Body() body: BulkRunsDto,
    @Req() request: Request,
  ): Promise<BulkRunsResponse> {
    return withIdempotency(
      this.idempotency,
      request,
      workspaceId,
      "POST /repurpose/runs/bulk",
      body,
      async () => this.bulk.startMany(workspaceId, userId, body),
    );
  }
}
