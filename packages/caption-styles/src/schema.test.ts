import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { STYLES_DIR } from "./registry.js";
import { STYLE_DOC_VERSION, StyleDocSchema, type StyleDocInput } from "./schema.js";

const punchPop = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
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
    delete withoutFlags["parityScore"];
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

describe("typography.scriptScale", () => {
  const base = draft() as StyleDocInput;

  it("is optional, so a document written before the field still parses", () => {
    const { scriptScale: _dropped, ...typography } = base.typography;
    const older = { ...base, typography };
    expect(StyleDocSchema.safeParse(older).success).toBe(true);
    expect(StyleDocSchema.parse(older).typography.scriptScale).toBeUndefined();
  });

  it("accepts lowercase four-letter OpenType tags", () => {
    const parsed = StyleDocSchema.parse({
      ...base,
      typography: { ...base.typography, scriptScale: { deva: 0.8, taml: 0.62, latn: 1 } },
    });
    expect(parsed.typography.scriptScale).toEqual({ deva: 0.8, taml: 0.62, latn: 1 });
  });

  it("rejects a key that is not a script tag", () => {
    const parsed = StyleDocSchema.safeParse({
      ...base,
      typography: { ...base.typography, scriptScale: { Devanagari: 0.8 } },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a multiplier that is zero, negative or absurd", () => {
    for (const value of [0, -1, 3]) {
      const parsed = StyleDocSchema.safeParse({
        ...base,
        typography: { ...base.typography, scriptScale: { deva: value } },
      });
      expect(parsed.success, `scriptScale.deva = ${String(value)} should be rejected`).toBe(false);
    }
  });

  it("keeps the schema at generation 2 — the field is additive, not a migration", () => {
    expect(STYLE_DOC_VERSION).toBe(2);
    expect(
      StyleDocSchema.parse({
        ...base,
        typography: { ...base.typography, scriptScale: { taml: 0.6 } },
      }).version,
    ).toBe(2);
  });
});

describe("typography.underline", () => {
  const base = draft() as StyleDocInput;

  it("is optional, so a document written before the field still parses", () => {
    const { underline: _dropped, ...typography } = { underline: undefined, ...base.typography };
    const older = { ...base, typography };
    expect(StyleDocSchema.safeParse(older).success).toBe(true);
    expect(StyleDocSchema.parse(older).typography.underline).toBeUndefined();
  });

  it("accepts true and false", () => {
    expect(
      StyleDocSchema.parse({ ...base, typography: { ...base.typography, underline: true } })
        .typography.underline,
    ).toBe(true);
    expect(
      StyleDocSchema.parse({ ...base, typography: { ...base.typography, underline: false } })
        .typography.underline,
    ).toBe(false);
  });

  it("rejects a non-boolean", () => {
    expect(
      StyleDocSchema.safeParse({
        ...base,
        typography: { ...base.typography, underline: "yes" as never },
      }).success,
    ).toBe(false);
  });
});

describe("depth3d", () => {
  const base = draft() as StyleDocInput;

  it("is absent by default — every existing style JSON parses unchanged", () => {
    expect(StyleDocSchema.safeParse(base).success).toBe(true);
    expect(StyleDocSchema.parse(base).depth3d).toBeUndefined();
  });

  it("accepts a full depth3d document", () => {
    const parsed = StyleDocSchema.parse({
      ...base,
      depth3d: { enabled: true, color: "#101014", offsetPct: 6, layers: 6 },
    });
    expect(parsed.depth3d).toEqual({ enabled: true, color: "#101014", offsetPct: 6, layers: 6 });
  });

  it("makes layers optional", () => {
    const parsed = StyleDocSchema.parse({
      ...base,
      depth3d: { enabled: true, color: "#101014", offsetPct: 6 },
    });
    expect(parsed.depth3d?.layers).toBeUndefined();
  });

  it("rejects a non-hex colour and an out-of-range offset or layer count", () => {
    expect(
      StyleDocSchema.safeParse({
        ...base,
        depth3d: { enabled: true, color: "black", offsetPct: 6 },
      }).success,
    ).toBe(false);
    expect(
      StyleDocSchema.safeParse({
        ...base,
        depth3d: { enabled: true, color: "#101014", offsetPct: 99 },
      }).success,
    ).toBe(false);
    expect(
      StyleDocSchema.safeParse({
        ...base,
        depth3d: { enabled: true, color: "#101014", offsetPct: 6, layers: 20 },
      }).success,
    ).toBe(false);
  });

  it("keeps the schema at generation 2 — the field is additive, not a migration", () => {
    expect(STYLE_DOC_VERSION).toBe(2);
    expect(
      StyleDocSchema.parse({
        ...base,
        depth3d: { enabled: true, color: "#101014", offsetPct: 6 },
      }).version,
    ).toBe(2);
  });
});
