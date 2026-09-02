/**
 * Loading the CanvasKit wasm module.
 *
 * The version is **pinned exactly** (`canvaskit-wasm` 0.42.0): a Skia upgrade
 * changes rasterisation, and rasterisation is what A18a's parity gate measures,
 * so it moves in its own reviewed commit and never through a caret range.
 *
 * `locateFile` is the only integration point a host normally needs. In Node the
 * default resolves `canvaskit.wasm` out of `node_modules`; in a browser the app
 * serves it from its own origin (a `.wasm` cannot be fetched cross-origin under
 * the app's CSP), so `apps/web` passes a URL under `/canvaskit/`.
 */

import type { CanvasKit } from "canvaskit-wasm";

/** The exact wasm build this package is tested against. */
export const CANVASKIT_VERSION = "0.42.0";

export interface LoadCanvasKitOptions {
  /**
   * Maps `"canvaskit.wasm"` to a URL or path. Omit in Node; in a browser point
   * it at the copy the app serves.
   */
  readonly locateFile?: (file: string) => string;
}

let modulePromise: Promise<CanvasKit> | undefined;

type CanvasKitInit = (options: { locateFile?: (file: string) => string }) => Promise<CanvasKit>;

/** Resolves `canvaskit.wasm` next to the package's own `bin/` directory. */
function defaultLocateFile(file: string): string {
  // `require.resolve` is only available in Node; in a browser the caller must
  // supply `locateFile`, which is why this is guarded rather than assumed.
  if (typeof require === "undefined") return file;
  try {
    const entry = require.resolve("canvaskit-wasm/bin/canvaskit.js");
    return entry.replace(/canvaskit\.js$/, file);
  } catch {
    return file;
  }
}

/**
 * Initialises CanvasKit once per process. The promise is cached, so a hundred
 * previews share one wasm instance.
 */
export async function loadCanvasKit(options: LoadCanvasKitOptions = {}): Promise<CanvasKit> {
  modulePromise ??= (async (): Promise<CanvasKit> => {
    const imported = (await import("canvaskit-wasm")) as unknown as {
      default?: CanvasKitInit;
    };
    const init = (imported.default ?? (imported as unknown as CanvasKitInit)) as CanvasKitInit;
    return init({ locateFile: options.locateFile ?? defaultLocateFile });
  })();
  return modulePromise;
}

/** Drops the cached module; used by tests and by a worker teardown. */
export function resetCanvasKit(): void {
  modulePromise = undefined;
}
