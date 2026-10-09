import { describe, expect, it } from "vitest";

import { AUTOPILOT_MAX_CLIPS, autopilotClipCount } from "./repurpose.constants.js";
import {
  SNAP_REACH_MS,
  autopilotAskCount,
  autopilotPicks,
  cutBoundsOf,
  discoveryBoundsOf,
  excludeRangesFor,
  isRemoved,
  snapToWords,
  steeringOf,
  withLengthPreset,
  type PickableCandidate,
  type SnapWord,
} from "./steering.js";

describe("steeringOf — what a run was steered with, read back off its frozen config", () => {
  it("reads a topic, a length and the skips", () => {
    expect(
      steeringOf({
        discovery: {
          mode: "ai",
          topic: "  money habits  ",
          clipLength: "short",
          skipIntroMs: 120_000,
          skipOutroMs: 60_000,
        },
      }),
    ).toEqual({
      topic: "money habits",
      clipLength: "short",
      skipIntroMs: 120_000,
      skipOutroMs: 60_000,
    });
  });

  it("is null for a run with no steering, and ignores what nobody could have sent", () => {
    expect(steeringOf({ discovery: { mode: "ai", requestedCandidates: 5 } })).toBeNull();
    expect(steeringOf(null)).toBeNull();
    expect(steeringOf({ discovery: "nope" })).toBeNull();
    expect(
      steeringOf({
        discovery: { topic: "x", clipLength: "epic", skipIntroMs: -5, skipOutroMs: 99_999_999 },
      }),
    ).toBeNull();
  });
});

describe("clip length presets", () => {
  it("writes the preset's band into the frozen bounds, over bounds sent beside it", () => {
    expect(
      withLengthPreset({
        clipLength: "long" as const,
        minDurationMs: 15_000,
        maxDurationMs: 60_000,
      }),
    ).toMatchObject({ minDurationMs: 55_000, maxDurationMs: 95_000 });
    const plain = { minDurationMs: 15_000, maxDurationMs: 60_000 };
    expect(withLengthPreset(plain)).toBe(plain);
  });

  it("gives discovery the preset's band, else the recorded bounds, else 15-60 s", () => {
    expect(discoveryBoundsOf({ clipLength: "short" })).toEqual({
      minDurationMs: 15_000,
      maxDurationMs: 35_000,
    });
    expect(discoveryBoundsOf({ clipLength: "medium" })).toEqual({
      minDurationMs: 30_000,
      maxDurationMs: 60_000,
    });
    expect(discoveryBoundsOf({ minDurationMs: 20_000, maxDurationMs: 90_000 })).toEqual({
      minDurationMs: 20_000,
      maxDurationMs: 90_000,
    });
    // Absent, as every run before steering: the old defaults.
    expect(discoveryBoundsOf({})).toEqual({ minDurationMs: 15_000, maxDurationMs: 60_000 });
    expect(discoveryBoundsOf(undefined)).toEqual({ minDurationMs: 15_000, maxDurationMs: 60_000 });
    // Out of the contract's range, or inside out: the defaults, never a payload it refuses.
    expect(discoveryBoundsOf({ minDurationMs: 1_000, maxDurationMs: 900_000 })).toEqual({
      minDurationMs: 15_000,
      maxDurationMs: 60_000,
    });
    expect(discoveryBoundsOf({ minDurationMs: 90_000, maxDurationMs: 30_000 })).toEqual({
      minDurationMs: 15_000,
      maxDurationMs: 60_000,
    });
  });

  it("resolves durationBin presets and custom duration seconds accurately", () => {
    expect(discoveryBoundsOf({ durationBin: "UNDER_30" })).toEqual({
      minDurationMs: 15_000,
      maxDurationMs: 30_000,
    });
    expect(discoveryBoundsOf({ durationBin: "BETWEEN_30_60" })).toEqual({
      minDurationMs: 30_000,
      maxDurationMs: 60_000,
    });
    expect(discoveryBoundsOf({ durationBin: "BETWEEN_60_90" })).toEqual({
      minDurationMs: 60_000,
      maxDurationMs: 90_000,
    });
    expect(discoveryBoundsOf({ durationBin: "60_90" })).toEqual({
      minDurationMs: 60_000,
      maxDurationMs: 90_000,
    });
    expect(discoveryBoundsOf({ durationBin: "BETWEEN_90_180" })).toEqual({
      minDurationMs: 90_000,
      maxDurationMs: 180_000,
    });
    expect(discoveryBoundsOf({ durationBin: "AUTO" })).toEqual({
      minDurationMs: 20_000,
      maxDurationMs: 90_000,
    });
    expect(discoveryBoundsOf({ minDurationSec: 45, maxDurationSec: 75 })).toEqual({
      minDurationMs: 45_000,
      maxDurationMs: 75_000,
    });
    expect(
      withLengthPreset({
        durationBin: "BETWEEN_60_90" as const,
        minDurationMs: 15_000,
        maxDurationMs: 60_000,
      }),
    ).toMatchObject({ minDurationMs: 60_000, maxDurationMs: 90_000 });
  });
});

