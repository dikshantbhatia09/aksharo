import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { STYLES_DIR } from "./registry.js";
import { STYLE_DOC_VERSION, StyleDocSchema, type StyleDocInput } from "./schema.js";

const punchPop = JSON.parse(
  readFileSync(join(STYLES_DIR, "punch-pop.json"), "utf8"),
) as StyleDocInput;

/** A fresh, minimal-but-complete document for mutation tests. */
function draft(overrides: Partial<StyleDocInput> = {}): Record<string, unknown> {
  return { ...(JSON.parse(JSON.stringify(punchPop)) as StyleDocInput), ...overrides } as Record<
    string,
    unknown
  >;
}

describe("StyleDoc v2", () => {
  it("parses a complete document", () => {
    const style = StyleDocSchema.parse(punchPop);
    expect(style.id).toBe("punch-pop");
    expect(style.version).toBe(STYLE_DOC_VERSION);
    expect(style.typography.fontFamily).toBe("Inter");
    expect(style.emphasisPresets.map((preset) => preset.id)).toContain("pop");
  });

  it("defaults the parity flags to the pre-gate answer", () => {
    const withoutFlags = draft();
    delete withoutFlags["assRenderable"];
    delete withoutFlags["assExportable"];
    delete withoutFlags["requiresLayoutMetrics"];
    const style = StyleDocSchema.parse(withoutFlags);
    expect(style.assRenderable).toBe(false);
    expect(style.assExportable).toBe(false);
    expect(style.requiresLayoutMetrics).toBe(true);
    expect(style.parityScore).toBeUndefined();
  });

  it("accepts the parity score CI writes", () => {
    expect(StyleDocSchema.parse(draft({ parityScore: 0.994 })).parityScore).toBe(0.994);
    expect(StyleDocSchema.safeParse(draft({ parityScore: 1.2 })).success).toBe(false);
  });

  it("enforces the naming rule on both id and name", () => {
    const result = StyleDocSchema.safeParse(draft({ id: "hormozi-pop", name: "Hormozi Pop" }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0])).toEqual(["id", "name"]);
    expect(result.error?.issues[0]?.message).toMatch(/D64/);
    expect(StyleDocSchema.safeParse(draft({ id: "punch-pop", name: "Punch Pop" })).success).toBe(
      true,
    );
  });

  it("requires kebab-case ids", () => {
    expect(StyleDocSchema.safeParse(draft({ id: "Punch Pop" })).success).toBe(false);
    expect(StyleDocSchema.safeParse(draft({ id: "punch--pop" })).success).toBe(false);
    expect(StyleDocSchema.safeParse(draft({ id: "punch-pop-2" })).success).toBe(true);
  });

  it("pins the schema generation", () => {
    expect(StyleDocSchema.safeParse(draft({ version: 1 as never })).success).toBe(false);
  });

  it("rejects colours that are not hex", () => {
    const style = draft();
    (style["colors"] as { text: string }).text = "white";
    expect(StyleDocSchema.safeParse(style).success).toBe(false);
  });

  it("rejects sizes and positions outside the canvas", () => {
    const oversized = draft();
    (oversized["typography"] as { sizePct: number }).sizePct = 90;
    expect(StyleDocSchema.safeParse(oversized).success).toBe(false);

    const offCanvas = draft();
    (offCanvas["layout"] as { y: number }).y = 1.4;
    expect(StyleDocSchema.safeParse(offCanvas).success).toBe(false);
  });

  it("rejects an unknown animation or highlight", () => {
    const style = draft();
    (style["animation"] as { in: { type: string } }).in.type = "explode";
    expect(StyleDocSchema.safeParse(style).success).toBe(false);

    const highlight = draft();
    (highlight["animation"] as { wordHighlight: { type: string } }).wordHighlight.type = "sparkle";
    expect(StyleDocSchema.safeParse(highlight).success).toBe(false);
  });

  it("rejects an unknown plan and category", () => {
    expect(StyleDocSchema.safeParse(draft({ minPlan: "enterprise" as never })).success).toBe(false);
    expect(StyleDocSchema.safeParse(draft({ category: "spicy" as never })).success).toBe(false);
  });

  it("keeps emphasis preset ids kebab-case", () => {
    expect(
      StyleDocSchema.safeParse(draft({ emphasisPresets: [{ id: "Pop Loud", label: "Pop" }] }))
        .success,
    ).toBe(false);
  });
});
