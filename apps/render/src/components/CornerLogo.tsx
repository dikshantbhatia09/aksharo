/** @jsx h */
/** @jsxFrag Fragment */
/**
 * Corner Logo Bug Overlay Component (Pillar 6 §06).
 *
 * Implements Opus Clip / Submagic grade persistent corner logo branding:
 * - Safe margins: X = 60px, Y = 180px for TOP_LEFT (safe from top platform headers / stories UI).
 * - Multi-corner support: 'TOP_LEFT', 'TOP_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_RIGHT'.
 * - Configurable scale percentage (5% - 50% width, default 15%) and opacity (0.1 - 1.0, default 0.85).
 * - Dual target: Remotion JSX VNode element & Skia DrawCommand for native Skia rendering pipeline.
 */

import { type DrawCommand } from "@montaj/render-core";
import {
  Fragment,
  h,
  type SplitScreenStyle,
  type SplitScreenVNode,
} from "./SplitScreenView.js";

export { Fragment, h };

export type CornerLogoPosition = "TOP_LEFT" | "TOP_RIGHT" | "BOTTOM_LEFT" | "BOTTOM_RIGHT";

export const DEFAULT_CORNER_LOGO_CANVAS_WIDTH = 1080;
export const DEFAULT_CORNER_LOGO_CANVAS_HEIGHT = 1920;
export const DEFAULT_SAFE_TOP_Y = 180;
export const DEFAULT_SAFE_BOTTOM_Y_MARGIN = 240;
export const DEFAULT_SAFE_X_MARGIN = 60;
export const DEFAULT_LOGO_SCALE_PCT = 15;
export const DEFAULT_LOGO_OPACITY = 0.85;

export interface CornerLogoBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly right: number;
  readonly bottom: number;
}

export interface CornerLogoProps {
  /** Logo image source URI or asset identifier. */
  readonly logoSrc: string;
  /** Positioning corner bug placement. */
  readonly position?: CornerLogoPosition;
  /** Scale percentage relative to canvas width (5% - 50%, default 15%). */
  readonly scalePct?: number;
  /** Opacity fraction (0.1 - 1.0, default 0.85). */
  readonly opacity?: number;
  /** Aspect ratio of the logo image (height / width, default 1.0 square). */
  readonly aspect?: number;
  /** Canvas width in pixels (default 1080). */
  readonly canvasWidth?: number;
  /** Canvas height in pixels (default 1920). */
  readonly canvasHeight?: number;
  /** Optional custom inline style overrides. */
  readonly style?: SplitScreenStyle;
  readonly "data-testid"?: string;
}

/**
 * Clamps scale percentage between 5% and 50%.
 */
export function clampLogoScalePct(pct: number): number {
  if (Number.isNaN(pct)) return DEFAULT_LOGO_SCALE_PCT;
  return Math.max(5, Math.min(50, Math.round(pct)));
}

/**
 * Clamps opacity between 0.1 and 1.0.
 */
export function clampLogoOpacity(opacity: number): number {
  if (Number.isNaN(opacity)) return DEFAULT_LOGO_OPACITY;
  return Math.max(0.1, Math.min(1.0, Math.round(opacity * 100) / 100));
}

/**
 * Computes exact pixel placement for the corner logo bug within platform safe areas.
 */
export function computeCornerLogoBounds(options: {
  readonly position?: CornerLogoPosition;
  readonly scalePct?: number;
  readonly aspect?: number;
  readonly canvasWidth?: number;
  readonly canvasHeight?: number;
  readonly safeXMargin?: number;
  readonly safeTopY?: number;
  readonly safeBottomYMargin?: number;
}): CornerLogoBounds {
  const {
    position = "TOP_LEFT",
    scalePct = DEFAULT_LOGO_SCALE_PCT,
    aspect = 1.0,
    canvasWidth = DEFAULT_CORNER_LOGO_CANVAS_WIDTH,
    canvasHeight = DEFAULT_CORNER_LOGO_CANVAS_HEIGHT,
    safeXMargin = DEFAULT_SAFE_X_MARGIN,
    safeTopY = DEFAULT_SAFE_TOP_Y,
    safeBottomYMargin = DEFAULT_SAFE_BOTTOM_Y_MARGIN,
  } = options;

  const validScale = clampLogoScalePct(scalePct);
  const width = Math.round((canvasWidth * validScale) / 100);
  const height = Math.round(width * Math.max(0.1, aspect));

  let left = safeXMargin;
  let top = safeTopY;

  switch (position) {
    case "TOP_LEFT":
      left = safeXMargin;
      top = safeTopY;
      break;
    case "TOP_RIGHT":
      left = canvasWidth - safeXMargin - width;
      top = safeTopY;
      break;
    case "BOTTOM_LEFT":
      left = safeXMargin;
      top = canvasHeight - safeBottomYMargin - height;
      break;
    case "BOTTOM_RIGHT":
      left = canvasWidth - safeXMargin - width;
      top = canvasHeight - safeBottomYMargin - height;
      break;
  }

  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

/**
 * Remotion `<CornerLogo />` Component.
 * Renders the persistent branded logo bug at platform-safe corner coordinates.
 */
export function CornerLogo(props: CornerLogoProps): SplitScreenVNode {
  const {
    logoSrc,
    position = "TOP_LEFT",
    scalePct = DEFAULT_LOGO_SCALE_PCT,
    opacity = DEFAULT_LOGO_OPACITY,
    aspect = 1.0,
    canvasWidth = DEFAULT_CORNER_LOGO_CANVAS_WIDTH,
    canvasHeight = DEFAULT_CORNER_LOGO_CANVAS_HEIGHT,
    style,
    "data-testid": testId = "corner-logo",
  } = props;

  const bounds = computeCornerLogoBounds({
    position,
    scalePct,
    aspect,
    canvasWidth,
    canvasHeight,
  });

  const validOpacity = clampLogoOpacity(opacity);

  const logoStyle: SplitScreenStyle = {
    position: "absolute",
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
    opacity: validOpacity,
    zIndex: 40,
    pointerEvents: "none",
    objectFit: "contain",
    ...style,
  };

  return (
    <div
      data-testid={testId}
      data-position={position}
      data-scalepct={clampLogoScalePct(scalePct)}
      data-opacity={validOpacity}
      style={logoStyle}
    >
      <img
        src={logoSrc}
        data-testid={`${testId}-img`}
        alt="Brand Logo Bug"
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
        }}
      />
    </div>
  );
}

/**
 * Generates native Skia overlay DrawCommand for the corner logo bug.
 */
export function cornerLogoCommandFor(options: {
  readonly assetId: string;
  readonly position?: CornerLogoPosition;
  readonly scalePct?: number;
  readonly opacity?: number;
  readonly aspect?: number;
  readonly canvasWidth?: number;
  readonly canvasHeight?: number;
}): DrawCommand {
  const {
    assetId,
    position = "TOP_LEFT",
    scalePct = DEFAULT_LOGO_SCALE_PCT,
    opacity = DEFAULT_LOGO_OPACITY,
    aspect = 1.0,
    canvasWidth = DEFAULT_CORNER_LOGO_CANVAS_WIDTH,
    canvasHeight = DEFAULT_CORNER_LOGO_CANVAS_HEIGHT,
  } = options;

  const bounds = computeCornerLogoBounds({
    position,
    scalePct,
    aspect,
    canvasWidth,
    canvasHeight,
  });

  return {
    kind: "image",
    assetId,
    dest: [bounds.left, bounds.top, bounds.right, bounds.bottom],
    opacity: clampLogoOpacity(opacity),
  };
}
