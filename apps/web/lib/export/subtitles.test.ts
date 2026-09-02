import { describe, expect, it } from "vitest";

import type { EdgProjection } from "@montaj/render-core";
import { buildTimeMap, cutEdit } from "@montaj/timemap";

import { buildSubtitleCues, toSrt, toTxt, toVtt } from "./subtitles";

function projection(): EdgProjection {
  return {
    canvas: { width: 1080, height: 1920 },
    styles: { defaultStyleId: "punch-pop" },
    segments: [
      { id: "s1", seq: "a0", startWordId: "0:0", endWordId: "0:1", startMs: 0, endMs: 1000 },
      { id: "s2", seq: "a1", startWordId: "0:2", endWordId: "0:3", startMs: 2000, endMs: 3000 },
    ],
    words: [
      { wid: "0:0", s: 0, e: 400, t: "hello" },
      { wid: "0:1", s: 400, e: 1000, t: "world" },
      { wid: "0:2", s: 2000, e: 2500, t: "second" },
      { wid: "0:3", s: 2500, e: 3000, t: "line" },
    ],
  };
}

describe("buildSubtitleCues", () => {
  it("produces one cue per segment with no timemap", () => {
    const cues = buildSubtitleCues({ projection: projection(), timemap: null, script: "roman" });
    expect(cues).toEqual([
      { startMs: 0, endMs: 1000, text: "hello world" },
      { startMs: 2000, endMs: 3000, text: "second line" },
    ]);
  });

  it("shifts cue timing by the timemap when a cut is accepted", () => {
    const timemap = buildTimeMap({ sourceDurationMs: 3000, edits: [cutEdit(1000, 2000)] });
    const cues = buildSubtitleCues({ projection: projection(), timemap, script: "roman" });
    expect(cues).toEqual([
      { startMs: 0, endMs: 1000, text: "hello world" },
      { startMs: 1000, endMs: 2000, text: "second line" },
    ]);
  });

  it("drops a segment entirely inside a cut", () => {
    const timemap = buildTimeMap({ sourceDurationMs: 3000, edits: [cutEdit(0, 1500)] });
    const cues = buildSubtitleCues({ projection: projection(), timemap, script: "roman" });
    expect(cues).toEqual([{ startMs: 500, endMs: 1500, text: "second line" }]);
  });

  it("skips a hidden segment", () => {
    const base = projection();
    const p: EdgProjection = {
      ...base,
      segments: [{ ...base.segments[0]!, hidden: true }, base.segments[1]!],
    };
    const cues = buildSubtitleCues({ projection: p, timemap: null, script: "roman" });
    expect(cues).toHaveLength(1);
  });
});

describe("formatters", () => {
  const cues = [
    { startMs: 0, endMs: 1500, text: "hello world" },
    { startMs: 2000, endMs: 3200, text: "second line" },
  ];

  it("formats SRT with comma decimals and 1-based numbering", () => {
    const srt = toSrt(cues);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,500\nhello world");
    expect(srt).toContain("2\n00:00:02,000 --> 00:00:03,200\nsecond line");
  });

  it("formats VTT with a header and dot decimals", () => {
    const vtt = toVtt(cues);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:01.500\nhello world");
  });

  it("formats plain text as one line per cue", () => {
    expect(toTxt(cues)).toBe("hello world\nsecond line\n");
  });

  it("formats an empty cue list", () => {
    expect(toTxt([])).toBe("");
    expect(toSrt([])).toBe("");
  });
});
