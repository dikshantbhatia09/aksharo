import { describe, expect, it } from "vitest";

import { loadSystemStyles } from "@montaj/caption-styles";

import { buildAeStyleMap, classifyStyle } from "./ae-style-map.js";

// Same expected table as C06b's `plugins/premiere-uxp/src/styles/mogrt-map.test.ts` — this
// package's font-family gate and shared classification rules are identical (both mirror the
// same C08b canonical rules and the same `packages/fonts` bundled-family list), so the same 30
// system styles land in the same buckets: 19 supported / 6 approximate / 5 unsupported.
const EXPECTED_STATUS: Record<string, "supported" | "approximate" | "unsupported"> = {
  "arcade-pixel": "supported",
  "bold-drop": "supported",
  "box-block": "supported",
  "bubble-soft": "approximate",
  "caption-card": "approximate",
  "duo-tone": "supported",
  "glitch-shift": "supported",
  "gradient-sweep": "supported",
  "highlight-marker": "approximate",
  "hype-bold": "supported",
  "impact-shout": "approximate",
  "karaoke-fill": "unsupported",
  "liquid-glass": "unsupported",
  "minimal-lower-third": "supported",
  "neon-glow": "unsupported",
  "news-ticker": "supported",
  "outline-only": "supported",
  "podcast-duo": "unsupported",
  "prism-split": "supported",
  "punch-pop": "supported",
  "quote-frame": "approximate",
  "soft-serif": "supported",
  "spotlight-word": "supported",
  "stroke-heavy": "supported",
  "subtitle-classic": "supported",
  "tape-retro": "supported",
  "typewriter-mono": "unsupported",
  "vertical-clean": "supported",
  "whisper-thin": "supported",
  "word-pop": "approximate",
};

describe("classifyStyle", () => {
  it("matches the expected status for every style", () => {
    const styles = loadSystemStyles();
    for (const style of styles) {
      const expected = EXPECTED_STATUS[style.id];
      expect(expected, `no expected status recorded for "${style.id}"`).toBeDefined();
      expect(classifyStyle(style).support, `unexpected status for "${style.id}"`).toBe(expected);
    }
  });

  it("marks a font outside the bundled OFL pack unsupported regardless of other rules", () => {
    const style = loadSystemStyles().find((s) => s.id === "subtitle-classic")!;
    const withUnbundledFont = {
      ...style,
      typography: { ...style.typography, fontFamily: "Comic Sans MS" },
    };
    const result = classifyStyle(withUnbundledFont);
    expect(result.support).toBe("unsupported");
    expect(result.reasons.some((r) => r.includes("bundled OFL pack"))).toBe(true);
  });
});

describe("buildAeStyleMap", () => {
  it("counts 19 supported / 6 approximate / 5 unsupported across the 30 system styles", () => {
    const map = buildAeStyleMap();
    const counts = { supported: 0, approximate: 0, unsupported: 0 };
    for (const entry of map) counts[entry.support] += 1;
    expect(counts).toEqual({ supported: 19, approximate: 6, unsupported: 5 });
  });
});
