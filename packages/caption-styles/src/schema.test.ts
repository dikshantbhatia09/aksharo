import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { STYLES_DIR } from "./registry.js";
import {
  GradientSchema,
  isGradient,
  resolveColour,
  STYLE_DOC_VERSION,
  StyleDocSchema,
  type Gradient,
  type StyleDocInput,
} from "./schema.js";

const plainWhite = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  readFileSync(join(STYLES_DIR, "plain-white.json"), "utf8"),
) as StyleDocInput;

/** A fresh, minimal-but-complete document for mutation tests. */
function draft(overrides: Partial<StyleDocInput> = {}): Record<string, unknown> {
  return { ...(JSON.parse(JSON.stringify(plainWhite)) as StyleDocInput), ...overrides } as Record<
    string,
    unknown
  >;
}

describe("StyleDoc v2", () => {
  it("parses a complete document", () => {
    const style = StyleDocSchema.parse(plainWhite);
    expect(style.id).toBe("plain-white");
    expect(style.version).toBe(STYLE_DOC_VERSION);
    expect(style.typography.fontFamily).toBe("Inter");
    expect(style.emphasisPresets.map((preset) => preset.id)).toContain("accent");
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

describe("K05: new cue animation types", () => {
  const base = draft() as StyleDocInput;

  it.each(["zoom", "scale", "slide-left", "slide-right", "rise", "hide"] as const)(
    "accepts %s as an in/out cue type, additive to the original eight",
    (type) => {
      const parsed = StyleDocSchema.safeParse({
        ...base,
        animation: {
          ...base.animation,
          in: { type, durationMs: 200 },
          out: { type, durationMs: 200 },
        },
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.animation.in.type).toBe(type);
        expect(parsed.data.animation.out.type).toBe(type);
      }
    },
  );

  it("still rejects a type that isn't in the (now fourteen-value) enum", () => {
    const style = draft();
    (style["animation"] as { in: { type: string } }).in.type = "explode";
    expect(StyleDocSchema.safeParse(style).success).toBe(false);
  });
});

describe("animation.cueScope", () => {
  const base = draft() as StyleDocInput;

  it("is optional, so a document written before the field still parses", () => {
    expect(StyleDocSchema.safeParse(base).success).toBe(true);
    expect(StyleDocSchema.parse(base).animation.cueScope).toBeUndefined();
  });

  it("accepts line and word", () => {
    expect(
      StyleDocSchema.parse({ ...base, animation: { ...base.animation, cueScope: "line" } })
        .animation.cueScope,
    ).toBe("line");
    expect(
      StyleDocSchema.parse({ ...base, animation: { ...base.animation, cueScope: "word" } })
        .animation.cueScope,
    ).toBe("word");
  });

  it("rejects anything else", () => {
    expect(
      StyleDocSchema.safeParse({
        ...base,
        animation: { ...base.animation, cueScope: "paragraph" as never },
      }).success,
    ).toBe(false);
  });
});

describe("animation.dynamicSpeed", () => {
  const base = draft() as StyleDocInput;

  it("is optional and defaults to undefined (fixed duration), so old documents parse unchanged", () => {
    expect(StyleDocSchema.safeParse(base).success).toBe(true);
    expect(StyleDocSchema.parse(base).animation.dynamicSpeed).toBeUndefined();
  });

  it("accepts true and false", () => {
    expect(
      StyleDocSchema.parse({ ...base, animation: { ...base.animation, dynamicSpeed: true } })
        .animation.dynamicSpeed,
    ).toBe(true);
    expect(
      StyleDocSchema.parse({ ...base, animation: { ...base.animation, dynamicSpeed: false } })
        .animation.dynamicSpeed,
    ).toBe(false);
  });

  it("rejects a non-boolean", () => {
    expect(
      StyleDocSchema.safeParse({
        ...base,
        animation: { ...base.animation, dynamicSpeed: "yes" as never },
      }).success,
    ).toBe(false);
  });
});

describe("typography.strikethrough", () => {
  const base = draft() as StyleDocInput;

  it("is optional, so a document written before the field still parses", () => {
    const { strikethrough: _dropped, ...typography } = {
      strikethrough: undefined,
      ...base.typography,
    };
    const older = { ...base, typography };
    expect(StyleDocSchema.safeParse(older).success).toBe(true);
    expect(StyleDocSchema.parse(older).typography.strikethrough).toBeUndefined();
  });

  it("accepts true and false", () => {
    expect(
      StyleDocSchema.parse({ ...base, typography: { ...base.typography, strikethrough: true } })
        .typography.strikethrough,
    ).toBe(true);
    expect(
      StyleDocSchema.parse({ ...base, typography: { ...base.typography, strikethrough: false } })
        .typography.strikethrough,
    ).toBe(false);
  });

  it("rejects a non-boolean", () => {
    expect(
      StyleDocSchema.safeParse({
        ...base,
        typography: { ...base.typography, strikethrough: "yes" as never },
      }).success,
    ).toBe(false);
  });
});

describe("emphasisPresets[].fontFamily/.italic/.underline (K05)", () => {
  const base = draft() as StyleDocInput;

  it("are absent by default — every existing style JSON parses unchanged", () => {
    expect(StyleDocSchema.safeParse(base).success).toBe(true);
    for (const preset of StyleDocSchema.parse(base).emphasisPresets) {
      expect(preset.fontFamily).toBeUndefined();
      expect(preset.italic).toBeUndefined();
      expect(preset.underline).toBeUndefined();
    }
  });

  it("accepts a full typography override alongside the existing weight", () => {
    const parsed = StyleDocSchema.parse({
      ...base,
      emphasisPresets: [
        { id: "mark", fontFamily: "Poppins", weight: 800, italic: true, underline: true },
      ],
    });
    expect(parsed.emphasisPresets[0]).toMatchObject({
      id: "mark",
      fontFamily: "Poppins",
      weight: 800,
      italic: true,
      underline: true,
    });
  });

  it("rejects an empty font family", () => {
    expect(
      StyleDocSchema.safeParse({
        ...base,
        emphasisPresets: [{ id: "mark", fontFamily: "" }],
      }).success,
    ).toBe(false);
  });

  it("rejects a non-boolean italic or underline", () => {
    expect(
      StyleDocSchema.safeParse({
        ...base,
        emphasisPresets: [{ id: "mark", italic: "yes" as never }],
      }).success,
    ).toBe(false);
    expect(
      StyleDocSchema.safeParse({
        ...base,
        emphasisPresets: [{ id: "mark", underline: "yes" as never }],
      }).success,
    ).toBe(false);
  });

  it("keeps the schema at generation 2 — every K05 field is additive, not a migration", () => {
    expect(STYLE_DOC_VERSION).toBe(2);
    expect(
      StyleDocSchema.parse({
        ...base,
        emphasisPresets: [{ id: "mark", fontFamily: "Poppins", italic: true, underline: true }],
      }).version,
    ).toBe(2);
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

describe("colors.text / emphasisPresets[].color: string | Gradient (K08)", () => {
  const base = draft() as StyleDocInput;
  const gradient: Gradient = {
    stops: [
      { offset: 0, color: "#ff2e63" },
      { offset: 0.5, color: "#ffd400" },
      { offset: 1, color: "#3fa7d6" },
    ],
    angleDeg: 45,
  };

  it("still accepts a plain hex string — every existing style JSON parses unchanged", () => {
    expect(StyleDocSchema.safeParse(base).success).toBe(true);
    expect(StyleDocSchema.parse(base).colors.text).toBe(plainWhite.colors.text);
  });

  it("accepts a Gradient in colors.text", () => {
    const parsed = StyleDocSchema.parse({
      ...base,
      colors: { ...base.colors, text: gradient },
    });
    expect(parsed.colors.text).toEqual(gradient);
  });

  it("accepts a Gradient in emphasisPresets[].color, alongside a preset that keeps a plain string", () => {
    const parsed = StyleDocSchema.parse({
      ...base,
      emphasisPresets: [
        { id: "grad", color: gradient },
        { id: "flat", color: "#ffffff" },
      ],
    });
    expect(parsed.emphasisPresets[0]?.color).toEqual(gradient);
    expect(parsed.emphasisPresets[1]?.color).toBe("#ffffff");
  });

  it("rejects fewer than two stops", () => {
    expect(
      StyleDocSchema.safeParse({
        ...base,
        colors: { ...base.colors, text: { stops: [{ offset: 0, color: "#ffffff" }], angleDeg: 0 } },
      }).success,
    ).toBe(false);
  });

  it("rejects more than six stops", () => {
    const tooMany = {
      stops: Array.from({ length: 7 }, (_unused, index) => ({
        offset: index / 6,
        color: "#ffffff",
      })),
      angleDeg: 0,
    };
    expect(
      StyleDocSchema.safeParse({ ...base, colors: { ...base.colors, text: tooMany } }).success,
    ).toBe(false);
  });

  it("rejects a stop offset outside 0-1 and an angle outside 0-360", () => {
    expect(
      GradientSchema.safeParse({
        stops: [
          { offset: -0.1, color: "#ffffff" },
          { offset: 1, color: "#000000" },
        ],
        angleDeg: 0,
      }).success,
    ).toBe(false);
    expect(
      GradientSchema.safeParse({
        stops: [
          { offset: 0, color: "#ffffff" },
          { offset: 1, color: "#000000" },
        ],
        angleDeg: 361,
      }).success,
    ).toBe(false);
  });

  it("rejects a non-hex stop colour", () => {
    expect(
      GradientSchema.safeParse({
        stops: [
          { offset: 0, color: "white" },
          { offset: 1, color: "#000000" },
        ],
        angleDeg: 0,
      }).success,
    ).toBe(false);
  });

  it("keeps the schema at generation 2 — the field is additive, not a migration", () => {
    expect(STYLE_DOC_VERSION).toBe(2);
    expect(
      StyleDocSchema.parse({ ...base, colors: { ...base.colors, text: gradient } }).version,
    ).toBe(2);
  });
});

describe("isGradient / resolveColour (K08)", () => {
  const gradient: Gradient = {
    stops: [
      { offset: 0, color: "#ff2e63" },
      { offset: 1, color: "#3fa7d6" },
    ],
    angleDeg: 90,
  };

  it("isGradient narrows a string | Gradient value", () => {
    expect(isGradient("#ffffff")).toBe(false);
    expect(isGradient(gradient)).toBe(true);
  });

  it("resolveColour passes a plain string through unchanged", () => {
    expect(resolveColour("#123456")).toBe("#123456");
  });

  it("resolveColour reads a Gradient's first stop", () => {
    expect(resolveColour(gradient)).toBe("#ff2e63");
  });
});
