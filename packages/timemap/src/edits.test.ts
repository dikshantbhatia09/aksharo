import { describe, expect, it } from "vitest";

import { cutEdit, flattenEdits, holdEdit, insideCuts, normaliseEdits, speedEdit } from "./edits.js";
import { isTimeMapError, TimeMapError } from "./errors.js";

const options = { sourceDurationMs: 10_000 };

describe("normaliseEdits — cuts", () => {
  it("orders, merges overlapping and merges touching cuts", () => {
    const { cuts } = normaliseEdits(
      [cutEdit(3000, 4000), cutEdit(1000, 2000), cutEdit(1500, 2500), cutEdit(4000, 4500)],
      options,
    );
    expect(cuts).toEqual([
      { kind: "cut", startMs: 1000, endMs: 2500 },
      { kind: "cut", startMs: 3000, endMs: 4500 },
    ]);
  });

  it("swallows a nested cut", () => {
    const { cuts } = normaliseEdits([cutEdit(1000, 5000), cutEdit(2000, 3000)], options);
    expect(cuts).toEqual([{ kind: "cut", startMs: 1000, endMs: 5000 }]);
  });

  it("drops empty cuts and clips cuts that run past the media", () => {
    const { cuts } = normaliseEdits(
      [cutEdit(500, 500), cutEdit(9000, 99_000), cutEdit(20_000, 30_000)],
      options,
    );
    expect(cuts).toEqual([{ kind: "cut", startMs: 9000, endMs: 10_000 }]);
  });

  it("rejects a backwards or fractional or negative cut", () => {
    expect(() => normaliseEdits([cutEdit(500, 400)], options)).toThrowError(TimeMapError);
    expect(() => normaliseEdits([cutEdit(0.5, 400)], options)).toThrowError(TimeMapError);
    expect(() => normaliseEdits([cutEdit(-1, 400)], options)).toThrowError(TimeMapError);
    try {
      normaliseEdits([cutEdit(500, 400)], options);
    } catch (error) {
      expect(isTimeMapError(error, "invalid-edit")).toBe(true);
      expect((error as TimeMapError).detail).toMatchObject({ startMs: 500, endMs: 400 });
    }
  });

  it("rejects an unknown edit kind", () => {
    expect(() =>
      normaliseEdits([{ kind: "warp", startMs: 0, endMs: 1 } as never], options),
    ).toThrowError(TimeMapError);
  });
});

describe("normaliseEdits — speed", () => {
  it("drops a 1x range and clips a range that a cut eats into", () => {
    const { speeds } = normaliseEdits(
      [speedEdit(0, 1000, 1), speedEdit(2000, 6000, 2), cutEdit(3000, 4000)],
      options,
    );
    expect(speeds).toEqual([
      { kind: "speed", startMs: 2000, endMs: 3000, factor: 2 },
      { kind: "speed", startMs: 4000, endMs: 6000, factor: 2 },
    ]);
  });

  it("lets a cut swallow a speed range entirely", () => {
    const { speeds } = normaliseEdits([speedEdit(2000, 3000, 0.5), cutEdit(1000, 5000)], options);
    expect(speeds).toEqual([]);
  });

  it("clips a speed range overlapping the cut on one side only", () => {
    const { speeds } = normaliseEdits([speedEdit(2000, 4000, 2), cutEdit(1000, 3000)], options);
    expect(speeds).toEqual([{ kind: "speed", startMs: 3000, endMs: 4000, factor: 2 }]);
  });

  it("rejects overlapping speed ranges instead of guessing", () => {
    expect(() =>
      normaliseEdits([speedEdit(0, 2000, 2), speedEdit(1000, 3000, 0.5)], options),
    ).toThrowError(TimeMapError);
    try {
      normaliseEdits([speedEdit(0, 2000, 2), speedEdit(1000, 3000, 0.5)], options);
    } catch (error) {
      expect(isTimeMapError(error, "overlapping-speed")).toBe(true);
    }
  });

  it("allows touching speed ranges", () => {
    const { speeds } = normaliseEdits([speedEdit(0, 2000, 2), speedEdit(2000, 3000, 0.5)], options);
    expect(speeds).toHaveLength(2);
  });

  it("rejects a factor that is not a positive finite number", () => {
    for (const factor of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => normaliseEdits([speedEdit(0, 100, factor)], options)).toThrowError(TimeMapError);
    }
  });
});

