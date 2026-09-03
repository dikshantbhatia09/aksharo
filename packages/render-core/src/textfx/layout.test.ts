import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { type Rect } from "../commands/types.js";
import { LANDSCAPE_CANVAS, PORTRAIT_CANVAS } from "../styles/fit.js";
import { type CanvasSize } from "../units.js";
import { placeTitleBox, rectsOverlap, type TitleSize } from "./layout.js";

const CANVASES: CanvasSize[] = [PORTRAIT_CANVAS, LANDSCAPE_CANVAS];

/**
 * A caption box anchored at the bottom or the top of the frame, sized like a
 * real caption block (up to ~3 wrapped lines). Captions in this system are
 * always top- or bottom-anchored (`StyleDoc.layout.anchor`), never a side
 * strip, so those are the two positions the solver has to reason about.
 */
function captionBoxArb(canvas: CanvasSize) {
  return fc
    .record({
      position: fc.constantFrom("bottom", "top"),
      widthFraction: fc.double({ min: 0.3, max: 0.95, noNaN: true }),
      heightFraction: fc.double({ min: 0.05, max: 0.28, noNaN: true }),
    })
    .map(({ position, widthFraction, heightFraction }): Rect => {
      const width = canvas.width * widthFraction;
      const height = canvas.height * heightFraction;
      const left = (canvas.width - width) / 2;
      if (position === "bottom") {
        const bottom = canvas.height * 0.94;
        return [left, bottom - height, left + width, bottom];
      }
      const top = canvas.height * 0.06;
      return [left, top, left + width, top + height];
    });
}

/** A short key-phrase title (1-6 words), never as tall or wide as a caption block. */
function titleSizeArb(canvas: CanvasSize) {
  return fc
    .record({
      widthFraction: fc.double({ min: 0.1, max: 0.6, noNaN: true }),
      heightFraction: fc.double({ min: 0.03, max: 0.16, noNaN: true }),
    })
    .map(({ widthFraction, heightFraction }): TitleSize => ({
      width: canvas.width * widthFraction,
      height: canvas.height * heightFraction,
    }));
}

describe("placeTitleBox", () => {
  it.each(CANVASES)(
    "never overlaps the caption, for any caption position x title length (canvas %o)",
    (canvas) => {
      fc.assert(
        fc.property(captionBoxArb(canvas), titleSizeArb(canvas), (captionBox, title) => {
          const placement = placeTitleBox({ canvas, captionBox, title });
          return !rectsOverlap(placement.box, captionBox);
        }),
        { numRuns: 500 },
      );
    },
  );

  it("keeps the placement inside the canvas's safe area", () => {
    fc.assert(
      fc.property(fc.constantFrom(...CANVASES), titleSizeArb(PORTRAIT_CANVAS), (canvas, title) => {
        const placement = placeTitleBox({ canvas, captionBox: undefined, title });
        const margin = Math.min(canvas.width, canvas.height) * 0.06;
        const [left, top, right, bottom] = placement.box;
        return (
          left >= margin - 0.01 &&
          top >= margin - 0.01 &&
          right <= canvas.width - margin + 0.01 &&
          bottom <= canvas.height - margin + 0.01
        );
      }),
      { numRuns: 200 },
    );
  });

  it("prefers the top third when no caption is on screen", () => {
    const placement = placeTitleBox({
      canvas: PORTRAIT_CANVAS,
      captionBox: undefined,
      title: { width: 400, height: 100 },
    });
    expect(placement.slot).toBe("top-third");
  });

  it("moves off the top third when the caption itself sits there", () => {
    const canvas = PORTRAIT_CANVAS;
    const captionAtTop: Rect = [0, 0, canvas.width, canvas.height / 3 + 40];
    const placement = placeTitleBox({
      canvas,
      captionBox: captionAtTop,
      title: { width: 300, height: 80 },
    });
    expect(placement.slot).not.toBe("top-third");
    expect(rectsOverlap(placement.box, captionAtTop)).toBe(false);
  });

  it("is deterministic: identical inputs produce identical output", () => {
    const canvas = LANDSCAPE_CANVAS;
    const captionBox: Rect = [100, canvas.height - 200, canvas.width - 100, canvas.height - 40];
    const title: TitleSize = { width: 500, height: 120 };
    const a = placeTitleBox({ canvas, captionBox, title });
    const b = placeTitleBox({ canvas, captionBox, title });
    expect(a).toEqual(b);
  });
});
