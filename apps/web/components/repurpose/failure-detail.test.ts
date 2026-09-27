import { describe, expect, it } from "vitest";

import {
  detailedFailure,
  failureDetailOf,
  formatBytes,
  formatCredits,
  spanPhrase,
  tooLongFacts,
} from "./failure-detail";

/**
 * The numbers behind a refusal (plan limits, 2026-09-27). A too-long link used
 * to end on "This video is longer than your plan allows" with no length, no
 * limit and only another video to choose; the run now carries the facts and
 * the card states them.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const LENGTH = 34 * MIN + 37_000; // 34:37

describe("failureDetailOf", () => {
  it("keeps only numbers the page can print, key by key", () => {
    expect(
      failureDetailOf({
        durationMs: LENGTH,
        windowMs: "1200000",
        maxBytes: -1,
        approximateBytes: Number.NaN,
        creditsLeft: 3.5,
        somethingElse: 7,
      }),
    ).toEqual({ durationMs: LENGTH, creditsLeft: 3.5 });
  });

  it("is null for nothing usable, so the plain sentence stays", () => {
    for (const value of [null, undefined, "34:37", 5, {}, { durationMs: "long" }]) {
      expect(failureDetailOf(value), String(value)).toBeNull();
    }
  });
});

describe("the numbers, as a person reads them", () => {
  it("never overstates a balance", () => {
    expect(formatCredits(1)).toBe("1 credit");
    expect(formatCredits(3.59)).toBe("3.5 credits");
    expect(formatCredits(0)).toBe("0 credits");
    expect(formatCredits(20)).toBe("20 credits");
    expect(formatCredits(-2)).toBe("0 credits");
  });

  it("says sizes in MB and GB", () => {
    expect(formatBytes(500 * 1024 * 1024)).toBe("500 MB");
    expect(formatBytes(556 * 1024 * 1024)).toBe("556 MB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2 GB");
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });

  it("says a stretch of video in minutes, and whole hours past 90 minutes", () => {
    expect(spanPhrase(20 * MIN)).toBe("20 minutes");
    expect(spanPhrase(60 * MIN)).toBe("60 minutes");
    expect(spanPhrase(150 * MIN)).toBe("150 minutes");
    expect(spanPhrase(3 * HOUR)).toBe("3 hours");
    expect(spanPhrase(12 * HOUR)).toBe("12 hours");
    expect(spanPhrase(MIN)).toBe("1 minute");
    expect(spanPhrase(30_000)).toBe("30 seconds");
    // Down, never up: 2:47 left is not "the next 3 minutes".
    expect(spanPhrase(2 * MIN + 47_000)).toBe("2 minutes");
  });
});

describe("tooLongFacts", () => {
  it("is a window when the video is longer than a run processes, within what is taken at all", () => {
    expect(
      tooLongFacts({ durationMs: LENGTH, windowMs: 20 * MIN, maxDurationMs: 12 * HOUR }),
    ).toEqual({ kind: "window", durationMs: LENGTH, windowMs: 20 * MIN });
    expect(tooLongFacts({ durationMs: LENGTH, windowMs: 20 * MIN })).toMatchObject({
      kind: "window",
    });
  });

  // What the probe writes when a downloaded file overran its window (an old
  // downloader that fetched the whole video): a new download is windowed.
  it("is a window when the file overran the window it was fetched for", () => {
    expect(
      tooLongFacts({ durationMs: LENGTH, maxDurationMs: 20 * MIN, windowMs: 20 * MIN }),
    ).toEqual({ kind: "window", durationMs: LENGTH, windowMs: 20 * MIN });
  });

  it("is the ceiling when the video is over a limit longer than the window", () => {
    const thirteenHours = 13 * HOUR;
    expect(
      tooLongFacts({ durationMs: thirteenHours, windowMs: 20 * MIN, maxDurationMs: 12 * HOUR }),
    ).toEqual({ kind: "ceiling", durationMs: thirteenHours, maxMs: 12 * HOUR });
  });

  // A download is refused on length only past the ceiling (a longer video is
  // windowed instead), and that refusal names no window — also for an
  // unlimited workspace, whose window is the ceiling itself.
  it("is the ceiling when a limit comes with no window beside it", () => {
    expect(tooLongFacts({ durationMs: 13 * HOUR, maxDurationMs: 12 * HOUR })).toEqual({
      kind: "ceiling",
      durationMs: 13 * HOUR,
      maxMs: 12 * HOUR,
    });
  });

  it("is a length when only that came, and nothing without one", () => {
    expect(tooLongFacts({ durationMs: LENGTH })).toEqual({ kind: "length", durationMs: LENGTH });
    expect(tooLongFacts({ windowMs: 20 * MIN })).toBeNull();
    expect(tooLongFacts(null)).toBeNull();
  });
});

describe("detailedFailure", () => {
  it("states the length and the plan's window for a too-long video", () => {
    expect(
      detailedFailure("repurpose/source_too_long", { durationMs: LENGTH, windowMs: 20 * MIN }),
    ).toEqual({
      title: "This video is 34:37. Your plan processes 20:00 per video.",
      windowPossible: true,
      windowMs: 20 * MIN,
    });
  });

  it("offers no part of a video over the ceiling, where no part helps", () => {
    const detailed = detailedFailure("repurpose/source_too_long", {
      durationMs: 13 * HOUR + 2 * MIN + 11_000,
      windowMs: 20 * MIN,
      maxDurationMs: 12 * HOUR,
    });
    expect(detailed.title).toBe(
      "This video is 13:02:11. Your plan takes videos up to 12 hours long.",
    );
    expect(detailed.windowPossible).toBe(false);
  });

  it("keeps the plain title, and the window, when the run carried no numbers", () => {
    expect(detailedFailure("repurpose/source_too_long", null)).toEqual({ windowPossible: true });
    expect(detailedFailure("repurpose/source_too_long", { durationMs: LENGTH }).title).toBe(
      "This video is 34:37, longer than your plan allows.",
    );
  });

  it("states the size and the cap for a too-large video", () => {
    const mb = 1024 * 1024;
    expect(
      detailedFailure("repurpose/source_too_large", {
        approximateBytes: 556 * mb,
        maxBytes: 500 * mb,
      }).title,
    ).toBe("This video is about 556 MB. Your plan takes files up to 500 MB.");
    expect(detailedFailure("repurpose/source_too_large", { maxBytes: 500 * mb }).title).toBe(
      "This video is bigger than your plan allows (up to 500 MB).",
    );
    expect(detailedFailure("repurpose/source_too_large", null).title).toBeUndefined();
  });

  // A snapshot from when the run stopped, so it is said in the past.
  it("says the balance the run stopped with when out of credits", () => {
    expect(detailedFailure("repurpose/no_credits", { creditsLeft: 3.5 }).reassurance).toBe(
      "Your video is safe. This run stopped with 3.5 credits left, and making its transcript needed more than that.",
    );
    expect(detailedFailure("repurpose/no_credits", null).reassurance).toBeUndefined();
  });

  it("changes nothing for a code that has no numbers", () => {
    expect(detailedFailure("repurpose/source_blocked", { durationMs: LENGTH })).toEqual({
      windowPossible: false,
    });
  });
});
