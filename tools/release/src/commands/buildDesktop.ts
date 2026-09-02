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
 * Looks for a real `electron-builder --dir` output under `<desktopAppDir>/release`
 * (C02b, scope §4: "consumes the real apps/desktop output ... when a real build
 * exists"). `pnpm --filter @montaj/desktop pack:dry` (or the new `release-desktop.yml`
 * `e2e` job, C02b §3) produces this locally/in CI before `build-desktop` runs.
 *
 * **Known local blocker (verified 2026-09, not introduced by this WP):** in this
 * pnpm workspace, `electron-builder --dir` currently fails before producing any
 * output — `node_modules/@montaj/{bridge-core,config}` are pnpm symlinks whose
 * real path resolves to `packages/*` (outside `apps/desktop/`), and app-builder-lib's
 * asar packager (`AsarPackager.unpackPattern` → `getRelativePath`) throws
 * `"<file> must be under <appDir>"` for every file under those packages once it
 * tries to express their real path relative to the app dir. Reproduces with only
 * `@montaj/bridge-core`/`@montaj/config` as dependencies (present since C01/C02),
 * so it is a structural pnpm-workspace/electron-builder incompatibility, not
 * something this WP's adapter/tray/preload changes caused. The standard fix is a
 * flattened (non-symlinked) `node_modules` for the packaged app — e.g. `pnpm
 * deploy`, a `node-linker=hoisted` app-local `.npmrc`, or bundling the main
 * process with esbuild — all bigger than this WP's `apps/desktop/**` +
 * `tools/release/**` boundary; flagged here for C00 (release pipeline owner)
 * rather than worked around silently. Until it's fixed, this function's
 * "real build" branch is unreachable in this sandbox and the placeholder
 * branch below is what actually runs; the mechanism is still real so it picks
 * up a genuine `release/` output the moment packaging works.
 */
async function findRealElectronBuilderOutput(
  desktopAppDir: string,
  platform: Platform,
): Promise<string | undefined> {
  const releaseDir = path.join(desktopAppDir, "release");
  if (!(await pathExists(releaseDir))) return undefined;

  if (platform === "win") {
    const winUnpacked = path.join(releaseDir, "win-unpacked");
    return (await pathExists(path.join(winUnpacked, "Aksharo.exe"))) ? releaseDir : undefined;
  }

  // mac: electron-builder names the output dir after the arch (`mac`, `mac-arm64`,
  // `mac-universal`, ...); scan for whichever one actually holds the app bundle.
  const entries = await fs.readdir(releaseDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(releaseDir, entry.name);
    if (await pathExists(path.join(candidate, "Aksharo.app"))) return candidate;
  }
  return undefined;
}

/**
 * Builds a placeholder desktop app tree when `apps/desktop` has no real Electron code, or
 * no real `electron-builder --dir` output yet, to build against (per brief, "build against
 * a placeholder app if absent and report"). C02 has since landed `apps/desktop/
 * electron-builder.yml` with `appId: ai.aksharo.desktop`, `productName: Aksharo` and mac
 * category `public.app-category.video` — this file's `release.config.ts` mirrors those
 * exact values, so the two configs are provably consistent. `ensureAppTree` prefers a real
 * `electron-builder --dir` output (`findRealElectronBuilderOutput`, C02b) and falls back to
 * synthesizing a nested-binary tree so `sign-nested`/`notarize`/`checksums` exercise their
 * real logic against *some* tree either way.
 */
async function ensureAppTree(
  outDir: string,
  platform: Platform,
  desktopAppDir: string,
): Promise<{ appDir: string; placeholder: boolean }> {
  const realOutput = await findRealElectronBuilderOutput(desktopAppDir, platform);
  if (realOutput !== undefined) {
    const appDir = path.join(outDir, "build", platform, "app");
    await ensureDir(path.dirname(appDir));
    await fs.rm(appDir, { recursive: true, force: true });
    await fs.cp(realOutput, appDir, { recursive: true });
    return { appDir, placeholder: false };
  }

  const hasRealApp = await pathExists(path.join(desktopAppDir, "package.json"));
  const appDir = path.join(outDir, "build", platform, hasRealApp ? "app" : "placeholder-app");
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
