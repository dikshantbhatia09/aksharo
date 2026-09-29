import { describe, expect, it } from "vitest";

import { DEFAULT_BRAND_KIT_SETTINGS, contrastRatio, type BrandKitSettings } from "@montaj/edg";
import { AudiogramSchema } from "@montaj/repurpose-contracts";

import {
  AUDIOGRAM_DEFAULT_COLOURS,
  audiogramOf,
  coverAssetIdOf,
  hasNoPicture,
  readableOn,
} from "./audiogram.js";

const WS = "01JCWS0000000000000000000A";
const COVER = { key: `ws/${WS}/brand/01JCC0VER00000000000000000.jpg`, format: "jpeg" } as const;
const LOGO = { key: `ws/${WS}/brand/01JCL0G0000000000000000000.png`, format: "png" } as const;

function kit(colors: Partial<BrandKitSettings["colors"]> = {}): BrandKitSettings {
  return {
    ...DEFAULT_BRAND_KIT_SETTINGS,
    colors: { ...DEFAULT_BRAND_KIT_SETTINGS.colors, ...colors },
  };
}

describe("audiogramOf", () => {
  it("draws a calm dark ground and a light waveform with no kit and no cover", () => {
    const audiogram = audiogramOf({ kit: null, cover: null });
    expect(audiogram).toEqual({
      background: AUDIOGRAM_DEFAULT_COLOURS.background,
      accent: AUDIOGRAM_DEFAULT_COLOURS.accent,
    });
    expect(AudiogramSchema.safeParse(audiogram).success).toBe(true);
    expect(
      contrastRatio(AUDIOGRAM_DEFAULT_COLOURS.background, AUDIOGRAM_DEFAULT_COLOURS.accent),
    ).toBeGreaterThan(7);
  });

  it("takes the kit's secondary for the ground and its primary for the waveform", () => {
    const audiogram = audiogramOf({
      kit: { settings: kit({ primary: "#FFD400", secondary: "#102040" }) },
      cover: null,
    });
    expect(audiogram).toEqual({ background: "#102040", accent: "#ffd400" });
  });

  it("draws the waveform in black or white when the kit's colours would not read", () => {
    const light = audiogramOf({
      kit: { settings: kit({ primary: "#f5f5f5", secondary: "#ffffff" }) },
      cover: null,
    });
    expect(light.accent).toBe("#000000");
    const dark = audiogramOf({
      kit: { settings: kit({ primary: "#141414", secondary: "#000000" }) },
      cover: null,
    });
    expect(dark.accent).toBe("#ffffff");
    expect(readableOn("#141217", "#f0508a")).toBe("#f0508a");
  });

  it("uses the run's cover first, then the kit's logo, then nothing", () => {
    const withBoth = audiogramOf({ kit: { settings: kit(), logo: LOGO }, cover: COVER });
    expect(withBoth.artwork).toEqual(COVER);
    const logoOnly = audiogramOf({ kit: { settings: kit(), logo: LOGO }, cover: null });
    expect(logoOnly.artwork).toEqual(LOGO);
    // A cover without a kit keeps the default colours.
    const coverOnly = audiogramOf({ kit: null, cover: COVER });
    expect(coverOnly).toEqual({ ...AUDIOGRAM_DEFAULT_COLOURS, artwork: COVER });
    expect(AudiogramSchema.safeParse(withBoth).success).toBe(true);
  });
});

describe("coverAssetIdOf", () => {
  it("reads the cover a run was started with, and nothing else", () => {
    const id = "01JCC0VER00000000000000000";
    expect(coverAssetIdOf({ config: { audiogram: { coverAssetId: id } } })).toBe(id);
    expect(coverAssetIdOf({ config: {} })).toBeUndefined();
    expect(coverAssetIdOf({ config: null })).toBeUndefined();
    expect(coverAssetIdOf({ config: { audiogram: { coverAssetId: "../x" } } })).toBeUndefined();
    expect(coverAssetIdOf({ config: { audiogram: "cover" } })).toBeUndefined();
  });
});

describe("hasNoPicture", () => {
  it("is a probed source with no picture size: audio only", () => {
    expect(hasNoPicture({ width: null, height: null })).toBe(true);
    expect(hasNoPicture({ width: 1_920, height: 1_080 })).toBe(false);
  });
});
