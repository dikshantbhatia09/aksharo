import { describe, expect, it } from "vitest";

import {
  brandCaptionOverrides,
  brandEndCardOverlay,
  brandHookAppearance,
  brandKitSettingsOf,
  BrandKitSettingsSchema,
  brandLogoOverlay,
  contrastRatio,
  DEFAULT_BRAND_KIT_SETTINGS,
  stableOverlayId,
  type BrandKitSettings,
} from "./brand.js";
import { ULID_PATTERN } from "./ids.js";
import { OverlaySchema } from "./schemas/document.js";

const IMAGE = {
  assetId: "01JASSET000000000000000000",
  format: "png",
  width: 400,
  height: 200,
} as const;
const WINDOW = { startMs: 0, endMs: 30_000 };

function kit(patch: Partial<BrandKitSettings> = {}): BrandKitSettings {
  return { ...DEFAULT_BRAND_KIT_SETTINGS, ...patch };
}

describe("BrandKitSettingsSchema", () => {
  it("takes the defaults, and refuses a colour, a size or a line out of bounds", () => {
    expect(BrandKitSettingsSchema.safeParse(DEFAULT_BRAND_KIT_SETTINGS).success).toBe(true);
    const bad: unknown[] = [
      { ...kit(), colors: { ...kit().colors, primary: "pink" } },
      { ...kit(), logo: { ...kit().logo, sizePct: 80 } },
      { ...kit(), logo: { ...kit().logo, corner: "centre" } },
      { ...kit(), endCard: { ...kit().endCard, cta: "x".repeat(61) } },
      { ...kit(), endCard: { ...kit().endCard, handle: "x".repeat(41) } },
      { ...kit(), endCard: { ...kit().endCard, durationMs: 5_000 } },
      { ...kit(), captions: { fontFamily: "" } },
    ];
    for (const value of bad) expect(BrandKitSettingsSchema.safeParse(value).success).toBe(false);
  });
});

describe("brandKitSettingsOf", () => {
  it("reads a stored kit, and falls back to the defaults for what is missing or broken", () => {
    expect(brandKitSettingsOf(null)).toEqual(DEFAULT_BRAND_KIT_SETTINGS);
    expect(brandKitSettingsOf({ v: 1, colors: { primary: "#112233" } }).colors).toEqual({
      ...DEFAULT_BRAND_KIT_SETTINGS.colors,
      primary: "#112233",
    });
    expect(brandKitSettingsOf({ v: 1, colors: { primary: "nope" } })).toEqual(
      DEFAULT_BRAND_KIT_SETTINGS,
    );
  });
});

describe("brandCaptionOverrides", () => {
  it("changes nothing about the captions for a kit that sets none of them", () => {
    expect(brandCaptionOverrides(kit())).toBeUndefined();
  });

  it("sets the typeface and colours the kit names, and recolours the keyword emphasis", () => {
    const overrides = brandCaptionOverrides(
      kit({
        captions: {
          fontFamily: "Poppins",
          fill: "#ffffff",
          highlight: "#f0508a",
          stroke: "#000000",
        },
      }),
      {
        presets: [
          { id: "pop", effect: "none", color: "#ffd400" },
          { id: "shout", effect: "shake", color: "#ff2e63" },
        ],
        keywordPresetId: "pop",
      },
    );
    expect(overrides).toEqual({
      typography: { fontFamily: "Poppins" },
      colors: { text: "#ffffff", activeText: "#f0508a" },
      stroke: { color: "#000000" },
      emphasisPresets: [
        { id: "pop", effect: "none", color: "#f0508a" },
        { id: "shout", effect: "shake", color: "#ff2e63" },
      ],
    });
  });

  it("leaves the emphasis list alone when there is no highlight or no keyword preset", () => {
    const presets = [{ id: "pop", color: "#ffd400" }];
    expect(
      brandCaptionOverrides(kit({ captions: { fill: "#ffffff" } }), {
        presets,
        keywordPresetId: "pop",
      }),
    ).toEqual({ colors: { text: "#ffffff" } });
    expect(brandCaptionOverrides(kit({ captions: { highlight: "#f0508a" } }), { presets })).toEqual(
      { colors: { activeText: "#f0508a" } },
    );
  });
});

