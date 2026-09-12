import { describe, expect, it } from "vitest";

import {
  joinWords,
  shiftTiming,
  splitLine,
  splitWord,
  toggleEmphasis,
  updateWordText,
  type TimelineLine,
  type TimelineWord,
} from "./timeline-ops.js";

describe("timeline-ops", () => {
  const sampleWord: TimelineWord = {
    id: "w1",
    text: "Namaste",
    cleanText: "namaste",
    startMs: 1000,
    endMs: 2000,
    confidence: 0.95,
    isEmphasized: false,
  };

  it("splits a word into two pieces with distributed timing", () => {
    const [w1, w2] = splitWord(sampleWord, 4);
    expect(w1.text).toBe("Nama");
    expect(w2.text).toBe("ste");
    expect(w1.startMs).toBe(1000);
    expect(w1.endMs).toBe(1571); // 1000 + 1000 * (4/7) rounded
    expect(w2.startMs).toBe(1571);
    expect(w2.endMs).toBe(2000);
  });

  it("joins two adjacent words into one", () => {
    const wordA: TimelineWord = {
      id: "w1",
      text: "Aapka",
      startMs: 1000,
      endMs: 1400,
      confidence: 0.9,
    };
    const wordB: TimelineWord = {
      id: "w2",
      text: "Swagat",
      startMs: 1450,
      endMs: 2000,
      confidence: 0.96,
    };

    const joined = joinWords(wordA, wordB);
    expect(joined.text).toBe("Aapka Swagat");
    expect(joined.cleanText).toBe("aapka swagat");
    expect(joined.startMs).toBe(1000);
    expect(joined.endMs).toBe(2000);
    expect(joined.confidence).toBeCloseTo(0.93, 2);
  });

  it("splits a line at a given word ID", () => {
    const line: TimelineLine = {
      id: "l1",
      lineIndex: 1,
      startMs: 1000,
      endMs: 4000,
      words: [
        { id: "w1", text: "Sabr", startMs: 1000, endMs: 1500 },
        { id: "w2", text: "karo", startMs: 1600, endMs: 2200 },
        { id: "w3", text: "mitr", startMs: 2400, endMs: 4000 },
      ],
    };

    const [l1, l2] = splitLine(line, "w2");
    expect(l1.words.map((w) => w.text)).toEqual(["Sabr"]);
    expect(l2.words.map((w) => w.text)).toEqual(["karo", "mitr"]);
    expect(l1.endMs).toBe(1500);
    expect(l2.startMs).toBe(1600);
    expect(l2.lineIndex).toBe(2);
  });

  it("shifts timing forward and backward with floor at 0", () => {
    const shiftedForward = shiftTiming(sampleWord, 500);
    expect(shiftedForward.startMs).toBe(1500);
    expect(shiftedForward.endMs).toBe(2500);

    const shiftedBackward = shiftTiming(sampleWord, -1500);
    expect(shiftedBackward.startMs).toBe(0);
    expect(shiftedBackward.endMs).toBe(1000);
  });

  it("toggles word emphasis", () => {
    const emphasized = toggleEmphasis(sampleWord);
    expect(emphasized.isEmphasized).toBe(true);

    const reverted = toggleEmphasis(emphasized);
    expect(reverted.isEmphasized).toBe(false);
  });

  it("updates word text and lowercases clean text", () => {
    const updated = updateWordText(sampleWord, "Kalakar");
    expect(updated.text).toBe("Kalakar");
    expect(updated.cleanText).toBe("kalakar");
  });
});
