/**
 * Word-by-Word Kinetic Animation Engine (Pillar 4 §01).
 *
 * Implements frame-accurate, physics-based typography animation for dynamic
 * short-form video captions:
 * - Underdamped spring scale punch: S(f) = 1.0 + 0.22 * exp(-0.35 * f) * cos(1.2 * f)
 * - Submagic-grade attack yOffset dip (-4px settling to 0px over 5 frames)
 * - Dynamic collision-free word spacing safe margin:
 *   marginRight = baseMargin + (isActive ? fontSize * 0.1 : 0)
 * - Multiple animation curves: pop-bounce, karaoke-fill, typewriter, elastic-fade
 * - Rapid micro-pacing line packer (3-5 words / 1.2-2.0s per screen)
 */

export type KineticAnimationCurve =
  | "pop-bounce"
  | "karaoke-fill"
  | "typewriter"
  | "elastic-fade";

export interface TimedWordItem {
  readonly text: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly confidence?: number;
  readonly highlightColor?: string;
  readonly inactiveColor?: string;
}

export interface KineticWordState {
  readonly text: string;
  readonly index: number;
  readonly isActive: boolean;
  readonly isUpcoming: boolean;
  readonly isPast: boolean;
  readonly scale: number;
  readonly yOffset: number;
  readonly marginRight: number;
  readonly color: string;
  readonly glow: string;
  readonly textShadow: string;
  readonly fillProgress: number;
  readonly opacity: number;
}

export interface KineticAnimationOptions {
  readonly fps?: number;
  readonly curve?: KineticAnimationCurve;
  readonly fontSize?: number;
  readonly baseMargin?: number;
  readonly activeColor?: string;
  readonly inactiveColor?: string;
  readonly glowColor?: string;
}

/**
 * Calculates underdamped spring scale punch for an active word.
 *
 * For an active word spoken at time t0, scale S(f) over elapsed frames
 * f = (currentSec - wordStartSec) * fps:
 * S(f) = 1.0 + 0.22 * exp(-gamma * f) * cos(omega * f)
 * where damping gamma = 0.35 and angular frequency omega = 1.2.
 * Settles back to standard size 1.0 by frame 8 (<= 133 ms).
 */
export function computeWordSpringScale(
  currentSec: number,
  wordStartSec: number,
  fps = 60,
): number {
  const elapsedSec = currentSec - wordStartSec;
  if (elapsedSec < 0) return 1.0;
  const f = elapsedSec * fps;
  if (f > 8) return 1.0; // Settled
  return 1.0 + 0.22 * Math.exp(-0.35 * f) * Math.cos(1.2 * f);
}

/** Millisecond overload of {@link computeWordSpringScale}. */
export function computeWordSpringScaleMs(
  currentMs: number,
  wordStartMs: number,
  fps = 60,
): number {
  return computeWordSpringScale(currentMs / 1000, wordStartMs / 1000, fps);
}

/**
 * Submagic-style attack dip: dips -4px on the attack frame and settles to 0px
 * over 5 frames (~83ms at 60 fps).
 */
export function computeWordYOffset(
  currentSec: number,
  wordStartSec: number,
  fps = 60,
  maxDipPx = -4,
): number {
  const elapsedSec = currentSec - wordStartSec;
  if (elapsedSec < 0) return 0;
  const f = elapsedSec * fps;
  if (f > 6) return 0; // Settled
  return maxDipPx * Math.exp(-0.5 * f) * Math.cos(0.9 * f);
}

/** Millisecond overload of {@link computeWordYOffset}. */
export function computeWordYOffsetMs(
  currentMs: number,
  wordStartMs: number,
  fps = 60,
  maxDipPx = -4,
): number {
  return computeWordYOffset(currentMs / 1000, wordStartMs / 1000, fps, maxDipPx);
}

/**
 * Dynamic word micro-padding with safe margin to prevent adjacent words
 * from colliding when the active word expands up to 1.22x.
 *
 * Formula: marginRight = baseMargin + (isActive ? fontSize * 0.1 : 0)
 */
export function computeWordMargin(
  fontSize: number,
  isActive: boolean,
  baseMargin = 8,
): number {
  return baseMargin + (isActive ? fontSize * 0.1 : 0);
}

/**
 * Clamps a number to the [0, 1] range.
 */
