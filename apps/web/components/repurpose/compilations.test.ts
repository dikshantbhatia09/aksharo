import { describe, expect, it } from "vitest";

import type {
  RepurposeCandidateItem,
  RepurposeClipFormat,
  RepurposeClipItem,
} from "@montaj/api-client";

import * as web from "./compilations";
import * as contracts from "../../../../packages/repurpose-contracts/src/compilations";

const {
  COMPILATION_COPY,
  COMPILATION_LIMITS,
  bestOf,
  compilationFailureCopy,
  compilationOutputMs,
  compilationSummary,
  formatLength,
  moved,
  pickableClips,
  seriesClips,
} = web;

function format(
  shape: RepurposeClipFormat["shape"],
  durationMs: number | null,
  status: RepurposeClipFormat["status"] = "ready",
): RepurposeClipFormat {
  return {
    shape,
    status,
    projectId: "01JCPR0JECT000000000000000",
    captioned: {
      status: status === "ready" ? "ready" : "rendering",
      playUrl: status === "ready" ? "https://x/play" : null,
      downloadUrl: status === "ready" ? "https://x/dl" : null,
      durationMs,
    },
    cleanUrl: null,
  };
}

function clip(id: string, candidateId: string, startMs: number, formats: RepurposeClipFormat[]) {
  return {
    id,
    candidateId,
    state: "ready",
    sourceStartMs: startMs,
    sourceEndMs: startMs + 30_000,
    formats,
  } satisfies RepurposeClipItem;
}

const candidates: RepurposeCandidateItem[] = [
  { id: "c1", startMs: 60_000, endMs: 90_000, title: "Second in the video", potentialScore: 91 },
  { id: "c2", startMs: 10_000, endMs: 40_000, title: "First in the video", potentialScore: 70 },
  { id: "c3", startMs: 200_000, endMs: 230_000, title: "Mine", potentialScore: null },
  {
    id: "c4",
    startMs: 300_000,
    endMs: 330_000,
    title: "Removed",
    potentialScore: 99,
    state: "rejected",
  },
];

const clips: RepurposeClipItem[] = [
  clip("k1", "c1", 60_000, [format("9:16", 28_000), format("1:1", null, "rendering")]),
  clip("k2", "c2", 10_000, [format("9:16", 31_000), format("1:1", 31_000)]),
  clip("k3", "c3", 200_000, [format("9:16", 25_000)]),
  clip("k4", "c4", 300_000, [format("9:16", 25_000)]),
  { id: "k5", candidateId: "c5", state: "cutting" },
];

describe("the run page's copy of the compilation rules", () => {
  it("is the contracts package's, word for word", () => {
    expect(web.COMPILATION_LIMITS).toEqual(contracts.COMPILATION_LIMITS);
    expect(web.SERIES_LIMITS).toEqual(contracts.SERIES_LIMITS);
    for (const input of [
      { clipsMs: [31_500, 28_000], introMs: 2_000 },
      { clipsMs: [3_000, 2_520], fadeMs: 500 },
      { clipsMs: [10_000] },
      { clipsMs: [] },
    ]) {
      expect(compilationOutputMs(input)).toBe(contracts.compilationOutputMs(input));
    }
  });
});

describe("pickableClips (2026-10-03)", () => {
  it("offers the clips whose captioned video in the shape is made, in the video's order", () => {
    expect(pickableClips(clips, candidates, "9:16").map((entry) => entry.clipId)).toEqual([
      "k2",
      "k1",
      "k3",
    ]);
    const [first] = pickableClips(clips, candidates, "9:16");
    expect(first).toEqual({
      clipId: "k2",
      title: "First in the video",
      startMs: 10_000,
      durationMs: 31_000,
      potential: 70,
    });
    // k1's square video is still being made.
    expect(pickableClips(clips, candidates, "1:1").map((entry) => entry.clipId)).toEqual(["k2"]);
  });

  it("offers every made clip for a series, never a removed moment's", () => {
    expect([...seriesClips(clips, candidates)].sort()).toEqual(["k1", "k2", "k3"]);
  });
});

describe("bestOf", () => {
  const pickable = pickableClips(clips, candidates, "9:16");

  it("takes the strongest clips within the length, then plays them in the video's order", () => {
    // k1 (91) then k2 (70) fit in a minute; k3, a person's own pick, would not.
    expect(bestOf(pickable, 60_000, false)).toEqual(["k2", "k1"]);
    expect(bestOf(pickable, 10 * 60_000, true)).toEqual(["k2", "k1", "k3"]);
  });

  it("takes two however short the length, when there are two", () => {
    expect(bestOf(pickable, 1_000, false)).toHaveLength(2);
  });
});

describe("the small helpers", () => {
  it("moves an entry up and down, and never out of the list", () => {
    expect(moved(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moved(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moved(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moved(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });

  it("says a length and a summary a person reads", () => {
    expect(formatLength(65_400)).toBe("1:05");
    expect(
      compilationSummary({
        id: "x",
        runId: "r",
        shape: "4:5",
        title: null,
        clipIds: ["a", "b", "c"],
        status: "ready",
        failureCode: null,
        durationMs: 90_000,
        progress: null,
        playUrl: null,
        downloadUrl: null,
        expiresAt: null,
        stale: false,
        canRetry: false,
        createdAt: "",
        updatedAt: "",
      }),
    ).toBe("Portrait 4:5 · 3 clips · 1:30");
  });

  it("has words for every way a compilation ends, and no technical ones", () => {
    const codes = [
      "repurpose/compilation_source_gone",
      "repurpose/compilation_too_long",
      "repurpose/compilation_cancelled",
      "repurpose/compilation_stalled",
      "repurpose/compilation_no_credits",
      "repurpose/compilation_failed",
      null,
    ];
    const words = [...codes.map(compilationFailureCopy), ...Object.values(COMPILATION_COPY)];
    for (const sentence of words) {
      expect(sentence).not.toMatch(/\b(job|queue|render\.|ffmpeg|export row|payload|null)\b/i);
    }
    expect(COMPILATION_LIMITS.maxClips).toBe(20);
  });
});
