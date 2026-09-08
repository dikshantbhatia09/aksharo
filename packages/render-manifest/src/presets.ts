/**
 * The named export presets of `03-architecture/05-system-architecture.md` §5.2,
 * and the aspect arithmetic both the issuer and the renderer need.
 *
 * The table lives beside the schema rather than in `apps/render` because A21
 * uses it to *write* `output.width`/`output.height` and the renderer only
 * *reads* them. One table, one place to change a resolution.
 *
 * Every dimension is even: 4:2:0 chroma subsampling halves both axes, so an odd
 * width is a hard encoder error rather than a rounding nuisance.
 */

import { type Aspect, type RenderPreset } from "./schema.js";

export interface PresetDimensions {
  readonly width: number;
  readonly height: number;
  readonly aspect: Aspect;
  /** Human label for the export dialog and for log lines. */
  readonly label: string;
}

/** `custom` has no fixed size; the manifest carries its own width and height. */
export const PRESET_DIMENSIONS: Readonly<
  Record<Exclude<RenderPreset, "custom">, PresetDimensions>
> = Object.freeze({
  reels: { width: 1080, height: 1920, aspect: "9:16", label: "Reels / TikTok 1080×1920" },
  shorts: { width: 1080, height: 1920, aspect: "9:16", label: "Shorts 1080×1920" },
  "youtube-4k": { width: 3840, height: 2160, aspect: "16:9", label: "YouTube 4K 3840×2160" },
  square: { width: 1080, height: 1080, aspect: "1:1", label: "Square 1080×1080" },
  // K07: same 1080×1920/9:16 canvas as `reels` — Instagram Story has no
  // technical difference from a Reel today (no platform-specific safe-area
  // or bitrate logic exists at this layer), it is a distinct value purely so
  // the export dialog can offer it as its own selectable, correctly-labelled
  // option (see `RENDER_PRESETS`'s doc comment).
  "instagram-story": {
    width: 1080,
    height: 1920,
    aspect: "9:16",
    label: "Instagram Story 1080×1920",
  },
  // K07: the standard Instagram feed post aspect, 4:5 — `ASPECT_RATIOS`
  // already carried `"4:5"` before this WP; this is the first preset to use it.
  "instagram-feed": {
    width: 1080,
    height: 1350,
    aspect: "4:5",
    label: "Instagram Feed 1080×1350",
  },
});

/** Dimensions for a preset, or `null` for `custom`. */
export function dimensionsFor(preset: RenderPreset): PresetDimensions | null {
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  return preset === "custom" ? null : PRESET_DIMENSIONS[preset];
}

const ASPECT_RATIOS: Readonly<Record<Aspect, number>> = Object.freeze({
  "9:16": 9 / 16,
  "16:9": 16 / 9,
  "1:1": 1,
  "4:5": 4 / 5,
});

/** Width ÷ height for a named aspect. */
export function aspectRatio(aspect: Aspect): number {
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  return ASPECT_RATIOS[aspect];
}

/** Rounds down to an even number, with a floor of 2. */
export function toEven(value: number): number {
  const floored = Math.floor(value);
  return Math.max(2, floored - (floored % 2));
}

export interface ScaleCrop {
  /** Intermediate size the source is scaled to before cropping. */
  readonly scaleWidth: number;
  readonly scaleHeight: number;
  readonly cropWidth: number;
  readonly cropHeight: number;
  readonly cropX: number;
  readonly cropY: number;
  /** True when the source already matches the target and nothing is needed. */
  readonly identity: boolean;
}

/**
 * Centre "cover" fit: scale the source until it covers the target on both axes,
 * then crop the overflow away symmetrically.
 *
 * Cover rather than contain because a Reel with letterbox bars is a bug report,
 * and because the caption layout is computed for the full target canvas — a
 * contained picture would leave captions floating over black.
 */
export function coverScaleCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): ScaleCrop {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new RangeError(
      `source dimensions must be positive, got ${String(sourceWidth)}×${String(sourceHeight)}`,
    );
  }
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) {
    return {
      scaleWidth: targetWidth,
      scaleHeight: targetHeight,
      cropWidth: targetWidth,
      cropHeight: targetHeight,
      cropX: 0,
      cropY: 0,
      identity: true,
    };
  }
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
  // Ceil, then even: rounding down could leave the scaled picture one pixel
  // short of the crop window, which ffmpeg answers with a hard error.
  const scaleWidth = Math.max(targetWidth, toEven(Math.ceil(sourceWidth * scale)));
  const scaleHeight = Math.max(targetHeight, toEven(Math.ceil(sourceHeight * scale)));
  return {
    scaleWidth,
    scaleHeight,
    cropWidth: targetWidth,
    cropHeight: targetHeight,
    cropX: Math.floor((scaleWidth - targetWidth) / 2),
    cropY: Math.floor((scaleHeight - targetHeight) / 2),
    identity: false,
  };
}
