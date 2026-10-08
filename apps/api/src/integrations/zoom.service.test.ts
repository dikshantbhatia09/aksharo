import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZoomService } from "./zoom.service.js";

describe("ZoomService", () => {
  let prisma: any;
  let vault: any;
  let service: ZoomService;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ZOOM_CLIENT_ID = "mock_client_id";
    process.env.ZOOM_CLIENT_SECRET = "mock_client_secret";

    prisma = {
      workspaceZoomIntegration: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      zoomRecordingEvent: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
    };

    vault = {
      encrypt: vi.fn().mockImplementation((val: string) => `enc_${val}`),
      decrypt: vi.fn().mockImplementation((val: string) => val.replace("enc_", "")),
    };

    service = new ZoomService(prisma, vault);
  });

  describe("getAuthUrl", () => {
    it("builds a valid Zoom OAuth authorization URL", () => {
      const result = service.getAuthUrl("ws-123");
      const url = new URL(result.url);

      expect(url.origin).toBe("https://zoom.us");
      expect(url.pathname).toBe("/oauth/authorize");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("client_id")).toBe("mock_client_id");
      expect(url.searchParams.get("state")).toBe("ws-123");
    });
  });

  describe("handleOAuthCallback", () => {
    it("exchanges code and stores encrypted tokens", async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/oauth/token")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                access_token: "zm_access_token_123",
                refresh_token: "zm_refresh_token_456",
                expires_in: 3600,
              }),
          });
        }
        if (url.includes("/users/me")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                id: "zm_user_999",
                email: "podcast.host@crestmondtechnologies.com",
              }),
          });
        }
        return Promise.reject(new Error("Unknown url"));
      });

      prisma.workspaceZoomIntegration.upsert.mockResolvedValue({
        id: "int-1",
        workspaceId: "ws-123",
        zoomUserId: "zm_user_999",
        zoomEmail: "podcast.host@crestmondtechnologies.com",
        autoRepurpose: true,
        minDurationSec: 600,
        nameFilter: null,
        expiresAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.handleOAuthCallback(
        "ws-123",
        "auth_code_789",
        undefined,
        mockFetch as any,
      );

      expect(vault.encrypt).toHaveBeenCalledWith("zm_access_token_123");
      expect(vault.encrypt).toHaveBeenCalledWith("zm_refresh_token_456");
      expect(prisma.workspaceZoomIntegration.upsert).toHaveBeenCalled();
      expect(result.zoomUserId).toBe("zm_user_999");
      expect(result.zoomEmail).toBe("podcast.host@crestmondtechnologies.com");
      expect(result.autoRepurpose).toBe(true);
    });
  });

  describe("getValidAccessToken with automatic token refresh", () => {
    it("returns active decrypted token when token is fresh (> 5 mins remaining)", async () => {
      const futureDate = new Date(Date.now() + 60 * 60 * 1000); // 1 hour ahead
      prisma.workspaceZoomIntegration.findUnique.mockResolvedValue({
        workspaceId: "ws-123",
        accessToken: "enc_zm_fresh_access",
        refreshToken: "enc_zm_fresh_refresh",
        expiresAt: futureDate,
      });

      const token = await service.getValidAccessToken("ws-123");

      expect(token).toBe("zm_fresh_access");
      expect(prisma.workspaceZoomIntegration.update).not.toHaveBeenCalled();
    });

    it("automatically refreshes token when token expires within 5 minutes", async () => {
      const expiringSoon = new Date(Date.now() + 2 * 60 * 1000); // 2 minutes ahead (< 5 mins)
      prisma.workspaceZoomIntegration.findUnique.mockResolvedValue({
        workspaceId: "ws-123",
        accessToken: "enc_zm_old_access",
        refreshToken: "enc_zm_old_refresh",
        expiresAt: expiringSoon,
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "zm_newly_refreshed_access",
            refresh_token: "zm_newly_refreshed_refresh",
            expires_in: 3600,
          }),
      });

      prisma.workspaceZoomIntegration.update.mockResolvedValue({});

      const token = await service.getValidAccessToken("ws-123", mockFetch as any);

      expect(token).toBe("zm_newly_refreshed_access");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://zoom.us/oauth/token",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/x-www-form-urlencoded",
          }),
        }),
      );
      expect(prisma.workspaceZoomIntegration.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId: "ws-123" },
          data: expect.objectContaining({
            accessToken: "enc_zm_newly_refreshed_access",
            refreshToken: "enc_zm_newly_refreshed_refresh",
          }),
        }),
      );
    });
  });

  describe("updateSettings & disconnect", () => {
    it("updates selective ingestion rules", async () => {
      prisma.workspaceZoomIntegration.findUnique.mockResolvedValue({
        workspaceId: "ws-123",
      });
      prisma.workspaceZoomIntegration.update.mockResolvedValue({
        id: "int-1",
        workspaceId: "ws-123",
        zoomUserId: "zm_user_1",
        zoomEmail: "test@example.com",
        autoRepurpose: false,
        minDurationSec: 1200,
        nameFilter: "#podcast",
        expiresAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = await service.updateSettings("ws-123", {
        autoRepurpose: false,
        minDurationSec: 1200,
        nameFilter: "#podcast",
      });

      expect(updated.autoRepurpose).toBe(false);
      expect(updated.minDurationSec).toBe(1200);
      expect(updated.nameFilter).toBe("#podcast");
    });

    it("disconnects integration", async () => {
      prisma.workspaceZoomIntegration.findUnique.mockResolvedValue({
        workspaceId: "ws-123",
      });
      prisma.workspaceZoomIntegration.delete.mockResolvedValue({});

      await service.disconnect("ws-123");
      expect(prisma.workspaceZoomIntegration.delete).toHaveBeenCalledWith({
        where: { workspaceId: "ws-123" },
      });
    });
  });

  describe("ledger events listing", () => {
    it("lists events from persistent ledger", async () => {
      prisma.zoomRecordingEvent.findMany.mockResolvedValue([
        {
          id: "ev-1",
          meetingId: "123456789",
          workspaceId: "ws-123",
          topic: "Q3 All Hands",
          durationMin: 60,
          fileCount: 2,
          status: "COMPLETED",
          projectId: "proj-1",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const events = await service.listEvents("ws-123");
      expect(events).toHaveLength(1);
      expect(events[0]!.meetingId).toBe("123456789");
      expect(events[0]!.status).toBe("COMPLETED");
    });
  });
});

