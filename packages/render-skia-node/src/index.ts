/**
 * `@montaj/render-skia-node` — the cloud backend.
 *
 * It executes the `DrawCommand[]` that `@montaj/render-core` produced on Skia's
 * native build (`@napi-rs/canvas`), and hands back straight RGBA frames for
 * ffmpeg to composite over the decoded video (decision D33). It contains no
 * layout of its own: every coordinate and every glyph position arrives
 * finished, which is what makes the browser preview and the cloud render the
 * same picture.
 *
 * ```ts
 * const backend = await SkiaNodeBackend.create({ shaper });
 * const batch = backend.createBatch({ width: 1080, height: 1920 });
 * for (const commands of frames) pipe.write(batch.render(commands));
 * ```
 */

export {
  BLUR_SIGMA_MARGIN,
  type Box,
  deviceBounds,
  hasContainers,
  IDENTITY,
  inflate,
  intersect,
  multiply,
  offset,
  snapToSurface,
  union,
} from "./bounds.js";

export {
  type FrameBatch,
  type FrameDiagnostics,
  type FrameOptions,
  SkiaNodeBackend,
  type SkiaNodeBackendOptions,
} from "./backend.js";

export { isSkiaNodeError, SkiaNodeError, type SkiaNodeErrorCode } from "./errors.js";

export {
  type Approximation,
  type CanvasFactory,
  commandCount,
  cssColour,
  executeCommands,
  type ExecutionContext,
  type MissingResource,
  parseColour,
  SHADOW_BLUR_PER_SIGMA,
  SKIA_MITER_LIMIT,
  toTransformArgs,
  tracePath,
  traceRoundRect,
} from "./executor.js";

export { NAPI_CANVAS_VERSION } from "./version.js";

export { type PackageInfo, PACKAGE_INFO } from "./package-info.js";