describe("brandHookAppearance", () => {
  it("puts the words on the brand's primary colour, in its ink when that reads", () => {
    expect(brandHookAppearance(kit())).toEqual({ background: "#f0508a" });
    const dark = brandHookAppearance(
      kit({ colors: { primary: "#141217", secondary: "#000000", text: "#f1ece6" } }),
    );
    expect(dark).toEqual({ background: "#141217", text: "#f1ece6" });
    expect(
      brandHookAppearance(
        kit({ hookTitle: { fontFamily: "Anton", background: "#ffffff", text: "#111111" } }),
      ),
    ).toEqual({ fontFamily: "Anton", background: "#ffffff", text: "#111111" });
    // The captions' typeface when the title names none.
    expect(brandHookAppearance(kit({ captions: { fontFamily: "Poppins" } })).fontFamily).toBe(
      "Poppins",
    );
  });
});

describe("brandLogoOverlay", () => {
  it("is the kit's placement for a logo it shows, and nothing without one", () => {
    const logo = brandLogoOverlay(kit(), IMAGE, stableOverlayId("v:logo"), WINDOW);
    expect(logo).toEqual({
      id: stableOverlayId("v:logo"),
      kind: "logo",
      ...WINDOW,
      image: IMAGE,
      corner: "top-right",
      sizePct: 16,
      opacity: 0.9,
      marginPct: 4,
    });
    expect(OverlaySchema.safeParse(logo).success).toBe(true);
    expect(brandLogoOverlay(kit(), undefined, "x", WINDOW)).toBeUndefined();
    expect(
      brandLogoOverlay(kit({ logo: { ...kit().logo, show: false } }), IMAGE, "x", WINDOW),
    ).toBeUndefined();
  });
});

describe("brandEndCardOverlay", () => {
  const on = (patch: Partial<BrandKitSettings["endCard"]> = {}): BrandKitSettings =>
    kit({
      endCard: {
        ...kit().endCard,
        enabled: true,
        cta: "  Follow for more  ",
        handle: "@aksharo",
        ...patch,
      },
    });

  it("is off until the kit turns it on, and needs something to show", () => {
    expect(brandEndCardOverlay(kit(), IMAGE, "x", WINDOW)).toBeUndefined();
    expect(
      brandEndCardOverlay(on({ cta: " ", handle: "", showLogo: false }), IMAGE, "x", WINDOW),
    ).toBeUndefined();
    // The logo alone is enough.
    expect(brandEndCardOverlay(on({ cta: "", handle: "" }), IMAGE, "x", WINDOW)?.image).toEqual(
      IMAGE,
    );
  });

  it("carries the words, the card's colour, and the kit's ink and accent where they read", () => {
    const card = brandEndCardOverlay(on(), IMAGE, stableOverlayId("v:end-card"), {
      startMs: 27_000,
      endMs: 30_000,
    });
    expect(card).toMatchObject({
      kind: "end-card",
      cta: "Follow for more",
      handle: "@aksharo",
      background: "#141217",
      text: "#f1ece6",
      accent: "#f0508a",
      image: IMAGE,
    });
    expect(OverlaySchema.safeParse(card).success).toBe(true);
    // On a light card, a light ink is left for render-core to replace.
    const light = brandEndCardOverlay(on({ background: "#fafafa" }), undefined, "x", WINDOW);
    expect(light).not.toHaveProperty("text");
    expect(light).not.toHaveProperty("image");
  });
});

describe("contrastRatio and stableOverlayId", () => {
  it("measures WCAG contrast", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("gives a ULID-shaped id that is the same for the same seed and differs otherwise", () => {
    const id = stableOverlayId("01JVARIANT0000000000000000:logo");
    expect(id).toMatch(ULID_PATTERN);
    expect(stableOverlayId("01JVARIANT0000000000000000:logo")).toBe(id);
    expect(stableOverlayId("01JVARIANT0000000000000000:end-card")).not.toBe(id);
  });
});
