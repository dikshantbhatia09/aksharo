import { describe, expect, it } from "vitest";

import { loadSystemStyles } from "@montaj/caption-styles";

import { capabilitiesOf, EFFECT_ONLY_STYLE_IDS } from "./capabilities.js";

const styles = loadSystemStyles();

describe("capabilitiesOf", () => {
  it("judges every shipped style without throwing", () => {
    for (const style of styles) {
      const capability = capabilitiesOf(style);
      expect(capability.styleId).toBe(style.id);
      expect(capability.assExportable).toBe(true);
    }
  });

  it("flags effect-only styles as not likely renderable", () => {
    for (const id of EFFECT_ONLY_STYLE_IDS.keys()) {
      const style = styles.find((candidate) => candidate.id === id);
      if (style === undefined) continue;
      expect(capabilitiesOf(style).likelyRenderable).toBe(false);
    }
  });

  it("marks karaoke-fill as reasoned but Latin-only", () => {
    const karaoke = styles.find((style) => style.animation.wordHighlight.type === "karaoke-fill");
    expect(karaoke).toBeDefined();
    if (karaoke === undefined) return;
    const capability = capabilitiesOf(karaoke);
    expect(capability.reasons.some((reason) => reason.includes("Latin"))).toBe(true);
  });

  it("requires layout metrics for a non-none word highlight", () => {
    const style = styles.find(
      (candidate) =>
        candidate.animation.wordHighlight.type !== "none" &&
        !EFFECT_ONLY_STYLE_IDS.has(candidate.id),
    );
    expect(style).toBeDefined();
    if (style === undefined) return;
    expect(capabilitiesOf(style).requiresLayoutMetrics).toBe(true);
  });

  it("does not require layout metrics for a plain, box-free style", () => {
    const style = styles.find(
      (candidate) =>
        candidate.animation.wordHighlight.type === "none" &&
        !candidate.animation.perWord &&
        candidate.box.mode !== "word",
    );
    expect(style).toBeDefined();
    if (style === undefined) return;
    expect(capabilitiesOf(style).requiresLayoutMetrics).toBe(false);
  });
});
