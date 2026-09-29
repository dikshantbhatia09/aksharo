import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { RepurposeService } from "./repurpose.service.js";
import { zodBody, zodResponse } from "../auth/dto/openapi.js";
import { BRAND_KIT_RATE_LIMITS } from "../brand-kit/brand-kit.constants.js";
import {
  CoverCompleteDto,
  CoverUploadDto,
  coverViewSchema,
  logoCompleteSchema,
  logoUploadSchema,
  logoUploadTicketSchema,
} from "../brand-kit/brand-kit.dto.js";
import { BrandKitService } from "../brand-kit/brand-kit.service.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
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

import type { CoverView, LogoUploadTicket } from "../brand-kit/brand-kit.dto.js";

/**
 * A run's cover image (2026-10-04, audiograms): the artwork its clips are drawn
 * with when the source has no picture of its own. The start form uploads it
 * before it starts the run - a signed PUT straight to storage, then `complete`,
 * which checks the bytes - and sends the asset id as
 * `setup.audiogram.coverAssetId`, which `POST /repurpose/runs` checks is this
 * workspace's.
 *
 * The same guard chain as the runs, `editor` to upload, the clips surface's
 * flag (404 while it is off), a per-user rate limit, and every kept cover
 * audited. The bytes are checked by the brand kit's image rules, with a
 * cover's own limits (`COVER_MAX_BYTES`).
 */
@ApiTags("repurpose")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("repurpose/covers")
export class RepurposeCoversController {
  constructor(
    private readonly repurpose: RepurposeService,
    private readonly brandKits: BrandKitService,
    private readonly audit: CommonAuditService,
  ) {}

  @Post()
  @Roles("editor")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @RateLimit(BRAND_KIT_RATE_LIMITS.cover)
  @ApiOperation({
    summary: "Start uploading a run's cover (PNG, JPEG or WebP, up to 10 MB)",
    description:
      "For a run started from an audio file: its clips are drawn with this as their artwork. " +
      "A presigned PUT; upload the bytes with the same `Content-Type`, then call `complete`. " +
      "413 `repurpose/cover_too_large`.",
    operationId: "createRepurposeCoverUpload",
  })
  @ApiBody(zodBody(logoUploadSchema))
  @ApiOkResponse(zodResponse(logoUploadTicketSchema, "Where to PUT the cover."))
  async createUpload(
    @CurrentWorkspace() workspaceId: string,
    @Body() body: CoverUploadDto,
  ): Promise<LogoUploadTicket> {
    await this.repurpose.assertAvailable(workspaceId);
    return this.brandKits.createCoverUpload(workspaceId, body);
  }

  @Post(":assetId/complete")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(BRAND_KIT_RATE_LIMITS.cover)
  @ApiOperation({
    summary: "Keep an uploaded cover",
    description:
      "The bytes must open as the image type they were uploaded as, at 64 to 4096 pixels a " +
      "side; otherwise they are deleted and refused (422 `repurpose/cover_invalid` or " +
      "`repurpose/cover_bad_size`). 409 `repurpose/cover_not_uploaded` before they arrive. " +
      "Idempotent.",
    operationId: "completeRepurposeCover",
  })
  @ApiBody(zodBody(logoCompleteSchema))
  @ApiOkResponse(zodResponse(coverViewSchema, "The cover, to start the run with."))
  async complete(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("assetId") assetId: string,
    @Body() body: CoverCompleteDto,
  ): Promise<CoverView> {
    await this.repurpose.assertAvailable(workspaceId);
    const view = await this.brandKits.completeCover(workspaceId, userId, assetId, body);
    await this.audit.record({
      action: "repurpose.cover.uploaded",
      resource: "brand_asset",
      resourceId: view.assetId,
      actorId: userId,
      workspaceId,
      data: { width: view.width, height: view.height, sizeBytes: view.sizeBytes },
    });
    return view;
  }
}
