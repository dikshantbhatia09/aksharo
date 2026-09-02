import { describe, expect, it } from "vitest";

import {
  isSubtitleKind,
  normaliseText,
  parseSubtitles,
  parseTimestamp,
  stripAssMarkup,
  stripHtml,
  SUBTITLE_KINDS,
  SubtitleParseError,
} from "./subtitle-parsers.js";

const BOM = "﻿";

/** Devanagari, so nothing in the pipeline may assume Latin script. */
const HINDI_ONE = "नमस्ते दोस्तों";
const HINDI_TWO = "आज हम बात करेंगे";

const SRT = [
  "1",
  "00:00:01,000 --> 00:00:03,500",
  HINDI_ONE,
  "",
  "2",
  "00:00:03,500 --> 00:00:06,000",
  `${HINDI_TWO}`,
  "second line",
  "",
].join("\n");

const VTT = [
  "WEBVTT",
  "",
  "NOTE this is a comment block",
  "",
  "cue-1",
  "00:00:01.000 --> 00:00:03.500 align:middle line:90%",
  `<v Priya>${HINDI_ONE}</v>`,
  "",
  "00:00:03.500 --> 00:00:06.000",
  `<i>${HINDI_TWO}</i>`,
  "",
].join("\n");

const ASS = [
  "[Script Info]",
  "Title: A06 fixture",
  "ScriptType: v4.00+",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize",
  "Style: Default,Noto Sans Devanagari,48",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  `Dialogue: 0,0:00:01.00,0:00:03.50,Default,Priya,0,0,0,,{\\an8}${HINDI_ONE}`,
  `Dialogue: 0,0:00:03.50,0:00:06.00,Default,,0,0,0,,${HINDI_TWO}\\Nsecond line, with a comma`,
  "Comment: 0,0:00:06.00,0:00:07.00,Default,,0,0,0,,ignored",
  "",
].join("\n");

describe("normaliseText", () => {
  it("strips a byte-order mark and normalises line endings", () => {
    expect(normaliseText(`${BOM}a\r\nb\rc`)).toBe("a\nb\nc");
  });

  it("leaves a BOM in the middle alone; only a leading one is a marker", () => {
    expect(normaliseText(`a${BOM}b`)).toBe(`a${BOM}b`);
  });
});

describe("parseTimestamp", () => {
  it.each([
    ["00:00:01,000", 1_000],
    ["00:00:01.000", 1_000],
    ["01:02:03,004", 3_723_004],
    ["00:01.500", 1_500],
    ["0:00:01.50", 1_500],
    ["0:00:01.5", 1_500],
  ])("reads %s as %d ms", (value, expected) => {
    expect(parseTimestamp(value)).toBe(expected);
  });

  it.each(["", "abc", "00:99:00,000", "00:00:99,000", "1", "::"])("refuses %j", (bad) => {
    expect(parseTimestamp(bad)).toBeNull();
  });
});

describe("isSubtitleKind", () => {
  it("recognises exactly the four kinds", () => {
    for (const kind of SUBTITLE_KINDS) expect(isSubtitleKind(kind)).toBe(true);
    expect(isSubtitleKind("ssa")).toBe(false);
    expect(isSubtitleKind(7)).toBe(false);
  });
});

describe("SRT", () => {
  it("parses cues, keeping Devanagari byte for byte", () => {
    const parsed = parseSubtitles("srt", SRT);
    expect(parsed.timed).toBe(true);
    expect(parsed.cues).toHaveLength(2);
    expect(parsed.cues[0]).toMatchObject({
      index: 1,
      startMs: 1_000,
      endMs: 3_500,
      text: HINDI_ONE,
    });
    expect(parsed.cues[1]?.text).toBe(`${HINDI_TWO}\nsecond line`);
  });

  it("parses a CRLF file with a BOM, which is what Windows tools write", () => {
    const windows = BOM + SRT.replace(/\n/g, "\r\n");
    const parsed = parseSubtitles("srt", windows);
    expect(parsed.cues).toHaveLength(2);
    expect(parsed.cues[0]?.text).toBe(HINDI_ONE);
  });

  it("tolerates a missing numbering line", () => {
    const parsed = parseSubtitles("srt", "00:00:01,000 --> 00:00:02,000\nhello\n");
    expect(parsed.cues[0]?.text).toBe("hello");
  });

  it("warns about a block it cannot read rather than failing the file", () => {
    const parsed = parseSubtitles("srt", `${SRT}\n99\nnot a timing line\nstill text\n`);
    expect(parsed.cues).toHaveLength(2);
    expect(parsed.warnings.join(" ")).toContain("no timing line");
  });

  it("clamps a cue that ends before it starts, and says so", () => {
    const parsed = parseSubtitles("srt", "1\n00:00:05,000 --> 00:00:01,000\nbackwards\n");
    expect(parsed.cues[0]?.endMs).toBe(5_000);
    expect(parsed.warnings.join(" ")).toContain("ends before it starts");
  });

  it("throws when there is nothing readable at all", () => {
    expect(() => parseSubtitles("srt", "just some prose")).toThrow(SubtitleParseError);
  });
});

