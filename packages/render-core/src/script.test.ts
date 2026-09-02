import { describe, expect, it } from "vitest";

import {
  charCount,
  detectWordScript,
  dominantScript,
  isComplexScript,
  limitsFor,
  openTypeScriptTag,
  SCRIPT_LIMITS,
} from "./script.js";
import { capabilitiesOf, gradientOf, stylesWithCapabilities } from "./styles/capabilities.js";
import {
  PREVIEW_DURATION_MS,
  PREVIEW_SCRIPTS,
  previewFor,
  previewStillMs,
} from "./styles/preview.js";

describe("script rules re-exported from the segmenter", () => {
  it("keeps the frozen per-script line budgets", () => {
    expect(SCRIPT_LIMITS.latin.maxCharsPerLine).toBe(32);
    expect(SCRIPT_LIMITS.devanagari.maxCharsPerLine).toBe(24);
    expect(SCRIPT_LIMITS.tamil.maxCharsPerLine).toBe(22);
    expect(limitsFor("other").maxCharsPerLine).toBe(26);
  });

  it("counts base code points and excludes combining marks", () => {
    expect(charCount("editing")).toBe(7);
    // ब + ा + र + े is four code points but two base characters.
    expect(charCount("बारे")).toBe(2);
    // இ + ன + ் + ற + ு is five code points but three base characters.
    expect(charCount("இன்று")).toBe(3);
  });

  it("detects the script of a word and of a caption", () => {
    expect(detectWordScript("video")).toBe("latin");
    expect(detectWordScript("बारे")).toBe("devanagari");
    expect(detectWordScript("இன்று")).toBe("tamil");
    expect(detectWordScript("123")).toBeUndefined();
    expect(dominantScript(["video", "editing", "बारे"])).toBe("latin");
    expect(dominantScript([])).toBe("latin");
  });
});

describe("OpenType script tags", () => {
  it("maps each script the renderer knows", () => {
    expect(openTypeScriptTag("latin")).toBe("Latn");
    expect(openTypeScriptTag("devanagari")).toBe("Deva");
    expect(openTypeScriptTag("tamil")).toBe("Taml");
    expect(openTypeScriptTag("other")).toBe("Zyyy");
  });

  it("knows which scripts need cluster-aware treatment", () => {
    expect(isComplexScript("devanagari")).toBe(true);
    expect(isComplexScript("tamil")).toBe(true);
    expect(isComplexScript("other")).toBe(true);
    expect(isComplexScript("latin")).toBe(false);
  });
});

describe("style capabilities", () => {
  it("says a plain style needs nothing extra", () => {
    expect(capabilitiesOf("vertical-clean")).toEqual({
      backdrop: false,
      gradient: false,
      raster: false,
    });
    expect(gradientOf("vertical-clean")).toBeUndefined();
  });

  it("names the styles that sample the backdrop, gradient or raster", () => {
    expect(capabilitiesOf("liquid-glass").backdrop).toBe(true);
    expect(capabilitiesOf("prism-split").gradient).toBe(true);
    expect(capabilitiesOf("glitch-shift").raster).toBe(true);
    expect(capabilitiesOf("tape-retro").raster).toBe(true);
  });

  it("carries the gradient a style paints with", () => {
    expect(gradientOf("prism-split")?.target).toBe("text");
    expect(gradientOf("gradient-sweep")?.target).toBe("box");
    expect(gradientOf("prism-split")?.stops.length).toBeGreaterThan(1);
  });

  it("lists every style with a note, in id order, for the parity report", () => {
    const listed = stylesWithCapabilities();
    expect(listed.map((entry) => entry.id)).toEqual([...listed.map((entry) => entry.id)].sort());
    expect(listed.every((entry) => entry.note !== undefined)).toBe(true);
    expect(listed).toHaveLength(5);
  });
});

describe("style previews", () => {
  it("runs for exactly three seconds and splits the words evenly", () => {
    const preview = previewFor("punch-pop");
    expect(preview.segment.endMs - preview.segment.startMs).toBe(PREVIEW_DURATION_MS);
    expect(preview.words[0]?.s).toBe(0);
    expect(preview.words[preview.words.length - 1]?.e).toBe(PREVIEW_DURATION_MS);
    expect(
      preview.words.every((word, index) => index === 0 || word.s === preview.words[index - 1]?.e),
    ).toBe(true);
  });

  it("previews an Indic style in its own script", () => {
    expect(previewFor("punch-pop", "devanagari").words[0]?.t).toMatch(/\p{Script=Devanagari}/u);
    expect(previewFor("punch-pop", "tamil").words[0]?.t).toMatch(/\p{Script=Tamil}/u);
    expect(previewFor("punch-pop", "other").script).toBe("other");
  });

  it("names the instants a still may be captured at", () => {
    const preview = previewFor("punch-pop");
    expect(preview.keyMs).toHaveLength(3);
    expect(preview.keyMs.every((tMs) => tMs > 0 && tMs < PREVIEW_DURATION_MS)).toBe(true);
    expect(previewStillMs()).toBe(1500);
    expect(PREVIEW_SCRIPTS).toEqual(["latin", "devanagari", "tamil"]);
  });

  it("names the segment after the style so two previews never collide", () => {
    expect(previewFor("neon-glow").segment.id).toBe("preview:neon-glow");
  });
});
