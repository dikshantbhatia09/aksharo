import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { RenderPreviewService } from "./render-preview.js";
import { CurrentWorkspace, JwtAuthGuard, Roles, RolesGuard } from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { RenderPreview } from "./render-preview.js";

/**
 * `GET /projects/{projectId}/render-preview` — the read-only caption preview
 * (proxy, face track, render projection) for a project in the caller's
 * workspace. The same guards as every project route; reading is `viewer`.
 */
@ApiTags("projects")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("projects/:projectId/render-preview")
export class RenderPreviewController {
  constructor(private readonly previews: RenderPreviewService) {}

  @Get()
  @Roles("viewer")
  @ApiOperation({
    summary: "The captions preview of a project, as the share viewer renders it",
    description:
      "A signed proxy URL, the face track when there is one, and the render projection " +
      "(null until the project has an editing document). 409 until the proxy exists.",
    operationId: "getProjectRenderPreview",
  })
  async preview(
    @CurrentWorkspace() workspaceId: string,
    @Param("projectId") projectId: string,
  ): Promise<RenderPreview> {
    return this.previews.forProject(workspaceId, projectId);
  }
}
