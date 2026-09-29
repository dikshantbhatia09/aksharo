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
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";

import { ClipReviewService } from "./clip-review.service.js";
import { REVIEW_RATE_LIMITS } from "./review.constants.js";
import {
  AddClipCommentDto,
  CreateReviewLinkDto,
  ResolveClipCommentDto,
  ReviewDecisionDto,
  addClipCommentSchema,
  createReviewLinkSchema,
  resolveClipCommentSchema,
  reviewDecisionSchema,
} from "./review.dto.js";
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

import type {
  ClipCommentView,
  ClipReviewDetailView,
  ClipReviewSummaryView,
  CreatedReviewLinkView,
  ReviewLinkView,
  RunReviewView,
} from "./review.dto.js";
import type { AuthPrincipal } from "../../common/guards/index.js";

/**
 * Clip review, the team's routes (2026-10-03), beside `RepurposeController` on
 * the same `/repurpose/runs` prefix and the same guard chain; the workspace
 * comes from the token, never the path.
 *
 * Roles (`review-state.ts` has the reasons): everyone reads and comments;
 * editors ask for changes, see the client links and revoke them; owners and
 * admins approve and make client links. `@Roles` on the decision route is the
 * lower bar (editor); approving is checked again in the service, which knows
 * which decision was asked for. `WorkspaceMemberGuard` has refreshed the role
 * from the database by the time a handler runs, so a demotion bites on the next
 * request.
 */
@ApiTags("repurpose")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("repurpose/runs")
export class ClipReviewController {
  constructor(private readonly reviews: ClipReviewService) {}

  @Get(":runId/review")
  @Roles("viewer")
  @ApiOperation({
    summary: "Where each of a run's clips stands in review",
    description:
      "Per clip: pending, approved or changes requested, who decided and when, the shapes the " +
      "decision covers, the video it would be made on now, and the comment count. Also whether " +
      "the workspace needs approval before posting, and what the caller may do. A clip whose " +
      "video changed after its decision is returned to pending first.",
    operationId: "getRepurposeRunReview",
  })
  async runReview(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser() principal: AuthPrincipal,
    @Param("runId") runId: string,
  ): Promise<RunReviewView> {
    return this.reviews.runReview(workspaceId, runId, principal);
  }

  @Get(":runId/clips/:clipId/review")
  @Roles("viewer")
  @ApiOperation({
    summary: "One clip's review: its state, history and comments",
    operationId: "getRepurposeClipReview",
  })
  async clipReview(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser() principal: AuthPrincipal,
    @Param("runId") runId: string,
    @Param("clipId") clipId: string,
  ): Promise<ClipReviewDetailView> {
    return this.reviews.clipReview(workspaceId, runId, clipId, principal);
  }

  @Post(":runId/clips/:clipId/review")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(REVIEW_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Approve a clip, or ask for changes",
    description:
      "Approving takes an owner or admin (403 `review/forbidden` otherwise) and a finished " +
      "captioned video (409 `review/no_video`); it covers the clip's videos as they are now. " +
      "`note` becomes a comment too. `expect` is the videos the page showed (shape to export " +
      "id): 409 `review/video_changed` when they have changed since. 409 `review/busy` when " +
      "another decision landed at the same moment.",
    operationId: "decideRepurposeClipReview",
  })
  @ApiBody(zodBody(reviewDecisionSchema))
  async decide(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser() principal: AuthPrincipal,
    @Param("runId") runId: string,
    @Param("clipId") clipId: string,
    @Body() body: ReviewDecisionDto,
  ): Promise<ClipReviewSummaryView> {
    return this.reviews.decideAsMember(workspaceId, principal, runId, clipId, body);
  }

  @Post(":runId/clips/:clipId/comments")
  @Roles("viewer")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @RateLimit(REVIEW_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Comment on a clip, optionally at a moment in it",
    operationId: "addRepurposeClipComment",
  })
  @ApiBody(zodBody(addClipCommentSchema))
  async addComment(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser() principal: AuthPrincipal,
    @Param("runId") runId: string,
    @Param("clipId") clipId: string,
    @Body() body: AddClipCommentDto,
  ): Promise<ClipCommentView> {
    return this.reviews.addMemberComment(workspaceId, principal, runId, clipId, body);
  }

  @Patch(":runId/clips/:clipId/comments/:commentId")
  @Roles("viewer")
  @UseGuards(RateLimitGuard)
  @RateLimit(REVIEW_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Resolve or reopen a comment",
    description: "Editors and up resolve any comment; anyone their own (403 `review/forbidden`).",
    operationId: "resolveRepurposeClipComment",
  })
  @ApiBody(zodBody(resolveClipCommentSchema))
  async resolveComment(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser() principal: AuthPrincipal,
    @Param("runId") runId: string,
    @Param("clipId") clipId: string,
    @Param("commentId") commentId: string,
    @Body() body: ResolveClipCommentDto,
  ): Promise<ClipCommentView> {
    return this.reviews.resolveComment(
      workspaceId,
      principal,
      runId,
      clipId,
      commentId,
      body.resolved,
    );
  }

  @Get(":runId/review-links")
  @Roles("editor")
  @ApiOperation({
    summary: "A run's client review links",
    description: "Never the link itself: that is shown once, when it is made.",
    operationId: "listRepurposeReviewLinks",
  })
  async links(
    @CurrentWorkspace() workspaceId: string,
    @Param("runId") runId: string,
  ): Promise<{ readonly links: ReviewLinkView[] }> {
    return { links: await this.reviews.listLinks(workspaceId, runId) };
  }

  @Post(":runId/review-links")
  @Roles("admin")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @RateLimit(REVIEW_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Share a run's clips for review with someone who has no account",
    description:
      "Owners and admins: the client's approval counts. `expiresInDays` 1-30 (7). The answer " +
      "carries `url`, the only time the link is shown. 409 `review/too_many_links` past 20 " +
      "live links on one run; 404 while public links are off.",
    operationId: "createRepurposeReviewLink",
  })
  @ApiBody(zodBody(createReviewLinkSchema))
  async createLink(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser() principal: AuthPrincipal,
    @Param("runId") runId: string,
    @Body() body: CreateReviewLinkDto,
  ): Promise<CreatedReviewLinkView> {
    return this.reviews.createLink(workspaceId, principal, runId, body);
  }

  @Delete(":runId/review-links/:linkId")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(REVIEW_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Revoke a client review link",
    description: "It stops opening at once. What its client already said stays.",
    operationId: "revokeRepurposeReviewLink",
  })
  async revokeLink(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser() principal: AuthPrincipal,
    @Param("runId") runId: string,
    @Param("linkId") linkId: string,
  ): Promise<ReviewLinkView> {
    return this.reviews.revokeLink(workspaceId, principal, runId, linkId);
  }
}
