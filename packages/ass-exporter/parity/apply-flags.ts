/**
 * The only writer of `assRenderable`/`assExportable`/`requiresLayoutMetrics`/
 * `parityScore` in `packages/caption-styles/styles/*.json` (D33). Reads
 * `packages/caption-styles/parity/results.json`, which `parity/run.ts`
 * produced, and patches each style file's four flag fields in place — nothing
 * else in the file is touched, so a diff on this commit is exactly the flag
 * change and nothing else.
 *
 * `parityScore` is the *lower* of the two measured scores expressed as
 * `1 - worstDiffRatio`: a style is only as good as its worse renderer. When
 * `assVsSkia` was not measured (no libass ffmpeg), `parityScore` falls back to
 * the CanvasKit-vs-Skia score alone, because that is still a real, gated
 * number — never a fabricated one.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatJson } from "./format-json.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = join(__dirname, "..", "..", "caption-styles", "parity", "results.json");
const STYLES_DIR = join(__dirname, "..", "..", "caption-styles", "styles");

interface StyleParityResult {
  readonly canvasVsSkia: number | null;
  readonly assVsSkia: number | null;
  readonly assRenderable: boolean;
  readonly assExportable: boolean;
  readonly requiresLayoutMetrics: boolean;
}

interface ResultsFile {
  readonly styles: Record<string, StyleParityResult>;
}

function parityScoreOf(result: StyleParityResult): number | undefined {
  const scores = [result.canvasVsSkia, result.assVsSkia]
    .filter((value): value is number => value !== null)
    .map((ratio) => 1 - ratio);
  if (scores.length === 0) return undefined;
  return Math.min(...scores);
}

async function main(): Promise<void> {
  const results = JSON.parse(await readFile(RESULTS_PATH, "utf8")) as ResultsFile;
  const files = (await readdir(STYLES_DIR)).filter(
    (f) => f.endsWith(".json") && f !== "registry.json",
  );

  let changed = 0;
  for (const file of files) {
    const path = join(STYLES_DIR, file);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const raw = await readFile(path, "utf8");
    const doc = JSON.parse(raw) as Record<string, unknown>;
    const id = typeof doc["id"] === "string" ? doc["id"] : file.replace(/\.json$/, "");
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const result = results.styles[id];
    if (result === undefined) {
      console.warn(`no parity result for style "${id}" (${file}); leaving its flags untouched`);
      continue;
    }

    const score = parityScoreOf(result);
    const next = {
      ...doc,
      assRenderable: result.assRenderable,
      assExportable: result.assExportable,
      requiresLayoutMetrics: result.requiresLayoutMetrics,
      ...(score === undefined ? {} : { parityScore: Math.round(score * 10_000) / 10_000 }),
    };

    const nextText = await formatJson(next, path);
    if (nextText !== raw) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      await writeFile(path, nextText, "utf8");
      changed += 1;
      console.warn(
        `updated ${file}: assRenderable=${String(result.assRenderable)} parityScore=${String(next["parityScore"])}`,
      );
    }
  }

  console.warn(`\n${String(changed)} style file(s) changed.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
