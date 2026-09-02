import { Body, Controller, Delete, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from "@nestjs/common";
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

import { STYLE_RATE_LIMITS } from "./styles.constants.js";
import {
  CreateStylePresetDto,
  createStylePresetSchema,
  styleCatalogueEntrySchema,
  UpdateStylePresetDto,
  updateStylePresetSchema,
} from "./styles.dto.js";
import { StylesService } from "./styles.service.js";
import { zodBody, zodResponse } from "../auth/dto/openapi.js";
import {
  JwtAuthGuard,
  RateLimit,
  RateLimitGuard,
  Roles,
  RolesGuard,
} from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { StyleCatalogueEntry } from "./styles.service.js";

/**
 * A workspace's custom style presets (07 §Styles, D64).
 *
 * Nested under `/workspaces/{id}` like the rest of that resource's sub-routes,
 * so it wears the exact guard stack `WorkspacesController` documents and
 * `test/workspace-guard.e2e-spec.ts` enumerates: every `:id` route here is
 * covered by that suite automatically, with no separate list to keep in sync.
 */
@ApiTags("styles")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`auth/not_a_member` or `common/forbidden`." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("workspaces/:id/style-presets")
export class StylePresetsController {
  constructor(private readonly styles: StylesService) {}

  @Post()
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(STYLE_RATE_LIMITS.writePreset)
  @ApiOperation({
    summary: "Save a custom style preset",
    description:
      "`doc` is validated by StyleDoc v2, including the D64 naming rule — a " +
      "name or id that reads as a person, creator or brand fails validation. " +
      "`doc.id` becomes the preset's key and cannot shadow a system style's.",
    operationId: "createStylePreset",
  })
  @ApiBody(zodBody(createStylePresetSchema))
  @ApiCreatedResponse(zodResponse(styleCatalogueEntrySchema, "The new preset."))
  @ApiConflictResponse({ description: "`style/reserved_key` or `style/key_taken`." })
  async create(
    @Param("id") workspaceId: string,
    @Body() body: CreateStylePresetDto,
  ): Promise<StyleCatalogueEntry> {
    return this.styles.createPreset(workspaceId, body.doc);
  }

  @Patch(":presetId")
  @Roles("editor")
  @ApiOperation({
    summary: "Update a custom style preset",
    description: "The preset's id (`doc.id`) cannot change; save a new preset instead.",
    operationId: "updateStylePreset",
  })
  @ApiBody(zodBody(updateStylePresetSchema))
  @ApiOkResponse(zodResponse(styleCatalogueEntrySchema, "The updated preset."))
  @ApiNotFoundResponse({ description: "`style/not_found`." })
  @ApiConflictResponse({ description: "`style/key_immutable`." })
  async update(
    @Param("id") workspaceId: string,
    @Param("presetId") presetId: string,
    @Body() body: UpdateStylePresetDto,
  ): Promise<StyleCatalogueEntry> {
    return this.styles.updatePreset(workspaceId, presetId, body.doc);
  }

  @Delete(":presetId")
  @Roles("admin")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete a custom style preset", operationId: "deleteStylePreset" })
  @ApiOkResponse({ schema: { type: "object", properties: { id: { type: "string" } } } })
  @ApiNotFoundResponse({ description: "`style/not_found`." })
  async remove(
    @Param("id") workspaceId: string,
    @Param("presetId") presetId: string,
  ): Promise<{ id: string }> {
    return this.styles.deletePreset(workspaceId, presetId);
  }
}
