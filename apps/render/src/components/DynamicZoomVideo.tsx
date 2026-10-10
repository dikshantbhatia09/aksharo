/** @jsx h */
/** @jsxFrag Fragment */
/**
 * Dynamic Attention Auto-Zoom & Punch-In Pacing Engine (Pillar 6 §03).
 *
 * Implements face-anchored camera punch-in and Ken Burns zooms:
 * - Maintains speaker eye-line in upper-third grid (Y in [0.28, 0.38]).
 * - Clamps originX to [0.2, 0.8] and originY to [0.2, 0.6] to prevent empty canvas
 *   bleed or forehead clipping.
 * - Supports Instant Jump Cuts ('JUMP'), Ken Burns Creeps ('CREEP'), and Smooth
 *   Ease-Out Cubic punch-ins ('EASE').
 */

import {
  Fragment,
  OffthreadVideo,
  h,
  type SplitScreenStyle,
  type SplitScreenVNode,
} from "./SplitScreenView.js";

export { Fragment, OffthreadVideo, h };

export interface ZoomKeyframe {
  /** Time offset in seconds (or mapped from ms). */
  readonly timeSec: number;
  /** Scale factor (>= 1.0, e.g. 1.0, 1.15, 1.18, 1.25). */
  readonly scale: number;
  /** Normalized X anchor (0..1). */
  readonly originX: number;
  /** Normalized Y anchor (0..1). */
  readonly originY: number;
  /** Transition curve into this keyframe: JUMP, EASE, CREEP, linear, or inOut. */
  readonly transition?: "JUMP" | "EASE" | "CREEP" | "linear" | "inOut";
}

export interface DynamicZoomVideoProps {
  readonly src: string;
  readonly currentTimeSec: number;
  readonly keyframes: readonly ZoomKeyframe[];
  readonly style?: SplitScreenStyle;
  readonly muted?: boolean;
  readonly volume?: number;
  readonly "data-testid"?: string;
}

/**
 * Clamps coordinates to ensure the speaker's eyes and face remain centered without
 * revealing black borders or clipping the forehead.
 */
export function clampOrigin(cx: number, cy: number): { originX: number; originY: number } {
  const originX = Math.round(Math.max(0.2, Math.min(0.8, cx)) * 10000) / 10000;
  const originY = Math.round(Math.max(0.2, Math.min(0.6, cy)) * 10000) / 10000;
  return { originX, originY };
}

/**
 * Normalizes input keyframes (handling both second-based and ms-based MKF2 shapes).
 */
export function normalizeKeyframes(
  rawFrames: readonly (ZoomKeyframe | { readonly tMs: number; readonly zoom: number; readonly cx: number; readonly cy: number; readonly ease?: string })[],
): ZoomKeyframe[] {
  return rawFrames.map((kf) => {
    if ("tMs" in kf) {
      const { originX, originY } = clampOrigin(kf.cx, kf.cy);
      return {
        timeSec: kf.tMs / 1000,
        scale: kf.zoom,
        originX,
        originY,
        transition: (kf.ease === "inOut" ? "EASE" : "linear") as ZoomKeyframe["transition"],
      };
    }
    const { originX, originY } = clampOrigin(kf.originX, kf.originY);
    return {
      timeSec: kf.timeSec,
      scale: kf.scale,
      originX,
      originY,
      transition: kf.transition ?? "EASE",
    };
  }).sort((a, b) => a.timeSec - b.timeSec);
}

/**
 * Computes the active transform matrix at a given timestamp.
 */
