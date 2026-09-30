import { describe, expect, it } from "vitest";

import { ApiError } from "@montaj/api-client";

import {
  ago,
  compactCount,
  day,
  describePerformanceError,
  percent,
  provenance,
  readingLine,
  until,
} from "./copy";

import type { ClipPost } from "./use-performance";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const HOUR = 60 * 60_000;

function post(overrides: Partial<ClipPost> = {}): ClipPost {
  return {
    id: "p",
    runId: "r",
    clipId: "c",
    platform: "instagram",
    platformLabel: "Instagram",
    shape: "9:16",
    language: null,
    source: "postiz",
    url: null,
    postedAt: null,
    numbers: { views: null, likes: null, comments: null, shares: null },
    engagementRate: null,
    reading: { state: "reading", nextAt: null, note: null },
    canRemove: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("numbers as a person says them", () => {
  it("shortens counts", () => {
    expect(compactCount(0)).toBe("0");
    expect(compactCount(950)).toBe("950");
    expect(compactCount(1_000)).toBe("1k");
    expect(compactCount(12_400)).toBe("12.4k");
    expect(compactCount(999_960)).toBe("1M");
    expect(compactCount(1_500_000)).toBe("1.5M");
  });

  it("gives rates as percentages", () => {
    expect(percent(0.042)).toBe("4.2%");
    expect(percent(0.16)).toBe("16%");
  });

  it("says when, both ways", () => {
    expect(ago(new Date(NOW - 30_000).toISOString(), NOW)).toBe("just now");
    expect(ago(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5 min ago");
    expect(ago(new Date(NOW - 3 * HOUR).toISOString(), NOW)).toBe("3 h ago");
    expect(ago(new Date(NOW - 26 * HOUR).toISOString(), NOW)).toBe("1 day ago");
    expect(ago("2026-09-01T00:00:00.000Z", NOW)).toBe("on 1 Sept");
    expect(until(new Date(NOW + 20 * 60_000).toISOString(), NOW)).toBe("in 20 min");
    expect(until(new Date(NOW + 5 * HOUR).toISOString(), NOW)).toBe("in 5 h");
    expect(until(new Date(NOW + 72 * HOUR).toISOString(), NOW)).toBe("in 3 days");
    expect(until(new Date(NOW - HOUR).toISOString(), NOW)).toBe("soon");
    expect(day("2026-10-03T12:00:00.000Z")).toBe("3 Oct");
  });
});

describe("provenance", () => {
  it("never passes an entered number off as measured", () => {
    const at = new Date(NOW - 2 * HOUR).toISOString();
    const typed = new Date(NOW - 50 * HOUR).toISOString();
    expect(
      provenance(
        post({
          numbers: {
            views: { value: 1, source: "postiz", measured: true, at },
            likes: { value: 1, source: "postiz", measured: true, at },
            comments: { value: 1, source: "person", measured: false, at: typed },
            shares: { value: 1, source: "person", measured: false, at: typed },
          },
        }),
        NOW,
      ),
    ).toBe(
      "Views and likes measured from Instagram 2 h ago · comments and shares entered 2 days ago.",
    );
    expect(provenance(post(), NOW)).toBe("");
  });
});

describe("readingLine", () => {
  it("says when a post is read next, or what its note says", () => {
    expect(
      readingLine(
        post({
          reading: { state: "reading", nextAt: new Date(NOW + HOUR).toISOString(), note: null },
        }),
        NOW,
      ),
    ).toBe("Read again in 1 h.");
    expect(
      readingLine(
        post({
          reading: { state: "reading", nextAt: new Date(NOW - HOUR).toISOString(), note: null },
        }),
        NOW,
      ),
    ).toBe("Being read.");
    expect(
      readingLine(
        post({ reading: { state: "done", nextAt: null, note: "Its first month is read." } }),
      ),
    ).toBe("Its first month is read.");
  });
});

describe("describePerformanceError", () => {
  it("maps each refusal to a sentence, and anything else to a safe one", () => {
    const refusal = (status: number, code: string): ApiError =>
      new ApiError({ status, code, message: "raw server words", details: undefined });
    expect(describePerformanceError(refusal(409, "performance/post_exists"))).toBe(
      "This post is already recorded.",
    );
    expect(describePerformanceError(refusal(429, "common/rate_limited"))).toBe(
      "Too many changes at once. Wait a minute, then try again.",
    );
    expect(describePerformanceError(refusal(500, "common/internal"))).toBe(
      "That did not work. Try again in a moment.",
    );
    expect(describePerformanceError(new Error("boom"))).toBe(
      "That did not work. Try again in a moment.",
    );
  });
});
