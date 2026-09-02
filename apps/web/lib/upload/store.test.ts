// `fake-indexeddb/auto` patches `globalThis.indexedDB` with a real, in-memory
// implementation of the spec — not a mock of `store.ts`'s own calls, so this
// suite proves records genuinely round-trip through IndexedDB, resume logic
// included, the same way a reloaded tab would read them back.
import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";

import {
  blobFromRecord,
  deleteUploadRecord,
  getUploadRecord,
  listResumableUploads,
  listUploadRecords,
  putUploadRecord,
  type PersistedUploadRecord,
} from "./store";

function record(overrides: Partial<PersistedUploadRecord> = {}): PersistedUploadRecord {
  const now = Date.now();
  const bytes = new Uint8Array(10).map((_, i) => i);
  return {
    id: "01JUPLOAD00000000000000AA",
    projectId: "01JPROJECT0000000000000AA",
    fileBytes: bytes.buffer,
    fileName: "clip.mp4",
    fileType: "video/mp4",
    fileSize: 10,
    completedParts: [],
    status: "pending",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** `store.ts`'s own database name — dropped after every test for isolation. */
const DB_NAME = "aksharo-uploads";

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(request.error ?? new Error("could not reset the fake database"));
    };
  });
});

describe("putUploadRecord / getUploadRecord", () => {
  it("round-trips a record, file bytes included", async () => {
    const original = record();
    await putUploadRecord(original);
    const fetched = await getUploadRecord(original.id);

    expect(fetched?.id).toBe(original.id);
    expect(fetched?.fileName).toBe("clip.mp4");
    expect(fetched?.fileBytes.byteLength).toBe(10);
    expect(new Uint8Array(fetched?.fileBytes ?? new ArrayBuffer(0))).toEqual(
      new Uint8Array(original.fileBytes),
    );

    const blob = blobFromRecord(fetched as PersistedUploadRecord);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(10);
  });

  it("answers undefined for a record that was never written", async () => {
    expect(await getUploadRecord("nope")).toBeUndefined();
  });

  it("a second put with the same id overwrites, not duplicates", async () => {
    const original = record();
    await putUploadRecord(original);
    await putUploadRecord({ ...original, status: "uploading", updatedAt: Date.now() + 1 });

    const all = await listUploadRecords();
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("uploading");
  });
});

describe("listUploadRecords", () => {
  it("orders newest first", async () => {
    await putUploadRecord(record({ id: "a", createdAt: 1_000 }));
    await putUploadRecord(record({ id: "b", createdAt: 3_000 }));
    await putUploadRecord(record({ id: "c", createdAt: 2_000 }));

    const all = await listUploadRecords();
    expect(all.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });
});

describe("listResumableUploads", () => {
  it("excludes settled uploads (done, cancelled, error)", async () => {
    await putUploadRecord(record({ id: "live", status: "uploading" }));
    await putUploadRecord(record({ id: "paused", status: "paused" }));
    await putUploadRecord(record({ id: "finished", status: "done" }));
    await putUploadRecord(record({ id: "gave-up", status: "cancelled" }));
    await putUploadRecord(record({ id: "failed", status: "error" }));

    const resumable = await listResumableUploads();
    expect(resumable.map((r) => r.id).sort()).toEqual(["live", "paused"]);
  });

  it("carries completed parts, which is the whole point of resuming", async () => {
    await putUploadRecord(
      record({
        id: "partial",
        status: "paused",
        completedParts: [
          { partNumber: 1, etag: '"etag-1"' },
          { partNumber: 2, etag: '"etag-2"' },
        ],
      }),
    );

    const [resumed] = await listResumableUploads();
    expect(resumed?.completedParts).toEqual([
      { partNumber: 1, etag: '"etag-1"' },
      { partNumber: 2, etag: '"etag-2"' },
    ]);
  });
});

describe("deleteUploadRecord", () => {
  it("removes it", async () => {
    await putUploadRecord(record());
    await deleteUploadRecord("01JUPLOAD00000000000000AA");
    expect(await listUploadRecords()).toEqual([]);
  });

  it("deleting something absent is not an error", async () => {
    await expect(deleteUploadRecord("never-existed")).resolves.toBeUndefined();
  });
});
