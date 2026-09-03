import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";

import { createApiClient } from "@montaj/api-client";

import { getUploadRecord, putUploadRecord } from "./store";
import { titleFromFilename, UploadJob } from "./upload-job";

import type { XhrLike } from "./part-upload";
import type { UploadItemState } from "./types";

const BASE = "https://api.test";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function projectJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "01JPROJECT0000000000000AA",
    workspaceId: "01JWORKSPACE000000000000A",
    title: "clip",
    folderId: null,
    clientTag: null,
    sourceLanguage: "hi-Latn",
    scripts: [],
    aspect: "9:16",
    status: "draft",
    thumbnailKey: null,
    durationMs: null,
    mediaCount: 0,
    lastActivityAt: "2026-09-02T00:00:00.000Z",
    retentionUntil: null,
    createdBy: "01JUSER00000000000000000A",
    createdAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function mediaJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "01JMEDIA00000000000000000",
    projectId: "01JPROJECT0000000000000AA",
    role: "primary",
    bucket: "s3",
    storageKey: "ws/x/p/y/media/z/raw.mp4",
    filename: "clip.mp4",
    mime: "video/mp4",
    sizeBytes: 5,
    contentHash: "deadbeef",
    durationMs: null,
    fps: null,
    width: null,
    height: null,
    audioChannels: null,
    status: "pending",
    needsRealign: false,
    uploadedAt: null,
    rawPurgeAt: null,
    derivedPurgeAt: null,
    derived: { proxy: null, audio16k: null, audio48k: null, waveform: null, thumbs: [] },
    createdAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

class FakeXhr implements XhrLike {
  status = 0;
  upload: { onprogress: ((event: { loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private headers: Record<string, string> = {};
  open(): void {
    // no-op
  }
  send(): void {
    // Answer immediately: the test only cares about the orchestration around
    // the part upload, not the transport `part-upload.test.ts` already covers.
    this.status = 200;
    this.headers = { ETag: '"part-etag"' };
    this.onload?.();
  }
  abort(): void {
    this.onabort?.();
  }
  setRequestHeader(): void {
    // no-op
  }
  getResponseHeader(name: string): string | null {
    return this.headers[name] ?? null;
  }
}

function fakeFile(bytes = 5): File {
  return new File([new Uint8Array(bytes)], "holiday-clip.mp4", { type: "video/mp4" });
}

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("aksharo-uploads");
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(request.error ?? new Error("reset failed"));
    };
  });
});

describe("titleFromFilename", () => {
  it("strips the extension and turns separators into spaces", () => {
    expect(titleFromFilename("holiday-clip_final.mp4")).toBe("holiday clip final");
  });
  it("never answers empty", () => {
    expect(titleFromFilename(".mp4")).toBe("Untitled project");
  });
});

