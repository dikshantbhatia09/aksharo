import { describe, expect, it } from "vitest";

import { NAMED_EXPORT_PRESETS, resolveOnboardingExportPreset } from "./onboarding-preset";

describe("resolveOnboardingExportPreset (B17 preset)", () => {
  it("maps each of B17's onboarding-flow.tsx MAKE_DEFAULTS labels to a named preset", () => {
    expect(resolveOnboardingExportPreset("reels")).toMatchObject({
      id: "reels-1080-vertical",
      preset: "reels",
      aspect: "9:16",
    });
    expect(resolveOnboardingExportPreset("youtube")).toMatchObject({
      id: "youtube-1080",
      preset: "youtube-4k",
      aspect: "16:9",
    });
    expect(resolveOnboardingExportPreset("podcast-clip")).toMatchObject({
      id: "podcast-clip",
      preset: "square",
      aspect: "1:1",
    });
    expect(resolveOnboardingExportPreset("client-review")).toMatchObject({
      id: "client-review",
      preset: "youtube-4k",
      aspect: "16:9",
    });
    expect(resolveOnboardingExportPreset("highlights")).toMatchObject({
      id: "highlights-1080-vertical",
      preset: "reels",
      aspect: "9:16",
    });
  });

  it("falls back to the default preset when the field is absent", () => {
    expect(resolveOnboardingExportPreset(undefined).id).toBe("reels-1080-vertical");
    expect(resolveOnboardingExportPreset(null).id).toBe("reels-1080-vertical");
  });

  it("falls back to the default preset for an unrecognised label (a future onboarding option)", () => {
    expect(resolveOnboardingExportPreset("cooking-show-intro").id).toBe("reels-1080-vertical");
  });

  it("every named preset resolves to a RenderPreset RENDER_PRESETS actually carries", () => {
    const validPresets = new Set(["reels", "shorts", "youtube-4k", "square", "custom"]);
    for (const named of NAMED_EXPORT_PRESETS) {
      expect(validPresets.has(named.preset)).toBe(true);
    }
  });

  it("every named preset id is unique", () => {
    const ids = NAMED_EXPORT_PRESETS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
