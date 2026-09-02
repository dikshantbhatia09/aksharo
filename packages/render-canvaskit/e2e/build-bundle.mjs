/**
 * Bundles `browser-entry.ts` into `.artifacts/executor.js` for the harness page.
 *
 * Playwright runs this as its global setup, so the browser always tests the
 * executor as it is on disk rather than a stale artefact. `canvaskit-wasm` is
 * aliased to a stub: the page loads the real wasm from a script tag, and
 * bundling emscripten's loader would only produce a second copy.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildBundle() {
  const result = await build({
    entryPoints: [join(here, "browser-entry.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    sourcemap: "inline",
    outfile: join(here, ".artifacts", "executor.js"),
    alias: { "canvaskit-wasm": resolve(here, "canvaskit-stub.mjs") },
    logLevel: "warning",
    metafile: true,
  });
  return result;
}

export default async function globalSetup() {
  await buildBundle();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildBundle();
  console.log("built e2e/.artifacts/executor.js");
}
