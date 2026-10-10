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
  StickerCacheDto,
  StickerRecommendDto,
  StickerSearchQueryDto,
  StickerTrendingQueryDto,
  type StickerCacheResponse,
  type StickerRecommendResponse,
  type StickerSearchResponse,
} from "./stickers.dto.js";
import { StickersService } from "./stickers.service.js";
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
 * Sticker, Meme & Reaction GIF Overlay Engine Controller (Pillar 6 §04).
 * Exposes multi-provider search across Giphy and Tenor,
 * AI sentiment reaction meme recommendations, and S3 edge caching.
 */
@ApiTags("stickers")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("stickers")
export class StickersController {
  constructor(
    private readonly stickersService: StickersService,
    private readonly audit: CommonAuditService,
  ) {}

  @Get("search")
  @Roles("viewer")
  @ApiOperation({
    summary: "Search stickers, GIFs, and reaction memes",
    description:
      "Queries Giphy and Tenor APIs with alpha-transparency filtering and Redis edge caching (<= 450ms SLA).",
    operationId: "searchStickers",
  })
  async search(@Query() query: StickerSearchQueryDto): Promise<StickerSearchResponse> {
    return this.stickersService.search(query);
  }

  @Get("trending")
  @Roles("viewer")
  @ApiOperation({
    summary: "Get trending reaction GIFs and stickers",
    description: "Returns viral trending reaction memes and animated vector stickers for quick discovery.",
    operationId: "getTrendingStickers",
  })
  async getTrending(@Query() query: StickerTrendingQueryDto): Promise<StickerSearchResponse> {
    return this.stickersService.getTrending(query);
  }

  @Get("categories")
  @Roles("viewer")
  @ApiOperation({
    summary: "Get sticker and meme categories",
    description: "Returns curated creator categories for fast discovery filtering (Shocked, Memes, Arrows, Laughing, etc.).",
    operationId: "getStickerCategories",
  })
  async getCategories(): Promise<{ readonly categories: readonly string[] }> {
    return { categories: this.stickersService.getCategories() };
  }

  @Post("recommend")
  @Roles("viewer")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Recommend contextual reaction memes for transcript",
    description:
      "Performs sentiment analysis over transcript text to propose 2-3 contextual reaction memes during humor peaks or dramatic punchlines.",
    operationId: "recommendReactionMemes",
  })
  async recommend(@Body() body: StickerRecommendDto): Promise<StickerRecommendResponse> {
    return this.stickersService.recommendReactionMemes(body);
  }

  @Post(["cache", "import"])
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Edge-cache a sticker or meme asset to S3",
    description:
      "Downloads and edge-caches sticker or GIF asset to Aksharo S3 for offline reliability and Remotion alpha rendering.",
    operationId: "cacheStickerAsset",
  })
  async cacheAsset(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Body() body: StickerCacheDto,
  ): Promise<StickerCacheResponse> {
    const result = await this.stickersService.cacheStickerAsset(body);

    await this.audit.record({
      action: "workspace.sticker.asset_cached",
      resource: "sticker_asset",
      resourceId: body.assetId,
      actorId: userId,
      workspaceId,
      data: {
        provider: body.provider,
        cachedKey: result.cachedKey,
        isTransparent: result.isTransparent,
      },
    });

    return result;
  }
}
