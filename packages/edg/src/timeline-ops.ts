/**
 * Pure timeline operations for transcript lines and word chips.
 * Supports split, join, timing shift, and emphasis toggling.
 */

export interface TimelineWord {
  id: string;
  text: string;
  cleanText?: string;
  startMs: number;
  endMs: number;
  confidence?: number;
  isEmphasized?: boolean;
  customColorHex?: string;
  emoji?: {
    char: string;
    position: "before" | "after";
  };
}

export interface TimelineLine {
  id: string;
  lineIndex: number;
  startMs: number;
  endMs: number;
  speakerTag?: string;
  words: TimelineWord[];
}

/**
 * Splits a single word into two parts based on splitPointRatio (default 0.5)
 * or split character index.
 */
export function splitWord<W extends TimelineWord>(
  word: W,
  splitCharIndex?: number,
  newIdGen?: () => string,
): [W, W] {
  const text = word.text;
  const idx =
    splitCharIndex !== undefined && splitCharIndex > 0 && splitCharIndex < text.length
      ? splitCharIndex
      : Math.max(1, Math.floor(text.length / 2));

  const text1 = text.slice(0, idx);
  const text2 = text.slice(idx);

  const duration = Math.max(0, word.endMs - word.startMs);
  const ratio = text.length > 0 ? idx / text.length : 0.5;
  const midMs = Math.round(word.startMs + duration * ratio);

  const id2 = newIdGen ? newIdGen() : `${word.id}_split`;

  const w1 = {
    ...word,
    text: text1,
    cleanText: text1.toLowerCase().trim(),
    endMs: midMs,
  };

  const w2 = {
    ...word,
    id: id2,
    text: text2,
    cleanText: text2.toLowerCase().trim(),
    startMs: midMs,
  };

  return [w1, w2];
}

/**
 * Splits a timeline line into two separate lines at a given word ID.
 * The word with splitWordId becomes the first word of the second line.
 */
export function splitLine<L extends TimelineLine>(
  line: L,
  splitWordId: string,
  newLineIdGen?: () => string,
): [L, L] {
  const wordIndex = line.words.findIndex((w) => w.id === splitWordId);
  if (wordIndex <= 0) {
    throw new Error(
      `Cannot split line at index ${wordIndex}: word must exist and not be the very first word.`,
    );
  }

  const words1 = line.words.slice(0, wordIndex);
  const words2 = line.words.slice(wordIndex);

  const endMs1 = words1[words1.length - 1]?.endMs ?? line.startMs;
  const startMs2 = words2[0]?.startMs ?? endMs1;

  const newLineId = newLineIdGen ? newLineIdGen() : `${line.id}_split`;

  const l1: L = {
    ...line,
    endMs: endMs1,
    words: words1,
  };

  const l2: L = {
    ...line,
    id: newLineId,
    lineIndex: line.lineIndex + 1,
    startMs: startMs2,
    words: words2,
  };

  return [l1, l2];
}

/**
 * Joins two adjacent words into a single merged word block.
 */
export function joinWords<W extends TimelineWord>(first: W, second: W): W {
  const combinedText = `${first.text} ${second.text}`.trim();
  return {
    ...first,
    text: combinedText,
    cleanText: combinedText.toLowerCase().trim(),
    endMs: Math.max(first.endMs, second.endMs),
    confidence:
      first.confidence !== undefined && second.confidence !== undefined
        ? (first.confidence + second.confidence) / 2
        : (first.confidence ?? second.confidence),
  };
}

/**
 * Shifts the start and end timing of a word or line by deltaMs.
 */
export function shiftTiming<T extends { startMs: number; endMs: number }>(
  item: T,
  deltaMs: number,
): T {
  const newStart = Math.max(0, item.startMs + deltaMs);
  const duration = Math.max(0, item.endMs - item.startMs);
  return {
    ...item,
    startMs: newStart,
    endMs: newStart + duration,
  };
}

/**
 * Toggles the emphasis state of a word chip.
 */
export function toggleEmphasis<W extends TimelineWord>(word: W): W {
  return {
    ...word,
    isEmphasized: !word.isEmphasized,
  };
}

/**
 * Updates text and cleaned text of a word chip.
 */
export function updateWordText<W extends TimelineWord>(word: W, newText: string): W {
  return {
    ...word,
    text: newText,
    cleanText: newText.toLowerCase().trim(),
  };
}
