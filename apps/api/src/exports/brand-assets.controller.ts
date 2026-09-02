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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { BrandAssetsService } from "./brand-assets.service.js";
import { BrandAssetCreateRequestDto, BrandAssetDto, BrandAssetUploadDto } from "./exports.dto.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { AuthPrincipal } from "../common/guards/index.js";
import type { BrandAsset } from "@prisma/client";

/**
 * A workspace's watermark/logo images (`ws/{workspaceId}/brand/{assetId}.png`,
 * CONTRACTS §6). `ExportsService` reads these when a request names one as
 * `options.brandAssetId`; the Free-tier anti-piracy mark is a separate, bundled
 * asset and is never one of these rows.
 */
@ApiTags("exports")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("workspaces/:id/brand-assets")
export class BrandAssetsController {
  constructor(
    private readonly brandAssets: BrandAssetsService,
    private readonly audit: CommonAuditService,
  ) {}

  @Post()
  @Roles("editor")
  @ApiOperation({
    summary: "Start uploading a brand asset (watermark or logo PNG)",
    description: "Returns a presigned PUT URL; the browser uploads the bytes directly to R2.",
    operationId: "createBrandAsset",
  })
  @ApiOkResponse({ type: BrandAssetUploadDto })
  async create(
    @CurrentUser() principal: AuthPrincipal,
    @Param("id") workspaceId: string,
    @Body() body: BrandAssetCreateRequestDto,
  ): Promise<BrandAssetUploadDto> {
    const result = await this.brandAssets.create(workspaceId, principal.userId, {
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
    });
    return { id: result.asset.id, uploadUrl: result.uploadUrl, expiresAt: result.expiresAt };
  }

  @Get()
  @Roles("viewer")
  @ApiOperation({ summary: "List a workspace's brand assets", operationId: "listBrandAssets" })
  @ApiOkResponse({ type: [BrandAssetDto] })
  async list(@Param("id") workspaceId: string): Promise<BrandAssetDto[]> {
    const assets = await this.brandAssets.list(workspaceId);
    return assets.map(toDto);
  }

  @Delete(":assetId")
  @Roles("editor")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete a brand asset", operationId: "deleteBrandAsset" })
  @ApiNotFoundResponse({ description: "`export/brand_asset_not_found`." })
  async delete(
    @CurrentUser() principal: AuthPrincipal,
    @Param("id") workspaceId: string,
    @Param("assetId") assetId: string,
  ): Promise<void> {
    await this.brandAssets.delete(workspaceId, assetId);
    await this.audit.record({
      action: "workspace.brand_asset.deleted",
      resource: "brand_asset",
      resourceId: assetId,
      actorId: principal.userId,
      workspaceId,
    });
  }
}

function toDto(asset: BrandAsset): BrandAssetDto {
  return {
    id: asset.id,
    kind: asset.kind,
    contentType: asset.contentType,
    sizeBytes: asset.sizeBytes,
    createdAt: asset.createdAt.toISOString(),
  };
}
