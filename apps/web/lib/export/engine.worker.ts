/**
 * Web Worker entry point for the export engine (brief §3: "runs in a Web
 * Worker"). Thin by design — `runExport` in `engine.ts` is the whole
 * pipeline; this file translates `postMessage`s into a call, and rebuilds the
 * WASM-backed `FontRegistry`/`Shaper`/`CanvasKitBackend` locally.
 *
 * Those three wrap WebAssembly memory and cannot cross a `postMessage`
 * boundary (`structuredClone` cannot copy a wasm-bound object), so the worker
 * receives plain, structured-cloneable data — the manifest, the projection,
 * the style catalogue (a `Map<string, StyleDoc>` of plain objects) and the
 * font bytes (`FontResource[]`, whose `data: Uint8Array` transfers cheaply) —
 * and loads its own copy of CanvasKit, HarfBuzz and the registry from those
 * bytes, exactly as `use-canvaskit.ts` does on the main thread.
 * `worker-client.ts` is the main-thread counterpart.
 */
/// <reference lib="webworker" />

import { CanvasKitBackend } from "@montaj/render-canvaskit";
import type { FontResource } from "@montaj/render-core";

import { loadWorkerLayoutEngine, runExport, type RunExportOptions } from "./engine";

import type { EngineProgress, EngineResult } from "./types";

export type WorkerRunOptions = Omit<
  RunExportOptions,
  "signal" | "onProgress" | "saveFilePicker" | "loadRenderer" | "registry" | "shaper"
> & {
  readonly fonts: readonly FontResource[];
  readonly canvasKitBase?: string;
};

export type WorkerRequest = { readonly type: "run"; readonly options: WorkerRunOptions };

export type WorkerResponse =
  | { readonly type: "progress"; readonly progress: EngineProgress }
  | { readonly type: "done"; readonly result: EngineResult }
  | { readonly type: "error"; readonly message: string; readonly name: string }
  | { readonly type: "cancelled" };

const controller = new AbortController();

self.addEventListener("message", (event: MessageEvent<WorkerRequest | { type: "cancel" }>) => {
  const data = event.data;
  if (data.type === "cancel") {
    controller.abort();
    return;
  }
  if (data.type !== "run") return;

  void (async (): Promise<void> => {
    const { fonts, canvasKitBase, ...rest } = data.options;
    const { registry, shaper } = await loadWorkerLayoutEngine(fonts);
    await runExport({
      ...rest,
      registry,
      shaper,
      signal: controller.signal,
      loadRenderer: async () => {
        const backend = await CanvasKitBackend.create({
          locateFile: (file) => `${canvasKitBase ?? "/canvaskit/"}${file}`,
          fonts,
        });
        return { backend };
      },
      onProgress: (progress) => {
        const message: WorkerResponse = { type: "progress", progress };
        self.postMessage(message);
      },
    })
      .then((result) => {
        const message: WorkerResponse = { type: "done", result };
        self.postMessage(message);
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "ExportCancelledError") {
          const message: WorkerResponse = { type: "cancelled" };
          self.postMessage(message);
          return;
        }
        const message: WorkerResponse = {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : "Error",
        };
        self.postMessage(message);
      });
  })();
});
