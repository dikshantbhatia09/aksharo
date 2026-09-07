import { fireEvent, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { makeWordId } from "@montaj/edg";
import type { PassItem, Segment, Word } from "@montaj/edg";

import { Timeline } from "./Timeline";

import type * as React from "react";

import { renderWithProviders } from "@/test/harness";

/**
 * The initial zoom is `msPerPx = 30`, `scrollMs = 0` (`Timeline.tsx`'s
 * `useState` defaults), so pixel math for a hit test is `px = ms / 30`. Lane
 * geometry is `RULER_HEIGHT + THUMB_LANE_HEIGHT + WAVEFORM_HEIGHT +
 * WORD_LANE_HEIGHT + SEGMENT_LANE_HEIGHT + gaps` before the first pass lane
 * (`24 + 32+2 + 64+2 + 28+2 + 36+2 = 192`; K03 added the `THUMB_LANE_HEIGHT`
 * filmstrip lane above the waveform); `buildLanes` always returns four lanes
 * in order `cuts, zoom, reframe, audio`, each `PASS_LANE_HEIGHT=20` tall with
 * a 2px gap, so the cuts lane spans y in `[192, 212)`.
 */
const CUTS_LANE_Y = 192 + 10;

function cutItem(overrides: Partial<PassItem> = {}): PassItem {
  return {
    itemId: "01ITEM0000000000000000001",
    passId: "01PASS00000000000000000001",
    kind: "cut",
    startMs: 1_000,
    endMs: 2_000,
    state: "proposed",
    reason: "1.2s of silence",
    payload: {},
    ...overrides,
  } as PassItem;
}

function wordFixture(overrides: Partial<Word> = {}): Word {
  return {
    wid: makeWordId(0, 0),
    s: 0,
    e: 500,
    t: "word",
    ...overrides,
  } as Word;
}

function segmentFixture(overrides: Partial<Segment> = {}): Segment {
  return {
    id: "seg-a",
    seq: "a",
    startWordId: makeWordId(0, 0),
    endWordId: makeWordId(0, 0),
    startMs: 0,
    endMs: 500,
    ...overrides,
  } as Segment;
}

beforeAll(() => {
  // jsdom never lays out real geometry; the timeline sizes itself off its
  // container's `clientWidth` via a ResizeObserver this project's test setup
  // stubs to a no-op, so every element reports a fixed, generous width.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    value: 2_000,
  });
});

function renderTimeline(props: Partial<React.ComponentProps<typeof Timeline>> = {}) {
  return renderWithProviders(
    <Timeline
      words={[]}
      segments={[]}
      passItems={[cutItem()]}
      durationMs={10_000}
      playheadMs={0}
      onSeek={vi.fn()}
      onSetSegmentBounds={vi.fn()}
      {...props}
    />,
  );
}

function fireCanvasMouseEvent(type: "mousemove" | "click", x: number, y: number): void {
  const canvasEl = screen.getByTestId("timeline-canvas");
  vi.spyOn(canvasEl, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 2_000,
    bottom: 400,
    width: 2_000,
    height: 400,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  fireEvent[type === "mousemove" ? "mouseMove" : "click"](canvasEl, { clientX: x, clientY: y });
}

describe("<Timeline /> B20 lane interaction", () => {
  it("calls onHoverPassItem with the item under the pointer, and undefined off it", () => {
    const onHoverPassItem = vi.fn();
    renderTimeline({ onHoverPassItem });

    fireCanvasMouseEvent("mousemove", 1_000 / 30, CUTS_LANE_Y); // inside [1000,2000)ms
    expect(onHoverPassItem).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemId: "01ITEM0000000000000000001" }),
    );

    fireCanvasMouseEvent("mousemove", 5_000 / 30, CUTS_LANE_Y); // outside the item's range
    expect(onHoverPassItem).toHaveBeenLastCalledWith(undefined);
  });

  it("calls onSelectPassItem when the lane item is clicked", () => {
    const onSelectPassItem = vi.fn();
    renderTimeline({ onSelectPassItem });

    fireCanvasMouseEvent("click", 1_500 / 30, CUTS_LANE_Y);
    expect(onSelectPassItem).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "01ITEM0000000000000000001", kind: "cut" }),
    );
  });

  it("does not select anything when the click misses every lane item", () => {
    const onSelectPassItem = vi.fn();
    renderTimeline({ onSelectPassItem });

    fireCanvasMouseEvent("click", 9_000 / 30, CUTS_LANE_Y);
    expect(onSelectPassItem).not.toHaveBeenCalled();
  });
});

