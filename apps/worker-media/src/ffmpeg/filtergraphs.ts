/**
 * Pillar 3 §05 — Blurred Background Canvas Fit (16:9 in 9:16)
 * FFmpeg Accelerated Filtergraph Generator (`apps/worker-media/src/ffmpeg/filtergraphs.ts`)
 *
 * Implements:
 * - `buildBlurredFitFiltergraph(sourceWidth, sourceHeight, targetWidth, targetHeight, options)`:
 *   Builds the dual-layer `-filter_complex` string that scales 16:9 source footage to fill the
 *   9:16 vertical canvas with `boxblur=luma_radius=35:luma_power=2` and 35% luminance attenuation
 *   (`colorchannelmixer=aa=1.0:rr=0.6:gg=0.6:bb=0.6`), then overlays the un-cropped `1080 x 608`
 *   foreground centered at `y = 656`.
 * - `buildBlurredFitVfFiltergraph(...)`: Single-input `-vf` variant used by `media.clip`.
 * - `validateBlurredFitAspectRatio(...)`: Validates source and target dimensions and aspect ratios.
 */

export const BLURRED_FIT_DEFAULT_LUMA_RADIUS = 35;
export const BLURRED_FIT_DEFAULT_LUMA_POWER = 2;
export const BLURRED_FIT_DEFAULT_CHANNEL_FACTOR = 0.6;
export const BLURRED_FIT_DEFAULT_TARGET_WIDTH = 1080;
export const BLURRED_FIT_DEFAULT_TARGET_HEIGHT = 1920;

export interface BlurredFitFiltergraphOptions {
  /** Boxblur luma radius in pixels (defaults to 35). */
  readonly lumaRadius?: number;
  /** Boxblur power / iterations (defaults to 2). */
  readonly lumaPower?: number;
  /** RGB channel attenuation factor in `colorchannelmixer` (defaults to 0.6). */
  readonly colorChannelFactor?: number;
  /** Optional explicit foreground vertical Y offset on the target canvas. */
  readonly foregroundY?: number;
}

