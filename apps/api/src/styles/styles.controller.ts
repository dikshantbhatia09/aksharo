import { Controller, Get, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { stylePageSchema } from "./styles.dto.js";
import { StylesService } from "./styles.service.js";
import { zodResponse } from "../auth/dto/openapi.js";
import { CurrentWorkspace, JwtAuthGuard, Roles, RolesGuard } from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { StyleCatalogueEntry } from "./styles.service.js";

/**
 * The style catalogue (07 §Styles).
 *
 * `GET /styles` is the one route: system styles (seeded from
 * `@montaj/caption-styles`) plus the caller's workspace presets, merged. There
 * is no `:id` in the path, so `WorkspaceMemberGuard` performs only its second
 * check — an active membership still exists — and the workspace comes from the
 * token's `ws` claim, never from a header (07 §Conventions).
 */
@ApiTags("styles")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`auth/not_a_member`." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("styles")
export class StylesController {
  constructor(private readonly styles: StylesService) {}

  @Get()
  @Roles("viewer")
  @ApiOperation({
    summary: "The style catalogue: system styles plus this workspace's presets",
    description:
      "Every entry is a full StyleDoc v2 document (the shape `StylePicker` " +
      "already reads), with `presetId`, `source` (`system`|`custom`) and " +
      "`previewKey` added. `previewKey` names a file the web app serves from " +
      "its own `/style-previews/`; it is `null` for a preset with no static " +
      "preview rendered yet.",
    operationId: "listStyles",
  })
  @ApiOkResponse(zodResponse(stylePageSchema, "System styles, then this workspace's own."))
  async list(@CurrentWorkspace() workspaceId: string): Promise<StyleCatalogueEntry[]> {
    return this.styles.list(workspaceId);
  }
}
