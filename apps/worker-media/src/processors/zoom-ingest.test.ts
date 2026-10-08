import { describe, expect, it, vi } from "vitest";
import {
  planZoomIngest,
  streamZoomFileToS3,
  processZoomIngest,
  type ZoomRecordingFileDescriptor,
} from "./zoom-ingest.js";
import type { S3Client } from "@aws-sdk/client-s3";

// Mock @aws-sdk/lib-storage
vi.mock("@aws-sdk/lib-storage", () => {
  class MockUpload {
    private handlers: Record<string, ((data: unknown) => void)[]> = {};
    params: { Bucket: string; Key: string };

    constructor(options: { params: { Bucket: string; Key: string } }) {
      this.params = options.params;
    }

    on(event: string, handler: (data: unknown) => void) {
      if (!this.handlers[event]) this.handlers[event] = [];
      this.handlers[event].push(handler);
      return this;
    }

    async done() {
      const progressHandlers = this.handlers["httpUploadProgress"] || [];
      for (const h of progressHandlers) {
        h({ loaded: 1048576, total: 1048576 });
      }
      return { Bucket: this.params.Bucket, Key: this.params.Key };
    }

    abort() {}
  }

  return {
    Upload: MockUpload,
  };
});

describe("planZoomIngest", () => {
  it("prioritizes shared_screen_with_speaker_view over active_speaker for primary video", () => {
    const files: ZoomRecordingFileDescriptor[] = [
      {
        id: "1",
        file_type: "MP4",
        recording_type: "active_speaker",
        download_url: "https://zoom.us/rec/play/1.mp4",
      },
      {
        id: "2",
        file_type: "MP4",
        recording_type: "shared_screen_with_speaker_view",
        download_url: "https://zoom.us/rec/play/2.mp4",
      },
      {
        id: "3",
        file_type: "M4A",
        recording_type: "audio_only",
        download_url: "https://zoom.us/rec/play/3.m4a",
      },
    ];

    const plan = planZoomIngest(files);
    expect(plan.primaryVideo.recording_type).toBe("shared_screen_with_speaker_view");
    expect(plan.audioOnly?.recording_type).toBe("audio_only");
    expect(plan.secondaryTracks.length).toBe(1);
    expect(plan.secondaryTracks[0]?.recording_type).toBe("active_speaker");
  });

  it("identifies active_speaker as primary if shared_screen not present", () => {
    const files: ZoomRecordingFileDescriptor[] = [
      {
        id: "1",
        file_type: "MP4",
        recording_type: "active_speaker",
        download_url: "https://zoom.us/rec/play/1.mp4",
      },
      {
        id: "2",
        file_type: "MP4",
        recording_type: "gallery_view",
        download_url: "https://zoom.us/rec/play/2.mp4",
      },
    ];

    const plan = planZoomIngest(files);
    expect(plan.primaryVideo.recording_type).toBe("active_speaker");
    expect(plan.secondaryTracks.length).toBe(1);
    expect(plan.secondaryTracks[0]?.recording_type).toBe("gallery_view");
  });

  it("throws if empty files array is passed", () => {
    expect(() => planZoomIngest([])).toThrow("No recording files provided to Zoom ingest processor");
  });
});

describe("streamZoomFileToS3", () => {
  it("fetches URL with Bearer token and uploads stream to S3", async () => {
    const mockS3 = {} as S3Client;
    const fakeData = new Uint8Array([1, 2, 3, 4]);

    const customFetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "video/mp4" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(fakeData);
          controller.close();
        },
      }),
    }));

    const bytes = await streamZoomFileToS3({
      s3Client: mockS3,
      bucket: "test-bucket",
      storageKey: "raw/test.mp4",
      downloadUrl: "https://zoom.us/rec/download/xyz",
      accessToken: "zoom-token-123",
      customFetch: customFetch as any,
    });

    expect(bytes).toBe(1048576);
    expect(customFetch).toHaveBeenCalledTimes(1);
    const calledUrl = customFetch.mock.calls[0][0];
    const calledOpts = customFetch.mock.calls[0][1];
    expect(calledUrl).toContain("access_token=zoom-token-123");
    expect(calledOpts.headers["Authorization"]).toBe("Bearer zoom-token-123");
  });

  it("throws an error if fetch fails", async () => {
    const mockS3 = {} as S3Client;
    const customFetch = vi.fn().mockImplementation(async () => ({
      ok: false,
      status: 403,
    }));

    await expect(
      streamZoomFileToS3({
        s3Client: mockS3,
        bucket: "test-bucket",
        storageKey: "raw/test.mp4",
        downloadUrl: "https://zoom.us/rec/download/xyz",
        customFetch: customFetch as any,
      }),
    ).rejects.toThrow("Failed to download Zoom recording file");
  });
});

describe("processZoomIngest", () => {
  it("processes full Zoom ingest workflow and uploads all tracks", async () => {
    const mockS3 = {} as S3Client;
    const customFetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "video/mp4" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      }),
    }));

    const output = await processZoomIngest(
      {
        workspaceId: "ws-1",
        meetingId: "meeting-999",
        accessToken: "token-abc",
        recordingFiles: [
          {
            id: "1",
            file_type: "MP4",
            recording_type: "shared_screen_with_speaker_view",
            download_url: "https://zoom.us/rec/play/1.mp4",
          },
          {
            id: "2",
            file_type: "M4A",
            recording_type: "audio_only",
            download_url: "https://zoom.us/rec/play/2.m4a",
          },
          {
            id: "3",
            file_type: "MP4",
            recording_type: "active_speaker",
            download_url: "https://zoom.us/rec/play/3.mp4",
          },
        ],
      },
      {
        s3Client: mockS3,
        bucket: "raw-bucket",
        keyPrefix: "ws-1/projects/proj-1",
        customFetch: customFetch as any,
      },
    );

    expect(output.meetingId).toBe("meeting-999");
    expect(output.primaryVideoKey).toBe("ws-1/projects/proj-1/meeting-999/primary.mp4");
    expect(output.audioOnlyKey).toBe("ws-1/projects/proj-1/meeting-999/audio.m4a");
    expect(output.secondaryTrackKeys.length).toBe(1);
    expect(output.secondaryTrackKeys[0]).toBe("ws-1/projects/proj-1/meeting-999/speaker_1.mp4");
    expect(output.totalBytes).toBe(1048576 * 3);
  });
});
