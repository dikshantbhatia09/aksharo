"use client";

/**
 * The editor's timeline (A17, brief `A17-web-timeline.md`): a waveform,
 * word/segment lanes, a draggable playhead and read-only cut/zoom/audio
 * lanes, all drawn on one Canvas2D surface for performance — not one DOM
 * node per word, which is what makes a multi-hour transcript still hit the
 * brief's 55 fps floor (`stage-geometry.ts`/`CaptionStage.tsx` set the same
 * precedent for the caption canvas).
 *
 * Every piece of maths — coordinates, snapping, the output-time clock, lane
 * layout, the nudge signal — lives in `lib/timeline/*.ts` and is unit-tested
 * there without a browser; this component is the thin, `"use client"` glue
 * around a `<canvas>`, exactly the split `stage-geometry.ts`/`CaptionStage.tsx`
 * already established, and (like `CaptionStage.tsx`) is exercised by
 * Playwright rather than jsdom (`vitest.config.ts` excludes
 * `components/editor/**\/*.tsx` from the coverage gate for the same reason:
 * a canvas draw has no useful jsdom answer).
 *
 * Ops never come from here directly — every drag ends in a prop callback
 * (`onSetSegmentBounds`, `onSplitSegment`, `onMergeSegments`), same contract
 * as `CaptionStage`'s `onOp`, so the caller (the editor page) is the only
 * place that touches `EditorStore`.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { newId, parseWordId } from "@montaj/edg";
import type { EdgOp, PassItem, Segment, Word } from "@montaj/edg";
import type { TimeMap } from "@montaj/timemap";

import {
  buildCaptionDelayOps,
  buildRemoveEmojiOps,
  buildRemoveEmphasisOps,
  buildRemoveGapsOps,
  buildRemovePunctuationOps,
  clampCaptionDelayMs,
} from "@/components/editor/timeline/caption-tools";
import {
  BulkActionsBar,
  type ResegmentParams,
} from "@/components/editor/transcript/BulkActionsBar";
import { type DisplayScript } from "@/components/editor/transcript/WordChip";
import { findMatches } from "@/lib/edg/find-replace";
import {
  clampScroll,
  msToPx,
  pxToMs,
  ruleTicks,
  tickStepMs,
  visibleRange,
  zoomAround,
  type Viewport,
} from "@/lib/timeline/coords";
import {
  decodeItemKeyframes,
  keyframeMarkersOf,
  zoomMiniPlotPoints,
} from "@/lib/timeline/keyframe-markers";
import {
  buildLanes,
  laneItemStrokeStyle,
  laneStateColor,
  type LaneItem,
  type LaneRow,
} from "@/lib/timeline/lanes";
import {
  noopNudgeSink,
  segmentEdgeNudge,
  type TimingNudgeSink,
  wordEdgeNudge,
} from "@/lib/timeline/nudge";
import {
  displayDurationMs,
  isCutAway,
  outputModeAvailable,
  toDisplayMs,
  toSourceMs,
  type TimeDisplayMode,
} from "@/lib/timeline/output-clock";
import { resolvePassItemDrag, type PassItemNeighbour } from "@/lib/timeline/pass-item-drag";
import { resolveSegmentDrag, resolveWordEdgeDrag, type Neighbour } from "@/lib/timeline/snapping";
import { useMemoryNudgeSink } from "@/lib/timeline/use-memory-nudge-sink";
import { reduceWaveform, type WaveformLike } from "@/lib/timeline/waveform-view";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Layout constants (CSS px)
// ---------------------------------------------------------------------------

const RULER_HEIGHT = 24;
/** K03: the video filmstrip lane, drawn above the waveform (Kalakar's "Video 1" track). */
const THUMB_LANE_HEIGHT = 32;
const WAVEFORM_HEIGHT = 64;
const WORD_LANE_HEIGHT = 28;
const SEGMENT_LANE_HEIGHT = 36;
const PASS_LANE_HEIGHT = 20;
const LANE_GAP = 2;
const EDGE_HIT_PX = 6;
const MIN_PX_PER_WORD_LABEL = 28;
/** K03: below this chip width a LINE-granularity caption's text is skipped, same rule as a word chip's label. */
const MIN_PX_PER_LINE_LABEL = 28;

/** K03: caption-lane granularity — one chip per word, or one merged chip per segment. */
export type TimelineGranularity = "word" | "line";

/**
 * K03: the Caption Tools dropdown's resegment dialog needs *some* starting
 * params when the caller (`editor-client.tsx`) does not pass its own — this
 * mirrors that page's `DEFAULT_RESEGMENT_PARAMS` so the timeline's second
 * entry point behaves the same as the transcript column's even if a future
 * caller forgets to thread `resegmentDefaultParams` through.
 */
const FALLBACK_RESEGMENT_PARAMS: ResegmentParams = {
  maxChars: 32,
  maxLines: 2,
  minMs: 800,
  maxMs: 4500,
  dropFillers: false,
};

/**
 * K06: the Caption Delay Control's slider range, before `clampCaptionDelayMs`
 * further restricts it to what actually fits the media duration — plus or
 * minus five seconds is enough room to fix a typical sync drift without the
 * slider being mostly dead space.
 */
const CAPTION_DELAY_RANGE_MS = 5_000;
const CAPTION_DELAY_STEP_MS = 50;

/** One user-marked protected range, as stored on `EdgHot.protected` (CONTRACTS §2). */
export interface ProtectedRange {
  readonly id: string;
  readonly s: number;
  readonly e: number;
}

export interface SegmentBoundsOp {
  readonly segmentId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly startWordId?: string;
  readonly endWordId?: string;
}

/** One resolved word-edge drag, ready for `SetWordTiming{wordId, s, e}` (A02d). */
export interface WordTimingOp {
  readonly wordId: string;
  readonly s: number;
  readonly e: number;
}

