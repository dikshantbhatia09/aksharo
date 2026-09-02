import { hashBlob, type HashProgress } from "./hash-core";

import type { HashWorkerResponse } from "./hash-worker";

/**
 * Content-hash a file, off the main thread when a Worker is available.
 *
 * `new Worker(new URL(...))` is the pattern Next.js's webpack config resolves
 * to a real worker bundle; it fails to construct in an environment with no
 * `Worker` at all (Vitest's default `node` environment, SSR), which is exactly
 * when the same-thread `hashBlob` fallback belongs — a hash is still produced,
 * just without the off-thread benefit a browser tab gets.
 */
export function hashFile(
  file: Blob,
  onProgress?: (progress: HashProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (typeof Worker === "undefined") {
    return hashBlob(file, onProgress, signal);
  }

  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./hash-worker.ts", import.meta.url), { type: "module" });
    } catch {
      // Some bundlers or restrictive CSPs refuse a module worker; the result is
      // still correct from the main thread.
      hashBlob(file, onProgress, signal).then(resolve, reject);
      return;
    }

    const cleanup = (): void => {
      worker.terminate();
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException("Hashing was cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort);

    worker.onmessage = (event: MessageEvent<HashWorkerResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        onProgress?.({ loadedBytes: message.loadedBytes, totalBytes: message.totalBytes });
        return;
      }
      if (message.type === "done") {
        cleanup();
        resolve(message.hex);
        return;
      }
      cleanup();
      reject(new Error(message.message));
    };
    worker.onerror = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || "Hashing failed."));
    };

    worker.postMessage({ type: "hash", blob: file });
  });
}
