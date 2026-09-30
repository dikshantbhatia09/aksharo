import { describe, expect, it } from "vitest";

import {
  BROLL_RULES,
  blockedBrollSpans,
  brollPlacementProblem,
  brollModeFor,
  brollMotionAt,
  brollOverlaysOf,
  brollWindowFrom,
  nudgeBrollWindow,
  planBroll,
  uncutClock,
  type BrollClock,
  type BrollWord,
} from "./broll.js";

import type { Overlay } from "./schemas/document.js";

/** `count` words of 400 ms with 100 ms gaps, from `startMs`: "w0" at 0-400, "w1" at 500-900, … */
function words(count: number, startMs = 0): BrollWord[] {
  return Array.from({ length: count }, (_, index) => ({
    wid: `0:${String(index)}`,
    s: startMs + index * 500,
    e: startMs + index * 500 + 400,
  }));
}

/** A clock with one cut over `[cutStart, cutEnd)` on the source clock. */
function clockWithCut(durationMs: number, cutStart: number, cutEnd: number): BrollClock {
  const cut = cutEnd - cutStart;
  return {
    outputDurationMs: durationMs - cut,
    toOutput: (ms) => {
      if (ms < 0 || ms > durationMs) return null;
      if (ms < cutStart) return ms;
      if (ms < cutEnd) return null;
      return ms - cut;
    },
  };
}

const at = (index: number) => `0:${String(index)}`;

describe("brollWindowFrom", () => {
  it("starts on the naming word and ends on the word that makes it about 2.5 s long", () => {
    const list = words(40);
    // w10 starts at 5000; w14 ends at 7400 (2.4 s), w15 at 7900 (2.9 s).
    expect(brollWindowFrom(list, 10)).toEqual({
      startMs: 5_000,
      endMs: 7_900,
      startWordId: at(10),
      endWordId: at(15),
    });
  });

  it("keeps a naming phrase whole, and stops at the last word", () => {
    const list = words(12);
    expect(brollWindowFrom(list, 8, 9)).toMatchObject({ startWordId: at(8), endWordId: at(11) });
    expect(brollWindowFrom(list, 11)).toEqual({
      startMs: 5_500,
      endMs: 5_900,
      startWordId: at(11),
      endWordId: at(11),
    });
  });

  it("never grows past the longest a cutaway may be, and refuses indices it does not have", () => {
    const list = words(40);
    const window = brollWindowFrom(list, 0, 0, { targetMs: 10_000, maxMs: 3_000 });
    expect(window).toMatchObject({ startMs: 0, endMs: 2_900, endWordId: at(5) });
    expect(brollWindowFrom(list, 50)).toBeUndefined();
    expect(brollWindowFrom(list, 5, 3)).toBeUndefined();
  });
});

