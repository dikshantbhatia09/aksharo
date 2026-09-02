import { describe, expect, it } from "vitest";

import { alignmentOf, buildStyleLine, fontSizePx, STYLE_FORMAT } from "./style-map.js";
import { makeStyle } from "./testing.js";

const CANVAS = { width: 1080, height: 1920 };

describe("alignmentOf", () => {
  it.each([
    ["top-left", 7],
    ["top-center", 8],
    ["top-right", 9],
    ["middle-left", 4],
    ["center", 5],
    ["middle-right", 6],
    ["bottom-left", 1],
    ["bottom-center", 2],
    ["bottom-right", 3],
  ] as const)("%s -> %i", (anchor, expected) => {
    expect(alignmentOf(anchor)).toBe(expected);
  });
});

describe("fontSizePx", () => {
  it("is a percentage of canvas height", () => {
    expect(
      fontSizePx(makeStyle({ typography: { ...makeStyle().typography, sizePct: 5 } }), CANVAS),
    ).toBe(96);
  });
});

describe("buildStyleLine", () => {
  it("emits a Style: line keyed by the style id, matching STYLE_FORMAT's field count", () => {
    const style = makeStyle({ id: "punch-pop" });
    const { name, line } = buildStyleLine(style, CANVAS);
    expect(name).toBe("punch-pop");
    expect(line.startsWith("Style: punch-pop,")).toBe(true);
    const fieldCount = STYLE_FORMAT.replace("Format: ", "").split(",").length;
    expect(line.replace("Style: ", "").split(",")).toHaveLength(fieldCount);
  });

  it("marks bold when weight >= 600", () => {
    const bold = buildStyleLine(
      makeStyle({ typography: { ...makeStyle().typography, weight: 700 } }),
      CANVAS,
    );
    const light = buildStyleLine(
      makeStyle({ typography: { ...makeStyle().typography, weight: 400 } }),
      CANVAS,
    );
    expect(bold.line.split(",")[7]).toBe("-1");
    expect(light.line.split(",")[7]).toBe("0");
  });

  it("uses BorderStyle 3 and outline-as-padding for an enabled block box", () => {
    const style = makeStyle({
      box: {
        enabled: true,
        mode: "block",
        fill: "#101018ff",
        paddingPct: 20,
        radiusPct: 10,
        opacity: 1,
      },
    });
    const { line } = buildStyleLine(style, CANVAS);
    const fields = line.replace("Style: ", "").split(",");
    expect(fields[15]).toBe("3"); // BorderStyle
    expect(Number(fields[16])).toBeGreaterThan(0); // Outline (padding-derived)
  });

  it("uses BorderStyle 1 and a real outline for stroke.enabled", () => {
    const style = makeStyle({ stroke: { enabled: true, color: "#000000ff", widthPct: 8 } });
    const { line } = buildStyleLine(style, CANVAS);
    const fields = line.replace("Style: ", "").split(",");
    expect(fields[15]).toBe("1");
    expect(Number(fields[16])).toBeGreaterThan(0);
  });

  it("computes a shadow distance from the average absolute offset", () => {
    const style = makeStyle({
      shadow: {
        enabled: true,
        color: "#000000ff",
        offsetXPct: 4,
        offsetYPct: 4,
        blurPct: 0,
        opacity: 1,
      },
    });
    const { line } = buildStyleLine(style, CANVAS);
    const fields = line.replace("Style: ", "").split(",");
    expect(Number(fields[17])).toBeGreaterThan(0);
  });

  it("zeroes outline and shadow when neither stroke nor shadow nor box is enabled", () => {
    const { line } = buildStyleLine(makeStyle(), CANVAS);
    const fields = line.replace("Style: ", "").split(",");
    expect(fields[16]).toBe("0");
    expect(fields[17]).toBe("0");
  });
});
