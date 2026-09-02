/**
 * `@montaj/render-canvaskit` — the browser (and desktop) backend.
 *
 * It executes the `DrawCommand[]` that `@montaj/render-core` produced, on Skia
 * compiled to WebAssembly, onto a WebGL surface where one exists and onto a CPU
 * raster surface otherwise (decision D33). It contains no layout of its own:
 * every coordinate and every glyph position arrives finished, which is what
 * makes the browser preview and the cloud render the same picture.
 *
 * ```ts
 * const backend = await CanvasKitBackend.create({ fonts });
 * const { surface } = createBrowserSurface(backend.ck, canvasElement);
 * backend.drawFrame(surface.getCanvas(), commands, { background: "#00000000" });
 * surface.flush();
 * ```
 */

export { Arena, type Deletable, withArena } from "./arena.js";
export {
  type BrowserSurface,
  CanvasKitBackend,
  type CanvasKitBackendOptions,
  CanvasKitError,
  createBrowserSurface,
  createExportSurface,
  type DrawFrameOptions,
  type MissingResource,
  type RenderToPngOptions,
} from "./backend.js";
export {
  CANVASKIT_VERSION,
  loadCanvasKit,
  type LoadCanvasKitOptions,
  resetCanvasKit,
} from "./canvaskit.js";
export { executeCommands, type ExecutionContext, toMatrix3x3 } from "./execute.js";
export {
  BASELINE_BACKGROUND,
  BASELINE_CANVAS,
  BASELINE_FRAMES,
  type BaselineFrame,
} from "./frames.js";
export { type PackageInfo, PACKAGE_INFO } from "./package-info.js";
