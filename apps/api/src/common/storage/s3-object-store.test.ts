import { beforeEach, describe, expect, it, vi } from "vitest";

import { MULTIPART_PART_SIZE_BYTES, partCountFor } from "./object-store.js";
import { encodeTags, ObjectStoreError, S3ObjectStore } from "./s3-object-store.js";

/**
 * The store, against a stubbed `send`.
 *
 * Presigning is NOT stubbed: `getSignedUrl` runs the real SigV4 signer over the
 * real client configuration, which needs no network and is the part most worth
 * exercising — a presigned URL that a browser cannot use is the failure mode this
 * whole path has.
 */
function makeStore(overrides: Partial<Record<string, unknown>> = {}) {
  const store = new S3ObjectStore({
    kind: "s3",
    bucket: "montaj-raw",
    endpoint: "http://localhost:9000",
    region: "ap-south-1",
    accessKeyId: "test-key",
    secretAccessKey: "test-secret",
    ...overrides,
  });
  const send = vi.fn();
  (store as unknown as { client: { send: unknown } }).client.send = send;
  return { store, send };
}

describe("partCountFor", () => {
  it("splits on the 16 MiB part size", () => {
    expect(partCountFor(1)).toBe(1);
    expect(partCountFor(MULTIPART_PART_SIZE_BYTES)).toBe(1);
    expect(partCountFor(MULTIPART_PART_SIZE_BYTES + 1)).toBe(2);
    expect(partCountFor(MULTIPART_PART_SIZE_BYTES * 3)).toBe(3);
  });

  it("never returns zero parts", () => {
    expect(partCountFor(0)).toBe(1);
    expect(partCountFor(Number.NaN)).toBe(1);
  });
});

describe("encodeTags", () => {
  it("URL-encodes into the x-amz-tagging shape", () => {
    expect(encodeTags({ montaj: "raw", "a key": "a/value" })).toBe("montaj=raw&a%20key=a%2Fvalue");
  });
});

describe("createMultipartUpload", () => {
  let harness: ReturnType<typeof makeStore>;

  beforeEach(() => {
    harness = makeStore();
  });

  it("opens the upload and signs one URL per part", async () => {
    harness.send.mockResolvedValueOnce({ UploadId: "upload-1" });
    const upload = await harness.store.createMultipartUpload({
      key: "ws/a/raw.mp4",
      sizeBytes: MULTIPART_PART_SIZE_BYTES * 2 + 10,
      contentType: "video/mp4",
      tags: { montaj: "raw" },
    });

    expect(upload.uploadId).toBe("upload-1");
    expect(upload.partSizeBytes).toBe(MULTIPART_PART_SIZE_BYTES);
    expect(upload.parts.map((part) => part.partNumber)).toEqual([1, 2, 3]);
    expect(new Date(upload.expiresAt).getTime()).toBeGreaterThan(Date.now());

    for (const part of upload.parts) {
      const url = new URL(part.url);
      expect(url.pathname).toBe("/montaj-raw/ws/a/raw.mp4");
      expect(url.searchParams.get("partNumber")).toBe(String(part.partNumber));
      expect(url.searchParams.get("uploadId")).toBe("upload-1");
      // SigV4, and no checksum header in the signature: a browser cannot send one.
      expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
      expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    }
  });

  it("refuses a size that would need more parts than S3 allows", async () => {
    const { store } = makeStore({ partSizeBytes: 1 });
    await expect(
      store.createMultipartUpload({ key: "k", sizeBytes: 20_000 }),
    ).rejects.toBeInstanceOf(ObjectStoreError);
  });

  it("fails loudly when the store returns no upload id", async () => {
    harness.send.mockResolvedValueOnce({});
    await expect(
      harness.store.createMultipartUpload({ key: "k", sizeBytes: 10 }),
    ).rejects.toBeInstanceOf(ObjectStoreError);
  });
});

describe("completeMultipartUpload", () => {
  it("sends the parts in ascending part order whatever order it was given", async () => {
    const { store, send } = makeStore();
    send.mockResolvedValueOnce({ ETag: '"final"' });

    const result = await store.completeMultipartUpload("k", "u", [
      { partNumber: 3, etag: '"c"' },
      { partNumber: 1, etag: '"a"' },
      { partNumber: 2, etag: '"b"' },
    ]);

    expect(result.etag).toBe('"final"');
    const command = send.mock.calls[0]?.[0] as { input: { MultipartUpload: { Parts: unknown[] } } };
    expect(command.input.MultipartUpload.Parts).toEqual([
      { PartNumber: 1, ETag: '"a"' },
      { PartNumber: 2, ETag: '"b"' },
      { PartNumber: 3, ETag: '"c"' },
    ]);
  });
});

