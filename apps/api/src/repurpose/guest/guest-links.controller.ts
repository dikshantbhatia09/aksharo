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
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";

import { GuestLinksService } from "./guest-links.service.js";
import { GUEST_RATE_LIMITS } from "./guest.constants.js";
import { CreateGuestLinkDto, createGuestLinkSchema } from "./guest.dto.js";
import { zodBody } from "../../auth/dto/openapi.js";
import {
  CurrentUser,
  CurrentWorkspace,
  JwtAuthGuard,
  RateLimit,
  RateLimitGuard,
  Roles,
  RolesGuard,
} from "../../common/guards/index.js";
import { WorkspaceMemberGuard } from "../../workspaces/workspace-member.guard.js";

import type { CreatedGuestLinkView, GuestLinkView } from "./guest.dto.js";
import type { AuthPrincipal } from "../../common/guards/index.js";

/**
 * Guest links, the team's routes (2026-10-05), beside `RepurposeController` on
 * the same `/repurpose/runs` prefix and the same guard chain; the workspace
 * comes from the token, never the path.
 *
 * Editors and up list, make and revoke them (`guest-links.service.ts` has the
 * reason: a guest link hands over files, never a decision). Viewers see none.
 * `WorkspaceMemberGuard` has refreshed the role from the database by the time a
 * handler runs, so a demotion bites on the next request.
 */
@ApiTags("repurpose")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("repurpose/runs")
export class GuestLinksController {
  constructor(private readonly links: GuestLinksService) {}

  @Get(":runId/guest-links")
  @Roles("editor")
  @ApiOperation({
    summary: "A run's guest links",
    description:
      "Each with its guest's name, the clips it shares, its visits and downloads. Never the " +
      "link itself: that is shown once, when it is made.",
    operationId: "listRepurposeGuestLinks",
  })
  async list(
    @CurrentWorkspace() workspaceId: string,
    @Param("runId") runId: string,
  ): Promise<{ readonly links: GuestLinkView[] }> {
    return { links: await this.links.listLinks(workspaceId, runId) };
  }

  @Post(":runId/guest-links")
  @Roles("editor")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @RateLimit(GUEST_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Share a run's clips with a guest, to download with no account",
    description:
      "Every clip (`allClips`, clips made later included) or the ones in `clipIds` (400 " +
      "`guest/clip_not_in_run` for one that is not the run's). `guestName` greets them on the " +
      "page; `includeDubs` adds the clips' dubbed versions; `expiresInDays` 1-30 (14). The " +
      "answer carries `url`, the only time the link is shown. 409 `guest/too_many_links` past " +
      "20 live links on one run; 404 while public links are off.",
    operationId: "createRepurposeGuestLink",
  })
  @ApiBody(zodBody(createGuestLinkSchema))
  async create(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser() principal: AuthPrincipal,
    @Param("runId") runId: string,
    @Body() body: CreateGuestLinkDto,
  ): Promise<CreatedGuestLinkView> {
    return this.links.createLink(workspaceId, principal, runId, body);
  }

  @Delete(":runId/guest-links/:linkId")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(GUEST_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Revoke a guest link",
    description: "It stops opening at once. Files already downloaded stay with the guest.",
    operationId: "revokeRepurposeGuestLink",
  })
  async revoke(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser() principal: AuthPrincipal,
    @Param("runId") runId: string,
    @Param("linkId") linkId: string,
  ): Promise<GuestLinkView> {
    return this.links.revokeLink(workspaceId, principal, runId, linkId);
  }
}