function clamp01(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

/**
 * Calculates progressive karaoke fill sweep fraction [0, 1].
 */
export function computeKaraokeFillProgress(
  currentSec: number,
  wordStartSec: number,
  wordEndSec: number,
): number {
  if (currentSec <= wordStartSec) return 0;
  if (currentSec >= wordEndSec) return 1;
  const duration = Math.max(0.001, wordEndSec - wordStartSec);
  return clamp01((currentSec - wordStartSec) / duration);
}

/**
 * Calculates typewriter visible character count based on elapsed duration.
 */
export function computeTypewriterProgress(
  currentSec: number,
  wordStartSec: number,
  wordEndSec: number,
  textLength: number,
): number {
  if (currentSec <= wordStartSec) return 0;
  if (currentSec >= wordEndSec) return textLength;
  const ratio = computeKaraokeFillProgress(currentSec, wordStartSec, wordEndSec);
  return Math.min(textLength, Math.floor(ratio * (textLength + 1)));
}

/**
 * Evaluates the full kinetic state of a single word at `currentSec`.
 */
export function evaluateKineticWordState(
  word: TimedWordItem,
  index: number,
  currentSec: number,
  options: KineticAnimationOptions = {},
): KineticWordState {
  const fps = options.fps ?? 60;
  const curve = options.curve ?? "pop-bounce";
  const fontSize = options.fontSize ?? 48;
  const baseMargin = options.baseMargin ?? 8;
  const activeColor = word.highlightColor ?? options.activeColor ?? "#00FFA3";
  const inactiveColor = word.inactiveColor ?? options.inactiveColor ?? "#FFFFFF";
  const glowColor = options.glowColor ?? activeColor;

  const isUpcoming = currentSec < word.startSec;
  const isPast = currentSec > word.endSec;
  const isActive = !isUpcoming && !isPast;

  let scale = 1.0;
  let yOffset = 0;
  let opacity = 1.0;
  const fillProgress = computeKaraokeFillProgress(currentSec, word.startSec, word.endSec);

  switch (curve) {
    case "pop-bounce": {
      if (isActive) {
        scale = computeWordSpringScale(currentSec, word.startSec, fps);
        yOffset = computeWordYOffset(currentSec, word.startSec, fps, -4);
      }
      break;
    }
    case "elastic-fade": {
      if (isActive) {
        const p = fillProgress;
        scale = 1.0 + 0.15 * Math.sin(p * Math.PI) * (1 - p);
        opacity = 0.4 + 0.6 * p;
      } else if (isUpcoming) {
        opacity = 0.4;
      }
      break;
    }
    case "typewriter": {
      if (isUpcoming) {
        opacity = 0.2;
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
  const color = isActive ? activeColor : inactiveColor;
  const glow = isActive ? `0 0 20px ${glowColor}` : "none";
  const textShadow = isActive
    ? `0 0 20px ${glowColor}, 0 2px 4px rgba(0,0,0,0.8)`
    : "0 2px 4px rgba(0,0,0,0.8)";

  return {
    text: word.text,
    index,
    isActive,
    isUpcoming,
    isPast,
    scale,
    yOffset,
    marginRight,
    color,
    glow,
    textShadow,
    fillProgress,
    opacity,
  };
}

/**
 * Micro-Pacing Line Packer (Section 2.1 & Section 4).
 *
 * Groups timed words into rapid visual pacing lines:
 * - Maximum 3 to 5 words per line (default 4).
 * - Maximum duration 1.2 to 2.0s per sentence screen (default 2.0s).
 * - Splits naturally on sentence terminal punctuation (. ? !).
 */
export function packMicroPacingLines<T extends { startSec: number; endSec: number; text: string }>(
  words: readonly T[],
  options: { maxWordsPerLine?: number; maxDurationSec?: number } = {},
): T[][] {
  if (words.length === 0) return [];

  const maxWords = options.maxWordsPerLine ?? 4;
  const maxDuration = options.maxDurationSec ?? 2.0;

  const lines: T[][] = [];
  let currentLine: T[] = [];

  for (const word of words) {
    if (currentLine.length === 0) {
      currentLine.push(word);
      continue;
    }

    const firstInLine = currentLine[0];
    const wouldExceedWords = currentLine.length >= maxWords;
    const wouldExceedDuration =
      firstInLine !== undefined && word.endSec - firstInLine.startSec > maxDuration;
    const prevWord = currentLine[currentLine.length - 1];
    const prevEndsSentence = prevWord !== undefined && /[.?!]$/.test(prevWord.text.trim());

    if (wouldExceedWords || wouldExceedDuration || prevEndsSentence) {
      lines.push(currentLine);
      currentLine = [word];
    } else {
      currentLine.push(word);
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Cross-Lingual Word Timing Allocator (Pillar 4 §09).
 *
 * Distributes sentence clause duration [startSec, endSec] across translated words
 * using token length and punctuation bonuses (Section 2.1):
 *   weight(w_i) = len(w_i) + bonus(punctuation)
 *   Delta t_i = (endSec - startSec) * (weight(w_i) / sum(weights))
 *
 * Guarantees that the final word strictly ends at endSec (zero drift).
 */
export function allocateCrossLingualWordTiming(
  translatedText: string,
  startSec: number,
  endSec: number,
): TimedWordItem[] {
  const tokens = translatedText.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const safeStart = startSec;
  const safeEnd = endSec < startSec ? startSec : endSec;
  const totalDuration = safeEnd - safeStart;

  if (totalDuration <= 0) {
    return tokens.map((token) => ({
      text: token,
      startSec: safeStart,
      endSec: safeEnd,
    }));
  }

  const weights = tokens.map((token) => {
    const stripped = token.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'–—«»""'']/g, "");
    const baseLen = Math.max(1, stripped.length);
    let bonus = 0;
    if (/[.?!।॥]$/.test(token)) {
      bonus = 2;
    } else if (/[,;:—–]$/.test(token)) {
      bonus = 1;
    }
    return baseLen + bonus;
  });

  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  const result: TimedWordItem[] = [];
  let currentStart = safeStart;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    let currentEnd: number;
    if (i === tokens.length - 1) {
      currentEnd = safeEnd;
    } else {
      const duration = totalDuration * (weights[i]! / totalWeight);
      currentEnd = Math.min(safeEnd, currentStart + duration);
    }

    result.push({
      text: token,
      startSec: currentStart,
      endSec: currentEnd,
    });
    currentStart = currentEnd;
  }

  return result;
}

