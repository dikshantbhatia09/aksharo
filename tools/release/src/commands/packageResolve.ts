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
  /** Macro ids staged from `plugins/resolve/installer/manifest.json` (empty until a macro
   * file actually exists on disk — C08b generates it, never hand-edited). */
  macrosStaged: string[];
  /** C09: whether the Studio Workflow Integration panel (built `dist/` + `manifest.xml` +
   * `index.html`) was actually staged, vs. a placeholder because either the panel hasn't been
   * built (`pnpm --filter @montaj/resolve-panel build`) or `config.resolvePanel` is unset. */
  placeholderPanel: boolean;
}

/** `plugins/resolve/installer/manifest.json` (C08b + C10): Fusion macros the installer
 * copies alongside the `Scripts/Utility` script tree, each with its own per-OS install path. */
interface ResolveInstallerManifest {
  version: number;
  macros: {
    id: string;
    file: string;
    installTo: { win: string; mac: string; linux: string };
  }[];
}

async function readInstallerManifest(repoRoot: string): Promise<ResolveInstallerManifest> {
  const manifestPath = path.join(repoRoot, "plugins", "resolve", "installer", "manifest.json");
  if (!(await pathExists(manifestPath))) return { version: 1, macros: [] };
  const raw = await fs.readFile(manifestPath, "utf8");
  return JSON.parse(raw) as ResolveInstallerManifest;
}

/** `package-resolve`: zips `aksharo_core.py` + its `aksharo_core_app` library (C08;
 * a real Python package, no `.lua`) plus per-OS installer scripts that copy both into
 * the Fusion `Scripts/Utility` path (works for both Resolve Free and Studio — they share
 * the same per-user Fusion support directory, RR-03: no signing needed) and stage any
 * generated macro (C08b's Text+ caption macro) into its own Fusion `Macros` path. Ships
 * an uninstaller and a `VERSION` file next to the scripts so a re-run/uninstall can tell
 * what is currently installed. Only the real script tree is staged — not this workspace's
 * `.venv`, `tests/`, or Python tooling config. */
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

  const installerManifest = await readInstallerManifest(ctx.repoRoot);
  const macrosStaged: string[] = [];
  const stagedMacroDir = path.join(sourceDir, "macros");
  await ensureDir(stagedMacroDir);
  for (const macro of installerManifest.macros) {
    const macroSrc = path.join(absPluginDir, macro.file);
    if (!(await pathExists(macroSrc))) continue; // C08b not landed yet -- skip, don't fake it
    const macroFileName = path.basename(macro.file);
    await fs.copyFile(macroSrc, path.join(stagedMacroDir, macroFileName));
    macrosStaged.push(macro.id);
  }

  await fs.writeFile(path.join(sourceDir, "VERSION"), `${version}\n`, "utf8");

  await writeInstaller(
    sourceDir,
    "install.sh",
    installerShell(config, entryFile, libDir, installerManifest, version),
  );
  await writeInstaller(
    sourceDir,
    "install.ps1",
    installerPowerShell(config, entryFile, libDir, installerManifest, version),
  );
  await writeInstaller(
    sourceDir,
    "uninstall.sh",
    uninstallerShell(config, entryFile, libDir, installerManifest),
  );
  await writeInstaller(
    sourceDir,
    "uninstall.ps1",
    uninstallerPowerShell(config, entryFile, libDir, installerManifest),
  );

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

  return { bundlePath, placeholderPlugin, macrosStaged, placeholderPanel };
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

/** Both DaVinci Resolve Free and Studio read scripts/macros from the same per-user Fusion
 * support directory on each OS -- there is no separate Free-vs-Studio install path -- so one
 * script serves both editions. */
