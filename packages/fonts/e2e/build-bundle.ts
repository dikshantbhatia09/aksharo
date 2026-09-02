/**
 * Playwright's global setup: lay a frame out in Node, then bundle the page.
 *
 * The commands come from the **real** layout engine driven by the **real**
 * bundled pack, which is what makes the browser half meaningful: every
 * `GlyphRun.fontId` in the file is a face id out of `fonts.json`, so a face the
 * loader failed to register is a missing typeface in the browser rather than a
 * silent substitution. `canvaskit-wasm` is aliased to a stub because the page
 * loads the real wasm from a script tag.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { build } from "esbuild";

import { loadSystemStyleMap } from "@montaj/caption-styles";
import { animate, createHarfBuzzShaper, layoutSegment } from "@montaj/render-core";
import type { DrawCommand, RenderWord } from "@montaj/render-core";

import { loadPack } from "../src/pack.js";

const here = __dirname;
const artifacts = join(here, ".artifacts");

const SAMPLES = [
  { name: "latin", text: "Aksharo draws captions" },
  { name: "devanagari", text: "हिंदी में कैप्शन बनाइए" },
  { name: "tamil", text: "தமிழ் வசனம் இங்கே" },
] as const;

/** Every `fontId` a command tree references. */
function collectFontIds(commands: readonly DrawCommand[], into: Set<string>): void {
  for (const command of commands) {
    const record = command as unknown as {
      kind?: string;
      run?: { fontId?: string };
      children?: DrawCommand[];
    };
    if (record.kind === "text" && typeof record.run?.fontId === "string") {
      into.add(record.run.fontId);
    }
    if (Array.isArray(record.children)) collectFontIds(record.children, into);
  }
}

/** Lay out one caption per script with the pack's own faces. */
async function buildCommands(): Promise<string[]> {
  const { registry } = await loadPack();
  const shaper = await createHarfBuzzShaper(registry);
  const canvas = { width: 540, height: 960 };

  const style = loadSystemStyleMap().get("punch-pop");
  if (style === undefined) throw new Error("the punch-pop style is missing");

  const frames: Record<string, DrawCommand[]> = {};
  const fontIds = new Set<string>();
  for (const sample of SAMPLES) {
    const words: RenderWord[] = sample.text.split(" ").map((text, index) => ({
      wid: `0:${String(index)}`,
      t: text,
      s: index * 300,
      e: index * 300 + 300,
    }));
    const layout = layoutSegment({
      style,
      segment: { id: "s1", startMs: 0, endMs: 3_000 },
      words,
      canvas,
      registry,
      shaper,
      tMs: 1_500,
    });
    const commands = animate({ layout, style, tMs: 1_500 });
    frames[sample.name] = commands;
    collectFontIds(commands, fontIds);
  }

  mkdirSync(artifacts, { recursive: true });
  writeFileSync(
    join(artifacts, "commands.json"),
    JSON.stringify({ canvas, background: "#101018ff", frames, fontIds: [...fontIds] }, null, 2),
    "utf8",
  );
  return [...fontIds];
}

export async function buildBundle(): Promise<void> {
  await build({
    entryPoints: [join(here, "browser-entry.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    sourcemap: "inline",
    outfile: join(artifacts, "loader.js"),
    alias: { "canvaskit-wasm": resolve(here, "canvaskit-stub.mjs") },
    // The page never shapes: the commands arrive laid out, so HarfBuzz stays on
    // the Node side. Marking it external keeps its Node-only wasm loader out of
    // a browser bundle that would never call it.
    external: ["harfbuzzjs"],
    logLevel: "warning",
  });
}

export default async function globalSetup(): Promise<void> {
  const fontIds = await buildCommands();
  if (fontIds.length === 0) throw new Error("the layout referenced no fonts at all");
  await buildBundle();
  // Fail here, not in the page, when the pack or the bundle is missing.
  if (!existsSync(join(artifacts, "loader.js"))) {
    throw new Error("the browser bundle was not written");
  }
}
