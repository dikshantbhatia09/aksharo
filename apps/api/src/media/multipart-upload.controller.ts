import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
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
} from "@nestjs/swagger";

import {
  AbortMultipartUploadDto,
  abortMultipartUploadSchema,
  CompleteMultipartUploadDto,
  completeMultipartUploadSchema,
  completeUploadResponseSchema,
  InitiateMultipartUploadDto,
  initiateMultipartUploadSchema,
  initiateUploadResponseSchema,
  SignPartUrlDto,
  signPartUrlResponseSchema,
  signPartUrlSchema,
} from "./multipart-upload.dto.js";
import {
  MultipartUploadService,
  type CompleteUploadResult,
  type InitiateUploadResult,
  type SignPartUrlResult,
} from "./multipart-upload.service.js";
import { zodBody, zodResponse } from "../auth/dto/openapi.js";
import {
  CurrentWorkspace,
  JwtAuthGuard,
  RateLimit,
  RateLimitGuard,
  Roles,
  RolesGuard,
} from "../common/guards/index.js";
import { PROJECT_RATE_LIMITS } from "../projects/projects.constants.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { MediaUploadSession } from "@prisma/client";

@ApiTags("media-upload")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "Not a member of this workspace or forbidden." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller(["api/v1/media/upload", "media/upload"])
export class MultipartUploadController {
  constructor(private readonly uploadService: MultipartUploadService) {}

  @Post("initiate")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(PROJECT_RATE_LIMITS.initUpload)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Initiate direct S3 multipart upload session",
    description:
      "Allocates S3 multipart upload ID and returns chunk configuration (16 MB) " +
      "and part 1 presigned URL with start latency <= 250ms.",
    operationId: "initiateMultipartUpload",
  })
  @ApiBody(zodBody(initiateMultipartUploadSchema))
  @ApiOkResponse(zodResponse(initiateUploadResponseSchema, "The upload session details."))
  async initiate(
    @CurrentWorkspace() workspaceId: string,
    @Body() body: InitiateMultipartUploadDto,
  ): Promise<InitiateUploadResult> {
    return this.uploadService.initiateUpload(workspaceId, body);
  }

  @Post("part-url")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Presign S3 chunk upload PUT URL on demand",
    description:
      "Dynamically signs chunk PUT URL on demand so URLs never expire for slow " +
      "or interrupted connections.",
    operationId: "signMultipartPartUrl",
  })
  @ApiBody(zodBody(signPartUrlSchema))
  @ApiOkResponse(zodResponse(signPartUrlResponseSchema, "The signed PUT URL."))
  async signPartUrl(
    @CurrentWorkspace() workspaceId: string,
    @Body() body: SignPartUrlDto,
  ): Promise<SignPartUrlResult> {
    return this.uploadService.signPartUrl(workspaceId, body);
  }

  @Post("complete")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Complete multipart upload and begin processing pipeline",
    description:
      "Verifies parts with storage, creates MediaAsset, and enqueues media.probe and media.proxy.",
    operationId: "completeMultipartUpload",
  })
  @ApiBody(zodBody(completeMultipartUploadSchema))
  @ApiOkResponse(zodResponse(completeUploadResponseSchema, "Upload completion status."))
  async complete(
    @CurrentWorkspace() workspaceId: string,
    @Body() body: CompleteMultipartUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.uploadService.completeUpload(workspaceId, body);
  }

  @Post("abort")
  @Roles("editor")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Abort multipart upload",
    description: "Cleans up orphaned chunk parts on S3 and cancels session.",
    operationId: "abortMultipartUpload",
  })
  @ApiBody(zodBody(abortMultipartUploadSchema))
  @ApiOkResponse({ description: "Upload successfully aborted." })
  async abort(
    @CurrentWorkspace() workspaceId: string,
    @Body() body: AbortMultipartUploadDto,
  ): Promise<{ aborted: boolean }> {
    return this.uploadService.abortUpload(workspaceId, body);
  }

  @Get("session/:uploadId")
  @Roles("viewer")
  @ApiOperation({
    summary: "Get current upload session progress",
    description: "Returns session metadata for resuming interrupted uploads.",
    operationId: "getUploadSession",
  })
  @ApiNotFoundResponse({ description: "Session not found." })
  async getSession(
    @CurrentWorkspace() workspaceId: string,
    @Param("uploadId") uploadId: string,
  ): Promise<MediaUploadSession | null> {
    return this.uploadService.getSession(workspaceId, uploadId);
  }
}

