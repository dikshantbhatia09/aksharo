import { describe, expect, it } from "vitest";

import {
  computeKineticSkiaLayout,
  KineticSubtitleLine,
} from "./KineticSubtitleLine.js";
import { findVNodesByType, h, type KineticCaptionWord } from "./SplitScreenView.js";

void h;

const SAMPLE_WORDS: readonly KineticCaptionWord[] = [
  { text: "DO", startSec: 0.0, endSec: 0.2 },
  { text: "NOT", startSec: 0.2, endSec: 0.5 },
  { text: "LOOK", startSec: 0.5, endSec: 0.9 },
  { text: "AWAY!", startSec: 0.9, endSec: 1.4, highlightColor: "#FEE715" },
];

describe("KineticSubtitleLine Remotion Component & Kinetic Engine (Pillar 4 §01)", () => {
  it("renders word spans with frame-accurate spring scale punch and neon glow", () => {
    // Current time at 0.5s: "LOOK" is active
    const tree = (
      <KineticSubtitleLine
        words={SAMPLE_WORDS}
        currentTimeSec={0.5}
        fps={60}
        fontSize={50}
        baseMargin={10}
        activeColor="#00FFA3"
        inactiveColor="#FFFFFF"
        placement="divider"
        topPx={960}
      />
    );

    expect(tree.props["data-testid"]).toBe("kinetic-subtitle-line");
    expect(tree.props["data-placement"]).toBe("divider");
    expect(tree.props.style?.position).toBe("absolute");
    expect(tree.props.style?.top).toBe(960);

    const wordNodes = findVNodesByType(tree, "span");
    expect(wordNodes).toHaveLength(4);

    // Word 0 ("DO"): past
    const word0 = wordNodes[0]!;
    expect(word0.props["data-word"]).toBe("DO");
    expect(word0.props["data-active"]).toBe("false");
    expect(word0.props.style?.color).toBe("#FFFFFF");
    expect(word0.props.style?.transform).toContain("scale(1.000)");

    // Word 2 ("LOOK"): active at t = 0.5s (word.startSec = 0.5s -> frame 0 attack)
    const word2 = wordNodes[2]!;
    expect(word2.props["data-word"]).toBe("LOOK");
    expect(word2.props["data-active"]).toBe("true");
    expect(word2.props.style?.color).toBe("#00FFA3");
    // Peak spring scale ~1.22
    expect(word2.props["data-scale"]).toBe("1.220");
    expect(word2.props.style?.transform).toContain("scale(1.220)");
    // Attack dip -4px
    expect(word2.props["data-y-offset"]).toBe("-4.00");
    expect(word2.props.style?.transform).toContain("translate3d(0, -4.00px, 0)");
    // Enhanced neon glow
    expect(String(word2.props.style?.textShadow)).toContain("22px #00FFA3");
    // Dynamic safe margin (base 10 + 50 * 0.1 = 15px)
    expect(word2.props.style?.marginRight).toBe("15.0px");
  });

  it("verifies custom word highlight color overrides default active color", () => {
    // Current time at 1.0s: "AWAY!" is active, which specifies highlightColor="#FEE715"
    const tree = (
      <KineticSubtitleLine
        words={SAMPLE_WORDS}
        currentTimeSec={1.0}
        activeColor="#00FFA3"
      />
    );

    const wordNodes = findVNodesByType(tree, "span");
    const word3 = wordNodes[3]!;
    expect(word3.props["data-word"]).toBe("AWAY!");
    expect(word3.props["data-active"]).toBe("true");
    expect(word3.props.style?.color).toBe("#FEE715");
  });

  it("supports multiple kinetic animation curves: pop-bounce, karaoke-fill, typewriter, elastic-fade", () => {
    // 1. Karaoke-fill curve
    const karaokeTree = (
      <KineticSubtitleLine
        words={SAMPLE_WORDS}
        currentTimeSec={0.5}
        curve="karaoke-fill"
      />
    );
    const karaokeWords = findVNodesByType(karaokeTree, "span");
    expect(karaokeWords[2]?.props.style?.transform).toContain("scale(1.040)");

    // 2. Typewriter curve (dims upcoming words to 0.15)
    const typewriterTree = (
      <KineticSubtitleLine
        words={SAMPLE_WORDS}
        currentTimeSec={0.3} // "DO" is past, "NOT" is active, "LOOK" and "AWAY!" upcoming
        curve="typewriter"
      />
    );
    const typewriterWords = findVNodesByType(typewriterTree, "span");
    expect(typewriterWords[2]?.props.style?.opacity).toBe(0.15);
    expect(typewriterWords[3]?.props.style?.opacity).toBe(0.15);

    // 3. Elastic-fade curve
    const elasticTree = (
      <KineticSubtitleLine
        words={SAMPLE_WORDS}
        currentTimeSec={0.3}
        curve="elastic-fade"
      />
    );
    const elasticWords = findVNodesByType(elasticTree, "span");
    expect(elasticWords[1]?.props["data-active"]).toBe("true");
    expect(elasticWords[1]?.props.style?.opacity).toBeGreaterThan(0.4);
  });

  it("prevents collision between consecutive words during active punch (visual regression test)", () => {
    const fontSize = 54;
    const baseMargin = 8;
    const tree = (
      <KineticSubtitleLine
        words={SAMPLE_WORDS}
        currentTimeSec={0.2} // "NOT" is active
        fontSize={fontSize}
        baseMargin={baseMargin}
      />
    );

    const wordNodes = findVNodesByType(tree, "span");
    const activeWord = wordNodes[1]!;
    expect(activeWord.props["data-active"]).toBe("true");

    // Dynamic margin = baseMargin (8) + fontSize * 0.1 (5.4) = 13.4px
    expect(activeWord.props.style?.marginRight).toBe("13.4px");

    // Inactive word keeps base margin (8.0px)
    const inactiveWord = wordNodes[0]!;
    expect(inactiveWord.props.style?.marginRight).toBe("8.0px");
  });

  describe("computeKineticSkiaLayout (Skia / CanvasKit hardware blitter)", () => {
    it("generates frame-accurate 2D word layouts with spring scales and positions", () => {
      const paths = computeKineticSkiaLayout(SAMPLE_WORDS, 0.5, 1080, 960, 48, 60, 10);
      expect(paths).toHaveLength(4);

      // Verify active word "LOOK"
      const activePath = paths[2]!;
      expect(activePath.text).toBe("LOOK");
      expect(activePath.isActive).toBe(true);
      expect(activePath.scale).toBeCloseTo(1.22, 2);
      expect(activePath.yOffset).toBeCloseTo(-4.0, 2);
      expect(activePath.y).toBeCloseTo(960 - 4.0, 2);
      expect(activePath.color).toBe("#00FFA3");
      expect(activePath.shadowSigma).toBeGreaterThan(15);

      // Verify inactive words have scale 1.0 and resting y
      const inactivePath = paths[0]!;
      expect(inactivePath.isActive).toBe(false);
      expect(inactivePath.scale).toBe(1.0);
      expect(inactivePath.y).toBe(960);

      // Verify layout maintains positive spacing between consecutive words
      for (let i = 0; i < paths.length - 1; i++) {
        const curr = paths.at(i);
        const next = paths.at(i + 1);
        if (curr && next) {
          expect(next.x).toBeGreaterThan(curr.x + curr.width);
        }
      }
    });
  });

  describe("Timestamp Synchronization SLA (<= 16.6ms accuracy at 60 fps)", () => {
    it("synchronizes active states frame-for-frame across 60 fps boundary", () => {
      // Word 1: 0.20s to 0.50s
      // At t = 0.183s (frame 11): inactive
      const tPre = 0.183;
      const preTree = <KineticSubtitleLine words={SAMPLE_WORDS} currentTimeSec={tPre} />;
      const preWords = findVNodesByType(preTree, "span");
      expect(preWords[1]?.props["data-active"]).toBe("false");

      // At t = 0.200s (frame 12): active!
      const tStart = 0.200;
      const startTree = <KineticSubtitleLine words={SAMPLE_WORDS} currentTimeSec={tStart} />;
      const startWords = findVNodesByType(startTree, "span");
      expect(startWords[1]?.props["data-active"]).toBe("true");

      // At t = 0.483s (frame 29): still active
      const tMid = 0.483;
      const midTree = <KineticSubtitleLine words={SAMPLE_WORDS} currentTimeSec={tMid} />;
      const midWords = findVNodesByType(midTree, "span");
      expect(midWords[1]?.props["data-active"]).toBe("true");
      expect(midWords[2]?.props["data-active"]).toBe("false");

      // At t = 0.500s (frame 30): exact transition to Word 2 ("LOOK")
      const tNext = 0.500;
      const nextTree = <KineticSubtitleLine words={SAMPLE_WORDS} currentTimeSec={tNext} />;
      const nextWords = findVNodesByType(nextTree, "span");
      expect(nextWords[1]?.props["data-active"]).toBe("false");
      expect(nextWords[2]?.props["data-active"]).toBe("true");
    });
  });
});
