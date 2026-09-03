import { describe, expect, it } from "vitest";

import { MultipartUpload } from "./multipart-upload";

/**
 * Let every pending microtask (and, via the real `setTimeout`, anything
 * scheduled off one) run before the test looks at state again. A fixed count
 * of `await Promise.resolve()` is fragile here: `MultipartUpload`'s
 * pause/resume path chains a rejection through `uploadPart`'s retry loop and
 * then through the worker's own `catch`, and exactly how many microtask ticks
 * that takes is an implementation detail this suite should not have to track.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

import type { XhrLike } from "./part-upload";
import type { UploadPartTicket } from "./store";

class FakeXhr implements XhrLike {
  status = 0;
  upload: { onprogress: ((event: { loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  aborted = false;
  url = "";
  body: Blob | null = null;
  private headers: Record<string, string> = {};

  open(_method: string, url: string): void {
    this.url = url;
  }

  send(body: Blob): void {
    this.body = body;
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }

  setRequestHeader(): void {
    // unused
  }

  getResponseHeader(name: string): string | null {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    return this.headers[name] ?? null;
  }

  respond(status: number, headers: Record<string, string> = {}): void {
    this.status = status;
    this.headers = headers;
    this.onload?.();
  }
}

const PART_SIZE = 10;
const FILE_SIZE = PART_SIZE * 3; // three full parts, three workers can run flat out

function makeParts(): UploadPartTicket[] {
  return [1, 2, 3].map((partNumber) => ({
    partNumber,
    url: `https://minio.test/part-${String(partNumber)}`,
  }));
}

function harness(overrides: { concurrency?: number } = {}) {
  const xhrs: FakeXhr[] = [];
  const factory = (): XhrLike => {
    const xhr = new FakeXhr();
    xhrs.push(xhr);
    return xhr;
  };
  const file = new Blob([new Uint8Array(FILE_SIZE)]);
  const progressUpdates: { uploadedBytes: number; completedParts: number }[] = [];
  const completedCalls: number[] = [];

  const upload = new MultipartUpload({
    file,
    parts: makeParts(),
    partSizeBytes: PART_SIZE,
    concurrency: overrides.concurrency ?? 3,
    xhrFactory: factory,
    setTimeoutFn: (handler) => {
      handler();
      return 0;
    },
    onProgress: (state) => {
      progressUpdates.push({
        uploadedBytes: state.uploadedBytes,
        completedParts: state.completedParts,
      });
    },
    onPartCompleted: (part) => {
      completedCalls.push(part.partNumber);
    },
  });

  return { upload, xhrs, progressUpdates, completedCalls, file };
}

function etagFor(n: number): string {
  return `"etag-${String(n)}"`;
}

describe("MultipartUpload", () => {
  it("uploads every part and resolves with their ETags in part order", async () => {
    const h = harness();
    const promise = h.upload.run();

    expect(h.xhrs).toHaveLength(3);
    h.xhrs[0]?.respond(200, { ETag: etagFor(1) });
    h.xhrs[1]?.respond(200, { ETag: etagFor(2) });
    h.xhrs[2]?.respond(200, { ETag: etagFor(3) });

    await expect(promise).resolves.toEqual([
      { partNumber: 1, etag: etagFor(1) },
      { partNumber: 2, etag: etagFor(2) },
      { partNumber: 3, etag: etagFor(3) },
    ]);
    expect(h.completedCalls.sort()).toEqual([1, 2, 3]);
  });

  it("PUTs each part's correctly-sliced bytes", async () => {
    const h = harness();
    void h.upload.run();
    expect(h.xhrs[0]?.body?.size).toBe(PART_SIZE);
    expect(h.xhrs[1]?.url).toBe("https://minio.test/part-2");
  });

  it("caps concurrency: only `concurrency` parts run at once", async () => {
    const h = harness({ concurrency: 1 });
    const promise = h.upload.run();

    expect(h.xhrs).toHaveLength(1);
    h.xhrs[0]?.respond(200, { ETag: etagFor(1) });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.xhrs).toHaveLength(2);

    h.xhrs[1]?.respond(200, { ETag: etagFor(2) });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.xhrs).toHaveLength(3);

    h.xhrs[2]?.respond(200, { ETag: etagFor(3) });
    await expect(promise).resolves.toHaveLength(3);
  });

  it("skips parts already completed (resuming from IndexedDB)", async () => {
    const file = new Blob([new Uint8Array(FILE_SIZE)]);
    const xhrs: FakeXhr[] = [];
    const upload = new MultipartUpload({
      file,
      parts: makeParts(),
      partSizeBytes: PART_SIZE,
      alreadyCompleted: [{ partNumber: 1, etag: etagFor(1) }],
      xhrFactory: () => {
        const xhr = new FakeXhr();
        xhrs.push(xhr);
        return xhr;
      },
      setTimeoutFn: (handler) => {
        handler();
        return 0;
      },
    });

    const promise = upload.run();
    // Only parts 2 and 3 are ever asked for.
    expect(xhrs).toHaveLength(2);
    xhrs[0]?.respond(200, { ETag: etagFor(2) });
    xhrs[1]?.respond(200, { ETag: etagFor(3) });

    await expect(promise).resolves.toEqual([
      { partNumber: 1, etag: etagFor(1) },
      { partNumber: 2, etag: etagFor(2) },
      { partNumber: 3, etag: etagFor(3) },
    ]);
  });

  it("reports aggregate progress across parts still in flight", async () => {
    const h = harness();
    void h.upload.run();

    h.xhrs[0]?.upload.onprogress?.({ loaded: 4, total: PART_SIZE });
    h.xhrs[1]?.upload.onprogress?.({ loaded: 6, total: PART_SIZE });
    expect(h.upload.getProgress().uploadedBytes).toBe(10); // 4 + 6, part 3 untouched

    h.xhrs[0]?.respond(200, { ETag: etagFor(1) });
    await flush();
    expect(h.upload.getProgress().uploadedBytes).toBe(16); // 10 (part 1, full) + 6 (part 2, partial)
  });

  it("pause aborts in-flight parts and stops new ones from starting", async () => {
    const h = harness({ concurrency: 1 });
    void h.upload.run();
    expect(h.xhrs).toHaveLength(1);

    h.upload.pause();
    expect(h.xhrs[0]?.aborted).toBe(true);
    await flush();
    // No second XHR while paused.
    expect(h.xhrs).toHaveLength(1);
  });

  it("resume continues the queue, including the part pause interrupted", async () => {
    const h = harness({ concurrency: 1 });
    const promise = h.upload.run();
    h.upload.pause();
    await flush();

    h.upload.resume();
    await flush();
    expect(h.xhrs.length).toBeGreaterThanOrEqual(2);
    // Part 1 was aborted mid-flight and goes back to the front of the queue;
    // whichever xhr is now the newest is its retry.
    h.xhrs.at(-1)?.respond(200, { ETag: etagFor(1) });
    await flush();
    h.xhrs.at(-1)?.respond(200, { ETag: etagFor(2) });
    await flush();
    h.xhrs.at(-1)?.respond(200, { ETag: etagFor(3) });

    await expect(promise).resolves.toHaveLength(3);
  });

  it("cancel rejects the run with an AbortError", async () => {
    const h = harness({ concurrency: 1 });
    const promise = h.upload.run();
    h.upload.cancel();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});
