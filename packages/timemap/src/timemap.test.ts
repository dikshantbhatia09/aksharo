import { describe, expect, it } from "vitest";

import { cutEdit, holdEdit, speedEdit } from "./edits.js";
import { isTimeMapError, TimeMapError } from "./errors.js";
import { buildTimeMap } from "./timemap.js";

/** 10 s of source with two cuts: 2–3 s and 6–6.5 s. Output is 8.5 s. */
const twoCuts = () =>
  buildTimeMap({ sourceDurationMs: 10_000, edits: [cutEdit(2000, 3000), cutEdit(6000, 6500)] });

describe("buildTimeMap", () => {
  it("maps identity with no edits", () => {
    const map = buildTimeMap({ sourceDurationMs: 5000 });
    expect(map.outputDurationMs).toBe(5000);
    expect(map.spans).toHaveLength(1);
    for (const ms of [0, 1, 2499, 5000]) {
      expect(map.toOutput(ms)).toBe(ms);
      expect(map.toSource(ms)).toBe(ms);
    }
  });

  it("accepts a zero-length source", () => {
    const map = buildTimeMap({ sourceDurationMs: 0 });
    expect(map.outputDurationMs).toBe(0);
    expect(map.spans).toEqual([]);
    expect(map.toOutput(0)).toBe(0);
    expect(map.toSource(0)).toBe(0);
    expect(map.isInsideCut(0)).toBe(false);
    expect(map.mapRange(0, 0)).toEqual([]);
    expect(map.locateSource(50)).toMatchObject({ sourceMs: 0, outputMs: 0, clamped: true });
    expect(map.locateOutput(50)).toMatchObject({ outputMs: 0, sourceMs: 0, clamped: true });
  });

  it("rejects a duration that is not whole, finite and non-negative", () => {
    for (const sourceDurationMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildTimeMap({ sourceDurationMs })).toThrowError(TimeMapError);
    }
    try {
      buildTimeMap({ sourceDurationMs: -1 });
    } catch (error) {
      expect(isTimeMapError(error, "invalid-duration")).toBe(true);
    }
    expect(() => buildTimeMap({ sourceDurationMs: "10" as never })).toThrowError(TimeMapError);
  });

  it("rejects a bad fps up front", () => {
    expect(() => buildTimeMap({ sourceDurationMs: 10, fps: -1 })).toThrowError(TimeMapError);
  });

  it("is frozen and exposes its normalised edits", () => {
    const map = twoCuts();
    expect(Object.isFrozen(map)).toBe(true);
    expect(Object.isFrozen(map.spans)).toBe(true);
    expect(map.cuts).toEqual([
      { kind: "cut", startMs: 2000, endMs: 3000 },
      { kind: "cut", startMs: 6000, endMs: 6500 },
    ]);
    expect(map.speeds).toEqual([]);
    expect(map.holds).toEqual([]);
    expect(map.edits).toEqual(map.cuts);
    expect(map.fps).toBeUndefined();
  });

  it("keeps total output length = source length − Σ cuts", () => {
    expect(twoCuts().outputDurationMs).toBe(10_000 - 1000 - 500);
  });
});

