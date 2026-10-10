/** @jsx h */
/** @jsxFrag Fragment */
/**
 * Bilingual Subtitle Component & Cross-Lingual Sync Compositor (Pillar 4 §09).
 *
 * Implements CapCut / Opus Clip dual-track bilingual subtitle presentation:
 * - Line 1 (Top / Original / Native): subtle opacity (~0.65), muted gray (#8E8E93) / white,
 *   subordinate font size (32px), preserving speech context.
 * - Line 2 (Bottom / Translated): vibrant kinetic bounce (48px), neon glow phoneme accents,
 *   high-retention spring punch (pop-bounce, karaoke-fill, typewriter, elastic-fade).
 * - Proportional cross-lingual word timing allocation for frame-accurate sync.
 * - Skia / CanvasKit hardware blitter path layout generator (60 fps compositor).
 */

import {
  allocateCrossLingualWordTiming,
  type KineticAnimationCurve,
} from "@montaj/caption-styles";

import {
  computeKineticSkiaLayout,
  KineticSubtitleLine,
  type SkiaKineticWordPath,
} from "./KineticSubtitleLine.js";
import {
  Fragment as _Fragment,
  h as _h,
  type KineticCaptionWord,
  type SplitScreenStyle,
  type SplitScreenVNode,
} from "./SplitScreenView.js";

export const h = _h;
export const Fragment = _Fragment;

export interface BilingualSubtitleProps {
  readonly originalWords?: readonly KineticCaptionWord[];
  readonly translatedWords?: readonly KineticCaptionWord[];
  readonly originalText?: string;
  readonly translatedText?: string;
  readonly currentTimeSec: number;
  readonly startSec?: number;
  readonly endSec?: number;
  readonly fps?: number;
  readonly curve?: KineticAnimationCurve;
  readonly originalFontSize?: number;
  readonly translatedFontSize?: number;
  readonly originalColor?: string;
  readonly originalOpacity?: number;
  readonly activeColor?: string;
  readonly inactiveColor?: string;
  readonly glowColor?: string;
  readonly strokeColor?: string;
  readonly strokeWidth?: number;
  readonly fontFamily?: string;
  readonly textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  readonly placement?: "divider" | "center" | "lower-third" | "top";
  readonly topPx?: number;
  readonly maxWidthPx?: number;
  readonly lineGapPx?: number;
  readonly className?: string;
  readonly style?: SplitScreenStyle;
  readonly "data-testid"?: string;
}

/**
 * `<BilingualSubtitle />` Remotion Composition Component.
 */
export function BilingualSubtitle(props: BilingualSubtitleProps): SplitScreenVNode {
  const currentTimeSec = props.currentTimeSec ?? 0;
  const fps = props.fps ?? 60;
  const curve = props.curve ?? "pop-bounce";
  const originalFontSize = props.originalFontSize ?? 32;
  const translatedFontSize = props.translatedFontSize ?? 48;
  const originalColor = props.originalColor ?? "#8E8E93";
  const originalOpacity = props.originalOpacity ?? 0.65;
  const activeColor = props.activeColor ?? "#00FFA3";
  const inactiveColor = props.inactiveColor ?? "#FFFFFF";
  const glowColor = props.glowColor ?? activeColor;
  const maxWidthPx = props.maxWidthPx ?? 950;
  const lineGapPx = props.lineGapPx ?? 10;
  const placement = props.placement ?? "center";
  const fontFamily = props.fontFamily ?? "Inter, -apple-system, system-ui, sans-serif";

  // Resolve translated words
  let resolvedTranslatedWords: readonly KineticCaptionWord[] = props.translatedWords ?? [];
  if (resolvedTranslatedWords.length === 0 && props.translatedText) {
    const s = props.startSec ?? currentTimeSec;
    const e = props.endSec ?? currentTimeSec + 2.0;
    const allocated = allocateCrossLingualWordTiming(props.translatedText, s, e);
    resolvedTranslatedWords = allocated.map((w) => ({
      text: w.text,
      startSec: w.startSec,
      endSec: w.endSec,
    }));
  }

  // Resolve original words
  let resolvedOriginalWords: readonly KineticCaptionWord[] = props.originalWords ?? [];
  if (resolvedOriginalWords.length === 0 && props.originalText) {
    const s = props.startSec ?? currentTimeSec;
    const e = props.endSec ?? currentTimeSec + 2.0;
    const allocated = allocateCrossLingualWordTiming(props.originalText, s, e);
    resolvedOriginalWords = allocated.map((w) => ({
      text: w.text,
      startSec: w.startSec,
      endSec: w.endSec,
    }));
  }

  return (
    <div
      data-testid={props["data-testid"] ?? "bilingual-subtitle"}
      data-placement={placement}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: `${lineGapPx}px`,
        maxWidth: maxWidthPx,
        textAlign: "center",
        pointerEvents: "none",
        fontFamily,
        zIndex: 25,
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
      {/* Top Line: Original / Native (Subtle Opacity, Muted Styling) */}
      <div
        data-testid="bilingual-original-line"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "center",
          opacity: originalOpacity,
          color: originalColor,
          fontSize: `${originalFontSize}px`,
          fontWeight: 600,
          lineHeight: 1.25,
          letterSpacing: "0.01em",
          textShadow: "0 1px 3px rgba(0, 0, 0, 0.7)",
        }}
      >
        {resolvedOriginalWords.length > 0 ? (
          resolvedOriginalWords.map((word, idx) => {
            const isWordActive =
              currentTimeSec >= word.startSec &&
              (idx === resolvedOriginalWords.length - 1
                ? currentTimeSec <= word.endSec
                : currentTimeSec < word.endSec);
            return (
              <span
                key={idx}
                data-testid="bilingual-original-word"
                data-word={word.text}
                data-active={isWordActive ? "true" : "false"}
                style={{
                  display: "inline-block",
                  marginRight: `${Math.round(originalFontSize * 0.18)}px`,
                  color: isWordActive ? "#FFFFFF" : originalColor,
                  fontWeight: isWordActive ? 700 : 500,
                  transition: "color 40ms ease",
                }}
              >
                {word.text}
              </span>
            );
          })
        ) : (
          <span>{props.originalText ?? ""}</span>
        )}
      </div>

      {/* Bottom Line: Translated (Vibrant Kinetic Bounce & Neon Accents) */}
      <div data-testid="bilingual-translated-line" style={{ width: "100%" }}>
        <KineticSubtitleLine
          data-testid="bilingual-kinetic-line"
          words={resolvedTranslatedWords}
          currentTimeSec={currentTimeSec}
          fps={fps}
          curve={curve}
          fontSize={translatedFontSize}
          fontFamily={fontFamily}
          textTransform={props.textTransform}
          activeColor={activeColor}
          inactiveColor={inactiveColor}
          glowColor={glowColor}
          strokeColor={props.strokeColor}
          strokeWidth={props.strokeWidth}
          maxWidthPx={maxWidthPx}
        />
      </div>
    </div>
  );
}

