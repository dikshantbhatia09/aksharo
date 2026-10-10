import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  escapeAssText,
  exportToASS,
  exportToJSON,
  exportToSRT,
  exportToVTT,
  formatASS,
  formatJSON,
  formatSRT,
  formatTimestampASS,
  formatTimestampSRT,
  formatTimestampVTT,
  formatVTT,
  hexToAssColor,
  type SubtitleLine,
  type SubtitleStyleDoc,
} from "./serializer.js";

const SAMPLE_LINES: SubtitleLine[] = [
  {
    id: "line-1",
    lineIndex: 0,
    startMs: 1200,
    endMs: 3500,
    speaker: "Host",
    words: [
      { id: "w-1", text: "This", startMs: 1200, endMs: 1550 },
      { id: "w-2", text: "is", startMs: 1550, endMs: 1950 },
      { id: "w-3", text: "viral!", startMs: 1950, endMs: 3500, isEmphasized: true },
    ],
  },
  {
    id: "line-2",
    lineIndex: 1,
    startMs: 3600,
    endMs: 6000,
    speaker: "Guest",
    words: [
      { id: "w-4", text: "Welcome", startMs: 3600, endMs: 4200 },
      { id: "w-5", text: "to", startMs: 4200, endMs: 4500 },
      { id: "w-6", text: "Aksharo.", startMs: 4500, endMs: 6000 },
    ],
  },
];

const SAMPLE_STYLE: SubtitleStyleDoc = {
  id: "hormozi-bold",
  name: "Hormozi",
  typography: {
    fontFamily: "Montserrat",
    fontSize: 64,
    fontWeight: "bold",
  },
  colors: {
    primary: "#FFFF00",
    secondary: "#FFFFFF",
    outline: "#000000",
    shadow: "#111111",
  },
  layout: {
    alignment: 2,
    marginV: 150,
  },
};