/** One resolved pass-item edge drag, ready for `EditPassItem{itemId, startMs, endMs}` (B20b). */
export interface PassItemBoundsOp {
  readonly itemId: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** Editable kinds and states for drag-to-adjust (CONTRACTS §2, B20b). */
const EDITABLE_PASS_ITEM_KINDS = new Set<LaneItem["kind"]>(["cut", "zoom", "reframe"]);
const EDITABLE_PASS_ITEM_STATES = new Set<LaneItem["state"]>(["proposed", "accepted"]);

function isPassItemEditable(item: LaneItem): boolean {
  return EDITABLE_PASS_ITEM_KINDS.has(item.kind) && EDITABLE_PASS_ITEM_STATES.has(item.state);
}

export interface TimelineProps {
  readonly words: readonly Word[];
  readonly segments: readonly Segment[];
  readonly passItems?: readonly PassItem[];
  readonly waveform?: WaveformLike;
  /** `EdgHot.protected` (CONTRACTS §2, B18b) — drawn as a band under the ruler. */
  readonly protectedRanges?: readonly ProtectedRange[];
  /**
   * Toggles protection on the current selection's `[startMs, endMs]` (the "P"
   * key, or a caller's own button): a selected segment when nothing narrower
   * is picked. `undefined` disables the shortcut (no selection to protect).
   */
  readonly onToggleProtection?: (s: number, e: number) => void;
  readonly durationMs: number;
  readonly playheadMs: number;
  readonly playing?: boolean;
  readonly onSeek: (ms: number) => void;
  readonly onTogglePlay?: () => void;
  readonly selectedSegmentId?: string;
  readonly selectedWordId?: string;
  readonly onSelectSegment?: (segmentId: string | undefined) => void;
  readonly onSelectWord?: (segmentId: string, wordId: string) => void;
  readonly onSetSegmentBounds: (op: SegmentBoundsOp) => void;
  readonly onSetWordTiming?: (op: WordTimingOp) => void;
  readonly onSplitSegment?: (segmentId: string, atWordId: string) => void;
  readonly onMergeSegments?: (segmentIds: readonly [string, string]) => void;
  readonly timeMap?: TimeMap;
  readonly displayMode?: TimeDisplayMode;
  readonly onDisplayModeChange?: (mode: TimeDisplayMode) => void;
  readonly nudgeSink?: TimingNudgeSink;
  /** B20 §4: hover a lane item to see its reason; `undefined` on mouse-leave. */
  readonly onHoverPassItem?: (item: LaneItem | undefined) => void;
  /** B20 §4: click a lane item to select its `ProposalCard` in the Passes tab. */
  readonly onSelectPassItem?: (item: LaneItem) => void;
  /** B20b: drag-to-adjust a proposed/accepted cut/zoom/reframe item's edge. */
  readonly onEditPassItem?: (op: PassItemBoundsOp) => void;
  /**
   * K03: presigned thumbnail URLs for the source video, `media_assets.thumb_keys`
   * order (worker-media's evenly-spaced filmstrip, `apps/worker-media/src/ffmpeg/derive.ts`'s
   * `THUMBNAIL_COUNT`) — undefined/empty draws no filmstrip (audio-only media,
   * or not derived yet).
   */
  readonly thumbnails?: readonly string[];
  /** K03: which per-word text the search box matches against; same default as `editor-client.tsx`'s `wordScript`. */
  readonly wordScript?: DisplayScript;
  /** K03: Caption Tools dropdown — same three actions `BulkActionsBar.tsx` exposes in the transcript column. */
  readonly onMergeShortCaptions?: () => void;
  readonly onSplitLongCaptions?: () => void;
  readonly onResegmentCaptions?: (params: ResegmentParams) => void;
  readonly resegmentDefaultParams?: ResegmentParams;
  readonly bulkActionsBusy?: boolean;
  /**
   * K06: Caption Tools' Display Settings/Actions/Timing sections (the real
   * Kalakar-parity structure — `ADDENDUM-full-frame-audit.md` "New gap 4").
   * Every Action and the Delay Control's Apply button build a real, already-
   * batched `EdgOp[]` themselves (`caption-tools.ts`) — Timeline.tsx never
   * submits an op to any store, same contract as `onSetSegmentBounds`/
   * `onResegmentCaptions` above, so this callback only has to forward the
   * batch (e.g. `store.submitOps(ops, { label })`). `label` is a short,
   * human-readable description of the batch, for a queue/undo-stack entry.
   * `undefined` does not hide the section (the structure still matches the
   * reference frames) but disables its mutating controls, since a click that
   * does nothing would be exactly the "no-op UI element" the brief forbids.
   */
  readonly onCaptionToolsAction?: (ops: readonly EdgOp[], label: string) => void;
  readonly className?: string;
}

interface DragState {
  readonly pointerId: number;
  readonly kind: "segment-edge" | "word-edge" | "pass-item-edge" | "playhead";
  readonly segmentId?: string;
  readonly wordId?: string;
  readonly itemId?: string;
  readonly edge?: "start" | "end";
  readonly startMs?: number;
  readonly endMs?: number;
}

/** A word id's document-order sort key: chunk first, then its position inside the chunk. */
function wordOrderKey(wid: string): number {
  const p = parseWordId(wid);
  return p.chunkIdx * 1_000_000 + p.n;
}

/** `true` when `wid` falls in `[startWordId, endWordId]` by chunk/sequence order, not string order. */
function wordIdWithin(wid: string, startWordId: string, endWordId: string): boolean {
  const k = wordOrderKey(wid);
  return k >= wordOrderKey(startWordId) && k <= wordOrderKey(endWordId);
}

export function Timeline(props: TimelineProps): React.JSX.Element {
  const {
    words,
    segments,
    passItems = [],
    waveform,
    protectedRanges = [],
    onToggleProtection,
    durationMs,
    playheadMs,
    playing = false,
    onSeek,
    onTogglePlay,
    selectedSegmentId,
    selectedWordId,
    onSelectSegment,
    onSelectWord,
    onSetSegmentBounds,
    onSetWordTiming,
    onSplitSegment,
    onMergeSegments,
    timeMap,
    displayMode = "source",
    onDisplayModeChange,
    nudgeSink = noopNudgeSink,
    onHoverPassItem,
    onSelectPassItem,
    onEditPassItem,
    thumbnails,
    wordScript = "roman",
    onMergeShortCaptions,
    onSplitLongCaptions,
    onResegmentCaptions,
    resegmentDefaultParams = FALLBACK_RESEGMENT_PARAMS,
    bulkActionsBusy = false,
    onCaptionToolsAction,
    className,
  } = props;

  // B09b: the real sink (`memory-nudge-sink.ts`, consent-gated) is the
  // effective default. A caller passing its own `nudgeSink` (a test double,
  // or a future override) still wins — only the shared `noopNudgeSink`
  // singleton is replaced, by identity, never a sink that merely behaves
  // like it.
  const memoryNudgeSink = useMemoryNudgeSink();
  const resolvedNudgeSink = nudgeSink === noopNudgeSink ? memoryNudgeSink : nudgeSink;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const dragPreviewRef = useRef<{ startMs: number; endMs: number } | undefined>(undefined);

  const [widthPx, setWidthPx] = useState(0);
  const [msPerPx, setMsPerPx] = useState(30);
  const [scrollMs, setScrollMs] = useState(0);
  // Read once per mount: `--color-info` (`packages/ui/src/styles/tokens.css`)
  // resolved against the DOM, since a Canvas2D `fillStyle` cannot read a CSS
  // custom property itself. Falls back to the token's own default so a test
  // environment with no stylesheet still draws something legible.
  const [protectedColor, setProtectedColor] = useState("#4ea1ff");
  const [selectedEdge, setSelectedEdge] = useState<"start" | "end" | undefined>(undefined);
  const [selectedWordEdge, setSelectedWordEdge] = useState<"start" | "end" | undefined>(undefined);
  const [hoveredPassItemId, setHoveredPassItemId] = useState<string | undefined>(undefined);
  const [, forceRedraw] = useState(0);

  // K03: caption-lane granularity (word chips vs. one merged chip per
  // segment), the search box's query, and the Caption Tools dropdown's own
  // open state — all purely local UI state, never round-tripped through
  // `editor-client.tsx` (brief §1: "do not add a prop round-trip ... unless
  // the toggle needs to affect something outside the timeline").
  const [granularity, setGranularity] = useState<TimelineGranularity>("word");
  const [searchQuery, setSearchQuery] = useState("");
  const [captionToolsOpen, setCaptionToolsOpen] = useState(false);
  const captionToolsRef = useRef<HTMLDivElement | null>(null);

  // K06: Display Settings' Max Chars/Lines draft — local until the user
  // commits (Enter/blur on the number field, immediately on the Lines
  // select), never on every keystroke: `Resegment` replaces every segment id
  // and discards manual edits (A15's decision D78, "never resegment
  // silently"), so this only fires on a deliberate commit, and `lastAppliedRef`
  // skips a redundant call when blur fires without the value having changed.
  const [maxCharsDraft, setMaxCharsDraft] = useState(resegmentDefaultParams.maxChars);
  const [maxLinesDraft, setMaxLinesDraft] = useState(resegmentDefaultParams.maxLines);
  const lastAppliedDisplaySettingsRef = useRef({
    maxChars: resegmentDefaultParams.maxChars,
    maxLines: resegmentDefaultParams.maxLines,
  });

  // K06: the Caption Delay Control's live-preview offset — purely local state
  // (same convention as `granularity`/`searchQuery` above), redrawn straight
  // into the word/segment lanes below so dragging the slider visibly shifts
  // every caption on the timeline immediately, before any op is ever built.
  const [delayPreviewMs, setDelayPreviewMs] = useState(0);
  /** K03: `Image` objects for the thumbnail filmstrip, keyed by URL so a scroll/zoom redraw never re-decodes one. */
  const thumbImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const measure = (): void => setWidthPx(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (element === null || typeof window === "undefined") return;
    const value = window.getComputedStyle(element).getPropertyValue("--color-info").trim();
    if (value !== "") setProtectedColor(value);
  }, []);

  const viewport: Viewport = useMemo(
    () => ({ scrollMs, msPerPx, widthPx }),
    [scrollMs, msPerPx, widthPx],
  );

  const liveWords = useMemo(() => words.filter((w) => w.deleted !== true), [words]);
  const wordBoundariesOf = useCallback(
    (segment: Segment): number[] => {
      const boundaries: number[] = [];
      for (const word of liveWords) {
        if (word.s >= segment.startMs - 1 && word.e <= segment.endMs + 1) {
          boundaries.push(word.s, word.e);
        }
      }
      return boundaries;
    },
    [liveWords],
  );

  // K03: LINE granularity's merged chip text, one pass over `liveWords` per
  // `[segments, liveWords]` change (not per draw) — both arrays are already in
  // document order (`WordIndex`'s Map preserves insertion order, `segments` is
  // `orderedSegments(state)`), so a single two-pointer sweep keyed by
  // `wordOrderKey` correctly buckets every live word into its owning segment
  // in O(words + segments) instead of an O(words × segments) filter per chip.
  const segmentTextById = useMemo(() => {
    const map = new Map<string, string>();
    let index = 0;
    for (const segment of segments) {
      const startKey = wordOrderKey(segment.startWordId);
      const endKey = wordOrderKey(segment.endWordId);
      const parts: string[] = [];
      while (index < liveWords.length) {
        // eslint-disable-next-line security/detect-object-injection -- bracket access on a loop-bounded numeric index, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
        const word = liveWords[index];
        if (word === undefined || wordOrderKey(word.wid) > endKey) break;
        if (wordOrderKey(word.wid) >= startKey) parts.push(word.t);
        index += 1;
      }
      map.set(segment.id, parts.join(" "));
    }
    return map;
  }, [segments, liveWords]);

  // K03: the search box's matches, reusing `FindReplaceDialog.tsx`'s own
  // matcher (`lib/edg/find-replace.ts`'s `findMatches`) rather than
  // reimplementing substring matching — an empty query is the same "nothing
  // to search" no-op `findMatches` itself already returns.
  const searchMatches = useMemo(
    () =>
      searchQuery === ""
        ? []
        : findMatches(liveWords, searchQuery, wordScript, { caseSensitive: false }),
    [liveWords, searchQuery, wordScript],
  );
  const searchMatchWordIds = useMemo(
    () => new Set(searchMatches.map((match) => match.wordId)),
    [searchMatches],
  );

  // K03: jump the viewport to the first match, centred, whenever the query
  // text itself changes — deliberately *not* whenever `searchMatches` is
  // merely recomputed (e.g. an unrelated edit elsewhere re-renders this
  // component while a search is active), which would otherwise fight a user
  // who has since scrolled or zoomed away from the jump.
  useEffect(() => {
    if (searchQuery === "") return;
    const first = searchMatches[0];
    if (first === undefined) return;
    const word = liveWords.find((w) => w.wid === first.wordId);
    if (word === undefined) return;
    setScrollMs(
      clampScroll(Math.max(0, word.s - (widthPx / 2) * msPerPx), { msPerPx, widthPx }, durationMs),
    );
    // Only the query text should trigger a jump; see comment above — `searchMatches`,
    // `liveWords`, `widthPx`, `msPerPx` and `durationMs` are read, not depended on.
  }, [searchQuery]);

  /** K03: an `HTMLImageElement` for a thumbnail URL, decoded once and cached across redraws. */
  const getThumbImage = useCallback((url: string): HTMLImageElement => {
    const cache = thumbImagesRef.current;
    const cached = cache.get(url);
    if (cached !== undefined) return cached;
    const img = new Image();
    img.onload = () => forceRedraw((n) => n + 1);
    img.src = url;
    cache.set(url, img);
    return img;
  }, []);

  const lanes: readonly LaneRow[] = useMemo(() => buildLanes(passItems), [passItems]);
  /** B20b: full pass items by id — `LaneItem` strips `payload`, but the zoom
   * lane's mini-plot needs the item's own keyframe curve to decode. */
  const passItemsById = useMemo(
    () => new Map(passItems.map((item) => [item.itemId, item])),
    [passItems],
  );

