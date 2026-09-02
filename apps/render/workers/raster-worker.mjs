/**
 * The rasteriser, on its own thread.
 *
 * Plain JavaScript on purpose. `worker_threads` loads this file with Node's own
 * loader — not vitest's, not tsx's — so a `.ts` entry point would work under one
 * runner and fail under the others. It lives outside `src/` for the same reason
 * the path resolves identically from `src/render/` and from `dist/render/`: both
 * are two directories below the package root.
 *
 * It owns everything a frame needs and nothing else: the fonts, a HarfBuzz
 * shaper, a Skia backend and one reusable surface. Layout, the frame-diff hash
 * and the cache decision stay on the main thread — the worker is handed a
 * finished `DrawCommand[]` and answers with pixels, which keeps the cache exactly
 * as exact as it was single-threaded.
 *
 * Frames never cross the thread boundary. The main thread allocates a
 * `SharedArrayBuffer` per slot and sends it once; the worker draws into a view
 * of it and posts back the slot number. An 8.3 MB structured clone per frame
 * would cost more than the parallelism buys.
 */

import { parentPort, workerData } from "node:worker_threads";

import { createFontRegistry, createHarfBuzzShaper } from "@montaj/render-core";
import { SkiaNodeBackend } from "@montaj/render-skia-node";

if (parentPort === null) {
  throw new Error("raster-worker.mjs must be started as a worker thread");
}

const port = parentPort;
const { width, height, fonts, images, slots } = workerData;

/** One reusable Skia surface per slot, each drawing into that slot's memory. */
const batches = new Map();
let backend = null;

async function boot() {
  const registry = createFontRegistry(
    fonts.map((font) => ({
      id: font.id,
      family: font.family,
      weight: font.weight,
      italic: font.italic,
      data: new Uint8Array(font.data),
      ...(font.scripts === undefined ? {} : { scripts: font.scripts }),
    })),
  );
  const shaper = await createHarfBuzzShaper(registry);
  backend = await SkiaNodeBackend.create({ shaper });

  // The watermark is an `image` command, so a worker without the bytes would
  // draw every frame correctly except the one thing the plan is charging for.
  for (const image of images ?? []) {
    await backend.registerImage(image.assetId, new Uint8Array(image.bytes));
  }

  for (const [index, shared] of slots.entries()) {
    batches.set(
      index,
      backend.createBatch({ width, height, into: new Uint8Array(shared) }),
    );
  }
  port.postMessage({ type: "ready" });
}

port.on("message", (message) => {
  if (message.type !== "render") return;
  try {
    const batch = batches.get(message.slot);
    if (batch === undefined) throw new Error(`no surface for slot ${message.slot}`);
    // `outline` converts glyph runs to paths; it is a pure function of the list,
    // so doing it here rather than on the main thread changes no pixels and
    // takes the work off the thread that is feeding ffmpeg.
    batch.render(backend.outline(message.commands));
    // A missing font or image is reported, never thrown: one absent asset should
    // cost one caption, not the whole render. The main thread logs it once.
    const missing = batch.diagnostics.missing.map((entry) => `${entry.kind}:${entry.id}`);
    port.postMessage({
      type: "done",
      id: message.id,
      slot: message.slot,
      ...(missing.length === 0 ? {} : { missing }),
    });
  } catch (error) {
    port.postMessage({
      type: "failed",
      id: message.id,
      slot: message.slot,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

boot().catch((error) => {
  port.postMessage({
    type: "boot-failed",
    message: error instanceof Error ? error.message : String(error),
  });
});
