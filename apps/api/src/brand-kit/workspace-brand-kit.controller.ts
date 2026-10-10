import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import {
  UpdateWorkspaceBrandKitDto,
  workspaceBrandKitSchema,
  updateWorkspaceBrandKitSchema,
  type WorkspaceBrandKitView,
} from "./workspace-brand-kit.dto.js";
import { WorkspaceBrandKitService } from "./workspace-brand-kit.service.js";
import { zodBody, zodResponse } from "../auth/dto/openapi.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import {
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

@ApiTags("brand-kit")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller(["api/v1/workspaces/:id/brand-kit", "workspaces/:id/brand-kit"])
export class WorkspaceBrandKitController {
  constructor(
    private readonly workspaceBrandKitService: WorkspaceBrandKitService,
    private readonly audit: CommonAuditService,
  ) {}

  @Get()
  @Roles("viewer")
  @ApiOperation({
    summary: "Fetch active workspace brand kit and bumper settings",
    description: "Returns configured corner logo bug, bumpers (intro/outro), and social badges.",
    operationId: "getWorkspaceBrandKit",
  })
  @ApiOkResponse(zodResponse(workspaceBrandKitSchema, "Active brand kit configuration."))
  async get(@Param("id") workspaceId: string): Promise<WorkspaceBrandKitView> {
    return this.workspaceBrandKitService.get(workspaceId);
  }

  @Put()
  @Roles("editor")
  @ApiOperation({
    summary: "Update workspace brand kit, bumpers, and handles",
    description: "Save logo, bumpers, opacity, and scale settings for the workspace.",
    operationId: "updateWorkspaceBrandKit",
  })
  @ApiBody(zodBody(updateWorkspaceBrandKitSchema))
  @ApiOkResponse(zodResponse(workspaceBrandKitSchema, "Updated brand kit configuration."))
  async update(
    @Param("id") workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Body() body: UpdateWorkspaceBrandKitDto,
  ): Promise<WorkspaceBrandKitView> {
    const updated = await this.workspaceBrandKitService.update(workspaceId, body);
    await this.audit.record({
      action: "workspace.brand_kit.updated",
      resource: "workspace_brand_kit",
      actorId: userId,
      workspaceId,
      data: {
        logoPosition: updated.logoPosition,
        logoScalePct: updated.logoScalePct,
        hasIntro: Boolean(updated.introVideoUrl),
        hasOutro: Boolean(updated.outroVideoUrl),
      },
    });
    return updated;
  }
}
