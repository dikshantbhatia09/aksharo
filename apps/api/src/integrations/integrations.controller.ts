import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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

import { zodArrayResponse, zodBody, zodResponse } from "../auth/dto/openapi.js";
import {
  CurrentWorkspace,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";
import { CloudImportService } from "./cloud-import.service.js";
import { CloudIntegrationService } from "./cloud-integration.service.js";
import {
  CloudImportJobResponseDto,
  cloudImportJobResponseSchema,
  CloudIntegrationViewDto,
  cloudIntegrationViewSchema,
  ImportCloudDto,
  importCloudSchema,
  SaveCloudIntegrationDto,
  saveCloudIntegrationSchema,
} from "./integrations.dto.js";

@ApiTags("integrations")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "auth/not_a_member or common/forbidden." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller()
export class IntegrationsController {
  constructor(
    private readonly integrations: CloudIntegrationService,
    private readonly cloudImport: CloudImportService,
  ) {}

  @Get("integrations/cloud")
  @Roles("viewer")
  @ApiOperation({
    summary: "List connected third-party cloud storage accounts",
    description: "Returns connected Google Drive, Dropbox, Box, and OneDrive accounts.",
    operationId: "listCloudIntegrations",
  })
  @ApiOkResponse(zodArrayResponse(cloudIntegrationViewSchema, "List of connected cloud accounts."))
  async listIntegrations(
    @CurrentWorkspace() workspaceId: string,
  ): Promise<CloudIntegrationViewDto[]> {
    const list = await this.integrations.listIntegrations(workspaceId);
    return list.map((item) => ({
      ...item,
      expiresAt: item.expiresAt ? item.expiresAt.toISOString() : null,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    }));
  }

  @Post("integrations/cloud")
  @Roles("editor")
  @ApiOperation({
    summary: "Connect or refresh third-party cloud storage account credentials",
    description: "Tokens are encrypted at rest with AES-256-GCM.",
    operationId: "saveCloudIntegration",
  })
  @ApiBody(zodBody(saveCloudIntegrationSchema))
  @ApiCreatedResponse(zodResponse(cloudIntegrationViewSchema, "Connected integration details."))
  async saveIntegration(
    @CurrentWorkspace() workspaceId: string,
    @Body() body: SaveCloudIntegrationDto,
  ): Promise<CloudIntegrationViewDto> {
    const saved = await this.integrations.saveIntegration(workspaceId, body);
    return {
      ...saved,
      expiresAt: saved.expiresAt ? saved.expiresAt.toISOString() : null,
      createdAt: saved.createdAt.toISOString(),
      updatedAt: saved.updatedAt.toISOString(),
    };
  }

  @Delete("integrations/cloud/:id")
  @Roles("editor")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Disconnect third-party cloud storage account",
    operationId: "deleteCloudIntegration",
  })
  async deleteIntegration(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
  ): Promise<void> {
    return this.integrations.deleteIntegration(workspaceId, id);
  }

  @Post("media/import-cloud")
  @Roles("editor")
  @ApiOperation({
    summary: "Import video file directly from cloud storage",
    description:
      "Initiates zero-disk server-to-server streaming from Google Drive or Dropbox to S3 storage.",
    operationId: "importMediaFromCloud",
  })
  @ApiBody(zodBody(importCloudSchema))
  @ApiCreatedResponse(zodResponse(cloudImportJobResponseSchema, "The enqueued cloud import job."))
  async importCloud(
    @CurrentWorkspace() workspaceId: string,
    @Body() body: ImportCloudDto,
  ): Promise<CloudImportJobResponseDto> {
    return this.cloudImport.importFromCloud(workspaceId, body);
  }

  @Get("media/cloud-import/:jobId")
  @Roles("viewer")
  @ApiOperation({
    summary: "Check status of a cloud import streaming job",
    description: "Returns transfer progress percentage and completion status.",
    operationId: "getCloudImportStatus",
  })
  @ApiOkResponse(zodResponse(cloudImportJobResponseSchema, "Cloud import job status."))
  @ApiNotFoundResponse({ description: "import/job_not_found." })
  async getCloudImportStatus(
    @CurrentWorkspace() workspaceId: string,
    @Param("jobId") jobId: string,
  ): Promise<CloudImportJobResponseDto> {
    return this.cloudImport.getImportJob(workspaceId, jobId);
  }
}

