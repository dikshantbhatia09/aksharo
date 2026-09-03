import { describe, expect, it } from "vitest";

import { drawTextFxTitle } from "./draw.js";
import { textFxPhase } from "./presets.js";
import { walkCommands } from "../commands/types.js";
import { type GlyphRun, type Rect } from "../commands/types.js";

const BOX: Rect = [100, 200, 500, 300];

function glyphRun(text: string): GlyphRun {
  return {
    fontId: "font:test",
    fontSizePx: 48,
    glyphs: [...text].map((_, index) => index + 1),
    positions: [...text].flatMap((_, index) => [100 + index * 20, 250]),
    clusters: [...text].map((_, index) => index),
    text,
  };
}

describe("drawTextFxTitle", () => {
  it("draws nothing when fully transparent", () => {
    const phase = { opacity: 0, scale: 1, dy: 0, reveal: 1, underline: 1, countFraction: 1 };
    const commands = drawTextFxTitle({
      box: BOX,
      phase,
      glyphRun: glyphRun("Hello"),
      textColor: "#ffffff",
    });
    expect(commands).toEqual([]);
  });

  it("wraps the text in a transform + group with the phase's opacity and scale", () => {
    const phase = textFxPhase("pop", 0.5, 2000);
    const commands = drawTextFxTitle({
      box: BOX,
      phase,
      glyphRun: glyphRun("Hello"),
      textColor: "#ffffff",
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.kind).toBe("transform");
    const kinds = [...walkCommands(commands)].map((c) => c.kind);
    expect(kinds).toContain("group");
    expect(kinds).toContain("text");
  });

  it("reveals only a prefix of the glyph run for the typewriter preset mid-reveal", () => {
    const phase = textFxPhase("typewriter", 0.02, 2000);
    expect(phase.reveal).toBeGreaterThan(0);
    expect(phase.reveal).toBeLessThan(1);
    const commands = drawTextFxTitle({
      box: BOX,
      phase,
      glyphRun: glyphRun("Hello World"),
      textColor: "#ffffff",
    });
    const textCommand = [...walkCommands(commands)].find((c) => c.kind === "text");
    expect(textCommand?.kind).toBe("text");
    if (textCommand?.kind === "text") {
      expect(textCommand.run.glyphs.length).toBeLessThan(11);
    }
  });

  it("draws an underline rule sized by phase.underline when requested", () => {
    const phase = textFxPhase("underline", 0.02, 2000);
    const commands = drawTextFxTitle({
      box: BOX,
      phase,
      glyphRun: glyphRun("Hi"),
      textColor: "#ffffff",
      accentColor: "#ff0000",
      showUnderline: true,
    });
    const rectCommands = [...walkCommands(commands)].filter((c) => c.kind === "rect");
    expect(rectCommands.length).toBeGreaterThanOrEqual(1);
  });

  it("draws a background chip when withBackground is set", () => {
    const phase = textFxPhase("fade", 0.5, 2000);
    const commands = drawTextFxTitle({
      box: BOX,
      phase,
      glyphRun: glyphRun("Hi"),
      textColor: "#ffffff",
      withBackground: true,
    });
    const rectCommands = [...walkCommands(commands)].filter((c) => c.kind === "rect");
    expect(rectCommands.length).toBeGreaterThanOrEqual(1);
  });
});