export interface BlurredFitFilterGeometry {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly foregroundWidth: number;
  readonly foregroundHeight: number;
  readonly overlayX: number;
  readonly overlayY: number;
  readonly lumaRadius: number;
  readonly lumaPower: number;
  readonly colorChannelFactor: number;
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

function floorEven(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Validate that source and target dimensions are finite positive numbers (>= 2)
 * and that the source aspect ratio is wider than the target canvas aspect ratio
 * (e.g., 16:9 `1920x1080` fitted into 9:16 `1080x1920` or 4:5 `1080x1350`).
 */
export function validateBlurredFitAspectRatio(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): void {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    !Number.isFinite(targetWidth) ||
    !Number.isFinite(targetHeight) ||
    sourceWidth < 2 ||
    sourceHeight < 2 ||
    targetWidth < 2 ||
    targetHeight < 2
  ) {
    throw new RangeError(
      `Invalid dimensions for BlurredFit filtergraph: source=${String(sourceWidth)}x${String(sourceHeight)}, target=${String(targetWidth)}x${String(targetHeight)}`,
    );
  }

  // Blurred Background Canvas Fit requires a source wider than the target canvas aspect ratio
  if (sourceWidth * targetHeight <= sourceHeight * targetWidth) {
    throw new RangeError(
      `Source aspect ratio (${String(sourceWidth)}:${String(sourceHeight)}) must be wider than target aspect ratio (${String(targetWidth)}:${String(targetHeight)}) for BLURRED_FIT`,
    );
  }
}

/**
 * Compute even-aligned H.264 geometry for Blurred Background Canvas Fit.
 */
export function computeBlurredFitFilterGeometry(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number = BLURRED_FIT_DEFAULT_TARGET_WIDTH,
  targetHeight: number = BLURRED_FIT_DEFAULT_TARGET_HEIGHT,
  options: BlurredFitFiltergraphOptions = {},
): BlurredFitFilterGeometry {
  validateBlurredFitAspectRatio(sourceWidth, sourceHeight, targetWidth, targetHeight);

  const srcW = floorEven(sourceWidth);
  const srcH = floorEven(sourceHeight);
  const outW = even(targetWidth);
  const outH = even(targetHeight);

  const foregroundWidth = outW;
  const foregroundHeight = clamp(even((foregroundWidth * sourceHeight) / sourceWidth), 2, outH);
  const overlayX = Math.floor((outW - foregroundWidth) / 4) * 2;
  const defaultOverlayY = Math.floor((outH - foregroundHeight) / 4) * 2;
  const overlayY =
    typeof options.foregroundY === "number" && Number.isFinite(options.foregroundY)
      ? Math.floor(clamp(Math.round(options.foregroundY), 0, Math.max(0, outH - foregroundHeight)) / 2) * 2
      : defaultOverlayY;

  // FFmpeg's boxblur requires luma_radius <= min(w, h) / 2
  const maxAllowedRadius = Math.max(1, Math.floor(Math.min(outW, outH) / 4));
  const lumaRadius = clamp(
    Math.round(options.lumaRadius ?? BLURRED_FIT_DEFAULT_LUMA_RADIUS),
    1,
    Math.min(100, maxAllowedRadius),
  );
  const lumaPower = clamp(
    Math.round(options.lumaPower ?? BLURRED_FIT_DEFAULT_LUMA_POWER),
    1,
    5,
  );
  const colorChannelFactor = clamp(
    options.colorChannelFactor ?? BLURRED_FIT_DEFAULT_CHANNEL_FACTOR,
    0.1,
    1.0,
  );

  return {
    sourceWidth: srcW,
    sourceHeight: srcH,
    targetWidth: outW,
    targetHeight: outH,
    foregroundWidth,
    foregroundHeight,
    overlayX,
    overlayY,
    lumaRadius,
    lumaPower,
    colorChannelFactor,
  };
}

function formatChannelFactor(factor: number): string {
  const rounded = Math.round(factor * 100) / 100;
  return Number.isInteger(rounded) ? `${String(rounded)}.0` : String(rounded);
}

/**
 * Build the FFmpeg `-filter_complex` string for Blurred Background Canvas Fit (Pillar 3 §05 §2.2 & §5 Step 3):
 *
 * For `1920x1080` -> `1080x1920`:
 * `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=35:luma_power=2,colorchannelmixer=aa=1.0:rr=0.6:gg=0.6:bb=0.6[bg]; [0:v]scale=1080:608[fg]; [bg][fg]overlay=x=0:y=656[v]`
 */
export function buildBlurredFitFiltergraph(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number = BLURRED_FIT_DEFAULT_TARGET_WIDTH,
  targetHeight: number = BLURRED_FIT_DEFAULT_TARGET_HEIGHT,
  options: BlurredFitFiltergraphOptions = {},
): string {
  const geom = computeBlurredFitFilterGeometry(
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
    options,
  );
  const ch = formatChannelFactor(geom.colorChannelFactor);

  return [
    `[0:v]scale=${String(geom.targetWidth)}:${String(geom.targetHeight)}:force_original_aspect_ratio=increase,crop=${String(geom.targetWidth)}:${String(geom.targetHeight)},boxblur=luma_radius=${String(geom.lumaRadius)}:luma_power=${String(geom.lumaPower)},colorchannelmixer=aa=1.0:rr=${ch}:gg=${ch}:bb=${ch}[bg]`,
    `[0:v]scale=${String(geom.foregroundWidth)}:${String(geom.foregroundHeight)}[fg]`,
    `[bg][fg]overlay=x=${String(geom.overlayX)}:y=${String(geom.overlayY)}[v]`,
  ].join("; ");
}

/**
 * Single-stream `-vf` filtergraph variant for `media.clip` pipelines.
 */
export function buildBlurredFitVfFiltergraph(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number = BLURRED_FIT_DEFAULT_TARGET_WIDTH,
  targetHeight: number = BLURRED_FIT_DEFAULT_TARGET_HEIGHT,
  options: BlurredFitFiltergraphOptions = {},
): string {
  const geom = computeBlurredFitFilterGeometry(
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
    options,
  );
  const ch = formatChannelFactor(geom.colorChannelFactor);

  return [
    `scale=${String(geom.sourceWidth)}:${String(geom.sourceHeight)},split=2[bg_in][fg_in]`,
    `[bg_in]scale=${String(geom.targetWidth)}:${String(geom.targetHeight)}:force_original_aspect_ratio=increase:flags=bicubic,crop=${String(geom.targetWidth)}:${String(geom.targetHeight)},boxblur=luma_radius=${String(geom.lumaRadius)}:luma_power=${String(geom.lumaPower)},colorchannelmixer=aa=1.0:rr=${ch}:gg=${ch}:bb=${ch}[bg]`,
    `[fg_in]scale=${String(geom.foregroundWidth)}:${String(geom.foregroundHeight)}:flags=bicubic,setsar=1[fg]`,
    `[bg][fg]overlay=x=${String(geom.overlayX)}:y=${String(geom.overlayY)},setsar=1,format=yuv420p`,
  ].join(";");
}
