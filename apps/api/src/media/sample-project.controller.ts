import { Controller, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { MediaService } from "./media.service.js";
import { zodResponse } from "../auth/dto/openapi.js";
import { CurrentUser, CurrentWorkspace, JwtAuthGuard, Roles, RolesGuard } from "../common/guards/index.js";
import { projectSchema } from "../projects/projects.dto.js";
import { ProjectsService } from "../projects/projects.service.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { ProjectView } from "../projects/projects.service.js";

/**
 * "Try with a sample" (08 §Home): the empty-state button that gives a new
 * workspace something to open without waiting on a real upload.
 *
 * A real project, not a demo mode: it is created in the caller's own
 * workspace with the bundled sample clip ingested through the same pipeline
 * every upload uses (`MediaService.attachSample`), so it shows up in the
 * Recent grid and `/projects` exactly like anything else — open, duplicate,
 * archive and delete all work on it unmodified.
 */
@ApiTags("projects")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`auth/not_a_member` or `common/forbidden`." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("projects")
export class SampleProjectController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly media: MediaService,
  ) {}

  @Post("sample")
  @Roles("editor")
  @ApiOperation({
    summary: 'Create the seeded sample project ("Welcome to Aksharo")',
    description:
      "Creates a project and ingests the bundled sample clip into it through " +
      "the normal media pipeline (`media.probe` runs exactly as it would for a " +
      "real upload). Callable more than once — every call makes its own copy, " +
      "the same as duplicating a project.",
    operationId: "createSampleProject",
  })
  @ApiCreatedResponse(zodResponse(projectSchema, "The new sample project."))
  async create(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
  ): Promise<ProjectView> {
    const created = await this.projects.create(workspaceId, userId, {
      title: "Welcome to Aksharo",
      aspect: "9:16",
      sourceLanguage: "hi-Latn",
    });
    // `attachSample` wants the Prisma row, not the view `create()` returns.
    const row = await this.projects.requireProject(workspaceId, created.id);
    await this.media.attachSample(workspaceId, row);
    return this.projects.get(workspaceId, created.id);
  }
}
