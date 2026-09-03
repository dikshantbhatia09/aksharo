/**
 * The browser loader, driven with a fake `fetch` over the real bundled pack.
 *
 * The Playwright lane (`e2e/font-loader.spec.ts`) proves the same code path in
 * a real browser with a real CanvasKit; this suite proves the branches — the
 * sfnt fallback, a face that 404s, a manifest that will not parse — which a
 * browser test would have to break the server to reach.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { createFontRegistry } from "@montaj/render-core";

import {
  defaultWoff2Decompressor,
  FontLoadError,
  installCssFontFaces,
  loadFontsInBrowser,
  manifestUrlFor,
  type FetchLike,
} from "./browser.js";
import { parseManifest, type FontFace, type FontManifest } from "./manifest.js";
import { bundledPackDirectory, readPackManifest } from "./pack.js";

let manifest: FontManifest;
/** A three-face manifest, so a suite does not fetch forty-eight files. */
let small: FontManifest;

beforeAll(async () => {
  manifest = await readPackManifest();
  small = parseManifest({
    ...manifest,
    fonts: manifest.fonts.filter((face) =>
      ["inter-700", "noto-sans-devanagari-400", "noto-sans-tamil-400"].includes(face.id),
    ),
  });
});

/** Serves the pack off disk under `/fonts/<file>`, and counts what was asked for. */
function packFetch(): FetchLike & { readonly asked: string[] } {
  const asked: string[] = [];
  const fetchImpl = ((url: string) => {
    asked.push(url);
    const name = url.replace(/^\/fonts\//, "");
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      const bytes = readFileSync(join(bundledPackDirectory(), name));
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () =>
          Promise.resolve(
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          ),
        json: () => Promise.resolve(JSON.parse(bytes.toString("utf8")) as unknown),
      });
    } catch {
      return Promise.resolve({
        ok: false,
        status: 404,
        arrayBuffer: () => Promise.reject(new Error("404")),
        json: () => Promise.reject(new Error("404")),
      });
    }
  }) as FetchLike & { asked: string[] };
  Object.defineProperty(fetchImpl, "asked", { value: asked });
  return fetchImpl;
}

const resolveUrl = (face: { file: string; woff2?: string }, format: "woff2" | "sfnt"): string =>
  `/fonts/${format === "woff2" ? (face.woff2 ?? face.file) : face.file}`;

describe("loadFontsInBrowser", () => {
  it("fetches WOFF2, decompresses it and registers a shapeable face", async () => {
    const decompress = await defaultWoff2Decompressor();
    const fetchImpl = packFetch();
    const loaded = await loadFontsInBrowser({
      manifest: small,
      fetch: fetchImpl,
      resolveUrl,
      decompressWoff2: decompress,
    });

    expect(loaded.failed).toEqual([]);
    expect(loaded.counts).toEqual({ woff2: 3, sfnt: 0 });
    expect(fetchImpl.asked.every((url) => url.endsWith(".woff2"))).toBe(true);
    for (const font of loaded.fonts) {
      // Decompressed, so the bytes a registry sees are sfnt again.
      expect(String.fromCharCode(...font.data.subarray(0, 4))).not.toBe("wOF2");
    }
    expect(loaded.registry.list()).toHaveLength(3);
    expect(
      loaded.registry.resolve({ family: "Noto Sans Devanagari", weight: 400, italic: false }),
    ).toBeDefined();
  });

  it("falls back to the sfnt when no decompressor was given", async () => {
    const fetchImpl = packFetch();
    const loaded = await loadFontsInBrowser({ manifest: small, fetch: fetchImpl, resolveUrl });
    expect(loaded.counts).toEqual({ woff2: 0, sfnt: 3 });
    expect(fetchImpl.asked.every((url) => url.endsWith(".ttf"))).toBe(true);
    expect(loaded.failed).toEqual([]);
  });

  it("honours an explicit sfnt preference even with a decompressor", async () => {
    const loaded = await loadFontsInBrowser({
      manifest: small,
      fetch: packFetch(),
      resolveUrl,
      prefer: "sfnt",
      decompressWoff2: await defaultWoff2Decompressor(),
    });
    expect(loaded.counts.sfnt).toBe(3);
  });

  it("loads only the families a project asks for", async () => {
    const loaded = await loadFontsInBrowser({
      manifest: small,
      fetch: packFetch(),
      resolveUrl,
      families: ["noto sans tamil"],
    });
    expect(loaded.fonts.map((font) => font.family)).toEqual(["Noto Sans Tamil"]);
  });

  it("registers into a registry the host already has", async () => {
    const registry = createFontRegistry();
    const loaded = await loadFontsInBrowser({
      manifest: small,
      fetch: packFetch(),
      resolveUrl,
      registry,
    });
    expect(loaded.registry).toBe(registry);
    expect(registry.list()).toHaveLength(3);
  });

  it("fetches the manifest when given a URL", async () => {
    const loaded = await loadFontsInBrowser({
      manifestUrl: "/fonts/fonts.json",
      fetch: packFetch(),
      resolveUrl,
      families: ["Anton"],
    });
    expect(loaded.manifest.fonts.length).toBe(manifest.fonts.length);
    expect(loaded.fonts).toHaveLength(1);
  });

  it("reports a face it cannot fetch instead of failing the load", async () => {
    const warnings: string[] = [];
    const broken = parseManifest({
      ...small,
      fonts: [
        ...small.fonts,
        { ...small.fonts[0], id: "ghost-400", file: "ghost.ttf", woff2: "ghost.woff2" },
      ],
    });
    const loaded = await loadFontsInBrowser({
      manifest: broken,
      fetch: packFetch(),
      resolveUrl,
      onWarning: (message) => warnings.push(message),
    });
    expect(loaded.fonts).toHaveLength(3);
    expect(loaded.failed).toEqual([{ id: "ghost-400", reason: expect.stringContaining("404") }]);
    expect(warnings[0]).toContain("ghost-400");
  });

  it("refuses a manifest URL that answers badly", async () => {
    await expect(
      loadFontsInBrowser({ manifestUrl: "/fonts/missing.json", fetch: packFetch() }),
    ).rejects.toMatchObject({ code: "fonts/manifest_unreachable" });
  });

  it("refuses a manifest URL that throws", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("offline"))) as unknown as FetchLike;
    await expect(
      loadFontsInBrowser({ manifestUrl: "/fonts/fonts.json", fetch: fetchImpl }),
    ).rejects.toThrow(/offline/);
  });

  it("insists on being told where the manifest is", async () => {
    await expect(loadFontsInBrowser({})).rejects.toBeInstanceOf(FontLoadError);
  });

  it("refuses a manifest that is not one", async () => {
    await expect(loadFontsInBrowser({ manifest: { v: 4 } })).rejects.toThrow(/not a v1/);
  });
});

