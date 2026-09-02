/**
 * IndexedDB persistence for in-flight uploads.
 *
 * A part upload that survives a reload needs two things back: which parts are
 * already done (so it does not re-send them) and the bytes to slice the
 * remaining ones from. `IDBObjectStore` can hold an `ArrayBuffer` as a
 * structured-cloneable value everywhere this product ships (`Blob` itself
 * clones through most browsers' real IndexedDB too, but not reliably through
 * every fake used in tests, and an `ArrayBuffer` has no such gap), so the
 * record below stores the original file's bytes next to its progress rather
 * than asking the person to re-pick it after a crash or an accidental tab
 * close.
 *
 * One database, one object store, keyed by a client-generated `id` — assigned
 * before `POST .../media/init` even runs, so a file dropped seconds before a
 * crash is still resumable even though it never got a `mediaId`.
 */

const DB_NAME = "aksharo-uploads";
const DB_VERSION = 1;
const STORE_NAME = "uploads";

export type UploadRecordStatus =
  | "pending"
  | "hashing"
  | "uploading"
  | "paused"
  | "completing"
  | "done"
  | "error"
  | "cancelled";

export interface CompletedPartRecord {
  readonly partNumber: number;
  readonly etag: string;
}

export interface UploadPartTicket {
  readonly partNumber: number;
  readonly url: string;
}

export interface PersistedUploadRecord {
  /** Client-generated ULID, assigned before anything else — the resume key. */
  readonly id: string;
  readonly projectId: string;
  /** The original bytes, so a resumed upload can re-slice any part. */
  readonly fileBytes: ArrayBuffer;
  readonly fileName: string;
  readonly fileType: string;
  readonly fileSize: number;
  contentHash?: string;
  mediaId?: string;
  uploadId?: string | null;
  storageKey?: string;
  bucket?: "s3" | "r2";
  partSizeBytes?: number;
  parts?: readonly UploadPartTicket[];
  completedParts: readonly CompletedPartRecord[];
  status: UploadRecordStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("could not open the upload database"));
    };
  });
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        const request = run(store);
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(request.error ?? new Error("upload database request failed"));
        };
        tx.oncomplete = () => {
          db.close();
        };
      }),
  );
}

export async function putUploadRecord(record: PersistedUploadRecord): Promise<void> {
  await runTransaction("readwrite", (store) => store.put(record));
}

export async function getUploadRecord(id: string): Promise<PersistedUploadRecord | undefined> {
  return runTransaction("readonly", (store) => store.get(id));
}

/** Every record, newest first — the upload tray reads this after a reload. */
export async function listUploadRecords(): Promise<PersistedUploadRecord[]> {
  const all = await runTransaction<PersistedUploadRecord[]>("readonly", (store) =>
    store.getAll(),
  );
  return [...all].sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteUploadRecord(id: string): Promise<void> {
  await runTransaction("readwrite", (store) => store.delete(id));
}

/** Records not in a settled state — what to offer resuming after a reload. */
export async function listResumableUploads(): Promise<PersistedUploadRecord[]> {
  const all = await listUploadRecords();
  return all.filter(
    (record) =>
      record.status !== "done" && record.status !== "cancelled" && record.status !== "error",
  );
}

/** A `Blob` view over a record's bytes, for slicing parts or re-hashing. */
export function blobFromRecord(record: PersistedUploadRecord): Blob {
  return new Blob([record.fileBytes], { type: record.fileType });
}
