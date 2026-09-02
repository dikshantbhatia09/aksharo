import { describe, expect, it } from "vitest";

import type { Segment, TranscriptChunk, Word } from "@montaj/edg/schemas";

import {
  EXPORT_MEDIA_TYPES,
  isExportFormat,
  liveWords,
  renderExport,
  timecode,
  toCues,
  TRANSCRIPT_EXPORT_FORMATS,
} from "./transcript-export.js";

import type { ExportInput } from "./transcript-export.js";

function word(n: number, text: string, s: number, e: number, extra: Partial<Word> = {}): Word {
  return { wid: `0:${String(n)}` as Word["wid"], s, e, t: text, ...extra };
}

const CHUNK: TranscriptChunk = {
  chunkIdx: 0,
  startMs: 0,
  endMs: 6_000,
  words: [
    word(0, "Bhai", 320, 768, { sp: "s1" }),
    word(1, "aaj", 808, 1_256, { sp: "s1" }),
    word(2, "matlab", 1_296, 1_744, { sp: "s1", filler: true }),
    word(3, "baat", 1_784, 2_232, { sp: "s1" }),
    word(4, "karenge.", 2_272, 2_720, { sp: "s1" }),
    word(5, "Haan", 3_500, 3_940, { sp: "s2" }),
    word(6, "bilkul.", 3_980, 4_420, { sp: "s2" }),
    word(7, "gone", 4_500, 4_900, { sp: "s2", deleted: true }),
  ],
};

const SEGMENTS: Segment[] = [
  { id: "SEG1", seq: "V", startWordId: "0:0", endWordId: "0:4", startMs: 320, endMs: 2_720 },
  { id: "SEG2", seq: "l", startWordId: "0:5", endWordId: "0:6", startMs: 3_500, endMs: 4_420 },
];

const INPUT: ExportInput = {
  transcriptId: "01JCTRANSCRIPT0000000000000",
  revision: 1,
  language: "hi-Latn",
  chunks: [CHUNK],
  segments: SEGMENTS,
};

describe("transcript exports", () => {
  it("publishes the four formats and their media types", () => {
    expect(TRANSCRIPT_EXPORT_FORMATS).toEqual(["json", "srt", "vtt", "txt"]);
    expect(Object.keys(EXPORT_MEDIA_TYPES).sort()).toEqual(["json", "srt", "txt", "vtt"]);
    expect(isExportFormat("srt")).toBe(true);
    expect(isExportFormat("ass")).toBe(false);
  });

  it("never includes a tombstoned word, and drops fillers only on request", () => {
    expect(liveWords(INPUT).map((entry) => entry.t)).not.toContain("gone");
    expect(liveWords(INPUT).map((entry) => entry.t)).toContain("matlab");
    expect(liveWords({ ...INPUT, dropFillers: true }).map((entry) => entry.t)).not.toContain(
      "matlab",
    );
  });

  it("builds cues from the document's captions when there are any", () => {
    expect(toCues(INPUT)).toEqual([
      { startMs: 320, endMs: 2_720, text: "Bhai aaj matlab baat karenge.", speaker: "s1" },
      { startMs: 3_500, endMs: 4_420, text: "Haan bilkul.", speaker: "s2" },
    ]);
  });

  it("prefers a caption the user retyped", () => {
    const edited: Segment[] = [{ ...(SEGMENTS[0] as Segment), textOverrides: { roman: "Bhai!" } }];
    expect(toCues({ ...INPUT, segments: edited })[0]?.text).toBe("Bhai!");
  });

  it("skips a hidden caption", () => {
    const hidden: Segment[] = [
      { ...(SEGMENTS[0] as Segment), hidden: true },
      SEGMENTS[1] as Segment,
    ];
    expect(toCues({ ...INPUT, segments: hidden })).toHaveLength(1);
  });

  it("groups the words itself when the project has no editing document yet", () => {
    const cues = toCues({ ...INPUT, segments: [] });
    expect(cues.length).toBeGreaterThan(1);
    // A speaker change is always a boundary.
    expect(cues.some((cue) => cue.speaker === "s2")).toBe(true);
    expect(cues.every((cue) => cue.endMs > cue.startMs)).toBe(true);
  });

  it("writes SubRip timecodes with a comma and VTT with a full stop", () => {
    expect(timecode(3_661_234, ",")).toBe("01:01:01,234");
    expect(timecode(3_661_234, ".")).toBe("01:01:01.234");
    expect(timecode(-5, ",")).toBe("00:00:00,000");
  });

  it("renders SRT with numbered cues", () => {
    expect(renderExport("srt", INPUT)).toBe(
      [
        "1",
        "00:00:00,320 --> 00:00:02,720",
        "Bhai aaj matlab baat karenge.",
        "",
        "2",
        "00:00:03,500 --> 00:00:04,420",
        "Haan bilkul.",
        "",
        "",
      ].join("\n"),
    );
  });

  it("renders VTT with its header", () => {
    const vtt = renderExport("vtt", INPUT);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:00.320 --> 00:00:02.720");
  });

  it("renders plain text as speaker-labelled paragraphs with no timings", () => {
    expect(renderExport("txt", INPUT)).toBe(
      "s1: Bhai aaj matlab baat karenge.\n\ns2: Haan bilkul.\n",
    );
    expect(renderExport("txt", INPUT)).not.toContain("-->");
  });

  it("renders JSON with the word ids and timings intact, and says it is source time", () => {
    const parsed = JSON.parse(renderExport("json", INPUT)) as {
      transcriptId: string;
      timebase: string;
      chunks: { words: { wid: string }[] }[];
    };
    expect(parsed.transcriptId).toBe(INPUT.transcriptId);
    expect(parsed.timebase).toBe("source");
    expect(parsed.chunks[0]?.words.map((entry) => entry.wid)).toEqual([
      "0:0",
      "0:1",
      "0:2",
      "0:3",
      "0:4",
      "0:5",
      "0:6",
      "0:7",
    ]);
  });

  it("renders an empty transcript without crashing", () => {
    const empty: ExportInput = { ...INPUT, chunks: [], segments: [] };
    expect(renderExport("srt", empty)).toBe("");
    expect(renderExport("vtt", empty)).toBe("WEBVTT\n\n");
    expect(renderExport("txt", empty)).toBe("\n");
  });

  it("orders chunks by index whatever order they arrive in", () => {
    const second: TranscriptChunk = {
      chunkIdx: 1,
      startMs: 600_000,
      endMs: 601_000,
      words: [{ wid: "1:0" as Word["wid"], s: 600_000, e: 600_400, t: "later" }],
    };
    const parsed = JSON.parse(renderExport("json", { ...INPUT, chunks: [second, CHUNK] })) as {
      chunks: { chunkIdx: number }[];
    };
    expect(parsed.chunks.map((chunk) => chunk.chunkIdx)).toEqual([0, 1]);
  });
});
