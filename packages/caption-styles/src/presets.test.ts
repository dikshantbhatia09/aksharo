import { describe, expect, it } from "vitest";

import {
  BUILTIN_PRESETS,
  compilePresetToStyleDoc,
  SYSTEM_STYLE_TO_VIRAL_PRESET,
  VIRAL_FONT_FALLBACKS,
  VIRAL_PRESET_COMPLIANT_NAMES,
  VIRAL_PRESET_TO_SYSTEM_STYLE,
  ViralPresetCatalogueSchema,
  ViralPresetItemSchema,
  ViralPresetKeySchema,
} from "./presets.js";
import { StyleDocSchema } from "./schema.js";

describe("Popular Viral Caption Style Presets Engine (Pillar 4 §06)", () => {
  it("validates all built-in viral presets against ViralPresetItemSchema", () => {
    const keys = Object.keys(BUILTIN_PRESETS);
    expect(keys).toHaveLength(5);

    for (const [key, preset] of Object.entries(BUILTIN_PRESETS)) {
      expect(ViralPresetKeySchema.safeParse(key).success, `Key ${key} invalid`).toBe(true);

      const parsed = ViralPresetItemSchema.safeParse(preset);
      expect(parsed.success, `Preset ${key} failed schema: ${parsed.error?.message}`).toBe(true);

      // Verify non-zero font sizes
      expect(preset.fontSize).toBeGreaterThan(20);
      expect(preset.fontSize).toBeLessThanOrEqual(100);

      // Verify words per screen
      expect(preset.maxWordsPerScreen).toBeGreaterThanOrEqual(1);
      expect(preset.maxWordsPerScreen).toBeLessThanOrEqual(10);

      // Verify colors are valid hex or rgba
      expect(preset.colorInactive).toMatch(/^(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\()/);
      expect(preset.colorActive).toMatch(/^(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\()/);

      if (preset.strokeColor) {
        expect(preset.strokeColor).toMatch(/^(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\()/);
      }
      if (preset.shadowColor) {
        expect(preset.shadowColor).toMatch(/^(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\()/);
      }
    }

    // Verify whole catalogue schema parses cleanly
    const catalogueParsed = ViralPresetCatalogueSchema.safeParse(BUILTIN_PRESETS);
    expect(catalogueParsed.success).toBe(true);
  });

  it("verifies gold-standard design presets specifications", () => {
    // 1. Hormozi Neon Pop
    const hormozi = BUILTIN_PRESETS.hormozi_neon;
    expect(hormozi.name).toBe("Hormozi Neon Pop");
    expect(hormozi.fontFamily).toBe("The Bold Font");
    expect(hormozi.textTransform).toBe("uppercase");
    expect(hormozi.colorActive).toBe("#FEE715"); // Neon Yellow
    expect(hormozi.strokeWidth).toBe(10);
    expect(hormozi.animation).toBe("POP_BOUNCE");
    expect(hormozi.maxWordsPerScreen).toBe(3);

    // 2. MrBeast Comic
    const mrbeast = BUILTIN_PRESETS.mrbeast_comic;
    expect(mrbeast.name).toBe("MrBeast Comic");
    expect(mrbeast.fontFamily).toBe("Komika Axis");
    expect(mrbeast.textTransform).toBe("uppercase");
    expect(mrbeast.colorActive).toBe("#00E5FF");
    expect(mrbeast.strokeWidth).toBe(8);
    expect(mrbeast.animation).toBe("COMIC_TILT");

    // 3. Karaoke Cyan
    const karaoke = BUILTIN_PRESETS.karaoke_cyan;
    expect(karaoke.name).toBe("Karaoke Cyan");
    expect(karaoke.fontFamily).toBe("Montserrat");
    expect(karaoke.textTransform).toBe("uppercase");
    expect(karaoke.colorActive).toBe("#00FFA3"); // Vivid Mint / Cyan
    expect(karaoke.animation).toBe("KARAOKE_FILL");

    // 4. Editorial Ghost
    const editorial = BUILTIN_PRESETS.editorial_ghost;
    expect(editorial.name).toBe("Editorial Ghost");
    expect(editorial.fontFamily).toBe("Cabinet Grotesk");
    expect(editorial.textTransform).toBe("none");
    expect(editorial.backgroundPill).toBeDefined();
    expect(editorial.backgroundPill?.borderRadius).toBe(12);
    expect(editorial.animation).toBe("PROGRESSIVE_FADE");

    // 5. Neon Cyber Pulse
    const neon = BUILTIN_PRESETS.neon_pulse;
    expect(neon.name).toBe("Neon Cyber Pulse");
    expect(neon.fontFamily).toBe("Orbitron");
    expect(neon.colorActive).toBe("#00F0FF");
    expect(neon.animation).toBe("NEON_GLOW");
  });

  it("compiles each viral preset into a valid StyleDoc schema document", () => {
    for (const [key] of Object.entries(BUILTIN_PRESETS)) {
      const styleDoc = compilePresetToStyleDoc(key as keyof typeof BUILTIN_PRESETS);

      // Must validate against full StyleDocSchema (including D64 naming rule)
      const parsed = StyleDocSchema.safeParse(styleDoc);
      expect(
        parsed.success,
        `Compiled StyleDoc for ${key} failed StyleDocSchema: ${JSON.stringify(parsed.error?.issues)}`,
      ).toBe(true);

      expect(styleDoc.version).toBe(2);
      expect(styleDoc.typography.sizePct).toBeGreaterThan(0);
      expect(styleDoc.typography.fallbacks?.length).toBeGreaterThan(0);
      expect(styleDoc.colors.text).toBeTruthy();
      expect(styleDoc.colors.activeText).toBeTruthy();
      expect(styleDoc.layout.wordsPerCue).toBeGreaterThanOrEqual(1);
    }
  });

  it("preserves bidirectional mapping with existing system styles", () => {
    for (const [key, systemStyleId] of Object.entries(VIRAL_PRESET_TO_SYSTEM_STYLE)) {
      expect(SYSTEM_STYLE_TO_VIRAL_PRESET[systemStyleId]).toBe(key);
      expect(VIRAL_PRESET_COMPLIANT_NAMES[key as keyof typeof VIRAL_PRESET_COMPLIANT_NAMES]).toBeTruthy();
    }
  });

  it("provides reliable bundled fallbacks for all viral display fonts", () => {
    for (const preset of Object.values(BUILTIN_PRESETS)) {
      const fallbacks = VIRAL_FONT_FALLBACKS[preset.fontFamily];
      expect(fallbacks, `Missing fallbacks for ${preset.fontFamily}`).toBeDefined();
      expect(fallbacks?.length).toBeGreaterThanOrEqual(3);
      expect(fallbacks).toContain("Noto Sans Devanagari");
    }
  });
});

