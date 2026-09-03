import { describe, expect, it } from "vitest";

import { PartUploadError, uploadPart } from "./part-upload";

import type { XhrLike } from "./part-upload";

class FakeXhr implements XhrLike {
  status = 0;
  upload: { onprogress: ((event: { loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  sentBody: Blob | null = null;
  openedUrl: string | null = null;
  aborted = false;
  private responseHeaders: Record<string, string> = {};

  open(_method: string, url: string): void {
    this.openedUrl = url;
  }

  send(body: Blob): void {
    this.sentBody = body;
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }

  setRequestHeader(): void {
    // unused by the module under test
  }

  getResponseHeader(name: string): string | null {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    return this.responseHeaders[name] ?? null;
  }

  /** Test helper: simulate the server answering. */
  respond(status: number, headers: Record<string, string> = {}): void {
    this.status = status;
    this.responseHeaders = headers;
    this.onload?.();
  }

  fail(): void {
    this.onerror?.();
  }
}

/** A harness with a fake clock, so retry backoff does not make the suite slow. */
function harness() {
  const xhrs: FakeXhr[] = [];
  const timers: { handler: () => void; ms: number }[] = [];
  const factory = (): XhrLike => {
    const xhr = new FakeXhr();
    xhrs.push(xhr);
    return xhr;
  };
  const setTimeoutFn = (handler: () => void, ms: number): unknown => {
    const timer = { handler, ms };
    timers.push(timer);
    return timer;
  };
  const runNextTimer = (): void => {
    const timer = timers.shift();
    timer?.handler();
  };
  return { xhrs, timers, factory, setTimeoutFn, runNextTimer };
}

const PART = { partNumber: 3, url: "https://minio.test/part-3", blob: new Blob(["hello"]) };

describe("uploadPart", () => {
  it("PUTs to the presigned URL and resolves with the ETag", async () => {
    const h = harness();
    const promise = uploadPart(PART, { xhrFactory: h.factory, setTimeoutFn: h.setTimeoutFn });
    h.xhrs[0]?.respond(200, { ETag: '"abc123"' });

    const result = await promise;
    expect(result).toEqual({ partNumber: 3, etag: '"abc123"' });
    expect(h.xhrs[0]?.openedUrl).toBe(PART.url);
    expect(h.xhrs[0]?.sentBody).toBe(PART.blob);
  });

  it("reports upload progress as it happens", async () => {
    const h = harness();
    const seen: number[] = [];
    const promise = uploadPart(PART, {
      xhrFactory: h.factory,
      setTimeoutFn: h.setTimeoutFn,
      onProgress: (loaded) => {
        seen.push(loaded);
      },
    });
    h.xhrs[0]?.upload.onprogress?.({ loaded: 2, total: 5 });
    h.xhrs[0]?.upload.onprogress?.({ loaded: 5, total: 5 });
    h.xhrs[0]?.respond(200, { ETag: '"x"' });
    await promise;

    expect(seen).toEqual([2, 5]);
  });

  it("retries a 500 with backoff and eventually succeeds", async () => {
    const h = harness();
    const promise = uploadPart(PART, { xhrFactory: h.factory, setTimeoutFn: h.setTimeoutFn });

    h.xhrs[0]?.respond(500);
    await Promise.resolve(); // let the retry loop schedule its timer
    expect(h.timers).toHaveLength(1);
    h.runNextTimer();
    await Promise.resolve();

    expect(h.xhrs).toHaveLength(2);
    h.xhrs[1]?.respond(200, { ETag: '"final"' });
    await expect(promise).resolves.toEqual({ partNumber: 3, etag: '"final"' });
  });

  it("does not retry a 403 (an expired presigned URL is not transient)", async () => {
    const h = harness();
    const promise = uploadPart(PART, { xhrFactory: h.factory, setTimeoutFn: h.setTimeoutFn });
    h.xhrs[0]?.respond(403);

    await expect(promise).rejects.toBeInstanceOf(PartUploadError);
    expect(h.xhrs).toHaveLength(1);
  });

  it("gives up after maxAttempts and surfaces a PartUploadError", async () => {
    const h = harness();
    const promise = uploadPart(PART, {
      xhrFactory: h.factory,
      setTimeoutFn: h.setTimeoutFn,
      maxAttempts: 2,
    });

    h.xhrs[0]?.respond(500);
    await Promise.resolve();
    h.runNextTimer();
    await Promise.resolve();
    h.xhrs[1]?.respond(500);

    await expect(promise).rejects.toMatchObject({ partNumber: 3 });
    expect(h.xhrs).toHaveLength(2);
  });

  it("stops immediately when the signal is already aborted", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadPart(PART, { xhrFactory: h.factory, signal: controller.signal }),
    ).rejects.toMatchObject({ retryable: false });
    expect(h.xhrs).toHaveLength(0);
  });

  it("aborts the in-flight request when the signal fires mid-upload", async () => {
    const h = harness();
    const controller = new AbortController();
    const promise = uploadPart(PART, { xhrFactory: h.factory, signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ retryable: false });
    expect(h.xhrs[0]?.aborted).toBe(true);
  });
});
