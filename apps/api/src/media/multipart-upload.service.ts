import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { MEDIA_JOB_KEYS, MEDIA_JOB_QUOTES } from "./media.constants.js";
import {
  assertAllowedType,
  extensionFor,
  normaliseMime,
} from "./media.service.js";
import {
  AbortMultipartUploadDto,
  CompleteMultipartUploadDto,
  InitiateMultipartUploadDto,
  RESUMABLE_CHUNK_SIZE_BYTES,
  SignPartUrlDto,
} from "./multipart-upload.dto.js";
import { probeJobPayload } from "./probe-restart.js";
import { AppException, ERROR_CODES, PrismaService } from "../common/index.js";
import {
  DERIVED_STORE,
  RAW_STORE,
  rawKey,
  type CompletedPart,
  type ObjectStore,
} from "../common/storage/index.js";
import { JobsService } from "../jobs/jobs.service.js";
import { derivedPurgeAt, mediaLimitsFor, rawPurgeAt } from "../projects/plan-limits.js";
import {
  MEDIA_ERRORS,
  RAW_OBJECT_TAGS,
} from "../projects/projects.constants.js";
import { ProjectsService } from "../projects/projects.service.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { MediaUploadSession } from "@prisma/client";

export interface InitiateUploadResult {
  readonly sessionId: string;
  readonly uploadId: string;
  readonly s3Key: string;
  readonly chunkSize: number;
  readonly totalParts: number;
  readonly initialPartUrl?: string;
}

export interface SignPartUrlResult {
  readonly partNumber: number;
  readonly url: string;
  readonly expiresInSeconds: number;
}

export interface CompleteUploadResult {
  readonly success: boolean;
  readonly mediaId: string;
  readonly status: string;
  readonly probeJobId: string;
}

@Injectable()
export class MultipartUploadService {
  private readonly logger = new Logger(MultipartUploadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly entitlements: EntitlementService,
    private readonly jobs: JobsService,
    @Inject(RAW_STORE) private readonly raw: ObjectStore,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
  ) {}

  /**
   * Initiate a client-to-storage multipart upload.
   *
   * SLA: Starts in <= 250ms because parts are signed on-demand rather than
   * up-front in a massive loop. Zero bytes proxy through the API gateway.
   */
  async initiateUpload(
    workspaceId: string,
    dto: InitiateMultipartUploadDto,
  ): Promise<InitiateUploadResult> {
    const mime = normaliseMime(dto.mimeType);
    assertAllowedType(mime, dto.fileName);

    const limits = mediaLimitsFor(await this.entitlements.forWorkspace(workspaceId));
    if (dto.fileSizeBytes > limits.maxFileBytes) {
      throw new AppException(
        ERROR_CODES.mediaTooLarge,
        `Your plan allows files up to ${Math.floor(limits.maxFileBytes / (1024 * 1024))} MB.`,
        HttpStatus.PAYLOAD_TOO_LARGE,
        { sizeBytes: dto.fileSizeBytes, maxFileBytes: limits.maxFileBytes, plan: limits.planKey },
      );
    }

    let targetProjectId = dto.projectId;
    if (targetProjectId) {
      await this.projects.requireProject(workspaceId, targetProjectId);
    } else {
      // Find or create default active project if none specified
      const latestProject = await this.prisma.project.findFirst({
        where: { workspaceId, deletedAt: null },
        orderBy: { createdAt: "desc" },
      });
      if (latestProject) {
        targetProjectId = latestProject.id;
      } else {
        const createdId = ulid();
        const created = await this.prisma.project.create({
          data: {
            id: createdId,
            workspaceId,
            title: dto.fileName.replace(/\.[^/.]+$/, ""),
            status: "draft",
          },
        });
        targetProjectId = created.id;
      }
    }

    const sessionId = ulid();
    const mediaId = ulid();
    const ext = extensionFor(dto.fileName, mime);
    const key = rawKey(workspaceId, targetProjectId, mediaId, ext);

    let uploadId: string;
    if (this.raw.initiateMultipartUpload) {
      const res = await this.raw.initiateMultipartUpload({
        key,
        contentType: mime,
        tags: RAW_OBJECT_TAGS,
      });
      uploadId = res.uploadId;
    } else {
      const res = await this.raw.createMultipartUpload({
        key,
        sizeBytes: dto.fileSizeBytes,
        contentType: mime,
        tags: RAW_OBJECT_TAGS,
      });
      uploadId = res.uploadId;
    }

    const totalParts = Math.max(1, Math.ceil(dto.fileSizeBytes / RESUMABLE_CHUNK_SIZE_BYTES));

    await this.prisma.mediaUploadSession.create({
      data: {
        id: sessionId,
        workspaceId,
        uploadId,
        s3Key: key,
        fileName: dto.fileName,
        fileSizeBytes: BigInt(dto.fileSizeBytes),
        mimeType: mime,
        chunkSizeBytes: RESUMABLE_CHUNK_SIZE_BYTES,
        totalParts,
        completedParts: 0,
        status: "UPLOADING",
      },
    });

    let initialPartUrl: string | undefined;
    if (this.raw.presignPartUpload) {
      initialPartUrl = await this.raw.presignPartUpload(key, uploadId, 1, 3600);
    }

    return {
      sessionId,
      uploadId,
      s3Key: key,
      chunkSize: RESUMABLE_CHUNK_SIZE_BYTES,
      totalParts,
      initialPartUrl,
    };
  }

