/** @jsx h */
/** @jsxFrag Fragment */
/**
 * Contextual Auto-Emoji & Synced Animation Component (Pillar 4 §04).
 *
 * Implements Submagic-grade 3D vector animated emojis synchronized with spoken word
 * timestamps:
 * - Dynamic spring pop-scale (0.0x -> 1.25x -> settling to 1.0x)
 * - Rotational wiggle (+12 deg -> -6 deg -> 0 deg over 6 frames)
 * - Subtle upward float (-15px over word duration)
 * - Precise centered positioning over active word:
 *   X_emoji = X_word_center, Y_emoji = Y_word_top - 65px
 * - Vector SVG rendering with fallback to styled Unicode glyph
 * - CanvasKit / Skia layout path generator for frame-accurate 2D compositor
 */

import { getEmojiDataUri } from "@montaj/caption-styles";

import {
  Fragment as _Fragment,
  h as _h,
  type SplitScreenStyle,
  type SplitScreenVNode,
} from "./SplitScreenView.js";

export const h = _h;
export const Fragment = _Fragment;

export interface AnimatedEmojiProps {
  readonly emoji: string;
  readonly assetKey?: string;
  readonly currentTimeSec: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly fps?: number;
  readonly sizePx?: number;
  readonly offsetYPx?: number;
  readonly style?: SplitScreenStyle;
  readonly "data-testid"?: string;
}

export interface SkiaAnimatedEmojiLayout {
  readonly emoji: string;
  readonly assetKey?: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly rotationDeg: number;
  readonly opacity: number;
  readonly visible: boolean;
}

/**
 * Calculates underdamped spring scale punch for an emoji.
 * Pops from 0.0 -> 1.25 peak over 2 frames, settling back to 1.0 by frame 6-8.
 */
export function computeEmojiSpringScale(
  currentSec: number,
  startSec: number,
  fps = 60,
): number {
  const elapsedSec = currentSec - startSec;
  if (elapsedSec < 0) return 0.0;
  const f = elapsedSec * fps;
  if (f > 8) return 1.0;
  if (f <= 2) {
    return (f / 2) * 1.25;
  }
  const settleF = f - 2;
  return 1.0 + 0.25 * Math.exp(-0.45 * settleF) * Math.cos(0.7 * settleF);
}

/**
 * Rotational wiggle: tilts +12 deg on attack, springs to -6 deg, settling to 0 deg
 * over 6-8 frames (~100-130ms at 60 fps).
 */
export function computeEmojiRotation(
  currentSec: number,
  startSec: number,
  fps = 60,
): number {
  const elapsedSec = currentSec - startSec;
  if (elapsedSec < 0) return 0;
  const f = elapsedSec * fps;
  if (f > 8) return 0;
  return 12.0 * Math.exp(-0.4 * f) * Math.sin(1.1 * f);
}

/**
 * Subtle upward float: drifts smoothly upward up to maxFloatPx (-15px) over word duration.
 */
export function computeEmojiFloatY(
  currentSec: number,
  startSec: number,
  durationSec: number,
  maxFloatPx = -15,
): number {
  const elapsedSec = currentSec - startSec;
  if (elapsedSec <= 0 || durationSec <= 0) return 0;
  const progress = Math.min(1.0, elapsedSec / durationSec);
  return progress * maxFloatPx;
}

/**
 * `<AnimatedEmoji />` Remotion Composition Component.
 *
 * Renders an energetic, spring-animated 3D vector emoji placed directly above
 * a spoken transcript word.
 */
export function AnimatedEmoji(props: AnimatedEmojiProps): SplitScreenVNode {
  const {
    emoji,
    assetKey,
    currentTimeSec,
    startSec,
    endSec,
    fps = 60,
    sizePx = 64,
    offsetYPx = -65,
    style = {},
  } = props;

  const durationSec = Math.max(0.1, endSec - startSec);
  const isUpcoming = currentTimeSec < startSec;
  const isPast = currentTimeSec > endSec;
  const isVisible = !isUpcoming && !isPast;

  const scale = isVisible ? computeEmojiSpringScale(currentTimeSec, startSec, fps) : 0;
  const rotationDeg = isVisible ? computeEmojiRotation(currentTimeSec, startSec, fps) : 0;
  const floatY = isVisible ? computeEmojiFloatY(currentTimeSec, startSec, durationSec, -15) : 0;
  const totalY = offsetYPx + floatY;

  const dataUri = assetKey ? getEmojiDataUri(assetKey) : null;

  return (
    <div
      data-testid={props["data-testid"] ?? "animated-emoji"}
      data-emoji={emoji}
      data-asset-key={assetKey ?? "system"}
      data-scale={scale.toFixed(3)}
      data-rotation={rotationDeg.toFixed(2)}
      data-float-y={floatY.toFixed(2)}
      data-visible={isVisible ? "true" : "false"}
      style={{
        position: "absolute",
        left: "50%",
        top: 0,
        transform: `translate3d(-50%, ${totalY.toFixed(2)}px, 0) scale(${scale.toFixed(3)}) rotate(${rotationDeg.toFixed(2)}deg)`,
        width: `${sizePx}px`,
        height: `${sizePx}px`,
        display: isVisible ? "flex" : "none",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
        zIndex: 30,
        willChange: "transform, opacity",
        filter: "drop-shadow(0 6px 12px rgba(0, 0, 0, 0.4))",
        ...style,
      }}
    >
      {dataUri ? (
        <img
          src={dataUri}
          alt={emoji}
          width={sizePx}
          height={sizePx}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      ) : (
        <span
          style={{
            fontSize: `${sizePx * 0.85}px`,
            lineHeight: 1,
            userSelect: "none",
          }}
        >
          {emoji}
        </span>
      )}
    </div>
  );
}

/**
 * Computes Skia/CanvasKit layout coordinates and spring transformations for 2D
 * hardware-accelerated video compositing.
 */
export function computeAnimatedEmojiSkiaLayout(
  emoji: string,
  assetKey: string | undefined,
  wordCenterX: number,
  wordTopY: number,
  currentTimeSec: number,
  startSec: number,
  endSec: number,
  fps = 60,
  sizePx = 64,
  offsetYPx = -65,
): SkiaAnimatedEmojiLayout {
  const isUpcoming = currentTimeSec < startSec;
  const isPast = currentTimeSec > endSec;
  const visible = !isUpcoming && !isPast;

  const durationSec = Math.max(0.1, endSec - startSec);
  const scale = visible ? computeEmojiSpringScale(currentTimeSec, startSec, fps) : 0;
  const rotationDeg = visible ? computeEmojiRotation(currentTimeSec, startSec, fps) : 0;
  const floatY = visible ? computeEmojiFloatY(currentTimeSec, startSec, durationSec, -15) : 0;

  return {
    emoji,
    assetKey,
    x: wordCenterX - sizePx / 2,
    y: wordTopY + offsetYPx + floatY,
    width: sizePx,
    height: sizePx,
    scale,
    rotationDeg,
    opacity: visible ? 1.0 : 0.0,
    visible,
  };
}
