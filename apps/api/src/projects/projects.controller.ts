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
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { PROJECT_RATE_LIMITS } from "./projects.constants.js";
import {
  BatchCreateProjectsDto,
  batchCreateProjectsSchema,
  batchCreateResultSchema,
  CreateProjectDto,
  createProjectSchema,
  ListProjectsQueryDto,
  projectPageSchema,
  projectSchema,
  UpdateProjectDto,
  updateProjectSchema,
} from "./projects.dto.js";
import { ProjectsService } from "./projects.service.js";
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
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { Page, ProjectView } from "./projects.service.js";

/**
 * Projects.
 *
 * **Every route wears `JwtAuthGuard`, `WorkspaceMemberGuard` and `RolesGuard`,
 * in that order** (THREAT-MODEL T4, T5). There is no workspace id in any of these
 * paths and there is deliberately no `X-Workspace-Id` header (07 §Conventions):
 * the workspace comes from the token's `ws` claim, and `WorkspaceMemberGuard`
 * re-reads the membership on every request so a removal or a demotion bites at
 * once rather than at the end of a fifteen-minute token.
 *
 * The role ladder is `viewer < editor < admin < owner`, and each route names the
 * lowest role that may call it: reading is `viewer`, creating and editing are
 * `editor`, and deleting a project is `admin` because a soft delete takes a whole
 * project's work off every other member's screen.
 */
@ApiTags("projects")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`auth/not_a_member` or `common/forbidden`." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("projects")
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @Roles("viewer")
  @ApiOperation({
    summary: "List the workspace's projects, newest first",
    description:
      "Cursor pagination: pass the previous page's `nextCursor` as `cursor`. " +
      "Filters: `q` (title substring), `status`, `folder` (a folder id or `root`) " +
      "and `clientTag`. Deleted projects are never returned.",
    operationId: "listProjects",
  })
  @ApiOkResponse(zodResponse(projectPageSchema, "One page of projects."))
  async list(
    @CurrentWorkspace() workspaceId: string,
    @Query() query: ListProjectsQueryDto,
  ): Promise<Page<ProjectView>> {
    return this.projects.list(workspaceId, query);
  }

  @Post()
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(PROJECT_RATE_LIMITS.createProject)
  @ApiOperation({
    summary: "Create a project",
    description:
      "The retention window opens now, at the plan's length, and every upload " +
      "pushes it out again (D47).",
    operationId: "createProject",
  })
  @ApiBody(zodBody(createProjectSchema))
  @ApiCreatedResponse(zodResponse(projectSchema, "The new project."))
  @ApiNotFoundResponse({ description: "`project/folder_not_found`." })
  async create(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Body() body: CreateProjectDto,
  ): Promise<ProjectView> {
    return this.projects.create(workspaceId, userId, body);
  }

  @Post("batch")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(PROJECT_RATE_LIMITS.createProject)
  @ApiOperation({
    summary: "Create several projects at once",
    description:
      "One transaction: the batch lands whole or not at all. This creates the " +
      "rows only — batch *orchestration* (upload, transcribe and report as one " +
      "unit) is a later work package and builds on these.",
    operationId: "batchCreateProjects",
  })
  @ApiBody(zodBody(batchCreateProjectsSchema))
  @ApiCreatedResponse(zodResponse(batchCreateResultSchema, "The projects created."))
  async batch(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Body() body: BatchCreateProjectsDto,
  ): Promise<{ created: ProjectView[] }> {
    return { created: await this.projects.batchCreate(workspaceId, userId, body) };
  }

  @Get(":projectId")
  @Roles("viewer")
  @ApiOperation({ summary: "Fetch one project", operationId: "getProject" })
  @ApiOkResponse(zodResponse(projectSchema, "The project."))
  @ApiNotFoundResponse({ description: "`project/not_found`, including another tenant's id." })
  async get(
    @CurrentWorkspace() workspaceId: string,
    @Param("projectId") projectId: string,
  ): Promise<ProjectView> {
    return this.projects.get(workspaceId, projectId);
  }

  @Patch(":projectId")
  @Roles("editor")
  @ApiOperation({
    summary: "Rename, re-file, re-tag or archive a project",
    description: 'Archiving is `status: "archived"`; there is no separate route for it.',
    operationId: "updateProject",
  })
  @ApiBody(zodBody(updateProjectSchema))
  @ApiOkResponse(zodResponse(projectSchema, "The updated project."))
  @ApiNotFoundResponse({ description: "`project/not_found` or `project/folder_not_found`." })
  async update(
    @CurrentWorkspace() workspaceId: string,
    @Param("projectId") projectId: string,
    @Body() body: UpdateProjectDto,
  ): Promise<ProjectView> {
    return this.projects.update(workspaceId, projectId, body);
  }

  @Delete(":projectId")
  @Roles("admin")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Delete a project",
    description:
      "A soft delete: the row is marked and the objects go when retention runs " +
      "(D47), so an accidental click is recoverable until then.",
    operationId: "deleteProject",
  })
  @ApiOkResponse({ schema: { type: "object", properties: { id: { type: "string" } } } })
  @ApiNotFoundResponse({ description: "`project/not_found`." })
  async remove(
    @CurrentWorkspace() workspaceId: string,
    @Param("projectId") projectId: string,
  ): Promise<{ id: string }> {
    return this.projects.softDelete(workspaceId, projectId);
  }
}