describe("normaliseEdits — holds", () => {
  it("keeps holds at cut edges and drops the ones strictly inside", () => {
    const { holds } = normaliseEdits(
      [cutEdit(2000, 3000), holdEdit(2000, 100), holdEdit(2500, 100), holdEdit(3000, 100)],
      options,
    );
    expect(holds.map((hold) => hold.atMs)).toEqual([2000, 3000]);
  });

  it("drops zero-length holds and clamps one past the end", () => {
    const { holds } = normaliseEdits([holdEdit(500, 0), holdEdit(99_000, 250)], options);
    expect(holds).toEqual([{ kind: "hold", atMs: 10_000, durationMs: 250 }]);
  });

  it("rejects a negative or fractional hold", () => {
    expect(() => normaliseEdits([holdEdit(-1, 100)], options)).toThrowError(TimeMapError);
    expect(() => normaliseEdits([holdEdit(100, 1.5)], options)).toThrowError(TimeMapError);
  });
});

describe("normaliseEdits — frame snapping", () => {
  it("snaps cut edges to the nearest frame when asked", () => {
    const { cuts } = normaliseEdits([cutEdit(1010, 2030)], {
      ...options,
      fps: 25,
      snapCutsToFrames: true,
    });
    expect(cuts).toEqual([{ kind: "cut", startMs: 1000, endMs: 2040 }]);
  });

  it("drops a cut shorter than a frame once both edges snap to the same boundary", () => {
    const { cuts } = normaliseEdits([cutEdit(1001, 1002)], {
      ...options,
      fps: 25,
      snapCutsToFrames: true,
    });
    expect(cuts).toEqual([]);
  });

  it("leaves cuts alone without the option", () => {
    const { cuts } = normaliseEdits([cutEdit(1010, 2030)], { ...options, fps: 25 });
    expect(cuts).toEqual([{ kind: "cut", startMs: 1010, endMs: 2030 }]);
  });

  it("refuses to snap without an fps", () => {
    expect(() =>
      normaliseEdits([cutEdit(0, 10)], { ...options, snapCutsToFrames: true }),
    ).toThrowError(TimeMapError);
    try {
      normaliseEdits([], { ...options, snapCutsToFrames: true });
    } catch (error) {
      expect(isTimeMapError(error, "missing-fps")).toBe(true);
    }
  });

  it("rejects a bad fps even when not snapping", () => {
    expect(() => normaliseEdits([], { ...options, fps: 0 })).toThrowError(TimeMapError);
  });
});

describe("insideCuts", () => {
  const cuts = [cutEdit(1000, 2000), cutEdit(4000, 5000), cutEdit(8000, 9000)];

  it("is true only strictly inside a cut", () => {
    expect(insideCuts(cuts, 999)).toBe(false);
    expect(insideCuts(cuts, 1000)).toBe(false);
    expect(insideCuts(cuts, 1500)).toBe(true);
    expect(insideCuts(cuts, 2000)).toBe(false);
    expect(insideCuts(cuts, 8500)).toBe(true);
    expect(insideCuts(cuts, 9500)).toBe(false);
    expect(insideCuts([], 5)).toBe(false);
  });
});

describe("flattenEdits", () => {
  it("orders by source time with holds first at a shared instant", () => {
    const normalised = normaliseEdits(
      [cutEdit(2000, 3000), holdEdit(2000, 100), speedEdit(0, 1000, 2)],
      options,
    );
    expect(flattenEdits(normalised)).toEqual([
      { kind: "speed", startMs: 0, endMs: 1000, factor: 2 },
      { kind: "hold", atMs: 2000, durationMs: 100 },
      { kind: "cut", startMs: 2000, endMs: 3000 },
    ]);
  });
});
