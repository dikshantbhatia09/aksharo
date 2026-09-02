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
  visibleRange,
  zoomAround,
  type Viewport,
} from "@/lib/timeline/coords";
import { buildLanes, laneStateColor, type LaneRow } from "@/lib/timeline/lanes";
import { noopNudgeSink, segmentEdgeNudge, type TimingNudgeSink } from "@/lib/timeline/nudge";
import {
  displayDurationMs,
  isCutAway,
  outputModeAvailable,
  toDisplayMs,
  toSourceMs,
  type TimeDisplayMode,
} from "@/lib/timeline/output-clock";
import { resolveSegmentDrag, type Neighbour } from "@/lib/timeline/snapping";
import { reduceWaveform, type WaveformLike } from "@/lib/timeline/waveform-view";
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

export interface SegmentBoundsOp {
  readonly segmentId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly startWordId?: string;
  readonly endWordId?: string;
}

export interface TimelineProps {
  readonly words: readonly Word[];
  readonly segments: readonly Segment[];
  readonly passItems?: readonly PassItem[];
  readonly waveform?: WaveformLike;
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
  readonly onSplitSegment?: (segmentId: string, atWordId: string) => void;
  readonly onMergeSegments?: (segmentIds: readonly [string, string]) => void;
  readonly timeMap?: TimeMap;
  readonly displayMode?: TimeDisplayMode;
  readonly onDisplayModeChange?: (mode: TimeDisplayMode) => void;
  readonly nudgeSink?: TimingNudgeSink;
  readonly className?: string;
}

interface DragState {
  readonly pointerId: number;
  readonly kind: "segment-edge" | "playhead";
  readonly segmentId?: string;
  readonly edge?: "start" | "end";
  readonly startMs?: number;
  readonly endMs?: number;
}

/** `true` when `wid` falls in `[startWordId, endWordId]` by chunk/sequence order, not string order. */
function wordIdWithin(wid: string, startWordId: string, endWordId: string): boolean {
  const target = parseWordId(wid);
  const start = parseWordId(startWordId);
  const end = parseWordId(endWordId);
  const key = (p: { chunkIdx: number; n: number }): number => p.chunkIdx * 1_000_000 + p.n;
  const k = key(target);
  return k >= key(start) && k <= key(end);
}

