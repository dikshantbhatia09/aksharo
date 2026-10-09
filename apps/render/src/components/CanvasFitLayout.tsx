/** @jsx h */
/** @jsxFrag Fragment */
/**
 * Pillar 3 §04 — Screen Share & Presentation Slide Detection Engine
 * (Smart Canvas Fit / PIP)
 *
 * Implements the `<CanvasFitLayout />` / `<SmartCanvasFit />` Remotion layout
 * component, FFmpeg filtergraph builder, and deterministic RGBA buffer
 * compositor for rendering 16:9 screen shares, presentation slides, code
 * editors, and spreadsheets inside a 9:16 (`1080 x 1920`) vertical canvas
 * with zero cropped text:
 * - Background Layer: `<OffthreadVideo style={{ filter: 'blur(30px) brightness(0.6)', transform: 'scale(1.4)' }} />`
 *   filling the entire `1080 x 1920` canvas.
 * - Foreground Layer: `<OffthreadVideo style={{ width: 1080, height: 608, objectFit: 'contain' }} />`
 *   centered vertically (`y = 656`) or placed in the upper half (`y = 360`)
 *   in "Presentation Fit" mode.
 * - Optional Presenter PIP Bubble: Crops the presenter's webcam corner into a
 *   `280px` circular Picture-in-Picture (PIP) bubble positioned at `top-right`
 *   or `bottom-center` of the vertical canvas.
 */

import {
  Fragment,
  OffthreadVideo,
  h,
  type SplitScreenCrop,
  type SplitScreenVNode,
} from "./SplitScreenView.js";

export type CropRect = SplitScreenCrop;
export type CanvasFitMode = "CANVAS_FIT" | "PIP_BUBBLE";
export type PresentationVerticalPlacement = "center" | "presentation-fit";
export type PipBubblePosition = "top-right" | "bottom-center";

export const CANVAS_FIT_WIDTH = 1080;
export const CANVAS_FIT_HEIGHT = 1920;
export const SLIDE_FIT_WIDTH = 1080;
export const SLIDE_FIT_HEIGHT = 608;
export const SLIDE_CENTER_Y = 656; // (1920 - 608) / 2
export const SLIDE_PRESENTATION_FIT_Y = 360;
export const PIP_BUBBLE_DIAMETER = 280;
export const PIP_BUBBLE_BORDER_PX = 4;

export interface PipPresenterConfig {
  /** Crop rectangle of the presenter webcam in source pixel coordinates. */
  readonly cropRect: CropRect;
  /** Target position of the 280px circular PIP bubble on the 9:16 canvas. */
  readonly position?: PipBubblePosition;
  /** Optional diameter override (defaults to 280px). */
  readonly diameter?: number;
  /** Optional border color around the circular PIP bubble (defaults to #FFFFFF). */
  readonly borderColor?: string;
}

export interface CanvasFitLayoutProps {
  readonly src: string;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly layoutMode?: CanvasFitMode;
  /**
   * Vertical placement of the 16:9 slide (`1080 x 608`):
   * - `'center'` -> `y = 656` (`(1920 - 608) / 2`)
   * - `'presentation-fit'` -> `y = 360` (upper half, leaving room for captions/PIP below)
   */
  readonly placement?: PresentationVerticalPlacement;
  /** Optional explicit Y coordinate override for the foreground slide. */
  readonly slideY?: number;
  /** Optional presenter webcam configuration for `PIP_BUBBLE` mode. */
  readonly presenterPip?: PipPresenterConfig;
  readonly canvasWidth?: number;
  readonly canvasHeight?: number;
  readonly startFrom?: number;
  readonly endAt?: number;
  readonly muted?: boolean;
  readonly volume?: number;
}

export interface ComputedSlideGeometry {
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
}

export interface ComputedPipBubbleGeometry {
  readonly diameter: number;
  readonly x: number;
  readonly y: number;
  readonly position: PipBubblePosition;
  readonly cropRect: CropRect;
  readonly borderColor: string;
}

