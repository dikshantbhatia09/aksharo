import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { AUDIO_ASSET_RATE_LIMITS } from "./audio-assets.constants.js";
import { packAssetUrlSchema } from "./audio-assets.dto.js";
import { AudioAssetsService } from "./audio-assets.service.js";
import { zodResponse } from "../auth/dto/openapi.js";
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

import type { PackAssetUrl } from "./audio-assets.dto.js";
import type { AuthPrincipal } from "../common/guards/index.js";

/**
 * `GET /audio-assets/{assetId}/url` (D04d) — no `:id` in the path (this is a
 * shared library, not a workspace-owned resource; `pack-keys.ts`'s open
 * question), so `WorkspaceMemberGuard` runs its "active membership still
 * exists" check alone, exactly as it already does on every `/projects/*`
 * route (its own doc comment). Read-only and rate-limited rather than
 * audited (`audio-assets.constants.ts`).
 */
@ApiTags("audio-assets")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`auth/not_a_member` or `audio-assets/not_allowed`." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("audio-assets")
export class AudioAssetsController {
  constructor(private readonly audioAssets: AudioAssetsService) {}

  @Get(":assetId/url")
  @Roles("viewer")
  @UseGuards(RateLimitGuard)
  @RateLimit(AUDIO_ASSET_RATE_LIMITS.url)
  @ApiOperation({
    summary: "A signed URL onto one pack asset's bytes",
    description:
      "Re-checks the licence predicate (surface/plan/territory/clearance/term) " +
      "against the caller's own token before signing — a ten-minute GET, for " +
      "the Passes-tab preview player and the browser export mixer's per-asset " +
      "cache.",
    operationId: "getAudioAssetUrl",
  })
  @ApiOkResponse(zodResponse(packAssetUrlSchema, "A short-lived download URL."))
  @ApiNotFoundResponse({ description: "`audio-assets/not_found`." })
  async url(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser() user: AuthPrincipal,
    @Param("assetId") assetId: string,
  ): Promise<PackAssetUrl> {
    return this.audioAssets.signedUrl(workspaceId, assetId, user.kind);
  }
}