  /**
   * Generates a signed PUT URL for a specific chunk.
   */
  async signPartUrl(
    workspaceId: string,
    dto: SignPartUrlDto,
  ): Promise<SignPartUrlResult> {
    const session = await this.prisma.mediaUploadSession.findFirst({
      where: {
        workspaceId,
        uploadId: dto.uploadId,
        s3Key: dto.s3Key,
      },
    });

    if (!session) {
      throw new AppException(
        MEDIA_ERRORS.notFound,
        "Upload session not found.",
        HttpStatus.NOT_FOUND,
        { uploadId: dto.uploadId },
      );
    }

    if (session.status !== "UPLOADING") {
      throw new AppException(
        MEDIA_ERRORS.invalidState,
        `Upload session is not active (status: ${session.status}).`,
        HttpStatus.CONFLICT,
        { uploadId: dto.uploadId, status: session.status },
      );
    }

    if (dto.partNumber < 1 || dto.partNumber > session.totalParts + 1) {
      throw new AppException(
        MEDIA_ERRORS.invalidState,
        `Part number ${dto.partNumber} is out of bounds for total parts ${session.totalParts}.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const expiresInSeconds = 3600;
    let url: string;
    if (this.raw.presignPartUpload) {
      url = await this.raw.presignPartUpload(dto.s3Key, dto.uploadId, dto.partNumber, expiresInSeconds);
    } else {
      url = await this.raw.presignPut(dto.s3Key, expiresInSeconds);
    }

    return {
      partNumber: dto.partNumber,
      url,
      expiresInSeconds,
    };
  }

  /**
   * Finalizes multipart upload and enqueues background processing.
   */
  async completeUpload(
    workspaceId: string,
    dto: CompleteMultipartUploadDto,
  ): Promise<CompleteUploadResult> {
    const session = await this.prisma.mediaUploadSession.findFirst({
      where: {
        workspaceId,
        uploadId: dto.uploadId,
        s3Key: dto.s3Key,
      },
    });

    if (!session) {
      throw new AppException(
        MEDIA_ERRORS.notFound,
        "Upload session not found.",
        HttpStatus.NOT_FOUND,
        { uploadId: dto.uploadId },
      );
    }

    const parts: CompletedPart[] = dto.parts.map((p) => ({
      partNumber: p.PartNumber,
      etag: p.ETag.startsWith('"') ? p.ETag : `"${p.ETag}"`,
    }));

    try {
      await this.raw.completeMultipartUpload(dto.s3Key, dto.uploadId, parts);
    } catch (error) {
      this.logger.error({ error, uploadId: dto.uploadId }, "Complete multipart upload failed");
      throw new AppException(
        MEDIA_ERRORS.uploadFailed,
        "Failed to complete multipart upload on storage.",
        HttpStatus.CONFLICT,
        { uploadId: dto.uploadId },
      );
    }

    await this.prisma.mediaUploadSession.update({
      where: { id: session.id },
      data: {
        status: "COMPLETED",
        completedParts: parts.length,
      },
    });

    const head = await this.raw.head(session.s3Key);
    const sizeBytes = head?.sizeBytes ?? Number(session.fileSizeBytes);

    const limits = mediaLimitsFor(await this.entitlements.forWorkspace(workspaceId));
    const uploadedAt = new Date();

    // Extract target project id from the key or use dto.projectId
    // Key format: ws/{wsId}/p/{projectId}/media/{mediaId}/raw.{ext}
    const keyParts = session.s3Key.split("/");
    const pIndex = keyParts.indexOf("p");
    const mIndex = keyParts.indexOf("media");
    const projectId =
      dto.projectId ??
      (pIndex !== -1 && keyParts[pIndex + 1] ? keyParts[pIndex + 1]! : "");
    const mediaId =
      mIndex !== -1 && keyParts[mIndex + 1] ? keyParts[mIndex + 1]! : ulid();

    const media = await this.prisma.mediaAsset.create({
      data: {
        id: mediaId,
        projectId,
        role: "primary",
        bucket: this.raw.kind,
        storageKey: session.s3Key,
        filename: session.fileName,
        mime: head?.contentType ?? session.mimeType,
        sizeBytes: BigInt(sizeBytes),
        status: "uploaded",
        uploadedAt,
        rawPurgeAt: rawPurgeAt(uploadedAt),
        derivedPurgeAt: derivedPurgeAt(uploadedAt, limits),
      },
    });

    if (projectId) {
      await this.prisma.project.update({
        where: { id: projectId },
        data: {
          lastActivityAt: uploadedAt,
          retentionUntil: derivedPurgeAt(uploadedAt, limits),
          status: "active",
        },
      });
    }

    await this.raw.tag(session.s3Key, RAW_OBJECT_TAGS).catch(() => undefined);

    const probe = await this.jobs.enqueue({
      type: "media.probe",
      workspaceId,
      projectId,
      params: probeJobPayload(media, projectId, {
        raw: this.raw.kind,
        derived: this.derived.kind,
      }),
      jobKey: MEDIA_JOB_KEYS.probe(media.id),
      worstCaseTenths: MEDIA_JOB_QUOTES.probeTenths,
      reason: `media.probe · ${media.id}`,
    });

    return {
      success: true,
      mediaId: media.id,
      status: "uploaded",
      probeJobId: probe.job.id,
    };
  }

  /**
   * Aborts an in-progress multipart upload and cleans up S3 parts.
   */
  async abortUpload(
    workspaceId: string,
    dto: AbortMultipartUploadDto,
  ): Promise<{ aborted: boolean }> {
    const session = await this.prisma.mediaUploadSession.findFirst({
      where: {
        workspaceId,
        uploadId: dto.uploadId,
        s3Key: dto.s3Key,
      },
    });

    if (session) {
      await this.prisma.mediaUploadSession.update({
        where: { id: session.id },
        data: { status: "ABORTED" },
      });
    }

    await this.raw.abortMultipartUpload(dto.s3Key, dto.uploadId);
    return { aborted: true };
  }

  /**
   * Fetch current session info for resume check.
   */
  async getSession(
    workspaceId: string,
    uploadId: string,
  ): Promise<MediaUploadSession | null> {
    return this.prisma.mediaUploadSession.findFirst({
      where: { workspaceId, uploadId },
    });
  }
}
