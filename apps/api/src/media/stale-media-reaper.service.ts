import { Inject, Injectable, Logger } from "@nestjs/common";

import { DEFAULT_STALE_MEDIA_THRESHOLD_MS } from "./media.constants.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { RAW_STORE, type ObjectStore } from "../common/storage/index.js";

import type { MediaStatus } from "@prisma/client";

export interface StaleMediaReaperOptions {
  /** Overridable timestamp for testing. Defaults to now. */
  readonly now?: Date;
  /** Milliseconds an asset can remain in non-terminal state before being reaped. */
  readonly thresholdMs?: number;
  /** Maximum number of records to process in a single sweep pass. */
  readonly limit?: number;
}

export interface StaleMediaReapReport {
  readonly checked: number;
  readonly reaped: number;
  readonly skippedActiveJobs: number;
  readonly abortedUploads: number;
  readonly reapedMediaIds: string[];
}

/** Non-terminal media statuses that can become stale. */
const NON_TERMINAL_STATUSES: MediaStatus[] = [
  "pending",
  "uploading",
  "uploaded",
  "probing",
];

/**
 * Scheduled reaper for stale media assets (CORE-016).
 *
 * Media assets stuck in non-terminal states (`pending`, `uploading`, `uploaded`, `probing`)
 * for longer than a policy threshold (default 24 hours) without any active (`queued` or
 * `running`) jobs are transitioned to terminal `failed` state with reason `media/stale_upload`.
 * Any open multipart upload is aborted, and an administrative audit record is created.
 *
 * Guardrails:
 * 1. Never touches `ready` assets or already terminal assets (`failed`, `purged`).
 * 2. Never touches an asset with any active job in `queued` or `running` status.
 * 3. Idempotent: safe to run repeatedly.
 */
@Injectable()
export class StaleMediaReaperService {
  private readonly logger = new Logger(StaleMediaReaperService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RAW_STORE) private readonly raw: ObjectStore,
    private readonly audit: CommonAuditService,
  ) {}

  async reapStaleMedia(options: StaleMediaReaperOptions = {}): Promise<StaleMediaReapReport> {
    const now = options.now ?? new Date();
    const thresholdMs = options.thresholdMs ?? DEFAULT_STALE_MEDIA_THRESHOLD_MS;
    const cutoff = new Date(now.getTime() - thresholdMs);
    const take = options.limit ?? 100;

    const candidates = await this.prisma.mediaAsset.findMany({
      where: {
        status: { in: NON_TERMINAL_STATUSES },
        createdAt: { lte: cutoff },
        OR: [
          { uploadedAt: null },
          { uploadedAt: { lte: cutoff } },
        ],
      },
      include: {
        project: { select: { workspaceId: true } },
      },
      orderBy: { createdAt: "asc" },
      take,
    });

    let skippedActiveJobs = 0;
    let abortedUploads = 0;
    const reapedMediaIds: string[] = [];

    for (const asset of candidates) {
      // Guardrail: Never touch an asset with a queued or running job
      const activeJob = await this.prisma.job.findFirst({
        where: {
          status: { in: ["queued", "running"] },
          OR: [
            { jobKey: { contains: asset.id } },
            { params: { path: ["mediaId"], equals: asset.id } },
          ],
        },
        select: { id: true },
      });

      if (activeJob !== null) {
        skippedActiveJobs += 1;
        continue;
      }

      const previousStatus = asset.status;
      const hadUploadId = asset.uploadId !== null && asset.uploadId.trim() !== "";

      // If there is an open multipart upload, abort it
      if (hadUploadId && asset.uploadId !== null) {
        try {
          await this.raw.abortMultipartUpload(asset.storageKey, asset.uploadId);
          abortedUploads += 1;
        } catch (error) {
          this.logger.warn(
            { mediaId: asset.id, uploadId: asset.uploadId, err: error },
            "failed to abort multipart upload for stale media asset",
          );
        }
      }

      // Move asset to terminal failed state
      await this.prisma.mediaAsset.update({
        where: { id: asset.id },
        data: {
          status: "failed",
          failureReason: "media/stale_upload",
          uploadId: null,
        },
      });

      // Record audit event
      await this.audit.record({
        action: "media.stale_reaped",
        resource: "media_asset",
        resourceId: asset.id,
        actorId: "system",
        workspaceId: asset.project.workspaceId,
        data: {
          previousStatus,
          reason: "media/stale_upload",
          hadUploadId,
          ageMs: now.getTime() - asset.createdAt.getTime(),
        },
      });

      reapedMediaIds.push(asset.id);
    }

    return {
      checked: candidates.length,
      reaped: reapedMediaIds.length,
      skippedActiveJobs,
      abortedUploads,
      reapedMediaIds,
    };
  }
}