/**
 * Compute the exact un-cropped 16:9 foreground slide geometry inside the
 * vertical 9:16 canvas (`1080 x 608` centered at `y = 656` or `y = 360`).
 */
export function computeSlideGeometry(
  sourceWidth: number,
  sourceHeight: number,
  options: {
    readonly canvasWidth?: number;
    readonly canvasHeight?: number;
    readonly placement?: PresentationVerticalPlacement;
    readonly slideY?: number;
  } = {},
): ComputedSlideGeometry {
  const canvasWidth = options.canvasWidth ?? CANVAS_FIT_WIDTH;
  const canvasHeight = options.canvasHeight ?? CANVAS_FIT_HEIGHT;
  const safeSourceWidth = Math.max(2, sourceWidth);
  const safeSourceHeight = Math.max(2, sourceHeight);

  const rawSlideHeight = Math.round((canvasWidth * safeSourceHeight) / safeSourceWidth);
  const height = Math.max(2, Math.min(canvasHeight, rawSlideHeight - (rawSlideHeight % 2)));
  const defaultY =
    options.placement === "presentation-fit"
      ? Math.round((SLIDE_PRESENTATION_FIT_Y / CANVAS_FIT_HEIGHT) * canvasHeight)
      : Math.floor((canvasHeight - height) / 2);
  const rawY = options.slideY ?? defaultY;
  const clampedY = Math.max(0, Math.min(canvasHeight - height, rawY));
  const y = clampedY - (clampedY % 2);

  return {
    width: canvasWidth,
    height,
    x: 0,
    y,
  };
}

/**
 * Compute the `280px` circular PIP presenter bubble placement on the 9:16 canvas.
 */
export function computePipBubbleGeometry(
  sourceWidth: number,
  sourceHeight: number,
  slide: ComputedSlideGeometry,
  pip: PipPresenterConfig,
  canvasWidth = CANVAS_FIT_WIDTH,
  canvasHeight = CANVAS_FIT_HEIGHT,
): ComputedPipBubbleGeometry {
  const scale = canvasHeight / CANVAS_FIT_HEIGHT;
  const rawDiameter = Math.round((pip.diameter ?? PIP_BUBBLE_DIAMETER) * scale);
  const diameter = Math.max(64, rawDiameter - (rawDiameter % 2));
  const position: PipBubblePosition = pip.position ?? "top-right";
  const margin = Math.max(16, Math.round(48 * scale));

  let rawX: number;
  let rawY: number;
  if (position === "bottom-center") {
    rawX = Math.floor((canvasWidth - diameter) / 2);
    const belowSlideRemaining = canvasHeight - (slide.y + slide.height);
    rawY =
      belowSlideRemaining >= diameter + margin
        ? slide.y + slide.height + Math.floor((belowSlideRemaining - diameter) / 2)
        : canvasHeight - diameter - margin;
  } else {
    rawX = canvasWidth - diameter - margin;
    rawY = Math.max(margin, Math.min(slide.y - diameter - Math.floor(margin / 2), margin * 2));
  }

  const clampedX = Math.max(0, Math.min(canvasWidth - diameter, rawX));
  const clampedY = Math.max(0, Math.min(canvasHeight - diameter, rawY));

  const cropWidth = Math.max(2, Math.min(sourceWidth, Math.floor(pip.cropRect.width)));
  const cropHeight = Math.max(2, Math.min(sourceHeight, Math.floor(pip.cropRect.height)));
  const cropX = Math.max(0, Math.min(sourceWidth - cropWidth, Math.floor(pip.cropRect.x)));
  const cropY = Math.max(0, Math.min(sourceHeight - cropHeight, Math.floor(pip.cropRect.y)));

  return {
    diameter,
    x: clampedX - (clampedX % 2),
    y: clampedY - (clampedY % 2),
    position,
    cropRect: {
      x: cropX,
      y: cropY,
      width: cropWidth,
      height: cropHeight,
    },
    borderColor: pip.borderColor ?? "#FFFFFF",
  };
}

