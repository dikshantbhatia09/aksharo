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
  /** C09: whether the Studio Workflow Integration panel (built `dist/` + `manifest.xml` +
   * `index.html`) was actually staged, vs. a placeholder because either the panel hasn't been
   * built (`pnpm --filter @montaj/resolve-panel build`) or `config.resolvePanel` is unset. */
  placeholderPanel: boolean;
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

  // C09: Studio installs additionally get the docked Workflow Integration panel. Staged in
  // its own subfolder (`panel/`) since it installs to a different Resolve-owned location
  // ("Workflow Integration Plugins", not Fusion's `Scripts/Utility` `resolveBundle` uses) —
  // C10's installer decides the final Studio-only placement; see this WP's report for the
  // exact manifest entry C10 needs (C10 had not landed when this was written).
  const panelDir = path.join(sourceDir, "panel");
  const placeholderPanel = await stagePanel(ctx, panelDir);
  if (config.resolvePanel) {
    await writeInstaller(sourceDir, "install-panel.sh", installerPanelShell(config.resolvePanel));
    await writeInstaller(
      sourceDir,
      "install-panel.ps1",
      installerPanelPowerShell(config.resolvePanel),
    );
  }

  const bundlePath = path.join(
    ctx.outDir,
    "artifacts",
    "plugins",
    `aksharo-resolve-${version}.zip`,
  );
  await zipDirectory(sourceDir, bundlePath);

  return { bundlePath, placeholderPlugin, placeholderPanel };
}

/** Stages `plugins/resolve-panel`'s manifest + built `dist/` (Studio panel, brief item 3);
 * a placeholder when the panel hasn't been built yet (`pnpm --filter @montaj/resolve-panel
 * build`), mirroring `hasRealScript`'s fallback above. */
async function stagePanel(ctx: ReleaseContext, panelDir: string): Promise<boolean> {
  const absPanelSourceDir = path.join(ctx.repoRoot, "plugins", "resolve-panel");
  const manifestPath = path.join(absPanelSourceDir, "manifest.xml");
  const distDir = path.join(absPanelSourceDir, "dist");
  const hasManifest = await pathExists(manifestPath);
  const hasBuiltDist = await pathExists(path.join(distDir, "panel.js"));

  if (!hasManifest || !hasBuiltDist) {
    await ensureDir(panelDir);
    await fs.writeFile(
      path.join(panelDir, "README.txt"),
      hasManifest
        ? "placeholder Resolve Studio panel (run `pnpm --filter @montaj/resolve-panel build` first)\n"
        : "placeholder Resolve Studio panel (plugins/resolve-panel/manifest.xml not found)\n",
      "utf8",
    );
    return true;
  }

  await ensureDir(panelDir);
  await fs.copyFile(manifestPath, path.join(panelDir, "manifest.xml"));
  await fs.copyFile(path.join(absPanelSourceDir, "index.html"), path.join(panelDir, "index.html"));
  await copyDir(distDir, path.join(panelDir, "dist"));
  return false;
}

function installerPanelShell(resolvePanel: NonNullable<ReleaseConfig["resolvePanel"]>): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'OS="$(uname)"',
    `if [ "$OS" = "Darwin" ]; then DEST="${resolvePanel.installPaths.mac}"; else DEST="${resolvePanel.installPaths.linux}"; fi`,
    'mkdir -p "$DEST"',
    'cp -R "$(dirname "$0")/panel/"* "$DEST"/',
    'echo "Installed Studio panel to $DEST"',
    "",
  ].join("\n");
}

function installerPanelPowerShell(
  resolvePanel: NonNullable<ReleaseConfig["resolvePanel"]>,
): string {
  return [
    `$Dest = "${resolvePanel.installPaths.win}"`,
    "New-Item -ItemType Directory -Force -Path $Dest | Out-Null",
    'Copy-Item -Path "$PSScriptRoot\\panel\\*" -Destination $Dest -Recurse -Force',
    'Write-Host "Installed Studio panel to $Dest"',
    "",
  ].join("\n");
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
