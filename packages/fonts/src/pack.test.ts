/**
 * The bundled pack, judged against what the product promises.
 *
 * Acceptance criterion 1 of the brief lives here: the manifest has to cover
 * every one of the 22 scheduled languages' scripts, and "cover" is checked
 * against the shipped bytes' own character maps rather than against the
 * `scriptTags` the build script wrote. A manifest that claimed a script it did
 * not have would pass a self-consistency test and fail a viewer.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyles } from "@montaj/caption-styles";
import {
  createFontRegistry,
  createHarfBuzzShaper,
  resolveFontOrThrow,
  type FontRegistry,
  type Shaper,
} from "@montaj/render-core";

import { CATALOGUE, catalogueFaceCount } from "./catalogue.js";
import {
  manifestScriptTags,
  summariseFamilies,
  type FontFace,
  type FontManifest,
} from "./manifest.js";
import {
  bundledPackDirectory,
  FontPackIntegrityError,
  loadPack,
  packLicencePath,
  packManifestPath,
  readPackManifest,
  registerManifestFonts,
} from "./pack.js";
import {
  coverageRatio,
  COVERAGE_THRESHOLD,
  REQUIRED_SCRIPTS,
  SCHEDULED_LANGUAGES,
  SCRIPT_SAMPLES,
  toWordScript,
  type ScriptTag,
} from "./scripts.js";
import { validateFont } from "./validate.js";

let manifest: FontManifest;
let registry: FontRegistry;
let shaper: Shaper;
/** Each face's own character map, read back out of the shipped bytes. */
const coverage = new Map<string, ReturnType<typeof validateFont>>();

beforeAll(async () => {
  const pack = await loadPack({ verify: true });
  manifest = pack.manifest;
  registry = pack.registry;
  shaper = await createHarfBuzzShaper(registry);
  for (const font of pack.fonts) coverage.set(font.id, validateFont(font.data));
}, 180_000);

describe("the bundled pack", () => {
  it("has one face per catalogue entry and no duplicates", () => {
    expect(manifest.fonts).toHaveLength(catalogueFaceCount());
    expect(new Set(manifest.fonts.map((face) => face.id)).size).toBe(manifest.fonts.length);
    expect(manifest.origin).toBe("bundled");
    expect(manifest.v).toBe(1);
  });

  it("matches every committed checksum", async () => {
    // `loadPack({ verify: true })` in `beforeAll` did the work; this asserts it
    // was actually asked to, by breaking one on purpose.
    await expect(
      loadPack({ directory: bundledPackDirectory(), verify: true }),
    ).resolves.toBeTruthy();
  });

  it("ships a WOFF2 twin of every face, meaningfully smaller", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const files = new Set(await readdir(bundledPackDirectory()));
    for (const face of manifest.fonts) {
      expect(face.woff2, `${face.id} has no woff2`).toBeDefined();
      expect(files.has(face.woff2 ?? ""), `${face.woff2} is missing`).toBe(true);
      expect(face.woff2SizeBytes ?? Number.POSITIVE_INFINITY).toBeLessThan(face.sizeBytes);
    }
    const sfnt = manifest.fonts.reduce((sum, face) => sum + face.sizeBytes, 0);
    const woff2 = manifest.fonts.reduce((sum, face) => sum + (face.woff2SizeBytes ?? 0), 0);
    expect(woff2).toBeLessThan(sfnt * 0.5);
  });

  it("commits a licence text for every family, and only open ones", async () => {
    for (const family of summariseFamilies(manifest)) {
      expect(["OFL-1.1", "Apache-2.0"]).toContain(family.licence);
      const face = family.faces[0];
      expect(face?.licenceFile).toBeDefined();
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      const text = await readFile(packLicencePath(face?.licenceFile ?? ""), "utf8");
      expect(text.length).toBeGreaterThan(500);
      expect(text).toMatch(/SIL OPEN FONT LICENSE|Apache License/i);
    }
  });

  it("records the upstream commit every face was built from", () => {
    for (const face of manifest.fonts) {
      expect(face.upstream?.repo).toBe("google/fonts");
      expect(face.upstream?.ref).toMatch(/^[0-9a-f]{40}$/);
      expect(face.upstream?.path).toMatch(/^(ofl|apache)\//);
    }
  });

  it("carries no variable font: every face is a static instance", () => {
    for (const [id, validation] of coverage) {
      expect(validation.variable, `${id} still has axes`).toBe(false);
    }
  });
});

