import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import {
  StockImportDto,
  StockSearchQueryDto,
  type StockImportResponse,
  type StockSearchResponse,
} from "./stock.dto.js";
import { StockService } from "./stock.service.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import {
  CurrentUser,
  CurrentWorkspace,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

/**
 * Integrated Stock Media Library Controller (Pillar 6 §02).
 * Exposes multi-provider search across Pexels, Pixabay, and Storyblocks,
 * and high-resolution asset edge caching in S3.
 */
@ApiTags("stock")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("stock")
export class StockController {
  constructor(
    private readonly stockService: StockService,
    private readonly audit: CommonAuditService,
  ) {}

  @Get("search")
  @Roles("viewer")
  @ApiOperation({
    summary: "Search royalty-free stock media assets",
    description:
      "Aggregates Pexels, Pixabay, and Storyblocks with orientation filtering (9:16 vertical prioritization) and Redis edge caching.",
    operationId: "searchStockAssets",
  })
  async search(@Query() query: StockSearchQueryDto): Promise<StockSearchResponse> {
    return this.stockService.search(query);
  }

  @Get("categories")
  @Roles("viewer")
  @ApiOperation({
    summary: "Get curated stock categories",
    description: "Returns standard creator categories for fast discovery filtering.",
    operationId: "getStockCategories",
  })
  async getCategories(): Promise<{ readonly categories: readonly string[] }> {
    return { categories: this.stockService.getCategories() };
  }

  @Post(["import", "download"])
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Import and edge-cache a stock asset to S3",
    description:
      "Downloads high-resolution MP4 (>= 1080p) to Aksharo's S3 bucket (s3://aksharo-stock-cache/{provider}/{assetId}.mp4) for offline rendering reliability.",
    operationId: "importStockAsset",
  })
  async importAsset(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Body() body: StockImportDto,
  ): Promise<StockImportResponse> {
    const result = await this.stockService.importOrCacheAsset(body);

    await this.audit.record({
      action: "workspace.stock.asset_cached",
      resource: "stock_asset",
      resourceId: body.assetId,
      actorId: userId,
      workspaceId,
      data: {
        provider: body.provider,
        cachedKey: result.cachedKey,
        sizeBytes: result.sizeBytes,
      },
    });

    return result;
  }
}
