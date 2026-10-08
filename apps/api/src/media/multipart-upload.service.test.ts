import { describe, expect, it, vi, beforeEach } from "vitest";
import { MultipartUploadService } from "./multipart-upload.service.js";
import { RESUMABLE_CHUNK_SIZE_BYTES } from "./multipart-upload.dto.js";
import { AppException } from "../common/index.js";

const WORKSPACE = "01JBZ0Q4T7R8N4H1V0J9K2M3P5";
const PROJECT = "01JBZ0Q4T7R8N4H1V0J9K2M3P6";

describe("MultipartUploadService", () => {
  let prisma: any;
  let projects: any;
  let entitlements: any;
  let jobs: any;
  let rawStore: any;
  let derivedStore: any;
  let service: MultipartUploadService;

  beforeEach(() => {
    prisma = {
      project: {
        findFirst: vi.fn(async () => ({ id: PROJECT, workspaceId: WORKSPACE })),
        create: vi.fn(async ({ data }: any) => ({ ...data })),
        update: vi.fn(async ({ data }: any) => ({ ...data })),
      },
      mediaUploadSession: {
        create: vi.fn(async ({ data }: any) => ({ ...data })),
        findFirst: vi.fn(async () => ({
          id: "session-1",
          workspaceId: WORKSPACE,
          uploadId: "s3-upload-123",
          s3Key: `ws/${WORKSPACE}/p/${PROJECT}/media/media-1/raw.mp4`,
          fileName: "camera_prores.mov",
          fileSizeBytes: BigInt(64 * 1024 * 1024),
          mimeType: "video/quicktime",
          chunkSizeBytes: RESUMABLE_CHUNK_SIZE_BYTES,
          totalParts: 4,
          completedParts: 0,
          status: "UPLOADING",
        })),
        update: vi.fn(async ({ data }: any) => ({ ...data })),
      },
      mediaAsset: {
        create: vi.fn(async ({ data }: any) => ({ ...data })),
      },
    };

    projects = {
      requireProject: vi.fn(async () => ({ id: PROJECT, workspaceId: WORKSPACE })),
    };

    entitlements = {
      forWorkspace: vi.fn(async () => ({
        workspaceId: WORKSPACE,
        planKey: "creator",
        entitlements: {
          maxFileBytes: 10 * 1024 * 1024 * 1024,
          maxDurationMs: 7_200_000,
          retentionDays: 30,
        },
      })),
    };

    jobs = {
      enqueue: vi.fn(async () => ({ job: { id: "job-probe-123" } })),
    };

    rawStore = {
      kind: "s3",
      bucket: "aksharo-raw",
      initiateMultipartUpload: vi.fn(async () => ({ uploadId: "s3-upload-123" })),
      createMultipartUpload: vi.fn(async () => ({
        uploadId: "s3-upload-123",
        parts: [],
        key: "test",
        partSizeBytes: RESUMABLE_CHUNK_SIZE_BYTES,
        expiresAt: new Date().toISOString(),
      })),
      presignPartUpload: vi.fn(async (_k, _u, partNumber) => `https://s3.example.com/part-${partNumber}?sig=abc`),
      completeMultipartUpload: vi.fn(async () => ({ etag: '"final-etag"' })),
      abortMultipartUpload: vi.fn(async () => undefined),
      head: vi.fn(async () => ({ sizeBytes: 64 * 1024 * 1024, contentType: "video/quicktime" })),
      tag: vi.fn(async () => undefined),
    };

    derivedStore = {
      kind: "r2",
      bucket: "aksharo-derived",
    };

    service = new MultipartUploadService(
      prisma,
      projects,
      entitlements,
      jobs,
      rawStore,
      derivedStore,
    );
  });

  describe("initiateUpload", () => {
    it("initiates multipart upload for Apple ProRes MOV with 16MB chunks", async () => {
      const fileSizeBytes = 64 * 1024 * 1024; // 64 MB = 4 chunks
      const res = await service.initiateUpload(WORKSPACE, {
        fileName: "prores422_take1.mov",
        fileSizeBytes,
        mimeType: "video/quicktime",
        projectId: PROJECT,
      });

      expect(res.uploadId).toBe("s3-upload-123");
      expect(res.chunkSize).toBe(RESUMABLE_CHUNK_SIZE_BYTES);
      expect(res.totalParts).toBe(4);
      expect(res.initialPartUrl).toContain("part-1");
      expect(rawStore.initiateMultipartUpload).toHaveBeenCalledTimes(1);
      expect(prisma.mediaUploadSession.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: WORKSPACE,
            uploadId: "s3-upload-123",
            chunkSizeBytes: RESUMABLE_CHUNK_SIZE_BYTES,
            totalParts: 4,
            status: "UPLOADING",
          }),
        }),
      );
    });

    it("supports OBS MKV container recordings up to 10 GB", async () => {
      const fileSizeBytes = 6 * 1024 * 1024 * 1024; // 6 GB
      const res = await service.initiateUpload(WORKSPACE, {
        fileName: "gameplay_obs.mkv",
        fileSizeBytes,
        mimeType: "video/x-matroska",
      });

      expect(res.totalParts).toBe(Math.ceil(fileSizeBytes / RESUMABLE_CHUNK_SIZE_BYTES));
      expect(res.uploadId).toBe("s3-upload-123");
    });

    it("supports audio-only podcast WAV recordings", async () => {
      const fileSizeBytes = 50 * 1024 * 1024;
      const res = await service.initiateUpload(WORKSPACE, {
        fileName: "podcast_master.wav",
        fileSizeBytes,
        mimeType: "audio/wav",
      });

      expect(res.totalParts).toBe(Math.ceil(50 * 1024 * 1024 / RESUMABLE_CHUNK_SIZE_BYTES));
      expect(res.uploadId).toBe("s3-upload-123");
    });

    it("rejects unsupported executable or binary files with 415", async () => {
      await expect(
        service.initiateUpload(WORKSPACE, {
          fileName: "malicious.exe",
          fileSizeBytes: 1024,
          mimeType: "application/x-msdownload",
        }),
      ).rejects.toThrow(AppException);
    });

    it("rejects upload when file exceeds plan entitlement with 413", async () => {
      entitlements.forWorkspace.mockResolvedValueOnce({
        workspaceId: WORKSPACE,
        planKey: "free",
        entitlements: {
          maxFileBytes: 500 * 1024 * 1024, // 500 MB max
        },
      });

      await expect(
        service.initiateUpload(WORKSPACE, {
          fileName: "giant.mp4",
          fileSizeBytes: 2 * 1024 * 1024 * 1024, // 2 GB
          mimeType: "video/mp4",
        }),
      ).rejects.toThrow(AppException);
    });
  });

  describe("signPartUrl", () => {
    it("generates signed PUT URL on demand for arbitrary chunk", async () => {
      const res = await service.signPartUrl(WORKSPACE, {
        uploadId: "s3-upload-123",
        s3Key: `ws/${WORKSPACE}/p/${PROJECT}/media/media-1/raw.mp4`,
        partNumber: 3,
      });

      expect(res.partNumber).toBe(3);
      expect(res.url).toContain("part-3");
      expect(res.expiresInSeconds).toBe(3600);
      expect(rawStore.presignPartUpload).toHaveBeenCalledWith(
        `ws/${WORKSPACE}/p/${PROJECT}/media/media-1/raw.mp4`,
        "s3-upload-123",
        3,
        3600,
      );
    });

    it("throws 404 when session is not found", async () => {
      prisma.mediaUploadSession.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.signPartUrl(WORKSPACE, {
          uploadId: "unknown",
          s3Key: "test",
          partNumber: 1,
        }),
      ).rejects.toThrow(AppException);
    });

    it("throws 409 when session is not in UPLOADING status", async () => {
      prisma.mediaUploadSession.findFirst.mockResolvedValueOnce({
        status: "COMPLETED",
        totalParts: 4,
      });

      await expect(
        service.signPartUrl(WORKSPACE, {
          uploadId: "s3-upload-123",
          s3Key: "test",
          partNumber: 1,
        }),
      ).rejects.toThrow(AppException);
    });
  });

  describe("completeUpload", () => {
    it("completes S3 multipart upload and enqueues probe job", async () => {
      const parts = [
        { PartNumber: 1, ETag: '"etag-1"' },
        { PartNumber: 2, ETag: '"etag-2"' },
        { PartNumber: 3, ETag: '"etag-3"' },
        { PartNumber: 4, ETag: '"etag-4"' },
      ];

      const res = await service.completeUpload(WORKSPACE, {
        uploadId: "s3-upload-123",
        s3Key: `ws/${WORKSPACE}/p/${PROJECT}/media/media-1/raw.mp4`,
        parts,
        projectId: PROJECT,
      });

      expect(res.success).toBe(true);
      expect(res.status).toBe("uploaded");
      expect(res.probeJobId).toBe("job-probe-123");
      expect(rawStore.completeMultipartUpload).toHaveBeenCalledTimes(1);
      expect(prisma.mediaUploadSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "COMPLETED",
            completedParts: 4,
          }),
        }),
      );
      expect(prisma.mediaAsset.create).toHaveBeenCalledTimes(1);
      expect(jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "media.probe",
          projectId: PROJECT,
        }),
      );
    });
  });

  describe("abortUpload", () => {
    it("aborts S3 upload and updates session status", async () => {
      const res = await service.abortUpload(WORKSPACE, {
        uploadId: "s3-upload-123",
        s3Key: `ws/${WORKSPACE}/p/${PROJECT}/media/media-1/raw.mp4`,
      });

      expect(res.aborted).toBe(true);
      expect(rawStore.abortMultipartUpload).toHaveBeenCalledWith(
        `ws/${WORKSPACE}/p/${PROJECT}/media/media-1/raw.mp4`,
        "s3-upload-123",
      );
      expect(prisma.mediaUploadSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: "ABORTED" },
        }),
      );
    });
  });
});

