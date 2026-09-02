// Bundles the panel into a single Workflow-Integration-safe script. Mirrors
// plugins/premiere-uxp/scripts/build.mjs: an IIFE (no runtime `import()` of a URL — the panel
// is a single synchronous `<script>` load) so it works whether or not Resolve's Workflow
// Integration host restricts module loading the same way UXP's embedded Chromium does (that
// restriction is unconfirmed for Resolve specifically; IIFE is the same safe default either
// way and gives it esbuild's `--bundle --format=iife` for free).
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
  target: ["chrome94"], // Resolve's Workflow Integration panels run in an embedded Chromium
  outfile: path.join(outdir, "panel.js"),
  sourcemap: true,
  minify: process.env.NODE_ENV === "production",
  define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development") },
  logLevel: "info",
});

console.log(`built ${path.relative(root, path.join(outdir, "panel.js"))}`);
