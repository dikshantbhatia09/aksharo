import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { ZoomWebhookController, verifyZoomSignature } from "./zoom.controller.js";

describe("ZoomWebhookController & Verification", () => {
  const SECRET_TOKEN = "test_webhook_secret_12345";
  let prisma: any;
  let zoomService: any;
  let zoomIngest: any;
  let controller: ZoomWebhookController;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ZOOM_WEBHOOK_SECRET_TOKEN = SECRET_TOKEN;

    prisma = {
      zoomRecordingEvent: {
        findUnique: vi.fn(),
        create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: "ev-1", ...data })),
        updateMany: vi.fn(),
      },
      workspaceZoomIntegration: {
        findFirst: vi.fn(),
      },
    };

    zoomService = {
      getValidAccessToken: vi.fn().mockResolvedValue("zm_valid_bearer_token"),
    };

    zoomIngest = {
      ingestZoomRecording: vi.fn().mockResolvedValue({
        projectId: "proj-1",
        mediaId: "media-1",
        storageKey: "raw.mp4",
      }),
    };

    controller = new ZoomWebhookController(prisma, zoomService, zoomIngest);
  });

  describe("HMAC-SHA256 Signature Verification & CRC Validation", () => {
    it("successfully answers endpoint.url_validation challenge with HMAC-SHA256", async () => {
      const plainToken = "zoom_plain_token_abc123";
      const expectedHash = crypto
        .createHmac("sha256", SECRET_TOKEN)
        .update(plainToken)
        .digest("hex");

      const response = await controller.handleZoomWebhook({
        event: "endpoint.url_validation",
        payload: { plainToken },
      });

      expect(response).toEqual({
        plainToken,
        encryptedToken: expectedHash,
      });
    });

    it("verifies valid x-zm-signature header using timing-safe comparison", () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const bodyText = JSON.stringify({ event: "recording.completed" });
      const message = `v0:${timestamp}:${bodyText}`;
      const hash = crypto.createHmac("sha256", SECRET_TOKEN).update(message).digest("hex");
      const signature = `v0=${hash}`;

      const isValid = verifyZoomSignature({
        signatureHeader: signature,
        timestampHeader: timestamp,
        bodyText,
        secretToken: SECRET_TOKEN,
      });

      expect(isValid).toBe(true);
    });

    it("rejects invalid signature", () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const bodyText = JSON.stringify({ event: "recording.completed" });

      const isValid = verifyZoomSignature({
        signatureHeader: "v0=invalid_tampered_signature_hash_1234567890abcdef",
        timestampHeader: timestamp,
        bodyText,
        secretToken: SECRET_TOKEN,
      });

      expect(isValid).toBe(false);
    });

    it("rejects replay attacks with timestamp older than 300 seconds", () => {
      const oldTimestamp = String(Math.floor(Date.now() / 1000) - 400);
      const bodyText = JSON.stringify({ event: "recording.completed" });
      const message = `v0:${oldTimestamp}:${bodyText}`;
      const hash = crypto.createHmac("sha256", SECRET_TOKEN).update(message).digest("hex");

      const isValid = verifyZoomSignature({
        signatureHeader: `v0=${hash}`,
        timestampHeader: oldTimestamp,
        bodyText,
        secretToken: SECRET_TOKEN,
      });

      expect(isValid).toBe(false);
    });
  });

  describe("Persistent Idempotent Webhook Ledger & Selective Ingestion Rules", () => {
    const payloadObject = {
      id: "987654321",
      topic: "Q3 Webinar: Product Strategy #webinar",
      duration: 45, // 45 minutes
      host_id: "zm_host_123",
      recording_files: [
        {
          file_type: "MP4",
          recording_type: "shared_screen_with_speaker_view",
          download_url: "https://api.zoom.us/rec/download/1",
        },
        {
          file_type: "M4A",
          recording_type: "audio_only",
          download_url: "https://api.zoom.us/rec/download/2",
        },
      ],
    };

    it("returns 200 duplicate immediately when meetingId is already in ledger (idempotent)", async () => {
      prisma.zoomRecordingEvent.findUnique.mockResolvedValue({
        id: "ev-existing",
        meetingId: "987654321",
        status: "COMPLETED",
      });

      const response = await controller.handleZoomWebhook({
        event: "recording.completed",
        payload: { object: payloadObject },
      });

      expect(response.status).toBe("duplicate");
      expect(response.meetingId).toBe("987654321");
      expect(prisma.zoomRecordingEvent.create).not.toHaveBeenCalled();
    });

    it("ignores recording when no matching workspace integration is found", async () => {
      prisma.zoomRecordingEvent.findUnique.mockResolvedValue(null);
      prisma.workspaceZoomIntegration.findFirst.mockResolvedValue(null);

      const response = await controller.handleZoomWebhook({
        event: "recording.completed",
        payload: { object: payloadObject },
      });

      expect(response.status).toBe("ignored");
      expect(response.reason).toBe("no_matching_workspace_integration");
      expect(prisma.zoomRecordingEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          meetingId: "987654321",
          status: "IGNORED",
        }),
      });
    });

    it("respects selective ingestion rule: autoRepurpose=false", async () => {
      prisma.zoomRecordingEvent.findUnique.mockResolvedValue(null);
      prisma.workspaceZoomIntegration.findFirst.mockResolvedValue({
        workspaceId: "ws-1",
        zoomUserId: "zm_host_123",
        autoRepurpose: false,
        minDurationSec: 600,
      });

      const response = await controller.handleZoomWebhook({
        event: "recording.completed",
        payload: { object: payloadObject },
      });

      expect(response.status).toBe("ignored");
      expect(response.reason).toBe("auto_repurpose_disabled");
      expect(prisma.zoomRecordingEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: "IGNORED",
        }),
      });
    });

    it("respects selective ingestion rule: minDurationSec filter", async () => {
      prisma.zoomRecordingEvent.findUnique.mockResolvedValue(null);
      prisma.workspaceZoomIntegration.findFirst.mockResolvedValue({
        workspaceId: "ws-1",
        zoomUserId: "zm_host_123",
        autoRepurpose: true,
        minDurationSec: 3600, // 60 minutes minimum
      });

      // Meeting duration is 45 minutes (2700s < 3600s)
      const response = await controller.handleZoomWebhook({
        event: "recording.completed",
        payload: { object: payloadObject },
      });

      expect(response.status).toBe("ignored");
      expect(response.reason).toBe("duration_below_minimum_3600s");
      expect(prisma.zoomRecordingEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: "IGNORED",
        }),
      });
    });

    it("respects selective ingestion rule: nameFilter regex/tag", async () => {
      prisma.zoomRecordingEvent.findUnique.mockResolvedValue(null);
      prisma.workspaceZoomIntegration.findFirst.mockResolvedValue({
        workspaceId: "ws-1",
        zoomUserId: "zm_host_123",
        autoRepurpose: true,
        minDurationSec: 600,
        nameFilter: "#all-hands", // Does not match '#webinar'
      });

      const response = await controller.handleZoomWebhook({
        event: "recording.completed",
        payload: { object: payloadObject },
      });

      expect(response.status).toBe("ignored");
      expect(response.reason).toBe("name_filter_not_matched");
      expect(prisma.zoomRecordingEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: "IGNORED",
        }),
      });
    });

    it("accepts valid recording, records PROCESSING in ledger, and initiates ingestion", async () => {
      prisma.zoomRecordingEvent.findUnique.mockResolvedValue(null);
      prisma.workspaceZoomIntegration.findFirst.mockResolvedValue({
        workspaceId: "ws-1",
        zoomUserId: "zm_host_123",
        autoRepurpose: true,
        minDurationSec: 600,
        nameFilter: "#webinar",
      });

      const response = await controller.handleZoomWebhook({
        event: "recording.completed",
        payload: { object: payloadObject },
      });

      expect(response.status).toBe("accepted");
      expect(response.meetingId).toBe("987654321");
      expect(response.workspaceId).toBe("ws-1");

      expect(prisma.zoomRecordingEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          meetingId: "987654321",
          workspaceId: "ws-1",
          status: "PROCESSING",
        }),
      });
    });
  });
});

