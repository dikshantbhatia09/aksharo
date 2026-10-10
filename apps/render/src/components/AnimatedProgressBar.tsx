/** @jsx h */
/** @jsxFrag Fragment */
/**
 * Dynamic Animated Progress Bars & Timers (Pillar 6 §05).
 *
 * Implements Vidyo.ai, Submagic & Zubtitle grade video completion boosters:
 * - Frame-accurate 60fps duration sweeps across the canvas.
 * - Horizontal Progress Bar (SLIM_LINE): 4-8px clean bar sweeping 0% -> 100%.
 * - Neon Gradient Bar (NEON_GRADIENT): High-impact multi-color neon gradient with glowing lead cursor.
 * - Radial Countdown Clock (RADIAL_DIAL): Minimalist circular dial with animated stroke-dashoffset countdown.
 * - Strict platform safe-zone margin guarantee (TOP=160px, BOTTOM_SAFE=1450px) preventing UI occlusion.
 */

import {
  calculateProgressBarPlacement,
  DEFAULT_PROGRESS_BAR_SAFE_Y,
  DEFAULT_PROGRESS_BAR_TOP_Y,
  isProgressBarSafeFromOcclusion,
  type ProgressBarPosition,
  type ProgressBarSettings,
  type ProgressBarType,
  type SafeZonePlatform,
} from "@montaj/caption-styles";

import {
  Fragment as _Fragment,
  h as _h,
  type SplitScreenStyle,
  type SplitScreenVNode,
} from "./SplitScreenView.js";

export const h = _h;
export const Fragment = _Fragment;

export const DEFAULT_CANVAS_WIDTH = 1080;
export const DEFAULT_CANVAS_HEIGHT = 1920;
export const DEFAULT_BAR_HEIGHT_PX = 6;
export const DEFAULT_FILL_COLOR = "#00FFA3";
export const DEFAULT_TRACK_COLOR = "rgba(255, 255, 255, 0.25)";
export const DEFAULT_RADIAL_RADIUS = 32;
export const DEFAULT_RADIAL_STROKE = 5;

export interface AnimatedProgressBarProps {
  /** Whether the progress bar is enabled (default: true) */
  readonly enabled?: boolean;
  /** Visual style design type (default: 'SLIM_LINE') */
  readonly type?: ProgressBarType;
  /** Safe-zone anchoring position (default: 'BOTTOM_SAFE') */
  readonly position?: ProgressBarPosition;
  /** Height / thickness in pixels (default: 6) */
  readonly heightPx?: number;
  /** Fill hex color or gradient (default: '#00FFA3') */
  readonly fillColor?: string;
  /** Track background color (default: 'rgba(255, 255, 255, 0.25)') */
  readonly trackColor?: string;
  /** Whether neon glow is enabled (default: false, auto true for NEON_GRADIENT) */
  readonly glow?: boolean;
  /** Current playhead time in seconds */
  readonly currentTimeSec?: number;
  /** Total video duration in seconds */
  readonly durationSec?: number;
  /** Current frame index */
  readonly currentFrame?: number;
  /** Total frames count */
  readonly totalFrames?: number;
  /** Canvas width in pixels (default: 1080) */
  readonly canvasWidth?: number;
  /** Canvas height in pixels (default: 1920) */
  readonly canvasHeight?: number;
  /** Custom Y-coordinate override */
  readonly customY?: number;
  /** Social media platform for safe-zone checks */
  readonly platform?: SafeZonePlatform;
  /** Direct settings object from StyleDoc */
  readonly settings?: Partial<ProgressBarSettings>;
  /** Whether to render countdown text inside radial dial (default: true) */
  readonly showCountdownText?: boolean;
  readonly "data-testid"?: string;
  readonly style?: SplitScreenStyle;
}

/**
 * Computes normalized progress in [0.0, 1.0] from frame counts or timestamps.
 */
export function computeProgress(
  currentFrame?: number,
  totalFrames?: number,
  currentTimeSec?: number,
  durationSec?: number,
): number {
  if (totalFrames !== undefined && totalFrames > 0 && currentFrame !== undefined) {
    const p = currentFrame / totalFrames;
    return Math.max(0.0, Math.min(1.0, Math.round(p * 10000) / 10000));
  }
  if (durationSec !== undefined && durationSec > 0 && currentTimeSec !== undefined) {
    const p = currentTimeSec / durationSec;
    return Math.max(0.0, Math.min(1.0, Math.round(p * 10000) / 10000));
  }
  return 0.0;
}

