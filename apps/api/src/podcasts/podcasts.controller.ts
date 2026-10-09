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
  ApiTags,
} from "@nestjs/swagger";

import {
  connectPodcastSchema,
  podcastShowViewSchema,
  repurposeEpisodeSchema,
  searchPodcastsQuerySchema,
  updatePodcastShowSchema,
  type ConnectPodcastDto,
  type PodcastEpisodeViewDto,
  type PodcastShowViewDto,
  type RepurposeEpisodeDto,
  type UpdatePodcastShowDto,
} from "./podcasts.dto.js";
import { PodcastsService } from "./podcasts.service.js";
import { zodBody, zodResponse } from "../auth/dto/openapi.js";
import {
  CurrentUser,
  CurrentWorkspace,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

/**
 * Controller for Podcast RSS Ingestion & Automated Episode Watcher (Pillar 1 §06).
 */
@ApiTags("podcasts")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("podcasts")
export class PodcastsController {
  constructor(private readonly podcasts: PodcastsService) {}

  @Post("connect")
  @Roles("editor")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Connect a podcast RSS feed",
    description: "Fetches and indexes all historical episodes into the catalog.",
    operationId: "connectPodcastShow",
  })
  @ApiBody(zodBody(connectPodcastSchema))
  @ApiOkResponse(zodResponse(podcastShowViewSchema, "Connected podcast show with episodes."))
  async connect(
    @CurrentWorkspace() workspaceId: string,
    @Body() body: ConnectPodcastDto,
  ): Promise<PodcastShowViewDto> {
    const validated = connectPodcastSchema.parse(body);
    return this.podcasts.connectShow(workspaceId, validated);
  }

  @Get("search")
  @Roles("viewer")
  @ApiOperation({
    summary: "Search iTunes directory for podcasts",
    description: "Search Apple Podcasts to find show title, artwork, and RSS feed URL.",
    operationId: "searchPodcastsDirectory",
  })
  async search(@Query("q") query: string, @Query("limit") limit?: string) {
    const validated = searchPodcastsQuerySchema.parse({ q: query, limit });
    return this.podcasts.searchPodcasts(validated.q, validated.limit);
  }

  @Get()
  @Roles("viewer")
  @ApiOperation({
    summary: "List connected podcasts in workspace",
    operationId: "listPodcastShows",
  })
  async list(@CurrentWorkspace() workspaceId: string): Promise<PodcastShowViewDto[]> {
    return this.podcasts.listShows(workspaceId);
  }

  @Get(":showId")
  @Roles("viewer")
  @ApiOperation({
    summary: "Get podcast show details and complete episode catalog",
    operationId: "getPodcastShow",
  })
  async get(
    @CurrentWorkspace() workspaceId: string,
    @Param("showId") showId: string,
  ): Promise<PodcastShowViewDto> {
    return this.podcasts.getShow(workspaceId, showId);
  }

  @Patch(":showId")
  @Roles("editor")
  @ApiOperation({
    summary: "Update podcast show settings",
    description: "Toggle autoRepurpose on or off.",
    operationId: "updatePodcastShow",
  })
  @ApiBody(zodBody(updatePodcastShowSchema))
  async update(
    @CurrentWorkspace() workspaceId: string,
    @Param("showId") showId: string,
    @Body() body: UpdatePodcastShowDto,
  ): Promise<PodcastShowViewDto> {
    const validated = updatePodcastShowSchema.parse(body);
    return this.podcasts.updateShow(workspaceId, showId, validated);
  }

  @Delete(":showId")
  @Roles("editor")
  @ApiOperation({
    summary: "Disconnect and remove a podcast show",
    operationId: "deletePodcastShow",
  })
  async delete(
    @CurrentWorkspace() workspaceId: string,
    @Param("showId") showId: string,
  ): Promise<{ deleted: boolean }> {
    return this.podcasts.deleteShow(workspaceId, showId);
  }

  @Post(":showId/sync")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Sync RSS feed for new episodes",
    description: "Performs conditional GET with ETag / If-Modified-Since to discover new releases.",
    operationId: "syncPodcastFeed",
  })
  async sync(
    @CurrentWorkspace() workspaceId: string,
    @Param("showId") showId: string,
  ): Promise<{ updated: boolean; newEpisodes: number; episodes: PodcastEpisodeViewDto[] }> {
    // Assert show belongs to workspace first
    await this.podcasts.getShow(workspaceId, showId);
    return this.podcasts.syncFeed(showId);
  }

  @Post("episodes/:episodeId/repurpose")
  @Roles("editor")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "1-Click Repurpose for an episode",
    description: "Converts a podcast episode into video shorts with chapters seeded from show notes.",
    operationId: "repurposePodcastEpisode",
  })
  async repurpose(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("episodeId") episodeId: string,
    @Body() body?: RepurposeEpisodeDto,
  ): Promise<{ projectId: string; episodeId: string; status: string }> {
    const validated = body ? repurposeEpisodeSchema.parse(body) : undefined;
    return this.podcasts.repurposeEpisode(workspaceId, userId, episodeId, validated);
  }
}
