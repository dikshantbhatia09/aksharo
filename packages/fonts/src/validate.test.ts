import { describe, expect, it } from "vitest";

import {
  collectionBytes,
  fakeTtfBytes,
  notAFontBytes,
  oversizeBytes,
  packFontBytes,
  sampleDevanagariFont,
  sampleLatinFont,
  sampleTamilFont,
  withBitmapOnlyEmbedding,
  withNoEmbedding,
  withNoSubsetting,
  withUnitsPerEm,
  withViewOnlyEmbedding,
} from "./testing.js";
import {
  detectContainer,
  embeddingVerdict,
  FontValidationError,
  isCollection,
  MAX_FONT_BYTES,
  mayBeSubset,
  normaliseWeight,
  validateFont,
} from "./validate.js";

/** The code of a refusal, or `"accepted"`. */
function refusalOf(bytes: Uint8Array, options?: Parameters<typeof validateFont>[1]): string {
  try {
    validateFont(bytes, options);
    return "accepted";
  } catch (error) {
    if (error instanceof FontValidationError) return error.code;
    throw error;
  }
}

describe("container sniffing", () => {
  it("recognises the four containers we accept", () => {
    expect(detectContainer(sampleLatinFont())).toBe("ttf");
    expect(detectContainer(packFontBytes("noto-sans-400", "woff2"))).toBe("woff2");
    expect(detectContainer(new TextEncoder().encode("OTTO...."))).toBe("otf");
    expect(detectContainer(new TextEncoder().encode("wOFF...."))).toBe("woff");
  });

  it("refuses to guess at anything else", () => {
    expect(detectContainer(notAFontBytes())).toBeUndefined();
    expect(detectContainer(new Uint8Array([1, 2]))).toBeUndefined();
    expect(detectContainer(collectionBytes())).toBeUndefined();
  });

  it("names a collection as such", () => {
    expect(isCollection(collectionBytes())).toBe(true);
    expect(isCollection(sampleLatinFont())).toBe(false);
  });
});

describe("validateFont refuses", () => {
  it("an empty upload", () => {
    expect(refusalOf(new Uint8Array())).toBe("fonts/empty");
  });

  it("a font over the size cap", () => {
    expect(refusalOf(oversizeBytes(MAX_FONT_BYTES + 1))).toBe("fonts/too_large");
    expect(refusalOf(sampleLatinFont(), { maxBytes: 1_024 })).toBe("fonts/too_large");
  });

  it("a file that is not a font at all", () => {
    expect(refusalOf(notAFontBytes())).toBe("fonts/unknown_format");
  });

  it("a fake TTF with a valid signature and a broken table directory", () => {
    expect(refusalOf(fakeTtfBytes())).toBe("fonts/unparsable");
  });

  it("a TrueType collection", () => {
    expect(refusalOf(collectionBytes())).toBe("fonts/collection_unsupported");
  });

  it("a font whose fsType forbids embedding", () => {
    expect(refusalOf(withNoEmbedding(sampleLatinFont()))).toBe("fonts/embedding_restricted");
  });

  it("a font licensed for preview and print only", () => {
    expect(refusalOf(withViewOnlyEmbedding(sampleLatinFont()))).toBe("fonts/embedding_restricted");
  });

  it("a font that allows bitmap embedding only", () => {
    expect(refusalOf(withBitmapOnlyEmbedding(sampleLatinFont()))).toBe(
      "fonts/embedding_restricted",
    );
  });

  it("a font with impossible metrics", () => {
    expect(refusalOf(withUnitsPerEm(sampleLatinFont(), 1))).toBe("fonts/bad_metrics");
  });

  it("a claim of a script the font does not cover", () => {
    expect(refusalOf(sampleLatinFont(), { claimedScripts: ["Taml"] })).toBe(
      "fonts/script_not_covered",
    );
    expect(refusalOf(sampleDevanagariFont(), { claimedScripts: ["Beng"] })).toBe(
      "fonts/script_not_covered",
    );
  });

  it("a claim of a script that is not in the catalogue at all", () => {
    expect(refusalOf(sampleLatinFont(), { claimedScripts: ["Hans"] })).toBe(
      "fonts/script_not_covered",
    );
  });

  it("and says how far short the claim fell", () => {
    try {
      validateFont(sampleLatinFont(), { claimedScripts: ["Deva"] });
      expect.unreachable("a Latin font must not pass a Devanagari claim");
    } catch (error) {
      expect(error).toBeInstanceOf(FontValidationError);
      const details = (error as FontValidationError).details ?? {};
      expect(details["claimed"]).toBe("Deva");
      expect(Number(details["coverage"])).toBeLessThan(0.9);
    }
  });
});