/**
 * Computes filled width of the horizontal progress bar in pixels.
 */
export function computeProgressBarWidth(
  progress: number,
  canvasWidth: number = DEFAULT_CANVAS_WIDTH,
): number {
  const clamped = Math.max(0.0, Math.min(1.0, progress));
  return Math.round(clamped * canvasWidth * 100) / 100;
}

/**
 * Computes stroke-dashoffset for the radial dial countdown circle.
 */
export function computeRadialDashOffset(
  progress: number,
  radius: number = DEFAULT_RADIAL_RADIUS,
): number {
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0.0, Math.min(1.0, progress));
  const offset = circumference * (1 - clamped);
  return Math.round(offset * 100) / 100;
}

/**
 * Computes safe Y placement for the progress bar.
 */
export function computeProgressBarY(
  position: ProgressBarPosition = "BOTTOM_SAFE",
  canvasHeight: number = DEFAULT_CANVAS_HEIGHT,
  customY?: number,
): number {
  if (customY !== undefined) {
    return customY;
  }
  const ratio = canvasHeight / DEFAULT_CANVAS_HEIGHT;
  switch (position) {
    case "TOP":
      return Math.round(DEFAULT_PROGRESS_BAR_TOP_Y * ratio);
    case "BELOW_VIDEO":
      return Math.round(1264 * ratio);
    case "BOTTOM_SAFE":
    default:
      return Math.round(DEFAULT_PROGRESS_BAR_SAFE_Y * ratio);
  }
}

/**
 * Asserts whether a progress bar placement avoids platform occlusion chrome.
 */
export function validateSafeZoneCompliance(
  y: number,
  heightPx: number = DEFAULT_BAR_HEIGHT_PX,
  canvasHeight: number = DEFAULT_CANVAS_HEIGHT,
  platform: SafeZonePlatform = "universal",
): boolean {
  return isProgressBarSafeFromOcclusion(
    y,
    heightPx,
    platform,
    { width: DEFAULT_CANVAS_WIDTH, height: canvasHeight },
  );
}

/**
 * AnimatedProgressBar Remotion Composition Component.
 */
