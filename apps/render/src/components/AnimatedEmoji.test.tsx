import { describe, expect, it } from "vitest";

import {
  AnimatedEmoji,
  computeAnimatedEmojiSkiaLayout,
  computeEmojiFloatY,
  computeEmojiRotation,
  computeEmojiSpringScale,
} from "./AnimatedEmoji.js";
import { findVNodesByType, h } from "./SplitScreenView.js";

void h;

describe("AnimatedEmoji Remotion Component & Dynamics (Pillar 4 §04)", () => {
  it("calculates spring scale pop (0.0 -> 1.25 -> 1.0 settling)", () => {
    // Upcoming: scale 0.0
    expect(computeEmojiSpringScale(0.4, 0.5, 60)).toBe(0.0);

    // Attack frame (0.5s): starts pop
    const attackScale = computeEmojiSpringScale(0.5, 0.5, 60);
    expect(attackScale).toBe(0.0);

    // Peak frame (~frame 1-2 at 60 fps, e.g. 0.5 + 2/60 = 0.533s)
    const peakScale = computeEmojiSpringScale(0.5 + 2 / 60, 0.5, 60);
    expect(peakScale).toBeGreaterThanOrEqual(1.15);
    expect(peakScale).toBeLessThanOrEqual(1.30);

    // Settled frame (after frame 8: e.g. 0.5 + 10/60s = 0.666s)
    const settledScale = computeEmojiSpringScale(0.5 + 10 / 60, 0.5, 60);
    expect(settledScale).toBe(1.0);
  });

  it("calculates rotational wiggle (+12 deg -> -6 deg -> 0 deg)", () => {
    // Upcoming
    expect(computeEmojiRotation(0.4, 0.5, 60)).toBe(0);

    // Frame 1-2: swings into positive tilt
    const tilt = computeEmojiRotation(0.5 + 1 / 60, 0.5, 60);
    expect(tilt).toBeGreaterThan(0);
    expect(tilt).toBeLessThanOrEqual(12.0);

    // Settled: returns to 0 deg
    const settled = computeEmojiRotation(0.5 + 12 / 60, 0.5, 60);
    expect(settled).toBe(0);
  });

  it("calculates subtle upward float over duration (-15px)", () => {
    // At start: float 0px
    expect(computeEmojiFloatY(0.5, 0.5, 1.0, -15)).toBe(0);

    // Midway through duration: float halfway (-7.5px)
    expect(computeEmojiFloatY(1.0, 0.5, 1.0, -15)).toBeCloseTo(-7.5, 1);

    // At end: float max (-15px)
    expect(computeEmojiFloatY(1.5, 0.5, 1.0, -15)).toBe(-15);
  });

  it("renders AnimatedEmoji component with 3D vector SVG data URI when active", () => {
    const tree = (
      <AnimatedEmoji
        emoji="🔥"
        assetKey="fire"
        currentTimeSec={0.55}
        startSec={0.5}
        endSec={1.2}
        fps={60}
        sizePx={64}
        offsetYPx={-65}
      />
    );

    expect(tree.props["data-testid"]).toBe("animated-emoji");
    expect(tree.props["data-emoji"]).toBe("🔥");
    expect(tree.props["data-asset-key"]).toBe("fire");
    expect(tree.props["data-visible"]).toBe("true");

    const transform = String(tree.props.style?.transform);
    expect(transform).toContain("translate3d(-50%,");
    expect(transform).toContain("scale(");
    expect(transform).toContain("rotate(");

    const imgNodes = findVNodesByType(tree, "img");
    expect(imgNodes.length).toBe(1);
    expect(imgNodes[0]?.props.src).toMatch(/^data:image\/svg\+xml/);
  });

  it("hides emoji when upcoming or past", () => {
    const upcomingTree = (
      <AnimatedEmoji
        emoji="🚀"
        currentTimeSec={0.2}
        startSec={0.5}
        endSec={1.0}
      />
    );
    expect(upcomingTree.props["data-visible"]).toBe("false");
    expect(upcomingTree.props.style?.display).toBe("none");

    const pastTree = (
      <AnimatedEmoji
        emoji="🚀"
        currentTimeSec={1.5}
        startSec={0.5}
        endSec={1.0}
      />
    );
    expect(pastTree.props["data-visible"]).toBe("false");
    expect(pastTree.props.style?.display).toBe("none");
  });

  it("computes Skia / CanvasKit layout coordinates for 2D compositor", () => {
    const layout = computeAnimatedEmojiSkiaLayout(
      "💸",
      "money",
      540, // word center X
      960, // word top Y
      0.6, // current time
      0.5, // start
      1.0, // end
      60,
      64,
      -65,
    );

    expect(layout.visible).toBe(true);
    expect(layout.opacity).toBe(1.0);
    expect(layout.x).toBe(540 - 32); // centered at 508px
    expect(layout.y).toBeLessThan(960 - 65); // elevated by -65px plus float
    expect(layout.scale).toBeGreaterThan(0.5);
  });
});
