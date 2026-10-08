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

import { zodBody, zodResponse } from "../auth/dto/openapi.js";
import {
  CurrentWorkspace,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";
import {
  googleMeetImportSchema,
  manualZoomImportSchema,
  riversideStudioImportSchema,
  updateZoomSettingsSchema,
  workspaceZoomIntegrationViewSchema,
  zoomAuthorizeUrlResponseSchema,
  zoomOAuthCallbackSchema,
  type GoogleMeetImportDto,
  type ManualZoomImportDto,
  type RiversideStudioImportDto,
  type UpdateZoomSettingsDto,
  type WorkspaceZoomIntegrationViewDto,
  type ZoomAuthorizeUrlResponseDto,
  type ZoomOAuthCallbackDto,
  type ZoomRecordingEventViewDto,
} from "./zoom.dto.js";
import { ZoomIngestService } from "./zoom-ingest.service.js";
import { ZoomService } from "./zoom.service.js";

@ApiTags("integrations")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "auth/not_a_member or common/forbidden." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller()
export class ZoomController {
  constructor(
    private readonly zoomService: ZoomService,
    private readonly zoomIngest: ZoomIngestService,
  ) {}

  @Get("integrations/zoom")
  @Roles("viewer")
  @ApiOperation({
    summary: "Get Zoom integration status and configuration for workspace",
    operationId: "getZoomIntegration",
  })
  @ApiOkResponse(zodResponse(workspaceZoomIntegrationViewSchema, "Zoom integration details."))
  async getIntegration(
    @CurrentWorkspace() workspaceId: string,
  ): Promise<WorkspaceZoomIntegrationViewDto | { connected: false }> {
    const integration = await this.zoomService.getIntegration(workspaceId);
    return integration || { connected: false };
  }

  @Post("integrations/zoom/authorize")
  @Roles("editor")
  @ApiOperation({
    summary: "Get Zoom OAuth authorization URL",
    operationId: "getZoomAuthorizeUrl",
  })
  @ApiCreatedResponse(zodResponse(zoomAuthorizeUrlResponseSchema, "OAuth redirect URL."))
  async getAuthorizeUrl(
    @CurrentWorkspace() workspaceId: string,
    @Query("state") state?: string,
  ): Promise<ZoomAuthorizeUrlResponseDto> {
    return this.zoomService.getAuthUrl(workspaceId, state);
  }

  @Post("integrations/zoom/callback")
  @Roles("editor")
  @ApiOperation({
    summary: "Connect Zoom workspace using OAuth authorization code",
    operationId: "connectZoomOAuth",
  })
  @ApiBody(zodBody(zoomOAuthCallbackSchema))
  @ApiCreatedResponse(zodResponse(workspaceZoomIntegrationViewSchema, "Connected Zoom integration."))
  async handleCallback(
    @CurrentWorkspace() workspaceId: string,
    @Body() body: ZoomOAuthCallbackDto,
  ): Promise<WorkspaceZoomIntegrationViewDto> {
    return this.zoomService.handleOAuthCallback(workspaceId, body.code, body.redirectUri);
  }

  @Patch("integrations/zoom/settings")
  @Roles("editor")
  @ApiOperation({
    summary: "Update Zoom selective ingestion rules",
    operationId: "updateZoomSettings",
  })
  @ApiBody(zodBody(updateZoomSettingsSchema))
  @ApiOkResponse(zodResponse(workspaceZoomIntegrationViewSchema, "Updated Zoom integration."))
  async updateSettings(
    @CurrentWorkspace() workspaceId: string,
    @Body() body: UpdateZoomSettingsDto,
  ): Promise<WorkspaceZoomIntegrationViewDto> {
    return this.zoomService.updateSettings(workspaceId, body);
  }

  @Delete("integrations/zoom")
  @Roles("editor")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Disconnect Zoom integration",
    operationId: "disconnectZoom",
  })
  async disconnect(@CurrentWorkspace() workspaceId: string): Promise<void> {
    return this.zoomService.disconnect(workspaceId);
  }

  @Get("integrations/zoom/events")
  @Roles("viewer")
  @ApiOperation({
    summary: "List Zoom recording events from persistent ledger",
    operationId: "listZoomEvents",
  })
  async listEvents(
    @CurrentWorkspace() workspaceId: string,
  ): Promise<ZoomRecordingEventViewDto[]> {
    return this.zoomService.listEvents(workspaceId);
  }

  @Post("integrations/zoom/import/:meetingId")
  @Roles("editor")
  @ApiOperation({
    summary: "Trigger manual import of a Zoom recording",
    operationId: "importZoomMeeting",
  })
  @ApiBody(zodBody(manualZoomImportSchema))
  async importMeeting(
    @CurrentWorkspace() workspaceId: string,
    @Param("meetingId") meetingId: string,
    @Body() body: ManualZoomImportDto,
  ): Promise<{ status: string; projectId?: string }> {
    const accessToken = await this.zoomService.getValidAccessToken(workspaceId);
    const downloadUrl =
      body.downloadUrl ||
      `https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}/recordings/download`;

    const result = await this.zoomIngest.ingestZoomRecording({
      workspaceId,
      meetingId,
      topic: body.topic || `Zoom Recording - ${meetingId}`,
      durationMin: 30,
      recordingFiles: [
        {
          file_type: "MP4",
          download_url: downloadUrl,
          recording_type: "shared_screen_with_speaker_view",
        },
      ],
      accessToken,
    });

    return {
      status: "queued",
      projectId: result.projectId,
    };
  }

  @Post("integrations/studio/riverside")
  @Roles("editor")
  @ApiOperation({
    summary: "Import Riverside.fm studio session with multi-speaker track separation",
    operationId: "importRiversideStudio",
  })
  @ApiBody(zodBody(riversideStudioImportSchema))
  async importRiverside(
    @CurrentWorkspace() workspaceId: string,
    @Body() body: RiversideStudioImportDto,
  ): Promise<{ status: string; projectId: string; tracksCount: number }> {
    const result = await this.zoomIngest.ingestRiversideSession(workspaceId, body);
    return {
      status: "ready",
      projectId: result.projectId,
      tracksCount: result.tracksCount,
    };
  }

  @Post("integrations/studio/google-meet")
  @Roles("editor")
  @ApiOperation({
    summary: "Import Google Meet cloud recording",
    operationId: "importGoogleMeet",
  })
  @ApiBody(zodBody(googleMeetImportSchema))
  async importGoogleMeet(
    @CurrentWorkspace() workspaceId: string,
    @Body() body: GoogleMeetImportDto,
  ): Promise<{ status: string; projectId: string }> {
    const result = await this.zoomIngest.ingestGoogleMeetRecording(workspaceId, body);
    return {
      status: "ready",
      projectId: result.projectId,
    };
  }
}