/**
 * Computes Skia / CanvasKit hardware blitter layouts for dual-track bilingual subtitles.
 */
export function computeBilingualSkiaLayout(
  originalWords: readonly KineticCaptionWord[],
  translatedWords: readonly KineticCaptionWord[],
  currentTimeSec: number,
  canvasWidth: number,
  baselineY: number,
  options: {
    readonly originalFontSize?: number;
    readonly translatedFontSize?: number;
    readonly lineGapPx?: number;
    readonly fps?: number;
    readonly activeColor?: string;
    readonly inactiveColor?: string;
    readonly originalColor?: string;
    readonly curve?: KineticAnimationCurve;
    readonly textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  } = {},
): {
  readonly originalPaths: readonly SkiaKineticWordPath[];
  readonly translatedPaths: readonly SkiaKineticWordPath[];
  readonly allPaths: readonly SkiaKineticWordPath[];
} {
  const originalFontSize = options.originalFontSize ?? 32;
  const translatedFontSize = options.translatedFontSize ?? 48;
  const lineGapPx = options.lineGapPx ?? 12;
  const originalColor = options.originalColor ?? "#8E8E93";

  // Top line (original) placed lineGap + font above baselineY
  const originalBaselineY = baselineY - (translatedFontSize * 0.8 + lineGapPx);

  const originalPaths: SkiaKineticWordPath[] = [];
  if (originalWords.length > 0) {
    const charWidth = originalFontSize * 0.55;
    const wordWidths = originalWords.map((w) => w.text.length * charWidth);
    const margin = originalFontSize * 0.18;
    const totalLineWidth =
      wordWidths.reduce((a, b) => a + b, 0) + (originalWords.length - 1) * margin;
    let currX = Math.max(20, (canvasWidth - totalLineWidth) / 2);

    for (let i = 0; i < originalWords.length; i++) {
      const w = originalWords[i]!;
      const width = wordWidths[i]!;
      const isPast =
        i === originalWords.length - 1 ? currentTimeSec > w.endSec : currentTimeSec >= w.endSec;
      const isActive = currentTimeSec >= w.startSec && !isPast;

      originalPaths.push({
        text: w.text,
        index: i,
        x: currX,
        y: originalBaselineY,
        width,
        height: originalFontSize,
        scale: 1.0,
        yOffset: 0,
        color: isActive ? "#FFFFFF" : originalColor,
        isActive,
        shadowSigma: originalFontSize * 0.05,
        shadowColor: "rgba(0, 0, 0, 0.7)",
      });
      currX += width + margin;
    }
  }

  // Bottom line (translated) with active kinetic bounce
  const translatedPaths = computeKineticSkiaLayout(
    translatedWords,
    currentTimeSec,
    canvasWidth,
    baselineY,
    translatedFontSize,
    options.fps ?? 60,
    8,
    options.curve ?? "pop-bounce",
    options.textTransform ?? "none",
  );

  return {
    originalPaths,
    translatedPaths,
    allPaths: [...originalPaths, ...translatedPaths],
  };
}