/**
 * `<CanvasFitLayout />` Remotion component.
 *
 * Renders:
 * 1. Full-canvas blurred ambient background layer (`blur(30px) brightness(0.6)` + `scale(1.4)`).
 * 2. Un-cropped 16:9 foreground presentation slide (`1080 x 608`, `objectFit: 'contain'`).
 * 3. Optional `280px` circular presenter PIP bubble (`borderRadius: '50%'`).
 */
export function CanvasFitLayout(props: CanvasFitLayoutProps): SplitScreenVNode {
  const canvasWidth = props.canvasWidth ?? CANVAS_FIT_WIDTH;
  const canvasHeight = props.canvasHeight ?? CANVAS_FIT_HEIGHT;
  const layoutMode: CanvasFitMode =
    props.layoutMode ?? (props.presenterPip !== undefined ? "PIP_BUBBLE" : "CANVAS_FIT");

  const slide = computeSlideGeometry(props.sourceWidth, props.sourceHeight, {
    canvasWidth,
    canvasHeight,
    ...(props.placement === undefined ? {} : { placement: props.placement }),
    ...(props.slideY === undefined ? {} : { slideY: props.slideY }),
  });

  const pipGeometry =
    layoutMode === "PIP_BUBBLE" && props.presenterPip !== undefined
      ? computePipBubbleGeometry(
          props.sourceWidth,
          props.sourceHeight,
          slide,
          props.presenterPip,
          canvasWidth,
          canvasHeight,
        )
      : null;

  const pipScaleX =
    pipGeometry !== null ? pipGeometry.diameter / Math.max(1, pipGeometry.cropRect.width) : 1;
  const pipScaleY =
    pipGeometry !== null ? pipGeometry.diameter / Math.max(1, pipGeometry.cropRect.height) : 1;
  const pipScale = Math.max(pipScaleX, pipScaleY);

  return (
    <div
      data-testid="canvas-fit-layout"
      data-layout-mode={layoutMode}
      style={{
        position: "relative",
        width: `${String(canvasWidth)}px`,
        height: `${String(canvasHeight)}px`,
        overflow: "hidden",
        backgroundColor: "#000000",
      }}
    >
      {/* Background Layer: Ambient blurred & darkened 9:16 backdrop */}
      <div
        data-testid="canvas-fit-background"
        style={{
          position: "absolute",
          top: "0px",
          left: "0px",
          width: `${String(canvasWidth)}px`,
          height: `${String(canvasHeight)}px`,
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
            width: `${String(canvasWidth)}px`,
            height: `${String(canvasHeight)}px`,
            objectFit: "cover",
            filter: "blur(30px) brightness(0.6)",
            transform: "scale(1.4)",
            transformOrigin: "center center",
          }}
        />
      </div>

      {/* Foreground Layer: Un-cropped 16:9 slide fit cleanly into 1080 x 608 */}
      <div
        data-testid="canvas-fit-foreground"
        data-slide-width={slide.width}
        data-slide-height={slide.height}
        data-slide-y={slide.y}
        style={{
          position: "absolute",
          left: `${String(slide.x)}px`,
          top: `${String(slide.y)}px`,
          width: `${String(slide.width)}px`,
          height: `${String(slide.height)}px`,
          overflow: "hidden",
          boxShadow: "0 16px 48px rgba(0, 0, 0, 0.45)",
        }}
      >
        <OffthreadVideo
          src={props.src}
          {...(props.muted === undefined ? {} : { muted: props.muted })}
          {...(props.volume === undefined ? {} : { volume: props.volume })}
          {...(props.startFrom === undefined ? {} : { startFrom: props.startFrom })}
          {...(props.endAt === undefined ? {} : { endAt: props.endAt })}
          style={{
            width: `${String(slide.width)}px`,
            height: `${String(slide.height)}px`,
            objectFit: "contain",
          }}
        />
      </div>

      {/* Optional Presenter PIP Bubble (280px circular mask) */}
      {pipGeometry !== null ? (
        <div
          data-testid="canvas-fit-pip-bubble"
          data-pip-position={pipGeometry.position}
          data-pip-diameter={pipGeometry.diameter}
          style={{
            position: "absolute",
            left: `${String(pipGeometry.x)}px`,
            top: `${String(pipGeometry.y)}px`,
            width: `${String(pipGeometry.diameter)}px`,
            height: `${String(pipGeometry.diameter)}px`,
            borderRadius: "50%",
            overflow: "hidden",
            border: `${String(PIP_BUBBLE_BORDER_PX)}px solid ${pipGeometry.borderColor}`,
            boxShadow: "0 12px 32px rgba(0, 0, 0, 0.5)",
            zIndex: 2,
          }}
        >
          <OffthreadVideo
            src={props.src}
            muted={true}
            volume={0}
            {...(props.startFrom === undefined ? {} : { startFrom: props.startFrom })}
            {...(props.endAt === undefined ? {} : { endAt: props.endAt })}
            style={{
              position: "absolute",
              left: "0px",
              top: "0px",
              width: `${String(Math.round(props.sourceWidth * pipScale))}px`,
              height: `${String(Math.round(props.sourceHeight * pipScale))}px`,
              transform: `translate(${String(-Math.round(pipGeometry.cropRect.x * pipScale))}px, ${String(-Math.round(pipGeometry.cropRect.y * pipScale))}px)`,
              transformOrigin: "top left",
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Alias matching the Architecture & Implementation Plan (`SmartCanvasFit`). */
export const SmartCanvasFit = CanvasFitLayout;

/**
 * Build the FFmpeg filtergraph corresponding to `<CanvasFitLayout />`.
 */
export function buildCanvasFitFfmpegFilter(props: CanvasFitLayoutProps): string {
  const canvasWidth = props.canvasWidth ?? CANVAS_FIT_WIDTH;
  const canvasHeight = props.canvasHeight ?? CANVAS_FIT_HEIGHT;
  const layoutMode: CanvasFitMode =
    props.layoutMode ?? (props.presenterPip !== undefined ? "PIP_BUBBLE" : "CANVAS_FIT");
  const slide = computeSlideGeometry(props.sourceWidth, props.sourceHeight, {
    canvasWidth,
    canvasHeight,
    ...(props.placement === undefined ? {} : { placement: props.placement }),
    ...(props.slideY === undefined ? {} : { slideY: props.slideY }),
  });

  if (layoutMode === "PIP_BUBBLE" && props.presenterPip !== undefined) {
    const pip = computePipBubbleGeometry(
      props.sourceWidth,
      props.sourceHeight,
      slide,
      props.presenterPip,
      canvasWidth,
      canvasHeight,
    );
    const radius = Math.floor(pip.diameter / 2);
    return [
      `scale=${String(props.sourceWidth)}:${String(props.sourceHeight)},split=3[bg_in][fg_in][pip_in]`,
      `[bg_in]scale=${String(canvasWidth)}:${String(canvasHeight)}:force_original_aspect_ratio=increase:flags=bicubic,crop=${String(canvasWidth)}:${String(canvasHeight)},gblur=sigma=30,eq=brightness=-0.12[bg]`,
      `[fg_in]scale=${String(slide.width)}:${String(slide.height)}:flags=bicubic,setsar=1[fg]`,
      `[bg][fg]overlay=(W-w)/2:${String(slide.y)}[base]`,
      `[pip_in]crop=${String(pip.cropRect.width)}:${String(pip.cropRect.height)}:${String(pip.cropRect.x)}:${String(pip.cropRect.y)},scale=${String(pip.diameter)}:${String(pip.diameter)}:flags=bicubic,format=yuva420p,geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':a='if(lte(hypot(X-${String(radius)},Y-${String(radius)}),${String(radius)}),255,0)'[pip]`,
      `[base][pip]overlay=${String(pip.x)}:${String(pip.y)},setsar=1,format=yuv420p`,
    ].join(";");
  }

  return [
    `scale=${String(props.sourceWidth)}:${String(props.sourceHeight)},split=2[bg_in][fg_in]`,
    `[bg_in]scale=${String(canvasWidth)}:${String(canvasHeight)}:force_original_aspect_ratio=increase:flags=bicubic,crop=${String(canvasWidth)}:${String(canvasHeight)},gblur=sigma=30,eq=brightness=-0.12[bg]`,
    `[fg_in]scale=${String(slide.width)}:${String(slide.height)}:flags=bicubic,setsar=1[fg]`,
    `[bg][fg]overlay=(W-w)/2:${String(slide.y)},setsar=1,format=yuv420p`,
  ].join(";");
}

function parseHexRgba(hex: string): readonly [number, number, number, number] {
  const clean = hex.replace(/^#/, "");
  if (clean.length === 6) {
    const r = Number.parseInt(clean.slice(0, 2), 16);
    const g = Number.parseInt(clean.slice(2, 4), 16);
    const b = Number.parseInt(clean.slice(4, 6), 16);
    if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
      return [r, g, b, 255];
    }
  }
  return [255, 255, 255, 255];
}

/**
 * Pure RGBA pixel-buffer compositor for `<CanvasFitLayout />` visual tests.
 *
 * Composites:
 * 1. Darkened (`brightness(0.6)`) & box-blurred (`scale(1.4)`) background filling
 *    the entire `canvasWidth x canvasHeight` 9:16 buffer.
 * 2. Un-cropped 16:9 foreground slide mapped across the full `slide.width x slide.height`
 *    region (`1080 x 608` centered at `y = 656` or `y = 360`), preserving 100% of
 *    horizontal slide content from `x = 0` to `x = sourceWidth - 1` (zero cropped text).
 * 3. Optional circular presenter PIP bubble (`diameter = 280`) with circular mask and border.
 */
export function compositeCanvasFitRgbaFrame(params: {
  readonly sourceRgba: Uint8Array;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly layoutMode?: CanvasFitMode;
  readonly placement?: PresentationVerticalPlacement;
  readonly slideY?: number;
  readonly presenterPip?: PipPresenterConfig;
  readonly canvasWidth?: number;
  readonly canvasHeight?: number;
}): Uint8Array {
  const canvasWidth = params.canvasWidth ?? CANVAS_FIT_WIDTH;
  const canvasHeight = params.canvasHeight ?? CANVAS_FIT_HEIGHT;
  const layoutMode: CanvasFitMode =
    params.layoutMode ?? (params.presenterPip !== undefined ? "PIP_BUBBLE" : "CANVAS_FIT");
  const out = new Uint8Array(canvasWidth * canvasHeight * 4);

  const slide = computeSlideGeometry(params.sourceWidth, params.sourceHeight, {
    canvasWidth,
    canvasHeight,
    ...(params.placement === undefined ? {} : { placement: params.placement }),
    ...(params.slideY === undefined ? {} : { slideY: params.slideY }),
  });

  // 1. Background layer: center-cropped cover + 1.4x zoom + brightness(0.6)
  const bgScale = Math.max(canvasWidth / params.sourceWidth, canvasHeight / params.sourceHeight) * 1.4;
  const bgCropW = params.sourceWidth / bgScale;
  const bgCropH = params.sourceHeight / bgScale;
  const bgStartX = (params.sourceWidth - bgCropW) / 2;
  const bgStartY = (params.sourceHeight - bgCropH) / 2;

  for (let dstY = 0; dstY < canvasHeight; dstY += 1) {
    const srcY = Math.min(
      params.sourceHeight - 1,
      Math.max(0, Math.floor(bgStartY + ((dstY + 0.5) / canvasHeight) * bgCropH)),
    );
    for (let dstX = 0; dstX < canvasWidth; dstX += 1) {
      const srcX = Math.min(
        params.sourceWidth - 1,
        Math.max(0, Math.floor(bgStartX + ((dstX + 0.5) / canvasWidth) * bgCropW)),
      );
      const srcIdx = (srcY * params.sourceWidth + srcX) * 4;
      const dstIdx = (dstY * canvasWidth + dstX) * 4;
      out[dstIdx] = Math.round((params.sourceRgba[srcIdx] ?? 0) * 0.6);
      out[dstIdx + 1] = Math.round((params.sourceRgba[srcIdx + 1] ?? 0) * 0.6);
      out[dstIdx + 2] = Math.round((params.sourceRgba[srcIdx + 2] ?? 0) * 0.6);
      out[dstIdx + 3] = 255;
    }
  }

  // 2. Foreground layer: full un-cropped 16:9 frame scaled into slide.width x slide.height
  for (let localY = 0; localY < slide.height; localY += 1) {
    const dstY = slide.y + localY;
    if (dstY < 0 || dstY >= canvasHeight) continue;
    const srcY = Math.min(
      params.sourceHeight - 1,
      Math.max(0, Math.floor(((localY + 0.5) / slide.height) * params.sourceHeight)),
    );
    for (let localX = 0; localX < slide.width; localX += 1) {
      const dstX = slide.x + localX;
      if (dstX < 0 || dstX >= canvasWidth) continue;
      const srcX = Math.min(
        params.sourceWidth - 1,
        Math.max(0, Math.floor(((localX + 0.5) / slide.width) * params.sourceWidth)),
      );
      const srcIdx = (srcY * params.sourceWidth + srcX) * 4;
      const dstIdx = (dstY * canvasWidth + dstX) * 4;
      out[dstIdx] = params.sourceRgba[srcIdx] ?? 0;
      out[dstIdx + 1] = params.sourceRgba[srcIdx + 1] ?? 0;
      out[dstIdx + 2] = params.sourceRgba[srcIdx + 2] ?? 0;
      out[dstIdx + 3] = params.sourceRgba[srcIdx + 3] ?? 255;
    }
  }

  // 3. Optional circular PIP bubble
  if (layoutMode === "PIP_BUBBLE" && params.presenterPip !== undefined) {
    const pip = computePipBubbleGeometry(
      params.sourceWidth,
      params.sourceHeight,
      slide,
      params.presenterPip,
      canvasWidth,
      canvasHeight,
    );
    const radius = pip.diameter / 2;
    const innerRadius = Math.max(1, radius - PIP_BUBBLE_BORDER_PX);
    const [bR, bG, bB, bA] = parseHexRgba(pip.borderColor);

    for (let localY = 0; localY < pip.diameter; localY += 1) {
      const dstY = pip.y + localY;
      if (dstY < 0 || dstY >= canvasHeight) continue;
      const dy = localY + 0.5 - radius;
      for (let localX = 0; localX < pip.diameter; localX += 1) {
        const dstX = pip.x + localX;
        if (dstX < 0 || dstX >= canvasWidth) continue;
        const dx = localX + 0.5 - radius;
        const dist = Math.hypot(dx, dy);
        if (dist > radius) continue;

        const dstIdx = (dstY * canvasWidth + dstX) * 4;
        if (dist >= innerRadius) {
          out[dstIdx] = bR;
          out[dstIdx + 1] = bG;
          out[dstIdx + 2] = bB;
          out[dstIdx + 3] = bA;
        } else {
          const srcX = Math.min(
            params.sourceWidth - 1,
            Math.max(
              0,
              pip.cropRect.x + Math.floor(((localX + 0.5) / pip.diameter) * pip.cropRect.width),
            ),
          );
          const srcY = Math.min(
            params.sourceHeight - 1,
            Math.max(
              0,
              pip.cropRect.y + Math.floor(((localY + 0.5) / pip.diameter) * pip.cropRect.height),
            ),
          );
          const srcIdx = (srcY * params.sourceWidth + srcX) * 4;
          out[dstIdx] = params.sourceRgba[srcIdx] ?? 0;
          out[dstIdx + 1] = params.sourceRgba[srcIdx + 1] ?? 0;
          out[dstIdx + 2] = params.sourceRgba[srcIdx + 2] ?? 0;
          out[dstIdx + 3] = 255;
        }
      }
    }
  }

  return out;
}
