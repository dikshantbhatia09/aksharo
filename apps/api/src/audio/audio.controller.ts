import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPaymentRequiredResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import {
  AudioCleanDto,
  AudioCleanListDto,
  CleanAcceptedDto,
  CleanListQueryDto,
  CleanRequestDto,
} from "./audio.dto.js";
import { AudioService } from "./audio.service.js";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "../common/guards/index.js";
import { RequiresEntitlement } from "../entitlements/requires-entitlement.guard.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { AuthPrincipal } from "../common/guards/index.js";

/**
 * The audio-clean surface: quote + start a run, list a project's clean history
 * (B10).
 *
 * `@Roles("editor")` on the producer for the same reason `transcribe` carries
 * it: starting a clean spends the workspace's credits. `@RequiresEntitlement
 * ("audioClean")` gates it on plan (creator+, `packages/config/src/credits.ts`)
 * ahead of the credit check, so a Starter workspace gets a clear "upgrade"
 * refusal rather than "insufficient credits". Reads are `@Roles("viewer")`.
 */
@ApiTags("audio")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiNotFoundResponse({ description: "`common/not_found`." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("projects/:projectId/audio")
export class AudioController {
  constructor(private readonly audio: AudioService) {}

  @Post("clean")
  @Roles("editor")
  @RequiresEntitlement("audioClean")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Clean the project's audio: denoise, normalise loudness",
    description:
      "Quotes the job from the probed media duration (1 credit a minute, rounded up to " +
      "0.1 of a minute, creator plan and above), holds the credits and enqueues `ai.clean`. " +
      "Watch `job.completed` on the project's realtime room, or poll `GET /jobs/{id}`, then " +
      "read `GET /projects/{id}/audio/cleans` for the signed URLs and metrics.",
    operationId: "cleanProjectAudio",
  })
  @ApiOkResponse({ type: CleanAcceptedDto, description: "Accepted and queued." })
  @ApiConflictResponse({ description: "`audio/media_not_ready`." })
  @ApiPaymentRequiredResponse({ description: "`credits/insufficient`." })
  async clean(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Body() body: CleanRequestDto,
  ): Promise<CleanAcceptedDto> {
    const result = await this.audio.requestClean({
      projectId,
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      strength: body.strength,
      target: body.target,
      ...(body.mediaId === undefined ? {} : { mediaId: body.mediaId }),
      ...(body.dereverb === undefined ? {} : { dereverb: body.dereverb }),
      ...(body.deesser === undefined ? {} : { deesser: body.deesser }),
    });
    return result;
  }

  @Get("cleans")
  @Roles("viewer")
  @ApiOperation({
    summary: "This project's audio-clean history",
    description:
      "Newest first, capped at 50. `cleanedAudioUrl`/`previewOriginalUrl`/`previewCleanedUrl` " +
      "are short-lived signed GET URLs, present once the run has succeeded.",
    operationId: "listProjectAudioCleans",
  })
  @ApiOkResponse({ type: AudioCleanListDto })
  async cleans(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Query() query: CleanListQueryDto,
  ): Promise<AudioCleanListDto> {
    const cleans = await this.audio.list({
      projectId,
      workspaceId: principal.workspaceId,
      ...(query.mediaId === undefined ? {} : { mediaId: query.mediaId }),
    });
    return { cleans: cleans as AudioCleanDto[] };
  }
}
