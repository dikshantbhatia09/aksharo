/** @jsx h */
/** @jsxFrag Fragment */
/**
 * Context-Aware AI B-Roll Remotion Layer & Compositor (Pillar 6 §01).
 *
 * Implements Submagic & Opus Clip grade B-roll compositing over talking-head video:
 * - Layered Compositor Hierarchy:
 *   1. Layer 1 (Bottom): Primary talking-head speaker video
 *   2. Layer 2 (Middle): B-roll commercial stock footage overlay with 100ms crossfade
 *      dissolve and subtle Ken Burns camera motion (scale 1.0 -> 1.08 over clip duration)
 *   3. Layer 3 (Top): Kinetic subtitles & animated emojis permanently layered ABOVE
 *      the B-roll track so spoken words are never obscured.
 * - Render engine: Remotion `<Sequence>` and `<OffthreadVideo>` with audio strictly muted
 *   so primary speaker audio stream is preserved verbatim.
 * - FFmpeg multi-stream filtergraph builder with frame-accurate fade and Ken Burns zoompan.
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

export const DEFAULT_BROLL_FPS = 30;
export const DEFAULT_BROLL_DISSOLVE_SEC = 0.1; // 100ms dissolve crossfade (6 frames @ 60fps / 3 frames @ 30fps)
export const DEFAULT_KEN_BURNS_SCALE = 0.08; // 1.0 -> 1.08 subtle scale interpolation
export const BROLL_CANVAS_WIDTH = 1080;
export const BROLL_CANVAS_HEIGHT = 1920;

export type BrollMotion = "push-in" | "pull-out" | "pan-left" | "pan-right" | "none";
export type BrollMode = "full" | "pip";

export interface SequenceProps {
  readonly from: number;
  readonly durationInFrames: number;
  readonly style?: SplitScreenStyle;
  readonly children?: readonly (SplitScreenVNode | string)[];
  readonly "data-testid"?: string;
}

/**
 * Remotion `<Sequence>` component descriptor for time-gated rendering.
 */
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

export interface BrollOverlayProps {
  /** Source URI for the B-roll video clip (e.g. cached stock MP4). */
  readonly brollSrc: string;
  /** Primary talking-head source video URI. */
  readonly mainVideoSrc?: string;
  /** Timeline start in seconds. */
  readonly startSec: number;
  /** Timeline end in seconds. */
  readonly endSec: number;
  /** Active playback time in seconds. */
  readonly currentTimeSec: number;
  /** Composition framerate. */
  readonly fps?: number;
  /** Composition canvas width (default 1080). */
  readonly canvasWidth?: number;
  /** Composition canvas height (default 1920). */
  readonly canvasHeight?: number;
  /** Camera motion profile (push-in, pull-out, pan-left, pan-right, none). */
  readonly motion?: BrollMotion;
  /** Display mode: 'full' (fullscreen 9:16) or 'pip' (picture-in-picture box). */
  readonly mode?: BrollMode;
  /** Crossfade dissolve duration in seconds (default 0.1s = 100ms). */
  readonly dissolveSec?: number;
  /** Ken Burns maximum zoom scale delta (default 0.08). */
  readonly zoomScale?: number;
  /** Optional subtitle or emoji children elements to render permanently on top. */
  readonly subtitleChildren?: readonly (SplitScreenVNode | string)[];
  readonly style?: SplitScreenStyle;
  readonly "data-testid"?: string;
}

/**
 * Calculates Ken Burns CSS transform scale and translation.
 * - push-in: scales from 1.0x to (1.0 + zoomScale)x
 * - pull-out: scales from (1.0 + zoomScale)x down to 1.0x
 * - pan-left: holds scale and translates horizontally across frame
 * - pan-right: holds scale and translates horizontally across frame
 */
export function computeBrollKenBurnsTransform(
  progress01: number,
  motion: BrollMotion = "push-in",
  zoomScale: number = DEFAULT_KEN_BURNS_SCALE,
): { scale: number; translateX: number; translateY: number; transformString: string } {
  const p = Math.max(0, Math.min(1, progress01));
  let scale = 1.0;
  let translateX = 0;
  let translateY = 0;

  switch (motion) {
    case "push-in":
      scale = 1.0 + p * zoomScale;
      break;
    case "pull-out":
      scale = 1.0 + (1.0 - p) * zoomScale;
      break;
    case "pan-left":
      scale = 1.0 + zoomScale;
      translateX = (0.5 - p) * 40;
      break;
    case "pan-right":
      scale = 1.0 + zoomScale;
      translateX = -(0.5 - p) * 40;
      break;
    case "none":
    default:
      scale = 1.0;
      break;
  }

  const roundedScale = Math.round(scale * 10000) / 10000;
  const roundedX = Math.round(translateX * 100) / 100;
  const roundedY = Math.round(translateY * 100) / 100;

  let transformString = `scale(${roundedScale})`;
  if (roundedX !== 0 || roundedY !== 0) {
    transformString += ` translate(${roundedX}px, ${roundedY}px)`;
  }

  return { scale: roundedScale, translateX: roundedX, translateY: roundedY, transformString };
}

/**
 * Calculates opacity for 100ms dissolve crossfade in and out.
 */