describe("planBroll", () => {
  const list = words(120); // 60 s of speech
  const clock = uncutClock(60_000);
  const proposal = (index: number, score = 5, until = index) => ({
    startWordId: at(index),
    endWordId: at(until),
    score,
  });

  it("keeps a proposal on its own words", () => {
    const [planned] = planBroll({ proposals: [proposal(20)], words: list, clock });
    expect(planned).toEqual({
      startMs: 10_000,
      endMs: 12_900,
      startWordId: at(20),
      endWordId: at(25),
      proposal: 0,
    });
  });

  it("never covers the hook's first seconds or the last seconds of the video", () => {
    // w2 starts at 1 s; w116 starts at 58 s.
    const planned = planBroll({
      proposals: [proposal(2, 9), proposal(116, 9), proposal(30, 1)],
      words: list,
      clock,
    });
    expect(planned.map((entry) => entry.proposal)).toEqual([2]);
    for (const entry of planned) {
      expect(entry.startMs).toBeGreaterThanOrEqual(BROLL_RULES.hookClearMs);
      expect(entry.endMs).toBeLessThanOrEqual(60_000 - BROLL_RULES.tailClearMs);
    }
  });

  it("spaces cutaways out, keeping the stronger of two that crowd each other", () => {
    const planned = planBroll({
      proposals: [proposal(20, 3), proposal(26, 8), proposal(60, 5)],
      words: list,
      clock,
    });
    // w26 (13 s) beats w20 (10 s), which would end 0.1 s before it starts.
    expect(planned.map((entry) => entry.proposal)).toEqual([1, 2]);
    const [first, second] = planned;
    expect((second?.startMs ?? 0) - (first?.endMs ?? 0)).toBeGreaterThanOrEqual(
      BROLL_RULES.minGapMs,
    );
  });

  it("covers at most its share of the video, and at most five cutaways", () => {
    const many = Array.from({ length: 20 }, (_, index) => proposal(8 + index * 11, 5));
    const planned = planBroll({ proposals: many, words: words(240), clock: uncutClock(120_000) });
    expect(planned.length).toBeLessThanOrEqual(BROLL_RULES.maxPerClip);
    const covered = planned.reduce((sum, entry) => sum + entry.endMs - entry.startMs, 0);
    expect(covered).toBeLessThanOrEqual(BROLL_RULES.maxCoverage * 120_000);

    // A minute: 22 % of it is 13.2 s, four cutaways of 2.9 s and not a fifth.
    const short = planBroll({ proposals: many, words: list, clock });
    const shortCovered = short.reduce((sum, entry) => sum + entry.endMs - entry.startMs, 0);
    expect(shortCovered).toBeLessThanOrEqual(BROLL_RULES.maxCoverage * 60_000);
    expect(short).toHaveLength(4);
  });

  it("keeps off a hook title and an end card, and off the cutaways already there", () => {
    const blocked = [{ startMs: 20_000, endMs: 22_000 }];
    const existing = [{ startMs: 40_000, endMs: 42_000 }];
    const planned = planBroll({
      // w36's window (18-20.9 s) runs into the title; w80 (40 s) is on a cutaway;
      // w62 (31-33.9 s) is 6.1 s clear of it, and kept.
      proposals: [proposal(36, 9), proposal(80, 9), proposal(62, 1)],
      words: list,
      clock,
      blocked,
      existing,
    });
    expect(planned.map((entry) => entry.proposal)).toEqual([2]);
    // The cutaway already there counts towards the five.
    const crowded = planBroll({
      proposals: [proposal(62, 1)],
      words: list,
      clock,
      existing,
      rules: { maxPerClip: 1 },
    });
    expect(crowded).toEqual([]);
  });

  it("measures the hook, the tail and the coverage on the video as it plays, after the cuts", () => {
    // A 4 s cut at 1-5 s: w10 (5 s on the source clock) plays at 1 s.
    const cut = clockWithCut(60_000, 1_000, 5_000);
    expect(planBroll({ proposals: [proposal(10)], words: list, clock: cut })).toEqual([]);
    // w16 (8 s) plays at 4 s: clear of the hook.
    expect(planBroll({ proposals: [proposal(16)], words: list, clock: cut })).toHaveLength(1);
  });

  it("leaves out a proposal naming words that are not there, or backwards", () => {
    const planned = planBroll({
      proposals: [
        { startWordId: "9:9", endWordId: "9:9", score: 9 },
        { startWordId: at(30), endWordId: at(20), score: 9 },
      ],
      words: list,
      clock,
    });
    expect(planned).toEqual([]);
  });
});

describe("blockedBrollSpans and brollOverlaysOf", () => {
  const overlays: Overlay[] = [
    {
      id: "01J00000000000000000000001",
      kind: "hook-title",
      text: "Hook",
      startMs: 0,
      endMs: 2_500,
    },
    {
      id: "01J00000000000000000000002",
      kind: "b-roll",
      startMs: 9_000,
      endMs: 11_000,
      image: { assetId: "01J00000000000000000000009", format: "png", width: 100, height: 100 },
      mode: "full",
      motion: "none",
    },
    {
      id: "01J00000000000000000000003",
      kind: "end-card",
      startMs: 27_000,
      endMs: 30_000,
      background: "#000000",
      cta: "Follow",
    },
    {
      id: "01J00000000000000000000004",
      kind: "b-roll",
      startMs: 5_000,
      endMs: 7_000,
      image: { assetId: "01J00000000000000000000009", format: "png", width: 100, height: 100 },
      mode: "pip",
      motion: "pan-left",
    },
  ];

  it("blocks the titles and the card, never a logo or a cutaway", () => {
    expect(blockedBrollSpans(overlays)).toEqual([
      { startMs: 0, endMs: 2_500 },
      { startMs: 27_000, endMs: 30_000 },
    ]);
    expect(blockedBrollSpans(undefined)).toEqual([]);
  });

  it("lists the cutaways in start order", () => {
    expect(brollOverlaysOf(overlays).map((overlay) => overlay.startMs)).toEqual([5_000, 9_000]);
  });
});

