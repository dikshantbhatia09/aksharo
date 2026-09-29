import { describe, expect, it } from "vitest";

import {
  BRAND_MUSIC_DUCK,
  BRAND_MUSIC_LEVELS,
  brandCaptionOverrides,
  brandEndCardOverlay,
  brandHookAppearance,
  brandKitSettingsOf,
  BrandKitSettingsSchema,
  brandLogoOverlay,
  brandMusicPass,
  contrastRatio,
  DEFAULT_BRAND_KIT_SETTINGS,
  isWorkspaceMusicItem,
  stableOverlayId,
  WORKSPACE_MUSIC_PACK_ID,
  type BrandKitSettings,
} from "./brand.js";
import { ULID_PATTERN } from "./ids.js";
import { OverlaySchema } from "./schemas/document.js";
import { PassSchema } from "./schemas/pass.js";

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

describe("the kit's music (2026-10-04)", () => {
  const TRACK = {
    assetId: "01JM0S1C000000000000000000",
    rightsAttestedAt: "2026-10-04T09:00:00.000Z",
    rightsAttestedBy: "01JUSER0000000000000000000",
    title: "Morning theme",
  } as const;
  const ids = {
    passId: stableOverlayId("01JVAR1ANT000000000000000:music-pass"),
    itemId: stableOverlayId("01JVAR1ANT000000000000000:music"),
  };

  it("is on and quiet by default, and a kit saved without it still parses", () => {
    expect(DEFAULT_BRAND_KIT_SETTINGS.music).toEqual({ enabled: true, level: "quiet" });
    const { music: _music, ...older } = DEFAULT_BRAND_KIT_SETTINGS;
    const parsed = BrandKitSettingsSchema.parse(older);
    expect(parsed.music).toEqual({ enabled: true, level: "quiet" });
    expect(
      BrandKitSettingsSchema.safeParse({ ...kit(), music: { enabled: true, level: "loud" } })
        .success,
    ).toBe(false);
  });

  it("reads a stored kit's music, and the default for a kit from before it", () => {
    expect(brandKitSettingsOf({ v: 1 }).music).toEqual(DEFAULT_BRAND_KIT_SETTINGS.music);
    expect(brandKitSettingsOf({ v: 1, music: { enabled: false } }).music).toEqual({
      enabled: false,
      level: "quiet",
    });
  });

  it("lays one accepted, looped, ducked bed over the whole clip", () => {
    const pass = brandMusicPass({
      settings: kit({ music: { enabled: true, level: "medium" } }),
      music: TRACK,
      durationMs: 31_250.4,
      ...ids,
    });
    expect(pass).toBeDefined();
    const parsed = PassSchema.parse(pass);
    expect(parsed).toMatchObject({ type: "music", status: "ready", passId: ids.passId });
    expect(ULID_PATTERN.test(parsed.passId)).toBe(true);
    const [item] = parsed.items;
    expect(item).toMatchObject({
      itemId: ids.itemId,
      kind: "music",
      state: "accepted",
      startMs: 0,
      endMs: 31_250,
      payload: {
        assetId: TRACK.assetId,
        packId: WORKSPACE_MUSIC_PACK_ID,
        durationMs: 31_250,
        gainDb: BRAND_MUSIC_LEVELS.medium,
        loopPolicy: "loop",
        bedDuck: BRAND_MUSIC_DUCK,
        licenceSnapshot: {
          source: "workspace",
          rightsAttestedAt: TRACK.rightsAttestedAt,
          rightsAttestedBy: TRACK.rightsAttestedBy,
          title: "Morning theme",
        },
      },
    });
    expect(item !== undefined && isWorkspaceMusicItem(item)).toBe(true);
    expect(BRAND_MUSIC_LEVELS.quiet).toBeLessThan(BRAND_MUSIC_LEVELS.medium);
  });

  it("lays nothing when the kit's music is off, or the clip has no length", () => {
    expect(
      brandMusicPass({
        settings: kit({ music: { enabled: false, level: "quiet" } }),
        music: TRACK,
        durationMs: 30_000,
        ...ids,
      }),
    ).toBeUndefined();
    expect(
      brandMusicPass({ settings: kit(), music: TRACK, durationMs: 0, ...ids }),
    ).toBeUndefined();
  });

  it("tells a workspace's bed from a catalogue one", () => {
    const pass = brandMusicPass({ settings: kit(), music: TRACK, durationMs: 5_000, ...ids });
    const item = pass?.items[0];
    expect(item).toBeDefined();
    if (item === undefined || item.kind !== "music") return;
    expect(
      isWorkspaceMusicItem({ ...item, payload: { ...item.payload, packId: "d05-core" } }),
    ).toBe(false);
  });
});