function installerShell(
  config: ReleaseConfig,
  entryFile: string,
  libDir: string,
  manifest: ResolveInstallerManifest,
  version: string,
): string {
  const macroLines = manifest.macros.flatMap((macro) => {
    const macroFileName = path.basename(macro.file);
    return [
      `if [ -f "$(dirname "$0")/macros/${macroFileName}" ]; then`,
      `  if [ "$OS" = "Darwin" ]; then MACRO_DEST="${macro.installTo.mac}"; else MACRO_DEST="${macro.installTo.linux}"; fi`,
      '  mkdir -p "$MACRO_DEST"',
      `  cp "$(dirname "$0")/macros/${macroFileName}" "$MACRO_DEST"/`,
      "fi",
    ];
  });
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "# Installs into DaVinci Resolve Free and Studio alike -- both editions read scripts and",
    "# macros from the same per-user Fusion support directory.",
    'OS="$(uname)"',
    `if [ "$OS" = "Darwin" ]; then DEST="${config.resolveBundle.installPaths.mac}"; else DEST="${config.resolveBundle.installPaths.linux}"; fi`,
    'mkdir -p "$DEST"',
    `cp "$(dirname "$0")/${entryFile}" "$DEST"/`,
    `cp -R "$(dirname "$0")/${libDir}" "$DEST"/`,
    `cp "$(dirname "$0")/VERSION" "$DEST"/aksharo-resolve.VERSION`,
    ...macroLines,
    `echo "Installed Aksharo for DaVinci Resolve ${version} to $DEST"`,
    "",
  ].join("\n");
}

function installerPowerShell(
  config: ReleaseConfig,
  entryFile: string,
  libDir: string,
  manifest: ResolveInstallerManifest,
  version: string,
): string {
  const macroLines = manifest.macros.flatMap((macro) => {
    const macroFileName = path.basename(macro.file);
    return [
      `if (Test-Path "$PSScriptRoot\\macros\\${macroFileName}") {`,
      `  New-Item -ItemType Directory -Force -Path "${macro.installTo.win}" | Out-Null`,
      `  Copy-Item -Path "$PSScriptRoot\\macros\\${macroFileName}" -Destination "${macro.installTo.win}" -Force`,
      "}",
    ];
  });
  return [
    "# Installs into DaVinci Resolve Free and Studio alike -- both editions read scripts and",
    "# macros from the same per-user Fusion support directory.",
    `$Dest = "${config.resolveBundle.installPaths.win}"`,
    "New-Item -ItemType Directory -Force -Path $Dest | Out-Null",
    `Copy-Item -Path "$PSScriptRoot\\${entryFile}" -Destination $Dest -Force`,
    `Copy-Item -Path "$PSScriptRoot\\${libDir}" -Destination $Dest -Recurse -Force`,
    `Copy-Item -Path "$PSScriptRoot\\VERSION" -Destination "$Dest\\aksharo-resolve.VERSION" -Force`,
    ...macroLines,
    `Write-Host "Installed Aksharo for DaVinci Resolve ${version} to $Dest"`,
    "",
  ].join("\n");
}

function uninstallerShell(
  config: ReleaseConfig,
  entryFile: string,
  libDir: string,
  manifest: ResolveInstallerManifest,
): string {
  const macroLines = manifest.macros.flatMap((macro) => {
    const macroFileName = path.basename(macro.file);
    return [
      `if [ "$OS" = "Darwin" ]; then rm -f "${macro.installTo.mac}/${macroFileName}"; else rm -f "${macro.installTo.linux}/${macroFileName}"; fi`,
    ];
  });
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'OS="$(uname)"',
    `if [ "$OS" = "Darwin" ]; then DEST="${config.resolveBundle.installPaths.mac}"; else DEST="${config.resolveBundle.installPaths.linux}"; fi`,
    `rm -f "$DEST/${entryFile}"`,
    `rm -rf "$DEST/${libDir}"`,
    'rm -f "$DEST/aksharo-resolve.VERSION"',
    ...macroLines,
    'echo "Uninstalled Aksharo for DaVinci Resolve from $DEST"',
    "",
  ].join("\n");
}

function uninstallerPowerShell(
  config: ReleaseConfig,
  entryFile: string,
  libDir: string,
  manifest: ResolveInstallerManifest,
): string {
  const macroLines = manifest.macros.map((macro) => {
    const macroFileName = path.basename(macro.file);
    return `Remove-Item -Path "${macro.installTo.win}\\${macroFileName}" -Force -ErrorAction SilentlyContinue`;
  });
  return [
    `$Dest = "${config.resolveBundle.installPaths.win}"`,
    `Remove-Item -Path "$Dest\\${entryFile}" -Force -ErrorAction SilentlyContinue`,
    `Remove-Item -Path "$Dest\\${libDir}" -Recurse -Force -ErrorAction SilentlyContinue`,
    `Remove-Item -Path "$Dest\\aksharo-resolve.VERSION" -Force -ErrorAction SilentlyContinue`,
    ...macroLines,
    'Write-Host "Uninstalled Aksharo for DaVinci Resolve from $Dest"',
    "",
  ].join("\n");
}
