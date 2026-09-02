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

import { SegmentCard } from "./SegmentCard";
import { type DisplayScript } from "./WordChip";

import { VirtualList } from "@/lib/edg/virtual-list";
import { cn } from "@/lib/utils";

export interface SpeakerInfo {
  readonly name?: string;
  readonly color?: string;
}

export interface TranscriptListProps {
  readonly segments: readonly Segment[];
  readonly wordsOf: (segment: Segment) => readonly Word[];
  readonly script: DisplayScript;
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
  readonly className?: string;
}

const DEFAULT_ROW_HEIGHT = 64;
const OVERSCAN = 8;

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

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      data-testid="transcript-list"
      className={cn("h-full overflow-y-auto overscroll-contain", className)}
    >
      <div style={{ height: listRef.current.totalHeight(), position: "relative" }}>
        <div
          style={{ transform: `translateY(${String(range.offsetTop)}px)` }}
          className="flex flex-col"
        >
          {visible.map((segment, offset) => {
            const index = range.startIndex + offset;
            return (
              <MeasuredRow
                key={segment.id}
                onHeight={(height) => {
                  listRef.current.setHeight(index, height);
                }}
              >
                <SegmentCard
                  segment={segment}
                  words={wordsOf(segment)}
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

/** Reports its own rendered height, so the virtualiser can use a real number instead of an estimate. */
function MeasuredRow({
  children,
  onHeight,
}: {
  children: React.ReactNode;
  onHeight: (height: number) => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    // The spacing between rows lives *inside* the measured element (padding,
    // not a flex `gap`), so the height fed to `VirtualList` already accounts
    // for it — a `gap` on the scrolling container would drift the prefix sums
    // by one gap per row over a long list.
    onHeight(element.getBoundingClientRect().height);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) onHeight(entry.contentRect.height);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={ref} className="pb-1.5">
      {children}
    </div>
  );
}
