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
import {
  ApiBearerAuth,
  ApiBody,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";

import {
  GenerateShowNotesDto,
  generateShowNotesSchema,
  ProjectShowNotesView,
  projectShowNotesSchema,
  UpdateShowNotesDto,
  updateShowNotesSchema,
} from "./show-notes.dto.js";
import { ShowNotesService } from "./show-notes.service.js";
import { zodBody, zodResponse } from "../auth/dto/openapi.js";
import {
  CurrentWorkspace,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

@ApiTags("show-notes")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("projects")
export class ShowNotesController {
  constructor(private readonly showNotesService: ShowNotesService) {}

  @Get(":projectId/show-notes")
  @Roles("viewer")
  @ApiOperation({
    summary: "Fetch automated show notes & YouTube chapters for a project",
    operationId: "getProjectShowNotes",
  })
  @ApiOkResponse(zodResponse(projectShowNotesSchema, "The project's show notes package."))
  @ApiNotFoundResponse({ description: "`show_notes/not_found` or `project/not_found`." })
  async get(
    @CurrentWorkspace() workspaceId: string,
    @Param("projectId") projectId: string,
  ): Promise<ProjectShowNotesView | null> {
    return this.showNotesService.getShowNotes(workspaceId, projectId);
  }

  @Post(":projectId/show-notes/generate")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Generate automated show notes, key takeaways, and YouTube timestamps from project transcript",
    operationId: "generateProjectShowNotes",
  })
  @ApiBody(zodBody(generateShowNotesSchema))
  @ApiOkResponse(zodResponse(projectShowNotesSchema, "The newly generated show notes."))
  async generate(
    @CurrentWorkspace() workspaceId: string,
    @Param("projectId") projectId: string,
    @Body() body?: GenerateShowNotesDto,
  ): Promise<ProjectShowNotesView> {
    return this.showNotesService.generateShowNotes(
      workspaceId,
      projectId,
      body?.forceRegenerate ?? false,
    );
  }

  @Patch(":projectId/show-notes")
  @Roles("editor")
  @ApiOperation({
    summary: "Update existing show notes or YouTube chapters",
    operationId: "updateProjectShowNotes",
  })
  @ApiBody(zodBody(updateShowNotesSchema))
  @ApiOkResponse(zodResponse(projectShowNotesSchema, "The updated show notes."))
  async update(
    @CurrentWorkspace() workspaceId: string,
    @Param("projectId") projectId: string,
    @Body() body: UpdateShowNotesDto,
  ): Promise<ProjectShowNotesView> {
    return this.showNotesService.updateShowNotes(workspaceId, projectId, body);
  }

  @Delete(":projectId/show-notes")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Delete/reset show notes for a project",
    operationId: "deleteProjectShowNotes",
  })
  @ApiOkResponse({ schema: { type: "object", properties: { success: { type: "boolean" } } } })
  async remove(
    @CurrentWorkspace() workspaceId: string,
    @Param("projectId") projectId: string,
  ): Promise<{ success: boolean }> {
    return this.showNotesService.deleteShowNotes(workspaceId, projectId);
  }
}

