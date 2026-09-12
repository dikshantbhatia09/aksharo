import { describe, expect, it } from "vitest";

import { loadStyleRegistry, StyleDocSchema } from "@montaj/caption-styles";

import { SYSTEM_STYLES, SYSTEM_STYLE_MAP } from "./system-styles";

/**
 * The browser catalogue imports the style documents as JSON and types them
 * rather than parsing them, because pulling the schema into the client bundle
 * would drag the filesystem-backed catalogue loader in with it. The validation
 * therefore happens here, in Node, on the same objects the browser gets — so a
 * malformed style still fails CI, just not at the user's expense.
 */
describe("the browser style catalogue", () => {
  it("holds every style the registry lists", () => {
    const registry = loadStyleRegistry();
    expect(SYSTEM_STYLES.map((style) => style.id).sort()).toEqual(
      registry.styles.map((entry) => entry.id).sort(),
    );
    expect(SYSTEM_STYLES).toHaveLength(52);
  });

  it("validates every document against the StyleDoc schema", () => {
    for (const style of SYSTEM_STYLES) {
      const parsed = StyleDocSchema.safeParse(style);
      expect(parsed.success, `${style.id}: ${parsed.success ? "" : parsed.error.message}`).toBe(
        true,
      );
    }
  });

  it("keys the map by id", () => {
    expect(SYSTEM_STYLE_MAP.size).toBe(SYSTEM_STYLES.length);
    expect(SYSTEM_STYLE_MAP.get("plain-white")?.name).toBe("Plain White");
    expect(SYSTEM_STYLE_MAP.get("estate-word-pop")?.name).toBe("Real Estate: Word Pop");
    expect(SYSTEM_STYLE_MAP.get("kinetic-flow")?.name).toBe("Kinetic Flow");
    expect(SYSTEM_STYLE_MAP.get("kinetic-slab-punch")?.name).toBe("Kinetic Slab Punch");
    expect(SYSTEM_STYLE_MAP.get("punch-pop")?.name).toBe("Punch Pop");
  });
});
