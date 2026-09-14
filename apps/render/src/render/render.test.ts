import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap } from "@montaj/caption-styles";
import { createHarfBuzzShaper, watermarkFor } from "@montaj/render-core";
import { RenderManifestSchema, withSignature } from "@montaj/render-manifest";
import type { RenderManifest, UnsignedRenderManifest } from "@montaj/render-manifest";
import { fixtureManifest, signedFixtureManifest } from "@montaj/render-manifest/testing";
import { SkiaNodeBackend } from "@montaj/render-skia-node";
import { buildTimeMap, cutEdit } from "@montaj/timemap";

import { FontPackError, fontFilesIn, loadFonts, readFontPack } from "./fonts.js";
import { createFrameSource, frameTimeMs } from "./frames.js";
import {
  buildRenderTimeMap,
  parseStyleCatalogue,
  ProjectionError,
  toEdgProjection,
} from "./projection.js";
import { watermarkCommandFor, WATERMARK_WIDTH_RATIO } from "./watermark.js";
import { removeQuietly, sampleProjection, sampleStyles } from "../testing.js";

import type { RenderProjection } from "../queues.js";

const SECRET = "render-test-secret";
let scratch: string;

function manifest(overrides: Parameters<typeof fixtureManifest>[0] = {}): RenderManifest {
  return RenderManifestSchema.parse(
    withSignature(fixtureManifest(overrides) as UnsignedRenderManifest, SECRET),
  );
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "a20-render-"));
});

afterAll(async () => {
  await removeQuietly(scratch);
});

describe("the watermark", () => {
  const canvas = { width: 1080, height: 1920 };

  it("is nothing at all when the manifest says so", () => {
    expect(watermarkCommandFor(null, canvas)).toBeNull();
  });

  it("puts a bottom-right mark exactly where render-core puts one", () => {
    // The browser exporter draws `watermarkFor`; if the two disagreed, the same
    // export would be marked differently depending on where it was rendered.
    const cloud = watermarkCommandFor(
      { assetId: "mark", position: "bottom-right", opacity: 0.85 },
      canvas,
    );
    expect(cloud).toEqual(watermarkFor("mark", canvas));
  });

  it("honours the other three corners", () => {
    const topLeft = watermarkCommandFor(
      { assetId: "mark", position: "top-left", opacity: 1 },
      canvas,
    );
    expect(topLeft?.kind).toBe("image");
    if (topLeft?.kind !== "image") return;
    expect(topLeft.dest[0]).toBeCloseTo(canvas.height * 0.03, 5);
    expect(topLeft.dest[1]).toBeCloseTo(canvas.height * 0.03, 5);
    expect(topLeft.opacity).toBe(1);

    const topRight = watermarkCommandFor(
      { assetId: "mark", position: "top-right", opacity: 0.5 },
      canvas,
    );
    if (topRight?.kind !== "image") return;
    expect(topRight.dest[2]).toBeCloseTo(canvas.width - canvas.height * 0.03, 5);
    expect(topRight.dest[1]).toBeCloseTo(canvas.height * 0.03, 5);
  });

  it("scales with the canvas rather than being a fixed number of pixels", () => {
    const small = watermarkCommandFor(
      { assetId: "mark", position: "bottom-right", opacity: 1 },
      { width: 540, height: 960 },
    );
    if (small?.kind !== "image") return;
    expect(small.dest[2] - small.dest[0]).toBeCloseTo(540 * WATERMARK_WIDTH_RATIO, 5);
  });
});

describe("frame timing", () => {
  it("samples the centre of each frame's interval", () => {
    // Sampling the start would put a caption beginning mid-frame one frame late.
    expect(frameTimeMs(0, 30)).toBeCloseTo(16.667, 2);
    expect(frameTimeMs(29, 30)).toBeCloseTo(983.333, 2);
    expect(frameTimeMs(0, 1)).toBe(500);
  });
});

