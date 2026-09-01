import { describe, expect, it } from "vitest";

import { cutEdit } from "./edits.js";
import { buildTimeMap } from "./timemap.js";

interface ZoomKey {
  readonly tMs: number;
  readonly scale: number;
}

const key = (tMs: number, scale: number): ZoomKey => ({ tMs, scale });

/** 10 s of source, one cut removing 4–6 s. */
const map = buildTimeMap({ sourceDurationMs: 10_000, edits: [cutEdit(4000, 6000)] });

const lerp = (before: ZoomKey, after: ZoomKey, ratio: number): ZoomKey => ({
  tMs: 0,
  scale: before.scale + (after.scale - before.scale) * ratio,
});

describe("mapKeyframes", () => {
  it("returns nothing for an empty track", () => {
    expect(map.mapKeyframes([])).toEqual([]);
  });

  it("remaps a track clear of every cut", () => {
    expect(map.mapKeyframes([key(0, 1), key(1000, 1.5), key(2000, 2)])).toEqual([
      key(0, 1),
      key(1000, 1.5),
      key(2000, 2),
    ]);
  });

  it("drops keyframes strictly inside a cut", () => {
    const out = map.mapKeyframes([key(3000, 1), key(4500, 9), key(5500, 9), key(7000, 2)]);
    expect(out.map((each) => each.scale)).not.toContain(9);
  });

  it("pins the curve at both edges of a splice", () => {
    const out = map.mapKeyframes([key(0, 1), key(8000, 2)]);
    // 0 → pre-edge at 4000 → post-edge at 6000 → 8000, all on the output clock.
    expect(out).toEqual([
      { tMs: 0, scale: 1 },
      { tMs: 4000, scale: 1 },
      { tMs: 4000, scale: 2 },
      { tMs: 6000, scale: 2 },
    ]);
    // Both edge keyframes land on the splice, which is where the jump belongs.
    expect(map.toOutput(4000)).toBe(4000);
    expect(map.toOutput(6000)).toBe(4000);
  });

  it("interpolates the edge values when told how", () => {
    const out = map.mapKeyframes([key(0, 0), key(8000, 8)], { interpolate: lerp });
    expect(out).toEqual([
      { tMs: 0, scale: 0 },
      { tMs: 4000, scale: 4 },
      { tMs: 4000, scale: 6 },
      { tMs: 6000, scale: 8 },
    ]);
  });

  it("does not duplicate a keyframe already sitting on an edge", () => {
    const out = map.mapKeyframes([key(0, 1), key(4000, 3), key(6000, 4), key(8000, 5)]);
    expect(out).toEqual([
      { tMs: 0, scale: 1 },
      { tMs: 4000, scale: 3 },
      { tMs: 4000, scale: 4 },
      { tMs: 6000, scale: 5 },
    ]);
  });

  it("skips a cut the curve does not cross", () => {
    const early = map.mapKeyframes([key(7000, 1), key(8000, 2)]);
    expect(early).toHaveLength(2);
    const late = map.mapKeyframes([key(0, 1), key(1000, 2)]);
    expect(late).toHaveLength(2);
  });

  it("honours insertBoundaries: false", () => {
    const out = map.mapKeyframes([key(0, 1), key(8000, 2)], { insertBoundaries: false });
    expect(out).toEqual([
      { tMs: 0, scale: 1 },
      { tMs: 6000, scale: 2 },
    ]);
  });

  it("returns nothing when every keyframe was inside a cut", () => {
    expect(map.mapKeyframes([key(4500, 1), key(5500, 2)])).toEqual([]);
  });

  it("sorts an unordered track before mapping", () => {
    const out = map.mapKeyframes([key(2000, 3), key(1000, 2), key(0, 1)]);
    expect(out.map((each) => each.tMs)).toEqual([0, 1000, 2000]);
  });

  it("pins every splice a long curve crosses", () => {
    const many = buildTimeMap({
      sourceDurationMs: 10_000,
      edits: [cutEdit(2000, 3000), cutEdit(5000, 5500), cutEdit(8000, 9000)],
    });
    const out = many.mapKeyframes([key(0, 0), key(10_000, 10)]);
    expect(out).toHaveLength(2 + 3 * 2);
    expect(out.map((each) => each.tMs)).toEqual([0, 2000, 2000, 4000, 4000, 6500, 6500, 7500]);
  });

  it("keeps a single keyframe that is not in a cut", () => {
    expect(map.mapKeyframes([key(7000, 1)])).toEqual([{ tMs: 5000, scale: 1 }]);
  });

  it("falls back to holding when interpolate is given but the pair is coincident", () => {
    const coincident = buildTimeMap({ sourceDurationMs: 100, edits: [cutEdit(40, 60)] });
    const out = coincident.mapKeyframes([key(40, 1), key(40, 2)], { interpolate: lerp });
    expect(out.map((each) => each.scale)).toEqual([1, 2]);
  });
});