  const laneTops = useMemo(() => {
    let y = RULER_HEIGHT;
    // K03: the video filmstrip sits above the waveform (Kalakar's Video/Audio
    // track order) — reserved unconditionally, like every other lane, so the
    // layout does not jump once thumbnails finish loading (same convention
    // `WAVEFORM_HEIGHT` already sets for a waveform that has not arrived yet).
    const thumbTop = y;
    y += THUMB_LANE_HEIGHT + LANE_GAP;
    const waveformTop = y;
    y += WAVEFORM_HEIGHT + LANE_GAP;
    const wordTop = y;
    y += WORD_LANE_HEIGHT + LANE_GAP;
    const segmentTop = y;
    y += SEGMENT_LANE_HEIGHT + LANE_GAP;
    const passTops: number[] = [];
    for (const _lane of lanes) {
      passTops.push(y);
      y += PASS_LANE_HEIGHT + LANE_GAP;
    }
    return { thumbTop, waveformTop, wordTop, segmentTop, passTops, totalHeight: y };
  }, [lanes]);

  const displayDuration = displayDurationMs(durationMs, displayMode, timeMap);
  const displayPlayheadMs = toDisplayMs(playheadMs, displayMode, timeMap);

  // ---------------------------------------------------------------------
  // Draw
  // ---------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || widthPx <= 0) return;
    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(widthPx * dpr));
    canvas.height = Math.max(1, Math.round(laneTops.totalHeight * dpr));
    canvas.style.width = `${String(widthPx)}px`;
    canvas.style.height = `${String(laneTops.totalHeight)}px`;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, widthPx, laneTops.totalHeight);

    const { startMs, endMs } = visibleRange(viewport, 50);

    // Ruler
    ctx.fillStyle = "#0b0b12";
    ctx.fillRect(0, 0, widthPx, RULER_HEIGHT);
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = "10px sans-serif";
    // The ruler is drawn across the whole canvas, whose span is `widthPx *
    // msPerPx` and owes nothing to the media: a 20.2 s clip at the default
    // 30 ms/px on a ~1170 px timeline labelled ticks out to 00:35 (FIX-02 step
    // 6, audit 2026-09-04). `clampScroll` already treats `durationMs` as the
    // content extent; the ruler now agrees, stopping one major tick past the
    // end so the last label is still reachable. `durationMs === 0` (no media
    // loaded yet) keeps the old full-width ruler rather than drawing none.
    const rulerEndMs = durationMs > 0 ? Math.min(endMs, durationMs + tickStepMs(msPerPx)) : endMs;
    for (const tickSourceMs of ruleTicks(startMs, rulerEndMs, msPerPx)) {
      const tickMs = toDisplayMs(tickSourceMs, displayMode, timeMap);
      const px = msToPx(tickSourceMs, viewport);
      ctx.beginPath();
      ctx.moveTo(px, RULER_HEIGHT - 8);
      ctx.lineTo(px, RULER_HEIGHT);
      ctx.stroke();
      ctx.fillText(formatMs(tickMs), px + 2, RULER_HEIGHT - 10);
    }

    // Protected ranges (B18b): a translucent band the full lane height, under
    // everything else, so a range's word/segment/pass content still reads.
    for (const range of protectedRanges) {
      if (range.e < startMs || range.s > endMs) continue;
      const x0 = msToPx(range.s, viewport);
      const x1 = msToPx(range.e, viewport);
      const w = Math.max(1, x1 - x0);
      ctx.fillStyle = protectedColor;
      ctx.globalAlpha = 0.18;
      ctx.fillRect(x0, RULER_HEIGHT, w, laneTops.totalHeight - RULER_HEIGHT);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = protectedColor;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(x0 + 0.5, RULER_HEIGHT);
      ctx.lineTo(x0 + 0.5, laneTops.totalHeight);
      ctx.moveTo(x1 - 0.5, RULER_HEIGHT);
      ctx.lineTo(x1 - 0.5, laneTops.totalHeight);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // K03: video filmstrip — up to `THUMBNAIL_COUNT` (worker-media,
    // evenly-spaced midpoints of the whole clip) presigned JPEGs, each
    // stretched across its own `1/count` slice of the timeline. Virtualised
    // the same way the waveform is: a slice outside `[startMs, endMs]` is
    // skipped, so drawing never costs more than the (at most ten) slices
    // actually on screen, regardless of zoom.
    if (thumbnails !== undefined && thumbnails.length > 0) {
      ctx.fillStyle = "#0f0f16";
      ctx.fillRect(0, laneTops.thumbTop, widthPx, THUMB_LANE_HEIGHT);
      const count = thumbnails.length;
      for (const [index, url] of thumbnails.entries()) {
        const sliceStartMs = Math.floor((durationMs * index) / count);
        const sliceEndMs = Math.floor((durationMs * (index + 1)) / count);
        if (sliceEndMs < startMs || sliceStartMs > endMs) continue;
        const x0 = msToPx(sliceStartMs, viewport);
        const x1 = msToPx(sliceEndMs, viewport);
        const w = Math.max(1, x1 - x0);
        const img = getThumbImage(url);
        if (img.complete && img.naturalWidth > 0) {
          ctx.drawImage(img, x0, laneTops.thumbTop, w, THUMB_LANE_HEIGHT);
        } else {
          ctx.fillStyle = "rgba(255,255,255,0.06)";
          ctx.fillRect(x0, laneTops.thumbTop, w, THUMB_LANE_HEIGHT);
        }
        if (index > 0) {
          ctx.strokeStyle = "rgba(0,0,0,0.4)";
          ctx.beginPath();
          ctx.moveTo(x0 + 0.5, laneTops.thumbTop);
          ctx.lineTo(x0 + 0.5, laneTops.thumbTop + THUMB_LANE_HEIGHT);
          ctx.stroke();
        }
      }
    }

    // Waveform
    if (waveform !== undefined) {
      const buckets = reduceWaveform(
        waveform,
        Math.max(0, startMs),
        Math.min(durationMs, endMs),
        widthPx,
      );
      const midY = laneTops.waveformTop + WAVEFORM_HEIGHT / 2;
      ctx.fillStyle = "rgba(124,143,240,0.25)";
      ctx.strokeStyle = "#7c8ff0";
      for (let px = 0; px < buckets.length; px++) {
        // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
        const bucket = buckets[px];
        if (bucket === undefined) continue;
        const sourceMs = pxToMs(px, viewport);
        const cutAway = isCutAway(sourceMs, timeMap);
        const peakH = bucket.peak * (WAVEFORM_HEIGHT / 2);
        const energyH = bucket.energy * (WAVEFORM_HEIGHT / 2);
        ctx.globalAlpha = cutAway ? 0.25 : 1;
        ctx.fillRect(px, midY - peakH, 1, peakH * 2);
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.strokeRect(px, midY - energyH, 1, energyH * 2);
        ctx.globalAlpha = 1;
      }
    }

    // Caption lane: one chip per word (WORD) or one merged chip per segment
    // (LINE, brief §1) — a purely visual switch, `words`/`segments` are never
    // touched, so toggling back to WORD always shows the exact same
    // words/timings it did before.
    if (granularity === "word") {
      for (const word of liveWords) {
        const preview =
          dragRef.current?.kind === "word-edge" && dragRef.current.wordId === word.wid
            ? dragPreviewRef.current
            : undefined;
        // K06: the Caption Delay Control's live preview — added only for the
        // caption lanes' draw position, never to `word.s`/`e` themselves (the
        // underlying data is untouched until Apply), so a non-zero preview
        // visibly shifts every chip without moving anything the waveform,
        // thumbnails or a concurrent edge-drag still read from.
        const wordStartMs = (preview?.startMs ?? word.s) + delayPreviewMs;
        const wordEndMs = (preview?.endMs ?? word.e) + delayPreviewMs;
        if (wordEndMs < startMs || wordStartMs > endMs) continue;
        const x0 = msToPx(wordStartMs, viewport);
        const x1 = msToPx(wordEndMs, viewport);
        const w = Math.max(1, x1 - x0);
        const selected = word.wid === selectedWordId;
        const lowConfidence = word.c !== undefined && word.c < 0.6;
        ctx.fillStyle = selected
          ? "#ffffff"
          : word.filler === true
            ? "rgba(255,255,255,0.15)"
            : "rgba(255,255,255,0.3)";
        ctx.fillRect(x0, laneTops.wordTop, w, WORD_LANE_HEIGHT);
        if (lowConfidence) {
          ctx.fillStyle = "#f59e0b";
          ctx.fillRect(x0, laneTops.wordTop + WORD_LANE_HEIGHT - 2, w, 2);
        }
        if (selected) {
          ctx.fillStyle = "#7c8ff0";
          ctx.fillRect(x0 - 1, laneTops.wordTop, 2, WORD_LANE_HEIGHT);
          ctx.fillRect(x1 - 1, laneTops.wordTop, 2, WORD_LANE_HEIGHT);
        }
        if (searchMatchWordIds.has(word.wid)) {
          ctx.strokeStyle = "#facc15";
          ctx.lineWidth = 2;
          ctx.strokeRect(x0 + 1, laneTops.wordTop + 1, Math.max(0, w - 2), WORD_LANE_HEIGHT - 2);
          ctx.lineWidth = 1;
        }
        if (w >= MIN_PX_PER_WORD_LABEL) {
          ctx.fillStyle = selected ? "#0b0b12" : "rgba(255,255,255,0.9)";
          ctx.font = "11px sans-serif";
          ctx.fillText(word.t, x0 + 2, laneTops.wordTop + WORD_LANE_HEIGHT - 9, w - 4);
        }
      }
    } else {
      for (const segment of segments) {
        // K06: same live-preview shift as the WORD branch above.
        const segStartMs = segment.startMs + delayPreviewMs;
        const segEndMs = segment.endMs + delayPreviewMs;
        if (segEndMs < startMs || segStartMs > endMs) continue;
        const x0 = msToPx(segStartMs, viewport);
        const x1 = msToPx(segEndMs, viewport);
        const w = Math.max(1, x1 - x0);
        const selected = segment.id === selectedSegmentId;
        const hasMatch = liveWords.some(
          (word) =>
            word.s >= segment.startMs - 1 &&
            word.e <= segment.endMs + 1 &&
            searchMatchWordIds.has(word.wid),
        );
        ctx.fillStyle = selected ? "#ffffff" : "rgba(255,255,255,0.3)";
        ctx.fillRect(x0, laneTops.wordTop, w, WORD_LANE_HEIGHT);
        if (selected) {
          ctx.fillStyle = "#7c8ff0";
          ctx.fillRect(x0 - 1, laneTops.wordTop, 2, WORD_LANE_HEIGHT);
          ctx.fillRect(x1 - 1, laneTops.wordTop, 2, WORD_LANE_HEIGHT);
        }
        if (hasMatch) {
          ctx.strokeStyle = "#facc15";
          ctx.lineWidth = 2;
          ctx.strokeRect(x0 + 1, laneTops.wordTop + 1, Math.max(0, w - 2), WORD_LANE_HEIGHT - 2);
          ctx.lineWidth = 1;
        }
        if (w >= MIN_PX_PER_LINE_LABEL) {
          const text = segmentTextById.get(segment.id) ?? "";
          ctx.fillStyle = selected ? "#0b0b12" : "rgba(255,255,255,0.9)";
          ctx.font = "11px sans-serif";
          ctx.fillText(text, x0 + 2, laneTops.wordTop + WORD_LANE_HEIGHT - 9, w - 4);
        }
      }
    }

    // Segment lane
    for (const segment of segments) {
      const preview =
        dragRef.current?.kind === "segment-edge" && dragRef.current.segmentId === segment.id
          ? dragPreviewRef.current
          : undefined;
      // K06: the Caption Delay Control's live preview, same as the caption
      // lane above — an active edge-drag preview wins over it (a user is not
      // doing both at once, but the drag's own in-progress value must never
      // be second-guessed by a stale slider position).
      const startMsS = (preview?.startMs ?? segment.startMs) + delayPreviewMs;
      const endMsS = (preview?.endMs ?? segment.endMs) + delayPreviewMs;
      if (endMsS < startMs || startMsS > endMs) continue;
      const x0 = msToPx(startMsS, viewport);
      const x1 = msToPx(endMsS, viewport);
      const w = Math.max(1, x1 - x0);
      const selected = segment.id === selectedSegmentId;
      ctx.fillStyle =
        segment.hidden === true
          ? "rgba(255,255,255,0.06)"
          : selected
            ? "rgba(124,143,240,0.5)"
            : "rgba(124,143,240,0.25)";
      ctx.fillRect(x0, laneTops.segmentTop, w, SEGMENT_LANE_HEIGHT);
      if (segment.hidden === true) {
        ctx.strokeStyle = "rgba(255,255,255,0.3)";
        for (let hx = x0; hx < x1; hx += 6) {
          ctx.beginPath();
          ctx.moveTo(hx, laneTops.segmentTop);
          ctx.lineTo(hx + SEGMENT_LANE_HEIGHT, laneTops.segmentTop + SEGMENT_LANE_HEIGHT);
          ctx.stroke();
        }
      }
      ctx.strokeStyle = selected ? "#ffffff" : "rgba(124,143,240,0.6)";
      ctx.strokeRect(
        x0 + 0.5,
        laneTops.segmentTop + 0.5,
        Math.max(0, w - 1),
        SEGMENT_LANE_HEIGHT - 1,
      );
      if (selected) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x0 - 1, laneTops.segmentTop, 2, SEGMENT_LANE_HEIGHT);
        ctx.fillRect(x1 - 1, laneTops.segmentTop, 2, SEGMENT_LANE_HEIGHT);
      }
      // Reference-video parity (addendum "New gap 5"): once a block is wide
      // enough to hold a real label, show the caption's own text instead of
      // just a colour bar -- same threshold and lookup the LINE-mode word
      // lane above already uses, so a caption reads consistently wherever it
      // appears on the timeline.
      if (segment.hidden !== true && w >= MIN_PX_PER_LINE_LABEL) {
        const text = segmentTextById.get(segment.id) ?? "";
        ctx.fillStyle = selected ? "#0b0b12" : "rgba(255,255,255,0.9)";
        ctx.font = "11px sans-serif";
        ctx.fillText(text, x0 + 2, laneTops.segmentTop + SEGMENT_LANE_HEIGHT - 9, w - 4);
      }
    }

    // Pass lanes: dimmed+struck-through when accepted, dashed when proposed
    // (brief §4); a hovered item gets a highlight outline so a reviewer can
    // tell the lane is what their pointer is over before the tooltip lands.
    lanes.forEach((lane, laneIndex) => {
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      const top = laneTops.passTops[laneIndex];
      if (top === undefined) return;
      for (const item of lane.items) {
        const preview =
          dragRef.current?.kind === "pass-item-edge" && dragRef.current.itemId === item.itemId
            ? dragPreviewRef.current
            : undefined;
        const itemStartMs = preview?.startMs ?? item.startMs;
        const itemEndMs = preview?.endMs ?? item.endMs;
        if (itemEndMs < startMs || itemStartMs > endMs) continue;
        const x0 = msToPx(itemStartMs, viewport);
        const x1 = msToPx(itemEndMs, viewport);
        const w = Math.max(1, x1 - x0);
        const style = laneItemStrokeStyle(item.state);
        ctx.fillStyle = laneStateColor(item.state);
        ctx.globalAlpha = style.alpha;
        ctx.fillRect(x0, top, w, PASS_LANE_HEIGHT);
        if (style.dash.length > 0) {
          ctx.save();
          ctx.setLineDash(style.dash);
          ctx.strokeStyle = laneStateColor(item.state);
          ctx.lineWidth = 1;
          ctx.strokeRect(x0 + 0.5, top + 0.5, w - 1, PASS_LANE_HEIGHT - 1);
          ctx.restore();
        }
        if (style.struckThrough) {
          ctx.strokeStyle = "#0a0a0a";
          ctx.globalAlpha = 0.6;
          ctx.beginPath();
          ctx.moveTo(x0, top + PASS_LANE_HEIGHT / 2);
          ctx.lineTo(x1, top + PASS_LANE_HEIGHT / 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        if (hoveredPassItemId === item.itemId) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2;
          ctx.strokeRect(x0, top, w, PASS_LANE_HEIGHT);
          ctx.lineWidth = 1;
        }

        // B20b: keyframe markers + the zoom lane's mini scale-curve plot,
        // from the item's own decoded (inline-only) curve.
        if (lane.kind === "zoom") {
          const fullItem = passItemsById.get(item.itemId);
          const frames = fullItem === undefined ? undefined : decodeItemKeyframes(fullItem.payload);
          if (frames !== undefined && frames.length > 0) {
            const markers = keyframeMarkersOf(frames, itemStartMs);
            const plotHeight = Math.min(8, PASS_LANE_HEIGHT - 4);
            const plotTop = top + PASS_LANE_HEIGHT - plotHeight - 2;
            const points = zoomMiniPlotPoints(
              markers,
              { startMs: itemStartMs, endMs: itemEndMs },
              { widthPx: w, heightPx: plotHeight },
            );
            if (points.length > 0) {
              ctx.strokeStyle = "#e0e7ff";
              ctx.lineWidth = 1;
              ctx.beginPath();
              points.forEach((point, index) => {
                const px = x0 + point.x;
                const py = plotTop + point.y;
                if (index === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
              });
              ctx.stroke();
              ctx.fillStyle = "#ffffff";
              for (const point of points) {
                ctx.fillRect(x0 + point.x - 1, plotTop - 1, 2, plotHeight + 2);
              }
            }
          }
        }
      }
    });

    // Playhead
    const playheadSourceMs = playheadMs;
    if (playheadSourceMs >= startMs && playheadSourceMs <= endMs) {
      const px = msToPx(playheadSourceMs, viewport);
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, laneTops.totalHeight);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }, [
    widthPx,
    viewport,
    laneTops,
    waveform,
    liveWords,
    segments,
    lanes,
    protectedRanges,
    protectedColor,
    selectedSegmentId,
    selectedWordId,
    playheadMs,
    durationMs,
    displayMode,
    timeMap,
    msPerPx,
    hoveredPassItemId,
    passItemsById,
    granularity,
    segmentTextById,
    searchMatchWordIds,
    thumbnails,
    getThumbImage,
    delayPreviewMs,
  ]);

  // ---------------------------------------------------------------------
  // Pointer interaction
  // ---------------------------------------------------------------------

  /** B20 §4: which lane item, if any, sits under `(px, py)`. */
  const hitTestPassItem = useCallback(
    (px: number, py: number): LaneItem | undefined => {
      for (const [laneIndex, lane] of lanes.entries()) {
        // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
        const top = laneTops.passTops[laneIndex];
        if (top === undefined || py < top || py > top + PASS_LANE_HEIGHT) continue;
        for (const item of lane.items) {
          const x0 = msToPx(item.startMs, viewport);
          const x1 = msToPx(item.endMs, viewport);
          if (px >= x0 && px <= x1) return item;
        }
      }
      return undefined;
    },
    [lanes, laneTops.passTops, viewport],
  );

  /** B20b: which editable lane item's edge, if any, sits under `(px, py)`. */
  const hitTestPassItemEdge = useCallback(
    (px: number, py: number): { item: LaneItem; edge: "start" | "end" } | undefined => {
      for (const [laneIndex, lane] of lanes.entries()) {
        // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
        const top = laneTops.passTops[laneIndex];
        if (top === undefined || py < top || py > top + PASS_LANE_HEIGHT) continue;
        for (const item of lane.items) {
          if (!isPassItemEditable(item)) continue;
          const x0 = msToPx(item.startMs, viewport);
          const x1 = msToPx(item.endMs, viewport);
          if (Math.abs(px - x0) <= EDGE_HIT_PX) return { item, edge: "start" };
          if (Math.abs(px - x1) <= EDGE_HIT_PX) return { item, edge: "end" };
        }
      }
      return undefined;
    },
    [lanes, laneTops.passTops, viewport],
  );

  /** Accepted items of `kind` other than `itemId` — what a drag must not cross. */
  const passItemNeighbours = useCallback(
    (kind: LaneItem["kind"], itemId: string): PassItemNeighbour[] => {
      const neighbours: PassItemNeighbour[] = [];
      for (const lane of lanes) {
        for (const other of lane.items) {
          if (other.itemId === itemId || other.kind !== kind || other.state !== "accepted") {
            continue;
          }
          neighbours.push({ startMs: other.startMs, endMs: other.endMs });
        }
      }
      return neighbours;
    },
    [lanes],
  );

  const onCanvasMouseMove = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (dragRef.current !== undefined) return; // a drag owns the pointer
      const rect = event.currentTarget.getBoundingClientRect();
      const hit = hitTestPassItem(event.clientX - rect.left, event.clientY - rect.top);
      setHoveredPassItemId(hit?.itemId);
      onHoverPassItem?.(hit);
    },
    [hitTestPassItem, onHoverPassItem],
  );

  const onCanvasMouseLeave = useCallback(() => {
    setHoveredPassItemId(undefined);
    onHoverPassItem?.(undefined);
  }, [onHoverPassItem]);

  const onCanvasClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const hit = hitTestPassItem(event.clientX - rect.left, event.clientY - rect.top);
      if (hit !== undefined) onSelectPassItem?.(hit);
    },
    [hitTestPassItem, onSelectPassItem],
  );

  const hitTestSegmentEdge = useCallback(
    (px: number, py: number): { segment: Segment; edge: "start" | "end" } | undefined => {
      if (py < laneTops.segmentTop || py > laneTops.segmentTop + SEGMENT_LANE_HEIGHT)
        return undefined;
      for (const segment of segments) {
        const x0 = msToPx(segment.startMs, viewport);
        const x1 = msToPx(segment.endMs, viewport);
        if (Math.abs(px - x0) <= EDGE_HIT_PX) return { segment, edge: "start" };
        if (Math.abs(px - x1) <= EDGE_HIT_PX) return { segment, edge: "end" };
      }
      return undefined;
    },
    [segments, viewport, laneTops.segmentTop],
  );

  /** The live word immediately before/after `word` in document order (A02d). */
  const wordNeighbours = useCallback(
    (word: Word): { prev?: Neighbour; next?: Neighbour } => {
      const index = liveWords.findIndex((w) => w.wid === word.wid);
      const prev = index > 0 ? liveWords[index - 1] : undefined;
      const next = index >= 0 && index < liveWords.length - 1 ? liveWords[index + 1] : undefined;
      return {
        ...(prev && { prev: { startMs: prev.s, endMs: prev.e } }),
        ...(next && { next: { startMs: next.s, endMs: next.e } }),
      };
    },
    [liveWords],
  );

  const hitTestWordEdge = useCallback(
    (px: number, py: number): { word: Word; edge: "start" | "end" } | undefined => {
      // K03: a LINE chip is a merged segment, not a word — its resize
      // handles are the segment lane's below, so word-edge dragging is a
      // WORD-granularity-only affordance.
      if (granularity !== "word") return undefined;
      if (py < laneTops.wordTop || py > laneTops.wordTop + WORD_LANE_HEIGHT) return undefined;
      for (const word of liveWords) {
        const x0 = msToPx(word.s, viewport);
        const x1 = msToPx(word.e, viewport);
        if (Math.abs(px - x0) <= EDGE_HIT_PX) return { word, edge: "start" };
        if (Math.abs(px - x1) <= EDGE_HIT_PX) return { word, edge: "end" };
      }
      return undefined;
    },
    [granularity, liveWords, viewport, laneTops.wordTop],
  );

  const hitTestSegmentBody = useCallback(
    (px: number, py: number): Segment | undefined => {
      if (py < laneTops.segmentTop || py > laneTops.segmentTop + SEGMENT_LANE_HEIGHT)
        return undefined;
      const ms = pxToMs(px, viewport);
      return segments.find((s) => ms >= s.startMs && ms <= s.endMs);
    },
    [segments, viewport, laneTops.segmentTop],
  );

  const hitTestWord = useCallback(
    (px: number, py: number): Word | undefined => {
      if (granularity !== "word") return undefined;
      if (py < laneTops.wordTop || py > laneTops.wordTop + WORD_LANE_HEIGHT) return undefined;
      const ms = pxToMs(px, viewport);
      return liveWords.find((w) => ms >= w.s && ms <= w.e);
    },
    [granularity, liveWords, viewport, laneTops.wordTop],
  );

  /** K03: LINE granularity's merged chip under `(px, py)` — the word lane's Y-range, hit-tested against segments. */
  const hitTestLineChip = useCallback(
    (px: number, py: number): Segment | undefined => {
      if (granularity !== "line") return undefined;
      if (py < laneTops.wordTop || py > laneTops.wordTop + WORD_LANE_HEIGHT) return undefined;
      const ms = pxToMs(px, viewport);
      return segments.find((s) => ms >= s.startMs && ms <= s.endMs);
    },
    [granularity, segments, viewport, laneTops.wordTop],
  );

  function neighboursOf(segment: Segment): { prev?: Neighbour; next?: Neighbour } {
    const index = segments.findIndex((s) => s.id === segment.id);
    const prev = index > 0 ? segments[index - 1] : undefined;
    const next = index >= 0 && index < segments.length - 1 ? segments[index + 1] : undefined;
    return { ...(prev && { prev }), ...(next && { next }) };
  }

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;

      if (py <= RULER_HEIGHT) {
        // Scrub via the ruler.
        dragRef.current = { pointerId: event.pointerId, kind: "playhead" };
        event.currentTarget.setPointerCapture(event.pointerId);
        onSeek(toSourceMs(pxToMs(px, viewport), displayMode, timeMap));
        return;
      }

      const edgeHit = hitTestSegmentEdge(px, py);
      if (edgeHit !== undefined) {
        dragRef.current = {
          pointerId: event.pointerId,
          kind: "segment-edge",
          segmentId: edgeHit.segment.id,
          edge: edgeHit.edge,
          startMs: edgeHit.segment.startMs,
          endMs: edgeHit.segment.endMs,
        };
        dragPreviewRef.current = { startMs: edgeHit.segment.startMs, endMs: edgeHit.segment.endMs };
        setSelectedEdge(edgeHit.edge);
        onSelectSegment?.(edgeHit.segment.id);
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }

      const passEdgeHit = onEditPassItem !== undefined ? hitTestPassItemEdge(px, py) : undefined;
      if (passEdgeHit !== undefined) {
        dragRef.current = {
          pointerId: event.pointerId,
          kind: "pass-item-edge",
          itemId: passEdgeHit.item.itemId,
          edge: passEdgeHit.edge,
          startMs: passEdgeHit.item.startMs,
          endMs: passEdgeHit.item.endMs,
        };
        dragPreviewRef.current = {
          startMs: passEdgeHit.item.startMs,
          endMs: passEdgeHit.item.endMs,
        };
        onSelectPassItem?.(passEdgeHit.item);
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }

      const wordEdgeHit = hitTestWordEdge(px, py);
      if (wordEdgeHit !== undefined && onSetWordTiming !== undefined) {
        dragRef.current = {
          pointerId: event.pointerId,
          kind: "word-edge",
          wordId: wordEdgeHit.word.wid,
          edge: wordEdgeHit.edge,
          startMs: wordEdgeHit.word.s,
          endMs: wordEdgeHit.word.e,
        };
        dragPreviewRef.current = { startMs: wordEdgeHit.word.s, endMs: wordEdgeHit.word.e };
        setSelectedWordEdge(wordEdgeHit.edge);
        const owner = segments.find((s) =>
          wordIdWithin(wordEdgeHit.word.wid, s.startWordId, s.endWordId),
        );
        if (owner !== undefined) onSelectWord?.(owner.id, wordEdgeHit.word.wid);
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }

      const word = hitTestWord(px, py);
      if (word !== undefined) {
        const owner = segments.find((s) => wordIdWithin(word.wid, s.startWordId, s.endWordId));
        if (owner !== undefined) onSelectWord?.(owner.id, word.wid);
        onSeek(word.s);
        return;
      }

      // K03: a LINE chip click selects and seeks to its segment — the same
      // outcome a segment-lane click below it already produces, so the two
      // lanes agree once a caption is showing as a merged line.
      const lineChip = hitTestLineChip(px, py);
      if (lineChip !== undefined) {
        onSelectSegment?.(lineChip.id);
        onSeek(lineChip.startMs);
        return;
      }

      const segment = hitTestSegmentBody(px, py);
      if (segment !== undefined) {
        onSelectSegment?.(segment.id);
        return;
      }

      onSelectSegment?.(undefined);
    },
    [
      hitTestSegmentEdge,
      hitTestPassItemEdge,
      hitTestWordEdge,
      hitTestWord,
      hitTestLineChip,
      hitTestSegmentBody,
      onSeek,
      onSelectSegment,
      onSelectWord,
      onSelectPassItem,
      onSetWordTiming,
      onEditPassItem,
      segments,
      viewport,
      displayMode,
      timeMap,
    ],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (drag === undefined || drag.pointerId !== event.pointerId) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const px = event.clientX - rect.left;

      if (drag.kind === "playhead") {
        onSeek(toSourceMs(pxToMs(px, viewport), displayMode, timeMap));
        return;
      }

      if (drag.kind === "segment-edge" && drag.segmentId !== undefined && drag.edge !== undefined) {
        const segment = segments.find((s) => s.id === drag.segmentId);
        if (segment === undefined) return;
        const candidateMs = pxToMs(px, viewport);
        const boundaries = wordBoundariesOf(segment);
        const resolved = resolveSegmentDrag(drag.edge, candidateMs, segment, {
          wordBoundaries: boundaries,
          neighbours: neighboursOf(segment),
        });
        dragPreviewRef.current = resolved;
        forceRedraw((n) => n + 1);
        return;
      }

      if (drag.kind === "word-edge" && drag.wordId !== undefined && drag.edge !== undefined) {
        const word = liveWords.find((w) => w.wid === drag.wordId);
        if (word === undefined) return;
        const candidateMs = pxToMs(px, viewport);
        const neighbours = wordNeighbours(word);
        const boundaries = [
          ...(neighbours.prev !== undefined ? [neighbours.prev.endMs] : []),
          ...(neighbours.next !== undefined ? [neighbours.next.startMs] : []),
        ];
        const resolved = resolveWordEdgeDrag(
          drag.edge,
          candidateMs,
          { startMs: word.s, endMs: word.e },
          { wordBoundaries: boundaries, neighbours },
        );
        dragPreviewRef.current = resolved;
        forceRedraw((n) => n + 1);
        return;
      }

      if (drag.kind === "pass-item-edge" && drag.itemId !== undefined && drag.edge !== undefined) {
        const item = lanes.flatMap((lane) => lane.items).find((i) => i.itemId === drag.itemId);
        if (item === undefined) return;
        const candidateMs = pxToMs(px, viewport);
        const resolved = resolvePassItemDrag(
          drag.edge,
          candidateMs,
          { startMs: item.startMs, endMs: item.endMs },
          { durationMs, neighbours: passItemNeighbours(item.kind, item.itemId) },
        );
        dragPreviewRef.current = resolved;
        forceRedraw((n) => n + 1);
      }
    },
    [
      segments,
      liveWords,
      viewport,
      wordBoundariesOf,
      wordNeighbours,
      onSeek,
      displayMode,
      timeMap,
      lanes,
      durationMs,
      passItemNeighbours,
    ],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (drag === undefined || drag.pointerId !== event.pointerId) return;
      event.currentTarget.releasePointerCapture(event.pointerId);

      if (drag.kind === "segment-edge" && drag.segmentId !== undefined && drag.edge !== undefined) {
        const segment = segments.find((s) => s.id === drag.segmentId);
        const resolved = dragPreviewRef.current;
        if (segment !== undefined && resolved !== undefined) {
          const fromMs = drag.edge === "start" ? segment.startMs : segment.endMs;
          const toMs = drag.edge === "start" ? resolved.startMs : resolved.endMs;
          if (fromMs !== toMs) {
            const boundaries = wordBoundariesOf(segment);
            const startWord = liveWords.find((w) => w.s === resolved.startMs);
            const endWord = liveWords.find((w) => w.e === resolved.endMs);
            onSetSegmentBounds({
              segmentId: segment.id,
              startMs: resolved.startMs,
              endMs: resolved.endMs,
              ...(boundaries.includes(resolved.startMs) && startWord !== undefined
                ? { startWordId: startWord.wid }
                : {}),
              ...(boundaries.includes(resolved.endMs) && endWord !== undefined
                ? { endWordId: endWord.wid }
                : {}),
            });
            resolvedNudgeSink.record(segmentEdgeNudge(drag.edge, segment.id, fromMs, toMs));
          }
        }
      }

      if (drag.kind === "word-edge" && drag.wordId !== undefined && drag.edge !== undefined) {
        const word = liveWords.find((w) => w.wid === drag.wordId);
        const resolved = dragPreviewRef.current;
        if (word !== undefined && resolved !== undefined && onSetWordTiming !== undefined) {
          const fromMs = drag.edge === "start" ? word.s : word.e;
          const toMs = drag.edge === "start" ? resolved.startMs : resolved.endMs;
          if (fromMs !== toMs) {
            onSetWordTiming({ wordId: word.wid, s: resolved.startMs, e: resolved.endMs });
            resolvedNudgeSink.record(wordEdgeNudge(drag.edge, word.wid, fromMs, toMs));
          }
        }
      }

      if (drag.kind === "pass-item-edge" && drag.itemId !== undefined && drag.edge !== undefined) {
        const item = lanes.flatMap((lane) => lane.items).find((i) => i.itemId === drag.itemId);
        const resolved = dragPreviewRef.current;
        if (item !== undefined && resolved !== undefined && onEditPassItem !== undefined) {
          const fromMs = drag.edge === "start" ? item.startMs : item.endMs;
          const toMs = drag.edge === "start" ? resolved.startMs : resolved.endMs;
          if (fromMs !== toMs) {
            onEditPassItem({
              itemId: item.itemId,
              startMs: resolved.startMs,
              endMs: resolved.endMs,
            });
          }
        }
      }

      dragRef.current = undefined;
      dragPreviewRef.current = undefined;
      forceRedraw((n) => n + 1);
    },
    [
      segments,
      wordBoundariesOf,
      liveWords,
      onSetSegmentBounds,
      onSetWordTiming,
      onEditPassItem,
      resolvedNudgeSink,
      lanes,
    ],
  );

  const onDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (onSplitSegment === undefined) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      if (py < laneTops.segmentTop || py > laneTops.segmentTop + SEGMENT_LANE_HEIGHT) return;
      const ms = pxToMs(px, viewport);
      const segment = segments.find((s) => ms >= s.startMs && ms <= s.endMs);
      if (segment === undefined) return;
      let nearest: Word | undefined;
      let nearestDist = Infinity;
      for (const word of liveWords) {
        if (word.s < segment.startMs || word.e > segment.endMs) continue;
        const dist = Math.abs(word.s - ms);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = word;
        }
      }
      if (nearest !== undefined && nearest.wid !== segment.startWordId) {
        onSplitSegment(segment.id, nearest.wid);
      }
    },
    [segments, liveWords, viewport, onSplitSegment, laneTops.segmentTop],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const anchorPx = event.clientX - rect.left;
        const next = zoomAround({ msPerPx, scrollMs }, anchorPx, event.deltaY < 0 ? "in" : "out");
        setMsPerPx(next.msPerPx);
        setScrollMs(clampScroll(next.scrollMs, { msPerPx: next.msPerPx, widthPx }, durationMs));
        return;
      }
      const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
      setScrollMs((current) =>
        clampScroll(current + delta * msPerPx, { msPerPx, widthPx }, durationMs),
      );
    },
    [msPerPx, scrollMs, widthPx, durationMs],
  );

  // ---------------------------------------------------------------------
  // Keyboard: arrow nudge (10ms / 100ms with Shift), zoom, split, merge, play.
  // Scoped to this component (`onKeyDown` on the container), never the
  // document-wide map `lib/edg/keyboard-shortcuts.ts` owns — the brief's
  // J/K/L/Space/S/M live there for the whole editor; this is only the
  // boundary-nudge arrow keys and the zoom shortcuts specific to a focused
  // timeline, so the two never fight over a keystroke.
  // ---------------------------------------------------------------------
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // Alt+Arrow nudges the selected word's edge (A02d), independent of the
      // plain-arrow segment nudge below — the two never fight over a keystroke
      // because a word is only selected once a word (not a segment) was clicked.
      if (
        event.altKey &&
        selectedWordId !== undefined &&
        onSetWordTiming !== undefined &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        const word = liveWords.find((w) => w.wid === selectedWordId);
        if (word === undefined) return;
        event.preventDefault();
        const step = event.shiftKey ? 100 : 10;
        const edge = selectedWordEdge ?? "end";
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        const current = edge === "start" ? word.s : word.e;
        const candidateMs = current + direction * step;
        const neighbours = wordNeighbours(word);
        const boundaries = [
          ...(neighbours.prev !== undefined ? [neighbours.prev.endMs] : []),
          ...(neighbours.next !== undefined ? [neighbours.next.startMs] : []),
        ];
        const resolved = resolveWordEdgeDrag(
          edge,
          candidateMs,
          { startMs: word.s, endMs: word.e },
          { wordBoundaries: boundaries, neighbours },
        );
        const toMs = edge === "start" ? resolved.startMs : resolved.endMs;
        if (toMs !== current) {
          onSetWordTiming({ wordId: word.wid, s: resolved.startMs, e: resolved.endMs });
          resolvedNudgeSink.record(wordEdgeNudge(edge, word.wid, current, toMs));
        }
        return;
      }
      if (event.altKey && event.key === "Tab" && !event.shiftKey && selectedWordId !== undefined) {
        event.preventDefault();
        setSelectedWordEdge((edge) => (edge === "start" ? "end" : "start"));
        return;
      }

      // "P" toggles protection (B18b) on the current selection: the selected
      // segment's range, or the selected word's range when no segment is
      // picked. Never fires while a modifier is held, so it never fights a
      // browser or OS shortcut on the same key.
      if (
        (event.key === "p" || event.key === "P") &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        onToggleProtection !== undefined
      ) {
        const selectedSegment = segments.find((s) => s.id === selectedSegmentId);
        const selectedWord = liveWords.find((w) => w.wid === selectedWordId);
        const range =
          selectedSegment !== undefined
            ? { s: selectedSegment.startMs, e: selectedSegment.endMs }
            : selectedWord !== undefined
              ? { s: selectedWord.s, e: selectedWord.e }
              : undefined;
        if (range !== undefined) {
          event.preventDefault();
          onToggleProtection(range.s, range.e);
        }
        return;
      }

      if (selectedSegmentId === undefined) return;
      const segment = segments.find((s) => s.id === selectedSegmentId);
      if (segment === undefined) return;
      const step = event.shiftKey ? 100 : 10;
      const edge = selectedEdge ?? "end";

      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        const current = edge === "start" ? segment.startMs : segment.endMs;
        const candidateMs = current + direction * step;
        const resolved = resolveSegmentDrag(edge, candidateMs, segment, {
          wordBoundaries: wordBoundariesOf(segment),
          neighbours: neighboursOf(segment),
        });
        const toMs = edge === "start" ? resolved.startMs : resolved.endMs;
        if (toMs !== current) {
          onSetSegmentBounds({
            segmentId: segment.id,
            startMs: resolved.startMs,
            endMs: resolved.endMs,
          });
          resolvedNudgeSink.record(segmentEdgeNudge(edge, segment.id, current, toMs));
        }
        return;
      }
      if (event.key === "Tab" && !event.shiftKey && event.altKey) {
        event.preventDefault();
        setSelectedEdge(edge === "start" ? "end" : "start");
      }
    },
    [
      selectedSegmentId,
      selectedWordId,
      selectedWordEdge,
      segments,
      liveWords,
      selectedEdge,
      wordBoundariesOf,
      wordNeighbours,
      onSetSegmentBounds,
      onSetWordTiming,
      onToggleProtection,
      resolvedNudgeSink,
    ],
  );

  // K03: the Caption Tools panel is a hand-rolled floating menu (matching
  // `BulkActionsBar.tsx`'s and `FindReplaceDialog.tsx`'s own conditional-div
  // dialogs, not `@montaj/ui`'s `DropdownMenu` — that primitive traps focus
  // and manages its own outside-click logic, which would fight the resegment
  // dialog's `<input type="number">` fields it wraps), so it owns its own
  // outside-click/Escape dismissal the same way those two do.
  useEffect(() => {
    if (!captionToolsOpen) return;
    function onDocumentPointerDown(event: PointerEvent): void {
      if (captionToolsRef.current === null) return;
      if (!captionToolsRef.current.contains(event.target as Node)) setCaptionToolsOpen(false);
    }
    function onDocumentKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setCaptionToolsOpen(false);
    }
    document.addEventListener("pointerdown", onDocumentPointerDown);
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onDocumentPointerDown);
      document.removeEventListener("keydown", onDocumentKeyDown);
    };
  }, [captionToolsOpen]);

  // K06: whenever the panel closes — Escape, a click outside, or an action
  // that closes it itself — any un-applied Caption Delay preview is dropped
  // too, so a shift the user only dragged (never hit Apply on) never lingers
  // as a visual artifact on a timeline the panel is no longer open over.
  useEffect(() => {
    if (!captionToolsOpen) setDelayPreviewMs(0);
  }, [captionToolsOpen]);

  const captionToolsAvailable =
    onMergeShortCaptions !== undefined &&
    onSplitLongCaptions !== undefined &&
    onResegmentCaptions !== undefined;

  // ---------------------------------------------------------------------
  // K06: Caption Tools' Display Settings / Actions / Timing (the real
  // Kalakar-parity structure — `ADDENDUM-full-frame-audit.md` "New gap 4").
  // ---------------------------------------------------------------------

  /**
   * Display Settings' Max Chars/Lines: both feed the *existing* `Resegment`
   * op via the *existing* `onResegmentCaptions` callback (already required by
   * `captionToolsAvailable` above) — this is exactly the "Max Chars strongly
   * resembles an existing Resegment param" investigation the brief asks for
   * (`A15-web-editor-transcript.md`'s `fitBudget`/`maxChars`), not a new op.
   * `minMs`/`maxMs`/`dropFillers` carry over from `resegmentDefaultParams`
   * unchanged. A no-op commit (values unchanged since the last one) is
   * skipped so tabbing through the fields without editing them never
   * triggers a silent resegment (A15's decision D78).
   */
  function commitDisplaySettings(
    patch: Partial<{ maxChars: number; maxLines: number }> = {},
  ): void {
    if (onResegmentCaptions === undefined) return;
    const maxChars = patch.maxChars ?? maxCharsDraft;
    const maxLines = patch.maxLines ?? maxLinesDraft;
    const last = lastAppliedDisplaySettingsRef.current;
    if (maxChars === last.maxChars && maxLines === last.maxLines) return;
    lastAppliedDisplaySettingsRef.current = { maxChars, maxLines };
    onResegmentCaptions({ ...resegmentDefaultParams, maxChars, maxLines });
  }

  /** Actions: one-shot batch text-cleanup/timing passes (brief §3 — see the report for why these are buttons, not persisted toggles). */
  function runRemovePunctuation(): void {
    if (onCaptionToolsAction === undefined) return;
    const ops = buildRemovePunctuationOps(liveWords, wordScript, newId);
    if (ops.length > 0) onCaptionToolsAction(ops, "Remove punctuation");
  }
  function runRemoveEmojis(): void {
    if (onCaptionToolsAction === undefined) return;
    const ops = buildRemoveEmojiOps(liveWords, wordScript, newId);
    if (ops.length > 0) onCaptionToolsAction(ops, "Remove emojis");
  }
  function runRemoveEmphasis(): void {
    if (onCaptionToolsAction === undefined) return;
    const ops = buildRemoveEmphasisOps(segments, newId);
    if (ops.length > 0) onCaptionToolsAction(ops, "Remove emphasis");
  }
  function runRemoveGaps(): void {
    if (onCaptionToolsAction === undefined) return;
    const ops = buildRemoveGapsOps(segments, newId);
    if (ops.length > 0) onCaptionToolsAction(ops, "Remove gaps in captions");
  }

  /** Timing: the slider only ever updates local preview state — see the draw loop above for the live shift. */
  function onDelaySliderChange(rawMs: number): void {
    setDelayPreviewMs(clampCaptionDelayMs(segments, rawMs, durationMs));
  }
  function applyCaptionDelay(): void {
    if (onCaptionToolsAction === undefined || delayPreviewMs === 0) return;
    const ops = buildCaptionDelayOps(segments, delayPreviewMs, newId);
    if (ops.length > 0) onCaptionToolsAction(ops, "Shift caption timing");
    setDelayPreviewMs(0);
  }
  function resetCaptionDelay(): void {
    setDelayPreviewMs(0);
  }

  const ariaDescription = useMemo(() => {
    const parts: string[] = [];
    if (selectedSegmentId !== undefined) {
      const segment = segments.find((s) => s.id === selectedSegmentId);
      if (segment !== undefined) {
        parts.push(
          `Segment selected, ${formatMs(segment.startMs)} to ${formatMs(segment.endMs)}${
            selectedEdge !== undefined ? `, ${selectedEdge} edge active` : ""
          }.`,
        );
      }
    }
    if (selectedWordId !== undefined) {
      const word = liveWords.find((w) => w.wid === selectedWordId);
      if (word !== undefined) {
        parts.push(
          `Word selected: "${word.t}"${
            selectedWordEdge !== undefined ? `, ${selectedWordEdge} edge active` : ""
          }.`,
        );
      }
    }
    if (parts.length === 0) parts.push("No selection.");
    return parts.join(" ");
  }, [selectedSegmentId, selectedWordId, segments, liveWords, selectedEdge, selectedWordEdge]);

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full select-none", className)}
      data-testid="timeline-root"
      role="application"
      aria-label="Caption timeline"
      aria-roledescription="editor timeline"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2 px-1 pb-1 text-xs text-white/60">
        <button
          type="button"
          data-testid="timeline-play-pause"
          className="rounded bg-white/10 px-2 py-0.5"
          onClick={onTogglePlay}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          data-testid="timeline-zoom-in"
          className="rounded bg-white/10 px-2 py-0.5"
          onClick={() => {
            const next = zoomAround({ msPerPx, scrollMs }, widthPx / 2, "in");
            setMsPerPx(next.msPerPx);
            setScrollMs(clampScroll(next.scrollMs, { msPerPx: next.msPerPx, widthPx }, durationMs));
          }}
        >
          Zoom in
        </button>
        <button
          type="button"
          data-testid="timeline-zoom-out"
          className="rounded bg-white/10 px-2 py-0.5"
          onClick={() => {
            const next = zoomAround({ msPerPx, scrollMs }, widthPx / 2, "out");
            setMsPerPx(next.msPerPx);
            setScrollMs(clampScroll(next.scrollMs, { msPerPx: next.msPerPx, widthPx }, durationMs));
          }}
        >
          Zoom out
        </button>
        <div
          className="ml-2 flex items-center gap-0.5 rounded bg-white/10 p-0.5"
          role="group"
          aria-label="Caption granularity"
        >
          <button
            type="button"
            data-testid="timeline-granularity-word"
            aria-pressed={granularity === "word"}
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase",
              granularity === "word"
                ? "bg-white/25 text-white"
                : "text-white/50 hover:text-white/80",
            )}
            onClick={() => setGranularity("word")}
          >
            Word
          </button>
          <button
            type="button"
            data-testid="timeline-granularity-line"
            aria-pressed={granularity === "line"}
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase",
              granularity === "line"
                ? "bg-white/25 text-white"
                : "text-white/50 hover:text-white/80",
            )}
            onClick={() => setGranularity("line")}
          >
            Line
          </button>
        </div>
        <div className="flex items-center gap-1">
          <input
            type="text"
            data-testid="timeline-search"
            placeholder="Search captions"
            aria-label="Search captions"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="w-32 rounded bg-white/10 px-2 py-0.5 text-white placeholder:text-white/40 focus:ring-1 focus:ring-white/40 focus:outline-none"
          />
          {searchQuery !== "" ? (
            <>
              <span data-testid="timeline-search-count" className="tabular-nums text-white/50">
                {searchMatches.length} match{searchMatches.length === 1 ? "" : "es"}
              </span>
              <button
                type="button"
                data-testid="timeline-search-clear"
                aria-label="Clear search"
                className="rounded px-1 text-white/50 hover:text-white/80"
                onClick={() => setSearchQuery("")}
              >
                ×
              </button>
            </>
          ) : null}
        </div>
        {captionToolsAvailable ? (
          <div className="relative" ref={captionToolsRef}>
            <button
              type="button"
              data-testid="timeline-caption-tools-trigger"
              aria-haspopup="true"
              aria-expanded={captionToolsOpen}
              className="rounded bg-white/10 px-2 py-0.5"
              onClick={() => setCaptionToolsOpen((open) => !open)}
            >
              Caption Tools ▾
            </button>
            {captionToolsOpen ? (
              <div
                role="menu"
                aria-label="Caption Tools"
                data-testid="timeline-caption-tools-menu"
                className="border-white/10 bg-bg-1 absolute top-full left-0 z-40 mt-1 flex w-72 max-h-[75vh] flex-col gap-3 overflow-y-auto rounded-lg border p-3 text-left shadow-xl"
              >
                {/*
                 * K06 (`ADDENDUM-full-frame-audit.md` "New gap 4"): the real
                 * Kalakar Caption Tools dropdown is Display Settings / Actions
                 * / Timing — not merge/split/resegment, which K03 was briefed
                 * from an incomplete sample. Kalakar has no equivalent of our
                 * auto-resegmentation concept at all, so it is kept below
                 * under its own "Structure" heading (option (a) from the
                 * brief) rather than dropped: it is a real, working feature
                 * of this app's own captioning model, and keeping it here —
                 * unchanged, still `BulkActionsBar` itself, not a
                 * reimplementation — costs nothing and regresses nothing, the
                 * transcript column's own entry point included.
                 */}
                <div data-testid="caption-tools-display-settings" className="flex flex-col gap-1.5">
                  <div className="text-[10px] font-semibold tracking-wide text-white/40 uppercase">
                    Display Settings
                  </div>
                  <label className="flex items-center justify-between gap-2 text-xs text-white/80">
                    Words
                    <select
                      data-testid="caption-tools-words"
                      disabled
                      title="No other grouping exists yet in this app's data model — Default is the only real option."
                      className="w-28 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-right disabled:opacity-50"
                      defaultValue="default"
                    >
                      <option value="default">Default</option>
                    </select>
                  </label>
                  <label className="flex items-center justify-between gap-2 text-xs text-white/80">
                    Max Chars
                    <input
                      type="number"
                      min={8}
                      max={60}
                      data-testid="caption-tools-max-chars"
                      value={maxCharsDraft}
                      disabled={onResegmentCaptions === undefined}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isFinite(value)) setMaxCharsDraft(value);
                      }}
                      onBlur={() => commitDisplaySettings()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitDisplaySettings();
                      }}
                      className="w-20 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-right disabled:opacity-50"
                    />
                  </label>
                  <label className="flex items-center justify-between gap-2 text-xs text-white/80">
                    Lines
                    <select
                      data-testid="caption-tools-lines"
                      value={maxLinesDraft}
                      disabled={onResegmentCaptions === undefined}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        setMaxLinesDraft(value);
                        commitDisplaySettings({ maxLines: value });
                      }}
                      className="w-28 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-right disabled:opacity-50"
                    >
                      <option value={1}>1 Line</option>
                      <option value={2}>2 Lines</option>
                      <option value={3}>3 Lines</option>
                    </select>
                  </label>
                  <p className="text-[10px] text-white/40">
                    Re-cuts every caption from the transcript — manual splits, merges and hidden
                    captions are replaced.
                  </p>
                </div>

                <div data-testid="caption-tools-actions" className="flex flex-col gap-1.5">
                  <div className="text-[10px] font-semibold tracking-wide text-white/40 uppercase">
                    Actions
                  </div>
                  <button
                    type="button"
                    data-testid="caption-tools-remove-punctuation"
                    disabled={onCaptionToolsAction === undefined}
                    className="text-fg-2 rounded-md bg-white/5 px-2 py-1 text-left text-xs hover:bg-white/10 disabled:opacity-40"
                    onClick={runRemovePunctuation}
                  >
                    Remove Punctuation
                  </button>
                  <button
                    type="button"
                    data-testid="caption-tools-remove-emphasis"
                    disabled={onCaptionToolsAction === undefined}
                    className="text-fg-2 rounded-md bg-white/5 px-2 py-1 text-left text-xs hover:bg-white/10 disabled:opacity-40"
                    onClick={runRemoveEmphasis}
                  >
                    Remove Emphasis
                  </button>
                  <button
                    type="button"
                    data-testid="caption-tools-remove-gaps"
                    disabled={onCaptionToolsAction === undefined}
                    className="text-fg-2 rounded-md bg-white/5 px-2 py-1 text-left text-xs hover:bg-white/10 disabled:opacity-40"
                    onClick={runRemoveGaps}
                  >
                    Remove Gaps in Captions
                  </button>
                  <button
                    type="button"
                    data-testid="caption-tools-remove-emojis"
                    disabled={onCaptionToolsAction === undefined}
                    className="text-fg-2 rounded-md bg-white/5 px-2 py-1 text-left text-xs hover:bg-white/10 disabled:opacity-40"
                    onClick={runRemoveEmojis}
                  >
                    Remove Emojis
                  </button>
                </div>

                <div data-testid="caption-tools-timing" className="flex flex-col gap-1.5">
                  <div className="text-[10px] font-semibold tracking-wide text-white/40 uppercase">
                    Timing
                  </div>
                  <label className="flex flex-col gap-1 text-xs text-white/80">
                    <span className="flex items-center justify-between">
                      Caption Delay
                      <span
                        data-testid="caption-tools-delay-value"
                        className="tabular-nums text-white/50"
                      >
                        {delayPreviewMs > 0 ? "+" : ""}
                        {(delayPreviewMs / 1000).toFixed(2)}s
                      </span>
                    </span>
                    <input
                      type="range"
                      data-testid="caption-tools-delay-slider"
                      min={-CAPTION_DELAY_RANGE_MS}
                      max={CAPTION_DELAY_RANGE_MS}
                      step={CAPTION_DELAY_STEP_MS}
                      value={delayPreviewMs}
                      onChange={(event) => onDelaySliderChange(Number(event.target.value))}
                    />
                  </label>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      data-testid="caption-tools-delay-reset"
                      disabled={delayPreviewMs === 0}
                      className="text-fg-3 px-2 py-1 text-xs hover:underline disabled:opacity-40"
                      onClick={resetCaptionDelay}
                    >
                      Reset
                    </button>
                    <button
                      type="button"
                      data-testid="caption-tools-delay-apply"
                      disabled={delayPreviewMs === 0 || onCaptionToolsAction === undefined}
                      className="rounded-md bg-lime-400 px-2 py-1 text-xs font-medium text-black disabled:opacity-40"
                      onClick={applyCaptionDelay}
                    >
                      Apply
                    </button>
                  </div>
                </div>

                <div className="h-px bg-white/10" />

                {/*
                 * K03 brief §3: "call the same underlying handlers/store actions
                 * `BulkActionsBar.tsx` uses, do not duplicate the logic" — this
                 * renders that exact component (not a reimplementation) as a
                 * second entry point, so its three actions are guaranteed to
                 * produce identical results to the transcript column's own copy.
                 */}
                <div data-testid="caption-tools-structure" className="flex flex-col gap-1.5">
                  <div className="text-[10px] font-semibold tracking-wide text-white/40 uppercase">
                    Structure
                  </div>
                  <BulkActionsBar
                    onMergeShort={() => {
                      onMergeShortCaptions?.();
                      setCaptionToolsOpen(false);
                    }}
                    onSplitLong={() => {
                      onSplitLongCaptions?.();
                      setCaptionToolsOpen(false);
                    }}
                    onResegment={(params) => {
                      onResegmentCaptions?.(params);
                      setCaptionToolsOpen(false);
                    }}
                    defaultParams={resegmentDefaultParams}
                    busy={bulkActionsBusy}
                    className="flex-wrap"
                  />
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {outputModeAvailable(timeMap) ? (
          <label className="ml-2 flex items-center gap-1">
            <input
              type="checkbox"
              data-testid="timeline-output-mode-toggle"
              checked={displayMode === "output"}
              onChange={(event) =>
                onDisplayModeChange?.(event.target.checked ? "output" : "source")
              }
            />
            Output time
          </label>
        ) : null}
        {onToggleProtection !== undefined &&
        (selectedSegmentId !== undefined || selectedWordId !== undefined) ? (
          <button
            type="button"
            data-testid="timeline-toggle-protection"
            className="rounded bg-white/10 px-2 py-0.5"
            onClick={() => {
              const selectedSegment = segments.find((s) => s.id === selectedSegmentId);
              const selectedWord = liveWords.find((w) => w.wid === selectedWordId);
              const range =
                selectedSegment !== undefined
                  ? { s: selectedSegment.startMs, e: selectedSegment.endMs }
                  : selectedWord !== undefined
                    ? { s: selectedWord.s, e: selectedWord.e }
                    : undefined;
              if (range !== undefined) onToggleProtection(range.s, range.e);
            }}
          >
            Protect (P)
          </button>
        ) : null}
        {selectedSegmentId !== undefined && onMergeSegments !== undefined ? (
          <button
            type="button"
            data-testid="timeline-merge"
            className="ml-auto rounded bg-white/10 px-2 py-0.5"
            onClick={() => {
              const index = segments.findIndex((s) => s.id === selectedSegmentId);
              const next = segments[index + 1];
              if (next !== undefined) onMergeSegments([selectedSegmentId, next.id]);
            }}
          >
            Merge with next
          </button>
        ) : null}
        <span data-testid="timeline-display-clock" className="ml-auto tabular-nums">
          {formatMs(displayPlayheadMs)} / {formatMs(displayDuration)}
        </span>
      </div>
      <canvas
        ref={canvasRef}
        data-testid="timeline-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onMouseMove={onCanvasMouseMove}
        onMouseLeave={onCanvasMouseLeave}
        onClick={onCanvasClick}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
      />
      <p className="sr-only" data-testid="timeline-aria-description" aria-live="polite">
        {ariaDescription}
      </p>
    </div>
  );
}

function formatMs(ms: number): string {
  const totalMs = Math.max(0, Math.round(ms));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  const pad = (n: number, len = 2): string => String(n).padStart(len, "0");
  return hours > 0
    ? `${String(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`
    : `${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}
