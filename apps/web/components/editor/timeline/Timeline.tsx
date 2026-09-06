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

import { parseWordId } from "@montaj/edg";
import type { PassItem, Segment, Word } from "@montaj/edg";
import type { TimeMap } from "@montaj/timemap";

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
import {
  reduceWaveform,
  waveformDrawWindow,
  type WaveformLike,
} from "@/lib/timeline/waveform-view";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Layout constants (CSS px)
// ---------------------------------------------------------------------------

const RULER_HEIGHT = 24;
const WAVEFORM_HEIGHT = 64;
const WORD_LANE_HEIGHT = 28;
const SEGMENT_LANE_HEIGHT = 36;
const PASS_LANE_HEIGHT = 20;
const LANE_GAP = 2;
const EDGE_HIT_PX = 6;
const MIN_PX_PER_WORD_LABEL = 28;

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
   * FIX-03: which per-word text the transcript reference column reads —
   * `SegmentCard`'s own `displayText` rule (A22's `ScriptTabs`), so switching
   * the editor's script tab is reflected here without a second lookup table.
   * Defaults to `"roman"`, `TranscriptList`'s own initial script.
   */
  readonly script?: string;
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

/** A word id's document position as one sortable number — chunk order, then in-chunk order. */
function wordOrderKey(wid: string): number {
  const { chunkIdx, n } = parseWordId(wid);
  return chunkIdx * 1_000_000 + n;
}

/** `true` when `wid` falls in `[startWordId, endWordId]` by chunk/sequence order, not string order. */
function wordIdWithin(wid: string, startWordId: string, endWordId: string): boolean {
  const k = wordOrderKey(wid);
  return k >= wordOrderKey(startWordId) && k <= wordOrderKey(endWordId);
}

/**
 * The text a transcript-column row shows for one word — `SegmentCard`'s own
 * `displayText` rule, spelled out per script so this needs no bracket access
 * on a variable key (`word.scripts` is keyed by the same three scripts).
 */