describe("toOutput — boundary semantics", () => {
  const map = twoCuts();

  it.each([
    ["retained before the first cut", 0, 0],
    ["one ms before the cut", 1999, 1999],
    ["the cut start — the splice", 2000, 2000],
    ["the cut end — the same splice", 3000, 2000],
    ["one ms after the cut", 3001, 2001],
    ["the second cut start", 6000, 5000],
    ["the second cut end", 6500, 5000],
    ["the last source instant", 10_000, 8500],
  ])("%s", (_label, sourceMs, expected) => {
    expect(map.toOutput(sourceMs)).toBe(expected);
  });

  it("answers null strictly inside a cut, and only there", () => {
    expect(map.toOutput(2001)).toBeNull();
    expect(map.toOutput(2500)).toBeNull();
    expect(map.toOutput(2999)).toBeNull();
    expect(map.toOutput(2000)).not.toBeNull();
    expect(map.toOutput(3000)).not.toBeNull();
    expect(map.isInsideCut(2500)).toBe(true);
    expect(map.isInsideCut(2000)).toBe(false);
    expect(map.isInsideCut(3000)).toBe(false);
  });

  it("clamps out-of-range input and says so", () => {
    expect(map.toOutput(-5000)).toBe(0);
    expect(map.toOutput(999_999)).toBe(8500);
    expect(map.locateSource(-5000)).toEqual({
      sourceMs: 0,
      outputMs: 0,
      insideCut: false,
      clamped: true,
    });
    expect(map.locateSource(500).clamped).toBe(false);
  });

  it("reports the splice for an instant inside a cut", () => {
    expect(map.locateSource(2500)).toEqual({
      sourceMs: 2500,
      outputMs: 2000,
      insideCut: true,
      clamped: false,
    });
  });

  it("rejects a non-finite time", () => {
    expect(() => map.toOutput(Number.NaN)).toThrowError(TimeMapError);
    expect(() => map.toOutput(Number.POSITIVE_INFINITY)).toThrowError(TimeMapError);
    try {
      map.toOutput(Number.NaN);
    } catch (error) {
      expect(isTimeMapError(error, "invalid-time")).toBe(true);
    }
  });
});

describe("toSource — the inverse used for scrubbing", () => {
  const map = twoCuts();

  it.each([
    ["the start", 0, 0],
    ["just before the splice", 1999, 1999],
    ["the splice — the frame after the cut", 2000, 3000],
    ["just after the splice", 2001, 3001],
    ["the second splice", 5000, 6500],
    ["the end", 8500, 10_000],
  ])("%s", (_label, outputMs, expected) => {
    expect(map.toSource(outputMs)).toBe(expected);
  });

  it("clamps out-of-range input and says so", () => {
    expect(map.toSource(-1)).toBe(0);
    expect(map.toSource(99_999)).toBe(10_000);
    expect(map.locateOutput(99_999)).toEqual({
      outputMs: 8500,
      sourceMs: 10_000,
      held: false,
      clamped: true,
    });
  });

  it("rejects a non-finite time", () => {
    expect(() => map.toSource(Number.NaN)).toThrowError(TimeMapError);
  });
});

describe("cuts at the edges", () => {
  it("handles a cut at 0", () => {
    const map = buildTimeMap({ sourceDurationMs: 1000, edits: [cutEdit(0, 200)] });
    expect(map.outputDurationMs).toBe(800);
    expect(map.toOutput(0)).toBe(0);
    expect(map.toOutput(100)).toBeNull();
    expect(map.toOutput(200)).toBe(0);
    expect(map.toSource(0)).toBe(200);
  });

  it("handles a cut at the end", () => {
    const map = buildTimeMap({ sourceDurationMs: 1000, edits: [cutEdit(800, 1000)] });
    expect(map.outputDurationMs).toBe(800);
    expect(map.toOutput(800)).toBe(800);
    expect(map.toOutput(900)).toBeNull();
    expect(map.toOutput(1000)).toBe(800);
    expect(map.toSource(800)).toBe(800);
  });

  it("handles a cut that removes everything", () => {
    const map = buildTimeMap({ sourceDurationMs: 1000, edits: [cutEdit(0, 1000)] });
    expect(map.outputDurationMs).toBe(0);
    expect(map.toOutput(0)).toBe(0);
    expect(map.toOutput(500)).toBeNull();
    expect(map.toOutput(1000)).toBe(0);
    expect(map.toSource(0)).toBe(0);
    expect(map.mapRange(0, 1000)).toEqual([]);
  });

  it("treats adjacent cuts as one splice", () => {
    const map = buildTimeMap({
      sourceDurationMs: 1000,
      edits: [cutEdit(200, 300), cutEdit(300, 400)],
    });
    expect(map.cuts).toHaveLength(1);
    expect(map.spans.filter((span) => span.kind === "cut")).toHaveLength(1);
    expect(map.toOutput(250)).toBeNull();
    expect(map.toOutput(350)).toBeNull();
    expect(map.toOutput(400)).toBe(200);
    expect(map.outputDurationMs).toBe(800);
  });
});

