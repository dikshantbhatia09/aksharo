import { describe, expect, it } from "vitest";

import { buildTimeMap, cutEdit } from "@montaj/timemap";

import {
  buildCues,
  formatTimestamp,
  isSupportedFormat,
  MIN_CUE_MS,
  renderSidecar,
  segmentText,
  SubtitleError,
  SUPPORTED_SUBTITLE_FORMATS,
  toMarkdown,
  toSrt,
  toTxt,
  toVtt,
} from "./subtitles.js";

import type { RenderProjection } from "./queues.js";

const projection: RenderProjection = {
  canvas: { width: 1080, height: 1920 },
  segments: [
    {
      id: "s1",
      seq: "V",
      startMs: 0,
      endMs: 2_000,
      startWordId: "0:0",
      endWordId: "0:1",
    },
    {
      id: "s2",
      seq: "l",
      startMs: 2_000,
      endMs: 4_000,
      startWordId: "0:2",
      endWordId: "0:3",
      textOverrides: { en: "Cut it, it is simple" },
    },
    {
      id: "s3",
      seq: "m",
      startMs: 4_000,
      endMs: 6_000,
      startWordId: "0:4",
      endWordId: "0:4",
      hidden: true,
    },
  ],
  words: [
    { wid: "0:0", s: 0, e: 900, t: "Bhai", sp: "sp1", scripts: { roman: "Bhai", native: "भाई" } },
    { wid: "0:1", s: 900, e: 2_000, t: "aaj", sp: "sp1", scripts: { roman: "aaj", native: "आज" } },
    { wid: "0:2", s: 2_000, e: 3_000, t: "kaato", sp: "sp2", filler: true },
    { wid: "0:3", s: 3_000, e: 4_000, t: "bas", sp: "sp2" },
    { wid: "0:4", s: 4_000, e: 6_000, t: "hidden" },
  ],
};

describe("timestamps", () => {
  it("writes SRT commas and VTT dots", () => {
    expect(formatTimestamp(3_661_042, ",")).toBe("01:01:01,042");
    expect(formatTimestamp(3_661_042, ".")).toBe("01:01:01.042");
  });

  it("never writes a negative time", () => {
    expect(formatTimestamp(-5, ",")).toBe("00:00:00,000");
  });
});

describe("segment text", () => {
  it("joins the words of the requested script", () => {
    expect(segmentText(projection, 0, "native", false).text).toBe("भाई आज");
    expect(segmentText(projection, 0, "roman", false).text).toBe("Bhai aaj");
  });

  it("falls back to the literal text when the script is missing", () => {
    expect(segmentText(projection, 1, "native", false).text).toBe("kaato bas");
  });

  it("prefers an override, which is what the editor typed", () => {
    expect(segmentText(projection, 1, "en", false).text).toBe("Cut it, it is simple");
  });

  it("drops fillers when asked", () => {
    expect(segmentText(projection, 1, "roman", true).text).toBe("bas");
  });

  it("reports the speaker of the first word", () => {
    expect(segmentText(projection, 0, "roman", false).speaker).toBe("sp1");
  });

  it("answers empty for a segment that is not there", () => {
    expect(segmentText(projection, 99, "roman", false)).toEqual({
      text: "",
      speaker: undefined,
    });
  });
});

