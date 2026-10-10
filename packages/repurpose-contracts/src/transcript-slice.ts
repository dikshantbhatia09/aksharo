import { z } from "zod";

/**
 * Manual Timestamp Selection & Frame-Accurate Boundary Trimming (Pillar 2 §08).
 *
 * Provides zero-latency transcript word re-slicing, subtitle line re-grouping,
 * magnetic word/sentence boundary snapping (±0.2s / 8px deadband), 1/30s frame
 * quantization, and high-precision timecode parsing/formatting.
 */

export const TimedWordSchema = z.object({
  id: z.string().optional(),
  text: z.string(),
  start: z.number(),
  end: z.number(),
  confidence: z.number().optional(),
  speaker: z.string().optional(),
  isSentenceEnd: z.boolean().optional(),
  isEmphasized: z.boolean().optional(),
  accentColor: z.string().optional(),
  accentIndex: z.number().optional(),
  clipRelativeStart: z.number().optional(),
  clipRelativeEnd: z.number().optional(),
});

export type TimedWord = z.infer<typeof TimedWordSchema>;

export interface SlicedTimedWord extends TimedWord {
  clipRelativeStart: number;
  clipRelativeEnd: number;
}

export interface SlicedCaptionLine {
  lineIndex: number;
  text: string;
  sourceStartSec: number;
  sourceEndSec: number;
  clipRelativeStartSec: number;
  clipRelativeEndSec: number;
  words: SlicedTimedWord[];
}

export const ClipTrimRequestSchema = z
  .object({
    startSec: z.number().finite(),
    endSec: z.number().finite(),
    bypassSnap: z.boolean().optional(),
  })
  .strict();

export type ClipTrimRequest = z.infer<typeof ClipTrimRequestSchema>;

export const DEFAULT_SNAP_TOLERANCE_SEC = 0.2;
export const DEFAULT_SNAP_DEADBAND_PX = 8;
export const DEFAULT_FRAME_RATE = 30;

/**
 * Re-slices source transcript words into a clip window `[startSec, endSec]`
 * and computes non-negative clip-relative start and end offsets in seconds.
 */
export function sliceTranscriptWords(
  allWords: readonly TimedWord[],
  startSec: number,
  endSec: number,
): SlicedTimedWord[] {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec < startSec) {
    return [];
  }
  return allWords
    .filter((w) => w.end >= startSec && w.start <= endSec)
    .map((w) => ({
      ...w,
      clipRelativeStart: Math.max(0, w.start - startSec),
      clipRelativeEnd: Math.max(0, w.end - startSec),
    }));
}

export interface SliceLinesOptions {
  readonly maxWordsPerLine?: number;
  readonly maxCharsPerLine?: number;
  readonly pauseGapSec?: number;
}

/**
 * Re-slices transcript words for `[startSec, endSec]` and groups them into
 * subtitle lines with adapted clip-relative word timings and natural line breaks.
 */