describe("speed edits", () => {
  it("halves the output of a 2x range and doubles a 0.5x range", () => {
    const fast = buildTimeMap({ sourceDurationMs: 1000, edits: [speedEdit(200, 600, 2)] });
    expect(fast.outputDurationMs).toBe(200 + 200 + 400);
    expect(fast.toOutput(400)).toBe(300);
    expect(fast.toSource(300)).toBe(400);

    const slow = buildTimeMap({ sourceDurationMs: 1000, edits: [speedEdit(200, 600, 0.5)] });
    expect(slow.outputDurationMs).toBe(200 + 800 + 400);
    expect(slow.toOutput(400)).toBe(600);
    expect(slow.toSource(600)).toBe(400);
  });

  it("lets a cut win inside a speed range", () => {
    const map = buildTimeMap({
      sourceDurationMs: 1000,
      edits: [speedEdit(0, 1000, 2), cutEdit(400, 600)],
    });
    // 800 ms of retained source at 2x.
    expect(map.outputDurationMs).toBe(400);
    expect(map.toOutput(500)).toBeNull();
    expect(map.toOutput(400)).toBe(200);
    expect(map.toOutput(600)).toBe(200);
  });

  it("keeps the cumulative rounding error under half a millisecond", () => {
    const edits = Array.from({ length: 50 }, (_unused, index) =>
      speedEdit(index * 20, index * 20 + 7, 3),
    );
    const map = buildTimeMap({ sourceDurationMs: 2000, edits });
    const exact = 2000 - 50 * 7 + (50 * 7) / 3;
    expect(Math.abs(map.outputDurationMs - exact)).toBeLessThanOrEqual(0.5);
  });
});

describe("holds", () => {
  it("inserts output time and freezes the source instant", () => {
    const map = buildTimeMap({
      sourceDurationMs: 1000,
      edits: [holdEdit(0, 500), holdEdit(400, 200)],
    });
    expect(map.outputDurationMs).toBe(1000 + 500 + 200);
    expect(map.toOutput(0)).toBe(0);
    expect(map.toOutput(400)).toBe(900);
    expect(map.toSource(200)).toBe(0);
    expect(map.toSource(1000)).toBe(400);
    expect(map.locateOutput(1000).held).toBe(true);
    expect(map.locateOutput(1200).held).toBe(false);
    expect(map.toSource(1700)).toBe(1000);
  });

  it("stacks two holds at the same instant", () => {
    const map = buildTimeMap({
      sourceDurationMs: 1000,
      edits: [holdEdit(500, 100), holdEdit(500, 250)],
    });
    expect(map.outputDurationMs).toBe(1350);
    expect(map.toOutput(500)).toBe(500);
    expect(map.toSource(700)).toBe(500);
  });

  it("keeps a hold at the end of the media", () => {
    const map = buildTimeMap({ sourceDurationMs: 1000, edits: [holdEdit(1000, 300)] });
    expect(map.outputDurationMs).toBe(1300);
    expect(map.toOutput(1000)).toBe(1000);
    expect(map.toSource(1300)).toBe(1000);
  });

  it("keeps total output length = source − Σ cuts + Σ holds", () => {
    const map = buildTimeMap({
      sourceDurationMs: 10_000,
      edits: [cutEdit(1000, 2000), holdEdit(4000, 750), cutEdit(8000, 8500)],
    });
    expect(map.outputDurationMs).toBe(10_000 - 1000 - 500 + 750);
  });
});

