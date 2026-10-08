import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { AppException, DERIVED_STORE, ERROR_CODES, PrismaService, RAW_STORE } from "../common/index.js";
import { extensionOf, rawKey } from "../common/storage/index.js";
import { JobsService } from "../jobs/jobs.service.js";
import { MEDIA_JOB_KEYS, MEDIA_JOB_QUOTES } from "../media/media.constants.js";
import { probeJobPayload } from "../media/probe-restart.js";
import { ProjectsService } from "../projects/projects.service.js";
import { CloudIntegrationService } from "./cloud-integration.service.js";
import {
  getDropboxStream,
  getGoogleDriveStream,
  uploadStreamToS3,
} from "./cloud-stream-client.js";

import type { ObjectStore } from "../common/index.js";
import type { ImportCloudDto, CloudImportJobResponseDto } from "./integrations.dto.js";

@Injectable()
export class CloudImportService {
  private readonly logger = new Logger(CloudImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: CloudIntegrationService,
    private readonly projects: ProjectsService,
    private readonly jobs: JobsService,
    @Inject(RAW_STORE) private readonly rawStore: ObjectStore,
    @Inject(DERIVED_STORE) private readonly derivedStore: ObjectStore,
  ) {}

  /**
   * Import media directly from Google Drive, Dropbox, Box, or OneDrive.
   * Creates a CloudImportJob and begins zero-disk server-to-server streaming to S3.
   */
  async importFromCloud(
    workspaceId: string,
    input: ImportCloudDto,
  ): Promise<CloudImportJobResponseDto> {
    const provider = input.provider.toUpperCase();

    // 1. Resolve token if not directly supplied in payload
    let token = input.token;
    if (!token && !input.directLink) {
      const integration = await this.integrations.getDecryptedToken(workspaceId, provider);
      if (!integration?.accessToken) {
        throw new AppException(
          "integrations/token_required",
          `integrations/token_required: No active OAuth connection or token found for ${provider}. Please authenticate first.`,
          HttpStatus.UNAUTHORIZED,
        );
      }
      token = integration.accessToken;
    }

    // 2. Resolve or create project
    let projectId = input.projectId;
    let projectTitle = input.fileName || `Cloud Import - ${provider}`;
    if (projectId) {
      const existing = await this.prisma.project.findFirst({
        where: { id: projectId, workspaceId },
      });
      if (!existing) {
        throw new AppException(
          ERROR_CODES.notFound,
          "The target project does not exist in this workspace",
          HttpStatus.NOT_FOUND,
        );
      }
      projectTitle = existing.title;
    } else {
      const newProj = await this.prisma.project.create({
        data: {
          id: ulid(),
          workspaceId,
          title: projectTitle,
          status: "draft",
        },
      });
      projectId = newProj.id;
    }

    // 3. Create MediaAsset row
    const mediaId = ulid();
    const fileName = input.fileName || `cloud-${provider.toLowerCase()}-${Date.now()}.mp4`;
    const ext = extensionOf(fileName) || ".mp4";
    const storageKey = rawKey(workspaceId, projectId, mediaId, ext);

    await this.prisma.mediaAsset.create({
      data: {
        id: mediaId,
        projectId,
        role: "primary",
        bucket: "s3",
        storageKey,
        filename: fileName,
        mime: input.mimeType || "video/mp4",
        sizeBytes: BigInt(input.fileSizeBytes || 0),
        status: "uploading",
      },
    });

    // 4. Create CloudImportJob
    const job = await this.prisma.cloudImportJob.create({
      data: {
        workspaceId,
        projectId,
        provider,
        fileId: input.fileId,
        fileName,
        fileSizeBytes: BigInt(input.fileSizeBytes || 0),
        status: "QUEUED",
        progressPct: 0,
        s3Key: storageKey,
        sourceUrl: input.directLink || null,
      },
    });

    // 5. Kick off zero-disk streaming in background
    this.streamCloudFileToS3({
      jobId: job.id,
      workspaceId,
      projectId,
      mediaId,
      storageKey,
      provider,
      fileId: input.fileId,
      token,
      directLink: input.directLink,
      fileName,
      fileSizeBytes: input.fileSizeBytes,
      mimeType: input.mimeType,
    }).catch((err) => {
      this.logger.error(`Cloud stream failed for job ${job.id}: ${err.message}`, err.stack);
    });

    return {
      jobId: job.id,
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      provider: job.provider,
      fileId: job.fileId,
      fileName: job.fileName,
      fileSizeBytes: job.fileSizeBytes.toString(),
      status: "QUEUED" as const,
      progressPct: 0,
      s3Key: job.s3Key,
      mediaId,
      createdAt: job.createdAt.toISOString(),
      completedAt: null,
    };
  }

