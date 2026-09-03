import { beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap, type StyleDoc } from "@montaj/caption-styles";

import { captionBoxFromLayouts, renderTitleFrame, type TitleFxTrack } from "./frame.js";
import { walkCommands } from "../commands/types.js";
import { type Shaper } from "../fonts/shaper.js";
import { type FontRegistry } from "../fonts/types.js";
import { type Layout } from "../layout/types.js";
import { createFixtureRenderer, GOLDEN_CANVAS } from "../testing.js";

let registry: FontRegistry;
let shaper: Shaper;
let style: StyleDoc;

beforeAll(async () => {
  ({ registry, shaper } = await createFixtureRenderer());
  const catalogue = loadSystemStyleMap();
  const found = catalogue.get("vertical-clean");
  if (found === undefined) throw new Error("fixture style missing");
  style = found;
});

function title(overrides: Partial<TitleFxTrack> = {}): TitleFxTrack {
  return {
    itemId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    startMs: 0,
    endMs: 2000,
    text: "Editing made easy",
    motionPreset: "pop",
    ...overrides,
  };
}

describe("renderTitleFrame", () => {
  it("draws nothing when no title is on screen", () => {
    const commands = renderTitleFrame({
      titles: [title({ startMs: 3000, endMs: 5000 })],
      timemap: null,
      outputMs: 500,
      canvas: GOLDEN_CANVAS,
      registry,
      shaper,
      style,
    });
    expect(commands).toEqual([]);
  });

  it("draws a title command tree at mid-preset", () => {
    const commands = renderTitleFrame({
      titles: [title()],
      timemap: null,
      outputMs: 1000,
      canvas: GOLDEN_CANVAS,
      registry,
      shaper,
      style,
    });
    expect(commands.length).toBeGreaterThan(0);
    const kinds = [...walkCommands(commands)].map((c) => c.kind);
    expect(kinds).toContain("text");
  });

  it("avoids a supplied caption box when a clear slot exists", () => {
    const captionBox: Layout["paddedBox"] = [
      0,
      GOLDEN_CANVAS.height * 0.8,
      GOLDEN_CANVAS.width,
      GOLDEN_CANVAS.height,
    ];
    const commands = renderTitleFrame({
      titles: [title()],
      timemap: null,
      outputMs: 1000,
      canvas: GOLDEN_CANVAS,
      registry,
      shaper,
      style,
      captionBox,
    });
    expect(commands.length).toBeGreaterThan(0);
  });

  it("substitutes a locale-formatted, animated number for a count-up preset", () => {
    const commands = renderTitleFrame({
      titles: [title({ text: "50,000 creators", motionPreset: "count-up", endMs: 2000 })],
      timemap: null,
      outputMs: 100,
      canvas: GOLDEN_CANVAS,
      registry,
      shaper,
      style,
    });
    const textCommand = [...walkCommands(commands)].find((c) => c.kind === "text");
    expect(textCommand?.kind).toBe("text");
    if (textCommand?.kind === "text") {
      expect(textCommand.run.text).not.toBe("50,000 creators");
      expect(textCommand.run.text.endsWith(" creators")).toBe(true);
    }
  });

  it("draws two titles active at once in deterministic itemId order", () => {
    const commands = renderTitleFrame({
      titles: [
        title({ itemId: "b", startMs: 0, endMs: 2000, text: "Second" }),
        title({ itemId: "a", startMs: 0, endMs: 2000, text: "First" }),
      ],
      timemap: null,
      outputMs: 1000,
      canvas: GOLDEN_CANVAS,
      registry,
      shaper,
      style,
    });
    const texts = [...walkCommands(commands)]
      .filter((c) => c.kind === "text")
      .map((c) => (c.kind === "text" ? c.run.text : ""));
    expect(texts).toEqual(["First", "Second"]);
  });
});

describe("captionBoxFromLayouts", () => {
  it("returns undefined with no layouts", () => {
    expect(captionBoxFromLayouts([])).toBeUndefined();
  });

  it("unions multiple layouts' padded boxes", () => {
    const a = { paddedBox: [0, 0, 10, 10] } as unknown as Layout;
    const b = { paddedBox: [5, 5, 20, 20] } as unknown as Layout;
    expect(captionBoxFromLayouts([{ layout: a }, { layout: b }])).toEqual([0, 0, 20, 20]);
  });
});
