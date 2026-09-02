import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBuildDesktop } from "../src/commands/buildDesktop.js";
import { createContext } from "../src/config.js";

import type { ReleaseConfig } from "../src/config.js";

/**
 * C02b scope §4: `build-desktop` should consume a real `electron-builder --dir`
 * output when one exists under `<desktopAppDir>/release`, instead of always
 * synthesizing the placeholder nested-binary tree. See `buildDesktop.ts`'s
 * `findRealElectronBuilderOutput` doc comment for why the real electron-builder
 * invocation itself can't run inside this dry-run harness/sandbox.
 */
describe("build-desktop against a real electron-builder output", () => {
  let repoRoot: string;
  let outDir: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "release-repo-real-"));
    outDir = path.join(repoRoot, ".release");
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  function ctx() {
    return createContext({ repoRoot, outDir, mode: "dry-run", now: () => 1_700_000_000_000 });
  }

  const config: ReleaseConfig = {
    appId: "ai.aksharo.desktop",
    productName: "Aksharo",
    desktopAppDir: "apps/desktop",
    mac: { target: ["dmg", "zip"], category: "public.app-category.video" },
    win: { target: "nsis", arch: "x64" },
    ccx: { pluginDir: "plugins/premiere-uxp-does-not-exist", minPremiereVersion: "25.6" },
    zxp: { pluginDir: "plugins/ae-cep-does-not-exist" },
    resolveBundle: {
      scriptDir: "plugins/resolve-does-not-exist",
      installPaths: { win: "w", mac: "m", linux: "l" },
    },
    channels: ["alpha", "beta", "stable"],
  };

  it("uses the real win-unpacked tree when Aksharo.exe is present", async () => {
    const winUnpacked = path.join(repoRoot, "apps/desktop/release/win-unpacked");
    await mkdir(winUnpacked, { recursive: true });
    await writeFile(path.join(winUnpacked, "Aksharo.exe"), "real-pe-main\n");
    await writeFile(path.join(winUnpacked, "bridge.exe"), "real-bridge-sea\n");

    const result = await runBuildDesktop(ctx(), config, {
      platform: "win",
      channel: "alpha",
      dryRun: true,
    });

    expect(result.placeholderApp).toBe(false);
    // The synthesized placeholder never writes "real-pe-main"; a signed target pointing at
    // the genuine Aksharo.exe proves the real tree (not the placeholder) was consumed.
    expect(result.signed.some((s) => s.path.endsWith("Aksharo.exe"))).toBe(true);
  });

  it("forces the placeholder tree with --placeholder even when a real output exists", async () => {
    // C00b scope §3: CI's dry-run job never builds apps/desktop, so it always wants the
    // synthesized tree explicitly rather than accidentally picking up a real one.
    const winUnpacked = path.join(repoRoot, "apps/desktop/release/win-unpacked");
    await mkdir(winUnpacked, { recursive: true });
    await writeFile(path.join(winUnpacked, "Aksharo.exe"), "real-pe-main\n");

    const result = await runBuildDesktop(ctx(), config, {
      platform: "win",
      channel: "alpha",
      dryRun: true,
      placeholder: true,
    });

    expect(result.placeholderApp).toBe(true);
    expect(result.signed.some((s) => s.path.endsWith("Aksharo.exe"))).toBe(true);
  });

  it("falls back to the placeholder tree when release/ exists but has no Aksharo.exe yet", async () => {
    // e.g. a partial/failed electron-builder run (only Electron's own binaries copied).
    const winUnpacked = path.join(repoRoot, "apps/desktop/release/win-unpacked");
    await mkdir(winUnpacked, { recursive: true });
    await writeFile(path.join(winUnpacked, "electron.exe"), "electron-runtime\n");

    const result = await runBuildDesktop(ctx(), config, {
      platform: "win",
      channel: "alpha",
      dryRun: true,
    });

    expect(result.placeholderApp).toBe(true);
  });
});
