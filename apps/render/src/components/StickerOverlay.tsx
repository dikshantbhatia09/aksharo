/** @jsx h */
/** @jsxFrag Fragment */
/**
 * Sticker, Meme & Reaction GIF Remotion Layer & Compositor (Pillar 6 §04).
 *
 * Implements Submagic & CapCut grade reaction overlay compositing:
 * - Spring Pop entrance physics: 1.1x spring overshoot settling to 1.0x within 250ms.
 * - Normalized coordinate placement (x, y in [0, 1] mapped to canvas width/height).
 * - Full alpha-channel transparency preservation (yuva420p WebM / transparent APNG).
 * - Scaling (0.1x - 5.0x), rotation (-360deg to +360deg), and fade-out dissolve.
 */

import {
  Fragment,
  OffthreadVideo,
  findVNodeByTestId,
  findVNodesByType,
  h,
  type SplitScreenStyle,
  type SplitScreenVNode,
} from "./SplitScreenView.js";

export { Fragment, OffthreadVideo, findVNodeByTestId, findVNodesByType, h };

export const DEFAULT_STICKER_FPS = 30;
export const STICKER_CANVAS_WIDTH = 1080;
export const STICKER_CANVAS_HEIGHT = 1920;
export const DEFAULT_SPRING_POP_DURATION_SEC = 0.25; // 250ms spring entrance
export const DEFAULT_SPRING_OVERSHOOT = 0.20; // 1.10x peak pop

export interface SequenceProps {
  readonly from: number;
  readonly durationInFrames: number;
  readonly style?: SplitScreenStyle;
  readonly children?: readonly (SplitScreenVNode | string)[];
  readonly "data-testid"?: string;
}

export function Sequence(props: SequenceProps): SplitScreenVNode {
  return {
    type: "Sequence",
    props: {
      from: props.from,
      durationInFrames: props.durationInFrames,
      style: props.style,
      "data-testid": props["data-testid"],
      children: props.children ?? [],
    },
  };
}

export interface StickerOverlayProps {
  /** Direct URL to sticker WebM, GIF, or WebP */
  readonly stickerSrc: string;
  /** Primary video background source (optional) */
  readonly mainVideoSrc?: string;
  /** Timeline start in seconds */
  readonly startSec: number;
  /** Timeline end in seconds */
  readonly endSec: number;
  /** Current playhead time in seconds */
  readonly currentTimeSec: number;
  /** Normalized center X position in [0, 1] (default: 0.5) */
  readonly x?: number;
  /** Normalized center Y position in [0, 1] (default: 0.5) */
  readonly y?: number;
  /** Visual scale multiplier (default: 1.0) */
  readonly scale?: number;
  /** Rotation angle in degrees (default: 0) */
  readonly rotation?: number;
  /** Opacity in [0, 1] (default: 1.0) */
  readonly opacity?: number;
  /** Whether the media asset features alpha transparency (default: true) */
  readonly isTransparent?: boolean;
  /** Native sticker pixel width (default: 380) */
  readonly stickerWidth?: number;
  /** Native sticker pixel height (default: 380) */
  readonly stickerHeight?: number;
  /** Canvas width in pixels (default: 1080) */
  readonly canvasWidth?: number;
  /** Canvas height in pixels (default: 1920) */
  readonly canvasHeight?: number;
  /** Composition framerate (default: 30) */
  readonly fps?: number;
  readonly "data-testid"?: string;
  readonly style?: SplitScreenStyle;
}

/**
 * Calculates damped spring pop scale multiplier during entrance.
 * Peaks at ~1.10x at ~100ms and settles to 1.0x by 250ms.
 */
export function computeStickerSpringPopScale(
  timeFromStartSec: number,
  baseScale: number = 1.0,
  durationSec: number = DEFAULT_SPRING_POP_DURATION_SEC,
): number {
  if (timeFromStartSec < 0) {
    return 0.0;
  }
  if (timeFromStartSec >= durationSec) {
    return baseScale;
  }

  const p = timeFromStartSec / durationSec;
  // Damped sinusoidal spring equation
  const springMultiplier = 1.0 + DEFAULT_SPRING_OVERSHOOT * Math.sin(p * Math.PI) * Math.exp(-1.5 * p);
  const effectiveScale = baseScale * springMultiplier;

  return Math.round(effectiveScale * 1000) / 1000;
}