describe("URL resolution", () => {
  it("prefers the signed URLs the API puts on a face", () => {
    const face = {
      ...(manifest.fonts[0] as FontFace),
      url: "https://r2/x.ttf",
      woff2Url: "https://r2/x.woff2",
    };
    expect(manifestUrlFor(face, "woff2")).toBe("https://r2/x.woff2");
    expect(manifestUrlFor(face, "sfnt")).toBe("https://r2/x.ttf");
  });

  it("falls back to the bare file names of a bundled pack", () => {
    const face = manifest.fonts.find((entry) => entry.id === "inter-700");
    expect(manifestUrlFor(face ?? (manifest.fonts[0] as FontFace), "sfnt")).toBe("inter-700.ttf");
    expect(manifestUrlFor(face ?? (manifest.fonts[0] as FontFace), "woff2")).toBe(
      "inter-700.woff2",
    );
  });
});

describe("installCssFontFaces", () => {
  it("does nothing outside a browser", async () => {
    expect(await installCssFontFaces(small)).toEqual([]);
  });

  it("installs one CSS face per manifest entry, preferring the WOFF2", async () => {
    const added: string[] = [];
    const sources: string[] = [];
    const installed = await installCssFontFaces(small, {
      resolveUrl,
      sink: { add: () => added.push("added") },
      createFontFace: (family, source) => {
        sources.push(source);
        return { load: () => Promise.resolve(family) };
      },
    });
    expect(installed).toHaveLength(3);
    expect(added).toHaveLength(3);
    expect(sources.every((source) => source.includes(".woff2"))).toBe(true);
  });

  it("warns and carries on when one face will not load", async () => {
    const warnings: string[] = [];
    const installed = await installCssFontFaces(small, {
      resolveUrl,
      sink: { add: () => undefined },
      createFontFace: (family) => ({
        load: () =>
          family === "Inter" ? Promise.reject(new Error("bad face")) : Promise.resolve(family),
      }),
      onWarning: (message) => warnings.push(message),
    });
    expect(installed).toHaveLength(2);
    expect(warnings[0]).toContain("Inter");
  });

  it("skips a face with no URL at all", async () => {
    const noUrls = parseManifest({
      ...small,
      fonts: small.fonts.map((face) => ({ ...face, woff2: undefined })),
    });
    const installed = await installCssFontFaces(noUrls, {
      resolveUrl: () => undefined,
      sink: { add: () => undefined },
      createFontFace: (family) => ({ load: () => Promise.resolve(family) }),
    });
    expect(installed).toEqual([]);
  });
});

describe("the default decompressor", () => {
  it("loads woff2-encoder and round-trips a real face", async () => {
    const decompress = await defaultWoff2Decompressor();
    const woff2 = new Uint8Array(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      readFileSync(join(bundledPackDirectory(), "noto-sans-tamil-400.woff2")),
    );
    const sfnt = await decompress(woff2);
    expect(sfnt.byteLength).toBeGreaterThan(woff2.byteLength);
    expect(String.fromCharCode(...sfnt.subarray(0, 4))).not.toBe("wOF2");
  });
});