function fireCanvasPointerEvent(
  type: "pointerdown" | "pointermove" | "pointerup",
  x: number,
  y: number,
): void {
  const canvasEl = screen.getByTestId("timeline-canvas");
  vi.spyOn(canvasEl, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 2_000,
    bottom: 400,
    width: 2_000,
    height: 400,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  fireEvent[
    type === "pointerdown" ? "pointerDown" : type === "pointermove" ? "pointerMove" : "pointerUp"
  ](canvasEl, { clientX: x, clientY: y, pointerId: 1 });
}

describe("<Timeline /> B20b drag-to-adjust", () => {
  it("drags the item's end edge and emits one EditPassItem op on pointer-up", () => {
    const onEditPassItem = vi.fn();
    renderTimeline({ onEditPassItem });

    // 2000ms is the item's own end edge (px = 2000/30 ≈ 66.7).
    fireCanvasPointerEvent("pointerdown", 2_000 / 30, CUTS_LANE_Y);
    fireCanvasPointerEvent("pointermove", 3_500 / 30, CUTS_LANE_Y);
    fireCanvasPointerEvent("pointerup", 3_500 / 30, CUTS_LANE_Y);

    expect(onEditPassItem).toHaveBeenCalledTimes(1);
    const [op] = onEditPassItem.mock.calls[0] as [
      { itemId: string; startMs: number; endMs: number },
    ];
    expect(op.itemId).toBe("01ITEM0000000000000000001");
    expect(op.startMs).toBe(1_000);
    expect(op.endMs).toBeCloseTo(3_500, -1);
  });

  it("never emits when the pointer never lands on an edge", () => {
    const onEditPassItem = vi.fn();
    renderTimeline({ onEditPassItem });

    fireCanvasPointerEvent("pointerdown", 1_500 / 30, CUTS_LANE_Y); // the item's body, not an edge
    fireCanvasPointerEvent("pointermove", 3_500 / 30, CUTS_LANE_Y);
    fireCanvasPointerEvent("pointerup", 3_500 / 30, CUTS_LANE_Y);

    expect(onEditPassItem).not.toHaveBeenCalled();
  });

  it("clamps the drag against a neighbouring accepted item of the same kind", () => {
    const onEditPassItem = vi.fn();
    const neighbour = cutItem({
      itemId: "01ITEM0000000000000000002",
      startMs: 4_000,
      endMs: 5_000,
      state: "accepted",
    });
    renderTimeline({ passItems: [cutItem(), neighbour], onEditPassItem });

    fireCanvasPointerEvent("pointerdown", 2_000 / 30, CUTS_LANE_Y);
    fireCanvasPointerEvent("pointermove", 4_500 / 30, CUTS_LANE_Y);
    fireCanvasPointerEvent("pointerup", 4_500 / 30, CUTS_LANE_Y);

    expect(onEditPassItem).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "01ITEM0000000000000000001",
        startMs: 1_000,
        endMs: 4_000,
      }),
    );
  });
});

/** The word lane's own Y-band: `wordTop` (124, see the geometry note above) + a few px. */
const WORD_LANE_Y = 124 + 10;

