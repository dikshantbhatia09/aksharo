import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IDB_DATABASE_NAME,
  RESUMABLE_CHUNK_SIZE_BYTES,
  ResumableIdbStore,
  ResumableUploader,
} from "./resumable-uploader";

describe("ResumableUploader", () => {
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(IDB_DATABASE_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });

  describe("chunk boundaries", () => {
    it("slices 50MB into three 16MB chunks and one 2MB chunk", async () => {
      const fileSize = 50 * 1024 * 1024;
      // Mock blob without allocating 50MB of memory
      const fakeBlob = {
        size: fileSize,
        type: "video/mp4",
        slice: (start: number, end: number) => {
          const actualEnd = Math.min(fileSize, end);
          return { size: actualEnd - start, type: "video/mp4" } as Blob;
        },
      } as unknown as Blob;

      const uploadedChunkSizes: number[] = [];
      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = url.toString();
        if (urlStr.includes("/initiate")) {
          return new Response(
            JSON.stringify({
              sessionId: "sess-1",
              uploadId: "s3-up-1",
              s3Key: "media/test.mp4",
              chunkSize: RESUMABLE_CHUNK_SIZE_BYTES,
              totalParts: Math.ceil(fileSize / RESUMABLE_CHUNK_SIZE_BYTES),
            }),
            { status: 200 },
          );
        }
        if (urlStr.includes("/part-url")) {
          const body = JSON.parse(init?.body as string);
          return new Response(
            JSON.stringify({ url: `https://s3.example.com/put-part-${body.partNumber}` }),
            { status: 200 },
          );
        }
        if (urlStr.includes("put-part-")) {
          const chunk = init?.body as Blob;
          uploadedChunkSizes.push(chunk.size);
          return new Response(null, { status: 200, headers: { etag: '"etag-ok"' } });
        }
        if (urlStr.includes("/complete")) {
          return new Response(JSON.stringify({ mediaId: "med-1", status: "uploaded" }), {
            status: 200,
          });
        }
        return new Response(null, { status: 404 });
      });

      const uploader = new ResumableUploader({
        file: fakeBlob,
        fileName: "clip_50mb.mp4",
        fetchFn,
        sleepFn: vi.fn(),
      });

      const res = await uploader.start();
      expect(res.mediaId).toBe("med-1");
      expect(uploadedChunkSizes).toHaveLength(4);
      expect(uploadedChunkSizes[0]).toBe(16 * 1024 * 1024);
      expect(uploadedChunkSizes[1]).toBe(16 * 1024 * 1024);
      expect(uploadedChunkSizes[2]).toBe(16 * 1024 * 1024);
      expect(uploadedChunkSizes[3]).toBe(2 * 1024 * 1024);
    });
  });

  describe("concurrency limiter", () => {
    it("maintains at most 4 parallel uploads simultaneously", async () => {
      const fileSize = 100 * 1024 * 1024; // 7 chunks
      const fakeBlob = {
        size: fileSize,
        type: "video/quicktime",
        slice: (start: number, end: number) => {
          const actualEnd = Math.min(fileSize, end);
          return { size: actualEnd - start, type: "video/quicktime" } as Blob;
        },
      } as unknown as Blob;

      let currentActive = 0;
      let maxActiveObserved = 0;

      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = url.toString();
        if (urlStr.includes("/initiate")) {
          return new Response(
            JSON.stringify({
              sessionId: "sess-2",
              uploadId: "s3-up-2",
              s3Key: "media/test.mov",
              chunkSize: RESUMABLE_CHUNK_SIZE_BYTES,
              totalParts: Math.ceil(fileSize / RESUMABLE_CHUNK_SIZE_BYTES),
            }),
            { status: 200 },
          );
        }
        if (urlStr.includes("/part-url")) {
          const body = JSON.parse(init?.body as string);
          return new Response(
            JSON.stringify({ url: `https://s3.example.com/put-part-${body.partNumber}` }),
            { status: 200 },
          );
        }
        if (urlStr.includes("put-part-")) {
          currentActive++;
          if (currentActive > maxActiveObserved) {
            maxActiveObserved = currentActive;
          }
          await new Promise((r) => setTimeout(r, 10));
          currentActive--;
          return new Response(null, { status: 200, headers: { etag: '"etag-ok"' } });
        }
        if (urlStr.includes("/complete")) {
          return new Response(JSON.stringify({ mediaId: "med-2", status: "uploaded" }), {
            status: 200,
          });
        }
        return new Response(null, { status: 404 });
      });

      const uploader = new ResumableUploader({
        file: fakeBlob,
        fileName: "prores.mov",
        concurrency: 4,
        fetchFn,
        sleepFn: vi.fn(),
      });

      await uploader.start();
      expect(maxActiveObserved).toBeLessThanOrEqual(4);
      expect(maxActiveObserved).toBeGreaterThanOrEqual(1);
    });
  });

  describe("automatic retry with backoff", () => {
    it("retries on 500 error and recovers on subsequent attempt", async () => {
      const fileSize = 16 * 1024 * 1024;
      const fakeBlob = {
        size: fileSize,
        type: "video/mp4",
        slice: (start: number, end: number) => ({ size: end - start, type: "video/mp4" } as Blob),
      } as unknown as Blob;

      let putAttempts = 0;
      const sleepSpy = vi.fn(async () => undefined);

      const fetchFn = vi.fn(async (url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes("/initiate")) {
          return new Response(
            JSON.stringify({
              sessionId: "sess-3",
              uploadId: "s3-up-3",
              s3Key: "media/test.mp4",
              chunkSize: RESUMABLE_CHUNK_SIZE_BYTES,
              totalParts: 1,
            }),
            { status: 200 },
          );
        }
        if (urlStr.includes("/part-url")) {
          return new Response(JSON.stringify({ url: "https://s3.example.com/put-part-1" }), {
            status: 200,
          });
        }
        if (urlStr.includes("put-part-1")) {
          putAttempts++;
          if (putAttempts === 1) {
            return new Response("Internal Server Error", { status: 500 });
          }
          return new Response(null, { status: 200, headers: { etag: '"etag-recovered"' } });
        }
        if (urlStr.includes("/complete")) {
          return new Response(JSON.stringify({ mediaId: "med-3", status: "uploaded" }), {
            status: 200,
          });
        }
        return new Response(null, { status: 404 });
      });

      const uploader = new ResumableUploader({
        file: fakeBlob,
        fileName: "retry_test.mp4",
        fetchFn,
        sleepFn: sleepSpy,
      });

      const res = await uploader.start();
      expect(res.mediaId).toBe("med-3");
      expect(putAttempts).toBe(2);
      expect(sleepSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("IndexedDB resumption", () => {
    it("resumes upload from previously saved session without re-uploading finished chunks", async () => {
      const fileSize = 48 * 1024 * 1024; // 3 parts of 16MB
      const fakeBlob = {
        size: fileSize,
        type: "video/mp4",
        slice: (start: number, end: number) => ({ size: end - start, type: "video/mp4" } as Blob),
      } as unknown as Blob;
      const fileName = "resume_test.mp4";

      // Pre-seed IndexedDB with parts 1 and 2 already uploaded
      const idbStore = new ResumableIdbStore();
      const fileKey = `${fileName}-${fileSize}-0`;

      await idbStore.saveSession({
        id: "sess-preseed",
        fileKey,
        uploadId: "s3-preseed-upload",
        s3Key: "ws/test/media/resume_test.mp4",
        fileName,
        fileSize,
        mimeType: "video/mp4",
        chunkSize: RESUMABLE_CHUNK_SIZE_BYTES,
        totalParts: 3,
        completedParts: [
          { PartNumber: 1, ETag: "etag-part-1" },
          { PartNumber: 2, ETag: "etag-part-2" },
        ],
        status: "uploading",
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 5000,
      });

      const uploadedParts: number[] = [];

      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = url.toString();
        if (urlStr.includes("/part-url")) {
          const body = JSON.parse(init?.body as string);
          return new Response(
            JSON.stringify({ url: `https://s3.example.com/put-part-${body.partNumber}` }),
            { status: 200 },
          );
        }
        if (urlStr.includes("put-part-")) {
          const match = /put-part-(\d+)/.exec(urlStr);
          const partNum = Number(match?.[1]);
          uploadedParts.push(partNum);
          return new Response(null, { status: 200, headers: { etag: `"etag-part-${partNum}"` } });
        }
        if (urlStr.includes("/complete")) {
          const body = JSON.parse(init?.body as string);
          expect(body.parts).toHaveLength(3);
          expect(body.parts[0].ETag).toBe("etag-part-1");
          expect(body.parts[1].ETag).toBe("etag-part-2");
          expect(body.parts[2].ETag).toBe("etag-part-3");
          return new Response(JSON.stringify({ mediaId: "med-resumed", status: "uploaded" }), {
            status: 200,
          });
        }
        return new Response(null, { status: 404 });
      });

      const uploader = new ResumableUploader({
        file: fakeBlob,
        fileName,
        fetchFn,
        sleepFn: vi.fn(),
      });

      const result = await uploader.start();
      expect(result.mediaId).toBe("med-resumed");
      // ONLY part 3 was uploaded across the network! Parts 1 and 2 were recovered from IndexedDB!
      expect(uploadedParts).toEqual([3]);
    });
  });
});

