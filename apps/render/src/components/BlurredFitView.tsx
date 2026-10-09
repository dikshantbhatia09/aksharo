/** @jsx h */
/** @jsxFrag Fragment */
/**
 * Pillar 3 §05 — Blurred Background Canvas Fit (16:9 in 9:16)
 *
 * Implements the `<BlurredFitView />` ("Fit with Blur") Remotion component,
 * FFmpeg filtergraph builder, and deterministic RGBA buffer compositor for
 * placing un-cropped 16:9 widescreen footage inside a 9:16 (`1080 x 1920`)
 * vertical canvas:
 * 1. Layer 1 (Ambient Blurred Canvas): Scales the original 16:9 footage to fill
 *    the entire `1080 x 1920` vertical canvas (`width: 'auto', height: '100%'`),
 *    centered, with heavy Gaussian blur (`blurRadius`, default `40px` CSS / `35px`
 *    sigma), luminance attenuation (`dimOpacity = 0.65`, darkening by 35%), and
 *    saturation boost (`saturate(1.2)`).
 * 2. Layer 2 (Crisp Master Video): Places the un-cropped 16:9 footage (`1080 x 608`)
 *    centered in the foreground at `y = 656px` with subtle `16px` rounded corners
 *    (`borderRadius`) and shadow depth (`boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)'`),
 *    with playhead strictly synchronized to Layer 1 (`startFrom`, `endAt`).
 * 3. Layer 3 (Subtitle Safe Zone): Positions dynamic kinetic captions in the
 *    blurred lower canvas zone at `y = 1450px`, preventing subtitle text from
 *    obscuring the main widescreen action.
 */

import { Fragment, OffthreadVideo, h, type SplitScreenVNode } from "./SplitScreenView.js";

export const BLURRED_FIT_CANVAS_WIDTH = 1080;
export const BLURRED_FIT_CANVAS_HEIGHT = 1920;
export const BLURRED_FIT_FG_WIDTH = 1080;
export const BLURRED_FIT_FG_HEIGHT = 608;
export const BLURRED_FIT_FG_Y = 656; // (1920 - 608) / 2
export const BLURRED_FIT_DEFAULT_BLUR_RADIUS = 35;
export const BLURRED_FIT_DEFAULT_CSS_BLUR_PX = 40;
export const BLURRED_FIT_DEFAULT_DIM_OPACITY = 0.65;
export const BLURRED_FIT_DEFAULT_SATURATION = 1.2;
export const BLURRED_FIT_DEFAULT_BORDER_RADIUS = 16;
export const BLURRED_FIT_DEFAULT_BOX_SHADOW = "0 25px 50px -12px rgba(0, 0, 0, 0.7)";
export const BLURRED_FIT_CAPTION_Y = 1450;

export interface BlurredFitViewProps {
  readonly src: string;
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
  readonly canvasWidth?: number;
  readonly canvasHeight?: number;
  /** CSS / Gaussian blur radius in px (defaults to 40px for CSS filter, 35px for FFmpeg luma_radius). */
  readonly blurRadius?: number;
  /** Luminance brightness multiplier 0..1 (defaults to 0.65, darkening by 35%). */
  readonly dimOpacity?: number;
  /** Saturation multiplier for ambient background (defaults to 1.2). */
  readonly saturation?: number;
  /** Corner rounding radius in px for the foreground 16:9 video (defaults to 16px). */
  readonly borderRadius?: number;
  /** CSS box-shadow for the foreground 16:9 card. */
  readonly boxShadow?: string;
  /** Optional explicit Y coordinate override for the foreground video (defaults to 656 on 1080x1920). */
  readonly foregroundY?: number;
  /** Y coordinate on the 9:16 canvas for the lower blurred caption zone (defaults to 1450 on 1080x1920). */
  readonly captionZoneY?: number;
  /** Optional kinetic caption text to render in the lower blurred safe zone. */
  readonly captionText?: string;
  /** Synchronized playhead start frame across both background and foreground video layers. */
  readonly startFrom?: number;
  /** Synchronized playhead end frame across both background and foreground video layers. */
  readonly endAt?: number;
  readonly muted?: boolean;
  readonly volume?: number;
}

