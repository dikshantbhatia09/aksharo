import { Body, Controller, Get, Param, Patch, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import { type ClientTagView, ClientTagsService } from "./client-tags.service.js";
import { clientTagViewSchema, SetClientTagDto, setClientTagSchema } from "./teams.dto.js";
import { zodArrayResponse, zodBody } from "../../auth/dto/openapi.js";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "../../common/guards/index.js";
import { context } from "../../users/users.controller.js";
import { WorkspaceMemberGuard } from "../workspace-member.guard.js";

import type { AuthPrincipal } from "../../common/guards/index.js";
import type { Request } from "express";

const projectSchema = z.object({ id: z.string(), title: z.string() });

/**
 * Client tags (04 §Plans, Agency): the tag catalogue, setting a tag on a
 * project or a folder, and the per-client project filter. Registered under
 * `/workspaces` like `OwnershipTransferController` — same guard requirement.
 */
@ApiTags("workspaces")
@Controller("workspaces")
export class ClientTagsController {
  constructor(private readonly clientTags: ClientTagsService) {}

  @Get(":id/client-tags")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("viewer")
  @ApiBearerAuth("access-token")
  @ApiOperation({ summary: "Client tags in use, with counts", operationId: "listClientTags" })
  @ApiOkResponse(zodArrayResponse(clientTagViewSchema, "Tags in use."))
  async list(@Param("id") workspaceId: string): Promise<ClientTagView[]> {
    return this.clientTags.list(workspaceId);
  }

  @Get(":id/client-tags/:tag/projects")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("viewer")
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Projects carrying a client tag",
    operationId: "listProjectsForClientTag",
  })
  @ApiOkResponse(zodArrayResponse(projectSchema, "Projects with this tag."))
  async projectsForTag(
    @Param("id") workspaceId: string,
    @Param("tag") tag: string,
  ): Promise<{ id: string; title: string }[]> {
    return this.clientTags.projectsForTag(workspaceId, tag);
  }

  @Patch(":id/projects/:projectId/client-tag")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("editor")
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Set (or clear) a project's client tag",
    operationId: "setProjectClientTag",
  })
  @ApiBody(zodBody(setClientTagSchema))
  @ApiOkResponse({ description: "The project's new client tag." })
  async setProjectTag(
    @Param("id") workspaceId: string,
    @Param("projectId") projectId: string,
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: SetClientTagDto,
    @Req() request: Request,
  ) {
    return this.clientTags.setProjectTag(
      workspaceId,
      projectId,
      body.clientTag,
      principal.userId,
      context(request),
    );
  }

  @Patch(":id/folders/:folderId/client-tag")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("editor")
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Set (or clear) a folder's client tag",
    operationId: "setFolderClientTag",
  })
  @ApiBody(zodBody(setClientTagSchema))
  @ApiOkResponse({ description: "The folder's new client tag." })
  async setFolderTag(
    @Param("id") workspaceId: string,
    @Param("folderId") folderId: string,
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: SetClientTagDto,
    @Req() request: Request,
  ) {
    return this.clientTags.setFolderTag(
      workspaceId,
      folderId,
      body.clientTag,
      principal.userId,
      context(request),
    );
  }
}
