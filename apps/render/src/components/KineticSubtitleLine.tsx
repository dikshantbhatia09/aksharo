/** @jsx h */
/** @jsxFrag Fragment */
/**
 * Word-by-Word Kinetic Animation Engine (Pillar 4 §01).
 *
 * Remotion-compatible `<KineticSubtitleLine />` composition component and
 * Skia/CanvasKit path layout builder:
 * - Frame-accurate spring bounce scale punch (1.0x -> 1.22x -> undershoot -> 1.0x)
 * - Submagic-grade attack dip (-4px -> 0px over 5 frames)
 * - Zero-collision dynamic word spacing safe margin:
 *   marginRight = baseMargin + (isActive ? fontSize * 0.1 : 0)
 * - Enhanced neon glow and drop shadow on active phoneme:
 *   box-shadow / text-shadow 0 0 20px rgba(0, 255, 163, 0.8)
 * - Supports Pop-Bounce, Karaoke-Fill, Typewriter Reveal, and Elastic-Fade curves
 * - High-retention attention micro-pacing line breaking (max 3-5 words)
 */

import {
  computeKaraokeFillProgress,
  computeWordMargin,
  computeWordSpringScale,
  computeWordYOffset,
  evaluateKineticWordState,
  type KineticAnimationCurve,
  packMicroPacingLines,
} from "@montaj/caption-styles";

import { AnimatedEmoji } from "./AnimatedEmoji.js";
import {
  Fragment as _Fragment,
  h as _h,
  type KineticCaptionWord,
  type SplitScreenStyle,
  type SplitScreenVNode,
} from "./SplitScreenView.js";

export const h = _h;
export const Fragment = _Fragment;

export type { KineticAnimationCurve };

export interface KineticSubtitleLineProps {
  readonly words: readonly KineticCaptionWord[];
  readonly currentTimeSec: number;
  readonly fps?: number;
  readonly curve?: KineticAnimationCurve;
  readonly fontSize?: number;
  readonly fontFamily?: string;
  readonly baseMargin?: number;
  readonly activeColor?: string;
  readonly inactiveColor?: string;
  readonly glowColor?: string;
  readonly maxWidthPx?: number;
  readonly placement?: "divider" | "center" | "lower-third" | "top";
  readonly topPx?: number;
  readonly className?: string;
  readonly style?: SplitScreenStyle;
  readonly "data-testid"?: string;
}

export interface SkiaKineticWordPath {
  readonly text: string;
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly yOffset: number;
  readonly color: string;
  readonly isActive: boolean;
  readonly shadowSigma: number;
  readonly shadowColor: string;
}

/**
 * `<KineticSubtitleLine />` Remotion Composition Component.
 *
 * Renders an energetic, word-by-word kinetic subtitle line with hardware-accelerated
 * spring scale punch, dynamic safe margin word spacing, and neon phoneme glow.
 */