/**
 * Calculates sticker opacity during entrance and exit ramps.
 */
export function computeStickerOpacity(
  currentTimeSec: number,
  startSec: number,
  endSec: number,
  baseOpacity: number = 1.0,
): number {
  if (currentTimeSec < startSec || currentTimeSec > endSec) {
    return 0.0;
  }

  const duration = Math.max(0.1, endSec - startSec);
  const exitRampSec = Math.min(0.15, duration / 3);
  const timeToEnd = endSec - currentTimeSec;

  let factor = 1.0;
  if (timeToEnd < exitRampSec) {
    factor = timeToEnd / exitRampSec;
  }

  return Math.max(0.0, Math.min(1.0, Math.round(baseOpacity * factor * 100) / 100));
}

/**
 * Remotion `<StickerOverlay />` component:
 * Composites sticker / meme over talking-head video with spring pop physics,
 * clean alpha channel blending, and drag-and-drop coordinate resolution.
 */
export function StickerOverlay(props: StickerOverlayProps): SplitScreenVNode {
  const {
    stickerSrc,
    mainVideoSrc,
    startSec,
    endSec,
    currentTimeSec,
    x = 0.5,
    y = 0.5,
    scale = 1.0,
    rotation = 0,
    opacity = 1.0,
    isTransparent = true,
    stickerWidth = 380,
    stickerHeight = 380,
    canvasWidth = STICKER_CANVAS_WIDTH,
    canvasHeight = STICKER_CANVAS_HEIGHT,
    fps = DEFAULT_STICKER_FPS,
    "data-testid": testId = "sticker-overlay-root",
  } = props;

  const durationSec = Math.max(0.01, endSec - startSec);
  const fromFrame = Math.max(0, Math.round(startSec * fps));
  const durationInFrames = Math.max(1, Math.round(durationSec * fps));

  const timeFromStart = currentTimeSec - startSec;
  const springScale = computeStickerSpringPopScale(timeFromStart, scale);
  const effectiveOpacity = computeStickerOpacity(currentTimeSec, startSec, endSec, opacity);

  const leftPx = Math.round(x * canvasWidth);
  const topPx = Math.round(y * canvasHeight);

  const isVideoFormat =
    stickerSrc.toLowerCase().endsWith(".webm") ||
    stickerSrc.toLowerCase().endsWith(".mp4");

  return (
    <div
      data-testid={testId}
      style={{
        position: "relative",
        width: canvasWidth,
        height: canvasHeight,
        overflow: "hidden",
        backgroundColor: "#000000",
      }}
    >
      {/* Layer 1: Background main video stream (if provided) */}
      {mainVideoSrc ? (
        <OffthreadVideo
          src={mainVideoSrc}
          data-testid="sticker-main-video"
          muted={false}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: canvasWidth,
            height: canvasHeight,
            objectFit: "cover",
            zIndex: 1,
          }}
        />
      ) : null}

      {/* Layer 2: Time-gated Sticker Sequence with Spring Pop entrance */}
      <Sequence
        from={fromFrame}
        durationInFrames={durationInFrames}
        data-testid="sticker-sequence-gate"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: canvasWidth,
          height: canvasHeight,
          pointerEvents: "none",
          zIndex: 20,
        }}
      >
        <div
          data-testid="sticker-container"
          style={{
            position: "absolute",
            left: `${leftPx}px`,
            top: `${topPx}px`,
            width: stickerWidth,
            height: stickerHeight,
            transform: `translate(-50%, -50%) scale(${springScale}) rotate(${rotation}deg)`,
            transformOrigin: "center center",
            opacity: effectiveOpacity,
            backgroundColor: "transparent",
            display: currentTimeSec >= startSec && currentTimeSec <= endSec ? "block" : "none",
            filter: isTransparent ? "drop-shadow(0px 8px 16px rgba(0,0,0,0.35))" : "none",
          }}
        >
          {isVideoFormat ? (
            <OffthreadVideo
              src={stickerSrc}
              muted={true}
              data-testid="sticker-media-video"
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
                backgroundColor: "transparent",
              }}
            />
          ) : (
            <img
              src={stickerSrc}
              alt="reaction-overlay"
              data-testid="sticker-media-image"
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
                backgroundColor: "transparent",
                pointerEvents: "none",
              }}
            />
          )}
        </div>
      </Sequence>
    </div>
  );
}