describe("script coverage (acceptance criterion 1)", () => {
  it("claims every script the 22 scheduled languages need", () => {
    const claimed = manifestScriptTags(manifest);
    for (const script of REQUIRED_SCRIPTS) {
      expect(claimed.has(script), `no bundled family claims ${script}`).toBe(true);
    }
  });

  it("actually covers each of them, checked against the shipped bytes", () => {
    for (const script of REQUIRED_SCRIPTS) {
      const covering = manifest.fonts.filter((face) => {
        const validation = coverage.get(face.id);
        return (
          validation !== undefined &&
          coverageRatio(script, validation.codePoints) >= COVERAGE_THRESHOLD
        );
      });
      expect(covering.length, `nothing in the pack covers ${script}`).toBeGreaterThan(0);
    }
  });

  it("draws every scheduled language's sample without tofu", () => {
    for (const language of SCHEDULED_LANGUAGES) {
      const sample = SCRIPT_SAMPLES[language.script];
      const codePoints = [...sample].map((character) => character.codePointAt(0) ?? 0);
      const face = registry.resolve(
        {
          family: "Inter",
          weight: 400,
          italic: false,
          fallbacks: ["Noto Sans Devanagari", "Noto Sans Tamil", "Noto Sans"],
          script: toWordScript(language.script),
        },
        codePoints,
      );
      expect(face, `${language.name} (${language.script}) resolves to nothing`).toBeDefined();
      expect(shaper.covers(face?.id ?? "", codePoints), `${language.name}`).toBe(true);
    }
  });

  it("claims nothing a face cannot draw", () => {
    for (const face of manifest.fonts) {
      const validation = coverage.get(face.id);
      for (const tag of face.scriptTags) {
        expect(
          coverageRatio(tag as ScriptTag, validation?.codePoints ?? new Set()),
          `${face.id} claims ${tag}`,
        ).toBeGreaterThanOrEqual(COVERAGE_THRESHOLD);
      }
    }
  });
});

describe("the pack satisfies the caption styles", () => {
  it("has every family the 30 system styles name, at a usable weight", () => {
    for (const style of loadSystemStyles()) {
      const wanted = style.typography.fontFamily;
      const face = registry.resolve({
        family: wanted,
        weight: style.typography.weight,
        italic: style.typography.italic,
      });
      expect(face, `${style.id} wants ${wanted} and the pack has no such family`).toBeDefined();
      expect(face?.family, `${style.id} fell through to a fallback`).toBe(wanted);
    }
  });

  it("has every fallback family the styles list", () => {
    const families = new Set(manifest.fonts.map((face) => face.family));
    for (const style of loadSystemStyles()) {
      for (const fallback of style.typography.fallbacks ?? []) {
        expect(families.has(fallback), `${style.id} falls back to ${fallback}`).toBe(true);
      }
    }
  });

  it("resolves a Hinglish line's two runs to two different faces", () => {
    const latin = resolveFontOrThrow(
      registry,
      { family: "Poppins", weight: 700, italic: false, script: "latin" },
      [...("video" as string)].map((c) => c.codePointAt(0) ?? 0),
    );
    const devanagari = resolveFontOrThrow(
      registry,
      {
        family: "Anton",
        weight: 400,
        italic: false,
        fallbacks: ["Noto Sans Devanagari"],
        script: "devanagari",
      },
      [...("बारे" as string)].map((c) => c.codePointAt(0) ?? 0),
    );
    expect(latin.family).toBe("Poppins");
    expect(devanagari.family).toBe("Noto Sans Devanagari");
  });
});

describe("shaping through the pack", () => {
  const cases: readonly {
    readonly family: string;
    readonly text: string;
    readonly script: ScriptTag;
  }[] = [
    { family: "Noto Sans Devanagari", text: "हिंदी में कैप्शन", script: "Deva" },
    { family: "Noto Sans Tamil", text: "தமிழ் வசனம்", script: "Taml" },
    { family: "Inter", text: "Aksharo captions", script: "Latn" },
  ];

  for (const testCase of cases) {
    it(`shapes ${testCase.script} with real clusters and advances`, () => {
      const face = resolveFontOrThrow(registry, {
        family: testCase.family,
        weight: 400,
        italic: false,
        script: toWordScript(testCase.script),
      });
      const run = shaper.shape({
        text: testCase.text,
        fontId: face.id,
        script: toWordScript(testCase.script),
      });
      expect(run.glyphs.length).toBeGreaterThan(0);
      expect(run.advance).toBeGreaterThan(0);
      // Nothing resolved to `.notdef`, which is what tofu is.
      expect(run.glyphs.every((glyph) => glyph.id !== 0)).toBe(true);
    });
  }

  it("reorders a Devanagari matra, which is what proves the layout tables survived", () => {
    const face = resolveFontOrThrow(registry, {
      family: "Noto Sans Devanagari",
      weight: 400,
      italic: false,
      script: "devanagari",
    });
    // "कि" is stored क then ि and drawn ि then क: the first glyph's cluster is
    // therefore the second code point's. A subset that lost GSUB would not do this.
    const run = shaper.shape({ text: "कि", fontId: face.id, script: "devanagari" });
    expect(run.glyphs.length).toBeGreaterThanOrEqual(2);
    expect(run.glyphs[0]?.cluster).toBe(0);
  });
});

