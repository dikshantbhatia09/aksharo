"use client";

/**
 * The virtualised transcript column.
 *
 * A 3-hour transcript is roughly 9,000 captions; mounting all of them would
 * miss acceptance criterion 1 (≥ 55 fps scroll) by a wide margin, since the
 * DOM — not the network — is what a scroll frame has to repaint. `VirtualList`
 * (`lib/edg/virtual-list.ts`) does the arithmetic; this component owns the
 * scroll listener, the `ResizeObserver` that feeds it real row heights, and
 * the "follow" auto-scroll to the playhead.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Segment, Word } from "@montaj/edg";

import { SegmentCard, type SegmentCardAction } from "./SegmentCard";

import { estimateSegmentHeight, VirtualList } from "@/lib/edg/virtual-list";
import { cn } from "@/lib/utils";

export interface SpeakerInfo {
  readonly name?: string;
  readonly color?: string;
}

export interface TranscriptListProps {
  readonly segments: readonly Segment[];
  readonly wordsOf: (segment: Segment) => readonly Word[];
  /** A22's ScriptTabs also offers "translated" — SegmentCard branches on it. */
  readonly script: string;
  readonly speakers?: ReadonlyMap<string, SpeakerInfo>;
  readonly selectedSegmentId?: string;
  readonly selectedWordId?: string;
  readonly activeSegmentId?: string;
  readonly activeWordId?: string;
  readonly hideFillers?: boolean;
  readonly follow?: boolean;
  readonly onSelectSegment: (segmentId: string) => void;
  readonly onSelectWord?: (segmentId: string, wordId: string) => void;
  readonly onSeek?: (ms: number) => void;
  readonly onEditWord: (wordId: string, text: string) => void;
  readonly onFixSpellingEverywhere?: (wordId: string, text: string) => void;
  readonly onMergeWithNext?: (segmentId: string) => void;
  readonly onHideToggle?: (segmentId: string, hidden: boolean) => void;
  readonly onInsertWordAfter: (afterWordId: string, text: string) => void;
  readonly onRenameSpeakerRequested?: (speakerId: string) => void;
  /** OC3: the segment card's right-click menu asking the editor for a document-level op. */
  readonly onRequestAction?: (
    action: SegmentCardAction,
    segmentId: string,
    wordId?: string,
  ) => void;
  readonly className?: string;
}

const DEFAULT_ROW_HEIGHT = 58;
// The brief caps overscan at 6 rows: each extra row is another subtree the
// adversarial "jump the whole list every frame" perf test forces to
// mount/unmount every frame (acceptance criterion 1).
const OVERSCAN = 6;

