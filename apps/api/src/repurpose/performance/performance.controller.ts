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
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";

import { ClipPostsService } from "./clip-posts.service.js";
import { PERFORMANCE_RATE_LIMITS, WHAT_WORKS_DAYS } from "./performance.constants.js";
import {
  AddPostDto,
  EnterNumbersDto,
  WhatWorksQueryDto,
  addPostSchema,
  enterNumbersSchema,
} from "./performance.dto.js";
import { WhatWorksService } from "./what-works.service.js";
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

import type { ClipPostView, RunPerformanceView, WhatWorksView } from "./performance.dto.js";

/**
 * Where a run's clips went and how they did (2026-10-05), beside the clips
 * routes on the same prefix and guard chain (`JwtAuthGuard` +
 * `WorkspaceMemberGuard` + `RolesGuard`; the workspace comes from the token,
 * never the path). `viewer` to read, `editor` to add a link, remove one or
 * type numbers in, each rate-limited per person. 404 while `repurpose_flow`
 * is off; while `repurpose_performance` is, the list answers `enabled: false`
 * and the changes 404. Every change is audited by the service.
 */
@ApiTags("repurpose")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("repurpose/runs")
export class RepurposePerformanceController {
  constructor(private readonly posts: ClipPostsService) {}

  @Get(":runId/performance")
  @Roles("viewer")
  @ApiOperation({
    summary: "Where the run's clips were posted, and how each post did",
    description:
      "Each post (from Postiz, or a pasted link) with its newest views, likes, comments and " +
      "shares - each saying whether it was measured or entered, and when - and how its numbers " +
      "are kept up to date. `clips` says, per clip, the shapes and dubbed languages a post " +
      "can be of. `enabled: false` while the feature is off for the workspace.",
    operationId: "getRepurposeRunPerformance",
  })
  async list(
    @CurrentWorkspace() workspaceId: string,
    @Param("runId") runId: string,
  ): Promise<RunPerformanceView> {
    return this.posts.runPerformance(workspaceId, runId);
  }

  @Post(":runId/clips/:clipId/performance/posts")
  @Roles("editor")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @RateLimit(PERFORMANCE_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "I posted this: follow a post of the clip by its link",
    description:
      "A link to a post on YouTube, Instagram, TikTok, LinkedIn, X, Facebook or Threads, and " +
      "the shape (and dubbed language) posted. A YouTube post's views are then read by " +
      "themselves; other platforms' numbers are typed in. 400 `performance/link_invalid`, " +
      "`link_unsupported`, `link_not_a_post`, `link_short`, `shape_unknown`, " +
      "`language_unknown`, `date_invalid`; 409 `performance/post_exists` (`details.postId`, " +
      "`details.clipId`) or `too_many_posts`.",
    operationId: "addRepurposeClipPost",
  })
  @ApiBody(zodBody(addPostSchema))
  async add(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Param("clipId") clipId: string,
    @Body() body: AddPostDto,
  ): Promise<ClipPostView> {
    return this.posts.addLink(workspaceId, userId, runId, clipId, body);
  }

  @Delete(":runId/performance/posts/:postId")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(PERFORMANCE_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Stop following a pasted post",
    description:
      "Its numbers go with it. 409 `performance/post_not_removable` for a post made through " +
      "Postiz, which is followed from there.",
    operationId: "removeRepurposeClipPost",
  })
  async remove(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Param("postId") postId: string,
  ): Promise<{ readonly removed: true }> {
    return this.posts.removePost(workspaceId, userId, runId, postId);
  }

  @Post(":runId/performance/posts/:postId/numbers")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(PERFORMANCE_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Type in a post's numbers, as read off the platform",
    description:
      "Any of views, likes, comments and shares; kept as entered, beside anything measured. " +
      "400 `performance/numbers_empty` with none.",
    operationId: "enterRepurposeClipPostNumbers",
  })
  @ApiBody(zodBody(enterNumbersSchema))
  async numbers(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Param("postId") postId: string,
    @Body() body: EnterNumbersDto,
  ): Promise<ClipPostView> {
    return this.posts.enterNumbers(workspaceId, userId, runId, postId, body);
  }
}

/**
 * "What works" (2026-10-05): the workspace's best clips and what they share.
 * `viewer`; 404 while `repurpose_performance` or `repurpose_flow` is off.
 */
@ApiTags("repurpose")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("repurpose/performance")
export class WhatWorksController {
  constructor(private readonly whatWorks: WhatWorksService) {}

  @Get("what-works")
  @Roles("viewer")
  @ApiOperation({
    summary: "What works: the clips that did best, and what they share",
    description:
      "The best clips by views and by engagement, and how clips of each length, opening, " +
      "topic word, layout, language and posting time did against the rest, compared platform " +
      "by platform - every group with its number of posts, nothing claimed from fewer than " +
      "five - and what the next runs' picks lean toward.",
    operationId: "getRepurposeWhatWorks",
  })
  @ApiQuery({
    name: "days",
    required: false,
    enum: [...WHAT_WORKS_DAYS],
    description: "The window, in days; 90 by default.",
  })
  async get(
    @CurrentWorkspace() workspaceId: string,
    @Query() query: WhatWorksQueryDto,
  ): Promise<WhatWorksView> {
    return this.whatWorks.whatWorks(workspaceId, query.days);
  }
}