export function KineticSubtitleLine(props: KineticSubtitleLineProps): SplitScreenVNode {
  const words = props.words ?? [];
  const currentTimeSec = props.currentTimeSec ?? 0;
  const fps = props.fps ?? 60;
  const curve = props.curve ?? "pop-bounce";
  const fontSize = props.fontSize ?? 48;
  const baseMargin = props.baseMargin ?? 8;
  const activeColor = props.activeColor ?? "#00FFA3";
  const inactiveColor = props.inactiveColor ?? "#FFFFFF";
  const glowColor = props.glowColor ?? activeColor;
  const maxWidthPx = props.maxWidthPx ?? 950;
  const placement = props.placement ?? "center";

  const renderedWords = words.map((word, index) => {
    const isUpcoming = currentTimeSec < word.startSec;
    const isPast =
      index === words.length - 1 ? currentTimeSec > word.endSec : currentTimeSec >= word.endSec;
    const isActive = !isUpcoming && !isPast;

    let scale = 1.0;
    let yOffset = 0;
    let opacity = 1.0;

    switch (curve) {
      case "pop-bounce": {
        if (isActive) {
          scale = computeWordSpringScale(currentTimeSec, word.startSec, fps);
          yOffset = computeWordYOffset(currentTimeSec, word.startSec, fps, -4);
        }
        break;
      }
      case "elastic-fade": {
        if (isActive) {
          const p = computeKaraokeFillProgress(currentTimeSec, word.startSec, word.endSec);
          scale = 1.0 + 0.15 * Math.sin(p * Math.PI) * (1 - p);
          opacity = 0.4 + 0.6 * p;
        } else if (isUpcoming) {
          opacity = 0.4;
        }
        break;
      }
      case "typewriter": {
        if (isUpcoming) {
          opacity = 0.15;
        }
        break;
      }
      case "karaoke-fill":
      default: {
        if (isActive) {
          scale = 1.04;
        }
        break;
      }
    }

    const marginRight = computeWordMargin(fontSize, isActive, baseMargin);
    const wordColor = isActive ? (word.highlightColor ?? activeColor) : inactiveColor;
    const textShadow = isActive
      ? `0 0 22px ${glowColor}, 0 2px 4px rgba(0, 0, 0, 0.85)`
      : "0 2px 4px rgba(0, 0, 0, 0.85)";

    return (
      <span
        key={index}
        data-testid="kinetic-word"
        data-word={word.text}
        data-index={index}
        data-active={isActive ? "true" : "false"}
        data-scale={scale.toFixed(3)}
        data-y-offset={yOffset.toFixed(2)}
        style={{
          position: "relative",
          display: "inline-block",
          transform: `translate3d(0, ${yOffset.toFixed(2)}px, 0) scale(${scale.toFixed(3)})`,
          color: wordColor,
          marginRight: `${marginRight.toFixed(1)}px`,
          textShadow,
          opacity,
          fontWeight: 800,
          lineHeight: 1.22,
          transition: "color 33ms ease",
          willChange: "transform, color",
        }}
      >
        {word.emoji && (
          <AnimatedEmoji
            emoji={word.emoji.char}
            assetKey={word.emoji.assetKey}
            currentTimeSec={currentTimeSec}
            startSec={word.startSec}
            endSec={word.endSec}
            fps={fps}
            sizePx={Math.max(36, fontSize * 1.0)}
            offsetYPx={-(fontSize * 1.15)}
          />
        )}
        {word.text}
      </span>
    );
  });

  return (
    <div
      data-testid={props["data-testid"] ?? "kinetic-subtitle-line"}
      data-placement={placement}
      data-curve={curve}
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
        maxWidth: maxWidthPx,
        textAlign: "center",
        pointerEvents: "none",
        fontFamily: props.fontFamily ?? "Inter, -apple-system, system-ui, sans-serif",
        fontSize: `${fontSize}px`,
        lineHeight: 1.22,
        letterSpacing: "0.02em",
        zIndex: 20,
        ...(props.topPx !== undefined
          ? {
              position: "absolute",
              top: props.topPx,
              left: "50%",
              transform: "translate(-50%, -50%)",
            }
          : {}),
        ...props.style,
      }}
    >
      {renderedWords}
    </div>
  );
}

/**
 * Computes deterministic word layouts and spring transformations for Skia / CanvasKit
 * hardware-accelerated 2D text renderers (60 fps frame-accurate compositor).
 */
export function computeKineticSkiaLayout(
  words: readonly KineticCaptionWord[],
  currentTimeSec: number,
  canvasWidth: number,
  baselineY: number,
  fontSize = 48,
  fps = 60,
  baseMargin = 8,
): SkiaKineticWordPath[] {
  if (words.length === 0) return [];

  // Approximate character width for horizontal layout packing
  const charWidth = fontSize * 0.58;
  const wordWidths = words.map((w) => w.text.length * charWidth);

  // Compute margins with dynamic safe clearance
  const margins = words.map((w, index) => {
    const isPast =
      index === words.length - 1 ? currentTimeSec > w.endSec : currentTimeSec >= w.endSec;
    const isActive = currentTimeSec >= w.startSec && !isPast;
    return computeWordMargin(fontSize, isActive, baseMargin);
  });

  const totalLineWidth =
    wordWidths.reduce((a, b) => a + b, 0) +
    margins.slice(0, -1).reduce((a, b) => a + b, 0);

  let currentX = Math.max(20, (canvasWidth - totalLineWidth) / 2);
  const paths: SkiaKineticWordPath[] = [];

  for (let i = 0; i < words.length; i++) {
    const word = words.at(i);
    if (!word) continue;
    const width = wordWidths.at(i) ?? 0;
    const margin = margins.at(i) ?? 0;
    const isUpcoming = currentTimeSec < word.startSec;
    const isPast =
      i === words.length - 1 ? currentTimeSec > word.endSec : currentTimeSec >= word.endSec;
    const isActive = !isUpcoming && !isPast;

    const scale = isActive ? computeWordSpringScale(currentTimeSec, word.startSec, fps) : 1.0;
    const yOffset = isActive ? computeWordYOffset(currentTimeSec, word.startSec, fps, -4) : 0;
    const color = isActive ? (word.highlightColor ?? "#00FFA3") : "#FFFFFF";
    const shadowSigma = isActive ? fontSize * 0.4 : fontSize * 0.08;
    const shadowColor = isActive ? "#00FFA3" : "rgba(0,0,0,0.85)";

    paths.push({
      text: word.text,
      index: i,
      x: currentX,
      y: baselineY + yOffset,
      width,
      height: fontSize,
      scale,
      yOffset,
      color,
      isActive,
      shadowSigma,
      shadowColor,
    });

    currentX += width + margin;
  }

  return paths;
}

export { evaluateKineticWordState, packMicroPacingLines };
