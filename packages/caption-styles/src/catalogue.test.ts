import { describe, expect, it } from "vitest";

import { DEFAULT_PICKABLE_STYLE_ID, isPickableStyle, PICKABLE_STYLE_IDS } from "./catalogue.js";
import { loadSystemStyleMap } from "./registry.js";

describe("the pickable catalogue", () => {
  const styles = loadSystemStyleMap();

  it("offers Punch Pop first, as the default, and four more looks (owner, 2026-09-29)", () => {
    expect(PICKABLE_STYLE_IDS).toEqual([
      "punch-pop",
      "karaoke-fill",
      "hype-bold",
      "word-pop",
      "vertical-clean",
    ]);
    expect(DEFAULT_PICKABLE_STYLE_ID).toBe("punch-pop");
    expect(isPickableStyle(DEFAULT_PICKABLE_STYLE_ID)).toBe(true);
    expect(isPickableStyle("box-block")).toBe(false);
  });

  it("offers only styles that ship, whose default emphasis stays readable", () => {
    for (const id of PICKABLE_STYLE_IDS) {
      const style = styles.get(id);
      expect(style, id).toBeDefined();
      // "Emphasise word" (and Autopilot's keywords) use the first preset; a
      // highlight preset paints the word in its own marker colour today.
      expect(style?.emphasisPresets[0]?.effect, id).not.toBe("highlight");
      expect(style?.typography.fallbacks, id).toContain("Noto Sans Devanagari");
    }
  });
});