describe("mapRange", () => {
  const map = twoCuts();

  it("splits a range that straddles a cut", () => {
    expect(map.mapRange(1500, 3500)).toEqual([
      { sourceStart: 1500, sourceEnd: 2000, outputStart: 1500, outputEnd: 2000 },
      { sourceStart: 3000, sourceEnd: 3500, outputStart: 2000, outputEnd: 2500 },
    ]);
  });

  it("returns nothing for a range wholly inside a cut, empty or backwards-clamped", () => {
    expect(map.mapRange(2000, 3000)).toEqual([]);
    expect(map.mapRange(2100, 2900)).toEqual([]);
    expect(map.mapRange(500, 500)).toEqual([]);
    expect(map.mapRange(-100, 0)).toEqual([]);
  });

  it("clips a range that runs past the media", () => {
    expect(map.mapRange(9500, 99_999)).toEqual([
      { sourceStart: 9500, sourceEnd: 10_000, outputStart: 8000, outputEnd: 8500 },
    ]);
  });

  it("splits into three across both cuts", () => {
    expect(map.mapRange(0, 10_000)).toHaveLength(3);
  });

  it("coalesces pieces that only meet at a speed boundary", () => {
    const speeded = buildTimeMap({ sourceDurationMs: 1000, edits: [speedEdit(200, 600, 2)] });
    expect(speeded.mapRange(0, 1000)).toEqual([
      { sourceStart: 0, sourceEnd: 1000, outputStart: 0, outputEnd: 800 },
    ]);
  });

  it("keeps one piece across a freeze frame, so a caption stays up while the picture is held", () => {
    const held = buildTimeMap({ sourceDurationMs: 1000, edits: [holdEdit(400, 200)] });
    expect(held.mapRange(0, 1000)).toEqual([
      { sourceStart: 0, sourceEnd: 1000, outputStart: 0, outputEnd: 1200 },
    ]);
  });

  it("starts a piece at the freeze when the range opens on one", () => {
    const held = buildTimeMap({ sourceDurationMs: 1000, edits: [holdEdit(400, 200)] });
    expect(held.mapRange(400, 1000)).toEqual([
      { sourceStart: 400, sourceEnd: 1000, outputStart: 400, outputEnd: 1200 },
    ]);
    // …and ends before a freeze that sits on the exclusive end of the range.
    expect(held.mapRange(0, 400)).toEqual([
      { sourceStart: 0, sourceEnd: 400, outputStart: 0, outputEnd: 400 },
    ]);
  });

  it("agrees with toOutput at both ends of every piece", () => {
    for (const piece of map.mapRange(1000, 9000)) {
      expect(map.toOutput(piece.sourceStart)).toBe(piece.outputStart);
      expect(map.toOutput(piece.sourceEnd)).toBe(piece.outputEnd);
    }
  });

  it("rejects a backwards range", () => {
    expect(() => map.mapRange(3000, 1000)).toThrowError(TimeMapError);
    try {
      map.mapRange(3000, 1000);
    } catch (error) {
      expect(isTimeMapError(error, "invalid-range")).toBe(true);
    }
  });

  it("rejects a non-finite bound", () => {
    expect(() => map.mapRange(Number.NaN, 10)).toThrowError(TimeMapError);
    expect(() => map.mapRange(0, Number.NaN)).toThrowError(TimeMapError);
  });
});

describe("snapCutsToFrames", () => {
  it("moves cut edges onto frame boundaries", () => {
    const map = buildTimeMap({
      sourceDurationMs: 10_000,
      edits: [cutEdit(1010, 2030)],
      fps: 25,
      snapCutsToFrames: true,
    });
    expect(map.cuts).toEqual([{ kind: "cut", startMs: 1000, endMs: 2040 }]);
    expect(map.fps).toBe(25);
    expect(map.outputDurationMs).toBe(10_000 - 1040);
  });
});