describe("UploadJob.run — happy path", () => {
  it("creates a project, uploads the one part, completes, and lands on ready", async () => {
    const calls: string[] = [];
    const fetchMock = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);

      if (method === "POST" && url.pathname === "/projects") {
        return jsonResponse(projectJson(), 201);
      }
      if (method === "POST" && url.pathname === "/projects/01JPROJECT0000000000000AA/media/init") {
        return jsonResponse(
          {
            mediaId: "01JMEDIA00000000000000000",
            uploadId: "upload-1",
            key: "ws/x/raw.mp4",
            bucket: "s3",
            partSizeBytes: 16 * 1024 * 1024,
            parts: [{ partNumber: 1, url: "https://minio.test/part-1" }],
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            duplicate: false,
            media: mediaJson(),
          },
          201,
        );
      }
      if (
        method === "POST" &&
        url.pathname ===
          "/projects/01JPROJECT0000000000000AA/media/01JMEDIA00000000000000000/complete"
      ) {
        return jsonResponse(
          { media: mediaJson({ status: "uploaded" }), probeJobId: "job-1", proxyJobId: null },
          201,
        );
      }
      if (method === "POST" && url.pathname === "/projects/01JPROJECT0000000000000AA/transcribe") {
        // The freshly-uploaded media has not been probed yet in this test, so
        // the real endpoint answers exactly what it answers in production.
        return jsonResponse(
          { error: { code: "transcript/media_not_ready", message: "Media not probed yet." } },
          409,
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url.pathname}`);
    };

    const client = createApiClient({ baseUrl: BASE, fetch: fetchMock as typeof fetch });
    const updates: UploadItemState[] = [];

    const job = new UploadJob({
      client,
      file: fakeFile(),
      quickPick: { language: "hi-Latn", aspect: "9:16" },
      localId: "local-1",
      onUpdate: (state) => {
        updates.push(state);
      },
      hashFileFn: async () => "deadbeef",
      xhrFactory: () => new FakeXhr(),
      setTimeoutFn: (handler) => {
        handler();
        return 0;
      },
    });

    await job.run();

    const finalState = updates.at(-1);
    expect(finalState?.status).toBe("ready"); // transcribe answers media_not_ready -> ready
    expect(finalState?.projectId).toBe("01JPROJECT0000000000000AA");
    expect(finalState?.mediaId).toBe("01JMEDIA00000000000000000");
    expect(calls).toEqual([
      "POST /projects",
      "POST /projects/01JPROJECT0000000000000AA/media/init",
      "POST /projects/01JPROJECT0000000000000AA/media/01JMEDIA00000000000000000/complete",
      "POST /projects/01JPROJECT0000000000000AA/transcribe",
    ]);

    // The record is cleared once the upload settles — nothing left to resume.
    expect(await getUploadRecord("local-1")).toBeUndefined();
  });
});

describe("UploadJob.run — duplicate detection", () => {
  it("removes the just-created project and reports the original", async () => {
    const deleteCalls: string[] = [];
    const fetchMock = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (method === "POST" && url.pathname === "/projects") {
        return jsonResponse(projectJson({ id: "01JNEWPROJECT00000000000A" }), 201);
      }
      if (method === "POST" && url.pathname === "/projects/01JNEWPROJECT00000000000A/media/init") {
        return jsonResponse({
          mediaId: "01JEXISTINGMEDIA000000000",
          uploadId: null,
          key: "ws/x/raw.mp4",
          bucket: "s3",
          partSizeBytes: 0,
          parts: [],
          expiresAt: null,
          duplicate: true,
          media: mediaJson({
            id: "01JEXISTINGMEDIA000000000",
            projectId: "01JORIGINALPROJECT00000AA",
          }),
        });
      }
      if (method === "DELETE" && url.pathname === "/projects/01JNEWPROJECT00000000000A") {
        deleteCalls.push(url.pathname);
        return jsonResponse({ id: "01JNEWPROJECT00000000000A" });
      }
      throw new Error(`unexpected fetch: ${method} ${url.pathname}`);
    };

    const client = createApiClient({ baseUrl: BASE, fetch: fetchMock as typeof fetch });
    const updates: UploadItemState[] = [];
    const job = new UploadJob({
      client,
      file: fakeFile(),
      quickPick: { language: "hi-Latn", aspect: "9:16" },
      localId: "local-dup",
      onUpdate: (state) => {
        updates.push(state);
      },
      hashFileFn: async () => "same-hash-as-existing",
    });

    await job.run();

    expect(deleteCalls).toEqual(["/projects/01JNEWPROJECT00000000000A"]);
    const finalState = updates.at(-1);
    expect(finalState?.status).toBe("duplicate");
    expect(finalState?.duplicateOfProjectId).toBe("01JORIGINALPROJECT00000AA");
    expect(await getUploadRecord("local-dup")).toBeUndefined();
  });
});

describe("UploadJob.resumeFromRecord", () => {
  it("skips create-project and init, and only uploads the remaining part", async () => {
    const calls: string[] = [];
    const fetchMock = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);
      if (
        method === "POST" &&
        url.pathname ===
          "/projects/01JPROJECT0000000000000AA/media/01JMEDIA00000000000000000/complete"
      ) {
        return jsonResponse({ media: mediaJson(), probeJobId: "job-1", proxyJobId: null }, 201);
      }
      if (method === "POST" && url.pathname === "/projects/01JPROJECT0000000000000AA/transcribe") {
        return jsonResponse(
          { error: { code: "transcript/media_not_ready", message: "Media not probed yet." } },
          409,
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url.pathname}`);
    };
    const client = createApiClient({ baseUrl: BASE, fetch: fetchMock as typeof fetch });

    const twoPartFile = new File([new Uint8Array(20)], "clip.mp4", { type: "video/mp4" });
    await putUploadRecord({
      id: "local-resume",
      projectId: "01JPROJECT0000000000000AA",
      fileBytes: await twoPartFile.arrayBuffer(),
      fileName: "clip.mp4",
      fileType: "video/mp4",
      fileSize: 20,
      contentHash: "already-known-hash",
      mediaId: "01JMEDIA00000000000000000",
      uploadId: "upload-1",
      storageKey: "ws/x/raw.mp4",
      bucket: "s3",
      partSizeBytes: 10,
      parts: [
        { partNumber: 1, url: "https://minio.test/part-1" },
        { partNumber: 2, url: "https://minio.test/part-2" },
      ],
      // Part 1 already finished before the simulated reload.
      completedParts: [{ partNumber: 1, etag: '"part-1-etag"' }],
      status: "uploading",
      createdAt: 1,
      updatedAt: 1,
    });

    const record = await getUploadRecord("local-resume");
    const xhrsCreated: FakeXhr[] = [];
    const updates: UploadItemState[] = [];
    const job = new UploadJob({
      client,
      file: twoPartFile,
      quickPick: { language: "hi-Latn", aspect: "9:16" },
      localId: "local-resume",
      onUpdate: (state) => {
        updates.push(state);
      },
      xhrFactory: () => {
        const xhr = new FakeXhr();
        xhrsCreated.push(xhr);
        return xhr;
      },
      setTimeoutFn: (handler) => {
        handler();
        return 0;
      },
    });

    await job.resumeFromRecord(record!);

    // Only the second part was ever PUT — the first was already done.
    expect(xhrsCreated).toHaveLength(1);
    expect(calls).toEqual([
      "POST /projects/01JPROJECT0000000000000AA/media/01JMEDIA00000000000000000/complete",
      "POST /projects/01JPROJECT0000000000000AA/transcribe",
    ]);
    expect(updates.at(-1)?.status).toBe("ready");
  });
});

