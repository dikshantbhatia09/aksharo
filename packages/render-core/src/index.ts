/**
 * `@montaj/render-core` — the single source of layout truth.
 *
 * `(StyleDoc, segment, words, time, canvas) → DrawCommand[]`, computed once in
 * pure TypeScript with HarfBuzz-wasm shaping and bundled subset fonts, then
 * executed by CanvasKit in the browser and by `@napi-rs/canvas` in the cloud
 * (decision D33). Nothing in this package touches the DOM, the network or a
 * system font.
 *
 * ```ts
 * const registry = createFontRegistry([{ id: "inter-700", family: "Inter", weight: 700, italic: false, data }]);
 * const shaper = await createHarfBuzzShaper(registry);
 * const layout = layoutSegment({ style, segment, words, canvas, registry, shaper, tMs });
 * const commands = animate({ layout, style, tMs });
 * ```
 */

export { type PackageInfo, PACKAGE_INFO } from "./package-info.js";

export {
  animate,
  type AnimateOptions,
  cuePhase,
  cueTiming,
  toGlyphRun,
  watermarkCommand,
  wordColour,
  wordState,
  type WordState,
} from "./animate/animate.js";
export {
  type Easing,
  EASINGS,
  type EasingName,
  easeInCubic,
  easeInOutCubic,
  easeOutBack,
  easeOutBounce,
  easeOutCubic,
  easeOutQuad,
  lerp,
  linear,
  progress,
  shakeOffset,
} from "./animate/easing.js";

export {
  blur,
  clip,
  clipRect,
  fill,
  group,
  IDENTITY_MATRIX,
  image,
  inflate,
  linearGradient,
  radialGradient,
  rect,
  rectHeight,
  rectWidth,
  roundRect,
  scaleTranslateMatrix,
  shadow,
  solid,
  stroke,
  text,
  transform,
} from "./commands/build.js";
export { canonicalJson, hashCommands, sha256Hex } from "./commands/hash.js";
export {
  glyphRunToPath,
  outlineGlyphRun,
  outlineTextCommands,
  transformGlyphPath,
} from "./commands/outline.js";
export {
  type BlurCommand,
  type ClipCommand,
  type ClipShape,
  type Color,
  type ContainerCommand,
  countCommands,
  DRAW_COMMAND_KINDS,
  type DrawCommand,
  type DrawCommandKind,
  type Fill,
  type GlyphRun,
  type GradientStop,
  type GroupCommand,
  type ImageCommand,
  isContainerCommand,
  type Matrix,
  type Paint,
  type PathCommand,
  type Point,
  type Rect,
  type RectCommand,
  type RoundRectCommand,
  type ShadowCommand,
  type Stroke,
  type StrokeCap,
  type StrokeJoin,
  type TextCommand,
  type TransformCommand,
  walkCommands,
} from "./commands/types.js";

export {
  contrastingInk,
  formatColour,
  luminance,
  mixColours,
  normaliseColour,
  parseColour,
  type Rgba,
  setAlpha,
  withAlpha,
} from "./colour.js";

export { isRenderError, RenderError, type RenderErrorCode } from "./errors.js";

export {
  createHarfBuzzShaper,
  DEFAULT_FEATURES,
  harfBuzzVersion,
  type HarfBuzzModule,
  type HarfBuzzShaperOptions,
  loadHarfBuzz,
  resetHarfBuzz,
} from "./fonts/harfbuzz.js";
export { createFontRegistry, resolveFontOrThrow } from "./fonts/registry.js";
export {
  advanceOfClusterRange,
  clusterBoundaries,
  codePointsOf,
  type FontMetrics,
  type ShapeRequest,
  type ShapedGlyph,
  type ShapedRun,
  type Shaper,
} from "./fonts/shaper.js";
export { type FontQuery, type FontRegistry, type FontResource } from "./fonts/types.js";

export {
  type DisplayScript,
  mergeOverrides,
  resolveStyle,
  resolveWords,
  type ResolveTextOptions,
  type StyleOverrides,
  type StyleSource,
  type TranscriptWord,
} from "./frame/resolve.js";
export {
  type EdgProjection,
  layoutFrame,
  type ProjectedSegment,
  renderFrame,
  type RenderFrameOptions,
  visibleSegments,
  watermarkFor,
  wordsBetween,
} from "./frame/render-frame.js";

export { itemise, type ItemisedRun, type ItemiseOptions, splitByScript } from "./layout/itemise.js";
export {
  applyTextTransform,
  captionCharacterCount,
  layoutSegment,
  type LayoutOptions,
  MIN_SHRINK,
  visibleWords,
} from "./layout/layout.js";
export {
  type Layout,
  type LayoutLine,
  type LayoutWord,
  type PlacedGlyph,
  type PlacedRun,
  type RenderSegment,
  type RenderWord,
} from "./layout/types.js";
export {
  balanceIntoLines,
  breakWordAtClusters,
  toWrapItems,
  type WrapItem,
  wrapByCharacters,
  wrapByWidth,
} from "./layout/wrap.js";

export {
  charCount,
  detectWordScript,
  dominantScript,
  isComplexScript,
  limitsFor,
  openTypeScriptTag,
  SCRIPT_LIMITS,
  type ScriptLimits,
  type WordScript,
} from "./script.js";

export {
  capabilitiesOf,
  type GradientLook,
  gradientOf,
  type StyleCapabilities,
  stylesWithCapabilities,
} from "./styles/capabilities.js";
export {
  budgetFillingWords,
  budgetProbes,
  type FitContext,
  type FitProbe,
  type FitResult,
  LANDSCAPE_CANVAS,
  LANDSCAPE_MIN_SHRINK,
  PORTRAIT_CANVAS,
  PORTRAIT_MIN_SHRINK,
  sweep,
  worstFit,
} from "./styles/fit.js";
export {
  PREVIEW_DURATION_MS,
  PREVIEW_SCRIPTS,
  previewFor,
  previewStillMs,
  type StylePreview,
} from "./styles/preview.js";

export {
  assertCanvas,
  blurRadiusToSigma,
  type CanvasSize,
  clamp,
  clamp01,
  COORDINATE_DECIMALS,
  ofCanvasHeight,
  ofCanvasWidth,
  ofFontSize,
  q,
  qRect,
} from "./units.js";
