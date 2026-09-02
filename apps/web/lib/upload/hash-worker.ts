/**
 * The Web Worker entry point for content-hashing an upload off the main
 * thread — hashing a multi-gigabyte file with `hashBlob` (streaming, but still
 * CPU-bound JS) would otherwise stall drag feedback and the rest of the page
 * for the seconds to low-minutes it takes.
 *
 * Protocol (`postMessage`, one worker per hash):
 *   in  → `{ type: "hash", blob: Blob }`
 *   out → `{ type: "progress", loadedBytes, totalBytes }` zero or more times
 *   out → `{ type: "done", hex: string }` or `{ type: "error", message: string }`
 *
 * A `Blob` (not a `File`) travels across `postMessage` by structured clone —
 * cheap, since the browser clones a handle to the bytes, not the bytes
 * themselves. There is nothing to cancel here: `hash-client.ts` cancels a hash
 * by terminating the whole worker, which is instant and needs no protocol.
 */
import { hashBlob } from "./hash-core";

export interface HashWorkerRequest {
  readonly type: "hash";
  readonly blob: Blob;
}

export type HashWorkerResponse =
  | { readonly type: "progress"; readonly loadedBytes: number; readonly totalBytes: number }
  | { readonly type: "done"; readonly hex: string }
  | { readonly type: "error"; readonly message: string };

self.onmessage = (event: MessageEvent<HashWorkerRequest>) => {
  if (event.data.type !== "hash") return;
  const { blob } = event.data;

  hashBlob(blob, (progress) => {
    self.postMessage({
      type: "progress",
      loadedBytes: progress.loadedBytes,
      totalBytes: progress.totalBytes,
    } satisfies HashWorkerResponse);
  })
    .then((hex) => {
      self.postMessage({ type: "done", hex } satisfies HashWorkerResponse);
    })
    .catch((error: unknown) => {
      self.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : "Hashing failed.",
      } satisfies HashWorkerResponse);
    });
};
