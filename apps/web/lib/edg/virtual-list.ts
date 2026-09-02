/**
 * A variable-height virtualiser for the transcript list.
 *
 * Segments differ in height (short one-word lines vs. long two-line captions
 * with many word chips), so a fixed-row virtualiser either wastes space or
 * clips content. This keeps a per-index height (an estimate until the row
 * reports its measured height) and a prefix-sum array so the visible range for
 * a given scroll position is a binary search — O(log n) per scroll event,
 * which is what a 54,000-word, 3-hour transcript needs to stay smooth
 * (acceptance criterion 1: ≥ 55 fps).
 *
 * No DOM, no React: `TranscriptList.tsx` owns the scroll listener and
 * `ResizeObserver`; this class only does the arithmetic, so it can be tested
 * (and its complexity budget proven) without rendering anything.
 */

export interface VisibleRange {
  readonly startIndex: number;
  readonly endIndex: number;
  /** Pixels of blank space above `startIndex`, from index 0. */
  readonly offsetTop: number;
  readonly totalHeight: number;
}

export class VirtualList {
  private heights: number[];
  private prefix: number[] = [];
  private dirty = true;
  private readonly defaultHeight: number;

  constructor(count: number, defaultHeight: number) {
    this.defaultHeight = defaultHeight;
    this.heights = new Array(count).fill(defaultHeight) as number[];
  }

  /** The list grew or shrank (more segments paged in, a merge removed one). */
  setCount(count: number): void {
    if (count === this.heights.length) return;
    if (count < this.heights.length) {
      this.heights = this.heights.slice(0, count);
    } else {
      const extra = new Array(count - this.heights.length).fill(this.defaultHeight) as number[];
      this.heights = this.heights.concat(extra);
    }
    this.dirty = true;
  }

  count(): number {
    return this.heights.length;
  }

  /** A row reported its real rendered height. */
  setHeight(index: number, height: number): void {
    if (index < 0 || index >= this.heights.length) return;
    if (this.heights[index] === height) return;
    this.heights[index] = height;
    this.dirty = true;
  }

  heightOf(index: number): number {
    return this.heights[index] ?? this.defaultHeight;
  }

  private ensurePrefix(): void {
    if (!this.dirty) return;
    const prefix = new Array<number>(this.heights.length + 1);
    prefix[0] = 0;
    for (let index = 0; index < this.heights.length; index += 1) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- prefix[index] is always set by this point in the loop
      prefix[index + 1] = prefix[index]! + this.heights[index]!;
    }
    this.prefix = prefix;
    this.dirty = false;
  }

  totalHeight(): number {
    this.ensurePrefix();
    return this.prefix[this.prefix.length - 1] ?? 0;
  }

  offsetOf(index: number): number {
    this.ensurePrefix();
    const clamped = Math.max(0, Math.min(index, this.heights.length));
    return this.prefix[clamped] ?? 0;
  }

  /** First index whose row spans `offset` (binary search over the prefix sums). */
  indexAtOffset(offset: number): number {
    this.ensurePrefix();
    if (this.heights.length === 0) return 0;
    let low = 0;
    let high = this.heights.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- middle is in range [low, high) of a fully-populated prefix array
      if (this.prefix[middle + 1]! <= offset) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /** The rows to render for a scroll window, padded by `overscan` on both ends. */
  visibleRange(scrollTop: number, viewportHeight: number, overscan = 6): VisibleRange {
    this.ensurePrefix();
    if (this.heights.length === 0) {
      return { startIndex: 0, endIndex: -1, offsetTop: 0, totalHeight: 0 };
    }
    const rawStart = this.indexAtOffset(Math.max(0, scrollTop));
    const rawEnd = this.indexAtOffset(Math.max(0, scrollTop + viewportHeight));
    const startIndex = Math.max(0, rawStart - overscan);
    const endIndex = Math.min(this.heights.length - 1, rawEnd + overscan);
    return {
      startIndex,
      endIndex,
      offsetTop: this.offsetOf(startIndex),
      totalHeight: this.totalHeight(),
    };
  }
}