describe("<Timeline /> K03 WORD/LINE granularity", () => {
  const words: Word[] = [
    wordFixture({ wid: makeWordId(0, 0), s: 0, e: 500, t: "hello" }),
    wordFixture({ wid: makeWordId(0, 1), s: 600, e: 1_200, t: "world" }),
    wordFixture({ wid: makeWordId(0, 2), s: 3_000, e: 3_600, t: "far" }),
  ];
  const segments: Segment[] = [
    segmentFixture({
      id: "seg-a",
      startWordId: makeWordId(0, 0),
      endWordId: makeWordId(0, 1),
      startMs: 0,
      endMs: 1_200,
    }),
    segmentFixture({
      id: "seg-b",
      startWordId: makeWordId(0, 2),
      endWordId: makeWordId(0, 2),
      startMs: 3_000,
      endMs: 3_600,
    }),
  ];

  it("defaults to WORD, and toggling never touches the underlying words or segments", () => {
    const onSetWordTiming = vi.fn();
    const onSetSegmentBounds = vi.fn();
    renderTimeline({ words, segments, onSetWordTiming, onSetSegmentBounds });

    expect(screen.getByTestId("timeline-granularity-word")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("timeline-granularity-line")).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    fireEvent.click(screen.getByTestId("timeline-granularity-line"));
    expect(screen.getByTestId("timeline-granularity-line")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("timeline-granularity-word"));
    expect(screen.getByTestId("timeline-granularity-word")).toHaveAttribute("aria-pressed", "true");

    // Toggling granularity is purely a render switch — it never emits an op.
    expect(onSetWordTiming).not.toHaveBeenCalled();
    expect(onSetSegmentBounds).not.toHaveBeenCalled();
  });

  it("WORD granularity: a click in the caption lane selects the word under it", () => {
    const onSelectWord = vi.fn();
    const onSelectSegment = vi.fn();
    const onSeek = vi.fn();
    renderTimeline({ words, segments, onSelectWord, onSelectSegment, onSeek });

    // Word/segment selection is resolved on `pointerdown` (`Timeline.tsx`'s
    // `onPointerDown`), not the canvas's `click` handler — that one only
    // covers the read-only pass-item lanes (see the B20 describe block above).
    fireCanvasPointerEvent("pointerdown", 100 / 30, WORD_LANE_Y); // inside "hello", [0,500)ms
    expect(onSelectWord).toHaveBeenCalledWith("seg-a", makeWordId(0, 0));
    expect(onSeek).toHaveBeenCalledWith(0);
  });

  it("LINE granularity: a click in the caption lane selects the segment, not a word", () => {
    const onSelectWord = vi.fn();
    const onSelectSegment = vi.fn();
    const onSeek = vi.fn();
    renderTimeline({ words, segments, onSelectWord, onSelectSegment, onSeek });

    fireEvent.click(screen.getByTestId("timeline-granularity-line"));
    fireCanvasPointerEvent("pointerdown", 100 / 30, WORD_LANE_Y); // still inside seg-a's [0,1200)ms

    expect(onSelectSegment).toHaveBeenCalledWith("seg-a");
    expect(onSeek).toHaveBeenCalledWith(0);
    expect(onSelectWord).not.toHaveBeenCalled();
  });
});

describe("<Timeline /> K03 search box", () => {
  const words: Word[] = [
    wordFixture({ wid: makeWordId(0, 0), s: 0, e: 500, t: "hello" }),
    wordFixture({ wid: makeWordId(0, 1), s: 600, e: 1_200, t: "zzzunique" }),
  ];

  it("reports a live match count, and clearing the query removes it", () => {
    renderTimeline({ words });

    expect(screen.queryByTestId("timeline-search-count")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("timeline-search"), { target: { value: "uniq" } });
    expect(screen.getByTestId("timeline-search-count")).toHaveTextContent("1 match");

    fireEvent.click(screen.getByTestId("timeline-search-clear"));
    expect(screen.queryByTestId("timeline-search-count")).not.toBeInTheDocument();
  });

  it("is case-insensitive and counts every match", () => {
    renderTimeline({
      words: [...words, wordFixture({ wid: makeWordId(0, 2), s: 1_300, e: 1_800, t: "UNIQUELY" })],
    });

    fireEvent.change(screen.getByTestId("timeline-search"), { target: { value: "unique" } });
    expect(screen.getByTestId("timeline-search-count")).toHaveTextContent("2 matches");
  });

  it("jumps the viewport so the first match is centred, then a click lands on it", () => {
    const farWord = wordFixture({ wid: makeWordId(0, 9), s: 200_000, e: 200_800, t: "farword" });
    const owner = segmentFixture({
      id: "seg-far",
      startWordId: farWord.wid,
      endWordId: farWord.wid,
      startMs: 200_000,
      endMs: 200_800,
    });
    const onSelectWord = vi.fn();
    const onSeek = vi.fn();
    renderTimeline({
      words: [...words, farWord],
      segments: [owner],
      durationMs: 300_000,
      onSelectWord,
      onSeek,
    });

    // Before searching, ms=200_000 is far outside the initial [0, 60_000)ms
    // view (msPerPx=30, widthPx=2000) — nothing is at px=1000 yet.
    fireCanvasPointerEvent("pointerdown", 1_000, WORD_LANE_Y);
    expect(onSeek).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("timeline-search"), { target: { value: "farword" } });

    // `scrollMs` should now centre the match: 200_000 - (2000/2)*30 = 170_000,
    // putting its start back at px = (200_000-170_000)/30 = 1000.
    fireCanvasPointerEvent("pointerdown", 1_000, WORD_LANE_Y);
    expect(onSelectWord).toHaveBeenCalledWith("seg-far", farWord.wid);
    expect(onSeek).toHaveBeenCalledWith(200_000);
  });

  it("clearing the search restores the normal, unhighlighted view (no match count, no crash)", () => {
    renderTimeline({ words });
    fireEvent.change(screen.getByTestId("timeline-search"), { target: { value: "unique" } });
    expect(screen.getByTestId("timeline-search-count")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("timeline-search"), { target: { value: "" } });
    expect(screen.queryByTestId("timeline-search-count")).not.toBeInTheDocument();
    expect(screen.getByTestId("timeline-search")).toHaveValue("");
  });
});

