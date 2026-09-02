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
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { FoldersService } from "./folders.service.js";
import {
  CreateFolderDto,
  createFolderSchema,
  folderSchema,
  UpdateFolderDto,
  updateFolderSchema,
} from "./projects.dto.js";
import { zodArrayResponse, zodBody, zodResponse } from "../auth/dto/openapi.js";
import {
  CurrentUser,
  CurrentWorkspace,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { FolderView } from "./folders.service.js";

/**
 * Project folders.
 *
 * A separate collection rather than `/projects/folders`, because a folder is not
 * a project and `POST /projects/{id}` would otherwise have to disambiguate an id
 * from the word "folders". The guard stack is the same one every workspace-scoped
 * route wears.
 */
@ApiTags("projects")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`auth/not_a_member` or `common/forbidden`." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("folders")
export class FoldersController {
  constructor(private readonly folders: FoldersService) {}

  @Get()
  @Roles("viewer")
  @ApiOperation({
    summary: "The workspace's folders",
    description: "The whole tree, ordered by `position` then name; nesting is shallow by design.",
    operationId: "listFolders",
  })
  @ApiOkResponse(zodArrayResponse(folderSchema, "Every live folder in the workspace."))
  async list(@CurrentWorkspace() workspaceId: string): Promise<FolderView[]> {
    return this.folders.list(workspaceId);
  }

  @Post()
  @Roles("editor")
  @ApiOperation({ summary: "Create a folder", operationId: "createFolder" })
  @ApiBody(zodBody(createFolderSchema))
  @ApiCreatedResponse(zodResponse(folderSchema, "The new folder."))
  @ApiConflictResponse({ description: "`project/folder_cycle` when it would nest too deep." })
  async create(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Body() body: CreateFolderDto,
  ): Promise<FolderView> {
    return this.folders.create(workspaceId, userId, body);
  }

  @Get(":folderId")
  @Roles("viewer")
  @ApiOperation({ summary: "Fetch one folder", operationId: "getFolder" })
  @ApiOkResponse(zodResponse(folderSchema, "The folder."))
  @ApiNotFoundResponse({ description: "`project/folder_not_found`." })
  async get(
    @CurrentWorkspace() workspaceId: string,
    @Param("folderId") folderId: string,
  ): Promise<FolderView> {
    return this.folders.get(workspaceId, folderId);
  }

  @Patch(":folderId")
  @Roles("editor")
  @ApiOperation({
    summary: "Rename, move or reorder a folder",
    description:
      "Moving a folder inside itself or one of its descendants is `project/folder_cycle`.",
    operationId: "updateFolder",
  })
  @ApiBody(zodBody(updateFolderSchema))
  @ApiOkResponse(zodResponse(folderSchema, "The updated folder."))
  @ApiNotFoundResponse({ description: "`project/folder_not_found`." })
  @ApiConflictResponse({ description: "`project/folder_cycle`." })
  async update(
    @CurrentWorkspace() workspaceId: string,
    @Param("folderId") folderId: string,
    @Body() body: UpdateFolderDto,
  ): Promise<FolderView> {
    return this.folders.update(workspaceId, folderId, body);
  }

  @Delete(":folderId")
  @Roles("admin")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Delete an empty folder",
    description:
      "Refused while projects or child folders are still in it " +
      "(`project/folder_not_empty`): silently orphaning what is inside is how " +
      "somebody loses work they can still see.",
    operationId: "deleteFolder",
  })
  @ApiOkResponse({ schema: { type: "object", properties: { id: { type: "string" } } } })
  @ApiNotFoundResponse({ description: "`project/folder_not_found`." })
  @ApiConflictResponse({ description: "`project/folder_not_empty`." })
  async remove(
    @CurrentWorkspace() workspaceId: string,
    @Param("folderId") folderId: string,
  ): Promise<{ id: string }> {
    return this.folders.softDelete(workspaceId, folderId);
  }
}
