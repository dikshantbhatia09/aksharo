import { describe, expect, it } from "vitest";

import { STEERING_COPY, beginnerSafetyViolations } from "./copy";
import {
  CLIP_LENGTH_PRESETS,
  CLIP_LENGTHS,
  discoverySteeringOf,
  isRemovedCandidate,
  lengthRange,
  nudgeBounds,
  skipMsOf,
  steeringSummary,
  topicProblem,
} from "./steering";
import * as contracts from "../../../../packages/repurpose-contracts/src/schema";

/**
 * Steering (2026-09-29): the start form's topic, clip length and skips, the
 * run page's line about them, and the nudges that move a moment.
 */
describe("the clip lengths", () => {
  it("are the contract's presets, word for word", () => {
    expect(CLIP_LENGTH_PRESETS).toEqual(contracts.CLIP_LENGTH_PRESETS);
    expect([...CLIP_LENGTHS]).toEqual([...contracts.ClipLengthPresetSchema.options]);
  });

  it("say their band beside the choice", () => {
    expect(lengthRange("short")).toBe("15–35 s");
    expect(lengthRange("medium")).toBe("30–60 s");
    expect(lengthRange("long")).toBe("55–95 s");
  });
});

describe("the skips, as typed in minutes", () => {
  it("reads whole and part minutes, and a comma as a point", () => {
    expect(skipMsOf("2")).toBe(120_000);
    expect(skipMsOf(" 1.5 ")).toBe(90_000);
    expect(skipMsOf("0,5")).toBe(30_000);
    expect(skipMsOf("30")).toBe(1_800_000);
  });

  it("is nothing for an empty field or zero", () => {
    expect(skipMsOf("")).toBeUndefined();
    expect(skipMsOf("   ")).toBeUndefined();
    expect(skipMsOf("0")).toBeUndefined();
  });

  it("refuses what is not a number of minutes up to thirty", () => {
    for (const text of ["31", "-2", "1e1", "0x1f", "two", "1.2.3", "."]) {
      expect(skipMsOf(text), text).toBeNull();
    }
  });
});

describe("the topic", () => {
  it("is optional, but a single letter or an essay is not a topic", () => {
    expect(topicProblem("")).toBeUndefined();
    expect(topicProblem("money habits")).toBeUndefined();
    expect(topicProblem(" x ")).toBe(STEERING_COPY.topicTooShort);
    expect(topicProblem("y".repeat(201))).toBe(STEERING_COPY.topicTooLong);
  });
});

describe("what the form sends", () => {
  it("sends only what was given, and always the length", () => {
    expect(
      discoverySteeringOf({
        topic: "  money habits, startup failures ",
        clipLength: "short",
        skipIntro: "2",
        skipOutro: "",
      }),
    ).toEqual({
      topic: "money habits, startup failures",
      clipLength: "short",
      skipIntroMs: 120_000,
    });
    expect(
      discoverySteeringOf({ topic: "", clipLength: "medium", skipIntro: "0", skipOutro: "" }),
    ).toEqual({ clipLength: "medium" });
  });
});

describe("the run page's line about a steered run", () => {
  it("says what it is about, how long the clips are, and what it skipped", () => {
    expect(
      steeringSummary({
        topic: "money habits",
        clipLength: "short",
        skipIntroMs: 120_000,
        skipOutroMs: 0,
      }),
    ).toBe("About: money habits · Short clips · Skips the first 2 min");
    expect(
      steeringSummary({ topic: null, clipLength: null, skipIntroMs: 90_000, skipOutroMs: 30_000 }),
    ).toBe("Skips the first 1.5 min and the last 30 s");
    expect(
      steeringSummary({ topic: null, clipLength: "long", skipIntroMs: 0, skipOutroMs: 300_000 }),
    ).toBe("Long clips · Skips the last 5 min");
  });

  it("says nothing for a run that was not steered", () => {
    expect(steeringSummary(null)).toBeNull();
    expect(steeringSummary(undefined)).toBeNull();
    expect(
      steeringSummary({ topic: " ", clipLength: null, skipIntroMs: 0, skipOutroMs: 0 }),
    ).toBeNull();
  });
});

describe("the nudges", () => {
  const moment = { startMs: 60_000, endMs: 90_000 };

  it("move one side at a time", () => {
    expect(nudgeBounds(moment, "start", -5_000, 600_000)).toEqual({
      startMs: 55_000,
      endMs: 90_000,
    });
    expect(nudgeBounds(moment, "end", 1_000, 600_000)).toEqual({ startMs: 60_000, endMs: 91_000 });
  });

  it("stay inside the video, and do nothing past its edges", () => {
    expect(nudgeBounds({ startMs: 2_000, endMs: 30_000 }, "start", -5_000, null)).toEqual({
      startMs: 0,
      endMs: 30_000,
    });
    expect(nudgeBounds({ startMs: 0, endMs: 30_000 }, "start", -1_000, null)).toBeNull();
    expect(nudgeBounds({ startMs: 480_000, endMs: 598_000 }, "end", 5_000, 600_000)).toEqual({
      startMs: 480_000,
      endMs: 600_000,
    });
    expect(nudgeBounds({ startMs: 480_000, endMs: 600_000 }, "end", 1_000, 600_000)).toBeNull();
  });

  it("keep a moment 3 s to 3 min long", () => {
    expect(nudgeBounds({ startMs: 60_000, endMs: 64_000 }, "end", -1_000, null)).toEqual({
      startMs: 60_000,
      endMs: 63_000,
    });
    expect(nudgeBounds({ startMs: 60_000, endMs: 63_000 }, "end", -1_000, null)).toBeNull();
    expect(nudgeBounds({ startMs: 0, endMs: 178_000 }, "end", 5_000, null)).toBeNull();
  });
});

describe("a removed moment", () => {
  it("is one the person rejected", () => {
    expect(isRemovedCandidate({ id: "a", state: "rejected" })).toBe(true);
    expect(isRemovedCandidate({ id: "a", state: "proposed" })).toBe(false);
    expect(isRemovedCandidate({ id: "a" })).toBe(false);
  });
});

describe("every steering sentence", () => {
  it("contains no technical word", () => {
    const everything = [
      STEERING_COPY.topicLabel,
      STEERING_COPY.topicPlaceholder,
      STEERING_COPY.topicHint,
      STEERING_COPY.topicTooShort,
      STEERING_COPY.topicTooLong,
      STEERING_COPY.lengthLegend,
      ...Object.values(STEERING_COPY.length),
      STEERING_COPY.skipLegend,
      STEERING_COPY.skipFirst,
      STEERING_COPY.skipLast,
      STEERING_COPY.skipHint,
      STEERING_COPY.skipInvalid,
      STEERING_COPY.about("money habits"),
      ...Object.values(STEERING_COPY.runLength),
      STEERING_COPY.skipsBoth("2 min", "1 min"),
      STEERING_COPY.removeClip("A moment"),
      STEERING_COPY.removeMoment("A moment"),
      STEERING_COPY.restoreLabel("A moment"),
      STEERING_COPY.adjustLabel("A moment"),
      STEERING_COPY.adjustWhileCutting,
      STEERING_COPY.nudge("start", -5),
      STEERING_COPY.nudge("end", 1),
      STEERING_COPY.recutNote,
      STEERING_COPY.saveNote,
    ];
    for (const text of everything) {
      expect(beginnerSafetyViolations(text), text).toEqual([]);
    }
    expect(STEERING_COPY.nudge("start", -5)).toBe("Start 5 seconds earlier");
    expect(STEERING_COPY.nudge("end", 1)).toBe("End 1 second later");
  });
});