describe("<Timeline /> K03 Caption Tools dropdown", () => {
  const resegmentDefaultParams = {
    maxChars: 32,
    maxLines: 2,
    minMs: 800,
    maxMs: 4_500,
    dropFillers: false,
  };

  it("does not render when no bulk-action handlers are passed", () => {
    renderTimeline();
    expect(screen.queryByTestId("timeline-caption-tools-trigger")).not.toBeInTheDocument();
  });

  it("Merge short / Split long / Resegment call the exact props the transcript column's BulkActionsBar calls — same component, not a reimplementation", () => {
    const onMergeShortCaptions = vi.fn();
    const onSplitLongCaptions = vi.fn();
    const onResegmentCaptions = vi.fn();
    renderTimeline({
      onMergeShortCaptions,
      onSplitLongCaptions,
      onResegmentCaptions,
      resegmentDefaultParams,
    });

    // Merge short.
    fireEvent.click(screen.getByTestId("timeline-caption-tools-trigger"));
    const menu1 = screen.getByTestId("timeline-caption-tools-menu");
    expect(within(menu1).getByTestId("bulk-actions-bar")).toBeInTheDocument();
    fireEvent.click(within(menu1).getByTestId("bulk-merge-short"));
    expect(onMergeShortCaptions).toHaveBeenCalledTimes(1);
    // The dropdown closes itself after an action, mirroring a typical menu.
    expect(screen.queryByTestId("timeline-caption-tools-menu")).not.toBeInTheDocument();

    // Split long.
    fireEvent.click(screen.getByTestId("timeline-caption-tools-trigger"));
    const menu2 = screen.getByTestId("timeline-caption-tools-menu");
    fireEvent.click(within(menu2).getByTestId("bulk-split-long"));
    expect(onSplitLongCaptions).toHaveBeenCalledTimes(1);

    // Resegment — opens the real `BulkActionsBar` dialog, same testids and
    // same param shape as the transcript column's own copy.
    fireEvent.click(screen.getByTestId("timeline-caption-tools-trigger"));
    const menu3 = screen.getByTestId("timeline-caption-tools-menu");
    fireEvent.click(within(menu3).getByTestId("bulk-resegment-open"));
    expect(screen.getByTestId("resegment-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("resegment-confirm"));
    expect(onResegmentCaptions).toHaveBeenCalledWith(resegmentDefaultParams);
  });

  it("closes on Escape without firing any action", () => {
    const onMergeShortCaptions = vi.fn();
    const onSplitLongCaptions = vi.fn();
    const onResegmentCaptions = vi.fn();
    renderTimeline({ onMergeShortCaptions, onSplitLongCaptions, onResegmentCaptions });

    fireEvent.click(screen.getByTestId("timeline-caption-tools-trigger"));
    expect(screen.getByTestId("timeline-caption-tools-menu")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("timeline-caption-tools-menu")).not.toBeInTheDocument();
    expect(onMergeShortCaptions).not.toHaveBeenCalled();
    expect(onSplitLongCaptions).not.toHaveBeenCalled();
    expect(onResegmentCaptions).not.toHaveBeenCalled();
  });
});

describe("<Timeline /> K03 thumbnail track", () => {
  it("accepts thumbnail URLs and renders without error alongside the other lanes", () => {
    const { unmount } = renderTimeline({
      thumbnails: [
        "https://cdn.test/thumb-0.jpg",
        "https://cdn.test/thumb-1.jpg",
        "https://cdn.test/thumb-2.jpg",
      ],
      durationMs: 30_000,
    });
    expect(screen.getByTestId("timeline-canvas")).toBeInTheDocument();
    unmount();
  });

  it("renders with no thumbnails (audio-only media) without error", () => {
    renderTimeline({ thumbnails: [] });
    expect(screen.getByTestId("timeline-canvas")).toBeInTheDocument();
  });
});