export function sliceTranscriptLines(
  allWords: readonly TimedWord[],
  startSec: number,
  endSec: number,
  options: SliceLinesOptions = {},
): SlicedCaptionLine[] {
  const sliced = sliceTranscriptWords(allWords, startSec, endSec);
  if (sliced.length === 0) return [];

  const maxWords = Math.max(1, options.maxWordsPerLine ?? 8);
  const maxChars = Math.max(8, options.maxCharsPerLine ?? 42);
  const pauseGapSec = Math.max(0.1, options.pauseGapSec ?? 0.8);

  const lines: SlicedCaptionLine[] = [];
  let currentWords: SlicedTimedWord[] = [];
  let currentChars = 0;

  const flushLine = (): void => {
    const first = currentWords[0];
    const last = currentWords[currentWords.length - 1];
    if (!first || !last) return;
    lines.push({
      lineIndex: lines.length,
      text: currentWords
        .map((w) => w.text.trim())
        .filter((t) => t.length > 0)
        .join(" "),
      sourceStartSec: Math.max(startSec, first.start),
      sourceEndSec: Math.min(endSec, last.end),
      clipRelativeStartSec: first.clipRelativeStart,
      clipRelativeEndSec: Math.min(endSec - startSec, last.clipRelativeEnd),
      words: currentWords,
    });
    currentWords = [];
    currentChars = 0;
  };

  for (const word of sliced) {
    const prev = currentWords[currentWords.length - 1];
    const wordLen = word.text.trim().length;
    if (prev !== undefined) {
      const gap = word.start - prev.end;
      const wouldExceedChars = currentChars + 1 + wordLen > maxChars && currentWords.length >= 2;
      if (gap >= pauseGapSec || currentWords.length >= maxWords || wouldExceedChars) {
        flushLine();
      }
    }

    currentWords.push(word);
    currentChars += (currentWords.length > 1 ? 1 : 0) + wordLen;

    const trimmed = word.text.trim();
    const isSentenceEnd =
      word.isSentenceEnd === true || /[.!?।]["')\]]?$/.test(trimmed);
    if (isSentenceEnd && currentWords.length >= 3) {
      flushLine();
    }
  }

  flushLine();
  return lines;
}

/**
 * Quantizes a timestamp in seconds to the nearest frame boundary (`1 / fps` sec).
 */
export function quantizeToFrame(timeSec: number, fps: number = DEFAULT_FRAME_RATE): number {
  if (!Number.isFinite(timeSec)) return 0;
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FRAME_RATE;
  const clamped = Math.max(0, timeSec);
  const quantized = Math.round(clamped * safeFps) / safeFps;
  return Number(quantized.toFixed(6));
}

export interface SnapBoundaryOptions {
  /** Magnetic snap reach in seconds (default: 0.2s). */
  readonly snapToleranceSec?: number;
  /** Disable magnetic word snapping (`Shift` or `Alt` held) for frame-accurate trimming. */
  readonly bypassSnap?: boolean;
  /** Frame rate used when quantizing free-form trim positions (default: 30 fps). */
  readonly fps?: number;
  /** Minimum allowed timestamp in seconds. */
  readonly minSec?: number;
  /** Maximum allowed timestamp in seconds. */
  readonly maxSec?: number;
}

export interface SnapBoundaryResult {
  readonly timeSec: number;
  readonly snapped: boolean;
  readonly snappedWordId: string | null;
  readonly snappedSentenceBoundary: boolean;
}

/**
 * Magnetically snaps a trim handle timestamp (`start` or `end`) to the nearest
 * word or sentence boundary within `±snapToleranceSec` (default `±0.2s`), or
 * quantizes down to `1/30`th second frame precision when `bypassSnap` is true.
 */
export function snapToWordBoundary(
  requestedSec: number,
  words: readonly TimedWord[],
  side: "start" | "end",
  options: SnapBoundaryOptions = {},
): SnapBoundaryResult {
  const minSec = Math.max(0, options.minSec ?? 0);
  const maxSec =
    options.maxSec !== undefined && Number.isFinite(options.maxSec) && options.maxSec > minSec
      ? options.maxSec
      : Number.POSITIVE_INFINITY;
  const fps = options.fps ?? DEFAULT_FRAME_RATE;
  const clampedReq = Math.min(maxSec, Math.max(minSec, requestedSec));

  if (options.bypassSnap === true) {
    const frameTime = Math.min(maxSec, Math.max(minSec, quantizeToFrame(clampedReq, fps)));
    return {
      timeSec: frameTime,
      snapped: false,
      snappedWordId: null,
      snappedSentenceBoundary: false,
    };
  }

  const tolerance = Math.max(0, options.snapToleranceSec ?? DEFAULT_SNAP_TOLERANCE_SEC);
  let bestWord: TimedWord | null = null;
  let bestEdge = clampedReq;
  let bestDist = Number.POSITIVE_INFINITY;
  let bestIsSentence = false;

  for (const word of words) {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end < word.start) {
      continue;
    }
    const edge = side === "start" ? word.start : word.end;
    if (edge < minSec || edge > maxSec) continue;

    const dist = Math.abs(edge - clampedReq);
    if (dist > tolerance + 1e-9) continue;

    const isSentence =
      word.isSentenceEnd === true ||
      /[.!?।]["')\]]?$/.test(word.text.trim());

    if (
      dist < bestDist - 1e-6 ||
      (Math.abs(dist - bestDist) <= 1e-6 && isSentence && !bestIsSentence)
    ) {
      bestDist = dist;
      bestWord = word;
      bestEdge = edge;
      bestIsSentence = isSentence;
    }
  }

  if (bestWord !== null) {
    return {
      timeSec: Number(bestEdge.toFixed(6)),
      snapped: true,
      snappedWordId: bestWord.id ?? null,
      snappedSentenceBoundary: bestIsSentence,
    };
  }

  const fallback = Math.min(maxSec, Math.max(minSec, quantizeToFrame(clampedReq, fps)));
  return {
    timeSec: fallback,
    snapped: false,
    snappedWordId: null,
    snappedSentenceBoundary: false,
  };
}

/**
 * Parses a timecode string (`04:15.000`, `14:00`, `1:02:03.500`, `75:30`)
 * into seconds, or returns `null` if invalid.
 */
export function parseTimecodeToSec(raw: string): number | null {
  if (typeof raw !== "string") return null;
  const match =
    /^\s*(?:(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?|(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?)\s*$/.exec(
      raw,
    );
  if (match === null) return null;
  const [, h, hm, hs, hms, m, s, ms] = match;
  const hours = h === undefined ? 0 : Number(h);
  const minutes = h === undefined ? Number(m) : Number(hm);
  const seconds = h === undefined ? Number(s) : Number(hs);
  const fracRaw = h === undefined ? ms : hms;
  if (seconds > 59 || (h !== undefined && minutes > 59)) return null;
  const millis = fracRaw === undefined ? 0 : Number(fracRaw.padEnd(3, "0"));
  return (hours * 3600) + (minutes * 60) + seconds + millis / 1000;
}

/**
 * Formats seconds into a timecode string (`04:15.000` when `includeMs` is true,
 * or `04:15` / `1:04:15` when `includeMs` is false).
 */
export function formatSecToTimecode(sec: number, includeMs = true): string {
  const safeMs = Math.max(0, Math.round((Number.isFinite(sec) ? sec : 0) * 1000));
  const totalSeconds = Math.floor(safeMs / 1000);
  const millis = safeMs % 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  const base = hours > 0 ? `${String(hours).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
  if (!includeMs) return base;
  return `${base}.${String(millis).padStart(3, "0")}`;
}

