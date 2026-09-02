import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";

import { SubtitleImportService } from "./import/subtitle-import.service.js";
import {
  completedUploadSchema,
  CompleteUploadDto,
  completeUploadSchema,
  ImportSubtitlesDto,
  importResultSchema,
  importSubtitlesSchema,
  ImportUrlDto,
  importUrlSchema,
  InitUploadDto,
  initUploadSchema,
  mediaSchema,
  mediaUrlsSchema,
  ReplaceMediaDto,
  replaceMediaSchema,
  uploadTicketSchema,
} from "./media.dto.js";
import { MediaService } from "./media.service.js";
import { zodArrayResponse, zodBody, zodResponse } from "../auth/dto/openapi.js";
import {
  CurrentWorkspace,
  JwtAuthGuard,
  RateLimit,
  RateLimitGuard,
  Roles,
  RolesGuard,
} from "../common/guards/index.js";
import { LogAccess } from "../privacy/access-log.decorator.js";
import { PROJECT_RATE_LIMITS } from "../projects/projects.constants.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { ImportResult } from "./import/subtitle-import.service.js";
import type { CompletedUpload, MediaUrls, MediaView, UploadTicket } from "./media.service.js";

/**
 * Media ingest, hung off the project it belongs to.
 *
 * The upload never passes through this process: `init` hands back presigned
 * multipart URLs the browser PUTs to directly, and `complete` closes the upload
 * and starts `media.probe` and `media.proxy`. That is why there is no
 * `@Post("upload")` here and why the body size limit in `main.ts` is irrelevant
 * to a 2 GB file.
 *
 * Guard stack and role ladder are the ones `ProjectsController` documents.
 */
@ApiTags("media")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`auth/not_a_member` or `common/forbidden`." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("projects/:projectId")
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly imports: SubtitleImportService,
  ) {}

  @Get("media")
  @Roles("viewer")
  @ApiOperation({
    summary: "The project's media, oldest first",
    description: "Includes imported subtitle sidecars, which carry the role `subtitle`.",
    operationId: "listProjectMedia",
  })
  @ApiOkResponse(zodArrayResponse(mediaSchema, "Every media asset in the project."))
  @ApiNotFoundResponse({ description: "`project/not_found`." })
  async list(
    @CurrentWorkspace() workspaceId: string,
    @Param("projectId") projectId: string,
  ): Promise<MediaView[]> {
    return this.media.list(workspaceId, projectId);
  }

  @Post("media/init")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(PROJECT_RATE_LIMITS.initUpload)
  @ApiOperation({
    summary: "Begin an upload",
    description:
      "Checks the declared size against the plan, opens a multipart upload on " +
      "the raw bucket and returns one presigned URL per 16 MiB part. PUT each " +
      "part, keep its `ETag`, then call `completeMediaUpload`. When " +
      "`contentHash` matches an upload this workspace already has, the existing " +
      "media is returned with `duplicate: true` and no parts to upload.",
    operationId: "initMediaUpload",
  })
  @ApiBody(zodBody(initUploadSchema))
  @ApiCreatedResponse(zodResponse(uploadTicketSchema, "Presigned parts, or a duplicate."))
  @ApiNotFoundResponse({ description: "`project/not_found`." })
  async init(
    @CurrentWorkspace() workspaceId: string,
    @Param("projectId") projectId: string,
    @Body() body: InitUploadDto,
  ): Promise<UploadTicket> {
    return this.media.initUpload(workspaceId, projectId, body);
  }

  @Post("media/:mediaId/complete")
  @Roles("editor")
  @ApiOperation({
    summary: "Finish an upload (project-scoped form)",
    description:
      "`completeMediaUpload` under the path `07-api-and-contracts.md` spells, " +
      "kept so a client can stay inside `/projects/{id}` for the whole ingest. " +
      "Slightly stricter than the unscoped form: the media must be in the " +
      "project the path names.",
    operationId: "completeProjectMediaUpload",
  })
  @ApiBody(zodBody(completeUploadSchema))
  @ApiCreatedResponse(zodResponse(completedUploadSchema, "The media and its two jobs."))
  async completeInProject(
    @CurrentWorkspace() workspaceId: string,
    @Param("projectId") projectId: string,
    @Param("mediaId") mediaId: string,
    @Body() body: CompleteUploadDto,
  ): Promise<CompletedUpload> {
    // The path names a project, so it is enforced: a media id from a *different*
    // project of the same workspace is a 404 here even though the unscoped route
    // would take it.
    return this.media.complete(workspaceId, mediaId, body.etags, projectId);
  }

  @Post("media/:mediaId/replace")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(PROJECT_RATE_LIMITS.initUpload)
  @ApiOperation({
    summary: "Replace a media item's bytes",
    description:
      "A fresh upload onto the SAME media row, so transcripts, the EDG document " +
      "and exports keep pointing at it. The row is flagged `needsRealign`: the " +
      "words survive, the timings do not.",
    operationId: "replaceMedia",
  })
  @ApiBody(zodBody(replaceMediaSchema))
  @ApiCreatedResponse(zodResponse(uploadTicketSchema, "Presigned parts for the new bytes."))
  @ApiNotFoundResponse({ description: "`media/not_found`." })
  async replace(
    @CurrentWorkspace() workspaceId: string,
    @Param("projectId") projectId: string,
    @Param("mediaId") mediaId: string,
    @Body() body: ReplaceMediaDto,
  ): Promise<UploadTicket> {
    return this.media.replace(workspaceId, projectId, mediaId, body);
  }

  @Get("media/:mediaId/urls")
  @Roles("viewer")
  @ApiOperation({
    summary: "Signed URLs for the derived objects",
    description:
      "Proxy, 16 kHz and 48 kHz audio, waveform and thumbnails, from the derived " +
      "bucket, valid five minutes. Only artefacts that exist are signed, so the " +
      "response doubles as `what is ready`.",
    operationId: "getMediaUrls",
  })
  @ApiOkResponse(zodResponse(mediaUrlsSchema, "Short-lived download URLs."))
  @ApiNotFoundResponse({ description: "`media/not_found`." })
  async urls(
    @CurrentWorkspace() workspaceId: string,
    @Param("projectId") projectId: string,
    @Param("mediaId") mediaId: string,
  ): Promise<MediaUrls> {
    return this.media.urls(workspaceId, projectId, mediaId);
  }

  @Post("import")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(PROJECT_RATE_LIMITS.import)
  @ApiOperation({
    summary: "Import an existing subtitle file",
    description:
      "Parses SRT, WebVTT, ASS or plain text into one normalised cue list, " +
      "stores it as a sidecar in the derived bucket and enqueues `ai.align`. " +
      "Plain text carries no timings, so `timed` is false and alignment supplies " +
      "them. At most 2 MB.",
    operationId: "importSubtitles",
  })
  @ApiBody(zodBody(importSubtitlesSchema))
  @ApiCreatedResponse(zodResponse(importResultSchema, "The stored cue list and its align job."))
  @ApiUnprocessableEntityResponse({ description: "`import/unparsable`." })
  async importSubtitles(
    @CurrentWorkspace() workspaceId: string,
    @Param("projectId") projectId: string,
    @Body() body: ImportSubtitlesDto,
  ): Promise<ImportResult> {
    return this.imports.importInline(workspaceId, projectId, body);
  }

  @Post("import-url")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(PROJECT_RATE_LIMITS.importUrl)
  @ApiOperation({
    summary: "Import a subtitle file from a URL",
    description:
      "The same import, fetched first through the egress-restricted client: " +
      "http(s) only, addresses resolved and judged before the connection, the " +
      "resolved address pinned, at most three redirects and 2 MB (THREAT-MODEL " +
      "T6). A refused URL is `import/blocked_url`, with no detail about why.",
    operationId: "importSubtitlesFromUrl",
  })
  @ApiBody(zodBody(importUrlSchema))
  @ApiCreatedResponse(zodResponse(importResultSchema, "The stored cue list and its align job."))
  @ApiUnprocessableEntityResponse({ description: "`import/unparsable`." })
  async importFromUrl(
    @CurrentWorkspace() workspaceId: string,
    @Param("projectId") projectId: string,
    @Body() body: ImportUrlDto,
  ): Promise<ImportResult> {
    return this.imports.importFromUrl(workspaceId, projectId, body);
  }
}

