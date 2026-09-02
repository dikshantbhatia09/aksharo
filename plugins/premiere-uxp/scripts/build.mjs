// Bundles the panel into a single UXP-safe script.
//
// UXP's JS engine (V8 embedded, no Node/Electron APIs) forbids `eval`/`new Function` and does
// not reliably support dynamically importing remote code, so the bundle format is IIFE (one
// synchronous `<script>` load, no runtime `import()` of a URL) rather than ESM — see Adobe's
// UXP guide, "JavaScript restrictions" (developer.adobe.com/premiere-pro/uxp/guides/uxp_guide/uxp-for-scripting/javascript-restrictions/).
// esbuild's `--bundle --format=iife` satisfies this without a dependency on Node/webpack.
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outdir = path.join(root, "dist");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: [path.join(root, "src", "index.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome94"], // UXP's embedded Chromium baseline (manifest v5 hosts)
  outfile: path.join(outdir, "panel.js"),
  sourcemap: true,
  minify: process.env.NODE_ENV === "production",
  define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development") },
  logLevel: "info",
});

console.log(`built ${path.relative(root, path.join(outdir, "panel.js"))}`);