function wordDisplayText(word: Word, script: string): string {
  if (script === "roman") return word.scripts?.roman ?? word.t;
  if (script === "native") return word.scripts?.native ?? word.t;
  if (script === "en") return word.scripts?.en ?? word.t;
  return word.t;
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
    script = "roman",
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
  // FIX-03: the transcript reference column docks beside the canvas, inside
  // `containerRef`'s own flex row — measuring `containerRef` for `widthPx`
  // would hand the canvas the whole row's width, including the space the
  // docked column actually occupies. This ref is the canvas's own column, so
  // `widthPx` (and every `msToPx`/`pxToMs` derived from it) only ever
  // describes pixels the canvas truly owns.
  const canvasColumnRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const dragPreviewRef = useRef<{ startMs: number; endMs: number } | undefined>(undefined);
  const transcriptRowRefs = useRef(new Map<string, HTMLLIElement>());

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

  useLayoutEffect(() => {
    const element = canvasColumnRef.current;
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

  // FIX-03: each segment's plain transcript text, for the reference column.
  // `segments` and `liveWords` are both already in document order (every
  // other consumer in this file — `wordNeighbours`, `onDoubleClick`'s
  // "nearest word" scan — relies on the same assumption), so one linear
  // merge finds every segment's words in O(segments + words) rather than
  // filtering the full word list per segment: with a multi-hour transcript
  // (`TranscriptList.tsx`'s own ~9,000-segment/54,000-word stress case) an
  // O(segments * words) scan here would be a real, user-visible freeze.
  const segmentTexts = useMemo(() => {
    const texts = new Map<string, string>();
    let wordIndex = 0;
    for (const segment of segments) {
      const startKey = wordOrderKey(segment.startWordId);
      const endKey = wordOrderKey(segment.endWordId);
      const segmentWords: string[] = [];
      while (wordIndex < liveWords.length) {
        // eslint-disable-next-line security/detect-object-injection -- wordIndex is a numeric loop counter bounded by liveWords.length above, not attacker-controlled
        const word = liveWords[wordIndex];
        if (word === undefined) break;
        const key = wordOrderKey(word.wid);
        if (key > endKey) break;
        wordIndex += 1;
        // A word between two segments' ranges (not owned by either) is
        // skipped rather than attributed to whichever segment's turn it is.
        if (key < startKey) continue;
        segmentWords.push(wordDisplayText(word, script));
      }
      texts.set(segment.id, segmentWords.join(" "));
    }
    return texts;
  }, [segments, liveWords, script]);

  // Which segment the playhead is over right now — cheap off props this
  // component already has, so the reference column can follow playback
  // without any new cross-component plumbing (a "selected" segment is a
  // separate, user-driven thing and not what this highlights).
  const activeSegmentId = useMemo(
    () => segments.find((s) => playheadMs >= s.startMs && playheadMs <= s.endMs)?.id,
    [segments, playheadMs],
  );

  useEffect(() => {
    if (activeSegmentId === undefined) return;
    const row = transcriptRowRefs.current.get(activeSegmentId);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeSegmentId]);

  const lanes: readonly LaneRow[] = useMemo(() => buildLanes(passItems), [passItems]);
  /** B20b: full pass items by id — `LaneItem` strips `payload`, but the zoom
   * lane's mini-plot needs the item's own keyframe curve to decode. */
  const passItemsById = useMemo(
    () => new Map(passItems.map((item) => [item.itemId, item])),
    [passItems],
  );

  const laneTops = useMemo(() => {
    let y = RULER_HEIGHT;
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
    return { waveformTop, wordTop, segmentTop, passTops, totalHeight: y };
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

    // Waveform: bounded to the media's own `durationMs`, in canvas pixels —
    // see `waveformDrawWindow`'s own doc for why a plain `Math.min(durationMs,
    // endMs)` clamp on the *time* range alone (FIX-04) still let the drawn
    // waveform run past the media's end.
    const waveformWindow =
      waveform === undefined
        ? undefined
        : waveformDrawWindow(viewport, durationMs, { startMs, endMs });
    if (waveform !== undefined && waveformWindow !== undefined) {
      const buckets = reduceWaveform(
        waveform,
        waveformWindow.startMs,
        waveformWindow.endMs,
        waveformWindow.widthPx,
      );
      const midY = laneTops.waveformTop + WAVEFORM_HEIGHT / 2;
      ctx.fillStyle = "rgba(124,143,240,0.25)";
      ctx.strokeStyle = "#7c8ff0";
      for (let i = 0; i < buckets.length; i++) {
        // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
        const bucket = buckets[i];
        if (bucket === undefined) continue;
        const px = waveformWindow.pxStart + i;
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

    // Word lane
    for (const word of liveWords) {
      const preview =
        dragRef.current?.kind === "word-edge" && dragRef.current.wordId === word.wid
          ? dragPreviewRef.current
          : undefined;
      const wordStartMs = preview?.startMs ?? word.s;
      const wordEndMs = preview?.endMs ?? word.e;
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
      if (w >= MIN_PX_PER_WORD_LABEL) {
        ctx.fillStyle = selected ? "#0b0b12" : "rgba(255,255,255,0.9)";
        ctx.font = "11px sans-serif";
        ctx.fillText(word.t, x0 + 2, laneTops.wordTop + WORD_LANE_HEIGHT - 9, w - 4);
      }
    }

    // Segment lane
    for (const segment of segments) {
      const preview =
        dragRef.current?.kind === "segment-edge" && dragRef.current.segmentId === segment.id
          ? dragPreviewRef.current
          : undefined;
      const startMsS = preview?.startMs ?? segment.startMs;
      const endMsS = preview?.endMs ?? segment.endMs;
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
      if (py < laneTops.wordTop || py > laneTops.wordTop + WORD_LANE_HEIGHT) return undefined;
      for (const word of liveWords) {
        const x0 = msToPx(word.s, viewport);
        const x1 = msToPx(word.e, viewport);
        if (Math.abs(px - x0) <= EDGE_HIT_PX) return { word, edge: "start" };
        if (Math.abs(px - x1) <= EDGE_HIT_PX) return { word, edge: "end" };
      }
      return undefined;
    },
    [liveWords, viewport, laneTops.wordTop],
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
      if (py < laneTops.wordTop || py > laneTops.wordTop + WORD_LANE_HEIGHT) return undefined;
      const ms = pxToMs(px, viewport);
      return liveWords.find((w) => ms >= w.s && ms <= w.e);
    },
    [liveWords, viewport, laneTops.wordTop],
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
      className={cn("flex w-full select-none items-start gap-2", className)}
      data-testid="timeline-root"
      role="application"
      aria-label="Caption timeline"
      aria-roledescription="editor timeline"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div ref={canvasColumnRef} className="relative min-w-0 flex-1">
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
              setScrollMs(
                clampScroll(next.scrollMs, { msPerPx: next.msPerPx, widthPx }, durationMs),
              );
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
              setScrollMs(
                clampScroll(next.scrollMs, { msPerPx: next.msPerPx, widthPx }, durationMs),
              );
            }}
          >
            Zoom out
          </button>
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

      {/*
       * FIX-03: a plain, always-visible transcript reference column — not a
       * second `TranscriptList` (that stays the one place word/segment text
       * is edited). Height matches the canvas exactly (`laneTops.totalHeight`)
       * so it scrolls on its own rather than stretching the whole timeline
       * row; `editor-timeline-row`'s own scroll (M18, `editor-client.tsx`)
       * still governs the page when the canvas itself is tall.
       */}
      <div
        data-testid="timeline-transcript-panel"
        className="w-64 shrink-0 overflow-y-auto border-l border-white/10 pl-2 text-xs leading-snug text-white/70"
        style={{ height: laneTops.totalHeight }}
      >
        {segments.length === 0 ? (
          <p className="p-2 text-white/40">No transcript yet.</p>
        ) : (
          <ul className="flex flex-col gap-0.5 py-1">
            {segments.map((segment) => (
              <li
                key={segment.id}
                ref={(element) => {
                  if (element === null) transcriptRowRefs.current.delete(segment.id);
                  else transcriptRowRefs.current.set(segment.id, element);
                }}
                data-testid={`timeline-transcript-row-${segment.id}`}
                className={cn(
                  "cursor-pointer rounded px-1.5 py-1",
                  segment.id === activeSegmentId ? "bg-white/10 text-white" : "hover:bg-white/5",
                  segment.hidden === true && "text-white/30 line-through",
                )}
                onClick={() => {
                  onSelectSegment?.(segment.id);
                  onSeek(segment.startMs);
                }}
              >
                {segmentTexts.get(segment.id)}
              </li>
            ))}
          </ul>
        )}
      </div>
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
