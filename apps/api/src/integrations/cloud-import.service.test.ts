import { describe, expect, it, vi } from "vitest";
import { CloudImportService } from "./cloud-import.service.js";

describe("CloudImportService", () => {
  it("creates a CloudImportJob, MediaAsset, and enqueues streaming import", async () => {
    const mockJobs: any[] = [];
    const mockMedia: any[] = [];
    const WS_ID = "01JBQ8Z2W4N7Y0K3M5P8R1T6VB";
    const PROJ_ID = "01JBQ8Z2W4N7Y0K3M5P8R1T6VC";

    const prisma = {
      project: {
        findFirst: vi.fn().mockResolvedValue({ id: PROJ_ID, title: "Existing Project" }),
        create: vi.fn().mockResolvedValue({ id: PROJ_ID, title: "interview.mp4", status: "draft" }),
      },
      mediaAsset: {
        create: vi.fn().mockImplementation(({ data }) => {
          mockMedia.push(data);
          return data;
        }),
      },
      cloudImportJob: {
        create: vi.fn().mockImplementation(({ data }) => {
          const row = { id: "job-1", createdAt: new Date(), ...data };
          mockJobs.push(row);
          return row;
        }),
        findFirst: vi.fn().mockImplementation(({ where }) => {
          return mockJobs.find((j) => j.id === where.id);
        }),
      },
    } as any;

    const integrations = {
      getDecryptedToken: vi.fn(),
    } as any;

    const projects = {
      create: vi.fn().mockResolvedValue({ id: PROJ_ID, title: "New Project" }),
    } as any;

    const jobs = {
      enqueue: vi.fn(),
    } as any;

    const rawStore = {
      bucket: "raw-bucket",
      kind: "s3",
      getClient: vi.fn().mockReturnValue({}),
    } as any;

    const derivedStore = {
      bucket: "derived-bucket",
      kind: "r2",
    } as any;

    const service = new CloudImportService(
      prisma,
      integrations,
      projects,
      jobs,
      rawStore,
      derivedStore,
    );

    const result = await service.importFromCloud(WS_ID, {
      provider: "GOOGLE_DRIVE",
      fileId: "drive-file-999",
      fileName: "interview.mp4",
      fileSizeBytes: 1048576,
      token: "ya29.sample-token",
    });

    expect(result.jobId).toBe("job-1");
    expect(result.status).toBe("QUEUED");
    expect(result.provider).toBe("GOOGLE_DRIVE");
    expect(result.fileName).toBe("interview.mp4");
    expect(mockMedia).toHaveLength(1);
    expect(mockMedia[0].status).toBe("uploading");
    expect(mockJobs).toHaveLength(1);
    expect(mockJobs[0].status).toBe("QUEUED");
  });

  it("throws error when token is missing and no stored OAuth integration exists", async () => {
    const prisma = {} as any;
    const integrations = {
      getDecryptedToken: vi.fn().mockResolvedValue(null),
    } as any;
    const projects = {} as any;
    const jobs = {} as any;
    const rawStore = {} as any;
    const derivedStore = {} as any;

    const service = new CloudImportService(
      prisma,
      integrations,
      projects,
      jobs,
      rawStore,
      derivedStore,
    );

    await expect(
      service.importFromCloud("ws-1", {
        provider: "GOOGLE_DRIVE",
        fileId: "drive-file-999",
      }),
    ).rejects.toThrow(/integrations\/token_required/);
  });
});
