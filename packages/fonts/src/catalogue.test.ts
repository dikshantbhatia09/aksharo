import { describe, expect, it } from "vitest";

import {
  CATALOGUE,
  CATALOGUE_UPSTREAM_REF,
  CATALOGUE_UPSTREAM_REPO,
  catalogueFaceCount,
  catalogueSources,
  faceFileName,
  faceId,
  sourceFileFor,
  upstreamPath,
  upstreamUrl,
  type CatalogueFamily,
} from "./catalogue.js";
import { BUNDLED_LICENCES } from "./manifest.js";
import { isScriptTag, REQUIRED_SCRIPTS } from "./scripts.js";

describe("the catalogue", () => {
  it("pins one upstream commit for every file", () => {
    expect(CATALOGUE_UPSTREAM_REPO).toBe("google/fonts");
    expect(CATALOGUE_UPSTREAM_REF).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is open licence only", () => {
    for (const family of CATALOGUE) {
      expect(BUNDLED_LICENCES).toContain(family.licence);
      expect(family.licenceFile).toMatch(/\.txt$/);
      expect(family.upstreamLicenceFile).toBeTruthy();
    }
  });

  it("names a distinct family and licence file per entry", () => {
    expect(new Set(CATALOGUE.map((f) => f.family)).size).toBe(CATALOGUE.length);
    expect(new Set(CATALOGUE.map((f) => f.licenceFile)).size).toBe(CATALOGUE.length);
  });

  it("declares only scripts the catalogue knows", () => {
    for (const family of CATALOGUE) {
      expect(family.scripts.length).toBeGreaterThan(0);
      for (const script of family.scripts) expect(isScriptTag(script)).toBe(true);
    }
  });

  it("covers every required script with at least one family", () => {
    const declared = new Set(CATALOGUE.flatMap((family) => family.scripts));
    for (const script of REQUIRED_SCRIPTS) {
      expect(declared.has(script), `no family declares ${script}`).toBe(true);
    }
  });

  it("gives every face a source: a static file or a variable master", () => {
    for (const family of CATALOGUE) {
      expect(family.faces.length).toBeGreaterThan(0);
      for (const face of family.faces) {
        expect(sourceFileFor(family, face)).toBeTruthy();
        expect(face.weight).toBeGreaterThanOrEqual(100);
        expect(face.weight).toBeLessThanOrEqual(900);
      }
      expect(new Set(family.faces.map((face) => face.weight)).size).toBe(family.faces.length);
    }
  });

  it("pins every axis of a variable master, so nothing ships variable", () => {
    for (const family of CATALOGUE) {
      if (family.variableFile === undefined) continue;
      const axes = /\[([^\]]+)\]/.exec(family.variableFile)?.[1]?.split(",") ?? [];
      for (const face of family.faces) {
        if (face.file !== undefined) continue;
        for (const axis of axes) {
          expect(
            // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
            face.axes?.[axis],
            `${family.family} ${String(face.weight)} leaves ${axis} unpinned`,
          ).toBeDefined();
        }
      }
    }
  });

  it("refuses a family that names neither a file nor a master", () => {
    expect(() =>
      sourceFileFor(
        { ...(CATALOGUE[0] as (typeof CATALOGUE)[number]), variableFile: undefined },
        { weight: 400 },
      ),
    ).toThrow(/neither/);
  });

  it("de-duplicates the upstream files a build has to fetch", () => {
    const sources = catalogueSources();
    expect(sources.length).toBeLessThan(catalogueFaceCount());
    expect(new Set(sources.map((s) => `${s.family.directory}/${s.file}`)).size).toBe(
      sources.length,
    );
  });

  it("counts the faces the pack should hold", () => {
    expect(catalogueFaceCount()).toBe(
      CATALOGUE.reduce((total, family) => total + family.faces.length, 0),
    );
  });
});

describe("naming", () => {
  it("slugs a family into a stable face id", () => {
    expect(faceId("Noto Sans Devanagari", 700)).toBe("noto-sans-devanagari-700");
    expect(faceId("Playfair Display", 500)).toBe("playfair-display-500");
    expect(faceId("Inter", 900, true)).toBe("inter-900-italic");
  });

  it("gives every catalogue face a unique id", () => {
    const ids = CATALOGUE.flatMap((family) =>
      family.faces.map((face) => faceId(family.family, face.weight, face.italic ?? false)),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names the two files a face ships as", () => {
    expect(faceFileName("Roboto Mono", 500, false, "ttf")).toBe("roboto-mono-500.ttf");
    expect(faceFileName("Roboto Mono", 500, false, "woff2")).toBe("roboto-mono-500.woff2");
  });
});

describe("upstream addressing", () => {
  const family = CATALOGUE.find((entry) => entry.family === "Noto Sans Devanagari");

  it("builds a raw URL at the pinned commit with the brackets escaped", () => {
    const url = upstreamUrl(
      family ?? (CATALOGUE[0] as CatalogueFamily),
      "NotoSansDevanagari[wdth,wght].ttf",
    );
    expect(url).toContain(CATALOGUE_UPSTREAM_REF);
    expect(url).toContain("%5Bwdth%2Cwght%5D");
    expect(url.startsWith("https://raw.githubusercontent.com/google/fonts/")).toBe(true);
  });

  it("records the unescaped path in the manifest's provenance", () => {
    expect(upstreamPath(family ?? (CATALOGUE[0] as CatalogueFamily), "x.ttf")).toBe(
      "ofl/notosansdevanagari/x.ttf",
    );
  });
});
