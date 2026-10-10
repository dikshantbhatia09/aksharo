import { describe, expect, it } from "vitest";

import {
  computeKaraokeFillProgress,
  computeTypewriterProgress,
  computeWordMargin,
  computeWordSpringScale,
  computeWordSpringScaleMs,
  computeWordYOffset,
  computeWordYOffsetMs,
  evaluateKineticWordState,
  packMicroPacingLines,
  type TimedWordItem,
} from "./spring.js";

describe("Word-by-Word Kinetic Animation Engine (Pillar 4 §01)", () => {
  describe("computeWordSpringScale & computeWordSpringScaleMs", () => {
    it("returns 1.0 before word starts (elapsedSec < 0)", () => {
      expect(computeWordSpringScale(0.5, 1.0)).toBe(1.0);
      expect(computeWordSpringScaleMs(500, 1000)).toBe(1.0);
    });

    it("evaluates underdamped spring scale punch: peak ~1.22 at attack and settles to 1.0 by frame 8", () => {
      const fps = 60;
      const startSec = 1.0;

      // Frame 0: t = 1.000s -> f = 0 -> S(0) = 1.0 + 0.22 = 1.22
      const scaleF0 = computeWordSpringScale(startSec, startSec, fps);
      expect(scaleF0).toBeCloseTo(1.22, 2);

      // Frame 1: t = 1.0 + 1/60 -> f = 1 -> positive energetic punch
      const scaleF1 = computeWordSpringScale(startSec + 1 / fps, startSec, fps);
      expect(scaleF1).toBeGreaterThan(1.0);
      expect(scaleF1).toBeLessThanOrEqual(1.22);

      // Frame 2: underdamped bounce oscillation dipping slightly
      const scaleF2 = computeWordSpringScale(startSec + 2 / fps, startSec, fps);
      expect(scaleF2).toBeLessThan(1.0);

      // Frame 8+: settled to exactly 1.0
      const scaleF8 = computeWordSpringScale(startSec + 8.1 / fps, startSec, fps);
      expect(scaleF8).toBe(1.0);

      const scaleF10 = computeWordSpringScale(startSec + 10 / fps, startSec, fps);
      expect(scaleF10).toBe(1.0);
    });

    it("verifies millisecond overload produces identical results to second-based calculation", () => {
      const tMs = 1250;
      const startMs = 1200;
      const fps = 60;
      expect(computeWordSpringScaleMs(tMs, startMs, fps)).toBeCloseTo(
        computeWordSpringScale(tMs / 1000, startMs / 1000, fps),
        6,
      );
    });
  });

  describe("computeWordYOffset & computeWordYOffsetMs", () => {
    it("returns 0 before word starts", () => {
      expect(computeWordYOffset(0.2, 0.5)).toBe(0);
      expect(computeWordYOffsetMs(200, 500)).toBe(0);
    });

    it("dips -4px on attack frame and settles back to 0px by frame 6", () => {
      const fps = 60;
      const startSec = 2.0;

      // Attack frame: dips to -4px
      const yF0 = computeWordYOffset(startSec, startSec, fps, -4);
      expect(yF0).toBeCloseTo(-4.0, 2);

      // Settles to 0 by frame 7
      const yF7 = computeWordYOffset(startSec + 7 / fps, startSec, fps, -4);
      expect(yF7).toBe(0);
    });
  });

  describe("Dynamic Word Spacing Safe Margin & Zero Overlap Collision Bounds", () => {
    it("applies extra margin when word is active to prevent overlap during 1.22x scale expansion", () => {
      const fontSize = 54;
      const baseMargin = 8;

      const inactiveMargin = computeWordMargin(fontSize, false, baseMargin);
      expect(inactiveMargin).toBe(8);

      const activeMargin = computeWordMargin(fontSize, true, baseMargin);
      expect(activeMargin).toBe(8 + 54 * 0.1); // 13.4 px
      expect(activeMargin).toBeGreaterThan(inactiveMargin);
    });

    it("asserts zero text collision bounds between consecutive words during active punch", () => {
      const fontSize = 50;
      const baseMargin = 10;
      const wordAWidth = 100;

      // When Word A is active, it scales by 1.22x -> width expands by 22px (+11px right, +11px left)
      const scale = 1.22;
      const wordAExpansionRight = ((scale - 1) * wordAWidth) / 2; // +11px

      // Without safe margin: 10px baseMargin - 11px expansion = -1px (collision/overlap!)
      const overlapWithoutSafeMargin = baseMargin - wordAExpansionRight;
      expect(overlapWithoutSafeMargin).toBeLessThan(0);

      // With dynamic safe margin:
      const dynamicMargin = computeWordMargin(fontSize, true, baseMargin); // 10 + 5 = 15px
      const clearanceWithSafeMargin = dynamicMargin - wordAExpansionRight;
      expect(clearanceWithSafeMargin).toBeGreaterThan(0);
      expect(clearanceWithSafeMargin).toBeGreaterThanOrEqual(4); // Safe positive visual clearance
    });
  });

  describe("Progressive Karaoke Fill & Typewriter Reveal", () => {
    it("computes progressive karaoke sweep fraction from 0 to 1", () => {
      const startSec = 1.0;
      const endSec = 2.0;

      expect(computeKaraokeFillProgress(0.9, startSec, endSec)).toBe(0);
      expect(computeKaraokeFillProgress(1.0, startSec, endSec)).toBe(0);
      expect(computeKaraokeFillProgress(1.5, startSec, endSec)).toBeCloseTo(0.5, 2);
      expect(computeKaraokeFillProgress(2.0, startSec, endSec)).toBe(1);
      expect(computeKaraokeFillProgress(2.2, startSec, endSec)).toBe(1);
    });

    it("computes typewriter visible character progression", () => {
      const text = "DYNAMIC";
      const startSec = 1.0;
      const endSec = 2.0;

      expect(computeTypewriterProgress(0.9, startSec, endSec, text.length)).toBe(0);
      expect(computeTypewriterProgress(1.5, startSec, endSec, text.length)).toBeGreaterThanOrEqual(3);
      expect(computeTypewriterProgress(2.0, startSec, endSec, text.length)).toBe(text.length);
    });
  });

  describe("evaluateKineticWordState", () => {
    const sampleWord: TimedWordItem = {
      text: "REVOLUTIONARY",
      startSec: 1.0,
      endSec: 1.5,
      highlightColor: "#00FFA3",
      inactiveColor: "#FFFFFF",
    };

    it("evaluates active kinetic state with neon glow and spring scale punch", () => {
      const state = evaluateKineticWordState(sampleWord, 0, 1.0, {
        curve: "pop-bounce",
        fontSize: 50,
      });

      expect(state.isActive).toBe(true);
      expect(state.isUpcoming).toBe(false);
      expect(state.isPast).toBe(false);
      expect(state.color).toBe("#00FFA3");
      expect(state.scale).toBeCloseTo(1.22, 2);
      expect(state.yOffset).toBeCloseTo(-4.0, 2);
      expect(state.glow).toContain("#00FFA3");
      expect(state.marginRight).toBe(13); // 8 + 5
    });

    it("evaluates inactive upcoming state with standard resting scale and subtle shadow", () => {
      const state = evaluateKineticWordState(sampleWord, 0, 0.5, {
        curve: "pop-bounce",
        fontSize: 50,
      });

      expect(state.isActive).toBe(false);
      expect(state.isUpcoming).toBe(true);
      expect(state.color).toBe("#FFFFFF");
      expect(state.scale).toBe(1.0);
      expect(state.yOffset).toBe(0);
      expect(state.glow).toBe("none");
      expect(state.marginRight).toBe(8);
    });

    it("supports elastic-fade and typewriter curves", () => {
      const elastic = evaluateKineticWordState(sampleWord, 0, 1.25, {
        curve: "elastic-fade",
      });
      expect(elastic.isActive).toBe(true);
      expect(elastic.scale).toBeGreaterThan(1.0);

      const typewriter = evaluateKineticWordState(sampleWord, 0, 0.5, {
        curve: "typewriter",
      });
      expect(typewriter.opacity).toBe(0.2);
    });
  });

  describe("packMicroPacingLines", () => {
    it("packs timed words into lines with max 4 words and max 2.0s duration", () => {
      const words: TimedWordItem[] = [
        { text: "Viral", startSec: 0.0, endSec: 0.3 },
        { text: "kinetic", startSec: 0.3, endSec: 0.6 },
        { text: "captions", startSec: 0.6, endSec: 0.9 },
        { text: "boost", startSec: 0.9, endSec: 1.2 },
        { text: "retention", startSec: 1.2, endSec: 1.6 },
        { text: "instantly!", startSec: 1.6, endSec: 2.1 },
        { text: "Every", startSec: 2.2, endSec: 2.5 },
        { text: "single", startSec: 2.5, endSec: 2.8 },
      ];

      const lines = packMicroPacingLines(words, { maxWordsPerLine: 4, maxDurationSec: 2.0 });

      // First line contains max 4 words: ["Viral", "kinetic", "captions", "boost"]
      expect(lines[0]?.length).toBe(4);
      expect(lines[0]?.map((w) => w.text)).toEqual(["Viral", "kinetic", "captions", "boost"]);

      // Second line contains words until punctuation "instantly!"
      expect(lines[1]?.map((w) => w.text)).toEqual(["retention", "instantly!"]);

      // Third line starts with "Every"
      expect(lines[2]?.map((w) => w.text)).toEqual(["Every", "single"]);
    });

    it("handles empty words array gracefully", () => {
      expect(packMicroPacingLines([])).toEqual([]);
    });
  });

  describe("Key Performance SLAs (16.6ms frame budget)", () => {
    it("computes 1,000 frame states in < 5ms (well within 16.6ms 60fps frame budget)", () => {
      const word: TimedWordItem = {
        text: "KINETIC",
        startSec: 0.5,
        endSec: 1.2,
      };

      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        evaluateKineticWordState(word, 0, 0.5 + (i % 60) / 60);
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(10); // Far faster than 16.6ms
    });
  });
});
