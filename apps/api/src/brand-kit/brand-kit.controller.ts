import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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

import { BrandKitSettingsSchema } from "@montaj/edg";

import { BRAND_KIT_RATE_LIMITS } from "./brand-kit.constants.js";
import {
  brandKitViewSchema,
  LogoCompleteDto,
  logoCompleteSchema,
  LogoUploadDto,
  logoUploadSchema,
  logoUploadTicketSchema,
  UpdateBrandKitDto,
} from "./brand-kit.dto.js";
import { BrandKitService } from "./brand-kit.service.js";
import { zodBody, zodResponse } from "../auth/dto/openapi.js";
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

import type { BrandKitView, LogoUploadTicket } from "./brand-kit.dto.js";

/**
 * A workspace's brand kit (2026-10-02). The workspace comes from the token,
 * never the path. Viewers read it; editors change it. Every change is audited
 * (`workspace.brand_kit.*`); the logo routes share a per-user rate limit.
 */
@ApiTags("brand-kit")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("brand-kit")
export class BrandKitController {
  constructor(
    private readonly brandKits: BrandKitService,
    private readonly audit: CommonAuditService,
  ) {}

  @Get()
  @Roles("viewer")
  @ApiOperation({
    summary: "The workspace's brand kit",
    description:
      "Never 404: a workspace that has not saved one gets the defaults with `exists: false`, " +
      "and Autopilot adds nothing to its clips.",
    operationId: "getBrandKit",
  })
  @ApiOkResponse(zodResponse(brandKitViewSchema, "The kit, its logo, and the logos clips draw."))
  async get(@CurrentWorkspace() workspaceId: string): Promise<BrandKitView> {
    return this.brandKits.view(workspaceId);
  }

  @Put()
  @Roles("editor")
  @ApiOperation({
    summary: "Save the brand kit",
    description:
      "The whole kit. Clips already made keep their look; runs started with the kit on get it. " +
      "400 `brand_kit/font_unknown` for a typeface Aksharo does not bundle.",
    operationId: "updateBrandKit",
  })
  @ApiBody(zodBody(BrandKitSettingsSchema))
  @ApiOkResponse(zodResponse(brandKitViewSchema, "The saved kit."))
  async update(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Body() body: UpdateBrandKitDto,
  ): Promise<BrandKitView> {
    const view = await this.brandKits.update(workspaceId, body);
    await this.audit.record({
      action: "workspace.brand_kit.updated",
      resource: "brand_kit",
      actorId: userId,
      workspaceId,
    });
    return view;
  }

  @Post("logo")
  @Roles("editor")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @RateLimit(BRAND_KIT_RATE_LIMITS.logo)
  @ApiOperation({
    summary: "Start uploading a logo (PNG, JPEG or WebP, up to 2 MB)",
    description:
      "A presigned PUT; the browser uploads the bytes straight to storage with the same " +
      "`Content-Type`, then calls `complete`. 413 `brand_kit/logo_too_large`.",
    operationId: "createBrandKitLogoUpload",
  })
  @ApiBody(zodBody(logoUploadSchema))
  @ApiOkResponse(zodResponse(logoUploadTicketSchema, "Where to PUT the logo."))
  async createLogoUpload(
    @CurrentWorkspace() workspaceId: string,
    @Body() body: LogoUploadDto,
  ): Promise<LogoUploadTicket> {
    return this.brandKits.createLogoUpload(workspaceId, body);
  }

  @Post("logo/:assetId/complete")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(BRAND_KIT_RATE_LIMITS.logo)
  @ApiOperation({
    summary: "Make an uploaded logo the kit's",
    description:
      "The bytes must open as the image type they were uploaded as, at 16 to 4096 pixels a " +
      "side; otherwise they are deleted and refused (422 `brand_kit/logo_invalid` or " +
      "`brand_kit/logo_bad_size`). 409 `brand_kit/logo_not_uploaded` before they arrive. " +
      "Clips already made keep the logo they were made with.",
    operationId: "completeBrandKitLogo",
  })
  @ApiBody(zodBody(logoCompleteSchema))
  @ApiOkResponse(zodResponse(brandKitViewSchema, "The kit with its new logo."))
  async completeLogo(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("assetId") assetId: string,
    @Body() body: LogoCompleteDto,
  ): Promise<BrandKitView> {
    const { view, replaced } = await this.brandKits.completeLogo(
      workspaceId,
      userId,
      assetId,
      body,
    );
    await this.audit.record({
      action: "workspace.brand_kit.logo_set",
      resource: "brand_asset",
      resourceId: assetId,
      actorId: userId,
      workspaceId,
      data: { replaced },
    });
    return view;
  }

  @Delete("logo")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Take the logo off the brand kit",
    description:
      "New clips get no logo; clips that already carry it keep it until it is taken off them " +
      "in the editor. Idempotent.",
    operationId: "deleteBrandKitLogo",
  })
  @ApiOkResponse(zodResponse(brandKitViewSchema, "The kit without a logo."))
  async removeLogo(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
  ): Promise<BrandKitView> {
    const { view, removed } = await this.brandKits.removeLogo(workspaceId);
    if (removed !== null) {
      await this.audit.record({
        action: "workspace.brand_kit.logo_removed",
        resource: "brand_asset",
        resourceId: removed,
        actorId: userId,
        workspaceId,
      });
    }
    return view;
  }
}