  /**
   * Get the status and progress of a cloud import job.
   */
  async getImportJob(workspaceId: string, jobId: string): Promise<CloudImportJobResponseDto> {
    const job = await this.prisma.cloudImportJob.findFirst({
      where: { id: jobId, workspaceId },
    });

    if (!job) {
      throw new AppException(
        ERROR_CODES.notFound,
        `Cloud import job ${jobId} not found`,
        HttpStatus.NOT_FOUND,
      );
    }

    // Find associated mediaId if any
    const media = job.projectId
      ? await this.prisma.mediaAsset.findFirst({
          where: { projectId: job.projectId, storageKey: job.s3Key || "" },
        })
      : null;

    return {
      jobId: job.id,
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      provider: job.provider,
      fileId: job.fileId,
      fileName: job.fileName,
      fileSizeBytes: job.fileSizeBytes.toString(),
      status: job.status as "QUEUED" | "STREAMING" | "COMPLETED" | "FAILED",
      progressPct: job.progressPct,
      errorMessage: job.errorMessage,
      s3Key: job.s3Key,
      mediaId: media?.id || null,
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt ? job.completedAt.toISOString() : null,
    };
  }

  /**
   * Execute the streaming pipe directly from cloud provider -> S3 multipart with zero disk usage.
   */
  private async streamCloudFileToS3(params: {
    readonly jobId: string;
    readonly workspaceId: string;
    readonly projectId: string;
    readonly mediaId: string;
    readonly storageKey: string;
    readonly provider: string;
    readonly fileId: string;
    readonly token?: string;
    readonly directLink?: string;
    readonly fileName: string;
    readonly fileSizeBytes?: number;
    readonly mimeType?: string;
  }): Promise<void> {
    const {
      jobId,
      workspaceId,
      projectId,
      mediaId,
      storageKey,
      provider,
      fileId,
      token,
      directLink,
      fileSizeBytes,
      mimeType,
    } = params;

    try {
      await this.prisma.cloudImportJob.update({
        where: { id: jobId },
        data: { status: "STREAMING", progressPct: 5 },
      });

      let cloudStream;
      if (provider === "GOOGLE_DRIVE") {
        cloudStream = await getGoogleDriveStream({
          fileId,
          accessToken: token!,
        });
      } else if (provider === "DROPBOX") {
        cloudStream = await getDropboxStream({
          pathOrId: fileId,
          directLink,
          accessToken: token,
        });
      } else {
        throw new Error(`Unsupported cloud provider: ${provider}`);
      }

      const client = this.rawStore.getClient?.();
      if (!client) {
        throw new Error("S3Client not available on raw store for multipart upload");
      }

      let lastReportedPct = 5;
      const uploadResult = await uploadStreamToS3({
        client,
        bucket: this.rawStore.bucket,
        key: storageKey,
        stream: cloudStream.stream,
        contentType: mimeType || cloudStream.mimeType || "video/mp4",
        totalExpectedBytes: fileSizeBytes || cloudStream.fileSizeBytes,
        onProgress: async (p) => {
          const pct = Math.min(95, Math.max(5, Math.round(p.percentage * 0.9)));
          if (pct - lastReportedPct >= 5 || pct === 95) {
            lastReportedPct = pct;
            await this.prisma.cloudImportJob.update({
              where: { id: jobId },
              data: { progressPct: pct },
            }).catch(() => {});
          }
        },
      });

      const totalUploaded = BigInt(uploadResult.totalBytesUploaded || cloudStream.fileSizeBytes || 0);

      // 1. Update CloudImportJob to COMPLETED
      await this.prisma.cloudImportJob.update({
        where: { id: jobId },
        data: {
          status: "COMPLETED",
          progressPct: 100,
          fileSizeBytes: totalUploaded,
          completedAt: new Date(),
        },
      });

      // 2. Update MediaAsset to uploaded
      const updatedMedia = await this.prisma.mediaAsset.update({
        where: { id: mediaId },
        data: {
          status: "uploaded",
          sizeBytes: totalUploaded,
          uploadedAt: new Date(),
        },
      });

      // 3. Enqueue media.probe
      const project = await this.prisma.project.findUniqueOrThrow({
        where: { id: projectId },
      });

      await this.jobs.enqueue({
        type: "media.probe",
        workspaceId,
        projectId,
        params: probeJobPayload(updatedMedia, projectId, {
          raw: this.rawStore.kind,
          derived: this.derivedStore.kind,
        }),
        jobKey: MEDIA_JOB_KEYS.probe(mediaId),
        worstCaseTenths: MEDIA_JOB_QUOTES.probeTenths,
        reason: `media.probe · ${mediaId}`,
      });

      this.logger.log(`Cloud import job ${jobId} completed successfully for media ${mediaId}`);
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error streaming cloud import ${jobId}: ${errMessage}`);

      await this.prisma.cloudImportJob.update({
        where: { id: jobId },
        data: {
          status: "FAILED",
          errorMessage: errMessage,
          completedAt: new Date(),
        },
      }).catch(() => {});

      await this.prisma.mediaAsset.update({
        where: { id: mediaId },
        data: {
          status: "failed",
          failureReason: "media/corrupt",
        },
      }).catch(() => {});
    }
  }
}
