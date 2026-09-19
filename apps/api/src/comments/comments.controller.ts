import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import { type Env, surfaceEnabled } from "@montaj/config";

import { CommentsService, type CommentView } from "./comments.service.js";
import { zodBody, zodResponse } from "../auth/dto/openapi.js";
import {
  CurrentUser,
  JwtAuthGuard,
  Public,
  RateLimit,
  RateLimitGuard,
  Roles,
  RolesGuard,
} from "../common/guards/index.js";
import { ENV } from "../config/config.module.js";
import { ShareLinksService } from "../share/share-links.service.js";
import { SHARE_RATE_LIMITS, SHARE_SESSION_HEADER } from "../share/share.constants.js";
import {
  commentSchema,
  createCommentSchema,
  CreateCommentDto,
  ListCommentsQueryDto,
  resolveCommentSchema,
  ResolveCommentDto,
} from "../share/share.dto.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

/**
 * Comments on a project's timeline (B15 brief §2), reachable two ways:
 *
 *  - authenticated workspace members, under `/projects/:id/comments`
 *    (`JwtAuthGuard`/`WorkspaceMemberGuard`/`RolesGuard`, same ladder as
 *    `ProjectsController`);
 *  - a public share-link reviewer, under `/s/:token/comments`, gated on the
 *    link's scope (`comment` or `approve`) rather than a role.
 *
 * Both paths write the same `comments` row and land in the same editor Review
 * panel — the only difference is who is allowed to post and how that caller is
 * identified (`authorId` vs. a guest name/email hash).
 */
@ApiTags("comments")
@Controller()
export class CommentsController {
  constructor(
    private readonly comments: CommentsService,
    private readonly shareLinks: ShareLinksService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private assertPublicSharesEnabled(): void {
    if (!surfaceEnabled("publicShares", this.env.FEATURE_FLAGS_JSON)) {
      throw new NotFoundException({
        error: { code: "common/not_found", message: "Not found." },
      });
    }
  }

  @Get("projects/:projectId/comments")
  @ApiBearerAuth("access-token")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("viewer")
  @ApiOperation({ summary: "List a project's comments", operationId: "listComments" })
  @ApiOkResponse(zodResponse(z.array(commentSchema), "Comments for the project."))
  async list(
    @Param("projectId") projectId: string,
    @Query() query: ListCommentsQueryDto,
  ): Promise<CommentView[]> {
    return this.comments.list(projectId, { resolved: query.resolved, segmentId: query.segmentId });
  }

  @Post("projects/:projectId/comments")
  @ApiBearerAuth("access-token")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("viewer")
  @ApiOperation({ summary: "Add a comment as a workspace member", operationId: "addComment" })
  @ApiBody(zodBody(createCommentSchema))
  async add(
    @CurrentUser("userId") userId: string,
    @Param("projectId") projectId: string,
    @Body() body: CreateCommentDto,
  ): Promise<CommentView> {
    return this.comments.add({ ...body, projectId, authorId: userId });
  }

  @Patch("projects/:projectId/comments/:commentId")
  @ApiBearerAuth("access-token")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("viewer")
  @ApiOperation({ summary: "Resolve or reopen a comment", operationId: "resolveComment" })
  @ApiBody(zodBody(resolveCommentSchema))
  async resolve(
    @Param("projectId") projectId: string,
    @Param("commentId") commentId: string,
    @Body() body: ResolveCommentDto,
  ): Promise<CommentView> {
    return this.comments.resolve(projectId, commentId, body.resolved);
  }

  @Get("s/:token/comments")
  @Public()
  @ApiOperation({ summary: "List comments through a share link", operationId: "listShareComments" })
  async listPublic(
    @Param("token") token: string,
    @Headers(SHARE_SESSION_HEADER) session: string | undefined,
  ): Promise<CommentView[]> {
    this.assertPublicSharesEnabled();
    const { shareLink } = await this.shareLinks.resolve(token, session);
    return this.comments.list(shareLink.projectId, {});
  }

  @Post("s/:token/comments")
  @Public()
  @UseGuards(RateLimitGuard)
  @RateLimit(SHARE_RATE_LIMITS.postComment)
  @ApiOperation({ summary: "Comment through a share link", operationId: "addShareComment" })
  @ApiBody(zodBody(createCommentSchema))
  async addPublic(
    @Param("token") token: string,
    @Headers(SHARE_SESSION_HEADER) session: string | undefined,
    @Body() body: CreateCommentDto,
  ): Promise<CommentView> {
    this.assertPublicSharesEnabled();
    const { shareLink } = await this.shareLinks.resolve(token, session);
    this.shareLinks.assertScope(shareLink.scope, "comment");
    return this.comments.add({
      ...body,
      projectId: shareLink.projectId,
      shareLinkId: shareLink.id,
    });
  }
}
