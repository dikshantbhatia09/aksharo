import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  brandAssetKey,
  contentTypeFor,
  createObjectStore,
  exportKey,
  mediaPrefix,
  rawKey,
  StorageError,
  subtitleKey,
} from "./storage.js";
import { createDirectoryStore, FIXTURE_IDS, removeQuietly } from "./testing.js";

const WS = FIXTURE_IDS.workspaceId;
const PROJECT = FIXTURE_IDS.projectId;
const MEDIA = FIXTURE_IDS.mediaId;
const EXPORT = FIXTURE_IDS.exportId;

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "a20-storage-"));
});

afterAll(async () => {
  await removeQuietly(scratch);
});

describe("the CONTRACTS §6 keys", () => {
  it("builds the media prefix", () => {
    expect(mediaPrefix(WS, PROJECT, MEDIA)).toBe(`ws/${WS}/p/${PROJECT}/media/${MEDIA}`);
  });

  it("builds a raw key", () => {
    expect(rawKey(WS, PROJECT, MEDIA, "MP4")).toBe(`ws/${WS}/p/${PROJECT}/media/${MEDIA}/raw.mp4`);
    expect(rawKey(WS, PROJECT, MEDIA, ".mov").endsWith("raw.mov")).toBe(true);
  });

  it("builds an export key", () => {
    expect(exportKey(WS, PROJECT, EXPORT, "mp4")).toBe(
      `ws/${WS}/p/${PROJECT}/exports/${EXPORT}.mp4`,
    );
  });

  it("keeps a sidecar under the same export prefix", () => {
    // Several files come out of one subtitle job, and the contract gives an
    // export one key; the script goes before the extension so a prefix match
    // still finds every artefact of the export.
    expect(subtitleKey(WS, PROJECT, EXPORT, "roman", "srt")).toBe(
      `ws/${WS}/p/${PROJECT}/exports/${EXPORT}.roman.srt`,
    );
    expect(
      subtitleKey(WS, PROJECT, EXPORT, "native", "vtt").startsWith(
        `ws/${WS}/p/${PROJECT}/exports/${EXPORT}.`,
      ),
    ).toBe(true);
  });

  it("builds a brand-asset key inside the workspace's own prefix", () => {
    expect(brandAssetKey(WS, "aksharo-mark")).toBe(`ws/${WS}/brand/aksharo-mark.png`);
  });

  it("refuses an id that is not a ULID, because a key is a path", () => {
    // `../` in an id would be a way out of the workspace's own prefix.
    expect(() => rawKey("../other", PROJECT, MEDIA, "mp4")).toThrow(StorageError);
    expect(() => exportKey(WS, PROJECT, "not-a-ulid", "mp4")).toThrow(/not a ULID/);
    expect(() => brandAssetKey("nope", "mark")).toThrow(StorageError);
  });

  it("refuses an extension that is not one", () => {
    expect(() => rawKey(WS, PROJECT, MEDIA, "mp4/../..")).toThrow(/not a usable extension/);
    expect(() => rawKey(WS, PROJECT, MEDIA, "")).toThrow(StorageError);
  });

  it("refuses a script tag that is not one", () => {
    expect(() => subtitleKey(WS, PROJECT, EXPORT, "../etc", "srt")).toThrow(/not a script tag/);
  });

  it("refuses an asset id with a path in it", () => {
    expect(() => brandAssetKey(WS, "../../secret")).toThrow(/not an asset id/);
  });
});

describe("content types", () => {
  it("knows the artefacts this service writes", () => {
    expect(contentTypeFor("mp4")).toBe("video/mp4");
    expect(contentTypeFor("MOV")).toBe("video/quicktime");
    expect(contentTypeFor("webm")).toBe("video/webm");
    expect(contentTypeFor("srt")).toBe("application/x-subrip");
    expect(contentTypeFor("vtt")).toBe("text/vtt");
    expect(contentTypeFor("unknown")).toBe("application/octet-stream");
  });
});

describe("the object store", () => {
  it("refuses to be built without an endpoint or a bucket", async () => {
    await expect(
      createObjectStore({
        endpoint: "",
        region: "ap-south-1",
        bucket: "b",
        accessKey: "k",
        secretKey: "s",
      }),
    ).rejects.toThrow(StorageError);
    await expect(
      createObjectStore({
        endpoint: "http://localhost:9000",
        region: "ap-south-1",
        bucket: "",
        accessKey: "k",
        secretKey: "s",
      }),
    ).rejects.toThrow(/not configured/);
  });

  it("builds a client for an S3-compatible endpoint", async () => {
    const store = await createObjectStore({
      endpoint: "http://localhost:9000",
      region: "ap-south-1",
      bucket: "montaj-derived",
      accessKey: "key",
      secretKey: "secret",
    });
    expect(store.bucket).toBe("montaj-derived");
  });
});

describe("the directory-backed store used by the tests", () => {
  it("round-trips bytes and files, and records what it wrote", async () => {
    const store = createDirectoryStore(join(scratch, "store"));
    const source = join(scratch, "input.txt");
    await writeFile(source, "hello");

    await store.seedBytes("a/b.txt", new Uint8Array([1, 2, 3]));
    expect(Array.from(await store.getBytes("a/b.txt"))).toEqual([1, 2, 3]);

    const size = await store.upload("a/c.txt", source, { contentType: "text/plain" });
    expect(size).toBe(5);
    expect(store.written).toEqual([{ key: "a/c.txt", sizeBytes: 5 }]);

    const destination = join(scratch, "out.txt");
    await store.download("a/c.txt", destination);
    expect(await readFile(destination, "utf8")).toBe("hello");

    await store.putBytes("a/d.bin", new Uint8Array([9]));
    expect((await store.read("a/d.bin")).byteLength).toBe(1);
  });
});