export function computeBrollDissolveOpacity(
  currentTimeSec: number,
  startSec: number,
  endSec: number,
  dissolveSec: number = DEFAULT_BROLL_DISSOLVE_SEC,
): number {
  if (currentTimeSec < startSec || currentTimeSec > endSec) {
    return 0.0;
  }
  const duration = Math.max(0.1, endSec - startSec);
  const ramp = Math.min(dissolveSec, duration / 2);

  const timeFromStart = currentTimeSec - startSec;
  const timeToEnd = endSec - currentTimeSec;

  let opacity = 1.0;
  if (timeFromStart < ramp) {
    opacity = timeFromStart / ramp;
  } else if (timeToEnd < ramp) {
    opacity = timeToEnd / ramp;
  }

  return Math.max(0.0, Math.min(1.0, Math.round(opacity * 1000) / 1000));
}

/**
 * Remotion `<BrollOverlay />` component:
 * Renders primary video, B-roll overlay with Ken Burns zoom + 100ms crossfade, and kinetic subtitles on top.
 */
export function BrollOverlay(props: BrollOverlayProps): SplitScreenVNode {
  const {
    brollSrc,
    mainVideoSrc,
    startSec,
    endSec,
    currentTimeSec,
    fps = DEFAULT_BROLL_FPS,
    canvasWidth = BROLL_CANVAS_WIDTH,
    canvasHeight = BROLL_CANVAS_HEIGHT,
    motion = "push-in",
    mode = "full",
    dissolveSec = DEFAULT_BROLL_DISSOLVE_SEC,
    zoomScale = DEFAULT_KEN_BURNS_SCALE,
    subtitleChildren = [],
    "data-testid": testId = "broll-overlay-root",
  } = props;

  const durationSec = Math.max(0.01, endSec - startSec);
  const fromFrame = Math.max(0, Math.round(startSec * fps));
  const durationInFrames = Math.max(1, Math.round(durationSec * fps));

  const progress = (currentTimeSec - startSec) / durationSec;
  const { transformString } = computeBrollKenBurnsTransform(progress, motion, zoomScale);
  const opacity = computeBrollDissolveOpacity(currentTimeSec, startSec, endSec, dissolveSec);

  const isPip = mode === "pip";
  const pipWidth = Math.round(canvasWidth * 0.44);
  const pipHeight = Math.round(pipWidth * (16 / 9));

  const brollStyle: SplitScreenStyle = isPip
    ? {
        position: "absolute",
        top: 180,
        right: 48,
        width: pipWidth,
        height: pipHeight,
        borderRadius: 24,
        overflow: "hidden",
        boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
        zIndex: 20,
        opacity,
        transform: transformString,
      }
    : {
        position: "absolute",
        top: 0,
        left: 0,
        width: canvasWidth,
        height: canvasHeight,
        objectFit: "cover",
        zIndex: 10,
        opacity,
        transform: transformString,
      };

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
      {/* Layer 1: Primary Talking Head Video */}
      {mainVideoSrc ? (
        <OffthreadVideo
          src={mainVideoSrc}
          data-testid="broll-main-video"
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

      {/* Layer 2: B-Roll Video Track (Audio Muted, Ken Burns scale, 100ms Dissolve) */}
      <Sequence
        from={fromFrame}
        durationInFrames={durationInFrames}
        data-testid="broll-sequence"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: canvasWidth,
          height: canvasHeight,
        }}
      >
        <OffthreadVideo
          src={brollSrc}
          data-testid="broll-stock-video"
          muted={true}
          volume={0}
          style={brollStyle}
        />
      </Sequence>

      {/* Layer 3: Subtitles & Animated Emojis (TOP LAYER - Z-INDEX 50) */}
      <div
        data-testid="broll-subtitles-layer"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: canvasWidth,
          height: canvasHeight,
          pointerEvents: "none",
          zIndex: 50,
        }}
      >
        {subtitleChildren}
      </div>
    </div>
  );
}

/**
 * Builds an FFmpeg complex filtergraph string for compositing B-roll video.
 */
export function buildBrollFfmpegFiltergraph(options: {
  readonly mainInputIndex?: number;
  readonly brollInputIndex: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly dissolveSec?: number;
  readonly width?: number;
  readonly height?: number;
}): string {
  const {
    mainInputIndex = 0,
    brollInputIndex,
    startSec,
    endSec,
    dissolveSec = DEFAULT_BROLL_DISSOLVE_SEC,
    width = BROLL_CANVAS_WIDTH,
    height = BROLL_CANVAS_HEIGHT,
  } = options;

  const duration = endSec - startSec;
  const fadeOutStart = Math.max(startSec, endSec - dissolveSec);

  return [
    `[${brollInputIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},`,
    `zoompan=z='min(zoom+0.0015,1.08)':d=${Math.round(duration * 30)}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height},`,
    `fade=t=in:st=0:d=${dissolveSec}:alpha=1,`,
    `fade=t=out:st=${Math.max(0, duration - dissolveSec)}:d=${dissolveSec}:alpha=1[broll_v];`,
    `[${mainInputIndex}:v][broll_v]overlay=0:0:enable='between(t,${startSec},${endSec})'[v_out]`,
  ].join("");
}

