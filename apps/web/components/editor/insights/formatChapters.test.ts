import { describe, expect, it } from "vitest";

import { chaptersAsYouTubeDescription, formatChapterTimestamp } from "./formatChapters";

describe("formatChapterTimestamp", () => {
  it("formats under an hour as MM:SS", () => {
    expect(formatChapterTimestamp(0)).toBe("0:00");
    expect(formatChapterTimestamp(65_000)).toBe("1:05");
    expect(formatChapterTimestamp(599_000)).toBe("9:59");
  });

  it("formats an hour or more as H:MM:SS", () => {
    expect(formatChapterTimestamp(3_661_000)).toBe("1:01:01");
  });
});

describe("chaptersAsYouTubeDescription", () => {
  it("forces the first chapter to 0:00 (YouTube requires it to recognise the list)", () => {
    const description = chaptersAsYouTubeDescription([
      { startMs: 4_000, title: "Intro" },
      { startMs: 65_000, title: "Main topic" },
    ]);
    expect(description).toBe("0:00 Intro\n1:05 Main topic");
  });

  it("returns an empty string for no chapters", () => {
    expect(chaptersAsYouTubeDescription([])).toBe("");
  });
});
