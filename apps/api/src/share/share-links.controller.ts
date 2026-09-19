import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { z } from "zod";

import { type Env, surfaceEnabled } from "@montaj/config";

import { ShareLinksService, type ShareLinkView } from "./share-links.service.js";
import { SHARE_RATE_LIMITS } from "./share.constants.js";
import { CreateShareLinkDto, createShareLinkSchema, shareLinkSchema } from "./share.dto.js";
import { zodBody, zodResponse } from "../auth/dto/openapi.js";
import {
  CurrentUser,
  CurrentWorkspace,
  JwtAuthGuard,
  RateLimit,
  RateLimitGuard,
  Roles,
  RolesGuard,
} from "../common/guards/index.js";
import { ENV } from "../config/config.module.js";
import { ulidSchema } from "../projects/projects.dto.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

/**
 * Owner-side share-link management, mounted under a project
 * (`/projects/:projectId/share-links`) — the counterpart to the public
 * `/s/:token` viewer `PublicViewerController` exposes.
 *
 * Every route wears the same three guards `ProjectsController` does
 * (THREAT-MODEL T4, T5): `JwtAuthGuard`, `WorkspaceMemberGuard`, `RolesGuard`.
 * Creating a link is `editor`; revoking one is `admin`, same ladder reasoning
 * as deleting a project — a link is reach into the workspace's content that a
 * demoted editor should not still be able to hand out.
 */
@ApiTags("share-links")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("projects/:projectId/share-links")
export class ShareLinksController {
  constructor(
    private readonly shareLinks: ShareLinksService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private assertSurfaceEnabled(): void {
    if (!surfaceEnabled("publicShares", this.env.FEATURE_FLAGS_JSON)) {
      throw new NotFoundException({
        error: { code: "common/not_found", message: "Not found." },
      });
    }
  }

  @Post()
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(SHARE_RATE_LIMITS.createLink)
  @ApiOperation({ summary: "Create a share link for review", operationId: "createShareLink" })
  @ApiBody(zodBody(createShareLinkSchema))
  @ApiCreatedResponse(zodResponse(shareLinkSchema, "The new share link."))
  async create(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("projectId") projectId: string,
    @Body() body: CreateShareLinkDto,
  ): Promise<ShareLinkView> {
    this.assertSurfaceEnabled();
    ulidSchema.parse(projectId);
    return this.shareLinks.create(workspaceId, userId, projectId, body, this.env.WEB_ORIGIN);
  }

  @Get()
  @Roles("viewer")
  @ApiOperation({ summary: "List a project's share links", operationId: "listShareLinks" })
  @ApiOkResponse(zodResponse(z.array(shareLinkSchema), "Share links for the project."))
  async list(
    @CurrentWorkspace() workspaceId: string,
    @Param("projectId") projectId: string,
  ): Promise<ShareLinkView[]> {
    this.assertSurfaceEnabled();
    return this.shareLinks.list(workspaceId, projectId, this.env.WEB_ORIGIN);
  }

  @Delete(":shareLinkId")
  @Roles("admin")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Revoke a share link", operationId: "revokeShareLink" })
  async revoke(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("projectId") projectId: string,
    @Param("shareLinkId") shareLinkId: string,
  ): Promise<void> {
    this.assertSurfaceEnabled();
    await this.shareLinks.revoke(workspaceId, userId, projectId, shareLinkId);
  }
}
