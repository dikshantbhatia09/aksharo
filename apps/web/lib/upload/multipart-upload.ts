import { uploadPart } from "./part-upload";

import type { UploadPartOptions, XhrLike } from "./part-upload";
import type { UploadPartTicket } from "./store";

export interface CompletedPartRecord {
  readonly partNumber: number;
  readonly etag: string;
}

export interface UploadProgressState {
  readonly uploadedBytes: number;
  readonly totalBytes: number;
  readonly completedParts: number;
  readonly totalParts: number;
}

export interface MultipartUploadOptions {
  readonly file: Blob;
  readonly parts: readonly UploadPartTicket[];
  readonly partSizeBytes: number;
  /** 3 in production (the brief); a test drops this to see interleaving. */
  readonly concurrency?: number;
  /** Parts a previous run (or a resumed IndexedDB record) already finished. */
  readonly alreadyCompleted?: readonly CompletedPartRecord[];
  readonly onProgress?: (state: UploadProgressState) => void;
  /** Called as each part settles, so the caller can persist it incrementally. */
  readonly onPartCompleted?: (part: CompletedPartRecord) => void;
  readonly maxAttemptsPerPart?: number;
  readonly xhrFactory?: () => XhrLike;
  readonly setTimeoutFn?: UploadPartOptions["setTimeoutFn"];
  readonly clearTimeoutFn?: UploadPartOptions["clearTimeoutFn"];
  readonly random?: () => number;
}

function partSize(partNumber: number, totalBytes: number, partSizeBytes: number): number {
  const start = (partNumber - 1) * partSizeBytes;
  return Math.max(0, Math.min(partSizeBytes, totalBytes - start));
}

/**
 * Uploads every part of one file, 3 at a time by default, retrying transient
 * failures and reporting aggregate progress across every part in flight —
 * not just the one that most recently ticked.
 *
 * Pause stops new parts from starting and aborts the ones in flight (so a
 * paused upload actually frees the connection rather than idling it); resume
 * picks the queue back up including whatever those aborted parts still owe.
 * Nothing here touches IndexedDB — `upload-manager.ts` persists
 * `onPartCompleted` calls, so this class stays a pure "move these bytes"
 * engine a test can drive without a database.
 */
export class MultipartUpload {
  private readonly completed = new Map<number, string>();
  private readonly partsBytesDone = new Map<number, number>();
  private readonly pendingQueue: number[];
  private cancelled = false;
  private paused = false;
  private resumeWaiters: (() => void)[] = [];
  private activeControllers = new Map<number, AbortController>();

  constructor(private readonly options: MultipartUploadOptions) {
    for (const part of options.alreadyCompleted ?? []) {
      this.completed.set(part.partNumber, part.etag);
    }
    this.pendingQueue = options.parts
      .map((part) => part.partNumber)
      .filter((partNumber) => !this.completed.has(partNumber));
  }

  /** Runs until every part has an ETag, or `cancel()` rejects it. */
  async run(): Promise<CompletedPartRecord[]> {
    const concurrency = Math.max(1, Math.min(this.options.concurrency ?? 3, this.options.parts.length || 1));
    this.emitProgress();

    const workers = Array.from({ length: concurrency }, () => this.worker());
    await Promise.all(workers);

    if (this.cancelled) throw new DOMException("Upload was cancelled.", "AbortError");

    return this.options.parts.map((part) => ({
      partNumber: part.partNumber,
      etag: this.completed.get(part.partNumber) ?? "",
    }));
  }

  pause(): void {
    if (this.paused || this.cancelled) return;
    this.paused = true;
    for (const controller of this.activeControllers.values()) controller.abort();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const wake of waiters) wake();
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.paused = false;
    for (const controller of this.activeControllers.values()) controller.abort();
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const wake of waiters) wake();
  }

  getProgress(): UploadProgressState {
    return this.snapshotProgress();
  }

  private async worker(): Promise<void> {
    for (;;) {
      if (this.cancelled) return;
      if (this.paused) {
        await new Promise<void>((resolve) => {
          this.resumeWaiters.push(resolve);
        });
        continue;
      }
      const partNumber = this.pendingQueue.shift();
      if (partNumber === undefined) return;

      const ticket = this.options.parts.find((part) => part.partNumber === partNumber);
      if (ticket === undefined) continue; // defensive; every queued number came from `parts`

      const blob = this.blobFor(partNumber);
      const controller = new AbortController();
      this.activeControllers.set(partNumber, controller);

      try {
        const result = await uploadPart(
          { partNumber, url: ticket.url, blob },
          {
            signal: controller.signal,
            maxAttempts: this.options.maxAttemptsPerPart ?? 5,
            xhrFactory: this.options.xhrFactory,
            setTimeoutFn: this.options.setTimeoutFn,
            clearTimeoutFn: this.options.clearTimeoutFn,
            random: this.options.random,
            onProgress: (loaded) => {
              this.partsBytesDone.set(partNumber, loaded);
              this.emitProgress();
            },
          },
        );
        this.completed.set(partNumber, result.etag);
        this.partsBytesDone.set(partNumber, blob.size);
        this.emitProgress();
        this.options.onPartCompleted?.(result);
      } catch (error) {
        this.activeControllers.delete(partNumber);
        if (this.cancelled) return;
        if (this.paused) {
          // Aborted by `pause()`, not a real failure: put it back and let the
          // pause/resume gate above hold this worker until `resume()`.
          this.pendingQueue.unshift(partNumber);
          this.partsBytesDone.delete(partNumber);
          continue;
        }
        throw error;
      }
      this.activeControllers.delete(partNumber);
    }
  }

  private blobFor(partNumber: number): Blob {
    const { file, partSizeBytes } = this.options;
    const start = (partNumber - 1) * partSizeBytes;
    const end = start + partSize(partNumber, file.size, partSizeBytes);
    return file.slice(start, end);
  }

  private snapshotProgress(): UploadProgressState {
    const { file } = this.options;
    let uploadedBytes = 0;
    for (const partNumber of this.completed.keys()) {
      uploadedBytes += partSize(partNumber, file.size, this.options.partSizeBytes);
    }
    for (const [partNumber, bytes] of this.partsBytesDone) {
      if (!this.completed.has(partNumber)) uploadedBytes += bytes;
    }
    return {
      uploadedBytes,
      totalBytes: file.size,
      completedParts: this.completed.size,
      totalParts: this.options.parts.length,
    };
  }

  private emitProgress(): void {
    this.options.onProgress?.(this.snapshotProgress());
  }
}
