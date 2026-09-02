/**
 * A variable-height virtualiser for the transcript list.
 *
 * Segments differ in height (short one-word lines vs. long two-line captions
 * with many word chips), so a fixed-row virtualiser either wastes space or
 * clips content. This keeps a per-index height (an estimate until the row
 * reports its measured height) in a Fenwick tree (binary indexed tree) of
 * prefix sums, so both a single height update and the visible range for a
 * given scroll position are O(log n) — what a 54,000-word, 3-hour transcript
 * needs to stay smooth (acceptance criterion 1: ≥ 55 fps).
 *
 * An earlier version kept a flat prefix-sum array rebuilt lazily on read: a
 * binary search made *reading* the visible range O(log n), but every row
 * that reported a real measured height for the first time (`setHeight`,
 * from `TranscriptList.tsx`'s `ResizeObserver`) invalidated the whole array,
 * so the very next scroll frame paid an O(n) rebuild to get a fresh one.
 * Continuous scrolling through a fresh 54,000-row document is exactly the
 * case where new rows keep entering view for the first time — every frame
 * hit that O(n) path, which measured at ~13 fps against the ≥ 55 fps target
 * (A15b perf run). A Fenwick tree makes the write itself O(log n) instead of
 * merely deferring an O(n) cost to the next read.
 *
 * No DOM, no React: `TranscriptList.tsx` owns the scroll listener and
 * `ResizeObserver`; this class only does the arithmetic, so it can be tested
 * (and its complexity budget proven) without rendering anything.
 */

/**
 * A pre-measurement estimate for a caption row, from its word count alone —
 * no DOM read required. `TranscriptList.tsx` seeds a newly-mounted row's
 * height with this the moment it renders, instead of forcing a synchronous
 * layout (`getBoundingClientRect`) before first paint; the shared
 * `ResizeObserver` corrects it to the real measured height asynchronously
 * once the browser has actually laid the row out.
 *
 * The constants approximate this app's caption row: a header line (speaker
 * chip + timestamp), then wrapped word chips at roughly `WORDS_PER_LINE`
 * words per line at the transcript column's default width. A rough estimate
 * that avoids a forced reflow storm beats an exact one that causes it — the
 * `ResizeObserver` fixes up any drift within a frame or two.
 */
const HEADER_HEIGHT = 28;
const LINE_HEIGHT = 24;
const ROW_VERTICAL_PADDING = 16;
const WORDS_PER_LINE = 12;

export function estimateSegmentHeight(wordCount: number): number {
  const lines = Math.max(1, Math.ceil(wordCount / WORDS_PER_LINE));
  return HEADER_HEIGHT + lines * LINE_HEIGHT + ROW_VERTICAL_PADDING;
}

export interface VisibleRange {
  readonly startIndex: number;
  readonly endIndex: number;
  /** Pixels of blank space above `startIndex`, from index 0. */
  readonly offsetTop: number;
  readonly totalHeight: number;
}

export class VirtualList {
  private heights: number[];
  /** 1-indexed Fenwick tree over `heights`; `tree[i]` covers a range ending at `i`. */
  private tree: number[];
  private readonly defaultHeight: number;

  constructor(count: number, defaultHeight: number) {
    this.defaultHeight = defaultHeight;
    this.heights = new Array(count).fill(defaultHeight) as number[];
    this.tree = buildTree(this.heights);
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
    // A resize is already O(n) (the array itself changed size) and is rare —
    // paging in a chunk or a merge/split, not every scroll frame — so a full
    // tree rebuild here does not reintroduce the per-scroll-frame cost the
    // Fenwick tree exists to avoid.
    this.tree = buildTree(this.heights);
  }

  count(): number {
    return this.heights.length;
  }

  /** A row reported its real rendered height. */
  setHeight(index: number, height: number): void {
    if (index < 0 || index >= this.heights.length) return;
    const previous = this.heights[index] ?? this.defaultHeight;
    if (previous === height) return;
    this.heights[index] = height;
    treeAdd(this.tree, index, height - previous);
  }

  heightOf(index: number): number {
    return this.heights[index] ?? this.defaultHeight;
  }

  totalHeight(): number {
    return treePrefixSum(this.tree, this.heights.length - 1);
  }

  /** Sum of the heights of rows `[0, index)`. */
  offsetOf(index: number): number {
    const clamped = Math.max(0, Math.min(index, this.heights.length));
    return clamped === 0 ? 0 : treePrefixSum(this.tree, clamped - 1);
  }

  /** First index whose row spans `offset` (a Fenwick-tree descent, O(log n)). */
  indexAtOffset(offset: number): number {
    if (this.heights.length === 0) return 0;
    if (offset <= 0) return 0;
    const index = treeFindByPrefixSum(this.tree, offset);
    return Math.min(index, this.heights.length - 1);
  }

  /** The rows to render for a scroll window, padded by `overscan` on both ends. */
  visibleRange(scrollTop: number, viewportHeight: number, overscan = 6): VisibleRange {
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

// ---------------------------------------------------------------------------
// Fenwick tree (binary indexed tree) over 0-indexed `heights`.
// ---------------------------------------------------------------------------

function buildTree(heights: readonly number[]): number[] {
  const tree = new Array<number>(heights.length + 1).fill(0);
  for (let i = 0; i < heights.length; i += 1) {
    treeAdd(tree, i, heights[i] ?? 0);
  }
  return tree;
}

/** Adds `delta` at 0-indexed `index`. O(log n). */
function treeAdd(tree: number[], index: number, delta: number): void {
  if (delta === 0) return;
  let i = index + 1;
  while (i < tree.length) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- i is in [1, tree.length)
    tree[i] = tree[i]! + delta;
    i += i & -i;
  }
}

/** Sum of `heights[0..index]` inclusive (0-indexed). O(log n). */
function treePrefixSum(tree: readonly number[], index: number): number {
  if (index < 0) return 0;
  let i = Math.min(index + 1, tree.length - 1);
  let sum = 0;
  while (i > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- i is in [1, tree.length)
    sum += tree[i]!;
    i -= i & -i;
  }
  return sum;
}

/**
 * The smallest 0-indexed `index` such that the sum of `heights[0..index]`
 * (inclusive) is `>= target`. Standard Fenwick-tree binary lifting, O(log n)
 * — the tree-walk analogue of the old flat array's binary search.
 */
function treeFindByPrefixSum(tree: readonly number[], target: number): number {
  const n = tree.length - 1;
  let pos = 0;
  let remaining = target;
  let step = highestPowerOfTwo(n);
  while (step > 0) {
    const next = pos + step;
    if (next <= n && (tree[next] ?? 0) <= remaining) {
      pos = next;
      remaining -= tree[next] ?? 0;
    }
    step >>>= 1;
  }
  // `pos` is the largest index whose prefix sum is strictly less than
  // `target`; the row spanning `target` is the next one.
  return pos;
}

function highestPowerOfTwo(n: number): number {
  let power = 1;
  while (power * 2 <= n) power *= 2;
  return power;
}
