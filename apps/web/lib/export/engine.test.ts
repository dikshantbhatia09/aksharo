import { describe, expect, it } from "vitest";

import { retainedSourceRangesMs } from "./engine";

describe("retainedSourceRangesMs", () => {
  it("returns the whole range when there are no cuts", () => {
    expect(retainedSourceRangesMs(10_000, [])).toEqual([{ startMs: 0, endMs: 10_000 }]);
  });

  it("removes a single cut in the middle", () => {
    expect(retainedSourceRangesMs(10_000, [{ kind: "cut", startMs: 2_000, endMs: 3_000 }])).toEqual(
      [
        { startMs: 0, endMs: 2_000 },
        { startMs: 3_000, endMs: 10_000 },
      ],
    );
  });

  it("merges overlapping and touching cuts", () => {
    expect(
      retainedSourceRangesMs(10_000, [
        { kind: "cut", startMs: 2_000, endMs: 3_500 },
        { kind: "cut", startMs: 3_000, endMs: 4_000 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 2_000 },
      { startMs: 4_000, endMs: 10_000 },
    ]);
  });

  it("drops a leading cut down to zero and a trailing cut to the end", () => {
    expect(
      retainedSourceRangesMs(10_000, [
        { kind: "cut", startMs: 0, endMs: 1_000 },
        { kind: "cut", startMs: 9_000, endMs: 10_000 },
      ]),
    ).toEqual([{ startMs: 1_000, endMs: 9_000 }]);
  });

  it("clamps a cut that runs past the source duration", () => {
    expect(
      retainedSourceRangesMs(10_000, [{ kind: "cut", startMs: 8_000, endMs: 12_000 }]),
    ).toEqual([{ startMs: 0, endMs: 8_000 }]);
  });

  it("returns nothing retained when a single cut covers the whole source", () => {
    expect(retainedSourceRangesMs(10_000, [{ kind: "cut", startMs: 0, endMs: 10_000 }])).toEqual(
      [],
    );
  });

  it("ignores non-cut edits (speed/hold), which the caller refuses before calling this", () => {
    expect(
      retainedSourceRangesMs(10_000, [
        { kind: "speed", startMs: 1_000, endMs: 2_000, factor: 2 },
        { kind: "cut", startMs: 5_000, endMs: 6_000 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 5_000 },
      { startMs: 6_000, endMs: 10_000 },
    ]);
  });
});