export function computeZoomTransform(
  keyframes: readonly ZoomKeyframe[],
  timeSec: number,
): {
  scale: number;
  originX: number;
  originY: number;
  transform: string;
  transformOrigin: string;
  style: SplitScreenStyle;
} {
  if (keyframes.length === 0) {
    const { originX, originY } = clampOrigin(0.5, 0.35);
    return {
      scale: 1.0,
      originX,
      originY,
      transform: "scale(1)",
      transformOrigin: `${originX * 100}% ${originY * 100}%`,
      style: {
        transform: "scale(1)",
        transformOrigin: `${originX * 100}% ${originY * 100}%`,
      },
    };
  }

  const sorted = [...keyframes].sort((a, b) => a.timeSec - b.timeSec);
  const first = sorted[0]!;
  if (timeSec <= first.timeSec || sorted.length === 1) {
    const { originX, originY } = clampOrigin(first.originX, first.originY);
    return {
      scale: first.scale,
      originX,
      originY,
      transform: `scale(${first.scale})`,
      transformOrigin: `${originX * 100}% ${originY * 100}%`,
      style: {
        transform: `scale(${first.scale})`,
        transformOrigin: `${originX * 100}% ${originY * 100}%`,
      },
    };
  }

  const last = sorted[sorted.length - 1]!;
  if (timeSec >= last.timeSec) {
    const { originX, originY } = clampOrigin(last.originX, last.originY);
    return {
      scale: last.scale,
      originX,
      originY,
      transform: `scale(${last.scale})`,
      transformOrigin: `${originX * 100}% ${originY * 100}%`,
      style: {
        transform: `scale(${last.scale})`,
        transformOrigin: `${originX * 100}% ${originY * 100}%`,
      },
    };
  }

  // Find active segment [startKf, endKf]
  let startKf = first;
  let endKf = last;
  for (let i = 0; i < sorted.length - 1; i++) {
    const curr = sorted[i]!;
    const next = sorted[i + 1]!;
    if (timeSec >= curr.timeSec && timeSec <= next.timeSec) {
      startKf = curr;
      endKf = next;
      break;
    }
  }

  const duration = endKf.timeSec - startKf.timeSec;
  if (duration <= 0.0001) {
    const { originX, originY } = clampOrigin(endKf.originX, endKf.originY);
    return {
      scale: endKf.scale,
      originX,
      originY,
      transform: `scale(${endKf.scale})`,
      transformOrigin: `${originX * 100}% ${originY * 100}%`,
      style: {
        transform: `scale(${endKf.scale})`,
        transformOrigin: `${originX * 100}% ${originY * 100}%`,
      },
    };
  }

  const progress = Math.max(0, Math.min(1, (timeSec - startKf.timeSec) / duration));

  // Transition types
  const transition = endKf.transition ?? "EASE";
  let easeProgress: number;
  if (transition === "JUMP") {
    // Jump cut: hold start scale until arrival
    easeProgress = 0;
  } else if (transition === "CREEP") {
    // Subtle ease-in-out tension creep
    easeProgress = progress * progress * (3 - 2 * progress);
  } else if (transition === "inOut" || transition === "EASE") {
    // Ease-out cubic: 1 - (1 - t)^3
    easeProgress = 1 - Math.pow(1 - progress, 3);
  } else {
    // Linear
    easeProgress = progress;
  }

  const currentScale = Math.round((startKf.scale + (endKf.scale - startKf.scale) * easeProgress) * 10000) / 10000;
  const rawX = startKf.originX + (endKf.originX - startKf.originX) * easeProgress;
  const rawY = startKf.originY + (endKf.originY - startKf.originY) * easeProgress;
  const { originX, originY } = clampOrigin(rawX, rawY);

  const transform = `scale(${currentScale})`;
  const transformOrigin = `${originX * 100}% ${originY * 100}%`;

  return {
    scale: currentScale,
    originX,
    originY,
    transform,
    transformOrigin,
    style: {
      transform,
      transformOrigin,
      transition: transition === "JUMP" ? "none" : "transform 0.18s cubic-bezier(0.2, 0, 0.2, 1)",
    },
  };
}

/**
 * Remotion Dynamic Zoom Video component.
 */
export function DynamicZoomVideo(props: DynamicZoomVideoProps): SplitScreenVNode {
  const normKeyframes = normalizeKeyframes(props.keyframes);
  const activeTransform = computeZoomTransform(normKeyframes, props.currentTimeSec);

  const mergedStyle: SplitScreenStyle = {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
    ...activeTransform.style,
    ...(props.style ?? {}),
  };

  return {
    type: "div",
    props: {
      style: {
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
      },
      "data-testid": props["data-testid"] ?? "dynamic-zoom-video",
      children: [
        OffthreadVideo({
          src: props.src,
          style: mergedStyle,
          muted: props.muted ?? true,
          volume: props.volume ?? 0,
          "data-testid": "dynamic-zoom-offthread-video",
        }),
      ],
    },
  };
}

/**
 * Builds an FFmpeg zoompan filter expression equivalent for background rendering.
 */
export function buildZoompanFilter(
  keyframes: readonly ZoomKeyframe[],
  durationSec: number,
  fps = 30,
): string {
  if (keyframes.length === 0) {
    return `zoompan=z=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=${fps}`;
  }

  const sorted = [...keyframes].sort((a, b) => a.timeSec - b.timeSec);
  const maxScale = Math.max(...sorted.map((k) => k.scale));
  const primaryAnchor = clampOrigin(sorted[0]!.originX, sorted[0]!.originY);

  // FFmpeg zoompan syntax with face-anchored center
  const zExpr = `min(${maxScale.toFixed(2)},1+(on/${Math.max(1, Math.round(durationSec * fps))})*${(maxScale - 1).toFixed(2)})`;
  const xExpr = `iw*${primaryAnchor.originX.toFixed(2)}-(iw/zoom/2)`;
  const yExpr = `ih*${primaryAnchor.originY.toFixed(2)}-(ih/zoom/2)`;

  return `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${Math.max(1, Math.round(durationSec * fps))}:s=1080x1920:fps=${fps}`;
}
