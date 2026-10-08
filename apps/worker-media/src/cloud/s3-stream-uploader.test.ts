import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { uploadStreamToS3 } from "./s3-stream-uploader.js";

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

describe("uploadStreamToS3", () => {
  it("streams directly to S3 via @aws-sdk/lib-storage with progress events", async () => {
    const mockClient = {} as import("@aws-sdk/client-s3").S3Client;
    const stream = Readable.from(["part-1", "part-2", "part-3"]);
    const progressList: { loaded: number; percentage: number }[] = [];

    const result = await uploadStreamToS3({
      client: mockClient,
      bucket: "test-raw-bucket",
      key: "ws/123/media/456/raw.mp4",
      stream,
      contentType: "video/mp4",
      totalExpectedBytes: 1048576,
      onProgress: (p) => {
        progressList.push(p);
      },
    });

    expect(result.bucket).toBe("test-raw-bucket");
    expect(result.key).toBe("ws/123/media/456/raw.mp4");
    expect(result.totalBytesUploaded).toBe(1048576);
    expect(progressList.length).toBeGreaterThan(0);
    expect(progressList[progressList.length - 1].percentage).toBe(100);
  });
});