describe("the style catalogue", () => {
  it("parses every system style", () => {
    const styles = sampleStyles();
    const catalogue = parseStyleCatalogue(styles);
    // Not a hard-coded count: the catalogue grows every time a style ships, and
    // a magic number turns "we added a template" into a failing render suite
    // (it had drifted to 30 against 66 actual styles). What matters is that
    // EVERY style parses — a style the render worker cannot read is a style
    // that exports a blank caption track.
    expect(catalogue.size).toBe(Object.keys(styles).length);
    expect(catalogue.size).toBeGreaterThan(0);
    expect(catalogue.get("punch-pop")?.id).toBe("punch-pop");
  });

  it("refuses a document that is not a v2 StyleDoc, naming the id", () => {
    let caught: unknown;
    try {
      parseStyleCatalogue({ broken: { id: "broken" } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProjectionError);
    expect((caught as ProjectionError).code).toBe("render/bad-style");
    expect((caught as ProjectionError).detail["styleId"]).toBe("broken");
  });

  it("refuses a payload with no styles at all", () => {
    expect(() => parseStyleCatalogue({})).toThrow(/no style documents/);
  });
});

describe("the projection adapter", () => {
  let projection: RenderProjection;

  beforeAll(async () => {
    projection = await sampleProjection(10_000);
  });

  it("takes its canvas from the manifest, not from the payload", () => {
    // The payload is not signed; the output size is a plan decision.
    const built = toEdgProjection(
      { ...projection, canvas: { width: 100, height: 100 } },
      manifest(),
    );
    expect(built.canvas).toEqual({ width: 1080, height: 1920 });
  });

  it("never sets a watermark on the projection", () => {
    // `renderFrame` would draw it, which would make the mark a property of the
    // unsigned payload (T10).
    const built = toEdgProjection(projection, manifest());
    expect(built.render?.["watermarkAssetId"]).toBeUndefined();
  });

  it("carries the manifest's document-level style overrides", () => {
    const built = toEdgProjection(
      projection,
      manifest({
        styles: {
          defaultStyleId: "punch-pop",
          catalogueSnapshotIds: [],
          documentOverrides: { typography: { fontSizePct: 7 } },
        },
      }),
    );
    expect(built.styles.inline?.doc).toEqual({ typography: { fontSizePct: 7 } });
  });

  it("keeps the sample project's segments and words", () => {
    const built = toEdgProjection(projection, manifest());
    expect(built.segments.length).toBeGreaterThan(0);
    expect(built.words.length).toBeGreaterThan(0);
    expect(built.speakerColours?.["sp1"]).toBeTruthy();
  });

  it("refuses segments with no words to put in them", () => {
    expect(() => toEdgProjection({ ...projection, words: [] }, manifest())).toThrow(
      ProjectionError,
    );
  });
});

describe("the timemap", () => {
  it("is built even when there are no edits, so one number is the source of truth", () => {
    const map = buildRenderTimeMap(manifest());
    expect(map.outputDurationMs).toBe(10_000);
    expect(map.spans).toHaveLength(1);
  });

  it("applies the manifest's cuts", () => {
    const map = buildRenderTimeMap(
      manifest({
        timemap: {
          sourceDurationMs: 10_000,
          snapCutsToFrames: false,
          edits: [{ kind: "cut", startMs: 2_000, endMs: 4_000 }],
        },
      }),
    );
    expect(map.outputDurationMs).toBe(8_000);
  });

  it("snaps cuts to frames when asked", () => {
    const map = buildRenderTimeMap(
      manifest({
        timemap: {
          sourceDurationMs: 10_000,
          snapCutsToFrames: true,
          fps: 30,
          edits: [{ kind: "cut", startMs: 2_001, endMs: 4_002 }],
        },
      }),
    );
    expect(map.cuts[0]?.startMs).not.toBe(2_001);
  });
});

describe("the font loader", () => {
  it("falls back to the bundled subsets with a warning", async () => {
    const warnings: string[] = [];
    const loaded = await loadFonts({ onWarning: (message) => warnings.push(message) });
    expect(loaded.source).toBe("fixtures");
    expect(loaded.fonts.length).toBeGreaterThan(0);
    expect(warnings.join(" ")).toContain("RENDER_FONT_DIR");
  });

  it("reads a font pack", async () => {
    const dir = join(scratch, "pack");
    const { fonts } = await loadFonts();
    const face = fonts[0];
    expect(face).toBeDefined();
    if (face === undefined) return;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await writeFile(join(await ensureDir(dir), "face.ttf"), face.data);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await writeFile(
      join(dir, "fonts.json"),
      JSON.stringify({
        v: 1,
        fonts: [
          { id: "pack-400", family: "Packed", weight: 400, file: "face.ttf", scripts: ["latin"] },
        ],
      }),
    );
    const loaded = await loadFonts({ directory: dir });
    expect(loaded.source).toBe("pack");
    expect(loaded.fonts).toHaveLength(1);
    expect(loaded.fonts[0]?.family).toBe("Packed");
    expect(await fontFilesIn(dir)).toEqual(["face.ttf"]);
  });

  it("refuses a directory with no manifest", async () => {
    const dir = await ensureDir(join(scratch, "empty-pack"));
    await expect(readFontPack(dir)).rejects.toThrow(FontPackError);
  });

  it("refuses a manifest that is not a v1 pack", async () => {
    const dir = await ensureDir(join(scratch, "bad-pack"));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await writeFile(join(dir, "fonts.json"), JSON.stringify({ v: 2, fonts: [] }));
    await expect(readFontPack(dir)).rejects.toThrow(/not a v1 font pack/);
  });

  it("refuses a file name that could escape the pack directory", async () => {
    const dir = await ensureDir(join(scratch, "escape-pack"));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await writeFile(
      join(dir, "fonts.json"),
      JSON.stringify({
        v: 1,
        fonts: [{ id: "x", family: "X", weight: 400, file: "../secret.ttf" }],
      }),
    );
    await expect(readFontPack(dir)).rejects.toThrow(/bare name/);
  });

  it("refuses woff2, which HarfBuzz cannot read", async () => {
    const dir = await ensureDir(join(scratch, "woff-pack"));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await writeFile(
      join(dir, "fonts.json"),
      JSON.stringify({
        v: 1,
        fonts: [{ id: "x", family: "X", weight: 400, file: "face.woff2" }],
      }),
    );
    await expect(readFontPack(dir)).rejects.toThrow(/\.ttf or \.otf/);
  });

  it("refuses a manifest naming a file that is not there", async () => {
    const dir = await ensureDir(join(scratch, "missing-pack"));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await writeFile(
      join(dir, "fonts.json"),
      JSON.stringify({
        v: 1,
        fonts: [{ id: "x", family: "X", weight: 400, file: "gone.ttf" }],
      }),
    );
    await expect(readFontPack(dir)).rejects.toThrow(/could not be read/);
  });
});

describe("the frame source and its cache", () => {
  it("rasterises a changed frame and reuses an identical one", async () => {
    const { registry } = await loadFonts();
    const shaper = await createHarfBuzzShaper(registry);
    const backend = await SkiaNodeBackend.create({ shaper });
    const built = manifest({
      output: {
        kind: "video",
        preset: "custom",
        aspect: "9:16",
        width: 270,
        height: 480,
        fps: 10,
        container: "mp4",
        videoCodec: "h264",
      },
    });
    const batch = backend.createBatch({ width: 270, height: 480 });
    const projection = await sampleProjection(10_000);

    const source = createFrameSource({
      backend,
      batch,
      projection: toEdgProjection(projection, built),
      timemap: buildTimeMap({ sourceDurationMs: 10_000, edits: [] }),
      catalogue: loadSystemStyleMap(),
      registry,
      shaper,
      fps: 10,
      watermark: null,
    });

    for (let index = 0; index < 100; index += 1) source.frame(index);

    expect(source.stats.requested).toBe(100);
    expect(source.stats.rasterised).toBeGreaterThan(0);
    expect(source.stats.rasterised).toBeLessThan(100);
    expect(source.stats.reused).toBe(100 - source.stats.rasterised);
    expect(source.stats.reuseRatio).toBeCloseTo(source.stats.reused / 100, 6);
    backend.dispose();
  }, 300_000);

  it("reuses every frame of a project with no captions at all", async () => {
    const { registry } = await loadFonts();
    const shaper = await createHarfBuzzShaper(registry);
    const backend = await SkiaNodeBackend.create({ shaper });
    const batch = backend.createBatch({ width: 64, height: 64 });
    const source = createFrameSource({
      backend,
      batch,
      projection: {
        canvas: { width: 64, height: 64 },
        styles: { defaultStyleId: "punch-pop" },
        segments: [],
        words: [],
      },
      timemap: null,
      catalogue: loadSystemStyleMap(),
      registry,
      shaper,
      fps: 10,
      watermark: null,
    });
    for (let index = 0; index < 50; index += 1) source.frame(index);
    // One rasterised frame, forty-nine reuses: the empty frame is drawn once.
    expect(source.stats.rasterised).toBe(1);
    expect(source.stats.reused).toBe(49);
    backend.dispose();
  }, 120_000);

  it("adds the manifest's watermark to every frame", async () => {
    const { registry } = await loadFonts();
    const shaper = await createHarfBuzzShaper(registry);
    const backend = await SkiaNodeBackend.create({ shaper });
    const batch = backend.createBatch({ width: 64, height: 64 });
    const watermark = watermarkCommandFor(
      { assetId: "mark", position: "bottom-right", opacity: 0.9 },
      { width: 64, height: 64 },
    );
    const source = createFrameSource({
      backend,
      batch,
      projection: {
        canvas: { width: 64, height: 64 },
        styles: { defaultStyleId: "punch-pop" },
        segments: [],
        words: [],
      },
      timemap: null,
      catalogue: loadSystemStyleMap(),
      registry,
      shaper,
      fps: 10,
      watermark,
    });
    const commands = source.commandsAt(0);
    expect(commands.at(-1)).toEqual(watermark);
    backend.dispose();
  }, 120_000);

  it("maps output time through the timemap, so a cut moves the captions", async () => {
    const { registry } = await loadFonts();
    const shaper = await createHarfBuzzShaper(registry);
    const backend = await SkiaNodeBackend.create({ shaper });
    const built = signedFixtureManifest(SECRET);
    const projection = await sampleProjection(10_000);
    const batch = backend.createBatch({ width: 270, height: 480 });

    const withCut = createFrameSource({
      backend,
      batch,
      projection: toEdgProjection(projection, RenderManifestSchema.parse(built)),
      timemap: buildTimeMap({ sourceDurationMs: 10_000, edits: [cutEdit(0, 4_000)] }),
      catalogue: loadSystemStyleMap(),
      registry,
      shaper,
      fps: 10,
      watermark: null,
    });
    const withoutCut = createFrameSource({
      backend,
      batch,
      projection: toEdgProjection(projection, RenderManifestSchema.parse(built)),
      timemap: null,
      catalogue: loadSystemStyleMap(),
      registry,
      shaper,
      fps: 10,
      watermark: null,
    });
    // Output instant 100 ms is source 4,100 ms with the cut and 100 ms without,
    // so the two frames must not carry the same caption.
    expect(JSON.stringify(withCut.commandsAt(100))).not.toBe(
      JSON.stringify(withoutCut.commandsAt(100)),
    );
    backend.dispose();
  }, 300_000);
});

async function ensureDir(path: string): Promise<string> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path, { recursive: true });
  return path;
}
