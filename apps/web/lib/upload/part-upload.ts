import { backoffDelayMs } from "./backoff";

/**
 * The slice of `XMLHttpRequest` one part upload uses, so a test can hand this
 * a fake in a few lines the way `RealtimeClient` does for `WebSocket`. `fetch`
 * cannot report upload progress (no `body` stream progress event exists for a
 * same-process `Blob` body in any shipping browser), which is why this is XHR
 * rather than `fetch`, and why the interface is this shape instead of that
 * one's.
 */
export interface XhrLike {
  open(method: string, url: string): void;
  send(body: Blob): void;
  abort(): void;
  setRequestHeader(name: string, value: string): void;
  getResponseHeader(name: string): string | null;
  status: number;
  upload: { onprogress: ((event: { loaded: number; total: number }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}

export interface UploadPartInput {
  readonly partNumber: number;
  readonly url: string;
  readonly blob: Blob;
}

export interface UploadPartResult {
  readonly partNumber: number;
  readonly etag: string;
}

export interface UploadPartOptions {
  readonly signal?: AbortSignal;
  readonly maxAttempts?: number;
  readonly onProgress?: (loadedBytes: number) => void;
  readonly xhrFactory?: () => XhrLike;
  readonly setTimeoutFn?: (handler: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  readonly random?: () => number;
}

export class PartUploadError extends Error {
  constructor(
    message: string,
    readonly partNumber: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PartUploadError";
  }
}

/** `PUT` one part straight to the presigned URL, retrying transient failures. */
export async function uploadPart(
  input: UploadPartInput,
  options: UploadPartOptions = {},
): Promise<UploadPartResult> {
  const maxAttempts = options.maxAttempts ?? 5;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted === true) {
      throw new PartUploadError("cancelled", input.partNumber, false);
    }
    try {
      return await putOnce(input, options);
    } catch (error) {
      lastError = error;
      const retryable = !(error instanceof PartUploadError) || error.retryable;
      if (!retryable || attempt === maxAttempts) break;
      await delay(attempt, options);
    }
  }

  throw lastError instanceof PartUploadError
    ? lastError
    : new PartUploadError(
        lastError instanceof Error ? lastError.message : "upload failed",
        input.partNumber,
        true,
      );
}

function delay(attempt: number, options: UploadPartOptions): Promise<void> {
  const ms = backoffDelayMs(attempt, options.random ?? Math.random);
  const schedule = options.setTimeoutFn ?? ((handler, delayMs) => setTimeout(handler, delayMs));
  return new Promise((resolve) => {
    schedule(resolve, ms);
  });
}

function putOnce(input: UploadPartInput, options: UploadPartOptions): Promise<UploadPartResult> {
  return new Promise((resolve, reject) => {
    const factory = options.xhrFactory ?? (() => new XMLHttpRequest() as unknown as XhrLike);
    const xhr = factory();

    const onAbort = (): void => {
      xhr.abort();
    };
    const cleanup = (): void => {
      options.signal?.removeEventListener("abort", onAbort);
    };
    options.signal?.addEventListener("abort", onAbort);

    xhr.open("PUT", input.url);
    xhr.upload.onprogress = (event) => {
      options.onProgress?.(event.loaded);
    };
    xhr.onload = () => {
      cleanup();
      if (xhr.status < 200 || xhr.status >= 300) {
        // A 5xx or a throttling response is worth retrying; a 4xx (the
        // presigned URL expired, the part number is wrong) is not — retrying
        // it five times would just wait longer to report the same failure.
        const retryable = xhr.status >= 500 || xhr.status === 0 || xhr.status === 429;
        reject(
          new PartUploadError(
            `part ${String(input.partNumber)}: HTTP ${String(xhr.status)}`,
            input.partNumber,
            retryable,
          ),
        );
        return;
      }
      const etag = xhr.getResponseHeader("ETag");
      if (etag === null || etag === "") {
        reject(
          new PartUploadError(
            `part ${String(input.partNumber)}: no ETag in the response`,
            input.partNumber,
            true,
          ),
        );
        return;
      }
      resolve({ partNumber: input.partNumber, etag });
    };
    xhr.onerror = () => {
      cleanup();
      reject(
        new PartUploadError(
          `part ${String(input.partNumber)}: network error`,
          input.partNumber,
          true,
        ),
      );
    };
    xhr.onabort = () => {
      cleanup();
      reject(new PartUploadError("cancelled", input.partNumber, false));
    };

    xhr.send(input.blob);
  });
}
