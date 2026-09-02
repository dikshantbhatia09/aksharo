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

/** `package-resolve`: zips `aksharo_core` (DaVinci Resolve script) plus per-OS installer
 * scripts that copy it into the Fusion `Scripts/Utility` path (RR-03: no signing needed). */
export async function runPackageResolve(
  ctx: ReleaseContext,
  config: ReleaseConfig,
  version: string,
): Promise<PackageResolveResult> {
  const absPluginDir = path.join(ctx.repoRoot, config.resolveBundle.scriptDir);
  let sourceDir = absPluginDir;
  let placeholderPlugin = false;

  if (!(await pathExists(path.join(absPluginDir, `${PLUGIN_IDS.resolveScript}.lua`)))) {
    placeholderPlugin = true;
    sourceDir = path.join(ctx.outDir, "build-resolve", "placeholder-plugin");
    await ensureDir(sourceDir);
    await fs.writeFile(
      path.join(sourceDir, `${PLUGIN_IDS.resolveScript}.lua`),
      "-- placeholder Resolve script (C08 not landed yet)\n",
      "utf8",
    );
  }

  await writeInstaller(sourceDir, "install.sh", installerShell(config));
  await writeInstaller(sourceDir, "install.ps1", installerPowerShell(config));

  const bundlePath = path.join(
    ctx.outDir,
    "artifacts",
    "plugins",
    `aksharo-resolve-${version}.zip`,
  );
  await zipDirectory(sourceDir, bundlePath);

  return { bundlePath, placeholderPlugin };
}

async function writeInstaller(dir: string, name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(dir, name), content, "utf8");
}

function installerShell(config: ReleaseConfig): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'OS="$(uname)"',
    `if [ "$OS" = "Darwin" ]; then DEST="${config.resolveBundle.installPaths.mac}"; else DEST="${config.resolveBundle.installPaths.linux}"; fi`,
    'mkdir -p "$DEST"',
    'cp "$(dirname "$0")"/*.lua "$DEST"/',
    'echo "Installed to $DEST"',
    "",
  ].join("\n");
}

function installerPowerShell(config: ReleaseConfig): string {
  return [
    `$Dest = "${config.resolveBundle.installPaths.win}"`,
    "New-Item -ItemType Directory -Force -Path $Dest | Out-Null",
    'Copy-Item -Path "$PSScriptRoot\\*.lua" -Destination $Dest -Force',
    'Write-Host "Installed to $Dest"',
    "",
  ].join("\n");
}