/**
 * `POST /media/{mediaId}/complete` — the brief's own spelling of completion.
 *
 * A separate controller because the path is not under `/projects`: a media id is
 * globally unique, and the browser that has just PUT twenty parts should not have
 * to remember which project it started in. Ownership is still proved the same
 * way — the lookup joins through `projects.workspace_id`, so another tenant's
 * media id is a 404 (THREAT-MODEL T5).
 */
@ApiTags("media")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`auth/not_a_member` or `common/forbidden`." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("media")
export class MediaUploadsController {
  constructor(private readonly media: MediaService) {}

  @Get(":mediaId")
  @Roles("viewer")
  @LogAccess("media")
  @ApiOperation({ summary: "Fetch one media asset", operationId: "getMedia" })
  @ApiOkResponse(zodResponse(mediaSchema, "The media asset."))
  @ApiNotFoundResponse({ description: "`media/not_found`." })
  async get(
    @CurrentWorkspace() workspaceId: string,
    @Param("mediaId") mediaId: string,
  ): Promise<MediaView> {
    return this.media.get(workspaceId, mediaId);
  }

  @Post(":mediaId/complete")
  @Roles("editor")
  @ApiOperation({
    summary: "Finish an upload and start the pipeline",
    description:
      "Completes the multipart upload from the part `ETag`s **in part order**, " +
      "records the store's own byte count, sets `rawPurgeAt` (upload + 7 days) " +
      "and `derivedPurgeAt` (the plan's retention), then enqueues `media.probe` " +
      "and `media.proxy`. Idempotent: a retry returns the same two job ids.",
    operationId: "completeMediaUpload",
  })
  @ApiBody(zodBody(completeUploadSchema))
  @ApiCreatedResponse(zodResponse(completedUploadSchema, "The media and its two jobs."))
  @ApiNotFoundResponse({ description: "`media/not_found`." })
  async complete(
    @CurrentWorkspace() workspaceId: string,
    @Param("mediaId") mediaId: string,
    @Body() body: CompleteUploadDto,
  ): Promise<CompletedUpload> {
    return this.media.complete(workspaceId, mediaId, body.etags);
  }
}
