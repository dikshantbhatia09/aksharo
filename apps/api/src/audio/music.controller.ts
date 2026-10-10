import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import {
  type ClipMusicSelectionResult,
  type MusicBrowseQueryDto,
  type MusicBrowseResponseDto,
  type MusicTrackDto,
  type SelectClipMusicDto,
  clipMusicSelectionResultSchema,
  musicBrowseResponseSchema,
  musicTrackDtoSchema,
  selectClipMusicSchema,
} from "./music.dto.js";
import { MusicService } from "./music.service.js";
import { zodBody, zodResponse } from "../auth/dto/openapi.js";
import { JwtAuthGuard, Roles, RolesGuard } from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

/**
 * Royalty-Free Background Music Library Controller (Pillar 5 §04).
 *
 * Provides endpoints for browsing, filtering, and previewing licensed music tracks
 * categorized by mood and tempo/BPM, plus attaching tracks to project clips with
 * volume attenuation.
 *
 * Catalog browsing and previewing are public so creators and offline editors can
 * freely preview CC0 audio tracks without workspace gating.
 */
@ApiTags("music")
@Controller()
export class MusicController {
  constructor(private readonly musicService: MusicService) {}

  @Get("api/v1/audio/music")
  @ApiOperation({
    summary: "Browse and filter royalty-free background music catalog",
    description: "Filters commercially cleared tracks by mood, tempo, BPM range, and text search.",
    operationId: "browseMusicV1",
  })
  @ApiOkResponse(zodResponse(musicBrowseResponseSchema, "Catalog of matching music tracks."))
  async browseV1(@Query() query: MusicBrowseQueryDto): Promise<MusicBrowseResponseDto> {
    return this.musicService.browse(query);
  }

  @Get("audio/music")
  @ApiOperation({
    summary: "Browse and filter royalty-free background music catalog",
    operationId: "browseMusic",
  })
  @ApiOkResponse(zodResponse(musicBrowseResponseSchema, "Catalog of matching music tracks."))
  async browse(@Query() query: MusicBrowseQueryDto): Promise<MusicBrowseResponseDto> {
    return this.musicService.browse(query);
  }

  @Get("api/v1/audio/music/recommendations")
  @ApiOperation({
    summary: "Get semantic music recommendations",
    description: "Recommends tracks based on virality diagnostics mood tag or sentiment.",
    operationId: "recommendMusicV1",
  })
  async recommendV1(@Query("mood") mood?: string): Promise<{ recommended: MusicTrackDto[] }> {
    const recommended = await this.musicService.getRecommendations(mood);
    return { recommended };
  }

  @Get("audio/music/recommendations")
  @ApiOperation({
    summary: "Get semantic music recommendations",
    operationId: "recommendMusic",
  })
  async recommend(@Query("mood") mood?: string): Promise<{ recommended: MusicTrackDto[] }> {
    const recommended = await this.musicService.getRecommendations(mood);
    return { recommended };
  }

  @Get("api/v1/audio/music/:id")
  @ApiOperation({
    summary: "Get single music track details with waveform data",
    operationId: "getMusicTrackV1",
  })
  @ApiOkResponse(zodResponse(musicTrackDtoSchema, "The music track details."))
  @ApiNotFoundResponse({ description: "Music track not found." })
  async getTrackV1(@Param("id") id: string): Promise<MusicTrackDto> {
    return this.musicService.getById(id);
  }

  @Get("audio/music/:id")
  @ApiOperation({
    summary: "Get single music track details with waveform data",
    operationId: "getMusicTrack",
  })
  @ApiOkResponse(zodResponse(musicTrackDtoSchema, "The music track details."))
  @ApiNotFoundResponse({ description: "Music track not found." })
  async getTrack(@Param("id") id: string): Promise<MusicTrackDto> {
    return this.musicService.getById(id);
  }

  @Patch("api/v1/projects/:projectId/clips/:clipId/music")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("editor")
  @ApiBearerAuth("access-token")
  @ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Set background music track and volume on a clip",
    description: "Attaches a background music track with custom volume level (0.0 to 1.0, default 0.15).",
    operationId: "selectClipMusicV1",
  })
  @ApiBody(zodBody(selectClipMusicSchema))
  @ApiOkResponse(zodResponse(clipMusicSelectionResultSchema, "Updated clip music configuration."))
  async selectClipMusicV1(
    @Param("clipId") clipId: string,
    @Body() body: SelectClipMusicDto,
  ): Promise<ClipMusicSelectionResult> {
    return this.musicService.selectClipMusic(clipId, body);
  }

  @Patch("projects/:projectId/clips/:clipId/music")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("editor")
  @ApiBearerAuth("access-token")
  @ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Set background music track and volume on a clip",
    operationId: "selectClipMusic",
  })
  @ApiBody(zodBody(selectClipMusicSchema))
  @ApiOkResponse(zodResponse(clipMusicSelectionResultSchema, "Updated clip music configuration."))
  async selectClipMusic(
    @Param("clipId") clipId: string,
    @Body() body: SelectClipMusicDto,
  ): Promise<ClipMusicSelectionResult> {
    return this.musicService.selectClipMusic(clipId, body);
  }
}