export function AnimatedProgressBar(props: AnimatedProgressBarProps): SplitScreenVNode {
  const {
    settings,
    enabled = settings?.enabled ?? true,
    type = settings?.type ?? "SLIM_LINE",
    position = settings?.position ?? "BOTTOM_SAFE",
    heightPx = settings?.heightPx ?? DEFAULT_BAR_HEIGHT_PX,
    fillColor = settings?.fillColor ?? DEFAULT_FILL_COLOR,
    trackColor = settings?.trackColor ?? DEFAULT_TRACK_COLOR,
    glow = settings?.glow ?? (type === "NEON_GRADIENT"),
    currentTimeSec,
    durationSec,
    currentFrame,
    totalFrames,
    canvasWidth = DEFAULT_CANVAS_WIDTH,
    canvasHeight = DEFAULT_CANVAS_HEIGHT,
    customY,
    platform = "universal",
    showCountdownText = true,
    "data-testid": testId = "animated-progress-bar-root",
    style: customStyle,
  } = props;

  // If disabled, return empty fragment
  if (!enabled) {
    return <Fragment />;
  }

  const progress = computeProgress(currentFrame, totalFrames, currentTimeSec, durationSec);
  const barWidth = computeProgressBarWidth(progress, canvasWidth);

  // Derive placement respecting safe zones
  const placement = calculateProgressBarPlacement({
    position,
    heightPx,
    canvas: { width: canvasWidth, height: canvasHeight },
    platform,
    customY,
  });

  const posY = placement.y;

  // 1. Radial Dial Countdown Mode
  if (type === "RADIAL_DIAL") {
    const radius = DEFAULT_RADIAL_RADIUS;
    const strokeWidth = heightPx > 2 ? heightPx : DEFAULT_RADIAL_STROKE;
    const circumference = 2 * Math.PI * radius;
    const dashOffset = computeRadialDashOffset(progress, radius);
    const size = (radius + strokeWidth) * 2 + 8;
    const center = size / 2;

    // Place in top-right safe zone
    const posX = canvasWidth - size - 40;
    const topY = position === "TOP" ? posY : Math.max(160, Math.round(160 * (canvasHeight / DEFAULT_CANVAS_HEIGHT)));

    const remainingSec = durationSec !== undefined && currentTimeSec !== undefined
      ? Math.max(0, Math.ceil(durationSec - currentTimeSec))
      : null;

    return (
      <div
        data-testid={testId}
        data-type="RADIAL_DIAL"
        data-progress={progress}
        style={{
          position: "absolute",
          left: `${posX}px`,
          top: `${topY}px`,
          width: `${size}px`,
          height: `${size}px`,
          pointerEvents: "none",
          zIndex: 40,
          ...customStyle,
        }}
      >
        <svg
          data-testid="radial-dial-svg"
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          style={{ transform: "rotate(-90deg)", transformOrigin: "center center" }}
        >
          {/* Background Track Circle */}
          <circle
            data-testid="radial-dial-track"
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={trackColor}
            strokeWidth={strokeWidth}
          />
          {/* Animated Progress Circle */}
          <circle
            data-testid="radial-dial-fill"
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={fillColor}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            style={{
              filter: glow ? `drop-shadow(0 0 8px ${fillColor})` : "none",
            }}
          />
        </svg>

        {showCountdownText && remainingSec !== null ? (
          <div
            data-testid="radial-countdown-text"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: `${size}px`,
              height: `${size}px`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#FFFFFF",
              fontSize: "14px",
              fontWeight: 700,
              fontFamily: "Inter, sans-serif",
              textShadow: "0 1px 3px rgba(0,0,0,0.8)",
            }}
          >
            {`${remainingSec}s`}
          </div>
        ) : null}
      </div>
    );
  }

  // 2. Horizontal Bar Modes (SLIM_LINE & NEON_GRADIENT)
  const isNeon = type === "NEON_GRADIENT";
  const fillGradient = isNeon
    ? `linear-gradient(90deg, #00E5FF, ${fillColor}, #00FFA3)`
    : fillColor;

  const glowBoxShadow = glow || isNeon
    ? `0 0 12px ${fillColor}, 0 0 24px rgba(0, 255, 163, 0.6)`
    : "none";

  const showLeadDot = isNeon && progress > 0.005 && progress < 0.999;
  const leadDotSize = Math.max(10, heightPx * 2);

  return (
    <div
      data-testid={testId}
      data-type={type}
      data-position={position}
      data-progress={progress}
      data-y={posY}
      style={{
        position: "absolute",
        left: "0px",
        top: `${posY}px`,
        width: `${canvasWidth}px`,
        height: `${heightPx}px`,
        pointerEvents: "none",
        zIndex: 40,
        ...customStyle,
      }}
    >
      {/* Background Track */}
      <div
        data-testid="progress-bar-track"
        style={{
          position: "absolute",
          left: "0px",
          top: "0px",
          width: "100%",
          height: "100%",
          backgroundColor: trackColor,
          borderRadius: `${heightPx / 2}px`,
        }}
      />

      {/* Active Fill Bar */}
      <div
        data-testid="progress-bar-fill"
        style={{
          position: "absolute",
          left: "0px",
          top: "0px",
          width: `${barWidth}px`,
          height: "100%",
          background: fillGradient,
          boxShadow: glowBoxShadow,
          borderRadius: `${heightPx / 2}px`,
          transition: "width 16ms linear",
        }}
      />

      {/* Glowing Leading Cursor Pill */}
      {showLeadDot ? (
        <div
          data-testid="progress-bar-lead-dot"
          style={{
            position: "absolute",
            left: `${barWidth}px`,
            top: `${heightPx / 2}px`,
            width: `${leadDotSize}px`,
            height: `${leadDotSize}px`,
            transform: "translate(-50%, -50%)",
            borderRadius: "50%",
            backgroundColor: "#FFFFFF",
            boxShadow: `0 0 10px #FFFFFF, 0 0 20px ${fillColor}, 0 0 30px #00FFA3`,
          }}
        />
      ) : null}
    </div>
  );
}