export interface ComputedBlurredFitGeometry {
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly foregroundWidth: number;
  readonly foregroundHeight: number;
  readonly foregroundX: number;
  readonly foregroundY: number;
  readonly borderRadius: number;
  readonly blurRadius: number;
  readonly dimOpacity: number;
  readonly saturation: number;
  readonly boxShadow: string;
  readonly captionZoneY: number;
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Compute the exact un-cropped 16:9 foreground geometry, styling parameters,
 * and lower blurred caption zone coordinates inside the 9:16 vertical canvas.
 */
export function computeBlurredFitGeometry(
  sourceWidth = 1920,
  sourceHeight = 1080,
  options: {
    readonly canvasWidth?: number;
    readonly canvasHeight?: number;
    readonly blurRadius?: number;
    readonly dimOpacity?: number;
    readonly saturation?: number;
    readonly borderRadius?: number;
    readonly boxShadow?: string;
    readonly foregroundY?: number;
    readonly captionZoneY?: number;
  } = {},
): ComputedBlurredFitGeometry {
  const canvasWidth = even(options.canvasWidth ?? BLURRED_FIT_CANVAS_WIDTH);
  const canvasHeight = even(options.canvasHeight ?? BLURRED_FIT_CANVAS_HEIGHT);
  const safeSourceWidth = Math.max(2, sourceWidth);
  const safeSourceHeight = Math.max(2, sourceHeight);

  const foregroundWidth = canvasWidth;
  const rawFgHeight = Math.round((foregroundWidth * safeSourceHeight) / safeSourceWidth);
  const foregroundHeight = clamp(even(rawFgHeight), 2, canvasHeight);

  const defaultY = Math.floor((canvasHeight - foregroundHeight) / 2);
  const rawY = options.foregroundY ?? defaultY;
  const clampedY = clamp(Math.round(rawY), 0, Math.max(0, canvasHeight - foregroundHeight));
  const foregroundY = clampedY - (clampedY % 2);

  const scaleY = canvasHeight / BLURRED_FIT_CANVAS_HEIGHT;
  const defaultCaptionY = Math.round(BLURRED_FIT_CAPTION_Y * scaleY);
  const captionZoneY = clamp(
    Math.round(options.captionZoneY ?? defaultCaptionY),
    foregroundY + foregroundHeight,
    canvasHeight - 2,
  );

  const blurRadius = clamp(
    options.blurRadius ?? BLURRED_FIT_DEFAULT_CSS_BLUR_PX,
    1,
    120,
  );
  const dimOpacity = clamp(
    options.dimOpacity ?? BLURRED_FIT_DEFAULT_DIM_OPACITY,
    0.1,
    1.0,
  );
  const saturation = clamp(
    options.saturation ?? BLURRED_FIT_DEFAULT_SATURATION,
    0.5,
    3.0,
  );
  const borderRadius = clamp(
    Math.round(options.borderRadius ?? BLURRED_FIT_DEFAULT_BORDER_RADIUS),
    0,
    64,
  );

  return {
    canvasWidth,
    canvasHeight,
    foregroundWidth,
    foregroundHeight,
    foregroundX: 0,
    foregroundY,
    borderRadius,
    blurRadius,
    dimOpacity,
    saturation,
    boxShadow: options.boxShadow ?? BLURRED_FIT_DEFAULT_BOX_SHADOW,
    captionZoneY,
  };
}

/**
 * `<BlurredFitView />` ("Fit with Blur") Remotion component (Pillar 3 §05).
 *
 * Renders:
 * 1. Layer 1: Background `<OffthreadVideo>` scaled to fill the 9:16 canvas with
 *    `blur(${blurRadius}px) brightness(${dimOpacity}) saturate(${saturation})` and
 *    muted audio so only the foreground master track plays audio.
 * 2. Layer 2: Foreground `<OffthreadVideo>` at `1080 x 608` (`y = 656px`) with
 *    `borderRadius: '16px'` and `boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)'`,
 *    sharing identical `startFrom` and `endAt` playhead bounds with Layer 1.
 * 3. Layer 3: Lower blurred safe-zone caption container positioned at `y = 1450px`.
 */
export function BlurredFitView(props: BlurredFitViewProps): SplitScreenVNode {
  const sourceWidth = props.sourceWidth ?? 1920;
  const sourceHeight = props.sourceHeight ?? 1080;
  const geom = computeBlurredFitGeometry(sourceWidth, sourceHeight, {
    ...(props.canvasWidth === undefined ? {} : { canvasWidth: props.canvasWidth }),
    ...(props.canvasHeight === undefined ? {} : { canvasHeight: props.canvasHeight }),
    ...(props.blurRadius === undefined ? {} : { blurRadius: props.blurRadius }),
    ...(props.dimOpacity === undefined ? {} : { dimOpacity: props.dimOpacity }),
    ...(props.saturation === undefined ? {} : { saturation: props.saturation }),
    ...(props.borderRadius === undefined ? {} : { borderRadius: props.borderRadius }),
    ...(props.boxShadow === undefined ? {} : { boxShadow: props.boxShadow }),
    ...(props.foregroundY === undefined ? {} : { foregroundY: props.foregroundY }),
    ...(props.captionZoneY === undefined ? {} : { captionZoneY: props.captionZoneY }),
  });

  const cssFilter = `blur(${String(geom.blurRadius)}px) brightness(${String(geom.dimOpacity)}) saturate(${String(geom.saturation)})`;

  return (
    <div
      data-testid="blurred-fit-view"
      data-layout-mode="BLURRED_FIT"
      style={{
        position: "relative",
        width: `${String(geom.canvasWidth)}px`,
        height: `${String(geom.canvasHeight)}px`,
        overflow: "hidden",
        backgroundColor: "#000000",
      }}
    >
      {/* Layer 1: Ambient Blurred & Darkened 9:16 Background Canvas */}
      <div
        data-testid="blurred-fit-background"
        data-blur-radius={geom.blurRadius}
        data-dim-opacity={geom.dimOpacity}
        data-saturation={geom.saturation}
        style={{
          position: "absolute",
          top: "0px",
          left: "0px",
          width: `${String(geom.canvasWidth)}px`,
          height: `${String(geom.canvasHeight)}px`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <OffthreadVideo
          src={props.src}
          muted={true}
          volume={0}
          {...(props.startFrom === undefined ? {} : { startFrom: props.startFrom })}
          {...(props.endAt === undefined ? {} : { endAt: props.endAt })}
          style={{
            width: "auto",
            height: "100%",
            minWidth: `${String(geom.canvasWidth)}px`,
            minHeight: `${String(geom.canvasHeight)}px`,
            objectFit: "cover",
            filter: cssFilter,
            transform: "scale(1.15)",
            transformOrigin: "center center",
          }}
        />
      </div>

      {/* Layer 2: Un-cropped 16:9 Crisp Foreground Video with 16px Rounded Corners & Drop Shadow */}
      <div
        data-testid="blurred-fit-foreground"
        data-fg-width={geom.foregroundWidth}
        data-fg-height={geom.foregroundHeight}
        data-fg-y={geom.foregroundY}
        data-border-radius={geom.borderRadius}
        style={{
          position: "absolute",
          left: `${String(geom.foregroundX)}px`,
          top: `${String(geom.foregroundY)}px`,
          width: `${String(geom.foregroundWidth)}px`,
          height: `${String(geom.foregroundHeight)}px`,
          borderRadius: `${String(geom.borderRadius)}px`,
          boxShadow: geom.boxShadow,
          overflow: "hidden",
          zIndex: 1,
        }}
      >
        <OffthreadVideo
          src={props.src}
          {...(props.muted === undefined ? {} : { muted: props.muted })}
          {...(props.volume === undefined ? {} : { volume: props.volume })}
          {...(props.startFrom === undefined ? {} : { startFrom: props.startFrom })}
          {...(props.endAt === undefined ? {} : { endAt: props.endAt })}
          style={{
            width: `${String(geom.foregroundWidth)}px`,
            height: `${String(geom.foregroundHeight)}px`,
            objectFit: "contain",
            borderRadius: `${String(geom.borderRadius)}px`,
          }}
        />
      </div>

      {/* Layer 3: Dedicated Lower Blur Safe Zone for Dynamic Kinetic Captions (y = 1450px) */}
      <div
        data-testid="blurred-fit-caption-zone"
        data-caption-y={geom.captionZoneY}
        style={{
          position: "absolute",
          left: "0px",
          top: `${String(geom.captionZoneY)}px`,
          width: `${String(geom.canvasWidth)}px`,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          pointerEvents: "none",
          zIndex: 2,
        }}
      >
        {props.captionText !== undefined && props.captionText.length > 0 ? (
          <span
            data-testid="blurred-fit-caption-text"
            style={{
              color: "#FFFFFF",
              fontSize: "48px",
              fontWeight: 800,
              textAlign: "center",
              textShadow: "0 4px 16px rgba(0, 0, 0, 0.85)",
              padding: "0 48px",
            }}
          >
            {props.captionText}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Preset alias matching Opus Clip & Submagic's "Fit with Blur". */
export const FitWithBlur = BlurredFitView;

/**
 * Compute smooth signed distance to a rounded rectangle of `width x height`
 * with corner radius `radius`. Negative inside, 0 on boundary, positive outside.
 */
function roundedRectSignedDistance(
  localX: number,
  localY: number,
  width: number,
  height: number,
  radius: number,
): number {
  const r = clamp(radius, 0, Math.min(width, height) / 2);
  const halfW = width / 2;
  const halfH = height / 2;
  const px = Math.abs(localX + 0.5 - halfW) - (halfW - r);
  const py = Math.abs(localY + 0.5 - halfH) - (halfH - r);
  const outsideX = Math.max(px, 0);
  const outsideY = Math.max(py, 0);
  const outsideDist = Math.hypot(outsideX, outsideY);
  const insideDist = Math.min(Math.max(px, py), 0);
  return outsideDist + insideDist - r;
}

/**
 * Apply luminance attenuation (`dimOpacity = 0.65`) and saturation boost (`saturation = 1.2`)
 * to an RGB triplet.
 */
function attenuateAndSaturateRgb(
  r: number,
  g: number,
  b: number,
  dimOpacity: number,
  saturation: number,
): readonly [number, number, number] {
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const satR = luma + (r - luma) * saturation;
  const satG = luma + (g - luma) * saturation;
  const satB = luma + (b - luma) * saturation;
  return [
    clamp(Math.round(satR * dimOpacity), 0, 255),
    clamp(Math.round(satG * dimOpacity), 0, 255),
    clamp(Math.round(satB * dimOpacity), 0, 255),
  ];
}

/**
 * Pure deterministic RGBA pixel-buffer compositor for `<BlurredFitView />`.
 *
 * Composites:
 * 1. Scaled-to-fill 9:16 background with separable box-blur approximation of
 *    Gaussian blur ($\sigma \approx 35\text{px}$), darkened by 35% (`dimOpacity = 0.65`)
 *    and boosted saturation (`1.2x`), with zero edge bleed.
 * 2. Soft drop shadow beneath the foreground 16:9 frame.
 * 3. Un-cropped 16:9 foreground video (`1080 x 608` at `y = 656`) with `16px`
 *    anti-aliased rounded corners (`borderRadius`) so there are zero harsh boundary
 *    artifacts between the blurred backdrop and the foreground video.
 */
export function compositeBlurredFitRgbaFrame(params: {
  readonly sourceRgba: Uint8Array;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly canvasWidth?: number;
  readonly canvasHeight?: number;
  readonly blurRadius?: number;
  readonly dimOpacity?: number;
  readonly saturation?: number;
  readonly borderRadius?: number;
  readonly foregroundY?: number;
  readonly captionZoneY?: number;
}): Uint8Array {
  const geom = computeBlurredFitGeometry(params.sourceWidth, params.sourceHeight, {
    ...(params.canvasWidth === undefined ? {} : { canvasWidth: params.canvasWidth }),
    ...(params.canvasHeight === undefined ? {} : { canvasHeight: params.canvasHeight }),
    ...(params.blurRadius === undefined ? {} : { blurRadius: params.blurRadius }),
    ...(params.dimOpacity === undefined ? {} : { dimOpacity: params.dimOpacity }),
    ...(params.saturation === undefined ? {} : { saturation: params.saturation }),
    ...(params.borderRadius === undefined ? {} : { borderRadius: params.borderRadius }),
    ...(params.foregroundY === undefined ? {} : { foregroundY: params.foregroundY }),
    ...(params.captionZoneY === undefined ? {} : { captionZoneY: params.captionZoneY }),
  });

  const { canvasWidth, canvasHeight, foregroundWidth, foregroundHeight, foregroundX, foregroundY } =
    geom;
  const out = new Uint8Array(canvasWidth * canvasHeight * 4);
  const bgRaw = new Uint8Array(canvasWidth * canvasHeight * 4);

  // 1. Scale 16:9 source to fill 9:16 background canvas (aspect-ratio increase + center crop)
  const bgScale = Math.max(canvasWidth / params.sourceWidth, canvasHeight / params.sourceHeight);
  const bgCropW = canvasWidth / bgScale;
  const bgCropH = canvasHeight / bgScale;
  const bgStartX = (params.sourceWidth - bgCropW) / 2;
  const bgStartY = (params.sourceHeight - bgCropH) / 2;

  for (let dstY = 0; dstY < canvasHeight; dstY += 1) {
    const srcY = clamp(
      Math.floor(bgStartY + ((dstY + 0.5) / canvasHeight) * bgCropH),
      0,
      params.sourceHeight - 1,
    );
    for (let dstX = 0; dstX < canvasWidth; dstX += 1) {
      const srcX = clamp(
        Math.floor(bgStartX + ((dstX + 0.5) / canvasWidth) * bgCropW),
        0,
        params.sourceWidth - 1,
      );
      const srcIdx = (srcY * params.sourceWidth + srcX) * 4;
      const dstIdx = (dstY * canvasWidth + dstX) * 4;
      bgRaw[dstIdx] = params.sourceRgba[srcIdx] ?? 0;
      bgRaw[dstIdx + 1] = params.sourceRgba[srcIdx + 1] ?? 0;
      bgRaw[dstIdx + 2] = params.sourceRgba[srcIdx + 2] ?? 0;
      bgRaw[dstIdx + 3] = 255;
    }
  }

  // 2. Separable horizontal + vertical box blur + luminance attenuation & saturation boost
  const scaledKernelRadius = clamp(
    Math.round((geom.blurRadius * canvasWidth) / BLURRED_FIT_CANVAS_WIDTH),
    2,
    40,
  );
  const horiz = new Uint8Array(canvasWidth * canvasHeight * 4);

  for (let y = 0; y < canvasHeight; y += 1) {
    for (let x = 0; x < canvasWidth; x += 1) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let count = 0;
      const x0 = Math.max(0, x - scaledKernelRadius);
      const x1 = Math.min(canvasWidth - 1, x + scaledKernelRadius);
      for (let kx = x0; kx <= x1; kx += 1) {
        const idx = (y * canvasWidth + kx) * 4;
        rSum += bgRaw[idx] ?? 0;
        gSum += bgRaw[idx + 1] ?? 0;
        bSum += bgRaw[idx + 2] ?? 0;
        count += 1;
      }
      const dstIdx = (y * canvasWidth + x) * 4;
      horiz[dstIdx] = Math.round(rSum / count);
      horiz[dstIdx + 1] = Math.round(gSum / count);
      horiz[dstIdx + 2] = Math.round(bSum / count);
      horiz[dstIdx + 3] = 255;
    }
  }

  for (let y = 0; y < canvasHeight; y += 1) {
    const y0 = Math.max(0, y - scaledKernelRadius);
    const y1 = Math.min(canvasHeight - 1, y + scaledKernelRadius);
    const count = y1 - y0 + 1;
    for (let x = 0; x < canvasWidth; x += 1) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      for (let ky = y0; ky <= y1; ky += 1) {
        const idx = (ky * canvasWidth + x) * 4;
        rSum += horiz[idx] ?? 0;
        gSum += horiz[idx + 1] ?? 0;
        bSum += horiz[idx + 2] ?? 0;
      }
      const [r, g, b] = attenuateAndSaturateRgb(
        rSum / count,
        gSum / count,
        bSum / count,
        geom.dimOpacity,
        geom.saturation,
      );
      const dstIdx = (y * canvasWidth + x) * 4;
      out[dstIdx] = r;
      out[dstIdx + 1] = g;
      out[dstIdx + 2] = b;
      out[dstIdx + 3] = 255;
    }
  }

  // 3. Foreground un-cropped 16:9 layer with anti-aliased rounded corners & soft shadow falloff
  const scaledRadius =
    params.borderRadius !== undefined
      ? clamp(geom.borderRadius, 0, Math.floor(Math.min(foregroundWidth, foregroundHeight) / 2))
      : Math.max(4, Math.round((geom.borderRadius * canvasWidth) / BLURRED_FIT_CANVAS_WIDTH));
  const shadowBlurPx = Math.max(2, Math.round((24 * canvasHeight) / BLURRED_FIT_CANVAS_HEIGHT));
  const shadowOffsetY = Math.max(1, Math.round((12 * canvasHeight) / BLURRED_FIT_CANVAS_HEIGHT));

  const bandTop = Math.max(0, foregroundY - shadowBlurPx);
  const bandBottom = Math.min(canvasHeight - 1, foregroundY + foregroundHeight + shadowBlurPx + shadowOffsetY);

  for (let dstY = bandTop; dstY <= bandBottom; dstY += 1) {
    const localY = dstY - foregroundY;
    for (let dstX = 0; dstX < canvasWidth; dstX += 1) {
      const localX = dstX - foregroundX;
      const sdf = roundedRectSignedDistance(
        localX,
        localY,
        foregroundWidth,
        foregroundHeight,
        scaledRadius,
      );
      const dstIdx = (dstY * canvasWidth + dstX) * 4;
      const bgR = out[dstIdx] ?? 0;
      const bgG = out[dstIdx + 1] ?? 0;
      const bgB = out[dstIdx + 2] ?? 0;

      // Apply soft ambient drop shadow outside the rounded rect
      let baseR = bgR;
      let baseG = bgG;
      let baseB = bgB;
      if (sdf > -0.5) {
        const shadowSdf = roundedRectSignedDistance(
          localX,
          localY - shadowOffsetY,
          foregroundWidth,
          foregroundHeight,
          scaledRadius,
        );
        if (shadowSdf > 0 && shadowSdf < shadowBlurPx) {
          const shadowAlpha = 0.45 * (1 - shadowSdf / shadowBlurPx);
          baseR = Math.round(bgR * (1 - shadowAlpha));
          baseG = Math.round(bgG * (1 - shadowAlpha));
          baseB = Math.round(bgB * (1 - shadowAlpha));
        }
      }

      if (sdf >= 0.5) {
        out[dstIdx] = baseR;
        out[dstIdx + 1] = baseG;
        out[dstIdx + 2] = baseB;
        continue;
      }

      // Sample un-cropped 16:9 foreground pixel
      const srcX = clamp(
        Math.floor(((localX + 0.5) / foregroundWidth) * params.sourceWidth),
        0,
        params.sourceWidth - 1,
      );
      const srcY = clamp(
        Math.floor(((localY + 0.5) / foregroundHeight) * params.sourceHeight),
        0,
        params.sourceHeight - 1,
      );
      const srcIdx = (srcY * params.sourceWidth + srcX) * 4;
      const fgR = params.sourceRgba[srcIdx] ?? 0;
      const fgG = params.sourceRgba[srcIdx + 1] ?? 0;
      const fgB = params.sourceRgba[srcIdx + 2] ?? 0;

      // Anti-aliased boundary blend over [-0.5, +0.5] to guarantee zero harsh boundary artifacts
      const fgAlpha = sdf <= -0.5 ? 1 : 0.5 - sdf;
      out[dstIdx] = Math.round(fgR * fgAlpha + baseR * (1 - fgAlpha));
      out[dstIdx + 1] = Math.round(fgG * fgAlpha + baseG * (1 - fgAlpha));
      out[dstIdx + 2] = Math.round(fgB * fgAlpha + baseB * (1 - fgAlpha));
      out[dstIdx + 3] = 255;
    }
  }

  return out;
}
