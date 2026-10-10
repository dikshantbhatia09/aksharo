import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { BROLL_RATE_LIMITS } from "./broll.constants.js";
import {
  BrollCompleteDto,
  brollCompleteSchema,
  brollDeletedSchema,
  brollItemViewSchema,
  brollLibraryViewSchema,
  BrollUpdateDto,
  brollUpdateSchema,
  BrollUploadDto,
  brollUploadSchema,
  brollUploadTicketSchema,
  StockSaveDto,
  stockSaveSchema,
  StockSearchDto,
  stockSearchViewSchema,
} from "./broll.dto.js";
import { BrollLibraryService } from "./broll.service.js";
import { StockProviderService, type StockVideoCandidate } from "./stock-provider.service.js";
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

import type {
  BrollItemView,
  BrollLibraryView,
  BrollUploadTicket,
  StockSearchView,
} from "./broll.dto.js";

/**
 * A workspace's B-roll library (2026-10-05): the pictures a B-roll cutaway
 * draws. The workspace comes from the token, never the path. Viewers read it;
 * editors change it. Every change is audited (`workspace.broll.*`); uploads,
 * stock searches and stock saves each have a per-user rate limit, and stock
 * photos only exist here when `PEXELS_API_KEY` is set (`stock.enabled`).
 */
@ApiTags("broll")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("broll")
export class BrollController {
  constructor(
    private readonly library: BrollLibraryService,
    private readonly stockProvider: StockProviderService,
    private readonly audit: CommonAuditService,
  ) {}

  @Get()
  @Roles("viewer")
  @ApiOperation({
    summary: "The workspace's B-roll library",
    description:
      "Every picture, newest first, each signed for an hour, and whether stock photos can be " +
      "searched here. Never 404: an empty library is an empty list.",
    operationId: "getBrollLibrary",
  })
  @ApiOkResponse(zodResponse(brollLibraryViewSchema, "The library."))
  async list(@CurrentWorkspace() workspaceId: string): Promise<BrollLibraryView> {
    return this.library.list(workspaceId);
  }

