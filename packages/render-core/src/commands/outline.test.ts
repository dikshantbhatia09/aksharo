import { beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap } from "@montaj/caption-styles";

import { animate } from "../animate/animate.js";
import { type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { layoutSegment } from "../layout/layout.js";
import { CAPTION_FIXTURES, createFixtureRenderer, GOLDEN_CANVAS } from "../testing.js";
import { fill, stroke } from "./build.js";
import { glyphRunToPath, outlineGlyphRun, outlineTextCommands, transformGlyphPath } from "./outline.js";
import { type DrawCommand, walkCommands } from "./types.js";

let registry: FontRegistry;
let shaper: Shaper;

beforeAll(async () => {
  ({ registry, shaper } = await createFixtureRenderer());
});

function commandsFor(fixtureName: string, styleId = "punch-pop"): DrawCommand[] {
  const style = loadSystemStyleMap().get(styleId);
  const fixture = CAPTION_FIXTURES.find((entry) => entry.name === fixtureName);
  if (style === undefined || fixture === undefined) throw new Error("bad fixture");
  const layout = layoutSegment({
    style,
    segment: fixture.segment,
    words: fixture.words,
    canvas: GOLDEN_CANVAS,
    registry,
    shaper,
    tMs: 1500,
  });
  return animate({ layout, style, tMs: 1500 });
}

describe("transformGlyphPath", () => {
  it("flips y and scales into canvas space", () => {
    // A unit square in font units at upem 1000, drawn at 100 px, origin (10, 200).
    expect(transformGlyphPath("M0,0L1000,0L1000,1000Z", 10, 200, 0.1)).toBe("M10 200L110 200L110 100Z");
  });

  it("handles quadratic and cubic segments", () => {
    expect(transformGlyphPath("M0,0Q10,10 20,0", 0, 0, 1)).toBe("M0 0Q10 -10 20 0");
    expect(transformGlyphPath("M0,0C1,1 2,2 3,3", 0, 0, 1)).toBe("M0 0C1 -1 2 -2 3 -3");
  });

  it("returns nothing for an empty outline", () => {
    expect(transformGlyphPath("", 0, 0, 1)).toBe("");
  });

  it("refuses a path command it was never promised", () => {
    expect(() => transformGlyphPath("M0,0A1 1 0 0 1 2 2", 0, 0, 1)).toThrow(/unsupported glyph path token/);
  });
});

describe("glyphRunToPath", () => {
  it("produces one path for a whole run", () => {
    const text = [...walkCommands(commandsFor("english"))].find((command) => command.kind === "text");
    expect(text?.kind).toBe("text");
    if (text?.kind !== "text") return;
    const path = glyphRunToPath(text.run, shaper);
    expect(path.startsWith("M")).toBe(true);
    expect(path.split("M").length - 1).toBeGreaterThanOrEqual(text.run.glyphs.length);
  });

  it("outlines Devanagari and Tamil, marks included", () => {
    for (const fixture of ["hindi", "tamil"]) {
      const text = [...walkCommands(commandsFor(fixture))].find((command) => command.kind === "text");
      if (text?.kind !== "text") throw new Error("no text command");
      expect(glyphRunToPath(text.run, shaper).length).toBeGreaterThan(100);
    }
  });

  it("keeps the paints when it turns a run into a path command", () => {
    const text = [...walkCommands(commandsFor("english"))].find((command) => command.kind === "text");
    if (text?.kind !== "text") throw new Error("no text command");
    const path = outlineGlyphRun(text.run, shaper, { fill: fill("#ffffff"), stroke: stroke("#000000", 4) });
    expect(path.kind).toBe("path");
    expect(path.fillRule).toBe("nonzero");
    expect(path.fill).toBeDefined();
    expect(path.stroke).toBeDefined();
  });

  it("skips a glyph with no outline, such as a space", () => {
    const empty = glyphRunToPath(
      { fontId: "noto-sans-400", fontSizePx: 48, glyphs: [], positions: [], clusters: [], text: "" },
      shaper,
    );
    expect(empty).toBe("");
  });
});

describe("outlineTextCommands", () => {
  it("replaces every text command in a tree and leaves the rest alone", () => {
    const commands = commandsFor("hinglish");
    const outlined = outlineTextCommands(commands, shaper);
    const before = [...walkCommands(commands)];
    const after = [...walkCommands(outlined)];
    expect(before.filter((command) => command.kind === "text").length).toBeGreaterThan(0);
    expect(after.filter((command) => command.kind === "text")).toHaveLength(0);
    expect(after.filter((command) => command.kind === "path").length).toBe(
      before.filter((command) => command.kind === "text").length,
    );
    expect(after).toHaveLength(before.length);
  });

  it("leaves rects, images and containers untouched", () => {
    const source: DrawCommand[] = [
      { kind: "rect", rect: [0, 0, 1, 1] },
      { kind: "image", assetId: "a", dest: [0, 0, 1, 1] },
      { kind: "group", children: [{ kind: "rect", rect: [0, 0, 2, 2] }] },
    ];
    expect(outlineTextCommands(source, shaper)).toEqual(source);
  });
});