describe("excludeRangesFor — the skips, on the clock the words are timed on", () => {
  const MIN = 60_000;

  it("skips the start and the end of a video processed whole", () => {
    expect(
      excludeRangesFor({
        skipIntroMs: 2 * MIN,
        skipOutroMs: 5 * MIN,
        offsetMs: 0,
        fileDurationMs: 40 * MIN,
        sourceDurationMs: null,
      }),
    ).toEqual([
      { startMs: 0, endMs: 2 * MIN },
      { startMs: 35 * MIN, endMs: 40 * MIN },
    ]);
  });

  it("moves the skips onto a window's own clock: 20:00-40:00 of a 45-minute video", () => {
    // The intro is long over by 20:00; the outro (the last 10 minutes, from
    // 35:00) is 15:00-20:00 of this file.
    expect(
      excludeRangesFor({
        skipIntroMs: 2 * MIN,
        skipOutroMs: 10 * MIN,
        offsetMs: 20 * MIN,
        fileDurationMs: 20 * MIN,
        sourceDurationMs: 45 * MIN,
      }),
    ).toEqual([{ startMs: 15 * MIN, endMs: 20 * MIN }]);
  });

  it("trims an intro that runs into a window, and nothing of an outro past it", () => {
    expect(
      excludeRangesFor({
        skipIntroMs: 5 * MIN,
        skipOutroMs: 2 * MIN,
        offsetMs: 3 * MIN,
        fileDurationMs: 20 * MIN,
        sourceDurationMs: 60 * MIN,
      }),
    ).toEqual([{ startMs: 0, endMs: 2 * MIN }]);
  });

  it("leaves the end of a part alone when the video's length was never reported", () => {
    expect(
      excludeRangesFor({
        skipIntroMs: 0,
        skipOutroMs: 5 * MIN,
        offsetMs: 20 * MIN,
        fileDurationMs: 20 * MIN,
        sourceDurationMs: null,
      }),
    ).toEqual([]);
  });

  it("covers the whole file when the skips are longer than the video", () => {
    expect(
      excludeRangesFor({
        skipIntroMs: 30 * MIN,
        skipOutroMs: 0,
        offsetMs: 0,
        fileDurationMs: 10 * MIN,
        sourceDurationMs: 10 * MIN,
      }),
    ).toEqual([{ startMs: 0, endMs: 10 * MIN }]);
    expect(
      excludeRangesFor({
        skipIntroMs: 0,
        skipOutroMs: 30 * MIN,
        offsetMs: 0,
        fileDurationMs: 10 * MIN,
        sourceDurationMs: 10 * MIN,
      }),
    ).toEqual([{ startMs: 0, endMs: 10 * MIN }]);
  });

  it("asks for nothing when nothing is skipped", () => {
    expect(
      excludeRangesFor({
        skipIntroMs: 0,
        skipOutroMs: 0,
        offsetMs: 0,
        fileDurationMs: 10 * MIN,
        sourceDurationMs: null,
      }),
    ).toEqual([]);
  });
});

