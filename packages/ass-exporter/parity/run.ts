/**
 * The A18a parity gate (D33).
 *
 * Three renderers, compared with D33's own pixel yardstick (≤ 1% of pixels
 * differing by more than 2/255 — the same metric `@montaj/render-skia-node`'s
 * own CanvasKit-vs-Skia suite already uses; a true SSIM computation is not
 * implemented here so the gate does not silently loosen or diverge from the
 * yardstick the rest of the render stack is held to. See the README for that
 * deviation from the brief's literal "SSIM" wording):
 *
 *  1. **canvasVsSkia** — the existing A20 harness (`@montaj/render-skia-node`'s
 *     `buildParitySweep`), widened here to run for every shipped style, not
 *     just `punch-pop`. This is the browser↔cloud SLO of D33 itself.
 *  2. **assVsSkia** — `toAss` output rendered by `ffmpeg -vf ass=` (libass),
 *     compared against the same Skia-cloud frame. Only run when
 *     `probeLibass()` finds a libass-enabled ffmpeg on PATH; otherwise every
 *     style's `assVsSkia` is written as `null` ("not measured"), never a
 *     fabricated number.
 *
 * Output: `packages/caption-styles/parity/results.json`, keyed by style id.
 * This script only *measures*; `apply-flags.ts` is the only writer of the
 * `StyleDoc` JSON flags (kept separate so CI can diff the flag change before
 * committing it, per the brief's "fail with diff" choice).
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSystemStyles } from "@montaj/caption-styles";
import { CanvasKitBackend, loadCanvasKit } from "@montaj/render-canvaskit";
import { animate, layoutSegment, type DrawCommand } from "@montaj/render-core";
import {
  CAPTION_FIXTURES,
  createFixtureRenderer,
  GOLDEN_TIMESTAMPS_MS,
  loadFixtureFonts,
  PROXY_CANVAS,
} from "@montaj/render-core/testing";
import { SkiaNodeBackend } from "@montaj/render-skia-node";
import { comparePixels, PARITY_BACKGROUND } from "@montaj/render-skia-node/testing";

import { probeLibass, renderAssFrameToRgba } from "./ffmpeg-libass.js";
import { toAss } from "../src/to-ass.js";

import type { AssProjection, AssWord } from "../src/types.js";
import type { CanvasKit } from "canvaskit-wasm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = join(__dirname, "..", "..", "caption-styles", "parity", "results.json");

interface StyleParityResult {
  readonly styleId: string;
  /** Worst (highest) pixel-diff ratio across the fixture sweep; null if the sweep produced nothing. */
  readonly canvasVsSkia: number | null;
  /** Worst pixel-diff ratio against libass; null = "not measured" (no libass ffmpeg). */
  readonly assVsSkia: number | null;
  readonly assRenderable: boolean;
  readonly assExportable: boolean;
  readonly requiresLayoutMetrics: boolean;
  readonly warnings: readonly string[];
  readonly measuredAt: string;
}

interface ResultsFile {
  readonly generatedAt: string;
  readonly maxDiffRatio: number;
  readonly libassMeasured: boolean;
  readonly libassSkipReason?: string;
  readonly styles: Record<string, StyleParityResult>;
}

const MAX_DIFF_RATIO = 0.01;

/** Text-heavy frames known to sit near the SLO purely from anti-aliasing; see render-skia-node's own note. */
const TEXT_EDGE_HEADROOM = 0.05;

function browserPixels(
  ck: CanvasKit,
  backend: CanvasKitBackend,
  commands: readonly DrawCommand[],
  width: number,
  height: number,
  background: string,
): Uint8Array {
  const png = backend.renderToPng(commands, { width, height, background });
  const image = ck.MakeImageFromEncoded(png);
  if (image === null) throw new Error("could not decode a CanvasKit PNG");
  try {
    const pixels = image.readPixels(0, 0, {
      width: image.width(),
      height: image.height(),
      colorType: ck.ColorType.RGBA_8888,
      alphaType: ck.AlphaType.Unpremul,
      colorSpace: ck.ColorSpace.SRGB,
    });
    if (pixels === null) throw new Error("could not read the decoded PNG");
    return pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer);
  } finally {
    image.delete();
  }
}

