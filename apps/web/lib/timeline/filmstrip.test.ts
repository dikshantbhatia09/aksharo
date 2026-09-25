import { describe, expect, it } from "vitest";

import { coverCrop, filmstripTiles, MIN_TILE_WIDTH_PX } from "./filmstrip";

const VERTICAL = 9 / 16;
const HEIGHT = 37;

function tiles(overrides: Partial<Parameters<typeof filmstripTiles>[0]> = {}) {
  const viewport = { scrollMs: 0, msPerPx: 30, widthPx: 800 };
  return filmstripTiles({
    durationMs: 16_183,
    thumbCount: 10,
    aspect: VERTICAL,
    tileHeightPx: HEIGHT,
    viewport,
    startMs: 0,
    endMs: viewport.widthPx * viewport.msPerPx,
    ...overrides,
  });
}

describe("filmstripTiles", () => {
  // 2026-09-25: each thumbnail was stretched over a tenth of the timeline —
  // a 9:16 frame drawn ~9x too wide.
  it("lays every full tile out at the video's own aspect ratio", () => {
    const all = tiles();
    for (const tile of all.slice(0, -1)) {
      expect(tile.w / HEIGHT).toBeCloseTo(VERTICAL, 5);
    }
  });

  it("covers the whole clip, edge to edge, with no gaps or overlaps", () => {
    const all = tiles();
    expect(all[0]?.x).toBe(0);
    for (let i = 1; i < all.length; i += 1) {
      const previous = all.at(i - 1)!;
      expect(all.at(i)!.x).toBeCloseTo(previous.x + previous.w, 6);
    }
    const last = all.at(-1)!;
    // Ends exactly at the media's end, the last tile cut short rather than overhanging.
    expect(last.x + last.w).toBeCloseTo(16_183 / 30, 6);
  });

  it("shows the frames in order, from the first thumbnail to the last", () => {
    const indices = tiles().map((tile) => tile.thumbIndex);
    expect(indices[0]).toBe(0);
    expect(indices.at(-1)).toBe(9);
    for (let i = 1; i < indices.length; i += 1) {
      expect(indices.at(i)!).toBeGreaterThanOrEqual(indices.at(i - 1)!);
    }
  });

  it("produces only the tiles on screen, however long the media", () => {
    const viewport = { scrollMs: 600_000, msPerPx: 10, widthPx: 800 };
    const all = tiles({
      durationMs: 3_600_000,
      viewport,
      startMs: viewport.scrollMs,
      endMs: viewport.scrollMs + viewport.widthPx * viewport.msPerPx,
    });
    expect(all.length).toBeLessThanOrEqual(Math.ceil(800 / (HEIGHT * VERTICAL)) + 1);
    expect(all[0]!.x).toBeLessThanOrEqual(0);
    expect(all.at(-1)!.x).toBeLessThan(800);
  });

  it("keeps tiles anchored to time, so they scroll with the video", () => {
    const at = (scrollMs: number) =>
      tiles({ viewport: { scrollMs, msPerPx: 30, widthPx: 800 }, startMs: scrollMs });
    const before = at(0).find((tile) => tile.x > 100)!;
    const after = at(300).find((tile) => tile.thumbIndex === before.thumbIndex && tile.x > 90)!;
    expect(before.x - after.x).toBeCloseTo(10, 6); // 300 ms at 30 ms/px
  });

  it("never draws a tile narrower than a readable frame", () => {
    const all = tiles({ aspect: 0.1 });
    expect(all[0]!.w).toBe(MIN_TILE_WIDTH_PX);
  });

  it("falls back to a landscape frame for a nonsense aspect", () => {
    expect(tiles({ aspect: Number.NaN })[0]!.w).toBeCloseTo(HEIGHT * (16 / 9), 6);
  });

  it("draws nothing without media or thumbnails", () => {
    expect(tiles({ durationMs: 0 })).toEqual([]);
    expect(tiles({ thumbCount: 0 })).toEqual([]);
  });
});

describe("coverCrop", () => {
  it("takes a window of the frame with the tile's own shape, centred", () => {
    const crop = coverCrop({ width: 320, height: 569 }, 20.8, 37);
    expect(crop.sw / crop.sh).toBeCloseTo(20.8 / 37, 5);
    expect(crop.sx).toBeCloseTo((320 - crop.sw) / 2, 6);
    expect(crop.sy).toBeCloseTo((569 - crop.sh) / 2, 6);
  });

  it("crops a short last tile instead of squashing the frame into it", () => {
    const crop = coverCrop({ width: 320, height: 569 }, 8, 37);
    expect(crop.sh).toBe(569);
    expect(crop.sw / crop.sh).toBeCloseTo(8 / 37, 5);
  });
});
