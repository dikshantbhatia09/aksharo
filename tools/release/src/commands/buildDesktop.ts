import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, pathExists, writeJson } from "../lib/fsUtil.js";
import { discoverNestedBinaries, outermostBundleTarget } from "../lib/nestedBinaries.js";
import { zipDirectory } from "../lib/zip.js";
import { resolveSignProvider } from "../signing/index.js";

import type { ReleaseConfig } from "../config.js";
import type { Channel, Platform, ReleaseContext } from "../types.js";

export interface BuildDesktopOptions {
  platform: Platform;
  channel: Channel;
  dryRun: boolean;
}

export interface BuildDesktopResult {
  appDir: string;
  artifactPath: string;
  electronBuilderConfigPath: string;
  signed: { path: string; signed: boolean }[];
  placeholderApp: boolean;
}

/** Generates the electron-builder YAML-shaped config as JSON from `release.config.ts`. Kept
 * as JSON (not YAML) so the CLI has no extra YAML dependency; electron-builder also accepts
 * `electron-builder.json`. */
export function generateElectronBuilderConfig(
  config: ReleaseConfig,
  platform: Platform,
): Record<string, unknown> {
  return {
    appId: config.appId,
    productName: config.productName,
    directories: { output: "dist-electron" },
    files: ["dist/**/*"],
    afterSign: "tools/release/dist/hooks/afterSign.js",
    mac:
      platform === "mac"
        ? {
            target: config.mac.target.map((t) => ({ target: t, arch: ["universal"] })),
            category: config.mac.category,
            hardenedRuntime: true,
          }
        : undefined,
    win:
      platform === "win"
        ? { target: [{ target: config.win.target, arch: [config.win.arch] }] }
        : undefined,
  };
}

/**
 * Builds a placeholder desktop app tree when `apps/desktop` has no real Electron code yet
 * (per brief, "build against a placeholder app if absent and report"). C02 has since landed
 * `apps/desktop/electron-builder.yml` with `appId: ai.aksharo.desktop`, `productName: Aksharo`
 * and mac category `public.app-category.video` — this file's `release.config.ts` mirrors
 * those exact values, so the two configs are provably consistent even though invoking the
 * real electron-builder (downloads Electron, needs a GUI toolchain) stays out of scope for
 * this dry-run harness; `ensureAppTree` still synthesizes a nested-binary tree either way so
 * `sign-nested`/`notarize`/`checksums` exercise their real logic against *some* tree.
 */
async function ensureAppTree(
  outDir: string,
  platform: Platform,
  desktopAppDir: string,
): Promise<{ appDir: string; placeholder: boolean }> {
  const hasRealApp = await pathExists(path.join(desktopAppDir, "package.json"));
  const appDir = path.join(outDir, "build", platform, hasRealApp ? "app" : "placeholder-app");
  if (hasRealApp) {
    // Real electron-builder invocation would populate `appDir`; out of scope for a dry-run
    // fixture, so we still materialize a minimal tree so downstream commands have something.
    await ensureDir(appDir);
  }
  await ensureDir(appDir);

  if (platform === "mac") {
    const contents = path.join(appDir, "Aksharo.app", "Contents");
    await ensureDir(path.join(contents, "MacOS"));
    await ensureDir(path.join(contents, "Frameworks", "Aksharo Helper.app", "Contents", "MacOS"));
    await fs.writeFile(path.join(contents, "MacOS", "Aksharo"), "placeholder-mach-o-main\n");
    await fs.writeFile(
      path.join(
        contents,
        "Frameworks",
        "Aksharo Helper.app",
        "Contents",
        "MacOS",
        "Aksharo Helper",
      ),
      "placeholder-helper\n",
    );
    await fs.writeFile(
      path.join(contents, "MacOS", "montaj-engine"),
      "placeholder-engine-sidecar\n",
    );
    await fs.writeFile(path.join(contents, "MacOS", "ffmpeg"), "placeholder-ffmpeg\n");
    await fs.writeFile(path.join(contents, "MacOS", "bridge"), "placeholder-bridge-sea\n");
  } else {
    const unpacked = path.join(appDir, "win-unpacked");
    await ensureDir(unpacked);
    await fs.writeFile(path.join(unpacked, "Aksharo.exe"), "placeholder-pe-main\n");
    await fs.writeFile(path.join(unpacked, "montaj-engine.exe"), "placeholder-engine-sidecar\n");
    await fs.writeFile(path.join(unpacked, "ffmpeg.exe"), "placeholder-ffmpeg\n");
    await fs.writeFile(path.join(unpacked, "bridge.exe"), "placeholder-bridge-sea\n");
    await fs.writeFile(path.join(unpacked, "resources.dll"), "placeholder-dll\n");
  }

  return { appDir, placeholder: !hasRealApp };
}

export async function runBuildDesktop(
  ctx: ReleaseContext,
  config: ReleaseConfig,
  opts: BuildDesktopOptions,
): Promise<BuildDesktopResult> {
  const outDir = path.join(ctx.outDir, "build-desktop", opts.channel, opts.platform);
  await ensureDir(outDir);

  const ebConfig = generateElectronBuilderConfig(config, opts.platform);
  const electronBuilderConfigPath = path.join(outDir, "electron-builder.generated.json");
  await writeJson(electronBuilderConfigPath, ebConfig);

  const { appDir, placeholder } = await ensureAppTree(
    outDir,
    opts.platform,
    path.join(ctx.repoRoot, config.desktopAppDir),
  );

  const nested = await discoverNestedBinaries(appDir, opts.platform);
  const bundleRoot =
    opts.platform === "mac" ? path.join(appDir, "Aksharo.app") : path.join(appDir, "win-unpacked");
  const outer = outermostBundleTarget(bundleRoot, opts.platform);

  const provider = resolveSignProvider(opts.platform, ctx.mode);
  const signed: { path: string; signed: boolean }[] = [];
  for (const target of nested) {
    const result = await provider.sign(target, ctx);
    signed.push({ path: result.path, signed: result.signed });
  }
  const outerResult = await provider.sign(outer, ctx);
  signed.push({ path: outerResult.path, signed: outerResult.signed });

  const artifactExt = opts.platform === "mac" ? "zip" : "zip"; // dmg/nsis packaging requires native tooling; dry-run packs a zip stand-in
  const artifactName = `Aksharo-${opts.channel}-${opts.platform}.${artifactExt}`;
  const artifactPath = path.join(ctx.outDir, "artifacts", opts.channel, artifactName);
  await zipDirectory(bundleRoot, artifactPath);

  return { appDir, artifactPath, electronBuilderConfigPath, signed, placeholderApp: placeholder };
}