describe("Universal Subtitle Serializer Engine", () => {
  describe("SRT Formatter (exportToSRT)", () => {
    it("exports valid SubRip format with numbered cues and HH:MM:SS,mmm timestamps", () => {
      const srt = exportToSRT(SAMPLE_LINES);
      assert.ok(srt.includes("1\n00:00:01,200 --> 00:00:03,500\nThis is viral!\n"));
      assert.ok(srt.includes("2\n00:00:03,600 --> 00:00:06,000\nWelcome to Aksharo.\n"));

      const timeRangeRegex = /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/m;
      assert.match(srt, timeRangeRegex);
    });

    it("supports formatSRT alias", () => {
      assert.equal(formatSRT(SAMPLE_LINES), exportToSRT(SAMPLE_LINES));
    });

    it("handles second-based timestamps (startSec / endSec) gracefully", () => {
      const secLines: SubtitleLine[] = [
        {
          text: "Second-based timing",
          startSec: 1.5,
          endSec: 4.25,
        },
      ];
      const srt = exportToSRT(secLines);
      assert.ok(srt.includes("00:00:01,500 --> 00:00:04,250"));
      assert.ok(srt.includes("Second-based timing"));
    });

    it("returns empty string for empty line input", () => {
      assert.equal(exportToSRT([]), "");
    });
  });

  describe("WebVTT Formatter (exportToVTT)", () => {
    it("exports valid WebVTT format starting with WEBVTT and dot-millisecond timestamps", () => {
      const vtt = exportToVTT(SAMPLE_LINES);
      assert.ok(vtt.startsWith("WEBVTT\n\n"));
      assert.ok(vtt.includes("00:00:01.200 --> 00:00:03.500\nThis is viral!\n"));
      assert.ok(vtt.includes("00:00:03.600 --> 00:00:06.000\nWelcome to Aksharo.\n"));

      const vttTimeRegex = /^\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}$/m;
      assert.match(vtt, vttTimeRegex);
    });

    it("supports formatVTT alias", () => {
      assert.equal(formatVTT(SAMPLE_LINES), exportToVTT(SAMPLE_LINES));
    });

    it("returns valid header for empty input", () => {
      assert.equal(exportToVTT([]), "WEBVTT\n\n");
    });
  });

  describe("ASS Formatter (exportToASS)", () => {
    it("exports valid ASS v4.00+ with [Script Info], [V4+ Styles], and karaoke tags", () => {
      const ass = exportToASS(SAMPLE_LINES, SAMPLE_STYLE);
      assert.ok(ass.includes("[Script Info]"));
      assert.ok(ass.includes("ScriptType: v4.00+"));
      assert.ok(ass.includes("PlayResX: 1080"));
      assert.ok(ass.includes("PlayResY: 1920"));

      assert.ok(ass.includes("[V4+ Styles]"));
      assert.ok(ass.includes("Style: Hormozi,Montserrat,64,"));

      assert.ok(ass.includes("[Events]"));
      assert.ok(ass.includes("Dialogue: 0,0:00:01.20,0:00:03.50,Hormozi,,0,0,0,,{\\k35}This {\\k40}is {\\k155}viral!"));
      assert.ok(ass.includes("Dialogue: 0,0:00:03.60,0:00:06.00,Hormozi,,0,0,0,,{\\k60}Welcome {\\k30}to {\\k150}Aksharo."));

      const assDialogueRegex = /^Dialogue: 0,\d+:\d{2}:\d{2}\.\d{2},\d+:\d{2}:\d{2}\.\d{2},/m;
      assert.match(ass, assDialogueRegex);
    });

    it("supports formatASS alias", () => {
      assert.equal(formatASS(SAMPLE_LINES, SAMPLE_STYLE), exportToASS(SAMPLE_LINES, SAMPLE_STYLE));
    });

    it("escapes special characters in ASS text", () => {
      assert.equal(escapeAssText("Hello {World} \\ test\nnewline"), "Hello \\{World\\} \\\\ test\\Nnewline");
    });

    it("converts CSS hex colors to ASS &HAABBGGRR format", () => {
      // #FFFF00 -> Blue 00, Green FF, Red FF -> &H0000FFFF
      assert.equal(hexToAssColor("#FFFF00"), "&H0000FFFF");
      // #FF0000 -> Blue 00, Green 00, Red FF -> &H000000FF
      assert.equal(hexToAssColor("#FF0000"), "&H000000FF");
      // #0000FF -> Blue FF, Green 00, Red 00 -> &H00FF0000
      assert.equal(hexToAssColor("#0000FF"), "&H00FF0000");
    });
  });

  describe("Remotion / Timeline JSON Formatter (exportToJSON)", () => {
    it("exports structured JSON with cues, words, and exact millisecond/second coordinates", () => {
      const jsonStr = exportToJSON(SAMPLE_LINES);
      const parsed = JSON.parse(jsonStr);

      assert.equal(parsed.version, "1.0");
      assert.equal(parsed.timebase, "source");
      assert.equal(parsed.totalLines, 2);
      assert.equal(parsed.totalWords, 6);

      assert.equal(parsed.lines[0].text, "This is viral!");
      assert.equal(parsed.lines[0].startMs, 1200);
      assert.equal(parsed.lines[0].endMs, 3500);
      assert.equal(parsed.lines[0].startSec, 1.2);
      assert.equal(parsed.lines[0].endSec, 3.5);

      assert.equal(parsed.lines[0].words[2].text, "viral!");
      assert.equal(parsed.lines[0].words[2].isEmphasized, true);
    });

    it("supports formatJSON alias", () => {
      assert.equal(formatJSON(SAMPLE_LINES), exportToJSON(SAMPLE_LINES));
    });
  });

  describe("Performance SLA", () => {
    it("serializes 500 lines in < 150ms", () => {
      const largeLines: SubtitleLine[] = Array.from({ length: 500 }, (_, i) => ({
        id: `line-${i}`,
        lineIndex: i,
        startMs: i * 2000,
        endMs: i * 2000 + 1800,
        words: [
          { id: `w-${i}-1`, text: "WordOne", startMs: i * 2000, endMs: i * 2000 + 500 },
          { id: `w-${i}-2`, text: "WordTwo", startMs: i * 2000 + 500, endMs: i * 2000 + 1000 },
          { id: `w-${i}-3`, text: "WordThree", startMs: i * 2000 + 1000, endMs: i * 2000 + 1800 },
        ],
      }));

      const start = performance.now();
      const srt = exportToSRT(largeLines);
      const vtt = exportToVTT(largeLines);
      const ass = exportToASS(largeLines, SAMPLE_STYLE);
      const json = exportToJSON(largeLines);
      const elapsedMs = performance.now() - start;

      assert.ok(srt.length > 0);
      assert.ok(vtt.length > 0);
      assert.ok(ass.length > 0);
      assert.ok(json.length > 0);
      assert.ok(elapsedMs < 150, `Serialization took ${elapsedMs}ms, exceeding 150ms SLA`);
    });
  });
});

