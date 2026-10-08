import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationsController } from "./integrations.controller.js";

describe("IntegrationsController", () => {
  let mockIntegrationsService: any;
  let mockCloudImportService: any;
  let controller: IntegrationsController;

  beforeEach(() => {
    mockIntegrationsService = {
      listIntegrations: vi.fn().mockResolvedValue([
        {
          id: "int-1",
          workspaceId: "ws-1",
          provider: "GOOGLE_DRIVE",
          accountEmail: "user@example.com",
          hasRefreshToken: true,
          expiresAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
      saveIntegration: vi.fn().mockResolvedValue({
        id: "int-2",
        workspaceId: "ws-1",
        provider: "DROPBOX",
        accountEmail: "user@example.com",
        hasRefreshToken: false,
        expiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      deleteIntegration: vi.fn().mockResolvedValue(undefined),
    };

    mockCloudImportService = {
      importFromCloud: vi.fn().mockResolvedValue({
        jobId: "job-123",
        workspaceId: "ws-1",
        projectId: "proj-1",
        provider: "GOOGLE_DRIVE",
        fileId: "drive-1",
        fileName: "video.mp4",
        fileSizeBytes: "1048576",
        status: "QUEUED",
        progressPct: 0,
        createdAt: new Date().toISOString(),
      }),
      getImportJob: vi.fn().mockResolvedValue({
        jobId: "job-123",
        workspaceId: "ws-1",
        status: "STREAMING",
        progressPct: 45,
      }),
    };

    controller = new IntegrationsController(
      mockIntegrationsService,
      mockCloudImportService,
    );
  });

  it("lists connected cloud integrations", async () => {
    const list = await controller.listIntegrations("ws-1");
    expect(list).toHaveLength(1);
    expect(list[0]!.provider).toBe("GOOGLE_DRIVE");
  });

  it("saves a cloud integration", async () => {
    const saved = await controller.saveIntegration("ws-1", {
      provider: "DROPBOX",
      accountEmail: "user@example.com",
      accessToken: "token_123",
    });
    expect(saved.provider).toBe("DROPBOX");
  });

  it("imports media from cloud", async () => {
    const result = await controller.importCloud("ws-1", {
      provider: "GOOGLE_DRIVE",
      fileId: "drive-1",
      fileName: "video.mp4",
      token: "ya29.sample",
    });
    expect(result.jobId).toBe("job-123");
    expect(result.status).toBe("QUEUED");
  });

  it("checks cloud import job status", async () => {
    const status = await controller.getCloudImportStatus("ws-1", "job-123");
    expect(status.status).toBe("STREAMING");
    expect(status.progressPct).toBe(45);
  });
});