describe("abortMultipartUpload", () => {
  it("swallows a failure: an upload already gone is the state we wanted", async () => {
    const { store, send } = makeStore();
    send.mockRejectedValueOnce(new Error("NoSuchUpload"));
    await expect(store.abortMultipartUpload("k", "u")).resolves.toBeUndefined();
  });
});

describe("head", () => {
  it("maps the response onto the port's shape", async () => {
    const { store, send } = makeStore();
    const lastModified = new Date("2026-09-02T00:00:00.000Z");
    send.mockResolvedValueOnce({
      ContentLength: 1234,
      ContentType: "video/mp4",
      ETag: '"abc"',
      LastModified: lastModified,
    });
    await expect(store.head("k")).resolves.toEqual({
      sizeBytes: 1234,
      contentType: "video/mp4",
      etag: '"abc"',
      lastModified,
    });
  });

  it("answers null for a missing object rather than throwing", async () => {
    const { store, send } = makeStore();
    send.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotFound" }));
    await expect(store.head("k")).resolves.toBeNull();

    send.mockRejectedValueOnce(
      Object.assign(new Error("x"), { $metadata: { httpStatusCode: 404 } }),
    );
    await expect(store.head("k")).resolves.toBeNull();
  });

  it("still throws on a real failure", async () => {
    const { store, send } = makeStore();
    send.mockRejectedValueOnce(Object.assign(new Error("boom"), { name: "InternalError" }));
    await expect(store.head("k")).rejects.toBeInstanceOf(ObjectStoreError);
  });
});

describe("presigned GET", () => {
  it("signs a short-lived URL and can attach a download filename", async () => {
    const { store } = makeStore();
    const plain = await store.presignGet("ws/a/proxy540.mp4", 300);
    expect(new URL(plain).searchParams.get("X-Amz-Expires")).toBe("300");

    const named = await store.presignGet("ws/a/proxy540.mp4", 300, {
      downloadFilename: 'my "clip"; rm -rf.mp4',
    });
    const disposition = new URL(named).searchParams.get("response-content-disposition");
    expect(disposition).toContain("attachment");
    // Quotes and shell characters are replaced, so the header cannot be broken out of.
    expect(disposition).not.toContain(String.fromCharCode(34) + "clip");
  });

  it("signs a single-shot PUT for small objects", async () => {
    const { store } = makeStore();
    const url = await store.presignPut("ws/a/small.json", 60, "application/json");
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("60");
  });
});

describe("get / put / delete", () => {
  it("reads a body through transformToByteArray", async () => {
    const { store, send } = makeStore();
    send.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => new TextEncoder().encode("hello") },
    });
    await expect(store.get("k")).resolves.toEqual(Buffer.from("hello"));
  });

  it("raises when the response carries no body", async () => {
    const { store, send } = makeStore();
    send.mockResolvedValueOnce({});
    await expect(store.get("k")).rejects.toBeInstanceOf(ObjectStoreError);
  });

  it("writes a string body as UTF-8 with its tags", async () => {
    const { store, send } = makeStore();
    send.mockResolvedValueOnce({});
    await store.put({
      key: "k",
      body: "नमस्ते",
      contentType: "application/json",
      tags: { montaj: "derived" },
    });
    const command = send.mock.calls[0]?.[0] as {
      input: { Body: Buffer; Tagging: string; ContentType: string };
    };
    expect(command.input.Body.toString("utf8")).toBe("नमस्ते");
    expect(command.input.Tagging).toBe("montaj=derived");
  });

  it("batches deletes and reports how many went", async () => {
    const { store, send } = makeStore();
    send.mockResolvedValueOnce({ Errors: [{ Key: "b" }] });
    await expect(store.deleteMany(["a", "b", "c"])).resolves.toBe(2);
    await expect(store.deleteMany([])).resolves.toBe(0);
  });

  it("replaces an object's tag set", async () => {
    const { store, send } = makeStore();
    send.mockResolvedValueOnce({});
    await store.tag("k", { montaj: "raw" });
    const command = send.mock.calls[0]?.[0] as { input: { Tagging: { TagSet: unknown[] } } };
    expect(command.input.Tagging.TagSet).toEqual([{ Key: "montaj", Value: "raw" }]);
  });
});