  @Post("uploads")
  @Roles("editor")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RateLimitGuard)
  @RateLimit(BROLL_RATE_LIMITS.upload)
  @ApiOperation({
    summary: "Start uploading a picture (PNG, JPEG or WebP, up to 8 MB)",
    description:
      "A presigned PUT; the browser uploads the bytes straight to storage with the same " +
      "`Content-Type`, then calls `complete`. 413 `broll/picture_too_large`, 409 " +
      "`broll/library_full`.",
    operationId: "createBrollUpload",
  })
  @ApiBody(zodBody(brollUploadSchema))
  @ApiOkResponse(zodResponse(brollUploadTicketSchema, "Where to PUT the picture."))
  async createUpload(
    @CurrentWorkspace() workspaceId: string,
    @Body() body: BrollUploadDto,
  ): Promise<BrollUploadTicket> {
    return this.library.createUpload(workspaceId, body);
  }

  @Post(":assetId/complete")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(BROLL_RATE_LIMITS.upload)
  @ApiOperation({
    summary: "Keep an uploaded picture in the library",
    description:
      "The bytes must open as the image type they were uploaded as, 320 to 3840 pixels a side; " +
      "otherwise they are deleted and refused (422 `broll/picture_invalid` or " +
      "`broll/picture_bad_size`). 409 `broll/picture_not_uploaded` before they arrive. " +
      "Idempotent.",
    operationId: "completeBrollUpload",
  })
  @ApiBody(zodBody(brollCompleteSchema))
  @ApiOkResponse(zodResponse(brollItemViewSchema, "The picture."))
  async complete(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("assetId") assetId: string,
    @Body() body: BrollCompleteDto,
  ): Promise<BrollItemView> {
    const { item, created } = await this.library.complete(workspaceId, userId, assetId, body);
    if (created) {
      await this.audit.record({
        action: "workspace.broll.picture_added",
        resource: "broll_asset",
        resourceId: item.assetId,
        actorId: userId,
        workspaceId,
        data: { source: "upload", tags: item.tags.length },
      });
    }
    return item;
  }

  @Patch(":assetId")
  @Roles("editor")
  @ApiOperation({
    summary: "Change a picture's tags or title",
    description:
      "Tags are what Autopilot matches a picture on; they are lower-cased and trimmed, at most " +
      "ten. 404 `broll/picture_not_found`.",
    operationId: "updateBrollPicture",
  })
  @ApiBody(zodBody(brollUpdateSchema))
  @ApiOkResponse(zodResponse(brollItemViewSchema, "The picture."))
  async update(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("assetId") assetId: string,
    @Body() body: BrollUpdateDto,
  ): Promise<BrollItemView> {
    const item = await this.library.update(workspaceId, assetId, body);
    await this.audit.record({
      action: "workspace.broll.picture_updated",
      resource: "broll_asset",
      resourceId: item.assetId,
      actorId: userId,
      workspaceId,
      data: { tags: item.tags.length },
    });
    return item;
  }

  @Delete(":assetId")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Delete a picture",
    description:
      "The picture is deleted for good. Clips that show it stop showing it; a captioned video " +
      "already made keeps it. Idempotent: `deleted: false` when there was no such picture.",
    operationId: "deleteBrollPicture",
  })
  @ApiOkResponse(zodResponse(brollDeletedSchema, "Whether a picture was deleted."))
  async remove(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("assetId") assetId: string,
  ): Promise<{ readonly deleted: boolean }> {
    const deleted = await this.library.remove(workspaceId, assetId);
    if (deleted) {
      await this.audit.record({
        action: "workspace.broll.picture_removed",
        resource: "broll_asset",
        resourceId: assetId,
        actorId: userId,
        workspaceId,
      });
    }
    return { deleted };
  }

  @Get("stock")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(BROLL_RATE_LIMITS.stockSearch)
  @ApiOperation({
    summary: "Search stock photos",
    description:
      "Photos from Pexels, when this deployment has a key (404 `broll/stock_disabled` " +
      "otherwise). 429 `broll/stock_busy` when the hour's searches are used up, 502 " +
      "`broll/stock_unavailable` when Pexels does not answer.",
    operationId: "searchBrollStock",
  })
  @ApiQuery({ name: "query", required: true, description: "What to look for, 2 to 80 characters." })
  @ApiQuery({ name: "orientation", required: false, enum: ["portrait", "landscape", "square"] })
  @ApiQuery({ name: "page", required: false, type: Number, description: "1 to 20; 1 by default." })
  @ApiOkResponse(zodResponse(stockSearchViewSchema, "One page of photos."))
  async searchStock(@Query() query: StockSearchDto): Promise<StockSearchView> {
    return this.library.searchStock(query);
  }

  @Post("stock")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RateLimitGuard)
  @RateLimit(BROLL_RATE_LIMITS.stockSave)
  @ApiOperation({
    summary: "Keep a stock photo in the library",
    description:
      "Reads the photo from Pexels by its id, at most 2560 pixels on its long side, and keeps " +
      "it with its photographer's credit. The same photo again answers the picture already " +
      "kept. Refusals as for a search, and 404 `broll/stock_not_found`, 409 " +
      "`broll/library_full`.",
    operationId: "saveBrollStock",
  })
  @ApiBody(zodBody(stockSaveSchema))
  @ApiOkResponse(zodResponse(brollItemViewSchema, "The picture."))
  async saveStock(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Body() body: StockSaveDto,
  ): Promise<BrollItemView> {
    const { item, created } = await this.library.saveStock(workspaceId, userId, body);
    if (created) {
      await this.audit.record({
        action: "workspace.broll.stock_saved",
        resource: "broll_asset",
        resourceId: item.assetId,
        actorId: userId,
        workspaceId,
        data: { provider: "pexels", photoId: body.photoId },
      });
    }
    return item;
  }

  @Get("stock/videos")
  @Roles("viewer")
  @ApiOperation({
    summary: "Search stock videos for B-roll insertion",
    description: "Returns vertical portrait stock videos matching query with >= 1080p resolution.",
    operationId: "searchBrollStockVideos",
  })
  async searchStockVideos(
    @Query("query") query: string,
    @Query("orientation") orientation?: "portrait" | "landscape" | "square",
    @Query("page") page?: number,
  ): Promise<StockVideoCandidate[]> {
    return this.stockProvider.searchVideos({
      query: query || "broll",
      orientation: orientation || "portrait",
      page: page ? Number(page) : 1,
    });
  }

  @Get("cues/:projectId")
  @Roles("viewer")
  @ApiOperation({
    summary: "Get B-roll cues for a project",
    description: "Returns all active B-roll cues ordered by startSec.",
    operationId: "getProjectBrollCues",
  })
  async getCues(@Param("projectId") projectId: string) {
    return this.stockProvider.getCues(projectId);
  }

  @Post("cues")
  @Roles("editor")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Create a B-roll cue for a project",
    operationId: "createProjectBrollCue",
  })
  async createCue(
    @Body()
    body: {
      projectId: string;
      startSec: number;
      endSec: number;
      query: string;
      stockVideoUri: string;
      sourceProvider?: string;
      status?: string;
    },
  ) {
    return this.stockProvider.createCue(body);
  }

  @Patch("cues/:cueId")
  @Roles("editor")
  @ApiOperation({
    summary: "Update or swap video for a B-roll cue",
    operationId: "updateProjectBrollCue",
  })
  async updateCue(
    @Param("cueId") cueId: string,
    @Body()
    body: {
      startSec?: number;
      endSec?: number;
      query?: string;
      stockVideoUri?: string;
      sourceProvider?: string;
      status?: string;
    },
  ) {
    return this.stockProvider.updateCue(cueId, body);
  }

  @Delete("cues/:cueId")
  @Roles("editor")
  @ApiOperation({
    summary: "Delete a B-roll cue",
    operationId: "deleteProjectBrollCue",
  })
  async deleteCue(@Param("cueId") cueId: string) {
    const deleted = await this.stockProvider.deleteCue(cueId);
    return { deleted };
  }
}
