import { describe, expect, it } from "vitest";

import {
  BilingualSubtitle,
  computeBilingualSkiaLayout,
} from "./BilingualSubtitle.js";
import { findVNodesByType, h, type KineticCaptionWord } from "./SplitScreenView.js";

void h;

const ORIGINAL_WORDS: readonly KineticCaptionWord[] = [
  { text: "आज", startSec: 0.0, endSec: 0.4 },
  { text: "हम", startSec: 0.4, endSec: 0.7 },
  { text: "सीखेंगे", startSec: 0.7, endSec: 1.2 },
];

const TRANSLATED_WORDS: readonly KineticCaptionWord[] = [
  { text: "Today", startSec: 0.0, endSec: 0.4 },
  { text: "we", startSec: 0.4, endSec: 0.6 },
  { text: "will", startSec: 0.6, endSec: 0.8 },
  { text: "learn!", startSec: 0.8, endSec: 1.2, highlightColor: "#00FFA3" },
];

describe("BilingualSubtitle Remotion Component (Pillar 4 §09)", () => {
  it("renders dual-line stacked layout with subtle native top line and kinetic translated bottom line", () => {
    const tree = (
      <BilingualSubtitle
        originalWords={ORIGINAL_WORDS}
        translatedWords={TRANSLATED_WORDS}
        currentTimeSec={0.5} // "हम" and "we" active
        fps={60}
        originalFontSize={32}
        translatedFontSize={48}
        originalColor="#8E8E93"
        originalOpacity={0.65}
        activeColor="#00FFA3"
        placement="lower-third"
        topPx={1500}
      />
    );

    expect(tree.props["data-testid"]).toBe("bilingual-subtitle");
    expect(tree.props["data-placement"]).toBe("lower-third");
    expect(tree.props.style?.position).toBe("absolute");
    expect(tree.props.style?.top).toBe(1500);

    // Verify top line (original)
    const originalLine = tree.props.children.find(
      (c) => typeof c === "object" && c !== null && "props" in c && c.props["data-testid"] === "bilingual-original-line",
    );
    expect(originalLine).toBeDefined();
    if (typeof originalLine === "object" && originalLine !== null && "props" in originalLine) {
      expect(originalLine.props.style?.opacity).toBe(0.65);
      expect(originalLine.props.style?.fontSize).toBe("32px");
      expect(originalLine.props.style?.color).toBe("#8E8E93");

      const origWordNodes = findVNodesByType(originalLine, "span");
      expect(origWordNodes).toHaveLength(3);
      // Word 1 ("हम") is active at t = 0.5s
      expect(origWordNodes[1]?.props["data-active"]).toBe("true");
      expect(origWordNodes[1]?.props.style?.color).toBe("#FFFFFF");
      // Word 0 ("आज") is inactive
      expect(origWordNodes[0]?.props["data-active"]).toBe("false");
      expect(origWordNodes[0]?.props.style?.color).toBe("#8E8E93");
    }

    // Verify bottom line (translated)
    const translatedLine = tree.props.children.find(
      (c) => typeof c === "object" && c !== null && "props" in c && c.props["data-testid"] === "bilingual-translated-line",
    );
    expect(translatedLine).toBeDefined();
    if (typeof translatedLine === "object" && translatedLine !== null && "props" in translatedLine) {
      const kineticLineNodes = findVNodesByType(translatedLine, "div");
      expect(kineticLineNodes.length).toBeGreaterThan(0);
      const kineticSpans = findVNodesByType(translatedLine, "span");
      expect(kineticSpans).toHaveLength(4);

      // Word 1 ("we") is active at t = 0.5s
      const activeWord = kineticSpans[1]!;
      expect(activeWord.props["data-word"]).toBe("we");
      expect(activeWord.props["data-active"]).toBe("true");
      expect(activeWord.props.style?.color).toBe("#00FFA3");
    }
  });

  it("automatically performs proportional phonetic timing allocation when given plain string texts", () => {
    const tree = (
      <BilingualSubtitle
        originalText="नमस्ते दोस्तों कैसे हो"
        translatedText="Hello friends how are you"
        startSec={0.0}
        endSec={2.0}
        currentTimeSec={0.3}
      />
    );

    const origLine = tree.props.children.find(
      (c) => typeof c === "object" && c !== null && "props" in c && c.props["data-testid"] === "bilingual-original-line",
    );
    expect(origLine).toBeDefined();
    if (typeof origLine === "object" && origLine !== null && "props" in origLine) {
      const origWords = findVNodesByType(origLine, "span");
      expect(origWords).toHaveLength(4);
    }

    const transLine = tree.props.children.find(
      (c) => typeof c === "object" && c !== null && "props" in c && c.props["data-testid"] === "bilingual-translated-line",
    );
    expect(transLine).toBeDefined();
    if (typeof transLine === "object" && transLine !== null && "props" in transLine) {
      const transWords = findVNodesByType(transLine, "span");
      expect(transWords).toHaveLength(5);
    }
  });

  describe("computeBilingualSkiaLayout (Dual-Track 60fps hardware compositor)", () => {
    it("generates separate top and bottom paths with frame-accurate vertical clearance", () => {
      // Test at t = 0.4s (frame 0 attack of "we")
      const layout = computeBilingualSkiaLayout(
        ORIGINAL_WORDS,
        TRANSLATED_WORDS,
        0.4,
        1080,
        960,
        {
          originalFontSize: 32,
          translatedFontSize: 48,
          lineGapPx: 12,
        },
      );

      expect(layout.originalPaths).toHaveLength(3);
      expect(layout.translatedPaths).toHaveLength(4);
      expect(layout.allPaths).toHaveLength(7);

      // Original paths must sit above translated paths (smaller y)
      const origY = layout.originalPaths[0]?.y ?? 0;
      const transY = layout.translatedPaths[0]?.y ?? 0;
      expect(origY).toBeLessThan(transY);

      // Translated active word "we" at attack (t = 0.4s) has spring scale ~1.22
      const activeTransWord = layout.translatedPaths[1]!;
      expect(activeTransWord.text).toBe("we");
      expect(activeTransWord.isActive).toBe(true);
      expect(activeTransWord.scale).toBeCloseTo(1.22, 2);
    });
  });

});
