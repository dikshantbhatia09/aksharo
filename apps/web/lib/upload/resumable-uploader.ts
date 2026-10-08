/**
 * Local Multi-Format Resumable Upload Engine (Up to 10 GB)
 *
 * Implements Pillar 1 §04 Specification:
 * - Direct client-to-storage multipart uploads
 * - Native Blob.slice() into 16 MB chunks
 * - Concurrency pool maintaining 4 parallel streams
 * - On-demand chunk signing so URLs never expire
 * - Automatic retry with exponential jitter (1s, 2s, 4s, 8s) on network drops or 5xx
 * - IndexedDB state persistence for page reload and network recovery resumption
 */

export const RESUMABLE_CHUNK_SIZE_BYTES = 16 * 1024 * 1024; // 16 MB
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_MAX_RETRIES = 4;
export const IDB_DATABASE_NAME = "aksharo-resumable-uploads";
export const IDB_STORE_NAME = "sessions";

export interface CompletedPart {
  readonly PartNumber: number;
  readonly ETag: string;
}

export interface ResumableSessionRecord {
  readonly id: string;
  readonly fileKey: string;
  readonly uploadId: string;
  readonly s3Key: string;
  readonly fileName: string;
  readonly fileSize: number;
  readonly mimeType: string;
  readonly chunkSize: number;
  readonly totalParts: number;
  completedParts: CompletedPart[];
  status: "idle" | "uploading" | "paused" | "completed" | "aborted" | "error";
  readonly createdAt: number;
  updatedAt: number;
}

export interface ResumableProgress {
  readonly uploadedBytes: number;
  readonly totalBytes: number;
  readonly percent: number;
  readonly completedParts: number;
  readonly totalParts: number;
  readonly speedBytesPerSec?: number;
}

export interface ResumableUploaderOptions {
  readonly file: Blob | File;
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly apiBaseUrl?: string; // defaults to /api/v1/media/upload
  readonly getAuthHeaders?: () => Promise<Record<string, string>> | Record<string, string>;
  readonly chunkSize?: number;
  readonly concurrency?: number;
  readonly maxRetries?: number;
  readonly onProgress?: (progress: ResumableProgress) => void;
  readonly onPartComplete?: (part: CompletedPart) => void;
  readonly onComplete?: (result: { mediaId: string; status: string }) => void;
  readonly onError?: (error: Error) => void;
  readonly fetchFn?: typeof fetch;
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly idbFactory?: IDBFactory;
}

function getFileKey(file: Blob | File, name?: string): string {
  const fileObj = file as File;
  const fileName = name ?? fileObj.name ?? "unnamed-media";
  const size = file.size;
  const lastModified = fileObj.lastModified ?? 0;
  return `${fileName}-${size}-${lastModified}`;
}

export class ResumableIdbStore {
  private readonly idb: IDBFactory;

  constructor(idbFactory?: IDBFactory) {
    this.idb =
      idbFactory ??
      (typeof indexedDB !== "undefined"
        ? indexedDB
        : (globalThis as any).indexedDB);
  }

  private openDb(): Promise<IDBDatabase> {
    if (!this.idb) {
      return Promise.reject(new Error("IndexedDB is not supported in this environment"));
    }
    return new Promise((resolve, reject) => {
      const req = this.idb.open(IDB_DATABASE_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
          db.createObjectStore(IDB_STORE_NAME, { keyPath: "fileKey" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB"));
    });
  }

  private async runTransaction<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.openDb();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_NAME, mode);
      const store = tx.objectStore(IDB_STORE_NAME);
      const req = run(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
      tx.oncomplete = () => db.close();
      tx.onabort = () => db.close();
      tx.onerror = () => db.close();
    });
  }

  async getSession(fileKey: string): Promise<ResumableSessionRecord | null> {
    try {
      const res = await this.runTransaction<ResumableSessionRecord | undefined>("readonly", (s) => s.get(fileKey));
      return res ?? null;
    } catch {
      return null;
    }
  }

  async saveSession(record: ResumableSessionRecord): Promise<void> {
    try {
      await this.runTransaction("readwrite", (s) => s.put(record));
    } catch {
      // Best-effort IndexedDB persistence
    }
  }

  async deleteSession(fileKey: string): Promise<void> {
    try {
      await this.runTransaction("readwrite", (s) => s.delete(fileKey));
    } catch {
      // Best-effort
    }
  }
}

