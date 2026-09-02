import { describe, expect, it } from "vitest";

import {
  fontFaceSchema,
  FontManifestError,
  LICENCE_DIR,
  MANIFEST_FILE,
  manifestScriptTags,
  parseManifest,
  summariseFamilies,
} from "./manifest.js";

const face = {
  id: "inter-700",
  family: "Inter",
  weight: 700,
  italic: false,
  file: "inter-700.ttf",
  scripts: ["latin"],
  scriptTags: ["Latn"],
  sizeBytes: 1_234,
  sha256: "a".repeat(64),
};

const manifest = { v: 1, fonts: [face] };

describe("the manifest schema", () => {
  it("accepts a minimal face and defaults italic and origin", () => {
    const parsed = parseManifest(manifest);
    expect(parsed.fonts[0]?.italic).toBe(false);
    expect(parsed.origin).toBe("bundled");
  });

  it("is a superset of the render node's v1 font pack", () => {
    // These six fields, in this shape, are what `apps/render`'s FontPackSchema
    // reads; everything else it strips. A change here is a change to that
    // contract and has to move both sides.
    const parsed = parseManifest(manifest).fonts[0];
    expect(Object.keys(parsed ?? {})).toEqual(
      expect.arrayContaining(["id", "family", "weight", "italic", "file", "scripts"]),
    );
    expect(MANIFEST_FILE).toBe("fonts.json");
    expect(LICENCE_DIR).toBe("licences");
  });

  it("refuses a file name that is a path", () => {
    for (const file of ["../secret.ttf", "nested/inter.ttf", "a\\b.ttf"]) {
      expect(() => parseManifest({ ...manifest, fonts: [{ ...face, file }] })).toThrow(
        FontManifestError,
      );
    }
  });

  it("refuses a checksum that is not a SHA-256", () => {
    expect(() => parseManifest({ ...manifest, fonts: [{ ...face, sha256: "nope" }] })).toThrow(
      FontManifestError,
    );
  });

  it("refuses a version it does not know", () => {
    expect(() => parseManifest({ ...manifest, v: 2 })).toThrow(FontManifestError);
  });

  it("refuses an empty manifest and a non-object", () => {
    expect(() => parseManifest({ v: 1, fonts: [] })).toThrow(FontManifestError);
    expect(() => parseManifest("nope")).toThrow(FontManifestError);
  });

  it("refuses a duplicate face id, which would shadow a face silently", () => {
    expect(() => parseManifest({ v: 1, fonts: [face, { ...face, family: "Other" }] })).toThrow(
      /twice/,
    );
  });

  it("refuses a script that is not a WordScript", () => {
    expect(() =>
      parseManifest({ ...manifest, fonts: [{ ...face, scripts: ["bengali"] }] }),
    ).toThrow(FontManifestError);
  });

  it("refuses an ISO tag outside the catalogue", () => {
    expect(() =>
      parseManifest({ ...manifest, fonts: [{ ...face, scriptTags: ["Hans"] }] }),
    ).toThrow(FontManifestError);
  });

  it("names the source in the message", () => {
    expect(() => parseManifest({ v: 9 }, "workspace fonts")).toThrow(/workspace fonts/);
  });

  it("takes the optional URL fields the API fills in", () => {
    const parsed = fontFaceSchema.parse({
      ...face,
      url: "https://r2.example/ws/x/fonts/y.ttf?sig",
      woff2Url: "https://r2.example/ws/x/fonts/y.woff2?sig",
      woff2: "inter-700.woff2",
      woff2SizeBytes: 400,
    });
    expect(parsed.url).toContain("sig");
    expect(parsed.woff2SizeBytes).toBe(400);
  });
});

describe("summaries", () => {
  const many = {
    v: 1,
    fonts: [
      face,
      { ...face, id: "inter-400", weight: 400 },
      {
        ...face,
        id: "noto-deva-400",
        family: "Noto Sans Devanagari",
        weight: 400,
        file: "d.ttf",
        scripts: ["latin", "devanagari"],
        scriptTags: ["Deva", "Latn"],
        licence: "OFL-1.1",
      },
    ],
  };

  it("groups by family in first-seen order and sorts the weights", () => {
    const families = summariseFamilies(parseManifest(many));
    expect(families.map((f) => f.family)).toEqual(["Inter", "Noto Sans Devanagari"]);
    expect(families[0]?.weights).toEqual([400, 700]);
    expect(families[0]?.totalBytes).toBe(2_468);
    expect(families[1]?.scriptTags).toEqual(["Deva", "Latn"]);
    expect(families[1]?.licence).toBe("OFL-1.1");
  });

  it("collects every script tag any face claims", () => {
    expect(manifestScriptTags(parseManifest(many))).toEqual(new Set(["Latn", "Deva"]));
  });
});