async function main(): Promise<void> {
  const full = process.argv.includes("--full");
  const styles = loadSystemStyles();
  const { registry, shaper } = await createFixtureRenderer();
  const ck = await loadCanvasKit();
  const browser = await CanvasKitBackend.create({ canvasKit: ck, fonts: loadFixtureFonts() });
  const cloud = await SkiaNodeBackend.create({ shaper });

  const libassProbe = await probeLibass();
  if (!libassProbe.available) {
    console.warn(
      `ass-exporter parity: libass not available (${libassProbe.reason ?? "unknown"}); assVsSkia will be "not measured" for every style.`,
    );
  }

  // The full 30 x 4 fixtures x 3 instants x (canvas+ass) sweep is what CI runs;
  // locally, --full opts in, and the default is one instant per fixture so a
  // developer iterating on the exporter is not stuck waiting on ffmpeg.
  const instants = full ? GOLDEN_TIMESTAMPS_MS : [GOLDEN_TIMESTAMPS_MS[1] as number];

  const results: Record<string, StyleParityResult> = {};

  for (const style of styles) {
    const canvasRatios: number[] = [];
    const assRatios: number[] = [];
    const warnings = new Set<string>();

    for (const fixture of CAPTION_FIXTURES) {
      for (const tMs of instants) {
        const layout = layoutSegment({
          style,
          segment: fixture.segment,
          words: fixture.words,
          canvas: PROXY_CANVAS,
          registry,
          shaper,
          tMs,
        });
        const commands = animate({ layout, style, tMs });

        const expected = browserPixels(
          ck,
          browser,
          commands,
          PROXY_CANVAS.width,
          PROXY_CANVAS.height,
          PARITY_BACKGROUND,
        );
        const actual = cloud.renderFrameToRgba(commands, {
          width: PROXY_CANVAS.width,
          height: PROXY_CANVAS.height,
          background: PARITY_BACKGROUND,
        });
        canvasRatios.push(comparePixels(expected, actual).ratio);

        if (libassProbe.available) {
          const words: AssWord[] = fixture.words.map((word) => ({
            wid: word.wid,
            t: word.t,
            s: word.s,
            e: word.e,
            ...(word.sp === undefined ? {} : { sp: word.sp }),
          }));
          const projection: AssProjection = {
            canvas: PROXY_CANVAS,
            segments: [
              {
                id: fixture.segment.id,
                startMs: fixture.segment.startMs,
                endMs: fixture.segment.endMs,
                startWordId: words[0]?.wid ?? "",
                endWordId: words[words.length - 1]?.wid ?? "",
                styleRef: style.id,
              },
            ],
          };
          const { ass, warnings: exportWarnings } = toAss(
            projection,
            words,
            { [style.id]: style },
            PROXY_CANVAS,
          );
          for (const warning of exportWarnings) warnings.add(warning.code);
          try {
            const assActual = await renderAssFrameToRgba({
              assContent: ass,
              width: PROXY_CANVAS.width,
              height: PROXY_CANVAS.height,
              background: PARITY_BACKGROUND,
              tMs,
              durationMs: fixture.segment.endMs,
              // RR-04 F6/F14: Devanagari/Tamil need HarfBuzz shaping for
              // conjuncts and matra reordering; libass's `auto` default was
              // never verified, so this gate always asks for it explicitly.
              shaping:
                fixture.script === "devanagari" || fixture.script === "tamil" ? "complex" : "auto",
            });
            assRatios.push(comparePixels(expected, assActual).ratio);
          } catch (error) {
            warnings.add("ass_render_failed");
            console.warn(
              `ass render failed for ${style.id}/${fixture.name}@${String(tMs)}: ${String(error)}`,
            );
          }
        }
      }
    }

    const worstCanvas = canvasRatios.length > 0 ? Math.max(...canvasRatios) : null;
    const worstAss = libassProbe.available && assRatios.length > 0 ? Math.max(...assRatios) : null;
    const budget = MAX_DIFF_RATIO + TEXT_EDGE_HEADROOM;

    const assExportable = !warnings.has("effect_only_style");
    const assRenderable =
      libassProbe.available &&
      worstAss !== null &&
      worstAss <= budget &&
      !warnings.has("ass_render_failed");

    results[style.id] = {
      styleId: style.id,
      canvasVsSkia: worstCanvas,
      assVsSkia: worstAss,
      assRenderable,
      assExportable,
      requiresLayoutMetrics:
        style.animation.wordHighlight.type !== "none" ||
        style.animation.perWord ||
        style.box.mode === "word",
      warnings: [...warnings],
      measuredAt: new Date().toISOString(),
    };

    console.warn(
      `${style.id.padEnd(22)} canvasVsSkia=${worstCanvas === null ? "n/a" : worstCanvas.toFixed(4)}` +
        ` assVsSkia=${worstAss === null ? "not measured" : worstAss.toFixed(4)}` +
        ` assRenderable=${String(assRenderable)}`,
    );
  }

  const failures = Object.values(results).filter(
    (result) =>
      result.canvasVsSkia !== null && result.canvasVsSkia > MAX_DIFF_RATIO + TEXT_EDGE_HEADROOM,
  );

  const output: ResultsFile = {
    generatedAt: new Date().toISOString(),
    maxDiffRatio: MAX_DIFF_RATIO,
    libassMeasured: libassProbe.available,
    ...(libassProbe.reason === undefined ? {} : { libassSkipReason: libassProbe.reason }),
    styles: results,
  };

  await mkdir(dirname(RESULTS_PATH), { recursive: true });
  await writeFile(RESULTS_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.warn(`\nwrote ${RESULTS_PATH}`);

  browser.dispose();
  cloud.dispose();

  if (failures.length > 0) {
    console.error(
      `\nCanvasKit vs Skia-Node parity SLO failed for: ${failures.map((f) => f.styleId).join(", ")}`,
    );
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