describe("UploadJob.run — batch (existingProjectId)", () => {
  it("skips POST /projects and uploads straight into the given project (B15)", async () => {
    const calls: string[] = [];
    const fetchMock = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);

      if (method === "POST" && url.pathname === "/projects/01JBATCHPROJECT0000000AA/media/init") {
        return jsonResponse(
          {
            mediaId: "01JMEDIA00000000000000000",
            uploadId: "upload-1",
            key: "ws/x/raw.mp4",
            bucket: "s3",
            partSizeBytes: 16 * 1024 * 1024,
            parts: [{ partNumber: 1, url: "https://minio.test/part-1" }],
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            duplicate: false,
            media: mediaJson({ projectId: "01JBATCHPROJECT0000000AA" }),
          },
          201,
        );
      }
      if (
        method === "POST" &&
        url.pathname ===
          "/projects/01JBATCHPROJECT0000000AA/media/01JMEDIA00000000000000000/complete"
      ) {
        return jsonResponse(
          { media: mediaJson({ status: "uploaded" }), probeJobId: "job-1", proxyJobId: null },
          201,
        );
      }
      if (method === "POST" && url.pathname === "/projects/01JBATCHPROJECT0000000AA/transcribe") {
        return jsonResponse(
          { error: { code: "transcript/media_not_ready", message: "Media not probed yet." } },
          409,
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url.pathname}`);
    };

    const client = createApiClient({ baseUrl: BASE, fetch: fetchMock as typeof fetch });
    const updates: UploadItemState[] = [];

    const job = new UploadJob({
      client,
      file: fakeFile(),
      quickPick: { language: "hi-Latn", aspect: "9:16" },
      localId: "local-batch",
      existingProjectId: "01JBATCHPROJECT0000000AA",
      onUpdate: (state) => {
        updates.push(state);
      },
      hashFileFn: async () => "deadbeef",
      xhrFactory: () => new FakeXhr(),
      setTimeoutFn: (handler) => {
        handler();
        return 0;
      },
    });

    await job.run();

    expect(calls).toEqual([
      "POST /projects/01JBATCHPROJECT0000000AA/media/init",
      "POST /projects/01JBATCHPROJECT0000000AA/media/01JMEDIA00000000000000000/complete",
      "POST /projects/01JBATCHPROJECT0000000AA/transcribe",
    ]);
    expect(updates.at(-1)?.projectId).toBe("01JBATCHPROJECT0000000AA");
    expect(updates.at(-1)?.status).toBe("ready");
  });

  it("does not remove a batch project on a duplicate — only its own would be", async () => {
    const removeCalls: string[] = [];
    const fetchMock = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (method === "DELETE") removeCalls.push(url.pathname);

      if (method === "POST" && url.pathname === "/projects/01JBATCHPROJECT0000000AB/media/init") {
        return jsonResponse({
          mediaId: "01JEXISTINGMEDIA000000000",
          uploadId: null,
          key: "ws/x/raw.mp4",
          bucket: "s3",
          partSizeBytes: 0,
          parts: [],
          expiresAt: null,
          duplicate: true,
          media: mediaJson({ projectId: "01JOTHERPROJECT0000000000" }),
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url.pathname}`);
    };

    const client = createApiClient({ baseUrl: BASE, fetch: fetchMock as typeof fetch });
    const updates: UploadItemState[] = [];

    const job = new UploadJob({
      client,
      file: fakeFile(),
      quickPick: { language: "hi-Latn", aspect: "9:16" },
      localId: "local-batch-dup",
      existingProjectId: "01JBATCHPROJECT0000000AB",
      onUpdate: (state) => {
        updates.push(state);
      },
      hashFileFn: async () => "deadbeef",
    });

    await job.run();

    expect(removeCalls).toHaveLength(0);
    expect(updates.at(-1)?.status).toBe("duplicate");
    expect(updates.at(-1)?.duplicateOfProjectId).toBe("01JOTHERPROJECT0000000000");
  });
});
