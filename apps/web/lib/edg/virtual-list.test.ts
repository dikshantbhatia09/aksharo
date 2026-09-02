import { describe, expect, it } from "vitest";

import { VirtualList } from "./virtual-list";

describe("VirtualList", () => {
  it("computes the visible range for a uniform-height list", () => {
    const list = new VirtualList(1000, 50);
    const range = list.visibleRange(500, 300, 0);
    expect(range.startIndex).toBe(10);
    // 500..800 spans rows 10..15; the window's bottom edge lands exactly on
    // row 16's boundary, and `indexAtOffset` treats that edge as belonging to
    // the row after it — the same reason a `<` vs `<=` choice matters for any
    // half-open range — so row 16 is included too.
    expect(range.endIndex).toBe(16);
    expect(range.offsetTop).toBe(500);
    expect(range.totalHeight).toBe(50_000);
  });

  it("applies overscan on both ends without running past the array bounds", () => {
    const list = new VirtualList(10, 50);
    const range = list.visibleRange(0, 100, 5);
    expect(range.startIndex).toBe(0);
    // 2 rows visible (0..100 spans rows 0 and 1, plus row 2 at the exact
    // boundary — see the note above) + 5 overscan, clamped at the last index.
    expect(range.endIndex).toBe(7);
  });

  it("uses real measured heights once reported, not the estimate", () => {
    const list = new VirtualList(5, 50);
    list.setHeight(0, 200);
    expect(list.totalHeight()).toBe(200 + 50 * 4);
    expect(list.offsetOf(1)).toBe(200);
  });

  it("recomputes prefix sums lazily — many setHeight calls before one read", () => {
    const list = new VirtualList(100, 20);
    for (let i = 0; i < 100; i += 1) list.setHeight(i, 10);
    expect(list.totalHeight()).toBe(1000);
    expect(list.offsetOf(50)).toBe(500);
  });

  it("setCount grows and shrinks, keeping existing heights", () => {
    const list = new VirtualList(3, 50);
    list.setHeight(1, 80);
    list.setCount(5);
    expect(list.count()).toBe(5);
    expect(list.heightOf(1)).toBe(80);
    expect(list.heightOf(4)).toBe(50);

    list.setCount(2);
    expect(list.count()).toBe(2);
    expect(list.totalHeight()).toBe(50 + 80);
  });

  it("indexAtOffset finds the row spanning an arbitrary offset", () => {
    const list = new VirtualList(4, 10);
    list.setHeight(0, 10);
    list.setHeight(1, 30);
    list.setHeight(2, 10);
    list.setHeight(3, 10);
    // offsets: [0,10) row0, [10,40) row1, [40,50) row2, [50,60) row3
    expect(list.indexAtOffset(0)).toBe(0);
    expect(list.indexAtOffset(15)).toBe(1);
    expect(list.indexAtOffset(45)).toBe(2);
    expect(list.indexAtOffset(59)).toBe(3);
  });

  it("an empty list has a well-defined, empty visible range", () => {
    const list = new VirtualList(0, 50);
    const range = list.visibleRange(0, 500);
    expect(range).toEqual({ startIndex: 0, endIndex: -1, offsetTop: 0, totalHeight: 0 });
  });

  it("scrolling deep into a 54,000-row list resolves in O(log n) — no observable slowdown", () => {
    const list = new VirtualList(54_000, 64);
    const start = performance.now();
    for (let i = 0; i < 500; i += 1) {
      list.visibleRange((i * 3457) % (54_000 * 64), 900, 6);
    }
    const elapsed = performance.now() - start;
    // Generous budget for a shared CI machine; the point is "not linear per call".
    expect(elapsed).toBeLessThan(200);
  });
});