export function TranscriptList({
  segments,
  wordsOf,
  script,
  speakers,
  selectedSegmentId,
  selectedWordId,
  activeSegmentId,
  activeWordId,
  hideFillers = false,
  follow = false,
  onSelectSegment,
  onSelectWord,
  onSeek,
  onEditWord,
  onFixSpellingEverywhere,
  onMergeWithNext,
  onHideToggle,
  onInsertWordAfter,
  onRenameSpeakerRequested,
  onRequestAction,
  className,
}: TranscriptListProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<VirtualList>(new VirtualList(segments.length, DEFAULT_ROW_HEIGHT));
  const [range, setRange] = useState({ startIndex: 0, endIndex: -1, offsetTop: 0, totalHeight: 0 });
  const [viewportHeight, setViewportHeight] = useState(0);

  // Keep the virtualiser's count in sync with the (paged, edited) segment list.
  useLayoutEffect(() => {
    listRef.current.setCount(segments.length);
    recompute();
  }, [segments.length]);

  function recompute(): void {
    const container = scrollRef.current;
    if (container === null) return;
    setRange(listRef.current.visibleRange(container.scrollTop, container.clientHeight, OVERSCAN));
  }

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (container === null) return;
    setViewportHeight(container.clientHeight);
    recompute();
    const observer = new ResizeObserver(() => {
      setViewportHeight(container.clientHeight);
      recompute();
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, []);

  function onScroll(): void {
    recompute();
  }

  // "Follow" — scroll the active caption into view when the playhead moves.
  useEffect(() => {
    if (!follow || activeSegmentId === undefined) return;
    const index = segments.findIndex((segment) => segment.id === activeSegmentId);
    if (index < 0) return;
    const container = scrollRef.current;
    if (container === null) return;
    const top = listRef.current.offsetOf(index);
    const height = listRef.current.heightOf(index);
    const bottom = top + height;
    if (top < container.scrollTop || bottom > container.scrollTop + container.clientHeight) {
      container.scrollTo({
        top: Math.max(0, top - container.clientHeight / 3),
        behavior: "smooth",
      });
    }
  }, [follow, activeSegmentId]);

  const visible = useMemo(
    () => segments.slice(range.startIndex, range.endIndex + 1),
    [segments, range.startIndex, range.endIndex],
  );

  // `wordsOf` recomputes a fresh `Word[]` on every call (it slices the word
  // index between two ids) — calling it straight from the render map below
  // would hand `SegmentCard`/`WordChip` a new `words` array reference every
  // render, defeating `React.memo` on both for any row that re-renders
  // without actually changing (the overlap between one scroll frame's window
  // and the next, which is most of it outside the adversarial perf test).
  // Caching by segment id keeps the reference stable across renders and is
  // invalidated wholesale only when `wordsOf` itself changes identity (i.e.
  // the underlying word index changed — an edit, not a scroll).
  const wordsCacheRef = useRef<{ wordsOf: typeof wordsOf; cache: Map<string, readonly Word[]> }>({
    wordsOf,
    cache: new Map(),
  });
  if (wordsCacheRef.current.wordsOf !== wordsOf) {
    wordsCacheRef.current = { wordsOf, cache: new Map() };
  }
  function getWords(segment: Segment): readonly Word[] {
    const { cache } = wordsCacheRef.current;
    const cached = cache.get(segment.id);
    if (cached !== undefined) return cached;
    const words = wordsOf(segment);
    cache.set(segment.id, words);
    return words;
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      data-testid="transcript-list"
      className={cn("bg-bg-1 scrollbar-thin h-full overflow-y-auto overscroll-contain", className)}
    >
      <div style={{ height: listRef.current.totalHeight(), position: "relative" }}>
        <div
          style={{ transform: `translateY(${String(range.offsetTop)}px)` }}
          className="flex flex-col"
        >
          {visible.map((segment, offset) => {
            const index = range.startIndex + offset;
            const words = getWords(segment);
            return (
              <MeasuredRow
                key={segment.id}
                estimatedHeight={estimateSegmentHeight(words.length)}
                onHeight={(height) => {
                  listRef.current.setHeight(index, height);
                }}
              >
                <SegmentCard
                  segment={segment}
                  index={index + 1}
                  words={words}
                  script={script}
                  selected={segment.id === selectedSegmentId}
                  isLast={index === segments.length - 1}
                  hideFillers={hideFillers}
                  {...(selectedWordId === undefined ? {} : { selectedWordId })}
                  {...(activeWordId === undefined ? {} : { activeWordId })}
                  {...(speakers?.get(segment.id) !== undefined
                    ? {
                        speakerName: speakers.get(segment.id)?.name,
                        speakerColor: speakers.get(segment.id)?.color,
                      }
                    : {})}
                  onSelect={onSelectSegment}
                  {...(onSelectWord === undefined ? {} : { onSelectWord })}
                  {...(onSeek === undefined ? {} : { onSeek })}
                  onEditWord={onEditWord}
                  {...(onFixSpellingEverywhere === undefined ? {} : { onFixSpellingEverywhere })}
                  {...(onMergeWithNext === undefined ? {} : { onMergeWithNext })}
                  {...(onHideToggle === undefined ? {} : { onHideToggle })}
                  onInsertWordAfter={onInsertWordAfter}
                  {...(onRenameSpeakerRequested === undefined ? {} : { onRenameSpeakerRequested })}
                  {...(onRequestAction === undefined ? {} : { onRequestAction })}
                />
              </MeasuredRow>
            );
          })}
        </div>
      </div>
      {viewportHeight === 0 ? null : (
        // A stable, invisible probe: keeps `viewportHeight` referenced so a
        // future px-based row-height heuristic has it without another effect.
        <span
          aria-hidden="true"
          data-testid="transcript-list-viewport"
          data-height={viewportHeight}
        />
      )}
    </div>
  );
}

/**
 * One `ResizeObserver` for every `MeasuredRow` on the page, rather than one
 * per row.
 *
 * The stress case for this list (a 3-hour, 54,000-word transcript scrolled
 * fast — acceptance criterion 1) moves the viewport many multiples of its
 * own height every frame (`editor-performance.spec.ts`'s own comment: "the
 * worst case for a virtualiser, since every frame's visible range is new"),
 * so the whole visible+overscan window of rows — everything `MeasuredRow`
 * renders — mounts fresh every single frame. Constructing and disconnecting
 * a real `ResizeObserver` per row, ~25 times a frame for two seconds
 * straight, measured as a real contributor to a 13–18 fps result against
 * the ≥ 55 fps target (A15b perf run): one long-lived observer that
 * `observe`/`unobserve`s elements is far cheaper than repeatedly
 * constructing the observer itself.
 */
let sharedRowObserver: ResizeObserver | undefined;
const rowObserverCallbacks = new Map<Element, (height: number) => void>();

function sharedObserver(): ResizeObserver {
  sharedRowObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      rowObserverCallbacks.get(entry.target)?.(entry.contentRect.height);
    }
  });
  return sharedRowObserver;
}

/** Reports its own rendered height, so the virtualiser can use a real number instead of an estimate. */
function MeasuredRow({
  children,
  estimatedHeight,
  onHeight,
}: {
  children: React.ReactNode;
  estimatedHeight: number;
  onHeight: (height: number) => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  // `onHeight` is a fresh closure every render (it captures the row's
  // current `index`); routing calls through a ref keeps the observer effect
  // itself mount-once (`[]`) instead of tearing down and rebuilding on every
  // re-render of an already-visible row.
  const onHeightRef = useRef(onHeight);
  onHeightRef.current = onHeight;
  const estimatedHeightRef = useRef(estimatedHeight);
  estimatedHeightRef.current = estimatedHeight;

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    // Seed the virtualiser with the content-based estimate rather than
    // calling `element.getBoundingClientRect()` here: that read forces a
    // synchronous layout before the browser would otherwise compute one, and
    // the adversarial scroll test mounts ~2x overscan rows fresh every
    // single frame — one forced reflow per row per frame measured as a real
    // contributor to the pre-A15c 13-18 fps result. The shared
    // `ResizeObserver`'s own first callback (already async, batched by the
    // browser after layout) reports the real height a frame or two later and
    // corrects any drift; the spacing between rows lives *inside* the
    // measured element (padding, not a flex `gap`), so that correction still
    // keeps the prefix sums exact.
    onHeightRef.current(estimatedHeightRef.current);
    const observer = sharedObserver();
    rowObserverCallbacks.set(element, (height) => {
      onHeightRef.current(height);
    });
    observer.observe(element);
    return () => {
      observer.unobserve(element);
      rowObserverCallbacks.delete(element);
    };
  }, []);

  return (
    <div ref={ref} className="editor-transcript-measured-row">
      {children}
    </div>
  );
}