describe("Autopilot's reserve", () => {
  it("asks for about a third more than it cuts, never past forty", () => {
    expect(autopilotAskCount(5)).toBe(7);
    expect(autopilotAskCount(18)).toBe(24);
    expect(autopilotAskCount(30)).toBe(39);
    expect(autopilotAskCount(35)).toBe(AUTOPILOT_MAX_CLIPS);
    expect(autopilotAskCount(autopilotClipCount(6 * 60 * 60_000))).toBe(AUTOPILOT_MAX_CLIPS);
  });

  const suggestion = (id: string, rank: number, potentialScore = 80): PickableCandidate => ({
    id,
    source: "ai",
    state: "proposed",
    rank,
    potentialScore,
    startMs: rank * 60_000,
  });

  it("cuts the best `target` suggestions and keeps the rest in reserve", () => {
    const candidates = [
      suggestion("c4", 4),
      suggestion("c1", 1),
      suggestion("c3", 3),
      suggestion("c2", 2),
    ];
    const picks = autopilotPicks({ candidates, withClip: new Set(), target: 2, room: 40 });
    expect(picks.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("gives a removed clip's place to the best moment in reserve", () => {
    const candidates = [
      { ...suggestion("c1", 1), state: "rejected" },
      suggestion("c2", 2),
      suggestion("c3", 3),
      suggestion("c4", 4),
    ];
    const picks = autopilotPicks({
      candidates,
      withClip: new Set(["c1", "c2"]),
      target: 2,
      room: 38,
    });
    expect(picks.map((c) => c.id)).toEqual(["c3"]);
  });

  it("always cuts a moment the person added, outside the target, and never a removed one", () => {
    const candidates = [
      suggestion("c1", 1),
      {
        id: "m1",
        source: "manual",
        state: "proposed",
        rank: null,
        potentialScore: null,
        startMs: 5_000,
      },
      {
        id: "m2",
        source: "manual",
        state: "rejected",
        rank: null,
        potentialScore: null,
        startMs: 9_000,
      },
    ];
    const picks = autopilotPicks({ candidates, withClip: new Set(["c1"]), target: 1, room: 40 });
    expect(picks.map((c) => c.id)).toEqual(["m1"]);
  });

  it("never passes the run's clip cap", () => {
    const candidates = [suggestion("c1", 1), suggestion("c2", 2), suggestion("c3", 3)];
    expect(autopilotPicks({ candidates, withClip: new Set(), target: 3, room: 1 })).toHaveLength(1);
    expect(autopilotPicks({ candidates, withClip: new Set(), target: 3, room: 0 })).toEqual([]);
  });

  it("orders unranked suggestions after ranked ones, then by potential", () => {
    const candidates = [
      { ...suggestion("low", 1, 60), rank: null },
      { ...suggestion("high", 2, 90), rank: null },
      suggestion("ranked", 5, 10),
    ];
    const picks = autopilotPicks({ candidates, withClip: new Set(), target: 3, room: 40 });
    expect(picks.map((c) => c.id)).toEqual(["ranked", "high", "low"]);
  });

  it("knows a removed moment", () => {
    expect(isRemoved({ state: "rejected" })).toBe(true);
    expect(isRemoved({ state: "proposed" })).toBe(false);
    expect(isRemoved(undefined)).toBe(false);
  });
});

describe("snapToWords — a moved start and end land on word edges", () => {
  // Speech with a long pause (4.0-9.0 s) in the middle.
  const words: SnapWord[] = [
    { wid: "0:0", s: 1_000, e: 1_400 },
    { wid: "0:1", s: 1_500, e: 2_000 },
    { wid: "0:2", s: 2_100, e: 3_900 },
    { wid: "0:3", s: 9_000, e: 9_600 },
    { wid: "0:4", s: 9_700, e: 10_200 },
    { wid: "0:5", s: 10_300, e: 12_000 },
    { wid: "0:6", s: 12_100, e: 12_500, deleted: true },
  ];
  const limits = { minMs: 3_000, maxMs: 180_000, durationMs: 60_000 };

  it("snaps the start to the nearest word start and the end to the nearest word end", () => {
    const snapped = snapToWords(words, { startMs: 1_600, endMs: 10_100 }, null, limits);
    expect(snapped).toEqual({
      startMs: 1_500,
      endMs: 10_200,
      startWordId: "0:1",
      endWordId: "0:4",
    });
  });

  it("leaves a side the person did not move exactly where it was", () => {
    const current = { startMs: 1_000, endMs: 9_600, startWordId: "0:0", endWordId: "0:3" };
    const snapped = snapToWords(words, { startMs: 1_000, endMs: 10_600 }, current, limits);
    expect(snapped).toEqual({
      startMs: 1_000,
      endMs: 10_200,
      startWordId: "0:0",
      endWordId: "0:4",
    });
  });

  it("never snaps a nudge back onto where the side already was", () => {
    // End at 9.6 s, nudged 1 s earlier into the pause: the only word end in
    // reach is 9.6 s itself, which would undo the nudge. No word is cut in a
    // pause, so the end stays where it was asked for.
    const current = { startMs: 1_000, endMs: 9_600, startWordId: "0:0", endWordId: "0:3" };
    const snapped = snapToWords(words, { startMs: 1_000, endMs: 8_600 }, current, limits);
    expect(snapped).toEqual({ startMs: 1_000, endMs: 8_600, startWordId: "0:0", endWordId: null });
    // Nudged 1 s later from 10.2 s, it lands on the next word's end, not back.
    const later = snapToWords(
      words,
      { startMs: 1_000, endMs: 11_200 },
      { ...current, endMs: 10_200, endWordId: "0:4" },
      limits,
    );
    expect(later?.endMs).toBe(12_000);
  });

  it("ignores deleted words, and keeps the time as asked where no word is in reach", () => {
    const snapped = snapToWords(words, { startMs: 9_000, endMs: 12_400 }, null, limits);
    expect(snapped?.endMs).toBe(12_000);
    const far = snapToWords(
      words,
      { startMs: 30_000, endMs: 30_000 + SNAP_REACH_MS + 14_000 },
      null,
      limits,
    );
    expect(far).toEqual({
      startMs: 30_000,
      endMs: 45_000,
      startWordId: null,
      endWordId: null,
    });
  });

  it("tries the next word start when the nearest would break the 3 s minimum", () => {
    // 9.7-12.0 s is 2.3 s; the start before it (9.0 s) makes exactly 3 s.
    const snapped = snapToWords(words, { startMs: 9_700, endMs: 12_600 }, null, limits);
    expect(snapped).toEqual({
      startMs: 9_000,
      endMs: 12_000,
      startWordId: "0:3",
      endWordId: "0:5",
    });
  });

  it("ends where the video does, and refuses what cannot be a moment", () => {
    const short = { ...limits, durationMs: 11_800 };
    expect(snapToWords(words, { startMs: 5_000, endMs: 12_000 }, null, short)?.endMs).toBe(11_800);
    expect(snapToWords([], { startMs: 5_000, endMs: 6_000 }, null, limits)).toBeNull();
    expect(
      snapToWords([], { startMs: 5_000, endMs: 200_000 }, null, { ...limits, durationMs: null }),
    ).toBeNull();
  });
});

describe("cutBoundsOf — the bounds a cut's job key names", () => {
  it("is the moment's start and its end, cut to the source's length", () => {
    expect(cutBoundsOf({ startMs: 60_000, endMs: 90_000 }, 600_000)).toBe("60000-90000");
    expect(cutBoundsOf({ startMs: 60_000, endMs: 90_040 }, 90_000)).toBe("60000-90000");
    expect(cutBoundsOf({ startMs: 60_000, endMs: 90_000 }, null)).toBe("60000-90000");
  });
});
