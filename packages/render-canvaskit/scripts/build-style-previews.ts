/**
 * Renders one still per system style into `packages/caption-styles/previews/`.
 *
 * The picker in the editor animates a style live (it has `render-core` and
 * CanvasKit already), but the catalogue, the marketing page and the plugin
 * panels need a picture they can `<img>`. This script is the one place that
 * makes them, from the same preview definition (`previewFor`) and the same
 * renderer, so the picture and the live tile cannot disagree.
 *
 *   pnpm --filter @montaj/render-canvaskit previews:build
 *
 * A20 replaces the still with an animated WebP once `@napi-rs/canvas` and the
 * encoder land; the file names do not change.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { loadSystemStyles } from "@montaj/caption-styles";
import { animate, layoutSegment, previewFor, previewStillMs } from "@montaj/render-core";
import { createFixtureRenderer, loadFixtureFonts } from "@montaj/render-core/testing";

import { CanvasKitBackend } from "../src/backend.js";

const require = createRequire(__filename);

/** Tile size: the 9:16 master divided by four, which is what the picker shows. */
const PREVIEW_CANVAS = { width: 270, height: 480 } as const;

/** A neutral ground so a light style and a dark style both read. */
const PREVIEW_BACKGROUND = "#242430ff";

async function main(): Promise<void> {
  const previewDir = resolve(
    dirname(require.resolve("@montaj/caption-styles/package.json")),
    "previews",
  );
  mkdirSync(previewDir, { recursive: true });

  const { registry, shaper } = await createFixtureRenderer();
  const backend = await CanvasKitBackend.create({ fonts: loadFixtureFonts() });
  const tMs = previewStillMs();

  try {
    for (const style of loadSystemStyles()) {
      const preview = previewFor(style.id);
      const layout = layoutSegment({
        style,
        segment: preview.segment,
        words: preview.words,
        canvas: PREVIEW_CANVAS,
        registry,
        shaper,
        tMs,
      });
      const png = backend.renderToPng(animate({ layout, style, tMs }), {
        width: PREVIEW_CANVAS.width,
        height: PREVIEW_CANVAS.height,
        background: PREVIEW_BACKGROUND,
      });
      writeFileSync(join(previewDir, `${style.id}.png`), png);
      console.log(`${style.id}.png — ${String(png.length)} bytes`);
    }
    console.log(`wrote style previews to ${previewDir}`);
  } finally {
    backend.dispose();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
