// Bundles the panel into a single browser-safe script.
//
// A CEP panel is a Chromium 99 tab (CEP 12 HTML Extension Cookbook, cited in
// `src/host/ae.ts`'s header) — a regular web page, not a sandboxed runtime with import
// restrictions the way UXP is (contrast `plugins/premiere-uxp/scripts/build.mjs`'s comment).
// IIFE is still used here for simplicity and parity with that sibling package, not because CEP
// requires it.
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
  target: ["chrome99"], // CEP 12's embedded Chromium baseline
  outfile: path.join(outdir, "panel.js"),
  sourcemap: true,
  minify: process.env.NODE_ENV === "production",
  define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development") },
  logLevel: "info",
});

console.log(`built ${path.relative(root, path.join(outdir, "panel.js"))}`);