describe("cues", () => {
  it("skips a hidden segment", () => {
    const cues = buildCues({ projection, timemap: null, script: "roman" });
    expect(cues.map((cue) => cue.text)).toEqual(["Bhai aaj", "kaato bas"]);
    expect(cues[0]?.index).toBe(1);
    expect(cues[1]?.index).toBe(2);
  });

  it("uses source time when there is no timemap", () => {
    const cues = buildCues({ projection, timemap: null, script: "roman" });
    expect(cues[1]?.startMs).toBe(2_000);
  });

  it("moves every cue onto the output clock", () => {
    // Without this a sidecar drifts later and later through the file, by exactly
    // the length of the cuts before it — the drift D30 exists to prevent.
    const timemap = buildTimeMap({ sourceDurationMs: 6_000, edits: [cutEdit(0, 1_000)] });
    const cues = buildCues({ projection, timemap, script: "roman" });
    expect(cues[0]?.startMs).toBe(0);
    expect(cues[1]?.startMs).toBe(1_000);
  });

  it("splits a segment that straddles a splice into two cues", () => {
    // One cue across the splice would be on screen over footage that no longer
    // contains its words.
    const timemap = buildTimeMap({ sourceDurationMs: 6_000, edits: [cutEdit(800, 1_200)] });
    const cues = buildCues({ projection, timemap, script: "roman" });
    const first = cues.filter((cue) => cue.text === "Bhai aaj");
    expect(first).toHaveLength(2);
    expect(first[0]?.endMs).toBe(800);
    expect(first[1]?.startMs).toBe(800);
  });

  it("drops a fragment too short to read", () => {
    const timemap = buildTimeMap({
      sourceDurationMs: 6_000,
      edits: [cutEdit(20, 1_980)],
    });
    const cues = buildCues({ projection, timemap, script: "roman", minCueMs: MIN_CUE_MS });
    expect(cues.some((cue) => cue.endMs - cue.startMs < MIN_CUE_MS)).toBe(false);
  });

  it("drops a segment whose every word was a filler", () => {
    const cues = buildCues({ projection, timemap: null, script: "roman", dropFillers: true });
    expect(cues.map((cue) => cue.text)).toEqual(["Bhai aaj", "bas"]);
  });

  it("numbers the cues in output order, not in segment order", () => {
    const shuffled: RenderProjection = {
      ...projection,
      segments: [...projection.segments].reverse(),
    };
    const cues = buildCues({ projection: shuffled, timemap: null, script: "roman" });
    expect(cues.map((cue) => cue.index)).toEqual([1, 2]);
    expect(cues[0]?.startMs).toBeLessThan(cues[1]?.startMs ?? 0);
  });
});

describe("the formats", () => {
  const cues = buildCues({ projection, timemap: null, script: "roman" });

  it("names only the formats this service writes", () => {
    expect(SUPPORTED_SUBTITLE_FORMATS).toEqual(["srt", "vtt", "txt", "md"]);
    expect(isSupportedFormat("srt")).toBe(true);
    expect(isSupportedFormat("ass")).toBe(false);
  });

  it("writes SubRip with CRLF and comma timestamps", () => {
    const srt = toSrt(cues);
    expect(srt).toContain("1\r\n00:00:00,000 --> 00:00:02,000\r\nBhai aaj\r\n");
    expect(srt).toContain("2\r\n00:00:02,000 --> 00:00:04,000\r\n");
  });

  it("writes WebVTT with its header and dot timestamps", () => {
    const vtt = toVtt(cues);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:02.000");
    expect(vtt).not.toContain("\r");
  });

  it("writes plain text with no timing", () => {
    expect(toTxt(cues)).toBe("Bhai aaj\nkaato bas\n");
  });

  it("writes Markdown with speaker headings", () => {
    const markdown = toMarkdown(cues);
    expect(markdown).toContain("# Transcript");
    expect(markdown).toContain("**sp1**");
    expect(markdown).toContain("**sp2**");
    expect(markdown).toContain("`00:00:00` Bhai aaj");
  });

  it("dispatches on the format name", () => {
    expect(renderSidecar("srt", cues)).toBe(toSrt(cues));
    expect(renderSidecar("vtt", cues)).toBe(toVtt(cues));
    expect(renderSidecar("txt", cues)).toBe(toTxt(cues));
    expect(renderSidecar("md", cues)).toBe(toMarkdown(cues));
  });

  it("refuses ASS, which A18a owns", () => {
    expect(() => renderSidecar("ass", cues)).toThrow(SubtitleError);
    expect(() => renderSidecar("ass", cues)).toThrow(/ass-exporter/);
  });

  it("writes an empty file rather than crashing on no cues", () => {
    expect(toSrt([])).toBe("");
    expect(toVtt([])).toBe("WEBVTT\n\n");
    expect(toTxt([])).toBe("\n");
    expect(toMarkdown([])).toBe("# Transcript\n");
  });
});
