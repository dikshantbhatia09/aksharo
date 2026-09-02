import fs from "node:fs/promises";
import path from "node:path";

import { PLUGIN_IDS } from "@montaj/config/brand";

import { ensureDir, pathExists } from "../lib/fsUtil.js";
import { zipDirectory } from "../lib/zip.js";

import type { ReleaseConfig } from "../config.js";
import type { ReleaseContext } from "../types.js";

export interface PackageResolveResult {
  bundlePath: string;
  placeholderPlugin: boolean;
}

/** `package-resolve`: zips `aksharo_core.py` + its `aksharo_core_app` library (C08;
 * a real Python package, no `.lua`) plus per-OS installer scripts that copy both into
 * the Fusion `Scripts/Utility` path (RR-03: no signing needed). Only the real script
 * tree is staged — not this workspace's `.venv`, `tests/`, or Python tooling config. */
export async function runPackageResolve(
  ctx: ReleaseContext,
  config: ReleaseConfig,
  version: string,
): Promise<PackageResolveResult> {
  const absPluginDir = path.join(ctx.repoRoot, config.resolveBundle.scriptDir);
  const entryFile = `${PLUGIN_IDS.resolveScript}.py`;
  const libDir = `${PLUGIN_IDS.resolveScript}_app`;
  const hasRealScript = await pathExists(path.join(absPluginDir, entryFile));

  const sourceDir = path.join(ctx.outDir, "build-resolve", "staged-plugin");
  await ensureDir(sourceDir);
  let placeholderPlugin = false;

  if (hasRealScript) {
    await fs.copyFile(path.join(absPluginDir, entryFile), path.join(sourceDir, entryFile));
    await copyDir(path.join(absPluginDir, libDir), path.join(sourceDir, libDir));
  } else {
    placeholderPlugin = true;
    await fs.writeFile(
      path.join(sourceDir, entryFile),
      "# placeholder Resolve script (C08 not landed yet)\n",
      "utf8",
    );
  }

  await writeInstaller(sourceDir, "install.sh", installerShell(config, entryFile, libDir));
  await writeInstaller(sourceDir, "install.ps1", installerPowerShell(config, entryFile, libDir));

  const bundlePath = path.join(
    ctx.outDir,
    "artifacts",
    "plugins",
    `aksharo-resolve-${version}.zip`,
  );
  await zipDirectory(sourceDir, bundlePath);

  return { bundlePath, placeholderPlugin };
}

async function copyDir(src: string, dest: string): Promise<void> {
  if (!(await pathExists(src))) return;
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    // Never ship bytecode caches or the (non-existent here) venv.
    if (entry.name === "__pycache__" || entry.name === ".venv") continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else if (entry.isFile()) {
      await fs.copyFile(from, to);
    }
  }
}

async function writeInstaller(dir: string, name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(dir, name), content, "utf8");
}

function installerShell(config: ReleaseConfig, entryFile: string, libDir: string): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'OS="$(uname)"',
    `if [ "$OS" = "Darwin" ]; then DEST="${config.resolveBundle.installPaths.mac}"; else DEST="${config.resolveBundle.installPaths.linux}"; fi`,
    'mkdir -p "$DEST"',
    `cp "$(dirname "$0")/${entryFile}" "$DEST"/`,
    `cp -R "$(dirname "$0")/${libDir}" "$DEST"/`,
    'echo "Installed to $DEST"',
    "",
  ].join("\n");
}

function installerPowerShell(config: ReleaseConfig, entryFile: string, libDir: string): string {
  return [
    `$Dest = "${config.resolveBundle.installPaths.win}"`,
    "New-Item -ItemType Directory -Force -Path $Dest | Out-Null",
    `Copy-Item -Path "$PSScriptRoot\\${entryFile}" -Destination $Dest -Force`,
    `Copy-Item -Path "$PSScriptRoot\\${libDir}" -Destination $Dest -Recurse -Force`,
    'Write-Host "Installed to $Dest"',
    "",
  ].join("\n");
}
