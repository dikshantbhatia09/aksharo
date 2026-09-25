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
import {
  AudioWaveform,
  Link2,
  Magnet,
  Maximize2,
  Plus,
  Scissors,
  SlidersHorizontal,
  GitMerge,
  Italic,
  Pause,
  Play,
  Search,
  Shield,
  Video,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
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
import { coverCrop, filmstripTiles } from "@/lib/timeline/filmstrip";
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
/**
 * Canvas colours (Shirorekha, docs/redesign/DESIGN.md).
 *
 * A 2D canvas takes a resolved colour, not a CSS variable and not a Tailwind
 * class, so this is the one place in the editor where palette values are
 * written out by hand. Every entry names the token in
 * `packages/ui/src/styles/tokens.css` it copies; changing a token means
 * changing it here too.
 *
 * Accent discipline applies on the canvas as well: the rani accent marks only
 * the word under the playhead and the selection's edges. Word chips and the
 * waveform are warm neutrals, so the footage and the words stay the subject.
 * Label text on every chip clears 4.5:1: ink on the accent is 5.5:1, fg-0 on
 * neutral-700 is 6.4:1, fg-1 on neutral-800 is 7.5:1, ink on fg-0 is 16:1.
 */
const CANVAS = {
  accent: "#f0508a", // --color-accent
  accentTintStrong: "rgba(240,80,138,0.45)", // accent, selected segment band
  accentTint: "rgba(240,80,138,0.22)", // accent, unselected segment band
  accentEdge: "rgba(240,80,138,0.6)",
  proposed: "#e8b04a", // --color-proposed (low confidence, search match)
  ink: "#0b0a0c", // --color-ink
  fg0: "#f1ece6", // --color-fg-0
  fg1: "#d6cfc8", // --color-fg-1
  fg2: "#a39a93", // --color-fg-2
  neutral200: "#ebe5df", // --color-neutral-200
  chip: "#5a534f", // --color-neutral-700
  chipFiller: "#3d3739", // --color-neutral-800
  waveBed: "#262227", // --color-neutral-900
  wavePeak: "#7c746e", // --color-neutral-600
  waveEnergy: "#bcb3ac", // --color-neutral-400
  ruler: "#201d23", // --color-editor-ruler
  sunken: "#0e0c10", // --color-sunken
  tick: "rgba(241,236,230,0.14)", // --color-divider
  wash: "rgba(241,236,230,0.06)",
  hatch: "rgba(241,236,230,0.3)",
  seam: "rgba(11,10,12,0.4)",
  info: "#7fa6f5", // --color-info
} as const;
/**
 * The filmstrip's own chrome, from the same tokens: `--color-surface` under a
 * frame still loading, `--color-ink` for the line between frames (the video
 * canvas colour, the one near-black), and a faint `--color-fg-0` edge.
 */
const FILMSTRIP_EMPTY = "#1f1c23";
const FILMSTRIP_FRAME_LINE = "rgba(11, 10, 12, 0.85)";
const FILMSTRIP_EDGE = "rgba(241, 236, 230, 0.08)";
/** Frame shape to lay tiles out at before any thumbnail has decoded. */
const FILMSTRIP_FALLBACK_ASPECT = 16 / 9;
const FILMSTRIP_RADIUS = 6;
/** Air above and below the strip inside its lane, CSS px. */
const FILMSTRIP_INSET_Y = 4;
import {
  reduceWaveform,
  waveformDrawWindow,
  type WaveformLike,
} from "@/lib/timeline/waveform-view";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Layout constants (CSS px)
// ---------------------------------------------------------------------------

const RULER_HEIGHT = 30;
/** K03: the video filmstrip lane, drawn above the waveform (Kalakar's "Video 1" track). */
const THUMB_LANE_HEIGHT = 45;
const WAVEFORM_HEIGHT = 45;
const WORD_LANE_HEIGHT = 45;
const SEGMENT_LANE_HEIGHT = 42;
const PASS_LANE_HEIGHT = 20;
const LANE_GAP = 0;
/** The persistent track-name column's width — Kalakar's own is 124px at 1919px canvas width; this timeline runs narrower, so a tighter column keeps "Captions"/"Video 1"/"Audio 1" from crowding the ruler. */
const TRACK_LABEL_WIDTH = 124;
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

// ---------------------------------------------------------------------------
// Chrome recipes (08 §1 tokens). Spelled out once, so a control added to the
// toolbar or the Caption Tools menu later cannot drift from the caption
// panel's own primitives (`components/editor/panels/controls.tsx`) — same
// heights, same wells, same one-of-N segmented control, lime reserved for
// state that is actually *on*.
// ---------------------------------------------------------------------------

/** 32 px ghost icon button — the toolbar's default tool affordance. */
const TOOL_BUTTON =
  "text-fg-2 hover:text-fg-0 flex size-8 shrink-0 items-center justify-center rounded-sm transition-colors duration-[160ms]";
/** A labelled toolbar button: bordered, on `bg-2`, never the accent. */
const TOOLBAR_BUTTON =
  "bg-bg-2 border-border text-fg-1 hover:text-fg-0 flex h-8 shrink-0 items-center gap-1.5 rounded-sm border px-2.5 text-xs font-medium transition-colors duration-[160ms]";
const SEGMENTED_TRACK = "flex gap-0.5 rounded-sm border border-border bg-bg-0 p-0.5";
const TOOLBAR_DIVIDER = "bg-border h-5 w-px shrink-0";
const SECTION_LABEL = "text-2xs font-medium tracking-wide uppercase text-fg-2";
/** The Caption Tools menu's row and control well, matching `controls.tsx`'s `ROW`/`WELL`. */
const MENU_ROW = "flex min-h-8 items-center justify-between gap-2 text-sm text-fg-1";
const MENU_WELL =
  "h-8 rounded-sm border border-border bg-bg-0 px-2 text-right text-xs text-fg-0 disabled:cursor-not-allowed disabled:text-fg-disabled";
const MENU_ACTION =
  "bg-bg-2 border-border text-fg-1 hover:text-fg-0 disabled:text-fg-disabled h-8 rounded-sm border px-2.5 text-left text-xs font-medium transition-colors duration-[160ms] disabled:cursor-not-allowed";

/**
 * The WORD/LINE granularity switch. Kalakar's own toggle (pixel-sampled from
 * the reference, 2026-09-12) fills the picked side near-white with dark
 * text — the one segmented control in the whole product that inverts
 * instead of using the neutral raised fill `controls.tsx`'s `segmentedItem`
 * uses everywhere else.
 */
function segmentedItem(active: boolean): string {
  return cn(
    "text-2xs h-7 rounded-[6px] border px-2.5 font-medium tracking-wide uppercase transition-colors duration-[160ms]",
    active
      ? "border-transparent bg-fg-0 text-bg-1"
      : "text-fg-2 hover:text-fg-0 border-transparent bg-transparent",
  );
}

/** The percentage a `.panel-range` has filled, as its `--fill` custom property. */
function rangeFillStyle(value: number, min: number, max: number): React.CSSProperties {
  const span = max - min;
  const pct = span === 0 ? 0 : Math.min(100, Math.max(0, ((value - min) / span) * 100));
  return { "--fill": `${String(pct)}%` } as React.CSSProperties;
}

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
  readonly onInsertWordAfter?: (afterWordId: string, text: string) => void;
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

/**
 * Kalakar's persistent left track-name column (pixel-sampled from the
 * reference, 2026-09-12; Shirorekha keeps all three icons neutral fg-2: an italic-T for Captions, a camera
 * for Video, a waveform for Audio, in that top-to-bottom order). Stacks
 * the same fixed lane heights `laneTops` itself now assigns them in — see
 * that `useMemo`'s own comment — rather than reading `laneTops` directly, so
 * the two can't silently disagree about which row is which. The segment/pass
 * lanes have no reference counterpart to name and stay one blank spacer,
 * sized off `laneTops.totalHeight` so it always fills whatever is left.
 */
function TrackLabels({
  laneTops,
}: {
  readonly laneTops: { readonly totalHeight: number };
}): React.JSX.Element {
  const namedHeight =
    RULER_HEIGHT +
    WORD_LANE_HEIGHT +
    LANE_GAP +
    SEGMENT_LANE_HEIGHT +
    LANE_GAP +
    THUMB_LANE_HEIGHT +
    LANE_GAP +
    WAVEFORM_HEIGHT +
    LANE_GAP;
  const tailHeight = Math.max(0, laneTops.totalHeight - namedHeight);
  return (
    <div
      className="editor-timeline-labels flex shrink-0 flex-col overflow-hidden text-xs"
      style={{ width: TRACK_LABEL_WIDTH }}
      aria-hidden="true"
    >
      <div style={{ height: RULER_HEIGHT }} />
      <div
        className="flex items-center gap-1.5 pr-1"
        style={{ height: WORD_LANE_HEIGHT, marginBottom: LANE_GAP }}
      >
        <Italic className="size-3.5 shrink-0 text-fg-2" aria-hidden="true" />
        <span className="text-fg-2 truncate">Captions</span>
      </div>
      {/* The segment lane sits here (no reference counterpart) — unlabeled. */}
      <div style={{ height: SEGMENT_LANE_HEIGHT, marginBottom: LANE_GAP }} />
      <div
        className="flex items-center gap-1.5 pr-1"
        style={{ height: THUMB_LANE_HEIGHT, marginBottom: LANE_GAP }}
      >
        <Video className="size-3.5 shrink-0 text-fg-2" aria-hidden="true" />
        <span className="text-fg-2 truncate">Video 1</span>
      </div>
      <div className="flex items-center gap-1.5 pr-1" style={{ height: WAVEFORM_HEIGHT }}>
        <AudioWaveform className="text-fg-2 size-3.5 shrink-0" aria-hidden="true" />
        <span className="text-fg-2 truncate">Audio 1</span>
      </div>
      <div style={{ height: tailHeight }} />
    </div>
  );
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
    onInsertWordAfter,
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

  const [widthPx, setWidthPx] = useState(0);
  const [msPerPx, setMsPerPx] = useState(1000 / 158);
  const [snapping, setSnapping] = useState(true);
  const [linkedSelection, setLinkedSelection] = useState(true);
  const [addingWord, setAddingWord] = useState(false);
  const [newWord, setNewWord] = useState("");
  const [scrollMs, setScrollMs] = useState(0);
  // Read once per mount: `--color-info` (`packages/ui/src/styles/tokens.css`)
  // resolved against the DOM, since a Canvas2D `fillStyle` cannot read a CSS
  // custom property itself. Falls back to the token's own default so a test
  // environment with no stylesheet still draws something legible.
  const [protectedColor, setProtectedColor] = useState<string>(CANVAS.info);
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
    const element = canvasColumnRef.current;
    if (element === null) return;
    // The track-label column (`TrackLabels`) sits to the canvas's left inside
    // this same ref, so the canvas itself only gets what's left over.
    const measure = (): void => setWidthPx(Math.max(0, element.clientWidth - TRACK_LABEL_WIDTH));
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
    // Kalakar's own lane order (pixel-sampled from the reference,
    // 2026-09-12) is Captions first, then Video, then Audio — the reverse of
    // this file's original video/audio/captions stack. Every consumer below
    // (drawing and pointer hit-testing alike) already keys off these named
    // offsets rather than assuming a numeric order among them, so this is a
    // pure reshuffle: which lane gets the smallest `y` changes, nothing else
    // has to.
    const wordTop = y;
    y += WORD_LANE_HEIGHT + LANE_GAP;
    const segmentTop = y;
    y += SEGMENT_LANE_HEIGHT + LANE_GAP;
    const thumbTop = y;
    y += THUMB_LANE_HEIGHT + LANE_GAP;
    const waveformTop = y;
    y += WAVEFORM_HEIGHT + LANE_GAP;
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
    ctx.fillStyle = CANVAS.ruler;
    ctx.fillRect(0, 0, widthPx, RULER_HEIGHT);
    ctx.strokeStyle = CANVAS.tick;
    ctx.fillStyle = CANVAS.fg2;
    ctx.font = "11px Inter, sans-serif";
    // The ruler is drawn across the whole canvas, whose span is `widthPx *
    // msPerPx` and owes nothing to the media: a 20.2 s clip at the default
    // 30 ms/px on a ~1170 px timeline labelled ticks out to 00:35 (FIX-02 step
    // 6, audit 2026-09-04). `clampScroll` already treats `durationMs` as the
    // content extent; the ruler now agrees, stopping one major tick past the
    // end so the last label is still reachable. `durationMs === 0` (no media
    // loaded yet) keeps the old full-width ruler rather than drawing none.
    const rulerEndMs =
      durationMs > 0 ? Math.min(endMs, durationMs + tickStepMs(msPerPx, 72)) : endMs;
    for (const tickSourceMs of ruleTicks(startMs, rulerEndMs, msPerPx, 72)) {
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

    // K03: video filmstrip. Frame-shaped tiles at the video's own aspect
    // ratio, repeated along the lane and anchored to time, each showing the
    // nearest of worker-media's thumbnails with a "cover" crop — never one
    // thumbnail stretched across a tenth of the timeline, which drew a 9:16
    // frame about nine times too wide (2026-09-25; `lib/timeline/filmstrip.ts`).
    if (thumbnails !== undefined && thumbnails.length > 0 && durationMs > 0) {
      const top = laneTops.thumbTop + FILMSTRIP_INSET_Y;
      const height = THUMB_LANE_HEIGHT - FILMSTRIP_INSET_Y * 2;
      const stripX0 = msToPx(0, viewport);
      const stripX1 = msToPx(durationMs, viewport);
      const loaded = thumbnails
        .map((url) => getThumbImage(url))
        .find((img) => img.complete && img.naturalWidth > 0);
      const aspect =
        loaded === undefined ? FILMSTRIP_FALLBACK_ASPECT : loaded.naturalWidth / loaded.naturalHeight;

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(stripX0, top, stripX1 - stripX0, height, FILMSTRIP_RADIUS);
      ctx.clip();
      ctx.fillStyle = FILMSTRIP_EMPTY;
      ctx.fillRect(stripX0, top, stripX1 - stripX0, height);
      const tiles = filmstripTiles({
        durationMs,
        thumbCount: thumbnails.length,
        aspect,
        tileHeightPx: height,
        viewport,
        startMs,
        endMs,
      });
      for (const tile of tiles) {
        const url = thumbnails[tile.thumbIndex];
        const img = url === undefined ? undefined : getThumbImage(url);
        if (img !== undefined && img.complete && img.naturalWidth > 0) {
          const crop = coverCrop(
            { width: img.naturalWidth, height: img.naturalHeight },
            tile.w,
            height,
          );
          ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, tile.x, top, tile.w, height);
        }
        // A hairline of the canvas ink between frames, like a film's frame line.
        if (tile.x > stripX0 + 0.5) {
          ctx.fillStyle = FILMSTRIP_FRAME_LINE;
          ctx.fillRect(Math.round(tile.x), top, 1, height);
        }
      }
      ctx.restore();
      // A faint inner edge so the strip reads as one object on the rail.
      ctx.strokeStyle = FILMSTRIP_EDGE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(stripX0 + 0.5, top + 0.5, stripX1 - stripX0 - 1, height - 1, FILMSTRIP_RADIUS);
      ctx.stroke();
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
      ctx.fillStyle = CANVAS.waveBed;
      ctx.fillRect(
        waveformWindow.pxStart,
        laneTops.waveformTop + 3,
        waveformWindow.widthPx,
        WAVEFORM_HEIGHT - 6,
      );
      ctx.fillStyle = CANVAS.wavePeak;
      ctx.strokeStyle = CANVAS.waveEnergy;
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
        ctx.strokeStyle = CANVAS.waveEnergy;
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
        // design/07 §3.1: the word currently under the playhead illuminates
        // in the accent, distinct from `selected` (an editing click, indigo edge
        // marks below) — compared against the same shifted `wordStartMs`/
        // `wordEndMs` the chip is positioned with, so it never drifts out of
        // sync with a live Caption Delay preview or an in-progress edge drag.
        const playing = wordStartMs <= playheadMs && playheadMs < wordEndMs;
        const lowConfidence = word.c !== undefined && word.c < 0.6;
        // Unselected word chips are a warm neutral (Shirorekha: the accent is
        // spent on the playing word and the selection only). The earlier gold
        // chip read as the `proposed` signal hue, which is a status colour.
        ctx.fillStyle = playing
          ? CANVAS.accent
          : selected
            ? CANVAS.fg0
            : word.filler === true
              ? CANVAS.chipFiller
              : CANVAS.chip;
        ctx.beginPath();
        ctx.roundRect(x0, laneTops.wordTop + 4, w, WORD_LANE_HEIGHT - 8, Math.min(4, w / 2));
        ctx.fill();
        if (lowConfidence) {
          ctx.fillStyle = CANVAS.proposed;
          ctx.fillRect(x0, laneTops.wordTop + WORD_LANE_HEIGHT - 2, w, 2);
        }
        if (selected) {
          ctx.fillStyle = CANVAS.accent;
          ctx.fillRect(x0 - 1, laneTops.wordTop, 2, WORD_LANE_HEIGHT);
          ctx.fillRect(x1 - 1, laneTops.wordTop, 2, WORD_LANE_HEIGHT);
        }
        if (searchMatchWordIds.has(word.wid)) {
          ctx.strokeStyle = CANVAS.proposed;
          ctx.lineWidth = 2;
          ctx.strokeRect(x0 + 1, laneTops.wordTop + 1, Math.max(0, w - 2), WORD_LANE_HEIGHT - 2);
          ctx.lineWidth = 1;
        }
        if (w >= MIN_PX_PER_WORD_LABEL) {
          // Ink on the accent (5.5:1) and on the fg-0 selection; light text
          // on the neutral chips. White on the accent was 3.4:1.
          ctx.fillStyle =
            playing || selected ? CANVAS.ink : word.filler === true ? CANVAS.fg1 : CANVAS.fg0;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0 + 4, laneTops.wordTop + 4, Math.max(1, w - 8), WORD_LANE_HEIGHT - 9);
          ctx.clip();
          // 11 px: the meta-text floor (DESIGN.md › Type). The old 8.5 px
          // "T Text" sub-label under it named nothing and was removed (L-2).
          ctx.font = "11px Inter, sans-serif";
          ctx.fillText(word.t, x0 + 5, laneTops.wordTop + 16);
          ctx.restore();
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
        ctx.fillStyle = selected ? CANVAS.fg0 : CANVAS.chip;
        ctx.beginPath();
        ctx.roundRect(x0, laneTops.wordTop + 4, w, WORD_LANE_HEIGHT - 8, Math.min(4, w / 2));
        ctx.fill();
        if (selected) {
          ctx.fillStyle = CANVAS.accent;
          ctx.fillRect(x0 - 1, laneTops.wordTop, 2, WORD_LANE_HEIGHT);
          ctx.fillRect(x1 - 1, laneTops.wordTop, 2, WORD_LANE_HEIGHT);
        }
        if (hasMatch) {
          ctx.strokeStyle = CANVAS.proposed;
          ctx.lineWidth = 2;
          ctx.strokeRect(x0 + 1, laneTops.wordTop + 1, Math.max(0, w - 2), WORD_LANE_HEIGHT - 2);
          ctx.lineWidth = 1;
        }
        if (w >= MIN_PX_PER_LINE_LABEL) {
          const text = segmentTextById.get(segment.id) ?? "";
          ctx.fillStyle = selected ? CANVAS.ink : CANVAS.fg0;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0 + 4, laneTops.wordTop + 4, Math.max(1, w - 8), WORD_LANE_HEIGHT - 9);
          ctx.clip();
          // 11 px: the meta-text floor (DESIGN.md › Type). The old 8.5 px
          // "T Text" sub-label under it named nothing and was removed (L-2).
          ctx.font = "11px Inter, sans-serif";
          ctx.fillText(text, x0 + 5, laneTops.wordTop + 16);
          ctx.restore();
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
      if (!selected && segment.hidden !== true) continue;
      ctx.fillStyle =
        segment.hidden === true
          ? CANVAS.wash
          : selected
            ? CANVAS.accentTintStrong
            : CANVAS.accentTint;
      ctx.fillRect(x0, laneTops.segmentTop, w, SEGMENT_LANE_HEIGHT);
      if (segment.hidden === true) {
        ctx.strokeStyle = CANVAS.hatch;
        for (let hx = x0; hx < x1; hx += 6) {
          ctx.beginPath();
          ctx.moveTo(hx, laneTops.segmentTop);
          ctx.lineTo(hx + SEGMENT_LANE_HEIGHT, laneTops.segmentTop + SEGMENT_LANE_HEIGHT);
          ctx.stroke();
        }
      }
      ctx.strokeStyle = selected ? CANVAS.fg0 : CANVAS.accentEdge;
      ctx.strokeRect(
        x0 + 0.5,
        laneTops.segmentTop + 0.5,
        Math.max(0, w - 1),
        SEGMENT_LANE_HEIGHT - 1,
      );
      if (selected) {
        ctx.fillStyle = CANVAS.fg0;
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
        ctx.fillStyle = CANVAS.fg0;
        ctx.font = "11px Inter, sans-serif";
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
          ctx.strokeStyle = CANVAS.ink;
          ctx.globalAlpha = 0.6;
          ctx.beginPath();
          ctx.moveTo(x0, top + PASS_LANE_HEIGHT / 2);
          ctx.lineTo(x1, top + PASS_LANE_HEIGHT / 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        if (hoveredPassItemId === item.itemId) {
          ctx.strokeStyle = CANVAS.fg0;
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
              ctx.strokeStyle = CANVAS.neutral200;
              ctx.lineWidth = 1;
              ctx.beginPath();
              points.forEach((point, index) => {
                const px = x0 + point.x;
                const py = plotTop + point.y;
                if (index === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
              });
              ctx.stroke();
              ctx.fillStyle = CANVAS.fg0;
              for (const point of points) {
                ctx.fillRect(x0 + point.x - 1, plotTop - 1, 2, plotHeight + 2);
              }
            }
          }
        }
      }
    });

    // The reference uses a thin white playhead with a square handle.
    const playheadSourceMs = playheadMs;
    if (playheadSourceMs >= startMs && playheadSourceMs <= endMs) {
      const px = msToPx(playheadSourceMs, viewport);
      ctx.strokeStyle = CANVAS.fg0;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, laneTops.totalHeight);
      ctx.stroke();
      ctx.fillStyle = CANVAS.fg0;
      ctx.beginPath();
      ctx.roundRect(px - 4, 0, 9, 9, 2);
      ctx.fill();
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
        if (linkedSelection) onSeek(word.s);
        return;
      }

      // K03: a LINE chip click selects and seeks to its segment — the same
      // outcome a segment-lane click below it already produces, so the two
      // lanes agree once a caption is showing as a merged line.
      const lineChip = hitTestLineChip(px, py);
      if (lineChip !== undefined) {
        onSelectSegment?.(lineChip.id);
        if (linkedSelection) onSeek(lineChip.startMs);
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
      linkedSelection,
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
          wordBoundaries: snapping ? boundaries : [],
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
          { wordBoundaries: snapping ? boundaries : [], neighbours },
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
      snapping,
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
      snapping,
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
          { wordBoundaries: snapping ? boundaries : [], neighbours },
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
          wordBoundaries: snapping ? wordBoundariesOf(segment) : [],
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
      snapping,
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
      className={cn("editor-timeline bg-bg-1 flex w-full select-none items-start", className)}
      data-testid="timeline-root"
      role="application"
      aria-label="Caption timeline"
      aria-roledescription="editor timeline"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div ref={canvasColumnRef} className="editor-timeline-column relative min-w-0 flex-1">
        <div className="editor-timeline-toolbar text-fg-2 flex items-center text-xs">
          <div
            className={cn(SEGMENTED_TRACK, "timeline-granularity")}
            role="group"
            aria-label="Caption granularity"
          >
            <button
              type="button"
              data-testid="timeline-granularity-word"
              aria-pressed={granularity === "word"}
              className={segmentedItem(granularity === "word")}
              onClick={() => setGranularity("word")}
            >
              Word
            </button>
            <button
              type="button"
              data-testid="timeline-granularity-line"
              aria-pressed={granularity === "line"}
              className={segmentedItem(granularity === "line")}
              onClick={() => setGranularity("line")}
            >
              Line
            </button>
          </div>

          <div className="relative">
            <button
              type="button"
              className={TOOLBAR_BUTTON}
              aria-expanded={addingWord}
              disabled={liveWords.length === 0 || onInsertWordAfter === undefined}
              onClick={() => setAddingWord((open) => !open)}
            >
              <Plus className="size-[13px]" /> Word
            </button>
            {addingWord ? (
              <form
                className="absolute top-full left-0 z-40 mt-2 flex gap-2 rounded-sm border border-border bg-bg-1 p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const anchor =
                    liveWords.find((word) => word.wid === selectedWordId) ??
                    [...liveWords].reverse().find((word) => word.s <= playheadMs) ??
                    liveWords[0];
                  if (anchor !== undefined && newWord.trim() !== "") {
                    onInsertWordAfter?.(anchor.wid, newWord.trim());
                    setNewWord("");
                    setAddingWord(false);
                  }
                }}
              >
                <input
                  autoFocus
                  aria-label="New word"
                  value={newWord}
                  onChange={(event) => setNewWord(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setAddingWord(false);
                  }}
                  className="w-32 rounded-sm border border-border bg-bg-2 px-2"
                />
                <button type="submit" className={TOOLBAR_BUTTON}>
                  Add
                </button>
              </form>
            ) : null}
          </div>
          <div className="relative" ref={captionToolsRef}>
            <button
              type="button"
              data-testid="timeline-caption-tools-trigger"
              aria-haspopup="true"
              aria-expanded={captionToolsOpen}
              className={TOOL_BUTTON}
              aria-label="Caption tools"
              title="Caption tools"
              onClick={() => setCaptionToolsOpen((open) => !open)}
            >
              <SlidersHorizontal className="size-[17px]" aria-hidden="true" />
            </button>
            {captionToolsOpen ? (
              <div
                role="menu"
                aria-label="Caption tools"
                data-testid="timeline-caption-tools-menu"
                className="border-border bg-bg-1 scrollbar-thin absolute top-full left-0 z-40 mt-1 flex max-h-[75vh] w-72 flex-col gap-3 overflow-y-auto rounded-md border p-3 text-left shadow-xl"
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
                <div className="flex items-center gap-2">
                  {" "}
                  <button
                    type="button"
                    data-testid="timeline-play-pause"
                    aria-label={playing ? "Pause" : "Play"}
                    title={playing ? "Pause" : "Play"}
                    className={TOOL_BUTTON}
                    onClick={onTogglePlay}
                  >
                    {playing ? (
                      <Pause className="size-4" aria-hidden="true" />
                    ) : (
                      <Play className="size-4" aria-hidden="true" />
                    )}
                  </button>
                  <div className="relative flex items-center gap-1.5">
                    <Search
                      className="text-fg-2 pointer-events-none absolute left-2 size-3.5"
                      aria-hidden="true"
                    />
                    <input
                      type="text"
                      data-testid="timeline-search"
                      placeholder="Search captions"
                      aria-label="Search captions"
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      className="border-border bg-bg-0 text-fg-0 placeholder:text-fg-2 focus:border-border-hover h-8 w-36 rounded-sm border pr-2 pl-7 text-xs transition-colors duration-[160ms] focus:outline-none"
                    />
                    {searchQuery !== "" ? (
                      <>
                        <span
                          data-testid="timeline-search-count"
                          className="text-fg-2 tabular-nums"
                        >
                          {searchMatches.length} match{searchMatches.length === 1 ? "" : "es"}
                        </span>
                        <button
                          type="button"
                          data-testid="timeline-search-clear"
                          aria-label="Clear search"
                          className={TOOL_BUTTON}
                          onClick={() => setSearchQuery("")}
                        >
                          <X className="size-3.5" aria-hidden="true" />
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
                {outputModeAvailable(timeMap) ? (
                  <label className="text-fg-1 ml-2 flex shrink-0 items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      data-testid="timeline-output-mode-toggle"
                      checked={displayMode === "output"}
                      onChange={(event) =>
                        onDisplayModeChange?.(event.target.checked ? "output" : "source")
                      }
                      className="panel-switch"
                    />
                    Output time
                  </label>
                ) : null}
                {onToggleProtection !== undefined &&
                (selectedSegmentId !== undefined || selectedWordId !== undefined) ? (
                  <button
                    type="button"
                    data-testid="timeline-toggle-protection"
                    className={TOOLBAR_BUTTON}
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
                    <Shield className="size-3.5" aria-hidden="true" />
                    Protect (P)
                  </button>
                ) : null}

                <div data-testid="caption-tools-display-settings" className="flex flex-col gap-1.5">
                  <div className={SECTION_LABEL}>Display settings</div>
                  <label className={MENU_ROW}>
                    Words
                    <select
                      data-testid="caption-tools-words"
                      disabled
                      title="No other grouping exists yet in this app's data model — Default is the only real option."
                      className={cn(MENU_WELL, "w-28")}
                      defaultValue="default"
                    >
                      <option value="default">Default</option>
                    </select>
                  </label>
                  <label className={MENU_ROW}>
                    Max characters
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
                      className={cn(MENU_WELL, "w-20")}
                    />
                  </label>
                  <label className={MENU_ROW}>
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
                      className={cn(MENU_WELL, "w-28")}
                    >
                      <option value={1}>1 Line</option>
                      <option value={2}>2 Lines</option>
                      <option value={3}>3 Lines</option>
                    </select>
                  </label>
                  <p className="text-2xs text-fg-2">
                    Re-cuts every caption from the transcript — manual splits, merges and hidden
                    captions are replaced.
                  </p>
                </div>

                <div data-testid="caption-tools-actions" className="flex flex-col gap-1.5">
                  <div className={SECTION_LABEL}>Actions</div>
                  <button
                    type="button"
                    data-testid="caption-tools-remove-punctuation"
                    disabled={onCaptionToolsAction === undefined}
                    className={MENU_ACTION}
                    onClick={runRemovePunctuation}
                  >
                    Remove punctuation
                  </button>
                  <button
                    type="button"
                    data-testid="caption-tools-remove-emphasis"
                    disabled={onCaptionToolsAction === undefined}
                    className={MENU_ACTION}
                    onClick={runRemoveEmphasis}
                  >
                    Remove emphasis
                  </button>
                  <button
                    type="button"
                    data-testid="caption-tools-remove-gaps"
                    disabled={onCaptionToolsAction === undefined}
                    className={MENU_ACTION}
                    onClick={runRemoveGaps}
                  >
                    Remove gaps in captions
                  </button>
                  <button
                    type="button"
                    data-testid="caption-tools-remove-emojis"
                    disabled={onCaptionToolsAction === undefined}
                    className={MENU_ACTION}
                    onClick={runRemoveEmojis}
                  >
                    Remove emojis
                  </button>
                </div>

                <div data-testid="caption-tools-timing" className="flex flex-col gap-1.5">
                  <div className={SECTION_LABEL}>Timing</div>
                  <label className="text-fg-1 flex flex-col gap-2 text-sm">
                    <span className="flex items-center justify-between">
                      Caption delay
                      <span
                        data-testid="caption-tools-delay-value"
                        className="text-fg-2 font-mono text-xs tabular-nums"
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
                      className="panel-range w-full"
                      style={rangeFillStyle(
                        delayPreviewMs,
                        -CAPTION_DELAY_RANGE_MS,
                        CAPTION_DELAY_RANGE_MS,
                      )}
                    />
                  </label>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      data-testid="caption-tools-delay-reset"
                      disabled={delayPreviewMs === 0}
                      className="text-fg-2 hover:text-fg-0 disabled:text-fg-disabled h-8 rounded-sm px-2.5 text-xs font-medium transition-colors duration-[160ms] disabled:cursor-not-allowed"
                      onClick={resetCaptionDelay}
                    >
                      Reset
                    </button>
                    <button
                      type="button"
                      data-testid="caption-tools-delay-apply"
                      disabled={delayPreviewMs === 0 || onCaptionToolsAction === undefined}
                      className="border-border text-fg-0 hover:bg-neutral-100/7 active:bg-neutral-100/14 disabled:text-fg-disabled flex h-8 items-center justify-center rounded-sm border px-4 text-xs font-medium transition-colors duration-[160ms] disabled:cursor-not-allowed disabled:hover:bg-transparent"
                      onClick={applyCaptionDelay}
                    >
                      Apply
                    </button>
                  </div>
                </div>

                <div className="bg-border h-px" />

                {/*
                 * K03 brief §3: "call the same underlying handlers/store actions
                 * `BulkActionsBar.tsx` uses, do not duplicate the logic" — this
                 * renders that exact component (not a reimplementation) as a
                 * second entry point, so its three actions are guaranteed to
                 * produce identical results to the transcript column's own copy.
                 */}
                <div
                  data-testid="caption-tools-structure"
                  hidden={!captionToolsAvailable}
                  className="flex flex-col gap-1.5"
                >
                  <div className={SECTION_LABEL}>Structure</div>
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

          <div className={TOOLBAR_DIVIDER} aria-hidden="true" />
          <button
            type="button"
            className={TOOL_BUTTON}
            aria-label="Split caption"
            title="Split caption (S)"
            disabled={selectedSegmentId === undefined || onSplitSegment === undefined}
            onClick={() => {
              const segment = segments.find((entry) => entry.id === selectedSegmentId);
              const word =
                liveWords.find((entry) => entry.wid === selectedWordId) ??
                liveWords.find((entry) => entry.s >= playheadMs);
              if (
                segment !== undefined &&
                word !== undefined &&
                wordIdWithin(word.wid, segment.startWordId, segment.endWordId)
              )
                onSplitSegment?.(segment.id, word.wid);
            }}
          >
            <Scissors className="size-[17px]" />
          </button>
          <button
            type="button"
            data-testid="timeline-merge"
            className={TOOL_BUTTON}
            aria-label="Merge with next"
            title="Merge with next (M)"
            disabled={
              selectedSegmentId === undefined ||
              onMergeSegments === undefined ||
              segments.at(-1)?.id === selectedSegmentId
            }
            onClick={() => {
              const index = segments.findIndex((entry) => entry.id === selectedSegmentId);
              const next = segments[index + 1];
              if (selectedSegmentId !== undefined && next !== undefined)
                onMergeSegments?.([selectedSegmentId, next.id]);
            }}
          >
            <GitMerge className="size-[17px]" />
          </button>
          <div className={TOOLBAR_DIVIDER} aria-hidden="true" />
          <button
            type="button"
            className={TOOL_BUTTON}
            aria-label="Snap to word boundaries"
            title="Snap to word boundaries"
            aria-pressed={snapping}
            onClick={() => setSnapping((value) => !value)}
          >
            <Magnet className="size-[17px]" />
          </button>
          <button
            type="button"
            className={TOOL_BUTTON}
            aria-label="Link selection to playback"
            title="Link selection to playback"
            aria-pressed={linkedSelection}
            onClick={() => setLinkedSelection((value) => !value)}
          >
            <Link2 className="size-[17px]" />
          </button>
          <div className={TOOLBAR_DIVIDER} aria-hidden="true" />
          <div className="editor-timeline-zoom">
            <button
              type="button"
              data-testid="timeline-zoom-out"
              aria-label="Zoom out"
              title="Zoom out"
              className={TOOL_BUTTON}
              onClick={() => {
                const next = zoomAround({ msPerPx, scrollMs }, widthPx / 2, "out");
                setMsPerPx(next.msPerPx);
                setScrollMs(
                  clampScroll(next.scrollMs, { msPerPx: next.msPerPx, widthPx }, durationMs),
                );
              }}
            >
              <ZoomOut className="size-4" aria-hidden="true" />
            </button>

            <input
              type="range"
              className="panel-range"
              aria-label="Timeline zoom"
              min={0}
              max={100}
              value={100 - (Math.log(msPerPx / 5) / Math.log(200)) * 100}
              onChange={(event) => {
                const next = 5 * Math.pow(200, 1 - Number(event.target.value) / 100);
                const anchor = scrollMs + (widthPx / 2) * msPerPx;
                setMsPerPx(next);
                setScrollMs(
                  clampScroll(
                    anchor - (widthPx / 2) * next,
                    { msPerPx: next, widthPx },
                    durationMs,
                  ),
                );
              }}
            />
            <button
              type="button"
              data-testid="timeline-zoom-in"
              aria-label="Zoom in"
              title="Zoom in"
              className={TOOL_BUTTON}
              onClick={() => {
                const next = zoomAround({ msPerPx, scrollMs }, widthPx / 2, "in");
                setMsPerPx(next.msPerPx);
                setScrollMs(
                  clampScroll(next.scrollMs, { msPerPx: next.msPerPx, widthPx }, durationMs),
                );
              }}
            >
              <ZoomIn className="size-4" aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            className={cn(TOOL_BUTTON, "ml-auto")}
            aria-label="Fit timeline"
            title="Fit timeline"
            onClick={() => {
              setMsPerPx(Math.max(5, Math.min(1000, durationMs / Math.max(1, widthPx))));
              setScrollMs(0);
            }}
          >
            <Maximize2 className="size-[17px]" />
          </button>
          <span data-testid="timeline-display-clock" className="sr-only">
            {formatMs(displayPlayheadMs)} / {formatMs(displayDuration)}
          </span>
        </div>
        <div className="editor-timeline-tracks flex items-start">
          <TrackLabels laneTops={laneTops} />
          <canvas
            ref={canvasRef}
            data-testid="timeline-canvas"
            className="bg-editor-sunken block"
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
        </div>
        <div className="editor-timeline-scroll">
          <input
            type="range"
            className="panel-range"
            aria-label="Timeline scroll"
            min={0}
            max={Math.max(0, durationMs - widthPx * msPerPx)}
            step={1}
            value={scrollMs}
            onChange={(event) => setScrollMs(Number(event.target.value))}
          />
        </div>
        <p className="sr-only" data-testid="timeline-aria-description" aria-live="polite">
          {ariaDescription}
        </p>
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