export function Timeline(props: TimelineProps): React.JSX.Element {
  const {
    words,
    segments,
    passItems = [],
    waveform,
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
    onSplitSegment,
    onMergeSegments,
    timeMap,
    displayMode = "source",
    onDisplayModeChange,
    nudgeSink = noopNudgeSink,
    className,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const dragPreviewRef = useRef<{ startMs: number; endMs: number } | undefined>(undefined);

  const [widthPx, setWidthPx] = useState(0);
  const [msPerPx, setMsPerPx] = useState(30);
  const [scrollMs, setScrollMs] = useState(0);
  const [selectedEdge, setSelectedEdge] = useState<"start" | "end" | undefined>(undefined);
  const [, forceRedraw] = useState(0);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const measure = (): void => setWidthPx(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
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

  const lanes: readonly LaneRow[] = useMemo(() => buildLanes(passItems), [passItems]);

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
    const dpr = typeof window === "undefined" ? 1 : (window.devicePixelRatio || 1);
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
    for (const tickSourceMs of ruleTicks(startMs, endMs, msPerPx)) {
      const tickMs = toDisplayMs(tickSourceMs, displayMode, timeMap);
      const px = msToPx(tickSourceMs, viewport);
      ctx.beginPath();
      ctx.moveTo(px, RULER_HEIGHT - 8);
      ctx.lineTo(px, RULER_HEIGHT);
      ctx.stroke();
      ctx.fillText(formatMs(tickMs), px + 2, RULER_HEIGHT - 10);
    }

    // Waveform
    if (waveform !== undefined) {
      const buckets = reduceWaveform(waveform, Math.max(0, startMs), Math.min(durationMs, endMs), widthPx);
      const midY = laneTops.waveformTop + WAVEFORM_HEIGHT / 2;
      ctx.fillStyle = "rgba(124,143,240,0.25)";
      ctx.strokeStyle = "#7c8ff0";
      for (let px = 0; px < buckets.length; px++) {
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

    // Word lane
    for (const word of liveWords) {
      if (word.e < startMs || word.s > endMs) continue;
      const x0 = msToPx(word.s, viewport);
      const x1 = msToPx(word.e, viewport);
      const w = Math.max(1, x1 - x0);
      const selected = word.wid === selectedWordId;
      const lowConfidence = word.c !== undefined && word.c < 0.6;
      ctx.fillStyle = selected ? "#ffffff" : word.filler === true ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.3)";
      ctx.fillRect(x0, laneTops.wordTop, w, WORD_LANE_HEIGHT);
      if (lowConfidence) {
        ctx.fillStyle = "#f59e0b";
        ctx.fillRect(x0, laneTops.wordTop + WORD_LANE_HEIGHT - 2, w, 2);
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
      ctx.fillStyle = segment.hidden === true ? "rgba(255,255,255,0.06)" : selected ? "rgba(124,143,240,0.5)" : "rgba(124,143,240,0.25)";
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
      ctx.strokeRect(x0 + 0.5, laneTops.segmentTop + 0.5, Math.max(0, w - 1), SEGMENT_LANE_HEIGHT - 1);
      if (selected) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x0 - 1, laneTops.segmentTop, 2, SEGMENT_LANE_HEIGHT);
        ctx.fillRect(x1 - 1, laneTops.segmentTop, 2, SEGMENT_LANE_HEIGHT);
      }
    }

    // Pass lanes (read-only)
    lanes.forEach((lane, laneIndex) => {
      const top = laneTops.passTops[laneIndex];
      if (top === undefined) return;
      for (const item of lane.items) {
        if (item.endMs < startMs || item.startMs > endMs) continue;
        const x0 = msToPx(item.startMs, viewport);
        const x1 = msToPx(item.endMs, viewport);
        const w = Math.max(1, x1 - x0);
        ctx.fillStyle = laneStateColor(item.state);
        ctx.globalAlpha = item.state === "rejected" ? 0.25 : 0.6;
        ctx.fillRect(x0, top, w, PASS_LANE_HEIGHT);
        ctx.globalAlpha = 1;
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
    selectedSegmentId,
    selectedWordId,
    playheadMs,
    durationMs,
    displayMode,
    timeMap,
    msPerPx,
  ]);

  // ---------------------------------------------------------------------
  // Pointer interaction
  // ---------------------------------------------------------------------

  const hitTestSegmentEdge = useCallback(
    (px: number, py: number): { segment: Segment; edge: "start" | "end" } | undefined => {
      if (py < laneTops.segmentTop || py > laneTops.segmentTop + SEGMENT_LANE_HEIGHT) return undefined;
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

  const hitTestSegmentBody = useCallback(
    (px: number, py: number): Segment | undefined => {
      if (py < laneTops.segmentTop || py > laneTops.segmentTop + SEGMENT_LANE_HEIGHT) return undefined;
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
      hitTestWord,
      hitTestSegmentBody,
      onSeek,
      onSelectSegment,
      onSelectWord,
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
      }
    },
    [segments, viewport, wordBoundariesOf, onSeek, displayMode, timeMap],
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
            nudgeSink.record(segmentEdgeNudge(drag.edge, segment.id, fromMs, toMs));
          }
        }
      }

      dragRef.current = undefined;
      dragPreviewRef.current = undefined;
      forceRedraw((n) => n + 1);
    },
    [segments, wordBoundariesOf, liveWords, onSetSegmentBounds, nudgeSink],
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
      setScrollMs((current) => clampScroll(current + delta * msPerPx, { msPerPx, widthPx }, durationMs));
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
          onSetSegmentBounds({ segmentId: segment.id, startMs: resolved.startMs, endMs: resolved.endMs });
          nudgeSink.record(segmentEdgeNudge(edge, segment.id, current, toMs));
        }
        return;
      }
      if (event.key === "Tab" && !event.shiftKey && event.altKey) {
        event.preventDefault();
        setSelectedEdge(edge === "start" ? "end" : "start");
      }
    },
    [selectedSegmentId, segments, selectedEdge, wordBoundariesOf, onSetSegmentBounds, nudgeSink],
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
      if (word !== undefined) parts.push(`Word selected: "${word.t}".`);
    }
    if (parts.length === 0) parts.push("No selection.");
    return parts.join(" ");
  }, [selectedSegmentId, selectedWordId, segments, liveWords, selectedEdge]);

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
        {outputModeAvailable(timeMap) ? (
          <label className="ml-2 flex items-center gap-1">
            <input
              type="checkbox"
              data-testid="timeline-output-mode-toggle"
              checked={displayMode === "output"}
              onChange={(event) => onDisplayModeChange?.(event.target.checked ? "output" : "source")}
            />
            Output time
          </label>
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