describe("brollModeFor", () => {
  const tall = { width: 1080, height: 1920 };
  const wide = { width: 1920, height: 1080 };

  it("covers the frame with a picture of about its shape", () => {
    expect(brollModeFor({ width: 1440, height: 2560 }, tall)).toBe("full");
    expect(brollModeFor({ width: 2000, height: 3000 }, tall)).toBe("full");
    expect(brollModeFor({ width: 3000, height: 2000 }, wide)).toBe("full");
    expect(brollModeFor({ width: 1000, height: 1000 }, { width: 1080, height: 1350 })).toBe("full");
  });

  it("boxes a picture whose shape would lose more than half of it to the crop", () => {
    expect(brollModeFor({ width: 3000, height: 2000 }, tall)).toBe("pip");
    expect(brollModeFor({ width: 2000, height: 3000 }, wide)).toBe("pip");
  });
});

describe("brollMotionAt", () => {
  it("never moves two cutaways in a row alike", () => {
    const moves = Array.from({ length: 8 }, (_, index) => brollMotionAt(index));
    for (let index = 1; index < moves.length; index += 1) {
      expect(moves.at(index)).not.toBe(moves.at(index - 1));
    }
    expect(brollMotionAt(-1)).toBe("pan-right");
  });
});

describe("nudgeBrollWindow", () => {
  const list = words(20);
  const window = { startMs: 2_000, endMs: 4_400 };

  it("trims one edge to the next word boundary either way", () => {
    expect(nudgeBrollWindow(window, list, "start", 1)).toEqual({ startMs: 2_500, endMs: 4_400 });
    expect(nudgeBrollWindow(window, list, "start", -1)).toEqual({ startMs: 1_500, endMs: 4_400 });
    expect(nudgeBrollWindow(window, list, "end", 1)).toEqual({ startMs: 2_000, endMs: 4_900 });
    expect(nudgeBrollWindow(window, list, "end", -1)).toEqual({ startMs: 2_000, endMs: 3_900 });
  });

  it("moves the whole window a word at a time, keeping its length", () => {
    expect(nudgeBrollWindow(window, list, "both", 1)).toEqual({ startMs: 2_500, endMs: 4_900 });
    expect(nudgeBrollWindow(window, list, "both", -1)).toEqual({ startMs: 1_500, endMs: 3_900 });
  });

  it("refuses a trim that would make it shorter than a second, or run out of words", () => {
    expect(nudgeBrollWindow({ startMs: 2_000, endMs: 3_400 }, list, "end", -1)).toBeUndefined();
    expect(nudgeBrollWindow({ startMs: 0, endMs: 2_400 }, list, "both", -1)).toBeUndefined();
    expect(nudgeBrollWindow(window, [], "start", 1)).toBeUndefined();
  });
});

describe("brollPlacementProblem", () => {
  const clock = uncutClock(60_000);
  const blocked = [{ startMs: 27_000, endMs: 30_000 }];

  it("keeps a person's cutaway off the hook's first seconds and off a title or a card", () => {
    expect(brollPlacementProblem({ startMs: 1_000, endMs: 3_500 }, { clock, blocked })).toBe(
      "hook",
    );
    expect(brollPlacementProblem({ startMs: 26_000, endMs: 28_000 }, { clock, blocked })).toBe(
      "title",
    );
    expect(
      brollPlacementProblem({ startMs: 10_000, endMs: 12_500 }, { clock, blocked }),
    ).toBeUndefined();
    // Near the end is a person's call: only Autopilot keeps clear of it.
    expect(
      brollPlacementProblem({ startMs: 56_000, endMs: 59_000 }, { clock, blocked }),
    ).toBeUndefined();
  });

  it("measures the hook on the video as it plays, after its cuts", () => {
    const cut = clockWithCut(60_000, 1_000, 5_000);
    // 5.5 s of source plays at 1.5 s: still the hook.
    expect(
      brollPlacementProblem({ startMs: 5_500, endMs: 8_000 }, { clock: cut, blocked: [] }),
    ).toBe("hook");
    expect(
      brollPlacementProblem({ startMs: 8_000, endMs: 10_000 }, { clock: cut, blocked: [] }),
    ).toBeUndefined();
  });
});
