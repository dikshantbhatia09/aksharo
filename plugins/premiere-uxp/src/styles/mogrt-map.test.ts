import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadSystemStyles } from "@montaj/caption-styles";

import { buildMogrtStyleMap, classifyStyle } from "./mogrt-map.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTION_STYLES_DIR = join(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "caption-styles",
  "styles",
);
const styleCount = readdirSync(CAPTION_STYLES_DIR).filter(
  (f) => f.endsWith(".json") && f !== "registry.json",
).length;

// Expected per-style status, worked out by hand from the shared rules
// (classification-rules.ts) plus params.ts's BoxFill/BoxOpacity, and checked
// to match C08b's own generated report style-for-style
// (plugins/resolve/docs/RESOLVE-STYLE-COVERAGE.md, commit 704c92b on
// wp/C08b): 19 supported / 6 approximate / 5 unsupported, same styles in each
// bucket. Kept here as an explicit table so a future rule change that shifts
// any single style is visible in a diff, not just in a changed count.
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

  it("marks karaoke-fill, glow and underline word-highlight styles unsupported", () => {
    const styles = loadSystemStyles();
    for (const style of styles.filter((s) =>
      ["karaoke-fill", "glow", "underline"].includes(s.animation.wordHighlight.type),
    )) {
      expect(classifyStyle(style).support).toBe("unsupported");
    }
  });

  it("marks box word-highlight and perWord styles approximate (never worse), when no other rule fires", () => {
    const styles = loadSystemStyles();
    for (const style of styles.filter(
      (s) => s.animation.wordHighlight.type === "box" && !s.box.enabled,
    )) {
      expect(classifyStyle(style).support).toBe("approximate");
    }
  });

  it("marks a translucent (opacity < 0.5) enabled box unsupported", () => {
    const styles = loadSystemStyles();
    const liquidGlass = styles.find((s) => s.id === "liquid-glass");
    expect(liquidGlass?.box.enabled).toBe(true);
    expect(liquidGlass && liquidGlass.box.opacity < 0.5).toBe(true);
    expect(classifyStyle(liquidGlass!).support).toBe("unsupported");
  });

  it("marks an opaque enabled block/line box supported (BoxFill/BoxOpacity cover it)", () => {
    const styles = loadSystemStyles();
    const arcadePixel = styles.find((s) => s.id === "arcade-pixel");
    expect(arcadePixel?.box.enabled).toBe(true);
    expect(arcadePixel?.box.mode).toBe("block");
    expect(classifyStyle(arcadePixel!).support).toBe("supported");
  });

  it("every mapping carries paramSources, including BoxFill/BoxOpacity", () => {
    const styles = loadSystemStyles();
    for (const style of styles) {
      const mapping = classifyStyle(style);
      expect(mapping.paramSources.BoxFill).toBeTruthy();
      expect(mapping.paramSources.BoxOpacity).toBeTruthy();
      if (mapping.support === "unsupported" || mapping.support === "approximate") {
        expect(mapping.reasons.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("buildMogrtStyleMap", () => {
  const mapping = buildMogrtStyleMap();

  it("covers every shipped style, one entry each", () => {
    expect(mapping).toHaveLength(styleCount);
    expect(new Set(mapping.map((m) => m.styleId)).size).toBe(styleCount);
  });

  it("is deterministic across calls", () => {
    expect(buildMogrtStyleMap()).toEqual(buildMogrtStyleMap());
  });

  it("matches C08b's own counts: 19 supported / 6 approximate / 5 unsupported", () => {
    const counts = { supported: 0, approximate: 0, unsupported: 0 };
    for (const entry of mapping) {
      counts[entry.support]++;
    }
    expect(counts).toEqual({ supported: 19, approximate: 6, unsupported: 5 });
  });
});

describe("consistency with C08b's style_map report (if it has landed on this worktree)", () => {
  const candidatePaths = [
    join(HERE, "..", "..", "..", "resolve", "docs", "RESOLVE-STYLE-COVERAGE.md"),
    join(HERE, "..", "..", "..", "resolve", "aksharo_core_app", "fusion", "style_map.json"),
  ];

  it("the Resolve coverage doc, when present, names the same style ids in the same status this module computes", () => {
    let markdown: string | undefined;
    for (const path of candidatePaths) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
        markdown = readFileSync(path, "utf8");
        break;
      } catch {
        // not present in this worktree yet - try the next candidate
      }
    }
    if (!markdown) {
      // wp/C08b had not merged into main when this test was written. Nothing
      // to compare yet; EXPECTED_STATUS above already encodes the hand-checked
      // agreement with commit 704c92b's report.
      expect(markdown).toBeUndefined();
      return;
    }
    const mine = buildMogrtStyleMap();
    for (const entry of mine) {
      // Row shape: | Name (`id`) | category | Status | reason | font | ... |
      // eslint-disable-next-line security/detect-non-literal-regexp -- RegExp built from a fixed/internal string (test fixture or bounded value, not attacker input) -- reviewed for M06's eslint-plugin-security promotion
      const rowMatch = new RegExp("`" + entry.styleId + "`\\) \\| [^|]+ \\| ([A-Za-z]+) \\|").exec(
        markdown,
      );
      expect(rowMatch, `no row for "${entry.styleId}" in the Resolve coverage doc`).not.toBeNull();
      const theirStatus = rowMatch![1]!.toLowerCase();
      expect(theirStatus, `classification mismatch for "${entry.styleId}"`).toBe(entry.support);
    }
  });
});
