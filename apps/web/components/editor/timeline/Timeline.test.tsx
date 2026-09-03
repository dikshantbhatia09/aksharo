import { fireEvent, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { PassItem } from "@montaj/edg";

import { Timeline } from "./Timeline";

import type * as React from "react";

import { renderWithProviders } from "@/test/harness";

/**
 * The initial zoom is `msPerPx = 30`, `scrollMs = 0` (`Timeline.tsx`'s
 * `useState` defaults), so pixel math for a hit test is `px = ms / 30`. Lane
 * geometry is `RULER_HEIGHT + WAVEFORM_HEIGHT + WORD_LANE_HEIGHT +
 * SEGMENT_LANE_HEIGHT + gaps` before the first pass lane
 * (`24 + 64+2 + 28+2 + 36+2 = 158`); `buildLanes` always returns four lanes
 * in order `cuts, zoom, reframe, audio`, each `PASS_LANE_HEIGHT=20` tall with
 * a 2px gap, so the cuts lane spans y in `[158, 178)`.
 */
const CUTS_LANE_Y = 158 + 10;

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
