import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";

import {
  DailyPostsDto,
  PublishClipDto,
  dailyPostsSchema,
  publishClipSchema,
} from "./publishing.dto.js";
import { PublishingService } from "./publishing.service.js";
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
import { IdempotencyService } from "../public-api/v1/idempotency.service.js";
import { withIdempotency } from "../public-api/v1/idempotent.helper.js";
import { CLIP_RATE_LIMITS } from "../repurpose/repurpose-clips.dto.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type {
  ChannelView,
  PostView,
  PublishPlanView,
  PublishResultView,
  PublishingStatusView,
} from "./publishing.dto.js";
import type { Request } from "express";

/**
 * Posting clips (2026-09-29): the workspace-level routes.
 *
 * The guard chain every workspace-scoped module uses (`JwtAuthGuard` +
 * `WorkspaceMemberGuard` + `RolesGuard`); the workspace comes from the token,
 * never the path. `editor` to post, cancel or retry, and to see the channel
 * list (the accounts the workspace posts as); `viewer` for the status line.
 * Mutations share the clip routes' rate limit: each one can reach a social
 * account. Everything but `status` answers 404 while `publishing_postiz` is
 * off.
 */
@ApiTags("publishing")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("publishing")
export class PublishingController {
  constructor(private readonly publishing: PublishingService) {}

  @Get("status")
  @Roles("viewer")
  @ApiOperation({
    summary: "Whether this workspace can post clips, and what is missing if not",
    description:
      "Never an error: `enabled` false while the feature is off (the page shows no Post button), " +
      "`available` false with a `reason` and one sentence when something is missing.",
    operationId: "getPublishingStatus",
  })
  async status(@CurrentWorkspace() workspaceId: string): Promise<PublishingStatusView> {
    return this.publishing.status(workspaceId);
  }

  @Get("channels")
  @Roles("editor")
  @ApiOperation({
    summary: "The accounts connected for posting",
    description: "Each connected account, whether Aksharo posts to it, and why not.",
    operationId: "listPublishingChannels",
  })
  async channels(
    @CurrentWorkspace() workspaceId: string,
  ): Promise<{ readonly status: PublishingStatusView; readonly channels: ChannelView[] }> {
    return this.publishing.channels(workspaceId);
  }

  @Delete("posts/:postId")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Cancel a post that has not gone out",
    description:
      "A scheduled post is removed from the schedule. 409 `publishing/not_cancellable` while " +
      "it is being sent or once it is out; 503 when the schedule cannot be reached.",
    operationId: "cancelPublishingPost",
  })
  async cancel(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("postId") postId: string,
  ): Promise<PostView> {
    return this.publishing.cancel(workspaceId, userId, postId);
  }

  @Post("posts/:postId/retry")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Send a post that did not go out again",
    description:
      "409 `publishing/not_retryable` for a post that is not failed, or failed for good.",
    operationId: "retryPublishingPost",
  })
  async retry(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("postId") postId: string,
  ): Promise<PostView> {
    return this.publishing.retry(workspaceId, userId, postId);
  }
}

/**
 * Posting clips (2026-09-29): the run's routes, beside `RepurposeController`
 * on the same prefix and the same guard chain.
 *
 * The two POSTs honour `Idempotency-Key` (a retried request after a dropped
 * answer replays the first answer); the idempotency index on the posts
 * themselves is what holds a double press to one post either way.
 */
@ApiTags("repurpose")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("repurpose/runs")
export class RepurposePublishingController {
  constructor(
    private readonly publishing: PublishingService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get(":runId/clips/:clipId/publish-plan")
  @Roles("editor")
  @ApiOperation({
    summary: "What posting this clip would do",
    description:
      "Accounts (with the video shape each would get, or why it cannot), the starting text per " +
      "platform, and each account's next free day. Changes nothing.",
    operationId: "getRepurposePublishPlan",
  })
  async plan(
    @CurrentWorkspace() workspaceId: string,
    @Param("runId") runId: string,
    @Param("clipId") clipId: string,
  ): Promise<PublishPlanView> {
    return this.publishing.plan(workspaceId, runId, clipId);
  }

  @Post(":runId/clips/:clipId/posts")
  @Roles("editor")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Post a clip now, at a time, or on the next free day",
    description:
      "201 with the posts, one per account. 409 `publishing/already_posted` when the clip already " +
      "has a live post there for that slot; 409 `publishing/not_ready` without a finished " +
      "captioned video the account takes; 400 `publishing/text_invalid` or `publishing/time_invalid`.",
    operationId: "publishRepurposeClip",
  })
  @ApiBody(zodBody(publishClipSchema))
  async publish(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Param("clipId") clipId: string,
    @Body() body: PublishClipDto,
    @Req() request: Request,
  ): Promise<PublishResultView> {
    return withIdempotency(
      this.idempotency,
      request,
      workspaceId,
      `POST /repurpose/runs/${runId}/clips/${clipId}/posts`,
      body,
      async () => this.publishing.publish(workspaceId, userId, runId, clipId, body),
    );
  }

  @Get(":runId/posts")
  @Roles("viewer")
  @ApiOperation({
    summary: "A run's posts, newest first",
    description: "Optionally one clip's (`clipId`).",
    operationId: "listRepurposePosts",
  })
  async list(
    @CurrentWorkspace() workspaceId: string,
    @Param("runId") runId: string,
    @Query("clipId") clipId?: string,
  ): Promise<{ readonly posts: PostView[] }> {
    return this.publishing.list(workspaceId, runId, clipId);
  }

  @Post(":runId/posts/daily")
  @Roles("editor")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @RateLimit(CLIP_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Post one a day",
    description:
      "Each chosen clip on its own day at `time` (default 19:00, India time), per account, " +
      "skipping days an account already posts on. Pairs that cannot be posted are listed in `skipped`.",
    operationId: "scheduleRepurposeDailyPosts",
  })
  @ApiBody(zodBody(dailyPostsSchema))
  async daily(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Body() body: DailyPostsDto,
    @Req() request: Request,
  ): Promise<PublishResultView> {
    return withIdempotency(
      this.idempotency,
      request,
      workspaceId,
      `POST /repurpose/runs/${runId}/posts/daily`,
      body,
      async () => this.publishing.daily(workspaceId, userId, runId, body),
    );
  }
}