export class ResumableUploader {
  private readonly file: Blob | File;
  private readonly fileName: string;
  private readonly mimeType: string;
  private readonly fileKey: string;
  private readonly chunkSize: number;
  private readonly concurrency: number;
  private readonly maxRetries: number;
  private readonly apiBaseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly idbStore: ResumableIdbStore;

  private session: ResumableSessionRecord | null = null;
  private activeControllers = new Map<number, AbortController>();
  private completedPartsMap = new Map<number, string>();
  private isPaused = false;
  private isAborted = false;
  private inFlight = false;

  constructor(private readonly options: ResumableUploaderOptions) {
    this.file = options.file;
    const fileObj = this.file as File;
    this.fileName = options.fileName ?? fileObj.name ?? "unnamed_media";
    this.mimeType = options.mimeType ?? fileObj.type ?? "application/octet-stream";
    this.fileKey = getFileKey(this.file, this.fileName);
    this.chunkSize = options.chunkSize ?? RESUMABLE_CHUNK_SIZE_BYTES;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.apiBaseUrl = (options.apiBaseUrl ?? "/api/v1/media/upload").replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.sleepFn =
      options.sleepFn ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.idbStore = new ResumableIdbStore(options.idbFactory);
  }

  async start(): Promise<{ mediaId: string; status: string }> {
    if (this.inFlight) {
      throw new Error("Upload is already in progress.");
    }
    this.inFlight = true;
    this.isPaused = false;
    this.isAborted = false;

    try {
      // 1. Try restoring session from IndexedDB
      let session = await this.idbStore.getSession(this.fileKey);

      if (!session || session.status === "completed" || session.status === "aborted") {
        // Initialize new session
        const initData = await this.callApi<{
          sessionId: string;
          uploadId: string;
          s3Key: string;
          chunkSize: number;
          totalParts: number;
        }>("/initiate", {
          fileName: this.fileName,
          fileSizeBytes: this.file.size,
          mimeType: this.mimeType,
        });

        session = {
          id: initData.sessionId,
          fileKey: this.fileKey,
          uploadId: initData.uploadId,
          s3Key: initData.s3Key,
          fileName: this.fileName,
          fileSize: this.file.size,
          mimeType: this.mimeType,
          chunkSize: initData.chunkSize,
          totalParts: initData.totalParts,
          completedParts: [],
          status: "uploading",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        await this.idbStore.saveSession(session);
      } else {
        session.status = "uploading";
        session.updatedAt = Date.now();
        await this.idbStore.saveSession(session);
      }

      this.session = session;
      this.completedPartsMap.clear();
      for (const p of session.completedParts) {
        this.completedPartsMap.set(p.PartNumber, p.ETag);
      }

      this.emitProgress();

      // 2. Queue remaining parts
      const pendingParts: number[] = [];
      for (let partNum = 1; partNum <= session.totalParts; partNum++) {
        if (!this.completedPartsMap.has(partNum)) {
          pendingParts.push(partNum);
        }
      }

      // 3. Process queue with concurrency pool
      await this.processQueue(pendingParts);

      if (this.isPaused) {
        throw new Error("Upload paused");
      }
      if (this.isAborted) {
        throw new Error("Upload cancelled");
      }

      // 4. Complete upload on API
      const partsPayload = Array.from(this.completedPartsMap.entries())
        .map(([PartNumber, ETag]) => ({ PartNumber, ETag }))
        .sort((a, b) => a.PartNumber - b.PartNumber);

      const completeRes = await this.callApi<{
        mediaId: string;
        status: string;
      }>("/complete", {
        uploadId: session.uploadId,
        s3Key: session.s3Key,
        parts: partsPayload,
      });

      session.status = "completed";
      session.updatedAt = Date.now();
      await this.idbStore.saveSession(session);
      await this.idbStore.deleteSession(this.fileKey);

      this.options.onComplete?.(completeRes);
      return completeRes;
    } catch (err: any) {
      if (!this.isPaused && !this.isAborted) {
        this.options.onError?.(err);
      }
      throw err;
    } finally {
      this.inFlight = false;
    }
  }

  pause(): void {
    if (!this.inFlight || this.isPaused) return;
    this.isPaused = true;
    for (const ctrl of this.activeControllers.values()) {
      ctrl.abort();
    }
    this.activeControllers.clear();
    if (this.session) {
      this.session.status = "paused";
      this.session.updatedAt = Date.now();
      void this.idbStore.saveSession(this.session);
    }
  }

  resume(): Promise<{ mediaId: string; status: string }> {
    if (this.inFlight) {
      return Promise.reject(new Error("Upload is already active."));
    }
    return this.start();
  }

  async abort(): Promise<void> {
    this.isAborted = true;
    this.isPaused = false;
    for (const ctrl of this.activeControllers.values()) {
      ctrl.abort();
    }
    this.activeControllers.clear();

    if (this.session) {
      try {
        await this.callApi("/abort", {
          uploadId: this.session.uploadId,
          s3Key: this.session.s3Key,
        });
      } catch {
        // ignore abort network errors
      }
      await this.idbStore.deleteSession(this.fileKey);
      this.session.status = "aborted";
    }
  }

  getProgress(): ResumableProgress {
    const totalBytes = this.file.size;
    const totalParts = this.session?.totalParts ?? Math.ceil(totalBytes / this.chunkSize);
    let uploadedBytes = 0;

    for (let part = 1; part <= totalParts; part++) {
      if (this.completedPartsMap.has(part)) {
        const start = (part - 1) * this.chunkSize;
        const size = Math.min(this.chunkSize, totalBytes - start);
        uploadedBytes += size;
      }
    }

    const percent = totalBytes > 0 ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100)) : 0;
    return {
      uploadedBytes,
      totalBytes,
      percent,
      completedParts: this.completedPartsMap.size,
      totalParts,
    };
  }

  private emitProgress(): void {
    this.options.onProgress?.(this.getProgress());
  }

  private sliceChunk(partNumber: number): Blob {
    const start = (partNumber - 1) * this.chunkSize;
    const end = Math.min(this.file.size, start + this.chunkSize);
    return this.file.slice(start, end);
  }

  private async processQueue(pendingParts: number[]): Promise<void> {
    const queue = [...pendingParts];
    const pool = Array.from({ length: this.concurrency }, async () => {
      while (queue.length > 0) {
        if (this.isPaused || this.isAborted) return;
        const partNumber = queue.shift();
        if (partNumber === undefined) break;

        await this.uploadPartWithRetry(partNumber);
      }
    });

    await Promise.all(pool);
  }

  private async uploadPartWithRetry(partNumber: number): Promise<void> {
    let attempt = 0;
    while (attempt <= this.maxRetries) {
      if (this.isPaused || this.isAborted) return;

      const controller = new AbortController();
      this.activeControllers.set(partNumber, controller);

      try {
        // 1. Sign URL on demand
        const { url } = await this.callApi<{ url: string }>("/part-url", {
          uploadId: this.session!.uploadId,
          s3Key: this.session!.s3Key,
          partNumber,
        });

        // 2. PUT chunk
        const chunkBlob = this.sliceChunk(partNumber);
        const res = await this.fetchFn(url, {
          method: "PUT",
          body: chunkBlob,
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error(`Storage returned HTTP ${res.status}`);
        }

        const rawEtag = res.headers.get("etag") ?? `"part-${partNumber}"`;
        const etag = rawEtag.replace(/^"|"$/g, "");

        this.completedPartsMap.set(partNumber, etag);
        this.activeControllers.delete(partNumber);

        // Record in session & persist in IndexedDB
        if (this.session) {
          this.session.completedParts.push({ PartNumber: partNumber, ETag: etag });
          this.session.updatedAt = Date.now();
          await this.idbStore.saveSession(this.session);
        }

        this.options.onPartComplete?.({ PartNumber: partNumber, ETag: etag });
        this.emitProgress();
        return;
      } catch (err: any) {
        this.activeControllers.delete(partNumber);
        if (this.isPaused || this.isAborted || controller.signal.aborted) {
          return;
        }

        attempt++;
        if (attempt > this.maxRetries) {
          throw new Error(
            `Failed to upload part ${partNumber} after ${this.maxRetries} attempts: ${err.message}`,
          );
        }

        // Exponential backoff with jitter: 1s, 2s, 4s, 8s + random(0-500ms)
        const delayMs = Math.pow(2, attempt - 1) * 1000 + Math.random() * 500;
        await this.sleepFn(delayMs);
      }
    }
  }

  private async callApi<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const authHeaders = this.options.getAuthHeaders
      ? await this.options.getAuthHeaders()
      : {};

    const url = `${this.apiBaseUrl}${path}`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`API ${path} failed with ${res.status}: ${errText}`);
    }

    return res.json() as Promise<T>;
  }
}
