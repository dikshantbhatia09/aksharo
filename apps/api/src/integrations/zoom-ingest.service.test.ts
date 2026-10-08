import { beforeEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulid";
import { ZoomIngestService } from "./zoom-ingest.service.js";

// Mock @aws-sdk/lib-storage
vi.mock("@aws-sdk/lib-storage", () => {
  class MockUpload {
    params: { Bucket: string; Key: string };
    constructor(options: { params: { Bucket: string; Key: string } }) {
      this.params = options.params;
    }
    async done() {
      return { Bucket: this.params.Bucket, Key: this.params.Key };
    }
  }
  return { Upload: MockUpload };
});

describe("ZoomIngestService", () => {
  let prisma: any;
  let projects: any;
  let jobs: any;
  let rawStore: any;
  let derivedStore: any;
  let service: ZoomIngestService;

  beforeEach(() => {
    vi.clearAllMocks();

    prisma = {
      project: {
        create: vi.fn().mockImplementation((args) => Promise.resolve(args.data)),
      },
      mediaAsset: {
        create: vi.fn().mockImplementation((args) => Promise.resolve(args.data)),
      },
      zoomRecordingEvent: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    projects = {};

    jobs = {
      enqueue: vi.fn().mockResolvedValue({ id: "job-123" }),
    };

    rawStore = {
      kind: "s3",
      bucket: "test-raw-bucket",
      getClient: vi.fn().mockReturnValue({}),
    };

    derivedStore = {
      kind: "s3",
      bucket: "test-derived-bucket",
    };

    service = new ZoomIngestService(
      prisma,
      projects,
      jobs,
      rawStore,
      derivedStore,
    );
  });

  describe("ingestZoomRecording", () => {
    it("handles multi-speaker tracks, streams to S3, and enqueues probe job", async () => {
      const validWsId = ulid();
      const customFetch = vi.fn().mockImplementation(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "video/mp4" }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        }),
      }));

      const result = await service.ingestZoomRecording({
        workspaceId: validWsId,
        meetingId: "meet-987654",
        topic: "Weekly Engineering All-Hands",
        recordingFiles: [
          {
            id: "f-1",
            file_type: "MP4",
            recording_type: "shared_screen_with_speaker_view",
            download_url: "https://zoom.us/rec/play/f1.mp4",
            file_size: 5000000,
          },
          {
            id: "f-2",
            file_type: "M4A",
            recording_type: "audio_only",
            download_url: "https://zoom.us/rec/play/f2.m4a",
            file_size: 1000000,
          },
          {
            id: "f-3",
            file_type: "MP4",
            recording_type: "active_speaker",
            download_url: "https://zoom.us/rec/play/f3.mp4",
            file_size: 3000000,
          },
        ],
        accessToken: "test-zoom-jwt",
        customFetch: customFetch as any,
      });

      expect(result.projectId).toBeDefined();
      expect(result.mediaId).toBeDefined();
      expect(result.storageKey).toContain(validWsId);
      expect(result.secondaryTracks.length).toBe(2); // audio_only + active_speaker secondary video

      // Verify Prisma Project creation
      expect(prisma.project.create).toHaveBeenCalledTimes(1);
      const createdProject = prisma.project.create.mock.calls[0][0].data;
      expect(createdProject.title).toBe("Weekly Engineering All-Hands");
      expect(createdProject.workspaceId).toBe(validWsId);
      expect(createdProject.status).toBe("active");

      // Verify MediaAsset records: 1 primary + 1 audio + 1 secondary video = 3 assets
      expect(prisma.mediaAsset.create).toHaveBeenCalledTimes(3);

      // Verify zoomRecordingEvent status update in ledger
      expect(prisma.zoomRecordingEvent.updateMany).toHaveBeenCalledWith({
        where: { meetingId: "meet-987654" },
        data: expect.objectContaining({
          status: "COMPLETED",
          projectId: result.projectId,
        }),
      });

      // Verify media.probe job enqueueing
      expect(jobs.enqueue).toHaveBeenCalledTimes(1);
      const enqueuedJob = jobs.enqueue.mock.calls[0][0];
      expect(enqueuedJob.type).toBe("media.probe");
      expect(enqueuedJob.workspaceId).toBe(validWsId);
      expect(enqueuedJob.projectId).toBe(result.projectId);
    });

    it("throws error if no recording files are provided", async () => {
      const validWsId = ulid();
      await expect(
        service.ingestZoomRecording({
          workspaceId: validWsId,
          meetingId: "meet-empty",
          recordingFiles: [],
          accessToken: "token",
        }),
      ).rejects.toThrow("No recording files found in Zoom meeting meet-empty");
    });
  });

  describe("ingestRiversideSession", () => {
    it("creates project and assets for Riverside tracks", async () => {
      const validWsId = ulid();
      const customFetch = vi.fn().mockImplementation(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "video/mp4" }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([4, 5, 6]));
            controller.close();
          },
        }),
      }));

      const res = await service.ingestRiversideSession(
        validWsId,
        {
          sessionId: "riv-123",
          sessionTitle: "Founders Podcast Ep 12",
          tracks: [
            {
              speakerName: "Host Alice",
              audioUrl: "https://riverside.fm/rec/host.wav",
              videoUrl: "https://riverside.fm/rec/host.mp4",
              role: "host",
            },
            {
              speakerName: "Guest Bob",
              audioUrl: "https://riverside.fm/rec/guest.wav",
              videoUrl: "https://riverside.fm/rec/guest.mp4",
              role: "guest",
            },
          ],
        },
        customFetch as any,
      );

      expect(res.projectId).toBeDefined();
      expect(res.tracksCount).toBe(2);
      expect(prisma.project.create).toHaveBeenCalledTimes(1);
      expect(prisma.mediaAsset.create).toHaveBeenCalledTimes(2);
    });
  });

  describe("ingestGoogleMeetRecording", () => {
    it("creates project and mediaAsset for Google Meet file", async () => {
      const validWsId = ulid();
      const res = await service.ingestGoogleMeetRecording(validWsId, {
        meetCode: "abc-defg-hij",
        recordingFileId: "drive-file-789",
        title: "Sprint Planning Meet",
      });

      expect(res.projectId).toBeDefined();
      expect(res.mediaId).toBeDefined();
      expect(prisma.project.create).toHaveBeenCalledTimes(1);
      expect(prisma.mediaAsset.create).toHaveBeenCalledTimes(1);
    });
  });
});
