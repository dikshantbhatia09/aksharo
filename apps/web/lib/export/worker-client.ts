/**
 * Main-thread wrapper around `engine.worker.ts`.
 *
 * Known limitation (see `engine.worker.ts`'s header): `showSaveFilePicker` is
 * not available inside a dedicated worker, so a run dispatched through this
 * client always uses the in-memory sink even when the browser supports File
 * System Access. Transferring a pre-obtained `FileSystemFileHandle` into the
 * worker (`handle` is structured-cloneable across `postMessage`) is the fix;
 * not implemented in this pass — reported as an open question.
 */

import { ExportCancelledError, type EngineProgress, type EngineResult } from "./types";

import type { RunExportOptions } from "./engine";
import type { WorkerRequest, WorkerRunOptions } from "./engine.worker";

export interface RunExportInWorkerOptions extends WorkerRunOptions {
  readonly onProgress?: (progress: EngineProgress) => void;
  readonly signal?: AbortSignal;
}

export function createExportWorker(): Worker {
  return new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
}

export async function runExportInWorker(
  worker: Worker,
  options: RunExportInWorkerOptions,
): Promise<EngineResult> {
  const { onProgress, signal, ...runOptions } = options;

  return new Promise<EngineResult>((resolve, reject) => {
    const onAbort = (): void => {
      worker.postMessage({ type: "cancel" });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as
        | { type: "progress"; progress: EngineProgress }
        | { type: "done"; result: EngineResult }
        | { type: "error"; message: string; name: string }
        | { type: "cancelled" };
      if (data.type === "progress") {
        onProgress?.(data.progress);
        return;
      }
      signal?.removeEventListener("abort", onAbort);
      if (data.type === "done") {
        resolve(data.result);
      } else if (data.type === "cancelled") {
        reject(new ExportCancelledError());
      } else {
        const error = new Error(data.message);
        error.name = data.name;
        reject(error);
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      signal?.removeEventListener("abort", onAbort);
      reject(event.error instanceof Error ? event.error : new Error(event.message));
    };

    const request: WorkerRequest = { type: "run", options: runOptions };
    worker.postMessage(request);
  });
}

export type { RunExportOptions };
