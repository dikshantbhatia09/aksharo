import fs from "node:fs/promises";
import path from "node:path";

import { PLUGIN_IDS } from "@montaj/config/brand";

import { validateUxpManifest, type UxpManifest } from "../lib/ccxManifest.js";
import { ensureDir, pathExists } from "../lib/fsUtil.js";
import { zipDirectory } from "../lib/zip.js";

import type { ReleaseContext } from "../types.js";

export interface PackageCcxOptions {
  pluginDir: string;
  minPremiereVersion: string;
  version: string;
}

export interface PackageCcxResult {
  ccxPath: string;
  manifestValid: boolean;
  manifestErrors: string[];
  placeholderPlugin: boolean;
}

const PLACEHOLDER_MANIFEST: UxpManifest = {
  id: PLUGIN_IDS.premiereUxp,
  name: "Aksharo Captions",
  version: "0.1.0",
  host: [{ app: "PPRO", minVersion: "25.6" }],
};

/**
 * `package-ccx`: zips the UXP plugin folder into a `.ccx` (a plain ZIP per RR-03 — UXP needs
 * no signature). Validates `manifest.json` first so a bad id/host entry fails the CLI instead
 * of shipping a package Premiere will refuse to load.
 */
export async function runPackageCcx(
  ctx: ReleaseContext,
  opts: PackageCcxOptions,
): Promise<PackageCcxResult> {
  const absPluginDir = path.isAbsolute(opts.pluginDir)
    ? opts.pluginDir
    : path.join(ctx.repoRoot, opts.pluginDir);
  const manifestPath = path.join(absPluginDir, "manifest.json");

  let sourceDir = absPluginDir;
  let placeholderPlugin = false;
  if (!(await pathExists(manifestPath))) {
    // `plugins/premiere-uxp` is a placeholder (C05a not landed yet) — build a minimal valid
    // plugin tree so the pipeline still exercises manifest validation + zipping end to end.
    placeholderPlugin = true;
    sourceDir = path.join(ctx.outDir, "build-ccx", "placeholder-plugin");
    await ensureDir(sourceDir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await fs.writeFile(
      path.join(sourceDir, "manifest.json"),
      `${JSON.stringify(PLACEHOLDER_MANIFEST, null, 2)}\n`,
      "utf8",
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await fs.writeFile(
      path.join(sourceDir, "index.html"),
      "<!-- placeholder UXP entry point -->\n",
      "utf8",
    );
  } else {
    // A real plugin source tree (C05a+) has its `package.json`/`src`/`node_modules`/tests
    // alongside the shippable files — zipping `absPluginDir` as-is would ship the whole dev
    // tree (and pnpm's symlinked `node_modules` breaks the dependency-free ZIP fallback in
    // `zip.ts`, which doesn't follow symlinks). Stage only the shippable subset instead.
    sourceDir = path.join(ctx.outDir, "build-ccx", "staged-plugin");
    await ensureDir(sourceDir);
    await stageShippableFiles(absPluginDir, sourceDir);
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  const manifestRaw = await fs.readFile(path.join(sourceDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestRaw) as unknown;
  const validation = validateUxpManifest(manifest);
  if (!validation.valid) {
    throw new Error(
      `manifest.json invalid:\n${validation.errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }

  const ccxPath = path.join(
    ctx.outDir,
    "artifacts",
    "plugins",
    `aksharo-premiere-${opts.version}.ccx`,
  );
  await zipDirectory(sourceDir, ccxPath);

  return {
    ccxPath,
    manifestValid: validation.valid,
    manifestErrors: validation.errors,
    placeholderPlugin,
  };
}

/** Files/directories a UXP plugin ships; everything else in the source tree is dev-only. */
const SHIPPABLE_ENTRIES = ["manifest.json", "index.html", "dist", "icons"];

async function stageShippableFiles(fromDir: string, toDir: string): Promise<void> {
  for (const entry of SHIPPABLE_ENTRIES) {
    const src = path.join(fromDir, entry);
    if (!(await pathExists(src))) continue;
    await fs.cp(src, path.join(toDir, entry), { recursive: true, dereference: true });
  }
}