describe("validateFont accepts", () => {
  it("a real Latin face and reports what it is", () => {
    const result = validateFont(sampleLatinFont());
    expect(result.family).toBe("Noto Sans");
    expect(result.weight).toBe(400);
    expect(result.italic).toBe(false);
    expect(result.format).toBe("ttf");
    expect(result.unitsPerEm).toBeGreaterThan(0);
    expect(result.numGlyphs).toBeGreaterThan(50);
    expect(result.scripts).toContain("Latn");
    expect(result.variable).toBe(false);
    expect(result.variationAxes).toEqual([]);
  });

  it("a Devanagari face claiming Devanagari and Latin", () => {
    const result = validateFont(sampleDevanagariFont(), { claimedScripts: ["Deva", "Latn"] });
    expect(result.scripts).toContain("Deva");
    expect(result.coverage["Deva"]).toBeGreaterThanOrEqual(0.9);
  });

  it("a Tamil face, and does not let it claim Telugu", () => {
    expect(validateFont(sampleTamilFont()).scripts).toContain("Taml");
    expect(refusalOf(sampleTamilFont(), { claimedScripts: ["Telu"] })).toBe(
      "fonts/script_not_covered",
    );
  });

  it("a font that may be embedded but not subset", () => {
    const bytes = withNoSubsetting(sampleLatinFont());
    expect(refusalOf(bytes)).toBe("accepted");
    expect(mayBeSubset(bytes)).toBe(false);
    expect(mayBeSubset(sampleLatinFont())).toBe(true);
    expect(mayBeSubset(fakeTtfBytes())).toBe(false);
  });

  it("a WOFF2, because the container is not what makes a font usable", () => {
    const result = validateFont(packFontBytes("noto-sans-tamil-400", "woff2"));
    expect(result.format).toBe("woff2");
    expect(result.scripts).toContain("Taml");
  });
});

describe("the embedding verdict", () => {
  it("permits a font with no OS/2 opinion", () => {
    expect(embeddingVerdict(undefined)).toEqual({ allowed: true, mayBeSubset: true });
  });

  it("permits installable and editable embedding", () => {
    expect(embeddingVerdict({ editable: true }).allowed).toBe(true);
    expect(embeddingVerdict({}).allowed).toBe(true);
  });

  it("refuses the three restrictive bits and says which", () => {
    expect(embeddingVerdict({ noEmbedding: true }).reason).toMatch(/forbids embedding/);
    expect(embeddingVerdict({ bitmapOnly: true }).reason).toMatch(/bitmap/);
    expect(embeddingVerdict({ viewOnly: true }).reason).toMatch(/preview and print/);
  });

  it("treats no-subsetting as a shipping instruction, not a refusal", () => {
    expect(embeddingVerdict({ noSubsetting: true })).toEqual({
      allowed: true,
      mayBeSubset: false,
    });
  });
});

describe("weight normalisation", () => {
  it("passes CSS weights through", () => {
    expect(normaliseWeight(400)).toBe(400);
    expect(normaliseWeight(700)).toBe(700);
  });

  it("scales the old 1-9 scale", () => {
    expect(normaliseWeight(4)).toBe(400);
    expect(normaliseWeight(9)).toBe(900);
  });

  it("clamps and defaults the nonsense", () => {
    expect(normaliseWeight(undefined)).toBe(400);
    expect(normaliseWeight(Number.NaN)).toBe(400);
    expect(normaliseWeight(50)).toBe(100);
    expect(normaliseWeight(1_200)).toBe(900);
    expect(normaliseWeight(650)).toBe(700);
  });
});