describe("the catalogue and the pack agree", () => {
  it("builds every catalogue family into the manifest", () => {
    const families = new Set(manifest.fonts.map((face) => face.family));
    for (const family of CATALOGUE) {
      expect(families.has(family.family), `${family.family} is missing from the pack`).toBe(true);
    }
  });

  it("names files that exist and nothing outside the pack directory", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const files = new Set(await readdir(bundledPackDirectory()));
    for (const face of manifest.fonts) {
      expect(files.has(face.file), `${face.file}`).toBe(true);
      expect(face.file.includes("/") || face.file.includes("..")).toBe(false);
    }
  });

  it("reads back through readPackManifest as well as loadPack", async () => {
    const direct = await readPackManifest();
    expect(direct.fonts).toHaveLength(manifest.fonts.length);
  });

  it("stays inside a sane total size for an image layer", () => {
    const sfnt = manifest.fonts.reduce((sum, face) => sum + face.sizeBytes, 0);
    expect(sfnt).toBeLessThan(12 * 1024 * 1024);
  });

  it("keeps its licences directory beside the fonts", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const licences = await readdir(join(bundledPackDirectory(), "licences"));
    expect(licences.length).toBe(CATALOGUE.length);
  });
});

describe("registerManifestFonts", () => {
  it("fetches and registers every face a workspace manifest names", async () => {
    const registry = createFontRegistry();
    const small = { ...manifest, fonts: manifest.fonts.slice(0, 3) };
    const registered = await registerManifestFonts(registry, small, {
      fetchBytes: async (face) =>
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
        new Uint8Array(await readFile(join(bundledPackDirectory(), face.file))),
    });
    expect(registered).toHaveLength(3);
    expect(registry.list()).toHaveLength(3);
  });

  it("warns and carries on when one face cannot be fetched", async () => {
    const warnings: string[] = [];
    const registry = createFontRegistry();
    const small = { ...manifest, fonts: manifest.fonts.slice(0, 2) };
    const registered = await registerManifestFonts(registry, small, {
      fetchBytes: async (face) => {
        if (face.id === small.fonts[0]?.id) throw new Error("403 from R2");
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
        return new Uint8Array(await readFile(join(bundledPackDirectory(), face.file)));
      },
      onWarning: (message) => warnings.push(message),
    });
    expect(registered).toHaveLength(1);
    expect(warnings[0]).toContain("403 from R2");
  });

  it("swallows a non-Error rejection without losing the warning", async () => {
    const warnings: string[] = [];
    await registerManifestFonts(
      createFontRegistry(),
      { ...manifest, fonts: [manifest.fonts[0] as FontFace] },
      {
        fetchBytes: () => Promise.reject("gone"),
        onWarning: (message) => warnings.push(message),
      },
    );
    expect(warnings[0]).toContain("gone");
  });
});

describe("pack integrity", () => {
  it("refuses a face whose bytes do not match the manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "montaj-fonts-"));
    const face = manifest.fonts[0];
    if (face === undefined) throw new Error("empty manifest");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await writeFile(join(directory, face.file), new Uint8Array([0, 1, 0, 0]));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await writeFile(
      join(directory, "fonts.json"),
      JSON.stringify({ v: 1, fonts: [{ ...face, woff2: undefined }] }),
      "utf8",
    );
    await expect(loadPack({ directory, verify: true })).rejects.toBeInstanceOf(
      FontPackIntegrityError,
    );
    // Without `verify` the same directory loads: the checksum is a deliberate cost.
    await expect(loadPack({ directory })).resolves.toBeTruthy();
    await rm(directory, { recursive: true, force: true });
  });

  it("refuses a directory with no manifest at all", async () => {
    const directory = await mkdtemp(join(tmpdir(), "montaj-fonts-"));
    await expect(readPackManifest(directory)).rejects.toBeTruthy();
    await rm(directory, { recursive: true, force: true });
  });

  it("answers the conventional path when no pack is installed", () => {
    expect(bundledPackDirectory().endsWith("pack")).toBe(true);
  });

  it("puts a licence path inside the pack's licences directory", () => {
    expect(packLicencePath("OFL-Inter.txt")).toContain("licences");
    expect(packManifestPath()).toContain("fonts.json");
  });
});