describe("WebVTT", () => {
  it("parses cues, skips NOTE blocks and reads the voice span", () => {
    const parsed = parseSubtitles("vtt", VTT);
    expect(parsed.cues).toHaveLength(2);
    expect(parsed.cues[0]).toMatchObject({ startMs: 1_000, endMs: 3_500, speaker: "Priya" });
    expect(parsed.cues[0]?.text).toBe(HINDI_ONE);
    // Cue settings after the end timestamp are positioning, not content.
    expect(parsed.cues[1]?.text).toBe(HINDI_TWO);
  });

  it("accepts a file with no WEBVTT header but says so", () => {
    const parsed = parseSubtitles("vtt", "00:00:01.000 --> 00:00:02.000\nhello\n");
    expect(parsed.cues).toHaveLength(1);
    expect(parsed.warnings.join(" ")).toContain("WEBVTT header");
  });

  it("parses a BOM + CRLF file", () => {
    const parsed = parseSubtitles("vtt", BOM + VTT.replace(/\n/g, "\r\n"));
    expect(parsed.cues).toHaveLength(2);
  });

  it("throws when no cue survives", () => {
    expect(() => parseSubtitles("vtt", "WEBVTT\n\nNOTE only a note\n")).toThrow(SubtitleParseError);
  });
});

describe("ASS", () => {
  it("reads Dialogue lines, honours the Format order and strips override tags", () => {
    const parsed = parseSubtitles("ass", ASS);
    expect(parsed.cues).toHaveLength(2);
    expect(parsed.cues[0]).toMatchObject({
      startMs: 1_000,
      endMs: 3_500,
      speaker: "Priya",
      text: HINDI_ONE,
    });
    // A comma inside Text must not be treated as another field.
    expect(parsed.cues[1]?.text).toBe(`${HINDI_TWO}\nsecond line, with a comma`);
    expect(parsed.cues[1]?.speaker).toBeUndefined();
  });

  it("ignores Comment lines and anything outside [Events]", () => {
    const parsed = parseSubtitles("ass", ASS);
    expect(parsed.cues.some((cue) => cue.text === "ignored")).toBe(false);
  });

  it("parses a BOM + CRLF file", () => {
    const parsed = parseSubtitles("ass", BOM + ASS.replace(/\n/g, "\r\n"));
    expect(parsed.cues).toHaveLength(2);
  });

  it("throws when the file has no Dialogue at all", () => {
    expect(() => parseSubtitles("ass", "[Script Info]\nTitle: nothing\n")).toThrow(
      SubtitleParseError,
    );
  });
});

describe("stripAssMarkup", () => {
  it("removes override blocks and converts hard breaks and spaces", () => {
    expect(stripAssMarkup("{\\an8\\pos(10,20)}line one\\Nline two\\hend")).toBe(
      "line one\nline two end",
    );
  });
});

describe("stripHtml", () => {
  it("keeps the text inside tags", () => {
    expect(stripHtml("<i>hello</i> <b>world</b>")).toBe("hello world");
  });
});

describe("plain text", () => {
  it("makes one untimed cue per non-empty line", () => {
    const parsed = parseSubtitles("txt", `${HINDI_ONE}\n\n  ${HINDI_TWO}  \n`);
    expect(parsed.timed).toBe(false);
    expect(parsed.cues.map((cue) => cue.text)).toEqual([HINDI_ONE, HINDI_TWO]);
    expect(parsed.cues.every((cue) => cue.startMs === 0 && cue.endMs === 0)).toBe(true);
  });

  it("throws on an empty file", () => {
    expect(() => parseSubtitles("txt", "   \n\n")).toThrow(SubtitleParseError);
  });
});
